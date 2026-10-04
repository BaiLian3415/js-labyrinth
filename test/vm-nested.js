/**
 * 嵌套档编译器（src/passes/vmNested.js）测试。
 *
 * 跑法：node test/vm-nested.js
 *
 * 这一层只验"AST → 字节码 → 内核执行"这条链路，不涉及产物注入。核心断言方式
 * 是**端到端比对**：编译出来的字节码交给 vmcore 真实执行，拿到的返回值必须与
 * 直接跑原始 JS 一致 —— 不看字节码长什么样，只看结果对不对。
 *
 * 编译器刻意只吃算术与局部变量。遇到不支持的语法必须返回 null（退让给单层档），
 * 绝不能产出算错的字节码：后者会让产物算出错误值，且极难归因。所以"该退让的
 * 时候确实退让"是这批测试的重点。
 */
import parserMod from '../src/ast/parser.js';
const { parse } = parserMod;
import { compileNested } from '../src/passes/vmNested.js';
import {
  OPCODES, INSN_W, scrambleOpcode, encodeOpcode, CORE_SRC,
} from '../src/rt/vmcore.js';

// 跑的是 CORE_SRC 里那段源码（与产物里注入的是同一份文本），
// 而不是 import 一个函数——测试必须验真正会进产物的那份。
const RT = (0, eval)('(function(){' + CORE_SRC + '\nreturn {run:VMC_run};})()');
import { ok, report, section, cleanTmp, runNode } from './_harness.js';

/**
 * 给字节码配一套 handler（模拟外层动态生成的表），然后真跑。
 * @param {Uint8Array} code
 * @param {number} shift 操作码变换偏移
 * @param {number} slots 局部槽数
 */
function execute(code, shift, slots) {
  const st = (o) => (o ^ 0x37) | 0;   // 状态字掩码，与编译期无关，这里随手取一个
  const K = {};
  // 局部变量：GET/SET 走一张与 regs 平行的小表（内核不区分，handler 自己分）
  const locals = new Array(slots).fill(0);
  K[OPCODES.PUSH] = (c, i) => { c.push(i.oa); c.nxt(); };
  K[OPCODES.GET] = (c, i) => { c.push(st(locals[i.oa])); c.nxt(); };
  // SET 只写不推。赋值语句的"自身有值"由编译器在 SET 之前显式 DUP 表达，
  // handler 若自己多推一个，栈就会多出一份垃圾 —— 首版正是在这里出的 3025。
  K[OPCODES.SET] = (c, i) => { locals[i.oa] = st(c.pop()); c.nxt(); };
  K[OPCODES.DUP] = (c) => { c.push(c.peek(0)); c.nxt(); };
  K[OPCODES.POP] = (c) => { c.pop(); c.nxt(); };
  for (const [name, fn] of Object.entries({
    ADD: (a, b) => (a + b) | 0, SUB: (a, b) => (a - b) | 0,
    MUL: (a, b) => (a * b) | 0, DIV: (a, b) => (a / b) | 0,
    MOD: (a, b) => (a % b) | 0,
  })) {
    K[OPCODES[name]] = (c) => {
      const b = c.pop(), a = c.pop();
      c.push(fn(a, b) | 0); c.nxt();
    };
  }
  for (const [name, fn] of Object.entries({
    AND: (a, b) => a & b, OR: (a, b) => a | b, XOR: (a, b) => a ^ b,
    SHL: (a, b) => a << b, SHR: (a, b) => a >> b, USHR: (a, b) => a >>> b,
    EQ: (a, b) => (a === b ? 1 : 0), NE: (a, b) => (a !== b ? 1 : 0),
    LT: (a, b) => (a < b ? 1 : 0), LE: (a, b) => (a <= b ? 1 : 0),
    GT: (a, b) => (a > b ? 1 : 0), GE: (a, b) => (a >= b ? 1 : 0),
  })) {
    K[OPCODES[name]] = (c) => {
      const b = c.pop(), a = c.pop();
      c.push(fn(a, b) | 0); c.nxt();
    };
  }
  K[OPCODES.NEG] = (c) => { c.push((-c.pop()) | 0); c.nxt(); };
  K[OPCODES.NOT] = (c) => { c.push((~c.pop()) | 0); c.nxt(); };
  K[OPCODES.JMP] = (c, i) => { c.jmp((i.oa << 24) >> 24); };
  K[OPCODES.JZ] = (c, i) => {
    if (c.peek() === 0) c.jmp((i.oa << 24) >> 24); else c.nxt();
  };
  K[OPCODES.RET] = (c) => { c.ret(c.pop()); c.stop(); };
  K[OPCODES.HALT] = (c) => c.stop();
  const handler = {};
  for (const [k, fn] of Object.entries(K)) handler[Number(k)] = fn;
  const r = RT.run(code, {
    handler, consts: [], mem: {}, mask: st(0) ^ 0x37, opShift: shift,
    entry: 0, limit: 20000,
  });
  return { ret: r.ret === undefined ? null : r.ret, r, locals };
}

