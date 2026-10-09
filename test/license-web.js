#!/usr/bin/env node
/**
 * 网页侧授权链路：端到端激活、裸键串扰防护、自锚定校验、额度包、赎回与机器码绑定。
 *
 *   node test/license-web.js
 *
 * 整跑全部用例：npm test（即 node test/selftest.js）。
 */
import { cleanTmp, ok, report, section } from './_harness.js';
import codec from '../src/license-codec.js';
import licCore from '../src/license-core.js';
import plan from '../src/plan.js';
import licenseWeb from '../src/license-web.js';
import platform from '../src/platform.js';


// 测试专用签发密钥对。
//
// 真私钥不随源码分发（这正是换成非对称的目的），所以自测不能拿它签卡——也不该
// 拿。测试自己固定一对：种子写死在这里，公钥由它派生，再通过 setKeyMaterial /
// JSLB_CODE_KEY 注入到 license-web 与 Worker。走的签发/校验代码路径与线上完全
// 相同，只有密钥不同。种子是公开的常量，仅供测试，绝不能用于真实发卡。
const TEST_CODE_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
section('端到端激活（v5 卡密）');
{
  // v5 卡密不携带绑定段：matchesMachine 对任何机器码恒真——"一卡一机"由服务端
  // 赎回登记强制（见 license-web.activate 的 redeem 检查）。机器码摘要本身仍
  // 逐位区分，赎回登记按它记录赎回者。
  const key = TEST_CODE_KEY;
  const midA = 'ABCDEFGHJKMNPQRSTVWXYZ01';
  const midB = 'ABCDEFGHJKMNPQRSTVWXYZ02'; // 与 A 只差最后一位
  const free = codec.parseCode(key, codec.issueCode(key, 'plus', 30, '12345', 2192));
  ok(free.ok && free.bound === false && free.bindSeg === codec.BIND_NONE, 'v5 卡密绑定段恒为全 0');
  ok(codec.matchesMachine(free.bindSeg, midA) && codec.matchesMachine(free.bindSeg, midB),
    '不绑定的卡在任何机器上都放行');
  ok(codec.bindDigest(midA) !== codec.bindDigest(midB), '机器码摘要仍逐位区分（赎回登记用）');

  {
    platform.setKv(null);
    platform.setStorage(platform.newMemoryStorage());
    licenseWeb.setKeyMaterial(key, null);
    licenseWeb.resetRequestState();
    // 签发日必须取今天：到期时间由"签发日 + 天数"推出，restore 会验过期。
    const today = Math.floor((Date.now() - codec.DAY_ZERO) / 86400000);

    const own = codec.issueCode(key, 'plus', 30, '24681', today);
    const goodAct = await licenseWeb.activate(own);
    ok(goodAct.ok && goodAct.plan === 'plus', '不绑定卡 activate 成功');
    ok(licenseWeb.isLicensed(), '激活后进入已授权状态');
    const rest = await licenseWeb.restore();
    ok(rest.ok, '激活写下的记录可被 restore 恢复');

    // 过期卡：activate 这一刻就拒绝，不留到 restore（Worker 按卡密激活的 API
    // 请求每次重放都走 activate，过期检查必须在激活入口生效）。
    licenseWeb.resetRequestState();
    platform.setStorage(platform.newMemoryStorage());
    const stale = codec.issueCode(key, 'plus', 30, '24682', today - 60);
    const staleAct = await licenseWeb.activate(stale);
    ok(!staleAct.ok && staleAct.reason === 'expired',
      '过期卡 activate 即被拒（reason=expired）', staleAct.reason);
    ok(!licenseWeb.isLicensed() && (await licenseWeb.exportRecord()) === null,
      '过期卡拒激活后无权益、不落盘');

    licenseWeb.resetRequestState();
    platform.setStorage(null);
  }
}

// ------------------------------------------------------------ 裸键串扰防护
//
// 背景（2026-10-01 线上实测）：存储键按请求设备码隔离（scopedKey），无设备头时
// 回落到裸键。暖实例上 restore() 会读到别的租户激活过的记录——实测匿名请求拿到了
// pack100 权益，Free 卡的闸门全被绕过（Free+htmle 照样 200）。
//
// 本节钉住两道防线（都是 server/handler.js handleObfuscate 在用）：
//   ① restoredMatchesKey：复用的记录必须与出示的卡密是同一张卡（比卡密编号）；
//   ② ensure({trialOnly:true})：既无卡密又无有效记录时跳过 restore，只能是试用。

