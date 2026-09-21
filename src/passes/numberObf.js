import t from '../ast/types.js';
import rand from '../utils/rand.js';
const { randInt } = rand;
import vmBoundary from './vmBoundary.js';
const { insideVmFunction } = vmBoundary;
/**
 * 数值常量混淆：把整数字面量改写成求值恒等的算术/位运算表达式。
 *
 * 控制流与条件里的阈值、下标、长度、位掩码往往是最直接的可读性来源——
 * `if (x === 3)` 一眼看穿，`if (x === ((0x1a2b^0x1a28)))` 要折叠一整棵表达式
 * 树。本 pass 只做取值恒等的替换，不做任何数值近似，因此语义绝对保持。
 *
 * 形态每处独立随机（异或二项、异或三项、加法、减法、复合四项），操作数随机
 * 但恒等，同一份产物里同一个数字在不同位置也有不同写法，按"查找常量值"定位
 * 逻辑的静态手段失效。异或类形态限定在非负区间，避免 `0 ^ 0` 之外引入负值。
 *
 * 排除的上下文：
 *   - 非整数、绝对值小于 2（0 与 ±1 展开只会胀体积，且 0 有 -0 陷阱）
 *   - 超过 2^30（超大常量多半是掩码表或 ID，展开后精度与体积都不划算）
 *   - 键位/成员位的字面量（{1:x}、a.1 不能换成计算式）
 *   - 元素超过 16 的数组字面量（整表逐元素展开会让产物体积失控）
 *   - VM 已编译函数体与 RT 内核（契约见 vmBoundary.js，热原语体内按每字符
 *     调用计成本，多一层表达式调用会被放大）
 */

/** 恒等式生成：返回求值严格等于 V 的表达式节点。 */
function identity(V) {
  const forms = [];
  if (V >= 2) {
    // a ^ b，操作数与结果都落在 [0, 2^31)
    forms.push(() => {
      const a = randInt(1, 0x3fffffff);
      return t.binaryExpression('^', t.numericLiteral(a), t.numericLiteral(a ^ V));
    });
    // (a ^ b) ^ c，三层异或，折叠代价更高
    forms.push(() => {
      const a = randInt(1, 0x3fffffff);
      const b = randInt(1, 0x3fffffff);
      const c = (a ^ b) ^ V;
      return t.binaryExpression('^',
        t.binaryExpression('^', t.numericLiteral(a), t.numericLiteral(b)),
        t.numericLiteral(c));
    });
  }
  // a + b，同号相加，不会出现 -0
  forms.push(() => {
    const a = V > 0 ? randInt(0, V) : randInt(V, 0);
    return t.binaryExpression('+', t.numericLiteral(a), t.numericLiteral(V - a));
  });
  // a - b
  forms.push(() => {
    const b = randInt(1, 0x3fffffff);
    return t.binaryExpression('-', t.numericLiteral(V + b), t.numericLiteral(b));
  });
  if (V >= 2) {
    // 复合：(a ^ b) + (c - d)，两段各自恒等且和为 V
    forms.push(() => {
      const x1 = randInt(0, V);
      const x2 = V - x1;
      const a = randInt(1, 0x3fffffff);
      const d = randInt(1, 0x3fffffff);
      return t.binaryExpression('+',
        t.binaryExpression('^', t.numericLiteral(a), t.numericLiteral(a ^ x1)),
        t.binaryExpression('-', t.numericLiteral(x2 + d), t.numericLiteral(d)));
    });
  }
  return forms[randInt(0, forms.length - 1)]();
}

/** 是否可替换。字面量所在位置必须仍然容纳任意表达式。 */
function eligible(path, ctx) {
  const v = path.node.value;
  if (typeof v !== 'number' || !Number.isInteger(v)) return false;
  if (Math.abs(v) < 2 || Math.abs(v) > 0x3fffffff) return false;
  if (insideVmFunction(path)) return false;
  const p = path.parentPath;
  if (!p) return false;
  const n = p.node;
  const isKey = (p.isObjectProperty && p.isObjectProperty()) ||
    (p.isObjectMethod && p.isObjectMethod()) ||
    (p.isClassMethod && p.isClassMethod()) ||
    (p.isClassProperty && p.isClassProperty());
  if (isKey && n.key === path.node && !n.computed) return false;
  if (p.isMemberExpression && p.isMemberExpression() && n.property === path.node && !n.computed) return false;
  if (p.isArrayExpression && p.isArrayExpression() && n.elements.length > 16) return false;
  return true;
}

export default function numberObf(ast, options, ctx) {
  if (options.numberObfuscation === false) return { replaced: 0 };
  const { traverse, rng } = ctx;
  const threshold = options.numberObfuscationThreshold !== undefined
    ? options.numberObfuscationThreshold : 0.6;
  if (threshold <= 0) return { replaced: 0 };

  const targets = [];
  traverse(ast, {
    NumericLiteral(path) {
      if (!eligible(path, ctx)) return;
      if (rng() > threshold) return;
      targets.push(path);
    },
    noScope: true,
  });

  let replaced = 0;
  // 先收集后替换：identity() 会消耗 PRNG，遍历中改 AST 会让后续节点的
  // 随机数消耗序列跟着变，固定 seed 下不可复现
  for (const path of targets) {
    const v = path.node.value;
    path.replaceWith(identity(v));
    replaced++;
  }
  return { replaced };
}
