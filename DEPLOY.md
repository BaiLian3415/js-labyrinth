# 部署到 Cloudflare

从零到上线的一份可执行清单。所有命令都在项目根目录执行，Windows（Git Bash）与
macOS/Linux 通用。零依赖是本项目硬要求，所以 **wrangler 不入 `package.json`**，
用时临时装、用完删。

---

## 1. 选 Workers 还是 Pages

**结论：Workers。** 项目已经是 Workers 形态，不要改。

| 判断点 | 本项目情况 | 结论 |
| --- | --- | --- |
| 有没有服务端逻辑 | 有：`/api/license`、`/api/obfuscate`、`/api/plans`、`/api/health` | 两者都行 |
| 要不要 KV 持久化 | 要：许可证记录、配额计数按设备码分键存 `JSLB_KV` | **Workers 更顺**——`[[kv_namespaces]]` 写在 `wrangler.toml` 里随代码走；Pages 的绑定要在控制台手配，容易漏 |
| 要不要 Secrets | **不需要**（公钥已内置且非机密） | **Workers 更顺**——配置更少；Pages 要控制台手配绑定 |
| 界面与 API 是否同域 | 是：`[assets]` + `run_worker_first = ["/api/*"]`，一个域名全包 | Workers 原生支持 |
| 自定义域名 | 已绑 `https://jslb.lllm.dpdns.org` | 两者都行 |

**什么时候改选 Pages**：只需要静态界面 + `functions/api/[[path]].js`（项目里确实保留了
这份等价实现），而且能接受 KV/Secret 去控制台手配。注意 Pages **只从项目根读
`functions/`**，所以那个目录不能挪。

> `dist/` 里 `src/**` 是界面要用的核心模块（原生 ESM，界面在浏览器内跑混淆）。
> 它不是"源码泄露"，是设计如此——**也因此根密钥会随静态资源公开**，见第 4 节。

---

## 2. 配置文件

`wrangler.toml` 已配好，逐项确认一遍：

```toml
name = "jslabyrinth"                    # Worker 名
main = "worker/index.js"                 # 入口（不 import 任何 node: 内建，无需 nodejs_compat）
compatibility_date = "2025-04-01"

[assets]
directory = "./dist"                    # ← 必须与 npm run build:web 的输出目录一致
binding = "ASSETS"
not_found_handling = "404-page"

run_worker_first = ["/api/*"]           # ← 不能省
```

`run_worker_first` 为什么必须写：`compatibility_date` 在 `2025-04-01` 及以后时，
浏览器地址栏直接打开 `/api/health`（导航请求，带 `Sec-Fetch-Mode: navigate`）会
**优先走静态资源**，而 `dist/` 里没有这个文件，于是返回 404 页面而不是 JSON。
界面里的 `fetch` 属于 cors 请求，本来就命中 Worker，所以不加也能跑——只是直接
访问接口会莫名 404。

其余两项：

```toml
[vars]
JSLB_WEB_CONFIG = '{"requireLicense":true,...}'   # 非机密，可以入库

[[kv_namespaces]]
binding = "JSLB_KV"
id = "cfdd5c6983dd427aa03ba995c45bbd91"           # 换账号要改
```

没有 KV 就先建（免费版够用）：

```bash
node node_modules/wrangler/bin/wrangler.js kv namespace create JSLB_KV
# 把输出的 id 填进 wrangler.toml
```

`wrangler.jsonc` 是等价的新格式，本项目统一用 `wrangler.toml`，不要两种并存
（wrangler 找到多个配置文件会报错）。

---

## 3. 构建与调试（全部经 Cloudflare）

本项目**不在本地起 Web 服务器**，也不需要任何本地 hosts 映射。所有调试与发布
都走 Cloudflare 自己的运行时：

```bash
npm run build:web        # 产出 dist/：界面 + 自混淆后的核心（--plain 可退回纯复制）
                         # 纯复制 + 注入，无打包器、无外部依赖，约 1 秒

npx wrangler dev         # 本地 workerd：静态资源 + /api/*，与线上同构
                         # 这是唯一的"本地跑起来"方式，跑的就是线上那套运行时

npx wrangler deploy      # 发布到线上，浏览器直接打开线上域名验证
```

