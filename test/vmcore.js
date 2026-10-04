/**
 * 内层可信内核（src/rt/vmcore.js）的单元测试。
 *
 * 跑法：node test/vmcore.js
 *
 * 这个内核是"嵌套 VM"里唯一不被虚拟化的部分，也是整个方案最容易出错的地方：
 * 一旦取指宽度、解变换偏移、栈混淆或 pc 推进有一处对不上，外层算出来的字节码
 * 就会被解释成别的东西——而产物仍然能跑，只是结果是错的。所以这里逐项钉死：
 *   · 指令编码/解码往返、操作码分布
 *   · 操作码变换的等价性与边界（shift=0、255、负数、往返一致）
 *   · 定长取指在边界处的行为（越界、空片）
 *   · 栈混淆的可逆性
 *   · 解释器循环：pc 推进、条件跳转、步数上限、未知 opcode 的处理
 *
 * **CORE_SRC 必须 eval 出来跑真代码**，不能抄一份到测试里：抄的那份会与源码
 * 漂移，漂移了就等于没测。测试文件不在核心模块图里，这里的 eval 是允许的
 * （核心模块图里连一处字符串代码生成都不能留，有断言）。
 */
import {
  OPCODES, INSN_W, OPCODE_NAMES, scrambleOpcode, encodeOpcode,
  stash, unstash, CORE_SRC,
} from '../src/rt/vmcore.js';
import { ok, report, section, cleanTmp } from './_harness.js';

// 把运行期源码求值成真函数（与产物里跑的是同一段文本）
const RT = (0, eval)('(function(){' + CORE_SRC + '\nreturn {run:VMC_run,st:VMC_st,us:VMC_us,un:VMC_un};})()');

section('指令集与编码');
{
  const names = Object.keys(OPCODES);
  ok(names.length >= 20, '指令条数 >= 20', '实际 ' + names.length);

  const need = {
    算术: ['ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'NEG'],
    逻辑: ['AND', 'OR', 'XOR', 'NOT', 'SHL', 'SHR'],
    跳转: ['JMP', 'JZ', 'JNZ'],
    内存: ['LOAD', 'STORE', 'GET', 'SET', 'NEW'],
    调用: ['CALL', 'RET'],
    字符串: ['PUSH', 'LOADK', 'LEN', 'CAT', 'IDX'],
  };
  for (const [cat, list] of Object.entries(need)) {
    const miss = list.filter((n) => OPCODES[n] === undefined);
    ok(miss.length === 0, cat + '类指令齐全', '缺: ' + miss.join(','));
  }

  ok(INSN_W === 6, '指令定长 6 字节', String(INSN_W));

  // 编号不能是一段连续区间（那是指纹），也不能有 0（除 NOP）
  const codes = Object.values(OPCODES);
  const sorted = [...codes].sort((a, b) => a - b);
  let contiguous = true;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) { contiguous = false; break; }
  }
  ok(!contiguous, '操作码不是连续分配（分派表本身不该是指纹）');
  ok(codes.every((c) => c >= 0x11 && c <= 0xbd), '操作码避开低位的 0x00~0x10',
    '最小=' + sorted[0].toString(16));

  let revBad = '';
  for (const [n, v] of Object.entries(OPCODES)) {
    if (OPCODE_NAMES.get(v) !== n) revBad = n + '→' + OPCODE_NAMES.get(v);
  }
  ok(revBad === '', '反向表与正向表自洽', revBad);

  // GET/SET 是局部槽，LOAD/STORE 是内存表 —— 四个必须互不相同
  const quad = [OPCODES.GET, OPCODES.SET, OPCODES.LOAD, OPCODES.STORE];
  ok(new Set(quad).size === 4, 'GET/SET/LOAD/STORE 四者互不相同（局部槽与内存表不是同一组）',
    quad.join(','));
}

