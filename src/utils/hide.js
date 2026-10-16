import rand from './rand.js';
const { randInt, randHex } = rand;
import parser from '../ast/parser.js';
const { parse } = parser;
/**
 * 隐蔽语句构造工具，产物中不出现高指纹明文。
 *
 * debugger 触发器的隐蔽做法。源码里没有 "debugger" 明文，也没有明文的
 * charCode 序列 100,101,...。运行时用
 * Function(String.fromCharCode((m1^m2), ...)) 构造触发函数，m1^m2 恒等于
 * 目标 charCode，掩码每次构建随机，所以没有固定指纹。触发函数缓存在
 * globalThis 的构建期随机属性上，机制与毒药标志相同，走字符串属性访问，
 * 不落 var 绑定，mangle 重命名和语句搬移都影响不到它，同一 helpers 实例
 * 的所有注入点共用一份构造结果，热路径不重复构造。CSP 之类禁用 Function
 * 构造器的环境降级成空函数，检测失效但不影响原逻辑执行。
 */

/**
 * obfStrExpr 的 AST 版本。把表达式源码解析成节点，直接拼进 t.* 构造的
 * AST，head 检测点即走这条路径。掩码机制与源码注入路径 dbgVarSource、
 * buildSentinelSrc 相同。
 * @param {string} s 目标字符串
 * @param {string} [tbl] 运行时字符表绑定名
 * @returns {object} 表达式节点
 */
function obfStrNode(s, tbl, fcc) {
  return parse(obfStrExpr(s, tbl, fcc), { sourceType: 'script' }).program.body[0].expression;
}

// "debugger" 的 charCode 序列。仅构建期使用，不进入产物明文。
const DBG_CODES = [100, 101, 98, 117, 103, 103, 101, 114];

/**
 * globalThis 的安全引用表达式，**逐构建随机形态**。
 *
 * 为什么必须随机：这段链原先在 5 个模块里各写一份且**逐字节相同**（hide / domainLock /
 * integrityCheck / stringArray / banner），任何一份产物里都能 grep 到它，等于一个跨构建
 * 常量。2026-10-15 实测它是 loader 明文区里最大的一段固定骨架（单构建出现两次、
 * 105 个 token 在 4 个 seed 下全同）。
 *
 * 形态怎么随机才不动语义：4 层候选（globalThis → self → window → global，末位兜底 `{}`）
 * 各自独立决定"条件取反与否"。`C?A:R` 与 `¬C?R:A` 逐位等价，于是 4 层共 16 种形态
 * 全部严格等价。
 *
 * **取反必须写成 `===`，不能靠交换操作数**：条件是 `typeof G!==typeof void 0`，
 * 它的否定是 `typeof void 0===typeof G`。写成 `typeof void 0!==typeof G` 是**另一个
 * 恒真的东西**——`a!==b` 与 `b!==a` 是同一条命题，不是取反。结果是 globalThis 已定义
 * 时仍然走进兜底分支，在 Node 上返回 `self`/`window` 并直接 ReferenceError。
 * 2026-10-15 实测：写错这一处的版本 5 种模拟宿主里错 54/80 种，antiCDP 与
 * debugProtection 的产物全部抛错；而这两种 pass 恰好是唯一会把它注入到多处的地方，
 * 所以症状是"只有开 antiCDP/debugProtection 才炸"，与病因隔了两层。
 *
 * **不要**改成 `||` 短路那种"看着更短"的写法：三元取的是第一个**已定义**的全局，
 * `||` 取的是第一个**真值**的全局，对"已定义但为假值"的宿主有语义差。
 *
 * 为什么是函数而不是模块级常量：形态要走构建种子流，模块加载期还没播种，那时求值
 * 就不具可复现性（AGENTS「逐字节可复现是特性」）。一律在 pass 运行期调用。
 *
 * **历史那一份形态（全不取反）本身要剔掉**：它就是被替换掉的那个跨构建常量，若仍以
 * 1/16 的概率出现，实测仍有约三分之一的产物可被 grep 命中（每份产物 2~5 处注入，
 * 命中概率 = 1-(15/16)^n）。所以 flip 取 0 时强制置 1，实际形态 15 种。
 *
 * bit 的含义是「该层是否取反」，所以"全不取反"= 0 —— 剔除条件必须对着这个含义写。
 * 这里踩过一次：先前把 bit 的含义设成「是否保持原形态」，结果剔除条件写成
 * `mask === 0`，实际放行的恰恰是**全取反**，而历史形态（全不取反）走的是 mask === 15，
 * 于是它照旧以 1/16 出现，断言从 24/24 命中降到 8/24 就卡住了——看着像"修了大半"，
 * 实际是剔错了方向。
 */
const GLOBAL_CANDS = ['globalThis', 'self', 'window', 'global'];
function globalRef() {
  let flip = 0;
  for (let i = 0; i < GLOBAL_CANDS.length; i++) flip |= randInt(0, 1) << i;
  if (flip === 0) flip = 1;
  let out = '{}';
  for (let i = GLOBAL_CANDS.length - 1; i >= 0; i--) {
    const g = GLOBAL_CANDS[i];
    out = (flip >> i) & 1
      ? 'typeof void 0===typeof ' + g + '?' + out + ':' + g
      : 'typeof ' + g + '!==typeof void 0?' + g + ':' + out;
  }
  return '(' + out + ')';
}

