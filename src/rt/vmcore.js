/**
 * 内层可信内核（trusted core）—— 外层 Dispatcher 的执行后端。
 *
 * ============================ 这个文件的形态 ============================
 *
 * 运行期代码放在 CORE_SRC 这个**字符串**里，而不是写成模块里的函数。原因是
 * 注入产物时需要它的**源码文本**：构建期把这段文本原样 parse 进产物，而不能
 * import 一个模块（产物流水线里没有模块解析）。
 *
 * 为什么不反过来"写成函数、再从源码里抽文本"？因为核心模块图里禁止一切字符串
 * 代码生成（test/minify.js 有断言），不能 eval；而手抄两份必然漂移。
 * 所以单一真相是**这段字符串**：
 *   · 产物侧：原样注入
 *   · 测试侧：test/vmcore.js 把它 eval 出来跑（测试文件不在核心模块图里，
 *     那里的 eval 是允许的）
 * 编译期需要的操作码表则是**真的 JS 对象**（见下），因为编译器要在构建期查它。
 * CORE_SRC 里不含操作码表——运行期只认"解变换后的数字"，不需要知道名字。
 *
 * ============================ 为什么要有一台不被虚拟化的 VM ============================
 *
 * 用户函数由外层 vm.js 编译成字节码、由外层 handler 表驱动。但保护外层 handler
 * 需要另一台 VM，VM 又需要 handler —— 无限 regress。终止点是手写的紧凑内核：
 * 它不参与混淆流水线，因此不会再被自己编译。
 *
 * 代价要说清楚：它小到能被人读完，它的能力边界就是这份保护的边界。
 *
 * ============================ 指令编码 ============================
 *
 * 定长 6 字节，取指按常量偏移算，不做变长解析：
 *   [0] opcode   [1] oa   [2] ob   [3] oc   [4] od   [5] flags
 *
 * 操作数字节由调用方给出，内层**不解释**其语义——指令语义是外层的事。
 * 内层只认 opcode，把 oa..od 原样交给 handler。这样内核不需要知道外层的
 * 类型系统，也就不会和外层的 AST 编译耦合。
 *
 * ================================= 安全性立场 =================================
 *
 * 刻意不用 eval / new Function / Proxy / Function.prototype.toString。
 * 这些正是分析者最先挂钩的地方，内层用了等于自己交出把手。反分析检测放在
 * 外层（debugProtection / antiCDP 已有成熟实现），内层只做"字节码正确执行 +
 * 状态自校验"，把面收窄。
 */

// ---------------------------------------------------------------- 指令集（编译期）

/**
 * 操作码表。内层按 opcode 索引分派，编译器按名字取。
 *
 * 三点讲究：
 *   · 数值**故意不连续**且分段。连续的 0..N 会让分派表本身成为指纹，也能让
 *     人从"缺失的编号"直接数出指令条数。
 *   · 0x00 留给 NOP，且**没有任何指令取 0**：全零字节码片不能被当成有效程序。
 *   · CALL/RET 刻意远离算术群与跳转群（分析者最先想定位的就是这两条）。
 *   · GET/SET 是**局部槽**，LOAD/STORE 是**内存表**。两组分工别混用——首版把
 *     局部槽编译成 STORE 而 handler 表注册 SET，两个不同指令，SET 永不命中、
 *     槽位全 0，而程序照样跑出别的值。
 *   · ARGV 是**形参**，与 LOAD/STORE 的内存表、与 LOADK 的常量表都不同源。
 *     混用同样会静默算错：形参读成常量 0，函数对任何输入都返回同一个值。
 */
export const OPCODES = {
  // 0x1x 段：栈与常量
  NOP: 0x11,
  PUSH: 0x13,
  DUP: 0x17,
  SWAP: 0x1b,
  POP: 0x1f,
  LOADK: 0x23,

  // 0x3x 段：算术
  ADD: 0x31,
  SUB: 0x35,
  MUL: 0x39,
  DIV: 0x3d,
  MOD: 0x41,
  NEG: 0x45,
  INC: 0x49,
  DEC: 0x4d,

  // 0x5x 段：位运算与逻辑
  AND: 0x51,
  OR: 0x55,
  XOR: 0x59,
  NOT: 0x5d,
  SHL: 0x61,
  SHR: 0x65,
  USHR: 0x69,

  // 0x6x 段：只有一个 ARGV（形参）。刻意单开一段而不是塞进 0x1x 或 0x9x ——
  // 那两段已经各自连续占满，插进去会让"段"这个概念消失，而分段的用意正是让
  // 操作码空间看起来不像"某台栈机的编号表"。
  ARGV: 0x6d,

  // 0x7x 段：比较与跳转
  EQ: 0x71,
  NE: 0x75,
  LT: 0x79,
  LE: 0x7d,
  GT: 0x81,
  GE: 0x85,
  JMP: 0x89,
  JZ: 0x8d,
  JNZ: 0x91,

  // 0x9x/0xBx 段：局部槽、内存与调用（刻意远离上面三段）
  GET: 0x95,
  SET: 0x99,
  LOAD: 0x9d,
  STORE: 0xa1,
  NEW: 0xa5,
  LEN: 0xa9,
  IDX: 0xad,
  CAT: 0xb1,
  CALL: 0xb5,
  RET: 0xb9,
  HALT: 0xbd,
};

