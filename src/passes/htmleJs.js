/**
 * HTMLE（JS 侧）：把嵌在 JS 里的 HTML 也加密成密文，运行期由注入的解码器还原。
 *
 * 与文档模式（src/htmle.js，改的是整篇 HTML 的文本节点与属性值）的分工：
 *   - 文档模式：输入本身是 HTML，加密文本节点 + 属性值，还原靠 loader 遍历 DOM。
 *   - 本 pass：输入是 JS，HTML 以字符串/模板字面量存在于代码里。把这样的字面量换成
 *     一个运行期解码调用 `DEC(N)`，N 指向本文件专属的密文表。DEC 是**占位写法**：
 *     注入名逐构建随机（见阶段三的取名循环），产物里从不出现 `DEC` 这个串。
 *
 * 这里不需要 DOM：解码器只做一件事——按标记把模板里的占位换回值、返回字符串。它不
 * 碰 document，所以产物在 Node / worker / ServiceWorker 里照样能跑。这一点与文档模式
 * （必须有 document）根本不同，也是本模式适用范围更广的原因。
 *
 * 两个识别来源，取并集（用户 2026-10-01 选定）：
 *   1. 标签白名单：串里出现白名单标签的 `<tag` 或 `</tag`。用白名单而不是「有尖括号
 *      就算」，是为避开 `a < b`、`Array<int>`、`i<length` 这类误伤——`<b` 里的 b 不是
 *      标签，`Map<string,X>` 里的 string 不是标签。代价是自定义标签（`<my-widget>`）
 *      会漏，可用已有的 reservedStrings 手动排除。
 *   2. DOM 赋值处：出现在 innerHTML/outerHTML 赋值右侧、insertAdjacentHTML /
 *      document.write / createContextualFragment 的实参里，或 ``$(`…`)`` 这类
 *      jQuery/Zepto 调用。这类即使标签不在白名单也会被处理。
 *
 * 带标签的模板（lit-html 的 html`…`）不处理，这是有意留的空缺而不是漏写：
 * 它的准星位置必须是真正的 TemplateLiteral，替换成解码调用会让
 * TaggedTemplateExpression.quasi 变成 CallExpression，生成器读 node.quasis 直接抛
 * TypeError；而且标签函数约定收到的是 (strings, ...values)，塞一个返回单个字符串的
 * 调用进去本身也改了语义。要支持得改准星的内容表示（准星保留、只换 quasi 里的字符串
 * 字面量），那是另一种改法，不在这里顺手做。用普通模板 + innerHTML 赋值同样能覆盖
 * 绝大多数写法。
 *
 * 插值模板（`<div>${x}</div>`）逐个静态片段加密，重建成 `DEC(0)+x+DEC(1)` 的拼接（DEC
 * 同上，是随机注入名的占位写法）。
 * 片段本身加密不出东西的（纯空白、单个闭合标签）保持原样，不为了统一而套一层空调用。
 *
 * 必须排在 stringArray 之前（obfuscate.js 里有注释说明）：它把字面量整个换掉，
 * stringArray 后面就看不到 HTML 了。
 *
 * 注入头部是源码级前插、不参与 mangle，所以注入名必须登记进 ctx.keepNames，
 * 否则 AST 里的调用点被改名、注入源码里的名字没变，两边对不上。与 stringArray 的
 * 解码器同一处理。
 */
import t from '../ast/types.js';
import randUtil from '../utils/rand.js';
const { randInt, randHex } = randUtil;
import he from '../htmle.js';

const { scramble, pickMarkers, packValues, crypt } = he;

/**
 * 认得的 HTML 标签。刻意只收标准标签：自定义元素走「DOM 赋值处」那条路，
 * 或用 reservedStrings 排除，避免 `<` 开头的普通比较表达式被误判。
 */
const HTML_TAGS = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'audio', 'b', 'bdi', 'bdo', 'blockquote',
  'body', 'br', 'button', 'canvas', 'caption', 'cite', 'code', 'col', 'colgroup',
  'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt',
  'em', 'embed', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'i', 'iframe',
  'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map', 'mark',
  'menu', 'meta', 'meter', 'nav', 'noscript', 'object', 'ol', 'optgroup', 'option',
  'output', 'p', 'param', 'picture', 'pre', 'progress', 'q', 'rp', 'rt', 'ruby', 's',
  'samp', 'script', 'section', 'select', 'slot', 'small', 'source', 'span', 'strong',
  'style', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'template', 'textarea',
  'tfoot', 'th', 'thead', 'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video',
  'wbr',
]);

