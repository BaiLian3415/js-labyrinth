/**
 * 选项元数据：名称、类型、范围、分组、标签。
 * CLI 与网页界面共用此表，新增选项只改这里即可。
 * kind 语义：percent(0~1)、count(≥0)、int(min/max)、enum(values/intRange)、string。
 */
import DEFAULTS from './options.js';
import PRESETS from './presets.js';
import i18n from './i18n.js';

const { LANGS } = i18n;

export const PRESET_NAMES = Object.keys(PRESETS);
export const toHyphen = (k) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
export const toCamel = (k) => k.replace(/-([a-z])/g, (m, c) => c.toUpperCase());

export const VALUE_OPTIONS = {
  seed: { kind: 'count', group: 'basic', guiHide: true, zh: '随机种子', en: 'Random seed',
    hintZh: '固定后同一份代码每次构建产物逐字节一致，便于比对与复现；留空则每次都不同。',
    hintEn: 'When set, the same input yields a byte-identical artifact on every build (reproducible). Empty randomizes per build.' },
  lang: { kind: 'enum', values: [...LANGS], group: 'basic', guiHide: true, zh: '提示语言', en: 'Message language',
    hintZh: '报错与提示的语言，不影响产物。',
    hintEn: 'Language of error and hint text; does not affect the artifact.' },
  preset: { kind: 'enum', values: PRESET_NAMES, caseInsensitive: true, group: 'basic', zh: '混淆强度预设', en: 'Strength preset', hintZh: '一键选 low/medium/high/max 四档强度。选完仍可逐项覆盖。', hintEn: 'One-click strength tier (low/medium/high/max). Individual options can still be overridden afterwards.' },
  target: { kind: 'enum', values: ['auto', 'browser', 'node', 'cloudflare-worker'], group: 'basic', zh: '目标宿主', en: 'Target runtime',
    hintZh: '产物最终跑在哪里。auto 按源码结构判断 Cloudflare Workers，认不出（有自定义写法）时手动选；判成受限宿主会强制关掉跑不了的形态并告警。',
    hintEn: 'Where the artifact finally runs. auto guesses Cloudflare Workers from the structure of the source; set it explicitly when the guess cannot work. A restricted target force-disables the shapes that cannot run there, with a warning.' },
  identifierPrefix: { kind: 'string', group: 'basic', zh: '标识符前缀', en: 'Identifier prefix', hintZh: '生成名的前缀，默认 _0x；须以字母或 _/$ 开头。', hintEn: 'Prefix for generated names, default _0x. Must start with a letter, _ or $.' },
  nameStyle: { kind: 'enum', values: ['Mangled', 'Mangled-props', 'Mangled-shuffled', 'Mangled-shuffled-props', 'Hexadecimal', 'Hexadecimal-props', 'Dictionary', 'Dictionary-props', 'Chinese', 'Chinese-props'], group: 'structure', zh: '命名策略', en: 'Naming style', hintZh: '变量与函数名策略。5 个基础档 × 带不带 `-props`（连属性名/对象键一起改，形状与标识符一致）：Mangled（a/b/c，默认）、Mangled-shuffled（字母表每次构建打乱，发布用）、Hexadecimal、Dictionary、Chinese（汉字，需按 UTF-8 提供）。`-props` 只改程序内定义且被访问的属性，与外部共享的属性会破。', hintEn: 'Naming strategy for variables and functions. Five base styles, each with or without `-props` (which also renames properties to match the identifier shape): Mangled (a/b/c, default), Mangled-shuffled (letter order reshuffled per build, use for releases), Hexadecimal, Dictionary, Chinese (requires UTF-8). `-props` only touches properties defined and accessed inside the program; properties shared with the outside world will break.' },
  chineseDictionary: { kind: 'string', group: 'structure', zh: '汉字字典', en: 'Chinese dictionary',
    // 显隐规则：只在命名策略选中 Chinese 档时这一项才被读（mangle 与
    // renameProperties 都改走汉字池），摆出来只会让人以为填了有用。规则写在
    // 元数据里而非散在界面代码中，这样 CLI 帮助、Worker API 与网页三端看到的
    // 是同一份判断。
    // 显隐规则：只在命名策略选中 Chinese 档时这一项才被读（mangle 与
    // renameProperties 都改走汉字池），摆出来只会让人以为填了有用。规则写在
    // 元数据里而非散在界面代码中，这样 CLI 帮助、Worker API 与网页三端看到的
    // 是同一份判断。
    //
    // 用 oneOf 而不是 equals：档位扩到十档后，汉字档有两个（Chinese 与
    // Chinese-props），equals 只能写一个，写死另一个就把该显示的输入框藏了。
    showWhen: { key: 'nameStyle', oneOf: ['Chinese', 'Chinese-props'] },
    // 1024 个字塞进单行输入框没法看也没法逐个校对，渲染成多行文本框。
    multiline: true,
    hintZh: 'Chinese 档的汉字表，逗号分隔；留空用内置 1024 字。发名前打乱，所以顺序只影响用到哪些字，不影响可复现性。',
    hintEn: 'Character table for the Chinese style, comma-separated. Empty uses the built-in 1024 characters. Shuffled before use, so the order only affects which characters appear, not reproducibility.' },
  nameDictionary: { kind: 'string', group: 'structure', zh: '词典词表', en: 'Dictionary words',
    // 同上：只有命名策略选中 Dictionary 档时词表才被读（含带属性名的那一档）。
    showWhen: { key: 'nameStyle', oneOf: ['Dictionary', 'Dictionary-props'] },
    // 词表常有几十个词，单行只能看到头几个。
    multiline: true,
    hintZh: 'Dictionary 档的词表，逗号分隔；留空用内置 64 词。非标识符、关键字与重复词会被丢弃，全部非法时回落到内置词表。',
    hintEn: 'Word table for the Dictionary style, comma-separated. Empty uses the built-in 64 words. Entries that are not valid identifiers, or are keywords or duplicates, are dropped; if all are invalid it falls back to the built-in table.' },
  extraGlobals: { kind: 'string', group: 'basic', zh: '宿主全局白名单', en: 'Extra host globals', hintZh: '逗号分隔的宿主全局名（如 WebSocketPair），自校验时视为已定义、不改名。', hintEn: 'Comma-separated host globals (e.g. WebSocketPair) treated as defined by the self-check and left unrenamed.' },
  reservedNames: { kind: 'string', group: 'basic', zh: '保留名（正则）', en: 'Reserved names', hintZh: '匹配的正则不改名（如 ^__webpack）。', hintEn: 'Matching patterns are left unrenamed (e.g. ^__webpack).' },
  htmle: { kind: 'bool', group: 'defense', zh: 'HTML Encrypt', en: 'HTML Encrypt', hintZh: 'Plus 及以上可用。把页面正文与属性值加密，产物只留密文与 loader，运行期还原。这是混淆不是保密：密钥与解密逻辑都在产物里。注意两点——loader 执行前页面**没有正文**，无 JS 环境与爬虫看到的是空页；href、src、integrity、nonce 这类需在 HTML 解析阶段就被浏览器读走的属性保持原样。', hintEn: 'Available from Plus up. Encrypts page text and attribute values; the artifact keeps only ciphertext plus a loader that restores the DOM at runtime. This is obfuscation, not secrecy: the key and the decryptor both ship in the artifact. Two caveats: the page has **no body** until the loader runs, so crawlers and non-JS clients see a blank page; and attributes the browser must read during HTML parsing (href, src, integrity, nonce) are left as-is.' },
  htmleKey: { kind: 'int', group: 'defense', min: 0, max: 4294967295, zh: 'HTML 加密密钥', en: 'HTML encryption key', hintZh: 'HTML 加密密钥。0 = 由随机种子决定（同种子永远同一密钥，产物可复现）；填具体数值则每次构建都用它。', hintEn: 'HTML encryption key. 0 derives it from the random seed, so the same seed always yields the same key and a reproducible artifact. An explicit value is used on every build.' },
  reservedStrings: { kind: 'string', group: 'basic', zh: '保留字符串（正则）', en: 'Reserved strings', hintZh: '匹配的正则不入池、不拆段、不编码。', hintEn: 'Matching patterns are never pooled, split or encoded.' },
  forceTransformStrings: { kind: 'string', group: 'basic', zh: '强制入池字符串（正则）', en: 'Force into pool', hintZh: '匹配的正则**强制**入池，绕过抽样阈值。密钥、URL、特征串这类不该留明文的用它（阈值是随机丢弃的，"这次恰好没进池"本身就是洞）。冲突时以本项为准。', hintEn: 'Matching patterns are forced into the pool, bypassing the sampling threshold. Use it for keys, URLs and signature strings that must not stay in plaintext (the threshold drops at random, so "it happened not to be pooled this time" is itself a hole). This option wins on conflict.' },
  moduleBase: { kind: 'string', group: 'basic', zh: 'ESM 基准地址', en: 'ESM base URL', hintZh: '产物所在目录的 URL。带相对 import 的 ESM 必填，否则 ./dep.js 之类解析不了。只对 ESM 载荷有意义。', hintEn: 'URL of the directory holding the artifact. Required for ESM with relative imports, otherwise ./dep.js cannot resolve. Only meaningful for ESM payloads.' },
  domainLock: { kind: 'string', group: 'defense', zh: '域名锁定', en: 'Domain lock', hintZh: '逗号分隔的域名白名单。example.com 精确匹配，.example.com 含任意层子域，example.com:8443 额外锁端口。留空关闭。', hintEn: 'Comma-separated domain allowlist. example.com matches exactly, .example.com matches any subdomain, example.com:8443 also locks the port. Empty disables it.' },
  domainLockRedirectUrl: { kind: 'string', group: 'defense', zh: '域名锁定重定向', en: 'Domain lock redirect', showWhen: { key: 'domainLock', notEquals: '' },
    hintZh: '非授权域时跳转到的地址（相对路径或 http/https）。只在"装载期抛错"那种降级下生效；另外两种降级走不到跳转语句。javascript: 等会执行代码的地址直接忽略。', hintEn: 'Where non-authorized domains get redirected to (relative path or http/https). Only takes effect under the throw-during-load degradation; the other two never reach the redirect. Schemes like javascript: are ignored.' },
  dirSkip: { kind: 'string', group: 'basic', guiHide: true, zh: '目录模式追加跳过', en: 'Extra skipped dirs',
    hintZh: '目录模式下额外跳过的路径，逗号分隔。用于跳过 node_modules、构建产物等不该混淆的目录。',
    hintEn: 'Extra paths to skip in directory mode, comma-separated. Use it for node_modules and build output that should not be obfuscated.' },
  indent: { kind: 'count', group: 'output', def: 2, zh: '缩进宽度', en: 'Indent width', hintZh: '缩进的空格数，仅在 compact 关掉时有效。', hintEn: 'Indentation width in spaces. Only applies when compact is off.' },
  stringArrayEncoding: { kind: 'enum', values: ['none', 'xor', 'base64', 'rc4', 'affine', 'add', 'xorrev'], group: 'strings', zh: '字符串编码方式', en: 'String encoding', hintZh: '池内字符串的编码：none / xor（异或后自动 base64）/ base64 / rc4 / affine / add / xorrev。', hintEn: 'Encoding used inside the pool: none / xor (then base64) / base64 / rc4 / affine / add / xorrev.' },
  stringArrayEvolve: { kind: 'enum', values: ['each', 'sparse'], intRange: [0, 7], group: 'strings', zh: '密文演化策略', en: 'Ciphertext evolution strategy', hintZh: 'each：每次访问都重算密文；sparse：只在值变化时重算。前者更贵但每次取值路径都不同。', hintEn: 'each recomputes the ciphertext on every access; sparse only when the value changes. The former costs more but varies the retrieval path every time.' },
  stringArrayWrappersCount: { kind: 'int', min: 0, max: 10, group: 'strings', zh: '包装层数', en: 'Wrapper layer count',
    hintZh: '在解码器外面再包几层单表达式函数（0~10，0 = 不包）。层数越多，调用点越难静态还原。',
    hintEn: 'Wraps the decoder in N single-expression wrapper functions (0~10, 0 = no wrapping). More layers make call sites harder to recover statically.' },
  stringArrayWrappersChainedCalls: { kind: 'bool', group: 'strings', zh: '链式调用', en: 'Chained calls',
    showWhen: { key: 'stringArrayWrappersCount', notEquals: 0 },
    hintZh: 'true = 调用点只出现最外层那一个函数，签名单一；false = 调用点分散在各层，产物里出现多种签名。',
    hintEn: 'true: call sites only ever show the outermost function, so the signature looks uniform. false: call sites are spread across layers, so several signatures appear in one artifact.' },
  stringArrayWrappersChainedCallsThreshold: { kind: 'int', min: 0, max: 100, group: 'strings', zh: '链式调用占比', en: 'Chained-call ratio',
    showWhen: { key: 'stringArrayWrappersChainedCalls', equals: true },
    hintZh: '链式调用开启时，走最外层的调用点百分比（0~100）。100 = 只有一种调用形态。',
    hintEn: 'When chained calls are on, the percentage of call sites routed through the outermost function (0~100). 100 = a single call shape.' },
  stringArrayThreshold: { kind: 'percent', group: 'strings', zh: '字符串收集概率', en: 'String collection rate', hintZh: '字符串进池的概率（0~1）。越高池越大、解码调用越多。', hintEn: 'Probability (0~1) that a string literal is collected into the pool. Higher means a bigger pool and more decoder calls.' },
  stringArrayDecompose: { kind: 'count', group: 'strings', zh: '字符串池分组倍率', en: 'Pool grouping multiplier', hintZh: '字符串池的分组倍率，越高池被切得越碎。', hintEn: 'Grouping factor for the string pool; higher splits the pool into more fragments.' },
  stringSplitThreshold: { kind: 'count', group: 'strings', zh: '拆段最小长度', en: 'Split minimum length', hintZh: '字符串长于该长度才拆成多段，避免把短串拆碎。', hintEn: 'Only strings longer than this are split into segments, so short strings stay whole.' },
  stringSplitProbability: { kind: 'percent', group: 'strings', zh: '拆段概率', en: 'Split probability', hintZh: '字符串被拆段的概率（0~1）。', hintEn: 'Probability (0~1) that a string is split into segments.' },
  controlFlowThreshold: { kind: 'count', group: 'flow', zh: '扁平化最小语句数', en: 'Flattening minimum statements', hintZh: '函数体语句数达到该值才做扁平化。值越大越省 CPU，小函数保持原样。', hintEn: 'Only functions with at least this many statements get flattened. Higher values save CPU and leave small functions alone.' },
  controlFlowProbability: { kind: 'percent', group: 'flow', zh: '扁平化概率', en: 'Flattening probability', hintZh: '每条可扁平化的控制流被处理的概率。', hintEn: 'Probability that each flattenable control-flow statement is processed.' },
  controlFlowDepth: { kind: 'int', min: 1, max: 8, group: 'flow', zh: '扁平化嵌套层数', en: 'Flattening depth', hintZh: '扁平化的嵌套层数（1~8）。', hintEn: 'Nesting depth of the flattening (1~8).' },
  numberObfuscationThreshold: { kind: 'percent', group: 'flow', zh: '数值常量混淆率', en: 'Number obfuscation rate', hintZh: '数值常量被混淆的比例（0~1）。', hintEn: 'Ratio (0~1) of numeric literals that get obfuscated.' },
  numberObfuscationMBA: { kind: 'bool', group: 'flow', zh: 'MBA 数值混淆', en: 'MBA number obfuscation', hintZh: '把数值改写成位运算与算术交织的 MBA 恒等式，无运行期开销；但只会按算子做局部折叠的工具会失效或算错。', hintEn: 'Rewrites numbers into MBA identities mixing bitwise and arithmetic. No runtime cost, but tools that fold by operator alone will fail or miscompute.' },
  logicalExpressionsThreshold: { kind: 'percent', group: 'flow', zh: '逻辑表达式混淆率', en: 'Logical expression rate', hintZh: '逻辑表达式被改写的比例（0~1）。', hintEn: 'Ratio (0~1) of logical expressions that get rewritten.' },
  conditionObfuscationThreshold: { kind: 'percent', group: 'flow', zh: '条件混淆率', en: 'Condition obfuscation rate', hintZh: '比较与条件表达式被混淆的比例（0~1）。', hintEn: 'Ratio (0~1) of comparisons and conditional expressions that get obfuscated.' },
  opaquePredicatesProbability: { kind: 'percent', group: 'flow', zh: '不透明谓词注入率', en: 'Opaque predicate rate', hintZh: '每个可注入点插入不透明谓词的概率。', hintEn: 'Probability of inserting an opaque predicate at each eligible point.' },
  opaquePredicatesMax: { kind: 'count', group: 'flow', zh: '不透明谓词上限', en: 'Opaque predicate max', hintZh: '单个函数里不透明谓词的数量上限。', hintEn: 'Cap on the number of opaque predicates within one function.' },
  deadCodeProbability: { kind: 'percent', group: 'flow', zh: '死代码注入率', en: 'Dead code rate', hintZh: '注入死代码的概率（0~1）。', hintEn: 'Probability (0~1) of injecting dead code.' },
  sentinelRate: { kind: 'percent', group: 'defense', zh: '哨兵注入率', en: 'Sentinel rate', hintZh: '控制流中自检哨兵点的注入密度。', hintEn: 'Density of self-check sentinels injected into control flow.' },
  integrityPoisonPoints: { kind: 'count', group: 'defense', zh: '完整性投毒点数', en: 'Integrity poison points', hintZh: '完整性校验失败时写入投毒值的点位数。', hintEn: 'Number of poison values written when the integrity check fails.' },
  debugProtectionInterval: { kind: 'count', group: 'defense', zh: '反调试检测间隔', en: 'Anti-debug interval', hintZh: '反调试自检的间隔（毫秒）。', hintEn: 'Interval between anti-debug self-checks, in milliseconds.' },
  vmStepLimit: { kind: 'int', min: 0, max: 1000000000, group: 'vm', zh: 'VM 步数上限', en: 'VM step limit',
    showWhen: { key: 'vmProtection', equals: true },
    hintZh: '单次调用最多执行的字节码指令数，超了抛错。0 = 不检查。这是有界失败路径，不是性能调优项。',
    hintEn: 'Maximum bytecode instructions per call; exceeding it throws. 0 disables the check. This is a bounded-failure guard, not a performance knob.' },
  vmLayers: { kind: 'int', min: 1, max: 2, group: 'vm', zh: 'VM 嵌套层数', en: 'VM nesting layers',
    showWhen: { key: 'vmProtection', equals: true },
    hintZh: '1 = 单层；2 = 把解释器循环本身再编译一次。嵌套的函数在 wasm 档下走 JS 路径，产物更大、运行更慢。',
    hintEn: '1 = single layer. 2 = compiles the interpreter loop itself again. Functions that need nesting take the JS path under wasm: larger artifact, slower runtime.' },
  vmMode: { kind: 'enum', values: ['global', 'comment'], group: 'vm', zh: 'VMP 目标筛选', en: 'VMP target selection', hintZh: 'global 处理全部可编译函数；comment 只处理 start/end 注释标记之间的函数。', hintEn: 'global processes every compilable function; comment processes only those between the start/end comment markers.' },
  vmCompileKey: { kind: 'string', group: 'vm', zh: '编译期密钥', en: 'Compile-time key', hintZh: '编译期密钥。填了则由「密钥 + 函数序号」派生掩码等材料，同一密钥产物可复现；留空则每次构建随机。', hintEn: 'Compile-time key. When set, masks and related material are derived from the key plus a per-function index, so the same key reproduces the artifact. Empty randomizes per build.' },
  vmRuntimeKeyGetter: { kind: 'string', group: 'vm', zh: '运行时密钥取值', en: 'Runtime key getter', hintZh: '运行期取密钥的表达式（如 window.__VM_KEY__）。产物在每个 VM 函数开头取值并重跑密钥派生；值必须等于编译期密钥，否则字节码解成垃圾。', hintEn: 'Expression that fetches the key at runtime (e.g. window.__VM_KEY__). The artifact reads it at the start of every VM function and re-derives the key material; it must equal the compile-time key or the bytecode decodes to garbage.' },
  vmThreshold: { kind: 'count', group: 'vm', zh: 'VMP 函数最小语句数', en: 'VMP minimum statements', hintZh: '函数体语句数达到该值才编译成字节码。', hintEn: 'Only functions with at least this many statements are compiled to bytecode.' },
  wasmThreshold: { kind: 'count', group: 'vm', zh: 'WASM 搬入最小字节码字数', en: 'WASM minimum bytecode words', hintZh: '只有字节码字数达到该值的函数才搬进 WASM 模块。0 = 不设限。', hintEn: 'Only functions with at least this many bytecode words move into the WASM module. 0 means no limit.' },
  rtDepth: { kind: 'int', min: 1, max: 8, group: 'vm', zh: '自定义运行时层数', en: 'Custom RT layers', hintZh: 'WASM 宿主运行时生成器的嵌套层数（1~8）。', hintEn: 'Nesting depth of the WASM host runtime generator (1~8).' },
  vmDecoyOps: { kind: 'count', group: 'vm', zh: '分发器干扰字总数', en: 'Dispatcher decoy ops', hintZh: '分发器里混入的干扰分发字总数，越多越难静态还原指令集。', hintEn: 'Total number of decoy dispatch words mixed into the dispatcher; more makes the instruction set harder to recover statically.' },
  shellDepth: { kind: 'int', min: 1, group: 'defense', zh: '外壳层数', en: 'Shell layers', hintZh: '外层保护壳的嵌套层数，越多越难剥。', hintEn: 'Nesting depth of the outer protection shell; harder to peel with more layers.' },
  shellForm: { kind: 'enum', values: ['classic', 'jsfuck', 'bytecode'], group: 'defense', zh: '外壳形态', en: 'Shell form', hintZh: 'classic = 明文引导器，可顺着读懂（默认）；jsfuck = 核心编成 JSFuck 表达式，静态不可读，每层约 +45.4 KB；bytecode = 解码链进密文字节码，外层只留通用解释器，体积与 classic 持平。', hintEn: 'classic: plain bootstrap, readable (default). jsfuck: the core becomes a JSFuck expression, unreadable statically, ≈+45.4 KB per layer. bytecode: the decode chain moves into encrypted bytecode with only a generic interpreter outside; size is on par with classic.' },
};

