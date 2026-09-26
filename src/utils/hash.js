/**
 * 纯 JS 的 SHA-256、SHA-512 与 HMAC-SHA256，零依赖、全同步。
 *
 * 卡密与许可证令牌的验签必须在 Node、浏览器与服务端上得到逐位
 * 相同的结果，而 node:crypto 只在 Node 可用、WebCrypto 的接口又是异步的，两条
 * 路都进不了现有的同步校验路径。这里自己实现一份，三端同一份代码，也不再有
 * 运行期依赖。
 *
 * SHA-512 是 Ed25519 的内部哈希（RFC 8032 §5.1.5 规定用 SHA-512 摘要私钥），
 * 少了它就没法把签名换成非对称。
 *
 * 与 node:crypto 的等价性由 tools/test/hashtest.js 覆盖（SHA-256、SHA-512、HMAC、
 * 空串、长密钥、超 64 字节密钥、中文与代理对）。
 */

/** SHA-256 轮常量。 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 初始状态。 */
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/** HMAC 分块长度，SHA-256 固定 64 字节。 */
const BLOCK = 64;

/**
 * UTF-8 编码，返回字节数组。
 *
 * 与 Buffer.from(s, 'utf8') 等价，含两块边界：孤立代理项编码为 U+FFFD，
 * 合法代理对合并成四字节增补平面序列。
 *
 * @param {string} str 待编码文本
 * @returns {Uint8Array} UTF-8 字节
 */
export function utf8Bytes(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c < 0xdc00) {
      const c2 = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (c2 >= 0xdc00 && c2 < 0xe000) {
        i++;
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else {
        // 孤立高位代理项，按 Unicode 替换字符处理
        bytes.push(0xef, 0xbf, 0xbd);
      }
    } else if (c >= 0xdc00 && c < 0xe000) {
      // 孤立低位代理项
      bytes.push(0xef, 0xbf, 0xbd);
    } else {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

/**
 * UTF-8 文本的字节长度，不产生中间字节数组。
 *
 * 与 Buffer.byteLength(s, 'utf8') 等价，用于大小限额判定。浏览器与 Worker
 * 里没有 Buffer，构建期又要在三端算出同一个数。
 *
 * @param {string} str 文本
 * @returns {number} 字节数
 */
export function utf8Length(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00) {
      const c2 = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (c2 >= 0xdc00 && c2 < 0xe000) { i++; n += 4; } else n += 3;
    } else if (c >= 0xdc00 && c < 0xe000) n += 3;
    else n += 3;
  }
  return n;
}

/** 字节数组转小写 hex。 */
export function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] >>> 4).toString(16) + (bytes[i] & 15).toString(16);
  return out;
}

/**
 * SHA-256 摘要。
 * @param {Uint8Array} bytes 输入字节
 * @returns {Uint8Array} 32 字节摘要
 */
export function sha256Bytes(bytes) {
  const len = bytes.length;
  const bitLen = len * 8;
  // 尾部补 0x80 与 8 字节大端比特长度，总长对齐到 64 字节
  const total = ((len + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, Math.floor(bitLen / 4294967296));
  view.setUint32(total - 4, bitLen >>> 0);

  const h = H0.slice();
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15];
      const w2 = w[i - 2];
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0]; let b = h[1]; let c = h[2]; let d = h[3];
    let e = h[4]; let f = h[5]; let g = h[6]; let hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
  return out;
}

/**
 * SHA-256 摘要的 hex 文本。
 * @param {string} text 输入文本，按 UTF-8 处理
 * @returns {string} 64 位小写 hex
 */
export function sha256Hex(text) {
  return bytesToHex(sha256Bytes(utf8Bytes(text)));
}

