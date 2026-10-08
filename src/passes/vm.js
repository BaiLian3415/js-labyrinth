/**
 * Pass 0 虚拟机保护。把符合条件的函数体编译成自定义栈式字节码，由注入函数体的
 * 解释器循环 for(;;){ switch(B[pc++]) { case N: ...; break; } } 执行，控制流在
 * 静态视图下消失，控制流还原与符号执行这类常规反混淆无法直接还原。
 *
 * 每个函数生成 var V=[],G=[getter],H=[setter],K=[常量],B=[字节码],S=[],pc=0，
 * 未被捕获的参数拷进 V 槽位后进入解释器。V 是未被嵌套函数或片段捕获的局部槽位，
 * G/H 是名字 getter/setter 闭包，覆盖 this、外层名、捕获的局部名与全局名，运行期
 * 按词法解析回原函数，this 与 arguments 因此可以透传；K 是常量池，装字面量与片段
 * 闭包 ()=>{ return expr; }。B 是纯数字字节码，操作码编号逐函数随机置换，每个存储
 * 字按「值 ^ 位置散列 ^ 当前掩码」加密，取指做同一逆运算；每次调用入口推进掩码并
 * 整体原位重写 B，调用期间内存中的字节码与源码字面量不同，尾部另有永不取指的垃圾字。
 *
 * 编译范围：表达式片段（正则、模板串、对象与类字面量、函数表达式、可选链、spread
 * 调用、解构赋值目标等）与语句片段（for-in/for-of）整体降级为常量池闭包，求值时机
 * 与次数保持与源一致；逃逸到嵌套函数或片段里的局部名保留为真实 var，经 G/H 闭包
 * 读写，闭包链不断。生成器、含 yield/super/new.target 的表达式、私有名成员、
 * 直接 eval 调用、try/switch/labeled/with/class 声明、for-in/of 子树内含 return 或
 * 函数声明或 var 解构，这些一律放弃编译，函数体保持原样。
 * async 函数默认同样放弃编译；开启异步执行器（vmAsyncExecutor）后会被纳入，只要它的
 * 每个 await 都落在「编译后仍在 async 函数体内」的位置（判定见 awaitSafe），并把分发
 * 形态限制成内联形态 A/C。
 *
 * 执行护栏（原嵌套内层档可信内核的能力，已并入本解释器）：
 * 指令步数上限（vmStepLimit，0 关闭）与操作数栈深度上限，超限抛错而不是静默挂死。
 * 内层档撤销的原因与边界：只认 int32 子集（任意 JS 值会静默算错）、手写第二份内核
 * 维护成本高、性价比实测不成立——同一批特性以「解释器内闸门」形态保留，regress 不退。
 *
 * 本 pass 最先执行。已编译函数经 isVMCompiled() 登记，controlFlow 据此跳过，解释器
 * 不宜再被状态机包裹；B/K 内的数字与字符串随后仍由 stringArray 正常混淆。
 */
import t from '../ast/types.js';
import parser from '../ast/parser.js';
const { parse } = parser;
import rtlib from './rtlib.js';
import rand from '../utils/rand.js';
const { shuffle, uniqueName, randInt } = rand;
import morph from '../utils/morph.js';
import i18n from '../i18n.js';
const { t: msg } = i18n;
import platform from '../platform.js';

// 已编译函数登记，controlFlow 据此跳过
const compiledSet = new WeakSet();
function isVMCompiled(fn) {
  return compiledSet.has(fn);
}

// xorshift32 的 keyState 兜底常量。
//
// 原先写死 0x9e3779b9，那是公开的"黄金比例哈希常数"——扫字面量即可定位到本类
// 实现。这里逐构建换一个：它**不是算法规范参数**，只是"取到 0 时换个非零值"，
// 唯一约束是非零（0 是 xorshift32 的不动点）。
//
// 每次调用给一个不同的值，但同一次构建内必须处处相同——调用点通过
// ctx.__vmKeyFallback 缓存第一次的结果（构建期派生与运行期注入是两处代码）。
function vmKeyFallback() {
  let v;
  do {
    // 取一个高斯位数的奇数：xorshift32 在偶数或低熵初值下推进质量会下降。
    v = (randInt(0x10000000, 0x7fffffff) << 1) | 1;
  } while (v === 0);
  return v >>> 0;
}

// 片段判定。分析走法与编译走法共用同一实现

function hasSpread(list) {
  if (!list) return false;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e && e.type === 'SpreadElement') return true;
  }
  return false;
}

/** 表达式需整体降级为片段闭包 ()=>{ return expr; } 时返回 true。 */
function isFragmentExpr(node) {
  if (!node || typeof node.type !== 'string') return false;
  switch (node.type) {
    case 'RegExpLiteral': return true;        // 每次求值都新建对象，lastIndex 状态彼此隔离
    case 'TemplateLiteral':
    case 'TaggedTemplateExpression': return true;
    case 'ObjectExpression': return true;     // 每次求值都新建对象，含方法或 computed 键
    case 'ClassExpression': return true;
    case 'FunctionExpression':
    case 'ArrowFunctionExpression': return true; // 每次求值都生成新闭包
    case 'OptionalMemberExpression':
    case 'OptionalCallExpression': return true;
    case 'Import': return true;               // 动态 import 不能当值传递
    case 'BigIntLiteral': return true;
    case 'UnaryExpression':
      // typeof 未声明变量不能先求值，delete 的目标不是值
      return node.operator === 'delete' ||
        (node.operator === 'typeof' && node.argument.type === 'Identifier');
    case 'CallExpression':
      return hasSpread(node.arguments) || node.callee.type === 'Import' ||
        isFragmentExpr(node.callee);
    case 'NewExpression': return hasSpread(node.arguments);
    case 'ArrayExpression': return hasSpread(node.elements);
    case 'AssignmentExpression':
      // 解构赋值目标（模式）
      return node.left.type !== 'Identifier' && node.left.type !== 'MemberExpression';
    case 'UpdateExpression':
      // 成员目标自增在栈机上表述复杂，整体降级为片段
      return node.argument.type !== 'Identifier';
    default: return false;
  }
}

// 通用遍历小工具

const META_KEYS = new Set([
  'loc', 'start', 'end', 'extra', 'range',
  'leadingComments', 'trailingComments', 'innerComments', 'comments',
]);

function eachChild(node, cb) {
  for (const key in node) {
    if (META_KEYS.has(key)) continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) if (v[i] && typeof v[i] === 'object') cb(v[i]);
    } else if (v && typeof v === 'object') {
      cb(v);
    }
  }
}

/** 收集子树全部标识符名，ThisExpression 记为 'this'。多收无害。 */
function collectAllIdentifiers(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) collectAllIdentifiers(node[i], out);
    return;
  }
  if (typeof node.type !== 'string') return;
  if (node.type === 'Identifier') { out.add(node.name); return; }
  if (node.type === 'ThisExpression') { out.add('this'); return; }
  eachChild(node, (child) => collectAllIdentifiers(child, out));
}

/** 子树扫描，不进入函数体内部，函数声明节点本身会上报。 */
function scanSubtree(root, seen) {
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i]);
      return;
    }
    if (typeof node.type !== 'string') return;
    seen(node);
    if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression' ||
        node.type === 'FunctionDeclaration' || node.type === 'ClassMethod' ||
        node.type === 'ObjectMethod') return;
    eachChild(node, walk);
  })(root);
}

/** 整个子树含全部嵌套函数体内是否存在直接 eval 调用。 */
function hasDirectEval(root) {
  let found = false;
  (function walk(node) {
    if (found || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node.type !== 'string') return;
    if (node.type === 'CallExpression' && node.callee &&
        node.callee.type === 'Identifier' && node.callee.name === 'eval') {
      found = true;
      return;
    }
    eachChild(node, walk);
  })(root);
  return found;
}

function addPatternNames(node, out) {
  if (!node) return;
  if (node.type === 'Identifier') { out.add(node.name); return; }
  const ids = t.getBindingIdentifiers(node);
  for (const name in ids) out.add(name);
}

// 区域走法，按语句树加 isFragmentExpr 切分，逃逸分析用

function regionExprIdentifiers(node, out) {
  if (!node) return;
  if (isFragmentExpr(node)) { collectAllIdentifiers(node, out); return; }
  eachChild(node, (child) => regionExprIdentifiers(child, out));
}

function regionVarInitIdentifiers(declNode, out) {
  for (const d of declNode.declarations) {
    if (d.id && d.id.type !== 'Identifier') {
      // 解构声明整体转 EXEC 片段，绑定名与 init 内被读取的名字都要捕获
      collectAllIdentifiers(d.id, out);
      if (d.init) collectAllIdentifiers(d.init, out);
      continue;
    }
    if (d.init) regionExprIdentifiers(d.init, out);
  }
}

function regionStmtIdentifiers(node, out) {
  if (!node) return;
  switch (node.type) {
    case 'ExpressionStatement': regionExprIdentifiers(node.expression, out); break;
    case 'VariableDeclaration': regionVarInitIdentifiers(node, out); break;
    case 'FunctionDeclaration': collectAllIdentifiers(node, out); break; // 整体转片段处理
    case 'ReturnStatement':
    case 'ThrowStatement': regionExprIdentifiers(node.argument, out); break;
    case 'IfStatement':
      regionExprIdentifiers(node.test, out);
      regionStmtIdentifiers(node.consequent, out);
      regionStmtIdentifiers(node.alternate, out);
      break;
    case 'WhileStatement':
      regionExprIdentifiers(node.test, out);
      regionStmtIdentifiers(node.body, out);
      break;
    case 'DoWhileStatement':
      regionStmtIdentifiers(node.body, out);
      regionExprIdentifiers(node.test, out);
      break;
    case 'ForStatement':
      if (node.init) {
        if (node.init.type === 'VariableDeclaration') regionVarInitIdentifiers(node.init, out);
        else regionExprIdentifiers(node.init, out);
      }
      regionExprIdentifiers(node.test, out);
      regionExprIdentifiers(node.update, out);
      regionStmtIdentifiers(node.body, out);
      break;
    case 'ForInStatement':
    case 'ForOfStatement': collectAllIdentifiers(node, out); break; // 整体转 EXEC 片段处理
    case 'BlockStatement':
      for (const s of node.body) regionStmtIdentifiers(s, out);
      break;
    default: break; // Empty 与 Debugger 不产生标识符
  }
}

// canCompile 整函数可编译判定，判定方向保守，宁可不编译

function exprOk(node) {
  if (!node) return true;
  if (isFragmentExpr(node)) return true;
  switch (node.type) {
    case 'Identifier':
    case 'ThisExpression':
    case 'NumericLiteral':
    case 'StringLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral': return true;
    case 'UnaryExpression': return exprOk(node.argument);
    case 'UpdateExpression': return true; // 非 Identifier 目标已由片段判定接走
    case 'BinaryExpression': return exprOk(node.left) && exprOk(node.right);
    case 'LogicalExpression': return exprOk(node.left) && exprOk(node.right);
    case 'ConditionalExpression':
      return exprOk(node.test) && exprOk(node.consequent) && exprOk(node.alternate);
    case 'SequenceExpression': return node.expressions.every(exprOk);
    case 'MemberExpression':
      return node.property.type !== 'PrivateName' &&
        exprOk(node.object) && (!node.computed || exprOk(node.property));
    case 'CallExpression': return exprOk(node.callee) && node.arguments.every(exprOk);
    case 'NewExpression': return exprOk(node.callee) && node.arguments.every(exprOk);
    case 'ArrayExpression': return node.elements.every((e) => !e || exprOk(e));
    case 'AssignmentExpression': {
      const l = node.left;
      if (l.type === 'Identifier') return exprOk(node.right);
      if (l.type === 'MemberExpression') {
        return exprOk(node.right) && exprOk(l.object) && (!l.computed || exprOk(l.property));
      }
      return false; // 模式目标应由片段判定接走
    }
    default:
      // Await、Yield、Super、MetaProperty 以及未知节点一律拒绝
      return false;
  }
}

function regionOk(node) {
  if (!node) return true;
  switch (node.type) {
    case 'ExpressionStatement': return exprOk(node.expression);
    case 'VariableDeclaration':
      return node.declarations.every((d) =>
        (d.id.type === 'Identifier' || d.id.type === 'ObjectPattern' ||
          d.id.type === 'ArrayPattern') && (!d.init || exprOk(d.init)));
    case 'FunctionDeclaration': return true; // 整体降级为片段
    case 'ReturnStatement': return exprOk(node.argument);
    case 'ThrowStatement': return exprOk(node.argument);
    case 'IfStatement':
      return exprOk(node.test) && regionOk(node.consequent) && regionOk(node.alternate);
    case 'WhileStatement': return exprOk(node.test) && regionOk(node.body);
    case 'DoWhileStatement': return regionOk(node.body) && exprOk(node.test);
    case 'ForStatement':
      return (!node.init ||
        (node.init.type === 'VariableDeclaration' ? regionOk(node.init) : exprOk(node.init))) &&
        exprOk(node.test) && exprOk(node.update) && regionOk(node.body);
    case 'ForInStatement':
    case 'ForOfStatement': {
      if (node.type === 'ForOfStatement' && node.await) return false;
      let ok = true;
      scanSubtree(node, (n) => {
        // EXEC 片段内的 return 会错误退出 thunk，函数声明的提升语义会被破坏，
        // var 解构又无法在片段化之前完成重写
        if (n.type === 'ReturnStatement' || n.type === 'FunctionDeclaration') ok = false;
        if (n.type === 'VariableDeclaration' && n.kind === 'var') {
          for (const d of n.declarations) if (d.id.type !== 'Identifier') ok = false;
        }
      });
      return ok;
    }
    case 'BlockStatement': return node.body.every(regionOk);
    case 'EmptyStatement':
    case 'DebuggerStatement': return true; // debugger 丢弃，无语义影响
    default:
      // Try、Switch、Labeled、With、ClassDeclaration 等一律拒绝整函数
      return false;
  }
}

// async 函数的 await 位置判定（Async Executor）
//
// 背景：解释器循环本身就写在被编译函数的函数体里，所以只要那个函数是 async，动作体里
// 的 `await` 就会把整个解释器挂起、Promise settle 后再从下一条指令继续——挂起与恢复
// 是 JS 引擎的能力，不需要把解释器改成状态机。但有一个必须挡住的前提：await 不能
// 出现在编译后会被搬进非 async 闭包的位置，否则产物是语法错误。会被搬进闭包的
// 位置有三类，判定与它们一一对应：
//   ① 片段表达式（isFragmentExpr 命中的那些）：统一写成 ()=>{ return expr; }，
//      这个箭头不是 async，里面不能有 await。
//   ② for-in / for-of 与解构声明：整体转 EXEC 片段 ()=>{ ... }，同样是非 async 箭头。
//   ③ 非 async 的嵌套函数：它自己的体不是 async，里面不可能有合法 await。
//      但 async 的嵌套函数是安全的：它保持 async，await 是它自己的挂起语义。
// 判定方向保守：拿不准就返回 false，函数整函数保持原样不编译（绝不产出坏产物）。
const AWAIT_FN_TYPES = new Set([
  'FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration',
  'ClassMethod', 'ObjectMethod',
]);

/**
 * 判断子树里的 await 是否都落在「编译后仍在 async 函数体内」的位置。
 * @param node - 待判定节点
 * @param inFrag - 当前是否已经处在会被搬进非 async 闭包的位置里
 * @returns {boolean} 全部安全返回 true
 */
function awaitSafe(node, inFrag) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return true;
  if (AWAIT_FN_TYPES.has(node.type)) {
    // async 函数自成作用域：await 归它自己挂起，安全；非 async 函数体内出现 await
    // 一律判不安全（进到这里说明它整个体会被原样搬走）
    return node.async ? true : awaitSafe(node.body, true);
  }
  const frag = inFrag || isFragmentExpr(node);
  if ((node.type === 'UnaryExpression' && node.operator === 'await') ||
      node.type === 'AwaitExpression') return !frag;
  let ok = true;
  eachChild(node, (c) => { if (!awaitSafe(c, frag)) ok = false; });
  return ok;
}

/** 语句级 await 位置判定，按各语句的落地形态分派。 */
function awaitStmtOk(s) {
  if (!s) return true;
  switch (s.type) {
    case 'BlockStatement': return s.body.every(awaitStmtOk);
    case 'IfStatement':
      return awaitSafe(s.test, false) && awaitStmtOk(s.consequent) && awaitStmtOk(s.alternate);
    case 'WhileStatement': return awaitSafe(s.test, false) && awaitStmtOk(s.body);
    case 'DoWhileStatement': return awaitStmtOk(s.body) && awaitSafe(s.test, false);
    case 'ForStatement':
      return (!s.init || (s.init.type === 'VariableDeclaration' ? awaitDeclOk(s.init) : awaitSafe(s.init, false)))
        && awaitSafe(s.test, false) && awaitSafe(s.update, false) && awaitStmtOk(s.body);
    case 'VariableDeclaration': return awaitDeclOk(s);
    case 'ExpressionStatement': return awaitSafe(s.expression, false);
    case 'ReturnStatement':
    case 'ThrowStatement': return awaitSafe(s.argument, false);
    // 整体降级为 EXEC 片段的语句：整棵子树按「在非 async 闭包里」判定
    case 'ForInStatement':
    case 'ForOfStatement': return awaitSafe(s, true);
    case 'FunctionDeclaration': return true; // 独立函数，它的 await 归它自己的判定
    case 'EmptyStatement':
    case 'DebuggerStatement':
    case 'BreakStatement':
    case 'ContinueStatement': return true;
    default: return false; // 其余语句 regionOk 已经拒绝，这里保守
  }
}

/** 声明级判定：只有标识符名是内联求值，模式声明整个 init 会进 EXEC 片段。 */
function awaitDeclOk(node) {
  return node.declarations.every((d) => (d.id.type === 'Identifier'
    ? awaitSafe(d.init, false)
    : awaitSafe(d.id, true) && awaitSafe(d.init, true)));
}

function canCompile(fn, allowAsync) {
  if (!fn || fn.generator) return false;
  if (fn.async) {
    // 异步执行器（vmAsyncExecutor）关闭时行为与改动前一致：async 函数一律不编译
    if (!allowAsync) return false;
    if (!fn.body || fn.body.type !== 'BlockStatement') return false;
    if (!fn.body.body.every(awaitStmtOk)) return false;
  }
  const body = fn.body;
  if (!body || body.type !== 'BlockStatement') return false;
  if (!body.body.length) return false;
  if (hasDirectEval(body)) return false;
  return body.body.every(regionOk);
}

// 局部名收集，含参数与区域声明，覆盖 for-in/of 提升与嵌套 for-in 绑定

function collectLoopBodyVars(node, locals) {
  if (!node) return;
  switch (node.type) {
    case 'VariableDeclaration':
      if (node.kind === 'var') {
        for (const d of node.declarations) addPatternNames(d.id, locals);
      }
      break;
    case 'BlockStatement':
      for (const s of node.body) collectLoopBodyVars(s, locals);
      break;
    case 'IfStatement':
      collectLoopBodyVars(node.consequent, locals);
      collectLoopBodyVars(node.alternate, locals);
      break;
    case 'WhileStatement':
    case 'DoWhileStatement':
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
      if (node.type === 'ForStatement' && node.init && node.init.type === 'VariableDeclaration') {
        for (const d of node.init.declarations) addPatternNames(d.id, locals);
      }
      if ((node.type === 'ForInStatement' || node.type === 'ForOfStatement') &&
          node.left && node.left.type === 'VariableDeclaration') {
        addPatternNames(node.left.declarations[0].id, locals);
      }
      collectLoopBodyVars(node.body, locals);
      break;
    default: break;
  }
}

function collectLocalsFromStmt(node, locals) {
  if (!node) return;
  switch (node.type) {
    case 'VariableDeclaration':
      for (const d of node.declarations) addPatternNames(d.id, locals);
      break;
    case 'FunctionDeclaration':
      if (node.id) locals.add(node.id.name);
      break;
    case 'IfStatement':
      collectLocalsFromStmt(node.consequent, locals);
      collectLocalsFromStmt(node.alternate, locals);
      break;
    case 'WhileStatement':
    case 'DoWhileStatement':
      collectLocalsFromStmt(node.body, locals);
      break;
    case 'ForStatement':
      if (node.init && node.init.type === 'VariableDeclaration') {
        for (const d of node.init.declarations) addPatternNames(d.id, locals);
      }
      collectLocalsFromStmt(node.body, locals);
      break;
    case 'ForInStatement':
    case 'ForOfStatement': {
      const L = node.left;
      if (L.type === 'VariableDeclaration') addPatternNames(L.declarations[0].id, locals);
      else if (L.type === 'Identifier') locals.add(L.name);
      else if (L.type !== 'MemberExpression') addPatternNames(L, locals);
      collectLocalsFromStmt(node.body, locals);
      collectLoopBodyVars(node.body, locals);
      break;
    }
    case 'BlockStatement':
      for (const s of node.body) collectLocalsFromStmt(s, locals);
      break;
    default: break;
  }
}

function collectLocals(fn) {
  const locals = new Set();
  for (const p of fn.params) addPatternNames(p, locals);
  for (const s of fn.body.body) collectLocalsFromStmt(s, locals);
  return locals;
}

// 逃逸分析。出现在嵌套函数或片段内的局部名保留为真实 var

function collectCaptured(fn, locals) {
  const fragNames = new Set();
  for (const s of fn.body.body) regionStmtIdentifiers(s, fragNames);
  const captured = new Set();
  for (const name of fragNames) if (locals.has(name)) captured.add(name);
  return captured;
}

// 区域加权计数，供阈值判定。语句计 1 分，片段表达式计 1 分。
// 语句少但含大量字面量或片段的函数，比如只负责组装返回值的，也是 VMP 的有效目标。

function exprWeight(node) {
  if (!node) return 0;
  if (isFragmentExpr(node)) return 1; // 每个片段闭包都占一个常量池条目
  let w = 0;
  eachChild(node, (child) => { w += exprWeight(child); });
  return w;
}

function countRegionStmts(node) {
  if (!node) return 0;
  switch (node.type) {
    case 'IfStatement':
      return 1 + exprWeight(node.test) + countRegionStmts(node.consequent) + countRegionStmts(node.alternate);
    case 'WhileStatement':
      return 1 + exprWeight(node.test) + countRegionStmts(node.body);
    case 'DoWhileStatement':
      return 1 + exprWeight(node.test) + countRegionStmts(node.body);
    case 'ForStatement':
      return 1 + exprWeight(node.init) + exprWeight(node.test) + exprWeight(node.update) + countRegionStmts(node.body);
    case 'ForInStatement':
    case 'ForOfStatement':
      return 1 + exprWeight(node.right) + countRegionStmts(node.body);
    case 'BlockStatement': {
      let n = 0;
      for (const s of node.body) n += countRegionStmts(s);
      return n;
    }
    case 'ExpressionStatement': return 1 + exprWeight(node.expression);
    case 'VariableDeclaration': {
      let n = 0;
      for (const d of node.declarations) n += 1 + (d.init ? exprWeight(d.init) : 0);
      return n;
    }
    case 'ReturnStatement': return 1 + exprWeight(node.argument);
    case 'ThrowStatement': return 1 + exprWeight(node.argument);
    case 'FunctionDeclaration': return 2; // 会生成一条 FRAG 加一次存入
    default: return 1;
  }
}

// for-in/of 片段化重写，剥离 var 声明。提升语义已由局部名收集补偿

const REMOVE_STMT = Symbol('vm.remove');

