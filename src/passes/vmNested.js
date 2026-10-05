/**
 * Pass：嵌套虚拟机（外层 Dispatcher → 内层可信内核）。
 *
 * ============================ 为什么要嵌套 ============================
 *
 * 单层 VM 的软肋是：还原出一份字节码 + 一张 handler 表之后，剩下的就是逐条翻译回
 * JS，工具链高度成熟。把 handler 表本身也藏起来，办法是让它**运行期生成**；
 * 而"生成 handler 表的代码"如果也用同一套 VM 编译，就无限 regress。
 *
 * 这里的收法是：
 *
 *   外层  用户 AST → 字节码 → **动态生成的 handler 表** → 解释执行
 *                    ↑ 这一层是现有 vm.js 的能力，被嵌套档复用
 *   内层  外层 handler 表被编译成**第二份字节码**，交给手写的可信内核执行
 *                    ↑ src/rt/vmcore.js，不参与流水线，因此 regress 在此终止
 *
 * 也就是说：外层 handler 不再是产物里的静态函数，而是**字节码**。静态分析看到
 * 的是两层字节码 + 一个几百字节的解释器循环，而"handler 到底是什么"这件事
 * 要等到运行时解出内层字节码、走过内层的表构造才知道。
 *
 * ============================ 为什么不复用 vm.js 的指令集 ============================
 *
 * vm.js 的操作码空间已经被 decoyOps 填到 256+，handler 表也按它那套 AST 编译
 * 路径生成。这里用 vmcore 独立的一套（6 字节定长、操作码加偏移变换），两套
 * 编码混在一个产物里本身就是特征 —— 交叉引用会让两边都不再"单一"。
 *
 * 编译范围刻意保守：只吃**算术与局部变量**（数值字面量、标识符读写、四则与位运算、
 * 一元负号/取反、if/else、for、while、return）。这是刻意留下的缺口：
 * 内核小到能被人读完，它的能力边界就是这份保护的边界，说清楚比含糊过去好。
 * 超出范围的函数**不编译、原样保留**，由 vm.js 的单层档处理。
 */

import t from '../ast/types.js';
import parser from '../ast/parser.js';
import rtlib from './rtlib.js';
import rand from '../utils/rand.js';
import i18n from '../i18n.js';
import { OPCODES, INSN_W, encodeOpcode } from '../rt/vmcore.js';

const { parse } = parser;
const { randInt, randHex, uniqueName } = rand;
const { t: msg } = i18n;

// ---------------------------------------------------------------- 指令发射

/**
 * 字节码缓冲。定长 6 字节，顺序追加。
 * 跳转先占位、回填 —— 内核不支持变长指令，所以只能两趟。
 */
class Emit {
  /**
   * @param {number} shift 操作码变换偏移。**每条指令的操作码都在这里加上**，
   *   运行期 vmcore 取指时再减去。首版只在签名里收着这个参数、实际没用上，
   *   于是 shift≠0 时字节码里的操作码全是原始值，内核解变换后查不到任何
  *   handler，整片被当填充跳过 —— 程序跑到末尾报 ok=false，看起来像"编译失败"。
   *   换句话说：变换不是可选装饰，它是内核与编译器之间必须对齐的约定。
   */
  constructor(shift) {
    this.bytes = [];
    this.shift = shift | 0;
  }

  /** 发一条，返回它的指令下标（跳转会用到） */
  insn(op, oa = 0, ob = 0, oc = 0, od = 0, flags = 0) {
    this.bytes.push((op + this.shift) & 0xff, oa & 0xff, ob & 0xff, oc & 0xff, od & 0xff, flags & 0xff);
    return this.bytes.length / INSN_W - 1;
  }

  /** 占一条跳转指令，稍后 patch */
  placeholder() { return this.insn(0); }
  patch(idx, op, oa = 0, ob = 0) {
    const at = idx * INSN_W;
    this.bytes[at] = (op + this.shift) & 0xff;
    this.bytes[at + 1] = oa & 0xff;
    this.bytes[at + 2] = ob & 0xff;
  }

  get length() { return this.bytes.length; }
  toBytes() { return Uint8Array.from(this.bytes); }
}

// ---------------------------------------------------------------- 局部变量

/**
 * 局部变量槽位分配。名字 → 槽号。
 *
 * 只收编译范围内的名字。名字表本身**不进字节码** —— 取值时按槽号直接读，
 * 产物里看不到 `x` 与槽 0 的对应关系（外层还有 mangle 在改名字，两层叠加）。
 */
