import t from '../ast/types.js';
import rand from '../utils/rand.js';
const { uniqueName, randInt } = rand;
import parser from '../ast/parser.js';
const { parse } = parser;
import wasmBin from '../ast/wasm.js';
const { buildModule, buildNameFuncs, OP, T_I32, T_F64, BLOCK_VOID, i32Const, localGet, localSet, i32Load, i32Store, uleb } = wasmBin;
import encode from '../utils/encode.js';
const { b64Encode } = encode;

/**
 * Uint8Array 转标准 base64 文本。
 *
 * 原实现走 Buffer.from(...).toString('base64')，那只在 Node 可用。这里分块用
 * fromCharCode 拼成字节串，再走 utils/encode 的纯 JS 编码器，浏览器与 Worker
 * 下同一份实现；产物里 atob 侧拿到的仍是标准字母表。
 *
 * @param {Uint8Array} bytes 字节
 * @returns {string} base64 文本
 */
function bytesToB64(bytes) {
  let s = '';
  const CHUNK = 8192; // 分块，避开 apply 的参数个数上限
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return b64Encode(s);
}

/**
 * 宿主是否允许从字节码即时编译 wasm。
 *
 * 探针是一个 8 字节的空模块（magic + 版本），编译它不依赖本项目的发射器。
 * Cloudflare Workers 出于安全只允许静态导入 .wasm，Node 与浏览器都允许，
 * 于是这里用能力探测代替环境名判断：探测失败一律按"不支持"处理，宁可跳过
 * 自检，也不要因为宿主限制把整个混淆判成失败。
 *
 * @returns {boolean} 可即时编译返回 true
 */
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

/**
 * WASM 虚拟机档。运行在 functionWrapper 之后、mangle 之前，就地处理主 AST。
 *
 * 对每个 vm 已编译函数做三件事。字节码数组字面量从函数体移除，全部函数的字节码
 * 合并进单个 WebAssembly 模块的数据段，存储密文再叠加一层模块级位置散列，静态
 * dump data 段拿不到可用字节码。函数体内的 B 声明替换成按调拷贝，形如
 * B = MEM.slice(baseWords + seg, baseWords + seg + len)。TypedArray.slice 返回
 * 元素级拷贝，每次调用得到独立数组，与 vm.js 里数组字面量每次调用重建的语义一致，
 * 掩码从 MASK_M0 起步、原位重写只作用于本次调用的副本，递归与重入都安全，
 * vm.js 生成的取指、解密与解释循环无需任何改动即可工作。模块另导出 init()、stak(i)、
 * mem()，init 返回 data 段锚定字，供宿主比对模块是否被替换；stak 返回代码区第 i 个
 * 探针字，供宿主比对构建期期望表以检测 data 段篡改；mem 是共享线性内存。
 *
 * 初始化器同步优先。先用 new WebAssembly.Module/Instance 同步编译实例化，Node、
 * CF Workers、浏览器 Worker 等任意大小都可用，浏览器主线程遇到超大模块会抛错；
 * 随后校验、解密，MEM 立即就绪。同步失败（主线程体积限制或无 WebAssembly）时退回
 * 异步 instantiate。READY.then 注册的回调在同步路径下当场执行。
 *
 * 布局分两种。ESM 下 mem/ready 注入模块体头部，全部原语句保持原位原序，
 * import/export 留在顶层，不设门，MEM 同步就绪后模块求值时天然可见；同步编译失败
 * 转入异步时，顶层 WASM 调用抛 TypeError，此时放行而不静默。脚本下 mem/ready 注入
 * root 头部，其余未被函数或导出引用依赖的原语句搬进 main()，由 READY.then(main)
 * 放行，同步路径下 main 在模块求值内同步执行，异步路径下推迟到 MEM 就绪。
 *
 * @param {object} ast     - AST，就地修改，functionWrapper 之后的形态
 * @param {object} options - { wasm, wasmThreshold, vmProtection }
 * @param {object} ctx     - 上下文 { traverse, t, usedNames, rng }
 * @returns {{moved:number, candidates:number, moduleBytes:number,
 *            readyName:string, memName:string, esm?:boolean}}
 */

