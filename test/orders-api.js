#!/usr/bin/env node
/**
 * 购买服务的 HTTP 层：把 server/handler.js 当黑盒调（与线上同一份代码），
 * 覆盖状态码、鉴权、幂等、防重放、限流与"没配存储"的降级。
 *
 *   node test/orders-api.js
 *
 * 为什么要单独一组：src/orders.js 的单测只证明**规则**对，证明不了**接线**对——
 * 路由拿错参数、鉴权检查漏在某个分支上、状态码给成 200，这些都是纯逻辑测试看不见的。
 * 之前这些只能在临时脚本里跑（`npm test` 覆盖不到），所以固化成回归。
 *
 * 依赖：Node 的全局 Request/Response（与 Vercel 函数同一套 Web 标准接口），
 * KV 用内存实现，env 里塞令牌与回调密钥模拟配置好的部署。
 */
import { cleanTmp, ok, report, section } from './_harness.js';
import handler from '../server/handler.js';
import orders from '../src/orders.js';
import codec from '../src/license-codec.js';
import secret from '../src/license-secret.js';
import licenseWeb from '../src/license-web.js';
import platform from '../src/platform.js';

const ADMIN = 'test-admin-token';
const HOOK = 'test-hook-secret';

/** 内存 KV，契约与 vercel/store.js 一致。 */
function memKv() {
  const m = new Map();
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, String(v)); return true; },
    delete: async (k) => { m.delete(k); },
    _map: m,
  };
}

/** 建一个"已配置好"的部署环境。 */
function makeEnv(extra) {
  return {
    JSLB_KV: memKv(),
    JSLB_ADMIN_TOKEN: ADMIN,
    JSLB_PAY_WEBHOOK_SECRET: HOOK,
    JSLB_PAY_PAYEE: '测试收款方',
    ...(extra || {}),
  };
}

/** 调 handler，返回 {status, data}。默认带设备码（限流按它分桶）。 */
async function call(env, path, opts) {
  const o = opts || {};
  const headers = {
    'content-type': 'application/json',
    'x-jslb-device': o.device || 'dev-api-test',
    ...(o.headers || {}),
  };
  const res = await handler.fetch(new Request('https://unit.test' + path, {
    method: o.method || 'GET',
    headers,
    body: o.raw !== undefined ? o.raw : (o.body === undefined ? undefined : JSON.stringify(o.body)),
  }), env, {});
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  return { status: res.status, data, text };
}

const auth = { authorization: 'Bearer ' + ADMIN };

