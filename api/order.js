/**
 * Vercel 函数：/api/order —— 建单、提交付款凭证、查状态/自助取卡。
 * 处理逻辑见 server/handler.js；状态机与核验规则在 src/orders.js（可单测）。
 */
export { GET, POST, OPTIONS } from '../vercel/entry.js';
