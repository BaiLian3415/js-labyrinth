# 部署到 Vercel

从零到上线的一份可执行清单。所有命令都在项目根目录执行，Windows（PowerShell /
Git Bash）与 macOS/Linux 通用。运行时零依赖，`vercel` CLI 也不进 `package.json`，
用时临时 `npx` 拉起。

站点是 **云端执行**形态：界面与 `/api/*` 同域，混淆在服务端跑，**混淆核心不随静态
资源下发**。

---

## 1. 为什么是"云端执行"

`web/app.js` 有两种执行模式，由部署决定（`cloudOnly`，由 `/api/plans` 下发）：

| 模式 | 混淆跑在哪 | 静态产物里有核心吗 | 适合 |
| --- | --- | --- | --- |
| 浏览器内执行 | 访问者的 CPU | 有（自混淆 + 模块体加密） | 自建、离线、想省服务端 CPU |
| **云端执行**（本部署） | Vercel 函数 | **没有** | 公开站点：源码不出服务端 |

Vercel 部署走云端执行，构建命令是 `npm run build:web:cloud`（见 `vercel.json`）：

- 受保护模块（`src/index.js`、`pipeline.js`、`passes/`、`ast/`、`utils/` …）**根本不进
  `dist/`**，只有授权链路与选项元数据的公开模块下发——未激活界面要靠它们渲染激活表单；
- 界面把源码 POST 到 `/api/obfuscate`，服务端跑完整流水线后回结果，大回执走流式；
- `/api/plans` 强制 `web.cloudOnly = true`（`vercel/entry.js` 里写死，不看环境变量）：
  漏配会让界面去 import 一个不存在的 `./src/index.js`，用户看到的是一句 404 黑话。

> 浏览器内执行的构建（`npm run build:web`，不带 `--cloud`）仍然可用，适合自建；
> 它带完整核心与模块体加密层，代价是核心随静态资源公开（对称卡密密钥也在里面，
> 见第 4 节）。

---

## 2. 配置文件

`vercel.json` 已配好：

```jsonc
{
  "buildCommand": "npm run build:web:cloud",   // 云端执行构建
  "outputDirectory": "dist",                   // ← 必须与构建输出一致
  "regions": ["hkg1"],                         // 香港；用户主要在东亚时延迟更低
  "env": {
    // 网页版策略 JSON，界面会公开读回
    "JSLB_WEB_CONFIG": "{\"requireLicense\":true,\"trialPreset\":\"low\",\"trialMaxFileBytes\":524288,\"trialRunsPerDay\":10}"
  },
  "functions": {
    "api/obfuscate.js": { "maxDuration": 300 },  // 与 src/host-limits.js 的 functionMaxSeconds 一致
    "api/license.js":   { "maxDuration": 60 },
    "api/machine.js":   { "maxDuration": 30 },
    "api/free-key.js":  { "maxDuration": 30 },
    "api/plans.js":     { "maxDuration": 30 },
    "api/health.js":    { "maxDuration": 30 }
  }
}
```

**Vercel 按文件建函数**，所以 `api/` 下每个路由一个文件，内容都只是一行转发
（`export { POST, OPTIONS } from '../vercel/entry.js'`）。真正的逻辑在
`vercel/entry.js`：它把请求交给平台无关的 `server/handler.js`，再按免费档的约束加工
一遍（上传预检、每日 CPU 预算、回执护栏与流式回传、health 上报宿主信息）。

---

## 3. 云存储（授权与用量持久化）

**必做**。Vercel 的函数是无状态的：同一份许可证记录下一秒可能落到另一个实例上。
没有云存储时记录与计数只在单实例内存里活着，表现是"刚激活又提示未激活"、
"每天次数怎么刷新都在涨"。

项目认两种 Redis 接法（都在 `vercel/store.js` 里自动判断，**不需要手抄变量**）：

**A. Upstash 的 REST 接口**（一行 fetch，最省事）

1. Vercel 项目 → Marketplace → 装 **Upstash for Redis**（免费档对授权与计数绰绰有余）；
2. 装完自动注入下面这四个名字里的**任意一对**：

   | 变量 | 用途 |
   | --- | --- |
   | `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Upstash Vercel 集成注入的一对 |
   | `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Upstash 控制台给的一对 |

