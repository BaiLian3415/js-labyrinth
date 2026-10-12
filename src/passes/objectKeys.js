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

  // reservedStrings 在这里同样要生效：键位上的字符串字面量被拆段之后，stringArray
  // 再也看不到原串，"该串不收集/不拆分"的承诺当场落空。匹配语义与 stringArray 那边
  // 逐字一致，否则同一份名单在两处会对同一个串给出不同结论。
  const keepStrRe = (options.reservedStrings || [])
    .map((s) => { try { return new RegExp(s); } catch (e) { return null; } })
    .filter(Boolean);
  // 命中就保持字面。标 __noPool：stringArray 认这个标记（见 isEligible），否则靠这里
  // 保护住的串会被池收走，产物里只剩一个解码调用，等于这条保留白设。
  // Identifier 形态的键（方法名 / 类字段名 mostly 是这种）也要查同一份名单：
  // 拆段同样会让原名从产物里消失，用户在 reservedStrings 里点名保它就必须留明文。
  const keepName = (v) => keepStrRe.length > 0 && keepStrRe.some((re) => re.test(v));
  const keepLiteral = (node) => {
    if (!keepName(node.value)) return false;
    node.__noPool = true;
    return true;
  };

  // 方法名/类字段名（ObjectMethod / ClassMethod / ClassProperty）的键转计算形态。
  // objectKeys 原先只处理 ObjectProperty 与 MemberExpression：成员访问（调用点）早就
  // 转了下标并入了池，但**定义点的键**一直是明文——`{render(){}}`、`class{render(){}}`
  // 里的方法名是产物里唯一剩下的可 grep 标识符面，静态就能读出 API 面。这里把三者
  // 的键也转成 `["render"]` 计算形态，随后由 stringArray 收进池。
  //
  // 各自的禁改面（错了就静默坏语义，不是报错）：
  //   · ClassMethod 的 constructor 不能转计算键——计算形态的 "constructor" 只是普通
  //     方法，类会丢掉构造函数，`new` 直接抛；
  //   · ObjectMethod 的 __proto__ 保守跳过（方法形态本不触发原型设置，与 ObjectProperty
  //     的 __proto__ 语义不同，但保持"这个键名不动"的统一口径更省心）；
  //   · 私有名（PrivateName）、数字键、本来就是表达式的键一律不动。
  const convertKey = (path) => {
    // 守卫只看**容器**（对象/类字面量）在不在 VM 函数体内，不看方法自身。
    // 方法体被 VM 编译时 `isVMCompiled(方法节点)` 为真，但那说的是"方法体是字节码
    // 桥接"，而键仍在字面量上、不在字节码里——拿方法自身判定会把最常见的情形
    //（普通类/对象方法进 VM）整个跳过，等于没做。真正要挡的是"位于 VM 片段 thunk
    // 内部的对象字面量"（那整段是字节码的一部分），此时容器在 VM 内、守卫成立。
    if (insideVmFunction(path.parentPath)) return;
    const n = path.node;
    if (n.computed) return;
    const key = n.key;
    if (!key) return;
    let name = null;
    if (t.isIdentifier(key)) { if (keepName(key.name)) return; name = key.name; }
    else if (t.isStringLiteral(key)) { if (keepLiteral(key)) return; name = key.value; }
    else return;
    if (n.type === 'ClassMethod' && name === 'constructor') return;
    if (n.type === 'ObjectMethod' && name === '__proto__') return;
    const expr = makeConcat(name);
    if (!expr) return;
    n.key = expr;
    n.computed = true;
    changed++;
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
        // 命中 reservedStrings 的字符串键保持字面
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
    ObjectMethod(path) { convertKey(path); },
    ClassMethod(path) { convertKey(path); },
    ClassProperty(path) { convertKey(path); },
    MemberExpression(path) {
      if (insideVmFunction(path)) return;
      const n = path.node;
      if (n.computed) {
        // 已经是下标形态，只拆字符串
        if (!t.isStringLiteral(n.property)) return;
        // 与键位同一口径：命中保留名单的串保持字面，否则原串被拆段后
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