`wrangler dev` 由 Cloudflare 官方工具提供并运行 `workerd`（Cloudflare 的生产
运行时），不是自建服务器——静态资源、`/api/*` 路由、KV 绑定、`[vars]` 策略
全部按 `wrangler.toml` 在进程内复现。因此**本地与线上是同一套语义**，不需要
再维护一个等价的本地预览器。

> 早先版本有个 `npm run serve`（自建 http 静态预览），现已移除。它只是把
> 文件读给浏览器，既不跑 Worker 也不读 KV，与线上差异反而更大；`wrangler dev`
> 覆盖了它全部用途且更准。

**发布前必跑**（改了授权相关代码时）：

```bash
npm run test             # 核心 + 线上验收（见下）
npm run hashtest         # 68 项
npm run semantics        # 语义保持 528 次比对（约 11 分钟）
npm run selfdigest:check # 自身摘要表；改了授权文件要 npm run selfdigest
```

`npm run test` 末段会打线上域名做验收。若要纯离线跑（无网 / 受限 CI）：

```bash
JSLB_SKIP_LIVE=1 npm test
```

验收目标域名默认 `https://jslb.lllm.dpdns.org`，用 `JSLB_LIVE_ORIGIN` 覆盖。

---

## 4. 环境变量与 Secrets

### 4.1 分类

| 名称 | 机密？ | 放哪 | 说明 |
| --- | --- | --- | --- |
| `JSLB_CODE_KEY` | 否 | `[vars]` 或 Secret 都行 | 覆盖内置签发公钥。**非机密**，默认不用配 |
| `JSLB_MACHINE_SALT` | 否 | 同上 | 机器码派生盐。**非机密** |
| `JSLB_WEB_CONFIG` | 否 | `[vars]` | 网页版策略 JSON，界面会公开读回 |
| `JSLB_CORS_ORIGIN` | 否 | `[vars]` | `/api/*` 跨域来源，默认 `*`，同源部署不用配 |
| `JSLB_DEVICE_ID` | 否 | `[vars]` | 固定设备码（仅用于 KV 分键与试用计数），测试用；**不再影响机器码** |
| ~~`JSLB_CORE_KEY`~~ | — | — | **已废弃**（对称签名时代的根密钥），见 4.4 |

> **⚠️ v5 更新（2026-09-24）：卡密改为对称格式，本节及下文的 Ed25519/私钥描述是 v4 历史背景。**
> 卡密为 `JSLB-编号8-信息16-校验4`，签发与校验共用同一把对称卡密密钥（`B64_CODE_KEY`，随
> 源码分发；可用 `JSLB_CODE_KEY` 环境变量覆盖）。服务端现在**有**一把"所有访客也拿得到"的
> 密钥——这是对称体系的固有属性，真正的强制在服务端：/api/obfuscate 逐请求校验、KV 赎回
> 登记（一卡一机）与 JSLB_GATE_CORE 门控。安全模型以 `src/license-codec.js` 的头注释为准。

**Worker 上没有任何机密。** 卡密是 Ed25519 签名的，Worker 只持公钥——它能验签、
签不出新卡。公钥写死在 `src/license-secret.js` 里随静态资源公开，这**不是**问题。

**签发私钥（`JSLB_CODE_KEY`）绝不能出现在 Worker、Secret 或 `dist/` 里。**
它只在签发方（你自己的机器）：环境变量或项目根的 `.jslb-code-key`（gitignore）。

### 4.2 注入

默认情况下**什么都不用配**——公钥已内置。只有"用自己的密钥对"时才需要：

```bash
node tools/issue/keyrotate.js --write        # 生成密钥对
# 公钥进 src/license-secret.js（可入库）；私钥进 .jslb-code-key（gitignore）
node node_modules/wrangler/bin/wrangler.js secret put JSLB_CODE_KEY   # 可选：覆盖公钥
node node_modules/wrangler/bin/wrangler.js secret list                  # 只列名，不列值
```

本地 `wrangler dev` 用 `.dev.vars`（**已在 `.gitignore` 里**）：

