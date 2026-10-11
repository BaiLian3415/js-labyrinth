/**
 * 购买订单的状态机与核验规则 —— 平台无关、可单测（KV 由调用方注入）。
 *
 * ## 为什么要有这个模块
 *
 * 收款用的是**个人微信收款码**：它没有商户回调，也没有订单查询接口。所以"支付成功"
 * 这件事在系统里只有两个可能的来源：
 *   1. 买家自己提交凭证（交易单号 / 金额 / 时间）→ 人工核验（管理端接口或 CLI）；
 *   2. 配了商户号之后，支付平台的**签名回调**（/api/pay-notify）——这是唯一能自动
 *      确认的通道，本模块预留好了入口（applyPayment + verifyWebhook）。
 * 两条路最终都汇到同一处：状态推进到 paid，然后**幂等签发**一张 v5 卡密。
 *
 * ## 状态机
 *
 *   pending ──claim──▶ claimed ──confirm──▶ paid ──issue──▶ issued
 *      │                  │                 │
 *      └──── 超时 ────────┴──▶ expired      └── reject ──▶ rejected
 *   （pay-notify 的签名回调可以直接把 pending/claimed/expired 推到 paid）
 *
 * ## 安全约束（每条都对应一个真实的攻击）
 *
 *   - **查询码与订单号分离**：订单号会出现在页面、聊天记录、客服工单里；只凭订单号
 *     就能取卡的话，任何人看到订单号都能冒领卡密。取卡必须再给 10 字符查询码
 *     （50 bit CSPRNG），且 KV 里只存查询码的 **sha256**——库被读走也换不出卡。
 *   - **交易单号防重放**：同一个交易单号只能核销一次（`txid:<单号>` 键），否则一张
 *     付款截图可以反复下单领卡。
 *   - **金额必须与价目表一致**：签约金额来自 src/pricing.js，不接受客户端传价。
 *   - **签发幂等**：`issueKey` 对已 issued 的订单直接返回原卡密，重复回调不会多签。
 *   - **限流**：同一设备/IP 每小时最多建 N 单，防止刷单把订单表灌满。
 *   - 所有随机数走 CSPRNG（`crypto.getRandomValues`），**不用**项目里那套可复现
 *     PRNG——订单号与查询码是可复现伪随机的话，别人按种子就能算出别人的查询码。
 */

import plan from './plan.js';
import pricing from './pricing.js';
import codec from './license-codec.js';
import secret from './license-secret.js';
import { sha256Hex, hmacSha256Bytes, utf8Bytes, bytesToHex, timingSafeEqualText } from './utils/hash.js';

/** 未支付订单的有效期：24 小时（超过即 expired，不再接受自助提交凭证）。 */
export const ORDER_TTL_MS = 24 * 3600 * 1000;

/** 订单号长度（Crockford base32，每字符 5 bit）。14 字符 = 70 bit。 */
export const ID_LEN = 14;

/** 查询码长度。10 字符 = 50 bit，暴力猜的代价足够高。 */
export const QUERY_LEN = 10;

/** 同一来源每小时可创建的订单数。 */
export const MAX_ORDERS_PER_HOUR = 10;

/** 订单索引（管理端列表）保留的最近条数。KV 没有范围查询，只能自己维护一个索引。 */
export const MAX_INDEX = 200;

/**
 * 订单号的字符集：去掉 I/L/O/U 的 Crockford base32。
 * 长度恰是 32，所以 `字节 & 31` 就是无偏映射（256 % 32 === 0），不需要拒绝采样。
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 状态取值。顺序即推进方向，管理端按它排序展示。 */
export const STATUSES = ['pending', 'claimed', 'paid', 'issued', 'rejected', 'expired'];

/** 默认随机源：浏览器的 WebCrypto / Node 的 globalThis.crypto 都满足。 */
function defaultRng(n) {
  const b = new Uint8Array(n);
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('orders: 需要 CSPRNG（crypto.getRandomValues）');
  }
  c.getRandomValues(b);
  return b;
}

/**
 * 生成定长随机文本（订单号/查询码）。
 * @param {number} len 长度
 * @param {function} [rng] 注入的随机源（测试用）
 * @returns {string}
 */
export function randomText(len, rng) {
  const bytes = (rng || defaultRng)(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] & 31];
  return s;
}

