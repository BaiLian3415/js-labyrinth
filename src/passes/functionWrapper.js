import t from '../ast/types.js';

/**
 * 该节点是否在顶层（不在任何函数体内）。
 *
 * 顶层 await / 动态 import() 只在模块顶层合法；同样的语法进了函数就由那个函数
 * 自己的语义管（async 函数里的 await 谁都有），不构成「这是 ESM」的证据。
 */
function isTopLevel(path) {
  return !path.getFunctionParent();
}

/**
 * 函数包装器：把整个程序包进 IIFE，顶层变量就不再泄漏到全局。
 * 三种情况必须跳过。有 import/export 的 ESM 不能包；浏览器 script 的顶层 this 等于 window，
 * 包进 IIFE 后语义会变；顶层出现 module/exports/require 说明是 CommonJS 模块。
 * 三条判定共用同一次遍历。
 *
 * ESM 判定优先采信 ctx.sourceIsModule（解析期就定下的，见 obfuscate.js）。本 pass
 * 排在流水线中段，等它跑的时候 controlFlow、functionWrapper 之前的若干 pass 已经把
 * AST 改过：顶层 await 可能已被裹进 async 函数、动态 import() 可能已被搬走，此时
 * 现场扫描会把 ESM 误判成脚本，于是把模块包进 IIFE——模块里的顶层 await 落到函数
 * 作用域，产物加载即抛 SyntaxError: Unexpected reserved word。2026-10-02 实测。
 */

export default function functionWrapper(ast, options, ctx) {
  const { traverse } = ctx;

  // 解析期结论优先；没有这个字段（例如自测直接调本 pass）才退回现场扫描。
  let isModule = ctx.sourceIsModule === true;
  let hasThis = false;
  let hasCjs = false;
  traverse(ast, {
    ImportDeclaration() { isModule = true; },
    ExportNamedDeclaration() { isModule = true; },
    ExportDefaultDeclaration() { isModule = true; },
    ExportAllDeclaration() { isModule = true; },
    // 顶层 await 与动态 import() 也是模块才合法。ctx.sourceIsModule 缺失时才靠
    // 这两条兜底。自研 parser 对顶层 await 产出 UnaryExpression{operator:'await'}，
    // 两个形态都要认。
    UnaryExpression(path) {
      if (isModule) return;
      if (path.node.operator === 'await' && isTopLevel(path)) isModule = true;
    },
    AwaitExpression(path) {
      if (isModule) return;
      if (isTopLevel(path)) isModule = true;
    },
    Import(path) { if (isTopLevel(path)) isModule = true; },
    // import.meta 在经典脚本里非法（"Cannot use 'import.meta' outside a module"），
    // 所以它同样是「这是 ESM」的证据。
    MetaProperty(path) {
      if (isModule) return;
      const m = path.node.meta;
      if (m && m.type === 'Identifier' && m.name === 'import' && isTopLevel(path)) {
        isModule = true;
      }
    },
    ThisExpression(path) {
      if (isModule) return;
      const fn = path.getFunctionParent();
      if (!fn || fn.isProgram()) hasThis = true;
    },
    Identifier(path) {
      if (isModule || hasCjs) return;
      const name = path.node.name;
      if (name !== 'module' && name !== 'exports' && name !== 'require') return;
      const fn = path.getFunctionParent();
      if (fn && !fn.isProgram()) return; // 函数体内同名变量只是局部遮蔽，不构成 CommonJS 标记
      const parent = path.parentPath;
      if (name === 'require' && parent.isCallExpression() && parent.node.callee === path.node) {
        hasCjs = true;
      } else if ((name === 'module' || name === 'exports') &&
        parent.isMemberExpression() && parent.node.object === path.node) {
        hasCjs = true;
      }
    },
  });
  if (isModule) return { wrapped: false, reason: 'esm' };
  if (hasThis) return { wrapped: false, reason: 'top-level-this' };
  if (hasCjs) return { wrapped: false, reason: 'commonjs' };

  let wrapped = false;
  traverse(ast, {
    Program(path) {
      const body = path.node.body;
      if (body.length === 0) return;
      const directives = path.node.directives || [];
      const inner = directives.length > 0 ? directives.map((d) => t.cloneNode(d, true)) : [];

      // 指令要放进 blockStatement 的 directives 字段，不能混进 body。
      // 混进 body 时打印结果一样，但作用域构建按 directives 字段判断函数体
      // 是否严格模式，错放会让整个 IIFE 被当成非严格，块级函数声明的归属随之算错。
      const fn = t.functionExpression(null, [], t.blockStatement(body, inner));
      const iife = t.expressionStatement(t.callExpression(fn, []));
      path.node.body = [iife];
      path.node.directives = [];
      path.scope.crawl();
      wrapped = true;
    },
  });

  return { wrapped, reason: wrapped ? 'ok' : 'none' };
};
