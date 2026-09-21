/**
 * 卡密与许可证令牌的编解码原语，纯函数，无副作用。
 *
 * 这里有**两套不同性质的签名**，别混为一谈：
 *
 * 1. **卡密签名：Ed25519，非对称。** 私钥只在签发方（tools/issue/keygen.js），
 *    公钥随源码分发。这是真正的安全边界——拿到全部源码也签不出新卡，因为
 *    签名需要私钥。卡密格式为
 *      JSLB-<套餐段>-<天数段>-<签发日段>-<编号段>-<绑定段>-<签名段>
 *    签名载荷 'JSLB4|<套餐段>|<天数段>|<签发日段>|<编号段>|<绑定段>' 全大写，
 *    覆盖全部有意义的字段：改套餐字符、改天数、改签发日、改编号、改绑定段
 *    都会让验签失败。
 *
 *    **绑定段是机器码的派生摘要，不是机器码本身。** 它对使用者不可逆推
 *    （见 bindDigest），卡密上手抄不出目标机器的机器码；但它进了签名载荷，
 *    所以也换不掉——拿别人的卡密改一个字符到自己机器上是过不了验签的。
 *    绑定段全 0 表示"不绑定"，任何机器都能激活，供企业批量与内部测试用。
 *
 * 2. **本机记录令牌：HMAC-SHA256，对称。** 密钥由公钥派生，因此是公开的。
 *    它绑定机器码、到期时间与用量，作用是"改 license.lic 会被发现"，**不是**
 *    安全边界——有源码的人能自己重算。之所以必须留在本地，是因为用量每次递增
 *    都要重签（license-web.consumeRun），那里拿不到签发私钥。
 *
 * 签发日入签是这次改造的关键一环。到期时间由卡密的签发日与天数推出
 * （见 license-core.expiryFromIssueDay），不再采信记录里的 issuedAt；否则本地改一个
 * issuedAt 就能把自己的许可证无限续期。
 *
 * 字符表不含 I L O U，避免抄写歧义；解码容忍大小写，并把 I/L 当 1、O 当 0。
 */

import {
  hmacSha256Hex, sha256Hex, timingSafeEqualText, b64ToBytes, utf8Bytes,
} from './utils/hash.js';
import { ed25519Sign, ed25519Verify } from './utils/ed25519.js';
import plans from './plan.js';

/** Crockford base32 字符表，去掉了易混的 I L O U。 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 卡密前缀。 */
const PREFIX = 'JSLB';

/** 永久卡的到期时间戳取值。 */
const PERPETUAL = 0;

/** 抄写容错：常见误写字符归一。 */
const CONFUSABLES = { I: '1', L: '1', O: '0', U: 'V' };

/** 套餐段长度。1 个字符即套餐字符本身，见 src/plans.js 的 code 字段。 */
const PLAN_LEN = 1;

/** 天数段长度。2 个字符共 10 bit，可表示 0 到 1023 天。 */
const DAYS_LEN = 2;

/** 签发日段长度。3 个字符共 15 bit，单位是"天"，起点见 DAY_ZERO。 */
const ISSUE_DAY_LEN = 3;

/** 编号段长度，8 个字符即 40 bit，约 1.1 万亿个编号。 */
const ID_LEN = 8;

/**
 * 绑定段长度，16 个字符即 80 bit。
 *
 * 这里存机器码的派生摘要而不是机器码本身：机器码 24 字符，直接写进卡密
 * 等于把目标机器的机器码公开发布，也让人能对着机器码造卡。摘要不可逆，
 * 且 80 bit 足够抗碰撞。
 */
const BIND_LEN = 16;

/** 绑定段"不绑定"的取值。全 0 段让任何机器都能激活，卡密里不放机器信息。 */
const BIND_NONE = '0'.repeat(BIND_LEN);

/** Ed25519 签名固定 64 字节，base32 需要 ceil(512/5) = 103 个字符。 */
const SIG_LEN = 103;

/** 签名字节长度。 */
const SIG_BYTES = 64;

