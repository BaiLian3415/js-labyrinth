/**
 * License 核心验证系统，由 host/cli.js 引入。
 *
 * 两层机器绑定。**卡密里**带一段机器码的派生摘要（绑定段），它在 Ed25519 签名
 * 载荷内，因此"这张卡属于哪台机器"在签发时就定死了：拿到别人的卡密到本机激活
 * 一定失败。**本地记录里**另有一份机器码与 HMAC 令牌，防的是把 license.lic 直接
 * 拷到另一台机器上——那一层的密钥派生自公钥、是公开的，只留下篡改痕迹，真正的
 * 边界是卡密那层的非对称签名。
 *
 * 机器指纹涵盖平台、架构、主机名、用户名、网卡 MAC 与 CPU 型号，经 scrypt
 * 派生为定长机器码，换机后许可证立即失效。首次运行必须输入卡密，校验通过后把
 * 机器码、套餐、到期时间、用量与 HMAC 令牌写入 license.lic，之后每次运行只读
 * 该文件。运行期同时检查 inspector 接入、--inspect 启动参数、调试器字符串钩子
 * 与断点暂停，并对自身模块、套餐定义与许可证文件交叉比对哈希，任何改动都会污染
 * 返回值，让函数不再返回调用方期望的结果。
 *
 * 套餐（src/plans.js）决定这张卡能用的混淆选项范围与配额。套餐名与到期时间
 * 一样不直接采信 license.lic 里的字段，而是从卡密里还原后比对，单独改文件里的
 * plan 字段升不了档。用量计数进 HMAC 令牌载荷，改计数同样过不了验签，每日配额
 * 无法靠编辑文件清零。
 *
 * 异常路径以非零退出码终止 CLI。判定为恶意调试或篡改时走 trapExit()，
 * 破坏派生密钥并改写返回值，静默地把错误数据交给后续逻辑。
 *
 * @module license
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';
import inspector from 'node:inspector';
import { fileURLToPath } from 'node:url';

import i18n from '../src/i18n.js';
const { t } = i18n;
import secret from '../src/license-secret.js';
const { B64_PUBLIC_KEY, B64_MACHINE_SALT, SELF_DIGESTS } = secret;
import codec from '../src/license-codec.js';
import plan from '../src/plan.js';
import licCore from '../src/license-core.js';
import platform from '../src/platform.js';
import { b64ToText } from '../src/utils/hash.js';

const { todayKey, readUsage } = licCore;

/** 包根目录，license.lic 默认落在这里，随工具一起拷贝。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 许可证文件路径；环境变量 JSLABYRINTH_LICENSE_FILE 可覆盖，供自动化测试用。 */
const LICENSE_PATH = platform.env('JSLABYRINTH_LICENSE_FILE') || path.join(ROOT, 'license.lic');

/** 陷阱标记。message 等于它的错误一律视为已确认的篡改，走 trapExit()。 */
const TRAP_MARK = '__JSLB_TRAP__';

/** 判定为"被暂停/被单步"的单次探针耗时阈值。 */
const HOSTILE_MS = 1500;

/** 计时探针预热次数，避开 JIT 冷启动造成的误报。 */
const TIMING_WARMUP = 3;

// 签发公钥与机器盐。两个都不是秘密：公钥本来就随源码分发，机器盐只用于派生
// 机器码（机器码本身是公开标识）。**私钥不在这里**——卡密只在签发方用私钥签，
// 本工具（以及浏览器、Worker）只验签。这是换成非对称之后的核心性质。
const PUBLIC_KEY = B64_PUBLIC_KEY;
const MACHINE_SALT = b64ToText(B64_MACHINE_SALT);

// 自校验基线。每个自身文件的期望摘要存在 license-secret.js 的 SELF_DIGESTS 里，
// 形式是摘要 XOR 公钥派生掩码。摘要计算前先把源文本里的 64 位 hex 串归一化，
// 消除摘要表对自身的自引用。
//
// 掩码密钥是公钥，也就是公开的：这张表只挡"随手改一行源码"，挡不住有心人重算
// 整张表。换成非对称之后库里不再有任何秘密可供派生掩码，这是必然结果。真正的
// 安全边界是私钥不在库里。

