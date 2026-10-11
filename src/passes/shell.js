/**
 * Pass 15：产物外壳。把已完成的混淆产物当作载荷字节流，用纯手工实现的解密引导器
 * 包裹，编码链为反馈密钥流、交织置换、S-box 逆查表、校验尾与乱序 base64 分段存放，
 * 派生表全部在运行期由种子生成。防篡改靠算术依赖：单字节篡改令反馈链错位、校验尾
 * 差量非零，载荷被打碎后 eval 必抛 SyntaxError。引导器自身要过同一流水线，必须关掉
 * 若干 pass 才能自举，否则无限递归；ESM 源跳过套壳。
 *
 * shellForm: 'jsfuck' 时另把「密钥流生成 + 校验尾差量」那段核心编成纯 JSFuck 表达式
 * （编码器见 jsfuck.js），引导器其余部分（段装载、表派生、投毒）一字不动。
 */

import rand from '../utils/rand.js';
// randFn 是 rand 模块导出的 0~1 浮点源（默认导出本身也叫 rand，解构出来得改名，
// 否则 const { rand } = rand 会在自己的初始化器里撞上 TDZ）。
const { randInt, randHex, rand: randFn } = rand;
import i18n from '../i18n.js';
import { jsfuckProgram, decodeStrExpr } from './jsfuck.js';
import { buildDecodeChain } from './shellir.js';
import { encryptWords, emitInterpreter, emitVm, shuffleOpCodes } from './shellemit.js';

const B64_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// 共享原语，参数为无符号 32 位或有限整数，构建期与运行期行为逐位一致。
//
// 每个原语给**若干族实现**，逐构建挑一族。为什么值得挑：
//   · lcg 的 1103515245、xs32 的 13/17/5、mul32 的 16 位拆分形状，都是极强且
//     一搜就中的工具指纹——扫一遍常量就能定位到本工具，无需理解任何逻辑。
//   · 这些原语只用于在构建期与运行期之间自洽地产生密钥流（谁也不用它的具体数值），
//     所以换一族**不改变任何外部可观察行为**，只需要同一变体在两侧一致。
//   · 于是指纹从"这几个常量"降级成"某一族常量"，定位成本从扫常量升到读逻辑。
//
// 每族的 src（进产物的文本）与 fn（构建期实现）必须逐位等价，这由
// test/handler-poly.js 遍历**全部**变体组合逐位比对来钉死；test/minify.js 那条
// 只比默认档，作为"两份实现不会漂移"的基线保留。
//
// PRIMITIVES 是产物里那份文本，逐字进引导器；下面是它在构建期的等价物。原先这里
// 用 (0, eval)(...) 当场求值，好处是"同一份文本"天然不会漂移，但浏览器的 CSP 与
// 不少函数运行时禁止一切字符串代码生成——eval 与 new Function 一律被拒，跑起来
// 直接报 EvalError: Code generation from strings disallowed。
//
// 参数名用 _0x/_0u/_0a 这类占位，随后统一交给 randomizeNames 随机化（见
// makeShellLayer 里的调用点处理），所以变体之间的形参命名不构成差异。

const MUL32_FORMS = [
  {
    // 16 位拆分。不用 Math.imul 是为了兼容没有 imul 的老宿主（它在 ES2015 才进规范）。
    src: 'function mul32(_0a,_0b){_0a=_0a>>>0;_0b=_0b>>>0;var _0l=_0a&65535,_0h=_0a>>>16;' +
      'return ((_0l*_0b)+(((_0h*_0b)&65535)<<16))>>>0;}',
    fn: (a, b) => {
      a >>>= 0; b >>>= 0;
      const l = a & 65535; const h = a >>> 16;
      return ((l * b) + (((h * b) & 65535) << 16)) >>> 0;
    },
  },
  {
    // imul 版：同一结果（低 32 位），代码形状完全不同。
    src: 'function mul32(_0a,_0b){return Math.imul(_0a>>>0,_0b>>>0)>>>0;}',
    fn: (a, b) => Math.imul(a >>> 0, b >>> 0) >>> 0,
  },
  {
    // 8 位拆分版：与 16 位拆分同族思想不同分块，低 32 位与另两族逐位一致
    // （handler-poly 全组合断言）。无循环，装载期每字节密钥流调一次也不慢；
    // 移位加版曾在此处，因 32 轮循环把大载荷的装载拖慢到触发反调试时延拖慢
    // （正反馈到 60s+ 超时），已弃用——教训：原语形态必须同时看渐近成本。
    src: 'function mul32(_0a,_0b){_0a=_0a>>>0;_0b=_0b>>>0;' +
      'var _0x0=_0a&255,_0x1=(_0a>>>8)&255,_0x2=(_0a>>>16)&255,_0x3=_0a>>>24;' +
      'return ((_0x0*_0b)+(((_0x1*_0b)&16777215)<<8)+(((_0x2*_0b)&65535)<<16)+(((_0x3*_0b)&255)<<24))>>>0;}',
    fn: (a, b) => {
      a >>>= 0; b >>>= 0;
      const x0 = a & 255, x1 = (a >>> 8) & 255, x2 = (a >>> 16) & 255, x3 = a >>> 24;
      return ((x0 * b) + (((x1 * b) & 16777215) << 8) + (((x2 * b) & 65535) << 16) + (((x3 * b) & 255) << 24)) >>> 0;
    },
  },
];

const LCG_FORMS = [
  { src: 'function lcg(_0x){return (mul32(_0x>>>0,1103515245)+12345)>>>0;}',
    fn: (x) => (mul32(x >>> 0, 1103515245) + 12345) >>> 0 },
  { src: 'function lcg(_0x){return (mul32(_0x>>>0,214013)+2531011)>>>0;}',
    fn: (x) => (mul32(x >>> 0, 214013) + 2531011) >>> 0 },
  { src: 'function lcg(_0x){return (mul32(_0x>>>0,1664525)+1013904223)>>>0;}',
    fn: (x) => (mul32(x >>> 0, 1664525) + 1013904223) >>> 0 },
];

const XS32_FORMS = [
  { src: 'function xs32(_0u){_0u^=_0u<<13;_0u^=_0u>>>17;_0u^=_0u<<5;return _0u>>>0;}',
    fn: (u) => { u ^= u << 13; u ^= u >>> 17; u ^= u << 5; return u >>> 0; } },
  // 注意：三元组不能随手填。(11,19,8) 看着顺眼，实际周期只有 84——4096 步只取到
  // 84 个值。产物照样能跑（构建期与运行期一起退化），但密钥流质量没了，等于白换掉
  // 一个指纹。(11,13,19) 是实测过的非退化三元组，test/handler-poly.js 有断言守着。
  { src: 'function xs32(_0u){_0u^=_0u<<11;_0u^=_0u>>>13;_0u^=_0u<<19;return _0u>>>0;}',
    fn: (u) => { u ^= u << 11; u ^= u >>> 13; u ^= u << 19; return u >>> 0; } },
  { src: 'function xs32(_0u){_0u=(_0u+0x6D2B79F5)>>>0;var _0t=_0u;_0t=Math.imul(_0t^(_0t>>>15),_0t|1);' +
      '_0t^=_0t+Math.imul(_0t^(_0t>>>7),_0t|61);return (_0t^(_0t>>>14))>>>0;}',
    fn: (u) => {
      u = (u + 0x6D2B79F5) >>> 0;
      let s = u;
      s = Math.imul(s ^ (s >>> 15), s | 1);
      s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
      return (s ^ (s >>> 14)) >>> 0;
    } },
];

const SHFL_FORMS = [
  // 自顶向下（经典 Fisher-Yates）
  { src: 'function shfl(_0a,_0s){var _0x=_0s>>>0;' +
      'for(var _0i=_0a.length-1;_0i>0;_0i--){_0x=lcg(_0x);var _0j=_0x%(_0i+1);' +
      'var _0t=_0a[_0i];_0a[_0i]=_0a[_0j];_0a[_0j]=_0t;}return _0a;}',
    fn: (a, s) => {
      let x = s >>> 0;
      for (let i = a.length - 1; i > 0; i--) {
        x = lcg(x);
        const j = x % (i + 1);
        const t = a[i]; a[i] = a[j]; a[j] = t;
      }
      return a;
    } },
  // 自底向上：同样是一个均匀置换，循环方向与取模方式都不同
  { src: 'function shfl(_0a,_0s){var _0x=_0s>>>0;var _0n=_0a.length;' +
      'for(var _0i=0;_0i<_0n-1;_0i++){_0x=lcg(_0x);var _0j=_0i+_0x%(_0n-_0i);' +
      'var _0t=_0a[_0i];_0a[_0i]=_0a[_0j];_0a[_0j]=_0t;}return _0a;}',
    fn: (a, s) => {
      let x = s >>> 0;
      const n = a.length;
      for (let i = 0; i < n - 1; i++) {
        x = lcg(x);
        const j = i + x % (n - i);
        const t = a[i]; a[i] = a[j]; a[j] = t;
      }
      return a;
    } },
  // 由内向外：逐个把原数组元素插进新数组，不原地改写（调用点一律取返回值，
  // 见各 shfl 调用处的注释前提）。不同族的置换结果本来就不必相同，只要同族
  // 两侧一致——形状（新数组+if+取模+双写）与 Fisher-Yates 两族完全不同。
  { src: 'function shfl(_0a,_0s){var _0x=_0s>>>0;var _0n=_0a.length;' +
      'var _0b=new Array(_0n);for(var _0i=0;_0i<_0n;_0i++){_0x=lcg(_0x);' +
      'var _0j=_0x%(_0i+1);if(_0i!==_0j){_0b[_0i]=_0b[_0j];}_0b[_0j]=_0a[_0i];}return _0b;}',
    fn: (a, s) => {
      let x = s >>> 0;
      const n = a.length;
      const b = new Array(n);
      for (let i = 0; i < n; i++) {
        x = lcg(x);
        const j = x % (i + 1);
        if (i !== j) b[i] = b[j];
        b[j] = a[i];
      }
      return b;
    } },
];

