#!/usr/bin/env node
/**
 * 外壳解码链 IR 的三路对拍：手写参考实现 ⟷ emitJs ⟷ emitVm。
 *
 *   node test/shell-bytecode.js
 *
 * ## 为什么是三路而不是两路
 *
 * 基准必须是**独立手写**的一份，不能是 emitJs 自己。两路对拍只能证明"两个发射器
 * 一致"，而它们完全可能一致地错——IR 里写错一个符号，两边一起错，对拍照样全绿。
 * 所以这里第三路是从 shell.js 那几条语句**逐句转写**下来的参考实现（decStyle 0 内联
 * base64 那一支），它与 IR 之间没有任何共享代码：IR 错，两路对拍会挂；参考实现错，
 * 同样会挂。三个来源同时对上，"逐位一致"才有意义。
 *
 * ## 这组用例要盯住的具体坑
 *
 * 上一版手写字节码栽过的四个坑，在这里各自有对应断言或由三路对拍天然覆盖：
 *   - 二元运算左右操作数顺序（加法乘法对称，减法与移位才暴露）
 *   - `>>>` 的 int32 截断口径（`(1 << pc) - 1` 在 pc≥31 时会变负）
 *   - 坏字符的 `continue` 必须仍然执行内层循环的自增
 *   - 投毒分支里 `(x || 1)`：x 为 0 时取 1，否则取 x
 */

import { cleanTmp, counters, ok, report, runNode, section } from './_harness.js';
import { buildDecodeChain } from '../src/passes/shellir.js';
import {
  CONSTS, OPCODES, assignSlots, emitInterpreter, emitJs, emitVm,
  encryptWords, shuffleOpCodes,
} from '../src/passes/shellemit.js';
import { PRIMITIVES_TEXT } from '../src/passes/shell.js';
import obfuscateMod from '../src/obfuscate.js';

const { obfuscate } = obfuscateMod;

// 引导器真正下发的那组原语（不是重写一份，那才是真对拍）
const rt = (0, eval)(PRIMITIVES_TEXT + ';({mul32:mul32,xs32:xs32,ipos:ipos,mix:mix})');
const { mul32, xs32, ipos, mix } = rt;

const INPUTS = ['N', 'L', 'SG', 'P1', 'P2', 'HB', 'E', 'G', 'D', 'M2', 'SB', 'P_EVAL', 'P_FN'];
// 原语参数名，顺序 = 函数表下标：xs32 mix ipos mul32 cc eval Function
const PRIM_NAMES = ['_0xs', '_0mx', '_0ip', '_0ml', '_0cc', '_0ev', '_0fn'];

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const mkM2 = () => { const m = new Array(128).fill(-1); for (let i = 0; i < 64; i++) m[B64.charCodeAt(i)] = i; return m; };
const mkSB = () => { const a = []; for (let i = 0; i < 256; i++) a[i] = i; return a; };
const mkD = (n) => { const a = []; for (let i = 0; i < n; i++) a[i] = i; return a; };

/**
 * 明文字节 → base64 → **恰好** nseg 段。
 *
 * 段数必须与 D 的长度一致：D 是段下标的置换表，长度对不上就是取到 undefined，
 * 症状是参考实现先崩、看起来像 IR 写错了，实际是测试夹具的问题。
 * D 用一个固定置换（而不是恒等），这样「乱序落位」这条路径真的被走到。
 */
function mkSegments(bytes, nseg) {
  const b64 = Buffer.from(bytes).toString('base64');
  const per = Math.ceil(b64.length / nseg);
  const out = [];
  for (let i = 0; i < b64.length; i += per) out.push(b64.slice(i, i + per));
  while (out.length < nseg) out.push('');
  return out;
}

/** 长度与段数相同的置换表（固定错位，保证不是恒等）。 */
function mkPerm(n) {
  const a = []; for (let i = 0; i < n; i++) a[i] = (i * 3 + 1) % n;
  // n 与 3 互质时上式是置换；否则退回恒等，避免出现重复下标这种非法输入
  const s = new Set(a);
  if (s.size !== n) { for (let i = 0; i < n; i++) a[i] = i; }
  return a;
}

