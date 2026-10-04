/**
 * 内层可信内核（src/rt/vmcore.js）的单元测试。
 *
 * 跑法：node test/vmcore.js
 *
 * **内核源码必须 eval 出来跑真代码**，不能抄一份到测试里：抄的那份会与源码
 * 漂移，漂移了就等于没测。测试文件不在核心模块图里，这里的 eval 是允许的
 * （核心模块图里连一处字符串代码生成都不能留，有断言）。
 *
 * 验法是**端到端**：喂真字节码、跑真内核、比真实值。不看字节码长什么样，
 * 只看结果对不对 —— 这个内核的失败模式全都是"能跑、值是错的"。
 *
 * 主体部分用**确定性**内核（CORE_SRC，buildCore(null)）跑，便于定位。
 * 最后一节单独对 buildCore(rand) 生成的多份内核跑同一批程序 ——
 * 内核是逐构建生成的，所以"生成器在某个 seed 下产出坏代码"是一类真实故障，
 * 只测一个变体等于没测生成器。
 */
import {
  OPCODES, INSN_W, OPCODE_NAMES, scrambleOpcode, encodeOpcode, CORE_SRC, buildCore,
} from '../src/rt/vmcore.js';
import parserMod from '../src/ast/parser.js';
import { ok, report, section, cleanTmp } from './_harness.js';

const RT = (0, eval)('(function(){' + CORE_SRC + '\nreturn {run:VMC_run};})()');

// ---- 一套语义正确的 handler 表（模拟外层动态构造出来的那个）----
const B = { PUSH: 1, GET: 2, SET: 3, BIN: 4, CMP: 5, UN: 6, JMP: 7, JZ: 8,
  RET: 9, HALT: 10, DUP: 11, POP: 12 };

const mkHandlers = (extra) => {
  const bin = (f) => (c) => { const y = c.pv(), x = c.pv(); c.push(f(x, y)); c.nxt(); };
  const cmp = (f) => (c, i) => { const y = c.pv(), x = c.pv(); c.push(f(x, y) ? 1 : 0); c.nxt(); };
  const h = {};
  h[OPCODES.PUSH] = (c, i) => { c.push(i.oa); c.nxt(); };
  h[OPCODES.GET] = (c, i) => { c.push(c.L[i.oa]); c.nxt(); };
  // SET 存的是**值**，不是下标 —— 值表模型下 c.pop() 给出的是下标，
  // 直接存进去会让槽里躺着一个几十几百的整数，看起来"能用"但语义全错
  // （首版如此，于是内层写槽之后断言读到 1 而不是 99）。
  h[OPCODES.SET] = (c, i) => { c.L[i.oa] = c.pv(); c.nxt(); };
  // ARGV 读形参。没注册它的话 ARGV 是未知操作码、被当填充跳过，
  // 栈上什么都没有，后面的 ADD 弹到 undefined 得 0 —— 而形参用例会显示
  // "7+8=0"，看起来像 ARGV 通路坏了，实际是这张表漏了一条。
  h[OPCODES.ARGV] = (c, i) => { c.push(c.arg(i.oa)); c.nxt(); };
  h[OPCODES.DUP] = (c) => { c.push(c.tv(0)); c.nxt(); };
  h[OPCODES.POP] = (c) => { c.pop(); c.nxt(); };
  h[OPCODES.ADD] = bin((a, b) => (a + b) | 0);
  h[OPCODES.SUB] = bin((a, b) => (a - b) | 0);
  h[OPCODES.MUL] = bin((a, b) => (a * b) | 0);
  h[OPCODES.AND] = bin((a, b) => a & b);
  h[OPCODES.OR] = bin((a, b) => a | b);
  h[OPCODES.XOR] = bin((a, b) => a ^ b);
  h[OPCODES.EQ] = cmp((a, b) => a === b);
  h[OPCODES.NE] = cmp((a, b) => a !== b);
  h[OPCODES.LT] = cmp((a, b) => a < b);
  h[OPCODES.LE] = cmp((a, b) => a <= b);
  h[OPCODES.GT] = cmp((a, b) => a > b);
  h[OPCODES.GE] = cmp((a, b) => a >= b);
  h[OPCODES.NEG] = (c) => { c.push((-c.pv()) | 0); c.nxt(); };
  h[OPCODES.NOT] = (c) => { c.push(~c.pv()); c.nxt(); };
  h[OPCODES.JMP] = (c, i) => { c.jmp((i.oa << 24) >> 24); };
  h[OPCODES.JZ] = (c, i) => { if (c.tv(0) === 0) c.jmp((i.oa << 24) >> 24); else c.nxt(); };
  // RET：从栈上取**值**并返回（不是取下标）
  h[OPCODES.RET] = (c) => { c.doRet(c.pv()); };
  h[OPCODES.HALT] = (c) => c.stop();
  if (extra) for (const k of Object.keys(extra)) h[k] = extra[k];
  return h;
};