/** 查询码的存储形态：只存散列（见文件头「查询码与订单号分离」）。 */
export function queryHash(id, q) {
  return sha256Hex('jslb-order-v1|' + String(id) + '|' + String(q).toUpperCase());
}

/** 订单的 KV 键。命名与 license-web 的 `redeem:` / `machine:` 同一风格（无额外前缀）。 */
export const keys = {
  order: (id) => 'order:' + id,
  index: () => 'orders:index',
  rate: (scope, bucket) => 'orderrate:' + scope + ':' + bucket,
  txid: (txid) => 'txid:' + txid,
};

/**
 * 建一张订单（纯计算，不落库；落库由 saveOrder 负责）。
 *
 * @param {object} opts
 * @param {string} opts.planName 套餐名
 * @param {string} opts.term 周期 id
 * @param {number} [opts.now] 当前毫秒时间戳
 * @param {function} [opts.rng] 随机源（测试用）
 * @param {string} [opts.device] 建单设备码（审计用，不参与鉴权）
 * @returns {{ok:true, order:object, queryCode:string}|{ok:false, reason:string}}
 */
export function createOrder({ planName, term, now, rng, device }) {
  if (!plan.isPlan(planName)) return { ok: false, reason: 'unknownPlan' };
  const price = pricing.priceOf(planName, term);
  if (!price.ok) return { ok: false, reason: price.reason };
  const t = (Number.isFinite(now) ? now : Date.now());
  const id = randomText(ID_LEN, rng);
  const queryCode = randomText(QUERY_LEN, rng);
  return {
    ok: true,
    queryCode,
    order: {
      v: 1,
      id,
      qh: queryHash(id, queryCode),
      plan: planName,
      term: price.term,
      days: price.days,
      amount: price.fen,
      currency: price.currency,
      status: 'pending',
      createdAt: t,
      expiresAt: t + ORDER_TTL_MS,
      device: String(device || '').slice(0, 64),
      claim: null,
      paid: null,
      key: null,
      keyId: null,
      issuedAt: null,
      rejectedReason: null,
    },
  };
}

/** 写入订单。返回是否写成功（store 的契约是 true/false，不抛）。 */
export async function saveOrder(kv, order) {
  if (!kv || typeof kv.put !== 'function') return false;
  try {
    return (await kv.put(keys.order(order.id), JSON.stringify(order))) !== false;
  } catch (e) {
    return false;
  }
}

/** 读订单；不存在或内容损坏时返回 null。 */
export async function loadOrder(kv, id) {
  if (!kv || typeof kv.get !== 'function' || !id) return null;
  let raw = null;
  try {
    raw = await kv.get(keys.order(String(id).toUpperCase()));
  } catch (e) {
    return null;
  }
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' && o.id ? o : null;
  } catch (e) {
    return null;
  }
}

/** 把订单号插到索引首位（管理端列表用）。索引损坏时静默重建为单元素。 */
export async function indexAdd(kv, id) {
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') return false;
  let list = [];
  try {
    const raw = await kv.get(keys.index());
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) list = parsed.filter((x) => typeof x === 'string');
  } catch (e) {
    list = [];
  }
  list = [String(id)].concat(list.filter((x) => x !== String(id))).slice(0, MAX_INDEX);
  try {
    return (await kv.put(keys.index(), JSON.stringify(list))) !== false;
  } catch (e) {
    return false;
  }
}

