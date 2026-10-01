import t from './types.js';
import i18n from '../i18n.js';
const { t: msg } = i18n;
/**
 * 自研 JS 解析器，接口取 @babel/parser 的子集，产出与 Babel 对齐的 AST，
 * 节点字段照 src/ast/keys.js 的 VISITOR_KEYS 排列。
 * 支持 ES2018 的常用语法，语句覆盖声明、控制流、try/catch、import/export，
 * 表达式覆盖字面量、模板串、对象与数组（含计算键、shorthand、spread）、
 * 箭头函数、类、可选链、yield/await 与解构；源码首行的 hashbang 按注释跳过，
 * 原文经 File.shebang 带出。不含 JSX、装饰器、TypeScript 类型语法。
 * 词法部分按需取 token，模板串由 tokenizer 与 parser 协同处理，
 * 表达式走 Pratt 优先级解析，语句走递归下降。
 */

const BINARY_PREC = {
  '||': 2, '??': 2, '&&': 3, '|': 4, '^': 5, '&': 6,
  '==': 7, '!=': 7, '===': 7, '!==': 7,
  '<': 8, '>': 8, '<=': 8, '>=': 8, 'instanceof': 8, 'in': 8,
  '<<': 9, '>>': 9, '>>>': 9,
  '+': 10, '-': 10,
  '*': 11, '/': 11, '%': 11,
  '**': 12,
};
const ASSIGN_OPS = new Set([
  '=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '>>>=', '|=', '^=', '&=',
  '**=', '&&=', '||=', '??=',
]);
// 这些关键字不可能延续一个表达式语句，碰上就当语句结束。
// 同行出现 x const y 本身就是语法错误，所以放宽判断不会放过合法代码。
// await 与 async 也算在内：无分号写法 const w = getWriter() 换行后接 await w.write(c) 要靠它断句。
const STMT_START_KEYWORDS = new Set([
  'var', 'let', 'const', 'function', 'class', 'if', 'for', 'while', 'do',
  'switch', 'try', 'return', 'throw', 'break', 'continue', 'debugger', 'with',
  'import', 'export', 'case', 'default', 'else', 'finally', 'catch',
  'await', 'async',
]);
const UNARY_OPS = new Set(['!', '~', '+', '-', 'typeof', 'void', 'delete', 'await']);
const MULTI_PUNCT = [
  '>>>=', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '...',
  '==', '!=', '<=', '>=', '&&', '||', '??', '**', '+=', '-=', '*=', '/=', '%=',
  '|=', '^=', '&=', '++', '--', '<<', '>>', '=>', '?.',
];

function isDigit(c) { return c >= '0' && c <= '9'; }
// 标识符要认 Unicode 的 ID_Start 与 ID_Part，CJK 和全角字符都算在内。
// ASCII 用 charCode 直接比，比带 u 标志的正则快得多，只有非 ASCII 才落到正则上。
const RE_ID_START = /[A-Za-z_$\p{ID_Start}]/u;
const RE_ID_PART = /[A-Za-z0-9_$\p{ID_Continue}]/u;
function isIdentStart(c) {
  const x = c.charCodeAt(0);
  if (x < 128) return (x >= 97 && x <= 122) || (x >= 65 && x <= 90) || x === 36 || x === 95;
  return RE_ID_START.test(c);
}
function isIdentPart(c) {
  const x = c.charCodeAt(0);
  if (x < 128) return (x >= 97 && x <= 122) || (x >= 65 && x <= 90) || (x >= 48 && x <= 57) || x === 36 || x === 95;
  return RE_ID_PART.test(c);
}

/**
 * 按需取词的 tokenizer，内部维护 token 缓冲和模板串状态栈。
 * 模板 a${expr}b 会拆成 tpl('a', tail:false)、中间的表达式 token、tplClose 与 tpl('b', tail:true)，
 * 其中 tplClose 对应结束插值的那个右花括号。
 */
class Lexer {
  constructor(code) {
    this.code = code;
    this.pos = 0;
    this.len = code.length;
    this.buf = [];
    this.prev = null;      // 上一个 token，用来判断 / 是除号还是正则开头
    this.tplStack = [];    // 每层记录 { bracket }，跟踪模板插值里的括号深度
    this._hadNl = false;   // _skipWs 有没有跨过换行，ASI 判断用，_fill 入口重置
    // 记录全部注释及其起止下标。vm comment 模式靠注释区间与节点源码区间是否重叠
    // 来判断函数或语句有没有被标注，产物本身不含注释，只在构建期读取。
    this.comments = [];    // { start, end, text }
    this.shebang = '';     // 源码首行的 hashbang，不含行终止符，没有就是空串
    this._skipShebang();
  }

  /**
   * 处理首行 hashbang，Node 与 ECMAScript Annex B 都认这个扩展。
   * 只有源码第 0 字节就是 #! 才算数，整行当行注释跳过，
   * 原文存进 this.shebang，由 obfuscate 写回产物头部，npm bin 直接执行要靠它。
   * 行终止符留给 _skipWs 消费，首个 token 的换行标记与源码一致，不影响 ASI 判断。
   */
  _skipShebang() {
    if (!this.code.startsWith('#!')) return;
    const nl = this.code.indexOf('\n');
    const end = nl < 0 ? this.len : nl;
    this.shebang = this.code.slice(0, end).replace(/\r$/, '');
    this.pos = end;
  }

  peek() {
    if (this.buf.length === 0) this._fill();
    return this.buf[0];
  }
  next() {
    if (this.buf.length === 0) this._fill();
    const tok = this.buf.shift();
    this.prev = tok;
    return tok;
  }

  _error(msg) {
    const line = this.code.slice(0, this.pos).split('\n').length;
    throw new SyntaxError(msg + ' (line ' + line + ')');
  }

  _skipWs() {
    while (this.pos < this.len) {
      const c = this.code[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\u00a0' || c === '\ufeff') {
        if (c === '\n' || c === '\r') this._hadNl = true;
        this.pos++; continue;
      }
      if (c === '/' && this.code[this.pos + 1] === '/') {
        const cStart = this.pos;
        while (this.pos < this.len && this.code[this.pos] !== '\n') this.pos++;
        this.comments.push({ start: cStart, end: this.pos, text: this.code.slice(cStart, this.pos) });
        continue;
      }
      if (c === '/' && this.code[this.pos + 1] === '*') {
        const cStart = this.pos;
        this.pos += 2;
        while (this.pos < this.len && !(this.code[this.pos] === '*' && this.code[this.pos + 1] === '/')) {
          if (this.code[this.pos] === '\n' || this.code[this.pos] === '\r') this._hadNl = true;
          this.pos++;
        }
        this.pos = Math.min(this.pos + 2, this.len);
        this.comments.push({ start: cStart, end: this.pos, text: this.code.slice(cStart, this.pos) });
        continue;
      }
      break;
    }
  }

