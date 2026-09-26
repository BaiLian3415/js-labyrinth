/**
 * 宿主包络：本部署跑在什么套餐上、它给的单次与每日预算有多少。
 *
 * 为什么要有这一份：`src/plans.js` 里的配额（单文件大小、每天次数）不是拍脑袋定的，
 * 而是**由部署宿主的免费档硬约束反推出来的**。Vercel Hobby（免费档）的三条硬线：
 *
 *   1. 函数请求体上限 **4.5 MB**（超了平台直接 413 `FUNCTION_PAYLOAD_TOO_LARGE`，
 *      请求根本进不到我们的代码里，所以必须在客户端就挡住）；
 *   2. 函数单次最长 **300 s**（Hobby 上限，与默认值相同）；
 *   3. 每月 **100 万次**函数调用，外加有限的 Active CPU 额度（免费档超出即暂停，
 *      不会转成账单）。
 *
 * 响应体同样有 4.5 MB 上限，但**流式回执不受该限制**（Vercel 官方绕过方案），
 * 所以回执走流式（见 vercel/entry.js），单次回执只在 `maxResponseBytes` 处设一道
 * 自家护栏，防止某个 87× 膨胀的 max 预设把带宽跑飞。
 *
 * 免费档真正的瓶颈是 CPU：混淆的耗时可实测（`tools/build/cloud-budget.js`），
 * 与预设强相关。所以这里给每个预设记一组**实测成本**，用来：
 *   - 反推每个预设的单文件上限（`presetInputCap`），
 *   - 在服务端做预算记账（`estimateCost`），全网每日 CPU 预算用尽就拒绝新任务。
 *
 * 全部数字都能用环境变量放宽（升级到 Pro 后应放宽）：
 *   JSLB_MAX_UPLOAD_BYTES     单次上传上限（字节，默认 2 MiB；平台硬线 4.5 MB）
 *   JSLB_PER_RUN_CPU_SECONDS  单次运行 CPU 预算（默认 240 s）
 *   JSLB_DAILY_CPU_SECONDS    全网每日 CPU 预算（默认 300 s）
 *   JSLB_MAX_RESPONSE_BYTES   单次回执上限（默认 64 MiB）
 */
import PRESETS from './presets.js';

/** 静态包络（两端一致：浏览器拿它做预检与文案，服务端拿它做强制）。 */
export const HOST = {
  id: 'vercel-hobby',
  display: 'Vercel Hobby',
  /** 平台硬线：函数请求体上限。 */
  requestBodyBytes: 4718592,
  /** 平台硬线：非流式回执上限（本部署走流式，只作说明用）。 */
  responseBodyBytes: 4718592,
  /** 平台硬线：单次函数最长运行时间（秒）。 */
  functionMaxSeconds: 300,
  /** 平台配额：每月函数调用次数。 */
  invocationsPerMonth: 1000000,
  /** 本部署对外承诺的单次上传上限：给 JSON 转义留 2× 余量，远低于 4.5 MB 硬线。 */
  maxUploadBytes: 2097152,
  /** 单次运行允许消耗的 CPU 秒数（240 s，给平台开销留 60 s 余量）。 */
  perRunCpuSeconds: 240,
  /** 全网每日 CPU 预算（免费档 Active CPU 额度折算，保守值）。 */
  dailyCpuSeconds: 300,
  /** 单次回执上限：流式回执照写，但别把带宽一下子跑光。 */
  maxResponseBytes: 67108864,
};

/**
 * 各预设的**实测成本**。数字来自本机 Node 24 的实测（`tools/build/cloud-budget.js`
 * 可复现，同一份合成输入、同一 seed）：
 *
 *   预设     膨胀比      CPU
 *   low      3.7~3.9×    2.0~2.5 ms/KB
 *   medium   28×         20 ms/KB
 *   high     38×         18~63 ms/KB（抖动大，取上限）
 *   max      85~87×      141~166 ms/KB
 *
 * 取值一律向上取整（宁可保守）：估算只用来做预算与预检，真实耗时由运行时决定。
 */