```bash
cat > .dev.vars <<'EOF'
JSLB_CODE_KEY=<你的公钥>
JSLB_MACHINE_SALT=<B64_MACHINE_SALT>
EOF
chmod 600 .dev.vars
```

### 4.3 三条硬规矩

1. **私钥永不进仓库、不进 `dist/`、不进 `wrangler.toml`、不进 Secret。**
   泄露 `JSLB_CODE_KEY` 等于泄露发卡权：拿它可以签出任意套餐、任意有效期的卡密，
   而所有验签方都持有对应公钥，一定通过。
2. **发卡要带同一把私钥**（默认读 `.jslb-code-key`，所以通常也不用带）：
   ```bash
   JSLB_CODE_KEY=<base64 种子> node tools/issue/keygen.js --plan plus --days 365
   ```
   缺私钥时会明确报错并给出设置方法，不会静默签出一张验不过的卡。
3. `.jslb-code-key`、`.keygen-state.json`、`.dev.vars`、`.env`、
   `.workbuddy-ai/` 都已在 `.gitignore` 里。**提交前扫一遍**：
   ```bash
   grep -rIn "JSLB_CODE_KEY\|B64_PRIVATE" --exclude-dir=node_modules --exclude-dir=dist .
   # 只应命中文档与 .env.example 的占位符
   ```

### 4.4 密钥模型：非对称，源码公开不再致命

**2026-09-20 起卡密改用 Ed25519 非对称签名**，此前的 HMAC-SHA256 对称方案已废弃。
两者的区别决定了"源码公开"这件事的性质：

| | 旧（对称 HMAC） | 新（Ed25519） |
| --- | --- | --- |
| 浏览器/Worker 持有什么 | **同一把密钥**（能验也能签） | **只有公钥**（能验不能签） |
| 源码被爬走后能否伪造卡密 | **能**，拿到密钥就能签任意套餐 | **不能**，签名需要私钥 |
| 密钥轮换代价 | 所有卡密作废 | 所有卡密作废 |

所以现在：

```
GET https://jslb.lllm.dpdns.org/src/license-secret.js   → 200，但里面只有公钥
```

**这是设计结果，不是漏洞。** 爬走公钥签不出任何东西。

剩下的边界要说清楚：

- **机器绑定分两层，卡密那层才是边界。** 卡密里的绑定段是机器码的 HMAC 摘要，且在
  Ed25519 签名载荷内 ⇒ 拿别人的卡密到自己机器上激活一定失败，改不了绑。而本地记录里的
  `machine` 字段与令牌用了派生自公钥的对称密钥，那层只防"把本地许可证记录拷到另一台
  机器"，**不是**边界。
- **本地记录令牌仍是 HMAC-SHA256，密钥由公钥派生（即公开）。** 它绑定机器码、
  到期时间与用量，作用是"手改记录会被发现"，**不是安全边界**——
  有源码的人能自己重算。之所以必须留在本地（浏览器 localStorage / KV），是因为用量每次
  递增都要重签（`license-web.consumeRun()`），拿不到签发私钥。
  但它改不动**套餐**：套餐来自卡密签名，而那层是 Ed25519。
- **到期时间由卡密里已签名的签发日推出**，不采信记录里的 `issuedAt`/`expiresAt`。
  所以本地改记录也续不了期。
- **网页端的「机器码」是设备特征，不是唯一硬件标识。** 浏览器拿不到唯一硬件 id，只能用
  平台/核心数/屏幕/GPU 渲染器/时区/语言这组特征派生，**同型号同配置的机器会算出同一个
  机器码**。所以绑定是"设备特征级"的，比硬件指纹弱一档。要一对一，只能把
  签发与验签都搬到服务端（本项目刻意不这么做——混淆在浏览器内跑，验签也跟着在浏览器内，
  这是同一个取舍）。好的一面：清站点数据、换浏览器、进隐私模式都**不会**换机器码，已激活
  的卡不会因清缓存失效。
- 自检摘要表（`SELF_DIGESTS`）的掩码密钥现在是公钥，因此它只挡"随手改一行源码"。
  真正的边界是私钥不在库里——改源码最多骗过本机自检，签不出能在别处通过验签的卡密。

