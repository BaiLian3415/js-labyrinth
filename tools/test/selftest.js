#!/usr/bin/env node
/**
 * 自测。直接跑：
 *
 *   npm test            （即 node tools/test/selftest.js）
 *   node tools/test/selftest.js --verbose
 *   JSLB_SKIP_LIVE=1 npm test       仅跑离线段，完全不打网络
 *
 * 覆盖范围：
 *   核心       三个预设各跑一遍，产物可执行、固定 seed 可复现、跨运行一致
 *   HTML       内联脚本被替换、外部脚本与非 JS type 不被碰、跨块共享给出警告
 *   目录模式   递归混淆、镜像目录结构、非 JS 文件按开关复制或跳过
 *   闸门       试用/低档卡密的预设上限与逐项闸门按预期拦截
 *   许可证     codec 签发-校验往返、篡改卡密/用量/套餐一律失败
 *   网页链路   runJob 在浏览器侧等价路径上可跑通（授权、限额、记账）
 *   额度包     一次性额度按总额度累计、跨日不重置、用尽即拦
 *   解除激活   服务端按设备码存的那份记录被真正删掉，刷新不再恢复
 *   Worker API health / plans / license / obfuscate 四个路由（进程内，不打网络）
 *   ZIP        文件头、CRC 与中央目录结构
 *   线上验收   打已部署的 Cloudflare 站点，确认部署与策略真的生效
 *
 * ⚠️ 网络依赖：除最末「线上验收」段外，全部离线。该段会打
 *    JSLB_LIVE_ORIGIN（默认 https://jslb.lllm.dpdns.org），
 *    需要无网/CI 环境纯离线跑时设 JSLB_SKIP_LIVE=1。
 *
 * 不写仓库内文件（临时目录用完即删）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import obfuscateMod from '../../src/obfuscate.js';
import htmlMod from '../../src/html.js';
import codec from '../../src/license-codec.js';
import licCore from '../../src/license-core.js';
import plan from '../../src/plan.js';
import gate from '../../src/options-gate.js';
import pipeline from '../../src/pipeline.js';
import licenseWeb from '../../src/license-web.js';
import platform from '../../src/platform.js';
import i18n from '../../src/i18n.js';
import makeZip from '../../src/utils/zip.js';
import hash from '../../src/utils/hash.js';
import secret from '../../src/license-secret.js';
import { ed25519PublicKeyFromSeed } from '../../src/utils/ed25519.js';

// 测试专用签发密钥对。
//
// 真私钥不随源码分发（这正是换成非对称的目的），所以自测不能拿它签卡——也不该
// 拿。测试自己固定一对：种子写死在这里，公钥由它派生，再通过 setKeyMaterial /
// JSLB_PUBLIC_KEY 注入到 license-web 与 Worker。走的签发/验签代码路径与线上完全
// 相同，只有密钥不同。种子是公开的常量，仅供测试，绝不能用于真实发卡。
const TEST_SIGNING_SEED = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const TEST_PUBLIC_KEY = hash.bytesToB64(ed25519PublicKeyFromSeed(hash.b64ToBytes(TEST_SIGNING_SEED)));

const { obfuscate } = obfuscateMod;
const { obfuscateDocument } = htmlMod;
const { runJob } = pipeline;
const { makeZip: zip } = makeZip;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERBOSE = process.argv.includes('--verbose');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jslb-selftest-'));

// 临时目录必须随进程一起消失。末尾那句 rmSync 只在"跑到最后"时才执行，
// 而线上段不可达时会提前 return、断言失败时也可能中途抛错——都会把
// os.tmpdir()/jslb-selftest-* 留在盘上（曾攒下几十个）。这里挂进程级兜底，
// 保证任何退出路径（正常、抛错、Ctrl-C、process.exit）都能清掉。
let tmpCleaned = false;
function cleanTmp() {
  if (tmpCleaned) return;
  tmpCleaned = true;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
}
process.on('exit', cleanTmp);
process.on('SIGINT', () => { cleanTmp(); process.exit(130); });
process.on('SIGTERM', () => { cleanTmp(); process.exit(143); });
process.on('uncaughtException', (e) => { cleanTmp(); throw e; });

let pass = 0;
let fail = 0;
const failures = [];

/** 断言。 */
function ok(cond, label, detail) {
  if (cond) {
    pass++;
    if (VERBOSE) console.log('  [OK] ' + label);
  } else {
    fail++;
    failures.push(label + (detail ? ' — ' + detail : ''));
    console.log('  [FAIL] ' + label + (detail ? '\n      ' + detail : ''));
  }
}

/** 粗暴剥掉块注释与整行行注释，静态检查只看真实代码。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * 去掉注释与字符串/模板字面量，只留代码骨架。
 *
 * 扫描"有没有字符串代码生成"时必须用这个：壳里的 `'(0,eval)'` 与帮助文案里的
 * eval 都只是数据，用 stripComments 会把它们当成真实调用（i18n.js 与 shell.js
 * 就是这样误报的）。反过来，删掉字符串后仍能命中的才是真的代码生成。
 */
