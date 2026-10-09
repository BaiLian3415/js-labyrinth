/**
 * HTMLE：把 HTML 的文本节点与属性值加密成一段密文，页面里只留密文 + 一个
 * 还原 loader。运行期 loader 把密文解进内存，按占位标记把 DOM 还原成与原文逐字
 * 相同的形态。
 *
 * 解决的是"静态可读"：产物里不再有任何正文/属性明文，view-source、grep、爬虫
 * 都拿不到内容。
 *
 * 定位要说清：这是客户端混淆，不是保密。密钥和解密逻辑都在页面里，打开
 * 开发者工具的人照样能 dump 出解密后的 DOM，任何人拦不住。它挡的是"随手看源码 /
 * 静态扫描"，不是"有决心的人"。要真保密只能放到服务端。
 *
 * 两个容易做错的地方，这里都处理了：
 *
 * 1) 加密的是解码后的值，不是源码字面。源码里写的是 `&amp;`，DOM 里是 `&`。
 *    加密 `&amp;` 再用 textContent 写回去，页面就会显示字面的 `&amp;`。所以取值的
 *    时候先解实体，loader 写回时用 textContent / setAttribute（都按字面处理），
 *    两边正好对上。实体解码只覆盖常用命名实体与数值实体，未知实体原样保留——
 *    原样保留意味着 loader 写回的文本和原文一致，行为不改变。
 *
 * 2) 占位标记不能和原文撞。标记用两个控制字符包一个十进制下标；若原文里已经
 *    含有这两个字符，直接当标记解会解错。所以先扫描原文，冲突就换一组控制字符，
 *    最多试若干组。
 */
import rand from './utils/rand.js';

const { randInt, randHex } = rand;

/** 内部不处理的标签：内容是代码或不可见文本，动了会破坏产物。 */
const SKIP_CONTENT = new Set(['script', 'style', 'noscript', 'template']);

/** 属性明文不值得加密的：影响解析/行为的少数几个。 */
const SKIP_ATTRS = new Set(['src', 'href', 'integrity', 'nonce']);

// 常用命名实体。够用即可：未列出的保持原样（见文件头说明）。
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '\u00a9', reg: '\u00ae', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', trade: '\u2122',
  laquo: '\u00ab', raquo: '\u00bb', deg: '\u00b0', plusmn: '\u00b1', times: '\u00d7',
  divide: '\u00f7', middot: '\u00b7', bull: '\u2022', dagger: '\u2020', euro: '\u20ac',
  pound: '\u00a3', yen: '\u00a5', cent: '\u00a2', sect: '\u00a7', para: '\u00b6',
  micro: '\u00b5', frac12: '\u00bd', sup2: '\u00b2', sup3: '\u00b3', larr: '\u2190',
  rarr: '\u2192', harr: '\u2194', lArr: '\u21d0', rArr: '\u21d2', infin: '\u221e',
  ne: '\u2260', le: '\u2264', ge: '\u2265', alpha: '\u03b1', beta: '\u03b2', gamma: '\u03b3',
};

/** 解 HTML 实体：数值优先，其次查命名表，都不中就原样返回。 */
function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch (e) { return m; }
    }
    const v = NAMED[body];
    return v === undefined ? m : v;
  });
}

// 核心不使用 Buffer（自测里有「核心不使用 Buffer」与「核心 import 图不含 Node 内建」
// 两条断言），所以 utf8 ↔ 字节走 Web 标准的 TextEncoder/TextDecoder——jsfuck.js、
// shell.js、platform.js 早就在用同一套，不引入新依赖。
const TE = new TextEncoder();
const TD = new TextDecoder();

/** 字节数组 → latin1 字符串（每个码元恰好一个字节），供 length-prefix 打包用。 */
function bytesToLatin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** latin1 字符串前 n 个码元 → 字节数组，是 bytesToLatin1 的逆。 */
function latin1ToBytes(s, from, n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = s.charCodeAt(from + i);
  return out;
}

/** 定长编码的序列化：每项 <十进制长度>:<内容>，避免用分隔符（内容里可能含任何字符）。 */
function packValues(values) {
  let s = '';
  for (const v of values) {
    const b = TE.encode(v);
    s += b.length + ':' + bytesToLatin1(b);
  }
  return s;
}

