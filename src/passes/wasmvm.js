/**
 * Pass：WASM 解释器内核档（wasmInterpreter）。
 *
 * 与 wasm 档的区别：wasm 档把字节码数据与取指/分桶/轮换等原语搬进 WASM，解释
 * 循环仍在 JS；本档把解释器本体（取指、解密、分发、值栈、槽位、控制流）整
 * 体编译进一个共享 WASM 模块，JS 侧只剩每函数一条桥接语句。所有值语义（属性
 * 读写、调用、二元运算）经随机命名的宿主导入函数回调，值以句柄（i32）表示，
 * 句柄表与引用计数都在宿主侧，pc、链值、掩码、栈与槽位全部只存在于 WASM 内。
 *
 * 内存布局（dWORD 下标）：
 *   [0] ANCHOR  [1] codeLen  [2..] 各函数密文字节码（模块层散列 + 每 fn 位置
 *   散列 + 链值；掩码不落盘，逐帧随机重掩后再取指）  PT 每函数参数表（表层
 *   加密，ini 时解密）  ARGSLOT 参数→槽位映射  SEMTAB 分发字→语义号
 *   PROBES 探针对（明文）  junk 段  FRAME 帧区（槽位+值栈+字节码重掩码草稿，
 *   帧顶指针是可变全局）  ARGAREA 参数区  RC 引用计数区（宿主持有）。
 *
 * 自保护：干扰分发字经 SEMTAB 落默认桶，进入 fail 导入置毒并陷阱；解释循环按
 * 周期调心跳导入做原生性检查；帧区溢出、探针失配、锚定字不符都走同一毒化路径。
 * 模块结构每构建随机：导入/导出名、函数序、类型噪声、诱饵函数、不透明假分支、
 * 常数拆分形、自定义 name 段假符号。
 */
import rand from '../utils/rand.js';
const { randInt } = rand;
import parser from '../ast/parser.js';
const { parse } = parser;
import wasmBin from '../ast/wasm.js';
const {
  buildModule, buildNameFuncs, OP, T_I32, BLOCK_VOID,
  i32Const, localGet, localSet, i32Load, i32Store, uleb,
} = wasmBin;
import rtlib from './rtlib.js';
import rtgen from './rtgen.js';
import platform from '../platform.js';
// 融合跳转种类 → 比较算子表：唯一真源在 vm.js， wasm 侧只读不用，两边漂移即静默算错。
import { FUSED_REL_OPS } from './vm.js';

// 宿主导入表（语义键 → 签名）。导入函数索引即本表下标，名字逐构建随机。
//
// 反 hook 多路复用：语义操作不各占一个导入，而是按**栈元数**合并为三条复用
// 入口（u1/u2/v2）+ bin/un（首参本就是不透明分发字）。hook 单个导入只能看到
// （随机子码, 句柄…），子码→语义的映射逐构建随机且只存在于宿主分发链里。
// 按元数硬编码模式（"唯一的 (3→1) 就是 bin"）彻底失效：(2→1) 有 u1/un 两家，
// (3→1) 有 u2/bin 两家，void 侧只有 v2 一家但 6 个子码共用。
const IMPORT_DEFS = [
  ['u1', [T_I32, T_I32], [T_I32]],               // 复用一元值 op：ldc/frag/get/bool/nul/mks/thr
  ['u2', [T_I32, T_I32, T_I32], [T_I32]],        // 复用二元值 op：getm/call/callm/new/arr
  ['v2', [T_I32, T_I32, T_I32, T_I32], []],      // 复用副作用 op：set/setm/exec/rel/fail/hb（多余槽位填 0）
  ['bin', [T_I32, T_I32, T_I32], [T_I32]],       // 二元（分发字定运算）
  ['un', [T_I32, T_I32], [T_I32]],               // 一元
];
const IMP = Object.fromEntries(IMPORT_DEFS.map(([k], i) => [k, i]));

/**
 * 复用入口的子码表（构造器，逐构建调用）。u1/u2/v2 的首个栈参数是子码，决定
 * 宿主执行哪个语义分支。稀疏随机整数（组内互异）：0..N 的稠密编号会泄露
 * "第几个分支"，稀疏值则没有序数信息。同一份映射经 spec 传给 rtgen（宿主分发
 * 链用同一套），两边对不上则冒烟的 anchor/probe 先挂，不会静默产出坏产物。
 *
 * 必须是逐构建生成：模块层只跑一次，多次 obfuscate() 会复用同一张表。
 */
function makeSubCodes() {
  const used = new Set();
  const pick = () => { let v; do { v = randInt(1, 0x7fffffff); } while (used.has(v)); used.add(v); return v; };
  const grp = (ops) => Object.fromEntries(ops.map((op) => [op, pick()]));
  return {
    u1: grp(['ldc', 'frag', 'get', 'bool', 'nul', 'mks', 'thr']),
    u2: grp(['getm', 'call', 'callm', 'new', 'arr']),
    v2: grp(['set', 'setm', 'exec', 'rel', 'fail', 'hb']),
  };
}

// 每函数参数表布局（PT，8 字/函数）
const PT_SEG = 0, PT_LEN = 1, PT_NSLOTS = 2, PT_FRAME = 3, PT_CHAIN = 4,
  PT_K1 = 5, PT_K2 = 6, PT_NARGS = 7, PT_STEP = 8;

const MAXA = 64;           // 参数区容量（同时是 ARGSLOT 步长）
const FRAMEWORDS = 131072; // 帧区容量（dWORD）
const RCCAP = 1 << 20;     // 句柄容量上限

// 内部调用索引占位（rcInc/rcDec 的最终索引在函数洗牌后才知道；
// 100/101 远超本模块用到的所有真实索引，回填时唯一可识别）
const PH_RCINC = 100;
const PH_RCDEC = 101;

/** i32 → LE 字节。 */
/** 当前构建的复用子码表（buildInterpreter 入口赋值，见上）。 */
let SUBCODES = null;

function i32le(v) {
  v = v | 0;
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

/** 宿主是否允许即时编译 wasm（与 wasm.js 同口径的能力探测）。 */
function wasmCompilable() {
  if (typeof WebAssembly !== 'object' || WebAssembly === null
    || typeof WebAssembly.Module !== 'function') return false;
  try {
    new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    return true;
  } catch (e) {
    return false;
  }
}

/** 结构化控制流小汇编器：跟踪 block 栈，按名字算 br 深度。 */
function WAsm() {
  this.b = [];
  this.stack = [];
}
WAsm.prototype.raw = function (xs) {
  // 递归展平并做操作码白名单检查：undefined 会以 0x00 落进模块（= unreachable），
  // 静默产出会跑飞的解释器，因此这里宁可构建期直接抛错。
  const em = this;
  const put = (v) => {
    if (typeof v === 'number') { em.b.push(v); return; }
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) put(v[i]); return; }
    throw new Error('wasmvm: 非数值操作码 ' + JSON.stringify(v));
  };
  for (let i = 0; i < xs.length; i++) put(xs[i]);
  return this;
};
WAsm.prototype.block = function (name) {
  this.raw([OP.block, BLOCK_VOID]); this.stack.push(name); return this;
};
WAsm.prototype.loop = function (name) {
  this.raw([OP.loop, BLOCK_VOID]); this.stack.push(name); return this;
};
WAsm.prototype.end = function () {
  this.raw([OP.end]); this.stack.pop(); return this;
};
WAsm.prototype.depth = function (name) {
  for (let i = this.stack.length - 1; i >= 0; i--) {
    if (this.stack[i] === name) return this.stack.length - 1 - i;
  }
  throw new Error('wasmvm: unknown label ' + name);
};
WAsm.prototype.br = function (name) {
  this.raw([OP.br, ...uleb(this.depth(name))]); return this;
};
WAsm.prototype.brIf = function (name) {
  this.raw([OP.br_if, ...uleb(this.depth(name))]); return this;
};

