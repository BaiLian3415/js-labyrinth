import parser from './ast/parser.js';
const { parse } = parser;
import generate from './ast/generator.js';
import traverse from './ast/traverse.js';
import t from './ast/types.js';
import i18n from './i18n.js';
const { t: msg } = i18n;
import DEFAULTS from './options.js';
import PRESETS from './presets.js';
import randUtil from './utils/rand.js';
const { setSeed, rand, randInt } = randUtil;
import rtlib from './passes/rtlib.js';
import simplify from './passes/simplify.js';
import renameProperties from './passes/renameProperties.js';
import vm from './passes/vm.js';
import wasm from './passes/wasm.js';
import wasmvm from './passes/wasmvm.js';
import controlFlow from './passes/controlFlow.js';
import objectKeys from './passes/objectKeys.js';
import numberObf from './passes/numberObf.js';
import templateToConcat from './passes/templateToConcat.js';
import stringArray from './passes/stringArray.js';
import logicalExpr from './passes/logicalExpr.js';
import conditionObf from './passes/conditionObf.js';
import deadCode from './passes/deadCode.js';
import opaquePredicates from './passes/opaquePredicates.js';
import domainLock from './passes/domainLock.js';
import antiLLM from './passes/antiLLM.js';
import antiCDP from './passes/antiCDP.js';
import debugProtection from './passes/debugProtection.js';
import functionWrapper from './passes/functionWrapper.js';
import callProxy from './passes/callProxy.js';
import mangle from './passes/mangle.js';
import envFingerprint from './passes/envFingerprint.js';
import integrityCheck from './passes/integrityCheck.js';
import shellWrap from './passes/shell.js';
import bannerMod from './passes/banner.js';
import platform from './platform.js';
import builtinLower from './ast/builtin-lower.js';
import builtinUpper from './ast/builtin-upper.js';
/**
 * 核心混淆器。输入源码与选项，返回 { code, stats, originalSize, obfuscatedSize }。
 *
 * pass 顺序固定，调顺序前确认依赖：
 *   rtlib → vm → numberObf → controlFlow → objectKeys → templateToConcat → stringArray
 *   → logicalExpr → conditionObf → deadCode → opaquePredicates → antiCDP
 *   → debugProtection → envFingerprint → functionWrapper → callProxy → wasm
 *   → mangle → integrityCheck → selfCheck → generate → shell
 */

const PRESET_NAMES = Object.keys(PRESETS);

/** 合并选项：DEFAULTS → 预设 → 用户显式选项。preset 键不保留。 */
function resolveOptions(userOptions) {
  const src = userOptions || {};
  const raw = src.preset;
  let preset = null;
  if (raw !== undefined && raw !== null && raw !== '') {
    const name = String(raw).toLowerCase();
    preset = PRESETS[name];
    if (!preset) {
      throw new Error(msg('badPreset', { p: String(raw), names: PRESET_NAMES.join(' | ') }));
    }
  }
  const options = { ...DEFAULTS, ...(preset || {}), ...src };
  delete options.preset;
  return options;
}

/**
 * 混淆后自校验：重爬 AST 作用域找未绑定引用。mangle 直接改节点，漏改会留
 * 下悬空引用。豁免四类：typeof 守卫、内建全局、宿主全局白名单、extraGlobals。
 * hasGlobal() 会把未绑定引用注册进 globals，不能替代静态列表。
 */
const HOST_GLOBALS = new Set(`
  window self global globalThis document navigator location history screen localStorage sessionStorage
  console alert confirm prompt atob btoa fetch XMLHttpRequest WebSocket WebSocketWorker Worker SharedWorker
  setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame
  process require module exports Buffer __dirname __filename performance queueMicrotask
  structuredClone crypto TextEncoder TextDecoder URL URLSearchParams AbortController AbortSignal
  Headers Request Response FormData Blob File Event CustomEvent MessageChannel MessagePort
  postMessage importScripts addEventListener removeEventListener dispatchEvent DOMException
  ReadableStream WritableStream TransformStream ByteLengthQueuingStrategy CountQueuingStrategy
  CompressionStream DecompressionStream WritableStreamDefaultWriter WritableStreamDefaultController
  ReadableStreamDefaultReader ReadableStreamDefaultController TransformStreamDefaultTransformer
  Image Audio HTMLElement documentElement body head title
`.split(/\s+/).filter(Boolean));