function stripLiterals(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

/** 断言抛出。 */
function throws(fn, label) {
  try {
    fn();
    ok(false, label, '未抛出异常');
  } catch (e) {
    ok(true, label);
  }
}

function section(name) {
  console.log('\n' + name);
}

/**
 * 用系统自带的解压器解开 zip，成功返回所用命令名，都不可用返回 null。
 * Windows 用 PowerShell 的 Expand-Archive，其余平台优先 unzip，再退 bsdtar。
 * @param {string} zipPath zip 路径
 * @param {string} dest 目标目录
 * @returns {string|null} 命令标识
 */
function tryExtract(zipPath, dest) {
  const attempts = [];
  if (process.platform === 'win32') {
    attempts.push(['powershell', ['-NoProfile', '-Command',
      'Expand-Archive -LiteralPath ' + JSON.stringify(zipPath) + ' -DestinationPath ' + JSON.stringify(dest) + ' -Force']]);
  }
  attempts.push(['unzip', ['-o', '-q', zipPath, '-d', dest]]);
  attempts.push(['bsdtar', ['-xf', zipPath, '-C', dest]]);
  for (const [cmd, args] of attempts) {
    try {
      execFileSync(cmd, args, { stdio: 'ignore', timeout: 30000 });
      return cmd;
    } catch (e) { /* 试下一个 */ }
  }
  return null;
}

/** 示例源码，覆盖字符串、模板串、类、条件、循环、async 与对象键。 */
const SAMPLE = `
const GREETING = 'hello world';
const tpl = \`prefix-\${GREETING}-suffix\`;
function classify(n) {
  if (n > 100 && n % 2 === 0) return 'big-even';
  if (n > 100) return 'big-odd';
  return n === 0 ? 'zero' : 'small';
}
class Counter { constructor(s) { this.value = s; } inc(b) { this.value += (b === undefined ? 1 : b); return this.value; } }
const obj = { alpha: 1, 'beta-gamma': [1, 2, 3], nested: { deep: { key: 'value' } } };
const c = new Counter(3);
for (let i = 0; i < 5; i++) c.inc(i);
const list = [1, 2, 3, 4].map((x) => x * x).filter((x) => x > 2);
async function main() {
  await Promise.resolve();
  console.log(GREETING, tpl, obj['beta-gamma'].length, obj.nested.deep.key, c.value, list.join('|'), classify(400));
}
main();
`;

/** 用 node 跑一段产物，返回 stdout。 */
function runNode(code, name) {
  const file = path.join(TMP, name || ('run-' + Math.random().toString(36).slice(2) + '.js'));
  fs.writeFileSync(file, code);
  return execFileSync(process.execPath, [file], { encoding: 'utf8', timeout: 60000 });
}

// ---------------------------------------------------------------- 核心

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

// ---------------------------------------------------------------- HTML

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

// ---------------------------------------------------------------- 闸门

section('套餐闸门与提示');
{
  const plusEnt = { ...plan.describe('plus'), trial: false };
  ok(gate.checkOptions({ preset: 'medium' }, plusEnt).ok, '套餐自带预设可用（Plus 上限为 medium）');
  ok(!gate.checkOptions({ preset: 'max' }, plusEnt).ok, '超出套餐预设上限被拦');
  ok(!gate.checkOptions({ envFingerprint: true }, plusEnt).ok, '套餐不提供的开关被拦');
  ok(!gate.checkOptions({ stringArrayThreshold: 0.9 }, plusEnt).ok, '超上限的数值被拦');
  ok(gate.checkOptions({ preset: 'low', mangle: false }, plusEnt).ok, '关掉开关始终允许');
  ok(gate.checkOptions({}, plusEnt).ok, '什么都不写不被拦（用套餐自带预设）');
  // 档位阶梯（低档每一项都不得超过高档）由 plan.js 的 assertConsistent() 在模块
  // 加载时对所有相邻档位校验：预设上限单调、配额单调、闸门不倒挂。这里不再重复，
  // 能跑到这一行就说明阶梯成立。

  const businessEnt = plan.describe('business');
  ok(gate.checkOptions({ preset: 'max', wasm: true, shellDepth: 4 }, businessEnt).ok, '顶档全部放行');

  const trial = licenseWeb.trialEntitlements();
  const r = gate.checkOptions({ preset: 'high' }, trial);
  ok(!r.ok && r.kind === 'preset', '试用模式按预设上限拦截');
  ok(gate.checkOptions({ preset: trial.preset }, trial).ok, '试用模式自带预设可跑通');
  ok(typeof gate.presetBlockedText(r, trial) === 'string'
    && gate.presetBlockedText(r, trial).length > 0, '预设越界有本地化提示');
  const v = gate.checkOptions({ wasm: true }, trial);
  ok(!v.ok && typeof gate.violationText(v.hits[0], trial) === 'string', '逐项闸门有本地化提示');
}

// ---------------------------------------------------------------- 许可证

section('卡密与令牌');
{
  // 签发用私钥种子，验签用公钥——两把不是同一个东西，这正是非对称的意义。
  const seed = TEST_SIGNING_SEED;
  const pub = TEST_PUBLIC_KEY;
  const code = codec.issueCode(seed, 'pro', 30, '12345');
  ok(!!code && code.startsWith('JSLB-R-'), '可签发 Pro/30 天卡密', code);
  const parsed = codec.parseCode(pub, code);
  ok(parsed.ok && parsed.plan === 'pro' && parsed.days === 30, '卡密可解析且套餐天数正确');
  ok(parsed.id === '12345', '编号可还原（编号段已压到 40 bit）');
  ok(typeof parsed.issueDay === 'number' && parsed.issueDay >= 0, '卡密带签发日');
  ok(parsed.bound === false, '未指定机器码时卡密为"不绑定"');
  ok(codec.parseCode(pub, code.toLowerCase().replace(/-/g, ' ')).ok, '小写与分隔符容错');
  ok(!codec.parseCode(pub, code.replace(/-R-/, '-B-')).ok, '改套餐段导致签名失败');
  ok(!codec.parseCode(pub, code.slice(0, -1) + '0').ok, '改签名段失败');
  ok(!codec.parseCode(pub, 'JSLB-X-00-000-' + '0'.repeat(8) + '-' + '0'.repeat(16) + '-' + '0'.repeat(103)).ok, '未知套餐段失败');
  // 签发日也在签名载荷里，改它必须失败——否则本地能把到期时间往后挪
  const shiftedDay = codec.issueCode(seed, 'pro', 30, '12345', 1000);
  const tamperedDay = shiftedDay.replace(/^(JSLB-R-..-)(...)/, (m, a) => a + '001');
  ok(!codec.parseCode(pub, tamperedDay).ok, '改签发日导致签名失败');

  // 编号段超界必须拒绝——压缩段宽后原来的 20 位编号再也放不下
  ok(codec.issueCode(seed, 'pro', 30, '1099511627775') !== null, '编号上限内可签发');
  ok(codec.issueCode(seed, 'pro', 30, '1099511627776') === null, '编号超 40 bit 上限时拒绝签发');
  ok(codec.MAX_ID === 1099511627775n, '编号上限恰为 2^40-1', String(codec.MAX_ID));

  // 编号段的跨度**小于**时间戳——这正是 keygen 首次签发时必须取模的原因。
  // 这一条防的是"起点策略悄悄换回裸时间戳"：13 位毫秒数 (~1.8e12) 比 40 bit 的
  // 上限 (~1.1e12) 大，那样的起点会让首次签发（比如最常见的 --bind 签名）报
  // "编号区间超出编码上限"，看起来却像机器码有问题。
  {
    const span = codec.MAX_ID + 1n;
    ok(BigInt(Date.now()) > span, '毫秒时间戳超出编号段跨度（所以起点必须取模）',
      '跨度 ' + span + '，时间戳 ' + Date.now());
    const at = (ms) => codec.issueCode(seed, 'pro', 30, BigInt(ms) % span, 2192);
    ok(at(Date.now()) !== null, '时间戳取模后的起点可签发');
    ok(at(4102444800000) !== null, '2100 年的时间戳取模后仍可签发');
    // 同一毫秒内连签两张：取模起点相同，靠编号递增才不会撞成同一段卡密。
    const ms = Date.now();
    const one = codec.issueCode(seed, 'pro', 30, BigInt(ms) % span, 2192);
    const two = codec.issueCode(seed, 'pro', 30, BigInt(ms) % span + 1n, 2192);
    ok(one !== two, '同一起点紧邻编号签出不同卡密');
  }

  // 非对称的核心性质：只有公钥时签不出卡。公钥是公开的，用它当种子必然签不出
  // 一张能验过的卡（这里验的是"拿公钥冒充私钥"不会意外通过）。
  const forged = codec.issueCode(hash.bytesToB64(hash.b64ToBytes(pub)), 'business', 0, '99999');
  ok(!forged || !codec.parseCode(pub, forged).ok, '只有公钥时无法伪造卡密');

  // 签发日进签名载荷，到期时间由它推出——这是"本地改不了自己的有效期"的依据。
  // 用 2026-01-01（距零点 2192 天）签 30 天，到期必须是 2026-01-31，而不是"激活时刻 + 30 天"。
  {
    const day = 2192; // 2026-01-01 距 2020-01-01 UTC 的天数
    const c = codec.issueCode(seed, 'pro', 30, '12345', day);
    const p = codec.parseCode(pub, c);
    ok(p.ok && p.issueDay === day, '签发日可从卡密还原', String(p.issueDay));
    const exp = licCore.expiryFromIssueDay(p);
    ok(exp === codec.DAY_ZERO + (day + 30) * 86400000,
      '到期时间 = 签发日 + 天数（不采信记录里的 issuedAt）',
      new Date(exp).toISOString().slice(0, 10));
    ok(new Date(exp).toISOString().slice(0, 10) === '2026-01-31',
      '2026-01-01 签的 30 天卡到期日为 2026-01-31');
    // 永久卡不受签发日影响
    const perm = codec.parseCode(pub, codec.issueCode(seed, 'pro', 0, '12345', day));
    ok(licCore.expiryFromIssueDay(perm) === codec.PERPETUAL, '永久卡到期时间为 0');
  }

  const mid = 'ABCDEFGHJKMNPQRSTVWXYZ01';
  const token = codec.makeToken(pub, mid, 0, '2026-01-01', 3);
  ok(codec.verifyToken(pub, token, mid, 0, '2026-01-01', 3), '令牌验签通过');
  ok(!codec.verifyToken(pub, token, mid, 0, '2026-01-01', 4), '改用量次数后验签失败');
  ok(!codec.verifyToken(pub, token, 'ZZZZZZZZZZZZZZZZZZZZZZZ1', 0, '2026-01-01', 3), '换机器码后验签失败');
  // 令牌密钥由公钥派生，换一对密钥就对不上
  ok(!codec.verifyToken(secret.B64_PUBLIC_KEY, token, mid, 0, '2026-01-01', 3), '换公钥后令牌验签失败');

  // 纯 JS HMAC 与 node:crypto 的一致性由 tools/test/hashtest.js 覆盖，这里只跑它
  const ht = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'test', 'hashtest.js')], { encoding: 'utf8' });
  ok(ht.includes('全部通过'), 'hash 实现与 node:crypto 逐位一致', ht.trim().split('\n').pop());
}

