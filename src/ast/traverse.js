import t from './types.js';
import keys from './keys.js';
const { VISITOR_KEYS } = keys;
/**
 * 自研 AST 遍历器，接口取 @babel/traverse 的子集，只提供各 pass 真正用到的那部分。
 * NodePath 覆盖 get/isXxx/replaceWith/skip/stop/容器增删/查找函数父级，Scope 覆盖 bindings/crawl/getBinding/generateUidIdentifier。
 * ReferencedIdentifier 走结构性判断，不依赖 scope 绑定，未构建 scope 时也能工作。
 * 作用域树惰性构建：path.scope 首次访问时才建，不需要绑定信息的 pass 完全不付这个代价。
 *
 * 作用域模型按 mangle 与 selfCheck 的需要来定：每个 scope 节点建一个 Scope 并串起 parent 链，
 * binding 记录 identifier、referencePaths、constantViolations 和 kind；建父 scope 时会深入嵌套函数体，
 * 把闭包内对父级绑定的引用一并收进来，否则重命名会漏掉闭包里的引用。
 * functionWrapper、stringArray 改动 AST 后要调 crawl() 从根重建整棵树。
 */

// 这些节点会挂一个 Scope
const SCOPE_TYPES = new Set([
  'Program', 'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
  'BlockStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement',
  'CatchClause', 'SwitchStatement', 'ClassBody', 'StaticBlock',
  'ClassMethod', 'ObjectMethod',
]);

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
  'ClassMethod', 'ObjectMethod',
]);

/**
 * 指令序言里有没有 "use strict"。
 * 解析器只把开头的指令收进 directives，所以正常情况下不会误判；
 * 同时容忍指令节点被放进 body 的情况，各 pass 造函数体时写法不一定一致。
 */
function hasUseStrict(directives, body) {
  const scan = (list) => {
    for (const d of list || []) {
      if (!d) continue;
      if (d.type === 'Directive') {
        const v = d.value;
        const s = typeof v === 'string' ? v : (v && v.value);
        if (s === 'use strict') return true;
      }
    }
    return false;
  };
  return scan(directives) || scan(body);
}

/**
 * 判断某个作用域节点是否处于严格模式，严格性沿作用域链向下继承。
 * 类体与类方法是恒严格的，ESM 也是。
 * 这个标记只服务块级函数声明的归属：非严格模式下块级函数声明按 Annex B 额外
 * 拿到一个函数级 var 绑定，严格模式下则严格局在块内，两者的绑定位置不同。
 */
function isStrictScope(node, parentStrict) {
  if (node.type === 'ClassBody' || node.type === 'ClassMethod') return true;
  if (node.type === 'Program') {
    return !!parentStrict || node.sourceType === 'module' || hasUseStrict(node.directives, node.body);
  }
  if (FUNCTION_TYPES.has(node.type)) {
    const body = node.body;
    const isBlock = body && body.type === 'BlockStatement';
    return !!parentStrict || hasUseStrict(isBlock ? body.directives : null, isBlock ? body.body : null);
  }
  return !!parentStrict;
}

let scopeBuildSeq = 0; // 每重建一次 scope 树就加一，Scope 靠它判断自己是否过期

class NodePath {
  constructor(node, parentPath, parentKey, listKey, parentNode) {
    this.node = node;
    this.parentPath = parentPath || null;
    // parentNode 允许显式传入，scope 收集阶段造的轻量 path 不带 parentPath 链
    this.parent = parentNode !== undefined ? parentNode : (parentPath ? parentPath.node : null);
    this.parentKey = parentKey || null;
    this.listKey = listKey !== undefined ? listKey : null;
    this._scope = undefined;
    this._shouldSkip = false;
    this._shouldStop = false;
  }

  get scope() {
    if (this._scope) return this._scope;
    if (!this.node || typeof this.node.type !== 'string') return null;
    if (SCOPE_TYPES.has(this.node.type)) {
      // 缓存来自更早的构建，中间有 pass 改过 AST，得重建
      const cached = this.node.__dshScope;
      if (!cached || cached.__build !== scopeBuildSeq) {
        let root = this;
        while (root.parentPath) root = root.parentPath;
        if (root.node && root.node.type === 'Program') {
          buildScopes(root);
        } else {
          this.node.__dshScope = new Scope(this, null, this._scopeKind());
        }
      }
      this._scope = this.node.__dshScope;
      return this._scope;
    }
    return this.parentPath ? this.parentPath.scope : null;
  }