export const VALUE_ALIASES = { intensity: 'preset' };

export const BOOL_OPTIONS = new Set(
  Object.keys(DEFAULTS).filter((k) => typeof DEFAULTS[k] === 'boolean').concat('dirCopyOthers'),
);

export const FLAG_ALIASES = {
  vm: 'vmProtection',
  controlFlow: 'controlFlowFlattening',
  objectKeys: 'objectKeyEncoding',
  deadCode: 'deadCodeInjection',
  templateConcat: 'templateToConcat',
};

export const BOOL_BY_FLAG = new Map(
  [...BOOL_OPTIONS].map((k) => [toHyphen(k), k])
    .concat(Object.entries(FLAG_ALIASES).map(([a, target]) => [toHyphen(a), target])),
);
export const VALUE_BY_FLAG = new Map(
  Object.keys(VALUE_OPTIONS).map((k) => [toHyphen(k), k])
    .concat(Object.entries(VALUE_ALIASES).map(([a, target]) => [toHyphen(a), target])),
);

const FLAG_DISPLAY = Object.fromEntries(
  Object.entries(FLAG_ALIASES).map(([alias, key]) => [key, alias]),
);
export const flagName = (key) => '--' + toHyphen(FLAG_DISPLAY[key] || key);

export const KNOWN_OPTION_KEYS = new Set(
  [...Object.keys(DEFAULTS), ...Object.keys(VALUE_OPTIONS), ...BOOL_OPTIONS, 'preset'],
);