section('HTTP：价目表与建单');
const env = makeEnv();
{
  const pricing = await call(env, '/api/pricing');
  ok(pricing.status === 200 && pricing.data.ok, '/api/pricing 正常返回');
  const plans = pricing.data.plans || [];
  ok(plans.length >= 8, '价目表列出全部套餐', String(plans.length));
  const plus = plans.find((p) => p.name === 'plus');
  ok(plus && plus.prices.length === 3 && plus.prices[0].fen === 2900,
    'plus 有三个周期价且月付 2900 分', plus ? JSON.stringify(plus.prices.map((x) => x.term + ':' + x.fen)) : '');
  ok(pricing.data.pay && pricing.data.pay.payee === '测试收款方'
    && pricing.data.pay.auto === true && pricing.data.pay.admin === true,
    '收款信息来自环境变量，自动回调/管理端标记为真', JSON.stringify(pricing.data.pay));

  const created = await call(env, '/api/order', { method: 'POST', body: { action: 'create', plan: 'plus', term: 'year' } });
  ok(created.status === 200 && created.data.ok, '建单成功', JSON.stringify(created.data).slice(0, 100));
  ok(typeof created.data.queryCode === 'string' && created.data.queryCode.length === orders.QUERY_LEN,
    '建单响应里带查询码（且只有这一次）', created.data.queryCode);
  ok(created.data.order.amount === 29900 && created.data.order.days === 365
    && created.data.order.amountText === '299.00', '金额与天数由服务端按价目表算出',
    created.data.order.amountText + '/' + created.data.order.days);
  ok(!('key' in created.data.order) || created.data.order.key === null, '新订单不带卡密');

  const id = created.data.order.id;
  const q = created.data.queryCode;

  // 取卡鉴权：订单号不是凭据
  const noQ = await call(env, '/api/order', { method: 'POST', body: { action: 'pickup', id } });
  ok(noQ.status === 403 && noQ.data.reason === 'badQuery', '不带查询码取卡被拒（403）', JSON.stringify(noQ.data));
  const badQ = await call(env, '/api/order?id=' + id + '&q=WRONGCODE1');
  ok(badQ.status === 403, 'GET 取卡错查询码被拒（403）');
  const okQ = await call(env, '/api/order?id=' + id + '&q=' + q);
  ok(okQ.status === 200 && okQ.data.order.status === 'pending' && !okQ.data.order.key,
    'GET 凭查询码可查状态但拿不到未签发的卡');

  // 非法组合：免费档、周期不匹配、未知套餐
  const free = await call(env, '/api/order', { method: 'POST', body: { action: 'create', plan: 'free', term: 'month' } });
  ok(free.status === 400 && free.data.reason === 'freePlan', '免费档不可下单（400）');
  const badTerm = await call(env, '/api/order', { method: 'POST', body: { action: 'create', plan: 'plus', term: 'once' } });
  ok(badTerm.status === 400 && badTerm.data.reason === 'termNotOffered', '周期与套餐族不匹配被拒');
  const noPlan = await call(env, '/api/order', { method: 'POST', body: { action: 'create', plan: 'nope', term: 'month' } });
  ok(noPlan.status === 400 && noPlan.data.reason === 'unknownPlan', '未知套餐被拒');
  const badAction = await call(env, '/api/order', { method: 'POST', body: { action: 'zzz' } });
  ok(badAction.status === 400 && badAction.data.reason === 'badAction', '未知动作被拒');

  // /api/plans 也要带价格与收款信息：老部署（只有 /api/plans、没有 /api/pricing）
  // 下定价页靠它回落，否则页面白屏而接口其实活着。
  const plansApi = await call(env, '/api/plans');
  ok(plansApi.status === 200 && Array.isArray(plansApi.data.plans) && plansApi.data.plans.length >= 8,
    '/api/plans 仍返回套餐对照表');
  ok(Array.isArray(plansApi.data.pricing) && plansApi.data.pricing.length >= 8
    && plansApi.data.pricing.find((p) => p.name === 'plus').prices.length === 3,
    '/api/plans 带上了价格（供定价页回落到单一接口）');
  ok(plansApi.data.pay && typeof plansApi.data.pay.qr === 'string',
    '/api/plans 带上了收款信息', JSON.stringify(plansApi.data.pay));

  // 提交凭证
  const badTx = await call(env, '/api/order', { method: 'POST', body: { action: 'claim', id, q, txid: 'x' } });
  ok(badTx.status === 400 && badTx.data.reason === 'badTxid', '非法交易单号被拒（400）');
  const claimNoQ = await call(env, '/api/order', { method: 'POST', body: { action: 'claim', id, q: 'WRONGCODE1', txid: '420000111111' } });
  ok(claimNoQ.status === 403, '不带查询码提交凭证被拒（403）——否则别人能拿订单号乱提交');
  const claim = await call(env, '/api/order', { method: 'POST', body: { action: 'claim', id, q, txid: '4200 0011 1111', payer: '买家' } });
  ok(claim.status === 200 && claim.data.order.status === 'claimed', '提交凭证成功（claimed）');

  // 管理端
  const noToken = await call(env, '/api/admin-order', { method: 'POST', body: { action: 'list' } });
  ok(noToken.status === 403 && noToken.data.reason === 'forbidden', '管理端无令牌 403');
  const wrongToken = await call(env, '/api/admin-order', { method: 'POST', body: { action: 'list' }, headers: { authorization: 'Bearer nope' } });
  ok(wrongToken.status === 403, '管理端错令牌 403');
  const list = await call(env, '/api/admin-order', { method: 'POST', body: { action: 'list', status: 'claimed' }, headers: auth });
  ok(list.status === 200 && list.data.orders.length === 1 && !('qh' in list.data.orders[0]),
    '管理端列表按状态过滤且不含查询码散列', JSON.stringify(list.data.count));
  const got = await call(env, '/api/admin-order', { method: 'POST', body: { action: 'get', id }, headers: auth });
  ok(got.status === 200 && got.data.order.claim.txid === '420000111111', '管理端详情含规范化后的交易单号');

  const mismatch = await call(env, '/api/admin-order', {
    method: 'POST', body: { action: 'confirm', id, txid: '420000999999', amount: 1 }, headers: auth,
  });
  ok(mismatch.status === 409 && mismatch.data.reason === 'amountMismatch', '金额不符拒绝发卡（409）');
  const confirmed = await call(env, '/api/admin-order', {
    method: 'POST', body: { action: 'confirm', id, amount: 29900 }, headers: auth,
  });
  ok(confirmed.status === 200 && confirmed.data.order.status === 'issued' && !!confirmed.data.key,
    '管理端确认后发卡并回传卡密');
  // 用**当前生效**的密钥解码，而不是内置常量 `secret.B64_CODE_KEY`：
  // 密钥是模块级状态，同一进程里别的测试（或部署的 JSLB_CODE_KEY）可能已经覆盖过它，
  // 而服务端签发用的正是"当前生效的那把"（licenseWeb.activeCodeKey）。
  // 这条断言单跑时能过、进全套就红过一次——原因就是两者不同源，而这恰恰是要守住的不变量。
  const parsed = codec.parseCode(licenseWeb.activeCodeKey(), confirmed.data.key);
  ok(parsed.ok && parsed.plan === 'plus' && parsed.days === 365,
    '发出去的卡密能被解码器解析（与浏览器端同源）', parsed.ok ? parsed.plan + '/' + parsed.days : parsed.reason);
  ok(licenseWeb.activeCodeKey() === secret.B64_CODE_KEY || parsed.ok,
    '签名密钥取的是当前生效的那把（被 JSLB_CODE_KEY 覆盖时也能解）');

  const again = await call(env, '/api/admin-order', {
    method: 'POST', body: { action: 'confirm', id, amount: 29900 }, headers: auth,
  });
  ok(again.status === 200 && again.data.fresh === false && again.data.key === confirmed.data.key,
    '重复确认幂等：同一张卡、fresh=false');

  const pickup = await call(env, '/api/order', { method: 'POST', body: { action: 'pickup', id, q } });
  ok(pickup.status === 200 && pickup.data.order.key === confirmed.data.key,
    '买家凭订单号 + 查询码自助取到同一张卡');
}

