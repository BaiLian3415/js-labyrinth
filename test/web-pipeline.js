#!/usr/bin/env node
/**
 * 浏览器侧等价链路：runJob、服务端路由与云存储 RESP 协议。
 *
 *   node test/web-pipeline.js
 *
 * 整跑全部用例：npm test（即 node test/selftest.js）。
 */
import { SAMPLE, cleanTmp, ok, report, runNode, section } from './_harness.js';
import pipeline from '../src/pipeline.js';
import makeZip from '../src/utils/zip.js';
import platform from '../src/platform.js';
import licenseWeb from '../src/license-web.js';
import codec from '../src/license-codec.js';
import licCore from '../src/license-core.js';
import plan from '../src/plan.js';
import obfuscateMod from '../src/obfuscate.js';

const { runJob } = pipeline;
const { obfuscate } = obfuscateMod;

// 测试专用签发密钥对。
//
// 真私钥不随源码分发（这正是换成非对称的目的），所以自测不能拿它签卡——也不该
// 拿。测试自己固定一对：种子写死在这里，公钥由它派生，再通过 setKeyMaterial /
// JSLB_CODE_KEY 注入到 license-web 与 Worker。走的签发/校验代码路径与线上完全
// 相同，只有密钥不同。种子是公开的常量，仅供测试，绝不能用于真实发卡。
const TEST_CODE_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
section('网页链路（授权 → 限额 → 混淆 → 记账）');
{
  platform.setStorage(null); // 回到内存实现，测试不碰 localStorage
  const ens = await licenseWeb.ensure();
  ok(ens.ok && ens.trial, '未激活时按网页版策略进入试用');

  const ent = licenseWeb.entitlements();
  ok(!!ent && ent.trial && ent.preset === platform.getWebConfig().trialPreset,
    '试用权益的预设上限来自配置');

  let consumed = 0;
  const r = await runJob({
    code: SAMPLE, options: { preset: 'low', seed: 3 }, ent, consumeRun: async () => { consumed++; return { ok: true, used: 1, total: 0 }; },
  });
  ok(r.ok && typeof r.code === 'string' && r.code.length > 100, 'runJob 产出结果');
  ok(consumed === 1, '成功任务记一次用量');
  ok(runNode(r.code, 'webrun.js').includes('hello world'), '网页链路产物可执行');

  const blocked = await runJob({ code: SAMPLE, options: { preset: 'max' }, ent });
  ok(!blocked.ok && blocked.status === 403, '越界预设被拦并给出 403');

  const big = 'x'.repeat(platform.getWebConfig().trialMaxFileBytes + 10);
  const oversize = await runJob({ code: '/*' + big + '*/', options: { preset: 'low' }, ent });
  ok(!oversize.ok && oversize.status === 413, '超出单文件限额被拦并给出 413');

  const noEnt = await runJob({ code: SAMPLE, options: {}, ent: null });
  ok(!noEnt.ok && noEnt.status === 401, '未授权时返回 401');

  const htmlJob = await runJob({
    code: '<html><body><script>console.log("hi");</script></body></html>',
    options: { preset: 'low', seed: 1 }, ent, type: 'auto',
  });
  ok(htmlJob.ok && htmlJob.html === true && htmlJob.code.includes('console.log') === false,
    'runJob 自动识别 HTML 并只改内联脚本');
}