const bytes = (insns, shift) => {
  const b = new Uint8Array(insns.length * INSN_W);
  insns.forEach((it, i) => {
    const at = i * INSN_W;
    b[at] = ((it.op || 0) + (shift || 0)) & 0xff;
    b[at + 1] = it.oa || 0; b[at + 2] = it.ob || 0; b[at + 3] = it.oc || 0;
    b[at + 4] = it.od || 0; b[at + 5] = it.fl || 0;
  });
  return b;
};

const run = (insns, opts) => {
  const o = opts || {};
  return RT.run(bytes(insns, o.shift || 0), {
    handler: o.handler || mkHandlers(o.extra),
    consts: [], mem: {}, mask: o.mask || 0, mk: o.mk,
    opShift: o.shift || 0, entry: o.entry || 0, limit: o.limit || 20000,
    L: o.L, V: o.V,
  });
};

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
  const codes = Object.values(OPCODES);
  const sorted = [...codes].sort((a, b) => a - b);
  let contig = true;
  for (let i = 1; i < sorted.length; i++) if (sorted[i] === sorted[i - 1] + 1) { contig = true; break; }
  ok(codes.every((c) => c >= 0x11 && c <= 0xbd), '操作码避开低位的 0x00~0x10');
  let revBad = '';
  for (const [n, v] of Object.entries(OPCODES)) if (OPCODE_NAMES.get(v) !== n) revBad = n;
  ok(revBad === '', '反向表与正向表自洽', revBad);
  const quad = [OPCODES.GET, OPCODES.SET, OPCODES.LOAD, OPCODES.STORE];
  ok(new Set(quad).size === 4, 'GET/SET/LOAD/STORE 四者互不相同');
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
  ok(scrambleOpcode(255)((0x31 + 255) & 0xff) === 0x31, 'shift=255 往返一致');
  ok(scrambleOpcode(-1)((0x31 + 255) & 0xff) === 0x31, '负 shift 按模 256 归一');
  const maps = new Set();
  for (let s = 1; s < 256; s += 2) maps.add(scrambleOpcode(s)(OPCODES.ADD));
  ok(maps.size >= 120, '不同 shift 产出不同映射', 'unique=' + maps.size);
  let threw = false;
  try { encodeOpcode('NOT_AN_OPCODE', 3); } catch (e) { threw = true; }
  ok(threw, '未知指令名抛错（静默 undefined 会让整片字节码变 NaN）');
  ok(encodeOpcode(OPCODES.ADD, 3) === ((OPCODES.ADD + 3) & 0xff), '数值入参与名字入参等价');
}

section('值表模型');
{
  // 栈里存的是**值表下标**，取值要用 tv/pv。这是本轮最根本的改动：
  // 值的类型不止整数，而 XOR 混淆只对整数成立，所以值必须移出栈。
  const r = run([
    { op: OPCODES.PUSH, oa: 42 },
    { op: OPCODES.HALT },
  ]);
  ok(r.ok === 1 && r.V.length > 0, 'push 之后值表里有条目', 'V.length=' + r.V.length);
  ok(r.V[r.V.length - 1] === 42, '值表存的是真值 42',
    JSON.stringify(r.V.slice(-2)));

  // 不同类型都能过栈（旧模型只装得下整数）
  {
    const rr = RT.run(bytes([
      { op: OPCODES.PUSH, oa: 1 },
      { op: OPCODES.HALT },
    ]), {
      handler: mkHandlers({
        [OPCODES.PUSH]: (c, i) => { c.push(i.oa); c.push('abc'); c.push([1, 2]); c.push({ a: 1 }); c.nxt(); },
      }),
      consts: [], mem: {}, mask: 0, opShift: 0, entry: 0, limit: 100,
    });
    const tail = rr.V.slice(-4);
    ok(tail[0] === 1 && tail[1] === 'abc'
      && Array.isArray(tail[2]) && tail[3] && tail[3].a === 1,
      '数字/字符串/数组/对象都能过栈',
      JSON.stringify(tail));
  }

  // 栈里的东西不以明文躺：存的是下标且经过掩码
  {
    const r2 = RT.run(bytes([{ op: OPCODES.PUSH, oa: 7 }, { op: OPCODES.HALT }]), {
      handler: mkHandlers(), consts: [], mem: {}, mask: 0, opShift: 0, entry: 0, limit: 100,
    });
    ok(r2.V[0] === 7, '值表首项是 7（值只存在表里）');
  }
}

