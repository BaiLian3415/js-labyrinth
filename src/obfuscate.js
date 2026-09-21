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
import vm from './passes/vm.js';
import wasm from './passes/wasm.js';
import controlFlow from './passes/controlFlow.js';
import objectKeys from './passes/objectKeys.js';
import numberObf from './passes/numberObf.js';
import templateToConcat from './passes/templateToConcat.js';
import stringArray from './passes/stringArray.js';
import logicalExpr from './passes/logicalExpr.js';
import conditionObf from './passes/conditionObf.js';
import deadCode from './passes/deadCode.js';
import opaquePredicates from './passes/opaquePredicates.js';
import debugProtection from './passes/debugProtection.js';
import functionWrapper from './passes/functionWrapper.js';
import callProxy from './passes/callProxy.js';
import mangle from './passes/mangle.js';
import envFingerprint from './passes/envFingerprint.js';
import integrityCheck from './passes/integrityCheck.js';
import shellWrap from './passes/shell.js';
import platform from './platform.js';
import builtinLower from './ast/builtin-lower.js';
import builtinUpper from './ast/builtin-upper.js';
/**
 * 核心混淆器。输入源码与选项，返回 { code, stats, originalSize, obfuscatedSize }。
 *
 * pass 顺序固定，调顺序前确认依赖：
 *   rtlib → vm → numberObf → controlFlow → objectKeys → templateToConcat → stringArray
 *   → logicalExpr → conditionObf → deadCode → opaquePredicates → debugProtection
 *   → envFingerprint → functionWrapper → callProxy → wasm → mangle → integrityCheck
 *   → selfCheck → generate → shell
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

  const stats = [];

  const timePass = (name, fn) => {
    const t0 = platform.nowMs();
    const r = fn();
    stats.push({ pass: name, result: r, ms: platform.nowMs() - t0 });
    return r;
  };

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

  // 反调试保护
  if (options.debugProtection) applyPass(debugProtection, 'debugProtection');

  if (options.envFingerprint) applyPass(envFingerprint, 'envFingerprint');
  if (options.functionWrapper) timePass('functionWrapper', () => functionWrapper(ast, options, ctx));
  if (options.callProxy) applyPass(callProxy, 'callProxy');
  if (options.wasm) timePass('wasm', () => wasm(ast, options, ctx));
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

  const tShell = platform.nowMs();
  if (options.shell !== false) {
    const progNode = ast.type === 'File' ? ast.program : ast;
    const isModuleSrc = progNode.body.some((s) =>
      s.type === 'ImportDeclaration' || s.type === 'ExportNamedDeclaration' ||
      s.type === 'ExportDefaultDeclaration' || s.type === 'ExportAllDeclaration');
    if (isModuleSrc) {
      stats.push({ pass: 'shell', result: { skipped: 'module' } });
    } else if (usesFreeCommonJs(ast, traverse)) {
      stats.push({ pass: 'shell', result: { skipped: 'commonjs' } });
    } else {
      // 引导器子集：关掉 VM/字符串池/反调试等无法自举的 pass
      const bootOpts = Object.assign({}, options, {
        seed: randInt(1, 1000000000),
        shell: false,
        vmProtection: false, wasm: false,
        stringArray: false,
        debugProtection: false, envFingerprint: false,
        integrityCheck: false, selfCheck: false,
        controlFlowFlattening: true, logicalExpressions: true,
        conditionObfuscation: true, opaquePredicates: true,
        deadCodeInjection: true, objectKeyEncoding: true,
        templateToConcat: true, functionWrapper: true,
        callProxy: true, mangle: true,
      });
      const sr = shellWrap(finalCode, options, (src) => obfuscate(src, bootOpts));
      finalCode = sr.code;
      stats.push({ pass: 'shell', result: { layers: sr.layers } });
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