function stripVars(s) {
  if (!s) return s;
  switch (s.type) {
    case 'VariableDeclaration': {
      if (s.kind !== 'var') return s;
      const assigns = [];
      for (const d of s.declarations) {
        if (d.id.type !== 'Identifier') return s; // canCompile 已拦截，这里是兜底
        if (d.init) assigns.push(t.assignmentExpression('=', d.id, d.init));
      }
      if (!assigns.length) return REMOVE_STMT;
      return assigns.length === 1
        ? t.expressionStatement(assigns[0])
        : t.expressionStatement(t.sequenceExpression(assigns));
    }
    case 'BlockStatement':
      s.body = s.body.flatMap((c) => {
        const r = stripVars(c);
        return r === REMOVE_STMT ? [] : [r];
      });
      return s;
    case 'IfStatement':
      if (s.consequent) s.consequent = applyStrip(s.consequent);
      if (s.alternate) s.alternate = applyStrip(s.alternate);
      return s;
    case 'WhileStatement':
    case 'DoWhileStatement':
      if (s.body) s.body = applyStrip(s.body);
      return s;
    case 'ForStatement': {
      if (s.init && s.init.type === 'VariableDeclaration' && s.init.kind === 'var') {
        const assigns = [];
        for (const d of s.init.declarations) {
          if (d.id.type !== 'Identifier') return s;
          if (d.init) assigns.push(t.assignmentExpression('=', d.id, d.init));
        }
        s.init = assigns.length
          ? (assigns.length === 1 ? assigns[0] : t.sequenceExpression(assigns))
          : null;
      }
      if (s.body) s.body = applyStrip(s.body);
      return s;
    }
    case 'ForInStatement':
    case 'ForOfStatement':
      if (s.left && s.left.type === 'VariableDeclaration') {
        s.left = s.left.declarations[0].id;
      }
      if (s.body) s.body = applyStrip(s.body);
      return s;
    default:
      return s;
  }
}

function applyStrip(s) {
  const r = stripVars(s);
  return r === REMOVE_STMT ? t.emptyStatement() : r;
}

// 其他小工具

/** 表达式体箭头函数改成块体，把隐式 return 写显式。 */
function prepareFn(fn) {
  if (fn.type === 'ArrowFunctionExpression' && fn.body && fn.body.type !== 'BlockStatement') {
    fn.body = t.blockStatement([t.returnStatement(fn.body)]);
    fn.expression = false;
  }
}

/** 语句位置的函数声明转成函数表达式，保留 id 以支持自身递归引用。 */
function toFunctionExpression(decl) {
  const fe = t.functionExpression(decl.id, decl.params, decl.body, decl.generator, decl.async);
  // 编译外层函数时，体内语句位置的函数声明会作为内层闭包被一并编译，元数据（含
  // fIdx）登记在 decl 上。此处新建节点替换 decl，必须把元数据一并搬过去：桥接体
  // 本身随 decl.body 走了（body 在换节点前就已改写成含 fIdx 的调用），缺的只是这份
  // 登记表。少了它，WASM 解释器内核档按 fIdx 落位时会撞上「fIdx 空洞」而构建失败。
  if (decl.__wasmVmMeta) fe.__wasmVmMeta = decl.__wasmVmMeta;
  return fe;
}

/**
 * 函数体自身的指令序言还原成语句。Directive.value 有两种形态：解析器产出的是
 * DirectiveLiteral 节点（值挂在 .value 上），手工构造的可能是裸字符串，两种都要
 * 取出字符串本体。字面量标 __noPool：指令靠"函数体第一条语句"这个位置生效，
 * 被字符串池收走就成了一次普通解码调用，严格模式随之丢掉。
 */
function directiveStmts(directives) {
  return (directives || []).map((d) => {
    const v = d.value;
    const s = typeof v === 'string' ? v : (v && typeof v.value === 'string' ? v.value : '');
    const lit = t.stringLiteral(s);
    lit.__noPool = true;
    return t.expressionStatement(lit);
  });
}

const JUMP_KINDS = new Set([
  'JMP', 'JPF', 'JPT', 'JANDK', 'JORK', 'JNULK',
  // 融合关系跳转（单层复杂度）：比较 + 条件跳转一字。真极性（T 结尾省略，
  // 如 JLT = a<b 时跳）与假极性（F 结尾，如 JLTF = !(a<b) 时跳）各 6 种。
  // 假极性不靠"反转算子"实现（NaN 下 !(a<b) 与 a>=b 不等价！），而是把 `!`
  // 包在原比较外面，逐位恒等。发射器见 emitTestJump，动作体见 caseBody。
  'JLT', 'JLE', 'JGT', 'JGE', 'JEQ', 'JNE',
  'JLTF', 'JLEF', 'JGTF', 'JGEF', 'JEQF', 'JNEF',
]);
// 融合跳转种类 → JS 比较算子（真/假极性共用同一个，极性由种类后缀 F 决定）。
// wasm 侧复用同一张表（见 wasmvm.js 的导入），两边漂移即静默算错。
const FUSED_REL_OPS = {
  JLT: '<', JLE: '<=', JGT: '>', JGE: '>=', JEQ: '===', JNE: '!==',
  JLTF: '<', JLEF: '<=', JGTF: '>', JGEF: '>=', JEQF: '===', JNEF: '!==',
};
// 源码比较算子 → 融合种类（true = 条件为真时跳，false = 条件为假时跳）。
const FUSED_T = { '<': 'JLT', '<=': 'JLE', '>': 'JGT', '>=': 'JGE', '===': 'JEQ', '!==': 'JNE' };
const FUSED_F = { '<': 'JLTF', '<=': 'JLEF', '>': 'JGTF', '>=': 'JGEF', '===': 'JEQF', '!==': 'JNEF' };
const ARG1_KINDS = new Set(['LDC', 'LOD', 'STR', 'GET', 'SET', 'FRAG', 'EXEC', 'MKS']);
const ARG2_KINDS = new Set(['JANDK', 'JORK', 'JNULK']);
// 宏指令的操作数个数。MPKn 把 n 条连续的操作数装载指令压成一条，
// 操作数是 n 个打包字「(下标 << 2) | 源位」。源位两位，取值与 caseBody 的
// MACRO_SRC 表一一对应：0 常量池 K、1 槽位面 V、2 外层名 getter G、3 常量池闭包 K()。
// 打包让任意源组合共用同一个宏种类，不必按组合展开种类；两条指令原本可能一个取
// 常量池、一个取槽位面，融进同一条宏之后仍然各取各的。
const MACRO_KINDS = new Map([['MPK2', 2], ['MPK3', 3], ['MPK4', 4]]);
// 可作为宏成员的装载类指令。共同点是动作体只做「取一个值压栈」，没有别的副作用，
// 所以按原顺序拼接就是等价展开。MKS 的体是还原循环、EXEC 的结果要丢弃，都不在列。
const MACRO_MEMBER_KINDS = new Set(['LDC', 'LOD', 'GET', 'FRAG']);
// 源位编码表，取值即编译期打包字低两位与 caseBody 里 macroSrc() 表的下标。
const MACRO_SRC_CODE = new Map([['LDC', 0], ['LOD', 1], ['GET', 2], ['FRAG', 3]]);

/**
 * 一条字节码条目占多少个字，以及是否尾随一个链值字。
 * args 是操作数字数（跳转类已含目标那一个字），chain 是链值字有无。
 */
function layoutOf(e) {
  const m = MACRO_KINDS.get(e.op);
  if (m !== undefined) return { args: m, chain: false };
  // NOP：1 字无操作数无链值，解释器遇到直接进下一条（动作体为空）。
  if (e.op === 'NOP') return { args: 0, chain: false };
  const isJump = JUMP_KINDS.has(e.op);
  if (ARG2_KINDS.has(e.op)) return { args: 2, chain: isJump };
  if (isJump) return { args: 1, chain: true };
  if (ARG1_KINDS.has(e.op)) return { args: 1, chain: false };
  return { args: 0, chain: false };
}
/** 一条字节码条目占多少个字（opcode 一字，操作数若干，跳转类再加链值字）。 */
function opWordWidth(e) {
  const l = layoutOf(e);
  return 1 + l.args + (l.chain ? 1 : 0);
}

// 编译器

