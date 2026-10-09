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
import { isChineseNaming, wantsPropertyRename } from './utils/naming.js';
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
import htmleJs from './passes/htmleJs.js';
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
import esmFold from './passes/esmFold.js';
import callProxy from './passes/callProxy.js';
import mangle from './passes/mangle.js';
import envFingerprint from './passes/envFingerprint.js';
import integrityCheck from './passes/integrityCheck.js';
import shellWrap from './passes/shell.js';
import bannerMod from './passes/banner.js';
import platform from './platform.js';
import {
  resolveTarget, forbiddenShapes, isClockFrozen, profileOf,
} from './target-runtime.js';
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

/**
 * 保留名在生成期的字面形态判定器：命中的文本原样写出，不做 \uXXXX 转义。
 *
 * 为什么需要它：四个预设都开 escapeNonAscii，它会把非 ASCII 一律转义——包括用户
 * 要求保留的名字。名字确实没被改名（排除是生效的），但产物里写成
 * \u8ba4\u8bc1\u4ee4\u724c，用户按中文 grep 一个字都搜不到，只能判断"勾了没效果"。
 * 显式保留优先于通用转义开关，命中就把原文写出来。
 *
 *
 * 名单为空时返回 null：默认路径零开销、产物逐字节不变。
 *
 * @param {object} options 归一化之后的选项
 * @returns {((text:string)=>boolean)|null}
 */
function buildKeepRaw(options) {
  const exact = new Set();
  const res = [];
  for (const key of ['reservedNames', 'reservedStrings']) {
    for (const s of options[key] || []) {
      try { res.push(new RegExp(s)); } catch (e) { /* 非法正则：各处一致忽略 */ }
    }
  }
  if (!res.length) return null;
  return (text) => res.some((re) => re.test(text));
}

/**
 * 判断源码是不是 ESM。三类依据，缺一不可：
 *
 * 1. import/export 声明。够用但不完整。
 * 2. 顶层 await。eval 与 Function 里都非法（"await is only valid in async
 *    functions"），壳必须走 import()。
 * 3. 动态 import()。它是 CallExpression 的 callee，不是 ImportDeclaration，
 *    只看声明会漏。
 *
 * 顶层 await 有两种 AST 形态：自研 parser 对它产出
 * UnaryExpression{operator:'await'}，Babel 惯例是 AwaitExpression。两个都要认。
 *
 * 必须在解析后、任何 pass 之前调用，见 obfuscate.js 里 sourceIsModule 的注释。
 *
 * @param {object} ast 刚 parse 出来的 AST
 * @param {Function} traverse 自研遍历器
 * @returns {boolean} true 表示要按 ESM 处理
 */
function detectModuleSource(ast, traverse) {
  const prog = ast.type === 'File' ? ast.program : ast;
  if (prog.body.some((s) =>
    s.type === 'ImportDeclaration' || s.type === 'ExportNamedDeclaration' ||
    s.type === 'ExportDefaultDeclaration' || s.type === 'ExportAllDeclaration')) {
    return true;
  }
  let topLevelAwait = false;
  let dynamicImport = false;
  let metaProperty = false;
  traverse(ast, {
    // 只看顶层：函数体内的 await/import() 由那个函数自己的模块语义管，
    // 不构成整个文件是 ESM 的证据。
    Function(path) { path.skip(); },
    AwaitExpression() { topLevelAwait = true; },
    UnaryExpression(path) {
      if (path.node.operator === 'await') topLevelAwait = true;
    },
    Import() { dynamicImport = true; },
    // import.meta / new.target 里的 import.meta 形态：MetaProperty 的 meta 名
    // 是 Identifier 'import'。它在经典脚本里直接抛 "Cannot use 'import.meta'
    // outside a module"，壳必须走 import()。
    MetaProperty(path) {
      const m = path.node.meta;
      if (m && m.type === 'Identifier' && m.name === 'import') metaProperty = true;
    },
    noScope: true,
  });
  return topLevelAwait || dynamicImport || metaProperty;
}

