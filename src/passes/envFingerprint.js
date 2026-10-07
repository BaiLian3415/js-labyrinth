import t from '../ast/types.js';
import parser from '../ast/parser.js';
const { parse } = parser;
import rand from '../utils/rand.js';
const { randInt, shuffle, uniqueName } = rand;
import hide from '../utils/hide.js';
const { makeDbgHelpers, obfStrExpr } = hide;
import rtlib from './rtlib.js';
/**
 * 环境指纹检测。Program 头部注入一个命名函数声明及其紧随的调用，integrityCheck
 * 的哈希面覆盖这段产物，patch 任一检测点都会改变函数文本，进而哈希失配并毒化全部
 * 字符串。检测面覆盖自动化、无头、调试器驱动、沙箱与被 hook 的环境，命中即触发
 * 隐蔽断点。每个检测点都以 typeof 守卫并各自包 try/catch，Node、测试沙箱、旧浏览
 * 器等缺少对应全局的环境静默跳过，不影响原程序执行。检测点按构建级随机子集抽取并
 * 打乱顺序，针对单次构建归纳出的 NOP 绕过规则到下一次构建即失效。本 pass 由
 * options.envFingerprint 控制，显式传 false 时不注入。
 *
 * 产物不出现 debugger 明文，触发器由 utils/hide 动态构造，用
 * Function(String.fromCharCode(恒等掩码式)) 加 globalThis 随机属性缓存。响应取单点
 * 隐蔽断点而不是死循环：指纹检测存在环境误报的可能，例如内嵌 WebView 与加固容器，
 * 断点在没有调试器时是 no-op，误报零代价。
 */