/**
 * 构建 WASM 解释器模块。
 * @param {Array<object>} fns 每函数元数据（flat 含 M0 掩码，落盘前剥掉）
 * @param {Map<string,number>} wordOf kind → 共享分发字
 * @param {number} total 分发字空间大小
 */
function buildInterpreter(fns, wordOf, total) {
  SUBCODES = makeSubCodes();
  const MOD_K1 = randInt(0x10001, 0x7ffffffe) | 1;
  const MOD_X = randInt(0x1000, 0xffffff);
  const TK1 = randInt(0x10001, 0x7ffffffe) | 1;   // 表层散列乘数
  const TK2 = randInt(0x1000, 0xffffff);
  const MKC = randInt(0x10001, 0x7ffffffe) | 1;   // 帧掩码乘子
  const ANCHOR = randInt(0x10000, 0xffffffff);
  const HBK = [0x3ff, 0x7ff, 0xfff][randInt(0, 2)]; // 心跳周期掩码

  // 模块层位置散列：参数即绝对字下标，运行期取指按 base+pc-1 传入同一公式（不得再减一）
  const modHash = (a) => ((Math.imul(a, MOD_K1) >>> 8) ^ MOD_X) >>> 0;
  const CODEBASE = 2;

  // ---- 代码区 ----
  const segBaseWords = [];
  const codeWords = [];
  for (const f of fns) {
    segBaseWords.push(codeWords.length);
    for (let z = 0; z < f.flat.length; z++) {
      // 剥掉 M0（掩码不落盘，逐帧随机重掩），叠加模块层散列
      const stripped = ((f.flat[z] >>> 0) ^ (f.MASK_M0 >>> 0)) >>> 0;
      codeWords.push((stripped ^ modHash(CODEBASE + codeWords.length)) >>> 0);
    }
  }
  const codeLen = codeWords.length;

  const PTB = CODEBASE + codeLen;
  const ASB = PTB + fns.length * PT_STEP;
  const SEMB = ASB + fns.length * MAXA;
  const kinds = [...wordOf.keys()];
  const NS = kinds.length;                          // 真实语义号 0..NS-1
  const semOfWord = new Array(total).fill(NS + randInt(1, 7)); // 干扰字 → 越界（默认桶）
  kinds.forEach((k, i) => { semOfWord[wordOf.get(k)] = i; });
  const PRB = SEMB + total;

  // 探针：代码区抽样
  const probeCount = Math.min(8, codeWords.length);
  const probeIdx = [];
  const probeVal = [];
  const step = Math.max(1, Math.floor(codeWords.length / Math.max(1, probeCount)));
  for (let k = 0; k < probeCount; k++) {
    const j = Math.min(codeWords.length - 1, k * step);
    probeIdx.push(j); probeVal.push(codeWords[j] >>> 0);
  }

  const TBSTART = PTB;               // 表层加密区（PT+ARGSLOT+SEMTAB）
  const TBEND = PRB + probeIdx.length * 2; // 探针区明文，不在加密区
  const thash = (x) => ((Math.imul(x, TK1) >>> 8) ^ TK2) >>> 0;
  const tenc = (i, v) => (((v | 0) >>> 0) ^ thash(i - TBSTART)) >>> 0;

  const dataWords = [];
  const put = (v) => dataWords.push((v | 0) >>> 0);
  put(ANCHOR); put(codeLen);
  for (const cw of codeWords) put(cw);
  for (let fi = 0; fi < fns.length; fi++) {
    const f = fns[fi];
    const frameSize = f.nSlots + f.segLen + 4 + f.segLen; // 槽位 + 值栈上界 + 草稿
    const row = [CODEBASE + segBaseWords[fi], f.segLen, f.nSlots, frameSize,
      f.CHAIN_SEED, f.MASK_K1, f.MASK_K2, f.argslots.length];
    for (let k = 0; k < PT_STEP; k++) put(tenc(PTB + fi * PT_STEP + k, row[k]));
  }
  for (let fi = 0; fi < fns.length; fi++) {
    const f = fns[fi];
    for (let k = 0; k < MAXA; k++) {
      const v = k < f.argslots.length ? f.argslots[k] : randInt(0, 0xffff);
      put(tenc(ASB + fi * MAXA + k, v));
    }
  }
  for (let i = 0; i < total; i++) put(tenc(SEMB + i, semOfWord[i]));
  for (let k = 0; k < probeIdx.length; k++) { put(probeIdx[k]); put(probeVal[k]); }

  // junk 段 + 帧区
  const JUNKW = randInt(64, 256);
  for (let j = 0; j < JUNKW; j++) put(randInt(0, 0xffffffff));
  const FRAMEBASE = TBEND + JUNKW + randInt(8, 32);
  const FRAMEEND = FRAMEBASE + FRAMEWORDS;
  const ARGAREA = FRAMEEND;
  const RCBASE = ARGAREA + MAXA;
  const totalWords = RCBASE + RCCAP;
  const pages = Math.max(2, Math.ceil((totalWords * 4) / 65536) + randInt(0, 2));
  if (pages > 65536) throw new Error('wasmvm: memory too large');

  // ---- 反编译加固原语 ----
  const splitConst = (v) => {
    const style = randInt(0, 2);
    v = v | 0;
    if (style === 0) return i32Const(v);
    const a = randInt(1, 0x7ffffffe);
    if (style === 1) return [].concat(i32Const(a), i32Const((v - a) | 0), [OP.i32_add]);
    return [].concat(i32Const(a), i32Const((a ^ v) | 0), [OP.i32_xor]);
  };
  const junkSeq = () => {
    const style = randInt(0, 3);
    if (style === 0) return [];
    if (style === 1) return [].concat(splitConst(randInt(1, 0xffff)), splitConst(randInt(1, 0xffff)), [OP.i32_add, OP.drop]);
    if (style === 2) return [].concat(splitConst(randInt(2, 0xffffff)), [OP.i32_eqz, OP.if, BLOCK_VOID], splitConst(randInt(1, 0xffff)), [OP.drop, OP.end]);
    return [].concat(i32Const(1), [OP.i32_eqz, OP.if, BLOCK_VOID, OP.nop, OP.end]);
  };
  const shr8 = () => (randInt(0, 1)
    ? [].concat(i32Const(8), [OP.i32_shr_u])
    : [].concat(i32Const(4), [OP.i32_shr_u], i32Const(4), [OP.i32_shr_u]));

  // ---- 类型表 ----
  const types = [];
  const typeOf = (() => {
    const map = new Map();
    return (params, results) => {
      const key = params.join(',') + '>' + results.join(',');
      let i = map.get(key);
      if (i === undefined) {
        i = types.length;
        types.push({ params, results });
        map.set(key, i);
      }
      return i;
    };
  })();

  // ---- 导入/导出名随机化 ----
  const takenNames = new Set();
  const genName = () => {
    let n;
    do { n = Array.from({ length: randInt(2, 4) }, () =>
      'abcdefghijklmnopqrstuvwxyz'[randInt(0, 25)]).join(''); } while (takenNames.has(n));
    takenNames.add(n);
    return n;
  };
  const modName = 'e' + randInt(1000, 9999).toString(36) + randInt(10, 99);
  const impNameOf = {};
  for (const [k] of IMPORT_DEFS) impNameOf[k] = genName();
  const imports = IMPORT_DEFS.map(([k, params, results]) => ({
    module: modName, name: impNameOf[k], typeIdx: typeOf(params, results),
  }));
  const callImp = (k) => [OP.call, ...uleb(IMP[k])];
  // 复用入口调用前缀：子码先压栈，再压原操作数。v2 固定 4 槽，不足补 i32 0。
  // 子码是稀疏随机值（见 makeSubCodes），静态按"第几个 call"数导入行为的写法失效。
  // SUBCODES 逐构建赋值（buildInterpreter 入口）：构建全程同步单线程，无重入，
  // 与 ctx.__vmWasmShared 同一生命周期，rtgen 经 spec 拿同一份。
  const u1sub = (op) => [...i32Const(SUBCODES.u1[op])];
  const u2sub = (op) => [...i32Const(SUBCODES.u2[op])];
  const v2head = (op) => [...i32Const(SUBCODES.v2[op])];
  const v2pad = (n) => Array.from({ length: n }, () => i32Const(0)).flat();

  // ---- 引用计数辅助函数 ----
  const rcIncBody = [].concat(
    junkSeq(),
    [localGet(0), i32Const(4), OP.i32_ge_s, OP.if, BLOCK_VOID],
    localGet(0), i32Const(2), OP.i32_shl, splitConst(RCBASE * 4), [OP.i32_add], localSet(1),
    localGet(1), localGet(1), i32Load(), i32Const(1), [OP.i32_add], i32Store(),
    [OP.end, OP.end],
  ).flat(2);
  const rcDecBody = [].concat(
    junkSeq(),
    [localGet(0), i32Const(4), OP.i32_ge_s, OP.if, BLOCK_VOID],
    localGet(0), i32Const(2), OP.i32_shl, splitConst(RCBASE * 4), [OP.i32_add], localSet(1),
    localGet(1), i32Load(), i32Const(1), [OP.i32_sub], localSet(2),
    localGet(1), localGet(2), i32Store(),
    localGet(2), [OP.i32_eqz, OP.if, BLOCK_VOID],
    localGet(0), ...v2head('rel'), ...v2pad(2), callImp('v2'),
    [OP.end],
    [OP.end, OP.end],
  ).flat(2);

  // ---- 解释器 RUN(f, argc) -> i32 ----
  // 局部：0 f, 1 argc, 2 pc, 3 ch, 4 mk, 5 fb, 6 sp, 7 k1, 8 k2, 9 d, 10 sem,
  //       11 base, 12 cs, 13 r, 14 h, 15 ptp, 16 b, 17 c, 18 n, 19 i, 20 t,
  //       21 fr, 22 nsl, 23 sg, 24 a2
  const L = {
    f: 0, argc: 1, pc: 2, ch: 3, mk: 4, fb: 5, sp: 6, k1: 7, k2: 8, d: 9,
    sem: 10, base: 11, cs: 12, r: 13, h: 14, ptp: 15, b: 16, c: 17, n: 18,
    i: 19, t: 20, fr: 21, nsl: 22, sg: 23, a2: 24,
  };
  const G = (l) => localGet(l);
  const S = (l) => localSet(l);
  const shl2 = () => [i32Const(2), OP.i32_shl];
  const rcInc = (x) => [].concat(G(x), [OP.call, ...uleb(PH_RCINC)]);
  const rcDec = (x) => [].concat(G(x), [OP.call, ...uleb(PH_RCDEC)]);

  // 取指：d = mem[(cs+pc)*4] ^ modHash(base+pc-1) ^ pos(pc) ^ mk ^ ch；ch=d；pc++
  // （掩码在帧入口对草稿区整体异或过一次，取指再异或 mk 恰好抵消，落盘密文不含掩码）
  const fetch = (dst) => [].concat(
    G(L.cs), G(L.pc), [OP.i32_add], shl2(), i32Load(),
    G(L.pc), i32Const(1), [OP.i32_add], S(L.pc),
    G(L.base), G(L.pc), [OP.i32_add], i32Const(1), [OP.i32_sub],
    splitConst(MOD_K1), [OP.i32_mul], shr8(), splitConst(MOD_X), [OP.i32_xor],
    [OP.i32_xor],
    G(L.pc), G(L.k1), [OP.i32_mul], shr8(), G(L.k2), [OP.i32_xor], [OP.i32_xor],
    G(L.mk), [OP.i32_xor],
    G(L.ch), [OP.i32_xor],
    S(dst), G(dst), S(L.ch),
  );
  const push = (x) => [].concat(G(L.sp), shl2(), G(x), i32Store(),
    G(L.sp), i32Const(1), [OP.i32_add], S(L.sp));
  const popMove = (x) => [].concat(          // 值移动（所有权转移，不动引用计数）
    G(L.sp), i32Const(1), [OP.i32_sub], S(L.sp),
    G(L.sp), shl2(), i32Load(), S(x));
  const peek = (off, x) => [].concat(
    G(L.sp), i32Const(1 + off), [OP.i32_sub], shl2(), i32Load(), S(x));

  const w = new WAsm();
  // 构建期诊断标记（DSH_WASMVM_DEBUG）：借 fail 导入回传阶段号，最后一条即已到达的阶段
  const TRACE = !!platform.env('DSH_WASMVM_DEBUG');
  const mark = (n) => { if (TRACE) w.raw([].concat(i32Const(n), ...v2head('fail'), ...v2pad(2), callImp('v2')).flat(2)); };
  const probe = (l) => { if (TRACE) w.raw([].concat(G(l), ...v2head('fail'), ...v2pad(2), callImp('v2')).flat(2)); };

  // ---- 帧入口 ----
  w.raw([].concat(
    junkSeq(),
    G(L.f), i32Const(PT_STEP), [OP.i32_mul], splitConst(PTB), [OP.i32_add], S(L.ptp),
  ).flat(2));
  const ldP = (off, dst) => w.raw([].concat(
    G(L.ptp), i32Const(off), [OP.i32_add], shl2(), i32Load(), S(dst),
  ));
  mark(11);
  ldP(PT_SEG, L.base); ldP(PT_LEN, L.sg); ldP(PT_NSLOTS, L.nsl);
  ldP(PT_FRAME, L.fr); ldP(PT_CHAIN, L.ch); ldP(PT_K1, L.k1); ldP(PT_K2, L.k2);
  ldP(PT_NARGS, L.n);
  w.raw([].concat(
    [OP.global_get, ...uleb(0)], S(L.fb),
    G(L.fb), G(L.fr), [OP.i32_add], S(L.t),
    G(L.t), [OP.global_set, ...uleb(0)],
    G(L.t), splitConst(FRAMEEND), [OP.i32_gt_u, OP.if, BLOCK_VOID],
    i32Const(2), ...v2head('fail'), ...v2pad(2), callImp('v2'), [OP.unreachable],
    [OP.end],
    G(L.fb), G(L.fr), [OP.i32_add], G(L.sg), [OP.i32_sub], S(L.cs),
    [OP.global_get, ...uleb(1)], i32Const(1), [OP.i32_add], S(L.t),
    G(L.t), [OP.global_set, ...uleb(1)],
    G(L.t), splitConst(MKC), [OP.i32_mul], [OP.global_get, ...uleb(2)], [OP.i32_xor], S(L.mk),
  ).flat(2));
  // 字节码逐帧重掩码拷贝：mem[cs+i] = mem[base+i] ^ mk
  w.raw([].concat(i32Const(0), S(L.i)).flat(2));
  w.block('$cp'); w.loop('$cpl');
  w.raw([].concat(G(L.i), G(L.sg), [OP.i32_ge_s]).flat(2)); w.brIf('$cp');
  w.raw([].concat(
    G(L.cs), G(L.i), [OP.i32_add], shl2(),
    G(L.base), G(L.i), [OP.i32_add], shl2(), i32Load(),
    G(L.mk), [OP.i32_xor],
    i32Store(),
    G(L.i), i32Const(1), [OP.i32_add], S(L.i),
  ).flat(2));
  w.br('$cpl'); w.end(); w.end();
  // 槽位初始化为句柄 0（undefined）
  w.raw([].concat(i32Const(0), S(L.i)).flat(2));
  w.block('$si'); w.loop('$sil');
  w.raw([].concat(G(L.i), G(L.nsl), [OP.i32_ge_s]).flat(2)); w.brIf('$si');
  w.raw([].concat(G(L.fb), G(L.i), [OP.i32_add], shl2(), i32Const(0), i32Store()).flat(2));
  w.raw([].concat(G(L.i), i32Const(1), [OP.i32_add], S(L.i)).flat(2));
  w.br('$sil'); w.end(); w.end();
  mark(13);
  // 参数拷贝（i < min(nArgs, argc)）
  w.raw([].concat(i32Const(0), S(L.i)).flat(2));
  w.block('$ar'); w.loop('$arl');
  w.raw([].concat(G(L.i), G(L.n), [OP.i32_ge_s]).flat(2)); w.brIf('$ar');
  w.raw([].concat(G(L.i), G(L.argc), [OP.i32_ge_s]).flat(2)); w.brIf('$ar');
  w.raw([].concat(
    G(L.f), i32Const(MAXA), [OP.i32_mul], splitConst(ASB), [OP.i32_add], G(L.i), [OP.i32_add], shl2(), i32Load(), S(L.t),
    i32Const(ARGAREA), G(L.i), [OP.i32_add], shl2(), i32Load(), S(L.h),
    rcInc(L.h),
    G(L.fb), G(L.t), [OP.i32_add], shl2(), G(L.h), i32Store(),
    G(L.i), i32Const(1), [OP.i32_add], S(L.i),
  ).flat(2));
  w.br('$arl'); w.end(); w.end();
  mark(14);
  w.raw([].concat(G(L.fb), G(L.nsl), [OP.i32_add], S(L.sp), i32Const(0), S(L.pc)).flat(2));
  mark(17);

  // ---- 主循环 ----
  w.loop('$next');
  w.raw([].concat(
    [OP.global_get, ...uleb(3)], i32Const(1), [OP.i32_add], S(L.t),
    G(L.t), [OP.global_set, ...uleb(3)],
    G(L.t), i32Const(HBK), [OP.i32_and, OP.i32_eqz, OP.if, BLOCK_VOID],
    ...v2head('hb'), ...v2pad(3), callImp('v2'),
    [OP.end],
  ).flat(2));
  probe(L.fb); probe(L.cs); probe(L.base); probe(L.sg); probe(L.fr);
  probe(L.mk); probe(L.ch); probe(L.k1); probe(L.k2);
  if (TRACE) { w.raw([].concat(G(L.cs), G(L.pc), [OP.i32_add], shl2(), i32Load(), ...v2head('fail'), ...v2pad(2), callImp('v2')).flat(2)); }
  w.raw([].concat(fetch(L.d)).flat(2));
  probe(L.d);
  w.raw([].concat(G(L.d), splitConst(SEMB), [OP.i32_add], shl2(), i32Load(), S(L.sem)).flat(2));
  probe(L.d); probe(L.sem);

  // ---- 分发 ----
  for (let s = 0; s < NS; s++) w.block('$c' + s);
  w.block('$dflt');
  w.raw([].concat(G(L.sem), [OP.br_table],
    uleb(NS),
    ...Array.from({ length: NS }, (_, s) => uleb(NS - s)),
    uleb(0),
    [OP.unreachable],
  ).flat(2));
  w.end(); // $dflt 闭合，此处位于 $c{NS-1} 内 → 默认桶体
  w.raw([].concat(i32Const(3), ...v2head('fail'), ...v2pad(2), callImp('v2'), [OP.unreachable]).flat(2));
  w.br('$next');

  // ---- case 体生成器 ----
  // 调用类（CALL_/CALLM_/NEW_/ARR_）：含结构化释放循环，返回分段描述
  // head = 本次调用在值栈上占用的句柄数（CALL/NEW 为 n+1；CALLM 另有方法键，为 n+2；ARR 为 n）
  function callSeq(imp, n, head) {
    const pre = [].concat(
      G(L.sp), i32Const(head), [OP.i32_sub], S(L.t),
      ...u2sub(imp), i32Const(n), G(L.t), callImp('u2'), S(L.h),
      i32Const(0), S(L.i),
    );
    const post = [].concat(
      G(L.sp), i32Const(head), [OP.i32_sub], S(L.sp),
      rcInc(L.h), push(L.h),
    );
    return { seq: true, pre, cnt: head, post };
  }

  const caseBodyOf = (kind) => {
    if (kind === 'LDC') return [].concat(
      ...u1sub('ldc'), fetch(L.h), G(L.h), callImp('u1'), S(L.h), rcInc(L.h), push(L.h));
    if (kind === 'LOD') return [].concat(
      fetch(L.h),
      G(L.fb), G(L.h), [OP.i32_add], shl2(), i32Load(), S(L.h),
      rcInc(L.h), push(L.h));
    if (kind === 'STR') return [].concat(
      fetch(L.t),
      popMove(L.h),
      G(L.fb), G(L.t), [OP.i32_add], shl2(), i32Load(), S(L.b),
      rcDec(L.b),
      G(L.fb), G(L.t), [OP.i32_add], shl2(), G(L.h), i32Store());
    if (kind === 'GET') return [].concat(
      ...u1sub('get'), fetch(L.h), G(L.h), callImp('u1'), S(L.h), rcInc(L.h), push(L.h));
    if (kind === 'SET') return [].concat(
      fetch(L.t), popMove(L.h), ...v2head('set'), G(L.t), G(L.h), ...v2pad(1), callImp('v2'), rcDec(L.h));
    if (kind === 'FRAG') return [].concat(
      ...u1sub('frag'), fetch(L.h), G(L.h), callImp('u1'), S(L.h), rcInc(L.h), push(L.h));
    if (kind === 'EXEC') return [].concat(fetch(L.t), ...v2head('exec'), G(L.t), ...v2pad(2), callImp('v2'));
    if (kind === 'MKS') return [].concat(
      ...u1sub('mks'), fetch(L.h), G(L.h), callImp('u1'), S(L.h), rcInc(L.h), push(L.h));
    if (kind === 'GETM') return [].concat(
      popMove(L.b), popMove(L.a2),
      ...u2sub('getm'), G(L.a2), G(L.b), callImp('u2'), S(L.h),
      rcDec(L.b), rcDec(L.a2), rcInc(L.h), push(L.h));
    if (kind === 'SETM') return [].concat(
      popMove(L.h), popMove(L.b), popMove(L.a2),
      ...v2head('setm'), G(L.a2), G(L.b), G(L.h), callImp('v2'),
      rcDec(L.b), rcDec(L.a2), rcInc(L.h), push(L.h));
    if (kind === 'GETMK') return [].concat(
      peek(1, L.a2), peek(0, L.b),
      ...u2sub('getm'), G(L.a2), G(L.b), callImp('u2'), S(L.h),
      rcInc(L.h), push(L.h));
    if (kind === 'DUP') return [].concat(peek(0, L.h), rcInc(L.h), push(L.h));
    if (kind === 'POP') return [].concat(popMove(L.h), rcDec(L.h));
    if (kind === 'JMP') return [].concat(
      fetch(L.t), fetch(L.b),
      G(L.t), S(L.pc));
    if (kind === 'JPF' || kind === 'JPT') {
      const cond = kind === 'JPF' ? [OP.i32_eqz] : [];
      return [].concat(
        fetch(L.t),
        popMove(L.h), ...u1sub('bool'), G(L.h), callImp('u1'), S(L.c), rcDec(L.h),
        fetch(L.b),
        G(L.c), cond, [OP.if, BLOCK_VOID],
        G(L.t), S(L.pc),
        [OP.end]);
    }
    // 融合关系跳转：弹两个值，经宿主 bin 按本分发字查关系算子求值，再按极性分支。
    // 引用计数照 BIN_ + JPF 两段原样拼（pops 释放、结果用后释放、不压栈）；
    // F 假极性在 i32 结果上补一个 eqz（与 JPF 同式），比较本身不取反。
    const fusedRel = FUSED_REL_OPS[kind];
    if (fusedRel !== undefined) {
      const cond = kind.endsWith('F') ? [OP.i32_eqz] : [];
      return [].concat(
        fetch(L.t),
        popMove(L.b), popMove(L.a2),
        G(L.d), G(L.a2), G(L.b), callImp('bin'), S(L.h),
        rcDec(L.b), rcDec(L.a2),
        ...u1sub('bool'), G(L.h), callImp('u1'), S(L.c), rcDec(L.h),
        fetch(L.b),
        G(L.c), cond, [OP.if, BLOCK_VOID],
        G(L.t), S(L.pc),
        [OP.end]);
    }
    // NOP（流干扰）：空动作，取指已由循环统一推进，直接回主循环。
    if (kind === 'NOP') return [];
    if (kind === 'JANDK' || kind === 'JORK' || kind === 'JNULK') {
      const imp = kind === 'JNULK' ? 'nul' : 'bool';
      const jumpWhenTruthy = kind !== 'JANDK';
      return {
        logical: true,
        head: [].concat(
          fetch(L.t),   // 目标
          fetch(L.b),   // 数量 n
          fetch(L.a2),  // 链值字（取走即完成链复位）
          peek(0, L.h), // 栈顶 v（不消费）
          ...u1sub(imp), G(L.h), callImp('u1'), S(L.c),
        ),
        cond: jumpWhenTruthy ? [G(L.c)] : [G(L.c), OP.i32_eqz],
        tail: [].concat(
          // 栈顶 v 下移到 sp-1-n，sp -= n，pc = 目标
          G(L.sp), i32Const(1), [OP.i32_sub], G(L.b), [OP.i32_sub], shl2(), G(L.h), i32Store(),
          G(L.sp), G(L.b), [OP.i32_sub], S(L.sp),
          G(L.t), S(L.pc),
        ),
      };
    }
    if (kind === 'RET') return { ret: true };
    if (kind === 'RETU' || kind === 'END') return { retu: true };
    if (kind === 'THR') return [].concat(
      popMove(L.h), ...u1sub('thr'), G(L.h), callImp('u1'), [OP.drop, OP.unreachable]);
    if (kind.startsWith('BIN_')) return [].concat(
      popMove(L.b), popMove(L.a2),
      G(L.d), G(L.a2), G(L.b), callImp('bin'), S(L.h),
      rcDec(L.b), rcDec(L.a2), rcInc(L.h), push(L.h));
    if (kind.startsWith('UN_')) return [].concat(
      popMove(L.h), G(L.d), G(L.h), callImp('un'), S(L.t),
      rcDec(L.h), G(L.t), S(L.h), rcInc(L.h), push(L.h));
    if (kind.startsWith('CALL_')) return callSeq('call', +kind.slice(5), +kind.slice(5) + 1);
    if (kind.startsWith('CALLM_')) return callSeq('callm', +kind.slice(6), +kind.slice(6) + 2);
    if (kind.startsWith('NEW_')) return callSeq('new', +kind.slice(4), +kind.slice(4) + 1);
    if (kind.startsWith('ARR_')) return callSeq('arr', +kind.slice(4), +kind.slice(4));
    throw new Error('wasmvm: unknown kind ' + kind);
  };

  // 返回类收尾（RET/RETU）：释放槽位与栈残余，帧退栈，返回句柄
  const teardownAndReturn = (retKind) => {
    if (retKind === 'RET') {
      w.raw(popMove(L.r));
    } else {
      w.raw([].concat(i32Const(0), S(L.r)).flat(2));
    }
    w.raw([].concat(i32Const(0), S(L.i)).flat(2));
    w.block('$ts'); w.loop('$tsl');
    w.raw([].concat(G(L.i), G(L.nsl), [OP.i32_ge_s]).flat(2)); w.brIf('$ts');
    w.raw([].concat(
      G(L.fb), G(L.i), [OP.i32_add], shl2(), i32Load(), S(L.h),
      rcDec(L.h),
      G(L.i), i32Const(1), [OP.i32_add], S(L.i),
    ).flat(2));
    w.br('$tsl'); w.end(); w.end();
    w.raw([].concat(G(L.fb), G(L.nsl), [OP.i32_add], S(L.i)).flat(2));
    w.block('$tt'); w.loop('$ttl');
    w.raw([].concat(G(L.i), G(L.sp), [OP.i32_ge_s]).flat(2)); w.brIf('$tt');
    w.raw([].concat(
      G(L.i), shl2(), i32Load(), S(L.h),
      rcDec(L.h),
      G(L.i), i32Const(1), [OP.i32_add], S(L.i),
    ).flat(2));
    w.br('$ttl'); w.end(); w.end();
    w.raw([].concat(
      G(L.fb), [OP.global_set, ...uleb(0)],
      G(L.r), [OP.return],
    ).flat(2));
  };

  // [ptr, ptr+cnt) 引用释放循环（结构化）
  const releaseLoop = (ptrLocal, cnt) => {
    const inner = new WAsm();
    inner.block('$rl'); inner.loop('$rll');
    inner.raw([].concat(G(L.i), i32Const(cnt), [OP.i32_ge_s]).flat(2)); inner.brIf('$rl');
    inner.raw([].concat(
      G(ptrLocal), G(L.i), [OP.i32_add], shl2(), i32Load(), S(L.r),
      rcDec(L.r),
      G(L.i), i32Const(1), [OP.i32_add], S(L.i),
    ).flat(2));
    inner.br('$rll'); inner.end(); inner.end();
    return inner.b;
  };

  // ---- 逐 case 输出（从 semId NS-1 到 0）----
  // 关键：br 到 block 标签的落点是该 block 的 end 之后，因此必须先关块再发
  // 对应语义的处理器。少关一次会让所有分支错位一个块（语义全部错配）。
  for (let s = NS - 1; s >= 0; s--) {
    const kind = kinds[s];
    const body = caseBodyOf(kind);
    w.end(); // 关 $c{s}，紧随其后的代码就是该语义的处理器
    mark(30 + s);
    if (body.logical) {
      w.raw(body.head);
      w.raw(body.cond);
      w.raw([OP.if, BLOCK_VOID]);
      // 跳转支：释放栈顶下方 n 项（项 i 的字下标 = sp-1-n+i），栈顶下移，pc=目标
      w.raw([].concat(i32Const(0), S(L.i)).flat(2));
      w.raw(logicalReleaseSeq());
      w.raw(body.tail);
      w.raw([OP.else]);
      w.raw([].concat(popMove(L.h), rcDec(L.h)).flat(2));
      w.raw([OP.end]);
    } else if (body.ret) {
      teardownAndReturn('RET');
    } else if (body.retu) {
      teardownAndReturn('RETU');
    } else if (body.seq) {
      w.raw(body.pre.flat(2));
      w.raw(releaseLoop(L.t, body.cnt));
      w.raw(body.post.flat(2));
    } else {
      w.raw(body.flat(2));
    }
    w.br('$next');
  }
  w.end(); // loop $next
  w.raw([OP.unreachable]); // 循环无自然出口（所有处理器 br $next 或 return）
  w.raw([OP.end]);         // 函数 end：不可达，校验器按多态栈接受

  // 逻辑跳转类释放序列：地址基 = sp-1-n（项 i 的字下标），n 在 L.b
  function logicalReleaseSeq() {
    const inner = new WAsm();
    inner.block('$rj'); inner.loop('$rjl');
    inner.raw([].concat(G(L.i), G(L.b), [OP.i32_ge_s]).flat(2)); inner.brIf('$rj');
    inner.raw([].concat(
      G(L.sp), i32Const(1), [OP.i32_sub], G(L.b), [OP.i32_sub], G(L.i), [OP.i32_add], shl2(), i32Load(), S(L.r),
      rcDec(L.r),
      G(L.i), i32Const(1), [OP.i32_add], S(L.i),
    ).flat(2));
    inner.br('$rjl'); inner.end(); inner.end();
    return inner.b;
  }

  const runLocals = [[23, T_I32]]; // 参数 2 + 23 局部 = 25
  const runBody = w.b;

  // ---- ini() -> i32：探针校验 + 表层解密 ----
  const iniW = new WAsm();
  iniW.raw([].concat(i32Const(0), localSet(0)).flat(2));
  iniW.block('$pv'); iniW.loop('$pvl');
  iniW.raw([].concat(localGet(0), i32Const(probeIdx.length * 2), [OP.i32_ge_s]).flat(2)); iniW.brIf('$pv');
  iniW.raw([].concat(
    splitConst(PRB), localGet(0), [OP.i32_add], shl2(), i32Load(), localSet(1),
    splitConst(PRB), localGet(0), [OP.i32_add], i32Const(1), [OP.i32_add], shl2(), i32Load(), localSet(2),
    i32Const(CODEBASE), localGet(1), [OP.i32_add], shl2(), i32Load(),
    localGet(2), [OP.i32_ne, OP.if, BLOCK_VOID],
    i32Const(1), [OP.return],
    [OP.end],
    localGet(0), i32Const(2), [OP.i32_add], localSet(0),
  ).flat(2));
  iniW.br('$pvl'); iniW.end(); iniW.end();
  iniW.raw([].concat(splitConst(TBSTART), localSet(0)).flat(2));
  iniW.block('$dc'); iniW.loop('$dcl');
  iniW.raw([].concat(localGet(0), splitConst(TBEND), [OP.i32_ge_s]).flat(2)); iniW.brIf('$dc');
  iniW.raw([].concat(
    localGet(0), shl2(), i32Load(),
    localGet(0), splitConst(TBSTART), [OP.i32_sub],
    splitConst(TK1), [OP.i32_mul], shr8(), splitConst(TK2), [OP.i32_xor],
    [OP.i32_xor], localSet(1),
    localGet(0), shl2(), localGet(1), i32Store(),
    localGet(0), i32Const(1), [OP.i32_add], localSet(0),
  ).flat(2));
  iniW.br('$dcl'); iniW.end(); iniW.end();
  iniW.raw([].concat(i32Const(0), [OP.end]).flat(2));
  const iniBody = iniW.b;

  // ---- anchor / prb / snn ----
  const anchorBody = [].concat(junkSeq(), splitConst(ANCHOR), [OP.end]).flat(2);
  const prbBody = [].concat(junkSeq(),
    localGet(0), shl2(), splitConst(CODEBASE * 4), [OP.i32_add], i32Load(),
    [OP.end]).flat(2);
  const snnBody = [].concat(junkSeq(),
    localGet(0), [OP.global_set, ...uleb(2)], [OP.end]).flat(2);

  // ---- 诱饵函数 ----
  const SCRATCH = FRAMEEND - randInt(32, 96);
  const JUNK_ADDR = TBEND + 8;
  const decoyAffine = () => {
    const A = randInt(1, 0x7ffffffe) | 1;
    const B = randInt(1, 0xffffff);
    return [].concat(junkSeq(),
      localGet(0), i32Const(15), [OP.i32_and],
      splitConst(SCRATCH), [OP.i32_add], shl2(), localSet(2),
      localGet(2), i32Load(),
      localGet(1), splitConst(A), [OP.i32_mul], splitConst(B), [OP.i32_add],
      [OP.i32_xor], localSet(3),
      localGet(2), localGet(3), i32Store(),
      junkSeq(),
      localGet(2), i32Load(),
      localGet(1), splitConst(A), [OP.i32_mul], [OP.i32_add],
      [OP.end]).flat(2);
  };
  const decoyScan = () => {
    const C = randInt(1, 0xffffff);
    return [].concat(junkSeq(),
      localGet(0), i32Const(7), [OP.i32_and],
      splitConst(JUNK_ADDR), [OP.i32_add], shl2(), i32Load(),
      localGet(0), i32Const(3), [OP.i32_and],
      splitConst(JUNK_ADDR + 2), [OP.i32_add], shl2(), i32Load(),
      [OP.i32_add], junkSeq(), splitConst(C), [OP.i32_xor],
      [OP.end]).flat(2);
  };

  // ---- 函数定义与洗牌 ----
  const defs = [
    { key: 'rcinc', typeIdx: typeOf([T_I32], []), locals: [[1, T_I32]], body: rcIncBody },
    { key: 'rcdec', typeIdx: typeOf([T_I32], []), locals: [[2, T_I32]], body: rcDecBody },
    { key: 'run', typeIdx: typeOf([T_I32, T_I32], [T_I32]), locals: runLocals, body: runBody },
    { key: 'ini', typeIdx: typeOf([], [T_I32]), locals: [[3, T_I32]], body: iniBody },
    { key: 'anchor', typeIdx: typeOf([], [T_I32]), locals: [[1, T_I32]], body: anchorBody },
    { key: 'prb', typeIdx: typeOf([T_I32], [T_I32]), locals: [[1, T_I32]], body: prbBody },
    { key: 'snn', typeIdx: typeOf([T_I32], []), locals: [[1, T_I32]], body: snnBody },
  ];
  for (let d = 0; d < randInt(2, 5); d++) {
    defs.push(d % 2 === 0
      ? { key: 'dk' + d, typeIdx: typeOf([T_I32, T_I32], [T_I32]), locals: [[2, T_I32]], body: decoyAffine() }
      : { key: 'dk' + d, typeIdx: typeOf([T_I32], [T_I32]), locals: [[1, T_I32]], body: decoyScan() });
  }
  for (let d = 0; d < randInt(0, 2); d++) types.push({ params: [T_I32], results: [] }); // 未用型噪声

  // 洗牌后才能确定 rcInc/rcDec 的最终索引，先洗再回填占位
  const fnOrder = defs.map((_, i) => i);
  for (let i = fnOrder.length - 1; i > 0; i--) {
    const j = randInt(0, i); const tmp = fnOrder[i]; fnOrder[i] = fnOrder[j]; fnOrder[j] = tmp;
  }
  const shuffled = fnOrder.map((i) => defs[i]);
  const defIdxOf = new Map();
  shuffled.forEach((d, i) => defIdxOf.set(d.key, IMPORT_DEFS.length + i));
  const RCINC_IDX = defIdxOf.get('rcinc');
  const RCDEC_IDX = defIdxOf.get('rcdec');
  // 回填占位索引（PH_* 单字节且不与任何真实索引冲突）
  for (const d of shuffled) {
    if (d.key === 'rcinc' || d.key === 'rcdec') continue;
    for (let i = 0; i + 1 < d.body.length; i++) {
      if (d.body[i] === OP.call && d.body[i + 1] === PH_RCINC) { d.body[i + 1] = RCINC_IDX; i++; continue; }
      if (d.body[i] === OP.call && d.body[i + 1] === PH_RCDEC) { d.body[i + 1] = RCDEC_IDX; i++; continue; }
    }
  }

  const expName = (() => {
    return () => { let n; do { n = genName(); } while (n.length < 2); return n; };
  })();
  const expNames = {
    run: expName(), ini: expName(), anchor: expName(), prb: expName(),
    snn: expName(), mem: expName(),
  };
  const expList = defs.map((d) => ({
    name: expNames[d.key] || expName(), kind: 0, idx: defIdxOf.get(d.key),
  }));
  expList.push({ name: expNames.mem, kind: 2, idx: 0 });

  // ---- 数据段 ----
  const dataBytes = [];
  for (const v of dataWords) { const b = i32le(v); for (const x of b) dataBytes.push(x); }
  const junkBytes = [];
  for (let k = 0; k < randInt(256, 1024); k++) junkBytes.push(randInt(0, 255));
  const dataSegs = [
    { offsetBytes: [...i32Const(0), OP.end], bytes: dataBytes },
    { offsetBytes: [...i32Const((TBEND + 8) * 4), OP.end], bytes: junkBytes },
  ];
  for (let i = dataSegs.length - 1; i > 0; i--) {
    const j = randInt(0, i); const tmp = dataSegs[i]; dataSegs[i] = dataSegs[j]; dataSegs[j] = tmp;
  }

  // 假 name 段（误导反编译器）
  const FAKE_SYMS = ['malloc', 'free', 'memcpy', '__multi3', 'htonl', 'deflate_block',
    'lzma_decode', 'sha256_transform', 'btree_split', '_Znwj', 'rb_insert_color',
    'pow_p', 'exp_m1', 'locale_facet', 'wcsnrtombs', 'arena_alloc'];
  const nameBytes = buildNameFuncs(
    shuffled.map((d, i) => [IMPORT_DEFS.length + i,
      FAKE_SYMS[randInt(0, FAKE_SYMS.length - 1)] + '_' + randInt(10, 99999).toString(36)]),
  );

  const mod = buildModule({
    types,
    imports,
    funcs: shuffled.map((d) => ({ typeIdx: d.typeIdx, locals: d.locals, body: d.body })),
    globals: [
      { init: FRAMEBASE, mutable: true },               // g0 帧顶指针
      { init: randInt(1, 0x3fffffff), mutable: true },  // g1 帧计数
      { init: 0, mutable: true },                       // g2 nonce（snn 设置）
      { init: 0, mutable: true },                       // g3 指令计数
    ],
    memPages: pages,
    exports: expList,
    data: dataSegs,
    nameBytes,
  });

  if (platform.env('DSH_WASMVM_DEBUG')) {
    for (const d of defs) {
      const bad = [];
      (d.body || []).forEach((b, i) => {
        if (typeof b !== 'number') bad.push(i + '=' + JSON.stringify(b));
      });
      if (bad.length) {
        console.error('[wasmvm] hole in ' + d.key + ': ' + bad.join(', '));
        const first = Number(bad[0].split('=')[0]);
        console.error('[wasmvm]   around ' + first + ': '
          + JSON.stringify(d.body.slice(Math.max(0, first - 6), first + 6)));
      }
    }
    console.error('[wasmvm] PRB=' + PRB + ' TBSTART=' + TBSTART + ' TBEND=' + TBEND
      + ' probeIdx=' + JSON.stringify(probeIdx) + ' NS=' + NS
      + ' defs=' + defs.map((d) => d.key + '/' + d.body.length).join(','));
    if (fns.length) {
      const f0 = fns[0];
      const p1 = ((Math.imul(1, f0.MASK_K1) >>> 8) ^ f0.MASK_K2) >>> 0;
      console.error('[wasmvm] expect d0=' + (((f0.flat[0] ^ p1 ^ f0.MASK_M0 ^ f0.CHAIN_SEED) >>> 0)) + ' words=' + ['LOD','LDC','BIN_+','RET'].map((k) => k + ':' + wordOf.get(k)).join(','));
      console.error('[wasmvm] flat head=' + JSON.stringify(f0.flat.slice(0, 4)) + ' seed=' + f0.CHAIN_SEED + ' M0=' + f0.MASK_M0 + ' K1=' + f0.MASK_K1 + ' K2=' + f0.MASK_K2);
      console.error('[wasmvm] PT0 expect=[' + [CODEBASE + segBaseWords[0], f0.segLen, f0.nSlots,
        f0.nSlots + f0.segLen + 4 + f0.segLen, f0.CHAIN_SEED, f0.MASK_K1, f0.MASK_K2,
        f0.argslots.length].join(',') + ']');
    }
  }

  // ---- 构建期自检 ----
  let smoke = 'skip';
  if (wasmCompilable()) {
    if (!WebAssembly.validate(mod)) {
      // 校验失败时用 Module 构造取回具体报错，便于定位发射器缺陷
      let detail = '';
      try { new WebAssembly.Module(mod); } catch (e) { detail = e && e.message ? e.message : String(e); }
      throw new Error('wasmvm: 模块校验失败 — ' + detail);
    }
    try {
      const impObj = {};
      for (const [k] of IMPORT_DEFS) impObj[impNameOf[k]] = function () { return 0; };
      const inst = new WebAssembly.Instance(new WebAssembly.Module(mod), { [modName]: impObj });
      const ex = inst.exports;
      let step = 'anchor';
      try {
        if ((ex[expNames.anchor]() >>> 0) !== (ANCHOR >>> 0)) throw new Error('anchor mismatch');
        step = 'prb';
        for (let k = 0; k < probeIdx.length; k++) {
          if ((ex[expNames.prb](probeIdx[k]) >>> 0) !== (probeVal[k] >>> 0)) throw new Error('probe mismatch');
        }
        step = 'ini';
        if (ex[expNames.ini]() !== 0) throw new Error('ini failed');
      } catch (e) {
        throw new Error('at ' + step + ': ' + (e && e.message ? e.message : String(e)));
      }
      smoke = 'ok';
    } catch (e) {
      throw new Error('wasmvm: 冒烟失败 — ' + (e && e.message ? e.message : String(e)));
    }
  }

  return {
    mod, expNames, impNameOf, modName, ANCHOR, probeIdx, probeVal,
    kinds, NS, total, smoke, subCodes: SUBCODES,
    layout: { CODEBASE, PTB, ASB, SEMB, PRB, TBSTART, TBEND, FRAMEBASE, FRAMEEND, ARGAREA, RCBASE, RCCAP, MAXA },
  };
}

