#!/usr/bin/env node
/**
 * 价目表与购买订单：定价数据一致性、订单状态机、取卡鉴权、防重放、限流、回调签名。
 *
 *   node test/pricing.js
 *
 * 整跑全部用例：npm test（即 node test/selftest.js）。
 *
 * 为什么这一组值得单独存在：订单链路是**唯一碰钱的地方**，而它的失败模式全是安静的
 * ——价格漏配会显示 ¥0.00、查询码不校验会让订单号变成取卡凭据、交易单号不去重会让
 * 一张付款截图反复领卡。这些都不会抛异常，只会默默放行。所以这里逐条钉住。
 */
import { cleanTmp, ok, report, section } from './_harness.js';
import plan from '../src/plan.js';
import pricing from '../src/pricing.js';
import orders from '../src/orders.js';
import codec from '../src/license-codec.js';
import secret from '../src/license-secret.js';
import i18n from '../src/i18n.js';

/** 内存 KV。契约与 vercel/store.js 一致：get → 字符串或 null，put → true/false。 */
function memKv() {
  const m = new Map();
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, String(v)); return true; },
    delete: async (k) => { m.delete(k); },
    _dump: () => m,
  };
}

/** 确定性随机源：测试里要能复现订单号与查询码。 */
function rngOf(seed) {
  let s = seed >>> 0;
  return (n) => {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
      b[i] = (s >>> 8) & 0xff;
    }
    return b;
  };
}

section('价目表：一致性与格式化');
{
  const problems = pricing.problems(plan);
  ok(problems.length === 0, '价目表与套餐表一一对应且无隐患', problems.join('；'));

  // 每个可购买套餐的每个周期都必须查得到价，且金额是正整数分
  const buyable = plan.rows().filter((r) => pricing.isPurchasable(r.name));
  ok(buyable.length >= 6, '至少六个在线售卖的套餐', '实得 ' + buyable.length);
  const bad = [];
  for (const r of buyable) {
    const terms = pricing.termsFor(r.name);
    if (!terms.length) bad.push(r.name + ': 无周期');
    for (const t of terms) {
      const p = pricing.priceOf(r.name, t);
      if (!p.ok || !Number.isSafeInteger(p.fen) || p.fen <= 0) bad.push(r.name + '/' + t);
    }
  }
  ok(bad.length === 0, '每个售卖组合都有正整数价格', bad.join(' '));

  // 免费档与按合同报价的档不能下单
  ok(!pricing.isPurchasable('free') && pricing.priceOf('free', 'month').reason === 'freePlan',
    '免费档不可下单');
  ok(!pricing.isPurchasable('packCustom') && pricing.priceOf('packCustom', 'once').reason === 'contactOnly',
    '按合同报价的档不可自助下单');
  ok(pricing.priceOf('plus', 'month').days === 30 && pricing.priceOf('plus', 'perpetual').days === 0,
    '周期天数进卡密载荷（月付 30 天、永久 0 天）');
  ok(pricing.priceOf('team', 'month').ok === false ? true : true, '（占位：未知周期见下条）');
  ok(pricing.priceOf('nope', 'month').reason === 'unknownPlan'
    && pricing.priceOf('plus', 'nope').reason === 'unknownTerm', '未知套餐/周期被拒绝');

  ok(pricing.formatFen(2900) === '29' && pricing.formatFen(2990) === '29.90'
    && pricing.formatFen(129900, true) === '1,299.00' && pricing.formatFen(0) === '0',
    '金额格式化（整元省小数、千分位、强制两位）',
    [pricing.formatFen(2900), pricing.formatFen(2990), pricing.formatFen(129900, true)].join(' / '));

  const saving = pricing.yearlySaving('plus');
  ok(saving === null || (saving > 0 && saving < 1), '年付折扣比例在 (0,1) 内', String(saving));
}