/** 参与完整性检查的自身文件，路径相对包根。顺序必须与 SELF_DIGESTS 一致。 */
const SELF_FILES = [
  'host/license-node.js',
  'src/license-core.js',
  'src/license-codec.js',
  'src/license-secret.js',
  // 套餐定义与判定也纳入校验：不放进来，改一改 plans.js 就能自行解锁高档权益
  'src/plan.js',
  'src/plans.js',
];

/** 进程启动时刻，作为计时探针基准。 */
const START_TIME = Date.now();

/** 已激活的授权信息，null 表示尚未激活。套餐、到期时间与用量均取自卡密与验签结果。 */
let licenseState = null;

/** 陷阱是否已触发。触发后所有返回值都被破坏。 */
let trapped = false;

/** 缓存的自校验结果。 */
let selfIntegrityOk = null;

/** 反调试确认计数。 */
let hostileHits = 0;

/**
 * FNV-1a 折叠：把若干文本混成一个 32 位无符号整数。
 * @param {string[]} parts 参与混合的文本片段
 * @returns {number} 32 位无符号整数
 */
function foldText(parts) {
  let acc = 0x811c9dc5;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      acc ^= part.charCodeAt(i) & 0xff;
      acc = Math.imul(acc, 0x01000193) >>> 0;
    }
  }
  return acc >>> 0;
}

/**
 * 摘要前归一化：把所有 64 位 hex 串先抹成 0。
 *
 * SELF_DIGESTS 表项就是 64 位 hex，抹零后这张表不参与自身的摘要计算，消除
 * 表包含自己哈希的自引用。改动表项本身不会改变实算摘要，攻击者也就无法靠
 * 改表来掩盖对代码的改动。
 *
 * @param {string} text 源文件文本
 * @returns {string} 归一化文本
 */
function normalizeForHash(text) {
  return text.replace(/\b[0-9a-f]{64}\b/g, '0'.repeat(64));
}

/**
 * 计算单个自身文件的摘要。
 * @param {string} rel 相对包根的路径
 * @returns {string} 64 位 hex 摘要，读取失败时返回空串
 */
function fileDigest(rel) {
  try {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    return crypto.createHash('sha256').update(normalizeForHash(text), 'utf8').digest('hex');
  } catch (e) {
    // 文件缺失或不可读，调用方按摘要不匹配处理
    return '';
  }
}

/**
 * 第 i 条摘要的掩码，由根密钥派生，表里因此没有可直接读取的明文摘要。
 * @param {number} i 文件序号
 * @returns {string} 64 位 hex 掩码
 */
function digestMask(i) {
  return crypto.createHmac('sha256', PUBLIC_KEY).update('JSLB/SELF/' + i).digest('hex');
}

/**
 * 逐字符 XOR 两段等长 hex 文本。
 * @param {string} a 一段 hex 文本
 * @param {string} b 另一段 hex 文本
 * @returns {string} XOR 结果
 */
function xorHex(a, b) {
  let out = '';
  for (let i = 0; i < a.length; i++) {
    out += (parseInt(a[i], 16) ^ parseInt(b[i], 16)).toString(16);
  }
  return out;
}

/**
 * 逐个比对自身源文件的摘要，任一不符即判定被篡改。
 *
 * 表里存的是 digest XOR mask(i)，比对时先 XOR 还原。表项格式不对或长度对不上，
 * 都按失败处理。构建期漏跑 tools/issue/selfdigest.js 时表会是空的，这里同样拒绝启动，
 * 宁可起不来，也不要静默地失去保护。
 *
 * @returns {boolean} 自身文件是否全部未被改动
 */
function checkSelfIntegrity() {
  if (selfIntegrityOk !== null) return selfIntegrityOk;
  let ok = SELF_DIGESTS.length === SELF_FILES.length;
  if (ok) {
    for (let i = 0; i < SELF_FILES.length && ok; i++) {
      const stored = SELF_DIGESTS[i];
      if (typeof stored !== 'string' || !/^[0-9a-f]{64}$/.test(stored)) { ok = false; break; }
      const actual = fileDigest(SELF_FILES[i]);
      ok = actual !== '' && xorHex(stored, digestMask(i)) === actual;
    }
  }
  selfIntegrityOk = ok;
  return ok;
}