function compileFunction(fn, ctx) {
  const opts = ctx.options;
  const threshold = opts.vmThreshold !== undefined ? opts.vmThreshold : 3;

  // 异步执行器（vmAsyncExecutor）。canCompile 已经确认这个函数是 async 且全部 await 都
  // 落在「编译后仍在 async 函数体内」的位置，这里只需要记住身份，做两件事：
  //   ① 分发形态限制成内联形态（见下面 dispatchForm 的选择）；
  //   ② await 的编译走通用的一元运算通道：emitExpr 把 `await x` 发成 UN_await，
  //      动作体生成出 `await R` 表达式。因为它写在 async 函数体内（解释器循环就在这里），
  //      这个 await 会把整个解释器挂起，Promise settle 后从下一条指令继续——
  //      挂起/恢复、返回值的 Promise 包装、throw 变 rejected promise 全部交给引擎，
  //      与源码的 async 语义逐条对等，不需要任何状态机或续体改造。
  const asyncFn = !!fn.async;

  // 层数（vmLayers）。默认 1 = 当今形态（外层函数体就是 VM 解释器）；
  // 2 = 「解释器循环本身作为一个新函数体再 VM 编译一次」。判定必须放在 WASM
  // 桥接分支之前：wasmInterpreter 开启时 bridge 路径会丢弃 JS 解释器（解释循环
  // 在模块里），没有可嵌套的东西；要嵌套的函数改走 JS 解释器路径（见桥接分支
  // 的条件），嵌套失败则回退单层 JS 解释器。async 函数不嵌套（await 要求内联
  // 形态 A/C，而嵌套要求形态 C 且循环体含返回穿透——两者叠加语义不明，保守起见
  // 整函数走原路径）。
  // depth 由外层 compileFunction 递归时推进（见文件末尾组装段）。
  const layersWanted = (() => {
    const v = opts.vmLayers === undefined || opts.vmLayers === null ? 1 : opts.vmLayers | 0;
    return v < 1 ? 1 : (v > 3 ? 3 : v);
  })();
  const wantNestingHere = (ctx.__vmDepth | 0) + 1 < layersWanted && !asyncFn;

  // 执行护栏（原嵌套内层档的可信内核特性，现并入本解释器）：
  //   · 指令步数上限：单次调用里解释器最多执行多少条字节码指令，超了抛错。
  //     0 = 关闭检查。默认给得很大，只在真正失控（死循环）时触发，
  //     正常业务负载不会撞到这条线。
  //   · 操作数栈深度上限（固定常数）：病态深嵌套的表达式不允许无界撑爆 S。
  const stepLimit = (opts.vmStepLimit === undefined || opts.vmStepLimit === null)
    ? 100000000
    : (opts.vmStepLimit > 0 ? opts.vmStepLimit | 0 : 0);
  const stackDepthCap = 4096;

  // 编译期密钥（vmCompileKey）。给了密钥时，本函数的密钥材料不再取自 randInt，
  // 而由「密钥 + 本函数序号」哈希派生出的确定性流给出：
  //   - 同一密钥每次构建得到同一套密钥材料，产物可复现；
  //   - 没有密钥就复现不出掩码与位置散列，字节码字的解密式也就凑不出来。
  // 没给密钥时 krand 直接转发 randInt，产物与改动前逐字节一致（自测基线不动）。
  // 注意只切换「密钥材料」这一组取值；干扰字、分发形态等仍走 randInt，
  // 所以形态多态性不受影响。
  const keyText = opts.vmCompileKey ? String(opts.vmCompileKey) : '';
  const keyed = !!keyText;
  // 兜底常量在整个 pass 运行期固定一次（存在 ctx 上，与 __vmKeySeq 同一模式）：
  // 构建期算派生与运行期注入兜底在代码上是两处，必须同值，各自摇会得到不同值。
  if (ctx.__vmKeyFallback === undefined) ctx.__vmKeyFallback = vmKeyFallback();
  const keyFallback = ctx.__vmKeyFallback;
  let keySeq = 0;
  let keyState = 0;
  if (keyed) {
    // 函数序号：同一份源码里的每个函数拿到不同的密钥材料，同时又是运行期重建
    // 派生所需的同一个编号（产物里以字面量出现，不是秘密——秘密是密钥本身）。
    keySeq = (ctx.__vmKeySeq = (ctx.__vmKeySeq || 0) + 1);
    let h = 0x811c9dc5; // FNV-1a
    const tag = keyText + '#' + keySeq;
    for (let i = 0; i < tag.length; i++) h = Math.imul(h ^ tag.charCodeAt(i), 0x01000193) >>> 0;
    keyState = h >>> 0;
    // 0 是 xorshift32 的不动点，兜底值必须非零。
    //
    // 这个值是**任意选取**的（不是算法规范参数），所以逐构建换一个：0x9e3779b9
    // 是公开的"黄金比例常数"，扫字面量就能定位。约束只有两条——非零、且运行期
    // 注入的那份必须与构建期一致（见 emitKeyedSetup 的同名兜底），否则派生出的
    // 密钥材料两侧对不上。
    if (keyState === 0) keyState = keyFallback;
  }
  // xorshift32 推进后取模落进 [lo, hi]，与 randInt 的返回区间一致
  const krand = (lo, hi) => {
    if (!keyed) return randInt(lo, hi);
    keyState ^= keyState << 13; keyState >>>= 0;
    keyState ^= keyState >>> 17;
    keyState ^= keyState << 5;  keyState >>>= 0;
    return lo + (keyState % (hi - lo + 1));
  };

  // 字节码编码（vmBytecodeEncoding）。关闭时字节码以明文整数数组存在：取指退化成
  // 一次普通数组读取，入口也不再重写 B 数组——这是排查问题用的弱档，不是安全档。
  // WASM 解释器内核档的取指在模块里、按加密布局硬编码，所以该档强制保持编码，
  // 本项对它无效。
  const enc = (opts.vmBytecodeEncoding !== false) || !!ctx.__vmWasmShared;

  // 跳转编码（vmJumpsEncoding）。开启后跳转操作数不存目标的绝对字下标，改存
  // 「目标字下标 − 本指令字下标」的差值，运行期用取指游标把本指令的字下标还原回来
  // 再加回去。差值脱离所在位置就没有意义，所以即使 dump 出解密后的字节码，看到的
  // 也只是一串相对位移，还原控制流图还得先确定每条指令的字跨度。
  // WASM 内核档的解释器在模块里、按绝对下标硬编码，该档自动关闭本项。
  const jumpEnc = !!opts.vmJumpsEncoding && !ctx.__vmWasmShared;

  // 栈编码（vmStackEncoding）。操作数栈上装的是任意 JS 值，XOR 只对数字成立，所以
  // 编码函数必须对非数字透明：SE(v) 在 v 是 32 位整数且非 -0 时返回 v ^ K，否则原样
  // 返回。SE 是幂等的（SE∘SE = id），所以编码与解码共用同一个函数。
  // 栈上存的永远是 SE(值)：压栈时编码、出栈时解码；DUP 原样复制已编码值（不能再编一次）、
  // 条件跳转与 GETMK 取键要解码。
  // WASM 内核档的栈在模块里，该档自动关闭本项。
  const stackEnc = !!opts.vmStackEncoding && !ctx.__vmWasmShared;
  const nSE = stackEnc ? uniqueName(ctx.usedNames, '_0x') : null; // 编码函数名
  const nSEK = stackEnc ? uniqueName(ctx.usedNames, '_0x') : null; // 逐函数密钥
  const nSEV = stackEnc ? uniqueName(ctx.usedNames, '_0x') : null; // 编码函数的形参名

  // 宏指令（vmMacroOps）。把连续的操作数装载指令合并成一条 MPKn：原本「n 条指令
  // 各自取指 + 各自分发」变成「一条指令取指一次 + 分发一次」，n 个操作数打包成
  // n 个「(下标 << 1) | 源位」的字跟在后面。宏的动作体由被合并的那 n 条指令的动作
  // 体按原顺序拼接而成，所以语义等价是构造性的，不需要逐模式证明。
  // 只在同一个函数内做，且跳转目标不落在被合并的区间内（跳转靠指令下标定位）。
  // WASM 解释器内核档的动作体在模块里、按既有指令集硬编码，该档关闭本项。
  const macroOps = !!opts.vmMacroOps && !ctx.__vmWasmShared;

  // 动态操作码（vmDynOpcodes）。分发字到语义动作的对应关系不再是全函数唯一的一张表：
  // 存进字节码的编号是「规范编号 − 本条指令字下标的轮换量」，取指之后由解释器用取指
  // 游标把轮换量算回来再加回去，得到规范编号，再分桶、比对、查表。
  // 于是同一个分发字在不同位置指向不同动作：静态 dump 出解密后的字节码，看到的
  // 只是一串与位置耦合的编号，要把分发字与语义对齐，必须先把每条指令的字下标与轮换
  // 公式算清楚（而公式里的两个常数逐函数随机），不能再拿一张「字 → 语义」表直接读。
  // 与逐调用轮换的关系：掩码与链值在每次调用入口整体重写 B，那层管"字长什么样"；
  // 本项管"字还原成哪个编号"，两者叠在同一条取指路径上，互不依赖。
  // 为什么用位置而不是段/状态：动作体按操作码种类生成，一个种类的体要给
  // 该种类全部指令共用，承载不了"按指令"的字面量；而取指游标是每条指令天然自带、
  // 且在任何进入路径（顺序、跳转、回边）上都唯一确定的状态，所以位置轮换不需要额外
  // 指令、不需要入口初始化，也不会在"某处既是跳转目标又是顺序后继"的边界上失配。
  // 代价：取指后多一次 imul、异或与掩码；字空间必须是 2 的幂（还原用 &(N-1)），
  // 开启时把槽位数上取整、多出的槽位并进干扰项。WASM 内核档的分发在模块里，忽略本项。
  const dynOps = !!opts.vmDynOpcodes && !ctx.__vmWasmShared;
  // 位置轮换的两个常数。这里必须用 randInt 而不是 krand：krand 是与编译期密钥
  // 绑定的确定性流，而运行期要让"密钥取回"重跑一遍派生（rtKeyStmts 里的那张清单）
  // 才能对上构建期的掩码、链种子与分发常数。那份清单按固定顺序列举派生项，中途插进
  // 两个新的 krand 抽取会让清单与构建期错位——构建期派生的掩码与运行期重跑出来的
  // 掩码不一致，密钥正确也会解成垃圾（实测表现是产物静默算出 undefined 而不报错）。
  // 这两个常数只在解释器里当字面量用、运行期不参与派生，所以走种子流即可：同种子
  // 依旧可复现，产物仍随编译期密钥变化（其余派生项仍在密钥流上）。
  const DYN_P = dynOps ? (randInt(0x10001, 0x7ffffffe) | 1) : 0;
  const DYN_Q = dynOps ? randInt(0x1000, 0x7ffffff) : 0;

  // 运行时密钥取值（vmRuntimeKeyGetter）。与编译期密钥配对使用：产物在每个 VM
  // 函数开头求值用户给的表达式，用取回的值重跑一遍上面这套派生，把结果当初始掩码、
  // 位置散列常数、轮换函数与链种子。取回的值不等于编译期密钥 → 派生出另一套掩码 →
  // 字节码字解出来是垃圾 → 函数随即崩掉，门禁由此成立。
  // 两个前提：取指在 WASM 模块里的那一档改不了，自动忽略本项；没有编译期密钥就
  // 没有"正确值"可比，门禁不成立，在 pass 入口直接报错（见 vm()）。
  const rtGetterText = (!ctx.__vmWasmShared && opts.vmRuntimeKeyGetter)
    ? String(opts.vmRuntimeKeyGetter) : '';
  // 编码关闭时没有掩码可派生，运行期密钥取值跟着失效（守门守的正是那套掩码）
  const useRtKey = !!rtGetterText && keyed && enc;
  // 运行期派生要用的名字。分块那三个只在 useBlock 时才落进语句，先占名无副作用。
  const rt = useRtKey ? {
    ks: uniqueName(ctx.usedNames, '_0x'), // 派生状态
    ri: uniqueName(ctx.usedNames, '_0x'), // 哈希游标
    rs: uniqueName(ctx.usedNames, '_0x'), // 密钥串
    K1: uniqueName(ctx.usedNames, '_0x'),
    K2: uniqueName(ctx.usedNames, '_0x'),
    M0: uniqueName(ctx.usedNames, '_0x'),
    RA: uniqueName(ctx.usedNames, '_0x'),
    RB: uniqueName(ctx.usedNames, '_0x'),
    BS: uniqueName(ctx.usedNames, '_0x'),
    BA: uniqueName(ctx.usedNames, '_0x'),
    BB: uniqueName(ctx.usedNames, '_0x'),
    CS: uniqueName(ctx.usedNames, '_0x'),
  } : null;
  // 取指 / 轮换 / 链种子：开了运行期派生就改成标识符引用，否则保持构建期字面量，
  // 与改动前逐字节一致
  const kLit = (value, name) => (name ? t.identifier(name) : t.numericLiteral(value));

  // 栈机是唯一后端。操作数栈始终是唯一的活动栈。

  // 运行时名字走 uniqueName，避免与源码标识符冲突
  const nV = uniqueName(ctx.usedNames, '_0x');
  const nG = uniqueName(ctx.usedNames, '_0x');
  const nH = uniqueName(ctx.usedNames, '_0x');
  const nK = uniqueName(ctx.usedNames, '_0x');
  const nB = uniqueName(ctx.usedNames, '_0x');
  const nJ = uniqueName(ctx.usedNames, '_0x');
  const nS = uniqueName(ctx.usedNames, '_0x');
  const npc = uniqueName(ctx.usedNames, '_0x');
  const nM = uniqueName(ctx.usedNames, '_0x');
  const nSTEP = uniqueName(ctx.usedNames, '_0x');
  const V = t.identifier(nV), G = t.identifier(nG), H = t.identifier(nH);
  const K = t.identifier(nK), B = t.identifier(nB), S = t.identifier(nS);
  const J = t.identifier(nJ); // 字符串码元表，MKS 指令在运行期解密还原成 string
  const PC = t.identifier(npc);
  const MASK = t.identifier(nM);
  const STEP = t.identifier(nSTEP);   // 指令步数计数器（执行护栏，见 interpBody）
  // 字节码加密参数，同时供入口自修改使用。
  // 存储字 = 值 ^ posMask(下标+1) ^ 当前掩码，取指做同一逆运算。
  // posMask 走 Math.imul 位置散列，让每个字的密文依赖自己的位置，整体异或式还原因此失效。
  // 每次调用入口，解释器用 imul 轮换函数推进掩码并原位重写整个 B 数组，调用期间内存中的
  // 字节码与源码字面量不同，不同调用轮次的密文也不同。
  const MASK_K1 = krand(0x10001, 0x7ffffffe) | 1;   // 位置散列乘数，取奇数
  const MASK_K2 = krand(0x1000, 0xffffff);          // 位置散列异或分量
  const MASK_M0 = krand(0x1000, 0x3fffffff);        // 构建期初始掩码，正 31 位
  const ROT_A = krand(0x10001, 0x7ffffffe) | 1;     // 轮换函数乘数，取奇数，imul 上可逆
  const ROT_B = krand(0x1000, 0xffffff);            // 轮换函数异或分量
  const posMask = (i) => (Math.imul(i, MASK_K1) >>> 8) ^ MASK_K2;

  // P4 分块自解密。块密钥由块号运行期派生：BK(b) = imul(b, BK_A) ^ BK_B，
  // 块长取 2 的幂（BL = 1 << BL_SH），块号 = 字下标 >>> BL_SH。
  // 存储字多异或一项 BK(b(z))，取指必须带上同一项——静态面没有 BK_A/BK_B/BL_SH
  // 的明文（旧 wasm 档把它们搬进模块数据段），不知道块长与派生常数就解不出任何字。
  // WASM 解释器内核档（桥接函数没有 JS 取指）自动关闭，产物与不开时逐字节一致。
  // 编码关闭时字里没有「加密过的字」可再分层，分块自解密跟着失效；
  // WASM 解释器内核档的桥接函数没有 JS 取指，该档一向关闭本项。
  const useBlock = !!opts.vmBlockDecrypt && !ctx.__vmWasmShared && enc;
  const BL_SH = useBlock ? krand(4, 6) : 0;              // 块长指数（16/32/64 字）
  const BL = useBlock ? (1 << BL_SH) : 0;                  // 块长（字）
  const BK_A = useBlock ? (krand(0x10001, 0x7ffffffe) | 1) : 0; // 派生乘数，奇数
  const BK_B = useBlock ? krand(0x1000, 0xffffff) : 0;   // 派生异或分量
  const bkOf = useBlock ? (z) => (Math.imul(z >>> BL_SH, BK_A) ^ BK_B) | 0 : () => 0;

  // 字符串表加密参数。产物里没有明文字符串字面量，字符串以码元密文表存在，
  // 每个码元与「项序号、项内下标」的位置散列异或，只有 VM 解释器执行 MKS 指令
  // 时才把它还原成 string 并交回调用方，静态面拿不到明文。
  const STR_P = krand(0x1000, 0xffff) | 1;          // 项序号乘数
  const STR_K1 = krand(0x10001, 0x7ffffffe) | 1;    // 位置散列乘数，取奇数
  const STR_K2 = krand(0x1000, 0xffffff);           // 位置散列异或分量
  const STR_M0 = krand(0x1000, 0x3fffffff);         // 码元掩码
  const strHash = (si, i) => ((Math.imul(Math.imul(si + 1, STR_P) + i, STR_K1) >>> 8) ^ STR_K2 ^ STR_M0) >>> 0;

  // 名字分类。被捕获的保留为真实 var，经 G/H 闭包读写；未捕获的进槽位
  const locals = collectLocals(fn);
  const captured = collectCaptured(fn, locals);
  const slotOf = new Map();
  for (const name of locals) if (!captured.has(name)) slotOf.set(name, slotOf.size);

  const getterNodes = [];
  const getterIdx = new Map();
  const setterNodes = [];
  const setterIdx = new Map();
  const getThunkIdx = (key) => {
    let i = getterIdx.get(key);
    if (i === undefined) {
      i = getterNodes.length;
      getterIdx.set(key, i);
      getterNodes.push(key === 'this'
        ? t.arrowFunctionExpression([], t.thisExpression())
        : t.arrowFunctionExpression([], t.identifier(key)));
    }
    return i;
  };
  const getSetIdx = (name) => {
    let i = setterIdx.get(name);
    if (i === undefined) {
      i = setterNodes.length;
      setterIdx.set(name, i);
      const p = uniqueName(ctx.usedNames, '_0x');
      setterNodes.push(t.arrowFunctionExpression(
        [t.identifier(p)],
        t.assignmentExpression('=', t.identifier(name), t.identifier(p))));
    }
    return i;
  };

  // 常量池
  const consts = [];
  const constKey = new Map();
  const litConst = (node) => {
    let key;
    switch (node.type) {
      case 'NumericLiteral': key = 'n:' + node.value; break;
      case 'StringLiteral': key = 's:' + node.value; break;
      case 'BooleanLiteral': key = 'b:' + node.value; break;
      case 'NullLiteral': key = 'z:null'; break;
      default: key = 'u:undefined'; break;
    }
    let i = constKey.get(key);
    if (i === undefined) {
      i = consts.length;
      constKey.set(key, i);
      consts.push(node.type === 'Identifier' ? t.identifier('undefined') : node);
    }
    return i;
  };
  const UNDEF = litConst(t.identifier('undefined'));
  const pushThunk = (arrow) => { consts.push(arrow); return consts.length - 1; };

  // 字符串表。明文字符串只在本进程的构建期存在，写进产物的是码元密文表，
  // 运行期由 MKS 指令解密拼接后返回 string。同一函数内重复字符串共享一项。
  const strings = [];
  const strKey = new Map();
  // 码元密文表：每个码元与「项序号、项内下标」的位置散列异或。产物里只有这张
  // 数字表，明文串在任何静态面上都不出现，只有 VM 执行 MKS 时才还原成 string。
  const stringsEnc = [];
  const encString = (si, value) => {
    const row = [];
    for (let j = 0; j < value.length; j++) {
      row.push((value.charCodeAt(j) ^ strHash(si, j)) >>> 0);
    }
    stringsEnc.push(row);
  };
  const litString = (value) => {
    let i = strKey.get(value);
    if (i === undefined) { i = strings.length; strKey.set(value, i); strings.push(value); encString(i, value); }
    return i;
  };
  const strThunkIdx = new Map();
  const fccCall = (x) => (ctx.rt && ctx.rt.fcc)
    ? t.callExpression(t.identifier(ctx.rt.fcc), [x])
    : t.callExpression(t.memberExpression(t.identifier('String'), t.identifier('fromCharCode'), false), [x]);
  // 位置散列：base 是项序号经 STR_P 预混后的常数分量，j 是项内下标。
  // 异或结合律多态：三种括号形态逐调用随机，语义是同一位向量恒等（位异或满足
  // 结合律/交换律，int32 逐位相等），但取指表达式的 AST 形态各不相同。静态提取
  // 「还原公式」不能再靠单一模板匹配 strPosExpr，必须做语义归一。
  const strPosExpr = (baseNode, jNode) => {
    const h = t.binaryExpression('>>>',
      rtlib.mulCall(ctx,
        t.binaryExpression('+', baseNode, jNode),
        t.numericLiteral(STR_K1)),
      t.numericLiteral(8));
    const k2 = t.numericLiteral(STR_K2), m0 = t.numericLiteral(STR_M0);
    const f = randInt(0, 2);
    if (f === 0) return t.binaryExpression('^', t.binaryExpression('^', h, k2), m0);
    if (f === 1) return t.binaryExpression('^', h, t.binaryExpression('^', k2, m0));
    return t.binaryExpression('^', t.binaryExpression('^', h, m0), k2);
  };
  const strBaseConst = (si) => Math.imul(si + 1, STR_P) | 0;

  // 片段闭包里的字符串字面量不能走解释器的 MKS 指令（片段是真实 JS 闭包），
  // 改为引用 K 里的解密 thunk，由 thunk 在运行期解出 string 再交回片段。
  // thunk 与片段同处编译函数作用域，能按词法访问 K 与 J。
  const strThunkArrow = (si) => {
    const key = String(si);
    const cached = strThunkIdx.get(key);
    if (cached !== undefined) return cached;
    const nT0 = uniqueName(ctx.usedNames, '_0x');
    const nT1 = uniqueName(ctx.usedNames, '_0x');
    const nT2 = uniqueName(ctx.usedNames, '_0x');
    const row = t.memberExpression(J, t.numericLiteral(si), true);
    const arrow = t.arrowFunctionExpression([], t.blockStatement([
      t.variableDeclaration('var', [t.variableDeclarator(t.identifier(nT0), t.stringLiteral(''))]),
      t.forStatement(
        t.variableDeclaration('var', [t.variableDeclarator(t.identifier(nT1), t.numericLiteral(0))]),
        morph.relCmp('<', t.identifier(nT1),
          morph.memberDot(row, 'length')),
        morph.incUpd(nT1),
        t.blockStatement([
          t.expressionStatement(t.assignmentExpression('=',
            t.identifier(nT0),
            t.binaryExpression('+', t.identifier(nT0), fccCall(t.binaryExpression('^',
              t.memberExpression(row, t.identifier(nT1), true),
              strPosExpr(t.numericLiteral(strBaseConst(si)), t.identifier(nT1))))))),
        ])),
      t.returnStatement(t.identifier(nT0)),
    ]));
    const idx = pushThunk(arrow);
    strThunkIdx.set(key, idx);
    return idx;
  };
  // 片段闭包统一写成 ()=>{ return expr; }，return 后跟 { 开头的表达式恒合法
  const wrapFrag = (expr) =>
    t.arrowFunctionExpression([], t.blockStatement([t.returnStatement(expr)]));

  // 片段内的嵌套函数值递归编译
  const allowAsync = !!opts.vmAsyncExecutor && !ctx.__vmWasmShared;
  const compileInnerFns = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(compileInnerFns); return; }
    if (typeof node.type !== 'string') return;
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression' || node.type === 'ClassMethod' ||
        node.type === 'ObjectMethod') {
      if (!compiledSet.has(node)) {
        prepareFn(node);
        if (canCompile(node, allowAsync) && countRegionStmts(node.body) >= threshold) {
          try { compileFunction(node, ctx); } catch (e) { /* 保守处理，维持原样 */ }
        }
      }
      return;
    }
    eachChild(node, compileInnerFns);
  };

  // 代码发射
  const code = []; // { op, a, n }
  const usedOps = new Set();
  const emit = (op, a, n) => { usedOps.add(op); code.push({ op, a, n }); return code.length - 1; };

  const loopStack = [];
  const pushLoop = () => {
    const l = { brkFix: [], contFix: [], brkAt: -1, contAt: -1 };
    loopStack.push(l);
    return l;
  };
  const popLoop = () => {
    const l = loopStack.pop();
    for (const e of l.contFix) code[e].a = l.contAt;
    for (const e of l.brkFix) code[e].a = l.brkAt;
  };

  function emitUpdate(node) {
    const name = node.argument.name;
    const isSlot = slotOf.has(name);
    const binOp = node.operator === '++' ? '+' : '-';
    const load = () => { if (isSlot) emit('LOD', slotOf.get(name)); else emit('GET', getThunkIdx(name)); };
    const store = () => { if (isSlot) emit('STR', slotOf.get(name)); else emit('SET', getSetIdx(name)); };
    load();
    if (node.prefix) {
      emit('LDC', litConst(t.numericLiteral(1)));
      emit('BIN_' + binOp);
      emit('DUP');
      store();
    } else {
      emit('DUP');
      emit('LDC', litConst(t.numericLiteral(1)));
      emit('BIN_' + binOp);
      store();
    }
  }

  function emitAssignment(node) {
    const { operator, left, right } = node;
    if (left.type === 'Identifier') {
      const isSlot = slotOf.has(left.name);
      if (operator === '=') {
        emitExpr(right);
        emit('DUP');
        if (isSlot) emit('STR', slotOf.get(left.name));
        else emit('SET', getSetIdx(left.name));
        return;
      }
      if (operator === '&&=' || operator === '||=' || operator === '??=') {
        const op = operator === '&&=' ? 'JANDK' : operator === '||=' ? 'JORK' : 'JNULK';
        if (isSlot) emit('LOD', slotOf.get(left.name));
        else emit('GET', getThunkIdx(left.name));
        const j = emit(op, -1, 0);
        emitExpr(right);
        emit('DUP');
        if (isSlot) emit('STR', slotOf.get(left.name));
        else emit('SET', getSetIdx(left.name));
        code[j].a = code.length;
        return;
      }
      // 复合算术与位运算 x OP= v。标识符没有副作用，可以安全展开
      if (isSlot) emit('LOD', slotOf.get(left.name));
      else emit('GET', getThunkIdx(left.name));
      emitExpr(right);
      emit('BIN_' + operator.slice(0, -1));
      emit('DUP');
      if (isSlot) emit('STR', slotOf.get(left.name));
      else emit('SET', getSetIdx(left.name));
      return;
    }
    // MemberExpression 目标（赋值流，对象不进地址栈，与 M0 布局一致），模式目标已由片段判定接走
    emitMemberObject(left.object);
    if (left.computed) emitExpr(left.property);
    else emit('MKS', litString(left.property.name));
    if (operator === '=') {
      emitExpr(right);
      emit('SETM'); // 存入后把值压回，作为赋值表达式的结果
      return;
    }
    if (operator === '&&=' || operator === '||=' || operator === '??=') {
      const op = operator === '&&=' ? 'JANDK' : operator === '||=' ? 'JORK' : 'JNULK';
      emit('GETMK');
      const j = emit(op, -1, 2); // 提前定值时要把栈底 o、k 两个值弹掉
      emitExpr(right);
      emit('SETM');
      code[j].a = code.length;
      return;
    }
    // o.k OP= v，GETMK 会保留 o、k 供回写
    emit('GETMK');
    emitExpr(right);
    emit('BIN_' + operator.slice(0, -1));
    emit('SETM');
  }

  // 片段子树内的字符串字面量换成 K 里的解密 thunk 调用，函数边界不再深入，
  // 嵌套函数由 compileInnerFns 独立编译，各自处理自己的字符串。
  const FRAG_FN_TYPES = new Set(['FunctionExpression', 'ArrowFunctionExpression',
    'FunctionDeclaration', 'ClassMethod', 'ObjectMethod', 'ClassExpression', 'ClassDeclaration']);

  function rewriteFragStrings(root) {
    const conv = (n) => (n && typeof n.type === 'string' && n.type === 'StringLiteral')
      ? t.callExpression(t.memberExpression(K, t.numericLiteral(strThunkArrow(litString(n.value))), true), [])
      : null;
    // 根节点是片段本身，函数形态的根要进它的体；只有更深一层的函数边界才停，
    // 那些内嵌函数由 compileInnerFns 各自独立编译，字符串归各自处理。
    const go = (n, isRoot) => {
      if (!n || typeof n !== 'object' || typeof n.type !== 'string') return;
      if (!isRoot && FRAG_FN_TYPES.has(n.type)) return;
      for (const key of Object.keys(n)) {
        if (META_KEYS.has(key) || key === 'type') continue;
        const v = n[key];
        if (Array.isArray(v)) {
          for (let i = 0; i < v.length; i++) {
            const r = conv(v[i]);
            if (r) v[i] = r; else go(v[i], false);
          }
        } else if (v && typeof v === 'object') {
          const r = conv(v);
          if (r) n[key] = r; else go(v, false);
        }
      }
    };
    const self = conv(root);
    if (self) return; // 根节点本身是字符串时由调用方处理，片段判定不会命中这种形态
    go(root, true);
  }

  function emitMemberObject(obj) {
    emitExpr(obj);
  }

  function emitExpr(node) {
    if (!node) { emit('LDC', UNDEF); return; }
    if (isFragmentExpr(node)) {      compileInnerFns(node);
      rewriteFragStrings(node);
      emit('FRAG', pushThunk(wrapFrag(node)));
      return;
    }
    switch (node.type) {
      case 'Identifier': {
        const s = slotOf.get(node.name);
        if (s !== undefined) emit('LOD', s);
        else emit('GET', getThunkIdx(node.name));
        return;
      }
      case 'ThisExpression': emit('GET', getThunkIdx('this')); return;
      case 'NumericLiteral':
      case 'BooleanLiteral':
      case 'NullLiteral': emit('LDC', litConst(node)); return;
      case 'StringLiteral': emit('MKS', litString(node.value)); return;
      case 'UnaryExpression':
        emitExpr(node.argument);
        emit('UN_' + node.operator);
        return;
      case 'UpdateExpression': emitUpdate(node); return;
      case 'BinaryExpression':
        emitExpr(node.left);
        emitExpr(node.right);
        emit('BIN_' + node.operator);
        return;
      case 'LogicalExpression': {
        emitExpr(node.left);
        const op = node.operator === '&&' ? 'JANDK' : node.operator === '||' ? 'JORK' : 'JNULK';
        const j = emit(op, -1, 0); // 保留左值时跳到右支之后
        emitExpr(node.right);
        code[j].a = code.length; // 保留时落到右支之后
        return;
      }
      case 'ConditionalExpression': {
        let j = emitTestJump(node.test, -1, false);
        if (j < 0) { emitExpr(node.test); j = emit('JPF', -1); }
        emitExpr(node.consequent);
        const m = emit('JMP', -1);
        code[j].a = code.length;
        emitExpr(node.alternate);
        code[m].a = code.length;
        return;
      }
      case 'SequenceExpression': {
        const last = node.expressions.length - 1;
        for (let i = 0; i < last; i++) { emitExpr(node.expressions[i]); emit('POP'); }
        emitExpr(node.expressions[last]);
        return;
      }
      case 'AssignmentExpression': emitAssignment(node); return;
      case 'MemberExpression':
        emitMemberObject(node.object);
        if (node.computed) emitExpr(node.property);
        else emit('MKS', litString(node.property.name));
        emit('GETM');
        return;
      case 'CallExpression': {
        const callee = node.callee;
        if (callee.type === 'MemberExpression') {
          emitMemberObject(callee.object);
          if (callee.computed) emitExpr(callee.property);
          else emit('MKS', litString(callee.property.name));
        } else {
          emitExpr(callee);
        }
        for (const a of node.arguments) emitExpr(a);
        emit((callee.type === 'MemberExpression' ? 'CALLM_' : 'CALL_') + node.arguments.length);
        return;
      }
      case 'NewExpression': {
        emitExpr(node.callee);
        for (const a of node.arguments) emitExpr(a);
        emit('NEW_' + node.arguments.length);
        return;
      }
      case 'ArrayExpression': {
        for (const el of node.elements) {
          if (el) emitExpr(el);
          else emit('LDC', UNDEF); // 数组洞按 undefined 处理，长度语义保持一致
        }
        emit('ARR_' + node.elements.length);
        return;
      }
      default:
        // 片段判定之外的未知表达式，兜底走片段以保住语义
        compileInnerFns(node);
        rewriteFragStrings(node);
        emit('FRAG', pushThunk(wrapFrag(node)));
        return;
    }
  }

  function emitVarDecl(node) {
    for (const d of node.declarations) {
      if (d.id.type === 'Identifier') {
        if (!d.init) continue; // var 提升语义下，槽位与真实 var 一开始就是 undefined
        emitExpr(d.init);
        const s = slotOf.get(d.id.name);
        if (s !== undefined) emit('STR', s);
        else emit('SET', getSetIdx(d.id.name));
      } else {
        // 解构声明转 EXEC 片段 ()=>{ (pattern = init); }，绑定名已提升为真实 var
        if (!d.init) continue;
        compileInnerFns(d.init);
        rewriteFragStrings(d.id);
        rewriteFragStrings(d.init);
        const thunk = t.arrowFunctionExpression([], t.blockStatement([
          t.expressionStatement(t.assignmentExpression('=', d.id, d.init)),
        ]));
        emit('EXEC', pushThunk(thunk));
      }
    }
  }

  // 条件测试的融合发射：test 为关系/恒等比较时直接发"比较+跳转"一条融合指令，
  // 否则回退成"求值 + JPF/JPT"老序列（返回 -1）。求值顺序与次数与老序列逐位
  // 一致（左右各求值一次，先左后右），融合恒等价，无需操作数纯——有副作用的
  // 调用照样能融。wantTrue 取真极性（do-while 回边），false 取假极性。
  function emitTestJump(test, target, wantTrue) {
    const fused = test && test.type === 'BinaryExpression'
      ? (wantTrue ? FUSED_T[test.operator] : FUSED_F[test.operator])
      : undefined;
    if (fused === undefined) return -1;
    emitExpr(test.left);
    emitExpr(test.right);
    if (ctx.__vmFused) ctx.__vmFused.jumps++;
    return emit(fused, target);
  }

  function emitStmt(s) {
    if (!s) return;
    switch (s.type) {
      case 'ExpressionStatement': emitExpr(s.expression); emit('POP'); return;
      case 'VariableDeclaration': emitVarDecl(s); return;
      case 'ReturnStatement':
        if (s.argument) { emitExpr(s.argument); emit('RET'); }
        else emit('RETU');
        return;
      case 'ThrowStatement': emitExpr(s.argument); emit('THR'); return;
      case 'IfStatement': {
        let j = emitTestJump(s.test, -1, false);
        if (j < 0) { emitExpr(s.test); j = emit('JPF', -1); }
        emitStmt(s.consequent);
        const m = emit('JMP', -1);
        code[j].a = code.length;
        emitStmt(s.alternate);
        code[m].a = code.length;
        return;
      }
      case 'WhileStatement': {
        const top = code.length;
        let j = emitTestJump(s.test, -1, false);
        if (j < 0) { emitExpr(s.test); j = emit('JPF', -1); }
        const loop = pushLoop();
        emitStmt(s.body);
        loop.contAt = top;
        emit('JMP', top);
        loop.brkAt = code.length;
        popLoop();
        code[j].a = loop.brkAt;
        return;
      }
      case 'DoWhileStatement': {
        const top = code.length;
        const loop = pushLoop();
        emitStmt(s.body);
        loop.contAt = code.length; // continue 回到测试条件，重新求值
        if (emitTestJump(s.test, top, true) < 0) { emitExpr(s.test); emit('JPT', top); }
        loop.brkAt = code.length;
        popLoop();
        return;
      }
      case 'ForStatement': {
        if (s.init) {
          if (s.init.type === 'VariableDeclaration') emitVarDecl(s.init);
          else { emitExpr(s.init); emit('POP'); }
        }
        const top = code.length;
        let jTest = -1;
        if (s.test) {
          jTest = emitTestJump(s.test, -1, false);
          if (jTest < 0) { emitExpr(s.test); jTest = emit('JPF', -1); }
        }
        const loop = pushLoop();
        emitStmt(s.body);
        const contAt = code.length;
        if (s.update) { emitExpr(s.update); emit('POP'); }
        emit('JMP', top);
        loop.contAt = contAt;
        loop.brkAt = code.length;
        popLoop();
        if (jTest >= 0) code[jTest].a = loop.brkAt;
        return;
      }
      case 'BlockStatement': for (const st of s.body) emitStmt(st); return;
      case 'BreakStatement': {
        const l = loopStack[loopStack.length - 1];
        if (!l) throw new Error(msg('vmBreakOutsideLoop'));
        const e = emit('JMP', -1);
        l.brkFix.push(e);
        return;
      }
      case 'ContinueStatement': {
        const l = loopStack[loopStack.length - 1];
        if (!l) throw new Error(msg('vmContinueOutsideLoop'));
        const e = emit('JMP', -1);
        l.contFix.push(e);
        return;
      }
      case 'FunctionDeclaration': {
        // 语句位置的函数声明，顶层声明在序言处理。生成 FRAG 后存入槽位或真实 var
        compileInnerFns(s);
        const fe = toFunctionExpression(s);
        rewriteFragStrings(fe);
        emit('FRAG', pushThunk(wrapFrag(fe)));
        const sl = slotOf.get(s.id.name);
        if (sl !== undefined) emit('STR', sl);
        else emit('SET', getSetIdx(s.id.name));
        return;
      }
      case 'ForInStatement':
      case 'ForOfStatement': {
        // 整体转 EXEC 片段，先剥掉 var，再递归编译内部函数值
        const L = s.left;
        if (L.type === 'VariableDeclaration') s.left = L.declarations[0].id;
        stripVars(s.body);
        compileInnerFns(s.right);
        compileInnerFns(s.body);
        rewriteFragStrings(s.right);
        rewriteFragStrings(s.body);
        const thunk = t.arrowFunctionExpression([], t.blockStatement([s]));
        emit('EXEC', pushThunk(thunk));
        return;
      }
      case 'EmptyStatement':
      case 'DebuggerStatement': return;
      default:
        throw new Error(msg('vmUnsupportedStatement', { type: s.type }));
    }
  }

  // 发射顺序：先提升序言函数声明，再发其余语句，最后 END。
  // 栈机解释器的收尾指令 END 让解释器直接 return。
  const origStmts = fn.body.body;
  const origDirectives = fn.body.directives;
  for (const s of origStmts) {
    if (s.type === 'FunctionDeclaration') emitStmt(s);
  }
  for (const s of origStmts) {
    if (s.type !== 'FunctionDeclaration') emitStmt(s);
  }
  emit('END');

  // 宏指令融合（vmMacroOps）。在整条指令流发完之后做，因为「跳转目标落在哪」要
  // 等所有跳转回填完才知道：跳转靠指令下标定位（pos[e.a]、targetChainOf 用
  // opZ.get(code[o.instr].a)），被合并掉的指令如果还是某个跳转的目标，定位就断了。
  // 所以规则是：只把连续的操作数装载指令并成一条宏指令，n 取 2..4；
  // 目标指令本身绝不并入前一条——它是段的起点，段可以从它开始，但不能跨过它。
  // 两种后端的打包格式不同（见下面 memberPack），但「取段 → 重映射 → 重建指令集」
  // 这套骨架完全共用，避免两套实现日后漂移。
  let macroFused = 0;  // 本函数生成的宏指令条数（统计用）
  let macroSaved = 0;  // 因融合而减少的指令条数（统计用）
  if (macroOps) {
    // 可融合的成员与打包函数：LDC / LOD / GET / FRAG，操作数只有「下标」，
    // 打包字 = (下标 << 2) | 源位；段长 2..4 时字流长度正好 1 + n，与 opWordWidth 一致。
    const memberSet = MACRO_SRC_CODE;
    const memberOk = (e) => memberSet.has(e.op);
    const memberPack = (e) => (e.a << 2) | memberSet.get(e.op);
    const macroName = (n) => 'MPK' + n;
    const targets = new Set();
    for (const e of code) if (JUMP_KINDS.has(e.op)) targets.add(e.a);
    const fused = [];
    // 指令下标重映射表。跳转目标记的是指令下标（pos[e.a] 与 targetChainOf 的
    // opZ.get(code[o.instr].a) 都按它取字下标），融合会改变下标，所以融完必须整体
    // 改写跳转操作数，否则跳转落到错误的指令上——循环会因此死循环。
    const remap = new Array(code.length);
    for (let i = 0; i < code.length; i++) {
      const e = code[i];
      if (!memberOk(e)) { remap[i] = fused.length; fused.push(e); continue; }
      // 段的右端：连续的同族装载，且下一个位置不是任何跳转的目标
      let j = i;
      while (j + 1 < code.length && memberOk(code[j + 1]) && !targets.has(j + 1)) j++;
      let at = i;
      while (at <= j) {
        // 每段最多 4 条：再长的收益递减，而打包字要保持小整数便于逐字加密。
        let n = 0;
        while (n < 4 && at + n <= j) n++;
        if (n < 2) { remap[at] = fused.length; fused.push(code[at]); at++; continue; }
        const args = [];
        for (let k = 0; k < n; k++) args.push(memberPack(code[at + k]));
        // 段内每条指令的下标都指到这条宏上：段内不可能是跳转目标（上面已保证），
        // 只有段首可能被跳转指到，它必须映射正确
        for (let k = 0; k < n; k++) remap[at + k] = fused.length;
        fused.push({ op: macroName(n), a: 0, n: 0, args });
        macroFused++;
        macroSaved += n - 1;
        at += n;
      }
      i = j;
    }
    code.length = 0;
    for (const e of fused) code.push(e);
    for (const e of code) if (JUMP_KINDS.has(e.op)) e.a = remap[e.a];
    // 指令集清单按融合后的实际指令流重建：被完全并掉的装载指令不再占分发编号，
    // 新出现的宏指令才有动作体要生成。顺序取自指令流，保证同种子可复现。
    usedOps.clear();
    for (const e of code) usedOps.add(e.op);
    // 统计并入 ctx：片段里嵌套的函数走 compileInnerFns 递归编译，那条路的返回值
    // 没人接，所以计数必须落在共享的累加器上才不会漏报
    if (ctx.__vmMacro) { ctx.__vmMacro.fused += macroFused; ctx.__vmMacro.saved += macroSaved; }
  }

  // 流干扰 NOP（单层复杂度）：融合之后、编号之前注入无操作指令。
  // 跳转目标记的是 code 下标，插入会整体移位，所以边插边给所有 JUMP_KINDS
  // （含上面的融合跳转）重定位 .a。NOP 不并入融合段（融合已结束），不占操作数，
  // 布局 1 字无链值（见 layoutOf）。门控：干扰项关闭（vmDecoyOps=0）时连流
  // 干扰一起关，保持最小足迹模式干净。
  let nopInjected = 0;
  if (ctx.options.vmDecoyOps === undefined || (ctx.options.vmDecoyOps | 0) > 0) {
    // 坏邻接预防（这条是踩坑换来的，见下）。code[i] 是跳转、且 code[i+1] 恰是某跳转
    // 目标时，本间隔一律不插 NOP。
    //
    // 为什么：字流里 [跳转的链值字][1 字指令][该跳转的目标] 这个三连会构成链求解的
    // 2-环——链值字的明文按定义取自「目标的前一字」（即中间这条 1 字指令），而中间这条
    // 的明文在 dynOps 下是「规范编号 − rot(前一字明文)」，前一字正是链值字本身。
    // wordAt 的不动点循环对环上的链字会保留首轮猜测值，此后不再重算，于是链值字与它
    // 依赖的 rot 永久不一致且**静默**（收敛校验过不了也不抛，只是不自洽）：跳转落点
    // 的字按错误的链值解密 → 落点解出非法操作码 → 后面全级联偏移，实测表现为整包输出
    // 乱码、undefined 或提前 END。
    //
    // 为什么原生布局碰不到：无 NOP 时中间那条必须恰是 1 字指令（LOD/LDC/BIN_/DUP 等），
    // 概率极低；插 NOP 后 NOP 本身就是 1 字指令，概率从「极低」变成「8% 每条」。
    //
    // 定位手法（留给下一个遇到字节码级静默错的人）：在解释器分发前临时插一行
    // `console.log(npc + ":" + dispT)`，跑产物拿执行轨迹，再与构建期的
    // {pos: 指令字下标表, canon: 分发字→种类逆表} 对账——若某次取指的位置不在 pos
    // 里、或解出的字不在 canon 里，就是这条链字不一致。切 vmDynOpcodes:false 或
    // vmDecoyOps:0 各自能消掉症状，就是这条（前者去掉 rot 环，后者去掉中间那条字）。
    const targetIdx = new Set();
    for (const e of code) {
      if (e.op && JUMP_KINDS.has(e.op) && e.a >= 0) targetIdx.add(e.a);
    }
    const nextCode = [];
    const remapN = new Array(code.length);
    for (let i = 0; i < code.length; i++) {
      remapN[i] = nextCode.length;
      nextCode.push(code[i]);
      // END 之后不插（解释器到 END 即返回，尾巴指令永不可达还占字流）；
      // 密度 8%：线性扫描器每十几条就撞上一条假指令。
      const badAdj = JUMP_KINDS.has(code[i].op) && targetIdx.has(i + 1);
      if (code[i].op !== 'END' && !badAdj && randInt(0, 99) < 8) {
        nextCode.push({ op: 'NOP', a: 0, n: 0 });
        nopInjected++;
      }
    }
    code.length = 0;
    for (const e of nextCode) code.push(e);
    for (const e of code) if (JUMP_KINDS.has(e.op)) e.a = remapN[e.a];
    if (nopInjected > 0) usedOps.add('NOP');
    if (ctx.__vmFused) ctx.__vmFused.nops += nopInjected;
  }

  // 操作码随机编号后展平，跳转目标用绝对索引
  const opKinds = [...usedOps];
  const opNums = new Map();
  // 两级分发，分发字加桶再加全值比对。
  // 桶号由仿射(d)（P1/Q1）经非负模得到，外层 switch 按桶分派，桶内的 if-else 链比对
  // t === d。静态能看到的只有 switch 标签（桶号，本身没有语义）和 if 的比较常数 d。
  // 想知道 d 与语义的对应关系，必须先解出字节码流密文（含位置散列与掩码轮换）拿到实际
  // 的 d 序列，直接读 case 表已经得不到编号到语义的映射。
  const DISP_P1 = (krand(1, 0xffff) * 2 + 1) | 0;
  const DISP_Q1 = krand(1, 0xffff);

  // 指令集编号空间。真实操作码与干扰项共用一个稠密编号空间 0..N-1，编号来自一次全排列
  // 抽取，逐函数独立。稠密编号让 wasm 档可以按编号直接索引「编号 → 语义序号」表，
  // 不需要散列或查找；JS 档仍按编号做桶分发。干扰编号不会进入字节码流，对应处理器
  // 都是净无副作用的垃圾体，与真实动作混排进同一桶分布，静态分析无法按结构或位置
  // 区分真假，指令集还原只能逐条求值全部 N 个分支。
  const decoyTarget = Math.max(0,
    (ctx.options.vmDecoyOps !== undefined ? ctx.options.vmDecoyOps | 0 : 1024) - opKinds.length);
  let totalSlots = opKinds.length + decoyTarget;
  // 动态操作码的还原式是 &(N-1)，要求字空间是 2 的幂；把槽位数上取整，多出来的槽位
  // 自然成为干扰项（它们不进字节码流，与既有干扰项待遇一致）
  if (dynOps) { let p2 = 1; while (p2 < totalSlots) p2 <<= 1; totalSlots = p2; }
  const slotOrder = shuffle(Array.from({ length: totalSlots }, (_, i) => i));
  let decoys = slotOrder.slice(opKinds.length);
  if (ctx.__vmWasmShared) {
    // WASM 解释器内核档：分发字全程序共享。解释器本体在 WASM 里，逐函数置换不再
    // 增大静态分析成本，反而要求 WASM 侧按函数查表；共享编号让模块只留一张
    // 「分发字 → 语义号」表。未被占用的槽位就是干扰字，映射只有模块数据段知道。
    const sh = ctx.__vmWasmShared;
    opNums.clear();
    for (const k of opKinds) {
      let w = sh.wordOf.get(k);
      if (w === undefined) {
        if (sh.next >= sh.slots.length) throw new Error(msg('vmWasmTableFull'));
        w = sh.slots[sh.next++];
        sh.wordOf.set(k, w);
      }
      opNums.set(k, w);
    }
    decoys = [];
  } else {
    opKinds.forEach((k, i) => opNums.set(k, slotOrder[i]));
  }
  // ---- 轮换量：由「链值」驱动（2026-09-28 落地）----
  //
  // rot = ((前一字明文 * DYN_P) ^ DYN_Q) & (N-1)，z=0 时前一字不存在，取 CHAIN_SEED。
  //
  // 为什么不用字下标当输入（那是 2026-09-27 之前的做法）：下标是整条字节码里的常量，
  // 轮换量于是也是常量——同一位置在任何一次运行、任何一份产物里都解出同一个动作。
  // 改成链值之后，轮换量随前面那个字的实际明文变化：改一个字节码字，后面所有
  // opcode 的解读都会跟着变。
  //
  // ---- 另一条路：为什么不由运行期掩码 MASK 驱动 ----
  //
  // 记在这里免得重复推导。rotStmts 每次调用入口会把整条 B 数组重新 XOR 一遍
  // （B[z] ^= MASK ^ nm），所以解码出的明文是不变量。轮换量若依赖 MASK，第二
  // 次调用解出的规范编号就与构建期不同 → 字节码解成垃圾。要修就得在每次入口把
  // opcode 字按新轮换量重写一遍，而「哪些字是 opcode 字」必须显式给出来——那就是
  // 操作码位置表（已评估否决：解密后在内存里就是一张明文索引表）。所以「随运行
  // 状态演化」只能走链值这条，它不需要额外给出任何位置信息。
  //
  // ---- 代价：opcode 字从「具体值」变成「计算值」----
  //
  // 位置驱动时 opcode 字直接算好落库；链值驱动时它依赖 words[z-1]，而那一字可能
  // 本身是链值字或另一个 opcode 字，所以本字也得等求解器迭代。于是三处要改：
  //   · null 这个占位符现在同时表示链值字与 opcode 字，得靠 opWordZ 区分；
  //   · 不动点循环必须每轮重算 opcode 字——只算 null 的话第一轮填进去之后它们
  //     就成了"具体值"不再重算，而链值字一变，下游 opcode 全部陈旧；
  //   · 环上更要紧：链值字按定义就是跳转指令的最后一个字，紧接着就是下一条指令的
  //     opcode 字，所以链值每次变化都级联到下一个轮换量。
  // 这三件都在下方 wordAt 与不动点循环里处理，另加一道收敛校验（没到不动点就宁可
  // 构建失败，也不放一份"能跑但结果错"的产物出去）。
  //
  // （2026-09-27 那版结论里提到 targetChainOf 需要跟着改——实际那个函数是死代码，
  //  只有定义没有调用，本次一并删掉了。）
  const rotMask = totalSlots - 1;
  const rotOf = (chain) => ((Math.imul(chain, DYN_P) ^ DYN_Q) & rotMask);
  if (dynOps && ctx.__vmDyn) { ctx.__vmDyn.applied = true; ctx.__vmDyn.space = totalSlots; }
  // 桶数随指令集规模扩展，桶内大致保持 24 项线性比对；无干扰项时沿用原公式。
  // P3 随机化补强：基数乘一个 1.0~1.4 的随机因子，桶数公式本身逐构建漂移，
  // 「桶内 24 项」这条可被脚本化的结构规律因此不成立。桶数最终仍取 2 的幂。
  const nbRaw = decoys.length
    ? Math.max(8, Math.min(64, Math.ceil((opKinds.length + decoys.length) * (1 + randInt(0, 40) / 100) / 24)))
    : Math.max(2, Math.min(6, Math.ceil(opKinds.length / 3)));
  let nbuckets = 1;
  while (nbuckets < nbRaw) nbuckets <<= 1;
  // 桶数取 2 的幂，按高位取桶，非负模退化成一次无符号右移，省掉整数除法。
  // 桶号是解释器每条指令都要算的项，这一步对热路径有实际意义。取高位还消除了
  // 桶号只由分发字低位决定的下位相关性，位与和取模都只反映 d 的低位，右移形不泄露 d mod nb。
  const DISP_SH = 32 - Math.round(Math.log2(nbuckets));
  const dispBucket = (d) => (Math.imul(d, DISP_P1) + DISP_Q1) >>> DISP_SH;

  const pos = new Array(code.length);
  let acc = 0;
  for (let i = 0; i < code.length; i++) {
    pos[i] = acc;
    acc += opWordWidth(code[i]);
  }
  // 链式加密布局。
  // 链值取前一字的明文，字 -1 的链值是 CHAIN_SEED。密文 flat[z] 等于
  // 明文 ^ 位置分量 ^ 初始掩码 ^ chainAt[z]，其中 chainAt[z] 就是前一字的明文。
  // 任何一字的解密都要用到前一字的明文，没法从任意下标单独解密，只能从字 0 顺序推进。
  // 跳转指令额外携带目标处的链值字，跳转之后链状态就恢复成目标处的预期值。
  const CHAIN_SEED = krand(1, 0xfffffff) | 0;
  // 字布局：owner[z] = { instr, slot }（slot 0=opcode, 1/2=操作数, 3=链值字）
  const owner = [];
  const words = []; // 明文字，null 是「待求值」占位（链值字与动态 opcode 字），后面迭代填上
  const opCanon = []; // 仅动态操作码：字下标 -> 该字未轮换前的规范编号
  for (let i = 0; i < code.length; i++) {
    const e = code[i];
    const isJump = JUMP_KINDS.has(e.op);
    const w = opWordWidth(e);
    for (let s = 0; s < w; s++) owner.push({ instr: i, slot: s });
    // 动态操作码：存进字节码的是「规范编号 − rotOf(前一字明文)」。前一字是计算值，
    // 所以本字也交给求解器算（推平成 null 占位，规范编号记进 opCanon）；位置驱动
    // 时代这里是一行算完的定值。pos[i] 仍是本条指令 opcode 字的字下标，运行期不再
    // 用它算轮换量，只用来定位取指。
    if (dynOps) {
      opCanon[words.length] = opNums.get(e.op);
      words.push(null);
    } else {
      words.push(opNums.get(e.op));
    }
    if (MACRO_KINDS.has(e.op)) {
      // 宏指令：n 个打包操作数逐字落流。宏的动作体自己按顺序取走它们，
      // 取指顺序与原来逐条执行时完全一致。
      for (const v of e.args) words.push(v);
    } else if (ARG2_KINDS.has(e.op)) {
      words.push(jumpEnc ? pos[e.a] - pos[i] : pos[e.a]); words.push(e.n);
      if (isJump) words.push(null);
    } else if (isJump) {
      words.push(jumpEnc ? pos[e.a] - pos[i] : pos[e.a]); words.push(null);
    } else if (ARG1_KINDS.has(e.op)) {
      words.push(e.a);
    }
  }
  // 尾部垃圾字。END 早已 return，这些字永不取指，只用来干扰静态分段与长度指纹
  const junkN = randInt(4, 12);
  for (let j = 0; j < junkN; j++) { owner.push({ instr: -1, slot: 0 }); words.push(randInt(0, 0xffff)); }
  // 指令 opcode 字下标
  const opZ = new Map();
  // opWordZ 恒为 Set（不能是 null——下面的 wordAt 与不动点循环无条件调 .has，
  // null 会抛 TypeError；而那个异常会被编译循环的 try/catch 吞掉，表现为"该函数
  // 保持原样"，实际却是解释器运行时没发出来，自检只报出一堆未绑定引用）。
  // 填充必须与 opCanon 同开同关：一旦非空，不动点循环就把这些字当「计算值」
  // 每轮重算，而 opCanon 仅在 dynOps 下才填。否则 dynOps=false（四个预设的默认值）
  // 时 opcode 字会被重算成 (undefined - rot) & mask 的垃圾，整条字节码报废。
  const opWordZ = new Set();
  for (let z = 0; z < words.length; z++) {
    if (owner[z].instr >= 0 && owner[z].slot === 0) {
      opZ.set(owner[z].instr, z);
      if (dynOps) opWordZ.add(z);
    }
  }
  // 链值字求解。链值字的明文等于所属跳转目标的链值，而目标 opcode 的前一字可能又是
  // 另一个跳转的链值字，所以要递归展开并记忆化。环上的依赖来自跳转目标互指，每个环上
  // 字的值最终由环外的锚定字决定，按值传播就能解出来。
  //
  // 动态操作码开启时 opcode 字也走这里：它的明文是「规范编号 − rotOf(前一字明文)」，
  // 与链值字一样是算出来的。所以判断顺序上 opcode 字必须先认——第一轮迭代
  // 之后 words[z] 已非 null，若按「非 null 即具体值」提前返回，它就再也不被重算；
  // 而它依赖的前一字（多半是上一条指令末尾的链值字）后面还会变，一变它就陈旧。
  const memo = new Map(); // 字下标 -> 已求明文
  const solving = new Set(); // 递归栈（环检测）
  const wordAt = (z) => {
    if (memo.has(z)) return memo.get(z);
    if (opWordZ.has(z)) {
      if (solving.has(z)) return 0;
      solving.add(z);
      const prev = z === 0 ? CHAIN_SEED : wordAt(z - 1);
      solving.delete(z);
      const r = (opCanon[z] - rotOf(prev)) & rotMask;
      memo.set(z, r);
      return r;
    }
    const v = words[z];
    if (v !== null) { memo.set(z, v); return v; }
    if (solving.has(z)) return 0; // 遇到环先以 0 暂定，等环外的值流入后再修正
    solving.add(z);
    const o = owner[z];
    // 目标 opcode 字下标的前一字
    const tz = opZ.get(code[o.instr].a);
    const prev = tz === 0 ? CHAIN_SEED : wordAt(tz - 1);
    solving.delete(z);
    memo.set(z, prev);
    return prev;
  };
  // 环处理。环内字互相依赖时第一遍先以 0 暂定，第二遍用已定值重解，反复迭代到稳定。
  // 环上字的真实值由环外第一个非环依赖链的锚定字传播而来。
  let round = 0;
  let progressed = true;
  while (progressed && round++ < words.length + 4) {
    progressed = false;
    memo.clear();
    for (let z = 0; z < words.length; z++) {
      // 判据是「opcode 字或待求值」，不是只判 null。opcode 字必须每轮重算：
      // 它依赖的前一字可能在本轮稍后才被修正，只算一轮就会留下陈旧值。
      if (opWordZ.has(z) || words[z] === null) {
        const v = wordAt(z);
        if (words[z] !== v) { words[z] = v; progressed = true; }
      } else {
        memo.set(z, words[z]);
      }
    }
  }
  if (words.some((w) => w === null)) throw new Error(msg('vmChainSolveFailed'));
  // 收敛校验。跑满轮数上限仍在变化 = 没到不动点：此时 words 已非 null，存的是上一轮
  // 的中间值，而解码端按最终链值算出的规范编号会与构建期不一致——字节码解成垃圾，
  // 而且不报错，属于那种能出包、能跑、结果错的坏产物。宁可构建失败。
  // 只在动态操作码开启时校验：位置驱动没有这条额外依赖边，别给它新增失败面。
  if (dynOps && progressed) throw new Error(msg('vmChainSolveFailed'));
  // 逐字求链值并生成密文。分块开启时密文多异或一项块密钥（P4）。
  const chainAt = new Array(words.length);
  const flat = [];
  {
    let c = CHAIN_SEED;
    for (let z = 0; z < words.length; z++) {
      chainAt[z] = c;
      flat.push(enc
        ? (((words[z] ^ posMask(z + 1)) ^ MASK_M0 ^ c ^ bkOf(z)) | 0)
        : (words[z] | 0)); // 编码关闭：明文落库，链值仍留下一项但无人取用
      c = words[z];
    }
  }

  // ---- WASM 解释器内核档：函数体降级成一句桥接调用，解释循环在共享模块内 ----
  //
  // 要嵌套（vmLayers>=2）的函数不走这里：bridge 体里没有 JS 解释器循环，无物可套。
  // 这类函数改走下面的 JS 解释器路径，嵌套成功后内外层各有独立字节码；嵌套失败则
  // 回退单层 JS 解释器（仍正确，只是没进模块）。代价是这些函数不享受"桥接瘦身"
  // 带来的下游 pass 加速——见 wasm-bench 的 pass 耗时分布，这是用户用 vmLayers
  // 换保护深度的明确 trade-off，不是性能回退。
  // 嵌套让路计数（stats.nestedJs 用）：wasm 下走 JS 路径的函数数。
  if (wantNestingHere && ctx.__vmWasmShared) ctx.__vmNestJs = (ctx.__vmNestJs | 0) + 1;
  if (ctx.__vmWasmShared && !wantNestingHere) {
    if (!ctx.__vmBridgeName) ctx.__vmBridgeName = uniqueName(ctx.usedNames, '_0x');
    const fIdx = (ctx.__vmWasmCount = (ctx.__vmWasmCount || 0) + 1) - 1;
    const paramOrder = [];
    for (const p of fn.params) {
      for (const nm in t.getBindingIdentifiers(p)) paramOrder.push(nm);
    }
    if (paramOrder.length > 64) throw new Error(msg('vmWasmTooManyParams'));
    const argslots = paramOrder.map((nm) => (slotOf.has(nm) ? slotOf.get(nm) : -1));
    const dirStmtsW = directiveStmts(origDirectives);
    fn.__wasmVmMeta = {
      fIdx, flat, MASK_K1, MASK_K2, MASK_M0, CHAIN_SEED,
      nSlots: slotOf.size, segLen: flat.length, argslots,
      kinds: [...usedOps],
      stringsEnc, STR_P, STR_K1, STR_K2, STR_M0,
    };
    // 桥接体：G/H/K/J 仍按调用重建（闭包按词法解析回原作用域），参数经桥接转句柄
    fn.body = t.blockStatement([
      t.variableDeclaration('var', [
        t.variableDeclarator(G, t.arrayExpression(getterNodes)),
        t.variableDeclarator(H, t.arrayExpression(setterNodes)),
        t.variableDeclarator(K, t.arrayExpression(consts)),
        t.variableDeclarator(J, t.arrayExpression(stringsEnc.map((row) =>
          t.arrayExpression(row.map((n) => t.numericLiteral(n)))))),
        ...[...captured].map((name) => t.variableDeclarator(t.identifier(name))),
      ]),
      t.returnStatement(t.callExpression(t.identifier(ctx.__vmBridgeName), [
        t.numericLiteral(fIdx), G, H, K, J,
        t.arrayExpression(paramOrder.map((nm) => t.identifier(nm))),
      ])),
    ]);
    fn.body.body.unshift(...dirStmtsW);
    if (fn.type === 'ArrowFunctionExpression') fn.expression = false;
    compiledSet.add(fn);
    // 共享档不按函数字面量计干扰项，但要让调用方知道这一档换了口径（2026-10-01 修）。
    //
    // 这里的 0 是真值——本函数字面量确实没生成干扰处理器（解释器在 WASM 里，
    // 共享槽里未被占用的槽本身就是干扰字，见上面 decoys = [] 那段）。但
    // stats.ops.decoy 报 0 会被读成"这一档没有干扰项"：max 档因此看起来比
    // high 弱一个数量级（ops 45 vs 1280），实际差的是 per-function 与全程序
    // 共享两种编号空间，干扰强度并不低。
    //
    // 三个数统一在 vm() 返回前按共享表重算，这里只带一个 shared 标记让累加处跳过。
    return { real: usedOps.size, decoy: 0, shared: !!ctx.__vmWasmShared };
  }

  // 解释器 case 生成。
  // 取指是链式的，B[PC++] 在 PC 已自增为下标加一之后取值，结果再异或位置分量、当前掩码
  // 与链值。链值取前一字的解密值，字 -1 的链值就是 CHAIN_SEED。因为解密要用到前一明文，
  // 没法从任意下标静态解出单字，只能从字 0 顺序推进。跳转目标处的链值在构建期预置，
  // 跳转指令同时携带目标链值。
  const nCHAIN = uniqueName(ctx.usedNames, '_0x'); // 当前链值变量
  const nCHN = uniqueName(ctx.usedNames, '_0x');   // 取指暂存，存放新链值
  // 取指统一形态：先解出新字 v，再推进链 nCHAIN = v，dst 给定时同时存入。
  // 跳转的链值字是例外，它本身就是目标处的预期链值，取它之后 nCHAIN 即为该值，
  // 自洽推进，不需要特判。
  //
  // XOR 操作数树随机化，让解密式的括号结构不固定。解密式是四操作数 XOR，即取指字、
  // 位置分量、掩码与链值。XOR 可交换可结合，任意二叉组合树都语义恒等，所以每函数每个
  // 取指位随机选一棵树，操作数顺序与结合结构逐构建漂移，按固定括号结构做模板匹配或
  // 归纳的还原规则无法跨构建复用。wasm 桥接面不受影响，桥接只按子树特征定位
  // Math.imul 与 B[pc++] 节点，与树形无关。
  const xorTree = (nodes) => {
    if (nodes.length === 1) return nodes[0];
    const cut = randInt(1, nodes.length - 1);
    return t.binaryExpression('^', xorTree(nodes.slice(0, cut)), xorTree(nodes.slice(cut)));
  };
  const bAt = (dst) => {
    const fetch = t.memberExpression(B, t.updateExpression('++', PC, false), true);
    // P4 分块自解密：块密钥项 (imul((npc-1) >>> BL_SH, BK_A) ^ BK_B)。
    // npc 已自增为字下标+1，块号要用取指前的下标（npc-1）。BL_SH/BK_A/BK_B
    // 是逐函数随机的字面量，散进 XOR 树里与位置分量、掩码、链值并列。
    const blkTerm = useBlock ? t.binaryExpression('^',
      rtlib.mulCall(ctx,
        t.binaryExpression('>>>',
          t.binaryExpression('-', t.identifier(npc), t.numericLiteral(1)),
          kLit(BL_SH, rt && rt.BS)),
        kLit(BK_A, rt && rt.BA)),
      kLit(BK_B, rt && rt.BB)) : null;
    const dec = enc ? xorTree([
      fetch,
      t.binaryExpression('^',
        t.binaryExpression('>>>',
          rtlib.mulCall(ctx, t.identifier(npc), kLit(MASK_K1, rt && rt.K1)),
          t.numericLiteral(8)),
        kLit(MASK_K2, rt && rt.K2)),
      MASK,
      t.identifier(nCHAIN),
      ...(blkTerm ? [blkTerm] : []),
    ]) : fetch;
    // 序列式结果：nCHN = v, nCHAIN = nCHN, 可选 dst = nCHN，整个表达式的值取 nCHN
    const parts = [
      t.assignmentExpression('=', t.identifier(nCHN), dec),
      t.assignmentExpression('=', t.identifier(nCHAIN), t.identifier(nCHN)),
    ];
    if (dst) parts.push(t.assignmentExpression('=', t.identifier(dst), t.identifier(nCHN)));
    parts.push(t.identifier(nCHN));
    return t.sequenceExpression(parts);
  };
  const Slen = () => morph.memberDot(S, 'length');
  // topElem 是原样栈顶（已编码值），供 DUP 直接复制；topVal 是解码后的真值，
  // 供条件跳转判值、GETMK 取键这类"要用真值"的地方。
  const topElem = () => t.memberExpression(S,
    t.binaryExpression('-', Slen(), t.numericLiteral(1)), true);
  const topVal = () => seCall(topElem());
  // 任意数组的栈顶引用。地址栈与操作数栈共用同一形态
  const topOf = (arr) => t.memberExpression(arr,
    t.binaryExpression('-',
      t.memberExpression(arr, t.identifier('length'), false), t.numericLiteral(1)), true);
  const declConst = (name, init) =>
    t.variableDeclaration(morph.declKind(), [t.variableDeclarator(t.identifier(name), init)]);
  const idn = (n) => t.identifier(n);
  const assignPC = (val) => t.expressionStatement(t.assignmentExpression('=', PC, val));
  // 跳转目标还原。开启 jumps 编码后操作数存的是差值，要用取指游标还原本指令的字下标：
  // npc 此时已自增到「读完本指令全部字」的位置，减去本指令的字跨度就是它的字下标。
  // 跨度：JMP / JPF / JPT 三个字（op、目标、链值），JANDK 系四个字（op、目标、数量、链值）。
  const jumpTarget = (deltaNode, span) => (jumpEnc
    ? t.binaryExpression('+', deltaNode,
        t.binaryExpression('-', t.identifier(npc), t.numericLiteral(span)))
    : deltaNode);
  // 解释器 case 体里的局部名。
  //
  // 不能用 a / b / c / v / f / k / o / x0 这类短名：解释器的语句是直接塞进用户
  // 函数体里的，而 declJmpA 用的是 `var`，会提升到函数作用域——用户只要有个变量叫
  // a，第一条 if 的跳转分支就会把它写成跳转目标地址，之后 typeof a 恒得 "number"。
  // （2026-09-21 修：medium/high/max 档下，函数里有名为 a 的变量且不止一条 if，
  // 产物就会静默算错。）改成 uniqueName 生成并登记进 usedNames，就不会与用户标识符
  // 冲突——必须登记，否则 mangle 之后仍可能撞上。
  const N_A = uniqueName(ctx.usedNames, '_0x');
  const N_B = uniqueName(ctx.usedNames, '_0x');
  const N_C = uniqueName(ctx.usedNames, '_0x');
  const N_V = uniqueName(ctx.usedNames, '_0x');
  const N_N = uniqueName(ctx.usedNames, '_0x');
  const N_F = uniqueName(ctx.usedNames, '_0x');
  const N_K = uniqueName(ctx.usedNames, '_0x');
  const N_O = uniqueName(ctx.usedNames, '_0x');
  // 宏指令的操作数暂存名。每个打包字取指一次、解码两次（选源位与下标位），
  // 所以要绑到临时名上；上限 4 与 MACRO_KINDS 的最长段长一致。
  // 关闭本项时不占名：uniqueName 会推进随机名字流，白占四个名会让同种子下的
  // 其余名字整体错位，产物与改造前不再逐字节一致。
  const macroArgNames = macroOps
    ? Array.from({ length: 4 }, () => uniqueName(ctx.usedNames, '_0x'))
    : [];
  // 宏操作数的取源表达式表，下标即打包字的低两位（见 MACRO_SRC_CODE）：
  //   0 常量池 K        —— 与 LDC 的动作体同义
  //   1 槽位面 V        —— 与 LOD 的动作体同义
  //   2 外层名 getter G —— 与 GET 的动作体同义
  //   3 常量池闭包调用  —— 与 FRAG 的动作体同义
  // 四种都只做「取一个值」，所以能串成一棵条件表达式树，宏体不必用分支语句；
  // 打包字高位的下标要左移还原（打包时左移了两位）。
  const macroSrc = (w) => {
    const idx = () => t.binaryExpression('>>', idn(w), t.numericLiteral(2));
    return [
      t.memberExpression(K, idx(), true),
      t.memberExpression(V, idx(), true),
      t.callExpression(t.memberExpression(G, idx(), true), []),
      t.callExpression(t.memberExpression(K, idx(), true), []),
    ];
  };
  // 形参名按下标缓存，同一条指令内的多个参数共用一个池，彼此不冲突
  const argNameCache = [];
  const argNames = (count) => {
    for (let i = argNameCache.length; i < count; i++) argNameCache.push(uniqueName(ctx.usedNames, '_0x'));
    return argNameCache.slice(0, count);
  };

  // 栈编解码。SE 幂等，编解码共用；只在压栈/出栈点各调用一次，
  // 绝不把 S.pop() 这类有副作用的表达式内联展开（展开三次就会弹三次）。
  const seCall = (x) => (stackEnc ? t.callExpression(t.identifier(nSE), [x]) : x);
  // 压栈形态二选一：S.push(v) ↔ S[S.length]=v。语句位置（返回值丢弃）、真数组、
  // 操作数求值一次，三者齐了才恒等。每次压栈独立随机，同一函数内两种形态混排。
  const SPUSH = (x) => (randInt(0, 1) === 0
    ? t.callExpression(morph.memberDot(S, 'push'), [seCall(x)])
    : t.assignmentExpression('=',
        t.memberExpression(S, morph.memberDot(S, 'length'), true),
        seCall(x)));
  const SPUSHRAW = (x) => t.callExpression(
    morph.memberDot(S, 'push'), [x]); // 复制已编码值，不能再编一次
  const SPOPRAW = () => t.callExpression(morph.memberDot(S, 'pop'), []);
  const SPOP = () => seCall(SPOPRAW());

  // 压栈 / 出栈。
  const pushR = (val) => [t.expressionStatement(SPUSH(val))];
  const popR = () => SPOP();
  // 部分 case 直连栈、部分 case 走通临时暂存，同一指令两种形态按位置决定。
  const pushCall = (x) => t.expressionStatement(SPUSH(x));
  const popCall = () => SPOP();

  // 成员访问的读写对象/键都从操作数栈弹。
  const popMemberTarget = () => ({ obj: () => popR(), key: () => popR() });

  // MKS 的临时名逐函数唯一，避免与 case 体里其它分支的局部名互相遮蔽
  const nSX = uniqueName(ctx.usedNames, '_0x'); // 字符串表下标
  const nSS = uniqueName(ctx.usedNames, '_0x'); // 该字符串的码元表
  const nSO = uniqueName(ctx.usedNames, '_0x'); // 还原中的累积串
  const nSJ = uniqueName(ctx.usedNames, '_0x'); // 码元游标

  /**
   * 字符串表还原：把第 siNode 项的码元密文表解回 string。
   * 返回语句序列；还原结果留在变量 nSO 里，调用方把它压栈。
   */
  const mksDecode = (siNode) => [
    declConst(nSX, siNode),
    declConst(nSS, t.memberExpression(J, idn(nSX), true)),
    t.variableDeclaration('var', [t.variableDeclarator(idn(nSO), t.stringLiteral(''))]),
    t.forStatement(
      t.variableDeclaration('var', [t.variableDeclarator(idn(nSJ), t.numericLiteral(0))]),
      morph.relCmp('<', idn(nSJ), morph.memberDot(idn(nSS), 'length')),
      morph.incUpd(nSJ),
      t.blockStatement([
        t.expressionStatement(t.assignmentExpression('=',
          idn(nSO),
          t.binaryExpression('+', idn(nSO), fccCall(t.binaryExpression('^',
            t.memberExpression(idn(nSS), idn(nSJ), true),
            strPosExpr(
              rtlib.mulCall(ctx,
                t.binaryExpression('+', idn(nSX), t.numericLiteral(1)),
                t.numericLiteral(STR_P)),
              idn(nSJ))))))),
      ])),
  ];

  function caseBody(kind) {
    if (kind === 'LDC') return pushR(t.memberExpression(K, bAt(), true));
    if (kind === 'LOD') return pushR(t.memberExpression(V, bAt(), true));
    if (kind === 'STR') return [t.expressionStatement(t.assignmentExpression('=',
      t.memberExpression(V, bAt(), true), popR()))];
    if (kind === 'GET') return [pushCall(t.callExpression(t.memberExpression(G, bAt(), true), []))];
    if (kind === 'SET') return [t.expressionStatement(t.callExpression(
      t.memberExpression(H, bAt(), true), [popR()]))];
    if (kind === 'FRAG') return pushR(t.callExpression(t.memberExpression(K, bAt(), true), []));
    if (kind === 'EXEC') return [t.expressionStatement(t.callExpression(
      t.memberExpression(K, bAt(), true), []))];
    // MKS 在 VM 内部把码元密文表还原成 string 并压栈。项序号来自字节码操作数，
    // 位置散列常数只存在于解释器指令流里，静态面拿不到明文串也拿不到还原公式。
    if (kind === 'MKS') return [...mksDecode(bAt()), ...pushR(idn(nSO))];
    if (kind === 'GETM') return [
      declConst(N_B, popMemberTarget().key()), declConst(N_A, popMemberTarget().obj()),
      ...pushR(t.memberExpression(idn(N_A), idn(N_B), true)),
    ];
    // SETM：赋值流的对象从未离开操作数栈（见 emitMemberObject）。
    // 三种模型统一从这里弹 3 个值（值、键、对象）。
    if (kind === 'SETM') return [
      declConst(N_C, popR()), declConst(N_B, popR()), declConst(N_A, popR()),
      t.expressionStatement(t.assignmentExpression('=',
        t.memberExpression(idn(N_A), idn(N_B), true), idn(N_C))),
      ...pushR(idn(N_C)), // 成员存完之后压回，作为赋值表达式的结果
    ];
    // GETMK：把成员目标对象、键与当前值（o[k]）压栈，供 SETM 回写或提前定值弹栈。
    // 复制栈顶两个（o、k）再求 o[k]，S = [..., o, k, o[k]]。
    if (kind === 'GETMK') {
      return [pushCall(t.memberExpression(
        seCall(t.memberExpression(S, t.binaryExpression('-', Slen(), t.numericLiteral(2)), true)),
        topVal(), true))];
    }
    if (kind === 'DUP') return [t.expressionStatement(SPUSHRAW(topElem()))];
    if (kind === 'POP') return [t.expressionStatement(popCall())];
    // P4 模型 M2：把操作数栈顶搬到地址栈。只在 M2 的成员目标处出现。
    // 跳转类取目标字与目标链值字，跳转之后 PC 与链状态一起重置。
    // N_A 要用 var 预声明：bAt 的序列式里含 N_A=nCHN 的赋值，若用 const
    // 初始化器会在内部自引用触发 TDZ。
    const declJmpA = () => t.variableDeclaration('var', [
      t.variableDeclarator(idn(N_A)), t.variableDeclarator(idn(N_C))]);
    if (kind === 'JMP') return [
      declJmpA(),
      t.expressionStatement(t.assignmentExpression('=', idn(N_A), bAt(N_A))),
      t.expressionStatement(bAt(null)), // 链值字，取走后 nCHAIN 即为目标链值
      assignPC(jumpTarget(idn(N_A), 3)),
    ];
    if (kind === 'JPF' || kind === 'JPT') {
      // 链值字在两个互斥分支里各取一次。跳转时 nCHAIN 变成目标链值；不跳时
      // nCHAIN 变成链值字明文，也就是顺序下一字的预期链值，构建期 pushWord 之后
      // curChain 就是该值，两条路径都自洽。条件已在 test 的 pop 里求完，
      // 不跳分支不需要再弹栈。
      return [
        declJmpA(),
        t.expressionStatement(t.assignmentExpression('=', idn(N_A), bAt(N_A))),
        t.ifStatement(
          kind === 'JPF' ? t.unaryExpression('!', popCall()) : popCall(),
          t.blockStatement([
            t.expressionStatement(bAt(null)), // 链值字，取走后 nCHAIN 即为目标链值
            assignPC(jumpTarget(idn(N_A), 3)),
          ]),
          t.blockStatement([
            t.expressionStatement(bAt(null)), // 链值字，取走后 nCHAIN 即为顺序预期值
          ])),
      ];
    }
    // 融合关系跳转（JLT/JLE/JGT/JGE/JEQ/JNE 真极性 + JLTF 等假极性）：
    // 弹两个值比较，条件成立时跳。求值顺序（先左后右、各一次）由发射器保证，
    // 这里复现同一次比较与同一次跳转，与"比较压栈 + JPF/JPT"逐位一致。
    // 假极性把 `!` 包在原比较外面（NaN 下 !(a<b) 与 a>=b 不等价，不敢反转算子）。
    // 链字两条路径各取一次、目标字宽 3，与 JPF 同式。
    const fusedRel = FUSED_REL_OPS[kind];
    if (fusedRel !== undefined) {
      const cmp = t.binaryExpression(fusedRel, idn(N_V), idn(N_B));
      return [
        declJmpA(),
        t.expressionStatement(t.assignmentExpression('=', idn(N_A), bAt(N_A))),
        declConst(N_B, popR()), // 先弹的是右操作数（后压栈）
        declConst(N_V, popR()), // 再弹左操作数
        t.ifStatement(
          kind.endsWith('F') ? t.unaryExpression('!', cmp) : cmp,
          t.blockStatement([
            t.expressionStatement(bAt(null)), // 链值字，取走后 nCHAIN 即为目标链值
            assignPC(jumpTarget(idn(N_A), 3)),
          ]),
          t.blockStatement([
            t.expressionStatement(bAt(null)), // 链值字，取走后 nCHAIN 即为顺序预期值
          ])),
      ];
    }
    if (kind === 'JANDK' || kind === 'JORK' || kind === 'JNULK') {
      // JANDK 对应 &&，假值时保留跳转；JORK 对应 ||，真值时保留跳转；
      // JNULK 对应 ??，非 nullish 时保留跳转，判断条件是 v != null。
      // 布局为 a 放目标、n 放数量、chain 放目标链值字。三者无条件顺序取走，
      // 链值字取走之后 nCHAIN 即目标链值，而它同时就是顺序下一字的预期链值，同值自洽。
      const cond = kind === 'JANDK' ? t.unaryExpression('!', idn(N_V))
        : kind === 'JORK' ? idn(N_V)
        : t.binaryExpression('!=', idn(N_V), t.nullLiteral());
      return [
        declJmpA(),
        t.expressionStatement(t.assignmentExpression('=', idn(N_A), bAt(N_A))),
        declConst(N_N, bAt(null)),
        t.expressionStatement(bAt(null)), // 链值字，nCHAIN 落到目标链值，也是顺序预期值
        declConst(N_V, topVal()),
        t.ifStatement(
          cond,
          t.blockStatement([
            t.expressionStatement(t.callExpression(
              t.memberExpression(S, t.identifier('splice'), false), [
                t.binaryExpression('-',
                  t.binaryExpression('-', Slen(), t.numericLiteral(1)), idn(N_N)),
                idn(N_N),
              ])),
            assignPC(jumpTarget(idn(N_A), 4)),
          ]),
          t.blockStatement([t.expressionStatement(popCall())])),
      ];
    }
    if (kind === 'RET') return [t.returnStatement(popR())];
    if (kind === 'RETU' || kind === 'END') return [morph.retVoid()];
    if (kind === 'THR') return [t.throwStatement(popR())];
    if (kind.startsWith('BIN_')) return [
      declConst(N_B, popR()), declConst(N_A, popR()),
      ...pushR(t.binaryExpression(kind.slice(4), idn(N_A), idn(N_B))),
    ];
    if (kind.startsWith('UN_')) return [
      declConst(N_A, popR()),
      ...pushR(t.unaryExpression(kind.slice(3), idn(N_A))),
    ];
    if (kind.startsWith('CALL_')) {
      const args = argNames(+kind.slice(5));
      return [
        ...args.slice().reverse().map((nm) => declConst(nm, popR())),
        declConst(N_F, popR()),
        ...pushR(t.callExpression(idn(N_F), args.map(idn))),
      ];
    }
    if (kind.startsWith('CALLM_')) {
      const args = argNames(+kind.slice(6));
      return [
        ...args.slice().reverse().map((nm) => declConst(nm, popR())),
        declConst(N_K, popR()), declConst(N_O, popR()),
        ...pushR(t.callExpression(t.memberExpression(idn(N_O), idn(N_K), true), args.map(idn))),
      ];
    }
    if (kind.startsWith('NEW_')) {
      const args = argNames(+kind.slice(4));
      return [
        ...args.slice().reverse().map((nm) => declConst(nm, popR())),
        declConst(N_F, popR()),
        ...pushR(t.newExpression(idn(N_F), args.map(idn))),
      ];
    }
    if (kind.startsWith('ARR_')) {
      const args = argNames(+kind.slice(4));
      return [
        ...args.slice().reverse().map((nm) => declConst(nm, popR())),
        ...pushR(t.arrayExpression(args.map(idn))),
      ];
    }
    // 宏指令 MPKn：把 n 条被合并的装载指令的动作体按原顺序展开。
    // 每个操作数是一个打包字：低两位选源（见 macroSrc 表），高位是下标。
    // 取指与 LDC / LOD / GET / FRAG 走同一条 bAt()，所以链式解密、掩码轮换、位置分量
    // 全部沿用，字流长度也正好是 1 + n。压栈沿用 pushR，栈编码行为不变。
    // 之所以能直接拼接：被合并的每条指令原本只做「取一个字 → 按源取一个值 → 压栈」，
    // 三者互不依赖，顺序执行与逐条执行恒等；源位在运行期用条件表达式选，等价于原来
    // 由分发字选动作体，少了一次分发。
    if (kind.startsWith('MPK')) {
      const n = +kind.slice(3);
      const out = [];
      for (let k = 0; k < n; k++) {
        const w = macroArgNames[k];
        out.push(declConst(w, bAt()));
        const src = macroSrc(w);
        // 低位为 0 取常量池、为 1 取槽位面……依次串成条件表达式链
        let val = src[3];
        for (let s = 2; s >= 0; s--) {
          val = t.conditionalExpression(
            morph.yodaEq(
              t.binaryExpression('&', idn(w), t.numericLiteral(3)),
              t.numericLiteral(s)),
            src[s], val);
        }
        out.push(...pushR(val));
      }
      return out;
    }
    // NOP（流干扰）：动作体为空，进分发即下一条。与干扰项的区别是它真的进
    // 字节码流（干扰项只占编号）；线性扫描器看到的是"有编号、有槽位、执行无事
    // 发生"的真指令。toActionFn（表驱动形态）包一层空块同样无害。
    if (kind === 'NOP') return [];
    throw new Error(msg('vmUnknownOpcode', { kind }));
  }

  // 干扰项处理器池，每构建随机生成，JN 个箭头函数共享，体量因此可控。
  // 每个干扰体都是净无副作用的：只读栈长、K、B、PC、MASK，读写垃圾暂存数组与双暂存，
  // push 与 pop 相互对冲。它绝不触碰 V 槽位内容、G/H 闭包，也不写 PC、nCHAIN 与掩码。
  // 干扰体的结构与真实动作同形，栈访问、槽位式写都齐备，无法按形态过滤。
  const nDV = uniqueName(ctx.usedNames, '_0x'); // 垃圾暂存数组（形似 V 槽位面）
  const nT0 = uniqueName(ctx.usedNames, '_0x');
  const nT1 = uniqueName(ctx.usedNames, '_0x');
  const scratchDecls = [
    t.variableDeclarator(idn(nDV), t.arrayExpression(
      // P3 随机化补强：初值改为随机非零小整数。全零初值本身就是「这是垃圾数组」
      // 的静态特征（真实槽位面几乎不会是全零），随机初值让它与 V 槽位面同形。
      Array.from({ length: randInt(4, 8) }, () => t.numericLiteral(randInt(1, 0x7fff))))),
    t.variableDeclarator(idn(nT0), t.numericLiteral(randInt(1, 0xffff))),
    t.variableDeclarator(idn(nT1), t.numericLiteral(randInt(1, 0xffff))),
  ];
  const junkNames = [];
  const junkDecls = [];
  const JN = decoys.length ? Math.min(24, Math.max(10, Math.ceil(decoys.length / 48))) : 0;
  const slenE = () => morph.memberDot(S, 'length');
  const junkReg = () => t.memberExpression(idn(nDV), t.binaryExpression('%',
    t.binaryExpression('+', PC, t.numericLiteral(randInt(0, 7))),
    morph.memberDot(idn(nDV), 'length')), true);
  const junkStmt = () => {
    switch (randInt(0, 6)) {
      case 0: // 暂存数组算术，形态与真实的槽位/栈访问一致
        return t.expressionStatement(t.assignmentExpression('=', junkReg(),
          t.binaryExpression('+',
            t.binaryExpression('^', junkReg(), t.numericLiteral(randInt(1, 0xffff))),
            t.binaryExpression('&', slenE(), t.numericLiteral(0xf)))));
      case 1: // 只读地窥视栈顶
        return t.expressionStatement(t.assignmentExpression('=', junkReg(),
          t.memberExpression(S, t.binaryExpression('-', slenE(), t.numericLiteral(1)), true)));
      case 2: // 压栈与弹栈对冲，净效果为零，栈内容不变
        return t.blockStatement([
          t.expressionStatement(t.callExpression(
            morph.memberDot(S, 'push'), [slenE()])),
          t.expressionStatement(t.callExpression(
            morph.memberDot(S, 'pop'), [])),
        ]);
      case 3: // 只读 K 再异或
        return t.expressionStatement(t.assignmentExpression('=', junkReg(),
          t.binaryExpression('^',
            t.binaryExpression('|',
              t.memberExpression(K, t.binaryExpression('&',
                t.binaryExpression('-', morph.memberDot(K, 'length'), t.numericLiteral(1)),
                t.numericLiteral(7)), true),
              t.numericLiteral(0)),
            t.numericLiteral(randInt(1, 0xff)))));
      case 4: // 垃圾数组轮转，形似 V 槽位写，下标经 length 取模保证不越界
        // S、K、PC、MASK 已经是 Identifier 节点，直接用；nDV、nT0、nT1、REGS
        // 是名字字符串，要经 idn() 转成节点。
        return t.expressionStatement(t.assignmentExpression('=',
          t.memberExpression(idn(nDV), t.binaryExpression('%',
            t.binaryExpression('+', PC, t.numericLiteral(randInt(0, 7))),
            morph.memberDot(idn(nDV), 'length')), true),
          t.binaryExpression('^',
            t.memberExpression(idn(nDV), t.binaryExpression('%',
              t.binaryExpression('+', PC, t.numericLiteral(randInt(1, 8))),
              morph.memberDot(idn(nDV), 'length')), true),
            t.numericLiteral(randInt(1, 0xff)))));
      case 5: // 只读地混合位置与掩码
        return t.expressionStatement(t.assignmentExpression('=', junkReg(),
          t.binaryExpression('&', t.binaryExpression('^', PC, MASK), t.numericLiteral(0xff))));
      default: // 两个暂存变量做算术
        return t.blockStatement([
          t.expressionStatement(t.assignmentExpression('=', idn(nT0),
            t.binaryExpression('>>>',
              rtlib.mulCall(ctx, idn(nT0), t.binaryExpression('|', idn(nT1), t.numericLiteral(1))),
              t.numericLiteral(3)))),
          t.expressionStatement(t.assignmentExpression('=', idn(nT1),
            t.binaryExpression('&', t.binaryExpression('+', idn(nT1), PC), t.numericLiteral(0xffff)))),
        ]);
    }
  };
  for (let j = 0; j < JN; j++) {
    const nm = uniqueName(ctx.usedNames, '_0x');
    junkNames.push(nm);
    const stmts = [];
    const nStmts = randInt(1, 3);
    for (let q = 0; q < nStmts; q++) stmts.push(junkStmt());
    junkDecls.push(t.variableDeclaration('var', [
      t.variableDeclarator(t.identifier(nm), t.arrowFunctionExpression([], t.blockStatement(stmts))),
    ]));
  }

  // 两级分发 case 生成。
  // 外层 switch 判别式是 bAt() 过桶函数的结果，标签就是桶号，本身没有语义。桶内是
  // if (t === 分发字) 链，比较常数是构建期已知的分发字。运行期 t 的真实值是解密后的
  // 编号经 full 映射得到的，只有与比较常数相等才执行对应语义动作。静态读代码只能知道
  // 某个桶里比对某个常数的分支做什么，而 t 的实际值要先解密字节码流才拿得到，不运行
  // 就没法把编号与语义对齐。
  //
  // 分发形态每函数随机三选一：
  // A 是 switch 桶加桶内 if-else 链，结构最常见；
  // B 是表驱动，用桶号索引一张 [分发字, 动作函数] 表，桶内线性扫描，属于数据驱动调度，
  //   没有 switch 也没有比较链骨架；
  // C 是嵌套 if，外层桶号 if-else 链加桶内分发字 if-else 链，没有 switch 也没有表，
  //   纯分支树。
  // 三种形态都经由桶号调度，所以 wasm 档可以按 MUL(dispT,P1) 这一特征统一改写成
  // BK(f,t) 调用，细节见 wasm。
  const _dispT = uniqueName(ctx.usedNames, '_0x'); // 取指暂存变量
  const _bk = uniqueName(ctx.usedNames, '_0x');    // 本条指令的分发桶号，每指令只求值一次
  // 分发条目由真实操作码与干扰项组成，经同一个桶函数分桶，同桶内乱序混排
  const entries = opKinds.map((k) => ({ real: true, kind: k, word: opNums.get(k) }));
  for (const w of decoys) {
    entries.push({
      real: false,
      word: w,
      junk: junkNames[randInt(0, junkNames.length - 1)],
    });
  }
  const byBucket = new Map();
  for (let b = 0; b < nbuckets; b++) byBucket.set(b, []);
  for (const e of entries) byBucket.get(dispBucket(e.word)).push(e);
  for (const b of byBucket.values()) shuffle(b); // 桶内顺序同样打乱

  // 桶内比对 t === 分发字 d，d 在构建期已知，与字节码流一致。
  // 比较方向与数字写法双多态（见 morph.yodaEq/numLit）：每条目独立随机，
  // 上千个干扰项的比较代码不再是同一模板的重复。
  const fullCmp = (e) => morph.yodaEq(t.identifier(_dispT), morph.numLit(e.word));

  // 条目动作体。真实条目走语义 case，干扰条目调用共享的垃圾箭头，净无副作用
  const entryBody = (e) => (e.real
    ? t.blockStatement(caseBody(e.kind))
    : t.blockStatement([
      t.expressionStatement(t.callExpression(t.identifier(e.junk), [])),
    ]));

  // 桶内 if-else 链（条目顺序已洗牌）
  const bucketChain = (es) => {
    const inner = [];
    for (const e of es) {
      // 动作末尾不加 break，由外层结构统一退出
      inner.push(t.ifStatement(fullCmp(e), entryBody(e)));
    }
    let chain = inner[inner.length - 1];
    for (let i = inner.length - 2; i >= 0; i--) {
      inner[i].alternate = chain;
      chain = inner[i];
    }
    return chain;
  };

  // 桶号表达式（wasm 档由 wasm 按 MUL(dispT,P1)（自研 imul 内核）特征
  // 整体替换为 BK(f,t) 调用，右移留在 JS 侧、仿射常数仍在 wasm 内存；
  // JS 档为内联仿射 + 高位右移取桶。求值点唯一：每指令一次，结果存 _bk，
  // 三形态的分发体只读 _bk）
  const bucketExpr = () => t.binaryExpression('>>>',
    t.binaryExpression('+',
      rtlib.mulCall(ctx, t.identifier(_dispT), t.numericLiteral(DISP_P1)),
      t.numericLiteral(DISP_Q1)),
    t.numericLiteral(DISP_SH));

  // 分发形态每函数随机：vmDispatchEnc 关闭时 A/B/C 三选一；开启时 75% 走
  // 形态 D（表密文化），25% 仍走 A/B/C，避免「全库单一形态」的新指纹。
  // 紧凑分发器（vmCompactDispatcher）：强制形态 E（直接寻址）。
  // A/C 是分支链形态，会为每个条目——包括上千个干扰字——各生成一段比较代码；
  // E 把「字 → 动作」压成一条密文整数流，运行期解成直接寻址表，结构代码只剩一句话。
  // async 函数（异步执行器）强制走 A/C：B/D/E 的动作体装在箭头函数里，而非 async
  // 箭头里写 `await` 是语法错误。A 的 switch 体与 C 的嵌套 if 体都直接内联在 async
  // 函数体内，await 合法。代价是 async 函数拿不到密文条目表与直接寻址，换来的是
  // 「能编译」——这一步不做的话产物会直接语法错误，不是"没效果"。
  // 层数（vmLayers）。默认 1 = 当今形态（外层函数体就是 VM 解释器）；
  // 2 = 「解释器循环本身作为一个新函数体再 VM 编译一次」——外层用户字节码的
  // 解释动作由 B2 字节码执行，每层的解释器实例之间只共享随机化的解释器结构，
  // 不共享密钥材料与编号空间。各层命名与操作码表逐层独立，重新随机。
  //
  // B2 的解释器循环必然还是纯 JS——所以层数取决于「把循环整体作为
  // 用户代码喂给同一编译器」能否成功：只要外层 emitter 构造的循环没有 switch、
  // break、标签、label、await，regionOk 就认定可编译。因此要嵌套时 dispatchForm
  // 必须选 C（嵌套 if，无 switch/无表，且动作体全部内联）。wantNestingHere 见
  // compileFunction 入口（WASM 桥接分支之前就算好，桥接是否让路靠它决定）。
  const dispatchForm = wantNestingHere
    ? 2
    : asyncFn
      ? (randInt(0, 1) === 0 ? 0 : 2)
      : (ctx.options.vmCompactDispatcher
        ? 4
        : (ctx.options.vmDispatchEnc
          ? (randInt(0, 3) === 0 ? randInt(0, 2) : 3) // 75% 走 D，25% 仍走 A/B/C（避免形态单一）
          : randInt(0, 2))); // 0 为 A，1 为 B，2 为 C，3 为 D，4 为 E（紧凑）
  let dispSwitchNode = null;   // 形态 A 的 switch 判别式节点
  // 表驱动形态（B/D/E）共用的动作体转换：return 一律转成 [0, 值] / [0]，由调度层
  // 穿透返回。三种形态共用同一实现，避免各写一份之后漂移。
  const toActionFn = (k) => {
    const stmts = caseBody(k).map((s) => s);
    const conv = (n) => {
      if (!n || typeof n !== 'object' || typeof n.type !== 'string') return;
      if (n.type === 'ReturnStatement') {
        n.argument = n.argument
          ? t.arrayExpression([t.numericLiteral(0), n.argument])
          : t.arrayExpression([t.numericLiteral(0)]);
        return;
      }
      for (const key of Object.keys(n)) {
        if (key === 'loc') continue;
        const v = n[key];
        if (Array.isArray(v)) for (const c of v) conv(c);
        else if (v && typeof v === 'object' && typeof v.type === 'string') conv(v);
      }
    };
    stmts.forEach(conv);
    return t.blockStatement(stmts);
  };
  // 解释器循环之前先声明干扰项共享的垃圾体，各种分发形态都要；B/D/E 再追加各自的表
  let preLoopStmts = junkDecls.slice();
  let dispatchBody = null;     // 分发体，可能是 switch 语句、if 链或表扫描循环

  if (dispatchForm === 0) {
    // 形态 A：switch 桶加桶内 if-else 链
    const outerCases = [];
    for (let b = 0; b < nbuckets; b++) {
      const es = byBucket.get(b);
      if (!es.length) continue;
      outerCases.push(t.switchCase(t.numericLiteral(b), [
        t.blockStatement([bucketChain(es)]),
        t.breakStatement(),
      ]));
    }
    shuffle(outerCases);
    dispSwitchNode = t.switchStatement(idn(_bk), outerCases);
    dispatchBody = dispSwitchNode;
  } else if (dispatchForm === 1) {
    // 形态 B：表驱动。
    // TBL[b] 是 [[d0, ()=>{...}], [d1, ()=>{...}], ...]，桶内乱序。调度时用 for
    // 扫描 TBL[bb]，命中分发字就调用对应动作。
    // return 需要穿透调度层：return 类 handler 统一返回 [0, 值]，RET 带值，
    // RETU 与 END 返回 [0]；调度层发现 rr !== undefined 就 return rr[1]。
    // throw 直接穿透闭包边界。
    // 表声明提升到解释器循环之前，不变量表只需构建一次。干扰项行引用共享垃圾箭头，
    // 1000 多行的表若每次分发都重建，开销不可接受。
    const TBL = uniqueName(ctx.usedNames, '_0x');
    const toFnBody = (k) => {
      const stmts = caseBody(k).map((s) => s);
      // return 转成 [0, expr] 或 [0]
      const conv = (n) => {
        if (!n || typeof n !== 'object' || typeof n.type !== 'string') return;
        if (n.type === 'ReturnStatement') {
          n.argument = n.argument
            ? t.arrayExpression([t.numericLiteral(0), n.argument])
            : t.arrayExpression([t.numericLiteral(0)]);
          return;
        }
        for (const key of Object.keys(n)) {
          if (key === 'loc') continue;
          const v = n[key];
          if (Array.isArray(v)) for (const c of v) conv(c);
          else if (v && typeof v === 'object' && typeof v.type === 'string') conv(v);
        }
      };
      stmts.forEach(conv);
      return t.blockStatement(stmts);
    };
    const tblElems = [];
    for (let b = 0; b < nbuckets; b++) {
      const es = byBucket.get(b);
      const rows = es.map((e) => t.arrayExpression([
        t.numericLiteral(e.word),
        e.real
          ? t.arrowFunctionExpression([], toFnBody(e.kind))
          : t.identifier(e.junk),
      ]));
      tblElems.push(t.arrayExpression(rows));
    }
    preLoopStmts.push(
      t.variableDeclaration('var', [
        t.variableDeclarator(t.identifier(TBL), t.arrayExpression(tblElems)),
      ]),
    );
    const _q = uniqueName(ctx.usedNames, '_0x');
    const _e = uniqueName(ctx.usedNames, '_0x');
    const _rr = uniqueName(ctx.usedNames, '_0x');
    const _rw = uniqueName(ctx.usedNames, '_0x'); // 本指令命中的桶行数组，每指令取一次
    dispatchBody = t.blockStatement([
      t.variableDeclaration('var', [
        t.variableDeclarator(idn(_rw), t.memberExpression(t.identifier(TBL), idn(_bk), true)),
      ]),
      t.forStatement(
      t.variableDeclaration('var', [t.variableDeclarator(t.identifier(_q), t.numericLiteral(0))]),
      morph.relCmp('<',
        t.identifier(_q),
        morph.memberDot(t.identifier(_rw), 'length')),
      morph.incUpd(_q),
      t.blockStatement([
        t.variableDeclaration('var', [
          t.variableDeclarator(t.identifier(_e),
            t.memberExpression(t.identifier(_rw), t.identifier(_q), true)),
        ]),
        t.ifStatement(
          morph.yodaEq(
            t.memberExpression(t.identifier(_e), t.numericLiteral(0), true),
            t.identifier(_dispT)),
          t.blockStatement([
            t.variableDeclaration('var', [
              t.variableDeclarator(t.identifier(_rr), t.callExpression(
                t.memberExpression(t.identifier(_e), t.numericLiteral(1), true), [])),
            ]),
            t.ifStatement(
              t.binaryExpression('!==', t.identifier(_rr), t.unaryExpression('void', t.numericLiteral(0), true)),
              t.blockStatement([t.returnStatement(
                t.memberExpression(t.identifier(_rr), t.numericLiteral(1), true))])),
            t.breakStatement(),
          ])),
      ])),
      ]);
  } else if (dispatchForm === 3) {
    // 形态 D（P3）：分发条目表密文化 + 动作函数表间接调度。
    //
    // 这是「分发字 → 语义」映射唯一不以明文出现在产物里的形态。构造：
    //
    //   1. 动作函数表 A[i]：第 i 项是某个真实语义的箭头函数（return 转 [0,值] 穿透，
    //      与形态 B 同一套转换）。语义只以「在 A 里的下标」存在，产物里没有
    //      「分发字 = 语义」的对应。
    //   2. 条目密文表 C：把 (bucket, word, actIdx) 三元组编码成整数流，逐项与
    //      「位置散列 ^ 桶盐 ^ 表掩码」异或。产物里 C 是一串看似随机的整数。
    //   3. 运行期在解释器循环之前一次性解出 C，填充桶索引 BI[bucket]，
    //      BI[b] 给出该桶在解出的 (word, actIdx) 并行数组里的下标区间 [lo, hi)。
    //   4. 分发时按 BI[bucket] 取区间，线性比对 word，命中即调 A[actIdx]。
    //   5. 解完把 C 就地清空（C.length = 0），运行期内存里也不再保留密文表。
    //
    // 静态面的收益：读源码只能看到「一串整数」「一张箭头函数表」，以及
    // 「按桶号取区间、比对解出的值、调表里某下标」的调度骨架。要还原指令集语义，
    // 必须先算出 C 的解密密钥（依赖 DISP_P1/Q1、DE_S1、DE_M0，全部逐构建随机），
    // 再与 A 的下标对齐——而 A 的下标本身也不与语义名对应。
    const A_TBL = uniqueName(ctx.usedNames, '_0x'); // 动作函数表
    const C_TBL = uniqueName(ctx.usedNames, '_0x'); // 条目密文表（运行期就地解密）
    const BI_TBL = uniqueName(ctx.usedNames, '_0x'); // 桶 2 → 条目区间 [lo,hi) 的平铺表
    const DBI = uniqueName(ctx.usedNames, '_0x');   // 解密临时：条目掩码
    const DDR = uniqueName(ctx.usedNames, '_0x');   // 解密游标
    // 位置散列乘数（奇数）与异或分量、表掩码，全部逐构建随机。
    const DE_S1 = krand(0x10001, 0x7ffffffe) | 1;
    const DE_S2 = krand(0x1000, 0xffffff);
    const DE_M0 = krand(0x1000, 0x3fffffff);
    const deMask = (i) => (Math.imul(i + 1, DE_S1) >>> 9) ^ DE_S2 ^ DE_M0;

    // 动作函数表：只装真实语义（干扰条目在解密后指向一个共享的垃圾箭头下标，
    // 与真实项混排，静态上无法按下标规律区分真假）。
    // 动作体转换用共用的 toActionFn（return 转 [0, 值] / [0]，由调度层穿透）。
    const actElems = [];
    const actIdxOfKind = new Map();
    for (const k of opKinds) {
      actIdxOfKind.set(k, actElems.length);
      actElems.push(t.arrowFunctionExpression([], toActionFn(k)));
    }
    const junkActIdx = junkNames.length ? actElems.length : -1;
    if (junkNames.length) actElems.push(t.identifier(junkNames[0])); // 干扰动作，引用共享垃圾箭头
    // 每桶的条目序列（已洗牌），扁平化后编码
    const flatEntries = []; // {bucket, word, actIdx}
    const bucketRange = new Map(); // bucket -> [lo, hi)
    for (let b = 0; b < nbuckets; b++) {
      const es = byBucket.get(b);
      if (!es.length) continue;
      const lo = flatEntries.length;
      for (const e of es) {
        flatEntries.push({
          bucket: b,
          word: e.word,
          actIdx: e.real ? actIdxOfKind.get(e.kind) : junkActIdx,
        });
      }
      bucketRange.set(b, [lo, flatEntries.length]);
    }
    // 编码：每项拆成三个字，分别异或同一位置掩码（三字共用掩码，但字的「位段」
    // 不同，静态上也读不出哪三位是一组）。产物里是纯整数流。
    const cWords = [];
    flatEntries.forEach((en, i) => {
      const m = deMask(i);
      cWords.push((en.bucket ^ m) | 0);
      cWords.push((en.word ^ m) | 0);
      cWords.push((en.actIdx ^ m) | 0);
    });
    // 桶区间表也平铺成一维（桶号 -> lo, hi），同样异或掩码，避免桶边界明文可读。
    // 构建期掩码必须与运行期 biMask 逐字同构（注意这里没有 deMask 的 +1 偏移），
    // 否则解出的区间整体错位、分发永远落空。
    const biMaskOf = (b) => (Math.imul(b ^ (DE_S2 & 0xff), DE_S1) >>> 9) ^ DE_S2 ^ DE_M0;
    const biWords = [];
    for (let b = 0; b < nbuckets; b++) {
      const r = bucketRange.get(b);
      const m = biMaskOf(b);
      biWords.push((b ^ m) | 0);
      biWords.push((((r ? r[0] : 0) + 1) ^ m) | 0); // +1 偏移避开 0 值特征
      biWords.push((((r ? r[1] : 0) + 1) ^ m) | 0);
    }

    preLoopStmts.push(
      t.variableDeclaration('var', [
        t.variableDeclarator(t.identifier(A_TBL), t.arrayExpression(actElems)),
        t.variableDeclarator(t.identifier(C_TBL),
          t.arrayExpression(cWords.map((n) => t.numericLiteral(n)))),
        t.variableDeclarator(t.identifier(BI_TBL),
          t.arrayExpression(biWords.map((n) => t.numericLiteral(n)))),
      ]),
    );
    // 解密：一次性把 C 与 BI 解回明文结构（桶索引表 与 条目并行数组）。
    // 解密式与编码式同构：value = word ^ (imul(i+1, DE_S1) >>> 9) ^ DE_S2 ^ DE_M0。
    const deExpr = (idxNode) => t.binaryExpression('^',
      t.binaryExpression('^',
        t.binaryExpression('>>>',
          rtlib.mulCall(ctx, t.binaryExpression('+', idxNode, t.numericLiteral(1)),
            t.numericLiteral(DE_S1)),
          t.numericLiteral(9)),
        t.numericLiteral(DE_S2)),
      t.numericLiteral(DE_M0));
    // BI 的索引掩码与 C 不同（用 b ^ (DE_S2 & 0xff)），这里同构重算。
    const biMask = (bIdxNode) => t.binaryExpression('^',
      t.binaryExpression('>>>',
        rtlib.mulCall(ctx,
          t.binaryExpression('^', bIdxNode, t.numericLiteral(DE_S2 & 0xff)),
          t.numericLiteral(DE_S1)),
        t.numericLiteral(9)),
      t.binaryExpression('^', t.numericLiteral(DE_S2), t.numericLiteral(DE_M0)));
    const NB_LIT = nbuckets;
    // 解密后的明文结构装在三个并行数组：DW（分发字）、DA（动作下标）、
    // BB（该条目所属桶，用于把条目归位到桶区间）。归位在解密循环里一并完成。
    const DW = uniqueName(ctx.usedNames, '_0x');
    const DA = uniqueName(ctx.usedNames, '_0x');
    const BLO = uniqueName(ctx.usedNames, '_0x');
    const BHI = uniqueName(ctx.usedNames, '_0x');
    const decStmts = [
      t.variableDeclaration('var', [
        t.variableDeclarator(idn(DW), t.arrayExpression([])),
        t.variableDeclarator(idn(DA), t.arrayExpression([])),
      ]),
      // 解出全部条目
      t.forStatement(
        t.variableDeclaration('var', [
          t.variableDeclarator(idn(DDR), t.numericLiteral(0)),
        ]),
        morph.relCmp('<', idn(DDR),
          t.binaryExpression('/', morph.memberDot(t.identifier(C_TBL), 'length'),
            t.numericLiteral(3))),
        morph.incUpd(DDR),
        t.blockStatement([
          // 三字共用一处掩码，先算一次
          t.variableDeclaration('var', [
            t.variableDeclarator(idn(DBI), deExpr(idn(DDR))),
          ]),
          t.expressionStatement(t.callExpression(
            t.memberExpression(idn(DW), t.identifier('push'), false), [
              t.binaryExpression('^',
                t.memberExpression(t.identifier(C_TBL),
                  t.binaryExpression('+', t.binaryExpression('*', idn(DDR), t.numericLiteral(3)),
                    t.numericLiteral(1)), true),
                idn(DBI)),
            ])),
          t.expressionStatement(t.callExpression(
            t.memberExpression(idn(DA), t.identifier('push'), false), [
              t.binaryExpression('^',
                t.memberExpression(t.identifier(C_TBL),
                  t.binaryExpression('+', t.binaryExpression('*', idn(DDR), t.numericLiteral(3)),
                    t.numericLiteral(2)), true),
                idn(DBI)),
            ])),
        ])),
      // 解出桶区间（每桶三项：桶号、lo+1、hi+1），按桶号归位
      t.variableDeclaration('var', [
        t.variableDeclarator(idn(BLO), t.arrayExpression([])),
        t.variableDeclarator(idn(BHI), t.arrayExpression([])),
      ]),
      t.forStatement(
        t.variableDeclaration('var', [
          t.variableDeclarator(idn(DDR), t.numericLiteral(0)),
        ]),
        morph.relCmp('<', idn(DDR), t.numericLiteral(NB_LIT)),
        morph.incUpd(DDR),
        t.blockStatement([
          t.variableDeclaration('var', [
            t.variableDeclarator(idn(DBI), biMask(idn(DDR))),
          ]),
          t.expressionStatement(t.assignmentExpression('=',
            t.memberExpression(idn(BLO), idn(DDR), true),
            t.binaryExpression('^',
              t.memberExpression(t.identifier(BI_TBL),
                t.binaryExpression('+', t.binaryExpression('*', idn(DDR), t.numericLiteral(3)),
                  t.numericLiteral(1)), true),
              idn(DBI)))),
          t.expressionStatement(t.assignmentExpression('=',
            t.memberExpression(idn(BHI), idn(DDR), true),
            t.binaryExpression('^',
              t.memberExpression(t.identifier(BI_TBL),
                t.binaryExpression('+', t.binaryExpression('*', idn(DDR), t.numericLiteral(3)),
                  t.numericLiteral(2)), true),
              idn(DBI)))),
        ])),
      // 密文表就地清空：运行期内存里不再保留可 dump 的密文表
      t.expressionStatement(t.assignmentExpression('=',
        t.memberExpression(t.identifier(C_TBL), t.identifier('length'), false),
        t.numericLiteral(0))),
      t.expressionStatement(t.assignmentExpression('=',
        t.memberExpression(t.identifier(BI_TBL), t.identifier('length'), false),
        t.numericLiteral(0))),
    ];
    // 解密语句在每次函数调用时执行（DW/DA/BLO/BHI 随调用重建，与形态 B 的表
    // 每调用重建同一成本量级；条目数 = 真实 + 干扰，循环体只是算术与 push）。
    preLoopStmts = preLoopStmts.concat(decStmts);

    // 分发体：桶号 → 取区间 [BLO[b]-1, BHI[b]-1) → 线性比对 DW[i]，命中调 A[DA[i]]。
    const _q = uniqueName(ctx.usedNames, '_0x');
    const _rr = uniqueName(ctx.usedNames, '_0x');
    dispatchBody = t.blockStatement([
      t.forStatement(
        t.variableDeclaration('var', [
          t.variableDeclarator(idn(_q),
            t.binaryExpression('-',
              t.memberExpression(idn(BLO), idn(_bk), true), t.numericLiteral(1))),
        ]),
        morph.relCmp('<', idn(_q),
          t.binaryExpression('-',
            t.memberExpression(idn(BHI), idn(_bk), true), t.numericLiteral(1))),
        morph.incUpd(_q),
        t.blockStatement([
          t.ifStatement(
            morph.yodaEq(
              t.memberExpression(idn(DW), idn(_q), true),
              idn(_dispT)),
            t.blockStatement([
              t.variableDeclaration('var', [
                t.variableDeclarator(idn(_rr), t.callExpression(
                  t.memberExpression(t.identifier(A_TBL),
                    t.memberExpression(idn(DA), idn(_q), true), true), [])),
              ]),
              t.ifStatement(
                t.binaryExpression('!==', idn(_rr),
                  t.unaryExpression('void', t.numericLiteral(0), true)),
                t.blockStatement([t.returnStatement(
                  t.memberExpression(idn(_rr), t.numericLiteral(1), true))])),
              t.breakStatement(),
            ])),
        ])),
    ]);
  } else if (dispatchForm === 4) {
    // 形态 E（紧凑分发器）：直接寻址。
    //
    // 分发字空间本来就是稠密的——opNums 取的是 0..totalSlots-1 的一次全排列，每个整数
    // 要么是真实操作码要么是干扰字。所以「字」本身就是下标：不需要桶、不需要桶区间表、
    // 也不需要桶内线性扫描。
    //   1. 动作函数表 A[i]：每个真实语义一个箭头函数（return 转 [0,值]，调度层穿透）。
    //   2. 条目密文流 C：按字下标就地存放，位置即字，每项只有动作下标那一个字与
    //      位置散列异或——产物里是一串整数，长度正好等于字空间大小。
    //   3. 运行期在循环之前把 C 解成直接寻址表 M：M[word] = C[word] ^ 位置掩码，
    //      解完就地清空 C。
    //   4. 分发 = 一次 A[M[t]]() 加一个返回值判断，O(1)。
    //
    // 与形态 D 对比：D 每项三个字（桶、字、动作）外加一张桶区间表，分发要按桶取区间再
    // 线性扫描；E 每项一个字、无区间表、分发 O(1)。两者的「字 → 语义」都只在运行期解出，
    // 静态面上同样只有一串密文整数，隐藏程度相同。
    const A_TBL = uniqueName(ctx.usedNames, '_0x');
    const M_TBL = uniqueName(ctx.usedNames, '_0x');
    const C_TBL = uniqueName(ctx.usedNames, '_0x');
    const DDR = uniqueName(ctx.usedNames, '_0x');
    const CE_S1 = krand(0x10001, 0x7ffffffe) | 1;
    const CE_S2 = krand(0x1000, 0xffffff);
    const CE_M0 = krand(0x1000, 0x3fffffff);
    const actElems = [];
    const actIdxOfKind = new Map();
    for (const k of opKinds) {
      actIdxOfKind.set(k, actElems.length);
      actElems.push(t.arrowFunctionExpression([], toActionFn(k)));
    }
    const junkActIdx = junkNames.length ? actElems.length : -1;
    if (junkNames.length) actElems.push(t.identifier(junkNames[0]));
    // 按字升序编码。M 是直接寻址表，条目次序本身不承载信息
    // 位置即分发字：条目按字下标就地存放，每项只存一个加密的动作下标。
    // 字空间是稠密的（0..totalSlots-1 全覆盖），所以数组长度正好等于字空间大小——
    // 这是直接寻址能压到的最小数据量，也是它比形态 D 小的原因（D 每项存三个字）。
    const actIdxByWord = new Map();
    for (const k of opKinds) actIdxByWord.set(opNums.get(k), actIdxOfKind.get(k));
    const cWords = [];
    for (let w = 0; w < totalSlots; w++) {
      const ai = actIdxByWord.has(w) ? actIdxByWord.get(w) : junkActIdx;
      cWords.push((ai ^ ((Math.imul(w + 1, CE_S1) >>> 9) ^ CE_S2 ^ CE_M0)) | 0);
    }
    preLoopStmts.push(t.variableDeclaration('var', [
      t.variableDeclarator(t.identifier(A_TBL), t.arrayExpression(actElems)),
      t.variableDeclarator(t.identifier(C_TBL),
        t.arrayExpression(cWords.map((n) => t.numericLiteral(n)))),
      t.variableDeclarator(t.identifier(M_TBL), t.arrayExpression([])),
    ]));
    // 解密与归位：M[word] = C[word] ^ 位置掩码，一项一个字，与编码式同构
    const ceMask = (idxNode) => t.binaryExpression('^',
      t.binaryExpression('^',
        t.binaryExpression('>>>',
          rtlib.mulCall(ctx, t.binaryExpression('+', idxNode, t.numericLiteral(1)),
            t.numericLiteral(CE_S1)),
          t.numericLiteral(9)),
        t.numericLiteral(CE_S2)),
      t.numericLiteral(CE_M0));
    preLoopStmts = preLoopStmts.concat([
      t.forStatement(
        t.variableDeclaration('var', [t.variableDeclarator(idn(DDR), t.numericLiteral(0))]),
        morph.relCmp('<', idn(DDR),
          morph.memberDot(t.identifier(C_TBL), 'length')),
        morph.incUpd(DDR),
        t.blockStatement([
          t.expressionStatement(t.assignmentExpression('=',
            t.memberExpression(idn(M_TBL), idn(DDR), true),
            t.binaryExpression('^',
              t.memberExpression(t.identifier(C_TBL), idn(DDR), true),
              ceMask(idn(DDR))))),
        ])),
      // 密文流就地清空：运行期内存里不再保留可 dump 的密文
      t.expressionStatement(t.assignmentExpression('=',
        t.memberExpression(t.identifier(C_TBL), t.identifier('length'), false),
        t.numericLiteral(0))),
    ]);
    const _rr = uniqueName(ctx.usedNames, '_0x');
    dispatchBody = t.blockStatement([
      t.variableDeclaration('var', [t.variableDeclarator(idn(_rr), t.callExpression(
        t.memberExpression(t.identifier(A_TBL),
          t.memberExpression(idn(M_TBL), idn(_dispT), true), true), []))]),
      t.ifStatement(
        t.binaryExpression('!==', idn(_rr),
          t.unaryExpression('void', t.numericLiteral(0), true)),
        t.blockStatement([t.returnStatement(
          t.memberExpression(idn(_rr), t.numericLiteral(1), true))])),
    ]);
  } else {
    // 形态 C：嵌套 if 桶链
    const outer = [];
    for (let b = 0; b < nbuckets; b++) {
      const kinds = byBucket.get(b);
      if (!kinds.length) continue;
      outer.push(t.ifStatement(
        morph.yodaEq(idn(_bk), t.numericLiteral(b)),
        t.blockStatement([bucketChain(kinds)])));
    }
    shuffle(outer);
    let chain = outer[outer.length - 1];
    for (let i = outer.length - 2; i >= 0; i--) {
      outer[i].alternate = chain;
      chain = outer[i];
    }
    dispatchBody = chain;
  }

  // 解释器循环形态逐构建随机，for(;;) 与 while(true) 二选一。循环骨架是解释器最外层
  // 指纹之一，这两种形态与 dispatchForm 的四种分发正交组合出 8 种骨架，针对单一骨架
  // 模板写的还原规则无法跨构建复用。
  const interpBody = t.blockStatement([
    // 步数闸门（执行护栏，原 vmNestedLimit 的平移）：
    // 每执行一条字节码指令就 ++STEP，超过 vmStepLimit 直接抛错。
    // 死循环/失控执行不再只能靠宿主挂死兜底，而是有条可定位的失败路径。
    // vmStepLimit=0 时不生成这道闸门（产物逐字节仍只差这一项）。
    ...(stepLimit > 0 ? [t.ifStatement(
      t.binaryExpression('>',
        t.updateExpression('++', STEP, true),
        t.numericLiteral(stepLimit)),
      t.blockStatement([t.throwStatement(t.newExpression(
        t.identifier('Error'), [t.stringLiteral(msg('vmOverrun'))]))]))] : []),
    // 操作数栈深度护栏：正常编译产物的栈深由编译期就可推出上界，
    // 远低于该值；撞到这条说明字节码/解释器状态已损坏，显式抛错优于在坏状态下继续。
    t.ifStatement(
      morph.relCmp('>',
        morph.memberDot(S, 'length'),
        t.numericLiteral(stackDepthCap)),
      t.blockStatement([t.throwStatement(t.newExpression(
        t.identifier('Error'), [t.stringLiteral(msg('vmOverrun'))]))])),
    // 越界守卫，只在开启运行期密钥（useRtKey）时生成：取回的密钥不对时所有分发
    // 条目都落空，取指游标会一直越界读下去变成死循环，把浏览器主线程挂死。这里改成
    // 明确抛出，失败模式从"卡死"变成"立刻报错"。密钥正确时 END 一定会先 return，
    // 所以这道守卫不会误伤；默认路径（不开启本项）一条指令都不多。
    ...(rt ? [t.ifStatement(
      morph.relCmp('>', t.identifier(npc),
        morph.memberDot(B, 'length')),
      t.blockStatement([t.throwStatement(t.newExpression(
        t.identifier('Error'), [t.stringLiteral(msg('vmKeyMismatch'))]))]))] : []),
    t.variableDeclaration('var', [
      // 动态操作码：取指之后按前一字的明文（也就是 nCHAIN）算回轮换量并加回去，
      // 还原成规范编号。桶映射、比对常数、直接寻址表下标全部按规范编号算，所以下面
      // 五种分发形态一个字都不用改。
      //
      // 轮换项必须写在加法左侧。JS 对 `+` 的求值顺序是先左后右，而 bAt() 是
      // 「nCHN=…, nCHAIN=nCHN, …」的逗号序列：放右边它先求值，把 nCHAIN 推进到本字，
      // 读到的就成了新链值而不是前一字的明文。加法可交换，和值不变，只是顺序要紧。
      t.variableDeclarator(t.identifier(_dispT), dynOps
        ? t.binaryExpression('&',
            t.binaryExpression('+',
              t.binaryExpression('^',
                rtlib.mulCall(ctx, t.identifier(nCHAIN), t.numericLiteral(DYN_P)),
                t.numericLiteral(DYN_Q)),
              bAt()),
            t.numericLiteral(rotMask))
        : bAt()),
    ]),
    // 桶号每指令求值一次（三形态共用；此前在表扫描条件/体内与 if 链中
    // 逐次重算，一条指令要重复求值桶映射 2~2×桶数次）
    t.variableDeclaration('var', [
      t.variableDeclarator(t.identifier(_bk), bucketExpr()),
    ]),
    dispatchBody,
  ]);
  // 主解释循环形态二选一（见 morph.loopTrue）：与分发四形态正交组合。
  const interpLoop = morph.loopTrue(interpBody);

  // 组装新函数体，依次放入指令序、参数拷贝、捕获名的 var 声明与解释器
  const dirStmts = directiveStmts(origDirectives);
  const runtimeDecl = t.variableDeclaration('var', shuffle([
    t.variableDeclarator(V, t.arrayExpression([])),
    t.variableDeclarator(G, t.arrayExpression(getterNodes)),
    t.variableDeclarator(H, t.arrayExpression(setterNodes)),
    t.variableDeclarator(K, t.arrayExpression(consts)),
    t.variableDeclarator(J, t.arrayExpression(stringsEnc.map((row) =>
      t.arrayExpression(row.map((n) => t.numericLiteral(n)))))),
    t.variableDeclarator(B, t.arrayExpression(flat.map((n) => t.numericLiteral(n)))),
    t.variableDeclarator(S, t.arrayExpression([])),
    // 栈编码：逐函数密钥 + 幂等的编解码函数。谓词只对 32 位整数成立、且排除 -0
    // （位运算出不了 -0，所以"已编码值"永远不进 -0 分支，谓词在编码侧与解码侧一致）；
    // 浮点、大整数、字符串、对象、NaN/Infinity 一律原样通过。
    ...(stackEnc ? [
      t.variableDeclarator(t.identifier(nSEK), t.numericLiteral(krand(0x1000, 0x3fffffff))),
      t.variableDeclarator(t.identifier(nSE), t.arrowFunctionExpression(
        [t.identifier(nSEV)],
        t.conditionalExpression(
          t.binaryExpression('&&',
            morph.yodaEq(
              t.unaryExpression('typeof', t.identifier(nSEV)),
              t.stringLiteral('number')),
            t.binaryExpression('&&',
              morph.yodaEq(
                t.binaryExpression('|', t.identifier(nSEV), t.numericLiteral(0)),
                t.identifier(nSEV)),
              t.unaryExpression('!', t.binaryExpression('&&',
                morph.yodaEq(t.identifier(nSEV), t.numericLiteral(0)),
                morph.relCmp('<',
                  t.binaryExpression('/', t.numericLiteral(1), t.identifier(nSEV)),
                  t.numericLiteral(0)))))),
          t.binaryExpression('^', t.identifier(nSEV), t.identifier(nSEK)),
          t.identifier(nSEV)))),
    ] : []),
    t.variableDeclarator(PC, t.numericLiteral(0)),
    // 步数计数器（执行护栏）。无条件声明：即使 vmStepLimit=0 关掉闸门，
    // 该变量仍在（未被闸门引用），保证关闸时的产物只差闸门本身不变其它。
    t.variableDeclarator(t.identifier(nSTEP), t.numericLiteral(0)),
    t.variableDeclarator(MASK, kLit(MASK_M0, rt && rt.M0)),
    t.variableDeclarator(t.identifier(nCHAIN), kLit(CHAIN_SEED, rt && rt.CS)), // 链值状态
    t.variableDeclarator(t.identifier(nCHN), t.numericLiteral(0)),           // 取指暂存
    // 干扰项暂存，即垃圾数组与双暂存，结构上并入运行时声明面
    ...scratchDecls,
    // 捕获的局部名保留为真实 var，供 G/H 闭包按词法解析；参数重声明合法
    ...[...captured].map((name) => t.variableDeclarator(t.identifier(name))),
  ]));
  // 入口自修改，做掩码轮换并把字节码数组整体原位重写。
  // 存储字 = 值 ^ posMask ^ curMask。curMask 推进到 nm 之后，对每个字做
  // B[z] ^ curMask ^ nm 就把它重加密成 nm 掩码形态，随后取指统一异或 nm。
  // 每次调用执行一遍，调用期间内存中的字节码与源码字面量不同。
  const nNM = uniqueName(ctx.usedNames, '_0x');
  const nZI = uniqueName(ctx.usedNames, '_0x');
  // 编码关闭时没有掩码可轮换，也不需要在入口重写 B 数组
  const rotStmts = !enc ? [] : [
    t.variableDeclaration('var', [
      t.variableDeclarator(t.identifier(nNM), t.binaryExpression('>>>',
        t.binaryExpression('^',
          rtlib.mulCall(ctx, MASK, kLit(ROT_A, rt && rt.RA)),
          kLit(ROT_B, rt && rt.RB)),
        t.numericLiteral(0))),
    ]),
    t.forStatement(
      t.variableDeclaration('var', [t.variableDeclarator(t.identifier(nZI), t.numericLiteral(0))]),
      morph.relCmp('<', t.identifier(nZI), morph.memberDot(B, 'length')),
      morph.incUpd(nZI),
      t.blockStatement([
        t.expressionStatement(t.assignmentExpression('=',
          t.memberExpression(B, t.identifier(nZI), true),
          t.binaryExpression('^',
            t.binaryExpression('^', t.memberExpression(B, t.identifier(nZI), true), MASK),
            t.identifier(nNM)))),
      ])
    ),
    t.expressionStatement(t.assignmentExpression('=', MASK, t.identifier(nNM))),
  ];
  const paramCopies = [];
  for (const p of fn.params) {
    for (const name in t.getBindingIdentifiers(p)) {
      const s = slotOf.get(name);
      if (s !== undefined) {
        paramCopies.push(t.expressionStatement(t.assignmentExpression('=',
          t.memberExpression(V, t.numericLiteral(s), true), t.identifier(name))));
      }
    }
  }
  // 运行期密钥派生语句。与构建期 krand 的调用顺序逐项对齐：
  //   掩码三件 → 轮换两件 → [分块三件，仅 useBlock] → 字符串表四件 → 分发仿射两件 → 链种子
  // 字符串表与分发仿射这两组运行期用不到，但必须照样推进派生状态，否则后面的链种子
  // 对不上。取值一律「先推进一步、再取模」，与 krand 同构。
  // 用户给的表达式文本经项目自带解析器转 AST——核心模块禁止 eval / new Function。
  const rtKeyStmts = () => {
    if (!rt) return [];
    const KS = () => t.identifier(rt.ks);
    const num = (n) => t.numericLiteral(n);
    const xor = (a, b) => t.binaryExpression('^', a, b);
    const shl = (a, b) => t.binaryExpression('<<', a, b);
    const shru = (a, b) => t.binaryExpression('>>>', a, b);
    const setKS = (e) => t.expressionStatement(t.assignmentExpression('=', KS(), e));
    // 一步 xorshift32。构建期是「a ^= a << 13; a >>>= 0」，等价于 a = (a ^ (a << 13)) >>> 0；
    // 后两步同理。<< 与 >>> 都只看 32 位位型，所以每步各自归一成无符号与构建期完全等价。
    const advance = () => [
      setKS(shru(xor(KS(), shl(KS(), num(13))), num(0))),
      setKS(shru(xor(KS(), shru(KS(), num(17))), num(0))),
      setKS(shru(xor(KS(), shl(KS(), num(5))), num(0))),
    ];
    // 推进一次并取出落在 [lo, hi] 的值；name 为空表示只为推进状态
    const take = (name, lo, hi, odd) => {
      const out = advance();
      if (name) {
        const v = t.binaryExpression('+', num(lo),
          t.binaryExpression('%', KS(), num(hi - lo + 1)));
        out.push(t.variableDeclaration('var', [t.variableDeclarator(
          t.identifier(name), odd ? t.binaryExpression('|', v, num(1)) : v)]));
      }
      return out;
    };
    const getter = (() => {
      let file;
      try {
        file = parser.parse('(' + rtGetterText + '\n)');
      } catch (e) {
        throw new Error(msg('vmRuntimeKeyGetterParseFailed', { msg: (e && e.message) || String(e) }));
      }
      const st = file.program && file.program.body && file.program.body[0];
      if (!st || st.type !== 'ExpressionStatement' || !st.expression) {
        throw new Error(msg('vmRuntimeKeyGetterParseFailed', { msg: 'empty expression' }));
      }
      return st.expression;
    })();
    const RI = () => t.identifier(rt.ri);
    const RS = () => t.identifier(rt.rs);
    const stmts = [
      // 密钥串 = 取回的值 + '#' + 函数序号，与构建期的 tag 是同一个串
      t.variableDeclaration('var', [
        t.variableDeclarator(KS(), num(0x811c9dc5)),
        t.variableDeclarator(RI(), num(0)),
        t.variableDeclarator(RS(), t.binaryExpression('+', getter, t.stringLiteral('#' + keySeq))),
      ]),
      // FNV-1a
      t.forStatement(
        null,
        morph.relCmp('<', RI(), morph.memberDot(RS(), 'length')),
        morph.incUpd(rt.ri),
        t.blockStatement([
          setKS(shru(rtlib.mulCall(ctx, xor(KS(), t.callExpression(
            t.memberExpression(RS(), t.identifier('charCodeAt'), false), [RI()],
          )), num(0x01000193)), num(0))),
        ]),
      ),
      // 0 是 xorshift32 的不动点，与构建期同一处兜底（同一个值，见 ctx.__vmKeyFallback）
      t.ifStatement(
        morph.yodaEq(KS(), num(0)),
        t.blockStatement([setKS(num(ctx.__vmKeyFallback))])),
    ];
    stmts.push(
      ...take(rt.K1, 0x10001, 0x7ffffffe, true),
      ...take(rt.K2, 0x1000, 0xffffff, false),
      ...take(rt.M0, 0x1000, 0x3fffffff, false),
      ...take(rt.RA, 0x10001, 0x7ffffffe, true),
      ...take(rt.RB, 0x1000, 0xffffff, false),
    );
    if (useBlock) {
      stmts.push(
        ...take(rt.BS, 4, 6, false),
        ...take(rt.BA, 0x10001, 0x7ffffffe, true),
        ...take(rt.BB, 0x1000, 0xffffff, false),
      );
    }
    stmts.push(
      // 字符串表散列四件 + 分发仿射两件：运行期不用，但必须推进状态
      ...take(null, 0x1000, 0xffff, true),
      ...take(null, 0x10001, 0x7ffffffe, true),
      ...take(null, 0x1000, 0xffffff, false),
      ...take(null, 0x1000, 0x3fffffff, false),
      ...take(null, 1, 0xffff, false),
      ...take(null, 1, 0xffff, false),
      ...take(rt.CS, 1, 0xfffffff, false),
    );
    return stmts;
  };
  // ------------------------------------------------------------ 执行护栏
  //
  // 原嵌套内层档的「可信内核」特性已并入本解释器，不再存在第二份手写内核：
  //   · 指令步数上限（vmStepLimit）——原 vmNestedLimit 的平移，见 runtimeDecl 里
  //     的 STEP 计数与 interpBody 的闸门；
  //   · 操作数栈深度上限——原内核的「帧深上限」平行物，语义域为本解释器的 S；
  //   · 逐构建随机化的分发/干扰/掩码布局（原 buildCore 的同维特性）早已在本
  //     解释器里（dispatchForm、junk 声明、uniqueName、masked words），本次不改。
  // 内层档的 int32 参数闸门与帧式调用**不**移植：本解释器的栈与槽位装任意 JS 值
  // （而非 int32），调用走 G/H 闭包透传、this/arguments 语义靠闭包链保持——同一
  // 套机制硬搬会把「语义域不同」变成新的静默算错。
  {
    if (wantNestingHere) {
      // 嵌套插人：用户函数体不再直接支持解释循环，而是声明内层解释器函数并立刻调用它。
      // 内层函数的体是 rotStmts+interpLoop（对同一份 B1 字节码的解释执行），
      // 随后它自己会作为被保护对象被同一编译器再编译一遍，得到 B2——执行时 B2 的
      // 解释循环（纯 JS）跑 B2，B2 的语义是「跑 B1 的解释循环」。B1/B2 各自拥有
      // 独立生成的 G/H/K 值池、掩码、编号空间与全集干扰项，互不共享。
      const innerInterpName = uniqueName(ctx.usedNames, '_0x');
      const innerInterp = t.functionExpression(null, [], t.blockStatement([...rotStmts, interpLoop]));
      fn.body = t.blockStatement([
        ...rtKeyStmts(),
        runtimeDecl,
        ...preLoopStmts,
        ...paramCopies,
        t.variableDeclaration('var', [t.variableDeclarator(t.identifier(innerInterpName), innerInterp)]),
        // everything in fn.params has been copied into V1 slots, interp takes no args
        t.returnStatement(t.callExpression(t.identifier(innerInterpName), [])),
      ]);
      fn.body.body.unshift(...dirStmts);
      if (fn.type === 'ArrowFunctionExpression') fn.expression = false;
      if (canCompile(innerInterp, false) && countRegionStmts(innerInterp.body) >= threshold) {
        const savedDepth = ctx.__vmDepth | 0;
        ctx.__vmDepth = savedDepth + 1;
        try {
          compileFunction(innerInterp, ctx);
          ctx.__vmLayerMax = Math.max(ctx.__vmLayerMax | 0, savedDepth + 2);
        } catch (e) {
          // 嵌套失败时回退到单层：innerInterp 保持原状，user fn 的 VM 语义不变
          if (platform.env('DSH_VM_DEBUG')) console.error('[vm] 嵌套解释器编译失败（回退单层）:', e && e.stack ? e.stack : e);
        } finally {
          ctx.__vmDepth = savedDepth;
        }
      } else {
        // 不能编译时内层函数退回原始循环形态（单层语义，仍然正确）
        if (platform.env('DSH_VM_DEBUG')) console.error('[vm] 嵌套解释器无法通过 regionOk，回退单层');
      }
    } else {
      fn.body = t.blockStatement([
        // 运行期密钥派生必须排在 runtimeDecl 之前：MASK 与链种子的初始化要读它算出的值
        ...rtKeyStmts(),
        runtimeDecl,
        // 形态 B 的 handler 表与干扰项共享垃圾体，都是不变量，在循环外构建一次
        ...preLoopStmts,
        ...rotStmts,
        ...paramCopies,
        interpLoop,
      ]);
      fn.body.body.unshift(...dirStmts);
      if (fn.type === 'ArrowFunctionExpression') fn.expression = false;
    }
  }

  // WASM 档元数据，供 wasm pass 读取；不开启 wasm 时没有消费方
  fn.__vmMeta = {
    flat,                 // 加密字节码字数组，含尾部垃圾字
    nB,                   // 字节码数组变量名，wasm 用来定位声明
    nM,                   // 掩码变量名，wasm 用来定位 MASK 声明与轮换写回
    nNM,                  // 轮换掩码临时变量名
    MASK_K1, MASK_K2, MASK_M0,
    BL_SH, BL, BK_A, BK_B,   // P4 分块自解密参数，旧 wasm 档 CN 用；关闭时全 0
    npc,                 // 位置计数变量名，wasm 用它特征匹配取指表达式
    nCHAIN, nCHN,        // 链状态与暂存名，wasm 据此改写 cr 复位点
    CHAIN_SEED,           // 链式取指初值，wasm 档可放进 WASM data 段
    chainAt,              // 每字链值表，wasm 档把 PC 与链状态搬进模块后按目标字复位
    flatLen: flat.length, // 本函数字节码字数，wasm 档切分数据段用
    ROT_A, ROT_B,
    disp: { P1: DISP_P1, Q1: DISP_Q1, nb: nbuckets, SH: DISP_SH }, // 分发桶参数，wasm 档进 data 段
    ops: { real: opKinds.length, decoy: decoys.length, total: entries.length, buckets: nbuckets }, // 干扰项混淆之后的指令集规模
    dispT: _dispT,        // 取指暂存变量名，wasm 据此特征匹配并改写
    dispatchForm,         // 0 为 A(switch)，1 为 B(表驱动)，2 为 C(嵌套 if)
    opNums,               // kind 到编号的 Map，桥接端按编号分发
    consts,               // 常量池节点，引用共享，搬运时原样重建 K
    getterNodes, setterNodes,
    slots: [...slotOf.entries()], // 名字到槽位的映射
    captured: [...captured],
    params: fn.params,    // 参数 pattern，重建拷贝序言时用
  };

  compiledSet.add(fn);
  // 新后端的计数在这里累加（走到这一行说明整条编译流程没抛错、产物已落到 AST 上）；
  // 片段里嵌套的函数走 compileInnerFns 递归调用，也会各自累加，所以统计不会漏报
  if (asyncFn && ctx.__vmAsync) ctx.__vmAsync.funcs++;
  return {
    real: opKinds.length, decoy: decoys.length, total: entries.length, form: dispatchForm,
  };
}

