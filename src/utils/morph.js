/**
 * 形态多态小件：同一语义的多种 AST 写法，逐构建随机挑一种。
 *
 * 使用铁律（调用方必须逐条保证，测试只验统计出现率 + 端到端语义）：
 *   · 只用在**生成的机器代码**上（VM 动作体、状态机骨架、解码模板），不动用户 AST。
 *   · 凡是涉及求值顺序/次数的一律要求操作数纯（标识符、字面量），有副作用的
 *     取指、调用、成员写一律不进这些 helper。
 *   · 全部随机经由 utils/rand（seeded），同 seed 产物逐字节可复现。
 */

import t from '../ast/types.js';
import rand from './rand.js';
const { randInt } = rand;

/**
 * 声明种类 const/let 二选一。
 *
 * 等价条件：同一块作用域内先写后读（所有暂存声明都带初值，读一定在写之后）。
 * var 不在候选里：var 提升到函数作用域，跨 case 共用同一绑定；而 const/let
 * 都是块作用域，在"声明即初始化、读在写后"的前提下逐位一致。万一哪处违反
 * 前提，let/const 会抛错（fail-closed），var 反而静默算错——所以只敢在二者里选。
 */
export function declKind() {
  return randInt(0, 1) === 0 ? 'const' : 'let';
}

/**
 * 二元比较/交换算子的 Yoda 式：a===b ↔ b===a。
 *
 * 等价条件：op ∈ {===, !==}（无类型转换、无短路），且两侧纯（标识符/字面量）。
 * 加减乘与位运算的交换律形态不在这里——那些要同时证明"无字符串拼接、无溢出
 * 语义差"，留给各 pass 自己的上下文去做，这里只收恒等价的比较。
 */
export function yodaEq(l, r) {
  return randInt(0, 1) === 0
    ? t.binaryExpression('===', l, r)
    : t.binaryExpression('===', r, l);
}

/**
 * 数值字面量十进制/十六进制二选一。只收非负整数（负数走一元负号，不在这里拼）。
 * 生成器认 extra.raw（generator _numericLiteral 优先原文），parser 侧 hex 早有支持。
 */
export function numLit(n) {
  const node = t.numericLiteral(n);
  if (Number.isInteger(n) && n >= 0 && randInt(0, 1) === 0) {
    node.extra = { raw: '0x' + n.toString(16) };
  }
  return node;
}

/**
 * 恒真无条件循环 while(true) ↔ for(;;)。两者都是"无条件永远循环"，逐位等价，
 * 且都不引入 break/continue 语义差（循环体原样搬运）。
 */
export function loopTrue(body) {
  return randInt(0, 1) === 0
    ? t.whileStatement(t.booleanLiteral(true), body)
    : t.forStatement(null, null, null, body);
}

/**
 * 空返回 return; ↔ return void 0;。都是"返回 undefined"，恒等。
 * 只用在解释器收尾这类"无值返回"位置，不碰带返回值的 return。
 */
export function retVoid() {
  return randInt(0, 1) === 0
    ? t.returnStatement(null)
    : t.returnStatement(t.unaryExpression('void', t.numericLiteral(0), true));
}

/**
 * 成员点访问 a.b ↔ a["b"]。等价条件：name 是普通数据属性名（length/push/pop
 * 这类数组自有方法），调用方不传 __proto__/constructor/prototype。
 * renameProperties 对两种形态一致处理（uses/defs 双收），可放心混用。
 */
export function memberDot(obj, name) {
  return randInt(0, 1) === 0
    ? t.memberExpression(obj, t.identifier(name), false)
    : t.memberExpression(obj, t.stringLiteral(name), true);
}

/**
 * 关系比较方向翻转：a<b ↔ b>a、a<=b ↔ b>=a。
 *
 * 等价条件：op ∈ {<,>,<=,>=}（关系比较按规范对称定义，翻转恒等），且两侧纯
 * （标识符/字面量/纯数据成员读：求值顺序变了但求值结果不变）。有调用、更新、
 * 赋值的一律不进。
 */
export function relCmp(op, l, r) {
  const flip = { '<': '>', '>': '<', '<=': '>=', '>=': '<=' };
  if (!flip[op]) throw new Error('morph.relCmp: 不支持的算子 ' + op);
  return randInt(0, 1) === 0
    ? t.binaryExpression(op, l, r)
    : t.binaryExpression(flip[op], r, l);
}

/**
 * 否定比较三态：!(l===r) ↔ l!==r ↔ r!==l。
 *
 * 等价条件：=== 无类型转换，三式恒等价；l/r 纯（同 relCmp）。调用方保证返回的
 * 布尔值只用在条件位置（if/test/三元判别），不依赖引用同一性——三式都是新节点。
 */
export function negCmp(l, r) {
  const f = randInt(0, 2);
  if (f === 0) return t.unaryExpression('!', t.binaryExpression('===', l, r), true);
  if (f === 1) return t.binaryExpression('!==', l, r);
  return t.binaryExpression('!==', r, l);
}

/**
 * 布尔字面量：true ↔ !0、false ↔ !1。逐位恒等（!0===true、!1===false）。
 * 任何位置可用（表达式纯、无副作用）。
 */
export function boolLit(b) {
  const v = !!b;
  return randInt(0, 1) === 0
    ? t.booleanLiteral(v)
    : t.unaryExpression('!', t.numericLiteral(v ? 0 : 1), true);
}

/**
 * for-update 位置的计数器自增三态：i++ ↔ ++i ↔ i+=1。
 *
 * 等价条件（调用方保证，缺一不可）：
 *   · 处在 for 的 update 槽（值被 for 机制丢弃，前/后缀差异不可观察）；
 *   · 目标是数值计数器（初值为数字字面量、仅本处自增：字符串目标下 i++ 与
 *     i+=1 语义不同，前者转数字后者拼接，绝不能混用）。
 * 传名字字符串，内部每次都造新节点，不复用调用方的节点对象。
 */
export function incUpd(name) {
  const id = () => t.identifier(name);
  const f = randInt(0, 2);
  if (f === 0) return t.updateExpression('++', id(), false);
  if (f === 1) return t.updateExpression('++', id(), true);
  return t.assignmentExpression('+=', id(), t.numericLiteral(1));
}

export default { declKind, yodaEq, numLit, loopTrue, retVoid, memberDot, relCmp, negCmp, boolLit, incUpd };
