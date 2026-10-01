#!/usr/bin/env node
/**
 * ZIP 打包：文件头、CRC 与中央目录结构。
 *
 *   node test/zip.js
 *
 * 整跑全部用例：npm test（即 node test/selftest.js）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { TMP, VERBOSE, cleanTmp, ok, report, section, tryExtract } from './_harness.js';
import makeZip from '../src/utils/zip.js';
import hash from '../src/utils/hash.js';

const { makeZip: zip } = makeZip;
section('ZIP 打包');
{
  const files = [
    { name: 'a.js', data: 'console.log("a");\n' },
    { name: 'sub/b.js', data: '中文字符串\n' },
  ];
  const bytes = zip(files, new Date('2026-01-02T03:04:05Z'));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  ok(view.getUint32(0, true) === 0x04034b50, '本地文件头签名正确');

  // 中央目录偏移与条目数
  const eocd = bytes.length - 22;
  ok(view.getUint32(eocd, true) === 0x06054b50, '中央目录结束记录签名正确');
  ok(view.getUint16(eocd + 10, true) === files.length, '条目数为 2');
  const cdOffset = view.getUint32(eocd + 16, true);
  ok(view.getUint32(cdOffset, true) === 0x02014b50, '中央目录项签名正确');

  // 第一个条目的 CRC 与内容
  const nameLen = view.getUint16(26, true);
  const dataStart = 30 + nameLen;
  const dataLen = view.getUint32(18, true);
  const crcStored = view.getUint32(14, true);
  const payload = bytes.subarray(dataStart, dataStart + dataLen);
  ok(crcStored === zlib.crc32(payload), 'CRC-32 与 zlib 一致');
  ok(hash.utf8Length('console.log("a");\n') === dataLen, '大小字段正确');

  // 用系统解压器验证一遍（unzip / PowerShell / bsdtar 任取其一）
  const zipPath = path.join(TMP, 'test.zip');
  fs.writeFileSync(zipPath, bytes);
  const dir = path.join(TMP, 'unzip');
  fs.mkdirSync(dir, { recursive: true });
  const extracted = tryExtract(zipPath, dir);
  if (extracted) {
    ok(fs.existsSync(path.join(dir, 'a.js')) && fs.existsSync(path.join(dir, 'sub', 'b.js')),
      '系统解压器能还原两个条目', extracted);
    const round = fs.readFileSync(path.join(dir, 'sub', 'b.js'), 'utf8');
    ok(round === '中文字符串\n', '解压内容与原文一致（含中文）');
  } else if (VERBOSE) {
    console.log('    （本机没有可用的解压器，跳过解压验证）');
  }
}

if (process.argv[1] && process.argv[1].endsWith('zip.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}
