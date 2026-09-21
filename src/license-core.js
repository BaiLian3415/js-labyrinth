/**
 * 许可证数据结构的校验与拼装，三端共用。
 *
 * 这里只做"给定机器码与公钥，这份许可证是否自洽"的纯判定，不碰文件、
 * 不碰存储、不碰反调试。Node 侧（license-node.js）把它落在 license.lic 上，
 * 网页侧（license-web.js）把它落在 localStorage / KV 上，两边判定的是同一套
 * 规则，卡密在哪一端激活都得到同样的结论。
 *
 * 到期时间、套餐与用量都不直接采信存储里的字段，而是由卡密还原后比对：
 * 单独改 expiresAt、plan 或 usage 都过不了令牌验签。到期时间更进一步——它由
 * **卡密里已签名的签发日**推出，连重新签令牌都改不动。
 *
 * 机器绑定同样以卡密为准：卡密里带一段机器码的派生摘要（绑定段，见
 * license-codec.bindDigest），且它在签名载荷内，所以"这台机器能不能用这张卡"
 * 是签发时就定死的，本地改不了。不绑定的卡绑定段全 0，任何机器都能用。
 */
import codec from './license-codec.js';
import platform from './platform.js';

/** 许可证数据格式版本。套餐与用量字段自 2 起存在，1 的旧数据一律要求重新激活。 */
export const LIC_FORMAT = 2;

/**
 * 当日日期键，YYYY-MM-DD，按本机时区。
 *
 * 配额按自然日切换，用本地时区而不是 UTC，跨时区用户的"今天"才和自己的作息
 * 一致。字符串按 ISO 形式拼接，字典序即时间序，可安全地直接比较。
 *
 * @returns {string} 当日日期键
 */
export function todayKey() {
  const d = new Date(platform.now());
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/**
 * 校验用量字段的形状。
 * @param {object} u 许可证里的 usage 字段
 * @returns {{ok:boolean, day?:string, used?:number}} 校验结果
 */
export function readUsage(u) {
  if (u === null || typeof u !== 'object' || Array.isArray(u)) return { ok: false };
  if (typeof u.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(u.day)) return { ok: false };
  if (!Number.isSafeInteger(u.used) || u.used < 0) return { ok: false };
  return { ok: true, day: u.day, used: u.used };
}

/**
 * 校验许可证内容是否与当前机器、当前时间、公钥自洽。
 *
 * 机器绑定分两层，缺一不可：
 *  ① 卡密里的**绑定段**必须是这台机器的机器码派生摘要（见 codec.matchesMachine）。
 *     绑定段在 Ed25519 签名载荷里，改不了；所以拿别人的卡密到这机器上激活一定
 *     失败，且**无需等待令牌校验**就能判出来。
 *  ② 记录里的 machine 字段必须等于当前机器码，令牌也必须与它自洽——这层防的是
 *     "本地记录被搬到另一台机器"。令牌密钥是公开的，所以这层只防搬运，不防
 *     有源码的人重签自己的记录；真正的边界是①。
 *
 * @param {object} data 许可证内容
 * @param {string} mid 当前机器码（Node 为硬件指纹派生，网页为设备特征派生）
 * @param {string} publicKeyB64 签发公钥 base64
 * @returns {{ok:boolean, reason?:string, expiresAt?:number, plan?:string, code?:string, usage?:object}}
 */
export function verifyLicenseData(data, mid, publicKeyB64) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'corrupt' };
  if (data.v !== LIC_FORMAT) return { ok: false, reason: 'version' };
  if (typeof data.code !== 'string' || typeof data.token !== 'string') return { ok: false, reason: 'corrupt' };
  if (typeof data.machine !== 'string' || data.machine.length !== 24) return { ok: false, reason: 'corrupt' };

  const parsed = codec.parseCode(publicKeyB64, data.code);
  if (!parsed.ok) return { ok: false, reason: 'code' };

  // 卡密绑定的机器与当前机器是否一致。不绑定的卡（绑定段全 0）这一步恒真。
  if (!codec.matchesMachine(parsed.bindSeg, mid)) return { ok: false, reason: 'bind' };

  // 套餐以卡密为准，存储里的 plan 只用来发现不一致
  if (data.plan !== parsed.plan) return { ok: false, reason: 'planmismatch' };

  if (data.machine !== mid) return { ok: false, reason: 'machine' };

  // 到期时间由**卡密里已签名的签发日**与天数推出，不采信记录里的 issuedAt 或
  // expiresAt。这两项在存储里是明文，改一下就能把自己的许可证无限续期；而
  // 签发日在卡密签名载荷里，改不动。
  const expected = expiryFromIssueDay(parsed);
  if (data.expiresAt !== expected) return { ok: false, reason: 'expirymismatch' };

  const usage = readUsage(data.usage);
  if (!usage.ok) return { ok: false, reason: 'corrupt' };
  if (!codec.verifyToken(publicKeyB64, data.token, mid, data.expiresAt, usage.day, usage.used)) {
    return { ok: false, reason: 'token' };
  }
  if (data.expiresAt !== codec.PERPETUAL && platform.now() > data.expiresAt) {
    return { ok: false, reason: 'expired', expiresAt: data.expiresAt };
  }
  return {
    ok: true,
    expiresAt: data.expiresAt,
    plan: parsed.plan,
    code: parsed.code,
    usage: { day: usage.day, used: usage.used },
  };
}

/**
 * 拼装一份待落盘/落存储的许可证记录。
 *
 * 到期时间与用量两项都进令牌签名载荷，改存储里的任何一项都过不了验签，
 * 因此每次配额递增都要整份重写，不能只改 usage 字段。
 *
 * 注意这个令牌用的是**派生自公钥的对称密钥**，不需要签发私钥——用量每次递增
 * 都要重签，而那时只有用户本机。它的作用是留下篡改痕迹，不是安全边界；
 * 真正的防伪造在卡密那层（Ed25519，私钥在签发方）。
 *
 * @param {{code:string, plan:string, machine:string, issuedAt:number, expiresAt:number, usage:{day:string,used:number}}} lic 授权内容
 * @param {string} publicKeyB64 签发公钥 base64
 * @returns {object} 可直接序列化的记录
 */
export function makeRecord(lic, publicKeyB64) {
  return {
    v: LIC_FORMAT,
    code: lic.code,
    plan: lic.plan,
    machine: lic.machine,
    issuedAt: lic.issuedAt,
    expiresAt: lic.expiresAt,
    usage: { day: lic.usage.day, used: lic.usage.used },
    token: codec.makeToken(publicKeyB64, lic.machine, lic.expiresAt, lic.usage.day, lic.usage.used),
  };
}

/**
 * 由卡密的签发日与天数算出到期时间。
 *
 * 签发日来自卡密签名载荷，因此结果不可伪造。永久卡返回 0。
 *
 * @param {object} parsed codec.parseCode 的结果
 * @returns {number} 到期时间戳，0 表示永久
 */
export function expiryFromIssueDay(parsed) {
  if (parsed.days === codec.PERPETUAL) return codec.PERPETUAL;
  return codec.DAY_ZERO + (parsed.issueDay + parsed.days) * 86400000;
}

export default {
  LIC_FORMAT, todayKey, readUsage, verifyLicenseData, makeRecord, expiryFromIssueDay,
};