**B. Vercel 官方 Redis**（Redis Cloud，只注入一个 `REDIS_URL`）

它没有 REST 接口，只有标准 Redis 协议连接串。官方示例是 `npm install redis`，而本项目
把零依赖当硬要求，所以自带一个极小的 RESP 客户端（`vercel/redis-tcp.js`，只用
`node:net` / `node:tls`，~200 行）：

1. Marketplace → 装 **Redis**（免费档每账号一个库，30 MB、100 ops/s、无持久化）；
2. 装完注入 `REDIS_URL`（形如 `redis://default:<密码>@xxx.db.redis.io:10944`），直接可用。

   注意两点实测结论：`rediss://` 的连接串**只走 TLS，握手失败就判失败**，不会偷偷改走
   明文；而本部署的 `redis://…:10944` 是**明文端口**（同一端口发 TLS 握手会被回
   `WRONG_VERSION_NUMBER`），密码在公网上是明文传输的。若在意这一点，用 A 方案或换
   托管方提供 `rediss://` 的实例。

3. 验证：`curl -s https://<你的域名>/api/health`，看 `store` 字段。

```jsonc
{
  "store": "redis",           // redis = 走 REDIS_URL；upstash = 走 REST；memory = 没配
  "storeNote": "…",           // memory 时这里会写明"不跨实例持久化，请每次请求带卡密"
  "budget": { "used": 12, "total": 300, "persistent": true }
}
```

`memory` 不算故障，但多实例下授权会时有时无，先把 Redis 装上再对外公布。

---

## 4. 卡密密钥（对称，可选覆盖）

`src/license-secret.js` 的 `B64_CODE_KEY` 随源码分发（浏览器本地验卡要用），因此它
**不是秘密**——拿到源码的人能自己造卡。真正的强制在服务端：`/api/obfuscate` 逐请求
校验 + 云存储里的赎回登记（一卡一机），再加上**云端执行构建压根不下发混淆核心**。

想换一把不进 git 的密钥（离线/私有部署场景）：

```bash
node tools/issue/keyrotate.js --write        # 生成新密钥并重算自身摘要表
# 然后在 Vercel 项目设置里加环境变量 JSLB_CODE_KEY（base64，32 字节）
```

换密钥等于换发卡权：所有旧卡密与所有 license 记录立即失效。浏览器端仍用内置值，
两端不一致时**以服务端为准**。


---

## 5. 发卡

```bash
JSLB_CODE_KEY=<base64 密钥> node tools/issue/keygen.js --plan plus --days 365
```

套餐定义在 `src/plans.js`，配额**由部署宿主的免费档硬约束反推**（`src/host-limits.js`），
改动配额时必须同时确认宿主包络跟得上——`src/plan.js` 在加载期会断言，不一致直接抛错。

---

## 5.5 定价页与购买订单（2026-10-11）

定价页在界面顶部条「套餐定价」，价格数据源是 `src/pricing.js`：**改价只改 `PRICES` 一处**
（金额单位是分）。收款码图片在 `web/assets/pay-wechat.png`，替换该文件即可换成自己的码；
也可以配 `JSLB_PAY_QR` 指向别的路径。

**收款方式与"购买验证"的关系（重要）**：个人微信收款码**没有商户回调**，也没有订单查询
接口，所以默认形态是"买家提交交易单号 → 你核验 → 服务端发卡"。核验发卡有两条路：

```bash
# 路 1：走已部署的管理接口（不需要 Redis 凭据，适合在任意机器上核单）
JSLB_ADMIN_URL=https://<站点> JSLB_ADMIN_TOKEN=<令牌> \
  node tools/issue/orders.js list --status claimed
JSLB_ADMIN_URL=https://<站点> JSLB_ADMIN_TOKEN=<令牌> \
  node tools/issue/orders.js confirm <订单号> --txid <交易单号> --amount <分>

# 路 2：直连云存储（手里有 Upstash/REDIS_URL 时，连站点都不用开）
node tools/issue/orders.js list --kv
node tools/issue/orders.js confirm <订单号> --amount 29900 --kv
```