/** 令牌签名的 hex 长度。HMAC-SHA256 是 32 字节，即 64 个 hex 字符。 */
const TOKEN_SIG_LEN = 64;

/** 编号段能表示的最大值，含端点。 */
const MAX_ID = (1n << BigInt(ID_LEN * 5)) - 1n;

/**
 * 签发日段的零点，2020-01-01 UTC。
 *
 * 3 个 base32 字符是 15 bit，可表示 0~32767 天，从 2020 年起算可用到 2109 年。
 * 卡密里存的是"距零点的天数"而不是毫秒时间戳，天数段只有 10 bit 装不下时间戳。
 */
const DAY_ZERO = Date.UTC(2020, 0, 1);

/**
 * 把用户抄写的卡密归一化为大写、无分隔符的形式。
 *
 * 这里只处理大小写与分隔符，不做易混字符替换。前缀 JSLB 自身就含 L，在这里
 * 替换会把它毁成 JS1B。易混字符只作用于前缀之后的段。
 *
 * @param {string} raw 原始输入，允许小写与空格、连字符分隔
 * @returns {string} 大写、无分隔符的文本
 */
function normalizeCode(raw) {
  return String(raw == null ? '' : raw).toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/**
 * 易混字符归正，用于抄写容错：I/L 转 1，O 转 0，U 转 V。
 *
 * 字符表本就不含 I L O U，因此这个映射只会把误写修正成合法字符，不会误伤
 * 正确输入。
 *
 * @param {string} s 已归一化的段文本
 * @returns {string} 归正后的段文本
 */
function deskew(s) {
  return s.split('').map((c) => CONFUSABLES[c] || c).join('');
}

/**
 * 按大端把固定长度 base32 段解码为整数。
 * @param {string} s 已归一化的 base32 文本
 * @returns {number} 无符号整数，含非法字符时返回 -1
 */
function b32ToInt(s) {
  let n = 0;
  for (const c of s) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) return -1;
    n = n * 32 + v;
    if (!Number.isSafeInteger(n)) return -1;
  }
  return n;
}

/**
 * 按大端把长 base32 段解码为 BigInt。
 *
 * 编号段压到 8 字符后已经落回 Number 安全范围，b32ToInt 也够用；这里保留
 * BigInt 版本是因为签名段与绑定段仍需按任意长度解析，且 toIdSegment 的
 * 越界判定以 BigInt 为基准，两处口径一致才不会出现"能编码但解不出"的段。
 *
 * @param {string} s 已归一化的 base32 文本
 * @returns {bigint|null} 无符号整数，含非法字符时返回 null
 */
function b32ToBigInt(s) {
  let n = 0n;
  for (const c of s) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) return null;
    n = n * 32n + BigInt(v);
  }
  return n;
}

/**
 * 按大端把 BigInt 编码为定长 base32 文本，左侧补 0。
 * @param {bigint} n 非负整数
 * @param {number} len 目标长度，超出时返回 null
 * @returns {string|null} base32 文本
 */
function bigIntToB32(n, len) {
  if (typeof n !== 'bigint' || n < 0n) return null;
  let s = '';
  let v = n;
  while (v > 0n) {
    s = ALPHABET[Number(v % 32n)] + s;
    v /= 32n;
  }
  while (s.length < len) s = '0' + s;
  return s.length > len ? null : s;
}

/**
 * 把调用方给出的编号转为定长编号段，接受 BigInt、数字或十进制文本。
 * @param {bigint|number|string} id 编号
 * @returns {string|null} 长度 ID_LEN 的编号段，越界或非法时返回 null
 */function toIdSegment(id) {
  let v = null;
  if (typeof id === 'bigint') v = id;
  else if (typeof id === 'number') v = Number.isSafeInteger(id) && id >= 0 ? BigInt(id) : null;
  else if (typeof id === 'string' && /^[0-9]+$/.test(id)) v = BigInt(id);
  if (v === null || v < 0n || v > MAX_ID) return null;
  return bigIntToB32(v, ID_LEN);
}