class Locals {
  constructor() {
    this.map = new Map();
    /**
     * 静态确定为数值的槽名集合。给 `+` 用：JS 的 + 会因类型不同变成字符串拼接，
     * 而内核的 ADD 只做数值运算。挂在 Locals 上而不是单独传参，是因为 locals
     * 已经贯穿全部编译函数，再加一个并行参数会让每个签名都多一个槽位。
     */
    this.numeric = new Set();
    /**
     * 静态确定为**整数**的槽名。比 numeric 更严一档：内核的算术按 |0 走，
     * 浮点会静默算错（28/5 在 JS 里是 5.6，内核给 5）。只有整数槽才允许
     * 参与编译期无法确定结果的运算。
     */
    this.numericInt = new Set();
  }
  /** 取槽号，必要时分配 */
  slot(name) {
    if (this.map.has(name)) return this.map.get(name);
    const s = this.map.size;
    this.map.set(name, s);
    return s;
  }
  has(name) { return this.map.has(name); }
  get size() { return this.map.size; }
}

// ---------------------------------------------------------------- 二元运算映射

/**
 * 二元运算符 → 内层操作码。
 *
 * 刻意**不覆盖** `+`：JS 的 `+` 同时是数值加与字符串拼接，语义依赖运行期类型，
 * 内核的 ADD 只做数值。字符串拼接交给 CAT，但左右两侧求值顺序会变，所以编译器
 * 只在**两侧都是数值字面量**或都是已知数值槽时才用 CAT（见 compileBinary）。
 */
const BINOP = {
  '-': OPCODES.SUB,
  '*': OPCODES.MUL,
  '/': OPCODES.DIV,
  '%': OPCODES.MOD,
  '&': OPCODES.AND,
  '|': OPCODES.OR,
  '^': OPCODES.XOR,
  '<<': OPCODES.SHL,
  '>>': OPCODES.SHR,
  '>>>': OPCODES.USHR,
};

/** 比较运算符 → 内层操作码（结果 0/1） */
const CMPOP = {
  '==': OPCODES.EQ, '!=': OPCODES.NE,
  '<': OPCODES.LT, '<=': OPCODES.LE,
  '>': OPCODES.GT, '>=': OPCODES.GE,
  '===': OPCODES.EQ, '!==': OPCODES.NE,
};

/**
 * 复合赋值运算符 → 对应的二元操作码。
 *
 * 只收纯算术的那几个。`+=` 的坑在上一处 compileBinary 里说过（可能是拼接），
 * 这里靠 `locals.numeric` 挡：槽值静态确定为数值时才展开。
 */
const COMPOUND = {
  // += 也在表里，但**编译时另有类型闸门**：槽与右值都必须静态确定为数值，
  // 否则 `s += "x"` 会被编成数值加，静默算错。放在表里是因为闸门之外
  // 它与其他复合赋值没有区别。
  '+=': OPCODES.ADD,
  '-=': OPCODES.SUB,
  '*=': OPCODES.MUL,
  '/=': OPCODES.DIV,
  '%=': OPCODES.MOD,
  '&=': OPCODES.AND,
  '|=': OPCODES.OR,
  '^=': OPCODES.XOR,
  '<<=': OPCODES.SHL,
  '>>=': OPCODES.SHR,
  '>>>=': OPCODES.USHR,
};

// ---------------------------------------------------------------- 编译期

/**
 * 函数体 → 字节码。编译不了就返回 null（调用方保留原函数，不静默产出错代码）。
 *
 * 失败一律返回 null 而不是抛错：嵌套档是**可选增强**，遇到不支持的语法就退让，
 * 让单层档接手。宁可少保护一层，也不能产出算错的字节码 —— 后者会让产物
 * 算出错误的值，且极难归因。
 *
 * @returns {{code:Uint8Array, slots:number, consts:number[]}|null}
 */
function compileBody(body, emit, locals, budget) {
  // budget 是"还能编译多少条语句"的粗略额度，防止深递归把构建期卡住。
  // 超了就返回 null，外层放弃这个函数。
  if (budget.n <= 0) return false;
  budget.n--;

  for (const st of body) {
    if (!compileStmt(st, emit, locals, budget)) return false;
  }
  return true;
}

/** 条件表达式：编译成 JZ/JMP 的一对分支，返回 true 表示两分支都编过 */
function compileCond(node, emit, locals, budget, jumpIfZero) {
  if (!compileExpr(node, emit, locals, budget)) return false;
  // 条件值留一个副本：EQ/LT 之类的比较不消费，但裸值要留给分支判断
  if (jumpIfZero) {
    emit.insn(OPCODES.DUP);            // DUP：复制条件值供下方 JZ 读
    const j = emit.placeholder();
    emit.insn(OPCODES.POP);      // 另一份丢弃，保持栈平衡
    return j;
  }
  return -1;
}

