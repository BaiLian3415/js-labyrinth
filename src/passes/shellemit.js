/**
 * 解码链 IR 的两处发射器：朴素 JS（语义基准）与密文字节码 + 通用栈式解释器。
 *
 * ## 唯一不变量
 *
 * **`emitExpr` 发射完恰好在操作数栈上留一个值。** 整份文件里凡是压栈的地方都只经由
 * `emitExpr`，凡是弹栈的地方都只经由弹栈辅助函数。上一版手写字节码之所以错得安静，
 * 正是因为栈序散落在几百个字面量里；把它收进这一个函数之后，"栈多了一个值"这种错
 * 只会让三路对拍失败，而不会伪装成"算错一点点"。
 *
 * `emitCond` 是它的推论：发射一段求值代码并**恰好压一个 0/1**，随后接一条条件跳转。
 * 解码链里的条件全都是比较或原生探针，两者都产出 0/1，所以这个约定是闭合的。
 *
 * ## 与 vm.js 的分工
 *
 * 那边是可复现构建的核心（要逐字节可复现、要进 wasm、要有 dispatch 加密）；这边是
 * **一次性产物里的引导器**，只要求正确与不可读，不参与可复现性比对。两边刻意不共用
 * 代码——共用了就把"核心的可复现性"和"引导器的可读性"两个目标绑在一起。
 */

// ================================================================ 公共：槽位分配

/**
 * 给 IR 里的每个变量分配一个稳定下标。
 *
 * 顺序固定（输入在前、其余按首次出现），所以同一份 IR 每次得到同一张表——
 * 这是 `emitJs` 与 `emitVm` 能"逐位一致"的前提：两边的变量 i 就是对方的变量 i。
 *
 * @param {object} ir 语句树
 * @param {string[]} inputs 输入变量名（按参数顺序）
 * @returns {{slot:Object, list:string[], size:number}}
 */
/**
 * 语句位置既接受数组也接受 block 节点。
 *
 * IR 里两种写法都自然（`iff` 的 then/els 本来就是数组，循环体顺手写成 `blk([…])`
 * 也很自然）。在这里归一，两个发射器就都只需要认一种内部形态——省掉的是"某处少写
 * 一个中括号"这类与算法无关的失败。
 */
const asList = (x) => (Array.isArray(x) ? x : (x && x.k === 'block' ? x.list : []));

export function assignSlots(ir, inputs) {
  const slot = {};
  const list = [];
  for (const n of inputs) { slot[n] = list.length; list.push(n); }
  const seen = new Set(inputs);
  (function walk(nd) {
    if (!nd || typeof nd !== 'object') return;
    if (Array.isArray(nd)) { nd.forEach(walk); return; }
    if (nd.k === 'var') {
      if (!seen.has(nd.n)) { seen.add(nd.n); slot[nd.n] = list.length; list.push(nd.n); }
      return;
    }
    if (nd.k === 'len') { walk(nd.of); return; }
    if (nd.k === 'nchk') return; // 原语表下标，不是局部
    Object.keys(nd).forEach((key) => {
      if (key === 'k') return;
      const v = nd[key];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    });
  }(ir));
  return { slot, list, size: list.length };
}

// ================================================================ 发射器一：朴素 JS

/**
 * 发成朴素 JS 函数源码。作为**语义基准**：它一眼能核对回原始引导器，而形态随机性
 * （`P()` 二/三形态、原语多族、声明合分）刻意一概不做——基准越朴素，对拍越有说服力。
 *
 * @param {object} ir 语句树
 * @param {object} o
 * @param {string[]} o.inputs 输入变量（参数顺序）
 * @param {string[]} o.prims 原语参数名（按函数表顺序）
 * @param {string} o.output 输出变量名
 * @param {Object<string,string>} [o.names] IR 变量 → JS 标识符（缺省按槽位生成）
 * @returns {string} 函数表达式源码
 */
