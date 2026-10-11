#!/usr/bin/env node
'use strict';
/**
 * 购买订单管理工具（发卡方使用，不随最终用户分发）。
 *
 * 用途：把"买家提交了交易单号"的订单核验成"已收款并发卡"。两条路：
 *
 *   1) 走已部署的管理接口（推荐，不需要 Redis 凭据）
 *        JSLB_ADMIN_URL=https://your.site JSLB_ADMIN_TOKEN=xxx \
 *          node tools/issue/orders.js list
 *      也可以用 --api / --token 传，或 --api-token-file 从文件读。
 *
 *   2) 直连云存储（部署方手里有 Upstash/REDIS_URL 时，连站点都不用开）
 *        node tools/issue/orders.js list --kv
 *      凭据取自环境变量（KV_REST_API_URL/TOKEN、UPSTASH_*、REDIS_URL），
 *      与 vercel/store.js 认的那几组完全一致。
 *
 * 用法:
 *   node tools/issue/orders.js list [--status pending|claimed|paid|issued|rejected|expired]
 *   node tools/issue/orders.js get <订单号>
 *   node tools/issue/orders.js confirm <订单号> [--txid <单号>] [--amount <分>] [--note <备注>]
 *   node tools/issue/orders.js reject <订单号> --reason <原因>
 *
 * 选项:
 *   --api <url>        管理接口所在站点（默认 $JSLB_ADMIN_URL）
 *   --token <t>        管理令牌（默认 $JSLB_ADMIN_TOKEN）
 *   --kv               直连云存储，不走 HTTP
 *   --json             以 JSON 输出（便于脚本处理）
 *   -h, --help         帮助
 *
 * 为什么 confirm 还要 --amount：管理端确认时带上实收金额（单位**分**），服务端会与
 * 订单金额比对；不一致直接拒绝。人工核验最怕的就是"看着像就放行"，把金额变成必比对项
 * 能把"付了 1 分"这类挡在发卡之前。
 */

import orders from '../../src/orders.js';
import plan from '../../src/plan.js';
import pricing from '../../src/pricing.js';
import licenseWeb from '../../src/license-web.js';
import { createStore } from '../../vercel/store.js';

const HELP = `JsLabyrinth 订单管理（购买核验 / 发卡）

用法:
  node tools/issue/orders.js list [--status <状态>] [--kv]
  node tools/issue/orders.js get <订单号> [--kv]
  node tools/issue/orders.js confirm <订单号> [--txid <单号>] [--amount <分>] [--note <备注>] [--kv]
  node tools/issue/orders.js reject <订单号> --reason <原因> [--kv]

默认走管理接口（JSLB_ADMIN_URL + JSLB_ADMIN_TOKEN，或 --api/--token）。
加 --kv 则直连云存储（KV_REST_API_URL/TOKEN、UPSTASH_*、REDIS_URL）。

状态: ${orders.STATUSES.join(' | ')}
`;

/** 解析 "键 值" 形式的选项。 */
function parseArgs(argv) {
  const out = { _: [], json: false, kv: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-h': case '--help': out.help = true; break;
      case '--json': out.json = true; break;
      case '--kv': out.kv = true; break;
      case '--api': out.api = next(); break;
      case '--token': out.token = next(); break;
      case '--status': out.status = next(); break;
      case '--txid': out.txid = next(); break;
      case '--amount': out.amount = next(); break;
      case '--note': out.note = next(); break;
      case '--reason': out.reason = next(); break;
      default:
        if (a.startsWith('-')) { console.error('未知选项 "' + a + '"（用 --help 查看用法）'); process.exit(1); }
        out._.push(a);
    }
  }
  return out;
}

/** 调管理接口。返回 {ok, status, data}。 */
async function callAdmin(opts, body) {
  const base = String(opts.api || process.env.JSLB_ADMIN_URL || '').replace(/\/+$/, '');
  const token = String(opts.token || process.env.JSLB_ADMIN_TOKEN || '');
  if (!base) {
    console.error('缺少管理接口地址：用 --api 或环境变量 JSLB_ADMIN_URL 指定（或加 --kv 直连存储）。');
    process.exit(1);
  }
  if (!token) {
    console.error('缺少管理令牌：用 --token 或环境变量 JSLB_ADMIN_TOKEN 指定。');
    process.exit(1);
  }
  const res = await fetch(base + '/api/admin-order', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok && data && data.ok, status: res.status, data };
}

/** 直连存储路径：用与线上同一份 src/orders.js 逻辑。 */
async function withKv(fn) {
  const store = createStore(process.env);
  if (!store.kv || store.kind === 'memory') {
    console.error('直连模式需要云存储凭据（KV_REST_API_URL/TOKEN、UPSTASH_* 或 REDIS_URL）。');
    console.error('当前解析到的存储类型: ' + store.kind + (store.note ? '（' + store.note + '）' : ''));
    process.exit(1);
  }
  return fn(store.kv);
}

/** 状态本地化（中文，与网页版的中文口径一致）。 */
function statusText(status) {
  return {
    pending: '待付款', claimed: '待核验', paid: '已确认收款',
    issued: '已发卡', rejected: '已拒绝', expired: '已过期',
  }[status] || status;
}

/** 一行摘要，供列表与人类阅读。 */
function line(o) {
  const amt = '¥' + pricing.formatFen(o.amount, true);
  const when = new Date(o.createdAt || 0).toISOString().replace('T', ' ').slice(0, 16);
  const claim = o.claim ? ' 单号=' + o.claim.txid : '';
  return [
    o.id, pad(statusText(o.status), 10), pad(plan.displayName(o.plan), 9),
    pad(o.term, 9), pad(amt, 10), when + claim,
  ].join(' ');
}