  _fill() {
    for (;;) {
      this._hadNl = false;
      this._skipWs();
      const nl = this._hadNl;
      if (this.pos >= this.len) { this.buf.push({ type: 'eof', nl, idx: this.pos }); return; }
      const c = this.code[this.pos];

      // 模板插值里碰到 }，看括号深度决定它是表达式的一部分还是插值结束
      if (this.tplStack.length > 0 && c === '}') {
        const top = this.tplStack[this.tplStack.length - 1];
        if (top.bracket > 0) { top.bracket--; const ix = this.pos; this.pos++; this.buf.push({ type: 'punct', value: '}', nl, idx: ix }); return; }
        const ix2 = this.pos; this.pos++;
        this.buf.push({ type: 'tplClose', nl, idx: ix2 });
        this._readTemplateChunk();
        return;
      }

      if (c === '`') {
        this.pos++;
        this.tplStack.push({ bracket: 0 });
        this._readTemplateChunk();
        return;
      }

      if (isDigit(c) || (c === '.' && isDigit(this.code[this.pos + 1]))) { this._readNumber(); return; }
      if (c === '"' || c === "'") { this._readString(); return; }
      // 标识符与关键字，也要认 \u 转义开头，生成器 _escapeIdent 的产物得能读回来
      if (isIdentStart(c) ||
          (c === '\\' && this.code[this.pos + 1] === 'u' &&
           (this.code[this.pos + 2] === '{' || /[0-9a-fA-F]/.test(this.code[this.pos + 2] || '')))) {
        this._readIdent();
        return;
      }
      // 正则只在前面是操作符、左括号或关键字时才成立，判据就是上一个 token
      if (c === '/' && this._isRegexStart()) { this._readRegexp(); return; }

      const rest = this.code.slice(this.pos);
      let matched = null;
      for (const p of MULTI_PUNCT) {
        if (rest.startsWith(p)) { matched = p; break; }
      }
      if (matched) {
        this.pos += matched.length;
        if (this.tplStack.length > 0) {
          if (matched === '(' || matched === '[' || matched === '{') this.tplStack[this.tplStack.length - 1].bracket++;
          else if (matched === ')' || matched === ']') {
            const top = this.tplStack[this.tplStack.length - 1];
            if (top.bracket > 0) top.bracket--;
          }
        }
        this.buf.push({ type: 'punct', value: matched, nl, idx: this.pos - matched.length });
        return;
      }
      const cix = this.pos; this.pos++;
      if (this.tplStack.length > 0 && (c === '(' || c === '[' || c === '{')) this.tplStack[this.tplStack.length - 1].bracket++;
      else if (this.tplStack.length > 0 && (c === ')' || c === ']')) {
        const top = this.tplStack[this.tplStack.length - 1];
        if (top.bracket > 0) top.bracket--;
      }
      this.buf.push({ type: 'punct', value: c, nl, idx: cix });
      return;
    }
  }

  _isRegexStart() {
    if (!this.prev) return true;
    const t0 = this.prev;
    if (t0.type === 'num' || t0.type === 'str' || t0.type === 'regexp' || t0.type === 'tpl') return false;
    if (t0.type === 'name') return t0.value === 'return' || t0.value === 'typeof' || t0.value === 'case' || t0.value === 'delete' || t0.value === 'void' || t0.value === 'new' || t0.value === 'in' || t0.value === 'of' || t0.value === 'instanceof' || t0.value === 'do' || t0.value === 'else' || t0.value === 'yield' || t0.value === 'await';
    if (t0.type === 'punct') {
      const v = t0.value;
      if (v === ')' || v === ']' || v === '}' || v === '++' || v === '--') return false;
      return true;
    }
    return false;
  }

  _readTemplateChunk() {
    const tStart = this.pos;
    let raw = '';
    let cooked = '';
    for (;;) {
      if (this.pos >= this.len) this._error(msg('parseUnterminatedTemplate'));
      const ch = this.code[this.pos];
      if (ch === '`') {
        this.pos++;
        this.tplStack.pop();
        this.buf.push({ type: 'tpl', raw, cooked, tail: true, idx: tStart });
        return;
      }
      if (ch === '\\') {
        raw += this.code.slice(this.pos, this.pos + 2);
        cooked += this._tplEscape(this.code[this.pos + 1]);
        this.pos += 2;
        continue;
      }
      if (ch === '$' && this.code[this.pos + 1] === '{') {
        this.pos += 2;
        this.buf.push({ type: 'tpl', raw, cooked, tail: false, idx: tStart });
        return;
      }
      // 规范要求 cooked 里的 \r\n 和 \r 都归一成 \n，raw 原样保留源文本，
      // tagged template 拿到的 raw 不受影响
      if (ch === '\r') {
        raw += ch;
        this.pos++;
        if (this.code[this.pos] === '\n') {
          raw += '\n';
          this.pos++;
        }
        cooked += '\n';
        continue;
      }
      raw += ch;
      cooked += ch;
      this.pos++;
    }
  }

  _tplEscape(c) {
    switch (c) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'v': return '\v';
      case '0': return '\0';
      case '`': return '`';
      case '\\': return '\\';
      case '$': return '$';
      // 反斜杠接行终结符是续行，cooked 里不产生字符
      case '\n': return '';
      case '\r':
        if (this.code[this.pos + 2] === '\n') this.pos++;
        return '';
      case 'x': {
        const hex = this.code.substr(this.pos + 2, 2);
        this.pos += 2;
        return String.fromCharCode(parseInt(hex, 16));
      }
      // 进这个函数时 this.pos 指向反斜杠，调用方之后统一加 2，
      // 所以分支里只推进转义体本身的长度
      case 'u': {
        if (this.code[this.pos + 2] === '{') {
          const end = this.code.indexOf('}', this.pos + 3);
          if (end > 0) {
            const hex = this.code.slice(this.pos + 3, end);
            this.pos = end - 1;
            return String.fromCodePoint(parseInt(hex, 16));
          }
          return 'u';
        }
        const hex = this.code.substr(this.pos + 2, 4);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          this.pos += 4;
          return String.fromCharCode(parseInt(hex, 16));
        }
        return 'u';
      }
      default: return c;
    }
  }

  _readNumber() {
    const start = this.pos;
    let raw = '';
    if (this.code[this.pos] === '0' && /[xXbBoO]/.test(this.code[this.pos + 1] || '')) {
      const prefix = this.code[this.pos + 1].toLowerCase();
      this.pos += 2;
      while (this.pos < this.len && /[0-9a-fA-F_]/.test(this.code[this.pos])) this.pos++;
      raw = this.code.slice(start, this.pos).replace(/_/g, '');
      const digits = raw.slice(2);
      // 十六进制等前缀的 BigInt，value 存含前缀的完整原文但不含 n，
      // 生成器统一输出 value 加 n，0x3ffffffn 才不会被还原成十进制
      if (this.code[this.pos] === 'n' && !isIdentPart(this.code[this.pos + 1] || '')) {
        this.pos++;
        this.buf.push({ type: 'bigint', raw: raw + 'n', value: raw, nl: this._hadNl, idx: start });
        return;
      }
      const value = parseInt(digits, prefix === 'x' ? 16 : prefix === 'b' ? 2 : 8);
      this.buf.push({ type: 'num', value, raw, nl: this._hadNl, idx: start });
      return;
    }
    while (this.pos < this.len && /[0-9_]/.test(this.code[this.pos])) this.pos++;
    if (this.code[this.pos] === '.' && isDigit(this.code[this.pos + 1])) {
      this.pos++;
      while (this.pos < this.len && /[0-9_]/.test(this.code[this.pos])) this.pos++;
    }
    if (this.code[this.pos] === 'e' || this.code[this.pos] === 'E') {
      let p = this.pos + 1;
      if (this.code[p] === '+' || this.code[p] === '-') p++;
      if (isDigit(this.code[p])) {
        this.pos = p;
        while (this.pos < this.len && /[0-9_]/.test(this.code[this.pos])) this.pos++;
      }
    }
    raw = this.code.slice(start, this.pos).replace(/_/g, '');
    // 十进制 BigInt，小数和指数形式不算
    if (this.code[this.pos] === 'n' && raw !== '' && !raw.includes('.') && !/[eE]/.test(raw) && !isIdentPart(this.code[this.pos + 1] || '')) {
      this.pos++;
      this.buf.push({ type: 'bigint', raw: raw + 'n', value: raw, nl: this._hadNl, idx: start });
      return;
    }
    this.buf.push({ type: 'num', value: Number(raw), raw, nl: this._hadNl, idx: start });
  }

  _readString() {
    const start = this.pos;
    const quote = this.code[this.pos];
    this.pos++;
    // 快路径：到闭合引号之间没有反斜杠时，整段一次切片取回。
    //
    // 逐字符 value += c 对短字符串无所谓，但外壳（shell）会把整个载荷的
    // base64 当成一个普通字符串字面量（几 MB），那就是几百万次单字符拼接。
    // 实测占"递归混淆引导器"这一步耗时的 53%，也就是 shell 步骤的最大单项。
    // indexOf 在原生代码里找边界，只做一次切片。
    //
    // 判据必须与慢路径等价：慢路径只在遇到 `\` 时才特殊处理，其余字符一律原样
    // 收进 value（包括裸换行，它不做校验，这里也不做）。所以"第一个反斜杠出现在
    // 闭合引号之后"就等价于"整段无转义"。找不到闭合引号时落到慢路径，由它按
    // 原逻辑报未闭合错误。
    const close = this.code.indexOf(quote, this.pos);
    if (close !== -1) {
      const esc = this.code.indexOf('\\', this.pos);
      if (esc === -1 || esc > close) {
        const value = this.code.slice(this.pos, close);
        this.pos = close + 1;
        this.buf.push({ type: 'str', value, nl: this._hadNl, idx: start });
        return;
      }
    }
    let value = '';
    for (;;) {
      if (this.pos >= this.len) this._error(msg('parseUnterminatedString'));
      const c = this.code[this.pos];
      if (c === quote) { this.pos++; break; }
      if (c === '\\') {
        const esc = this.code[this.pos + 1];
        this.pos += 2;
        value += this._strEscape(esc);
        continue;
      }
      value += c;
      this.pos++;
    }
    this.buf.push({ type: 'str', value, nl: this._hadNl, idx: start });
  }

  _strEscape(c) {
    switch (c) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'v': return '\v';
      case '0': return '\0';
      case 'x': {
        const hex = this.code.substr(this.pos, 2);
        this.pos += 2;
        return String.fromCharCode(parseInt(hex, 16));
      }
      case 'u': {
        if (this.code[this.pos] === '{') {
          const end = this.code.indexOf('}', this.pos);
          const hex = this.code.slice(this.pos + 1, end);
          this.pos = end + 1;
          return String.fromCodePoint(parseInt(hex, 16));
        }
        const hex = this.code.substr(this.pos, 4);
        this.pos += 4;
        return String.fromCharCode(parseInt(hex, 16));
      }
      default: return c;
    }
  }

  _readIdent() {
    const start = this.pos;
    let value = '';
    for (;;) {
      if (this.pos >= this.len) break;
      const c = this.code[this.pos];
      if (isIdentPart(c)) {
        value += c;
        this.pos++;
        continue;
      }
      // 标识符里的 \uXXXX 与 \u{X...}，生成器 _escapeIdent 写出的形式要能读回来
      if (c === '\\' && this.code[this.pos + 1] === 'u') {
        const save = this.pos;
        this.pos += 2;
        let cp = -1;
        if (this.code[this.pos] === '{') {
          const end = this.code.indexOf('}', this.pos);
          if (end > this.pos) {
            const hex = this.code.slice(this.pos + 1, end);
            if (/^[0-9a-fA-F]+$/.test(hex)) {
              cp = parseInt(hex, 16);
              this.pos = end + 1;
            }
          }
        } else {
          const hex = this.code.substr(this.pos, 4);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            cp = parseInt(hex, 16);
            this.pos += 4;
          }
        }
        if (cp < 0) { this.pos = save; break; }
        const ch = String.fromCodePoint(cp);
        // 解出来的字符得是合法标识符字符，首字符还必须是 ID_Start
        const valid = value === '' ? isIdentStart(ch) : isIdentPart(ch);
        if (!valid) { this.pos = save; break; }
        value += ch;
        continue;
      }
      break;
    }
    this.buf.push({ type: 'name', value, nl: this._hadNl, idx: start });
  }

  _readRegexp() {
    const start = this.pos;
    this.pos++;
    let pattern = '';
    let inClass = false;
    for (;;) {
      if (this.pos >= this.len) this._error(msg('parseUnterminatedRegex'));
      const c = this.code[this.pos];
      if (c === '\\') {
        pattern += this.code.slice(this.pos, this.pos + 2);
        this.pos += 2;
        continue;
      }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { this.pos++; break; }
      else if (c === '\n') this._error(msg('parseMultilineRegex'));
      pattern += c;
      this.pos++;
    }
    let flags = '';
    while (this.pos < this.len && /[a-z]/i.test(this.code[this.pos])) {
      flags += this.code[this.pos];
      this.pos++;
    }
    this.buf.push({ type: 'regexp', pattern, flags, nl: this._hadNl, idx: start });
  }
}

