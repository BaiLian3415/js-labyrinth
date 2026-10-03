#!/usr/bin/env node
/**
 * ESM 模块折叠（esmFold）：静态 import/export 折叠成动态 import + 单出口，模块体
 * 进 IIFE，import 绑定改写为命名空间属性访问。
 *
 *   node test/esm-fold.js
 *
 * 整跑全部用例：npm test（即 node test/selftest.js）。
 *
 * 产物是 ESM（顶层保留 export 出口），临时文件必须写 .mjs 才能按模块运行；
 * 相对说明符按产物所在目录解析，依赖模块同目录落盘。
 *
 * 输出一律走 process.stdout.write 而不是 console.log：max 档开了 consoleStub，
 * 会把 console 系列换成桩（那是它的既有语义，不是缺陷），拿 console 比对只会
 * 得到空输出，把干净产物误判成坏了。
 */
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { TMP, cleanTmp, ok, report, runNode, section } from './_harness.js';
import obfuscateMod from '../src/obfuscate.js';

const { obfuscate } = obfuscateMod;

const moduleBase = pathToFileURL(path.join(TMP, '/')).href;

// 依赖模块。depA 出命名导出，depB 出默认导出与命名导出，depC 供活再导出用。
fs.writeFileSync(path.join(TMP, 'depA.mjs'),
  'export const A = 40;\nexport function fa() { return 11; }\n');
fs.writeFileSync(path.join(TMP, 'depB.mjs'),
  'export default 2;\nexport const B = 3;\n');
fs.writeFileSync(path.join(TMP, 'depC.mjs'),
  'export const C1 = 10;\nexport const C2 = 20;\n');

