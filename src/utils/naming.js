/**
 * nameStyle 的解析——「这个档位是什么名字形状」与「要不要连属性名一起改」两个判定
 * 全部收在这里，不在别处各写一遍。
 *
 * 为什么要收在一处（和 cjk.js 里 isChineseNaming 当初的理由一样）：判定有五处消费
 * ——mangle 挑标识符名池、renameProperties 挑属性名池、obfuscate 决定要不要跑
 * renameProperties、integrityCheck 重算产物哈希时要与构建期一致、options-meta 要
 * 枚举与文案。它们一旦各写一遍，早晚会漂移出「标识符是词表名、属性名却是 _0x 随机」
 * 这类自相矛盾，且产物仍能跑、只是不好看——静默失败最难查。
 *
 * 档位命名：基础档 + 可选的 `-props` 后缀。`Hexadecimal-props` = 用十六进制形状改
 * 标识符**并且**连属性名/对象键一起改。原来属性名重命名是个独立布尔项 `renameProperties`，
 * 而它的实现只对 Chinese 档认 nameStyle、其余一律发 `_0x` 随机名——也就是说选了
 * Hexadecimal 之后属性名完全不受影响，那一档对属性而言是假的。写进档位后属性名走
 * 与标识符同一个名池，选什么就是什么。
 */
import rand from './rand.js';
import { cjkNames } from './cjk.js';
const { shuffle, RESERVED, HEXD } = rand;

/** 连属性名/对象键一起改的后缀。 */
export const PROPS_SUFFIX = '-props';

/** 基础档（不带 `-props` 的那些）。顺序即界面展示顺序。 */
export const BASE_NAME_STYLES = [
  'Mangled',
  'Mangled-shuffled',
  'Hexadecimal',
  'Dictionary',
  'Chinese',
];

/** 代表「汉字命名」的那一档。与 options.js 注释、options-meta 枚举同源。 */
export const CHINESE_NAME_STYLE = 'Chinese';

// 小写索引。档位串由调用方给：网页界面的 <select> 传的是原串，API/脚本可能手抄成
// 小写或混大小写（options-meta 里虽然导出 toCamel，但仓库内没有消费方，不存在
// 「CLI 自动转驼峰」这回事）。所以匹配一律大小写不敏感。
const BASE_BY_LOWER = new Map(BASE_NAME_STYLES.map((s) => [s.toLowerCase(), s]));

/** 规范默认值：未给、给了空串、给了不认识的值时都用它。与 options.js 同源。 */
export const DEFAULT_NAME_STYLE = 'Mangled';

/** 全部合法档位 = 基础档 × {不带属性名, 带属性名}，界面与 CLI 都以这份为准。 */
export const NAME_STYLES = BASE_NAME_STYLES.flatMap(
  (base) => [base, base + PROPS_SUFFIX],
);

/**
 * 拆一个 nameStyle 字符串。
 *
 * @param {string} style 档位串，如 'Dictionary-props'
 * @returns {{base:string, props:boolean, known:boolean}}
 *   base   —— 规范大小写的基础档名（不认识时回落到 DEFAULT_NAME_STYLE）
 *   props  —— 是否连属性名一起改
 *   known  —— 输入是否是一个认识的档位（false 表示已按默认值兜底）
 */
export function parseNameStyle(style) {
  const raw = typeof style === 'string' ? style.trim() : '';
  const hasProps = raw.toLowerCase().endsWith(PROPS_SUFFIX);
  const body = hasProps ? raw.slice(0, raw.length - PROPS_SUFFIX.length).trim() : raw;
  const base = BASE_BY_LOWER.get(body.toLowerCase());
  if (!base) return { base: DEFAULT_NAME_STYLE, props: false, known: false };
  return { base, props: hasProps, known: true };
}

/**
 * 只要基础档名（调用方只想知道名池形状、不关心属性名时用）。
 * @param {string} style 档位串
 * @returns {string} 规范大小写的基础档名
 */
export function baseNameStyle(style) {
  return parseNameStyle(style).base;
}

