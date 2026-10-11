import t from '../ast/types.js';
import rand from '../utils/rand.js';
const { randInt, shuffle } = rand;
import morph from '../utils/morph.js';
import vmBoundary from './vmBoundary.js';
const { insideVmFunction } = vmBoundary;
/**
 * 控制流扁平化：把函数体改写成 while(true) 加 switch(state) 的状态机。
 * if/else 分支拆成独立 case，条件只决定下一个状态值，case 顺序与状态无关，
 * 跳转靠状态值匹配；状态值取非连续随机数，另注入永不命中的死状态和恒真谓词
 * 包裹的虚假分支。嵌套 if/else 递归处理，options.controlFlowDepth（默认 3，
 * 上限 8）决定再包几层，每层各自持有状态变量、XOR 掩码、死状态和乱序，
 * 内层 default return 保证语义不变。
 *
 * 入口门槛是函数体为 BlockStatement 且顶层语句数达到 threshold，只对第 1 层
 * 判断；含 with/labeled/class 的函数跳过；分支含针对外层循环的 break/continue
 * 或 try 时该 if 整体保留；let/const 提升为 var，函数声明提升到开头。
 * controlFlowLoopFlattening 默认开启，while/do-while/for 拆成测试、体、更新
 * 三个状态，裸 break/continue 转为状态跳转；循环体含 let/const、块级函数声明、
 * try/with/labeled，或 for 头含 let/const，或 switch 内有 continue 的循环整体
 * 保留，for-in/for-of 始终保留。
 *
 * 运行期滚动重键（options.controlFlowRollingKey，默认开）：状态变量不再直接存
 * 加密状态值 enc(s)，而是存 enc(s) ^ K，K 是一把每次分派推进一次的轮密钥
 * （xorshift32，与 shell 的 xs32 同源）。分派时先算 d = state ^ K 再匹配 case
 * 标签，随后立刻把 K 推进到下一轮，于是同一条边在第 i 次与第 j 次经过时状态
 * 变量里的数值并不相同——照着同一个值下条件断点、按值聚类做动态跟踪、从内存
 * dump 反推状态编号这三种做法同时失效。K 只走移位与异或，不引入乘法，没有
 * 超过 2^53 的精度问题，每轮分派多四次整数运算。
 */

export default function controlFlow(ast, options, ctx) {
  const { traverse, rng } = ctx;
  const threshold = options.controlFlowThreshold !== undefined ? options.controlFlowThreshold : 5;
  const probability = options.controlFlowProbability !== undefined ? options.controlFlowProbability : 0.75;
  const depth = Math.min(Math.max(1, options.controlFlowDepth || 3), 8); // 取 1 到 8 层，默认 3 层嵌套
  // 循环纳入状态机，默认开启：while/do-while/for 拆成测试、体、更新三个状态，
  // 循环体含 let/const、函数声明、try 等无法安全降级的循环整体保留
  const loopFlatten = options.controlFlowLoopFlattening !== false;
  // 运行期滚动重键，默认开。关掉后状态变量直接承载加密状态值，与旧行为一致
  const rolling = options.controlFlowRollingKey !== false;
  let flattened = 0;
  let casesGenerated = 0;
  let loopsFlattened = 0;

  traverse(ast, {
    Function(path) {
      if (path.isArrowFunctionExpression() && !t.isBlockStatement(path.node.body)) return;
      if (path.node.body && !t.isBlockStatement(path.node.body)) return;
      // VMP 解释器骨架和体内的片段闭包整体跳过，判定与 condition、logical、
      // objectKeys、deadCode、debugProtection、opaquePredicates 一致，同属
      // vmBoundary 约定。片段闭包按字节码步执行，包一层状态机等于给每条被步
      // 执行的指令再加一层分发；骨架本身被状态机化会破坏字节码分发。RT 内核
      // 函数同样豁免（__rtKernel）。未开启 VMP 的产物没有豁免，强度不变。
      if (insideVmFunction(path)) return;

      const body = path.get('body');
      if (!body.isBlockStatement()) return;
      // 门槛判断只在第 1 层做，包括 threshold、probability 和 eligibility
      const stmts = body.node.body;
      if (stmts.length < threshold) return;
      if (rng() > probability) return;
      if (!isEligible(stmts)) return;

      // 逐层扁平化，每层对当前函数体再包一层状态机
      let total = 0;
      for (let d = 0; d < depth; d++) {
        const cur = body.node.body;
        if (cur.length === 0) break;
        const r = doFlatten(path, cur, rng, loopFlatten, rolling);
        if (!r) break;
        total += r.cases;
        loopsFlattened += r.loops;
        flattened++;
      }
      casesGenerated += total;
    },
  });

  return { flattened, casesGenerated, loopsFlattened };
};

