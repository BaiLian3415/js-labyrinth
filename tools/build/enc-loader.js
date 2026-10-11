/**
 * 模块体加密：把受保护的 src 模块编译成「明文 stub + 一个加密载荷」。
 *
 * ## 为什么需要它
 *
 * 自混淆（build-web.js 的 writeObfuscatedSrc）只能抬高阅读成本：名字被 mangle、
 * 原生 API 名被 RT 内核收敛，但只要跑一遍就能拿回可读代码。真正的痛点有两个——
 *   1) 匿名/已激活请求都能逐字节爬走完整实现；
 *   2) 产物是合法 ESM，字符串与结构都在，grep 一遍就能还原。
 * 本模块解决这两点：dist 里不再有受保护模块的源码文本，只有密文 + 一个引导层。
 *
 * ## 形态
 *
 *   dist/src/__core.pack     加密载荷（JSON：{ v, modules: { id: 源码 } }）
 *   dist/src/__jslb_core.js  明文引导层，含密钥与解密例程，导出 materialize(id)
 *   dist/src/<模块>.js       明文 stub：await materialize(id) 后静态再导出
 *
 * stub 必须静态再导出，因为 ESM 的导出名要能在解析期确定——不能运行时拼。
 * 所以构建期要枚举每个模块的导出名（见 collectExportNames），逐个写成
 * `export const <name> = __m.<name>;`。项目里 60 个模块恰好都是「一个 default
 * 导出 +（最多）若干具名导出」，所以这一步是有限且确定的。
 *
 * ## 为什么用 blob + import() 而不是直接把源码拼回文件
 *
 * ESM 的 `import` 说明符是静态解析的，密文模块不可能被静态 import。所以引导层
 * 解密后把源码做成 Blob URL 再 `import()`。代价是 blob 里的相对说明符会以 blob
 * URL 为基准解析——因此解密后要把 `from './x.js'` 改写成本源上的 stub 绝对地址。
 * 相对说明符在 blob 内一律失效，这一点必须在改写里覆盖全。
 *
 * ## 依赖图前提（构建期会断言）
 *
 * materialize 是带顶层 await 的，依赖图不能有环：A 等 B、B 等 A 就是死锁。
 * src/** 当前 60 个节点无环（已用 Tarjan 验过），build 前再断言一次。
 *
 * ## 威胁模型（别把它当安全边界）
 *
 * 密钥必须随引导层下发（浏览器要用），所以拿到引导层的人一定能解出载荷。
 * 这一层的价值是：匿名爬取拿不到任何明文、已激活用户的逆向起点从「读业务代码」
 * 变成「先逆一个引导层」。真正的边界仍是服务端——见 license-codec.js 头注释。
 * 正因如此载荷用的是一个快而简单的流密码（xorshift128），够挡住"直接读"，
 * 不承担密码学强度要求；竞品那种强度要靠服务端。
 *
 * ## 单一实现来源
 *
 * 构建期加密与运行期解密必须是同一套算法，否则产物静默全坏。这里不写两份：
 * 引导层的源码由 `keystream/xorInto/fnv1a` 的 fn.toString() 插值生成，
 * 构建期直接调用同一批函数。改动即同步，不存在漂移。
 */

// ---------------------------------------------------------------------------
// 密码例程：下面三个函数的源码会被原样插进引导层，必须自包含
// （不引用外部变量/模块，只用参数与内置对象），否则产物在浏览器里跑不起来。
// ---------------------------------------------------------------------------

