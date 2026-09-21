/**
 * Cloudflare Worker 入口（同时也被 Pages Functions 复用，见 functions/api/[[path]].js）。
 *
 * 两条路都提供：
 *   静态资源   绑定 ASSETS 时，非 /api/ 的请求原样交给静态资源（网页界面就在那里）；
 *   JSON API   /api/obfuscate、/api/license、/api/plans、/api/health。
 *
 * 与浏览器内执行共用同一份核心（src/**），因此相同输入、相同卡密在两端得到
 * 相同结果与相同拦截。区别只在计算位置：Worker 有 CPU 时间上限（免费版 10 ms，
 * 付费版 30 s，可用 limits.cpu_ms 调高），大文件建议走浏览器内执行；
 * 浏览器内跑的是用户自己的 CPU，代码也不出本机。
 *
 * 授权：卡密经 X-JSLB-Key（或请求体 key）传入，设备码经 X-JSLB-Device 传入。
 * 绑定 KV（变量名 JSLB_KV）后，试用/配额的每日计数跨请求持久化；未绑定时
 * 计数只在单个 isolate 内有效，等于不限次。
 *
 * 卡密是 Ed25519 签名，Worker 只持**公钥**（内置，或用 JSLB_PUBLIC_KEY 覆盖成
 * 部署方自己的公钥）——它只能验签，签不出新卡。签发私钥留在签发方，绝不进
 * Worker。所以即使整个 Worker 的源码与静态资源都被爬走，也伪造不出卡密。
 *
 * 请求示例：
 *   curl -X POST https://<worker>/api/obfuscate \
 *     -H 'content-type: application/json' \
 *     -H 'X-JSLB-Key: JSLB-...' -H 'X-JSLB-Device: <32 位 hex 设备码>' \
 *     -d '{"code":"console.log(1)","options":{"preset":"medium","seed":42}}'
 */
import platform from '../src/platform.js';
import licenseWeb from '../src/license-web.js';
import pipeline from '../src/pipeline.js';
import plan from '../src/plan.js';
import i18n from '../src/i18n.js';
import { VERSION } from '../src/version.js';

const { runJob } = pipeline;
const { t } = i18n;

/**
 * 需要鉴权才能下载的核心产物：混淆算法本体。
 *
 * 界面是原生 ESM，`src/**` 整棵模块树都必须能被浏览器取到，于是默认任何人都能顺着
 * index.html 里的 modulepreload 清单把实现整个爬走。这里按路径挡一道：未激活设备
 * 拿不到算法，只能拿到页面外壳与授权链路。
 *
 * 只挡"算法本体"这六个入口，其余模块（options / presets / plan / license-* / i18n /
 * platform / utils / options-meta / options-gate）保持公开——界面要靠它们渲染出
 * 激活表单，否则未激活用户永远走不到激活那一步（这是第一版全挡 /src/ 时的死锁）。
 * 前提是 `web/app.js` 已经把核心改成激活后 `import('./src/index.js')`。
 *
 * 只对 Workers 生效——Pages 的静态资源不经过这个函数（functions/ 只匹配 /api/*）。
 */
const GATED_PREFIXES = [
  '/src/index.js',
  '/src/obfuscate.js',
  '/src/pipeline.js',
  '/src/html.js',
  '/src/passes/',
  '/src/ast/',
];

/** 是否开启核心下载鉴权。默认关，部署方显式开启。 */
function gateCoreOn(env) {
  const v = env && env.JSLB_GATE_CORE;
  return (v === true || v === 'true') && env && env.ASSETS;
}

/**
 * 设备 cookie。
 *
 * 浏览器的模块请求是同源普通 GET，**不会**带 `X-JSLB-Device` 这种自定义头
 * （ESM 的 import 没法加头），只有 cookie 会自动带上。所以鉴权身份走 cookie。
 */
function deviceCookie(request, dev) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return 'jslb_dev=' + encodeURIComponent(dev)
    + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000' + secure;
}

/** 从 cookie 里取设备码。 */
function cookieDevice(request) {
  const raw = request.headers.get('cookie') || '';
  const m = /(?:^|;\s*)jslb_dev=([^;]*)/.exec(raw);
  return m ? decodeURIComponent(m[1]) : null;
}

/** JSON 响应。 */
function json(body, status, extraHeaders) {
  return new Response(JSON.stringify(body, null, 2), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(extraHeaders || {}),
    },
  });
}