export const FLAG_CANDIDATES = [
  ...[...BOOL_BY_FLAG.keys()].flatMap((f) => [
    { display: `--${f}`, body: f },
    { display: `--no-${f}`, body: `no-${f}` },
  ]),
  ...[...VALUE_BY_FLAG.keys()].map((f) => ({ display: `--${f}`, body: f })),
  { display: '--intensity', body: 'intensity' },
  { display: '-o', body: 'output' },
  { display: '--output', body: 'output' },
  { display: '--config', body: 'config' },
  { display: '-h', body: 'help' },
  { display: '--help', body: 'help' },
];

const BOOL_LABELS = {
  mangle: ['标识符重命名', 'Identifier renaming'],
  esmFold: ['ESM 模块折叠', 'ESM module folding'],
  functionWrapper: ['函数包装（IIFE）', 'Function wrapper (IIFE)'],
  callProxy: ['动态调用层', 'Call proxy dispatch'],
  templateToConcat: ['模板串降级', 'Template literal lowering'],
  objectKeyEncoding: ['对象键编码', 'Object key encoding'],
  numberObfuscation: ['数值常量混淆', 'Number obfuscation'],
  controlFlowRollingKey: ['分派表滚动重键', 'Rolling dispatch re-key'],
  stringArray: ['字符串数组池', 'String array pool'],
  stringArrayRotate: ['字符串池轮换', 'String array rotation'],
  stringArrayCache: ['解码明文缓存', 'Decoded plaintext cache'],
  stringArrayMixedEncoding: ['混合编码', 'Mixed encoding per group'],
  stringIndexMask: ['索引 XOR 掩码', 'Index XOR mask'],
  stringArrayCallsTransform: ['调用点包装（旧名）', 'Callsite wrapping (legacy)'],
  stringArrayWrappersCount: ['包装层数', 'Wrapper layer count'],
  stringArrayWrappersChainedCalls: ['链式调用', 'Chained calls'],
  stringArrayWrappersChainedCallsThreshold: ['链式调用占比', 'Chained-call ratio'],
  controlFlowFlattening: ['控制流扁平化', 'Control flow flattening'],
  controlFlowLoopFlattening: ['循环扁平化', 'Loop flattening'],
  vmProtection: ['虚拟机保护（VMP）', 'Virtual machine protection'],
  wasm: ['WASM 虚拟机档', 'WASM VM tier'],
  wasmInterpreter: ['WASM 解释器内核', 'WASM interpreter core'],
  vmBytecodeEncoding: ['字节码编码', 'Bytecode encoding'],
  vmDispatchEnc: ['分发条目表加密', 'Encrypted dispatch table'],
  vmCompactDispatcher: ['紧凑分发器', 'Compact dispatcher'],
  vmJumpsEncoding: ['跳转编码', 'Jumps encoding'],
  vmStackEncoding: ['栈编码', 'Stack encoding'],
  vmWrapTopLevel: ['顶层初始化包装', 'Wrap top-level initializers'],
  vmMacroOps: ['宏指令融合', 'Macro operations'],
  vmDynOpcodes: ['动态操作码（状态化映射）', 'Dynamic opcodes (stateful mapping)'],
  vmAsyncExecutor: ['异步执行器（async/await）', 'Async executor (async/await)'],
  vmBlockDecrypt: ['字节码分块自解密', 'Per-block bytecode self-decryption'],
  vmLayers: ['多层VM（嵌套解释器）', 'Multi-layer VM (nested interpreters)'],
  stringScatter: ['字符串碎片化', 'String fragmentation'],
  antiLLM: ['Anti-LLM 防护', 'Anti-LLM protection'],
  logicalExpressions: ['逻辑表达式混淆', 'Logical expression obfuscation'],
  conditionObfuscation: ['条件表达式混淆', 'Condition obfuscation'],
  opaquePredicates: ['不透明谓词', 'Opaque predicates'],
  deadCodeInjection: ['死代码注入', 'Dead code injection'],
  honeyStrings: ['蜜罐诱饵字符串', 'Honeypot decoy strings'],
  decoyFunctions: ['语义诱饵函数', 'Decoy functions'],
  debugProtection: ['反调试', 'Anti-debugging'],
  antiCDP: ['CDP 自动化检测', 'CDP automation detection'],
  debugPoison: ['反调试投毒联动', 'Anti-debug poisoning'],
  consoleStub: ['console 中和', 'Console neutralization'],
  selfDefending: ['字符串池自防御', 'String pool self-defense'],
  envFingerprint: ['环境指纹检测', 'Environment fingerprinting'],
  integrityCheck: ['完整性校验', 'Integrity check'],
  selfCheck: ['混淆后自校验', 'Post-obfuscation self-check'],
  shell: ['外层保护壳', 'Outer protective shell'],
  compact: ['压缩输出', 'Compact output'],
  escapeNonAscii: ['非 ASCII 转义', 'Escape non-ASCII'],
  simplify: ['AST 简化（常量折叠）', 'AST simplify (constant folding)'],
  dirCopyOthers: ['复制非 JS 文件', 'Copy non-JS files'],
};

