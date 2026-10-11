/**
 * 网页版授权（浏览器与服务端共用）。
 *
 * 与 Node 版的差别只在宿主能力，判定规则完全一致：卡密由同一份 license-codec
 * 解析，许可证记录由同一份 license-core 校验，套餐闸门与配额口径也一致。
 *
 * ## 机器码：硬件特征派生，激活时与卡密永久绑定
 *
 * 机器码由设备硬件特征（平台、CPU 核数、GPU 渲染器、时区、语言，见
 * deviceFingerprint）派生：同一台机器跨会话稳定，不受清站点数据、换浏览器、
 * 隐私模式影响。客户端在激活时把机器码随请求提交，服务端把它写进赎回登记与
 * 卡的机器码绑定——这张卡从此永久绑死在这个机器码上（"一卡一机"）。
 *
 * 为什么激活时提交而不是各端自己派生：v5 卡密不携带绑定段，"这张卡在哪台机器
 * 激活的"唯一凭据是 KV 里的赎回登记。服务端（Worker）没有 navigator / WebGL，
 * 派不出客户端同款的特征值，所以绑定值以客户端提交的为准，服务端负责格式校验
 * 与后续比对：换一台机器再出示同一张卡，提交的机器码对不上赎回登记，即被拒
 * （reason=used）。服务端签发的旧机器码机制（/api/machine）保留：老卡与不带
 * 机器码头的旧客户端仍走原路径，行为不变。
 *
 * 网页自动派发 Free 卡（issueFreeKey）：部署方开启 requireLicense 且本机没有
 * 可用授权时，网页向 /api/free-key 出示本机机器码，服务端按机器码确定性派生
 * 卡号签一张 7 天 Free 卡（卡密字符串因随机 IV 每次不同，但卡号恒定），并写
 * 入"每机器一张"的派发台账。台账丢失（没绑 KV）时重派仍得同一卡号，"一机一卡"
 * 不依赖台账持久；跨机器赎回照旧由赎回登记拦截。Free 卡允许同机重激活：误清
 * 站点数据后同一机器码再输一次即可恢复本地记录（Free 是每日配额，没有总额度
 * 重置风险）；其余卡种保持严格一次性。
 *
 * 离线或纯静态部署（没有同源服务）时退回本机缓存，再退设备特征派生值，并把
 * 结论记进本机缓存，保证刷新前后一致。
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

// 卡密密钥（对称，base64 32 字节）。信息段加密与校验码都用它；它随源码分发，
// 浏览器才能本地验卡——代价是拿到源码的人也能自己造卡，真正的强制在服务端
// （服务端逐请求校验 + 云存储赎回登记，见 license-codec.js
// 的头注释）。部署方想用自己的密钥，用 JSLB_CODE_KEY 覆盖。
const BUNDLED_CODE_KEY = secret.B64_CODE_KEY;

let codeKey = BUNDLED_CODE_KEY;
let machineSalt = b64ToText(secret.B64_MACHINE_SALT);
let keysOverridden = false;

/** 存储键。 */
const K_DEVICE = 'jslabyrinth.device.v1';
const K_LICENSE = 'jslabyrinth.license.v2';
const K_TRIAL_USAGE = 'jslabyrinth.trial-usage.v1';
/** 卡密赎回登记键前缀（按卡密编号分键，全局，不按设备隔离）。 */
const K_REDEEM_PREFIX = 'jslabyrinth.redeem.';
/** 本机最近一次拿到的机器码（离线重放用，保证刷新前后同一个值）。 */
const K_MACHINE = 'jslabyrinth.machine.v2';
/** 机器码绑定键前缀（按卡密编号分键，全局；无 KV 时落到本机存储）。 */
const K_MACHINE_BIND_PREFIX = 'jslabyrinth.machinebind.';
/** 网页自动派发的 Free 卡有效期（天）。 */
const FREE_KEY_DAYS = 7;
/** Free 卡派发台账键前缀（本机存储侧；按机器码分键，全局）。 */
const K_FREE_PREFIX = 'jslabyrinth.freekey.';
/** Free 卡派发台账键前缀（KV 侧；同上，全局不按设备隔离）。 */
const KV_FREE_PREFIX = 'freekey:';
/** Free 卡卡号派生标签：机器码 → 40 bit 卡号，同一机器码恒得同一卡号。 */
const FREE_ID_TAG = 'JSLB/FREEKEY/v1|';

/** 机器码长度：24 字符 base32，与设备特征派生出的旧值同形制。 */
const MACHINE_LEN = 24;
/** KV 里的机器码绑定键前缀（全局，不按设备隔离）。 */
const KV_MACHINE_PREFIX = 'machine:';

/** 设备码内存缓存。 */
let deviceCache = null;

/** 设备特征串内存缓存（派生机器码用，不含随机量）。 */
let fingerprintCache = null;

/** 机器码内存缓存。 */
let machineCache = null;

/** 授权服务地址（浏览器侧由界面注入；空串表示同源）。 */
let apiBase = null;

/** 当前授权状态：null 表示未激活且未进入试用。 */
let state = null;

/** 服务端请求带来的设备码（Worker 逐请求设置）。 */
let requestDeviceId = null;