轮换密钥对：`node tools/issue/keyrotate.js --write`（会重算摘要表）。

### 4.5 核心源码的暴露面：四层防护

`dist/src` 里现在只剩 15 个公开模块的明文（激活表单的静态依赖，必须能匿名取到），
其余 45 个受保护模块没有源码文本。现在有四层，**默认全部开启**：

| 层 | 机制 | 挡什么 | 状态 |
| --- | --- | --- | --- |
| **1. 鉴权下发** | `JSLB_GATE_CORE = "true"`，受保护路径未激活一律 403 | 匿名爬虫、未激活用户 | **已启用** |
| **2. 自混淆** | `build:web` 用项目自己的混淆器把 `src/**` 跑一遍再写进 `dist/` | 抬高已激活用户的逆向成本 | **已启用**（实测 1.31×） |
| **3. 模块体加密** | 45 个受保护模块 → 明文 stub + 一个密文载荷；引导层解密后 Blob 物化 | **直接爬取拿不到可读代码** | **已启用** |
| **4. 卡密签名** | 卡密载荷有校验段，且服务端逐请求校验 + KV 赎回登记 | **即使前三层全被绕过也造不出可用卡密** | **已启用** |

第 4 层才是安全边界，前三层是纵深。也就是说：**爬走全部源码的人，拿不到任何能签
卡密的东西。**（v5 起卡密是对称体系，见本节开头的历史说明——"拿到源码能造卡"这句
仍然成立，真正的强制在服务端的三件事：逐请求校验、赎回登记、门控。）

#### 自混淆（第 2 层）的实测数据与约束

```
核心已自混淆（60 个文件，766 KB -> 1490 KB，1.9 倍，耗时 ~700 ms）
核心已模块体加密：45 个受保护模块 → 明文 stub + 1262 KB 载荷，引导层 3.6 KB
```

- **必须逐文件混淆**，不能合并成 bundle——项目是原生 ESM，界面按文件路径 import。
  混淆器保留 import/export 绑定与文件路径，所以逐文件混淆不破坏跨文件引用。
- **产物必须仍是合法 ESM**：`functionWrapper` 检测到 import/export 会自行跳过，
  否则包进 IIFE 会把 `export` 吞掉（见 `src/passes/functionWrapper.js`）。
- **种子固定**，同一份源码每次构建得到相同产物；混淆后的核心产出与原核心
  **逐字节一致**（low/medium/high 三档实测）。
- **按实测挑 pass，别照旧名单猜**。旧文档给的"low 全量 70.6× / 关 objectKey 27.9× /
  再关 stringArray 10.8× / 再关四项 1.63×"整条链已过时，而且把最贵的第二项漏了。
  重测（`npm run bench:selfobf`，11 次取中位数，混淆后的核心 vs 原核心）：

  | 配置 | 运行期 |
  | --- | --- |
  | `objectKeyEncoding` | 21.37×（每次属性访问变成分段解密取键） |
  | `opaquePredicates` | **2.99×**（单项第二贵，旧表把它当免费项了） |
  | `stringArray` 全量 | 2.59× |
  | `stringArray` 阈值 0.10 | 1.65×（压到最低也装不进 ≤1.5× 预算） |
  | `numberObfuscation` | 1.11× |
  | 控制流 / 死码 / 逻辑 / 条件 | 各 1.02~1.04× |
  | 基线（全关昂贵项） | 0.99× |
  | **当前配置**（免费全开 + 昂贵全关） | **1.31×** |

  当前配置保留**重命名**（名字全不可读）、**RT 内核**（原生 API 名不出现）、
  **控制流平坦化**与**数字混淆**；只有字符串字面量仍是明文——那部分由第 3 层补。
  改 `selfObfOptions` 前先跑 `npm run bench:selfobf`。
- **调试线上问题时用 `npm run build:web -- --plain`**（或 `JSLB_BUILD_PLAIN=1`），
  两层都跳过，产物退回与源码逐字节一致。预设与种子可用 `JSLB_BUILD_OBF_PRESET` /
  `JSLB_BUILD_OBF_SEED` 覆盖（显式指定预设时完全按预设走，包括昂贵的 pass）。
