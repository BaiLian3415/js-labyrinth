/**
 * Vercel 函数的共用入口。
 *
 * api/*.js 只是几个一行转发（Vercel 按文件建函数，所以每个路由要有一个文件），
 * 真正的逻辑都在这里：把 Vercel 的请求交给平台无关的 API handler
 * （server/handler.js），再把它返回的 Response 按 Vercel 免费档的约束加工一遍：
 *
 *   1. 上传侧预检：请求体大小、单次上传上限、当前预设的单次上限——超了直接回
 *      可读的 413，而不是让平台丢一句 `FUNCTION_PAYLOAD_TOO_LARGE`；
 *   2. 预算记账：全网每日 CPU 预算（默认 300 s，见 src/host-limits.js）用云存储
 *      累计，用尽即 503，避免把免费档的月度 Active CPU 一次性烧穿；
 *   3. 回执侧：大回执流式返回（Vercel 的 4.5 MB 回执上限对流式不适用），
 *      只留一道自家护栏（默认 64 MiB）；
 *   4. /api/health 上补宿主信息（host / store / envelope / budget），界面的诊断
 *      面板据此显示"云端到底挂在哪、还剩多少预算"；
 *   5. /api/plans 强写 web.cloudOnly=true：Vercel 构建走 build:web:cloud，产物里
 *      没有混淆核心，界面只能走 /api/obfuscate。
 *
 * 云存储（授权记录与每日用量）走 vercel/store.js：Upstash Redis REST，没配就退化为
 * 单实例内存，并在 /api/health 里明说。
 */
import handler from '../server/handler.js';
import platform from '../src/platform.js';
import i18n from '../src/i18n.js';
import hostLimits from '../src/host-limits.js';
import { createStore } from './store.js';

const { t } = i18n;
const { HOST, effectiveHost, estimateCost, presetInputCap, formatBytes } = hostLimits;

/** 回执超过这个长度才走流式；小回执直接给，省一层开销。 */
const STREAM_THRESHOLD_BYTES = 262144;

/** 本次请求的语言（优先级与 server/handler.js 的 resolveLang 一致）。 */
function langOf(request, env) {
  const explicit = String(request.headers.get('X-JSLB-Lang') || '').trim().toLowerCase();
  if (explicit === 'zh' || explicit === 'en') return explicit;
  const accept = String(request.headers.get('accept-language') || '').toLowerCase();
  for (const part of accept.split(',')) {
    const tag = part.split(';')[0].trim();
    if (tag.startsWith('zh')) return 'zh';
    if (tag.startsWith('en')) return 'en';
  }
  return (env && env.JSLABYRINTH_LANG) === 'en' ? 'en' : 'zh';
}

/**
 * 本次请求生效的 env，供 jsonResponse 取 CORS 配置。
 *
 * 刻意做成模块级而不是逐个传参：jsonResponse 有 7 个调用点（4 个上传/输出预检
 * 413、CPU 预算 503、兜底 500、重写的 /api/health），逐个传 env 迟早会漏一个，
 * 而漏掉的表现是跨域调用方只看到不透明的网络错误——精心写好的中文提示根本没机会
 * 送达。JSLB_CORS_ORIGIN 是部署期常量（不是请求期变量），所以并发请求读到同一个值
 * 是安全的；真正按请求变化的东西都不走这里。
 */
let currentEnv = {};

/** 设置本次请求的 env。buildEnv 里调用。 */
function setCurrentEnv(env) { currentEnv = env || {}; }

function jsonResponse(body, status, extraHeaders) {
  return new Response(JSON.stringify(body, null, 2), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      // 跨域头默认带上：/api/plans 与 /api/obfuscate 是靠复制 handler 的 res.headers
      // 顺带保住的，而这里这 7 个响应走的是本函数，原来一个都没带。
      ...handler.corsHeaders(currentEnv),
      ...(extraHeaders || {}),
    },
  });
}

/** 今日 UTC 日期，做预算键。跨实例必须一致，所以不用本地时区。 */
function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function budgetKey() {
  return 'jslb:cloud:cpu:' + dayKey();
}