/**
 * 覆盖公钥与机器盐。部署方用自己的密钥对签卡时用得上。
 * @param {string} codeKeyB64 卡密密钥的 base64（32 字节）
 * @param {string} saltBase64 机器盐的 base64
 */
export function setKeyMaterial(codeKeyB64, saltBase64) {
  if (codeKeyB64) { codeKey = String(codeKeyB64); keysOverridden = true; }
  if (saltBase64) { machineSalt = b64ToText(saltBase64); keysOverridden = true; }
}

/**
 * 从环境变量加载密钥覆盖（JSLB_CODE_KEY / JSLB_MACHINE_SALT，base64）。
 * Worker 入口每次请求调用，未配置时保持内置常量。
 *
 * 这两个都不是秘密：公钥本来就随源码分发。放在环境变量里只是为了支持"不同部署
 * 用不同密钥对"，不是为了藏东西——私钥绝不能出现在这里。
 */
export function loadKeysFromEnv() {
  const k = platform.env('JSLB_CODE_KEY');
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
  machineCache = null;
}

/**
 * 设置授权服务地址（浏览器侧）。
 *
 * 界面允许把 API 指到别的域（自托管、本地联调），机器码是向这个地址要的，
 * 不跟着走就会出现"界面在 A、机器码在 B"。空串即同源。
 *
 * @param {string} base 形如 https://api.example.com，末尾斜杠会被去掉
 */
export function setApiBase(base) {
  apiBase = base == null ? null : String(base).replace(/\/+$/, '');
}

/** @returns {string} 当前授权服务地址（未设置时为空串）。 */
export const getApiBase = () => apiBase || '';

/** @returns {boolean} 是否使用了外部注入的密钥。 */
export const usingExternalKeys = () => keysOverridden;

/**
 * 界面上"机器码"一栏该显示的值。
 *
 * v5 起卡密不再携带绑定段（keygen 的 --bind 已废除），这一栏不再是"报给签发方
 * 去绑卡"的输入，而是这张授权的身份标识：它由服务端签发、与卡密永久绑定，
 * 激活之后不再变化。未激活时给的是本机兜底值（见 machineId 的取值顺序）。
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

/**
 * 查询一张卡密的赎回登记。
 *
 * 键是全局的（不按设备隔离）：防的就是"同一张卡在多台机器上各激活一次"。
 * 服务端绑了 KV 时取全局值，是真正的跨机器强制；浏览器侧无 KV 时退回本地
 * 存储，仅防同一浏览器误用，跨机器的强制由服务端网关承担。
 *
 * 登记值是 JSON 文本 {k: 卡密原文, m: 机器码, t: 赎回时间戳}；旧版本只存
 * 机器码纯文本，这里归一成同一形状，老记录照常拦截（一次性语义不降级）。
 *
 * @param {string} cardId 卡密编号（十进制文本）
 * @returns {Promise<object|null>} 登记记录 {k, m, t}，未赎回时为 null
 */
async function getRedeemer(cardId) {
  let v = null;
  const kv = platform.getKv();
  if (kv && typeof kv.get === 'function') {
    try {
      v = await kv.get('redeem:' + cardId);
    } catch (e) {
      v = null;
    }
  } else {
    v = platform.getStorage().get(K_REDEEM_PREFIX + cardId) || null;
  }
  if (!v) return null;
  if (typeof v === 'string' && v.charAt(0) === '{') {
    try {
      const d = JSON.parse(v);
      if (d && typeof d === 'object') {
        return {
          k: typeof d.k === 'string' ? d.k : '',
          m: typeof d.m === 'string' ? d.m : '',
          t: Number.isFinite(d.t) ? d.t : 0,
        };
      }
    } catch (e) { /* 损坏值落到底下的纯文本归一，宁可错杀也不放行 */ }
  }
  return { k: '', m: String(v), t: 0 };
}

/**
 * 登记一张卡密被某台机器赎回。键全局，跨请求、跨 isolate 持久。
 *
 * 存卡密原文 + 机器码 + 时间戳：卡密原文供发卡方核对"哪张卡"，机器码供核对
 * "哪台机器"，时间戳供审计；发卡方解绑（删 jslb:redeem:<卡号> 键）时三样都要
 * 对上，防止误删别人正在用的卡。
 *
 * @param {string} cardId 卡密编号
 * @param {string} code 卡密原文（归一化后的完整卡密）
 * @param {string} machineId 赎回者机器码
 * @returns {Promise<boolean>} 是否写入成功（KV 故障时为 false）
 */