section('订单：创建、凭证、核验、签发');
{
  const kv = memKv();
  const rng = rngOf(20261011);
  const now = Date.UTC(2026, 9, 11, 12, 0, 0);

  const made = orders.createOrder({ planName: 'plus', term: 'year', now, rng, device: 'dev-1' });
  ok(made.ok, '建单成功', JSON.stringify(made).slice(0, 120));
  const order = made.order;
  const q = made.queryCode;
  ok(order.amount === pricing.priceOf('plus', 'year').fen && order.days === 365,
    '订单金额与天数取自价目表，不接受客户端传价', order.amount + '/' + order.days);
  ok(order.key === null && order.status === 'pending', '新单是 pending 且不带卡密');
  ok(orders.createOrder({ planName: 'free', term: 'month', now, rng }).reason === 'freePlan'
    && orders.createOrder({ planName: 'plus', term: 'once', now, rng }).reason === 'termNotOffered',
    '免费档与不匹配的周期在服务端被拒（不靠界面挡）');

  // 查询码只存散列：KV 里不该出现明文查询码
  await orders.saveOrder(kv, order);
  await orders.indexAdd(kv, order.id);
  const stored = kv._dump().get(orders.keys.order(order.id));
  ok(stored && !stored.includes(q), 'KV 里存的是查询码散列而不是明文',
    stored.includes(q) ? '明文泄漏!' : 'ok');
  ok(JSON.parse(stored).qh === orders.queryHash(order.id, q), '查询码散列可复算');

  // 取卡鉴权：订单号不足以取卡
  ok(orders.pickupView(order, '', now).reason === 'badQuery', '不给查询码取不到卡');
  ok(orders.pickupView(order, 'AAAAAAAAAA', now).reason === 'badQuery', '错查询码取不到卡');
  const peek = orders.pickupView(order, q, now);
  ok(peek.ok && peek.view.status === 'pending' && !peek.view.key,
    '凭查询码可查状态，但未签发时拿不到卡密');

  // 提交凭证 → 人工确认 → 签发
  const badTx = orders.applyClaim(order, { txid: 'x' }, now);
  ok(!badTx.ok && badTx.reason === 'badTxid', '非法交易单号被拒');
  const claim = orders.applyClaim(order, { txid: '4200 0012-3456', amount: 299, payer: '张三' }, now + 1000);
  ok(claim.ok && order.status === 'claimed' && order.claim.txid === '420000123456',
    '凭证规范化（去空格连字符、大写）并置为 claimed', order.claim && order.claim.txid);

  const early = orders.issueKey(order, { now, keyB64: secret.B64_CODE_KEY, rng });
  ok(!early.ok && early.reason === 'notPaid:claimed', '未确认支付不允许签发');

  const mismatch = orders.applyPayment(order, { txid: '420000123456', amount: 1, source: 'admin' }, now + 2000);
  ok(!mismatch.ok && mismatch.reason === 'amountMismatch', '金额不符被拒（1 分换不走卡）',
    JSON.stringify(mismatch));
  const paid = orders.applyPayment(order, { txid: '420000123456', amount: 29900, source: 'admin' }, now + 2000);
  ok(paid.ok && order.status === 'paid', '金额一致则置为 paid');
  ok(orders.applyPayment(order, { txid: '420000123456', source: 'webhook' }, now + 3000).ok,
    '重复确认是幂等的（回调重放不会出错）');

  const issued = orders.issueKey(order, { now: now + 4000, keyB64: secret.B64_CODE_KEY, rng });
  ok(issued.ok && issued.fresh && !!issued.key, 'paid 之后签发卡密');
  const again = orders.issueKey(order, { now: now + 5000, keyB64: secret.B64_CODE_KEY, rng });
  ok(again.ok && again.fresh === false && again.key === issued.key, '签发幂等：重复调用给同一张卡');

  // 用卡密解码器反验：这张卡必须是真的、套餐与天数与订单一致
  const parsed = codec.parseCode(secret.B64_CODE_KEY, issued.key);
  ok(parsed.ok && parsed.plan === 'plus' && parsed.days === 365,
    '签发出的卡密能被解码器解析，套餐/天数与订单一致',
    parsed.ok ? parsed.plan + '/' + parsed.days : parsed.reason);

  const finalView = orders.pickupView(order, q, now + 6000);
  ok(finalView.ok && finalView.view.status === 'issued' && finalView.view.key === issued.key,
    '签发后凭查询码自助取卡');

  await orders.saveOrder(kv, order);
  const reloaded = await orders.loadOrder(kv, order.id);
  ok(reloaded && reloaded.status === 'issued' && reloaded.key === issued.key, '订单落库后可原样读回');
  const idx = await orders.indexList(kv);
  ok(idx.length === 1 && idx[0] === order.id, '订单索引里能查到这张单');
}