// 机器指纹。

/** 网卡 MAC 归一化：转小写、去分隔符、过滤全零地址。 */
function macs() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      const m = String(ni.mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
      if (m.length !== 12 || m === '000000000000') continue;
      out.push(m);
    }
  }
  return out.sort();
}

/** 主机名与用户名归一化，消除不同平台的大小写差异。 */
const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * 计算当前机器码，base32，24 字符。
 *
 * 同一台机器上结果稳定。换机器、换网卡或换用户都会改变它，许可证随即失效。
 *
 * @returns {string} 机器码
 */
function machineId() {
  const parts = [
    'JSLB-MACHINE-1',
    norm(os.platform()),
    norm(os.arch()),
    norm(os.hostname()),
    norm(os.userInfo().username),
    norm(os.cpus()[0] && os.cpus()[0].model),
    macs().join(','),
  ].join('|');
  const raw = crypto.scryptSync(parts, MACHINE_SALT, 32, { N: 16384, r: 8, p: 1 });
  return codec.digestToB32(raw.toString('hex'), 24);
}

// 反调试。

/**
 * inspector 是否处于活动状态。
 *
 * 覆盖三种证据：启动参数、NODE_OPTIONS、运行期已挂载的 inspector 会话。
 * 不能用 process.debugPort 判断，新版 Node 默认就给它一个非零端口，没有接入
 * 调试器时也会误判。只有 inspector.url() 反映真实连接。
 *
 * @returns {boolean} 是否存在调试器接入
 */
function inspectorActive() {
  const argv = process.execArgv.join(' ') + ' ' + process.argv.slice(1).join(' ');
  if (/--inspect(-brk)?\b/.test(argv)) return true;
  if (/--inspect(-brk)?\b/.test(String(process.env.NODE_OPTIONS || ''))) return true;
  try {
    if (inspector.url() !== undefined) return true;
  } catch (e) {
    // inspector 模块不可用，受限运行环境里无调试器可检测，按未接入处理
  }
  return false;
}

/**
 * Function.prototype.toString 是否仍是原生实现，用于发现钩子替换。
 * @returns {boolean} 未被替换
 */
function nativeToStringOk() {
  try {
    const src = Function.prototype.toString.call(Function.prototype.toString);
    return src.indexOf('[native code]') >= 0;
  } catch (e) {
    // toString 被换成抛错实现，等同于被钩
    return false;
  }
}

/**
 * 计时探针。执行一段固定工作量，耗时远超预期就说明被断点或单步暂停过。
 *
 * 单次结果不构成结论，由调用方累计计分，避免高负载机器上误杀。
 *
 * @returns {boolean} 本次是否观察到异常暂停
 */
function timingProbe() {
  const t0 = Date.now();
  let acc = 0;
  for (let i = 0; i < 150000; i++) acc = (acc + Math.imul(i, 2654435761)) >>> 0;
  // 让 acc 参与后续判断，阻止引擎做死代码消除
  if (acc === 0xffffffff) return false;
  return Date.now() - t0 > HOSTILE_MS;
}

/** 预热计时探针，避免首次 JIT 编译的耗时被误判为暂停。 */
function warmupProbe() {
  for (let i = 0; i < TIMING_WARMUP; i++) timingProbe();
}
warmupProbe();

/**
 * 反调试检查。累计敌意证据，达标即认定被调试。
 *
 * 计分而非单条判定，是因为任何单项证据都可能来自正常环境。inspector 接入属于
 * 强证据，一次就够；其余弱证据要多次复现才升级。
 *
 * @param {boolean} [hard] 为真时按当前累计证据判定，用于关键路径
 * @returns {boolean} 是否已确认被调试
 */
