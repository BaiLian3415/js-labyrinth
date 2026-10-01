#!/usr/bin/env node
/**
 * 核心混淆与 HTML 内联处理。产物可执行、固定 seed 可复现、闸门按档位拦截。
 *
 *   node test/core-obfuscate.js
 *
 * 整跑全部用例：npm test（即 node test/selftest.js）。
 */
import { SAMPLE, VERBOSE, cleanTmp, ok, report, runNode, section, throws } from './_harness.js';
import obfuscateMod from '../src/obfuscate.js';
import htmlMod from '../src/html.js';
import gate from '../src/options-gate.js';
import plan from '../src/plan.js';
import licenseWeb from '../src/license-web.js';

const { obfuscate } = obfuscateMod;
const { obfuscateDocument } = htmlMod;

// 测试专用签发密钥对。
//
// 真私钥不随源码分发（这正是换成非对称的目的），所以自测不能拿它签卡——也不该
// 拿。测试自己固定一对：种子写死在这里，公钥由它派生，再通过 setKeyMaterial /
// JSLB_CODE_KEY 注入到 license-web 与 Worker。走的签发/校验代码路径与线上完全
// 相同，只有密钥不同。种子是公开的常量，仅供测试，绝不能用于真实发卡。
const TEST_CODE_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
section('核心混淆');
const OUTPUTS = {};
for (const preset of ['low', 'medium', 'max']) {
  const t0 = Date.now();
  const r = obfuscate(SAMPLE, { preset, seed: 20240918 });
  OUTPUTS[preset] = r;
  const out = runNode(r.code, 'core-' + preset + '.js');
  ok(out.includes('hello world') && out.includes('big-even') && out.includes('13'),
    preset + ' 产物可执行且语义不变', out.trim().split('\n').pop());
  ok(r.obfuscatedSize > r.originalSize, preset + ' 产物确实变大了', r.originalSize + ' → ' + r.obfuscatedSize);
  if (VERBOSE) console.log('    ' + preset + ': ' + (Date.now() - t0) + ' ms');
}
{
  const a = obfuscate(SAMPLE, { preset: 'medium', seed: 7 }).code;
  const b = obfuscate(SAMPLE, { preset: 'medium', seed: 7 }).code;
  const c = obfuscate(SAMPLE, { preset: 'medium', seed: 8 }).code;
  ok(a === b, '固定 seed 可复现');
  ok(a !== c, '不同 seed 产出不同');
  ok(OUTPUTS.low.code !== OUTPUTS.max.code, '不同预设产出不同');
}
throws(() => obfuscate(SAMPLE, { preset: 'nope' }), '未知预设报错');
throws(() => obfuscate(SAMPLE, { identifierPrefix: '0x' }), '非法 identifierPrefix 报错');
throws(() => obfuscate('const a = ;', {}), '语法错误输入报错');
ok(typeof obfuscate('#!/usr/bin/env node\nconsole.log(1)', { preset: 'low' }).code === 'string',
  '带 hashbang 的输入可处理');

section('HTML 内联脚本');
{
  const html = '<!DOCTYPE html><html><head>'
    + '<script src="https://cdn.example.com/lib.js"></script>'
    + '<script type="application/json">{"a":1}</script>'
    + '<script>var answer = 40 + 2; console.log("inline", answer);</script>'
    + '</head><body><p>keep me</p>'
    + '<script>console.log("second", answer);</script>'
    + '</body></html>';
  const r = obfuscateDocument(html, obfuscateMod.resolveOptions({ preset: 'low', seed: 5 }));
  ok(r.info.obfuscated === 2, '两个内联块都被混淆', JSON.stringify(r.info));
  ok(r.info.skippedExternal === 1, '外部 src 被跳过');
  ok(r.info.skippedType === 1, '非 JS type 被跳过');
  ok(r.html.includes('cdn.example.com/lib.js') && r.html.includes('{"a":1}'), '被跳过的脚本原样保留');
  ok(r.html.includes('keep me'), '正文未被改动');
  ok(r.warnings.some((w) => w.includes('answer')), '跨块共享给出警告');
  ok(!/var answer = 40/.test(r.html), '原内联脚本已被替换');
}
{
  const html = '<p>no scripts here</p>';
  const r = obfuscateDocument(html, obfuscateMod.resolveOptions({ preset: 'low' }));
  ok(r.html === null && r.info.obfuscated === 0, '无内联脚本时返回 null');
}

section('套餐闸门与提示');
{
  const plusEnt = { ...plan.describe('plus'), trial: false };
  ok(gate.checkOptions({ preset: 'high' }, plusEnt).ok, '套餐自带预设可用（Plus 上限为 high）');
  ok(!gate.checkOptions({ preset: 'max' }, plusEnt).ok, '超出套餐预设上限被拦');
  // 这两条必须挑 Plus **确实还拦着**的项：提档会连带放宽若干开关与数值，原先拿
  // envFingerprint / 更松的阈值当样本，2026-09-22 把 Plus 提到 high 后就变成了
  // "本该被拦却被放行"的假失败。
  ok(!gate.checkOptions({ consoleStub: true }, plusEnt).ok, '套餐不提供的开关被拦');
  ok(!gate.checkOptions({ controlFlowDepth: 3 }, plusEnt).ok, '超上限的数值被拦');
  ok(gate.checkOptions({ preset: 'low', mangle: false }, plusEnt).ok, '关掉开关始终允许');
  ok(gate.checkOptions({}, plusEnt).ok, '什么都不写不被拦（用套餐自带预设）');
  // 外壳形态：free 锁 classic，Plus 起可用（与 domainLock / simplify 同一条"付费档"线）
  const freeEnt = plan.describe('free');
  ok(!gate.checkOptions({ shellForm: 'jsfuck' }, freeEnt).ok, 'free 档拦下 jsfuck 外壳形态');
  ok(gate.checkOptions({ shellForm: 'classic' }, freeEnt).ok, 'free 档放行 classic 外壳形态');
  ok(gate.checkOptions({ shellForm: 'jsfuck' }, plusEnt).ok, 'Plus 档放行 jsfuck 外壳形态');
  // 档位阶梯（低档每一项都不得超过高档）由 plan.js 的 assertConsistent() 在模块
  // 加载时对所有相邻档位校验：预设上限单调、配额单调、闸门不倒挂。这里不再重复，
  // 能跑到这一行就说明阶梯成立。

  const businessEnt = plan.describe('business');
  ok(gate.checkOptions({ preset: 'max', shellForm: 'jsfuck', shellDepth: 4 }, businessEnt).ok, '顶档全部放行');

  const trial = licenseWeb.trialEntitlements();
  const r = gate.checkOptions({ preset: 'high' }, trial);
  ok(!r.ok && r.kind === 'preset', '试用模式按预设上限拦截');
  ok(gate.checkOptions({ preset: trial.preset }, trial).ok, '试用模式自带预设可跑通');
  ok(typeof gate.presetBlockedText(r, trial) === 'string'
    && gate.presetBlockedText(r, trial).length > 0, '预设越界有本地化提示');
  const v = gate.checkOptions({ debugProtection: true }, trial);
  ok(!v.ok && typeof gate.violationText(v.hits[0], trial) === 'string', '逐项闸门有本地化提示');
}

if (process.argv[1] && process.argv[1].endsWith('core-obfuscate.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}
