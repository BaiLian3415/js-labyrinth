import t from '../ast/types.js';
import rand from '../utils/rand.js';
const { uniqueName, shuffle, RESERVED } = rand;

/**
 * 标识符重命名。
 *
 * 用 Babel 的作用域分析取出每个绑定，生成全局唯一的随机名，再直接改写所有
 * 声明与引用节点的 name。
 *
 * 不走 scope.rename，因为它每次调用都会对整棵作用域树做一次 crawl，复杂度是
 * O(n^2)，绑定一多就慢得离谱。这里改为先快照各作用域的 bindings，再对每个绑定
 * 直接改写声明标识符、referencePaths 与 constantViolations 的 name。由于生成的
 * 名字全局唯一，不会与任何已有名字冲突，所以可以只改节点而不维护作用域图。代价
 * 是不能再依赖 Babel 的绑定一致性，后续必须有自校验兜底，否则漏改的引用不会被
 * 任何环节发现。
 *
 * arguments、import 的模块绑定以及被 export 的本地名字一律跳过，对外接口保持
 * 不变。
 *
 * 命名策略由 `nameStyle` 选：默认 `random`（上面的随机混族长名，防指纹优先），
 * `short` 走下面的 minifier 式短名池（体积优先，见那里的说明）。
 */

/**
 * minifier 式短名池（`nameStyle: 'short'`）。
 *
 * 随机名平均 8~11 字符（`_0x7e925a43e`、CJK 字形、`c0…` 前缀各不相同），改名
 * 反而把产物撑大——实测 src/obfuscate.js 关掉 mangle 比开着小 4.9 KB，而 terser
 * 同输入的产物只有"纯压缩"配置的 42%。这里改成 minifier 的取法：
 *
 *   - 长度递增：a…Z$_ → aa… → aaa…（54 个单字符起步，小文件全用单字符）；
 *   - 每档字母顺序**逐构建打乱**：不是固定的 a/b/c 序列——同 seed 可复现、换 seed
 *     换一套字母，不给"产物必然从 a 开始"的可识别指纹；
 *   - **按引用次数从多到少发放**：最常出现的绑定拿最短的名，这是压缩率的关键
 *     （terser 同款策略）；
 *   - 全局唯一、不复用作用域：本 pass 直接改节点名、不维护作用域图，要复用就得
 *     做冲突分析，得不偿失；
 *   - `used` 与关键字一律跳过：`used` 里既有源码绑定名，也有**未声明的全局引用**
 *     （jQuery 的 `$`、`_` 之类），不跳过就会用同名局部变量把全局遮蔽掉。
 */
const SHORT_ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ$_';

function* shortNames() {
  const tier = () => shuffle(SHORT_ALPHA.split(''));
  const a1 = tier();
  const a2 = [tier(), tier()];
  const a3 = [tier(), tier(), tier()];
  yield* a1;
  for (const x of a2[0]) for (const y of a2[1]) yield x + y;
  for (const x of a3[0]) for (const y of a3[1]) for (const z of a3[2]) yield x + y + z;
}

function collectExportedFromProgram(path, exported) {
  const node = path.node;
  if (node.type === 'ExportNamedDeclaration') {
    const d = node.declaration;
    if (d) {
      if (t.isVariableDeclaration(d)) {
        for (const decl of d.declarations) {
          const ids = t.getBindingIdentifiers(decl.id);
          for (const k of Object.keys(ids)) exported.add(k);
        }
      } else if (t.isFunctionDeclaration(d) || t.isClassDeclaration(d)) {
        if (d.id) exported.add(d.id.name);
      }
    }
    for (const spec of node.specifiers || []) {
      exported.add(spec.local.name);
    }
  }
  // ExportDefaultDeclaration 不约束本地名
}

