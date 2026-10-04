/**
 * 嵌套档的产物注入层。
 *
 * 注入产物后的形态：
 *
 *   ① CORE_SRC 内核本体（手写、不参与流水线，因此不被再虚拟化）
 *   ② 运行期**动态构造**的 handler 表：由一张规约数组用循环建出来，并掺入
 *      永不执行的虚假条目
 *   ③ 加密字节码（密文 + 构建期密钥的拆分形式，运行期重组）
 *   ④ 入口：重建密钥 → 解密 → 建表 → 交给内核执行
 *
 * 为什么 handler 表要运行期动态生成而不是写成函数字面量：直接写出来的表，
 * 分析者扫一遍产物就知道每条指令做什么。动态构造之后表在静态产物里**不存在**，
 * 只有一张规约数组和一个建表循环，"某操作码对应哪种行为"要到运行期才确定。
 *
 * 注入失败一律返回 null，由调用方保留原函数。绝不能注入半成品 —— 字节码错则
 * 产物错，而且只在运行期暴露，几乎无法归因。
 *
 * 与外层 vm.js 用**不同的指令集**（这里 6 字节定长，vm.js 自己一套）：两套编码
 * 混在一个产物里本身就是特征，交叉引用会让两边都不再"单一"。
 */

import rand from '../utils/rand.js';
import { CORE_SRC, INSN_W, OPCODES, encodeOpcode } from '../rt/vmcore.js';

const { randInt } = rand;

/** 局部槽按索引读写。槽里的值与栈一样走状态混淆，不以明文躺在内存里。 */
const SLOTS = 'SL';

/** handler 行为码。与 behaviorSrc 里的 case 一一对应。 */
export const BEHAVIOR = {
  PUSH: 1, GET: 2, SET: 3, BIN: 4, CMP: 5, UN: 6,
  JMP: 7, JZ: 8, RET: 9, HALT: 10, DUP: 11, POP: 12,
  ARGV: 13,
};

/**
 * 算子码表。键是**解码后**的操作码，值是 VMC_bin 的 case 号。
 *
 * 键必须写成 `OPCODES.ADD` 而不是 0x31。写死的编号在操作码表**重新分段**后会
 * 静默失效：0x31 从 ADD 变成别的东西，这里的映射还指向旧值，于是那条指令在
 * 字节码里照常出现、建表时挂上错误的行为码，产物不报错、只是算错。
 * 本会话已经踩过一次同样的坑（vmNested.js 里 7 处 emit.insn(0x13)，0x13 恰好
 * 从 DUP 变成 PUSH，所有 DUP 都在发 PUSH，编译成功且字节码长度一模一样）。
 *
 * 必须与 vmNested.js 里 BINOP/CMPOP/一元 的集合一致；两边不同就会出现
 * "操作码认识、行为码不认识"的条目，建表时落到兜底分支（当填充跳过），
 * 产物于是静默算错。
 */
const ARITH = {
  [OPCODES.ADD]: 0, [OPCODES.SUB]: 1, [OPCODES.MUL]: 2,
  [OPCODES.AND]: 3, [OPCODES.OR]: 4, [OPCODES.XOR]: 5,
  [OPCODES.SHL]: 6, [OPCODES.SHR]: 7, [OPCODES.USHR]: 8,
};
const COMPARE = {
  [OPCODES.EQ]: 0, [OPCODES.NE]: 1,
  [OPCODES.LT]: 2, [OPCODES.LE]: 3,
  [OPCODES.GT]: 4, [OPCODES.GE]: 5,
};
const UNARY = { [OPCODES.NEG]: 0, [OPCODES.NOT]: 1 };

/**
 * 行为工厂 + 算子实现。
 *
 * 槽表通过参数传进来（不写死）：栈和槽必须用**同一个**掩码，早期版本让表自己
 * 持一个固定掩码而字节码用另一个，槽里解不开，所有变量读出 0。
 */
