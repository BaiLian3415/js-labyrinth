#!/usr/bin/env node
'use strict';
/**
 * 网页端设备特征指纹的浏览器实测（线上驱动）。
 *
 * 只有浏览器能跑：指纹依赖 navigator / screen / WebGL，Node 里全是空占位，
 * 验不出"同一台机器两次算出同一个机器码"这件事。用 playwright-core + 系统
 * Chrome（agent-browser 不支持 Windows）。
 *
 * 本脚本**不打本地服务器**：直接访问已部署的 Cloudflare 站点，跑的就是
 * 线上那份 dist（含 Worker 下发的授权链路）。因此它验证的是"线上真的能算
 * 出一致的机器码"，而不是"本地构建产物能否算"。
 *
 * 需要网络。域名下方可用环境变量覆盖：
 *
 *   node tools/test/webfp.js
 *   JSLB_LIVE_ORIGIN=https://your.domain node tools/test/webfp.js
 *
 * 只自测离线逻辑时不要用本脚本——离线覆盖在 tools/test/selftest.js。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.JSLB_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = (process.env.JSLB_LIVE_ORIGIN || 'https://jslb.lllm.dpdns.org').replace(/\/+$/, '');

const { chromium } = await import('playwright-core');

/** 先确认线上确实活着，避免把"网站 404/502"误报成"指纹不一致"。 */
const probe = async (url) => {
  try {
    const r = await fetch(url, { method: 'GET' });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, status: 0, err: (e && e.message) || String(e) };
  }
};

const health = await probe(ORIGIN + '/api/health');
if (!health.ok) {
  console.error('[FAIL] 线上站点不可达：' + ORIGIN + '/api/health -> '
    + (health.status || health.err || 'unknown'));
  console.error('       本脚本依赖线上部署，请确认网络与域名后重试。');
  process.exit(1);
}
console.log('线上站点：' + ORIGIN + '（health ' + health.status + '）');

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
// 线上是 HTTPS，dist 里的模块由 Cloudflare 静态资源提供，无需任何本地映射。
await page.goto(ORIGIN + '/index.html', { waitUntil: 'domcontentloaded' });

const readFp = async (p) => p.evaluate(async () => {
  const lw = await import('./src/license-web.js');
  return {
    machine: await lw.machineId(),
    device: await lw.deviceCode(),
  };
});

const a = await readFp(page);
const b = await readFp(page);

// 换个"会话"（新上下文 = 清空站点数据）再取一次，验证指纹不依赖 localStorage
const ctx2 = await browser.newContext();
const page2 = await ctx2.newPage();
await page2.goto(ORIGIN + '/index.html', { waitUntil: 'domcontentloaded' });
const c = await readFp(page2);

await browser.close();

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
console.log(fail === 0 ? '\n网页端设备指纹线上实测全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
