/**
 * Pass：ESM 模块折叠（esmFold）。
 *
 * ESM 载荷里残留的模块结构是产物上最强的结构指纹：静态 import/export 声明、
 * 顶层绑定与顶层控制流在解密视图里一览无余（依赖图、公开接口、入口顺序都在）。
 * 本 pass 把整个模块改成这种形态：
 *
 *   const <alias> = await (async () => {
 *     const <ns0> = await import("spec0");
 *     ...
 *     return (function () { <原模块体；import 绑定改写为 ns 属性访问> })();
 *   })();
 *   const <f0> = <alias>.<local0>;
 *   ...
 *   export { <f0> as <exported0>, ... };
 *   export default <alias>.<default>;
 *
 * 顶层只剩一条 TLA 赋值与出口名（对外契约）。原模块体全部进同步 IIFE，后续
 * VM/控制流/字符串池/改名各 pass 正常接管——模块形状、import 说明符（进字符串池）、
 * 顶层声明与顶层控制流都从静态视图里消失。
 *
 * 说明符改走动态 import() 是刻意的：静态 import 必须写在模块顶层，留着它们
 * 折叠就只剩一半。动态 import 的说明符是普通字符串字面量，moduleBase 绝对化
 * 与字符串池收集都覆盖 CallExpression(Import) 形态。
 *
 * 语义口径（与打包器惯例一致，属于可接受的边界）：
 *   - 导出绑定在模块初始化结束时取快照：`export let` 之后被重赋值不再"活"；
 *   - import 绑定的活性保留：引用改写为命名空间属性访问（ns 的 getter 是活绑定），
 *     循环导入的 TDZ 行为与静态 import 一致；
 *   - `export {a} from 's'` / `export * from 's'`（带 source 的活再导出）无法折进
 *     标识符绑定，原语句保留在顶层（这是唯一的结构残留）；
 *   - 体内有顶层 await/for await 时不再拆出同步内层（await 无法进同步函数）：
 *     整个模块体直接进外层 async IIFE，体仍受扁平化/改名/字符串池保护，
 *     只是不进 VM 字节码；
 *   - 顶层类声明的静态块含裸 await/for await 时放弃整个折叠（那种 await 只能
 *     存在于模块顶层，搬进任何函数体都是语法错误），载荷保持原 ESM 形态，
 *     其余 pass 照常工作。
 */
import t from '../ast/types.js';
import rand from '../utils/rand.js';

const { uniqueName } = rand;

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
  'ClassMethod', 'ObjectMethod',
]);

/**
 * 块内（跳过嵌套函数体）是否存在裸 await 或 for await。
 * 静态块里的裸 await 只能出现在模块顶层，搬进函数体即语法错误，靠它判折叠放弃。
 */
function blockHasBareAwait(node) {
  let found = false;
  (function walk(n) {
    if (found || !n || typeof n.type !== 'string') return;
    if (FUNCTION_TYPES.has(n.type)) return;
    if (n.type === 'AwaitExpression') { found = true; return; }
    if (n.type === 'UnaryExpression' && n.operator === 'await') { found = true; return; }
    if (n.type === 'ForOfStatement' && n.await) { found = true; return; }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra') continue;
      const v = n[k];
      if (Array.isArray(v)) { for (const c of v) walk(c); }
      else if (v && typeof v.type === 'string') walk(v);
    }
  })(node);
  return found;
}

/** 顶层类声明的静态块是否含裸 await/for await。 */
function topClassBlocksAwait(clsNode) {
  for (const m of clsNode.body && clsNode.body.body || []) {
    if (m.type === 'StaticBlock' && blockHasBareAwait(m)) return true;
  }
  return false;
}

/** 模块体（不含 import/export 声明）是否存在顶层 await/for await。 */
function bodyHasTopLevelAwait(stmts, traverse) {
  let found = false;
  traverse({ type: 'Program', body: stmts, directives: [], sourceType: 'module' }, {
    Function(path) { path.skip(); },
    AwaitExpression() { found = true; },
    UnaryExpression(path) { if (path.node.operator === 'await') found = true; },
    ForOfStatement(path) { if (path.node.await) found = true; },
    noScope: true,
  });
  return found;
}