// 特征串仅在构建期使用，产物中经 m1^m2 掩码恒等式重组，既无明文也无固定
// charCode 序列，按特征 charCode 列表做静态签名的剥离规则随之失效。这里只挑
// WebDriver 标记、无头 UA、窗口全局残留这类跨环境稳定的信号，它们不随版本和
// 页面内容漂移，误报面窄。
const NEEDLES = {
  headless: 'HeadlessChrome',
  phantom: 'PhantomJS',
  swiftshader: 'SwiftShader',
  llvmpipe: 'llvmpipe',
  pluginarray: 'object PluginArray',
  native: 'native code',
  webdriver: 'webdriver',
  callPhantom: 'callPhantom',
  phantomGlobal: '_phantom',
  phantomas: '__phantomas',
  seleniumRecorder: '_Selenium_IDE_Recorder',
  nightmare: '__nightmare',
  seleniumUnwrapped: '__selenium_unwrapped',
  driverEval: '__driver_evaluate',
  webdriverEval: '__webdriver_evaluate',
  fxdriverEval: '__fxdriver_evaluate',
  puppeteer: '__puppeteer',
  playwright: '__playwright',
  nightmareJS: '__nightmareJS',
  domAutomation: 'domAutomation',
  domAutomationController: 'domAutomationController',
  cdcMarker: '$cdc_asdjflasutopfhvcZLmcfl_',
};
// 生成 var 名 = 掩码重组表达式; 形态的 needle 变量声明。rt 可用时经运行时字符表
// 下标重组，产物中没有 String.fromCharCode 调用点。
// 每项含 pre 前置 needle 声明与 cond 检测条件，cond 引用 needle 变量名，命中动作
// 为 _0xdg()，即隐蔽断点触发器调用，不是明文 debugger。
// buildChecks 是惰性工厂。pre 里的 needle 与 raw 声明串经 obfStrExpr 消耗 PRNG，
// 必须在 obfuscate() 调 setSeed 之后构建；放在模块顶层会在 require 期用未 seed 的
// crypto 熵求值并冻结进常量，导致同一 seed 跨进程构建不可复现。
const buildChecks = (rt) => {
  const tbl = rt && rt.tblCall;
  const fcc = rt && rt.fcc;
  const needleDecl = (varName, needle) => 'var ' + varName + '=' + obfStrExpr(NEEDLES[needle], tbl, fcc) + ';';
  const rawDecl = (varName, s) => 'var ' + varName + '=' + obfStrExpr(s, tbl, fcc) + ';';
  const IOF = (s, needle) => rt && rt.iof ? rt.iof + '(' + s + ',' + needle + ')' : '(' + s + ').indexOf(' + needle + ')';
  return [
  { pre: needleDecl('_0xwd', 'webdriver'),
    cond: 'typeof navigator!==typeof void 0&&navigator[_0xwd]===true' },
  { pre: needleDecl('_0xcp', 'callPhantom') +
      needleDecl('_0xpg', 'phantomGlobal') +
      needleDecl('_0xpt2', 'phantomas'),
    cond: 'typeof window!==typeof void 0&&(!!window[_0xcp]||!!window[_0xpg]||!!window[_0xpt2])' },
  { pre: needleDecl('_0xs1', 'seleniumRecorder') +
      needleDecl('_0xs2', 'nightmare') +
      needleDecl('_0xs3', 'seleniumUnwrapped') +
      needleDecl('_0xs4', 'driverEval') +
      needleDecl('_0xs5', 'webdriverEval') +
      needleDecl('_0xs6', 'fxdriverEval'),
    cond: 'typeof window!==typeof void 0&&(!!window[_0xs1]||!!window[_0xs2]||' +
      '!!window[_0xs3]||!!window[_0xs4]||!!window[_0xs5]||!!window[_0xs6])' },
  { pre: needleDecl('_0xp1', 'puppeteer') +
      needleDecl('_0xp2', 'playwright') +
      needleDecl('_0xp3', 'nightmareJS'),
    cond: 'typeof window!==typeof void 0&&(!!window[_0xp1]||!!window[_0xp2]||!!window[_0xp3])' },
  { pre: needleDecl('_0xd1', 'domAutomation') +
      needleDecl('_0xd2', 'domAutomationController'),
    cond: 'typeof document!==typeof void 0&&(!!document[_0xd1]||!!document[_0xd2])' },
  { pre: needleDecl('_0xd3', 'cdcMarker'),
    cond: 'typeof document!==typeof void 0&&!!document[_0xd3]' },
  { pre: needleDecl('_0xhn', 'headless'),
    cond: 'typeof navigator!==typeof void 0&&!!navigator.userAgent&&' + IOF('navigator.userAgent', '_0xhn') + '>-1' },
  { pre: needleDecl('_0xpn', 'phantom'),
    cond: 'typeof navigator!==typeof void 0&&!!navigator.userAgent&&' + IOF('navigator.userAgent', '_0xpn') + '>-1' },
  { pre: '', cond: 'typeof navigator!==typeof void 0&&!!navigator.languages&&navigator.languages.length===0' },
  { pre: '', cond: 'typeof navigator!==typeof void 0&&typeof navigator.plugins!==typeof void 0&&' +
      'typeof window!==typeof void 0&&!!window.chrome===false&&navigator.plugins.length===0' },
  { pre: '', cond: 'typeof process!==typeof void 0&&!!process.versions&&!!process.versions.electron' },
  // Node vm 沙箱与伪造浏览器环境
  // 有 window 却同时暴露 Node process，说明是伪造的浏览器环境，真浏览器从不暴露
  // process，这是自动化沙箱的强信号。无 window 的纯 Node 触发点在没有调试器时是
  // no-op。
  { pre: '', cond: 'typeof process!==typeof void 0&&typeof process.versions!==typeof void 0&&' +
      'typeof process.versions.node!==typeof void 0&&typeof window!==typeof void 0' },
  { pre: '', cond: 'typeof process!==typeof void 0&&typeof process.versions!==typeof void 0&&' +
      'typeof window===typeof void 0&&typeof document===typeof void 0&&typeof navigator===typeof void 0' },
  // stealth 反探测：webdriver 被覆盖成 own 属性
  // 真 Chrome 的 navigator 从不拥有 own 的 webdriver 属性，它在原型链的 getter 上。
  // stealth 插件用 Object.defineProperty(navigator,'webdriver',{get:()=>undefined})
  // 伪造时 hasOwnProperty 会命中，反探测成立。属性名经掩码重组。
  { pre: needleDecl('_0xwd2', 'webdriver'),
    cond: 'typeof navigator!==typeof void 0&&typeof navigator.hasOwnProperty==="function"&&' +
      'navigator.hasOwnProperty(_0xwd2)' },
  // stealth 反探测：navigator.plugins 的类标签被伪造
  { pre: needleDecl('_0xpt', 'pluginarray'),
    cond: 'typeof navigator!==typeof void 0&&typeof navigator.plugins!==typeof void 0&&' +
      'Object.prototype.toString.call(navigator.plugins)!==_0xpt' },
  // Function.prototype.toString 自一致性，防定向 hook
  { pre: rawDecl('_0xnt', NEEDLES.native),
    cond: 'typeof Function!==typeof void 0&&typeof Function.prototype!==typeof void 0&&' +
      'typeof Function.prototype.toString==="function"&&(' +
      IOF('(Function.prototype.toString.call(Function.prototype.toString)+"")', '_0xnt') + '===-1||' +
      IOF('(Function.prototype.toString.toString()+"")', '_0xnt') + '===-1)' },
  // Error 栈被 hook，属性名经掩码重组，产物中无明文指纹
  { pre: rawDecl('_0xps', 'prepareStackTrace'),
    cond: 'typeof Error!==typeof void 0&&typeof Error[_0xps]!==typeof void 0' },
  { pre: rawDecl('_0xsl', 'stackTraceLimit'),
    cond: 'typeof Error!==typeof void 0&&typeof Error[_0xsl]!==typeof void 0&&' +
      'typeof Error[_0xsl]!=="number"' },
  // WebGL 软件渲染器，对应无 GPU 的无头环境
  { pre: rawDecl('_0xsw', NEEDLES.swiftshader) + rawDecl('_0xll', NEEDLES.llvmpipe),
    cond: 'typeof document!==typeof void 0&&typeof document.createElement==="function"&&' +
      '(function(){try{var c=document.createElement("canvas");var gl=c.getContext("webgl")||c.getContext("experimental-webgl");' +
      'if(!gl)return false;var e=gl.getExtension("WEBGL_debug_renderer_info");' +
      'if(!e)return false;var r=gl.getParameter(e.UNMASKED_RENDERER_WEBGL)||"";' +
      'return ' + IOF('r', '_0xsw') + '>-1||' + IOF('r', '_0xll') + '>-1;}catch(_0xe){return false;}})()' },
  ];
};

