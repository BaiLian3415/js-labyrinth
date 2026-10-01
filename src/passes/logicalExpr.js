import t from '../ast/types.js';
import vmBoundary from './vmBoundary.js';
const { insideVmFunction } = vmBoundary;
/**
 * 逻辑表达式混淆。做五类等价变换：三元翻转 a ? b : c 变成 !a ? c : b，
 * 冗余取反 !!a 与 !a 混用，&& 和 || 在左操作数无副作用时转成三元，
 * De Morgan 把外层 ! 推进逻辑表达式内部，两侧都是原子的逻辑链交换求值顺序。
 * 这几类变换在布尔求值结果上恒等，也不会改变任何一侧的求值副作用次数。
 */

// 判定表达式能否安全重复求值
function isSideEffectFree(node) {
  return (
    t.isIdentifier(node) ||
    t.isLiteral(node) ||
    t.isUnaryExpression(node) && node.operator === '!' && isSideEffectFree(node.argument)
  );
}

/** 恒产出布尔值的二元运算符。 */
const BOOL_BINARY_OPS = new Set(['==', '===', '!=', '!==', '<', '>', '<=', '>=']);

/**
 * 表达式是否恒产出布尔值。
 *
 * 交换 `&&`/`||` 两侧只有在这一点成立时才安全：这两个运算符返回的是操作数的值，
 * 不是布尔值。`3 || 1` 得 3，交换成 `1 || 3` 得 1——值变了。原先的注释写"求值结果
 * 不变"，那是错的，也正是这个 pass 在 medium 下把 `v + (b || 1)` 改坏的原因
 * （b 为真时结果被换成右操作数）。两侧都是比较、`!` 或布尔字面量时，取值与真值
 * 都一致，交换才真的等价。
 *
 * @param {object} node AST 节点
 * @returns {boolean} 是否恒为布尔
 */
function isBooleanValued(node) {
  if (!node) return false;
  if (node.type === 'BooleanLiteral') return true;
  if (node.type === 'UnaryExpression') return node.operator === '!';
  if (node.type === 'BinaryExpression') return BOOL_BINARY_OPS.has(node.operator);
  return false;
}

export default function logicalExpr(ast, options, ctx) {
  const { traverse, rng } = ctx;
  let changed = 0;
  // 命中率默认 0.7，可用 logicalExpressionsThreshold 覆盖
  const threshold = options.logicalExpressionsThreshold !== undefined ? options.logicalExpressionsThreshold : 0.7;

  // VM 解释器骨架是 wasm 桥接的契约面，改写会让桶链比较和取指序列对不上，
  // 用 insideVmFunction 整段跳过。嵌套片段闭包里是用户代码，照常混淆。
  traverse(ast, {
    UnaryExpression(path) {
      if (insideVmFunction(path)) return;
      // De Morgan，!(a && b) 换成 !a || !b，!(a || b) 换成 !a && !b
      const n = path.node;
      if (n.operator !== '!') return;
      const arg = n.argument;
      if (!t.isLogicalExpression(arg)) return;
      if (rng() > threshold) return;
      const op = arg.operator;
      if (op !== '&&' && op !== '||') return;
      path.replaceWith(
        t.logicalExpression(
          op === '&&' ? '||' : '&&',
          t.unaryExpression('!', arg.left, true),
          t.unaryExpression('!', arg.right, true)
        )
      );
      path.skip(); // 换上去的新节点不再进 visitor，重复匹配会一直套下去
      changed++;
    },

    ConditionalExpression(path) {
      if (insideVmFunction(path)) return;
      if (rng() > threshold) return;
      const n = path.node;
      const roll = rng();
      if (roll < 0.4) {
        // 三成换成翻转形态，a ? b : c 变 !a ? c : b
        const neg = t.unaryExpression('!', n.test, true);
        path.replaceWith(t.conditionalExpression(neg, n.alternate, n.consequent));
      } else if (roll < 0.7) {
        // 另三成只给 test 套一层冗余双取反，分支不动
        const dd = t.unaryExpression('!', t.unaryExpression('!', n.test, true), true);
        path.replaceWith(t.conditionalExpression(dd, n.consequent, n.alternate));
      } else {
        // 剩下四成走单取反加翻转，和第一种写法同形，只用来打散分布
        const neg = t.unaryExpression('!', n.test, true);
        path.replaceWith(t.conditionalExpression(neg, n.alternate, n.consequent));
      }
      path.skip(); // 同上，避免替换结果被再次匹配
      changed++;
    },

    LogicalExpression(path) {
      if (insideVmFunction(path)) return;
      if (rng() > threshold) return;
      const n = path.node;
      if (n.operator === '??') return; // ?? 没有等价的交换或三元写法，nullish 分支会漏掉左值
      // 两侧都是原子、且都恒为布尔时交换短路顺序，取值与副作用才都不变。
      //
      // isBooleanValued 两条刻意放在 rng() 之后：rng() 的消耗序列因此与修复前
      // 完全一致，凡是本来就不会发生非法交换的产物仍逐字节不变，改动只落在真正
      // 出错的那部分组合上。
      if (isSideEffectFree(n.left) && isSideEffectFree(n.right) && rng() < 0.3
        && isBooleanValued(n.left) && isBooleanValued(n.right)) {
        path.replaceWith(t.logicalExpression(n.operator, n.right, n.left));
        path.skip();
        changed++;
        return;
      }
      // 转三元，左操作数要能重复求值，a && b 写成 a ? b : a
      if (!isSideEffectFree(n.left)) return;
      if (t.isLogicalExpression(n.right)) return; // 右操作数还是逻辑链时不展开，避免嵌套过深
      if (n.operator === '&&') {
        path.replaceWith(t.conditionalExpression(n.left, n.right, n.left));
      } else if (n.operator === '||') {
        path.replaceWith(t.conditionalExpression(n.left, n.left, n.right));
      } else {
        return;
      }
      path.skip();
      changed++;
    },
    noScope: true,
  });

  return { changed };
};
