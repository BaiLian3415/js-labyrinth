#!/usr/bin/env node
/**
 * 反分析：Anti-CDP 自动化检测与域名锁定（密钥耦合）。
 *
 *   node test/anti-analysis.js
 *
 * 整跑全部用例：npm test（即 node test/selftest.js）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TMP, cleanTmp, counters, ok, report, runNode, runSync, section, throws } from './_harness.js';
import obfuscateMod from '../src/obfuscate.js';
import plan from '../src/plan.js';

const { obfuscate } = obfuscateMod;
section('Anti-CDP（CDP 自动化检测）');
{
  // 探针样例：字符串全部经字符串池（high 预设 threshold=1），投毒后输出腐蚀
  const cdpSample = `function greet(n) {
  return 'OK-' + n + '-END';
}
const a = greet('aa');
const b = greet('bb');
process.stdout.write(a + '|' + b + '\\n');
`;
  const cdpWant = 'OK-aa-END|OK-bb-END\n';
  const cdpHelper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cdp-sandbox.js');
  const cdpRun = (code, mode, tag) => {
    const file = path.join(TMP, 'cdp-' + mode + '-' + tag + '.js');
    fs.writeFileSync(file, code);
    return runSync(process.execPath, [cdpHelper, file, mode], { encoding: 'utf8', timeout: 60000 });
  };

  // 形态：开启时 pass 注入且三向量齐全，关闭时不出现
  const rCdpOn = obfuscate(cdpSample, { preset: 'high', shell: false, antiCDP: true, seed: 11 });
  const rCdpOff = obfuscate(cdpSample, { preset: 'high', shell: false, antiCDP: false, seed: 11 });
  const stCdp = rCdpOn.stats.find((s) => s.pass === 'antiCDP');
  ok(stCdp && stCdp.result && stCdp.result.injected === true && stCdp.result.vectors >= 3,
    'antiCDP 开启时 pass 注入且三向量齐全', JSON.stringify(stCdp && stCdp.result));
  ok(!rCdpOff.stats.some((s) => s.pass === 'antiCDP'), 'antiCDP 关闭时 pass 不出现');

  // Node 直跑零副作用：window 不存在，探针全部跳过，开/关输出一致
  let cdpNodeBad = '';
  for (const [flag, r] of [['on', rCdpOn], ['off', rCdpOff]]) {
    let got;
    try { got = runNode(r.code, 'cdp-node-' + flag); } catch (e) { got = 'THREW'; }
    if (got !== cdpWant) cdpNodeBad = flag + ' → ' + got.slice(0, 40);
  }
  ok(cdpNodeBad === '', 'Node 环境直跑零副作用（开/关输出一致）', cdpNodeBad);

  // 干净浏览器沙箱零误报：window/document/navigator 齐备但无自动化痕迹
  let cdpCleanBad = '';
  for (let seed = 1; seed <= 2; seed++) {
    const code = obfuscate(cdpSample, { preset: 'high', shell: false, antiCDP: true, seed }).code;
    const got = cdpRun(code, 'clean', String(seed));
    if (got !== cdpWant) cdpCleanBad = 'seed=' + seed + ' → ' + got.slice(0, 40);
  }
  ok(cdpCleanBad === '', '干净浏览器沙箱零误报（输出逐位一致）', cdpCleanBad);

  // navigator.webdriver=true（Puppeteer/Playwright 默认签名）→ 投毒
  let cdpWdPoisoned = 0;
  let cdpWdFirst = '';
  for (let seed = 1; seed <= 2; seed++) {
    const code = obfuscate(cdpSample, { preset: 'high', shell: false, antiCDP: true, seed }).code;
    const got = cdpRun(code, 'webdriver', String(seed));
    if (got !== cdpWant) cdpWdPoisoned++;
    else if (!cdpWdFirst) cdpWdFirst = 'seed=' + seed;
  }
  ok(cdpWdPoisoned === 2, 'navigator.webdriver=true 即投毒（字符串池被腐蚀）', cdpWdFirst);

  // Runtime.enable 序列化模拟（log 1 次 + debug 2 次）→ 投毒
  let cdpSerPoisoned = 0;
  let cdpSerFirst = '';
  for (let seed = 1; seed <= 2; seed++) {
    const code = obfuscate(cdpSample, { preset: 'high', shell: false, antiCDP: true, seed }).code;
    const got = cdpRun(code, 'cdp', String(seed));
    if (got !== cdpWant) cdpSerPoisoned++;
    else if (!cdpSerFirst) cdpSerFirst = 'seed=' + seed;
  }
  ok(cdpSerPoisoned === 2, 'console 序列化（Runtime.enable 特征）即投毒', cdpSerFirst);

  // 弱证据（仅 log 单次触发）不投毒：只走隐蔽断点，输出不变
  let cdpWeakBad = '';
  for (let seed = 1; seed <= 2; seed++) {
    const code = obfuscate(cdpSample, { preset: 'high', shell: false, antiCDP: true, seed }).code;
    const got = cdpRun(code, 'weak', String(seed));
    if (got !== cdpWant) cdpWeakBad = 'seed=' + seed + ' → ' + got.slice(0, 40);
  }
  ok(cdpWeakBad === '', '弱证据（单次触发）不投毒不误伤', cdpWeakBad);

  // 开关有效性：关闭后 webdriver 环境也不投毒
  ok(cdpRun(rCdpOff.code, 'webdriver', 'off') === cdpWant,
    'antiCDP 关闭时 webdriver 环境输出不变');

  // 门控：free 锁死、plus 放行；默认开启（assertConsistent 在模块加载时
  // 已校验闸门与预设取值一致，这里断言对外行为）
  ok(plan.violations({ antiCDP: true }, 'free').length === 1, 'free 档 antiCDP 被闸门锁死');
  ok(plan.violations({ antiCDP: false }, 'free').length === 0, 'free 档关闭放行');
  ok(plan.violations({ antiCDP: true }, 'plus').length === 0, 'plus 档 antiCDP 放行');
  ok(obfuscateMod.DEFAULTS.antiCDP === true, 'antiCDP 默认开启');

  // 可复现：固定 seed 逐字节一致
  ok(obfuscate(cdpSample, { preset: 'high', shell: false, antiCDP: true, seed: 4242 }).code ===
    obfuscate(cdpSample, { preset: 'high', shell: false, antiCDP: true, seed: 4242 }).code,
    'antiCDP 固定 seed 可复现');
}

section('域名锁定（domainLock，密钥耦合）');
{
  // 探针样例：字符串全部经字符串池（high 预设 threshold=1），失配即整池腐蚀。
  // 沙箱在 node:vm 里注入 location（hostname/host），'-' 表示无 location。
  const dlSample = `function greet(n) {
  return 'OK-' + n + '-END';
}
const a = greet('aa');
const b = greet('bb');
process.stdout.write(a + '|' + b + '\\n');
`;
  const dlWant = 'OK-aa-END|OK-bb-END\n';
  const dlHelper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'domain-sandbox.js');
  const dlRun = (code, hostname, tag, hostWithPort) => {
    const file = path.join(TMP, 'dl-' + tag + '.js');
    fs.writeFileSync(file, code);
    const args = [dlHelper, file, hostname];
    if (hostWithPort) args.push(hostWithPort);
    return runSync(process.execPath, args, { encoding: 'utf8', timeout: 60000 });
  };
  // 篡改面锚点策略：注入的校验函数会被 mangle 改名且被后续包装层搬动（用函数
  // 名或 function 头回溯定位都不可靠），改用模板在产物里的两个唯一明文锚点——
  // 探针属性 location.hostname 与 +Q 异或表达式（均已验证开/关构建恰好 1/0 次）

  // 形态：开启时注入且为 coupled 模式；关闭时 pass 不出现、location 探针不出现
  const rDlOn = obfuscate(dlSample, { preset: 'high', shell: false, domainLock: 'example.com', seed: 11 });
  const rDlOff = obfuscate(dlSample, { preset: 'high', shell: false, seed: 11 });
  const stDl = rDlOn.stats.find((s) => s.pass === 'domainLock');
  ok(stDl && stDl.result && stDl.result.injected === true && stDl.result.mode === 'coupled'
    && stDl.result.entries === 1 && stDl.result.exact === 1,
    'domainLock 开启时注入且为 coupled 模式', JSON.stringify(stDl && stDl.result));
  ok(!rDlOff.stats.some((s) => s.pass === 'domainLock'), 'domainLock 关闭时 pass 不出现');
  ok(!rDlOff.code.includes('hostname') && rDlOn.code.includes('hostname'),
    'location 探针只在开启时出现（域名白名单零明文）');

  // 多条目解析计数：1 精确 + 1 后缀
  const stDl2 = obfuscate(dlSample, { preset: 'high', shell: false, domainLock: 'example.com, .foo.dev', seed: 11 })
    .stats.find((s) => s.pass === 'domainLock');
  ok(stDl2 && stDl2.result.entries === 2 && stDl2.result.exact === 1 && stDl2.result.suffix === 1,
    '多条目（精确+后缀）计数正确', JSON.stringify(stDl2 && stDl2.result));

  // 授权主机放行（5 seed × 4 形态）：精确 / 后缀含顶点 / 后缀深层子域 / 端口精确
  let dlAuthBad = '';
  for (let seed = 1; seed <= 5 && !dlAuthBad; seed++) {
    const o = { preset: 'high', shell: false, seed };
    const cases = [
      [obfuscate(dlSample, { ...o, domainLock: 'example.com' }).code, 'example.com', null],
      [obfuscate(dlSample, { ...o, domainLock: '.example.com' }).code, 'example.com', null],
      [obfuscate(dlSample, { ...o, domainLock: '.example.com' }).code, 'a.b.example.com', null],
      [obfuscate(dlSample, { ...o, domainLock: 'example.com:8443' }).code, 'example.com', 'example.com:8443'],
    ];
    for (let i = 0; i < cases.length; i++) {
      const got = dlRun(cases[i][0], cases[i][1], 'auth-' + seed + '-' + i, cases[i][2] || undefined);
      if (got !== dlWant) { dlAuthBad = '形态 ' + i + ' seed=' + seed + ' → ' + got.slice(0, 40); break; }
    }
  }
  ok(dlAuthBad === '', '授权主机放行（精确/后缀含顶点/深层子域/端口精确）', dlAuthBad);

  // 回归（2026-09-27 修）：早带即调用的函数不得被注入交叉校验闩锁。
  //
  // 症状：domainLock + integrityCheck 同时开（= coupled 模式的唯一组合）时，
  // 授权主机上产物跑出乱码。原因是 domainLock 的校验函数由 insertHeadEarly 注入、
  // 在头部**立即调用**，而 integrityCheck 随后给根级函数体注入
  // `if(!latchObj[key])…`，其 `var latchObj={}` 却要等 integrityCheck 自己的早带块
  // 才赋值——那个块排在 domainLock 之后。此刻 latchObj 还是提升后的 undefined，
  // 读 undefined[key] 抛 TypeError，被外层 `catch(e){}` 吞掉：+Q 永不落位，
  // 字符串池偏移停在非零，整池静默乱码，产物不报任何错。
  //
  // 修法：domainLock 登记 __earlyInvoked，integrityCheck 据此把它排除出入口校验点
  // 候选（它仍在哈希面内，只是不当"被调用时顺手校验 peer"的宿主）。
  // 下面两条分别钉住"不再被注入闩锁"与"仍在哈希面内"，少任何一条都会让
  // 这类缺陷以"少一层交叉检查"或"重新自损坏"的形式退化回来。
  {
    const rDlEarly = obfuscate(dlSample, { preset: 'high', shell: false, seed: 3, domainLock: 'example.com' });
    const stIc = rDlEarly.stats.find((s) => s.pass === 'integrityCheck');
    const hostFnName = rDlEarly.stats.find((s) => s.pass === 'domainLock').result.hostFn;
    // hostFn 会被 mangle 改名，按函数体特征定位：domainLock 的校验函数是唯一
    // 读 location.hostname 的根级函数。
    const probeAt = rDlEarly.code.indexOf('location.hostname');
    ok(probeAt > 0, 'domainLock 校验函数在产物里可定位（读 location.hostname）');
    if (probeAt > 0) {
      // 函数体首字符 '{' 之后紧跟的闩锁引用即交叉校验闩锁；被排除后不应再有它
      const brace = rDlEarly.code.lastIndexOf('{', probeAt);
      const head = rDlEarly.code.slice(brace + 1, brace + 120);
      ok(!/^if\(![A-Za-z_$一-鿿][\w$]*\["__f/.test(head),
        '早带即调用的 domainLock 函数未被注入交叉校验闩锁', head.slice(0, 60));
      // 仍在哈希面内：改动函数体文本必须让整池腐蚀
      const patched = rDlEarly.code.slice(0, brace + 1) + '0;' + rDlEarly.code.slice(brace + 1);
      ok(dlRun(patched, 'example.com', 'early-tamper') !== dlWant,
        'domainLock 校验函数仍受完整性哈希覆盖（改函数体即投毒）');
    }
    ok(stIc && stIc.result && stIc.result.checked > 0,
      'integrityCheck 哈希面非空', JSON.stringify(stIc && stIc.result));
  }

  // 非授权主机 fail-closed（2 seed × 4 形态）：错域 / 后缀点边界 / 错端口 /
  // 无 location。coupled 模式静默腐蚀整池，不应有可定位的抛错
  let dlDenyBad = '';
  for (let seed = 1; seed <= 2 && !dlDenyBad; seed++) {
    const o = { preset: 'high', shell: false, seed };
    const cases = [
      [obfuscate(dlSample, { ...o, domainLock: 'example.com' }).code, 'evil.com', null],
      [obfuscate(dlSample, { ...o, domainLock: '.example.com' }).code, 'badexample.com', null],
      [obfuscate(dlSample, { ...o, domainLock: 'example.com:8443' }).code, 'example.com', 'example.com:80'],
      [obfuscate(dlSample, { ...o, domainLock: 'example.com' }).code, '-', null],
    ];
    for (let i = 0; i < cases.length; i++) {
      const got = dlRun(cases[i][0], cases[i][1], 'deny-' + seed + '-' + i, cases[i][2] || undefined);
      // 失配后整池乱码：解码器在乱码索引上可能越界抛错（沙箱 |THREW 前缀），
      // 也可能静默输出乱码——都是 fail-closed 的合法表现，只要不等于正确输出
      if (got === dlWant) { dlDenyBad = '形态 ' + i + ' seed=' + seed + ' 未拦截'; break; }
    }
  }
  ok(dlDenyBad === '', '非授权主机整池腐蚀（错域/点边界/错端口/无 location）', dlDenyBad);

  // 真机 Node 直跑（无 location）同样 fail-closed
  {
    const f = path.join(TMP, 'dl-node-real.js');
    fs.writeFileSync(f, rDlOn.code);
    let got;
    try { got = runSync(process.execPath, [f], { encoding: 'utf8', timeout: 30000 }); }
    catch (e) { got = 'THREW'; }
    ok(got.trim() !== dlWant.trim(), 'Node 真机直跑 fail-closed（域名锁定不承诺浏览器外运行）',
      String(got).slice(0, 40));
  }

  // 降级一：关完整性校验（couple 缺席）→ poison 模式（毒药键路径）
  const rDlPois = obfuscate(dlSample, { preset: 'high', shell: false, integrityCheck: false, domainLock: 'example.com', seed: 7 });
  const stPois = rDlPois.stats.find((s) => s.pass === 'domainLock');
  ok(stPois && stPois.result.mode === 'poison', '关完整性校验时降级为 poison 模式', JSON.stringify(stPois && stPois.result));
  ok(dlRun(rDlPois.code, 'example.com', 'pois-auth') === dlWant
    && dlRun(rDlPois.code, 'evil.com', 'pois-deny') !== dlWant,
    'poison 模式：授权放行、失配写毒药键腐蚀输出');

  // 降级二：连池都没有 → throw 模式（裸抛，不被引导 catch 自吞）
  const rDlThrow = obfuscate(dlSample, { preset: 'high', shell: false, integrityCheck: false, stringArray: false, domainLock: 'example.com', seed: 7 });
  const stThrow = rDlThrow.stats.find((s) => s.pass === 'domainLock');
  ok(stThrow && stThrow.result.mode === 'throw', '无字符串池时降级为 throw 模式', JSON.stringify(stThrow && stThrow.result));
  ok(dlRun(rDlThrow.code, 'evil.com', 'throw-deny').includes('|THREW:'),
    'throw 模式失配装载期抛错（引导调用裸奔不被吞）');
  ok(dlRun(rDlThrow.code, 'example.com', 'throw-auth') === dlWant, 'throw 模式授权主机正常');

  // 篡改面一：改校验函数体内的探针属性名（location.hostname 是模板在产物里
  // 的唯一明文）。文本一变即进完整性哈希面失配，同时运行期取不到 hostname
  // 视为失配——双路 fail-closed
  {
    const hit = (rDlOn.code.match(/location\.hostname/g) || []).length;
    let got = 'NOANCHOR';
    if (hit === 1) {
      const tampered = rDlOn.code.replace('location.hostname', 'location.hostnamf');
      try { got = dlRun(tampered, 'example.com', 'tamper-fn'); } catch (e) { got = 'THREW'; }
    }
    ok(hit === 1 && got !== dlWant,
      '篡改校验函数体即被完整性哈希面检出（授权域自腐蚀）',
      'hit=' + hit + ' → ' + String(got).slice(0, 40));
  }

  // 篡改面二：废掉 +Q 贡献（第二个异或半片 +1）——等价于引导调用被 NOP/删除：
  // 授权域偏移不再归零，自己乱码（Q≠0 设计）。产物里该形态恰好一处
  {
    const qRe = /\+\(0x[0-9a-f]+\^0x([0-9a-f]+)\)/;
    const mq = rDlOn.code.match(qRe);
    let got = 'NOQ';
    if (mq) {
      const patched = rDlOn.code.replace(qRe, (m0, h) =>
        m0.slice(0, m0.length - h.length - 1) + (parseInt(h, 16) + 1).toString(16) + ')');
      try { got = dlRun(patched, 'example.com', 'tamper-q'); } catch (e) { got = 'THREW'; }
    }
    ok(!!mq && got !== dlWant,
      '篡改 +Q 贡献即自毁（Q≠0，授权域偏移不再归零）',
      (mq ? mq[0] : '未命中') + ' → ' + String(got).slice(0, 40));
  }

  // 外壳档：整件编码后语义不变（授权放行 / 失配腐蚀）
  const rDlShell = obfuscate(dlSample, { preset: 'high', shell: true, domainLock: 'example.com', seed: 5 });
  ok(dlRun(rDlShell.code, 'example.com', 'shell-auth') === dlWant
    && dlRun(rDlShell.code, 'evil.com', 'shell-deny') !== dlWant,
    '外壳档下语义不变（授权放行/失配腐蚀）');

  // 门控：free 只允许空串（关闭），plus 放行；默认关闭
  ok(plan.violations({ domainLock: 'example.com' }, 'free').length === 1, 'free 档非空 domainLock 被闸门锁死');
  ok(plan.violations({ domainLock: '' }, 'free').length === 0, 'free 档关闭（空串）放行');
  ok(plan.violations({ domainLock: 'example.com' }, 'plus').length === 0, 'plus 档 domainLock 放行');
  ok(obfuscateMod.DEFAULTS.domainLock === '', 'domainLock 默认关闭（空串）');

  // 非法条目：构建立即失败（不得静默降级——引导层已按 OK-Q 写死）
  throws(() => obfuscate(dlSample, { preset: 'high', shell: false, domainLock: 'http://a.com/x' }), '带路径的条目报错');
  throws(() => obfuscate(dlSample, { preset: 'high', shell: false, domainLock: '.a.com:443' }), '后缀+端口报错');
  throws(() => obfuscate(dlSample, { preset: 'high', shell: false, domainLock: 'a..b.com' }), '空标签报错');

  // 可复现：固定 seed 逐字节一致
  ok(obfuscate(dlSample, { preset: 'high', shell: false, domainLock: '.example.com', seed: 97 }).code ===
    obfuscate(dlSample, { preset: 'high', shell: false, domainLock: '.example.com', seed: 97 }).code,
    'domainLock 固定 seed 可复现');
}

section('Anti-LLM：注记与 FLAG 词表逐构建变化（非常量）');
{
  // 旧形态是 10 条注记 + 8 个 FLAG 常量：stringArray 阈值 <1 时注记留明文，
  // 跨构建统计产物明文即聚类出 antiLLM 档位。2026-10-11 改成槽位组合
  // （TAG×动词×对象×条件 = 4096 种注记，头×核×尾 = 120 种 FLAG），随机性走
  // randInt（构建已播种），同 seed 复现。
  //
  // 判据：8 个 seed 的去重注记数 > 10 且去重 FLAG 数 > 8——旧码恒不超过
  // 10/8（数组长度即硬上限），天然可区分。stringArray 关掉以便在明文层计数；
  // FLAG 只认 `process.env.X` 形态，避免别的 pass 的标识符混入。
  const src = [
    'function a(x){var s=x+1;if(s>2){s+=x;}else{s-=1;}return s;}',
    'function b(x){var s=0;for(var i=0;i<x;i++){if(i%2){s+=i;}else{s-=2;}}return s;}',
    'process.stdout.write([a(4),b(5)].join(" "));',
  ].join('\n');
  const notes = new Set();
  const flags = new Set();
  for (let seed = 1; seed <= 8; seed++) {
    const code = obfuscate(src, {
      preset: 'low', seed, shell: false, bannerSkip: true,
      stringArray: false, antiLLM: true,
    }).code;
    for (const m of code.matchAll(/['"](\/\/[^'"]*)['"]/g)) notes.add(m[1]);
    for (const m of code.matchAll(/\.env\.((?:JSLB_|APP_|CFG_)[A-Za-z0-9_]*)/g)) flags.add(m[1]);
  }
  ok(notes.size > 10, '注记文本跨构建变化（去重 > 10，旧码硬上限即 10）', 'distinct=' + notes.size);
  ok(flags.size > 8, 'FLAG 名跨构建变化（去重 > 8，旧码硬上限即 8）', 'distinct=' + flags.size);
  // 可复现：同 seed 两次构建逐字节相同（组合随机性必须来自构建种子流）
  const c1 = obfuscate(src, {
    preset: 'low', seed: 3, shell: false, bannerSkip: true, stringArray: false, antiLLM: true,
  }).code;
  const c2 = obfuscate(src, {
    preset: 'low', seed: 3, shell: false, bannerSkip: true, stringArray: false, antiLLM: true,
  }).code;
  ok(c1 === c2, '同 seed 注记/FLAG 组合逐字节可复现');
  // 语义：注记是无害字符串语句，伪分支恒假，产物输出与原文一致
  ok(runNode(c1, 'llm-sem.js').trim() === runNode(src, 'llm-want.js').trim(), '注记/伪分支不改变语义');
}

if (process.argv[1] && process.argv[1].endsWith('anti-analysis.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}