const IPOS_SRC = 'function ipos(_0t,_0P1,_0P2,_0N){return (((_0t*_0P1)%_0N)*_0P2)%_0N;}';

// mix 的乘数 16777619 是 FNV 的素数，属于算法规范参数：**不能换值**。
// mix 算出的 h 就是载荷的校验尾（见 makeShellLayer 里的 tailWord），构建期算、
// 运行期重算比对，两侧必须逐位一致——换值会让每个产物都解不开。
// 只能换写法：16777619 === 0x01000193 === (1<<24)|0x193。
const MIX_FORMS = [
  { id: 'dec', prime: '16777619' },
  { id: 'hex', prime: '0x01000193' },
  { id: 'shift', prime: '((1<<24)|0x193)' },
];

/** 按给定变体装配 mix 的源码文本。 */
function buildMixSrc(vi) {
  const P = MIX_FORMS[vi % MIX_FORMS.length].prime;
  return 'function mix(_0h,_0v,_0t,_0ph){_0h=mul32(_0h^_0v,' + P + ');' +
    'if(_0ph){_0h=mul32(_0h^(_0t&255),' + P + ');}return _0h>>>0;}';
}

const MIX_SRC = buildMixSrc(0);

/** 每族的变体数。抽出来给自测遍历全部组合用。 */
export const PRIMITIVE_VARIANT_COUNTS = {
  mul32: MUL32_FORMS.length,
  lcg: LCG_FORMS.length,
  xs32: XS32_FORMS.length,
  shfl: SHFL_FORMS.length,
  mix: MIX_FORMS.length,
};

/** 默认变体（族 0）。既是不选时的取值，也是自测的基线。 */
export const DEFAULT_VARIANTS = { mul32: 0, lcg: 0, xs32: 0, shfl: 0, mix: 0 };

// 当前生效的变体。构建期所有原语调用都转发到这里的族实现，所以「产物里那一份」
// 与「构建期算表用的那一份」必然是同一族——这是本文件最容易出错的地方：
// 两侧一旦不同族，构建期算出的密钥流与运行期解出来的不一致，载荷直接变乱码。
let CUR = { ...DEFAULT_VARIANTS };

/**
 * 按变体装配产物里那份原语文本。
 * @param {{mul32:number,lcg:number,xs32:number,shfl:number}} v 变体下标
 * @returns {string} 可直接进引导器的函数声明串
 */
export function buildPrimitivesText(v) {
  return [
    MUL32_FORMS[v.mul32].src,
    LCG_FORMS[v.lcg].src,
    XS32_FORMS[v.xs32].src,
    SHFL_FORMS[v.shfl].src,
    IPOS_SRC,
    buildMixSrc(v.mix === undefined ? 0 : v.mix),
  ].join('');
}

/** 把模块当前变体设成给定下标。只由本文件的构建流程与自测调用。 */
export function setPrimitiveVariants(v) {
  CUR = { ...DEFAULT_VARIANTS, ...(v || {}) };
}

/** 当前生效的变体副本（自测与诊断用）。 */
export function currentPrimitiveVariants() { return { ...CUR }; }

/**
 * 逐构建挑一族变体。走的是 seeded rand，所以同 seed 必得同一族、产物可复现。
 * @param {() => number} rng 0..1 的随机源
 */
export function choosePrimitiveVariants(rng) {
  const pick = (n) => Math.min(n - 1, Math.floor(rng() * n));
  const v = {
    mul32: pick(MUL32_FORMS.length),
    lcg: pick(LCG_FORMS.length),
    xs32: pick(XS32_FORMS.length),
    shfl: pick(SHFL_FORMS.length),
    mix: pick(MIX_FORMS.length),
  };
  setPrimitiveVariants(v);
  return v;
}

/** 32 位精确乘法，转发到当前变体。 */
function mul32(_0a, _0b) { return MUL32_FORMS[CUR.mul32].fn(_0a, _0b); }
/** 密钥流推进器（线性同余），转发到当前变体。 */
function lcg(_0x) { return LCG_FORMS[CUR.lcg].fn(_0x); }
/** 另一条密钥流推进器，转发到当前变体。 */
function xs32(_0u) { return XS32_FORMS[CUR.xs32].fn(_0u); }
/** 原地置换，转发到当前变体。 */
function shfl(_0a, _0s) { return SHFL_FORMS[CUR.shfl].fn(_0a, _0s); }

function ipos(_0t, _0P1, _0P2, _0N) { return (((_0t * _0P1) % _0N) * _0P2) % _0N; }

function mix(_0h, _0v, _0t, _0ph) {
  _0h = mul32(_0h ^ _0v, 16777619);
  if (_0ph) { _0h = mul32(_0h ^ (_0t & 255), 16777619); }
  return _0h >>> 0;
}

/** 原语表。调用点按名字取，与 buildPrimitivesText 产出的那组同名同序。 */
const RT = { mul32, lcg, xs32, shfl, ipos, mix };

/**
 * 引导器原语文本（当前变体的默认档），导出给自测用。
 *
 * 自测在 Node 下把它 eval 出来，与上面那组直接实现逐位比对，作为"两份实现
 * 不会漂移"的保证。eval 只出现在 test/minify.js 里——那里不随 Worker
 * 上传，而核心模块图里连一处字符串代码生成都不能留。
 */
export const PRIMITIVES_TEXT = buildPrimitivesText(DEFAULT_VARIANTS);

/** 直接实现的那组原语，导出给自测比对。 */
export const primitivesDirect = RT;

// 差量与非法计数混入密钥流种子的乘数。
//
// 原先写死 2654435761（= 0x9e3779b1，公开的黄金比例常数），扫字面量即可定位。
// 它**不是算法规范参数**——只是在往 keyState 里掺一个构建期已知的乘数，让"改坏
// 载荷 → 差量变化 → 解不开"这条依赖多一处冗余，所以逐构建换一个即可。
// 唯一约束：同一次 makeShellLayer 里的三处引用必须是同一个值（构建期不再重算它，
// 三处都直接写进产物文本，所以只要在一个地方摇一次）。
function junkMult() {
  // 取奇数：偶数会让低位的抹除概率上升，掺入的差量更容易被低熵掩盖。
  return ((randInt(0x10000000, 0x7fffffff) << 1) | 1) >>> 0;
}


/** 载荷转 UTF-8 字节数组，构建期使用。 */
function utf8Bytes(str) {
  return Array.from(new TextEncoder().encode(str));
}

/** UTF-8 字节数组转字符串，构建期解码镜像，供对称测试使用。 */
function utf8Decode(bytes) {
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/** 与 N 互质的交织步长，种子驱动，构建期与运行期走同一条推导链。 */
function coprimeStep(N, seed) {
  if (N <= 2) return 1;
  let x = seed >>> 0;
  const span = N - 2;
  for (let k = 0; k < 300; k++) {
    x = RT.lcg(x);
    const c = 2 + (x % span);
    let a = c, b = N;
    while (b) { const t = a % b; a = b; b = t; }
    if (a === 1) return c;
  }
  return 1;
}

/** base64 编码，构建期使用，字母表由种子派生并乱序，不补 padding。 */
function b64encode(bytes, alpha) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += alpha[(n >>> 18) & 63] + alpha[(n >>> 12) & 63] +
      alpha[(n >>> 6) & 63] + alpha[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += alpha[(n >>> 18) & 63] + alpha[(n >>> 12) & 63];
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += alpha[(n >>> 18) & 63] + alpha[(n >>> 12) & 63] + alpha[(n >>> 6) & 63];
  }
  return out;
}

/**
 * jsfuck 壳形式要搬进纯 JSFuck 表达式的那段核心。
 *
 * 与 makeShellLayer 里 classic 分支的循环逐语句等价：同一个 xs32 反馈链、同一个
 * 位置交织逆查表、同一个 FNV 累积与校验尾拼接，返回值就是 classic 分支算出的
 * _0bd（差量）。原语与表一律当参数传进来（xs/mx/ip）而不在核心内重写一份：
 * 核心每多一个字符，产物就多约 79 字符（实测口径见 jsfuck.js 头注释），
 * 而散列、取模这些原语在引导器作用域里已经有了。
 *
 * 切面刻意留得窄——只搬"密钥流生成 + 校验"这段，其余解密链路仍走流水线混淆。
 * 想扩大切面（比如把表派生、段装载也搬进来）只需把更多语句改写成这里的函数体，
 * 并在调用点按同样的方式传参：成本是可预期的 79 字符/字节 + 8.1K 固定开销
 * （当前 487 字节的核心 = 45.4 KB，每层一份）。
 */
