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
 * 形态限制成内联形态 A/C。寄存器式虚拟机（vmRegisterVM）则把同一份 AST 编译到另一套
 * 指令集：操作数是显式寄存器号，运行期读写寄存器文件，没有隐式栈顶。
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

/**
 * 保留名单：用户点名要保留的标识符与字符串字面量（字面名）+ 手写
 * reservedNames / reservedStrings 正则。没有排除需求时返回 null，走原路径、
 * 零额外开销。
 *
 * 两类条目都要收：VM 的码元密文表（stringsEnc）装的是**函数体里的一切**——
 * 绑定名的字面形态、字符串字面量的值、属性名。只收标识符的话，被排除的字符串
 * 会随函数一起进密文表（high/max 档实测），和当初"排除名单在最强两档失效"
 * 是同一个病。
 */
function buildKeepNames(options) {
  const names = new Set();
  const strs = new Set();
  const res = [];
  const strRes = [];
  for (const n of options.excludedIdentifiers || []) {
    if (typeof n === 'string' && n) names.add(n);
  }
  // excludedStrings 在 stringArray 那边是**字面值**（逐个转义加锚点后匹配），
  // 与这里的 Set 精确比较等价；AST 上的 StringLiteral.value 已经是解码值。
  for (const n of options.excludedStrings || []) {
    if (typeof n === 'string' && n) strs.add(n);
  }
  for (const src of options.reservedNames || []) {
    try { res.push(new RegExp(src)); } catch (e) { /* 非法正则：mangle 那边同样忽略 */ }
  }
  for (const src of options.reservedStrings || []) {
    try { strRes.push(new RegExp(src)); } catch (e) { /* 非法正则：stringArray 那边同样忽略 */ }
  }
  if (!names.size && !strs.size && !res.length && !strRes.length) return null;
  return { names, strs, res, strRes };
}

/** 一个字符串值是否命中保留名单（excludedStrings 精确值 + reservedStrings 正则）。 */
function keepHitsString(keep, value) {
  if (typeof value !== 'string') return false;
  if (keep.strs.size && keep.strs.has(value)) return true;
  for (const re of keep.strRes) if (re.test(value)) return true;
  return false;
}

/** 模板串按 quasi 的 cooked 值判（与 stringArray 的取值口径一致）。 */
function templateHit(keep, node) {
  for (const q of node.quasis || []) {
    const v = q.value && q.value.cooked !== undefined && q.value.cooked !== null
      ? q.value.cooked
      : (q.value && q.value.raw);
    if (keepHitsString(keep, v)) return true;
  }
  return false;
}

/**
 * 子树里是否命中保留名单。命中就返回 true，可提前退出。
 *
 * 为什么要这个判断：VM 的字符串表是**码元密文表**（stringsEnc，见 litString/encString），
 * 标识符名与字符串字面量都作为字符串被加密进表、运行期由 MKS 指令解密。也就是说
 * **被编译的函数里任何字符串都不会以明文出现**，用户点名保留的名字（或字符串）
 * 进了这张表就必然字面消失。
 *
 * 之前把这个现象记成「已知边界」是回避问题：high/max 档下几乎每个函数都会被编译，
 * 于是排除名单在最强两档对函数内局部变量基本失效。现在改为命中就不编译这个函数。
 */
function subtreeHitsKeep(node, keep) {
  if (!node || typeof node !== 'object' || !keep) return false;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) if (subtreeHitsKeep(node[i], keep)) return true;
    return false;
  }
  if (typeof node.type !== 'string') return false;
  if (node.type === 'Identifier') {
    if (keep.names.size && keep.names.has(node.name)) return true;
    for (const re of keep.res) if (re.test(node.name)) return true;
    return false;
  }
  if (node.type === 'StringLiteral') return keepHitsString(keep, node.value);
  if (node.type === 'TemplateLiteral') return templateHit(keep, node);
  let hit = false;
  eachChild(node, (child) => { if (!hit && subtreeHitsKeep(child, keep)) hit = true; });
  return hit;
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
// 是 JS 引擎的能力，不需要把解释器改成状态机。但有一个**必须挡住**的前提：await 不能
// 出现在编译后会被搬进**非 async 闭包**的位置，否则产物是语法错误。会被搬进闭包的
// 位置有三类，判定与它们一一对应：
//   ① 片段表达式（isFragmentExpr 命中的那些）：统一写成 ()=>{ return expr; }，
//      这个箭头不是 async，里面不能有 await。
//   ② for-in / for-of 与解构声明：整体转 EXEC 片段 ()=>{ ... }，同样是非 async 箭头。
//   ③ 非 async 的嵌套函数：它自己的体不是 async，里面不可能有合法 await。
//      但**async 的嵌套函数**是安全的：它保持 async，await 是它自己的挂起语义。
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

function canCompile(fn, allowAsync, keep) {
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
  // 用户点名保留的标识符或字符串出现在函数体里，这个函数就**不编译**。含嵌套：
  // 外层编译会把内层一并带走，所以要连整个子树一起判。代价是这些函数少一层 VM
  // 保护，换来的是名字/字符串真的留在产物里——这正是这个选项存在的意义。
  if (subtreeHitsKeep(body, keep)) return false;
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
  // 寄存器后端的跳转指令。它们与栈机跳转同待遇：尾随一个链值字，操作数 a 记的是
  // 目标**指令下标**（宏融合重映射与链值求解都按这个约定走）。
  'R_JM', 'R_JF', 'R_JT', 'R_JAND', 'R_JOR', 'R_JNUL',
]);
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

// 寄存器后端的操作码表（Register-Based VM）。与栈机指令集完全独立：栈机的操作数是
// 「隐式栈顶 + 位置」，寄存器机的每个操作数都是显式寄存器号，所以指令名、操作数个数
// 都另起一套（统一 R_ 前缀，与栈机指令名不重叠）。
//
// 值取自字节码字流，顺序与发射顺序一致；跳转类**第一个**操作数是目标指令下标
// （翻成字下标落流），其后的操作数才是寄存器号。
//
// 指令清单（argc 只数寄存器操作数，跳转的目标字另加）：
//   R_LC dst,k      取常量池 K[k]            R_LD dst,s   取槽位 V[s]
//   R_GT dst,i      取外层名 G[i]()          R_FR dst,i   取常量池闭包 K[i]()
//   R_MK dst,si     还原字符串表第 si 项      R_EX i       执行 K[i]()（结果丢弃）
//   R_ST s,src      写槽位 V[s]=R[src]       R_SE i,src   写外层名 H[i](R[src])
//   R_MV dst,src    寄存器搬运
//   R_BI_<op> dst,a,b   二元运算            R_UN_<op> dst,a  一元运算（含 await）
//   R_GM dst,o,k    取成员 R[dst]=R[o][R[k]]  R_SM o,k,v   存成员 R[o][R[k]]=R[v]
//   R_C_<n> dst,f,a…     直接调用            R_CM_<n> dst,o,k,a…  成员调用
//   R_NW_<n> dst,f,a…    构造              R_AR_<n> dst,a…      数组字面量
//   R_RT src / R_TW src  返回 / 抛出
//   R_JM t               无条件跳转
//   R_JF t,a / R_JT t,a  按 R[a] 假/真跳转
//   R_JAND t,a / R_JOR t,a / R_JNUL t,a   逻辑短路（保留左值，与栈机 JANDK 系同义）
//   RMPK<n> w…            宏指令：n 个打包的装载（见下面的打包格式）
const REG_FIXED_ARGC = new Map(Object.entries({
  R_LC: 2, R_LD: 2, R_GT: 2, R_FR: 2, R_MK: 2, R_EX: 1,
  R_ST: 2, R_SE: 2, R_MV: 2, R_GM: 3, R_SM: 3,
  R_RT: 1, R_TW: 1, R_JM: 0, R_JF: 1, R_JT: 1, R_JAND: 1, R_JOR: 1, R_JNUL: 1,
}));
const REG_MACRO_RE = /^RMPK([234])$/;
const REG_CALL_RE = /^R_C_(\d+)$/;
const REG_CALLM_RE = /^R_CM_(\d+)$/;
const REG_NEW_RE = /^R_NW_(\d+)$/;
const REG_ARR_RE = /^R_AR_(\d+)$/;
const REG_BIN_RE = /^R_BI_/;
const REG_UN_RE = /^R_UN_/;
/** 寄存器指令的寄存器操作数个数；不是寄存器指令时返回 undefined。 */
function regArgc(op) {
  const f = REG_FIXED_ARGC.get(op);
  if (f !== undefined) return f;
  let m;
  if ((m = REG_MACRO_RE.exec(op))) return +m[1];
  if ((m = REG_CALL_RE.exec(op))) return +m[1] + 2;
  if ((m = REG_CALLM_RE.exec(op))) return +m[1] + 3;
  if ((m = REG_NEW_RE.exec(op))) return +m[1] + 2;
  if ((m = REG_ARR_RE.exec(op))) return +m[1] + 1;
  if (REG_BIN_RE.test(op)) return 3;
  if (REG_UN_RE.test(op)) return 2;
  return undefined;
}
// 可参与寄存器宏融合的装载指令与源位编码（打包字低两位）
const REG_MACRO_MEMBER_SRC = new Map([['R_LC', 0], ['R_LD', 1], ['R_GT', 2], ['R_FR', 3]]);
/**
 * 一条字节码条目占多少个字，以及是否尾随一个链值字。
 * args 是**操作数字数**（跳转类已含目标那一个字），chain 是链值字有无。
 */