/** Pass 入口：收集桥接函数元数据 → 构建模块 → 注入宿主运行时。 */
export default function wasmvm(ast, options, ctx) {
  if (options.wasmInterpreter === false) return { fns: 0, moduleBytes: 0 };
  const program = ast.type === 'File' ? ast.program : ast;

  const cands = [];
  ctx.traverse(ast, {
    Function: (p) => { if (p.node.__wasmVmMeta) cands.push(p.node); },
    noScope: true,
  });
  if (!cands.length) return { fns: 0, moduleBytes: 0, kinds: 0 };

  const shared = ctx.__vmWasmShared;
  if (!shared || !shared.wordOf) {
    throw new Error('wasmvm: 缺少共享分发表（vm pass 未以 wasmInterpreter 模式运行）');
  }

  // 必须按 vm pass 分配的 fIdx 落位：桥接体内写的是 fIdx，而 traverse 的收集顺序与
  // 编译顺序（内层函数先被外层连带编译）并不一致，按收集顺序索引会读错参数表行。
  const fns = [];
  for (const fn of cands) {
    const m = fn.__wasmVmMeta;
    if (!m || m.fIdx === undefined) throw new Error('wasmvm: 桥接元数据缺少 fIdx');
    if (fns[m.fIdx]) throw new Error('wasmvm: fIdx 冲突 ' + m.fIdx);
    fns[m.fIdx] = m;
  }
  for (let i = 0; i < fns.length; i++) {
    if (!fns[i]) throw new Error('wasmvm: fIdx 空洞 ' + i);
  }
  const built = buildInterpreter(fns, shared.wordOf, shared.total);

  const rt = rtgen.buildLoader({
    ctx,
    options,
    debug: !!platform.env('DSH_WASMVM_DEBUG'),
    modBytes: built.mod,
    modName: built.modName,
    impNameOf: built.impNameOf,
    expNames: built.expNames,
    importDefs: IMPORT_DEFS,
    subCodes: built.subCodes,
    binWords: [...shared.wordOf]
      .filter(([k]) => k.startsWith('BIN_') || FUSED_REL_OPS[k] !== undefined)
      .map(([k, w]) => (k.startsWith('BIN_') ? [w, k.slice(4)] : [w, FUSED_REL_OPS[k]])),
    unWords: [...shared.wordOf].filter(([k]) => k.startsWith('UN_')).map(([k, w]) => [w, k.slice(3)]),
    strParams: fns.map((f) => [f.STR_P, f.STR_K1, f.STR_K2, f.STR_M0]),
    anchorVal: built.ANCHOR,
    probeIdx: built.probeIdx,
    probeVal: built.probeVal,
    layout: built.layout,
  });

  // 解析并注入根头部（rtlib 头部协议），标记 __rtKernel 豁免结构变换
  const parsed = parse(rt.source, { sourceType: 'script' });
  const stmts = parsed.program.body;
  const markKernel = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(markKernel); return; }
    if (typeof n.type !== 'string') return;
    if (n.type === 'FunctionDeclaration') n.__rtKernel = true;
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra') continue;
      markKernel(n[key]);
    }
  };
  markKernel(parsed.program);
  rtlib.insertHead(ctx, program, stmts);

  return {
    fns: fns.length,
    kinds: built.NS,
    words: fns.reduce((s, f) => s + f.flat.length, 0),
    moduleBytes: built.mod.length,
    smoke: built.smoke,
    rtLayers: rt.layers,
    // 宿主导入数：多路复用后恒为 5（u1/u2/v2/bin/un）。有人加回逐语义导入时
    // 这里会变，测试据此拦截"导入面悄悄膨胀"。
    imports: IMPORT_DEFS.length,
  };
}