function compileStmt(node, emit, locals, budget) {
  if (budget.n <= 0) return false;

  switch (node.type) {
    case 'VariableDeclaration': {
      if (node.kind !== 'var') return false;   // 只收 var，let/const 的块级语义另有含义
      for (const d of node.declarations) {
        if (!d.init) {
          // 无初值：`var a;` 之后 a 是 undefined，不是 0。
          // 内核的栈与槽都只装 32 位量，装不下 undefined —— 所以这一档
          // 直接退让给单层档。首版压 0，于是 `var a; return a;` 得 0 而不是
          // undefined：能跑、不报错，只是值不对。
          return false;
        }
        if (!compileExpr(d.init, emit, locals, budget)) return false;
        const s = locals.slot(nameOf(d.id));
        emit.insn(OPCODES.SET, s);
      }
      return true;
    }

    case 'ExpressionStatement':
      if (!compileExpr(node.expression, emit, locals, budget)) return false;
      // 表达式语句只求值不消费：把结果弹掉，否则栈越积越深。
      //
      // 赋值与自增也**要弹**：它们的"自身有值"是靠 DUP 留下的一份，弹掉的
      // 正是那份（SET 只写不推）。首版误以为"赋值已经处理过了"而不弹，
      // `s = s + i` 就把下一条 GET 的值吃掉，循环体算成错的数，
      // 而栈深看起来仍然平衡，极难发现。
      if (producesValue(node.expression)) emit.insn(OPCODES.POP);
      return true;

    case 'ReturnStatement': {
      if (node.argument) {
        if (!compileExpr(node.argument, emit, locals, budget)) return false;
      } else {
        emit.insn(OPCODES.PUSH, 0);
      }
      emit.insn(OPCODES.RET);
      return true;
    }

    case 'BlockStatement':
      return compileBody(node.body, emit, locals, budget);

    case 'IfStatement': {
      if (!compileExpr(node.test, emit, locals, budget)) return false;
      emit.insn(OPCODES.DUP);                  // 留一份给 JZ
      const jz = emit.placeholder();
      emit.insn(OPCODES.POP);                  // 分支体不消费条件值
      let ok = true;
      if (node.consequent) ok = compileStmt(node.consequent, emit, locals, budget);
      if (ok && node.alternate) {
        // 有 alternate：JZ 落在 alternate 的第一条；JMP 跳过 alternate 体。
        // 两个偏移都要等各自的终点确定后再回填。
        const jmpAt = emit.length / INSN_W;
        emit.insn(OPCODES.JMP, 0);
        const altStart = jmpAt + 1;
        emit.patch(jz, OPCODES.JZ, (altStart - jz) & 0xff);
        ok = compileStmt(node.alternate, emit, locals, budget);
        const after = emit.length / INSN_W;
        emit.patch(jmpAt, OPCODES.JMP, (after - jmpAt) & 0xff);
      } else {
        const after = emit.length / INSN_W;
        emit.patch(jz, OPCODES.JZ, (after - jz) & 0xff);
      }
      return ok;
    }

    case 'ForStatement':
      return compileFor(node, emit, locals, budget);

    case 'WhileStatement':
      return compileWhile(node, emit, locals, budget);

    case 'BreakStatement':
      return false;    // 跳出循环需要帧记录，内核暂不支持

    case 'ContinueStatement':
      return false;

    default:
      return false;    // 不认识的语句：放弃整个函数
  }
}

function compileFor(node, emit, locals, budget) {
  if (node.init) {
    if (node.init.type === 'VariableDeclaration') {
      if (!compileStmt(node.init, emit, locals, budget)) return false;
    } else {
      if (!compileExpr(node.init, emit, locals, budget)) return false;
      emit.insn(OPCODES.POP);
    }
  }
  const top = emit.length / INSN_W;

  // 条件：无 test 视为真（for(;;)）
  let exitJmp = -1;
  if (node.test) {
    if (!compileExpr(node.test, emit, locals, budget)) return false;
    emit.insn(OPCODES.DUP);                        // DUP
    const jz = emit.placeholder();
    emit.insn(OPCODES.POP);
    // 前跳距离要等循环体编完才知道，先记着
    exitJmp = jz;
  }

  if (!compileStmt(node.body, emit, locals, budget)) return false;

  if (node.update) {
    // ++/-- 是 UpdateExpression，不是 AssignmentExpression。这里做等价展开：
    // a++ 读槽 → 加 1 → 写回。展开成显式指令比新增一条 INC 指令更划算，
    // 而且 INC 在内核里目前没有定义。
    if (!compileUpdate(node.update, emit, locals, budget)) return false;
  }
  // 无条件跳回循环顶部。
  //
  // 偏移是**相对当前这条 JMP** 的：`jump(delta)` 把 pc 加上 delta，所以
  // delta = top - self。首版写成 top - (length/INSN_W - 1)，而 self 正是
  // length/INSN_W - 1 —— 两者相消，delta 恒等于 top，跳到"绝对位置 top"，
  // 落在程序尾之外。循环于是永不退出，跑满 limit 被判失败。
  const self = emit.length / INSN_W;
  emit.insn(OPCODES.JMP, 0);
  const backIdx = self;
  emit.patch(backIdx, OPCODES.JMP, (top - backIdx) & 0xff);

  if (exitJmp >= 0) {
    // 出口跳到循环之后：目标就是当前末尾（RE 之后那条）
    const after = emit.length / INSN_W;
    emit.patch(exitJmp, OPCODES.JZ, (after - exitJmp) & 0xff);
  }
  return true;
}