section('裸键串扰防护（restore 必须匹配出示的卡密）');
{
  platform.setKv(null);
  platform.setStorage(platform.newMemoryStorage());
  licenseWeb.setKeyMaterial(TEST_CODE_KEY, null);
  licenseWeb.resetRequestState();
  // 签发日取今天（与上节同口径，否则 restore 先验过期）。
  const today = Math.floor((Date.now() - codec.DAY_ZERO) / 86400000);
  const cardA = codec.issueCode(TEST_CODE_KEY, 'pack100', 0, '91001', today);
  const cardB = codec.issueCode(TEST_CODE_KEY, 'free', 365, '91002', today);

  // A 激活 → 记录落盘（模拟暖实例上留下的别人记录）。
  const actA = await licenseWeb.activate(cardA);
  ok(actA.ok && actA.plan === 'pack100', 'pack100 卡激活成功（串扰场景的 A 方）');

  // ① 出示同一张卡 → 匹配，可复用；出示另一张卡 → 不匹配，走 activate。
  ok(await licenseWeb.restoredMatchesKey(cardA), '出示同一张卡：记录匹配，可复用');
  ok(!(await licenseWeb.restoredMatchesKey(cardB)), '出示另一张卡：记录不匹配，不可复用');
  ok(!(await licenseWeb.restoredMatchesKey('JSLB-NOT-A-KEY')), '出示非法卡密：不匹配');

  // 无记录时一律不匹配（调用方回落到 activate，由它报 401 原因）。
  licenseWeb.resetRequestState();
  platform.setStorage(platform.newMemoryStorage());
  ok(!(await licenseWeb.restoredMatchesKey(cardA)), '无存储记录时不匹配');

  // ② 先证明现场是真的：不清存储只清 state（模拟新请求落到暖实例），
  //    不带 trialOnly 的 ensure 会复用别人的记录——这正是要堵的洞。
  //    （不断言它是"对的"，只用它证明下面的 trialOnly 测试不是空转。）
  licenseWeb.resetRequestState();
  platform.setStorage(platform.newMemoryStorage());
  ok((await licenseWeb.activate(cardA)).ok, '重建串扰现场：pack100 记录已落盘');
  licenseWeb.resetRequestState();
  const leak = await licenseWeb.ensure({ selfAnchored: true });
  const leakEnt = licenseWeb.entitlements();
  ok(leak.ok && leakEnt && leakEnt.plan === 'pack100',
    '对照组：不清存储时 ensure 确实复用了他人记录（pack100）',
    leakEnt ? leakEnt.plan : '无权益');

  // 同一现场加 trialOnly → 绝不能是 pack100（试用或直接拒绝，看 requireLicense 配置）。
  licenseWeb.resetRequestState();
  const gated = await licenseWeb.ensure({ selfAnchored: true, trialOnly: true });
  const gatedEnt = licenseWeb.entitlements();
  ok(!gatedEnt || gatedEnt.trial === true || gatedEnt.plan !== 'pack100',
    'trialOnly 下不复用他人记录', gatedEnt ? (gatedEnt.trial ? 'trial' : gatedEnt.plan) : '无权益');

  licenseWeb.resetRequestState();
  platform.setStorage(null);
}

// ------------------------------------------------------------ 自锚定校验

// 服务端（Vercel 的 Node 函数）里没有 navigator / screen / WebGL，machineId()
// 派生出的值与浏览器派的永不相等（服务端实测 4CFS7ZE5899W3R803S439Y2F，浏览器实测
// 1K9W9H9S065P0C7M834C1XC8）。所以服务端网关必须用"自锚定"模式校验：
// 锚点取记录自己声称的 machine，再验卡密校验码、令牌与到期时间是否与它自洽。
//
// 这一节钉住三件事：自锚定能放行正常记录、严格模式不会因此被放松、伪造仍然过不去。

