/**
 * 服务端 JSON API 处理器（Vercel Functions 的实现层，见 vercel/entry.js）。
 *
 * 只提供 /api/* 五个端点：/api/obfuscate、/api/license、/api/plans、/api/health、
 * /api/machine。**静态界面不经过这里**——dist/ 由托管平台的 CDN 直接发；原先
 * "把非 /api 请求转给 ASSETS 绑定"那一路属于 Cloudflare 部署，已随之移除。
 *
 * /api/machine 负责发机器码：激活时客户端向它要一个，服务端按**卡密编号**登记
 * 后永久保存，同一张卡此后拿到的永远是同一个值（详见 license-web 的"机器码"一节）。
 *
 * 与浏览器共用同一份核心（src/**），因此相同输入、相同卡密在两端得到相同结果与
 * 相同拦截。计算位置由部署决定：Vercel 部署一律云端执行（web.cloudOnly），源码
 * 上传到 /api/obfuscate，由平台按免费档的请求体/CPU 上限强制（src/host-limits.js）。
 *
 * 授权：卡密经 X-JSLB-Key（或请求体 key）传入，设备码经 X-JSLB-Device 传入，
 * 缺失时回落到设备 cookie（/api/license 会种下它）。绑定 KV（变量名 JSLB_KV）
 * 后，试用/配额的每日计数跨请求持久化；未绑定时计数只在单次执行环境内有效。
 *
 * 卡密是 v5 对称格式（编号 + 加密信息段 + 校验码），服务端与浏览器共用同一把
 * 卡密密钥（内置，或用 JSLB_CODE_KEY 覆盖）。对称密钥随静态资源公开，拿到源码
 * 的人能自己造卡——真正的强制靠服务端：/api/obfuscate 逐请求校验 + KV 赎回登记
 * （一卡一机）；混淆核心**根本不在静态产物里**（构建走 build:web:cloud）。
 *
 * 请求示例：
 *   curl -X POST https://<host>/api/obfuscate \
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
    'access-control-allow-headers': 'content-type, x-jslb-key, x-jslb-device, x-jslb-lang',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

/**
 * 每个请求的环境准备：绑定注入、密钥覆盖、网页版策略、KV、设备码。
 *
 * 一个函数实例会连续、且可能并发地处理多个互不相干的请求，而 platform 与
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
  // 语言也必须逐请求设定：i18n 的 current 是模块级变量，一个实例会连续处理
  // 不同语言的请求（见 resolveLang 的说明）。
  i18n.setLang(resolveLang(request, env));
  licenseWeb.resetRequestState();
  // 无 KV 时服务端是无状态的：许可证与计数不跨请求保留，客户端每次都要带上
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
  // cookie 兜底：脚本调用方（curl、自写客户端）常常不带 X-JSLB-Device，
  // 而 /api/license 会种下 jslb_dev —— 有 cookie 就别把设备当成"新的"，
  // 否则同一台设备换个客户端就被当成新设备重新试用。
  const device = request.headers.get('X-JSLB-Device') || cookieDevice(request) || null;
  licenseWeb.setRequestDeviceId(device);
}

/**
 * 本次请求该用哪种语言回消息。
 *
 * 服务端文案原先只由**模块加载时**读到的 JSLABYRINTH_LANG 决定，于是界面切了英文的
 * 访问者拿到的报错仍是中文（`Activation failed: 激活失败: 未找到许可证文件` 这种
 * 中英夹杂），这是"license 英文未适配"的来源。
 *
 * 改为按请求判定，优先级：
 *   1. `X-JSLB-Lang` —— 界面自己带，值与用户在界面里选的语言严格一致
 *   2. `Accept-Language` —— 脚本 API / 直接 curl 的场景，浏览器也会自动带
 *   3. 环境变量 JSLABYRINTH_LANG，都没有则 zh（与改造前一致，不影响既有调用方）
 *
 * 只认 zh / en；其他取值一律回落，避免 i18n.setLang 抛错影响请求。
 * @param {Request} request 请求
 * @param {object} env 绑定
 * @returns {string} 'zh' 或 'en'
 */