  _scopeKind() {
    switch (this.node.type) {
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
      case 'ClassMethod': case 'ObjectMethod': return 'function';
      case 'Program': return 'program';
      default: return 'block';
    }
  }

  get(key, index) {
    const val = this.node[key];
    if (Array.isArray(val)) {
      const idx = index !== undefined ? index : 0;
      return new NodePath(val[idx], this, key, idx);
    }
    return new NodePath(val, this, key);
  }

  replaceWith(newNode) {
    if (this.listKey !== null) {
      this.parentPath.node[this.parentKey][this.listKey] = newNode;
    } else if (this.parentKey) {
      this.parentPath.node[this.parentKey] = newNode;
    }
    this.node = newNode;
  }

  remove() {
    if (this.listKey !== null) {
      const arr = this.parentPath.node[this.parentKey];
      arr.splice(this.listKey, 1);
    }
  }

  skip() { this._shouldSkip = true; }
  stop() { this._shouldStop = true; }

  unshiftContainer(key, nodes) {
    const arr = this.node[key];
    arr.unshift(...(Array.isArray(nodes) ? nodes : [nodes]));
  }

  pushContainer(key, nodes) {
    const arr = this.node[key];
    arr.push(...(Array.isArray(nodes) ? nodes : [nodes]));
  }

  insertBefore(nodes) {
    if (this.listKey === null) return;
    const arr = this.parentPath.node[this.parentKey];
    const nodeList = Array.isArray(nodes) ? nodes : [nodes];
    arr.splice(this.listKey, 0, ...nodeList);
    this.listKey += nodeList.length;
  }

  insertAfter(nodes) {
    if (this.listKey === null) return;
    const arr = this.parentPath.node[this.parentKey];
    arr.splice(this.listKey + 1, 0, ...(Array.isArray(nodes) ? nodes : [nodes]));
  }

  getFunctionParent() {
    let p = this.parentPath;
    while (p) {
      const type = p.node.type;
      if (FUNCTION_TYPES.has(type) || type === 'Program') return p;
      p = p.parentPath;
    }
    return null;
  }

  isXxx(type, opts) {
    if (!this.node || this.node.type !== type) return false;
    if (!opts) return true;
    for (const k of Object.keys(opts)) {
      if (this.node[k] !== opts[k]) return false;
    }
    return true;
  }

  isProgram() { return !!this.node && this.node.type === 'Program'; }
  isScope() { return !!this.node && SCOPE_TYPES.has(this.node.type); }
}

for (const type of Object.keys(VISITOR_KEYS)) {
  NodePath.prototype['is' + type] = function (opts) { return this.isXxx(type, opts); };
}

// 与 types.js 的 is.* 保持同一套判断，mangle.renameViolation 依赖这两个方法
NodePath.prototype.isForXStatement = function () {
  const t = this.node && this.node.type;
  return t === 'ForInStatement' || t === 'ForOfStatement';
};
NodePath.prototype.isFunction = function () {
  const t = this.node && this.node.type;
  return t === 'FunctionDeclaration' || t === 'FunctionExpression' || t === 'ArrowFunctionExpression' || t === 'ClassMethod' || t === 'ObjectMethod';
};

class Scope {
  constructor(path, parent, kind) {
    this.path = path;
    this.parent = parent || null;
    this.kind = kind || (path ? path._scopeKind() : 'block');
    this.bindings = {};
    this.uids = new Set();
    this.strict = parent ? !!parent.strict : false; // 严格性默认继承，由 descend 按节点类型修正
    this._crawled = true; // bindings 在构建时已经填好
    this.__build = scopeBuildSeq; // 构建代数，用来判断是否已失效
  }

