/**
 * 外壳解码链的**声明式 IR**：一份语义，两处发射（经典 JS 形态 / 密文字节码形态）。
 *
 * ## 为什么要有这一层
 *
 * 上一版尝试是**手写字节码**：把解码链逐句翻成 477 个字的栈式程序，结果栽在
 * 四类与算法毫无关系的错误上——操作数栈与局部表共用一个数组、取指多跳一个字、
 * AGET 的槽来自操作数却顺手多压了一个局部、循环退出标签与「下一个元素」落点合并。
 * 这四类错误的共同点：**它们不在任何一条指令里，而在「整份程序手写栈序」这个做法
 * 本身**。只要栈序是由人逐条摆出来的，它就一定会错，而且错得安静——程序照样跳得
 * 起来、只是算错值或永不返回。
 *
 * 所以改成这里的形式：解码链表达成**三地址 + 结构化控制流**的树，然后
 *   - `emitJs` 把它发成普通 JS 语句（语义基准）；或
 *   - `emitVm`  把它发成字节码，由一个通用栈式解释器执行（不可读形态）。
 *
 * 不变量只有一个，而且集中在 `emitExpr` 一处：**任何表达式发射后恰好在操作数栈上
 * 留一个值**。谁破坏了它，整条链的对拍就会挂，不会有别的表现。控制流同理——树里
 * 没有标签、没有回填，`continue`/短路都由发射器在结构上就地处理。
 *
 * ## 与 shell.js 现有引导器的关系
 *
 * 这一层**不复用** shell.js 那套语句多态发射（`P()` 二/三形态、声明合分、原语多族
 * 等）。那是另一件事：形态多态对付的是"两次构建长得一样"，而这里对付的是"算法本身
 * 明文可读"。两者正交，混在一起会让对拍失去意义——基准必须是一份**朴素、直白、
 * 逐位可核对**的 JS，而不是一份形态随机的 JS。
 *
 * 因此语义基准是 `emitJs` 的输出，正确性靠三路对拍钉死：
 * 手写参考实现 ⟷ emitJs ⟷ emitVm。见 test/shell-bytecode.js。
 */

// ---------------------------------------------------------------- 表达式节点
//
// op 取值：+ - * & | ^ << >> >>> < > <= >= == !=
// 「取地址」类（数组读）用 idx；写用 store 语句。

const num = (v) => ({ k: 'num', v: v | 0 });
const vr = (n) => ({ k: 'var', n });
const idx = (o, i) => ({ k: 'idx', o, i });
const bin = (op, a, b) => ({ k: 'bin', op, a, b });
const u32 = (a) => ({ k: 'un', op: '>>>0', a });
const call = (f, args) => ({ k: 'call', f, args });
const newU8 = (size) => ({ k: 'new', size });

// ---------------------------------------------------------------- 语句节点

const set = (v, e) => ({ k: 'set', v, e });
const store = (o, i, e) => ({ k: 'store', o, i, e });
const iff = (c, then, els) => ({ k: 'if', c, then, els });
const loop = (init, c, update, body) => ({ k: 'for', init, c, update, body });
const blk = (list) => ({ k: 'block', list });
/** `continue` —— 结构化控制流的一等公民，发射器负责落点 */
const cont = () => ({ k: 'continue' });
/**
 * `v = (e || 1)`。外壳里只有投毒那两处用到这个形状。
 *
 * 刻意**不做** `||` 表达式节点：短路求值要求发射器在表达式中间跳分支，
 * 「压一个操作数 / 跳走」这两件事天然冲突，最后一定会写出一半栈序一半跳转的
 * 半成品。做成语句就没有这个问题了——赋值只发生在落点上。
 */
const or1 = (v, e) => ({ k: 'or1', v, e });

// ---------------------------------------------------------------- 链的定义

/** 校验尾 4 字节按字节序拼回的 uint32。 */
function tailExpr(q, L, tailOrder) {
  const at = (k) => idx(q, k === 0 ? vr(L) : bin('+', vr(L), num(k)));
  const sh = tailOrder === 0 ? [24, 16, 8, 0] : [0, 8, 16, 24];
  // 四项**一律**套上自己的移位，包括末项。大端序末项移位恰是 0，写不写都对；
  // 小端序末项要 <<24——第一版在这里图省事少写了一次，于是大端全绿、小端全错。
  // 这类"只在一半用例下成立"的省略正是三路对拍要抓的东西：两组用例各覆盖一种
  // 字节序，任何一边绿都不能说明另一边对。
  let e = num(0);
  for (let k = 0; k < 4; k++) {
    e = bin('|', e, bin('<<', at(k), num(sh[k])));
  }
  return u32(e);
}

/**
 * 组装解码链 A/B/C 三段。
 *
 * 变量名是**语义名**（`n`/`pc`/`bd2`/`u`…），发射器各自映射到目标命名空间：
 * `emitJs` 映射成引导器的 `_0x` 风格短名，`emitVm` 映射成 VM 局部槽。两边不必同名，
 * 但必须**槽位一一对应**——这是三路对拍能证明"逐位一致"的前提。
 *
 * 输入变量（由引导器算好后灌入）：N L SG P1 P2 HB E G D M2 SB
 * 原语（由函数表提供）：xs32 mix ipos mul32 cc
 * 输出变量：q（Uint8Array，载荷明文字节）
 *
 * @param {object} cfg
 * @param {number} cfg.tailOrder  校验尾字节序：0 大端、1 小端
 * @param {boolean} cfg.probeFunction 是否也探 Function（evalStyle===1）
 * @param {number} cfg.junkMult   投毒乘法因子
 * @param {number} cfg.posHash    位置散列开关（传给 mix 的 ph）
 * @returns {object} 语句树
 */
