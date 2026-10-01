/**
 * 纯 JS 的 Ed25519 签名与验签，零依赖、全同步。
 *
 * 为什么要自己实现：许可证签名原本是 HMAC-SHA256（对称），浏览器端本地校验必须
 * 持有同一把密钥，而密钥随静态资源公开——拿到它的人可以自己签发任意套餐的卡密。
 * 换非对称后，浏览器只放公钥，纵使被完整读走也签不出新卡。
 *
 * 为什么不用 node:crypto：卡密与令牌的验签必须在 Node、浏览器与服务端
 * Workers 上得到逐位相同的结果，而 node:crypto 只在 Node 可用、WebCrypto 的
 * 接口又是异步的，两条路都进不了现有的同步校验路径（同 utils/hash.js 的理由）。
 *
 * 实现依据 RFC 8032。曲线是 twisted Edwards 曲线 edwards25519：
 *   -x^2 + y^2 = 1 + d*x^2*y^2，d = -121665/121666
 * 采用扩展坐标 (X:Y:Z:T) 做点运算，避免每次求逆。
 *
 * 与 node:crypto 的等价性由 test/hashtest.js 覆盖（RFC 8032 测试向量 +
 * 随机往返）。
 */

import { sha512Bytes } from './hash.js';

/** 域素数 p = 2^255 - 19。 */
const P = (1n << 255n) - 19n;

/** 群阶 L = 2^252 + 27742317777372353535851937790883648493。 */
const L = (1n << 252n) + 27742317777372353535851937790883648493n;

/** 曲线常数 d = -121665/121666 mod p。 */
const D = mod(-121665n * inv(121666n));

/** 2 的 (p-1)/4 次方，用于开平方。 */
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

/** 单位元 (0, 1, 1, 0)。 */
const IDENTITY = { X: 0n, Y: 1n, Z: 1n, T: 0n };

/** 生成元的 y 坐标。 */
const BY = mod(4n * inv(5n));
/**
 * 生成元的 x 坐标。
 *
 * 开平方会得到互为相反数的两个根，RFC 8032 规定基点取 x 为偶的那一个。
 * 取错根会得到 -B：点运算照常成立、自签自验也能通过，但公钥与签名与所有外部
 * 实现都不兼容，测试向量会全数失败。
 */
const BX = recoverX(BY, 0n);

/** 基点（生成元）。 */
const BASE = { X: BX, Y: BY, Z: 1n, T: mod(BX * BY) };

/** mod p 取正余数。 */
function mod(a) {
  const r = a % P;
  return r < 0n ? r + P : r;
}

/**
 * mod L（群阶）取正余数。
 *
 * 标量一律按 L 归约，不能按 P：两个模数差着一个数量级，用错会让 S 与 k 落到
 * 错误的同余类里。公钥派生只用得到 P（坐标运算），签名与验签的标量必须走 L。
 * 二者混用时的表现是"公钥对、签名全错"。
 */
function modL(a) {
  const r = a % L;
  return r < 0n ? r + L : r;
}

/** 模逆，Fermat 小定理。 */
function inv(a) {
  return pow(mod(a), P - 2n);
}

/** 模幂，平方乘。 */
function pow(b, e) {
  let r = 1n;
  let x = mod(b);
  let n = e;
  while (n > 0n) {
    if (n & 1n) r = (r * x) % P;
    x = (x * x) % P;
    n >>= 1n;
  }
  return r;
}

/**
 * 由 y 与符号位还原 x 坐标，解 x^2 = (y^2 - 1) / (d*y^2 + 1)。
 *
 * @param {bigint} y y 坐标
 * @param {bigint} sign 符号位，0 取偶根，1 取奇根
 * @returns {bigint} x 坐标，无解时抛错
 */
function recoverX(y, sign) {
  const y2 = mod(y * y);
  const num = mod(y2 - 1n);
  const den = mod(D * y2 + 1n);
  const x2 = mod(num * inv(den));
  // p ≡ 5 (mod 8)，所以候选根是 x2^((p+3)/8)；若它的平方不是 x2，就乘 sqrt(-1) 换另一个根。
  // 注意比较的是 mod(x*x) 与 x2，不能写成 mod(x*x - x2) !== 0n——那样两边都过了 mod，
  // 判断方向就错了，会一路走错分支（基点的 x 取到 -B，与所有外部实现不兼容）。
  let x = pow(x2, (P + 3n) / 8n);
  if (mod(x * x) !== x2) x = mod(x * SQRT_M1);
  if (mod(x * x) !== x2) throw new Error('ed25519: invalid point');
  if ((x & 1n) !== (sign & 1n)) x = mod(-x);
  return x;
}

/** 扩展坐标点加法。 */
function addPoint(p, q) {
  const A = mod((p.Y - p.X) * (q.Y - q.X));
  const B = mod((p.Y + p.X) * (q.Y + q.X));
  const C = mod(2n * p.T * q.T * D);
  const Dd = mod(2n * p.Z * q.Z);
  const E = mod(B - A);
  const F = mod(Dd - C);
  const G = mod(Dd + C);
  const H = mod(B + A);
  return {
    X: mod(E * F), Y: mod(G * H), Z: mod(F * G), T: mod(E * H),
  };
}

/** 扩展坐标点取负。 */
function negPoint(p) {
  return {
    X: mod(-p.X), Y: p.Y, Z: p.Z, T: mod(-p.T),
  };
}

/**
 * 标量乘，double-and-add。
 * @param {object} p 点
 * @param {bigint} e 标量
 * @returns {object} 结果点
 */