const behaviorSrc = [
  'function VMC_bh(b,a){switch(b){',
  'case 1:return function(C,I){C.push(I.oa);C.nxt();};',
  'case 2:return function(C,I){C.push(C.L[I.oa]);C.nxt();};',
  'case 3:return function(C,I){C.L[I.oa]=C.V[C.pop()];C.nxt();};',
  'case 4:return function(C,I){var y=C.pv(),x=C.pv();C.push(VMC_bin(a,x,y));C.nxt();};',
  'case 5:return function(C,I){var y=C.pv(),x=C.pv();C.push(VMC_cmp(a,x,y));C.nxt();};',
  'case 6:return function(C,I){C.push(VMC_un(a,C.pv()));C.nxt();};',
  'case 7:return function(C,I){C.jmp((I.oa<<24)>>24);};',
  'case 8:return function(C,I){if(C.tv(0)===0){C.jmp((I.oa<<24)>>24);}else{C.nxt();}};',
  'case 9:return function(C,I){C.ret(C.pv());C.stop();};',
  'case 10:return function(C,I){C.stop();};',
  'case 11:return function(C,I){C.push(C.tv(0));C.nxt();};',
  'case 12:return function(C,I){C.pop();C.nxt();};',
  'case 13:return function(C,I){C.push(C.arg(I.oa));C.nxt();};',
  '}',
  // 兜底：未知行为当填充跳过，而不是抛错。真实程序不该出现，但让分析者无法
  // 用"遇到未知项就报错"来区分真假路径。
  'return function(C,I){C.nxt();};}',
  'function VMC_bin(a,x,y){switch(a){',
  'case 0:return (x+y)|0;case 1:return (x-y)|0;case 2:return (x*y)|0;',
  'case 3:return x&y;case 4:return x|y;case 5:return x^y;',
  'case 6:return x<<y;case 7:return x>>y;case 8:return x>>>y;',
  '}return 0;}',
  'function VMC_cmp(a,x,y){switch(a){',
  'case 0:return x===y?1:0;case 1:return x!==y?1:0;',
  'case 2:return x<y?1:0;case 3:return x<=y?1:0;',
  'case 4:return x>y?1:0;case 5:return x>=y?1:0;',
  '}return 0;}',
  'function VMC_un(a,x){switch(a){case 0:return (-x)|0;case 1:return ~x;}return x;}',
].join('\n');

/**
 * 生成注入源码与入口调用表达式。
 *
 * @param {object} spec compileNested 的产物
 * @param {object} names 各标识符名（由调用方用 uniqueName 分配）
 * @param {object} [opts] { decoyOps, limit }
 * @returns {{src:string, call:string}|null}
 */
