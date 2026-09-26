/**
 * Vercel 侧的云存储适配层。
 *
 * 为什么需要它：Vercel 的函数是无状态的，同一个许可证记录下一秒可能落到另一个实例上。
 * 没有一处**云端存储**，授权记录与用量计数就只能在单实例内存里活着——表现是"刚激活又
 * 提示未激活""每天次数怎么刷新都在涨"。Vercel 没有原生 KV，所以这里用
 * **Upstash Redis 的 REST 接口**（Vercel Marketplace 里一键安装，
 * 免费档 256 MB / 每日 1 万次命令，对授权与计数绰绰有余）。
 *
 * 形状对齐 `server/handler.js` 里对 `env.JSLB_KV` 的用法：
 *   get(key) → 字符串或 null
 *   put(key, value) → 成功 true / 失败 false
 *   delete(key) → 无所谓
 * 键名由调用方加前缀（worker 那边是 `jslb:`），本层不再改动键名。
 *
 * 另外给宿主预算记账提供一个 `addNumber()`（Upstash 的 INCRBY，原子），它不属于 KV
 * 的三件套，只在 Vercel 侧使用。
 *
 * 环境变量（Vercel 的 Upstash 集成会自动注入前一组）：
 *   KV_REST_API_URL / KV_REST_API_TOKEN
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
 * 都没配时退化为**单实例内存**（进程内 Map）：能跑，但不跨实例持久化，界面与
 * /api/health 会明确提示（hostNoStore）。
 */

const TIMEOUT_MS = 2500;

/** 单实例内存兜底。声明在模块级，同一实例的多次请求能共用。 */
const memory = new Map();

function memoryStore() {
  return {
    kind: 'memory',
    kv: {
      get(key) { return memory.has(key) ? memory.get(key) : null; },
      put(key, value) { memory.set(key, String(value)); return true; },
      delete(key) { memory.delete(key); },
    },
    addNumber(key, delta) {
      const next = (Number(memory.get(key)) || 0) + Number(delta || 0);
      memory.set(key, String(next));
      return next;
    },
  };
}

/** 从环境里取 Upstash 配置；两者必须成对出现。 */
function upstashConfig(env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || '';
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || '';
  if (!url || !token) return null;
  return { url: String(url).replace(/\/+$/, ''), token: String(token) };
}

/** 发一条 Upstash REST 命令，返回第一条结果；失败返回 undefined（不抛）。 */
async function redisCommand(cfg, command) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + cfg.token,
        'content-type': 'application/json',
      },
      body: JSON.stringify([command]),
      signal: ctl ? ctl.signal : undefined,
    });
    if (!res.ok) return undefined;
    const data = await res.json().catch(() => null);
    // 管道式响应：[{result: ...}]；单命令风格：{result: ...}
    if (Array.isArray(data)) return data.length ? data[0].result : undefined;
    return data && data.result !== undefined ? data.result : undefined;
  } catch (e) {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 建一个云存储。失败的写会返回 false（授权模块据此提示"用量写不进去"）。
 * @param {object} [env] 环境（默认 process.env）
 * @returns {{kind:'upstash'|'memory', kv:object, addNumber:function, note:string}}
 */
export function createStore(env) {
  const source = env || (typeof process !== 'undefined' ? process.env : {}) || {};
  const cfg = upstashConfig(source);
  if (!cfg) {
    return { ...memoryStore(), note: 'no-store' };
  }
  return {
    kind: 'upstash',
    note: '',
    kv: {
      async get(key) {
        const v = await redisCommand(cfg, ['GET', String(key)]);
        return v === undefined || v === null ? null : String(v);
      },
      async put(key, value) {
        const v = await redisCommand(cfg, ['SET', String(key), String(value)]);
        return v === 'OK';
      },
      async delete(key) {
        await redisCommand(cfg, ['DEL', String(key)]);
      },
    },
    async addNumber(key, delta) {
      const v = await redisCommand(cfg, ['INCRBY', String(key), String(Math.round(Number(delta) || 0))]);
      return Number.isFinite(Number(v)) ? Number(v) : null;
    },
  };
}

export default { createStore };