// 就地遍历展开解构 pattern 里的 shorthand，不建 NodePath。只处理 ObjectPattern
// 与赋值解构目标里的 ObjectProperty，对象字面量的简写属性保持原样，它的 key 与
// value 同名是语义要求。
function expandShorthands(ast) {
  (function walk(node, parent, keyName) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], node, i);
      return;
    }
    if (typeof node.type !== 'string') return;
    if (node.type === 'ObjectProperty' && node.shorthand) {
      // 只有解构 pattern 场景需要展开，包括父级是 ObjectPattern，以及赋值
      // 解构目标由 _toAssignable 生成的 ObjectPattern
      const inPattern = parent && parent.type === 'ObjectPattern';
      if (inPattern && node.key === node.value && node.value.type === 'Identifier') {
        node.value = t.identifier(node.value.name);
        node.shorthand = false;
      } else if (inPattern && node.value && node.value.type === 'AssignmentPattern' &&
        node.value.left === node.key && node.key.type === 'Identifier') {
        node.value = t.assignmentPattern(t.identifier(node.key.name), node.value.right);
        node.shorthand = false;
      }
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra') continue;
      const v = node[k];
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) walk(v[i], node, k);
      } else if (v && typeof v === 'object' && typeof v.type === 'string') {
        walk(v, node, k);
      }
    }
  })(ast, null, null);
}

// 递归改写解构 pattern 里的 Identifier，覆盖 ObjectPattern、ArrayPattern、
// AssignmentPattern 与 RestElement
function renameInPattern(node, oldName, newName) {
  if (!node) return;
  const type = node.type;
  if (type === 'Identifier') {
    if (node.name === oldName) node.name = newName;
    return;
  }
  if (type === 'ObjectProperty') {
    // shorthand 的 key 是属性名，对外生效，不能改名。parser 对简写会生成
    // key 与 value 指向同一 Identifier 节点的情况，所以改名前必须把 value 换成
    // 克隆节点，让 key 保留原属性名，value 单独承接新名，简写随之展开成
    // key: value 形式。
    if (node.shorthand && node.key === node.value && node.value.type === 'Identifier' &&
        node.value.name === oldName) {
      node.value = t.identifier(newName);
      node.shorthand = false;
      return;
    }
    if (node.shorthand && node.value && node.value.type === 'AssignmentPattern' &&
        node.value.left === node.key && node.value.left.type === 'Identifier' &&
        node.value.left.name === oldName) {
      node.value = t.assignmentPattern(t.identifier(newName), node.value.right);
      node.shorthand = false;
      return;
    }
    renameInPattern(node.value, oldName, newName);
    return;
  }
  if (type === 'ObjectPattern' || type === 'ArrayPattern' || type === 'AssignmentPattern' || type === 'RestElement') {
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra') continue;
      const v = node[k];
      if (Array.isArray(v)) {
        for (const c of v) renameInPattern(c, oldName, newName);
      } else if (v && typeof v === 'object' && typeof v.type === 'string') {
        renameInPattern(v, oldName, newName);
      }
    }
  }
}

// 改写一个写入点的 name
function renameViolation(path, oldName, newName) {
  if (!path || !path.node) return;
  const n = path.node;
  if (path.isIdentifier()) {
    if (n.name === oldName) n.name = newName;
  } else if (path.isVariableDeclarator()) {
    // 重声明的 var，例如第二个 for(var x=0;...)，改 id，它可能是解构 pattern
    if (n.id) renameInPattern(n.id, oldName, newName);
  } else if (path.isMemberExpression()) {
    const obj = n.object;
    if (obj && obj.type === 'Identifier' && obj.name === oldName) obj.name = newName;
  } else if (path.isAssignmentExpression()) {
    // 左值可能是 Identifier，也可能是 [a] = ... 或 ({a} = ...) 这类解构 pattern
    renameInPattern(n.left, oldName, newName);
  } else if (path.isUpdateExpression()) {
    const a = n.argument;
    if (a && a.type === 'Identifier' && a.name === oldName) a.name = newName;
  } else if (path.isUnaryExpression()) {
    const a = n.argument;
    if (a && a.type === 'Identifier' && a.name === oldName) a.name = newName;
  } else if (path.isForXStatement()) {
    // for (x of arr) 与 for (x in obj) 的 left 可能是 Identifier、pattern
    // 或 VariableDeclaration
    const l = n.left;
    if (l && l.type === 'VariableDeclaration') {
      for (const d of l.declarations) renameInPattern(d.id, oldName, newName);
    } else {
      renameInPattern(l, oldName, newName);
    }
  } else if (n.type === 'ArrayPattern' || n.type === 'ObjectPattern' ||
             n.type === 'AssignmentPattern' || n.type === 'RestElement' || n.type === 'ObjectProperty') {
    // 解构赋值的目标容器，递归改写其中的绑定标识符
    renameInPattern(n, oldName, newName);
  }
}

