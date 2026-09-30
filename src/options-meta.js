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
  seed: { kind: 'count', group: 'basic', guiHide: true, zh: '随机种子', en: 'Random seed' },
  lang: { kind: 'enum', values: [...LANGS], group: 'basic', guiHide: true, zh: '提示语言', en: 'Message language' },
  preset: { kind: 'enum', values: PRESET_NAMES, caseInsensitive: true, group: 'basic', zh: '混淆强度预设', en: 'Strength preset', hintZh: '一键选择 low/medium/high/max 四档强度组合，选档后各项仍可单独覆盖。', hintEn: 'One-click strength tier (low/medium/high/max); individual options can still be overridden.' },
  identifierPrefix: { kind: 'string', group: 'basic', zh: '标识符前缀', en: 'Identifier prefix', hintZh: '生成名的前缀，默认 _0x，须以字母或 _/$ 开头。', hintEn: 'Prefix for generated names (default _0x); must start with a letter, _ or $.' },
  nameStyle: { kind: 'enum', values: ['Mangled', 'Mangled-shuffled', 'Hexadecimal', 'Dictionary'], group: 'structure', zh: '命名策略', en: 'Naming style', hintZh: 'Mangled 规范短名 a/b/c…（体积最小、可复现，指纹最强，默认）；Mangled-shuffled 同形状但字母表逐构建打乱（体积相当且不留字母表指纹，混淆发布用）；Hexadecimal 字母+十六进制位（一样短但完全无规律）；Dictionary 固定词表的可读名（调试友好，产物更大且词表可枚举）。四档命名与 obfuscator.io 的 identifierNamesGenerator 一致。', hintEn: 'Mangled: canonical a/b/c… short names (smallest, reproducible, strongest fingerprint; default); Mangled-shuffled: same shape with the alphabet shuffled per build (same size, no alphabet fingerprint — use this for release); Hexadecimal: letter + hex digits (as short, fully irregular); Dictionary: fixed word list (debuggable, larger and word list is enumerable). Names match obfuscator.io identifierNamesGenerator.' },
  extraGlobals: { kind: 'string', group: 'basic', zh: '宿主全局白名单', en: 'Extra host globals', hintZh: '逗号分隔的宿主全局名（如 WebSocketPair），自校验时视为已定义、不改名。', hintEn: 'Comma-separated host globals (e.g. WebSocketPair) treated as defined and left unrenamed.' },
  reservedNames: { kind: 'string', group: 'basic', zh: '保留名（正则）', en: 'Reserved names', hintZh: '逗号分隔的正则；匹配的变量/函数名不改名（如 ^__webpack）。', hintEn: 'Comma-separated regexes; matching identifiers are never renamed (e.g. ^__webpack).' },
  reservedStrings: { kind: 'string', group: 'basic', zh: '保留字符串（正则）', en: 'Reserved strings', hintZh: '逗号分隔的正则；匹配的字符串字面量不收集、不拆分、不编码。', hintEn: 'Comma-separated regexes; matching string literals are left untouched.' },
  domainLock: { kind: 'string', group: 'defense', zh: '域名锁定', en: 'Domain lock', hintZh: '逗号分隔的域名白名单：example.com 精确匹配、.example.com 含任意层子域、example.com:8443 额外锁端口；留空关闭。非授权域整池字符串乱码。', hintEn: 'Comma-separated domain allowlist: example.com exact, .example.com with subdomains, example.com:8443 also locks the port; empty disables. Unauthorized domains garble the string pool.' },
  dirSkip: { kind: 'string', group: 'basic', guiHide: true, zh: '目录模式追加跳过', en: 'Extra skipped dirs' },
  indent: { kind: 'count', group: 'output', def: 2, zh: '缩进宽度', en: 'Indent width', hintZh: '输出缩进宽度（空格数）。', hintEn: 'Output indentation width in spaces.' },
  stringArrayEncoding: { kind: 'enum', values: ['none', 'xor', 'base64', 'rc4'], group: 'strings', zh: '字符串编码方式', en: 'String encoding', hintZh: '池内字符串的编码方式：none / xor / base64 / rc4。', hintEn: 'Encoding for pooled strings: none / xor / base64 / rc4.' },
  stringArrayEvolve: { kind: 'enum', values: ['each', 'sparse'], intRange: [0, 7], group: 'strings', zh: '密文演化策略', en: 'Ciphertext evolution strategy', hintZh: '密文演化：each 每次访问重算，sparse 稀疏演化。', hintEn: 'Ciphertext evolution: each re-derives on every access, sparse evolves occasionally.' },
  stringArrayThreshold: { kind: 'percent', group: 'strings', zh: '字符串收集概率', en: 'String collection rate', hintZh: '字符串被收集进池的概率（0~1）。', hintEn: 'Probability a string literal is collected into the pool (0–1).' },
  stringArrayDecompose: { kind: 'count', group: 'strings', zh: '字符串池分组倍率', en: 'Pool grouping multiplier', hintZh: '字符串池分组倍率：越高池被切得越碎。', hintEn: 'Pool grouping multiplier: higher splits the pool into more pieces.' },
  stringSplitThreshold: { kind: 'count', group: 'strings', zh: '拆段最小长度', en: 'Split minimum length', hintZh: '长于该长度的字符串才拆段。', hintEn: 'Only strings longer than this get split into segments.' },
  stringSplitProbability: { kind: 'percent', group: 'strings', zh: '拆段概率', en: 'Split probability', hintZh: '字符串被拆段的概率（0~1）。', hintEn: 'Probability a string is split into segments (0–1).' },
  controlFlowThreshold: { kind: 'count', group: 'flow', zh: '扁平化最小语句数', en: 'Flattening minimum statements', hintZh: '函数体语句数达到该值才做扁平化。', hintEn: 'Minimum statement count before a function body is flattened.' },
  controlFlowProbability: { kind: 'percent', group: 'flow', zh: '扁平化概率', en: 'Flattening probability', hintZh: '每条可扁平化的控制流被处理的概率。', hintEn: 'Probability each flattenable control-flow region is processed.' },
  controlFlowDepth: { kind: 'int', min: 1, max: 8, group: 'flow', zh: '扁平化嵌套层数', en: 'Flattening depth', hintZh: '扁平化的嵌套层数（1~8）。', hintEn: 'Flattening depth, 1–8.' },
  numberObfuscationThreshold: { kind: 'percent', group: 'flow', zh: '数值常量混淆率', en: 'Number obfuscation rate', hintZh: '数值常量被混淆的比例（0~1）。', hintEn: 'Share of numeric constants that get obfuscated (0–1).' },
  numberObfuscationMBA: { kind: 'bool', group: 'flow', zh: 'MBA 数值混淆', en: 'MBA number obfuscation', hintZh: '把数值改写成位运算与算术交织的 MBA 恒等式（如 (x^y)+2*(x&y)），化简需先认出进位恒等式，只按算子做局部折叠的工具会失效或算错；无额外运行期开销。max 预设启用。', hintEn: 'Rewrites numbers as mixed bitwise/arithmetic MBA identities (e.g. (x^y)+2*(x&y)); reducing them requires recognising the carry identity, so operator-local folding fails or miscomputes. No extra runtime cost. Enabled in the max preset.' },
  logicalExpressionsThreshold: { kind: 'percent', group: 'flow', zh: '逻辑表达式混淆率', en: 'Logical expression rate', hintZh: '逻辑表达式被改写的比例（0~1）。', hintEn: 'Share of logical expressions rewritten (0–1).' },
  conditionObfuscationThreshold: { kind: 'percent', group: 'flow', zh: '条件混淆率', en: 'Condition obfuscation rate', hintZh: '比较/条件表达式被混淆的比例（0~1）。', hintEn: 'Share of comparison/condition expressions obfuscated (0–1).' },
  opaquePredicatesProbability: { kind: 'percent', group: 'flow', zh: '不透明谓词注入率', en: 'Opaque predicate rate', hintZh: '每个可注入点插入不透明谓词的概率。', hintEn: 'Probability of injecting an opaque predicate at each eligible site.' },
  opaquePredicatesMax: { kind: 'count', group: 'flow', zh: '不透明谓词上限', en: 'Opaque predicate max', hintZh: '单个函数里不透明谓词的数量上限。', hintEn: 'Maximum opaque predicates per function.' },
  deadCodeProbability: { kind: 'percent', group: 'flow', zh: '死代码注入率', en: 'Dead code rate', hintZh: '死代码插入的概率（0~1）。', hintEn: 'Probability of injecting dead code (0–1).' },
  sentinelRate: { kind: 'percent', group: 'defense', zh: '哨兵注入率', en: 'Sentinel rate', hintZh: '控制流中自检哨兵点的注入密度。', hintEn: 'Density of self-check sentinel points injected into control flow.' },
  integrityPoisonPoints: { kind: 'count', group: 'defense', zh: '完整性投毒点数', en: 'Integrity poison points', hintZh: '完整性校验失败时写入投毒值的点位数。', hintEn: 'Number of poisoning points written when integrity checks fail.' },
  debugProtectionInterval: { kind: 'count', group: 'defense', zh: '反调试检测间隔', en: 'Anti-debug interval', hintZh: '反调试自检的间隔。', hintEn: 'Interval between anti-debug self-checks.' },
  vmMode: { kind: 'enum', values: ['global', 'comment', 'only-string'], group: 'vm', zh: 'VMP 目标筛选', en: 'VMP target selection', hintZh: 'global 处理全部可编译函数；comment 只处理 -jsvmp- 标记的函数；only-string 只处理含字符串的函数。', hintEn: 'global: all compilable functions; comment: only -jsvmp- marked; only-string: only functions containing strings.' },
  vmModel: { kind: 'enum', values: ['auto', 'M0', 'M1', 'M2'], group: 'vm', guiHide: true, zh: '寄存器模型（测试用）', en: 'Register model (testing)' },
  vmCompileKey: { kind: 'string', group: 'vm', zh: '编译期密钥', en: 'Compile-time key', hintZh: '填了则由「密钥 + 函数序号」派生掩码、位置散列、链种子等，同一密钥产物可复现；留空则每次构建随机。', hintEn: 'When set, masks, position hashes and chain seeds are derived from key + function index (reproducible); empty randomizes them per build.' },
  vmRuntimeKeyGetter: { kind: 'string', group: 'vm', zh: '运行时密钥取值', en: 'Runtime key getter', hintZh: '运行期表达式（如 window.__VM_KEY__），产物在每个 VM 函数开头取值并重跑密钥派生；值必须等于编译期密钥，否则字节码解成垃圾。必须与编译期密钥同时设置。', hintEn: 'Runtime expression (e.g. window.__VM_KEY__) evaluated at each VM function entry to re-derive the key; the value must equal the compile-time key or the bytecode decodes to garbage. Requires the compile-time key.' },
  vmThreshold: { kind: 'count', group: 'vm', zh: 'VMP 函数最小语句数', en: 'VMP minimum statements', hintZh: '函数体语句数达到该值才编译成字节码。', hintEn: 'Minimum statements for a function body to be compiled to bytecode.' },
  wasmThreshold: { kind: 'count', group: 'vm', zh: 'WASM 搬入最小字节码字数', en: 'WASM minimum bytecode words', hintZh: '只有字节码字数达到该值的函数才搬进 WASM 模块（0 表示不设限）。', hintEn: 'Only functions whose bytecode word count reaches this value are moved into the WASM module (0 = no limit).' },
  rtDepth: { kind: 'int', min: 1, max: 8, group: 'vm', zh: '自定义运行时层数', en: 'Custom RT layers', hintZh: 'WASM 宿主运行时生成器的嵌套层数（1~8）。', hintEn: 'Nesting layers for the WASM host runtime generator (1–8).' },
  vmDecoyOps: { kind: 'count', group: 'vm', zh: '分发器干扰字总数', en: 'Dispatcher decoy ops', hintZh: '分发器里混入的干扰分发字总数，越多越难静态还原指令集。', hintEn: 'Decoy dispatch words mixed into the dispatcher; more makes static ISA recovery harder.' },
  shellDepth: { kind: 'int', min: 1, group: 'defense', zh: '外壳层数', en: 'Shell layers', hintZh: '外层保护壳的嵌套层数。', hintEn: 'Number of nested outer protective shell layers.' },
  shellForm: { kind: 'enum', values: ['classic', 'jsfuck'], group: 'defense', zh: '外壳形态', en: 'Shell form', hintZh: 'classic 明文引导器；jsfuck 把密钥流与校验核心编成纯 JSFuck 表达式，每层约多 45.4 KB。', hintEn: 'classic: plain bootstrap; jsfuck: compiles the keystream/verification core to pure JSFuck, ≈+45.4 KB per layer.' },
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
  renameProperties: ['属性名重命名', 'Property renaming'],
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
  stringArrayCallsTransform: ['调用点包装', 'Callsite wrapping'],
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
  vmRegisterVM: ['寄存器式虚拟机', 'Register-based VM'],
  vmAsyncExecutor: ['异步执行器（async/await）', 'Async executor (async/await)'],
  vmPolymorph: ['多态寄存器模型', 'Polymorphic register model'],
  vmBlockDecrypt: ['字节码分块自解密', 'Per-block bytecode self-decryption'],
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
  mangle: 'structure', renameProperties: 'structure', functionWrapper: 'structure', callProxy: 'structure',
  templateToConcat: 'structure', objectKeyEncoding: 'structure',
  stringArray: 'strings', stringArrayRotate: 'strings', stringArrayCache: 'strings',
  stringArrayMixedEncoding: 'strings', stringIndexMask: 'strings', honeyStrings: 'strings',
  stringArrayCallsTransform: 'strings',
  controlFlowFlattening: 'flow', controlFlowLoopFlattening: 'flow',
  numberObfuscation: 'flow', controlFlowRollingKey: 'flow',
  logicalExpressions: 'flow', conditionObfuscation: 'flow',
  opaquePredicates: 'flow', deadCodeInjection: 'flow', decoyFunctions: 'flow',
  vmProtection: 'vm', vmBytecodeEncoding: 'vm', wasm: 'vm', wasmInterpreter: 'vm',
  vmDispatchEnc: 'vm', vmCompactDispatcher: 'vm', vmJumpsEncoding: 'vm', vmStackEncoding: 'vm', vmWrapTopLevel: 'vm', vmMacroOps: 'vm', vmDynOpcodes: 'vm', vmRegisterVM: 'vm', vmAsyncExecutor: 'vm', vmPolymorph: 'vm', vmBlockDecrypt: 'vm',
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
  renameProperties: ['重命名程序内定义并访问的属性名（safe 模式）；与外部共享的属性可能被破坏。', 'Renames properties defined and accessed inside the program (safe mode); properties shared with external code may break.'],
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
  stringArrayCallsTransform: ['包装字符串池调用点，改变调用形态。', 'Wraps string-pool call sites to alter their shape.'],
  stringScatter: ['把字符串碎片化分散，降低整池被一次性还原的风险。', 'Scatters strings into fragments to reduce whole-pool recovery.'],
  honeyStrings: ['混入蜜罐诱饵字符串，让静态提取的字符串清单真假难辨。', 'Mixes in honeypot strings so extracted string lists are unreliable.'],
  debugProtection: ['检测调试器与断点并周期性自检，命中即扰动执行。', 'Detects debuggers and breakpoints with periodic self-checks and reacts on hit.'],
  antiCDP: ['检测 Chrome DevTools Protocol 与自动化框架；用 Puppeteer/Playwright 做端到端测试时请关掉。', 'Detects CDP and automation frameworks; turn it off for Puppeteer/Playwright E2E tests.'],
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
  vmBytecodeEncoding: ['字节码字逐字加密并按调用轮换掩码；关掉则以明文整数数组存在（仅供排查，不再构成防护），同时分块自解密与运行时密钥取值失效。', 'Encrypts each bytecode word and rotates the mask per call; off leaves a plain integer array (troubleshooting only) and disables block self-decryption and the runtime key getter.'],
  vmDispatchEnc: ['分发字与语义动作的对应关系密文化，产物里不出现明文分发表。', 'Encrypts the dispatch word → action mapping so no plaintext table appears in the artifact.'],
  vmCompactDispatcher: ['强制直接寻址分发形态：分发字本身就是下标，无需桶表与扫描，更小更快，静态隐藏程度相同。', 'Forces direct-address dispatch where the word is the index — smaller and faster, with the same static hiding.'],
  vmJumpsEncoding: ['跳转操作数改存相对位移，dump 出解密后的字节码也只能看到相对位置。', 'Jump operands store relative deltas, so even decrypted bytecode only shows displacements.'],
  vmStackEncoding: ['操作数栈上的 32 位整数以逐函数密钥 XOR 存放；浮点、字符串、对象原样通过。', 'XORs 32-bit integers on the operand stack with a per-function key; floats, strings and objects pass through.'],
  vmPolymorph: ['逐函数随机采用纯栈 / 寄存器优先 / 双栈分立三种执行结构，静态数据流模型不再统一。', 'Randomly picks one of three execution shapes per function (pure stack / register-first / dual stack).'],
  vmWrapTopLevel: ['把顶层初始化语句搬进合成函数体，同样由 VM 解释执行，静态视图里不再有顶层控制流；含 ESM、顶层 this、CommonJS 等情形自动跳过。', 'Moves top-level initializers into a synthetic function body also run by the VM, so no top-level control flow remains; ESM, top-level this and CommonJS cases are skipped.'],
  vmBlockDecrypt: ['字节码按块自解密，块边界逐构建随机，任一时刻内存里最多一两块明文。', 'Per-block bytecode self-decryption with per-build random boundaries; at most one or two blocks are plaintext at a time.'],
  vmMacroOps: ['把连续的操作数装载指令融合成一条宏指令（段长 2~4），减少取指与分发次数。', 'Fuses consecutive operand loads into one macro instruction (length 2–4), cutting fetches and dispatches.'],
  vmDynOpcodes: ['分发字按指令位置轮换编号，同一存储值在不同位置指向不同动作。', 'Rotates dispatch numbers by instruction position, so one stored value means different actions at different spots.'],
  vmRegisterVM: ['改用寄存器机指令集生成代码：操作数是显式寄存器号，值有稳定身份，栈配对式还原失效。', 'Generates register-machine bytecode with explicit register operands and stable value identities, defeating stack-pairing recovery.'],
  vmAsyncExecutor: ['让 async 函数体也走同一套编译流程，await 由解释器原地挂起与恢复。', 'Compiles async function bodies too, with await suspending and resuming the interpreter in place.'],
  integrityCheck: ['对产物关键函数做哈希自校验，被改动即投毒。', 'Hash-checks key functions and poisons state on any modification.'],
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
      def: DEFAULTS[key] !== undefined ? DEFAULTS[key] : (spec.def !== undefined ? spec.def : ''),
    });
  }
  for (const key of Object.keys(DEFAULTS)) {
    if (!BOOL_OPTIONS.has(key)) continue;
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
