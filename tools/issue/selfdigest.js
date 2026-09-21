#!/usr/bin/env node
'use strict';
/**
 * 自身摘要表生成工具，给发卡方和维护者用。
 *
 *   node tools/issue/selfdigest.js          打印当前应有的摘要表，不改文件
 *   node tools/issue/selfdigest.js --write  改写 src/license-secret.js 里的表
 *   node tools/issue/selfdigest.js --check  校验表与源码是否一致，CI 使用
 *
 * 摘要规则和 src/license.js 保持一致，digest_i 取 normalize(text_i) 的 sha256，
 * 结果是 64 位 hex，stored_i 再用 HMAC-SHA256(PUBLIC_KEY, 'JSLB/SELF/' + i) 做异或掩码。
 * 掩码密钥是公钥（公开的），所以这张表只挡随手改动，不挡有心人——见 license-secret.js。
 * normalize 会把文本里所有 64 位 hex 串抹成 0，为的是避免摘要表引用自身，
 * 不然每写一次表摘要就变一次，永远收敛不了。
 *
 * 改过 src/license-core.js、src/license-codec.js、src/license-secret.js、src/plan.js
 * 或 src/plans.js 之后要重跑本工具并提交新的摘要表，否则会判定自身被篡改。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SECRET_PATH = path.join(ROOT, 'src', 'license-secret.js');

/** 顺序必须和 src/license-secret.js 里 SELF_DIGESTS 的顺序一致。 */
const SELF_FILES = [
  'src/license-core.js',
  'src/license-codec.js',
  'src/license-secret.js',
  // 套餐定义与判定也在校验范围内：不放进来，改 plans.js 就能自行解锁高档权益
  'src/plan.js',
  'src/plans.js',
];

/** @see license.js normalizeForHash */
function normalizeForHash(text) {
  return text.replace(/\b[0-9a-f]{64}\b/g, '0'.repeat(64));
}

function fileDigest(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return crypto.createHash('sha256').update(normalizeForHash(text), 'utf8').digest('hex');
}

function xorHex(a, b) {
  let out = '';
  for (let i = 0; i < a.length; i++) out += (parseInt(a[i], 16) ^ parseInt(b[i], 16)).toString(16);
  return out;
}

function main(argv) {
  const write = argv.includes('--write');
  const check = argv.includes('--check');

  // 版本号两处必须一致：package.json 与 src/version.js（界面与帮助文本读后者）
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const verSrc = fs.readFileSync(path.join(ROOT, 'src', 'version.js'), 'utf8');
  const mVer = verSrc.match(/VERSION = '([^']+)'/);
  if (!mVer || mVer[1] !== pkgVersion) {
    console.error('版本号不一致：package.json=' + pkgVersion + '，src/version.js=' + (mVer ? mVer[1] : '?'));
    console.error('请把两处改成同一个值。');
    process.exit(1);
  }

  // 只从 B64_PUBLIC_KEY 取公钥来算掩码，不读 SELF_DIGESTS 的当前值
  const secretSrc = fs.readFileSync(SECRET_PATH, 'utf8');
  const m = secretSrc.match(/const B64_PUBLIC_KEY = '([^']+)';/);
  if (!m) {
    console.error('无法从 src/license-secret.js 解析 B64_PUBLIC_KEY');
    process.exit(1);
  }
  const publicKey = m[1];

  const stored = SELF_FILES.map((rel, i) => {
    const mask = crypto.createHmac('sha256', publicKey).update('JSLB/SELF/' + i).digest('hex');
    return xorHex(fileDigest(rel), mask);
  });

  const block = 'const SELF_DIGESTS = [\n' + stored.map((s) => `  '${s}',`).join('\n') + '\n];';

  if (check) {
    const cur = secretSrc.match(/const SELF_DIGESTS = \[([\s\S]*?)\];/);
    const curList = cur ? [...cur[1].matchAll(/'([0-9a-f]{64})'/g)].map((x) => x[1]) : [];
    const same = curList.length === stored.length && curList.every((v, i) => v === stored[i]);
    if (!same) {
      console.error('自身摘要表已过期，请运行: node tools/issue/selfdigest.js --write');
      process.exit(1);
    }
    console.log('自身摘要表与当前源码一致');
    return;
  }

  if (write) {
    // 摘要表自身也在被校验的文件里（license-secret.js），而 normalize 只把 64 位
    // hex 抹零、不抹掉表项的条数，所以条目数一变，实算摘要就跟着变。这里迭代到
    // 不动点为止：改写 → 重算，直到两次结果一致。
    let next = secretSrc;
    let prev = null;
    for (let i = 0; i < 6; i++) {
      const cur = SELF_FILES.map((rel, idx) => {
        const mask = crypto.createHmac('sha256', publicKey).update('JSLB/SELF/' + idx).digest('hex');
        return xorHex(fileDigest(rel), mask);
      });
      const body = 'const SELF_DIGESTS = [\n' + cur.map((s) => `  '${s}',`).join('\n') + '\n];';
      prev = cur.join('\n');
      next = next.replace(/const SELF_DIGESTS = \[[\s\S]*?\];/, body);
      if (!next.includes('const SELF_DIGESTS = [')) {
        console.error('未找到 SELF_DIGESTS 定义');
        process.exit(1);
      }
      // 写盘后再算一次，若与本次一致则已达不动点
      fs.writeFileSync(SECRET_PATH, next);
      const again = SELF_FILES.map((rel, idx) => {
        const mask = crypto.createHmac('sha256', publicKey).update('JSLB/SELF/' + idx).digest('hex');
        return xorHex(fileDigest(rel), mask);
      }).join('\n');
      if (again === prev) {
        console.log('已更新 ' + path.relative(ROOT, SECRET_PATH) + (i ? '（迭代 ' + (i + 1) + ' 次收敛）' : ''));
        return;
      }
    }
    console.error('摘要表未收敛，请检查 SELF_FILES 与文件内容');
    process.exit(1);
  }

  console.log(block);
}

main(process.argv.slice(2));
