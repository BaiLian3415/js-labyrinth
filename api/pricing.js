/**
 * Vercel 函数：GET /api/pricing —— 价目表 + 收款信息（定价页一次拿全）。
 * 处理逻辑见 server/handler.js（与界面同一份数据源 src/pricing.js）。
 */
export { GET, OPTIONS } from '../vercel/entry.js';