function resolveLang(request, env) {
  const explicit = String(request.headers.get('X-JSLB-Lang') || '').trim().toLowerCase();
  if (explicit === 'zh' || explicit === 'en') return explicit;
  const accept = String(request.headers.get('accept-language') || '').toLowerCase();
  if (accept) {
    // 形如 "en-US,en;q=0.9,zh-CN;q=0.8"：按出现顺序取第一个认得出的主语言
    // （不解析 q 值——界面已经用显式头优先，这里只是给脚本调用一个合理默认）
    for (const part of accept.split(',')) {
      const tag = part.split(';')[0].trim();
      if (tag.startsWith('zh')) return 'zh';
      if (tag.startsWith('en')) return 'en';
    }
  }
  return (env && env.JSLABYRINTH_LANG) === 'en' ? 'en' : 'zh';
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
    // 卡密是严格一次性的：先恢复本设备已有授权——同一张卡在本设备激活过后，
    // KV 里留有有效记录，直接复用；重复 activate 会被赎回登记判成 'used'。
    // 只有记录缺失或已过期时才真正走激活（此时传的应是另一张未赎回的卡）。
    const had = await licenseWeb.restore({ selfAnchored: true });
    if (!had.ok) {
      const act = await licenseWeb.activate(key);
      if (!act.ok) {
        return json({
          ok: false,
          status: 401,
          message: t('webActivateFailed', { reason: t('licReason_' + act.reason) }),
        }, 401);
      }
    }
  } else {
    const ens = await licenseWeb.ensure({ selfAnchored: true });
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

/**
 * /api/machine：取某张卡密绑定的机器码，没有就签发一个并永久登记。
 *
 * 机器码不再由客户端的设备特征派生——那样换环境就变（Worker 里没有 navigator，
 * 派生出的值与浏览器永不相等，界面上就是"激活之后机器码变了"）。现在由服务端
 * 签发并与卡密绑定：同一张卡在任何设备、任何时间拿到的都是同一个值。
 *
 * 卡密必须合法（走 codec.parseCode 的校验码），认不出卡就无从绑定——机器码是
 * 绑在卡上的，不是绑在请求上的。
 */
async function handleMachine(request) {
  if (request.method !== 'POST') {
    return json({ ok: false, message: 'use POST with {key}' }, 405);
  }
  const body = await readBody(request);
  if (body === null) return json({ ok: false, message: 'invalid JSON body' }, 400);
  const key = request.headers.get('X-JSLB-Key') || body.key;
  if (!key) return json({ ok: false, message: 'missing key' }, 400);
  const r = await licenseWeb.machineForCode(key);
  if (!r.ok) {
    return json({ ok: false, message: t('licReason_' + r.reason) }, 400);
  }
  return json({
    ok: true,
    machine: r.machine,
    // issued 为真表示这次是首次签发（之前没有绑定），客户端可据此判断是不是新卡
    issued: !!r.issued,
    source: r.source || '',
  }, 200);
}

/** /api/license：查询或激活。 */
async function handleLicense(request) {
  if (request.method === 'GET') {
    await licenseWeb.ensure({ selfAnchored: true });
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
    await licenseWeb.ensure({ selfAnchored: true });
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
    // 与 /api/obfuscate 同口径：卡密严格一次性，本设备已有有效记录时直接复用，
    // 只在未激活（记录缺失或已过期）时才用这张卡走激活。
    const had = await licenseWeb.restore({ selfAnchored: true });
    if (!had.ok) {
      const act = await licenseWeb.activate(key);
      if (!act.ok) {
        return json({
          ok: false,
          status: 401,
          message: t('webActivateFailed', { reason: t('licReason_' + act.reason) }),
        }, 401);
      }
    }
  }
  await licenseWeb.ensure({ selfAnchored: true });
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
      engine: 'jslb-api',
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

  if (path === '/api/machine') {
    const res = await handleMachine(request);
    for (const [k, v] of Object.entries(corsHeaders(env))) res.headers.set(k, v);
    return res;
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
   * @param {object} env 绑定（含可选的 JSLB_KV 与密钥变量）
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

    // 非 /api 一律 404：静态界面由托管平台直接发（本部署是 dist/ 的 CDN），
    // 不再有"把请求转给 ASSETS 绑定"那一路——那是 Cloudflare 部署的做法，
    // 随 Cloudflare 部署一起移除了。留在这里是为了让误路由（比如把 /src/xxx.js
    // 打到函数上）得到一句可读的 404，而不是平台默认的 HTML 错误页。
    return json({ ok: false, message: 'not found: ' + url.pathname }, 404, corsHeaders(env));
  },
};