/** i32 → LE 字节。 */
function i32le(v) {
  v = v | 0;
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

/**
 * 构建共享 WASM 模块。
 * 数据段全部是 i32 LE，按 dWORD 索引。下标 0 是 ANCHOR 锚定字，构建期随机，
 * init() 返回它供宿主比对；下标 1 是代码区字数；从下标 2 起是加密字节码，
 * 属模块级密文，宿主初始化时一次解密。CODEBASE 固定为 2 个 dWORD。
 * @param {Array<number[]>} segs 每函数的加密字节码，即 vm 产出的原密文
 * @param {Array<{P1:number,Q1:number,nb:number}>} dispParams 每函数的分发桶参数，
 *        存进 data 段参数表，由 bk(f,t) 导出在 wasm 内部读取计算，JS 侧没有
 *        P1/Q1 明文，桶映射无法静态还原
 * @param {Array<{K1:number,K2:number,seed:number}>} cnParams 每函数的取指解密参数，
 *        即位置散列 K1/K2 与链种子，由 cn 导出在 wasm 内部使用，JS 侧没有解密
 *        公式常数，链式解密因此是黑盒；链状态由调用方持有，递归各帧独立
 * @param {Array<{A:number,B:number}>} rotParams 每函数的入口掩码轮换参数，
 *        由 cr(f,m) 导出在 wasm 内部读取计算。JS 侧没有 ROT_A/ROT_B 明文，
 *        轮换函数只能靠反编译 wasm 求得
 * @returns {{mod:Uint8Array, codeBaseWords:number, segBaseWords:number[],
 *            dispBase:number, cnBase:number, rotBase:number,
 *            ANCHOR:number, probeIdx:number[], probeVal:number[], expNames:object}}
 */
function buildWasm(segs, dispParams, cnParams, rotParams) {
  const MOD_K1 = randInt(0x10001, 0x7ffffffe) | 1;
  const MOD_X = randInt(0x1000, 0xffffff);
  const ANCHOR = randInt(0x10000, 0xffffffff);
  // 模块层位置散列：以代码区全局字索引为位置分量
  const modHash = (j) => ((Math.imul(j + 1, MOD_K1) >>> 8) ^ MOD_X) >>> 0;

  const CODEBASE = 2; // dWORD

  // 拼代码区。
  const segBaseWords = [];
  const codeWords = [];
  for (const seg of segs) {
    segBaseWords.push(codeWords.length);
    for (let j = 0; j < seg.length; j++) {
      codeWords.push(((seg[j] >>> 0) ^ modHash(codeWords.length)) >>> 0);
    }
  }

  // 分发桶参数表（data 段代码区之后，每函数 3 字：P1,Q1,nb）。
  const dispBase = CODEBASE + codeWords.length;
  const dispWords = [];
  for (const d of dispParams) dispWords.push(d.P1 | 0, d.Q1 | 0, d.SH | 0);

  // 探针表：data 段代码区篡改检测（init 时比对，失配不解密）。
  const probeCount = Math.min(8, codeWords.length);
  const probeIdx = [];
  const probeVal = [];
  const step = Math.max(1, Math.floor(codeWords.length / probeCount));
  for (let k = 0; k < probeCount; k++) {
    const j = Math.min(codeWords.length - 1, k * step);
    probeIdx.push(j);
    probeVal.push(codeWords[j] >>> 0);
  }

  // 数据段字节。布局：[0]ANCHOR [1]len [2..]代码区 [..]分发参数表 [..]取指参数表(K1,K2)
  // [..]轮换参数表(ROT_A,ROT_B)
  const cnBase = dispBase + dispParams.length * 3;    // 取指参数表（每函数 K1,K2）
  const cnWords = [];
  for (const d of cnParams) cnWords.push(d.K1 | 0, d.K2 | 0);
  const rotBase = cnBase + cnParams.length * 2;       // 轮换参数表（每函数 ROT_A,ROT_B）
  const rotWords = [];
  for (const d of rotParams) rotWords.push(d.A | 0, d.B | 0);
  const sdBase = rotBase + cnParams.length * 2;       // 链种子表（每函数 CHAIN_SEED）
  const sdWords = [];
  for (const d of cnParams) sdWords.push(d.seed | 0);
  // 运行时状态表（每函数 3 字 [start, pc, chain]）。start 是该函数代码在 MEM 里的
  // 绝对 dWORD 下标，pc 是函数内字下标，chain 是当前链值。取指由 nx 在其中就地
  // 推进，JS 侧既没有 pc 也没有链状态。
  const stBase = sdBase + cnParams.length;
  const stWords = [];
  for (let i = 0; i < cnParams.length; i++) stWords.push(CODEBASE + segBaseWords[i], 0, 0);
  const dataBytes = [
    ...i32le(ANCHOR),
    ...i32le(codeWords.length),
    ...(() => { const out = []; for (const w of codeWords) out.push(...i32le(w)); return out; })(),
    ...(() => { const out = []; for (const w of dispWords) out.push(...i32le(w)); return out; })(),
    ...(() => { const out = []; for (const w of cnWords) out.push(...i32le(w)); return out; })(),
    ...(() => { const out = []; for (const w of rotWords) out.push(...i32le(w)); return out; })(),
    ...(() => { const out = []; for (const w of sdWords) out.push(...i32le(w)); return out; })(),
    ...(() => { const out = []; for (const w of stWords) out.push(...i32le(w)); return out; })(),
  ];

  // 反编译加固辅助。每构建随机组合等价的指令形，各产物之间形态不同。
  // splitConst 把立即数拆成 add 或 xor 的组合指令，常数不再以单个 i32.const
  // 明文出现，反编译看到的每个常数都是算式。
  const splitConst = (v) => {
    const style = randInt(0, 2);
    v = v | 0;
    if (style === 0) return i32Const(v);
    const a = randInt(1, 0x7ffffffe);
    if (style === 1) return [].concat(i32Const(a), i32Const((v - a) | 0), [OP.i32_add]);
    return [].concat(i32Const(a), i32Const((a ^ v) | 0), [OP.i32_xor]);
  };
  // junkSeq 产出栈平衡的死代码，包括不透明假分支与丢弃算式，干扰线性阅读
  const junkSeq = () => {
    const style = randInt(0, 3);
    if (style === 0) return [];
    if (style === 1) return [].concat(splitConst(randInt(1, 0xffff)), splitConst(randInt(1, 0xffff)), [OP.i32_add, OP.drop]);
    if (style === 2) return [].concat(splitConst(randInt(2, 0xffffff)), [OP.i32_eqz, OP.if, BLOCK_VOID], splitConst(randInt(1, 0xffff)), [OP.drop, OP.end]);
    return [].concat(i32Const(1), [OP.i32_eqz, OP.if, BLOCK_VOID, OP.nop, OP.end]);
  };
  // shr8Seq 把 `>>>8` 随机写成一次 8 位移或两次 4 位移，值等价但形不同
  const shr8Seq = () => (randInt(0, 1)
    ? [].concat(i32Const(8), [OP.i32_shr_u])
    : [].concat(i32Const(4), [OP.i32_shr_u], i32Const(4), [OP.i32_shr_u]));
  // 哑元局部，每函数 1 到 3 个未用的 i32 local，另给出首个哑元下标供临时值使用
  const dummyLocals = (paramCount) => {
    const n = randInt(1, 3);
    return { locals: [[n, T_I32]], tmp: paramCount };
  };

  // 内存布局。真数据段之后排 junk 段与诱饵 scratch 页
  const pages = Math.max(2, Math.ceil((dataBytes.length + 4096) / 65536) + randInt(0, 1));
  const SCRATCH = pages * 16384 - randInt(32, 96);   // dWORD 下标（末页顶）
  // junk 段位置，**字下标**。诱饵函数按 (x + JUNK_ADDR) * 4 读它，所以这里必须是
  // 字下标；而写数据段时用的是字节地址，下面 segDefs 里要乘 4。
  //
  // 必须落在真数据段之后。原先把 JUNK_ADDR 直接当字节地址写进数据段，等于把它
  // 落在了字下标 JUNK_ADDR/4（约 6144~7142）处，正好压在分发/取指/轮换/种子/状态
  // 这五张参数表上（字 6132~6904），把 K1、K2 随机改掉；wasm 侧读到的取指参数与
  // 构建期不一致，nx 自检就会以约四分之一的概率失败。放到数据段之后就再也不会重叠。
  const JUNK_ADDR = Math.ceil(dataBytes.length / 4) + randInt(8, 64);
  const junkBytes = [];
  for (let k = 0; k < randInt(256, 1024); k++) junkBytes.push(randInt(0, 255));

  // junk 段。addr 是数据段里的**字节**偏移；JUNK_ADDR 是字下标（诱饵函数按
  // (x + JUNK_ADDR) * 4 读它），两者差一个乘 4。这里只算一次，之后 segDefs 直接
  // 引用同一个对象，杜绝"两处写法不一致"。
  const junkSeg = { addr: JUNK_ADDR * 4, bytes: junkBytes };

  // 不变式，把 2026-09-19 那个 bug 钉死：当时 JUNK_ADDR 没乘 4 就当了字节偏移，
  // junk 段因此落在字下标 JUNK_ADDR/4（约 6144~7142），压在分发/取指/轮换/种子/
  // 状态这五张参数表（字 6132~6904）上，随机改掉 K1、K2，使 nx 自检以约四分之一
  // 的概率失败。
  //
  // 两条断言只看 junkSeg.addr —— 也就是真正写进数据段的那个值。写成"检查另一个
  // 变量"是没用的：那样改错 segDefs 时守卫照样不响。
  if (junkSeg.addr < dataBytes.length) {
    throw new Error('wasm 内存布局错误：junk 段（字节 ' + junkSeg.addr + '）落在真数据段'
      + '（' + dataBytes.length + ' 字节）之内，会覆盖参数表');
  }
  if (junkSeg.addr + junkBytes.length > pages * 65536) {
    throw new Error('wasm 内存布局错误：junk 段越出内存（' + (junkSeg.addr + junkBytes.length)
      + ' > ' + pages * 65536 + ' 字节）');
  }

  // WASM 函数体。
  // init() -> i32：返回锚定字（常数拆分形）
  const initBody = [].concat(junkSeq(), splitConst(ANCHOR), [OP.end]).flat(2);
  // stak(i) 返回 i32，即代码区第 i 个密文 word。地址有兩種等价算法：
  // A 为 (CODEBASE + i) << 2，B 为 (i << 2) + CODEBASE*4
  const stakD = dummyLocals(1);
  const stakBody = randInt(0, 1) === 0
    ? [].concat(junkSeq(), localGet(0), splitConst(CODEBASE), [OP.i32_add], i32Const(2), [OP.i32_shl], i32Load(), [OP.end]).flat(2)
    : [].concat(junkSeq(), localGet(0), i32Const(2), [OP.i32_shl], splitConst(CODEBASE * 4), [OP.i32_add], i32Load(), [OP.end]).flat(2);
  // bk(f, t) 返回 i32，即分发桶的仿射原值 h = t*P1 + Q1。参数表地址是
  // (dispBase + f*3 + k)*4。P1/Q1 只存在于 wasm 内存中，JS 侧没有仿射常数。
  // 非负模不在这里做，vm.js 把桶数取成 2 的幂之后用一次无符号右移取高位，
  // 每条指令的热路径因此不含 i32 除法，早先的 rem_s/add/rem_s 三重取模已经去掉。
  // 三种等价形随机选一：直算、h 先存局部、h 先存局部再插入中途 junk。
  const loadParam = (k) => [].concat(
    localGet(0),
    i32Const(3), [OP.i32_mul],
    splitConst(dispBase + k), [OP.i32_add],
    i32Const(2), [OP.i32_shl],
    i32Load(),
  ).flat(2);
  const bkD = { locals: [[2, T_I32]], th: 2, tr: 3 };
  const bkStyle = randInt(0, 3);
  const localSet = (i) => [OP.local_set, ...uleb(i)];
  // 仿射加取桶：h = (t*P1 + Q1) >>> SH，i32 环绕，SH 也在参数表里。
  // 右移在 wasm 内部完成，JS 侧连移位量都拿不到，桶号由 bk 直接返回，
  // 分发器拿到的就是最终桶下标。
  const affineH = () => [].concat(
    localGet(1), loadParam(0), [OP.i32_mul], loadParam(1), [OP.i32_add],
    loadParam(2), [OP.i32_shr_u]);
  let bkBody;
  if (bkStyle === 1) {
    // h 存进局部再取回，打散栈形
    bkBody = [].concat(junkSeq(),
      affineH(),
      localSet(bkD.th),
      localGet(bkD.th),
      [OP.end]).flat(2);
  } else if (bkStyle === 2) {
    // h 存局部，取回前插 junk。junk 序列净效果为零，栈深为 1 处不影响返回值
    bkBody = [].concat(junkSeq(),
      affineH(),
      localSet(bkD.th),
      junkSeq(),
      localGet(bkD.th),
      [OP.end]).flat(2);
  } else {
    bkBody = [].concat(junkSeq(),
      affineH(),
      [OP.end]).flat(2);
  }

  // cn(f, w, m, p, c) 返回 i32，做链式取指解密，K1/K2 常数存放在 wasm 内存里。
  // 公式是 plain = w ^ ((p*K1 >>> 8) ^ K2) ^ m ^ c。
  // 链值 c 由调用方持有，它是上一字的明文，作为函数局部变量存在，递归各帧独立，
  // 与 JS 档 nCHAIN 语义一致；返回值就是下一字的链值。纯函数，无状态。
  // 参数依次是 0=f，1=w（密文），2=m（当前掩码），3=p（取指位置），4=c（当前链值）。
  // cn 参数表地址为 (cnBase + f*2 + k)*4，k 取 0 是 K1，取 1 是 K2。
  const cnLoad = (k) => [].concat(
    localGet(0),
    i32Const(2), [OP.i32_mul],
    splitConst(cnBase + k), [OP.i32_add],
    i32Const(2), [OP.i32_shl],
    i32Load(),
  ).flat(2);
  // 位置分量 (p*K1 >>>8)^K2，两种等价移位形随机选
  const posSeq = () => [].concat(
    localGet(3), cnLoad(0), [OP.i32_mul], shr8Seq(), cnLoad(1), [OP.i32_xor],
  ).flat(2);
  const cnStyle = randInt(0, 3);
  let cnBody;
  if (cnStyle === 1) {
    // (m^c) ^ w ^ pos，按 XOR 交换律换一种组合次序
    cnBody = [].concat(junkSeq(),
      localGet(2), localGet(4), [OP.i32_xor],
      localGet(1), [OP.i32_xor],
      posSeq(), [OP.i32_xor],
      [OP.end]).flat(2);
  } else if (cnStyle === 2) {
    // w ^ m ^ c ^ pos
    cnBody = [].concat(junkSeq(),
      localGet(1), localGet(2), [OP.i32_xor],
      localGet(4), [OP.i32_xor],
      posSeq(), [OP.i32_xor],
      [OP.end]).flat(2);
  } else {
    cnBody = [].concat(junkSeq(),
      localGet(1),
      localGet(3), cnLoad(0), [OP.i32_mul], shr8Seq(),
      cnLoad(1), [OP.i32_xor],
      [OP.i32_xor],
      localGet(2), [OP.i32_xor],
      localGet(4), [OP.i32_xor],
      [OP.end]).flat(2);
  }

  // dx(i) 返回 i32，做模块层取指解密，载入 MEM[i] 后与模块级位置散列
  // ((i-(CODEBASE-1))*K1 >>> 8) ^ X 异或。K1 与 X 只存在于 wasm 指令流中，
  // 且经过 splitConst 算式化，JS 侧拿不到常数明文。它和 cn 的取指层一起构成双层
  // 解密。按分配律展开的变体 (i*K1 - (CODEBASE-1)*K1) 与直接式在 mod 2^32 下等值。
  const dxStyle = randInt(0, 2);
  const dxBody = dxStyle === 1
    ? [].concat(junkSeq(),
      localGet(0), i32Const(2), [OP.i32_shl], i32Load(),
      localGet(0), splitConst(MOD_K1), [OP.i32_mul],
      splitConst(((CODEBASE - 1) * MOD_K1) | 0), [OP.i32_sub],
      shr8Seq(), splitConst(MOD_X), [OP.i32_xor],
      [OP.i32_xor],
      [OP.end]).flat(2)
    : [].concat(junkSeq(),
      localGet(0),
      i32Const(2), [OP.i32_shl],
      i32Load(),
      localGet(0),
      splitConst(CODEBASE - 1), [OP.i32_sub],
      splitConst(MOD_K1), [OP.i32_mul],
      shr8Seq(),
      splitConst(MOD_X), [OP.i32_xor],
      [OP.i32_xor],
      [OP.end]).flat(2);

  // cr(f, m) 返回 i32，做入口掩码轮换：h = imul(m, ROT_A) ^ ROT_B。
  // ROT_A/ROT_B 只存在于 wasm 内存的参数表，JS 侧没有轮换函数的明文常数，
  // 每构建随机、每函数独立，静态面拿到的只有一次跨模块调用。
  const rotLoad = (k) => [].concat(
    localGet(0),
    i32Const(2), [OP.i32_mul],
    splitConst(rotBase + k), [OP.i32_add],
    i32Const(2), [OP.i32_shl],
    i32Load(),
  ).flat(2);
  const crBody = [].concat(junkSeq(),
    localGet(1), rotLoad(0), [OP.i32_mul],
    rotLoad(1), [OP.i32_xor],
    [OP.end]).flat(2);

  // 导出名随机化，构建期每次生成无语义短名。wasm 导出名不会进入 stringArray 的
  // 收集面，随机化之后再也不会泄露 init、stak、bk、cn、mem 的功能结构。
  // 名字在集合内互异，短名空间本就小，一旦碰撞会把一个模块的导出绑到另一个的桥上。
  const expName = (() => {
    const taken = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    const gen = () => Array.from({ length: randInt(2, 4) }, () =>
      'abcdefghijklmnopqrstuvwxyz'[randInt(0, 25)]).join('');
    return () => {
      let n;
      do { n = gen(); } while (taken.has(n));
      taken.add(n);
      return n;
    };
  })();
  // 运行时状态表地址：(stBase + f*3 + k) * 4，f 为参数 0
  const stAddrF = (k) => [].concat(
    localGet(0), i32Const(3), [OP.i32_mul],
    splitConst(stBase + k), [OP.i32_add],
    i32Const(2), [OP.i32_shl],
  ).flat(2);
  const stLoadF = (k) => [].concat(stAddrF(k), i32Load()).flat(2);

  // nx(f, mask) -> i32：取指并解密一个字，是全档的热路径核心。
  //   pc = st[1]；idx = st[0] + pc；raw = MEM[idx]；
  //   模块层 plain = raw ^ (((idx-(CODEBASE-1))*MOD_K1 >>> 8) ^ MOD_X)；
  //   vm 层 v = plain ^ (((pc+1)*K1 >>> 8) ^ K2) ^ mask ^ chain；
  //   回写 chain = v、pc = pc + 1；返回 v。
  // 取指、两层位置散列、链推进与状态更新全部在 wasm 内完成。JS 侧没有 pc、
  // 没有链、也没有 B 数组，静态面拿不到任何一条指令的明文或它的位置分量。
  const nxBody = [].concat(junkSeq(),
    // pc -> local2
    stLoadF(1), localSet(2),
    // idx = start + pc -> local3
    stLoadF(0), localGet(2), [OP.i32_add], localSet(3),
    // raw 与模块层解密 -> local4
    localGet(3), i32Const(2), [OP.i32_shl], i32Load(),
    localGet(3), splitConst(CODEBASE - 1), [OP.i32_sub],
    splitConst(MOD_K1), [OP.i32_mul], shr8Seq(), splitConst(MOD_X), [OP.i32_xor],
    [OP.i32_xor], localSet(4),
    // vm 层解密 -> local5
    localGet(4),
    localGet(2), i32Const(1), [OP.i32_add],
    cnLoad(0), [OP.i32_mul], shr8Seq(), cnLoad(1), [OP.i32_xor],
    [OP.i32_xor],
    localGet(1), [OP.i32_xor],
    stLoadF(2), [OP.i32_xor],
    localSet(5),
    // chain = v
    stAddrF(2), localGet(5), i32Store(),
    // pc = pc + 1
    stAddrF(1), localGet(2), i32Const(1), [OP.i32_add], i32Store(),
    // 返回 v
    localGet(5),
    [OP.end]).flat(2);

  // spc(f, target) -> i32：跳转复位，把该函数的 pc 槽直接写成目标字下标并返回目标值。
  // 链值不在这里写：跳转序列里紧跟目标字的那个链值字已被 nx 取走，此刻链恰好等于
  // chainAt[target]，与从字 0 顺序推进到 target 时构建期预置的链值一致。JS 侧没有 pc，
  // 跳转只能经这里复位，目标下标也来自 wasm 内存里的 start 基址。
  const spcBody = [].concat(junkSeq(),
    stAddrF(1), localGet(1), i32Store(),
    localGet(1),
    [OP.end]).flat(2);

  const expNames = { init: expName(), stak: expName(), bk: expName(), cn: expName(), dx: expName(), cr: expName(), nx: expName(), spc: expName(), mem: expName() };

  // 诱饵导出函数，是 scratch 页上的仿射与扫描死代码，语义形同真函数，
  // 分别做 f&t 的仿射读写和 i 的扫描求和，JS 侧永不引用
  const decoyAffine = () => {
    const A = randInt(1, 0x7ffffffe) | 1;
    const B = randInt(1, 0xffffff);
    return [].concat(junkSeq(),
      localGet(0), i32Const(15), [OP.i32_and],
      splitConst(SCRATCH), [OP.i32_add], i32Const(2), [OP.i32_shl],
      localSet(2),
      localGet(2), i32Load(),
      localGet(1), splitConst(A), [OP.i32_mul], splitConst(B), [OP.i32_add],
      [OP.i32_xor],
      localSet(3),
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
      splitConst(JUNK_ADDR), [OP.i32_add], i32Const(2), [OP.i32_shl], i32Load(),
      localGet(0), i32Const(3), [OP.i32_and],
      splitConst(JUNK_ADDR + 2), [OP.i32_add], i32Const(2), [OP.i32_shl], i32Load(),
      [OP.i32_add],
      junkSeq(),
      splitConst(C), [OP.i32_xor],
      [OP.end]).flat(2);
  };
  const fnDefs = [
    { name: expNames.init, typeIdx: 0, locals: [[randInt(1, 2), T_I32]], body: initBody },
    { name: expNames.stak, typeIdx: 1, locals: stakD.locals, body: stakBody },
    { name: expNames.bk, typeIdx: 2, locals: bkD.locals, body: bkBody },
    { name: expNames.cn, typeIdx: 3, locals: [[randInt(1, 2), T_I32]], body: cnBody },
    { name: expNames.dx, typeIdx: 1, locals: [[randInt(1, 2), T_I32]], body: dxBody },
    { name: expNames.cr, typeIdx: 2, locals: [[randInt(1, 2), T_I32]], body: crBody },
    { name: expNames.nx, typeIdx: 2, locals: [[4, T_I32]], body: nxBody },
    { name: expNames.spc, typeIdx: 2, locals: [[randInt(1, 2), T_I32]], body: spcBody },
  ];
  const decoyCount = randInt(2, 4);
  for (let d = 0; d < decoyCount; d++) {
    const dn = expName();
    fnDefs.push(d % 2 === 0
      ? { name: dn, typeIdx: 2, locals: [[2, T_I32]], body: decoyAffine() }
      : { name: dn, typeIdx: 1, locals: [[1, T_I32]], body: decoyScan() });
  }
  // 函数顺序洗牌：导出按新下标绑定（JS 侧只按名取用，功能无影响）
  for (let i = fnDefs.length - 1; i > 0; i--) {
    const j = randInt(0, i); const t = fnDefs[i]; fnDefs[i] = fnDefs[j]; fnDefs[j] = t;
  }

  const types = [
    { params: [], results: [T_I32] },             // type0: init()
    { params: [T_I32], results: [T_I32] },        // type1: stak(i)/dx(i)/扫描诱饵
    { params: [T_I32, T_I32], results: [T_I32] }, // type2: bk(f,t)/仿射诱饵
    { params: [T_I32, T_I32, T_I32, T_I32, T_I32], results: [T_I32] }, // type3: cn
  ];
  for (let d = 0; d < randInt(0, 2); d++) types.push({ params: [T_I32], results: [] }); // 未用型噪声

  // 数据段：真数据段 + junk 段（地址相邻但区域不重叠），段序与偏移
  // 表达式形态随机（extended-const 双常数加法形合法）
  const segDefs = [
    { addr: 0, bytes: dataBytes },
    // junkSeg.addr 已由上面的不变式保证落在真数据段之后、且不越出内存。
    junkSeg,
  ];
  const dataSegs = segDefs.map((s) => {
    if (randInt(0, 1) === 0) return { offsetBytes: [...i32Const(s.addr), OP.end], bytes: s.bytes };
    const a = randInt(1000, 60000);
    return { offsetBytes: [].concat(i32Const(a), i32Const(s.addr - a), [OP.i32_add, OP.end]), bytes: s.bytes };
  });
  for (let i = dataSegs.length - 1; i > 0; i--) {
    const j = randInt(0, i); const t = dataSegs[i]; dataSegs[i] = dataSegs[j]; dataSegs[j] = t;
  }

  const expList = fnDefs.map((f, i) => ({ name: f.name, kind: 0, idx: i }));
  expList.push({ name: expNames.mem, kind: 2, idx: 0 });
  for (let i = expList.length - 1; i > 0; i--) {
    const j = randInt(0, i); const t = expList[i]; expList[i] = expList[j]; expList[j] = t;
  }

  // 假 name 自定义段：wasm-dis/IDA 等反编译工具会把这些符号渲染到函数
  // 上（与本模块真实功能毫无关联）；Web 引擎按规范忽略未知自定义段
  const FAKE_SYMS = ['malloc', 'free', 'memcpy', 'memmove', '__multi3', '__udivti3',
    'htonl', 'deflate_block', 'lzma_decode', 'sha256_transform', 'btree_split',
    '_Znwj', '_ZdlPv', 'rb_insert_color', 'pow_p', 'exp_m1', 'locale_facet', 'wcsnrtombs'];
  const nameBytes = buildNameFuncs(
    fnDefs.map((f, i) => [i, FAKE_SYMS[randInt(0, FAKE_SYMS.length - 1)] + '_' + randInt(10, 99999).toString(36)]),
  );

  const mod = buildModule({
    types,
    imports: [],
    funcs: fnDefs.map((f) => ({ typeIdx: f.typeIdx, locals: f.locals, body: f.body })),
    memPages: pages,
    exports: expList,
    data: dataSegs,
    nameBytes,
  });
  // 构建期自检：用 nx 把每个函数的字节码逐字走一遍，结果必须与构建期写入的
  // 明文逐字相等。nx 把取指、两层位置散列、链推进与状态更新收进 wasm，这里在
  // 构建期用真实 wasm 引擎跑一遍，作为它的正确性证据，不依赖产物运行。
  //
  // 但有些宿主不允许从字节码即时编译 wasm（Cloudflare Workers 出于安全只支持
  // 静态导入 .wasm），那里的自检根本跑不起来。自检只是正确性证据，产物本身
  // 由 mod 决定，因此宿主不支持时跳过、不把整个混淆判为失败。先拿一个 8 字节
  // 空模块探一下宿主能力，而不是靠错误文案猜。
  const canCompileWasm = wasmCompilable();
  let nxOk = true;
  let nxWords = 0;
  let nxErr = '';
  try {
    if (!canCompileWasm) throw new Error('SKIP');
    const inst = new WebAssembly.Instance(new WebAssembly.Module(mod));
    const ex = inst.exports;
    const M = new Int32Array(ex[expNames.mem].buffer);
    const nx = ex[expNames.nx];
    for (let i = 0; i < cnParams.length && nxOk; i++) {
      const start = CODEBASE + segBaseWords[i];
      M[stBase + i * 3] = start;
      M[stBase + i * 3 + 1] = 0;
      M[stBase + i * 3 + 2] = cnParams[i].seed | 0;
      for (let z = 0; z < segs[i].length; z++) {
        const got = nx(i, cnParams[i].m0 | 0) >>> 0;
        // seg 里存的是 VM 层密文 flat，wasm 内部又套了一层模块层散列；nx 返回的是两层
        // 都解完的指令字，所以期望值必须自己还原（密文 ^ 位置散列 ^ 初始掩码 ^ 链值），
        // 不能直接拿 seg 比。位置散列用与 vm.js posMask 相同的仿射形。
        const cp = cnParams[i];
        const pos = ((Math.imul(z + 1, cp.K1 | 0) >>> 8) ^ (cp.K2 | 0)) >>> 0;
        const want = ((segs[i][z] >>> 0) ^ pos ^ (cp.m0 | 0) ^ (cp.chain[z] >>> 0)) >>> 0;
        if (got !== want) {
          nxOk = false;
          nxErr = 'f=' + i + ' z=' + z + '/' + segs[i].length +
            ' want=' + want + ' got=' + got +
            ' xor=' + ((want ^ got) >>> 0) +
            ' seed=' + (cnParams[i].seed | 0) + ' m0=' + (cnParams[i].m0 | 0) +
            ' K1=' + (cnParams[i].K1 | 0) + ' K2=' + (cnParams[i].K2 | 0) +
            ' MOD_K1=' + (MOD_K1 | 0) + ' MOD_X=' + (MOD_X | 0) +
            ' stBase=' + stBase + ' sdBase=' + sdBase + ' start=' + start +
            ' segWords=' + segs[i].length;
          break;
        }
        nxWords++;
      }
      if (!nxOk) break;
      // spc 单元自检：把 pc 槽写到中段某下标，直接读回内存槽比对地址算式。
      // 链值复位不由 spc 负责（见 spcBody 注释），因此这里只验证 pc 槽写入。
      const spc = ex[expNames.spc];
      const tPos = Math.floor(segs[i].length / 2);
      spc(i, tPos);
      if (M[stBase + i * 3 + 1] !== tPos) {
        nxOk = false;
        nxErr = 'spc f=' + i + ' pc slot=' + M[stBase + i * 3 + 1] + ' want=' + tPos;
        break;
      }
      // 跳转复位不变式：顺序取指 t 次之后，nx 推进出的链值必须等于构建期预置的
      // chainAt[t]（t=0 时等于 CHAIN_SEED）。跳转序列里紧跟目标字的链值字正是这个
      // 值，被 nx 取走之后链自然落到 chainAt[t]，所以 spc 只需改 pc，无需碰链。
      // 这里逐下标复位重放，把该不变式钉死在构建期。
      const cp2 = cnParams[i];
      // chainAt 只对 0..len-1 有定义：chainAt[0] 是 CHAIN_SEED，chainAt[z] 是取第 z 字
      // 之前的链值（即第 z-1 字的明文）。t 取到 len 就是一字越界，那里没有预置值，
      // 所以上界取两者较���值。跳转目标只可能落在 0..len-1，该范围已覆盖全部跳转复位。
      const lim = Math.min(cp2.chain.length, segs[i].length);
      for (let t = 0; t < lim; t++) {
        M[stBase + i * 3] = start;
        M[stBase + i * 3 + 1] = 0;
        M[stBase + i * 3 + 2] = cp2.seed | 0;
        for (let q = 0; q < t; q++) nx(i, cp2.m0 | 0);
        if (M[stBase + i * 3 + 2] !== (cp2.chain[t] | 0)) {
          nxOk = false;
          nxErr = 'chainAt f=' + i + ' t=' + t + ' got=' + M[stBase + i * 3 + 2] +
            ' want=' + (cp2.chain[t] | 0) + ' lim=' + lim +
            ' segLen=' + segs[i].length + ' chainLen=' + cp2.chain.length;
          break;
        }
      }
      if (!nxOk) break;
    }
  } catch (e) {
    nxOk = false;
    nxErr = 'throw: ' + (e && e.message ? e.message : String(e));
  }
  // 宿主不支持即时编译 wasm：自检跳过，产物照常返回
  if (!canCompileWasm) nxOk = true;
  if (!nxOk) throw new Error('wasm nx 自检失败：取指解密与构建期明文不一致 [' + nxErr + ']');

  return { mod, codeBaseWords: CODEBASE, segBaseWords, dispBase, cnBase, rotBase, sdBase, stBase,
    ANCHOR, probeIdx, probeVal, expNames, nxWords, nxChecked: canCompileWasm };
}

export default function wasm(ast, options, ctx) {
  if (options.wasm === false) return { moved: 0, candidates: 0, moduleBytes: 0 };
  if (options.vmProtection === false) {
    // VM 关闭时没有字节码可迁移，这里直接返回而不报错，因为 CLI 允许自由组合
    return { moved: 0, candidates: 0, moduleBytes: 0 };
  }
  const program0 = ast.type === 'File' ? ast.program : ast;
  // ESM 用同步优先初始化，即 new WebAssembly.Module/Instance，让 MEM 在模块求值前
  // 就绪。全部原语句保持顶层原序，import/export 不能搬，也不设门。同步路径失败时
  // 转入异步，浏览器主线程遇到大模块限制等都会走到这里：MEM 延后就绪，期间顶层 WASM
  // 调用抛 TypeError，宁可报错也不静默产出错误结果。
  const isModule = program0.body.some((s) =>
    s.type === 'ImportDeclaration' || s.type === 'ExportNamedDeclaration' ||
    s.type === 'ExportDefaultDeclaration' || s.type === 'ExportAllDeclaration');
  // 全部可搬函数都搬（阈值默认 0；wasm-threshold 可调回）
  const wasmThreshold = options.wasmThreshold !== undefined ? options.wasmThreshold : 0;

  // 收集 vm 已编译函数。
  const cands = [];
  ctx.traverse(ast, {
    Function: (p) => { if (p.node.__vmMeta) cands.push(p.node); },
    noScope: true,
  });
  if (!cands.length) return { moved: 0, candidates: 0, moduleBytes: 0 };

  const picked = cands.filter((fn) => fn.__vmMeta.flat.length >= wasmThreshold);
  if (!picked.length) return { moved: 0, candidates: cands.length, moduleBytes: 0 };

  const fns = picked.map((fn, i) => ({ fn, meta: fn.__vmMeta, idx: i }));
  // 分发桶参数与取指解密参数按函数逐个进 wasm data 段，由 bk/cn 导出在内部读取计算。
  // JS 侧没有 P1、Q1、K1、K2 的明文，桶映射与解密公式只能靠反编译 wasm 求得
  const wasm = buildWasm(
    fns.map((f) => f.meta.flat),
    fns.map((f) => f.meta.disp || { P1: 1, Q1: 0, nb: 2, SH: 0 }),
    fns.map((f) => ({ K1: f.meta.MASK_K1, K2: f.meta.MASK_K2, seed: f.meta.CHAIN_SEED, m0: f.meta.MASK_M0, chain: f.meta.chainAt })),
    fns.map((f) => ({ A: f.meta.ROT_A, B: f.meta.ROT_B })),
  );

  // 各函数体把 B 数组字面量换成按调拷贝共享内存段。
  // MEM.slice(base, base+len) 是元素级拷贝，vm.js 的轮换、取指与解释循环原样工作，
  // 语义与每次调用从字面量重建数组完全等价
  const MEM = uniqueName(ctx.usedNames, '_0x');
  const BK = uniqueName(ctx.usedNames, '_0x'); // 分发桶函数桥（init 赋值）
  const CN = uniqueName(ctx.usedNames, '_0x'); // 取指解密函数桥（init 赋值）
  const CR = uniqueName(ctx.usedNames, '_0x'); // 入口掩码轮换函数桥（init 赋值）
  const NX = uniqueName(ctx.usedNames, '_0x'); // 取指+双层解密+链推进桥（init 赋值）
  const SPC = uniqueName(ctx.usedNames, '_0x'); // 跳转 pc 复位桥（init 赋值）
  let moved = 0;
  let bkMoved = 0;
  let cnMoved = 0;
  let crMoved = 0;
  for (const f of fns) {
    const m = f.meta;
    let decl = null;
    for (const s of f.fn.body.body) {
      if (s.type !== 'VariableDeclaration') continue;
      for (const d of s.declarations) {
        if (d.id && d.id.name === m.nB && d.init && d.init.type === 'ArrayExpression') {
          decl = d;
        }
      }
    }
    if (!decl) continue;
    const from = wasm.codeBaseWords + wasm.segBaseWords[f.idx];
    const to = from + m.flat.length;
    decl.init = ctx.rt && ctx.rt.tas
      ? t.callExpression(t.identifier(ctx.rt.tas),
        [t.identifier(MEM), t.numericLiteral(from), t.numericLiteral(to)])
      : t.callExpression(
        t.memberExpression(t.identifier(MEM), t.identifier('slice'), false),
        [t.numericLiteral(from), t.numericLiteral(to)]);
    moved++;
    // 入口掩码轮换改写为 CR(fIdx, MASK)。定位特征是
    // 「(imul(MASK, ROT_A) ^ ROT_B) >>> 0」整棵子树，ROT_A 逐函数唯一，
    // 不会误伤用户代码里���其它异或或移位。替换后 JS 侧不再持有 ROT_A/ROT_B
    // 明文，轮换函数只能靠反编译 wasm 求得。
    if (m.nM && m.ROT_A !== undefined) {
      const ROT_A = m.ROT_A;
      const MUL = ctx.rt && ctx.rt.mul;
      const isRotCore = (n) => n && n.type === 'CallExpression' &&
        n.callee && n.callee.type === 'Identifier' && n.callee.name === MUL &&
        n.arguments && n.arguments.length === 2 &&
        n.arguments[0].type === 'Identifier' && n.arguments[0].name === m.nM &&
        n.arguments[1].type === 'NumericLiteral' && n.arguments[1].value === ROT_A;
      const isRotExpr = (n) => n && n.type === 'BinaryExpression' && n.operator === '>>>' &&
        n.left && n.left.type === 'BinaryExpression' && n.left.operator === '^' &&
        isRotCore(n.left.left) &&
        n.left.right && n.left.right.type === 'NumericLiteral';
      const rotWalk = (n) => {
        if (!n || typeof n !== 'object' || typeof n.type !== 'string') return;
        for (const key of Object.keys(n)) {
          if (key === 'loc' || key === 'extra') continue;
          const v = n[key];
          if (Array.isArray(v)) {
            for (let i = 0; i < v.length; i++) {
              if (isRotExpr(v[i])) {
                v[i] = t.callExpression(t.identifier(CR),
                  [t.numericLiteral(f.idx), t.identifier(m.nM)]);
                crMoved++;
              } else rotWalk(v[i]);
            }
          } else if (v && typeof v === 'object') {
            if (isRotExpr(v)) {
              n[key] = t.callExpression(t.identifier(CR),
                [t.numericLiteral(f.idx), t.identifier(m.nM)]);
              crMoved++;
            } else rotWalk(v);
          }
        }
      };
      rotWalk(f.fn);
    }
    // 桶号表达式改写为 BK(fIdx, t)：traverse 该函数体定位所有
    // 「MUL(dispT, P1)」子树（RT 内核模拟 imul；P1 为函数私有仿射常数，
    // 特征唯一），以调用节点整体替换。多态分发的全部形态（switch 判别式 /
    // 表索引 / 桶链比较）都含此子树 → 单一特征覆盖三形态。
    if (m.disp && m.dispT) {
      const P1 = m.disp.P1;
      const MUL = ctx.rt && ctx.rt.mul;
      // 手动递归替换含特征 MUL(dispT,P1) 的最外层仿射取模
      // 表达式（「imul(...)+Q1」节点整体换为 BK 调用）。
      const isImulDisp = (call) => call && call.type === 'CallExpression' &&
        call.callee && call.callee.type === 'Identifier' && call.callee.name === MUL &&
        call.arguments && call.arguments.length === 2 &&
        call.arguments[0].type === 'Identifier' && call.arguments[0].name === m.dispT &&
        call.arguments[1].type === 'NumericLiteral' && call.arguments[1].value === P1;
      // 桶号整式：(imul(dispT, P1) + Q1) >>> SH。仿射常数与移位量都在 wasm
      // 参数表里，整式换成一次 BK(f, dispT) 调用后 JS 侧不再持有任何桶映射常数。
      const isBucketExpr = (n) => n && n.type === 'BinaryExpression' && n.operator === '>>>' &&
        n.left && n.left.type === 'BinaryExpression' && n.left.operator === '+' &&
        isImulDisp(n.left.left);
      const replaceWalk = (n) => {
        if (!n || typeof n !== 'object' || typeof n.type !== 'string') return;
        for (const key of Object.keys(n)) {
          if (key === 'loc' || key === 'extra') continue;
          const v = n[key];
          if (Array.isArray(v)) {
            for (let i = 0; i < v.length; i++) {
              if (isBucketExpr(v[i])) {
                v[i] = t.callExpression(t.identifier(BK), [t.numericLiteral(f.idx), t.identifier(m.dispT)]);
                bkMoved++;
              } else replaceWalk(v[i]);
            }
          } else if (v && typeof v === 'object' && typeof v.type === 'string') {
            if (isBucketExpr(v)) {
              n[key] = t.callExpression(t.identifier(BK), [t.numericLiteral(f.idx), t.identifier(m.dispT)]);
              bkMoved++;
            } else replaceWalk(v);
          }
        }
      };
      replaceWalk(f.fn);
    }
    // 取指解密表达式改写成 CN(f, B[pc++], MASK, pc, chain)。定位办法是找
    // AssignmentExpression（nCHN = DEC），且 DEC 子树含 Math.imul(npc, MASK_K1)，
    // 这是函数私有位置散列的特征；命中后把整个 DEC 换成 CN 调用，B[pc++] 成员节点
    // 原样提取，自增副作用保留。链值与掩码仍由 JS 变量传递，递归各帧独立，语义与
    // JS 档一致；K1/K2 解密常数只存在于 wasm 内存。
    if (m.npc && m.MASK_K1 !== undefined) {
      const K1 = m.MASK_K1;
      const MUL = ctx.rt && ctx.rt.mul;
      const subHasImul = (n) => {
        if (!n || typeof n !== 'object' || typeof n.type !== 'string') return false;
        if (n.type === 'CallExpression' && n.callee && n.callee.type === 'Identifier' &&
            n.callee.name === MUL && n.arguments && n.arguments.length === 2 &&
            n.arguments[0].type === 'Identifier' && n.arguments[0].name === m.npc &&
            n.arguments[1].type === 'NumericLiteral' && n.arguments[1].value === K1) return true;
        for (const key of Object.keys(n)) {
          if (key === 'loc' || key === 'extra') continue;
          const v = n[key];
          if (Array.isArray(v)) { for (const c of v) if (subHasImul(c)) return true; }
          else if (v && typeof v === 'object' && typeof v.type === 'string' && subHasImul(v)) return true;
        }
        return false;
      };
      const findFetch = (n) => {
        if (!n || typeof n !== 'object' || typeof n.type !== 'string') return null;
        if (n.type === 'MemberExpression' && n.computed === true &&
            n.object && n.object.type === 'Identifier' && n.object.name === m.nB &&
            n.property && n.property.type === 'UpdateExpression') return n;
        for (const key of Object.keys(n)) {
          if (key === 'loc' || key === 'extra') continue;
          const v = n[key];
          if (Array.isArray(v)) { for (const c of v) { const r = findFetch(c); if (r) return r; } }
          else if (v && typeof v === 'object' && typeof v.type === 'string') { const r = findFetch(v); if (r) return r; }
        }
        return null;
      };
      const cnWalk = (n) => {
        if (!n || typeof n !== 'object' || typeof n.type !== 'string') return;
        for (const key of Object.keys(n)) {
          if (key === 'loc' || key === 'extra') continue;
          const v = n[key];
          if (Array.isArray(v)) {
            for (let i = 0; i < v.length; i++) {
              const e = v[i];
              if (e && e.type === 'AssignmentExpression' && e.operator === '=' &&
                  e.left && e.left.type === 'Identifier' && e.left.name === m.nCHN &&
                  e.right && subHasImul(e.right)) {
                const fetch = findFetch(e.right);
                if (!fetch) continue;
                v[i] = t.assignmentExpression('=', e.left, t.callExpression(
                  t.identifier(CN), [
                    t.numericLiteral(f.idx),
                    fetch,
                    t.identifier(m.nM),
                    t.identifier(m.npc),
                    t.identifier(m.nCHAIN),
                  ]));
                cnMoved++;
              } else cnWalk(e);
            }
          } else if (v && typeof v === 'object' && typeof v.type === 'string') {
            if (v.type === 'AssignmentExpression' && v.operator === '=' &&
                v.left && v.left.type === 'Identifier' && v.left.name === m.nCHN &&
                v.right && subHasImul(v.right)) {
              const fetch = findFetch(v.right);
              if (!fetch) continue;
              n[key] = t.assignmentExpression('=', v.left, t.callExpression(
                t.identifier(CN), [
                  t.numericLiteral(f.idx),
                  fetch,
                  t.identifier(m.nM),
                  t.identifier(m.npc),
                  t.identifier(m.nCHAIN),
                ]));
              cnMoved++;
            } else cnWalk(v);
          }
        }
      };
      cnWalk(f.fn);
    }
  }
  if (!moved) return { moved: 0, candidates: cands.length, moduleBytes: 0 };

  // 全局初始化器，同步优先，同步失败才转异步。
  // 同步路径用 new WebAssembly.Module/Instance，Node、Workers 与浏览器 Worker 下
  // 任意大小都行；浏览器主线程遇到超大模块会抛错，于是转入异步路径。
  // 异步路径用 WebAssembly.instantiate 的 promise，就绪后由 READY 回调放行。
  // READY.then(f) 在同步路径下让 f 当场执行，模块求值内 main 随即运行；
  // 在异步路径下等 MEM 就绪后再执行 f。
  const READY = uniqueName(ctx.usedNames, '_0x');
  const b64 = bytesToB64(wasm.mod);
  const totalWords = fns.reduce((s, f) => s + f.meta.flat.length, 0);
  const base = wasm.codeBaseWords;

  // 探针期望表（构建期固化；init 时比对）
  const probeIdxLit = wasm.probeIdx.join(',');
  const probeValLit = wasm.probeVal.join(',');

  const initSrc = `(function(){
var _ab = ${ctx.rt && ctx.rt.b64 ? ctx.rt.b64 : '(function(s){var A="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";var D={};for(var q=0;q<64;q++)D[A[q]]=q;var o=[],bi=0,ac=0;for(var i=0;i<s.length;i++){var v=D[s[i]];if(v===undefined)continue;ac=(ac<<6)|v;bi+=6;if(bi>=8){bi-=8;o[o.length]=(ac>>bi)&255;}}return o;})'};
var _w = new Uint8Array(_ab("${b64}"));
var _pi = [${probeIdxLit}];
var _pv = [${probeValLit}];
var _r = { d: null, then: function(f){ _r.d = f; _f(); } };
var _ok = false;
function _f(){ if (_ok && _r.d) { var d = _r.d; _r.d = null; d(); } }
function _v(I) {
  if ((I.exports.${wasm.expNames.init}() >>> 0) !== ${wasm.ANCHOR >>> 0}) return false;
  for (var k = 0; k < _pi.length; k++) {
    if ((I.exports.${wasm.expNames.stak}(_pi[k]) >>> 0) !== (_pv[k] >>> 0)) return false;
  }
  var M = new Int32Array(I.exports.${wasm.expNames.mem}.buffer);
  for (var i = ${base}; i < ${base + totalWords}; i++) {
    M[i] = I.exports.${wasm.expNames.dx}(i) | 0; // 模块层解密：常数只在 wasm 指令流里
  }
  ${MEM} = M;
  ${BK} = I.exports.${wasm.expNames.bk}; // 分发桶函数（P1/Q1/nb 在 wasm 内存，JS 无明文）
  ${CN} = I.exports.${wasm.expNames.cn}; // 取指解密函数（K1/K2 在 wasm 内存，链值由调用方持有）
  ${CR} = I.exports.${wasm.expNames.cr}; // 入口掩码轮换函数（ROT_A/ROT_B 在 wasm 内存，JS 无明文）
  ${NX} = I.exports.${wasm.expNames.nx}; // 取指：pc/链状态在 wasm 内存，JS 侧无 pc 无链
  ${SPC} = I.exports.${wasm.expNames.spc}; // 跳转 pc 复位，链值自洽无需改写
  return true;
}
function _g(){
  try {
    if (typeof WebAssembly === "undefined") { _ok = true; _f(); return; }
    try {
      // 同步快道：编译 + 实例化 + 校验 + 解密，一次完成
      var I = new WebAssembly.Instance(new WebAssembly.Module(_w));
      _v(I); // 校验失败：MEM 保持 null（WASM 函数首调抛错）
      _ok = true; _f(); return;
    } catch (e) { /* 同步编译被拒（如主线程体积限制）→ 异步兜底 */ }
    (WebAssembly.instantiate(_w)).then(function(R){
      try { _v(R.instance); } catch (e) { /* MEM 保持 null */ }
      _ok = true; _f();
    }, function(){ _ok = true; _f(); });
  } catch (e) { _ok = true; _f(); }
}
_g();
return _r;
})()`;

  // 注入：wrapper IIFE 体内。
  const program = ast.type === 'File' ? ast.program : ast;
  let rootBody = null;
  let inWrapper = false;
  if (program.body.length === 1 && program.body[0].type === 'ExpressionStatement' &&
      program.body[0].expression && program.body[0].expression.type === 'CallExpression') {
    const callee = program.body[0].expression.callee;
    if (callee.type === 'FunctionExpression' && callee.body) {
      rootBody = callee.body.body;
      inWrapper = true;
    }
  }
  if (!rootBody) rootBody = program.body;

  const initAst = parse(`var ${MEM} = null;
var ${BK} = null;
var ${CN} = null;
var ${CR} = null;
var ${NX} = null;
var ${SPC} = null;
var ${READY} = ${initSrc};`, { sourceType: 'script' });
  const memDecl = initAst.program.body[0];
  const bkDecl = initAst.program.body[1];
  const cnDecl = initAst.program.body[2];
  const crDecl = initAst.program.body[3];
  const nxDecl = initAst.program.body[4];
  const spcDecl = initAst.program.body[5];
  const readyDecl = initAst.program.body[6];

  // ESM 下全量搬字节码，语句布局不动。
  // 同步路径让 MEM 在 readyDecl 求值时即就绪，模块体后续语句按原序求值时 WASM
  // 函数直接可用。原语句含 import/export 在内全部保持顶层原位原序，不设门，也不加
  // main 包装，export 可见性与源文件一致。同步编译被拒而走异步时 MEM 延后就绪，
  // 期间 WASM 函数调用抛 TypeError，放行而不静默。
  if (isModule) {
    const body = program.body;
    const firstNonImport = body.findIndex((s) => s.type !== 'ImportDeclaration');
    const insertAt = firstNonImport < 0 ? body.length : firstNonImport;
    // import 提升语义下放哪都行；放在首条非 import 语句前保持直观。
    body.splice(insertAt, 0, memDecl, bkDecl, cnDecl, crDecl, nxDecl, spcDecl, readyDecl);
    return {
      moved, candidates: cands.length, moduleBytes: wasm.mod.length,
      readyName: READY, memName: MEM, esm: true,
    };
  }

  const directives = rootBody.filter((s) => s.type === 'Directive');
  const fnDecls = rootBody.filter((s) => s.type === 'FunctionDeclaration');
  const varDecls = rootBody.filter((s) => s.type === 'VariableDeclaration');
  const clsDecls = rootBody.filter((s) => s.type === 'ClassDeclaration');
  // ESM 模块声明（import/export）只能出现在模块顶层，一律留在 root，
  // 绝不进 mainFn（否则 Workers/ESM 报 Cannot use import statement
  // outside a module）。
  const moduleStmts = rootBody.filter((s) =>
    s.type === 'ImportDeclaration' || s.type === 'ExportNamedDeclaration' ||
    s.type === 'ExportDefaultDeclaration' || s.type === 'ExportAllDeclaration');

  // 词法作用域保全：root 上的函数声明（vm 编译函数等）按词法作用域
  // 引用 root 声明（stringArray 解码器 var、类声明等），其顶层声明语句
  // 必须留在 root。"整棵子树标识符名 − 整棵子树声明名"的全局减法不可行：
  // 一个名字可以是某函数的局部参数（它对该名字的引用解析到参数），同时是
  // 另一函数对 root 声明的真实引用；全局减法会把后者判成局部而漏留，
  // 声明被搬进 mainFn 后，root 函数里的引用悬空（运行期 ReferenceError）。
  // 这里逐函数带作用域栈计算自由引用：Identifier 只在其路径上的函数作用域
  // 都不遮蔽它时才算 root 引用。块内 let/const、catch 形参、类名（嵌套块
  // 级）一律不视为遮蔽，方向性错误只会多留 root，不会切断作用域链。
  const FN_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod']);
  const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', '__vmMeta', '__dshScope']);

  // fnNode 自身函数作用域绑定的名字：参数、函数表达式名、var 提升声明、
  // 直接体级函数/类声明、直接体级 let/const（TDZ 使它们对函数体全程生效，
  // 不会落到外层同名声明）。
  function fnOwnBindings(fnNode) {
    const names = new Set();
    for (const p of fnNode.params || []) {
      for (const k in t.getBindingIdentifiers(p)) names.add(k);
    }
    if (fnNode.type === 'FunctionExpression' && fnNode.id) names.add(fnNode.id.name);
    if (!fnNode.body || fnNode.body.type !== 'BlockStatement') return names;
    for (const st of fnNode.body.body) {
      if (!st || typeof st.type !== 'string') continue;
      if (st.type === 'VariableDeclaration') {
        for (const d of st.declarations) for (const k in t.getBindingIdentifiers(d.id)) names.add(k);
      } else if ((st.type === 'FunctionDeclaration' || st.type === 'ClassDeclaration') && st.id) {
        names.add(st.id.name);
      }
    }
    (function hoist(n) {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { for (const c of n) hoist(c); return; }
      if (typeof n.type !== 'string') return;
      if (n.type === 'VariableDeclaration') {
        if (n.kind === 'var') {
          for (const d of n.declarations) for (const k in t.getBindingIdentifiers(d.id)) names.add(k);
        }
      } else if (n.type === 'FunctionDeclaration') {
        if (n.id) names.add(n.id.name);
        return; // 其函数体是独立作用域
      } else if (FN_TYPES.has(n.type)) {
        return;
      }
      for (const k of Object.keys(n)) {
        if (SKIP_KEYS.has(k)) continue;
        hoist(n[k]);
      }
    })(fnNode.body);
    return names;
  }

  // 粗集合：节点内出现的全部 Identifier 名（含属性键位，多留方向，安全）。
  function identNamesOf(node) {
    const s = new Set();
    (function go(n) {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { for (const c of n) go(c); return; }
      if (typeof n.type !== 'string') return;
      if (n.type === 'Identifier') { s.add(n.name); return; }
      if (n.type === 'PrivateName') return;
      for (const k of Object.keys(n)) {
        if (SKIP_KEYS.has(k)) continue;
        go(n[k]);
      }
    })(node);
    return s;
  }

  // rootFn 子树的自由引用名：未被路径上任何函数作用域遮蔽。
  function freeRefsOf(rootFn) {
    const out = new Set();
    const stack = [];
    (function go(n) {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { for (const c of n) go(c); return; }
      if (typeof n.type !== 'string') return;
      if (FN_TYPES.has(n.type)) {
        stack.push(fnOwnBindings(n));
        for (const k of Object.keys(n)) {
          if (SKIP_KEYS.has(k)) continue;
          go(n[k]);
        }
        stack.pop();
        return;
      }
      if (n.type === 'Identifier') {
        for (const s of stack) if (s.has(n.name)) return;
        out.add(n.name);
        return;
      }
      for (const k of Object.keys(n)) {
        if (SKIP_KEYS.has(k)) continue;
        go(n[k]);
      }
    })(rootFn);
    return out;
  }

  const rootUsed = new Set();
  for (const f of fnDecls) for (const nm of freeRefsOf(f)) rootUsed.add(nm);
  // export 语句引用的顶层声明必须留 root（否则绑定断链）；模块声明在
  // root 求值，其提及的全部名字一并计入（粗化 = 多留，安全）。
  for (const s of moduleStmts) for (const nm of identNamesOf(s)) rootUsed.add(nm);

  const varStays = [];
  const clsStays = [];
  for (const d of varDecls) {
    // 声明名含解构 pattern（const {a,b} = require(...) 等），只看
    // Identifier 会把 pattern 声明整体漏判，误搬进 mainFn 切断 root
    // 函数的词法引用（vm 编译函数对模块级解构绑定的引用变悬空）。
    const refs = d.declarations.some((x) => {
      if (!x.id) return false;
      if (x.id.type === 'Identifier') return rootUsed.has(x.id.name);
      for (const k in t.getBindingIdentifiers(x.id)) if (rootUsed.has(k)) return true;
      return false;
    });
    if (refs) varStays.push(d);
  }
  for (const c of clsDecls) {
    const nm = c.id && c.id.name;
    if (nm && rootUsed.has(nm)) clsStays.push(c);
  }
  const stays = new Set([...varStays, ...clsStays]);

  const stayNames = new Set();
  const addStayNames = (stmts) => { for (const s of stmts) for (const nm of identNamesOf(s)) stayNames.add(nm); };
  addStayNames(varStays); addStayNames(clsStays); addStayNames(moduleStmts);
  // 内核函数声明不参与粗粒度名闭包：内核体内的循环变量名（j/i/…）会
  // 误把同名用户顶层 var 拉回 root，与进 main 的兄弟语句割裂执行序
  addStayNames(fnDecls.filter((f) => !f.__rtKernel));
  let grew = true;
  const allVarByName = new Map();
  for (const d of varDecls) {
    for (const x of d.declarations) {
      if (!x.id) continue;
      for (const k in t.getBindingIdentifiers(x.id)) if (!allVarByName.has(k)) allVarByName.set(k, d);
    }
  }
  const allClsByName = new Map();
  for (const c of clsDecls) if (c.id) allClsByName.set(c.id.name, c);
  const isModuleDecl = (s) => s.type === 'ImportDeclaration' || s.type === 'ExportNamedDeclaration' ||
    s.type === 'ExportDefaultDeclaration' || s.type === 'ExportAllDeclaration';

  // stay 中 var/class 声明绑定的名字（root 求值语句）。搬入 mainFn 的语句
  // 若在原顺序里更早地写入这些名字，root 侧的快照读取（{...X} spread、
  // 解构拷贝等）会因门禁把写入推迟而永远丢值；这类写入语句必须提升回 root。
  function rootBoundNames() {
    const set = new Set();
    for (const s of stays) {
      if (s.type === 'VariableDeclaration') {
        for (const d of s.declarations) { if (d.id) for (const k in t.getBindingIdentifiers(d.id)) set.add(k); }
      } else if (s.type === 'ClassDeclaration' && s.id) set.add(s.id.name);
    }
    return set;
  }
  const writeCache = new Map();
  // 语句内赋值/更新/forX 左值的写入基名（a.b[x]=v → a；for (x of y) → x）
  function writeTargetBases(stmt) {
    let v = writeCache.get(stmt);
    if (v) return v;
    v = new Set();
    const baseOf = (l) => {
      while (l && (l.type === 'MemberExpression' || l.type === 'OptionalMemberExpression')) l = l.object;
      if (l && l.type === 'Identifier') v.add(l.name);
    };
    (function go(m) {
      if (!m || typeof m !== 'object') return;
      if (Array.isArray(m)) { for (const c of m) go(c); return; }
      if (typeof m.type !== 'string') return;
      if (m.type === 'AssignmentExpression') baseOf(m.left);
      else if (m.type === 'UpdateExpression') baseOf(m.argument);
      else if (m.type === 'ForInStatement' || m.type === 'ForOfStatement') {
        const l = m.left;
        if (l && l.type === 'VariableDeclaration') {
          for (const d of l.declarations) { if (d.id) for (const k in t.getBindingIdentifiers(d.id)) v.add(k); }
        } else baseOf(l);
      }
      for (const k of Object.keys(m)) { if (SKIP_KEYS.has(k)) continue; go(m[k]); }
    })(stmt);
    writeCache.set(stmt, v);
    return v;
  }

  while (grew) {
    grew = false;
    // 1) 名字闭包：stay 语句提及的顶层 var/class 声明留 root
    for (const nm of stayNames) {
      const vd = allVarByName.get(nm);
      if (vd && !stays.has(vd)) { stays.add(vd); addStayNames([vd]); grew = true; }
      const cd = allClsByName.get(nm);
      if (cd && !stays.has(cd)) { stays.add(cd); addStayNames([cd]); grew = true; }
    }
    // 2) 写入提升：搬运语句写 root 绑定名 → 提升回 root，引用名一并闭包
    const rb = rootBoundNames();
    for (const s of rootBody) {
      if (stays.has(s) || s.type === 'FunctionDeclaration' || s.type === 'Directive' || isModuleDecl(s)) continue;
      for (const nm of writeTargetBases(s)) {
        if (rb.has(nm)) { stays.add(s); addStayNames([s]); grew = true; break; }
      }
    }
  }

  // 待搬语句按原相对顺序进 main（类/其 new 表达式等死代码对
  // 顺序敏感；按类别分组会打乱 TDZ 语义）。
  // 模块声明（import/export）永远不搬，只能在模块顶层。
  const movedStmts = [];
  for (const s of rootBody) {
    if (s.type === 'Directive' || s.type === 'FunctionDeclaration') continue;
    if (stays.has(s)) continue;
    if (s.type === 'ImportDeclaration' || s.type === 'ExportNamedDeclaration' ||
        s.type === 'ExportDefaultDeclaration' || s.type === 'ExportAllDeclaration') continue;
    movedStmts.push(s);
  }

  // root 新布局：mem/ready 注入 var 最先，同步路径下 init 立即完成，
  // root 求值语句（含写入提升来的）调用 vm 编译函数时 MEM/BK/CN 已就绪
  // （var 提升只给 undefined，靠求值顺序保证）；stay 语句保持原相对顺序，
  // export default 初始值对其后 let/const 有 TDZ 依赖；函数声明提升，位置无关。
  const rootStays = [];
  for (const s of rootBody) {
    if (s.type === 'Directive') continue;
    if (s.type === 'FunctionDeclaration') continue;
    if (stays.has(s)) rootStays.push(s);
    else if (s.type === 'ImportDeclaration' || s.type === 'ExportNamedDeclaration' ||
        s.type === 'ExportDefaultDeclaration' || s.type === 'ExportAllDeclaration') rootStays.push(s);
  }

  if (!movedStmts.length) {
    rootBody.length = 0;
    rootBody.push(...directives, memDecl, bkDecl, cnDecl, crDecl, nxDecl, spcDecl, readyDecl, ...rootStays, ...fnDecls);
  } else {
    const mainName = uniqueName(ctx.usedNames, '_0x');
    const mainFn = t.functionDeclaration(t.identifier(mainName), [],
      t.blockStatement(movedStmts));
    const gate = t.expressionStatement(t.callExpression(
      t.memberExpression(t.identifier(READY), t.identifier('then'), false),
      [t.functionExpression(null, [], t.blockStatement([
        t.expressionStatement(t.callExpression(t.identifier(mainName), [])),
      ]))]));
    rootBody.length = 0;
    rootBody.push(...directives, memDecl, bkDecl, cnDecl, crDecl, nxDecl, spcDecl, readyDecl, ...rootStays,
      ...fnDecls, mainFn, gate);
  }

  return {
    moved, candidates: cands.length, moduleBytes: wasm.mod.length,
    readyName: READY, memName: MEM, bkName: BK, cnName: CN, crName: CR,
    nxName: NX, spcName: SPC,
    bkMoved, cnMoved, crMoved,
  };
};
