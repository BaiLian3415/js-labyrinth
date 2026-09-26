#!/usr/bin/env node
'use strict';
/**
 * 卡密密钥的生成与轮换工具。发卡方使用，不随最终用户分发。
 *
 * 用法:
 *   node tools/issue/keyrotate.js                 # 只生成一把新密钥，不改任何文件
 *   node tools/issue/keyrotate.js --write         # 密钥写入 src/license-secret.js 的
 *                                                 # B64_CODE_KEY 与 .jslb-code-key，并重算摘要表
 *   node tools/issue/keyrotate.js --json          # 以 JSON 输出
 *   node tools/issue/keyrotate.js --key <b64>     # 用指定的 32 字节密钥（base64）落盘
 *   -h, --help                                   帮助
 *
 * v5 卡密是对称格式（编号 + 加密信息段 + 校验码），签发与校验共用**同一把**密钥。
 * 它写进 src/license-secret.js 随源码分发（浏览器本地验卡要用），因此不是秘密：
 * 拿到源码的人能自己造卡，真正的强制在服务端（/api/obfuscate 逐请求校验 + 云存储
 * 赎回登记）。它的保密要求只对"离线/私有部署场景"有意义。
 *
 * 换密钥等于换发卡权：所有旧卡密与所有 license 记录立即失效（校验必然失败），
 * 每台机器都要用新卡密重新激活。服务端与 git 里的值不一致时，用
 * Vercel 项目设置里的 `JSLB_CODE_KEY` 环境变量覆盖服务端取值。
 *
 * --write 之后会自动调用 tools/issue/selfdigest.js 重算自身摘要表：表中的掩码由
 * 卡密密钥派生，密钥一变还原出的摘要就全错，CLI 会判定自身被篡改并以退出码 2
 * 静默退出。顺序不能颠倒。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import codec from '../../src/license-codec.js';
import { bytesToB64, b64ToBytes } from '../../src/utils/hash.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SECRET_PATH = path.join(ROOT, 'src', 'license-secret.js');
const CODE_KEY_PATH = path.join(ROOT, '.jslb-code-key');
const SELFDIGEST_PATH = path.join(__dirname, 'selfdigest.js');

/** 卡密密钥长度，固定 32 字节。 */
const KEY_BYTES = 32;

/** B64_CODE_KEY 定义块，与 src/license-secret.js 的写法一致。 */
const KEY_PATTERN = /const B64_CODE_KEY = '[^']*';/;

const HELP = `JsLabyrinth 卡密密钥生成/轮换工具

用法: node tools/issue/keyrotate.js [选项]

  -w, --write        新密钥写入 src/license-secret.js 的 B64_CODE_KEY 与
                     .jslb-code-key，随后重算自身摘要表
  -k, --key <b64>    用指定的 32 字节密钥（base64），不随机生成
  --json             以 JSON 输出
  -h, --help         帮助

不带 --write 时只打印新密钥，不触碰任何文件。

示例:
  node tools/issue/keyrotate.js              # 预览一把新密钥
  node tools/issue/keyrotate.js --write      # 生成并落盘，随后重算摘要表

注意: 落盘后旧卡密与旧 license 记录全部失效，需重新运行 node tools/issue/keygen.js 发卡。
`;

/** 校验密钥长度；非法时退出。 */
function keyFromB64(keyB64) {
  let bytes;
  try { bytes = b64ToBytes(keyB64); } catch (e) { bytes = null; }
  if (!bytes || bytes.length !== KEY_BYTES) {
    console.error(`密钥必须是 ${KEY_BYTES} 字节（base64），收到 ${bytes ? bytes.length : '无效'} 字节`);
    process.exit(1);
  }
  return keyB64;
}

/** 生成一把新密钥并做往返自检。 */
function newKey() {
  // crypto.randomBytes 是 CSPRNG。绝不能用项目里的 PRNG——那是可复现的伪随机。
  const keyB64 = bytesToB64(new Uint8Array(crypto.randomBytes(KEY_BYTES)));
  const code = codec.issueCode(keyB64, 'plus', 30, '1');
  const ok = code !== null && codec.parseCode(keyB64, code).ok;
  if (!ok) {
    console.error('密钥自检失败，拒绝输出（这通常意味着编解码实现有问题）');
    process.exit(1);
  }
  return keyB64;
}

/** 写入密钥（进源码与本地文件），并重算自身摘要表。 */
function writeKeys(keyB64) {
  const src = fs.readFileSync(SECRET_PATH, 'utf8');
  if (!KEY_PATTERN.test(src)) {
    console.error('未在 src/license-secret.js 找到 B64_CODE_KEY 定义');
    process.exit(1);
  }
  fs.writeFileSync(SECRET_PATH, src.replace(KEY_PATTERN, `const B64_CODE_KEY = '${keyB64}';`));
  console.error('已更新 ' + path.relative(ROOT, SECRET_PATH) + '（B64_CODE_KEY）');

  fs.writeFileSync(CODE_KEY_PATH, keyB64 + '\n', { mode: 0o600 });
  console.error('已写入 ' + path.relative(ROOT, CODE_KEY_PATH) + '（签发方用，勿提交）');

  // 摘要表的掩码由新密钥派生，只能在写入之后重算
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
  let keyB64 = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-h': case '--help': console.log(HELP); return;
      case '-w': case '--write': write = true; break;
      case '-k': case '--key': keyB64 = String(next() || ''); break;
      case '--json': asJson = true; break;
      default:
        console.error(`未知选项 "${a}"（用 --help 查看用法）`);
        process.exit(1);
    }
  }

  const key = keyB64 !== null ? keyFromB64(keyB64) : newKey();

  if (!write) {
    if (asJson) {
      console.log(JSON.stringify({ codeKey: key }, null, 2));
      return;
    }
    console.log(`const B64_CODE_KEY = '${key}';`);
    console.error('只读预览：未改动任何文件；确认后加 --write 落盘。');
    return;
  }

  writeKeys(key);

  if (asJson) {
    console.log(JSON.stringify({
      codeKey: key,
      secretFile: path.relative(ROOT, SECRET_PATH),
      keyFile: path.relative(ROOT, CODE_KEY_PATH),
    }, null, 2));
  } else {
    console.log(`const B64_CODE_KEY = '${key}';`);
  }
  console.error('卡密密钥已轮换。所有旧卡密与现有 license 记录已全部失效，');
  console.error('请用 node tools/issue/keygen.js 重新发卡，并让各机器重新激活。');
}

main(process.argv.slice(2));