function layoutOf(e) {
  const m = MACRO_KINDS.get(e.op);
  if (m !== undefined) return { args: m, chain: false };
  const isJump = JUMP_KINDS.has(e.op);
  const rc = regArgc(e.op);
  // 寄存器指令：rc 个寄存器操作数，跳转类再加目标那一个字
  if (rc !== undefined) return { args: rc + (isJump ? 1 : 0), chain: isJump };
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

  // 寄存器式虚拟机（vmRegisterVM）。开启后本函数换一套代码生成后端：不再发栈机指令，
  // 改发寄存器机指令（见文件上方 REG_FIXED_ARGC 那一段的指令清单）。下面所有
  // 「栈机专有」的机制在本函数里自然失效，逐项说明：
  //   · 操作数栈 S：寄存器后端一次都不 push/pop（S 仍然声明着，因为干扰项处理器会读
  //     它的长度——那是形态伪装，不是语义）；
  //   · 栈编码（vmStackEncoding）：没有栈可编码，这里直接关掉，连编解码函数都不生成；
  //   · 多态寄存器模型（vmPolymorph）：寄存器后端本身就是一种执行结构，模型固定为 M3；
  //   · WASM 解释器内核（vmInterpreter=wasmInterpreter）：模块内的解释器按栈机硬编码，
  //     该档下本项不生效（与其它「模块内解释器」受限项同一处理方式）；
  //   · 宏指令融合（vmMacroOps）：仍然生效，只是打包格式换成寄存器版（带目标寄存器号）。
  // 注意这一段**不占任何随机名字**（uniqueName 会推进名字流），关闭时产物与改动前
  // 逐字节一致；开启时才分配寄存器文件等名字。
  const registerVM = !!opts.vmRegisterVM && !ctx.__vmWasmShared;

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

  // 栈编码（vmStackEncoding）。操作数栈上装的是任意 JS 值，XOR 只对数字成立，所以
  // 编码函数必须对非数字透明：SE(v) 在 v 是 32 位整数且非 -0 时返回 v ^ K，否则原样
  // 返回。SE 是幂等的（SE∘SE = id），所以编码与解码共用同一个函数。
  // 栈上存的永远是 SE(值)：压栈时编码、出栈时解码；DUP 原样复制已编码值（不能再编一次）、
  // 条件跳转与 GETMK 取键要解码、M2 的地址栈迁移原样搬运（两张栈同一密钥，值可以直传）。
  // WASM 内核档的栈在模块里，该档自动关闭本项；寄存器后端没有操作数栈，本项同样关闭。
  const stackEnc = !registerVM && !!opts.vmStackEncoding && !ctx.__vmWasmShared;
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
  // 于是**同一个分发字在不同位置指向不同动作**：静态 dump 出解密后的字节码，看到的
  // 只是一串与位置耦合的编号，要把分发字与语义对齐，必须先把每条指令的字下标与轮换
  // 公式算清楚（而公式里的两个常数逐函数随机），不能再拿一张「字 → 语义」表直接读。
  // 与逐调用轮换的关系：掩码与链值在每次调用入口整体重写 B，那层管"字长什么样"；
  // 本项管"字还原成哪个编号"，两者叠在同一条取指路径上，互不依赖。
  // 为什么用位置而不是段/寄存器状态：动作体按**操作码种类**生成，一个种类的体要给
  // 该种类全部指令共用，承载不了"按指令"的字面量；而取指游标是每条指令天然自带、
  // 且在任何进入路径（顺序、跳转、回边）上都唯一确定的状态，所以位置轮换不需要额外
  // 指令、不需要入口初始化，也不会在"某处既是跳转目标又是顺序后继"的边界上失配。
  // 代价：取指后多一次 imul、异或与掩码；字空间必须是 2 的幂（还原用 &(N-1)），
  // 开启时把槽位数上取整、多出的槽位并进干扰项。WASM 内核档的分发在模块里，忽略本项。
  const dynOps = !!opts.vmDynOpcodes && !ctx.__vmWasmShared;
  // 位置轮换的两个常数。这里**必须用 randInt 而不是 krand**：krand 是与编译期密钥
  // 绑定的确定性流，而运行期要让"密钥取回"重跑一遍派生（rtKeyStmts 里的那张清单）
  // 才能对上构建期的掩码、链种子与分发常数。那份清单按固定顺序列举派生项，中途插进
  // 两个新的 krand 抽取会让清单与构建期错位——构建期派生的掩码与运行期重跑出来的
  // 掩码不一致，密钥正确也会解成垃圾（实测表现是产物静默算出 undefined 而不报错）。
  // 这两个常数只在解释器里当字面量用、运行期不参与派生，所以走种子流即可：同种子
  // 依旧可复现，产物仍随编译期密钥变化（其余派生项仍在密钥流上）。
  const DYN_P = dynOps ? (randInt(0x10001, 0x7ffffffe) | 1) : 0;
  const DYN_Q = dynOps ? randInt(0x1000, 0x7ffffff) : 0;

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
  //   M3 寄存器机   —— 寄存器后端（vmRegisterVM）：指令操作数是显式寄存器号
  // WASM 解释器内核档对栈模型有硬编码假设，该档强制 M0；vmModel 可显式锁定
  // （自测用：M0/M1/M2 三档语义必须等价）。M3 由 vmRegisterVM 直接决定，不参与抽取。
  let vmModel = 'M0';
  if (registerVM) {
    vmModel = 'M3';
  } else if (!ctx.__vmWasmShared) {
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
  // 寄存器后端的寄存器文件。只在寄存器后端分配名字（uniqueName 推进随机名字流，
  // 白占名会让关闭时的产物与改动前不再逐字节一致）。
  const RID = registerVM ? t.identifier(uniqueName(ctx.usedNames, '_0x')) : null;

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
        if (canCompile(node, allowAsync, ctx.__vmKeepNames) && countRegionStmts(node.body) >= threshold) {
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

  // ------------------------------------------------------------------
  // 寄存器后端代码生成（Register-Based VM）
  // ------------------------------------------------------------------
  // 与栈机发射器并存，但同一函数只会走其中一条。栈机把「表达式的结果」隐式留在操作数
  // 栈顶；寄存器机把结果写进一个**显式寄存器号**，所以每个表达式求值函数都要返回
  // 「结果在哪个寄存器」。分配策略是 LIFO 复用：求值完立刻把临时寄存器还回池子，
  // 于是寄存器号很小、复用率高；但编号是显式的且语句之间**不复位**，所以同一个值
  // 在它的整个生命周期里一直挂在同一个号上——这正是「寄存器机数据流」与「栈机位置流」
  // 的分野。跳转分支要汇合时，把结果钉在左值/测试值那个寄存器上（两个分支都写它），
  // 于是汇合点上寄存器号是稳定的，不需要 phi 之类的额外机制。
  let regNext = 0;        // 已分配过的最大寄存器号 + 1（高水位）
  const regPool = [];     // 空闲寄存器栈（LIFO）
  const allocReg = () => {
    if (regPool.length) return regPool.pop();
    const r = regNext++;
    return r;
  };
  const freeReg = (r) => { if (r >= 0) regPool.push(r); };
  /** 发一条寄存器指令。args 是操作数（寄存器号或字面量），target 只对跳转类有意义。 */
  const rEmit = (op, args, target) => {
    usedOps.add(op);
    code.push({ op, args: args || [], a: target === undefined ? -1 : target });
    return code.length - 1;
  };
  /** 补跳转目标：记的是**指令下标**，与栈机的 JMP 系同一约定（pos[e.a] 取字下标）。 */
  const rPatch = (j) => { code[j].a = code.length; };
  const rKey = (name) => { const d = allocReg(); rEmit('R_MK', [d, litString(name)]); return d; };
  const rLoadIdent = (name) => {
    const d = allocReg();
    const s = slotOf.get(name);
    if (s !== undefined) rEmit('R_LD', [d, s]);
    else rEmit('R_GT', [d, getThunkIdx(name)]);
    return d;
  };
  const rStoreIdent = (name, r) => {
    const s = slotOf.get(name);
    if (s !== undefined) rEmit('R_ST', [s, r]);
    else rEmit('R_SE', [getSetIdx(name), r]);
  };
  /** 成员访问（读）的三元组公共部分：对象、键两个寄存器。 */
  const rMemberTarget = (node) => [emitExprR(node.object),
    node.computed ? emitExprR(node.property) : rKey(node.property.name)];

  function emitUpdateR(node) {
    const name = node.argument.name;
    const binOp = node.operator === '++' ? '+' : '-';
    const r0 = rLoadIdent(name);
    const one = allocReg();
    rEmit('R_LC', [one, litConst(t.numericLiteral(1))]);
    const r1 = allocReg();
    rEmit('R_BI_' + binOp, [r1, r0, one]);
    freeReg(one);
    rStoreIdent(name, r1);
    // 后缀取旧值（r0）、前缀取新值（r1）；另一个寄存器随之释放
    if (node.prefix) { freeReg(r0); return r1; }
    freeReg(r1);
    return r0;
  }

  function emitAssignmentR(node) {
    const { operator, left, right } = node;
    if (left.type === 'Identifier') {
      const name = left.name;
      if (operator === '=') {
        const r = emitExprR(right);
        rStoreIdent(name, r);
        return r; // 值仍在该寄存器里，不需要像栈机那样 DUP
      }
      if (operator === '&&=' || operator === '||=' || operator === '??=') {
        const op = operator === '&&=' ? 'R_JAND' : operator === '||=' ? 'R_JOR' : 'R_JNUL';
        const r0 = rLoadIdent(name);
        const j = rEmit(op, [r0], -1); // 短路分支：保留左值、跳过写回
        const r1 = emitExprR(right);
        rEmit('R_MV', [r0, r1]);
        freeReg(r1);
        rStoreIdent(name, r0);
        rPatch(j);
        return r0;
      }
      // 复合算术与位运算 x OP= v。dst 复用 r0（运算先读后写，语义安全）
      const r0 = rLoadIdent(name);
      const r1 = emitExprR(right);
      rEmit('R_BI_' + operator.slice(0, -1), [r0, r0, r1]);
      freeReg(r1);
      rStoreIdent(name, r0);
      return r0;
    }
    // 成员目标：对象、键先算，再算右值（与源码求值顺序一致）
    const [ro, rk] = rMemberTarget(left);
    if (operator === '=') {
      const rv = emitExprR(right);
      rEmit('R_SM', [ro, rk, rv]);
      freeReg(ro); freeReg(rk);
      return rv; // 赋值表达式的值就是右值
    }
    const rv = allocReg();
    rEmit('R_GM', [rv, ro, rk]); // rv 先装旧值
    if (operator === '&&=' || operator === '||=' || operator === '??=') {
      const op = operator === '&&=' ? 'R_JAND' : operator === '||=' ? 'R_JOR' : 'R_JNUL';
      const j = rEmit(op, [rv], -1); // 短路：不写成员，结果就是旧值
      const r1 = emitExprR(right);
      rEmit('R_SM', [ro, rk, r1]);
      rEmit('R_MV', [rv, r1]);
      freeReg(r1);
      rPatch(j);
      freeReg(ro); freeReg(rk);
      return rv;
    }
    const r1 = emitExprR(right);
    rEmit('R_BI_' + operator.slice(0, -1), [rv, rv, r1]);
    freeReg(r1);
    rEmit('R_SM', [ro, rk, rv]);
    freeReg(ro); freeReg(rk);
    return rv;
  }

  function emitExprR(node) {
    if (!node) { const d = allocReg(); rEmit('R_LC', [d, UNDEF]); return d; }
    if (isFragmentExpr(node)) {
      compileInnerFns(node);
      rewriteFragStrings(node);
      const d = allocReg();
      rEmit('R_FR', [d, pushThunk(wrapFrag(node))]);
      return d;
    }
    switch (node.type) {
      case 'Identifier': return rLoadIdent(node.name);
      case 'ThisExpression': {
        const d = allocReg();
        rEmit('R_GT', [d, getThunkIdx('this')]);
        return d;
      }
      case 'NumericLiteral':
      case 'BooleanLiteral':
      case 'NullLiteral': {
        const d = allocReg();
        rEmit('R_LC', [d, litConst(node)]);
        return d;
      }
      case 'StringLiteral': {
        const d = allocReg();
        rEmit('R_MK', [d, litString(node.value)]);
        return d;
      }
      case 'UnaryExpression': {
        const a = emitExprR(node.argument);
        const d = allocReg();
        // await 也走这条通道：运算符名就是 'await'，动作体生成 `R[d] = await R[a]`
        rEmit('R_UN_' + node.operator, [d, a]);
        freeReg(a);
        return d;
      }
      case 'UpdateExpression': return emitUpdateR(node);
      case 'BinaryExpression': {
        const a = emitExprR(node.left);
        const b = emitExprR(node.right);
        const d = allocReg();
        rEmit('R_BI_' + node.operator, [d, a, b]);
        freeReg(a); freeReg(b);
        return d;
      }
      case 'LogicalExpression': {
        // 结果钉在左值寄存器 a 上：短路分支直接跳（R[a] 就是左值），不短路分支把右值
        // 搬进 a。两个分支汇合后 R[a] 都是最终值，与栈机 JANDK 系的「保留左值」同义。
        const a = emitExprR(node.left);
        const op = node.operator === '&&' ? 'R_JAND' : node.operator === '||' ? 'R_JOR' : 'R_JNUL';
        const j = rEmit(op, [a], -1);
        const b = emitExprR(node.right);
        rEmit('R_MV', [a, b]);
        freeReg(b);
        rPatch(j);
        return a;
      }
      case 'ConditionalExpression': {
        const a = emitExprR(node.test);
        const jf = rEmit('R_JF', [a], -1);
        const c = emitExprR(node.consequent);
        rEmit('R_MV', [a, c]);
        freeReg(c);
        const jm = rEmit('R_JM', [], -1);
        rPatch(jf);
        const e2 = emitExprR(node.alternate);
        rEmit('R_MV', [a, e2]);
        freeReg(e2);
        rPatch(jm);
        return a;
      }
      case 'SequenceExpression': {
        const last = node.expressions.length - 1;
        for (let i = 0; i < last; i++) freeReg(emitExprR(node.expressions[i]));
        return emitExprR(node.expressions[last]);
      }
      case 'AssignmentExpression': return emitAssignmentR(node);
      case 'MemberExpression': {
        const [ro, rk] = rMemberTarget(node);
        const d = allocReg();
        rEmit('R_GM', [d, ro, rk]);
        freeReg(ro); freeReg(rk);
        return d;
      }
      case 'CallExpression': {
        const callee = node.callee;
        let f, o = -1, k = -1;
        if (callee.type === 'MemberExpression') {
          [o, k] = rMemberTarget(callee);
        } else {
          f = emitExprR(callee);
        }
        const args = node.arguments.map(emitExprR);
        const d = allocReg();
        if (callee.type === 'MemberExpression') rEmit('R_CM_' + args.length, [d, o, k, ...args]);
        else rEmit('R_C_' + args.length, [d, f, ...args]);
        if (o >= 0) { freeReg(o); freeReg(k); } else freeReg(f);
        for (const r of args) freeReg(r);
        return d;
      }
      case 'NewExpression': {
        const f = emitExprR(node.callee);
        const args = node.arguments.map(emitExprR);
        const d = allocReg();
        rEmit('R_NW_' + args.length, [d, f, ...args]);
        freeReg(f);
        for (const r of args) freeReg(r);
        return d;
      }
      case 'ArrayExpression': {
        const els = node.elements.map((el) => (el ? emitExprR(el) : (() => {
          // 数组洞按 undefined 处理，与栈机一致
          const d = allocReg();
          rEmit('R_LC', [d, UNDEF]);
          return d;
        })()));
        const d = allocReg();
        rEmit('R_AR_' + els.length, [d, ...els]);
        for (const r of els) freeReg(r);
        return d;
      }
      default:
        // 片段判定之外的未知表达式，兜底走片段以保住语义
        compileInnerFns(node);
        rewriteFragStrings(node);
        {
          const d = allocReg();
          rEmit('R_FR', [d, pushThunk(wrapFrag(node))]);
          return d;
        }
    }
  }

  function emitVarDeclR(node) {
    for (const d of node.declarations) {
      if (d.id.type === 'Identifier') {
        if (!d.init) continue;
        const r = emitExprR(d.init);
        rStoreIdent(d.id.name, r);
        freeReg(r);
      } else {
        // 解构声明转 EXEC 片段，与栈机同源
        if (!d.init) continue;
        compileInnerFns(d.init);
        rewriteFragStrings(d.id);
        rewriteFragStrings(d.init);
        const thunk = t.arrowFunctionExpression([], t.blockStatement([
          t.expressionStatement(t.assignmentExpression('=', d.id, d.init)),
        ]));
        rEmit('R_EX', [pushThunk(thunk)]);
      }
    }
  }

  function emitStmtR(s) {
    if (!s) return;
    switch (s.type) {
      case 'ExpressionStatement': freeReg(emitExprR(s.expression)); return;
      case 'VariableDeclaration': emitVarDeclR(s); return;
      case 'ReturnStatement':
        if (s.argument) rEmit('R_RT', [emitExprR(s.argument)]);
        else rEmit('RETU'); // 无值返回与栈机共用动作体（都只是 return）
        return;
      case 'ThrowStatement': rEmit('R_TW', [emitExprR(s.argument)]); return;
      case 'IfStatement': {
        const a = emitExprR(s.test);
        const jf = rEmit('R_JF', [a], -1);
        freeReg(a);
        emitStmtR(s.consequent);
        const jm = rEmit('R_JM', [], -1);
        rPatch(jf);
        emitStmtR(s.alternate);
        rPatch(jm);
        return;
      }
      case 'WhileStatement': {
        const top = code.length;
        const a = emitExprR(s.test);
        const jf = rEmit('R_JF', [a], -1);
        freeReg(a);
        const loop = pushLoop();
        emitStmtR(s.body);
        loop.contAt = top;
        const jb = rEmit('R_JM', []);
        code[jb].a = top;
        loop.brkAt = code.length;
        popLoop();
        rPatch(jf);
        return;
      }
      case 'DoWhileStatement': {
        const top = code.length;
        const loop = pushLoop();
        emitStmtR(s.body);
        loop.contAt = code.length; // continue 回到测试条件
        const a = emitExprR(s.test);
        rEmit('R_JT', [a], top);
        freeReg(a);
        loop.brkAt = code.length;
        popLoop();
        return;
      }
      case 'ForStatement': {
        if (s.init) {
          if (s.init.type === 'VariableDeclaration') emitVarDeclR(s.init);
          else freeReg(emitExprR(s.init));
        }
        const top = code.length;
        let jTest = -1;
        if (s.test) {
          const a = emitExprR(s.test);
          jTest = rEmit('R_JF', [a], -1);
          freeReg(a);
        }
        const loop = pushLoop();
        emitStmtR(s.body);
        const contAt = code.length;
        if (s.update) freeReg(emitExprR(s.update));
        const j = rEmit('R_JM', []);
        code[j].a = top;
        loop.contAt = contAt;
        loop.brkAt = code.length;
        popLoop();
        if (jTest >= 0) rPatch(jTest);
        return;
      }
      case 'BlockStatement': for (const st of s.body) emitStmtR(st); return;
      case 'BreakStatement': {
        const l = loopStack[loopStack.length - 1];
        if (!l) throw new Error(msg('vmBreakOutsideLoop'));
        l.brkFix.push(rEmit('R_JM', []));
        return;
      }
      case 'ContinueStatement': {
        const l = loopStack[loopStack.length - 1];
        if (!l) throw new Error(msg('vmContinueOutsideLoop'));
        l.contFix.push(rEmit('R_JM', []));
        return;
      }
      case 'FunctionDeclaration': {
        compileInnerFns(s);
        const fe = toFunctionExpression(s);
        rewriteFragStrings(fe);
        const d = allocReg();
        rEmit('R_FR', [d, pushThunk(wrapFrag(fe))]);
        rStoreIdent(s.id.name, d);
        freeReg(d);
        return;
      }
      case 'ForInStatement':
      case 'ForOfStatement': {
        const L = s.left;
        if (L.type === 'VariableDeclaration') s.left = L.declarations[0].id;
        stripVars(s.body);
        compileInnerFns(s.right);
        compileInnerFns(s.body);
        rewriteFragStrings(s.right);
        rewriteFragStrings(s.body);
        const thunk = t.arrowFunctionExpression([], t.blockStatement([s]));
        rEmit('R_EX', [pushThunk(thunk)]);
        return;
      }
      case 'EmptyStatement':
      case 'DebuggerStatement': return;
      default:
        throw new Error(msg('vmUnsupportedStatement', { type: s.type }));
    }
  }

  // 发射顺序：先提升序言函数声明，再发其余语句，最后 END。
  // 两种后端的收尾指令都让解释器直接 return（栈机 END、寄存器 RETU 缺省落到 END）。
  const origStmts = fn.body.body;
  const origDirectives = fn.body.directives;
  if (registerVM) {
    for (const s of origStmts) {
      if (s.type === 'FunctionDeclaration') emitStmtR(s);
    }
    for (const s of origStmts) {
      if (s.type !== 'FunctionDeclaration') emitStmtR(s);
    }
    rEmit('RETU');
  } else {
    for (const s of origStmts) {
      if (s.type === 'FunctionDeclaration') emitStmt(s);
    }
    for (const s of origStmts) {
      if (s.type !== 'FunctionDeclaration') emitStmt(s);
    }
    emit('END');
  }

  // 宏指令融合（vmMacroOps）。在整条指令流发完之后做，因为「跳转目标落在哪」要
  // 等所有跳转回填完才知道：跳转靠**指令下标**定位（pos[e.a]、targetChainOf 用
  // opZ.get(code[o.instr].a)），被合并掉的指令如果还是某个跳转的目标，定位就断了。
  // 所以规则是：只把连续的操作数装载指令并成一条宏指令，n 取 2..4；
  // 目标指令本身绝不并入前一条——它是段的起点，段可以从它开始，但不能跨过它。
  // 两种后端的打包格式不同（见下面 memberPack），但「取段 → 重映射 → 重建指令集」
  // 这套骨架完全共用，避免两套实现日后漂移。
  let macroFused = 0;  // 本函数生成的宏指令条数（统计用）
  let macroSaved = 0;  // 因融合而减少的指令条数（统计用）
  if (macroOps) {
    // 可融合的成员与打包函数。
    //   栈后端：LDC / LOD / GET / FRAG，操作数只有「下标」，打包字 = (下标 << 2) | 源位；
    //     段长 2..4 时字流长度正好 1 + n，与 opWordWidth 一致。
    //   寄存器后端：同样的四条装载指令，但每条还带一个**目标寄存器号**，所以打包字要多
    //     一个字段：(下标 << 10) | (目标寄存器 << 2) | 源位。字段宽度取 8 位（寄存器号
    //     0..255）、22 位（下标 0..2^21-1），留出的高位保证打包字恒为非负 int32，
    //     运行期用 >> 才不会做符号扩展。放不下时这段不融合（见 memberPack 返回 null）。
    const regFuse = registerVM;
    const memberSet = regFuse ? REG_MACRO_MEMBER_SRC : MACRO_SRC_CODE;
    const memberOk = (e) => memberSet.has(e.op);
    const memberPack = (e) => {
      if (!regFuse) return (e.a << 2) | memberSet.get(e.op);
      const idx = e.args[1], dst = e.args[0];
      if (idx > 0x1fffff || dst > 0xff) return null;
      return (idx << 10) | (dst << 2) | memberSet.get(e.op);
    };
    const macroName = (n) => (regFuse ? 'RMPK' + n : 'MPK' + n);
    const targets = new Set();
    for (const e of code) if (JUMP_KINDS.has(e.op)) targets.add(e.a);
    const fused = [];
    // 指令下标重映射表。跳转目标记的是**指令下标**（pos[e.a] 与 targetChainOf 的
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
        // 打包字段放不下的成员（只可能出现在寄存器后端）就地落单，段就此断开。
        let n = 0;
        while (n < 4 && at + n <= j && memberPack(code[at + n]) !== null) n++;
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
  // 改成链值之后，轮换量随**前面那个字的实际明文**变化：改一个字节码字，后面所有
  // opcode 的解读都会跟着变。
  //
  // ---- 另一条路：为什么不由运行期掩码 MASK 驱动 ----
  //
  // 记在这里免得重复推导。rotStmts 每次调用入口会把整条 B 数组重新 XOR 一遍
  // （B[z] ^= MASK ^ nm），所以**解码出的明文是不变量**。轮换量若依赖 MASK，第二
  // 次调用解出的规范编号就与构建期不同 → 字节码解成垃圾。要修就得在每次入口把
  // opcode 字按新轮换量重写一遍，而「哪些字是 opcode 字」必须显式给出来——那就是
  // 操作码位置表（已评估否决：解密后在内存里就是一张明文索引表）。所以「随运行
  // 状态演化」只能走链值这条，它不需要额外给出任何位置信息。
  //
  // ---- 代价：opcode 字从「具体值」变成「计算值」----
  //
  // 位置驱动时 opcode 字直接算好落库；链值驱动时它依赖 words[z-1]，而那一字可能
  // 本身是链值字或另一个 opcode 字，所以本字也得等求解器迭代。于是三处要改：
  //   · null 这个占位符现在**同时**表示链值字与 opcode 字，得靠 opWordZ 区分；
  //   · 不动点循环必须**每轮重算** opcode 字——只算 null 的话第一轮填进去之后它们
  //     就成了"具体值"不再重算，而链值字一变，下游 opcode 全部陈旧；
  //   · 环上更要紧：链值字按定义就是跳转指令的最后一个字，紧接着就是下一条指令的
  //     opcode 字，所以链值每次变化都**级联**到下一个轮换量。
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
    } else if (regArgc(e.op) !== undefined) {
      // 寄存器指令：操作数逐个落流。跳转类的第一个操作数是目标指令下标，翻成字下标
      // （开了跳转编码就落相对差值），寄存器操作数跟在后面，最后是链值字。
      if (isJump) {
        words.push(jumpEnc ? pos[e.a] - pos[i] : pos[e.a]);
        for (const v of e.args) words.push(v);
        words.push(null);
      } else {
        for (const v of e.args) words.push(v);
      }
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
  // **填充必须与 opCanon 同开同关**：一旦非空，不动点循环就把这些字当「计算值」
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
  // 与链值字一样是**算出来的**。所以判断顺序上 opcode 字必须**先**认——第一轮迭代
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
      // 判据是「opcode 字 **或** 待求值」，不是只判 null。opcode 字必须每轮重算：
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
  // 而且**不报错**，属于那种能出包、能跑、结果错的坏产物。宁可构建失败。
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
  if (ctx.__vmWasmShared) {
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
  // topElem 是**原样**栈顶（已编码值），供 DUP 直接复制；topVal 是解码后的真值，
  // 供条件跳转判值、GETMK 取键这类"要用真值"的地方。
  const topElem = () => t.memberExpression(S,
    t.binaryExpression('-', Slen(), t.numericLiteral(1)), true);
  const topVal = () => seCall(topElem());
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
  // 宏指令的操作数暂存名。每个打包字取指一次、解码两次（选源位与下标位），
  // 所以要绑到临时名上；上限 4 与 MACRO_KINDS 的最长段长一致。
  // 关闭本项时**不占名**：uniqueName 会推进随机名字流，白占四个名会让同种子下的
  // 其余名字整体错位，产物与改造前不再逐字节一致。寄存器后端不用这套名（它的成员
  // 装载要落到寄存器号上，只用下面 regMacroNames 那一组）。
  const macroArgNames = (macroOps && !registerVM)
    ? Array.from({ length: 4 }, () => uniqueName(ctx.usedNames, '_0x'))
    : [];
  // 寄存器宏（RMPKn）每个成员一个暂存名：打包字取指一次后要连着解出「源位、目标
  // 寄存器号、下标」三个字段。同样只在「融合开 + 寄存器后端」时占名。
  const regMacroNames = (macroOps && registerVM)
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

  // 寄存器窗口，形成栈与寄存器混合的数据流。
  // 一组轮转伪寄存器，每个 case 内的 push/pop 值先落到寄存器再进出栈，静态数据流
  // 因此必须同时追踪寄存器组与栈两层。轮转槽位由构建期逐 case 随机起点决定，
  // 跨 case 的寄存器占用图不规则。
  // 寄存器组大小（M0 纯栈式与 M3 寄存器机都用 0：M0 没有寄存器变量，M3 的寄存器
  // 是它自己的显式寄存器文件，不用这里的「环形窗口」）
  const REGN = (ctx.vmModel === 'M0' || ctx.vmModel === 'M3')
    ? 0 : (ctx.vmModel === 'M1' ? 5 : randInt(3, 5));
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
  // 栈编解码。SE 幂等，编解码共用；只在压栈/出栈点各调用一次，
  // 绝不把 S.pop() 这类有副作用的表达式内联展开（展开三次就会弹三次）。
  const seCall = (x) => (stackEnc ? t.callExpression(t.identifier(nSE), [x]) : x);
  const SPUSH = (x) => t.callExpression(
    t.memberExpression(S, t.identifier('push'), false), [seCall(x)]);
  const SPUSHRAW = (x) => t.callExpression(
    t.memberExpression(S, t.identifier('push'), false), [x]); // 复制已编码值，不能再编一次
  const SPOPRAW = () => t.callExpression(t.memberExpression(S, t.identifier('pop'), false), []);
  const SPOP = () => seCall(SPOPRAW());

  // 压栈经寄存器：R = 值; push(R)。M0 纯栈式模型下没有寄存器，直接落栈。
  // （P4 多态寄存器模型：M0 纯栈 / M1 寄存器优先 / M2 双栈分立，见 ctx.vmModel）
  const pushR = (val) => {
    if (REGN === 0) return [t.expressionStatement(SPUSH(val))];
    const r = nextReg();
    return [
      t.expressionStatement(t.assignmentExpression('=', idn(r), val)),
      t.expressionStatement(SPUSH(idn(r))),
    ];
  };
  // 出栈经寄存器：R = pop()，表达式值就是 R 的引用。M0 下直接 pop。
  const popR = () => {
    if (REGN === 0) return SPOP();
    const r = nextReg();
    return t.sequenceExpression([
      t.assignmentExpression('=', idn(r), SPOP()),
      idn(r),
    ]);
  };
  // 不经寄存器的原语。部分 case 直连栈，两种形态混用让数据流更不规则
  const pushCall = (x) => t.expressionStatement(SPUSH(x));
  const popCall = () => SPOP();

  // P4 模型 M2：地址栈。成员访问类指令（GETM/SETM/CALLM）的目标对象与键不改从
  // 操作数栈出，而从第二张栈 SA 出。静态上「一个栈」的模型不再成立：同一条指令
  // 序列里出现两套 push/pop，且哪套用在哪种指令上不按位置规律。
  // M0/M1 下 SA 为 null，指令实现与改造前逐字节一致。
  const SA = vmModel === 'M2' ? t.identifier(uniqueName(ctx.usedNames, '_0x')) : null;
  const pushA = (x) => t.expressionStatement(t.callExpression(
    t.memberExpression(SA, t.identifier('push'), false), [x]));
  // 地址栈与操作数栈同一密钥，值可以直传：入栈原样（不动），出栈才解码。
  // 因此 STA 必须用 SPOPRAW 搬运，不能走 popCall（那会先解码，再被 popA 解第二次）。
  const popA = () => seCall(t.callExpression(t.memberExpression(SA, t.identifier('pop'), false), []));
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

  /**
   * 字符串表还原：把第 siNode 项的码元密文表解回 string。
   * 返回语句序列；还原结果留在变量 nSO 里，调用方自己决定是压栈（栈机）还是落寄存器
   * （寄存器后端）。两种后端共用同一实现，避免还原公式漂移。
   */
  const mksDecode = (siNode) => [
    declConst(nSX, siNode),
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
  ];

  function caseBody(kind) {
    // 寄存器后端（vmRegisterVM）的指令走自己的动作体生成器。寄存器指令与栈机指令在
    // 同一个分发器里只会出现一套（一个函数只会由一个后端发射），这里按指令名分派即可。
    if (regArgc(kind) !== undefined) return regCaseBody(kind);
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
    if (kind === 'MKS') return [...mksDecode(bAt()), ...pushR(idn(nSO))];
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
        seCall(t.memberExpression(S, t.binaryExpression('-', Slen(), t.numericLiteral(2)), true)),
        topVal(), true))];
    }
    if (kind === 'DUP') return [t.expressionStatement(SPUSHRAW(topElem()))];
    if (kind === 'POP') return [t.expressionStatement(popCall())];
    // P4 模型 M2：把操作数栈顶搬到地址栈。只在 M2 的成员目标处出现。
    if (kind === 'STA') return [pushA(SPOPRAW())]; // 原样搬运，见 pushA/popA 的约定
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
    // 宏指令 MPKn：把 n 条被合并的装载指令的动作体按原顺序展开。
    // 每个操作数是一个打包字：低两位选源（见 macroSrc 表），高位是下标。
    // 取指与 LDC / LOD / GET / FRAG 走同一条 bAt()，所以链式解密、掩码轮换、位置分量
    // 全部沿用，字流长度也正好是 1 + n。压栈沿用 pushR，寄存器窗口与栈编码的行为不变。
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
            t.binaryExpression('===',
              t.binaryExpression('&', idn(w), t.numericLiteral(3)),
              t.numericLiteral(s)),
            src[s], val);
        }
        out.push(...pushR(val));
      }
      return out;
    }
    throw new Error(msg('vmUnknownOpcode', { kind }));
  }

  /**
   * 寄存器后端的动作体生成（Register-Based VM，指令清单见文件上方 REG_FIXED_ARGC）。
   *
   * 与栈机动作体的根本差别：**没有操作数栈**。每个操作数是一个显式寄存器号，取值写值
   * 都直接作用在寄存器文件 R 上，所以「表达式树怎么配对」这件事在静态面上不存在了——
   * 要看懂一条指令得先知道每个寄存器号在那一刻装的是哪个表达式的中间结果。
   *
   * 两条实现约定：
   *   ① 每个寄存器号操作数都先绑到一个 const 临时名上再用。bAt() 有副作用（推进取指
   *      游标、推进链状态），在一个表达式里写两次就会多取一个字、把整条流读错位。
   *   ② 操作数按**发射顺序**取，与 words.push 的落流顺序一一对应：跳转类的第一个字是
   *      目标指令下标（跳转编码开启时是相对差值，用 jumpTarget 还原），后面才是寄存器号，
   *      最后是链值字（跳转类必须取走它，链状态才自洽）。
   */
  function regCaseBody(kind) {
    const R = RID;
    // 寄存器文件的读写位置既可能是编译期已知的寄存器号（临时名），也可能是运行期算出来的
    // （寄存器宏的打包字里解出的目标号），所以下标允许直接给节点——统一在这里区分。
    // 传给 idn() 的只能是名字字符串，传节点会造出无 name 的 Identifier（生成期直接报错）。
    const rAt = (n) => t.memberExpression(R, typeof n === 'string' ? idn(n) : n, true);
    const setR = (d, e) => t.expressionStatement(t.assignmentExpression('=', rAt(d), e));
    const declJmpA = () => t.variableDeclaration('var', [
      t.variableDeclarator(idn(N_A)), t.variableDeclarator(idn(N_C))]);
    // 跳转类的字跨度：op + 目标 + 寄存器操作数 + 链值字。跳转编码用它把取指游标
    // 退回本条指令的字下标（游标此时已越过本条全部字）。
    const span = regArgc(kind) + 3;

    // 四条装载指令：dst, idx → R[dst] = 对应源的下标 idx 项
    if (kind === 'R_LC' || kind === 'R_LD' || kind === 'R_GT' || kind === 'R_FR') {
      const pick = (i) => (kind === 'R_LC' ? t.memberExpression(K, i, true)
        : kind === 'R_LD' ? t.memberExpression(V, i, true)
          : kind === 'R_GT' ? t.callExpression(t.memberExpression(G, i, true), [])
            : t.callExpression(t.memberExpression(K, i, true), []));
      return [declConst(N_A, bAt()), declConst(N_B, bAt()), setR(N_A, pick(idn(N_B)))];
    }
    // 字符串还原：dst, 项序号
    if (kind === 'R_MK') {
      return [declConst(N_A, bAt()), ...mksDecode(bAt()), setR(N_A, idn(nSO))];
    }
    // EXEC 片段：结果丢弃，没有寄存器操作数
    if (kind === 'R_EX') {
      return [t.expressionStatement(t.callExpression(t.memberExpression(K, bAt(), true), []))];
    }
    // 写槽位（V[s] = R[src]）与写外层名（H[i](R[src])）
    if (kind === 'R_ST') {
      return [declConst(N_A, bAt()), declConst(N_B, bAt()),
        t.expressionStatement(t.assignmentExpression('=',
          t.memberExpression(V, idn(N_A), true), rAt(N_B)))];
    }
    if (kind === 'R_SE') {
      return [declConst(N_A, bAt()), declConst(N_B, bAt()),
        t.expressionStatement(t.callExpression(
          t.memberExpression(H, idn(N_A), true), [rAt(N_B)]))];
    }
    // 寄存器搬运：R[dst] = R[src]。逻辑短路与条件表达式用它把两个分支的结果归位
    if (kind === 'R_MV') {
      return [declConst(N_A, bAt()), declConst(N_B, bAt()), setR(N_A, rAt(N_B))];
    }
    // 二元 / 一元（含 await：一元运算符名就是 'await'，生成 `R[d] = await R[a]`，
    // 因为它写在 async 函数体内，这个 await 会把解释器挂起后再继续，见 vmAsyncExecutor）
    if (kind.startsWith('R_BI_')) {
      return [declConst(N_A, bAt()), declConst(N_B, bAt()), declConst(N_C, bAt()),
        setR(N_A, t.binaryExpression(kind.slice(5), rAt(N_B), rAt(N_C)))];
    }
    if (kind.startsWith('R_UN_')) {
      return [declConst(N_A, bAt()), declConst(N_B, bAt()),
        setR(N_A, t.unaryExpression(kind.slice(5), rAt(N_B)))];
    }
    // 成员读写：取/存都是「对象, 键」两个寄存器
    if (kind === 'R_GM') {
      return [declConst(N_A, bAt()), declConst(N_B, bAt()), declConst(N_C, bAt()),
        setR(N_A, t.memberExpression(rAt(N_B), rAt(N_C), true))];
    }
    if (kind === 'R_SM') {
      return [declConst(N_A, bAt()), declConst(N_B, bAt()), declConst(N_C, bAt()),
        t.expressionStatement(t.assignmentExpression('=',
          t.memberExpression(rAt(N_A), rAt(N_B), true), rAt(N_C)))];
    }
    // 返回 / 抛出
    if (kind === 'R_RT') return [declConst(N_A, bAt()), t.returnStatement(rAt(N_A))];
    if (kind === 'R_TW') return [declConst(N_A, bAt()), t.throwStatement(rAt(N_A))];
    // 无条件跳转：目标字 + 链值字，没有寄存器操作数
    if (kind === 'R_JM') {
      return [declJmpA(),
        t.expressionStatement(t.assignmentExpression('=', idn(N_A), bAt())),
        t.expressionStatement(bAt()),
        assignPC(jumpTarget(idn(N_A), span))];
    }
    // 条件跳转与逻辑短路：目标字、条件寄存器、链值字依次取走。
    // 条件寄存器里的值是**直接读寄存器**（寄存器机没有栈顶可弹），短路分支只改 PC，
    // 结果寄存器不动——「保留左值」这个语义因此是天然成立的。
    if (kind === 'R_JF' || kind === 'R_JT' || kind === 'R_JAND' || kind === 'R_JOR' || kind === 'R_JNUL') {
      const cond = kind === 'R_JF' ? t.unaryExpression('!', rAt(N_V))
        : kind === 'R_JT' ? rAt(N_V)
          : kind === 'R_JAND' ? t.unaryExpression('!', rAt(N_V))
            : kind === 'R_JOR' ? rAt(N_V)
              : t.binaryExpression('!=', rAt(N_V), t.nullLiteral());
      return [declJmpA(),
        t.expressionStatement(t.assignmentExpression('=', idn(N_A), bAt())),
        declConst(N_V, bAt()),
        t.expressionStatement(bAt()),
        t.ifStatement(cond, t.blockStatement([assignPC(jumpTarget(idn(N_A), span))]))];
    }
    // 调用 / 构造 / 数组：操作数个数随元数变化，统一「先取全部操作数再执行」。
    // 取指顺序必须与发射顺序一致（dst、被调/对象/键、然后实参正序），所以先全部读进
    // 临时名，再组表达式——这样求值顺序与源码一致，也绝不会重复取指。
    // 注意 dst 与实参都要经 rAt() 取**寄存器内容**：临时名装的是寄存器号，不是值。
    // （这里漏一层反引用会把寄存器号当实参传进去，是寄存器后端最容易踩的一处。）
    if (kind.startsWith('R_CM_') || kind.startsWith('R_C_') ||
        kind.startsWith('R_NW_') || kind.startsWith('R_AR_')) {
      const names = argNames(regArgc(kind));
      const stmts = names.map((nm) => declConst(nm, bAt()));
      if (kind.startsWith('R_AR_')) {
        // 数组字面量：dst, 元素…（没有「被调」那一位，元素从第 2 个操作数开始）
        stmts.push(setR(names[0], t.arrayExpression(names.slice(1).map((nm) => rAt(nm)))));
        return stmts;
      }
      const rest = names.slice(2).map((nm) => rAt(nm));
      if (kind.startsWith('R_CM_')) {
        stmts.push(setR(names[0], t.callExpression(
          t.memberExpression(rAt(names[1]), rAt(names[2]), true), names.slice(3).map((nm) => rAt(nm)))));
      } else if (kind.startsWith('R_C_')) {
        stmts.push(setR(names[0], t.callExpression(rAt(names[1]), rest)));
      } else {
        stmts.push(setR(names[0], t.newExpression(rAt(names[1]), rest)));
      }
      return stmts;
    }
    // 寄存器宏 RMPKn：n 个打包字「(下标 << 10) | (目标寄存器 << 2) | 源位」依次取走，
    // 每个字一条「按源位选源 → 写目标寄存器」。与栈机宏同理：被合并的每条成员原本只做
    // 「取一个字 → 按源取一个值 → 落寄存器」，三者互不依赖，顺序执行恒等；差别只是
    // 目标寄存器也从打包字里解出来（运行期才知道），静态上连「结果落在哪号寄存器」
    // 都不再是明文。
    if (kind.startsWith('RMPK')) {
      const n = +kind.slice(4);
      const out = [];
      for (let k = 0; k < n; k++) {
        const w = regMacroNames[k];
        out.push(declConst(w, bAt()));
        const idx = t.binaryExpression('>>', idn(w), t.numericLiteral(10));
        const src = [
          t.memberExpression(K, idx, true),
          t.memberExpression(V, idx, true),
          t.callExpression(t.memberExpression(G, idx, true), []),
          t.callExpression(t.memberExpression(K, idx, true), []),
        ];
        let val = src[3];
        for (let s = 2; s >= 0; s--) {
          val = t.conditionalExpression(
            t.binaryExpression('===', t.binaryExpression('&', idn(w), t.numericLiteral(3)),
              t.numericLiteral(s)),
            src[s], val);
        }
        // 目标寄存器号 = (w >> 2) & 255
        out.push(setR(t.binaryExpression('&',
          t.binaryExpression('>>', idn(w), t.numericLiteral(2)), t.numericLiteral(255)), val));
      }
      return out;
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
  // async 函数（异步执行器）**强制走 A/C**：B/D/E 的动作体装在箭头函数里，而非 async
  // 箭头里写 `await` 是语法错误。A 的 switch 体与 C 的嵌套 if 体都直接内联在 async
  // 函数体内，await 合法。代价是 async 函数拿不到密文条目表与直接寻址，换来的是
  // 「能编译」——这一步不做的话产物会直接语法错误，不是"没效果"。
  const dispatchForm = asyncFn
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
      // 动态操作码：取指之后按**前一字的明文**（也就是 nCHAIN）算回轮换量并加回去，
      // 还原成规范编号。桶映射、比对常数、直接寻址表下标全部按规范编号算，所以下面
      // 五种分发形态一个字都不用改。
      //
      // 轮换项必须写在加法**左侧**。JS 对 `+` 的求值顺序是先左后右，而 bAt() 是
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
  const interpLoop = randInt(0, 1) === 0
    ? t.forStatement(null, null, null, interpBody)
    : t.whileStatement(t.booleanLiteral(true), interpBody);

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
    // 寄存器后端的寄存器文件（vmRegisterVM）。空数组起步、按需增长：寄存器号是显式的
    // 小整数，运行期看到的是「当前活跃值集合」，而不是按序压入的栈；高水位 regNext
    // 就是静态面能读到的寄存器数量。非寄存器后端不声明它。
    ...(registerVM ? [t.variableDeclarator(RID, t.arrayExpression([]))] : []),
    // 栈编码：逐函数密钥 + 幂等的编解码函数。谓词只对 32 位整数成立、且排除 -0
    // （位运算出不了 -0，所以"已编码值"永远不进 -0 分支，谓词在编码侧与解码侧一致）；
    // 浮点、大整数、字符串、对象、NaN/Infinity 一律原样通过。
    ...(stackEnc ? [
      t.variableDeclarator(t.identifier(nSEK), t.numericLiteral(krand(0x1000, 0x3fffffff))),
      t.variableDeclarator(t.identifier(nSE), t.arrowFunctionExpression(
        [t.identifier(nSEV)],
        t.conditionalExpression(
          t.binaryExpression('&&',
            t.binaryExpression('===',
              t.unaryExpression('typeof', t.identifier(nSEV)),
              t.stringLiteral('number')),
            t.binaryExpression('&&',
              t.binaryExpression('===',
                t.binaryExpression('|', t.identifier(nSEV), t.numericLiteral(0)),
                t.identifier(nSEV)),
              t.unaryExpression('!', t.binaryExpression('&&',
                t.binaryExpression('===', t.identifier(nSEV), t.numericLiteral(0)),
                t.binaryExpression('<',
                  t.binaryExpression('/', t.numericLiteral(1), t.identifier(nSEV)),
                  t.numericLiteral(0)))))),
          t.binaryExpression('^', t.identifier(nSEV), t.identifier(nSEK)),
          t.identifier(nSEV)))),
    ] : []),
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
  // 新后端的计数在这里累加（走到这一行说明整条编译流程没抛错、产物已落到 AST 上）；
  // 片段里嵌套的函数走 compileInnerFns 递归调用，也会各自累加，所以统计不会漏报
  if (registerVM && ctx.__vmReg) ctx.__vmReg.funcs++;
  if (asyncFn && ctx.__vmAsync) ctx.__vmAsync.funcs++;
  return {
    real: opKinds.length, decoy: decoys.length, total: entries.length, form: dispatchForm,
    regs: registerVM ? regNext : 0, // 寄存器后端用到的寄存器数量（静态面可见的活跃值宽度）
  };
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
function makeTopWrapper(stmts, directives, keep) {
  if (!stmts.length) return null;
  const fn = t.functionExpression(null, [], t.blockStatement(
    stmts,
    (directives || []).map((d) => t.cloneNode(d, true)),
  ));
  if (!canCompile(fn, false, keep)) return null;
  return fn;
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
  // 异步执行器（vmAsyncExecutor）。WASM 解释器内核档的解释器在模块里、没有 await
  // 能力，该档整体忽略本项（allowAsync 为 false，async 函数照旧不编译）。
  const allowAsync = !!options.vmAsyncExecutor && !ctx.__vmWasmShared;
  // 用户点名要保留的标识符与字符串字面量（+ 手写保留正则）。命中的函数一律不编译，
  // 见 canCompile。为 null 时所有判定直接短路，不给默认路径添开销。挂一份到 ctx：
  // 嵌套函数的编译入口（compileInnerFns）在别的作用域里，也要用同一份，不能各建一次。
  const keepNames = buildKeepNames(options);
  ctx.__vmKeepNames = keepNames;
  const mode = options.vmMode === 'comment' || options.vmMode === 'only-string'
    ? options.vmMode
    : 'global';
  // comment 模式靠 -jsvmp- 注释挑目标。parse() 把注释挂在 File.comments 上，
  // AST 顶层遍历取不到，所以直接从 ast.comments 读
  const vmpComments = (ast && Array.isArray(ast.comments))
    ? ast.comments.filter((c) => JSVMP_RE.test(c.text || ''))
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
        const wfn = makeTopWrapper(userStmts, userProg.directives, keepNames);
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
  let regsMax = 0; // 寄存器后端用到的寄存器数量最大值（静态面可见的活跃值宽度）
  // vmMacroOps 的融合计数。放在 ctx 上共享：片段里嵌套的函数由 compileInnerFns
  // 递归编译，计数从那里并回来才不会漏（见 compileFunction 的融合段）
  ctx.__vmMacro = { fused: 0, saved: 0 };
  // vmDynOpcodes 的计数：同样放 ctx 上，片段里嵌套编译的函数也要算进来
  ctx.__vmDyn = { applied: false, space: 0 };
  // vmRegisterVM / vmAsyncExecutor 的计数：寄存器后端处理的函数个数、异步执行器
  // 编译掉的 async 函数个数。都在 compileFunction 入口累加，片段里嵌套编译的也算。
  ctx.__vmReg = { funcs: 0 };
  ctx.__vmAsync = { funcs: 0 };
  const rtNames = ctx.rtNames || new Set();
  // 分发形态计数（A=0/B=1/C=2/D=3/E=4）。形态 D 的验收用例据此断言「D 真的出现了」，
  // 也用于观察 vmDispatchEnc 与 vmCompactDispatcher 开关下的形态分布。
  const formCount = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  // 寄存器模型计数（P4 多态验收用；M3 是寄存器后端的固定模型，不参与多态抽取）
  const modelCount = { M0: 0, M1: 0, M2: 0, M3: 0 };
  // comment 模式的最近声明头判定要用到全部候选函数的头下标
  const allHeads = fns.map((fn) => fnHeadIdx(fn));
  // 因命中保留名单而故意不编译的函数数（代价可见化，见返回值里的 keptPlain）
  let keptPlain = 0;
  for (const fn of fns) {
    if (compiledSet.has(fn)) continue; // 已被外层编译过程连带处理
    if (rtNames.size && fn.type === 'FunctionDeclaration' && fn.id && rtNames.has(fn.id.name)) continue; // RT 内核是解释器的引导层，编译它会造成循环依赖
    prepareFn(fn);
    if (!canCompile(fn, allowAsync, keepNames)) {
      if (keepNames && subtreeHitsKeep(fn.body, keepNames)) keptPlain++;
      continue;
    }
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
        if (r.regs > regsMax) regsMax = r.regs;
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
  return {
    compiled,
    considered: fns.length,
    failed,
    mode,
    // 因命中用户保留名单而**故意不编译**的函数数。代价可见化：用户在界面勾了排除项
    // 就该知道有多少函数因此少了一层 VM 保护，而不是构建完才发现强度掉了。
    // keptPlain: 0 表示没有排除需求，走的是原路径。
    keptPlain,
    topLevel: options.vmWrapTopLevel
      ? { wrapped: topWrapped, reason: topWrapped ? 'ok' : topWrapReason }
      : { wrapped: false, reason: 'off' },
    // 指令集规模。每个编译函数的分发器要枚举 real+decoy 个分发字，干扰项通常不少于 1000
    ops: { real: opsReal, decoy: opsDecoy, total: opsReal + opsDecoy },
    // vmMacroOps：融合出的宏指令条数，与因此少掉的指令条数（字流相应变短）
    macros: { fused: ctx.__vmMacro.fused, saved: ctx.__vmMacro.saved },
    // vmDynOpcodes：是否真的生效，以及取整后的字空间大小（0 表示本项没生效）
    dyn: { applied: ctx.__vmDyn.applied, space: ctx.__vmDyn.space },
    // vmRegisterVM / vmAsyncExecutor：各自实际处理了多少个函数（0 表示本项没生效，
    // 例如寄存器后端被 WASM 解释器内核档挡下、async 函数的 await 落进闭包被保守放弃）
    register: { funcs: ctx.__vmReg.funcs, regs: regsMax },
    asyncExec: { funcs: ctx.__vmAsync.funcs },
    forms: formCount,
    models: modelCount,
  };
};

// 默认导出是 vm 函数本身，isVMCompiled 另以具名导出与函数属性两种形态给出
vm.isVMCompiled = isVMCompiled;

export default vm;
export { isVMCompiled };
