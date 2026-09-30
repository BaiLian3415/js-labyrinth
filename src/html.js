import parser from './ast/parser.js';
const { parse } = parser;
import traverse from './ast/traverse.js';
import t from './ast/types.js';
import i18n from './i18n.js';
const { t: msg } = i18n;
import obfuscateMod from './obfuscate.js';
const { obfuscate } = obfuscateMod;
/**
 * HTML 内联脚本处理：抽出 <script> 里的 JS 交给 transform，再原位回写。
 * 每块都是独立编译单元，各自混淆、互不共享重命名和字符串池，seed 按块序偏移，
 * 同一份 HTML 里多个块才不会产出同一套随机选择；单块失败只影响该块。
 */

// 当作 JS 的 type 值；比较前先剥掉分号后的 charset 等参数，空串表示没写 type
const JS_MIME = new Set([
  'module', 'text/javascript', 'application/javascript', 'text/ecmascript',
  'application/ecmascript', 'application/x-javascript', 'text/jscript',
]);
// 原文元素内的内容是展示文本，里面的 <script> 不会执行也不用处理
const RAWTEXT_TAGS = new Set(['textarea', 'title', 'xmp', 'noembed', 'noframes']);

/**
 * 解析 <...> 开标签，属性值里的 > 不会截断标签。
 * @returns {{tagName:string, attrs:Object, afterOpen:number}|null}
 *   null 表示标签或属性引号未闭合，调用方按普通文本继续处理
 */
function parseOpenTag(html, lt) {
  const n = html.length;
  let i = lt + 1;
  let j = i;
  while (j < n && !/[\s/>]/.test(html[j])) j++;
  if (j >= n) return null;
  const tagName = html.slice(i, j).toLowerCase();
  i = j;
  const attrs = {};
  for (;;) {
    while (i < n && /\s/.test(html[i])) i++;
    if (i >= n) return null;
    const c = html[i];
    if (c === '>') return { tagName, attrs, afterOpen: i + 1 };
    if (c === '/') { i++; continue; }
    let k = i;
    while (k < n && !/[=\s>]/.test(html[k])) k++;
    if (k >= n) return null;
    const name = html.slice(i, k).toLowerCase();
    i = k;
    while (i < n && /\s/.test(html[i])) i++;
    if (i < n && html[i] === '=') {
      i++;
      while (i < n && /\s/.test(html[i])) i++;
      if (i >= n) return null;
      const q = html[i];
      if (q === '"' || q === "'") {
        const e = html.indexOf(q, i + 1);
        if (e < 0) return null;
        attrs[name] = html.slice(i + 1, e);
        i = e + 1;
      } else {
        let u = i;
        while (u < n && !/[\s>]/.test(html[u])) u++;
        attrs[name] = html.slice(i, u);
        i = u;
      }
    } else {
      attrs[name] = null; // 无值属性，如 defer
    }
  }
}

function isJsMime(raw) {
  const v = String(raw == null ? '' : raw).split(';')[0].trim().toLowerCase();
  return v === '' || JS_MIME.has(v);
}

/** 找 </name ...> 结束标签，返回其 '>' 之后的位置；找不到返回 -1。 */
function findCloseTag(html, from, tagName) {
  const re = new RegExp('</' + tagName + '(?=[\\s/>])', 'gi');
  re.lastIndex = from;
  const m = re.exec(html);
  if (!m) return -1;
  const gt = html.indexOf('>', m.index);
  return gt < 0 ? html.length : gt + 1;
}

/**
 * 收集一个块的顶层声明和自由变量，供跨块共享检测使用。
 * topLevel 是经典脚本顶层会挂进全局的绑定名，module 恒为空；
 * free 是块内引用但块内没有绑定的名字。
 * @param {string} js 块的 JS 源码
 * @param {boolean} isModule 是否为 module 块
 * @returns {{topLevel:Set<string>, free:Set<string>}|null} 解析失败时返回 null
 */