async function setRedeemer(cardId, code, machineId) {
  const payload = JSON.stringify({
    k: String(code == null ? '' : code),
    m: String(machineId == null ? '' : machineId),
    t: platform.now(),
  });
  const kv = platform.getKv();
  if (kv && typeof kv.put === 'function') {
    try {
      // 必须看返回值：store 的契约是「成功 true / 失败 false」，不抛异常
      // （见 vercel/store.js 的接口注释，Upstash 与 RESP 两条实现都这样）。
      // 只 await 不看返回值的话，Redis 挂掉会返回 false，这里却 return true，
      // 于是 activate 里那道 fail-closed 的 `=== false` 判定永远走不到——
      // 兑换登记形同虚设，而请求照样 200。
      return (await kv.put('redeem:' + cardId, payload)) !== false;
    } catch (e) {
      return false;
    }
  }
  return platform.getStorage().set(K_REDEEM_PREFIX + cardId, payload);
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
 * 只取跨会话稳定且不受显示设置漂移影响的量：平台、CPU 核心数、GPU 渲染器、
 * 时区与语言。刻意不取 UA 全串（同一浏览器版本内会随小版本更新漂移）、不取
 * canvas 噪声（隐私浏览器会加噪，且同一台机器两次可能不同）、也不取任何随机值。
 *
 * 不再纳入屏幕尺寸（CSS 像素）与 devicePixelRatio：它们会随系统显示缩放、
 * 多屏切换、窗口跨屏拖动而变——这是"机器码随意变动"的主因。保留的几项只在
 * 用户显式更改硬件或浏览器配置时才变，不随日常显示操作漂移。
 *
 * 任何一项取不到就用空串占位，位置依然保留——位置是协议的一部分，不能因为
 * 某项缺失就让后面的项前移，否则同一台机器在不同能力环境下会算出不同机器码。
 *
 * 结果不含随机量，所以刷新页面、清站点数据、换隐私模式都不会改变它。
 * 特征算法一变（改动字段集合或其顺序），所有已签发的网页绑定卡都会失效，
 * 改动前务必确认；不绑定卡（默认签发方式）不受影响。
 *
 * @returns {string} 特征串
 */
function deviceFingerprint() {
  if (fingerprintCache) return fingerprintCache;
  const nav = platform.navigatorInfo();
  const cores = nav && Number.isFinite(nav.hardwareConcurrency) ? String(nav.hardwareConcurrency) : '';
  const tz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch (e) {
      return '';
    }
  })();
  const parts = [
    'JSLB-WEB-3',
    nav ? nav.platform : '',
    cores,
    platform.gpuRendererValue() || '',
    tz,
    nav ? nav.language : '',
  ];
  fingerprintCache = parts.join('|');
  return fingerprintCache;
}

/** 设备特征派生的机器码。只作兜底：未激活、且拿不到服务端签发值时才有它出场。 */
function fingerprintMachineId() {
  return codec.digestToB32(hmacSha256Hex(machineSalt, deviceFingerprint()), MACHINE_LEN);
}

/**
 * @param {*} v 待判定的值
 * @returns {boolean} 是否为 24 字符 base32 的机器码
 */
function isMachineCode(v) {
  return typeof v === 'string' && v.length === MACHINE_LEN && codec.isB32Text(v);
}

/**
 * 随机机器码。
 *
 * 字符表正好 32 个字符，随机字节 & 31 之后仍是均匀分布，不需要拒绝采样。
 * @returns {string} 24 字符 base32
 */
function newMachineCode() {
  const bytes = platform.randomBytes(MACHINE_LEN);
  let s = '';
  for (let i = 0; i < MACHINE_LEN; i++) s += codec.ALPHABET[bytes[i] & 31];
  return s;
}

/**
 * 由卡密编号确定性派生机器码。
 *
 * 只在服务端没绑 KV 时用：随机签发的值得有地方存才恒等，没 KV 就存不住
 * （每个 isolate 的内存都是干净的），这时改用"卡号 → 机器码"的确定性映射，
 * 同一张卡在任何 isolate、任何时间都算出同一个值。
 *
 * HMAC 的密钥取固定常量而不是机器盐：部署方覆盖 JSLB_MACHINE_SALT 时不该把
 * 已激活卡的机器码换成另一个。
 *
 * @param {string} cardId 卡密编号（十进制文本）
 * @returns {string} 24 字符 base32
 */
function deriveMachineCode(cardId) {
  return codec.digestToB32(hmacSha256Hex('JSLB/MACHINE/v1', 'JSLB-MACHINE-1|' + cardId), MACHINE_LEN);
}

/** 读取某张卡已登记的机器码；没有或已损坏时返回 null。 */
async function getMachineBinding(cardId) {
  const kv = platform.getKv();
  if (kv && typeof kv.get === 'function') {
    try {
      const v = await kv.get(KV_MACHINE_PREFIX + cardId);
      return isMachineCode(v) ? v : null;
    } catch (e) {
      return null;
    }
  }
  const v = platform.getStorage().get(K_MACHINE_BIND_PREFIX + cardId);
  return isMachineCode(v) ? v : null;
}

/** 登记某张卡的机器码。 */
async function setMachineBinding(cardId, mid) {
  const kv = platform.getKv();
  if (kv && typeof kv.put === 'function') {
    try {
      await kv.put(KV_MACHINE_PREFIX + cardId, mid);
      return true;
    } catch (e) {
      return false;
    }
  }
  return platform.getStorage().set(K_MACHINE_BIND_PREFIX + cardId, mid);
}

/**
 * 把机器码与卡密永久绑定（先写者为准，绝不覆盖）。
 *
 * 第一次成功激活留下的那个码就是这张卡的身份，之后谁再来都不改——允许覆盖就
 * 等于让机器码随最后一次激活漂移，"永久绑定"名存实亡。
 */
async function bindMachineToCard(cardId, mid) {
  if (!isMachineCode(mid)) return;
  const cur = await getMachineBinding(cardId);
  if (cur) return;
  await setMachineBinding(cardId, mid);
}

