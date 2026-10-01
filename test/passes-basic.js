#!/usr/bin/env node
/**
 * 基础混淆 pass：逻辑表达式、数值常量、多态可复现、控制流扁平化。
 *
 *   node test/passes-basic.js
 *
 * 整跑全部用例：npm test（即 node test/selftest.js）。
 */
import { cleanTmp, ok, report, runNode, section } from './_harness.js';
import obfuscateMod from '../src/obfuscate.js';

const { obfuscate } = obfuscateMod;
section('逻辑表达式取值语义');
{
  // 2026-09-19 修掉的静默正确性缺陷：logicalExpr 原先把 `a || b` 交换成 `b || a`，
  // 依据是"两侧都是原子时求值结果不变"。但 && 与 || 返回的是**操作数的值**而非布尔：
  // `3 || 1` 得 3，`1 || 3` 得 1，交换会改值。原先这里只打一行提示、不判失败，
  // 理由是"原版也这样"——可它产出的是**语义不同的代码且不报错**，属于最危险的一类，
  // 必须判失败。修复后仅当两侧都恒为布尔（比较、!、布尔字面量）才允许交换。
  //
  // 命中依赖随机数，所以每个例子跑 10 个 seed：修复前实测约 3/16 会改坏，
  // 4 例 × 10 seed 漏检概率可忽略。
  const cases = [
    'function m(b) { var v = 0; v = v + (b || 1); return v; } console.log(m(0), m(3));',
    'function m(b) { var v = 0; v += b || 1; return v; } console.log(m(0), m(3));',
    'function m(b) { var v = 0; v += b && 2; return v; } console.log(m(0), m(3));',
    'function m(b) { var v = 10; v -= b || 1; return v; } console.log(m(0), m(3));',
  ];
  let mismatch = 0;
  let firstBad = '';
  for (let ci = 0; ci < cases.length; ci++) {
    const src = cases[ci] + '\n';
    const want = runNode(src, 'logi-plain-' + ci + '.js').trim();
    for (let seed = 1; seed <= 10; seed++) {
      const got = runNode(obfuscate(src, { preset: 'medium', seed }).code,
        'logi-' + ci + '-' + seed + '.js').trim();
      if (got !== want) {
        mismatch++;
        if (!firstBad) firstBad = '例' + ci + ' seed=' + seed + '：混淆后 ' + got + '，应为 ' + want;
      }
    }
  }
  ok(mismatch === 0, '逻辑表达式作运算数时取值语义保持（4 例 × 10 seed）', firstBad);
}

section('数值常量混淆');
{
  // 整数字面量被改写成恒等表达式，最容易出的错是"看起来恒等、求值不恒等"：
  // 0 与 -0、超过 2^31 的异或、键位与成员位被误改。这里覆盖这四类，跨 6 个
  // seed 跑 medium 与 high（阈值 0.5 / 0.8），命中依赖随机数，单 seed 不够。
  const cases = [
    'var a=[10,20,30];console.log(a[0]+a[2], a.length, 1/0, -7+3);',
    'function f(x){if(x===1024){return "k";}return -(255)+0;}console.log(f(1024),f(1),Object.is(-0,0-0));',
  ];
  let mismatch = 0;
  let firstBad = '';
  for (let ci = 0; ci < cases.length; ci++) {
    const src = cases[ci] + '\n';
    const want = runNode(src, 'num-plain-' + ci + '.js').trim();
    for (const preset of ['medium', 'high']) {
      for (let seed = 1; seed <= 6; seed++) {
        const got = runNode(obfuscate(src, { preset, seed }).code,
          'num-' + ci + '-' + preset + '-' + seed + '.js').trim();
        if (got !== want) {
          mismatch++;
          if (!firstBad) firstBad = '例' + ci + ' ' + preset + ' seed=' + seed + '：' + got + ' 应为 ' + want;
        }
      }
    }
  }
  ok(mismatch === 0, '数值常量改写后取值语义保持（2 例 × 2 预设 × 6 seed）', firstBad);

  // MBA（混合布尔算术）：位算与算术交织的恒等式。这里钉的是两件事——
  //   ① 取值恒等，尤其是 `(x & y) << 1` 那条：x + y = V 时 x&y ≤ V/2，
  //      所以左移不会翻负；把取值域放宽到 2^31 就会静默算错，边界值必须覆盖；
  //   ② 默认关、max 开：不改既有预设基线，且开关真的生效（不是只加了选项名）。
  {
    const vals = [2, 3, 4, 7, 8, 255, 256, 65535, 65536, 1048575, 1048576,
      0x1ffff, 0x20000, 0x3fffffe, 0x3fffffff];
    const mbaSrc = 'var o=[];\n'
      + vals.map((v) => `o.push(${v});`).join('\n')
      + '\nprocess.stdout.write(JSON.stringify(o));\n';
    const mbaWant = runNode(mbaSrc, 'mba-plain.js');
    let mbaBad = '';
    for (let seed = 1; seed <= 5 && !mbaBad; seed++) {
      const got = runNode(obfuscate(mbaSrc, {
        preset: 'medium', seed, numberObfuscationMBA: true,
        numberObfuscationThreshold: 1,
      }).code, 'mba-' + seed + '.js');
      if (got !== mbaWant) mbaBad = 'seed=' + seed + '：' + got.slice(0, 60) + ' 应为 ' + mbaWant.slice(0, 60);
    }
    ok(mbaBad === '', 'MBA 恒等式取值语义保持（边界值 × 5 seed）', mbaBad);

    const stMax = obfuscate(mbaSrc, { preset: 'max', seed: 3, shell: false }).stats
      .find((s) => s.pass === 'numberObf');
    ok(stMax && stMax.result.mba === true, 'max 预设启用 MBA', JSON.stringify(stMax && stMax.result));

    const on = obfuscate(mbaSrc, { preset: 'medium', seed: 3, numberObfuscationMBA: true, numberObfuscationThreshold: 1 }).code;
    const off = obfuscate(mbaSrc, { preset: 'medium', seed: 3, numberObfuscationMBA: false, numberObfuscationThreshold: 1 }).code;
    ok(on !== off, 'MBA 开关真的改变产物（不是空开关）');
    // 形态特征：同一棵表达式里同时出现 & / | / << 与算术算子
    ok(/(?:&[^;]*\)\s*<<|&[^;]*\)\s*[+*]|[-+]\s*\([^()]*&)/.test(on),
      'MBA 产物里出现位算与算术交织的形态');
  }
}