/** 指令宽度（字节）。定长，取指无需解析。CORE_SRC 里是同一个数。 */
export const INSN_W = 6;

/** 操作码 → 指令名，供自测与诊断。 */
export const OPCODE_NAMES = (() => {
  const m = new Map();
  for (const [k, v] of Object.entries(OPCODES)) m.set(v, k);
  return m;
})();

/**
 * 逐构建重排操作码。
 *
 * 构建期给每个操作码**加上**常量偏移写进产物，运行期再**减去**。等价变换，
 * 但产物里不再出现 0x31/0x71 这类固定编号——而这些编号是识别"这是某个栈机"
 * 的强特征。
 *
 * 偏移取奇数，保证 gcd(shift, 256) = 1：该映射是 0..255 上的双射，取偶数会让
 * 一半操作码对折（x 与 x+128 撞成同一个），变换后的编号里永远只有 128 个不同
 * 值——那本身就是特征。
 *
 * @param {number} shift 构建期随机偏移（0..255）
 * @returns {(op:number)=>number} 产物字节 → 原操作码
 */
export function scrambleOpcode(shift) {
  const s = ((shift % 256) + 256) % 256;
  return (op) => (op - s) & 0xff;
}

/**
 * 把指令名**或操作码数值**变换成产物里写的那个字节。
 *
 * 两种入参都支持，因为调用点天然有两种写法：拿名字查表的，和已经在 OPCODES
 * 里查过一次、拿着数值来的。未知名字**抛错**而不是静默返回 undefined ——
 * undefined 写进字节码会让整片变 NaN，取指全是未知 opcode 被当填充跳过，
 * 最后报"结果不对"，极难归因。
 *
 * @param {string|number} nameOrCode 指令名或操作码数值
 * @param {number} shift 变换偏移
 * @returns {number} 0..255 的变换后操作码
 */
export function encodeOpcode(nameOrCode, shift) {
  let code;
  if (typeof nameOrCode === 'number') {
    code = nameOrCode;
  } else {
    code = OPCODES[nameOrCode];
    if (code === undefined) throw new Error('unknown opcode name: ' + nameOrCode);
  }
  return (code + shift) & 0xff;
}

/**
 * 状态字的混淆。
 *
 * 取值域是**有符号 32 位**（与 JS 的 `| 0` 一致），不是无符号。栈与寄存器里的
 * 量本就按有符号处理（负数索引、负差值）；统一成无符号会在边界上多一次转换，
 * 且 `>>> 0` 把 -1 变成 4294967295 —— 同一个负数在存取两侧表现不同。
 *
 * 这不是密码学，只是让明文值不长期躺在内存里。掩码由调用方传（外层负责生成
 * 并与完整性校验绑定），内核不持有任何秘密。
 */
export function stash(v, mask) { return ((v | 0) ^ mask) | 0; }
/** stash 的逆运算。 */
export function unstash(v, mask) { return ((v | 0) ^ mask) | 0; }

// ---------------------------------------------------------------- 运行期源码

/**
 * 内核的运行期源码。注入产物时原样使用；测试时 eval 出来跑真代码。
 *
 * 这里刻意写成 ES5 风格（var + function，无箭头、无解构、无默认参数）：
 * 内核是要放进任意宿主的最小可信部分，宿主可能没有 ES2015。
 */