section('卡密的机器码绑定');
{
  const seed = TEST_SIGNING_SEED;
  const pub = TEST_PUBLIC_KEY;
  const midA = 'ABCDEFGHJKMNPQRSTVWXYZ01';
  const midB = 'ABCDEFGHJKMNPQRSTVWXYZ02'; // 与 A 只差最后一位

  const bound = codec.parseCode(pub, codec.issueCode(seed, 'pro', 30, '12345', 2192, midA));
  ok(bound.ok && bound.bound === true, '指定机器码签出的卡为"已绑定"');
  ok(codec.matchesMachine(bound.bindSeg, midA), '绑定卡在本机可用');
  ok(!codec.matchesMachine(bound.bindSeg, midB), '绑定卡换一台机器（机器码差一位）即被拒');

  // 机器码不进卡密明文：卡密里只有摘要，反查不出机器码
  ok(bound.code.indexOf(midA) < 0, '卡密里不含机器码明文');
  ok(bound.bindSeg.length === codec.BIND_LEN && codec.isB32Text(bound.bindSeg),
    '绑定段是 ' + codec.BIND_LEN + ' 字符 base32');
  ok(bound.bindSeg !== midA.slice(0, codec.BIND_LEN), '绑定段也不是机器码的截断');
  ok(codec.bindDigest(midA) === codec.bindDigest(midA), '绑定摘要对同一机器码稳定');
  ok(codec.bindDigest(midA) !== codec.bindDigest(midB), '机器码一位之差得不同摘要');

  // 绑定段在签名载荷里：改一个字符必须验签失败，所以"把别人的卡密改到自己机器上"不可能
  const tampered = bound.code.replace(
    new RegExp('-' + bound.bindSeg + '-'),
    '-' + codec.bindDigest(midB) + '-',
  );
  ok(tampered !== bound.code, '构造出"把绑定段换成自己机器"的卡密');
  ok(!codec.parseCode(pub, tampered).ok, '改绑定段导致签名失败（换绑不了）');

  // 不绑定的卡对任何机器都放行
  const free = codec.parseCode(pub, codec.issueCode(seed, 'pro', 30, '12345', 2192));
  ok(free.bound === false && free.bindSeg === codec.BIND_NONE, '不绑定的卡绑定段为全 0');
  ok(codec.matchesMachine(free.bindSeg, midA) && codec.matchesMachine(free.bindSeg, midB),
    '不绑定的卡在任何机器上都放行');

  // 端到端的判定走 license-core：绑定不符时 reason 必须是 bind
  {
    const rec = licCore.makeRecord({
      code: bound.code, plan: 'pro', machine: midB,
      issuedAt: Date.now(), expiresAt: licCore.expiryFromIssueDay(bound),
      usage: { day: '2026-01-01', used: 0 },
    }, pub);
    const res = licCore.verifyLicenseData(rec, midB, pub);
    ok(!res.ok && res.reason === 'bind', '卡密绑定的机器与当前机器不符时判 bind', res.reason);
    const okRes = licCore.verifyLicenseData(rec, midA, pub);
    ok(!okRes.ok && okRes.reason === 'machine', '卡密绑定对但记录来自别的机器时判 machine', okRes.reason);
  }
}

// ------------------------------------------------------------ 自锚定校验

// 服务端（Cloudflare Worker）里没有 navigator / screen / WebGL，machineId() 派生出的
// 值与浏览器派的永不相等（Worker 实测 4CFS7ZE5899W3R803S439Y2F，浏览器实测
// 1K9W9H9S065P0C7M834C1XC8）。所以 Worker 侧的网关必须用"自锚定"模式校验：
// 锚点取记录自己声称的 machine，再拿**签名过的绑定段**去核对。
//
// 这一节钉住三件事：自锚定能放行正常记录、严格模式不会因此被放松、伪造仍然过不去。

section('自锚定校验（服务端网关）');
{
  const seed = TEST_SIGNING_SEED;
  const pub = TEST_PUBLIC_KEY;
  const browserMid = '1K9W9H9S065P0C7M834C1XC8'; // 浏览器派生（记录里的 machine）
  const serverMid = '4CFS7ZE5899W3R803S439Y2F';  // Worker 派生（网关手里的 machine）

  // 签发日必须晚于当前时间，否则校验会在 expired 那一步先失败，掩盖掉这里要验的
  // bind / token 判定。往上取一段余量而不是写死某天，免得测试随时间腐烂。
  const issueDay = Math.floor((Date.now() - codec.DAY_ZERO) / 86400000) + 3650;

  // 卡绑到浏览器机器码 —— 线上就是这种情况
  const parsed = codec.parseCode(pub, codec.issueCode(seed, 'pro', 30, '70001', issueDay, browserMid));
  ok(parsed.ok && parsed.bound === true, '自锚定用例：卡绑到浏览器机器码');
  const rec = licCore.makeRecord({
    code: parsed.code, plan: 'pro', machine: browserMid,
    issuedAt: Date.now(), expiresAt: licCore.expiryFromIssueDay(parsed),
    usage: { day: '2026-01-01', used: 0 },
  }, pub);

  // 严格模式：本机码相同 → 放行；换成 Worker 派的码 → 必须拒绝
  ok(licCore.verifyLicenseData(rec, browserMid, pub).ok, '严格模式：机器码一致时放行');
  {
    const res = licCore.verifyLicenseData(rec, serverMid, pub);
    // 拒绝的理由是 bind 而不是 machine：绑定段的核对排在 machine 比对之前，
    // 而异机场景下绑定段先一步不合。这正是 403 的真凶。
    ok(!res.ok && res.reason === 'bind', '严格模式：换成服务端机器码时判 bind（403 的真凶）', res.reason);
  }

  // 自锚定：null / undefined / 空串都应被视为自锚定
  for (const anchor of [null, undefined, '']) {
    const res = licCore.verifyLicenseData(rec, anchor, pub);
    ok(res.ok, '自锚定（' + JSON.stringify(anchor) + '）放行浏览器派生的记录', res.reason);
    ok(res.machine === browserMid, '自锚定回传的 machine 取自记录自身');
  }

  // 严格模式绝不能被自锚定带松：传了机器码就必须严格比对
  ok(!licCore.verifyLicenseData(rec, serverMid, pub).ok, '自锚定不影响严格模式：异机仍拒');
  ok(licCore.verifyLicenseData(rec, browserMid, pub).ok, '自锚定不影响严格模式：同机仍放');

  // 安全性：自锚定的锚点来自记录，必须靠签名过的绑定段兜底
  {
    const forged = { ...rec, machine: 'ZZZZZZZZZZZZZZZZZZZZZZZZ' };
    const res = licCore.verifyLicenseData(forged, null, pub);
    ok(!res.ok && res.reason === 'bind', '自锚定：改 machine 会被签名过的绑定段拦下', res.reason);
  }
  {
    // 连令牌一起换成"新机器"的也没用：绑定段仍指向原机器
    const machine = 'ZZZZZZZZZZZZZZZZZZZZZZZZ';
    const forged = {
      ...rec,
      machine,
      token: codec.makeToken(pub, machine, rec.expiresAt, rec.usage.day, rec.usage.used),
    };
    const res = licCore.verifyLicenseData(forged, null, pub);
    ok(!res.ok && res.reason === 'bind', '自锚定：令牌与 machine 同步伪造仍被绑定段拦下', res.reason);
  }
  {
    const tampered = { ...rec, usage: { day: rec.usage.day, used: 999 } };
    const res = licCore.verifyLicenseData(tampered, null, pub);
    ok(!res.ok && res.reason === 'token', '自锚定：篡改用量判 token', res.reason);
  }
  {
    // 卡密不绑机器（绑定段全 0）时，自锚定等价于"只看签名与令牌"
    const free = codec.parseCode(pub, codec.issueCode(seed, 'pro', 30, '70002', issueDay));
    ok(free.bound === false, '自锚定用例：通用卡不绑定机器');
    const freeRec = licCore.makeRecord({
      code: free.code, plan: 'pro', machine: serverMid,
      issuedAt: Date.now(), expiresAt: licCore.expiryFromIssueDay(free),
      usage: { day: '2026-01-01', used: 0 },
    }, pub);
    ok(licCore.verifyLicenseData(freeRec, null, pub).ok, '自锚定：不绑定的卡在任何机器码下都放行');
  }
  {
    // machine 长度不对属于结构性损坏，自锚定也必须先挡下来
    ok(!licCore.verifyLicenseData({ ...rec, machine: 'SHORT' }, null, pub).ok,
      '自锚定：machine 长度非法判 corrupt');
  }
}

