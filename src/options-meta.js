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
  preset: { kind: 'enum', values: PRESET_NAMES, caseInsensitive: true, group: 'basic', zh: '混淆强度预设', en: 'Strength preset' },
  identifierPrefix: { kind: 'string', group: 'basic', zh: '标识符前缀', en: 'Identifier prefix' },
  nameStyle: { kind: 'enum', values: ['random', 'short'], group: 'structure', zh: '命名策略', en: 'Naming style', hintZh: 'short：minifier 式短名（长度递增、字母逐构建打乱、按引用次数分配），体积优先；random：随机混族长名，防指纹优先（默认）', hintEn: 'short: minifier-style short names (shortest first, shuffled per build, assigned by reference count) for size; random: mixed-family long names to defeat fingerprinting (default)' },
  extraGlobals: { kind: 'string', group: 'basic', zh: '宿主全局白名单', en: 'Extra host globals', hintZh: '逗号分隔，如 WebSocketPair', hintEn: 'comma separated, e.g. WebSocketPair' },
  reservedNames: { kind: 'string', group: 'basic', zh: '保留名（正则）', en: 'Reserved names', hintZh: '逗号分隔的正则；匹配的变量/函数名不改名，如 ^__webpack, ^process$', hintEn: 'comma separated regex; matching identifiers are not renamed, e.g. ^__webpack, ^process$' },
  reservedStrings: { kind: 'string', group: 'basic', zh: '保留字符串（正则）', en: 'Reserved strings', hintZh: '逗号分隔的正则；匹配的字符串字面量不收集/不拆分/不编码', hintEn: 'comma separated regex; matching string literals are left untouched' },
  domainLock: { kind: 'string', group: 'defense', zh: '域名锁定', en: 'Domain lock', hintZh: '逗号分隔的域名白名单；example.com 精确匹配，.example.com 含任意层子域，example.com:8443 额外锁端口；留空关闭。非授权域整池字符串乱码，锁定与解密密钥耦合', hintEn: 'comma separated; example.com exact, .example.com with subdomains, example.com:8443 locks port; empty disables. Key-coupled: unauthorized domains garble the whole string pool' },
  bannerText: { kind: 'string', group: 'basic', zh: '自定义文件头注释', en: 'Custom header banner', hintZh: '付费档可自定义；留空写默认署名与反 LLM 声明', hintEn: 'paid tiers; empty writes the default notice' },
  dirSkip: { kind: 'string', group: 'basic', guiHide: true, zh: '目录模式追加跳过', en: 'Extra skipped dirs' },
  indent: { kind: 'count', group: 'output', def: 2, zh: '缩进宽度', en: 'Indent width' },
  stringArrayEncoding: { kind: 'enum', values: ['none', 'xor', 'base64', 'rc4'], group: 'strings', zh: '字符串编码方式', en: 'String encoding' },
  stringArrayEvolve: { kind: 'enum', values: ['each', 'sparse'], intRange: [0, 7], group: 'strings', zh: '密文演化策略', en: 'Ciphertext evolution strategy' },
  stringArrayThreshold: { kind: 'percent', group: 'strings', zh: '字符串收集概率', en: 'String collection rate' },
  stringArrayDecompose: { kind: 'count', group: 'strings', zh: '字符串池分组倍率', en: 'Pool grouping multiplier' },
  stringSplitThreshold: { kind: 'count', group: 'strings', zh: '拆段最小长度', en: 'Split minimum length' },
  stringSplitProbability: { kind: 'percent', group: 'strings', zh: '拆段概率', en: 'Split probability' },
  controlFlowThreshold: { kind: 'count', group: 'flow', zh: '扁平化最小语句数', en: 'Flattening minimum statements' },
  controlFlowProbability: { kind: 'percent', group: 'flow', zh: '扁平化概率', en: 'Flattening probability' },
  controlFlowDepth: { kind: 'int', min: 1, max: 8, group: 'flow', zh: '扁平化嵌套层数', en: 'Flattening depth' },
  numberObfuscationThreshold: { kind: 'percent', group: 'flow', zh: '数值常量混淆率', en: 'Number obfuscation rate' },
  logicalExpressionsThreshold: { kind: 'percent', group: 'flow', zh: '逻辑表达式混淆率', en: 'Logical expression rate' },
  conditionObfuscationThreshold: { kind: 'percent', group: 'flow', zh: '条件混淆率', en: 'Condition obfuscation rate' },
  opaquePredicatesProbability: { kind: 'percent', group: 'flow', zh: '不透明谓词注入率', en: 'Opaque predicate rate' },
  opaquePredicatesMax: { kind: 'count', group: 'flow', zh: '不透明谓词上限', en: 'Opaque predicate max' },
  deadCodeProbability: { kind: 'percent', group: 'flow', zh: '死代码注入率', en: 'Dead code rate' },
  sentinelRate: { kind: 'percent', group: 'defense', zh: '哨兵注入率', en: 'Sentinel rate' },
  integrityPoisonPoints: { kind: 'count', group: 'defense', zh: '完整性投毒点数', en: 'Integrity poison points' },
  debugProtectionInterval: { kind: 'count', group: 'defense', zh: '反调试检测间隔', en: 'Anti-debug interval' },
  vmMode: { kind: 'enum', values: ['global', 'comment', 'only-string'], group: 'vm', zh: 'VMP 目标筛选', en: 'VMP target selection' },
  vmModel: { kind: 'enum', values: ['auto', 'M0', 'M1', 'M2'], group: 'vm', guiHide: true, zh: '寄存器模型（测试用）', en: 'Register model (testing)' },
  vmCompileKey: { kind: 'string', group: 'vm', zh: '编译期密钥', en: 'Compile-time key', hintZh: '留空则 VM 的密钥材料每次构建随机。填了就由「密钥 + 函数序号」哈希派生掩码、位置散列、轮换函数、字符串表散列、分发仿射常数、链种子与分块密钥：同一密钥每次构建产物可复现，且没有密钥就复现不出掩码，字节码字的解密式凑不出来', hintEn: 'Empty randomizes VM key material per build. When set, the mask, position hash, rotation function, string-table hash, dispatch affine constants, chain seed and block keys are derived from key + function index: the same key reproduces the build, and without the key the mask cannot be reproduced so bytecode words cannot be decoded' },
  vmRuntimeKeyGetter: { kind: 'string', group: 'vm', zh: '运行时密钥取值', en: 'Runtime key getter', hintZh: '运行期表达式（如 window.__VM_KEY__）。产物在每个 VM 函数开头求值它，用取回的值重跑一遍密钥派生。取回的值必须等于编译期密钥，否则字节码解成垃圾、函数崩掉。必须与编译期密钥同时设置；宿主不提供该密钥时产物无法运行。WASM 解释器内核档忽略本项', hintEn: 'A runtime expression (e.g. window.__VM_KEY__). Each VM-compiled function evaluates it and re-runs the key derivation from the returned value. The value must equal the compile-time key, otherwise the bytecode decodes to garbage and the function breaks. Requires the compile-time key; the artifact will not run unless the host provides it. Ignored by the WASM interpreter tier' },
  vmThreshold: { kind: 'count', group: 'vm', zh: 'VMP 函数最小语句数', en: 'VMP minimum statements' },
  vmDecoyOps: { kind: 'count', group: 'vm', zh: '分发器干扰字总数', en: 'Dispatcher decoy ops' },
  wasmThreshold: { kind: 'count', group: 'vm', zh: 'WASM 搬入最小字节码字数', en: 'WASM minimum bytecode words' },
  rtDepth: { kind: 'int', min: 1, max: 8, group: 'vm', zh: '自定义运行时层数', en: 'Custom RT layers' },
  shellDepth: { kind: 'int', min: 1, group: 'defense', zh: '外壳层数', en: 'Shell layers' },
  shellForm: { kind: 'enum', values: ['classic', 'jsfuck'], group: 'defense', zh: '外壳形态', en: 'Shell form', hintZh: 'jsfuck：把密钥流生成与校验那段核心编成纯 JSFuck 表达式（只由 [ ] ( ) ! + { } 构成），每层固定多约 45.4 KB', hintEn: 'jsfuck: keystream/verification core compiled to pure JSFuck ([ ] ( ) ! + { } only), ≈ +45.4 KB per layer' },
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
  vmBytecodeEncoding: ['字节码编码', 'Bytecode encoding'],
  vmDispatchEnc: ['分发条目表加密', 'Encrypted dispatch table'],
  vmCompactDispatcher: ['紧凑分发器', 'Compact dispatcher'],
  vmJumpsEncoding: ['跳转编码', 'Jumps encoding'],
  vmStackEncoding: ['栈编码', 'Stack encoding'],
  vmPolymorph: ['多态寄存器模型', 'Polymorphic register model'],
  vmBlockDecrypt: ['字节码分块自解密', 'Per-block bytecode self-decryption'],
  wasmInterpreter: ['WASM 解释器内核', 'WASM interpreter core'],
  stringScatter: ['字符串碎片化', 'String fragmentation'],
  antiLLM: ['Anti-LLM 防护', 'Anti-LLM protection'],
  wasm: ['WASM 虚拟机档', 'WASM VM tier'],
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
  vmProtection: 'vm', vmBytecodeEncoding: 'vm', wasm: 'vm',
  vmDispatchEnc: 'vm', vmCompactDispatcher: 'vm', vmJumpsEncoding: 'vm', vmStackEncoding: 'vm', vmPolymorph: 'vm', vmBlockDecrypt: 'vm',
  wasmInterpreter: 'vm', stringScatter: 'strings', antiLLM: 'defense',
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

