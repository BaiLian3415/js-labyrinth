/**
 * vmNested 端到端验证：这一档接进真实流水线之后，产物能跑且语义与原生一致。
 *
 * 跑法：node test/vm-nested-end2end.js
 *
 * ============================ 为什么这个文件必须存在 ============================
 *
 * test/vm-nested-inject.js 走的是「编译 → 注入 → 自研解析器 → node 真跑」，
 * **不经过混淆流水线**。而内层档真正的风险全在流水线那半截：
 *   · 注入源码在流水线**之前**进 AST，后面十几个 pass 会改它的名字与结构；
 *   · 字符串数组 / DCP 会动注入代码里的字面量；
 *   · 后续 pass 可能把注入的声明当死代码 DCE 掉。
 * 这一档的第一版就是这样漏的：buildCore 有两处赋值漏了 var，产出隐式全局，
 * 非严格模式下完全合法（内核单测全绿），进产物才炸 —— selfCheck 判「未绑定
 * 引用」把整个构建打断。所以必须有走流水线的测试。
 *
 * ============================ 判据怎么定（这里踩了两次坑）========================
 *
 * **不能用「产物里出现 VMC_run 字样」当判据。** mangle 会把这些名字改掉。
 * 首版测试正是这么写的，于是它在 mangle 关时绿、mangle 开时"失败"，
 * 把一个误判结论写成了断言。
 *
 * **也不能在默认配置下搜明文标记。** 默认 shell:true 会把整个载荷 base64 包
 * 起来再 eval，源码里搜不到任何内核特征 —— 我据此误判过「内层档从未触发」，
 * 实际上它工作正常。第二版判据换成 AST 结构签名，与改名和壳都无关。
 *
 * 结构判据那一组仍然显式关掉 shell：AST 结构在壳打开时也是 base64，
 * 拿不到就无从判断。**语义判据则两种都测**（壳开 / 壳关），因为壳可能
 * 掩盖别的错误，不能因为"要搜明文"就跳过它。
 */
import parserMod from '../src/ast/parser.js';
import obfuscateMod from '../src/obfuscate.js';
import { ok, report, section, cleanTmp, runNode } from './_harness.js';

const { obfuscate, resolveOptions } = obfuscateMod;
const { parse } = parserMod;

/** 真实配置：mangle / selfCheck / stringArray / 控制流 / 壳全部保持默认开启 */
const REAL = {
  vmProtection: true,
  vmNested: true,
  vmThreshold: 1,
  vmNestedBudget: 400,
};

/**
 * 内层核心的形状签名：**同一个对象上的 8 条以上「属性 = function」赋值**。
 *
 * 内核把栈、槽、值表、取指都挂在一个上下文对象上，形如
 *   ctx.push=function(...){...}; ctx.pop=function(...){...}; ctx.peek=...
 * 一连十几条。外层 VM 的分发循环不是这个形状（循环 + switch/if 链），
 * 用户原函数也不是。所以它与改名无关。
 *
 * 为什么不拿「函数体语句数 ≥ 30」当判据：外层 VM 的 handler 循环同样有几十条
 * 语句，那个判据在内层档**没生效**时也照样满足 —— 首版就栽在这里，
 * 把 tryNested 强制成不触发，测试依然全绿。
 */
function innerCoreShape(code) {
  let best = 0;
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if ((n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression')
        && n.body && Array.isArray(n.body.body)) {
      // 按"对象名"归类：数每个对象上有多少条 `obj.prop = function` 赋值
      const byObj = new Map();
      for (const st of n.body.body) {
        if (!st || st.type !== 'ExpressionStatement') continue;
        const e = st.expression;
        if (!e || e.type !== 'AssignmentExpression') continue;
        const L = e.left;
        if (!L || L.type !== 'MemberExpression' || L.computed) continue;
        if (!L.object || L.object.type !== 'Identifier') continue;
        if (!e.right || e.right.type !== 'FunctionExpression') continue;
        byObj.set(L.object.name, (byObj.get(L.object.name) || 0) + 1);
      }
      for (const c of byObj.values()) if (c > best) best = c;
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'range') continue;
      walk(n[k]);
    }
  };
  walk(parse(code, { sourceType: 'script' }).program);
  return best;
}

/**
 * 原生与产物各跑一次，比对输出。
 *
 * 原生值**先算且一定要算**：早先版本在构建抛错时提前返回，r.native 是 undefined，
 * 于是失败信息变成「期望 undefined」——断言抓到了问题，诊断却指不出方向。
 */
function bothOutputs(userCode, opts) {
  const native = runNode(userCode, 'vn-native.js');
  let obf;
  try {
    obf = obfuscate(userCode, resolveOptions(opts)).code;
  } catch (e) {
    return { native, buildError: String(e.message).split('\n')[0].slice(0, 70) };
  }
  let out;
  try {
    out = runNode(obf, 'vn-obf.js');
  } catch (e) {
    return { native, obf, runError: e.killed ? '超时' : String(e.message).split('\n')[0].slice(0, 70) };
  }
  return { native, out, obf };
}

/** 把一次比对压成一条可累加的结果 */
function compare(src, opts) {
  const r = bothOutputs(src, opts);
  const got = r.buildError ? ('构建失败: ' + r.buildError)
    : r.runError ? ('运行失败: ' + r.runError) : r.out;
  return { ok: got === r.native, got, native: r.native, obf: r.obf, r };
}

function bulk(title, cases, opts) {
  let pass = 0;
  const fails = [];
  for (const [name, src] of cases) {
    const c = compare(src, opts);
    if (c.ok) pass++;
    else fails.push(name + ': 得 ' + JSON.stringify(c.got) + ' 期望 ' + JSON.stringify(c.native));
  }
  ok(fails.length === 0, title + '（' + pass + '/' + cases.length + '）', fails.slice(0, 3).join('; '));
  return fails.length === 0;
}