function blockFacts(js, isModule) {
  let ast;
  try {
    ast = parse(js, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: false,
      plugins: ['topLevelAwait'],
    });
  } catch (e) { return null; }
  const topLevel = new Set();
  if (!isModule) {
    for (const s of ast.program.body) {
      if (s.type === 'VariableDeclaration') {
        for (const d of s.declarations) {
          for (const k in t.getBindingIdentifiers(d.id)) topLevel.add(k);
        }
      } else if ((s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') && s.id) {
        topLevel.add(s.id.name);
      }
    }
  }
  const free = new Set();
  try {
    traverse(ast, {
      Program(p) { p.scope.crawl(); },
      ReferencedIdentifier(p) {
        const nm = p.node.name;
        if (nm === 'undefined' || nm === 'arguments') return;
        if (!p.scope.getBinding(nm)) free.add(nm);
      },
    });
  } catch (e) { /* 作用域异常时保守置空（不影响混淆本身） */ }
  return { topLevel, free };
}

/**
 * @param {string} html HTML 源码
 * @param {function(string, number, {isModule:boolean, sharedNames:string[]}): string} transform
 *   (js, idx, meta) => 混淆后 JS，抛错表示该块处理失败。idx 是可混淆块的序号，
 *   跳过的块不占号，调用方用它做 seed 偏移；meta.sharedNames 是本块引用到的其他块
 *   顶层声明名，重命名和 IIFE 包装会切断这类共享，调用方可据此调整选项。
 * @returns {{html:string, info:{obfuscated:number, skippedExternal:number, skippedType:number, skippedEmpty:number, failed:number}, warnings:string[]}}
 */
function processHtml(html, transform) {
  const info = { obfuscated: 0, skippedExternal: 0, skippedType: 0, skippedEmpty: 0, failed: 0 };
  const warnings = [];

  // 第一遍只记录位置、属性和作用域事实，不动文本，后面替换时坐标才不会失真
  const blocks = [];
  let pos = 0;
  const n = html.length;
  while (pos < n) {
    const lt = html.indexOf('<', pos);
    if (lt < 0) break;

    // HTML 注释整段跳过，里面的 <script> 浏览器也不会执行
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      pos = end < 0 ? n : end + 3;
      continue;
    }

    const open = parseOpenTag(html, lt);
    if (!open) { pos = lt + 1; continue; }

    if (open.tagName === 'script') {
      const closeRe = /<\/script(?=[\s/>])/gi;
      closeRe.lastIndex = open.afterOpen;
      const m = closeRe.exec(html);
      if (!m) break; // 没有结束标签时浏览器会一路读到 EOF，后面不会再有块
      const contentStart = open.afterOpen;
      const contentEnd = m.index;
      const gt = html.indexOf('>', contentEnd);
      const afterClose = gt < 0 ? n : gt + 1;
      const typeRaw = open.attrs.type === undefined ? '' : String(open.attrs.type);
      const isModule = typeRaw.trim().toLowerCase() === 'module';
      if (open.attrs.src !== undefined) {
        info.skippedExternal++;
      } else if (!isJsMime(typeRaw)) {
        info.skippedType++;
      } else {
        const js = html.slice(contentStart, contentEnd);
        if (!js.trim()) {
          info.skippedEmpty++;
        } else {
          blocks.push({
            contentStart, contentEnd, afterClose, isModule, js,
            facts: blockFacts(js, isModule) || { topLevel: new Set(), free: new Set() },
          });
        }
      }
      pos = afterClose;
      continue;
    }

    // plaintext 之后整篇都是文本
    if (open.tagName === 'plaintext') break;
    // 原文元素整体跳到结束标签，浏览器同样不解析其中的内容
    if (RAWTEXT_TAGS.has(open.tagName)) {
      const stop = findCloseTag(html, open.afterOpen, open.tagName);
      pos = stop < 0 ? n : stop;
      continue;
    }

    pos = lt + 1;
  }

  // 经典脚本共享同一个全局作用域：某块的自由名若落在别的块的顶层声明里，说明存在
  // 跨块共享，重命名和 IIFE 包装会把它切断。module 的顶层声明不进全局，不参与判定。
  const shared = blocks.map((b) => new Set());
  for (let j = 0; j < blocks.length; j++) {
    if (blocks[j].isModule) continue; // module 顶层不进全局，不作为共享源
    for (let i = 0; i < blocks.length; i++) {
      if (i === j) continue;
      for (const nm of blocks[j].facts.free) {
        if (blocks[i].facts.topLevel.has(nm)) shared[j].add(nm);
      }
    }
  }
  for (let j = 0; j < blocks.length; j++) {
    if (shared[j].size) {
      warnings.push(msg('htmlSharedWarning', { n: j + 1, names: [...shared[j]].join(', ') }));
    }
  }

  // 从后往前替换，改动后面的块不会让前面记下的位置失效
  let out = html;
  for (let k = blocks.length - 1; k >= 0; k--) {
    const b = blocks[k];
    const sharedNames = [...shared[k]];
    try {
      const outJs = transform(b.js, k, { isModule: b.isModule, sharedNames });
      // 转义字面 </script，否则产物里的字符串会提前关掉脚本块；字符串和模板里 \/ 与 / 等值
      const safeJs = outJs.replace(/<\/script/gi, '<\\/script');
      out = out.slice(0, b.contentStart) + safeJs + out.slice(b.contentEnd);
      info.obfuscated++;
    } catch (e) {
      info.failed++;
      warnings.push(msg('htmlBlockError', { n: k + 1, msg: e.message }));
    }
  }

  return { html: out, info, warnings };
}

