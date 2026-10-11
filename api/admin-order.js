/**
 * Vercel 函数：POST /api/admin-order —— 管理端人工核验（列表/详情/确认发卡/拒绝）。
 * 需要配置 JSLB_ADMIN_TOKEN，未配置时该端点恒为 403。
 * 没有管理端账号时，用 tools/issue/orders.js 走同一套逻辑（同一个 KV）。
 */
export { POST, OPTIONS } from '../vercel/entry.js';