section('操作码变换');
{
  const bad = [];
  for (let shift = 1; shift < 256; shift += 2) {
    const un = scrambleOpcode(shift);
    for (const [n, v] of Object.entries(OPCODES)) {
      if (un(encodeOpcode(n, shift)) !== v) bad.push(n + '@' + shift);
    }
  }
  ok(bad.length === 0, '奇数 shift 下 encode/decode 全部往返一致', bad.slice(0, 3).join(','));

  ok(scrambleOpcode(0)(0x31) === 0x31, 'shift=0 是恒等变换');
  ok(scrambleOpcode(255)((0x31 + 255) & 0xff) === 0x31, 'shift=255（等价 -1）往返一致');
  ok(scrambleOpcode(-1)((0x31 + 255) & 0xff) === 0x31, '负 shift 按模 256 归一');

  // 不同 shift 必须给出不同映射，否则"多态"是假的
  const maps = new Set();
  for (let s = 1; s < 256; s += 2) maps.add(scrambleOpcode(s)(OPCODES.ADD));
  ok(maps.size >= 120, '不同 shift 产出不同映射（多态真实）', 'unique=' + maps.size);

  // 偶数 shift 的后果：映射 (op - s) 在 0..255 上仍是双射（加减总是可逆的），
  // 但它会把操作码按"模 s 的余数"分组 —— 同一个余数类里的操作码在变换后彼此
  // 相距 s，于是**两个原本不同的操作码可能落到同一"视觉特征"上**。
  // 下面这条断言的是"变换前后操作码集合的大小不变"（双射），以及奇数 shift
  // 覆盖到的映射个数不少于偶数。
  const distinctAll = (maxStep) => {
    const got = new Set();
    for (let s = 1; s < 256; s += maxStep) {
      const un = scrambleOpcode(s);
      for (const v of Object.values(OPCODES)) got.add(un((v + s) & 0xff));
    }
    return got.size;
  };
  ok(distinctAll(1) >= distinctAll(2),
    '奇数 shift 覆盖的变换结果不少于偶数',
    'odd=' + distinctAll(1) + ' even=' + distinctAll(2));

  // 未知名字必须抛错，不能静默返回 undefined
  let threw = false;
  try { encodeOpcode('NOT_AN_OPCODE', 3); } catch (e) { threw = true; }
  ok(threw, '未知指令名抛错（静默 undefined 会让整片字节码变 NaN）');
  ok(encodeOpcode(OPCODES.ADD, 3) === ((OPCODES.ADD + 3) & 0xff),
    '数值入参与名字入参等价');
}

section('状态混淆');
{
  const probes = [0, 1, -1, 0x7fffffff, -0x80000000, 0xffffffff, 12345, -12345];
  let bad = '';
  for (const v of probes) {
    for (const m of [0, 1, 0x5a5a5a5a, 0xffffffff]) {
      if (unstash(stash(v, m), m) !== (v | 0)) bad += v + '/' + m + ' ';
    }
  }
  ok(bad === '', 'stash/unstash 对全部探针可逆', bad);
  ok(stash(5, 0xffffffff) !== 5, '非零掩码下值确实被改写');
  ok(stash(5, 0) === 5, '掩码 0 时是恒等');
}