- 自混淆失败会**中止构建**并列出文件，不会混出"一半明文一半混淆"的产物。

#### 模块体加密（第 3 层）的机制与约束

形态：每个受保护模块在 `dist/src/<路径>.js` 只剩一个**明文 stub**（约 130 字节），
真源码进 `dist/src/__core.pack`（密文），`dist/src/__jslb_core.js` 是 3.6 KB 的
明文引导层。三者关系与完整设计说明见 `tools/build/enc-loader.js` 头注释。

- **stub 必须静态再导出**：ESM 的导出名必须在解析期确定，不能运行时拼。所以构建期
  枚举每个模块的导出名，逐个写 `export const <name> = __m.<name>;`。
  **这里踩过一次**：`index.js` 的导出清单带分组注释（`// 核心`），注释跟着逗号粘进
  片段，导致紧跟注释的 `obfuscate` 与 `runJob` 双双漏掉——产物能加载、能建对象，
  但一点"混淆"就 `runJob is not a function`。所以构建期枚举 + `npm run verify:enc`
  的逐模块导出比对都不能省。
- **依赖图不能有环**：物化是带顶层 await 的，A 等 B、B 等 A 就是死锁。当前 60 个
  节点无环（Tarjan 验过）。加模块时若引入环，加密层会整体加载失败。
- **相对说明符必须改写**：blob 模块里的 `./x.js` 会以 blob URL 为基准解析（无效地址），
  解密后统一改写成本源上的 stub 绝对地址。公开模块因此能混用（stub 与明文文件在
  同一进程里互相 import）。
- **载荷有 FNV 完整性校验**：改 1 字节就抛 `payload integrity check failed`，
  不会静默跑错代码。
- **密钥随引导层下发**——所以拿到引导层的人一定能解出载荷。这一层挡的是"直接爬取
  读代码"，**不是安全边界**（真正边界见上表第 4 层）。想换密钥：
  `JSLB_BUILD_ENC_KEY`（hex 或 base64），代价是产物不再与默认构建逐字节相同。
- **发布后必跑** `npm run verify:enc`（对 dist 校验：密文可加载、45 个模块导出逐个
  一致、语义保持、篡改被拦）；它**不能替代浏览器实测**——blob: 物化只有真浏览器能验。
  2026-09-25 已在 Chrome 上实测：激活后 `/src/__jslb_core.js` 与 `/src/__core.pack`
  正常取回，随后大量 blob: Script 动态导入成功，混淆产出正常。
- 第 1 层的名单在 `worker/gate-policy.js`，**与构建期加密的是同一份**。两处漂移不会
  报错：名单偏大 → 未激活界面取不到激活表单依赖的模块（死锁）；名单偏小 → 引导层
  被匿名取走，加密层形同虚设。`npm run verify` 第 5 项正反两个方向都会探。

**这一步本身就是混淆器最狠的自测**：拿它混淆自己，产物一加载就会暴露任何语义破坏。
2026-09-20 的 BigInt 缺陷就是这么发现的——`opaquePredicates` 对函数参数做位运算，
碰到 BigInt 参数直接抛 `Cannot mix BigInt and other types`，凡是用户代码里出现
BigInt 都会中招。

**自混淆的可行性已验证**：混淆器会保留 `import`/`export` 绑定与文件路径
（实测产物里 `import PLANS from "./plans.js"`、`export default {...}` 原样保留），
所以逐文件混淆不会破坏跨文件引用。整库 52 个文件全部可混淆（此前 `src/i18n.js`
因 `isRefByIdent` 的 ESM 说明符误判失败，已修）。

**鉴权下发（第 1 层）的细节。** `worker/index.js` 里：`JSLB_GATE_CORE = "true"` 时，
下面六个入口走 Worker 校验，未激活一律 403：

```
/src/index.js  /src/obfuscate.js  /src/pipeline.js  /src/html.js  /src/passes/*  /src/ast/*
```