section('自锚定校验（服务端网关）');
{
  const seed = TEST_CODE_KEY;
  const pub = TEST_CODE_KEY;
  const browserMid = '1K9W9H9S065P0C7M834C1XC8'; // 浏览器派生（记录里的 machine）
  const serverMid = '4CFS7ZE5899W3R803S439Y2F';  // Worker 派生（网关手里的 machine）

  // 签发日必须晚于当前时间，否则校验会在 expired 那一步先失败，掩盖掉这里要验的
  // bind / token 判定。往上取一段余量而不是写死某天，免得测试随时间腐烂。
  const issueDay = Math.floor((Date.now() - codec.DAY_ZERO) / 86400000) + 3650;

  // 卡绑到浏览器机器码 —— 线上就是这种情况
  const parsed = codec.parseCode(pub, codec.issueCode(seed, 'plus', 30, '70001', issueDay));
  ok(parsed.ok, '自锚定用例：不绑定卡可解析');
  const rec = licCore.makeRecord({
    code: parsed.code, plan: 'plus', machine: browserMid,
    issuedAt: Date.now(), expiresAt: licCore.expiryFromIssueDay(parsed),
    usage: { day: '2026-01-01', used: 0 },
  }, pub);

  // 严格模式：本机码相同 → 放行；换成 Worker 派的码 → 必须拒绝
  ok(licCore.verifyLicenseData(rec, browserMid, pub).ok, '严格模式：机器码一致时放行');
  {
    const res = licCore.verifyLicenseData(rec, serverMid, pub);
    // v5 卡密不带绑定段，异机拒绝来自记录 machine 与锚点的比对（reason=machine）。
    ok(!res.ok && res.reason === 'machine', '严格模式：换成服务端机器码时判 machine', res.reason);
  }

  // 自锚定：null / undefined / 空串都应被视为自锚定
  for (const anchor of [null, undefined, '']) {
    const res = licCore.verifyLicenseData(rec, anchor, pub);
    ok(res.ok, '自锚定（' + JSON.stringify(anchor) + '）放行浏览器派生的记录', res.reason);
    ok(res.machine === browserMid, '自锚定回传的 machine 取自记录自身');
  }

  // 严格模式绝不能被自锚定带松：传了机器码就必须严格比对
  ok(!licCore.verifyLicenseData(rec, serverMid, pub).ok, '自锚定不影响严格模式：异机仍拒');
  ok(licCore.verifyLicenseData(rec, browserMid, pub).ok, '自锚定不影响严格模式：同机仍放');

  // 安全性：自锚定的锚点来自记录，v5 下兜底的是令牌（machine 进令牌载荷）
  {
    const forged = { ...rec, machine: 'ZZZZZZZZZZZZZZZZZZZZZZZZ' };
    const res = licCore.verifyLicenseData(forged, null, pub);
    ok(!res.ok && res.reason === 'token', '自锚定：改 machine 会被令牌拦下（绑定职能由服务端赎回登记承担）', res.reason);
  }
  {
    // v5 已知边界：连令牌一起同步伪造的自锚定记录在卡密层放行（校验码与令牌
    // 都自洽）。这是对称体系的固有属性；"一卡一机"由服务端赎回登记兜底。
    const machine = 'ZZZZZZZZZZZZZZZZZZZZZZZZ';
    const forged = {
      ...rec,
      machine,
      token: codec.makeToken(pub, machine, rec.expiresAt, rec.usage.day, rec.usage.used),
    };
    const res = licCore.verifyLicenseData(forged, null, pub);
    ok(res.ok, '自锚定已知边界：令牌与 machine 同步伪造在卡密层放行（服务端赎回登记兜底）', res.reason);
  }
  {
    const tampered = { ...rec, usage: { day: rec.usage.day, used: 999 } };
    const res = licCore.verifyLicenseData(tampered, null, pub);
    ok(!res.ok && res.reason === 'token', '自锚定：篡改用量判 token', res.reason);
  }
  {
    // 卡密不绑机器（绑定段全 0）时，自锚定等价于"只看签名与令牌"
    const free = codec.parseCode(pub, codec.issueCode(seed, 'plus', 30, '70002', issueDay));
    ok(free.bound === false, '自锚定用例：通用卡不绑定机器');
    const freeRec = licCore.makeRecord({
      code: free.code, plan: 'plus', machine: serverMid,
      issuedAt: Date.now(), expiresAt: licCore.expiryFromIssueDay(free),
      usage: { day: '2026-01-01', used: 0 },
    }, pub);
    ok(licCore.verifyLicenseData(freeRec, null, pub).ok, '自锚定：不绑定的卡在任何机器码下都放行');
  }
  {
    // machine 长度不对属于结构性损坏，自锚定也必须先挡下来
    ok(!licCore.verifyLicenseData({ ...rec, machine: 'SHORT' }, null, pub).ok,
      '自锚定：machine 长度非法判 corrupt');
  }
}

