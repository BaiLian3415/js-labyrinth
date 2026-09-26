import t from '../ast/types.js';
import vmBoundary from './vmBoundary.js';
const { insideVmFunction } = vmBoundary;
/**
 * 条件表达式混淆。做四类等价变换：比较运算符取反，把 a === b 写成 !(a !== b)，
 * 每个比较运算符都有对应的取反形态；双取反噪音，原运算符不动只在外层包 !!(a op b)，
 * 和取反形态混用，反混淆器要同时折叠 !! 和运算符翻转两套规则；if 分支交换，
 * if (a) {B} else {C} 写成 if (!a) {C} else {B}，分支体原样搬移；比较方向翻转，
 * a < b 写成 b > a。
 * 这些变换在 JavaScript 的求值语义下恒等：比较取反对任意类型和 NaN 都成立，
 * 方向翻转只在两侧求值互不影响时使用。
 */

const FLIP = {
  '===': '!==',
  '!==': '===',
  '>': '<=',
  '<': '>=',
  '>=': '<',
  '<=': '>',
  '==': '!=',
  '!=': '==',
};

// 方向翻转，严格序和宽松序共用一套映射
const SWAP = {
  '<': '>',
  '>': '<',
  '<=': '>=',
  '>=': '<=',
};

// 方向翻转的可用面只限标识符和字面量。成员访问可能触发 getter，
// 交换两侧会让 getter 的求值顺序反过来，抛错来源跟着变，所以排除在外。
// 标识符和字面量重复求值都没有副作用，交换是安全的。
function isPureAtomic(node) {
  return t.isIdentifier(node) || t.isLiteral(node);
}

export default function conditionObf(ast, options, ctx) {
  const { traverse, rng } = ctx;
  let changed = 0;
  let flippedBranches = 0;
  let swapped = 0;
  // 命中率默认 0.5，可用 conditionObfuscationThreshold 覆盖
  const threshold = options.conditionObfuscationThreshold !== undefined ? options.conditionObfuscationThreshold : 0.5;

  // 比较表达式统一走一个 visitor，随机在取反和方向翻转之间二选一。
  // VM 解释器骨架是取指与分发的契约面，桶链比较和取指序列的结构形态
  // 不能被改写，整段跳过；嵌套片段闭包里是用户代码，照常混淆。
  traverse(ast, {
    BinaryExpression(path) {
      if (insideVmFunction(path)) return;
      const n = path.node;
      // 外层已套 ! 的比较直接跳过，重复处理只会越套越深
      const parent = path.parentPath;
      if (parent.isUnaryExpression({ operator: '!' })) return;
      const flip = FLIP[n.operator];
      const swapOp = SWAP[n.operator];
      if (!flip && !swapOp) return;

      // 两侧都是原子时先试方向翻转，约三成半的概率走这条
      if (swapOp && isPureAtomic(n.left) && isPureAtomic(n.right) && rng() < 0.35) {
        path.replaceWith(t.binaryExpression(swapOp, n.right, n.left));
        path.skip();
        swapped++;
        return;
      }

      // 取反形态：一半写成 !(flip(a,b))，把比较运算符翻到反面再整体取反，
      // 另一半只在外层套 !!，运算符原样保留。两种写法混着用。
      if (!flip) return;
      if (rng() > threshold) return;
      const useDoubleNot = rng() < 0.5;
      path.replaceWith(useDoubleNot
        ? t.unaryExpression('!', t.unaryExpression('!', n, true), true)
        : t.unaryExpression('!', t.binaryExpression(flip, n.left, n.right), true));
      path.skip();
      changed++;
    },

    // if 分支交换，只在 else 存在时做。else 缺失时不交换，
    // 避免生成空分支这种死形状。
    IfStatement(path) {
      if (insideVmFunction(path)) return;
      const n = path.node;
      if (!n.alternate) return;
      if (rng() > threshold) return;
      // test 已经被 ! 包住就先把这层剥掉，交换时再决定要不要加回去，
      // 这样不会出现 !! 叠在同一处
      let test = n.test;
      let negated = false;
      if (t.isUnaryExpression(test) && test.operator === '!') {
        test = test.argument;
        negated = true;
      }
      n.test = negated ? test : t.unaryExpression('!', test, true);
      const tmp = n.consequent;
      n.consequent = n.alternate;
      n.alternate = tmp;
      flippedBranches++;
    },
    noScope: true,
  });

  return { changed, flippedBranches, swapped };
};