买家随后在定价页凭**订单号 + 查询码**自助取卡（查询码只在建单响应里出现一次，页面提示
截图保存）。查询码在 KV 里只存 sha256；交易单号全局唯一（防一张截图领多次卡）。

想改成**自动发卡**：接一个能拿到支付回调的通道（微信支付商户号 / 服务商 / 自建对账脚本），
然后：

1. 在 Vercel 环境变量里加 `JSLB_PAY_WEBHOOK_SECRET=<随机密钥>`（**机密**，验签用）；
   再开 `JSLB_PAY_AUTO=1` 显式声明"已接入自动回调"；
2. 让回调方以 `POST /api/pay-notify` 通知，正文 JSON 至少含 `orderId`、`txid`、`amount`（分），
   头 `X-JSLB-Signature: <hex(HMAC-SHA256(密钥, 原始请求体))>`；
3. 定价页会自动把提示文案从"人工核验"换成"通常几秒内自动发卡"（读 `/api/pricing` 的 `pay.auto`）。

> `pay.auto` **只认 `JSLB_PAY_AUTO`**，不认"配没配密钥"：密钥只是验签材料，端点不会自己
> 收到通知。只配密钥而没开开关时，文案保持"人工核验"——个人收款码就是这条默认路。

> 签名必须对**原始请求体**计算。先 JSON.parse 再 JSON.stringify 会因键序/空白变化导致
> 签名失配，而那种失败看起来像"密钥配错了"。

需要开放管理接口时再加 `JSLB_ADMIN_TOKEN=<随机令牌>`（**机密**）：不配时
`/api/admin-order` 恒返回 403，配了才启用。可选文案项：`JSLB_PAY_PAYEE`（收款方显示名）、
`JSLB_PAY_CONTACT`（客服联系方式）。

订单必须落在云存储里（见第 3 节）：`/api/order` 在没有 KV 时直接返回 503 而不是"建一张
活不过一个实例的单"——买家付了钱查不到单，比暂时不能下单糟得多。

---

## 6. 发布

**发布 = push 到 `main`，不需要手动部署**（2026-10-11 定）。仓库已绑定 GitHub，
Vercel 集成在 push 时自动构建并上线：

```bash
npm test                        # 改动核心后必跑（约 15 分钟）
npm run selfdigest:check        # 改了 plan.js / plans.js / license-* 之后必跑
git push origin main            # 推上去即自动部署（不要再跑 npx vercel --prod / npm run deploy）
```

产物由流水线自己构建：`vercel.json` 的 `buildCommand` 是 `npm run build:web:cloud`、
`outputDirectory` 是 `dist`，`dist/` 已 gitignore、不入库——**本地不需要为部署预生成
`dist/`**，手动跑 `npx vercel --prod` 只会绕过 GitHub 集成。

首次关联项目（只做一次）用 `npx vercel link`；`npx vercel login` 是本地 CLI 登录，
与自动部署无关。

发布**不等于生效**——2026-09-19 踩过：配置里 `requireLicense: true` 写着，部署输出
也把那条列进了环境变量，线上 `/api/plans` 返回的却是代码默认值 `false`，站点一直在
无卡密自由试用，部署过程毫无异常。所以每次发布后必须打探针：

```bash
npm run verify -- https://<你的域名>
```

它一次打完这几项（都不消耗配额，用随机设备码且期望被拒）：

1. `/api/health` 活着，`runtime=vercel` / `engine=vercel-functions` / `host=vercel-hobby`，
   版本与本地 `src/version.js` 一致；
2. `/api/plans` 档位数与本地一致、`web.requireLicense` 与预期一致，且**逐档**比对预设
   上限、配额、族与关闭项；`web.*` 与 `vercel.json` 的 `env.JSLB_WEB_CONFIG` 逐键一致；
   `web.cloudOnly === true`；
3. 无卡密 `POST /api/obfuscate` 被拒（默认期望 `402`）；
4. `/api/machine` 路由在（非法卡密 400、GET 405）；
   `/api/free-key` 路由在（缺机器码 400、GET 405；`requireLicense=true` 的部署上它给匿名机器发 7 天 Free 卡，属预期行为）；
5. **混淆核心不在静态产物里**：`/src/index.js` 等一律 404，而公开模块仍 200，
   且首页带 `jslabyrinth-cloud` 标记。