// ------------------------------------------------------------ keygen 命令行

section('签发工具命令行（编号分配与 --bind）');
{
  // 这一节必须真的把 keygen.js 当子进程跑，不能只调 codec。踩过的坑正是：
  // 签发工具首次运行时拿 Date.now() 当起始编号，13 位毫秒数超出 40 bit 编号段，
  // 于是**任何**不带 --id 的签发都失败，报的却是"编号区间超出编码上限"。因为
  // keygen.js 平时能看到的状态是 --machine（不需要私钥、不碰计数器），
  // 这个坑看起来就像"机器码有问题"。用假私钥跑子进程才能覆盖到这条路径：
  // 签发在 allocateId 之后才用私钥，而假私钥（32 字节非零种子）一样能签出
  // 语法合法的卡密。
  const KEYGEN = path.join(ROOT, 'tools', 'issue', 'keygen.js');
  const FAKE_SEED = hash.bytesToB64(new Uint8Array(32).fill(7));
  const stateDir = fs.mkdtempSync(path.join(TMP, 'keygen-'));
  const stateFile = path.join(stateDir, '.keygen-state.json');
  const env = {
    ...process.env,
    JSLB_SIGNING_KEY: FAKE_SEED,
    JSLABYRINTH_KEYGEN_STATE: stateFile,
  };
  const gen = (args) => execFileSync(process.execPath, [KEYGEN, ...args], {
    encoding: 'utf8', timeout: 30000, env,
  });
  const genFail = (args) => {
    try {
      execFileSync(process.execPath, [KEYGEN, ...args], { encoding: 'utf8', timeout: 30000, env });
      return null;
    } catch (e) {
      return String((e.stderr || '') + (e.stdout || ''));
    }
  };

  // 计数器不存在 = 首次签发。绑定签名是最常见的用法，也是最容易撞上这个坑的路径。
  const mid = 'ABCDEFGHJKMNPQRSTVWXYZ01';
  let first = null;
  try {
    first = gen(['--plan', 'pro', '--days', '365', '--bind', mid]);
  } catch (e) {
    ok(false, '首次签发（计数器不存在）能成功', String(e.stderr || e.message).trim());
  }
  if (first !== null) {
    const line = first.trim().split('\n')[0].trim();
    ok(/^JSLB-R-/.test(line), '首次签发 --bind 得到卡密', line.slice(0, 24) + '…');
    // 卡密是假私钥签的，验签必然不过，所以这里只校验段结构：能切出绑定段、
    // 且编号落在 40 bit 之内，就说明 allocateId 没把越界编号交出去。
    const segs = codec.normalizeCode(line);
    const body = segs.slice(4);
    const idSeg = body.slice(1 + 2 + 3, 1 + 2 + 3 + codec.ID_LEN);
    ok(codec.isB32Text(idSeg) && idSeg.length === codec.ID_LEN,
      '首次签发落在编号段 40 bit 之内', idSeg);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    ok(/^[0-9]+$/.test(state.last) && BigInt(state.last) <= codec.MAX_ID,
      '计数器写入的编号未越界', state.last);
  }

  // 计数器存在之后走 stored + 1，不再看时间戳：连续两次签发编号必须递增。
  const second = gen(['--plan', 'pro', '--days', '365', '--bind', mid]);
  ok(second.trim().length > 0, '计数器存在后仍可签发');
  const stateAfterSecond = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  ok(/^[0-9]+$/.test(stateAfterSecond.last) && BigInt(stateAfterSecond.last) <= codec.MAX_ID,
    '第二次签发的编号仍在编号段内', stateAfterSecond.last);

  // --count 3 必须把计数器推进 3 个编号（写回的是本次用掉的最后编号，故 +2）
  gen(['--plan', 'pro', '--days', '365', '--count', '3']);
  const stateAfterBatch = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  ok(BigInt(stateAfterBatch.last) === BigInt(stateAfterSecond.last) + 3n,
    '--count 3 把计数器推进 3 个编号',
    stateAfterSecond.last + ' → ' + stateAfterBatch.last);

  // 显式 --id 越界：错误信息必须指向 --id，而不是含糊的"编号区间超出编码上限"
  const tooBig = genFail(['--plan', 'pro', '--id', String(codec.MAX_ID), '--count', '2']);
  ok(tooBig !== null && /--id/.test(tooBig), '显式 --id 越界时报错并点出 --id',
    String(tooBig).trim().split('\n').pop());

  // 计数器已满：报错要给出可执行的处置（删除/改名计数器），别让人去怀疑机器码
  fs.writeFileSync(stateFile, JSON.stringify({ last: codec.MAX_ID.toString() }, null, 2));
  const exhausted = genFail(['--plan', 'pro', '--days', '365', '--bind', mid]);
  ok(exhausted !== null && /计数器|--id/.test(exhausted) && /--bind/.test(exhausted) === false,
    '计数器用满时给出可操作的建议', String(exhausted).trim().split('\n')[0]);
  ok(exhausted === null || !/机器码|--bind/.test(exhausted),
    '计数器用满的报错不把责任推给机器码');

  // --machine 不碰计数器、不需要私钥：即使在计数器已满的情况下也必须正常
  const noKeyEnv = { ...process.env, JSLB_SIGNING_KEY: '', JSLABYRINTH_KEYGEN_STATE: stateFile };
  const machineOut = execFileSync(process.execPath, [KEYGEN, '--machine', '--json'], {
    encoding: 'utf8', timeout: 30000, env: noKeyEnv,
  });
  let parsedMachine = null;
  try { parsedMachine = JSON.parse(machineOut.trim()); } catch { /* 下面断言报错 */ }
  ok(parsedMachine && parsedMachine.machine && parsedMachine.machine.length === 24
    && codec.isB32Text(parsedMachine.machine),
  '--machine 无需私钥即可打印 24 字符机器码',
  parsedMachine ? parsedMachine.machine : machineOut.trim());

  fs.rmSync(stateDir, { recursive: true, force: true });
}