const BOOL_GROUPS = {
  mangle: 'structure', esmFold: 'structure', functionWrapper: 'structure', callProxy: 'structure',
  templateToConcat: 'structure', objectKeyEncoding: 'structure',
  stringArray: 'strings', stringArrayRotate: 'strings', stringArrayCache: 'strings',
  stringArrayMixedEncoding: 'strings', stringIndexMask: 'strings', honeyStrings: 'strings',
  stringArrayCallsTransform: 'strings',
  controlFlowFlattening: 'flow', controlFlowLoopFlattening: 'flow',
  numberObfuscation: 'flow', controlFlowRollingKey: 'flow',
  logicalExpressions: 'flow', conditionObfuscation: 'flow',
  opaquePredicates: 'flow', deadCodeInjection: 'flow', decoyFunctions: 'flow',
  vmProtection: 'vm', vmBytecodeEncoding: 'vm', wasm: 'vm', wasmInterpreter: 'vm',
  vmDispatchEnc: 'vm', vmCompactDispatcher: 'vm', vmJumpsEncoding: 'vm', vmStackEncoding: 'vm', vmWrapTopLevel: 'vm', vmMacroOps: 'vm', vmDynOpcodes: 'vm', vmAsyncExecutor: 'vm', vmBlockDecrypt: 'vm', vmLayers: 'vm',
  stringScatter: 'strings', antiLLM: 'defense',
  debugProtection: 'defense', debugPoison: 'defense', consoleStub: 'defense',
  antiCDP: 'defense',
  selfDefending: 'defense', envFingerprint: 'defense', integrityCheck: 'defense',
  selfCheck: 'defense', shell: 'defense',
  compact: 'output', escapeNonAscii: 'output', simplify: 'output',
};

