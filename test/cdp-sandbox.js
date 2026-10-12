#!/usr/bin/env node
/**
 * CDP 模拟沙箱（selftest 专用）。用法：
 *
 *   node test/cdp-sandbox.js <product.js> <mode>
 *
 * mode：
 *   clean     干净浏览器环境（window/document/navigator 齐备，console 静默）
 *   webdriver navigator.webdriver === true（Puppeteer / Playwright 默认签名）
 *   cdp       console 序列化模拟 Runtime.enable（log 触发 1 次访问器，debug
 *             触发 2 次——真实 CDP 的 consoleAPICalled 预览 + 缓冲双读特征）
 *   weak      仅 log 触发 1 次（弱证据，不应投毒）
 *   stealth   stealth 伪装：navigator 实例上 defineProperty 一个返回 false 的
 *             webdriver 访问器（原型形态见 stock-proto，判据见 antiCDP 的 v2Src）
 *   stealth-v 同上但用自有**数据**属性（{value:false}），另一派 stealth 库的做法
 *   stealth-p 原型级覆盖：实例上不留任何痕迹（**已知残余**，不应被判为命中）
 *   stock-proto 真实浏览器形态：webdriver 是原型上的可枚举可配置访问器，实例上
 *             没有任何同名自有属性。**这是防误报的基准形态，必须不投毒**
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
// navigator 形态。四种 stealth/基准形态都要按真实浏览器的描述符布局搭，不能图
// 简单写成 { webdriver: false }——那是**自有数据属性**，恰好会被新增判据命中，
// 用来测"不误报"是无效的（基准形态必须是 webdriver 在原型上、实例上什么都没有）。
function makeNavigator(kind) {
  const proto = {};
  const stockProto = () => Object.defineProperty(proto, 'webdriver',
    { configurable: true, enumerable: true, get() { return false; } });
  if (kind === 'stock-proto' || kind === 'stealth' || kind === 'stealth-v' || kind === 'stealth-p') stockProto();
  const nav = Object.create(proto);
  Object.defineProperty(nav, 'userAgent', { value: 'Mozilla/5.0', enumerable: true, configurable: true });
  if (kind === 'webdriver') {
    Object.defineProperty(nav, 'webdriver', { value: true, enumerable: true, configurable: true });
  } else if (kind === 'stealth') {
    Object.defineProperty(nav, 'webdriver', { configurable: true, get() { return false; } });
  } else if (kind === 'stealth-v') {
    Object.defineProperty(nav, 'webdriver', { value: false, enumerable: true, configurable: true });
  } else if (kind === 'stealth-p') {
    // 原型级覆盖：实例上不留任何痕迹，纯 JS 侧与原生访问器无法区分
    Object.defineProperty(proto, 'webdriver', { configurable: true, enumerable: true, get() { return false; } });
  }
  return nav;
}

sandbox.navigator = makeNavigator(mode);

try {
  vm.runInNewContext(code, sandbox, { timeout: 30000 });
} catch (e) {
  out.push('\n|THREW:' + (e && e.message ? String(e.message).slice(0, 60) : 'err'));
}
process.stdout.write(out.join(''));