class Parser {
  constructor(code, options) {
    this.lexer = new Lexer(code);
    this.options = options || {};
    this.allowIn = true; // 解析 for 的初始化部分时会临时关掉 in 二元运算符
    this.sourceType = this.options.sourceType || 'unambiguous';
    this.isModule = this.sourceType === 'module';
  }

  peek() { return this.lexer.peek(); }
  next() { return this.lexer.next(); }
  isPunct(v) { const t0 = this.peek(); return t0.type === 'punct' && t0.value === v; }
  isName(v) { const t0 = this.peek(); return t0.type === 'name' && t0.value === v; }
  eatPunct(v) { if (this.isPunct(v)) { this.next(); return true; } return false; }
  eatName(v) { if (this.isName(v)) { this.next(); return true; } return false; }
  expectPunct(v) {
    if (!this.eatPunct(v)) {
      const t0 = this.peek();
      this._err(msg('parseExpectedValue', { v, got: t0.type === 'eof' ? 'EOF' : JSON.stringify(t0.value || t0.type) }), t0);
    }
  }
  expectName(v) {
    if (!this.eatName(v)) {
      const t0 = this.peek();
      this._err(msg('parseExpectedValue', { v, got: t0.type === 'eof' ? 'EOF' : JSON.stringify(t0.value || t0.type) }), t0);
    }
  }

  /**
   * 抛带源码位置的语法错误，行列都从 1 起算，由 token 起始下标折算。
   * CLI 只打印 e.message，没有位置的话"意外的 token"根本定位不到源码。
   * @param {string} msg 错误描述
   * @param {{idx?: number}} [tok] 出错的 token，缺省用 tokenizer 当前下标
   * @returns {never} 始终抛出 SyntaxError
   */
  _err(msg, tok) {
    const idx = tok && typeof tok.idx === 'number' ? tok.idx : this.lexer.pos;
    const before = this.lexer.code.slice(0, idx);
    const line = before.split('\n').length;
    const col = idx - (before.lastIndexOf('\n') + 1) + 1;
    throw new SyntaxError(msg + ' (line ' + line + ', col ' + col + ')');
  }

  /**
   * 先存下 tokenizer 状态再执行 fn，结束后把 buf、pos、tplStack、prev 全部还原。
   * 所有向前探测都走这条路径，否则试探过程中取出的 token 会丢，模板串状态栈也会被打乱。
   * @param {Function} fn 探测逻辑，返回值即探测结果
   * @returns {*} fn 的返回值，抛异常时返回 null
   */
  _lookahead(fn) {
    const save = this.lexer.buf.slice();
    const pos = this.lexer.pos;
    const tplStack = this.lexer.tplStack.map((s) => ({ ...s }));
    const prev = this.lexer.prev;
    let result;
    try {
      result = fn();
    } catch (e) {
      result = null;
    }
    this.lexer.buf = save;
    this.lexer.pos = pos;
    this.lexer.tplStack = tplStack;
    this.lexer.prev = prev;
    return result;
  }

  _lookaheadIs(v) { return this._lookahead(() => { this.next(); return this.isPunct(v); }); }
  _lookaheadIsName(v) { return this._lookahead(() => { this.next(); return this.isName(v); }); }

  // 探测后面是否依次跟着标识符和左括号，get/set/async 方法靠它区分
  _nameThenParen() {
    return this._lookahead(() => {
      this.next();
      if (this.peek().type !== 'name') return false;
      this.next();
      return this.isPunct('(');
    });
  }

  parseProgram() {
    const body = [];
    const directives = [];
    for (;;) {
      const t0 = this.peek();
      if (t0.type === 'eof') break;
      if (t0.type === 'str') {
        const dir = this.parseDirective();
        if (dir) { directives.push(dir); continue; }
      }
      const stmt = this.parseStatement();
      if (stmt) body.push(stmt);
    }
    if (this.sourceType === 'unambiguous') {
      this.sourceType = this.isModule ? 'module' : 'script';
    }
    return t.program(body, directives, this.sourceType);
  }