/**
 * 把 ESM 载荷里的相对模块说明符改写成绝对 URL。
 *
 * 套壳后载荷经 blob:/data: URL 加载，这两种 URL 没有目录上下文，`./x.js` 必然
 * 解析失败（data: 报 "Failed to resolve module specifier"）。运行期无法补救——
 * URL 在 import() 调用前就定型了——所以只能在构建期改。
 *
 * 覆盖 import/export 声明与 import()/export() 的动态说明符。裸说明符（'fs'、
 * 'node:path'）不动，它们由解析器自己解析，与 base 无关。
 *
 * @param {object} ast 载荷 AST（原地改写 source.value）
 * @param {Function} traverse 自研遍历器
 * @param {string} base 基准 URL 或路径，形如 'file:///D:/app/' 或 'https://h/app/'
 * @returns {{rewritten:string[], skipped:string[]}} 改写与未能改写的说明符
 */
function absolutizeModuleSpecifiers(ast, traverse, base) {
  const rewritten = [];
  const skipped = [];
  const toAbsolute = (spec) => {
    if (typeof spec !== 'string' || spec === '') return null;
    // 裸说明符、协议相对（//host/x）、绝对 URL 都不需要改
    if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
    try {
      return new URL(spec, base).href;
    } catch (e) {
      return null;
    }
  };
  const handle = (node) => {
    if (!node) return;
    const abs = toAbsolute(node.value);
    if (abs === null) {
      if (typeof node.value === 'string' &&
          (node.value.startsWith('./') || node.value.startsWith('../'))) {
        skipped.push(node.value);
      }
      return;
    }
    rewritten.push(node.value + ' -> ' + abs);
    node.value = abs;
    node.raw = JSON.stringify(abs);
  };
  traverse(ast, {
    ImportDeclaration(path) { handle(path.node.source); },
    ExportNamedDeclaration(path) { handle(path.node.source); },
    ExportAllDeclaration(path) { handle(path.node.source); },
    // 动态 import(x) / export(x) 的说明符是第一个实参
    CallExpression(path) {
      const c = path.node.callee;
      const isDynamic = c && (c.type === 'Import' ||
        (c.type === 'Identifier' && c.name === 'export'));
      if (isDynamic) handle(path.node.arguments && path.node.arguments[0]);
    },
    noScope: true,
  });
  return { rewritten, skipped };
}

/**
 * 收集载荷里所有相对模块说明符（只读，不改写）。
 *
 * 用于「没有 moduleBase、改写没做」时点名提醒：这类说明符在套壳后必然加载失败
 * （blob:/data: URL 没有目录上下文），属于产物坏了，必须说出来而不是静默发出去。
 *
 * @param {object} ast 载荷 AST
 * @param {Function} traverse 自研遍历器
 * @returns {string[]} 去重后的相对说明符
 */
function collectRelativeSpecifiers(ast, traverse) {
  const out = new Set();
  const add = (node) => {
    const v = node && node.value;
    if (typeof v !== 'string') return;
    if (v.startsWith('./') || v.startsWith('../')) out.add(v);
  };
  traverse(ast, {
    ImportDeclaration(path) { add(path.node.source); },
    ExportNamedDeclaration(path) { add(path.node.source); },
    ExportAllDeclaration(path) { add(path.node.source); },
    CallExpression(path) {
      const c = path.node.callee;
      if (c && (c.type === 'Import' ||
          (c.type === 'Identifier' && c.name === 'export'))) {
        add(path.node.arguments && path.node.arguments[0]);
      }
    },
    noScope: true,
  });
  return [...out];
}

/**
 * 收集产物里真实保留下来（未被改名）的绑定名，用于壳外明文清单。
 *
 * 取的是 AST 里的具体名字，不是用户写的正则：用户填 `^myPublic`，产物里出现的是
 * `myPublicApi` 这个标识符，清单里要写的就是后者，用户 grep 才命中。
 *
 * @param {object} ast 产物 AST
 * @param {Function} traverse 自研遍历器
 * @param {object} options 含 reservedNames（正则文本数组）
 * @returns {string[]} 去重后的名字
 */
function collectKeptNames(ast, traverse, options) {
  const patterns = compileKeepPatterns(options.reservedNames);
  if (patterns.length === 0) return [];
  const out = new Set();
  traverse(ast, {
    Identifier(path) {
      const n = path.node.name;
      for (const re of patterns) if (re.test(n)) { out.add(n); return; }
    },
    noScope: true,
  });
  return [...out];
}

