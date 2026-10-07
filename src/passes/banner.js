/**
 * 引导层（原「文件头横幅」，2026-09-30 去掉注释）。
 *
 * 它做两件事：
 *   1) 写入字符串池的健康载体：`global[<随机名>] = (OK - Q + (盐 - 期望盐))|0`，
 *      未被改动时偏移恒为 0；integrityCheck 之后只做增量累加，域名锁定按 +Q 补回。
 *      删掉引导 → 载体没人写 → 池读取端算出 -OK → 整池字符串静默乱码。
 *   2) 产生盐（saltVar），外壳层把它运行期取值异或进载荷密钥流
 *      （见 shell.makeShellLayer）；盐不对或 saltVar 缺失，载荷就解不开。
 *
 * 与改造前的差别：不再往产物里写 `/*! … *␀/` 文件头注释。原设计把注释正文当比对
 * 锚点（注释被删/被改 → 盐错位 → 载荷失效），但那条"锚点"完全可以换成引导内部的
 * 随机字面量：盐 = fnv32(字面量) 在构建期算一次写进引导，运行期由引导自己重算，
 * 编辑那个字面量 → 盐变 → 外壳密钥流错位、健康载体偏移非零。删掉整段引导同样坏
 * （saltVar 未定义 + 载体缺失），"不可删除"这条性质反而更直接，不再依赖一行注释。
 *
 * 另一处简化：去掉"尽力腿"（读 document.currentScript / __filename 核对文件头）。
 * 它只在能拿到自身文件文本时生效，而且在 Node 下会给测试前置一行代码就自毁；注释
 * 没了之后它要核对的锚点也一起没了。
 *
 * 生成物不进流水线二次混淆（会被 AST 重生成打乱），但常量、字面量、段划分与标识符
 * 逐次随机，两次混淆得到的引导代码不同。
 */
import rand from '../utils/rand.js';
const { randInt, randHex } = rand;
import shell from './shell.js';

/**
 * 逐次随机化引导代码里的固定标识符。
 * 两条硬约束：
 *   1) 字符串字面量必须先摘出去：段载荷是 base64，短名（mix/lcg 等）会出现在
 *      编码数据内部，直接全文替换会改坏载荷、让校验尾失配；
 *   2) 必须"最长优先 + 词边界 + 单次扫描"：短名是长名的前缀（_0e 与 _0en、
 *      _0a 与 _0acc、_0c 与 _0c2），逐个 split/join 会把长名切成半截，
 *      产物里出现未定义引用（实测把逻辑表达式用例打崩）。
 * 同一原名必须映射到同一新名，否则声明与引用会对不上。
 */
function randomizeNames(src, used, prefix) {
  const lits = [];
  const masked = src.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, (m) => {
    lits.push(m);
    return '\u0001' + (lits.length - 1) + '\u0001';
  });
  const names = [
    '_0s1', '_0s2', '_0s3', '_0S', '_0L', '_0N', '_0P1', '_0P2', '_0CK', '_0HB',
    '_0SG', '_0g', '_0a', '_0i', '_0j', '_0t', '_0e', '_0d', '_0r', '_0n', '_0acc',
    '_0pc', '_0bd2', '_0j2', '_0sg', '_0q2', '_0c', '_0c2', '_0q', '_0u', '_0pv',
    '_0h', '_0t2', '_0kb', '_0v', '_0bd', '_0u2', '_0lim', '_0s2', '_0p', '_0y',
    '_0st', '_0en', '_0m2', '_0sb',
    // 分段解码助手（decStyle=1/2）自带的固定名，同样逐构建随机化，不留字面量指纹
    '_0ds', '_0s', '_0o', '_0da', '_0dp', '_0dc', '_0de', '_0dk', '_0dv', '_0dr', '_0ch',
    'mul32', 'lcg', 'xs32', 'shfl', 'ipos', 'mix',
  ];
  const mapa = new Map();
  const re = new RegExp('\\b(?:' + names.slice().sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'g');
  const out = masked.replace(re, (m) => {
    let fresh = mapa.get(m);
    if (fresh === undefined) {
      fresh = rand.uniqueName(used, prefix);
      mapa.set(m, fresh);
    }
    return fresh;
  });
  return out.replace(/\u0001(\d+)\u0001/g, (m, i) => lits[Number(i)]);
}

/** FNV-1a 32 位字符串散列，构建期与运行期同一实现。 */
export function fnv32(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0) >>> 0;
  }
  return h >>> 0;
}