export function emitJs(ir, { inputs, prims, output, names }) {
  const { slot, list } = assignSlots(ir, inputs);
  const nm = (n) => (names && names[n]) || ('_v' + slot[n]);
  const primName = {};
  // 原语在参数表里的位置由「函数表下标」决定，IR 里以原语名出现
  const primOf = { xs32: 0, mix: 1, ipos: 2, mul32: 3, cc: 4, P_EVAL: 5, P_FN: 6 };
  Object.keys(primOf).forEach((k) => { primName[k] = prims[primOf[k]]; });

  const declared = list.filter((n) => inputs.indexOf(n) < 0 && n !== output);

  function ex(nd) {
    switch (nd.k) {
      case 'num': return String(nd.v);
      case 'var': return nm(nd.n);
      case 'idx': return '(' + ex(nd.o) + '[' + ex(nd.i) + '])';
      case 'len': return '(' + ex(nd.of) + '.length)';
      case 'un': return '(' + ex(nd.a) + '>>>0)';
      case 'bin': return '(' + ex(nd.a) + nd.op + ex(nd.b) + ')';
      case 'call': return primName[nd.f] + '(' + nd.args.map(ex).join(',') + ')';
      case 'new': return 'new Uint8Array(' + ex(nd.size) + ')';
      case 'nchk': return '((("" + ' + nm(nd.g) + ').indexOf("native"))<0)';
      default: throw new Error('emitJs: 未知表达式 ' + nd.k);
    }
  }

  const out = [];
  function st(nd) {
    switch (nd.k) {
      case 'block': asList(nd).forEach(st); return;
      case 'set': out.push(nm(nd.v) + '=' + ex(nd.e) + ';'); return;
      case 'store': out.push(ex(nd.o) + '[' + ex(nd.i) + ']=' + ex(nd.e) + ';'); return;
      case 'or1': out.push(nm(nd.v) + '=(' + ex(nd.e) + '||1);'); return;
      case 'continue': out.push('continue;'); return;
      case 'if':
        out.push('if(' + ex(nd.c) + '){');
        asList(nd.then).forEach(st);
        if (asList(nd.els).length) { out.push('}else{'); asList(nd.els).forEach(st); }
        out.push('}');
        return;
      case 'for': {
        // init / update 在本链里恒为 set，发进 for 头。continue 在 JS 的 for 里
        // 会正常执行 update，所以这里的 continue 与原版逐位一致——这一点靠的是
        // 「用 for 而不是 while(init;cond){body;update}」，后者 continue 会跳过 update。
        const hdr = (s) => (s.k === 'set' ? nm(s.v) + '=' + ex(s.e) : (st(s), ''));
        out.push('for(' + hdr(nd.init) + ';' + ex(nd.c) + ';' + hdr(nd.update) + '){');
        asList(nd.body).forEach(st);
        out.push('}');
        return;
      }
      default: throw new Error('emitJs: 未知语句 ' + nd.k);
    }
  }
  st(ir);

  const params = prims.concat(inputs.map(nm)).join(',');
  const head = declared.length ? 'var ' + declared.map(nm).join(',') + ';' : '';
  return '(function(' + params + '){' + head + out.join('') + 'return ' + nm(output) + ';})';
}

// ================================================================ 发射器二：密文字节码

// 操作码表。编号逐构建随机（shuffleOpCodes），字节码因此不可跨构建复用，
// 外层解释器的 case 标签也随之逐构建变——同一份外壳每次构建形状都不同。
export const OPCODES = [
  'PUSH', 'LD', 'ST', 'AGET', 'ASET', 'LEN', 'NEWU8', 'DUP', 'POP',
  'ADD', 'SUB', 'MUL', 'AND', 'OR', 'XOR', 'SHL', 'SHR', 'USHR', 'U32',
  'LT', 'LE', 'GT', 'GE', 'EQ', 'NE',
  'JMP', 'JZ',
  'CALL', 'NCHK',
  'RET',
];

/** 每个操作码带几个紧随其后的 int32 操作数。解释器发射必须与此一致。 */
const ARITY = {
  PUSH: 1, LD: 1, ST: 1, AGET: 0, ASET: 0, LEN: 0, NEWU8: 0, DUP: 0, POP: 0,
  ADD: 0, SUB: 0, MUL: 0, AND: 0, OR: 0, XOR: 0, SHL: 0, SHR: 0, USHR: 0, U32: 0,
  LT: 0, LE: 0, GT: 0, GE: 0, EQ: 0, NE: 0,
  JMP: 1, JZ: 1,
  CALL: 2, NCHK: 2,
  RET: 0,
};

const PRIM_OF = { xs32: 0, mix: 1, ipos: 2, mul32: 3, cc: 4, P_EVAL: 5, P_FN: 6 };
const PRIM_ARITY = [1, 4, 4, 2, 2, 0, 0];
export const CONSTS = ['native'];

