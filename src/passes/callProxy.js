import t from '../ast/types.js';
import parser from '../ast/parser.js';
const { parse } = parser;
import rand from '../utils/rand.js';
const { randInt, shuffle, uniqueName } = rand;
/**
 * 动态调用层。顶层函数之间的调用改写为经间接派发表转发，静态调用图消失。
 * 表不是构建期常量数组，运行期按时间戳密钥现场重排，掩码不能写成表达式，任何纯
 * 算术式掩码都能被折叠器按运算符代数规则消去。表内混入诱饵槽位，派发表中真假
 * 槽位外观一致，静态阅读难以区分哪些是真实函数。时机放在 functionWrapper 之后，
 * 此时顶层已是 IIFE 体且函数声明稳定；放在 mangle / integrityCheck 之前，因为 VM
 * 函数已编译为解释器，不在重写面内。只重写 callee 为根函数名的普通调用，模块绑定
 * 与 new 不动。
 */

export default function callProxy(ast, options, ctx) {
  if (options.callProxy === false) return { redirected: 0, tableSize: 0 };
  const program = ast.type === 'File' ? ast.program : ast;

  // 根作用域定位，functionWrapper 的产物是 IIFE 体。
  let rootBody = program.body;
  if (program.body.length === 1 && program.body[0].type === 'ExpressionStatement') {
    const ex = program.body[0].expression;
    if (ex.type === 'CallExpression' && ex.callee.type === 'FunctionExpression' &&
        ex.callee.body && ex.arguments.length === 0) {
      rootBody = ex.callee.body.body;
    }
  }

  // 候选集合取顶层函数声明名，排除模块导出绑定。
  const isModuleStmt = (s) =>
    s.type === 'ImportDeclaration' || s.type === 'ExportNamedDeclaration' ||
    s.type === 'ExportDefaultDeclaration' || s.type === 'ExportAllDeclaration';
  // 被 export 直接引用的名字不进表，保持模块接口稳定
  const exportedNames = new Set();
  for (const s of rootBody) {
    if (!isModuleStmt(s)) continue;
    if (s.type === 'ExportNamedDeclaration' && s.declaration) {
      if (s.declaration.type === 'FunctionDeclaration' && s.declaration.id) exportedNames.add(s.declaration.id.name);
      if (s.declaration.type === 'VariableDeclaration') {
        for (const d of s.declaration.declarations) {
          for (const k in t.getBindingIdentifiers(d.id)) exportedNames.add(k);
        }
      }
    }
  }
  const fnNames = new Set();
  for (const s of rootBody) {
    if (s.type === 'FunctionDeclaration' && s.id && s.id.name && !exportedNames.has(s.id.name)) {
      // 内核不经派发表，MUL 这类热原语在解释器骨架内被调用，改成槽位查找会
      // 破坏内核调用点与解释器骨架的结构对应
      if (ctx.rtNames && ctx.rtNames.has(s.id.name)) continue;
      fnNames.add(s.id.name);
    }
  }
  if (fnNames.size < 2) return { redirected: 0, tableSize: 0 };

  // 诱饵槽位，2 到 5 个指向永不调用的诱饵函数。表项真假要结合调用点求值
  // 才能区分，调用点下标含运行期密钥，静态无法折叠。
  const decoyCount = randInt(2, 5);
  const decoyNames = [];
  const decoyDecls = [];
  for (let i = 0; i < decoyCount; i++) {
    const dn = uniqueName(ctx.usedNames, '_0x');
    decoyNames.push(dn);
    // 诱饵函数体是无害的数值垃圾，永不执行，因为没有调用点指向它
    decoyDecls.push(t.functionDeclaration(t.identifier(dn), [], t.blockStatement([
      t.expressionStatement(t.binaryExpression('^',
        t.numericLiteral(randInt(1, 0xffff)),
        t.numericLiteral(randInt(1, 0xffff)))),
    ])));
  }

  // 槽位序表 T0 与构建期置换 D 及其逆。
  const slots = [...fnNames, ...decoyNames];
  shuffle(slots); // 真实函数与诱饵混排，槽位映射逐构建随机
  const N = slots.length;
  const slotOf = new Map();
  slots.forEach((n, i) => slotOf.set(n, i));

  const D = Array.from({ length: N }, (_, i) => i);
  shuffle(D);
  const Dinv = new Array(N);
  for (let i = 0; i < N; i++) Dinv[D[i]] = i;

  // 根级绑定名。
  const T0 = uniqueName(ctx.usedNames, '_0x');   // 槽位序函数数组，字面量
  const TBL = uniqueName(ctx.usedNames, '_0x');  // 运行期重排后的派发表
  const DVAR = uniqueName(ctx.usedNames, '_0x'); // 置换数组
  const KEY = uniqueName(ctx.usedNames, '_0x');  // 运行期密钥 R
  const IVAR = uniqueName(ctx.usedNames, '_0x'); // 构造循环变量

  const t0Decl = t.variableDeclaration('var', [
    t.variableDeclarator(t.identifier(T0),
      t.arrayExpression(slots.map((n) => t.identifier(n)))),
  ]);

  // 加载时构造：TBL[(i + R) % N] = T0[D[i]]（i 遍历全部槽位，是完整置换）
  // 密钥取时间戳低位，运行期取值静态不可知；`% N` 不引入负值（时间戳非负）。
  const buildSrc =
    'var ' + DVAR + '=[' + D.join(',') + '];' +
    'var ' + TBL + '=[];' +
    'var ' + KEY + '=(Date.now?Date.now():(new Date()).getTime())%' + N + ';' +
    'for(var ' + IVAR + '=0;' + IVAR + '<' + N + ';' + IVAR + '++){' +
    TBL + '[(' + IVAR + '+' + KEY + ')%' + N + ']=' + T0 + '[' + DVAR + '[' + IVAR + ']];' +
    '}';
  const buildDecls = parse(buildSrc, { sourceType: 'script' }).program.body;

  // 调用点下标 (Dinv[slot] + R) % N
  const indexExpr = (slot) => t.binaryExpression('%',
    t.binaryExpression('+',
      t.numericLiteral(Dinv[slot]),
      t.identifier(KEY)),
    t.numericLiteral(N));

  // 重写调用点，全树遍历并关闭 scope，纯按名字匹配。局部遮蔽靠保守候选集
  // 规避：局部声明遮蔽根函数时调用点其实指向局部，名字在集合内就会被错误
  // 重写，而是否无同名局部声明无法低成本静态判定，因此函数体内声明过候选
  // 同名参数或变量的，整个函数跳过重写。
  let redirected = 0;
  const shadowed = (fnNode) => {
    // 收集该函数体内 var、let、const、参数与函数声明的名字，只看浅层一层加
    // 嵌套一层。更深的嵌套遮蔽影响的是内层函数，对当前函数体的直接子表达式没有
    // 影响，两层已经够保守
    const names2 = new Set();
    const walk = (n, d) => {
      if (!n || typeof n !== 'object' || typeof n.type !== 'string') return;
      if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' ||
          n.type === 'ArrowFunctionExpression') {
        if (n.id) names2.add(n.id.name);
        for (const p of n.params || []) for (const k in t.getBindingIdentifiers(p)) names2.add(k);
        if (d >= 1) return; // 两层即可
      }
      if (n.type === 'VariableDeclarator' && n.id) {
        for (const k in t.getBindingIdentifiers(n.id)) names2.add(k);
      }
      for (const key of Object.keys(n)) {
        if (key === 'loc' || key === 'extra') continue;
        const v = n[key];
        if (Array.isArray(v)) for (const c of v) walk(c, d + (typeof n.type === 'string' && (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') ? 1 : 0));
        else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v, d);
      }
    };
    walk(fnNode, 0);
    return names2;
  };

  ctx.traverse(ast, {
    Function(p) {
      const fn = p.node;
      const shadows = shadowed(fn);
      // 遍历本函数体，不含嵌套函数，它们各自走自己的 visit
      const rewriteIn = (n) => {
        if (!n || typeof n !== 'object' || typeof n.type !== 'string') return;
        for (const key of Object.keys(n)) {
          if (key === 'loc' || key === 'extra') continue;
          const v = n[key];
          if (Array.isArray(v)) {
            for (let i = 0; i < v.length; i++) {
              const e = v[i];
              if (e && e.type === 'CallExpression' && e.callee.type === 'Identifier' &&
                  fnNames.has(e.callee.name) && !shadows.has(e.callee.name)) {
                e.callee = t.memberExpression(t.identifier(TBL), indexExpr(slotOf.get(e.callee.name)), true);
                redirected++;
              } else rewriteIn(e);
            }
          } else if (v && typeof v === 'object' && typeof v.type === 'string') {
            if (v.type === 'CallExpression' && v.callee.type === 'Identifier' &&
                fnNames.has(v.callee.name) && !shadows.has(v.callee.name)) {
              n[key] = t.callExpression(
                t.memberExpression(t.identifier(TBL), indexExpr(slotOf.get(v.callee.name)), true),
                v.arguments);
              redirected++;
            } else if (v.type !== 'FunctionDeclaration' && v.type !== 'FunctionExpression' && v.type !== 'ArrowFunctionExpression') {
              rewriteIn(v);
            }
          }
        }
      };
      rewriteIn(fn);
    },
    noScope: true,
  });

  if (!redirected) return { redirected: 0, tableSize: 0 };

  // 槽位序表、构造代码与诱饵函数声明插入根部，位置在 Directive 之后。
  let ins = 0;
  while (ins < rootBody.length && rootBody[ins].type === 'Directive') ins++;
  rootBody.splice(ins, 0, t0Decl, ...buildDecls, ...decoyDecls);

  return { redirected, tableSize: N, decoys: decoyNames.length };
};
