#!/usr/bin/env node
/**
 * 压缩能力：AST 简化、无用声明消除、命名策略、属性名重命名与其他杂项。
 *
 *   node test/minify.js
 *
 * 整跑全部用例：npm test（即 node test/selftest.js）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, cleanTmp, counters, ok, report, runNode, section, stripComments, stripLiterals, throws } from './_harness.js';
import obfuscateMod from '../src/obfuscate.js';
import plan from '../src/plan.js';
import optionsMeta from '../src/options-meta.js';
import platform from '../src/platform.js';
import * as naming from '../src/utils/naming.js';
import hostLimits from '../src/host-limits.js';
import i18n from '../src/i18n.js';
import secret from '../src/license-secret.js';

const { obfuscate } = obfuscateMod;
section('AST 简化（simplify：常量折叠 / 死代码 / 声明合并）');
{
  // 三组样例：① 数值/字符串/一元折叠 + if(false) 死代码 + var 合并；② 位运算/
  // typeof/逻辑/条件/字符串比较/nullish 折叠；③ 除零/NaN 这类必须保守跳过。
  const simCases = [
    [`function calc(n) {
  var base = 1 + 2 * 3;
  var msg = 'a' + 'b' + n;
  var flag = !0;
  if (false) { base = 999; }
  var sum = 0;
  for (var i = 0; i < 3; i++) { sum += i; }
  var d1 = 1; var d2 = 2;
  return [base, msg, flag, sum, d1, d2].join(',');
}
process.stdout.write(calc('X') + '\\n');`, '7,abX,true,3,1,2\n'],
    [`var r = [];
r.push((5 & 3) + (1 << 4));
r.push(typeof 5);
r.push((true && 'yes'));
r.push((false ? 'a' : 'b'));
r.push(('abc' < 'abd'));
r.push((10 === 10));
r.push((null ?? 'fallback'));
process.stdout.write(r.join('|') + '\\n');`, '17|number|yes|b|true|true|fallback\n'],
    [`var a = 1 / 0;
var b = 0 / 0;
var c = 'x' + (2 + 3);
process.stdout.write(String(a) + '|' + String(b) + '|' + c + '\\n');`, 'Infinity|NaN|x5\n'],
  ];

  // 形态：开启时折叠/死代码/声明合并均生效；关闭时 pass 不出现且产物不变
  const rSimOn = obfuscate(simCases[0][0], { preset: 'low', shell: false, simplify: true, seed: 1 });
  const rSimOff = obfuscate(simCases[0][0], { preset: 'low', shell: false, simplify: false, seed: 1 });
  const stSim = rSimOn.stats.find((s) => s.pass === 'simplify');
  ok(stSim && stSim.result && stSim.result.folded > 0 && stSim.result.removed > 0
    && stSim.result.merged > 0,
    'simplify 开启时折叠/死代码/声明合并均生效', JSON.stringify(stSim && stSim.result));
  ok(!rSimOff.stats.some((s) => s.pass === 'simplify'), 'simplify 关闭时 pass 不出现');
  ok(rSimOn.code !== rSimOff.code, 'simplify 开启确实改动了产物');

  // 语义等价：三组样例开/关输出一致（含除零/NaN 这类被保守跳过的陷阱）
  let simBad = '';
  for (let i = 0; i < simCases.length && !simBad; i++) {
    const [src, want] = simCases[i];
    for (const flag of [false, true]) {
      const code = obfuscate(src, { preset: 'low', shell: false, simplify: flag, seed: 1 }).code;
      let got;
      try { got = runNode(code, 'sim-' + i + '-' + flag); } catch (e) { got = 'THREW'; }
      if (got !== want) { simBad = '样例' + i + ' simplify=' + flag + ' → ' + got.slice(0, 40); break; }
    }
  }
  ok(simBad === '', '三组样例 simplify 开/关语义一致（除零/NaN 保守跳过）', simBad);

  // 组合：high 预设 + simplify 全链路语义不变（2 seed）
  {
    let comboBad = '';
    for (let seed = 1; seed <= 2 && !comboBad; seed++) {
      for (const flag of [false, true]) {
        const code = obfuscate(simCases[0][0], { preset: 'high', shell: false, simplify: flag, seed }).code;
        let got;
        try { got = runNode(code, 'sim-combo-' + seed + '-' + flag); } catch (e) { got = 'THREW'; }
        if (got !== simCases[0][1]) { comboBad = 'seed=' + seed + ' simplify=' + flag + ' → ' + got.slice(0, 40); break; }
      }
    }
    ok(comboBad === '', 'high 预设 + simplify 全链路语义不变', comboBad);
  }

  // let/const 相邻合并（2026-10-11）：原来只合 var。合并只发生在同一体数组内
  // 相邻同 kind 声明之间（中途无语句、无跨作用域），初始化顺序不变，恒等；
  // var 接 let 这类跨 kind 一律不动（TDZ 语义不同）。simplify 跑在一切机器代码
  // 注入之前，所以 merged 计数只反映用户代码，可断精确值。旧码两个用例的计数
  // 是 0 与 1，新码是 1 与 3。
  {
    const letSrc = 'function f(n){ let a = 1;\n let b = 2;\n return a + b + n; }\n'
      + 'process.stdout.write(f(10) + "\\n");';
    const rLet = obfuscate(letSrc, { preset: 'low', shell: false, simplify: true, seed: 1 });
    const stLet = rLet.stats.find((s) => s.pass === 'simplify');
    ok(stLet && stLet.result && stLet.result.merged === 1, '相邻 let 合并（旧码此处为 0）',
      JSON.stringify(stLet && stLet.result));
    let gotLet = 'THREW';
    try { gotLet = runNode(rLet.code, 'sim-let.js').trim(); } catch (e) { gotLet = 'THREW'; }
    ok(gotLet === '13', 'let 合并后语义不变', gotLet);

    const mixSrc = 'function g(n){ var c = 1;\n var d = 2;\n let a = 3;\n let b = 4;\n'
      + 'const e = 5;\n const k = 6;\n return [c, d, a, b, e, k, n].join(","); }\n'
      + 'process.stdout.write(g(0) + "\\n");';
    const rMix = obfuscate(mixSrc, { preset: 'low', shell: false, simplify: true, seed: 1 });
    const stMix = rMix.stats.find((s) => s.pass === 'simplify');
    ok(stMix && stMix.result && stMix.result.merged === 3, 'var/let/const 各合各的（旧码此处为 1）',
      JSON.stringify(stMix && stMix.result));
    let gotMix = 'THREW';
    try { gotMix = runNode(rMix.code, 'sim-mix.js').trim(); } catch (e) { gotMix = 'THREW'; }
    ok(gotMix === '1,2,3,4,5,6,0', '跨 kind 不互合、语义不变', gotMix);
  }

  // 门控：free 锁死、plus 放行；默认关闭
  ok(plan.violations({ simplify: true }, 'free').length === 1, 'free 档 simplify 被闸门锁死');
  ok(plan.violations({ simplify: false }, 'free').length === 0, 'free 档关闭放行');
  ok(plan.violations({ simplify: true }, 'plus').length === 0, 'plus 档 simplify 放行');
  ok(obfuscateMod.DEFAULTS.simplify === false, 'simplify 默认关闭');

  // 可复现：固定 seed 逐字节一致
  ok(obfuscate(simCases[0][0], { preset: 'high', shell: false, simplify: true, seed: 97 }).code ===
    obfuscate(simCases[0][0], { preset: 'high', shell: false, simplify: true, seed: 97 }).code,
    'simplify 固定 seed 可复现');

  // 死代码闸门放宽 + 不可达语句清除（2026-10-12）。
  //
  // 原来的闸门是 `test.type === 'BooleanLiteral'`，于是只有 if(false)/while(false)
  // 能删；`if (0)`、`if ('')`、`if (null)`、`if (void 0)`、`while (0)`、
  // `do..while(0)`、`for(;false;)` 全部漏掉——真实代码里这些写法一点也不比
  // if(false) 少。另外没有任何"return 之后的语句"处理。
  // 实测：下面这组样例老码 removed=2，新码 removed=12。
  {
    const src = [
      'var calls = 0;',
      'function bump(){ calls++; return 1; }',
      'function f1(){ var r = typeof x; return r; var x = 1; }',
      'function f2(){ return 1; var {a} = {}; }',
      'function f4(){ var r = typeof later; return r; function later(){ return 1; } }',
      'function f5(){ var n = 0; do { n += 2; } while (0); return n; }',
      'function f6(){ var s = 0; for (var i = 0; false; i++) { s += i; } return s + "|" + typeof i; }',
      'function f7(){ var s = 0; for (let j = 0; false; j++) { s += j; } return s; }',
      'function f8(){ var o = {}; o.k = 1; for (o.k; false; ) { } return o.k; }',
      'function f9(){ if (void bump()) { calls += 100; } return calls; }',
      'function f10(){ var undefined = 5; var out = 0; if (undefined) { out = 1; } return out; }',
      'function f11(x){ var out = ""; switch (x) { case 1: out += "a"; break; out += "dead"; case 2: out += "b"; return out; } return out; }',
      'function f13(){ var out = 0; if (!0) { out = 1; } if (``) { out = 2; } if (`x`) { out += 10; } if (-0) { out = 3; } if (0.0) { out = 4; } return out; }',
      'function f14(){ var out = 0; if (0) { out = 1; } else { out = 2; } if (1) { out += 10; } else { out = 99; } return out; }',
      'function f15(){ try { return 7; } finally { } }',
      'var res = [f1(), f2(), f4(), f5(), f6(), f7(), f8(), f9(), f10(), f11(1), f11(2), f13(), f14(), f15()].join("~");',
      'process.stdout.write(res);',
    ].join('\n');
    const want = runNode(src, 'dce-want.js').trim();

    const plain = { preset: 'low', shell: false, simplify: true, seed: 1, reservedNames: ['^mk[0-9]$'] };

    // 判别 1：七类"静态可判假"的写法，调用点必须全部消失。
    // 标记函数名走 reservedNames 保住（mangle 会改名，靠名字计数就废了）。
    const marks = ['mk1', 'mk2', 'mk3', 'mk4', 'mk5', 'mk6', 'mk7'];
    const deadSrc = [
      'function mk1(){} function mk2(){} function mk3(){} function mk4(){} function mk5(){}',
      'function mk6(){} function mk7(){}',
      'function pack(a, b) {',
      '  if (false) { mk1(); }',
      '  if (0) { mk2(); }',
      "  if ('') { mk3(); }",
      '  if (null) { mk4(); }',
      '  if (void 0) { mk5(); }',
      '  while (0) { mk6(); }',
      '  for (; false; ) { mk7(); }',
      '  return a + b;',
      '}',
      'process.stdout.write(String(pack(2, 3)));',
    ].join('\n');
    const rDead = obfuscate(deadSrc, { ...plain, controlFlowFlattening: false, deadCodeInjection: false, stringArray: false, objectKeyEncoding: false, mangle: false });
    const callCount = (code, n) => (code.match(new RegExp('(?<![A-Za-z0-9_$])' + n + '\\s*\\(', 'g')) || []).length;
    const stillAlive = marks.filter((n) => callCount(rDead.code, n) > 1);
    ok(stillAlive.length === 0,
      '七类静态可判假的写法全部删掉（旧码只删得掉 if(false)）',
      '仍留调用点：' + (stillAlive.join(',') || '-') + '；removed=' +
      ((rDead.stats.find((s) => s.pass === 'simplify') || {}).result || {}).removed);

    // 判别 2：return 之后的语句必须清掉（老码完全没有这一步）
    const tailSrc = 'function g(){ return 1; h1(); var t = 2; if (t) { h2(); } }\n'
      + 'function h1(){}\nfunction h2(){}\nprocess.stdout.write(String(g()));';
    const rTail = obfuscate(tailSrc, { ...plain, reservedNames: ['^h[12]$'] });
    const tailAlive = ['h1', 'h2'].filter((n) => callCount(rTail.code, n) > 1);
    ok(tailAlive.length === 0, 'return 之后的语句被清除（旧码完全不做）', '仍留：' + tailAlive.join(','));

    // 守卫：15 组语义逐位不变。里面每一条都对应一个"删错了就出事"的边界：
    //   f1  var 提升（删掉声明 → typeof x 从 undefined 变 ReferenceError）
    //   f2  不可达代码里的解构 var（摘成 `var {a}` 是语法错误）
    //   f4  return 之后的函数声明（提升，删掉 → typeof later 变 undefined）
    //   f5  do-while(0) 体照跑一次
    //   f6  for(;false;) 的 var init 要留（提升 + 初始化器要跑）
    //   f7  for(;false;) 的 let init 可整条删（循环作用域随之消失）
    //   f8  for(;false;) 的表达式 init 要留（赋值副作用）
    //   f9  `void f()` 不判假——调用本身有副作用，判假就等于把它吃掉
    //   f10 被遮蔽的 undefined 不判假（`var undefined = 5` 是合法代码）
    //   f11 switch case 穿透不能被误删
    let semBad = '';
    for (const preset of ['low', 'medium', 'high', 'max']) {
      for (const seed of [1, 2, 3]) {
        let got;
        try {
          const code = obfuscate(src, {
            preset, seed, shell: false, simplify: true, integrityCheck: false,
            controlFlowFlattening: false, deadCodeInjection: false, opaquePredicates: false,
            selfDefending: false, debugProtection: false, sentinelRate: 0,
          }).code;
          got = runNode(code, 'dce-' + preset + '-' + seed + '.js').trim();
        } catch (e) { got = 'THREW'; }
        if (got !== want) { semBad = preset + '/' + seed + ' → ' + got.slice(0, 60); break; }
      }
      if (semBad) break;
    }
    ok(semBad === '', '放宽闸门 + 不可达清除后语义逐位不变（15 组）', semBad || '');
    ok(want === 'undefined~1~function~2~0|number~0~1~1~1~a~b~11~12~7',
      '样例本身的期望值（防止 want 取错导致整组断言空转）', want);
  }
}

section('AST 简化：无用声明消除（DCE）');
{
  // 单元口径：直接 parse → simplify → generate，看得到名字，边界才说得清
  const parser = (await import('../src/ast/parser.js')).default;
  const generate = (await import('../src/ast/generator.js')).default;
  const trav = (await import('../src/ast/traverse.js')).default;
  const simp = (await import('../src/passes/simplify.js')).default;
  const runSimpl = (src) => {
    const ast = parser.parse(src, { sourceType: 'unambiguous', allowReturnOutsideFunction: false, plugins: ['topLevelAwait'] });
    const stat = simp(ast, { simplify: true }, { traverse: trav });
    return { out: generate(ast, { compact: true, escapeNonAscii: false }).code, stat };
  };

  const mod = runSimpl('export const K = 1;\nfunction priv() { return 2; }\nconst unused = { a: 1 };\n'
    + 'const used = 3;\nexport function api() { return used; }');
  ok(!/\bpriv\b/.test(mod.out) && !/\bunused\b/.test(mod.out), 'DCE：模块顶层未用函数/变量删除', mod.out);
  ok(/\bapi\b/.test(mod.out) && /\bused\b/.test(mod.out) && /\bK\b/.test(mod.out),
    'DCE：导出面与在用声明保留', mod.out);

  const script = runSimpl('var topUnused = 1;\nfunction outer() { var innerUnused = 2; function innerFn() { return 3; } return 4; }\n'
    + 'console.log(outer());');
  ok(/\btopUnused\b/.test(script.out), 'DCE：脚本顶层全局属性保留', script.out);
  ok(!/\binnerUnused\b/.test(script.out) && !/\binnerFn\b/.test(script.out), 'DCE：函数内未用声明删除', script.out);

  const guarded = runSimpl('function f() { var keep = g(); return keep; }\nfunction g() { return 5; }\n'
    + 'function w() { var n = 1; n = 7; return n; }\nfunction h() { var folded = 1 + 2 * 3; return 9; }\n'
    + 'console.log(f() + w() + h());');
  ok(/\bkeep\b/.test(guarded.out), 'DCE：有副作用的初始化保留', guarded.out);
  ok(/\bn\b/.test(guarded.out), 'DCE：有写入的绑定保留', guarded.out);
  ok(!/\bfolded\b/.test(guarded.out), 'DCE：纯字面量初始化且无人读取的变量删除', guarded.out);

  const withSrc = runSimpl('function f(o) { with (o) { var x = 1; } return 1; }\nconsole.log(f({}));');
  ok(/\bx\b/.test(withSrc.out), 'DCE：出现 with 时整体跳过（绑定分析不可靠）', withSrc.out);

  // 端到端：产物仍可执行，且副作用不多不少
  {
    const src = 'var unusedTop = 1;\n'
      + 'function outer() { var unusedInner = 2; function innerUnused() { return 3; } return 4; }\n'
      + 'function keepsSideEffect() { var keep = bump(); return keep; }\n'
      + 'function bump() { globalThis.__dce = (globalThis.__dce || 0) + 1; return 5; }\n'
      + 'process.stdout.write("dce=" + outer() + keepsSideEffect() + globalThis.__dce + "\\n");';
    const want = runNode(src, 'dce-raw.js').trim();
    const code = obfuscate(src, { preset: 'low', shell: false, simplify: true, seed: 3 }).code;
    let got = 'THREW';
    try { got = runNode(code, 'dce-obf.js').trim(); } catch (e) { got = 'THREW'; }
    ok(got === want && want === 'dce=451', 'DCE 端到端语义不变（副作用不多不少）', got + ' ≠ ' + want);
  }

  // 直接 eval 守卫（2026-10-13）：eliminateUnused 原先只查 with 不查 eval，
  // 把 eval 字符串要用的声明删掉，原码 1|7 → 产物 ReferenceError（removed:1）。
  // eval 串是黑盒，绑定分析不可靠，只能整体跳过本函数。
  {
    const src = 'function f(){var hidden=7;eval("globalThis.__s=hidden");return 1;}\n'
      + 'process.stdout.write(String(f())+"|"+String(globalThis.__s));';
    const want = runNode(src, 'dce-evraw.js').trim();
    const r = obfuscate(src, { preset: 'low', shell: false, simplify: true, seed: 1,
      mangle: false, selfCheck: false, stringArray: false });
    const st = r.stats.find((s) => s.pass === 'simplify');
    ok(st && st.result && st.result.removed === 0, '含直接 eval 时 eliminateUnused 整体跳过（旧码 removed=1）',
      JSON.stringify(st && st.result));
    let got = 'THREW';
    try { got = runNode(r.code, 'dce-evobf.js').trim(); } catch (e) { got = 'THREW'; }
    ok(got === want && want === '1|7', '含直接 eval 时语义不变', got + ' ≠ ' + want);
  }

  // 未声明名的初始化器不判纯（2026-10-13）：pureInit(Identifier) 原先恒 true，
  // `var a = nope` 被删掉，原码抛 ReferenceError，产物打印 1 —— 一次本该发生的
  // 异常消失了。修完后声明保留：selfCheck 关掉时产物与原码抛同一个错；
  // 默认自检开启时构建被响亮拒绝（自检白名单只放真全局，未声明名不在内，
  // extraGlobals 是留给宿主全局的逃生口）。
  {
    const src = 'function f(){ var a = nopeNotDeclared; return 1; }\nprocess.stdout.write(String(f()));';
    const runThrow = (code, tag) => {
      try { runNode(code, tag); return 'NO-THROW'; }
      catch (e) { return /ReferenceError/.test(String((e && e.stderr) || e)) ? 'ReferenceError' : 'OTHER-THROW'; }
    };
    ok(runThrow(src, 'dce-undecl-raw.js') === 'ReferenceError', '未声明名样本原码抛 ReferenceError（基准）', '');
    const r = obfuscate(src, { preset: 'low', shell: false, simplify: true, seed: 1,
      mangle: false, selfCheck: false, stringArray: false });
    ok(runThrow(r.code, 'dce-undecl-obf.js') === 'ReferenceError',
      'selfCheck 关闭时产物抛同一个错（旧码打印 1）', '');
    let refused = '';
    try { obfuscate(src, { preset: 'low', shell: false, simplify: true, seed: 1 }); }
    catch (e) { refused = String(e.message).split('\n')[0]; }
    ok(/自检失败|self-check failed/i.test(refused), '默认自检响亮拒绝未声明名（不产出静默错的产物）', refused.slice(0, 60));
  }
}

section('命名策略（nameStyle）与动态 import');
{
  // 动态 import() 与 import.meta：解析、生成、运行三处都要通（此前缺 t.import builder）
  {
    const src = 'const HERE = import.meta.url;\n'
      + 'export async function load(p) { const m = await import(p); return m.default; }\n'
      + 'export function where() { return HERE.slice(0, 5); }\n'
      + 'const mod = await import("data:text/javascript,export default 41");\n'
      + 'process.stdout.write("dyn=" + (mod.default + 1) + " meta=" + where() + "\\n");';
    const want = runNode(src, 'import-raw.mjs').trim();
    ok(want.startsWith('dyn=42 meta=file:'), '动态 import / import.meta 原始可运行（基准）', want);
    const code = obfuscate(src, { preset: 'low', seed: 5 }).code;
    ok(code.includes('import(') && code.includes('import.meta'),
      '动态 import / import.meta 在产物里保留', code.slice(0, 80));
    let got = 'THREW';
    try { got = runNode(code, 'import-obf.mjs').trim(); } catch (e) { got = 'THREW'; }
    ok(got === want, '混淆后动态 import / import.meta 行为一致', got);
  }

  // Mangled / Mangled-shuffled：同输入体积接近、产物可执行、各自的可复现性符合约定
  const namey = 'function computeTotals(records) { var runningTotal = 0; var index = 0;\n'
    + '  while (index < records.length) { var currentRecord = records[index];\n'
    + '    runningTotal += currentRecord.weight * (currentRecord.count + 1); index++; }\n'
    + '  return runningTotal; }\n'
    + 'function describeResult(value) { var label = value > 100 ? "big" : "small"; return label + ":" + value; }\n'
    + 'process.stdout.write(describeResult(computeTotals([{ weight: 2, count: 3 }, { weight: 5, count: 4 }])) + "\\n");';
  {
    const want = runNode(namey, 'namestyle-raw.js').trim();
    const mangled = obfuscate(namey, { preset: 'low', shell: false, nameStyle: 'Mangled', seed: 9 });
    const shuffled = obfuscate(namey, { preset: 'low', shell: false, nameStyle: 'Mangled-shuffled', seed: 9 });
    ok(Math.abs(shuffled.code.length - mangled.code.length) < mangled.code.length * 0.1,
      '乱序档与规范档体积相当（只差字母表，名字长度一样）',
      mangled.code.length + ' → ' + shuffled.code.length);
    ok(!/computeTotals|describeResult|runningTotal/.test(shuffled.code), '乱序档把用户标识符全部换掉', '');
    let got = 'THREW';
    try { got = runNode(shuffled.code, 'namestyle-shuffled.js').trim(); } catch (e) { got = 'THREW'; }
    ok(got === want && want === 'small:33', '乱序档产物语义不变', got + ' ≠ ' + want);
    ok(obfuscate(namey, { preset: 'low', shell: false, nameStyle: 'Mangled-shuffled', seed: 9 }).code === shuffled.code,
      '乱序档同 seed 逐字节可复现');
  }

  // 未声明的全局引用不能被短名遮蔽（$ / _ 这类）
  {
    const src = 'globalThis.$ = 7; globalThis._ = 8;\n'
      + 'var alpha = $; var beta = _; var gamma = 1; var delta = 2;\n'
      + 'process.stdout.write("globals=" + (alpha + beta + gamma + delta) + "\\n");';
    const want = runNode(src, 'namestyle-globals-raw.js').trim();
    // $ / _ 是未声明的宿主全局（不是内建），所以显式进 extraGlobals 白名单
    const code = obfuscate(src, {
      preset: 'low', shell: false, nameStyle: 'Mangled', seed: 11, extraGlobals: ['$', '_'],
    }).code;
    let got = 'THREW';
    try { got = runNode(code, 'namestyle-globals.js').trim(); } catch (e) { got = 'THREW'; }
    ok(got === want && want === 'globals=18', '短名不遮蔽未声明的全局引用', got + ' ≠ ' + want);
  }

  // mangle 遇直接 eval / with 时污染域跳过（2026-10-13）。mangle 原先是全仓库
  // 唯一没有这两道判定的 pass，两类静默破坏实测 5/5 seed：
  //   eval：声明改名了、eval 串里的名字没改 → ReferenceError；
  //   with：with 体内的写点被跟着改名，写进局部变量 → 10|101 变成 11|100。
  // 修法：污染 with 节点与直接 eval 调用所在作用域的整条祖先链（影响沿链向上），
  // 域内绑定不改名。stats 用 skippedTainted 报告跳过数（旧码无此键，双向判别）。
  {
    const evalSrc = 'globalThis.seedv=5;function f(){var localv=10;eval(\'localv = localv + globalThis.seedv\');return localv;}\n'
      + 'process.stdout.write(String(f())+"|"+String(globalThis.localv));';
    const withSrc = 'var store={tally:1,hidden:100};function f(o){var hidden=10;with(o){hidden=hidden+1;}'
      + 'return String(hidden)+"|"+String(o.hidden);}\nprocess.stdout.write(f(store));';
    for (const [label, src, want] of [['直接eval', evalSrc, '15|undefined'], ['with', withSrc, '10|101']]) {
      ok(runNode(src, 'mangle-taint-raw-' + label + '.js').trim() === want, label + '样本原码基准', '');
      let bad = '';
      for (const preset of ['low', 'high']) {
        for (const seed of [1, 2]) {
          const r = obfuscate(src, { preset, seed, shell: false });
          const st = r.stats.find((s) => s.pass === 'mangle');
          if (!(st && st.result && st.result.skippedTainted > 0)) {
            bad = preset + '/' + seed + ' skippedTainted 未报（旧码无此键）：' + JSON.stringify(st && st.result);
            break;
          }
          let got = 'THREW';
          try { got = runNode(r.code, 'mangle-taint-' + label + '-' + preset + '-' + seed + '.js').trim(); }
          catch (e) { got = 'THREW'; }
          if (got !== want) { bad = preset + '/' + seed + ' → ' + got.slice(0, 50); break; }
        }
        if (bad) break;
      }
      ok(!bad, label + '污染域跳过且语义不变（low/high × 2 seed，旧码 5/5 全错）', bad);
    }
    // 间接 eval 不污染（(0,eval) 跑在全局作用域，看不到调用方局部量）：
    // 同样本 skippedTainted 必须为 0，防止守卫写宽把正常代码的改名全关掉。
    // 注意样本只能碰全局量——间接 eval 本来就看不到局部变量，不是守卫问题。
    {
      const src = 'globalThis.__base=10;function f(){var localv=3;(0,eval)(\'globalThis.__v=globalThis.__base+1\');return localv;}\n'
        + 'process.stdout.write(String(f())+"|"+String(globalThis.__v));';
      const r = obfuscate(src, { preset: 'low', seed: 1, shell: false });
      const st = r.stats.find((s) => s.pass === 'mangle');
      ok(st && st.result && st.result.skippedTainted === 0, '间接 eval 不触发污染跳过', JSON.stringify(st && st.result));
      let got = 'THREW';
      try { got = runNode(r.code, 'mangle-indirect.js').trim(); } catch (e) { got = 'THREW'; }
      ok(got === '3|11', '间接 eval 样本语义不变', got);
    }
  }

  // 四档的发名形状。为了能逐个检查发出来的名字长什么样，这里把除 mangle 之外的 pass
  // 全关掉：否则 stringArray 之类注入的声明名会混进来，那部分按设计是保持原样的
  // （ctx.rtNames / ctx.keepNames），不该算进改名结果。
  const NAMEONLY = {
    preset: 'low', shell: false, stringArray: false, controlFlowFlattening: false,
    logicalExpressions: false, conditionObfuscation: false, opaquePredicates: false,
    deadCodeInjection: false, functionWrapper: false, objectKeyEncoding: false,
    numberObfuscation: false, templateToConcat: false, selfCheck: false,
    stringSplitProbability: 0, bannerSkip: true,
  };
  const shapeSrc = 'var computeTotals = 0; var runningTotal = 1; var currentRecord = 2;\n'
    + 'var describeResult = 3;\n'
    + 'function collectAll(records) { var idx = 0; var acc = 0;\n'
    + '  while (idx < records.length) { acc = acc + records[idx] + runningTotal; idx = idx + 1; }\n'
    + '  return acc; }\n'
    + 'console.log(computeTotals + runningTotal + currentRecord + describeResult + collectAll([1, 2]));';
  // 刻意挑不可能是命名池产物的标识符：`out` 这种短词不行，词典档里有 output，
  // 子串匹配会把它误报成"原名残留"（实测确认：只有词典档会命中 output）
  const ORIG_NAMES = ['computeTotals', 'runningTotal', 'currentRecord', 'describeResult', 'collectAll', 'records', 'idx', 'acc'];
  const declNames = (code) => [...new Set(
    [...code.matchAll(/(?:var|let|const|function)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)].map((m) => m[1]),
  )];
  // 只数 mangle **自己发出的**名字，不数机械名。
  //
  // 产物里的声明名有三类：用户标识符（被 mangle 改名）、内核与外壳的机械名（RT
  // 原语、引导层、VM 桩……由 uniqueName 另行随机化）、以及函数参数。机械名不该算进
  // 改名结果——上面那段注释本来就写明了这个意图，但一直没真正排除掉：机械名以前很短
  // （i / k / o），恰好不匹配各档的形状正则，所以看不出来；2026-10-03 RT 内核局部名
  // 也随机化之后，机械名变成 4~9 位字母，既能撞上 Dictionary 的词名形状，也曾被
  // mangle 当成普通绑定改过名（于是 Hexadecimal 档一度数到 47 个，远超 8 个用户
  // 标识符）。两个档的计数因此都在靠巧合过关。
  //
  // 做法：同一 seed 下再构建一份 mangle:false 的，机械名逐构建相同（同一个种子），
  // 两份声明名一减，差集就是 mangle 引入的名字。
  const declsNoMangle = declNames(obfuscate(shapeSrc, { ...NAMEONLY, mangle: false, seed: 9 }).code);
  const mangleEmitted = (code) => declNames(code).filter((n) => !declsNoMangle.includes(n));
  // 界面选项表里查一项。显隐规则在元数据上，用的是 guiOptions() 那份拷贝，
  // 所以断言要查它而不是查 VALUE_OPTIONS 本身。
  const guiOpt = (key) => optionsMeta.guiOptions().find((o) => o.key === key) || null;
  // normalizeNameDict 已搬到 utils/naming.js（名池实现与 renameProperties 共用一份）
const normalizeNameDict = (await import('../src/utils/naming.js')).normalizeNameDict;
  {
    // Hexadecimal：字母 + 十六进制位，从 2 字符起步
    const want = runNode(shapeSrc, 'namestyle-shape-raw.js').trim();
    const hex = obfuscate(shapeSrc, { ...NAMEONLY, nameStyle: 'Hexadecimal', seed: 9 });
    const decls = declNames(hex.code);
    const emitted = mangleEmitted(hex.code);
    const hexShaped = emitted.filter((n) => /^[A-Za-z][0-9a-f]{1,3}$/.test(n));
    // shapeSrc 有 8 个用户标识符，其中 records 是函数参数、不在 declNames 的
    // 声明名正则覆盖范围内，所以声明名这一侧最多看到 7 个——阈值按 7 定，多一个都
    // 说明混进了机械名。
    ok(emitted.length === 7 && hexShaped.length === 7,
      'Hexadecimal 档发出的名字都是"字母+十六进制"形状',
      '发出 ' + emitted.length + ' 个，其中合规 ' + hexShaped.length + ' 个：' + hexShaped.join(' '));
    ok(hexShaped.every((n) => n.length >= 2), 'Hexadecimal 档不发 1 字符名（否则退回 Mangled 的序列感）', hexShaped.filter((n) => n.length < 2).join(' '));
    ok(!ORIG_NAMES.some((n) => hex.code.includes(n)), 'Hexadecimal 档把用户标识符全部换掉', ORIG_NAMES.filter((n) => hex.code.includes(n)).join(' '));
    let got = 'THREW';
    try { got = runNode(hex.code, 'namestyle-hex.js').trim(); } catch (e) { got = 'THREW'; }
    ok(got === want, 'Hexadecimal 档产物语义不变', got + ' ≠ ' + want);
    ok(obfuscate(shapeSrc, { ...NAMEONLY, nameStyle: 'Hexadecimal', seed: 9 }).code === hex.code, 'Hexadecimal 档同 seed 逐字节可复现');
    ok(obfuscate(shapeSrc, { ...NAMEONLY, nameStyle: 'Hexadecimal', seed: 10 }).code !== hex.code, 'Hexadecimal 档换 seed 换一套名字');
  }
  {
    // Dictionary：固定词表
    const want = runNode(shapeSrc, 'namestyle-shape-raw.js').trim();
    const dict = obfuscate(shapeSrc, { ...NAMEONLY, nameStyle: 'Dictionary', seed: 9 });
    const decls = declNames(dict.code);
    const emitted = mangleEmitted(dict.code);
    const words = emitted.filter((n) => /^[a-z]{3,8}[0-9]*$/.test(n));
    ok(emitted.length === 7 && words.length === 7, 'Dictionary 档发出的是可读词名',
      '发出 ' + emitted.length + ' 个，其中合规 ' + words.length + ' 个：' + words.join(' '));
    ok(!ORIG_NAMES.some((n) => dict.code.includes(n)), 'Dictionary 档把用户标识符全部换掉', ORIG_NAMES.filter((n) => dict.code.includes(n)).join(' '));
    let got = 'THREW';
    try { got = runNode(dict.code, 'namestyle-dict.js').trim(); } catch (e) { got = 'THREW'; }
    ok(got === want, 'Dictionary 档产物语义不变', got + ' ≠ ' + want);
    ok(obfuscate(shapeSrc, { ...NAMEONLY, nameStyle: 'Dictionary', seed: 9 }).code === dict.code, 'Dictionary 档同 seed 逐字节可复现');
    ok(obfuscate(shapeSrc, { ...NAMEONLY, nameStyle: 'Dictionary', seed: 10 }).code !== dict.code, 'Dictionary 档换 seed 换一套词');
  }
  {
    // Dictionary 池耗尽不退 _0x 随机名：走完一轮后加数字后缀继续发（word、word1…），
    // 形状永远是词表形。旧形态在 n*64（内置词表 4096）后交回调用方退回 _0x 随机名，
    // 后缀一出就是"词典档被用超了"的指纹。去上限不改变前 4096 个的发放序列。
    const pool = naming.createNamePool({ nameStyle: 'Dictionary' });
    const got = [];
    for (let i = 0; i < 5000; i++) {
      const it = pool.next();
      if (it.done) break;
      got.push(it.value);
    }
    ok(got.length === 5000, '词典池可发放 5000 个名而不枯竭（旧上限 4096）', '实得 ' + got.length);
    ok(new Set(got).size === got.length, '超量发放的名字仍互不重复');
    ok(got.every((n) => /^[a-z]{3,6}[0-9]*$/.test(n)), '超量发放的仍是词表形状（无 _0x 回落）',
      got.filter((n) => !/^[a-z]{3,6}[0-9]*$/.test(n)).slice(0, 5).join(' '));
    // 端到端：4400 个绑定（超 4096 上限）走完 mangle，尾部出现后缀 ≥64 的词名
    // （旧码只能发到后缀 63）；全部重命名点位语义正确（求和对拍）。
    const N = 4400, PER = 100;
    const parts = [];
    const chunks = [];
    for (let c = 0; c < N / PER; c++) {
      const vs = [];
      for (let i = 0; i < PER; i++) vs.push('v' + (c * PER + i));
      parts.push('var ' + vs.map((v, i) => v + '=' + (c * PER + i)).join(',') + ';');
      parts.push('var s' + c + '=' + vs.join('+') + ';');
      chunks.push('s' + c);
    }
    const bigSrc = parts.join('\n') + '\nprocess.stdout.write(String(' + chunks.join('+') + '));';
    const bigWant = runNode(bigSrc, 'dict-big-raw.js').trim();
    const big = obfuscate(bigSrc, { ...NAMEONLY, nameStyle: 'Dictionary', seed: 9 });
    // 前边界不可少：机器十六进制名（_0xaf2295 这类）的子串 `xaf2295` 形如"字母+数字"，
    // 无前边界会误伤（旧码实测 4 个误伤，恰好贴着阈值，极险）。后边界同理。
    const suffixed = big.code.match(/(?<![A-Za-z0-9_$])[a-z]{3,6}(6[4-9]|[7-9][0-9]|[0-9]{3,})(?![A-Za-z0-9_$])/g) || [];
    ok(new Set(suffixed).size >= 5, '超量构建出现后缀 ≥64 的词名（旧码上限 63）',
      '实得去重 ' + new Set(suffixed).size + ' 个：' + [...new Set(suffixed)].slice(0, 5).join(' '));
    let bigGot = 'THREW';
    try { bigGot = runNode(big.code, 'dict-big.js').trim(); } catch (e) { bigGot = 'THREW'; }
    ok(bigGot === bigWant && bigWant === '9677800', '超量改名后语义正确（4400 绑定求和）', bigGot + ' ≠ ' + bigWant);
    ok(obfuscate(bigSrc, { ...NAMEONLY, nameStyle: 'Dictionary', seed: 9 }).code === big.code,
      '超量构建同 seed 逐字节可复现');
  }
  {
    // Dictionary 的自定义词表。词表里的名字会直接写进产物，所以"过滤规则"和
    // "真的换池了"两件事都要钉住——只测前者会漏掉选项没接进 mangle 的情况。
    const DICTONLY = { ...NAMEONLY, nameStyle: 'Dictionary' };
    const custom = obfuscate(shapeSrc, { ...DICTONLY, nameDictionary: 'zebra,quokka,axolotl', seed: 9 });
    const mine = (code, ws) => ws.filter((w) => new RegExp('(?<![A-Za-z0-9_$])' + w + '[0-9]*(?![A-Za-z0-9_$])').test(code));
    const got = mine(custom.code, ['zebra', 'quokka', 'axolotl']);
    ok(got.length === 3, '自定义词表生效（产物里出现用户填的词）', got.join(' '));
    ok(mine(custom.code, ['value', 'index', 'result', 'buffer', 'count']).length === 0,
      '给了自定义词表就不掺内置词', '内置词: ' + mine(custom.code, ['value', 'index', 'result', 'buffer', 'count']).join(' '));
    // 过滤：关键字、非标识符、重复词都不该进池。留着它们会让产物直接无法解析
    // （关键字）或名字重复（撞名改语义），所以这三类必须挡掉。
    const filtered = normalizeNameDict('if while alpha 1abc 9x ok_1 alpha');
    ok(!filtered.includes('if') && !filtered.includes('while'), '关键字被过滤', filtered.join(' '));
    ok(!filtered.some((w) => /^[0-9]/.test(w)), '非标识符（数字开头）被过滤', filtered.join(' '));
    ok(new Set(filtered).size === filtered.length, '重复词被去重', filtered.join(' '));
    ok(filtered.includes('alpha') && filtered.includes('ok_1'), '合法词被保留', filtered.join(' '));
    // 全部非法时必须回落到内置词表，而不是交出空池让整份代码退回随机名
    ok(normalizeNameDict('1abc 9x').length === 64, '全非法时回落到内置 64 词表', String(normalizeNameDict('1abc 9x').length));
    ok(normalizeNameDict('').length === 64, '留空回落到内置词表', String(normalizeNameDict('').length));
    // 分隔符：逗号/空白/换行都要能用，且分隔符不粘进词里
    ok(normalizeNameDict('aa,bb cc\ndd').join(',') === 'aa,bb,cc,dd',
      '逗号/空白/换行都能分隔', normalizeNameDict('aa,bb cc\ndd').join(','));
    // 词表只影响标识符档位：中文命名打开时它压根不被读
    const cjk = obfuscate(shapeSrc, { ...NAMEONLY, nameStyle: 'Chinese', nameDictionary: 'zebra,quokka' });
    ok(!mine(cjk.code, ['zebra', 'quokka']).length, '中文命名打开时词表不参与改名',
      mine(cjk.code, ['zebra', 'quokka']).join(' '));
    // 元数据：显隐规则 + 闸门口径。free 档锁死 nameStyle=Dictionary 不可选，
    // 词表随之没有意义，所以与 chineseDictionary 一样不加闸门（与 htmleKey 同一口径）
    //
    // 显隐规则用 oneOf 而不是 equals：档位扩到十档后，Dictionary/Chinese 各有两个
    // （带不带 -props），写死一个就把另一种下的输入框藏了——而那种情况是真实存在的
    // （选了 Dictionary-props 也要能填词表）。
    ok(Array.isArray(optionsMeta.VALUE_OPTIONS.nameDictionary.showWhen?.oneOf)
      && optionsMeta.VALUE_OPTIONS.nameDictionary.showWhen.key === 'nameStyle'
      && optionsMeta.VALUE_OPTIONS.nameDictionary.showWhen.oneOf.includes('Dictionary')
      && optionsMeta.VALUE_OPTIONS.nameDictionary.showWhen.oneOf.includes('Dictionary-props'),
    'nameDictionary 在 Dictionary 与 Dictionary-props 两档都显示',
    JSON.stringify(optionsMeta.VALUE_OPTIONS.nameDictionary.showWhen));
    ok(Array.isArray(optionsMeta.VALUE_OPTIONS.chineseDictionary.showWhen?.oneOf)
      && optionsMeta.VALUE_OPTIONS.chineseDictionary.showWhen.key === 'nameStyle'
      && optionsMeta.VALUE_OPTIONS.chineseDictionary.showWhen.oneOf.includes('Chinese')
      && optionsMeta.VALUE_OPTIONS.chineseDictionary.showWhen.oneOf.includes('Chinese-props'),
    'chineseDictionary 在 Chinese 与 Chinese-props 两档都显示',
    JSON.stringify(optionsMeta.VALUE_OPTIONS.chineseDictionary.showWhen));
    ok(optionsMeta.KNOWN_OPTION_KEYS.has('nameDictionary'), 'nameDictionary 是已知选项（GUI/CLI 都能识别）');
    ok(guiOpt('nameDictionary') !== null, 'nameDictionary 出现在界面选项表里');
    // 词表渲染成多行文本框：1024 字的汉字字典与几十词的词典表塞进单行输入框没法看。
    // 只给这两项，其余字符串项（identifierPrefix / reservedNames 等）是短值。
    ok(guiOpt('nameDictionary').multiline === true, 'nameDictionary 渲染为多行');
    ok(guiOpt('chineseDictionary').multiline === true, 'chineseDictionary 渲染为多行');
    const ml = optionsMeta.guiOptions().filter((o) => o.multiline).map((o) => o.key).sort().join(',');
    ok(ml === 'chineseDictionary,nameDictionary', '只有两处词表是多行', ml);
    for (const k of ['identifierPrefix', 'reservedNames', 'domainLock', 'vmCompileKey']) {
      ok(guiOpt(k).multiline !== true, k + ' 仍是单行（短值不必多行）');
    }
    // app.js 里要有 textarea 分支，且 CSS 要有对应规则——缺任一半都会退回单行外观
    const appTxt = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
    const cssTxt = fs.readFileSync(path.join(ROOT, 'web', 'styles.css'), 'utf8');
    ok(/createElement\('textarea'\)/.test(appTxt), 'renderOption 会建 textarea');
    ok(/opt\.kind === 'string' && opt\.multiline/.test(appTxt), 'textarea 只用于 string+multiline');
    ok(/\.opt-row textarea\.opt-ctl/.test(cssTxt), 'CSS 有 textarea 的整行/尺寸规则');
    ok(/min-height:\s*\d+px/.test(cssTxt.slice(cssTxt.indexOf('.opt-row textarea.opt-ctl'))),
      'textarea 有最小高度（不是浏览器的单行默认高）');
    ok(/resize:\s*vertical/.test(cssTxt), 'textarea 允许用户纵向拉高');
  }
  {
    // 显隐规则真的作用在"用户手动切档位"上——这条是被真实 bug 逼出来的。
    //
    // 首版 refreshOptionVisibility 调的是 presetValue，而 presetValue 只读预设、
    // 读不到 state.touched：用户把命名策略从 Mangled 切到 Dictionary 之后，
    // 判定拿到的仍是预设的 Mangled，于是词表框永远不出现。界面显示控件用的却是
    // "touched 优先"的口径，两边不一致就露馅了。所以这里跑 web/app.js 里**真实的**
    // 函数（从源码抽出来 eval，不复刻），并断言读取口径必须走 currentValue。
    const appSrc = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
    const grab = (name) => {
      const at = appSrc.indexOf('function ' + name + '(');
      ok(at >= 0, 'app.js 里有 ' + name + '()');
      let i = appSrc.indexOf('{', at);
      let depth = 0;
      for (; i < appSrc.length; i++) {
        if (appSrc[i] === '{') depth++;
        else if (appSrc[i] === '}') { depth--; if (depth === 0) return appSrc.slice(at, i + 1); }
      }
      return '';
    };
    const mkRow = (rule) => ({
      dataset: { showWhen: JSON.stringify(rule) },
      classes: new Set(),
      classList: {
        toggle(c, on) { if (on) this.owner.classes.add(c); else this.owner.classes.delete(c); },
        contains(c) { return this.owner.classes.has(c); },
      },
      owner: null,
    });
    const rowDict = mkRow({ key: 'nameStyle', equals: 'Dictionary' });
    const rowCjk = mkRow({ key: 'nameStyle', equals: 'Chinese' });
    for (const r of [rowDict, rowCjk]) r.classList.owner = r;
    const rows = [rowDict, rowCjk];
    const vstate = { preset: 'low', touched: new Map() };
    const PRESETS2 = { low: { nameStyle: 'Mangled' } };
    const DEFAULTS2 = { nameStyle: 'Mangled' };
    const doc = { querySelectorAll: (s) => (s.indexOf('data-show-when') >= 0 ? rows : []) };
    const visApi = new Function('PRESETS', 'DEFAULTS', 'state', 'document', [
      grab('presetValue'), grab('currentValue'), grab('refreshOptionVisibility'),
    ].join('\n') + '\nreturn { presetValue, currentValue, refreshOptionVisibility };')(
      PRESETS2, DEFAULTS2, vstate, doc);

    const shown = (r) => !r.classes.has('is-hidden');
    visApi.refreshOptionVisibility();
    ok(!shown(rowDict) && !shown(rowCjk), '默认预设下两处都收起',
      '词表=' + shown(rowDict) + ' 汉字=' + shown(rowCjk));
    // 关键回归：走 touched（用户手动改的）这一层
    vstate.touched.set('nameStyle', 'Dictionary');
    visApi.refreshOptionVisibility();
    ok(shown(rowDict), '用户切到 Dictionary 后词表框出现（读 touched 而非预设）',
      'presetValue=' + visApi.presetValue('nameStyle') + ' currentValue=' + visApi.currentValue('nameStyle'));
    vstate.touched.set('nameStyle', 'Chinese');
    visApi.refreshOptionVisibility();
    ok(!shown(rowDict) && shown(rowCjk), '关词表、开中文命名后汉字字典框出现',
      '词表=' + shown(rowDict) + ' 汉字=' + shown(rowCjk));
    vstate.touched.set('nameStyle', 'Mangled');
    visApi.refreshOptionVisibility();
    ok(!shown(rowDict) && !shown(rowCjk), '两项都关时重新收起',
      '词表=' + shown(rowDict) + ' 汉字=' + shown(rowCjk));
    // 口径一致性：显隐用的必须是 currentValue，不能是 presetValue
    ok(appSrc.slice(appSrc.indexOf('function refreshOptionVisibility('))
      .indexOf('currentValue(rule.key)') > 0,
    'refreshOptionVisibility 按 currentValue 判定（touched 优先）');

    // notEquals 回归：显隐规则里两种写法都在用（equals 如 nameDictionary，
    // notEquals 如 domainLockRedirectUrl / stringArrayWrappersChainedCalls）。
    // 首版只读 rule.equals，notEquals 规则里的 equals 是 undefined，
    // 于是 currentValue(...) !== undefined 恒真 → 那一行永远被收起，
    // 而且不会有任何报错，只是"那个选项在界面上不见了"。
    const rowNe = mkRow({ key: 'stringArrayWrappersCount', notEquals: 0 });
    rowNe.classList.owner = rowNe;
    const rowEq = mkRow({ key: 'stringArrayWrappersChainedCalls', equals: true });
    rowEq.classList.owner = rowEq;
    const rowsNe = [rowNe, rowEq];
    const vstate2 = { preset: 'low', touched: new Map() };
    const PRESETS3 = { low: { stringArrayWrappersCount: 0, stringArrayWrappersChainedCalls: true } };
    const DEFAULTS3 = { stringArrayWrappersCount: 0, stringArrayWrappersChainedCalls: true };
    const doc2 = { querySelectorAll: (s) => (s.indexOf('data-show-when') >= 0 ? rowsNe : []) };
    const visApi2 = new Function('PRESETS', 'DEFAULTS', 'state', 'document', [
      grab('presetValue'), grab('currentValue'), grab('refreshOptionVisibility'),
    ].join('\n') + '\nreturn { refreshOptionVisibility };')(
      PRESETS3, DEFAULTS3, vstate2, doc2);
    const shownNe = (r) => !r.classes.has('is-hidden');
    visApi2.refreshOptionVisibility();
    ok(!shownNe(rowNe), 'notEquals 规则：层数为 0 时收起（原先恒收起，这一格看不出差别）',
      'shown=' + shownNe(rowNe));
    ok(shownNe(rowEq), 'equals 规则：链式为 true 时显示');
    // 关键那一格：层数非 0 时 notEquals 行必须**显示**。旧实现这里恒为 false。
    vstate2.touched.set('stringArrayWrappersCount', 3);
    visApi2.refreshOptionVisibility();
    ok(shownNe(rowNe), 'notEquals 规则：层数非 0 时显示（旧实现恒收起，这一格会失败）',
      'shown=' + shownNe(rowNe));
    vstate2.touched.set('stringArrayWrappersChainedCalls', false);
    visApi2.refreshOptionVisibility();
    ok(!shownNe(rowEq), 'equals 规则：链式关掉后收起', 'shown=' + shownNe(rowEq));
  }
  {
    // Mangled 的定义性质：发名与 seed 无关。用单绑定样本排除干扰——多绑定样本里
    // stringArray 等注入名逐构建随机，比对整体名字集合会被它们污染。
    const one = 'var computeTotals = 1; console.log(computeTotals);';
    const singleName = (style, seed) => {
      const code = obfuscate(one, { ...NAMEONLY, nameStyle: style, seed }).code;
      const m = /var\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*1/.exec(code);
      return m ? m[1] : '';
    };
    const m9 = singleName('Mangled', 9);
    const m10 = singleName('Mangled', 10);
    ok(m9 !== '' && m9 === m10 && m9 === singleName('Mangled', 11),
      'Mangled 档发名与 seed 无关（决定性，可跨构建 diff）', 'seed9=' + m9 + ' seed10=' + m10);
    const s9 = singleName('Mangled-shuffled', 9);
    const s10 = singleName('Mangled-shuffled', 10);
    ok(s9 !== s10 || s9 !== singleName('Mangled-shuffled', 11),
      'Mangled-shuffled 档发名随 seed 变（不留字母表指纹）', 'seed9=' + s9 + ' seed10=' + s10);
  }
  {
    // 体积定位。必须用 NAMEONLY（其它 pass 全关）：Mangled 的命名池不打乱、不消耗
    // 随机数，Mangled-shuffled 要消耗，两者的随机流位置因此不同，完整预设下后续 pass
    // 的产物会有零点几个百分点的差异——那不是名字的功劳，是随机状态的副作用。
    // 关掉其它 pass 后，差异就只剩名字本身。
    const size = {};
    for (const style of ['Mangled', 'Mangled-shuffled', 'Hexadecimal', 'Dictionary']) {
      size[style] = obfuscate(namey, { ...NAMEONLY, nameStyle: style, seed: 9 }).code.length;
    }
    ok(size.Mangled === size['Mangled-shuffled'],
      'Mangled 与 Mangled-shuffled 体积逐字节相同（名字长度一样，只差字母）',
      size.Mangled + ' vs ' + size['Mangled-shuffled']);
    ok(size.Hexadecimal > size.Mangled,
      'Hexadecimal 更大（从 2 字符起步，没有 1 字符名）', size.Mangled + ' → ' + size.Hexadecimal);
    ok(size.Dictionary > size.Hexadecimal, 'Dictionary 档体积最大（词名换可读性）',
      size.Hexadecimal + ' → ' + size.Dictionary);
  }
  {
    // 未知档名（旧档名 random/short、大小写写错、拼错）一律回落到默认值，且不能因为
    // nameStyle 来自调用方就命中 Object.prototype 上的 'constructor'（命名池用 Map）
    const mangled = obfuscate(namey, { preset: 'low', shell: false, nameStyle: 'Mangled', seed: 9 });
    const fallback = obfuscate(namey, { preset: 'low', shell: false, nameStyle: 'constructor', seed: 9 });
    const legacy = obfuscate(namey, { preset: 'low', shell: false, nameStyle: 'short', seed: 9 });
    ok(fallback.code === mangled.code, '未知 nameStyle 回落到默认档而不是抛异常',
      fallback.code.length + ' vs ' + mangled.code.length);
    ok(legacy.code === mangled.code, '旧档名（short/random）也回落到默认档，不会静默出一份没约定的产物');
  }

  // 闸门与默认值
  ok(obfuscateMod.DEFAULTS.nameStyle === 'Mangled', 'nameStyle 默认 Mangled');
  for (const style of optionsMeta.VALUE_OPTIONS.nameStyle.values) {
    const v = plan.violations({ nameStyle: style }, 'free').length;
    const p = plan.violations({ nameStyle: style }, 'plus').length;
    const wantFree = style === 'Mangled' ? 0 : 1;
    ok(v === wantFree && p === 0,
      '闸门 ' + style + '：free ' + (v === 0 ? '放行' : '锁死') + ' / plus 放行', 'free=' + v + ' plus=' + p);
  }
  // 元数据枚举与实际实现必须同步：界面上能选、闸门放行，但 mangle 里没有对应池的档位
  // 会静默回落到默认档（选项存在但无效），这类漂移要有断言兜住。
  // 枚举不再写死字符串，改为与实现侧的 NAME_STYLES 对拍——写死的话下次加档位
  // 就会漏改其中一处，而这种漂移的表征是"选项能选但没效果"，极难从产物看出。
  ok(optionsMeta.VALUE_OPTIONS.nameStyle.values.join(',') === naming.NAME_STYLES.join(','),
    'nameStyle 枚举与实现（utils/naming.js 的 NAME_STYLES）同步',
    optionsMeta.VALUE_OPTIONS.nameStyle.values.join(','));
  ok(naming.NAME_STYLES.length === 10, 'nameStyle 共 10 档（5 基础 × 带/不带属性名）',
    String(naming.NAME_STYLES.length));
  for (const style of optionsMeta.VALUE_OPTIONS.nameStyle.values) {
    const r = obfuscate(namey, { preset: 'low', shell: false, nameStyle: style, seed: 9 });
    ok(typeof r.code === 'string' && r.code.length > 0, '枚举里的 ' + style + ' 档确实生效', r.code.length + ' 字节');
  }
  // 档位解析：后缀只影响「要不要改属性名」，不影响名池形状；不认识的值回落默认档。
  ok(naming.parseNameStyle('Dictionary-props').base === 'Dictionary'
    && naming.parseNameStyle('Dictionary-props').props === true,
  'parseNameStyle 拆出基础档与属性名开关');
  ok(naming.parseNameStyle('Dictionary').props === false, '不带后缀即不改属性名');
  ok(naming.parseNameStyle('dictionary-props').base === 'Dictionary',
    '档位匹配大小写不敏感（API 传小写也能认）');
  ok(naming.parseNameStyle('nope').base === 'Mangled' && naming.parseNameStyle('nope').known === false,
    '不认识的档位回落到默认档且 known=false');
  // 属性名重命名已并入档位（2026-10-09）：旧开关不再是已知选项
  ok(!optionsMeta.KNOWN_OPTION_KEYS.has('renameProperties'),
    'renameProperties 布尔项已移除（并入 nameStyle 的 -props 档）');
  ok(obfuscateMod.DEFAULTS.renameProperties === undefined, 'DEFAULTS 里不再有 renameProperties');
}

section('属性名重命名（nameStyle 的 -props 档）与保留名单（reservedNames/reservedStrings）');
{
  // 内部契约属性（定义 + 访问）：foo/bar/baz 三处同步改名；o2 走点号与字面量键两条路
  const rpSrc = `var obj = { foo: 1, bar: 2, baz: 3 };
function get() { return obj.foo + obj.bar * obj.baz; }
var o2 = { foo: 'a' };
o2['foo'] = 'b';
process.stdout.write(get() + '|' + o2.foo + '\\n');`;
  const rpWant = '7|b\n';

  // 改名生效 + 语义等价（文本探针会被 objectKeyEncoding/vm 改写，改用 stats 计数）
  {
    const on = obfuscate(rpSrc, { preset: 'low', shell: false, nameStyle: 'Hexadecimal-props', seed: 1 });
    const off = obfuscate(rpSrc, { preset: 'low', shell: false, nameStyle: 'Hexadecimal', seed: 1 });
    const st = on.stats.find((s) => s.pass === 'renameProperties');
    ok(st && st.result && st.result.renamed >= 3, '-props 档开启时三处属性名同步改名',
      JSON.stringify(st && st.result));
    ok(!off.stats.some((s) => s.pass === 'renameProperties'), '不带 -props 的同档位下 pass 不出现');
    ok(on.code !== off.code, '-props 档确实改动了产物');
    ok(runNode(on.code, 'rp-on') === rpWant && runNode(off.code, 'rp-off') === rpWant,
      '属性名开/关语义一致');
  }

  // 白名单：body 在保留名单不改，len 不在则改（定义 ∩ 访问均命中）
  {
    const bodySrc = `var o = { body: 1, len: 2 };
process.stdout.write(String(o.body + o.len) + '\\n');`;
    const r = obfuscate(bodySrc, { preset: 'low', shell: false, nameStyle: 'Hexadecimal-props', seed: 1 });
    const st = r.stats.find((s) => s.pass === 'renameProperties');
    ok(st && st.result && st.result.renamed === 1, '白名单属性（body）不改、非白名单（len）改',
      JSON.stringify(st && st.result));
    ok(runNode(r.code, 'rp-body') === '3\n', '白名单样例语义正确');
  }

  // 本次改动的核心：属性名必须跟随档位形状。此前它只对 Chinese 认 nameStyle、其余一律
  // 发 `_0x` 随机名，所以「选了 Hexadecimal 但属性名不是十六进制形状」——那一档对属性
  // 而言是假的。
  {
    const shapeSrc = `var o = { alpha: 1, beta: 2, gamma: 3, delta: 4 };
process.stdout.write(String(o.alpha + o.beta + o.gamma + o.delta));`;
    const want = '10';
    // 关掉 objectKeyEncoding：它会把属性名拆成计算键（["k"+"e"+"y"] 这类），那样产物
    // 里就看不到点号形态的名字，探针无从下手。这里要验的是"名字的形状"，不是"名字
    // 有没有被藏起来"。
    const base = {
      preset: 'low', shell: false, stringArray: false, objectKeyEncoding: false, seed: 9,
    };
    const rProps = obfuscate(shapeSrc, { ...base, nameStyle: 'Dictionary-props' });
    const rPlain = obfuscate(shapeSrc, { ...base, nameStyle: 'Dictionary' });

    // 用自定义词表做精确探针：填进去的四个词必须原样出现在产物里。比"看起来像词表
    // 词"强得多——不会被 process.stdout.write 之类的内建名干扰。
    const WORDS = ['zebra', 'quokka', 'numbat', 'dugong'];
    const rCustom = obfuscate(shapeSrc, {
      ...base, nameStyle: 'Dictionary-props', nameDictionary: WORDS.join(','),
    });
    for (const w of WORDS) {
      ok(new RegExp('\\.' + w + '\\b').test(rCustom.code),
        '自定义词表里的 "' + w + '" 真的做成了属性名', '产物里没有 .' + w);
    }
    ok(!rCustom.code.includes('o.alpha'), '原属性名 alpha 不再出现在产物里');

    // 关键对照：带 -props 与不带 -props 必须产出**不同**的产物。若两者相同，说明档位
    // 对属性名毫无影响——那正是本次要修的病。
    ok(rProps.code !== rPlain.code, 'Dictionary-props 与 Dictionary 产物不同（属性名确实被改）');
    ok(!rPlain.stats.some((s) => s.pass === 'renameProperties'),
      '不带 -props 的 Dictionary 档不跑属性名改名');
    ok(rProps.stats.some((s) => s.pass === 'renameProperties'),
      'Dictionary-props 跑属性名改名');

    // 逐档抽一遍：每个 -props 档都要真的改名，且语义不变
    for (const style of naming.NAME_STYLES.filter((s) => s.endsWith('-props'))) {
      const r = obfuscate(shapeSrc, { ...base, nameStyle: style });
      const st = r.stats.find((s) => s.pass === 'renameProperties');
      ok(st && st.result && st.result.renamed >= 4, style + ' 档改名四个属性',
        JSON.stringify(st && st.result));
      ok(runNode(r.code, 'rp-' + style) === want, style + ' 档语义正确');
    }
  }

  // 组合：high 预设 + 属性名改名全链路语义不变（2 seed）
  {
    let comboBad = '';
    for (let seed = 1; seed <= 2 && !comboBad; seed++) {
      for (const style of ['Mangled', 'Mangled-props']) {
        const code = obfuscate(rpSrc, { preset: 'high', shell: false, nameStyle: style, seed }).code;
        let got;
        try { got = runNode(code, 'rp-combo-' + seed + '-' + style); } catch (e) { got = 'THREW'; }
        if (got !== rpWant) { comboBad = 'seed=' + seed + ' style=' + style + ' → ' + got.slice(0, 40); break; }
      }
    }
    ok(comboBad === '', 'high 预设 + 属性名改名全链路语义不变', comboBad);
  }

  // reservedNames：匹配名不改，其余照常改
  {
    const src = `function myPublicApi(x) { return x * 2; }
var internalVar = 5;
process.stdout.write(myPublicApi(internalVar) + '\\n');`;
    const r = obfuscate(src, { preset: 'low', shell: false, reservedNames: ['^myPublic'], seed: 1 });
    ok(runNode(r.code, 'rn') === '10\n', 'reservedNames 语义正确');
    ok(r.code.includes('myPublicApi') && !r.code.includes('internalVar'),
      'reservedNames 保留匹配名、其余改名');
  }

  // reservedStrings：匹配字符串不进池（threshold=1 保证非保留串必进池）
  {
    const src = `var a = 'secret-string';
var b = 'normal-string';
process.stdout.write(a + '|' + b + '\\n');`;
    const r = obfuscate(src, { preset: 'low', shell: false, reservedStrings: ['secret'], stringArrayThreshold: 1, seed: 1 });
    ok(runNode(r.code, 'rs') === 'secret-string|normal-string\n', 'reservedStrings 语义正确');
    ok(r.code.includes('secret-string') && !r.code.includes('normal-string'),
      'reservedStrings 保留匹配串、其余进池');
  }

  // 门控：free 锁死全部 *-props 档（属性名重命名是付费能力，现在由档位承载）。
  // 关键：白名单必须只列不带 -props 的那档——误列一个就把付费能力白送，且
  // violations() 不会报错，只会说"free 也能用这档"，所以这里逐档钉。
  for (const style of naming.NAME_STYLES) {
    const v = plan.violations({ nameStyle: style }, 'free').length;
    const p = plan.violations({ nameStyle: style }, 'plus').length;
    const wantFree = style === 'Mangled' ? 0 : 1;
    ok(v === wantFree && p === 0,
      '闸门 ' + style + '：free ' + (v === 0 ? '放行' : '锁死') + ' / plus 放行', 'free=' + v + ' plus=' + p);
  }
  ok(plan.violations({ nameStyle: 'Mangled-props' }, 'free').length === 1,
    'free 档拿不到属性名重命名（Mangled-props 被锁死）');
  // reservedNames/reservedStrings 是减混淆兼容功能，不门控
  ok(plan.violations({ reservedNames: ['^x'] }, 'free').length === 0, 'free 档 reservedNames 不门控');
  ok(plan.violations({ reservedStrings: ['x'] }, 'free').length === 0, 'free 档 reservedStrings 不门控');

  // 可复现
  ok(obfuscate(rpSrc, { preset: 'high', shell: false, nameStyle: 'Hexadecimal-props', seed: 97 }).code ===
    obfuscate(rpSrc, { preset: 'high', shell: false, nameStyle: 'Hexadecimal-props', seed: 97 }).code,
    '属性名改名固定 seed 可复现');
}

section('其他');
{
  // 成本估算（src/host-limits.js）。这三个函数直接决定**用户能上传多大**、以及
  // 服务端回执预算够不够，所以要有断言——纯数字常量没人盯着，改错了要等线上
  // 超时才发现。
  {
    const names = Object.keys(hostLimits.PRESET_COST);
    let costBad = '';
    for (const n of names) {
      const c = hostLimits.costOf(n);
      if (!(c.msPerKb > 0) || !(c.inflation >= 1)) costBad = n + ' 成本不合理 ' + JSON.stringify(c);
    }
    ok(costBad === '', '各预设成本档为正且膨胀比 ≥ 1', costBad);

    // 认不出的预设必须回落到**当前表里最贵的一档**，不能写死 PRESET_COST.max。
    // 2026-09-28 重算基线后最贵的已经不是 max（high 走旧 wasm 档，贵数倍），写死
    // max 会让未知档位按最便宜的一档记账，与「失败要偏保守」完全相反。
    const dearest = Math.max(...names.map((n) => hostLimits.costOf(n).msPerKb));
    const fb = hostLimits.costOf('__no_such_preset__');
    ok(fb.msPerKb === dearest, '未知预设回落到当前最贵的一档（不是写死 max）',
      '回落 ' + fb.msPerKb + '，最贵 ' + dearest);
    ok(hostLimits.costOf(undefined).msPerKb === dearest, 'undefined 预设同样回落到最贵档');

    // 上传上限必须落在 [1 KiB, maxUploadBytes] 且对预设单调不增（越贵上限越小）
    let capBad = '';
    for (const n of names) {
      const cap = hostLimits.presetInputCap(n);
      if (!(cap >= 1024) || cap > hostLimits.HOST.maxUploadBytes) capBad = n + ' 上限 ' + cap;
    }
    ok(capBad === '', '各预设上传上限落在合理区间', capBad);

    // 未知档位的上限不得比任何已知档位都大
    const fbCap = hostLimits.presetInputCap('__no_such_preset__');
    ok(fbCap <= Math.min(...names.map((n) => hostLimits.presetInputCap(n))),
      '未知档位的上传上限不比任何已知档位宽松', '回落上限 ' + fbCap);
  }

  // CLI 已随转向纯云端一并移除，help 文本不再存在；改为校验界面用到的文案可渲染。
  ok(typeof i18n.t('guiRun') === 'string' && i18n.t('guiRun').length > 0, '界面文案可渲染');
  const before = i18n.getLang();
  i18n.setLang('en');
  ok(i18n.t('guiRun') === 'Obfuscate', '可切到英文');
  i18n.setLang(before);
  throws(() => i18n.setLang('fr'), '未知语言报错');

  // 界面与 CLI 用到的文案键必须两种语言都在：新增控件时最容易漏配英文
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'i18n.js'), 'utf8');
    const zhKeys = new Set([...src.slice(src.indexOf('  zh: {'), src.indexOf('  en: {'))
      .matchAll(/^    ([A-Za-z_][\w]*):/gm)].map((m) => m[1]));
    const enKeys = new Set([...src.slice(src.indexOf('  en: {'))
      .matchAll(/^    ([A-Za-z_][\w]*):/gm)].map((m) => m[1]));
    const onlyZh = [...zhKeys].filter((k) => !enKeys.has(k));
    const onlyEn = [...enKeys].filter((k) => !zhKeys.has(k));
    ok(onlyZh.length === 0 && onlyEn.length === 0,
      'i18n 两种语言的键集一致', 'only zh: ' + onlyZh.join(',') + ' only en: ' + onlyEn.join(','));

    const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
    const app = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
    const wanted = new Set();
    for (const m of html.matchAll(/data-i18n(?:-title|-ph)?="([^"]+)"/g)) wanted.add(m[1]);
    for (const m of app.matchAll(/\bt\('([A-Za-z_][\w]*)'/g)) wanted.add(m[1]);
    const missing = [...wanted].filter((k) => !zhKeys.has(k) && k !== 'licReason_');
    ok(missing.length === 0, '界面用到的文案键都已定义', missing.join(', '));
  }

  ok(platform.runtime === 'node', '运行环境判定为 node', platform.runtime);
  ok(platform.byteLength('中文abc') === Buffer.byteLength('中文abc', 'utf8'), 'byteLength 与 Buffer 一致');
  const bytes = platform.randomBytes(32);
  ok(bytes.length === 32 && new Set(bytes).size > 4, 'randomBytes 返回 32 字节且不全是同一个值');

  // 常见陷阱：核心模块图里不能出现 Node 内建依赖，否则浏览器与 Worker 会整体求值失败
  const coreFiles = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) coreFiles.push(p);
    }
  })(path.join(ROOT, 'src'));
  const bad = [];
  for (const f of coreFiles) {
    const text = stripComments(fs.readFileSync(f, 'utf8'));
    if (/\brequire\(/.test(text) || /from '(node:)?(fs|path|os|crypto|readline|inspector|child_process)'/.test(text)) {
      bad.push(path.relative(ROOT, f));
    }
  }
  ok(bad.length === 0, '核心模块不含 Node 内建依赖', bad.join(', '));

  // 更严的一条：从公共入口出发跟踪真实 import 图，逐个模块查 node: 依赖。
  // 目录扫描会漏掉"新增文件没被谁引用"或"入口间接引入"两种情况，这里不会。
  {
    const seen = new Set();
    const offenders = [];
    const walkImports = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = stripComments(fs.readFileSync(file, 'utf8'));
      if (/from '(node:)?(fs|path|os|crypto|readline|inspector|child_process|module|url|worker_threads)'/.test(text)) {
        offenders.push(path.relative(ROOT, file));
      }
      for (const m of text.matchAll(/from '(\.[^']+)'/g)) {
        const abs = path.resolve(path.dirname(file), m[1]);
        if (fs.existsSync(abs)) walkImports(abs);
      }
    };
    walkImports(path.join(ROOT, 'src', 'index.js'));
    ok(offenders.length === 0, 'src/index.js 的 import 图不含 Node 内建依赖',
      offenders.join(', '));
    ok(seen.size >= 30, '公共入口的 import 图覆盖整个核心', '仅 ' + seen.size + ' 个模块');
  }

  const cf = [];
  for (const f of coreFiles) {
    // 只看真实的调用形态。obfuscate.js 的宿主全局白名单字符串里出现 "Buffer"
    // 是数据而非依赖（那份名单正是用来放行宿主全局的）。
    const text = stripComments(fs.readFileSync(f, 'utf8'));
    if (/\bBuffer\.(from|alloc|byteLength|concat|isBuffer)\b/.test(text)) {
      cf.push(path.relative(ROOT, f));
    }
  }
  ok(cf.length === 0, '核心不使用 Buffer', cf.join(', '));

  // 字符串代码生成：浏览器的 CSP 与不少函数运行时都禁 eval / new Function，
  // 一旦核心里出现，产物在那边直接抛 EvalError。核心坚持不用字符串代码生成，
  // 因此同一份产物在任何宿主上都能跑。判据只看真实的调用形态，放过 AST 访问器
  // 里那些名为 Function 的方法定义（形如 `Function(path) {`）。
  const codegen = [];
  for (const f of coreFiles) {
    const text = stripLiterals(fs.readFileSync(f, 'utf8'));
    if (/new\s+Function\s*\(/.test(text) || /\(\s*0\s*,\s*eval\s*\)/.test(text)
      || /[^.\w]eval\s*\(/.test(text)) {
      codegen.push(path.relative(ROOT, f));
    }
  }
  ok(codegen.length === 0, '核心模块图内没有字符串代码生成（eval / new Function）',
    codegen.join(', '));

  // shell 引导器原语有两份实现：产物里那份文本（PRIMITIVES_TEXT）与构建期那份
  // 直接实现。原先靠 (0,eval) 当场求值保证不漂移，eval 在受限宿主上会被禁掉，
  // 所以改成手写，这里逐位比对把"不漂移"重新钉死。eval 只出现在本文件里，
  // 而本文件不随产物上传。
  {
    const shellMod = await import('../src/passes/shell.js');
    // 原语变体是模块级可变状态（构建时逐层切换）。显式钉回默认档再比对：
    // 别的测试文件（handler-poly）跑过之后会把当前变体留在任意一档，
    // 而这里比对的是 PRIMITIVES_TEXT（默认档的文本），靠执行顺序碰巧对上是隐患。
    shellMod.setPrimitiveVariants(shellMod.DEFAULT_VARIANTS);
    const fromText = (0, eval)('(function(){' + shellMod.PRIMITIVES_TEXT
      + 'return {mul32:mul32,lcg:lcg,xs32:xs32,shfl:shfl,ipos:ipos,mix:mix};})()');
    const direct = shellMod.primitivesDirect;
    let same = true;
    let firstBad = '';
    // mul32 / lcg / xs32 / mix / ipos 用覆盖边界与进位的输入逐个比对
    const seeds = [0, 1, 2, 0x7fffffff, 0x80000000, 0xffffffff, 0x12345678, 0xdeadbeef];
    for (const a of seeds) {
      if (fromText.mul32(a, 0xffffffff) !== direct.mul32(a, 0xffffffff)) {
        same = false; firstBad = 'mul32(' + a + ')'; break;
      }
      if (fromText.lcg(a) !== direct.lcg(a)) { same = false; firstBad = 'lcg(' + a + ')'; break; }
      if (fromText.xs32(a) !== direct.xs32(a)) { same = false; firstBad = 'xs32(' + a + ')'; break; }
      if (fromText.mix(a, 0x9e3779b9, a & 255, 1) !== direct.mix(a, 0x9e3779b9, a & 255, 1)) {
        same = false; firstBad = 'mix(' + a + ')'; break;
      }
      if (fromText.ipos(a, 40503, 2654435761, 257) !== direct.ipos(a, 40503, 2654435761, 257)) {
        same = false; firstBad = 'ipos(' + a + ')'; break;
      }
    }
    // shfl 原地置换，比对整个数组与返回值
    for (const n of [0, 1, 2, 7, 64, 257]) {
      const mk = () => Array.from({ length: n }, (_, i) => i);
      const a1 = fromText.shfl(mk(), 0xc0ffee);
      const a2 = direct.shfl(mk(), 0xc0ffee);
      if (a1.length !== a2.length || a1.some((v, i) => v !== a2[i])) {
        same = false; firstBad = 'shfl(n=' + n + ')'; break;
      }
    }
    ok(same, 'shell 引导器原语：产物文本与构建期直接实现逐位一致', firstBad);
  }
}

section('生成器优先级：赋值级以下的位置必须给逗号表达式补括号');
{
  // 根因：AST 里 SequenceExpression 是合法节点，但**打印**出来的语法层级未必容纳它。
  // 生成器多数表达式位置走 _str(expr, minPrec)（优先级不够就补括号），少数位置直接
  // _node(expr) —— 那几处漏掉一次括号，产出的代码会重新解析成**另一个结构**，
  // 而且不报错、不在构建期暴露，只在运行期表现为"某个值算错了"。
  //
  // 2026-10-12 实测到的就是这类：numberObfuscation 的运行期状态形态产出逗号表达式
  // `upd, expr`，而 _yieldExpression 直接印操作数，于是
  //   class A { *it() { yield 9; } }
  // 被改成
  //   class A { *it() { yield C=C*48769+51123&131071, 126054494^C^(126054494^9^C); } }
  // `yield a, b` 的 b 是逗号的右操作数，yield 只拿到 a —— 于是 yield 出去的是计数器
  // 状态（65571）而不是 9。实测 preset high/medium 在 30 个 seed 里各错 1 个
  // （seed 6）、max 错 1 个（seed 10），与 VM、扁平化都无关。
  //
  // 判据用**运行结果**而不是文本：每个用例的逗号表达式左侧都有可观测副作用
  // （赋值 / push），所以"少一对括号"必然改变值或抛错，老码逐条都不通过。
  const parserMod = await import('../src/ast/parser.js');
  const generatorMod = await import('../src/ast/generator.js');
  const { parse } = parserMod.default || parserMod;
  const generate = (ast) => (generatorMod.default || generatorMod)(ast).code;

  const CASES = [
    // yield 操作数：少括号 → yield 出去的是左操作数
    ['yield 操作数', 'function* gy(){ var a; yield (a=1, 7); }\nout([...gy()].join(","));', '7'],
    // await 操作数：少括号 → await 的是左操作数，值变成 Promise 对象
    ['await 操作数',
      'async function aw(){ var a; var p = (a=1, Promise.resolve(2)); return String(await p); }\naw().then(function(v){ out(v); });',
      '2'],
    // 展开元素：少括号 → ... 展开的是左操作数（数字），抛 TypeError
    ['展开元素', 'var a=0; out([...(a=0, [1,2])].join(","));', '1,2'],
    // 解构剩余：同上
    ['解构剩余', 'var a=0; var t=[...(a=0, [1,2])]; out(t.join(","));', '1,2'],
    // 默认值：少括号 → 变成两个实参
    ['解构默认值', 'var a=0; function f(v=(a=1, 5)){ return v; } out(String(f()));', '5'],
    // 计算属性键：少括号 → 键取左操作数
    ['对象计算键', 'var a=0; var o={[(a=0,"k")]: 9}; out(String(o.k));', '9'],
    ['对象方法计算键', 'var a=0; var o={[(a=0,"m")](){ return 4; }}; out(String(o.m()));', '4'],
    ['类方法计算键', 'var a=0; class M { [(a=0,"cm")](){ return 5; } } out(String(new M().cm()));', '5'],
    ['类字段计算键', 'var a=0; class P { [(a=0,"cp")]=6; } out(String(new P().cp));', '6'],
    // 类字段初值：少括号 → 逗号被读成下一个字段声明
    ['类字段初值', 'var a=0; class Q { v=(a=0, 7); } out(String(new Q().v));', '7'],
    // 标签模板的 tag：少括号 → 模板套在右操作数上，左侧不产生调用
    ['标签模板 tag',
      'var n=0; function tg(){ n++; return "x"; } var a=0; (a=0, tg)`tpl`; out(String(n));', '1'],
    // 计算下标：少括号 → 下标取左操作数
    ['成员计算下标', 'var a=0; var o={k:3}; out(String(o[(a=0,"k")]));', '3'],
  ];

  // 预置 out()：每个用例只写自己那一行。输出挂在 exit 上，async 用例的 then
  // 回调（微任务）才来得及跑完——挂在 try 块之后同步输出的话 async 用例恒为空串。
  const wrap = (body) => 'var __o=[]; function out(v){ __o.push(String(v)); }\n'
    + 'process.on("exit", function(){ process.stdout.write(__o.join("~")); });\n'
    + 'try{\n' + body + '\n}catch(e){ __o.push("THREW:"+(e&&e.constructor&&e.constructor.name)); }';

  let bad = '';
  for (const [name, body, want] of CASES) {
    const src = wrap(body);
    let got;
    try {
      // 两轮往返：生成 → 解析 → 再生成。要求两轮文本一致，且都能跑出 want。
      const g1 = generate(parse(src, { sourceType: 'script' }));
      const g2 = generate(parse(g1, { sourceType: 'script' }));
      if (g1 !== g2) { bad = name + '：往返两轮文本不一致（第一轮丢了括号）'; break; }
      got = runNode(g1, 'genprec-' + name + '.js').trim();
    } catch (e) {
      bad = name + '：生成/解析抛错 ' + String(e.message).split('\n')[0].slice(0, 60); break;
    }
    if (got !== want) { bad = name + '：实得 ' + got + '，应为 ' + want; break; }
  }
  ok(!bad, '逗号表达式在 ' + CASES.length + ' 个赋值级以下位置都补括号（老码逐条算错）', bad);

  // 反向确认：断言不是恒真的。把生成结果里的括号去掉（等价于老码的打印方式），
  // 值必须变。判据取 yield 这一条——它是 2026-10-12 实测真实踩到的那一处。
  {
    const body = 'function* gy(){ var a; yield (a=1, 7); }\nout([...gy()].join(","));';
    const g = generate(parse(wrap(body), { sourceType: 'script' }));
    const old = g.replace(/yield \(([^()]*)\)/, 'yield $1');
    let okParen = false, oldDiffers = false;
    try {
      okParen = runNode(g, 'genprec-good.js').trim() === '7';
      oldDiffers = runNode(old, 'genprec-old.js').trim() !== '7';
    } catch (e) { oldDiffers = true; }
    ok(okParen && oldDiffers, '去掉括号后值确实改变（老打印方式必错，断言非恒真）',
      '带括号=' + okParen + ' 去括号后是否不同=' + oldDiffers);
  }
}

section('选项元数据：说明完整性');
{
  // 每个选项都必须有中英文名称与中英文说明，缺一不可。
  //
  // 为什么要有这条：说明是**手写**的，新增选项时很容易只写 `zh`/`en` 名字而忘了
  // 提示 —— 界面上就出现一个没有解释的开关，用户只能猜。实测就是这样漏下四项
  // （seed / lang / dirSkip，全是 guiHide 的命令行与内部项，GUI 里看不见，
  // 所以更容易忘）。
  //
  // 判据是"字段存在且非空"，不判长度：有的说明本来就短（"输出缩进宽度（空格数）"），
  // 硬凑字数只会注水。
  const V = optionsMeta.VALUE_OPTIONS;
  const keys = Object.keys(V);
  ok(keys.length >= 50, '选项表有条目', '实际 ' + keys.length);

  const missName = [], missHint = [], emptyHint = [];
  for (const k of keys) {
    const o = V[k];
    if (!o.zh || !o.en) missName.push(k);
    if (!o.hintZh || !o.hintEn) missHint.push(k);
    // 说明与名称不能是同一个词 —— 那种"说明"等于没说明
    if (o.hintZh && o.hintZh.trim() === (o.zh || '').trim()) emptyHint.push(k + '(zh)');
    if (o.hintEn && o.hintEn.trim() === (o.en || '').trim()) emptyHint.push(k + '(en)');
  }
  ok(missName.length === 0, keys.length + ' 个选项都有中英文名称',
    '缺名称: ' + missName.join(','));
  ok(missHint.length === 0, keys.length + ' 个选项都有中英文说明',
    '缺说明: ' + missHint.join(','));
  ok(emptyHint.length === 0, '没有选项拿名称当说明用', emptyHint.join(','));

  // 说明不该是空话：至少要有个最低长度，且不含未替换的模板占位
  const tooShort = keys.filter((k) => (V[k].hintZh || '').length < 8);
  ok(tooShort.length === 0, '没有过短的说明（< 8 字符）', tooShort.join(','));
  const tpl = keys.filter((k) => /\{\{|\}\}|undefined|NaN/.test(V[k].hintZh || ''));
  ok(tpl.length === 0, '说明里没有未替换的占位符', tpl.join(','));

  // 上面那圈只覆盖 VALUE_OPTIONS（52 项）。界面上还有一批布尔项来自 BOOL_LABELS +
  // BOOL_HINTS，两者拼进 guiOptions() 才是用户真正看到的那一版。
  //
  // 曾经的洞：wasm / wasmInterpreter 在 BOOL_LABELS 里有标签、BOOL_HINTS 里**根本没有
  // 条目**，界面上就是两个没有任何说明的开关——而 VALUE_OPTIONS 那圈检查看不见它们。
  // 所以这里以 guiOptions() 为准再查一遍：只要界面会渲染，它就必须有说明。
  const gui = optionsMeta.guiOptions();
  ok(gui.length > keys.length, '界面选项集大于 VALUE_OPTIONS（含布尔项）',
    gui.length + ' vs ' + keys.length);
  const guiMiss = gui.filter((o) => !o.hintZh || !o.hintEn).map((o) => o.key);
  ok(guiMiss.length === 0, gui.length + ' 个界面选项都有中英文说明', '缺说明: ' + guiMiss.join(','));

  // 长度预算：提示是让人在**选一个值之前**知道自己在选什么，不是文档。
  // 上限给得宽（220 字）——它拦的是"膨胀"而不是"长短"：超过这个长度的多半又把实现
  // 细节、历史沿革或动机塞回来了，而那些在 README 与 AGENTS 里各有一处正本。
  const over = gui.filter((o) => (o.hintZh || '').length > 220)
    .map((o) => o.key + '(' + o.hintZh.length + ')');
  ok(over.length === 0, '没有说明膨胀到 220 字以上', over.join(','));

  // 说明里点名了别的选项时要真实存在：改名/删项之后最容易漏改的就是这种交叉引用，
  // 而它不会报错——用户读到的是一个不存在的选项名。
  const known = new Set(gui.map((o) => o.key));
  const badRef = [];
  for (const o of gui) {
    for (const m of (o.hintZh || '').matchAll(/\b([a-z][A-Za-z0-9]{3,})\b/g)) {
      const w = m[1];
      // 只查"看起来像选项名"且确实不在表里的：避免把 camelCase 的普通英文词全算进来
      if (/[A-Z]/.test(w) && !known.has(w) && /^(string|vm|wasm|control|number|opaque|dead|sentinel|integrity|domain|module|dir|shell|html|name|chinese|force|reserved|extra|self|debug|anti|console|env|simplify|escape|compact|indent|seed|lang|preset|target|identifier|logical|condition|rt)/.test(w)) {
        badRef.push(o.key + '->' + w);
      }
    }
  }
  ok(badRef.length === 0, '说明里引用的选项名都真实存在', badRef.join(','));
}

if (process.argv[1] && process.argv[1].endsWith('minify.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}