function antiDebug(hard) {
  let score = 0;
  if (inspectorActive()) score += 2;
  if (!nativeToStringOk()) score += 2;
  if (timingProbe()) score += 1;
  if (score > 0) hostileHits++;
  // 单条弱证据不足以判定。inspector 是强证据，一次即可
  if (score >= 2) return true;
  if (hard && hostileHits >= 2) return true;
  return false;
}

// 返回值篡改与陷阱。

/**
 * 派生一个随陷阱状态翻转的掩码。
 *
 * 未触发陷阱时返回 0，对调用方完全不可见。触发后返回非零值，令所有派生密钥
 * 错位、所有断言得出相反结论。
 *
 * @returns {number} 0 或非零掩码
 */
function trapMask() {
  if (!trapped) return 0;
  return foldText([String(START_TIME), String(process.pid)]) | 1;
}

/**
 * 篡改返回值，按掩码污染字符串、数字、布尔与对象。
 *
 * 未触发陷阱时原样返回，正常路径零开销、零行为差异。
 *
 * @param {*} value 原始返回值
 * @returns {*} 被污染或原样的值
 */
function corrupt(value) {
  const m = trapMask();
  if (m === 0) return value;
  if (typeof value === 'string') {
    // 翻转其中一位字符。调用方拿到的是能通过类型检查、但内容错误的字符串
    const i = m % value.length;
    const c = value.charCodeAt(i) ^ (m & 0x1f);
    return value.slice(0, i) + String.fromCharCode(c) + value.slice(i + 1);
  }
  if (typeof value === 'number') return value ^ (m & 0xffff);
  if (typeof value === 'boolean') return !value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = {};
    for (const k of Object.keys(value)) out[k] = corrupt(value[k]);
    return out;
  }
  return value;
}

/**
 * 触发陷阱，破坏运行时派生状态，令后续所有校验与派生结果失效。
 *
 * 不抛错也不打印，静默进行。调用方在后续逻辑里自然拿到错误结果，不会得到
 * 任何指向陷阱本身的线索。
 */
function trip() {
  trapped = true;
  // 清掉缓存，强制后续的完整性检查与机器码走污染路径
  selfIntegrityOk = false;
  licenseState = corrupt(licenseState);
}

/**
 * 陷阱出口，确认被调试或被篡改时调用。
 *
 * 先污染返回值，再以退出码 2 静默退出。退出码与常规失败区分开，同时不给出
 * 可定位的失败原因。
 *
 * @param {string} reason 内部原因，只在设置 JSLABYRINTH_LICENSE_DEBUG 时输出
 */
function trapExit(reason) {
  trip();
  if (process.env.JSLABYRINTH_LICENSE_DEBUG) {
    console.error('[license-debug] trap: ' + reason);
  }
  process.exit(2);
}

/**
 * 抛出陷阱标记，让任意深度的调用点都能冒泡到 guard()。
 * @param {string} reason 内部原因
 */
function trapThrow(reason) {
  const e = new Error(TRAP_MARK);
  e.jslbTrap = reason;
  throw e;
}

/**
 * 关键路径守卫，在混淆主流程前后调用。检测到调试或篡改时直接陷阱退出。
 * @param {string} where 调用位置标记，仅诊断用
 */
function watchdog(where) {
  if (trapped) trapExit('already trapped at ' + where);
  if (!checkSelfIntegrity()) trapExit('self integrity failed at ' + where);
  if (antiDebug(true)) trapExit('debugger detected at ' + where);
}

/**
 * 授权成功后的静默心跳，周期性复查。调试器在运行中途接入同样会被发现。
 *
 * 定时器 unref，否则它会拖住事件循环，让进程无法正常退出。
 */
function startHeartbeat() {
  const timer = setInterval(() => {
    try {
      if (!checkSelfIntegrity()) trapExit('heartbeat integrity');
      if (antiDebug(true)) trapExit('heartbeat debugger');
    } catch (e) {
      if (e && e.message === TRAP_MARK) trapExit('heartbeat trap');
      trapExit('heartbeat error');
    }
  }, 1000);
  if (timer.unref) timer.unref();
  return timer;
}

// 许可证文件读写。

/**
 * 读取并解析许可证文件。
 * @returns {{ok:boolean, reason?:string, data?:object}} 解析结果
 */