任一项不过就别对外公布。排查顺序：① 确认域名指向的是哪个 Vercel 项目
（`npx vercel ls` / 项目设置里的域名）② 改一个醒目的值（如 `trialRunsPerDay: 7`）
重新发布，看 `/api/plans` 会不会跟着变 ③ 若不变，说明发布的不是同一个服务。

---

## 7. 免费档包络与常见报错

`src/host-limits.js` 是这套数字的唯一来源，按 Vercel Hobby 的硬约束定：

| 约束 | 数值 | 表现 |
| --- | --- | --- |
| 函数请求体上限 | 4.5 MB | 超了平台直接 413 `FUNCTION_PAYLOAD_TOO_LARGE`；入口预检会先回一句可读的 413 |
| 单次上传上限 | 2 MiB（`JSLB_MAX_UPLOAD_BYTES`） | 入口预检回 413 + 建议拆分 |
| 每日 CPU 预算 | 500 s（`JSLB_DAILY_CPU_SECONDS`） | 用尽即 503（`hostBudgetExhausted`），明日恢复 |
| 单次回执上限 | 64 MiB（`JSLB_MAX_RESPONSE_BYTES`） | 超过回 413；正常回执走**流式**，不受 4.5 MB 限制 |
| 函数时长 | Hobby 硬上限 300 s | `vercel.json` 的 `maxDuration: 300` 与 `src/host-limits.js` 的 `functionMaxSeconds` 必须一致；单任务 CPU 预算留 60 s 余量（`perRunCpuSeconds: 240`） |

常见现象与原因：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 点运行报一句 import 404 | 构建没走 `--cloud`，但 `/api/plans` 又说 `cloudOnly=true`（或反之） | `vercel.json` 的 `buildCommand` 必须是 `npm run build:web:cloud`；改完 push（自动重新部署） |
| 未激活界面连激活表单都渲染不出 | 公开模块没下发（挡多了） | 跑 `npm run verify`，第 5 项会指出取不到的模块 |
| 刚激活又提示未激活 | 没装 Redis（`store: memory`） | 第 3 节 |
| 每天次数怎么刷新都在涨 | 同上 | 同上 |
| `FUNCTION_PAYLOAD_TOO_LARGE` | 输入太大 | 拆小输入或降预设 |
| 503 `hostBudgetExhausted` | 当日全网 CPU 预算用尽 | 等明日，或调高 `JSLB_DAILY_CPU_SECONDS` |
| `store: memory` 且授权时有时无 | Upstash 环境变量没注入到函数运行时 | 确认变量在 **Production** 分组下，而不是只在 Preview |

---

## 8. 本地开发

```bash
npm run build:web:cloud        # 产出 dist/（云端执行形态）
npx vercel dev                 # 本地起 Vercel 运行时：静态资源 + /api/*，与线上同构
```

`vercel dev` 会读 `vercel.json`，本地缺 Upstash 时 `/api/health` 报 `store: memory`，
属正常。只想看界面与本地混淆（不需要服务端）时：

```bash
npm run build:web              # 浏览器内执行形态：核心进 dist
npx serve dist                 # 任意静态服务器即可
```

---

## 9. 相关文件

```
vercel.json          构建命令、区域、环境变量、函数时长、缓存头
api/*.js             六个路由各一个文件（一行转发，Vercel 按文件建函数）
vercel/entry.js      共用入口：预检 / 预算记账 / 流式回执 / health 上报
vercel/store.js      云存储适配（Upstash REST / REDIS_URL / 没配退化为单实例内存）
vercel/redis-tcp.js  零依赖 RESP 客户端（REDIS_URL 那条路走它）
server/handler.js    平台无关的 /api/* 实现（授权判定、混淆执行、机器码签发、Free 卡派发）
src/host-limits.js   宿主包络（免费档硬约束反推出的配额上限）
tools/build/         构建与发布验证（build-web.js、gate-policy.js、verify-deploy.js）
```

自测里的线上验收段需要显式给目标站点：

```bash
JSLB_LIVE_ORIGIN=https://<你的域名> npm test     # 或 JSLB_SKIP_LIVE=1 纯离线跑
```