// 静态 import 声明的四种形态：副作用导入 / 命名导入 / 默认导入 / 命名空间导入。
// 折叠后只剩动态 import(，静态形态一条都不该留下。
const STATIC_IMPORT_RE = /\bimport\s*[\{*"']|\bimport\s+[A-Za-z0-9_$]/;

section('ESM 折叠：基础形态（无顶层 await）');
{
  const payload = [
    "import { A, fa } from './depA.mjs';",
    'import DB, { B } from \'./depB.mjs\';',
    'const sum = A + B + DB;',
    'export const X = sum;',
    'export function fx() { return A + fa(); }',
    'export default sum * 2;',
    'process.stdout.write([X, fx(), DB].join(" ") + "\\n");',
  ].join('\n');
  const want = runNode(payload, 'esf-plain.mjs').trim();

  let noStat = '';
  let noDyn = '';
  let noExp = '';
  let mismatch = '';
  for (let seed = 1; seed <= 3; seed++) {
    const r = obfuscate(payload, { preset: 'medium', esmFold: true, seed, shell: false, moduleBase });
    const st = r.stats.find((s) => s.pass === 'esmFold');
    if (!st || !st.result || st.result.folded !== true) {
      noStat = 'seed ' + seed + '：esmFold 未记录 folded=true';
    } else if (st.result.imports !== 2 || st.result.exports !== 3 || st.result.tla !== false) {
      noStat = 'seed ' + seed + '：统计口径 ' + JSON.stringify(st.result);
    }
    if (STATIC_IMPORT_RE.test(r.code)) noDyn = 'seed ' + seed + '：仍残留静态 import 声明';
    if (!/\bimport\s*\(/.test(r.code)) noDyn = 'seed ' + seed + '：找不到动态 import(';
    if (!/\bexport\s*\{/.test(r.code) || !/\bexport\s+default\b/.test(r.code)) noExp = 'seed ' + seed + '：出口被折叠掉了';
    const got = runNode(r.code, 'esf-m-' + seed + '.mjs').trim();
    if (got !== want && !mismatch) mismatch = 'seed ' + seed + '：混淆后 ' + got.slice(0, 40) + '，应为 ' + want;
  }
  ok(noStat === '', 'esmFold 统计口径正确（2 个 import、3 个出口、无顶层 await）', noStat);
  ok(noDyn === '', '静态 import 声明全部换成动态 import(（3 seed）', noDyn);
  ok(noExp === '', '出口保留：命名 export 与 default export 都在（3 seed）', noExp);
  ok(mismatch === '', '折叠后语义保持（3 seed）', mismatch);
}

section('ESM 折叠：活再导出保留原语句');
{
  // export * from / export {x} from 带 source，无法折进标识符绑定：原语句留在
  // 顶层（唯一的结构残留），其余照旧折叠。语义上这是活绑定透传，运行结果不变。
  const payload = [
    "import { A } from './depA.mjs';",
    "export * from './depC.mjs';",
    'export { A as AA };',
    'process.stdout.write(A + "\\n");',
  ].join('\n');
  const want = runNode(payload, 'esf-plain2.mjs').trim();
  const r = obfuscate(payload, { preset: 'medium', esmFold: true, seed: 5, shell: false, moduleBase });
  const st = r.stats.find((s) => s.pass === 'esmFold');
  ok(st && st.result && st.result.folded === true && st.result.reexports === 1,
    '活再导出计入统计（reexports=1）', st ? JSON.stringify(st.result) : '无 esmFold 统计');
  ok(/export\s*\*\s*from/.test(r.code), 'export * from 原语句保留在顶层');
  ok(!STATIC_IMPORT_RE.test(r.code), '普通 import 仍被折叠（顶层只剩活再导出语句）');
  ok(runNode(r.code, 'esf-reexport.mjs').trim() === want, '活再导出场景语义保持');
}

section('ESM 折叠：顶层 await 走 async 内层');
{
  // 体内有顶层 await 时不再拆同步内层（await 进不了同步函数）：整个模块体直接
  // 进外层 async IIFE。await 的位置语义（模块初始化期间求值）必须保持。
  const payload = [
    "import { A } from './depA.mjs';",
    'const v = await Promise.resolve(A + 1);',
    'export const W = v * 2;',
    'process.stdout.write(W + "\\n");',
  ].join('\n');
  const want = runNode(payload, 'esf-plain3.mjs').trim();
  const r = obfuscate(payload, { preset: 'medium', esmFold: true, seed: 9, shell: false, moduleBase });
  const st = r.stats.find((s) => s.pass === 'esmFold');
  ok(st && st.result && st.result.folded === true && st.result.tla === true,
    '顶层 await 被识别（tla=true）', st ? JSON.stringify(st.result) : '无 esmFold 统计');
  ok(runNode(r.code, 'esf-tla.mjs').trim() === want, '顶层 await 场景语义保持');
}

section('ESM 折叠：预设闸门（low 档不折叠）');
{
  // low 预设 esmFold=false：模块结构原样保留（静态 import 声明还在），只过其他
  // pass。这条钉的是"预设值真的在起作用"——选项没被误开后，产物形态必须不同。
  const payload = "import { A } from './depA.mjs';\nexport const Y = A + 1;\nprocess.stdout.write(Y + \"\\n\");\n";
  const want = runNode(payload, 'esf-plain4.mjs').trim();
  const low = obfuscate(payload, { preset: 'low', seed: 11, shell: false, moduleBase });
  ok(STATIC_IMPORT_RE.test(low.code), 'low 档（esmFold 默认关）保留静态 import 声明');
  ok(!/\bimport\s*\(/.test(low.code), 'low 档产物里不出现动态 import(');
  ok(runNode(low.code, 'esf-low.mjs').trim() === want, 'low 档 ESM 载荷语义保持');
}

section('ESM 折叠：max 档默认开启且可复现');
{
  // max 预设 esmFold=true（默认值）：同一 seed 两次构建逐字节一致（字节基线
  // 断言），产物语义保持。max 档全链路（VM/wasm/壳内层）都要吃下折叠后的形态。
  const payload = [
    "import { A, fa } from './depA.mjs';",
    'import DB, { B } from \'./depB.mjs\';',
    'export const X = A + B + DB;',
    'export default fa() + X;',
    'process.stdout.write(X + "\\n");',
  ].join('\n');
  const want = runNode(payload, 'esf-plain5.mjs').trim();
  const a = obfuscate(payload, { preset: 'max', seed: 21, moduleBase });
  const b = obfuscate(payload, { preset: 'max', seed: 21, moduleBase });
  ok(a.code === b.code, 'max 档 ESM 载荷固定 seed 可复现');
  const st = a.stats.find((s) => s.pass === 'esmFold');
  ok(st && st.result && st.result.folded === true, 'max 档默认走 esmFold', st ? JSON.stringify(st.result) : '无 esmFold 统计');
  ok(runNode(a.code, 'esf-max.mjs').trim() === want, 'max 档 ESM 载荷语义保持');
}

if (process.argv[1] && process.argv[1].endsWith('esm-fold.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}