section('网页链路（授权 → 限额 → 混淆 → 记账）');
{
  platform.setStorage(null); // 回到内存实现，测试不碰 localStorage
  const ens = await licenseWeb.ensure();
  ok(ens.ok && ens.trial, '未激活时按网页版策略进入试用');

  const ent = licenseWeb.entitlements();
  ok(!!ent && ent.trial && ent.preset === platform.getWebConfig().trialPreset,
    '试用权益的预设上限来自配置');

  let consumed = 0;
  const r = await runJob({
    code: SAMPLE, options: { preset: 'low', seed: 3 }, ent, consumeRun: async () => { consumed++; return { ok: true, used: 1, total: 0 }; },
  });
  ok(r.ok && typeof r.code === 'string' && r.code.length > 100, 'runJob 产出结果');
  ok(consumed === 1, '成功任务记一次用量');
  ok(runNode(r.code, 'webrun.js').includes('hello world'), '网页链路产物可执行');

  const blocked = await runJob({ code: SAMPLE, options: { preset: 'max' }, ent });
  ok(!blocked.ok && blocked.status === 403, '越界预设被拦并给出 403');

  const big = 'x'.repeat(platform.getWebConfig().trialMaxFileBytes + 10);
  const oversize = await runJob({ code: '/*' + big + '*/', options: { preset: 'low' }, ent });
  ok(!oversize.ok && oversize.status === 413, '超出单文件限额被拦并给出 413');

  const noEnt = await runJob({ code: SAMPLE, options: {}, ent: null });
  ok(!noEnt.ok && noEnt.status === 401, '未授权时返回 401');

  const htmlJob = await runJob({
    code: '<html><body><script>console.log("hi");</script></body></html>',
    options: { preset: 'low', seed: 1 }, ent, type: 'auto',
  });
  ok(htmlJob.ok && htmlJob.html === true && htmlJob.code.includes('console.log') === false,
    'runJob 自动识别 HTML 并只改内联脚本');
}

// ---------------------------------------------------------------- 额度包与解除激活

section('一次性额度包与解除激活');
{
  // 假的 KV：键名带设备码后缀，del 是真删。用它验证"解除激活必须删掉服务端那一份"——
  // 只清浏览器存储的话，下一次请求又会从 KV 把授权读回来。
  const store = new Map();
  platform.setKv({
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v); },
    del: async (k) => { store.delete(k); },
  });
  platform.setStorage(platform.newMemoryStorage());
  // 换成测试公钥：内置公钥对应的是真私钥，测试签不出来（也不该签得出来）。
  // loadKeysFromEnv() 只在 JSLB_PUBLIC_KEY 有值时覆盖，这里直接设内存里的值。
  licenseWeb.setKeyMaterial(TEST_PUBLIC_KEY, null);
  const keys = [TEST_SIGNING_SEED, TEST_PUBLIC_KEY];
  const devPack = 'c'.repeat(32);
  const devSub = 'd'.repeat(32);
  const keyOf = (base) => base + ':' + devPack;

  // 额度包：买断 100 次，用完为止
  licenseWeb.resetRequestState();
  licenseWeb.setRequestDeviceId(devPack);
  const packCode = codec.issueCode(keys[0], 'pack100', 0, '55555');
  const pa = await licenseWeb.activate(packCode);
  ok(pa.ok && pa.plan === 'pack100', '额度包卡密可激活');
  const pent = licenseWeb.entitlements();
  ok(pent.limits.runsTotal === 100 && pent.preset === 'max', '额度包按总额度记账，能力跟随 max 预设');
  const pq = await licenseWeb.quota();
  ok(pq.total === 100 && pq.used === 0, '额度包额度取自 runsTotal 而非每日上限');

  let used = 0;
  for (let i = 0; i < 100; i++) {
    const c = await licenseWeb.consumeRun();
    if (c.ok) used++;
  }
  ok(used === 100, '额度包可连续记满 100 次', '实得 ' + used);
  const overPack = await licenseWeb.consumeRun();
  ok(!overPack.ok && overPack.reason === 'quota', '额度用尽后不再放行');
  ok((await licenseWeb.quotaText()).indexOf('累计') >= 0, '额度包用量文案走累计口径');

  // 订阅档跨日归零、额度包跨日累计：直接塞一条"上次使用是 2020 年"的记录。
  // 不能靠改 current() 的副本——那只是快照，改它验不出任何东西。
  //
  // 到期时间必须走 expiryFromIssueDay：它由卡密里已签名的签发日推出，随便写一个
  // 值会被 verifyLicenseData 判成 expirymismatch。这正是"本地改不了自己的有效期"。
  const seed = async (device, code, planName, _days, used0) => {
    licenseWeb.resetRequestState();
    licenseWeb.setRequestDeviceId(device);
    const mid = await licenseWeb.machineId();
    const parsed = codec.parseCode(TEST_PUBLIC_KEY, code);
    const rec = licCore.makeRecord({
      code: parsed.code, plan: parsed.plan, machine: mid,
      issuedAt: Date.now(),
      expiresAt: licCore.expiryFromIssueDay(parsed),
      usage: { day: '2020-01-01', used: used0 },
    }, TEST_PUBLIC_KEY);
    store.set('jslabyrinth.license.v2:' + device, JSON.stringify(rec));
    const res = await licenseWeb.restore();
    return res;
  };

  ok((await seed(devPack, packCode, 'pack100', 0, 50)).ok, '旧日期的额度包记录仍可恢复');
  ok((await licenseWeb.quota()).used === 50, '额度包跨日累计：旧日期已用的次数照算');

  const proCode = codec.issueCode(keys[0], 'pro', 30, '66666');
  ok((await seed(devSub, proCode, 'pro', 30, 7)).ok, '旧日期的订阅档记录仍可恢复');
  ok((await licenseWeb.quota()).used === 0, '订阅档跨日归零');

  // 本地改 expiresAt 续期必须失败：到期时间由已签名的签发日推出
  {
    licenseWeb.resetRequestState();
    licenseWeb.setRequestDeviceId(devSub);
    const mid = await licenseWeb.machineId();
    const parsed = codec.parseCode(TEST_PUBLIC_KEY, proCode);
    const rec = licCore.makeRecord({
      code: parsed.code, plan: parsed.plan, machine: mid,
      issuedAt: Date.now(), expiresAt: licCore.expiryFromIssueDay(parsed),
      usage: { day: '2020-01-01', used: 0 },
    }, TEST_PUBLIC_KEY);
    rec.expiresAt = parsed.days === 0 ? 0 : rec.expiresAt + 3650 * 86400000;
    store.set('jslabyrinth.license.v2:' + devSub, JSON.stringify(rec));
    const r = await licenseWeb.restore();
    ok(!r.ok && r.reason === 'expirymismatch', '本地改 expiresAt 续期被拒', r.reason);
  }

  // 解除激活：本设备那份必须真的从 KV 里消失
  licenseWeb.resetRequestState();
  licenseWeb.setRequestDeviceId(devSub);
  const act2 = await licenseWeb.activate(proCode);
  ok(act2.ok && act2.plan === 'pro', '另一台设备激活成功');
  ok(store.has('jslabyrinth.license.v2:' + devSub), '许可证按设备码分键存进 KV');
  await licenseWeb.deactivate();
  ok(!store.has('jslabyrinth.license.v2:' + devSub), '解除激活删掉 KV 里那一条（真删，不是写空串）');
  const again = await licenseWeb.restore();
  ok(!again.ok && again.reason === 'missing', '之后再恢复读不到授权（刷新不会把卡密带回来）');

  platform.setKv(null);
  platform.setStorage(null);
}

// ---------------------------------------------------------------- Worker API

