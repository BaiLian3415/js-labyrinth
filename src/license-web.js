/**
 * 网页版授权（浏览器与 Cloudflare Workers 共用）。
 *
 * 与 Node 版的差别只在宿主能力，判定规则完全一致：卡密由同一份 license-codec
 * 解析，许可证记录由同一份 license-core 校验，套餐闸门与配额口径也一致。
 *
 * 机器码的来源不同。浏览器里**没有**可靠的唯一硬件标识，能拿到的只有一组设备
 * 特征（平台、CPU 核心数、屏幕、GPU 渲染器、时区、语言），同型号机器算出来是
 * 同一个值。所以网页端的"机器绑定"是**设备特征绑定**，比 Node 端的硬件指纹弱
 * 一档：两台同型号同配置的机器可以共用一张卡。这是浏览器沙箱里的物理上限，
 * 不是实现偷懒；真要一对一，得把签发权搬到服务端（本项目刻意不这么做，见下）。
 *
 * 设备特征里不含任何随机量，因此换浏览器、清站点数据、隐私模式都不会换机器码
 * ——这正是绑定机器时需要的行为。特征算法一变（改动字段集合或其顺序），所有
 * 已签发的网页卡都会失效，改动前务必确认。
 *
 * 反调试与自身文件摘要校验不在这里实现：网页端的代码与密钥对使用者完全可见，
 * 那两项在网页里没有实际防护意义，硬搬只会变成误导。部署方若要真正强制授权，
 * 应走 Worker API（密钥放服务端 secret），而不是依赖客户端校验。
 *
 * 全部接口都是异步的：Worker 的计数可能落在 KV 上，浏览器侧虽同步也统一成
 * promise，调用点无需区分。
 */
import codec from './license-codec.js';
import plan from './plan.js';
import secret from './license-secret.js';
import licCore from './license-core.js';
import platform from './platform.js';
import i18n from './i18n.js';
import { b64ToText, hmacSha256Hex } from './utils/hash.js';

const { t } = i18n;

// 签发公钥。卡密用 Ed25519 签名，浏览器只持公钥——**爬走全部源码也签不出新卡**，
// 这是换成非对称之后拿到的性质。部署方想用自己的密钥对，用 JSLB_PUBLIC_KEY 覆盖。
const BUNDLED_PUBLIC_KEY = secret.B64_PUBLIC_KEY;

let publicKey = BUNDLED_PUBLIC_KEY;
let machineSalt = b64ToText(secret.B64_MACHINE_SALT);
let keysOverridden = false;

/** 存储键。 */
const K_DEVICE = 'jslabyrinth.device.v1';
const K_LICENSE = 'jslabyrinth.license.v2';
const K_TRIAL_USAGE = 'jslabyrinth.trial-usage.v1';

/** 设备码内存缓存。 */
let deviceCache = null;

/** 设备特征串内存缓存（派生机器码用，不含随机量）。 */
let fingerprintCache = null;

/** 当前授权状态：null 表示未激活且未进入试用。 */
let state = null;

/** 服务端请求带来的设备码（Worker 逐请求设置）。 */
let requestDeviceId = null;

/**
 * 覆盖公钥与机器盐。部署方用自己的密钥对签卡时用得上。
 * @param {string} publicKeyB64 签发公钥的 base64（32 字节）
 * @param {string} saltBase64 机器盐的 base64
 */
export function setKeyMaterial(publicKeyB64, saltBase64) {
  if (publicKeyB64) { publicKey = String(publicKeyB64); keysOverridden = true; }
  if (saltBase64) { machineSalt = b64ToText(saltBase64); keysOverridden = true; }
}

/**
 * 从环境变量加载密钥覆盖（JSLB_PUBLIC_KEY / JSLB_MACHINE_SALT，base64）。
 * Worker 入口每次请求调用，未配置时保持内置常量。
 *
 * 这两个都不是秘密：公钥本来就随源码分发。放在环境变量里只是为了支持"不同部署
 * 用不同密钥对"，不是为了藏东西——**私钥绝不能出现在这里**。
 */