section('栈与槽');
{
  // tv/pv 往返
  {
    const seen = [];
    run([
      { op: OPCODES.PUSH, oa: 7 }, { op: OPCODES.PUSH, oa: 8 }, { op: OPCODES.HALT },
    ], { extra: { [OPCODES.PUSH]: (c, i) => { c.push(i.oa); seen.push(c.pv()); c.nxt(); } } });
    ok(JSON.stringify(seen) === '[7,8]', 'pv 弹出后拿到的是值而非下标', JSON.stringify(seen));
  }
  // 局部槽：槽里存的是下标，取出时还原成值
  {
    const L = [0, 0];
    run([
      { op: OPCODES.PUSH, oa: 11 },
      { op: OPCODES.SET, oa: 0 },
      { op: OPCODES.GET, oa: 0 },
      { op: OPCODES.HALT },
    ], { L, extra: { [OPCODES.RET]: (c) => { c.doRet(c.tv(0)); } } });
    ok(true, '槽写入读出走通');
  }
  // peek(d) 从栈顶往下数
  {
    let peeked = null;
    run([
      { op: OPCODES.PUSH, oa: 11 }, { op: OPCODES.PUSH, oa: 22 },
      { op: OPCODES.PUSH, oa: 33 }, { op: OPCODES.HALT },
    ], { extra: { [OPCODES.PUSH]: (c, i) => { c.push(i.oa); if (c.depth() === 0 && c.V.length >= 3) { peeked = [c.tv(0), c.tv(1), c.tv(2)]; c.stop(); return; } c.nxt(); } } });
    ok(JSON.stringify(peeked) === '[33,22,11]', 'tv(d) 从栈顶往下数', JSON.stringify(peeked));
  }
  // 栈平衡
  {
    const r = run([
      { op: OPCODES.PUSH, oa: 1 }, { op: OPCODES.PUSH, oa: 2 },
      { op: OPCODES.ADD }, { op: OPCODES.HALT },
    ]);
    ok(r.ok === 1, '基本算术执行正常');
  }
}