/** SHA-512 轮常量，80 个 64 位字。 */
const K512 = [
  0x428a2f98d728ae22n, 0x7137449123ef65cdn, 0xb5c0fbcfec4d3b2fn, 0xe9b5dba58189dbbcn,
  0x3956c25bf348b538n, 0x59f111f1b605d019n, 0x923f82a4af194f9bn, 0xab1c5ed5da6d8118n,
  0xd807aa98a3030242n, 0x12835b0145706fben, 0x243185be4ee4b28cn, 0x550c7dc3d5ffb4e2n,
  0x72be5d74f27b896fn, 0x80deb1fe3b1696b1n, 0x9bdc06a725c71235n, 0xc19bf174cf692694n,
  0xe49b69c19ef14ad2n, 0xefbe4786384f25e3n, 0x0fc19dc68b8cd5b5n, 0x240ca1cc77ac9c65n,
  0x2de92c6f592b0275n, 0x4a7484aa6ea6e483n, 0x5cb0a9dcbd41fbd4n, 0x76f988da831153b5n,
  0x983e5152ee66dfabn, 0xa831c66d2db43210n, 0xb00327c898fb213fn, 0xbf597fc7beef0ee4n,
  0xc6e00bf33da88fc2n, 0xd5a79147930aa725n, 0x06ca6351e003826fn, 0x142929670a0e6e70n,
  0x27b70a8546d22ffcn, 0x2e1b21385c26c926n, 0x4d2c6dfc5ac42aedn, 0x53380d139d95b3dfn,
  0x650a73548baf63den, 0x766a0abb3c77b2a8n, 0x81c2c92e47edaee6n, 0x92722c851482353bn,
  0xa2bfe8a14cf10364n, 0xa81a664bbc423001n, 0xc24b8b70d0f89791n, 0xc76c51a30654be30n,
  0xd192e819d6ef5218n, 0xd69906245565a910n, 0xf40e35855771202an, 0x106aa07032bbd1b8n,
  0x19a4c116b8d2d0c8n, 0x1e376c085141ab53n, 0x2748774cdf8eeb99n, 0x34b0bcb5e19b48a8n,
  0x391c0cb3c5c95a63n, 0x4ed8aa4ae3418acbn, 0x5b9cca4f7763e373n, 0x682e6ff3d6b2b8a3n,
  0x748f82ee5defb2fcn, 0x78a5636f43172f60n, 0x84c87814a1f0ab72n, 0x8cc702081a6439ecn,
  0x90befffa23631e28n, 0xa4506cebde82bde9n, 0xbef9a3f7b2c67915n, 0xc67178f2e372532bn,
  0xca273eceea26619cn, 0xd186b8c721c0c207n, 0xeada7dd6cde0eb1en, 0xf57d4f7fee6ed178n,
  0x06f067aa72176fban, 0x0a637dc5a2c898a6n, 0x113f9804bef90daen, 0x1b710b35131c471bn,
  0x28db77f523047d84n, 0x32caab7b40c72493n, 0x3c9ebe0a15c9bebcn, 0x431d67c49c100d4cn,
  0x4cc5d4becb3e42b6n, 0x597f299cfc657e2an, 0x5fcb6fab3ad6faecn, 0x6c44198c4a475817n,
];

/** SHA-512 初始状态。 */
const H512 = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];

/** 64 位掩码。 */
const M64 = (1n << 64n) - 1n;