export function buildInjection(spec, names, opts) {
  if (!spec || !spec.code || !spec.code.length) return null;
  const shift = spec.shift | 0;
  const slots = spec.slots | 0;
  // 虚假条目数：null/未给 = 按构建随机取 4~10；给 0 = 不掺。
  // 默认要掺 —— "表的大小与真实指令数无关"本身就是要藏的东西，不掺等于
  // 把真实指令条数直接写在产物里。
  const decoy = (opts && opts.decoyOps !== undefined && opts.decoyOps !== null)
    ? opts.decoyOps | 0
    : randInt(4, 10);
  const limit = (opts && opts.limit) || 20000;

  // ---- 密钥：构建期随机，产物里拆成两半，运行期异或重组 ----
  // 不直接写进产物（扫常量即得）。两半用基 36 而不是十六进制：产物里的字符串
  // 若清一色 0x.. 形态，本身就是"这里有个常量"的提示。
  const key = randInt(1, 0x7fffffff);
  const ka = randInt(0, 0xffff);
  const kb = ((key ^ ka) >>> 0) & 0xffff;
  const keyLow = key & 0xffff;

  // ---- 字节码加密 ----
  // 逐字节 XOR，并掺入与位置相关的偏移：单纯整体 XOR 会被"两版产物对应字节
  // 相减"直接还原，位置项让密文的每个字节依赖自己的位置。
  const enc = [];
  for (let i = 0; i < spec.code.length; i++) {
    enc.push((spec.code[i] ^ ((keyLow + i * 7) & 0xff)) & 0xff);
  }
  // 每字节两位基 36，比十进制数组省一半以上
  const cipher = enc.map((b) => ('0' + b.toString(36)).slice(-2)).join('');

  // ---- handler 规约 ----
  // 每条：[变换后的操作码, 行为码, 参数]。操作码存变换后的值：建表时用同一个
  // shift 减回来，内核取指时也减回来，两边对得上；而产物里出现的是逐构建变化的
  // 编号，不是固定常量。
  const used = usedBehaviors(spec);
  const entries = [];
  for (const [op, beh, arg] of used) {
    entries.push('[' + encodeOpcode(op, shift) + ',' + beh + ',' + (arg | 0) + ']');
  }
  // 虚假条目：永不执行，但让表的大小与真实条目数无关
  for (let i = 0; i < decoy; i++) {
    const op = (randInt(0x20, 0xf0) + shift) & 0xff;
    // 行为取无害的（DUP/POP）。万一被误执行也不会毁掉栈。
    entries.push('[' + op + ',' + (BEHAVIOR.DUP + randInt(0, 1)) + ',0]');
  }
  shuffleArr(entries);

  const L = [];
  L.push(CORE_SRC);
  L.push(behaviorSrc);
  // 解密：密文每字节两位基 36 → XOR 掉位置项
  L.push('function ' + names.dec + '(s,m){var o=[],i;'
    + 'for(i=0;i<s.length;i+=2){o.push(((parseInt(s.substr(i,2),36)^((m+(i>>1)*7)&255))&255));}'
    + 'return o;};');
  // 建表：循环遍历规约，操作码减回原值再挂 handler
  // 规约数组直接拼源码，**不能** JSON.stringify 整个数组。
  // entries 里每项已经是字符串（'[' + op + ',' + beh + ',' + arg + ']'），
  // 整体 stringify 会把它们再套一层引号，产物里变成字符串数组；循环里 e[0]
  // 取到的是字符 '[' 而不是数字，建表全部落空 → 表里没有一个真 handler，
  // 字节码整片被当填充跳过，最后 RET 没执行、返回 undefined。
  L.push('function ' + names.tab + '(sh,n){var h={},L=[],i,e;'
    + 'for(i=0;i<n;i++){L[i]=0;}'
    + 'var S=[' + entries.join(',') + '];'
    + 'for(i=0;i<S.length;i++){e=S[i];h[((e[0]-sh)&255)]=VMC_bh(e[1],e[2]);}'
    + 'return {h:h,L:L};};');
  // 入口：重组密钥 → 解密 → 建表 → 交给内核
  //
  // 实参从 arguments 的第 6 位起收集，而不是让调用方直接传一个数组字面量。
  // 后者会在产物里留下一段 [a,b,c] 这样的定长名字列表 —— 那是"这里有几个形参、
  // 分别叫什么"的可读痕迹，而形参个数与顺序本来就该只体现在字节码里。
  const ARG_BASE = 6;   // ka kb s sh n lm
  L.push('function ' + names.run + '(ka,kb,s,sh,n,lm){'
    + 'var key=((ka^(kb&65535))|0);'
    + 'var A=[],i;for(i=' + ARG_BASE + ';i<arguments.length;i++){A[i-' + ARG_BASE + ']=arguments[i];}'
    + 'var code=' + names.dec + '(s,key&65535);'
    + 'var T=' + names.tab + '(sh,n);'
    + 'var r=VMC_run(code,{handler:T.h,mem:{},mask:key,opShift:sh,entry:0,limit:lm,'
    + 'consts:[],L:T.L,mk:key,args:A});'
    + 'return (r.ret|0);};');

  // 形参实参接到 run(...) 后面。**一个都不能少**：少传一个，内核读到的
  // C.arg(1) 是 undefined，而 undefined 在算术里当 0，函数于是对所有输入
  // 返回同一个值 —— 不报错，只是结果全错。
  const argList = (spec.params || []).map((p) => p).join(',');

  return {
    src: L.join('\n'),
    // **必须带 return**：原函数体被替换成这一条，而函数体的值就是返回值。
    // 首版写成裸调用 `run(...)`，于是每个被虚拟化的函数都返回 undefined ——
    // 产物不报错、控制流照跑，只是所有算术结果全丢。这类错只在"函数返回值
    // 被用到"的地方暴露，纯副作用的函数看起来完全正常。
    call: 'return ' + names.run + '(' + ka + ',' + kb + ',' + JSON.stringify(cipher) + ','
      + shift + ',' + Math.max(1, slots) + ',' + limit
      + (argList ? ',' + argList : '') + ')',
  };
}