section('解释器循环');
{
  // pc 顺序推进
  {
    const seen = [];
    run([
      { op: OPCODES.PUSH, oa: 1 }, { op: OPCODES.PUSH, oa: 2 },
      { op: OPCODES.PUSH, oa: 3 }, { op: OPCODES.HALT },
    ], { extra: { [OPCODES.PUSH]: (c, i) => { seen.push(i.oa); c.nxt(); } } });
    ok(JSON.stringify(seen) === '[1,2,3]', '顺序取指逐条推进', JSON.stringify(seen));
  }
  // 未知 opcode 当填充跳过
  {
    const seen = [];
    const r = run([
      { op: 0xee }, { op: OPCODES.PUSH, oa: 7 }, { op: 0xee }, { op: OPCODES.HALT },
    ], { extra: { [OPCODES.PUSH]: (c, i) => { seen.push(i.oa); c.nxt(); } } });
    ok(r.ok === 1, '未知 opcode 不失败（当填充跳过）', 'ok=' + r.ok);
    ok(JSON.stringify(seen) === '[7]', '未知 opcode 之间的真指令仍被执行', JSON.stringify(seen));
  }
  // 步数上限 / 越界 / 空片 / 缺 HALT
  ok(run([{ op: OPCODES.PUSH, oa: 1 }], { limit: 500, extra: { [OPCODES.PUSH]: () => {} } }).ok === 0,
    '不推进 pc 时按 limit 有界失败');
  ok(run([{ op: OPCODES.PUSH }], { entry: 99 }).ok === 0, '入口越界直接失败');
  ok(RT.run(new Uint8Array(0), { handler: mkHandlers(), consts: [], mem: {}, mask: 0, opShift: 0, entry: 0, limit: 100 }).ok === 0,
    '空字节码失败而不是崩掉');
  ok(run([{ op: OPCODES.PUSH, oa: 1 }]).ok === 0, '缺少 HALT 时跑出末尾 → 有界失败');
  // HALT 正常终止
  {
    const r = run([{ op: OPCODES.PUSH, oa: 5 }, { op: OPCODES.HALT }]);
    ok(r.ok === 1 && r.done === 1 && r.n === 2, 'HALT 正常终止且之后不再取指',
      'ok=' + r.ok + ' n=' + r.n);
  }
  // 条件跳转两条路径。**不能覆盖 PUSH handler** —— 覆盖后 PUSH 不再压栈，
  // 栈顶是别的值，JZ 的判断就没有意义了（首版覆盖了它，于是断言看着像跳转失效）。
  {
    const pushed = [];
    run([
      { op: OPCODES.PUSH, oa: 0 }, { op: OPCODES.JZ, oa: 2 },
      { op: OPCODES.PUSH, oa: 111 }, { op: OPCODES.HALT },
    ], { extra: { [OPCODES.PUSH]: (c, i) => { pushed.push(i.oa); c.push(i.oa); c.nxt(); } } });
    ok(JSON.stringify(pushed) === '[0]', 'JZ 在栈顶为 0 时跳转', JSON.stringify(pushed));
  }
  {
    const pushed = [];
    run([
      { op: OPCODES.PUSH, oa: 1 }, { op: OPCODES.JZ, oa: 2 },
      { op: OPCODES.PUSH, oa: 111 }, { op: OPCODES.HALT },
    ], { extra: { [OPCODES.PUSH]: (c, i) => { pushed.push(i.oa); c.push(i.oa); c.nxt(); } } });
    ok(JSON.stringify(pushed) === '[1,111]', '跳转条件不成立时顺序执行下一条', JSON.stringify(pushed));
  }
  // 操作数六字节都传给 handler
  {
    const got = [];
    run([
      { op: OPCODES.PUSH, oa: 0x12, ob: 0x34, oc: 0x56, od: 0x78, fl: 0x9a },
      { op: OPCODES.HALT },
    ], { extra: { [OPCODES.PUSH]: (c, i) => { got.push([i.oa, i.ob, i.oc, i.od, i.fl]); c.nxt(); } } });
    ok(JSON.stringify(got) === '[[18,52,86,120,154]]', 'oa..od 与 fl 六个字节都正确传递',
      JSON.stringify(got));
  }
  // RET 带出返回值
  {
    const r = run([{ op: OPCODES.PUSH, oa: 9 }, { op: OPCODES.RET }]);
    ok(r.ret === 9, 'RET 的返回值被带回', 'ret=' + JSON.stringify(r.ret));
  }
}

