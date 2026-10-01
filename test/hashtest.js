#!/usr/bin/env node
/**
 * 纯 JS SHA-256 / SHA-512 / HMAC-SHA256 / Ed25519 与 node:crypto 的一致性测试。
 *
 *   node test/hashtest.js
 *
 * 为什么必须有这个测试：卡密与许可证令牌的验签在 Node、浏览器、Worker 三端
 * 走的是 src/utils/hash.js 里的纯 JS 实现，而与 node:crypto 的一致性决定了
 * "同一张卡密在哪儿都能验过"。覆盖空串、跨分块边界（55/56/63/64/65 字节）、
 * 长密钥（>64 字节触发先摘要路径）、中文与代理对。
 */
import crypto from 'node:crypto';
import hash from '../src/utils/hash.js';
import ed25519 from '../src/utils/ed25519.js';

const { sha256Hex, hmacSha256Hex, utf8Bytes, utf8Length, b64ToText } = hash;

/** 待测文本，覆盖分块边界与多字节边界。 */
const TEXTS = [
  '',
  'a',
  'abc',
  'x'.repeat(55),
  'x'.repeat(56),
  'x'.repeat(63),
  'x'.repeat(64),
  'x'.repeat(65),
  'x'.repeat(119),
  'x'.repeat(120),
  'x'.repeat(1000),
  'JsLabyrinth 混淆器：中文、emoji 😀 与代理对 𝄞',
  '\u0000\u0001\u007f\u0080\u07ff\u0800\uffff',
  'JSLB-B-00-0000000000000001M2TGBV35-077K5J669TA005DXC81XC6EA',
];

/** 待测密钥，含超过 64 字节触发"先摘要再补零"的分支。 */
const KEYS = [
  '',
  'k',
  'JSLabyrinth/License/v1::core::hmac-key::#7f3a91',
  'K'.repeat(63),
  'K'.repeat(64),
  'K'.repeat(65),
  'K'.repeat(200),
  '密钥🔑',
];

let pass = 0;
let fail = 0;

function eq(label, a, b) {
  if (a === b) { pass++; return; }
  fail++;
  console.log('[FAIL] ' + label + '\n  got  ' + a + '\n  want ' + b);
}