其余模块保持公开（options / presets / plan / license-* / i18n / platform /
options-meta / options-gate / version / utils），界面要靠它们渲染激活表单。
身份靠 **HttpOnly 设备 cookie** 传递（浏览器的模块请求是普通同源 GET，**带不了**
`X-JSLB-Device` 自定义头）；激活成功时种下、解除激活时清除；响应强制
`cache-control: private, no-store`（否则缓存会把源码留给后面的匿名请求）。

原先这里有个**死锁**：`web/app.js` 是**静态** `import './src/index.js'`，模块请求发生在
页面加载最开始且此时还没有 cookie —— 未激活用户渲染不出界面，永远走不到激活那一步。
已把界面拆成两段解决：

1. 授权链路与选项元数据**静态引入**（上面那批公开模块）；
2. 混淆核心改成**按需动态引入**：`const { runJob } = await loadCore()`，
   `loadCore()` 内部是 `import('./src/index.js')` 并缓存 promise。激活成功后会
   提前预热一次，免得首次执行混淆要等几十个模块下载。

顺带的收益：首页 `modulepreload` 清单从 **51 条降到 16 条**——清单本身不再泄露
整棵模块树的结构。

线上实测（2026-09-20）：

```
/src/passes/stringArray.js   匿名: 403   已激活(带 cookie): 200 (25816 字节)
/src/ast/parser.js           匿名: 403   已激活(带 cookie): 200 (58619 字节)
/src/index.js                匿名: 403   已激活(带 cookie): 200
/src/plan.js                 匿名: 200   ← 公开，界面要用
解除激活后带同一 cookie                     403
```

注意：每个受保护模块请求要读一次 KV，一次页面加载约三十次（免费版十万次读/天）。
只对 Workers 生效——Pages 的静态资源不经过 Worker 的 `fetch`。

---

## 5. 发布到生产

### 5.1 装 wrangler（临时，用完删）

```bash
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY      # 本机代理会挡 Cloudflare API
export NODE_OPTIONS="--dns-result-order=ipv4first"
npm install --no-save wrangler@4                          # --no-save：不写进 package.json
node node_modules/wrangler/bin/wrangler.js whoami         # 确认已登录
```

### 5.2 发布

```bash
npm run build:web                                         # 先构建
node node_modules/wrangler/bin/wrangler.js deploy
```

输出末尾给 `Version ID`，记下来。然后**必跑验证**：

```bash
npm run verify                                            # 默认验自定义域名
node tools/build/verify-deploy.js https://你的域名/         # 换域名
```

7 项探针，全过才算发成功（都不消耗配额：随机设备码，且期望被拒）：

1. `/api/health` 活着，`runtime=worker`
2. `/api/plans` 档位数与本地一致（现为 9）
3. `web.requireLicense` 与预期一致
4. **线上档位表与本地定义逐档一致**（预设上限、`maxFileBytes`、`maxFilesPerRun`、
   `runsPerDay`、`runsTotal`、族 `kind`、关闭项）
5. `web.*` 与 `wrangler.toml` 的 `[vars]` 逐键一致
6. 无卡密 `POST /api/obfuscate` 被拒（期望 402）

第 4、5 项是为了防"部署的不是这份代码"——**配置写了、部署没报错，不等于生效**。
2026-09-19 踩过：`JSLB_WEB_CONFIG` 写着 `requireLicense: true`，部署输出也把它列为
binding，线上却返回代码默认值 `false`。

顺手看日志与历史：

```bash
node node_modules/wrangler/bin/wrangler.js tail            # 实时日志
node node_modules/wrangler/bin/wrangler.js deployments list
```

### 5.3 自定义域名

当前 `https://jslb.lllm.dpdns.org` 已绑定，绑在 Cloudflare 侧（不在 `wrangler.toml`
里，所以重新发布不会丢）。新增或换绑：

- **DNS 在 Cloudflare**：控制台 Workers → `jslabyrinth` → Settings → Domains & Routes →
  Add → Custom Domain；或写进 `wrangler.toml` 后 `wrangler deploy`：
  ```toml
  [[routes]]
  pattern = "jslb.example.com"
  custom_domain = true
  ```
- **DNS 在别处**（`dpdns.org` 属于这种）：走 Cloudflare for SaaS 自定义主机名，
  或在 DNS 商处 CNAME 到 `jslabyrinth.heling8y.workers.dev`。