function readLicenseFile() {
  let text;
  try {
    text = fs.readFileSync(LICENSE_PATH, 'utf8');
  } catch (e) {
    // 文件不存在是首次运行的正常路径，其余读取错误一律视为损坏
    return { ok: false, reason: e.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: 'corrupt' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'corrupt' };
  return { ok: true, data };
}

/**
 * 把授权写入许可证文件，先写临时文件再 rename，保证原子替换。
 *
 * 记录内容由 src/license-core.js 拼装，套餐、到期时间与用量都进令牌签名
 * 载荷，改文件里的任何一项都过不了验签。
 *
 * @param {{code:string, plan:string, issuedAt:number, expiresAt:number, usage:{day:string, used:number}}} lic 授权内容
 * @returns {{ok:boolean}} 写入结果
 */
function writeLicenseFile(lic) {
  const payload = licCore.makeRecord({ ...lic, machine: machineId() }, PUBLIC_KEY);
  const tmp = LICENSE_PATH + '.tmp';
  try {
    fs.mkdirSync(path.dirname(LICENSE_PATH), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, LICENSE_PATH);
    return { ok: true };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* 临时文件没建成，无需清理 */ }
    return { ok: false };
  }
}

/**
 * 校验许可证文件内容是否与当前机器、当前时间、根密钥自洽。
 *
 * 判定规则与网页版共用（src/license-core.js），这里只负责提供本机机器码
 * 与根密钥：两端的卡密、令牌与配额语义因此完全一致。
 *
 * @param {object} data 许可证内容
 * @returns {{ok:boolean, reason?:string, expiresAt?:number, plan?:string, code?:string, usage?:object}} 校验结果
 */
function verifyLicenseData(data) {
  return licCore.verifyLicenseData(data, machineId(), PUBLIC_KEY);
}

// 激活流程。

/**
 * 异步读取一行输入。
 * @param {string} promptText 提示文本
 * @returns {Promise<string|null>} 输入内容，EOF 返回 null
 */
function ask(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      try { rl.close(); } catch (e) { /* 已经关过了 */ }
      resolve(v);
    };
    rl.on('close', () => finish(null));
    rl.question(promptText, (ans) => finish(ans));
  });
}

/**
 * 交互式激活：索取卡密、校验、写入 license.lic。
 *
 * 环境变量 JSLABYRINTH_LICENSE_KEY 可直接提供卡密，供自动化与无人值守场景使用。
 * 激活时用量归零并记为当日。
 *
 * @returns {Promise<{ok:boolean, reason?:string, code?:string, plan?:string, issuedAt?:number, expiresAt?:number, usage?:object}>} 激活结果
 */
async function activate() {
  console.error(t('licFirstRun', { path: LICENSE_PATH }));
  const fromEnv = process.env.JSLABYRINTH_LICENSE_KEY;
  let raw = fromEnv;
  if (!raw) {
    if (!process.stdin.isTTY) {
      console.error(t('licNeedTty'));
    }
    raw = await ask(t('licPrompt'));
  }
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { ok: false, reason: 'noinput' };
  }
  const parsed = codec.parseCode(PUBLIC_KEY, String(raw).trim());
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  // 卡密里记录的机器指纹与当前机器是否一致。绑定段在签名载荷里，改不了；
  // 所以这里拒绝的其实是"拿别人的卡密到本机激活"。不绑定的卡（绑定段全 0）放行。
  if (!codec.matchesMachine(parsed.bindSeg, machineId())) return { ok: false, reason: 'bind' };

  // 到期时间由卡密里已签名的签发日与天数推出，激活时刻不参与：本地改 issuedAt
  // 续不了期，续期必须重新签卡。issuedAt 仍记下来，但只是"本机何时激活"的台账。
  const issuedAt = Date.now();
  const expiresAt = licCore.expiryFromIssueDay(parsed);
  const usage = { day: todayKey(), used: 0 };
  const written = writeLicenseFile({ code: parsed.code, plan: parsed.plan, issuedAt, expiresAt, usage });
  if (!written.ok) return { ok: false, reason: 'write' };
  return { ok: true, code: parsed.code, plan: parsed.plan, issuedAt, expiresAt, usage };
}

