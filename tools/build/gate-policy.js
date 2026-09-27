/**
 * 受保护模块名单——**构建期专用**（build-web.js 与 verify-encryption.js 共用）。
 *
 * 为什么要有一份名单：`src/**` 分两类，处理方式完全不同。
 *   - 受保护模块：混淆核心本身。Vercel 部署（`build:web:cloud`）**根本不发**它们，
 *     界面不下载核心，混淆一律由 /api/obfuscate 在服务端跑；
 *   - 公开模块：授权链路与选项元数据的静态依赖，未激活界面要靠它们渲染激活表单，
 *     必须原样下发。
 *
 * 两件事必须对**同一个集合**成立。名单与实际处理一旦漂移，构建期不报错，只在产物
 * 里表现为怪现象：公开模块被漏发 → 未激活界面渲染不出激活表单（死锁）；受保护模块
 * 被下发 → 核心源码随静态资源公开、门控形同虚设。所以单点定义，谁处理都从这里取。
 *
 * 名单怎么来的：不是拍脑袋列的，是**从 web/app.js 的静态 import 链做可达性分析**
 * 算出来的。起点是 app.js 顶部那批静态 import（options-meta / options-gate / plan /
 * license-web / i18n / platform / utils-zip / version / options / presets），跟随相对
 * 说明符展开。截至 2026-09-27：src/ 下 58 个模块里 16 个必须公开，其余 42 个受保护。
 * 改动 app.js 的静态 import 或这几处的依赖后必须重算，否则就是上面那种漂移。
 * 复核方法（不需要解析器，与 build-web.js 的 collectModules 同一套正则思路）：
 *   遍历 src 下的 .js（id 相对 src/，如 "passes/vm.js"），逐个喂给
 *   isGatedModuleId，确认 public 数与 dist/src/ 实际下发的文件数一致。
 *   注意写法：路径里不要出现双星号斜杠的 glob（那会提前关掉本块注释）。
 *
 * 下面 GATED_EXEMPT 的两项（utils/hash.js、utils/zip.js）在 utils/ 前缀内却是公开的
 * ——它们在未激活页面的静态 import 链上（app.js → license-web → license-codec →
 * utils/hash，以及 app.js → utils/zip），挡住会死锁激活表单。别当成漏网之鱼删掉。
 *
 * 放在 tools/build/ 而不是 src/：src/ 下的每个文件都会进 dist 并被混淆，这份策略
 * 只在构建期用得到，不该作为模块发给浏览器。
 */

export const GATED_PREFIXES = [
  'index.js',
  'obfuscate.js',
  'pipeline.js',
  'html.js',
  'passes/',
  'ast/',
  'utils/',
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
  'utils/hash.js',
  'utils/zip.js',
];

/**
 * 该模块 id（相对 src/，如 'passes/vm.js'）是否属于受保护集合。
 * 加密层产物（__jslb_core.js / __core.pack）由 writeEncryptedCore 单独处理，
 * 不在本名单里——它们不是源模块，而是构建期生成的两份文件。
 */
export function isGatedModuleId(id) {
  if (GATED_EXEMPT.includes(id)) return false;
  return GATED_PREFIXES.some((p) => id === p || id.startsWith(p));
}