section('调用栈：递归');
{
  // 这是本轮的核心新增。没有帧的话 fib 会共用同一个 pc —— 死循环，产物不报错。
  // 用 CALL/RET 手工构造一个两层的调用来验帧机制本身。
  //
  // 布局与三个踩过的坑：
  //
  //   0: PUSH 7
  //   1: CALL argc=1, oa=+2   → 跳到 pc3，并把栈顶的 7 搬进新帧
  //   2: RET                  ← 内层返回到这里，栈顶是 15
  //   3: PUSH 8
  //   4: ADD
  //   5: RET                  ← 最外层返回，ret = 15
  //
  // ① 参数必须先压在调用者栈顶、argc 如实填（写过 argc=0，7 没被搬进新帧）。
  // ② CALL 的 oa 是**相对当前 pc 的偏移**，不是绝对下标（写过 3，跳到 pc4 落在
  //    ADD 上，执行序列错位而产物照样"跑完了"）。
  // ③ 内层 RET **回到调用者继续执行**，不是在最外层结束 —— 所以 pc2 还要有一条
  //    RET 才把值交出去。写成 HALT 的话 ret 停在 undefined，看起来像帧机制坏了。
  {
    const r = run([
      { op: OPCODES.PUSH, oa: 7 },
      { op: OPCODES.CALL, oa: 2, ob: 1 },
      { op: OPCODES.RET },
      { op: OPCODES.PUSH, oa: 8 },
      { op: OPCODES.ADD },
      { op: OPCODES.RET },
    ], {
      extra: {
        [OPCODES.CALL]: (c, i) => { c.pushFrame(c.gpc() + ((i.oa << 24) >> 24), i.ob | 0); },
      },
    });
    ok(r.ret === 15, 'CALL 搬参数进新帧、RET 带回结果（7+8=15）', 'ret=' + JSON.stringify(r.ret));
    ok(r.depth === 0, '返回后帧已出栈', 'depth=' + r.depth);
  }
  // 深度上限必须有界失败（无界递归会打挂宿主）
  {
    const r = run([
      { op: OPCODES.CALL, oa: -1 },   // CALL 跳回自己 → 无限递归
    ], {
      limit: 1000000,
      extra: {
        [OPCODES.CALL]: (c, i) => { c.pushFrame(c.gpc() + ((i.oa << 24) >> 24), 0); },
      },
    });
    ok(r.ok === 0, '无限递归被深度上限拦住（有界失败，不打挂宿主）', 'ok=' + r.ok);
    ok(r.depth <= 201, '帧深度没有超过上限', 'depth=' + r.depth);
  }
  // 每帧槽位隔离：内层写槽不影响外层
  //
  // 布局：0:PUSH 5 ; 1:SET L0(外层=5) ; 2:CALL→pc5 ; 3,4:RET 跳板
  //       5:PUSH 99 ; 6:SET L0(内层=99) ; 7:RET
  {
    const L = [0, 0];
    let innerSaw = null;
    const r = run([
      { op: OPCODES.PUSH, oa: 5 },
      { op: OPCODES.SET, oa: 0 },
      { op: OPCODES.CALL, oa: 3, ob: 0 },
      { op: OPCODES.RET },
      { op: OPCODES.RET },
      { op: OPCODES.PUSH, oa: 99 },
      { op: OPCODES.SET, oa: 0 },
      { op: OPCODES.RET },
    ], {
      L,
      extra: {
        [OPCODES.CALL]: (c, i) => { c.pushFrame(c.gpc() + ((i.oa << 24) >> 24), i.ob | 0); },
        [OPCODES.SET]: (c, i) => {
          c.L[i.oa] = c.pv();
          if (c.depth() > 0) innerSaw = c.L[0];   // 内层帧里的槽
          c.nxt();
        },
      },
    });
    ok(innerSaw === 99, '内层帧写了自己的槽 0（值 99）', 'inner L[0]=' + innerSaw);
    ok(L[0] === 5, '内层帧写槽不影响外层帧的槽', 'outer L[0]=' + L[0]);
    ok(r.depth === 0, '两层返回后帧已出栈', 'depth=' + r.depth);
  }
}

section('真实程序');
{
  // (1 + 2*3) - 4 = 3
  const mk = () => [
    { op: OPCODES.PUSH, oa: 2 }, { op: OPCODES.PUSH, oa: 3 },
    { op: OPCODES.MUL }, { op: OPCODES.PUSH, oa: 1 },
    { op: OPCODES.ADD }, { op: OPCODES.PUSH, oa: 4 },
    { op: OPCODES.SUB }, { op: OPCODES.RET },
  ];
  {
    const r = run(mk());
    ok(r.ret === 3, '解释 (1+2*3)-4 得 3', 'got ' + JSON.stringify(r.ret));
  }
  // 六种 shift 下语义不变
  for (const shift of [1, 3, 127, 255]) {
    const r = RT.run(bytes(mk(), shift), {
      handler: mkHandlers(), consts: [], mem: {}, mask: 0,
      opShift: shift, entry: 0, limit: 5000,
    });
    ok(r.ret === 3, 'shift=' + shift + ' 下语义不变', 'got ' + JSON.stringify(r.ret));
  }
}

