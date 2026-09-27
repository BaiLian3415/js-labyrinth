#!/usr/bin/env node
'use strict';
/**
 * 卡密密钥生成器。发卡方使用，不随最终用户分发。
 *
 * 用法:
 *   node tools/issue/signingkey.js                    # 生成一把新密钥并打印
 *   node tools/issue/signingkey.js --out ./keys       # 同时落盘到指定目录
 *   node tools/issue/signingkey.js --json             # 以 JSON 输出
 *   node tools/issue/signingkey.js -c, --check <b64>  # 校验一把密钥的格式并打印指纹
 *   -h, --help                                       帮助
 *
 * 与另外两个工具的分工，别搞混：
 *
 *   signingkey.js（本工具） 生成**卡密密钥**（对称，32 字节）。默认只打印，不碰任何文件。
 *   keyrotate.js            轮换卡密密钥：**覆盖** src/license-secret.js 里的 B64_CODE_KEY，
 *                           并把新密钥写进 .jslb-code-key。会让所有旧卡密作废。
 *   keygen.js               用密钥**签发卡密**（JSLB-...），不是生成密钥。
 *
 * v5 卡密是对称格式（编号 + 加密信息段 + 校验码），签发与校验共用**同一把**密钥：
 *
 *   - 它必须写进 src/license-secret.js（B64_CODE_KEY）随源码分发——浏览器本地
 *     验卡要用。因此它**不是秘密**：拿到源码的人能自己造卡，真正的强制在服务端
 *     （/api/obfuscate 逐请求校验 + 云存储赎回登记）。
 *   - 它仍然等于"离线场景的发卡权"：不想用内置值时，把新密钥配进服务端
 *     （Vercel 项目设置里的 JSLB_CODE_KEY），签发方用同一把，密钥不进 git。
 *
 * 生成后会当场做一次"签发→校验"往返自检：新密钥签出的卡密必须能被它自己解析、
 * 且换一把密钥就解析不过。任何一步不过就拒绝输出。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import codec from '../../src/license-codec.js';
import { bytesToB64, b64ToBytes, bytesToHex, sha256Bytes } from '../../src/utils/hash.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

/** 卡密密钥长度，固定 32 字节。 */
const KEY_BYTES = 32;

const HELP = `JsLabyrinth 卡密密钥生成器

用法: node tools/issue/signingkey.js [选项]

  -o, --out <dir>     把密钥写入指定目录（code-key.txt）
  -c, --check <b64>   只校验一把密钥：格式、长度、指纹，不生成任何东西
      --json          以 JSON 输出
      --force         允许覆盖 --out 目录下已存在的文件
  -h, --help          帮助

默认只打印，不触碰任何文件。

拿到密钥之后：
  1) 填进 src/license-secret.js 的 B64_CODE_KEY（或直接用 keyrotate.js --write 一步到位）
  2) 想让服务端与 git 里的值不同：Vercel 项目设置里加 JSLB_CODE_KEY 环境变量
  3) 发卡：node tools/issue/keygen.js --plan plus --days 365

⚠️ 密钥随源码分发（浏览器验卡要用），拿到源码的人能自己造卡；
   强制在服务端（赎回登记 + 门控）。别只依赖客户端校验。
`;

/** 解析失败统一出口。 */
function fail(msg) {
  console.error(msg);
  process.exit(1);
}

/**
 * 生成一把新密钥并做往返自检。
 * @returns {{keyB64:string, fingerprint:string, selfTest:object}}
 */