/** 按显示宽度补齐（中文占两列）。 */
function pad(s, width) {
  let w = 0;
  for (const ch of String(s)) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return String(s) + ' '.repeat(Math.max(0, width - w));
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help || !opts._.length) { console.log(HELP); return; }
  const cmd = String(opts._[0]).toLowerCase();
  const id = (opts._[1] || '').toUpperCase();

  const finish = (result) => {
    if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
    if (!result.ok) {
      console.error('失败: ' + ((result.data && result.data.message) || result.data && result.data.reason || ('HTTP ' + result.status)));
      process.exit(1);
    }
    const data = result.data || {};
    if (data.orders) {
      if (!data.orders.length) { console.log('（没有匹配的订单）'); return; }
      console.log(pad('订单号', 16) + pad('状态', 12) + pad('套餐', 11) + pad('周期', 11) + pad('金额', 12) + '创建时间 / 单号');
      for (const o of data.orders) console.log(line(o));
      console.log('\n共 ' + data.orders.length + ' 张');
      return;
    }
    if (data.order) {
      console.log(line(data.order));
      if (data.key) console.log('\n卡密: ' + data.key);
      if (data.order.claim) console.log('凭证: 单号=' + data.order.claim.txid
        + (data.order.claim.amount === null ? '' : ' 金额=' + data.order.claim.amount + ' 分')
        + (data.order.claim.payer ? ' 付款人=' + data.order.claim.payer : ''));
      return;
    }
    console.log(JSON.stringify(data));
  };

  if (cmd === 'list') {
    const body = { action: 'list', status: opts.status || '' };
    finish(opts.kv
      ? await withKv(async (kv) => {
        const ids = await orders.indexList(kv);
        const list = [];
        for (const one of ids) {
          const o = await orders.loadOrder(kv, one);
          if (!o) continue;
          const v = orders.adminView(o, Date.now());
          if (body.status && v.status !== body.status) continue;
          list.push(v);
        }
        return { ok: true, status: 200, data: { ok: true, orders: list, count: list.length } };
      })
      : await callAdmin(opts, body));
    return;
  }

  if (cmd === 'get') {
    if (!id) { console.error('需要订单号'); process.exit(1); }
    finish(opts.kv
      ? await withKv(async (kv) => {
        const o = await orders.loadOrder(kv, id);
        return o
          ? { ok: true, status: 200, data: { ok: true, order: orders.adminView(o, Date.now()) } }
          : { ok: false, status: 404, data: { ok: false, reason: 'notFound' } };
      })
      : await callAdmin(opts, { action: 'get', id }));
    return;
  }

  if (cmd === 'confirm') {
    if (!id) { console.error('需要订单号'); process.exit(1); }
    // 令牌：让签发密钥与浏览器端同源（部署方用 JSLB_CODE_KEY 覆盖时尤其重要）
    licenseWeb.loadKeysFromEnv();
    finish(opts.kv
      ? await withKv(async (kv) => {
        const o = await orders.loadOrder(kv, id);
        if (!o) return { ok: false, status: 404, data: { ok: false, reason: 'notFound' } };
        const paid = orders.applyPayment(o, {
          txid: opts.txid, amount: orders.normalizeFen(opts.amount), paidAt: '', source: 'admin-cli', note: opts.note,
        }, Date.now());
        if (!paid.ok) return { ok: false, status: 409, data: { ok: false, reason: paid.reason } };
        const txid = orders.normalizeTxid(opts.txid || (o.claim && o.claim.txid));
        if (txid && !(await orders.claimTxid(kv, txid, o.id))) {
          return { ok: false, status: 409, data: { ok: false, reason: 'txidUsed' } };
        }
        const issued = orders.issueKey(o, { keyB64: licenseWeb.activeCodeKey() });
        if (!issued.ok) return { ok: false, status: 500, data: { ok: false, reason: issued.reason } };
        await orders.saveOrder(kv, o);
        return { ok: true, status: 200, data: { ok: true, order: orders.adminView(o, Date.now()), key: issued.key, fresh: issued.fresh } };
      })
      : await callAdmin(opts, {
        action: 'confirm', id, txid: opts.txid,
        amount: opts.amount === undefined ? undefined : orders.normalizeFen(opts.amount),
        note: opts.note,
      }));
    return;
  }

  if (cmd === 'reject') {
    if (!id) { console.error('需要订单号'); process.exit(1); }
    finish(opts.kv
      ? await withKv(async (kv) => {
        const o = await orders.loadOrder(kv, id);
        if (!o) return { ok: false, status: 404, data: { ok: false, reason: 'notFound' } };
        const rej = orders.rejectOrder(o, opts.reason || '', Date.now());
        if (!rej.ok) return { ok: false, status: 409, data: { ok: false, reason: rej.reason } };
        await orders.saveOrder(kv, o);
        return { ok: true, status: 200, data: { ok: true, order: orders.adminView(o, Date.now()) } };
      })
      : await callAdmin(opts, { action: 'reject', id, reason: opts.reason }));
    return;
  }

  console.error('未知子命令 "' + cmd + '"（用 --help 查看用法）');
  process.exit(1);
}

main(process.argv.slice(2)).catch((e) => {
  console.error('执行失败: ' + ((e && e.message) || e));
  process.exit(1);
});