/**
 * 校验文本是否为合法 base32。只查字符集，不做整数转换。
 *
 * 签名段的数值有 512 bit，b32ToInt 会因超出安全整数范围而返回 -1，把合法
 * 卡密误判成含非法字符；这里只查字符集，绕开整数范围的干扰。
 *
 * @param {string} s 已归一化的 base32 文本
 * @returns {boolean} 是否非空且全部由字符表内的字符组成
 */
function isB32Text(s) {
  if (typeof s !== 'string' || s.length === 0) return false;
  for (const c of s) {
    if (ALPHABET.indexOf(c) < 0) return false;
  }
  return true;
}

/**
 * 按大端把整数编码为定长 base32 文本，左侧补 0。
 * @param {number} n 非负整数
 * @param {number} len 目标长度，超出时返回 null
 * @returns {string|null} base32 文本
 */
function intToB32(n, len) {
  if (!Number.isInteger(n) || n < 0) return null;
  let s = '';
  let v = n;
  while (v > 0) {
    s = ALPHABET[v % 32] + s;
    v = Math.floor(v / 32);
  }
  while (s.length < len) s = '0' + s;
  return s.length > len ? null : s;
}

/**
 * 把摘要折叠为定长 base32 文本。
 *
 * 用于机器码与绑定摘要的派生：把 32 字节的 HMAC 摘要压成定长的 base32 文本。
 * 摘要不够长时循环取用，够长则截断。
 *
 * @param {string} hex 摘要的 hex 文本
 * @param {number} len 需要的 base32 字符数
 * @returns {string} 定长 base32 文本
 */
function digestToB32(hex, len) {
  let out = '';
  let i = 0;
  while (out.length < len) {
    const byte = parseInt(hex.slice(i % hex.length, (i % hex.length) + 2), 16);
    out += ALPHABET[(byte >> 4) & 31] + ALPHABET[byte & 31];
    i += 2;
  }
  return out.slice(0, len);
}

/**
 * 字节数组按大端编码为定长 base32 文本。
 * @param {Uint8Array} bytes 字节
 * @param {number} len 目标字符数，不足时左侧补 0
 * @returns {string|null} base32 文本，超出长度时返回 null
 */
function bytesToB32(bytes, len) {
  let v = 0n;
  for (let i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i]);
  return bigIntToB32(v, len);
}

/**
 * 定长 base32 文本按大端解码为字节数组。
 *
 * 字符数是 ceil(bit/5) 而非精确的 5 的倍数，末字符有若干位是填充，所以必须显式
 * 检查数值上界：超界说明有人往签名段里塞了更长的数，直接判非法，不能截断。
 *
 * @param {string} s base32 文本
 * @param {number} byteLen 期望的字节数
 * @returns {Uint8Array|null} 字节，非法或超界时返回 null
 */