/** 标签白名单判定。必须整体匹配一个标签名，光有 `<` `>` 不算。 */
function byTagWhitelist(s) {
  if (s.indexOf('<') < 0) return false;
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)(?=[\s/>]|$)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (HTML_TAGS.has(m[1].toLowerCase())) return true;
  }
  return false;
}

const DOM_PROP = /^(?:inner|outer)HTML$/;
const DOM_FN = /^(?:insertAdjacentHTML|write|writeln|createContextualFragment)$/;

/** 取 memberExpression / identifier 的名字，computed 时取字符串值。 */
function nodeName(node) {
  if (!node) return '';
  if (node.type === 'Identifier') return node.name || '';
  if (node.type === 'MemberExpression') {
    if (node.computed) {
      const p = node.property;
      if (p && (p.type === 'StringLiteral' || p.type === 'Literal')) return String(p.value);
      return '';
    }
    const p = node.property;
    return p ? String(p.name || p.value || '') : '';
  }
  if (node.type === 'StringLiteral' || node.type === 'Literal') return String(node.value);
  return '';
}

/**
 * DOM 赋值处判定。覆盖：
 *   - `x.innerHTML = "…"` / `x.outerHTML = "…"`：赋值右侧
 *   - `insertAdjacentHTML(pos, "…")` / `document.write("…")` / `createContextualFragment("…")`
 *     / `$(`…`)`（jQuery、Zepto）：实参或模板本体
 *   - `` html`…` ``（lit-html 之类）：tag 名以 html 结尾
 *
 * 位置参数一律取全部实参逐一判断：insertAdjacentHTML 的内容在第二个参数、
 * document.write 在第一个，逐一分辨太脆，漏判的代价（该加密的没加密）比分判的代价大。
 */
function byDomSite(path) {
  const p = path.parentPath;
  if (!p) return false;
  const n = p.node;

  if (p.isAssignmentExpression && p.isAssignmentExpression() && n.right === path.node) {
    if (n.left && n.left.type === 'MemberExpression' && DOM_PROP.test(nodeName(n.left))) return true;
  }

  if (p.isTaggedTemplateExpression && p.isTaggedTemplateExpression()) {
    // `` html`…` `` 的准星是 n.quasi（不是 n.tag —— n.tag 是标签本身）。
    const isQuasi = n.quasi === path.node;
    const nm = nodeName(n.tag);
    // 标签名以 html 结尾（lit-html 之类）算 DOM 赋值处
    if (isQuasi && /html$/i.test(nm)) return true;
    // `$` / `jQuery` 包着模板
    if (isQuasi && (nm === '$' || nm === 'jQuery' || nm === 'Zepto')) return true;
  }

  if (p.isCallExpression && p.isCallExpression()) {
    const nm = nodeName(n.callee);
    if (DOM_FN.test(nm) || nm === '$' || nm === 'jQuery' || nm === 'Zepto') {
      const args = n.arguments || [];
      return args.indexOf(path.node) >= 0;
    }
  }
  return false;
}




/** reservedStrings 复用为逃生舱：用户显式保留的串一律不碰。 */
function makeReservedFilter(options) {
  const raw = options.reservedStrings;
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',') : []);
  const res = [];
  for (const one of list) {
    const s = String(one == null ? '' : one).trim();
    if (!s) continue;
    try { res.push(new RegExp(s)); } catch (e) { /* 非法正则：跳过这一条，不影响其它 */ }
  }
  return res.length ? (v) => res.some((re) => re.test(v)) : null;
}

/**
 * 生成解码器源码。
 *
 * 与文档模式的 loader 同源（同一份 crypt、同一套长度前缀打包），差别只在最后一步：
 * 文档模式遍历 DOM 改回去，这里直接把模板拼成字符串返回。
 */
function buildDecoder({ name, blob, key, open, close, templateCount }) {
  return [
    'var ' + name + '=(function(){',
    'var B=' + JSON.stringify(blob) + ',K=' + (key >>> 0)
      + ',O=' + open + ',C=' + close + ',N=' + templateCount
      + ',S=String.fromCharCode(O),E=String.fromCharCode(C);',
    'function xt(t,k){var o="",x=k>>>0;for(var i=0;i<t.length;i++){'
      + 'x=(Math.imul(x,1664525)+1013904223)>>>0;'
      + 'o+=String.fromCharCode(t.charCodeAt(i)^((x>>>16)&255));}return o;}',
    'var packed=xt(atob(B),K),dec=new TextDecoder(),A=[],i=0;',
    'while(i<packed.length){var c=packed.indexOf(":",i);if(c<0)break;'
      + 'var n=parseInt(packed.slice(i,c),10);if(!(n>=0))break;var f=c+1,b=new Uint8Array(n);'
      + 'for(var j=0;j<n;j++)b[j]=packed.charCodeAt(f+j);A.push(dec.decode(b));i=f+n;}',
    'var T=A.slice(0,N),V=A.slice(N),',
    're=new RegExp(S+"(\\\\d+)"+E,"g");',
    'return function(k){var s=T[k];if(s===undefined)return "";',
    'return s.replace(re,function(_,x){var v=V[+x];return v===undefined?"":v;});};',
    '})();',
  ].join('\n');
}