export default function mangle(ast, options, ctx) {
  const { traverse } = ctx;
  const used = new Set(ctx.usedNames);
  const prefix = options.identifierPrefix || '_0x';
  // reservedNames：匹配的绑定名不改名（正则，供跨库 / 外部契约保留）
  const reservedRe = (options.reservedNames || [])
    .map((s) => { try { return new RegExp(s); } catch (e) { return null; } })
    .filter(Boolean);

  // 预处理，先展开解构 pattern 里的 shorthand。parser 对简写会生成 key 与
  // value 指向同一节点的情况，直接改 value 名会连带污染属性名，先分离成
  // key: value 显式形式，后续改名才安全。
  expandShorthands(ast);

  const exported = new Set();

  // 快照所有作用域的绑定，靠遍历作用域节点完成，不依赖 childScopes
  const targets = [];
  const seenScopes = new Set();
  const addScope = (scope) => {
    if (!scope || seenScopes.has(scope)) return;
    seenScopes.add(scope);
    const bindings = scope.bindings || {};
    for (const name of Object.keys(bindings)) {
      const binding = bindings[name];
      if (name === 'arguments') continue;
      if (binding.kind === 'module') continue;
      if (exported.has(name)) continue;
      // 内核根绑定保持注入名，stringArray 解码器、verifier、哨兵等都要按名字
      // 跨 pass 引用内核，改名会让后注入的源码串断掉引用。内核函数体内部的局部
      // 名照常重命名
      if (ctx.rtNames && ctx.rtNames.has(name)) continue;
      // 各 pass 显式登记的短名注入绑定，比如 stringArray 解码 IIFE 的内部名与
      // 访问器名，同样保持注入名。它们每构建随机且已进 used 防撞，改名只会让
      // 每个引用处膨胀成 7 到 24 字节的随机名
      if (ctx.keepNames && ctx.keepNames.has(name)) continue;
      targets.push({ name, binding });
    }
  };

  // 一次遍历同时收集 exported 名并快照各作用域绑定。函数声明的提升绑定注册在最近
  // 的包裹作用域上，函数体的直接语句在 function scope，块内声明在块 scope，var
  // 声明则经 findFunctionScope 提升。所以除 Program 与 Function 外还必须快照全部
  // 块级作用域，否则 IIFE 体与块内的顶层函数名会漏改，functionWrapper 把用户顶层
  // 函数包进 IIFE 之后就正好触发这种情况。
  const BLOCK_SCOPE_TYPES = new Set([
    'BlockStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement',
    'SwitchStatement', 'CatchClause', 'ClassBody', 'StaticBlock',
  ]);
  // 先全树预扫描 exported 名，addScope 快照必须已经排除 export 声明的绑定，
  // 否则 export function foo 的 foo 会被改名，消费者访问 m.foo 就断链了。
  const collectAllExports = (root) => {
    (function walk(n) {
      if (!n || typeof n !== 'object' || typeof n.type !== 'string') return;
      if (n.type === 'ExportNamedDeclaration') {
        collectExportedFromProgram({ node: n }, exported);
      }
      for (const k of Object.keys(n)) {
        if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra') continue;
        const v = n[k];
        if (Array.isArray(v)) { for (const c of v) walk(c); }
        else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v);
      }
    })(root);
  };
  collectAllExports(ast.type === 'File' ? ast.program : ast);

  // 块级作用域的访问器直接由 BLOCK_SCOPE_TYPES 生成：两处各写一份清单的话，
  // 新增节点类型时很容易只改一边，漏掉的作用域里的绑定就不会被改名。
  const visitors = {};
  for (const type of BLOCK_SCOPE_TYPES) {
    visitors[type] = (path) => addScope(path.scope);
  }
  visitors.Program = (path) => {
    // 强制从根重建作用域树。中间 pass 用 replaceWith 改过节点却没有重新
    // crawl，scope.referencePaths 还指向已经脱离的旧节点，不重建就会漏改，
    // 之后由自检报出未绑定引用。
    path.scope.crawl();
    addScope(path.scope);
  };
  visitors.ExportNamedDeclaration = (path) => collectExportedFromProgram(path, exported);
  visitors.Function = (path) => addScope(path.scope);
  visitors.noScope = true;

  traverse(ast, visitors);

  // 命名策略：random（默认，随机混族长名）或 short（minifier 式短名池）
  const pool = options.nameStyle === 'short' ? shortNames() : null;
  const nextShort = () => {
    for (;;) {
      const it = pool.next();
      if (it.done) return null;
      if (used.has(it.value) || RESERVED.has(it.value)) continue;
      used.add(it.value);
      return it.value;
    }
  };
  if (pool) {
    // 引用次数多的先发短名。同权重保持原顺序，产物仍然只由 seed 决定。
    const weight = (b) => ((b.referencePaths && b.referencePaths.length) || 0)
      + ((b.constantViolations && b.constantViolations.length) || 0);
    targets.sort((a, b) => weight(b.binding) - weight(a.binding));
  }

  let renamed = 0;
  for (const { name, binding } of targets) {
    if (reservedRe.length && reservedRe.some((re) => re.test(name))) continue;
    // 短名池用尽（>15 万个绑定，实际不可达）时退回随机名，不静默复用名字
    const newName = pool ? (nextShort() || uniqueName(used, prefix)) : uniqueName(used, prefix);
    try {
      // 声明点。同一条绑定的重复声明（var 重复、Annex B 提升上来的块级函数
      // 声明）都要改，漏掉任何一处都会留下旧名，运行期读到的就不是同一个绑定
      if (binding.identifier) binding.identifier.name = newName;
      for (const extra of binding.declarationIds || []) {
        if (extra && extra.name === name) extra.name = newName;
      }
      // 所有引用点
      for (const ref of binding.referencePaths || []) {
        if (ref && ref.node && ref.node.name === name) ref.node.name = newName;
      }
      // 写入点
      for (const viol of binding.constantViolations || []) {
        renameViolation(viol, name, newName);
      }
      renamed++;
    } catch (e) {
      // 个别异常情况跳过该名字
    }
  }
  // 最终名字全集写回 ctx.usedNames：本 pass 之后还有 integrityCheck 等 pass
  // 靠 uniqueName 取新名，若改名结果只记在局部副本里，后置 pass 就可能抽中与
  // 本 pass 改出的名字相同的标识符。同名 var 赋值会覆盖同名函数声明的绑定值
  //（同一作用域里是同一个绑定）——integrityCheck 的哨兵 peek 变量一旦撞上根级
  // 函数声明名，头部注册数组就解析到 peek 闭包而非被哈希的函数，哈希假失配
  // 直接把干净产物投毒（2026-09-25 seed4/medium 实测踩中）。旧名一并登记：
  // 改名失败的绑定仍以旧名存在于产物，同样不能让后置 pass 撞上。
  for (const { name } of targets) ctx.usedNames.add(name);
  for (const n of used) ctx.usedNames.add(n);
  return { renamed };
};