  parseDirective() {
    const t0 = this.peek();
    if (t0.type !== 'str') return null;
    const save = this.lexer.buf.slice();
    const pos = this.lexer.pos;
    const tplStack = this.lexer.tplStack.map((s) => ({ ...s }));
    const prev = this.lexer.prev;
    const tok = this.next();
    const value = tok.value;
    const nx = this.peek();
    const isDirective =
      (nx.type === 'punct' && (nx.value === ';' || nx.value === '}')) || nx.type === 'eof';
    this.lexer.buf = save;
    this.lexer.pos = pos;
    this.lexer.tplStack = tplStack;
    this.lexer.prev = prev;
    if (!isDirective) return null;
    this.next();
    if (this.isPunct(';')) this.next();
    const d = { type: 'Directive', value: { type: 'DirectiveLiteral', value } };
    return d;
  }

  parseStatement() {
    const t0 = this.peek();
    if (t0.type === 'eof') return null;
    const node = this._parseStatementInner();
    // 记下语句在源码里的起始下标，vm comment 模式要拿它和注释区间做重叠判断。
    // 这是个轻量附加字段，generator 与 traverse 会跳过不认识的键，types.js 也不复制它。
    if (node && typeof node === 'object') node.srcIdx = t0.idx !== undefined ? t0.idx : 0;
    return node;
  }

  _parseStatementInner() {
    const t0 = this.peek();
    if (t0.type === 'eof') return null;
    if (t0.type === 'punct') {
      if (t0.value === '{') return this.parseBlockStatement();
      if (t0.value === ';') { this.next(); return t.emptyStatement(); }
    }
    if (t0.type === 'name') {
      const kw = t0.value;
      switch (kw) {
        case 'var': case 'let': case 'const': return this.parseVariableDeclaration();
        case 'function': return this.parseFunctionDeclaration(false);
        case 'class': return this.parseClassDeclaration();
        case 'if': return this.parseIfStatement();
        case 'for': return this.parseForStatement();
        case 'while': return this.parseWhileStatement();
        case 'do': return this.parseDoWhileStatement();
        case 'switch': return this.parseSwitchStatement();
        case 'try': return this.parseTryStatement();
        case 'return': return this.parseReturnStatement();
        case 'break': return this.parseBreakContinue('break');
        case 'continue': return this.parseBreakContinue('continue');
        case 'throw': return this.parseThrowStatement();
        case 'debugger': this.next(); this._consumeSemi(); return t.debuggerStatement();
        case 'with': return this.parseWithStatement();
        case 'import': {
          if (this._isImportDeclaration()) return this.parseImportDeclaration();
          break; // 落到这一支说明是动态 import() 表达式
        }
        case 'export': return this.parseExportDeclaration();
      }
    }
    // 剩下的走表达式语句，标签和 async function 声明也在里面分流
    return this.parseExpressionOrLabeledStatement();
  }

  _isImportDeclaration() {
    // import 后面跟左括号是动态导入，别的一律当声明
    return this._lookahead(() => {
      this.next();
      return !this.isPunct('(');
    });
  }

  parseExpressionOrLabeledStatement() {
    // 标识符后面直接跟冒号就是标签
    if (this.peek().type === 'name') {
      const isLabel = this._lookahead(() => {
        this.next();
        return this.isPunct(':');
      });
      if (isLabel) {
        const id = this.parseIdentifier();
        this.expectPunct(':');
        const body = this.parseStatement();
        return t.labeledStatement(id, body);
      }
    }
    if (this.isName('async')) {
      const isAsyncFn = this._lookaheadIsName('function');
      if (isAsyncFn) return this.parseFunctionDeclaration(true);
    }
    const expr = this.parseExpression();
    this._consumeSemi();
    return t.expressionStatement(expr);
  }

  parseBlockStatement() {
    this.expectPunct('{');
    const body = [];
    const directives = [];
    for (;;) {
      if (this.isPunct('}')) break;
      if (this.peek().type === 'eof') throw new SyntaxError(msg('parseUnclosedBlock'));
      if (this.peek().type === 'str') {
        const d = this.parseDirective();
        if (d) { directives.push(d); continue; }
      }
      const stmt = this.parseStatement();
      if (stmt) body.push(stmt);
    }
    this.expectPunct('}');
    return t.blockStatement(body, directives);
  }

  parseVariableDeclaration() {
    const kw = this.next().value; // 取到的就是 var/let/const
    const declarations = [];
    for (;;) {
      const id = this.parsePattern();
      let init = null;
      if (this.eatPunct('=')) init = this.parseAssignment();
      declarations.push(t.variableDeclarator(id, init));
      if (!this.eatPunct(',')) break;
    }
    this._consumeSemi();
    return t.variableDeclaration(kw, declarations);
  }

  parsePattern() {
    const t0 = this.peek();
    if (t0.type === 'punct' && t0.value === '{') return this.parseObjectPattern();
    if (t0.type === 'punct' && t0.value === '[') return this.parseArrayPattern();
    if (t0.type === 'punct' && t0.value === '...') {
      this.next();
      return t.restElement(this.parsePattern());
    }
    if (t0.type !== 'name') this._err(msg('parseExpectedIdentPattern'), t0);
    return this.parseIdentifier();
  }

  parseObjectPattern() {
    this.expectPunct('{');
    const properties = [];
    for (;;) {
      if (this.isPunct('}')) break;
      if (this.isPunct('...')) {
        this.next();
        properties.push(t.restElement(this.parsePattern()));
      } else {
        const { key, computed } = this.parsePropertyKey();
        if (this.eatPunct(':')) {
          // 形如 { key: pattern }，等号后面还可以接默认值
          let value = this.parsePattern();
          if (this.eatPunct('=')) value = t.assignmentPattern(value, this.parseAssignment());
          properties.push(t.objectProperty(key, value, computed, false));
        } else if (this.eatPunct('=')) {
          // 带默认值的简写，如 { sep = "," }。默认值解析用 parseAssignment，
          // 逗号留给属性分隔符，不会被吃进默认值
          const value = t.assignmentPattern(key, this.parseAssignment());
          properties.push(t.objectProperty(key, value, false, true));
        } else {
          properties.push(t.objectProperty(key, key, false, true));
        }
      }
      if (!this.eatPunct(',')) break;
    }
    this.expectPunct('}');
    return t.objectPattern(properties);
  }

  parseArrayPattern() {
    this.expectPunct('[');
    const elements = [];
    for (;;) {
      if (this.isPunct(']')) break;
      if (this.isPunct(',')) { this.next(); elements.push(null); continue; }
      if (this.isPunct('...')) {
        this.next();
        elements.push(t.restElement(this.parsePattern()));
      } else {
        // 元素后面可以跟默认值，同样把逗号留给元素分隔符
        let el = this.parsePattern();
        if (this.eatPunct('=')) el = t.assignmentPattern(el, this.parseAssignment());
        elements.push(el);
      }
      if (!this.eatPunct(',')) break;
    }
    this.expectPunct(']');
    return t.arrayPattern(elements);
  }

  parseFunctionDeclaration(asyncFlag) {
    if (asyncFlag) this.expectName('async'); // 探测阶段只看不消费，async 关键字由本函数吃掉
    this.expectName('function');
    let isAsync = asyncFlag;
    let isGenerator = false;
    if (this.isPunct('*')) { this.next(); isGenerator = true; }
    let id = null;
    if (this.peek().type === 'name') id = this.parseIdentifier();
    const params = this.parseParams();
    const body = this.parseBlockStatement();
    return t.functionDeclaration(id, params, body, isGenerator, isAsync);
  }