  crawl() {
    // AST 被改动过，从根把整棵 scope 树重搭一遍
    let root = this.path;
    while (root.parentPath) root = root.parentPath;
    if (root.node && root.node.type === 'Program') {
      buildScopes(root);
      const progScope = root.node.__dshScope;
      this.bindings = progScope.bindings;
      this.parent = progScope.parent;
      return;
    }
    // 没有 Program 根，只重建自身，收集本 scope 直接子树里的声明
    this.bindings = {};
    this.uids = new Set();
    const self = this;
    (function walk(n, st) {
      if (!n || typeof n.type !== 'string') return;
      const type = n.type;
      if (type === 'VariableDeclaration') {
        for (const d of n.declarations) collectPattern(d.id, n.kind, self, st);
      } else if (type === 'ClassDeclaration' && n.id) {
        register(n.id.name, 'let', n.id, self);
      } else if (type === 'FunctionDeclaration' && n.id) {
        register(n.id.name, 'hoisted', n.id, self);
      } else if (FUNCTION_TYPES.has(type)) {
        return; // 嵌套函数体自成 scope，不再往下收
      }
      const keys = VISITOR_KEYS[type] || [];
      for (const k of keys) {
        const v = n[k];
        if (Array.isArray(v)) {
          for (const c of v) walk(c, st);
        } else if (v && typeof v.type === 'string') {
          walk(v, st);
        }
      }
    })(this.path.node, null);
  }

  getBinding(name) {
    if (this.bindings[name]) return this.bindings[name];
    if (this.parent) return this.parent.getBinding(name);
    return null;
  }

  generateUidIdentifier(name) {
    const base = '_' + name;
    let uid = base;
    let i = 1;
    while (this._hasName(uid)) {
      uid = base + (i++);
    }
    this.uids.add(uid);
    return t.identifier(uid);
  }

  _hasName(name) {
    if (this.bindings[name]) return true;
    if (this.uids.has(name)) return true;
    if (this.parent) return this.parent._hasName(name);
    return false;
  }
}

// 单遍构建，再补挂前向引用。声明提升意味着源码里靠前的引用可能指向后面才注册的声明，
// 典型是调用点写在函数声明之前。顺序遍历到这种引用时 getBinding 还命中不了，
// 而直接丢掉会让 mangle 只改声明不改调用点，产物在运行期报 ReferenceError，
// 所以先暂存进 pendingRefs，等整棵树建完再统一挂到 binding 上。
let pendingRefs = [];
function buildScopes(rootPath) {
  scopeBuildSeq++; // 换代，之前留下的 __dshScope 全部作废
  const programNode = rootPath.node;
  const programScope = new Scope(rootPath, null, 'program');
  programScope.strict = isStrictScope(programNode, false);
  programNode.__dshScope = programScope;
  const stack = [programScope];
  pendingRefs = [];
  collectNode(programNode, null, null, stack, null);
  // 声明此时全部注册完毕，getBinding 能沿 parent 链找到目标
  if (pendingRefs.length > 0) {
    for (const ref of pendingRefs) {
      const binding = ref.scope.getBinding(ref.name);
      if (!binding) continue;
      if (ref.violation) binding.constantViolations.push(ref.violation);
      else binding.referencePaths.push(ref.path);
    }
    pendingRefs = [];
  }
}

/**
 * 注册声明、收集引用与常量违规，并递归子节点。
 * 为省开销直接传 node/parentNode/key，不给每个子节点造 NodePath，
 * 只在登记引用、违规或构造 Scope 时才建，mangle 会长期持有这些 path。
 * @param {object} node 当前节点
 * @param {object} parentNode 父节点
 * @param {string} parentKey 当前节点在父节点上的键名
 * @param {Array<object>} stack scope 栈，栈顶是当前作用域
 * @param {object|null} lvalNode 当前所处的左值容器节点，非左值位置为 null
 * @returns {void}
 */