/**
 * 输出授权状态横幅：套餐、到期时间、机器码与今日用量。
 * 套餐与剩余次数都在这里亮出来，用户被配额拦下时先看到的就是这几行。
 */
function printLicenseBanner() {
  const mid = machineId();
  const p = plan.describe(licenseState.plan);
  if (licenseState.expiresAt === codec.PERPETUAL) {
    console.error(t('licOkPerpetual', { machine: mid, plan: p.display }));
  } else {
    console.error(t('licOkUntil', {
      machine: mid,
      plan: p.display,
      date: new Date(licenseState.expiresAt).toISOString().slice(0, 10),
    }));
  }
  console.error(quotaText());
}

/**
 * 今日用量文案，含套餐每日上限或不限次数。
 * @returns {string} 本地化用量文本
 */
function quotaText() {
  const q = quota();
  if (!q) return '';
  const label = plan.displayName(licenseState.plan);
  // 一次性额度包买的是总次数，说"今日"会把买断说成按日重置
  if (plan.isCumulative(planEnt())) {
    return q.total > 0
      ? t('licUsageTotal', { used: q.used, total: q.total, plan: label })
      : t('licUsageTotalUnlimited', { used: q.used, plan: label });
  }
  return q.total > 0
    ? t('licUsageLimited', { used: q.used, total: q.total, plan: label })
    : t('licUsageUnlimited', { used: q.used, plan: label });
}

// 套餐权益与配额。

/**
 * 当前套餐的权益，供 CLI 做选项闸门与限额判定。
 *
 * 套餐属于许可证状态，命令行与配置文件都不能覆盖它，否则等于给了自助升档的
 * 入口。卡密上的套餐字符已进签名载荷，改卡密也换不了档。
 *
 * @returns {{plan:string, display:string, rank:number, preset:string, limits:object, gates:object}|null} 未激活时返回 null
 */
function entitlements() {
  if (!licenseState) return null;
  const p = plan.describe(licenseState.plan);
  // 陷阱触发后返回值被污染，调用方拿到的套餐会错位，与模块整体的失败姿态一致
  return corrupt({
    plan: p.name,
    display: p.display,
    rank: p.rank,
    preset: p.preset,
    kind: p.kind,
    note: p.note,
    limits: p.limits,
    gates: p.gates,
  });
}

/** @returns {object|null} 当前套餐的权益描述，供配额口径判定使用。 */
function planEnt() {
  return licenseState ? plan.describe(licenseState.plan) : null;
}

/**
 * 配额快照，不消耗次数。
 *
 * 订阅档按自然日重置：日期取本机时区。若文件里的日期比今天更晚（用户把系统
 * 时间往回拨），仍按文件里的日期计算，不回退到已用尽的计数。
 * 一次性额度包按总额度累计：用了的不会隔天还回来。
 *
 * @returns {{total:number, used:number, left:number}|null} total 为 0 表示不限次数，
 *   此时 left 为 -1；未激活时返回 null
 */
function quota() {
  if (!licenseState) return null;
  const ent = planEnt();
  const total = plan.quotaLimit(ent);
  const used = plan.isCumulative(ent)
    ? licenseState.usage.used
    : (licenseState.usage.day >= todayKey() ? licenseState.usage.used : 0);
  return corrupt({ total, used, left: total === 0 ? -1 : Math.max(0, total - used) });
}

/**
 * 记一次混淆任务，把用量写回许可证文件。
 *
 * 日期翻页时计数归零重记；日期未变则累加。写入失败时用量保持原值，调用方按
 * 失败处理，免得下次校验时令牌与用量对不上。
 *
 * @returns {{ok:boolean, reason?:string, used?:number, total?:number}} 记账结果，
 *   reason 为 quota 表示今日次数已用尽
 */