/** 可复现的伪随机（LCG），逐用例换种子。 */
function makeRng(seed) {
  let s = seed >>> 0;
  return (lo, hi) => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return lo + (s % (hi - lo + 1)); };
}

// ---------------------------------------------------------------- 参考实现
//
// 从 shell.js 的解码链逐句转写（decStyle 0 内联 base64 那一支，见 shell.js
// 「var _0r=new _0U8(_0N) … _0bd=(_0bd^mul32(…」那几段）。与 IR 无任何共享代码。

function reference(c) {
  const { G: segs, N, L, SG, P1, P2, HB, E, D, M2, SB,
    tailOrder, junkMult, posHash, badCount, probeFunction } = c;
  const r = new Uint8Array(N);
  const q = new Uint8Array(N);
  let n = 0, acc = 0, pc = 0, bd2 = badCount;

  for (let j2 = 0; j2 < SG; j2++) {
    const sg = segs[D[j2]];
    for (let q2 = 0; q2 < sg.length; q2++) {
      const c6 = M2[sg.charCodeAt(q2)];
      if (c6 < 0) { bd2++; continue; }
      acc = acc * 64 + c6;
      pc = pc + 6;
      if (pc > 7) {
        pc = pc - 8;
        r[n] = (acc >>> pc) & 255;
        n++;
        acc = acc & ((1 << pc) - 1);
      }
    }
  }

  let u = E >>> 0, pv = 0, h = HB >>> 0;
  for (let t2 = 0; t2 < N; t2++) {
    u = xs32(u);
    u = (u + pv + t2) >>> 0;
    const kb = (u ^ (u >>> 15) ^ (u >>> 22)) & 255;
    const v = (SB[r[ipos(t2, P1, P2, N)]] ^ kb) & 255;
    q[t2] = v;
    pv = v;
    if (t2 < L) h = mix(h, v, t2, posHash);
  }
  const tail = tailOrder === 0
    ? (((q[L] << 24) | (q[L + 1] << 16) | (q[L + 2] << 8) | q[L + 3]) >>> 0)
    : (((q[L + 3] << 24) | (q[L + 2] << 16) | (q[L + 1] << 8) | q[L]) >>> 0);
  let bd = (h ^ E ^ tail) >>> 0;

  bd = (bd ^ mul32(bd2, junkMult)) >>> 0;
  if (bd2 > 0 && bd === 0) bd = 1;
  if (('' + eval).indexOf('native') < 0) bd = (bd ^ (mul32(E ^ L, junkMult) || 1)) >>> 0;
  if (probeFunction && ('' + Function).indexOf('native') < 0) {
    bd = (bd ^ (mul32(E ^ N, junkMult) || 1)) >>> 0;
  }
  if (bd !== 0) {
    let u2 = xs32(E ^ bd);
    const lim = L < 8 ? L : 8;
    for (let i = 0; i < lim; i++) {
      u2 = xs32(u2 ^ bd ^ i);
      q[i] = (q[i] ^ (u2 >>> 11)) & 255;
    }
  }
  return q;
}

// ---------------------------------------------------------------- 两种发射的跑法

function runJs(c) {
  const ir = buildDecodeChain(c);
  const src = emitJs(ir, { inputs: INPUTS, prims: PRIM_NAMES, output: 'q' });
  const f = (0, eval)(src);
  return { q: f(xs32, mix, ipos, mul32, (s, i) => s.charCodeAt(i),
    (0, eval), Function, c.N, c.L, c.SG, c.P1, c.P2, c.HB, c.E, c.G, c.D, c.M2, c.SB,
    (0, eval), Function), src };
}