function collectNode(node, parentNode, parentKey, stack, lvalNode) {
  if (!node || typeof node.type !== 'string') return;
  const type = node.type;
  const scope = stack[stack.length - 1];

  if (type === 'VariableDeclaration') {
    const target = node.kind === 'var' ? findFunctionScope(stack) : scope;
    for (const decl of node.declarations) {
      collectPattern(decl.id, node.kind, target, stack);
    }
  } else if (type === 'ClassDeclaration') {
    if (node.id) register(node.id.name, 'let', node.id, scope);
  } else if (type === 'ImportDeclaration') {
    for (const spec of node.specifiers) {
      if (spec.local) register(spec.local.name, 'module', spec.local, scope);
    }
  }
  // 函数声明的 id 提升到外围作用域，交给 descend() 注册

  if (type === 'Identifier') {
    // x = ...、x++、for(x of ..)、delete x 这类直接写目标记作违规。
    // 写目标内部的成员读取（a[i]=x 里的 a 和 i）算引用，必须进 referencePaths，
    // 否则 mangle 只改声明和违规点，这些引用会留着旧名。
    const isDirectWrite = lvalNode && parentNode === lvalNode &&
      isLvalParentKey(lvalNode.type, parentKey);
    if (isDirectWrite) {
      const binding = scope.getBinding(node.name);
      if (binding) {
        // 压入的是容器节点的轻量 path，renameViolation 按容器类型去改里面的目标标识符
        binding.constantViolations.push(new NodePath(lvalNode, null, null, null, null));
      } else if (pendingRefs !== null) {
        // 赋值点写在 var 声明之前的也算前向写入，不能丢
        pendingRefs.push({ scope, name: node.name, violation: new NodePath(lvalNode, null, null, null, null) });
      }
    } else if (isRefByIdent(node, parentNode, parentKey)) {
      const binding = scope.getBinding(node.name);
      if (binding) {
        binding.referencePaths.push(new NodePath(node, null, parentKey, null, parentNode));
      } else if (pendingRefs !== null) {
        // 前向引用，binding 还没注册，先存起来等 buildScopes 收尾补挂
        pendingRefs.push({ scope, name: node.name, path: new NodePath(node, null, parentKey, null, parentNode) });
      }
    }
  }

  // 函数参数留给 descend() 在压入函数 scope 之后注册

  const keys = VISITOR_KEYS[type] || [];
  for (const key of keys) {
    const val = node[key];
    if (Array.isArray(val)) {
      const childLval = isLvalParentKey(type, key) ? node : lvalNode;
      for (let i = 0; i < val.length; i++) {
        const child = val[i];
        if (child && typeof child.type === 'string') {
          descend(child, node, key, stack, childLval);
        }
      }
    } else if (val && typeof val.type === 'string') {
      const childLval = isLvalParentKey(type, key) ? node : lvalNode;
      descend(val, node, key, stack, childLval);
    }
  }
}

/**
 * 从结构上判断 Identifier 是否处于引用位置，声明、属性键、标签、绑定位置都排除在外。
 * 直接收 node/parentNode/parentKey，不必先造 path。
 * @param {object} node 待判断的节点
 * @param {object} parentNode 父节点
 * @param {string} parentKey 当前节点在父节点上的键名
 * @returns {boolean} 是引用返回 true
 */