/**
 * FNV-1a 32 的等价写法库，注入时随机挑一种（见 guardSource）。
 *
 * 每种给出 emit(L, H, K)：L 字面量名、H 累加器名、K 循环变量名，产出引导里那几行。
 * 所有写法都严格等价于 fnv32。
 *
 * 这里要分清两件事，否则会走错方向：
 *
 * **循环形态**（for / while、`<` 还是 `!==`、步进 `++` 还是 `|0`）可以随便换，
 * 那是写法差异。
 *
 * **两个常量不能换值**。16777619（FNV-1a 的素数）与 2166136261（offset basis）
 * 是算法的规范参数：换了就不再是 FNV-1a，`fnv32()` 与注入写法之间的一致性断言
 * 也会当场失败。所以这里只给它们换**字面量形态**——同一个数的十进制、十六进制、
 * 移位或表达式写法：
 *
 *   素数 16777619 = 0x01000193 = (1<<24)|0x193
 *   基数 2166136261 = 0x811c9dc5
 *
 * 任何一族写错（写出的值不等于规范值）都会让盐对不上，构建期算的 clean 与运行期
 * 重算的结果不等，干净产物会被**自己的引导投毒**——而且是静默的，所以
 * test/guide-fnv.js 必须逐族跑真代码验证，不能只比对字符串。
 *
 * 循环形态不能图省事用 do-while：do-while 至少执行一次，空串会读到
 * charCodeAt(0)=NaN，算出的盐与 offset basis 对不上。实测踩过（见
 * test/anti-analysis.js 的引导等价性断言）。
 */
const FNV_FORMS = [
  {
    id: 'for-hex',
    emit: (L, H, K) => [
      '  var ' + H + '=0x811c9dc5>>>0;',
      '  for(var ' + K + '=0;' + K + '<' + L + '.length;' + K + '++){',
      '    ' + H + '=(Math.imul(' + H + '^' + L + '.charCodeAt(' + K + '),((1<<24)|0x193))>>>0)>>>0;',
      '  }',
    ],
  },
  {
    id: 'while-dec',
    emit: (L, H, K) => [
      '  var ' + H + '=2166136261>>>0;',
      '  var ' + K + '=0;',
      '  while(' + K + '<' + L + '.length){',
      '    ' + H + '=(Math.imul(' + H + '^' + L + '.charCodeAt(' + K + '),0x01000193)>>>0)>>>0;',
      '    ' + K + '=(' + K + '+1)|0;',
      '  }',
    ],
  },
  {
    id: 'while-ne',
    emit: (L, H, K) => [
      '  var ' + H + '=(0x811c9dc5|0)>>>0;',
      '  var ' + K + '=0;',
      '  while(' + K + '!==' + L + '.length){',
      '    ' + H + '=(Math.imul(' + H + '^' + L + '.charCodeAt(' + K + '),0x01000193)>>>0)>>>0;',
      '    ' + K + '=(' + K + '+1)|0;',
      '  }',
    ],
  },
  // 以下三族把两个常量都换成另一种**同值**写法。循环形态也一并换掉，
  // 让"扫 16777619 / 0x811c9dc5 字面量"这招在这三族上彻底落空。
  {
    id: 'for-shift',
    emit: (L, H, K) => [
      '  var ' + H + '=2166136261>>>0;',
      '  for(var ' + K + '=0;' + K + '<' + L + '.length;' + K + '++){',
      '    ' + H + '=(Math.imul(' + H + '^' + L + '.charCodeAt(' + K + '),((1<<24)|0x193))>>>0)>>>0;',
      '  }',
    ],
  },
  {
    id: 'while-ne-hex',
    emit: (L, H, K) => [
      '  var ' + H + '=0x811c9dc5>>>0;',
      '  var ' + K + '=0;',
      '  while(' + K + '!==' + L + '.length){',
      '    ' + H + '=(Math.imul(' + H + '^' + L + '.charCodeAt(' + K + '),0x01000193)>>>0)>>>0;',
      '    ' + K + '=(' + K + '+1)|0;',
      '  }',
    ],
  },
  {
    id: 'for-hex-shift',
    emit: (L, H, K) => [
      '  var ' + H + '=(2166136261|0)>>>0;',
      '  for(var ' + K + '=0;' + K + '<' + L + '.length;' + K + '++){',
      '    ' + H + '=(Math.imul(' + H + '^' + L + '.charCodeAt(' + K + '),0x01000193)>>>0)>>>0;',
      '  }',
    ],
  },
];

