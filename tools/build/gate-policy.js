/**
 * 受保护模块名单——构建期专用（build-web.js 与 verify-encryption.js 共用）。
 *
 * 为什么要有一份名单：`src/**` 分两类，处理方式完全不同。
 *   - 受保护模块：混淆核心本身。Vercel 部署（`build:web:cloud`）根本不发它们，
 *     界面不下载核心，混淆一律由 /api/obfuscate 在服务端跑；
 *   - 公开模块：授权链路与选项元数据的静态依赖，未激活界面要靠它们渲染激活表单，
 *     必须原样下发。
 *
 * 两件事必须对同一个集合成立。名单与实际处理一旦漂移，构建期不报错，只在产物
 * 里表现为怪现象：公开模块被漏发 → 未激活界面渲染不出激活表单（死锁）；受保护模块
 * 被下发 → 核心源码随静态资源公开、门控形同虚设。所以单点定义，谁处理都从这里取。
 *
 * 名单怎么来的：不是拍脑袋列的，是从 web/app.js 的静态 import 链做可达性分析
 * 算出来的。起点是 app.js 顶部那批静态 import（options-meta / options-gate / plan /
 * pricing / license-web / i18n / platform / utils-zip / version / options / presets），
 * 跟随相对说明符展开。截至 2026-10-11：src 下 73 个模块里 17 个必须公开，其余 56 个
 * 受保护。改动 app.js 的静态 import 或这几处的依赖后必须重算，否则就是上面那种漂移。
 * build-web.js 里那条「已下发但没进 modulepreload」的告警就是这条不变式的自动化
 * 版本——它一响，先怀疑本名单，再怀疑 collectModules 的扫描。
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
  // htmle：HTML 文本加密的实现，与 html.js 同属产物侧逻辑。不加进来的话它会
  // 被当成公开模块拷进 dist/src/，等于把加密方案（密钥流、长度前缀打包、实体表）
  // 原样发给客户端——既坏了「核心不在产物里」这条，也让它形同虚设。
  // 2026-09-30 由 dist 核对发现：dist/src/htmle.js 确实被下发了。
  'htmle.js',
  // target-runtime.js：产物目标运行时的判定（workerd 限制、时钟冻结、profile）。
  // 它唯一的引用者是 src/obfuscate.js，而 obfuscate.js 本身是受保护模块——浏览器侧
  // 从 web/app.js 出发根本够不着它，所以它属于核心、不属于公开模块。
  //
  // 2026-10-11 由构建期的「已下发但没进 modulepreload」告警发现：它不在 app.js 的
  // 静态 import 链上，也没有任何公开模块引用它，却因为没进本名单被照发进
  // dist/src/ 约 4 KB 死重量（浏览器永远不会去取，所以那条告警说的"串行往返"
  // 在这个例子里不成立，真正的问题是白下发 + 一条会被无视的告警）。
  'target-runtime.js',
  // orders.js：购买订单的状态机与核验规则。它是**服务端**逻辑（server/handler.js 与
  // tools/issue/orders.js 用），浏览器侧一行都不需要——界面只调 /api/order。
  // 不挡它的话就是白下发一份"订单/取卡鉴权"的实现，且会触发构建期那条
  // 「已下发但没进 modulepreload」告警（2026-10-11 加定价页时顺手挡住）。
  'orders.js',
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