function isRefByIdent(node, parentNode, parentKey) {
  if (!node || node.type !== 'Identifier') return false;
  if (!parentNode) return true;
  const parent = parentNode;
  // 声明与绑定位置
  if (parent.type === 'VariableDeclarator' && parent.id === node) return false;
  if ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' || parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression') && parent.id === node) return false;
  if ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' || parent.type === 'ArrowFunctionExpression' || parent.type === 'ClassMethod' || parent.type === 'ObjectMethod') && (parent.params || []).includes(node)) return false;
  if (parent.type === 'CatchClause' && parent.param === node) return false;
  if (parent.type === 'ImportDefaultSpecifier' || parent.type === 'ImportNamespaceSpecifier') return false;
  // `import { A as B }` 里两侧都不是变量引用：imported 是被导入模块导出的属性名，
  // local 才是本模块的绑定。只排除 local 的话，imported 会被当成引用，而它压根
  // 没有绑定，selfCheck 立刻报一处假的"未绑定引用"。
  // 注意 shorthand（`import { A }`）两侧指向同一节点，这里一并覆盖。
  if (parent.type === 'ImportSpecifier') return false;
  // export 的 exported 是对外属性名，不是引用；但 local 是**真实引用**，指向本模块
  // 的绑定，`export { c as d }` 里的 c 若不存在就是真的未绑定，必须继续报出来。
  if (parent.type === 'ExportSpecifier' && parent.exported === node) return false;
  if (parent.type === 'ObjectMethod' && parent.key === node) return false;
  // 私有名的 id 是属性名字面量，解析不到变量
  if (parent.type === 'PrivateName') return false;
  // 非计算的属性键
  if (parent.type === 'MemberExpression' && !parent.computed && parent.property === node) return false;
  if (parent.type === 'OptionalMemberExpression' && !parent.computed && parent.property === node) return false;
  if (parent.type === 'ObjectProperty' && !parent.computed && parent.key === node) return false;
  if (parent.type === 'ClassMethod' && !parent.computed && parent.key === node) return false;
  if (parent.type === 'ClassProperty' && !parent.computed && parent.key === node) return false;
  if (parent.type === 'LabeledStatement' && parent.label === node) return false;
  if (parent.type === 'BreakStatement' && parent.label === node) return false;
  if (parent.type === 'ContinueStatement' && parent.label === node) return false;
  if (parent.type === 'MetaProperty') return false;
  if (parent.type === 'ImportDeclaration') return false;
  // 解构模式里的标识符是绑定位置
  if (parent.type === 'ObjectPattern' || parent.type === 'ArrayPattern' || parent.type === 'AssignmentPattern' || parent.type === 'RestElement') return false;
  return true;
}

// walk 里的 ReferencedIdentifier 探测仍然按 path 调用
function isReferenceIdentifier(path) {
  return isRefByIdent(path.node, path.parent, path.parentKey);
}

// 判断节点的某个键是不是左值位置，进入时把 lvalNode 设成该节点
function isLvalParentKey(type, key) {
  if ((type === 'AssignmentExpression' || type === 'AssignmentPattern') && key === 'left') return true;
  if (type === 'UpdateExpression' && key === 'argument') return true;
  if ((type === 'ForInStatement' || type === 'ForOfStatement') && key === 'left') return true;
  if (type === 'UnaryExpression' && key === 'argument' ) return true; // delete x
  if (type === 'VariableDeclarator' && key === 'id') return true;     // 声明位置，kind 在别处处理
  if (type === 'CatchClause' && key === 'param') return true;
  // 解构赋值模式内部的标识符是写入点，如 [p,...q]=x 的 p/q、{a:{b}}=x 的 b
  if ((type === 'ArrayPattern' || type === 'AssignmentPattern' || type === 'RestElement') && (key === 'elements' || key === 'argument' || key === 'left')) return true;
  if (type === 'ObjectPattern' && key === 'properties') return true;
  if (type === 'ObjectProperty' && key === 'value') return true;
  return false;
}

