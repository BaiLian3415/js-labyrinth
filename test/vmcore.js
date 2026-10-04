/**
 * 内层可信内核（src/rt/vmcore.js）的单元测试。
 *
 * 跑法：node test/vmcore.js
 *
 * 这个内核是"嵌套 VM"里唯一不被虚拟化的部分，也是整个方案最容易出错的地方：
 * 一旦取指宽度、解变换偏移、栈混淆或 pc 推进有一处对不上，外层算出来的字节码
 * 就会被解释成别的东西——而产物仍然能跑，只是结果是错的。所以这里逐项钉死：
 *   · 指令编码/解码往返
 *   · 操作码变换的等价性与边界（shift=0、shift=255、往返一致）
 *   · 定长取指在边界处的行为（越界、空片）
 *   · 栈混淆的可逆性
 *   · 解释器循环：pc 推进、条件跳转、步数上限、未知 opcode 的处理
 *   · 每条指令语义（用真实字节码跑出预期结果）
 */
import {
  OPCODES, INSN_W, OPCODE_NAMES, scrambleOpcode, encodeOpcode,
  stash, unstash, runBytecode,
} from '../src/rt/vmcore.js';
import { ok, report, section, cleanTmp } from './_harness.js';

section('指令集与编码');
{
  const names = Object.keys(OPCODES);
  ok(names.length >= 20, '指令条数 >= 20', '实际 ' + names.length);

  // 覆盖需求里点名的几类
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

  // 编号不能连续（连续编号本身就是指纹），也不能占用 0x00
  const codes = Object.entries(OPCODES)
    .filter(([n]) => n !== 'NOP').map(([, v]) => v);
  const sorted = [...codes].sort((a, b) => a - b);
  let contiguous = true;
  for (let i = 1; i < sorted.length; i++) {
    // 允许相邻（同一段内），但整表不能是一段连续区间
    if (sorted[i] !== sorted[i - 1] + 1) { contiguous = false; break; }
  }
  ok(codes.indexOf(0) === -1 || OPCODES.NOP === 0,
    '0x00 只留给 NOP（全零字节码不能被当成有效程序）');
  const segs = new Set(codes.map((c) => c >> 4));
  ok(segs.size >= 4, '操作码分散在多个区段（不做 0..N 连续分配）',
    '区段数=' + segs.size);

  // 反向表自洽
  let revBad = '';
  for (const [n, v] of Object.entries(OPCODES)) {
    if (n === 'NOP') continue;
    if (OPCODE_NAMES.get(v) !== n) revBad = n + '→' + OPCODE_NAMES.get(v);
  }
  ok(revBad === '', '反向表与正向表自洽', revBad);

  ok(INSN_W === 6, '指令定长 6 字节', String(INSN_W));
}

section('操作码变换');
{
  // 等价性：decode(encode(x)) 回到 x
  const bad = [];
  for (let shift = 1; shift < 256; shift += 2) {
    const un = scrambleOpcode(shift);
    for (const [n, v] of Object.entries(OPCODES)) {
      if (un(encodeOpcode(n, shift)) !== v) bad.push(n + '@' + shift);
    }
  }
  ok(bad.length === 0, '奇数 shift 下 encode/decode 全部往返一致',
    bad.slice(0, 3).join(','));

  // 边界
  const u0 = scrambleOpcode(0);
  ok(u0(0x22) === 0x22, 'shift=0 是恒等变换');
  const u255 = scrambleOpcode(255);
  ok(u255((0x22 + 255) & 0xff) === 0x22, 'shift=255（等价 -1）往返一致');
  ok(u255(0) === 1, 'shift=255 时 0 不被映到 0（全零片不会撞出有效操作码）');
  const uNeg = scrambleOpcode(-1);
  ok(uNeg((0x22 + 255) & 0xff) === 0x22, '负 shift 按模 256 归一');

  // 不同 shift 必须给出不同映射，否则"多态"是假的
  const maps = new Set();
  for (let s = 1; s < 256; s += 2) {
    const un = scrambleOpcode(s);
    maps.add(OPCODES.ADD + ':' + un(OPCODES.ADD));
  }
  ok(maps.size >= 100, '不同 shift 产出不同映射（多态真实）',
    'unique=' + maps.size);
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
  ok(stash(5, 0xffffffff) !== 5, '非零掩码下值确实被改写（不长期明文躺内存）');
  ok(stash(5, 0) === 5, '掩码 0 时是恒等');
}