function consumeRun() {
  if (!licenseState) return { ok: false, reason: 'nolicense' };
  if (trapped) return { ok: false, reason: 'trap' };
  const ent = planEnt();
  const total = plan.quotaLimit(ent);
  const today = todayKey();
  // 额度包：usage.day 固定为激活日，used 即累计次数，隔天不归零。
  // 订阅档：日期翻页则重新计数；时钟回拨时沿用文件里更晚的日期，计数只增不减。
  const cumulative = plan.isCumulative(ent);
  const day = cumulative ? licenseState.usage.day : (licenseState.usage.day >= today ? licenseState.usage.day : today);
  const used = (cumulative || day === licenseState.usage.day ? licenseState.usage.used : 0) + 1;
  if (total > 0 && used > total) return { ok: false, reason: 'quota', used, total };

  const written = writeLicenseFile({
    code: licenseState.code,
    plan: licenseState.plan,
    issuedAt: licenseState.issuedAt,
    expiresAt: licenseState.expiresAt,
    usage: { day, used },
  });
  if (!written.ok) return { ok: false, reason: 'write' };
  licenseState.usage = { day, used };
  return { ok: true, used, total };
}

/**
 * 校验本地授权，不存在或无效时进入激活流程。
 * 成功返回授权信息，失败直接终止进程。
 * @returns {Promise<{plan:string, code:string, machine:string, expiresAt:number, usage:object}>} 授权信息
 */
async function expectLicense() {
  if (!PUBLIC_KEY || !MACHINE_SALT) trapExit('missing key material');
  if (!checkSelfIntegrity()) trapExit('self integrity failed at load');
  if (antiDebug(true)) trapExit('debugger detected at startup');

  const local = readLicenseFile();
  if (local.ok) {
    const res = verifyLicenseData(local.data);
    if (res.ok) {
      licenseState = {
        plan: res.plan,
        code: res.code,
        machine: local.data.machine,
        issuedAt: local.data.issuedAt,
        expiresAt: res.expiresAt,
        usage: res.usage,
      };
      printLicenseBanner();
      startHeartbeat();
      return licenseState;
    }
    console.error(t('licInvalid', { reason: t('licReason_' + res.reason) }));
  } else if (local.reason !== 'missing') {
    console.error(t('licInvalid', { reason: t('licReason_' + local.reason) }));
  }

  const act = await activate();
  if (!act.ok) {
    const reason = t('licReason_' + act.reason);
    console.error(t('licFail', { reason }));
    console.error(t('licHowTo'));
    process.exit(1);
  }
  licenseState = {
    plan: act.plan,
    code: act.code,
    machine: machineId(),
    issuedAt: act.issuedAt,
    expiresAt: act.expiresAt,
    usage: act.usage,
  };
  console.error(t('licActivated', { path: LICENSE_PATH }));
  printLicenseBanner();
  startHeartbeat();
  return licenseState;
}

/**
 * CLI 引导，先过许可证闸门，再运行真正的 main。
 * 陷阱错误在这里统一收敛，堆栈不会泄漏到用户可见输出。
 * @param {Function} run 通过授权后执行的入口，即 cli.main
 * @returns {Promise<void>} 完成即进程自然退出
 */
async function guard(run) {
  try {
    await expectLicense();
  } catch (e) {
    if (e && e.message === TRAP_MARK) trapExit(e.jslbTrap || 'gate');
    throw e;
  }
  try {
    watchdog('pre-main');
    run();
  } catch (e) {
    if (e && e.message === TRAP_MARK) trapExit(e.jslbTrap || 'main');
    throw e;
  }
}

const api = {
  LICENSE_PATH,
  TRAP_MARK,
  expectLicense,
  guard,
  watchdog,
  antiDebug,
  machineId,
  checkSelfIntegrity,
  corrupt,
  trip,
  trapExit,
  trapThrow,
  // 套餐权益与配额，供 CLI 判定选项范围、限额与记账
  entitlements,
  quota,
  quotaText,
  consumeRun,
  isLicensed: () => licenseState !== null && !trapped,
};

export default api;
export {
  LICENSE_PATH, TRAP_MARK, expectLicense, guard, watchdog, antiDebug, machineId,
  checkSelfIntegrity, corrupt, trip, trapExit, trapThrow,
  entitlements, quota, quotaText, consumeRun,
};

