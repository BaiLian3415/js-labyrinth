/**
 * 服务端 JSON API 处理器（Vercel Functions 的实现层，见 vercel/entry.js）。
 *
 * 只提供 /api/* 六个端点：/api/obfuscate、/api/license、/api/plans、/api/health、
 * /api/machine、/api/free-key。静态界面不经过这里——dist/ 由托管平台的 CDN
 * 直接发；原先"把非 /api 请求转给 ASSETS 绑定"那一路属于 Cloudflare 部署，
 * 已随之移除。
 *
 * /api/machine 负责发机器码（旧客户端/老卡路径）：激活时客户端向它要一个，
 * 服务端按卡密编号登记后永久保存，同一张卡此后拿到的永远是同一个值。
 * /api/free-key 负责网页自动派发：按客户端硬件机器码（X-JSLB-Machine）一机
 * 一张签发 7 天 Free 卡，卡号由机器码确定性派生，防刷卡密（详见 license-web
 * 的 issueFreeKey 与"机器码"一节）。
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
 * （一卡一机）；混淆核心根本不在静态产物里（构建走 build:web:cloud）。
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
import pricing from '../src/pricing.js';
import orders from '../src/orders.js';
import i18n from '../src/i18n.js';
import { VERSION } from '../src/version.js';
import { timingSafeEqualText } from '../src/utils/hash.js';

const { runJob } = pipeline;
const { t } = i18n;

/**
 * 设备 cookie。
 *
 * 浏览器的模块请求是同源普通 GET，不会带 `X-JSLB-Device` 这种自定义头
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
    'access-control-allow-headers': 'content-type, x-jslb-key, x-jslb-device, x-jslb-lang, x-jslb-machine',
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
 * 服务端文案原先只由模块加载时读到的 JSLABYRINTH_LANG 决定，于是界面切了英文的
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

  // 客户端手里的签名记录先补登记，与 /api/license 的补登记是同一个 licenseWeb
  // .importRecord（验签 + 自锚定机器码 + 赎回登记，一项都不少），只是把两步合成一步。
  //
  // 为什么必须有这一步：Vercel 函数是跨实例无状态的，没接云存储时授权记录只活在
  // 处理激活的那台实例的内存里。下一次请求换一台实例，服务端就"不认识"这台设备了，
  // 用户看到的是点「运行」时冒出一句 `激活失败: 未找到许可证文件`——明明刚激活过。
  // 记录在浏览器里、且带签名，服务端据此即可自助恢复；不补这一刀的话，这个部署形态
  // 下界面几乎不可用（只能靠用户反复重激活碰运气）。
  //
  // 失败不在这里报错：交给下面的 ensure() 统一判定（无效记录不会被写入，
  // 也就不可能因此放行任何东西）。
  //
  // importedOk 供下面的 trialOnly 判定：只有本次呈现的记录被成功采纳，才允许
  // 复用存储记录。呈现了无效记录 → 同样只能是试用，否则 restore 仍可能命中
  // 别人的残留记录（import 失败不写盘，但盘里可能早有别人的）。
  // 卡密也可以放在请求体里，方便不熟请求头的调用方
  const key = request.headers.get('X-JSLB-Key') || body.key;
  // 客户端提交的硬件机器码（见 /api/license 的同名说明）：激活时与卡密绑定，
  // 补登记时用来证明"呈上的记录属于本机"（见 license-web.importRecord）。
  const machine = request.headers.get('X-JSLB-Machine')
    || (typeof body.machine === 'string' ? body.machine : '');

  let importedOk = false;
  if (body.record && typeof body.record === 'object') {
    importedOk = (await licenseWeb.importRecord(body.record, { machine })).ok;
  }
  if (key) {
    // 卡密是严格一次性的：先恢复本设备已有授权——同一张卡在本设备激活过后，
    // KV 里留有有效记录，直接复用；重复 activate 会被赎回登记判成 'used'。
    // 只有记录缺失或已过期时才真正走激活（此时传的应是另一张未赎回的卡）。
    const had = await licenseWeb.restore({ selfAnchored: true });
    // 裸键串扰防护：复用的记录必须与出示的卡密是同一张卡。无设备头时所有请求
    // 共用同一存储键，暖实例上 restore() 会读到别的租户的记录；不校验就直接复用
    // 等于跨租户提权（2026-10-01 线上实测：Free 卡请求复用了 pack100 记录，
    // 闸门全被绕过）。不匹配时回落到 activate，由它报 401 原因。
    const reuse = had.ok && await licenseWeb.restoredMatchesKey(key);
    if (!reuse) {
      const act = await licenseWeb.activate(key, { machine });
      if (!act.ok) {
        return json({
          ok: false,
          status: 401,
          message: t('webActivateFailed', { reason: t('licReason_' + act.reason) }),
        }, 401);
      }
    }
  } else {
    // 本次呈现了有效记录（刚在上面 importRecord 成功采纳）才允许复用存储记录；
    // 既无卡密、又无有效记录 → 只能是试用，跳过 restore（同上，防裸键串扰）。
    // 注意：界面每次混淆都带 body.record（见上面注释），合法流程不受影响；
    // 唯一的行为变化是"无凭据却读到他人记录"的请求回到试用/402——那正是要堵的洞。
    const ens = await licenseWeb.ensure({ selfAnchored: true, trialOnly: !importedOk });
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

/**
 * /api/free-key：按机器码签发 7 天 Free 套餐卡（一机一张，网页自动派发用）。
 *
 * 机器码必须由客户端提交（X-JSLB-Machine 头或 body.machine）：它是硬件特征
 * 派生值，服务端没有浏览器指纹、替它算不出同一个值。卡号由机器码确定性派生，
 * 台账按机器码分键——同机重取回放原卡，异机各得各卡，跨机赎回被赎回登记拦
 * （详见 license-web.issueFreeKey 的说明）。
 *
 * 防刷卡密：刷出来的卡密分发给别的机器时，对方提交的机器码与卡号派生自的
 * 机器码对不上——赎回登记一查即拒（reason=used）。
 */
