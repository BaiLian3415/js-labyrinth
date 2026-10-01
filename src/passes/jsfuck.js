/**
 * JSFuck 编码器：把一段 ASCII 源码编成只由 [ ] ( ) ! + { } 八个字符构成的表达式
 * （"纯 JSFuck" 家族：语法上只有下标、调用、一元运算与加法）。
 *
 * 为什么不是经典的六个字符：'c'、'o'、'j' 这三个字符在整个可达空间里只有
 * 基串 "[object Object]" 给得出，而它必须写成 `([]+{})`；同理 NaN 走 `(+{}+[])`。
 * 少了 `{}` 就连 'constructor' 都拼不出来（拼不出它 → 拿不到 Function →
 * 一切都无从谈起），所以经典 JSFuck 的实现里 `{}` 也是绕不开的基串字面量。
 *
 * 用途：外壳的 jsfuck 壳形式（shellForm: 'jsfuck'）。引导器里「密钥流生成 +
 * 校验尾差量」那段核心不再以 JS 语句形式出现，而是本模块产出的纯 JSFuck
 * 表达式，运行期经 Function 构造器编回函数再调用；引导器其余部分（段装载、
 * 表派生、投毒）保持原样，照旧过流水线。
 *
 * 路线：S → UTF-8 字节 → 每字节 "%XX" 三连 → 一次 unescape 解出整串。
 *   另一条路（String.fromCharCode 逐字节给码点）也能走通——大写 C 从
 *   escape(",") === "%2C" 的下标 2 取到——但每字节要重新内联一遍取用链，实测
 *   8819 字符/字节，比 unescape 路线贵两个量级（见下面的成本口径）。
 *
 * 字符依赖链（这是个环，必须按下面的顺序破）：
 *   基串直接给  : f a l s e t r u o b j c O 空格 [ ] n d i N I y + 数字
 *   → FUNC        : ([]+[])["constructor"]["constructor"]   ← 只需要直接字符
 *   → "m"         : (FUNC()+[])[14]，即 "function anonymous(...)" 里的 m
 *   → "name" 键   : 拿到 m 之后才能拼出来
 *   → STRING_NAME : ([]+[])["constructor"]["name"] === "String"  ← 给出 S 与 g
 *   → "toString"  : 拿到 S/g 之后才能拼出来
 *   → 任意小写     : (n)["toString"](36)，n=10..35
 *   → "p"         : 上一步给（(25).toString(36) === "p"）
 *   → '%'         : escape(" ")[0]，escape 经 FUNC("return escape")() 取得
 *   若反过来先要 S，就会绕回 m，环就闭合了。
 *
 * 成本（实测，Node 下真 eval + 长度统计）——每字节的开销几乎全在 '%'：
 *   · 老路线 unescape('%XX')      : 每字节要把 '%' 的取用链整个内联一遍，2969
 *                                  字符/字节（get('%') ≈ 2909 占 98%）。
 *   · 现用路线（占位符置换）      : 编码串里用 hex 字母表外的 's' 占位，整串拼
 *                                  好后 .split('s').join('%') 一次换回，get('%')
 *                                  与 get('split') 各只出现一次（固定开销 8181
 *                                  字符），每字节只剩 占位符 + 两个 hex 数字：
 *                                  实测 68~88 字符/字节（取决于该字节的 hex 数字
 *                                  有多贵，'9' 这种要大半串加法，'0' 几乎免费；
 *                                  外壳那段核心是 79）。同一段核心从 2969/字节
 *                                  降到 ~79/字节，即 38 倍。
 *   · String.fromCharCode        : 每字节 ≈ 8819 字符（取用链含 h≈2032、C≈2890，
 *                                  且没有变量 ⇒ 每个字节都要重新内联一遍）。
 *                                  看着更"正规"，实际比 unescape 路线贵两个量级。
 * 没有变量是这套编码的一切代价的根源：任何值要复用只能重新内联，所以"把固定
 * 片段挪到只出现一次的调用里"是本模块唯一有效的优化手段。
 *
 * 限制：只接受 ASCII。fromCharCode/unescape 逐字节走 latin-1，非 ASCII 会静默
 * 走样（实测 "中文字符串" 变成 "ä¸æå­ç¬¦ä¸²"），这里直接报错，不发坏产物。
 * 外壳要编的那段核心是自己写的 ASCII 代码，限制不构成问题。
 */