function runVm(c, seed) {
  const ri = makeRng(seed);
  const ir = buildDecodeChain(c);
  const opmap = shuffleOpCodes(ri);
  const vm = emitVm(ir, { inputs: INPUTS, output: 'q', opmap });
  const enc = encryptWords(vm.words, ri);
  const src = emitInterpreter({ opmap, key: enc.key, k2: enc.k2, outSlot: vm.outSlot });
  const f = (0, eval)(src);
  const T = new Array(vm.slotCount).fill(0);
  const vals = { N: c.N, L: c.L, SG: c.SG, P1: c.P1, P2: c.P2, HB: c.HB, E: c.E,
    G: c.G, D: c.D, M2: c.M2, SB: c.SB, P_EVAL: (0, eval), P_FN: Function };
  for (const k of INPUTS) T[vm.slots[k]] = vals[k];
  const tbl = [xs32, mix, ipos, mul32, (s, i) => s.charCodeAt(i), (0, eval), Function];
  const q = f(enc.data.slice(), tbl, CONSTS, T);
  return { q, words: vm.words, opmap, src, outSlot: vm.outSlot, slots: vm.slots };
}

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const firstDiff = (a, b) => a.findIndex((v, i) => v !== b[i]);

// ---------------------------------------------------------------- 用例

function makeCase(o) {
  const N = o.N, L = N - 4;
  const SG = o.SG;
  const raw = new Uint8Array(N);
  for (let i = 0; i < N; i++) raw[i] = (i * 37 + (o.seed || 0)) & 255;
  const c = {
    N, L, SG, P1: 7919, P2: 104729, HB: 0x12345678, E: 0x9e3779b9,
    M2: mkM2(), SB: mkSB(), D: mkPerm(SG),
    G: mkSegments(raw, SG),
    tailOrder: o.tailOrder, junkMult: o.junkMult, posHash: o.posHash,
    badCount: o.badCount || 0, probeFunction: !!o.probeFunction, seed: o.seed || 0,
  };
  // 往段里掺坏字符：坏字符让 bd2 变化，走的是投毒判定那条分支，必须覆盖到
  if (o.dirty) c.G[c.G.length - 1] += '!';
  return c;
}

section('三路对拍：手写参考 ⟷ emitJs ⟷ emitVm');
{
  const cases = [
    ['大端尾 / ph=0 / 无坏字符', { N: 300, SG: 5, tailOrder: 0, posHash: 0, junkMult: 0x45d9f3b, seed: 3 }],
    ['小端尾 / ph=1 / 无坏字符', { N: 257, SG: 3, tailOrder: 1, posHash: 1, junkMult: 0x1a2b3c4d, seed: 5 }],
    ['大端尾 / ph=1 / 3 个坏字符', { N: 128, SG: 2, tailOrder: 0, posHash: 1, junkMult: 0x45d9f3b, seed: 7, dirty: true }],
    ['小端尾 / ph=0 / 坏字符 + Function 探针', {
      N: 64, SG: 1, tailOrder: 1, posHash: 0, junkMult: 0x0f1e2d3c, seed: 11,
      dirty: true, probeFunction: true,
    }],
    // L 很小 → 投毒循环只走 8 字节；L 也可能 < 8，走 lim = L 分支
    ['L<8（投毒循环取 lim=L）', { N: 12, SG: 1, tailOrder: 0, posHash: 1, junkMult: 0x5bf03635, seed: 13 }],
    ['单段单字节边界', { N: 5, SG: 1, tailOrder: 0, posHash: 0, junkMult: 0x45d9f3b, seed: 17 }],
    ['大 N / 多段', { N: 2048, SG: 17, tailOrder: 1, posHash: 1, junkMult: 0x2545f491, seed: 19 }],
  ];
  for (const [label, o] of cases) {
    const c = makeCase(o);
    const want = reference(c);
    const gotJs = runJs(c).q;
    const gotVm = runVm(c, o.seed).q;
    const jsOk = sameBytes(want, gotJs);
    const vmOk = jsOk && sameBytes(gotJs, gotVm);
    ok(vmOk, '三路逐位一致：' + label,
      !jsOk ? 'emitJs 与参考不符，首差 @' + firstDiff(want, gotJs)
        : 'emitVm 与 emitJs 不符，首差 @' + firstDiff(gotJs, gotVm));
  }
}

