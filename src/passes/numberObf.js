import t from '../ast/types.js';
import rand from '../utils/rand.js';
const { randInt, uniqueName } = rand;
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

/**
 * 运行时状态版恒等式的抽取概率。其余形式都是纯常量表达式，求值器一折就回到 V；
 * 这一形式要贵一点（每个字面量一次乘加与一次变量读写），按比例抽取。
 */
const RUNTIME_FORM_RATE = 0.25;

/** 恒等式生成：返回求值严格等于 V 的表达式节点。
 * @param {number} V 目标值
 * @param {object|null} rtState 运行时状态计数器 { id: () => Identifier }，
 *   为空表示不生成运行时形式（本 pass 未启用该形式时）
 */
function identity(V, rtState) {
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
  // 运行时状态形式（P1）：以上五种操作数全是字面量，常量传播能把整棵表达式折回
  // V，等于给静态分析送答案。这一形式让中间量 depend on 运行期才存在的值：
  //
  //   ((C = (C * A + B) & MASK), ((a ^ C) ^ ((a ^ V) ^ C)))
  //
  // 逗号左侧推进共享计数器，右侧展开后 C 与 C 相消，恒等于 V。于是每个被替换的
  // 字面量既依赖运行期取值（首值来自 Date.now），又依赖前一个字面量刚写下的计
  // 数值，形成数据流依赖链：静态求值无法确定 C，折叠失效；要化简必须先认出这条
  // 链并证明两侧的 C 是同一个值。
  //
  // 计数器全程收窄在 2^17 以内（乘数 < 2^15），乘加不溢出双精度，取值精确。
  if (rtState && randInt(0, 99) < Math.round(RUNTIME_FORM_RATE * 100)) {
    forms.push(() => {
      const a = randInt(1, 0x3fffffff);
      const upd = t.assignmentExpression('=', rtState.id(),
        t.binaryExpression('&',
          t.binaryExpression('+',
            t.binaryExpression('*', rtState.id(), t.numericLiteral(rtState.a)),
            t.numericLiteral(rtState.b)),
          t.numericLiteral(0x1ffff)));
      const expr = t.binaryExpression('^',
        t.binaryExpression('^', t.numericLiteral(a), rtState.id()),
        t.binaryExpression('^',
          t.binaryExpression('^', t.numericLiteral(a), t.numericLiteral(V)),
          rtState.id()));
      return t.sequenceExpression([upd, expr]);
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
  // 运行时状态计数器：**首次真的抽到运行时形式时才注入**，否则不引入多余绑定
  // （低档预设或阈值很低时不该多出无用声明）。声明放在程序最前，跳过指令序言
  // 与 import。
  //
  // 初值刻意用**纯字面量**，不调 Date.now 之类的运行期接口：本 pass 排在第 2 位，
  // 之后 objectKeys / stringArray 会把 `Date.now` 这类成员访问改写成字符串池
  // 计算式，而池访问器的声明位于头部带内、在程序最前那条声明**之后**——于是
  // 那句初始化会在池就绪前执行并直接抛错（实测："$2a is not a function"）。
  // 字面量初值没有这个问题，注入语句里也没有任何可被后续 pass 改写的结构。
  //
  // 运行期依赖由**使用点**承担：每个抽中该形式的字面量都先 `C = C * A + B` 再
  // 取值，于是第 n 个字面量的掩码取决于前 n-1 次求值，形成跨表达式的数据流依赖
  // 链——AST 常量折叠与局部代数化简都失效（它们只能看到单个表达式的常量树）。
  const body = ast.type === 'File' ? ast.program.body : ast.body;
  let rtName = null;
  const rtState = {
    // 乘数取奇数且小于 2^15，计数器掩码在 2^17 以内：乘加全程不溢出双精度
    a: randInt(0x1000, 0x7fff) * 2 + 1,
    b: randInt(1, 0xffff),
    id: () => {
      if (!rtName) {
        rtName = uniqueName(ctx.usedNames, '_0x');
        const decl = t.variableDeclaration('var', [t.variableDeclarator(
          t.identifier(rtName),
          t.numericLiteral(randInt(1, 0xffff)))]);
        let at = 0;
        while (at < body.length
          && (body[at].type === 'Directive' || body[at].type === 'ImportDeclaration')) at++;
        body.splice(at, 0, decl);
      }
      return t.identifier(rtName);
    },
  };
  // 先收集后替换：identity() 会消耗 PRNG，遍历中改 AST 会让后续节点的
  // 随机数消耗序列跟着变，固定 seed 下不可复现
  for (const path of targets) {
    const v = path.node.value;
    path.replaceWith(identity(v, rtState));
    replaced++;
  }
  return { replaced, runtimeState: rtName ? 1 : 0 };
}