section('一次性额度包与解除激活');
{
  // 假的 KV：键名带设备码后缀，del 是真删。用它验证"解除激活必须删掉服务端那一份"——
  // 只清浏览器存储的话，下一次请求又会从 KV 把授权读回来。
  const store = new Map();
  platform.setKv({
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v); },
    del: async (k) => { store.delete(k); },
  });
  platform.setStorage(platform.newMemoryStorage());
  // 换成测试公钥：内置公钥对应的是真私钥，测试签不出来（也不该签得出来）。
  // loadKeysFromEnv() 只在 JSLB_CODE_KEY 有值时覆盖，这里直接设内存里的值。
  licenseWeb.setKeyMaterial(TEST_CODE_KEY, null);
  const keys = [TEST_CODE_KEY, TEST_CODE_KEY];
  const devPack = 'c'.repeat(32);
  const devSub = 'd'.repeat(32);
  const keyOf = (base) => base + ':' + devPack;

  // 额度包：买断 100 次，用完为止
  licenseWeb.resetRequestState();
  licenseWeb.setRequestDeviceId(devPack);
  const packCode = codec.issueCode(keys[0], 'pack100', 0, '55555');
  const pa = await licenseWeb.activate(packCode);
  ok(pa.ok && pa.plan === 'pack100', '额度包卡密可激活');
  const pent = licenseWeb.entitlements();
  ok(pent.limits.runsTotal === 100 && pent.preset === 'max', '额度包按总额度记账，能力跟随 max 预设');
  const pq = await licenseWeb.quota();
  ok(pq.total === 100 && pq.used === 0, '额度包额度取自 runsTotal 而非每日上限');

  let used = 0;
  for (let i = 0; i < 100; i++) {
    const c = await licenseWeb.consumeRun();
    if (c.ok) used++;
  }
  ok(used === 100, '额度包可连续记满 100 次', '实得 ' + used);
  const overPack = await licenseWeb.consumeRun();
  ok(!overPack.ok && overPack.reason === 'quota', '额度用尽后不再放行');
  ok((await licenseWeb.quotaText()).indexOf('累计') >= 0, '额度包用量文案走累计口径');

  // 订阅档跨日归零、额度包跨日累计：直接塞一条"上次使用是 2020 年"的记录。
  // 不能靠改 current() 的副本——那只是快照，改它验不出任何东西。
  //
  // 到期时间必须走 expiryFromIssueDay：它由卡密里已签名的签发日推出，随便写一个
  // 值会被 verifyLicenseData 判成 expirymismatch。这正是"本地改不了自己的有效期"。
  const seed = async (device, code, planName, _days, used0) => {
    licenseWeb.resetRequestState();
    licenseWeb.setRequestDeviceId(device);
    const mid = await licenseWeb.machineId();
    const parsed = codec.parseCode(TEST_CODE_KEY, code);
    const rec = licCore.makeRecord({
      code: parsed.code, plan: parsed.plan, machine: mid,
      issuedAt: Date.now(),
      expiresAt: licCore.expiryFromIssueDay(parsed),
      usage: { day: '2020-01-01', used: used0 },
    }, TEST_CODE_KEY);
    store.set('jslabyrinth.license.v2:' + device, JSON.stringify(rec));
    const res = await licenseWeb.restore();
    return res;
  };

  ok((await seed(devPack, packCode, 'pack100', 0, 50)).ok, '旧日期的额度包记录仍可恢复');
  ok((await licenseWeb.quota()).used === 50, '额度包跨日累计：旧日期已用的次数照算');

  const plusCode = codec.issueCode(keys[0], 'plus', 30, '66666');
  ok((await seed(devSub, plusCode, 'plus', 30, 7)).ok, '旧日期的订阅档记录仍可恢复');
  ok((await licenseWeb.quota()).used === 0, '订阅档跨日归零');

  // 本地改 expiresAt 续期必须失败：到期时间由已签名的签发日推出
  {
    licenseWeb.resetRequestState();
    licenseWeb.setRequestDeviceId(devSub);
    const mid = await licenseWeb.machineId();
    const parsed = codec.parseCode(TEST_CODE_KEY, plusCode);
    const rec = licCore.makeRecord({
      code: parsed.code, plan: parsed.plan, machine: mid,
      issuedAt: Date.now(), expiresAt: licCore.expiryFromIssueDay(parsed),
      usage: { day: '2020-01-01', used: 0 },
    }, TEST_CODE_KEY);
    rec.expiresAt = parsed.days === 0 ? 0 : rec.expiresAt + 3650 * 86400000;
    store.set('jslabyrinth.license.v2:' + devSub, JSON.stringify(rec));
    const r = await licenseWeb.restore();
    ok(!r.ok && r.reason === 'expirymismatch', '本地改 expiresAt 续期被拒', r.reason);
  }

  // 解除激活：本设备那份必须真的从 KV 里消失
  licenseWeb.resetRequestState();
  licenseWeb.setRequestDeviceId(devSub);
  const act2 = await licenseWeb.activate(plusCode);
  ok(act2.ok && act2.plan === 'plus', '另一台设备激活成功');
  ok(store.has('jslabyrinth.license.v2:' + devSub), '许可证按设备码分键存进 KV');
  await licenseWeb.deactivate();
  ok(!store.has('jslabyrinth.license.v2:' + devSub), '解除激活删掉 KV 里那一条（真删，不是写空串）');
  const again = await licenseWeb.restore();
  ok(!again.ok && again.reason === 'missing', '之后再恢复读不到授权（刷新不会把卡密带回来）');

  platform.setKv(null);
  platform.setStorage(null);
}