function unpackValues(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const colon = s.indexOf(':', i);
    if (colon < 0) break;
    const n = parseInt(s.slice(i, colon), 10);
    if (!Number.isFinite(n) || n < 0) break;
    const from = colon + 1;
    out.push(TD.decode(latin1ToBytes(s, from, n)));
    i = from + n;
  }
  return out;
}

/**
 * 逐字符密钥流变换（加解密共用）。
 *
 * 自反：掩码只由 `(key, 位置)` 决定、不依赖输入字节，所以同一个函数加密一遍再解一遍
 * 就回原文（`a ^ m ^ m === a`）。
 *
 * transform / untransform 是同一个函数的两个名字，调用点读起来更贴切（解密处写
 * untransform 更说明意图），但它们必须保持同一份实现——loader 里只有 `xt` 一份，
 * 构建端若换成另一套公式（例如相减而不是异或），两边一旦不一致就是静默解出错乱，而不是
 * 报错。别把它"修"成非对称形式。
 */
function crypt(text, key) {
  let out = '';
  let k = key >>> 0;
  for (let i = 0; i < text.length; i++) {
    k = (Math.imul(k, 1664525) + 1013904223) >>> 0;
    out += String.fromCharCode(text.charCodeAt(i) ^ ((k >>> 16) & 0xff));
  }
  return out;
}

const transform = crypt;
const untransform = crypt;

export { packValues, unpackValues, crypt, transform, untransform, decodeEntities, scramble, pickMarkers };

/**
 * 选一组不与原文冲突的标记字符。
 * @param {string} src 原文（整篇 HTML）
 * @returns {{open:string, close:string}}
 */
function pickMarkers(src) {
  const pool = [1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
  for (let a = 0; a < pool.length; a++) {
    for (let b = a + 1; b < pool.length; b++) {
      const open = String.fromCharCode(pool[a]);
      const close = String.fromCharCode(pool[b]);
      if (src.indexOf(open) < 0 && src.indexOf(close) < 0) return { open, close };
    }
  }
  return null;
}

/**
 * 扫一遍 HTML，把文本节点与属性值替换成占位标记。
 *
 * 自己扫而不引 DOM/解析器：这个模块要能在构建期（Node）与运行期（浏览器）共用一套
 * 极简逻辑，且不能把 `ast/parser.js` 拉进来。页面结构简单（标签 + 属性 + 文本），
 * 一个字符级扫描足够；已知的坑都处理了：注释、CDATA、doctype、script/style 内容、
 * 属性值的引号与转义。
 *
 * @param {string} html
 * @param {{open:string,close:string}} mk
 * @returns {{html:string, values:string[]}}
 */
function scramble(html, mk, opts) {
  // keepEntities：JS 侧的字面量要不解码实体。
  //
  // 文档模式必须解码（见文件头第 1 点）：写回用 textContent，要的是 DOM 里真正出现的值。
  // JS 侧相反——字面量里的 `&amp;` 就是 5 个字符，赋给 innerHTML 后由浏览器解码。
  // 若这里解码成 `&`，还原出来的字符串里就是字面的 `&`，浏览器当纯文本处理，
  // `A &amp; B` 会显示成 `A & B` 而不是 `A & B`（原意）——内容被改写了。
  // 所以 JS 侧按原样字符加密，解密回来仍逐字相同，语义不变。
  const keepEntities = !!(opts && opts.keepEntities);
  const norm = keepEntities ? (s) => s : decodeEntities;
  const values = [];
  const n = html.length;
  let out = '';
  let i = 0;
  // 当前是否在 script/style 等不可处理的内容里
  let skipUntil = '';

  const take = (v) => {
    const idx = values.length;
    values.push(v);
    return mk.open + idx + mk.close;
  };

  while (i < n) {
    const c = html[i];

    // 注释 / CDATA / doctype：原样拷到结束
    if (c === '<' && html.startsWith('<!--', i)) {
      const e = html.indexOf('-->', i + 4);
      const end = e < 0 ? n : e + 3;
      out += html.slice(i, end);
      i = end;
      continue;
    }
    if (c === '<' && html.startsWith('<![CDATA[', i)) {
      const e = html.indexOf(']]>', i + 9);
      const end = e < 0 ? n : e + 3;
      out += html.slice(i, end);
      i = end;
      continue;
    }
    if (c === '<' && html[i + 1] === '!') {
      const e = html.indexOf('>', i);
      const end = e < 0 ? n : e + 1;
      out += html.slice(i, end);
      i = end;
      continue;
    }

    // 标签
    if (c === '<') {
      const close = html.indexOf('>', i);
      if (close < 0) { out += html.slice(i); i = n; break; }
      let tagEnd = close;
      // 属性值里可能有 '>'，标签解析要跳过引号内的内容
      tagEnd = findTagEnd(html, i);
      if (tagEnd < 0) { out += html.slice(i); i = n; break; }
      const raw = html.slice(i, tagEnd + 1);
      const m = /^<\s*(\/?)([a-zA-Z][a-zA-Z0-9:_-]*)/.exec(raw);
      const name = m ? m[2].toLowerCase() : '';
      out += processTag(raw, name, take, norm);
      i = tagEnd + 1;
      if (name && SKIP_CONTENT.has(name) && !m[1]) skipUntil = name;
      continue;
    }

    // 文本节点
    if (skipUntil) {
      const e = indexOfCloseTag(html, i, skipUntil);
      if (e < 0) { out += html.slice(i); i = n; break; }
      out += html.slice(i, e);
      i = e;
      skipUntil = '';
      continue;
    }
    const next = html.indexOf('<', i);
    const end = next < 0 ? n : next;
    const text = html.slice(i, end);
    if (text.trim() !== '') {
      // 纯空白（含换行与缩进）保留：去掉会让源码挤成一行，也会改变部分 CSS 选择器
      // 的语义（相邻兄弟选择器依赖文本节点存在）
      out += take(norm(text));
    } else {
      out += text;
    }
    i = end;
  }
  return { html: out, values };
}

/** 找到标签真正的 '>'，跳过引号内的 '>'。 */
function findTagEnd(html, from) {
  const n = html.length;
  let i = from + 1;
  let quote = '';
  while (i < n) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
    i++;
  }
  return -1;
}

