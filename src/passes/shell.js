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
const { randInt, randHex } = rand;
import i18n from '../i18n.js';
import { jsfuckProgram, decodeStrExpr } from './jsfuck.js';

const B64_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// 共享原语，参数为无符号 32 位或有限整数，构建期与运行期行为逐位一致。
//
// PRIMITIVES 是**产物里那份文本**，逐字进引导器；下面的直接实现是它在构建期的
// 等价物。原先这里用 (0, eval)(...) 把这段文本当场求值，好处是"同一份文本"
// 天然不会漂移，但浏览器的 CSP 与不少函数运行时禁止一切字符串代码生成——eval 与
// new Function 一律被拒，跑起来直接报 EvalError: Code generation from strings
// disallowed。改成手写等价实现后，"不漂移"由
// tools/test/selftest.js 里那条逐位比对来保证（Node 允许 eval，正好用来当参照）。
const PRIMITIVES = [
  'function mul32(_0a,_0b){_0a=_0a>>>0;_0b=_0b>>>0;var _0l=_0a&65535,_0h=_0a>>>16;',
  'return ((_0l*_0b)+(((_0h*_0b)&65535)<<16))>>>0;}',
  'function lcg(_0x){return (mul32(_0x>>>0,1103515245)+12345)>>>0;}',
  'function xs32(_0u){_0u^=_0u<<13;_0u^=_0u>>>17;_0u^=_0u<<5;return _0u>>>0;}',
  'function shfl(_0a,_0s){var _0x=_0s>>>0;',
  'for(var _0i=_0a.length-1;_0i>0;_0i--){_0x=lcg(_0x);var _0j=_0x%(_0i+1);',
  'var _0t=_0a[_0i];_0a[_0i]=_0a[_0j];_0a[_0j]=_0t;}return _0a;}',
  'function ipos(_0t,_0P1,_0P2,_0N){return (((_0t*_0P1)%_0N)*_0P2)%_0N;}',
  'function mix(_0h,_0v,_0t,_0ph){_0h=mul32(_0h^_0v,16777619);',
  'if(_0ph){_0h=mul32(_0h^(_0t&255),16777619);}return _0h>>>0;}',
].join('');

/** 32 位精确乘法，构建期使用，与引导器内 mul32 出自同一份文本。 */
function mul32(_0a, _0b) {
  _0a = _0a >>> 0;
  _0b = _0b >>> 0;
  const _0l = _0a & 65535;
  const _0h = _0a >>> 16;
  return ((_0l * _0b) + (((_0h * _0b) & 65535) << 16)) >>> 0;
}

function lcg(_0x) { return (mul32(_0x >>> 0, 1103515245) + 12345) >>> 0; }

function xs32(_0u) {
  _0u ^= _0u << 13;
  _0u ^= _0u >>> 17;
  _0u ^= _0u << 5;
  return _0u >>> 0;
}

function shfl(_0a, _0s) {
  let _0x = _0s >>> 0;
  for (let _0i = _0a.length - 1; _0i > 0; _0i--) {
    _0x = lcg(_0x);
    const _0j = _0x % (_0i + 1);
    const _0t = _0a[_0i];
    _0a[_0i] = _0a[_0j];
    _0a[_0j] = _0t;
  }
  return _0a;
}

function ipos(_0t, _0P1, _0P2, _0N) { return (((_0t * _0P1) % _0N) * _0P2) % _0N; }

function mix(_0h, _0v, _0t, _0ph) {
  _0h = mul32(_0h ^ _0v, 16777619);
  if (_0ph) { _0h = mul32(_0h ^ (_0t & 255), 16777619); }
  return _0h >>> 0;
}

/** 原语表。调用点按名字取，与 PRIMITIVES 导出的那组同名同序。 */
const RT = { mul32, lcg, xs32, shfl, ipos, mix };

