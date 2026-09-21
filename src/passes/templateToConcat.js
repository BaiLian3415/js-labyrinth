import t from '../ast/types.js';
/**
 * 把带插值的模板字面量降级成字符串拼接，`a${x}b` 会变成 '' + 'a' + x + 'b'。
 * 产物里不再出现反引号，拆出来的字符串片段随后由 stringArray 收集加密。
 * 不带插值的模板串交给 stringArray。
 */

export default function templateToConcat(ast, options, ctx) {
  const { traverse } = ctx;
  let changed = 0;

  traverse(ast, {
    TemplateLiteral(path) {
      const n = path.node;
      if (n.expressions.length === 0) return; // 无插值，留给 stringArray
      if (path.parentPath.isTaggedTemplateExpression()) return; // tagged template 要保住 tag 语义

      const parts = [];
      const quasis = n.quasis;
      for (let i = 0; i < quasis.length; i++) {
        const q = quasis[i].value;
        const cooked = q.cooked !== undefined && q.cooked !== null ? q.cooked : q.raw;
        if (cooked !== '') parts.push(t.stringLiteral(cooked));
        if (i < n.expressions.length) parts.push(n.expressions[i]);
      }

      // 从 '' + 起头，模板串总是返回字符串，拼出来也必须还是字符串
      let expr = t.stringLiteral('');
      for (const p of parts) {
        expr = t.binaryExpression('+', expr, p);
      }
      path.replaceWith(expr);
      path.skip();
      changed++;
    },
    noScope: true,
  });

  return { changed };
};