/** 32 位循环右移。 */
function rotr(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** 64 位循环右移。 */
function rotr64(x, n) {
  return ((x >> n) | (x << (64n - n))) & M64;
}

/**
 * SHA-512 摘要。
 *
 * 与 SHA-256 的差别不止字宽：分块 128 字节、轮数 80、长度域 16 字节（SHA-256
 * 是 8 字节）。这里用 BigInt 处理 64 位字，输入都很短（私钥 32 字节、
 * R||A||M 几十字节），性能足够，换来的是不必手写高低位拆分。
 *
 * @param {Uint8Array} bytes 输入字节
 * @returns {Uint8Array} 64 字节摘要
 */
export function sha512Bytes(bytes) {
  const len = bytes.length;
  const bitLen = BigInt(len) * 8n;
  // 尾部补 0x80 与 16 字节大端比特长度，总长对齐到 128 字节
  const total = ((len + 17 + 127) >> 7) << 7;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  for (let i = 0; i < 16; i++) {
    buf[total - 1 - i] = Number((bitLen >> BigInt(i * 8)) & 0xffn);
  }

  const h = H512.slice();
  const w = new Array(80);
  for (let off = 0; off < total; off += 128) {
    for (let i = 0; i < 16; i++) {
      let v = 0n;
      for (let j = 0; j < 8; j++) v = (v << 8n) | BigInt(buf[off + i * 8 + j]);
      w[i] = v;
    }
    for (let i = 16; i < 80; i++) {
      const w15 = w[i - 15];
      const w2 = w[i - 2];
      const s0 = rotr64(w15, 1n) ^ rotr64(w15, 8n) ^ (w15 >> 7n);
      const s1 = rotr64(w2, 19n) ^ rotr64(w2, 61n) ^ (w2 >> 6n);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & M64;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 80; i++) {
      const S1 = rotr64(e, 14n) ^ rotr64(e, 18n) ^ rotr64(e, 41n);
      const ch = (e & f) ^ (~e & g & M64);
      const t1 = (hh + S1 + ch + K512[i] + w[i]) & M64;
      const S0 = rotr64(a, 28n) ^ rotr64(a, 34n) ^ rotr64(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) & M64;
      hh = g; g = f; f = e;
      e = (d + t1) & M64;
      d = c; c = b; b = a;
      a = (t1 + t2) & M64;
    }
    const sums = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = (h[i] + sums[i]) & M64;
  }

  const out = new Uint8Array(64);
  for (let i = 0; i < 8; i++) {
    let v = h[i];
    for (let j = 7; j >= 0; j--) {
      out[i * 8 + j] = Number(v & 0xffn);
      v >>= 8n;
    }
  }
  return out;
}

/**
 * SHA-512 摘要的 hex 文本。
 * @param {string} text 输入文本，按 UTF-8 处理
 * @returns {string} 128 位小写 hex
 */
export function sha512Hex(text) {
  return bytesToHex(sha512Bytes(utf8Bytes(text)));
}

/**
 * HMAC-SHA256。
 * @param {Uint8Array} keyBytes 密钥字节
 * @param {Uint8Array} msgBytes 消息字节
 * @returns {Uint8Array} 32 字节 MAC
 */
export function hmacSha256Bytes(keyBytes, msgBytes) {
  // 密钥超过分块长度时先摘要，再右侧补零到 64 字节
  let key = keyBytes;
  if (key.length > BLOCK) key = sha256Bytes(key);
  const ipad = new Uint8Array(BLOCK + msgBytes.length);
  const opad = new Uint8Array(BLOCK + 32);
  for (let i = 0; i < BLOCK; i++) {
    const k = i < key.length ? key[i] : 0;
    ipad[i] = k ^ 0x36;
    opad[i] = k ^ 0x5c;
  }
  ipad.set(msgBytes, BLOCK);
  opad.set(sha256Bytes(ipad), BLOCK);
  return sha256Bytes(opad);
}

/**
 * HMAC-SHA256 的 hex 文本。签发与校验两侧都走这里，协议只此一份实现。
 * @param {string} key 密钥文本，按 UTF-8 处理
 * @param {string} text 消息文本，按 UTF-8 处理
 * @returns {string} 64 位小写 hex
 */
export function hmacSha256Hex(key, text) {
  return bytesToHex(hmacSha256Bytes(utf8Bytes(key), utf8Bytes(text)));
}

/**
 * 定长字符串的定时安全比较，两侧长度不等直接判否。
 * @param {string} a 待比较文本
 * @param {string} b 期望文本
 * @returns {boolean} 是否完全相同
 */
export function timingSafeEqualText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** base64 解码为文本，按 Latin-1 逐字节映射，用于还原 base64 存放的密钥常量。 */
export function b64ToText(s) {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = B64.indexOf(s[i]);
    if (c < 0) continue;
    buffer = (buffer << 6) | c;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return out;
}

/** base64 字符表，标准变体。 */
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * base64 解码为字节数组。
 *
 * 与 b64ToText 的区别是这里保住原始字节。密钥material 必须走这条：b64ToText 把
 * 每字节映射成一个字符，再经 utf8Bytes 编码回来时，0x80 以上的字节会变成两字节
 * 的 UTF-8 序列（甚至 U+FFFD），熵与长度都悄悄变了。Ed25519 的种子必须是恰好
 * 32 字节，用文本那条路根本还原不回来。
 *
 * @param {string} s base64 文本
 * @returns {Uint8Array} 解码后的字节
 */
export function b64ToBytes(s) {
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = B64_ALPHABET.indexOf(s[i]);
    if (c < 0) continue;
    buffer = (buffer << 6) | c;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/**
 * 字节数组编码为 base64，带标准 padding。
 * @param {Uint8Array} bytes 字节
 * @returns {string} base64 文本
 */
export function bytesToB64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 63] : '=';
  }
  return out;
}

export default {
  utf8Bytes,
  utf8Length,
  bytesToHex,
  sha256Bytes,
  sha256Hex,
  sha512Bytes,
  sha512Hex,
  hmacSha256Bytes,
  hmacSha256Hex,
  timingSafeEqualText,
  b64ToText,
  b64ToBytes,
  bytesToB64,
};