function compileWhile(node, emit, locals, budget) {
  const top = emit.length / INSN_W;
  if (!compileExpr(node.test, emit, locals, budget)) return false;
  emit.insn(OPCODES.DUP);
  const jz = emit.placeholder();
  emit.insn(OPCODES.POP);
  if (!compileStmt(node.body, emit, locals, budget)) return false;
  // 回跳：delta = top - self（self 是这条 JMP 自己的下标），同 compileFor。
  const self = emit.length / INSN_W;
  emit.insn(OPCODES.JMP, 0);
  emit.patch(self, OPCODES.JMP, (top - self) & 0xff);
  const after = emit.length / INSN_W;
  emit.patch(jz, OPCODES.JZ, (after - jz) & 0xff);
  return true;
}

function compileExpr(node, emit, locals, budget) {
  if (budget.n <= 0) return false;

  switch (node.type) {
    case 'NumericLiteral': {
      const v = node.value | 0;
      // PUSH 的 oa 是**单字节**，装不下负数，也装不下 >255 的值。
      // -128..-1 与 256..65535 都退让给单层档，而不是截断——截断会算出
      // 完全不同的值且不报错（首版 -7 被截成 249）。
      if (v < 0 || v > 255) return false;
      emit.insn(OPCODES.PUSH, v);
      return true;
    }

    case 'Identifier': {
      const name = node.name;
      if (!locals.has(name)) return false;   // 编译不到的自由变量：交给外层闭包
      emit.insn(OPCODES.GET, locals.slot(name));
      return true;
    }

    case 'UpdateExpression':
      return compileUpdate(node, emit, locals, budget);

    case 'AssignmentExpression': {
      const left = node.left;
      if (left.type !== 'Identifier') return false;
      const s = locals.slot(left.name);
      if (node.operator === '=') {
        if (!compileExpr(node.right, emit, locals, budget)) return false;
        emit.insn(OPCODES.DUP);                 // DUP：赋值表达式本身也有值
        emit.insn(OPCODES.SET, s);
        return true;
      }
      // 复合赋值（+= -= *= …）：展开成 读槽 → 运算 → 写回。
      //
      // 闸门用 intOnly 而不是 numeric：ADD 是 (x+y)|0，浮点会被截断。
      // 原来只判"是数值"，于是 `var s=1.5; s+=2;` 静默算错（3 而不是 3.5）。
      // 其余复合赋值同样落到 |0 算术上，所以闸门统一，不只给 += 设。
      if (!intOnly(left, locals)) return false;
      if (node.operator === '+=' && !intOnly(node.right, locals)) return false;
      const binOp = COMPOUND[node.operator];
      if (!binOp) return false;
      emit.insn(OPCODES.GET, s);
      if (!compileExpr(node.right, emit, locals, budget)) return false;
      emit.insn(binOp);
      emit.insn(OPCODES.SET, s);
      emit.insn(OPCODES.GET, s);          // 赋值表达式的值
      return true;
    }

    case 'BinaryExpression': {
      if (node.operator === '&&' || node.operator === '||') {
        // 短路：编成分支而非算术
        return compileShortCircuit(node, emit, locals, budget);
      }
      return compileBinary(node, emit, locals, budget);
    }

    case 'UnaryExpression': {
      if (node.operator === '-') {
        // 数值字面量取负直接折叠。但折叠结果装不进单字节 PUSH 时不能用
        // PUSH 承载——改为「压入原值 + NEG」，两条指令但取值域不受限。
        if (node.argument.type === 'NumericLiteral') {
          const v = node.argument.value | 0;
          if (v < 0 || v > 255) return false;
          if (-v >= 0 && -v <= 255) {
            emit.insn(OPCODES.PUSH, -v);
          } else {
            emit.insn(OPCODES.PUSH, v);
            emit.insn(OPCODES.NEG);
          }
          return true;
        }
        if (!compileExpr(node.argument, emit, locals, budget)) return false;
        emit.insn(OPCODES.NEG);
        return true;
      }
      if (node.operator === '!') {
        if (!compileExpr(node.argument, emit, locals, budget)) return false;
        // 逻辑非：与 0 比较后取反
        emit.insn(OPCODES.PUSH, 0);
        emit.insn(OPCODES.EQ);
        return true;
      }
      if (node.operator === '~') {
        if (!compileExpr(node.argument, emit, locals, budget)) return false;
        emit.insn(OPCODES.NOT);
        return true;
      }
      return false;
    }

    default:
      return false;
  }
}

