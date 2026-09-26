/**
 * Vercel 函数：GET/POST /api/license —— 查询或激活授权。
 * 处理逻辑见 vercel/entry.js（授权判定在 server/handler.js，与界面同一份规则）。
 */
export { GET, POST, OPTIONS } from '../vercel/entry.js';