section('卡密赎回（严格一次性，防重复使用）');
{
  // 每张卡密只能激活一次（严格一次性）：赎回登记一旦存在，无论是不是本机再输
  // 入同一卡密都拒（reason=used）。旧版放行同机重激活并重置用量——Pack 卡用完
  // 额度后同机再输一次就白得新额度，等于无限续杯，这里把口子钉死。
  const store = new Map();
  platform.setKv({
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v); },
    del: async (k) => { store.delete(k); },
  });
  platform.setStorage(platform.newMemoryStorage());
  licenseWeb.setKeyMaterial(TEST_CODE_KEY, null);
  licenseWeb.resetRequestState();
  const mid = await licenseWeb.machineId();
  const otherMid = mid.slice(0, 23) + (mid.endsWith('0') ? '1' : '0');
  const today = Math.floor((Date.now() - codec.DAY_ZERO) / 86400000);

  // 不绑定卡：首次激活成功，并写下赎回登记（键全局、按编号分键）
  const free = codec.issueCode(TEST_CODE_KEY, 'plus', 30, '77777', today);
  const a1 = await licenseWeb.activate(free);
  ok(a1.ok && a1.plan === 'plus', '不绑定卡首次激活成功', JSON.stringify(a1));
  ok(store.has('redeem:77777'), '赎回登记已写入全局 KV（按编号分键）');
  const rec1 = JSON.parse(store.get('redeem:77777'));
  // 机器码 2026-09-25 起由服务端按卡密签发，赎回登记记的是**这张卡的绑定码**，
  // 不再是上面那个未激活时的本机兜底值——激活之后 machineId() 返回的正是它。
  const freeMid = await licenseWeb.machineId();
  ok(rec1 && rec1.k === free && rec1.m === freeMid && rec1.t > 0,
    '登记含卡密原文、赎回机器码与时间戳', rec1 && rec1.m);

  // 同机再激活同一张：严格一次性，拒绝（同机重复验证应走 restore，不来到这里）
  licenseWeb.resetRequestState();
  platform.setStorage(platform.newMemoryStorage());
  const a2 = await licenseWeb.activate(free);
  ok(!a2.ok && a2.reason === 'used',
    '同机再次输入同一张卡密也被拒（严格一次性，reason=used）', JSON.stringify(a2));

  // 旧版登记是纯机器码文本：归一成同一形状后照常拦截，一次性语义对老记录不降级
  store.set('redeem:77777', otherMid);
  licenseWeb.resetRequestState();
  platform.setStorage(platform.newMemoryStorage());
  const a3 = await licenseWeb.activate(free);
  ok(!a3.ok && a3.reason === 'used', '旧格式赎回登记同样拒激活（reason=used）', a3.reason);

  // 另一张卡不受影响：赎回登记按编号分键
  licenseWeb.resetRequestState();
  platform.setStorage(platform.newMemoryStorage());
  store.delete('redeem:88888');
  const bound = codec.issueCode(TEST_CODE_KEY, 'plus', 30, '88888', today);
  const b1 = await licenseWeb.activate(bound);
  ok(b1.ok && b1.plan === 'plus', '另一张不绑定卡激活成功');
  const rec2 = JSON.parse(store.get('redeem:88888'));
  ok(rec2 && rec2.k === bound && rec2.m === (await licenseWeb.machineId()),
    '另一张卡也按卡密+机器码登记赎回（机器码随卡，与上一张不同）', rec2 && rec2.m);
  ok(rec2 && rec2.m !== freeMid, '两张卡的机器码互不相同', rec2 && rec2.m);

  platform.setKv(null);
  platform.setStorage(null);
}

// ---------------------------------------------------------------- 机器码（服务端签发）