/** 读索引（最近的订单号，最新在前）。 */
export async function indexList(kv) {
  if (!kv || typeof kv.get !== 'function') return [];
  try {
    const raw = await kv.get(keys.index());
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch (e) {
    return [];
  }
}

/**
 * 取「计入超时后的」状态。
 *
 * 为什么不落库改状态：KV 没有定时任务，过期只能读时判定。写回 expired 会与并发的
 * 确认操作打架（管理端正在确认，读到的却是 expired），所以过期只作为**视图**与
 * 自助操作的准入判据，真正的状态推进只由 claim/confirm/reject 写。
 *
 * @param {object} order 订单
 * @param {number} now 当前时间
 * @returns {string} 状态
 */
export function effectiveStatus(order, now) {
  if (!order) return 'missing';
  const t = Number.isFinite(now) ? now : Date.now();
  if (order.status === 'pending' || order.status === 'claimed') {
    if (order.expiresAt && t > order.expiresAt) return 'expired';
  }
  return order.status;
}

/** 交易单号规范化：去掉空格与连字符、大写。微信/支付宝单号是 18~32 位数字字母。 */
export function normalizeTxid(raw) {
  const s = String(raw == null ? '' : raw).replace(/[\s-]/g, '').toUpperCase();
  if (s.length < 6 || s.length > 40) return null;
  return /^[0-9A-Z]+$/.test(s) ? s : null;
}

/**
 * 金额（**分**）规范化：机器接口用，入参必须已经是分。
 *
 * 这里刻意**不做**"元 → 分"的换算：价格、订单金额、管理端确认全链路都是分，
 * 悄悄按 ×100 解释一个整数会让 29900（分）变成 2,990,000（分）——而金额比较是等值
 * 判断，错了就是"付了不认"。买家手输的"元"文本走 parseYuan()。
 *
 * @param {*} raw 数字或数字文本（单位：分）
 * @returns {number|null} 分，非法时 null
 */
export function normalizeFen(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'string' ? Number(raw.trim()) : Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  const fen = Math.round(n);
  return Number.isSafeInteger(fen) ? fen : null;
}

/**
 * 把买家输入的**元**文本解析成分（"29" / "¥29.00" / "29.5"）。
 * @param {*} raw 元
 * @returns {number|null} 分，非法时 null
 */
export function parseYuan(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'string' ? Number(raw.replace(/[¥￥,\s]/g, '')) : Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  const fen = Math.round(n * 100);
  return Number.isSafeInteger(fen) ? fen : null;
}

/**
 * 提交付款凭证（买家自助）。
 *
 * 允许在 pending 与 claimed 两个状态上重复提交：买家第一次抄错单号是常态，
 * 让他能改正，而不是"提交一次就锁死，只能找客服"。
 *
 * @param {object} order 订单（会被就地更新并返回）
 * @param {object} claim {txid, amount, paidAt, payer, note}
 * @param {number} now 当前时间
 * @returns {{ok:true, order:object}|{ok:false, reason:string}}
 */
export function applyClaim(order, claim, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const st = effectiveStatus(order, t);
  if (st !== 'pending' && st !== 'claimed') return { ok: false, reason: 'notOpen:' + st };
  const txid = normalizeTxid(claim && claim.txid);
  if (!txid) return { ok: false, reason: 'badTxid' };
  const amount = normalizeFen(claim && claim.amount);
  order.claim = {
    txid,
    amount: amount === null ? null : amount,
    paidAt: String((claim && claim.paidAt) || '').slice(0, 40),
    payer: String((claim && claim.payer) || '').slice(0, 40),
    note: String((claim && claim.note) || '').slice(0, 120),
    at: t,
  };
  order.status = 'claimed';
  return { ok: true, order };
}

/**
 * 支付确认（管理端人工确认 / 签名回调）。推进到 paid 并记录来源。
 *
 * @param {object} order 订单
 * @param {object} pay {txid, amount, paidAt, source, note}
 * @param {number} now 当前时间
 * @returns {{ok:true, order:object}|{ok:false, reason:string}}
 */
export function applyPayment(order, pay, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const st = effectiveStatus(order, t);
  if (order.status === 'issued') return { ok: true, order };          // 幂等
  if (order.status === 'rejected') return { ok: false, reason: 'rejected' };
  if (order.status === 'paid') return { ok: true, order };            // 幂等
  if (st !== 'pending' && st !== 'claimed' && st !== 'expired') return { ok: false, reason: 'badStatus:' + st };
  const txid = normalizeTxid((pay && pay.txid) || (order.claim && order.claim.txid));
  if (!txid) return { ok: false, reason: 'badTxid' };
  const amount = normalizeFen(pay && pay.amount);
  // 金额校验：只接受"与价目表一致"或"未提供"两种。提供却不一致的一律拒绝——
  // 放行的话，1 分钱的付款也能换到卡。
  if (amount !== null && amount !== order.amount) {
    return { ok: false, reason: 'amountMismatch', expected: order.amount, got: amount };
  }
  order.status = 'paid';
  order.paid = {
    txid,
    amount: amount === null ? order.amount : amount,
    paidAt: String((pay && pay.paidAt) || '').slice(0, 40),
    source: String((pay && pay.source) || 'admin').slice(0, 20),
    note: String((pay && pay.note) || '').slice(0, 120),
    at: t,
  };
  return { ok: true, order };
}

/** 拒绝订单（管理端）。已签发的订单不允许拒绝。 */
export function rejectOrder(order, reason, now) {
  if (!order) return { ok: false, reason: 'missing' };
  if (order.status === 'issued') return { ok: false, reason: 'alreadyIssued' };
  order.status = 'rejected';
  order.rejectedReason = String(reason || '').slice(0, 120) || 'rejected';
  order.rejectedAt = Number.isFinite(now) ? now : Date.now();
  return { ok: true, order };
}

/** 随机卡密编号（40 bit，与 tools/issue/keygen.js 的 randomId 同一形制）。 */
function randomKeyId(rng) {
  const b = (rng || defaultRng)(5);
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v & codec.MAX_ID;
}

/**
 * 签发卡密（幂等）。只有 paid / issued 的订单能签——pending/claimed 走不到这里。
 *
 * @param {object} order 订单
 * @param {object} [opts] {now, keyB64, rng}
 * @returns {{ok:true, order:object, key:string, fresh:boolean}|{ok:false, reason:string}}
 */
export function issueKey(order, opts) {
  const o = opts || {};
  if (!order) return { ok: false, reason: 'missing' };
  if (order.status === 'issued' && order.key) {
    return { ok: true, order, key: order.key, fresh: false };
  }
  if (order.status === 'rejected') return { ok: false, reason: 'rejected' };
  if (order.status !== 'paid') return { ok: false, reason: 'notPaid:' + order.status };
  const t = Number.isFinite(o.now) ? o.now : Date.now();
  const keyB64 = o.keyB64 || secret.B64_CODE_KEY;
  if (!keyB64) return { ok: false, reason: 'noKey' };
  const keyId = randomKeyId(o.rng);
  const issueDay = Math.floor((t - codec.DAY_ZERO) / 86400000);
  const code = codec.issueCode(keyB64, order.plan, order.days, keyId, issueDay);
  if (!code) return { ok: false, reason: 'issueFailed' };
  order.status = 'issued';
  order.key = code;
  order.keyId = keyId.toString();
  order.issuedAt = t;
  return { ok: true, order, key: code, fresh: true };
}

/**
 * 买家视角的订单视图。
 *
 * 取卡必须带查询码：订单号本身不是凭据（见文件头）。查询码用**定长比较**，
 * 免得留下"逐字符比较"的时序旁路。
 *
 * @param {object} order 订单
 * @param {string} query 买家提交的查询码
 * @param {number} now 当前时间
 * @returns {{ok:true, view:object}|{ok:false, reason:string}}
 */
export function pickupView(order, query, now) {
  if (!order) return { ok: false, reason: 'notFound' };
  const q = String(query == null ? '' : query).trim().toUpperCase();
  if (!q || !timingSafeEqualText(queryHash(order.id, q), order.qh || '')) {
    return { ok: false, reason: 'badQuery' };
  }
  const st = effectiveStatus(order, now);
  const view = {
    id: order.id,
    plan: order.plan,
    planName: plan.displayName(order.plan),
    term: order.term,
    days: order.days,
    amount: order.amount,
    currency: order.currency,
    status: st,
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    claimAt: order.claim ? order.claim.at : null,
    issuedAt: order.issuedAt || null,
    rejectedReason: order.rejectedReason || null,
  };
  // 只有已签发的订单才把卡密交出去——这一条是整条链路的价值所在，别为了"方便"
  // 提前返回，也别把查询码写进响应。
  if (st === 'issued' && order.key) view.key = order.key;
  return { ok: true, view };
}

/** 管理端视图：带凭证与内部字段，不带查询码散列。 */
export function adminView(order, now) {
  if (!order) return null;
  const o = { ...order };
  delete o.qh;
  o.status = effectiveStatus(order, now);
  return o;
}

/**
 * 签名回调的签名值：HMAC-SHA256(secret, 原始请求体) 的十六进制。
 * 用**原始文本**而不是解析后的对象——重新序列化会改变键序与空白，签名必然对不上。
 */
export function webhookSignature(secretText, rawBody) {
  return bytesToHex(hmacSha256Bytes(utf8Bytes(String(secretText || '')), utf8Bytes(String(rawBody || ''))));
}

/** 校验回调签名（定长比较）。secret 未配置时一律失败——绝不允许"没配就等于放行"。 */
export function verifyWebhook(secretText, rawBody, provided) {
  if (!secretText) return false;
  const want = webhookSignature(secretText, rawBody);
  return timingSafeEqualText(want, String(provided || '').trim().toLowerCase());
}

/**
 * 简单的固定窗口限流。
 *
 * @param {object} kv 存储
 * @param {string} scope 限流维度（设备码或 IP）
 * @param {number} now 当前时间
 * @param {object} [opts] {max, windowMs}
 * @returns {Promise<{ok:boolean, used:number}>} 超过上限时 ok=false
 */
export async function rateLimit(kv, scope, now, opts) {
  const o = opts || {};
  const max = Number.isFinite(o.max) ? o.max : MAX_ORDERS_PER_HOUR;
  const windowMs = Number.isFinite(o.windowMs) ? o.windowMs : 3600 * 1000;
  const t = Number.isFinite(now) ? now : Date.now();
  const bucket = Math.floor(t / windowMs);
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') {
    return { ok: true, used: 0 };   // 没有存储时不假装限流成功，但也不阻断下单
  }
  const key = keys.rate(String(scope || 'anonymous').slice(0, 64), bucket);
  let used = 0;
  try {
    used = Number(await kv.get(key)) || 0;
  } catch (e) {
    used = 0;
  }
  if (used >= max) return { ok: false, used };
  try {
    await kv.put(key, String(used + 1));
  } catch (e) { /* 计数写不进去时不阻断，只少一层保护 */ }
  return { ok: true, used: used + 1 };
}