section('发射器自身的性质');
{
  const c = makeCase({ N: 200, SG: 3, tailOrder: 0, posHash: 1, junkMult: 0x45d9f3b, seed: 29 });

  // 槽位分配：两个发射器必须对同一个 IR 变量给出同一个下标，否则「逐位一致」无从谈起
  const ir = buildDecodeChain(c);
  const a1 = assignSlots(ir, INPUTS);
  const a2 = assignSlots(ir, INPUTS);
  ok(JSON.stringify(a1.slot) === JSON.stringify(a2.slot), '槽位分配可复现（同一 IR 两次一致）');
  ok(a1.size >= INPUTS.length, '槽位数覆盖全部输入变量', a1.size + ' vs ' + INPUTS.length);
  ok(a1.list.indexOf('q') >= 0, '输出变量 q 拿到槽位');

  // emitJs 是朴素基准：不应带任何形态多态的痕迹
  const js = runJs(c).src;
  ok(!/while\s*\(/.test(js), 'emitJs 输出不含 while（基准刻意朴素，不掺形态多态）');
  ok(/\bfor\s*\(/.test(js), 'emitJs 输出用 for 循环');
  ok(!/eval\(|new Function/.test(js.replace(/\(\(0,eval\)/g, '')), 'emitJs 本身不含字符串代码生成');

  // emitVm：外层不得出现**算法级**的名字。
  //
  // `indexOf` 与 `Uint8Array` 不在禁列里：前者是原生探针这一个操作码的实现（"这个
  // 内建函数有没有被换钩子"），后者是建缓冲区的宿主调用——两者都是**单个操作码**，
  // 读完这一行仍然不知道外壳在解什么。禁它们等于逼着实现绕开宿主 API，那只会写出
  // 更难读的代码，不换来任何不可读性。
  const vm = runVm(c, 29);
  ok(vm.words.length > 200, '字节码规模合理', vm.words.length + ' 字');
  const forbidden = ['base64', 'charCodeAt', 'xs32', 'ipos', 'mul32', 'keystream',
    'acc', 'segment', 'shuffle', 'sbox', 'interleave', 'checksum', 'poison'];
  const leaked = forbidden.filter((w) => new RegExp(w, 'i').test(vm.src));
  ok(leaked.length === 0, '解释器源码不出现算法名/原语名（外层读不出语义）', leaked.join(','));
  // 外层的循环必须只有三个，且都是与算法无关的那三个：字节码就地解密、switch 分发、
  // CALL 收集参数。任何按段/按字符展开的解码循环都说明算法从字节码漏回了明文。
  //
  // 不断言"循环数量 <= N"而逐个核对循环头：数量上限在新增一个合法循环时会误报，
  // 而漏掉一个解码循环时又可能刚好还在上限内——这种断言看着在管事，实际两边都放行。
  ok(!/\bwhile\s*\(/.test(vm.src), '解释器里没有 while');
  const heads = (vm.src.match(/\bfor\s*\([^)]*\)/g) || []).map((x) => x.replace(/\s+/g, ''));
  const known = [
    /^for\(var\w+=\d+;\w+<\w+\.length;\w+\+\+\)/,   // 逐字解密
    /^for\(;;\)/,                                     // switch 分发
    /^for\(var\w+=\w+;\w+>0;\w+--\)/,                 // CALL 收集参数
  ];
  const unmatched = heads.filter((h) => !known.some((re) => re.test(h)));
  ok(unmatched.length === 0, '解释器里的循环只有解密/分发/收参三个', unmatched.join(' | '));
  ok(!/\.forEach\(|\.map\(|\.reduce\(/.test(vm.src), '解释器里没有数组高阶遍历');

  // 逐构建随机：操作码表与字节码都该变，否则外壳成了固定指纹
  const v1 = runVm(c, 101), v2 = runVm(c, 102), v3 = runVm(c, 101);
  ok(JSON.stringify(v1.opmap) !== JSON.stringify(v2.opmap), '不同种子得到不同操作码表');
  ok(JSON.stringify(v1.words) !== JSON.stringify(v2.words), '不同种子得到不同字节码');
  ok(JSON.stringify(v1.words) === JSON.stringify(v3.words), '同种子逐字节可复现');
  ok(v1.src !== v2.src, '不同种子的解释器源码形态不同（case 标签随操作码表变）');

  // 加密必须真的挡着：直接执行未解密的字节码不该给出正确答案
  const irX = buildDecodeChain(c);
  const opX = shuffleOpCodes(makeRng(7));
  const words = emitVm(irX, { inputs: INPUTS, output: 'q', opmap: opX }).words;
  const encX = encryptWords(words, makeRng(8));
  ok(JSON.stringify(encX.data) !== JSON.stringify(words), '字节码下发前已加密');
  ok(encX.key >= 1 && encX.key <= 255 && encX.k2 >= 1, 'key/k2 都在合法域内（两者都要返回给解释器）');
}

section('覆盖度：每个操作码都被真的用上');
{
  const c = makeCase({ N: 400, SG: 4, tailOrder: 1, posHash: 1, junkMult: 0x45d9f3b, seed: 31, dirty: true, probeFunction: true });
  const ir = buildDecodeChain(c);
  const opmap = shuffleOpCodes(makeRng(41));
  const vm = emitVm(ir, { inputs: INPUTS, output: 'q', opmap });
  const ARITY = { PUSH: 1, LD: 1, ST: 1, AGET: 0, ASET: 0, LEN: 0, NEWU8: 0, DUP: 0, POP: 0,
    ADD: 0, SUB: 0, MUL: 0, AND: 0, OR: 0, XOR: 0, SHL: 0, SHR: 0, USHR: 0, U32: 0,
    LT: 0, LE: 0, GT: 0, GE: 0, EQ: 0, NE: 0, JMP: 1, JZ: 1, CALL: 2, NCHK: 2, RET: 0 };
  const inv = {}; for (const [k, v] of Object.entries(opmap)) inv[v] = k;
  const used = new Set();
  let pc = 0;
  let bad = null;
  while (pc < vm.words.length) {
    const n = inv[vm.words[pc]];
    if (!n) { bad = '非法操作码 @' + pc; break; }
    used.add(n);
    pc += 1 + ARITY[n];
  }
  ok(!bad, '字节码从头到尾可完整解码（操作数长度自洽）', bad);
  ok(pc === vm.words.length, '解码后正好落在字流末尾', pc + ' vs ' + vm.words.length);
  const unused = OPCODES.filter((n) => !used.has(n));
  // 没用上的操作码留在分发表里只是几字节死重；编号已逐构建随机，不构成固定指纹。
  // 真正的收益是"按用到的子集裁剪分发表"，但那要求先跑一遍才知道用到了哪些，
  // 与"一遍发射"冲突，留作后续。
  ok(unused.length <= 4, '未用操作码保持在少数几个', '未用: ' + unused.join(','));
}

section('坏字符与 continue：自增仍要执行');
{
  // 内层循环里 continue 之后必须仍然 q2++。若 continue 被发成"跳到循环末尾"，
  // q2 不再自增 → 死循环或只解第一个字符，三路对拍会挂。这里显式钉住：
  // 一个全是坏字符的段，bd2 应恰好按字符数增长。
  const N = 40, SG = 1;
  const c = {
    N, L: N - 4, SG, P1: 7919, P2: 104729, HB: 0x12345678, E: 0x9e3779b9,
    M2: mkM2(), SB: mkSB(), D: mkPerm(SG),
    G: ['!!!!!!!!!!'],           // 整段全是坏字符
    tailOrder: 0, junkMult: 0x45d9f3b, posHash: 0, badCount: 0, probeFunction: false,
  };
  const want = reference(c);
  ok(sameBytes(want, runJs(c).q), '全坏字符段：emitJs 与参考一致');
  ok(sameBytes(want, runVm(c, 37).q), '全坏字符段：emitVm 与参考一致');
}

section('端到端：bytecode 形态的产物真能跑');
{
  // 前面所有用例都只在 IR 层打转，证明的是「发射器自洽」。这一节证明的是
  // 「接进 shell.js 之后，产物在宿主里跑得起来、且语义不变」——两件事不能互相替代：
  // 接线时最容易漏的是**变量名映射**（IR 的槽位 ↔ 引导器的 _0xx 变量）与
  // **原语表顺序**（xs32/mix/ipos/mul32/_0cc 与 IR 里 PRIM 下标必须对齐），
  // 这两处错了 IR 层完全看不出来，只在运行期表现为解出乱码或直接抛。
  const SAMPLE = 'function f(a){var r=0;for(var i=0;i<a;i++){if(i%2===0){r+=i*3;}else{r-=1;}}'
    + 'return r;}console.log(String(f(9)));';
  const want = runNode(SAMPLE, 'bc-native.cjs').trim();

  const forms = ['classic', 'jsfuck', 'bytecode'];
  const outs = {};
  for (const form of forms) {
    const r = obfuscate(SAMPLE, { preset: 'high', seed: 7, shell: true, shellForm: form, target: 'node' });
    outs[form] = { code: r.code, stats: r.stats, warnings: r.warnings || [] };
  }
  for (const form of forms) {
    ok(runNode(outs[form].code, 'bc-' + form + '.cjs').trim() === want,
      form + ' 形态产物语义不变', runNode(outs[form].code, 'bc-' + form + '-2.cjs').trim());
  }

  // 形态统计必须逐个点名。把 bytecode 归到 classic 会让「这份产物外层能不能被
  // 顺着读」这个判断失效——那正是选这个形态的人唯一在意的信息。
  const st = (outs.bytecode.stats || []).find((x) => x.pass === 'shell');
  ok(st && st.result.form === 'bytecode', 'stats 报 form=bytecode（没被归到 classic）',
    st && JSON.stringify(st.result));
  ok(st && st.result.jsfuckChars === 0, 'bytecode 形态不挂 jsfuck 预置（两者互斥）',
    st && String(st.result.jsfuckChars));
  ok(!(outs.bytecode.warnings || []).length, 'bytecode 形态无告警',
    (outs.bytecode.warnings || []).join(' | '));

  // 三种形态必须是三份不同的产物——若 bytecode 形态实际上没生效（分支没走到），
  // 产物会与 classic 逐字节相同，那是最危险的失败：看着有保护、其实没有。
  ok(outs.bytecode.code !== outs.classic.code, 'bytecode 形态与 classic 产物不同（形态确实生效了）');
  ok(outs.jsfuck.code !== outs.classic.code, 'jsfuck 形态与 classic 产物不同');

  // 外层不该再有明文解码链。逐字节对拍已经证明字节码算得对；这里补一条
  // 「读不出算法」的正面断言：产物里不应出现 classic 形态那段
  // 「按段取字符、查 base64 表、累加 6 位」的可读骨架。
  //
  // 注意不能直接搜 `_0m2` 之类的名字——banner 的 randomizeNames 会把它们换掉，
  // 搜了也搜不到（这是好事）。所以改为搜**与名字无关的结构痕迹**。
  const classicTrace = (outs.classic.code.match(/new Uint8Array\(/g) || []).length;
  const bcTrace = (outs.bytecode.code.match(/new Uint8Array\(/g) || []).length;
  ok(bcTrace <= classicTrace, 'bytecode 形态不新增明文缓冲区构造',
    classicTrace + ' -> ' + bcTrace);
}

if (process.argv[1] && process.argv[1].endsWith('shell-bytecode.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}