export const CORE_SRC = [
  'function VMC_run(code,H){',
  'var un=function(o){return (o-H.opShift)&255;};',
  'var mask=H.mask|0;',
  'var hd=H.handler||{};',
  'var lim=(H.limit>>>0)||100000;',
  'var n=0;var done=0;var good=1;var ret;',
  'var V=H.V||[];',
  'var fr=[],sp=0;',
  'function mkfr(pc0,L0){return {pc:pc0,stk:[],L:L0,base:0};}',
  // 第一帧**必须放进 fr[0]**。否则 RET 时 fr[sp-1] 取到 undefined，
  // 被当成'最外层返回'而直接结束 —— 任何一次函数调用都会把整个执行提前结束掉。
  'var F=mkfr(H.entry|0,H.L||[]);',
  'fr[0]=F;',
  'var stk=F.stk;var pc=F.pc;',
  'var C={code:code,mask:mask,consts:H.consts||[],regs:H.regs||[],mem:H.mem||{}};',
  // 局部槽随帧走：递归时每帧一套，互不干扰（这就是"嵌套调用状态隔离"）。
  'Object.defineProperty(C,"L",{get:function(){return F.L;}});',
  'C.mk=(H.mk===undefined)?mask:(H.mk|0);',
  // ---- 形参 ----
  //
  // 入口实参由宿主直接给（被保护的函数体被替换成一次 run 调用，实参原样传进来）。
  // 少了这一项，内层编译器就只能处理无参函数 —— 而真实代码里几乎每个函数都有
  // 形参，于是"能保护的范围"窄到没有实用价值。
  //
  // 越界返回 undefined 而不是抛错：和栈/槽一样，这里不做类型闸门，由编译期保证。
  'C.args=H.args||[];',
  'C.arg=function(i){return C.args[i|0];};',
  // ---- 值表 ----
  //
  // 栈与槽里存的**不是值本身，而是值表的下标**。原因：值的类型不止整数 ——
  // 字符串、数组、对象、函数都要能过栈，而 XOR 混淆只对整数成立。
  //
  // 把值移出栈、放进值表之后，栈里永远是整数，混淆照旧有效；值的身份以数组
  // 下标的形式露出来，但那只是一个位置，不含类型信息。
  'C.V=V;',
  'C.alloc=function(v){V.push(v);return V.length-1;};',
  'C.push=function(v){stk.push((C.alloc(v)^mask)&0x3fffffff);};',
  'C.pop=function(){var i=stk.pop();return (i===undefined)?0:((i^mask)&0x3fffffff);};',
  'C.peek=function(d){var i=stk[stk.length-1-(d||0)];return i===undefined?0:(i^mask)&0x3fffffff;};',
  'C.poke=function(d,v){var k=stk.length-1-(d||0);if(k>=0){stk[k]=(C.alloc(v)^mask)&0x3fffffff;}};',
  // 取栈顶的**值**而不是下标：tv=看栈顶，pv=弹出并返回。
  'C.tv=function(d){return V[C.peek(d||0)];};',
  'C.pv=function(){return V[C.pop()];};',
  'C.spc=function(v){pc=v|0;};',
  'C.nxt=function(){pc=(pc+1)|0;};',
  'C.jmp=function(d){pc=(pc+(d|0))|0;};',
  'C.gpc=function(){return pc|0;};',
  'C.ret=function(v){ret=v;};',
  'C.stop=function(){done=1;};',
  'C.fail=function(){good=0;done=1;};',
  'C.depth=function(){return sp;};',
  // ---- 调用 / 返回 ----
  //
  // 调用者栈顶连续 argc 个值就是实参。进入新帧时把它们**搬进新帧的栈底**，
  // 被调方读参数只需看自己栈底，不必知道调用者栈长什么样。
  //
  // frame.base 记的是"参数区在调用者栈上的起始高度"，RET 时据此把返回值
  // 压到正确位置。首版没有帧，于是递归会共用同一个 pc，fib 变成死循环 ——
  // 而产物不报错，只是算不出值。
  'C.pushFrame=function(target,argc){',
  '  var nf=mkfr(target,new Array(argc+16));',
  '  nf.base=stk.length-argc;',
  '  for(var i=0;i<argc;i++){nf.stk[i]=stk[nf.base+i];}',
  '  fr[++sp]=nf;F=nf;stk=nf.stk;pc=nf.pc;',
  '};',
  'C.doRet=function(v){',
  '  var c=fr[sp-1];',
  '  if(!c){ret=v;done=1;return;}',
  '  sp--;F=c;stk=c.stk;pc=c.pc;',
  '  stk.length=F.base;',
  '  C.push(v);C.nxt();',
  '  ret=undefined;',
  '};',
  'while(!done){',
  // 深度上限：递归爆栈必须有界失败，不能靠宿主自己的 RangeError ——
  // 那会让产物带着一个不可预期的异常退出，看起来像"随机崩溃"。
  'if(sp>200){C.fail();break;}',
  'if(++n>lim){C.fail();break;}',
  'var at=pc*6;',
  'if(at<0||at+6>code.length){C.fail();break;}',
  'var op=un(code[at]);',
  'var I={op:op,oa:code[at+1],ob:code[at+2],oc:code[at+3],od:code[at+4],fl:code[at+5]};',
  'var f=hd[op];',
  'if(f===undefined){C.nxt();continue;}',
  'F.pc=pc;',
  'f(C,I);',
  'if(!good){break;}',
  '}',
  'return {V:V,pc:pc,n:n,done:done,ok:good,ret:ret,mask:mask,depth:sp};',
  '}',
].join('\n');

export default {
  OPCODES, INSN_W, OPCODE_NAMES,
  scrambleOpcode, encodeOpcode, stash, unstash, CORE_SRC,
};