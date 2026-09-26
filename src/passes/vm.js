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
 * 读写，闭包链不断。生成器与 async、含 await/yield/super/new.target 的表达式、
 * 私有名成员、直接 eval 调用、try/switch/labeled/with/class 声明、for-in/of 子树
 * 内含 return 或函数声明或 var 解构，这些一律放弃编译，函数体保持原样。
 *
 * 本 pass 最先执行。已编译函数经 isVMCompiled() 登记，controlFlow 据此跳过，解释器
 * 不宜再被状态机包裹；B/K 内的数字与字符串随后仍由 stringArray 正常混淆。
 */
import t from '../ast/types.js';
import parser from '../ast/parser.js';
import rtlib from './rtlib.js';
import rand from '../utils/rand.js';
const { shuffle, uniqueName, randInt } = rand;
import i18n from '../i18n.js';
const { t: msg } = i18n;
import platform from '../platform.js';

// 已编译函数登记，controlFlow 据此跳过
const compiledSet = new WeakSet();
function isVMCompiled(fn) {
  return compiledSet.has(fn);
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

function canCompile(fn) {
  if (!fn || fn.generator || fn.async) return false;
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
  return t.functionExpression(decl.id, decl.params, decl.body, decl.generator, decl.async);
}

const JUMP_KINDS = new Set(['JMP', 'JPF', 'JPT', 'JANDK', 'JORK', 'JNULK']);
const ARG1_KINDS = new Set(['LDC', 'LOD', 'STR', 'GET', 'SET', 'FRAG', 'EXEC', 'MKS']);
const ARG2_KINDS = new Set(['JANDK', 'JORK', 'JNULK']);

// 编译器

function compileFunction(fn, ctx) {
  const opts = ctx.options;
  const threshold = opts.vmThreshold !== undefined ? opts.vmThreshold : 3;

  // 编译期密钥（vmCompileKey）。给了密钥时，本函数的密钥材料不再取自 randInt，
  // 而由「密钥 + 本函数序号」哈希派生出的确定性流给出：
  //   - 同一密钥每次构建得到同一套密钥材料，产物可复现；
  //   - 没有密钥就复现不出掩码与位置散列，字节码字的解密式也就凑不出来。
  // 没给密钥时 krand 直接转发 randInt，产物与改动前**逐字节一致**（自测基线不动）。
  // 注意只切换「密钥材料」这一组取值；干扰字、分发形态、寄存器模型等仍走 randInt，
  // 所以形态多态性不受影响。
  const keyText = opts.vmCompileKey ? String(opts.vmCompileKey) : '';
  const keyed = !!keyText;
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
    if (keyState === 0) keyState = 0x9e3779b9; // 0 是 xorshift32 的不动点，避开
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

  // 运行时密钥取值（vmRuntimeKeyGetter）。与编译期密钥**配对**使用：产物在每个 VM
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

  // P4 多态寄存器模型：逐函数随机抽一种执行结构不同的模型。
  //   M0 纯栈式     —— 只有值栈 S，push/pop 直连，产物里没有寄存器变量
  //   M1 寄存器优先 —— 环形寄存器窗口，值优先落寄存器
  //   M2 双栈分立   —— 操作数栈 + 地址栈，GETM/SETM/CALLM 走地址栈
  // WASM 解释器内核档对栈模型有硬编码假设，该档强制 M0；vmModel 可显式锁定
  // （自测用：M0/M1/M2 三档语义必须等价）。
  let vmModel = 'M0';
  if (!ctx.__vmWasmShared) {
    const forced = opts.vmModel;
    if (forced === 'M0' || forced === 'M1' || forced === 'M2') vmModel = forced;
    else vmModel = opts.vmPolymorph ? 'M' + randInt(0, 2) : 'M1';
  }
  ctx.vmModel = vmModel;

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
  const V = t.identifier(nV), G = t.identifier(nG), H = t.identifier(nH);
  const K = t.identifier(nK), B = t.identifier(nB), S = t.identifier(nS);
  const J = t.identifier(nJ); // 字符串码元表，MKS 指令在运行期解密还原成 string
  const PC = t.identifier(npc);
  const MASK = t.identifier(nM);

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
  // 位置散列：base 是项序号经 STR_P 预混后的常数分量，j 是项内下标
  const strPosExpr = (baseNode, jNode) => t.binaryExpression('^',
    t.binaryExpression('^',
      t.binaryExpression('>>>',
        rtlib.mulCall(ctx,
          t.binaryExpression('+', baseNode, jNode),
          t.numericLiteral(STR_K1)),
        t.numericLiteral(8)),
      t.numericLiteral(STR_K2)),
    t.numericLiteral(STR_M0));
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
        t.binaryExpression('<', t.identifier(nT1),
          t.memberExpression(row, t.identifier('length'), false)),
        t.updateExpression('++', t.identifier(nT1), false),
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
  const compileInnerFns = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(compileInnerFns); return; }
    if (typeof node.type !== 'string') return;
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression' || node.type === 'ClassMethod' ||
        node.type === 'ObjectMethod') {
      if (!compiledSet.has(node)) {
        prepareFn(node);
        if (canCompile(node) && countRegionStmts(node.body) >= threshold) {
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
    emitMemberObject(left.object, false);
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

  // 成员目标压栈。M2 下只有「读」流（GETM / CALLM_）把对象搬到地址栈 SA；
  // 「赋值目标」流（SETM / GETMK 前导）保持对象在操作数栈，与 M0/M1 逐字一致。
  // 这样 GETMK 的 o,k 不变式、JANDK 系的 splice 计数与 SETM 的三弹栈逻辑
  // 在三种模型下完全相同，地址栈只负责读路径，语义分叉面最小。
  // 用编译期搬栈（而不是在 emitExpr 里按模型分流）的好处：emitExpr 保持单一实现，
  // 三种模型只在「对象最终落在哪张栈」上分叉，字节码操作数布局不变。
  function emitMemberObject(obj, toSA) {
    emitExpr(obj);
    if (vmModel === 'M2' && toSA) emit('STA');
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
        emitExpr(node.test);
        const j = emit('JPF', -1);
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
        emitMemberObject(node.object, true);
        if (node.computed) emitExpr(node.property);
        else emit('MKS', litString(node.property.name));
        emit('GETM');
        return;
      case 'CallExpression': {
        const callee = node.callee;
        if (callee.type === 'MemberExpression') {
          emitMemberObject(callee.object, true);
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
        emitExpr(s.test);
        const j = emit('JPF', -1);
        emitStmt(s.consequent);
        const m = emit('JMP', -1);
        code[j].a = code.length;
        emitStmt(s.alternate);
        code[m].a = code.length;
        return;
      }
      case 'WhileStatement': {
        const top = code.length;
        emitExpr(s.test);
        const j = emit('JPF', -1);
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
        emitExpr(s.test);
        emit('JPT', top);
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
          emitExpr(s.test);
          jTest = emit('JPF', -1);
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

  // 发射顺序：先提升序言函数声明，再发其余语句，最后 END
  const origStmts = fn.body.body;
  const origDirectives = fn.body.directives;
  for (const s of origStmts) {
    if (s.type === 'FunctionDeclaration') emitStmt(s);
  }
  for (const s of origStmts) {
    if (s.type !== 'FunctionDeclaration') emitStmt(s);
  }
  emit('END');

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
  const totalSlots = opKinds.length + decoyTarget;
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
    const e = code[i];
    pos[i] = acc;
    const isJump = JUMP_KINDS.has(e.op);
    acc += 1 + (ARG2_KINDS.has(e.op) ? 2 + (isJump ? 1 : 0) : isJump ? 2 : ARG1_KINDS.has(e.op) ? 1 : 0);
  }
  // 链式加密布局。
  // 链值取前一字的明文，字 -1 的链值是 CHAIN_SEED。密文 flat[z] 等于
  // 明文 ^ 位置分量 ^ 初始掩码 ^ chainAt[z]，其中 chainAt[z] 就是前一字的明文。
  // 任何一字的解密都要用到前一字的明文，没法从任意下标单独解密，只能从字 0 顺序推进。
  // 跳转指令额外携带目标处的链值字，跳转之后链状态就恢复成目标处的预期值。
  const CHAIN_SEED = krand(1, 0xfffffff) | 0;
  // 字布局：owner[z] = { instr, slot }（slot 0=opcode, 1/2=操作数, 3=链值字）
  const owner = [];
  const words = []; // 明文字，null 是链值字占位，后面迭代填上
  for (let i = 0; i < code.length; i++) {
    const e = code[i];
    const isJump = JUMP_KINDS.has(e.op);
    const w = 1 + (ARG2_KINDS.has(e.op) ? 2 + (isJump ? 1 : 0) : isJump ? 2 : ARG1_KINDS.has(e.op) ? 1 : 0);
    for (let s = 0; s < w; s++) owner.push({ instr: i, slot: s });
    words.push(opNums.get(e.op));
    if (ARG2_KINDS.has(e.op)) {
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
  for (let z = 0; z < words.length; z++) {
    if (owner[z].instr >= 0 && owner[z].slot === 0) opZ.set(owner[z].instr, z);
  }
  // 目标链值取目标 opcode 字的前一字明文，z 为 0 时就是 CHAIN_SEED
  const targetChainOf = (instrIdx) => {
    const tz = opZ.get(instrIdx);
    return tz === 0 ? CHAIN_SEED : words[tz - 1];
  };
  // 链值字求解。链值字的明文等于所属跳转目标的链值，而目标 opcode 的前一字可能又是
  // 另一个跳转的链值字，所以要递归展开并记忆化。环上的依赖来自跳转目标互指，每个环上
  // 字的值最终由环外的锚定字决定，按值传播就能解出来。
  const memo = new Map(); // 字下标 -> 已求明文
  const solving = new Set(); // 递归栈（环检测）
  const wordAt = (z) => {
    if (memo.has(z)) return memo.get(z);
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
  // 环上字的真实值由环外第一个非环依赖链的锚定值传播而来。
  let round = 0;
  let progressed = true;
  while (progressed && round++ < words.length + 4) {
    progressed = false;
    memo.clear();
    for (let z = 0; z < words.length; z++) {
      if (words[z] === null) {
        const v = wordAt(z);
        if (words[z] !== v) { words[z] = v; progressed = true; }
      } else {
        memo.set(z, words[z]);
      }
    }
  }
  if (words.some((w) => w === null)) throw new Error(msg('vmChainSolveFailed'));
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
  if (ctx.__vmWasmShared) {
    if (!ctx.__vmBridgeName) ctx.__vmBridgeName = uniqueName(ctx.usedNames, '_0x');
    const fIdx = (ctx.__vmWasmCount = (ctx.__vmWasmCount || 0) + 1) - 1;
    const paramOrder = [];
    for (const p of fn.params) {
      for (const nm in t.getBindingIdentifiers(p)) paramOrder.push(nm);
    }
    if (paramOrder.length > 64) throw new Error(msg('vmWasmTooManyParams'));
    const argslots = paramOrder.map((nm) => (slotOf.has(nm) ? slotOf.get(nm) : -1));
    const dirStmtsW = (origDirectives || []).map((d) => {
      const v = d.value && d.value.type === 'StringLiteral' ? d.value.value : d.value;
      return t.expressionStatement(t.stringLiteral(v));
    });
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
    return { real: usedOps.size, decoy: 0 };
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
  const Slen = () => t.memberExpression(S, t.identifier('length'), false);
  const topElem = () => t.memberExpression(S,
    t.binaryExpression('-', Slen(), t.numericLiteral(1)), true);
  // 任意数组的栈顶引用。地址栈与操作数栈共用同一形态
  const topOf = (arr) => t.memberExpression(arr,
    t.binaryExpression('-',
      t.memberExpression(arr, t.identifier('length'), false), t.numericLiteral(1)), true);
  const declConst = (name, init) =>
    t.variableDeclaration('const', [t.variableDeclarator(t.identifier(name), init)]);
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
  // **不能**用 a / b / c / v / f / k / o / x0 这类短名：解释器的语句是直接塞进用户
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
  // 形参名按下标缓存，同一条指令内的多个参数共用一个池，彼此不冲突
  const argNameCache = [];
  const argNames = (count) => {
    for (let i = argNameCache.length; i < count; i++) argNameCache.push(uniqueName(ctx.usedNames, '_0x'));
    return argNameCache.slice(0, count);
  };

  // 寄存器窗口，形成栈与寄存器混合的数据流。
  // 一组轮转伪寄存器，每个 case 内的 push/pop 值先落到寄存器再进出栈，静态数据流
  // 因此必须同时追踪寄存器组与栈两层。轮转槽位由构建期逐 case 随机起点决定，
  // 跨 case 的寄存器占用图不规则。
  const REGN = ctx.vmModel === 'M0' ? 0 : (ctx.vmModel === 'M1' ? 5 : randInt(3, 5)); // 寄存器组大小（M0 纯栈式无寄存器）
  const REGS = Array.from({ length: REGN }, () => uniqueName(ctx.usedNames, '_0x'));
  let regSpin = randInt(0, Math.max(0, REGN - 1)); // 起点随机
  // P3 随机化补强：每个 case 重新随机起点，而不是全函数一条固定的轮转序列。
  // 跨 case 的寄存器占用图因此不规则，静态按「第 k 次 push 落在哪号寄存器」
  // 做归纳会失败。
  const reseedSpin = () => { if (REGN > 0) regSpin = randInt(0, REGN - 1); };
  // REGN === 0（M0 纯栈式）时 nextReg 不应被调用；真被调用时明确抛错而不是
  // 静默产出 REGS[NaN] 这种无名 Identifier 节点（会让生成器报"AST 已损坏"）。
  const nextReg = () => {
    if (REGN === 0) throw new Error(msg('vmUnknownOpcode', { kind: 'nextReg@M0' }));
    const r = REGS[regSpin % REGN]; regSpin = (regSpin + 1) % REGN; return r;
  };
  // 压栈经寄存器：R = 值; push(R)。M0 纯栈式模型下没有寄存器，直接落栈。
  // （P4 多态寄存器模型：M0 纯栈 / M1 寄存器优先 / M2 双栈分立，见 ctx.vmModel）
  const pushR = (val) => {
    if (REGN === 0) {
      return [t.expressionStatement(t.callExpression(
        t.memberExpression(S, t.identifier('push'), false), [val]))];
    }
    const r = nextReg();
    return [
      t.expressionStatement(t.assignmentExpression('=', idn(r), val)),
      t.expressionStatement(t.callExpression(
        t.memberExpression(S, t.identifier('push'), false), [idn(r)])),
    ];
  };
  // 出栈经寄存器：R = pop()，表达式值就是 R 的引用。M0 下直接 pop。
  const popR = () => {
    if (REGN === 0) {
      return t.callExpression(t.memberExpression(S, t.identifier('pop'), false), []);
    }
    const r = nextReg();
    return t.sequenceExpression([
      t.assignmentExpression('=', idn(r),
        t.callExpression(t.memberExpression(S, t.identifier('pop'), false), [])),
      idn(r),
    ]);
  };
  // 不经寄存器的原语。部分 case 直连栈，两种形态混用让数据流更不规则
  const pushCall = (x) => t.expressionStatement(t.callExpression(
    t.memberExpression(S, t.identifier('push'), false), [x]));
  const popCall = () => t.callExpression(t.memberExpression(S, t.identifier('pop'), false), []);

  // P4 模型 M2：地址栈。成员访问类指令（GETM/SETM/CALLM）的目标对象与键不改从
  // 操作数栈出，而从第二张栈 SA 出。静态上「一个栈」的模型不再成立：同一条指令
  // 序列里出现两套 push/pop，且哪套用在哪种指令上不按位置规律。
  // M0/M1 下 SA 为 null，指令实现与改造前逐字节一致。
  const SA = vmModel === 'M2' ? t.identifier(uniqueName(ctx.usedNames, '_0x')) : null;
  const pushA = (x) => t.expressionStatement(t.callExpression(
    t.memberExpression(SA, t.identifier('push'), false), [x]));
  const popA = () => t.callExpression(t.memberExpression(SA, t.identifier('pop'), false), []);
  // 模型 M2 的成员指令栈序：目标对象走 SA，键留在 S，操作数在 S。
  // 编译期压栈顺序是 [obj, key, ...args]（与栈机一致），所以出栈顺序是倒序。
  const popMemberTarget = (kind) => {
    if (vmModel !== 'M2') return { obj: () => popR(), key: () => popR() };
    return { obj: () => popA(), key: () => popR() };
  };

  // MKS 的临时名逐函数唯一，避免与 case 体里其它分支的局部名互相遮蔽
  const nSX = uniqueName(ctx.usedNames, '_0x'); // 字符串表下标
  const nSS = uniqueName(ctx.usedNames, '_0x'); // 该字符串的码元表
  const nSO = uniqueName(ctx.usedNames, '_0x'); // 还原中的累积串
  const nSJ = uniqueName(ctx.usedNames, '_0x'); // 码元游标

  function caseBody(kind) {
    reseedSpin(); // P3：每条指令重新随机寄存器轮转起点
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
    if (kind === 'MKS') return [
      declConst(nSX, bAt()),
      declConst(nSS, t.memberExpression(J, idn(nSX), true)),
      t.variableDeclaration('var', [t.variableDeclarator(idn(nSO), t.stringLiteral(''))]),
      t.forStatement(
        t.variableDeclaration('var', [t.variableDeclarator(idn(nSJ), t.numericLiteral(0))]),
        t.binaryExpression('<', idn(nSJ), t.memberExpression(idn(nSS), t.identifier('length'), false)),
        t.updateExpression('++', idn(nSJ), false),
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
      ...pushR(idn(nSO)),
    ];
    if (kind === 'GETM') return [
      declConst(N_B, popMemberTarget().key()), declConst(N_A, popMemberTarget().obj()),
      ...pushR(t.memberExpression(idn(N_A), idn(N_B), true)),
    ];
    // SETM：赋值流的对象从未离开操作数栈（见 emitMemberObject 的 toSA 约定），
    // 三种模型统一从这里弹 3 个值（值、键、对象）。
    if (kind === 'SETM') return [
      declConst(N_C, popR()), declConst(N_B, popR()), declConst(N_A, popR()),
      t.expressionStatement(t.assignmentExpression('=',
        t.memberExpression(idn(N_A), idn(N_B), true), idn(N_C))),
      ...pushR(idn(N_C)), // 成员存完之后压回，作为赋值表达式的结果
    ];
    // GETMK：把成员目标对象、键与当前值（o[k]）压栈，供 SETM 回写或提前定值弹栈。
    // 赋值流的对象不进地址栈（toSA=false），所以这里在三种模型下都是同一形态：
    // 复制栈顶两个（o、k）再求 o[k]，S = [..., o, k, o[k]]。
    if (kind === 'GETMK') {
      return [pushCall(t.memberExpression(
        t.memberExpression(S, t.binaryExpression('-', Slen(), t.numericLiteral(2)), true),
        topElem(), true))];
    }
    if (kind === 'DUP') return [pushCall(topElem())];
    if (kind === 'POP') return [t.expressionStatement(popCall())];
    // P4 模型 M2：把操作数栈顶搬到地址栈。只在 M2 的成员目标处出现。
    if (kind === 'STA') return [pushA(popCall())];
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
        declConst(N_V, topElem()),
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
    if (kind === 'RETU' || kind === 'END') return [t.returnStatement(null)];
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
      if (vmModel === 'M2') {
        // M2：目标对象走地址栈 SA，键与参数走操作数栈。
        // 编译期每 c.args 的压栈次序：先 c.obj → SA，再 c.key → S，再实参 → S。
        // 出栈倒序：先实参，再键，最后对象。
        return [
          ...args.slice().reverse().map((nm) => declConst(nm, popR())),
          declConst(N_K, popMemberTarget().key()),
          declConst(N_O, popMemberTarget().obj()),
          ...pushR(t.callExpression(t.memberExpression(idn(N_O), idn(N_K), true), args.map(idn))),
        ];
      }
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
    throw new Error(msg('vmUnknownOpcode', { kind }));
  }

  // 干扰项处理器池，每构建随机生成，JN 个箭头函数共享，体量因此可控。
  // 每个干扰体都是净无副作用的：只读栈长、K、B、PC、MASK，读写寄存器组，
  // 读写垃圾暂存数组与双暂存，push 与 pop 相互对冲。它绝不触碰 V 槽位内容、
  // G/H 闭包，也不写 PC、nCHAIN 与掩码。真实 case 里的寄存器一律先写后读，
  // 不存在跨 case 存活的值，所以干扰体动寄存器是安全的。干扰体的结构与真实
  // 动作同形，寄存器算术、栈访问、槽位式写都齐备，无法按形态过滤。
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
  const slenE = () => t.memberExpression(S, t.identifier('length'), false);
  // M0 纯栈式没有寄存器，干扰体一律改用垃圾数组做寄存器式算术（形态仍与真实
  // 寄存器窗口一致：读-改-写一个下标面），静态上分辨不出这里与真实寄存器动作。
  const junkReg = () => (REGN === 0
    ? t.memberExpression(idn(nDV), t.binaryExpression('%',
      t.binaryExpression('+', PC, t.numericLiteral(randInt(0, 7))),
      t.memberExpression(idn(nDV), t.identifier('length'), false)), true)
    : idn(REGS[randInt(0, REGN - 1)]));
  const junkStmt = () => {
    switch (randInt(0, 6)) {
      case 0: // 寄存器算术，形态与真实 case 的寄存器窗口一致
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
            t.memberExpression(S, t.identifier('push'), false), [slenE()])),
          t.expressionStatement(t.callExpression(
            t.memberExpression(S, t.identifier('pop'), false), [])),
        ]);
      case 3: // 只读 K 再异或
        return t.expressionStatement(t.assignmentExpression('=', junkReg(),
          t.binaryExpression('^',
            t.binaryExpression('|',
              t.memberExpression(K, t.binaryExpression('&',
                t.binaryExpression('-', t.memberExpression(K, t.identifier('length'), false), t.numericLiteral(1)),
                t.numericLiteral(7)), true),
              t.numericLiteral(0)),
            t.numericLiteral(randInt(1, 0xff)))));
      case 4: // 垃圾数组轮转，形似 V 槽位写，下标经 length 取模保证不越界
        // S、K、PC、MASK 已经是 Identifier 节点，直接用；nDV、nT0、nT1、REGS
        // 是名字字符串，要经 idn() 转成节点。
        return t.expressionStatement(t.assignmentExpression('=',
          t.memberExpression(idn(nDV), t.binaryExpression('%',
            t.binaryExpression('+', PC, t.numericLiteral(randInt(0, 7))),
            t.memberExpression(idn(nDV), t.identifier('length'), false)), true),
          t.binaryExpression('^',
            t.memberExpression(idn(nDV), t.binaryExpression('%',
              t.binaryExpression('+', PC, t.numericLiteral(randInt(1, 8))),
              t.memberExpression(idn(nDV), t.identifier('length'), false)), true),
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

  // 桶内比对 t === 分发字 d，d 在构建期已知，与字节码流一致
  const fullCmp = (e) => t.binaryExpression('===',
    t.identifier(_dispT),
    t.numericLiteral(e.word));

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
  const dispatchForm = ctx.options.vmCompactDispatcher
    ? 4
    : (ctx.options.vmDispatchEnc
      ? (randInt(0, 3) === 0 ? randInt(0, 2) : 3) // 75% 走 D，25% 仍走 A/B/C（避免形态单一）
      : randInt(0, 2)); // 0 为 A，1 为 B，2 为 C，3 为 D，4 为 E（紧凑）
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
      t.binaryExpression('<',
        t.identifier(_q),
        t.memberExpression(t.identifier(_rw), t.identifier('length'), false)),
      t.updateExpression('++', t.identifier(_q), false),
      t.blockStatement([
        t.variableDeclaration('var', [
          t.variableDeclarator(t.identifier(_e),
            t.memberExpression(t.identifier(_rw), t.identifier(_q), true)),
        ]),
        t.ifStatement(
          t.binaryExpression('===',
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
    //      与形态 B 同一套转换）。**语义只以「在 A 里的下标」存在**，产物里没有
    //      「分发字 = 语义」的对应。
    //   2. 条目密文表 C：把 (bucket, word, actIdx) 三元组编码成整数流，逐项与
    //      「位置散列 ^ 桶盐 ^ 表掩码」异或。产物里 C 是一串看似随机的整数。
    //   3. 运行期在解释器循环**之前**一次性解出 C，填充桶索引 BI[bucket]，
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
    // 构建期掩码必须与运行期 biMask **逐字同构**（注意这里没有 deMask 的 +1 偏移），
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
        t.binaryExpression('<', idn(DDR),
          t.binaryExpression('/', t.memberExpression(t.identifier(C_TBL), t.identifier('length'), false),
            t.numericLiteral(3))),
        t.updateExpression('++', idn(DDR), false),
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
        t.binaryExpression('<', idn(DDR), t.numericLiteral(NB_LIT)),
        t.updateExpression('++', idn(DDR), false),
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
        t.binaryExpression('<', idn(_q),
          t.binaryExpression('-',
            t.memberExpression(idn(BHI), idn(_bk), true), t.numericLiteral(1))),
        t.updateExpression('++', idn(_q), false),
        t.blockStatement([
          t.ifStatement(
            t.binaryExpression('===',
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
    //   2. 条目密文流 C：按字下标就地存放，**位置即字**，每项只有动作下标那一个字与
    //      位置散列异或——产物里是一串整数，长度正好等于字空间大小。
    //   3. 运行期在循环之前把 C 解成**直接寻址表** M：M[word] = C[word] ^ 位置掩码，
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
    // **位置即分发字**：条目按字下标就地存放，每项只存一个加密的动作下标。
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
        t.binaryExpression('<', idn(DDR),
          t.memberExpression(t.identifier(C_TBL), t.identifier('length'), false)),
        t.updateExpression('++', idn(DDR), false),
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
        t.binaryExpression('===', idn(_bk), t.numericLiteral(b)),
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
    // 越界守卫，**只在开启运行期密钥（useRtKey）时生成**：取回的密钥不对时所有分发
    // 条目都落空，取指游标会一直越界读下去变成死循环，把浏览器主线程挂死。这里改成
    // 明确抛出，失败模式从"卡死"变成"立刻报错"。密钥正确时 END 一定会先 return，
    // 所以这道守卫不会误伤；默认路径（不开启本项）一条指令都不多。
    ...(rt ? [t.ifStatement(
      t.binaryExpression('>', t.identifier(npc),
        t.memberExpression(B, t.identifier('length'), false)),
      t.blockStatement([t.throwStatement(t.newExpression(
        t.identifier('Error'), [t.stringLiteral(msg('vmKeyMismatch'))]))]))] : []),
    t.variableDeclaration('var', [
      t.variableDeclarator(t.identifier(_dispT), bAt()),
    ]),
    // 桶号每指令求值一次（三形态共用；此前在表扫描条件/体内与 if 链中
    // 逐次重算，一条指令要重复求值桶映射 2~2×桶数次）
    t.variableDeclaration('var', [
      t.variableDeclarator(t.identifier(_bk), bucketExpr()),
    ]),
    dispatchBody,
  ]);
  const interpLoop = randInt(0, 1) === 0
    ? t.forStatement(null, null, null, interpBody)
    : t.whileStatement(t.booleanLiteral(true), interpBody);

  // 组装新函数体，依次放入指令序、参数拷贝、捕获名的 var 声明与解释器
  const dirStmts = (origDirectives || []).map((d) => {
    const v = d.value && d.value.type === 'StringLiteral' ? d.value.value : d.value;
    return t.expressionStatement(t.stringLiteral(v));
  });
  const runtimeDecl = t.variableDeclaration('var', shuffle([
    t.variableDeclarator(V, t.arrayExpression([])),
    t.variableDeclarator(G, t.arrayExpression(getterNodes)),
    t.variableDeclarator(H, t.arrayExpression(setterNodes)),
    t.variableDeclarator(K, t.arrayExpression(consts)),
    t.variableDeclarator(J, t.arrayExpression(stringsEnc.map((row) =>
      t.arrayExpression(row.map((n) => t.numericLiteral(n)))))),
    t.variableDeclarator(B, t.arrayExpression(flat.map((n) => t.numericLiteral(n)))),
    t.variableDeclarator(S, t.arrayExpression([])),
    // P4 模型 M2 的地址栈。仅在 M2 下声明；M0/M1 下 SA 为 null，声明里不出现。
    ...(SA ? [t.variableDeclarator(SA, t.arrayExpression([]))] : []),
    t.variableDeclarator(PC, t.numericLiteral(0)),
    t.variableDeclarator(MASK, kLit(MASK_M0, rt && rt.M0)),
    t.variableDeclarator(t.identifier(nCHAIN), kLit(CHAIN_SEED, rt && rt.CS)), // 链值状态
    t.variableDeclarator(t.identifier(nCHN), t.numericLiteral(0)),           // 取指暂存
    // 寄存器窗口，压栈与出栈都经这里中转
    ...REGS.map((r) => t.variableDeclarator(idn(r), t.numericLiteral(0))),
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
      t.binaryExpression('<', t.identifier(nZI), t.memberExpression(B, t.identifier('length'), false)),
      t.updateExpression('++', t.identifier(nZI), false),
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
  // 运行期密钥派生语句。与构建期 krand 的调用顺序**逐项对齐**：
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
        t.binaryExpression('<', RI(), t.memberExpression(RS(), t.identifier('length'), false)),
        t.updateExpression('++', RI(), false),
        t.blockStatement([
          setKS(shru(rtlib.mulCall(ctx, xor(KS(), t.callExpression(
            t.memberExpression(RS(), t.identifier('charCodeAt'), false), [RI()],
          )), num(0x01000193)), num(0))),
        ]),
      ),
      // 0 是 xorshift32 的不动点，与构建期同一处兜底
      t.ifStatement(
        t.binaryExpression('===', KS(), num(0)),
        t.blockStatement([setKS(num(0x9e3779b9))])),
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
  return { real: opKinds.length, decoy: decoys.length, total: entries.length, form: dispatchForm };
}

// 目标筛选，由 vmMode 决定，取值 global、comment 或 only-string

/**
 * comment 模式下只处理被 -jsvmp- 注释标记的函数，命中位置有两类：
 * 一是注释落在函数体内某条语句的区间上，即体内任意语句的 srcIdx 落在注释区间内；
 * 二是注释紧贴函数声明之前，此时本函数是注释结束后下标最小的那个声明头。
 * 注释区间来自 parse() 的 lexer.comments，在构建期收集。
 */
const JSVMP_RE = /-jsvmp-/;

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
 * 判断函数是否被任一 -jsvmp- 注释标记。
 * @param fn - 函数节点，body 已确认为 BlockStatement
 * @param vmpComments - 全部 -jsvmp- 注释区间
 * @param allHeads - 全部候选函数的头下标，含自身，用于最近声明判定
 * @returns {boolean} 被标记时为 true
 */
function isMarkedFn(fn, vmpComments, allHeads) {
  if (!vmpComments || !vmpComments.length) return false;
  const head = fnHeadIdx(fn);
  const idxs = [];
  collectStmtIdx(fn.body, idxs);
  for (const c of vmpComments) {
    // 命中方式一，注释区间盖住了体内某条语句
    for (const ix of idxs) {
      if (ix >= c.start && ix <= c.end) return true;
    }
    // 命中方式二，本函数头是该注释之后最近的声明头
    if (head !== Infinity && head >= c.end) {
      let nearest = Infinity;
      for (const h of allHeads) {
        if (h >= c.end && h < nearest) nearest = h;
      }
      if (nearest === head) return true;
    }
  }
  return false;
}

/** only-string 模式用，判断函数体内是否含字符串字面量或模板串。 */
function hasStringLiteral(root) {
  let found = false;
  (function walk(node) {
    if (found || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node.type !== 'string') return;
    if (node.type === 'StringLiteral') { found = true; return; }
    if (node.type === 'TemplateLiteral') { found = true; return; }
    // 不深入嵌套函数，内嵌函数是独立候选，它自己的字符串归它自己的判定
    if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression' ||
        node.type === 'FunctionDeclaration' || node.type === 'ClassMethod' ||
        node.type === 'ObjectMethod') return;
    eachChild(node, walk);
  })(root);
  return found;
}

// Pass 入口

/**
 * @param {object} ast - 已解析的 AST，就地修改
 * @param {object} options - 选项。vmThreshold 是函数体区域语句数阈值，默认 3；
 *   vmMode 取 global 时处理全部可编译函数，也是默认值，取 comment 时只处理被
 *   -jsvmp- 注释标记的函数，取 only-string 时只处理函数体含字符串字面量的函数
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
  const mode = options.vmMode === 'comment' || options.vmMode === 'only-string'
    ? options.vmMode
    : 'global';
  // comment 模式靠 -jsvmp- 注释挑目标。parse() 把注释挂在 File.comments 上，
  // AST 顶层遍历取不到，所以直接从 ast.comments 读
  const vmpComments = (ast && Array.isArray(ast.comments))
    ? ast.comments.filter((c) => JSVMP_RE.test(c.text || ''))
    : [];

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
  const rtNames = ctx.rtNames || new Set();
  // 分发形态计数（A=0/B=1/C=2/D=3/E=4）。形态 D 的验收用例据此断言「D 真的出现了」，
  // 也用于观察 vmDispatchEnc 与 vmCompactDispatcher 开关下的形态分布。
  const formCount = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  // 寄存器模型计数（P4 多态验收用）
  const modelCount = { M0: 0, M1: 0, M2: 0 };
  // comment 模式的最近声明头判定要用到全部候选函数的头下标
  const allHeads = fns.map((fn) => fnHeadIdx(fn));
  for (const fn of fns) {
    if (compiledSet.has(fn)) continue; // 已被外层编译过程连带处理
    if (rtNames.size && fn.type === 'FunctionDeclaration' && fn.id && rtNames.has(fn.id.name)) continue; // RT 内核是解释器的引导层，编译它会造成循环依赖
    prepareFn(fn);
    if (!canCompile(fn)) continue;
    if (countRegionStmts(fn.body) < threshold) continue;
    // 模式筛选。comment 只挑被标记的函数，only-string 只挑含字符串的函数
    if (mode === 'comment' && !isMarkedFn(fn, vmpComments, allHeads)) continue;
    if (mode === 'only-string' && !hasStringLiteral(fn.body)) continue;
    try {
      const r = compileFunction(fn, ctx);
      if (r) {
        compiled++;
        opsReal += r.real;
        opsDecoy += r.decoy;
        if (r.form !== undefined) formCount['ABCDE'[r.form]]++;
        if (ctx.vmModel) modelCount[ctx.vmModel]++;
      }
    } catch (e) {
      failed++; // 保守处理，该函数保持原样
      if (platform.env('DSH_VM_DEBUG')) console.error('[vm] 编译失败（降级）:', e && e.stack ? e.stack : e);
    }
  }
  return {
    compiled,
    considered: fns.length,
    failed,
    mode,
    // 指令集规模。每个编译函数的分发器要枚举 real+decoy 个分发字，干扰项通常不少于 1000
    ops: { real: opsReal, decoy: opsDecoy, total: opsReal + opsDecoy },
    forms: formCount,
    models: modelCount,
  };
};

// 默认导出是 vm 函数本身，isVMCompiled 另以具名导出与函数属性两种形态给出
vm.isVMCompiled = isVMCompiled;

export default vm;
export { isVMCompiled };
