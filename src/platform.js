/**
 * 平台适配层。核心模块经此访问宿主能力，零 Node 内建依赖，可跑在
 * Node / 浏览器 / Cloudflare Workers 三端。
 */

const g = globalThis;

export const isNode = typeof process !== 'undefined' && !!process.versions && !!process.versions.node;
export const isWorkerd = typeof navigator !== 'undefined'
  && typeof navigator.userAgent === 'string'
  && /Cloudflare-Workers/i.test(navigator.userAgent);
export const isBrowser = !isNode && !isWorkerd && typeof window !== 'undefined' && typeof window.document !== 'undefined';
export const runtime = isNode ? 'node' : (isWorkerd ? 'worker' : (isBrowser ? 'browser' : 'unknown'));

let injectedEnv = null;

export function setEnv(obj) {
  injectedEnv = obj || null;
}

const nodeEnv = isNode && process.env ? process.env : null;

export function env(name, fallback) {
  let v;
  if (injectedEnv && injectedEnv[name] !== undefined) v = injectedEnv[name];
  else if (nodeEnv && nodeEnv[name] !== undefined) v = nodeEnv[name];
  else if (!isNode && g.JSLB_ENV && g.JSLB_ENV[name] !== undefined) v = g.JSLB_ENV[name];
  if (v === undefined || v === null || v === '') return fallback;
  return typeof v === 'string' ? v : String(v);
}

const webcrypto = g.crypto && typeof g.crypto.getRandomValues === 'function' ? g.crypto : null;

let entropy = null;

export function setEntropy(fn) {
  entropy = typeof fn === 'function' ? fn : null;
}

export function randomBytes(n) {
  if (entropy) {
    try {
      const out = entropy(n);
      if (out && out.length === n) return out;
    } catch (e) {
      // 宿主熵源不可用，走下面的兜底
    }
  }
  const out = new Uint8Array(n);
  if (webcrypto) {
    // getRandomValues 单次上限 65536 字节，超出时分段取
    for (let off = 0; off < n; off += 65536) {
      webcrypto.getRandomValues(out.subarray(off, Math.min(n, off + 65536)));
    }
    return out;
  }
  // 无 WebCrypto 的受限环境：退回 Math.random，熵不足但不阻断流程
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

export function randomUint32() {
  const b = randomBytes(4);
  return ((b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0);
}

export const now = () => Date.now();

/** 单调高精度时钟（performance.now() 优先）。只用于测耗时，不做业务判定。 */
export function nowMs() {
  if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export function byteLength(str) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(str).length;
  // 无 TextEncoder 时按码元手算
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length
      && str.charCodeAt(i + 1) >= 0xdc00 && str.charCodeAt(i + 1) < 0xe000) { i++; n += 4; } else n += 3;
  }
  return n;
}

const memory = new Map();

function memoryStorage() {
  return {
    persistent: false,
    get(key) { return memory.has(key) ? memory.get(key) : null; },
    set(key, value) { memory.set(key, String(value)); },
    remove(key) { memory.delete(key); },
  };
}

/** 新建独立内存存储。Worker 每请求换一份，避免 isolate 内串数据。 */
export function newMemoryStorage() {
  const own = new Map();
  return {
    persistent: false,
    get(key) { return own.has(key) ? own.get(key) : null; },
    set(key, value) { own.set(key, String(value)); },
    remove(key) { own.delete(key); },
  };
}

function localStorageImpl() {
  try {
    const probe = '__jslb_probe__';
    g.localStorage.setItem(probe, '1');
    g.localStorage.removeItem(probe);
  } catch (e) {
    return memoryStorage();
  }
  return {
    persistent: true,
    get(key) {
      try { return g.localStorage.getItem(key); } catch (e) { return null; }
    },
    set(key, value) {
      try { g.localStorage.setItem(key, String(value)); return true; } catch (e) { return false; }
    },
    remove(key) {
      try { g.localStorage.removeItem(key); } catch (e) { return; }
    },
  };
}

const AUTO_STORAGE = isBrowser ? localStorageImpl() : memoryStorage();

let activeStorage = AUTO_STORAGE;

export function getStorage() {
  return activeStorage;
}

export function setStorage(impl) {
  activeStorage = impl || AUTO_STORAGE;
}

let activeKv = null;

export function getKv() {
  return activeKv;
}

export function setKv(kv) {
  activeKv = kv || null;
}

