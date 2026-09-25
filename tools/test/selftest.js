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
 *   外壳形态   jsfuck 形态编解码往返、产物可执行、多层叠加与横幅互锁、超限构建失败
 *   许可证     codec 签发-校验往返、篡改卡密/用量/套餐一律失败
 *   机器码     服务端按卡密编号签发并永久绑定（同卡恒等、异卡不同、激活前后一致）
 *   网页链路   runJob 在浏览器侧等价路径上可跑通（授权、限额、记账）
 *   额度包     一次性额度按总额度累计、跨日不重置、用尽即拦
 *   解除激活   服务端按设备码存的那份记录被真正删掉，刷新不再恢复
 *   Worker API health / plans / license / machine / obfuscate 五个路由（进程内，不打网络）
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

// 测试专用签发密钥对。
//
// 真私钥不随源码分发（这正是换成非对称的目的），所以自测不能拿它签卡——也不该
// 拿。测试自己固定一对：种子写死在这里，公钥由它派生，再通过 setKeyMaterial /
// JSLB_CODE_KEY 注入到 license-web 与 Worker。走的签发/校验代码路径与线上完全
// 相同，只有密钥不同。种子是公开的常量，仅供测试，绝不能用于真实发卡。
const TEST_CODE_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

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
  process.stdout.write([GREETING, tpl, obj['beta-gamma'].length, obj.nested.deep.key, c.value, list.join('|'), classify(400)].join(' ') + '\n');
}
main();
`;

/**
 * 同步跑一个子进程并拿回输出。
 *
 * stdio 必须**显式写成数组**：默认管道（含 `stdin: 'ignore'` 简写之外的默认
 * 'pipe'）在部分 Windows 环境会直接以 EBUSY 失败——父进程的标准句柄来自上层
 * 宿主（IDE 内置终端、CI 包装器）时，spawnSync 建 stdin 管道这一步就过不去，
 * 整套测试会在第一个用例崩掉。stdout/stderr 仍是管道，返回值照常。
 * `stdio: 'ignore'`（三项全忽略，无管道）在同样环境下是好的，无需改动。
 */
const SYNC_STDIO = ['ignore', 'pipe', 'pipe'];
// spawn 阶段的瞬时资源失败（Windows 高强度进程孵化下偶发）：errno 挂在 code
// 上且没有子进程 status。与产物非零退出（有 status）区分开，前者退避后重试
// 一次，后者照常抛出交给用例判定。
const TRANSIENT_SPAWN_ERRNO = new Set(['ENOMEM', 'EBUSY', 'ETXTBSY', 'EAGAIN', 'EMFILE']);
function runSync(exe, args, opts) {
  try {
    return execFileSync(exe, args, { stdio: SYNC_STDIO, ...(opts || {}) });
  } catch (e) {
    if (e && !e.status && TRANSIENT_SPAWN_ERRNO.has(e.code)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      return execFileSync(exe, args, { stdio: SYNC_STDIO, ...(opts || {}) });
    }
    throw e;
  }
}

/** 用 node 跑一段产物，返回 stdout。 */
function runNode(code, name) {
  const file = path.join(TMP, name || ('run-' + Math.random().toString(36).slice(2) + '.js'));
  fs.writeFileSync(file, code);
  return runSync(process.execPath, [file], { encoding: 'utf8', timeout: 60000 });
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
  // v5：对称卡密密钥 + 加密信息段 + 校验码（格式 JSLB-编号8-信息16-校验4）。
  // 密钥随源码分发（见 license-secret.js 的说明），防篡改靠校验码；"一卡一机"
  // 由服务端赎回登记承担，卡密不再携带绑定段。
  const key = TEST_CODE_KEY;
  const code = codec.issueCode(key, 'plus', 30, '12345');
  ok(!!code && code.startsWith('JSLB-'), '可签发 Plus/30 天卡密', code);
  ok(codec.normalizeCode(code).length === 4 + codec.BODY_LEN,
    '卡密总长 = 前缀4+编号8+信息16+校验4', String(codec.normalizeCode(code).length));
  const parsed = codec.parseCode(key, code);
  ok(parsed.ok && parsed.plan === 'plus' && parsed.days === 30, '卡密可解析且套餐天数正确');
  ok(parsed.id === '12345', '编号可还原（40 bit）');
  ok(typeof parsed.issueDay === 'number' && parsed.issueDay >= 0, '卡密带签发日');
  ok(parsed.bound === false && parsed.bindSeg === codec.BIND_NONE, 'v5 卡密不携带绑定段');
  ok(codec.parseCode(key, code.toLowerCase().replace(/-/g, ' ')).ok, '小写与分隔符容错');

  // 同一参数两次签发产出不同卡密（信息段带随机 IV），但都能被同一把密钥解析
  const again = codec.issueCode(key, 'plus', 30, '12345');
  ok(again !== code, '同参数两次签发卡密不同（随机 IV）');
  const againParsed = codec.parseCode(key, again);
  ok(againParsed.ok && againParsed.id === '12345' && againParsed.plan === 'plus',
    '随机 IV 不影响解析');

  // 校验码覆盖编号段与信息段：改任何一段的一位都必须被拒
  const flipChar = (t, i) => {
    const c = t[i] === '0' ? '1' : '0';
    return t.slice(0, i) + c + t.slice(i + 1);
  };
  ok(!codec.parseCode(key, flipChar(code, 6)).ok, '改编号段一位即被拒');
  ok(!codec.parseCode(key, flipChar(code, 16)).ok, '改信息段一位即被拒');
  ok(!codec.parseCode(key, flipChar(code, code.length - 1)).ok, '改校验码一位即被拒');
  // 末位改成与当前值**不同**的字符：直接写死 '0' 时，若签发出的校验码末位本就是
  // '0'，这行等于没改，解析自然成功——概率性假红（1/32），与上面的 flipChar 同理
  ok(!codec.parseCode(key, code.slice(0, -1) + (code.endsWith('0') ? '1' : '0')).ok, '改末位失败');
  ok(!codec.parseCode(key, 'JSLB-' + '0'.repeat(8) + '-' + '0'.repeat(16) + '-' + '0'.repeat(4)).ok,
    '全零编号+全零信息+全零校验被拒');

  // 对称体系下"没有正确的密钥就签不出能通过校验的卡"：错误密钥签出的卡密
  // 在校验码这一步必然失败（这里验的是拿错密钥冒充不会意外通过）。
  const otherKey = hash.bytesToB64(new Uint8Array(32).fill(9));
  const forged = codec.issueCode(otherKey, 'business', 0, '99999');
  ok(!!forged && !codec.parseCode(key, forged).ok, '错误密钥签发的卡密无法通过校验');

  // 编号段超界必须拒绝
  ok(codec.issueCode(key, 'plus', 30, '1099511627775') !== null, '编号上限内可签发');
  ok(codec.issueCode(key, 'plus', 30, '1099511627776') === null, '编号超 40 bit 上限时拒绝签发');
  ok(codec.MAX_ID === 1099511627775n, '编号上限恰为 2^40-1', String(codec.MAX_ID));

  // 签发日在加密载荷里，到期时间由它推出——这是"本地改不了自己的有效期"的依据。
  // 用 2026-01-01（距零点 2192 天）签 30 天，到期必须是 2026-01-31，而不是"激活时刻 + 30 天"。
  {
    const day = 2192; // 2026-01-01 距 2020-01-01 UTC 的天数
    const c = codec.issueCode(key, 'plus', 30, '12345', day);
    const p = codec.parseCode(key, c);
    ok(p.ok && p.issueDay === day, '签发日可从卡密还原', String(p.issueDay));
    const exp = licCore.expiryFromIssueDay(p);
    ok(exp === codec.DAY_ZERO + (day + 30) * 86400000,
      '到期时间 = 签发日 + 天数（不采信记录里的 issuedAt）',
      new Date(exp).toISOString().slice(0, 10));
    ok(new Date(exp).toISOString().slice(0, 10) === '2026-01-31',
      '2026-01-01 签的 30 天卡到期日为 2026-01-31');
    // 永久卡不受签发日影响
    const perm = codec.parseCode(key, codec.issueCode(key, 'plus', 0, '12345', day));
    ok(licCore.expiryFromIssueDay(perm) === codec.PERPETUAL, '永久卡到期时间为 0');
  }

  const mid = 'ABCDEFGHJKMNPQRSTVWXYZ01';
  const token = codec.makeToken(key, mid, 0, '2026-01-01', 3);
  ok(codec.verifyToken(key, token, mid, 0, '2026-01-01', 3), '令牌验签通过');
  ok(!codec.verifyToken(key, token, mid, 0, '2026-01-01', 4), '改用量次数后验签失败');
  ok(!codec.verifyToken(key, token, 'ZZZZZZZZZZZZZZZZZZZZZZZ1', 0, '2026-01-01', 3), '换机器码后验签失败');
  // 令牌密钥由卡密密钥派生，换一把密钥就对不上
  ok(!codec.verifyToken(secret.B64_CODE_KEY, token, mid, 0, '2026-01-01', 3), '换密钥后令牌验签失败');

  // 纯 JS HMAC 与 node:crypto 的一致性由 tools/test/hashtest.js 覆盖，这里只跑它
  const ht = runSync(process.execPath, [path.join(ROOT, 'tools', 'test', 'hashtest.js')], { encoding: 'utf8' });
  ok(ht.includes('全部通过'), 'hash 实现与 node:crypto 逐位一致', ht.trim().split('\n').pop());
}

// ------------------------------------------------------------ 端到端激活（v5）

section('端到端激活（v5 卡密）');
{
  // v5 卡密不携带绑定段：matchesMachine 对任何机器码恒真——"一卡一机"由服务端
  // 赎回登记强制（见 license-web.activate 的 redeem 检查）。机器码摘要本身仍
  // 逐位区分，赎回登记按它记录赎回者。
  const key = TEST_CODE_KEY;
  const midA = 'ABCDEFGHJKMNPQRSTVWXYZ01';
  const midB = 'ABCDEFGHJKMNPQRSTVWXYZ02'; // 与 A 只差最后一位
  const free = codec.parseCode(key, codec.issueCode(key, 'plus', 30, '12345', 2192));
  ok(free.ok && free.bound === false && free.bindSeg === codec.BIND_NONE, 'v5 卡密绑定段恒为全 0');
  ok(codec.matchesMachine(free.bindSeg, midA) && codec.matchesMachine(free.bindSeg, midB),
    '不绑定的卡在任何机器上都放行');
  ok(codec.bindDigest(midA) !== codec.bindDigest(midB), '机器码摘要仍逐位区分（赎回登记用）');

  {
    platform.setKv(null);
    platform.setStorage(platform.newMemoryStorage());
    licenseWeb.setKeyMaterial(key, null);
    licenseWeb.resetRequestState();
    // 签发日必须取今天：到期时间由"签发日 + 天数"推出，restore 会验过期。
    const today = Math.floor((Date.now() - codec.DAY_ZERO) / 86400000);

    const own = codec.issueCode(key, 'plus', 30, '24681', today);
    const goodAct = await licenseWeb.activate(own);
    ok(goodAct.ok && goodAct.plan === 'plus', '不绑定卡 activate 成功');
    ok(licenseWeb.isLicensed(), '激活后进入已授权状态');
    const rest = await licenseWeb.restore();
    ok(rest.ok, '激活写下的记录可被 restore 恢复');

    // 过期卡：activate 这一刻就拒绝，不留到 restore（Worker 按卡密激活的 API
    // 请求每次重放都走 activate，过期检查必须在激活入口生效）。
    licenseWeb.resetRequestState();
    platform.setStorage(platform.newMemoryStorage());
    const stale = codec.issueCode(key, 'plus', 30, '24682', today - 60);
    const staleAct = await licenseWeb.activate(stale);
    ok(!staleAct.ok && staleAct.reason === 'expired',
      '过期卡 activate 即被拒（reason=expired）', staleAct.reason);
    ok(!licenseWeb.isLicensed() && (await licenseWeb.exportRecord()) === null,
      '过期卡拒激活后无权益、不落盘');

    licenseWeb.resetRequestState();
    platform.setStorage(null);
  }
}


// ------------------------------------------------------------ 自锚定校验

// 服务端（Cloudflare Worker）里没有 navigator / screen / WebGL，machineId() 派生出的
// 值与浏览器派的永不相等（Worker 实测 4CFS7ZE5899W3R803S439Y2F，浏览器实测
// 1K9W9H9S065P0C7M834C1XC8）。所以 Worker 侧的网关必须用"自锚定"模式校验：
// 锚点取记录自己声称的 machine，再验卡密校验码、令牌与到期时间是否与它自洽。
//
// 这一节钉住三件事：自锚定能放行正常记录、严格模式不会因此被放松、伪造仍然过不去。

section('自锚定校验（服务端网关）');
{
  const seed = TEST_CODE_KEY;
  const pub = TEST_CODE_KEY;
  const browserMid = '1K9W9H9S065P0C7M834C1XC8'; // 浏览器派生（记录里的 machine）
  const serverMid = '4CFS7ZE5899W3R803S439Y2F';  // Worker 派生（网关手里的 machine）

  // 签发日必须晚于当前时间，否则校验会在 expired 那一步先失败，掩盖掉这里要验的
  // bind / token 判定。往上取一段余量而不是写死某天，免得测试随时间腐烂。
  const issueDay = Math.floor((Date.now() - codec.DAY_ZERO) / 86400000) + 3650;

  // 卡绑到浏览器机器码 —— 线上就是这种情况
  const parsed = codec.parseCode(pub, codec.issueCode(seed, 'plus', 30, '70001', issueDay));
  ok(parsed.ok, '自锚定用例：不绑定卡可解析');
  const rec = licCore.makeRecord({
    code: parsed.code, plan: 'plus', machine: browserMid,
    issuedAt: Date.now(), expiresAt: licCore.expiryFromIssueDay(parsed),
    usage: { day: '2026-01-01', used: 0 },
  }, pub);

  // 严格模式：本机码相同 → 放行；换成 Worker 派的码 → 必须拒绝
  ok(licCore.verifyLicenseData(rec, browserMid, pub).ok, '严格模式：机器码一致时放行');
  {
    const res = licCore.verifyLicenseData(rec, serverMid, pub);
    // v5 卡密不带绑定段，异机拒绝来自记录 machine 与锚点的比对（reason=machine）。
    ok(!res.ok && res.reason === 'machine', '严格模式：换成服务端机器码时判 machine', res.reason);
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

  // 安全性：自锚定的锚点来自记录，v5 下兜底的是令牌（machine 进令牌载荷）
  {
    const forged = { ...rec, machine: 'ZZZZZZZZZZZZZZZZZZZZZZZZ' };
    const res = licCore.verifyLicenseData(forged, null, pub);
    ok(!res.ok && res.reason === 'token', '自锚定：改 machine 会被令牌拦下（绑定职能由服务端赎回登记承担）', res.reason);
  }
  {
    // v5 已知边界：连令牌一起同步伪造的自锚定记录在卡密层放行（校验码与令牌
    // 都自洽）。这是对称体系的固有属性；"一卡一机"由服务端赎回登记兜底。
    const machine = 'ZZZZZZZZZZZZZZZZZZZZZZZZ';
    const forged = {
      ...rec,
      machine,
      token: codec.makeToken(pub, machine, rec.expiresAt, rec.usage.day, rec.usage.used),
    };
    const res = licCore.verifyLicenseData(forged, null, pub);
    ok(res.ok, '自锚定已知边界：令牌与 machine 同步伪造在卡密层放行（服务端赎回登记兜底）', res.reason);
  }
  {
    const tampered = { ...rec, usage: { day: rec.usage.day, used: 999 } };
    const res = licCore.verifyLicenseData(tampered, null, pub);
    ok(!res.ok && res.reason === 'token', '自锚定：篡改用量判 token', res.reason);
  }
  {
    // 卡密不绑机器（绑定段全 0）时，自锚定等价于"只看签名与令牌"
    const free = codec.parseCode(pub, codec.issueCode(seed, 'plus', 30, '70002', issueDay));
    ok(free.bound === false, '自锚定用例：通用卡不绑定机器');
    const freeRec = licCore.makeRecord({
      code: free.code, plan: 'plus', machine: serverMid,
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

section('签发工具命令行（v5 随机编号）');
{
  // 这一节必须真的把 keygen.js 当子进程跑，不能只调 codec。v5 的编号随机生成、
  // 无计数器；密钥从 JSLB_CODE_KEY 环境变量注入（假密钥是 32 字节非零 base64，
  // 签出的卡密语法合法且能被同一把假密钥解析）。
  const KEYGEN = path.join(ROOT, 'tools', 'issue', 'keygen.js');
  const FAKE_KEY = hash.bytesToB64(new Uint8Array(32).fill(7));
  const env = {
    ...process.env,
    JSLB_CODE_KEY: FAKE_KEY,
  };
  const gen = (args) => runSync(process.execPath, [KEYGEN, ...args], {
    encoding: 'utf8', timeout: 30000, env,
  });
  const genFail = (args, customEnv) => {
    try {
      runSync(process.execPath, [KEYGEN, ...args], { encoding: 'utf8', timeout: 30000, env: customEnv || env });
      return null;
    } catch (e) {
      return String((e.stderr || '') + (e.stdout || ''));
    }
  };

  // 默认签发：随机编号。产物必须是 v5 三段结构，且能被同一把密钥解析。
  const first = gen(['--plan', 'plus', '--days', '365']);
  const line = first.trim().split('\n')[0].trim();
  ok(line.startsWith('JSLB-'), '默认签发得到卡密', line.slice(0, 24) + '…');
  ok(codec.normalizeCode(line).length === 4 + codec.BODY_LEN, '卡密总长 = 前缀4+编号8+信息16+校验4');
  const parsedFirst = codec.parseCode(FAKE_KEY, line);
  ok(parsedFirst.ok && parsedFirst.plan === 'plus' && parsedFirst.days === 365,
    'keygen 产物可用其密钥解析，套餐天数正确');

  // 随机编号：两次签发卡密必然不同（随机编号 + 随机 IV）
  const second = gen(['--plan', 'plus', '--days', '365']);
  ok(second.trim() !== first.trim(), '两次签发卡密不同（随机编号与随机 IV）');

  // --count 3 出 3 张互不相同的卡密（批内随机去重）
  const batch = gen(['--plan', 'plus', '--days', '365', '--count', '3']).trim().split('\n');
  ok(batch.length === 3 && new Set(batch).size === 3, '--count 3 出 3 张互不相同的卡密',
    String(batch.length) + ' 行 / ' + new Set(batch).size + ' 张');

  // --id 显式指定：编号可还原
  const explicit = gen(['--plan', 'plus', '--days', '30', '--id', '12345']);
  const parsedExplicit = codec.parseCode(FAKE_KEY, explicit.trim());
  ok(parsedExplicit.ok && parsedExplicit.id === '12345', '--id 指定的编号可从卡密还原');

  // --id 越界：错误信息必须指向 --id
  const tooBig = genFail(['--plan', 'plus', '--id', String(Number(codec.MAX_ID) + 1)]);
  ok(tooBig !== null && /--id/.test(tooBig), '显式 --id 越界时报错并点出 --id',
    String(tooBig).trim().split('\n').pop());

  // --bind 已废除：报错要给出"改用赎回模型"的指引
  const bindErr = genFail(['--plan', 'plus', '--bind', 'ABCDEFGHJKMNPQRSTVWXYZ01']);
  ok(bindErr !== null && /绑定/.test(bindErr), '--bind 已废除并给出指引',
    String(bindErr).trim().split('\n')[0]);

  // 无环境变量、磁盘上也没有 .jslb-code-key 时，keygen 按设计**回退内置密钥**
  // （CODE_KEY 的兜底分支：内置密钥部署下签发与 --check 同源，开箱即用）。
  // 这里曾经断言"必须报错"，那是回退逻辑加进来之前的旧口径，已随实现过期。
  const noKeyEnv = { ...process.env };
  delete noKeyEnv.JSLB_CODE_KEY;
  const fallbackIssue = genFail(['--plan', 'plus'], noKeyEnv);
  ok(fallbackIssue === null, '无密钥时回退内置密钥签发（开箱即用，不再报错）',
    String(fallbackIssue).trim().split('\n')[0]);

  // 真正走报错分支的是"密钥存在但不可用"：32 字节 base64 之外的取值一律拒绝，
  // 免得把配置错误表现成"所有卡密都校验失败"
  const badKeyEnv = { ...process.env, JSLB_CODE_KEY: 'not-a-32-byte-base64-key' };
  const badKey = genFail(['--plan', 'plus'], badKeyEnv);
  ok(badKey !== null && /密钥/.test(badKey), '密钥不可用时明确报错并指出设置方式',
    String(badKey).trim().split('\n')[0]);

  // --machine 不需要密钥：即使在密钥不可用的环境下也必须正常
  const machineOut = runSync(process.execPath, [KEYGEN, '--machine', '--json'], {
    encoding: 'utf8', timeout: 30000, env: badKeyEnv,
  });
  let parsedMachine = null;
  try { parsedMachine = JSON.parse(machineOut.trim()); } catch { /* 下面断言报错 */ }
  ok(parsedMachine && parsedMachine.machine && parsedMachine.machine.length === 24
    && codec.isB32Text(parsedMachine.machine),
  '--machine 无需密钥即可打印 24 字符机器码',
  parsedMachine ? parsedMachine.machine : machineOut.trim());
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
  // loadKeysFromEnv() 只在 JSLB_CODE_KEY 有值时覆盖，这里直接设内存里的值。
  licenseWeb.setKeyMaterial(TEST_CODE_KEY, null);
  const keys = [TEST_CODE_KEY, TEST_CODE_KEY];
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
    const parsed = codec.parseCode(TEST_CODE_KEY, code);
    const rec = licCore.makeRecord({
      code: parsed.code, plan: parsed.plan, machine: mid,
      issuedAt: Date.now(),
      expiresAt: licCore.expiryFromIssueDay(parsed),
      usage: { day: '2020-01-01', used: used0 },
    }, TEST_CODE_KEY);
    store.set('jslabyrinth.license.v2:' + device, JSON.stringify(rec));
    const res = await licenseWeb.restore();
    return res;
  };

  ok((await seed(devPack, packCode, 'pack100', 0, 50)).ok, '旧日期的额度包记录仍可恢复');
  ok((await licenseWeb.quota()).used === 50, '额度包跨日累计：旧日期已用的次数照算');

  const plusCode = codec.issueCode(keys[0], 'plus', 30, '66666');
  ok((await seed(devSub, plusCode, 'plus', 30, 7)).ok, '旧日期的订阅档记录仍可恢复');
  ok((await licenseWeb.quota()).used === 0, '订阅档跨日归零');

  // 本地改 expiresAt 续期必须失败：到期时间由已签名的签发日推出
  {
    licenseWeb.resetRequestState();
    licenseWeb.setRequestDeviceId(devSub);
    const mid = await licenseWeb.machineId();
    const parsed = codec.parseCode(TEST_CODE_KEY, plusCode);
    const rec = licCore.makeRecord({
      code: parsed.code, plan: parsed.plan, machine: mid,
      issuedAt: Date.now(), expiresAt: licCore.expiryFromIssueDay(parsed),
      usage: { day: '2020-01-01', used: 0 },
    }, TEST_CODE_KEY);
    rec.expiresAt = parsed.days === 0 ? 0 : rec.expiresAt + 3650 * 86400000;
    store.set('jslabyrinth.license.v2:' + devSub, JSON.stringify(rec));
    const r = await licenseWeb.restore();
    ok(!r.ok && r.reason === 'expirymismatch', '本地改 expiresAt 续期被拒', r.reason);
  }

  // 解除激活：本设备那份必须真的从 KV 里消失
  licenseWeb.resetRequestState();
  licenseWeb.setRequestDeviceId(devSub);
  const act2 = await licenseWeb.activate(plusCode);
  ok(act2.ok && act2.plan === 'plus', '另一台设备激活成功');
  ok(store.has('jslabyrinth.license.v2:' + devSub), '许可证按设备码分键存进 KV');
  await licenseWeb.deactivate();
  ok(!store.has('jslabyrinth.license.v2:' + devSub), '解除激活删掉 KV 里那一条（真删，不是写空串）');
  const again = await licenseWeb.restore();
  ok(!again.ok && again.reason === 'missing', '之后再恢复读不到授权（刷新不会把卡密带回来）');

  platform.setKv(null);
  platform.setStorage(null);
}

// ---------------------------------------------------------------- 卡密赎回（防重复使用）

section('卡密赎回（严格一次性，防重复使用）');
{
  // 每张卡密只能激活一次（严格一次性）：赎回登记一旦存在，无论是不是本机再输
  // 入同一卡密都拒（reason=used）。旧版放行同机重激活并重置用量——Pack 卡用完
  // 额度后同机再输一次就白得新额度，等于无限续杯，这里把口子钉死。
  const store = new Map();
  platform.setKv({
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v); },
    del: async (k) => { store.delete(k); },
  });
  platform.setStorage(platform.newMemoryStorage());
  licenseWeb.setKeyMaterial(TEST_CODE_KEY, null);
  licenseWeb.resetRequestState();
  const mid = await licenseWeb.machineId();
  const otherMid = mid.slice(0, 23) + (mid.endsWith('0') ? '1' : '0');
  const today = Math.floor((Date.now() - codec.DAY_ZERO) / 86400000);

  // 不绑定卡：首次激活成功，并写下赎回登记（键全局、按编号分键）
  const free = codec.issueCode(TEST_CODE_KEY, 'plus', 30, '77777', today);
  const a1 = await licenseWeb.activate(free);
  ok(a1.ok && a1.plan === 'plus', '不绑定卡首次激活成功', JSON.stringify(a1));
  ok(store.has('redeem:77777'), '赎回登记已写入全局 KV（按编号分键）');
  const rec1 = JSON.parse(store.get('redeem:77777'));
  // 机器码 2026-09-25 起由服务端按卡密签发，赎回登记记的是**这张卡的绑定码**，
  // 不再是上面那个未激活时的本机兜底值——激活之后 machineId() 返回的正是它。
  const freeMid = await licenseWeb.machineId();
  ok(rec1 && rec1.k === free && rec1.m === freeMid && rec1.t > 0,
    '登记含卡密原文、赎回机器码与时间戳', rec1 && rec1.m);

  // 同机再激活同一张：严格一次性，拒绝（同机重复验证应走 restore，不来到这里）
  licenseWeb.resetRequestState();
  platform.setStorage(platform.newMemoryStorage());
  const a2 = await licenseWeb.activate(free);
  ok(!a2.ok && a2.reason === 'used',
    '同机再次输入同一张卡密也被拒（严格一次性，reason=used）', JSON.stringify(a2));

  // 旧版登记是纯机器码文本：归一成同一形状后照常拦截，一次性语义对老记录不降级
  store.set('redeem:77777', otherMid);
  licenseWeb.resetRequestState();
  platform.setStorage(platform.newMemoryStorage());
  const a3 = await licenseWeb.activate(free);
  ok(!a3.ok && a3.reason === 'used', '旧格式赎回登记同样拒激活（reason=used）', a3.reason);

  // 另一张卡不受影响：赎回登记按编号分键
  licenseWeb.resetRequestState();
  platform.setStorage(platform.newMemoryStorage());
  store.delete('redeem:88888');
  const bound = codec.issueCode(TEST_CODE_KEY, 'plus', 30, '88888', today);
  const b1 = await licenseWeb.activate(bound);
  ok(b1.ok && b1.plan === 'plus', '另一张不绑定卡激活成功');
  const rec2 = JSON.parse(store.get('redeem:88888'));
  ok(rec2 && rec2.k === bound && rec2.m === (await licenseWeb.machineId()),
    '另一张卡也按卡密+机器码登记赎回（机器码随卡，与上一张不同）', rec2 && rec2.m);
  ok(rec2 && rec2.m !== freeMid, '两张卡的机器码互不相同', rec2 && rec2.m);

  platform.setKv(null);
  platform.setStorage(null);
}

// ---------------------------------------------------------------- 机器码（服务端签发）

// 老做法的毛病：机器码由浏览器设备特征派生，而 Worker 里没有 navigator / WebGL，
// 派生出的是另一个常量——界面上就是"激活前显示 A、激活后服务端回 B"；特征里任何
// 一项漂移（GPU 渲染器取不到、改时区/语言）还会让已激活的卡在 restore 时判成
// machine 不一致，用户什么都没干就被踢回未激活。
//
// 现在机器码由服务端按**卡密编号**签发并永久登记：同一张卡在任何设备、任何时间
// 拿到的都是同一个值。这一段钉住的就是这个"恒"。

section('机器码：服务端签发并与卡密永久绑定');
{
  const store = new Map();
  const kv = {
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v); },
    del: async (k) => { store.delete(k); },
  };
  licenseWeb.setKeyMaterial(TEST_CODE_KEY, null);
  const today = Math.floor((Date.now() - codec.DAY_ZERO) / 86400000);
  const cardA = codec.issueCode(TEST_CODE_KEY, 'plus', 30, '410001', today);
  const cardB = codec.issueCode(TEST_CODE_KEY, 'plus', 30, '410002', today);

  // ① 服务端没绑 KV：退化为"由卡号确定性派生"，跨请求、跨存储仍然恒等
  platform.setKv(null);
  licenseWeb.resetRequestState();
  platform.setStorage(platform.newMemoryStorage());
  const d1 = await licenseWeb.machineForCode(cardA);
  licenseWeb.resetRequestState();
  platform.setStorage(platform.newMemoryStorage());
  const d2 = await licenseWeb.machineForCode(cardA);
  ok(d1.ok && d2.ok && d1.machine === d2.machine && d1.machine.length === 24,
    '无 KV 时同一张卡的机器码仍恒等（按卡号确定性派生）', d1.machine + ' / ' + d2.machine);
  const dB = await licenseWeb.machineForCode(cardB);
  ok(dB.ok && dB.machine !== d1.machine, '不同卡密得到不同机器码', dB.machine);

  // ② 绑了 KV：随机签发一次并登记，之后永远回同一个值
  platform.setKv(kv);
  platform.setStorage(platform.newMemoryStorage());
  licenseWeb.resetRequestState();
  const k1 = await licenseWeb.machineForCode(cardA);
  ok(k1.ok && k1.issued === true && k1.source === 'issued', '首次取机器码由服务端签发', k1.source);
  ok(store.has('machine:410001'), '机器码按卡密编号登记进 KV（全局键 machine:<编号>）');
  licenseWeb.resetRequestState();
  platform.setStorage(platform.newMemoryStorage());
  const k2 = await licenseWeb.machineForCode(cardA);
  ok(k2.ok && k2.machine === k1.machine && k2.issued === false && k2.source === 'binding',
    '第二次取同一张卡的机器码就是那个值（issued=false）', k2.source);

  // ③ 激活用的就是这张卡的绑定码，记录与赎回登记三处一致
  licenseWeb.resetRequestState();
  licenseWeb.setRequestDeviceId('1'.repeat(32));
  const actA = await licenseWeb.activate(cardA);
  const recA = await licenseWeb.exportRecord();
  ok(actA.ok && recA && recA.machine === k1.machine,
    '激活写下的记录用同一个机器码', recA && recA.machine);
  const redeemA = JSON.parse(store.get('redeem:410001') || '{}');
  ok(redeemA.m === k1.machine, '赎回登记里的机器码与之一致（审计对得上）');

  // ④ 绑定键被清掉、赎回登记还在：沿用登记里的机器码，不重新随机
  store.delete('machine:410001');
  licenseWeb.resetRequestState();
  platform.setStorage(platform.newMemoryStorage());
  licenseWeb.setRequestDeviceId('1'.repeat(32));
  const k3 = await licenseWeb.machineForCode(cardA);
  ok(k3.ok && k3.machine === k1.machine && k3.source === 'redeem',
    '绑定键被删后由赎回登记恢复同一个码（不重新随机）', k3.source);

  // ⑤ 激活态：界面显示的机器码 == 卡的绑定码 == 记录里的码
  licenseWeb.resetRequestState();
  licenseWeb.setRequestDeviceId('1'.repeat(32));
  const restA = await licenseWeb.restore();
  ok(restA.ok, '激活后的记录可被 restore 恢复', JSON.stringify(restA));
  const shown = await licenseWeb.machineId();
  ok(shown === k1.machine, 'restore 后 machineId() 即许可证上那个码（刷新不变）', shown);
  ok((licenseWeb.current() || {}).machine === k1.machine, '状态里的机器码同步为绑定码');

  // ⑤ 非法卡密无从绑定——机器码绑在卡上，不是绑在请求上
  const bogus = await licenseWeb.machineForCode('JSLB-0-000-0000');
  ok(!bogus.ok, '非法卡密取不到机器码', JSON.stringify(bogus));

  platform.setKv(null);
  platform.setStorage(null);
  licenseWeb.resetRequestState();
}

// ---------------------------------------------------------------- Worker API

section('Cloudflare Worker 路由');
{
  const worker = (await import('../../worker/index.js')).default;
  // 注入测试公钥：签卡要用私钥，而真私钥不随源码分发（这正是非对称的意义），
  // 所以测试自己造一把卡密密钥，通过 JSLB_CODE_KEY 交给 Worker。走的代码路径
  // 与线上完全一致，只是密钥不同。
  const call = async (pathname, init) => {
    const req = new Request('https://example.com' + pathname, init);
    return worker.fetch(req, {
      JSLB_WEB_CONFIG: '{"trialPreset":"low","trialMaxFileBytes":65536}',
      JSLB_CODE_KEY: TEST_CODE_KEY,
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

  // /api/machine：机器码由服务端签发并与卡密永久绑定。这条链路是"激活前后界面
  // 显示同一个机器码"的保证——老做法里服务端拿自己的环境派生，与浏览器永远不等。
  {
    const mStore = new Map();
    const mEnv = {
      JSLB_WEB_CONFIG: '{"trialPreset":"low","trialMaxFileBytes":65536}',
      JSLB_CODE_KEY: TEST_CODE_KEY,
      JSLB_KV: {
        get: async (k) => (mStore.has(k) ? mStore.get(k) : null),
        put: async (k, v) => { mStore.set(k, v); },
        delete: async (k) => { mStore.delete(k); },
      },
    };
    const callKv = async (pathname, init) => worker.fetch(
      new Request('https://example.com' + pathname, init), mEnv, {},
    );
    const mCode = codec.issueCode(TEST_CODE_KEY, 'plus', 30, '420001');

    const r1 = await callKv('/api/machine', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: mCode }),
    });
    const j1 = await r1.json();
    ok(r1.status === 200 && j1.ok === true && j1.machine.length === 24 && j1.issued === true,
      'POST /api/machine 签发 24 字符机器码', JSON.stringify(j1));
    ok(mStore.has('jslb:machine:420001'), '机器码按卡密编号登记进 KV');

    const r2 = await callKv('/api/machine', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-JSLB-Key': mCode },
      body: '{}',
    });
    const j2 = await r2.json();
    ok(j2.ok === true && j2.machine === j1.machine && j2.issued === false,
      '同一张卡再次请求返回同一个机器码（issued=false）', JSON.stringify(j2));

    const badM = await callKv('/api/machine', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'JSLB-BAD' }),
    });
    ok(badM.status === 400 && (await badM.json()).ok === false, '非法卡密取机器码被拒（400）');
    const noKey = await callKv('/api/machine', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    ok(noKey.status === 400, '缺卡密返回 400');
    ok((await callKv('/api/machine')).status === 405, 'GET /api/machine 返回 405（只收 POST）');

    // 关键回归：激活之后服务端回的机器码必须与 /api/machine 签发的一致
    const actM = await callKv('/api/license', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-JSLB-Device': '9'.repeat(32) },
      body: JSON.stringify({ key: mCode }),
    });
    const aj = await actM.json();
    ok(actM.status === 200 && aj.ok === true && aj.machine === j1.machine,
      '激活后 /api/license 的机器码与 /api/machine 一致（激活前后不再变）',
      aj.machine + ' vs ' + j1.machine);
  }

  // 服务端文案要按**请求**语言回。原先语言只在模块加载时读一次 JSLABYRINTH_LANG，
  // 于是界面切了英文的访问者拿到的 API 报错仍是中文（"Activation failed: 激活失败: …"）。
  {
    const bogus = 'JSLB-F-00-000-' + '0'.repeat(8) + '-' + '0'.repeat(16) + '-' + '0'.repeat(103);
    const badKey = async (headers) => (await (await call('/api/license', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ key: bogus }),
    })).json()).message || '';
    ok(/激活失败/.test(await badKey({})), '未指定语言时服务端报错为默认中文');
    ok(/Activation failed/.test(await badKey({ 'X-JSLB-Lang': 'en' })),
      'X-JSLB-Lang: en 时服务端报错为英文');
    ok(/Activation failed/.test(await badKey({ 'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8' })),
      'Accept-Language: en 时服务端报错为英文（脚本调用场景）');
    ok(/激活失败/.test(await badKey({ 'X-JSLB-Lang': 'fr' })),
      '未知语言取值回落默认语言，不影响请求（不会因 setLang 抛错而 500）');
  }

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
  // 跨域调用方要能带语言头——不在 allow-headers 里会被浏览器预检拦掉
  ok((pre.headers.get('access-control-allow-headers') || '').includes('x-jslb-lang'),
    '预检放行 X-JSLB-Lang 头');

  // 激活流程：用 keygen 的签发路径造一张卡密，走 /api/license 激活
  const keys = [TEST_CODE_KEY, TEST_CODE_KEY];
  const issued = codec.issueCode(keys[0], 'plus', 30, '98765');
  const act = await call('/api/license', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-JSLB-Device': 'b'.repeat(32) },
    body: JSON.stringify({ key: issued }),
  });
  const actJson = await act.json();
  ok(act.status === 200 && actJson.ok === true && actJson.plan === 'plus' && actJson.trial === false,
    'POST /api/license 激活 Plus 卡密', JSON.stringify(actJson && actJson.message));
  ok(actJson.preset === plan.presetCeiling('plus'), '激活后预设上限取自套餐');

  const afterAct = await call('/api/obfuscate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-JSLB-Key': issued, 'X-JSLB-Device': 'b'.repeat(32) },
    body: JSON.stringify({ code: SAMPLE, options: { preset: 'medium', seed: 2 } }),
  });
  const afterJson = await afterAct.json();
  ok(afterAct.status === 200 && afterJson.ok === true, '激活后可跑套餐内预设');
  ok(afterJson.quota && afterJson.quota.used >= 1, '响应里带用量');

  // v5 卡密没有独立的套餐段（套餐在加密的信息段里），篡改用例改为翻转校验码
  // 末位——任何一位被改都必须在校验码这一步被拒。
  const tamperFlip = (t) => t.slice(0, -1) + (t.endsWith('0') ? '1' : '0');
  const tampered = await call('/api/obfuscate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-JSLB-Key': tamperFlip(issued) },
    body: JSON.stringify({ code: SAMPLE, options: { preset: 'low' } }),
  });
  ok(tampered.status === 401, '篡改校验码的卡密被拒（401）');

  // 严格一次性 + KV 赎回登记：激活写入 {卡密, 机器码, 时间戳}；同机重复请求靠
  // restore 复用不被误伤，异机再用同一卡密即 401。
  {
    const kvStore = new Map();
    const kv = {
      get: async (k) => (kvStore.has(k) ? kvStore.get(k) : null),
      put: async (k, v) => { kvStore.set(k, v); },
      del: async (k) => { kvStore.delete(k); },
    };
    const callKv = async (pathname, init) => {
      const req = new Request('https://example.com' + pathname, init);
      return worker.fetch(req, {
        JSLB_WEB_CONFIG: '{"trialPreset":"low","trialMaxFileBytes":65536}',
        JSLB_CODE_KEY: TEST_CODE_KEY,
        JSLB_KV: kv,
      }, {});
    };
    const code = codec.issueCode(TEST_CODE_KEY, 'plus', 30, '24680');
    const dev1 = 'e'.repeat(32);
    const dev2 = 'f'.repeat(32);
    const act1 = await callKv('/api/license', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-JSLB-Device': dev1 },
      body: JSON.stringify({ key: code }),
    });
    ok(act1.status === 200 && (await act1.json()).ok === true, '绑 KV 后激活成功');
    const redeemRec = JSON.parse(kvStore.get('jslb:redeem:24680') || 'null');
    ok(redeemRec && redeemRec.k === code && typeof redeemRec.m === 'string' && redeemRec.m.length === 24 && redeemRec.t > 0,
      'KV 赎回登记含卡密原文、24 位机器码与时间戳');

    const again = await callKv('/api/obfuscate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-JSLB-Key': code, 'X-JSLB-Device': dev1 },
      body: JSON.stringify({ code: SAMPLE, options: { preset: 'low' } }),
    });
    ok(again.status === 200, '同机重复带卡密请求走 restore 复用（200，不被 used 误伤）');

    const other = await callKv('/api/license', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-JSLB-Device': dev2 },
      body: JSON.stringify({ key: code }),
    });
    ok(other.status === 401, '同一张卡密异机激活被拒（401）');
  }
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

// ---------------------------------------------------------------- 密钥耦合（完整性 → 解密密钥）

section('密钥耦合：校验输出直接当解密密钥');
{
  // 改造前是"报警式"防护：校验失败置毒标志，解码器读到才损坏输出——攻击者定位到
  // 那个 `if(毒标志)` 分支 NOP 掉即可恢复。现在把校验算出的「重算哈希 ^ 期望哈希」
  // 偏移累加进一个健康载体，字符串池每次访问都拿它当解密密钥偏移：没有可 NOP 的
  // 分支，改动任一被校验函数或横幅都让整池字符串静默变乱码。
  //
  // 这一节钉四件事：干净产物逐位正确（偏移为 0 时耦合式子必须严格退化成恒等）、
  // 耦合的三个角色都在产物里、**把毒标志全部中和之后**篡改仍被检出（证明隐式那
  // 一路真的独立生效，而不是靠标志位）、以及 low 档（关了完整性校验）不启用耦合。
  // 输出走 process.stdout.write 而不是 console.log：max 档开了 consoleStub，会把
  // console 系列换成桩函数（那是它的既有语义，不是缺陷），拿 console 比对只会得到
  // 空输出，把干净产物误判成坏了
  const src = 'const s="hello world";function fib(n){if(n<2)return n;return fib(n-1)+fib(n-2);}\n'
    + 'process.stdout.write(fib(8)+" "+s.length+" "+s+" "+("beta-gamma".split("-").join("").length)+"\\n");';
  const want = runNode(src, 'kc-plain.js').trim();

  let bad = '';
  for (const preset of ['medium', 'high', 'max']) {
    for (const seed of [1, 2]) {
      const c = obfuscate(src, { preset, seed }).code;
      const got = runNode(c, 'kc-' + preset + '-' + seed + '.js').trim();
      if (got !== want) { bad = preset + '/' + seed + ' -> ' + got.slice(0, 40); break; }
    }
    if (bad) break;
  }
  ok(bad === '', '启用耦合后干净产物仍逐位正确（偏移为 0 时退化成恒等）', bad);

  {
    // 用行为断言而不是文本匹配：产物里的常量会被 numberObf 展开成恒等式，按源码
    // 形态去正则匹配很脆（实测 readOff 就因此漏判）。这里直接验证语义——把健康载体
    // 钉成"健康值 + 1"，池侧算出的偏移就不再是 0，整池字符串必须解成乱码。
    const c = obfuscate(src, { preset: 'medium', seed: 3, shell: false }).code;
    const nameM = /\["(__c[0-9a-f]{9,})"\]/.exec(c);
    const okM = /\]\s*=\s*\(\(0x([0-9a-f]+)\+\(/.exec(c); // 横幅自检写入绝对健康值
    ok(!!(nameM && okM), '产物中找得到健康载体名与健康常量',
      'name=' + (nameM && nameM[1]) + ' ok=' + (okM && okM[1]));
    if (nameM && okM) {
      const off = (parseInt(okM[1], 16) + 1) >>> 0;
      const at = c.indexOf('*/', c.indexOf('/*!'));
      const pin = ';(function(){var G=(typeof globalThis!=="undefined"?globalThis:this);'
        + 'try{Object.defineProperty(G,"' + nameM[1] + '",{configurable:false,'
        + 'get:function(){return 0x' + off.toString(16) + ';},set:function(){}});}catch(e){}})();';
      const pinned = at >= 0 ? c.slice(0, at + 2) + pin + c.slice(at + 2) : null;
      let got = want;
      try { got = pinned ? runNode(pinned, 'kc-offset.js').trim() : want; } catch (e) { got = 'ERR'; }
      ok(got !== want, '把健康载体改成非健康值即整池乱码（读取端确实在用它当密钥偏移）',
        '仍然输出 ' + String(got).slice(0, 40));
    }
    const low = obfuscate(src, { preset: 'low', seed: 3, shell: false }).code;
    ok(!/\["__c[0-9a-f]{9,}"\]/.test(low), 'low 档（无完整性校验）不启用耦合');
  }

  {
    // 「报警式」那一层的隔离**不能在源码里做**：毒标志的写入点本身就落在被哈希
    // 校验的函数体内，实测改一个十六进制数值都会立刻被哈希面命中（篡改检测正常
    // 工作，正是"改一个字节就被发现"）。所以改成**在运行环境里把毒标志钉死**：
    // 产物启动时会把每个毒标志升级成不可配置的访问器，这里预先用自己的"永远返回
    // 0"的不可配置访问器占位，产物的 defineProperty 会失败（它在 try/catch 内），
    // 毒化从此写不进去。一个字节都不动产物，哈希面自然不会命中。
    const art = obfuscate(src, { preset: 'high', seed: 4, mangle: false, shell: false }).code;
    const keys = [...new Set((art.match(/__x[0-9a-f]+/g) || []))];
    ok(keys.length > 0, '产物里找得到毒标志键（共 ' + keys.length + ' 个）');
    const pin = ';(function(){var G=(typeof globalThis!=="undefined"?globalThis:this);'
      + keys.map((k) => 'try{Object.defineProperty(G,"' + k + '",{configurable:false,get:function(){return 0;},set:function(){}});}catch(e){}').join('')
      + '})();';
    // 插在横幅注释之后、自检引导之前：不破坏"文件头是这段横幅"的尽力腿
    const afterBanner = art.indexOf('*/', art.indexOf('/*!'));
    const pinned = afterBanner >= 0
      ? art.slice(0, afterBanner + 2) + pin + art.slice(afterBanner + 2)
      : null;
    ok(!!pinned, '能在横幅之后插入毒标志钉死代码');
    let cleanPinned = 'ERR';
    try { cleanPinned = pinned ? runNode(pinned, 'kc-pinned-clean.js').trim() : 'ERR'; } catch (e) { cleanPinned = 'ERR'; }
    ok(cleanPinned === want, '钉死毒标志后干净产物仍正确', cleanPinned.slice(0, 40));

    const head = pinned ? pinned.match(/function\s+fib\s*\(/) : null;
    ok(!!head, '关掉重命名后能定位到根级函数声明（耦合用例）');
    if (pinned && head) {
      const i = pinned.indexOf(head[0]);
      const j = pinned.indexOf('{', i);
      const patched = j >= 0 ? pinned.slice(0, j + 1) + '0;' + pinned.slice(j + 1) : null;
      let got = want;
      try { got = patched ? runNode(patched, 'kc-pinned-tamper.js').trim() : want; } catch (e) { got = 'ERR'; }
      ok(got !== want, '毒标志被钉死后，改函数体仍被检出（密钥耦合独立生效，不依赖标志位）',
        '篡改后仍然输出 ' + String(got).slice(0, 40));
    }
  }
}

// ---------------------------------------------------------------- 多时钟源与数论谓词

section('多时钟源交叉校验与数论不透明谓词');
{
  // 冻结 Date.now：同源双读（Date.now 与 new Date().getTime()）立刻互相矛盾，且
  // performance 与 Date 的增量也对不上。这正是"只 hook 一个时钟"的最小复现——
  // 原来的性能检查只看"有没有明显停顿"，对这种假时钟无能为力。
  //
  // 单次构建里这项检查按 70% 概率入选，所以按"多数种子检出"判定，避免偶发假红。
  const src = 'console.log([1,2,3].map(function(x){return x*3;}).join("|"));';
  const want = runNode(src, 'ck-plain.js').trim();
  const seeds = [1, 2, 3, 4];
  let cleanBad = '';
  let hits = 0;
  for (const seed of seeds) {
    const code = obfuscate(src, { preset: 'medium', seed }).code;
    const clean = runNode(code, 'ck-clean-' + seed + '.js').trim();
    if (clean !== want) { cleanBad = 'seed ' + seed + ' 干净产物已异常: ' + clean.slice(0, 30); break; }
    let got = want;
    try { got = runNode('Date.now=function(){return 0;};' + code, 'ck-hooked-' + seed + '.js').trim(); }
    catch (e) { got = 'ERR'; }
    if (got !== want) hits++;
  }
  ok(cleanBad === '', '多时钟源检查不误伤干净产物', cleanBad);
  ok(!cleanBad && hits >= 2, '冻结 Date.now 被检出（' + hits + '/' + seeds.length + ' 个种子）',
    cleanBad || '命中数过低，检查可能没进产物');

  // 恒假形态升级：旧的 x === x + 1 能被代数化简整式折叠成 false，死块随之被删。
  // 现在改用数论/位运算不透明谓词——h³-h 恒被 3 整除、x|~x 恒为 -1、x^(x-1) 恒为
  // 奇数——都要先求出运行期取值、且判定需要模运算或进位传播的性质。
  //
  // 必须在 shell:false 下找：外壳档会把载荷编码，源码形态根本不出现在产物文本里
  // （这也是为什么"在源码里改毒标志"那类断言要格外小心）。
  let weakFound = '';
  let strong = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const c = obfuscate('var t=0;for(var i=0;i<5;i++){t+=i;}function g(x){return x*2;}process.stdout.write(""+t+g(3));',
      { preset: 'medium', seed, shell: false }).code;
    const m = /([A-Za-z0-9_$\u0080-\uffff]+)===\1\+1/.exec(c);
    if (m) weakFound = 'seed ' + seed + ' 仍出现 ' + m[0];
    if (/%3!==0/.test(c) || /\|~/.test(c) || /&1\)===0/.test(c)) strong++;
  }
  ok(weakFound === '', '恒假形态不再使用可被代数化简的 x === x + 1', weakFound);
  ok(strong > 0, '产物中出现数论/位运算不透明谓词（' + strong + '/6 个种子）');
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
      + ' process.stdout.write([f(0), f(9), f("z")].join(" ") + "\\n");',
    // 局部变量 a 参与两条 if
    'function g(){ var a=7; if(a>5) return "big"; if(a<10) return "small"; return "no"; }'
      + ' process.stdout.write(g() + "\\n");',
    // a 作为循环变量（跳转回边）
    'function h(n){ var s=0, a=0; for(a=0; a<n; a++) s+=a; return s; } process.stdout.write(h(5) + "\\n");',
    // 一批曾经会让解释器撞名的标识符
    'function k(a,b,c,v,n,f,o){ if(a>b) return "ab"; if(c<v) return "cv"; if(n!==f) return "nf";'
      + ' return o; } process.stdout.write(k(2,1,3,4,5,6,"tail") + "\\n");',
    // a 上是对象，走 GETM / SETM / CALLM
    'function m(a){ if(a.length>2) return a.toUpperCase(); if(a.length===1) return "one";'
      + ' return "other"; } process.stdout.write([m("abcd"), m("x"), m("yz")].join(" ") + "\\n");',
  ];
  const runNode = (code, name) => {
    const file = path.join(TMP, name + '.js');
    fs.writeFileSync(file, code);
    // max 预设的 VM+WASM 产物在较慢宿主上单次执行实测 25~31s，30s 超时是边界值，
    // 会以 ETIMEDOUT 形式偶发误报（每次漂移到不同 case/seed，放宽后结果全对）。
    // 这里放到 90s 只影响夹具判定，不改变被判定产物的语义。
    return runSync(process.execPath, [file], { encoding: 'utf8', timeout: 90000 }).trim();
  };
  let mismatch = 0;
  let firstBad = '';
  for (let ci = 0; ci < cases.length; ci++) {
    const want = runSync(process.execPath, ['-e', cases[ci]], { encoding: 'utf8' }).trim();
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

// ---------------------------------------------------------------- P3：分发表密文化

section('P3：分发表密文化（vmDispatchEnc）');
{
  // 样例刻意只用一个 VM 函数并调用两次：P3-3 的「解码清零每次调用执行一遍」
  // 计数断言需要已知的调用次数。integrityCheck 关掉是为了让篡改变体直接测
  // 分发表本身，而不是被完整性校验先一步拦下（后者已由「篡改检出」段覆盖）。
  const src1 = 'function work(n){var a=0;for(var i=0;i<n;i++){if(i%2===0){a+=i*3;}else{a-=1;}}return a+"|"+(n>3?"big":"small");}\n'
    + 'process.stdout.write(work(9)+" "+work(2)+"\\n");';
  const want = runNode(src1, 'p3-want.js').trim();
  const vmStatOf = (r) => {
    const s = r.stats.find((x) => x.pass === 'vm');
    return s && s.result ? s.result : null;
  };
  // 产物里的标识符可能是 \uXXXX 转义序列（名字池含非 ASCII），统一按转义层文本匹配
  const NAME = '(?:\\\\u[0-9a-fA-F]{4}|[\\w$])(?:\\\\u[0-9a-fA-F]{4}|[\\w$])*';
  const escName = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** 15 秒兜底运行：篡改变体可能让解释器失去分发目标而空转，超时视作检出。 */
  const runSafe = (code, name) => {
    const file = path.join(TMP, name + '.js');
    fs.writeFileSync(file, code);
    try {
      return runSync(process.execPath, [file], { encoding: 'utf8', timeout: 15000 }).trim();
    } catch (e) { return 'ERR'; }
  };

  // 形态统计：关 → D 不出现；开 → D 成为主要形态，且存在「全 D」构建。
  // 统计循环必须跑满 8 个 seed：allD 只记录不退出，否则 dCount 只累计到
  // 首个全 D 构建为止，断言会系统性偏低
  let offBad = 0;
  let dCount = 0;
  let allD = null;
  for (let seed = 1; seed <= 8; seed++) {
    const off = vmStatOf(obfuscate(src1, { preset: 'high', shell: false, vmDispatchEnc: false, integrityCheck: false, seed }));
    if (!off || off.forms.D !== 0) offBad++;
    const rOn = obfuscate(src1, { preset: 'high', shell: false, vmDispatchEnc: true, integrityCheck: false, seed });
    const on = vmStatOf(rOn);
    if (!on) continue;
    dCount += on.forms.D;
    if (!allD && on.compiled > 0 && on.forms.D === on.compiled) allD = { seed, code: rOn.code };
  }
  ok(offBad === 0, '关闭 vmDispatchEnc 时形态 D 不出现（8 seed）');
  ok(dCount >= 6, '开启 vmDispatchEnc 时形态 D 成为主要形态（D 计数 ≥ 6/8）', 'D=' + dCount);
  ok(!!allD, '存在全 D 构建（分发映射全部进密文表）', allD ? '' : '8 个 seed 都没出现全 D');

  // 全 D 构建的行为化验收：定位密文表 → 篡改必被检出 → 解码清零按调用次数执行
  if (allD) {
    const code = allD.code;
    // 形态 D 签名：解码收尾的两条相邻清零语句 C.length=0; BI.length=0;
    // 第一条名字必须能反查到一张纯数值大数组（≥9 元素，即 3 字 × ≥3 条目），
    // 排除恰好两连清零的其它结构
    const findArr = (text, name) => {
      const re = new RegExp('(var|,)\\s*' + escName(name) + '\\s*=\\s*\\[');
      const m = text.match(re);
      if (!m) return null;
      const start = m.index + m[0].length - 1;
      const end = text.indexOf(']', start); // 扁平整型数组无嵌套，首个 ] 即结尾
      if (end < 0) return null;
      return { start, end, text: text.slice(start + 1, end) };
    };
    const pairRe = new RegExp('(' + NAME + ')\\.length\\s*=\\s*0\\s*;\\s*(' + NAME + ')\\.length\\s*=\\s*0\\s*;', 'g');
    let pair = null;
    for (const m of code.matchAll(pairRe)) {
      const arr = findArr(code, m[1]);
      if (arr) {
        const elems = arr.text.split(',').map((s) => s.trim());
        if (elems.length >= 9 && elems.every((s) => Number.isFinite(Number(s)))) { pair = m; break; }
      }
    }
    ok(!!pair, '全 D 产物可定位「条目密文表 + 桶区间表」双清零签名');
    if (pair) {
      const cName = pair[1];
      // P3-2：翻转密文表中全部动作下标字（每条第目的第 3 个字），语义必然漂移
      const cArr = findArr(code, cName);
      const elems = cArr.text.split(',').map((s) => s.trim());
      const flipped = elems.map((s, i) => (i % 3 === 2 ? String(Number(s) ^ 1) : s)).join(',');
      const tampered = code.slice(0, cArr.start + 1) + flipped + code.slice(cArr.end);
      const got = runSafe(tampered, 'p3-tampered');
      ok(got !== want, '翻转密文表动作下标字即被检出（输出改变/抛错/超时）',
        got === want ? '篡改后输出不变' : got.slice(0, 40));
      // P3-3：在清零语句后注入计数探针，两次调用应恰好清零两次。
      // 注入文本必须以分号结尾：产物里清零语句之后可能紧跟 var 声明，
      // 少了分号会拼出 `+1var` 这种语法错误（真实的失败教训）
      const probed = code.replace(pairRe, (m) =>
        m + ';globalThis.__JSLB_P3HIT=(globalThis.__JSLB_P3HIT||0)+1;');
      const out2 = runSafe(probed + '\nif(globalThis.__JSLB_P3HIT!==undefined)process.stdout.write("|HIT"+globalThis.__JSLB_P3HIT);\n', 'p3-probe');
      // 样例自己的输出以 \n 结尾，探针计数另起一行；trim 只去首尾，中间的 \n 保留
      ok(out2 === want + '\n|HIT2', '解码与清零在每次调用时执行（2 次调用 → 计数 2）', JSON.stringify(out2).slice(0, 60));
    }
  }

  // P3-4 语义等价：medium（默认关）强制开与关，输出一致
  let semBad = 0;
  let semFirst = '';
  for (let seed = 1; seed <= 3; seed++) {
    for (const enc of [false, true]) {
      const code = obfuscate(src1, { preset: 'medium', shell: false, vmDispatchEnc: enc, seed }).code;
      let got;
      try { got = runNode(code, 'p3-sem-' + enc + '-' + seed).trim(); }
      catch (e) { got = 'THREW'; }
      if (got !== want) { semBad++; if (!semFirst) semFirst = 'enc=' + enc + ' seed=' + seed + ' → ' + got.slice(0, 40); }
    }
  }
  ok(semBad === 0, 'vmDispatchEnc 开与关的输出一致（medium × 3 seed）', semFirst);

  // P3-5 可复现：固定 seed 逐字节一致（enc 开）
  const ra = obfuscate(src1, { preset: 'high', shell: false, vmDispatchEnc: true, seed: 424242 }).code;
  const rb = obfuscate(src1, { preset: 'high', shell: false, vmDispatchEnc: true, seed: 424242 }).code;
  ok(ra === rb, 'vmDispatchEnc 开启下固定 seed 可复现');

  // P3-8 不影响 WASM 解释器内核档：max 预设（wasmInterpreter）语义不变
  let maxBad = 0;
  for (let seed = 1; seed <= 2; seed++) {
    const got = runNode(obfuscate(src1, { preset: 'max', seed }).code, 'p3-max-' + seed).trim();
    if (got !== want) maxBad++;
  }
  ok(maxBad === 0, 'max 预设（WASM 解释器内核）语义不变（2 seed）');
}

// ---------------------------------------------------------------- P4：多态模型与分块自解密

section('P4：多态寄存器模型与字节码分块自解密');
{
  // 跳转密集样例：if/else 链、&&、??、循环回边——分块解密的块边界与跳转复位
  // 都在这里被踩到
  const jumpSrc = 'function work(a,b){var r=0;'
    + 'for(var i=0;i<a;i++){if(i%3===0){r+=i;}else if(i%3===1){r-=b&&1;}else{r^=i+3;}}'
    + 'var s=b??7;'
    + 'if(a>3&&b>0){r+=s;}else{r-=1;}'
    + 'while(r>100){r-=100;}'
    + 'if(r<0||s===0){r=r*-1+2;}'
    + 'return r;}'
    + 'process.stdout.write([work(17,3),work(4,0),work(25,9)].join(" ")+"\\n");';
  const want = runNode(jumpSrc, 'p4-want.js').trim();
  const vmStatOf = (r) => {
    const s = r.stats.find((x) => x.pass === 'vm');
    return s && s.result ? s.result : null;
  };

  // P4-1 多态模型真的出现多种：4 函数样例 × 6 seed（wasmInterpreter 必须关，
  // 否则 __vmWasmShared 强制 M0）
  const polySrc = 'function f1(n){var s=0;for(var i=0;i<n;i++)s+=i;return s;}'
    + 'function f2(a,b){return a>b?a-b:a+b;}'
    + 'function f3(o){return o.k?o.k.length:0;}'
    + 'function f4(s){return s.split(",").length;}'
    + 'process.stdout.write([f1(10),f2(3,9),f3({k:"abc"}),f4("a,b,c,d")].join(" ")+"\\n");';
  const polyWant = runNode(polySrc, 'p4-poly-want.js').trim();
  let mixedBuilds = 0;
  const seenModels = new Set();
  let polySemBad = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const r = obfuscate(polySrc, { preset: 'high', shell: false, vmPolymorph: true, integrityCheck: false, seed });
    const st = vmStatOf(r);
    if (st && st.compiled >= 3) {
      const present = Object.keys(st.models).filter((k) => st.models[k] > 0);
      for (const k of present) seenModels.add(k);
      if (present.length >= 2) mixedBuilds++;
    }
    let got;
    try { got = runNode(r.code, 'p4-poly-' + seed).trim(); } catch (e) { got = 'THREW'; }
    if (got !== polyWant) polySemBad++;
  }
  ok(polySemBad === 0, 'vmPolymorph 开启下 4 函数样例语义全部正确（6 seed）');
  ok(mixedBuilds >= 2, '多态构建中多数产物混含 ≥2 种寄存器模型（6 seed 中 ≥2）',
    'mixed=' + mixedBuilds);
  ok(seenModels.size >= 2, '跨构建覆盖 ≥2 种模型（观察值：' + [...seenModels].join('/') + '）');

  // P4-2 三种模型强制指定时语义等价
  let modelBad = 0;
  let modelFirst = '';
  for (const model of ['M0', 'M1', 'M2']) {
    for (let seed = 1; seed <= 2; seed++) {
      const code = obfuscate(jumpSrc, { preset: 'high', shell: false, vmModel: model, integrityCheck: false, seed }).code;
      let got;
      try { got = runNode(code, 'p4-model-' + model + '-' + seed).trim(); } catch (e) { got = 'THREW'; }
      if (got !== want) { modelBad++; if (!modelFirst) modelFirst = model + ' seed=' + seed + ' → ' + got.slice(0, 40); }
    }
  }
  ok(modelBad === 0, '强制 M0/M1/M2 的输出一致（跳转密集样例 × 2 seed）', modelFirst);

  // P4-3 多态开关开与关输出一致
  let polyBad = 0;
  for (let seed = 1; seed <= 2; seed++) {
    for (const poly of [false, true]) {
      const code = obfuscate(jumpSrc, { preset: 'high', shell: false, vmPolymorph: poly, seed }).code;
      let got;
      try { got = runNode(code, 'p4-sw-' + poly + '-' + seed).trim(); } catch (e) { got = 'THREW'; }
      if (got !== want) polyBad++;
    }
  }
  ok(polyBad === 0, 'vmPolymorph 开与关的输出一致（2 seed）');

  // P4-5/P4-6 分块自解密：开与关、JS 档与旧 WASM 档，跳转密集样例全部正确
  let blkBad = 0;
  let blkFirst = '';
  for (const blk of [false, true]) {
    for (const tier of [['js', { wasm: false }], ['wasmtier', {}]]) {
      for (let seed = 1; seed <= 2; seed++) {
        const code = obfuscate(jumpSrc, {
          preset: 'high', shell: false, vmBlockDecrypt: blk, integrityCheck: false,
          ...tier[1], seed,
        }).code;
        let got;
        try { got = runNode(code, 'p4-blk-' + blk + '-' + tier[0] + '-' + seed).trim(); } catch (e) { got = 'THREW'; }
        if (got !== want) { blkBad++; if (!blkFirst) blkFirst = 'blk=' + blk + ' ' + tier[0] + ' seed=' + seed + ' → ' + got.slice(0, 40); }
      }
    }
  }
  ok(blkBad === 0, 'vmBlockDecrypt 开与关 × JS/WASM 档输出一致（2 seed）', blkFirst);

  // P4-8 篡改块移位字面量即被检出：块号派生是取指式的一部分，改一位解密即错
  {
    const r = obfuscate(jumpSrc, { preset: 'high', shell: false, vmBlockDecrypt: true, integrityCheck: false, wasm: false, seed: 3 });
    let hit = 0;
    const patched = r.code.replace(/>>>\s*([456])(?![\d.])/g, (m, d) => {
      hit++;
      return '>>>' + (d === '6' ? '4' : Number(d) + 1);
    });
    if (hit === 0) {
      ok(false, '块移位字面量出现在取指式中', '产物里未找到 >>>4/5/6（结构变化，需更新探针）');
    } else {
      const file = path.join(TMP, 'p4-blk-tampered.js');
      fs.writeFileSync(file, patched);
      let got;
      try { got = runSync(process.execPath, [file], { encoding: 'utf8', timeout: 15000 }).trim(); }
      catch (e) { got = 'ERR'; }
      ok(got !== want, '篡改块移位字面量即被检出（' + hit + ' 处）',
        got === want ? '篡改后输出不变' : got.slice(0, 40));
    }
  }

  // P4-10 可复现：P3+P4 全开下固定 seed 逐字节一致
  {
    const opt = { preset: 'high', shell: false, vmPolymorph: true, vmBlockDecrypt: true, seed: 424242 };
    ok(obfuscate(jumpSrc, opt).code === obfuscate(jumpSrc, opt).code,
      'P3+P4 全开下固定 seed 可复现');
  }
}

// ---------------------------------------------------------------- Anti-CDP

section('Anti-CDP（CDP 自动化检测）');
{
  // 探针样例：字符串全部经字符串池（high 预设 threshold=1），投毒后输出腐蚀
  const cdpSample = `function greet(n) {
  return 'OK-' + n + '-END';
}
const a = greet('aa');
const b = greet('bb');
process.stdout.write(a + '|' + b + '\\n');
`;
  const cdpWant = 'OK-aa-END|OK-bb-END\n';
  const cdpHelper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cdp-sandbox.js');
  const cdpRun = (code, mode, tag) => {
    const file = path.join(TMP, 'cdp-' + mode + '-' + tag + '.js');
    fs.writeFileSync(file, code);
    return runSync(process.execPath, [cdpHelper, file, mode], { encoding: 'utf8', timeout: 60000 });
  };

  // 形态：开启时 pass 注入且三向量齐全，关闭时不出现
  const rCdpOn = obfuscate(cdpSample, { preset: 'high', shell: false, antiCDP: true, seed: 11 });
  const rCdpOff = obfuscate(cdpSample, { preset: 'high', shell: false, antiCDP: false, seed: 11 });
  const stCdp = rCdpOn.stats.find((s) => s.pass === 'antiCDP');
  ok(stCdp && stCdp.result && stCdp.result.injected === true && stCdp.result.vectors >= 3,
    'antiCDP 开启时 pass 注入且三向量齐全', JSON.stringify(stCdp && stCdp.result));
  ok(!rCdpOff.stats.some((s) => s.pass === 'antiCDP'), 'antiCDP 关闭时 pass 不出现');

  // Node 直跑零副作用：window 不存在，探针全部跳过，开/关输出一致
  let cdpNodeBad = '';
  for (const [flag, r] of [['on', rCdpOn], ['off', rCdpOff]]) {
    let got;
    try { got = runNode(r.code, 'cdp-node-' + flag); } catch (e) { got = 'THREW'; }
    if (got !== cdpWant) cdpNodeBad = flag + ' → ' + got.slice(0, 40);
  }
  ok(cdpNodeBad === '', 'Node 环境直跑零副作用（开/关输出一致）', cdpNodeBad);

  // 干净浏览器沙箱零误报：window/document/navigator 齐备但无自动化痕迹
  let cdpCleanBad = '';
  for (let seed = 1; seed <= 2; seed++) {
    const code = obfuscate(cdpSample, { preset: 'high', shell: false, antiCDP: true, seed }).code;
    const got = cdpRun(code, 'clean', String(seed));
    if (got !== cdpWant) cdpCleanBad = 'seed=' + seed + ' → ' + got.slice(0, 40);
  }
  ok(cdpCleanBad === '', '干净浏览器沙箱零误报（输出逐位一致）', cdpCleanBad);

  // navigator.webdriver=true（Puppeteer/Playwright 默认签名）→ 投毒
  let cdpWdPoisoned = 0;
  let cdpWdFirst = '';
  for (let seed = 1; seed <= 2; seed++) {
    const code = obfuscate(cdpSample, { preset: 'high', shell: false, antiCDP: true, seed }).code;
    const got = cdpRun(code, 'webdriver', String(seed));
    if (got !== cdpWant) cdpWdPoisoned++;
    else if (!cdpWdFirst) cdpWdFirst = 'seed=' + seed;
  }
  ok(cdpWdPoisoned === 2, 'navigator.webdriver=true 即投毒（字符串池被腐蚀）', cdpWdFirst);

  // Runtime.enable 序列化模拟（log 1 次 + debug 2 次）→ 投毒
  let cdpSerPoisoned = 0;
  let cdpSerFirst = '';
  for (let seed = 1; seed <= 2; seed++) {
    const code = obfuscate(cdpSample, { preset: 'high', shell: false, antiCDP: true, seed }).code;
    const got = cdpRun(code, 'cdp', String(seed));
    if (got !== cdpWant) cdpSerPoisoned++;
    else if (!cdpSerFirst) cdpSerFirst = 'seed=' + seed;
  }
  ok(cdpSerPoisoned === 2, 'console 序列化（Runtime.enable 特征）即投毒', cdpSerFirst);

  // 弱证据（仅 log 单次触发）不投毒：只走隐蔽断点，输出不变
  let cdpWeakBad = '';
  for (let seed = 1; seed <= 2; seed++) {
    const code = obfuscate(cdpSample, { preset: 'high', shell: false, antiCDP: true, seed }).code;
    const got = cdpRun(code, 'weak', String(seed));
    if (got !== cdpWant) cdpWeakBad = 'seed=' + seed + ' → ' + got.slice(0, 40);
  }
  ok(cdpWeakBad === '', '弱证据（单次触发）不投毒不误伤', cdpWeakBad);

  // 开关有效性：关闭后 webdriver 环境也不投毒
  ok(cdpRun(rCdpOff.code, 'webdriver', 'off') === cdpWant,
    'antiCDP 关闭时 webdriver 环境输出不变');

  // 门控：free 锁死、plus 放行；默认开启（assertConsistent 在模块加载时
  // 已校验闸门与预设取值一致，这里断言对外行为）
  ok(plan.violations({ antiCDP: true }, 'free').length === 1, 'free 档 antiCDP 被闸门锁死');
  ok(plan.violations({ antiCDP: false }, 'free').length === 0, 'free 档关闭放行');
  ok(plan.violations({ antiCDP: true }, 'plus').length === 0, 'plus 档 antiCDP 放行');
  ok(obfuscateMod.DEFAULTS.antiCDP === true, 'antiCDP 默认开启');

  // 可复现：固定 seed 逐字节一致
  ok(obfuscate(cdpSample, { preset: 'high', shell: false, antiCDP: true, seed: 4242 }).code ===
    obfuscate(cdpSample, { preset: 'high', shell: false, antiCDP: true, seed: 4242 }).code,
    'antiCDP 固定 seed 可复现');
}

// ---------------------------------------------------------------- 域名锁定

section('域名锁定（domainLock，密钥耦合）');
{
  // 探针样例：字符串全部经字符串池（high 预设 threshold=1），失配即整池腐蚀。
  // 沙箱在 node:vm 里注入 location（hostname/host），'-' 表示无 location。
  const dlSample = `function greet(n) {
  return 'OK-' + n + '-END';
}
const a = greet('aa');
const b = greet('bb');
process.stdout.write(a + '|' + b + '\\n');
`;
  const dlWant = 'OK-aa-END|OK-bb-END\n';
  const dlHelper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'domain-sandbox.js');
  const dlRun = (code, hostname, tag, hostWithPort) => {
    const file = path.join(TMP, 'dl-' + tag + '.js');
    fs.writeFileSync(file, code);
    const args = [dlHelper, file, hostname];
    if (hostWithPort) args.push(hostWithPort);
    return runSync(process.execPath, args, { encoding: 'utf8', timeout: 60000 });
  };
  // 篡改面锚点策略：注入的校验函数会被 mangle 改名且被后续包装层搬动（用函数
  // 名或 function 头回溯定位都不可靠），改用模板在产物里的两个唯一明文锚点——
  // 探针属性 location.hostname 与 +Q 异或表达式（均已验证开/关构建恰好 1/0 次）

  // 形态：开启时注入且为 coupled 模式；关闭时 pass 不出现、location 探针不出现
  const rDlOn = obfuscate(dlSample, { preset: 'high', shell: false, domainLock: 'example.com', seed: 11 });
  const rDlOff = obfuscate(dlSample, { preset: 'high', shell: false, seed: 11 });
  const stDl = rDlOn.stats.find((s) => s.pass === 'domainLock');
  ok(stDl && stDl.result && stDl.result.injected === true && stDl.result.mode === 'coupled'
    && stDl.result.entries === 1 && stDl.result.exact === 1,
    'domainLock 开启时注入且为 coupled 模式', JSON.stringify(stDl && stDl.result));
  ok(!rDlOff.stats.some((s) => s.pass === 'domainLock'), 'domainLock 关闭时 pass 不出现');
  ok(!rDlOff.code.includes('hostname') && rDlOn.code.includes('hostname'),
    'location 探针只在开启时出现（域名白名单零明文）');

  // 多条目解析计数：1 精确 + 1 后缀
  const stDl2 = obfuscate(dlSample, { preset: 'high', shell: false, domainLock: 'example.com, .foo.dev', seed: 11 })
    .stats.find((s) => s.pass === 'domainLock');
  ok(stDl2 && stDl2.result.entries === 2 && stDl2.result.exact === 1 && stDl2.result.suffix === 1,
    '多条目（精确+后缀）计数正确', JSON.stringify(stDl2 && stDl2.result));

  // 授权主机放行（2 seed × 4 形态）：精确 / 后缀含顶点 / 后缀深层子域 / 端口精确
  let dlAuthBad = '';
  for (let seed = 1; seed <= 2 && !dlAuthBad; seed++) {
    const o = { preset: 'high', shell: false, seed };
    const cases = [
      [obfuscate(dlSample, { ...o, domainLock: 'example.com' }).code, 'example.com', null],
      [obfuscate(dlSample, { ...o, domainLock: '.example.com' }).code, 'example.com', null],
      [obfuscate(dlSample, { ...o, domainLock: '.example.com' }).code, 'a.b.example.com', null],
      [obfuscate(dlSample, { ...o, domainLock: 'example.com:8443' }).code, 'example.com', 'example.com:8443'],
    ];
    for (let i = 0; i < cases.length; i++) {
      const got = dlRun(cases[i][0], cases[i][1], 'auth-' + seed + '-' + i, cases[i][2] || undefined);
      if (got !== dlWant) { dlAuthBad = '形态 ' + i + ' seed=' + seed + ' → ' + got.slice(0, 40); break; }
    }
  }
  ok(dlAuthBad === '', '授权主机放行（精确/后缀含顶点/深层子域/端口精确）', dlAuthBad);

  // 非授权主机 fail-closed（2 seed × 4 形态）：错域 / 后缀点边界 / 错端口 /
  // 无 location。coupled 模式静默腐蚀整池，不应有可定位的抛错
  let dlDenyBad = '';
  for (let seed = 1; seed <= 2 && !dlDenyBad; seed++) {
    const o = { preset: 'high', shell: false, seed };
    const cases = [
      [obfuscate(dlSample, { ...o, domainLock: 'example.com' }).code, 'evil.com', null],
      [obfuscate(dlSample, { ...o, domainLock: '.example.com' }).code, 'badexample.com', null],
      [obfuscate(dlSample, { ...o, domainLock: 'example.com:8443' }).code, 'example.com', 'example.com:80'],
      [obfuscate(dlSample, { ...o, domainLock: 'example.com' }).code, '-', null],
    ];
    for (let i = 0; i < cases.length; i++) {
      const got = dlRun(cases[i][0], cases[i][1], 'deny-' + seed + '-' + i, cases[i][2] || undefined);
      // 失配后整池乱码：解码器在乱码索引上可能越界抛错（沙箱 |THREW 前缀），
      // 也可能静默输出乱码——都是 fail-closed 的合法表现，只要不等于正确输出
      if (got === dlWant) { dlDenyBad = '形态 ' + i + ' seed=' + seed + ' 未拦截'; break; }
    }
  }
  ok(dlDenyBad === '', '非授权主机整池腐蚀（错域/点边界/错端口/无 location）', dlDenyBad);

  // 真机 Node 直跑（无 location）同样 fail-closed
  {
    const f = path.join(TMP, 'dl-node-real.js');
    fs.writeFileSync(f, rDlOn.code);
    let got;
    try { got = runSync(process.execPath, [f], { encoding: 'utf8', timeout: 30000 }); }
    catch (e) { got = 'THREW'; }
    ok(got.trim() !== dlWant.trim(), 'Node 真机直跑 fail-closed（域名锁定不承诺浏览器外运行）',
      String(got).slice(0, 40));
  }

  // 降级一：关完整性校验（couple 缺席）→ poison 模式（毒药键路径）
  const rDlPois = obfuscate(dlSample, { preset: 'high', shell: false, integrityCheck: false, domainLock: 'example.com', seed: 7 });
  const stPois = rDlPois.stats.find((s) => s.pass === 'domainLock');
  ok(stPois && stPois.result.mode === 'poison', '关完整性校验时降级为 poison 模式', JSON.stringify(stPois && stPois.result));
  ok(dlRun(rDlPois.code, 'example.com', 'pois-auth') === dlWant
    && dlRun(rDlPois.code, 'evil.com', 'pois-deny') !== dlWant,
    'poison 模式：授权放行、失配写毒药键腐蚀输出');

  // 降级二：连池都没有 → throw 模式（裸抛，不被引导 catch 自吞）
  const rDlThrow = obfuscate(dlSample, { preset: 'high', shell: false, integrityCheck: false, stringArray: false, domainLock: 'example.com', seed: 7 });
  const stThrow = rDlThrow.stats.find((s) => s.pass === 'domainLock');
  ok(stThrow && stThrow.result.mode === 'throw', '无字符串池时降级为 throw 模式', JSON.stringify(stThrow && stThrow.result));
  ok(dlRun(rDlThrow.code, 'evil.com', 'throw-deny').includes('|THREW:'),
    'throw 模式失配装载期抛错（引导调用裸奔不被吞）');
  ok(dlRun(rDlThrow.code, 'example.com', 'throw-auth') === dlWant, 'throw 模式授权主机正常');

  // 篡改面一：改校验函数体内的探针属性名（location.hostname 是模板在产物里
  // 的唯一明文）。文本一变即进完整性哈希面失配，同时运行期取不到 hostname
  // 视为失配——双路 fail-closed
  {
    const hit = (rDlOn.code.match(/location\.hostname/g) || []).length;
    let got = 'NOANCHOR';
    if (hit === 1) {
      const tampered = rDlOn.code.replace('location.hostname', 'location.hostnamf');
      try { got = dlRun(tampered, 'example.com', 'tamper-fn'); } catch (e) { got = 'THREW'; }
    }
    ok(hit === 1 && got !== dlWant,
      '篡改校验函数体即被完整性哈希面检出（授权域自腐蚀）',
      'hit=' + hit + ' → ' + String(got).slice(0, 40));
  }

  // 篡改面二：废掉 +Q 贡献（第二个异或半片 +1）——等价于引导调用被 NOP/删除：
  // 授权域偏移不再归零，自己乱码（Q≠0 设计）。产物里该形态恰好一处
  {
    const qRe = /\+\(0x[0-9a-f]+\^0x([0-9a-f]+)\)/;
    const mq = rDlOn.code.match(qRe);
    let got = 'NOQ';
    if (mq) {
      const patched = rDlOn.code.replace(qRe, (m0, h) =>
        m0.slice(0, m0.length - h.length - 1) + (parseInt(h, 16) + 1).toString(16) + ')');
      try { got = dlRun(patched, 'example.com', 'tamper-q'); } catch (e) { got = 'THREW'; }
    }
    ok(!!mq && got !== dlWant,
      '篡改 +Q 贡献即自毁（Q≠0，授权域偏移不再归零）',
      (mq ? mq[0] : '未命中') + ' → ' + String(got).slice(0, 40));
  }

  // 外壳档：整件编码后语义不变（授权放行 / 失配腐蚀）
  const rDlShell = obfuscate(dlSample, { preset: 'high', shell: true, domainLock: 'example.com', seed: 5 });
  ok(dlRun(rDlShell.code, 'example.com', 'shell-auth') === dlWant
    && dlRun(rDlShell.code, 'evil.com', 'shell-deny') !== dlWant,
    '外壳档下语义不变（授权放行/失配腐蚀）');

  // 门控：free 只允许空串（关闭），plus 放行；默认关闭
  ok(plan.violations({ domainLock: 'example.com' }, 'free').length === 1, 'free 档非空 domainLock 被闸门锁死');
  ok(plan.violations({ domainLock: '' }, 'free').length === 0, 'free 档关闭（空串）放行');
  ok(plan.violations({ domainLock: 'example.com' }, 'plus').length === 0, 'plus 档 domainLock 放行');
  ok(obfuscateMod.DEFAULTS.domainLock === '', 'domainLock 默认关闭（空串）');

  // 非法条目：构建立即失败（不得静默降级——横幅已按 OK-Q 写死）
  throws(() => obfuscate(dlSample, { preset: 'high', shell: false, domainLock: 'http://a.com/x' }), '带路径的条目报错');
  throws(() => obfuscate(dlSample, { preset: 'high', shell: false, domainLock: '.a.com:443' }), '后缀+端口报错');
  throws(() => obfuscate(dlSample, { preset: 'high', shell: false, domainLock: 'a..b.com' }), '空标签报错');

  // 可复现：固定 seed 逐字节一致
  ok(obfuscate(dlSample, { preset: 'high', shell: false, domainLock: '.example.com', seed: 97 }).code ===
    obfuscate(dlSample, { preset: 'high', shell: false, domainLock: '.example.com', seed: 97 }).code,
    'domainLock 固定 seed 可复现');
}

// ---------------------------------------------------------------- AST 简化（simplify）

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

// ---------------------------------------------------------------- 属性名重命名与保留名单

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
// --------------------------------------------------- JSFuck 壳形式

section('JSFuck 壳形式（shellForm）');
{
  const jsfuck = await import('../../src/passes/jsfuck.js');
  const shellMod = await import('../../src/passes/shell.js');

  // 编码器：真 eval 往返。eval 只出现在本文件里，本文件不随 Worker 上传。
  {
    const cases = ['A', 'ab', 'function f(){return 1}', 'var x=1;x++;', '^&|<>;=?%*/-+', '  mixed 42 !'];
    let bad = 0;
    for (const c of cases) {
      let got;
      try { got = (0, eval)(jsfuck.decodeStrExpr(c)); } catch (e) { got = 'ERR ' + e.message; }
      if (got !== c) bad++;
    }
    ok(bad === 0, 'JSFuck 编码器：6 个 ASCII 用例真 eval 往返一致', bad + ' 项不符');
    ok((0, eval)(jsfuck.jsfuckProgram('return 6*7')) === 42, 'JSFuck 程序形态 Function(...)() 求值正确');
    throws(() => jsfuck.decodeStrExpr('中文'), 'JSFuck 编码器：非 ASCII 明确报错（不静默走样）');
  }

  // 预置：只由八个 JSFuck 字符构成 + 体积落在实测口径附近 + 超限构建失败
  {
    const pre = shellMod.jsfuckPrelude('_0xTestName');
    const expr = pre.slice(pre.indexOf('=') + 1, -1);
    ok(/^[\[\]()!+{}]+$/.test(expr), '预置表达式只由 [ ] ( ) ! + { } 构成', expr.slice(0, 24));
    // 每字节边际成本：用两段不同长度的编码差自己量出来（不碰模块内部常量）
    const e1 = jsfuck.decodeStrExpr('B'.repeat(64)).length;
    const e2 = jsfuck.decodeStrExpr('B'.repeat(128)).length;
    const rate = (e2 - e1) / 64;
    ok(rate < 120, '每字节成本在实测口径内（<120 字符/字节）', rate.toFixed(1));
    let msg = '';
    try { shellMod.jsfuckPrelude('_0xTestName', 1024); } catch (e) { msg = e.message; }
    // 只认数字（实际 46 KB / 核心 487 字符），不依赖 i18n 当前语言
    ok(/46\s*KB/.test(msg) && /487/.test(msg), '核心超限时构建失败并报出实际体积', msg.slice(0, 60));
  }

  // 端到端：产物仍是可执行 JS，且确实带上了纯 JSFuck 段
  const probe = (c) => (c.match(/[\[\]()!+{}]{40,}/g) || [])
    .reduce((a, b) => (b.length > a.length ? b : a), '');
  {
    const jf = obfuscate(SAMPLE, { preset: 'low', seed: 4242, shell: true, shellForm: 'jsfuck' });
    const st = {};
    for (const s of jf.stats || []) st[s.pass] = s.result;
    const out = runNode(jf.code, 'jf-low.js');
    ok(out.includes('hello world') && out.includes('big-even') && out.includes('13'),
      'jsfuck 壳产物可执行且语义不变', out.trim().split('\n').pop());
    ok(st.shell && st.shell.form === 'jsfuck', 'shell 统计标记为 jsfuck 形态', JSON.stringify(st.shell));
    ok(st.shell && st.shell.jsfuckChars > 4096, 'jsfuck 预置体积已计入统计');
    ok(probe(jf.code).length > 20000, '产物里存在整段纯 JSFuck 表达式',
      String(probe(jf.code).length));
    const classic = obfuscate(SAMPLE, { preset: 'low', seed: 4242, shell: true });
    ok(probe(classic.code).length < 100, 'classic 形态（默认）不产生纯 JSFuck 片段',
      String(probe(classic.code).length));
    ok(obfuscate(SAMPLE, { preset: 'low', seed: 4242, shell: true, shellForm: 'jsfuck' }).code === jf.code,
      'jsfuck 形态同 seed 逐字节可复现');
  }

  // 多层：外壳层数与 jsfuck 形态叠加，每层各带一份核心预置
  {
    const deep = obfuscate(SAMPLE, { preset: 'low', seed: 11, shell: true, shellDepth: 2, shellForm: 'jsfuck' });
    const out = runNode(deep.code, 'jf-depth2.js');
    ok(out.includes('hello world') && out.includes('big-even'),
      'shellDepth 2 + jsfuck 两层叠加仍可执行');
  }

  // 防删：jsfuck 形态下横幅互锁必须仍然成立（盐经 K0 进核心）
  {
    const jf = obfuscate(SAMPLE, { preset: 'low', seed: 4242, shell: true, shellForm: 'jsfuck' });
    const cut = jf.code.slice(jf.code.indexOf('\n') + 1);
    let broken = 'RUNS';
    try { runNode(cut, 'jf-cut.js'); } catch (e) { broken = 'BREAKS'; }
    ok(broken === 'BREAKS', 'jsfuck 产物删除横幅后失效（互锁未被形态改动破坏）', broken);
  }
}

// ---------------------------------------------------------------------------
// ------------------------------------------------- 增强保护（内核档 / 横幅 / 碎片化 / Anti-LLM）

section('增强保护：WASM 解释器内核 / 横幅 / 碎片化 / Anti-LLM');
{
  const src = 'function calc(a, b) { var t = a * 2 + b; if (t > 10) { t -= 3; } return t; }\n'
    + 'function label(n) { return n > 5 ? "big" : "small"; }\n'
    + 'var out = [];\nfor (var i = 0; i < 3; i++) { out.push(label(calc(i, 4))); }\n'
    + 'process.stdout.write(out.join(",") + "|" + calc(1, 2));';
  const want = 'small,big,big|4';
  const r = obfuscate(src, { preset: 'max', seed: 4242 });
  const st = {};
  for (const s of r.stats || []) st[s.pass] = s.result;

  // 内核档：解释循环整体在 WASM 内，构建期自检（锚定字/探针/表层解密）必须通过
  ok(st.wasmvm && st.wasmvm.fns > 0, 'max 预设启用 WASM 解释器内核档', JSON.stringify(st.wasmvm));
  ok(st.wasmvm && st.wasmvm.smoke === 'ok', '内核模块构建期自检通过（锚定字/探针/解密）');
  ok(st.wasmvm && st.wasmvm.rtLayers >= 2, '自定义运行时层数生效', String(st.wasmvm && st.wasmvm.rtLayers));
  ok(st.wasmvm && st.wasmvm.moduleBytes > 1000, 'WASM 模块非空');
  ok(runNode(r.code, 'enh-max.js').trim() === want,
    '内核档产物语义不变（max 预设）');

  // 语义等价：内核档多 seed
  let vmBad = 0;
  for (const seed of [1, 2, 3]) {
    const c = obfuscate(src, { preset: 'max', seed }).code;
    if (runNode(c, 'enh-max-' + seed + '.js').trim() !== want) vmBad++;
  }
  ok(vmBad === 0, '内核档跨 seed 语义一致（3 个 seed）');

  // 字符串碎片化：多载体计数 + 与关闭时结构不同
  ok(st.stringArray && st.stringArray.scatterCarriers >= 2, '字符串碎片化多载体生效',
    JSON.stringify(st.stringArray));
  const rNo = obfuscate(src, { preset: 'max', seed: 4242, stringScatter: false });
  const stNo = {};
  for (const s of rNo.stats || []) stNo[s.pass] = s.result;
  ok(stNo.stringArray && stNo.stringArray.scatterCarriers === 0, '关闭碎片化时不产生载体');
  ok(r.code !== rNo.code, '碎片化开关改变产物');

  // Anti-LLM：注记与伪业务分支
  ok(st.antiLLM && (st.antiLLM.notes + st.antiLLM.decoys) > 0, 'Anti-LLM 注记/诱饵已注入',
    JSON.stringify(st.antiLLM));

  // 横幅：默认署名 + 首行位置 + 同 seed 复现
  ok(r.code.startsWith('/*! JsLabyrinth'), '文件头横幅在产物最前面');
  ok(r.code.includes('Author: Heling'), '默认横幅含作者署名');
  ok(st.banner && st.banner.custom === false, '默认横幅标记为非自定义');
  ok(obfuscate(src, { preset: 'max', seed: 4242 }).code === r.code, '同 seed 产物逐字节可复现');

  // 防删：删掉文件头横幅，产物必须失效（密钥流与横幅互锁）
  {
    const cut = r.code.slice(r.code.indexOf('\n') + 1);
    let broken = 'RUNS';
    try { runNode(cut, 'enh-cut.js'); } catch (e) { broken = 'BREAKS'; }
    ok(broken === 'BREAKS', '删除文件头横幅后产物失效（不可删除）', broken);
  }

  // 自定义横幅（付费档能力）与非法输入
  {
    const rc = obfuscate(src, { preset: 'max', seed: 4242, bannerText: 'ACME Internal Build\nAuthor: Heling' });
    ok(rc.code.startsWith('/*! ACME Internal Build'), '自定义横幅写入文件头');
    ok(runNode(rc.code, 'enh-custom.js').trim() === want, '自定义横幅产物可执行');
    throws(() => obfuscate(src, { preset: 'low', bannerText: 'bad */ text' }), '横幅含注释终止符被拒');
    throws(() => obfuscate(src, { preset: 'low', bannerText: 'x'.repeat(3000) }), '横幅超长被拒');
  }

  // 关掉外壳时横幅只做守卫（不额外引入 eval 层），产物仍可执行
  {
    const rs = obfuscate(src, { preset: 'max', seed: 9, shell: false });
    ok(!/eval/.test(rs.code.split('\n').slice(0, 3).join('\n')), '无外壳时横幅不引入 eval 层');
    ok(runNode(rs.code, 'enh-noshell.js').trim() === want, '无外壳 + 横幅产物可执行');
  }

  // shebang 顺序：hashbang 必须仍在第一行，横幅紧随其后
  {
    const sh = obfuscate('#!/usr/bin/env node\nprocess.stdout.write("ok");', { preset: 'low', seed: 3 });
    ok(sh.code.split('\n')[0].startsWith('#!'), 'hashbang 仍在第一行');
    ok(sh.code.split('\n')[1].startsWith('/*!'), '横幅紧随 hashbang');
    ok(runNode(sh.code, 'enh-shebang.js').trim() === 'ok', '带 hashbang 的产物可执行');
  }
}

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
