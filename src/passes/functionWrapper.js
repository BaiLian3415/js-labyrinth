import t from '../ast/types.js';
/**
 * 函数包装器：把整个程序包进 IIFE，顶层变量就不再泄漏到全局。
 * 三种情况必须跳过。有 import/export 的 ESM 不能包；浏览器 script 的顶层 this 等于 window，
 * 包进 IIFE 后语义会变；顶层出现 module/exports/require 说明是 CommonJS 模块。
 * 三条判定共用同一次遍历。
 */

export default function functionWrapper(ast, options, ctx) {
  const { traverse } = ctx;

  // 一次遍历同时采集三种跳过信号，避免重复走 AST。
  let isModule = false;
  let hasThis = false;
  let hasCjs = false;
  traverse(ast, {
    ImportDeclaration() { isModule = true; },
    ExportNamedDeclaration() { isModule = true; },
    ExportDefaultDeclaration() { isModule = true; },
    ExportAllDeclaration() { isModule = true; },
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