function mulPoint(p, e) {
  let r = IDENTITY;
  let q = p;
  let n = e;
  while (n > 0n) {
    if (n & 1n) r = addPoint(r, q);
    q = addPoint(q, q);
    n >>= 1n;
  }
  return r;
}

/** 点编码为 32 字节小端，y 的最高位存 x 的符号。 */
function encodePoint(p) {
  const zi = inv(p.Z);
  const x = mod(p.X * zi);
  const y = mod(p.Y * zi);
  const out = new Uint8Array(32);
  let v = y;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (x & 1n) out[31] |= 0x80;
  return out;
}

/** 32 字节解码为点。 */
function decodePoint(bytes) {
  if (bytes.length !== 32) throw new Error('ed25519: bad point length');
  let v = 0n;
  for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  const sign = (v >> 255n) & 1n;
  const y = mod(v & ((1n << 255n) - 1n));
  const x = recoverX(y, sign);
  return { X: x, Y: y, Z: 1n, T: mod(x * y) };
}

/**
 * 小端字节转 BigInt。
 * @param {Uint8Array} bytes 输入
 * @param {boolean} [le] 是否小端，默认 true
 * @returns {bigint} 整数
 */
function bytesToBig(bytes, le = true) {
  let v = 0n;
  if (le) {
    for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  } else {
    for (let i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i]);
  }
  return v;
}

/**
 * BigInt 转定长小端字节。
 * @param {bigint} v 整数
 * @param {number} len 目标长度
 * @returns {Uint8Array} 字节
 */
function bigToBytes(v, len) {
  const out = new Uint8Array(len);
  let n = v;
  for (let i = 0; i < len; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/** 拼接多个字节数组。 */
function concatBytes(...chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/**
 * 由 32 字节种子派生密钥对（RFC 8032 §5.1.5）。
 * @param {Uint8Array} seed 32 字节种子
 * @returns {{publicKey:Uint8Array, scalar:bigint, prefix:Uint8Array}} 密钥对
 */
function keyFromSeed(seed) {
  if (seed.length !== 32) throw new Error('ed25519: seed must be 32 bytes');
  const h = sha512Bytes(seed);
  // 前 32 字节做钳位
  const scalar = bytesToBig(clamp(h.slice(0, 32)));
  const prefix = h.slice(32, 64);
  const pub = encodePoint(mulPoint(BASE, scalar));
  return { publicKey: pub, scalar, prefix };
}

/** 标量钳位（RFC 8032 §5.1.5）。 */
function clamp(h) {
  const out = h.slice();
  out[0] &= 248;
  out[31] &= 127;
  out[31] |= 64;
  return out;
}

/**
 * 由种子派生公钥。
 * @param {Uint8Array} seed 32 字节种子
 * @returns {Uint8Array} 32 字节公钥
 */
export function ed25519PublicKeyFromSeed(seed) {
  return keyFromSeed(seed).publicKey;
}

/**
 * Ed25519 签名（RFC 8032 §5.1.6，PureEdDSA）。
 * @param {Uint8Array} message 待签消息
 * @param {Uint8Array} seed 32 字节种子（私钥）
 * @returns {Uint8Array} 64 字节签名
 */
export function ed25519Sign(message, seed) {
  const { publicKey, scalar, prefix } = keyFromSeed(seed);
  // r 与 k 都按群阶 L 归约（RFC 8032 §5.1.6 第 2、5 步）
  const r = modL(bytesToBig(sha512Bytes(concatBytes(prefix, message))));
  const R = encodePoint(mulPoint(BASE, r));
  const k = modL(bytesToBig(sha512Bytes(concatBytes(R, publicKey, message))));
  const S = modL(r + k * scalar);
  return concatBytes(R, bigToBytes(S, 32));
}

/**
 * Ed25519 验签（RFC 8032 §5.1.7）。
 *
 * 检查 [S]B = R + [k]A。S 必须先按群阶归约后校验，否则签名里的 S 加一个 L 的
 * 倍数仍是"合法"的，同一条消息会有多个可通过的签名（可延展性）。
 *
 * @param {Uint8Array} signature 64 字节签名
 * @param {Uint8Array} message 消息
 * @param {Uint8Array} publicKey 32 字节公钥
 * @returns {boolean} 是否有效
 */
export function ed25519Verify(signature, message, publicKey) {
  try {
    if (signature.length !== 64 || publicKey.length !== 32) return false;
    const R = signature.slice(0, 32);
    const S = bytesToBig(signature.slice(32, 64));
    // S 必须 < L，否则拒绝
    if (S >= L) return false;
    const A = decodePoint(publicKey);
    const Rpoint = decodePoint(R);
    const k = modL(bytesToBig(sha512Bytes(concatBytes(R, publicKey, message))));
    const lhs = mulPoint(BASE, S);
    const rhs = addPoint(Rpoint, mulPoint(A, k));
    return pointEqual(lhs, rhs);
  } catch (e) {
    return false;
  }
}

/**
 * 扩展坐标点相等判定。
 *
 * 用交叉相乘避免两次模逆：X1/Z1 == X2/Z2 等价于 X1*Z2 == X2*Z1。模逆是一次
 * 模幂，比几次乘法贵得多，验签热路径上省下来很明显。
 */
function pointEqual(p, q) {
  return mod(p.X * q.Z) === mod(q.X * p.Z) && mod(p.Y * q.Z) === mod(q.Y * p.Z);
}

export default {
  ed25519PublicKeyFromSeed,
  ed25519Sign,
  ed25519Verify,
};
