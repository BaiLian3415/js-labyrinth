#!/usr/bin/env node
/**
 * 发布后验证。零依赖，直接跑：
 *
 *   node tools/build/verify-deploy.js <站点地址>
 *   node tools/build/verify-deploy.js https://jslb.lllm.dpdns.org/
 *   node tools/build/verify-deploy.js https://x.example --expect-require-license=false
 *
 * 为什么要有这个：2026-09-19 发现线上站点**根本没在强制卡密**——`wrangler.toml`
 * 里 `JSLB_WEB_CONFIG` 写着 `requireLicense: true`，部署输出也把这条列为 binding，
 * 但 `/api/plans` 返回的是 `platform.js` 的默认值 `false`，无卡密 POST 直接 200 成功。
 * 也就是说，配置写了、部署没报错，**不等于生效**。
 *
 * 所以每次发布后必须打这几个探针。三项都过才算发布成功：
 *
 *   1. /api/health 活着，且 runtime 与预期一致
 *   2. /api/plans 的档位数与本地一致，且 web.requireLicense 与预期一致
 *   3. /api/plans 的 web.* 与 wrangler.toml 的 [vars] JSLB_WEB_CONFIG 逐键一致
 *   4. 无卡密 POST /api/obfuscate 被拒（默认期望 402）
 *
 * 都不消耗配额：用的是随机设备码，且期望结果是被拒绝。
 *
 * 第 3 项是 2026-09-19 晚上补的。当天改了 `trialRunsPerDay`（0 → 10）并发布，前三项
 * 全过，但**没有一项校验试用限额**——只能靠手工拉 `/api/plans` 看一眼。web.* 这一组
 * 是唯一来自部署配置（`[vars]`）而不是代码的值，正是"写了不等于生效"的高风险区，
 * 不自动化等于没验证。
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import plan from '../../src/plan.js';
import { VERSION } from '../../src/version.js';

const args = process.argv.slice(2);
let base = '';
let expectRequireLicense = true;
let timeoutMs = 20000;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--expect-require-license') expectRequireLicense = args[++i] !== 'false';
  else if (a.startsWith('--expect-require-license=')) expectRequireLicense = a.split('=')[1] !== 'false';
  else if (a === '--timeout') timeoutMs = Number(args[++i]) || timeoutMs;
  else if (a === '-h' || a === '--help') {
    console.log('用法: node tools/build/verify-deploy.js <站点地址> [--expect-require-license=false] [--timeout 毫秒]');
    process.exit(0);
  } else if (!a.startsWith('-')) base = a;
}

if (!base) {
  console.error('缺少站点地址。例：node tools/build/verify-deploy.js https://jslb.lllm.dpdns.org/');
  process.exit(2);
}
base = base.replace(/\/+$/, '');

const device = randomBytes(16).toString('hex');
let failures = 0;
let checks = 0;

/** 带超时的 fetch，返回 {status, text}；网络失败时 status 为 0。 */
async function probe(path, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(base + path, { ...init, signal: ctl.signal });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    return { status: 0, text: (e && e.message) || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function report(ok, label, detail) {
  checks++;
  if (ok) {
    console.log('  ✅ ' + label + (detail ? '  ' + detail : ''));
  } else {
    failures++;
    console.log('  ❌ ' + label + (detail ? '  ' + detail : ''));
  }
}

/**
 * 读 wrangler.toml 的 [vars] JSLB_WEB_CONFIG（形如 `JSLB_WEB_CONFIG = '{...}'`）。
 * 读不到就返回 null，调用方跳过该探针——Pages 部署的配置来源不是这个文件，
 * 不该因为本地读不到 toml 就判失败。
 */
function readWebConfigVars() {
  try {
    const toml = readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8');
    const m = toml.match(/^[ \t]*JSLB_WEB_CONFIG[ \t]*=[ \t]*(['"])([\s\S]*?)\1/m);
    return m ? JSON.parse(m[2]) : null;
  } catch (e) {
    return null;
  }
}

console.log('发布后验证：' + base);
console.log('');

// ---- 1. 服务活着 ----
console.log('1) /api/health');
{
  const r = await probe('/api/health');
  if (r.status !== 200) {
    report(false, 'HTTP 200', '实得 ' + (r.status || '连接失败') + '  ' + r.text.slice(0, 80));
  } else {
    let j = null;
    try { j = JSON.parse(r.text); } catch (e) { /* 下面统一报 */ }
    report(!!j && j.ok === true, 'ok=true', j ? 'runtime=' + j.runtime + ' version=' + j.version : '响应不是 JSON');
    // 静态站点里 runtime 应为 worker（Worker 或 Pages Functions 都是 workerd）
    if (j) report(j.runtime === 'worker', 'runtime=worker', '实得 ' + j.runtime);
    // 版本一致性：线上报的版本必须等于本地 src/version.js（单一真源）。
    // 版本断言从这里读取而不是硬编码，升级版本号时本文件无需改动；
    // 部署了旧构建（改完代码忘了 deploy）时这一项会立刻失败。
    if (j) report(j.version === VERSION, '线上版本 = ' + VERSION, '实得 ' + (j.version ?? '（缺失）'));
  }
}

// ---- 2. 套餐表与网页版策略 ----
console.log('');
console.log('2) /api/plans');
{
  const r = await probe('/api/plans');
  let j = null;
  if (r.status !== 200) {
    report(false, 'HTTP 200', '实得 ' + (r.status || '连接失败'));
  } else {
    try { j = JSON.parse(r.text); } catch (e) { /* 下面统一报 */ }
    if (!j) {
      report(false, '响应是 JSON', r.text.slice(0, 80));
    } else {
      const want = plan.PLAN_NAMES.length;
      const got = Array.isArray(j.plans) ? j.plans.length : -1;
      report(got === want, '档位数 = ' + want, '实得 ' + got + '（' + (j.plans || []).map((p) => p.display).join('/') + '）');
      const rl = j.web && j.web.requireLicense;
      report(rl === expectRequireLicense, 'web.requireLicense = ' + expectRequireLicense,
        '实得 ' + JSON.stringify(rl) + (rl === expectRequireLicense ? '' : '  ← 配置没生效！'));

      // 逐档比对本地定义与线上返回。改了 plans.js 但没重新部署（或部署到了别的
      // 服务）时，这里会立刻暴露——光看档位数一样是发现不了的。
      const diff = [];
      for (const lo of plan.rows()) {
        const li = (j.plans || []).find((p) => p.name === lo.name);
        if (!li) { diff.push(lo.name + ' 线上缺失'); continue; }
        if (li.preset !== lo.preset) diff.push(lo.name + ' 预设上限 ' + li.preset + '≠' + lo.preset);
        // kind（subscription/pack）也要比：两族的额度口径不同，族错了记账方式就错了
        if (li.kind !== lo.kind) diff.push(lo.name + ' 族 ' + li.kind + '≠' + lo.kind);
        // runsTotal 是一次性额度包的额度，漏了这项就等于没校验额度包
        for (const k of ['maxFileBytes', 'maxFilesPerRun', 'runsPerDay', 'runsTotal']) {
          const a = li.limits ? li.limits[k] : undefined;
          if (a !== lo.limits[k]) diff.push(lo.name + ' ' + k + ' ' + a + '≠' + lo.limits[k]);
        }
        const a = (li.offOptions || []).slice().sort().join(',');
        const b = lo.offOptions.slice().sort().join(',');
        if (a !== b) diff.push(lo.name + ' 关闭项不一致');
      }
      report(diff.length === 0, '线上档位表与本地定义逐档一致',
        diff.length ? diff.slice(0, 3).join('；') + (diff.length > 3 ? ' …' : '') + '  ← 部署的不是这份代码' : '');

      // 部署配置类字段（试用限额等）逐键比对 wrangler.toml 的 [vars]。
      // 这组值是唯一"来自配置而非代码"的，是部署有没有真的吃进配置的最灵敏指标。
      const vars = readWebConfigVars();
      if (vars) {
        const wd = [];
        for (const k of Object.keys(vars)) {
          const online = j.web ? j.web[k] : undefined;
          if (online !== vars[k]) wd.push(k + ' 线上 ' + JSON.stringify(online) + '≠配置 ' + JSON.stringify(vars[k]));
        }
        report(wd.length === 0, 'web 策略与 wrangler.toml 的 [vars] 一致',
          wd.length ? wd.join('；') + '  ← 部署配置没生效' : '');
      }
    }
  }
}

// ---- 3. 未激活必须被拒 ----
console.log('');
console.log('3) 无卡密 POST /api/obfuscate');
{
  const r = await probe('/api/obfuscate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-JSLB-Device': device },
    body: JSON.stringify({ code: 'var a=1;console.log(a);', options: { preset: 'low' } }),
  });
  const want = expectRequireLicense ? 402 : 200;
  let j = null;
  try { j = JSON.parse(r.text); } catch (e) { /* 非 JSON，例如 1102 CPU 超限页 */ }
  report(r.status === want, 'HTTP ' + want + '（未激活一律拒绝）',
    '实得 ' + (r.status || '连接失败') + (j && !j.ok ? '  ' + String(j.message || '').slice(0, 60) : ''));
}

console.log('');
if (failures === 0) {
  console.log('✅ ' + checks + ' 项全过，发布可用。');
} else {
  console.log('❌ ' + failures + '/' + checks + ' 项失败——**先别对外公布**。');
  console.log('   最可能的原因：wrangler.toml 的 [vars] 没生效，或部署到了别的 Worker/Pages 项目。');
  console.log('   排查顺序：① 确认域名指向的是哪个 Worker（wrangler deployments list）');
  console.log('   ② 改一个醒目的值（如 trialRunsPerDay: 7）重新发布，看 /api/plans 会不会跟着变');
  console.log('   ③ 若不变，说明发布的不是同一个服务');
}
process.exit(failures === 0 ? 0 : 1);