/**
 * 向服务端要这张卡的机器码（只有浏览器走这条路）。
 *
 * 服务端是权威：绑定关系存在它的 KV 里，浏览器自己怎么算都只是一家之言。
 * 拿不到（离线、纯静态部署、跨域被拦）返回 null，由调用方落到本地兜底。
 *
 * @param {string} code 归一化后的卡密原文
 * @returns {Promise<string|null>} 机器码
 */
async function requestRemoteMachine(code) {
  // Worker 自己就是服务端，不能回头请求自己；Node 侧默认也没有服务可问。
  // 只有浏览器（或显式指定了服务地址）才走网络。
  if (!platform.isBrowser && apiBase === null) return null;
  const f = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
  if (!f) return null;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), 4000) : null;
  try {
    const res = await f((apiBase || '') + '/api/machine', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: code }),
      ...(ctl ? { signal: ctl.signal } : {}),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.ok && isMachineCode(data.machine)) return data.machine;
  } catch (e) {
    // 离线或被拦：落到本地兜底，不阻断激活
  } finally {
    if (timer) clearTimeout(timer);
  }
  return null;
}

/**
 * 取某张卡密绑定的机器码，没有就签发一个并永久登记。
 *
 * 这是"同一张卡永远同一个机器码"的唯一保证，四个来源按优先级：
 *   ① 已登记的绑定（服务端 KV，或本机缓存的上次结果）
 *   ② 服务端答复（浏览器在线时以服务端为准）
 *   ③ 赎回登记里记的机器码（绑定键被清掉、或升级前的历史记录）
 *   ④ 新签发：绑了 KV 就随机生成并登记；没绑 KV 就按卡号确定性派生
 *
 * 卡密非法时直接拒绝：机器码绑在卡上，认不出卡就无从绑定。
 *
 * @param {string} rawKey 卡密原文
 * @returns {Promise<{ok:boolean, reason?:string, machine?:string, issued?:boolean, source?:string}>} 结果
 */
export async function machineForCode(rawKey) {
  const parsed = codec.parseCode(codeKey, String(rawKey == null ? '' : rawKey).trim());
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const cardId = parsed.id;
  const bound = await getMachineBinding(cardId);
  if (bound) return { ok: true, machine: bound, issued: false, source: 'binding' };
  const remote = await requestRemoteMachine(parsed.code);
  if (remote) {
    await setMachineBinding(cardId, remote);
    return { ok: true, machine: remote, issued: false, source: 'server' };
  }
  const redeemer = await getRedeemer(cardId);
  if (redeemer && isMachineCode(redeemer.m)) {
    await setMachineBinding(cardId, redeemer.m);
    return { ok: true, machine: redeemer.m, issued: false, source: 'redeem' };
  }
  return allocateMachineCode(cardId);
}

/**
 * 签发一个新机器码并登记。
 *
 * 绑了 KV 才用随机值——随机必须有地方持久化才恒等；写 KV 失败时同样落回确定
 * 性派生：宁可少一点随机性，也不能让同一张卡两次拿到不同的码。
 *
 * @param {string} cardId 卡密编号
 * @returns {Promise<{ok:boolean, machine:string, issued:boolean, source:string}>} 结果
 */
async function allocateMachineCode(cardId) {
  const kv = platform.getKv();
  if (kv && typeof kv.put === 'function') {
    const m = newMachineCode();
    try {
      // 同 setRedeemer：写失败是「返回 false」而不是抛异常，所以必须看返回值。
      // 漏看的话会拿一个根本没存下来的随机码当"已永久签发"返回，下次调用又换一个
      // ——恰好违反这里要保证的恒等。
      if ((await kv.put(KV_MACHINE_PREFIX + cardId, m)) !== false) {
        return { ok: true, machine: m, issued: true, source: 'issued' };
      }
    } catch (e) {
      // KV 写不进去：落到下面的派生，保证恒等
    }
  }
  const derived = deriveMachineCode(cardId);
  await setMachineBinding(cardId, derived);
  return { ok: true, machine: derived, issued: true, source: 'derived' };
}

// ---------------------------------------------------------------- 网页自动派发 Free 卡
//
// 部署方开启 requireLicense 后，未激活的机器什么都干不了。这条通道让网页按
// "一台机器一张"自动领 7 天 Free 卡：反刷卡密（一人刷出一堆卡分发）靠三道
// 闸门——① 派发台账按机器码分键，同机重取回放原卡不新发；② 卡号由机器码
// 确定性派生，台账丢了也刷不出第二个卡号；③ 跨机器赎回被赎回登记拒绝。

/** 读取某机器码的 Free 卡派发台账；没有或损坏时返回 null。 */
async function getFreeKeyLedger(machine) {
  const kv = platform.getKv();
  let v = null;
  if (kv && typeof kv.get === 'function') {
    try {
      v = await kv.get(KV_FREE_PREFIX + machine);
    } catch (e) {
      v = null;
    }
  } else {
    v = platform.getStorage().get(K_FREE_PREFIX + machine) || null;
  }
  if (!v || typeof v !== 'string' || v.charAt(0) !== '{') return null;
  try {
    const d = JSON.parse(v);
    // 台账形状与赎回登记一致：k 卡密原文、m 机器码、t 时间戳
    if (d && typeof d === 'object' && typeof d.k === 'string' && d.k) {
      return {
        code: d.k,
        m: typeof d.m === 'string' ? d.m : '',
        t: Number.isFinite(d.t) ? d.t : 0,
      };
    }
  } catch (e) {
    // 损坏值按没有处理：卡号是确定性派生，重签不影响"一机一卡"
  }
  return null;
}