for (const s of TEXTS) {
  eq('sha256(' + JSON.stringify(s.slice(0, 24)) + (s.length > 24 ? '…' : '') + ')',
    sha256Hex(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'));
  eq('utf8Length vs Buffer.byteLength (' + s.length + ' 字符)',
    String(utf8Length(s)), String(Buffer.byteLength(s, 'utf8')));
}

for (const k of KEYS) {
  for (const s of ['', 'msg', 'JSLB2|P|01|0000000000000001M2TGBV35', '中文消息😀']) {
    eq('hmac(' + JSON.stringify(k.slice(0, 12)) + ', ' + JSON.stringify(s.slice(0, 16)) + ')',
      hmacSha256Hex(k, s),
      crypto.createHmac('sha256', k).update(s, 'utf8').digest('hex'));
  }
}

// UTF-8 编码与 Buffer 逐字节一致（孤立代理项按 U+FFFD 处理）
for (const s of ['\ud800', '\udc00', 'a\ud800b', '😀', '𝄞x']) {
  const mine = utf8Bytes(s);
  const theirs = Uint8Array.from(Buffer.from(s, 'utf8'));
  eq('utf8Bytes(' + JSON.stringify(s) + ')', Array.from(mine).join(','), Array.from(theirs).join(','));
}

// base64 还原密钥常量，必须与 Buffer 的 base64 解码一致
for (const s of ['', 'aGVsbG8=', 'SnNMYWJ5cmludGgvTGljZW5zZS92MTo6Y29yZTo6aG1hYy1rZXk6OiM3ZjNhOTE=']) {
  eq('b64ToText(' + JSON.stringify(s.slice(0, 16)) + ')',
    b64ToText(s), Buffer.from(s, 'base64').toString('latin1'));
}

// ---- SHA-512：Ed25519 的内部哈希，必须与 node:crypto 逐位一致 ----
//
// 分块是 128 字节，所以边界要单独覆盖 111/112/127/128/129（对应 SHA-256 的
// 55/56/63/64/65）。长度域也从 8 字节变成 16 字节。
for (const s of [...TEXTS, 'x'.repeat(111), 'x'.repeat(112), 'x'.repeat(127), 'x'.repeat(128), 'x'.repeat(129), 'x'.repeat(255), 'x'.repeat(256)]) {
  eq('sha512(' + JSON.stringify(s.slice(0, 12)) + ' len=' + s.length + ')',
    hash.sha512Hex(s), crypto.createHash('sha512').update(s, 'utf8').digest('hex'));
}

// ---- base64 字节编解码：密钥 material 走这条，必须与 Buffer 一致 ----
for (const s of ['', 'AA==', 'aGVsbG8=', '6gXmaKGn+dQw8jVtvmp7VWBYAA+hS+vEKHgrBstPW54=']) {
  eq('b64ToBytes(' + JSON.stringify(s.slice(0, 12)) + ')',
    Array.from(hash.b64ToBytes(s)).join(','),
    Array.from(Buffer.from(s, 'base64')).join(','));
}
for (const n of [0, 1, 2, 3, 31, 32, 33, 64]) {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = (i * 37 + 11) & 0xff;
  eq('bytesToB64(len=' + n + ')', hash.bytesToB64(bytes), Buffer.from(bytes).toString('base64'));
}

// ---- Ed25519：RFC 8032 §7.1 官方测试向量 ----
//
// 这里必须用官方向量而不是"自签自验"：自签自验对取错基点符号、用错哈希、
// 标量按 P 而不是按 L 归约这几类缺陷都是盲的（它们会自洽地全错）。实现时正是
// 三个错都犯过一遍，全靠这组向量逐个逼出来。
const ED_VECTORS = [
  {
    seed: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    pub: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    msg: '',
    sig: 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  },
  {
    seed: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
    pub: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
    msg: '72',
    sig: '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
  },
  {
    seed: 'c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7',
    pub: 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
    msg: 'af82',
    sig: '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a',
  },
];
const h2b = (h) => Uint8Array.from((h.match(/../g) || []).map((x) => parseInt(x, 16)));

for (let i = 0; i < ED_VECTORS.length; i++) {
  const v = ED_VECTORS[i];
  const seed = h2b(v.seed);
  eq('ed25519 公钥派生 #' + (i + 1), hash.bytesToHex(ed25519.ed25519PublicKeyFromSeed(seed)), v.pub);
  eq('ed25519 签名 #' + (i + 1), hash.bytesToHex(ed25519.ed25519Sign(h2b(v.msg), seed)), v.sig);
  eq('ed25519 验签 #' + (i + 1), ed25519.ed25519Verify(h2b(v.sig), h2b(v.msg), h2b(v.pub)), true);
}

// 负例：篡改、错消息、错公钥、S 越界（可延展性）都必须被拒
{
  const v = ED_VECTORS[1];
  const pub = h2b(v.pub);
  const msg = h2b(v.msg);
  const sig = ed25519.ed25519Sign(msg, h2b(v.seed));
  const flip = sig.slice(); flip[0] ^= 1;
  eq('ed25519 拒绝篡改签名', ed25519.ed25519Verify(flip, msg, pub), false);
  eq('ed25519 拒绝错误消息', ed25519.ed25519Verify(sig, h2b('73'), pub), false);
  eq('ed25519 拒绝错误公钥', ed25519.ed25519Verify(sig, msg, h2b(ED_VECTORS[2].pub)), false);
  const bigS = sig.slice(); bigS[62] = 0xff; bigS[63] = 0xff;
  eq('ed25519 拒绝越界 S', ed25519.ed25519Verify(bigS, msg, pub), false);
  eq('ed25519 拒绝全零签名', ed25519.ed25519Verify(new Uint8Array(64), msg, pub), false);
  // 与 node:crypto 交叉验证（Node 的 Ed25519 是独立实现）
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(h2b(v.seed))]);
  const priv = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pub)]);
  const pubKey = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  eq('ed25519 与 node:crypto 签名一致', hash.bytesToHex(sig), crypto.sign(null, Buffer.from(msg), priv).toString('hex'));
  eq('ed25519 验 node:crypto 的签名',
    ed25519.ed25519Verify(new Uint8Array(crypto.sign(null, Buffer.from(msg), priv)), msg, pub), true);
  eq('node:crypto 验我们的签名',
    crypto.verify(null, Buffer.from(msg), pubKey, Buffer.from(sig)), true);
}

console.log('\n' + (fail === 0 ? '全部通过' : '失败') + '：' + pass + ' 项一致，' + fail + ' 项不一致');
process.exit(fail === 0 ? 0 : 1);