/**
 * 生成把字符串 s 拼出来的掩码恒等式表达式源码。
 * 每个字符写成 (0x m1 ^0x m2)，以该值作下标从运行时字符表取出，m1^m2
 * 恒等于 charCode，再拼接重组。产物里没有明文目标串，没有固定的
 * charCode 序列，也不出现 String.fromCharCode 调用点，掩码每次构建随机。
 * tbl 省略时回退 fromCharCode 形态，走无内核的降级链路。
 *
 * 字符表只有 256 槽（码 0..255），code >= 256 的字符（汉字等）走表会取到
 * undefined、重组出的串整段损坏（干净产物被自己的完整性校验投毒）。这类
 * 字符改走内核 fcc（fcc(c) = c < 256 ? 表[c] : String.fromCharCode(c)），
 * 掩码与拼接顺序不变；fcc 缺失时该字符退回原生 fromCharCode。按 UTF-16
 * 码元逐位发：代理对的两半各自成项，拼接后仍是原字符。
 * @param {string} s 目标字符串
 * @param {string} [tbl] 运行时字符表绑定名
 * @param {string} [fcc] 内核 fcc 函数名（rt.fcc）
 * @returns {string} 表达式源码
 */
function obfStrExpr(s, tbl, fcc) {
  const parts = [];
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const m1 = 0x101 + randInt(0, 0xfefe);
    const m2 = m1 ^ code;
    parts.push({ p: '(0x' + m1.toString(16) + '^0x' + m2.toString(16) + ')', wide: code >= 256 });
  }
  const wideRef = (x) => fcc ? fcc + '(' + x.p + ')' : 'String.fromCharCode(' + x.p + ')';
  if (tbl) {
    // 字符表引用只求值一次就取回，tbl 形态是一次懒初始化 getter 调用。原
    // 写法每字符调一次表，在哨兵这类每次函数调用都要重组的位置会放大成
    // 数十万次内核调用，实测占关 VMP 产物总耗时约 70%。掩码、取字与拼接
    // 顺序都不变。
    if (parts.length > 2) {
      // IIFE 形参名逐调用随机（`_0` + 2~4 位 hex）。它是纯文本模板里的固定名，
      // mangle 够不着的位置（mangle 之后才注入的 integrityCheck 头部）会让它跨
      // 构建固定（2026-10-13 实测：单个产物里 163 处 `_0T`）。形参遮蔽恒安全：
      // 任何名字填进来，IIFE 体内的引用都指向该形参，不存在撞名改语义；
      // `_0` 开头避开 RESERVED 关键字。随机性走构建种子流，同 seed 可复现。
      const T = '_0' + randHex(randInt(2, 4));
      return '((function(' + T + '){return ' +
        parts.map((x) => x.wide ? wideRef(x) : T + '[' + x.p + ']').join('+') + ';})(' + tbl + '))';
    }
    return '(' + parts.map((x) => x.wide ? wideRef(x) : tbl + '[' + x.p + ']').join('+') + ')';
  }
  const chunks = [];
  for (let i = 0; i < parts.length; i += 4) {
    chunks.push('String.fromCharCode(' + parts.slice(i, i + 4).map((x) => x.p).join(',') + ')');
  }
  return '(' + chunks.join('+') + ')';
}

/**
 * 生成动态 debugger 触发器的构造器源码，由 Function 包裹表重组出的
 * "debugger"。tbl 提供时不出现 String.fromCharCode 调用点。
 * @param {string} [tbl] 运行时字符表绑定名
 * @returns {string} 构造器表达式源码
 */
function dbgFnSource(tbl) {
  const parts = [];
  for (const c of DBG_CODES) {
    const m1 = 0x101 + randInt(0, 0xfefe);
    const m2 = m1 ^ c;
    parts.push('(0x' + m1.toString(16) + '^0x' + m2.toString(16) + ')');
  }
  if (tbl) {
    return 'Function(' + parts.map((p) => tbl + '[' + p + ']').join('+') + ')';
  }
  return 'Function(String.fromCharCode(' + parts.join(',') + '))';
}

/**
 * 创建一组隐蔽 debugger 构造助手。
 * 同一实例即同一 cacheKey 下，所有注入点在运行时共享一份构造结果。
 * cacheKey 固定使用 `__d` 前缀，与毒药标志的 `__x` 前缀在字面上隔开。
 * 两者都存成 globalThis 属性，一旦撞名，调试缓存里的真值函数会被解码器
 * 误判成毒药标志，导致全量输出腐蚀。`__d` 与 `__x` 各自拼接随机 hex，
 * 其余部分逐构建唯一。
 * @param {string} [tbl] 运行时字符表绑定名，取自 ctx.rt.tbl
 * @returns {{ varSource: (name: string) => string }} varSource(name) 生成 `var NAME=G[k]||(G[k]=(安全构造));` 源码
 */
function makeDbgHelpers(tbl) {
  const cacheKey = '__d' + randInt(0x100000, 0xffffff).toString(16);
  // 一次只取一个形态：同一句 var 里的两处 G 必须是同一个写法（取值当然相同，
  // 但同形态更短、也免得读者以为它们可能指向不同对象）
  const G = globalRef();
  const varSource = (name) =>
    'var ' + name + '=' + G + '["' + cacheKey + '"]||(' + G +
    '["' + cacheKey + '"]=(function(){try{return ' + dbgFnSource(tbl) +
    ';}catch(_0xe){return function(){};}})());';
  return { varSource };
}

export default { makeDbgHelpers, obfStrExpr, obfStrNode, dbgFnSource, globalRef };