// 目标筛选，由 vmMode 决定，取值 global 或 comment（其他值一律按 global 处理）

/**
 * comment 模式的起止标记。标记必须成对出现、包住目标函数：
 *
 *   / *<jslabyrinth-vmp-start>* /  function f() { ... }  / *<jslabyrinth-vmp-end>* /
 *
 * 之所以不用单个词做标记（如旧的 -jsvmp-）：单个词没有作用域，误触（注释里
 * 提到它、别处复制粘贴带过来）会让不相关的函数被编译；而起止一对天然形成
 * 区间，标记的作用域就是两标记之间。同时它足够长、足够怪，正常注释里不会
 * 偶然出现。匹配只认注释文本，不认字符串内容。
 */
const VMP_MARK_START_RE = /<jslabyrinth-vmp-start>/;
const VMP_MARK_END_RE = /<jslabyrinth-vmp-end>/;

/** 收集函数体内全部语句的 srcIdx，嵌套块内的也收。 */
function collectStmtIdx(node, out) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
  if (node.srcIdx !== undefined) out.push(node.srcIdx);
  eachChild(node, (child) => collectStmtIdx(child, out));
}

/** 函数声明或表达式的头 token 下标，没有语句包装时兜底取体内首条语句。 */
function fnHeadIdx(fn) {
  if (fn.srcIdx !== undefined) return fn.srcIdx;
  const first = fn.body && fn.body.body && fn.body.body[0];
  return first && first.srcIdx !== undefined ? first.srcIdx : Infinity;
}