/**
 * 卡片图标：24×24 线性图标的 path 数据（stroke，不填充）。
 * 内联成 path 字符串而不是引入图标库——零依赖是硬要求。
 */
export const CARD_ICONS = {
  basic: 'M4 6h16M4 12h16M4 18h16',
  structure: 'M9 4H8a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h1M15 4h1a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2h-1',
  strings: 'M8 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h2M16 4h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-2',
  flow: 'M4 6h6M14 6h6M4 18h6M14 18h6M10 6l4 12M14 6l-4 12',
  vm: 'M4 5h16v14H4zM7 9.5l3 2.5-3 2.5M13 15h4',
  defense: 'M12 3l7 3v6c0 4.2-2.9 7.3-7 9-4.1-1.7-7-4.8-7-9V6z',
  output: 'M12 4v10M8 11l4 4 4-4M5 19h14',
};

/** 布尔项的说明文案。CLI 旗标名由 flagLabel() 补进提示，不必在这里重复。 */
const BOOL_HINTS = {
  mangle: ['把局部/全局标识符改名为随机名，压缩体积并抹掉语义。', 'Renames identifiers to random names, shrinking output and erasing meaning.'],
  esmFold: ['折叠 ESM 模块结构：静态 import/export 改成动态 import 加单一出口，模块体搬进 IIFE，顶层只留 await 赋值与出口名。仅对 ESM 载荷生效。', 'Folds ESM module structure: static import/export become a dynamic import with a single exit, the module body moves into an IIFE, and only await assignments and export names stay at the top level. ESM payloads only.'],
  functionWrapper: ['把顶层语句包进 IIFE，隐藏全局变量与初始化顺序。', 'Wraps top-level statements in an IIFE, hiding globals and init order.'],
  callProxy: ['顶层函数之间的调用改经运行期重排的派发表转发，静态调用图消失。', 'Routes top-level calls through a runtime-shuffled dispatch table, erasing the static call graph.'],
  templateToConcat: ['把模板字符串降级成字符串拼接，不留下可读模板。', 'Lowers template literals into string concatenation.'],
  objectKeyEncoding: ['对象属性访问改成计算下标形态，隐藏键名。', 'Turns property access into computed-index form, hiding key names.'],
  numberObfuscation: ['把数值常量改写成等价表达式，隐藏原始数值。', 'Rewrites numeric constants into equivalent expressions.'],
  controlFlowRollingKey: ['分派表按运行期密钥滚动重排，静态表结构失效。', 'Rolls the dispatch table with a runtime key so its static layout is useless.'],
  logicalExpressions: ['用德摩根律与等价变形改写逻辑表达式。', 'Rewrites logical expressions via De Morgan and equivalent forms.'],
  conditionObfuscation: ['比较表达式在取反与方向翻转之间随机改写。', 'Randomly inverts or flips comparison expressions.'],
  opaquePredicates: ['插入恒真/恒假但静态难判定的谓词，掩护真实分支。', 'Injects predicates that are always true/false but hard to decide statically.'],
  deadCodeInjection: ['插入永不执行的死代码，干扰静态阅读与体积指纹。', 'Injects never-executed dead code to confuse reading and size fingerprints.'],
  decoyFunctions: ['注入语义诱饵函数，干扰调用图与函数体分析。', 'Injects decoy functions to confuse call-graph and body analysis.'],
  controlFlowFlattening: ['把函数体控制流压成状态机加分派循环，静态结构消失。', 'Flattens control flow into a state machine plus dispatch loop.'],
  controlFlowLoopFlattening: ['对循环体额外做扁平化。', 'Additionally flattens loop bodies.'],
  stringArray: ['把所有字符串集中到一个加密池，访问点变成解密调用。', 'Collects all strings into an encrypted pool; access sites become decode calls.'],
  stringArrayRotate: ['装载期轮换字符串池，同一份代码每次运行池布局不同。', 'Rotates the string pool at load time so its layout differs per run.'],
  stringArrayCache: ['缓存已解码明文，减少重复解密开销。', 'Caches decoded plaintext to cut repeated decryption cost.'],
  stringArrayMixedEncoding: ['不同分组用不同编码方式，破掉统一解码器指纹。', 'Uses a different encoding per group, breaking the single-decoder fingerprint.'],
  stringIndexMask: ['池下标经 XOR 掩码后使用，静态下标不再直接对应项。', 'Masks pool indices with XOR so static indices no longer map directly.'],
  stringArrayCallsTransform: ['stringArrayWrappersCount 的旧名。true 等价于包装层数随机取 2~5；新代码用 stringArrayWrappersCount。', 'Legacy name for stringArrayWrappersCount. true is equivalent to a random wrapper count of 2 to 5; use stringArrayWrappersCount in new code.'],
  stringScatter: ['把字符串碎片化分散，降低整池被一次性还原的风险。', 'Scatters strings into fragments to reduce whole-pool recovery.'],
  honeyStrings: ['混入蜜罐诱饵字符串，让静态提取的字符串清单真假难辨。', 'Mixes in honeypot strings so extracted string lists are unreliable.'],
  debugProtection: ['检测调试器与断点并周期性自检，命中即扰动执行。', 'Detects debuggers and breakpoints with periodic self-checks and reacts on hit.'],
  antiCDP: ['检测 Chrome DevTools Protocol 与自动化框架。用 Puppeteer / Playwright 做端到端测试时请关掉。', 'Detects the Chrome DevTools Protocol and automation frameworks. Turn it off when running end-to-end tests with Puppeteer or Playwright.'],
  debugPoison: ['反调试命中时联动投毒，破坏后续执行而不是只报错。', 'Poisons state on anti-debug hits instead of merely erroring.'],
  consoleStub: ['中和 console 输出，减少运行期信息泄漏。', 'Neutralizes console output to reduce runtime leaks.'],
  selfDefending: ['字符串池自防御：代码被格式化或改写即自毁。', 'String-pool self-defense: formatting or rewriting the artifact breaks it.'],
  envFingerprint: ['采集运行环境指纹，在沙箱/分析器下改变行为。', 'Fingerprints the runtime and changes behavior in analysis environments.'],
  antiLLM: ['针对 AI 代码助手的对抗性声明与干扰，降低被大模型直接读懂的概率。', 'Adds adversarial declarations aimed at AI code assistants to reduce direct LLM comprehension.'],
  selfCheck: ['混淆后重爬作用域，发现悬空引用即报错（构建期自检）。', 'Re-crawls scopes after obfuscation and fails on dangling references (build-time).'],
  shell: ['在产物外再套一层保护壳，逐层解包执行。', 'Wraps the artifact in an outer protective shell that unpacks layer by layer.'],
  compact: ['输出压缩成单行，去掉多余空白与换行。', 'Compacts output to a single line.'],
  escapeNonAscii: ['把非 ASCII 字符转成 \\uXXXX 转义。', 'Escapes non-ASCII characters as \\uXXXX.'],
  simplify: ['混淆前做常量折叠、死代码消除与声明合并，缩小 AST 与产物。', 'Constant folding, dead-code elimination and declaration merging before obfuscation.'],
  dirCopyOthers: ['目录模式下一并复制非 JS 文件到输出目录。', 'Copies non-JS files to the output directory in directory mode.'],
  vmProtection: ['把符合条件的函数体编译成自定义字节码，由注入的解释器循环执行；控制流在静态视图下消失。', 'Compiles eligible function bodies into custom bytecode run by an injected interpreter loop, so control flow disappears from the static view.'],
  vmBytecodeEncoding: ['字节码逐字加密并按调用轮换掩码。关掉则以明文整数数组存在（仅供排查），同时分块自解密与运行时密钥取值失效。', 'Encrypts each bytecode word and rotates the mask per call. Off leaves a plain integer array (troubleshooting only) and disables block self-decryption and the runtime key getter.'],
  vmDispatchEnc: ['分发字与语义动作的对应关系密文化，产物里不出现明文分发表。', 'Encrypts the dispatch word → action mapping so no plaintext table appears in the artifact.'],
  vmCompactDispatcher: ['强制直接寻址分发形态：分发字本身就是下标，无需桶表与扫描，更小更快，静态隐藏程度相同。', 'Forces direct-address dispatch where the word is the index — smaller and faster, with the same static hiding.'],
  vmJumpsEncoding: ['跳转操作数改存相对位移，dump 出解密后的字节码也只能看到相对位置。', 'Jump operands store relative deltas, so even decrypted bytecode only shows displacements.'],
  vmStackEncoding: ['操作数栈上的 32 位整数以逐函数密钥 XOR 存放；浮点、字符串、对象原样通过。', 'XORs 32-bit integers on the operand stack with a per-function key; floats, strings and objects pass through.'],
  vmWrapTopLevel: ['把顶层初始化语句搬进合成函数体，同样由 VM 执行，静态视图里不再有顶层控制流。含 ESM、顶层 this 或 CommonJS 时自动跳过。', 'Moves top-level initializers into a synthetic function body also run by the VM, so no top-level control flow remains in the static view. Skipped for ESM, top-level this and CommonJS.'],
  vmBlockDecrypt: ['字节码按块自解密，块边界逐构建随机，内存里最多一两块明文。wasmInterpreter 档下不生效。', 'Per-block bytecode self-decryption with per-build random boundaries; at most one or two blocks sit in memory as plaintext. Inert under wasmInterpreter.'],
  vmMacroOps: ['把连续的操作数装载指令融合成一条宏指令（段长 2~4），减少取指与分发次数。wasmInterpreter 档下不生效。', 'Fuses consecutive operand loads into one macro instruction (length 2 to 4), cutting fetches and dispatches. Inert under wasmInterpreter.'],
  vmDynOpcodes: ['分发字按指令位置轮换编号，同一个存储值在不同位置指向不同动作。wasmInterpreter 档下不生效。', 'Rotates dispatch numbers by instruction position, so one stored value means different actions at different spots. Inert under wasmInterpreter.'],
  vmAsyncExecutor: ['让 async 函数体也走同一套编译流程，await 由解释器原地挂起与恢复。', 'Compiles async function bodies too, with await suspending and resuming the interpreter in place.'],
  integrityCheck: ['对产物关键函数做哈希自校验，被改动即投毒。', 'Hash-checks key functions and poisons state on any modification.'],
  wasm: ['把函数体编译进 WASM 模块执行，静态视图里看不到原始逻辑。仅在宿主支持 WebAssembly 时可用；受限宿主（如 Cloudflare Workers）会自动关掉并告警。', 'Compiles function bodies into a WASM module, so the original logic is absent from the static view. Only where the host supports WebAssembly; restricted hosts such as Cloudflare Workers turn it off with a warning.'],
  wasmInterpreter: ['更强的 WASM 档：解释循环本身也编译进共享模块，JS 侧只剩桥接调用。与 wasm 同时开启时以本项为准；受限宿主下会被关掉。', 'A stronger WASM tier: the interpreter loop itself is compiled into a shared module, leaving only bridge calls on the JS side. Wins over wasm when both are set; turned off on restricted hosts.'],
};