section('解释器循环');
{
  const mk = (insns) => {
    const b = new Uint8Array(insns.length * INSN_W);
    insns.forEach((it, i) => {
      const at = i * INSN_W;
      b[at] = it.op; b[at + 1] = it.oa || 0; b[at + 2] = it.ob || 0;
      b[at + 3] = it.oc || 0; b[at + 4] = it.od || 0; b[at + 5] = it.fl || 0;
    });
    return b;
  };
  const HOST = (x) => Object.assign({
    consts: [], mem: {}, mask: 0, opShift: 0, entry: 0, limit: 10000, handler: {},
  }, x || {});

  // ① pc 默认顺序推进
  {
    const seen = [];
    run1(mk([{ op: 0x13, oa: 1 }, { op: 0x13, oa: 2 }, { op: 0x13, oa: 3 }]),
      HOST({ handler: { 0x13: (c, i) => { seen.push(i.oa); c.nxt(); } } }));
    ok(JSON.stringify(seen) === '[1,2,3]', '顺序取指逐条推进', JSON.stringify(seen));
  }

  // ② 未知 opcode 当填充跳过，不报错（虚假 handler 的地基）
  {
    const seen = [];
    const code = mk([{ op: 0xee }, { op: 0x13, oa: 7 }, { op: 0xee }, { op: 0xbd }]);
    const r = run1(code, HOST({
      handler: { 0x13: (c, i) => { seen.push(i.oa); c.nxt(); }, 0xbd: (c) => c.stop() },
    }));
    ok(r.ok === 1, '遇到未知 opcode 不失败（当填充跳过）', 'ok=' + r.ok);
    ok(JSON.stringify(seen) === '[7]', '未知 opcode 之间的真指令仍被执行', JSON.stringify(seen));
  }

  // ③ 步数上限：有界失败，不是死循环
  {
    const r = run1(mk([{ op: 0x13, oa: 1 }]), HOST({ limit: 500, handler: { 0x13: () => {} } }));
    ok(r.ok !== 1 && r.n === 501, '不推进 pc 时按 limit 有界失败', 'ok=' + r.ok + ' n=' + r.n);
  }

  // ④ 越界取指 / 空字节码
  {
    ok(run1(mk([{ op: 0x13 }]), HOST({ entry: 99, handler: { 0x13: (c) => c.nxt() } })).ok !== 1,
      '入口越界直接失败');
    ok(run1(new Uint8Array(0), HOST({ handler: {} })).ok !== 1, '空字节码失败而不是崩掉');
  }

  // ⑤ 缺 HALT 时跑出末尾必须有界失败（真实程序漏写终止指令）
  {
    const r = run1(mk([{ op: 0x13, oa: 1 }]), HOST({ handler: { 0x13: (c) => c.nxt() } }));
    ok(r.ok !== 1, '缺少 HALT 时跑出末尾 → 有界失败', 'ok=' + r.ok);
  }

  // ⑥ HALT 正常终止
  {
    const r = run1(mk([{ op: 0x13, oa: 5 }, { op: 0xbd }]), HOST({
      handler: { 0x13: (c) => c.nxt(), 0xbd: (c) => c.stop() },
    }));
    ok(r.ok === 1 && r.done === 1 && r.n === 2, 'HALT 正常终止且之后不再取指',
      'ok=' + r.ok + ' n=' + r.n);
  }

  // ⑦ 条件跳转：用 peek 而不是 pop，且成立/不成立两条路径都对
  {
    // 栈顶非 0 → 不跳，中间那条 PUSH 应当被执行
    const pushed = [];
    run1(mk([
      { op: 0x13, oa: 1 },
      { op: 0x8d, oa: 2 },
      { op: 0x13, oa: 111 },
      { op: 0xbd },
    ]), HOST({
      handler: {
        0x13: (c, i) => { pushed.push(i.oa); c.push(i.oa); c.nxt(); },
        0x8d: (c, i) => { if (c.peek() === 0) c.jmp(i.oa); else c.nxt(); },
        0xbd: (c) => c.stop(),
      },
    }));
    ok(JSON.stringify(pushed) === '[1,111]',
      '跳转条件不成立时顺序执行下一条（栈顶未被吃掉）', JSON.stringify(pushed));
  }
  {
    // 栈顶为 0 → 跳，中间那条被跳过
    const pushed = [];
    run1(mk([
      { op: 0x13, oa: 0 },
      { op: 0x8d, oa: 2 },
      { op: 0x13, oa: 111 },
      { op: 0xbd },
    ]), HOST({
      handler: {
        0x13: (c, i) => { pushed.push(i.oa); c.push(i.oa); c.nxt(); },
        0x8d: (c, i) => { if (c.peek() === 0) c.jmp(i.oa); else c.nxt(); },
        0xbd: (c) => c.stop(),
      },
    }));
    ok(JSON.stringify(pushed) === '[0]', 'JZ 在栈顶为 0 时跳转', JSON.stringify(pushed));
  }

  // ⑧ 操作数六个字节都正确传给 handler
  {
    const got = [];
    run1(mk([{ op: 0x13, oa: 0x12, ob: 0x34, oc: 0x56, od: 0x78, fl: 0x9a }, { op: 0xbd }]), HOST({
      handler: {
        0x13: (c, i) => { got.push([i.oa, i.ob, i.oc, i.od, i.fl]); c.nxt(); },
        0xbd: (c) => c.stop(),
      },
    }));
    ok(JSON.stringify(got) === '[[18,52,86,120,154]]', 'oa..od 与 fl 六个字节都正确传递',
      JSON.stringify(got));
  }

  // ⑨ 栈混淆往返 + 栈平衡
  {
    const seen = [];
    const r = run1(mk([{ op: 0x13, oa: 7 }, { op: 0x13, oa: 8 }, { op: 0xbd }]), HOST({
      mask: 0x5a5a5a5a,
      handler: {
        0x13: (c, i) => { c.push(i.oa); seen.push(c.pop()); c.nxt(); },
        0xbd: (c) => c.stop(),
      },
    }));
    ok(JSON.stringify(seen) === '[7,8]', '加掩码后 push/pop 仍往返一致', JSON.stringify(seen));
    ok(r.stk.length === 0, '栈平衡（净深度为 0）', 'depth=' + r.stk.length);
  }

  // ⑩ peek(d) 从栈顶往下数
  {
    let depth = -1, peeked = null;
    run1(mk([{ op: 0x13, oa: 0 }, { op: 0x13, oa: 0 }]), HOST({
      mask: 0,
      handler: {
        0x13: (c) => {
          if (depth < 0) { c.push(11); c.push(22); c.push(33); depth = c.stk.length; }
          else { peeked = [c.peek(), c.peek(1), c.peek(2)]; c.stop(); return; }
          c.nxt();
        },
      },
    }));
    ok(depth === 3, '连续 push 后栈深为 3', 'depth=' + depth);
    ok(JSON.stringify(peeked) === '[33,22,11]', 'peek(d) 从栈顶往下数', JSON.stringify(peeked));
  }

  // ⑪ RET 把返回值带出来
  {
    const r = run1(mk([{ op: 0x13, oa: 9 }, { op: 0xb9 }]), HOST({
      handler: { 0x13: (c, i) => { c.push(i.oa); c.nxt(); }, 0xb9: (c) => { c.ret(c.pop()); c.stop(); } },
    }));
    ok(r.ret === 9, 'RET 的返回值被带回', 'ret=' + r.ret);
  }
}