/**
 * IR 运算符符号 → 操作码名。
 *
 * IR 用符号（因为 emitJs 要原样输出成 JS），VM 用名字（因为要进 case 表）。这张表是
 * 两边唯一的翻译处；漏一个的表现是 emitVm 报"未定义操作码"，不会静默算错。
 */
const BINOP = {
  '+': 'ADD', '-': 'SUB', '*': 'MUL',
  '&': 'AND', '|': 'OR', '^': 'XOR',
  '<<': 'SHL', '>>': 'SHR', '>>>': 'USHR',
  '<': 'LT', '<=': 'LE', '>': 'GT', '>=': 'GE',
  '===': 'EQ', '!==': 'NE',
};

/** 逐构建随机的操作码编号表（名字 → 编号）。 */
export function shuffleOpCodes(randInt) {
  const nums = OPCODES.map((_, i) => i);
  for (let i = nums.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    const t = nums[i]; nums[i] = nums[j]; nums[j] = t;
  }
  const m = {};
  OPCODES.forEach((n, i) => { m[n] = nums[i]; });
  return m;
}

/**
 * 发成字节码。
 *
 * 栈纪律全部由 `ex` 与弹栈辅助函数保证，没有任何一处手写"压几个、弹几个"。
 *
 * @param {object} ir 语句树
 * @param {object} o
 * @param {string[]} o.inputs 输入变量
 * @param {string} o.output 输出变量
 * @param {object} o.opmap 操作码表（名字 → 编号）
 * @returns {{words:number[], slots:object, slotCount:number, outSlot:number}}
 */
