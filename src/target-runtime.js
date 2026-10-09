/**
 * 目标运行时（target runtime）：产物最终跑在什么宿主里，以及那个宿主**禁掉了什么**。
 *
 * 为什么要有这一份：`src/host-limits.js` 讲的是**部署方**（Vercel 函数）的包络，
 * 与产物跑在哪是两件事——一份自混淆产物可能被用户部署到 Cloudflare Workers、
 * Deno Deploy、Node、浏览器或 ServiceWorker。这些宿主的限制差异极大，而且
 * **限制是"抛错"级别的，不是"效果差一点"**：Cloudflare Workers 明确禁用
 * `eval()` 与 `new Function`，只允许**部署期静态**的 ESM import，于是任何
 * 「运行期解密出代码再执行」的形态在那里必挂。
 *
 * 不固化就会静默出事：此前 Worker 脚本走 ESM 壳（`createObjectURL` + 动态
 * `import()`），在 workerd 里两条都不通——实测产物 434 KB 且**部署即抛**。
 * 保护层"看着有"却让产物直接不可用，比没有保护更糟。
 *
 * 事实来源（Cloudflare 官方文档 "Web standards"，2026-04-23 版）：
 *   - 不允许：eval()、new Function、WebAssembly.compile / compileStreaming /
 *     WebAssembly.instantiate(buffer) / instantiateStreaming
 *   - Date.now() 与 performance.now() 返回**最后一次 I/O 的时间**，不随代码执行推进
 *   - URL 只支持 http/https 方案
 *   - Timers 只能在 Request Context 内用
 *   - 开了 global_navigator 兼容标志时 navigator.userAgent === 'Cloudflare-Workers'
 */

/** 认识的目标。'auto' = 按源码特征猜（见 looksLikeCloudflareWorker）。 */
export const TARGETS = ['auto', 'browser', 'node', 'cloudflare-worker'];

/** Cloudflare Workers：workerd 上的硬限制。 */
const CF_WORKER = {
  id: 'cloudflare-worker',
  display: 'Cloudflare Workers',
  // 运行期禁止字符串代码生成——壳的 eval/Function 两条路全断。
  eval: false,
  newFunction: false,
  // 只允许部署期静态导入 .wasm：instantiate(buffer) 被禁，模块必须是静态 import。
  wasmFromBuffer: false,
  wasmStaticImportOnly: true,
  // 时钟冻结：Date.now() / performance.now() 在一次请求内不推进。
  clockFrozen: true,
  // 只有 http/https 方案，所以 data: / blob: 的模块加载不存在。
  importableUrlSchemes: ['http:', 'https:'],
  // 无 DOM。
  dom: false,
  // timers 只在 Request Context 内可用（构建期不存在，不影响产物正确性）。
  timersInRequestContext: true,
};

/**
 * 各目标的限制表。键是 TARGETS 里除 'auto' 之外的值。
 *
 * 未列出的目标按最宽松处理（等价于 browser/node 通用档）：**不要**把未知目标
 * 当成受限目标——那会因为猜错而砍掉用户要的保护。判断不了就放行，出了问题
 * 给出 warning，比默默削弱保护好。
 */
const PROFILES = {
  'cloudflare-worker': CF_WORKER,
};

const DEFAULT_PROFILE = {
  id: 'generic',
  display: '通用 JS 宿主',
  eval: true,
  newFunction: true,
  wasmFromBuffer: true,
  wasmStaticImportOnly: false,
  clockFrozen: false,
  importableUrlSchemes: null, // 不限
  dom: true,
  timersInRequestContext: false,
};