function indexOfCloseTag(html, from, name) {
  const re = new RegExp('</\\s*' + name + '\\s*>', 'i');
  const rest = html.slice(from);
  const m = re.exec(rest);
  return m ? from + m.index : -1;
}

/** 处理一个标签：只改属性值，标签名与其他内容原样。 */
function processTag(raw, name, take, norm) {
  if (!name) return raw;
  const head = /^<\s*\/?\s*[a-zA-Z][a-zA-Z0-9:_-]*/.exec(raw);
  if (!head) return raw;
  let out = raw.slice(0, head[0].length);
  const body = raw.slice(head[0].length, raw.endsWith('>') ? -1 : undefined);
  const tail = raw.endsWith('>') ? '>' : '';
  const ATTR = /([^\s=/>"']+)(\s*=\s*)("([^"]*)"|'([^']*)'|([^\s>]*))?/g;
  let m;
  let last = 0;
  while ((m = ATTR.exec(body)) !== null) {
    out += body.slice(last, m.index);
    const attrName = m[1];
    const eq = m[2];
    // 分组要取对：m[3] 是带引号的整段，m[4]/m[5]/m[6] 才是引号内的内容与无引号值。
    // 早前误用 m[3] 当内容，产出 class=""box"" 这种双层引号。
    const dq = m[4];
    const sq = m[5];
    const bare = m[6];
    if (eq === undefined) {
      out += attrName;                       // 无值属性（disabled 之类）
    } else if (dq !== undefined) {
      out += attrName + eq + '"' + encAttr(dq, attrName, take, norm) + '"';
    } else if (sq !== undefined) {
      out += attrName + eq + "'" + encAttr(sq, attrName, take, norm) + "'";
    } else {
      out += attrName + eq + encAttr(bare, attrName, take, norm);
    }
    last = m.index + m[0].length;
  }
  out += body.slice(last);
  return out + tail;
}

function encAttr(v, attrName, take, norm) {
  if (v === '') return '';
  if (SKIP_ATTRS.has(attrName.toLowerCase())) return v;
  return take(norm(v));
}

/**
 * 生成 loader 源码。
 *
 * 刻意保持紧凑且不依赖任何外部东西：它要能在任何页面里独立跑通。解密路径与上面
 * 的 untransform / unpackValues 逐字对应（同一份 LCG 密钥流公式、同一套长度前缀）。
 */
function buildLoader(b64, key, mk) {
  const open = mk.open.charCodeAt(0);
  const close = mk.close.charCodeAt(0);
  return `(function(){
var B=${JSON.stringify(b64)},K=${key >>> 0},O=${open},C=${close},S=String.fromCharCode(O),E=String.fromCharCode(C);
function xt(t,k){var o="",x=k>>>0;for(var i=0;i<t.length;i++){x=(Math.imul(x,1664525)+1013904223)>>>0;o+=String.fromCharCode(t.charCodeAt(i)^((x>>>16)&255));}return o;}
var bin=atob(B),packed=xt(bin,K),dec=new TextDecoder(),vals=[],i=0;
while(i<packed.length){var c=packed.indexOf(":",i);if(c<0)break;var n=parseInt(packed.slice(i,c),10);if(!(n>=0))break;
var f=c+1,by=new Uint8Array(n);for(var j=0;j<n;j++)by[j]=packed.charCodeAt(f+j);
vals.push(dec.decode(by));i=f+n;}
var re=new RegExp(S+"(\\\\d+)"+E,"g");
function fix(s){re.lastIndex=0;return s.replace(re,function(_,k){return vals[+k]===undefined?"":vals[+k];});}
function walk(){
var w=document.createTreeWalker(document.documentElement,NodeFilter.SHOW_TEXT,null),n;
while((n=w.nextNode())){var p=n.parentNode;if(!p)continue;var t=(p.nodeName||"").toLowerCase();
if(t==="script"||t==="style"||t==="noscript"||t==="template")continue;
var v=n.nodeValue;if(v&&v.indexOf(S)>=0){var f=fix(v);if(f!==v)n.nodeValue=f;}}
var all=document.getElementsByTagName("*");
for(var a=0;a<all.length;a++){var el=all[a],at=el.attributes;
for(var b=at.length-1;b>=0;b--){var q=at[b];if(q.value.indexOf(S)>=0){try{el.setAttribute(q.name,fix(q.value));}catch(e){}}}}
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",walk);else walk();
})();`;
}

/**
 * 入口：把 HTML 的文本与属性值加密成密文 + loader。
 *
 * @param {string} html
 * @param {object} options 已归一化的选项（只读 htmle / htmleKey）
 * @returns {{html:string, values:number, bytes:number}}
 */
export function htmle(html, options) {
  const mk = pickMarkers(html);
  if (!mk) return { html, values: 0, bytes: 0, skipped: 'no-marker-free-chars' };

  const { html: scrambled, values } = scramble(html, mk);
  if (!values.length) return { html, values: 0, bytes: 0, skipped: 'no-values' };

  const key = (options.htmleKey >>> 0) || ((randInt(0, 0xffffffff) >>> 0) || 1);
  const packed = packValues(values);
  const cipher = untransform(packed, key);
  const b64 = btoa(cipher);   // cipher 是 latin1 串，btoa 正好吃这种输入
  const loader = buildLoader(b64, key, mk);

  // loader 放在 </body> 之前：其上方的 DOM 已解析完，脚本本身也成了扫描范围的
  // 一部分（自身是 script，walk 会跳过）。没有 </body> 就追加到末尾。
  //
  // 下标必须在 scrambled 上找，不能用原文 html 的位置：scramble 把值换成了长度
  // 不同的占位标记，两边偏移根本不对应。拿原文的 </body> 下标去切 scrambled，loader 会被
  // 塞进标签中间，产出 `<script>` 多于 `</script>` 的坏 HTML（实测会多出一个孤零零的
  // `pt>`）。2026-09-30 由「属性无引号」等边界用例暴露——之前那份浏览器对比文档尾部结构
  // 太单一，偏移恰好落在空白处，才没炸。
  const script = '<script>' + loader + '</script>';
  let out;
  const bodyEnd = scrambled.lastIndexOf('</body>');
  if (bodyEnd >= 0) out = scrambled.slice(0, bodyEnd) + script + scrambled.slice(bodyEnd);
  else out = scrambled + script;

  return { html: out, values: values.length, bytes: cipher.length, key, skipped: null };
}

export default {
  htmle, packValues, unpackValues, crypt, transform, untransform,
  decodeEntities, scramble, pickMarkers,
};