/** 登记某机器码派发的 Free 卡。台账只为回放同一卡密串，写失败不影响本次返回。 */
async function setFreeKeyLedger(machine, code) {
  const payload = JSON.stringify({ k: String(code == null ? '' : code), m: String(machine), t: platform.now() });
  const kv = platform.getKv();
  if (kv && typeof kv.put === 'function') {
    try {
      await kv.put(KV_FREE_PREFIX + machine, payload);
      return true;
    } catch (e) {
      return false;
    }
  }
  return platform.getStorage().set(K_FREE_PREFIX + machine, payload);
}

/**
 * 按机器码签发一张 Free 套餐卡（网页自动派发用）。
 *
 * 卡号（40 bit 编号）由机器码 HMAC 确定性派生：同一机器码永远得到同一卡号，
 * 卡密字符串因信息段的随机 IV 每次不同，但赎回登记按卡号分键——所以即便派发
 * 台账丢了，"再派一张"也还是同一张卡，"一机一卡"不依赖台账持久；不同机器码
 * 派生不同卡号，卡密无法跨机共用。跨机赎回仍由赎回登记拦截（reason=used）。
 *
 * 有效期与套餐写死 free / 7 天（FREE_KEY_DAYS）：这是匿名机器的自服务通道，
 * 部署方不该在这上面谈套餐。未绑 KV 时台账落在单实例内存里、同实例内重取
 * 恒等，跨实例可能各签一次字符串——但卡号相同，赎回登记（若绑了 KV）照旧
 * 只认一次。
 *
 * ## 到期后续期
 *
 * 台账里那张卡满 7 天后必须重签一张新的，否则这台机器被永久锁死：台账回放的仍是
 * 那张过期卡，客户端 activate 判 reason=expired，而卡号是机器码确定性派生的、重签
 * 也只能拿到同一个卡号——原先的写法在这里恰好也是死路。到期后重签签发日更新，卡号
 * 不变，于是"一机一卡"仍成立（同一张卡号上的新一段有效期），赎回登记也不用重写
 * （Free 卡同机可重复激活，见 activate 的 redeemer 判定）。
 *
 * @param {string} machine 机器码，24 字符 base32（客户端硬件特征派生值）
 * @returns {Promise<{ok:boolean, reason?:string, code?:string, machine?:string, issued?:boolean, source?:string}>} 结果
 */
export async function issueFreeKey(machine) {
  const m = String(machine == null ? '' : machine).trim().toUpperCase();
  if (!isMachineCode(m)) return { ok: false, reason: 'machine' };
  const led = await getFreeKeyLedger(m);
  if (led) {
    const p = codec.parseCode(codeKey, led.code);
    // 过期（含解析不出）就不回放：回放一张用完的卡等于把这条通道关掉
    if (p.ok && p.plan === 'free' && p.days === FREE_KEY_DAYS
      && licCore.expiryFromIssueDay(p) > platform.now()) {
      return { ok: true, code: led.code, machine: m, issued: false, source: 'ledger' };
    }
  }
  const h = hmacSha256Hex(FREE_ID_TAG, m);
  const id = Number(BigInt('0x' + h.slice(0, 10)) & codec.MAX_ID);
  // 卡号恒定、签发日取今天：到期后续期得到同一卡号的一段新有效期
  const code = codec.issueCode(codeKey, 'free', FREE_KEY_DAYS, id);
  if (!code) return { ok: false, reason: 'issue' };
  await setFreeKeyLedger(m, code);
  return { ok: true, code, machine: m, issued: true, source: 'issued' };
}

/** 记下本机当前机器码：离线刷新也要保持同一个值，不能退回设备特征去。 */
async function rememberMachine(mid) {
  if (!isMachineCode(mid)) return;
  machineCache = mid;
  await storeSet(K_MACHINE, mid);
}

/**
 * 当前机器码，24 字符 base32，形制与旧的设备特征值一致（长度校验按 24 字符）。
 *
 * 取值优先级：
 *   ① 已激活许可证上那个——服务端签发，恒定不变
 *   ② 给了卡密 → 这张卡绑定的机器码（首次由服务端随机签发并永久登记）
 *   ③ 本机上次拿到的（离线重放，保证刷新前后一致）
 *   ④ 设备特征派生（未激活且拿不到服务端时的展示值）
 *
 * ①是"激活前后界面显示同一个机器码"的关键：服务端验过记录后 state.machine 就是
 * 记录里那个码，Worker 不会再拿自己的环境去派生一个对不上的值。
 *
 * @param {object} [opts]
 * @param {string} [opts.code] 卡密原文；给了就按这张卡取绑定的机器码
 * @returns {Promise<string>} 机器码
 */
export async function machineId(opts) {
  if (state && !state.trial && isMachineCode(state.machine)) return state.machine;
  const o = opts || {};
  if (o.code) {
    const r = await machineForCode(o.code);
    if (r.ok) {
      await rememberMachine(r.machine);
      return r.machine;
    }
  }
  if (machineCache) return machineCache;
  const cached = await storeGet(K_MACHINE);
  if (isMachineCode(cached)) {
    machineCache = cached;
    return cached;
  }
  return fingerprintMachineId();
}

