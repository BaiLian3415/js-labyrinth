import t from '../ast/types.js';
import rand from '../utils/rand.js';
import { uniqueCJKName } from '../utils/cjk.js';
import {
  createNamePool, parseNameStyle, isChineseNaming,
} from '../utils/naming.js';
const { uniqueName, RESERVED } = rand;

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
 * 命名策略由 `nameStyle` 选，共五档（与 obfuscator.io 的 identifierNamesGenerator
 * 同一套命名，便于横向对比产物）：`Mangled`、`Mangled-shuffled`、`Hexadecimal`、
 * `Dictionary`，外加本项目扩展的 `Chinese`。名池实现（四个拉丁/十六进制/词表生成器
 * 与汉字池的接入）都在 utils/naming.js，属性名重命名共用同一份——见那里的说明。
 * 各档共用"命名池"机制——长度递增、按引用次数从多到少发放、
 * 跳过已占用名与关键字、池空退回随机名，区别只在池子里装的是什么、以及发名顺序
 * 固不固定。
 */

// 名池实现（四个生成器 + normalizeNameDict + Dictionary 词表）已搬到 utils/naming.js：
// renameProperties 要用同一份，否则「选了 Hexadecimal、属性名却是 _0x 随机名」那种
// 自相矛盾会再次出现（那一档对属性而言曾是假的）。

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
  // reservedNames：用户手写的正则保留名单（^__webpack 之类），匹配的绑定名不改名
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
      targets.push({ name, binding, scope });
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
  // eval / with 污染域：直接 eval 能读到整条作用域链（含求值字符串里的名字），
  // with 让所在函数内的一切名字解析先过 with 对象。两者都让"按绑定改名"不再安全，
  // 而 mangle 是全仓库唯一没有这两道判定的 pass（vm/simplify/controlFlow/
  // opaquePredicates 都有）。2026-10-13 实测两类静默破坏：
  //   直接 eval：`function f(){var localv=10;eval('localv=...');}` —— 声明改名了，
  //     eval 串里的名字没改，运行期 ReferenceError（5/5 seed）；
  //   with：`with(o){hidden=hidden+1}` 的写点被跟着改名，写进了局部变量而不是
  //     with 对象的属性，原码 10|101 → 产物 11|100（静默算错，5/5 seed）。
  //
  // 实现：同一遍历内收集 with 节点与直接 eval 调用所在的作用域，污染其整条祖先链
  // （影响沿作用域链向上：外层名字在 with 内也可能先命中 with 对象，sloppy 直接
  // eval 能看到全局）。快照时照常收，改名前按 binding 所在 scope 的祖先链过滤——
  // 过滤在改名循环里做，不在 addScope 里做，因为 with/eval 节点可能出现在快照之后
  // 才被访问到（遍历自顶向下，函数体快照早于其内部的 with 节点）。
  // Scope 对象在单次构建内按节点缓存（__dshScope），同一遍历内身份一致；
  // Program 入口的 crawl() 发生在一切收集之前，不影响后续身份。
  // 间接 eval（(0,eval)()、obj.eval()）看不到调用方作用域，只认裸 eval(...)。
  // 名字叫 eval 的局部绑定（sloppy 下合法）会被误伤——fail-closed，多留几个原名。
  const tainted = new Set();
  const taintChain = (scope) => {
    let s = scope;
    while (s) { tainted.add(s); s = s.parent; }
  };
  const isTainted = (scope) => {
    let s = scope;
    while (s) {
      if (tainted.has(s)) return true;
      s = s.parent;
    }
    return false;
  };
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
  visitors.WithStatement = (path) => taintChain(path.scope);
  visitors.CallExpression = (path) => {
    const c = path.node.callee;
    if (c && c.type === 'Identifier' && c.name === 'eval') taintChain(path.scope);
  };
  visitors.noScope = true;

  traverse(ast, visitors);

  // 命名策略：各档都从命名池按序发放，池空时退回随机名。档名不存在（拼错、大小写
  // 不对、还是旧档名 random/short）一律回落到默认值，而不是抛异常或静默出一份
  // 没有约定的产物。档位的解析与名池的挑选都在 utils/naming.js（属性名重命名共用
  // 同一份，见那里的说明），这里不再自己判 chineseNames / Dictionary。
  const pool = createNamePool(options);
  const nextName = () => {
    for (;;) {
      const it = pool.next();
      if (it.done) return null;
      if (used.has(it.value) || RESERVED.has(it.value)) continue;
      used.add(it.value);
      return it.value;
    }
  };
  // 引用次数多的先发短名（池内按长度递增，权重排序才能让热名字落在短的那一档）。
  // 同权重保持原顺序：Mangled 档的发名与 seed 无关，其余三档由 seed 决定。
  const weight = (b) => ((b.referencePaths && b.referencePaths.length) || 0)
    + ((b.constantViolations && b.constantViolations.length) || 0);
  targets.sort((a, b) => weight(b.binding) - weight(a.binding));

  let renamed = 0;
  let skippedTainted = 0;
  for (const { name, binding, scope } of targets) {
    // eval/with 污染域内的绑定不改名（判据见上面的 taintRoots）。跳过的名字仍要
    // 进 used（下面的写回循环按 targets 全量登记），否则后置 pass 可能抽中同名。
    if (scope && isTainted(scope)) { skippedTainted++; continue; }
    if (reservedRe.length && reservedRe.some((re) => re.test(name))) continue;
    // 命名池用尽（词典档约四千个名字，>15 万个绑定才可能触发）时退回随机名，
    // 不静默复用名字——复用会撞名并改变语义。中文档的兜底仍是中文名，见
    // uniqueCJKName。
    const newName = nextName() || (isChineseNaming(options)
      ? uniqueCJKName(used, options.chineseDictionary || '')
      : uniqueName(used, prefix));
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
  return { renamed, skippedTainted };
};