function compileBinary(node, emit, locals, budget) {
  const op = node.operator;

  // `+` 在 JS 里同时是数值加与字符串拼接，语义**依赖运行期类型**。内核的 ADD
  // 只做数值运算：遇到字符串会得到 NaN 或 0，而产物照样"能跑"，只是值错了
  // ——这类错误几乎无法归因。
  //
  // 所以只有能**静态证明两侧都是数值**时才编译成 ADD：
  //   · 两侧都是数值字面量 → 直接折叠
  //   · 两侧都绑定到已知数值的槽（var x = <数值>）→ ADD
  // 其余情况（涉及字符串、函数返回、复杂表达式）一律返回 false 交给单层档。
  if (op === '+') {
    const l = node.left, r = node.right;
    if (l.type === 'NumericLiteral' && r.type === 'NumericLiteral') {
      // 折叠前必须确认两侧都是**整数**。原先只判"是数值字面量"，于是
      // `1.5 + 2` 被折成 (1.5+2)|0 = 3 —— 原生是 3.5，产物不报错、只是值错了。
      if (!Number.isInteger(l.value) || !Number.isInteger(r.value)) return false;
      const v = (l.value + r.value) | 0;
      if (v < 0 || v > 255) return false;
      emit.insn(OPCODES.PUSH, v);
      return true;
    }
    // 统一走"两侧静态确定为**整数**"这一条。写成 if/else 列举组合会漏：
    // `a*b + a + b` 里最外层 + 的左侧是 BinaryExpression 而非 Identifier，
    // 按"字面量 or 标识符"枚举就会把整个表达式退让掉——而它明明是纯数值算式。
    //
    // 这里用 intOnly 而不是 isNumericExpr(..., numeric)：ADD 是 (x+y)|0，
    // 浮点会被截断。numeric 只保证"是数"，不保证"是 32 位整数"，
    // 两者对 ADD 来说差着一条静默算错的缝（`var s=1.5; return s+2;`）。
    // 其余算术运算符早就用 intOnly 了，只有 + 漏了。
    if (intOnly(l, locals) && intOnly(r, locals)) {
      if (!compileExpr(l, emit, locals, budget)) return false;
      if (!compileExpr(r, emit, locals, budget)) return false;
      emit.insn(OPCODES.ADD);
      return true;
    }
    return false;    // 其余 +（含字符串、含浮点）交给单层档
  }

  const cop = CMPOP[op];
  if (cop) {
    if (!compileExpr(node.left, emit, locals, budget)) return false;
    if (!compileExpr(node.right, emit, locals, budget)) return false;
    emit.insn(cop);
    return true;
  }

  const bop = BINOP[op];
  if (bop) {
    // 除法与取余一律不编译。这不是保守，是内核的能力边界：
    // DIV/MOD 按 |0 走，5/2 在 JS 里是 2.5。编译器不做常量求值，
    // 所以无法知道"这次是不是碰巧能整除"——同一个指令形态遇到能整除的输入
    // 看起来是对的，遇到不能整除的就静默算错。这类错最难归因，所以整族退让。
    //
    // intOnly 闸门管的是**递归**情形：a*b 里 a 若来自分数表达式就不该编译。
    // 两者都要，各挡一类。
    if (op === '/' || op === '%') return false;
    if (!intOnly(node.left, locals) || !intOnly(node.right, locals)) return false;
    if (!compileExpr(node.left, emit, locals, budget)) return false;
    if (!compileExpr(node.right, emit, locals, budget)) return false;
    emit.insn(bop);
    return true;
  }
  return false;
}

/** 该表达式在编译期可证明是整数（字面量整数 / 数值槽 / 整数运算组合） */
function intOnly(node, locals) {
  if (!node) return false;
  switch (node.type) {
    case 'NumericLiteral':
      return Number.isInteger(node.value);
    case 'Identifier':
      return locals.numericInt ? locals.numericInt.has(node.name) : false;
    case 'UnaryExpression':
      return (node.operator === '-' || node.operator === '~')
        && intOnly(node.argument, locals);
    case 'BinaryExpression': {
      const op = node.operator;
      if (['<', '<=', '>', '>=', '==', '!=', '===', '!==', '&', '|', '^', '<<', '>>', '>>>'].includes(op)) {
        return true;   // 比较给 0/1，位运算与移位本就取整
      }
      // / 与 % 一律不算整数表达式。内核的 DIV/MOD 都按 |0 走，
      // 而 5/2 在 JS 里是 2.5 —— 同一个指令形态遇到能整除的输入"碰巧对了"，
      // 遇到不能整除的就静默错。编译器不做常量求值，所以没有"这次安全"的判断。
      if (op === '/' || op === '%') return false;
      return intOnly(node.left, locals) && intOnly(node.right, locals);
    }
    default:
      return false;
  }
}

