#!/usr/bin/env node
/**
 * 指纹与选项面回归：把审计里那几类"静默变成指纹 / 静默漂移"钉成断言。
 *
 *   node test/fingerprint.js
 *   整跑全部用例：npm test（即 node test/selftest.js）。
 *
 * 覆盖四件事：
 *   1. 引导锚点字面量、loader 死代码暂存名、解释器/JSFuck 预置名都**没有**固定形状；
 *   2. 四档预设与 DEFAULTS 的键集合对齐（预设不写未知键、DEFAULTS 不留没声明的键）；
 *   3. 被引用的 i18n 键真的存在（`t()` 找不到时会原样返回键名，用户看到的是标识符）；
 *   4. 拼错的选项键会被点名（且给出最接近的已知键），而不是静默无效。
 */
import { cleanTmp, ok, report, section } from './_harness.js';
import obfuscateMod from '../src/obfuscate.js';
import optionsMeta from '../src/options-meta.js';
import i18n from '../src/i18n.js';

const { obfuscate } = obfuscateMod;
const DEFAULTS = obfuscateMod.DEFAULTS;
const PRESETS = obfuscateMod.PRESETS;

const SRC = 'function secret(a,b){var k="s3cr3t-token-9f2a";if(a>b){return k+a;}return "no-"+b;}'
  + ' process.stdout.write(String(secret(2,1)));';

// ---------------------------------------------------------------- 1. 指纹
section('指纹：固定形状不得跨构建复现');
{
  // 引导锚点字面量：引导层的第一条 `var <名>="<随机 token>"`。
  // 历史教训：它曾经固定写成 'jr' + 16 位 hex，落在产物第一条语句里，不受 mangle /
  // shell / nameStyle 任何一层影响 —— 一条正则就能 100% 认出本工具（2026-10-11 改）。
  const ANCHOR_RE = /^\s*var [A-Za-z_$][\w$]*="([A-Za-z][A-Za-z0-9]{14,30})";?\s*$/m;
  const anchors = [];
  for (let seed = 1; seed <= 12; seed++) {
    const c = obfuscate(SRC, { preset: 'medium', seed }).code;
    const m = c.match(ANCHOR_RE);
    if (m) anchors.push(m[1]);
  }
  ok(anchors.length === 12, '12 个 seed 都能定位到引导锚点字面量', String(anchors.length));
  const heads = new Set(anchors.map((a) => a.slice(0, 2)));
  const lens = new Set(anchors.map((a) => a.length));
  ok(heads.size >= 8, '锚点前缀逐构建分散（不再有固定前缀）', '不同前两字符 ' + heads.size);
  ok(lens.size >= 3, '锚点长度逐构建分散（不再有固定长度）', '不同长度 ' + lens.size);
  ok(!anchors.some((a) => /^jr[0-9a-f]{16}$/.test(a)), '旧的 jr+16hex 形状一次都不出现');

  // loader 死代码暂存名：曾经是三个常量前缀 `_0qz`/`_0qj`/`_0qx` + 4 位 hex，
  // 实测每个产物残留 3~15 处（2026-10-11 改成逐构建随机前缀，且字母池去掉 q）。
  const junkNames = new Set();
  for (const preset of ['low', 'medium', 'high', 'max']) {
    for (const seed of [3, 11]) {
      const c = obfuscate(SRC, { preset, seed }).code;
      for (const n of c.match(/_0[a-z][a-z][0-9a-f]{4}/g) || []) junkNames.add(n);
    }
  }
  ok(junkNames.size > 0, '成品里确实存在 loader 死代码暂存名（断言不是空转）', String(junkNames.size));
  ok(![...junkNames].some((n) => /^_0q[zjx]/.test(n)), '旧的 _0q[zjx] 前缀一次都不出现');

  // 解释器 / JSFuck 预置名：形状是「前缀 + 9~13 位 hex」。长度必须随机——
  // 固定 9 位本身就是一个位宽指纹（2026-10-11 改）。这两个名字在 shellForm
  // 为 jsfuck/bytecode 时才出现，且刻意不随机化（流水线之外，够不着 randomizeNames）。
  const hexLens = new Set();
  for (let seed = 1; seed <= 10; seed++) {
    const c = obfuscate(SRC, { preset: 'medium', seed, shellForm: 'jsfuck' }).code;
    for (const n of c.match(/_0x[0-9a-f]{9,13}\b/g) || []) hexLens.add(n.length - 3);
  }
  ok(hexLens.size >= 3, '预置名的 hex 位宽逐构建分散', '观察到位宽 ' + [...hexLens].sort().join(','));
}