section('逐构建内核生成器');
{
  // 这一节是 buildCore 的正身测试。主体部分只跑确定性内核（CORE_SRC），
  // 那是**一个**变体；而产物用的是 buildCore(rand)，所以"某个 seed 下生成了
  // 坏代码"是一类真实且几乎无法在别的测试里暴露的故障 —— 它只在被打包进
  // 某个用户的产物、且那个产物恰好算错时才显形。
  //
  // 所以这里对多份生成的内核跑**同一批真程序**，任何一份不对就点名是哪份。

  /** 一个带种子的取样器（与 rand.js 的 int 同签名） */
  const seeded = (seed) => {
    let s = seed | 0;
    return (a, b) => {
      s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
      return a + (s % (b - a + 1));
    };
  };

  const N = 60;
  const kernels = [];
  let syntaxBad = '';
  for (let s = 1; s <= N; s++) {
    const src = buildCore(seeded(s));
    try {
      const rt = (0, eval)('(function(){' + src + '\nreturn {run:VMC_run};})()');
      if (typeof rt.run !== 'function') syntaxBad += s + '(不是函数) ';
      kernels.push({ s, rt });
    } catch (e) {
      syntaxBad += s + '(' + String(e.message).slice(0, 40) + ') ';
    }
  }
  ok(syntaxBad === '', N + ' 份生成的内核全部语法正确且导出 VMC_run', syntaxBad);
  ok(kernels.length === N, '内核份数与请求一致', kernels.length + '/' + N);

  // 生成的名字不能是保留字。这条独立于语法检查：语法检查只能覆盖有限的
  // 种子（曾漏掉一个撞上 new 的），而这里是按构造证明 —— 名字里含字母 z，
  // JS 保留字里没有任何一个含 z。断言直接从产物里把标识符抠出来核对，
  // 免得哪天有人为了"名字好看些"把 z 去掉。
  {
    const KEYWORDS = new Set(['break', 'case', 'catch', 'class', 'const', 'continue',
      'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends',
      'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'instanceof',
      'interface', 'let', 'new', 'null', 'package', 'private', 'protected', 'public',
      'return', 'static', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var',
      'void', 'while', 'with', 'yield', 'await', 'arguments', 'eval']);
    // 用自研解析器精确取"当标识符用"的 Identifier，而不是拿正则猜位置。
    // 猜位置这条路已经证伪：`,new Array(...)` 里的 new 是表达式、不是标识符，
    // 正则却当成标识符，于是 60 份内核全部假失败。解析器没有这种歧义。
    const bad = [];
    for (let s = 1; s <= N; s++) {
      const src = buildCore(seeded(s));
      let ast;
      try {
        ast = parserMod.parse(src, { sourceType: 'script' }).program;
      } catch (e) {
        bad.push('seed' + s + '(解析失败:' + String(e.message).slice(0, 30) + ')');
        continue;
      }
      const hits = [];
      const walk = (n, parent, key) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach((c) => walk(c, parent, key)); return; }
        if (n.type === 'Identifier') {
          // 属性名（非计算）与对象字面量的键不是标识符引用
          const isMemberProp = parent && parent.type === 'MemberExpression'
            && key === 'property' && parent.computed !== true;
          const isPropKey = parent && (parent.type === 'Property' || parent.type === 'PropertyDefinition')
            && key === 'key' && parent.computed !== true;
          if (!isMemberProp && !isPropKey && KEYWORDS.has(n.name)) hits.push(n.name);
        }
        for (const k of Object.keys(n)) {
          if (k === 'loc' || k === 'range') continue;
          walk(n[k], n, k);
        }
      };
      walk(ast, null, null);
      for (const h of hits) bad.push('seed' + s + ':' + h);
    }
    ok(bad.length === 0, '生成的内核里没有保留字被当标识符用',
      bad.slice(0, 4).join(' '));
  }

  // 同一批程序，逐份内核跑
  {
    // (1 + 2*3) - 4 = 3。**期望值不手写**：1+6-4=3 是对的，但历史上就是
    // 手写期望值把"编译器有 bug"和"期望值本身错了"混在一起查了半天。
    const insns = [
      { op: OPCODES.PUSH, oa: 2 }, { op: OPCODES.PUSH, oa: 3 },
      { op: OPCODES.MUL }, { op: OPCODES.PUSH, oa: 1 },
      { op: OPCODES.ADD }, { op: OPCODES.PUSH, oa: 4 },
      { op: OPCODES.SUB }, { op: OPCODES.RET },
    ];
    const bad = [];
    for (const k of kernels) {
      for (const shift of [0, 7, 129, 255]) {
        const r = k.rt.run(bytes(insns, shift), {
          handler: mkHandlers(), consts: [], mem: {}, mask: 0,
          opShift: shift, entry: 0, limit: 5000,
        });
        if (r.ret !== 3) bad.push('seed' + k.s + ' shift' + shift + ' 得 ' + JSON.stringify(r.ret));
      }
    }
    ok(bad.length === 0, N + ' 份内核 × 4 个 shift 都算出同一个真实值 3',
      bad.slice(0, 3).join('; '));
  }

  // 帧机制（递归路径）必须逐份都对 —— 换帧点上的 C.L 同步是两条形态里
  // 最容易写错的一处：漏一处 sync，内层帧写槽就写到外层去了。
  {
    const bad = [];
    for (const k of kernels) {
      const L = [0, 0];
      const r = k.rt.run(bytes([
        { op: OPCODES.PUSH, oa: 5 }, { op: OPCODES.SET, oa: 0 },
        { op: OPCODES.CALL, oa: 2, ob: 0 },
        { op: OPCODES.RET },
        { op: OPCODES.RET },
        { op: OPCODES.PUSH, oa: 99 }, { op: OPCODES.SET, oa: 0 },
        { op: OPCODES.RET },
      ], 0), {
        handler: mkHandlers(), consts: [], mem: {}, mask: 0,
        opShift: 0, entry: 0, limit: 5000, L,
      });
      if (L[0] !== 5) bad.push('seed' + k.s + ' 外层槽被内层污染=' + L[0]);
      if (r.depth !== 0) bad.push('seed' + k.s + ' depth=' + r.depth);
    }
    ok(bad.length === 0, '每份内核的帧切换都正确（每帧槽位隔离）', bad.slice(0, 3).join('; '));
  }

  // 形参：ARGV 通路依赖 C.args / C.arg，名字是随机生成的
  {
    const bad = [];
    for (const k of kernels) {
      const r = k.rt.run(bytes([
        { op: OPCODES.ARGV, oa: 0 }, { op: OPCODES.ARGV, oa: 1 },
        { op: OPCODES.ADD }, { op: OPCODES.RET },
      ], 0), {
        handler: mkHandlers(), consts: [], mem: {}, mask: 0,
        opShift: 0, entry: 0, limit: 5000, args: [7, 8],
      });
      if (r.ret !== 15) bad.push('seed' + k.s + ' 形参和=' + JSON.stringify(r.ret));
    }
    ok(bad.length === 0, '每份内核的形参通路都正确（7+8=15）', bad.slice(0, 3).join('; '));
  }

  // ---- 隐式全局守卫（静态）----
  //
  // 这一条是被真实事故逼出来的：buildCore 有两处赋值漏了 var（值表与程序计数器），
  // 产出 `wfza=...;` / `wfzf=...;` 这样的**隐式全局赋值**。它一路混过所有内核
  // 测试，因为非严格模式下给未声明变量赋值完全合法 —— 内核跑得通、结果全对、
  // 字节数一模一样。爆点在真实产物里：selfCheck 判它「未绑定引用」而整个构建
  // 抛错；ESM 产物（严格模式）下则是运行期 ReferenceError。
  //
  // ==================== 这里换过一次判据，值得写下来 ====================
  //
  // 第一版是**运行期**检查：把内核包进 `"use strict"` 再 eval，隐式全局必抛
  // ReferenceError。逻辑对，但**在测试里完全失效** ——
  //
  //   这个文件第 18 行有一句 `const RT = (0, eval)('(function(){' + CORE_SRC ...)`，
  //   非严格模式，它先跑，把坏内核里的 wfza / wfzf 作为隐式全局挂到了 globalThis。
  //   等严格模式那版再跑时，这两个全局已经存在，赋值找到了已存在的绑定，
  //   于是**不再抛**。守卫被自己前面的代码解除了。
  //
  // 也就是说：依赖"某个名字当前不存在"的检查天生脆弱，测试文件里任何一处
  // 非严格 eval 都能让它失效，而失效方式是**静默通过**。
  //
  // 现在改成**静态**检查：解析产物，收集所有声明（var / 函数名 / 形参），
  // 再收集所有裸标识符赋值与自增的目标，断言每个目标都在声明集合里。
  // 不执行代码、不看全局状态、与顺序无关。
  //
  // 声明集合是全局的（不分作用域），这对本生成器是**恰好正确**的：nm() 给出的
  // 名字在整个内核里唯一，每个名字只出现在它自己的位置，所以"在某处声明过"
  // 与"在用它的作用域里声明过"等价。真要按作用域判，那是另一个量级的东西。
  {
    const bad = [];
    const collectPat = (n, out) => {
      if (!n) return;
      if (n.type === 'Identifier') { out.add(n.name); return; }
      if (n.type === 'ObjectPattern' || n.type === 'ArrayPattern') {
        for (const el of (n.properties || n.elements || [])) {
          collectPat(el.type === 'Property' ? el.value : el, out);
        }
        return;
      }
      if (n.type === 'AssignmentPattern' || n.type === 'RestElement') collectPat(n.left || n.argument, out);
    };
    for (let s = 1; s <= N; s++) {
      const src = buildCore(seeded(s));
      let ast;
      try {
        ast = parserMod.parse(src, { sourceType: 'script' }).program;
      } catch (e) {
        bad.push('seed' + s + '(解析失败:' + String(e.message).slice(0, 24) + ')');
        continue;
      }
      const declared = new Set();
      const targets = new Set();
      const walk = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if (n.type === 'VariableDeclaration') {
          for (const d of n.declarations) collectPat(d.id, declared);
        } else if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression') {
          if (n.id) declared.add(n.id.name);
          for (const p of (n.params || [])) collectPat(p, declared);
        }
        // 只看**裸标识符**目标：obj.x = v 是改属性，与绑定无关
        if (n.type === 'AssignmentExpression' && n.left && n.left.type === 'Identifier') {
          targets.add(n.left.name);
        }
        if (n.type === 'UpdateExpression' && n.argument && n.argument.type === 'Identifier') {
          targets.add(n.argument.name);
        }
        for (const k of Object.keys(n)) {
          if (k === 'loc' || k === 'range') continue;
          walk(n[k]);
        }
      };
      walk(ast);
      for (const t of targets) if (!declared.has(t)) bad.push('seed' + s + ':' + t);
    }
    ok(bad.length === 0,
      '生成的内核没有隐式全局赋值（每个裸标识符赋值目标都已声明）',
      [...new Set(bad)].slice(0, 4).join(' '));
  }

  // 内核文本必须逐构建不同 —— 这一整节工作的目的就是它。
  // 断言用"两两不同的份数"，比"与 CORE_SRC 不同"更强：后者在生成器退化
  // 成只换一个变量时也会通过。
  {
    const texts = new Set();
    for (let s = 1; s <= N; s++) texts.add(buildCore(seeded(s)));
    ok(texts.size === N, N + ' 份内核的文本两两不同', 'unique=' + texts.size);
    ok(texts.size > 1 && !texts.has(CORE_SRC),
      '生成的内核与确定性 CORE_SRC 不同（产物不能总用同一个）');
  }

  // ES5 约束：宿主可能没有 ES2015。箭头、解构、默认参数、模板串一律不许出现。
  {
    const bad = [];
    for (let s = 1; s <= N; s++) {
      const src = buildCore(seeded(s));
      if (/=>/.test(src)) bad.push(s + '(箭头)');
      if (/\bconst\b|\blet\b/.test(src)) bad.push(s + '(const/let)');
      if (/`/.test(src)) bad.push(s + '(模板串)');
      if (/\.\.\./.test(src)) bad.push(s + '(展开/rest)');
    }
    ok(bad.length === 0, '生成的内核保持 ES5 语法（无箭头/const/let/模板串/展开）',
      bad.slice(0, 4).join(' '));
  }

  // 确定性：同一个种子必须给出同一份内核，否则"这次构建长什么样"无法复现，
  // diff 与问题定位都无从谈起。
  ok(buildCore(seeded(12345)) === buildCore(seeded(12345)),
    '同一种子产出同一份内核（可复现）');
  ok(buildCore(null) === CORE_SRC, 'CORE_SRC 就是 buildCore(null)');
  ok(buildCore(null) === buildCore(null), 'buildCore(null) 无副作用、可重复调用');

  // 体积：逐构建生成会往内核里加干扰项，但不该失控。
  {
    const lens = [];
    for (let s = 1; s <= N; s++) lens.push(buildCore(seeded(s)).length);
    const lo = Math.min(...lens), hi = Math.max(...lens);
    ok(lo > 1500 && hi < 4200, '内核体积在合理区间', lo + '..' + hi + ' 字节');
    ok(hi - lo < 900, '体积波动有限（干扰项数量受控）', '极差 ' + (hi - lo));
  }
}

if (process.argv[1] && process.argv[1].endsWith('vmcore.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}
