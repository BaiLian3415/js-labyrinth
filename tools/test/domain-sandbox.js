#!/usr/bin/env node
/**
 * 域名锁定沙箱（selftest 专用）。用法：
 *
 *   node tools/test/domain-sandbox.js <product.js> <hostname> [hostWithPort]
 *
 * hostname 传 "-" 表示不提供 location（Node 直跑形态）。
 *
 * 产物在 node:vm 新上下文里执行：console 静默、process.stdout.write 被收集、
 * 运行结束后原样写到真实 stdout。域名锁定命中引发的字符串池整体偏移会体现为
 * 输出腐蚀，降级 throw 模式则体现为 |THREW 前缀，逐位比对即可判定。
 */
import fs from 'node:fs';
import vm from 'node:vm';

const file = process.argv[2];
const hostname = process.argv[3] || '-';
const host = process.argv[4] || hostname;
const code = fs.readFileSync(file, 'utf8');
const out = [];

const sandbox = {
  console: { log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  process: {
    stdout: { write: (s) => { out.push(String(s)); } },
    env: {}, execArgv: [], version: '', platform: 'browser',
  },
  setInterval: () => ({ unref() {} }),
  clearInterval: () => {},
};
if (hostname !== '-') {
  sandbox.location = { hostname, host };
}
sandbox.window = sandbox;
sandbox.self = sandbox;

try {
  vm.runInNewContext(code, sandbox, { timeout: 30000 });
} catch (e) {
  out.push('\n|THREW:' + (e && e.message ? String(e.message).slice(0, 60) : 'err'));
}
process.stdout.write(out.join(''));