// ---------------------------------------------------------------------------
// 基串与数字
// ---------------------------------------------------------------------------
const BASES = ['(![]+[])', '(!![]+[])', '([]+{})', '([][[]]+[])', '(+{}+[])', '((+!![]/+[])+[])'];
const BASE_TEXT = ['false', 'true', '[object Object]', 'undefined', 'NaN', 'Infinity'];

/**
 * 求值为数字 n 的表达式。
 * 坑：不能写 `+!![]+ +!![]`——`+ +` 被词法器吃成后置 `++`，SyntaxError。
 * 用 `!+[]`（=true）当加法单元（中间的 ! 隔开两个 +），首项带一元 + 压成数字。
 */
function num(n) {
  return n === 0 ? '+[]' : '+' + new Array(n).fill('!+[]').join('+');
}

/** 数字字符 '0'..'9'。 */
const digitExpr = (d) => '(' + num(d) + '+[])';
const fromBase = (bi, idx) => BASES[bi] + '[' + num(idx) + ']';

/** 直接落在基串里的字符。 */
const direct = new Map();
for (const ch of new Set(BASE_TEXT.join(''))) {
  for (let bi = 0; bi < BASE_TEXT.length; bi++) {
    const idx = BASE_TEXT[bi].indexOf(ch);
    if (idx >= 0) { direct.set(ch, fromBase(bi, idx)); break; }
  }
}
for (let d = 0; d <= 9; d++) direct.set(String(d), digitExpr(d));

// ---------------------------------------------------------------------------
// 惰性解析：很多字符要等其他字符先就位，所以按需构造 + 记忆化
// ---------------------------------------------------------------------------
const memo = new Map();
const building = new Set();

const get = (ch) => (memo.has(ch) ? memo.get(ch) : build(ch));

/** 记忆化复合片段（键以 @ 开头，与单字符键不冲突）。 */
function memoSet(key, value) {
  if (!memo.has(key)) memo.set(key, value);
  return memo.get(key);
}

function build(ch) {
  if (direct.has(ch)) { memo.set(ch, direct.get(ch)); return direct.get(ch); }
  // 环检测：字符依赖链本该无环，撞上就说明漏推了一段，直接把链打出来
  if (building.has(ch)) {
    throw new Error('JSFuck 字符依赖成环，链: ' + [...building].join(' → ') + ' → ' + ch);
  }
  building.add(ch);
  try {
    const v = derive(ch);
    // 只可能是拼错了键名（'constructor' 之类）：任意源码字符不走这里，
    // 它们是 unescape 解出来的。直接报错，别把 null 拼进表达式。
    if (v === null) throw new Error('JSFuck 编码器不认识字符 ' + JSON.stringify(ch));
    memo.set(ch, v);
    return v;
  } finally {
    building.delete(ch);
  }
}

/** 任意短字符串 → 逐字符拼接的字符串表达式（属性键、内联源码片段都用它）。 */
const strExpr = (s) => '(' + [...s].map(get).join('+') + ')';

// ---------------------------------------------------------------------------
// 派生字符
// ---------------------------------------------------------------------------
const FUNC = () => memoSet('@func',
  '([]+[])[' + strExpr('constructor') + '][' + strExpr('constructor') + ']');
// "function anonymous(\n) {\n\n}"：f0 u1 n2 c3 t4 i5 o6 n7 sp8 a9 n10 o11 n12 y13
//                                m14 o15 u16 s17 (18 \n19 )20 sp21 {22 \n23 \n24 }25
const ANON = () => memoSet('@anon', '(' + FUNC() + '()+[])');
const at = (i) => ANON() + '[' + num(i) + ']';

const NAME_KEY = () => memoSet('@nameKey', strExpr('name'));                    // m 已就位
const STRING_NAME = () => memoSet('@stringName',
  '([]+[])[' + strExpr('constructor') + '][' + NAME_KEY() + ']');               // "String"
const TO_STRING_KEY = () => memoSet('@toStrKey', strExpr('toString'));          // S/g 已就位
const RADIX36 = digitExpr(3) + '+' + digitExpr(6);

const UNESCAPE = () => memoSet('@unescape',
  FUNC() + '(' + strExpr('return unescape') + ')()');

