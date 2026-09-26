import t from '../ast/types.js';
import rand from '../utils/rand.js';
const { randInt } = rand;
import vmBoundary from './vmBoundary.js';
const { insideVmFunction } = vmBoundary;
/**
 * 对象键编码。对象字面量的键和成员访问的属性名都拆成 2~5 段随机拼接，
 * 键与属性名的静态指纹一并消失；对象键改用计算属性形态，obj.abc 统一
 * 转成 obj['ab' + 'c']。__proto__ 键跳过，计算属性会改变原型设置语义。
 * 保留字属性名如 obj.class 点形态合法，转下标同样合法。
 */

/**
 * 把字符串随机切成 2~5 段。
 * @param {string} value
 * @returns {string[]|string} 段数组；长度不足 3 时原样返回字符串
 */
function splitString(value) {
  if (value.length < 3) {
    return value;
  }
  const maxParts = Math.min(5, value.length);
  const partsCount = randInt(2, maxParts);
  // 切点放进 Set 去重，重复位置会拼出空段
  const cuts = new Set();
  while (cuts.size < partsCount - 1) cuts.add(randInt(1, value.length - 1));
  const sorted = [...cuts].sort((a, b) => a - b);
  const parts = [];
  let prev = 0;
  for (const c of sorted) {
    parts.push(value.slice(prev, c));
    prev = c;
  }
  parts.push(value.slice(prev));
  return parts;
}

/**
 * 生成键的拼接表达式，形态在加号连接和 join('') 之间随机。
 * @param {*} value
 * @returns {object|null} 表达式节点；value 不是字符串时返回 null
 */
function makeConcat(value) {
  if (typeof value !== 'string' || value.length < 3) {
    // 短名不拆段，只包成字面量
    return typeof value === 'string' ? t.stringLiteral(value) : null;
  }
  const parts = splitString(value);
  // 拼接形态随机二选一：加号连接，或数组 join('')
  if (randInt(0, 1) === 0) {
    let expr = t.stringLiteral(parts[0]);
    for (let i = 1; i < parts.length; i++) {
      expr = t.binaryExpression('+', expr, t.stringLiteral(parts[i]));
    }
    return expr;
  }
  return t.callExpression(
    t.memberExpression(
      t.arrayExpression(parts.map((p) => t.stringLiteral(p))),
      t.identifier('join'), false),
    [t.stringLiteral('')]
  );
}

export default function objectKeys(ast, options, ctx) {
  const { traverse } = ctx;
  let changed = 0;
  let dotToComputed = 0;

  traverse(ast, {
    // VM 解释器骨架跳过，判断见 vmBoundary.js。B[pc++]、S.pop() 这类成员访问
    // 属于取指和栈操作的结构代码，改成下标形态会破坏解释器骨架的形态。
    // 嵌套片段闭包里的用户代码照常处理。
    ObjectProperty(path) {
      if (insideVmFunction(path)) return;
      const n = path.node;
      if (n.computed) return;
      // 解构绑定和赋值模式里的属性键不转换。ObjectPattern 的键只接受标识符
      // 或成员形态，计算键不合法；默认值语义也会被破坏，{b = 10} 的 10 会丢失
      if (path.parent && path.parent.type === 'ObjectPattern') return;
      if (t.isStringLiteral(n.key)) {
        const value = n.key.value;
        if (value === '__proto__') return; // 计算属性不再设置原型
        const expr = makeConcat(value);
        if (!expr) return;
        n.key = expr;
        n.computed = true;
        changed++;
      } else if (t.isIdentifier(n.key)) {
        // 标识符键同样拆段，明文属性名指纹消失。简写 {message} 先展开成
        // {[拆段]: message}，绑定关系不变。__proto__ 在这里也跳过，
        // 计算形态不触发原型设置。
        const name = n.key.name;
        if (name === '__proto__') return;
        const expr = makeConcat(name);
        if (!expr) return;
        if (n.shorthand) {
          n.shorthand = false;
          n.value = t.identifier(name);
        }
        n.key = expr;
        n.computed = true;
        changed++;
      }
    },
    MemberExpression(path) {
      if (insideVmFunction(path)) return;
      const n = path.node;
      if (n.computed) {
        // 已经是下标形态，只拆字符串
        if (!t.isStringLiteral(n.property)) return;
        const expr = makeConcat(n.property.value);
        if (!expr) return;
        n.property = expr;
        changed++;
      } else {
        // 点访问转计算下标，顺带拆段
        if (!t.isIdentifier(n.property)) return;
        const name = n.property.name;
        // obj.#x 这类私有名进不到这里，parser 给出的是 PrivateName 节点，
        // 这个分支只会遇到公共标识符
        const expr = makeConcat(name);
        if (!expr) return;
        n.property = expr;
        n.computed = true;
        dotToComputed++;
        changed++;
      }
    },
    noScope: true,
  });

  return { changed, dotToComputed };
};
