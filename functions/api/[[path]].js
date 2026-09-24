/**
 * Cloudflare Pages Functions 入口。
 *
 * 与 Worker 版共用同一份处理逻辑（worker/index.js），Pages 项目因此同时拥有
 * 静态界面与 /api/* 接口：部署 `dist/` 作为静态资源，本目录随项目一起上传。
 * 环境变量（JSLB_CODE_KEY、JSLB_WEB_CONFIG、JSLB_KV 绑定等）在 Pages 项目的
 * 设置里配置，读取方式与 Worker 完全一致。
 *
 * 路由规则：本文件匹配 /api/<任意路径>。
 *
 * 注意本目录必须留在项目根：Pages 只从根的 functions/ 读取函数，挪进 src/ 就失效了。
 */
import worker from '../../worker/index.js';

/**
 * Pages Functions 入口。
 * @param {object} context {request, env, params, waitUntil, next, data}
 * @returns {Promise<Response>} 响应
 */
export const onRequest = (context) => worker.fetch(context.request, context.env, context);

export default { onRequest };