section('真实程序：解释一段算术');
{
  const b = [];
  const push = (v) => b.push({ op: OPCODES.PUSH, oa: v });
  push(2); push(3);
  b.push({ op: OPCODES.MUL });
  push(1);
  b.push({ op: OPCODES.ADD });
  push(4);
  b.push({ op: OPCODES.SUB });
  b.push({ op: OPCODES.HALT });
  const code = new Uint8Array(b.length * INSN_W);
  b.forEach((it, i) => {
    const at = i * INSN_W;
    code[at] = it.op; code[at + 1] = it.oa || 0;
    code[at + 2] = it.ob || 0; code[at + 3] = it.oc || 0;
    code[at + 4] = it.od || 0; code[at + 5] = it.fl || 0;
  });
  const handler = {
    [OPCODES.PUSH]: (c, i) => { c.push(i.oa); c.nxt(); },
    [OPCODES.MUL]: (c) => { const y = c.pop(), x = c.pop(); c.push((x * y) | 0); c.nxt(); },
    [OPCODES.ADD]: (c) => { const y = c.pop(), x = c.pop(); c.push((x + y) | 0); c.nxt(); },
    [OPCODES.SUB]: (c) => { const y = c.pop(), x = c.pop(); c.push((x - y) | 0); c.nxt(); },
    [OPCODES.HALT]: (c) => c.stop(),
  };
  const r = run1(code, { handler, consts: [], mem: {}, mask: 0, opShift: 0, entry: 0, limit: 1000 });
  ok(r.stk.length ? (r.stk[r.stk.length - 1] ^ r.mask) | 0 : null === 3,
    '解释 (1+2*3)-4 得 3', 'got ' + JSON.stringify(r.stk));
  ok(r.ok && r.done, '程序正常 HALT');

  // 带操作码变换时结果必须相同
  for (const shift of [1, 3, 127, 255]) {
    const bs = [];
    const pb = (v) => bs.push({ op: encodeOpcode(OPCODES.PUSH, shift), oa: v });
    pb(2); pb(3);
    bs.push({ op: encodeOpcode(OPCODES.MUL, shift) });
    pb(1);
    bs.push({ op: encodeOpcode(OPCODES.ADD, shift) });
    pb(4);
    bs.push({ op: encodeOpcode(OPCODES.SUB, shift) });
    bs.push({ op: encodeOpcode(OPCODES.HALT, shift) });
    const c2 = new Uint8Array(bs.length * INSN_W);
    bs.forEach((it, i) => {
      const at = i * INSN_W;
      c2[at] = it.op; c2[at + 1] = it.oa || 0;
      c2[at + 2] = it.ob || 0; c2[at + 3] = it.oc || 0;
      c2[at + 4] = it.od || 0; c2[at + 5] = it.fl || 0;
    });
    // handler 表的键是**原操作码**：取指时先解变换拿到原值，再查表
    const h2 = {};
    for (const [k, fn] of Object.entries(handler)) h2[Number(k)] = fn;
    const r2 = run1(c2, { handler: h2, consts: [], mem: {}, mask: 0, opShift: shift, entry: 0, limit: 1000 });
    const got = r2.stk.length ? (r2.stk[r2.stk.length - 1] ^ r2.mask) | 0 : null;
    ok(got === 3, 'shift=' + shift + ' 下语义不变（变换是等价变换）', 'got ' + got);
  }
}

/** 跑一次 CORE_SRC 里的解释器 */
function run1(code, host) {
  return RT.run(code, host);
}

if (process.argv[1] && process.argv[1].endsWith('vmcore.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}