/**
 * 是否走汉字命名池。
 *
 * 大小写不敏感、容忍 `-props` 后缀；枚举之外的旧值一律落到非中文。
 *
 * @param {object} options 已归一化的选项
 * @returns {boolean}
 */
export function isChineseNaming(options) {
  return parseNameStyle(options && options.nameStyle).base === CHINESE_NAME_STYLE;
}

// ---- 名池（标识符与属性名共用同一份实现） ----
//
// 原来这四个生成器在 passes/mangle.js 里，renameProperties 拿不到，于是它对非中文档
// 只能发 `_0x` 随机名——「选了 Hexadecimal 但属性名不是十六进制形状」就是这么来的。
// 搬到这里后两个 pass 调同一个 createNamePool，形状必然一致。

/**
 * 规范短名池（`Mangled`）。
 *
 * `a…Z$_` → `aa…` → `aaa…` 的固定顺序发名，54 个单字符起步，小文件全用单字符。
 * 关键性质：字母表不打乱，同一输入永远得到同一份名字（与 seed 无关），可逐字节
 * diff；代价是产物里必然出现 a、b、c… 的发名顺序，指纹极强。
 */
const MANGLED_ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ$_';

function* mangledNames() {
  const a1 = MANGLED_ALPHA.split('');
  const a2 = [a1, a1];
  const a3 = [a1, a1, a1];
  yield* a1;
  for (const x of a2[0]) for (const y of a2[1]) yield x + y;
  for (const x of a3[0]) for (const y of a3[1]) for (const z of a3[2]) yield x + y + z;
}

/**
 * 乱序短名池（`Mangled-shuffled`）——形状与 Mangled 完全一样，只多一条：每档字母
 * 顺序由 seed 决定。同 seed 可复现、换 seed 换一套字母，是发布档的默认选择。
 */
function* mangledShuffledNames() {
  const tier = () => shuffle(MANGLED_ALPHA.split(''));
  const a1 = tier();
  const a2 = [tier(), tier()];
  const a3 = [tier(), tier(), tier()];
  yield* a1;
  for (const x of a2[0]) for (const y of a2[1]) yield x + y;
  for (const x of a3[0]) for (const y of a3[1]) for (const z of a3[2]) yield x + y + z;
}

/**
 * 十六进制名池（`Hexadecimal`）。形状是"头一个字母 + 若干位十六进制"（a7 / f30）。
 * 从 2 字符起步而不是 1 字符：单字符起步会退回 Mangled 那种 a/b/c 序列感。
 */
const HEX_HEAD = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function* hexadecimalNames() {
  const head = shuffle(HEX_HEAD.split(''));
  const tier = () => shuffle(HEXD.split(''));
  const b1 = tier();
  const b2 = [tier(), tier()];
  const b3 = [tier(), tier(), tier()];
  for (const h of head) for (const b of b1) yield h + b;
  for (const h of head) for (const b of b2[0]) for (const c of b2[1]) yield h + b + c;
  for (const h of head) for (const b of b3[0]) for (const c of b3[1]) for (const d of b3[2]) yield h + b + c + d;
}

/** 词典档的默认 64 词表。 */
const DICTIONARY_WORDS = [
  'value', 'index', 'count', 'total', 'result', 'output', 'input', 'target',
  'source', 'buffer', 'cursor', 'offset', 'length', 'factor', 'weight', 'limit',
  'start', 'range', 'field', 'group', 'batch', 'chunk', 'block', 'entry',
  'record', 'item', 'label', 'flag', 'state', 'store', 'cache', 'queue',
  'stack', 'frame', 'node', 'leaf', 'root', 'base', 'seed', 'salt',
  'token', 'key', 'name', 'text', 'line', 'path', 'step', 'phase',
  'mode', 'level', 'depth', 'width', 'scale', 'ratio', 'delta', 'sum',
  'avg', 'temp', 'aux', 'part', 'area', 'span', 'rank', 'gap',
];