/**
 * 引导器原语文本，导出给自测用。
 *
 * 自测在 Node 下把它 eval 出来，与上面那组直接实现逐位比对，作为"两份实现
 * 不会漂移"的保证。eval 只出现在 tools/test/selftest.js 里——那里不随 Worker
 * 上传，而核心模块图里连一处字符串代码生成都不能留。
 */
export const PRIMITIVES_TEXT = PRIMITIVES;

/** 直接实现的那组原语，导出给自测比对。 */
export const primitivesDirect = RT;

const JUNK_MULT = 2654435761; // 差量与非法计数混入密钥流种子的常数，两侧共用


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
 * _0bd（差量）。原语与表一律**当参数传进来**（xs/mx/ip）而不在核心内重写一份：
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
 * 遮掉，产物在运行期才炸。这里固定 `<前缀>+9 位 hex`（13 字符），长于 mangle
 * 的命名族上界，撞名概率可忽略。
 */
export function jsfuckCoreName(used, prefix) {
  let name;
  do {
    name = (prefix || '_0x') + randHex(9);
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
 * 必须由调用方拼在**流水线之外**：这段表达式里上万次调用一旦过 callProxy，
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
 * @param {{tailOrder?:number, evalStyle?:number, posHash?:number}} [variant]
 *        层形态变体，tailOrder 为校验尾字节序（0 大端，1 小端），evalStyle
 *        为取值器形态（0 用 (0,eval)，1 用 Function 间接取器），posHash 决定
 *        FNV 是否混合位置；省略时随机
 * @param {{cjs?:boolean}} [mode] cjs 为真时用「带 CommonJS 形参的函数内直接
 *        eval」放行载荷：require/module/exports/__dirname/__filename 因此在
 *        载荷作用域内可用，`var` 声明也不再落进全局
 * @returns {string} 引导器源码，自执行，末尾复原并 eval 载荷
 */
function makeShellLayer(payload, variant, mode) {
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
  const NATIVE = 'String.fromCharCode(110,97,116,105,118,101)'; // 拼出 native
  const tailExpr = tailOrder === 0
    ? '(((_0q[_0L]<<24)|(_0q[_0L+1]<<16)|(_0q[_0L+2]<<8)|_0q[_0L+3])>>>0)'
    : '(((_0q[_0L+3]<<24)|(_0q[_0L+2]<<16)|(_0q[_0L+1]<<8)|_0q[_0L])>>>0)';
  const isCjs = !!(mode && mode.cjs);
  const evalTake = evalStyle === 0 ? '(0,eval)' : 'Function("return eval")()';
  // CommonJS 载荷：形参名必须与载荷引用的绑定名逐字一致，直接 eval 才能看见它们
  const cjsTake = 'Function("require","module","exports","__dirname","__filename","payload","return eval(payload)")';

  const B = [];
  const put = (...xs) => B.push(...xs);
  put('(function(){');
  put(PRIMITIVES);
  put('var _0s2=' + s2 + ';');
  put('var _0a="";var _0i,_0j,_0t;');
  put('for(_0i=0;_0i<26;_0i++){_0a+=String.fromCharCode(65+_0i);}');
  put('for(_0i=0;_0i<26;_0i++){_0a+=String.fromCharCode(97+_0i);}');
  put('for(_0i=0;_0i<10;_0i++){_0a+=String.fromCharCode(48+_0i);}');
  put('_0a+=String.fromCharCode(43,47);_0a=shfl(_0a.split(""),_0S[1]).join("");');
  put('var _0m2=new Array(128);for(_0i=0;_0i<128;_0i++){_0m2[_0i]=-1;}');
  put('for(_0i=0;_0i<64;_0i++){_0m2[_0a.charCodeAt(_0i)]=_0i;}');
  put('var _0sb=new Array(256);for(_0i=0;_0i<256;_0i++){_0sb[_0i]=_0i;}');
  put('_0sb=shfl(_0sb,_0S[0]);');
  put('var _0s3=' + s3 + ';'); // 第三密钥分片放在表派生之后，让声明散布开
  put(saltVar
    ? 'var _0e=(_0s1^_0s2^_0s3)^(' + saltVar + '|0);'
    : 'var _0e=_0s1^_0s2^_0s3;');
  put('var _0d=new Array(_0SG);for(_0i=0;_0i<_0SG;_0i++){_0d[_0i]=_0i;}');
  put('_0d=shfl(_0d,_0S[2]);');
  put('var _0r=new Uint8Array(_0N);var _0n=0;var _0acc=0;var _0pc=0;var _0bd2=0;');
  put('for(var _0j2=0;_0j2<_0SG;_0j2++){var _0sg=_0g[_0d[_0j2]];');
  put('for(var _0q2=0;_0q2<_0sg.length;_0q2++){var _0c=_0m2[_0sg.charCodeAt(_0q2)];');
  put('if(_0c<0){_0bd2++;continue;}');
  put('_0acc=_0acc*64+_0c;_0pc=_0pc+6;');
  put('if(_0pc>7){_0pc=_0pc-8;_0r[_0n]=(_0acc>>>_0pc)&255;_0n++;_0acc=_0acc&((1<<_0pc)-1);}}}');
  put('var _0q=new Uint8Array(_0N);');
  if (jsfuckName) {
    // 与 classic 分支逐语句等价，只是整段搬进了 JSFuck 表达式求值出来的函数。
    // 原语按名传参（引导器作用域里的 xs32/mix/ipos），randomizeNames 会把它们
    // 与调用点一起改名，两边仍然对得上。
    put('var _0bd=' + jsfuckName + '(_0q,_0r,_0sb,_0N,_0L,_0P1,_0P2,_0HB,_0e,' + ph + ',' +
      tailOrder + ',xs32,mix,ipos);');
  } else {
    put('var _0u=_0e>>>0;var _0pv=0;var _0h=_0HB>>>0;');
    put('for(var _0t2=0;_0t2<_0N;_0t2++){');
    put('_0u=xs32(_0u);_0u=(_0u+_0pv+_0t2)>>>0;');
    put('var _0kb=(_0u^(_0u>>>15)^(_0u>>>22))&255;');
    put('var _0v=(_0sb[_0r[ipos(_0t2,_0P1,_0P2,_0N)]]^_0kb)&255;');
    put('_0q[_0t2]=_0v;_0pv=_0v;');
    put('if(_0t2<_0L){_0h=mix(_0h,_0v,_0t2,' + ph + ');}}');
    put('var _0bd=(_0h^_0e^' + tailExpr + ')>>>0;');
  }
  put('_0bd=(_0bd^mul32(_0bd2,' + JUNK_MULT + '))>>>0;');
  put('if(_0bd2>0&&_0bd===0){_0bd=1;}');
  put('if((""+eval).indexOf(' + NATIVE + ')<0){_0bd=(_0bd^(mul32(_0e^_0L,' + JUNK_MULT + ')||1))>>>0;}');
  if (evalStyle === 1) {
    put('if((""+Function).indexOf(' + NATIVE + ')<0){_0bd=(_0bd^(mul32(_0e^_0N,' + JUNK_MULT + ')||1))>>>0;}');
  }
  put('if(_0bd!==0){var _0u2=xs32(_0e^_0bd);var _0lim=_0L<8?_0L:8;');
  put('for(_0i=0;_0i<_0lim;_0i++){_0u2=xs32(_0u2^_0bd^_0i);_0q[_0i]=(_0q[_0i]^(_0u2>>>11))&255;}}');
  if (plainIsAscii) {
    // 载荷字节全为 ASCII 时，默认产物经 escapeNonAscii 转义必为 ASCII，
    // UTF-8 解码退化为定长分块 fromCharCode。校验、密钥流、位置交织与投毒
    // 打碎逻辑一字不动，省掉每字节的三向分支状态机，那是引导器耗时的主要
    // 成分。块长在构建期随机，避免留下固定分块特征。
    put('var _0s2="";var _0st=0;var _0en;');
    put('while(_0st<_0L){_0en=_0st+_0CK;if(_0en>_0L){_0en=_0L;}');
    put('_0s2+=String.fromCharCode.apply(null,_0q.subarray(_0st,_0en));_0st=_0en;}');
  } else {
    put('var _0s2="";var _0p=[];var _0y=0;');
    put('while(_0y<_0L){var _0c2=_0q[_0y++];');
    put('if(_0c2<128){_0p.push(_0c2);}');
    put('else if(_0c2<224){_0p.push(((_0c2&31)<<6)|(_0q[_0y++]&63));}');
    put('else if(_0c2<240){_0p.push(((_0c2&15)<<12)|((_0q[_0y++]&63)<<6)|(_0q[_0y++]&63));}');
    put('else{var _0cp=(((_0c2&7)<<18)|((_0q[_0y++]&63)<<12)|((_0q[_0y++]&63)<<6)|(_0q[_0y++]&63))-65536;');
    put('_0p.push(55296+(_0cp>>10),56320+(_0cp&1023));}');
    put('if(_0p.length>=512){_0s2+=String.fromCharCode.apply(null,_0p);_0p=[];}}');
    put('if(_0p.length){_0s2+=String.fromCharCode.apply(null,_0p);}');
  }
  if (isCjs) {
    put('var _0cm={exports:{}};');
    put(cjsTake + '.call(_0cm.exports,typeof require==="function"?require:void 0,_0cm,_0cm.exports,"","",_0s2);');
  } else {
    put(evalTake + '(_0s2);');
  }
  put('})();');

  const consts =
    'var _0s1=' + s1 + ';var _0S=[' + [SD_S, SD_T, SD_D] + '];' +
    'var _0L=' + L + ';var _0N=' + N + ';var _0P1=' + P1 + ';var _0P2=' + P2 + ';' +
    (plainIsAscii ? 'var _0CK=' + randInt(320, 704) + ';' : '') +
    'var _0HB=' + HB + ';var _0SG=' + SG + ';var _0g=[' +
    gSlots.map((s) => JSON.stringify(s)).join(',') + '];';
  return consts + B.join('');
}

/**
 * 套壳入口，对最终产物源码做 shellDepth 层递归套壳。
 * @param {string} code obfuscate 生成的最终源码
 * @param {object} options 原始构建选项，取其中的 shellDepth 与 shellForm
 * @param {(src:string, opts:object) => {code:string}} bootObfuscate
 *        对引导器再过一遍流水线的回调，由 obfuscate.js 注入，防递归标志已在
 *        其中固定为 shell:false
 * @returns {{code:string, layers:number, jsfuckChars:number}} 套壳后的源码、
 *        实际层数与 jsfuck 预置的字符数（0 表示 classic 形态）
 */
function shellWrap(code, options, bootObfuscate, cjs) {
  const depth = Math.max(1, options.shellDepth | 0 || 1);
  const jsfuck = options.shellForm === 'jsfuck';
  const jfUsed = new Set();
  let layers = 0;
  let jsfuckChars = 0;
  let cur = code;
  for (let l = 0; l < depth; l++) {
    const mode = { cjs: !!cjs };
    let pre = '';
    if (jsfuck) {
      mode.jsfuck = true;
      mode.jsfuckName = jsfuckCoreName(jfUsed, options.identifierPrefix);
      pre = jsfuckPrelude(mode.jsfuckName);
      jsfuckChars += pre.length;
    }
    const boot = makeShellLayer(cur, undefined, mode);
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
shellWrap.PRIMITIVES = PRIMITIVES;
shellWrap.jsfuckCoreName = jsfuckCoreName;
shellWrap.jsfuckPrelude = jsfuckPrelude;
shellWrap.JSFUCK_CORE = JSFUCK_CORE;
shellWrap.JSFUCK_MAX_CHARS = JSFUCK_MAX_CHARS;

export default shellWrap;
export { makeShellLayer, b64encode, mul32, utf8Bytes, utf8Decode, PRIMITIVES };