section('Cloudflare Worker 路由');
{
  const worker = (await import('../../worker/index.js')).default;
  // 注入测试公钥：签卡要用私钥，而真私钥不随源码分发（这正是非对称的意义），
  // 所以测试自己造一对，把公钥通过 JSLB_PUBLIC_KEY 交给 Worker。走的代码路径
  // 与线上完全一致，只是密钥不同。
  const call = async (pathname, init) => {
    const req = new Request('https://example.com' + pathname, init);
    return worker.fetch(req, {
      JSLB_WEB_CONFIG: '{"trialPreset":"low","trialMaxFileBytes":65536}',
      JSLB_PUBLIC_KEY: TEST_PUBLIC_KEY,
    }, {});
  };

  const health = await call('/api/health');
  ok(health.status === 200 && (await health.json()).ok === true, 'GET /api/health');

  const plans = await call('/api/plans');
  const plansJson = await plans.json();
  // 档数不写死：跟着 plans.js 走，加档位时不用回来改测试
  ok(plans.status === 200 && Array.isArray(plansJson.plans)
    && plansJson.plans.length === plan.PLAN_NAMES.length,
    'GET /api/plans 返回全部 ' + plan.PLAN_NAMES.length + ' 档套餐');
  ok(plansJson.plans[0] && plansJson.plans[0].name === plan.DEFAULT_PLAN,
    '对照表首档即最低档 ' + plan.DEFAULT_PLAN);

  const lic = await call('/api/license');
  const licJson = await lic.json();
  ok(lic.status === 200 && licJson.ok === true && licJson.trial === true, 'GET /api/license 返回试用状态');
  ok(typeof licJson.machine === 'string' && licJson.machine.length === 24, 'API 侧机器码为 24 字符');

  const bad = await call('/api/obfuscate', { method: 'POST', body: '{oops' });
  ok(bad.status === 400, '非法 JSON 请求体返回 400');

  const run = await call('/api/obfuscate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-JSLB-Device': 'a'.repeat(32) },
    body: JSON.stringify({ code: 'console.log("worker");', options: { preset: 'low', seed: 11 } }),
  });
  const runJson = await run.json();
  ok(run.status === 200 && runJson.ok === true, 'POST /api/obfuscate 成功');
  ok(runJson.code && runJson.originalSize > 0 && runJson.obfuscatedSize > 0, '返回产物与体积统计');
  ok(runJson.code.includes('worker') === false, '产物中不再出现明文字符串');

  const gated = await call('/api/obfuscate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: SAMPLE, options: { preset: 'max' } }),
  });
  ok(gated.status === 403, '越界预设经 API 返回 403');

  const missing = await call('/api/nope');
  ok(missing.status === 404, '未知路由返回 404');

  const pre = await call('/api/obfuscate', { method: 'OPTIONS' });
  ok(pre.status === 204 && pre.headers.get('access-control-allow-origin') !== null, 'OPTIONS 预检带 CORS 头');

  // 激活流程：用 keygen 的签发路径造一张卡密，走 /api/license 激活
  const keys = [TEST_SIGNING_SEED, TEST_PUBLIC_KEY];
  const issued = codec.issueCode(keys[0], 'pro', 30, '98765');
  const act = await call('/api/license', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-JSLB-Device': 'b'.repeat(32) },
    body: JSON.stringify({ key: issued }),
  });
  const actJson = await act.json();
  ok(act.status === 200 && actJson.ok === true && actJson.plan === 'pro' && actJson.trial === false,
    'POST /api/license 激活 Pro 卡密', JSON.stringify(actJson && actJson.message));
  ok(actJson.preset === 'medium', '激活后预设上限取自套餐');

  const afterAct = await call('/api/obfuscate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-JSLB-Key': issued, 'X-JSLB-Device': 'b'.repeat(32) },
    body: JSON.stringify({ code: SAMPLE, options: { preset: 'medium', seed: 2 } }),
  });
  const afterJson = await afterAct.json();
  ok(afterAct.status === 200 && afterJson.ok === true, '激活后可跑套餐内预设');
  ok(afterJson.quota && afterJson.quota.used >= 1, '响应里带用量');

  const tampered = await call('/api/obfuscate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-JSLB-Key': issued.replace(/-R-/, '-B-') },
    body: JSON.stringify({ code: SAMPLE, options: { preset: 'low' } }),
  });
  ok(tampered.status === 401, '改过套餐段的卡密被拒（401）');
}

// ---------------------------------------------------------------- ZIP

section('ZIP 打包');
{
  const files = [
    { name: 'a.js', data: 'console.log("a");\n' },
    { name: 'sub/b.js', data: '中文字符串\n' },
  ];
  const bytes = zip(files, new Date('2026-01-02T03:04:05Z'));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  ok(view.getUint32(0, true) === 0x04034b50, '本地文件头签名正确');

  // 中央目录偏移与条目数
  const eocd = bytes.length - 22;
  ok(view.getUint32(eocd, true) === 0x06054b50, '中央目录结束记录签名正确');
  ok(view.getUint16(eocd + 10, true) === files.length, '条目数为 2');
  const cdOffset = view.getUint32(eocd + 16, true);
  ok(view.getUint32(cdOffset, true) === 0x02014b50, '中央目录项签名正确');

  // 第一个条目的 CRC 与内容
  const nameLen = view.getUint16(26, true);
  const dataStart = 30 + nameLen;
  const dataLen = view.getUint32(18, true);
  const crcStored = view.getUint32(14, true);
  const payload = bytes.subarray(dataStart, dataStart + dataLen);
  ok(crcStored === zlib.crc32(payload), 'CRC-32 与 zlib 一致');
  ok(hash.utf8Length('console.log("a");\n') === dataLen, '大小字段正确');

  // 用系统解压器验证一遍（unzip / PowerShell / bsdtar 任取其一）
  const zipPath = path.join(TMP, 'test.zip');
  fs.writeFileSync(zipPath, bytes);
  const dir = path.join(TMP, 'unzip');
  fs.mkdirSync(dir, { recursive: true });
  const extracted = tryExtract(zipPath, dir);
  if (extracted) {
    ok(fs.existsSync(path.join(dir, 'a.js')) && fs.existsSync(path.join(dir, 'sub', 'b.js')),
      '系统解压器能还原两个条目', extracted);
    const round = fs.readFileSync(path.join(dir, 'sub', 'b.js'), 'utf8');
    ok(round === '中文字符串\n', '解压内容与原文一致（含中文）');
  } else if (VERBOSE) {
    console.log('    （本机没有可用的解压器，跳过解压验证）');
  }
}

// ---------------------------------------------------------------- 逻辑表达式取值语义

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

// ---------------------------------------------------------------- 数值常量混淆

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
}

// ---------------------------------------------------------------- 多态与可复现

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
    preset: 'medium', vmProtection: false, wasm: false, stringArray: false,
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

// ---------------------------------------------------------------- 自防御：篡改检出

