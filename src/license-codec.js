/**
 * 卡密与许可证令牌的编解码原语，纯函数，无副作用。
 *
 * ## 卡密格式 v5
 *
 *   JSLB-<编号段8>-<信息段16>-<校验码4>
 *
 * 去掉了 v4 的 Ed25519 非对称签名与机器绑定段，改为**对称密钥 + 加密信息段 +
 * 校验码**：
 *
 * 1. **编号段**：8 个 base32 字符（40 bit，约 1.1 万亿），由签发方**随机**生成。
 *    它同时是服务端赎回登记的分键（一卡一机的登记键），随机性保证多批发卡
 *    不会撞号。
 *
 * 2. **信息段**：16 个 base32 字符（80 bit），装载套餐（5 bit）+ 天数（10 bit）
 *    + 签发日（15 bit）共 30 bit 明文，外加 50 bit 随机 IV。加密用
 *    HMAC-SHA256 派生的 30 bit 密钥流异或明文——没有密钥读不出套餐与天数，
 *    同一张卡每次签发的信息段也不同。到期时间由**卡密里的签发日**与天数推出
 *    （见 license-core.expiryFromIssueDay），不采信记录里的任何明文字段。
 *
 * 3. **校验码**：4 个 base32 字符（20 bit），= 截断的 HMAC-SHA256(密钥,
 *    'JSLB5/CRC|编号段|信息段')。编号段与信息段的任何一位被改都会校验失败。
 *    20 bit 对"手抄错一位"与"脚本穷举"都足够（穷举一次通过的概率 1/1048576）。
 *
 * ## 安全模型的诚实说明
 *
 * 对称密钥必须随源码分发（浏览器要本地验卡），所以**拿到源码的人可以自己签发
 * 卡密**——这是 v4 换成 Ed25519 时特意避免的，v5 应签发方要求改回对称，安全
 * 边界随之降级。真正的强制在服务端：服务端用同一把密钥逐请求校验卡密 + 云存储
 * 赎回登记（一卡一机）+ 云端执行构建不下发核心源码。浏览器本地校验只是第一路径，
 * 与"部署方换密钥时激活靠服务端认定"的既有精神一致。
 *
 * 密钥在 src/license-secret.js（B64_CODE_KEY，base64 32 字节）。泄露等于发卡权
 * 泄露；轮换用 tools/issue/keyrotate.js，轮换后所有旧卡密与本地许可证记录
 * 立即失效。
 *
 * 2. **本机记录令牌：HMAC-SHA256，对称。** 密钥由卡密密钥派生。它绑定机器码、
 *    到期时间与用量，作用是"改 license 记录会被发现"——与卡密校验码同一性质，
 *    不是独立的安全边界。之所以必须留在本地，是因为用量每次递增都要重签
 *    （license-web.consumeRun），那里没有签发服务。
 *
 * ## 与 v4 的兼容性
 *
 * 格式版本随 v4→v5 更替，**所有 v4 卡密一律作废**（长度校验即失败，reason 为
 * length）。matchesMachine/bindDigest 保留：绑定段的概念不再进入卡密（"一卡
 * 一机"由服务端赎回登记承担），但机器绑定判定与机器码摘要仍是授权链路的一部分。
 *
 * 字符表不含 I L O U，避免抄写歧义；解码容忍大小写，并把 I/L 当 1、O 当 0。
 */

import {
  hmacSha256Hex, sha256Hex, timingSafeEqualText, b64ToBytes,
} from './utils/hash.js';
import platform from './platform.js';
import plans from './plan.js';

/** Crockford base32 字符表，去掉了易混的 I L O U。 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 卡密前缀。 */
const PREFIX = 'JSLB';

/** 永久卡的到期时间戳取值。 */
const PERPETUAL = 0;

/** 抄写容错：常见误写字符归一。 */
const CONFUSABLES = { I: '1', L: '1', O: '0', U: 'V' };

/** 编号段长度，8 个字符即 40 bit，约 1.1 万亿个编号，签发时随机取用。 */
const ID_LEN = 8;

