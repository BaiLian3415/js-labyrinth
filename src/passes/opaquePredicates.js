import t from '../ast/types.js';
import rand from '../utils/rand.js';
const { randInt, uniqueName, shuffle } = rand;
import rtlib from './rtlib.js';
import vmBoundary from './vmBoundary.js';
const { insideVmFunction } = vmBoundary;
/**
 * 不透明谓词注入。用恒真但静态无法直接证明的谓词包裹函数体内的真实语句。
 * 谓词有两个来源：本 pass 注入的 guard 局部变量，初值取自运行期熵，值域为
 * 非负 int32；以及函数真实参数，运行期取值未知。两者都让常量传播失效，判真
 * 必须先求出实际取值。guard 初值若写成构建期字面量，折叠器会一步把谓词化简
 * 为 true/false，静态阻力归零。注入量由 options.opaquePredicatesProbability
 * 控制，默认 1，每个函数最多包 options.opaquePredicatesMax 条，默认 8；
 * 下钻到一层深的块体时概率减半。
 */

// 可被谓词安全包裹的语句类型，声明与 label 除外
function isWrapable(stmt) {
  if (!stmt || typeof stmt !== 'object') return false;
  const type = stmt.type;
  return !(
    type === 'VariableDeclaration' ||
    type === 'FunctionDeclaration' ||
    type === 'ClassDeclaration' ||
    type === 'LabeledStatement' ||
    type === 'WithStatement'
  );
}

// 'number' 的 charCode 列表。运行期经 RT 字符表下标重组，产物里不再出现明文
// 字面量与 String.fromCharCode 调用点；无内核时回退旧形态。
const NUMBER_CHARS = [110, 117, 109, 98, 101, 114];

// 按 T[c] 形态取回掩码字符节点串，满足 m1^m2 === c，掩码逐构建随机
function tblChars(ctx) {
  const g = ctx && ctx.rt && ctx.rt.g;
  if (!g) return null;
  const nodes = NUMBER_CHARS.map((c) => {
    const m1 = 0x101 + randInt(0, 0xfefe);
    const m2 = m1 ^ c;
    // 每字符独立生成 G() 调用节点，节点共享会被 objectKeys 等原位改写复用
    return t.memberExpression(t.callExpression(t.identifier(g), []),
      t.binaryExpression('^', t.numericLiteral(m1), t.numericLiteral(m2)), true);
  });
  let expr = nodes[0];
  for (let i = 1; i < nodes.length; i++) expr = t.binaryExpression('+', expr, nodes[i]);
  return expr;
}

// 生成一个恒真谓词表达式。
// guard 为本 pass 注入的非 NaN 数字常量，live 为函数真实参数名。参数在运行
// 期取值未知，静态折叠器无法化简，且谓词在任意实参下恒真，构成依赖运行时的
// 不透明谓词。
// 复合形态把两个恒真原子用 && 或三元组合，反混淆器要折叠整棵组合树才能消解；
// 两原子取自不同族时没有共享子表达式可利用。
function makeTruePredicate(guard, live, ctx) {
  const g = t.identifier(guard);
  const eq = (l, r) => t.binaryExpression('===', l, r);
  // 运行时原子族，静态不可折叠。
  //
  // 除 case 0 外都要用 `typeof v !== 'number' || …` 短路包住。位运算
  // （`>>>` `|` `&` `^`）只对 Number 成立：参数装的是 BigInt 时
  // `v & 0xff` 会抛 "Cannot mix BigInt and other types"，装 Symbol 也会抛。
  // 而参数的实际类型在构建期无从得知（这正是"活值"的意义），所以必须先
  // 用 typeof 挡一道——非 Number 时短路为 true，既不抛也仍然恒真。
  //
  // 这个缺陷是 2026-09-20 用混淆器混淆自己时暴露的：ed25519.js 的签名参数
  // 是 BigInt，产物一加载就 TypeError。凡是用户代码里出现 BigInt 都会中招。
  const liveAtom = () => {
    const v = t.identifier(live);
    const bitwise = (expr) => t.logicalExpression('||',
      t.binaryExpression('!==', t.unaryExpression('typeof', t.identifier(live), true),
        t.stringLiteral('number')),
      expr);
    switch (randInt(0, 4)) {
      case 0: return eq(t.unaryExpression('typeof', v, true), t.unaryExpression('typeof', v, true));
      case 1: return bitwise(t.binaryExpression('>=',
        t.binaryExpression('>>>', v, t.numericLiteral(0)), t.numericLiteral(0))); // u32 ≥ 0
      case 2: return bitwise(t.binaryExpression('<=',
        t.binaryExpression('|', v, t.numericLiteral(0)), t.numericLiteral(0x7fffffff))); // int32 ≤ 2^31-1
      case 3: return bitwise(eq(
        t.binaryExpression('&', v, t.numericLiteral(0xff)),
        t.binaryExpression('&', v, t.numericLiteral(0xff)))); // 幂等且依赖 v
      default:
        // 异或自身恒等，且结果依赖 v
        return bitwise(eq(t.binaryExpression('^', v, t.numericLiteral(0xff00)),
          t.binaryExpression('^', v, t.numericLiteral(0xff00))));
    }
  };
  // 常量原子族，靠幂等与恒等成立
  const guardAtom = () => {
    switch (randInt(0, 7)) {
      case 0: return eq(g, g);
      case 1: return eq(t.binaryExpression('^', g, t.numericLiteral(0)), g);
      case 2: return eq(t.binaryExpression('|', g, t.numericLiteral(0)), g);
      case 3: return eq(t.binaryExpression('&', g, g), g);
      case 4: return eq(t.binaryExpression('>>>', g, t.numericLiteral(0)), g);
      case 5: {
        const n = tblChars(ctx) || t.callExpression(
          t.memberExpression(t.identifier('String'), t.identifier('fromCharCode'), false),
          NUMBER_CHARS.map((c) => t.numericLiteral(c)));
        return t.binaryExpression('===', t.unaryExpression('typeof', g, true), n);
      }
      case 6: return t.unaryExpression('!', t.binaryExpression('-', g, g));
      default: return eq(t.binaryExpression('*', g, t.numericLiteral(1)), g);
    }
  };
  // 复合形态，live 与 guard 组合，占 30%
  if (live && randInt(0, 9) < 3) {
    const a = liveAtom();
    const b = guardAtom();
    // 两种写法，&& 或三元恒选
    if (randInt(0, 1)) return t.logicalExpression('&&', a, b);
    return t.conditionalExpression(a, b, t.booleanLiteral(false));
  }
  // 单 live 原子，占 45%
  if (live && randInt(0, 1)) return liveAtom();
  // 其余落到单 guard 原子
  return guardAtom();
}