/**
 * 整篇 HTML 的混淆：对每个内联脚本块独立调用 obfuscate()，原位回写。
 *
 * 命令行、网页界面与 Worker API 都走这里，三端对同一份 HTML 的处理与统计口径
 * 完全一致。seed 按块序偏移（基准 + 序号 × 7919），既保证固定 seed 下可复现，
 * 又让同一篇文档里的多个块不会产出同一套随机选择。
 *
 * 跨块共享：某块引用到兄弟块的顶层声明时，重命名与 IIFE 包装会切断这类共享，
 * 该块关掉自检（否则必然报未绑定引用），并把共享名作为警告返回给调用方。
 *
 * @param {string} html HTML 源码
 * @param {object} options 已合并的完整选项（见 obfuscate.resolveOptions）
 * @returns {{html:string|null, info:object, warnings:string[], stats:Array|null,
 *   originalSize:number, obfuscatedSize:number}} info.obfuscated 为 0 时 html 为 null
 */
function obfuscateDocument(html, options) {
  const baseSeed = options.seed !== undefined ? options.seed : 1337;
  let stats = null;
  let originalSize = 0;
  let obfuscatedSize = 0;
  // 逐块混淆产生的警示（如「名单非空→跳过外壳」）并回总结果：同一篇文档里每个
  // 块都会给出同一条，去重后再交给调用方，不然界面里会连刷十几遍。
  const blockWarnings = [];
  const res = processHtml(html, (js, idx, blockMeta) => {
    // HTML 模式逐块混淆，**跳过引导层**（bannerSkip）。理由与旧的"文件头横幅"无关，
    // 改成引导层后有两点：引导层逐块注入没有额外价值（它不是面向页面的署名，而是
    // 产物自校验的载体），而且内联块之间**共享全局作用域**——每块各写一个
    // `global[随机名]` 健康载体会互相覆盖，后写的把先写的冲掉，字符串池的密钥偏移
    // 就算得错。要在 HTML 模式启用耦合，正确做法是整页只注入一次引导、在所有块
    // 之前执行，那是另一件事，不在这里顺手改。其余增强保护照常生效。
    const opts = { ...options, seed: baseSeed + idx * 7919, bannerSkip: true };
    if (blockMeta.sharedNames.length) opts.selfCheck = false;
    const out = obfuscate(js, opts);
    if (out.warnings && out.warnings.length) blockWarnings.push(...out.warnings);
    stats = out.stats;
    originalSize = out.originalSize;
    obfuscatedSize = out.obfuscatedSize;
    return out.code;
  });
  return {
    html: res.info.obfuscated === 0 ? null : res.html,
    info: res.info,
    warnings: [...new Set([...res.warnings, ...blockWarnings])],
    stats,
    originalSize,
    obfuscatedSize,
  };
}

export default { processHtml, obfuscateDocument, parseOpenTag, isJsMime, JS_MIME };
export { processHtml, obfuscateDocument, parseOpenTag, isJsMime, JS_MIME };