/** 信息段长度，16 个字符即 80 bit：30 bit 明文 + 50 bit 随机 IV。 */
const INFO_LEN = 16;

/** 校验码长度，4 个字符即 20 bit。 */
const CRC_LEN = 4;

/** 去分隔符后的卡密体长度：编号 + 信息 + 校验码。 */
const BODY_LEN = ID_LEN + INFO_LEN + CRC_LEN;

/** 信息段明文里套餐字符占的位数（1 个 base32 字符 = 5 bit）。 */
const PLAN_BITS = 5;

/** 天数占的位数。10 bit 可表示 0 到 1023 天。 */
const DAYS_BITS = 10;

/** 签发日占的位数。15 bit，起点见 DAY_ZERO。 */
const ISSUE_BITS = 15;

/** 信息段明文总位数：套餐 + 天数 + 签发日。 */
const PLAIN_BITS = PLAN_BITS + DAYS_BITS + ISSUE_BITS;

/** 信息段随机 IV 的位数：80 bit 减去 30 bit 明文。 */
const IV_BITS = INFO_LEN * 5 - PLAIN_BITS;

/** 校验码位数。 */
const CRC_BITS = 20;

/** 信息段加密与校验码派生的协议标签。换格式时必须换标签。 */
const TAG_INFO = 'JSLB5/INFO|';
const TAG_CRC = 'JSLB5/CRC|';

/** 绑定段"不绑定"的取值。v5 卡密恒为全 0：绑定职能由服务端赎回登记承担。 */
const BIND_NONE = '0000000000000000';
const BIND_LEN = 16;

/** 令牌签名的 hex 长度。HMAC-SHA256 是 32 字节，即 64 个 hex 字符。 */
const TOKEN_SIG_LEN = 64;

/** 编号段能表示的最大值，含端点。 */
const MAX_ID = (1n << BigInt(ID_LEN * 5)) - 1n;

/**
 * 签发日段的零点，2020-01-01 UTC。
 *
 * 签发日只有 15 bit，可表示 0~32767 天，从 2020 年起算可用到 2109 年。
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
 * 信息段 80 bit 超出 Number 安全范围，必须走 BigInt；编号段 40 bit 虽然落在
 * Number 范围内，也统一用这条路径解析，保证"能编码但解不出"的错位不存在。
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
 */
