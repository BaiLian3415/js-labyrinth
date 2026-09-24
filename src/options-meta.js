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
  extraGlobals: { kind: 'string', group: 'basic', zh: '宿主全局白名单', en: 'Extra host globals', hintZh: '逗号分隔，如 WebSocketPair', hintEn: 'comma separated, e.g. WebSocketPair' },
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
  vmThreshold: { kind: 'count', group: 'vm', zh: 'VMP 函数最小语句数', en: 'VMP minimum statements' },
  vmDecoyOps: { kind: 'count', group: 'vm', zh: '分发器干扰字总数', en: 'Dispatcher decoy ops' },
  wasmThreshold: { kind: 'count', group: 'vm', zh: 'WASM 搬入最小字节码字数', en: 'WASM minimum bytecode words' },
  rtDepth: { kind: 'int', min: 1, max: 8, group: 'vm', zh: '自定义运行时层数', en: 'Custom RT layers' },
  shellDepth: { kind: 'int', min: 1, group: 'defense', zh: '外壳层数', en: 'Shell layers' },
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
  vmDispatchEnc: ['分发条目表加密', 'Encrypted dispatch table'],
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
  debugPoison: ['反调试投毒联动', 'Anti-debug poisoning'],
  consoleStub: ['console 中和', 'Console neutralization'],
  selfDefending: ['字符串池自防御', 'String pool self-defense'],
  envFingerprint: ['环境指纹检测', 'Environment fingerprinting'],
  integrityCheck: ['完整性校验', 'Integrity check'],
  selfCheck: ['混淆后自校验', 'Post-obfuscation self-check'],
  shell: ['外层保护壳', 'Outer protective shell'],
  compact: ['压缩输出', 'Compact output'],
  escapeNonAscii: ['非 ASCII 转义', 'Escape non-ASCII'],
  dirCopyOthers: ['复制非 JS 文件', 'Copy non-JS files'],
};

const BOOL_GROUPS = {
  mangle: 'structure', functionWrapper: 'structure', callProxy: 'structure',
  templateToConcat: 'structure', objectKeyEncoding: 'structure',
  stringArray: 'strings', stringArrayRotate: 'strings', stringArrayCache: 'strings',
  stringArrayMixedEncoding: 'strings', stringIndexMask: 'strings', honeyStrings: 'strings',
  stringArrayCallsTransform: 'strings',
  controlFlowFlattening: 'flow', controlFlowLoopFlattening: 'flow',
  numberObfuscation: 'flow', controlFlowRollingKey: 'flow',
  logicalExpressions: 'flow', conditionObfuscation: 'flow',
  opaquePredicates: 'flow', deadCodeInjection: 'flow', decoyFunctions: 'flow',
  vmProtection: 'vm', wasm: 'vm',
  vmDispatchEnc: 'vm', vmPolymorph: 'vm', vmBlockDecrypt: 'vm',
  wasmInterpreter: 'vm', stringScatter: 'strings', antiLLM: 'defense',
  debugProtection: 'defense', debugPoison: 'defense', consoleStub: 'defense',
  selfDefending: 'defense', envFingerprint: 'defense', integrityCheck: 'defense',
  selfCheck: 'defense', shell: 'defense',
  compact: 'output', escapeNonAscii: 'output',
};

export const OPTION_GROUPS = [
  { id: 'basic', zh: '基础', en: 'Basic' },
  { id: 'structure', zh: '结构变换', en: 'Structure' },
  { id: 'strings', zh: '字符串', en: 'Strings' },
  { id: 'flow', zh: '控制流与死代码', en: 'Control flow' },
  { id: 'vm', zh: '虚拟机与 WASM', en: 'VM & WASM' },
  { id: 'defense', zh: '防护与外壳', en: 'Protection' },
  { id: 'output', zh: '输出', en: 'Output' },
];

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
    out.push({
      key,
      kind: 'bool',
      group: BOOL_GROUPS[key] || 'structure',
      zh: labels[0],
      en: labels[1],
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