/**
 * 由起止标记注释算出标记区间 [start, end]。注释按下标排序后顺序配对：
 * 起标记打开一个区间，终标记闭合它；没有终标记的起标记一直延伸到文件末尾；
 * 没有起标记的终标记直接忽略。区间端点用注释的 token 下标衡量，与函数头
 * 与语句的 srcIdx 同一坐标系。
 * @returns {Array<[number, number]>} 闭区间列表
 */
function markIntervals(comments) {
  const cs = (comments || []).slice().sort((a, b) => a.start - b.start);
  const out = [];
  let open = -1;
  for (const c of cs) {
    const t = c.text || '';
    if (VMP_MARK_START_RE.test(t)) {
      // 起标记嵌套/重复：直接以后一个为准，前一个区间丢弃——标记是人写的，
      // 嵌套必然是笔误，静默取内层比报错中断构建更合适（可选增强本就不该炸构建）。
      open = c.start;
    } else if (VMP_MARK_END_RE.test(t)) {
      if (open >= 0) { out.push([open, c.end]); open = -1; }
    }
  }
  if (open >= 0) out.push([open, Infinity]);
  return out;
}

/**
 * 判断函数是否落在任一标记区间内：函数头下标或体内任一条语句下标命中即算。
 * @param fn - 函数节点，body 已确认为 BlockStatement
 * @param intervals - markIntervals 的产物
 * @returns {boolean} 被圈住时为 true
 */
