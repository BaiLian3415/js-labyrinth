/**
 * Vercel 函数：POST /api/pay-notify —— 收款回调（HMAC 签名校验后幂等签发卡密）。
 * 处理逻辑见 server/handler.js；签名与状态机在 src/orders.js。
 * 需要配置 JSLB_PAY_WEBHOOK_SECRET，未配置时该端点恒为 401。
 */
export { POST, OPTIONS } from '../vercel/entry.js';