section('解释器循环');
{
  // 构造一段字节码的小工具
  const mk = (insns) => {
    const b = new Uint8Array(insns.length * INSN_W);
    insns.forEach((it, i) => {
      const at = i * INSN_W;
      b[at] = it.op;
      b[at + 1] = it.oa || 0;
      b[at + 2] = it.ob || 0;
      b[at + 3] = it.oc || 0;
      b[at + 4] = it.od || 0;
      b[at + 5] = it.flags || 0;
    });
    return b;
  };
  // 条件跳转约定：**用 peek 而非 pop**。取指器不该替 handler 决定要不要消费栈顶 ——
  // JZ/JNZ 的语义是"看，不吃"，弹不弹由 handler 自己决定。首版测试里写成 pop，
  // 结果 JZ 不成立时把 PUSH 的值吃掉了，下一条 PUSH 读到空栈，这类错能跑通但结果错。
//
// pc 同样由 ctx 独占：顺序指令调 ctx.next()，跳转调 ctx.jump/setPc。
// 内核不在 handler 之后自增 pc——否则跳转"吃掉"自己那条之后还会多执行一条。
const HOST = (extra) => Object.assign({
    consts: [], mem: {}, mask: 0, opShift: 0, entry: 0, limit: 10000, handler: {},
  }, extra || {});
  // 条件跳转约定：**用 peek 而非 pop**。取指器不该替 handler 决定要不要消费栈顶 ——
  // JZ/JNZ 的语义是"看，不吃"，弹不弹由 handler 自己决定。首版测试里写成 pop，
  // 结果 JZ 不成立时把 PUSH 的值吃掉了，下一条 PUSH 读到空栈，这类错能跑通但结果错。

  // ① pc 默认顺序推进
  {
    const seen = [];
    const code = mk([
      { op: 0x11, oa: 1 }, { op: 0x11, oa: 2 }, { op: 0x11, oa: 3 },
    ]);
    runBytecode(code, HOST({
      handler: { 0x11: (c, i) => { seen.push(i.oa); c.next(); } },
    }));
    ok(JSON.stringify(seen) === '[1,2,3]', '顺序取指逐条推进',
      JSON.stringify(seen));
  }

  // ② 未知 opcode 当填充跳过，不报错（虚假 handler 的地基）
  {
    const seen = [];
    const code = mk([{ op: 0xEE }, { op: 0x11, oa: 7 }, { op: 0xEE }, { op: 0xb9 }]);
    const r = runBytecode(code, HOST({
      handler: {
        0x11: (c, i) => { seen.push(i.oa); c.next(); },
        0xb9: (c) => c.setHalted(),
      },
    }));
    ok(r.ok === true, '遇到未知 opcode 不失败（当填充跳过）', 'ok=' + r.ok);
    ok(JSON.stringify(seen) === '[7]', '未知 opcode 之间的真指令仍被执行',
      JSON.stringify(seen));
  }

  // ③ 步数上限：有界失败，不是死循环
  {
    const code = mk([{ op: 0x11, oa: 1 }]);
    const t0 = Date.now();
    const r = runBytecode(code, HOST({
      limit: 500,
      // 不推进 pc → 必然超限
      handler: { 0x11: () => {} },
    }));
    ok(r.ok === false && r.steps === 501, '不推进 pc 时按 limit 有界失败',
      'ok=' + r.ok + ' steps=' + r.steps);
    ok(Date.now() - t0 < 1000, '失败是立即的（不是靠超时兜底）');
  }

  // ④ 越界取指
  {
    const code = mk([{ op: 0x11, oa: 1 }]);
    const r = runBytecode(code, HOST({
      entry: 99,
      handler: { 0x11: (c) => c.next() },
    }));
    ok(r.ok === false, '入口越界直接失败', 'ok=' + r.ok);
  }

  // ⑤ 空字节码
  {
    const r = runBytecode(new Uint8Array(0), HOST({ handler: {} }));
    ok(r.ok === false, '空字节码失败而不是崩掉', 'ok=' + r.ok);
  }

  // ⑥ HALT 正常终止
  {
    const code = mk([{ op: 0x11, oa: 5 }, { op: 0xb9 }]);
    const r = runBytecode(code, HOST({
      handler: {
        0x11: (c) => c.next(),
        0xb9: (c) => c.setHalted(),
      },
    }));
    ok(r.ok === true && r.halted === true, 'HALT 正常终止',
      'ok=' + r.ok + ' halted=' + r.halted);
    ok(r.steps === 2, 'HALT 之后不再取指', 'steps=' + r.steps);
  }

  // ⑦ 条件跳转：JZ 只在假值处跳
  {
    // 0: PUSH 0 ; 1: JZ +2 ; 2: PUSH 111(不该到) ; 3: PUSH 7 ; 4: HALT
    const code = mk([
      { op: 0x11, oa: 0 },
      { op: 0x7e, oa: 2 },   // 相对偏移：+2 跳过下一条 PUSH 111
      { op: 0x11, oa: 111 },
      { op: 0x11, oa: 7 },
      { op: 0xb9 },
    ]);
    const pushed = [];
    const r = runBytecode(code, HOST({
      handler: {
        0x11: (c, i) => { pushed.push(i.oa); c.push(i.oa); c.next(); },
        0x7e: (c, i) => { if (c.peek() === 0) c.jump(i.oa); else c.next(); },
        0xb9: (c) => c.setHalted(),
      },
    }));
    ok(JSON.stringify(pushed) === '[0,7]',
      'JZ 在栈顶为 0 时跳转，跳过中间的 PUSH', JSON.stringify(pushed));
    ok(r.ok === true, '跳转路径正常结束');
  }

  // ⑦b 条件跳转不成立时必须顺序执行（首版 pc 双所有权时这里会多跳一条）
  {
    const code = mk([
      { op: 0x11, oa: 1 },
      { op: 0x7e, oa: 2 },   // 栈顶非 0 → 不跳
      { op: 0x11, oa: 111 }, // 应当被执行
      { op: 0xb9 },
    ]);
    const pushed = [];
    runBytecode(code, HOST({
      handler: {
        // 必须真的 c.push —— JZ 要看栈顶。首版这里只往 pushed 记、没压栈，
        // 于是 peek() 恒为 0，JZ 总是成立，PUSH 111 被跳过，
        // 而"PUSH 1" 那条仍然出现在 pushed 里，看着像只差一个元素，很难定位。
        0x11: (c, i) => { pushed.push(i.oa); c.push(i.oa); c.next(); },
        0x7e: (c, i) => { if (c.peek() === 0) c.jump(i.oa); else c.next(); },
        0xb9: (c) => c.setHalted(),
      },
    }));
    ok(JSON.stringify(pushed) === '[1,111]',
      '跳转条件不成立时顺序执行下一条（栈顶未被吃掉）', JSON.stringify(pushed));
  }

  // ⑦c 跑出字节码末尾必须有界失败（真实程序漏写 HALT 时不能无限跑）
  {
    const code = mk([{ op: 0x11, oa: 1 }]);
    const r = runBytecode(code, HOST({ handler: { 0x11: (c) => c.next() } }));
    ok(r.ok === false, '缺少 HALT 时跑出末尾 → 有界失败（不是无限执行）',
      'ok=' + r.ok + ' steps=' + r.steps);
  }

  // ⑧ 操作数按字节读取（不解释语义，由 handler 决定）
  {
    const got = [];
    const code = mk([{ op: 0x11, oa: 0x12, ob: 0x34, oc: 0x56, od: 0x78, flags: 0x9a }]);
    runBytecode(code, HOST({
      handler: { 0x11: (c, i) => { got.push([i.oa, i.ob, i.oc, i.od, i.flags]); c.setPc(c.getPc() + 1); } },
    }));
    ok(JSON.stringify(got) === '[[18,52,86,120,154]]',
      'oa..od 与 flags 六个字节都正确传给 handler', JSON.stringify(got));
  }

  // ⑨ 栈混淆：push/pop 往返
  {
    const code = mk([{ op: 0x11, oa: 0 }, { op: 0x11, oa: 0 }, { op: 0x11, oa: 0 }]);
    const seen = [];
    const r = runBytecode(code, HOST({
      mask: 0x5a5a5a5a,
      handler: {
        0x11: (c, i) => { c.push(i.oa); seen.push(c.pop()); c.next(); },
      },
    }));
    ok(JSON.stringify(seen) === '[0,0,0]', '加掩码后 push/pop 仍往返一致',
      JSON.stringify(seen));
    ok(r.stack.length === 0, '栈平衡（净深度为 0）', 'depth=' + r.stack.length);
  }

  // ⑩ peek / poke 的偏移语义
  {
    const code = mk([{ op: 0x11, oa: 0 }, { op: 0x11, oa: 0 }, { op: 0x11, oa: 0 }]);
    let depth = -1;
    let peeked = null;
    runBytecode(code, HOST({
      mask: 0,
      handler: {
        0x11: (c, i) => {
          if (depth < 0) { c.push(11); c.push(22); c.push(33); depth = c.stack.length; }
          else if (peeked === null) { peeked = [c.peek(), c.peek(1), c.peek(2)]; c.setHalted(); }
          c.next();
        },
      },
    }));
    ok(depth === 3, '连续 push 后栈深为 3', 'depth=' + depth);
    ok(JSON.stringify(peeked) === '[33,22,11]',
      'peek(d) 从栈顶往下数', JSON.stringify(peeked));
  }
}