export function loadKeysFromEnv() {
  const k = platform.env('JSLB_PUBLIC_KEY');
  const s = platform.env('JSLB_MACHINE_SALT');
  if (k || s) setKeyMaterial(k, s);
}

/**
 * 设置本次请求的设备码（Worker 从请求头 X-JSLB-Device 取）。
 * @param {string|null} id 设备码文本
 */
export function setRequestDeviceId(id) {
  requestDeviceId = id || null;
}

/**
 * 清空逐请求的授权状态。Worker 入口在 prepareEnv 里调用。
 *
 * 必须调用：state / deviceCache 是模块级变量，而一个 isolate 会连续处理多个
 * 互不相干的请求。不清理的话，A 激活出的 business 权益会留在 state 里，
 * 之后的 B、C 即使没有任何卡密，也会读到同一份非试用权益——授权形同虚设。
 */
export function resetRequestState() {
  state = null;
  deviceCache = null;
  requestDeviceId = null;
  fingerprintCache = null;
}

/** @returns {boolean} 是否使用了外部注入的密钥。 */
export const usingExternalKeys = () => keysOverridden;

/**
 * 把签发时用的机器码格式化成绑定段，供界面提示"把这段报给签发方"。
 *
 * 直接给出机器码而不是绑定摘要：签发方用 --bind 接受的就是机器码，让他自己
 * 算摘要，免得界面与服务端两处算法漂移。
 *
 * @returns {Promise<string>} 机器码，24 字符 base32
 */
export async function bindTarget() {
  return machineId();
}

// 存储读写。绑定了 KV 时优先走 KV（跨请求、跨 isolate），否则走 platform 的
// 键值存储（浏览器 localStorage / 其余环境的内存实现）。
//
// KV 是整站共享的，键名却是常量，直接读写会让所有访问者共用同一条许可证记录
// （A 激活，B 也被算作已激活）。因此请求带了设备码时一律按设备加后缀；浏览器
// 侧没有请求设备码，键名保持原样，localStorage 的语义不变。

/** 按当前请求的设备码隔离存储键。 */
function scopedKey(key) {
  return requestDeviceId ? key + ':' + requestDeviceId : key;
}

async function storeGet(key) {
  const kv = platform.getKv();
  if (kv && typeof kv.get === 'function') {
    try {
      return await kv.get(scopedKey(key));
    } catch (e) {
      // KV 故障时退回本地存储，不阻断请求
    }
  }
  return platform.getStorage().get(scopedKey(key));
}

async function storeSet(key, value) {
  const kv = platform.getKv();
  if (kv && typeof kv.put === 'function') {
    try {
      return await kv.put(scopedKey(key), value);
    } catch (e) {
      // 同上
    }
  }
  return platform.getStorage().set(scopedKey(key), value);
}

/**
 * 删除一个键。
 *
 * 解除激活必须走删除而不是写空串：KV 里留着空值也能被 get 读到（返回空串），
 * 而空串在本地存储与 KV 上的语义并不一致，依赖"空串等于没记录"来判定未激活，
 * 等于把正确性押在存储后端的实现细节上。绑 KV 时用 delete，没有则 remove。
 */
async function storeDel(key) {
  const kv = platform.getKv();
  if (kv) {
    if (typeof kv.del === 'function') {
      try {
        await kv.del(scopedKey(key));
        return;
      } catch (e) {
        // 删除失败时继续走下面的兜底，不阻断解除流程
      }
    }
    // 后端没有 delete 接口时退回写空串：restore() 读到空串同样判为无记录。
    // 不能就此放弃——绑定了 KV 却不删，等于解除只在本地生效。
    if (typeof kv.put === 'function') {
      try {
        await kv.put(scopedKey(key), '');
        return;
      } catch (e) { /* 同上 */ }
    }
  }
  const st = platform.getStorage();
  if (typeof st.remove === 'function') st.remove(scopedKey(key));
  else await storeSet(key, '');
}

/** 随机设备码，32 位 hex。 */
function newDeviceId() {
  const bytes = platform.randomBytes(16);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] >>> 4).toString(16) + (bytes[i] & 15).toString(16);
  return s;
}

/**
 * 当前设备码。首次调用生成并持久化，之后稳定。
 * @returns {Promise<string>} 设备码
 */
