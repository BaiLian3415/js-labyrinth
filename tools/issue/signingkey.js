#!/usr/bin/env node
'use strict';
/**
 * 签名密钥对生成器。发卡方使用，不随最终用户分发。
 *
 * 用法:
 *   node tools/issue/signingkey.js                    # 生成一对新密钥并打印
 *   node tools/issue/signingkey.js --out ./keys       # 同时落盘到指定目录
 *   node tools/issue/signingkey.js --json             # 以 JSON 输出
 *   node tools/issue/signingkey.js --seed <b64>       # 由指定种子重建（确定性）
 *   node tools/issue/signingkey.js --check <b64 公钥>  # 校验公钥格式并打印指纹
 *   -h, --help                                       帮助
 *
 * 与另外两个工具的分工，别搞混：
 *
 *   signingkey.js（本工具） 生成**签名密钥对**。默认只打印，不碰任何文件。
 *   keyrotate.js            轮换签名密钥对：**覆盖** src/license-secret.js 里的公钥，
 *                           并把私钥写进 .jslb-signing-key。会让所有旧卡密作废。
 *   keygen.js               用私钥**签发卡密**（JSLB-...），不是生成密钥。
 *
 * 卡密用 Ed25519 签名，所以密钥是**一对**：
 *
 *   - **公钥**进 src/license-secret.js（`B64_PUBLIC_KEY`），随源码分发。只能验签。
 *   - **私钥**（32 字节种子）只留在签发方：环境变量 `JSLB_SIGNING_KEY`，或项目根的
 *     `.jslb-signing-key`（gitignore）。**它能签出任意套餐、任意有效期的卡密**，而
 *     所有验签方都持有对应公钥，一定通过。这是全套系统唯一的秘密。
 *
 * 本工具生成后会**当场做一次签名/验签往返自检**：种子派生公钥、签名、验签、再验
 * 一次"错误消息必须被拒"。任何一步不过就拒绝输出——宁可现在失败，也别把一对坏密钥
 * 交出去，那要等到线上验签失败才会发现。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ed25519PublicKeyFromSeed, ed25519Sign, ed25519Verify,
} from '../../src/utils/ed25519.js';
import {
  bytesToB64, b64ToBytes, utf8Bytes, bytesToHex, sha256Bytes,
} from '../../src/utils/hash.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

/** Ed25519 种子长度，固定 32 字节。 */
const SEED_BYTES = 32;

/** 公钥长度，固定 32 字节。 */
const PUB_BYTES = 32;

const HELP = `JsLabyrinth 签名密钥对生成器

用法: node tools/issue/signingkey.js [选项]

  -o, --out <dir>     把私钥与公钥写入指定目录（signing-key.txt / public-key.txt）
  -s, --seed <b64>    由指定种子重建密钥对（32 字节 base64），用于确定性恢复
  -c, --check <b64>   只校验一个公钥：格式、长度、指纹，不生成任何东西
      --json          以 JSON 输出
      --force         允许覆盖 --out 目录下已存在的文件
  -h, --help          帮助

默认只打印，不触碰任何文件。

生成后会自动做签名/验签往返自检，任何一步不过即拒绝输出。

拿到密钥对之后：
  1) 公钥填进 src/license-secret.js 的 B64_PUBLIC_KEY（或直接用 keyrotate.js --write）
  2) 私钥妥善保管：环境变量 JSLB_SIGNING_KEY，或 .jslb-signing-key（已在 .gitignore 里）
  3) 发卡：node tools/issue/keygen.js --plan pro --days 365

⚠️ 私钥泄露等于发卡权泄露。别进仓库、别进 dist/、别进 Worker Secret。
`;

/** 解析整数选项；非法时打印错误并退出。 */
function fail(msg) {
  console.error(msg);
  process.exit(1);
}

/**
 * 生成密钥对并做往返自检。
 * @param {string|null} seedB64 指定种子，null 表示随机
 * @returns {{seedB64:string, publicKeyB64:string, fingerprint:string, selfTest:object}}
 */
function generatePair(seedB64) {
  let seed;
  if (seedB64) {
    seed = b64ToBytes(seedB64);
    if (seed.length !== SEED_BYTES) {
      fail(`种子必须是 ${SEED_BYTES} 字节（base64），收到 ${seed.length} 字节`);
    }
  } else {
    // crypto.randomBytes 是 CSPRNG。绝不能用 Math.random 或项目里的 PRNG——
    // 那个是可复现的伪随机，种子一旦被猜出，私钥就没了。
    seed = new Uint8Array(crypto.randomBytes(SEED_BYTES));
  }

  const pub = ed25519PublicKeyFromSeed(seed);
  if (pub.length !== PUB_BYTES) fail('公钥派生结果长度异常');

  // 往返自检：能签能验，且改一个字节就验不过
  const msg = utf8Bytes('JsLabyrinth signing key self-test ' + bytesToB64(pub));
  const sig = ed25519Sign(msg, seed);
  const signed = ed25519Verify(sig, msg, pub);
  const tamperedSig = sig.slice();
  tamperedSig[0] ^= 1;
  const rejectTampered = !ed25519Verify(tamperedSig, msg, pub);
  const wrongMsg = utf8Bytes('other message');
  const rejectWrongMsg = !ed25519Verify(sig, wrongMsg, pub);
  const rejectWrongKey = !ed25519Verify(sig, msg, ed25519PublicKeyFromSeed(new Uint8Array(32)));

  const ok = signed && rejectTampered && rejectWrongMsg && rejectWrongKey;
  if (!ok) {
    fail('密钥对自检失败，拒绝输出（这通常意味着随机源或 Ed25519 实现有问题）');
  }

  return {
    seedB64: bytesToB64(seed),
    publicKeyB64: bytesToB64(pub),
    // 公钥指纹：用 SHA-256 前 16 位 hex，方便肉眼比对"线上用的是哪把公钥"
    fingerprint: bytesToHex(sha256Bytes(pub)).slice(0, 16),
    selfTest: { signed, rejectTampered, rejectWrongMsg, rejectWrongKey },
  };
}