section('自防御：篡改检出');
{
  // 机制层（字符串池解码器）过去不在校验面内，改了解码器没人发现。这条测试
  // 直接往解码器函数体里插一条无害语句 `0;`——语义完全不变，只有文本变了——
  // 期望产物立刻检出（毒化字符串）。只靠"产物能跑"是抓不到这事的。
  //
  // 覆盖依赖布局（访问器声明要还在根体里），所以先找一个真的覆盖上了的 seed，
  // 一个都覆盖不上就算失败：那说明覆盖被后续改动弄丢了。
  const src = 'function fib(n){if(n<2)return n;return fib(n-1)+fib(n-2);}\n' +
    'var s="hello world";\nconsole.log(fib(8), s.length, s);';
  const want = runNode(src, 'sd-plain.js').trim();
  let picked = null;
  for (let seed = 1; seed <= 6 && !picked; seed++) {
    const r = obfuscate(src, { preset: 'medium', seed, shell: false });
    const ic = r.stats.find((s) => s.pass === 'integrityCheck');
    if (ic && ic.result && ic.result.machinery > 0) picked = { seed, code: r.code };
  }
  ok(!!picked, '机制层（字符串池访问器）进入完整性校验面',
    picked ? '' : 'medium 预设 6 个 seed 都没覆盖到访问器');

  if (picked) {
    // 篡改后的产物会抛（毒化后成员访问失败），runNode 直接抛异常会中断整个
    // 自测，这里统一收口成字符串
    const tryRun = (c, name) => {
      try { return runNode(c, name).trim(); } catch (e) { return 'ERR'; }
    };
    const code = picked.code;
    const clean = tryRun(code, 'sd-ok.js');
    ok(clean === want, '未篡改的产物输出正确', clean.slice(0, 40));

    // 往每一处 `return function(...){` 的函数体开头插一条无害语句。产物里有多
    // 处返回函数（诱饵函数、熵闭包、解码器都长这样），只挑一处会挑错；全插则
    // 被覆盖的解码器必然在其中，而 `0;` 插在任何函数体开头都不会改语义
    let patched = code;
    let inserted = 0;
    let at = 0;
    for (;;) {
      const k = patched.indexOf('return function(', at);
      if (k < 0) break;
      const j = patched.indexOf('{', k);
      if (j < 0) break;
      patched = patched.slice(0, j + 1) + '0;' + patched.slice(j + 1);
      inserted++;
      at = j + 3;
    }
    ok(inserted > 0, '能在产物里定位到返回函数（共 ' + inserted + ' 处）');
    if (patched) {
      const got = tryRun(patched, 'sd-tampered.js');
      ok(got !== want, '往返回函数插一条无害语句即被检出（字符串被毒化）',
        '篡改后仍然输出 ' + got.slice(0, 40));
    }

    // 运行时保护：把 Function.prototype.toString 换成非原生实现（解壳的第一步
    // 就是这么干），产物必须检出。注意这条验证的是"整体会响应"，命中既可能来
    // 自原生性探针，也可能来自哈希面本身——两者都依赖 toString 取函数源码
    const hook = 'Function.prototype.toString=function(){return "function toString() { [code] }";};';
    const hooked = tryRun(hook + code, 'sd-hooked.js');
    ok(hooked !== want, '钩住 Function.prototype.toString 即被检出',
      '钩子环境下仍然输出 ' + hooked.slice(0, 40));

    // 主校验面：改一个根级函数声明的函数体也必须被检出。关掉 mangle 才认得出
    // 名字（生成器输出是 `function fib (`，按 "function fib(" 找会漏）
    const named = obfuscate(src, { preset: 'medium', seed: picked.seed, mangle: false, shell: false }).code;
    const head = named.match(/function\s+fib\s*\(/);
    ok(!!head, '关掉重命名后能定位到根级函数声明');
    if (head) {
      const i = named.indexOf(head[0]);
      const j = named.indexOf('{', i);
      const patched2 = j >= 0 ? named.slice(0, j + 1) + '0;' + named.slice(j + 1) : null;
      const got2 = patched2 ? tryRun(patched2, 'sd-fn.js') : want;
      ok(got2 !== want, '改根级函数体即被检出（头部哈希面生效）',
        '篡改后仍然输出 ' + String(got2).slice(0, 40));
    }
  }
}

// ---------------------------------------------------------------- ESM 说明符绑定

section('ESM 说明符绑定');
{
  // 2026-09-20 修掉的缺陷：`import { A as B }` 里 imported 侧（A）被 traverse 的
  // isRefByIdent 当成变量引用，但它本就没有绑定，于是混淆后自检报一处**假的**
  // "未绑定引用"——任何用了别名导入的 ESM 源码都直接混淆失败，报的还是一个查不到
  // 的标识符。CJS 用户不受影响，所以他们最先撞上的是 i18n.js 这类自身源码。
  //
  // 只排除 local 不够：shorthand（`import { A }`）两侧指向同一节点，恰好被
  // local 判断覆盖，所以这个 bug 只在写了别名的文件上暴露。
  //
  // 反向也要守住：export 的 local 是**真实引用**，`export { c as d }` 里的 c 若
  // 没声明必须继续报出来，别把两类说明符一起放过。
  const pass = [
    'import { VERSION as PKG_VERSION } from "./version.js"; var s = `${PKG_VERSION}`;',
    'import { a as x, b as y } from "./m.js"; console.log(x, y);',
    'import D, { n as N } from "./m.js"; import * as NS from "./n.js"; console.log(D, N, NS);',
    'import { o as o1 } from "m"; const f = ({ a: aa }) => aa + o1;',
    'var a = 1; export { a as b };',
  ];
  let bad = '';
  for (let i = 0; i < pass.length; i++) {
    try {
      obfuscate(pass[i] + '\n', { preset: 'medium' });
    } catch (e) {
      bad = '例' + i + '：' + String(e && e.message).split('\n')[0];
      break;
    }
  }
  ok(bad === '', '别名 import / 各类 ESM 说明符不再误报未绑定引用', bad);

  // 真未绑定必须继续检出，否则自检形同虚设
  throws(() => obfuscate('export { notDeclared as d };\n', { preset: 'medium' }),
    'export 指向未声明绑定时仍然报错（未过度放行）');
}

// ---------------------------------------------------------------- BigInt 与谓词

section('BigInt 与不透明谓词');
{
  // 2026-09-20 修掉的缺陷：opaquePredicates 的"活值原子"对函数参数做位运算
  // （`v >>> 0`、`v & 0xff`、`v ^ 0xff00`），隐含假定参数是 Number。参数装
  // BigInt 时 `BigInt & Number` 直接抛 TypeError，装 Symbol 同样抛——而参数的
  // 实际类型在构建期无从得知。
  //
  // 发现路径：用混淆器混淆自己时 ed25519.js 一加载就 TypeError。凡是用户代码
  // 里出现 BigInt 都会中招，所以这里按"跨多 seed"测，命中依赖随机数。
  const cases = [
    // 参数直接是 BigInt，函数体里还用它做运算
    'function f(a) { var r = a + 1n; return r * 2n; } console.log(String(f(10n)));',
    // 参数是 Symbol（位运算同样会抛）
    'function g(s) { return typeof s === "symbol" ? s.toString() : "no"; } console.log(g(Symbol("x")));',
    // 参数是对象与字符串，位运算会做隐式转换，也必须保持取值
    'function h(o) { return o && o.v ? o.v + 1 : -1; } console.log(h({ v: 41 }), h(null));',
    // 真实场景：大整数运算（RSA/椭圆曲线这类）
    'function modpow(b, e, m) { var r = 1n; b = b % m; while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; } console.log(String(modpow(3n, 200n, 1000000007n)));',
  ];
  // 用 runNode（写临时文件）而不是 node -e：混淆产物动辄几十上百 KB，
  // Windows 的命令行长度上限约 32 KB，用 -e 传会 spawn 失败，看起来像"产物抛错"。
  let mismatch = 0;
  let firstBad = '';
  for (let ci = 0; ci < cases.length; ci++) {
    let want;
    try {
      want = runNode(cases[ci], 'bigint-plain-' + ci + '.js').trim();
    } catch (e) {
      // 原样本本身就跑不了就跳过，不算失败
      continue;
    }
    for (let seed = 1; seed <= 6; seed++) {
      let got;
      try {
        got = runNode(obfuscate(cases[ci], { preset: 'medium', seed }).code,
          'bigint-' + ci + '-' + seed + '.js').trim();
      } catch (e) {
        got = 'THREW: ' + String(e.message).split('\n')[0];
      }
      if (got !== want) {
        mismatch++;
        if (!firstBad) firstBad = '例' + ci + ' seed=' + seed + '：混淆后 ' + got.slice(0, 80) + '，应为 ' + want;
      }
    }
  }
  ok(mismatch === 0, 'BigInt / Symbol / 对象参数不被谓词位运算弄坏（4 例 × 6 seed）', firstBad);
}

// ------------------------------------------------ VM 保护与用户标识符冲突

section('VM 保护与用户标识符冲突');
{
  // 2026-09-21 修掉的缺陷：解释器 case 体的局部名是硬编码的 a/b/c/v/f/k/o/x0，
  // 而跳转分支用 `var` 声明——var 提升到函数作用域，会把用户同名的变量整个覆盖掉。
  // 实测用户变量叫 a 时，第一条 if 的跳转分支把 a 写成跳转目标地址，之后 typeof a
  // 恒得 "number"、数值比较恒假，而且**不报错**。影响 medium/high/max（全部付费档位）。
  //
  // 覆盖要点：变量名叫 a（以及 b/c/x0/x1/f/k/o/v/n 这些解释器曾占用的名字）、
  // 函数里不止一条 if（否则跳转分支不执行，碰不到覆盖）、跨预设跨 seed。
  const cases = [
    // 参数为 a + 两条 if + typeof
    'function f(a){ if(a===0) return "n0"; if(typeof a==="number") return "num"; return "end"; }'
      + ' console.log(f(0), f(9), f("z"));',
    // 局部变量 a 参与两条 if
    'function g(){ var a=7; if(a>5) return "big"; if(a<10) return "small"; return "no"; }'
      + ' console.log(g());',
    // a 作为循环变量（跳转回边）
    'function h(n){ var s=0, a=0; for(a=0; a<n; a++) s+=a; return s; } console.log(h(5));',
    // 一批曾经会让解释器撞名的标识符
    'function k(a,b,c,v,n,f,o){ if(a>b) return "ab"; if(c<v) return "cv"; if(n!==f) return "nf";'
      + ' return o; } console.log(k(2,1,3,4,5,6,"tail"));',
    // a 上是对象，走 GETM / SETM / CALLM
    'function m(a){ if(a.length>2) return a.toUpperCase(); if(a.length===1) return "one";'
      + ' return "other"; } console.log(m("abcd"), m("x"), m("yz"));',
  ];
  const runNode = (code, name) => {
    const file = path.join(TMP, name + '.js');
    fs.writeFileSync(file, code);
    return execFileSync(process.execPath, [file], { encoding: 'utf8', timeout: 30000 }).trim();
  };
  let mismatch = 0;
  let firstBad = '';
  for (let ci = 0; ci < cases.length; ci++) {
    const want = execFileSync(process.execPath, ['-e', cases[ci]], { encoding: 'utf8' }).trim();
    // vmProtection 只在 medium 及以上开启，low 也一并测作对照
    for (const preset of ['low', 'medium', 'high', 'max']) {
      for (let seed = 1; seed <= 3; seed++) {
        const out = obfuscate(cases[ci], { preset, seed }).code;
        let got;
        try { got = runNode(out, 'vm-' + ci + '-' + preset + '-' + seed); }
        catch (e) { got = 'THREW: ' + String(e.message).split('\n')[0]; }
        if (got !== want) {
          mismatch++;
          if (!firstBad) firstBad = '例' + ci + ' ' + preset + ' seed=' + seed
            + '：' + got.slice(0, 60) + '，应为 ' + want.slice(0, 60);
        }
      }
    }
  }
  ok(mismatch === 0, 'VM 保护不覆盖用户名为 a/b/c/v/n/f/o 的变量（5 例 × 4 预设 × 3 seed）', firstBad);
}

// ---------------------------------------------------------------- 收尾

section('其他');
{
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

  // 字符串代码生成：Cloudflare Workers 一律拒绝（eval 与 new Function 都在禁用
  // 名单里），上传时直接报 EvalError: Code generation from strings disallowed，
  // 整个 Worker 发不出去。判据只看真实的调用形态，放过 AST 访问器里那些名为
  // Function 的方法定义（形如 `Function(path) {`）。
  const codegen = [];
  for (const f of coreFiles) {
    const text = stripLiterals(fs.readFileSync(f, 'utf8'));
    if (/new\s+Function\s*\(/.test(text) || /\(\s*0\s*,\s*eval\s*\)/.test(text)
      || /[^.\w]eval\s*\(/.test(text)) {
      codegen.push(path.relative(ROOT, f));
    }
  }
  ok(codegen.length === 0, '核心模块图内没有字符串代码生成（Cloudflare 禁用 eval / new Function）',
    codegen.join(', '));

  // shell 引导器原语有两份实现：产物里那份文本（PRIMITIVES_TEXT）与构建期那份
  // 直接实现。原先靠 (0,eval) 当场求值保证不漂移，eval 被 Cloudflare 禁掉之后
  // 改成手写，这里逐位比对把"不漂移"重新钉死。eval 只出现在本文件里，而本文件
  // 不随 Worker 上传。
  {
    const shellMod = await import('../../src/passes/shell.js');
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

// ---------------------------------------------------------------------------
// 线上验收（需要网络）
//
// 打已部署的 Cloudflare 站点，验证"本地构建的东西真的在线上跑着"。这一段是
// 唯一会走网络的测试：它验的是部署，不是算法。算法与授权链路的判定在前面的
// 离线段里已经全部覆盖过了，两者互补。
//
//   JSLB_LIVE_ORIGIN   覆盖目标域名（默认 jslb.lllm.dpdns.org）
//   JSLB_SKIP_LIVE=1   跳过本段（离线跑测试时用）
//
// 注意：本段通过与网络状况有关。它失败时先看是"站点不可达"还是"内容不对"——
// 前者是环境问题，后者才是部署问题。
// ---------------------------------------------------------------------------
const LIVE_ORIGIN = (process.env.JSLB_LIVE_ORIGIN || 'https://jslb.lllm.dpdns.org').replace(/\/+$/, '');
if (process.env.JSLB_SKIP_LIVE === '1') {
  console.log('\n线上验收（已按 JSLB_SKIP_LIVE=1 跳过）');
} else {
  section('线上验收：' + LIVE_ORIGIN);

  /** 带超时的 GET，返回 {status, text} 或 {status:0, err}。 */
  async function getLive(p, init) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(LIVE_ORIGIN + p, { ...init, signal: ctl.signal });
      return { status: r.status, text: await r.text() };
    } catch (e) {
      return { status: 0, err: (e && e.message) || String(e) };
    } finally {
      clearTimeout(t);
    }
  }

  const health = await getLive('/api/health');
  const reachable = health.status === 200;
  ok(reachable, '线上 /api/health 可达并返回 200',
    reachable ? '' : ('status=' + health.status + ' ' + (health.err || '')));

  if (!reachable) {
    // 站点都够不着，后面每项都会失败，只报一次即可，别刷屏。
    console.log('  （线上不可达，跳过后续线上断言）');
  } else {
    let info = null;
    try { info = JSON.parse(health.text); } catch { /* 下面断言会兜住 */ }
    ok(info && info.ok === true, 'health 返回 ok:true', health.text.slice(0, 120));
    ok(info && info.runtime === 'worker', 'health 标明 runtime=worker',
      info ? String(info.runtime) : '');
    ok(info && info.engine === 'cloudflare-worker', 'health 标明 engine=cloudflare-worker',
      info ? String(info.engine) : '');

    const plans = await getLive('/api/plans');
    ok(plans.status === 200, '线上 /api/plans 返回 200', 'status=' + plans.status);
    let plansBody = null;
    try { plansBody = JSON.parse(plans.text); } catch { /* ignore */ }
    ok(!!(plansBody && Array.isArray(plansBody.plans) && plansBody.plans.length > 0),
      '线上 /api/plans 返回非空套餐表',
      plansBody ? Object.keys(plansBody).join(',') : plans.text.slice(0, 120));
    // 网页版策略要求激活卡密：未激活一律拒绝，这一点必须在线上成立。
    // 注意策略挂在 body.web 下（不是顶层），见 worker/index.js 的 /api/plans。
    ok(!!(plansBody && plansBody.web && plansBody.web.requireLicense === true),
      '线上策略 web.requireLicense=true（未激活即拒绝）',
      plansBody && plansBody.web ? JSON.stringify(plansBody.web).slice(0, 160) : '');

    // 未授权调用 /api/obfuscate 必须被拒（不是 200），否则等于线上白送。
    const unauth = await getLive('/api/obfuscate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'var a=1;', preset: 'low' }),
    });
    ok(unauth.status !== 200,
      '线上未授权混淆被拒（不是 200）', 'status=' + unauth.status);

    // 核心源码闸门：未激活请求 /src/index.js 必须 403，不能白拿实现。
    const gated = await getLive('/src/index.js');
    ok(gated.status === 403, '线上 /src/index.js 对未激活设备返回 403',
      'status=' + gated.status);

    // 静态外壳必须能拿到，否则页面根本打不开。
    const shell = await getLive('/index.html');
    ok(shell.status === 200, '线上 /index.html 可访问', 'status=' + shell.status);

    console.log('  线上段依赖网络：失败时先区分"站点不可达"与"内容不符"。');
  }
}

cleanTmp();

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败项') + '：' + pass + ' 项通过，' + fail + ' 项失败');
if (fail) {
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
