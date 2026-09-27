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

/**
 * MBA（混合布尔算术）形态：位运算与算术**交织**的代数恒等式。
 *
 * 与上面那批单一算子形态的区别在于化简成本。`a ^ b` 或 `a + b` 是单算子表达式，
 * 一个按算子分派的窥孔化简器逐个处理即可；MBA 把 `& | ^ + - * <<` 混在同一棵树里，
 * 要还原成 V 必须先认出**进位恒等式**这一族关系：
 *
 *   x + y = (x ^ y) + 2·(x & y)     进位：xor 是不进位和，and 是被进位的位
 *   x + y = (x | y) + (x & y)       or = xor + and
 *   x ^ y = (x | y) - (x & y)       由上一条移项
 *
 * 只按算子做局部化简的工具有两种下场：要么化简不动，要么在中间表达式上取错值
 * （`(x|y) - (x&y)` 若被当成 `(x|y) - (x&y)` 之外的任意近似都会偏）。这正是 MBA
 * 相对普通常量混淆的增益所在——它不是"把数字写得难认"，而是"让代数化简本身失效"。
 *
 * ## 精确性前提（与 eligible 的取值域一致，不可放宽）
 *
 * x、y 都取自 [1, V-1] 且 V < 2^30，因此 x、y 均落在 int32 非负区间内：
 *   - `& | ^` 走 ToInt32 后结果非负且 < 2^31，回写为 Number 精确；
 *   - 由 x + y = V 得 min(x,y) ≤ V/2，故 `x & y ≤ V/2`，于是 `(x & y) << 1 ≤ V < 2^30`，
 *     **不会**溢出成负的 int32（这是本族恒等式里唯一有溢出风险的算子，其余无上界压力）；
 *   - 所有 `+ - *` 的中间量 ≤ 2^31，远在双精度精确整数范围内（2^53）。
 * 三条合起来保证恒等是**数学意义上的**，不是"在 int32 里恰好成立"。改这里前
 * 必须重新验算这三条——把取值域放宽到 2^31 就会让 `<< 1` 翻负，产物静默算错。
 *
 * @param {number} V 目标值（≥2）
 * @param {Array<function():object>} forms 追加到这里
 */
function mbaForms(V, forms) {
  // x + y = V，两侧都非平凡（避开 0 与 V，否则恒等式退化成直接暴露 V）
  const split = () => {
    const x = randInt(1, V - 1);
    return [x, V - x];
  };
  const xor = (a, b) => t.binaryExpression('^', t.numericLiteral(a), t.numericLiteral(b));
  const or = (a, b) => t.binaryExpression('|', t.numericLiteral(a), t.numericLiteral(b));
  const and = (a, b) => t.binaryExpression('&', t.numericLiteral(a), t.numericLiteral(b));

  // (x ^ y) + 2*(x & y)
  forms.push(() => {
    const [x, y] = split();
    return t.binaryExpression('+', xor(x, y),
      t.binaryExpression('*', t.numericLiteral(2), and(x, y)));
  });
  // (x | y) + (x & y)
  forms.push(() => {
    const [x, y] = split();
    return t.binaryExpression('+', or(x, y), and(x, y));
  });
  // (x & y) + (x | y) —— 交换加法两侧，文本形态不同、树形不同
  forms.push(() => {
    const [x, y] = split();
    return t.binaryExpression('+', and(x, y), or(x, y));
  });
  // (x ^ y) + ((x & y) << 1)
  forms.push(() => {
    const [x, y] = split();
    return t.binaryExpression('+', xor(x, y),
      t.binaryExpression('<<', and(x, y), t.numericLiteral(1)));
  });
  // 2*(x | y) - (x ^ y)
  forms.push(() => {
    const [x, y] = split();
    return t.binaryExpression('-',
      t.binaryExpression('*', t.numericLiteral(2), or(x, y)), xor(x, y));
  });
  // (x & y) * 2 + (x ^ y)
  forms.push(() => {
    const [x, y] = split();
    return t.binaryExpression('+',
      t.binaryExpression('*', and(x, y), t.numericLiteral(2)), xor(x, y));
  });
}

/** 恒等式生成：返回求值严格等于 V 的表达式节点。
 * @param {number} V 目标值
 * @param {object|null} rtState 运行时状态计数器 { id: () => Identifier }，
 *   为空表示不生成运行时形式（本 pass 未启用该形式时）
 * @param {boolean} mba 是否允许 MBA（混合布尔算术）形态
 */
function identity(V, rtState, mba) {
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
    // MBA：位算与算术交织，单算子窥孔化简失效（见 mbaForms 的说明）
    if (mba) mbaForms(V, forms);
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
      // MBA × 运行期状态：xor 用「or 减 and」展开，同一个 C 在两处相消。
      //   (a^C) ^ ((a^V)^C)  ==  a ^ a ^ V  ==  V
      // 于是表达式里同时出现 | 、- 、& 三种运算，且中间量 depend on 运行期计数器；
      // 静态折叠既认不出 C 的取值，也认不出这棵树其实是一个 xor。
      if (mba && randInt(0, 1) === 1) {
        const p = () => t.binaryExpression('^', t.numericLiteral(a), rtState.id());
        const q = () => t.binaryExpression('^',
          t.binaryExpression('^', t.numericLiteral(a), t.numericLiteral(V)),
          rtState.id());
        return t.sequenceExpression([upd,
          t.binaryExpression('-',
            t.binaryExpression('|', p(), q()),
            t.binaryExpression('&', p(), q()))]);
      }
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
  // 统计口径固定：三条返回路径都带齐同样的字段，否则"是否干活"会改变 stat 形状，
  // 消费方（自测、界面、bench）就得对两种形状分别兜底。
  if (options.numberObfuscation === false) return { replaced: 0, runtimeState: 0, mba: false };
  const { traverse, rng } = ctx;
  const threshold = options.numberObfuscationThreshold !== undefined
    ? options.numberObfuscationThreshold : 0.6;
  const mba = !!options.numberObfuscationMBA;
  if (threshold <= 0) return { replaced: 0, runtimeState: 0, mba };

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
    path.replaceWith(identity(v, rtState, mba));
    replaced++;
  }
  return { replaced, runtimeState: rtName ? 1 : 0, mba };
}