function derive(ch) {
  // 先处理破环用的三个字符，必须在通用小写分支之前：
  //   'm' → 来自 "function anonymous(...)"，只需直接字符，无依赖
  //   'S'、'g' → 来自 String 的 .name（拼 "name" 这个键要用到 'm'）
  // 如果把 'm' 交给下面的 (n).toString(36) 分支，它会去要 "toString" 键 → 要 'S'
  // → 要 "String" → 要 "name" 键 → 要 'm'，环就闭合了（实测踩过）。
  switch (ch) {
    case 'm': return at(14);
    case 'S': return STRING_NAME() + '[' + num(0) + ']';
    case 'g': return STRING_NAME() + '[' + num(5) + ']';
    // 大写 C 来自 escape(",") === "%2C" 的下标 2 —— 有了它 String.fromCharCode 就能用了
    case 'C': return CHAR_C();
    case ',': return '([[],[]]+[])[+[]]';                                  // 数组 join → ","
    case '.': return '((+!![])/(+!![]+!![])+[])[!+[]]';                    // "0.5"[1]
    case '(': return at(18);
    case ')': return at(20);
    case '{': return at(22);
    case '}': return at(25);
    case '%': return FUNC() + '(' + strExpr('return escape') + ')()(' + get(' ') + ')[+[]]';
    default: break;
  }
  // 其余小写字母走 (v).toString(36)，v 是 base36 数值：a=10 … z=35
  // （不是字母表下标——'m' 的下标是 12 但 base36 值是 22，搞错会绕回上面那个环）
  if (ch >= 'a' && ch <= 'z') {
    const v = 10 + (ch.charCodeAt(0) - 97);
    return '(' + num(v) + ')[' + TO_STRING_KEY() + '](' + RADIX36 + ')';
  }
  // 注意 '[' ']' 与空格已在基串里（"[object Object]"），不需要派生。
  // 其余 ASCII（大写字母、各种符号）这里一律不派生——它们不作为取值目标出现，
  // 而是由 unescape 从 "%XX" 解出来（见 decodeStrExpr）。
  return null;
}

/** 大写 C（escape(",")[2]）。仅 fromCharCode 路线与 '%' 的 hex 段用得到。 */
function CHAR_C() {
  return memoSet('@charC',
    FUNC() + '(' + strExpr('return escape') + ')()(' + get(',') + ')[!+[]+!+[]]');
}

// ---------------------------------------------------------------------------
// 任意字符串 → unescape(占位符串.split('s').join('%'))
// ---------------------------------------------------------------------------
// 's' 是 hex 数字（0-9a-f）里不会出现的字符，又不贵（"false"[3]）：
// 编码串里全部用它当 '%' 的占位，整串拼完只做一次 split/join。
const PH = 's';
const SPLIT_KEY = () => memoSet('@splitKey', strExpr('split'));
const JOIN_KEY = () => memoSet('@joinKey', strExpr('join'));

/** 字节 → 占位符 + 两个 hex 数字的拼接表达式。 */
function byteSeq(b) {
  const hex = b.toString(16).padStart(2, '0');
  return get(PH) + '+' + get(hex[0]) + '+' + get(hex[1]);
}

export function decodeStrExpr(s) {
  // 逐字节走 latin-1，所以输入必须是 ASCII。非 ASCII 会静默走样——宁可直接报错，
  // 也不发一份跑起来字符串是坏的产物。要支持非 ASCII 得走 decodeURIComponent，
  // 而它要的大写 D/U/R/I 里有拿不到的。
  for (const ch of s) {
    if (ch.charCodeAt(0) > 0x7f) {
      throw new Error('JSFuck 编码器只接受 ASCII（遇到 ' + JSON.stringify(ch) + '）');
    }
  }
  const bytes = [...new TextEncoder().encode(s)];
  const encoded = bytes.map(byteSeq).join('+');
  return UNESCAPE() + '((' + encoded + ')[' + SPLIT_KEY() + '](' + get(PH) + ')[' +
    JOIN_KEY() + '](' + get('%') + '))';
}

/** 整份程序：还原 code 并执行。 */
export function jsfuckProgram(code) {
  return FUNC() + '(' + decodeStrExpr(code) + ')()';
}

export default { decodeStrExpr, jsfuckProgram };