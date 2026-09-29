/**
 * 「不混淆项」挑选器的源码扫描器（纯词法扫描，界面侧独立模块）。
 *
 * 为什么不用解析器：src/ast/parser.js 在 build 的 GATED_PREFIXES 里，受保护、
 * 不下发浏览器。把它加进公开白名单等于把 63 KB 解析器发给客户端，会直接毁掉
 * 「核心不在产物里」这条保护（部署形态的核心压根不下发，正是靠这条）。所以
 * 这里自建词法扫描，代价是类别靠上下文推断。
 *
 * **类别的真实作用**：它决定勾选项写进哪份名单——标识符（变量/函数/参数/属性/类）
 * 写 excludedIdentifiers，字符串字面量写 excludedStrings。引擎侧两份名单的生效
 * 位置不同：前者管绑定名与属性名（mangle / objectKeys / renameProperties），
 * 后者管字符串字面量（stringArray / objectKeys / vm）。所以列错栏不是"显示问题"，
 * 而是**排除直接落空**：三元真支里的字符串若被当成属性名，勾了会写进标识符名单，
 * 那个串照旧被池化——这正是"勾了还是混淆了"的来源。推断规则尽量贴语法：
 *
 *   - 字符串后跟 ':' 只在不处于 case 标签 / 三元真支时才算对象键；
 *   - 标识符后跟 ':' 同理（且解构 {a: b} 的 a 也是属性名）；
 *   - a['k'] / a?.['k'] 里的字符串是属性名，归属性栏；
 *   - obj.k / obj?.k、get/set 访问器名归属性栏；
 *   - 无括号单参箭头 x => 的 x 归参数栏。
 *
 * 扫描是"尽力而为"的：闭包外无法 100% 判定对象字面量与语句块，两处已知的显示偏差
 * ——语句标签 `lbl:` 会被归到属性栏、方法简写 `{ m() {} }` 的 m 会被归到变量栏——
 * 都不影响排除本身：标签名引擎侧从不改名，方法名在两条名单里都是全名等值比较，
 * 从哪一栏勾上都一样生效，只是列的位置不贴切。要修得先能判定对象字面量，那就得
 * 上解析器，代价见上面那段，不值得。
 */

export const SCAN_KINDS = ['func', 'class', 'param', 'prop', 'var', 'str'];

// 标识符字符集。范围起点是 U+00A0（NBSP）而不是空格——写成字面量时它是个不可见
// 字符，复制/编辑器一动就会退化成空格（0x20），于是 ID_START 连空格都算标识符、
// 整行被当成一个名字扫进来。这里一律用转义写，别改回字面量。
const ID_START = /[A-Za-z_$\u00a0-\uffff]/;
const ID_PART = /[A-Za-z0-9_$\u00a0-\uffff]/;

const SCAN_KEYWORDS = new Set(('break case catch class const continue debugger default delete do else export extends '
  + 'finally for function if import in instanceof let new return super switch this throw try typeof var void '
  + 'while with yield static async await enum null true false of get set arguments').split(' '));

const SCAN_GLOBALS = new Set(['Array', 'Object', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Symbol', 'Proxy',
  'Reflect', 'BigInt', 'console', 'document', 'window', 'globalThis', 'process', 'require', 'module',
  'exports', 'global', 'undefined', 'NaN', 'Infinity', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'fetch', 'Buffer', 'WebAssembly', 'Int8Array', 'Uint8Array', 'Int32Array', 'Uint32Array', 'Float32Array',
  'Float64Array', 'ArrayBuffer', 'DataView', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'Intl',
  'queueMicrotask', 'structuredClone', 'crypto', 'performance', 'navigator', 'location', 'history',
  'localStorage', 'sessionStorage', 'eval', 'Function']);

/** 字符串字面量结束后的占位记号：让"值的结尾"这件事在 lastSig 上可判。 */
const STR_END = '@';

/** 某个有效记号是否是「值」（标识符 / ')' / ']' / 字符串字面量），用于判定 a[...] 是成员访问。 */
function isValueEnd(sig) {
  if (sig === ')' || sig === ']' || sig === STR_END) return true;
  if (!sig) return false;
  if (ID_START.test(sig[0]) && /^[A-Za-z0-9_$]*$/.test(sig.slice(1))) return !SCAN_KEYWORDS.has(sig);
  return false;
}

/**
 * 扫出源码里出现的标识符与字符串字面量，按上下文推断类别。
 * @param {string} code 源码
 * @returns {{func:string[],class:string[],param:string[],prop:string[],var:string[],str:string[]}}
 */