export function emitVm(ir, { inputs, output, opmap }) {
  const { slot, size } = assignSlots(ir, inputs);
  const w = [];
  /**
   * 发一条指令，返回**第一个操作数的下标**。
   *
   * 返回操作数下标（而不是指令尾，也不是推之前的 w.length）是为了回填：`patch` 要
   * 写的是跳转目标那个操作数。曾经写成 `const at = w.length; op(name, 0)`——那个
   * `at` 是**操作码**的位置，回填就把操作码本身覆盖成了目标地址，字节码从那里
   * 起整体错位，症状是解出非法操作码。这个坑在同一份代码里栽过两次（手写版与
   * 本版），所以干脆不给调用方「自己算下标」的机会。
   */
  const op = (name, ...args) => {
    const c = opmap[name];
    if (c === undefined) throw new Error('emitVm: 未定义操作码 ' + name);
    if (args.length !== ARITY[name]) {
      throw new Error(`emitVm: ${name} 要 ${ARITY[name]} 个操作数，收到 ${args.length}`);
    }
    w.push(c | 0);
    const slot = w.length;
    for (const a of args) w.push(a | 0);
    return slot;
  };
  // 标签 → 回填槽。标签（代码位置）与占位槽（操作数位置）严格分开，
  // 两者混用是本文件最贵的一个教训，见上面 op 的注释。
  const labels = [];
  const patch = [];
  const label = () => w.length;
  const jumpTo = (name, lbl) => { patch.push([op(name, 0), lbl]); };
  const patchAll = () => { for (const [at, lbl] of patch) w[at] = labels[lbl] | 0; };

  // ---- 表达式：恰好压一个值 ----
  function ex(nd) {
    switch (nd.k) {
      case 'num': op('PUSH', nd.v); return;
      case 'var': op('LD', slot[nd.n]); return;
      case 'idx': ex(nd.o); ex(nd.i); op('AGET'); return;
      case 'len': ex(nd.of); op('LEN'); return;
      case 'un': ex(nd.a); op('U32'); return;
      case 'bin': ex(nd.a); ex(nd.b); op(BINOP[nd.op]); return;
      case 'call': nd.args.forEach(ex); op('CALL', PRIM_OF[nd.f], PRIM_ARITY[PRIM_OF[nd.f]]); return;
      case 'new': ex(nd.size); op('NEWU8'); return;
      case 'nchk': op('NCHK', PRIM_OF[nd.g], nd.c); return;
      default: throw new Error('emitVm: 未知表达式 ' + nd.k);
    }
  }

  // ---- 条件：求值并恰好压一个 0/1，随后由调用方接条件跳转 ----
  const cond = (nd) => ex(nd);

  const loopStack = [];
  function st(nd) {
    switch (nd.k) {
      case 'block': asList(nd).forEach(st); return;
      case 'set': ex(nd.e); op('ST', slot[nd.v]); return;
      case 'store': ex(nd.o); ex(nd.i); ex(nd.e); op('ASET'); return;
      case 'or1': {
        // v = e || 1
        //
        // 这里必须先把值**复制一份**去判零：JZ 是无条件弹栈的，若直接 JZ 判原值，
        // 判完值就没了，lEnd 处 ST 会从空栈里弹 —— 表现为栈下溢后读到 undefined，
        // 症状是"跑到某条 AGET 时报 undefined[undefined]"，与真正的病因隔了两层。
        // 两条路都在 lEnd 留下恰好一个值：非零走原值（复制那份），零走丢弃 + 常量 1。
        ex(nd.e);
        op('DUP');
        const lOne = labels.length; labels.push(-1);
        jumpTo('JZ', lOne);
        const lEnd = labels.length; labels.push(-1);
        jumpTo('JMP', lEnd);
        labels[lOne] = label();
        op('POP'); op('PUSH', 1);
        labels[lEnd] = label();
        op('ST', slot[nd.v]);
        return;
      }
      case 'continue': {
        if (!loopStack.length) throw new Error('emitVm: continue 不在循环内');
        jumpTo('JMP', loopStack[loopStack.length - 1].cont);
        return;
      }
      case 'if': {
        const hasElse = asList(nd.els).length > 0;
        const lElse = labels.length; labels.push(-1);
        cond(nd.c);
        jumpTo('JZ', lElse);
        asList(nd.then).forEach(st);
        if (hasElse) {
          const lEnd = labels.length; labels.push(-1);
          jumpTo('JMP', lEnd);
          labels[lElse] = label();
          asList(nd.els).forEach(st);
          labels[lEnd] = label();
        } else {
          labels[lElse] = label();
        }
        return;
      }
      case 'for': {
        st(nd.init);
        const lTop = labels.length; labels.push(-1);
        labels[lTop] = label();
        const lEnd = labels.length; labels.push(-1);
        cond(nd.c);
        jumpTo('JZ', lEnd);
        // continue 落在 update **之前**，与 JS 的 for 语义一致
        const lCont = labels.length; labels.push(-1);
        loopStack.push({ cont: lCont });
        asList(nd.body).forEach(st);
        loopStack.pop();
        labels[lCont] = label();
        st(nd.update);
        jumpTo('JMP', lTop);
        labels[lEnd] = label();
        return;
      }
      default: throw new Error('emitVm: 未知语句 ' + nd.k);
    }
  }

  st(ir);
  op('RET');
  patchAll();
  const words = w;
  verifyVm(words, opmap, size);
  return { words, slots: slot, slotCount: size, outSlot: slot[output] };
}

/**
 * 构建期自检：顺着字流模拟一遍栈深，并核对槽位操作数。
 *
 * 这道检查存在的理由是上一版的教训：字节码里的错**全都不报错**，它们表现为"跑到某条
 * 指令时读到 undefined"或者"产物偶尔算错"。等到运行期才发现，定位成本高一个量级。
 * 而这类错在**静态**上是完全可见的——栈深在每条指令边界都应当恰好回到语句级的 0，
 * 槽位操作数都应当落在 [0, slotCount)。
 *
 * 有了它，"多压一个值""回填覆盖操作码"这两类错在 emitVm 返回前就会炸，并指出 pc。
 *
 * @param {number[]} words 字流
 * @param {object} opmap 名字 → 编号
 * @param {number} slotCount 局部槽总数
 */