// 导出来给测试直接验等价性：测试必须跑真正注入的那份写法，而不是抄一份——
// 抄的那份会与源码漂移，漂移了就等于没测。
export { FNV_FORMS };

/** 全局对象引用链，与 shell/stringArray 用的是同一套探测串。 */
function globalRef() {
  return '(typeof globalThis!=="undefined"?globalThis:typeof self!=="undefined"?self:typeof window!=="undefined"?window:typeof global!=="undefined"?global:{})';
}

/**
 * 保留名单的明文清单。
 *
 * 为什么要它：外壳把载荷当字节流加密，产物文本里再没有任何用户代码。用户按
 * reservedNames/reservedStrings 的约定 grep 产物做对接与核对，命中不了——这正是
 * 2026-09-29 那次「名单非空就整个关掉外壳」要解决的问题。关外壳是拆东墙补西墙：
 * 防护没了，名单也只是「不改名」，并不在产物里可见。
 *
 * 现在的取舍：外壳照套（全量加密，防护不降），名单项在壳外另留一份明文清单。清单
 * 里的每一项都取自 AST 中真实存在、且确实未被改写的名字/字面量，所以 grep 到的
 * 就是产物运行时会用的那个，不是另抄一份给用户看的旁证。
 *
 * 清单是死数据（不参与任何执行），但它进盐互锁：删改清单，引导层算出的盐就与外壳
 * 密钥流对不上，载荷解不开。
 *
 * @param {object} opts { keepNames, keepStrings }
 * @returns {string} 清单源码；名单为空时返回空串
 */
function keepManifest(opts) {
  const items = (opts.keepNames || []).concat(opts.keepStrings || []);
  if (items.length === 0) return '';
  const list = items.map((s) => JSON.stringify(s)).join(',');
  return '(function(){var G=' + globalRef() + ';try{Object.defineProperty(G,"__jsl_keep",' +
    '{configurable:false,enumerable:false,writable:false,value:Object.freeze([' +
    list + '])});}catch(e){}})();\n';
}

/**
 * 生成引导源码，返回 `{ code, salt, saltVar, nonce }`。
 *
 * @param {object} opts { couple, poisonKey, shellForm, ctx, privateVar }
 *   couple：ctx.couple（健康载体名 + 健康常量 + 域名锁定的 Q），为空时只产生盐
 *   privateVar：把 saltVar 收进引导自带的 IIFE，产物顶层不留裸 var。
 *               只有外层没有外壳时才允许，见 guardLayer 对 wrap 的处理。
 * @returns {{code:string, salt:number, saltVar:string, nonce:string}}
 */