async function handleFreeKey(request) {
  if (request.method !== 'POST') {
    return json({ ok: false, message: 'use POST with {machine}' }, 405);
  }
  const body = await readBody(request);
  const machine = request.headers.get('X-JSLB-Machine')
    || (body && typeof body.machine === 'string' ? body.machine : '');
  const r = await licenseWeb.issueFreeKey(machine);
  if (!r.ok) {
    const message = r.reason === 'machine'
      ? t('freeKeyBadMachine')
      : t('freeKeyFailed', { reason: r.reason });
    return json({ ok: false, status: 400, message }, 400);
  }
  return json({
    ok: true,
    key: r.code,
    plan: 'free',
    days: licenseWeb.FREE_KEY_DAYS,
    machine: r.machine,
    // issued 为真表示这次是新签（台账里没有这张机器码的记录）
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
  // 客户端提交的硬件机器码：激活时与卡密永久绑定（见 license-web.activate 的
  // opts.machine 说明）；补登记时还用来证明"呈上的记录属于本机"（见
  // license-web.importRecord）。老客户端不带这个头，activate 回落到卡的绑定机器码。
  const machine = request.headers.get('X-JSLB-Machine')
    || (typeof body.machine === 'string' ? body.machine : '');

  if (body.record && typeof body.record === 'object') {
    const imp = await licenseWeb.importRecord(body.record, { machine });
    if (!imp.ok) {
      return json({ ok: false, status: 401, message: t('licReason_' + imp.reason) }, 401);
    }
  }

  const key = request.headers.get('X-JSLB-Key') || body.key;
  if (key) {
    // 与 /api/obfuscate 完全同口径：复用已有记录前必须校验它与出示的卡密是同一张
    // （restoredMatchesKey）。原先这里只看"有没有有效记录"，于是设备上留着 Free
    // 记录时出示 Plus 卡会被判成"已激活"而直接跳过 activate，界面收到 200 与一份
    // Free 权益——用户以为升级成功了，实际套餐没变。/api/obfuscate 早就踩过同一个
    // 坑并补了这道校验（裸键串扰防护），这条路径漏了。
    const had = await licenseWeb.restore({ selfAnchored: true });
    const reuse = had.ok && await licenseWeb.restoredMatchesKey(key);
    if (!reuse) {
      const act = await licenseWeb.activate(key, { machine });
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
/**
 * 收款与客服信息。全部可用环境变量覆盖，默认值是"内置收款码 + 人工核验"这一形态
 * ——个人收款码没有商户回调，这是默认能跑通的那条路。
 *
 *   JSLB_PAY_QR          收款码图片路径（默认 /assets/pay-wechat.png，随 dist 下发）
 *   JSLB_PAY_PAYEE       收款方显示名（买家核对用）
 *   JSLB_PAY_CONTACT     客服联系方式（可选，显示在订单页）
 *   JSLB_ADMIN_TOKEN     管理端令牌（配了才启用 /api/admin-order）
 *   JSLB_PAY_WEBHOOK_SECRET  收款回调签名密钥（配了才启用 /api/pay-notify）
 */
function payInfo(env) {
  const e = env || {};
  return {
    qr: String(e.JSLB_PAY_QR || '/assets/pay-wechat.png'),
    payee: String(e.JSLB_PAY_PAYEE || 'JsLabyrinth'),
    contact: String(e.JSLB_PAY_CONTACT || ''),
    auto: !!e.JSLB_PAY_WEBHOOK_SECRET,
    admin: !!e.JSLB_ADMIN_TOKEN,
  };
}

/**
 * 订单来源标识，用于限流。
 *
 * 设备码优先（同一浏览器的多次下单算一个人），没有就退回 X-Forwarded-For 的首个
 * 地址（Vercel 上这是真实客户端 IP）。两者都没有时归到 anon——**不阻断下单**，
 * 只是少一层限流：把"取不到来源"当成攻击会让正常用户（隐私模式、代理）下不了单。
 */
function orderScope(request) {
  const dev = request.headers.get('x-jslb-device') || cookieDevice(request);
  if (dev) return 'd:' + String(dev).slice(0, 40);
  const xff = String(request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  if (xff) return 'i:' + xff.slice(0, 45);
  return 'anon';
}

/** 管理端令牌校验。未配置令牌时一律拒绝——"没配就等于谁都能管"是不能接受的默认。 */
function adminOk(env, request) {
  const want = String((env && env.JSLB_ADMIN_TOKEN) || '');
  if (!want) return false;
  const got = String(request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  return !!got && timingSafeEqualText(want, got);
}

/** 把订单转成给买家看的响应体（金额另给格式化文本，界面不用自己算分）。 */
function orderPayload(order, extra) {
  return {
    ...order,
    planName: plan.displayName(order.plan),
    amountText: pricing.formatFen(order.amount, true),
    currency: order.currency || pricing.CURRENCY,
    ...(extra || {}),
  };
}

/** /api/pricing：价目表 + 收款信息。定价页一次拿全，不用两次往返。 */
function handlePricing(request, env) {
  return json({
    ok: true,
    currency: pricing.CURRENCY,
    plans: pricing.rows(plan),
    terms: Object.keys(pricing.TERMS).map((id) => ({
      id, days: pricing.TERMS[id].days, kind: pricing.TERMS[id].kind,
    })),
    pay: payInfo(env),
  }, 200, corsHeaders(env));
}

/**
 * /api/order：创建订单、提交付款凭证、查询/取卡。
 *
 * 三个动作都在这一条路由上（Vercel 按文件建函数，多一个动作就多一个函数文件）：
 *   POST {action:'create', plan, term}                  → 建单，**只在这次响应里**给查询码
 *   POST {action:'claim', id, q, txid, amount, ...}     → 提交凭证（需查询码）
 *   POST {action:'pickup', id, q} / GET ?id=&q=         → 查状态；已签发时取卡
 */
async function handleOrder(request, env) {
  const kv = platform.getKv();
  const cors = corsHeaders(env);
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const id = url.searchParams.get('id') || '';
    const q = url.searchParams.get('q') || '';
    const order = await orders.loadOrder(kv, id);
    const r = orders.pickupView(order, q, Date.now());
    if (!r.ok) {
      const status = r.reason === 'notFound' ? 404 : 403;
      return json({ ok: false, reason: r.reason, message: t(orders.reasonKey(r.reason)) }, status, cors);
    }
    return json({ ok: true, order: orderPayload(r.view) }, 200, cors);
  }

  const body = await readBody(request);
  const action = String((body && body.action) || 'create').toLowerCase();

  if (action === 'create') {
    const kvOk = !!kv;
    if (!kvOk) {
      // 没有持久化存储时**不建单**：订单活不过一个实例，买家付了钱却查不到单，
      // 那比"暂时不能下单"糟得多。这里明确报错并让运维去配 Redis。
      return json({ ok: false, reason: 'noStore', message: t('orderErrStore') }, 503, cors);
    }
    const scope = orderScope(request);
    const rl = await orders.rateLimit(kv, scope, Date.now(), {});
    if (!rl.ok) {
      return json({ ok: false, reason: 'rateLimited', message: t('orderErrRate') }, 429, cors);
    }
    const made = orders.createOrder({
      planName: String((body && body.plan) || '').toLowerCase(),
      term: String((body && body.term) || '').toLowerCase(),
      now: Date.now(),
      device: scope,
    });
    if (!made.ok) {
      return json({ ok: false, reason: made.reason, message: t(orders.reasonKey(made.reason)) }, 400, cors);
    }
    const saved = await orders.saveOrder(kv, made.order);
    await orders.indexAdd(kv, made.order.id);
    if (!saved) return json({ ok: false, reason: 'noStore', message: t('orderErrStore') }, 503, cors);
    return json({
      ok: true,
      order: orderPayload(made.order),
      // 查询码只在这里出现一次：它是取卡凭据，页面要提示用户保存
      queryCode: made.queryCode,
      pay: payInfo(env),
    }, 200, cors);
  }

  if (action === 'claim') {
    const id = String((body && body.id) || '').toUpperCase();
    const order = await orders.loadOrder(kv, id);
    if (!order) return json({ ok: false, reason: 'notFound', message: t('orderErrNotFound') }, 404, cors);
    // 先验查询码再改状态：只凭订单号就能提交凭证的话，别人可以拿它的订单号乱提交，
    // 把真实买家挤成"待核验"状态。
    const auth = orders.pickupView(order, body && body.q, Date.now());
    if (!auth.ok) return json({ ok: false, reason: auth.reason, message: t(orders.reasonKey(auth.reason)) }, 403, cors);
    const claimed = orders.applyClaim(order, {
      txid: body && body.txid,
      amount: body && body.amount,
      paidAt: body && body.paidAt,
      payer: body && body.payer,
      note: body && body.note,
    }, Date.now());
    if (!claimed.ok) {
      return json({ ok: false, reason: claimed.reason, message: t(orders.reasonKey(claimed.reason)) }, 400, cors);
    }
    const txid = orders.normalizeTxid(body && body.txid);
    if (txid && !(await orders.claimTxid(kv, txid, order.id))) {
      // 回滚刚写进去的凭证，让买家能改正单号重提，而不是卡在"待核验"里
      order.status = 'pending';
      order.claim = null;
      await orders.saveOrder(kv, order);
      return json({ ok: false, reason: 'txidUsed', message: t('orderErrTxidUsed') }, 409, cors);
    }
    await orders.saveOrder(kv, order);
    const view = orders.pickupView(order, body && body.q, Date.now());
    return json({ ok: true, order: orderPayload(view.view) }, 200, cors);
  }

  if (action === 'pickup') {
    const id = String((body && body.id) || '').toUpperCase();
    const order = await orders.loadOrder(kv, id);
    const r = orders.pickupView(order, body && body.q, Date.now());
    if (!r.ok) {
      const status = r.reason === 'notFound' ? 404 : 403;
      return json({ ok: false, reason: r.reason, message: t(orders.reasonKey(r.reason)) }, status, cors);
    }
    return json({ ok: true, order: orderPayload(r.view) }, 200, cors);
  }

  return json({ ok: false, reason: 'badAction', message: t('orderErrGeneric') }, 400, cors);
}

/**
 * /api/pay-notify：收款回调（微信支付 V3 / 服务商 / 自建对账脚本都能用）。
 *
 * 签名是 HMAC-SHA256(JSLB_PAY_WEBHOOK_SECRET, **原始请求体**)，放在
 * `X-JSLB-Signature` 头里。用原始文本而不是重新序列化的对象：键序与空白一变，
 * 签名必然对不上，而那种失败会被误判成"密钥配错了"。
 *
 * 回调成功即幂等签发卡密，但**响应里不回卡密**——回调方不是买家，卡密只经
 * 查询码交付。
 */
async function handlePayNotify(request, env) {
  const cors = corsHeaders(env);
  const raw = await request.text().catch(() => '');
  const provided = request.headers.get('x-jslb-signature') || request.headers.get('x-signature') || '';
  if (!orders.verifyWebhook(env && env.JSLB_PAY_WEBHOOK_SECRET, raw, provided)) {
    return json({ ok: false, reason: 'badSignature', message: t('orderErrSignature') }, 401, cors);
  }
  let body = null;
  try { body = JSON.parse(raw); } catch (e) { body = null; }
  if (!body || !body.orderId) {
    return json({ ok: false, reason: 'badJson', message: t('orderErrGeneric') }, 400, cors);
  }
  const kv = platform.getKv();
  const order = await orders.loadOrder(kv, String(body.orderId).toUpperCase());
  if (!order) return json({ ok: false, reason: 'notFound', message: t('orderErrNotFound') }, 404, cors);
  const paid = orders.applyPayment(order, {
    txid: body.txid, amount: body.amount, paidAt: body.paidAt, source: 'webhook', note: body.note,
  }, Date.now());
  if (!paid.ok) {
    return json({ ok: false, reason: paid.reason, message: t(orders.reasonKey(paid.reason)) }, 409, cors);
  }
  const txid = orders.normalizeTxid(body.txid);
  if (txid && !(await orders.claimTxid(kv, txid, order.id))) {
    return json({ ok: false, reason: 'txidUsed', message: t('orderErrTxidUsed') }, 409, cors);
  }
  const issued = orders.issueKey(order, { keyB64: licenseWeb.activeCodeKey() });
  if (!issued.ok) {
    return json({ ok: false, reason: issued.reason, message: t(orders.reasonKey(issued.reason)) }, 500, cors);
  }
  await orders.saveOrder(kv, order);
  return json({ ok: true, orderId: order.id, status: order.status, fresh: issued.fresh }, 200, cors);
}

/**
 * /api/admin-order：管理端（人工核验付款、列表、拒绝）。
 *
 * 认证是 Bearer 令牌 + 定长比较。没配 JSLB_ADMIN_TOKEN 时这个端点恒为 403——
 * 默认关闭，而不是默认开启等运维想起来配。
 *
 *   POST {action:'list', status?, limit?}      列出最近订单（不含查询码散列）
 *   POST {action:'get', id}                    单张订单详情
 *   POST {action:'confirm', id, txid?, amount?, note?}  确认收款 → 幂等签发，返回卡密
 *   POST {action:'reject', id, reason}         拒绝订单
 */
async function handleAdminOrder(request, env) {
  const cors = corsHeaders(env);
  if (!adminOk(env, request)) {
    return json({ ok: false, reason: 'forbidden', message: t('orderErrForbidden') }, 403, cors);
  }
  const body = await readBody(request);
  const action = String((body && body.action) || 'list').toLowerCase();
  const kv = platform.getKv();
  if (!kv) return json({ ok: false, reason: 'noStore', message: t('orderErrStore') }, 503, cors);

  if (action === 'list') {
    const want = String((body && body.status) || '').toLowerCase();
    const limit = Math.min(Number((body && body.limit) || 50) || 50, orders.MAX_INDEX);
    const ids = (await orders.indexList(kv)).slice(0, limit);
    const list = [];
    for (const id of ids) {
      const o = await orders.loadOrder(kv, id);
      if (!o) continue;
      const view = orders.adminView(o, Date.now());
      if (want && view.status !== want) continue;
      list.push(view);
    }
    return json({ ok: true, count: list.length, orders: list }, 200, cors);
  }

  if (action === 'get') {
    const o = await orders.loadOrder(kv, String((body && body.id) || '').toUpperCase());
    if (!o) return json({ ok: false, reason: 'notFound', message: t('orderErrNotFound') }, 404, cors);
    return json({ ok: true, order: orders.adminView(o, Date.now()) }, 200, cors);
  }

  if (action === 'confirm') {
    const o = await orders.loadOrder(kv, String((body && body.id) || '').toUpperCase());
    if (!o) return json({ ok: false, reason: 'notFound', message: t('orderErrNotFound') }, 404, cors);
    const paid = orders.applyPayment(o, {
      txid: body && body.txid, amount: body && body.amount, paidAt: body && body.paidAt,
      source: 'admin', note: body && body.note,
    }, Date.now());
    if (!paid.ok) {
      return json({ ok: false, reason: paid.reason, message: t(orders.reasonKey(paid.reason)) }, 409, cors);
    }
    const txid = orders.normalizeTxid((body && body.txid) || (o.claim && o.claim.txid));
    if (txid && !(await orders.claimTxid(kv, txid, o.id))) {
      return json({ ok: false, reason: 'txidUsed', message: t('orderErrTxidUsed') }, 409, cors);
    }
    const issued = orders.issueKey(o, { keyB64: licenseWeb.activeCodeKey() });
    if (!issued.ok) {
      return json({ ok: false, reason: issued.reason, message: t(orders.reasonKey(issued.reason)) }, 500, cors);
    }
    await orders.saveOrder(kv, o);
    // 管理端拿得到卡密：买家丢查询码时客服要能补发
    return json({ ok: true, order: orders.adminView(o, Date.now()), key: issued.key, fresh: issued.fresh }, 200, cors);
  }

  if (action === 'reject') {
    const o = await orders.loadOrder(kv, String((body && body.id) || '').toUpperCase());
    if (!o) return json({ ok: false, reason: 'notFound', message: t('orderErrNotFound') }, 404, cors);
    const rej = orders.rejectOrder(o, (body && body.reason) || '', Date.now());
    if (!rej.ok) {
      return json({ ok: false, reason: rej.reason, message: t(orders.reasonKey(rej.reason)) }, 409, cors);
    }
    await orders.saveOrder(kv, o);
    return json({ ok: true, order: orders.adminView(o, Date.now()) }, 200, cors);
  }

  return json({ ok: false, reason: 'badAction', message: t('orderErrGeneric') }, 400, cors);
}

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
    // 套餐对照表是公开信息，发卡方的定价页可以直接取。
    // 2026-10-11 起一并带上价格与收款信息：定价页只要拿到这一条就能渲染整页，
    // 于是"老部署只有 /api/plans、没有 /api/pricing"也不会白屏（界面里有回落）。
    return json({
      ok: true,
      plans: plan.rows(),
      pricing: pricing.rows(plan),
      pay: payInfo(env),
      web: platform.getWebConfig(),
    }, 200, corsHeaders(env));
  }

  if (path === '/api/pricing') {
    return handlePricing(request, env);
  }

  if (path === '/api/order') {
    const res = await handleOrder(request, env);
    for (const [k, v] of Object.entries(corsHeaders(env))) res.headers.set(k, v);
    return res;
  }

  if (path === '/api/pay-notify' && request.method === 'POST') {
    const res = await handlePayNotify(request, env);
    for (const [k, v] of Object.entries(corsHeaders(env))) res.headers.set(k, v);
    return res;
  }

  if (path === '/api/admin-order') {
    const res = await handleAdminOrder(request, env);
    for (const [k, v] of Object.entries(corsHeaders(env))) res.headers.set(k, v);
    return res;
  }

  if (path === '/api/free-key') {
    const res = await handleFreeKey(request);
    for (const [k, v] of Object.entries(corsHeaders(env))) res.headers.set(k, v);
    return res;
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
   * CORS 响应头。vercel/entry.js 自己产生的响应（上传预检 413、CPU 预算 503、
   * 兜底 500，以及重写过的 /api/health）也必须带上——那些响应不经 handleApi，
   * 所以入口层要自己取。导出出来是为了让两层用同一份定义，不各自抄一遍。
   */
  corsHeaders,
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
