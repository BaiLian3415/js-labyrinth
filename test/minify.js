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

  // 门控：free 锁死、plus 放行；默认关闭
  ok(plan.violations({ simplify: true }, 'free').length === 1, 'free 档 simplify 被闸门锁死');
  ok(plan.violations({ simplify: false }, 'free').length === 0, 'free 档关闭放行');
  ok(plan.violations({ simplify: true }, 'plus').length === 0, 'plus 档 simplify 放行');
  ok(obfuscateMod.DEFAULTS.simplify === false, 'simplify 默认关闭');

  // 可复现：固定 seed 逐字节一致
  ok(obfuscate(simCases[0][0], { preset: 'high', shell: false, simplify: true, seed: 97 }).code ===
    obfuscate(simCases[0][0], { preset: 'high', shell: false, simplify: true, seed: 97 }).code,
    'simplify 固定 seed 可复现');
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
  // 界面选项表里查一项。显隐规则在元数据上，用的是 guiOptions() 那份拷贝，
  // 所以断言要查它而不是查 VALUE_OPTIONS 本身。
  const guiOpt = (key) => optionsMeta.guiOptions().find((o) => o.key === key) || null;
  const normalizeNameDict = (await import('../src/passes/mangle.js')).normalizeNameDict;
  {
    // Hexadecimal：字母 + 十六进制位，从 2 字符起步
    const want = runNode(shapeSrc, 'namestyle-shape-raw.js').trim();
    const hex = obfuscate(shapeSrc, { ...NAMEONLY, nameStyle: 'Hexadecimal', seed: 9 });
    const decls = declNames(hex.code);
    const hexShaped = decls.filter((n) => /^[A-Za-z][0-9a-f]{1,3}$/.test(n));
    ok(hexShaped.length >= 8, 'Hexadecimal 档发出的名字都是"字母+十六进制"形状', hexShaped.length + '/' + decls.length + '：' + hexShaped.slice(0, 8).join(' '));
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
    const words = decls.filter((n) => /^[a-z]{3,8}[0-9]*$/.test(n));
    ok(words.length >= 8, 'Dictionary 档发出的是可读词名', words.length + '/' + decls.length + '：' + words.slice(0, 8).join(' '));
    ok(!ORIG_NAMES.some((n) => dict.code.includes(n)), 'Dictionary 档把用户标识符全部换掉', ORIG_NAMES.filter((n) => dict.code.includes(n)).join(' '));
    let got = 'THREW';
    try { got = runNode(dict.code, 'namestyle-dict.js').trim(); } catch (e) { got = 'THREW'; }
    ok(got === want, 'Dictionary 档产物语义不变', got + ' ≠ ' + want);
    ok(obfuscate(shapeSrc, { ...NAMEONLY, nameStyle: 'Dictionary', seed: 9 }).code === dict.code, 'Dictionary 档同 seed 逐字节可复现');
    ok(obfuscate(shapeSrc, { ...NAMEONLY, nameStyle: 'Dictionary', seed: 10 }).code !== dict.code, 'Dictionary 档换 seed 换一套词');
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
    // 词表随之没有意义，所以与 chineseDictionary 一样不加闸门（与 html2memKey 同一口径）
    ok(optionsMeta.VALUE_OPTIONS.nameDictionary.showWhen
      && optionsMeta.VALUE_OPTIONS.nameDictionary.showWhen.key === 'nameStyle'
      && optionsMeta.VALUE_OPTIONS.nameDictionary.showWhen.equals === 'Dictionary',
    'nameDictionary 只在 nameStyle=Dictionary 时显示', JSON.stringify(optionsMeta.VALUE_OPTIONS.nameDictionary.showWhen));
    ok(optionsMeta.VALUE_OPTIONS.chineseDictionary.showWhen
      && optionsMeta.VALUE_OPTIONS.chineseDictionary.showWhen.key === 'nameStyle'
      && optionsMeta.VALUE_OPTIONS.chineseDictionary.showWhen.equals === 'Chinese',
    'chineseDictionary 只在 nameStyle=Chinese 时显示', JSON.stringify(optionsMeta.VALUE_OPTIONS.chineseDictionary.showWhen));
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
  // 会静默回落到默认档（选项存在但无效），这类漂移要有断言兜住
  ok(optionsMeta.VALUE_OPTIONS.nameStyle.values.join(',') === 'Mangled,Mangled-shuffled,Hexadecimal,Dictionary,Chinese',
    'nameStyle 枚举与实现同步', optionsMeta.VALUE_OPTIONS.nameStyle.values.join(','));
  for (const style of optionsMeta.VALUE_OPTIONS.nameStyle.values) {
    const r = obfuscate(namey, { preset: 'low', shell: false, nameStyle: style, seed: 9 });
    ok(typeof r.code === 'string' && r.code.length > 0, '枚举里的 ' + style + ' 档确实生效', r.code.length + ' 字节');
  }
}