export const OPTION_GROUPS = [
  { id: 'basic', zh: '基础', en: 'Basic' },
  { id: 'structure', zh: '结构变换', en: 'Structure' },
  { id: 'strings', zh: '字符串', en: 'Strings' },
  { id: 'flow', zh: '控制流与死代码', en: 'Control flow' },
  { id: 'vm', zh: '虚拟机与 WASM', en: 'VM & WASM' },
  { id: 'defense', zh: '防护与外壳', en: 'Protection' },
  { id: 'output', zh: '输出', en: 'Output' },
].map((g) => ({ ...g, icon: CARD_ICONS[g.id] }));

export function guiOptions() {
  const out = [];
  for (const [key, spec] of Object.entries(VALUE_OPTIONS)) {
    if (spec.guiHide) continue;
    out.push({
      key,
      kind: spec.kind,
      group: spec.group || 'basic',
      zh: spec.zh || key,
      en: spec.en || key,
      hintZh: spec.hintZh,
      hintEn: spec.hintEn,
      values: spec.values,
      intRange: spec.intRange,
      min: spec.min,
      max: spec.max,
      // 显隐规则原样传给界面，由界面按当前取值决定这一行是否显示。
      showWhen: spec.showWhen,
      // 多行文本框：词表这类长文本用单行输入框没法看（见 renderOption）。
      multiline: !!spec.multiline,
      def: DEFAULTS[key] !== undefined ? DEFAULTS[key] : (spec.def !== undefined ? spec.def : ''),
    });
  }
  for (const key of Object.keys(DEFAULTS)) {
    if (!BOOL_OPTIONS.has(key)) continue;
    // VALUE_OPTIONS 已经描述过的键不能再从这条旧路径推一条出来。
    // BOOL_OPTIONS 是「DEFAULTS 里所有布尔」的集合，所以任何一个既是布尔默认值、
    // 又登记进 VALUE_OPTIONS 的选项都会被推两遍——界面出现两个同名开关，其中一个
    // 显示原始键名、还落在 BOOL_GROUPS 的默认组（'structure'）而不是登记的组。
    // 2026-09-30 修：加 htmle 时撞上；同时消掉了 numberObfuscationMBA 的同类重复
    // （它一直显示为原始键名，此前没人当成 bug 报）。
    if (Object.prototype.hasOwnProperty.call(VALUE_OPTIONS, key)) continue;
    const labels = BOOL_LABELS[key] || [key, key];
    const hint = BOOL_HINTS[key];
    out.push({
      key,
      kind: 'bool',
      group: BOOL_GROUPS[key] || 'structure',
      zh: labels[0],
      en: labels[1],
      hintZh: hint ? hint[0] : undefined,
      hintEn: hint ? hint[1] : undefined,
      def: DEFAULTS[key],
    });
  }
  return out;
}

export default {
  PRESET_NAMES,
  VALUE_OPTIONS,
  VALUE_ALIASES,
  BOOL_OPTIONS,
  FLAG_ALIASES,
  BOOL_BY_FLAG,
  VALUE_BY_FLAG,
  KNOWN_OPTION_KEYS,
  FLAG_CANDIDATES,
  OPTION_GROUPS,
  toHyphen,
  toCamel,
  flagName,
  guiOptions,
};
