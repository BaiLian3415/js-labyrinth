#!/usr/bin/env node
'use strict';
/**
 * 网页端设备特征指纹的浏览器实测。
 *
 * 只有浏览器能跑：指纹依赖 navigator / screen / WebGL，Node 里全是空占位，
 * 验不出"同一台机器两次算出同一个机器码"这件事。用 playwright-core + 系统
 * Chrome（agent-browser 不支持 Windows）。
 *
 * 用法: node tools/test/webfp.js
 */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(ROOT, 'dist');
const CHROME = process.env.JSLB_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

// file:// 下浏览器拒绝加载 ESM（跨源），必须起一个本地静态服务。
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = path.join(DIST, rel);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = 'http://127.0.0.1:' + server.address().port;

const { chromium } = await import('playwright-core');

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
await page.goto(ORIGIN + '/index.html');

const probe = async (p) => p.evaluate(async () => {
  const lw = await import('./src/license-web.js');
  return {
    machine: await lw.machineId(),
    device: await lw.deviceCode(),
  };
});

const a = await probe(page);
const b = await probe(page);

// 换个"会话"（新上下文 = 清空站点数据）再取一次，验证指纹不依赖 localStorage
const ctx2 = await browser.newContext();
const page2 = await ctx2.newPage();
await page2.goto(ORIGIN + '/index.html');
const c = await probe(page2);

await browser.close();
server.close();

const results = [
  ['机器码为 24 字符 base32', a.machine.length === 24 && /^[0-9A-HJKMNP-TV-Z]{24}$/.test(a.machine), a.machine],
  ['同一页面两次取值相同', a.machine === b.machine, ''],
  ['清空站点数据后机器码不变（指纹不依赖 localStorage）', a.machine === c.machine, ''],
  ['设备码在清空站点数据后会变（它仍是随机的）', a.device !== c.device, ''],
];

let fail = 0;
for (const [name, pass, extra] of results) {
  if (!pass) fail++;
  console.log((pass ? '[OK]   ' : '[FAIL] ') + name + (extra && !pass ? '  (' + extra + ')' : ''));
}
console.log(fail === 0 ? '\n网页端设备指纹实测全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
