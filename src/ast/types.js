import keys from './keys.js';
const { VISITOR_KEYS } = keys;
/**
 * 自研 AST 节点构造器与类型判断，接口对齐 @babel/types，只实现本项目各 pass 用到的部分。
 * 不依赖 Babel 是为了让混淆产物不带任何第三方运行时。
 */

function node(type, fields) {
  const n = { type };
  for (const k of Object.keys(fields)) {
    if (fields[k] !== undefined) n[k] = fields[k];
  }
  return n;
}

const identifier = (name) => node('Identifier', { name });
const privateName = (id) => node('PrivateName', { id });
const stringLiteral = (value) => node('StringLiteral', { value });
const numericLiteral = (value) => node('NumericLiteral', { value });
const booleanLiteral = (value) => node('BooleanLiteral', { value });
const nullLiteral = () => node('NullLiteral', { value: null });
const bigIntLiteral = (value) => node('BigIntLiteral', { value: String(value) });
const decimalLiteral = (value) => node('DecimalLiteral', { value: String(value) });
const regexpLiteral = (pattern, flags) => node('RegExpLiteral', { pattern, flags });
const directiveLiteral = (value) => node('DirectiveLiteral', { value });
const directive = (value) => node('Directive', { value: directiveLiteral(value) });

const templateElement = (value, tail) =>
  node('TemplateElement', { value: { raw: value, cooked: value }, tail: !!tail });
const templateLiteral = (quasis, expressions) => node('TemplateLiteral', { quasis, expressions });
const taggedTemplateExpression = (tag, quasi) => node('TaggedTemplateExpression', { tag, quasi });

const thisExpression = () => node('ThisExpression', {});
const superNode = () => node('Super', {});
const arrayExpression = (elements) => node('ArrayExpression', { elements });
const objectExpression = (properties) => node('ObjectExpression', { properties });
const objectProperty = (key, value, computed, shorthand) =>
  node('ObjectProperty', { key, value, computed: !!computed, shorthand: !!shorthand });
const objectMethod = (kind, key, params, body, computed, generator, async) =>
  node('ObjectMethod', { kind, key, params, body, computed: !!computed, generator: !!generator, async: !!async });
const functionExpression = (id, params, body, generator, async) =>
  node('FunctionExpression', { id: id || null, params, body, generator: !!generator, async: !!async });
const arrowFunctionExpression = (params, body, async) =>
  node('ArrowFunctionExpression', { params, body, async: !!async, expression: !body || body.type !== 'BlockStatement' });
const unaryExpression = (operator, argument, prefix) =>
  node('UnaryExpression', { operator, argument, prefix: prefix !== false });
const updateExpression = (operator, argument, prefix) =>
  node('UpdateExpression', { operator, argument, prefix: !!prefix });
const binaryExpression = (operator, left, right) => node('BinaryExpression', { operator, left, right });
const logicalExpression = (operator, left, right) => node('LogicalExpression', { operator, left, right });
const assignmentExpression = (operator, left, right) => node('AssignmentExpression', { operator, left, right });
const conditionalExpression = (test, consequent, alternate) =>
  node('ConditionalExpression', { test, consequent, alternate });
const callExpression = (callee, args) => node('CallExpression', { callee, arguments: args });
const optionalCallExpression = (callee, args, optional) =>
  node('OptionalCallExpression', { callee, arguments: args, optional: !!optional });
const newExpression = (callee, args) => node('NewExpression', { callee, arguments: args });
const memberExpression = (object, property, computed, optional) =>
  node('MemberExpression', { object, property, computed: !!computed, optional: !!optional });
const optionalMemberExpression = (object, property, computed, optional) =>
  node('OptionalMemberExpression', { object, property, computed: !!computed, optional: !!optional });
const sequenceExpression = (expressions) => node('SequenceExpression', { expressions });
const spreadElement = (argument) => node('SpreadElement', { argument });
const restElement = (argument) => node('RestElement', { argument });
const assignmentPattern = (left, right) => node('AssignmentPattern', { left, right });
const objectPattern = (properties) => node('ObjectPattern', { properties });
const arrayPattern = (elements) => node('ArrayPattern', { elements });
const yieldExpression = (argument, delegate) => node('YieldExpression', { argument: argument || null, delegate: !!delegate });
const awaitExpression = (argument) => node('AwaitExpression', { argument });
const parenthesizedExpression = (expression) => node('ParenthesizedExpression', { expression });
const metaProperty = (meta, property) => node('MetaProperty', { meta, property });
// 动态 import()：callee 位置上的 Import 节点（沿用 Babel 旧命名）。它不是标识符，
// 所以既不会被重命名、也不会被当成对某个名为 import 的全局函数的调用。
const importNode = () => node('Import', {});