/** xorshift128 密钥流（Marsaglia）。返回与 byteLen 等长的字节数组。 */
function keystream(keyWords, byteLen) {
  var x = keyWords[0] >>> 0, y = keyWords[1] >>> 0, z = keyWords[2] >>> 0, w = keyWords[3] >>> 0;
  var out = new Uint8Array(byteLen);
  var i = 0;
  while (i < byteLen) {
    var t = (x ^ (x << 11)) >>> 0;
    x = y; y = z; z = w;
    w = (w ^ (w >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    for (var b = 0; b < 4 && i < byteLen; b++, i++) {
      out[i] = (w >>> (b * 8)) & 255;
    }
  }
  return out;
}

/** 就地异或。加解密是同一个操作，所以构建期与运行期共用它。 */
function xorInto(bytes, ks) {
  for (var i = 0; i < bytes.length; i++) {
    bytes[i] ^= ks[i];
  }
  return bytes;
}

/** FNV-1a 32 位。用于载荷完整性：解出来对不上就抛，不静默跑错代码。 */
function fnv1a(bytes) {
  var h = 2166136261;
  for (var i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export const CRYPT_SOURCE = { keystream, xorInto, fnv1a };

// ---------------------------------------------------------------------------
// 密钥
// ---------------------------------------------------------------------------

/**
 * 由构建种子派生 4 个非零 32 位字。
 *
 * 默认密钥只由种子决定 ⇒ 同一份源码 + 同一种子在任何部署上得到同一把密钥，
 * 保住了「产物可复现」这条项目约定，但代价是：一个人从引导层里挖出密钥，
 * 对所有同源部署都有效。要避免就把 JSLB_BUILD_ENC_KEY 换成部署方自己的随机值
 * （build-web.js 读这个环境变量），此时产物不再与默认构建逐字节相同。
 */
export function keyWordsFromSeed(seed) {
  let s = (Number(seed) >>> 0) || 1;
  const out = [];
  for (let i = 0; i < 4; i++) {
    s = Math.imul(s ^ (s >>> 15), 2246822507) >>> 0;
    s = Math.imul(s ^ (s >>> 13), 3266489909) >>> 0;
    s = (s ^ (s >>> 16)) >>> 0;
    out.push(s || 0x9e3779b9); // xorshift 全零会退化成零流，兜一个非零
  }
  return out;
}

/** 把 hex / base64 形式的密钥文本解析成 4 个 32 位字。非法则抛。 */
export function keyWordsFromText(text) {
  const t = String(text).trim();
  const bytes = [];
  if (/^[0-9a-fA-F]{64}$/.test(t)) {
    for (let i = 0; i < 32; i++) bytes.push(parseInt(t.substr(i * 2, 2), 16));
  } else {
    const bin = Buffer.from(t, 'base64');
    if (bin.length < 16) throw new Error('JSLB_BUILD_ENC_KEY 至少 16 字节（base64 或 64 位 hex）');
    for (const b of bin) bytes.push(b);
  }
  const words = [];
  for (let i = 0; i < 4; i++) {
    const o = i * 4;
    words.push(((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0);
  }
  if (words.every((w) => w === 0)) throw new Error('JSLB_BUILD_ENC_KEY 不能是全零');
  return words;
}

// ---------------------------------------------------------------------------
// 载荷
// ---------------------------------------------------------------------------

/**
 * 打包并加密：{ v, modules } → JSON → UTF-8 → 追加 4 字节 FNV → 异或密钥流。
 * @param {Record<string,string>} modules 模块 id → 源码
 * @param {number[]} keyWords 4 个 32 位字
 * @returns {Uint8Array} 可直接写盘的字节
 */
export function packModules(modules, keyWords) {
  const body = new TextEncoder().encode(JSON.stringify({ v: 1, modules }));
  const expected = fnv1a(body);
  const plain = new Uint8Array(body.length + 4);
  plain.set(body, 0);
  plain[body.length] = (expected >>> 24) & 255;
  plain[body.length + 1] = (expected >>> 16) & 255;
  plain[body.length + 2] = (expected >>> 8) & 255;
  plain[body.length + 3] = expected & 255;
  return xorInto(plain, keystream(keyWords, plain.length));
}

/** 包装密文（构建期自检用，与 packModules 往返比对）。 */
export function unpackModules(packed, keyWords) {
  const bytes = xorInto(Uint8Array.from(packed), keystream(keyWords, packed.length));
  const n = bytes.length - 4;
  const expected = ((bytes[n] << 24) | (bytes[n + 1] << 16) | (bytes[n + 2] << 8) | bytes[n + 3]) >>> 0;
  const body = bytes.subarray(0, n);
  if (fnv1a(body) !== expected) throw new Error('载荷完整性校验失败');
  return JSON.parse(new TextDecoder().decode(body));
}

// ---------------------------------------------------------------------------
// 导出名枚举（生成 stub 用）
// ---------------------------------------------------------------------------

/**
 * 收集一个模块对外导出的名字（不含 default）。
 *
 * 覆盖项目里实际用到的几种形态：`export { a, b as c }`、`export { a } from './x.js'`、
 * `export const/let/var/function/class NAME`、`export async function NAME`、
 * `export function* NAME`（生成器）。
 * `export * from` 一旦出现就无法静态枚举，这里直接抛——构建期报错远好过产物里
 * 静默少一个导出（那样只会在运行到某条路径时才炸）。
 *
 * @param {string} code 模块源码
 * @returns {string[]} 导出名，去重且有序
 */
export function collectExportNames(code) {
  if (/^\s*export\s+\*/m.test(code)) {
    throw new Error('出现 `export *`：导出名无法静态枚举，stub 无法生成');
  }
  const names = new Set();

  // export { a, b as c } [from './x.js']
  //
  // 必须先把注释剥掉：项目里的导出清单带分组注释（`// 核心`、`// HTML`、`// 授权`），
  // 注释文本会跟着逗号粘进片段，于是紧随注释之后的那个导出名不匹配标识符正则被丢掉。
  // 2026-09-25 实测踩到：index.js 里 `obfuscate`（紧跟 `// 核心`）与 `runJob`（紧跟
  // `// 一次任务的完整流程…`）双双漏掉，产物能加载、能建对象，但一点"混淆"就
  // `runJob is not a function`——正是那种只在用户按下按钮时才炸的静默缺陷。
  const listRe = /^\s*export\s*\{([^}]*)\}/gm;
  let m;
  while ((m = listRe.exec(code))) {
    const body = m[1]
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');
    for (const part of body.split(',')) {
      const seg = part.trim();
      if (!seg) continue;
      const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(seg);
      if (asMatch) {
        if (asMatch[2] !== 'default') names.add(asMatch[2]);
        continue;
      }
      if (/^[A-Za-z_$][\w$]*$/.test(seg) && seg !== 'default') names.add(seg);
    }
  }

  // export const/let/var/function/class NAME，含 async 与生成器（function*）两种修饰。
  //
  // `function*` 这一档是 2026-10-11 补的：`src/utils/cjk.js` 里 `export function* cjkNames`
  // 之前不被匹配，于是 dist 里 utils/cjk.js 的 stub 少一个导出，而 utils/naming.js 正好
  // import 它——浏览器执行形态（`build:web`）整份加密核心在 materialize 时链接期报错
  // （`does not provide an export named 'cjkNames'`）。只有 `npm run verify:enc` 抓得到，
  // 而它不在 `npm test` 的清单里，所以这个洞一直没人发现；云端形态不受影响（核心不下发）。
  const declRe = /^\s*export\s+(?:async\s+)?(?:const|let|var|function|class)\s*\*?\s*([A-Za-z_$][\w$]*)/gm;
  while ((m = declRe.exec(code))) names.add(m[1]);

  return [...names].sort();
}

/** 模块是否有 default 导出。 */
export function hasDefaultExport(code) {
  return /^\s*export\s+default\b/m.test(code);
}

// ---------------------------------------------------------------------------
// stub 与引导层源码生成
// ---------------------------------------------------------------------------

/**
 * 生成明文 stub。
 *
 * 顶部 `import` 的静态性不能动（stub 自身是普通 ESM），但导出必须静态声明，
 * 所以用顶层 await 拿到命名空间后再逐个转发。项目内模块无环，顶层 await 安全。
 *
 * @param {string} id 模块 id，如 'passes/vm.js'
 * @param {string} loaderRel 从该 stub 到引导层的相对路径
 * @param {{default:boolean, names:string[]}} exports 该模块的导出形态
 */
export function renderStub(id, loaderRel, exports) {
  const lines = [];
  lines.push('import { materialize } from ' + JSON.stringify(loaderRel) + ';');
  lines.push('const __m = await materialize(' + JSON.stringify(id) + ');');
  if (exports.default) lines.push('export default __m.default;');
  for (const n of exports.names) {
    lines.push('export const ' + n + ' = __m.' + n + ';');
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 生成引导层源码。
 *
 * 密码例程用 fn.toString() 插值 —— 构建期加密与运行期解密共享同一份实现，
 * 不存在"改了一边忘了另一边"的漂移可能。
 *
 * @param {{keyWords:number[], packRel:string, moduleCount:number}} opts
 */
export function renderLoader(opts) {
  const kw = opts.keyWords.join(', ');
  return `/**
 * JsLabyrinth 核心引导层（构建期生成，明文）。
 *
 * dist/src 里受保护的模块不再有源码文本：这里是解密与物化的全部实现。
 * 载荷在本源另一侧（${opts.packRel}），密钥由构建种子派生。
 *
 * 之所以只能明文：它要在任何模块之前跑起来，没法再靠上一层的解密来隐藏；
 * 它也是唯一会被静态读到的部分，所以刻意做得又短又直。
 * 真正的边界在服务端（见 license-codec.js）。篡改载荷会被 FNV 校验拦下。
 */
const KW = [${kw}];
const PACK = ${JSON.stringify(opts.packRel)};
const MODULES = ${opts.moduleCount};

${fnv1a.toString()}

${keystream.toString()}

${xorInto.toString()}

let packPromise = null;
const cache = new Map();

function decode(buf) {
  const bytes = new Uint8Array(buf);
  xorInto(bytes, keystream(KW, bytes.length));
  const n = bytes.length - 4;
  const expected = ((bytes[n] << 24) | (bytes[n + 1] << 16) | (bytes[n + 2] << 8) | bytes[n + 3]) >>> 0;
  const body = bytes.subarray(0, n);
  if (fnv1a(body) !== expected) {
    throw new Error('JsLabyrinth: payload integrity check failed');
  }
  return JSON.parse(new TextDecoder().decode(body));
}

function loadPack() {
  if (!packPromise) {
    packPromise = (async () => {
      const res = await fetch(new URL(PACK, import.meta.url).href, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('JsLabyrinth: core pack HTTP ' + res.status);
      const pack = decode(await res.arrayBuffer());
      if (!pack || !pack.modules || Object.keys(pack.modules).length !== MODULES) {
        throw new Error('JsLabyrinth: core pack shape mismatch');
      }
      return pack.modules;
    })();
  }
  return packPromise;
}

/**
 * 解密一个模块并物化成可 import 的模块命名空间。结果按 id 缓存，
 * 同一模块在整棵依赖图里只解密、只编译一次。
 *
 * 相对说明符必须改写成本源的绝对地址：blob 模块里的 './x.js' 会以 blob URL
 * 为基准解析，那是无效地址。改写后指向的是本源上的 stub，public 模块因此也能
 * 混用（stub 与明文文件在同一个进程里互相 import）。
 */
export async function materialize(id) {
  let hit = cache.get(id);
  if (!hit) {
    hit = (async () => {
      const modules = await loadPack();
      const src = modules[id];
      if (typeof src !== 'string') {
        throw new Error('JsLabyrinth: core module not in pack: ' + id);
      }
      const base = new URL(id, import.meta.url);
      const rewritten = src.replace(
        /(\\bfrom\\s*|\\bimport\\s*\\(?\\s*)(["'])(\\.[^"']*)\\2/g,
        (all, pre, quote, spec) => pre + quote + new URL(spec, base).href + quote
      );
      const url = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }));
      try {
        return await import(/* @vite-ignore */ url);
      } finally {
        URL.revokeObjectURL(url);
      }
    })();
    cache.set(id, hit);
  }
  return hit;
}
`;
}