function isEligible(stmts) {
  for (const stmt of stmts) {
    if (t.isWithStatement(stmt)) return false;
    if (t.isLabeledStatement(stmt)) return false;
    if (t.isClassDeclaration(stmt)) return false;
  }
  return true;
}

// 判断分支能否安全拆分：不含 try/with/labeled，也不含针对外层循环的
// break/continue。inLoop 为真时 break/continue 由 flatten 翻译成状态跳转，
// 可以放行
function isSimpleBranch(stmts, inLoop) {
  for (const s of stmts) {
    if (!inLoop && (t.isBreakStatement(s) || t.isContinueStatement(s))) return false;
    if (t.isTryStatement(s) || t.isWithStatement(s) || t.isLabeledStatement(s)) return false;
    if (t.isIfStatement(s)) {
      if (!isSimpleBranch(s.consequent.body || [s.consequent], inLoop)) return false;
      if (s.alternate && !isSimpleBranch(s.alternate.body || [s.alternate], inLoop)) return false;
    }
    // 循环/switch/函数：内部 break/continue 属于它们自己，安全，不深入
  }
  return true;
}

// 循环体统一成语句列表，块体取 body，单语句包成列表
function loopBodyList(stmt) {
  return t.isBlockStatement(stmt) ? stmt.body : [stmt];
}

// 循环体安全性扫描，不进入嵌套函数和嵌套循环，它们整体另行编译或保留。
// 含 try/with/labeled、let/const 声明、块级函数声明，或 switch 内存在
// continue，都算不可编译。switch 整体保留时其中的 continue 会误绑定到分发循环
function loopBodyUnsafe(stmts) {
  for (const s of stmts) {
    if (t.isFunction(s) || t.isWhileStatement(s) || t.isDoWhileStatement(s) ||
        t.isForStatement(s) || t.isForInStatement(s) || t.isForOfStatement(s)) continue;
    if (t.isTryStatement(s) || t.isWithStatement(s) || t.isLabeledStatement(s)) return true;
    if (t.isVariableDeclaration(s) && s.kind !== 'var') return true;
    if (t.isFunctionDeclaration(s)) return true;
    if (t.isSwitchStatement(s)) {
      for (const c of s.cases) {
        if (hasContinueOutsideLoop(c.consequent)) return true;
      }
      continue;
    }
    if (t.isIfStatement(s)) {
      if (loopBodyUnsafe(loopBodyList(s.consequent))) return true;
      if (s.alternate && loopBodyUnsafe(loopBodyList(s.alternate))) return true;
      continue;
    }
    if (t.isBlockStatement(s)) { if (loopBodyUnsafe(s.body)) return true; continue; }
  }
  return false;
}