function b32ToBytes(s, byteLen) {
  const v = b32ToBigInt(s);
  if (v === null) return null;
  if (v >= (1n << BigInt(byteLen * 8))) return null;
  const out = new Uint8Array(byteLen);
  let n = v;
  for (let i = byteLen - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/**
 * 拼装卡密的签名载荷文本。签发与校验两侧必须逐字一致，改动等于换协议。
 *
 * 版本号从 JSLB3 提到 JSLB4：新增绑定段，编号段同时由 24 字符压到 8 字符。
 * 旧卡密在新版本上必然验签失败——这是有意的，**所有 JSLB3 卡密一律作废**，
 * 必须重新签发。用版本号区分是为了让"格式对不上"与"签名不对"两类失败能
 * 分开报告，而不是笼统地报一句验签失败。
 *
 * @param {string} planSeg 套餐段
 * @param {string} daysSeg 天数段
 * @param {string} issueSeg 签发日段
 * @param {string} idSeg 编号段
 * @param {string} bindSeg 绑定段（机器码派生摘要，或 BIND_NONE）
 * @returns {string} 载荷文本
 */
function codePayload(planSeg, daysSeg, issueSeg, idSeg, bindSeg) {
  return PREFIX + '4|' + planSeg + '|' + daysSeg + '|' + issueSeg + '|' + idSeg + '|' + bindSeg;
}

/**
 * 把机器码派生为卡密里的绑定段。
 *
 * 用 HMAC 而不是直接截取机器码：直接截取虽然也不可逆（机器码本身已是摘要），
 * 但会让"前 80 bit 相同的两台机器互相能激活"，且把机器码的位分布暴露出去。
 * 加一层带盐的 HMAC 后，卡密与机器码之间没有可观察的对应关系。
 *
 * 盐取自公钥：不是秘密，也不需要是——绑定段的作用是"把卡密钉死在一台机器上"，
 * 而这一点由 Ed25519 签名保证（绑定段进了载荷）。这里只是让摘要不可逆推。
 *
 * @param {string} machineId 机器码，24 字符 base32
 * @returns {string} 长度 BIND_LEN 的 base32 绑定段，机器码为空时返回 BIND_NONE
 */
function bindDigest(machineId) {
  const mid = String(machineId == null ? '' : machineId).trim().toUpperCase();
  if (!mid || mid === BIND_NONE) return BIND_NONE;
  return digestToB32(hmacSha256Hex('JSLB/BIND/v4', 'JSLB-BIND-1|' + mid), BIND_LEN);
}

/**
 * 把绑定段还原为可比较的形式。
 *
 * 卡密在抄写与传输中会经过 deskew 与大小写归一，绑定段也走同一条路径，
 * 所以这里统一大写后再比。非法字符原样保留，比对自然失败。
 *
 * @param {string} seg 绑定段文本
 * @returns {string} 归一化后的绑定段
 */
function normalizeBindSeg(seg) {
  return String(seg == null ? '' : seg).trim().toUpperCase();
}

/**
 * 拼装许可证令牌的签名载荷文本。签发与校验两侧必须逐字一致。
 *
 * 用量（日期 + 次数）一并入签，license.lic 里的计数才改不动；否则用户把
 * used 改回 0 就能绕过每日配额。
 *
 * @param {string} machineId 机器码，base32
 * @param {number} expiresAt 到期时间戳，0 表示永久
 * @param {string} day 用量所属日期，YYYY-MM-DD
 * @param {number} used 当日已用次数
 * @returns {string} 载荷文本
 */
function tokenPayload(machineId, expiresAt, day, used) {
  return 'LIC3|' + machineId + '|' + expiresAt + '|' + day + '|' + used;
}

/**
 * 由公钥派生本机记录令牌的密钥。
 *
 * 公钥是公开的，所以这个密钥也是公开的：它只用于让"手改 license.lic"留下痕迹，
 * 不构成安全边界（见文件头注释）。派生而不是另设常量，是为了轮换密钥对时
 * 记录令牌的密钥跟着一起换。
 *
 * @param {string} publicKeyB64 公钥 base64
 * @returns {string} 令牌签名密钥
 */
function recordKeyFrom(publicKeyB64) {
  return sha256Hex('JSLB/RECORD/v3|' + publicKeyB64);
}

/** 公钥 base64 解码，长度必须是 32 字节。 */
function b64ToBytesSafe(b64) {
  if (typeof b64 !== 'string' || !b64) return null;
  const bytes = b64ToBytes(b64);
  return bytes.length === 32 ? bytes : null;
}

/**
 * 由套餐、天数、签发日与编号签发一段卡密。
 *
 * 这是**唯一需要私钥**的函数，只在签发方（tools/issue/keygen.js）调用。
 * 运行期一律走 parseCode，只验不签。
 *
 * @param {string} signingSeedB64 私钥种子 base64，32 字节
 * @param {string} planName 套餐名，取值见 src/plans.js
 * @param {number} days 有效天数，0 表示永久
 * @param {bigint|number|string} id 卡密编号，可为十进制文本、数字或 BigInt
 * @param {number} [issueDay] 签发日（距 DAY_ZERO 的天数），省略时取当前 UTC 日
 * @param {string} [machineId] 要绑定的机器码（24 字符 base32）；省略或空表示不绑定
 * @returns {string|null} JSLB-<套餐>-<天数>-<签发日>-<编号>-<绑定>-<签名>，参数非法时返回 null
 */
function issueCode(signingSeedB64, planName, days, id, issueDay, machineId) {
  const planSeg = plans.planCode(planName);
  const daysSeg = intToB32(days, DAYS_LEN);
  const idSeg = toIdSegment(id);
  const bindSeg = machineId === undefined || machineId === null || machineId === ''
    ? BIND_NONE
    : bindDigest(machineId);
  const dayNum = issueDay === undefined
    ? Math.floor((Date.now() - DAY_ZERO) / 86400000)
    : issueDay;
  const issueSeg = intToB32(dayNum, ISSUE_DAY_LEN);
  if (planSeg === null || daysSeg === null || idSeg === null || issueSeg === null) return null;
  if (bindSeg === null || bindSeg.length !== BIND_LEN) return null;
  const seed = b64ToBytesSafe(signingSeedB64);
  if (!seed) return null;
  const sigBytes = ed25519Sign(utf8Bytes(codePayload(planSeg, daysSeg, issueSeg, idSeg, bindSeg)), seed);
  const sigSeg = bytesToB32(sigBytes, SIG_LEN);
  if (!sigSeg) return null;
  return PREFIX + '-' + planSeg + '-' + daysSeg + '-' + issueSeg + '-' + idSeg + '-' + bindSeg + '-' + sigSeg;
}

/**
 * 解析并校验卡密。
 *
 * ok 为真时给出 plan、days、id、issueDay、bound 与归一化后的 code。id 固定为
 * 十进制字符串；编号段压到 8 字符（40 bit）后落在 Number 安全范围内。
 *
 * bound 为真表示这张卡**绑定了签发时指定的机器**，调用方必须把绑定段与当前
 * 机器码的派生摘要比对（见 matchesMachine），不一致就拒绝。为假表示不绑定的
 * 通用卡，任何机器都能激活。
 *
 * @param {string} publicKeyB64 公钥 base64
 * @param {string} raw 用户输入的卡密
 * @returns {{ok:boolean, reason?:string, plan?:string, days?:number, id?:string, issueDay?:number, bound?:boolean, bindSeg?:string, code?:string}} 解析结果
 */
function parseCode(publicKeyB64, raw) {
  const flat = normalizeCode(raw);
  if (!flat.startsWith(PREFIX)) return { ok: false, reason: 'prefix' };
  const body = deskew(flat.slice(PREFIX.length));
  const need = PLAN_LEN + DAYS_LEN + ISSUE_DAY_LEN + ID_LEN + BIND_LEN + SIG_LEN;
  if (body.length !== need) return { ok: false, reason: 'length' };
  let at = 0;
  const planSeg = body.slice(at, at += PLAN_LEN);
  const daysSeg = body.slice(at, at += DAYS_LEN);
  const issueSeg = body.slice(at, at += ISSUE_DAY_LEN);
  const idSeg = body.slice(at, at += ID_LEN);
  const bindSeg = body.slice(at, at += BIND_LEN);
  const sig = body.slice(at);
  const planName = plans.planFromCode(planSeg);
  if (planName === null) return { ok: false, reason: 'plan' };
  const days = b32ToInt(daysSeg);
  const issueDay = b32ToInt(issueSeg);
  const id = b32ToBigInt(idSeg);
  if (days < 0 || issueDay < 0 || id === null || !isB32Text(sig) || !isB32Text(bindSeg)) {
    return { ok: false, reason: 'alphabet' };
  }
  const pub = b64ToBytesSafe(publicKeyB64);
  if (!pub) return { ok: false, reason: 'key' };
  const sigBytes = b32ToBytes(sig, SIG_BYTES);
  if (!sigBytes) return { ok: false, reason: 'alphabet' };
  if (!ed25519Verify(sigBytes, utf8Bytes(codePayload(planSeg, daysSeg, issueSeg, idSeg, bindSeg)), pub)) {
    return { ok: false, reason: 'signature' };
  }
  const code = PREFIX + '-' + planSeg + '-' + daysSeg + '-' + issueSeg + '-' + idSeg + '-' + bindSeg + '-' + sig;
  return {
    ok: true,
    plan: planName,
    days,
    id: id.toString(),
    issueDay,
    bound: bindSeg !== BIND_NONE,
    bindSeg,
    code,
  };
}

/**
 * 卡密里的绑定段是否指向给定的机器码。
 *
 * 不绑定的卡（绑定段全 0）对任何机器都返回真。绑定的卡要求派生摘要逐字符
 * 相等——机器码只要有一位不同，摘要就完全不同。
 *
 * @param {string} bindSeg 卡密里的绑定段，取自 parseCode 的结果
 * @param {string} machineId 当前机器码，24 字符 base32
 * @returns {boolean} 是否允许在这台机器上使用
 */
function matchesMachine(bindSeg, machineId) {
  const seg = normalizeBindSeg(bindSeg);
  if (!seg || seg === BIND_NONE) return true;
  return timingSafeEqualText(seg, bindDigest(machineId));
}

/**
 * 由机器码、到期时间与用量生成许可证令牌。
 *
 * 用的是派生自公钥的对称密钥，**不需要签发私钥**——用量每次递增都要重签，
 * 那里只有用户本机，拿不到私钥。
 *
 * @param {string} publicKeyB64 公钥 base64
 * @param {string} machineId 机器码，base32
 * @param {number} expiresAt 到期时间戳，0 表示永久
 * @param {string} day 用量所属日期，YYYY-MM-DD
 * @param {number} used 当日已用次数
 * @returns {string} <machineId>.<sig> 形式的令牌
 */
function makeToken(publicKeyB64, machineId, expiresAt, day, used) {
  const key = recordKeyFrom(publicKeyB64);
  const sig = hmacSha256Hex(key, tokenPayload(machineId, expiresAt, day, used)).slice(0, TOKEN_SIG_LEN);
  return machineId + '.' + sig;
}

/**
 * 校验许可证令牌与机器码、到期时间、用量是否自洽。
 *
 * 机器码取自令牌前缀，先与当前机器码定时安全比较，再校验签名。换机后前缀
 * 就对不上，无需等签名失败。用量是签名的一部分，改 license.lic 里的配额计数
 * 会让这里失败——但注意密钥是公开的，这条只防手改，不防重新签名。
 *
 * @param {string} publicKeyB64 公钥 base64
 * @param {string} token 许可证令牌
 * @param {string} machineId 当前机器码
 * @param {number} expiresAt 声称的到期时间戳，0 表示永久
 * @param {string} day 声称的用量日期
 * @param {number} used 声称的当日已用次数
 * @returns {boolean} 令牌有效且绑定当前机器
 */
function verifyToken(publicKeyB64, token, machineId, expiresAt, day, used) {
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const claimedMachine = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (sig.length !== TOKEN_SIG_LEN) return false;
  if (typeof day !== 'string' || !Number.isSafeInteger(used) || used < 0) return false;
  if (!timingSafeEqualText(claimedMachine, machineId)) return false;
  const key = recordKeyFrom(publicKeyB64);
  const want = hmacSha256Hex(key, tokenPayload(machineId, expiresAt, day, used)).slice(0, TOKEN_SIG_LEN);
  return timingSafeEqualText(sig, want);
}

export default {
  ALPHABET,
  PREFIX,
  PERPETUAL,
  DAY_ZERO,
  normalizeCode,
  PLAN_LEN,
  DAYS_LEN,
  ISSUE_DAY_LEN,
  ID_LEN,
  BIND_LEN,
  BIND_NONE,
  SIG_LEN,
  TOKEN_SIG_LEN,
  MAX_ID,
  b32ToInt,
  b32ToBigInt,
  intToB32,
  bigIntToB32,
  bytesToB32,
  b32ToBytes,
  toIdSegment,
  isB32Text,
  digestToB32,
  recordKeyFrom,
  bindDigest,
  normalizeBindSeg,
  matchesMachine,
  codePayload,
  tokenPayload,
  issueCode,
  parseCode,
  timingSafeEqualText,
  makeToken,
  verifyToken,
};
