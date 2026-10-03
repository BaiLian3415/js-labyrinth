#!/usr/bin/env node
/**
 * 线上验收：打已部署的 Vercel 站点，确认部署与策略真的生效。
 *
 *   node test/live-verify.js
 *
 * 整跑全部用例：npm test（即 node test/selftest.js）。
 */
import path from 'node:path';
import { cleanTmp, counters, ok, report, runNode, section } from './_harness.js';
import obfuscateMod from '../src/obfuscate.js';
import htmlMod from '../src/html.js';
import html2memMod from '../src/html2mem.js';
import codec from '../src/license-codec.js';
import plan from '../src/plan.js';
import gate from '../src/options-gate.js';
import optionsMeta from '../src/options-meta.js';
import licenseWeb from '../src/license-web.js';
import secret from '../src/license-secret.js';
import hash from '../src/utils/hash.js';
import { ensureProxy } from '../tools/lib/proxy.js';

// 线上验收要打已部署的站点。装了代理客户端的机器上，浏览器自动走代理而 Node 的
// fetch 不走，直连还可能被 DNS 解析到不相干的地址——切换靠进程启动时的
// --use-env-proxy，所以必须在任何实际工作之前决定，否则重启会把前面的用例重跑一遍。
// 仅在本段真的要执行时才重启：离线跑（未设 JSLB_LIVE_ORIGIN 或 JSLB_SKIP_LIVE=1）
// 不该为此多跑一次全套。强制直连设 JSLB_NO_PROXY=1。
const wantLive = process.env.JSLB_SKIP_LIVE !== '1'
  && !!(process.env.JSLB_LIVE_ORIGIN || '').trim();
if (wantLive) ensureProxy('live-verify.js');

const { obfuscate } = obfuscateMod;
const { obfuscateDocument } = htmlMod;
const h2mMod = html2memMod.default || html2memMod;