/** 是否字面量 0（除以 0 得 Infinity，与 |0 截断的结果不同） */
function isZeroLiteral(node) {
  return node && node.type === 'NumericLiteral' && node.value === 0;
}

/** && / || 编成分支：左侧不成立就短路 */
function compileShortCircuit(node, emit, locals, budget) {
  if (!compileExpr(node.left, emit, locals, budget)) return false;
  emit.insn(OPCODES.DUP);                     // DUP：结果值
  const isAnd = node.operator === '&&';
  // && 时左侧假 → 走右侧；|| 时左侧真 → 走右侧。
  // 统一编成 "条件不满足就跳过右侧"，所以比较方向随运算符取反。
  emit.insn(OPCODES.PUSH, 0);
  emit.insn(isAnd ? OPCODES.EQ : OPCODES.NE);  // 左假(==0) / 左真(!=0)
  const j = emit.placeholder();
  emit.insn(OPCODES.POP);
  if (!compileExpr(node.right, emit, locals, budget)) return false;
  const dist = (emit.length / INSN_W - 1) - j;
  emit.patch(j, OPCODES.JZ, dist & 0xff);
  return true;
}

/**
 * 该表达式编译完后栈上是否留了值（决定语句位置要不要 POP）。
 *
 * 赋值与自增也算：它们靠 DUP 留下"表达式自身的结果"，SET 只写不推。
 */
function producesValue(node) {
  switch (node.type) {
    case 'NumericLiteral':
    case 'Identifier':
    case 'AssignmentExpression':
    case 'BinaryExpression':
    case 'UnaryExpression':
    case 'UpdateExpression':
      return true;
    default:
      return false;
  }
}

/**
 * UpdateExpression（++/--）展开成显式指令。
 *
 * 编译成 `a++` 等价于：读槽 → 加/减 1 → 写回 → 留下旧值（后缀）或新值（前缀）。
 * 只支持后缀形式出现在语句位置（结果丢弃），前缀形式留值。
 *
 * 只吃「作用在局部槽上的」形式：`i++`、`++i`。作用在成员/下标上的
 * （`a.b++`、`a[i]++`）返回 false 交给单层档。
 */
function compileUpdate(node, emit, locals, budget) {
  const arg = node.argument;
  if (!arg || arg.type !== 'Identifier') return false;
  if (!locals.has(arg.name)) return false;
  const isInc = node.operator === '++';
  const isPre = node.prefix === true;
  const s = locals.slot(arg.name);
  if (isPre) emit.insn(OPCODES.GET, s);          // 前缀：先留下槽的值
  emit.insn(OPCODES.GET, s);
  emit.insn(OPCODES.PUSH, 1);
  emit.insn(isInc ? OPCODES.ADD : OPCODES.SUB);
  emit.insn(OPCODES.SET, s);
  if (!isPre) emit.insn(OPCODES.GET, s);         // 后缀：留下旧值
  return true;
}

function nameOf(id) {
  return id && id.type === 'Identifier' ? id.name : null;
}

/**
 * 预扫描函数体：定槽号，并标出**静态确定为数值**的槽。
 *
 * 槽号必须**先扫完再编译**：`for (var i = 0; ...)` 里的 i 在 body 里先被用到，
 * 边编边分配会拿到不同槽号。
 *
 * numericSlots 是给 `+` 用的：JS 的 + 会因类型不同变成拼接，而内核的 ADD 只做
 * 数值运算。这里只把「初值是数值字面量」或「初值是另一个已知数值槽的运算结果」
 * 的变量标为数值，其余一律不算 —— 于是编译器只在能证明的情况下才发 ADD。
 *
 * 注意这里**不做数据流分析**：`var a = 1; a = "s"; a + b` 这种先赋数字后赋串的
 * 情况会被误判为数值相加。代价是那种代码算错，而正确做法是放弃整函数。
 * 所以下面还有一道保险：只要函数体内出现过对已标记槽的**非数值赋值**，
 * 就把该槽的标记撤掉。这不是完整的分析，但把常见情况挡住了，剩下的交给用户
 * 不要写这种代码（或者不启用嵌套档）。
 */
function preScan(body, locals) {
  for (const st of body) {
    if (!st || st.type !== 'VariableDeclaration') continue;
    for (const d of st.declarations) {
      const n = nameOf(d.id);
      if (n) locals.slot(n);
    }
  }
}

