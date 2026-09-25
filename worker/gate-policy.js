/**
 * 受保护路径策略——**worker 与 build:web 共用这一份**。
 *
 * 为什么必须共用：dist/src 下有两类模块，处理方式完全不同。
 *   - 受保护模块：构建期被加密成「明文 stub + 密文载荷」，Worker 侧匿名 403；
 *   - 公开模块：明文直出（未激活界面要靠它们渲染激活表单），Worker 侧必须 200。
 * 这两件事必须对**同一个集合**成立。两处各写一份名单，迟早漂移：
 *   名单比加密集合大 → 公开模块被 403 → 未激活界面渲染不出激活表单（死锁）；
 *   名单比加密集合小 → 受保护模块的 stub 与引导层被匿名取到 → 加密层形同虚设。
 * 两种都不会在构建时报错，只在线上表现为"莫名其妙"，所以这里做成单点。
 *
 * 名单怎么来的：不是拍脑袋列的，是**从 app.js 的静态 import 链做可达性分析**算出来的。
 * 起点是 app.js 顶部那批静态 import（options-meta / options-gate / plan / license-web /
 * i18n / platform / utils-zip / version / options / presets），跟随相对说明符展开，
 * 60 个模块里 15 个必须公开，其余 45 个全部受保护。改动 app.js 的静态 import 或
 * 这几处的依赖后必须重算，否则就是上面两种漂移之一。
 *
 * 放在 worker/ 而不是 src/：src/ 下的每个文件都会进 dist 并被混淆/加密，而这份策略
 * 只在构建期与 Worker 运行时用得到，不该作为模块发给浏览器。
 */

export const GATED_PREFIXES = [
  '/src/index.js',
  '/src/obfuscate.js',
  '/src/pipeline.js',
  '/src/html.js',
  '/src/passes/',
  '/src/ast/',
  '/src/utils/',
  // 加密层自身：引导层含密钥，载荷是密文。两者都必须挡在鉴权之后——
  // 引导层若公开，密钥就等于公开，载荷可被离线解开。
  '/src/__jslb_core.js',
  '/src/__core.pack',
];

/**
 * 前缀命中但必须公开的例外。
 *
 * `utils/hash.js`（HMAC/base64）与 `utils/zip.js`（打包下载）都在未激活界面的
 * 静态 import 链上：app.js → license-web → license-codec → utils/hash，
 * app.js → utils/zip。挡掉它们，未激活用户连激活表单都渲染不出来。
 * 这两个文件不含混淆算法，公开无碍。
 */
export const GATED_EXEMPT = [
  '/src/utils/hash.js',
  '/src/utils/zip.js',
];

/** 该 URL 路径是否需要激活才能下载。 */
export function isGatedPath(pathname) {
  if (GATED_EXEMPT.includes(pathname)) return false;
  return GATED_PREFIXES.some((p) => pathname.startsWith(p));
}

/** 该模块 id（相对 src/，如 'passes/vm.js'）是否需要保护。 */
export function isGatedModuleId(id) {
  return isGatedPath('/src/' + id);
}