// 搜索不进嵌套循环和函数的 continue，但会进入 switch、try、if、block 内层。
// 这类 continue 词法上绑定到正在编译的外层循环，无法在整体保留的子树里改写
function hasContinueOutsideLoop(stmts) {
  for (const s of stmts) {
    if (t.isFunction(s) || t.isWhileStatement(s) || t.isDoWhileStatement(s) ||
        t.isForStatement(s) || t.isForInStatement(s) || t.isForOfStatement(s)) continue;
    if (t.isContinueStatement(s)) return true;
    if (t.isSwitchStatement(s)) {
      for (const c of s.cases) {
        if (hasContinueOutsideLoop(c.consequent)) return true;
      }
      continue;
    }
    if (t.isTryStatement(s)) {
      if (hasContinueOutsideLoop(s.block.body)) return true;
      if (s.handler && hasContinueOutsideLoop(s.handler.body.body)) return true;
      if (s.finalizer && hasContinueOutsideLoop(s.finalizer.body)) return true;
      continue;
    }
    if (t.isIfStatement(s)) {
      if (hasContinueOutsideLoop(loopBodyList(s.consequent))) return true;
      if (s.alternate && hasContinueOutsideLoop(loopBodyList(s.alternate))) return true;
      continue;
    }
    if (t.isBlockStatement(s)) { if (hasContinueOutsideLoop(s.body)) return true; continue; }
  }
  return false;
}