const JSFUCK_CORE = 'function(_0q,_0r,_0sb,_0N,_0L,_0P1,_0P2,_0HB,_0e,_0ph,_0tn,_0xs,_0mx,_0ip){'
  + 'var _0u=_0e>>>0,_0pv=0,_0h=_0HB>>>0,_0i,_0kb,_0v;'
  + 'for(_0i=0;_0i<_0N;_0i++){'
  + '_0u=_0xs(_0u);_0u=(_0u+_0pv+_0i)>>>0;'
  + '_0kb=(_0u^(_0u>>>15)^(_0u>>>22))&255;'
  + '_0v=(_0sb[_0r[_0ip(_0i,_0P1,_0P2,_0N)]]^_0kb)&255;'
  + '_0q[_0i]=_0v;_0pv=_0v;'
  + 'if(_0i<_0L){_0h=_0mx(_0h,_0v,_0i,_0ph);}}'
  + 'return (_0h^_0e^(_0tn?'
  + '((_0q[_0L+3]<<24)|(_0q[_0L+2]<<16)|(_0q[_0L+1]<<8)|_0q[_0L])'
  + ':((_0q[_0L]<<24)|(_0q[_0L+1]<<16)|(_0q[_0L+2]<<8)|_0q[_0L+3])'
  + '))>>>0;}';

/**
 * JSFuck 核心的全局名。
 *
 * 不走 rand.uniqueName：那边会产出 4~9 个字母的短名，与 mangle 的命名族同源，
 * 理论上可能与引导层里某个改名后的局部绑定撞名——撞上就是局部绑定把全局函数
 * 遮掉，产物在运行期才炸。这里用 `<前缀> + 9~13 位 hex`（总长 13~17）：**下界**
 * 长于 mangle 命名族的上界（8 位 hex），撞名概率可忽略。
 *
 * 长度逐构建随机而不是固定 9（2026-10-11 改）：固定的 hex 位宽本身就是一个可
 * grep 的形状指纹（`_0x[0-9a-f]{9}`），而随机长度不增加任何撞名风险。
 */
export function jsfuckCoreName(used, prefix) {
  let name;
  do {
    name = (prefix || '_0x') + randHex(randInt(9, 13));
  } while (used && used.has(name));
  if (used) used.add(name);
  return name;
}

/**
 * JSFuck 核心表达式的体积上限。当前核心 487 字节 → 45.4 KB（79 字符/字节
 * 边际 + 8.1K 固定开销），留出十倍余量：改核心时不小心把整段引导器搬进来，
 * 会在构建期直接失败并报出实际体积，而不是悄悄产出几百 KB。
 */
export const JSFUCK_MAX_CHARS = 512 * 1024;

/**
 * 生成 JSFuck 核心的预置：`var <name> = <纯 JSFuck 表达式>;`
 *
 * 必须由调用方拼在流水线之外：这段表达式里上万次调用一旦过 callProxy，
 * 每个调用点都要再包一层间接层，体积翻数倍；它本身已经是最终形态，没有再可
 * 混淆的结构。调用方拿到的字符串应直接拼在（已混淆的）引导层之前。
 *
 * @param {string} name jsfuckCoreName 产出的全局名
 * @param {number} [maxChars] 体积上限覆盖值，仅供自测用来走一遍失败路径
 * @returns {string} 预置源码
 */
export function jsfuckPrelude(name, maxChars) {
  const cap = maxChars === undefined ? JSFUCK_MAX_CHARS : maxChars;
  const expr = jsfuckProgram('return ' + JSFUCK_CORE);
  if (expr.length > cap) {
    // 不静默降级：宁可直接失败并报出实际体积，也不发一份"说是 jsfuck 壳、
    // 实际没套上"的产物——用户付了这份体积，就得拿到这份形态。
    const fixed = decodeStrExpr('A').length;
    throw new Error(i18n.t('jsfuckTooBig', {
      n: Math.ceil(expr.length / 1024),
      max: Math.floor(cap / 1024),
      bytes: JSFUCK_CORE.length,
      rate: Math.round((expr.length - fixed) / Math.max(1, JSFUCK_CORE.length - 1)),
    }));
  }
  return 'var ' + name + '=' + expr + ';';
}

/**
 * 生成一层引导器源码，明文书写，随后整体再过流水线混淆。
 *
 * 明文侧值由载荷字节与校验尾 4 字节拼接，存放值是其与反馈密钥流的异或，
 * 再经交织置换与 S-box 逆查表，base64 后分段乱序存放。运行期逆推复原明文，
 * 同时累积 FNV 终态，差量非零就打碎载荷前 8 字节。
 *
 * @param {string} payload 层内载荷源码
 * @param {{tailOrder?:number, evalStyle?:number, posHash?:number, decStyle?:number}} [variant]
 *        层形态变体，tailOrder 为校验尾字节序（0 大端，1 小端），evalStyle
 *        为取值器形态（0 用 (0,eval)，1 用 Function 间接取器），posHash 决定
 *        FNV 是否混合位置，decStyle 为 base64 解码形态（0 内联双层循环，
 *        1 分段 for 助手，2 分段 forEach 助手）；省略时随机
 * @param {{cjs?:boolean, esm?:boolean}} [mode] cjs 为真时用「带 CommonJS 形参的
 *        函数内直接 eval」放行载荷：require/module/exports/__dirname/__filename
 *        因此在载荷作用域内可用，`var` 声明也不再落进全局。esm 为真时改用
 *        「blob 优先、data URL 兜底」的 import() 放行，让 ESM 载荷（含
 *        top-level await）能整套壳，见 esmTake 的注释
 * @returns {string} 引导器源码，自执行，末尾复原并放行载荷
 */