section('多态与可复现');
{
  const src = 'function add(a,b){return a+b;}console.log(add(2,3));';
  // 固定 seed 必须逐字节复现，这是"可复现构建"的底线，也是上面几组语义测试
  // 能定位到具体 seed 的前提
  const a = obfuscate(src, { preset: 'medium', seed: 424242 }).code;
  const b = obfuscate(src, { preset: 'medium', seed: 424242 }).code;
  ok(a === b, '同一 seed 两次构建逐字节相同');

  // 多态：不同 seed 的产物不仅是常量不同，连标识符集合与分派结构都不同。
  // 只比字节会漏掉"只换常量不换结构"的假多态，所以同时看标识符集合的重叠度
  const ids = (code) => {
    const set = new Set();
    for (const m of code.matchAll(/[\p{L}_$][\p{L}\p{N}_$]*/gu)) set.add(m[0]);
    return set;
  };
  const s1 = obfuscate(src, { preset: 'medium', seed: 11 }).code;
  const s2 = obfuscate(src, { preset: 'medium', seed: 12 }).code;
  const i1 = ids(s1);
  const i2 = ids(s2);
  let shared = 0;
  for (const n of i1) if (i2.has(n)) shared++;
  const overlap = shared / Math.max(1, Math.min(i1.size, i2.size));
  ok(s1 !== s2, '不同 seed 的产物不同');
  ok(overlap < 0.6, '不同 seed 的标识符集合重叠度低于 60%（结构级多态）',
    '重叠度 ' + overlap.toFixed(2));

  // 运行期滚动重键：开关两态都得跑得对，且产物不同
  const base = {
    preset: 'medium', vmProtection: false, stringArray: false,
    debugProtection: false, envFingerprint: false, integrityCheck: false,
    shell: false, mangle: false, controlFlowFlattening: true,
    controlFlowDepth: 2, controlFlowThreshold: 1, controlFlowProbability: 1,
  };
  const cfSrc = 'function f(n){var a=0;for(var i=0;i<n;i++){if(i%2===0){a+=i*3;}else{a-=1;}}return a;}\nconsole.log(f(3),f(7),f(20));';
  const cfWant = runNode(cfSrc, 'cf-plain.js').trim();
  let cfBad = 0;
  const outs = [];
  for (const rolling of [false, true]) {
    for (let seed = 1; seed <= 3; seed++) {
      const code = obfuscate(cfSrc, { ...base, controlFlowRollingKey: rolling, seed }).code;
      outs.push(code);
      if (runNode(code, 'cf-' + rolling + '-' + seed + '.js').trim() !== cfWant) cfBad++;
    }
  }
  ok(cfBad === 0, '分派表滚动重键开与关的语义都正确（2 × 3 seed）');
  ok(outs[0] !== outs[3], '滚动重键改变了产物结构（同 seed 下开与关不同）');
}

section('控制流扁平化：大函数体');
{
  // 回归：flatten 原先是"先递归算剩余列表"的尾递归（flatten(list.slice(1), next)），
  // 递归深度等于语句条数——一个几千条语句的函数体（打包产物的 IIFE、代码生成器的
  // 输出）就会 "Maximum call stack size exceeded"，且每层复制数组是 O(n²)。
  // 改成从尾到头倒序迭代后，条数只受内存限制。12000 条在改动前必爆，用它守住。
  const parts = ['function big(){'];
  for (let i = 0; i < 12000; i++) parts.push('var v' + i + ' = ' + i + ' + String(' + i + ').length;');
  parts.push('var s = 0;');
  parts.push('for (var k = 0; k < 20; k++) { if (k % 3 === 0) { s += k; } else { s += v0 + v11999; } }');
  parts.push('return [v0, v11999, s].join("|");');
  parts.push('}');
  parts.push('console.log(big());');
  const bigSrc = parts.join('\n');
  const want = runNode(bigSrc, 'cf-big-plain.js').trim();

  let code = '';
  let err = '';
  try {
    code = obfuscate(bigSrc, { preset: 'low', seed: 20260920 }).code;
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  ok(!err, '12000 条语句的函数体不触发栈溢出（原实现必爆）', err);
  ok(!!code && runNode(code, 'cf-big-obf.js').trim() === want, '大函数体产物语义与原源码一致');
}

if (process.argv[1] && process.argv[1].endsWith('passes-basic.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}