/**
 * @param {object} ast
 * @param {object} options
 * @param {object} ctx
 * @returns {{literals:number,values:number,bytes:number}|{skipped:string}}
 */
export default function htmleJs(ast, options, ctx) {
  if (!options.htmle) return { skipped: 'off' };

  const { traverse } = ctx;
  const used = ctx.usedNames || (ctx.usedNames = new Set());
  const keep = ctx.keepNames || (ctx.keepNames = new Set());

  const isReserved = makeReservedFilter(options);
  // 标记字符按整份源码挑一次：同一文件里所有模板共用一组，索引才对得上。
  const mk = pickMarkers(typeof ctx.source === 'string' ? ctx.source : '')
    || { open: '\u0001', close: '\u0002' };

  const qualifies = (v) => {
    if (!v || v.indexOf('<') < 0) return false;
    if (isReserved && isReserved(v)) return false;
    return byTagWhitelist(v);
  };

  // ---- 阶段一：收集候选 ----
  // kind: 'str' 整个字面量（无插值模板也走这里）；'quasi' 插值模板里的第 i 个静态片段
  const found = [];
  traverse(ast, {
    StringLiteral(path) {
      const v = path.node.value;
      if (typeof v !== 'string' || !v) return;
      if (!qualifies(v) && !byDomSite(path)) return;
      found.push({ path, kind: 'str', value: v });
    },
    TemplateLiteral(path) {
      const n = path.node;
      // 带标签的模板（lit-html 的 html`…`、gql`…`）整体跳过：它的准星位置必须是真正的
      // TemplateLiteral，替换成调用会让 TaggedTemplateExpression.quasi 变成 CallExpression，
      // 生成器读到 node.quasis 时直接抛 TypeError。标签函数要的是 (strings, ...values)，
      // 注入一个返回字符串的调用也改变了语义，所以这里不做。
      if (path.parentPath && path.parentPath.isTaggedTemplateExpression
        && path.parentPath.isTaggedTemplateExpression()
        && path.parentPath.node.quasi === path.node) return;
      const inDom = byDomSite(path);
      if (n.expressions.length === 0) {
        const q = n.quasis[0];
        const v = q.value.cooked !== undefined && q.value.cooked !== null ? q.value.cooked : q.value.raw;
        if (typeof v === 'string' && v && (qualifies(v) || inDom)) {
          found.push({ path, kind: 'str', value: v });
        }
        return;
      }
      for (let i = 0; i < n.quasis.length; i++) {
        const q = n.quasis[i];
        const v = q.value.cooked !== undefined && q.value.cooked !== null ? q.value.cooked : q.value.raw;
        if (typeof v !== 'string' || !v) continue;
        // 按片段独立判定即可：AST 给的 quasi 本身不含 `${`，静态部分各自就能判。
        if (!qualifies(v) && !inDom) continue;
        found.push({ path, kind: 'quasi', quasiIndex: i, value: v });
      }
    },
    noScope: true,
  });

  if (!found.length) return { skipped: 'no-html-in-js' };

  // ---- 阶段二：逐个 scramble，合并成文件级表 ----
  // scramble 给每个候选的占位下标是从 0 起数的，合并时要加偏移，否则第二个候选的
  // 占位会去取第一个候选的值。
  const templates = [];
  const values = [];
  const plan = [];              // { cand, tplIndex }
  const quasiPlan = new Map();  // TemplateLiteral 的 path → Map(quasiIndex → tplIndex)
  const markRe = new RegExp(mk.open + '(\\d+)' + mk.close, 'g');

  for (const c of found) {
    // keepEntities：字面量里的 `&amp;` 就是 5 个字符，赋给 innerHTML 后由浏览器解码。
    // 若按文档模式那样先解码成 `&`，还原出来的字符串里就是字面 `&`，浏览器当纯文本
    // 处理，内容被改写。JS 侧按原样字符加密，解密回来逐字相同、语义不变。
    const r = scramble(c.value, mk, { keepEntities: true });
    // 加密不出东西的（纯空白、只有闭合标签、没有任何文本/属性）不套空调用
    if (!r.values.length) continue;
    const off = values.length;
    for (const v of r.values) values.push(v);
    markRe.lastIndex = 0;
    const tpl = off === 0 ? r.html
      : r.html.replace(markRe, (_, d) => mk.open + (Number(d) + off) + mk.close);
    templates.push(tpl);
    const tplIndex = templates.length - 1;
    plan.push({ cand: c, tplIndex });
    if (c.kind === 'quasi') {
      let m = quasiPlan.get(c.path);
      if (!m) { m = new Map(); quasiPlan.set(c.path, m); }
      m.set(c.quasiIndex, tplIndex);
    }
  }

  if (!plan.length) return { skipped: 'nothing-to-encrypt' };

  // 注入名：短随机 + 登记 used / keepNames（理由见文件头）
  let name;
  for (;;) {
    const roll = randInt(0, 2);
    let cand;
    if (roll === 0) cand = '_' + randHex(randInt(2, 4));
    else if (roll === 1) cand = '$' + randHex(randInt(2, 3));
    else cand = '_h' + randHex(randInt(1, 2));
    if (!used.has(cand)) { used.add(cand); keep.add(cand); name = cand; break; }
  }

  // ---- 阶段三：替换 ----
  //
  // 两类要分开处理，且顺序不能反：
  //   1. 无插值模板（收集时归入 'str'）：path 就是 TemplateLiteral 本身，整体换成一个调用。
  //   2. 有插值模板：按 path 聚合成拼接表达式替换。
  //
  // 顺序反了会坏：先处理 'str' 时，它 replaceWith 掉的节点里可能同时含有后来
  // quasiPlan 引用的子路径——那些子路径指向已经被回收的 quasis，replaceWith 会写坏
  // AST，生成器读到 undefined.quasis 直接抛。先做聚合替换（quasiPlan 里的 path 是
  // 带插值的模板，与 'str' 那批不重叠），再逐个替换 'str'，两者就互不干扰。
  for (const [tplPath, indexMap] of quasiPlan) {
    const node = tplPath.node;
    const parts = [];
    for (let i = 0; i < node.quasis.length; i++) {
      if (indexMap.has(i)) {
        parts.push(t.callExpression(t.identifier(name), [t.numericLiteral(indexMap.get(i))]));
      } else {
        const q = node.quasis[i];
        const cooked = q.value.cooked !== undefined && q.value.cooked !== null ? q.value.cooked : q.value.raw;
        // 没被加密的片段保持原样；空片段直接省掉，免得拼出 `""+`
        if (typeof cooked === 'string' && cooked !== '') parts.push(t.stringLiteral(cooked));
      }
      if (i < node.expressions.length) parts.push(node.expressions[i]);
    }
    if (!parts.length) continue;
    let expr = parts[0];
    for (let i = 1; i < parts.length; i++) expr = t.binaryExpression('+', expr, parts[i]);
    tplPath.replaceWith(expr);
  }

  let literals = 0;
  for (const item of plan) {
    if (item.cand.kind !== 'str') continue;
    const p = item.cand.path;
    // 已被上面聚合替换掉的（理论上不该出现）跳过，避免写坏 AST
    if (!p.node || p.removed) continue;
    p.replaceWith(t.callExpression(t.identifier(name), [t.numericLiteral(item.tplIndex)]));
    literals++;
  }

  // ---- 打包与注入 ----
  // 模板在前、值在后，解码端靠 N 切分
  const packed = packValues(templates.concat(values));
  const key = (options.htmleKey >>> 0) || ((randInt(0, 0xffffffff) >>> 0) || 1);
  const cipher = crypt(packed, key);
  const blob = btoa(cipher);

  // 注入名是宿主全局上的绑定（源码级前插的 var），AST 里的引用没有对应声明，
  // validateReferences 会判成「未绑定引用」而让 selfCheck 失败。登记进
  // options.extraGlobals —— 那是 validateReferences 认的自定义全局入口，
  // stringArray 的 accessor 也走同一条路。
  if (!Array.isArray(options.extraGlobals)) options.extraGlobals = [];
  if (options.extraGlobals.indexOf(name) < 0) options.extraGlobals.push(name);

  ctx.htmleJs = {
    name, literals, templates: templates.length, values: values.length, bytes: cipher.length,
  };
  ctx.htmleJsSource = buildDecoder({
    name, blob, key, open: mk.open.charCodeAt(0), close: mk.close.charCodeAt(0),
    templateCount: templates.length,
  });

  return { literals, values: values.length, templates: templates.length, bytes: cipher.length, rebuilt: quasiPlan.size };
}