async function deviceId() {
  if (requestDeviceId) return String(requestDeviceId).slice(0, 128);
  if (deviceCache) return deviceCache;
  const envId = platform.env('JSLB_DEVICE_ID');
  if (envId) {
    deviceCache = envId;
    return deviceCache;
  }
  let id = await storeGet(K_DEVICE);
  if (!id || !/^[0-9a-f]{8,128}$/i.test(id)) {
    id = newDeviceId();
    await storeSet(K_DEVICE, id);
  }
  deviceCache = id;
  return id;
}

/**
 * 采集设备特征，拼成一段定序文本。
 *
 * 只取**跨会话稳定**的量：平台、CPU 核心数、屏幕尺寸与像素比、GPU 渲染器、
 * 时区与语言。刻意不取 UA 全串（同一浏览器版本内会随小版本更新漂移）、不取
 * canvas 噪声（隐私浏览器会加噪，且同一台机器两次可能不同）、也不取任何随机值。
 *
 * 任何一项取不到就用空串占位，位置依然保留——位置是协议的一部分，不能因为
 * 某项缺失就让后面的项前移，否则同一台机器在不同能力环境下会算出不同机器码。
 *
 * 结果不含随机量，所以刷新页面、清站点数据、换隐私模式都不会改变它。
 *
 * @returns {string} 特征串
 */
function deviceFingerprint() {
  if (fingerprintCache) return fingerprintCache;
  const nav = platform.navigatorInfo();
  const scr = platform.screenInfo();
  const cores = nav && Number.isFinite(nav.hardwareConcurrency) ? String(nav.hardwareConcurrency) : '';
  const tz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch (e) {
      return '';
    }
  })();
  const parts = [
    'JSLB-WEB-2',
    nav ? nav.platform : '',
    cores,
    scr && Number.isFinite(scr.width) ? String(scr.width) : '',
    scr && Number.isFinite(scr.height) ? String(scr.height) : '',
    scr && Number.isFinite(scr.colorDepth) ? String(scr.colorDepth) : '',
    String(platform.pixelRatioValue()),
    platform.gpuRendererValue() || '',
    tz,
    nav ? nav.language : '',
  ];
  fingerprintCache = parts.join('|');
  return fingerprintCache;
}

/**
 * 当前机器码，base32 24 字符，形制与 Node 版一致（验签与长度校验都按 24 字符）。
 *
 * 由设备特征派生，同型号同配置的机器会得到同一个值——这是浏览器里能做到的
 * 最接近"机器绑定"的语义，边界见文件头注释。
 *
 * @returns {Promise<string>} 机器码
 */
export async function machineId() {
  return codec.digestToB32(hmacSha256Hex(machineSalt, deviceFingerprint()), 24);
}

/**
 * 当前设备码原文（32 位 hex）。
 *
 * 它是客户端随机生成并持久化的标识，用途已**收窄为服务端 KV 的按设备分键**
 * （scopedKey）与 X-JSLB-Device 请求头，不再参与机器码派生——机器码改由设备
 * 特征决定，这样清掉站点数据不会导致已激活的卡失效，且绑定卡在浏览器间可
 * 迁移（只要设备特征不变）。它只是标识，不是密钥。
 *
 * @returns {Promise<string>} 设备码
 */
export async function deviceCode() {
  return deviceId();
}

/**
 * 未激活时的试用权益。
 *
 * 闸门取最低档套餐的定义、预设取配置里的上限，配额取配置里的单文件与次数，
 * 因此试用模式的提示文案（"需 X 或更高套餐"）与正式套餐完全一致，不另造一套。
 *
 * @returns {object} 权益对象，形制与 plan.describe 一致，另带 trial 标记
 */
export function trialEntitlements() {
  const cfg = platform.getWebConfig();
  const lowest = plan.PLAN_NAMES[0];
  return {
    plan: lowest,
    display: t('webTrialPlan'),
    rank: 0,
    preset: cfg.trialPreset,
    trial: true,
    limits: {
      maxFileBytes: cfg.trialMaxFileBytes,
      maxFilesPerRun: 1,
      runsPerDay: cfg.trialRunsPerDay,
      // 试用按日计数，没有一次性总额度这一说
      runsTotal: 0,
    },
    gates: plan.gates(lowest),
  };
}