section('服务端路由（/api/*）');
{
  const worker = (await import('../server/handler.js')).default;
  // 注入测试公钥：签卡要用私钥，而真私钥不随源码分发（这正是非对称的意义），
  // 所以测试自己造一把卡密密钥，通过 JSLB_CODE_KEY 交给服务端。走的代码路径
  // 与线上完全一致，只是密钥不同。
  const call = async (pathname, init) => {
    const req = new Request('https://example.com' + pathname, init);
    return worker.fetch(req, {
      JSLB_WEB_CONFIG: '{"trialPreset":"low","trialMaxFileBytes":65536}',
      JSLB_CODE_KEY: TEST_CODE_KEY,
    }, {});
  };

  const health = await call('/api/health');
  ok(health.status === 200 && (await health.json()).ok === true, 'GET /api/health');

  const plans = await call('/api/plans');
  const plansJson = await plans.json();
  // 档数不写死：跟着 plans.js 走，加档位时不用回来改测试
  ok(plans.status === 200 && Array.isArray(plansJson.plans)
    && plansJson.plans.length === plan.PLAN_NAMES.length,
    'GET /api/plans 返回全部 ' + plan.PLAN_NAMES.length + ' 档套餐');
  ok(plansJson.plans[0] && plansJson.plans[0].name === plan.DEFAULT_PLAN,
    '对照表首档即最低档 ' + plan.DEFAULT_PLAN);

  const lic = await call('/api/license');
  const licJson = await lic.json();
  ok(lic.status === 200 && licJson.ok === true && licJson.trial === true, 'GET /api/license 返回试用状态');
  ok(typeof licJson.machine === 'string' && licJson.machine.length === 24, 'API 侧机器码为 24 字符');

  // /api/machine：机器码由服务端签发并与卡密永久绑定。这条链路是"激活前后界面
  // 显示同一个机器码"的保证——老做法里服务端拿自己的环境派生，与浏览器永远不等。
  {
    const mStore = new Map();
    const mEnv = {
      JSLB_WEB_CONFIG: '{"trialPreset":"low","trialMaxFileBytes":65536}',
      JSLB_CODE_KEY: TEST_CODE_KEY,
      JSLB_KV: {
        get: async (k) => (mStore.has(k) ? mStore.get(k) : null),
        put: async (k, v) => { mStore.set(k, v); },
        delete: async (k) => { mStore.delete(k); },
      },
    };
    const callKv = async (pathname, init) => worker.fetch(
      new Request('https://example.com' + pathname, init), mEnv, {},
    );
    const mCode = codec.issueCode(TEST_CODE_KEY, 'plus', 30, '420001');

    const r1 = await callKv('/api/machine', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: mCode }),
    });
    const j1 = await r1.json();
    ok(r1.status === 200 && j1.ok === true && j1.machine.length === 24 && j1.issued === true,
      'POST /api/machine 签发 24 字符机器码', JSON.stringify(j1));
    ok(mStore.has('jslb:machine:420001'), '机器码按卡密编号登记进 KV');

    const r2 = await callKv('/api/machine', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-JSLB-Key': mCode },
      body: '{}',
    });
    const j2 = await r2.json();
    ok(j2.ok === true && j2.machine === j1.machine && j2.issued === false,
      '同一张卡再次请求返回同一个机器码（issued=false）', JSON.stringify(j2));

    const badM = await callKv('/api/machine', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'JSLB-BAD' }),
    });
    ok(badM.status === 400 && (await badM.json()).ok === false, '非法卡密取机器码被拒（400）');
    const noKey = await callKv('/api/machine', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    ok(noKey.status === 400, '缺卡密返回 400');
    ok((await callKv('/api/machine')).status === 405, 'GET /api/machine 返回 405（只收 POST）');

    // 关键回归：激活之后服务端回的机器码必须与 /api/machine 签发的一致
    const actM = await callKv('/api/license', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-JSLB-Device': '9'.repeat(32) },
      body: JSON.stringify({ key: mCode }),
    });
    const aj = await actM.json();
    ok(actM.status === 200 && aj.ok === true && aj.machine === j1.machine,
      '激活后 /api/license 的机器码与 /api/machine 一致（激活前后不再变）',
      aj.machine + ' vs ' + j1.machine);
  }

  // 服务端文案要按**请求**语言回。原先语言只在模块加载时读一次 JSLABYRINTH_LANG，
  // 于是界面切了英文的访问者拿到的 API 报错仍是中文（"Activation failed: 激活失败: …"）。
  {
    const bogus = 'JSLB-F-00-000-' + '0'.repeat(8) + '-' + '0'.repeat(16) + '-' + '0'.repeat(103);
    const badKey = async (headers) => (await (await call('/api/license', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ key: bogus }),
    })).json()).message || '';
    ok(/激活失败/.test(await badKey({})), '未指定语言时服务端报错为默认中文');
    ok(/Activation failed/.test(await badKey({ 'X-JSLB-Lang': 'en' })),
      'X-JSLB-Lang: en 时服务端报错为英文');
    ok(/Activation failed/.test(await badKey({ 'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8' })),
      'Accept-Language: en 时服务端报错为英文（脚本调用场景）');
    ok(/激活失败/.test(await badKey({ 'X-JSLB-Lang': 'fr' })),
      '未知语言取值回落默认语言，不影响请求（不会因 setLang 抛错而 500）');
  }

  const bad = await call('/api/obfuscate', { method: 'POST', body: '{oops' });
  ok(bad.status === 400, '非法 JSON 请求体返回 400');

  const run = await call('/api/obfuscate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-JSLB-Device': 'a'.repeat(32) },
    body: JSON.stringify({ code: 'console.log("worker");', options: { preset: 'low', seed: 11 } }),
  });
  const runJson = await run.json();
  ok(run.status === 200 && runJson.ok === true, 'POST /api/obfuscate 成功');
  ok(runJson.code && runJson.originalSize > 0 && runJson.obfuscatedSize > 0, '返回产物与体积统计');
  ok(runJson.code.includes('worker') === false, '产物中不再出现明文字符串');

  const gated = await call('/api/obfuscate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: SAMPLE, options: { preset: 'max' } }),
  });
  ok(gated.status === 403, '越界预设经 API 返回 403');

  const missing = await call('/api/nope');
  ok(missing.status === 404, '未知路由返回 404');

  const pre = await call('/api/obfuscate', { method: 'OPTIONS' });
  ok(pre.status === 204 && pre.headers.get('access-control-allow-origin') !== null, 'OPTIONS 预检带 CORS 头');
  // 跨域调用方要能带语言头——不在 allow-headers 里会被浏览器预检拦掉
  ok((pre.headers.get('access-control-allow-headers') || '').includes('x-jslb-lang'),
    '预检放行 X-JSLB-Lang 头');

  // 激活流程：用 keygen 的签发路径造一张卡密，走 /api/license 激活
  const keys = [TEST_CODE_KEY, TEST_CODE_KEY];
  const issued = codec.issueCode(keys[0], 'plus', 30, '98765');
  const act = await call('/api/license', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-JSLB-Device': 'b'.repeat(32) },
    body: JSON.stringify({ key: issued }),
  });
  const actJson = await act.json();
  ok(act.status === 200 && actJson.ok === true && actJson.plan === 'plus' && actJson.trial === false,
    'POST /api/license 激活 Plus 卡密', JSON.stringify(actJson && actJson.message));
  ok(actJson.preset === plan.presetCeiling('plus'), '激活后预设上限取自套餐');

  const afterAct = await call('/api/obfuscate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-JSLB-Key': issued, 'X-JSLB-Device': 'b'.repeat(32) },
    body: JSON.stringify({ code: SAMPLE, options: { preset: 'medium', seed: 2 } }),
  });
  const afterJson = await afterAct.json();
  ok(afterAct.status === 200 && afterJson.ok === true, '激活后可跑套餐内预设');
  ok(afterJson.quota && afterJson.quota.used >= 1, '响应里带用量');

  // v5 卡密没有独立的套餐段（套餐在加密的信息段里），篡改用例改为翻转校验码
  // 末位——任何一位被改都必须在校验码这一步被拒。
  const tamperFlip = (t) => t.slice(0, -1) + (t.endsWith('0') ? '1' : '0');
  const tampered = await call('/api/obfuscate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-JSLB-Key': tamperFlip(issued) },
    body: JSON.stringify({ code: SAMPLE, options: { preset: 'low' } }),
  });
  ok(tampered.status === 401, '篡改校验码的卡密被拒（401）');

  // 跨实例补登记：服务端换了实例（没接云存储时记录只活在处理激活的那台的内存里）
  // 就认不出这台设备，用户点「运行」会收到一句"激活失败: 未找到许可证文件"。
  // 界面因此把本机那份签名记录一并附在 /api/obfuscate 的请求体里，服务端用与
  // /api/license 补登记**同一个** importRecord 采纳（验签 + 自锚定机器码 + 赎回
  // 登记，一项不少）。下面这条环境没有 JSLB_KV，每个请求的存储都是新的，正好等价
  // 于"冷实例"，是这条自愈路径最直接的回归测试。
  {
    // 这三条必须在部署的真实策略下断言：requireLicense=true 时无记录才会回 402，
    // 否则走**试用**分支回 200，断言会"假绿"（第一版就踩了这个坑）。
    const callRl = async (pathname, init) => {
      const req = new Request('https://example.com' + pathname, init);
      return worker.fetch(req, {
        JSLB_WEB_CONFIG: '{"requireLicense":true,"trialPreset":"low","trialMaxFileBytes":65536}',
        JSLB_CODE_KEY: TEST_CODE_KEY,
      }, {});
    };
    const freshKey = codec.issueCode(TEST_CODE_KEY, 'plus', 30, '97531');
    const local = await licenseWeb.activate(freshKey);
    ok(local.ok, '本机本地激活新卡（构造客户端记录）', local.reason || '');
    const rec = await licenseWeb.exportRecord();
    ok(!!rec && !!rec.plan, '导出可交给服务端的签名记录');

    const noRec = await callRl('/api/obfuscate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-JSLB-Device': 'c'.repeat(32) },
      body: JSON.stringify({ code: SAMPLE, options: { preset: 'low' } }),
    });
    ok(noRec.status === 402, '冷实例上不带记录 → 402（复现用户症状）', 'status=' + noRec.status);

    const withRec = await callRl('/api/obfuscate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-JSLB-Device': 'c'.repeat(32) },
      body: JSON.stringify({ record: rec, code: SAMPLE, options: { preset: 'low' } }),
    });
    const withJson = await withRec.json();
    ok(withRec.status === 200 && withJson.ok === true,
      '冷实例上带签名记录 → 补登记后照常执行（跨实例自愈）',
      'status=' + withRec.status + ' ' + String(withJson.message || '').slice(0, 60));

    // 反向：伪造的记录不能让服务端放行（改一个字节即验签失败）。**换一台设备码**——
    // 否则上一条已把有效记录写进这台实例的存储，restore() 会先命中它，压根测不到
    // "篡改记录会不会被采纳"这件事（第一版的探针就因此误判过一次）。
    const broken = { ...rec, plan: 'business' };
    const badRec = await callRl('/api/obfuscate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-JSLB-Device': '9'.repeat(32) },
      body: JSON.stringify({ record: broken, code: SAMPLE, options: { preset: 'low' } }),
    });
    ok(badRec.status === 402, '篡改过的记录不被采纳（仍 402）', 'status=' + badRec.status);
  }

  // ---------------------------------------------------------- 换卡：升级 / 降级 / 搬运
  //
  // 2026-10-03 线上报障：激活了 Plus，跑 medium 仍被判
  // 「预设 medium 超出套餐 Free 的强度上限 low」。根因是 importRecord 的
  // 「服务端已有有效记录就沿用」——requireLicense 部署下网页会自动派发一张 Free 卡
  // 并先在服务端落一份记录，用户后来买的 Plus 就再也顶不上去；而 cloudOnly 部署下
  // 每次运行都过服务端闸门，于是买了额度用不上。
  //
  // 这一节钉住三个方向，缺一不可：升级放行、降级拦住、搬运拒绝。
  {
    const kvStore = new Map();
    const kv = {
      get: async (k) => (kvStore.has(k) ? kvStore.get(k) : null),
      put: async (k, v) => { kvStore.set(k, v); return true; },
      del: async (k) => { kvStore.delete(k); },
    };
    const CFG = JSON.stringify({
      requireLicense: true, trialPreset: 'low', trialMaxFileBytes: 65536, cloudOnly: true,
    });
    // 浏览器侧与 Worker 必须隔开：worker.fetch 每次都会 prepareEnv 重置 platform
    // （KV 键加 jslb: 前缀、存储换新），所以每调一次接口后要把浏览器侧的装回去。
    const lsStore = new Map();
    const asBrowser = () => {
      platform.setEnv({});
      platform.setKv(null);
      platform.setStorage({
        get: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
        set: (k, v) => { lsStore.set(k, v); return true; },
        remove: (k) => { lsStore.delete(k); },
      });
      licenseWeb.resetRequestState();
      licenseWeb.setKeyMaterial(TEST_CODE_KEY, null);
    };
    const MID = 'ABCDEFGHJKMNPQRSTVWXYZ01';
    const callUp = async (pathname, body, dev, mid) => worker.fetch(new Request('https://example.com' + pathname, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'X-JSLB-Device': dev, 'X-JSLB-Machine': mid || MID,
      },
      body: JSON.stringify(body),
    }), { JSLB_WEB_CONFIG: CFG, JSLB_CODE_KEY: TEST_CODE_KEY, JSLB_KV: kv }, {});
    const browserActivate = async (code) => {
      asBrowser();
      const r = await licenseWeb.activate(code, { machine: MID });
      return { ok: r.ok, plan: r.plan, reason: r.reason };
    };
    const browserRecord = async () => { asBrowser(); return licenseWeb.exportRecord(); };

    // ① 网页自动派发 Free 卡 → 服务端落一份 Free 记录（requireLicense 下的首访路径）
    const devUp = '1'.repeat(32);
    const issuedJson = await (await callUp('/api/free-key', {}, devUp)).json();
    ok(issuedJson.ok === true && typeof issuedJson.key === 'string', '/api/free-key 派发 Free 卡');
    ok((await browserActivate(issuedJson.key)).plan === 'free', '浏览器激活 Free 卡');
    const freeRec = await browserRecord();
    const freePush = await (await callUp('/api/license', { record: freeRec }, devUp)).json();
    ok(freePush.ok === true && freePush.plan === 'free', 'Free 记录补登记成功', JSON.stringify(freePush.message || ''));

    // ② 买 Plus：本地验签 + pushLicense。修复前服务端会沿用 Free，plan 停在 free。
    const plusCode = codec.issueCode(TEST_CODE_KEY, 'plus', 30, '97530');
    const plusAct = await browserActivate(plusCode);
    ok(plusAct.ok === true && plusAct.plan === 'plus', '浏览器激活 Plus 卡', plusAct.reason || '');
    const plusRec = await browserRecord();
    const plusPush = await (await callUp('/api/license', { record: plusRec }, devUp)).json();
    ok(plusPush.ok === true && plusPush.plan === 'plus',
      '升级：Free → Plus 后服务端认定 plus（修复前停在 free）', plusPush.plan || plusPush.message);
    const runUp = await callUp('/api/obfuscate', {
      record: plusRec, code: SAMPLE, options: { preset: 'medium', seed: 4 },
    }, devUp);
    ok(runUp.status === 200 && (await runUp.json()).ok === true,
      'cloudOnly 下 medium 放行（报障症状消失）', 'status=' + runUp.status);

    // ③ 降级不得生效：一份 Free 记录不能把服务端的 Plus 顶掉
    const freeCode2 = codec.issueCode(TEST_CODE_KEY, 'free', 365, '97529');
    const freeRec2 = licCore.makeRecord({
      code: freeCode2, plan: 'free', machine: MID, issuedAt: Date.now(),
      expiresAt: licCore.expiryFromIssueDay(codec.parseCode(TEST_CODE_KEY, freeCode2)),
      usage: { day: licCore.todayKey(), used: 0 },
    }, TEST_CODE_KEY);
    const downgrade = await (await callUp('/api/license', { record: freeRec2 }, devUp)).json();
    ok(downgrade.ok === true && downgrade.plan === 'plus',
      '降级：Free 记录不得覆盖服务端的 Plus', downgrade.plan || downgrade.message);

    // ④ 搬运：A 机的记录整份复制到 B 机必须被拒。记录自称的 machine 会被一起搬走，
    //    所以只有拿请求侧的 X-JSLB-Machine 比对才拦得住（见 importRecord 的说明）。
    const devA = '2'.repeat(32);
    const devB = '3'.repeat(32);
    const midB = 'ABCDEFGHJKMNPQRSTVWXYZ02';
    const packCode = codec.issueCode(TEST_CODE_KEY, 'pack100', 0, '97528');
    const actA = await (await callUp('/api/license', { key: packCode }, devA, MID)).json();
    ok(actA.ok === true && actA.plan === 'pack100', 'A 机激活 pack100', actA.plan || actA.message);
    // A 机手上那份签名记录（自锚定补登记走的就是这份）
    const packRec = licCore.makeRecord({
      code: packCode, plan: 'pack100', machine: MID, issuedAt: Date.now(),
      expiresAt: licCore.expiryFromIssueDay(codec.parseCode(TEST_CODE_KEY, packCode)),
      usage: { day: licCore.todayKey(), used: 0 },
    }, TEST_CODE_KEY);
    const stolen = await (await callUp('/api/license', { record: packRec }, devB, midB)).json();
    ok(stolen.ok === false && /machine|机器/.test(String(stolen.message || '')),
      '搬运：B 机拿 A 机的记录补登记被拒', JSON.stringify(stolen.message || stolen.ok));
    const bEnt = await (await callUp('/api/license', {}, devB, midB)).json();
    ok(bEnt.ok === false, 'B 机仍无权益', JSON.stringify(bEnt.plan || bEnt.message));

    // ⑤ /api/license 带卡密而设备已有记录：必须是同一张卡才复用，否则走 activate。
    //    修复前只看"有没有有效记录"，Free 记录会让 Plus 卡被当成"已激活"而跳过。
    const devC = '4'.repeat(32);
    const freeCode3 = codec.issueCode(TEST_CODE_KEY, 'free', 365, '97527');
    await callUp('/api/license', { key: freeCode3 }, devC, MID);
    const plusCode2 = codec.issueCode(TEST_CODE_KEY, 'plus', 30, '97526');
    const upKey = await (await callUp('/api/license', { key: plusCode2 }, devC, MID)).json();
    ok(upKey.ok === true && upKey.plan === 'plus',
      '设备已有 Free 记录时出示 Plus 卡：真的换了套餐（修复前静默沿用 Free）', upKey.plan || upKey.message);

    platform.setKv(null);
    platform.setStorage(null);
    licenseWeb.resetRequestState();
  }

  // 严格一次性 + KV 赎回登记：激活写入 {卡密, 机器码, 时间戳}；同机重复请求靠
  // restore 复用不被误伤，异机再用同一卡密即 401。
  {
    const kvStore = new Map();
    const kv = {
      get: async (k) => (kvStore.has(k) ? kvStore.get(k) : null),
      put: async (k, v) => { kvStore.set(k, v); },
      del: async (k) => { kvStore.delete(k); },
    };
    const callKv = async (pathname, init) => {
      const req = new Request('https://example.com' + pathname, init);
      return worker.fetch(req, {
        JSLB_WEB_CONFIG: '{"trialPreset":"low","trialMaxFileBytes":65536}',
        JSLB_CODE_KEY: TEST_CODE_KEY,
        JSLB_KV: kv,
      }, {});
    };
    const code = codec.issueCode(TEST_CODE_KEY, 'plus', 30, '24680');
    const dev1 = 'e'.repeat(32);
    const dev2 = 'f'.repeat(32);
    const act1 = await callKv('/api/license', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-JSLB-Device': dev1 },
      body: JSON.stringify({ key: code }),
    });
    ok(act1.status === 200 && (await act1.json()).ok === true, '绑 KV 后激活成功');
    const redeemRec = JSON.parse(kvStore.get('jslb:redeem:24680') || 'null');
    ok(redeemRec && redeemRec.k === code && typeof redeemRec.m === 'string' && redeemRec.m.length === 24 && redeemRec.t > 0,
      'KV 赎回登记含卡密原文、24 位机器码与时间戳');

    const again = await callKv('/api/obfuscate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-JSLB-Key': code, 'X-JSLB-Device': dev1 },
      body: JSON.stringify({ code: SAMPLE, options: { preset: 'low' } }),
    });
    ok(again.status === 200, '同机重复带卡密请求走 restore 复用（200，不被 used 误伤）');

    const other = await callKv('/api/license', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-JSLB-Device': dev2 },
      body: JSON.stringify({ key: code }),
    });
    ok(other.status === 401, '同一张卡密异机激活被拒（401）');
  }
}