// 把语句包进恒真谓词控制的 if 块
function wrapStmt(guard, stmt, live, ctx) {
  return t.ifStatement(makeTruePredicate(guard, live, ctx), t.blockStatement([stmt]));
}

// 收集下钻目标：一层深的 if 分支与循环体里可包裹的语句
function collectNested(stmts, out) {
  for (const stmt of stmts) {
    if (!stmt || typeof stmt !== 'object') continue;
    if (t.isFunction(stmt)) continue;
    if (t.isIfStatement(stmt)) {
      if (t.isBlockStatement(stmt.consequent)) out.push(stmt.consequent.body);
      if (stmt.alternate && t.isBlockStatement(stmt.alternate)) out.push(stmt.alternate.body);
    } else if (t.isWhileStatement(stmt) || t.isDoWhileStatement(stmt) || t.isForStatement(stmt)) {
      if (t.isBlockStatement(stmt.body)) out.push(stmt.body.body);
    }
  }
}

export default function opaquePredicates(ast, options, ctx) {
  const { traverse, rng } = ctx;
  const used = ctx.usedNames;
  const probability = options.opaquePredicatesProbability !== undefined ? options.opaquePredicatesProbability : 1;
  const maxPerFunction = options.opaquePredicatesMax !== undefined ? options.opaquePredicatesMax : 8;
  let injected = 0;

  traverse(ast, {
    Function(path) {
      if (rtlib.isRtFn(ctx, path.node)) return; // RT 内核引导层不包谓词
      // VM 解释器骨架与其体内片段闭包整体跳过，契约见 vmBoundary.js，与
      // condition、logical、objectKeys、deadCode、debugProtection 一致。片段
      // 闭包按字节码步执行，谓词包裹会把一次性算术成本乘成每步成本，实测同
      // 配置不同种子在 0.78s 到 32s 之间离散，来源就是谓词落进热片段闭包。
      if (insideVmFunction(path)) return;
      const bodyPath = path.get('body');
      if (!bodyPath.isBlockStatement()) return; // 跳过表达式体箭头函数
      const stmts = bodyPath.node.body;
      if (stmts.length === 0) return;

      // guard 声明插在头部指令之后，保持 'use strict' 生效
      const guard = uniqueName(used, '_0x');
      let ins = 0;
      while (ins < bodyPath.node.body.length && bodyPath.node.body[ins].type === 'Directive') ins++;
      // guard 初值取自运行期熵，即时间戳低 31 位。写成构建期字面量时，折叠器
      // 传播该常量后 guard 族谓词一步化简为 true/false，静态阻力归零；初值在
      // 运行期取值未知时，判真要先求出 guard，纯常量传播失效。
      // 取低 31 位而不是 |0：(g>>>0)===g 这类谓词要求 g 非负，带符号的时间戳
      // 会让谓词为假，被包裹的真实语句不执行。
      bodyPath.node.body.splice(
        ins, 0,
        t.variableDeclaration('var', [t.variableDeclarator(t.identifier(guard),
          t.binaryExpression('&',
            t.binaryExpression('|',
              t.callExpression(
                t.memberExpression(t.identifier('Date'), t.identifier('now'), false), []),
              t.numericLiteral(0)),
            t.numericLiteral(0x7fffffff)))])
      );

      // 真实参数名，作为运行时谓词的活值来源，参数在函数体内必然已初始化
      const liveParams = (path.node.params || [])
        .map((p) => (p && p.type === 'Identifier' ? p.name : null))
        .filter(Boolean);
      const live = liveParams.length ? liveParams[randInt(0, liveParams.length - 1)] : null;

      // 顶层语句按概率包裹，条数上限为 maxPerFunction
      let count = 0;
      for (let i = 0; i < stmts.length && count < maxPerFunction; i++) {
        if (rng() > probability) continue;
        const stmt = stmts[i];
        if (!isWrapable(stmt)) continue;
        stmts[i] = wrapStmt(guard, stmt, live, ctx);
        count++;
      }

      // 下钻一层块体，以减半概率注入，同样计入 maxPerFunction
      if (count < maxPerFunction) {
        const nested = [];
        collectNested(stmts, nested);
        shuffle(nested);
        for (const body of nested) {
          if (count >= maxPerFunction) break;
          for (let i = 0; i < body.length && count < maxPerFunction; i++) {
            if (rng() > probability / 2) continue;
            if (!isWrapable(body[i])) continue;
            body[i] = wrapStmt(guard, body[i], live, ctx);
            count++;
          }
        }
      }
      injected += count;
    },
  });

  return { injected };
};