/**
 * 登记交易单号，防一单多领。返回 false 表示这个单号已经被别的订单用过。
 *
 * @param {object} kv 存储
 * @param {string} txid 交易单号（已规范化）
 * @param {string} orderId 订单号
 * @returns {Promise<boolean>} 是否登记成功
 */
export async function claimTxid(kv, txid, orderId) {
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') return true;
  const key = keys.txid(txid);
  let prev = null;
  try {
    prev = await kv.get(key);
  } catch (e) {
    prev = null;
  }
  if (prev && prev !== orderId) return false;
  if (prev === orderId) return true;
  try {
    return (await kv.put(key, String(orderId))) !== false;
  } catch (e) {
    return false;
  }
}

/** i18n 文案键：把内部 reason 映射成用户可读的提示键。 */
export const REASON_KEYS = {
  unknownPlan: 'orderErrPlan',
  freePlan: 'orderErrFree',
  contactOnly: 'orderErrContact',
  unknownTerm: 'orderErrTerm',
  termNotOffered: 'orderErrTerm',
  badQuery: 'orderErrQuery',
  notFound: 'orderErrNotFound',
  badTxid: 'orderErrTxid',
  amountMismatch: 'orderErrAmount',
  rejected: 'orderErrRejected',
  alreadyIssued: 'orderErrIssued',
  noKey: 'orderErrNoKey',
  issueFailed: 'orderErrIssue',
  rateLimited: 'orderErrRate',
  txidUsed: 'orderErrTxidUsed',
  forbidden: 'orderErrForbidden',
  badJson: 'orderErrBadJson',
};

/** 内部 reason（可能是 `notOpen:expired` 这种带后缀的）→ i18n 键。 */
export function reasonKey(reason) {
  const base = String(reason || '').split(':')[0];
  return REASON_KEYS[base] || 'orderErrGeneric';
}

export default {
  ORDER_TTL_MS, ID_LEN, QUERY_LEN, MAX_ORDERS_PER_HOUR, MAX_INDEX, STATUSES, keys,
  randomText, queryHash, createOrder, saveOrder, loadOrder, indexAdd, indexList,
  effectiveStatus, normalizeTxid, normalizeFen, parseYuan, applyClaim, applyPayment, rejectOrder,
  issueKey, pickupView, adminView, webhookSignature, verifyWebhook, rateLimit, claimTxid,
  REASON_KEYS, reasonKey,
};