section('云存储适配与 RESP 协议');
{
  // 这一段全是纯函数与工厂选择，不建连：vercel/store.js 认 Upstash REST 与标准
  // Redis 连接串两条路，选错路的表现是 /api/health 的 store 字段不对，而那要到线
  // 上才看得见，所以选路规则必须在离线段钉住。
  const { createStore } = await import('../vercel/store.js');
  const { encodeCommand, parseReply } = await import('../vercel/redis-tcp.js');

  // ---- 选路 ----
  ok(createStore({}).kind === 'memory' && createStore({}).note === 'no-store',
    '没配任何存储变量 → 退化为单实例内存并标 no-store');
  ok(createStore({ KV_REST_API_URL: 'https://x.example/' }).kind === 'memory',
    'REST 只给 URL 不给 token（不成对）→ 不认，退内存');
  ok(createStore({ KV_REST_API_URL: 'https://x.example', KV_REST_API_TOKEN: 't' }).kind === 'upstash',
    'KV_REST_API_URL + TOKEN 成对 → 走 Upstash REST');
  ok(createStore({ UPSTASH_REDIS_REST_URL: 'https://y.example', UPSTASH_REDIS_REST_TOKEN: 't' }).kind === 'upstash',
    'UPSTASH_* 成对 → 同样走 REST');
  // Vercel 官方 Redis 只注入 REDIS_URL，这是本部署实际生效的那条路。
  const tcp = createStore({ REDIS_URL: 'redis://default:pw@db.example.io:10944' });
  ok(tcp.kind === 'redis', '只有 REDIS_URL → 走标准 Redis 协议（kind=redis）');
  ok(tcp.note === '', '接上存储时 note 为空（界面不会误报"没接存储"）');
  ok(typeof tcp.kv.get === 'function' && typeof tcp.kv.put === 'function'
    && typeof tcp.kv.delete === 'function' && typeof tcp.addNumber === 'function',
  'redis 版与 REST 版暴露同一组方法（get/put/delete/addNumber）');
  ok(createStore({
    REDIS_URL: 'redis://default:pw@db.example.io:10944',
    KV_REST_API_URL: 'https://z.example',
    KV_REST_API_TOKEN: 't',
  }).kind === 'upstash',
  '两组都配时 REST 优先（函数里只有一次 fetch，冻结下最省事）');
  const badUrl = createStore({ REDIS_URL: '这不是一个连接串' });
  ok(badUrl.kind === 'memory' && badUrl.note === 'bad-redis-url',
    '连接串坏了要退内存并标 bad-redis-url（不能抛，抛了整条 /api/* 都 500）');

  // ---- 命令编码 ----
  ok(encodeCommand(['GET', 'k']).toString('utf8') === '*2\r\n$3\r\nGET\r\n$1\r\nk\r\n',
    '命令编成 RESP 数组');
  // 注意长度是字节数：'jslb:cloud:cpu:2026-01-01' 是 25 个字符，INCRBY 是 6 个。
  ok(encodeCommand(['INCRBY', 'jslb:cloud:cpu:2026-01-01', '250']).toString('utf8')
    === '*3\r\n$6\r\nINCRBY\r\n$25\r\njslb:cloud:cpu:2026-01-01\r\n$3\r\n250\r\n',
  'INCRBY 三个参数各自按字节数计长');
  // 中文是三个字节。长度按字符数算就会错位，回包解出来必然是乱码——这类 bug 在真
  // 部署上表现为"授权记录写进去读出来是坏的"，极难查，所以钉一条。
  ok(encodeCommand(['SET', 'k', '中']).toString('utf8') === '*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$3\r\n中\r\n',
    '参数长度按 UTF-8 字节数（中文 1 字 = 3 字节）');
  ok(encodeCommand([]).toString('utf8') === '*0\r\n', '空命令编出 *0');

  // ---- 回包解析 ----
  const p = (s) => parseReply(Buffer.from(s, 'utf8'));
  ok(p('+OK\r\n').ok && p('+OK\r\n').value === 'OK', '简单字符串 +OK');
  ok(p(':42\r\n').ok && p(':42\r\n').value === 42, '整数 :42（INCRBY 的回包）');
  ok(p('$-1\r\n').ok && p('$-1\r\n').value === null, '$-1 是 nil（键不存在）');
  ok(!p('-ERR unknown command\r\n').ok, '错误回包 -ERR 不算成功');
  ok(p('$5\r\nhello\r\n').value === 'hello', '定长 bulk');
  ok(p('$9\r\n中文字\r\n').value === '中文字', 'bulk 里的中文按字节数解（9 字节，不被截断）');
  const arr = p('*2\r\n$3\r\nfoo\r\n:7\r\n');
  ok(arr.ok && Array.isArray(arr.value) && arr.value[0] === 'foo' && arr.value[1] === 7,
    '数组回包逐项解析');
  // 一次喂进两条回包：必须能切开（连接上"上一次的余量 + 新到的整包"就是这个形状）。
  const two = parseReply(Buffer.from('+OK\r\n$5\r\nhello\r\n', 'utf8'));
  ok(two.ok && two.value === 'OK' && two.rest === 5, '一次切一条，rest 指出剩下多少字节');
  // 半条是常态，不是错误：数据跨 TCP 分段到达。
  ok(parseReply(Buffer.from('$5\r\nhe', 'utf8')) === null, 'bulk 只到一半 → null（等下一段）');
  // 尾部 CRLF 缺一字节同样要等：急着解就会把半条当整条，剩下一个字节留在缓冲里错位。
  ok(parseReply(Buffer.from('$5\r\nhello', 'utf8')) === null, 'bulk 数据齐了但尾部 CRLF 没齐 → 仍等');
  ok(parseReply(Buffer.from('$5\r\nhello\r\n', 'utf8')).ok, '尾部 CRLF 齐了才解出整条');
  ok(parseReply(Buffer.from('*2\r\n$3\r\nfoo\r\n', 'utf8')) === null, '数组缺第二项 → null');
  ok(parseReply(Buffer.from('', 'utf8')) === null, '空缓冲 → null');
}

if (process.argv[1] && process.argv[1].endsWith('web-pipeline.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}