section('HTTP：防重放、限流、过期与降级');
{
  const env2 = makeEnv();
  // 交易单号复用：另一张订单用同一单号 → 409
  const a = await call(env2, '/api/order', { method: 'POST', body: { action: 'create', plan: 'team', term: 'month' } });
  const b = await call(env2, '/api/order', { method: 'POST', body: { action: 'create', plan: 'team', term: 'month' } });
  await call(env2, '/api/admin-order', { method: 'POST', body: { action: 'confirm', id: a.data.order.id, txid: 'TX-SHARED-1', amount: 9900 }, headers: auth });
  const reuse = await call(env2, '/api/admin-order', { method: 'POST', body: { action: 'confirm', id: b.data.order.id, txid: 'TX-SHARED-1', amount: 9900 }, headers: auth });
  ok(reuse.status === 409 && reuse.data.reason === 'txidUsed', '同一交易单号换订单被拒（409）');

  // 拒绝后不能再发卡
  const rej = await call(env2, '/api/admin-order', { method: 'POST', body: { action: 'reject', id: b.data.order.id, reason: '未收到款项' }, headers: auth });
  ok(rej.status === 200 && rej.data.order.status === 'rejected', '管理端可拒绝订单');
  const afterReject = await call(env2, '/api/admin-order', { method: 'POST', body: { action: 'confirm', id: b.data.order.id, amount: 9900 }, headers: auth });
  ok(afterReject.status === 409 && afterReject.data.reason === 'rejected', '被拒绝的订单发不出卡');

  // 过期：改写订单的 expiresAt 后提交凭证。
  //
  // 注意**不能**直接读 env.JSLB_KV：server/handler.js 的 prepareEnv 会把 KV 包一层
  // （键名前缀 jslb:，且只暴露 get/put/del）。测试要走同一层视图，否则读的是裸键、
  // 永远为空——第一版就是这么"读不到订单"的。platform.getKv() 正是那一层。
  const expiredEnv = makeEnv();
  const c = await call(expiredEnv, '/api/order', { method: 'POST', body: { action: 'create', plan: 'pack100', term: 'once' } });
  const view = platform.getKv();
  ok(!!view, '平台层 KV 视图可用（与线上同一层）');
  const stored = JSON.parse(await view.get(orders.keys.order(c.data.order.id)));
  stored.expiresAt = Date.now() - 1000;
  await view.put(orders.keys.order(c.data.order.id), JSON.stringify(stored));
  const lateClaim = await call(expiredEnv, '/api/order', {
    method: 'POST', body: { action: 'claim', id: c.data.order.id, q: c.data.queryCode, txid: 'TX-LATE-1' },
  });
  ok(lateClaim.status === 400 && String(lateClaim.data.reason).startsWith('notOpen'),
    '过期订单不再接受自助提交凭证', JSON.stringify(lateClaim.data.reason));

  // 限流：同一设备 11 单，第 11 单 429
  const rlEnv = makeEnv();
  let last = null;
  for (let i = 0; i < orders.MAX_ORDERS_PER_HOUR + 1; i++) {
    last = await call(rlEnv, '/api/order', { method: 'POST', body: { action: 'create', plan: 'plus', term: 'month' }, device: 'dev-rate' });
  }
  ok(last.status === 429 && last.data.reason === 'rateLimited',
    '同一设备每小时建单数被限流（第 ' + (orders.MAX_ORDERS_PER_HOUR + 1) + ' 单 429）', JSON.stringify(last.data));

  // 没配存储：503 而不是"建一张活不过实例的单"
  const noKvEnv = makeEnv({ JSLB_KV: null });
  const noStore = await call(noKvEnv, '/api/order', { method: 'POST', body: { action: 'create', plan: 'plus', term: 'month' } });
  ok(noStore.status === 503 && noStore.data.reason === 'noStore', '没配云存储时建单明确 503');
}