/**
 * 从存储加载许可证并校验。成功则进入已授权状态。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.selfAnchored] 是否用记录自己的 machine 作锚点，而不是
 *   现场派生的机器码。**服务侧（Worker 闸门）必须传 true**：Worker 里没有
 *   navigator / screen / WebGL，派生出的机器码与浏览器永不相等，否则任何记录
 *   都会判成 machine 不一致（详见 license-core.verifyLicenseData 的说明）。
 *   浏览器与 CLI 省略即可，保持"必须与当前机器一致"的严格语义。
 * @returns {Promise<{ok:boolean, reason?:string}>} 结果
 */
export async function restore(opts) {
  const raw = await storeGet(K_LICENSE);
  if (!raw) return { ok: false, reason: 'missing' };
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: 'corrupt' };
  }
  const selfAnchored = !!(opts && opts.selfAnchored);
  // 自锚定时不派生机器码——派生了也不用，还会白白读一遍 GPU 特征
  const mid = selfAnchored ? null : await machineId();
  const res = licCore.verifyLicenseData(data, mid, publicKey);
  if (!res.ok) return { ok: false, reason: res.reason };
  state = {
    plan: res.plan,
    code: res.code,
    machine: res.machine || mid || data.machine,
    issuedAt: data.issuedAt,
    expiresAt: res.expiresAt,
    usage: res.usage,
    trial: false,
  };
  return { ok: true };
}

/**
 * 用卡密激活当前设备，成功即写入存储并进入已授权状态。
 * @param {string} rawKey 卡密原文
 * @returns {Promise<{ok:boolean, reason?:string, plan?:string, expiresAt?:number}>} 结果
 */
export async function activate(rawKey) {
  const parsed = codec.parseCode(publicKey, String(rawKey == null ? '' : rawKey).trim());
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const mid = await machineId();
  // 到期时间只由卡密里已签名的签发日与天数决定，激活时刻不参与——所以续期
  // 得重新签卡，本地改 issuedAt 没用。issuedAt 仍然记下来，但只是"本机何时
  // 激活"的台账，不参与任何判定。
  const issuedAt = platform.now();
  const expiresAt = licCore.expiryFromIssueDay(parsed);
  const usage = { day: licCore.todayKey(), used: 0 };
  const record = licCore.makeRecord({
    code: parsed.code, plan: parsed.plan, machine: mid, issuedAt, expiresAt, usage,
  }, publicKey);
  const written = await storeSet(K_LICENSE, JSON.stringify(record));
  if (written === false) return { ok: false, reason: 'write' };
  state = {
    plan: parsed.plan, code: parsed.code, machine: mid, issuedAt, expiresAt, usage, trial: false,
  };
  return { ok: true, plan: parsed.plan, expiresAt };
}

/**
 * 读取本地存储里的许可证记录原文。
 *
 * 供客户端把它交给服务端补登记（见 importRecord）。传记录而不是卡密原文，
 * 是因为卡密在激活成功后界面就不再保留——记录里带签名，服务端照样能验。
 *
 * @returns {Promise<object|null>} 记录对象；无授权或内容损坏时为 null
 */
export async function exportRecord() {
  const raw = await storeGet(K_LICENSE);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch (e) {
    return null;
  }
}

/**
 * 采纳一份客户端送来的许可证记录。
 *
 * 场景：界面激活时先本地验签，验过就直接返回了，从没把卡密发给服务端；而
 * 核心模块是按设备 cookie 下发的，服务端 KV 里没有这台设备的记录，模块请求
 * 一律 403。这一步让服务端补上登记。
 *
 * 记录本身带签名且绑定机器码。服务端**没有浏览器指纹**，派不出与客户端一致的
 * 机器码，所以这里采用自锚定校验（verifyLicenseData 传 mid=null）：拿记录自称的
 * machine 作锚点，再验卡密签名、签名绑定段与记录令牌三者是否与它自洽。
 * 客户端因此换不来别人的授权，也改不动套餐与用量（那几项都在令牌载荷里）。
 *
 * @param {object} record 许可证记录
 * @returns {Promise<{ok:boolean, reason?:string, plan?:string}>} 结果
 */