  parseParams() {
    this.expectPunct('(');
    const params = [];
    for (;;) {
      if (this.isPunct(')')) break;
      if (this.isPunct('...')) {
        this.next();
        params.push(t.restElement(this.parsePattern()));
      } else {
        const p = this.parsePattern();
        if (this.eatPunct('=')) {
          const right = this.parseAssignment();
          params.push(t.assignmentPattern(p, right));
        } else {
          params.push(p);
        }
      }
      if (!this.eatPunct(',')) break;
    }
    this.expectPunct(')');
    return params;
  }

  parseIfStatement() {
    this.expectName('if');
    this.expectPunct('(');
    const test = this.parseExpression();
    this.expectPunct(')');
    const consequent = this.parseStatement();
    let alternate = null;
    if (this.eatName('else')) alternate = this.parseStatement();
    return t.ifStatement(test, consequent, alternate);
  }

  parseForStatement() {
    this.expectName('for');
    let isAwait = false;
    if (this.isName('await')) { this.next(); isAwait = true; }
    this.expectPunct('(');
    let init = null;
    if (!this.isPunct(';')) {
      if (this.isName('var') || this.isName('let') || this.isName('const')) {
        const kw = this.next().value;
        const id = this.parsePattern();
        if (this.isName('in') || this.isName('of')) {
          const kind = this.next().value;
          const right = this.parseExpression();
          this.expectPunct(')');
          const body = this.parseStatement();
          const decl = t.variableDeclaration(kw, [t.variableDeclarator(id, null)]);
          return kind === 'in' ? t.forInStatement(decl, right, body) : t.forOfStatement(decl, right, body, isAwait);
        }
        const declarators = [t.variableDeclarator(id, null)];
        if (this.eatPunct('=')) declarators[0].init = this.parseAssignment();
        while (this.eatPunct(',')) {
          const id2 = this.parsePattern();
          let init2 = null;
          if (this.eatPunct('=')) init2 = this.parseAssignment();
          declarators.push(t.variableDeclarator(id2, init2));
        }
        init = t.variableDeclaration(kw, declarators);
      } else {
        // 左值是表达式，可能属于 for-in/of，也可能只是普通 for 的初始化。
        // 先关掉 in 的二元运算符语义，避免 for (a in b) 里的 in 被当成比较
        const savedIn = this.allowIn;
        this.allowIn = false;
        const left = this.parseExpression();
        this.allowIn = savedIn;
        if (this.isName('in') || this.isName('of')) {
          const kind = this.next().value;
          const right = this.parseExpression();
          this.expectPunct(')');
          const body = this.parseStatement();
          const target = this._toAssignable(left);
          return kind === 'in' ? t.forInStatement(target, right, body) : t.forOfStatement(target, right, body, isAwait);
        }
        init = left;
      }
    }
    this.expectPunct(';');
    let test = null;
    if (!this.isPunct(';')) test = this.parseExpression();
    this.expectPunct(';');
    let update = null;
    if (!this.isPunct(')')) update = this.parseExpression();
    this.expectPunct(')');
    const body = this.parseStatement();
    return t.forStatement(init, test, update, body);
  }

  parseWhileStatement() {
    this.expectName('while');
    this.expectPunct('(');
    const test = this.parseExpression();
    this.expectPunct(')');
    const body = this.parseStatement();
    return t.whileStatement(test, body);
  }

  parseDoWhileStatement() {
    this.expectName('do');
    const body = this.parseStatement();
    this.expectName('while');
    this.expectPunct('(');
    const test = this.parseExpression();
    this.expectPunct(')');
    this._consumeSemi();
    return t.doWhileStatement(body, test);
  }

  parseSwitchStatement() {
    this.expectName('switch');
    this.expectPunct('(');
    const discriminant = this.parseExpression();
    this.expectPunct(')');
    this.expectPunct('{');
    const cases = [];
    for (;;) {
      if (this.isPunct('}')) break;
      if (this.peek().type === 'eof') throw new SyntaxError(msg('parseUnclosedSwitch'));
      let test = null;
      if (this.eatName('case')) test = this.parseExpression();
      else this.expectName('default');
      this.expectPunct(':');
      const consequent = [];
      while (!this.isPunct('}') && !this.isName('case') && !this.isName('default')) {
        const stmt = this.parseStatement();
        if (stmt) consequent.push(stmt);
      }
      cases.push(t.switchCase(test, consequent));
    }
    this.expectPunct('}');
    return t.switchStatement(discriminant, cases);
  }

  parseTryStatement() {
    this.expectName('try');
    const block = this.parseBlockStatement();
    let handler = null;
    let finalizer = null;
    if (this.eatName('catch')) {
      let param = null;
      if (this.eatPunct('(')) {
        param = this.parsePattern();
        this.expectPunct(')');
      }
      const body = this.parseBlockStatement();
      handler = t.catchClause(param, body);
    }
    if (this.eatName('finally')) {
      finalizer = this.parseBlockStatement();
    }
    if (!handler && !finalizer) throw new SyntaxError(msg('parseTryNeedsCatch'));
    return t.tryStatement(block, handler, finalizer);
  }

  parseReturnStatement() {
    this.expectName('return');
    let argument = null;
    // return 后换行就不带返回值，后面的 token 长得像表达式开头也不算
    if (!this._isSemiOrBrace() && !this.peek().nl) argument = this.parseExpression();
    this._consumeSemi();
    return t.returnStatement(argument);
  }

  parseBreakContinue(kind) {
    this.expectName(kind);
    let label = null;
    // break 与 continue 后换行就带不了标签
    if (this.peek().type === 'name' && !this._isSemiOrBrace() && !this.peek().nl) {
      label = this.parseIdentifier();
    }
    this._consumeSemi();
    return kind === 'break' ? t.breakStatement(label) : t.continueStatement(label);
  }

  parseThrowStatement() {
    this.expectName('throw');
    // throw 的表达式必须和 throw 同行，换行直接算语法错误
    if (this.peek().nl) throw new SyntaxError(msg('parseThrowNoNewline'));
    const argument = this.parseExpression();
    this._consumeSemi();
    return t.throwStatement(argument);
  }

  parseWithStatement() {
    this.expectName('with');
    this.expectPunct('(');
    const object = this.parseExpression();
    this.expectPunct(')');
    const body = this.parseStatement();
    return t.withStatement(object, body);
  }

  _isSemiOrBrace() {
    const t0 = this.peek();
    return t0.type === 'punct' && (t0.value === ';' || t0.value === '}' || t0.value === ')');
  }

  _consumeSemi() {
    if (this.eatPunct(';')) return;
    const t0 = this.peek();
    if (t0.type === 'eof' || (t0.type === 'punct' && (t0.value === '}' || t0.value === ')'))) return;
    // 规范里的规则 1：token 前有换行就自动插入分号，换行本身就是边界信号
    if (t0.nl) return;
    // 规则 2 的保守兜底：下一个 token 是语句起始关键字就当本条结束。
    // 同行出现 x const y 本来就是语法错误，放宽不会误伤合法代码
    if (t0.type === 'name' && STMT_START_KEYWORDS.has(t0.value)) return;
    this._err(msg('parseExpectedSemicolon', { got: JSON.stringify(t0.value || t0.type) }), t0);
  }

  parseClassDeclaration() {
    this.expectName('class');
    let id = null;
    if (this.peek().type === 'name') id = this.parseIdentifier();
    let superClass = null;
    if (this.eatName('extends')) superClass = this.parseLeftHandSide();
    const body = this.parseClassBody();
    return t.classDeclaration(id, superClass, body);
  }

