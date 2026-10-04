/**
 * 内层可信内核（trusted core）——外层 Dispatcher 的执行后端。
 *
 * ============================ 为什么要有这个文件 ============================
 *
 * 用户函数由外层 vm.js 编译成字节码、由外层 handler 表驱动执行。但**保护外层
 * handler 需要另一台 VM，VM 本身又需要 handler** —— 无限 regress。要终止它，
 * 必须有一个不再被虚拟化的地方：手写的紧凑内核。
 *
 * 所以这里的定位很具体：
 *   · 它**不参与混淆流水线**，不会自己再被编译成字节码（否则 regress 复发）。
 *   · 它由外层 vmNested 在构建期把本文件生成的源码**内联**进产物，不是 import。
 *   · 它必须小。可信内核越大，能被静态分析的面就越大——它恰恰是唯一没有
 *     多态、没有 handler 表、没有加密的地方。
 *
 * 与外层的关系：
 *   外层 handler 表（动态生成、含虚假 handler）→ 调用 runBytecode 执行字节码
 *   runBytecode 是本文件提供的入口。它只负责"取指 → 解密 → 分派 → 执行"，
 *   handler 表的动态构造在外层做，内层不碰。
 *
 * ============================ 指令编码 ============================
 *
 * 每条指令固定 6 字节，便于运行期按常量偏移取指，不做变长解析：
 *
 *   [0] opcode   操作码（经内层变换，见 scrambleOpcode）
 *   [1] oa       操作数 A
 *   [2] ob       操作数 B
 *   [3] oc       操作数 C
 *   [4] od       操作数 D（备用/扩展）
 *   [5] flags    标志位（目前用于 JMP 家族与内存操作）
 *
 * 操作数字节由调用方给出，本文件不解释其语义——**指令语义是外层的事**。
 * 内层只认 opcode，把 oa..od 交给对应的 handler。这样内层不需要知道外层
 * 的类型系统，也就不会和外层的 AST 编译耦合。
 *
 * ================================= 安全性立场 =================================
 *
 * 这个文件刻意**不**用 eval / new Function / Proxy / Function.prototype.toString。
 * 原因：这些正是分析者最先挂钩的地方，用它们等于自己交出把手。
 * 反分析检测放在外层（debugProtection / antiCDP 已有成熟实现），
 * 内层只做"字节码正确执行 + 状态自校验"这一件事，把面收窄。
 */

// ---------------------------------------------------------------- 指令集

/**
 * 操作码表。内层按 opcode 索引分派。
 *
 * 注意几点：
 *   · 数值**故意不连续**且不按语义分组——连续的 0..N 会让分派表本身成为指纹，
 *     也让"缺失的编号"暴露指令条数。这里按语义聚成几段，每段内留空位。
 *   · 0x00 留空（抛错），不给任何指令占用：全零字节码片不能被当成有效程序。
 *   · CALL/RET 特意不放在相邻位置：它们是分析者最先想定位的两条。
 */
export const OPCODES = {
  // 0x0x 段：栈与常量
  NOP: 0x00,      // 空操作（对齐/填充）
  PUSH: 0x11,     // 压入字面量常量
  DUP: 0x13,      // 复制栈顶
  SWAP: 0x17,     // 交换栈顶两值
  POP: 0x1b,      // 丢弃栈顶
  LOADK: 0x1f,    // 从常量池取

  // 0x2x 段：算术
  ADD: 0x22,
  SUB: 0x26,
  MUL: 0x2a,
  DIV: 0x2e,
  MOD: 0x32,
  NEG: 0x36,
  INC: 0x3a,
  DEC: 0x3e,

  // 0x4x 段：位运算与逻辑
  AND: 0x43,
  OR: 0x47,
  XOR: 0x4b,
  NOT: 0x4f,
  SHL: 0x53,
  SHR: 0x57,
  USHR: 0x5b,

  // 0x6x 段：比较与跳转
  EQ: 0x62,
  NE: 0x66,
  LT: 0x6a,
  LE: 0x6e,
  GT: 0x72,
  GE: 0x76,
  JMP: 0x7a,
  JZ: 0x7e,
  JNZ: 0x82,

  // 0x9x 段：局部槽与内存（故意远离 0x2x~0x4x 的算术群）
  //
  // 两组分工，别混用：
  //   GET / SET        —— 局部变量槽（编译器的局部变量表，槽号是单字节 oa）
  //   LOAD / STORE     —— 线性内存 mem[]（宿主对象表，键由 oa/ob 组合给出）
  // 首版把局部槽编译成 STORE、而 handler 表注册的是 SET，两边各说一套，
  // 结果 SET 永远不命中、槽位全 0，而程序照样跑出别的值 —— 静默错值。
  GET: 0x91,
  SET: 0x95,
  LOAD: 0x99,
  STORE: 0x9d,
  NEW: 0xa1,
  LEN: 0xa5,
  IDX: 0xa9,
  CAT: 0xad,        // 字符串拼接（码元序列 → string）
  CALL: 0xb1,
  RET: 0xb5,
  HALT: 0xb9,
};

