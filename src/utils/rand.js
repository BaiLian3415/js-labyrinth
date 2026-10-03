/**
 * 随机数工具，含可复现的 mulberry32 PRNG 和名字、字符串、洗牌生成函数。
 *
 * 没调 setSeed 时走 crypto 熵源，每次构建都不一样；crypto 不可用就退回 Math.random。
 * 各个 pass 不要直接调 Math.random，那样给了同样的 seed 也复现不出同一份产物。
 */

import platform from '../platform.js';

// setSeed 后换成 mulberry32，同一个种子产出同一份结果。
// 未播种时的熵源经 platform 取宿主的高熵随机数（Node / 浏览器 / Worker 一致），
// 不可用时才退回 Math.random。
let _rng = () => platform.randomUint32() / 0x100000000;

function setSeed(n) {
  let a = n >>> 0;
  _rng = function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = () => _rng();
const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const HEXD = '0123456789abcdef';
const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
// 前缀池混了 _0x、$、c0 几种风格,产物不会只剩一种 _0x 指纹。
// 前缀都以字母或 $/_ 开头,数字只出现在中间或尾部,保证拼出来是合法标识符。
const PREFIXES = ['_0x', '_', '$', 'c0', '_$', '$0x', 'a_', '_o', 'x_', '_q'];
const SUFFIXES = ['', '$', '_', 'x', '0', 'k'];

// 纯字母短名可能撞上关键字,这里连未来保留字一起排除
const RESERVED = new Set(('break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield await async of get set from as arguments eval undefined null Infinity NaN').split(' '));

function randHex(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += HEXD[randInt(0, 15)];
  return s;
}

function randAlpha(len) {
  let s = ALPHA[randInt(0, ALPHA.length - 1)];
  for (let i = 1; i < len; i++) s += CHARS[randInt(0, CHARS.length - 1)];
  return s;
}


function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/**
 * 生成一个没被占用的随机标识符。
 * used 由外部收集,是原始代码里全部已占用的名字。
 * 两族混排:纯字母短名约占五成半,符号前缀族占其余四成半,前缀族里调用方给的
 * prefix 只有 40% 的概率被采用,其他走前缀池。这样产物里没有占多数的单一
 * 命名样式,按前缀加 hex 批量识别改名的启发式就失效了。
 *
 * 只产 ASCII(2026-10-03 改):早先这里有约三成概率摇出汉字名,理由是混排后没有
 * 单一风格指纹。但 uniqueName 的产物会被多个 pass 当**原始文本**拼进产物(引导层
 * banner、外壳层 shell 等),那些位置不经过 AST 生成器,escapeNonAscii 管不到,
 * 汉字会原样落进产物——既违反用户选的 nameStyle,也违反 escapeNonAscii 的承诺,
 * 还留下「只有本工具会产出汉字标识符」这种极强的工具指纹。改为在源头只出 ASCII,
 * 对所有调用点一致生效,不必逐个 pass 排查哪条路径漏了转义。
 * 中文命名功能无关:它走 utils/cjk.js 的 cjkNames(),与本函数没有交集。
 *
 * @param {Set<string>} used 已占用的名字集合,生成的名字会写进去
 * @param {string} [prefix] 调用方指定的前缀,不一定被采用
 * @returns {string} 未被占用的标识符
 */
function uniqueName(used, prefix) {
  let name;
  let guard = 0;
  do {
    if (guard++ > 100) {
      // 极端拥挤兜底:直接追加计数
      name = (prefix || '_0x') + guard + randHex(4);
    } else {
      const roll = rand();
      if (roll < 0.55) {
        // 纯字母短名可能拼出 var/for/if/class,撞上就重摇
        do {
          name = randAlpha(randInt(4, 9));
        } while (RESERVED.has(name));
      } else {
        // 符号前缀族,调用方给的 prefix 只有四成概率被采用
        const p = (prefix && rand() < 0.4) ? prefix : PREFIXES[randInt(0, PREFIXES.length - 1)];
        name = p + randHex(randInt(4, 8)) + (rand() < 0.3 ? SUFFIXES[randInt(0, SUFFIXES.length - 1)] : '');
      }
    }
  } while (used.has(name));
  used.add(name);
  return name;
}

export default { setSeed, rand, randInt, randHex, randAlpha, shuffle, uniqueName, HEXD, RESERVED };