/** 该表达式在编译范围内是否静态确定为数值 */
function isNumericExpr(node, locals, numericSlots) {
  if (!node) return false;
  switch (node.type) {
    case 'NumericLiteral':
      return true;
    case 'Identifier':
      return numericSlots.has(node.name);
    case 'UnaryExpression':
      return node.operator === '-' || node.operator === '~'
        ? isNumericExpr(node.argument, locals, numericSlots)
        : false;
    case 'BinaryExpression': {
      const op = node.operator;
      // 这几个运算符在 JS 里不做类型转换，数值性由两侧继承
      if (op === '+') {
        // + 可能是拼接，两侧都确定为数值才算
        return isNumericExpr(node.left, locals, numericSlots)
          && isNumericExpr(node.right, locals, numericSlots);
      }
      if (['-', '*', '/', '%', '&', '|', '^', '<<', '>>', '>>>'].includes(op)) {
        return isNumericExpr(node.left, locals, numericSlots)
          && isNumericExpr(node.right, locals, numericSlots);
      }
      // 比较的结果是布尔（0/1），也是数值
      if (['<', '<=', '>', '>=', '==', '!=', '===', '!=='].includes(op)) return true;
      return false;
    }
    default:
      return false;
  }
}

/**
 * 第二遍：标出数值槽，并对"已标数值槽被赋非数值"的情况撤标。
 *
 * 这不是完整数据流分析（不做循环迭代、不做 phi 节点），只是挡住
 * "先赋数字、后赋字符串"这类直接自相矛盾的写法。
 */
function markNumericSlots(body, locals, params) {
  const numeric = new Set();
  // 形参直接标为数值（且整数）。
  //
  // ====================== 这一条是本档最大的能力边界 ======================
  //
  // 内核的算术按 |0 走（(x+y)|0、(x*y)|0、(-x)|0），所以它只在**参数与中间值
  // 全程是 32 位整数**时才与原生等价。形参的类型编译期无从得知，只能由调用方
  // 保证 —— 于是这里是整档唯一一处"假设输入类型"的地方。
  //
  // 假设错了的后果不是报错，是**静默算错**：f(a,b){return a+b} 被调用成
  // f("3", 4) 时原生得 "34"，内层得 7。函数不抛异常、控制流照跑，只是结果不对。
  //
  // 为什么不干脆不标（让带参数的函数一律编不了）：那样这一档几乎保护不了任何
  // 真实函数——真实代码里几乎每个函数都有形参。也不为什么在运行期加类型检查
  // 然后回退：回退需要留一份**未保护的原始函数体**在产物里，那等于把这一档
  // 要藏的东西直接交出去。
  //
  // 所以这是明确的取舍：**内层档只适用于整数域的数值函数**，它不是"更强的保护"，
  // 而是"另一类函数的保护"，用错地方会静默出错。选项说明里写死了这一点。
  for (const p of (params || [])) numeric.add(p);
  // 先把所有声明的槽建出来（isNumericExpr 查的是"这个槽是不是数值"，
  // 而不是"这个槽存在吗"，所以顺序上可以先建后判）。
  for (const st of walkStmts(body)) {
    if (st.type !== 'VariableDeclaration') continue;
    for (const d of st.declarations) {
      const n = nameOf(d.id);
      if (n) locals.slot(n);
    }
  }
  // 迭代到不动点：复合赋值（s += i）与自增会把数值性传播给别的槽，
  // 单遍按源码顺序走会漏掉"先引用后声明"的情况（累加循环里的
  // s = s + i，s 的数值性要等 i 定了才知道）。最多 4 轮，再不收敛就放弃标记。
  for (let round = 0; round < 4; round++) {
    let changed = false;
    for (const st of walkStmts(body)) {
      if (st.type !== 'VariableDeclaration') continue;
      for (const d of st.declarations) {
        const n = nameOf(d.id);
        if (!n || !d.init) continue;
        if (!numeric.has(n) && isNumericExpr(d.init, locals, numeric)) {
          numeric.add(n); changed = true;
        }
      }
    }
    if (!changed) break;
  }
  // 撤标：任何把数值槽改成非数值的赋值
  for (const st of walkStmts(body)) {
    if (st.type === 'AssignmentExpression' && st.operator === '='
        && st.left.type === 'Identifier') {
      const n = st.left.name;
      if (numeric.has(n) && !isNumericExpr(st.right, locals, numeric)) numeric.delete(n);
    }
  }
  return numeric;
}

/**
 * 标记整数槽：在 numeric 的基础上再要求初值/表达式不含除法。
 *
 * 内核算术按 |0 走，而 JS 的 / 会产生小数。`28/5` 在 JS 里是 5.6、内核给 5，
 * 产物照样能跑只是值错了 —— 所以凡是可能涉及除法的整数槽都不标，
 * 让用到它们的算式退让给单层档。
 */
function markIntSlots(body, numeric, params) {
  const ints = new Set();
  // 形参一律当整数种子：与 markNumericSlots 里同一个 int32 假设。
  for (const p of (params || [])) ints.add(p);
  for (let round = 0; round < 4; round++) {
    let changed = false;
    for (const st of walkStmts(body)) {
      if (st.type !== 'VariableDeclaration') continue;
      for (const d of st.declarations) {
        const n = nameOf(d.id);
        if (!n || !d.init || ints.has(n)) continue;
        if (!numeric.has(n)) continue;
        if (intOnly(d.init, { numericInt: ints })) { ints.add(n); changed = true; }
      }
    }
    if (!changed) break;
  }
  return ints;
}