/** 编译一段函数体源码并执行，返回 {got, compiled} */
function run(fnSrc, seedShift) {
  const ast = parse(fnSrc, { sourceType: 'script' });
  const fn = ast.program.body[0];
  const shift = seedShift || 0;
  const out = compileNested(fn.body.body, shift, 500);
  if (!out) return { got: null, compiled: false };
  const { ret, r } = execute(out.code, shift, out.slots);
  return { got: ret, compiled: true, ok: r.ok, steps: r.steps, insns: out.insnCount, slots: out.slots };
}

/**
 * 原始 JS 的真值（用 node 跑，作为基准）。
 *
 * 必须调用函数并把结果打出来：`function f(){…}` 光定义不调用，stdout 是空的。
 * 首版直接把函数源码丢给 node，得到的是空串，于是"与原生 JS 一致"这条
 * 断言永远失败，而报错信息里期望值显示成空白，看不出是基准取错。
 */
function baseline(fnSrc) {
  // 不做字符串手术 —— 首版把 `function f(` 替换成 `var __r = (function f(`，
  // 结果少了参数列表的右括号，生成的脚本本身语法就不合法，基准永远拿不到值。
  // 正确做法：原样保留函数声明，追加一行调用。
  const m = /^function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(fnSrc);
  const wrapped = fnSrc + '\nprocess.stdout.write(String(' + (m ? m[1] : 'f') + '()));\n';
  // 兜住执行失败：基准拿不到就返回可辨识的标记，让断言去比而不是抛错。
  try {
    return runNode(wrapped, 'nested-base.js').trim();
  } catch (e) {
    return '<基准失败>';
  }
}

section('编译器：端到端结果正确');
{
  const CASES = [
    ['常量返回', 'function f(){return 42;}', '42'],
    ['加法', 'function f(){var a=7;var b=5;return a+b;}', '12'],
    ['减法', 'function f(){return 20-8;}', '12'],
    ['乘法', 'function f(){var a=6;var b=7;return a*b;}', '42'],
    // 除法与取余不在这里：内核按 |0 走，见 MUST_REFUSE 的说明。
    ['字面量算术（无除法）', 'function f(){var a=7;var b=5;return a*b-b+1;}', '31'],
    ['字面量折叠加法', 'function f(){return 20+22;}', '42'],
    ['位与', 'function f(){var a=12;var b=10;return a&b;}', String(12 & 10)],
    ['位或', 'function f(){var a=12;var b=3;return a|b;}', String(12 | 3)],
    ['位异或', 'function f(){var a=12;var b=10;return a^b;}', String(12 ^ 10)],
    ['左移', 'function f(){var a=3;var b=4;return a<<b;}', String(3 << 4)],
    ['右移', 'function f(){var a=48;var b=2;return a>>b;}', String(48 >> 2)],
    ['一元负号', 'function f(){var a=5;return -a;}', '-5'],
    ['字面量取负', 'function f(){return -7;}', '-7'],
    ['按位非', 'function f(){var a=5;return ~a;}', String(~5)],
    ['小于', 'function f(){var a=3;var b=5;return a<b;}', '1'],
    ['大于等于', 'function f(){var a=5;var b=5;return a>=b;}', '1'],
    ['严格相等', 'function f(){var a=4;var b=4;return a===b;}', '1'],
    // 注意：内核的比较指令产出 0/1，**不是** JS 的 true/false。产物侧必须
    // 用 !! 之类的表达式还原成布尔，否则 `return a<b` 会变成返回 1，
    // 任何把它当布尔用的地方（if 条件、&& ）都还对，但严格相等/=== 的
    // 调用方会看到 1 而不是 true。这条断言就是把该差异钉在明处。
    ['逻辑非', 'function f(){var a=0;return !a;}', '1'],
    ['累加循环', 'function f(){var s=0;for(var i=1;i<=5;i++){s=s+i;}return s;}', '15'],
    ['多级同层加法', 'function f(){var a=17;var b=5;return a*b+a+b;}', '107'],
    ['循环内乘加', 'function f(){var s=0;for(var i=1;i<=10;i++){s=s+i*2;}return s;}', '110'],
    ['复合赋值 +=', 'function f(){var a=1;a+=2;return a;}', '3'],
    // 两侧都是已标记的整数槽，+ 走 ADD 是安全的。这类"看起来像字符串拼接"
    // 但两侧类型可证的组合必须放行 —— 首版因为闸门太紧把它们全退让了，
    // 结果最常见的整数加法反而编不出来。
    ['两整数槽相加', 'function f(){var a=1;var b=2;return a+b;}', '3'],
    ['while 循环', 'function f(){var s=0;var i=1;while(i<=4){s=s+i;i=i+1;}return s;}', '10'],
    ['if 单分支', 'function f(){var a=1;if(a){a=a+41;}return a;}', '42'],
    ['if 双分支', 'function f(){var a=1;if(a){a=42;}else{a=0;}return a;}', '42'],
    ['if 假走 else', 'function f(){var a=0;if(a){a=42;}else{a=7;}return a;}', '7'],
    ['嵌套算术', 'function f(){var a=2;var b=3;return (a+b)*4-2;}', '18'],
  ];
  let pass = 0;
  const fails = [];
  for (const [name, src, want] of CASES) {
    const got = run(src);
    if (got.got === null && !got.compiled) { fails.push(name + '(未编译)'); continue; }
    const s = String(got.got);
    if (s === want) pass++;
    else fails.push(name + ': 得 ' + s + ' 期望 ' + want);
  }
  ok(fails.length === 0, pass + '/' + CASES.length + ' 个用例结果与原生 JS 一致',
    fails.slice(0, 4).join('; '));
  // 再单独钉一条"逐例明细"：上面那条命中即失败，只报前 4 个。
  // 这里把每个用例各自记一条，失败时能精确定位到是哪一个算式、得多少、
  // 期望多少 —— 编译器出错时通常是"某类算式全错"，集中看比逐个试快得多。
  for (const [name, src, want] of CASES) {
    const got = run(src);
    ok(String(got.got) === want,
      '[明细] ' + name + ' = ' + want,
      got.compiled ? ('实得 ' + got.got) : '未编译（退让）');
  }
}

