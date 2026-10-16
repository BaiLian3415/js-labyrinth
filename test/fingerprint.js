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
import hideMod from '../src/utils/hide.js';

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

  // 外壳层固定短名：randomizeNames 名单漏一项，产物里就多一个跨构建固定的
  // `_0x` 名。2026-10-13 实测 shell:true（classic/bytecode）3 seed 交集
  // {_0b,_0f,_0ts,_0x}：_0b 是 mul32 形参、_0x 是 lcg 形参、_0f/_0ts 是 _0ph
  // 探针模板的形参与局部量——它们的兄弟（_0a/_0n/_0e/_0g）都在名单里，唯独
  // 这几个漏了。_0x0.._0x3（mul32 8 位拆分版局部量）同批补进，做全覆盖。
  // \b 安全性已在名单注释里论证（_0xG 载体、_0x1a2b 机器名都不匹配）。
  {
    const FIXED = ['_0b', '_0f', '_0ts', '_0x', '_0x0', '_0x1', '_0x2', '_0x3'];
    let bad = '';
    for (const form of [undefined, 'bytecode']) {
      const sets = [];
      for (let seed = 1; seed <= 3; seed++) {
        const c = obfuscate(SRC, { preset: 'high', seed, shell: true, ...(form ? { shellForm: form } : {}) }).code;
        const names = new Set();
        for (const m of c.matchAll(/(?<![A-Za-z0-9_$])_0[A-Za-z0-9]{1,9}(?![A-Za-z0-9_$])/g)) names.add(m[0]);
        sets.push(names);
      }
      const leaked = FIXED.filter((n) => sets.every((s) => s.has(n)));
      if (leaked.length) { bad = 'shell:' + (form || 'classic') + ' 仍固定 ' + leaked.join(' '); break; }
    }
    ok(!bad, '外壳层短名无跨构建固定项（旧码交集 {_0b,_0f,_0ts,_0x}）', bad);
  }

  // globalThis 引用链：原先在 5 个模块里各写一份、**逐字节相同**（hide / domainLock /
  // integrityCheck / stringArray / banner）。它出现在每一份产物里，攻击者 grep 一次
  // 就能认出工具——比 bigram 相似度更直接可用的指纹。2026-10-15 实测改造前 8/8 个
  // seed 的产物都逐字节命中。现在逐构建随机形态（utils/hide.js 是唯一真源）。
  //
  // 判据用**逐字节常量**而不是"链的某个片段"：后者会被 conditionObfuscation 的括号
  // 改写（typeof void 0 → typeof (void 0)）打散，grep 不到，等于断言恒真。
  {
    const OLD = 'typeof globalThis!==typeof void 0?globalThis:typeof self!==typeof void 0?self:'
      + 'typeof window!==typeof void 0?window:typeof global!==typeof void 0?global:{}';
    let hit = 0, seen = 0;
    for (const preset of ['low', 'medium', 'high', 'max']) {
      for (const seed of [1, 2, 3]) {
        for (const shell of [true, false]) {
          const c = obfuscate(SRC, { preset, seed, shell }).code;
          seen++;
          if (c.includes(OLD)) hit++;
        }
      }
    }
    ok(hit === 0, '产物里不再有逐字节相同的 globalThis 引用链（旧码 24/24 命中）',
      hit + '/' + seen);
  }

  // 形态等价性：随机形态必须与原始形态**逐值等价**。
  //
  // 这条是给 `===` 那个坑设的：把条件取反写成「操作数交换」(`typeof void 0!==typeof G`)
  // 看着像取反，实际 `a!==b` 与 `b!==a` 是同一条命题，于是 globalThis 已定义时仍然
  // 走进兜底分支，Node 上返回未定义的 self/window 直接 ReferenceError。
  // 症状极偏：只有开 antiCDP / debugProtection 的产物才炸（那两处是唯一把它注入到
  // 多处的），与病因隔了两层——所以判据直接落在形态生成器上。
  //
  // 老码上 hide.js 没有 globalRef（只有常量 GLOBAL_EXPR），先判存在性再断言，
  // 让它在老码上**干净失败**而不是崩掉整个文件。
  if (typeof hideMod.globalRef !== 'function') {
    ok(false, 'utils/hide.js 导出 globalRef()（老码只有常量 GLOBAL_EXPR）');
  } else {
    // 采样足够多的调用把形态收集齐（4 层独立取反共 16 种，历史那一份被剔掉 → 15 种）
    const shapes = new Set();
    for (let i = 0; i < 600; i++) shapes.add(hideMod.globalRef());
    ok(shapes.size >= 8, 'globalRef 形态逐构建分散（4 层独立取反）',
      '采样 600 次得到 ' + shapes.size + ' 种');
    ok(shapes.size <= 15 && shapes.size >= 15, '形态总数 15 种（历史形态已从池里剔掉）',
      '得到 ' + shapes.size + ' 种');

    // 在三种真实宿主上逐一比对：node / browser / worker。判据是「与第 0 号形态同值」。
    const HOSTS = [
      ['node（global + globalThis）', { globalThis: 'GT', self: undefined, window: undefined, global: 'GL' }],
      ['browser（globalThis + self + window）', { globalThis: 'GT', self: 'SE', window: 'WI', global: undefined }],
      ['worker（globalThis + self）', { globalThis: 'GT', self: 'SE', window: undefined, global: undefined }],
    ];
    const NAMES = ['globalThis', 'self', 'window', 'global'];
    const list = [...shapes];
    const baseline = list[0];
    let bad = '';
    for (const [hname, env] of HOSTS) {
      const want = NAMES.map((n) => env[n]).find((v) => v !== undefined);
      for (const s of list) {
        let got;
        try {
          got = new Function(NAMES.join(','), 'return (' + s + ');')(...NAMES.map((n) => env[n]));
        } catch (e) { got = 'THROW:' + e.constructor.name; }
        if (got !== want) { bad = hname + ' 下形态不等：' + s.slice(0, 90); break; }
      }
      if (bad) break;
    }
    ok(!bad, '全部形态在 node/browser/worker 上与基准形态同值（取反必须是 ===）', bad);
  }

  // 掩码串 IIFE 形人与 catch 形参：hide.js 的 `_0T` 与三处 header 模板的
  // `catch(_0w)` 都是纯文本模板里的固定名，mangle 够不着 mangle 之后才注入的
  // integrityCheck 头部，跨构建固定（2026-10-13 实测：单个产物 163 处 `_0T`、
  // integrityCheck 开关对照确认来源）。现逐构建随机，判据是"多 seed 交集为空"。
  // 注意与 stringArray 短名区分：`_0x` + 1 位 hex 只有 16 个槽位，每构建十几次
  // 抽取，3 seed 交集非空是生日碰撞的数学必然，不是固定指纹——不断言它。
  {
    const tSets = [], wSets = [];
    for (let seed = 1; seed <= 3; seed++) {
      const c = obfuscate(SRC, { preset: 'high', seed, shell: false }).code;
      const t = new Set();
      for (const m of c.matchAll(/(?<![A-Za-z0-9_$])_0[A-Za-z]{1,4}(?![A-Za-z0-9_$])/g)) t.add(m[0]);
      tSets.push(t);
      const w = new Set();
      for (const m of c.matchAll(/catch\((_0[A-Za-z0-9]+)\)/g)) w.add(m[1]);
      wSets.push(w);
    }
    const tCommon = [...tSets[0]].filter((n) => tSets.every((s) => s.has(n) && n !== '_0x'));
    const wCommon = [...wSets[0]].filter((n) => wSets.every((s) => s.has(n)));
    ok(!tCommon.includes('_0T'), '掩码串 IIFE 形参逐构建变化（旧码每构建固定 _0T）', '交集 ' + tCommon.join(' '));
    ok(!wCommon.includes('_0w'), 'header catch 形参逐构建变化（旧码每构建固定 _0w）', '交集 ' + wCommon.join(' '));
  }
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