// 内建全局，ES builtins 静态列表，不含用户代码产生的名字
const BUILTIN_GLOBALS = new Set([...builtinLower, ...builtinUpper]);

function validateReferences(ast, traverse, options) {
  const extraGlobals = options && Array.isArray(options.extraGlobals) ? options.extraGlobals : [];
  const hostGlobals = extraGlobals.length ? new Set([...HOST_GLOBALS, ...extraGlobals]) : HOST_GLOBALS;
  const problems = [];
  traverse(ast, {
    Program(path) {
      path.scope.crawl();
    },
    ReferencedIdentifier(path) {
      const name = path.node.name;
      if (name === 'undefined' || name === 'arguments') return;
      const parent = path.parentPath;
      // typeof 守卫：typeof 未声明变量是合法用法
      if (parent.isUnaryExpression({ operator: 'typeof' })) return;
      if (path.scope.getBinding(name)) return;
      if (BUILTIN_GLOBALS.has(name) || hostGlobals.has(name)) return;
      const loc = path.node.loc && path.node.loc.start;
      problems.push((loc ? loc.line + ':' + loc.column : '?') + ' ' + name);
    },
  });
  return problems;
}

/** 判断载荷是否自由引用 CommonJS 绑定（require/module/exports/__dirname/__filename）。
 *  套壳经 (0,eval) 在全局求值，全局无这些绑定，故 CommonJS 源跳过套壳。 */
function usesFreeCommonJs(ast, traverse) {
  const CJS_BINDINGS = new Set(['require', 'module', 'exports', '__dirname', '__filename']);
  let found = false;
  traverse(ast, {
    Program(path) {
      path.scope.crawl();
    },
    ReferencedIdentifier(path) {
      if (found) return;
      if (!CJS_BINDINGS.has(path.node.name)) return;
      if (path.scope.getBinding(path.node.name)) return;
      found = true;
      path.stop(); // 首个自由引用就够判定，大 AST 上不必整棵重爬
    },
  });
  return found;
}