  parseClassBody() {
    this.expectPunct('{');
    const members = [];
    for (;;) {
      if (this.isPunct('}')) break;
      if (this.peek().type === 'eof') throw new SyntaxError(msg('parseUnclosedClass'));
      let isStatic = false;
      let isAsync = false;
      let isGenerator = false;
      let isGet = false;
      let isSet = false;
      // static { ... } 是静态块，不是名为 static 的成员。
      // 必须排在下面那段 static 修饰符判断之前，否则 static 会被当成属性名，
      // 紧跟着的左花括号会被读成属性初始化式的开头。
      if (this.isName('static') && this._lookahead(() => { this.next(); return this.isPunct('{'); })) {
        this.next();
        const block = this.parseBlockStatement();
        members.push(t.staticBlock(block.body, block.directives));
        continue;
      }
      // 判断 static 是修饰符还是成员名：后面跟名字、星号、方括号或字符串才算修饰符，
      // 跟左括号、等号、分号、花括号时它本身就是成员名
      if (this.isName('static') && this._lookahead(() => {
        this.next();
        const t0 = this.peek();
        return !(t0.type === 'punct' && (t0.value === '(' || t0.value === '=' || t0.value === ';' || t0.value === '}' || t0.value === '{'));
      })) {
        this.next();
        isStatic = true;
      }
      if ((this.isName('get') || this.isName('set')) && this._nameThenParen()) {
        const gs = this.peek().value;
        this.next();
        if (gs === 'get') isGet = true;
        else isSet = true;
      }
      if (this.isName('async') && this._nameThenParen()) {
        this.next();
        isAsync = true;
      }
      if (this.isPunct('*')) { this.next(); isGenerator = true; }
      const { key, computed } = this.parsePropertyKey();
      if (this.isPunct('(')) {
        const params = this.parseParams();
        const body = this.parseBlockStatement();
        const kind = isGet ? 'get' : isSet ? 'set' : 'method';
        const m = t.classMethod(kind, key, params, body, computed, isStatic);
        if (isAsync) m.async = true;
        if (isGenerator) m.generator = true;
        members.push(m);
      } else {
        let value = null;
        if (this.eatPunct('=')) value = this.parseExpression();
        // isStatic 必须传下去，丢掉静态标记会让静态字段变成实例字段，
        // 类名上的属性取不到，实例上反而多出一个
        members.push(t.classProperty(key, value, isStatic));
        this._consumeSemi();
      }
    }
    this.expectPunct('}');
    return t.classBody(members);
  }

  parsePropertyKey() {
    const t0 = this.peek();
    if (t0.type === 'name') return { key: this.parseIdentifier(), computed: false };
    if (t0.type === 'str') { this.next(); return { key: t.stringLiteral(t0.value), computed: false }; }
    if (t0.type === 'num') {
      this.next();
      const n = t.numericLiteral(t0.value);
      if (t0.raw) n.extra = { raw: t0.raw };
      return { key: n, computed: false };
    }
    if (t0.type === 'punct' && t0.value === '[') {
      this.next();
      const expr = this.parseExpression();
      this.expectPunct(']');
      return { key: expr, computed: true };
    }
    if (t0.type === 'punct' && t0.value === '#') {
      this.next();
      const id = this.parseIdentifier();
      return { key: t.privateName(id), computed: false };
    }
    this._err(msg('parseInvalidPropKey'), t0);
  }

  /**
   * 点号后面的属性名，普通标识符或私有名（this.#x）。
   * 私有名必须建成 PrivateName，当成普通标识符会被后续的改名与自检当成变量名，
   * 重命名后与类里的声明对不上号。
   */
  parseMemberProperty() {
    if (this.isPunct('#')) {
      this.next();
      return t.privateName(this.parseIdentifier());
    }
    return this.parseIdentifier();
  }

  parseIdentifier() {
    const t0 = this.next();
    if (t0.type !== 'name') this._err(msg('parseExpectedIdent'), t0);
    return t.identifier(t0.value);
  }

  parseImportDeclaration() {
    this.next();
    this.isModule = true;
    const specifiers = [];
    let source = null;
    if (this.peek().type === 'str') {
      source = this.parseStringLiteral();
    } else if (this.isPunct('{')) {
      this.next();
      for (;;) {
        if (this.isPunct('}')) break;
        const imported = this.parseIdentifier();
        let local = imported;
        if (this.eatName('as')) local = this.parseIdentifier();
        specifiers.push(t.importSpecifier(imported, local));
        if (!this.eatPunct(',')) break;
      }
      this.expectPunct('}');
      this.expectName('from');
      source = this.parseStringLiteral();
    } else if (this.isPunct('*')) {
      this.next();
      this.expectName('as');
      const local = this.parseIdentifier();
      specifiers.push(t.importNamespaceSpecifier(local));
      this.expectName('from');
      source = this.parseStringLiteral();
    } else if (this.peek().type === 'name') {
      const local = this.parseIdentifier();
      specifiers.push(t.importDefaultSpecifier(local));
      if (this.eatPunct(',')) {
        if (this.isPunct('*')) {
          this.next();
          this.expectName('as');
          specifiers.push(t.importNamespaceSpecifier(this.parseIdentifier()));
        } else if (this.isPunct('{')) {
          this.next();
          for (;;) {
            if (this.isPunct('}')) break;
            const imported = this.parseIdentifier();
            let local2 = imported;
            if (this.eatName('as')) local2 = this.parseIdentifier();
            specifiers.push(t.importSpecifier(imported, local2));
            if (!this.eatPunct(',')) break;
          }
          this.expectPunct('}');
        }
      }
      this.expectName('from');
      source = this.parseStringLiteral();
    }
    this._consumeSemi();
    return t.importDeclaration(specifiers, source);
  }

  parseExportDeclaration() {
    this.next();
    this.isModule = true;
    if (this.eatName('default')) {
      let declaration = null;
      if (this.isName('function')) declaration = this.parseFunctionDeclaration(false);
      else if (this.isName('async') && this._lookaheadIsName('function')) declaration = this.parseFunctionDeclaration(true);
      else if (this.isName('class')) declaration = this.parseClassDeclaration();
      else declaration = this.parseExpression();
      this._consumeSemi();
      return t.exportDefaultDeclaration(declaration);
    }
    if (this.eatPunct('*')) {
      this.expectName('from');
      const source = this.parseStringLiteral();
      this._consumeSemi();
      return t.exportAllDeclaration(source);
    }
    if (this.isPunct('{')) {
      this.next();
      const specifiers = [];
      for (;;) {
        if (this.isPunct('}')) break;
        const local = this.parseIdentifier();
        let exported = local;
        if (this.eatName('as')) exported = this.parseIdentifier();
        specifiers.push(t.exportSpecifier(local, exported));
        if (!this.eatPunct(',')) break;
      }
      this.expectPunct('}');
      let source = null;
      if (this.eatName('from')) source = this.parseStringLiteral();
      this._consumeSemi();
      return t.exportNamedDeclaration(null, specifiers, source);
    }
    let declaration = null;
    if (this.isName('var') || this.isName('let') || this.isName('const')) declaration = this.parseVariableDeclaration();
    else if (this.isName('function')) declaration = this.parseFunctionDeclaration(false);
    else if (this.isName('async')) declaration = this.parseFunctionDeclaration(true);
    else if (this.isName('class')) declaration = this.parseClassDeclaration();
    else this._err(msg('parseInvalidExport'), this.peek());
    return t.exportNamedDeclaration(declaration, [], null);
  }

  parseStringLiteral() {
    const t0 = this.next();
    if (t0.type !== 'str') this._err(msg('parseExpectedString'), t0);
    return t.stringLiteral(t0.value);
  }

  parseExpression() {
    let expr = this.parseAssignment();
    if (this.isPunct(',')) {
      const expressions = [expr];
      while (this.eatPunct(',')) expressions.push(this.parseAssignment());
      return t.sequenceExpression(expressions);
    }
    return expr;
  }

  parseAssignment() {
    const t0 = this.peek();
    if (t0.type === 'name' && t0.value === 'yield') {
      this.next();
      let delegate = false;
      if (this.eatPunct('*')) delegate = true;
      let argument = null;
      if (!this._isSemiOrBrace() && !this.isPunct(',') && !this.isPunct(')') && !this.isPunct(']') && !this.isPunct('}') && !this.isPunct(':')) {
        argument = this.parseAssignment();
      }
      return t.yieldExpression(argument, delegate);
    }
    const left = this.parseConditional();
    const t1 = this.peek();
    if (t1.type === 'punct' && ASSIGN_OPS.has(t1.value)) {
      this.next();
      const right = this.parseAssignment();
      const target = this._toAssignable(left);
      return t.assignmentExpression(t1.value, target, right);
    }
    return left;
  }