function toIdSegment(id) {
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
 * 校验码与编号段的数值都能落进安全范围，但统一用这条路径做前置校验，
 * 让"含非法字符"与"数值越界"两类失败分开报告。
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
 * 卡密密钥 base64 解码，长度必须是 32 字节。
 *
 * 密钥来自 src/license-secret.js（或部署方用 JSLB_CODE_KEY 覆盖）。长度不对
 * 时整个编解码模块必须拒绝工作，否则会把"配置错了密钥"表现成"所有卡密都
 * 校验失败"，误导排查方向。
 *
 * @param {string} keyB64 卡密密钥 base64
 * @returns {Uint8Array|null} 32 字节密钥，非法时返回 null
 */
function b64ToBytesSafe(keyB64) {
  if (typeof keyB64 !== 'string' || !keyB64) return null;
  const bytes = b64ToBytes(keyB64);
  return bytes.length === 32 ? bytes : null;
}

/**
 * 由信息段随机 IV 派生 30 bit 加密密钥流。
 *
 * IV 是明文的一部分（随卡密携带），密钥流只由（密钥, IV）决定，加密与解密
 * 两侧用同一公式——这也是"能解"的依据。截取摘要前 32 bit 再右移 2 bit，
 * 是为了让 30 bit 密钥流的每一位都吃满摘要高位（直接取 30 bit 会丢掉最低
 * 2 bit 的均衡性，意义不大，但代价为零就顺手做了）。
 *
 * @param {string} keyB64 卡密密钥 base64（调用方已校验过格式）
 * @param {bigint} iv 50 bit 随机 IV
 * @returns {number} 30 bit 密钥流
 */
function keystream30(keyB64, iv) {
  const h = hmacSha256Hex(String(keyB64), TAG_INFO + iv.toString());
  return Number((BigInt('0x' + h.slice(0, 8)) >> 2n) & 0x3FFFFFFn);
}

/**
 * 由编号段与信息段算出 20 bit 校验码。
 *
 * 覆盖编号段与信息段两段：改任何一位（含分隔符重排造成的错位）都会让校验
 * 失败。密钥参与运算，没有密钥就造不出能通过校验的替换段。
 *
 * @param {string} keyB64 卡密密钥 base64
 * @param {string} idSeg 编号段
 * @param {string} infoSeg 信息段
 * @returns {string|null} 4 字符 base32 校验码
 */
function crc20(keyB64, idSeg, infoSeg) {
  const h = hmacSha256Hex(String(keyB64), TAG_CRC + idSeg + '|' + infoSeg);
  const n = Number((BigInt('0x' + h.slice(0, 8)) >> 12n) & 0xFFFFFn);
  return intToB32(n, CRC_LEN);
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
 * 把机器码派生为绑定摘要。
 *
 * v5 卡密**不再携带绑定段**（"一卡一机"由服务端赎回登记承担），但这个摘要
 * 保留：matchesMachine 的比对语义、以及迁移期对 v4 记录的判定都还要用它。
 *
 * @param {string} machineId 机器码，24 字符 base32
 * @returns {string} 长度 BIND_LEN 的 base32 绑定摘要
 */
function bindDigest(machineId) {
  const mid = String(machineId == null ? '' : machineId).trim().toUpperCase();
  if (!mid || mid === BIND_NONE) return BIND_NONE;
  return digestToB32(hmacSha256Hex('JSLB/BIND/v4', 'JSLB-BIND-1|' + mid), BIND_LEN);
}

/**
 * 拼装许可证令牌的签名载荷文本。签发与校验两侧必须逐字一致。
 *
 * 用量（日期 + 次数）一并入签，license 记录里的计数才改不动；否则用户把
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
 * 由卡密密钥派生本机记录令牌的密钥。
 *
 * 卡密密钥本身随源码分发，所以这个派生密钥也是公开的：它只用于让"手改
 * license 记录"留下痕迹，不构成安全边界（见文件头注释）。派生而不是另设
 * 常量，是为了轮换卡密密钥时记录令牌的密钥跟着一起换。
 *
 * @param {string} keyB64 卡密密钥 base64
 * @returns {string} 令牌签名密钥
 */
function recordKeyFrom(keyB64) {
  return sha256Hex('JSLB/RECORD/v4|' + keyB64);
}

/**
 * 由套餐、天数、签发日与随机编号签发一段卡密。
 *
 * 编号由调用方给出（keygen 默认随机生成）；信息段的 IV 每次调用都随机，
 * 因此同一组参数两次签发会得到两段不同的卡密，但都能被同一把密钥解析。
 *
 * @param {string} keyB64 卡密密钥 base64，32 字节
 * @param {string} planName 套餐名，取值见 src/plans.js
 * @param {number} days 有效天数，0 表示永久
 * @param {bigint|number|string} id 卡密编号，可为十进制文本、数字或 BigInt
 * @param {number} [issueDay] 签发日（距 DAY_ZERO 的天数），省略时取当前 UTC 日
 * @returns {string|null} JSLB-<编号>-<信息>-<校验码>，参数非法时返回 null
 */
function issueCode(keyB64, planName, days, id, issueDay) {
  if (b64ToBytesSafe(keyB64) === null) return null;
  const planSeg = plans.planCode(planName);
  const planIdx = planSeg === null ? -1 : ALPHABET.indexOf(planSeg);
  const idSeg = toIdSegment(id);
  const dayNum = issueDay === undefined
    ? Math.floor((Date.now() - DAY_ZERO) / 86400000)
    : issueDay;
  if (planIdx < 0 || !Number.isInteger(days) || days < 0 || days > (1 << DAYS_BITS) - 1) return null;
  if (!Number.isInteger(dayNum) || dayNum < 0 || dayNum > (1 << ISSUE_BITS) - 1) return null;
  if (idSeg === null) return null;
  // 明文打包：套餐 | 天数 | 签发日，共 30 bit
  let plain = BigInt(planIdx);
  plain = (plain << BigInt(DAYS_BITS)) | BigInt(days);
  plain = (plain << BigInt(ISSUE_BITS)) | BigInt(dayNum);
  // 随机 IV 50 bit。签发只在 Node/浏览器发生（Worker 不签卡），randomBytes 三端可用
  const ivBytes = platform.randomBytes(7);
  let iv = 0n;
  for (let i = 0; i < ivBytes.length; i++) iv = (iv << 8n) | BigInt(ivBytes[i]);
  iv &= (1n << BigInt(IV_BITS)) - 1n;
  const cipher = plain ^ BigInt(keystream30(keyB64, iv));
  const infoSeg = bigIntToB32((iv << BigInt(PLAIN_BITS)) | cipher, INFO_LEN);
  if (infoSeg === null) return null;
  const crcSeg = crc20(keyB64, idSeg, infoSeg);
  if (crcSeg === null) return null;
  return PREFIX + '-' + idSeg + '-' + infoSeg + '-' + crcSeg;
}

/**
 * 解析并校验卡密。
 *
 * ok 为真时给出 plan、days、id、issueDay 与归一化后的 code。id 固定为十进制
 * 字符串。bound 恒为 false、bindSeg 恒为 BIND_NONE——v5 卡密不携带绑定段，
 * 返回这两个字段是为了让 license-core 的判定链路在 v4/v5 之间保持同一形状。
 *
 * 校验顺序：先查校验码（覆盖编号段与信息段），再解密信息段。错误密钥签出的
 * 卡在这一步必然失败（reason=signature），不会走进解密分支。
 *
 * @param {string} keyB64 卡密密钥 base64
 * @param {string} raw 用户输入的卡密
 * @returns {{ok:boolean, reason?:string, plan?:string, days?:number, id?:string, issueDay?:number, bound?:boolean, bindSeg?:string, code?:string}} 解析结果
 */
function parseCode(keyB64, raw) {
  const flat = normalizeCode(raw);
  if (!flat.startsWith(PREFIX)) return { ok: false, reason: 'prefix' };
  const body = deskew(flat.slice(PREFIX.length));
  if (body.length !== BODY_LEN) return { ok: false, reason: 'length' };
  const idSeg = body.slice(0, ID_LEN);
  const infoSeg = body.slice(ID_LEN, ID_LEN + INFO_LEN);
  const crcSeg = body.slice(ID_LEN + INFO_LEN);
  if (!isB32Text(idSeg) || !isB32Text(infoSeg) || !isB32Text(crcSeg)) {
    return { ok: false, reason: 'alphabet' };
  }
  if (b64ToBytesSafe(keyB64) === null) return { ok: false, reason: 'key' };
  const idBig = b32ToBigInt(idSeg);
  if (idBig === null) return { ok: false, reason: 'alphabet' };
  // 校验码先验：覆盖编号段与信息段，改任何一位都在这里被拦
  if (crc20(keyB64, idSeg, infoSeg) !== crcSeg) return { ok: false, reason: 'signature' };
  const v = b32ToBigInt(infoSeg);
  if (v === null) return { ok: false, reason: 'alphabet' };
  const iv = v >> BigInt(PLAIN_BITS);
  const cipher = Number(v & ((1n << BigInt(PLAIN_BITS)) - 1n));
  const plain = BigInt(cipher) ^ BigInt(keystream30(keyB64, iv));
  const issueDay = Number(plain & ((1n << BigInt(ISSUE_BITS)) - 1n));
  const days = Number((plain >> BigInt(ISSUE_BITS)) & ((1n << BigInt(DAYS_BITS)) - 1n));
  // 明文布局：套餐(高 5 bit) | 天数(中 10 bit) | 签发日(低 15 bit)。套餐右移 25 位。
  const planIdx = Number(plain >> BigInt(PLAIN_BITS - PLAN_BITS));
  const planName = planIdx >= 0 && planIdx < ALPHABET.length ? plans.planFromCode(ALPHABET[planIdx]) : null;
  if (planName === null) return { ok: false, reason: 'plan' };
  const code = PREFIX + '-' + idSeg + '-' + infoSeg + '-' + crcSeg;
  return {
    ok: true,
    plan: planName,
    days,
    id: idBig.toString(),
    issueDay,
    bound: false,
    bindSeg: BIND_NONE,
    code,
  };
}

/**
 * 卡密里的绑定段是否指向给定的机器码。
 *
 * v5 卡密恒为"不绑定"（bindSeg 全 0），对任何机器码都返回真——"一卡一机"
 * 的强制在服务端赎回登记，不在这条判定里。保留函数是为了让 license-core 的
 * 判定链路不需要区分卡密格式。
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
 * 用的是由卡密密钥派生的对称密钥，**不需要签发服务**——用量每次递增都要重签，
 * 那里只有用户本机。
 *
 * @param {string} keyB64 卡密密钥 base64
 * @param {string} machineId 机器码，base32
 * @param {number} expiresAt 到期时间戳，0 表示永久
 * @param {string} day 用量所属日期，YYYY-MM-DD
 * @param {number} used 当日已用次数
 * @returns {string} <machineId>.<sig> 形式的令牌
 */
function makeToken(keyB64, machineId, expiresAt, day, used) {
  const key = recordKeyFrom(keyB64);
  const sig = hmacSha256Hex(key, tokenPayload(machineId, expiresAt, day, used)).slice(0, TOKEN_SIG_LEN);
  return machineId + '.' + sig;
}

/**
 * 校验许可证令牌与机器码、到期时间、用量是否自洽。
 *
 * 机器码取自令牌前缀，先与当前机器码定时安全比较，再校验签名。换机后前缀
 * 就对不上，无需等签名失败。用量是签名的一部分，改 license 记录里的配额计数
 * 会让这里失败——但注意密钥是公开的，这条只防手改，不防重新签名。
 *
 * @param {string} keyB64 卡密密钥 base64
 * @param {string} token 许可证令牌
 * @param {string} machineId 当前机器码
 * @param {number} expiresAt 声称的到期时间戳，0 表示永久
 * @param {string} day 声称的用量日期
 * @param {number} used 声称的当日已用次数
 * @returns {boolean} 令牌有效且绑定当前机器
 */
function verifyToken(keyB64, token, machineId, expiresAt, day, used) {
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const claimedMachine = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (sig.length !== TOKEN_SIG_LEN) return false;
  if (typeof day !== 'string' || !Number.isSafeInteger(used) || used < 0) return false;
  if (!timingSafeEqualText(claimedMachine, machineId)) return false;
  const key = recordKeyFrom(keyB64);
  const want = hmacSha256Hex(key, tokenPayload(machineId, expiresAt, day, used)).slice(0, TOKEN_SIG_LEN);
  return timingSafeEqualText(sig, want);
}

export default {
  ALPHABET,
  PREFIX,
  PERPETUAL,
  DAY_ZERO,
  normalizeCode,
  ID_LEN,
  INFO_LEN,
  CRC_LEN,
  BODY_LEN,
  PLAIN_BITS,
  IV_BITS,
  CRC_BITS,
  BIND_LEN,
  BIND_NONE,
  TOKEN_SIG_LEN,
  MAX_ID,
  b32ToInt,
  b32ToBigInt,
  intToB32,
  bigIntToB32,
  toIdSegment,
  isB32Text,
  digestToB32,
  recordKeyFrom,
  bindDigest,
  normalizeBindSeg,
  matchesMachine,
  tokenPayload,
  keystream30,
  crc20,
  issueCode,
  parseCode,
  timingSafeEqualText,
  makeToken,
  verifyToken,
};