/**
 * 选项徽章。**只标真实状态**，不做装饰性标签：
 *   experimental —— 默认关、属于后期引入的高级项（P3/P4 那几项）
 *   recommended  —— 当前默认预设里就是开的，属于"建议保持"
 * 没在这里出现的选项不显示徽章。
 */
export const OPTION_BADGES = {
  vmPolymorph: 'experimental',
  vmBlockDecrypt: 'experimental',
  wasmInterpreter: 'experimental',
  simplify: 'experimental',
  vmBytecodeEncoding: 'recommended',
  stringArrayEncoding: 'recommended',
  stringArrayThreshold: 'recommended',
  controlFlowFlattening: 'recommended',
  vmProtection: 'recommended',
  domainLock: 'recommended',
  integrityCheck: 'recommended',
};

/** 布尔项的说明文案。CLI 旗标名由 flagLabel() 补进提示，不必在这里重复。 */
const BOOL_HINTS = {
  vmProtection: ['把符合条件的函数体编译成自定义字节码，由注入的解释器循环执行；控制流在静态视图下消失', 'Compiles eligible function bodies into custom bytecode run by an injected interpreter loop; control flow disappears from the static view'],
  vmBytecodeEncoding: ['字节码字按「值 ^ 位置散列 ^ 掩码 ^ 链值 ^ 块密钥」逐字加密，取指做同一逆运算，并在每次调用入口整体重写；关掉后字节码以明文整数数组存在，仅供排查问题。关掉会让分块自解密与运行时密钥取值失效（前者无密文可分层，后者无掩码可守门），编译期密钥仍会派生字符串表与分发常数、但不再构成门禁', 'Each bytecode word is stored as value ^ position-hash ^ mask ^ chain ^ block-key with the fetch inverting it, and the whole array is rewritten at every call entry; turning it off leaves a plain integer array, for troubleshooting only. It disables block self-decryption (nothing left to layer) and the runtime key getter (no mask left to gate); the compile-time key still diversifies the string table and dispatch constants but no longer acts as a gate'],
  vmDispatchEnc: ['分发条目表密文化：分发字与语义动作的对应关系不以明文出现在产物里', 'Encrypts the dispatch table: the mapping from dispatch word to semantic action never appears in plaintext'],
  vmCompactDispatcher: ['强制走直接寻址形态：分发字本身就是下标（字空间是稠密的），不需要桶、桶区间表与桶内扫描。条目按字下标就地存放，每项只存一个加密的动作下标，分发是一次下标加一次调用，比密文表形态更小也更快，静态隐藏程度相同', 'Forces direct addressing: the dispatch word is itself the index (the word space is dense), so no buckets, no bucket-range table and no in-bucket scan. Entries sit at their own word index and each stores one encrypted action index; dispatch is one index plus one call — smaller and faster than the encrypted-table form, with the same static hiding'],
  vmJumpsEncoding: ['跳转操作数由「目标绝对字下标」改存「目标 − 本指令」的相对差值，运行期用取指游标还原。差值脱离所在位置就没有意义，dump 出解密后的字节码也只看得到相对位移，要还原控制流得先确定每条指令的字跨度。这是叠加在逐字加密之上的第二层；WASM 内核档的解释器按绝对下标硬编码，该档忽略本项', 'Jump operands store (target − this instruction) instead of the absolute word index, restored at runtime from the fetch cursor. The delta is meaningless out of context, so even a dump of the decrypted bytecode only shows relative displacements and recovering the CFG needs each instruction width. A second layer on top of per-word encryption; ignored by the WASM interpreter tier, which is hard-coded to absolute indices'],
  vmStackEncoding: ['操作数栈上的值以「32 位整数 ^ 逐函数密钥」存放，压栈编码、出栈解码（同一个幂等函数）。dump 操作数栈看到的不再是真实操作数。浮点、大整数、字符串、对象一律明文通过——这是本层的边界。代价是每次压栈/出栈多一次函数调用；WASM 内核档的栈在模块里，该档忽略本项', 'Operands sit on the stack as (32-bit integer ^ per-function key), encoded on push and decoded on pop (the same idempotent function), so dumping the operand stack no longer shows the real operands. Floats, big integers, strings and objects pass through in the clear — that is the boundary of this layer. Costs one extra call per push/pop; ignored by the WASM interpreter tier, whose stack lives inside the module'],
  vmPolymorph: ['逐函数从纯栈 / 寄存器优先 / 双栈分立三种执行结构里随机抽一种，静态数据流模型不再统一', 'Picks one of three execution shapes per function (pure stack / register-first / dual stack) so no single static model holds'],
  vmBlockDecrypt: ['字节码按块自解密：块边界逐构建随机，任一时刻内存里最多一两块明文', 'Per-block bytecode self-decryption: block boundaries are randomized per build, at most one or two blocks are plaintext at any moment'],
  wasmInterpreter: ['把解释器本体（取指、解密、分发、值栈）编译进共享 WASM 模块，JS 侧只剩桥接语句', 'Compiles the interpreter core (fetch, decrypt, dispatch, value stack) into a shared WASM module, leaving only bridge statements in JS'],
  wasm: ['WASM 虚拟机档：整体走 WASM 内核的强档', 'WASM VM tier: the stronger tier running through the WASM core'],
  integrityCheck: ['自校验产物摘要，被改一个字节即失败', 'Self-checks the artifact digest; a single modified byte fails it'],
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
      badge: OPTION_BADGES[key],
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
      badge: OPTION_BADGES[key],
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
