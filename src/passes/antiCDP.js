/**
 * Anti-CDP：Chrome DevTools Protocol 与自动化框架（Puppeteer / Playwright /
 * ChromeDriver / Selenium）的运行期检测。头部注入，纯浏览器守卫，Node 环境
 * 零副作用。检测向量全部是确定性硬证据，命中即投毒（与反调试共享毒药键），
 * 没有毒药键（stringArray 关闭）时降级为有界拖慢加隐蔽断点：
 *
 *   V1 console 序列化探针 —— CDP 客户端开启 Runtime.enable 后，console.log
 *      会为 consoleAPICalled 事件生成对象预览、console.debug 还会额外缓冲
 *      一份，对象上的访问器被立刻求值：log 触发 1 次、debug 触发 2 次，累计
 *      ≥2 即 Runtime.enable 在位（人工开着 DevTools 同样命中，同属反调试
 *      目标）；单次触发只算弱证据，走隐蔽断点不投毒。原生 console 引用在
 *      头部最先捕获——本 pass 先于 debugProtection 注入，头部执行顺序等于
 *      pass 调用顺序，consoleStub 的失效化不影响探针；
 *   V2 navigator.webdriver —— 两条判据：① 属性为 true（自动化驱动默认带
 *      --enable-automation 启动，人工浏览永远是 false/undefined）；② navigator
 *      实例上存在自有 webdriver 属性（stealth 框架的标准伪装手法，规范把该属性
 *      定义在 Navigator.prototype 上，实例上不该有）。判据 ② 的实测依据见 v2Src
 *      处的注释，含一条**已知残余**（原型级覆盖查不到）；
 *   V3 自动化痕迹扫描 —— window / navigator / document 上的驱动注入属性
 *      （__webdriver_evaluate、$chrome_asyncScriptInfo、__lastWatirAlert 等）
 *      逐一精确比对，再对 "cdc_" 子串做一遍枚举扫描（ChromeDriver 注入的
 *      $cdc_<随机串> 属性名带随机后缀，只能子串匹配）。
 *
 * V1 启动跑一次，外加低频周期重跑（每 10~20 个复查周期一次，探针对象污染可接受；
 * 尾巴是衰减累加器，持续在场才投毒，单次偶发自然衰减）；V2/V3 由定时器
 * 周期复查，间隔从 debugProtectionInterval 派生并逐构建随机。所有特征串经
 * 掩码恒等式重组（M），产物文本里没有可批量定位的明文指纹。定时器句柄
 * unref，不阻塞进程退出。
 */
import parser from '../ast/parser.js';
const { parse } = parser;
import rand from '../utils/rand.js';
const { randInt, uniqueName, randHex } = rand;
import hide from '../utils/hide.js';
const { makeDbgHelpers, obfStrExpr, globalRef } = hide;
import rtlib from './rtlib.js';

const NOW = '(Date.now?Date.now():(new Date()).getTime())';

// 自动化痕迹属性表。逐一精确比对；$cdc_ 系列名字带随机后缀，另走子串扫描。
const ARTIFACTS = [
  '__webdriver_evaluate', '__selenium_evaluate', '__driver_evaluate',
  '__fxdriver_evaluate', '__webdriver_unwrapped', '__driver_unwrapped',
  '__selenium_unwrapped', '__fxdriver_unwrapped', '_Selenium_IDE_Recorder',
  '_selenium', 'calledSelenium', '_WEBDRIVER_ELEM_CACHE', 'ChromeDriverw',
  'webdriver-evaluate', 'webdriverCommand', 'webdriver-evaluate-response',
  '__$webdriverAsyncExecutor', '$chrome_asyncScriptInfo', '__lastWatirAlert',
  '__lastWatirConfirm', '__lastWatirPrompt', '__webdriver_script_fn',
  '__webdriver_script_func', '__phantomas', 'domAutomation',
  'domAutomationController',
];