export async function importRecord(record) {
  loadKeysFromEnv();
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, reason: 'corrupt' };
  }
  // 自锚定：服务端派不出浏览器机器码，改用记录自称的 machine 作锚点。
  // 绑定段（Ed25519 签名内）与令牌都会拿它重验，所以伪造的 machine 过不了。
  const res = licCore.verifyLicenseData(record, null, publicKey);
  if (!res.ok) return { ok: false, reason: res.reason };
  const mid = res.machine;
  // 只在服务端本来没有有效记录时才落盘：客户端每刷新一次页面就会推一次记录，
  // 无脑覆盖等于把服务端累计的用量计数清零（/api/obfuscate 在那边扣的配额
  // 会被冲掉，等于白送额度）。服务端那份还有效就留着，客户端只是来补登记的。
  const mine = await exportRecord();
  if (mine) {
    const keep = licCore.verifyLicenseData(mine, null, publicKey);
    if (keep.ok) {
      state = {
        plan: keep.plan, code: keep.code, machine: keep.machine,
        issuedAt: mine.issuedAt, expiresAt: keep.expiresAt, usage: keep.usage, trial: false,
      };
      return { ok: true, plan: keep.plan, adopted: false };
    }
  }
  await storeSet(K_LICENSE, JSON.stringify(record));
  state = {
    plan: res.plan,
    code: res.code,
    machine: mid,
    issuedAt: record.issuedAt,
    expiresAt: res.expiresAt,
    usage: res.usage,
    trial: false,
  };
  return { ok: true, plan: res.plan, adopted: true };
}

/** 清除本地授权与试用计数，回到未激活状态。 */
export async function deactivate() {
  await storeDel(K_LICENSE);
  await storeDel(K_TRIAL_USAGE);
  state = null;
}

/** @returns {boolean} 当前是否已持有有效授权（含试用）。 */
export const isLicensed = () => state !== null && !state.trial;

/** @returns {object|null} 当前授权状态（副本）。 */
export function current() {
  return state ? { ...state, usage: state.usage ? { ...state.usage } : null } : null;
}

/**
 * 确保有可用授权：优先恢复已激活的卡密，否则按策略进入试用。
 *
 * @returns {Promise<{ok:boolean, reason?:string, trial?:boolean}>} 结果；
 *   ok 为假表示必须激活（requireLicense 为真且无有效卡密）
 */
export async function ensure(opts) {
  loadKeysFromEnv();
  const r = await restore(opts);
  if (r.ok) return { ok: true, trial: false };
  const cfg = platform.getWebConfig();
  if (cfg.requireLicense) return { ok: false, reason: r.reason || 'missing' };
  if (!state) {
    state = {
      plan: null,
      code: null,
      machine: await machineId(),
      issuedAt: 0,
      expiresAt: 0,
      usage: null,
      trial: true,
    };
  }
  return { ok: true, trial: true };
}

// 套餐权益与配额。与 Node 版的语义一致：套餐由卡密决定，界面与命令行都改不了。

/** @returns {object|null} 当前权益，未初始化时返回 null。 */
export function entitlements() {
  if (!state) return null;
  if (state.trial) return trialEntitlements();
  const p = plan.describe(state.plan);
  return {
    plan: p.name, display: p.display, rank: p.rank, preset: p.preset, kind: p.kind, note: p.note,
    limits: p.limits, gates: p.gates, trial: false,
  };
}

/** 试用计数（按日）。 */
async function trialUsage() {
  const day = licCore.todayKey();
  const raw = await storeGet(K_TRIAL_USAGE);
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch (e) {
    data = null;
  }
  if (!data || typeof data !== 'object' || data.day !== day || !Number.isSafeInteger(data.used) || data.used < 0) {
    return { day, used: 0 };
  }
  return { day, used: data.used };
}

/**
 * 今日配额快照，不消耗次数。
 * @returns {Promise<{total:number, used:number, left:number}|null>} total 为 0 表示不限
 */