section('编译器：与原生 JS 逐例比对（不预设期望值）');
{
  // 上面那张表我手写了期望值，可能自己写错。这里让 node 跑真值来对，
  // 免得"期望值写错 → 编译器和测试一起错"这种假绿。
  const SRC = [
    'function f(){var s=0;for(var i=1;i<=10;i++){s=s+i*2;}return s;}',
    'function f(){var a=17;var b=5;return a*b+a+b;}',
    'function f(){var x=0;var i=0;while(i<5){if(i<3){x=x+i*2;}i=i+1;}return x;}',
  ];
  let bad = '';
  let n = 0;
  for (const src of SRC) {
    const got = run(src);
    const want = baseline(src);
    n++;
    if (String(got.got) !== want) bad += src.slice(20, 46) + '… 得 ' + got.got + ' 期望 ' + want + '; ';
  }
  ok(bad === '', n + ' 个用例与 node 实跑结果逐位一致', bad);
}

section('编译器：操作码变换不改变语义');
{
  const SRC = 'function f(){var s=0;for(var i=1;i<=5;i++){s=s+i;}return s;}';
  let bad = '';
  for (const shift of [0, 1, 3, 17, 127, 255]) {
    const got = run(SRC, shift);
    if (got.got !== 15) bad += 'shift=' + shift + ' 得 ' + got.got + '; ';
  }
  ok(bad === '', '六种 shift 下结果都是 15（变换是等价变换）', bad);
}

section('编译器：不支持的语法必须退让');
{
  // 关键：返回 null 而不是产出错代码。错代码会让产物算出错误的值，
  // 而且几乎无法归因——所以这一组比上面的正确性更重要。
  const MUST_REFUSE = [
    ['字符串字面量', 'function f(){return "hello";}'],
    ['自由变量（非局部）', 'function f(){return externalVar;}'],
    ['函数调用', 'function f(){var a=1;return helper(a);}'],
    ['let 声明', 'function f(){let a=1;return a;}'],
    ['break', 'function f(){for(var i=0;i<3;i++){break;}return 1;}'],
    ['continue', 'function f(){for(var i=0;i<3;i++){continue;}return 1;}'],
    ['对象字面量', 'function f(){var o={a:1};return o.a;}'],
    ['数组字面量', 'function f(){var a=[1,2];return a[0];}'],
    ['成员访问', 'function f(){var o={a:1};return o.a;}'],
    ['字符串拼接（类型不可证）', 'function f(){var a=getStr();var b=getStr();return a+b;}'],
    // 无初值 → undefined，内核的 32 位槽装不下，必须退让而不是压 0
    ['无初值变量', 'function f(){var a;return a;}'],
    // 除法一律退让，不看结果是否"碰巧是整数"：编译器不做常量求值，
    // 10/5 在运行期是 2（对），但同样的指令形态遇到 5/2 就给 2 而不是 2.5。
    // 内核没有小数类型，所以凡是除法都不能编译 —— 这是内核的能力边界。
    ['除法（可能产生小数）', 'function f(){var a=10;var b=5;return a/b;}'],
    ['取余（除法同族）', 'function f(){var a=10;var b=3;return a%b;}'],
    ['嵌套除法', 'function f(){var a=3;var b=4;var c=5;return ((a+b)*c-a*b)/c;}'],
    ['小数参与', 'function f(){var a=1;var b=2;return (a+b)/2;}'],
  ];
  const accepted = [];
  for (const [name, src] of MUST_REFUSE) {
    const got = run(src);
    if (got.compiled) accepted.push(name + '→' + got.got);
  }
  ok(accepted.length === 0,
    '不支持的语法全部返回 null（退让给单层档，不产出错代码）',
    accepted.join('; '));
}