/**
 * 操作码 → handler 行为。**只登记真正用到的**，虚假条目由 buildInjection 单独掺。
 *
 * 键写成 OPCODES.* ：与上面的 ARITH/COMPARE/UNARY 同理，写死编号会在操作码表
 * 重分段后静默错配。keyBy 形参把这条约束固化下来 —— 新增一条映射必须经过它，
 * 绕不过去。
 */
const SIMPLE = new Map([
  [OPCODES.PUSH, BEHAVIOR.PUSH],
  [OPCODES.GET, BEHAVIOR.GET],
  [OPCODES.SET, BEHAVIOR.SET],
  [OPCODES.JMP, BEHAVIOR.JMP],
  [OPCODES.JZ, BEHAVIOR.JZ],
  [OPCODES.RET, BEHAVIOR.RET],
  [OPCODES.HALT, BEHAVIOR.HALT],
  [OPCODES.DUP, BEHAVIOR.DUP],
  [OPCODES.POP, BEHAVIOR.POP],
  [OPCODES.NOP, BEHAVIOR.POP],   // NOP 当填充
  [OPCODES.ARGV, BEHAVIOR.ARGV],
]);

/**
 * 解码后的操作码 → {beh, arg}，没有映射则 null。
 *
 * 导出是为了让测试能断言真正的不变量 ——"vmNested 能发射的每个操作码，这里都有
 * 行为码"——而不是拿正则去匹配源码里的 `0x31:\s*0`。源码文本断言在重命名操作码
 * 表之后会**假失败**，而更糟的是它在表被改坏时也可能**假通过**。
 */
export function behaviorFor(op) {
  const simple = SIMPLE.get(op);
  if (simple !== undefined) return { beh: simple, arg: 0 };
  if (ARITH[op] !== undefined) return { beh: BEHAVIOR.BIN, arg: ARITH[op] };
  if (COMPARE[op] !== undefined) return { beh: BEHAVIOR.CMP, arg: COMPARE[op] };
  if (UNARY[op] !== undefined) return { beh: BEHAVIOR.UN, arg: UNARY[op] };
  return null;
}

/**
 * 从字节码反推用到的行为。
 *
 * 必须扫**解码后**的操作码（字节码里存的是变换后的值）。只登记真正用到的，
 * 虚假条目由 buildInjection 单独掺 —— 两者的区别是这里按语义判定，那里随机造。
 */
function usedBehaviors(spec) {
  const shift = spec.shift | 0;
  const seen = new Set();
  const out = [];
  const add = (op, beh, arg) => {
    const k = op + ':' + beh + ':' + arg;
    if (seen.has(k)) return;
    seen.add(k);
    out.push([op, beh, arg]);
  };
  const code = spec.code;
  for (let i = 0; i + INSN_W <= code.length; i += INSN_W) {
    const op = (code[i] - shift) & 0xff;
    const b = behaviorFor(op);
    if (b) add(op, b.beh, b.arg);
  }
  return out;
}

/** 原地打乱（Fisher-Yates，走构建期 rand，所以同 seed 可复现）。 */
function shuffleArr(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

export default { buildInjection, BEHAVIOR };
export { SLOTS };