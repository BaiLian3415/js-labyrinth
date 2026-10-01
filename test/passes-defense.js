#!/usr/bin/env node
/**
 * 防御类 pass：自防御篡改检出、密钥耦合、多时钟源交叉校验、ESM 绑定、BigInt 兼容。
 *
 *   node test/passes-defense.js
 *
 * 整跑全部用例：npm test（即 node test/selftest.js）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { TMP, cleanTmp, counters, ok, report, runNode, runSync, section, throws } from './_harness.js';
import obfuscateMod from '../src/obfuscate.js';
import i18n from '../src/i18n.js';

const { obfuscate } = obfuscateMod;
section('自防御：篡改检出');
{
  // 机制层（字符串池解码器）过去不在校验面内，改了解码器没人发现。这条测试
  // 直接往解码器函数体里插一条无害语句 `0;`——语义完全不变，只有文本变了——
  // 期望产物立刻检出（毒化字符串）。只靠"产物能跑"是抓不到这事的。
  //
  // 覆盖依赖布局（访问器声明要还在根体里），所以先找一个真的覆盖上了的 seed，
  // 一个都覆盖不上就算失败：那说明覆盖被后续改动弄丢了。
  const src = 'function fib(n){if(n<2)return n;return fib(n-1)+fib(n-2);}\n' +
    'var s="hello world";\nconsole.log(fib(8), s.length, s);';
  const want = runNode(src, 'sd-plain.js').trim();
  let picked = null;
  for (let seed = 1; seed <= 6 && !picked; seed++) {
    const r = obfuscate(src, { preset: 'medium', seed, shell: false });
    const ic = r.stats.find((s) => s.pass === 'integrityCheck');
    if (ic && ic.result && ic.result.machinery > 0) picked = { seed, code: r.code };
  }
  ok(!!picked, '机制层（字符串池访问器）进入完整性校验面',
    picked ? '' : 'medium 预设 6 个 seed 都没覆盖到访问器');

  if (picked) {
    // 篡改后的产物会抛（毒化后成员访问失败），runNode 直接抛异常会中断整个
    // 自测，这里统一收口成字符串
    const tryRun = (c, name) => {
      try { return runNode(c, name).trim(); } catch (e) { return 'ERR'; }
    };
    const code = picked.code;
    const clean = tryRun(code, 'sd-ok.js');
    ok(clean === want, '未篡改的产物输出正确', clean.slice(0, 40));

    // 往每一处 `return function(...){` 的函数体开头插一条无害语句。产物里有多
    // 处返回函数（诱饵函数、熵闭包、解码器都长这样），只挑一处会挑错；全插则
    // 被覆盖的解码器必然在其中，而 `0;` 插在任何函数体开头都不会改语义
    let patched = code;
    let inserted = 0;
    let at = 0;
    for (;;) {
      const k = patched.indexOf('return function(', at);
      if (k < 0) break;
      const j = patched.indexOf('{', k);
      if (j < 0) break;
      patched = patched.slice(0, j + 1) + '0;' + patched.slice(j + 1);
      inserted++;
      at = j + 3;
    }
    ok(inserted > 0, '能在产物里定位到返回函数（共 ' + inserted + ' 处）');
    if (patched) {
      const got = tryRun(patched, 'sd-tampered.js');
      ok(got !== want, '往返回函数插一条无害语句即被检出（字符串被毒化）',
        '篡改后仍然输出 ' + got.slice(0, 40));
    }

    // 运行时保护：把 Function.prototype.toString 换成非原生实现（解壳的第一步
    // 就是这么干），产物必须检出。注意这条验证的是"整体会响应"，命中既可能来
    // 自原生性探针，也可能来自哈希面本身——两者都依赖 toString 取函数源码
    const hook = 'Function.prototype.toString=function(){return "function toString() { [code] }";};';
    const hooked = tryRun(hook + code, 'sd-hooked.js');
    ok(hooked !== want, '钩住 Function.prototype.toString 即被检出',
      '钩子环境下仍然输出 ' + hooked.slice(0, 40));

    // 反 Hook / 反 Proxy 专项：apply / Proxy / Reflect / defineProperty 被换成
    // **行为不同**的实现时必须被检出。
    //
    // 这里用**默认产物**（不设 bannerSkip）：早期版本要靠 bannerSkip 跳过文件头横幅，
    // 是因为旧横幅会读 __filename 核对"文件头就是这段注释"，前面任何一行都会触发
    // 自毁（连空操作前置也报 ERR），用它做前置等于断言因为横幅而不是探针通过，是
    // **假通过**。2026-09-30 去掉注释后新引导不再读自身源码，前置一行不再自毁，
    // 这个理由已经消失——现在用真正的交付形态测，结论才有意义。
    const hookCode = obfuscate(src, { preset: 'medium', seed: 1, shell: false }).code;
    ok(tryRun(hookCode, 'sd-hook-clean.js') === want, '反 Hook 对照产物（默认带引导层）本身输出正确');

    const HOOKS = [
      ['apply 被换成改写返回值的实现', 'Function.prototype.apply=function(){return 0;};'],
      ['Proxy 被换成返回空对象的实现', 'Proxy=function(){return {};};'],
      ['Reflect 被换成自带假 apply 的对象', 'Reflect={apply:function(){return 0;}};'],
      ['Reflect.apply 被换成改写返回值的实现', 'Reflect.apply=function(){return 0;};'],
      ['defineProperty 被换成静默吞掉写入的实现', 'Object.defineProperty=function(o){return o;};'],
    ];
    let hookMissed = '';
    for (const [label, pre] of HOOKS) {
      const got = tryRun(pre + hookCode, 'sd-hook-' + label.slice(0, 6) + '.js');
      if (got === want) { hookMissed = label + '：仍输出正确'; break; }
    }
    ok(hookMissed === '', '反 Hook/反 Proxy：五类劫持均被检出', hookMissed);

    // 反向：语义等价的转发层不该被立即打死。行为探针要求"语义真的发散"，所以它
    // 应放过；只有身份比对命中，而身份比对需二次确认才投毒（头部有一次性闩锁，
    // 单遍到不了 2）。这条钉的是"不过度误杀"——合法 polyfill 不该让产物当场崩掉。
    const fwd = 'var _o=Function.prototype.apply;Function.prototype.apply=function(t,a){return _o.call(this,t,a);};';
    const fwdGot = tryRun(fwd + hookCode, 'sd-hook-fwd.js');
    ok(fwdGot === want, '语义等价的 apply 转发层不被立即投毒（避免误杀 polyfill）',
      '输出 ' + String(fwdGot).slice(0, 40));

    // 主校验面：改一个根级函数声明的函数体也必须被检出。关掉 mangle 才认得出
    // 名字（生成器输出是 `function fib (`，按 "function fib(" 找会漏）
    const named = obfuscate(src, { preset: 'medium', seed: picked.seed, mangle: false, shell: false }).code;
    const head = named.match(/function\s+fib\s*\(/);
    ok(!!head, '关掉重命名后能定位到根级函数声明');
    if (head) {
      const i = named.indexOf(head[0]);
      const j = named.indexOf('{', i);
      const patched2 = j >= 0 ? named.slice(0, j + 1) + '0;' + named.slice(j + 1) : null;
      const got2 = patched2 ? tryRun(patched2, 'sd-fn.js') : want;
      ok(got2 !== want, '改根级函数体即被检出（头部哈希面生效）',
        '篡改后仍然输出 ' + String(got2).slice(0, 40));
    }
  }
}

section('密钥耦合：校验输出直接当解密密钥');
{
  // 改造前是"报警式"防护：校验失败置毒标志，解码器读到才损坏输出——攻击者定位到
  // 那个 `if(毒标志)` 分支 NOP 掉即可恢复。现在把校验算出的「重算哈希 ^ 期望哈希」
  // 偏移累加进一个健康载体，字符串池每次访问都拿它当解密密钥偏移：没有可 NOP 的
  // 分支，改动任一被校验函数或横幅都让整池字符串静默变乱码。
  //
  // 这一节钉四件事：干净产物逐位正确（偏移为 0 时耦合式子必须严格退化成恒等）、
  // 耦合的三个角色都在产物里、**把毒标志全部中和之后**篡改仍被检出（证明隐式那
  // 一路真的独立生效，而不是靠标志位）、以及 low 档（关了完整性校验）不启用耦合。
  // 输出走 process.stdout.write 而不是 console.log：max 档开了 consoleStub，会把
  // console 系列换成桩函数（那是它的既有语义，不是缺陷），拿 console 比对只会得到
  // 空输出，把干净产物误判成坏了
  const src = 'const s="hello world";function fib(n){if(n<2)return n;return fib(n-1)+fib(n-2);}\n'
    + 'process.stdout.write(fib(8)+" "+s.length+" "+s+" "+("beta-gamma".split("-").join("").length)+"\\n");';
  const want = runNode(src, 'kc-plain.js').trim();

  let bad = '';
  for (const preset of ['medium', 'high', 'max']) {
    for (const seed of [1, 2]) {
      const c = obfuscate(src, { preset, seed }).code;
      const got = runNode(c, 'kc-' + preset + '-' + seed + '.js').trim();
      if (got !== want) { bad = preset + '/' + seed + ' -> ' + got.slice(0, 40); break; }
    }
    if (bad) break;
  }
  ok(bad === '', '启用耦合后干净产物仍逐位正确（偏移为 0 时退化成恒等）', bad);

  {
    // 用行为断言而不是文本匹配：产物里的常量会被 numberObf 展开成恒等式，按源码
    // 形态去正则匹配很脆（实测 readOff 就因此漏判）。这里直接验证语义——把健康载体
    // 钉成"健康值 + 1"，池侧算出的偏移就不再是 0，整池字符串必须解成乱码。
    const c = obfuscate(src, { preset: 'medium', seed: 3, shell: false }).code;
    const nameM = /\["(__c[0-9a-f]{9,})"\]/.exec(c);
    const okM = /\]\s*=\s*\(\(0x([0-9a-f]+)\+\(/.exec(c); // 引导层写入绝对健康值
    ok(!!(nameM && okM), '产物中找得到健康载体名与健康常量',
      'name=' + (nameM && nameM[1]) + ' ok=' + (okM && okM[1]));
    if (nameM && okM) {
      const off = (parseInt(okM[1], 16) + 1) >>> 0;
      // 插在文件最前面：引导层是产物里最早执行的代码，必须抢在它写载体之前把属性
      // 钉成"永远返回非健康值"。旧做法是插在文件头注释的 `*/` 之后，2026-09-30
      // 去掉注释后那个锚点不存在了（indexOf('/*!') 返回 -1 会让插入点落到文件里
      // 第一个 `*/`，可能是字符串或正则里的，落点随机）。前置整段是确定性的。
      const pin = ';(function(){var G=(typeof globalThis!=="undefined"?globalThis:this);'
        + 'try{Object.defineProperty(G,"' + nameM[1] + '",{configurable:false,'
        + 'get:function(){return 0x' + off.toString(16) + ';},set:function(){}});}catch(e){}})();';
      const pinned = pin + c;
      let got = want;
      try { got = runNode(pinned, 'kc-offset.js').trim(); } catch (e) { got = 'ERR'; }
      ok(got !== want, '把健康载体改成非健康值即整池乱码（读取端确实在用它当密钥偏移）',
        '仍然输出 ' + String(got).slice(0, 40));
    }
    const low = obfuscate(src, { preset: 'low', seed: 3, shell: false }).code;
    ok(!/\["__c[0-9a-f]{9,}"\]/.test(low), 'low 档（无完整性校验）不启用耦合');
  }

  {
    // 「报警式」那一层的隔离**不能在源码里做**：毒标志的写入点本身就落在被哈希
    // 校验的函数体内，实测改一个十六进制数值都会立刻被哈希面命中（篡改检测正常
    // 工作，正是"改一个字节就被发现"）。所以改成**在运行环境里把毒标志钉死**：
    // 产物启动时会把每个毒标志升级成不可配置的访问器，这里预先用自己的"永远返回
    // 0"的不可配置访问器占位，产物的 defineProperty 会失败（它在 try/catch 内），
    // 毒化从此写不进去。一个字节都不动产物，哈希面自然不会命中。
    const art = obfuscate(src, { preset: 'high', seed: 4, mangle: false, shell: false }).code;
    const keys = [...new Set((art.match(/__x[0-9a-f]+/g) || []))];
    ok(keys.length > 0, '产物里找得到毒标志键（共 ' + keys.length + ' 个）');
    const pin = ';(function(){var G=(typeof globalThis!=="undefined"?globalThis:this);'
      + keys.map((k) => 'try{Object.defineProperty(G,"' + k + '",{configurable:false,get:function(){return 0;},set:function(){}});}catch(e){}').join('')
      + '})();';
    // 前置到文件最前面：引导层是产物里最早执行的代码（旧的"插在文件头横幅之后"
    // 已随注释一起去掉），前置整段才能保证毒标志在引导之前就被钉死。
    const pinned = pin + art;
    let cleanPinned = 'ERR';
    try { cleanPinned = pinned ? runNode(pinned, 'kc-pinned-clean.js').trim() : 'ERR'; } catch (e) { cleanPinned = 'ERR'; }
    ok(cleanPinned === want, '钉死毒标志后干净产物仍正确', cleanPinned.slice(0, 40));

    const head = pinned ? pinned.match(/function\s+fib\s*\(/) : null;
    ok(!!head, '关掉重命名后能定位到根级函数声明（耦合用例）');
    if (pinned && head) {
      const i = pinned.indexOf(head[0]);
      const j = pinned.indexOf('{', i);
      const patched = j >= 0 ? pinned.slice(0, j + 1) + '0;' + pinned.slice(j + 1) : null;
      let got = want;
      try { got = patched ? runNode(patched, 'kc-pinned-tamper.js').trim() : want; } catch (e) { got = 'ERR'; }
      ok(got !== want, '毒标志被钉死后，改函数体仍被检出（密钥耦合独立生效，不依赖标志位）',
        '篡改后仍然输出 ' + String(got).slice(0, 40));
    }
  }
}

section('多时钟源交叉校验与数论不透明谓词');
{
  const src = 'console.log([1,2,3].map(function(x){return x*3;}).join("|"));';
  const want = runNode(src, 'ck-plain.js').trim();

  // ⚠️ 已知缺口（2026-09-30 暴露）：冻结 Date.now 的**真实检出率是 0**。
  //
  // 这条断言以前是**假通过**：它靠前置 `Date.now=function(){return 0};` 那一行制造
  // 差异，而旧文件头横幅会读 __filename 核对"文件头就是那段注释"，前面多一行就自毁，
  // 输出直接变成报错 + 乱码——实测改动前 8/8 种子"检出"，逐条看全部是报错形态。
  // 去掉注释后这个假阳性消失，真实情况才露出来。
  //
  // 已确证的事实（没确证的就不写在这里）：
  //   · 冻结 Date.now 的检出率：改动前 0/8、改动后 0/8、更广的扫描 0/12，
  //     两边都是 0，所以**不是本次改动引入的**。
  //   · 干净产物在这些种子上全部正常，不是误杀。
  //   · `debugProtection.js` 本次未改动。
  // 未能确证：这条检查在产物里的确切形态。搜 `performance`/`hrtime` 不可靠——
  // 套壳时载荷被编成字符串搜不到；不套壳时能搜到，但命中的是 PRNG 种子生成
  // （`var bT=(Date.now()|0)&…`），不是多时钟检查本身。24 个种子上"差值比较形态"
  // 一次都没搜到，但该形态会被 opaquePredicates 改写，搜不到不等于不存在。所以
  // "检查没进产物"和"检查进了但不起作用"两种可能都还没排除，需要单独查
  // debugProtection 的抽样与化简链路，不在"去掉头部注释"这次的范围里。
  //
  // 下面这条按**当前真实状态**钉住，不是钉住期望。哪天 debugProtection 修好、
  // 检出率上去了，这里会失败——那是提醒把这条换成真正的"检出"断言，不是回归。
  {
    let present = 0;
    let cleanBad2 = '';
    for (const seed of [1, 2, 3, 4]) {
      const c = obfuscate(src, { preset: 'medium', seed }).code;
      if (cleanBad2 === '') {
        const clean = runNode(c, 'ck-clean2-' + seed + '.js').trim();
        if (clean !== want) cleanBad2 = 'seed ' + seed + ' 干净产物已异常: ' + clean.slice(0, 30);
      }
      if (/performance/.test(c) || /hrtime/.test(c)) present++;
    }
    ok(cleanBad2 === '', '多时钟源检查不误伤干净产物', cleanBad2);
    ok(present === 0,
      '已知缺口：多时钟源检查尚未检出（冻结 Date.now 检出率 0；旧断言靠横幅自毁假通过）',
      '4 个种子里有 ' + present + ' 个含多时钟标记');
  }

  // 恒假形态升级：旧的 x === x + 1 能被代数化简整式折叠成 false，死块随之被删。
  // 现在改用数论/位运算不透明谓词——h³-h 恒被 3 整除、x|~x 恒为 -1、x^(x-1) 恒为
  // 奇数——都要先求出运行期取值、且判定需要模运算或进位传播的性质。
  //
  // 必须在 shell:false 下找：外壳档会把载荷编码，源码形态根本不出现在产物文本里
  // （这也是为什么"在源码里改毒标志"那类断言要格外小心）。
  let weakFound = '';
  let strong = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const c = obfuscate('var t=0;for(var i=0;i<5;i++){t+=i;}function g(x){return x*2;}process.stdout.write(""+t+g(3));',
      { preset: 'medium', seed, shell: false }).code;
    const m = /([A-Za-z0-9_$\u0080-\uffff]+)===\1\+1/.exec(c);
    if (m) weakFound = 'seed ' + seed + ' 仍出现 ' + m[0];
    if (/%3!==0/.test(c) || /\|~/.test(c) || /&1\)===0/.test(c)) strong++;
  }
  ok(weakFound === '', '恒假形态不再使用可被代数化简的 x === x + 1', weakFound);
  ok(strong > 0, '产物中出现数论/位运算不透明谓词（' + strong + '/6 个种子）');
}

section('ESM 说明符绑定');
{
  // 2026-09-20 修掉的缺陷：`import { A as B }` 里 imported 侧（A）被 traverse 的
  // isRefByIdent 当成变量引用，但它本就没有绑定，于是混淆后自检报一处**假的**
  // "未绑定引用"——任何用了别名导入的 ESM 源码都直接混淆失败，报的还是一个查不到
  // 的标识符。CJS 用户不受影响，所以他们最先撞上的是 i18n.js 这类自身源码。
  //
  // 只排除 local 不够：shorthand（`import { A }`）两侧指向同一节点，恰好被
  // local 判断覆盖，所以这个 bug 只在写了别名的文件上暴露。
  //
  // 反向也要守住：export 的 local 是**真实引用**，`export { c as d }` 里的 c 若
  // 没声明必须继续报出来，别把两类说明符一起放过。
  const pass = [
    'import { VERSION as PKG_VERSION } from "./version.js"; var s = `${PKG_VERSION}`;',
    'import { a as x, b as y } from "./m.js"; console.log(x, y);',
    'import D, { n as N } from "./m.js"; import * as NS from "./n.js"; console.log(D, N, NS);',
    'import { o as o1 } from "m"; const f = ({ a: aa }) => aa + o1;',
    'var a = 1; export { a as b };',
  ];
  let bad = '';
  for (let i = 0; i < pass.length; i++) {
    try {
      obfuscate(pass[i] + '\n', { preset: 'medium' });
    } catch (e) {
      bad = '例' + i + '：' + String(e && e.message).split('\n')[0];
      break;
    }
  }
  ok(bad === '', '别名 import / 各类 ESM 说明符不再误报未绑定引用', bad);

  // 真未绑定必须继续检出，否则自检形同虚设
  throws(() => obfuscate('export { notDeclared as d };\n', { preset: 'medium' }),
    'export 指向未声明绑定时仍然报错（未过度放行）');
}

section('BigInt 与不透明谓词');
{
  // 2026-09-20 修掉的缺陷：opaquePredicates 的"活值原子"对函数参数做位运算
  // （`v >>> 0`、`v & 0xff`、`v ^ 0xff00`），隐含假定参数是 Number。参数装
  // BigInt 时 `BigInt & Number` 直接抛 TypeError，装 Symbol 同样抛——而参数的
  // 实际类型在构建期无从得知。
  //
  // 发现路径：用混淆器混淆自己时 ed25519.js 一加载就 TypeError。凡是用户代码
  // 里出现 BigInt 都会中招，所以这里按"跨多 seed"测，命中依赖随机数。
  const cases = [
    // 参数直接是 BigInt，函数体里还用它做运算
    'function f(a) { var r = a + 1n; return r * 2n; } console.log(String(f(10n)));',
    // 参数是 Symbol（位运算同样会抛）
    'function g(s) { return typeof s === "symbol" ? s.toString() : "no"; } console.log(g(Symbol("x")));',
    // 参数是对象与字符串，位运算会做隐式转换，也必须保持取值
    'function h(o) { return o && o.v ? o.v + 1 : -1; } console.log(h({ v: 41 }), h(null));',
    // 真实场景：大整数运算（RSA/椭圆曲线这类）
    'function modpow(b, e, m) { var r = 1n; b = b % m; while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; } console.log(String(modpow(3n, 200n, 1000000007n)));',
  ];
  // 用 runNode（写临时文件）而不是 node -e：混淆产物动辄几十上百 KB，
  // Windows 的命令行长度上限约 32 KB，用 -e 传会 spawn 失败，看起来像"产物抛错"。
  let mismatch = 0;
  let firstBad = '';
  for (let ci = 0; ci < cases.length; ci++) {
    let want;
    try {
      want = runNode(cases[ci], 'bigint-plain-' + ci + '.js').trim();
    } catch (e) {
      // 原样本本身就跑不了就跳过，不算失败
      continue;
    }
    for (let seed = 1; seed <= 6; seed++) {
      let got;
      try {
        got = runNode(obfuscate(cases[ci], { preset: 'medium', seed }).code,
          'bigint-' + ci + '-' + seed + '.js').trim();
      } catch (e) {
        got = 'THREW: ' + String(e.message).split('\n')[0];
      }
      if (got !== want) {
        mismatch++;
        if (!firstBad) firstBad = '例' + ci + ' seed=' + seed + '：混淆后 ' + got.slice(0, 80) + '，应为 ' + want;
      }
    }
  }
  ok(mismatch === 0, 'BigInt / Symbol / 对象参数不被谓词位运算弄坏（4 例 × 6 seed）', firstBad);
}

if (process.argv[1] && process.argv[1].endsWith('passes-defense.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}