function makeShellLayer(payload, variant, mode) {
  // 原语变体逐层重挑：每层壳用自己的一族，于是多层壳叠出来的产物里各层常量不同。
  // 必须在算任何表之前挑——本函数下面所有 RT.* 调用与最后 put(primitivesText)
  // 用的是同一个 CUR。
  const variants = choosePrimitiveVariants(randFn);
  const primitivesText = buildPrimitivesText(variants);
  const JUNK_MULT = junkMult();
  const plain = utf8Bytes(payload);
  const L = plain.length;
  const N = L + 4; // 额外 4 字节校验尾
  // 载荷是否纯 ASCII，决定引导器用哪套复原循环，构建期一次线性扫描
  let plainIsAscii = true;
  for (let i = 0; i < plain.length; i++) {
    if (plain[i] >= 128) { plainIsAscii = false; break; }
  }

  // 种子与密钥，全部随机派生，无明文表；K0 以异或三分片散布声明。
  const v = variant || {};
  const tailOrder = v.tailOrder !== undefined ? v.tailOrder : randInt(0, 1);
  const evalStyle = v.evalStyle !== undefined ? v.evalStyle : randInt(0, 1);
  const ph = v.posHash !== undefined ? v.posHash : randInt(0, 1);
  // base64 解码三形态：0 内联双层循环（经典），1 分段 for 助手，2 分段
  // forEach 助手（每段独立解、外层拼回）。编码侧（分段/乱序）一字不动，三种解码
  // 算出的字节流逐位一致：段长按 4 对齐使跨段无进位残留，坏字符计数累加方式一致。
  const decStyle = v.decStyle !== undefined ? v.decStyle : randInt(0, 2);
  // 字节码壳形态：解码链（A/B/C 三段）整体搬进密文字节码，外层只留一个通用栈式解释器。
  // 与 decStyle 正交但**互斥**：decStyle 是「明文解码链里的 base64 解码有几种写法」，
  // 字节码形态里根本没有那段明文可变形。三者取一：
  //   classic  —— 明文解码链（默认，产物基线，动它就是破坏可复现性）
  //   jsfuck   —— 同一条明文链，但密钥流+校验那段编成 JSFuck 表达式
  //   bytecode —— 解码链进字节码，外层不可读
  // 与 jsfuck 互斥（jsfuck 改的正是那段明文），见 shellWrap 里的分流。
  const bytecode = !!v.bytecode;
  // jsfuck 壳形式：密钥流 + 校验那段换成对全局 JSFuck 核心的一次调用，
  // 预置（var <name>=<表达式>）由调用方拼在流水线之外，见 jsfuckPrelude
  const jsfuckName = mode && mode.jsfuck ? mode.jsfuckName : null;
  const s1 = randInt(1, 0x7ffffffe) >>> 0;
  const s2 = randInt(1, 0x7ffffffe) >>> 0;
  const s3 = randInt(1, 0x7ffffffe) >>> 0;
  // 外部盐：横幅层用它把「横幅文本是否完好」耦合进密钥流。运行期从同名变量读，
  // 变量缺失或被改成别的值都会让密钥流错位、校验尾失配，载荷被打碎后 eval 必抛。
  const saltVar = mode && mode.saltVar ? mode.saltVar : null;
  const SALT = mode && mode.salt !== undefined ? (mode.salt >>> 0) : 0;
  const K0 = ((s1 ^ s2 ^ s3) ^ SALT) >>> 0;
  const SD_S = randInt(1, 0x7ffffffe) >>> 0; // S-box 表种子
  const SD_T = randInt(1, 0x7ffffffe) >>> 0; // 字母表乱序种子
  const SD_D = randInt(1, 0x7ffffffe) >>> 0; // 段乱序种子
  const SD_P = randInt(1, 0x7ffffffe) >>> 0; // 交织步长种子
  const HB = (randInt(1, 0xffffffff) | 1) >>> 0; // FNV 基值，无常量可锚
  const P1 = coprimeStep(N, SD_P);
  const P2 = coprimeStep(N, (SD_P ^ 0x5bf03635) >>> 0);

  // 派生表镜像，引导器内的洗牌与构建期同一实现。
  const alpha = RT.shfl(B64_ALPHA.split(''), SD_T).join('');
  const sbox = RT.shfl(Array.from({ length: 256 }, (_, i) => i), SD_S);
  const invSbox = new Array(256);
  for (let i = 0; i < 256; i++) invSbox[sbox[i]] = i;

  // 编码链，FNV 与校验尾都在明文侧累积，与运行期同源。
  let u = K0 >>> 0;
  let h = HB >>> 0;
  let prev = 0;
  const qAll = new Array(N);
  for (let t = 0; t < L; t++) {
    u = RT.xs32(u);
    u = (u + prev + t) >>> 0;
    const kb = (u ^ (u >>> 15) ^ (u >>> 22)) & 255;
    qAll[t] = (plain[t] ^ kb) & 255;
    h = RT.mix(h, plain[t], t, ph);
    prev = plain[t];
  }
  const tailWord = (h ^ K0) >>> 0;
  const tb = [(tailWord >>> 24) & 255, (tailWord >>> 16) & 255, (tailWord >>> 8) & 255, tailWord & 255];
  const tbytes = tailOrder === 0 ? tb : tb.slice().reverse();
  for (let k = 0; k < 4; k++) {
    u = RT.xs32(u);
    u = (u + prev + (L + k)) >>> 0;
    const kb = (u ^ (u >>> 15) ^ (u >>> 22)) & 255;
    qAll[L + k] = (tbytes[k] ^ kb) & 255;
    prev = tbytes[k];
  }
  const r = new Array(N);
  for (let t = 0; t < N; t++) r[RT.ipos(t, P1, P2, N)] = invSbox[qAll[t]];

  // 乱序字母表 base64，分段后按种子乱序存放。
  const b64 = b64encode(r, alpha);
  const segCount = Math.max(2, randInt(3, 8), Math.ceil(b64.length / 16384));
  const chunk = Math.ceil(Math.ceil(b64.length / segCount) / 4) * 4;
  const segs = [];
  for (let s = 0; s * chunk < b64.length; s++) segs.push(b64.slice(s * chunk, (s + 1) * chunk));
  const SG = segs.length;
  const ord = RT.shfl(segs.map((_, i) => i), SD_D);
  const gSlots = new Array(SG);
  for (let j = 0; j < SG; j++) gSlots[ord[j]] = segs[j];

  // 引导器模板，原生语句，无任何外部引用，原语文本逐字嵌入。
  // native 拼写走别名 _0fc（上面已声明）：指纹只剩 1 处。
  const NATIVE = '_0fc(110,97,116,105,118,101)'; // 拼出 native
  const tailExpr = tailOrder === 0
    ? '(((_0q[_0L]<<24)|(_0q[_0L+1]<<16)|(_0q[_0L+2]<<8)|_0q[_0L+3])>>>0)'
    : '(((_0q[_0L+3]<<24)|(_0q[_0L+2]<<16)|(_0q[_0L+1]<<8)|_0q[_0L])>>>0)';
  const isCjs = !!(mode && mode.cjs);
  const isEsm = !!(mode && mode.esm);
  const evalTake = evalStyle === 0 ? '(0,eval)' : 'Function("return eval")()';
  // CommonJS 载荷：形参名必须与载荷引用的绑定名逐字一致，直接 eval 才能看见它们
  const cjsTake = 'Function("require","module","exports","__dirname","__filename","payload","return eval(payload)")';
  // ESM 载荷：eval 与 Function 都跑不了 import/export（实测 "Cannot use import
  // statement outside a module"），只有 import() 行得通，top-level await 也只有
  // 在真模块里才合法。
  //
  // 候选按「成功概率」排，逐个试到加载成功为止。两个坑都踩过：
  //   - 浏览器：data: URL 有约 2MB 上限，多层壳后轻易到 10MB+，必须走 blob。
  //   - Node：URL.createObjectURL 存在，但返回 blob:nodedata:…，而 Node 的 ESM
  //     loader 明确拒收（ERR_UNSUPPORTED_ESM_URL_SCHEME）。
  // 所以两个候选都要放进列表，且不能靠「特性是否存在」筛——blob 在 Node 上
  // 存在却不可用，data 在浏览器上存在却可能超限。判据只能是「真的加载成不成功」，
  // 因此 catch 的是 import() 的失败并顺次退到下一个。
  const esmTake = '(function(s){var u=[];try{u.push(URL.createObjectURL(new Blob([s],{type:"text/javascript"})));}' +
    'catch(e){}u.push("data:text/javascript;charset=utf-8,"+encodeURIComponent(s));' +
    'var i=0;function nx(){if(i>=u.length){return Promise.reject(new Error("esm loader unavailable"));}' +
    'var v=u[i++];return import(v).catch(function(){return nx();});}return nx();})(_0s2)';

  const B = [];
  const put = (...xs) => B.push(...xs);
  // 引导器语句形态多态：同义字符串模板逐构建随机挑一个（见下面的 P)。
  //
  // 为什么做在字符串层而不是 AST 层：引导器本来就是字符串拼出来的，拼完才进
  // 流水线；在这里分叉形态最直接。约束与 morph.js 相同——只收逐位等价的写法，
  // 且 loader 顶层一律保留 var：载荷经 eval 在同一函数作用域执行，var 改 let
  // 会把"同名复用"变成 SyntaxError（let 重声明直接抛，var 只是复用）。
  // 语义网：test/semantics.js（medium 起真跑产物，必经本引导）+ handler-poly。
  const P = (forms) => forms[randInt(0, forms.length - 1)];
  put('(function(){');
  put(primitivesText);
  // 装载期一次性死代码：纯字面量/纯读表达式赋给下面唯一的新暂存，值永不再读，
  // 不触外部状态。形状（var/let/数组/三元/do-while/空循环）与数量（0~14）逐构建
  // 随机：新增的都是骨架里少见或没有的形态，专打归一化 bigram 分布。
  // 名 `_0<两字母><hex>` 每次现派、永不复用——let 重声明是 SyntaxError，固定名又怕与
  // 载荷 var 同名顶撞（同上 loader 本体保留 var 的理由）。
  {
    const junkNames = new Set();
    // 前缀逐构建随机（2026-10-11 改）。原先写死三个常量 `_0qz`/`_0qj`/`_0qx`：
    // 这些名字不进 randomizeNames 名单（引导器在流水线之外现拼），固定前缀本身
    // 就成了可 grep 的签名——实测每个产物残留 3~15 处。
    // 形状 `_0` + 两个随机小写字母 + 4 位 hex，与 loader 自己的定长名（_0L/_0N/_0P1…）
    // 和 mangle 的命名族（前缀池 + 4~8 位 hex，池里没有 `_0`+双字母这种形状）都不同形，
    // 所以连"被当成改名产物批量识别"也说不上；同形与否都不影响下面那道硬检查。
    // 字母池里**去掉 q**：旧签名正是 `_0q[zjx]`，留一个 q 就有约 0.4% 的概率
    // 摇回原来的形状，去掉后那条正则永远不可能命中（可写成断言）。
    // 撞名不看运气：名字逐个对着 mode.usedNames 查（obfuscate 会把载荷与各 pass
    // 生成的名字都写回那里），查到就重摇——所以摇出 `_0x…` 这种与改名产物同形的
    // 名字也不会与它顶撞。
    const junkLetters = 'abcdefghijklmnoprstuvwxyz';
    const junkLetter = () => junkLetters[randInt(0, junkLetters.length - 1)];
    const junkPrefs = [];
    while (junkPrefs.length < 3) {
      const p = '_0' + junkLetter() + junkLetter();
      if (junkPrefs.indexOf(p) < 0) junkPrefs.push(p);
    }
    const junkName = () => {
      let n;
      do { n = junkPrefs[randInt(0, junkPrefs.length - 1)] + randHex(4); }
      while (junkNames.has(n) || (mode && mode.usedNames && mode.usedNames.has(n)));
      junkNames.add(n);
      if (mode && mode.usedNames) mode.usedNames.add(n);
      return n;
    };
    const junkShapes = [
      () => 'var ' + junkName() + '=' + randInt(1, 999999) + ';',
      () => 'let ' + junkName() + '="qzx";',
      () => 'let ' + junkName() + '=[1,2,3,4];',
      () => 'let ' + junkName() + '=(11^22)>>>0;',
      // 只读恒有定义的顶层常量（_0L/_0N/_0P1/_0P2；_0CK 只在 ASCII 载荷时存在，
      // 死代码不能读它——中文载荷走 UTF-8 分支，没有 _0CK，读了就 ReferenceError）
      () => 'let ' + junkName() + '=_0N>0?_0L:_0N;',
      () => 'let ' + junkName() + '=_0L<=_0N?_0P1:_0P2;',
      () => { const a = junkName(); return 'let ' + a + '=0;do{' + a + '+=1;}while(' + a + '<0);'; },
      () => { const a = junkName(); return 'for(let ' + a + '=0;' + a + '<2;' + a + '+=1){}'; },
      () => { const a = junkName(); return 'var ' + a + '=0;while(2<' + a + '){break;}'; },
      // 空 switch：只读常量做判别，无 fallthrough、无副作用
      () => 'switch(_0N){default:break;}',
      () => { const a = junkName(); return 'let ' + a + '=_0N>0?(_0L>0?_0L:_0N):0;'; },
      () => 'let ' + junkName() + '=void 0;',
    ];
    const junkCount = randInt(0, 14);
    for (let ji = 0; ji < junkCount; ji++) put(junkShapes[randInt(0, junkShapes.length - 1)]());
  }
  // 原生函数单点收敛：下面用到的 String.fromCharCode / charCodeAt /
  // Uint8Array / Array 在此各取一次别名，调用点只写别名。静态扫
  // "fromCharCode" 这类指纹时命中从 N 处降到 1 处（声明行本身）。
  // 等价性：fromCharCode 是静态方法无需 receiver；charCodeAt 经闭包透传 receiver；
  // Uint8Array/Array 经别名 new 与直接 new 同内在（未被改写）。
  put(P([
    'var _0fc=String.fromCharCode;var _0cc=function(_0s9,_0k9){return _0s9.charCodeAt(_0k9);};var _0U8=Uint8Array;var _0Ar=Array;',
    'var _0fc=String.fromCharCode,_0U8=Uint8Array,_0Ar=Array;var _0cc=function(_0s9,_0k9){return _0s9.charCodeAt(_0k9);};',
  ]));
  // 原生性探针助手（classic 与 bytecode 两种形态共用）。判据是三条**互相独立**的路径，
  // 任一条不满足即视为被钩：
  //   ① 实例上的 toString 必须仍等于 Function.prototype.toString——自身属性被换过，
  //      就是最常见的一行式伪造：`hookedEval.toString=()=>'function eval(){[native code]}'`；
  //   ② 经**原型方法**（而不是实例属性）stringify 目标，源码里必须含 native；
  //   ③ 该原型方法 stringify 它自己，也必须含 native——堵住"整条原型被换、且会为
  //      自己伪造文本"这一层。
  // 旧写法 `(""+eval).indexOf('native')` 只走 ① 的反面（实例属性优先），一行就能骗过；
  // 三条都要过，攻击者得写出一致的多层谎言，而自动化工具体不会为此改。
  // 抛错一律判为被钩（fail-closed）：让探针抛错本身就是一种绕过手法。
  // 说明：这里刻意不用 try 包住 ①（它只读属性，不会抛）；`typeof` 两道先把
  // "Function.prototype.toString 被换成非函数""eval 在受限宿主里不存在"兜住。
  put(P([
    'var _0ph=function(_0f,_0n){var _0ts=Function.prototype.toString;'
    + 'if(typeof _0ts!=="function"||typeof _0f!=="function"){return 1;}'
    + 'if(_0f.toString!==_0ts){return 1;}'
    + 'try{if((""+_0ts.call(_0f)).indexOf(_0n)<0){return 1;}'
    + 'if((""+_0ts.call(_0ts)).indexOf(_0n)<0){return 1;}}catch(_0e){return 1;}'
    + 'return 0;};',
    'var _0ph=function(_0f,_0n){var _0ts=Function.prototype["toString"];'
    + 'if(typeof _0ts!=="function"||typeof _0f!=="function"){return 1;}'
    + 'if(_0f.toString!==_0ts){return 1;}'
    + 'try{if(0>((""+_0ts["call"](_0f)).indexOf(_0n))){return 1;}'
    + 'if(0>((""+_0ts["call"](_0ts)).indexOf(_0n))){return 1;}}catch(_0e){return 1;}'
    + 'return 0;};',
  ]));
  // 探针外壳：给"按字符串比 native"那条老路（字节码形态的 NCHK 只认 stringify 结果）
  // 用的可替换目标。它自身的 toString 走 _0ph，所以 stringify 出来含 needle 才代表
  // 原生未被钩；被钩时返回空串，NCHK 找不到 needle 即判为篡改。
  put(P([
    'var _0pw=function(_0f,_0n){var _0g=function(){};'
    + '_0g.toString=function(){return _0ph(_0f,_0n)?"":_0n;};return _0g;};',
    'var _0pw=function(_0f,_0n){var _0g=function(){};'
    + '_0g["toString"]=function(){return _0ph(_0f,_0n)?"":_0n;};return _0g;};',
  ]));
  put('var _0s2=' + s2 + ';');
  put(P(['var _0a="";var _0i,_0j,_0t;', 'var _0a="",_0i,_0j,_0t;']));
  // 字符串累加二形态（右部纯：别名调用无可见副作用，求值一次）。
  // 曾经的第三形态 `[a,b].join("")` 已删：它本身没问题，但模板字面量替代方案
  // 实测证明引导器里的模板经二次流水线（templateToConcat/stringArray 处理含
  // 表达式模板）会 corrupt 字母表、整包解出乱码——教训：loader 字符串模板只用
  // 引号字面量，不用反引号。join 因此只剩两处（shfl 尾与 ascii 快道，各 0/1）。
  const accA = (rhs) => P(['_0a+=' + rhs + ';', '_0a=_0a+' + rhs + ';']);
  // 计数循环四形态：for 正向 / for（Yoda 条件 + +=1）/ while / 展开 ×2。
  // 体内无 continue/break，把 update 搬到尾部与 for 逐位等价（见各调用点注释）。
  const alphaLoop = (limit, first) => P([
    'for(_0i=0;_0i<' + limit + ';_0i++){' + accA('_0fc(' + first + '+_0i)') + '}',
    'for(_0i=0;' + limit + '>_0i;_0i+=1){' + accA('_0fc(' + first + '+_0i)') + '}',
    '_0i=0;while(_0i<' + limit + '){' + accA('_0fc(' + first + '+_0i)') + '_0i+=1;}',
    // 展开 ×2：步长 2，体复制两份（i 与 i+1，右部纯、写不同槽）。只用于偶数界
    // （26/26/10），奇数界（_0SG/_0N/_0L 那几处）不碰——尾巴要另起分支，不值。
    'for(_0i=0;_0i<' + limit + ';_0i+=2){' + accA('_0fc(' + first + '+_0i)') + accA('_0fc(' + first + '+(_0i+1))') + '}',
  ]);
  put(alphaLoop(26, 65));
  put(alphaLoop(26, 97));
  put(alphaLoop(10, 48));
  put(P([
    '_0a+=_0fc(43,47);',
    '_0a=_0a+_0fc(43,47);',
    '_0a=[_0a,_0fc(43,47)].join("");',
  ]));
  // shfl 表派生尾：split+join 版与手工拆合版二选一。后者用下标建数组、
  // 累加拼回，不碰原生函数（_0a 全 ASCII，下标取码元与 split("") 一致）。
  // _0i 在此复用：顺序执行，前后都重新初始化，无干扰。
  put(P([
    '_0a=shfl(_0a.split(""),_0S[1]).join("");',
    'var _0sa=new _0Ar(_0a.length);for(_0i=0;_0i<_0a.length;_0i++){_0sa[_0i]=_0a[_0i];}'
    + '_0a=shfl(_0sa,_0S[1]);var _0sj="";for(_0i=0;_0i<_0a.length;_0i++){_0sj+=_0a[_0i];}_0a=_0sj;',
  ]));
  put(P([
    'var _0m2=new _0Ar(128);for(_0i=0;_0i<128;_0i++){_0m2[_0i]=-1;}',
    // Array(128) 与 new Array(128) 按规范逐位一致（普通 Array 调用即构造）
    'var _0m2=_0Ar(128);for(_0i=0;128>_0i;_0i+=1){_0m2[_0i]=-1;}',
    'var _0m2=new _0Ar(128);_0i=0;while(_0i<128){_0m2[_0i]=-1;_0i+=1;}',
    // 展开 ×2（128 偶数）：相邻两槽各写一次，顺序与逐个写一致
    'var _0m2=new _0Ar(128);for(_0i=0;_0i<128;_0i+=2){_0m2[_0i]=-1;_0m2[(_0i+1)]=-1;}',
  ]));
  put(P([
    'for(_0i=0;_0i<64;_0i++){_0m2[_0cc(_0a,_0i)]=_0i;}',
    'for(_0i=0;64>_0i;_0i+=1){_0m2[_0cc(_0a,_0i)]=_0i;}',
    '_0i=0;while(_0i<64){_0m2[_0cc(_0a,_0i)]=_0i;_0i+=1;}',
    // 展开 ×2（64 偶数）：两次查表走别名，写不同槽，右部纯
    'for(_0i=0;_0i<64;_0i+=2){_0m2[_0cc(_0a,_0i)]=_0i;_0m2[_0cc(_0a,(_0i+1))]=(_0i+1);}',
  ]));
  put(P([
    'var _0sb=new _0Ar(256);for(_0i=0;_0i<256;_0i++){_0sb[_0i]=_0i;}',
    'var _0sb=_0Ar(256);for(_0i=0;256>_0i;_0i+=1){_0sb[_0i]=_0i;}',
    'var _0sb=new _0Ar(256);_0i=0;while(_0i<256){_0sb[_0i]=_0i;_0i+=1;}',
    'var _0sb=new _0Ar(256);for(_0i=0;_0i<256;_0i+=2){_0sb[_0i]=_0i;_0sb[(_0i+1)]=(_0i+1);}',
  ]));
  put('_0sb=shfl(_0sb,_0S[0]);');
  put('var _0s3=' + s3 + ';'); // 第三密钥分片放在表派生之后，让声明散布开
  put(saltVar
    ? P(['var _0e=(_0s1^_0s2^_0s3)^(' + saltVar + '|0);',
        // xor 结合律换括号：整数异或逐位一致
        'var _0e=_0s1^((_0s2^_0s3)^(' + saltVar + '|0));'])
    : 'var _0e=_0s1^_0s2^_0s3;');
  put(P([
    'var _0d=new _0Ar(_0SG);for(_0i=0;_0i<_0SG;_0i++){_0d[_0i]=_0i;}',
    'var _0d=_0Ar(_0SG);for(_0i=0;_0SG>_0i;_0i+=1){_0d[_0i]=_0i;}',
  ]));
  put('_0d=shfl(_0d,_0S[2]);');
  if (bytecode) {
    // ================= 解码链 → 密文字节码 =================
    //
    // 这一支整体接管下面 else 里的解码链 A/B/C 三段（段装载+base64+交织落位、
    // 密钥流+校验尾差量、防篡改判定+投毒）。产物里这一段变成「一个通用栈式解释器
    // + 一堆不透明数字」：读代码看不出怎么解 base64、怎么交织、密钥流怎么算——
    // 那是 classic 形态下最薄的一环。外层解释器不认识 base64/交织/密钥流这些概念，
    // 只认识 PUSH/ADD/JMP；字节码还要靠那张逐构建随机的操作码表才能解码。
    //
    // 「字节→字符串」与「eval/import 交付」两段保持原样（下面 else 的后半段共用）——
    // 它们不是算法本体，改它们只会放大风险面。
    //
    // 正确性由 test/shell-bytecode.js 的三路对拍保证：手写参考 ⟷ 朴素 JS ⟷ 字节码。
    // 本函数只负责把「算好的输入灌进局部槽、调解释器取回 q」这一步接上。
    //
    // **解释器本体不进自混淆流水线**，与 jsfuck 预置同一个理由，但后果更严重：
    // 流水线会把 case 标签的数字字面量改写成带状态的逗号表达式
    // （controlFlow 的 assignState：`case M=M*14223+…,…^M^(…)`）。标签值于是依赖可变
    // 状态 `M`——该 case 执行一次后 M 变了，**第二次**分发到同一操作码时标签算出另一个
    // 值，落进 default 抛 "vm"。整个产物在跑完第一圈字节码后就死，且报错点（default
    // 分支）与病因隔了三层。所以解释器走 mode 交给 shellWrap 拼在流水线之外。
    const vmInputs = ['N', 'L', 'SG', 'P1', 'P2', 'HB', 'E', 'G', 'D', 'M2', 'SB', 'P_EVAL', 'P_FN'];
    const ir = buildDecodeChain({
      tailOrder,
      probeFunction: evalStyle === 1,
      junkMult: JUNK_MULT,
      posHash: ph,
      // 投毒公式的移位与遍历方向逐构建随机（公式自洽，任意取值都成立）；
      // 固定成一种写法会让这段新增代码成为跨 seed 的固定形态。
      scrShift: randInt(3, 29),
      scrDesc: randInt(0, 1) === 1,
    });
    const bcOp = shuffleOpCodes(randInt);
    const vm = emitVm(ir, { inputs: vmInputs, output: 'q', opmap: bcOp });
    const bcEnc = encryptWords(vm.words, randInt);
    // 新固定名必须进 banner.js 的 randomizeNames 名单，否则留成字面量指纹。
    // 解释器**整体在流水线之外**，所以 randomizeNames 够不着它，外层名字得自己随机
    // （前缀 + 9~13 位 hex，下界长于 mangle 命名族上界，撞名可忽略；长度同样随机，
    // 免得固定位宽成为形状指纹）——与 jsfuckCoreName 同法。
    // 解释器内部的短名（_w/_t/_c/_k/…）刻意不带 _0 前缀、也不随机化：它们属于
    // 「通用解释器」这一固定形态，变化由名字池与操作码表承担。
    const bcEval = evalStyle === 0 ? '(0,eval)' : 'Function("return eval")()';
    let bcFn;
    do { bcFn = (mode && mode.identifierPrefix ? mode.identifierPrefix : '_0x') + randHex(randInt(9, 13)); }
    while (mode && mode.usedNames && mode.usedNames.has(bcFn));
    if (mode && mode.usedNames) mode.usedNames.add(bcFn);
    mode.bytecodePrelude = 'var ' + bcFn + '=' + emitInterpreter({
      opmap: bcOp, key: bcEnc.key, k2: bcEnc.k2, outSlot: vm.outSlot, randInt,
    }) + ';';
    put('var _0bw=[' + bcEnc.data.join(',') + '];');
    // 原语表：前五项是引导器已声明的原语，后两项是**原生性探针目标**。
    // 第 6/7 项不是裸的 eval / Function，而是 _0pw 包出来的探针外壳：NCHK 只按
    // "stringify 后含不含 native"判定，外壳把三条独立路径的结论折成那一个字符串，
    // 于是"伪造实例 toString"这类一行式绕过在外壳里就被识破（见 _0ph 的注释）。
    // 交付用的 eval/Function 在 _0s2 那一段（evalTake），与本表无关。
    put('var _0bt=[xs32,mix,ipos,mul32,_0cc,_0pw(eval,' + NATIVE + '),_0pw(Function,'
      + NATIVE + ')];');
    // 常量池：原生性探针的针脚。走 _0fc 现拼，与 classic 形态同一口径，不留 'native' 明文。
    put('var _0bc=[' + NATIVE + '];');
    // 局部表：一次性给全长度并把非输入槽填 0。不填的话那些槽是「洞」，万一读到
    // 就是 undefined 而不是 0——静默算错的典型来源。输入槽直接填对应引导器变量。
    const vmLit = {
      N: '_0N', L: '_0L', SG: '_0SG', P1: '_0P1', P2: '_0P2', HB: '_0HB', E: '_0e',
      G: '_0g', D: '_0d', M2: '_0m2', SB: '_0sb', P_EVAL: bcEval, P_FN: 'Function',
    };
    const byIdx = new Array(vm.slotCount).fill('0');
    for (const k of vmInputs) byIdx[vm.slots[k]] = vmLit[k];
    put('var _0bl=[' + byIdx.join(',') + '];');
    put('var _0q=' + bcFn + '(_0bw,_0bt,_0bc,_0bl);');
  } else {
    if (decStyle === 0) {
      put(P(['var _0r=new _0U8(_0N);var _0n=0;var _0acc=0;var _0pc=0;var _0bd2=0;',
        'var _0r=new _0U8(_0N),_0n=0,_0acc=0,_0pc=0,_0bd2=0;']));
      put(P(['for(var _0j2=0;_0j2<_0SG;_0j2++){var _0sg=_0g[_0d[_0j2]];',
        'for(var _0j2=0;_0SG>_0j2;_0j2+=1){var _0sg=_0g[_0d[_0j2]];']));
      // 注意：内层 for 在此行不闭合（与原版同位），闭合在下面 `}}}` 行。
      // 查表经 _0cc 别名（直接点调用会把 charCodeAt 计数顶到 3，见棘轮注释）。
      put(P(['for(var _0q2=0;_0q2<_0sg.length;_0q2++){var _0c=_0m2[_0cc(_0sg,_0q2)];',
        'for(var _0q2=0;_0sg.length>_0q2;_0q2+=1){var _0c=_0m2[_0cc(_0sg,_0q2)];']));
      put(P(['if(_0c<0){_0bd2++;continue;}', 'if(0>_0c){_0bd2+=1;continue;}']));
      // 加法交换律只用于纯数字累加（_0acc/_0pc/_0c 全是数字，无拼接语义）
      put(P(['_0acc=_0acc*64+_0c;_0pc=_0pc+6;',
        '_0acc=_0c+_0acc*64;_0pc=6+_0pc;',
        '_0acc=_0c+64*_0acc;_0pc=_0pc+6;']));
      put(P(['if(_0pc>7){_0pc=_0pc-8;_0r[_0n]=(_0acc>>>_0pc)&255;_0n++;_0acc=_0acc&((1<<_0pc)-1);}}}',
        'if(7<_0pc){_0pc=_0pc-8;_0r[_0n]=(_0acc>>>_0pc)&255;_0n+=1;_0acc=_0acc&((1<<_0pc)-1);}}}']));
    } else {
      // 分段解码助手：每段独立解成（字节, 个数, 坏字符数），外层按原段序拼回。
      // 与内联版逐位一致：段长按 4 对齐使跨段无进位残留，坏字符分段计数再累加，
      // 掩码折叠式与内联版同一条（(1<<p)-1，p=0 时归零）。
      // 助手两形态：1 是 for 下标版，2 是 forEach 回调版（continue 在回调里非法，
      // 改成 if/else 嵌套，语义逐位一致；回调逐字符顺序执行，与下标版同序）。
      // split("") 按码元切分，段内容全是 ASCII base64，无代理对，切分与下标版一致。
      if (decStyle === 1) {
        put('var _0ds=function(_0s){var _0o=new _0U8(_0s.length);var _0da=0,_0dp=0,_0dc=0,_0de=0;'
          // 别名只替调用点，查表不能丢：_0cc 给的是码点，还要经 _0m2 映成 6 位值
          + 'for(var _0dk=0;_0dk<_0s.length;_0dk++){var _0dv=_0m2[_0cc(_0s,_0dk)];'
          + 'if(_0dv<0){_0de++;continue;}_0da=_0da*64+_0dv;_0dp+=6;'
          + 'if(_0dp>7){_0dp-=8;_0o[_0dc++]=(_0da>>>_0dp)&255;_0da&=(1<<_0dp)-1;}}'
          + 'return [_0o,_0dc,_0de];};');
      } else {
        put('var _0ds=function(_0s){var _0o=new _0U8(_0s.length);var _0da=0,_0dp=0,_0dc=0,_0de=0;'
          + '_0s.split("").forEach(function(_0ch){var _0dv=_0m2[_0cc(_0ch,0)];'
          + 'if(_0dv<0){_0de++;}else{_0da=_0da*64+_0dv;_0dp+=6;'
          + 'if(_0dp>7){_0dp-=8;_0o[_0dc++]=(_0da>>>_0dp)&255;_0da&=(1<<_0dp)-1;}}});'
          + 'return [_0o,_0dc,_0de];};');
      }
      put('var _0r=new _0U8(_0N),_0n=0,_0bd2=0;');
      if (decStyle === 1) {
        put(P(['for(var _0j2=0;_0j2<_0SG;_0j2++){var _0dr=_0ds(_0g[_0d[_0j2]]);'
          + '_0r.set(_0dr[0].subarray(0,_0dr[1]),_0n);_0n+=_0dr[1];_0bd2+=_0dr[2];}',
          'for(var _0j2=0;_0SG>_0j2;_0j2+=1){var _0dr=_0ds(_0g[_0d[_0j2]]);'
          + '_0r.set(_0dr[0].subarray(0,_0dr[1]),_0n);_0n+=_0dr[1];_0bd2+=_0dr[2];}']));
      } else {
        // C 外层换序：先累加偏移再用（_0n-_0dr[1] 还原段基址），与 B 的
        // "先拼后累加"逐位一致（同一 _0n 时间线，只是 set 行位置不同）。
        put(P(['for(var _0j2=0;_0j2<_0SG;_0j2++){var _0dr=_0ds(_0g[_0d[_0j2]]);'
          + '_0n+=_0dr[1];_0bd2+=_0dr[2];_0r.set(_0dr[0].subarray(0,_0dr[1]),_0n-_0dr[1]);}',
          'for(var _0j2=0;_0SG>_0j2;_0j2+=1){var _0dr=_0ds(_0g[_0d[_0j2]]);'
          + '_0bd2+=_0dr[2];_0n+=_0dr[1];_0r.set(_0dr[0].subarray(0,_0dr[1]),_0n-_0dr[1]);}']));
      }
    }
    put('var _0q=new _0U8(_0N);');
    if (jsfuckName) {
      // 与 classic 分支逐语句等价，只是整段搬进了 JSFuck 表达式求值出来的函数。
      // 原语按名传参（引导器作用域里的 xs32/mix/ipos），randomizeNames 会把它们
      // 与调用点一起改名，两边仍然对得上。
      put('var _0bd=' + jsfuckName + '(_0q,_0r,_0sb,_0N,_0L,_0P1,_0P2,_0HB,_0e,' + ph + ',' +
        tailOrder + ',xs32,mix,ipos);');
    } else {
      // 三个独立初值，声明合/分/换序逐位一致（右部互不引用）
      put(P(['var _0u=_0e>>>0;var _0pv=0;var _0h=_0HB>>>0;',
        'var _0u=_0e>>>0,_0pv=0,_0h=_0HB>>>0;',
        'var _0h=_0HB>>>0;var _0u=_0e>>>0;var _0pv=0;']));
      put(P(['for(var _0t2=0;_0t2<_0N;_0t2++){',
        'for(var _0t2=0;_0N>_0t2;_0t2+=1){']));
      // 整数加法结合律换括号：三数和 < 2^33，double 精确，>>>0 口径一致
      put(P(['_0u=xs32(_0u);_0u=(_0u+_0pv+_0t2)>>>0;',
        '_0u=xs32(_0u);_0u=(_0u+(_0pv+_0t2))>>>0;']));
      // xor 结合律换括号：int32 逐位一致
      put(P(['var _0kb=(_0u^(_0u>>>15)^(_0u>>>22))&255;',
        'var _0kb=(_0u^((_0u>>>15)^(_0u>>>22)))&255;']));
      put('var _0v=(_0sb[_0r[ipos(_0t2,_0P1,_0P2,_0N)]]^_0kb)&255;');
      // 链式赋值：右结合，先 _0pv=_0v 再写入槽，值与顺序逐位一致
      put(P(['_0q[_0t2]=_0v;_0pv=_0v;', '_0q[_0t2]=_0pv=_0v;']));
      put(P(['if(_0t2<_0L){_0h=mix(_0h,_0v,_0t2,' + ph + ');}}',
        'if(_0L>_0t2){_0h=mix(_0h,_0v,_0t2,' + ph + ');}}']));
      put(P(['var _0bd=(_0h^_0e^' + tailExpr + ')>>>0;',
        'var _0bd=(_0h^(_0e^' + tailExpr + '))>>>0;']));
    }
    put('_0bd=(_0bd^mul32(_0bd2,' + JUNK_MULT + '))>>>0;');
    put(P(['if(_0bd2>0&&_0bd===0){_0bd=1;}',
      'if(0<_0bd2&&0===_0bd){_0bd=1;}',
      'if(_0bd2>0&&0===_0bd){_0bd=1;}']));
    put(P(['if(_0ph(eval,' + NATIVE + ')){_0bd=(_0bd^(mul32(_0e^_0L,' + JUNK_MULT + ')||1))>>>0;}',
      'if(0<_0ph(eval,' + NATIVE + ')){_0bd=(_0bd^(mul32(_0e^_0L,' + JUNK_MULT + ')||1))>>>0;}']));
    if (evalStyle === 1) {
      put(P(['if(_0ph(Function,' + NATIVE + ')){_0bd=(_0bd^(mul32(_0e^_0N,' + JUNK_MULT + ')||1))>>>0;}',
        'if(0<_0ph(Function,' + NATIVE + ')){_0bd=(_0bd^(mul32(_0e^_0N,' + JUNK_MULT + ')||1))>>>0;}']));
    }
    // 投毒响应铺满整条密文（2026-10-11 改，与 shellir.js 同一口径）。
    // 原来只重掩前 ≤8 字节：攻击者把 8 个乱码字节补成合法前导（`!function`）就能
    // 救回整份载荷，于是原生探针、差分校验、FNV 尾校验全都只剩一个弱响应
    // （实测钩 eval 拿到 166 KB 明文，只有头部 8 字节坏）。现在按 _0bd 派生的
    // 滚动密钥异或全长度；_0bd===0（未改动）时不进分支，逐字节与改造前一致。
    //
    // 写法逐构建随机（头/循环方向/更新式/掩码拼写/右移位数）：这段是**新增的固定
    // 形态**，不换写法会拉高跨 seed 结构相似度（passes-basic 的棘轮立刻抓到）。
    // 公式自洽（生成端与运行端同一份），移位与方向任意取值都成立。
    {
      const scrShift = randInt(3, 29);
      const scrHead = P([
        'if(_0bd!==0){var _0u2=xs32(_0e^_0bd);',
        'if(0!==_0bd){var _0u2=xs32(_0e^_0bd);',
        'if(_0bd){var _0u2=xs32(_0e^_0bd);',
      ]);
      const scrLoop = randInt(0, 1) === 1
        ? P(['for(_0i=_0L-1;_0i>=0;_0i--){', 'for(_0i=_0L-1;0<=_0i;_0i-=1){'])
        : P(['for(_0i=0;_0i<_0L;_0i++){', 'for(_0i=0;_0L>_0i;_0i+=1){']);
      const scrUpd = P([
        '_0u2=xs32(_0u2^(_0bd^_0i));', '_0u2=xs32((_0u2^_0bd)^_0i);', '_0u2=xs32(_0u2^_0i^_0bd);',
      ]);
      const scrStore = P([
        '_0q[_0i]=(_0q[_0i]^(_0u2>>>' + scrShift + '))&255;}}',
        '_0q[_0i]=255&(_0q[_0i]^(_0u2>>>' + scrShift + '));}}',
      ]);
      put(scrHead + scrLoop + scrUpd);
      put(scrStore);
    }
    }
  // ↓↓↓ 以下「字节→字符串」与「eval/import 交付」两段两种形态共用 ↓↓↓
  if (plainIsAscii) {
    // 载荷字节全为 ASCII 时，默认产物经 escapeNonAscii 转义必为 ASCII，
    // UTF-8 解码退化为定长分块 fromCharCode。校验、密钥流、位置交织与投毒
    // 打碎逻辑一字不动，省掉每字节的三向分支状态机，那是引导器耗时的主要
    // 成分。块长在构建期随机，避免留下固定分块特征。
    put(P(['var _0s2="";var _0st=0;var _0en;', 'var _0s2="",_0st=0,_0en;']));
    // while(C) ↔ for(;C;)：无 init/update，逐位一致；注意本行只闭合内层 if，
    // 外层循环的闭合仍由下一行行末 `}` 完成（与原版同位）
    put(P(['while(_0st<_0L){_0en=_0st+_0CK;if(_0en>_0L){_0en=_0L;}',
      'for(;_0st<_0L;){_0en=_0CK+_0st;if(_0L<_0en){_0en=_0L;}']));
    put(P(['_0s2+=_0fc.apply(null,_0q.subarray(_0st,_0en));_0st=_0en;}',
      '_0s2=_0s2+_0fc["apply"](null,_0q["subarray"](_0st,_0en));_0st=_0en;}',
      '_0s2=[_0s2,_0fc.apply(null,_0q.subarray(_0st,_0en))].join("");_0st=_0en;}']));
  } else {
    put(P(['var _0s2="";var _0p=[];var _0y=0;', 'var _0s2="",_0p=[],_0y=0;']));
    // _0y++ 的值被用作下标，只动方向不动自增
    put(P(['while(_0y<_0L){var _0c2=_0q[_0y++];', 'for(;_0L>_0y;){var _0c2=_0q[_0y++];']));
    // push(v) ↔ v 进槽：语句位置、真数组、右部求值一次，三者齐了才恒等
    put(P(['if(_0c2<128){_0p.push(_0c2);}',
      'if(128>_0c2){_0p["push"](_0c2);}',
      'if(_0c2<128){_0p[_0p.length]=_0c2;}']));
    put(P(['else if(_0c2<224){_0p.push(((_0c2&31)<<6)|(_0q[_0y++]&63));}',
      'else if(224>_0c2){_0p[_0p.length]=(((_0c2&31)<<6)|(_0q[_0y++]&63));}']));
    put(P(['else if(_0c2<240){_0p.push(((_0c2&15)<<12)|((_0q[_0y++]&63)<<6)|(_0q[_0y++]&63));}',
      'else if(240>_0c2){_0p["push"](((_0c2&15)<<12)|((_0q[_0y++]&63)<<6)|(_0q[_0y++]&63));}']));
    put('else{var _0cp=(((_0c2&7)<<18)|((_0q[_0y++]&63)<<12)|((_0q[_0y++]&63)<<6)|(_0q[_0y++]&63))-65536;');
    // 双参 push 进双槽：两右部皆纯算术，各求值一次，顺序不变
    put(P(['_0p.push(55296+(_0cp>>10),56320+(_0cp&1023));}',
      '_0p[_0p.length]=55296+(_0cp>>10);_0p[_0p.length]=56320+(_0cp&1023);}']));
    put(P(['if(_0p.length>=512){_0s2+=_0fc.apply(null,_0p);_0p=[];}}',
      'if(512<=_0p.length){_0s2=[_0s2,_0fc["apply"](null,_0p)].join("");_0p=[];}}']));
    // length 是非负数字：if(n) ⟺ if(n!==0)，逐位一致
    put(P(['if(_0p.length){_0s2+=_0fc.apply(null,_0p);}',
      'if(_0p.length!==0){_0s2=_0s2+_0fc.apply(null,_0p);}']));
  }
  if (isCjs) {
    put('var _0cm={exports:{}};');
    put(cjsTake + '.call(_0cm.exports,typeof require==="function"?require:void 0,_0cm,_0cm.exports,"","",_0s2);');
  } else if (isEsm) {
    // import() 返回 Promise，这里不吞：吞了的话载荷里 top-level await 拒绝时会变成
    // unhandledrejection，模块的失败对调用方不可见。壳层只负责把字节还原出来，
    // 之后的事交给宿主。
    put(esmTake + ';');
  } else {
    put(evalTake + '(_0s2);');
  }
  put('})();');

  // 顶层常量声明合/分三形态：各右部互不引用，合分逐位一致（保留 var，
  // 理由见 P 的注释：载荷 eval 同作用域，let 会把同名复用变 SyntaxError）
  const constDecls = [
    'var _0s1=' + s1,
    'var _0S=[' + [SD_S, SD_T, SD_D] + ']',
    'var _0L=' + L,
    'var _0N=' + N,
    'var _0P1=' + P1,
    'var _0P2=' + P2,
    ...(plainIsAscii ? ['var _0CK=' + randInt(320, 704)] : []),
    'var _0HB=' + HB,
    'var _0SG=' + SG,
  ];
  const consts = P([
    constDecls.join(';') + ';var _0g=[' + gSlots.map((s) => JSON.stringify(s)).join(',') + '];',
    'var ' + constDecls.map((d) => d.replace(/^var /, '')).join(',') + ';var _0g=[' +
      gSlots.map((s) => JSON.stringify(s)).join(',') + '];',
    constDecls.slice(0, 4).join(';') + ';var ' +
      constDecls.slice(4).map((d) => d.replace(/^var /, '')).join(',') + ';var _0g=[' +
      gSlots.map((s) => JSON.stringify(s)).join(',') + '];',
  ]);
  return consts + B.join('');
}