function isMarkedFn(fn, intervals) {
  if (!intervals || !intervals.length) return false;
  const hit = (ix) => {
    for (const s of intervals) if (ix >= s[0] && ix <= s[1]) return true;
    return false;
  };
  const head = fnHeadIdx(fn);
  if (head !== Infinity && hit(head)) return true;
  const idxs = [];
  collectStmtIdx(fn.body, idxs);
  for (const ix of idxs) if (hit(ix)) return true;
  return false;
}

// 顶层初始化包装（vmWrapTopLevel）。VMP 原本只覆盖函数体，顶层语句（引导、注册、
// 初始化调用）完全不受保护。本项把整个顶层语句序列搬进一个合成函数体，让它走同一套
// 编译流程，产物里这段代码由 VM 解释器执行，顶层控制流与常量同样从静态视图里消失。

/** 路径是否位于程序顶层：不在任何函数体内。箭头函数不绑定 this，判定要穿透它。 */
function atTopLevel(path) {
  let p = path.parentPath;
  while (p) {
    const ty = p.node ? p.node.type : null;
    if (ty === 'Program') return true;
    if (ty === 'ArrowFunctionExpression') { p = p.parentPath; continue; }
    if (ty === 'ClassDeclaration' || ty === 'ClassExpression' || ty === 'ClassBody' ||
        ty === 'ClassProperty' || ty === 'StaticBlock' ||
        ty === 'FunctionDeclaration' || ty === 'FunctionExpression' ||
        ty === 'ClassMethod' || ty === 'ObjectMethod') return false;
    p = p.parentPath;
  }
  return true;
}