section('真实程序：解释一段算术');
{
  // 用真实 handler 表跑 (1 + 2 * 3) - 4 = 3
  //
  // 后缀式栈机序列必须是：PUSH 2 ; PUSH 3 ; MUL ; PUSH 1 ; ADD ; PUSH 4 ; SUB ; HALT
  //
  // 首版写成 push(1) push(2) push(3) MUL …，那是 1 + (2*3 + 1) - 4，
  // 结果 [1,3] 而不是 [3] —— 栈底那个 1 从没参与运算，留在栈里当垃圾。
  // 栈机的老坑：多余的 push 不会报错，只会让结果偏掉一截。
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
    code[at] = it.op;
    code[at + 1] = it.oa || 0;
    code[at + 2] = it.ob || 0;
    code[at + 3] = it.oc || 0;
    code[at + 4] = it.od || 0;
    code[at + 5] = it.flags || 0;
  });

  const handler = {
    [OPCODES.PUSH]: (c, i) => { c.push(i.oa); c.next(); },
    [OPCODES.MUL]: (c) => { const y = c.pop(); const x = c.pop(); c.push((x * y) | 0); c.next(); },
    [OPCODES.SUB]: (c) => { const y = c.pop(); const x = c.pop(); c.push((x - y) | 0); c.next(); },
    [OPCODES.ADD]: (c) => { const y = c.pop(); const x = c.pop(); c.push((x + y) | 0); c.next(); },
    [OPCODES.HALT]: (c) => c.setHalted(),
  };

  const r = runBytecode(code, { handler, consts: [], mem: {}, mask: 0, opShift: 0, entry: 0, limit: 1000 });
  const top = r.stack.length ? unstash(r.stack[r.stack.length - 1], r.mask) : null;
  ok(top === 3, '解释 (1+2*3)-4 得 3', 'got ' + top);
  ok(r.ok && r.halted, '程序正常 HALT');

  // 带操作码变换时结果必须相同（多态不能改变语义）
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
      c2[at + 4] = it.od || 0; c2[at + 5] = it.flags || 0;
    });
    const h2 = {};
    // handler 表的键就是**原操作码**。runBytecode 取指时先 un() 解变换拿到原值，
    // 再用原值查表——所以表键不能跟着 shift 变。
    // （首版把表键也 +shift 了，于是解出来的 17 去查 18 的键，全落空成未知
    //  opcode 被当填充跳过，报"结果不对"，而字节码与表看起来完全对应。）
    for (const [k, fn] of Object.entries(handler)) h2[Number(k)] = fn;
    const r2 = runBytecode(c2, { handler: h2, consts: [], mem: {}, mask: 0, opShift: shift, entry: 0, limit: 1000 });
    const t2 = r2.stack.length ? unstash(r2.stack[r2.stack.length - 1], r2.mask) : null;
    ok(t2 === 3, 'shift=' + shift + ' 下语义不变（变换是等价的）',
      'got ' + t2 + ' ok=' + r2.ok + ' steps=' + r2.steps +
      ' bc=[' + [...c2].join(',') + '] h2keys=[' + Object.keys(h2).join(',') + ']');
  }
}

if (process.argv[1] && process.argv[1].endsWith('vmcore.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}