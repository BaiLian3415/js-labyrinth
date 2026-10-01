import rand from './rand.js';

const { shuffle } = rand;

/**
 * 中文标识符用的字典与命名池。
 *
 * 为什么能直接拿汉字当标识符：ECMAScript 的 ID_Start 覆盖 CJK 统一表意文字
 * （U+4E00–U+9FFF），`var 甲 = 1` 在 Node 与浏览器里都合法。本项目的 parser 与
 * generator 也不拦——实测 escapeNonAscii 开关两种取值下产物都能正常执行。
 *
 * 默认字典 1024 字。前一段是手挑的常用字（起手就是甲乙丙丁，读起来像"人写的
 * 名字"而不是随机码点），不够 1024 时再从 U+4E00 起顺序补齐到 1024：补出来的
 * 偏生僻，但做标识符无所谓，且必须确定性——同样输入要得到同样字典，否则构建
 * 不可复现。
 *
 * 逐构建打乱：字典本身固定，直接按顺序发名会留下强指纹（等价于 Mangled 档
 * 的 a/b/c 序列）。所以每次构建先把字典打乱再发，同 seed 复现、换 seed 换一套。
 */

/** 字典大小。超过 1024 个绑定才会用到两字组合，因此单字池给到 1024 足够。 */
export const DEFAULT_CJK_DICT_SIZE = 1024;

/** 手挑的常用字，作为字典开头。顺序即优先级，越靠前越"像人话"。 */
const COMMON = [
  '甲乙丙丁戊己庚辛壬癸',
  '子丑寅卯辰巳午未申酉戌亥',
  '一二三四五六七八九十百千万亿零',
  '天地日月星辰风雨雷电云霜露雪',
  '山川河海江湖溪泉井岩石土田',
  '花草树木林森竹松梅兰菊荷莲',
  '鸟兽鱼虫猫狗牛羊马鸡鸭鱼龙凤',
  '人手足目耳口鼻舌牙头发心肝脾肺肾',
  '父母兄弟姐妹儿女夫妇叔伯',
  '金木水火土日月星辰光电',
  '东南西北中左右前后上下里外',
  '春夏秋冬晨昏昼夜朝暮年时',
  '红黄蓝白黑青绿紫橙粉棕灰',
  '车船马飞机轮骑步走跑跳升降',
  '门窗桌椅床柜灯墙屋顶梁柱',
  '衣食住行言语读写听闻问答思',
  '学教书礼义信仁勇智信忠孝节',
  '兵法权谋攻守进退成败得失',
  '福禄寿喜吉凶祸福命运缘',
  '真假善恶美丑是非对错好坏',
].join('');

/**
 * 造默认字典：常用字在前，不足的部分从 CJK 块顺序补齐。
 * @param {number} [size] 字典字数，默认 1024
 * @returns {string} 互不重复的汉字串
 */
export function defaultCJKDict(size) {
  const want = Math.max(1, Math.floor(size) || DEFAULT_CJK_DICT_SIZE);
  const seen = new Set();
  let out = '';
  const add = (ch) => {
    if (out.length >= want) return false;
    if (seen.has(ch)) return true;
    // 只收 BMP 里的单个码点：代理对那两半都不是合法 ID_Start
    if (ch.codePointAt(0) > 0xffff) return true;
    seen.add(ch);
    out += ch;
    return out.length < want;
  };
  for (const ch of COMMON) if (!add(ch)) return out;
  for (let cp = 0x4e00; cp <= 0x9fff && out.length < want; cp++) {
    add(String.fromCharCode(cp));
  }
  return out;
}

/**
 * 解析用户给的字典：非空就用它，否则用默认字典。非法字符（重复、代理对）过滤掉。
 * @param {string} raw 用户填的字典
 * @returns {string} 清洗后的字典
 */
export function normalizeCJKDict(raw) {
  const s = typeof raw === 'string' ? raw : '';
  if (!s.trim()) return defaultCJKDict();
  const seen = new Set();
  let out = '';
  for (const ch of s) {
    if (ch.codePointAt(0) > 0xffff) continue;
    if (seen.has(ch)) continue;
    seen.add(ch);
    out += ch;
  }
  return out || defaultCJKDict();
}

/**
 * 中文命名池：单字 → 两字组合。与 mangle 的其他几档共用"发名池"机制。
 *
 * 单字池逐构建打乱，因此同 seed 可复现、换 seed 换一套字典顺序；两字组合在
 * 单字用尽后才启用（一字 × 一字 共 size² 个，1024 时超过一百万，实际上用不到）。
 *
 * @param {string} dict 字典
 * @returns {Generator<string>} 依次产出候选名
 */
export function* cjkNames(dict) {
  const chars = shuffle(normalizeCJKDict(dict).split(''));
  const n = chars.length;
  yield* chars;
  if (n === 0) return;
  const tier = () => shuffle(chars.slice());
  const b1 = tier();
  const b2 = tier();
  for (const x of b1) for (const y of b2) yield x + y;
}

/** 名字里含非 ASCII 就按"中文名"处理——仅用于统计与提示，不参与改名判定。 */
export function isCJKName(name) {
  return typeof name === 'string' && /[\u3400-\u9fff]/.test(name);
}

/**
 * 命名池用尽后的兜底：仍给一个没被占用的汉字名。
 *
 * 池空只在字典被用户缩到极小、或绑定数超过字典平方时才会发生（默认 1024 字下是
 * 一百多万个名字，实际上摸不到）。此时按顺序取字典里第一个没用过的字，用完了再
 * 追加序号——与 rand.uniqueName 同构，保证任何情况下都不退回拉丁名，
 * 免得同一个产物里混着两套命名风格。
 *
 * @param {Set<string>} used 已占用名
 * @param {string} dict 字典
 * @returns {string} 一个未被占用的中文名
 */
export function uniqueCJKName(used, dict) {
  const chars = normalizeCJKDict(dict).split('');
  for (const ch of chars) {
    if (!used.has(ch)) {
      used.add(ch);
      return ch;
    }
  }
  for (let i = 0; ; i++) {
    const name = chars[0] + i;
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
}