section('编译器：产出形状与不许硬编码操作码');
{
  // 操作码表重新分段过一次，那次把 7 处 emit.insn(0x13) 留成了旧值 ——
  // 0x13 恰好从 DUP 变成了 PUSH，于是所有 DUP 都在发 PUSH。
  // 表现是"循环与 if 全算成 0"，而编译照常成功、字节码长度不变。
  // 这里读源码文本断言：发射指令只能走 OPCODES.xxx，不能写字面量。
  const fs = await import('node:fs');
  const srcText = fs.readFileSync(
    new URL('../src/passes/vmNested.js', import.meta.url), 'utf8');
  const literalOps = [...srcText.matchAll(/emit\.insn\(\s*0x[0-9a-fA-F]+/g)]
    .map((m) => m[0]);
  ok(literalOps.length === 0,
    '发射指令不硬编码操作码字面量（全部走 OPCODES.xxx）',
    '发现 ' + literalOps.length + ' 处: ' + literalOps.slice(0, 3).join(' '));
  const literalPatch = [...srcText.matchAll(/emit\.patch\(\s*\w+\s*,\s*0x[0-9a-fA-F]+/g)];
  ok(literalPatch.length === 0, '回填指令同样不硬编码操作码',
    '发现 ' + literalPatch.length + ' 处');
}
{
  const src = 'function f(){var a=1;var b=2;return a+b;}';
  const got = run(src);
  ok(got.compiled, '基本用例能编译');
  ok(got.insns > 0, '字节码非空', '指令数=' + got.insns);
  ok(got.insns === got.insns && Number.isInteger(got.insns),
    '指令数是整数', String(got.insns));

  // 字节码长度必须是 6 的整数倍（定长）
  const ast = parse(src, { sourceType: 'script' });
  const out = compileNested(ast.program.body[0].body.body, 0, 500);
  ok(out.code.length % INSN_W === 0,
    '字节码长度是 6 的整数倍', 'len=' + out.code.length);

  // 槽位编号要与变量数一致
  const src2 = 'function f(){var a=1;var b=2;var c=3;return a+b+c;}';
  const out2 = compileNested(parse(src2, { sourceType: 'script' }).program.body[0].body.body, 0, 500);
  ok(out2.slots === 3, '三个局部变量 → 3 个槽', 'slots=' + out2.slots);

  // 槽数超限必须退让（oa 是单字节）
  const many = 'function f(){' + Array.from({ length: 300 }, (_, i) => 'var v' + i + '=' + i + ';').join('') + 'return v0;}';
  const out3 = compileNested(parse(many, { sourceType: 'script' }).program.body[0].body.body, 0, 500);
  ok(out3 === null, '局部变量超过 255 个时退让（槽号是单字节）');

  // 预算耗尽必须退让（防深递归卡住构建）
  const out4 = compileNested(ast.program.body[0].body.body, 0, 1);
  ok(out4 === null, '编译预算耗尽时退让（不无限递归）');
}

section('编译器：确定性与无副作用');
{
  const src = 'function f(){var a=1;return a+1;}';
  const ast = parse(src, { sourceType: 'script' });
  const a = compileNested(ast.program.body[0].body.body, 5, 500);
  const b = compileNested(ast.program.body[0].body.body, 5, 500);
  ok(a && b && a.code.length === b.code.length
    && a.code.every((v, i) => v === b.code[i]),
    '同输入两次编译逐字节相同（构建可复现）');

  // 编译不应改动 AST
  const ast2 = parse(src, { sourceType: 'script' });
  const before = JSON.stringify(ast2.program);
  compileNested(ast2.program.body[0].body.body, 3, 500);
  ok(JSON.stringify(ast2.program) === before, '编译过程不改写 AST');
}

if (process.argv[1] && process.argv[1].endsWith('vm-nested.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}