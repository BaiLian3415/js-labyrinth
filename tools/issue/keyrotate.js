#!/usr/bin/env node
'use strict';
/**
 * 签发密钥对的生成与轮换工具。发卡方使用，不随最终用户分发。
 *
 * 用法:
 *   node tools/issue/keyrotate.js                 # 只生成一对新密钥，不改任何文件
 *   node tools/issue/keyrotate.js --write         # 公钥写入 src/license-secret.js，
 *                                                 # 私钥写入 .jslb-signing-key，并重算摘要表
 *   node tools/issue/keyrotate.js --json          # 以 JSON 输出
 *   node tools/issue/keyrotate.js --seed <b64>    # 用指定的 32 字节种子重建公钥
 *   -h, --help                                   帮助
 *
 * 卡密用 Ed25519 签名，因此密钥是**一对**而不是一把：
 *
 *   - **公钥**写进 src/license-secret.js，随源码分发。它只能验签。
 *   - **私钥**（32 字节种子）写进项目根的 .jslb-signing-key（gitignore），或由
 *     环境变量 JSLB_SIGNING_KEY 提供。**它能签出任意套餐、任意有效期的卡密**，
 *     而所有验签方都持有对应公钥，一定通过。绝不能进源码、dist/ 或 Worker 的
 *     静态资源。
 *
 * 这是整个系统唯一的秘密。换密钥对等于换发卡权：所有旧卡密与所有 license.lic
 * 立即失效（公钥变了，验签必然失败），每台机器都要用新卡密重新激活。
 *
 * --write 之后会自动调用 tools/issue/selfdigest.js 重算自身摘要表：表中的掩码由
 * 公钥派生，公钥一变还原出的摘要就全错，CLI 会判定自身被篡改并以退出码 2 静默
 * 退出。顺序不能颠倒。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ed25519PublicKeyFromSeed } from '../../src/utils/ed25519.js';
import { bytesToB64, b64ToBytes } from '../../src/utils/hash.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SECRET_PATH = path.join(ROOT, 'src', 'license-secret.js');
const SIGNING_KEY_PATH = path.join(ROOT, '.jslb-signing-key');
const SELFDIGEST_PATH = path.join(__dirname, 'selfdigest.js');

/** Ed25519 种子长度，固定 32 字节。 */
const SEED_BYTES = 32;

/** B64_PUBLIC_KEY 定义块，与 src/license-secret.js 的写法一致。 */
const PUB_PATTERN = /const B64_PUBLIC_KEY = '[^']*';/;

const HELP = `JsLabyrinth 签发密钥对生成/轮换工具

用法: node tools/issue/keyrotate.js [选项]

  -w, --write        公钥写入 src/license-secret.js，私钥写入 .jslb-signing-key，
                     随后重算自身摘要表
  -s, --seed <b64>   用指定的 32 字节种子（base64）重建密钥对，不随机生成
  --json             以 JSON 输出
  -h, --help         帮助

不带 --write 时只打印新密钥对，不触碰任何文件。

示例:
  node tools/issue/keyrotate.js              # 预览一对新密钥
  node tools/issue/keyrotate.js --write      # 生成并落盘，随后重算摘要表

注意: 落盘后旧卡密与旧 license.lic 全部失效，需重新运行 node tools/issue/keygen.js 发卡。
`;

/** 解析整数选项；非法时打印错误并退出。 */
function intArg(name, raw, min) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    console.error(`选项 ${name} 需要 ≥ ${min} 的整数，收到 "${raw}"`);
    process.exit(1);
  }
  return n;
}

/** 生成一对新密钥。 */
function newKeyPair(seedB64) {
  let seed;
  if (seedB64) {
    seed = b64ToBytes(seedB64);
    if (seed.length !== SEED_BYTES) {
      console.error(`种子必须是 ${SEED_BYTES} 字节（base64），收到 ${seed.length} 字节`);
      process.exit(1);
    }
  } else {
    seed = new Uint8Array(crypto.randomBytes(SEED_BYTES));
  }
  const pub = ed25519PublicKeyFromSeed(seed);
  return { seedB64: bytesToB64(seed), publicKeyB64: bytesToB64(pub) };
}

/** 写入公钥（进源码）与私钥（进 gitignore 的本地文件），并重算自身摘要表。 */
function writeKeys(pair) {
  const src = fs.readFileSync(SECRET_PATH, 'utf8');
  if (!PUB_PATTERN.test(src)) {
    console.error('未在 src/license-secret.js 找到 B64_PUBLIC_KEY 定义');
    process.exit(1);
  }
  fs.writeFileSync(SECRET_PATH, src.replace(PUB_PATTERN, `const B64_PUBLIC_KEY = '${pair.publicKeyB64}';`));
  console.error('已更新 ' + path.relative(ROOT, SECRET_PATH) + '（公钥，可公开）');

  fs.writeFileSync(SIGNING_KEY_PATH, pair.seedB64 + '\n', { mode: 0o600 });
  console.error('已写入 ' + path.relative(ROOT, SIGNING_KEY_PATH) + '（私钥，勿提交、勿分发）');

  // 摘要表的掩码由新公钥派生，只能在写入之后重算
  const written = spawnSync(process.execPath, [SELFDIGEST_PATH, '--write'], { stdio: 'inherit' });
  if (written.status !== 0) {
    console.error('自身摘要表重算失败，请手动运行: node tools/issue/selfdigest.js --write');
    process.exit(1);
  }
  const checked = spawnSync(process.execPath, [SELFDIGEST_PATH, '--check'], { stdio: 'inherit' });
  if (checked.status !== 0) {
    console.error('自身摘要表校验未通过');
    process.exit(1);
  }
}

function main(argv) {
  let write = false;
  let asJson = false;
  let seedB64 = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-h': case '--help': console.log(HELP); return;
      case '-w': case '--write': write = true; break;
      case '-s': case '--seed': seedB64 = String(next() || ''); break;
      case '--json': asJson = true; break;
      default:
        console.error(`未知选项 "${a}"（用 --help 查看用法）`);
        process.exit(1);
    }
  }

  const pair = newKeyPair(seedB64);

  if (!write) {
    if (asJson) {
      console.log(JSON.stringify({ publicKey: pair.publicKeyB64, signingKey: pair.seedB64 }, null, 2));
      return;
    }
    console.log(`const B64_PUBLIC_KEY = '${pair.publicKeyB64}';`);
    console.error('签发私钥（base64，32 字节种子）:');
    console.error('  ' + pair.seedB64);
    console.error('公钥可公开、随源码分发；私钥只留在签发方，切勿提交或分发。');
    console.error('只读预览：未改动任何文件；确认后加 --write 落盘。');
    return;
  }

  writeKeys(pair);

  if (asJson) {
    console.log(JSON.stringify({
      publicKey: pair.publicKeyB64,
      secretFile: path.relative(ROOT, SECRET_PATH),
      signingKeyFile: path.relative(ROOT, SIGNING_KEY_PATH),
    }, null, 2));
  } else {
    console.log(`const B64_PUBLIC_KEY = '${pair.publicKeyB64}';`);
  }
  console.error('密钥对已轮换。所有旧卡密与现有 license.lic 已全部失效，');
  console.error('请用 node tools/issue/keygen.js 重新发卡，并让各机器重新激活。');
}

main(process.argv.slice(2));