/**
 * 顶层包装的适用性判定，入参是"用户顶层语句"构成的 Program（不含 rtlib 内核）。
 * 返回 null 表示可以包装，否则返回跳过原因。
 * 三条排除与 functionWrapper 同源：这三种情形下"顶层代码搬进函数体"会改语义。
 */
function topWrapBlocked(prog, ctx) {
  let esm = false;
  let topThis = false;
  let cjs = false;
  ctx.traverse(prog, {
    ImportDeclaration() { esm = true; },
    ExportNamedDeclaration() { esm = true; },
    ExportDefaultDeclaration() { esm = true; },
    ExportAllDeclaration() { esm = true; },
    ThisExpression(path) {
      if (!topThis && atTopLevel(path)) topThis = true;
    },
    Identifier(path) {
      if (cjs) return;
      const name = path.node.name;
      if (name !== 'module' && name !== 'exports' && name !== 'require') return;
      if (!atTopLevel(path)) return;
      // 局部同名变量只是遮蔽，不构成 CommonJS 标记
      if (path.scope && path.scope.getBinding(name)) return;
      const par = path.parentPath;
      const pt = par && par.node ? par.node.type : null;
      if (name === 'require' && pt === 'CallExpression' && par.node.callee === path.node) cjs = true;
      else if ((name === 'module' || name === 'exports') && pt === 'MemberExpression' &&
               par.node.object === path.node) cjs = true;
    },
  });
  if (esm) return 'esm';
  if (topThis) return 'top-level-this';
  if (cjs) return 'commonjs';
  return null;
}