function obfuscate(code, userOptions) {
  const options = resolveOptions(userOptions);

  // 前缀不得以数字开头，否则生成名会变成十六进制字面量
  const idp = options.identifierPrefix !== undefined ? options.identifierPrefix : '_0x';
  if (typeof idp !== 'string' || idp === '' || /^[0-9]/.test(idp) || /[^A-Za-z0-9_$\u00aa\u00b5\u00ba\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u02ff]/.test(idp.slice(1))) {
    throw new Error(msg('badIdentifierPrefix', { p: idp }));
  }

  if (options.seed !== undefined) setSeed(options.seed);

  // extraGlobals 归一化为数组
  if (typeof options.extraGlobals === 'string') {
    options.extraGlobals = options.extraGlobals.split(',').map((s) => s.trim()).filter(Boolean);
  } else if (!Array.isArray(options.extraGlobals)) {
    options.extraGlobals = [];
  }

  // domainLock 归一化：字符串（逗号分隔）→ 数组；条目的语法校验在 pass 里做
  if (typeof options.domainLock === 'string') {
    options.domainLock = options.domainLock.split(',').map((s) => s.trim()).filter(Boolean);
  } else if (!Array.isArray(options.domainLock)) {
    options.domainLock = [];
  }

  // reservedNames / reservedStrings 归一化：字符串（逗号分隔）→ 正则文本数组
  for (const key of ['reservedNames', 'reservedStrings']) {
    if (typeof options[key] === 'string') {
      options[key] = options[key].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (!Array.isArray(options[key])) {
      options[key] = [];
    }
  }

  const tParse = platform.nowMs();
  const ast = parse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: false,
    plugins: ['topLevelAwait'],
  });
  const parseMs = platform.nowMs() - tParse;

  const tNames = platform.nowMs();
  const usedNames = new Set();
  traverse(ast, {
    Identifier(path) { usedNames.add(path.node.name); },
    noScope: true,
  });
  const namesMs = platform.nowMs() - tNames;

  const ctx = { traverse, t, usedNames, options, rng: () => rand() };

  // 密钥耦合（P0）。把完整性校验的输出当作字符串池解密密钥的一部分：
  // integrityCheck 在装载期算出「重算哈希 ^ 期望哈希」的偏移和写进一个随机全局
  // 属性，横幅自检再追加它自己的偏移；字符串池首次访问时读这个值当密钥偏移。
  // 代码未被改动时偏移恒为 0，所有耦合式子退化成恒等；改动任一被校验函数或
  // 修改横幅 → 偏移非零 → 整池字符串解码成乱码。
  //
  // 相比原先「解码器读到毒标志再损坏输出」，这里没有可 NOP 的分支：攻击者必须
  // 复原整条链路（哪些函数入哈希、哈希怎么折叠、偏移怎么参与密钥、健康常量是
  // 多少）才能让字符串恢复。删掉校验器同样修不好——读取端读到 undefined，
  // (undefined|0)-OK 得到 -OK，照样非零。
  //
  // 三个角色必须同开同关：池读取端（stringArray）、偏移入端（integrityCheck 的
  // 增量、banner 的绝对健康值）。有人读没人写会让正常产物自己变乱码，所以三处
  // 都读 ctx.couple，缺了即整条链路不启用（低档预设关了 integrityCheck 自动关闭，
  // 产物与改造前逐字节一致）。
  //
  // 横幅必须存在：绝对健康值由横幅自检写入，它是产物里最早执行的代码，也只有
  // 它能保证"字符串池第一次访问之前载体已有有效值"。跳过横幅（bannerSkip）时
  // 没人写这个值，读取端会算出 -OK，等于自己把自己打成乱码，因此一并关闭。
  if (options.integrityCheck !== false && options.bannerSkip !== true) {
    ctx.couple = {
      // 健康载体名：随机全局属性，存「健康常量 + 累计偏移」
      name: '__c' + randInt(0x10000000, 0x7fffffff).toString(16) + randInt(0x1000, 0xffff).toString(16),
      // 健康常量。必须是奇数且 < 2^31，读取端做 (值|0)-OK 求偏移，得 0 才算健康
      ok: randInt(0x100000, 0x7fffff) * 2 + 1,
    };
  }

  const stats = [];

  const timePass = (name, fn) => {
    const t0 = platform.nowMs();
    const r = fn();
    stats.push({ pass: name, result: r, ms: platform.nowMs() - t0 });
    return r;
  };

  // AST 简化（simplify）：常量折叠 / 死代码消除 / 空语句清除 / 声明合并。
  // 必须在 rtlib 之前、任何注入发生之前跑，此时 AST 只有用户代码。
  if (options.simplify) timePass('simplify', () => simplify(ast, options, ctx));

  // 属性名重命名（renameProperties，safe 模式）：同样在最前，只作用于用户代码。
  // 必须在 objectKeys / stringArray 之前：那时属性名还是干净的 Identifier /
  // StringLiteral，还没被改写成计算键 + 字符串池形态
  if (options.renameProperties) timePass('renameProperties', () => renameProperties(ast, options, ctx));

  if (options.rtlib !== false) timePass('rtlib', () => rtlib(ast, options, ctx));

  const applyPass = (fn, name) => {
    const r = timePass(name, () => fn(ast, options, ctx));
    // 中间产物转储。写入实现由宿主注册（Node 侧见 cli.js），核心不碰文件系统
    if (platform.env('DSH_DUMP_PASSES')) {
      try {
        const dumped = generate({ type: 'File', program: ast.program }, { compact: true });
        platform.dumpPass(name, typeof dumped === 'string' ? dumped : dumped.code);
      } catch (e) { /* 转储失败不影响构建 */ }
    }
    return r;
  };

  // 虚拟机保护，最先跑。函数体编译成自研栈式字节码，配函数体内解释器。
  // 已编译的函数登记进 compiledSet，controlFlow 遇到会跳过。
  if (options.vmProtection) applyPass(vm, 'vm');

  // 数值常量混淆。排在 vm 之后：已编译函数的常量在字节码里，不在 AST 上；
  // 排在 controlFlow 之前，状态机的分派常量由扁平化自己生成，不参与本变换
  if (options.numberObfuscation !== false) applyPass(numberObf, 'numberObf');

  // 控制流扁平化
  if (options.controlFlowFlattening) applyPass(controlFlow, 'controlFlow');

  // 对象键编码
  if (options.objectKeyEncoding) applyPass(objectKeys, 'objectKeys');

  // 模板串降级，先拆开，片段才能进 stringArray
  if (options.templateToConcat) applyPass(templateToConcat, 'templateToConcat');

  // 字符串数组
  if (options.stringArray) applyPass(stringArray, 'stringArray');

  // 逻辑表达式混淆
  if (options.logicalExpressions) applyPass(logicalExpr, 'logicalExpr');

  // 条件表达式混淆，比较运算符等价取反
  if (options.conditionObfuscation) applyPass(conditionObf, 'conditionObf');

  // 死代码注入
  if (options.deadCodeInjection) applyPass(deadCode, 'deadCode');

  // 不透明谓词注入，用恒真谓词包裹真实语句
  if (options.opaquePredicates) applyPass(opaquePredicates, 'opaquePredicates');

  // 域名锁定（P5 第二项）。排在 stringArray 之后：降级形态要读它登记的毒药键；
  // 排在 integrityCheck 之前：注入的根级函数声明要进完整性哈希面。pass 内部
  // 走早带注入（rtlib.insertHeadEarly），授权贡献在任何字符串池访问之前落位
  if (options.domainLock && options.domainLock.length) applyPass(domainLock, 'domainLock');

  // Anti-LLM 加固：误导性注记 + 伪业务分支。排在 stringArray 之前，
  // 注入的字符串字面量随后会被收进池里加密，不额外留下明文
  if (options.antiLLM) applyPass(antiLLM, 'antiLLM');

  // Anti-CDP：CDP / 自动化框架检测。必须先于 debugProtection 注入：头部执行
  // 顺序等于 pass 调用顺序，原生 console 引用要在反调试的 consoleStub 之前捕获
  if (options.antiCDP) applyPass(antiCDP, 'antiCDP');

  // 反调试保护
  if (options.debugProtection) applyPass(debugProtection, 'debugProtection');

  if (options.envFingerprint) applyPass(envFingerprint, 'envFingerprint');
  if (options.functionWrapper) timePass('functionWrapper', () => functionWrapper(ast, options, ctx));
  if (options.callProxy) applyPass(callProxy, 'callProxy');
  // WASM 解释器内核档与旧 wasm 档互斥：内核档把解释器整体搬进 WASM，旧档只搬
  // 数据与原语，两者同时开会生成两个模块与两套取指假设，故内核档优先。
  if (options.wasmInterpreter) timePass('wasmvm', () => wasmvm(ast, options, ctx));
  else if (options.wasm) timePass('wasm', () => wasm(ast, options, ctx));
  if (options.mangle) timePass('mangle', () => mangle(ast, options, ctx));
  if (options.integrityCheck) timePass('integrityCheck', () => integrityCheck(ast, options, ctx));

  if (options.selfCheck !== false) {
    const problems = validateReferences(ast, traverse, options);
    if (problems.length > 0) {
      const shown = problems.slice(0, 10);
      throw new Error(msg('selfCheckFailed', {
        n: problems.length,
        shown: shown.join('\n'),
        more: problems.length > 10 ? msg('selfCheckMore') : '',
      }));
    }
  }

  const tGen = platform.nowMs();
  const out = generate(ast, {
    compact: options.compact !== false,
    escapeNonAscii: !!options.escapeNonAscii,
    indent: options.indent !== undefined ? options.indent : 2,
  });
  const generateMs = platform.nowMs() - tGen;

  let finalCode = out.code;

  // 载荷形态判定：ESM 不套 eval 外壳，CJS 用带形参的直接 eval 放行
  const progNode = ast.type === 'File' ? ast.program : ast;
  const isModuleSrc = progNode.body.some((s) =>
    s.type === 'ImportDeclaration' || s.type === 'ExportNamedDeclaration' ||
    s.type === 'ExportDefaultDeclaration' || s.type === 'ExportAllDeclaration');
  const payloadCjs = !isModuleSrc && usesFreeCommonJs(ast, traverse);

  const tShell = platform.nowMs();
  if (options.shell !== false) {
    if (isModuleSrc) {
      stats.push({ pass: 'shell', result: { skipped: 'module' } });
    } else {
      const cjs = payloadCjs;
      // 引导器子集：关掉 VM/字符串池/反调试等无法自举的 pass
      const bootOpts = Object.assign({}, options, {
        seed: randInt(1, 1000000000),
        shell: false,
        vmProtection: false, wasm: false,
        stringArray: false,
        debugProtection: false, envFingerprint: false,
        antiCDP: false,
        integrityCheck: false, selfCheck: false,
        // 域名锁定只锁载荷：外壳引导层自身不注入（payload 里的校验已经
        // 覆盖整个产物，重复注入只会让引导代码在非授权域先崩在半路）
        domainLock: [],
        // simplify 同样只作用于载荷：引导层代码本就精简，不重复压缩
        simplify: false,
        controlFlowFlattening: true, logicalExpressions: true,
        conditionObfuscation: true, opaquePredicates: true,
        deadCodeInjection: true, objectKeyEncoding: true,
        templateToConcat: true, functionWrapper: true,
        callProxy: true, mangle: true,
      });
      const sr = shellWrap(finalCode, options, (src) => obfuscate(src, bootOpts), cjs);
      finalCode = sr.code;
      stats.push({
        pass: 'shell',
        result: { layers: sr.layers, cjs, form: options.shellForm === 'jsfuck' ? 'jsfuck' : 'classic', jsfuckChars: sr.jsfuckChars },
      });
    }
  }
  const shellMs = platform.nowMs() - tShell;

  stats.unshift({ pass: '·parse', result: { bytes: code.length }, ms: parseMs });
  stats.splice(1, 0, { pass: '·collectNames', result: { names: usedNames.size }, ms: namesMs });
  stats.push({ pass: '·generate', result: { bytes: out.code.length }, ms: generateMs });
  if (options.shell !== false) {
    const shellEntry = stats.find((s) => s.pass === 'shell');
    if (shellEntry) shellEntry.ms = shellMs;
    else stats.push({ pass: '·shell', result: { skipped: 'off' }, ms: shellMs });
  }

  // ---- 文件头横幅：默认写混淆器信息与作者名，付费档可自定义；与密钥流互锁 ----
  if (options.bannerSkip !== true) {
    const bn = bannerMod.sanitizeBanner(options.bannerText);
    if (!bn.ok) {
      if (bn.reason === 'long') throw new Error(msg('bannerTooLong', { max: 2000, n: bn.n }));
      throw new Error(msg('badBannerText', { p: String(options.bannerText).slice(0, 24) }));
    }
    const bw = bannerMod.wrapBanner(finalCode, {
      text: bn.text,
      cjs: payloadCjs,
      // 只有套了外壳的载荷才用盐互锁；ESM 或显式 shell:false 时只做守卫
      wrap: !isModuleSrc && options.shell !== false,
      // 横幅层是最外层，也是最显眼的一层：壳形式必须一路传到它这里，
      // 否则 jsfuck 产物只有内层是 JSFuck、外包一层 classic 引导
      shellForm: options.shellForm,
      poisonKey: progNode.__poisonKey,
      ctx,
    });
    finalCode = bw.code;
    stats.push({ pass: 'banner', result: { custom: bw.custom, salt: bw.salt } });
  }

  // hashbang 必须晚于套壳（eval 里出现 #! 会 SyntaxError）
  if (ast.shebang) finalCode = ast.shebang + '\n' + finalCode;

  const result = {
    code: finalCode,
    stats,
    originalSize: code.length,
    obfuscatedSize: finalCode.length,
  };

  return result;
}

export default { obfuscate, resolveOptions, DEFAULTS, PRESETS, PRESET_NAMES };