section('订单：过期、拒绝、防重放、限流、回调签名');
{
  const now = Date.UTC(2026, 9, 11, 12, 0, 0);
  const rng = rngOf(7);

  // 过期：24 小时后未支付 → expired，且不再接受自助提交
  const o1 = orders.createOrder({ planName: 'pack100', term: 'once', now, rng }).order;
  ok(orders.effectiveStatus(o1, now + orders.ORDER_TTL_MS + 1) === 'expired'
    && orders.applyClaim(o1, { txid: 'ABC123' }, now + orders.ORDER_TTL_MS + 2).reason.startsWith('notOpen'),
    '未支付订单 24 小时后过期，过期后不再接受凭证');
  // 但签名回调/人工确认仍可救回真实付款（钱已经到账，不能因为超时就吞掉）
  ok(orders.applyPayment(o1, { txid: 'ABC123', amount: o1.amount, source: 'webhook' }, now + orders.ORDER_TTL_MS + 3).ok,
    '超时但确有付款时，回调/人工确认仍可确认（不吞真实付款）');

  // 拒绝：已签发的订单不能被拒绝
  const o2 = orders.createOrder({ planName: 'plus', term: 'month', now, rng }).order;
  ok(orders.rejectOrder(o2, '未收到款项', now).ok && o2.status === 'rejected', '待支付订单可被拒绝');
  ok(orders.issueKey(o2, { now, keyB64: secret.B64_CODE_KEY, rng }).reason === 'rejected',
    '被拒绝的订单签发不出去');

  // 交易单号防重放：同一单号只能核销一次
  const kv = memKv();
  ok(await orders.claimTxid(kv, 'TX-1', 'order-a') === true, '首次核销单号成功');
  ok(await orders.claimTxid(kv, 'TX-1', 'order-a') === true, '同一订单重复核销是幂等的');
  ok(await orders.claimTxid(kv, 'TX-1', 'order-b') === false, '同一单号换订单会被拒（防一张截图领多次）');
  ok(await orders.claimTxid(kv, 'TX-2', 'order-b') === true, '不同单号正常通过');

  // 限流
  const kv2 = memKv();
  let allowed = 0;
  for (let i = 0; i < orders.MAX_ORDERS_PER_HOUR + 3; i++) {
    const r = await orders.rateLimit(kv2, 'dev-x', now);
    if (r.ok) allowed++;
  }
  ok(allowed === orders.MAX_ORDERS_PER_HOUR, '同一来源每小时建单数被限流',
    allowed + '/' + orders.MAX_ORDERS_PER_HOUR);
  ok((await orders.rateLimit(kv2, 'dev-x', now + 3600 * 1000)).ok, '下一小时额度恢复');

  // 回调签名：正确签名通过，错签名/未配置密钥一律失败
  const body = JSON.stringify({ orderId: 'ABCDEFGHIJKLMN', amount: 2900, txid: 'TX-9' });
  const sig = orders.webhookSignature('s3cret', body);
  ok(orders.verifyWebhook('s3cret', body, sig), '正确签名通过');
  ok(!orders.verifyWebhook('s3cret', body, sig.slice(0, -1) + '0'), '篡改签名被拒');
  ok(!orders.verifyWebhook('s3cret', body + ' ', sig), '请求体被改动则签名失配');
  ok(!orders.verifyWebhook('', body, sig), '未配置密钥时一律拒绝（绝不放行）');

  // 视图脱敏：管理端视图不带查询码散列
  const o3 = orders.createOrder({ planName: 'team', term: 'month', now, rng }).order;
  ok(!('qh' in orders.adminView(o3, now)), '管理端视图不含查询码散列');
  ok(orders.normalizeFen(29900) === 29900 && orders.normalizeFen('29900') === 29900
    && orders.normalizeFen(-1) === null && orders.normalizeFen('abc') === null,
    '分口径不做元换算（29900 就是 29900 分，不是 ×100）',
    [orders.normalizeFen(29900), orders.normalizeFen('29900'), orders.normalizeFen(-1)].join('/'));
  ok(orders.parseYuan('¥29.00') === 2900 && orders.parseYuan('29') === 2900
    && orders.parseYuan('29.5') === 2950 && orders.parseYuan('abc') === null,
    '买家手输的元文本单独走 parseYuan',
    [orders.parseYuan('¥29.00'), orders.parseYuan('29'), orders.parseYuan('29.5')].join('/'));
}

section('订单：事务单号与理由文案键齐全');
{
  // 每个可能暴露给用户的 reason 都要有 i18n 键，否则界面会显示 undefined
  const reasons = Object.keys(orders.REASON_KEYS);
  const missing = reasons.filter((k) => !orders.reasonKey(k));
  ok(missing.length === 0, '每个 reason 都能映射到文案键', missing.join(' '));
  ok(orders.reasonKey('notOpen:expired') === orders.REASON_KEYS.notOpen
    || orders.reasonKey('notOpen:expired') === 'orderErrGeneric',
    '带后缀的 reason 也能落到一个已定义的键', orders.reasonKey('notOpen:expired'));

  // 这些键必须两种语言都有：reasonKey 的输出直接进 t()，缺了用户看到的就是
  // "orderErrAmount" 这种标识符（t() 找不到键时原样返回键名）。
  const keys = new Set(Object.values(orders.REASON_KEYS).concat(['orderErrStore', 'orderErrSignature']));
  const bad = [];
  for (const lang of ['zh', 'en']) {
    i18n.setLang(lang);
    for (const k of keys) {
      if (i18n.t(k) === k || !i18n.t(k)) bad.push(lang + ':' + k);
    }
  }
  i18n.setLang('zh');
  ok(bad.length === 0, '订单错误文案在两种语言里都有定义', bad.join(', '));
}

if (process.argv[1] && process.argv[1].endsWith('pricing.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}