// 进入子节点，遇到 scope 节点就压栈
function descend(node, parentNode, parentKey, stack, lvalNode) {
  const type = node.type;
  if (SCOPE_TYPES.has(type)) {
    const parent = stack[stack.length - 1];
    // 函数声明的名字提升到包含它的函数或 Program scope
    if (type === 'FunctionDeclaration' && node.id) {
      // 块级函数声明在非严格模式下按 Annex B 还额外拿到一个函数级 var 绑定，
      // 块外按同一个名字也能访问到。只登记在块 scope 会让块外的引用找不到绑定：
      // 自检把它当悬空引用直接报错，改名也只能改一半。
      // 严格模式下块级函数声明严格局在块内，登记到函数作用域反而会把本该
      // 互相遮蔽的同名绑定并成一个，所以按严格性分流。
      const target = parent.kind === 'block' && !parent.strict ? findFunctionScope(stack) : parent;
      register(node.id.name, 'hoisted', node.id, target);
    }
    // 每次构建都新建 Scope，Scope 要长期持有 path 作为 binding 树的根，到这里才建 NodePath
    const path = new NodePath(node, null, parentKey, null, parentNode);
    const scope = new Scope(path, parent, path._scopeKind());
    scope.strict = isStrictScope(node, parent ? parent.strict : false);
    node.__dshScope = scope;
    stack.push(scope);
    if (FUNCTION_TYPES.has(type)) {
      // 具名函数表达式的名字只绑在函数自己身上，供递归自引用
      if (type === 'FunctionExpression' && node.id) {
        register(node.id.name, 'hoisted', node.id, scope);
      }
      for (const p of node.params || []) collectPattern(p, 'param', scope, stack);
    }
    if (type === 'ClassBody' && parentNode && parentNode.type === 'ClassExpression' && parentNode.id) {
      // 具名类表达式的类名同样只绑在类自己身上，extends 与类体里的自引用靠它。
      // 漏掉这一步，selfCheck 会把类体内对类名的引用当成未绑定引用，esbuild 的产物里这类写法很多。
      register(parentNode.id.name, 'let', parentNode.id, scope);
    }
    if (type === 'CatchClause' && node.param) {
      collectPattern(node.param, 'let', scope, stack);
    }
    collectNode(node, parentNode, parentKey, stack, null); // 换了作用域，左值上下文清零
    stack.pop();
  } else {
    collectNode(node, parentNode, parentKey, stack, lvalNode);
  }
}

function findFunctionScope(stack) {
  for (let i = stack.length - 1; i >= 0; i--) {
    const s = stack[i];
    if (s.kind === 'function' || s.kind === 'program') return s;
  }
  return stack[stack.length - 1];
}

/**
 * 把 pattern 里的绑定标识符登记到 scope，解构会递归展开。
 * @param {object} pattern 变量声明、参数或解构节点
 * @param {string} kind 绑定种类，取 var/let/const/param/hoisted/module 等
 * @param {object} scope 接收绑定的作用域
 * @param {Array<object>} stack scope 栈
 * @returns {void}
 */
function collectPattern(pattern, kind, scope, stack) {
  if (!pattern || typeof pattern !== 'object') return;
  const type = pattern.type;
  if (type === 'Identifier') {
    register(pattern.name, kind, pattern, scope);
    return;
  }
  if (type === 'ObjectPattern') {
    for (const prop of pattern.properties || []) {
      if (!prop) continue;
      if (prop.type === 'RestElement') collectPattern(prop.argument, kind, scope, stack);
      else if (prop.type === 'ObjectProperty') collectPattern(prop.value, kind, scope, stack);
    }
    return;
  }
  if (type === 'ArrayPattern') {
    for (const elem of pattern.elements || []) {
      if (elem) collectPattern(elem, kind, scope, stack);
    }
    return;
  }
  if (type === 'AssignmentPattern') {
    collectPattern(pattern.left, kind, scope, stack);
    return;
  }
  if (type === 'RestElement') {
    collectPattern(pattern.argument, kind, scope, stack);
    return;
  }
}

function register(name, kind, idNode, scope) {
  if (!scope.bindings[name]) {
    scope.bindings[name] = {
      identifier: idNode,
      kind,
      referencePaths: [],
      constantViolations: [],
    };
    return;
  }
  const binding = scope.bindings[name];
  // 同名重复声明（var 重复、块级函数声明提升到函数作用域后与既有绑定同名等）
  // 是同一条绑定，每个声明点都要改名。只改第一个的话，另一处声明会留着旧名，
  // 运行期两边对不上：var x=1;var x=2 会读回 1。
  if (idNode && binding.identifier !== idNode) {
    if (!binding.declarationIds) binding.declarationIds = [];
    if (!binding.declarationIds.includes(idNode)) binding.declarationIds.push(idNode);
  }
  if (kind === 'var' || kind === 'hoisted') {
    if (!binding.constantViolations) binding.constantViolations = [];
  }
}

/**
 * 遍历 AST，逐个节点调用 visitor。
 * visitor 的键是节点类型，也支持 Function 与 ReferencedIdentifier 这类集合键。
 * @param {object} ast 根节点，传入 File 时会自动改用它的 program
 * @param {object} visitor 访问器。noScope 为兼容标志，现已无作用（建树本就惰性）
 * @returns {void}
 */