export default function antiCDP(ast, options, ctx) {
  const program = ast.type === 'File' ? ast.program : ast;
  const rt = ctx.rt || {};
  const M = (s) => obfStrExpr(s, rt.tblCall, rt.fcc);
  // 原生字符串原语改走 RT 内核调用，无内核时回退原生，保证降级后仍可运行
  const IOF = (s, needle) => rt.iof ? rt.iof + '(' + s + ',' + needle + ')' : '(' + s + ').indexOf(' + needle + ')';
  const { varSource: cdpVarSource } = makeDbgHelpers(rt.tblCall);

  // catch 形参名逐构建随机。模板里的 `catch(_0w){}` 是空 catch，名字只出现一次，
  // 但跨构建固定就是可 grep 的头部指纹（mangle 够不着已注入的头部，改不了它）。
  // `_0` + 3 位 hex：不可能是 RESERVED 关键字；空 catch 作用域内无引用，任何名
  // 都安全。登记进 usedNames，免得后置 pass 抽中同名（同一构建内重名即遮蔽，
  // 虽不改语义，但少一次巧合）。随机性走构建种子流，同 seed 可复现。
  const cw = '_0' + randHex(3);
  if (ctx.usedNames) ctx.usedNames.add(cw);

  // 毒药联动：stringArray（pass 4）已在 program 上登记毒药属性键，本 pass
  // 写同一组键，解码器下次解码即损坏。头部执行顺序先于 debugProtection，
  // 直接写入的毒值会被其闩锁原样读回并锁死，两条链路天然兼容。
  const poisonKeys = Array.isArray(program.__poisonKeys) ? program.__poisonKeys : null;
  const poisonable = !!(poisonKeys && poisonKeys.length);
  const poisonSrc = (ref) => poisonKeys
    .map((k) => ref + '["' + k + '"]=0x' + (randInt(1, 0xffff) | 1).toString(16) + ';')
    .join('');

  // 命中动作：CDP 硬证据不做确认计数，直接投毒；没有毒药键时降级为有界拖慢
  // 加隐蔽断点（无界自旋不存在，拖慢上限逐构建随机）。
  const HANG_MS = randInt(300, 900);
  const hitSrc = (ref) => (poisonable
    ? poisonSrc(ref)
    : 'var _0hs=' + NOW + ';while((' + NOW + ')-_0hs<' + HANG_MS + '){}') + '_0xdg();';

  // V2/V3 的源码被启动首遍与周期复查共用
  //
  // V2 有两条判据，第二条是 2026-10-12 加的 stealth 反探测：
  //   ① navigator.webdriver === true —— 自动化驱动默认带 --enable-automation；
  //   ② navigator 实例上存在**自有** webdriver 属性 —— stealth 框架的标准手法就是
  //      `Object.defineProperty(navigator,'webdriver',{get:()=>false})`，① 恰好被它
  //      整个绕过。
  // ② 成立的基础是 HTML 规范把 webdriver 定义在 **Navigator.prototype** 上，实例上
  // 不该有同名自有属性。实测（headless Chromium，自动化已开）：
  //   stock 形态          ownDescriptor=null，原型上是访问器，in navigator=true
  //   实例上 defineProperty ownDescriptor={get:function}，webdriver=false
  // 也就是说"自动化本身"不产生自有属性，只有注入才会——所以 ② 是硬证据，可以和 ①
  // 同等对待（直接投毒），不需要衰减计数。
  //
  // 实测同时排除了两条想当然的判据：
  //   · `delete navigator.webdriver` 在 Chromium 里根本无效（原型属性还在，读到的仍是
  //     true），所以"属性缺失"不是现实 evasion 路径；而按缺失判假又会在 2018 年前
  //     的浏览器上大面积误报，误报即投毒，不做。
  //   · 原型级覆盖（delete Navigator.prototype.webdriver 再 defineProperty）
  //     实例上不留任何痕迹，纯 JS 侧无法与引擎原生访问器区分——这条是**已知残余**，
  //     按可枚举性/可配置性去猜会踩到 Safari 等引擎的实现差异，风险不对称，不做。
  const v2Src =
    '(function(){if(typeof navigator===typeof void 0||!navigator){return;}' +
    'var _0wdh=navigator[' + M('webdriver') + ']===true;' +
    'if(!_0wdh){try{_0wdh=!!Object.getOwnPropertyDescriptor(navigator,' + M('webdriver') + ');}catch(_0e){}}' +
    'if(_0wdh){' + hitSrc('_0xG') + '}})();';
  const v3Src =
    '(function(){if(typeof window===typeof void 0){return;}' +
    'var _0os=[window,(typeof navigator!==typeof void 0&&navigator)?navigator:null,' +
    '(typeof document!==typeof void 0&&document)?document:null];' +
    'var _0ks=[' + ARTIFACTS.map(M).join(',') + '];' +
    'var _0hit=false;' +
    'for(var _0i=0;_0i<_0os.length&&!_0hit;_0i++){var _0o=_0os[_0i];if(!_0o){continue;}' +
    'for(var _0j=0;_0j<_0ks.length;_0j++){if(_0o[_0ks[_0j]]!==undefined){_0hit=true;break;}}}' +
    'if(!_0hit){for(var _0q=0;_0q<_0os.length;_0q++){var _0o2=_0os[_0q];if(!_0o2){continue;}try{' +
    'for(var _0p in _0o2){if(' + IOF('_0p', M('cdc_')) + '>-1){_0hit=true;break;}}}' +
    'catch(_0e){}if(_0hit){break;}}}' +
    'if(_0hit){' + hitSrc('_0xG') + '}})();';
  const v1Src =
    '(function(){if(typeof window===typeof void 0||!_0clog||!_0cdb){return;}' +
    'var _0n=0;var _0gp={};' +
    // enumerable 必须显式置真：defineProperty 默认不可枚举，而 CDP 预览与
    // 自动化框架的序列化都走"枚举自属性再求值访问器"的路径，不可枚举的
    // 探针会被 Object.keys 一类枚举直接跳过，探针就永远打不响
    'Object.defineProperty(_0gp,"x",{configurable:true,enumerable:true,get:function(){_0n++;return 1;}});' +
    'try{_0clog(_0gp);}catch(_0e){}' +
    'try{_0cdb(_0gp);}catch(_0e){}' +
    'if(_0n>=2){' + hitSrc('_0xG') + '}else if(_0n===1){_0xdg();}})();';
  // V1 周期版（2026-10-11）：与启动版同一探针体，尾巴换成衰减累加器。启动版保持
  // "见 2 次即投毒"（CDP 在场时一次命中就够）；周期版低频跑（每 V1EVERY 个复查
  // 周期一次，console 探针对象污染可接受），累加器每轮先加本轮命中、再衰减 1：
  // 持续在场 3 轮即累计 ≥4 投毒，单次偶发（2→1→0）自然衰减掉。修的是"启动后才
  // attach 的 CDP 过去漏检"——V1 原先只跑一次。持续弱证据（每轮恰 1 次）不投毒，
  // 与启动版"1 次只断点"的口径一致。
  const V1EVERY = randInt(10, 20);
  const v1PeriodicSrc =
    '(function(){if(typeof window===typeof void 0||!_0clog||!_0cdb){return;}' +
    'var _0n=0;var _0gp={};' +
    'Object.defineProperty(_0gp,"x",{configurable:true,enumerable:true,get:function(){_0n++;return 1;}});' +
    'try{_0clog(_0gp);}catch(_0e){}' +
    'try{_0cdb(_0gp);}catch(_0e){}' +
    '_0v1acc+=_0n;if(_0v1acc>=4){' + hitSrc('_0xG') + '}if(_0v1acc>0){_0v1acc--;}})();';

  const PERIOD = Math.max(3000, Math.floor(
    (options.debugProtectionInterval > 50 ? options.debugProtectionInterval : 4000)
    * (randInt(75, 150) / 100)));

  // 头部函数体，整体以源码构造，规避手工拼 AST 的引用与调用错位
  const parts = [];
  parts.push(cdpVarSource('_0xdg'));
  parts.push('var _0xG=' + globalRef() + ';');
  // 原生 console 引用必须最先捕获：本头部在产物中先于 debugProtection 执行，
  // consoleStub 的失效化发生在后，捕获到的引用永远是原生方法
  parts.push('var _0cl=(typeof console!==typeof void 0&&console)?console:null;');
  parts.push('var _0clog=(_0cl&&typeof _0cl["log"]==="function")?_0cl["log"]:null;');
  parts.push('var _0cdb=(_0cl&&typeof _0cl["debug"]==="function")?_0cl["debug"]:null;');
  parts.push('try{' + v1Src + '}catch(_0z){}');
  parts.push('try{' + v2Src + '}catch(_0z){}');
  parts.push('try{' + v3Src + '}catch(_0z){}');
  // 周期复查跑 V2/V3，外加低频 V1（计数器每 V1EVERY 个周期命中一次）。
  // V1 会往控制台打探针对象，逐周期跑是可见污染，所以只低频跑；_0v1acc 与
  // _0tick 是头部函数作用域变量，随头部执行一次初始化，定时器闭包共享。
  parts.push('var _0tick=0;var _0v1acc=0;');
  parts.push('if(typeof window!==typeof void 0&&typeof setInterval==="function"){try{' +
    'var _0th=setInterval(function(){try{_0tick++;' + v2Src + v3Src + '}catch(_0e){}' +
    'try{if(_0tick%' + V1EVERY + '===0){' + v1PeriodicSrc + '}}catch(_0e){}},' + PERIOD + ');' +
    'try{if(_0th&&typeof _0th.unref==="function"){_0th.unref();}}catch(' + cw + '){}}catch(' + cw + '){}}');

  const headFnName = uniqueName(ctx.usedNames, '_0x');
  const headSrc = 'function ' + headFnName + '(){' + parts.join('') + '}' +
    'try{' + headFnName + '();}catch(_0z){}';
  let headStmts = [];
  try {
    headStmts = parse(headSrc, { sourceType: 'script' }).program.body;
  } catch (e) {
    headStmts = [];
  }
  if (!headStmts.length) return { injected: false, vectors: 0, periodic: false, poison: poisonable };
  rtlib.insertHead(ctx, program, headStmts);

  return {
    injected: true,
    vectors: 3,
    periodic: true,
    period: PERIOD,
    v1Every: V1EVERY,
    // V2 第二条判据（navigator 实例上的自有 webdriver 属性）是否在位。
    // 消费方用它确认"stealth 反探测"这条链真的生成了，而不是被 gate 掐掉。
    v2OwnCheck: true,
    poison: poisonable,
    headFn: headFnName,
  };
};