/** 允许跨域时的响应头。JSLB_CORS_ORIGIN 未设置时用 *（纯 API 用法需要）。 */
function corsHeaders(env) {
  const origin = (env && env.JSLB_CORS_ORIGIN) || '*';
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-jslb-key, x-jslb-device',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

/**
 * 每个请求的环境准备：绑定注入、密钥覆盖、网页版策略、KV、设备码。
 *
 * 一个 isolate 会连续、且可能并发地处理多个互不相干的请求，而 platform 与
 * license-web 的状态都是模块级的。这里逐请求把状态清干净，否则上一请求的
 * 授权（甚至别人的许可证记录）会留给下一请求：
 *
 *   resetRequestState()  清掉授权状态、设备码缓存
 *   setStorage(...)      换一份独立的内存存储，不与其他请求共用 Map
 *   setKv(...)           有 KV 时按设备码加前缀，避免整站共用一条记录
 */
function prepareEnv(env, request) {
  platform.setEnv(env || {});
  platform.loadWebConfigFromEnv();
  licenseWeb.resetRequestState();
  // 无 KV 时 Worker 是无状态的：许可证与计数不跨请求保留，客户端每次都要带上
  // 卡密（见 /api/obfuscate）。绑 KV 后按设备码持久化，语义与浏览器侧一致。
  platform.setStorage(platform.newMemoryStorage());
  licenseWeb.loadKeysFromEnv();
  const kv = env && env.JSLB_KV;
  // del 必须一起给：解除激活要靠它真正删掉 KV 里的许可证记录。只 put 空串的话
  // 键还在，下次请求 get 回来的是空串，客户端看起来像"清了又没完全清"。
  platform.setKv(kv ? {
    get: (key) => kv.get('jslb:' + key),
    put: (key, value) => kv.put('jslb:' + key, value),
    del: (key) => kv.delete('jslb:' + key),
  } : null);
  // cookie 兜底：浏览器侧的模块请求带不了自定义头，设备码只能从 cookie 拿
  const device = request.headers.get('X-JSLB-Device') || cookieDevice(request) || null;
  licenseWeb.setRequestDeviceId(device);
}

/** 请求体解析，失败时返回 null。 */
async function readBody(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    const data = JSON.parse(text);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch (e) {
    return null;
  }
}

/**
 * 授权状态快照，供 /api/license 与界面显示。
 * @returns {Promise<object>} 状态对象
 */
async function licenseState() {
  const ent = licenseWeb.entitlements();
  if (!ent) return { ok: false, trial: false, message: t('licReason_missing') };
  const q = await licenseWeb.quota();
  return {
    ok: true,
    trial: !!ent.trial,
    plan: ent.plan,
    display: ent.display,
    rank: ent.rank,
    preset: ent.preset,
    limits: ent.limits,
    // gates 必须一起回：界面拿它逐项标注被拦下的选项（optionsGate.checkOptions），
    // 少了这一项，部署方覆盖密钥时界面就画不出正确的闸门状态。
    gates: ent.gates,
    quota: q,
    machine: await licenseWeb.machineId(),
    banner: await licenseWeb.bannerText(),
    quotaText: await licenseWeb.quotaText(),
  };
}

/** /api/obfuscate */
async function handleObfuscate(request, env) {
  const body = await readBody(request);
  if (body === null) return json({ ok: false, message: 'invalid JSON body' }, 400);

  // 卡密也可以放在请求体里，方便不熟请求头的调用方
  const key = request.headers.get('X-JSLB-Key') || body.key;
  if (key) {
    const act = await licenseWeb.activate(key);
    if (!act.ok) {
      return json({
        ok: false,
        status: 401,
        message: t('webActivateFailed', { reason: t('licReason_' + act.reason) }),
      }, 401);
    }
  } else {
    const ens = await licenseWeb.ensure();
    if (!ens.ok) {
      return json({
        ok: false,
        status: 402,
        message: t('licFail', { reason: t('licReason_' + (ens.reason || 'missing')) }),
        needKey: true,
      }, 402);
    }
  }

  const ent = licenseWeb.entitlements();
  const r = await runJob({
    code: body.code,
    options: body.options && typeof body.options === 'object' ? body.options : {},
    type: body.type === 'html' || body.type === 'js' ? body.type : 'auto',
    ent,
    consumeRun: () => licenseWeb.consumeRun(),
  });
  if (!r.ok) {
    return json({ ok: false, status: r.status, message: r.message, upgrade: r.upgrade }, r.status);
  }
  return json({
    ok: true,
    code: r.code,
    stats: r.stats,
    originalSize: r.originalSize,
    obfuscatedSize: r.obfuscatedSize,
    html: r.html,
    info: r.info,
    warnings: r.warnings,
    quota: r.quota,
  }, 200);
}

/** /api/license：查询或激活。 */
async function handleLicense(request) {
  if (request.method === 'GET') {
    await licenseWeb.ensure();
    const dev = request.headers.get('X-JSLB-Device') || cookieDevice(request);
    return json(await licenseState(), 200, dev ? { 'set-cookie': deviceCookie(request, dev) } : {});
  }
  const body = await readBody(request);
  if (body === null) return json({ ok: false, message: 'invalid JSON body' }, 400);
  // 解除激活：清掉本设备的许可证记录与试用计数。绑了 KV 时这是唯一能让服务端
  // 忘记这台设备的办法——只清浏览器存储的话，下一次请求又会从 KV 恢复回来。
  //
  // 设备码来自 X-JSLB-Device，prepareEnv 已把它装进 license-web；缺了这个头，
  // 这里删的是无后缀的共享键，真正的设备记录原封不动。
  if (body.deactivate === true) {
    await licenseWeb.deactivate();
    await licenseWeb.ensure();
    // 解除之后状态本来就是"未激活"，licenseState() 会给出 ok:false；响应仍要
    // 标 ok:true，否则客户端把它当成请求失败，界面上会显示解除没生效。
    // 一并清掉设备 cookie，否则浏览器还会带着旧身份继续取核心模块
    const clearSecure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
    return json({ ...(await licenseState()), ok: true, deactivated: true }, 200, {
      'set-cookie': 'jslb_dev=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + clearSecure,
    });
  }

  // 补登记：客户端已经激活、服务端却没有这台设备的记录时，用它自己的许可证
  // 记录补上。
  //
  // 场景是界面激活走本地验签那条路（内置密钥认得卡密）就直接返回了，压根没把
  // 卡密发过来。核心模块按设备 cookie 下发，服务端 KV 里没记录 ⇒ cookie 指向
  // 一台"未授权设备" ⇒ 模块请求全部 403，界面上只看到一句动态 import 失败。
  //
  // 记录带签名且绑定机器码，这里用请求设备码派生出的机器码重新验一遍，所以
  // 换不来别人的授权，也改不动套餐与用量（那几项都在令牌载荷里）。
  if (body.record && typeof body.record === 'object') {
    const imp = await licenseWeb.importRecord(body.record);
    if (!imp.ok) {
      return json({ ok: false, status: 401, message: t('licReason_' + imp.reason) }, 401);
    }
  }

  const key = request.headers.get('X-JSLB-Key') || body.key;
  if (key) {
    const act = await licenseWeb.activate(key);
    if (!act.ok) {
      return json({
        ok: false,
        status: 401,
        message: t('webActivateFailed', { reason: t('licReason_' + act.reason) }),
      }, 401);
    }
  }
  await licenseWeb.ensure();
  // 激活成功后种下设备 cookie，后续 /src/** 的模块请求由浏览器自动带上。
  // 解除激活的那条分支不走这里——那边刚把记录删了，不该再发新 cookie。
  const dev = request.headers.get('X-JSLB-Device');
  return json(await licenseState(), 200, dev ? { 'set-cookie': deviceCookie(request, dev) } : {});
}

/** 路由分发。静态资源不在 /api/ 前缀下，由 Worker 的 assets 绑定接管。 */
async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/api';

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }

  if (path === '/api/health') {
    return json({
      ok: true,
      version: VERSION,
      runtime: platform.runtime,
      engine: 'cloudflare-worker',
      time: new Date().toISOString(),
    }, 200, corsHeaders(env));
  }

  if (path === '/api/plans') {
    // 套餐对照表是公开信息，发卡方的定价页可以直接取
    return json({
      ok: true,
      plans: plan.rows(),
      web: platform.getWebConfig(),
    }, 200, corsHeaders(env));
  }

  if (path === '/api/license') {
    const res = await handleLicense(request);
    for (const [k, v] of Object.entries(corsHeaders(env))) res.headers.set(k, v);
    return res;
  }

  if (path === '/api/obfuscate' && request.method === 'POST') {
    const res = await handleObfuscate(request, env);
    for (const [k, v] of Object.entries(corsHeaders(env))) res.headers.set(k, v);
    return res;
  }

  return json({ ok: false, message: 'not found: ' + path }, 404, corsHeaders(env));
}