/**
 * 猜目标是不是 Cloudflare Worker。
 *
 * 只看**结构性**特征，不看字符串字面量——否则用户代码里随便写个
 * `'cloudflare'` 就被误判成 Worker，保护被无谓地砍掉。判据按可信度排序：
 *
 *   1. `export default { … }` 里带 fetch/scheduled 等 handler —— module worker 的标志形态；
 *   2. 顶层 `addEventListener('fetch'|'scheduled', …)` —— service-worker 风格；
 *   3. 源码里出现 workerd 特有的绑定用法（`env.MY_KV`/`ctx.waitUntil`）且同时是模块。
 *
 * 宁可不判：`looksLikeCloudflareWorker` 返回 false 时一律按通用宿主处理。
 * 用户可以用 `target: 'cloudflare-worker'` 显式声明。
 *
 * @param {string} code 源码
 * @returns {boolean}
 */
export function looksLikeCloudflareWorker(code) {
  const s = typeof code === 'string' ? code : '';
  if (!s) return false;
  // 模块形态：import/export 出现，且不是字符串里的（粗判：出现在行首附近的概率高，
  // 这里只需要把明显非 Worker 的脚本排除掉，允许误判由 target 显式覆盖兜底）。
  const moduleish = /(^|\n)\s*(export\s+(default\s+)?|import\s)/.test(s);
  if (!moduleish) return false;
  if (/export\s+default\s*\{[\s\S]{0,400}?\b(fetch|scheduled|queue|email)\s*\(/.test(s)) return true;
  if (/addEventListener\s*\(\s*["'](fetch|scheduled)["']/.test(s)) return true;
  // env.X / ctx.waitUntil 同时出现：绑定用法 + 模块形态
  if (/\bctx\.waitUntil\s*\(/.test(s) && /\benv\.[A-Za-z_$]/.test(s)) return true;
  return false;
}

/**
 * 定目标。显式给的值优先；'auto'/未给则按源码特征猜。
 *
 * @param {string|undefined} target 选项里的 target
 * @param {string} code 源码（仅 auto 时用）
 * @returns {string} 目标 id
 */
export function resolveTarget(target, code) {
  const t = typeof target === 'string' ? target.trim().toLowerCase() : '';
  if (t && t !== 'auto' && PROFILES[t]) return t;
  if (t && t !== 'auto' && TARGETS.includes(t)) return t; // 已知但无特殊限制
  return looksLikeCloudflareWorker(code) ? 'cloudflare-worker' : 'generic';
}

/**
 * 取某目标的限制表。
 * @param {string} target 目标 id
 * @returns {object} 同形制于 DEFAULT_PROFILE
 */
export function profileOf(target) {
  return PROFILES[target] || DEFAULT_PROFILE;
}

/**
 * 这个目标下，产物里**绝不能出现**的形态。返回带说明的清单，供构建期强制与告警。
 *
 * 每条都要能说清"为什么"——否则将来有人会当成多余的规则删掉。
 *
 * @param {string} target 目标 id
 * @returns {Array<{key:string, why:string}>}
 */
export function forbiddenShapes(target) {
  const p = profileOf(target);
  const out = [];
  if (!p.eval || !p.newFunction) {
    out.push({
      key: 'runtimeEval',
      why: '该宿主禁用 eval() 与 new Function，运行期解密出代码再执行的形态必挂',
    });
  }
  if (!p.wasmFromBuffer) {
    out.push({
      key: 'wasmFromBuffer',
      why: '该宿主禁用 WebAssembly.instantiate(buffer)/compile，wasm 必须是部署期静态导入',
    });
  }
  return out;
}

/**
 * 时钟是否冻结。冻结时基于 `Date.now()` 差值的哨兵**静默失效**（差值恒 0，
 * 阈值永不成立）：不是崩溃，是保护悄悄消失，所以要在构建期点名。
 * @param {string} target 目标 id
 * @returns {boolean}
 */
export function isClockFrozen(target) {
  return !!profileOf(target).clockFrozen;
}

export default {
  TARGETS,
  resolveTarget,
  looksLikeCloudflareWorker,
  profileOf,
  forbiddenShapes,
  isClockFrozen,
};