export function verifyVm(words, opmap, slotCount) {
  const inv = {};
  for (const [k, v] of Object.entries(opmap)) inv[v] = k;
  // 各操作码对栈深的净影响
  const NET = {
    PUSH: 1, LD: 1, DUP: 1, NCHK: 1,
    ST: -1, AGET: -1, POP: -1, JZ: -1,
    ASET: -3,
    LEN: 0, NEWU8: 0, U32: 0, JMP: 0, RET: 0,
  };
  let pc = 0;
  let depth = 0;
  while (pc < words.length) {
    const n = inv[words[pc]];
    if (!n) throw new Error(`verifyVm: pc=${pc} 处是非法操作码 ${words[pc]}（多半是回填写到了操作码头上）`);
    const ar = ARITY[n];
    if (pc + 1 + ar > words.length) {
      throw new Error(`verifyVm: pc=${pc} 的 ${n} 操作数越界`);
    }
    if ((n === 'LD' || n === 'ST') && (words[pc + 1] < 0 || words[pc + 1] >= slotCount)) {
      throw new Error(`verifyVm: pc=${pc} 的 ${n} 槽位 ${words[pc + 1]} 越界（槽位共 ${slotCount} 个）`);
    }
    if ((n === 'JMP' || n === 'JZ') && (words[pc + 1] < 0 || words[pc + 1] >= words.length)) {
      throw new Error(`verifyVm: pc=${pc} 的 ${n} 目标 ${words[pc + 1]} 越界（字流共 ${words.length} 字）`);
    }
    let net = NET[n];
    if (net === undefined) {
      if (n === 'CALL') net = 1 - words[pc + 2];
      else net = -1; // 二元运算
    }
    depth += net;
    if (depth < 0) {
      throw new Error(`verifyVm: pc=${pc} 的 ${n} 让栈深变成 ${depth}（弹多了）`);
    }
    pc += 1 + ar;
  }
  if (pc !== words.length) throw new Error(`verifyVm: 解码到 ${pc}，字流长度 ${words.length}`);
  if (depth !== 0) throw new Error(`verifyVm: 结束时栈深 ${depth}，应为 0（多压/少压了值）`);
}

// ================================================================ 解释器发射

/**
 * 解释器内部的局部短名池。四组，逐构建挑一组。
 *
 * **必须连 case 体里的局部名一起参数化**：那些名字（a/b/s/i/o/v/n/t/g…）是函数级
 * `var`，若短名池与它们相撞，同一个函数里就会声明两次——要么 SyntaxError，要么后
 * 声明的覆盖先声明的（表现为"某个操作码算错"，与病因隔了两层）。所以这里给 20 个
 * 槽位一起分配字母，而不是只给入口那 6 个。
 *
 * 步长 5 保证同一组内 20 个字母互不相同；组间靠偏移 3 拉开，并给第 1 组及以后加
 * 数字后缀，彻底避开引导器其余部分的短名。
 */
const NAME_SLOTS = ['W', 'T', 'C', 'SK', 'pc', 'sp', 'D',
  'a', 'b', 's', 'i', 'o', 'v', 'n', 't', 'g', 'j', 'pp', 'cc', 'z'];
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
export const NAME_POOLS = 4;

function namePool(k) {
  const m = {};
  NAME_SLOTS.forEach((s, idx) => {
    m[s] = '_' + LETTERS[(idx * 5 + k * 3) % 26] + (k > 0 ? String(k) : '');
  });
  return m;
}

/**
 * 生成外层解释器源码：`function(words, tbl, C, T)`，返回解出的载荷字节。
 *
 * 刻意写成**通用**形态——它不认识 "base64"、"交织"、"密钥流" 这些概念，只认识
 * PUSH/ADD/JMP。所以外层无论读多少遍都读不出产品语义：算法在密文字节码里，而字节码
 * 要靠那张逐构建随机的操作码表才能解码。
 *
 * ## 为什么要多态
 *
 * 只随机化 case 标签的话，**形状匹配**照样能认出"这是个 switch 分发的栈式 VM"——
 * 搜一下 `switch` 加 `case` 加一串算术就命中了。多态化让**形状本身**逐构建变化：
 *
 *   - **分发形态**（3 种）：`switch(操作码)`（case 标签是操作码的随机置换）/
 *     `switch(稠密表[操作码])`（多一张映射表，标签变成 1..N 的**连续值**，落表顺序
 *     也逐构建打乱）/ `if-else` 长链（连 switch 与 case 标签都不存在）。
 *   - **循环骨架**（3 种）：`for(;;)` / `while(1)` / `for(;1;)`。
 *   - **局部短名**（4 组）：见 namePool。
 *   - **handler 顺序**（N! 种）：case/比较的**发射顺序**逐构建打乱。每条分支自带
 *     标签，顺序纯属写法；固定顺序会让"handler 序列"成为可对号入座的签名。
 *   - **handler 算式等价式**（4 种组合）：对称算子操作数交换（`a&b`↔`b&a`、
 *     `a<b`↔`b>a`）、比较结果归一化 `(c)?1:0`↔`+!!(c)`、`x>>>0`↔`(x|0)>>>0`。
 *
 * 三轴（分发/骨架/短名）独立组合 36 种，再乘上后两轴——同一份外壳每次构建的形状都不同，
 * 两次产物之间无法对照。
 *
 * 这是**提高识别成本**，不是让形状不可识别：真要彻底不可识别得做架构级差异（不同
 * 执行模型、不同字节码格式），那是另一个量级的工作。
 *
 * @param {object} o
 * @param {object} o.opmap 名字 → 编号
 * @param {number} o.key 字节码加密密钥
 * @param {number} o.k2 位置混淆因子
 * @param {number} o.outSlot 返回哪个局部
 * @param {function} [o.randInt] (lo,hi)=>int；省略时固定取第 0 种形态（保证可复现）
 * @returns {string} 函数表达式源码
 */