/** 只校验公钥。 */
function checkPublicKey(b64) {
  const bytes = b64ToBytes(b64);
  if (bytes.length !== PUB_BYTES) {
    fail(`公钥必须是 ${PUB_BYTES} 字节（base64），收到 ${bytes.length} 字节`);
  }
  // 公钥点必须能解码回曲线上；用一次验签走完整解码路径即可判定
  const sig = ed25519Sign(utf8Bytes('probe'), new Uint8Array(32));
  const usable = typeof ed25519Verify(sig, utf8Bytes('probe'), bytes) === 'boolean';
  return {
    publicKeyB64: b64,
    fingerprint: bytesToHex(sha256Bytes(bytes)).slice(0, 16),
    usable,
  };
}

/** 写入 --out 目录。默认拒绝覆盖，--force 才允许。 */
function writeOut(dir, pair, force) {
  const abs = path.resolve(ROOT, dir);
  fs.mkdirSync(abs, { recursive: true });
  const files = [
    { name: 'signing-key.txt', body: pair.seedB64 + '\n', mode: 0o600, label: '私钥（机密）' },
    { name: 'public-key.txt', body: pair.publicKeyB64 + '\n', mode: 0o644, label: '公钥（可公开）' },
  ];
  for (const f of files) {
    const p = path.join(abs, f.name);
    if (fs.existsSync(p) && !force) {
      fail(`文件已存在，拒绝覆盖：${p}\n确认要覆盖就加 --force（旧密钥覆盖后无法恢复）。`);
    }
  }
  const written = [];
  for (const f of files) {
    const p = path.join(abs, f.name);
    fs.writeFileSync(p, f.body, { mode: f.mode });
    written.push({ path: p, label: f.label });
  }
  return written;
}

function main(argv) {
  let outDir = null;
  let seedB64 = null;
  let checkB64 = null;
  let asJson = false;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-h': case '--help': console.log(HELP); return;
      case '-o': case '--out': outDir = String(next() || ''); break;
      case '-s': case '--seed': seedB64 = String(next() || ''); break;
      case '-c': case '--check': checkB64 = String(next() || ''); break;
      case '--json': asJson = true; break;
      case '--force': force = true; break;
      default:
        console.error(`未知选项 "${a}"（用 --help 查看用法）`);
        process.exit(1);
    }
  }

  if (checkB64 !== null) {
    const r = checkPublicKey(checkB64);
    if (asJson) console.log(JSON.stringify(r, null, 2));
    else {
      console.log('公钥格式合法。');
      console.log('  指纹: ' + r.fingerprint);
      console.log('  可用于验签: ' + (r.usable ? '是' : '否'));
    }
    return;
  }

  const pair = generatePair(seedB64);
  const written = outDir ? writeOut(outDir, pair, force) : [];

  if (asJson) {
    console.log(JSON.stringify({
      publicKey: pair.publicKeyB64,
      signingKey: pair.seedB64,
      fingerprint: pair.fingerprint,
      selfTest: pair.selfTest,
      written: written.map((w) => w.path),
    }, null, 2));
    return;
  }

  console.log('密钥对已生成，往返自检通过。');
  console.log('');
  console.log('  公钥（可公开，进 src/license-secret.js）:');
  console.log('    ' + pair.publicKeyB64);
  console.log('  私钥（机密，只在签发方）:');
  console.log('    ' + pair.seedB64);
  console.log('  公钥指纹: ' + pair.fingerprint);
  console.log('');
  console.log('  填进 src/license-secret.js 的一行：');
  console.log(`    const B64_PUBLIC_KEY = '${pair.publicKeyB64}';`);
  if (written.length) {
    console.log('');
    for (const w of written) console.log(`  已写入 ${w.label}: ${w.path}`);
  }
  console.log('');
  console.log('  下一步：');
  console.log('    1) 公钥写进 src/license-secret.js（或改用 keyrotate.js --write 一步到位）');
  console.log('    2) 私钥保管好：export JSLB_SIGNING_KEY=<上面那串私钥>');
  console.log('       或写进 .jslb-signing-key（已在 .gitignore 里，权限 600）');
  console.log('    3) 发卡：node tools/issue/keygen.js --plan pro --days 365');
  console.log('');
  console.log('  ⚠️ 私钥泄露等于发卡权泄露。别进仓库、别进 dist/、别进 Worker Secret。');
}

main(process.argv.slice(2));