export function guardSource(opts) {
  const ctx = opts.ctx || { usedNames: new Set(), identifierPrefix: '_0x' };
  // 标识符里的非 ASCII 要在这里自己转成 \uXXXX。生成器那边的 escapeNonAscii 管不到
  // 引导层：引导是**直接拼进产物的原始文本**，不经过 AST（见 guardLayer 的注释
  // 「前插的是已生成的源码字符串、不经过 AST」）。少了这一步，rand.uniqueName 摇出来
  // 的汉字名（约占三成，见该函数的命名族配比）会原样落进产物，同时违反两件事：
  // 用户选的 nameStyle（要 Mangled/Hexadecimal 却拿到汉字）与 escapeNonAscii 的承诺；
  // 还会留下「只有本工具会产出汉字标识符」这种极强的工具指纹（2026-10-03 修）。
  const escapeId = (name) => (ctx.options && ctx.options.escapeNonAscii
    ? name.replace(/[^\x00-\x7F]/g,
      (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
    : name);
  const uk = () => escapeId(rand.uniqueName(ctx.usedNames, ctx.identifierPrefix || '_0x'));
  const saltVar = uk();
  const nFn = uk();
  const nLit = uk();
  const nH = uk();
  const nK = uk();
  // 随机字面量就是比对锚点：盐由它在运行期重算，与构建期写下的 clean 比对。
  const nonce = 'jr' + randHex(16) + randInt(0x1000, 0xffff).toString(36);
  // 每次构建换一种等价写法（见 FNV_FORMS）。clean 仍由 canonical fnv32 算——三种写法
  // 与它逐位相等，所以引导运行期重算出来的值必须等于它，对不上就是产物被改过。
  const fnvForm = FNV_FORMS[randInt(0, FNV_FORMS.length - 1)];
  const clean = fnv32(nonce);
  const lines = [];
  const P = (s) => lines.push(s);
  // 私有模式：整个引导（连同 saltVar）塞进一个 IIFE，产物顶层不留任何裸 var。
  // 不私有时保持原样——外壳层要在全局作用域读 saltVar（shell.js 的 `(saltVar|0)`），
  // 收进函数里它就成了 undefined，载荷解不开。
  if (opts.privateVar) P('(function(){');
  P('var ' + saltVar + '=(function ' + nFn + '(){');
  P('  var ' + nLit + '=' + JSON.stringify(nonce) + ';');
  for (const line of fnvForm.emit(nLit, nH, nK)) P(line);
  if (opts.couple) {
    // 绝对健康值。域名锁定的 Q 在授权域由它自己的引导补回：这里的 okBase 先减掉 Q，
    // 未授权域补进的是宿主散列折叠值 J≠Q，读取端偏移非零 → 整池乱码。
    const cref = globalRef() + '["' + opts.couple.name + '"]';
    const okBase = ((opts.couple.ok - (opts.couple.q || 0)) >>> 0);
    P('  ' + cref + '=((0x' + okBase.toString(16) + '+(' + nH + '-0x' + (clean >>> 0).toString(16) + '))|0);');
  }
  if (opts.poisonKey) {
    // 字面量被改动 → 盐错位：无外壳时没有 key stream 兜底，这里补一个显式信号，
    // 让字符串池的毒药链把输出打坏（有外壳时载荷本身已经解不开）。
    P('  if(' + nH + '!==0x' + (clean >>> 0).toString(16) + '){');
    P('    try{' + globalRef() + '[' + JSON.stringify(opts.poisonKey) + ']=1;}catch(e){}');
    P('  }');
  }
  P('  return ' + nH + ';');
  P('})();');
  // 私有模式的收尾。引导已经算完盐并写完健康载体，这里丢弃返回值即可——privateVar
  // 只在无外壳时开启（见 guardLayer），此时没有外壳层再读全局的 saltVar。
  if (opts.privateVar) P('})();');
  return { code: lines.join('\n'), salt: clean, saltVar, nonce };
}

/**
 * 给最终产物套上引导层。返回值里的 code 已含引导与（可选）外壳层。
 *
 * @param {string} code 已完成全部变换的产物源码（不含 shebang）
 * @param {object} opts { cjs, esm, poisonKey, shellForm, ctx, keepNames, keepStrings }
 * @returns {{code:string, salt:number, saltVar:string, wrapped:boolean, nonce:string}}
 */
export function guardLayer(code, opts) {
  const ctx = opts.ctx || { usedNames: new Set(), identifierPrefix: '_0x' };
  const noShell = opts.wrap === false;
  // privateVar 只在无外壳时开启：有外壳时 shell.js 会在全局作用域读 `(saltVar|0)`，
  // 把引导收进 IIFE 会让它变 undefined、载荷解不开。无外壳时没人读它，可以私有化。
  const g = guardSource({ couple: ctx.couple || null, poisonKey: opts.poisonKey, ctx, privateVar: noShell });
  // 保留名单的明文清单放在最外层：载荷被整段加密后，产物里唯一还能 grep 到的
  // 就是这份清单。见 keepManifest 的注释。
  const manifest = keepManifest(opts);
  if (noShell) {
    // 用户显式关掉外壳：不套 eval 层，引导仍注入（健康载体与盐照常）
    return {
      code: manifest + g.code + '\n' + code,
      salt: g.salt, saltVar: g.saltVar, wrapped: false, nonce: g.nonce,
    };
  }
  const mode = { cjs: !opts.esm && !!opts.cjs, esm: !!opts.esm, saltVar: g.saltVar, salt: g.salt };
  let pre = '';
  if (opts.shellForm === 'jsfuck') {
    // 与 shellWrap 同一套：核心预置不进流水线（引导层本来就不进），名字先注册
    // 进 usedNames，后面的 randomizeNames 才不会撞上它。
    mode.jsfuck = true;
    mode.jsfuckName = shell.jsfuckCoreName(ctx.usedNames, ctx.identifierPrefix || '_0x');
    pre = shell.jsfuckPrelude(mode.jsfuckName);
  }
  const layer = shell.makeShellLayer(code, undefined, mode);
  const randomized = randomizeNames(layer, ctx.usedNames, ctx.identifierPrefix || '_0x');
  return {
    code: manifest + g.code + '\n' + pre + randomized,
    salt: g.salt, saltVar: g.saltVar, wrapped: true, nonce: g.nonce,
  };
}

export default { fnv32, guardSource, guardLayer };