// 老做法的毛病：机器码由浏览器设备特征派生，而 Worker 里没有 navigator / WebGL，
// 派生出的是另一个常量——界面上就是"激活前显示 A、激活后服务端回 B"；特征里任何
// 一项漂移（GPU 渲染器取不到、改时区/语言）还会让已激活的卡在 restore 时判成
// machine 不一致，用户什么都没干就被踢回未激活。
//
// 现在机器码由服务端按**卡密编号**签发并永久登记：同一张卡在任何设备、任何时间
// 拿到的都是同一个值。这一段钉住的就是这个"恒"。

section('机器码：服务端签发并与卡密永久绑定');
{
  const store = new Map();
  const kv = {
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v); },
    del: async (k) => { store.delete(k); },
  };
  licenseWeb.setKeyMaterial(TEST_CODE_KEY, null);
  const today = Math.floor((Date.now() - codec.DAY_ZERO) / 86400000);
  const cardA = codec.issueCode(TEST_CODE_KEY, 'plus', 30, '410001', today);
  const cardB = codec.issueCode(TEST_CODE_KEY, 'plus', 30, '410002', today);

  // ① 服务端没绑 KV：退化为"由卡号确定性派生"，跨请求、跨存储仍然恒等
  platform.setKv(null);
  licenseWeb.resetRequestState();
  platform.setStorage(platform.newMemoryStorage());
  const d1 = await licenseWeb.machineForCode(cardA);
  licenseWeb.resetRequestState();
  platform.setStorage(platform.newMemoryStorage());
  const d2 = await licenseWeb.machineForCode(cardA);
  ok(d1.ok && d2.ok && d1.machine === d2.machine && d1.machine.length === 24,
    '无 KV 时同一张卡的机器码仍恒等（按卡号确定性派生）', d1.machine + ' / ' + d2.machine);
  const dB = await licenseWeb.machineForCode(cardB);
  ok(dB.ok && dB.machine !== d1.machine, '不同卡密得到不同机器码', dB.machine);

  // ② 绑了 KV：随机签发一次并登记，之后永远回同一个值
  platform.setKv(kv);
  platform.setStorage(platform.newMemoryStorage());
  licenseWeb.resetRequestState();
  const k1 = await licenseWeb.machineForCode(cardA);
  ok(k1.ok && k1.issued === true && k1.source === 'issued', '首次取机器码由服务端签发', k1.source);
  ok(store.has('machine:410001'), '机器码按卡密编号登记进 KV（全局键 machine:<编号>）');
  licenseWeb.resetRequestState();
  platform.setStorage(platform.newMemoryStorage());
  const k2 = await licenseWeb.machineForCode(cardA);
  ok(k2.ok && k2.machine === k1.machine && k2.issued === false && k2.source === 'binding',
    '第二次取同一张卡的机器码就是那个值（issued=false）', k2.source);

  // ③ 激活用的就是这张卡的绑定码，记录与赎回登记三处一致
  licenseWeb.resetRequestState();
  licenseWeb.setRequestDeviceId('1'.repeat(32));
  const actA = await licenseWeb.activate(cardA);
  const recA = await licenseWeb.exportRecord();
  ok(actA.ok && recA && recA.machine === k1.machine,
    '激活写下的记录用同一个机器码', recA && recA.machine);
  const redeemA = JSON.parse(store.get('redeem:410001') || '{}');
  ok(redeemA.m === k1.machine, '赎回登记里的机器码与之一致（审计对得上）');

  // ④ 绑定键被清掉、赎回登记还在：沿用登记里的机器码，不重新随机
  store.delete('machine:410001');
  licenseWeb.resetRequestState();
  platform.setStorage(platform.newMemoryStorage());
  licenseWeb.setRequestDeviceId('1'.repeat(32));
  const k3 = await licenseWeb.machineForCode(cardA);
  ok(k3.ok && k3.machine === k1.machine && k3.source === 'redeem',
    '绑定键被删后由赎回登记恢复同一个码（不重新随机）', k3.source);

  // ⑤ 激活态：界面显示的机器码 == 卡的绑定码 == 记录里的码
  licenseWeb.resetRequestState();
  licenseWeb.setRequestDeviceId('1'.repeat(32));
  const restA = await licenseWeb.restore();
  ok(restA.ok, '激活后的记录可被 restore 恢复', JSON.stringify(restA));
  const shown = await licenseWeb.machineId();
  ok(shown === k1.machine, 'restore 后 machineId() 即许可证上那个码（刷新不变）', shown);
  ok((licenseWeb.current() || {}).machine === k1.machine, '状态里的机器码同步为绑定码');

  // ⑤ 非法卡密无从绑定——机器码绑在卡上，不是绑在请求上
  const bogus = await licenseWeb.machineForCode('JSLB-0-000-0000');
  ok(!bogus.ok, '非法卡密取不到机器码', JSON.stringify(bogus));

  platform.setKv(null);
  platform.setStorage(null);
  licenseWeb.resetRequestState();
}