section('vmNested：真实配置下的产物');
{
  const src = 'function add(a,b){var s=0;var x=a;var y=b;s=x+y;return s;}'
    + 'console.log("R="+add(3,5));';
  const r = bothOutputs(src, REAL);

  ok(!r.buildError, '开启 vmNested 不打断构建（selfCheck / mangle 全开）', r.buildError || '');
  ok(!r.runError, '产物能跑完', r.runError || '');
  if (!r.buildError && !r.runError) {
    ok(r.out === r.native, '产物输出与原生逐字节一致',
      '原生=' + JSON.stringify(r.native) + ' 产物=' + JSON.stringify(r.out));
    ok(r.out.indexOf('R=8') !== -1, '算术结果正确（3+5=8）', JSON.stringify(r.out));
  }

  // 结构判据要关掉 shell：壳把载荷 base64 起来，AST 里根本看不到内核
  const noshell = bothOutputs(src, { ...REAL, shell: false });
  if (!noshell.buildError) {
    const shape = innerCoreShape(noshell.obf);
    ok(shape >= 8, '产物里有内层核心的形状（同一对象上 8+ 条 obj.prop=function）',
      '实测最大计数 ' + shape);
  } else {
    ok(false, '关掉壳后仍能构建', noshell.buildError);
  }
}

section('vmNested：内层档覆盖到的函数');
{
  // 期望值一律用 node 实跑，不手写。手写期望值在本项目已经造出两次假 bug。
  const CASES = [
    ['单形参', 'function f(a){return a*3+1;}console.log("R="+f(7));'],
    ['双形参', 'function f(a,b){return a+b+a*b;}console.log("R="+f(3,5));'],
    ['形参与 var 混用', 'function f(a,b){var s=a+b;var t=s*2;return t-s;}console.log("R="+f(4,9));'],
    ['形参驱动循环', 'function f(n){var s=0;for(var i=1;i<=n;i++){s=s+i;}return s;}console.log("R="+f(10));'],
    ['形参驱动条件', 'function f(a){if(a){return a*2;}else{return a*3;}}console.log("R="+f(5));'],
    ['位运算', 'function f(a,b){return (a&b)+(a|b)+(a^b)+(a<<1);}console.log("R="+f(12,10));'],
    ['嵌套循环', 'function f(n){var s=0;for(var i=0;i<n;i++){for(var j=0;j<n;j++){s=s+i*j;}}return s;}'
      + 'console.log("R="+f(4));'],
    ['零与负形参', 'function f(a,b){return a-b;}console.log("R="+f(0,-9));'],
  ];
  bulk('个用例在真实配置（壳开）下与原生一致', CASES, REAL);
  bulk('个用例在真实配置（壳关）下与原生一致', CASES, { ...REAL, shell: false });
}

section('vmNested：编不了时必须退让（不能产出半成品）');
{
  // 内层编译器只吃算术与局部变量。含数组下标 / 成员访问 / 除法 / 递归的函数
  // 编不了，此时必须**原样退给外层单层档**，而不是注入一份残缺字节码。
  //
  // 这条最危险的失败模式是"产物能跑、值是错的"：编不出来的函数如果被硬套上，
  // 它照样返回某个数，只是那个数与原生无关。所以这里逐个比对数值。
  const CASES = [
    ['数组下标', 'function f(a){return a[0]+a[1];}console.log("R="+f([3,4]));'],
    ['成员访问', 'function f(o){return o.x+o.y;}console.log("R="+f({x:3,y:4}));'],
    ['字符串拼接', 'function f(a){return a+"x";}console.log("R="+f("n="));'],
    ['调用同文件函数', 'function g(x){return x+1;}function f(a){return g(a);}console.log("R="+f(41));'],
    ['除法', 'function f(a,b){return a/b;}console.log("R="+f(28,5));'],
    ['递归', 'function f(n){if(n<2){return n;}return f(n-1)+f(n-2);}console.log("R="+f(15));'],
    ['闭包', 'function mk(){var n=0;return function(){n=n+1;return n;};}'
      + 'var c=mk();c();c();console.log("R="+c());'],
    ['浮点', 'function f(a,b){var s=0;for(var i=0;i<b;i++){s=s+a/2;}return s;}console.log("R="+f(7,3));'],
  ];
  bulk('个内层编不了的函数正确退让给外层档（壳开）', CASES, REAL);
  bulk('个内层编不了的函数正确退让给外层档（壳关）', CASES, { ...REAL, shell: false });
}

section('vmNested：关闭时行为不变');
{
  const src = 'function add(a,b){var s=0;var x=a;var y=b;s=x+y;return s;}'
    + 'console.log("R="+add(3,5));';
  for (const [label, opts] of [['壳开', REAL], ['壳关', { ...REAL, shell: false }]]) {
    const r = bothOutputs(src, { ...opts, vmNested: false });
    ok(!r.buildError && !r.runError && r.out === r.native,
      'vmNested=false 时（' + label + '）构建正常且输出与原生一致',
      r.buildError || r.runError || JSON.stringify(r.out));
  }
  // 关掉时产物里不该有内层核心的形状
  const off = bothOutputs(src, { ...REAL, shell: false, vmNested: false });
  if (!off.buildError) {
    ok(innerCoreShape(off.obf) < 8, '关闭时产物里没有内层核心形状',
      '实测 ' + innerCoreShape(off.obf));
  }
}

if (process.argv[1] && process.argv[1].endsWith('vm-nested-end2end.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}