function traverse(ast, visitor) {
  if (!ast) return;
  // 兼容 File 包装，直接遍历它的 program
  if (ast.type === 'File' && ast.program) ast = ast.program;
  const rootPath = new NodePath(ast, null, null, null);
  // **作用域树按需构建，这里不预先建。**
  //
  // 原来是 noScope 为假就无条件 buildScopes()，等于每次遍历都从根重搭整棵作用域树
  // （collectNode 要过一遍全树、注册绑定、挂引用路径）。但多数 pass 根本不读
  // path.scope：控制流扁平化、函数包装、谓词注入都不需要绑定信息。实测这一项
  // 占中档配置总耗时约 15%，全花在没人看的结果上。
  //
  // 惰性化是安全的：NodePath.scope 的 getter 本来就实现了"缓存失效就重建"的路径
  // （按 scopeBuildSeq 判断陈旧），第一次读 path.scope 时会自己调 buildScopes(root)。
  // __dshScope 挂在**节点**上，因此同一节点的任意 path 实例拿到的是同一份作用域；
  // getBinding 只沿已建好的 parent 链走，而拿到 Scope 的唯一途径就是 path.scope，
  // 不存在"没建就查绑定"的路径。Scope.crawl() 也自己会重建，不依赖这里的预建。
  //
  // visitor.noScope 因此变成了纯兼容标志：它原本只用来阻止这次**急切**构建，而
  // getter 的惰性路径一直不看它。现在急切构建没有了，传不传都一样——保留是为了
  // 不动 12 个 pass 的调用点，语义上等价。
  // 每个节点都要用到的三件事，一次性算好放进 plan。
  // 原来是逐节点做 `visitor[type]`（动态键查表）、`FUNCTION_TYPES.has(type)`
  // （Set 查表）和 `visitor.ReferencedIdentifier`（属性读），节点数上百万时
  // 这三次查找就是可观的开销。CPU profile 显示 walk 自耗时第一（15.7%）。
  walk(ast, rootPath, {
    visitor,
    // 没有 Function 键时就不必查 FUNCTION_TYPES，绝大多数 pass 用不到这个集合键
    hasFnKey: typeof visitor.Function === 'function',
    refVisitor: typeof visitor.ReferencedIdentifier === 'function' ? visitor.ReferencedIdentifier : null,
  });
}

function walk(node, path, plan) {
  if (!node || typeof node.type !== 'string') return;
  const type = node.type;
  const visitor = plan.visitor;
  const fn = visitor[type] || (plan.hasFnKey && FUNCTION_TYPES.has(type) ? visitor.Function : null);

  if (plan.refVisitor !== null && type === 'Identifier' && isReferenceIdentifier(path)) {
    plan.refVisitor(path);
    if (path._shouldStop) { path.parentPath._shouldStop = true; return; }
    if (path._shouldSkip) return;
  }

  if (fn) {
    fn(path);
    if (path._shouldStop) { if (path.parentPath) path.parentPath._shouldStop = true; return; }
    if (path._shouldSkip) return;
  }

  // 叶子节点（Identifier 与各种 Literal）的子键是空数组，而它们占全部节点的一半
  // 以上。用索引循环而不是 for...of：后者对数组**每次都会新建迭代器对象**，
  // 节点一多就是实实在在的分配与 GC 压力（profile 里 GC 占 10.9%）。
  const keys = VISITOR_KEYS[type];
  const nk = keys == null ? 0 : keys.length;
  for (let k = 0; k < nk; k++) {
    const key = keys[k];
    const val = node[key];
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        const child = val[i];
        if (!child || typeof child.type !== 'string') continue;
        const childPath = new NodePath(child, path, key, i);
        walk(child, childPath, plan);
        if (childPath._shouldStop) { path._shouldStop = true; break; }
      }
    } else if (val && typeof val.type === 'string') {
      const childPath = new NodePath(val, path, key);
      walk(val, childPath, plan);
      if (childPath._shouldStop) { path._shouldStop = true; return; }
    }
    if (path._shouldStop) break;
  }
}

export default traverse;
