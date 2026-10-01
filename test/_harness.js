#!/usr/bin/env node
/**
 * 自测共用件：断言、临时目录、子进程执行与示例源码。
 *
 * 每个用例文件只 import 本模块，不再各自重复一遍 ok/section/runNode。
 * 断言结果记在模块级的计数器里，由 runAll 汇总——单跑一个文件时，
 * 进程退出码与统计口径和整跑一致。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERBOSE = process.argv.includes('--verbose');
export const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jslb-selftest-'));

// 临时目录必须随进程一起消失。各文件跑完可能提前 return、断言失败时也可能中途
// 抛错——都会把 os.tmpdir()/jslb-selftest-* 留在盘上。这里挂进程级兜底，
// 保证任何退出路径（正常、抛错、Ctrl-C、process.exit）都能清掉。
let tmpCleaned = false;
export function cleanTmp() {
  if (tmpCleaned) return;
  tmpCleaned = true;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
}
process.on('exit', cleanTmp);
process.on('SIGINT', () => { cleanTmp(); process.exit(130); });
process.on('SIGTERM', () => { cleanTmp(); process.exit(143); });
process.on('uncaughtException', (e) => { cleanTmp(); throw e; });

let pass = 0;
let fail = 0;
const failures = [];

/** 取当前累计的通过/失败数。用例文件偶尔要按通过数做判定。 */
export function counters() {
  return { pass, fail, failures };
}

/**
 * 断言。失败只记账不抛错，这样一段失败不影响后面继续跑完。
 * @param {boolean} cond 条件
 * @param {string} label 断言描述
 * @param {string} [detail] 失败时的补充信息
 */
export function ok(cond, label, detail) {
  if (cond) {
    pass++;
    if (VERBOSE) console.log('  [OK] ' + label);
    return;
  }
  fail++;
  failures.push(label + (detail ? ' — ' + detail : ''));
  console.log('  [FAIL] ' + label + (detail ? ' — ' + detail : ''));
}

/**
 * 只去掉注释，字符串内容原样保留。
 *
 * 用它来数 import / 看模块依赖：字符串里出现的 from '...' 不是真的依赖。
 */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * 去掉注释与字符串/模板字面量，只留代码骨架。
 *
 * 扫描"有没有字符串代码生成"时必须用这个：壳里的 `'(0,eval)'` 与帮助文案里的
 * eval 都只是数据，用 stripComments 会把它们当成真实调用（i18n.js 与 shell.js
 * 就是这样误报的）。反过来，删掉字符串后仍能命中的才是真的代码生成。
 */
export function stripLiterals(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

/** 断言某段代码会抛异常。 */
export function throws(fn, label) {
  try {
    fn();
    ok(false, label, '未抛出异常');
  } catch (e) {
    ok(true, label);
  }
}

/** 打印一个分组标题。 */
export function section(name) {
  console.log('\n' + name);
}

/**
 * 用系统自带的解压器解开 zip，成功返回所用命令名，都不可用返回 null。
 * Windows 用 PowerShell 的 Expand-Archive，其余平台优先 unzip，再退 bsdtar。
 * @param {string} zipPath zip 路径
 * @param {string} dest 目标目录
 * @returns {string|null} 命令标识
 */
export function tryExtract(zipPath, dest) {
  const attempts = [];
  if (process.platform === 'win32') {
    attempts.push(['powershell', ['-NoProfile', '-Command',
      'Expand-Archive -LiteralPath ' + JSON.stringify(zipPath) + ' -DestinationPath ' + JSON.stringify(dest) + ' -Force']]);
  }
  attempts.push(['unzip', ['-o', '-q', zipPath, '-d', dest]]);
  attempts.push(['bsdtar', ['-xf', zipPath, '-C', dest]]);
  for (const [cmd, args] of attempts) {
    try {
      execFileSync(cmd, args, { stdio: 'ignore', timeout: 30000 });
      return cmd;
    } catch (e) { /* 试下一个 */ }
  }
  return null;
}

/** 示例源码，覆盖字符串、模板串、类、条件、循环、async 与对象键。 */
export const SAMPLE = `
const GREETING = 'hello world';
const tpl = \`prefix-\${GREETING}-suffix\`;
function classify(n) {
  if (n > 100 && n % 2 === 0) return 'big-even';
  if (n > 100) return 'big-odd';
  return n === 0 ? 'zero' : 'small';
}
class Counter { constructor(s) { this.value = s; } inc(b) { this.value += (b === undefined ? 1 : b); return this.value; } }
const obj = { alpha: 1, 'beta-gamma': [1, 2, 3], nested: { deep: { key: 'value' } } };
const c = new Counter(3);
for (let i = 0; i < 5; i++) c.inc(i);
const list = [1, 2, 3, 4].map((x) => x * x).filter((x) => x > 2);
async function main() {
  await Promise.resolve();
  process.stdout.write([GREETING, tpl, obj['beta-gamma'].length, obj.nested.deep.key, c.value, list.join('|'), classify(400)].join(' ') + '\n');
}
main();
`;

/**
 * 同步跑一个子进程并拿回输出。
 *
 * stdio 必须显式写成数组：默认管道（含 `stdin: 'ignore'` 简写之外的默认
 * 'pipe'）在部分 Windows 环境会直接以 EBUSY 失败——父进程的标准句柄来自上层
 * 宿主（IDE 内置终端、CI 包装器）时，spawnSync 建 stdin 管道这一步就过不去，
 * 整套测试会在第一个用例崩掉。stdout/stderr 仍是管道，返回值照常。
 * `stdio: 'ignore'`（三项全忽略，无管道）在同样环境下是好的，无需改动。
 */
const SYNC_STDIO = ['ignore', 'pipe', 'pipe'];
// spawn 阶段的瞬时资源失败（Windows 高强度进程孵化下偶发）：errno 挂在 code
// 上且没有子进程 status。与产物非零退出（有 status）区分开，前者退避后重试
// 一次，后者照常抛出交给用例判定。
const TRANSIENT_SPAWN_ERRNO = new Set(['ENOMEM', 'EBUSY', 'ETXTBSY', 'EAGAIN', 'EMFILE']);
export function runSync(exe, args, opts) {
  try {
    return execFileSync(exe, args, { stdio: SYNC_STDIO, ...(opts || {}) });
  } catch (e) {
    if (e && !e.status && TRANSIENT_SPAWN_ERRNO.has(e.code)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      return execFileSync(exe, args, { stdio: SYNC_STDIO, ...(opts || {}) });
    }
    throw e;
  }
}

/** 用 node 跑一段产物，返回 stdout。 */
export function runNode(code, name) {
  const file = path.join(TMP, name || ('run-' + Math.random().toString(36).slice(2) + '.js'));
  fs.writeFileSync(file, code);
  return runSync(process.execPath, [file], { encoding: 'utf8', timeout: 60000 });
}

/** 打印本轮统计，并在有失败时把进程退出码置 1。 */
export function report() {
  const c = counters();
  console.log('\n' + (c.fail === 0 ? '✅ 全部通过' : '❌ 有失败项') + '：' + c.pass + ' 项通过，' + c.fail + ' 项失败');
  if (c.fail) {
    for (const f of c.failures) console.log('  - ' + f);
  }
  return c.fail;
}