  _toAssignable(node) {
    if (!node) return node;
    switch (node.type) {
      case 'Identifier': return node;
      case 'MemberExpression': case 'OptionalMemberExpression': return node;
      case 'ParenthesizedExpression': node.expression = this._toAssignable(node.expression); return node;
      case 'ArrayExpression':
        return t.arrayPattern(node.elements.map((e) => {
          if (e === null) return null;
          if (e.type === 'SpreadElement') return t.restElement(this._toAssignable(e.argument));
          return this._toAssignable(e);
        }));
      case 'ObjectExpression':
        return t.objectPattern(node.properties.map((p) => {
          if (p.type === 'SpreadElement') return t.restElement(this._toAssignable(p.argument));
          if (p.type === 'ObjectProperty') {
            const key = p.key;
            const value = this._toAssignable(p.value);
            const shorthand = p.shorthand || (key.type === 'Identifier' && value.type === 'Identifier' && key.name === value.name);
            return t.objectProperty(key, value, p.computed, shorthand);
          }
          return p;
        }));
      case 'AssignmentExpression':
        if (node.operator === '=') return t.assignmentPattern(this._toAssignable(node.left), node.right);
        return node;
      // 顶层的 SpreadElement 只在箭头函数形参位置成为绑定，如 (...xs) => {}。
      // 不转成 RestElement 的话 collectPattern 认不出这是个绑定，mangle 会漏改引用
      case 'SpreadElement':
        return t.restElement(this._toAssignable(node.argument));
      default:
        return node;
    }
  }

  parseConditional() {
    const test = this.parseBinary(0);
    if (this.isPunct('?')) {
      this.next();
      const consequent = this.parseAssignment();
      this.expectPunct(':');
      const alternate = this.parseAssignment();
      return t.conditionalExpression(test, consequent, alternate);
    }
    return test;
  }

  parseBinary(minPrec) {
    let left = this.parseUnary();
    for (;;) {
      const t0 = this.peek();
      let op = null;
      let prec = 0;
      if (t0.type === 'punct' && BINARY_PREC[t0.value] !== undefined) {
        op = t0.value;
        prec = BINARY_PREC[op];
      } else if (t0.type === 'name' && (t0.value === 'instanceof' || t0.value === 'in')) {
        if (t0.value === 'in' && !this.allowIn) break;
        op = t0.value;
        prec = BINARY_PREC[op];
      }
      if (op === null || prec < minPrec) break;
      this.next();
      // 指数运算是右结合，右操作数按同级递归
      const nextMin = op === '**' ? prec : prec + 1;
      const right = this.parseBinary(nextMin);
      if (op === '&&' || op === '||' || op === '??') {
        left = t.logicalExpression(op, left, right);
      } else {
        left = t.binaryExpression(op, left, right);
      }
    }
    return left;
  }

  parseUnary() {
    const t0 = this.peek();
    if (t0.type === 'punct' && UNARY_OPS.has(t0.value)) {
      this.next();
      return t.unaryExpression(t0.value, this.parseUnary(), true);
    }
    if (t0.type === 'name' && UNARY_OPS.has(t0.value)) {
      this.next();
      return t.unaryExpression(t0.value, this.parseUnary(), true);
    }
    if (t0.type === 'punct' && (t0.value === '++' || t0.value === '--')) {
      this.next();
      return t.updateExpression(t0.value, this.parseUnary(), true);
    }
    return this.parsePostfix();
  }

  parsePostfix() {
    const expr = this.parseLeftHandSide();
    const t0 = this.peek();
    // ++ 或 -- 前面有换行就不算后缀，a 换行后接 ++b 会读成两条语句
    if (t0.type === 'punct' && (t0.value === '++' || t0.value === '--') && !t0.nl) {
      this.next();
      return t.updateExpression(t0.value, expr, false);
    }
    return expr;
  }

  parseLeftHandSide() {
    let expr;
    if (this.isName('new')) {
      expr = this.parseNew();
    } else {
      expr = this.parsePrimary();
    }
    // 依次吃掉调用、成员访问、可选链和模板标签这些后缀
    for (;;) {
      if (this.isPunct('.')) {
        this.next();
        const prop = this.parseMemberProperty();
        expr = t.memberExpression(expr, prop, false);
      } else if (this.isPunct('?.')) {
        this.next();
        if (this.isPunct('(')) {
          const args = this.parseArguments();
          expr = t.optionalCallExpression(expr, args, true);
        } else {
          const { key, computed } = this.parsePropertyKey();
          expr = t.optionalMemberExpression(expr, key, computed, true);
        }
      } else if (this.isPunct('[')) {
        this.next();
        const prop = this.parseExpression();
        this.expectPunct(']');
        expr = t.memberExpression(expr, prop, true);
      } else if (this.isPunct('(')) {
        const args = this.parseArguments();
        expr = t.callExpression(expr, args);
      } else if (this.peek().type === 'tpl') {
        const quasi = this.parseTemplate();
        expr = t.taggedTemplateExpression(expr, quasi);
      } else {
        break;
      }
    }
    return expr;
  }

  parseNew() {
    this.next();
    // new.target 是元属性，不是 new 表达式。这里不认出来，后面会把 .target
    // 当成成员访问，报出与真实原因无关的语法错误。
    if (this.isPunct('.') && this._lookaheadIsName('target')) {
      this.next();
      return t.metaProperty(t.identifier('new'), this.parseIdentifier());
    }
    const callee = this.parseNewCallee();
    let args = [];
    if (this.isPunct('(')) args = this.parseArguments();
    return t.newExpression(callee, args);
  }

  parseNewCallee() {
    let expr = this.parsePrimary();
    for (;;) {
      if (this.isPunct('.')) {
        this.next();
        const prop = this.parseMemberProperty();
        expr = t.memberExpression(expr, prop, false);
      } else if (this.isPunct('?.')) {
        this.next();
        const { key, computed } = this.parsePropertyKey();
        expr = t.optionalMemberExpression(expr, key, computed, true);
      } else if (this.isPunct('[')) {
        this.next();
        const prop = this.parseExpression();
        this.expectPunct(']');
        expr = t.memberExpression(expr, prop, true);
      } else if (this.peek().type === 'tpl') {
        const quasi = this.parseTemplate();
        expr = t.taggedTemplateExpression(expr, quasi);
      } else {
        break;
      }
    }
    return expr;
  }

  parseArguments() {
    this.expectPunct('(');
    const args = [];
    for (;;) {
      if (this.isPunct(')')) break;
      if (this.isPunct('...')) {
        this.next();
        args.push(t.spreadElement(this.parseAssignment()));
      } else {
        args.push(this.parseAssignment());
      }
      if (!this.eatPunct(',')) break;
    }
    this.expectPunct(')');
    return args;
  }