export function emitInterpreter({ opmap, key, k2, outSlot, randInt }) {
  const ri = randInt || ((lo) => lo);
  const form = ri(0, 2);   // 分发形态
  const loop = ri(0, 2);   // 循环骨架
  const np = namePool(ri(0, NAME_POOLS - 1));
  const W = np.W, T = np.T, C = np.C, SK = np.SK, pc = np.pc, sp = np.sp, D = np.D;
  const a = np.a, b = np.b, s = np.s, i = np.i, o = np.o, v = np.v, n = np.n, t = np.t;
  const g = np.g, J = np.j, PP = np.pp, CC = np.cc, Z = np.z;

  // ---- handler 体的逐构建等价改写（2026-10-11 加）----
  //
  // 动机：36 种形态只把**编号与分派骨架**换掉了，handler 的**先后顺序与算式写法**一直
  // 是固定的——语义恢复者照样能按固定顺序做签名匹配（挑一条条指令的攻击就是这么打的：
  // 只要 handler 体文本稳定，指令集就能被逐条认出来）。
  //
  // 两条轴，都只收**逐位等价**的写法：
  //   swapSym：对称算子的操作数交换（a&b → b&a、a<b → b>a）。只碰真正交换律成立的
  //            算子；`a-b` 写成 `b-a`、`a<<b` 写成 `b<<a` 一律不动——那是"错了但大
  //            部分用例看不出来"的典型，减法与移位会当场露馅。
  //   truthify：比较结果归一化的两种写法 `(c)?1:0` ↔ `+!!(c)`。`+!!` 只把布尔化结果
  //            变 0/1，不会对操作数多做一次求值，NaN/对象/字符串都恒等。
  // ri 缺省时（三路对拍里不传 randInt 的那条路）两个开关都取 false，与改造前一致。
  const swapSym = ri(0, 1) === 1;
  const truthify = ri(0, 1) === 1;
  const sym = (x, op, y) => (swapSym ? y + op + x : x + op + y);
  const cmp = (x, op, flip, y) => {
    const lhs = swapSym ? y : x;
    const rhs = swapSym ? x : y;
    const o = swapSym ? flip : op;
    return truthify ? '+!!(' + lhs + o + rhs + ')' : '(' + lhs + o + rhs + ')?1:0';
  };

  // 弹栈必须是 SK[--sp]，**不是** SK[sp--]。
  //
  // 后缀 `--` 的语义是「取旧值再自减」，所以 SK[sp--] 读到的是「栈顶之上那一格」
  // （越界、undefined），而真正的栈顶**从没被弹出**。栈指针由此整体偏一格，之后每个
  // 表达式的操作数都错位——症状是 AGET 读到 undefined[undefined]、ADD 算出 NaN，
  // 与真正的病因隔了两层。
  //
  // 这是"手写栈序"这一整套做法的最终账单。上一轮手写字节码栽在"栈与局部共用一个
  // 数组"，这一轮栽在"后缀自减当弹出用"，两次都是同一条纪律的不同侧面——凡是碰栈
  // 指针的地方，都必须先问"这个下标是第几格"。
  const pop = () => SK + '[--' + sp + ']';
  const push = (x) => '(' + SK + '[' + sp + '++]=' + x + ')';
  const cases = [];

  // case 体**不带 break**——if-else 形态里 break 非法。各形态在装配时自己补。
  const emit = (nm, code) => cases.push({ nm, code });
  // 二元：栈顶是右操作数，先弹的进 b。顺序写反会让 a-b 变 b-a——加法乘法对称看不出来，
  // 只有减法与移位会暴露，属"错了但大部分用例看不出来"的那类。
  const bin = (nm, e) => emit(nm, `{var ${b}=${pop()},${a}=${pop()};${push(e)}}`);

  // 取指口径：`W[pc++]` 执行完 pc 已越过操作码，操作数一律 `W[pc++]`。
  // 写成 `W[++pc]` 会多跳一个字——每个操作数都读错，而程序照样跳得起来。
  emit('PUSH', `{${push(W + '[' + pc + '++]')}}`);
  emit('LD', `{${push(T + '[' + W + '[' + pc + '++]]')}}`);
  emit('ST', `{var ${s}=${W}[${pc}++];${T}[${s}]=${pop()}}`);
  // 基址也从栈上取（不是操作数），这样索引表达式不必是裸变量
  emit('AGET', `{var ${i}=${pop()},${o}=${pop()};${push(o + '[' + i + ']')}}`);
  emit('ASET', `{var ${v}=${pop()},${i}=${pop()},${o}=${pop()};${o}[${i}]=${v}}`);
  emit('LEN', `{var ${o}=${pop()};${push(o + '.length')}}`);
  // NEWU8 是**表达式**：弹尺寸、压新数组，不带目标槽。目标槽是 set 语句的事，让它带
  // operand 就等于让表达式知道自己的去处，破坏"表达式只管压一个值"这条不变量。
  emit('NEWU8', `{var ${n}=${pop()};${push('new Uint8Array(' + n + ')')}}`);
  // DUP / POP：栈深度的显式微调。`ex` 只管"恰好压一个"，凡是需要"多留一份"或"丢掉
  // 一个"的地方（目前只有 or1 的短路）都走这两个，不许在别处手写深度。DUP 读的是栈顶，
  // 即 sp-1 那一格。
  emit('DUP', `{var ${t}=${SK}[${sp}-1];${SK}[${sp}++]=${t}}`);
  emit('POP', `{${sp}--}`);

  bin('ADD', `${a}+${b}`); bin('SUB', `${a}-${b}`);
  bin('MUL', sym(a, '*', b)); bin('AND', sym(a, '&', b));
  bin('OR', sym(a, '|', b)); bin('XOR', sym(a, '^', b));
  bin('SHL', `${a}<<${b}`); bin('SHR', `${a}>>${b}`); bin('USHR', `${a}>>>${b}`);
  // >>>0 的两种等价写法：`x>>>0` 与 `(x|0)>>>0` 对任意值都落在同一个 ToUint32 结果上
  // （ToInt32 与 ToUint32 只差 2^32 的同余类，再取一次 ToUint32 就回来了）。
  emit('U32', `{var ${a}=${pop()};${push(ri(0, 1) === 1 ? '(' + a + '|0)>>>0' : a + '>>>0')}}`);
  bin('LT', cmp(a, '<', '>', b)); bin('LE', cmp(a, '<=', '>=', b)); bin('GT', cmp(a, '>', '<', b));
  bin('GE', cmp(a, '>=', '<=', b)); bin('EQ', cmp(a, '===', '===', b)); bin('NE', cmp(a, '!==', '!==', b));

  emit('JMP', `{${pc}=${W}[${pc}++]}`);
  emit('JZ', `{var ${J}=${W}[${pc}++];if(!${pop()})${pc}=${J}}`);
  emit('CALL', `{var ${PP}=${W}[${pc}++],${n}=${W}[${pc}++],${g}=[];`
    + `for(var ${i}=${n};${i}>0;${i}--)${g}[${i}-1]=${pop()};`
    + `${push('tbl[' + PP + '].apply(null,' + g + ')')}}`);
  emit('NCHK', `{var ${g}=${W}[${pc}++],${CC}=${W}[${pc}++];`
    + `${push('((""+tbl[' + g + ']).indexOf(' + C + '[' + CC + '])<0)?1:0')}}`);
  emit('RET', `{return ${T}[${outSlot}];}`);

  // handler 的**发射顺序**逐构建打乱：每条 case/比较都自带自己的标签（form 0/2 是
  // 操作码，form 1 是它自己的稠密下标 + 1），所以先后顺序纯属写法，语义不变。
  // 这是"handler 体形态"这一轴的另一半——只换算式写法而顺序固定，签名匹配仍可按
  // 固定序列对号入座。
  const seq = cases.map((_, k) => k);
  for (let k = seq.length - 1; k > 0; k--) {
    const q = ri(0, k);
    const tmp = seq[k]; seq[k] = seq[q]; seq[q] = tmp;
  }

  const opExpr = W + '[' + pc + '++]';
  let dispatch;
  if (form === 1) {
    // 稠密表：先把操作码映到 1..N，case 标签于是变成连续值、不再是置换。
    //
    // 表项的值必须是**该操作码自己在 cases 里的下标 + 1**，因为 case 标签也按这个
    // 下标发。曾经把表的稠密值和 case 标签按各自的排列发（一个用打乱后的顺序、一个
    // 用原始顺序），于是两者对不上：执行的是**别的**操作码的代码，表现为跑到某条
    // CALL 时 `tbl[undefined].apply` —— 离病因隔了三层。
    // 打乱只用来决定**落表语句的书写顺序**（让表的排列也逐构建不同），不改映射。
    const order = cases.map((_, k) => k);
    for (let k = order.length - 1; k > 0; k--) {
      const q = ri(0, k);
      const tmp = order[k]; order[k] = order[q]; order[q] = tmp;
    }
    const tblPre = 'var ' + D + '=[];' + order
      .map((idx) => D + '[' + opmap[cases[idx].nm] + ']=' + (idx + 1) + ';').join('');
    dispatch = tblPre + 'switch(' + D + '[' + opExpr + ']){'
      + seq.map((k) => 'case ' + (k + 1) + ':' + cases[k].code + 'break;').join('')
      + 'default:throw new Error("vm")}';
  } else if (form === 2) {
    // if-else 长链：连 switch 与 case 标签都不存在，形状与另两种完全不同。
    //
    // 操作码**必须先取进局部**：`W[pc++]` 写在比较式里会被求值 N 次（一条 case 一
    // 次），每读一个字 pc 就前移一格——于是从第二个分支起全在拿操作数当操作码比，
    // 表现为"跑到第几条就抛 vm"。switch 形态没这个问题是因为 switch 的判据只求值一次。
    // 链上第一条不加 else（`seq` 的首项承担这个位置），顺序由 seq 决定。
    dispatch = 'var ' + D + '=' + opExpr + ';'
      + seq.map((k, pos) => (pos === 0 ? '' : 'else ')
        + 'if(' + D + '===' + opmap[cases[k].nm] + '){' + cases[k].code + '}').join('')
      + 'else{throw new Error("vm")}';
  } else {
    dispatch = 'switch(' + opExpr + '){'
      + seq.map((k) => 'case ' + opmap[cases[k].nm] + ':' + cases[k].code + 'break;').join('')
      + 'default:throw new Error("vm")}';
  }

  // 栈（SK）与局部表（T）必须**两个数组**。曾经图省事让栈直接用 T：pop 读 T[sp--]、
  // push 写 T[sp++]=v，而 T 装着 N/L/SG/循环游标——于是每压一个值就覆盖一个局部。
  const loopPre = loop === 1 ? 'while(1){' : loop === 2 ? 'for(;1;){' : 'for(;;){';
  return '(function(' + W + ',tbl,' + C + ',' + T + '){'
    + 'var ' + SK + '=[];' + sp + '=0;' + pc + '=0;'
    // 就地解密：字节码随产物下发，必须先解开才能执行
    + 'for(var ' + Z + '=0;' + Z + '<' + W + '.length;' + Z + '++)'
    + W + '[' + Z + ']=(' + W + '[' + Z + ']^' + key + '^(((' + Z + '+1)*' + k2 + ')&255))|0;'
    + loopPre + dispatch + '}})';
}

/** 字节码加密：单字节密钥 + 位置混淆。key 与 k2 都要返回——解释器源码里带着这两个
 *  常数硬写进解密循环，只给 key 的话调用方只能瞎猜 k2，解出来的字节码整体错位。 */
export function encryptWords(words, randInt) {
  const key = (randInt(1, 0xff) | 0) || 1;
  const k2 = (randInt(1, 0xffff) | 0) || 2;
  return { key, k2, data: words.map((w, i) => (((w | 0) ^ key ^ (((i + 1) * k2) & 255)) | 0)) };
}