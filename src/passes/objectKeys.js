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

  // 界面「不混淆项」挑选器写进来的精确名：这些属性名保持**字面形态**，不进字符串池、
  // 也不转计算下标。与 mangle 那边是同一个名单（excludedIdentifiers），但作用对象不同：
  // 那边管绑定名（变量/函数/参数），这边管属性名（键与点访问）。
  const keepProps = new Set(options.excludedIdentifiers || []);
  // 字符串名单（excludedStrings 精确值 + reservedStrings 正则）在这里同样要生效：
  // 键位上的字符串字面量被拆段之后，stringArray 再也看不到原串，"该串不收集/不拆分"
  // 的承诺当场落空。语义与 stringArray 的匹配器逐字一致（字面值转义加锚点、手写正则
  // 保持不锚点 test），否则同一份名单在两处会对同一个串给出不同结论。
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keepStrRe = [
    ...(options.reservedStrings || []).map((s) => { try { return new RegExp(s); } catch (e) { return null; } }),
    ...(options.excludedStrings || []).map((s) => { try { return new RegExp('^' + reEsc(s) + '$'); } catch (e) { return null; } }),
  ].filter(Boolean);
  // 命中就保持字面。标 __noPool：stringArray 认这个标记（见 isEligible），否则通过
  // 属性名名单保护的串会被池收走，产物里只剩一个解码调用，等于这条排除白勾。
  const keepLiteral = (node) => {
    const v = node.value;
    if (keepProps.has(v) || (keepStrRe.length && keepStrRe.some((re) => re.test(v)))) {
      node.__noPool = true;
      return true;
    }
    return false;
  };

  traverse(ast, {
    // VM 解释器骨架跳过，判断见 vmBoundary.js。B[pc++]、S.pop() 这类成员访问
    // 属于取指和栈操作的结构代码，改成下标形态会破坏 wasm 的特征匹配。
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
        // 命中排除名单的字符串键保持字面（两类来源：属性名精确名、字符串精确值/正则）
        if (keepLiteral(n.key)) return;
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
        if (keepProps.has(name)) return;   // 挑选器排除了这个属性名，保持字面形态
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
        // 与键位同一口径：命中排除名单的串保持字面，否则原串被拆段后
        // 字符串名单再也匹配不到它
        if (keepLiteral(n.property)) return;
        const expr = makeConcat(n.property.value);
        if (!expr) return;
        n.property = expr;
        changed++;
      } else {
        // 点访问转计算下标，顺带拆段
        if (!t.isIdentifier(n.property)) return;
        const name = n.property.name;
        if (keepProps.has(name)) return;   // 同上：点访问也保持字面形态
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