/** 拿当前已用的预算秒数（无持久化存储时返回 null）。 */
async function budgetUsedSeconds(store) {
  if (!store || store.kind === 'memory') return null;
  const raw = await store.kv.get(budgetKey());
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n / 1000) : 0;
}

/** 预占 / 退回预算（毫秒）。返回预占后的总毫秒数，失败返回 null。 */
async function budgetAdd(store, deltaMs) {
  if (!store) return null;
  const next = await store.addNumber(budgetKey(), Math.round(deltaMs));
  return Number.isFinite(next) ? next : null;
}

/** 把一段文本按块写成流式回执：Vercel 的 4.5 MB 回执上限对流式不适用。 */
function streamText(text, res) {
  const bytes = new TextEncoder().encode(text);
  const chunk = 262144;
  const stream = new ReadableStream({
    start(controller) {
      for (let off = 0; off < bytes.length; off += chunk) {
        controller.enqueue(bytes.subarray(off, Math.min(bytes.length, off + chunk)));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: res.status, headers: new Headers(res.headers) });
}

/** 准备一次调用要用的 env（注入云存储与宿主标记）。 */
function buildEnv() {
  const env = { ...(typeof process !== 'undefined' ? process.env : {}) };
  const store = createStore(env);
  if (store.kv) env.JSLB_KV = store.kv;
  env.JSLB_HOST = HOST.id;
  return { env, store };
}


/**
 * 上传侧预检。只对会带请求体的 POST 生效。
 * @param {object} body 已解析的请求体（解析失败为 null）
 * @param {string} text 原始请求体文本
 * @param {object} host 生效包络
 * @returns {{ok:boolean, response?:Response, codeBytes?:number}}
 */
function preflightUpload(body, text, host) {
  const rawBytes = platform.byteLength(text || '');
  if (rawBytes > HOST.requestBodyBytes) {
    return {
      ok: false,
      response: jsonResponse({
        ok: false,
        status: 413,
        message: t('hostUploadTooBig', {
          size: formatBytes(rawBytes), limit: formatBytes(HOST.requestBodyBytes), host: HOST.display,
        }),
      }, 413),
    };
  }
  const code = body && typeof body.code === 'string' ? body.code : '';
  const codeBytes = code ? platform.byteLength(code) : 0;
  if (codeBytes && codeBytes > host.maxUploadBytes) {
    return {
      ok: false,
      response: jsonResponse({
        ok: false,
        status: 413,
        message: t('hostUploadTooBig', {
          size: formatBytes(codeBytes), limit: formatBytes(host.maxUploadBytes), host: HOST.display,
        }),
      }, 413),
    };
  }
  // 预设线：只有客户端显式给了预设才判。不给时用的授权自带预设要等授权结果，
  // 那一步由 runJob 的套餐闸门与 CPU 预算兜底（预算按最贵的预设预占）。
  const preset = body && body.options && typeof body.options === 'object' ? body.options.preset : '';
  if (codeBytes && preset) {
    const cap = presetInputCap(preset, host);
    if (codeBytes > cap) {
      const cost = hostLimits.costOf(preset);
      return {
        ok: false,
        response: jsonResponse({
          ok: false,
          status: 413,
          message: t('hostPresetCap', {
            preset: String(preset),
            limit: formatBytes(cap),
            ratio: cost.inflation,
            cost: cost.msPerKb + ' ms/KB',
          }),
        }, 413),
      };
    }
  }
  return { ok: true, codeBytes };
}

/**
 * 真正的处理：Web Request → Web Response。
 * @param {Request} request 请求
 * @returns {Promise<Response>} 响应
 */
async function handle(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/api';
  const { env, store } = buildEnv();
  // 必须在任何 jsonResponse 之前：上传预检、预算 503、兜底 500、重写的 health
  // 都要从这里取 CORS 配置。
  setCurrentEnv(env);
  const host = effectiveHost((name) => env[name]);
  i18n.setLang(langOf(request, env));

  if (request.method === 'OPTIONS') {
    return handler.fetch(request, env, {});
  }

  const isObfuscate = path === '/api/obfuscate' && request.method === 'POST';
  let forwarded = request;
  let reservedMs = 0;

  if (isObfuscate) {
    // 请求体只能读一次：读出来自己判完，再把同一份文本重新包成 Request 交给下游。
    const text = await request.text().catch(() => '');
    let body = null;
    try { body = JSON.parse(text); } catch (e) { body = null; }
    const pre = preflightUpload(body, text, host);
    if (!pre.ok) return pre.response;

    // CPU 预算：按估算先预占，跑完只在失败时退回（成功就按估算入账）。
    // 预占是必须的：并发请求同时通过检查会让预算形同虚设。
    const preset = String((body && body.options && body.options.preset) || 'max').toLowerCase();
    const estimate = estimateCost(preset, pre.codeBytes || 0);
    reservedMs = estimate.ms;
    const usedMs = await budgetAdd(store, reservedMs);
    if (usedMs !== null && usedMs > host.dailyCpuSeconds * 1000) {
      await budgetAdd(store, -reservedMs);
      return jsonResponse({
        ok: false,
        status: 503,
        message: t('hostBudgetExhausted', { cpu: host.dailyCpuSeconds }),
      }, 503);
    }
    forwarded = new Request(request.url, { method: 'POST', headers: request.headers, body: text });
  }

  let res;
  try {
    res = await handler.fetch(forwarded, env, {});
  } catch (e) {
    if (reservedMs) await budgetAdd(store, -reservedMs);
    return jsonResponse({ ok: false, message: (e && e.message) || String(e) }, 500);
  }

  // ---- /api/health：补上宿主信息 ----
  if (path === '/api/health' && res.ok) {
    const data = await res.json().catch(() => ({}));
    const usedSeconds = await budgetUsedSeconds(store);
    return jsonResponse({
      ...data,
      runtime: 'vercel',
      engine: 'vercel-functions',
      host: HOST.id,
      hostDisplay: HOST.display,
      store: store.kind,
      storeNote: store.note || '',
      envelope: hostLimits.describe(host),
      budget: usedSeconds === null
        ? { used: null, total: host.dailyCpuSeconds, persistent: false }
        : { used: usedSeconds, total: host.dailyCpuSeconds, persistent: true },
    }, 200);
  }

  // ---- /api/plans：Vercel 部署恒为云端执行 ----
  // 本部署的构建命令是 build:web:cloud，dist 里根本没有混淆核心，界面只能走
  // /api/obfuscate。cloudOnly 在这里强写而不是沿用 JSLB_WEB_CONFIG：配置漏写会让
  // 界面去 import 一个不存在的 ./src/index.js（404），比配置缺失本身更难排查。
  if (path === '/api/plans' && res.ok) {
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    if (data && data.web) {
      data.web = { ...data.web, cloudOnly: true };
      return new Response(JSON.stringify(data, null, 2), {
        status: res.status,
        headers: new Headers(res.headers),
      });
    }
    return new Response(text, { status: res.status, headers: new Headers(res.headers) });
  }

  // ---- /api/obfuscate：失败退预算、回执护栏、大回执走流式 ----
  if (isObfuscate) {
    const text = await res.text().catch(() => '');
    let body = null;
    try { body = JSON.parse(text); } catch (e) { body = null; }

    if (!(body && body.ok) && reservedMs) await budgetAdd(store, -reservedMs);

    if (body && body.ok && typeof body.code === 'string') {
      const outBytes = platform.byteLength(body.code);
      if (outBytes > host.maxResponseBytes) {
        return jsonResponse({
          ok: false,
          status: 413,
          message: t('hostOutputTooBig', {
            size: formatBytes(outBytes), limit: formatBytes(host.maxResponseBytes),
          }),
        }, 413);
      }
      if (outBytes > STREAM_THRESHOLD_BYTES) return streamText(text, res);
    }
    return new Response(text, { status: res.status, headers: new Headers(res.headers) });
  }

  return res;
}

/** Vercel 的 Web 签名：一个文件里导出各方法即可。 */
export async function GET(request) {
  return handle(request);
}

export async function POST(request) {
  return handle(request);
}

export async function OPTIONS(request) {
  return handle(request);
}

export default handle;