export async function quota() {
  const ent = entitlements();
  if (!ent) return null;
  const total = plan.quotaLimit(ent);
  if (ent.trial) {
    const u = await trialUsage();
    return { total, used: u.used, left: total === 0 ? -1 : Math.max(0, total - u.used) };
  }
  // 额度包按总额度累计，不随日期翻页归零
  const used = plan.isCumulative(ent)
    ? state.usage.used
    // 时钟回拨时沿用记录里更晚的日期，计数只增不减
    : (state.usage.day >= licCore.todayKey() ? state.usage.used : 0);
  return { total, used, left: total === 0 ? -1 : Math.max(0, total - used) };
}

/**
 * 记一次任务用量。已激活时把用量写回签名记录，试用时写试用计数。
 * @returns {Promise<{ok:boolean, reason?:string, used?:number, total?:number}>} 记账结果
 */
export async function consumeRun() {
  const ent = entitlements();
  if (!ent) return { ok: false, reason: 'nolicense' };
  const total = plan.quotaLimit(ent);

  if (ent.trial) {
    const u = await trialUsage();
    const used = u.used + 1;
    if (total > 0 && used > total) return { ok: false, reason: 'quota', used, total };
    await storeSet(K_TRIAL_USAGE, JSON.stringify({ day: u.day, used }));
    return { ok: true, used, total };
  }

  const today = licCore.todayKey();
  // 额度包：usage.day 固定为激活日，used 就是累计次数，隔天不归零。
  // 订阅档：日期翻页则重新计数，时钟回拨时沿用记录里更晚的日期，计数只增不减。
  const cumulative = plan.isCumulative(ent);
  const day = cumulative ? state.usage.day : (state.usage.day >= today ? state.usage.day : today);
  const used = (cumulative || day === state.usage.day ? state.usage.used : 0) + 1;
  if (total > 0 && used > total) return { ok: false, reason: 'quota', used, total };
  const record = licCore.makeRecord({
    code: state.code,
    plan: state.plan,
    machine: state.machine,
    issuedAt: state.issuedAt,
    expiresAt: state.expiresAt,
    usage: { day, used },
  }, publicKey);
  const written = await storeSet(K_LICENSE, JSON.stringify(record));
  if (written === false) return { ok: false, reason: 'write' };
  state.usage = { day, used };
  return { ok: true, used, total };
}

/**
 * 今日用量文案，与 Node 版同一批 i18n 键。
 * @returns {Promise<string>} 本地化文本
 */
export async function quotaText() {
  const ent = entitlements();
  if (!ent) return '';
  const q = await quota();
  const label = ent.trial ? t('webTrialPlan') : plan.displayName(ent.plan);
  if (plan.isCumulative(ent)) {
    return q.total > 0
      ? t('licUsageTotal', { used: q.used, total: q.total, plan: label })
      : t('licUsageTotalUnlimited', { used: q.used, plan: label });
  }
  return q.total > 0
    ? t('licUsageLimited', { used: q.used, total: q.total, plan: label })
    : t('licUsageUnlimited', { used: q.used, plan: label });
}

/**
 * 授权状态横幅文案。
 * @returns {Promise<string>} 本地化文本
 */
export async function bannerText() {
  const ent = entitlements();
  if (!ent) return t('licInvalid', { reason: t('licReason_missing') });
  const mid = await machineId();
  if (ent.trial) return t('webTrialBanner', { machine: mid });
  const label = plan.displayName(ent.plan);
  if (state.expiresAt === codec.PERPETUAL) {
    return t('licOkPerpetual', { machine: mid, plan: label });
  }
  return t('licOkUntil', {
    machine: mid,
    plan: label,
    date: new Date(state.expiresAt).toISOString().slice(0, 10),
  });
}

export default {
  setKeyMaterial,
  loadKeysFromEnv,
  setRequestDeviceId,
  resetRequestState,
  usingExternalKeys,
  machineId,
  deviceCode,
  bindTarget,
  trialEntitlements,
  restore,
  activate,
  exportRecord,
  importRecord,
  deactivate,
  ensure,
  entitlements,
  quota,
  quotaText,
  consumeRun,
  bannerText,
  current,
  isLicensed,
};