export function scanIdentifiers(code) {
  const found = new Map();
  const add = (name, kind) => {
    if (!name || SCAN_KEYWORDS.has(name) || SCAN_GLOBALS.has(name)) return;
    let s = found.get(name);
    if (!s) { s = new Set(); found.set(name, s); }
    s.add(kind);
  };
  // 字符串字面量单独收：它们写的是 excludedStrings 而不是 excludedIdentifiers，
  // 而且不能用上面的 add —— 那边按标识符规则过滤关键字与宿主全局，对字符串不适用。
  const strs = new Set();
  const addStr = (v) => {
    if (v.length === 0 || v.length > 80) return;   // 空的没意义，超长的清单 unusable
    strs.add(v);
  };

  const n = code.length;
  let i = 0;
  let afterDot = false;
  let pendingWord = '';
  let expectParams = false;
  // 最近一个有效记号（词存原文、单字符存该字符、字符串存 STR_END）。判断
  // "后跟冒号的字符串/标识符是不是对象键"要靠它区分 case 标签与三元真支。
  let lastSig = '';
  // 每层圆括号一个缓冲：先按常规推断暂存，等这层收尾才知道是不是形参表
  const levels = [{ items: [], isParams: false }];
  const top = () => levels[levels.length - 1];
  // 方括号层：记录每个 '[' 是不是「计算成员访问」（a[k] / a?.[k]）而不是数组/
  // 解构字面量。字符串落在成员层的正中间且后跟 ']' 时，它是属性名。
  const brackets = [];
  const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  /** 从 from 起跳过空白，返回下一个有效字符的下标（越界返回 n）。 */
  const nextSigIdx = (from) => { let j = from; while (j < n && isSpace(code[j])) j++; return j; };

  while (i < n) {
    const c = code[i];

    if (c === '/' && code[i + 1] === '/') { while (i < n && code[i] !== '\n') i++; continue; }
    if (c === '/' && code[i + 1] === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2; continue;
    }

    if (c === '"' || c === "'" || c === '`') {
      const q = c; const start = i;
      i++;
      let closed = false;
      while (i < n) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === q) { i++; closed = true; break; }
        if (q !== '`' && code[i] === '\n') break;
        i++;
      }
      if (closed) {
        const raw = code.slice(start + 1, i - 1);
        const before = lastSig;
        const next = code[nextSigIdx(i)];
        if (next === ':' && before !== 'case' && before !== '?') {
          // 对象字面量的字符串键：'strKey': 1 —— 它是属性名，进 prop 栏。
          // case 'x': 与 c ? 'a' : 'b' 里的冒号不是键值分隔，那两处是普通字面量，
          // 归到 str 栏（否则勾了会写进标识符名单，字符串照旧被池化）。
          add(decodeStrLiteral(raw), 'prop');
        } else if (next === ']' && before === '[' && brackets.length && brackets[brackets.length - 1]) {
          // a['k']：字符串是属性名而不是普通字面量。归进 prop 栏，勾选写
          // excludedIdentifiers，objectKeys 与 mangle 才会按属性名保住它
          // （字符串名单管的是"字面量不收集/不编码"，管不到属性名拆分）。
          add(decodeStrLiteral(raw), 'prop');
        } else if (q !== '`') {
          // 纯字面量的字符串进 str 栏。带 ${} 的模板是动态拼的、整体不能作字面量保留，
          // 不收——收进来只会让用户勾了却没效果。
          addStr(decodeStrLiteral(raw));
        }
      }
      afterDot = false; pendingWord = ''; lastSig = STR_END;
      continue;
    }

    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < n && ID_PART.test(code[j])) j++;
      const w = code.slice(i, j);
      const before = lastSig;
      if (w === 'function' || w === 'class' || w === 'async') {
        pendingWord = w; expectParams = true;
      } else if (w === 'get' || w === 'set') {
        pendingWord = 'prop';            // 访问器：get val() 的 val 是属性名
      } else if (afterDot) {
        top().items.push({ name: w, kind: 'prop' });
      } else if (pendingWord) {
        if (pendingWord === 'async') {
          // async 后面的名字不是被声明的函数名（那一个走上面的 function 分支）：
          // async x => x / async m(){} 都得按上下文常规定类，否则参数被塞进函数栏。
          const objKey = code[nextSigIdx(j)] === ':' && before !== '?' && before !== 'case';
          top().items.push({ name: w, kind: objKey ? 'prop' : 'var' });
          expectParams = true;
          pendingWord = '';
        } else {
          top().items.push({ name: w, kind: pendingWord === 'class' ? 'class' : (pendingWord === 'prop' ? 'prop' : 'func') });
          pendingWord = '';
          expectParams = true;             // 名字之后紧跟的 '(' 是形参表
        }
      } else {
        // 对象字面量的键：标识符后跟冒号。case a: 的标签与 c ? a : b 的三元真支
        // 不是键值对，那两处保持 var（排除名单对标识符本来就是全名等值比较，
        // 归栏只影响显示与"写进哪份名单"，而这两处的名字都属于标识符名单）。
        const objKey = code[nextSigIdx(j)] === ':' && before !== '?' && before !== 'case';
        top().items.push({ name: w, kind: objKey ? 'prop' : 'var' });
      }
      afterDot = false;
      lastSig = w;
      i = j;
      continue;
    }

    if (c === '.') { afterDot = true; lastSig = '.'; i++; continue; }

    if (c === '[') {
      // 成员访问还是字面量：看 '[' 前面是不是一个值的结尾（标识符 / ')' / ']' /
      // 字符串 / '.'）。a[k]、a?.[k] 是成员访问，[1,2]、const [a] = x 是字面量。
      brackets.push(afterDot || isValueEnd(lastSig));
      afterDot = false; pendingWord = ''; lastSig = '[';
      i++;
      continue;
    }

    if (c === ']') {
      if (brackets.length) brackets.pop();
      afterDot = false; lastSig = ']';
      i++;
      continue;
    }

    if (c === '(') {
      levels.push({ items: [], isParams: expectParams || pendingWord !== '' });
      expectParams = false; afterDot = false; lastSig = '(';
      i++;
      continue;
    }

    if (c === ')') {
      const lv = levels.length > 1 ? levels.pop() : levels[0];
      // 箭头函数：')' 之后是 '=>'，这层即便没被标记成形参表也要按形参收
      let j = nextSigIdx(i + 1);
      if (code[j] === '=' && code[j + 1] === '>') lv.isParams = true;
      for (const it of lv.items) add(it.name, (lv.isParams && it.kind === 'var') ? 'param' : it.kind);
      afterDot = false; lastSig = ')';
      i++;
      continue;
    }

    // 无括号单参箭头：x => ...，x 是参数。lastSig 必须就是刚扫过的那个标识符，
    // 否则说明 '=' 前面还有别的记号（如 x = y => 的 y 才是参数）。
    if (c === '=' && code[i + 1] === '>') {
      const lv = top();
      const it = lv.items[lv.items.length - 1];
      if (it && it.kind === 'var' && it.name === lastSig) it.kind = 'param';
      afterDot = false; lastSig = '=';
      i++;
      continue;
    }

    if (c === '{' || c === '[' || c === ';' || c === ',') pendingWord = '';
    if (!isSpace(c)) { afterDot = false; if (c !== '(') pendingWord = ''; lastSig = c; }
    i++;
  }
  // 未闭合的括号（源码有语法错误时）：把残留条目按 var 收掉，别丢
  for (const lv of levels) for (const it of lv.items) add(it.name, it.kind);

  // 同名多身份（同名形参又当变量用）归到**最具体**的一类，免得散在几栏、勾选打架
  const order = ['class', 'func', 'param', 'prop', 'var'];
  const out = {};
  for (const k of SCAN_KINDS) out[k] = [];
  for (const nm of strs) out.str.push(nm);
  for (const [nm, kinds] of found) {
    let best = 'var';
    for (const k of order) if (kinds.has(k)) { best = k; break; }
    out[best].push(nm);
  }
  for (const k of SCAN_KINDS) out[k].sort();
  return out;
}