function doFlatten(path, stmts, rng, loopFlatten, rolling) {
  const body = path.get('body');
  const stateName = path.scope.generateUidIdentifier('x');
  // 轮密钥与推进用的临时变量，只在滚动重键开启时声明
  const kName = rolling ? path.scope.generateUidIdentifier('k').name : null;
  const tName = rolling ? path.scope.generateUidIdentifier('w').name : null;
  const dName = rolling ? path.scope.generateUidIdentifier('d').name : null;
  const K0 = rolling ? randInt(1, 0x7ffffffe) : 0;

  // 声明提升，递归处理 if 分支内的声明。分支体用新的 BlockStatement 承接，
  // 不原位改写原节点的 body 数组，失败或放弃的路径不会留下半改写的 AST
  const hoistedVars = [];
  const seenVars = new Set();
  const hoistedFns = [];

  function preprocess(list) {
    const out = [];
    for (const stmt of list) {
      if (t.isFunctionDeclaration(stmt)) {
        hoistedFns.push(stmt);
        continue;
      }
      if (t.isVariableDeclaration(stmt)) {
        const ids = Object.keys(t.getBindingIdentifiers(stmt.declarations));
        for (const id of ids) {
          if (!seenVars.has(id)) {
            seenVars.add(id);
            hoistedVars.push(t.variableDeclarator(t.identifier(id)));
          }
        }
        for (const d of stmt.declarations) {
          if (d.init) {
            out.push(t.expressionStatement(t.assignmentExpression('=', d.id, d.init)));
          }
        }
        continue;
      }
      if (t.isIfStatement(stmt)) {
        if (t.isBlockStatement(stmt.consequent)) {
          stmt.consequent = t.blockStatement(preprocess(stmt.consequent.body));
        } else {
          const proc = preprocess([stmt.consequent]);
          if (proc.length) stmt.consequent = proc[0];
        }
        if (stmt.alternate) {
          if (t.isBlockStatement(stmt.alternate)) {
            stmt.alternate = t.blockStatement(preprocess(stmt.alternate.body));
          } else {
            const proc = preprocess([stmt.alternate]);
            if (proc.length) stmt.alternate = proc[0];
          }
        }
        out.push(stmt);
        continue;
      }
      out.push(stmt);
    }
    return out;
  }

  const cleanStmts = preprocess(stmts);
  if (cleanStmts.length === 0) return 0;

  // 逐状态 XOR 掩码加状态分配器，状态值取非连续随机数。每个状态 s 有自己的
  // 随机掩码 K(s)，case 标签与状态赋值共用同一个 K(s)，由 KMAP 记忆化，
  // switch 匹配语义不变。整个函数共用一个掩码时，反混淆器从任意一个 case 对
  // 就能推出 K 并解出全部状态标签；逐状态掩码把一处泄漏限制在单个状态上，
  // 恢复全部状态需要对每个 case 独立求解。状态赋值不写明文数字字面量，改用
  // 恒等算术表达式分解，state = expr 的表达式由随机操作数构建且求值严格等于
  // 目标值，AST 层面固定形态的 state = 整数 消失，单条正则或模式匹配剥离不了。
  // 掩码和状态值都小于 2^31，异或结果同界，stateExpr 的正数分支始终可用
  const KMAP = new Map();
  const maskOf = (s) => {
    let k = KMAP.get(s);
    if (k === undefined) {
      k = randInt(0x10000, 0x7fffffff);
      KMAP.set(s, k);
    }
    return k;
  };
  const enc = (s) => s ^ maskOf(s);

  const usedStates = new Set();
  const allocState = () => {
    let s;
    do {
      s = randInt(0x100, 0x7fffffff);
    } while (usedStates.has(s));
    usedStates.add(s);
    return s;
  };

  // 把整数 V（0 <= V < 2^31）分解成求值等于 V 的算术表达式，破坏整数字面量
  // 指纹。形态随机取 a^b、a+b、a-b、a*b、嵌套复合或位运算组合，操作数随机但
  // 保证恒等。反混淆器要折叠整棵表达式树才能消解，单条正则或模式匹配剥离不了
  const stateExpr = (V) => {
    const Vn = V | 0;
    if (Vn < 0) return t.numericLiteral(Vn); // 负数兜底，直接写字面量
    const form = randInt(0, 6);
    if (form === 0) {
      // a ^ b === V
      const a = randInt(1, 0x3fffffff);
      return t.binaryExpression('^', t.numericLiteral(a), t.numericLiteral(a ^ Vn));
    }
    if (form === 1) {
      // a + b === V
      const a = randInt(0, Vn);
      return t.binaryExpression('+', t.numericLiteral(a), t.numericLiteral(Vn - a));
    }
    if (form === 2) {
      // a - b === V
      const a = Vn + randInt(0, 0x3fffffff);
      return t.binaryExpression('-', t.numericLiteral(a), t.numericLiteral(a - Vn));
    }
    if (form === 3) {
      // a*b === V（取 a=1 保证不溢出、恒等）
      if (randInt(0, 1) === 0) return t.binaryExpression('*', t.numericLiteral(1), t.numericLiteral(Vn));
      return t.binaryExpression('*', t.numericLiteral(Vn), t.numericLiteral(1));
    }
    if (form === 4) {
      // 嵌套复合，需要先折叠内层。构造 (a ^ 0) + (b ^ 0) 且 a + b === V，
      // 求值恒等于 V
      const a = randInt(0, Vn);
      const b = Vn - a;
      const left = t.binaryExpression('^', t.numericLiteral(a), t.numericLiteral(0));
      const right = t.binaryExpression('^', t.numericLiteral(b), t.numericLiteral(0));
      return t.binaryExpression('+', left, right);
    }
    // 嵌套复合表达式 (a ^ b) + (c - d) === V，a^b 与 c-d 分别构造
    // 取 a^b = x1，c-d = x2，满足 x1 + x2 === V
    const x1 = randInt(0, Vn);
    const x2 = Vn - x1;
    const a1 = randInt(1, 0x3fffffff);
    const c1 = x2 + randInt(0, 0x3fffffff);
    const xorExpr = t.binaryExpression('^', t.numericLiteral(a1), t.numericLiteral(a1 ^ x1));
    const subExpr = t.binaryExpression('-', t.numericLiteral(c1), t.numericLiteral(c1 - x2));
    return t.binaryExpression('+', xorExpr, subExpr);
  };

  // 恒真谓词的形态表（2026-10-11 强化）。
  //
  // 旧形态只有 `typeof state==='number'` 一种，而且**两个分支是逐字相同的克隆**——
  // 也就是说 `cond ? A : A` 这个形状本身就够了：任何工具（甚至三行正则）都能不看
  // 语义直接把它折成 `A`，包裹等于没加。两条修法：
  //   ① 两个分支语义恒等但**文本不同**（`A` 与 `(0,A)`/`(void 0,A)`：逗号表达式
  //      返回右值，对任意值都恒等，不改类型也不多求值），"结构相等"这条捷径失效；
  //   ② 谓词不再只有 typeof 一种，改为逐构建从下表挑：每个都是**对任意值恒真**的
  //      位运算/算术恒等式——操作数一律先 `|0` 归一化到 int32，所以即使 state 万一
  //      不是数字也恒真（`(x|0)` 对任意 x 都有定义）。要证明它们恒真得做模算术/
  //      位级推理，纯常量折叠与类型推导都消不掉。
  //
  // 各形态的恒等性（S 表示 (state|0)，即任意 int32）：
  //   0 typeof：S 由我们自己的数值路径赋值，恒为 'number'
  //   1 (S>>1)*2 + (S&1) === S     —— 算术右移后重拼低一位；|S>>1|*2 ≤ 2^31 在
  //                                  float64 里精确，负数同样成立（-3→-2*2+1=-3）
  //   2 (S&-2)|(S&1) === S         —— 清低位再按原低位回填
  //   3 (S^(S&1)) + (S&1) === S    —— 低位置零后加回
  //   4 ((S|1)>S) === ((S&1)===0)  —— 偶数才因置位变大；两边同为布尔的等价判定
  const truePredForms = [
    () => t.binaryExpression('===',
      t.unaryExpression('typeof', t.identifier(stateName.name), true),
      t.stringLiteral('number')),
    () => t.binaryExpression('===',
      t.binaryExpression('+',
        t.binaryExpression('*', t.binaryExpression('>>', intState(), t.numericLiteral(1)), t.numericLiteral(2)),
        t.binaryExpression('&', intState(), t.numericLiteral(1))),
      intState()),
    () => t.binaryExpression('===',
      t.binaryExpression('|',
        t.binaryExpression('&', intState(), t.numericLiteral(-2)),
        t.binaryExpression('&', intState(), t.numericLiteral(1))),
      intState()),
    () => t.binaryExpression('===',
      t.binaryExpression('+',
        t.binaryExpression('^', intState(), t.binaryExpression('&', intState(), t.numericLiteral(1))),
        t.binaryExpression('&', intState(), t.numericLiteral(1))),
      intState()),
    () => t.binaryExpression('===',
      t.binaryExpression('>', t.binaryExpression('|', intState(), t.numericLiteral(1)), intState()),
      t.binaryExpression('===', t.binaryExpression('&', intState(), t.numericLiteral(1)), t.numericLiteral(0))),
  ];
  // 每个操作数都要一个新节点（AST 节点不可共享），这里现取现建
  function intState() {
    return t.binaryExpression('|', t.identifier(stateName.name), t.numericLiteral(0));
  }

  // 跳转写入加密值 enc(s)，switch 匹配的 case 标签也是 enc(s)，语义等价。
  // 赋值目标不是字面量，而是加密值经 stateExpr 分解出的计算表达式
  // 写入状态值。滚动重键时写的是 enc(s) ^ K，K 此刻已被推进到下一轮的值，
  // 下一轮分派用同一个 K 还原出 enc(s)。不滚键时与旧形态逐字一致。
  const assignState = (s) => {
    const rhs = rolling
      ? t.binaryExpression('^', stateExpr(enc(s)), t.identifier(kName))
      : stateExpr(enc(s));
    // 去确定性：30% 概率把状态写入包一层恒真条件 `cond ? A : B`。
    //
    // state 恒为数值（allocState/enc/滚动 K 全是 int32 路径），所以谓词恒真；但
    // 证明它需要位级/模算术推理，纯常量折叠与类型推导都消不掉。两个分支共用同一
    // rhs 的克隆（运行时只求值选中的那支），语义与不包裹逐位一致。
    if (randInt(0, 9) < 3) {
      const cond = truePredForms[randInt(0, truePredForms.length - 1)]();
      // 第二支过一层恒等包装：`(0,A)` / `(void 0,A)` 对任意值恒等且文本不同，
      // 于是 `cond?A:A`（结构相等即折叠）这条最容易的捷径不再成立。
      const cloned = t.cloneNode(rhs, true);
      const alt = randInt(0, 1) === 0
        ? t.sequenceExpression([t.numericLiteral(0), cloned])
        : t.sequenceExpression([t.unaryExpression('void', t.numericLiteral(0), true), cloned]);
      return t.expressionStatement(t.assignmentExpression('=',
        t.identifier(stateName.name),
        t.conditionalExpression(cond, rhs, alt)));
    }
    return t.expressionStatement(t.assignmentExpression('=', t.identifier(stateName.name), rhs));
  };

  // 递归生成 case，所有标签都是加密后的数字
  const cases = [];
  const caseOf = (s) => t.switchCase(t.numericLiteral(enc(s)), []);

  // 循环上下文栈，栈顶即裸 break/continue 的目标。它们无 label，只能绑定最近循环
  const loopStack = [];

  // 循环可编译判定。for 头含 let/const 时逐次迭代绑定无法降级，循环体含
  // let/const、块级函数声明、try/with/labeled，或 switch 内有 continue，
  // 都保留整体
  const loopCompilable = (node) => {
    if (t.isForStatement(node) && node.init &&
        t.isVariableDeclaration(node.init) && node.init.kind !== 'var') return false;
    return !loopBodyUnsafe(loopBodyList(node.body));
  };

  // 把 while/do-while/for 编译成状态机子图，breakTarget 是循环之后的状态
  let loopsDone = 0;
  function flattenLoop(node, breakTarget) {
    loopsDone++;
    const bodyList = loopBodyList(node.body);

    if (t.isWhileStatement(node) || t.isDoWhileStatement(node)) {
      const testS = allocState();
      loopStack.push({ brk: breakTarget, cont: testS });
      const bodyE = flatten(bodyList, testS);
      loopStack.pop();
      const c = caseOf(testS);
      c.consequent = [
        t.ifStatement(node.test,
          t.blockStatement([assignState(bodyE)]),
          t.blockStatement([assignState(breakTarget)])),
        t.breakStatement(),
      ];
      cases.push(c);
      // while 的入口是测试状态，do-while 的入口是循环体
      return t.isWhileStatement(node) ? testS : bodyE;
    }

    // for 循环的 continue 必须经过 update 状态
    const testS = node.test ? allocState() : null;
    const updS = allocState();
    loopStack.push({ brk: breakTarget, cont: updS });
    const bodyE = flatten(bodyList, updS);
    loopStack.pop();
    const afterUpd = testS !== null ? testS : bodyE;
    const updCase = caseOf(updS);
    updCase.consequent = [
      ...(node.update ? [t.expressionStatement(node.update)] : []),
      assignState(afterUpd),
      t.breakStatement(),
    ];
    cases.push(updCase);
    if (testS !== null) {
      const tc = caseOf(testS);
      tc.consequent = [
        t.ifStatement(node.test,
          t.blockStatement([assignState(bodyE)]),
          t.blockStatement([assignState(breakTarget)])),
        t.breakStatement(),
      ];
      cases.push(tc);
    }
    if (node.init) {
      const initStmts = [];
      if (t.isVariableDeclaration(node.init)) {
        const ids = Object.keys(t.getBindingIdentifiers(node.init.declarations));
        for (const id of ids) {
          if (!seenVars.has(id)) {
            seenVars.add(id);
            hoistedVars.push(t.variableDeclarator(t.identifier(id)));
          }
        }
        for (const d of node.init.declarations) {
          if (d.init) initStmts.push(t.expressionStatement(t.assignmentExpression('=', d.id, d.init)));
        }
      } else {
        initStmts.push(t.expressionStatement(node.init));
      }
      const initS = allocState();
      const ic = caseOf(initS);
      ic.consequent = [...initStmts, assignState(afterUpd), t.breakStatement()];
      cases.push(ic);
      return initS;
    }
    return afterUpd;
  }

  // flatten(list, next) 返回 list 的入口状态，next 是执行完 list 后进入的状态。
  //
  // 原来是 `flatten(list.slice(1), next)` 的尾递归：递归深度等于剩余语句条数，
  // 一个几千条语句的函数体（打包产物里的 IIFE、代码生成器的输出都很常见）
  // 就能把调用栈打爆（浏览器里更低），且每一层都要复制一遍剩余数组，是 O(n²)。
  // 改成从尾到头倒序遍历：深度恒为 O(1)。倒序与原实现的求值顺序一致（原式先递归
  // 算出 restEntry 再处理当前条），所以状态分配、掩码与会话内随机数的消耗顺序
  // 都不变，产物逐字节相同。分支里的嵌套调用保持递归——那层深度只等于 if 的
  // 嵌套层数，与语句条数无关。
  function flatten(list, next) {
    if (!list || list.length === 0) return next;
    let restEntry = next;
    for (let i = list.length - 1; i >= 0; i--) {
      const first = list[i];

      // 裸 break/continue 转成状态跳转，只在编译循环体时可达，l 缺失时兜底到 restEntry
      if (t.isBreakStatement(first) || t.isContinueStatement(first)) {
        const l = loopStack[loopStack.length - 1];
        const target = l ? (t.isBreakStatement(first) ? l.brk : l.cont) : restEntry;
        const entry = allocState();
        const c = caseOf(entry);
        c.consequent = [assignState(target), t.breakStatement()];
        cases.push(c);
        restEntry = entry;
        continue;
      }

      // 循环编译，while、do-while、for 都转状态机
      if (loopFlatten &&
          (t.isWhileStatement(first) || t.isDoWhileStatement(first) || t.isForStatement(first)) &&
          loopCompilable(first)) {
        restEntry = flattenLoop(first, restEntry);
        continue;
      }

      // if/else 拆分
      if (t.isIfStatement(first)) {
        const thenList = t.isBlockStatement(first.consequent) ? first.consequent.body : [first.consequent];
        const inLoop = loopStack.length > 0;
        const canSplit = isSimpleBranch(thenList, inLoop) &&
          (!first.alternate || isSimpleBranch(t.isBlockStatement(first.alternate) ? first.alternate.body : [first.alternate], inLoop));

        if (canSplit) {
          const thenEntry = flatten(thenList, restEntry);
          const elseEntry = first.alternate
            ? flatten(t.isBlockStatement(first.alternate) ? first.alternate.body : [first.alternate], restEntry)
            : restEntry;

          const jumpIf = t.ifStatement(
            first.test,
            t.blockStatement([assignState(thenEntry)]),
            first.alternate ? t.blockStatement([assignState(elseEntry)]) : t.blockStatement([assignState(restEntry)])
          );
          const entry = allocState();
          const c = caseOf(entry);
          c.consequent = [jumpIf, t.breakStatement()];
          cases.push(c);
          restEntry = entry;
          continue;
        }
        // 不能拆分时整体保留为一个 case
        const entry = allocState();
        const c2 = caseOf(entry);
        c2.consequent = [first, assignState(restEntry), t.breakStatement()];
        cases.push(c2);
        restEntry = entry;
        continue;
      }

      // 普通语句
      const entry = allocState();
      const c3 = caseOf(entry);
      c3.consequent = [first, assignState(restEntry), t.breakStatement()];
      cases.push(c3);
      restEntry = entry;
    }
    return restEntry;
  }

  const exitState = allocState();
  const entryState = flatten(cleanStmts, exitState);

  // 死状态注入加虚假分支。死状态永不命中，虚假分支用恒真谓词包裹真实操作，
  // 看似可达实则不达，两者共同破坏 CFG 恢复，反混淆器分不出真实 case 和假 case
  const deadCount = randInt(3, 6);
  for (let i = 0; i < deadCount; i++) {
    const deadState = allocState();
    const deadNext = rng() < 0.5 ? allocState() : exitState;
    // 假 case 用嵌套 if 加恒真谓词包裹真实操作，看起来像可选分支。
    // 谓词直接复用上面的 truePredForms（5 种位运算/typeof 恒等式）：判定它需要
    // 位级推理 + 跟踪 state 变量的数据流，而旧的两路字面量自反（`g===g`、
    // `(g^65280)===(g^65280)`，grep 个 65280 即定位）不看任何上下文就能折掉。
    // 死状态永不命中，谓词永不求值——引用 live 的 state 变量只有静态耦合效果，
    // 无运行期语义影响。
    const pred = truePredForms[randInt(0, truePredForms.length - 1)]();
    const fakeBody = [
      t.ifStatement(pred, t.blockStatement([
        t.expressionStatement(
          t.binaryExpression('+',
            t.binaryExpression('*', t.numericLiteral(randInt(1, 0xff)), t.numericLiteral(randInt(1, 0xff))),
            t.numericLiteral(randInt(1, 0xff)))
        ),
      ])),
      assignState(deadNext),
      t.breakStatement(),
    ];
    const dc = caseOf(deadState);
    dc.consequent = fakeBody;
    cases.push(dc);
  }

  // case 乱序，default 固定在最后
  shuffle(cases);
  cases.push(t.switchCase(null, [t.returnStatement()]));

  // 组装状态机
  const switchStmt = t.switchStatement(t.identifier(stateName.name), cases);
  // 滚动重键的分派前奏：取 d = state ^ K，随即把 K 推进一轮。case 体里写的
  // 状态值是"推进后的 K"，因此轮次始终对齐。
  //
  // 前奏必须写成单条逗号序列表达式：本层状态机被更深的一层再扁平化时，
  // 外层会把这个 while(true) 当成普通循环编译（flattenLoop），循环体按语句
  // 拆成若干状态。若前奏是多条语句，取 d 与推 K 会落在不同状态上，中间还夹
  // 着若干次外层分派，轮次就此错位；合成一条语句后，"取 d + 推 K"作为一个
  // 状态整体迁移，任何层数的嵌套都不会打散它。
  let loopBody = switchStmt;
  if (rolling) {
    const K = () => t.identifier(kName);
    const W = () => t.identifier(tName);
    const xor = (a, b) => t.binaryExpression('^', a, b);
    const seq = t.sequenceExpression([
      t.assignmentExpression('=', t.identifier(dName), xor(t.identifier(stateName.name), K())),
      t.assignmentExpression('=', W(), t.binaryExpression('<<', K(), t.numericLiteral(13))),
      t.assignmentExpression('=', K(), t.binaryExpression('>>>', xor(K(), W()), t.numericLiteral(0))),
      t.assignmentExpression('=', W(), t.binaryExpression('>>>', K(), t.numericLiteral(17))),
      t.assignmentExpression('=', K(), t.binaryExpression('>>>', xor(K(), W()), t.numericLiteral(0))),
      t.assignmentExpression('=', W(), t.binaryExpression('<<', K(), t.numericLiteral(5))),
      t.assignmentExpression('=', K(), t.binaryExpression('>>>', xor(K(), W()), t.numericLiteral(0))),
    ]);
    loopBody = t.blockStatement([
      t.expressionStatement(seq),
      t.switchStatement(t.identifier(dName), cases),
    ]);
  }
  // 主循环形态二选一：while(true) ↔ for(;;)，恒等（见 morph.loopTrue）。
  const loopStmt = morph.loopTrue(loopBody);

  const newBody = [];
  for (const fn of hoistedFns) newBody.push(fn);
  if (hoistedVars.length > 0) {
    newBody.push(t.variableDeclaration('var', hoistedVars));
  }
  if (rolling) {
    newBody.push(t.variableDeclaration('var', [t.variableDeclarator(t.identifier(kName), t.numericLiteral(K0))]));
    newBody.push(t.variableDeclaration('var', [
      t.variableDeclarator(t.identifier(tName)),
      t.variableDeclarator(t.identifier(dName)),
    ]));
  }
  const initState = rolling
    ? t.binaryExpression('^', stateExpr(enc(entryState)), t.identifier(kName))
    : stateExpr(enc(entryState));
  newBody.push(t.variableDeclaration('var', [
    t.variableDeclarator(stateName, initState),
  ]));
  newBody.push(loopStmt);

  body.node.body = newBody;
  return { cases: cases.length, loops: loopsDone };
}