// 测试专用签发密钥对。
//
// 真私钥不随源码分发（这正是换成非对称的目的），所以自测不能拿它签卡——也不该
// 拿。测试自己固定一对：种子写死在这里，公钥由它派生，再通过 setKeyMaterial /
// JSLB_CODE_KEY 注入到 license-web 与 Worker。走的签发/校验代码路径与线上完全
// 相同，只有密钥不同。种子是公开的常量，仅供测试，绝不能用于真实发卡。
const TEST_CODE_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
section('增强保护：引导层自检 / 碎片化 / Anti-LLM');
{
  const src = 'function calc(a, b) { var t = a * 2 + b; if (t > 10) { t -= 3; } return t; }\n'
    + 'function label(n) { return n > 5 ? "big" : "small"; }\n'
    + 'var out = [];\nfor (var i = 0; i < 3; i++) { out.push(label(calc(i, 4))); }\n'
    + 'process.stdout.write(out.join(",") + "|" + calc(1, 2));';
  const want = 'small,big,big|4';
  const r = obfuscate(src, { preset: 'max', seed: 4242 });
  const st = {};
  for (const s of r.stats || []) st[s.pass] = s.result;

  // 语义：max 预设（全部 VM 选项）产物语义不变
  ok(runNode(r.code, 'enh-max.js').trim() === want,
    'max 预设产物语义不变');

  // 语义等价：max 预设多 seed
  let vmBad = 0;
  for (const seed of [1, 2, 3]) {
    const c = obfuscate(src, { preset: 'max', seed }).code;
    if (runNode(c, 'enh-max-' + seed + '.js').trim() !== want) vmBad++;
  }
  ok(vmBad === 0, 'max 预设跨 seed 语义一致（3 个 seed）');

  // 字符串碎片化：多载体计数 + 与关闭时结构不同
  ok(st.stringArray && st.stringArray.scatterCarriers >= 2, '字符串碎片化多载体生效',
    JSON.stringify(st.stringArray));
  const rNo = obfuscate(src, { preset: 'max', seed: 4242, stringScatter: false });
  const stNo = {};
  for (const s of rNo.stats || []) stNo[s.pass] = s.result;
  ok(stNo.stringArray && stNo.stringArray.scatterCarriers === 0, '关闭碎片化时不产生载体');
  ok(r.code !== rNo.code, '碎片化开关改变产物');

  // Anti-LLM：注记与伪业务分支
  ok(st.antiLLM && (st.antiLLM.notes + st.antiLLM.decoys) > 0, 'Anti-LLM 注记/诱饵已注入',
    JSON.stringify(st.antiLLM));

  // 引导层（2026-09-30 起取代文件头横幅）：不再写 `/*! … */` 注释，互锁改由
  // 引导内部的随机字面量当比对锚点。签名/声明随注释一起去掉，互锁没丢。
  // 断言写成「不多于源码自带」而不是「一个都没有」：混淆器自己不写 /*!，但源码
  // 里本来就有 /*! 注释时，产物里出现 /*! 并不代表引导层还在写注释。
  const srcBang = (r.code.match(/\/\*!/g) || []).length;
  const ownBang = (src.match(/\/\*!/g) || []).length;
  ok(srcBang <= ownBang, '产物里的 /*! 不多于源码自带（混淆器自己不再写注释）',
    '产物 ' + srcBang + ' 处 / 源码 ' + ownBang + ' 处');
  ok(!r.code.includes('Author: Heling'), '产物里不含作者署名');
  ok(!/\bJsLabyrinth v1\.0\.0\b/.test(r.code), '产物里不含混淆器版本声明');
  ok(st.guard && typeof st.guard.salt === 'number', 'stats 有 guard 项且 salt 是数字',
    JSON.stringify(st.guard));
  ok(st.guard && st.guard.wrapped === true, 'guard.wrapped=true（max 默认套外壳）');
  ok(st.banner === undefined, '不再有 banner 统计项');
  ok(obfuscate(src, { preset: 'max', seed: 4242 }).code === r.code, '同 seed 产物逐字节可复现');

  // 防篡改：改引导里的锚点字面量一位 → 盐错位 → 外壳密钥流解不开
  {
    const m = r.code.match(/"(jr[0-9a-f]{16}[0-9a-z]+)"/);
    ok(!!m, '产物里找得到引导锚点字面量', m ? m[1] : '(未匹配)');
    let broken = 'RUNS';
    let badOut = '';
    if (m) {
      const v = m[1];
      const hex = '0123456789abcdef';
      const tampered = r.code.replace('"' + v + '"',
        '"' + v.slice(0, -1) + hex[(hex.indexOf(v[v.length - 1]) + 1) % 16] + '"');
      try {
        const got = runNode(tampered, 'enh-tamper.js');
        badOut = '输出 ' + String(got).slice(0, 40);
      } catch (e) { broken = 'BREAKS'; }
    }
    ok(broken === 'BREAKS', '改引导锚点字面量后产物失效（互锁仍在）', broken + ' ' + badOut);
  }

  // 防删：整行删掉引导 → 盐变量未定义 + 健康载体没人写 → 产物失效
  {
    const lines = r.code.split('\n');
    const gi = lines.findIndex((l) => /= ?"jr[0-9a-f]{16}/.test(l));
    ok(gi >= 0, '找得到引导所在行', '第 ' + (gi + 1) + ' 行');
    let broken = 'RUNS';
    if (gi >= 0) {
      const cut = lines.slice();
      cut.splice(gi, 1);
      try { runNode(cut.join('\n'), 'enh-cut.js'); } catch (e) { broken = 'BREAKS'; }
    }
    ok(broken === 'BREAKS', '整行删掉引导后产物失效（不可删除）', broken);
  }

  // 关掉外壳时引导仍注入（不额外引入 eval 层），产物可执行
  {
    const rs = obfuscate(src, { preset: 'max', seed: 9, shell: false });
    ok(!/eval/.test(rs.code.split('\n').slice(0, 3).join('\n')), '无外壳时引导不引入 eval 层');
    const g = (rs.stats || []).find((x) => x.pass === 'guard');
    ok(g && g.result && g.result.wrapped === false, '无外壳时 guard.wrapped=false');
    ok(runNode(rs.code, 'enh-noshell.js').trim() === want, '无外壳 + 引导产物可执行');
  }

  // shebang 顺序：hashbang 必须在第一行，引导紧随其后
  //
  // 判据取「引导 IIFE 在第 2 行开」而不是「token 落在前 3 行里」：token 是引导内部
  // 的一枚常量，它所在的行数取决于引导函数体前几行有多少条声明，跟着引导代码的
  // 排版变（实测已从第 3 行挪到第 4 行，seed 1/3/5/9 一致），拿它当"紧随"的判据
  // 就是拿内部实现细节当契约，改一次排版就假失败。真正要钉的是**引导紧跟在
  // hashbang 之后、抢在用户代码之前**——IIFE 的起始行才是这个位置。
  {
    const sh = obfuscate('#!/usr/bin/env node\nprocess.stdout.write("ok");', { preset: 'low', seed: 3 });
    const lines = sh.code.split('\n');
    ok(lines[0].startsWith('#!'), 'hashbang 仍在第一行');
    ok(/^\(function\(\)\{/.test(lines[1] || ''), '引导紧随 hashbang（IIFE 在第 2 行开）',
      '第 2 行 = ' + JSON.stringify((lines[1] || '').slice(0, 40)));
    ok(/jr[0-9a-f]{16}/.test(lines.slice(0, 8).join('\n')), '引导 token 落在文件头部');
    ok(runNode(sh.code, 'enh-shebang.js').trim() === 'ok', '带 hashbang 的产物可执行');
  }
}

// 线上验收（需要网络）
//
// 打已部署的 Vercel 站点，验证"本地构建的东西真的在线上跑着"。这一段是
// 唯一会走网络的测试：它验的是部署，不是算法。算法与授权链路的判定在前面的
// 离线段里已经全部覆盖过了，两者互补。
//
//   JSLB_LIVE_ORIGIN   目标站点（**必须显式给**，例如 https://<你的站点>.vercel.app）
//   JSLB_SKIP_LIVE=1   跳过本段（离线跑测试、或还没部署时用）
//
// 没给 JSLB_LIVE_ORIGIN 就直接跳过：旧版本硬编码过一个 Cloudflare 域名，站点迁走
// 之后那个默认值只会稳定地报"不可达"，把环境问题伪装成部署问题。
//
// 注意：本段通过与网络状况有关。它失败时先看是"站点不可达"还是"内容不对"——
// 前者是环境问题，后者才是部署问题。
// ---------------------------------------------------------------------------
const LIVE_ORIGIN = (process.env.JSLB_LIVE_ORIGIN || '').replace(/\/+$/, '');
if (process.env.JSLB_SKIP_LIVE === '1') {
  console.log('\n线上验收（已按 JSLB_SKIP_LIVE=1 跳过）');
} else if (!LIVE_ORIGIN) {
  console.log('\n线上验收（未设 JSLB_LIVE_ORIGIN，跳过；'
    + '部署后用 JSLB_LIVE_ORIGIN=https://<站点> 打开）');
} else {
  section('线上验收：' + LIVE_ORIGIN);

  /** 带超时的 GET，返回 {status, text} 或 {status:0, err}。 */
  async function getLive(p, init) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(LIVE_ORIGIN + p, { ...init, signal: ctl.signal });
      return { status: r.status, text: await r.text() };
    } catch (e) {
      return { status: 0, err: (e && e.message) || String(e) };
    } finally {
      clearTimeout(t);
    }
  }

  const health = await getLive('/api/health');
  const reachable = health.status === 200;
  ok(reachable, '线上 /api/health 可达并返回 200',
    reachable ? '' : ('status=' + health.status + ' ' + (health.err || '')));

  if (!reachable) {
    // 站点都够不着，后面每项都会失败，只报一次即可，别刷屏。
    console.log('  （线上不可达，跳过后续线上断言）');
  } else {
    let info = null;
    try { info = JSON.parse(health.text); } catch { /* 下面断言会兜住 */ }
    ok(info && info.ok === true, 'health 返回 ok:true', health.text.slice(0, 120));
    // Vercel 侧由 vercel/entry.js 覆盖 runtime/engine：handler 自报的是 'node' / 'jslb-api'，
    // 部署到 Vercel 后必须是 vercel/vercel-functions，否则说明部署的不是本项目。
    ok(info && info.runtime === 'vercel', 'health 标明 runtime=vercel',
      info ? String(info.runtime) : '');
    ok(info && info.engine === 'vercel-functions', 'health 标明 engine=vercel-functions',
      info ? String(info.engine) : '');
    // 云端执行部署：产物里没有混淆核心，界面只能走 /api/obfuscate。
    ok(info && info.host === 'vercel-hobby', 'health 标明宿主=vercel-hobby',
      info ? String(info.host) : '');

    const plans = await getLive('/api/plans');
    ok(plans.status === 200, '线上 /api/plans 返回 200', 'status=' + plans.status);
    let plansBody = null;
    try { plansBody = JSON.parse(plans.text); } catch { /* ignore */ }
    ok(!!(plansBody && Array.isArray(plansBody.plans) && plansBody.plans.length > 0),
      '线上 /api/plans 返回非空套餐表',
      plansBody ? Object.keys(plansBody).join(',') : plans.text.slice(0, 120));
    // 网页版策略要求激活卡密：未激活一律拒绝，这一点必须在线上成立。
    // 注意策略挂在 body.web 下（不是顶层），见 server/handler.js 的 /api/plans。
    ok(!!(plansBody && plansBody.web && plansBody.web.requireLicense === true),
      '线上策略 web.requireLicense=true（未激活即拒绝）',
      plansBody && plansBody.web ? JSON.stringify(plansBody.web).slice(0, 160) : '');

    // 未授权调用 /api/obfuscate 必须被拒（不是 200），否则等于线上白送。
    const unauth = await getLive('/api/obfuscate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'var a=1;', preset: 'low' }),
    });
    ok(unauth.status !== 200,
      '线上未授权混淆被拒（不是 200）', 'status=' + unauth.status);

    // 混淆核心必须**根本不存在**。这一条以前是"未激活请求 /src/index.js 返回 403"
    //（Cloudflare 时代的核心下载鉴权门控）；云端执行下那套机制已整体删除，
    // 构建走 build:web:cloud 就不产出受保护模块，所以正确结果是 404 而不是 403。
    // 拿到 200 才是事故——那等于把混淆器源码挂在公开静态资源上。
    const gated = await getLive('/src/index.js');
    ok(gated.status === 404, '线上 /src/index.js 不存在（核心不进静态产物）',
      'status=' + gated.status);

    // 反向：界面渲染激活表单依赖的公开模块必须还在（挡多了未激活界面直接死锁）。
    for (const p of ['/src/plan.js', '/src/utils/hash.js']) {
      const pub = await getLive(p);
      ok(pub.status === 200, '线上公开模块 200 ' + p, 'status=' + pub.status);
    }

    // 静态外壳必须能拿到，否则页面根本打不开；且必须带云端执行标记，
    // 缺了它界面会误以为自己是浏览器内执行的构建，去 import 不存在的核心。
    const shell = await getLive('/index.html');
    ok(shell.status === 200, '线上 /index.html 可访问', 'status=' + shell.status);
    ok(shell.status === 200 && /name=["']jslabyrinth-cloud["']/.test(shell.text),
      '线上首页带 jslabyrinth-cloud 标记（界面据此走云端执行）',
      shell.status === 200 ? shell.text.slice(0, 80) : 'status=' + shell.status);

    console.log('  线上段依赖网络：失败时先区分"站点不可达"与"内容不符"。');
  }
}

  // HTML2MEM：文本节点与属性值加密成密文 + 还原 loader
  section('HTML2MEM（HTML 文本加密）');
  {
    const h2mSrc = '<!DOCTYPE html>\n'
      + '<html lang="zh"><head><meta charset="utf-8"><title>测试页 &amp; 标题</title>'
      + '<style>.a{color:red}</style></head>\n'
      + '<body>\n'
      + '  <h1 class="title" data-cfg="secret-value-123">可见文本：你好世界</h1>\n'
      + '  <p class="p2">第二段 &lt;b&gt;加粗&lt;/b&gt; 文本 ABC-456 &amp; 符号</p>\n'
      + '  <a href="/path?a=1&amp;b=2" data-x="v" title="提示 A&amp;B">链接文字</a>\n'
      + '  <input type="text" value="输入框默认值" placeholder="占位提示">\n'
      + '  <div disabled>无值属性</div>\n'
      + '  <script>var token = "token-abc";</script>\n'
      + '</body></html>';

    // 关闭时产物不含任何加密痕迹
    const offH = obfuscateDocument(h2mSrc, obfuscateMod.resolveOptions({ preset: 'low', seed: 5 }));
    ok(!/atob\(/.test(offH.html), 'html2mem 关闭时不注入 loader');
    ok(offH.html.includes('可见文本'), 'html2mem 关闭时文本保持明文（行为与改动前一致）');
    ok(offH.html2mem === null || offH.html2mem === undefined, 'html2mem 关闭时统计为空');

    // 开启后：明文消失、代码与样式不动、loader 就位
    const onH = obfuscateDocument(h2mSrc, obfuscateMod.resolveOptions({
      preset: 'low', seed: 5, html2mem: true, html2memKey: 424242,
    }));
    const gone = ['可见文本：你好世界', 'secret-value-123', '链接文字', '输入框默认值', '占位提示', '测试页']
      .filter((s) => onH.html.includes(s));
    ok(gone.length === 0, '文本节点与属性值明文全部消失', gone.join(' | '));
    // script 块不在此列：内联脚本本来就会被混淆（既有功能），HTML2MEM 不负责还原它
    const kept = ['<style>.a{color:red}</style>', '/path?a=1&amp;b=2', 'disabled']
      .filter((s) => !onH.html.includes(s));
    ok(kept.length === 0, '样式/href/无值属性保持原样（script 块照常被混淆）', kept.join(' | '));
    ok(/atob\(/.test(onH.html) && /createTreeWalker/.test(onH.html), 'loader 脚本已注入且含解密与 DOM 遍历');
    ok(!!onH.html2mem && onH.html2mem.values > 0 && onH.html2mem.bytes > 0,
      'html2mem 统计报告了值数与密文字节数', JSON.stringify(onH.html2mem));
    ok(onH.html2mem && onH.html2mem.key === 424242, 'html2memKey 固定密钥被采用', JSON.stringify(onH.html2mem));

    // 固定密钥 → 逐字节可复现
    const again = obfuscateDocument(h2mSrc, obfuscateMod.resolveOptions({
      preset: 'low', seed: 5, html2mem: true, html2memKey: 424242,
    }));
    ok(again.html === onH.html, '同 seed + 同密钥 → 产物逐字节可复现');

    // html2memKey=0 是「由 seed 决定」而不是「每次真随机」：同 seed 必须可复现（与项目里
    // 其它随机量的口径一致），不同 seed 才换密钥。
    const rnd1 = obfuscateDocument(h2mSrc, obfuscateMod.resolveOptions({ preset: 'low', seed: 5, html2mem: true }));
    const rnd2 = obfuscateDocument(h2mSrc, obfuscateMod.resolveOptions({ preset: 'low', seed: 5, html2mem: true }));
    const rnd3 = obfuscateDocument(h2mSrc, obfuscateMod.resolveOptions({ preset: 'low', seed: 11, html2mem: true }));
    ok(rnd1.html2mem.key === rnd2.html2mem.key && rnd1.html === rnd2.html,
      'html2memKey=0：同 seed 密钥与产物都相同（可复现构建）');
    ok(rnd1.html2mem.key !== rnd3.html2mem.key && rnd1.html !== rnd3.html,
      'html2memKey=0：不同 seed 密钥与产物都不同');

    // 往返：用 loader 的同一套算法解回，语义应与原文一致（DOM 值层面，不是逐字节）
    {
      const b64 = /var B="([^"]+)"/.exec(onH.html)[1];
      const key = Number(/,K=(\d+),/.exec(onH.html)[1]);
      const open = Number(/,O=(\d+),/.exec(onH.html)[1]);
      const close = Number(/,C=(\d+)/.exec(onH.html)[1]);
      const packed = h2mMod.untransform(Buffer.from(b64, 'base64').toString('binary'), key);
      const vals = h2mMod.unpackValues(packed);
      const re = new RegExp(String.fromCharCode(open) + '(\\d+)' + String.fromCharCode(close), 'g');
      // 值级往返：解出的值表必须与「原文里真正会出现在 DOM 中的值」逐项相等。
      // 不拿整份文档比——内联脚本本来就被混淆了，还原标记不会把它变回源码，那是既有功能、
      // 不归这一层管。DOM 层面的等价由浏览器对比验证（元素/属性/文本逐项 diffCount=0）。
      const expectVals = [
        'zh', 'utf-8', '测试页 & 标题', 'title', 'secret-value-123', '可见文本：你好世界',
        'p2', '第二段 <b>加粗</b> 文本 ABC-456 & 符号', 'v', '提示 A&B', '链接文字',
        'text', '输入框默认值', '占位提示', '无值属性',
      ];
      const badIdx = [];
      for (let i = 0; i < Math.max(vals.length, expectVals.length); i++) {
        if (vals[i] !== expectVals[i]) {
          badIdx.push(i + ':' + JSON.stringify(vals[i]) + '≠' + JSON.stringify(expectVals[i]));
        }
      }
      ok(badIdx.length === 0, '解出的值表与原文 DOM 值逐项一致（实体已解码）', badIdx.join(' | '));
      const markCount = (onH.html.match(new RegExp(String.fromCharCode(open) + '\\d+' + String.fromCharCode(close), 'g')) || []).length;
      ok(markCount === vals.length, '占位标记数 == 值数', markCount + ' vs ' + vals.length);
    }

    // pack/unpack 与 transform/untransform 自洽
    {
      const vals = ['a', '你好', '', 'x:y:z', '长'.repeat(200)];
      ok(h2mMod.unpackValues(h2mMod.packValues(vals)).every((v, i) => v === vals[i]),
        'packValues/unpackValues 往返一致（含空串与多字节）');
      ok(h2mMod.untransform(h2mMod.transform('abc 你好 123', 0x9e3779b9), 0x9e3779b9) === 'abc 你好 123',
        'transform/untransform 互逆');
    }

    // 实体解码：未知实体与越界数值原样保留（不能猜错）
    ok(h2mMod.decodeEntities('&amp;&#65;&#x4e2d;') === '&A中', '实体解码：命名/十进制/十六进制');
    ok(h2mMod.decodeEntities('&unknownthing;') === '&unknownthing;', '未知实体原样保留');
    ok(h2mMod.decodeEntities('&#999999999;') === '&#999999999;', '越界数值实体原样保留');

    // 全页只有标签与属性、没有可加密内容时，产物不变并给出提示
    {
      // 注意：属性同样会被加密，所以「无可加密内容」必须用连属性都没有的文档
      const bare = '<html><body><div></div><script>var q=1;</script></body></html>';
      const r = obfuscateDocument(bare, obfuscateMod.resolveOptions({ preset: 'low', seed: 5, html2mem: true }));
      ok(!/atob\(/.test(r.html), '无可加密内容时不注入 loader');
      ok(r.warnings.some((w) => /html2mem/.test(String(w))), '并给出「无可加密内容」提示', JSON.stringify(r.warnings));
    }

    // JS 输入（不是 HTML）不受影响
    {
      const jsR = obfuscate('var a = 1; process.stdout.write(String(a));', { preset: 'low', seed: 5, html2mem: true });
      ok(!/atob\(/.test(jsR.code), 'JS 输入不受 html2mem 影响');
      ok(runNode(jsR.code, 'h2m-js.js').trim() === '1', 'JS 输入语义不变');
    }


    // 产物结构完整性：loader 只能作为**一整个标签**插在 </body> 前，不能插进标签中间。
    // 这条不是洁癖——2026-09-30 真出过 bug：插入点用原文的 </body> 下标去切混淆后的字符串
    // （占位标记长度不同，偏移不对应），loader 被塞进 <script> 标签中间，产出
    // `<script>` 多于 `</script>`、末尾多一个孤零零的 `pt>` 的坏 HTML。
    // 当时那份浏览器对比文档没炸，是因为它尾部结构单一、偏移恰好落在空白处——运气而已。
    {
      const tagCount = (s, re) => (s.match(re) || []).length;
      const docs = [
        ['常规文档', '<!DOCTYPE html><html><head><title>标题在这里</title></head><body>'
          + '<div class="a" data-x="1">短</div>'
          + '<p>很长很长很长很长很长很长很长的一段正文内容用来把偏移拉开</p>'
          + '<span>中</span><script>var q=1;</script></body></html>'],
        ['属性无引号', '<body><div class=box data-x=9>文本</div><script>var q=1;</script></body>'],
        ['无 </body> 片段', '<div class="a">文本</div><script>var q=1;</script>'],
        ['多文本节点', '<body><p>一</p><p>二</p><p>三</p><p>四</p><p>五</p><p>六</p>'
          + '<script>var q=1;</script></body>'],
        ['长短交替', '<body><b>短</b><p>' + '长'.repeat(200) + '</p><i>短</i>'
          + '<script>var q=1;</script></body>'],
        ['标签内含 </body> 字面量', '<body><p>提到 &lt;/body&gt; 这个标签</p>'
          + '<script>var q=1;</script></body>'],
      ];
      for (const [label, src] of docs) {
        const r = obfuscateDocument(src, obfuscateMod.resolveOptions({
          preset: 'low', seed: 5, html2mem: true, html2memKey: 424242,
        }));
        const out = r.html || '';
        const openS = tagCount(out, /<script>/g);
        const closeS = tagCount(out, /<\/script>/g);
        ok(openS === closeS, '[' + label + '] script 标签配平', openS + ' 开 / ' + closeS + ' 闭');
        // loader 必须是一个完整标签：紧邻 </body> 之前、不与其它标签粘连
        const bi = out.lastIndexOf('</body>');
        if (bi >= 0) {
          ok(out.slice(Math.max(0, bi - '</script>'.length), bi) === '</script>',
            '[' + label + '] loader 紧贴 </body> 之前且标签完整',
            JSON.stringify(out.slice(Math.max(0, bi - 24), bi)));
        } else {
          ok(/<\/script>$/.test(out), '[' + label + '] 无 </body> 时 loader 追加在末尾并闭合',
            JSON.stringify(out.slice(-24)));
        }
        // 除 loader 外，原文里的标签都还在（数量守恒）
        const srcOpenDiv = tagCount(src, /<div\b/g);
        const outOpenDiv = tagCount(out, /<div\b/g);
        ok(srcOpenDiv === outOpenDiv, '[' + label + '] 原有标签数量守恒',
          srcOpenDiv + ' → ' + outOpenDiv);
      }
    }
    // 界面元数据：guiOptions() 有两条来源（VALUE_OPTIONS 与 DEFAULTS+BOOL_OPTIONS 的旧表），
    // BOOL_OPTIONS 又是「DEFAULTS 里所有布尔」，所以任何既是布尔默认值又登记进
    // VALUE_OPTIONS 的选项都会被推两遍 → 界面上两个同名开关，其中一个显示原始键名、
    // 还落在 BOOL_GROUPS 的默认组。html2mem 踩了这个坑（numberObfuscationMBA 早就在里面，
    // 一直显示为原始键名没人当 bug 报）。这里钉住：键必须唯一，且 html2mem 要在 defense 组、
    // 带中文标签与提示。
    {
      const opts = optionsMeta.guiOptions();
      const counts = new Map();
      for (const o of opts) counts.set(o.key, (counts.get(o.key) || 0) + 1);
      const dupKeys = [...counts].filter(([, n]) => n > 1).map(([k, n]) => k + 'x' + n);
      ok(dupKeys.length === 0, 'guiOptions() 无重复键（界面不会渲染出两个同名控件）', dupKeys.join(', '));
      ok(counts.size === opts.length, '选项数 == 唯一键数', counts.size + ' vs ' + opts.length);

      const h2mUi = opts.filter((o) => o.key === 'html2mem');
      ok(h2mUi.length === 1, 'html2mem 在界面元数据里恰好一条', String(h2mUi.length));
      ok(h2mUi[0] && h2mUi[0].group === 'defense', 'html2mem 归在 defense 组', h2mUi[0] ? h2mUi[0].group : '缺失');
      ok(h2mUi[0] && h2mUi[0].kind === 'bool', 'html2mem 是布尔开关');
      ok(h2mUi[0] && h2mUi[0].zh && h2mUi[0].zh !== 'html2mem', 'html2mem 有中文标签而非原始键名', h2mUi[0] ? h2mUi[0].zh : '');
      ok(h2mUi[0] && h2mUi[0].en && h2mUi[0].en !== 'html2mem', 'html2mem 有英文标签');
      // 提示里必须留着那几条诚实说明，不能被后来的人「精简」掉
      ok(h2mUi[0] && /混淆不是保密/.test(h2mUi[0].hintZh || ''), '提示写明「混淆不是保密」');
      ok(h2mUi[0] && /混淆不是保密|obfuscation, not secrecy/.test(h2mUi[0].hintEn || ''), '英文提示同样写明不是保密');
      ok(h2mUi[0] && /没有正文|blank page/.test(h2mUi[0].hintZh || ''), '提示写明 loader 执行前没有正文');
      ok(h2mUi[0] && /href/.test(h2mUi[0].hintZh || '') && /src/.test(h2mUi[0].hintZh || ''), '提示写明 href/src 等例外');

      const keyUi = opts.filter((o) => o.key === 'html2memKey');
      ok(keyUi.length === 1, 'html2memKey 在界面元数据里恰好一条', String(keyUi.length));
      ok(keyUi[0] && keyUi[0].kind === 'int' && keyUi[0].group === 'defense', 'html2memKey 是 defense 组的整数项');

      // 旧表那条分支不能把 VALUE_OPTIONS 里的键再吐一遍
      const stillLegacy = opts.filter((o) => o.key === 'numberObfuscationMBA');
      ok(stillLegacy.length === 1 && stillLegacy[0].zh !== 'numberObfuscationMBA',
        '既有的 numberObfuscationMBA 重复也消了（此前一直显示原始键名）',
        stillLegacy.map((o) => o.group + '/' + o.zh).join(', '));
    }
// HTML2MEM 的 JS 侧：嵌在 JS 里的 HTML 字面量。
    //
    // 与上面文档模式那节是两回事：那边改的是整篇 HTML 的文本与属性值、靠 loader 遍历
    // DOM 还原；这边改的是代码里的字符串/模板字面量，靠注入的解码器拼回字符串。
    // 关键差别：这边**不需要 DOM**，所以产物在 Node / worker 里照样能跑。
    section('HTML2MEM（JS 内嵌 HTML）');
    {
      const lit = (src, extra) => {
        const r = obfuscate(src, Object.assign(
          { preset: 'low', seed: 5, html2mem: true, html2memKey: 424242, selfCheck: false },
          extra || {}));
        const st = r.stats.find((x) => x.pass === 'html2memJs');
        return { r, pass: st ? st.result : null };
      };
      const touched = (src, extra) => {
        const p = lit(src, extra).pass;
        return !!(p && !p.skipped);
      };

      // --- 静态：内容不留明文 ---
      {
        const src = [
          'globalThis.__a = "<div class=\\"box\\" data-cfg=\\"secret-value-123\\">机密正文内容</div>";',
          'var u = { name: "张三" };',
          'globalThis.__b = `<p>机密模板文本 ${u.name} 结尾</p>`;',
        ].join('\n');
        const r = obfuscate(src, {
          preset: 'low', seed: 5, html2mem: true, html2memKey: 424242, selfCheck: false,
        });
        ok(!r.code.includes('机密正文内容'), 'JS 侧：HTML 文本不留明文');
        ok(!r.code.includes('secret-value-123'), 'JS 侧：HTML 属性值不留明文');
        ok(!r.code.includes('机密模板文本'), 'JS 侧：模板里的 HTML 文本不留明文');
        ok(/TextDecoder/.test(r.code) && /atob\(/.test(r.code), 'JS 侧：注入了解码器');
        const st = r.stats.find((x) => x.pass === 'html2memJs');
        ok(!!st && st.result && st.result.templates > 0, 'JS 侧：pass 报告了模板与值数',
          JSON.stringify(st && st.result));
      }

      // --- 零误伤：非 HTML 字符串绝不能被改写 ---
      // 判定放宽一点就是灾难：`a < b`、`Map<string,X>`、`i<length` 全会被当 HTML 改掉。
      {
        const NOT_HTML = [
          ['小于比较', 'var q = 1, w = 2, r = (q<w);'],
          ['泛型写法', 'var t = "Map<string,number>";'],
          ['长度比较', 'var arr = [1,2,3], i = 0, n = arr.length;'],
          ['XML 路径', 'var pp = "a/b<c>d";'],
          ['数学式', 'var ss = "x<y && y>z";'],
          ['普通中文', 'var label = "点击这里";'],
          ['版本号', 'var v = "1.0.0-beta";'],
          ['URL', 'var u = "https://a.example/p?q=1";'],
          ['CSS 选择器', 'var sel = "div > p";'],
        ];
        const hit = NOT_HTML.filter(([, s]) => touched(s)).map(([n]) => n);
        ok(hit.length === 0, 'JS 侧：非 HTML 字符串零误伤', hit.join(', '));
      }

      // --- 该处理的都处理了 ---
      {
        const IS_HTML = [
          ['div 字符串', 'var a = "<div>内容</div>";'],
          ['带属性', 'var a = "<span class=\\"x\\" id=\\"y\\">t</span>";'],
          ['插值模板', 'var a = `<div class=\\"row\\">前缀 ${items} 后缀</div>`;'],
          ['innerHTML 赋值', 'el.innerHTML = "<b>粗体</b>";'],
          ['document.write', 'document.write("<p>段落</p>");'],
          ['insertAdjacentHTML', 'el.insertAdjacentHTML("beforeend", "<li>项</li>");'],
          ['jQuery', 'var h = $("<div>内容</div>");'],
          ['多行 HTML', 'var a = "<div>\\n  <p>段</p>\\n</div>";'],
          ['实体', 'var a = "<p>A &amp; B &lt;tag&gt; 保留</p>";'],
        ];
        const miss = IS_HTML.filter(([, s]) => !touched(s)).map(([n]) => n);
        ok(miss.length === 0, 'JS 侧：各类内嵌 HTML 都被改写', miss.join(', '));

        // 漏判之外还要看内容是否真的没留在明文
        const leak = [];
        for (const [n, s] of IS_HTML) {
          const r = obfuscate(s, {
            preset: 'low', seed: 5, html2mem: true, html2memKey: 424242, selfCheck: false,
          });
          if (r.code.includes('内容') || r.code.includes('粗体') || r.code.includes('段落')) {
            leak.push(n);
          }
        }
        ok(leak.length === 0, 'JS 侧：改写后内容不残留明文', leak.join(', '));
      }

      // --- 全是变量、没有静态内容的插值模板：跳过是合理的 ---
      {
        // `<ul>${items}</ul>` 里没有文本/属性值可加密，套一层空调用只是白白变长
        ok(!touched('var a = `<ul>${items}</ul>`;'),
          'JS 侧：全是变量的插值模板被跳过（无静态内容可加密）');
      }

      // --- reservedStrings 逃生舱 ---
      {
        ok(!touched('var a = "<div>保留内容</div>";', { reservedStrings: ['^<div>'] }),
          'JS 侧：reservedStrings 能排除掉内嵌 HTML');
      }

      // --- 运行期：逐字还原，含实体、插值、空白 ---
      {
        const src = [
          'globalThis.__r = [];',
          'var u = { name: "李四", tags: ["a","b"] };',
          'globalThis.__r.push("<div class=\\"c\\" data-v=\\"值1\\">正文 &amp; 符号</div>");',
          'globalThis.__r.push(`<p>变量 ${u.name} 在 ${u.tags.length} 个标签中</p>`);',
          'globalThis.__r.push("<pre>  保留空白\\n  第二行  </pre>");',
          'globalThis.__r.push(`<ul>${u.tags.map(function(t){return "<li>"+t+"</li>";}).join("")}</ul>`);',
        ].join('\n');
        const want = [
          '<div class="c" data-v="值1">正文 &amp; 符号</div>',
          '<p>变量 李四 在 2 个标签中</p>',
          '<pre>  保留空白\n  第二行  </pre>',
          '<ul><li>a</li><li>b</li></ul>',
        ];
        const r = obfuscate(src, {
          preset: 'low', seed: 5, html2mem: true, html2memKey: 424242, selfCheck: false,
        });
        // harness 里 document 在 Node 下不存在，补个最小桩
        const out = runNode('var document={getElementById:function(){return {};}};\n'
          + r.code + '\nconsole.log(JSON.stringify(globalThis.__r));');
        let got = null;
        try { got = JSON.parse(out.trim().split(/\r?\n/).pop()); } catch (e) { /* 下面按不一致报 */ }
        if (!got) {
          ok(false, 'JS 侧：产物可执行且输出可解析', out.trim().slice(0, 120));
        } else {
          ok(got.length === want.length, 'JS 侧：还原项数一致', got.length + ' vs ' + want.length);
          for (let i = 0; i < Math.max(got.length, want.length); i++) {
            ok(got[i] === want[i], 'JS 侧：第 ' + (i + 1) + ' 项逐字还原',
              got[i] === want[i] ? ''
                : '期望 ' + JSON.stringify(want[i]) + ' 实得 ' + JSON.stringify(got[i]));
          }
        }
        // 实体语义：JS 侧必须按**原样字符**加密。若照文档模式那样先解码成 `&`，
        // 还原出的字符串里会是字面 `&`，浏览器当纯文本处理，内容被改写。
        ok(got && got[0] !== undefined && got[0].indexOf('&amp;') >= 0,
          'JS 侧：实体保持 &amp; 原样（不解码，避免浏览器当纯文本）',
          got && got[0] !== undefined ? JSON.stringify(got[0]) : '');
      }

      // --- 带标签的模板：项目既有缺陷，不因本功能而恶化 ---
      {
        // 实测 `html\`…\`` 在开不开 html2mem 时都抛同一个错（generator._taggedTemplate
        // 读 node.quasis 时 undefined），是混淆器本来就有的问题，不在这里顺手修。
        const src = 'var t = html`<div class="a">x</div>`;';
        let offErr = null;
        let onErr = null;
        try { obfuscate(src, { preset: 'low', seed: 5, selfCheck: false }); } catch (e) { offErr = e; }
        try {
          obfuscate(src, { preset: 'low', seed: 5, html2mem: true, selfCheck: false });
        } catch (e) { onErr = e; }
        ok(!!offErr, 'JS 侧：带标签模板的崩溃是既有的（不开 html2mem 也一样）');
        ok(!!onErr && !!offErr && String(onErr.message) === String(offErr.message),
          'JS 侧：开 html2mem 抛的是同一个错（未引入新问题）',
          onErr ? String(onErr.message).slice(0, 70) : '没抛');
      }
    }
// 档位闸门：html2mem 是 Plus 及以上的能力（Free 不给）。
    // 三个容易踩的点，这里都钉住：
    //   ① 闸门约束的选项必须存在于**每个**预设里，否则 plan.js 的 assertConsistent()
    //      在加载期就抛「预设 low 达不到闸门要求项 html2mem」；
    //   ② html2memKey 刻意**不**加闸门——它是附属项，没 html2mem 时本就不起作用，
    //      单独拦它会让人以为能单独用；
    //   ③ 闸门在 free 上是 false（挡），plus 及以上**不设**该键（放行），与 antiLLM 同写法。
    {
      const gateMod2 = await import('../src/options-gate.js');
      const gate2 = gateMod2.default || gateMod2;
      const presetsMod2 = await import('../src/presets.js');
      const PRESETS2 = presetsMod2.default || presetsMod2;
      const plansMod2 = await import('../src/plans.js');
      const PLANS2 = plansMod2.default || plansMod2;
      const planMod2 = await import('../src/plan.js');
      const plan2 = planMod2.default || planMod2;

      // describe() 返回 { name, ... }，而 options-gate 的 upgradeHint / plan.next()
      // 读的是 ent.plan。真实权益对象来自 licenseWeb.entitlements()（带 plan 字段），
      // 离线断言拿不到它，所以这里补上 plan，形状与线上一致。
      //
      // 这个字段名不一致是既有的（describe 用 name、gate 读 plan），不是本次引入的。
      const ent = (n) => Object.assign(plan2.describe(n), { plan: n });

      // ① 四个预设都含 html2mem，且默认 false（新功能不改变默认产物形态）
      {
        const missing = Object.keys(PRESETS2).filter((k) => !Object.prototype.hasOwnProperty.call(PRESETS2[k], 'html2mem'));
        ok(missing.length === 0, '所有预设都定义了 html2mem（否则加载期断言会抛）', missing.join(', '));
        const notFalse = Object.keys(PRESETS2).filter((k) => PRESETS2[k].html2mem !== false);
        ok(notFalse.length === 0, '所有预设默认 html2mem=false', notFalse.join(', '));
      }

      // ② Free 挡住
      {
      const free = ent('free');
        const r = gate2.checkOptions({ html2mem: true }, free);
        ok(!r.ok, 'Free 开启 html2mem 被拒');
        ok(r.kind === 'options', '拒绝原因是 options 而非预设档', r.kind);
        ok(r.hits && r.hits[0] && r.hits[0].key === 'html2mem', '命中的键是 html2mem',
          r.hits && r.hits[0] ? r.hits[0].key : '无');
        ok(r.hits && r.hits[0] && r.hits[0].kind === 'bool', '按布尔项判定');
        ok(gate2.checkOptions({ html2mem: false }, free).ok, 'Free 关闭 html2mem 不受影响');
        ok(gate2.checkOptions({}, free).ok, 'Free 不传该选项也不受影响');
      }

      // ③ Plus 及以上全部放行（逐档，别只测一个）
      {
        const order = Object.keys(PLANS2).sort((a, b) => PLANS2[a].rank - PLANS2[b].rank);
        const blocked = [];
        for (const n of order) {
          if (n === 'free') continue;
          if (!gate2.checkOptions({ html2mem: true }, ent(n)).ok) blocked.push(n);
        }
        ok(blocked.length === 0, 'Plus 及以上每一档都可开启 html2mem', blocked.join(', '));
        ok(gate2.checkOptions({ html2memKey: 12345 }, ent('free')).ok,
          'html2memKey 不设闸门（附属项，单独限制无意义）');
      }

      // ④ 闸门方向：低档不比高档宽
      {
        const order = Object.keys(PLANS2).sort((a, b) => PLANS2[a].rank - PLANS2[b].rank);
        const wrong = [];
        for (let i = 0; i < order.length - 1; i++) {
          const lo = PLANS2[order[i]];
          const hi = PLANS2[order[i + 1]];
          if (plan2.gateAllows(hi.gates.html2mem, true) === false
            && plan2.gateAllows(lo.gates.html2mem, true) === true) {
            wrong.push(order[i] + '→' + order[i + 1]);
          }
        }
        ok(wrong.length === 0, '闸门随档位单调放宽（低档不会比高档更宽）', wrong.join(', '));
      }

      // ⑤ 拦截文案要带选项名与升级方向
      {
        const free = ent('free');
        const hit = gate2.violationsOf({ html2mem: true }, free)[0];
        ok(!!hit, 'violationsOf 能列出该违规项');
        const text = hit ? gate2.violationText(hit, free) : '';
        ok(/html2mem/.test(text), '拦截文案含选项名', text.slice(0, 60));
        const hint = gate2.upgradeHint(free);
        ok(typeof hint === 'string' && hint.length > 0, '给出升级提示', hint.slice(0, 60));
      }
    }
  }

// ------------------------------------------------------------ VMP 增强（2026-10-01）
// 钉住三项改动，各自有具体的失效形态：
//   ① 覆盖率（A）：medium 的 vmThreshold 由 4 降到 2，小函数也进字节码；
//   ② 深度（B）：high 打开 vmMacroOps + vmDynOpcodes；
//   ③ stats 口径（D）：WASM 解释器内核档的 ops.decoy 与 suppressed。
// 语义正确性是底线，每个断言都真跑一遍产物比对 stdout。

if (process.argv[1] && process.argv[1].endsWith('live-verify.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}