/**
 * 当前设备码原文（32 位 hex）。
 *
 * 它是客户端随机生成并持久化的标识，用途已收窄为服务端 KV 的按设备分键
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
 *   现场派生的机器码。服务侧（Worker 闸门）必须传 true：Worker 里没有
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
  const res = licCore.verifyLicenseData(data, mid, codeKey);
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
 * @param {object} [opts]
 * @param {string} [opts.machine] 客户端提交的机器码（硬件特征派生值，网页流程必带）。
 *   合法时直接作为绑定值：赎回登记与卡的机器码绑定都写它，这张卡从此永久属于
 *   这台机器。不传时取这张卡的绑定机器码（服务端签发机制，旧客户端/老卡路径）。
 * @returns {Promise<{ok:boolean, reason?:string, plan?:string, expiresAt?:number}>} 结果
 */
export async function activate(rawKey, opts) {
  const parsed = codec.parseCode(codeKey, String(rawKey == null ? '' : rawKey).trim());
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  // 机器码：客户端提交了就原样用（见文件头"机器码"一节——服务端派不出客户端
  // 同款的特征值，绑定值以提交为准）；否则按这张卡取（服务端签发/绑定机制）。
  const o = opts || {};
  const mid = isMachineCode(o.machine)
    ? String(o.machine).trim().toUpperCase()
    : await machineId({ code: parsed.code });
  // 机器绑定必须在激活这一刻就判定，不能留给 restore：激活成功立即获得完整
  // 权益（本次会话直接可用；Worker 按卡密激活的 API 请求更是每次都要走这里），
  // 等下次 restore 才以 reason:'bind' 拒绝，等于换机的绑定卡已经白用了一整轮。
  // matchesMachine 对不绑定的卡（绑定段全 0）恒真，语义与 verifyLicenseData 一致。
  if (!codec.matchesMachine(parsed.bindSeg, mid)) return { ok: false, reason: 'bind' };
  const issuedAt = platform.now();
  const expiresAt = licCore.expiryFromIssueDay(parsed);
  // 到期时间同样是激活这一刻就判定的硬上限，不能留给 restore：过期卡若能在
  // activate 里换到完整权益，Worker 按卡密激活的 API 请求每次重放都绕过过期检查。
  if (expiresAt !== codec.PERPETUAL && platform.now() > expiresAt) {
    return { ok: false, reason: 'expired' };
  }
  // 防重复使用：每张卡密只能激活一次（严格一次性）。赎回登记一旦存在，另一台
  // 机器再出示这张卡一律拒绝（reason=used）。旧版允许同机重复激活并把用量重置
  // 为 0——Pack 卡同机用完额度后再输一次就白得新额度，等于无限续杯，这条口子
  // 对非 Free 卡保持封死。用户误清数据后需重激活非 Free 卡的，由发卡方删除 KV
  // 里的 jslb:redeem:<卡号> 键解绑（登记里带卡密原文与机器码，核对无误再删）。
  //
  // 例外，Free 卡同机恢复：网页自动派发的 Free 卡绑在机器硬件机器码上，误清
  // 站点数据（本地记录没了）后同一机器码再激活一次即重建记录。Free 只有每日
  // 配额（无一次性总额度），不存在"重置额度"风险；跨机器出示仍被上面的判定拒绝。
  const redeemer = await getRedeemer(parsed.id);
  if (redeemer) {
    const same = isMachineCode(redeemer.m) && codec.timingSafeEqualText(redeemer.m, mid);
    if (!(parsed.plan === 'free' && same)) {
      return { ok: false, reason: 'used' };
    }
  } else if (await setRedeemer(parsed.id, parsed.code, mid) === false) {
    // 登记写不进去就不放行：否则这张卡等于从未赎回，换台机器还能再激活一次
    return { ok: false, reason: 'write' };
  }
  // 赎回即绑定：这张卡的机器码从此固定为 mid，先写者为准
  await bindMachineToCard(parsed.id, mid);
  const usage = { day: licCore.todayKey(), used: 0 };
  // 到期时间只由卡密里已签名的签发日与天数决定，激活时刻不参与——续期得重新
  // 签卡，本地改 issuedAt 没用。issuedAt 仍记下来，但只是"本机何时激活"的台账。
  const record = licCore.makeRecord({
    code: parsed.code, plan: parsed.plan, machine: mid, issuedAt, expiresAt, usage,
  }, codeKey);
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
 * 换卡时把服务端已计入的次数带进新记录。
 *
 * 采纳新卡必须重签记录（用量进令牌载荷，见 license-core.makeRecord 的说明），
 * 重签就意味着有机会把计数归零。归零等于白送额度：额度包用掉 99 次后换一张
 * 卡就又是 100 次。所以这里取"服务端那份"与"客户端那份"的较大值。
 *
 * 按日口径下换卡不该把昨天的次数拖到今天：存储里的 day 早于今天就说明那份
 * 记录已经翻页归零，此时用客户端带来的新值。额度包是累计口径，day 只是个
 * 台账日期，跨日不清零，所以一律带过去。
 *
 * @param {{day:string, used:number}|null} stored 服务端那份记录的用量
 * @param {{day:string, used:number}} fresh 客户端呈上的记录里的用量
 * @param {string} planName 新记录的套餐
 * @returns {{day:string, used:number}} 落盘的用量
 */
function carriedUsage(stored, fresh, planName) {
  if (!stored || !Number.isSafeInteger(stored.used) || stored.used <= 0) return fresh;
  const cumulative = plan.limits(planName).runsTotal > 0;
  if (!cumulative && stored.day < licCore.todayKey()) return fresh;
  return { day: fresh.day, used: Math.max(stored.used, fresh.used) };
}

/**
 * 采纳一份客户端送来的许可证记录。
 *
 * 场景：界面激活时先本地验签，验过就直接返回了，从没把卡密发给服务端；而
 * 核心模块是按设备 cookie 下发的，服务端 KV 里没有这台设备的记录，模块请求
 * 一律 403。这一步让服务端补上登记。
 *
 * 记录本身带签名且绑定机器码。服务端没有浏览器指纹，派不出与客户端一致的
 * 机器码，所以这里采用自锚定校验（verifyLicenseData 传 mid=null）：拿记录自称的
 * machine 作锚点，再验卡密签名、签名绑定段与记录令牌三者是否与它自洽。
 * 客户端因此换不来别人的授权，也改不动套餐与用量（那几项都在令牌载荷里）。
 *
 * ## 换卡：只升不降，且不因换卡抹掉用量
 *
 * 服务端已有有效记录时，只有呈上的卡**严格更高档**才替换它，其余一律沿用服务端
 * 那份。这条规则有两个方向，缺一不可：
 *   · 升级要放行 —— 网页自动派发的 Free 卡（requireLicense 部署下首访即发生）
 *     会先在服务端落一份 Free 记录；用户随后买 Plus，界面本地验签通过、pushLicense
 *     也成功，可服务端因为"已有有效记录就沿用"而永远停在 Free。cloudOnly 部署下
 *     每次运行都过服务端闸门，于是用户明明激活了 Plus，跑 medium 却被判
 *     「预设 medium 超出套餐 Free 的强度上限 low」——额度买了却用不上。
 *   · 降级要拦住 —— 反过来无条件覆盖的话，一份 Free 记录能把服务端的 Plus 顶掉。
 *     客户端能出示的记录都是自己验过签的，但"手上的卡是昨天那张"完全正常，
 *     不该因此丢掉更高档的权益。
 * 套餐 rank 相等（换了一张同档卡）按沿用处理：不覆盖，也就不会重置计数。
 *
 * ## 记录的可搬运性由请求侧的机器码兜底
 *
 * 自锚定校验只能证明"这份记录自称的 machine 与其自身自洽"，证不了"呈上记录的
 * 就是这台机器"——记录连同 machine 字段可以整体复制到另一台机器上。所以当调用方
 * 传入了本机机器码（Worker 从 X-JSLB-Machine 取，见 server/handler.js）时，它才是
 * 真正的判据：记录自称的 machine 必须与它一致，否则这份记录是从别处搬来的。
 *
 * 这条不能省：redeem 登记里记的也是"记录自称的 machine"，搬运者会把记录一起搬过去，
 * 于是登记比对同样通过——2026-10-03 实测，A 机的 pack100 记录复制到 B 机即可顶用。
 * 赎回登记的"本机"必须锚在请求侧那个码上。
 *
 * 老客户端不带这个头时没有可比对象，此时只做自锚定（与改动前的强度一致）。
 *
 * @param {object} record 许可证记录
 * @param {object} [opts]
 * @param {string} [opts.machine] 本次请求方自报的机器码（X-JSLB-Machine）
 * @returns {Promise<{ok:boolean, reason?:string, plan?:string, adopted?:boolean}>} 结果
 */
export async function importRecord(record, opts) {
  loadKeysFromEnv();
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, reason: 'corrupt' };
  }
  // 自锚定：服务端派不出浏览器机器码，改用记录自称的 machine 作锚点。
  // 校验码与令牌都会拿它重验，所以伪造的 machine 过不了。
  const res = licCore.verifyLicenseData(record, null, codeKey);
  if (!res.ok) return { ok: false, reason: res.reason };
  const mid = res.machine;
  // 请求侧机器码才是"这份记录属于本机"的判据（见文件头"记录的可搬运性"一节）
  const reqMid = opts && isMachineCode(opts.machine)
    ? String(opts.machine).trim().toUpperCase()
    : '';
  if (reqMid && !codec.timingSafeEqualText(mid, reqMid)) {
    return { ok: false, reason: 'machine' };
  }
  // 服务端已有的有效记录（含已过期的那份：过期会让 verifyLicenseData 判 expired，
  // 恰好使下面走采纳路径，Free 卡到期后重领才能恢复）。
  const mine = await exportRecord();
  const keep = mine ? licCore.verifyLicenseData(mine, null, codeKey) : { ok: false };
  // 已有更高档（或同档）的有效记录 → 沿用它。客户端每刷新一次页面就会推一次记录，
  // 无脑覆盖等于把服务端累计的用量计数清零（/api/obfuscate 在那边扣的配额会被冲掉）。
  if (keep.ok && plan.rank(res.plan) <= plan.rank(keep.plan)) {
    state = {
      plan: keep.plan, code: keep.code, machine: keep.machine,
      issuedAt: mine.issuedAt, expiresAt: keep.expiresAt, usage: keep.usage, trial: false,
    };
    return { ok: true, plan: keep.plan, adopted: false };
  }
  // 防重复使用（服务端补登记路径）：登记里已有这台机器，就是本机自己赎回过的那张，
  // 放行（误清站点数据、或反复 pushLicense 都会走到这里）；登记在别的机器上，
  // 说明这份记录是搬过来的，拒绝采纳。
  const parsedRec = codec.parseCode(codeKey, record.code);
  if (parsedRec.ok) {
    const redeemer = await getRedeemer(parsedRec.id);
    if (redeemer) {
      const same = isMachineCode(redeemer.m) && codec.timingSafeEqualText(redeemer.m, mid);
      if (!same) return { ok: false, reason: 'used' };
    } else if (await setRedeemer(parsedRec.id, parsedRec.code, mid) === false) {
      return { ok: false, reason: 'write' };
    }
    // 补登记同样固定机器码：客户端那份记录里的码就是这张卡此后恒定的身份
    await bindMachineToCard(parsedRec.id, mid);
  }
  // 换卡要重签（用量进令牌载荷），并把服务端已计入的次数带过去，见 carriedUsage。
  const usage = carriedUsage(keep.ok ? keep.usage : null, res.usage, res.plan);
  const adopted = usage === res.usage ? record : licCore.makeRecord({
    code: res.code, plan: res.plan, machine: mid,
    issuedAt: record.issuedAt, expiresAt: res.expiresAt, usage,
  }, codeKey);
  await storeSet(K_LICENSE, JSON.stringify(adopted));
  state = {
    plan: res.plan,
    code: res.code,
    machine: mid,
    issuedAt: record.issuedAt,
    expiresAt: res.expiresAt,
    usage,
    trial: false,
  };
  return { ok: true, plan: res.plan, adopted: true };
}