// ---------------------------------------------------------- 2. 选项键集合
section('选项面：预设与 DEFAULTS 的键集合必须对齐');
{
  for (const [name, preset] of Object.entries(PRESETS)) {
    const unknown = Object.keys(preset).filter((k) => !(k in DEFAULTS));
    ok(unknown.length === 0, '预设 ' + name + ' 不含 DEFAULTS 之外的键', unknown.join(','));
  }
  // 反向：DEFAULTS 里每个键都必须能在某处被查到（VALUE_OPTIONS / BOOL_OPTIONS /
  // KNOWN_OPTION_KEYS）。历史教训：bannerSkip 只被 obfuscate.js 读，三处都查不到，
  // 于是 API 传进来生效却没人知道它存在（2026-10-11 补声明）。
  const declared = new Set([...Object.keys(optionsMeta.VALUE_OPTIONS), ...optionsMeta.BOOL_OPTIONS]);
  const undeclared = Object.keys(DEFAULTS).filter((k) => !declared.has(k));
  ok(undeclared.length === 0, 'DEFAULTS 的每一项都在 VALUE_OPTIONS 或 BOOL_OPTIONS 里', undeclared.join(','));
  ok(optionsMeta.KNOWN_OPTION_KEYS.has('bannerSkip'), 'bannerSkip 是已知选项（内部项也要声明）');
  ok(!optionsMeta.guiOptions().some((o) => o.key === 'bannerSkip'), 'bannerSkip 不进界面（guiHide 生效）');
  ok(!optionsMeta.KNOWN_OPTION_KEYS.has('dirCopyOthers'), 'dirCopyOthers 幽灵项已删除');
  ok(!optionsMeta.BOOL_OPTIONS.has('dirCopyOthers'), 'dirCopyOthers 不在 BOOL_OPTIONS 里');
}

// ------------------------------------------------------------------ 3. i18n
section('i18n：被引用的键必须有定义');
{
  // vm.js 里这两处曾引用不存在的键，t() 会把键名原样返回，用户看到
  // "混淆失败: vmWasmTooManyParams"（2026-10-11 补）。
  for (const key of ['vmWasmTableFull', 'vmWasmTooManyParams', 'warnUnknownOption']) {
    i18n.setLang('zh');
    ok(i18n.t(key) !== key, 'zh 有 ' + key);
    i18n.setLang('en');
    ok(i18n.t(key) !== key, 'en 有 ' + key);
  }
  i18n.setLang('zh');
}

// ------------------------------------------------------- 4. 未知/拼错的键
section('选项面：未知键必须点名（不能静默无效）');
{
  const r = obfuscate(SRC, { preset: 'low', seed: 5, wasmInterpretr: true, integrtyCheck: false });
  const w = (r.warnings || []).map(String).join(' | ');
  ok(/wasmInterpretr/.test(w), '点出拼错的键', w.slice(0, 120));
  ok(/wasmInterpreter/.test(w), '给出最接近的已知键', w.slice(0, 120));
  ok(/integrityCheck/.test(w), '另一个拼错的键也能给出建议', w.slice(0, 120));
  const clean = obfuscate(SRC, { preset: 'low', seed: 5, consoleStub: false, bannerSkip: false, target: 'node' });
  ok(!(clean.warnings || []).length, '全是已知键时不产生噪声告警',
    (clean.warnings || []).join(' | '));
}

// 单跑本文件时自己汇总：不调 report() 的话断言失败不会反映到退出码——
// 那正是"永远不会失败的测试"。
if (process.argv[1] && process.argv[1].endsWith('fingerprint.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}