  parsePrimary() {
    const t0 = this.peek();
    switch (t0.type) {
      case 'num': {
        this.next();
        const n = t.numericLiteral(t0.value);
        if (t0.raw) n.extra = { raw: t0.raw };
        return n;
      }
      case 'bigint': {
        this.next();
        return t.bigIntLiteral(t0.value);
      }
      case 'str': {
        this.next();
        return t.stringLiteral(t0.value);
      }
      case 'regexp': {
        this.next();
        return t.regexpLiteral(t0.pattern, t0.flags);
      }
      case 'tpl': {
        return this.parseTemplate();
      }
      case 'name': {
        const v = t0.value;
        if (v === 'this') { this.next(); return t.thisExpression(); }
        if (v === 'true') { this.next(); return t.booleanLiteral(true); }
        if (v === 'false') { this.next(); return t.booleanLiteral(false); }
        if (v === 'null') { this.next(); return t.nullLiteral(); }
        if (v === 'function') return this.parseFunctionExpression(false);
        if (v === 'class') return this.parseClassExpression();
        if (v === 'super') { this.next(); return t.super(); }
        if (v === 'import' && this._lookaheadIs('(')) { this.next(); return t.import(); }
        // import.meta 与 new.target 一样是元属性，当普通标识符读会留下未绑定引用，
        // 自检阶段会把它当成悬空引用报错
        if (v === 'import' && this._lookaheadIs('.')) {
          this.next();
          this.next();
          return t.metaProperty(t.identifier('import'), this.parseIdentifier());
        }
        if (v === 'async') {
          if (this._lookaheadIsName('function')) {
            this.next();
            return this.parseFunctionExpression(true);
          }
          if (this._lookahead(() => {
            this.next();
            if (this.isPunct('(')) {
              // 一直扫到配对的右括号再回头看是不是箭头。
              // depth 从 0 起，消费掉左括号后为 1，遇到闭括号先看是否回到 0 决定退出
              let depth = 0;
              for (;;) {
                const tok = this.next();
                if (tok.type === 'eof') return false;
                if (tok.type === 'punct') {
                  if (tok.value === '(' || tok.value === '[' || tok.value === '{') {
                    depth++;
                  } else if (tok.value === ')' || tok.value === ']' || tok.value === '}') {
                    if (depth === 0) break;
                    depth--;
                    if (depth === 0) break;
                  }
                }
              }
              return this.isPunct('=>');
            }
            if (this.peek().type === 'name') {
              this.next();
              return this.isPunct('=>');
            }
            return false;
          })) {
            this.next(); // async
            // 区分：async (…) => 与 async x =>
            if (this.isPunct('(')) return this.parseParenOrArrow(true);
            const id = this.parseIdentifier();
            this.expectPunct('=>');
            return this._finishArrow([id], true);
          }
          return this.parseIdentifier();
        }
        if (this._arrowAfterIdent()) {
          const id = this.parseIdentifier();
          this.expectPunct('=>');
          return this._finishArrow([id], false);
        }
        return this.parseIdentifier();
      }
      case 'punct': {
        const v = t0.value;
        if (v === '(') return this.parseParenOrArrow(false);
        if (v === '[') return this.parseArrayExpression();
        if (v === '{') return this.parseObjectExpression();
        // 私有名可以直接出现在 in 的左侧做品牌检查，形如 #x in obj
        if (v === '#') { this.next(); return t.privateName(this.parseIdentifier()); }
        if (v === '...') {
          this.next();
          return t.spreadElement(this.parseAssignment());
        }
        break;
      }
    }
    this._err(msg('parseUnexpectedToken', { tok: JSON.stringify(t0.value || t0.type) }), t0);
  }

  // 看当前标识符后面是不是紧跟箭头
  _arrowAfterIdent() {
    return this._lookahead(() => {
      this.next();
      return this.isPunct('=>');
    });
  }

  parseFunctionExpression(asyncFlag) {
    this.next();
    let isGenerator = false;
    if (this.isPunct('*')) { this.next(); isGenerator = true; }
    let id = null;
    if (this.peek().type === 'name') id = this.parseIdentifier();
    const params = this.parseParams();
    const body = this.parseBlockStatement();
    return t.functionExpression(id, params, body, isGenerator, !!asyncFlag);
  }

  parseClassExpression() {
    this.next();
    let id = null;
    if (this.peek().type === 'name') id = this.parseIdentifier();
    let superClass = null;
    if (this.eatName('extends')) superClass = this.parseLeftHandSide();
    const body = this.parseClassBody();
    return t.classExpression(id, superClass, body);
  }

  parseParenOrArrow(asyncFlag) {
    this.expectPunct('(');
    // 空参数箭头函数，形如 () =>
    if (this.isPunct(')')) {
      this.next();
      if (this.eatPunct('=>')) return this._finishArrow([], !!asyncFlag);
      throw new SyntaxError(msg('parseEmptyParens'));
    }
    const first = this.parseExpression();
    if (this.isPunct(')')) {
      this.next();
      if (this.eatPunct('=>')) {
        const seq = first.type === 'SequenceExpression' ? first.expressions : [first];
        const params = seq.map((e) => this._toAssignable(e));
        return this._finishArrow(params, !!asyncFlag);
      }
      return first;
    }
    // parseExpression 会把逗号全部吃掉，正常不会落到这一支，留作防御
    throw new SyntaxError(msg('parseParenFailed'));
  }

  _finishArrow(params, asyncFlag) {
    let body;
    if (this.isPunct('{')) {
      body = this.parseBlockStatement();
    } else {
      body = this.parseAssignment();
    }
    return t.arrowFunctionExpression(params, body, !!asyncFlag);
  }

  parseArrayExpression() {
    this.expectPunct('[');
    const elements = [];
    for (;;) {
      if (this.isPunct(']')) break;
      if (this.isPunct(',')) { this.next(); elements.push(null); continue; }
      if (this.isPunct('...')) {
        this.next();
        elements.push(t.spreadElement(this.parseAssignment()));
      } else {
        elements.push(this.parseAssignment());
      }
      if (!this.eatPunct(',')) break;
    }
    this.expectPunct(']');
    return t.arrayExpression(elements);
  }

  parseObjectExpression() {
    this.expectPunct('{');
    const properties = [];
    for (;;) {
      if (this.isPunct('}')) break;
      if (this.isPunct('...')) {
        this.next();
        properties.push(t.spreadElement(this.parseAssignment()));
      } else {
        properties.push(this.parseObjectProperty());
      }
      if (!this.eatPunct(',')) break;
    }
    this.expectPunct('}');
    return t.objectExpression(properties);
  }

  parseObjectProperty() {
    if ((this.isName('get') || this.isName('set')) && this._nameThenParen()) {
      const kind = this.peek().value;
      this.next();
      const key = this.parseIdentifier();
      const params = this.parseParams();
      const body = this.parseBlockStatement();
      return t.objectMethod(kind, key, params, body);
    }
    if (this.isName('async') && this._nameThenParen()) {
      this.next();
      const key = this.parseIdentifier();
      const params = this.parseParams();
      const body = this.parseBlockStatement();
      const m = t.objectMethod('method', key, params, body);
      m.async = true;
      return m;
    }
    let isGenerator = false;
    if (this.isPunct('*')) { this.next(); isGenerator = true; }
    const { key, computed } = this.parsePropertyKey();
    if (this.isPunct('(')) {
      const params = this.parseParams();
      const body = this.parseBlockStatement();
      const m = t.objectMethod('method', key, params, body, computed);
      if (isGenerator) m.generator = true;
      return m;
    }
    if (this.eatPunct(':')) {
      const value = this.parseAssignment();
      return t.objectProperty(key, value, computed, false);
    }
    if (key.type === 'Identifier') {
      return t.objectProperty(key, key, false, true);
    }
    this._err(msg('parseInvalidObjectProp'), this.peek());
  }

  parseTemplate() {
    const quasis = [];
    const expressions = [];
    for (;;) {
      const tok = this.next();
      if (tok.type !== 'tpl') this._err(msg('parseTemplateTokenError'), tok);
      quasis.push(t.templateElement(tok.cooked, tok.tail));
      if (tok.tail) break;
      expressions.push(this.parseExpression());
      const close = this.next();
      if (close.type !== 'tplClose') this._err(msg('parseTemplateExprUnclosed'), close);
    }
    return t.templateLiteral(quasis, expressions);
  }
}

/**
 * 把源码解析成 AST File，与 @babel/parser 一样以 File 为外层、program 为根。
 * @param {string} code 待解析源码
 * @param {{sourceType?: string, allowReturnOutsideFunction?: boolean, plugins?: string[]}} options 解析选项
 * @returns {{type: 'File', program: object, comments: Array<object>, shebang: string}} File 节点，comments 为全部注释，shebang 是首行 #! 原文且不含行终止符，没有则为空串
 */
function parse(code, options) {
  const parser = new Parser(code, options || {});
  const program = parser.parseProgram();
  return { type: 'File', program, comments: parser.lexer.comments, shebang: parser.lexer.shebang };
}

export default { parse, Lexer };