export default {
  /**
   * @param {Request} request 请求
   * @param {object} env 绑定（含可选的 ASSETS、JSLB_KV 与密钥变量）
   * @param {object} ctx 执行上下文
   * @returns {Promise<Response>} 响应
   */
  async fetch(request, env, ctx) {
    prepareEnv(env, request);
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env);
      } catch (e) {
        // 未捕获异常统一成 JSON，避免把堆栈暴露给调用方
        return json({ ok: false, message: (e && e.message) || String(e) }, 500, corsHeaders(env));
      }
    }

    // 核心源码只对已激活设备开放。
    //
    // 代价要写在前面：每个模块请求都要读一次 KV（一次页面加载 = 五十来次读）。
    // 免费版 KV 是十万次读/天，够用但不宽裕；真上量了再改成带签名的短期票据
    // （cookie 里存过期时间戳，命中就跳过 KV）。
    if (gateCoreOn(env) && request.method === 'GET'
        && GATED_PREFIXES.some((p) => url.pathname.startsWith(p))) {
      const dev = cookieDevice(request);
      if (dev) licenseWeb.setRequestDeviceId(dev);
      const ens = await licenseWeb.ensure();
      if (!ens.ok) {
        return new Response('403 Forbidden — 核心模块仅对已激活设备开放\n', {
          status: 403,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
      const asset = await env.ASSETS.fetch(request);
      const headers = new Headers(asset.headers);
      // 必须 no-store：默认缓存会把某个已激活设备取到的源码留给后面的匿名请求
      headers.set('cache-control', 'private, no-store');
      return new Response(asset.body, { status: asset.status, headers });
    }

    // 静态资源：绑定时交给 assets，未绑定则给出提示
    if (env && env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }
    return new Response(
      'JsLabyrinth Worker 已就绪。API 见 /api/health；静态界面需要绑定 assets（见 wrangler.toml）。\n',
      { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  },
};