/**
 * 收集产物里真实保留下来（未进字符串池）的字符串字面量，用于壳外明文清单。
 *
 * @param {object} ast 产物 AST
 * @param {Function} traverse 自研遍历器
 * @param {object} options 含 reservedStrings（正则文本数组）
 * @returns {string[]} 去重后的字面量值
 */
function collectKeptStrings(ast, traverse, options) {
  const patterns = compileKeepPatterns(options.reservedStrings);
  if (patterns.length === 0) return [];
  const out = new Set();
  traverse(ast, {
    StringLiteral(path) {
      const v = path.node.value;
      if (typeof v !== 'string' || v === '') return;
      for (const re of patterns) if (re.test(v)) { out.add(v); return; }
    },
    noScope: true,
  });
  return [...out];
}

/** 把保留名单里的正则文本编译成 RegExp；非法项忽略（与 mangle 侧口径一致）。 */
function compileKeepPatterns(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list) {
    try { out.push(new RegExp(s)); } catch (e) { /* 非法正则：各处一致忽略 */ }
  }
  return out;
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

  // 载荷是不是 ESM，在解析完的当场就定下来。
  //
  // 不能等到套壳前再判（2026-10-02 踩过）：那时 AST 已经被十几个 pass 改过，
  // 顶层 await 会被 functionWrapper 之类裹进函数、或被条件改写掉，顶层 import
  // 也可能已经被搬走。实测 `const v = await f(); g(v)` 在 medium/max 下判出来
  // 是脚本，于是壳走了 eval 路径，产物加载即抛
  // "await is only valid in async functions"——而报错点在密文里，用户无从定位。
  // 解析后的 AST 还没被任何 pass 碰过，是唯一可靠的判定时机。
  const sourceIsModule = detectModuleSource(ast, traverse);

  // 目标运行时定档与「禁用什么」的处理。必须在任何 pass 之前——壳与 wasm 都是
  // 靠选项开关生效的，等它们跑完再想关就来不及了。
  //
  // 为什么不能默默关：这些形态在受限宿主里是**抛错**级别的（workerd 禁用 eval 与
  // new Function、只允许部署期静态 import）。默默关掉等于用户以为保护着、实际没有；
  // 更糟的是今天的状态——根本不关，于是 Worker 用户拿到一份 434 KB、部署即抛的产物。
  // 所以两条一起做：关掉 + 在 warnings 里点名说清关了什么、为什么。
  const target = resolveTarget(options.target, code);
  const forbidden = forbiddenShapes(target);
  const suppressedByTarget = [];
  if (forbidden.some((f) => f.key === 'runtimeEval') && options.shell) {
    options.shell = false;
    suppressedByTarget.push('shell');
  }
  if (forbidden.some((f) => f.key === 'wasmFromBuffer')) {
    // 两个 wasm 档都从 buffer 编译，一律关。内核档也一样：它把字节码搬进模块，
    // 模块仍是 buffer 编译出来的。
    if (options.wasm) { options.wasm = false; suppressedByTarget.push('wasm'); }
    if (options.wasmInterpreter) { options.wasmInterpreter = false; suppressedByTarget.push('wasmInterpreter'); }
  }
  // 时钟冻结：基于 Date.now() 差值的哨兵会**静默失效**（差值恒 0，阈值永不成立）。
  // 不是崩溃，是保护悄悄消失，所以也要点名。
  const clockFrozen = isClockFrozen(target);
  if (clockFrozen) {
    if (options.debugProtection) { options.debugProtection = false; suppressedByTarget.push('debugProtection'); }
    if (options.antiCDP) { options.antiCDP = false; suppressedByTarget.push('antiCDP'); }
  }

  const tNames = platform.nowMs();
  const usedNames = new Set();
  traverse(ast, {
    Identifier(path) { usedNames.add(path.node.name); },
    noScope: true,
  });
  const namesMs = platform.nowMs() - tNames;

  // sourceIsModule 挂在 ctx 上给 functionWrapper 用：它在流水线中段执行，那时 AST
  // 已被前面的 pass 改过，现场扫描会把 ESM 误判成脚本（见 functionWrapper 的注释）。
  const ctx = { traverse, t, usedNames, options, sourceIsModule, rng: () => rand() };
  // 保留名在生成期的字面形态。归一化之后就能建，挂 ctx 给主生成与
  // integrityCheck 的自哈希共用——两处必须用同一份，否则构建期哈希算的是
  // \uXXXX 形态、运行期读到的是原文，完整性校验必然假失配、把干净产物投毒。
  ctx.keepRaw = buildKeepRaw(options);

  // 密钥耦合（P0）。把完整性校验的输出当作字符串池解密密钥的一部分：
  // integrityCheck 在装载期算出「重算哈希 ^ 期望哈希」的偏移和写进一个随机全局
  // 属性，引导层先写入绝对健康值（见 passes/banner.js），域名锁定再按 +Q 补回；
  // 字符串池首次访问时读这个值当密钥偏移。代码未被改动时偏移恒为 0，所有耦合式
  // 退化成恒等；改动任一被校验函数（或引导层里的锚点字面量）→ 偏移非零 →
  // 整池字符串解码成乱码。
  //
  // 相比原先「解码器读到毒标志再损坏输出」，这里没有可 NOP 的分支：攻击者必须
  // 复原整条链路（哪些函数入哈希、哈希怎么折叠、偏移怎么参与密钥、健康常量是
  // 多少）才能让字符串恢复。删掉校验器同样修不好——读取端读到 undefined，
  // (undefined|0)-OK 得到 -OK，照样非零。
  //
  // 三个角色必须同开同关：池读取端（stringArray）、偏移入端（integrityCheck 的
  // 增量、引导层的绝对健康值）。有人读没人写会让正常产物自己变乱码，所以三处
  // 都读 ctx.couple，缺了即整条链路不启用（低档预设关了 integrityCheck 自动关闭，
  // 产物与改造前逐字节一致）。
  //
  // 引导层必须存在：绝对健康值由它写入，它是产物里最早执行的代码（在外壳与载荷
  // 之前），也只有它能保证"字符串池第一次访问之前载体已有有效值"。跳过引导
  // （bannerSkip）时没人写这个值，读取端会算出 -OK，等于自己把自己打成乱码，
  // 因此一并关闭。
  if (options.integrityCheck !== false && options.bannerSkip !== true) {
    ctx.couple = {
      // 健康载体名：随机全局属性，存「健康常量 + 累计偏移」
      name: '__c' + randInt(0x10000000, 0x7fffffff).toString(16) + randInt(0x1000, 0xffff).toString(16),
      // 健康常量。必须是奇数且 < 2^31，读取端做 (值|0)-OK 求偏移，得 0 才算健康
      ok: randInt(0x100000, 0x7fffff) * 2 + 1,
    };
  }

  const stats = [];
  // 构建期警示（不阻断流程，但要传到界面/CLI）。目前只有一条：外壳与不混淆名单
  // 互锁时点名跳过原因，避免用户以为名单没生效。
  const warnings = [];

  // 目标受限导致的降级：逐项点名，别让用户以为保护着。这里必须**说清关了什么、
  // 为什么**，否则用户只会看到"我的保护怎么没了"，而真正的原因（宿主不支持）
  // 是最有价值的那部分信息。
  if (suppressedByTarget.length > 0) {
    const why = forbidden.map((f) => f.why);
    const clockWhy = '该宿主的 Date.now()/performance.now() 不随代码执行推进，基于时间差值的哨兵会静默失效';
    warnings.push(msg('warnTargetSuppressed', {
      target: profileOf(target).display,
      list: suppressedByTarget.join(', '),
      why: Array.from(new Set([...why, ...(clockFrozen ? [clockWhy] : [])])).join('；'),
    }));
  }

  const timePass = (name, fn) => {
    const t0 = platform.nowMs();
    const r = fn();
    stats.push({ pass: name, result: r, ms: platform.nowMs() - t0 });
    return r;
  };

  // AST 简化（simplify）：常量折叠 / 死代码消除 / 空语句清除 / 声明合并。
  // 必须在 rtlib 之前、任何注入发生之前跑，此时 AST 只有用户代码。
  if (options.simplify) timePass('simplify', () => simplify(ast, options, ctx));

  // 属性名重命名（safe 模式）：同样在最前，只作用于用户代码。
  // 必须在 objectKeys / stringArray 之前：那时属性名还是干净的 Identifier /
  // StringLiteral，还没被改写成计算键 + 字符串池形态。
  // 开不开由 nameStyle 的档位决定（带 `-props` 后缀那几档），不再是独立开关——
  // 判定在 utils/naming.js，与 renameProperties pass 内那处同源。
  if (wantsPropertyRename(options)) timePass('renameProperties', () => renameProperties(ast, options, ctx));

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

  // ESM 模块折叠（esmFold）：静态 import/export 与顶层绑定是 ESM 载荷上最强的
  // 结构指纹。整模块改写成「TLA 赋值 + 出口名」，模块体进同步 IIFE（有顶层
  // await 时直接进 async IIFE），import 绑定改写为命名空间属性访问。必须在 VM
  // pass 之前跑：同步内层由此参与字节码编译，顶层控制流一并从静态视图消失。
  if (options.esmFold === true && sourceIsModule) applyPass(esmFold, 'esmFold');

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

  // HTMLE（JS 侧）：把嵌在 JS 里的 HTML 字面量加密成密文 + 注入解码器。
  //
  // 必须排在 templateToConcat 与 stringArray 之前，两个原因：
  //   - stringArray 会把字符串字面量收进池并换成池访问调用，本 pass 就认不出 HTML 了；
  //   - templateToConcat 会把模板拆成 `"a"+x+"b"`，插值模板的片段边界也就没了。
  // 排在它俩前面，模板还保持原样，片段边界完整。
  if (options.htmle) applyPass(htmleJs, 'htmleJs');

  // 模板串降级，先拆开，片段才能进 stringArray
  if (options.templateToConcat) applyPass(templateToConcat, 'templateToConcat');

  // ESM 相对说明符改写。必须排在 stringArray **之前**：那个 pass 会把所有字符串
  // 字面量搬进加密池，源节点上的 value 就被换成了访问器调用，届时再改写已经找不到
  // 说明符了（2026-10-02 实测：改写排在 stringArray 之后时，动态 import 的相对
  // 说明符仍是 "./dep2.mjs"，产物加载即失败）。
  //
  // 原因：壳把载荷塞进 blob:/data: URL 再 import()，这两种 URL 没有目录上下文，
  // `./dep.mjs` 无从解析（data: 报 "Failed to resolve module specifier"）。运行期
  // 补不了——URL 在 import() 调用前就定型了——只能构建期改。
  let esmSpecifiers = null;
  if (sourceIsModule && options.moduleBase) {
    esmSpecifiers = absolutizeModuleSpecifiers(ast, traverse, options.moduleBase);
  }

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
  // ---- domainLock 与 WASM 档互锁（2026-09-27 实测发现）----
  //
  // 两者不兼容，且是旧实现里就存在的潜在问题：wasm 档会把未被函数或导出引用的
  // 顶层语句搬进它合成的 main()，而 domainLock 的授权贡献（+Q）靠 insertHeadEarly
  // 落在头部、必须在任何字符串池访问之前执行。搬进 main() 后时序全变，实测授权
  // 主机上产物直接抛错（不是腐蚀，是 THREW）。显式关掉 wasm 即恢复正常，所以
  // 失败确实由 wasm 引入。
  //
  // 平时碰不到它，是因为 domainLock 是用户显式选项、四个预设里默认关；但 wasm
  // 恢复默认开启后，任何 plus+ 用户开域名锁定就会踩到，所以这里必须互锁。
  //
  // 方向选择：关 wasm，保 domainLock。domainLock 是用户显式选定的安全功能，
  // 悄悄把它降级是 fail-open；wasm 是防护/优化层，关掉产物照样正确。这与项目既有
  // 取舍一致——宁可少一层保护，也不拿自损坏的产物换覆盖率。
  const dlRequested = Array.isArray(options.domainLock) && options.domainLock.length > 0;
  if (dlRequested) {
    if (options.wasm || options.wasmInterpreter) {
      ctx.wasmDisabledByDomainLock = true;
      options.wasm = false;
      options.wasmInterpreter = false;
    }
  }
  // WASM 解释器内核档与旧 wasm 档互斥：内核档把解释器整体搬进 WASM，旧档只搬
  // 数据与原语，两者同时开会生成两个模块与两套取指假设，故内核档优先。
  // WASM 解释器内核档与旧 wasm 档互斥：内核档把解释器整体搬进 WASM，旧档只搬
  // 数据与原语，两者同时开会生成两个模块与两套取指假设，故内核档优先。
  //
  // ===================== 阶段二「嵌套 VM」设计（2026-09-28 修订两次）=====================
  //
  // 目标：让外层轻量 JS VM（L2）包住内层 WASM 主解释器（L3），使上面那条互锁不再必要。
  //
  // ============================== 结论：前提不成立，不做 ==============================
  //
  // 两次修订都不是"还没写完"，是逐层往下挖之后发现这件事的前提是空的。
  //
  // ---- 第一次修订（2026-09-27 那版计划）错在哪 ----
  //
  // 那版写的是「第①步：L2 字节码集加一条 CALLW，跑通 L2 调 L3」。L2 当时并不存在：
  // rtgen.js 生成的只有值语义层 / 桥接层 / 加载链三部分，JS 侧没有任何取指循环
  // （扫 for/while 读 B[]/pc 的模式，零命中）。当时只有一台 VM——WASM 内核。
  // 更要紧的是：就算造出来了，只装一条 CALLW 的 L2 也没有防护价值——它的全部工作
  // 就是「走一个字 → 解密 → 写进 WASM 内存 → 交棒」，一眼就能认出是 memcpy 包装。
  //
  // ---- 第二次修订：把"价值从哪来"算清楚之后，答案是 0 ----
  //
  // L2 唯一可能的收益是「让静态产物里看不到程序字节码」。那就得问：现在看得到吗？
  //
  //   · 部署形态（vercel.json → buildCommand = build:web:cloud）：受保护模块与加密层
  //     完全不进 dist，混淆在服务端跑。README 自己写了两条：产物里没有混淆核心
  //     与 cloudOnly=true「两者必须对上」；以及这一层「比『加密后公开』更靠前」。
  //     也就是说核心压根不下发给客户端，L2 要保护的对象在产物里不存在。
  //   · 自建形态（build:web 不带 --cloud）：核心在 dist 里，但同一份产物里。
  //     把 code segment 从 WASM data 段搬到 L2 的载荷，只是从产物的一个位置挪到
  //     另一个位置——同一份文件、同一个访问者、同样的静态分析。防护增量为零。
  //
  // 换句话说：L2 要挣回成本，指令集必须真的在解释逻辑（那是阶段 B）；而阶段 B 改的
  // 是"多少函数由 L2 解释"——可对部署形态来说，全部函数都在服务端，客户端连字节码
  // 都拿不到；对自建形态来说，产物里本来就有全部字节码，挪位置不解决问题。
  //
  // ---- 假如将来真要做，前提是部署形态先变 ----
  //
  // 只有一个条件能让阶段二变得有意义：产品形态改成把混淆核心下发给客户端
  // （离线本地执行、或把 wasmvm 当作可分发的加固 SDK 卖）。那时"客户端拿到了核心"
  // 才成立，L2 才有东西可护。届时的起点不是"造 L2"，而是先定：
  //   · 哪些函数归 L2 vs L3（切分只能落在函数粒度上——pc/链值/掩码/槽位只在
  //     WASM 内存里，L2 无法在函数执行中途接管）；
  //   · 句柄表归属：现状本来就在宿主侧（rtgen 的 tab/fre/fr 都是 JS 数组，装真值），
  //     这条已自动满足，不需要改；
  //   · 异常回传用带标签的返回值，不让异常穿越 WASM 边界（各宿主对 WASM 抛出的处理
  //     不一，且会打断 L2 的栈一致性）。
  //
  // 下面的实测记录留着：它推翻了原计划的切分粒度假设，即使将来形态变了仍然适用。
  //
  // ---- 实测：切分只能落在函数粒度（2026-09-28）----
  //
  // 状态分布（wasmvm.js 内存布局 + rtgen.js 值语义层）：
  //   JS 侧    句柄表 tab / 空闲表 fre / 帧表栈 fr —— 普通 JS 数组，装的是真值
  //   WASM 侧  字节码、pt/argslot/semtab、槽位、值栈（mv 是 WASM 内存的 Int32Array
  //            视图）、pc、链值、逐帧随机重掩的掩码
  // 所以「L2 解释一段指令、在控制流处交棒」在本架构下不成立——那需要把 pc/链值/
  // 掩码/槽位暴露到 WASM 之外，等于把内核最要紧的部分拆出来。
  //
  // ---- 另一条被高估的担忧 ----
  //
  // 曾担心"code segment 移出 data 段后 ANCHOR/探针覆盖不到"。实测不必担心：prb(i) 是
  // 从 WASM 内存的 PRB 处读探针表（wasmvm.js 里 `splitConst(PRB) + i` 与 `+1` 两次
  // i32Load），宿主侧比对的是自己那份 probeVal。L2 写入内存之后再校验，等于校验的是
  // 实际落地的运行态，比校验静态快照更强。真正要处理的是另一件事：探针对
  // （probeIdx/probeVal）目前以明文成对放在 data 段（L205 `put(idx); put(val)`），
  // 它们由 codeWords 派生，code 移出而探针留下就等于泄漏。
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

  // 相对说明符没被改写 = 产物运行期必然加载失败。不静默：点名提醒，并说清补救。
  if (sourceIsModule && !esmSpecifiers) {
    const rel = collectRelativeSpecifiers(ast, traverse);
    if (rel.length > 0) {
      warnings.push(msg('warnEsmRelative', {
        n: rel.length,
        shown: rel.slice(0, 5).join(', '),
      }));
    }
  }

  const tGen = platform.nowMs();
  const out = generate(ast, {
    compact: options.compact !== false,
    escapeNonAscii: !!options.escapeNonAscii,
    // 中文命名时汉字不转义，见 generator 的 _escapeIdent。
    // 这里传的是归一化后的 nameStyle，不是布尔项——2026-10-01 之前是 chineseNames。
    // 若继续传一个已不存在的字段，generator 侧的 isChineseNaming 恒为 false，
    // 汉字会被 escapeNonAscii 全转成 \uXXXX：产物能跑但用户 grep 不到，且
    // integrityCheck 两边口径一漂就会被自己的完整性校验投毒。
    chineseNames: isChineseNaming(options),
    indent: options.indent !== undefined ? options.indent : 2,
    // 命中「保留名单」的文本原样写出（不做 \uXXXX 转义），详见 buildKeepRaw
    keepRaw: ctx.keepRaw,
  });
  const generateMs = platform.nowMs() - tGen;

  let finalCode = out.code;

  // 载荷形态：ESM 走 import() 放行的独立壳，CJS 用带形参的直接 eval 放行。
  // isModuleSrc 用解析期定下的 sourceIsModule，不用此时的 AST —— 此刻的 AST 已被
  // pass 改过，顶层 await/import 可能已经不在顶层了，判错会让产物直接抛错。
  const progNode = ast.type === 'File' ? ast.program : ast;
  const isModuleSrc = sourceIsModule;
  const payloadCjs = !isModuleSrc && usesFreeCommonJs(ast, traverse);

  const tShell = platform.nowMs();
  // ---- 保留名单与外壳层：从「二选一」改成「名单项明文留在壳外」----
  //
  // 原设计（2026-09-29）：名单非空就整个关掉外壳。理由是外壳把产物当字节流加密，
  // 被保留的名字即便在载荷内部一字未改，产物文本里也搜不到。实测 medium/high/max
  // 三档下设了保留名的产物里连一个名字都找不到，用户看到的正是「勾了还是混淆了」。
  //
  // 现在的做法：照常套壳（全量加密，防护不降），名单项在壳外另存明文清单供 grep。
  const keepRequested = ['reservedNames', 'reservedStrings']
    .some((k) => Array.isArray(options[k]) && options[k].length > 0);
  // 名单明文清单的内容：从 AST 里取真实存在、且确实没被改写的项。正则本身不能直接
  // 写进清单——用户写的是 ^myPublic 这样的模式，产物里出现的是 myPublicApi 这个
  // 具体名字，grep 模式匹配不到。
  const keepNames = keepRequested ? collectKeptNames(ast, traverse, options) : [];
  const keepStrings = keepRequested ? collectKeptStrings(ast, traverse, options) : [];
  if (options.shell !== false) {
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
      // moduleBase 必须清空。引导层源码里没有真的模块说明符，唯一的字符串是那段
      // base64 载荷——它以 "./" 或 "../" 开头时会（极小概率）被当成相对说明符改写成
      // 绝对地址，载荷当场损坏，产物静默不执行。2026-10-02 实测：shellDepth=2 且填了
      // moduleBase 时载荷永不运行，depth=1 正常——正是内层引导层被改坏。
      moduleBase: '',
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
    const sr = shellWrap(finalCode, options, (src) => obfuscate(src, bootOpts), cjs, isModuleSrc);
    finalCode = sr.code;
    stats.push({
      pass: 'shell',
      result: {
        layers: sr.layers,
        cjs,
        esm: isModuleSrc,
        form: options.shellForm === 'jsfuck' ? 'jsfuck' : 'classic',
        jsfuckChars: sr.jsfuckChars,
      },
    });
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

  // ---- 引导层：健康载体（字符串池密钥耦合）+ 盐（与外壳密钥流互锁）----
  //
  // 2026-09-30 起不再写 `/*! … */` 文件头注释：署名、反 LLM 声明与"删掉提示就坏"
  // 这条威慑一起去掉（用户要求）。互锁本身没有丢——比对锚点从注释正文换成引导内部
  // 的随机字面量，盐由它重算；删掉引导同样是坏产物（saltVar 未定义 + 载体缺失）。
  // 详见 passes/banner.js 的文件头注释。
  if (options.bannerSkip !== true) {
    const bw = bannerMod.guardLayer(finalCode, {
      cjs: payloadCjs,
      esm: isModuleSrc,
      // 壳外明文清单：载荷整段加密后，产物里能 grep 到的保留项全靠它
      keepNames,
      keepStrings,
      // 套了外壳的载荷才用盐互锁；显式 shell:false 时只做引导（没有外壳层密钥可互锁）。
      // ESM 现在也走完整外壳（mode.esm），所以这里不再按 isModuleSrc 排除。
      wrap: options.shell !== false,
      // 引导层在最外层：壳形式必须一路传到它这里，
      // 否则 jsfuck 产物只有内层是 JSFuck、外包一层 classic 引导
      shellForm: options.shellForm,
      poisonKey: progNode.__poisonKey,
      ctx,
    });
    finalCode = bw.code;
    stats.push({ pass: 'guard', result: { salt: bw.salt, wrapped: bw.wrapped } });
  }

  // HTMLE（JS 侧）的解码器：源码级前插，放在引导层之后、载荷之前。
  //
  // 为什么不在 pass 里就地往 AST 顶部插变量：那样子树会跟着 mangle 一起被改名，而这里
  // 前插的是已生成的源码字符串、不经过 AST，两边会对不上。所以走和 guardLayer 一样
  // 的路子：pass 把解码器源码挂在 ctx 上，这里统一前插。注入名已登记 ctx.keepNames，
  // mangle 不会碰它。
  //
  // 位置必须在 selfCheck 之后：前插的是源码、AST 里没有对应声明，此刻再跑绑定检查
  // 会把解码器的调用点判成「未绑定引用」而误报失败（pass 内已把它登记进
  // options.extraGlobals 供 validateReferences 放行，两处缺一不可）。
  if (ctx.htmleJsSource) {
    finalCode = ctx.htmleJsSource + '\n' + finalCode;
    stats.push({ pass: '·htmleJs', result: ctx.htmleJs });
  }

  // hashbang 必须晚于套壳（eval 里出现 #! 会 SyntaxError）
  if (ast.shebang) finalCode = ast.shebang + '\n' + finalCode;

  const result = {
    code: finalCode,
    stats,
    warnings,
    originalSize: code.length,
    obfuscatedSize: finalCode.length,
  };

  return result;
}

export default { obfuscate, resolveOptions, DEFAULTS, PRESETS, PRESET_NAMES };