const expressionStatement = (expression) => node('ExpressionStatement', { expression });
const variableDeclaration = (kind, declarations) => node('VariableDeclaration', { kind, declarations });
const variableDeclarator = (id, init) => node('VariableDeclarator', { id, init: init || null });
const blockStatement = (body, directives) =>
  node('BlockStatement', { body, directives: directives || [] });
const emptyStatement = () => node('EmptyStatement', {});
const ifStatement = (test, consequent, alternate) =>
  node('IfStatement', { test, consequent, alternate: alternate || null });
const forStatement = (init, test, update, body) =>
  node('ForStatement', { init: init || null, test: test || null, update: update || null, body });
const forInStatement = (left, right, body) => node('ForInStatement', { left, right, body });
const forOfStatement = (left, right, body, isAwait) => node('ForOfStatement', { left, right, body, await: !!isAwait });
const whileStatement = (test, body) => node('WhileStatement', { test, body });
const doWhileStatement = (body, test) => node('DoWhileStatement', { body, test });
const switchStatement = (discriminant, cases) => node('SwitchStatement', { discriminant, cases });
const switchCase = (test, consequent) => node('SwitchCase', { test: test || null, consequent });
const breakStatement = (label) => node('BreakStatement', { label: label || null });
const continueStatement = (label) => node('ContinueStatement', { label: label || null });
const returnStatement = (argument) => node('ReturnStatement', { argument: argument || null });
const throwStatement = (argument) => node('ThrowStatement', { argument });
const tryStatement = (block, handler, finalizer) =>
  node('TryStatement', { block, handler: handler || null, finalizer: finalizer || null });
const catchClause = (param, body) => node('CatchClause', { param: param || null, body });
const debuggerStatement = () => node('DebuggerStatement', {});
const labeledStatement = (label, body) => node('LabeledStatement', { label, body });
const withStatement = (object, body) => node('WithStatement', { object, body });

const functionDeclaration = (id, params, body, generator, async) =>
  node('FunctionDeclaration', { id, params, body, generator: !!generator, async: !!async });
const classBody = (body) => node('ClassBody', { body });
const classMethod = (kind, key, params, body, computed, staticFlag) =>
  node('ClassMethod', { kind, key, params, body, computed: !!computed, static: !!staticFlag });
const classProperty = (key, value, staticFlag) =>
  node('ClassProperty', { key, value: value || null, static: !!staticFlag });
// 类静态块，static { ... }。body 与 directives 分开存，与 BlockStatement 一致
const staticBlock = (body, directives) =>
  node('StaticBlock', { body, directives: directives || [] });
const classDeclaration = (id, superClass, body, decorators) =>
  node('ClassDeclaration', { id, superClass: superClass || null, body, decorators: decorators || [] });
const classExpression = (id, superClass, body) =>
  node('ClassExpression', { id: id || null, superClass: superClass || null, body });

const importSpecifier = (imported, local) => node('ImportSpecifier', { imported, local });
const importDefaultSpecifier = (local) => node('ImportDefaultSpecifier', { local });
const importNamespaceSpecifier = (local) => node('ImportNamespaceSpecifier', { local });
const importDeclaration = (specifiers, source) => node('ImportDeclaration', { specifiers, source });
const exportSpecifier = (local, exported) => node('ExportSpecifier', { local, exported });
const exportNamedDeclaration = (declaration, specifiers, source) =>
  node('ExportNamedDeclaration', { declaration: declaration || null, specifiers: specifiers || [], source: source || null });
const exportDefaultDeclaration = (declaration) => node('ExportDefaultDeclaration', { declaration });
const exportAllDeclaration = (source) => node('ExportAllDeclaration', { source });

const program = (body, directives, sourceType) =>
  node('Program', { body, directives: directives || [], sourceType: sourceType || 'script' });

