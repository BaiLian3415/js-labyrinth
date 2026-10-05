/**
 * 内层可信内核（trusted core）—— 用户字节码的执行后端。
 *
 * ============================ 这个文件的形态 ============================
 *
 * 运行期代码是**逐构建生成的源码文本**，而不是模块里的函数。原因是注入产物时
 * 需要它的源码文本：构建期把这段文本原样 parse 进产物，而不能 import 一个模块
 * （产物流水线里没有模块解析）。
 *
 * 为什么不反过来"写成函数、再从源码里抽文本"？因为核心模块图里禁止一切字符串
 * 代码生成（test/minify.js 有断言），不能 eval；而手抄两份必然漂移。
 * 所以单一真相是**buildCore 这个生成器**：
 *   · 产物侧：buildCore(rand) 的输出原样注入
 *   · 测试侧：test/vmcore.js 把它 eval 出来跑（测试文件不在核心模块图里，
 *     那里的 eval 是允许的）
 * 编译期需要的操作码表则是**真的 JS 对象**（见下），因为编译器要在构建期查它。
 * 内核里不含操作码表——运行期只认"解变换后的数字"，不需要知道名字。
 *
 * ============================ 为什么内核要逐构建生成 ============================
 *
 * 这是实测逼出来的。固定内核有个致命性质：**2KB 的 CORE_SRC 每个构建一字不差**。
 * 反编译者读一次、写一个针对 VMC_run 的模板，就能处理此后所有构建 —— 与外层
 * VM 那种"每个构建 handler 表构造与分发循环都不同"相比，是把最难的那一维
 * 保护白送出去。内层赢的是体积（每函数 4.2KB vs 外层 10KB），输的是这一维，
 * 所以必须在这一维上补回来才值得作为一档推出去。
 *
 * 变化点只有一个硬约束：**每一处都必须与原版语义完全等价**。等价性不是靠
 * "看起来一样"，是靠逐点论证（见 buildCore 里每一处的注释）：
 *   · 局部变量改名 —— 纯重命名，作用域内无冲突
 *   · x|0 的多种写法 —— 都等价于 ToInt32(x)（JS 规范里位运算的转换规则）
 *   · var 声明顺序 —— var 提升，顺序不影响语义
 *   · 恒等语句（junk）—— 只对已经是 int32 的量做 ToInt32
 *   · C.L 用取值器还是普通字段 —— 两条路径都在每个换帧点同步
 * 凡是证明不了等价的，一律不做。
 *
 * ============================ 边界 ============================
 *
 * 这一档的能力边界就是它的保护边界：内核小到能被人读完（这正是它不参与混淆
 * 流水线的代价），它认得的指令就是它能保护的东西。编不了的写法一律退让给
 * 外层单层档，不产出半成品。
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
// ---------------------------------------------------------------- 运行期源码

/**
 * 逐构建生成内核源码。
 *
 * ============================ 这个函数的约束 ============================
 *
 * 它生成的是**要被执行**的代码，不是模板占位。任何一个变化点都必须与原版
 * 语义完全等价 —— 而"看起来等价"不算证明。所以下面每一处随机化都配了
 * 等价性论证；凡是论证不了的，不做。
 *
 * 四条随机化维度（按"收益 / 风险"排序）：
 *
 *   1. **局部变量改名**。反编译者第一件事是 grep C.pop / mask / sp 这类名字，
 *    命中即定位。整个内核的局部作用域改名之后，这一手完全失效。
 *    安全性：纯重命名。所有名字在函数内唯一，且内核只引用自己生成的名字。
 *    用两字母随机前缀而不是从词表里挑，是为了不必维护保留字表 ——
 *    没有任何 JS 关键字以两个字母的小写串开头。
 *
 *   2. **x|0 的多种写法**：x|0、~~x、x^0、x|0|0。
 *    等价性：JS 规范里位运算的操作数一律先 ToInt32，而 ToInt32(x) 正是 x|0 的
 *    定义；x^0 的右操作数 ToInt32(0)=0，异或 0 不改变值，所以 x^0 也等于
 *    ToInt32(x)。四条在**任意 number** 上等价，不限于整数。
 *
 *   3. **var 声明顺序**。等价性：var 提升到函数作用域顶部，纯声明之间的顺序对
 *    读取无影响。只打乱纯声明，不打乱派生赋值（var F=mkfr(...) 这类留在原位 ——
 *    虽然 function 声明提升让它其实也可以动，但没必要赌）。
 *
 *   4. **恒等语句（junk）与永不执行的干扰函数**。恒等语句只对**已保证是 int32**
 *    的量做 ToInt32（sp / pc / n / mask / good）；不碰 ret，因为 ret 装任意类型，
 *    ToInt32 会把字符串与对象毁掉。
 *
 * **只放在序言与每调用一次的函数里，绝不放在指令循环和 C.push/C.pop 里** ——
 * 那些是每次执行都走的热路径，往里塞语句等于按指令数放大运行开销。
 * 实测内层已经比原生慢 110 倍，往热路径加东西会直接变成不可用。
 *
 * ES5 约束不变：var + function，无箭头、无解构、无默认参数。宿主可能没有 ES2015。
 *
 * @param {(min:number,max:number)=>number} int 闭区间整数取样器。
 *   传 null 用内置的确定性 LCG —— 测试与 diff 需要内核源码稳定可 diff。
 * @returns {string} 内核源码（ES5）
 */