/**
 * 重写左值容器里对 import 绑定的写入点。
 * 导入绑定是只读的，写入在严格模式下运行期就抛 TypeError；改写成
 * `ns.prop = ...` 后对不可变命名空间属性写入同样抛错，语义保持一致。
 */
function rewriteLval(node, local, mk) {
  if (!node || typeof node.type !== 'string') return false;
  let hit = false;
  (function visit(n, parent, pkey, pidx) {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'Identifier') {
      if (n.name === local && parent) {
        if (pidx !== null) parent[pkey][pidx] = mk();
        else parent[pkey] = mk();
        hit = true;
      }
      return;
    }
    switch (n.type) {
      case 'AssignmentExpression': visit(n.left, n, 'left', null); break;
      case 'UpdateExpression': visit(n.argument, n, 'argument', null); break;
      case 'UnaryExpression': visit(n.argument, n, 'argument', null); break;
      case 'ForInStatement':
      case 'ForOfStatement': visit(n.left, n, 'left', null); break;
      case 'ObjectProperty':
        if (n.shorthand && n.value && n.value.type === 'Identifier' && n.value.name === local) {
          n.value = mk();
          n.shorthand = false;
          hit = true;
        } else visit(n.value, n, 'value', null);
        break;
      case 'ObjectPattern':
        for (const p of n.properties || []) {
          if (!p) continue;
          if (p.type === 'RestElement') visit(p.argument, p, 'argument', null);
          else if (p.type === 'ObjectProperty') visit(p, null, null, null);
        }
        break;
      case 'ArrayPattern':
        for (let i = 0; i < (n.elements || []).length; i++) {
          if (n.elements[i]) visit(n.elements[i], n, 'elements', i);
        }
        break;
      case 'AssignmentPattern': visit(n.left, n, 'left', null); break;
      case 'RestElement': visit(n.argument, n, 'argument', null); break;
      default: break;
    }
  })(node, null, null, null);
  return hit;
}

/** export default 的声明节点转成表达式位置可用的形态。 */
function toExpression(n) {
  if (!n) return n;
  if (n.type === 'FunctionDeclaration') {
    return { type: 'FunctionExpression', id: n.id, params: n.params, body: n.body, generator: n.generator, async: n.async };
  }
  if (n.type === 'ClassDeclaration') {
    return { type: 'ClassExpression', id: n.id, superClass: n.superClass, body: n.body };
  }
  return n;
}

/**
 * @param {object} ast - 已解析的 AST，就地修改
 * @param {object} options - 选项（读 identifierPrefix）
 * @param {object} ctx - 上下文 { traverse, t, usedNames, options, rng, sourceIsModule }
 * @returns {{folded:boolean, reason?:string, [k:string]:any}}
 */
