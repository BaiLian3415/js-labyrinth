#!/usr/bin/env node
/**
 * 模块体加密层的端到端校验（对着已构建的 dist/ 跑）。
 *
 *   npm run build:web && node tools/build/verify-encryption.js
 *
 * 为什么必须有这个脚本：加密层有几种静默失败模式，构建期一个都拦不住——
 *   - 导出名枚举漏了某个名字 → 产物能加载、能建对象，但某条路径一执行就
 *     "xxx is not a function"。2026-09-25 实测踩到：index.js 的导出清单带分组注释,
 *     紧跟注释的 `obfuscate` 与 `runJob` 双双被漏掉，界面上就是"点混淆没反应"。
 *   - 相对说明符改写漏了某种形态 → 某个模块 import 到无效地址，只在走到它时才炸。
 *   - 密钥/格式不一致 → 整份产物一加载就抛，但构建期只看代码是看不出来的。
 * npm test 只覆盖 src/（明文源码），碰不到 dist/，所以这条链路需要自己的校验。
 *
 * 校验内容：
 *   1) 引导层只取一次载荷，整棵核心模块图能用密文加载起来
 *   2) 导出完整性：逐个受保护模块比对「原始 src 模块命名空间」与「dist stub 命名空间」
 *   3) 真跑一次混淆任务，产物执行结果与原源码逐字符一致
 *   4) 篡改载荷 1 字节必须被 FNV 完整性校验拦下
 *
 * Node 与浏览器有两处差异，这里用 shim 抹平（生产代码不为可测性让步）：
 *   - Node 的 ESM 不认 blob: URL（浏览器认）→ createObjectURL 换回 data: URL
 *   - Node 的 fetch 不认 file: URL → 拦截并按路径读盘
 * 因此本脚本不能替代浏览器实测：blob: 物化那一步的真实行为要靠线上跑一遍
 * （2026-09-25 已在 Chrome 实测通过：激活后 /src/__jslb_core.js 与 /src/__core.pack
 * 正常取回，随后大量 blob: Script 动态导入成功）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isGatedModuleId } from './gate-policy.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DIST = path.join(ROOT, 'dist');

if (!fs.existsSync(path.join(DIST, 'src/index.js'))) {
  console.error('没有 dist/，先跑 npm run build:web');
  process.exit(1);
}

let failures = 0;
const ok = (cond, label, detail) => {
  if (cond) console.log('  ✅ ' + label + (detail ? '  ' + detail : ''));
  else { failures++; console.log('  ❌ ' + label + (detail ? '  ' + detail : '')); }
};

// ---------------------------------------------------------------------------
// shim
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
let packFetches = 0;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('file:')) {
    if (u.includes('__core.pack')) packFetches++;
    return new Response(fs.readFileSync(new URL(u)), { status: 200 });
  }
  return realFetch(url, init);
};

const RealBlob = globalThis.Blob;
globalThis.Blob = class extends RealBlob {
  constructor(parts, opts) {
    super(parts, opts);
    // createObjectURL 必须是同步的，而 Node 的 Blob 只有异步 text()/arrayBuffer()，
    // 所以在这里留一份字节副本供下面的 shim 使用。
    this.__bytes = Buffer.from(parts.map((p) => String(p)).join(''), 'utf8');
  }
};
globalThis.URL.createObjectURL = (blob) =>
  'data:text/javascript;base64,' + Buffer.from(blob.__bytes || '').toString('base64');

// ---------------------------------------------------------------------------
// 1) 整棵核心模块图能否用密文加载
// ---------------------------------------------------------------------------

console.log('模块体加密层校验：' + path.relative(ROOT, DIST));
console.log('');
console.log('1) 密文加载整棵核心模块图');
{
  const t0 = performance.now();
  const core = await import(pathToFileURL(path.join(DIST, 'src/index.js')).href);
  const ms = performance.now() - t0;
  ok(true, 'dist/src/index.js 可作为 ESM 加载（解密 + 物化完成）', ms.toFixed(0) + ' ms');
  ok(packFetches === 1, '引导层只取一次载荷', '实得 ' + packFetches + ' 次');
  ok(typeof core.runJob === 'function', 'index.js 的 runJob 导出可见');
  ok(typeof core.obfuscate === 'function', 'index.js 的 obfuscate 导出可见');
  ok(typeof core.DEFAULTS === 'object', 'index.js 的 DEFAULTS 导出可见');
}

// ---------------------------------------------------------------------------
// 2) 导出完整性
// ---------------------------------------------------------------------------

function listJs(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...listJs(path.join(dir, e.name), rel));
    else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out.sort();
}

console.log('');
console.log('2) 导出完整性（原始 src 模块  vs  dist stub）');
{
  let checked = 0;
  const bad = [];
  for (const id of listJs(path.join(ROOT, 'src'))) {
    if (!isGatedModuleId(id)) continue;
    checked++;
    const orig = await import(pathToFileURL(path.join(ROOT, 'src', id)).href);
    const stub = await import(pathToFileURL(path.join(DIST, 'src', id)).href);
    const a = Object.keys(orig);
    const b = new Set(Object.keys(stub));
    const missing = a.filter((k) => !b.has(k));
    const extra = Object.keys(stub).filter((k) => !a.includes(k));
    if (missing.length || extra.length) {
      bad.push(id + (missing.length ? ' 缺:' + missing.join(',') : '')
        + (extra.length ? ' 多:' + extra.join(',') : ''));
    }
  }
  ok(bad.length === 0, '受保护模块 ' + checked + ' 个导出名逐个一致', bad.length ? bad.join(' | ') : '');
}

// ---------------------------------------------------------------------------
// 3) 语义保持
// ---------------------------------------------------------------------------

console.log('');
console.log('3) 真跑一次混淆任务，比对产物执行结果');
{
  const core = (await import(pathToFileURL(path.join(DIST, 'src/index.js')).href)).default;
  const sample = `
function pick(a, b) { return a > b ? a : b; }
class Box { constructor(v) { this.v = v; } get val() { return this.v; } }
var out = [];
for (var i = 0; i < 3; i++) { out.push(pick(i, 2) + new Box(i).val); }
console.log(out.join(","));
`;
  const r = await core.runJob({
    code: sample,
    options: { preset: 'low', seed: 12345 },
    type: 'js',
    ent: { plan: 'business', preset: 'max', gates: {}, limits: {} },
  });
  ok(r.ok === true, 'runJob 成功产出', r.ok ? r.code.length + ' 字节' : String(r.message).split('\n')[0]);
  if (r.ok) {
    const run = (src) => {
      const buf = [];
      const orig = console.log;
      console.log = (...a) => buf.push(a.join(' '));
      try { new Function(src)(); } finally { console.log = orig; }
      return JSON.stringify(buf);
    };
    ok(run(sample) === run(r.code), '产物执行结果与原源码逐字符一致', run(sample));
  }
}

// ---------------------------------------------------------------------------
// 4) 篡改检测
// ---------------------------------------------------------------------------

console.log('');
console.log('4) 篡改载荷必须被完整性校验拦下');
{
  const packPath = path.join(DIST, 'src/__core.pack');
  const tamperPath = path.join(DIST, 'src/__core.pack.tampered');
  const probePath = path.join(DIST, 'src/__tamper_probe.js');
  const copy = Buffer.from(fs.readFileSync(packPath));
  copy[1000] ^= 0xff; // 改中间一个字节，确保落在 body 而不是尾部 4 字节校验位里
  fs.writeFileSync(tamperPath, copy);

  const loader = fs.readFileSync(path.join(DIST, 'src/__jslb_core.js'), 'utf8');
  // 引导层里 PACK 是 JSON.stringify 出来的（双引号），替换时保持同样的引号风格
  const patched = loader.replace(/(['"])\.\/__core\.pack\1/, '"./__core.pack.tampered"');
  if (!patched.includes('__core.pack.tampered')) {
    ok(false, '探针构造失败：没能改写引导层里的载荷路径');
  } else {
    fs.writeFileSync(probePath, patched);
    try {
      const probe = await import(pathToFileURL(probePath).href);
      await probe.materialize('index.js');
      ok(false, '载荷被改 1 字节却仍解出来了');
    } catch (e) {
      // 不能只看"抛错了"——fetch 失败也是抛错，必须确认是 FNV 那条
      const msg = String(e.message).split('\n')[0];
      ok(/integrity check failed/.test(msg), 'FNV 完整性校验拦下',
        /integrity check failed/.test(msg) ? '' : '抛的不是 FNV: ' + msg.slice(0, 80));
    }
  }
  fs.rmSync(tamperPath, { force: true });
  fs.rmSync(probePath, { force: true });
}

console.log('');
if (failures === 0) console.log('✅ 加密层校验全过。');
else console.log('❌ ' + failures + ' 项失败——别发布这份 dist/。');
process.exit(failures === 0 ? 0 : 1);