// ---------------------------------------------------------------- 网页自动派发 Free 卡
//
// 部署方开 requireLicense 后，未激活的机器只能靠这条通道领 7 天 Free 卡。
// 反刷卡密的三道闸门都在这里钉死：
//   ① 台账按机器码分键：同机重取回放原卡，不新发；
//   ② 卡号由机器码确定性派生：台账丢了，重派仍是同一卡号；
//   ③ 赎回登记跨机器拦截：A 机激活过的卡，B 机再出示一律 reason=used。
// 另钉住：Free 卡允许同机重激活（误清数据后恢复本地记录）；非 Free 卡保持
// 严格一次性（同机也拒），堵住"重激活重置额度"的口子。

section('网页自动派发 Free 卡（一机一张、一次性激活、同机可恢复）');
{
  const store = new Map();
  platform.setKv({
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v); },
    del: async (k) => { store.delete(k); },
  });
  platform.setStorage(platform.newMemoryStorage());
  licenseWeb.setKeyMaterial(TEST_CODE_KEY, null);
  licenseWeb.resetRequestState();

  const midA = 'ABCDEFGHJKMNPQRSTVWXYZ01';
  const midB = 'ABCDEFGHJKMNPQRSTVWXYZ02';
  const today = Math.floor((Date.now() - codec.DAY_ZERO) / 86400000);

  // ① 首次派发：free 套餐、7 天、台账按机器码落 KV
  const f1 = await licenseWeb.issueFreeKey(midA);
  ok(f1.ok && f1.machine === midA && f1.issued === true, '首次派发 Free 卡成功', JSON.stringify(f1));
  const p1 = codec.parseCode(TEST_CODE_KEY, f1.code);
  ok(p1.ok && p1.plan === 'free' && p1.days === 7, '派出的卡是 7 天 Free', p1.plan + '/' + p1.days);
  ok(store.has('freekey:' + midA), '派发台账按机器码分键写进 KV（全局）');

  // ② 同机重取：回放原卡，不新发（台账在）
  licenseWeb.resetRequestState();
  platform.setStorage(platform.newMemoryStorage());
  const f2 = await licenseWeb.issueFreeKey(midA);
  ok(f2.ok && f2.issued === false && f2.source === 'ledger' && f2.code === f1.code,
    '同机第二次取回放原卡（一机一张）', f2.source);

  // ② 台账丢失时重派：卡号仍是同一个（确定性派生，字符串因随机 IV 不同）
  store.delete('freekey:' + midA);
  licenseWeb.resetRequestState();
  platform.setStorage(platform.newMemoryStorage());
  const f3 = await licenseWeb.issueFreeKey(midA);
  const p3 = codec.parseCode(TEST_CODE_KEY, f3.code);
  ok(f3.ok && p3.ok && p3.id === p1.id,
    '台账丢失后同机重派得同一卡号（一机一卡不依赖台账持久）', p3.id + ' vs ' + p1.id);

  // ③ 不同机器码派生不同卡号：刷出来的卡无法跨机共用
  const fB = await licenseWeb.issueFreeKey(midB);
  const pB = codec.parseCode(TEST_CODE_KEY, fB.code);
  ok(fB.ok && pB.ok && pB.id !== p1.id, '不同机器码派生不同卡号', pB.id + ' vs ' + p1.id);

  // 非法机器码拒绝派发
  ok(!(await licenseWeb.issueFreeKey('short')).ok, '机器码过短不派卡');
  ok(!(await licenseWeb.issueFreeKey('')).ok, '空机器码不派卡');

  // 激活绑定：A 机用自己的硬件机器码激活，记录与赎回登记都落在 midA 上
  licenseWeb.resetRequestState();
  licenseWeb.setRequestDeviceId('a'.repeat(32));
  const a1 = await licenseWeb.activate(f1.code, { machine: midA });
  ok(a1.ok && a1.plan === 'free', 'Free 卡携机器码激活成功', JSON.stringify(a1));
  const recA = await licenseWeb.exportRecord();
  ok(recA && recA.machine === midA, '记录里的机器码是客户端提交的硬件码', recA && recA.machine);
  const redeem = JSON.parse(store.get('redeem:' + p1.id) || '{}');
  ok(redeem.m === midA, '赎回登记记录的机器码与之一致（跨机比对用）', redeem.m);

  // 同机恢复：清掉本地记录（模拟误清站点数据），同一机器码再激活 → 恢复
  licenseWeb.resetRequestState();
  platform.setStorage(platform.newMemoryStorage());
  licenseWeb.setRequestDeviceId('a'.repeat(32));
  const a2 = await licenseWeb.activate(f1.code, { machine: midA });
  ok(a2.ok && a2.plan === 'free', 'Free 卡同机重激活可恢复（误清数据后不再被锁死）', JSON.stringify(a2));
  ok((await licenseWeb.exportRecord()).machine === midA, '恢复后记录仍绑原机器码');

  // 跨机器：B 机出示同一张卡 → 严格拒绝
  licenseWeb.resetRequestState();
  platform.setStorage(platform.newMemoryStorage());
  licenseWeb.setRequestDeviceId('b'.repeat(32));
  const b1 = await licenseWeb.activate(f1.code, { machine: midB });
  ok(!b1.ok && b1.reason === 'used', '异机复用同一张 Free 卡被拒（reason=used）', b1.reason);

  // 非 Free 卡保持严格一次性：同机重激活也拒（防重激活重置额度包）
  const plus = codec.issueCode(TEST_CODE_KEY, 'plus', 30, '99001', today);
  licenseWeb.resetRequestState();
  licenseWeb.setRequestDeviceId('a'.repeat(32));
  const c1 = await licenseWeb.activate(plus, { machine: midA });
  ok(c1.ok && c1.plan === 'plus', 'plus 卡携机器码激活成功');
  licenseWeb.resetRequestState();
  platform.setStorage(platform.newMemoryStorage());
  licenseWeb.setRequestDeviceId('a'.repeat(32));
  const c2 = await licenseWeb.activate(plus, { machine: midA });
  ok(!c2.ok && c2.reason === 'used', '非 Free 卡保持严格一次性（同机重激活也拒）', c2.reason);

  // ④ 7 天到期后续期（2026-10-03 修）：台账里那张卡满 7 天后必须重签一张新的。
  //    原先无条件回放台账里的卡，于是到期后 activate 永远判 reason=expired，而卡号
  //    又是机器码确定性派生的、重签也只能拿到同一个卡号——这条自服务通道会永久死掉。
  //    构造：先正常派一张拿到真实卡号，再把台账换成"同一卡号、签发日很早"的过期卡。
  const midC = 'ABCDEFGHJKMNPQRSTVWXYZ03';
  const firstC = await licenseWeb.issueFreeKey(midC);
  const firstParsed = codec.parseCode(TEST_CODE_KEY, firstC.code);
  ok(firstC.ok && firstParsed.ok, '新机器首次派发成功', firstC.reason);
  const staleFree = codec.issueCode(
    TEST_CODE_KEY, 'free', licenseWeb.FREE_KEY_DAYS, firstParsed.id, today - 30,
  );
  ok(licCore.expiryFromIssueDay(codec.parseCode(TEST_CODE_KEY, staleFree)) < platform.now(),
    '构造出的台账卡确实已过期');
  store.set('freekey:' + midC, JSON.stringify({ k: staleFree, m: midC, t: 1 }));

  const renew = await licenseWeb.issueFreeKey(midC);
  const renewParsed = codec.parseCode(TEST_CODE_KEY, renew.code);
  ok(renew.ok && renewParsed.ok && renewParsed.id === firstParsed.id,
    '到期后续期：卡号仍由机器码派生（同一卡号，"一机一卡"不破）',
    renewParsed.id + ' vs ' + firstParsed.id);
  ok(renewParsed.issueDay === today, '到期后续期：签发日更新为今天（旧卡已满 7 天）',
    'issueDay=' + renewParsed.issueDay);
  ok(licCore.expiryFromIssueDay(renewParsed) > platform.now(), '续期后的卡未过期');
  const replay = await licenseWeb.issueFreeKey(midC);
  ok(replay.ok && replay.code === renew.code && replay.source === 'ledger',
    '续期后同机再取回放的仍是这张有效卡（不会立刻又触发续期）', replay.source);

  platform.setKv(null);
  platform.setStorage(null);
  licenseWeb.resetRequestState();
}

if (process.argv[1] && process.argv[1].endsWith('license-web.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}