/**
 * 套壳入口，对最终产物源码做 shellDepth 层递归套壳。
 * @param {string} code obfuscate 生成的最终源码
 * @param {object} options 原始构建选项，取其中的 shellDepth 与 shellForm
 * @param {(src:string, opts:object) => {code:string}} bootObfuscate
 *        对引导器再过一遍流水线的回调，由 obfuscate.js 注入，防递归标志已在
 *        其中固定为 shell:false
 * @param {Set<string>} [usedNames] 产物已占用的名字集合（ctx.usedNames）。传进来
 *        才能让 bcFn 的撞名守卫真正生效：原先 shellWrap 不设 mode.usedNames，
 *        那个 do/while 恒为假，解释器全局名只能靠"9 位 hex 够长"兜着。
 * @returns {{code:string, layers:number, jsfuckChars:number}} 套壳后的源码、
 *        实际层数与 jsfuck 预置的字符数（0 表示 classic 形态）
 */
function shellWrap(code, options, bootObfuscate, cjs, esm, usedNames) {
  const depth = Math.max(1, options.shellDepth | 0 || 1);
  const jsfuck = options.shellForm === 'jsfuck';
  const jfUsed = new Set();
  let layers = 0;
  let jsfuckChars = 0;
  let cur = code;
  for (let l = 0; l < depth; l++) {
    // esm 与 cjs 互斥：ESM 载荷本来就没有自由 CommonJS 绑定，且 import() 放行
    // 时那几个形参也无从谈起。每一层都继承形态——内层壳解密出来的是外层壳的
    // 源码，它同样需要 import() 才能跑。
    const mode = {
      cjs: !esm && !!cjs, esm: !!esm, identifierPrefix: options.identifierPrefix, usedNames,
    };
    let pre = '';
    // jsfuck 与 bytecode 互斥：jsfuck 改的正是「密钥流 + 校验尾」那段**明文**语句，
    // 而 bytecode 形态里那段已经不在明文里了。两者同时要时以 bytecode 为准——
    // 它把整条链都搬走，jsfuck 的预置就无处可作用了。
    const useBytecode = options.shellForm === 'bytecode';
    if (jsfuck && !useBytecode) {
      mode.jsfuck = true;
      mode.jsfuckName = jsfuckCoreName(jfUsed, options.identifierPrefix);
      pre = jsfuckPrelude(mode.jsfuckName);
      jsfuckChars += pre.length;
    }
    const boot = makeShellLayer(cur, useBytecode ? { bytecode: true } : undefined, mode);
    // 字节码解释器预置：与 jsfuck 预置同理拼在流水线之外。理由见 makeShellLayer 里
    // 那段注释——流水线会把 case 标签的数字改写成带状态的表达式，标签就不再稳定。
    if (mode.bytecodePrelude) pre = mode.bytecodePrelude + pre;
    // 预置留在流水线之外：见 jsfuckPrelude 的说明。它必须先于引导层执行，
    // 否则引导层读到的全局名还是 undefined。
    const out = bootObfuscate ? bootObfuscate(boot, options).code : boot;
    cur = pre + out;
    layers++;
  }
  return { code: cur, layers, jsfuckChars };
}

// 默认导出是 shellWrap 函数，其余原语挂在函数对象上一并导出
shellWrap.makeShellLayer = makeShellLayer;
shellWrap.b64encode = b64encode;
shellWrap.mul32 = mul32;
shellWrap.utf8Bytes = utf8Bytes;
shellWrap.utf8Decode = utf8Decode;
shellWrap.PRIMITIVES = PRIMITIVES_TEXT;
shellWrap.buildPrimitivesText = buildPrimitivesText;
shellWrap.jsfuckCoreName = jsfuckCoreName;
shellWrap.jsfuckPrelude = jsfuckPrelude;
shellWrap.JSFUCK_CORE = JSFUCK_CORE;
shellWrap.JSFUCK_MAX_CHARS = JSFUCK_MAX_CHARS;

export default shellWrap;
export { makeShellLayer, b64encode, mul32, utf8Bytes, utf8Decode };