export function buildDecodeChain({ tailOrder, probeFunction, junkMult, posHash }) {
  const list = [];
  const put = (s) => list.push(s);

  // ================= A：段装载（内联 base64 + 交织落位） =================
  put(set('r', newU8(vr('N'))));
  put(set('n', num(0)));
  put(set('acc', num(0)));
  put(set('pc', num(0)));
  put(set('bd2', num(0)));

  const charLoopBody = [
    set('c', idx(vr('M2'), call('cc', [vr('sg'), vr('q2')]))),
    // 坏字符：计数后跳过本字符（原版 continue）
    iff(bin('<', vr('c'), num(0)), blk([
      set('bd2', bin('+', vr('bd2'), num(1))),
      cont(),
    ])),
    set('acc', bin('+', bin('*', vr('acc'), num(64)), vr('c'))),
    set('pc', bin('+', vr('pc'), num(6))),
    iff(bin('>', vr('pc'), num(7)), blk([
      set('pc', bin('-', vr('pc'), num(8))),
      store(vr('r'), vr('n'), bin('&', bin('>>>', vr('acc'), vr('pc')), num(255))),
      set('n', bin('+', vr('n'), num(1))),
      // acc &= (1 << pc) - 1
      set('acc', bin('&', vr('acc'), bin('-', bin('<<', num(1), vr('pc')), num(1)))),
    ])),
  ];

  put(loop(
    set('j2', num(0)),
    bin('<', vr('j2'), vr('SG')),
    set('j2', bin('+', vr('j2'), num(1))),
    blk([
      set('sg', idx(vr('G'), idx(vr('D'), vr('j2')))),
      loop(
        set('q2', num(0)),
        bin('<', vr('q2'), lenOf('sg')),
        set('q2', bin('+', vr('q2'), num(1))),
        charLoopBody,
      ),
    ]),
  ));

  // ================= B：密钥流 + 校验尾差量 =================
  put(set('q', newU8(vr('N'))));
  put(set('u', u32(vr('E'))));
  put(set('pv', num(0)));
  put(set('h', u32(vr('HB'))));

  put(loop(
    set('t2', num(0)),
    bin('<', vr('t2'), vr('N')),
    set('t2', bin('+', vr('t2'), num(1))),
    blk([
      set('u', call('xs32', [vr('u')])),
      set('u', u32(bin('+', bin('+', vr('u'), vr('pv')), vr('t2')))),
      set('kb', bin('&', bin('^', bin('^', vr('u'), bin('>>>', vr('u'), num(15))),
        bin('>>>', vr('u'), num(22))), num(255))),
      set('v', bin('&', bin('^', idx(vr('SB'), idx(vr('r'),
        call('ipos', [vr('t2'), vr('P1'), vr('P2'), vr('N')]))), vr('kb')), num(255))),
      store(vr('q'), vr('t2'), vr('v')),
      set('pv', vr('v')),
      iff(bin('<', vr('t2'), vr('L')), blk([
        set('h', call('mix', [vr('h'), vr('v'), vr('t2'), num(posHash)])),
      ])),
    ]),
  ));

  put(set('bd', u32(bin('^', bin('^', vr('h'), vr('E')), tailExpr(vr('q'), 'L', tailOrder)))));

  // ================= C：防篡改判定 + 投毒 =================
  put(set('bd', u32(bin('^', vr('bd'), call('mul32', [vr('bd2'), num(junkMult)])))));

  // if (bd2 > 0 && bd === 0) bd = 1 —— 短路写成嵌套 If，不用 && 表达式
  put(iff(bin('>', vr('bd2'), num(0)), blk([
    iff(bin('===', vr('bd'), num(0)), blk([
      set('bd', num(1)),
    ])),
  ])));

  // 原生探针：(("" + eval).indexOf("native") < 0) → 视为被换钩子。
  // 「探哪个全局」是常量 P_EVAL / P_FN，映射到函数表下标。
  const probe = (probeVar, keyVar) => iff(
    bin('<', { k: 'nchk', g: probeVar, c: 0 }, num(0)),
    blk([or1('bd', bin('^', vr('bd'),
      call('mul32', [bin('^', vr('E'), vr(keyVar)), num(junkMult)])))]),
  );
  put(probe('P_EVAL', 'L'));
  if (probeFunction) put(probe('P_FN', 'N'));

  put(iff(bin('!==', vr('bd'), num(0)), blk([
    set('u2', call('xs32', [bin('^', vr('E'), vr('bd'))])),
    iff(bin('<', vr('L'), num(8)), blk([
      set('lim', vr('L')),
    ]), blk([
      set('lim', num(8)),
    ])),
    loop(
      set('i', num(0)),
      bin('<', vr('i'), vr('lim')),
      set('i', bin('+', vr('i'), num(1))),
      blk([
        set('u2', call('xs32', [bin('^', bin('^', vr('u2'), vr('bd')), vr('i'))])),
        store(vr('q'), vr('i'),
          bin('&', bin('^', idx(vr('q'), vr('i')), bin('>>>', vr('u2'), num(11))), num(255))),
      ]),
    ),
  ])));

  return blk(list);
}

// `sg.length`：IR 里没有成员访问节点（只有 idx），长度用 idx 的伴生节点表示。
// 单独收在这里，避免上面凭空出现 lenOf 这种半吊子表达式。
function lenOf(v) {
  return { k: 'len', of: vr(v) };
}

// ---------------------------------------------------------------- 导出

export const E = { num, vr, idx, bin, u32, call, newU8, lenOf };
export const S = { set, store, iff, loop, blk, cont, or1 };