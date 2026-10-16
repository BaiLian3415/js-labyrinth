import parser from '../ast/parser.js';
const { parse } = parser;
import rand from '../utils/rand.js';
const { randInt, randHex, randAlpha, shuffle, uniqueName } = rand;
import hide from '../utils/hide.js';
const { makeDbgHelpers, obfStrExpr, globalRef } = hide;
import vmBoundary from './vmBoundary.js';
const { insideVmFunction } = vmBoundary;
import rtlib from './rtlib.js';
/**
 * 反调试保护，含确认投毒联动与可选的 console 失效化。注入点不出现 debugger 明文，
 * 触发函数运行时经 Function 构造器动态生成并缓存在 globalThis 随机属性上。Program
 * 头部的反调试取命名函数声明加包装调用，integrityCheck 的哈希面覆盖它，patch 任一
 * 检测点都会改变函数文本并哈希失配，最终毒化全部字符串解码器。响应分隐蔽断点、有
 * 界拖慢、确认投毒三级，后两级均有界，不会冻结没有调试器的进程。
 *
 * 检测点在头部按 70% 概率逐个入选并打乱顺序，函数级哨兵按 options.sentinelRate
 * 抽样，默认约 35%；投毒由 options.debugPoison 控制，默认开启，没有毒药键时降级
 * 为前两级；options.consoleStub 打开时把 console 各方法置空。
 *
 * 检测分三类：尺寸/时差/栈形态这类环境侧信号、内建函数"原生文本"检测，以及
 * 内建函数"对象身份"检测。第三类在头部捕获 Function、Object.defineProperty、
 * Object.getOwnPropertyDescriptor、Function.prototype.call、eval 的引用，运行期
 * 比对身份——替换式 hook 可以顺手伪造 toString 文本，却很难同时保住对象身份与
 * 描述符结构，所以再加一个"自建对象上装访问器再读回描述符"的 canary。
 */

const NOW = '(Date.now?Date.now():(new Date()).getTime())';