/**
 * 把字符串字面量的源码文本解成真正的值。
 *
 * 必须解：引擎那边（stringArray / objectKeys / vm）匹配的是**解码后的值**，界面上
 * 显示解不开的原文（'a\\nb' 里那个反斜杠）会让用户勾了一个永远匹配不上的东西。
 * 认不出的转义原样保留——宁可保留原文，也不要猜错。
 */
export function decodeStrLiteral(raw) {
  if (raw.indexOf('\\') < 0) return raw;
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out += c; continue; }
    const e = raw[++i];
    switch (e) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case '0': out += '\0'; break;
      case 'x': {
        const h = raw.slice(i + 1, i + 3);
        if (/^[0-9a-fA-F]{2}$/.test(h)) { out += String.fromCharCode(parseInt(h, 16)); i += 2; }
        else out += '\\x';
        break;
      }
      case 'u': {
        if (raw[i + 1] === '{') {
          const close = raw.indexOf('}', i + 2);
          const h = close > 0 ? raw.slice(i + 2, close) : '';
          if (/^[0-9a-fA-F]{1,6}$/.test(h)) { out += String.fromCodePoint(parseInt(h, 16)); i = close; }
          else out += '\\u';
        } else {
          const h = raw.slice(i + 1, i + 5);
          if (/^[0-9a-fA-F]{4}$/.test(h)) { out += String.fromCharCode(parseInt(h, 16)); i += 4; }
          else out += '\\u';
        }
        break;
      }
      case undefined: out += '\\'; break;   // 末尾孤立的反斜杠
      default: out += e; break;             // \\ \' \" \/ 等
    }
  }
  return out;
}

export default { SCAN_KINDS, scanIdentifiers, decodeStrLiteral };