/**
 * 解析用户给的词典：逗号/空白/换行分隔，逐个校验后去重。
 *
 * 校验不能省——词表里的名字会直接写成产物里的标识符，一个不合法词就足以让产物
 * 无法解析。四条过滤：合法 JS 标识符、非关键字（rand.js 的 RESERVED）、不重复、
 * 长度 ≤64。全部被过滤光时回落到内置词表而不是交出空池：空池会让整份代码退回
 * 随机名，用户看到"我填的词一个都没用上"且没有任何提示。
 *
 * @param {string} raw 用户填的词表文本
 * @returns {string[]} 合法、不重复的词
 */
export function normalizeNameDict(raw) {
  const s = typeof raw === 'string' ? raw : '';
  if (!s.trim()) return DICTIONARY_WORDS;
  const seen = new Set();
  const out = [];
  for (const w of s.split(/[^A-Za-z0-9_$]+/)) {
    if (!w || out.length >= 256) continue;
    if (w.length > 64) continue;
    if (RESERVED.has(w)) continue;
    // 标识符合法性用正则判，不用 `new Function('var ' + w)` 实测——核心里禁止
    // 字符串代码生成（浏览器的 CSP 与不少函数运行时直接禁 eval / new Function，
    // 核心里出现就是产物在那边抛 EvalError，见 test/minify.js 的守卫与 README
    // 「核心模块图里不能有字符串代码生成」）。
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out.length ? out : DICTIONARY_WORDS;
}

function* dictionaryNames(dict) {
  const words = shuffle(normalizeNameDict(dict).slice());
  const n = words.length;
  // 无上限：走完一轮后加数字后缀继续发（word、word1、word2……），形状永远是词表形，
  // 不退回 _0x 随机名——后缀一出就是"词典档被用超了"的指纹，不如一直保持词表形状。
  // 后缀名仍经调用方的 used/RESERVED 查重（见 mangle 的 nextName），撞了顺延，
  // 永不复用（复用会撞名并改变语义）。去上限不改变前 n*64 个的发放序列，
  // 常规构建（远到不了四千个绑定）产物逐字节不变。
  let i = 0;
  for (;;) {
    yield words[i % n] + (i < n ? '' : String(Math.floor(i / n)));
    i++;
  }
}

/**
 * 基础档 → 命名池生成器。用 Map 而不是对象字面式：`POOLS['constructor']` 会命中
 * Object.prototype 上的构造函数，不是生成器。
 */
const NAME_POOLS = new Map([
  ['Mangled', mangledNames],
  ['Mangled-shuffled', mangledShuffledNames],
  ['Hexadecimal', hexadecimalNames],
  ['Dictionary', dictionaryNames],
]);

/**
 * 按选项造一个名池（每次调用给一个**新**生成器：名池是有状态的迭代器，标识符与
 * 属性名各要一条独立流，混用一条会让发放顺序互相踩）。
 *
 * Chinese 档接汉字池，取代其余四档的拉丁/十六进制/词表命名。escapeNonAscii 对
 * Chinese 档无效——生成器那侧单独放行（见 generator 的 _escapeIdent），否则默认
 * 开着的 escapeNonAscii 会把汉字写成 \uXXXX，产物里根本看不到中文。
 *
 * @param {object} options 已归一化的选项
 * @returns {Generator<string>} 名池
 */
export function createNamePool(options) {
  const { base } = parseNameStyle(options && options.nameStyle);
  if (base === CHINESE_NAME_STYLE) return cjkNames((options && options.chineseDictionary) || '');
  const gen = NAME_POOLS.get(base) || NAME_POOLS.get(DEFAULT_NAME_STYLE);
  // 词典档接用户自定义词表；其余三档的生成器不收参数，多传一个也无副作用，但显式
  // 只在 Dictionary 档传，免得"参数被静默吞掉"这类漂移看不出来。
  return gen(base === 'Dictionary' ? ((options && options.nameDictionary) || '') : undefined);
}

/**
 * 本档是否要连属性名/对象键一起改名。renameProperties pass 与 obfuscate 的调度
 * 都读这里，所以「勾了档位就跑」与「没勾就一个属性都不动」只有一个判定来源。
 *
 * @param {object} options 已归一化的选项
 * @returns {boolean}
 */
export function wantsPropertyRename(options) {
  return parseNameStyle(options && options.nameStyle).props;
}