export const DEFAULT_WEB_CONFIG = {
  requireLicense: false,
  trialPreset: 'low',
  trialMaxFileBytes: 524288,
  trialRunsPerDay: 10,
};

let webConfig = { ...DEFAULT_WEB_CONFIG };

export function getWebConfig() {
  return { ...webConfig };
}

export function setWebConfig(cfg) {
  webConfig = { ...DEFAULT_WEB_CONFIG, ...(cfg || {}) };
}

export function loadWebConfigFromEnv() {
  const raw = env('JSLB_WEB_CONFIG');
  if (!raw) return;
  try {
    const cfg = JSON.parse(raw);
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) setWebConfig(cfg);
  } catch (e) {
    // 配置写坏时保持默认策略，不阻断服务
  }
}

let passDumper = null;

export function setPassDumper(fn) {
  passDumper = typeof fn === 'function' ? fn : null;
}

export function dumpPass(name, code) {
  if (!env('DSH_DUMP_PASSES') || !passDumper) return;
  try {
    passDumper(name, code);
  } catch (e) {
    // 转储是诊断功能，失败不影响构建
  }
}

// 设备特征采集。机器码由设备特征派生（见 license-web.deviceFingerprint），
// 这里只做"取得到就取、取不到就报缺"的原始访问，判定逻辑留在授权模块里，
// 以便测试注入替身。

/** @returns {object|null} navigator 的只读快照，无 navigator 时返回 null。 */
export function navigatorInfo() {
  const nav = typeof g.navigator !== 'undefined' ? g.navigator : null;
  if (!nav) return null;
  return {
    platform: nav.platform === undefined ? '' : String(nav.platform),
    language: nav.language === undefined ? '' : String(nav.language),
    hardwareConcurrency: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : NaN,
  };
}

/** @returns {object|null} screen 的只读快照，无 screen 时返回 null。 */
export function screenInfo() {
  const scr = typeof g.screen !== 'undefined' ? g.screen : null;
  if (!scr) return null;
  return {
    width: typeof scr.width === 'number' ? scr.width : NaN,
    height: typeof scr.height === 'number' ? scr.height : NaN,
    colorDepth: typeof scr.colorDepth === 'number' ? scr.colorDepth : NaN,
  };
}

/** @returns {number} devicePixelRatio，取不到时返回 0（占位，不改变特征串长度）。 */
export function pixelRatioValue() {
  const r = g.devicePixelRatio;
  return typeof r === 'number' && Number.isFinite(r) ? r : 0;
}

/**
 * GPU 渲染器字符串，取不到时返回空串。
 *
 * 结果按 (renderer, vendor) 缓存：每次查询都要建一个 WebGL 上下文，浏览器对
 * 同时存活的上下文数量有上限，反复创建会触发上下文丢失警告甚至让已有的
 * 上下文失效。特征是稳定量，缓存一次即可。
 */
let gpuCache = null;

export function gpuRendererValue() {
  if (gpuCache !== null) return gpuCache;
  gpuCache = '';
  try {
    const canvas = typeof g.document !== 'undefined' && g.document.createElement
      ? g.document.createElement('canvas')
      : null;
    if (canvas) {
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = dbg
          ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER);
        const vendor = dbg
          ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)
          : gl.getParameter(gl.VENDOR);
        gpuCache = String(renderer || '') + '~' + String(vendor || '');
        // 主动丢弃上下文，别占着额度
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose && typeof lose.loseContext === 'function') lose.loseContext();
      }
    }
  } catch (e) {
    // 无 WebGL、被隐私设置屏蔽、或上下文数超限：按取不到处理，特征串该位留空
  }
  return gpuCache;
}

/** 清空 GPU 特征缓存，仅供测试。 */
export function resetGpuCache() {
  gpuCache = null;
}

export default {
  isNode,
  isBrowser,
  isWorkerd,
  runtime,
  env,
  setEnv,
  randomBytes,
  randomUint32,
  setEntropy,
  now,
  nowMs,
  byteLength,
  getStorage,
  setStorage,
  newMemoryStorage,
  getKv,
  setKv,
  getWebConfig,
  setWebConfig,
  loadWebConfigFromEnv,
  setPassDumper,
  dumpPass,
  navigatorInfo,
  screenInfo,
  pixelRatioValue,
  gpuRendererValue,
  resetGpuCache,
  DEFAULT_WEB_CONFIG,
};