export function buildCore(int) {
  const R = int || mkDetRng();

  // ---- 名字 ----
  //
  // 形如 `ne` + `z` + 序号（`nez0`、`nez1`…）。
  //
  // 中间那个 **z 是刻意放的**：JS 保留字里没有任何一个含字母 z（break/case/
  // catch/class/const/continue/debugger/default/delete/do/else/enum/export/
  // extends/finally/for/function/if/implements/import/in/instanceof/
  // interface/let/new/null/package/private/protected/public/return/static/
  // super/switch/this/throw/try/typeof/var/void/while/with/yield/await/
  // arguments/eval —— 逐个核过，一个都没有）。所以含 z 的标识符**在构造上就不可能是
  // 保留字**，不必维护词表，也不会因为词表漏词而产出语法错误的产物。
  //
  // 踩过的坑：原来生成的是 `前缀 + 序号`，而序号小于 10 时 base36 只有一位，
  // 名字就成了三个小写字母 —— `new` 恰好三个字母，于是 seed 22 生成了
  // `function f(a,new,b)`，产物直接语法错误。报错信息是 "Unexpected token 'new'"，
  // 与病因（名字生成器）看起来毫无关系。
  const pre = ALPHA[R(0, 25)] + ALPHA[R(0, 25)];
  let seq = 0;
  const nm = () => pre + 'z' + (seq++).toString(36);

  const nCode = nm(), nH = nm();
  const nUn = nm(), nMask = nm(), nHd = nm(), nLim = nm();
  const nN = nm(), nDone = nm(), nGood = nm(), nRet = nm();
  const nV = nm(), nFr = nm(), nSp = nm(), nF = nm(), nStk = nm(), nPc = nm(), nC = nm();
  const nMkfr = nm(), nPc0 = nm(), nL0 = nm();
  const nO = nm(), nI = nm(), nD = nm(), nVv = nm();
  const nNf = nm(), nCfr = nm(), nAt = nm(), nOp = nm(), nIns = nm(), nFnd = nm();

  // ---- 表达式形态 ----
  const I32 = [
    (e) => '(' + e + '|0)',
    (e) => '(~~(' + e + '))',
    (e) => '((' + e + ')^0)',
    (e) => '(' + e + '|0|0)',
  ];
  const i32 = I32[R(0, I32.length - 1)];
  // 取指里的操作码还原：(o - shift) & 255。o 与 shift 都在 0..255，
  // 差值在 [-255,255]，所以 +256 与不加在 &255 之后同余 —— 等价。
  const DEC = [
    (o, s) => '((' + o + '-' + s + ')&255)',
    (o, s) => '(((' + o + '-' + s + ')+256)&255)',
    (o, s) => '(((' + o + '-' + s + ')&255)|0)',
    (o, s) => '(255&((' + o + '-' + s + ')))',
  ];
  const dec = DEC[R(0, DEC.length - 1)];

  // ---- 恒等语句候选 ----
  // 只列已经保证 int32 的量。见上面"只放在序言与每调用一次的函数里"那条说明。
  const IDEN = [
    [nSp, nSp], [nPc, nPc], [nN, nN], [nMask, nMask], [nGood, nGood],
  ];
  const junk = (k) => {
    const out = [];
    const cnt = R(0, k);
    for (let i = 0; i < cnt; i++) {
      const t = IDEN[R(0, IDEN.length - 1)];
      out.push(t[0] + '=' + i32(t[1]) + ';');
    }
    return out;
  };

  // C.L 用取值器还是普通字段。
  //
  // 取值器版只有一行，但 Object.defineProperty(x,"L",{get:...}) 是个很强的
  // 指纹 —— "一个带取值器的上下文对象" 在真实代码里罕见。字段版多几行同步语句，
  // 但形态普通得多。两条路径的等价性靠"每个换帧点都同步"保证：
  // pushFrame 与 doRet 是仅有的两个换帧点，都必须更新。
  const useGetter = R(0, 99) < 45;

  // ---- var 声明（可打乱）----
  //
  // **每条都必须自带 var**，不能只写赋值：漏掉 var 就成了给未声明的全局赋值，
  // 产物里表现为 ReferenceError，而报错点在 eval 出来的内核里，与真正的病因
  // （生成器少写一个关键字）毫无关系。
  //
  // 之所以敢逐条打乱：var 提升到函数作用域顶部，所以纯声明之间的先后对读取
  // 没有影响。**恒等语句绝不能放进这个数组** —— 打乱之后 `mask=mask|0` 可能
  // 排在 `mask=H.mask|0` 之前，把掩码清零。栈槽算出来的下标全部解不开，
  // 而产物不报错、只是返回一堆乱七八糟的值。恒等语句一律放在下面固定位置的
  // 序言里（所有派生赋值之后）。
  const decls = [
    'var ' + nMask + '=' + i32(nH + '.mask') + ';',
    'var ' + nHd + '=' + nH + '.handler||{};',
    'var ' + nLim + '=(' + nH + '.limit>>>0)||100000;',
    'var ' + nN + '=0;',
    'var ' + nDone + '=0;',
    'var ' + nGood + '=1;',
    'var ' + nFr + '=[],' + nSp + '=0;',
  ];
  // 干扰函数的个数先抽：随机序列的推进点要和后面的分支错开，
  // 否则同一个取样序列会同时决定"有没有干扰函数"和"干扰函数写什么"。
  const nDecoy = R(0, 2);
  const fieldsPick = R(0, 1);
  if (R(0, 99) < 50) {
    decls.push('var ' + nRet + '=void 0;');
  } else {
    decls.push('var ' + nRet + ';');
  }
  shuffleIn(decls, R);

  // ---- 永不执行的干扰函数 ----
  // 纯函数、无副作用、不被引用。作用是让"这段代码里有哪些东西"与实际无关。
  const decoys = [];
  for (let i = 0; i < nDecoy; i++) {
    const f = nm(), a = nm(), b = nm(), c = nm();
    const body = [
      'return (' + a + '^' + b + ');',
      'return (' + a + '+' + b + ')|0;',
      'return (' + a + '&' + b + ')*' + c + ';',
      'var t=' + a + '-' + b + ';return (t^' + c + ');',
      'if(' + a + '>' + b + '){return ' + a + ';}return ' + b + ';',
    ][R(0, 4)];
    decoys.push('function ' + f + '(' + a + ',' + b + ',' + c + '){' + body + '}');
  }

  const L = [];
  for (const d of decoys) L.push(d);
  L.push('function VMC_run(' + nCode + ',' + nH + '){');
  L.push('var ' + nUn + '=function(' + nO + '){return ' + dec(nO, nH + '.opShift') + ';};');
  for (const d of decls) L.push(d);
  L.push('var ' + nV + '=' + nH + '.V||[];');
  L.push('function ' + nMkfr + '(' + nPc0 + ',' + nL0 + '){return {pc:' + nPc0
    + ',stk:[],L:' + nL0 + ',base:0};}');
  // 第一帧**必须放进 fr[0]**。否则 RET 时 fr[sp-1] 取到 undefined，
  // 被当成'最外层返回'而直接结束 —— 任何一次函数调用都会把整个执行提前结束掉。
  L.push('var ' + nF + '=' + nMkfr + '(' + i32(nH + '.entry') + ',' + nH + '.L||[]);');
  L.push(nFr + '[0]=' + nF + ';');
  // **两个名字都要各自带 var。** 写成 `var A=...;B=...;` 时 var 只管 A，
  // B 是隐式全局赋值。非严格模式下能跑（内核测试全绿），但产物的 selfCheck 会
  // 判成未绑定引用、严格模式（ESM 产物）下直接 ReferenceError。
  // 这已经是同一个坑第二次：先前 decls 数组整体漏了 var，这里漏了两处。
  L.push('var ' + nStk + '=' + nF + '.stk;');
  L.push('var ' + nPc + '=' + nF + '.pc;');
  // 恒等语句放在这里：所有派生赋值之后。此时 pc/sp/n/good/mask 都已是 int32，
  // 对它们做 ToInt32 是真正的恒等变换。
  for (const d of junk(2)) L.push(d);
  L.push('var ' + nC + '={' + nCode + ':' + nCode + ',' + nMask + ':' + nMask
    + ',consts:' + nH + '.consts||[],regs:' + nH + '.regs||[],mem:' + nH + '.mem||{}};');
  if (useGetter) {
    // 局部槽随帧走：递归时每帧一套，互不干扰（这就是"嵌套调用状态隔离"）。
    L.push('Object.defineProperty(' + nC + ',"L",{get:function(){return ' + nF + '.L;}});');
  } else {
    L.push(nC + '.L=' + nF + '.L;');
  }
  L.push(nC + '.mk=(' + nH + '.mk===undefined)?' + nMask + ':' + i32(nH + '.mk') + ';');
  // ---- 形参 ----
  //
  // 入口实参由宿主直接给（被保护的函数体被替换成一次 run 调用，实参原样传进来）。
  // 少了这一项，内层编译器就只能处理无参函数 —— 而真实代码里几乎每个函数都有
  // 形参，于是"能保护的范围"窄到没有实用价值。
  //
  // ---- int32 闸门：为什么这里必须抛错而不是硬算 ----
  //
  // 内核的算术按 |0 走，所以它只在参数与中间值**全程是 32 位整数**时才等价于
  // 原生。形参类型编译期无从得知（markNumericSlots 里是明写的假设），于是这份
  // 假设一旦不成立，表现是**静默算错**。实测：
  //
  //   f(a,b){return a+b}  调用 f(1.5,2)   原生 3.5  内层 3
  //   f(a,b){return a+b}  调用 f("x","y") 原生 xy  内层 0
  //   f(a){return a*2}    调用 f(3e9)     原生 6000000000  内层 1705032704
  //
  // 产物不报错、控制流照跑、字节数一模一样。对一个保护工具来说这比崩溃更糟 ——
  // 用户会以为自己的业务逻辑本来就这样，直到查不出原因。
  //
  // 所以在这里**显式拦住并抛错**：把"静默算错"换成"一条能定位的异常"。
  // 检查放在 ARGV 那一条指令上（每个形参各过一次），而不是入口统一扫 ——
  // 入口扫描要么多一趟循环，要么对无参函数也要付代价，而无参函数的值全部可证
  // 是整数，本来就不该被拦。
  //
  // 报错文案**不进产物**。一条明文英文串（哪怕只有 "non-int32 arg" 八个字符）
  // 会出现在**每一份**内层档产物里，而"产物里有一处固定的英文报错文案"正是
  // 识别这一档的最省事的办法 —— 比破解加密字节码容易得多。
  //
  // 改成抛一个**整数**：形参下标。栈里显示 `throw 3`，没有字符串字面量，
  // 分析者拿不到任何可 grep 的标记；同时开发者仍然看得出**是第几个参数**出的问题，
  // 剩下的（"这一档只吃 int32"）在选项说明里写着。
  //
  // 这是一处明确的取舍：**可诊断性换指纹面**。如果更看重可诊断性，把这里换成
  // 一句带说明的英文串即可，一行改动。
  L.push(nC + '.args=' + nH + '.args||[];');
  L.push(nC + '.arg=function(' + nI + '){return ' + nC + '.args[' + i32(nI) + '];};');
  L.push(nC + '.argi=function(' + nI + '){var v=' + nC + '.args[' + i32(nI) + '];'
    + 'if(typeof v==="number"&&(v|0)===v){return v;}'
    + 'throw ' + i32(nI) + ';};');
  // ---- 值表 ----
  //
  // 栈与槽里存的**不是值本身，而是值表的下标**。原因：值的类型不止整数 ——
  // 字符串、数组、对象、函数都要能过栈，而 XOR 混淆只对整数成立。
  //
  // 把值移出栈、放进值表之后，栈里永远是整数，混淆照旧有效；值的身份以数组
  // 下标的形式露出来，但那只是一个位置，不含类型信息。
  L.push(nC + '.V=' + nV + ';');
  L.push(nC + '.alloc=function(' + nVv + '){' + nV + '.push(' + nVv + ');return ' + nV + '.length-1;};');
  L.push(nC + '.push=function(' + nVv + '){' + nStk + '.push((' + nC + '.alloc(' + nVv + ')^' + nMask + ')&0x3fffffff);};');
  L.push(nC + '.pop=function(){var ' + nI + '=' + nStk + '.pop();return (' + nI + '===undefined)?0:((' + nI + '^' + nMask + ')&0x3fffffff);};');
  L.push(nC + '.peek=function(' + nD + '){var ' + nI + '=' + nStk + '[' + nStk + '.length-1-(' + nD + '||0)];return ' + nI + '===undefined?0:(' + nI + '^' + nMask + ')&0x3fffffff;};');
  L.push(nC + '.poke=function(' + nD + ',' + nVv + '){var k=' + nStk + '.length-1-(' + nD + '||0);if(k>=0){' + nStk + '[k]=(' + nC + '.alloc(' + nVv + ')^' + nMask + ')&0x3fffffff;}};');
  // 取栈顶的**值**而不是下标：tv=看栈顶，pv=弹出并返回。
  L.push(nC + '.tv=function(' + nD + '){return ' + nV + '[' + nC + '.peek(' + nD + '||0)];};');
  L.push(nC + '.pv=function(){return ' + nV + '[' + nC + '.pop()];};');
  L.push(nC + '.spc=function(' + nVv + '){' + nPc + '=' + i32(nVv) + ';};');
  L.push(nC + '.nxt=function(){' + nPc + '=' + i32(nPc + '+1') + ';};');
  L.push(nC + '.jmp=function(' + nD + '){' + nPc + '=' + i32(nPc + '+(' + i32(nD) + ')') + ';};');
  L.push(nC + '.gpc=function(){return ' + i32(nPc) + ';};');
  L.push(nC + '.ret=function(' + nVv + '){' + nRet + '=' + nVv + ';};');
  L.push(nC + '.stop=function(){' + nDone + '=1;};');
  L.push(nC + '.fail=function(){' + nGood + '=0;' + nDone + '=1;};');
  L.push(nC + '.depth=function(){return ' + nSp + ';};');
  // ---- 调用 / 返回 ----
  //
  // 调用者栈顶连续 argc 个值就是实参。进入新帧时把它们**搬进新帧的栈底**，
  // 被调方读参数只需看自己栈底，不必知道调用者栈长什么样。
  //
  // frame.base 记的是"参数区在调用者栈上的起始高度"，RET 时据此把返回值
  // 压到正确位置。首版没有帧，于是递归会共用同一个 pc，fib 变成死循环 ——
  // 而产物不报错，只是算不出值。
  L.push(nC + '.pushFrame=function(target,argc){');
  L.push('  var ' + nNf + '=' + nMkfr + '(target,new Array(argc+16));');
  L.push('  ' + nNf + '.base=' + nStk + '.length-argc;');
  L.push('  for(var ' + nI + '=0;' + nI + '<argc;' + nI + '++){' + nNf + '.stk[' + nI + ']=' + nStk + '[' + nNf + '.base+' + nI + '];}');
  L.push('  ' + nFr + '[++' + nSp + ']=' + nNf + ';' + nF + '=' + nNf + ';' + nStk + '=' + nNf + '.stk;' + nPc + '=' + nNf + '.pc;');
  if (!useGetter) L.push('  ' + nC + '.L=' + nNf + '.L;');
  for (const d of junk(1)) L.push('  ' + d);
  L.push('};');
  L.push(nC + '.doRet=function(' + nVv + '){');
  L.push('  var ' + nCfr + '=' + nFr + '[' + nSp + '-1];');
  L.push('  if(!' + nCfr + '){' + nRet + '=' + nVv + ';' + nDone + '=1;return;}');
  L.push('  ' + nSp + '--;' + nF + '=' + nCfr + ';' + nStk + '=' + nCfr + '.stk;' + nPc + '=' + nCfr + '.pc;');
  if (!useGetter) L.push('  ' + nC + '.L=' + nCfr + '.L;');
  L.push('  ' + nStk + '.length=' + nF + '.base;');
  L.push('  ' + nC + '.push(' + nVv + ');' + nC + '.nxt();');
  L.push('  ' + nRet + '=void 0;');
  for (const d of junk(1)) L.push('  ' + d);
  L.push('};');
  L.push('while(!' + nDone + '){');
  // 深度上限：递归爆栈必须有界失败，不能靠宿主自己的 RangeError ——
  // 那会让产物带着一个不可预期的异常退出，看起来像"随机崩溃"。
  L.push('if(' + nSp + '>200){' + nC + '.fail();break;}');
  L.push('if(++' + nN + '>' + nLim + '){' + nC + '.fail();break;}');
  L.push('var ' + nAt + '=' + nPc + '*6;');
  L.push('if(' + nAt + '<0||' + nAt + '+6>' + nCode + '.length){' + nC + '.fail();break;}');
  L.push('var ' + nOp + '=' + nUn + '(' + nCode + '[' + nAt + ']);');
  // 操作数字节的属性顺序也打乱：纯粹是文本差异，不影响任何求值。
  const fields = ['op:' + nOp, 'oa:' + nCode + '[' + nAt + '+1]', 'ob:' + nCode + '[' + nAt + '+2]',
    'oc:' + nCode + '[' + nAt + '+3]', 'od:' + nCode + '[' + nAt + '+4]', 'fl:' + nCode + '[' + nAt + '+5]'];
  if (fieldsPick) shuffleIn(fields, R);
  L.push('var ' + nIns + '={' + fields.join(',') + '};');
  L.push('var ' + nFnd + '=' + nHd + '[' + nOp + '];');
  // 未知 opcode / 虚假 handler 都落在这里：当填充跳过，不报错。真实程序不该有
  // 未知操作码，但让分析者无法用"遇到未知 opcode 就抛错"区分真假路径。
  L.push('if(' + nFnd + '===undefined){' + nC + '.nxt();continue;}');
  L.push(nF + '.pc=' + nPc + ';');
  L.push(nFnd + '(' + nC + ',' + nIns + ');');
  L.push('if(!' + nGood + '){break;}');
  L.push('}');
  L.push('return {V:' + nV + ',pc:' + nPc + ',n:' + nN + ',done:' + nDone
    + ',ok:' + nGood + ',ret:' + nRet + ',mask:' + nMask + ',depth:' + nSp + '};');
  L.push('}');
  return L.join('\n');
}

/** 小写字母表，用于随机前缀。 */
const ALPHA = 'abcdefghijklmnopqrstuvwxyz';

/** 按传入的取样器原地打乱（Fisher-Yates）。 */
function shuffleIn(a, R) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = R(0, i);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/**
 * 确定性取样器：只在没传 rand 时用。
 *
 * CORE_SRC 需要**逐字节稳定** —— 测试拿它 eval、diff 拿它比对、"这次构建的内核
 * 长什么样"要能被复现。构建期路径一律传 rand。
 */
function mkDetRng() {
  let s = 0x2545f491;
  return function (a, b) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return a + (s % (b - a + 1));
  };
}

/**
 * 确定性内核源码。
 *
 * 用途只有两个：测试（eval 它跑真程序）与 diff。**产物不要用它** ——
 * 每份构建都用同一个内核，正是这一档要解决的问题。
 * 产物侧用 buildCore(randInt)。
 */
export const CORE_SRC = buildCore(null);

export default {
  OPCODES, INSN_W, OPCODE_NAMES,
  scrambleOpcode, encodeOpcode, stash, unstash, CORE_SRC,
};