// 每个节点类型生成一个 is<Type>，类型清单直接取自 VISITOR_KEYS
function makeIsType(type) {
  return (n) => !!n && n.type === type;
}
const is = {};
for (const type of Object.keys(VISITOR_KEYS)) {
  is['is' + type] = makeIsType(type);
}

// 跨类型的并集判断，改名与自检阶段按这些分组筛选节点
is.isLiteral = (n) => !!n && (
  n.type === 'StringLiteral' || n.type === 'NumericLiteral' || n.type === 'BooleanLiteral' ||
  n.type === 'NullLiteral' || n.type === 'RegExpLiteral' || n.type === 'TemplateLiteral' ||
  n.type === 'BigIntLiteral' || n.type === 'DecimalLiteral'
);
is.isForXStatement = (n) => !!n && (n.type === 'ForInStatement' || n.type === 'ForOfStatement');
is.isFunction = (n) => !!n && (
  n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression'
);
is.isDeclaration = (n) => !!n && (
  n.type === 'VariableDeclaration' || n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration' ||
  n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportDefaultDeclaration' ||
  n.type === 'ExportAllDeclaration'
);
is.isPattern = (n) => !!n && (
  n.type === 'ObjectPattern' || n.type === 'ArrayPattern' || n.type === 'AssignmentPattern' || n.type === 'RestElement'
);

const t = { ...is };

Object.assign(t, {
  identifier, privateName, stringLiteral, numericLiteral, booleanLiteral, nullLiteral,
  bigIntLiteral, decimalLiteral, regexpLiteral, directiveLiteral, directive,
  templateElement, templateLiteral, taggedTemplateExpression,
  thisExpression, super: superNode, arrayExpression, objectExpression, objectProperty, objectMethod,
  functionExpression, arrowFunctionExpression, unaryExpression, updateExpression, binaryExpression,
  logicalExpression, assignmentExpression, conditionalExpression, callExpression, optionalCallExpression,
  newExpression, memberExpression, optionalMemberExpression, sequenceExpression, spreadElement, restElement,
  assignmentPattern, objectPattern, arrayPattern, yieldExpression, awaitExpression, parenthesizedExpression,
  metaProperty, import: importNode, expressionStatement, variableDeclaration, variableDeclarator, blockStatement, emptyStatement,
  ifStatement, forStatement, forInStatement, forOfStatement, whileStatement, doWhileStatement, switchStatement,
  switchCase, breakStatement, continueStatement, returnStatement, throwStatement, tryStatement, catchClause,
  debuggerStatement, labeledStatement, withStatement, functionDeclaration, classBody, classMethod, classProperty,
  staticBlock, classDeclaration, classExpression, importSpecifier, importDefaultSpecifier, importNamespaceSpecifier,
  importDeclaration, exportSpecifier, exportNamedDeclaration, exportDefaultDeclaration, exportAllDeclaration,
  program,
});

/**
 * 收集节点或其数组中出现的绑定标识符，返回 { name: identifierNode }。
 * 入参可以是 Identifier、ObjectPattern/ArrayPattern、VariableDeclarator、
 * VariableDeclaration，也可以是它们的数组。
 */
function getBindingIdentifiers(node) {
  const ids = {};
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const c of n) visit(c); return; }
    if (typeof n.type !== 'string') return;
    if (n.type === 'Identifier') {
      if (!ids[n.name]) ids[n.name] = n;
      return;
    }
    if (n.type === 'VariableDeclaration') {
      for (const d of n.declarations || []) visit(d.id);
      return;
    }
    if (n.type === 'VariableDeclarator') { visit(n.id); return; }
    // 对象属性的绑定在 value 上，简写时 key 与 value 是同一个节点
    if (n.type === 'ObjectProperty') { visit(n.value); return; }
    if (n.type === 'ObjectPattern' || n.type === 'ArrayPattern' || n.type === 'AssignmentPattern' || n.type === 'RestElement') {
      for (const k of Object.keys(n)) {
        if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' || k === 'type') continue;
        const v = n[k];
        if (Array.isArray(v)) { for (const c of v) visit(c); }
        else if (v && typeof v === 'object' && typeof v.type === 'string') visit(v);
      }
    }
    if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression') {
      if (n.id) visit(n.id);
    }
    if (n.type === 'ClassDeclaration' || n.type === 'ClassExpression') {
      if (n.id) visit(n.id);
    }
  };
  visit(node);
  return ids;
}

