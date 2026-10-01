/**
 * Vercel 侧的云存储适配层。
 *
 * 为什么需要它：Vercel 的函数是无状态的，同一个许可证记录下一秒可能落到另一个实例上。
 * 没有一处云端存储，授权记录与用量计数就只能在单实例内存里活着——表现是"刚激活又
 * 提示未激活""每天次数怎么刷新都在涨"。Vercel 没有原生 KV，所以这里认两种 Redis 接入：
 * Upstash 的 REST 接口（Marketplace 里一键安装）以及 Vercel 官方 Redis 注入的
 * 标准连接串 REDIS_URL（Redis Cloud，只有 RESP 协议，客户端在 vercel/redis-tcp.js，
 * 同样是零依赖）。两条路都不通才退化为单实例内存。
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
 * 环境变量（认这三组里的任意一组，按 REST 优先的顺序取）：
 *   KV_REST_API_URL / KV_REST_API_TOKEN          Upstash 的 Vercel 集成注入的一对
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  Upstash 控制台给的一对
 *   REDIS_URL                                    Vercel 官方 Redis（Redis Cloud）注入的
 *                                                标准连接串，走 vercel/redis-tcp.js 的 RESP
 * 一组都没配时退化为单实例内存（进程内 Map）：能跑，但不跨实例持久化，界面与
 * /api/health 会明确提示（hostNoStore）。
 */

import { createTcpStore } from './redis-tcp.js';

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
 *
 * 三条路按序取：Upstash REST（成对的 URL/TOKEN）→ 标准 Redis 连接串 → 单实例内存。
 * REDIS_URL 放最后是有意的：REST 版在函数里只有一次 fetch，冻结/冷启动下最省事；
 * 两者都配不会打架，REST 优先。
 *
 * @param {object} [env] 环境（默认 process.env）
 * @returns {{kind:'upstash'|'redis'|'memory', kv:object, addNumber:function, note:string}}
 */
export function createStore(env) {
  const source = env || (typeof process !== 'undefined' ? process.env : {}) || {};
  const cfg = upstashConfig(source);
  if (cfg) return upstashStore(cfg);
  const url = String(source.REDIS_URL || '').trim();
  if (url) {
    try {
      return createTcpStore(url);
    } catch (e) {
      // 连接串本身不合法（new URL 失败）。这属于部署配错，但要能继续跑：退内存，
      // note 说清楚是"连接串坏了"而不是"没配"，免得排查时找错方向。
      return { ...memoryStore(), note: 'bad-redis-url' };
    }
  }
  return { ...memoryStore(), note: 'no-store' };
}

/** Upstash REST 版：一条命令一次 fetch。 */
function upstashStore(cfg) {
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