export default function envFingerprint(ast, options, ctx) {
  if (options.envFingerprint === false) return { checks: 0 };
  const CHECKS = buildChecks(ctx.rt);
  const program = ast.type === 'File' ? ast.program : ast;
  const { varSource: dbgVarSource } = makeDbgHelpers(ctx.rt && ctx.rt.tblCall);

  const order = CHECKS.map((_, i) => i);
  shuffle(order);

  const stmts = [];
  // 隐蔽触发器声明（函数体首行）：命中动作为 _0xdg()
  try {
    stmts.push(...parse(dbgVarSource('_0xdg'), { sourceType: 'script' }).program.body);
  } catch (e) { /* 构造失败则该函数体只做检测不触发，不影响原逻辑 */ }
  for (const idx of order) {
    const chk = CHECKS[idx];
    const src =
      (chk.pre || '') +
      'try{if(' + chk.cond + '){_0xdg();}}catch(_0xe){}';
    const parsed = parse(src, { sourceType: 'script' }).program.body;
    stmts.push(...parsed);
  }

  // console getter 探针，CDP 或 DevTools 打开时 console.log 会求值对象 getter，
  // 仅在浏览器中运行。
  stmts.push(...parse(
    'try{if(typeof console!==typeof void 0&&typeof window!==typeof void 0){' +
    'var _0xg=false;var _0xp={};' +
    'Object.defineProperty(_0xp,"x",{get:function(){_0xg=true;return 1;}});' +
    'console.log(_0xp);if(_0xg){_0xdg();}' +
    '}}catch(_0xe){}',
    { sourceType: 'script' }).program.body);

  // 命名函数声明而不是裸 IIFE，integrityCheck 的哈希面覆盖它。patch 任一检测点都会
  // 改变函数文本，进而哈希失配并毒化，逐点 patch 从局部失效升级为全量毒化。
  const fnName = uniqueName(ctx.usedNames, '_0x');
  const fnDecl = t.functionDeclaration(
    t.identifier(fnName), [],
    t.blockStatement(stmts));
  const callStmt = t.expressionStatement(t.callExpression(t.identifier(fnName), []));

  // 按头部注入区协议排在内核与 stringArray 解码器之后求值，因为它要引用内核
  rtlib.insertHead(ctx, program, [fnDecl, callStmt]);

  return { checks: CHECKS.length, fn: fnName };
};