/**
 * 克隆节点树。第二个参数与 Babel 一致，传 true 表示深克隆。
 * @param {object|Array} node 待克隆的节点或节点数组
 * @param {boolean} [deep] 是否深克隆，缺省按深克隆处理
 * @returns {object|Array} 克隆结果
 */
function cloneNode(node, deep) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((c) => cloneNode(c, deep));
  if (typeof node.type !== 'string') {
    if (deep === false || deep === undefined) return node;
    const copy = {};
    for (const k of Object.keys(node)) copy[k] = node[k];
    return copy;
  }
  const copy = { type: node.type };
  // 复制除 loc/start/end 之外的全部字段，节点值递归克隆，数组逐项克隆。
  // 字段表不能用 VISITOR_KEYS：Identifier.name、VariableDeclaration.kind、
  // 字面量 value 这类标量不在表里，照着表复制会丢。
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'loc' || k === 'start' || k === 'end') continue;
    const v = node[k];
    if (v === undefined) continue;
    copy[k] = Array.isArray(v)
      ? v.map((c) => (deep !== false && c && typeof c === 'object' && typeof c.type === 'string' ? cloneNode(c, true) : c))
      : (v && typeof v === 'object' && typeof v.type === 'string')
        ? (deep !== false ? cloneNode(v, true) : v)
        : v;
  }
  // extra 里存着 hex 之类的原始写法，展开一层就够，值本身不会被改写
  if (node.extra) copy.extra = { ...node.extra };
  return copy;
}

/**
 * 判断节点是否为语句。
 * @param {object} n 待判断的节点
 * @returns {boolean} 是语句返回 true
 */
function isStatement(n) {
  return !!n && typeof n.type === 'string' && VISITOR_KEYS[n.type] !== undefined && (
    n.type.endsWith('Statement') || n.type === 'VariableDeclaration' || n.type === 'FunctionDeclaration' ||
    n.type === 'ClassDeclaration' || n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' ||
    n.type === 'ExportDefaultDeclaration' || n.type === 'ExportAllDeclaration' || n.type === 'BlockStatement' ||
    n.type === 'StaticBlock'
  );
}
t.isStatement = isStatement;

/**
 * 判断节点是否为表达式。
 * @param {object} n 待判断的节点
 * @returns {boolean} 是表达式返回 true
 */
function isExpression(n) {
  if (!n || typeof n.type !== 'string') return false;
  switch (n.type) {
    case 'Identifier': case 'StringLiteral': case 'NumericLiteral': case 'BooleanLiteral':
    case 'NullLiteral': case 'RegExpLiteral': case 'BigIntLiteral': case 'DecimalLiteral':
    case 'TemplateLiteral': case 'TaggedTemplateExpression': case 'ThisExpression': case 'Super':
    case 'ArrayExpression': case 'ObjectExpression': case 'FunctionExpression': case 'ArrowFunctionExpression':
    case 'ClassExpression': case 'UnaryExpression': case 'UpdateExpression': case 'BinaryExpression':
    case 'LogicalExpression': case 'AssignmentExpression': case 'ConditionalExpression': case 'CallExpression':
    case 'NewExpression': case 'MemberExpression': case 'SequenceExpression': case 'SpreadElement':
    case 'YieldExpression': case 'AwaitExpression': case 'ParenthesizedExpression': case 'MetaProperty':
    case 'Import': case 'OptionalCallExpression': case 'OptionalMemberExpression':
      return true;
    default:
      return false;
  }
}
t.isExpression = isExpression;

/**
 * 判断节点是否处于引用位置，供 ReferencedIdentifier 探测使用。
 * 实现上简化成标识符即引用，声明与属性键的排除交给 traverse 的 isRefByIdent。
 * @param {object} n 待判断的节点
 * @returns {boolean} 是引用返回 true
 */
function isReferenced(n) {
  return !!n && n.type === 'Identifier';
}
t.isReferenced = isReferenced;

t.getBindingIdentifiers = getBindingIdentifiers;
t.cloneNode = cloneNode;

export default t;
