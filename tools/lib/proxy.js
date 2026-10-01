#!/usr/bin/env node
/**
 * 出网走系统代理。
 *
 * 背景：Windows 上装了代理客户端（注册表 Internet Settings\ProxyEnable=1）时，
 * 浏览器和 PowerShell 都自动走代理，但 Node 的 fetch **不读**系统代理——它只看
 * HTTPS_PROXY/HTTP_PROXY 环境变量。结果就是同一个网址，PowerShell 拿得到 200、
 * `node verify-deploy.js` 却 UND_ERR_CONNECT_TIMEOUT，而且直连 DNS 有时还会把
 * 域名解析到不相干的地址（实测 vercel.app 被解析到 Twitter 的网段）。
 *
 * 做法：不自己实现 CONNECT 隧道（那是 undici 的活），而是复用 Node 自带的代理
 * 支持——`--use-env-proxy` 会让内置 fetch 读 HTTPS_PROXY/HTTP_PROXY。代价是这
 * 个开关必须在进程启动前生效，所以检测到代理且当前进程没带它时，用同样的参数
 * 把自身重启一次（stdio 继承，退出码透传，调用方察觉不到）。
 *
 * 代理来源按优先级：
 *   1. HTTPS_PROXY / https_proxy / HTTP_PROXY / http_proxy（CI、容器、手工指定）
 *   2. Windows 系统代理（注册表 ProxyEnable + ProxyServer）
 *   3. 不用代理
 * NO_PROXY 由 Node 自己处理，透传环境变量即可。
 *
 * 逃生舱：设 JSLB_NO_PROXY=1 强制直连（代理不可用、或只想验证直连时用）。
 */
import { execFileSync, spawnSync } from 'node:child_process';

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

// 重启过一次后由这个标记兜底，避免无限重启
const BOOTSTRAP = 'JSLB_PROXY_BOOTSTRAP';
// 重启后把探测结果带过去，供 playwright 等拿不到全局 fetch 的调用方使用
export const PROXY_ENV = 'JSLB_PROXY_URL';

/**
 * 补全 scheme。带 scheme 的只认 http/https（Node 内置代理不支持 socks 目标）；
 * 裸写法只认 `host:port`（含 `[::1]:port`）——"not a proxy" 这类必须判为无效，
 * 否则会拼出一个必然连接失败的地址，比不设代理更难排查。
 */
function normalize(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (!/^(?:\[[^\]]+\]|[^\s:/?#]+):\d+$/.test(s)) return '';
    return 'http://' + s;
  }
  if (!/^https?:\/\//i.test(s)) return '';
  return s;
}

/** 读一个注册表字符串值，Windows 之外或不存在返回空串。 */
function regValue(name) {
  if (process.platform !== 'win32') return '';
  try {
    const out = execFileSync('reg', ['query', REG_KEY, '/v', name],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    const m = new RegExp(name + '\\s+REG_\\w+\\s+(.*)$', 'm').exec(out);
    return m ? m[1].trim() : '';
  } catch (e) {
    return '';
  }
}

/**
 * 从 ProxyServer 里挑出 http 代理。
 * 它的三种写法都要认：裸 `host:port`、`http=a;https=b`、`socks=host:port`。
 * https 优先，其次 http；只有 socks 时返回空（Node 内置代理不支持 socks 目标）。
 */
function pickFromProxyServer(raw) {
  if (!raw) return '';
  if (!raw.includes('=')) return normalize(raw);
  const map = new Map();
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) map.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
  }
  return normalize(map.get('https')) || normalize(map.get('http'));
}

/**
 * 探测当前应该走的代理。
 * @returns {{url:string, source:string}|null} 探测不到时返回 null
 */
export function detectProxy() {
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const u = normalize(process.env[k]);
    if (u) return { url: u, source: 'env ' + k };
  }
  if (process.env.JSLB_NO_PROXY) return null;
  const enable = regValue('ProxyEnable');
  if (!/0x1$/i.test(enable)) return null;
  const u = pickFromProxyServer(regValue('ProxyServer'));
  if (u) return { url: u, source: '系统代理' };
  // 开了代理但只给了 PAC 脚本：这里没法求值，如实说明而不是默默直连
  if (regValue('AutoConfigURL')) {
    console.warn('[proxy] 系统代理用的是 PAC（AutoConfigURL），本工具不解析它，将直连。'
      + ' 需要走代理请手工设 HTTPS_PROXY。');
  }
  return null;
}

/** 进程是否已经带上了 Node 的代理开关。 */
function proxySupportOn() {
  return process.execArgv.includes('--use-env-proxy')
    || /^(1|true)$/i.test(process.env.NODE_USE_ENV_PROXY || '');
}

/**
 * 确保本进程能走代理。必要时以 `--use-env-proxy` 重启自身并透传退出码——
 * 调用方在探测到需要重启时不会返回，直接随子进程一起结束。
 *
 * @param {string} [label] 打印的那行提示里的脚本名
 * @returns {string|null} 生效的代理地址（已重启过或本来就开着时返回子进程传来的值）
 */
export function ensureProxy(label) {
  if (process.env.JSLB_NO_PROXY) return null;
  // 上一次已经重启过：直接用带过来的结果，别再转一次
  if (process.env[BOOTSTRAP]) return process.env[PROXY_ENV] || detectProxy()?.url || null;
  const found = detectProxy();
  if (!found) return null;
  if (proxySupportOn()) return found.url;
  const name = label || process.argv[1] || '当前脚本';
  console.log(`[proxy] 检测到${found.source} ${found.url}，以 --use-env-proxy 重启 ${name}`);
  const env = {
    ...process.env,
    HTTPS_PROXY: found.url,
    HTTP_PROXY: found.url,
    NODE_USE_ENV_PROXY: '1',
    [BOOTSTRAP]: '1',
    [PROXY_ENV]: found.url,
  };
  const r = spawnSync(process.execPath, ['--use-env-proxy', ...process.argv.slice(1)],
    { stdio: 'inherit', env });
  process.exit(r.status === null || r.status === undefined ? 1 : r.status);
}

/**
 * 给 playwright 这类拿不到全局 fetch 的调用方用的代理参数。
 * @returns {{server:string}|undefined} 没过代理时返回 undefined（playwright 认这个缺省值）
 */
export function playwrightProxy() {
  const url = process.env[PROXY_ENV] || detectProxy()?.url || null;
  return url ? { server: url } : undefined;
}