/**
 * 复用的存储记录是否与出示的卡密是同一张卡。
 *
 * 用途见 server/handler.js handleObfuscate：无设备头时所有请求共用同一存储键，
 * 暖实例上 restore() 会读到别的租户的记录。不校验就直接复用等于跨租户提权——
 * Free 卡的请求会顶着别人的 pack100 权益把闸门全绕过（2026-10-01 线上实测）。
 *
 * 比的是卡密编号（id）而不是套餐：同一设备先后用两张卡，以 presented 为准；
 * 不同卡即使同套餐也不得共用记录（一卡一机按卡登记）。
 * 两边都用 codeKey 重验签名，伪造的记录过不了 parseCode。
 *
 * @param {string} rawKey 出示的卡密原文
 * @returns {Promise<boolean>} 同一张卡时 true；无记录、记录损坏、卡密非法、
 *   不是同一张卡时一律 false（调用方回落到 activate，由它报 401 原因）
 */
export async function restoredMatchesKey(rawKey) {
  const rec = await exportRecord();
  if (!rec || typeof rec.code !== 'string') return false;
  const a = codec.parseCode(codeKey, String(rawKey == null ? '' : rawKey).trim());
  if (!a.ok) return false;
  const b = codec.parseCode(codeKey, String(rec.code).trim());
  if (!b.ok) return false;
  return String(a.id) === String(b.id) && a.plan === b.plan;
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
  // trialOnly：无卡密、无记录的请求只能是试用——绝不能复用存储里的他人记录。
  //
  // 背景（裸键串扰，2026-10-01 线上实测确认）：存储键按请求设备码隔离
  // （scopedKey），无设备头时回落到裸键。暖实例上 restore() 会读到别的租户
  // 激活过的记录（实测：匿名请求拿到了 pack100 权益，闸门全被绕过）。
  // 调用方在呈现了有效凭据（卡密走 activate，记录走 importRecord）时传 false；
  // 既无卡密又无记录时传 true。
  const trialOnly = !!(opts && opts.trialOnly);
  let reason = 'missing';
  if (!trialOnly) {
    const r = await restore(opts);
    if (r.ok) return { ok: true, trial: false };
    reason = r.reason || 'missing';
  }
  const cfg = platform.getWebConfig();
  if (cfg.requireLicense) return { ok: false, reason };
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
  }, codeKey);
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

/**
 * 当前生效的卡密密钥（base64）。
 *
 * 给**服务端签发**用（购买订单确认后签发卡密，见 src/orders.js）：签发与校验必须
 * 同源，否则签出来的卡在浏览器端一律解析失败。这里导出的是"当前生效的那把"，
 * 而不是让调用方各自去读 JSLB_CODE_KEY——两处各判一遍，迟早漂移成
 * "订单签发的卡客服端不认"这种最难查的不一致。
 *
 * 不是秘密：这把对称密钥本来就随静态资源分发（见文件头说明）。
 *
 * @returns {string} 卡密密钥的 base64
 */
export function activeCodeKey() {
  return codeKey;
}

export default {
  setKeyMaterial,
  loadKeysFromEnv,
  activeCodeKey,
  setRequestDeviceId,
  resetRequestState,
  usingExternalKeys,
  setApiBase,
  getApiBase,
  machineId,
  machineForCode,
  issueFreeKey,
  FREE_KEY_DAYS,
  deviceCode,
  bindTarget,
  trialEntitlements,
  restore,
  activate,
  exportRecord,
  importRecord,
  restoredMatchesKey,
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