export const PRESET_COST = {
  low: { msPerKb: 4, inflation: 4 },
  medium: { msPerKb: 25, inflation: 30 },
  high: { msPerKb: 70, inflation: 45 },
  max: { msPerKb: 170, inflation: 90 },
};

const PRESET_NAMES = Object.keys(PRESETS);

/** 取某个预设的成本档；认不出的预设按最贵的一档算（失败要偏保守）。 */
export function costOf(preset) {
  return PRESET_COST[String(preset || '').toLowerCase()] || PRESET_COST.max;
}

function intEnv(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * 服务端生效的包络：静态值与环境覆盖的合并结果。
 * 浏览器侧不该调用它（客户端环境变量不可信），界面只用 `HOST` 做预检与文案。
 * @param {(name:string)=>(string|undefined)} readEnv 取值函数（服务端传 platform.env）
 * @returns {object} 与 `HOST` 同形制
 */
export function effectiveHost(readEnv) {
  const env = typeof readEnv === 'function' ? readEnv : () => undefined;
  return {
    ...HOST,
    maxUploadBytes: Math.min(HOST.requestBodyBytes, intEnv(env('JSLB_MAX_UPLOAD_BYTES'), HOST.maxUploadBytes)),
    perRunCpuSeconds: intEnv(env('JSLB_PER_RUN_CPU_SECONDS'), HOST.perRunCpuSeconds),
    dailyCpuSeconds: intEnv(env('JSLB_DAILY_CPU_SECONDS'), HOST.dailyCpuSeconds),
    maxResponseBytes: intEnv(env('JSLB_MAX_RESPONSE_BYTES'), HOST.maxResponseBytes),
  };
}

/**
 * 某个预设下一次能上传多少字节——两条线取小：
 *   CPU 线：`perRunCpuSeconds` ÷ 该预设的 ms/KB；
 *   上传线：`maxUploadBytes`（默认 2 MiB，平台硬线 4.5 MB 与 JSON 转义余量共同决定）。
 * @param {string} preset 预设名
 * @param {object} [host] 生效包络，缺省用静态值
 * @returns {number} 字节数
 */
export function presetInputCap(preset, host) {
  const h = host || HOST;
  const cost = costOf(preset);
  const byCpu = Math.floor((h.perRunCpuSeconds * 1000) / cost.msPerKb) * 1024;
  return Math.min(h.maxUploadBytes, byCpu);
}

/**
 * 估算一次任务的 CPU 毫秒数与回执字节数。用于服务端预算记账与客户端预检提示。
 * @param {string} preset 预设名
 * @param {number} bytes 输入字节数
 * @returns {{ms:number, outBytes:number}} 估算结果
 */
export function estimateCost(preset, bytes) {
  const cost = costOf(preset);
  const kb = Math.max(0, Number(bytes) || 0) / 1024;
  return { ms: Math.round(kb * cost.msPerKb), outBytes: Math.round((Number(bytes) || 0) * cost.inflation) };
}

/** 人类可读的字节数（与 plan.humanBytes 同口径，避免两处格式不一致）。 */
export function formatBytes(n) {
  if (!n) return null;
  if (n >= 1048576) return (n / 1048576) + ' MB';
  if (n >= 1024) return (n / 1024) + ' KB';
  return n + ' B';
}

/** 包络的可读描述，给 /api/health 与文档用。 */
export function describe(host) {
  const h = host || HOST;
  return {
    id: h.id,
    display: h.display,
    requestBodyBytes: h.requestBodyBytes,
    responseBodyBytes: h.responseBodyBytes,
    functionMaxSeconds: h.functionMaxSeconds,
    invocationsPerMonth: h.invocationsPerMonth,
    maxUploadBytes: h.maxUploadBytes,
    perRunCpuSeconds: h.perRunCpuSeconds,
    dailyCpuSeconds: h.dailyCpuSeconds,
    maxResponseBytes: h.maxResponseBytes,
    presetCaps: PRESET_NAMES.reduce((acc, p) => { acc[p] = presetInputCap(p, h); return acc; }, {}),
  };
}

export { PRESET_NAMES };

export default {
  HOST,
  PRESET_COST,
  PRESET_NAMES,
  costOf,
  effectiveHost,
  presetInputCap,
  estimateCost,
  formatBytes,
  describe,
};
