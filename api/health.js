/**
 * Vercel 函数：GET /api/health。
 *
 * 只做转发：真正的处理与宿主包络加工都在 vercel/entry.js。Vercel 按文件建函数，
 * 所以每个路由各占一个文件；文件名即路径，不接受通配符以外的花活。
 */
export { GET, OPTIONS } from '../vercel/entry.js';