export default function esmFold(ast, options, ctx) {
  const { traverse } = ctx;
  const prog = ast && ast.type === 'File' ? ast.program : ast;
  if (!prog || prog.type !== 'Program') return { folded: false, reason: 'no-program' };
  if (ctx.sourceIsModule !== true) return { folded: false, reason: 'not-module' };

  const body = prog.body;
  const importDecls = [];
  const namedExps = [];
  const defaultExps = [];
  const allExps = [];
  for (const s of body) {
    if (s.type === 'ImportDeclaration') importDecls.push(s);
    else if (s.type === 'ExportNamedDeclaration') namedExps.push(s);
    else if (s.type === 'ExportDefaultDeclaration') defaultExps.push(s);
    else if (s.type === 'ExportAllDeclaration') allExps.push(s);
  }
  if (!importDecls.length && !namedExps.length && !defaultExps.length && !allExps.length) {
    return { folded: false, reason: 'no-module-decls' };
  }

  for (const s of body) {
    if (s.type === 'ClassDeclaration' && topClassBlocksAwait(s)) {
      return { folded: false, reason: 'static-block-await' };
    }
  }

  const hasTLA = bodyHasTopLevelAwait(body, traverse);

  // 重建前的模块作用域快照：import 绑定（kind 'module'）的 referencePaths /
  // constantViolations 覆盖体里全部使用点与写入点，是引用改写的依据。
  let moduleBindings = null;
  traverse(ast, {
    Program(path) { moduleBindings = path.scope.bindings; },
  });

  const prefix = typeof options.identifierPrefix === 'string' && options.identifierPrefix ? options.identifierPrefix : '_0x';
  const used = ctx.usedNames;

  // 每个不同说明符一个命名空间变量（动态 import 的结果）；同一说明符的多个
  // import 声明共享同一个命名空间，动态 import 语句也只发一条（按首次出现顺序）
  const specNs = new Map();
  const importInfo = importDecls.map((decl) => {
    const spec = decl.source ? decl.source.value : '';
    let ns = null;
    if ((decl.specifiers || []).length > 0) {
      ns = specNs.get(spec);
      if (!ns) {
        ns = uniqueName(used, prefix);
        specNs.set(spec, ns);
      }
    }
    return { decl, spec, ns };
  });

  // 可折叠的导出名（带 source 的活再导出保留原语句）
  const exportNames = [];
  for (const exp of namedExps) {
    if (exp.source) continue;
    const d = exp.declaration;
    if (d) {
      if (t.isVariableDeclaration(d)) {
        for (const declr of d.declarations) {
          for (const n of Object.keys(t.getBindingIdentifiers(declr.id))) {
            exportNames.push({ local: n, exported: n, isDefault: false });
          }
        }
      } else if (d.id) {
        exportNames.push({ local: d.id.name, exported: d.id.name, isDefault: false });
      }
    }
    for (const spec of exp.specifiers || []) {
      // export { default as x }：local 指向默认导出
      exportNames.push({ local: spec.local.name, exported: spec.exported.name, isDefault: spec.local.name === 'default' });
    }
  }
  const defaultDecl = defaultExps.length ? defaultExps[defaultExps.length - 1].declaration : null;
  const hasExports = exportNames.length > 0 || defaultDecl !== null;

  // import 绑定 → 命名空间属性访问
  const bindingMap = new Map();
  importDecls.forEach((decl, di) => {
    const ns = importInfo[di].ns;
    if (!ns) return;
    for (const spec of decl.specifiers || []) {
      if (spec.type === 'ImportSpecifier') bindingMap.set(spec.local.name, { ns, prop: spec.imported.name });
      else if (spec.type === 'ImportDefaultSpecifier') bindingMap.set(spec.local.name, { ns, prop: 'default' });
      else if (spec.type === 'ImportNamespaceSpecifier') bindingMap.set(spec.local.name, { ns, prop: null });
    }
  });
  const mkRef = (info) => info.prop === null
    ? t.identifier(info.ns)
    : t.memberExpression(t.identifier(info.ns), t.identifier(info.prop), false);

  // 导出对象：键是出口名对应的本地名（字符串池与对象键编码后续接管），值是绑定本身。
  // 原顶层语句：import/export 声明出体，其余全部进函数体。
  // rtlib 内核留在顶层：VM 解释器按词法作用域引用它，搬进 IIFE 就断了。
  const kernel = new Set(ctx.rtKernelStmts || []);
  const bodyStmts = [];
  const retainedExports = [];
  // 默认导出的本地名：有 id 的函数/类用原名字（原模块作用域里本就有这个绑定），
  // 纯表达式补一个新名。本地 const 插在原 export default 语句的位置（函数声明
  // 原本从模块初始化开始就有效，插到体最前保持提升语义；类与表达式的超类/求值
  // 顺序依赖原位置），导出对象的 default 属性引用这个本地名。
  const defaultLocalNames = [];
  for (const s of body) {
    if (kernel.has(s)) continue;
    if (s.type === 'ImportDeclaration') continue;
    if (s.type === 'ExportNamedDeclaration') {
      if (s.source === null) {
        // export function/const/class：去掉 export 关键词，声明本身留在模块体
        if (s.declaration) bodyStmts.push(s.declaration);
        continue;
      }
      retainedExports.push(s);
      continue;
    }
    if (s.type === 'ExportDefaultDeclaration') {
      if (s.declaration) {
        const localName = s.declaration.id ? s.declaration.id.name : uniqueName(used, prefix);
        defaultLocalNames.push(localName);
        const declStmt = t.variableDeclaration('const', [t.variableDeclarator(
          t.identifier(localName),
          toExpression(s.declaration),
        )]);
        if (s.declaration.type === 'FunctionDeclaration') {
          bodyStmts.unshift(declStmt);
        } else {
          bodyStmts.push(declStmt);
        }
      }
      continue;
    }
    if (s.type === 'ExportAllDeclaration') { retainedExports.push(s); continue; }
    bodyStmts.push(s);
  }
  const defaultLocalName = defaultLocalNames.length ? defaultLocalNames[defaultLocalNames.length - 1] : null;

  // 导出对象：键是出口名对应的本地名（字符串池与对象键编码后续接管），值是绑定本身。
  // 本地绑定走简写且 key 与 value 指向同一节点（parser 对简写的约定形态）：
  // mangle 的 renameInPattern 按这个约定改名——value 换新名、key 保留属性名、
  // 简写展开成 key: value。两个独立节点都标 shorthand 是非法状态，生成器会把
  // 整个属性折叠成只剩 key，改名后的值直接丢掉（自检出未绑定引用）。
  const props = [];
  for (const e of exportNames) {
    if (e.isDefault) continue; // default 属性由 defaultDecl 统一给出
    const info = bindingMap.get(e.local);
    if (info) {
      // import 绑定：值是命名空间属性访问，必须显式 k: v
      props.push(t.objectProperty(t.identifier(e.local), mkRef(info), false, false));
    } else {
      const id = t.identifier(e.local);
      props.push(t.objectProperty(id, id, false, true));
    }
  }
  if (defaultDecl !== null && defaultLocalName !== null) {
    props.push(t.objectProperty(t.identifier('default'), t.identifier(defaultLocalName), false, false));
  }
  const exportObj = t.objectExpression(props);
  const directives = (prog.directives || []).map((d) => t.cloneNode(d, true));

  const aliasName = hasExports ? uniqueName(used, prefix) : null;
  const fNames = exportNames.map(() => uniqueName(used, prefix));
  const defaultFName = defaultDecl !== null ? uniqueName(used, prefix) : null;

  // 动态 import 语句（副作用导入不带绑定）；同一说明符只发一条，模块只评估一次
  const importStmts = [];
  {
    const seenSpec = new Set();
    for (const i of importInfo) {
      if (seenSpec.has(i.spec)) continue;
      seenSpec.add(i.spec);
      importStmts.push(i.ns !== null
        ? t.variableDeclaration('const', [t.variableDeclarator(
            t.identifier(i.ns),
            t.awaitExpression(t.callExpression(t.import(), [t.stringLiteral(i.spec)])),
          )])
        : t.expressionStatement(t.awaitExpression(t.callExpression(t.import(), [t.stringLiteral(i.spec)]))));
    }
  }

  // 出口别名与 export 语句
  const aliasStmts = exportNames.map((e, i) =>
    t.variableDeclaration('const', [t.variableDeclarator(t.identifier(fNames[i]),
      t.memberExpression(t.identifier(aliasName), t.identifier(e.local), false))])
  );
  if (defaultDecl !== null) {
    aliasStmts.push(t.variableDeclaration('const', [t.variableDeclarator(t.identifier(defaultFName),
      t.memberExpression(t.identifier(aliasName), t.identifier('default'), false))]));
  }
  const exportStmts = [];
  if (exportNames.length) {
    exportStmts.push(t.exportNamedDeclaration(null, exportNames.map((e, i) =>
      t.exportSpecifier(t.identifier(fNames[i]), t.identifier(e.exported))), null));
  }
  if (defaultDecl !== null) exportStmts.push(t.exportDefaultDeclaration(t.identifier(defaultFName)));

  const newTop = [];
  if (hasTLA) {
    // 顶层 await：整个模块体直接进外层 async IIFE（await 留在原位，不拆同步内层）
    const asyncBody = [...importStmts, ...bodyStmts];
    if (hasExports) asyncBody.push(t.returnStatement(exportObj));
    const asyncFn = t.arrowFunctionExpression([], t.blockStatement(asyncBody, directives), true);
    if (hasExports) {
      newTop.push(t.variableDeclaration('const', [t.variableDeclarator(t.identifier(aliasName),
        t.awaitExpression(t.callExpression(asyncFn, [])))]));
    } else {
      newTop.push(t.expressionStatement(t.awaitExpression(t.callExpression(asyncFn, []))));
    }
    newTop.push(...aliasStmts, ...exportStmts);
  } else if (importInfo.length) {
    // 无顶层 await 但有 import：await 留在 async IIFE，模块体在同步内层（可进 VM）
    const innerStmts = [...bodyStmts];
    if (hasExports) innerStmts.push(t.returnStatement(exportObj));
    const innerFn = t.functionExpression(null, [], t.blockStatement(innerStmts, directives));
    const asyncFn = t.arrowFunctionExpression([], t.blockStatement(
      [...importStmts, t.returnStatement(t.callExpression(innerFn, []))],
      [],
    ), true);
    if (hasExports) {
      newTop.push(t.variableDeclaration('const', [t.variableDeclarator(t.identifier(aliasName),
        t.awaitExpression(t.callExpression(asyncFn, [])))]));
    } else {
      newTop.push(t.expressionStatement(t.awaitExpression(t.callExpression(asyncFn, []))));
    }
    newTop.push(...aliasStmts, ...exportStmts);
  } else {
    // 无 import 无顶层 await：模块体直接进同步 IIFE，不需要 async
    const innerStmts = [...bodyStmts];
    if (hasExports) innerStmts.push(t.returnStatement(exportObj));
    const innerFn = t.functionExpression(null, [], t.blockStatement(innerStmts, directives));
    if (hasExports) {
      newTop.push(t.variableDeclaration('const', [t.variableDeclarator(t.identifier(aliasName),
        t.callExpression(innerFn, []))]));
    } else {
      newTop.push(t.expressionStatement(t.callExpression(innerFn, [])));
    }
    newTop.push(...aliasStmts, ...exportStmts);
  }

  // 改写 import 绑定的全部引用点与写入点（bodyStmts 里旧引用重建前已注册进
  // referencePaths；出口对象里 import 绑定的值在 props 构建时已按 bindingMap
  // 直接给出 ns 访问形态，不经过这里）。作用域收集的轻量 path 不带数组下标，
  // 参数/元素这类数组槽位要按 indexOf 定位再换。
  const replaceSlot = (parent, parentKey, node, newNode) => {
    const slot = parent[parentKey];
    if (Array.isArray(slot)) {
      const i = slot.indexOf(node);
      if (i === -1) return false;
      slot[i] = newNode;
      return true;
    }
    if (slot === node) {
      parent[parentKey] = newNode;
      return true;
    }
    return false;
  };
  let refsRewritten = 0;
  let writesRewritten = 0;
  for (const [local, info] of bindingMap) {
    const binding = moduleBindings ? moduleBindings[local] : null;
    if (!binding) continue;
    for (const ref of binding.referencePaths || []) {
      const n = ref.node;
      if (!n || n.type !== 'Identifier' || n.name !== local) continue;
      if (ref.parent && ref.parentKey !== null && replaceSlot(ref.parent, ref.parentKey, n, mkRef(info))) {
        refsRewritten++;
      }
    }
    for (const viol of binding.constantViolations || []) {
      if (viol && viol.node && rewriteLval(viol.node, local, () => mkRef(info))) writesRewritten++;
    }
  }

  // 内核保持原相对位置（原顶层最前）：先内核、再 TLA 赋值、最后出口
  const kernelStmts = body.filter((s) => kernel.has(s));
  prog.body = [...kernelStmts, ...newTop, ...retainedExports];
  prog.directives = [];

  return {
    folded: true,
    imports: importDecls.length,
    reexports: retainedExports.length,
    exports: exportNames.length + (defaultDecl !== null ? 1 : 0),
    namespaces: specNs.size,
    tla: hasTLA,
    refsRewritten,
    writesRewritten,
  };
}