/**
 * 合成顶层包装体。只收用户顶层语句，整段必须整体通过区域判定，任何一条不通过就
 * 返回 null、源码保持原样（try/switch/标签/with、带 break/continue 的循环都会命中）。
 * 阈值不在这里判：判定统一留给下面的候选循环，没编译成由调用方回滚结构。
 * 指令序言留在顶层不动，同时克隆一份进包装体，严格模式因此不丢。
 */
function makeTopWrapper(stmts, directives) {
  if (!stmts.length) return null;
  const fn = t.functionExpression(null, [], t.blockStatement(
    stmts,
    (directives || []).map((d) => t.cloneNode(d, true)),
  ));
  if (!canCompile(fn)) return null;
  return fn;
}

// Pass 入口

/**
 * @param {object} ast - 已解析的 AST，就地修改
 * @param {object} options - 选项。vmThreshold 是函数体区域语句数阈值，默认 3；
 *   vmMode 取 global 时处理全部可编译函数，也是默认值；取 comment 时只处理被
 *   起止标记注释圈住的函数（见上方的标记说明）。其他取值一律按 global 处理。
 * @param {object} ctx - 上下文 { traverse, t, usedNames, options, rng }
 * @returns {{compiled:number, considered:number, failed:number, mode:string}}
 */
function vm(ast, options, ctx) {
  const threshold = options.vmThreshold !== undefined ? options.vmThreshold : 3;
  // 运行时密钥取值必须与编译期密钥配对：没有编译期密钥就没有"正确值"可比，
  // 取回什么都能自洽，门禁不成立。这种情况直接报错，不静默降级成一份无效配置。
  if (options.vmRuntimeKeyGetter && !options.vmCompileKey) {
    throw new Error(msg('vmRuntimeKeyNeedsCompileKey'));
  }
  // 函数序号按 pass 运行重置：同一份源码 + 同一密钥必须得到同一套密钥材料
  ctx.__vmKeySeq = 0;
  // WASM 解释器内核档：建立全程序共享的分发字编号空间（解释器在 WASM 内查表分发）
  ctx.__vmWasmShared = null;
  if (options.wasmInterpreter === true) {
    const space = Math.max(512, ctx.options.vmDecoyOps !== undefined ? ctx.options.vmDecoyOps | 0 : 1024);
    const slots = shuffle(Array.from({ length: space }, (_, i) => i));
    ctx.__vmWasmShared = { wordOf: new Map(), slots, next: 0, total: space };
  }
  // WASM 解释器内核档屏蔽掉的选项（compileFunction 里每处都带 && !ctx.__vmWasmShared）。
  //
  // 为什么要显式报出来：这些项不是"没配"而是"配了也没用"。模块内的解释器按栈机、
  // 按绝对下标、按既有指令集硬编码，栈机专有的机制（跳转差值编码、栈编码、宏指令、
  // 动态操作码、异步执行器、分块自解密、运行期密钥取值）在那里没有对应物。
  // vmLayers 不在此列：要嵌套的函数改走 JS 解释器路径（见桥接分支的条件），嵌套在
  // wasm 下依然生效，只是这些函数不进模块（stats.nestedJs 可见数量）。
  // 静默失效的代价是实测出来的：max 预设里 vmBlockDecrypt 为 true，但关掉它产物
  // 一个字节都不变——用户以为自己开了分块自解密，实际一直走的是共享分发字。
  const suppressedByWasm = [];
  if (ctx.__vmWasmShared) {
    const OFF = ['vmJumpsEncoding', 'vmStackEncoding', 'vmMacroOps', 'vmDynOpcodes',
      'vmAsyncExecutor', 'vmBlockDecrypt', 'vmRuntimeKeyGetter'];
    for (const k of OFF) if (options[k]) suppressedByWasm.push(k);
  }
  // 异步执行器（vmAsyncExecutor）。WASM 解释器内核档的解释器在模块里、没有 await
  // 能力，该档整体忽略本项（allowAsync 为 false，async 函数照旧不编译）。
  const allowAsync = !!options.vmAsyncExecutor && !ctx.__vmWasmShared;
  const mode = options.vmMode === 'comment' ? 'comment' : 'global';
  // comment 模式靠起止标记注释挑目标。parse() 把注释挂在 File.comments 上，
  // AST 顶层遍历取不到，所以直接从 ast.comments 读
  const markRanges = mode === 'comment'
    ? markIntervals(ast && Array.isArray(ast.comments) ? ast.comments : [])
    : [];

  // 顶层初始化包装：先判定适用性，再把用户顶层语句搬进合成包装体，让下面的候选
  // 遍历把它当普通函数编译。搬完先不动——没编译成的话结构要回滚。
  // rtlib 注入的内核（ctx.rtKernelStmts）不是保护对象：解释器靠词法引用它，编译它
  // 会造成循环依赖，所以既不搬进包装体，也不参与语义判定
  let topWrap = null;
  let topWrapReason = null;
  if (options.vmWrapTopLevel) {
    const prog = ast && ast.type === 'File' ? ast.program : ast;
    const kernel = new Set(ctx.rtKernelStmts || []);
    const userStmts = prog && prog.body ? prog.body.filter((s) => !kernel.has(s)) : [];
    const userProg = {
      type: 'Program',
      body: userStmts,
      directives: (prog && prog.directives) || [],
      sourceType: prog && prog.sourceType,
    };
    if (ctx.__vmWasmShared) topWrapReason = 'wasm';
    else if (!userStmts.length) topWrapReason = 'empty';
    else {
      topWrapReason = topWrapBlocked(userProg, ctx);
      if (!topWrapReason) {
        const wfn = makeTopWrapper(userStmts, userProg.directives);
        if (wfn) {
          // 包装调用落在内核之后、用户语句原来的位置
          const call = t.expressionStatement(t.callExpression(wfn, []));
          const last = prog.body.reduce((acc, s, i) => (kernel.has(s) ? i : acc), -1);
          const next = prog.body.filter((s) => kernel.has(s));
          next.splice(last + 1, 0, call);
          topWrap = { fn: wfn, saved: prog.body };
          prog.body = next;
        } else topWrapReason = 'uncompilable';
      }
    }
  }

  const fns = [];
  ctx.traverse(ast, {
    FunctionDeclaration: (p) => fns.push(p.node),
    FunctionExpression: (p) => fns.push(p.node),
    ArrowFunctionExpression: (p) => fns.push(p.node),
    ClassMethod: (p) => fns.push(p.node),
    ObjectMethod: (p) => fns.push(p.node),
    noScope: true,
  });

  let compiled = 0;
  let failed = 0;
  let opsReal = 0;
  let opsDecoy = 0;
  // vmMacroOps 的融合计数。放在 ctx 上共享：片段里嵌套的函数由 compileInnerFns
  // 递归编译，计数从那里并回来才不会漏（见 compileFunction 的融合段）
  ctx.__vmMacro = { fused: 0, saved: 0 };
  // 融合跳转 + 流 NOP 的计数（单层复杂度口径）。同样放 ctx 上：嵌套/片段递归
  // 编译的函数也要并回来（emitTestJump 与 NOP 注入里累加）。
  ctx.__vmFused = { jumps: 0, nops: 0 };
  // vmDynOpcodes 的计数：同样放 ctx 上，片段里嵌套编译的函数也要算进来
  ctx.__vmDyn = { applied: false, space: 0 };
  ctx.__vmAsync = { funcs: 0 };
  ctx.__vmDepth = 0;
  ctx.__vmLayerMax = 0;
  ctx.__vmNestJs = 0;
  const rtNames = ctx.rtNames || new Set();
  // 分发形态计数（A=0/B=1/C=2/D=3/E=4）。形态 D 的验收用例据此断言「D 真的出现了」，
  // 也用于观察 vmDispatchEnc 与 vmCompactDispatcher 开关下的形态分布。
  const formCount = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  for (const fn of fns) {
    if (compiledSet.has(fn)) continue; // 已被外层编译过程连带处理
    if (rtNames.size && fn.type === 'FunctionDeclaration' && fn.id && rtNames.has(fn.id.name)) continue; // RT 内核是解释器的引导层，编译它会造成循环依赖
    prepareFn(fn);
    if (!canCompile(fn, allowAsync)) continue;
    if (countRegionStmts(fn.body) < threshold) continue;
    // 模式筛选。comment 只处理起止标记圈住的函数
    if (mode === 'comment' && !isMarkedFn(fn, markRanges)) continue;
    try {
      const r = compileFunction(fn, ctx);
      if (r) {
        compiled++;
        opsReal += r.real;
        // 共享编号空间只有一张全程序分发表，逐函数累加没有意义（还会重复计数），
        // 三个数统一在循环之后按表重算。
        if (!r.shared) opsDecoy += r.decoy;
        if (r.form !== undefined) formCount['ABCDE'[r.form]]++;
      }
    } catch (e) {
      failed++; // 保守处理，该函数保持原样
      if (platform.env('DSH_VM_DEBUG')) console.error('[vm] 编译失败（降级）:', e && e.stack ? e.stack : e);
    }
  }
  // 包装体没进 VM（阈值或形态筛选挡下）就把顶层结构还原：产物里不能留下
  // "搬了家却没受保护"的顶层代码
  let topWrapped = false;
  if (topWrap) {
    if (compiledSet.has(topWrap.fn)) topWrapped = true;
    else {
      const prog = ast && ast.type === 'File' ? ast.program : ast;
      prog.body = topWrap.saved;
      topWrapReason = 'not-compiled';
    }
  }
  // 共享编号空间（WASM 解释器内核档）下三个数必须换一套口径，否则 total 会混单位。
  //
  // 逐函数档：real 是各函数字面量用到的指令种类数之和，decoy 是这些函数字面量各自
  // 生成的干扰字数之和，两者相加 = 分发器实际要枚举的分发字总数，同单位可比。
  //
  // 共享档：全程序只有一张分发表，各函数字面量不生成干扰处理器。此时若仍按函数累加
  // real（不同函数用到的指令种类会重复计数），再配上"共享槽剩余数"这个全局量，
  // 相加得到的 total 是两套单位之和——3 个函数时能算出 1040 而表本身只有 1024 槽。
  // 所以共享档整体改用表的口径：real = 已占槽、decoy = 空槽、total = 表大小。
  if (ctx.__vmWasmShared) {
    const sh3 = ctx.__vmWasmShared;
    const used = Math.min(sh3.next, sh3.slots.length);
    opsReal = used;
    opsDecoy = sh3.slots.length - used;
  }
  return {
    compiled,
    considered: fns.length,
    failed,
    mode,
    topLevel: options.vmWrapTopLevel
      ? { wrapped: topWrapped, reason: topWrapped ? 'ok' : topWrapReason }
      : { wrapped: false, reason: 'off' },
    // 指令集规模。每个编译函数的分发器要枚举 real+decoy 个分发字，干扰项通常不少于 1000。
    // shared 为 true 时这三个数换用共享表的口径（real=已占槽、decoy=空槽、total=表大小），
    // 逐函数档与共享档因此不可直接相减比较，见上面那处说明。
    ops: { real: opsReal, decoy: opsDecoy, total: opsReal + opsDecoy, shared: !!ctx.__vmWasmShared },
    // vmMacroOps：融合出的宏指令条数，与因此少掉的指令条数（字流相应变短）
    macros: { fused: ctx.__vmMacro.fused, saved: ctx.__vmMacro.saved },
    // 单层复杂度：融合关系跳转条数 + 流干扰 NOP 条数（0 表示本函数没融上/没插上）
    fused: { jumps: ctx.__vmFused.jumps, nops: ctx.__vmFused.nops },
    // vmDynOpcodes：是否真的生效，以及取整后的字空间大小（0 表示本项没生效）
    dyn: { applied: ctx.__vmDyn.applied, space: ctx.__vmDyn.space },
    // vmAsyncExecutor：被 WASM 解释器内核档挡下或 await 落进闭包被保守放弃时为 0。
    asyncExec: { funcs: ctx.__vmAsync.funcs },
    // 实际嵌套了几层 VM。默认所有 VM 编译都深度 1（外层解释器就是底层解释器）；
    // vmLayers>=2 成功嵌套的函数每多一层就把这个值往上加一级。失败回退则保持低位值。
    layers: ctx.__vmLayerMax > 0 ? ctx.__vmLayerMax : 1,
    // wasm 下为嵌套让路、改走 JS 路径的函数数（仍受 WASM 模块保护的是最内层，
    // 它以桥接形态进模块，见桥接分支的说明）。
    nestedJs: ctx.__vmNestJs | 0,
    forms: formCount,
    // WASM 内核档屏蔽掉的选项（配了但在本档不生效的）。空数组 = 没有静默失效的项。
    suppressed: suppressedByWasm,
  };
};

// 默认导出是 vm 函数本身，isVMCompiled 另以具名导出与函数属性两种形态给出
vm.isVMCompiled = isVMCompiled;

export default vm;
export { isVMCompiled, FUSED_REL_OPS };