export default function debugProtection(ast, options, ctx) {
  const { rng } = ctx;
  const program = ast.type === 'File' ? ast.program : ast;
  const interval = options.debugProtectionInterval || 4000;
  const rt = ctx.rt || {};
  const M = (s) => obfStrExpr(s, rt.tblCall, rt.fcc);
  // 原生字符串原语改走 RT 内核调用，无内核时回退原生，保证降级后仍可运行
  const IOF = (s, needle) => rt.iof ? rt.iof + '(' + s + ',' + needle + ')' : '(' + s + ').indexOf(' + needle + ')';
  const { varSource: dbgVarSource } = makeDbgHelpers(rt.tblCall);

  // catch 形参名（含 `var _0w=window` 那个实变量）逐构建随机：模板在 mangle
  // 之前注入的，mangle 会照常改名，无碍；关键是将来若有模板移到 mangle 之后，
  // 名字仍逐构建变化。`_0` + 3 位 hex 不可能是关键字；各模板自包含，声明与
  // 引用同现，一处定义全文件通用（每个 catch/IIFE 都是独立作用域）。
  const cw = '_0' + randHex(3);
  if (ctx.usedNames) ctx.usedNames.add(cw);

  // 毒药联动：stringArray（pass 4）已在 program 上登记毒药属性键，本
  // pass 直接写同一组键，解码器下次解码即损坏。无键（stringArray 关闭）或
  // 显式 --no-debug-poison 时降级为隐蔽断点加有界拖慢。
  const poisonKeys = Array.isArray(program.__poisonKeys) ? program.__poisonKeys : null;
  const poisonable = options.debugPoison !== false && !!(poisonKeys && poisonKeys.length);
  const poisonSrc = (ref) => poisonKeys
    .map((k) => ref + '["' + k + '"]=0x' + (randInt(1, 0xffff) | 1).toString(16) + ';')
    .join('');

  // globalThis 属性键，与触发器缓存 __d、毒药 __x 前缀字面隔离。这些是
  // 纯字符串属性访问，不经 var 绑定，mangle 不会波及：
  //  __a arm 头部已装配，复活调用据此幂等；__b hb 心跳时刻，供看门狗读取；
  //  __c cnt 确认命中计数；__i insp Node --inspect 证据；__h hd 本模块已装配
  //  定时器句柄表，重建前据此 clearInterval；__r rc 已消耗的重建额度，若改成
  //  闭包局部计数会被每次头部调用重置，额度就形同虚设。
  const KEYS = {
    arm: '__a' + randHex(6),
    hb: '__b' + randHex(6),
    cnt: '__c' + randHex(6),
    insp: '__i' + randHex(6),
    hd: '__h' + randHex(6),
    rc: '__r' + randHex(6),
  };

  // 确认命中，计数一次并在达到阈值时投毒，ref 为该作用域内的 globalThis 引用
  const confirmSrc = (ref) => (poisonable
    ? 'var _0cv=((' + ref + '["' + KEYS.cnt + '"]|0)+1);' + ref + '["' + KEYS.cnt + '"]=_0cv;' +
      'if(_0cv>=2||(_0cv>=1&&' + ref + '["' + KEYS.insp + '"])){' + poisonSrc(ref) + '}'
    : '');

  /**
   * 反 Hook / 反 Proxy 专项的命中响应。
   *
   * 分两档，依据是"误报可能性"而不是"信号强度"：
   *
   *   strong=false（纯身份比对）—— 隐蔽断点 + 确认后投毒（沿用 sentinel 的两级）。
   *     身份被替换在理论上可能是语义等价的 polyfill，留一次确认更稳。头部函数
   *     有一次性闩锁，所以这条依赖周期复查累积计数才有第二次机会。
   *
   *   strong=true（行为探针）—— 隐蔽断点 + 立即投毒。
   *     行为探针要求"同一个函数两种途径调用结果不一致"或"Proxy trap 不触发"，
   *     语义等价的实现不可能命中；命中即确定被插桩，再等一次确认只是给攻击者
   *     多留一个执行窗口（头部只跑一次，周期复查要等定时器，实测沙箱里根本不跑）。
   *
   * 代价与逃生口：若宿主在产物加载之前就替换了这些内建且语义不等价（例如把
   * `apply` 换成会改写返回值的转发层），产物会被投毒。这是有意为之的 fail-closed，
   * 关掉 `debugProtection` 即可规避。
   */
  const hookHit = (strong) => {
    const base = '_0xdg();';
    if (!poisonable) return base;
    return base + (strong ? poisonSrc('_0xG') : confirmSrc('_0xG'));
  };

  // 构建期随机阈值
  const TIME_ALLOW = randInt(80, 150);
  const TIME_CONFIRM = TIME_ALLOW + randInt(350, 650);
  const HANG_MS = randInt(500, 1500);
  const SIZE_ALLOW = randInt(150, 350);
  const PERF_ALLOW = randInt(60, 120);
  const PERF_CONFIRM = PERF_ALLOW + randInt(350, 650);
  const PERF_HANG = randInt(300, 900);
  const perPd = Math.max(250, Math.floor(interval * (randInt(60, 150) / 100)));
  const perPd2 = Math.max(200, Math.floor(interval * (randInt(25, 55) / 100)));
  const perTd = Math.max(200, Math.floor((interval / 2) * (randInt(70, 140) / 100)));
  const WD_MS = Math.max(5000, interval * randInt(4, 6));
  const STALL_MS = Math.max(9000, interval * 10);
  const REARMS = randInt(2, 3);
  const extraDebuggers = randInt(0, 1);
  // 多时钟源交叉验证的判定阈值：同源双读（Date.now 与 new Date）允许的漂移，
  // 以及"两个不同时钟源增量互相矛盾"的确认阈值。
  const CROSS_ALLOW = randInt(60, 120);
  const CROSS_CONFIRM = CROSS_ALLOW + randInt(300, 600);

  // 可选检测点，源码形态，命中动作为 _0xdg()，构建级子集抽取
  const checks = [
    // 尺寸检测，看浏览器 DevTools 停靠占位，属性名掩码重组后经计算下标访问
    '(function(){if(typeof window!==typeof void 0){var ' + cw + '=window;' +
    'var _0dx=' + cw + '[' + M('outerWidth') + ']-' + cw + '[' + M('innerWidth') + '];' +
    'var _0dy=' + cw + '[' + M('outerHeight') + ']-' + cw + '[' + M('innerHeight') + '];' +
    'if(_0dx>' + SIZE_ALLOW + '||_0dy>' + SIZE_ALLOW + '){_0xdg();}}})();',
    // Function.prototype.toString 防 hook
    '(function(){if(' + IOF('(Function.prototype.toString.toString()+"")', M('native')) + '===-1){_0xdg();}})();',
    // console 原生性检测
    '(function(){if(typeof console!==typeof void 0&&console&&typeof console.log==="function"){' +
    'if(' + IOF('(Function.prototype.toString.call(console.log)+"")', M('native code')) + '===-1){_0xdg();}}})();',
    // performance 高精度时差，确认命中计入投毒计数
    '(function(){if(typeof performance!==typeof void 0&&performance&&typeof performance.now==="function"){' +
    'var _0p0=performance.now();_0xdg();var _0p1=performance.now();var _0pg=_0p1-_0p0;' +
    'if(_0pg>' + PERF_CONFIRM + '){' + confirmSrc('_0xG') + '}' +
    'if(_0pg>' + PERF_ALLOW + '){_0xdg();var _0ph=performance.now();while(performance.now()-_0ph<' + PERF_HANG + '){}}' +
    '}})();',
    // Error.prepareStackTrace 被 hook，属性名经掩码重组
    '(function(){if(typeof Error!==typeof void 0&&typeof Error[' + M('prepareStackTrace') + ']!==typeof void 0){_0xdg();}})();',
    // Error.stackTraceLimit 被篡改
    '(function(){if(typeof Error!==typeof void 0&&typeof Error[' + M('stackTraceLimit') + ']!==typeof void 0&&' +
    'typeof Error[' + M('stackTraceLimit') + ']!=="number"){_0xdg();}})();',
    // Error().stack 自一致性，空栈或单行压扁说明栈被 hook，不支持栈的环境不误触
    '(function(){if(typeof Error!==typeof void 0){var _0st=new Error().stack;' +
    'if(typeof _0st==="string"&&_0st.length>0&&' +
    IOF('_0st', rt.fcc ? rt.fcc + '(10)' : '"\\n"') + '===-1){_0xdg();}}})();',
    // console getter 探针，DevTools 打开时 console.log 会求值对象 getter，仅浏览器
    '(function(){if(typeof console!==typeof void 0&&typeof window!==typeof void 0){' +
    'var _0gf=false;var _0gp={};' +
    'Object.defineProperty(_0gp,"x",{get:function(){_0gf=true;return 1;}});' +
    'console.log(_0gp);if(_0gf){_0xdg();}}})();',
    // window 属性 Proxy 劫持 canary，读两次比对一致性，仅浏览器
    '(function(){if(typeof window!==typeof void 0&&typeof Math!==typeof void 0){' +
    'var _0xy=(function(){try{' +
    'var _0kw="__z"+' + (rt.toh ? rt.toh + '((new Date().getTime()^0x5f3a5f3a)>>>0)' : '(new Date().getTime()).toString(36)') + ';' +
    'Object.defineProperty(window,_0kw,{configurable:true,get:function(){return 0x1a7;}});' +
    'var _0a1=window[_0kw];var _0a2=window[_0kw];' +
    'delete window[_0kw];' +
    'return _0a1===_0a2&&_0a1===0x1a7;' +
    '}catch(_0e){return true;}})();' +
    'if(!_0xy){_0xdg();}}})();',
    // Node --inspect 证据，查 execArgv 与 NODE_OPTIONS，置证据键后单次确认命中即投毒
    '(function(){if(typeof process!==typeof void 0){' +
    'var _0ja=(typeof process.execArgv!==typeof void 0?process.execArgv:[]);' +
    'var _0j=' + (rt.join ? rt.join + '(_0ja," ")' : '_0ja.join(" ")') + ';' +
    'var _0o=(process.env&&typeof process.env.NODE_OPTIONS==="string")?process.env.NODE_OPTIONS:"";' +
    'if(' + IOF('_0j', M('inspect')) + '>-1||' + IOF('_0o', M('inspect')) + '>-1){' +
    (poisonable ? '_0xG["' + KEYS.insp + '"]=1;' : '') +
    '_0xdg();}}})();',
    // Function.prototype.toString 被事后替换，与头部捕获的原生引用比对身份
    '(function(){if(typeof Function!==typeof void 0&&Function.prototype&&' +
    'Function.prototype[' + M('toString') + ']!==_0xFP){_0xdg();}})();',
    // prepareStackTrace 陷阱被摘除，描述符上的 set 访问器不再在位
    '(function(){if(_0xPT&&!_0xPT()){_0xdg();}})();',
    // setInterval 被替换，比对头部捕获的引用与当前全局
    '(function(){if(_0xSI&&typeof setInterval!==typeof void 0&&setInterval!==_0xSI){_0xdg();}})();',
    // 内建身份快照组。头部捕获 Function、Object.defineProperty、
    // Object.getOwnPropertyDescriptor、Function.prototype.call 与 eval 的引用，
    // 运行期比对身份：替换式 hook 会换掉函数对象，比对身份比查 toString 更
    // 难骗——hook 者常把 toString 一并伪造，却很少能保住对象身份。
    '(function(){if(_0xF1&&typeof Function!==typeof void 0&&Function!==_0xF1){_0xdg();}})();',
    '(function(){if(_0xDP&&typeof Object!==typeof void 0&&Object.defineProperty!==_0xDP){_0xdg();}})();',
    '(function(){if(_0xGP&&typeof Object!==typeof void 0&&Object.getOwnPropertyDescriptor!==_0xGP){_0xdg();}})();',
    '(function(){if(_0xCA&&typeof Function!==typeof void 0&&Function.prototype&&Function.prototype.call!==_0xCA){_0xdg();}})();',
    // eval 被替换：外壳与隐蔽触发器都经它构造，换掉 eval 是脱壳与去断点的前提
    '(function(){if(_0xEV&&typeof eval!==typeof void 0&&eval!==_0xEV){_0xdg();}})();',
    // 描述符 canary：在自建对象上装一个访问器再读回描述符，被 hook 的
    // defineProperty / getOwnPropertyDescriptor 留不下完全一致的描述符
    '(function(){if(!_0xDP||!_0xGP){return;}' +
    'try{var _0co={};var _0cg=function(){return 0x1a7;};' +
    '_0xDP(_0co,"p",{configurable:true,get:_0cg});' +
    'var _0cd=_0xGP(_0co,"p");' +
    'if(!_0cd||_0cd.get!==_0cg||!_0cd.configurable){_0xdg();}}catch(_0e){_0xdg();}})();',
    // RT 内核依赖的原生存活性：String.prototype.split 是解码器的底座之一，
    // 被替换即说明整条原生链被接管
    '(function(){if(typeof String!==typeof void 0&&String.prototype&&typeof String.prototype.split==="function"){' +
    'if(' + IOF('(""+String.prototype.split)', M('native code')) + '===-1){_0xdg();}}})();',
    // 多时钟源交叉验证。上面的 performance 检查只看"有没有明显停顿"，对"时钟被
    // 整体换掉但照样返回数字"无能为力；而 hook Date.now / performance.now 正是
    // 调试与去断点的第一步。
    //
    // 三段互相印证：
    //   ① 同源双读——Date.now() 与 new Date().getTime() 必须落在同一个时刻；
    //   ② 跨源增量——同一段真实计算里，performance.now 的增量与 Date.now 的增量
    //      必须同量级。只 hook 其中一个会让"performance 说过了很久、Date 说几乎
    //      没动"这种自相矛盾出现（真挂起会同时推高两者，因此不会误判）；
    //   ③ Node 侧再掺入 process.hrtime，三个时钟源两两对照，单独伪造一个必然
    //      与另两个对不上。
    '(function(){if(typeof Date!==typeof void 0&&typeof Date.now==="function"){' +
    'var _0cy=new Date().getTime();var _0cz=Date.now();' +
    'if(_0cy-_0cz>' + CROSS_ALLOW + '||_0cz-_0cy>' + CROSS_ALLOW + '){_0xdg();}' +
    'if(typeof performance!==typeof void 0&&performance&&typeof performance.now==="function"){' +
    'var _0cq=performance.now();var _0cd=_0cz;' +
    'if(typeof process!==typeof void 0&&process&&typeof process.hrtime==="function"){var _0ch0=process.hrtime();}' +
    'var _0cj=0;for(var _0ci=0;_0ci<2000;_0ci++){_0cj=(_0cj+_0ci)%7;}' +
    'if(_0cj===-1){_0xdg();}' +
    'var _0cr=performance.now();var _0ce=Date.now();' +
    'var _0cP=_0cr-_0cq;var _0cD=_0ce-_0cd;' +
    'if(_0cP>' + CROSS_CONFIRM + '&&_0cD*4<_0cP){' + confirmSrc('_0xG') + '}' +
    'if(typeof process!==typeof void 0&&process&&typeof process.hrtime==="function"){' +
    'var _0ch1=process.hrtime();' +
    'var _0cH=((_0ch1[0]-_0ch0[0])*1000)+((_0ch1[1]-_0ch0[1])/1000000);' +
    'if(_0cH-_0cP>' + CROSS_CONFIRM + '||_0cP-_0cH>' + CROSS_CONFIRM + '){_0xdg();}' +
    '}' +
    '}}})();',
  ];

  // ---- 反 Hook / 反 Proxy 专项：常驻，不参与抽样 ----
  // 七条探针分两组：身份快照比对（查出"被替换"）与行为自洽（查出"被包装成行为不同的
  // 等价物"——这类 hook 的身份快照反正是自己，只能靠行为对上）。劫持方要绕过就得同时
  // 伪造身份与行为。
  //
  // 不抽样的理由：抽样是为了摊薄检查成本，代价是"这一条本次没执行"。尺寸/时差那
  // 类环境信号即使漏检也就是少一次机会；而 hook 检测漏检等于整条防线不存在——实测
  // 70% 抽样下七条里通常只进 1~2 条，装上 hook 的产物照样跑出正确结果。这组探针总共
  // 只是几次属性读与一次极小对象的 Proxy 构造，成本远低于被抽掉的风险，因此常驻。
  // 命中响应走 hookHit()：隐蔽断点 + 可用时升级投毒（理由见该函数的注释）。
  //
  // 注意快照的固有边界：hook 若在本代码加载之前就装好，快照拍到的就是 hook 本身，
  // 身份比对自然相等——所以真正兜底的是下面那几条行为探针（它们不依赖快照）。
  // 两组缺一不可。
  const hookChecks = [
    // --- 身份比对（strong=false：语义等价的 polyfill 理论可能存在，留一次确认）---
    // Function.prototype.apply 被替换
    '(function(){if(_0xAP&&typeof Function!==typeof void 0&&Function.prototype&&Function.prototype[' + M('apply') + ']!==_0xAP){' + hookHit(false) + '}})();',
    // Proxy 构造器被替换
    '(function(){if(_0xPX&&typeof Proxy!==typeof void 0&&Proxy!==_0xPX){' + hookHit(false) + '}})();',
    // Reflect 被替换 / 被包装
    '(function(){if(_0xRF&&typeof Reflect!==typeof void 0&&Reflect!==_0xRF){' + hookHit(false) + '}})();',
    // --- 行为自洽（strong=true：语义等价的实现不可能命中，立即投毒）---
    // apply 行为：两种途径调用必须一致。预装 hook 也抓得到（不依赖快照）
    '(function(){try{var _0af=function(_0x){return _0x+1;};if(_0af[' + M('apply') + '](null,[1])!==2){' + hookHit(true) + '}}catch(' + cw + '){' + hookHit(true) + '}})();',
    // Proxy 行为：trap 必须真的被调用，且透传取值正确
    '(function(){if(!_0xPX){return;}try{var _0pa=0;var _0pt=new Proxy({v:0x1a7},{get:function(_0t,_0k){_0pa++;return _0t[_0k];}});if(_0pt.v!==0x1a7||_0pa<1){' + hookHit(true) + '}}catch(' + cw + '){' + hookHit(true) + '}})();',
    // Reflect.apply 行为：被替换，或与 Function.prototype.apply 结果不一致
    '(function(){if(!_0xRG||typeof Reflect===typeof void 0||!Reflect||!Reflect[' + M('apply') + ']){return;}if(Reflect[' + M('apply') + ']!==_0xRG){' + hookHit(true) + ';return;}try{var _0af=function(_0x){return _0x+1;};if(Reflect[' + M('apply') + '](_0af,null,[1])!==2){' + hookHit(true) + '}}catch(' + cw + '){' + hookHit(true) + '}})();',
    // defineProperty 行为：数据属性必须真的写进去（转发但吞掉/改写的包装层会露）
    '(function(){if(!_0xDP){return;}try{var _0o={};_0xDP(_0o,' + M('d') + ',{value:0x1a7,configurable:true});if(_0o[' + M('d') + ']!==0x1a7){' + hookHit(true) + '}}catch(' + cw + '){' + hookHit(true) + '}})();',
  ];

  const headChecks = [];
  for (const chk of checks) {
    if (rng() < 0.7) headChecks.push(chk);
  }
  if (!headChecks.length) headChecks.push(checks[randInt(0, checks.length - 1)]);
  headChecks.push(...hookChecks);
  shuffle(headChecks);

  // 头部函数体，整体以源码构造，规避手工拼 AST 的引用与调用错位
  const parts = [];
  parts.push(dbgVarSource('_0xdg'));
  parts.push('var _0xG=' + globalRef() + ';');
  parts.push('var _0armed=false;');
  parts.push('var _0xSI=(typeof setInterval!==typeof void 0?setInterval:null);');
  parts.push('var _0xCI=(typeof clearInterval!==typeof void 0?clearInterval:null);');
  // 每个句柄登记进 __h 表，_0xclr 据表清空。装配路径无论是首装配还是复入重
  // 建都先清后装，定时器数量恒定一份，不随重建次数叠加。
  parts.push('var _0xarm=function(_0xf,_0xm){if(!_0xSI){return null;}' +
    'var _0h=_0xSI(_0xf,_0xm);' +
    'try{if(_0h&&typeof _0h.unref==="function"){_0h.unref();}}catch(' + cw + '){}' +
    'try{var _0ha=_0xG["' + KEYS.hd + '"];' +
    'if(!_0ha||typeof _0ha.push!=="function"){_0ha=[];_0xG["' + KEYS.hd + '"]=_0ha;}' +
    '_0ha.push(_0h);}catch(' + cw + '){}' +
    'return _0h;};');
  parts.push('var _0xclr=function(){try{var _0ha=_0xG["' + KEYS.hd + '"];' +
    'if(_0ha&&_0xCI){for(var _0i=0;_0i<_0ha.length;_0i++){_0xCI(_0ha[_0i]);}}' +
    '_0xG["' + KEYS.hd + '"]=[];}catch(' + cw + '){}};');
  parts.push('var _0xhb=function(){try{_0xG["' + KEYS.hb + '"]=' + NOW + ';}catch(' + cw + '){}};');
  // 原生引用身份快照，用于发现检测启动后对关键内建函数的替换式 hook。
  // 除 Function.prototype.toString 外再抓五个：Function 构造器、
  // Object.defineProperty、Object.getOwnPropertyDescriptor、
  // Function.prototype.call 与 eval。外壳、隐蔽触发器与解码器全部依赖它们，
  // 身份比对比 toString 文本比对更难伪造——hook 者通常顺手改掉 toString。
  parts.push('var _0xFP=(typeof Function!==typeof void 0&&Function.prototype)?Function.prototype[' + M('toString') + ']:null;');
  parts.push('var _0xF1=(typeof Function!==typeof void 0?Function:null);');
  parts.push('var _0xDP=(typeof Object!==typeof void 0?Object.defineProperty:null);');
  parts.push('var _0xGP=(typeof Object!==typeof void 0?Object.getOwnPropertyDescriptor:null);');
  parts.push('var _0xCA=(typeof Function!==typeof void 0&&Function.prototype?Function.prototype[' + M('call') + ']:null);');
  parts.push('var _0xEV=(typeof eval!==typeof void 0?eval:null);');
  // ---- 反 Hook / 反 Proxy 快照（劫持检测用）----
  // 身份快照能查出"被替换"，查不出"被包装成行为不同的等价物"。所以除了快照，
  // 下面还配了行为探针：同一个函数用两种途径调用结果必须一致，Proxy 的 trap
  // 必须真的触发且取值正确。劫持方要绕过就得同时伪造身份与行为。
  // apply 与 call 是一对，此前只快照了 call；Reflect.apply 又常被用来绕过
  // Function.prototype.apply 上的 hook，三者一并纳入。
  parts.push('var _0xAP=(typeof Function!==typeof void 0&&Function.prototype?Function.prototype[' + M('apply') + ']:null);');
  parts.push('var _0xPX=(typeof Proxy!==typeof void 0?Proxy:null);');
  parts.push('var _0xRF=(typeof Reflect!==typeof void 0?Reflect:null);');
  parts.push('var _0xRG=(typeof Reflect!==typeof void 0&&Reflect[' + M('apply') + ']?Reflect[' + M('apply') + ']:null);');
  // Error.prepareStackTrace 设值陷阱：devtools 协议 attach 时会赋值该属性，
  // 陷阱被摘除即描述符不再是访问器，同样命中。_0xPT 是在位性探测函数，先于
  // 装配定义，复入路径上探测能力不会丢失；探测到陷阱在位就不重装，重装会把
  // 已有的赋值状态清零，还白造一个闭包。
  parts.push('var _0xPT=null;');
  parts.push('try{(function(){if(typeof Error===typeof void 0){return;}' +
    'var _0key=' + M('prepareStackTrace') + ';' +
    'if(typeof Error[_0key]!==typeof void 0){return;}' +
    '_0xPT=function(){try{var _0d=Object.getOwnPropertyDescriptor(Error,_0key);' +
    'return !_0d||typeof _0d.set==="function";}catch(_0e){return true;};};' +
    'if(!_0xPT()){return;}' +
    'var _0sv=undefined;' +
    'Object.defineProperty(Error,_0key,{configurable:true,' +
    'get:function(){return _0sv;},set:function(_0f){_0sv=_0f;_0xdg();}});})();}catch(' + cw + '){}');
  // 投毒键闩锁，defineProperty 访问器形态：falsy 写入被忽略，已置投毒无法
  // 清除，属性非 configurable，delete 也失效，检测命中后不可逆。
  // 复入路径在 arm 已置位时跳过装配：非 configurable 属性上重复 defineProperty
  // 必抛 TypeError，而深层调用栈里抛出加捕获的开销会被每次哨兵复活乘以键数，
  // 实测可占产物总耗时八成以上。初值改为从既有属性读回，即便访问器被环境替换
  // 也不会丢掉已置投毒。
  if (poisonable) {
    for (const k of poisonKeys) {
      parts.push('try{(function(_0k){if(_0xG["' + KEYS.arm + '"]===1){return;}' +
        'var _0v=_0xG[_0k]|0;' +
        'Object.defineProperty(_0xG,_0k,{configurable:false,' +
        'get:function(){return _0v;},set:function(_0x){if(_0x){_0v=_0x===true?1:_0x;}}});})("' + k + '");}catch(' + cw + '){}');
    }
  }
  // 心跳停滞判定与修复额度消耗。额度记在 __r 全局键上，若用头部函数体内的局
  // 部计数器，每次复入都从零开始，等于没有限量。被重建的只是本模块自己的定时
  // 器，不需要跨模块全局计数；隐藏页的定时器节流不会误判为停滞。
  // 心跳值必须原样比较：毫秒时间戳超过 2^31，|0 会把它截成负数，now 减去截断
  // 值恒大于停滞阈值，停滞判定于是永不为假，每次哨兵复入都重装一份定时器且
  // 不清旧的，定时器数量随宿主调用线性增长。
  parts.push('var _0xstale=function(){try{' +
    'if(typeof document!==typeof void 0&&typeof document.visibilityState==="string"&&document.visibilityState==="hidden"){return false;}' +
    'var _0n=' + NOW + ';var _0l=+_0xG["' + KEYS.hb + '"];' +
    'if(_0l>0&&_0n-_0l<' + STALL_MS + '){return false;}' +
    'var _0rc=+_0xG["' + KEYS.rc + '"]|0;' +
    'if(_0rc>=' + REARMS + '){return false;}' +
    '_0xG["' + KEYS.rc + '"]=_0rc+1;_0xhb();return true;' +
    '}catch(' + cw + '){return false;}};');
  // 周期性复查里也带上 hook 探针：身份快照与身份比对在同一个同步块内，预装的
  // hook 拍到的就是它自己，只有"加载之后才被装"的才能靠身份比对抓到——而 DevTools /
  // 运行时插桩恰好就是加载后才装。不挂进周期复查，那三条身份检查等于白写。行为探针
  // 一并挂上，于是 hook 无论何时出现，最迟一个复查周期内必被投毒。
  const hookProbes = hookChecks.join('');
  parts.push('var _0xpd=function(){try{_0xhb();' +
    'if(typeof Function!==typeof void 0&&Function.prototype&&Function.prototype[' + M('toString') + ']!==_0xFP){' +
    (poisonable ? confirmSrc('_0xG') : '_0xdg();') + '}' +
    'if(_0xPT&&!_0xPT()){_0xdg();}' +
    hookProbes +
    '_0xdg();}catch(' + cw + '){}};');
  parts.push('var _0xtd=function(){try{' +
    'var _0xs=new Date();_0xdg();var _0xe=new Date();var _0xdt=_0xe-_0xs;' +
    'if(_0xdt>' + TIME_CONFIRM + '){' + confirmSrc('_0xG') + '}' +
    'if(_0xdt>' + TIME_ALLOW + '){_0xdg();var _0xh=new Date();while(new Date()-_0xh<' + HANG_MS + '){}}' +
    '}catch(' + cw + '){}};');
  parts.push('var _0xwd=function(){try{' +
    'if(_0xSI&&typeof setInterval!==typeof void 0&&setInterval!==_0xSI){_0xdg();}' +
    'if(_0xstale()){_0xclr();_0xarm(_0xpd,' + perPd + ');_0xarm(_0xtd,' + perTd + ');' +
    (extraDebuggers ? '_0xarm(_0xpd,' + perPd2 + ');' : '') +
    '}}catch(' + cw + '){}};');
  // 复入路径，由哨兵复活调用命中。已装配时只查心跳：定时器被 clearInterval
  // 全部清掉（包括看门狗自己）之后，下一次任意用户函数调用即重建。
  parts.push('if(_0xG["' + KEYS.arm + '"]===1||_0armed){_0xwd();return;}');
  parts.push('_0armed=true;try{_0xG["' + KEYS.arm + '"]=1;}catch(_0a){}');
  parts.push('_0xhb();');
  // 启动即时首遍：先做时间差断点，DevTools 已附着时第一条语句即暂停，再跑
  // 入选检测点，随后装配全部定时器。
  parts.push('try{_0xtd();}catch(_0z){}');
  for (const chk of headChecks) parts.push('try{' + chk + '}catch(_0z){}');
  parts.push('_0xclr();');
  parts.push('_0xarm(_0xpd,' + perPd + ');');
  if (extraDebuggers) parts.push('_0xarm(_0xpd,' + perPd2 + ');');
  parts.push('_0xarm(_0xtd,' + perTd + ');');
  parts.push('_0xarm(_0xwd,' + WD_MS + ');');
  if (options.consoleStub) {
    parts.push('if(typeof console!==typeof void 0){var _0cm=["log","info","warn","error","debug","table","trace"];' +
      'for(var _0z=0;_0z<_0cm.length;_0z++){try{console[_0cm[_0z]]=function(){};}catch(' + cw + '){}}}');
  }

  const headFnName = uniqueName(ctx.usedNames, '_0x');
  const headSrc = 'function ' + headFnName + '(){' + parts.join('') + '}' +
    'try{' + headFnName + '();}catch(_0z){}';
  let headStmts = [];
  try {
    headStmts = parse(headSrc, { sourceType: 'script' }).program.body;
  } catch (e) {
    headStmts = [];
  }
  // 头部解析失败时禁用哨兵复活调用，引用未声明名会被自检拒绝
  const headName = headStmts.length ? headFnName : null;

  // 函数体哨兵：抽样注入隐蔽断点、自校验与头部复活调用。
  // 密度抽样按函数独立掷骰，默认约 35% 注入，每份哨兵的阈值、循环形态、检测
  // 点组合与顺序都独立随机，不存在两份完全相同的哨兵。哨兵名全局唯一，_0xdg
  // 是隐蔽触发器引用，由哨兵体自行构造。
  // 检测不通过时不进入无界自旋，而是有界拖慢：在构建期随机时限内持续触发断点
  // 后照常放行。有调试器时长时暂停，无调试器时至多延迟到 HANG 上限毫秒，绝不
  // 死循环。throw 的消息逐份随机生成，不是固定 charCode 列表，特征串全部经
  // m1^m2 掩码重组，产物中不存在可批量定位哨兵的固定字节序列。时间差命中先做
  // 确认计数，与头部共享 __c 键，达到阈值才投毒。
  // 哨兵体首部经 try 调用头部函数，该调用幂等：已装配时只做一次心跳停滞判定
  // 即返回，定时器被清空后借这条路径重建。根部的调用行若被删除，首个哨兵调用
  // 即重建全部头部防护；哨兵体本身在被哈希函数体内，整批删除会触发完整性投毒。
  const SENTINEL_RATE = options.sentinelRate !== undefined ? options.sentinelRate : 0.35;

  const buildSentinelSrc = (name) => {
    const timeAllow = randInt(80, 150);
    const timeConfirm = timeAllow + randInt(350, 650);
    const sizeAllow = randInt(150, 350);
    const hangMs = randInt(400, 1200);
    const loopA = randInt(0, 1) ? 'for(;;)' : 'while(true)';
    const bounded = (body) => 'var _0tb=' + NOW + ';' + loopA + '{' + body + 'if(' + NOW + '-_0tb>' + hangMs + ')break;}';
    const timeCheck = 'if(_0te-_0xt>' + timeAllow + '){' +
      'if(_0te-_0xt>' + timeConfirm + '){' + confirmSrc('_0xg') + '}' +
      bounded('_0xdg();') + '}';
    const hookCheck = 'if(' + IOF('(Function.prototype.toString.toString()+"")', M('native')) + '===-1){' + bounded('_0xdg();') + '}';
    const sizeCheck = 'if(typeof window!==typeof void 0&&(window[' + M('outerWidth') + ']-window[' + M('innerWidth') + ']>' + sizeAllow +
      '||window[' + M('outerHeight') + ']-window[' + M('innerHeight') + ']>' + sizeAllow + ')){_0xdg();}';
    const inspCheck = 'if(typeof process!==typeof void 0&&(' +
      IOF((rt.join ? rt.join + '((typeof process.execArgv!==typeof void 0?process.execArgv:[])," ")' : '(typeof process.execArgv!==typeof void 0?process.execArgv:[]).join(" ")'), M('inspect')) + '>-1' +
      (poisonable ? '||' + IOF('((process.env&&typeof process.env.NODE_OPTIONS==="string")?process.env.NODE_OPTIONS:"")', M('inspect')) + '>-1' : '') +
      ')){' + (poisonable ? '_0xg["' + KEYS.insp + '"]=1;' : '') + '_0xdg();}';
    const tail = [];
    if (rng() < 0.65) tail.push(hookCheck);
    if (rng() < 0.65) tail.push(sizeCheck);
    if (rng() < 0.65) tail.push(inspCheck);
    shuffle(tail);
    // 尾部特征检测按调用窗口抽样。哨兵每次被宿主调用都要重组特征串，M() 会
    // 逐字符取表拼接，还要取原生源码并扫描参数列表，单次约 2~5µs；宿主若是每
    // 元素一次的比较器，实测 10^6 次调用，就把一次性成本乘成秒级，同配置不同
    // 种子实测 0.78s 到 42.6s 的离散即来源于此。
    // 抽样保留首两次必检，静态删除或替换会当场暴露，此后每 N 次一检，N 取
    // 32、64、128 逐份随机。热宿主上 N 次调用只在微秒级流逝，检测时延远小于
    // 人工调试节奏，命中后的有界拖慢与投毒路径完全不变。
    // 计数键 __e 与 __a、__b、__c、__i 同族，纯字符串属性访问不经 var 绑定，
    // mangle 不波及，每哨兵独立计数，首两次按各自调用序成立。
    const sKey = '__e' + randHex(6);
    const sMask = [31, 63, 127][randInt(0, 2)];
    // 时间探针同入抽样窗口。宿主函数被系统调度打断时，_0te 减 _0xt 会越过
    // 80~150ms 的阈值而误判成有人在单步，随即进入 0.4~1.2s 有界拖慢；宿主若
    // 是每元素一次的比较器，10^6 次调用就被放大成分钟级停顿，实测并发负载下
    // 同一构建产物在 0.78s、18s、42s 之间不可复现，正是这条正反馈。
    // 断点语句 _0xdg() 仍在每次调用前执行，附加调试器时即时命中，只是计时、
    // 判定、拖慢与特征扫描按 N 次窗口抽样，首两次必检不变。
    const probe = tail.length
      ? 'var _0xt=new Date();_0xdg();var _0te=new Date();' + timeCheck + tail.join('')
      : 'var _0xt=new Date();_0xdg();var _0te=new Date();' + timeCheck;
    const sampleSrc = 'var _0cs=((_0xg["' + sKey + '"]|0)+1);_0xg["' + sKey + '"]=_0cs;' +
      'if(_0cs<2||(_0cs&0x' + sMask.toString(16) + ')===0){' + probe + '}';
    const msg = randAlpha(randInt(4, 8)) + ':' + randHex(8);
    return [
      headName ? 'try{' + headName + '();}catch(_0q){}' : '',
      'var ' + name + '=(function(_0xw){',
      'try{',
      dbgVarSource('_0xdg'),
      'var _0xg=' + globalRef() + ';',
      '_0xdg();',
      sampleSrc,
      'return true;',
      '}catch(_0e){return false;}',
      '})();',
      'if(' + name + '!==true){throw new Error(' + M(msg) + ');}',
    ].join('');
  };

  const functionPaths = [];
  ctx.traverse(ast, {
    Function(path) {
      // VM 已编译函数整体跳过，契约见 vmBoundary.js。解释器体内的闭包，包括
      // G/S 访问器与片段函数，按字节码步执行，哨兵注入会把一次性成本放大成每
      // 步成本，且解释器体内没有用户语义可保护
      if (insideVmFunction(path)) return;
      // RT 内核引导层跳过整个函数，哨兵成本会按调用频率放大，CCO 是每字符一次
      if (rtlib.isRtFn(ctx, path.node)) return;
      // stringArray 解码器 IIFE 同为高频引导机制层，每次字符串访问都会调用，
      // 内联哨兵每次调用重哈希自身源码的成本被调用频率放大，且机制函数没有用
      // 户语义可保护。stringArray 以 __saMachinery 标记它，用户函数照常注入
      if (path.node.__saMachinery) return;
      const fn = path.node;
      const isArrowExprBody = fn.type === 'ArrowFunctionExpression' &&
        !(fn.body && fn.body.type === 'BlockStatement');
      if (isArrowExprBody) return;
      functionPaths.push(path);
    },
    noScope: true,
  });

  let injectedSentinels = 0;
  for (const path of functionPaths) {
    const bodyNode = path.node.body;
    if (!bodyNode || bodyNode.type !== 'BlockStatement') continue;
    if (rng() > SENTINEL_RATE) continue;
    const uid = uniqueName(ctx.usedNames, '_0x');
    const stmts = (() => {
      try {
        return parse(buildSentinelSrc(uid), { sourceType: 'script' }).program.body;
      } catch (e) {
        return [];
      }
    })();
    if (stmts.length === 0) continue;
    let ins = 0;
    while (ins < bodyNode.body.length && bodyNode.body[ins].type === 'Directive') ins++;
    bodyNode.body.splice(ins, 0, ...stmts);
    injectedSentinels++;
  }

  // 头部函数声明与包装调用注入，按头部注入区协议排在内核与解码器之后
  rtlib.insertHead(ctx, program, headStmts);

  return {
    injected: injectedSentinels,
    head: headStmts.length > 0,
    headFn: headFnName,
    checks: headChecks.length,
    poison: poisonable,
  };
};