/** 深度优先遍历所有语句（含嵌套块），不进入函数内部 */
function* walkStmts(body) {
  for (const st of body) {
    if (!st) continue;
    yield st;
    switch (st.type) {
      case 'BlockStatement':
        yield* walkStmts(st.body);
        break;
      case 'IfStatement':
        if (st.consequent) yield* walkStmts([st.consequent]);
        if (st.alternate) yield* walkStmts([st.alternate]);
        break;
      case 'ForStatement':
        // for 的 init 里的 `var i = 1` 是 i 唯一的声明处，不扫它 i 就不会被
        // 标成数值槽，于是循环体里的 `i++` / `s+i` 全部退让 —— 表现是
        // 最普通的累加循环编译不过。
        if (st.init && st.init.type === 'VariableDeclaration') yield st.init;
        if (st.body) yield* walkStmts([st.body]);
        break;
      case 'WhileStatement':
        if (st.body) yield* walkStmts([st.body]);
        break;
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------- 编译入口

/**
 * 把一个函数体编译成嵌套档字节码。
 *
 * @param {Array} body 函数体的 statement 数组
 * @param {number} shift 操作码变换偏移
 * @param {number} budgetN 语句条数上限
 * @param {string[]} [paramNames] 形参名，按顺序。
 *
 *   **形参必须传进来**，否则带参数的函数一律编不了：Locals 的槽是在编译过程中
 *   由 var 声明现场分配的，参数不声明任何东西，于是 `locals.has('a')` 为 false，
 *   Identifier 分支直接返回 false，整个函数退回单层档。这不是"边界"，是漏了 ——
 *   真实代码里几乎每个函数都有形参。
 *
 * @returns {{code:Uint8Array, slots:number, shift:number, params:string[]}|null}
 *   编不了返回 null。**调用方必须检查 null**：静默产出一份错字节码的后果是
 *   产物能跑、值是错的，只在用到返回值的地方暴露。
 */
export function compileNested(body, shift, budgetN, paramNames) {
  const params = Array.isArray(paramNames) ? paramNames : [];
  const locals = new Locals();
  // 形参槽**先**占掉：槽号按分配顺序递增，形参排在 var 之前，于是序言里的
  // 槽号与字节码里的槽号天然一致，不需要额外记一张映射表。
  for (const p of params) locals.slot(p);
  preScan(body, locals);
  locals.numeric = markNumericSlots(body, locals, params);
  locals.numericInt = markIntSlots(body, locals.numeric, params);
  // 槽位数不能超过 255（oa 是单字节）
  if (locals.size > 255) return null;
  // 槽 0 从来没被写就被读的话，读到的是建表时填的 0，而原生是 undefined。
  // 形参可以合法地少于声明的个数（f(1) 调 f(a,b)），那种情况下漏掉的形参槽
  // 就会躺着一个 0。所以**实际形参数必须写进字节码**——由序言的 ARGV 条数
  // 体现，注入层据此决定传几个实参。这里只做一次自检。
  if (locals.size === 0 && params.length > 0) return null;
  const emit = new Emit(shift);
  const budget = { n: budgetN || 400 };
  // 首条固定一条 NOP。
  //
  // 它的作用是给"pc 从 0 开始"一个明确的起点：入口处 pc=0 指向它，
  // 之后才是真正的指令。这样字节码非空这件事有个可判定的形式
  // （第一条永远是 NOP），也让反汇编时"程序头"一眼可辨。
  //
  // 曾经的写法是发一条占位的 MUL 再 patch 成 NOP —— 那是硬编码操作码的
  // 另一个来源：操作码表重新分段后 0x2a 变成了别的指令，占位符本身错了，
  // 而 patch 会把它改回 NOP 所以"看起来对"，只有 NOP 的语义变化才会暴露问题。
  // 现在直接发 OPCODES.NOP，不绕。
  emit.insn(OPCODES.NOP);
  // 序言：ARGV i ; SET slot_i
  //
  // 逐个搬而不是一次全搬，是因为槽号由分配顺序决定、与形参下标不一定同号
  // （形参可能重名或与 var 冲突）。搬错了槽，函数读到的就是另一个变量的值。
  for (let i = 0; i < params.length; i++) {
    emit.insn(OPCODES.ARGV, i);
    emit.insn(OPCODES.SET, locals.slot(params[i]));
  }
  if (!compileBody(body, emit, locals, budget)) return null;
  emit.insn(OPCODES.HALT);
  return {
    code: emit.toBytes(),
    slots: locals.size,
    shift,
    params,
    insnCount: emit.length / INSN_W,
  };
}

export default { compileNested, Emit, Locals, OPCODES, INSN_W, encodeOpcode };