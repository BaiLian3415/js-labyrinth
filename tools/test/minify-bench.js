// 压缩能力基准：把"我们到底有多接近真正的 minifier"量出来。
//
//   npm run bench:minify                     与 terser 对比
//   npm install --no-save terser              （terser 不是依赖，缺了就只报绝对体积）
//   npm install --no-save javascript-obfuscator   再加一列 obfuscator.io 同口径数据
//
// 为什么这么量：
//   - 以 terser 为基准（`compress + mangle`，事实标准的 minifier），比的是**同输入
//     产物体积的倍数**。倍数比"缩小了百分之几"更能跨输入比较，也不受输入本身松紧影响。
//   - 输入取本仓库真实源码（手写、无死代码）+ 一段"打包产物式"模块（批量死角函数），
//     两类都报：前者代表正常源码，后者代表 bundle——DCE 的价值只在前者缺失、后者常见。
//   - 固定 seed，同输入同选项可复现；只比体积，语义由 npm test 兜底。
//
// 量出来的结论（2026-09-25，Node 24）：
//   真实源码：我们 1.18~1.58× terser，obfuscator.io（compact+simplify）1.49~1.89×；
//   含死代码的 bundle：我们 3.5 KB，obfuscator.io 13.6 KB（他们不做无用声明消除）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import obfuscateMod from '../../src/obfuscate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const obfuscate = obfuscateMod.default || obfuscateMod.obfuscate || obfuscateMod;

const SEED = 20260920;
const kb = (n) => (n / 1024).toFixed(1).padStart(7) + 'K';
const ratio = (n, base) => (n / base).toFixed(2).padStart(5) + '×';

/** 压缩档：除压缩相关的 pass 外全关（它就是"作为 minifier 用"的那套配置）。 */
const MINIFY = {
  preset: 'low', seed: SEED, shell: false, bannerSkip: true, compact: true, mangle: true,
  stringArray: false, controlFlowFlattening: false, logicalExpressions: false,
  conditionObfuscation: false, opaquePredicates: false, deadCodeInjection: false,
  functionWrapper: false, callProxy: false, objectKeyEncoding: false,
  numberObfuscation: false, templateToConcat: false, selfCheck: false, stringSplitPriority: 0,
  stringSplitProbability: 0,
};

/** 打包产物式输入：一批没人调用的辅助函数 + 未用变量，外加三条被真正用到的路径。 */
function bundleLike() {
  let out = 'export const VERSION = 1;\n';
  for (let i = 0; i < 40; i++) {
    out += 'function deadHelper' + i + '(a, b) { var tmp = a * ' + i + ' + b; if (tmp > 9) { tmp -= 2; } return tmp; }\n'
      + 'var deadConst' + i + ' = { idx: ' + i + ', tags: ["a", "b", "c"] };\n'
      + 'function live' + i + '(x) { let acc = 0; for (let k = 0; k < x.length; k++) { acc += x[k] * ' + (i + 1) + '; } return acc; }\n';
  }
  return out + 'export function report() { return [live0([1, 2, 3]), live1([4, 5]), live39([6])].join("|"); }\n';
}

const INPUTS = [
  ['src/obfuscate.js', fs.readFileSync(path.join(ROOT, 'src/obfuscate.js'), 'utf8')],
  ['src/passes/vm.js', fs.readFileSync(path.join(ROOT, 'src/passes/vm.js'), 'utf8')],
  ['src/ast/parser.js', fs.readFileSync(path.join(ROOT, 'src/ast/parser.js'), 'utf8')],
  ['bundle 式模块（含死代码）', bundleLike()],
];

let minify = null;
try { ({ minify } = await import('terser')); } catch (e) { /* 可选依赖 */ }
let obfIo = null;
try {
  const m = await import('javascript-obfuscator');
  obfIo = m.default || m;
} catch (e) { /* 可选依赖 */ }

console.log('压缩能力基准（seed=' + SEED + '，基准 = terser compress+mangle）\n');
if (!minify) console.log('提示：未安装 terser，只能看到绝对体积；npm install --no-save terser 可加基准列。');
if (!obfIo) console.log('提示：未安装 javascript-obfuscator；npm install --no-save javascript-obfuscator 可加 obfuscator.io 同口径列。');
console.log('');

const head = '输入'.padEnd(26) + '原始'.padStart(9) + 'terser'.padStart(9)
  + 'random'.padStart(15) + 'short'.padStart(15) + 'short+DCE'.padStart(15)
  + (obfIo ? 'obfuscator.io'.padStart(17) : '');
console.log(head);
console.log('-'.repeat(head.length));

for (const [name, code] of INPUTS) {
  const base = minify ? (await minify(code, { module: true, compress: true, mangle: true })).code.length : code.length;
  const rows = [
    ['random', { nameStyle: 'random', simplify: false }],
    ['short', { nameStyle: 'short', simplify: false }],
    ['short+DCE', { nameStyle: 'short', simplify: true }],
  ];
  let line = name.padEnd(26) + kb(code.length).padStart(9).trimEnd().padStart(9) + kb(base);
  for (const [, extra] of rows) {
    const r = obfuscate(code, { ...MINIFY, ...extra });
    line += kb(r.code.length) + (minify ? ratio(r.code.length, base) : '');
  }
  if (obfIo) {
    const out = obfIo.obfuscate(code, {
      compact: true, simplify: true, identifierNamesGenerator: 'hexadecimal',
      stringArray: false, deadCodeInjection: false, controlFlowFlattening: false,
      numbersToExpressions: false, unicodeEscapeSequence: false, target: 'browser',
    }).getObfuscatedCode().length;
    line += kb(out) + (minify ? ratio(out, base) : '');
  }
  console.log(line);
}
console.log('');
console.log('读法：short+DCE 那列就是"当 minifier 用"的成绩；random 列是混淆档的命名策略');
console.log('（长随机名，防指纹优先），它比 short 大一截是设计选择，不是缺陷。');