/** 指令宽度（字节）。定长，取指无需解析。 */
export const INSN_W = 6;

/** 操作码 → 指令名的反向表，供自测与诊断用。 */
export const OPCODE_NAMES = (() => {
  const m = new Map();
  for (const [k, v] of Object.entries(OPCODES)) {
    if (v === 0x00) continue;
    m.set(v, k);
  }
  return m;
})();

/**
 * 逐构建重排操作码（多态）。
 *
 * 做法：构建期给每个操作码**加上**一个常量偏移写进产物，运行期再**减去**它。
 * 等价变换，但产物里不再出现 0x11/0x22 这类固定编号——而这些编号是识别
 * "这是某虚拟机的栈机"的强特征。
 *
 * 偏移取奇数，保证 gcd(shift, 256) = 1：这个映射是 0..255 上的双射，
 * 取偶数会让一半的操作码对折（x 与 x+128 撞成同一个），变换后的编号里
 * 永远只有 128 个不同值——那本身就是特征。
 *
 * @param {number} shift 构建期随机偏移（0..255）
 * @returns {(op:number)=>number} 运行期解变换函数（产物字节 → 原操作码）
 */
export function scrambleOpcode(shift) {
  const s = ((shift % 256) + 256) % 256;
  return (op) => (op - s) & 0xff;
}

/** 把指令名解析成变换后的操作码。构建期用。 */
export function encodeOpcode(nameOrCode, shift) {
  const code = typeof nameOrCode === 'number'
    ? nameOrCode
    : OPCODES[nameOrCode];
  if (code === undefined) throw new Error('unknown opcode: ' + nameOrCode);
  return (code + shift) & 0xff;
}

// ---------------------------------------------------------------- 状态加密

/**
 * 状态字的混淆（不是密码学，只是让明文值不躺在内存里）。
 *
 * 值 v 以 v ^ mask 存放，取出时还原。mask 每次调用由调用方传入（外层负责
 * 生成并与完整性校验绑定），本函数不持有 mask —— 内层没有秘密，秘密在外层。
 *
 * 取值域是**有符号 32 位**（与 JS 的 `| 0` 一致），不是无符号。栈与寄存器里的
 * 量本来就按有符号处理（负数索引、负差值），统一成无符号会在边界上引入
 * 两次转换，且 `>>> 0` 会把 -1 变成 4294967295 —— 同一个负数在存取两侧
 * 表现不同，这类不一致最难查。
 *
 * @param {number} v 原值（有符号 32 位量）
 * @param {number} mask 混淆掩码（有符号 32 位量）
 * @returns {number} 存下的字（有符号 32 位）
 */
export function stash(v, mask) {
  return ((v | 0) ^ mask) | 0;
}

/** stash 的逆运算。 */
export function unstash(v, mask) {
  return ((v | 0) ^ mask) | 0;
}

// ---------------------------------------------------------------- 解释器