function generateKey() {
  // crypto.randomBytes 是 CSPRNG。绝不能用 Math.random 或项目里的 PRNG——
  // 那个是可复现的伪随机。
  const key = new Uint8Array(crypto.randomBytes(KEY_BYTES));
  const keyB64 = bytesToB64(key);

  // 往返自检：这把密钥签的卡能被它自己解析；换一把密钥就解析不过。
  const code = codec.issueCode(keyB64, 'plus', 30, '1');
  const roundTrip = code !== null && codec.parseCode(keyB64, code).ok;
  const otherKeyB64 = bytesToB64(new Uint8Array(32).fill(1));
  const cross = code === null || !codec.parseCode(otherKeyB64, code).ok;

  if (!roundTrip || !cross) {
    fail('密钥自检失败，拒绝输出（这通常意味着编解码实现有问题）');
  }

  return {
    keyB64,
    // 指纹：SHA-256 前 16 位 hex，方便肉眼比对"用的是哪把密钥"
    fingerprint: bytesToHex(sha256Bytes(key)).slice(0, 16),
    selfTest: { roundTrip, cross },
  };
}

/** 只校验密钥格式。 */
function checkKey(keyB64) {
  let bytes;
  try { bytes = b64ToBytes(keyB64); } catch (e) { bytes = null; }
  if (!bytes || bytes.length !== KEY_BYTES) {
    fail(`卡密密钥必须是 ${KEY_BYTES} 字节（base64），收到 ${bytes ? bytes.length : '无效'} 字节`);
  }
  return {
    keyB64,
    fingerprint: bytesToHex(sha256Bytes(bytes)).slice(0, 16),
  };
}

/** 写入 --out 目录。默认拒绝覆盖，--force 才允许。 */
function writeOut(dir, pair, force) {
  const abs = path.resolve(ROOT, dir);
  fs.mkdirSync(abs, { recursive: true });
  const p = path.join(abs, 'code-key.txt');
  if (fs.existsSync(p) && !force) {
    fail(`文件已存在，拒绝覆盖：${p}\n确认要覆盖就加 --force（旧密钥覆盖后无法恢复）。`);
  }
  fs.writeFileSync(p, pair.keyB64 + '\n', { mode: 0o600 });
  return [p];
}

function main(argv) {
  let outDir = null;
  let checkB64 = null;
  let asJson = false;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-h': case '--help': console.log(HELP); return;
      case '-o': case '--out': outDir = String(next() || ''); break;
      case '-c': case '--check': checkB64 = String(next() || ''); break;
      case '--json': asJson = true; break;
      case '--force': force = true; break;
      default:
        console.error(`未知选项 "${a}"（用 --help 查看用法）`);
        process.exit(1);
    }
  }

  if (checkB64 !== null) {
    const r = checkKey(checkB64);
    if (asJson) console.log(JSON.stringify(r, null, 2));
    else {
      console.log('卡密密钥格式合法。');
      console.log('  指纹: ' + r.fingerprint);
    }
    return;
  }

  const pair = generateKey();
  const written = outDir ? writeOut(outDir, pair, force) : [];

  if (asJson) {
    console.log(JSON.stringify({
      codeKey: pair.keyB64,
      fingerprint: pair.fingerprint,
      selfTest: pair.selfTest,
      written,
    }, null, 2));
    return;
  }

  console.log('卡密密钥已生成，往返自检通过。');
  console.log('');
  console.log('  卡密密钥（base64，32 字节）:');
  console.log('    ' + pair.keyB64);
  console.log('  指纹: ' + pair.fingerprint);
  console.log('');
  console.log('  填进 src/license-secret.js 的一行：');
  console.log(`    const B64_CODE_KEY = '${pair.keyB64}';`);
  if (written.length) {
    console.log('');
    for (const w of written) console.log(`  已写入: ${w}`);
  }
  console.log('');
  console.log('  下一步：');
  console.log('    1) 密钥写进 src/license-secret.js（或改用 keyrotate.js --write 一步到位）');
  console.log('    2) 服务端覆盖（可选）：Vercel 项目设置里加 JSLB_CODE_KEY 环境变量');
  console.log('    3) 发卡：node tools/issue/keygen.js --plan plus --days 365');
  console.log('');
  console.log('  ⚠️ 密钥随源码分发（浏览器验卡要用），拿到源码的人能自己造卡；');
  console.log('     强制在服务端（赎回登记 + 门控），别只依赖客户端校验。');
}

main(process.argv.slice(2));