`*.workers.dev` 子域在本机 DNS 被污染（解析到 `face:b00c`），**不要用默认的
workers.dev 地址验收**，一律用自定义域名。

### 5.4 收尾

```bash
rm -rf node_modules package-lock.json     # 零依赖项目不留这些
git status                                # 确认没把密钥/产物带进来（本项目暂无 git 仓库）
```

---

## 6. 常见报错排查

### 鉴权失败

```bash
node node_modules/wrangler/bin/wrangler.js whoami
```

- **没登录**：`wrangler login`（浏览器授权）。CI 用 `CLOUDFLARE_API_TOKEN`。
- **没有 `~/.wrangler` 目录 ≠ 没登录**：本机凭据在别处，`whoami` 照样通。先跑 `whoami`
  再下结论。
- **请求超时 / `ENOTFOUND`**：先 `unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY`
  并 `export NODE_OPTIONS="--dns-result-order=ipv4first"`。本机代理只放行少数域名，
  Cloudflare API 全被挡。网络命令需要关沙箱。
- **`--no-save` 装完找不到命令**：wrangler 不在 PATH，用
  `node node_modules/wrangler/bin/wrangler.js ...` 全路径调用。

### 构建产物目录错误

- 症状：发布后首页 404、或只有 API 没有界面。
- 查 `wrangler.toml` 的 `[assets].directory` 是否等于 `./dist`，以及 **`npm run build:web`
  有没有真的跑过**（改了源码忘了构建，线上就是旧界面）。
- `dist/` 被 `.gitignore` 忽略是正常的：它是构建产物，每次发布前重新生成。
- 想确认线上跑的是哪份：`npm run verify` 的第 4 项会逐档比对，对不上就是部署的不是
  这份代码。

### Node 版本不兼容

- 项目 `engines.node >= 18.17`，本机 `v22.22.2`。
- wrangler 4 系列对 Node 版本要求较高；装的时候报 `EBADENGINE` 就降到
  `npm install --no-save wrangler@3`，或把 Node 升到 20+。
- **不要给 Worker 加 `nodejs_compat`**：本项目核心不 import 任何 `node:` 内建，
  加了反而掩盖问题。

### `EvalError: Code generation from strings disallowed`

核心模块图里出现了 `eval` / `new Function`。Cloudflare 禁用，上传直接失败。
`src/passes/shell.js` 早年用过 `(0, eval)(PRIMITIVES)`，已改成手写等价实现。
自测里有守卫会拦住回退。注意**产物里面**的 `(0,eval)` 是给宿主跑的引导器，不受限。

### `error code: 1102`（CPU 超限）

免费版单请求 10 ms。medium 预设下实测：≤4 KB 正常，**8 KB / 16 KB 直接 1102**。
返回的是 Cloudflare HTML 错误页而非 JSON。界面的混淆本来就跑在浏览器内（用户自己的
CPU），不受影响；要放开 `/api/obfuscate`，改付费版并打开 `wrangler.toml` 里注释掉的
`[limits] cpu_ms = 30000`。

### 配置写了但线上没变 `/api/plans` 返回默认值

按这个顺序排查：

1. `wrangler deployments list` 确认域名指向的是哪个 Worker。
2. `npm run verify` 第 5 项现在会直接指出哪个键不一致。
3. 改一个醒目值（如 `trialRunsPerDay: 7`）重新发布，看 `/api/plans` 跟不跟着变；
   不变就是发布的不是同一个服务。
4. 实测有"重新发布一次就好了"的情况，原因未查明——所以**每次发布后都要 verify**，
   不能看部署输出没报错就算完。

---

## 附：一次完整发布（复制即用）

```bash
cd <项目根>
npm run build:web
npm run test && npm run selfdigest:check

unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
export NODE_OPTIONS="--dns-result-order=ipv4first"
npm install --no-save wrangler@4
node node_modules/wrangler/bin/wrangler.js whoami
node node_modules/wrangler/bin/wrangler.js deploy
npm run verify

rm -rf node_modules package-lock.json
```