section('属性名重命名（renameProperties）与保留名单（reservedNames/reservedStrings）');
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
    const on = obfuscate(rpSrc, { preset: 'low', shell: false, renameProperties: true, seed: 1 });
    const off = obfuscate(rpSrc, { preset: 'low', shell: false, renameProperties: false, seed: 1 });
    const st = on.stats.find((s) => s.pass === 'renameProperties');
    ok(st && st.result && st.result.renamed >= 3, 'renameProperties 开启时三处属性名同步改名',
      JSON.stringify(st && st.result));
    ok(!off.stats.some((s) => s.pass === 'renameProperties'), 'renameProperties 关闭时 pass 不出现');
    ok(on.code !== off.code, 'renameProperties 开启确实改动了产物');
    ok(runNode(on.code, 'rp-on') === rpWant && runNode(off.code, 'rp-off') === rpWant,
      'renameProperties 开/关语义一致');
  }

  // 白名单：body 在保留名单不改，len 不在则改（定义 ∩ 访问均命中）
  {
    const bodySrc = `var o = { body: 1, len: 2 };
process.stdout.write(String(o.body + o.len) + '\\n');`;
    const r = obfuscate(bodySrc, { preset: 'low', shell: false, renameProperties: true, seed: 1 });
    const st = r.stats.find((s) => s.pass === 'renameProperties');
    ok(st && st.result && st.result.renamed === 1, '白名单属性（body）不改、非白名单（len）改',
      JSON.stringify(st && st.result));
    ok(runNode(r.code, 'rp-body') === '3\n', '白名单样例语义正确');
  }

  // 组合：high 预设 + renameProperties 全链路语义不变（2 seed）
  {
    let comboBad = '';
    for (let seed = 1; seed <= 2 && !comboBad; seed++) {
      for (const rp of [false, true]) {
        const code = obfuscate(rpSrc, { preset: 'high', shell: false, renameProperties: rp, seed }).code;
        let got;
        try { got = runNode(code, 'rp-combo-' + seed + '-' + rp); } catch (e) { got = 'THREW'; }
        if (got !== rpWant) { comboBad = 'seed=' + seed + ' rp=' + rp + ' → ' + got.slice(0, 40); break; }
      }
    }
    ok(comboBad === '', 'high 预设 + renameProperties 全链路语义不变', comboBad);
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

  // 门控：free 锁死 renameProperties（reservedNames/reservedStrings 是减混淆兼容功能，不门控）
  ok(plan.violations({ renameProperties: true }, 'free').length === 1, 'free 档 renameProperties 锁死');
  ok(plan.violations({ renameProperties: false }, 'free').length === 0, 'free 档关闭放行');
  ok(plan.violations({ renameProperties: true }, 'plus').length === 0, 'plus 档 renameProperties 放行');
  ok(obfuscateMod.DEFAULTS.renameProperties === false, 'renameProperties 默认关闭');

  // 可复现
  ok(obfuscate(rpSrc, { preset: 'high', shell: false, renameProperties: true, seed: 97 }).code ===
    obfuscate(rpSrc, { preset: 'high', shell: false, renameProperties: true, seed: 97 }).code,
    'renameProperties 固定 seed 可复现');
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

if (process.argv[1] && process.argv[1].endsWith('minify.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}
