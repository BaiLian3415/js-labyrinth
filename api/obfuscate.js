/**
 * Vercel 函数：POST /api/obfuscate —— 云端执行混淆。
 *
 * 这是"所有逻辑存于云端"的落点：代码上传到这里，由服务端跑完整的混淆流水线，
 * 结果回给浏览器（大回执走流式）。上传上限、预设上限与每日 CPU 预算在
 * vercel/entry.js 里按免费档包络强制，套餐闸门与每日次数在 server/handler.js
 * 里与界面同一套判定。
 */
export { POST, OPTIONS } from '../vercel/entry.js';
