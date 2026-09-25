#!/usr/bin/env node
/**
 * CDP 模拟沙箱（selftest 专用）。用法：
 *
 *   node tools/test/cdp-sandbox.js <product.js> <mode>
 *
 * mode：
 *   clean     干净浏览器环境（window/document/navigator 齐备，console 静默）
 *   webdriver navigator.webdriver === true（Puppeteer / Playwright 默认签名）
 *   cdp       console 序列化模拟 Runtime.enable（log 触发 1 次访问器，debug
 *             触发 2 次——真实 CDP 的 consoleAPICalled 预览 + 缓冲双读特征）
 *   weak      仅 log 触发 1 次（弱证据，不应投毒）
 *
 * 产物在 node:vm 新上下文里执行：不提供 performance / setInterval 为真实
 * 定时器（返回带 unref 的假句柄，不排期），process.stdout.write 被收集，
 * 运行结束后原样写到真实 stdout。Anti-CDP 命中引发的字符串池投毒会体现为
 * 输出腐蚀（或运行抛错），逐位比对即可判定。
 */
import fs from 'node:fs';
import vm from 'node:vm';

const file = process.argv[2];
const mode = process.argv[3] || 'clean';
const code = fs.readFileSync(file, 'utf8');
const out = [];

// 模拟 CDP 预览序列化：枚举对象自属性，访问器直接求值 times 次。
// 用 getOwnPropertyNames 而非 Object.keys——真实 CDP 的对象预览不区分
// 可枚举性，访问器一律求值；只看 keys 会漏掉非枚举探针，模拟就失真了
const fireGetters = (o, times) => {
  if (!o || typeof o !== 'object') return;
  for (const k of Object.getOwnPropertyNames(o)) {
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (d && typeof d.get === 'function') {
      for (let i = 0; i < times; i++) {
        try { d.get.call(o); } catch (e) { /* 忽略 */ }
      }
    }
  }
};
const silent = () => {};
const sandboxConsole = {
  log: mode === 'cdp' ? (o) => fireGetters(o, 1) : (mode === 'weak' ? (o) => fireGetters(o, 1) : silent),
  debug: mode === 'cdp' ? (o) => fireGetters(o, 2) : silent,
  info: silent, warn: silent, error: silent, trace: silent, table: silent,
};

const sandbox = {
  console: sandboxConsole,
  process: {
    stdout: { write: (s) => { out.push(String(s)); } },
    env: {}, execArgv: [], version: '', platform: 'browser',
  },
  // 假定时器：登记动作存在但不排期，沙箱内不会真的异步触发
  setInterval: () => ({ unref() {} }),
  clearInterval: () => {},
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.outerWidth = 100; sandbox.innerWidth = 100;
sandbox.outerHeight = 200; sandbox.innerHeight = 200;
sandbox.document = { visibilityState: 'visible' };
sandbox.navigator = mode === 'webdriver'
  ? { webdriver: true, userAgent: 'Mozilla/5.0' }
  : { userAgent: 'Mozilla/5.0' };

try {
  vm.runInNewContext(code, sandbox, { timeout: 30000 });
} catch (e) {
  out.push('\n|THREW:' + (e && e.message ? String(e.message).slice(0, 60) : 'err'));
}
process.stdout.write(out.join(''));