section('HTTP：收款回调（签名、金额、幂等）');
{
  const env3 = makeEnv();
  const created = await call(env3, '/api/order', { method: 'POST', body: { action: 'create', plan: 'business', term: 'year' } });
  const id = created.data.order.id;

  const noSig = await call(env3, '/api/pay-notify', { method: 'POST', raw: JSON.stringify({ orderId: id, amount: 299900 }) });
  ok(noSig.status === 401 && noSig.data.reason === 'badSignature', '无签名回调被拒（401）');

  const raw = JSON.stringify({ orderId: id, txid: '420000222222', amount: 299900, paidAt: '2026-10-11T10:00:00Z' });
  const sig = orders.webhookSignature(HOOK, raw);
  // 篡改必须**确定性**：原来写的是"末位换成 '0'"，而末位本来就是 '0' 时等于没篡改
  // （1/16 概率），于是那条请求真的通过了、还把卡发掉，连带下一条"自动发卡"也红。
  const flipped = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1);
  const bad = await call(env3, '/api/pay-notify', { method: 'POST', raw, headers: { 'x-jslb-signature': flipped } });
  ok(bad.status === 401, '篡改签名被拒', JSON.stringify(bad.data));

  const good = await call(env3, '/api/pay-notify', { method: 'POST', raw, headers: { 'x-jslb-signature': sig } });
  ok(good.status === 200 && good.data.ok && good.data.status === 'issued' && good.data.fresh === true,
    '签名正确即自动发卡');
  ok(!('key' in good.data) && !/JSLB-/.test(good.text), '回调响应不回卡密（卡密只经查询码交付）');

  const again = await call(env3, '/api/pay-notify', { method: 'POST', raw, headers: { 'x-jslb-signature': sig } });
  ok(again.status === 200 && again.data.fresh === false, '回调重放幂等（fresh=false，不会多签）');

  // 金额不符：换一张订单，回调报一个更小的金额
  const created2 = await call(env3, '/api/order', { method: 'POST', body: { action: 'create', plan: 'business', term: 'year' } });
  const raw2 = JSON.stringify({ orderId: created2.data.order.id, txid: '420000333333', amount: 1 });
  const sig2 = orders.webhookSignature(HOOK, raw2);
  const small = await call(env3, '/api/pay-notify', { method: 'POST', raw: raw2, headers: { 'x-jslb-signature': sig2 } });
  ok(small.status === 409 && small.data.reason === 'amountMismatch', '回调金额不符被拒（409）');

  // 未配置密钥的部署：即使自带签名也必须拒
  const noHookEnv = makeEnv({ JSLB_PAY_WEBHOOK_SECRET: '' });
  const open = await call(noHookEnv, '/api/pay-notify', { method: 'POST', raw: JSON.stringify({ orderId: 'X' }), headers: { 'x-jslb-signature': 'anything' } });
  ok(open.status === 401, '未配置回调密钥时，任何回调都被拒（绝不放行）');

  // 不存在的订单
  const raw3 = JSON.stringify({ orderId: 'NOSUCHORDER123', amount: 1 });
  const ghost = await call(env3, '/api/pay-notify', {
    method: 'POST', raw: raw3, headers: { 'x-jslb-signature': orders.webhookSignature(HOOK, raw3) },
  });
  ok(ghost.status === 404, '回调指向不存在的订单返回 404');
}

if (process.argv[1] && process.argv[1].endsWith('orders-api.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}