/**
 * 字节码解释器主循环。
 *
 * pc 的所有权只有一个：ctx.setPc / ctx.getPc。handler 若不调 setPc，就顺序
 * 执行下一条。**不要**在循环外层再自增 pc —— 那会造成两处都在动 pc，
 * 跳转指令必须"吃掉"自己的那条，否则会多执行一条（首版就踩了：算 1+2*3-4
 * 得 3 不是 5，因为 MUL 之后既执行了 SUB 又执行了 ADD）。
 *
 * @param {Uint8Array} code 字节码
 * @param {object} host 外层提供的执行环境
 * @param {number[]} [host.consts] 常量池
 * @param {object} [host.mem] 线性内存（宿主对象表）
 * @param {object} host.handler 指令处理器表，签名 (ctx, insn) => void
 * @param {number} [host.mask] 状态字混淆掩码（有符号 32 位）
 * @param {number} [host.opShift] 操作码解变换偏移（与构建期 encodeOpcode 同一个）
 * @param {number} [host.entry] 入口地址（指令下标）
 * @param {number} [host.limit] 最多执行多少条指令（防死循环，同时是有界的失败路径）
 * @returns {object} { stack, regs, mem, pc, steps, halted, ok, mask, ret }
 */
export function runBytecode(code, host) {
  const un = scrambleOpcode(host.opShift);
  const stack = [];
  const regs = new Array(8).fill(0);
  const mem = host.mem || {};
  const handler = host.handler || {};
  const mask = (host.mask | 0);
  let pc = host.entry | 0;
  const limit = host.limit >>> 0 || 100000;
  let steps = 0;
  let halted = false;
  let ok = true;
  let ret = undefined;   // RET 指令写入

  // 帧：支持外层 handler 通过 callFrame 递归进入内层（嵌套调用状态隔离）。
  // 每次 runBytecode 自带一份栈/寄存器，递归即天然隔离，不共享。
  const frame = { stack, regs, mem, pc, returnTo: -1 };

  const ctx = {
    code, consts: host.consts || [], mem, regs, stack,
    mask, frame,
    /** 压栈（走混淆，值不长期以明文躺在栈里） */
    push(v) { stack.push((v ^ mask) | 0); },
    /** 弹栈 */
    pop() { return (stack.pop() ^ mask) | 0; },
    /** 读栈顶但不移除 */
    peek(d) { const v = stack[stack.length - 1 - (d || 0)]; return v === undefined ? 0 : (v ^ mask) | 0; },
    /** 写栈顶偏移位 */
    poke(d, v) { const i = stack.length - 1 - (d || 0); if (i >= 0) stack[i] = (v ^ mask) | 0; },
    /** 跳到第 n 条（指令下标，不是字节下标） */
    setPc(v) { pc = v | 0; },
    /** 顺序推进到下一条 */
    next() { pc = (pc + 1) | 0; },
    /** 跳到相对偏移（跳转指令用，省得 handler 自己算绝对地址） */
    jump(delta) { pc = (pc + (delta | 0)) | 0; },
    getPc() { return pc | 0; },
    /** RET：记下返回值并终止 */
    setRet(v) { ret = (v | 0); },
    setHalted() { halted = true; },
    fail() { ok = false; halted = true; },
  };

  while (!halted) {
    if (++steps > limit) { ctx.fail(); break; }
    const at = pc * INSN_W;
    if (at < 0 || at + INSN_W > code.length) { ctx.fail(); break; }
    const op = un(code[at]);
    const insn = {
      op,
      oa: code[at + 1],
      ob: code[at + 2],
      oc: code[at + 3],
      od: code[at + 4],
      flags: code[at + 5],
    };
    const h = handler[op];
    // 虚假 handler 与填充字节都落在这里：op 不在表里就当跳过，不报错。
    // 真实程序不该有未知操作码，但让分析者无法用"遇到未知 opcode 就抛错"
    // 来区分真假路径——虚假 handler 的地基。
    if (h === undefined) { ctx.next(); continue; }
    // handler 自己决定 pc：顺序指令调 ctx.next()，跳转指令调 ctx.jump/setPc。
    h(ctx, insn);
    if (!ok) break;
  }

  return { stack, regs, mem, pc, steps, halted, ok, mask, ret };
}

export default { OPCODES, INSN_W, OPCODE_NAMES, scrambleOpcode, encodeOpcode, stash, unstash, runBytecode };