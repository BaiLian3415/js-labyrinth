# JsLabyrinth

JavaScript 混淆器，**完全运行在 Cloudflare 上**。核心混淆逻辑跑在浏览器或 Worker
里，项目不依赖任何本地服务、不需要本地 hosts 映射、也没有 Node 端运行时入口。

| 场景 | 入口 | 说明 |
| --- | --- | --- |
| 网页界面（浏览器内执行） | `web/`（构建到 `dist/`） | 用访问者自己的 CPU，代码不出本机，无服务端 CPU 时限 |
| Cloudflare Worker / Pages | `worker/index.js`、`functions/api/[[path]].js` | 静态界面 + JSON API，绑 KV 做跨请求计数 |

混淆核心（`src/obfuscate.js` 及其依赖：AST 解析器、生成器、二十个 pass、许可证编解码）不引用任何
Node 内建模块，因此浏览器与 Worker 加载的是同一份代码、同一套选项表、同一套套餐闸门。

`src/` 与 `web/`、`worker/` 里**没有一行 `node:` 引用**，两者都是纯粹的 Web 标准代码。
`tools/` 下的脚本（发卡、自测、构建）是给维护者在本地用的开发工具，不属于运行时。

## 快速开始

```bash
# 1) 自测（末段会打线上域名做验收；纯离线跑用 JSLB_SKIP_LIVE=1）
npm test

# 2) 构建静态产物（界面 + 核心；核心默认自混淆，见下）
npm run build:web

# 3) 预览与调试：一律走 Cloudflare，本地不起任何服务器
npx wrangler dev         # 本地 workerd：静态资源 + /api/*，与线上同构
npx wrangler deploy      # 发布到线上，浏览器打开线上域名
```

`build:web` 会用**项目自己的混淆器**把 `src/**` 跑一遍再写进 `dist/`（体积约 1.3 倍、
运行期约 1.6 倍，种子固定所以产物可复现），抬高已激活用户的逆向成本。产物仍是合法 ESM——
混淆器保留 import/export 绑定与文件路径，所以逐文件混淆不破坏跨文件引用。

**配置不是 low 预设**：直接套 low 会让混淆后的核心慢 70 倍（浏览器里 20 KB 文件要等
8 秒）。逐项实测后采用"low + 关闭运行期昂贵 pass"的组合，实测表见
`tools/build/build-web.js` 的 `selfObfOptions`。想更硬可以往上加 pass，代价明码标价。

调试线上问题时用 `npm run build:web -- --plain` 退回逐字节复制。详见 `DEPLOY.md` 4.5。

## 激活

在网页界面里填入卡密即可。卡密由发布方用 `node tools/issue/keygen.js` 签发，
用户在界面上能看到自己的**机器码**，把它交给发布方用于 `--bind` 绑定。
（签发工具是维护者本地用的开发工具，不是运行时组件。）

## 部署到 Cloudflare

```bash
npm run build:web            # 产出 dist/：界面 + 自混淆后的核心（--plain 可退回纯复制）
npx wrangler dev             # 本地起 workerd（静态资源 + /api/*），与线上一致
npx wrangler deploy          # Workers：静态资源与 API 同域

# 或者当 Pages 项目发布（静态界面 + functions/ 里的 API）
npx wrangler pages deploy dist
```

### 发布后必须验证

```bash
npm run verify                       # 默认验自定义域名
node tools/build/verify-deploy.js https://你的域名/
```

**配置写了、部署没报错，不等于生效。** 2026-09-19 就踩过这个坑：`wrangler.toml` 里
`JSLB_WEB_CONFIG` 明确写着 `requireLicense: true`，`wrangler deploy` 也把这条列进了
bindings，但线上 `/api/plans` 返回的是代码里的默认值 `false`——**站点一直在无卡密
自由使用的试用模式**，而部署输出没有任何异常。

所以发布后固定打这三个探针（都不消耗配额，用的是随机设备码且期望被拒）：

1. `/api/health` 活着，`runtime` 为 `worker`
2. `/api/plans` 的档位数与本地一致、`web.requireLicense` 与预期一致，并且**逐档
   比对**预设上限、各项配额与关闭项
3. 无卡密 `POST /api/obfuscate` 被拒（默认期望 `402`）

第 2 项的逐档比对是为了防"部署的不是这份代码"：改了 `plans.js` 而忘记重新发布
（或发布到了别的服务）时，档位数常常还是一样的，只有逐字段比对才看得出。

任一项不过就别对外公布。排查顺序：① 确认域名指向的是哪个 Worker
（`npx wrangler deployments list`）② 改一个醒目的值（如 `trialRunsPerDay: 7`）
重新发布，看 `/api/plans` 会不会跟着变 ③ 若不变，说明发布的不是同一个服务。

`wrangler.toml` 里已配好 `[assets] directory = "./dist"`、`binding = "ASSETS"` 与
`run_worker_first = ["/api/*"]`。最后一项不能省：`compatibility_date` 在 `2025-04-01`
及以后时，浏览器地址栏直接打开 `/api/health`（导航请求，带 `Sec-Fetch-Mode: navigate`）
会优先走静态资源，而 `dist/` 里没有这个文件，于是返回 404 页面而不是 JSON。界面里的
`fetch` 属于 cors 请求，本来就会命中 Worker，所以不加也能跑——只是直接访问接口会莫名 404。

Pages 侧的函数在 `functions/api/[[path]].js`，与 Worker 共用同一份处理逻辑。

完整部署流程（平台选型依据、Secrets 注入、自定义域名、常见报错排查）见
[`DEPLOY.md`](DEPLOY.md)；本地环境变量模板见 `.env.example`。

### Worker 是无状态的

未绑 KV 时，Worker 不保留任何跨请求的东西：许可证记录、试用计数都是逐请求即弃，
`state`、设备码缓存、内存存储都在每个请求开头重置。这既是安全要求（一个 isolate 会
连续处理互不相干的请求，共用模块级状态会把 A 的授权泄漏给 B），也决定了调用方式——
**每次请求都要带上卡密**（`X-JSLB-Key` 或请求体 `key`）与设备码（`X-JSLB-Device`），
否则请求按试用档处理。绑定 KV（`JSLB_KV`）后记录按设备码分键持久化，计数才真正
跨请求、跨 isolate 生效。

设备码（`X-JSLB-Device`）由客户端随机生成并持久化，只用于 KV 按设备分键；**机器码已改由
设备特征派生，不再依赖它**，所以清掉浏览器存储不会让已激活的卡失效。反过来，设备码本身
仍是客户端提供的，清掉它只能重置**试用计数**——配额是"防误用"级别的，不是防作弊级别的。

### 运行限制

- **免费版 CPU 预算只有 10 ms**，稍大的输入会直接超时（错误 1102）。这条只约束
  `/api/obfuscate`：界面把混淆放在浏览器内（用户自己的 CPU，代码不出本机），不受
  影响。要放开 API 的预算，改用付费版并把 `limits.cpu_ms` 调高。
- **不能即时编译 Wasm**。workerd 出于安全只允许静态导入 `.wasm`，而混淆管线在构建期
  会用真实 wasm 引擎跑一遍 `wasm` 档的自检。自检因此改成了能力探测：宿主不支持就跳过，
  产物照常产出（`src/passes/wasm.js` 的 `wasmCompilable()`）。跳过只影响自检，产物字节
  与支持编译的宿主完全一致，`medium`/`high`/`max` 三个开了 `wasm` 的预设都能在 Worker 上跑。
- **核心模块图里不能有字符串代码生成**。Cloudflare 禁用 `eval` 与 `new Function`，
  上传时直接报 `EvalError: Code generation from strings disallowed`，整个 Worker 发不出去。
  `src/passes/shell.js` 原先用 `(0, eval)(PRIMITIVES)` 保证"产物文本与构建期实现不漂移"，
  已改成手写等价实现，比对挪进 `tools/test/selftest.js`（那里不随 Worker 上传）。
  自测里有一条守卫会拦住回退，改核心时别引入 `eval`/`new Function`。
  注意产物**里面**的 `(0,eval)` 是给宿主跑的引导器，不受这条限制。


## Worker API

> **网页界面不使用这一节**：界面把混淆完全留在浏览器内（见上）。下面的接口是给
> **程序化调用**准备的，同时也承担界面的授权与策略下发。

```bash
curl -s https://<host>/api/health
curl -s https://<host>/api/plans

curl -s -X POST https://<host>/api/obfuscate \
  -H 'content-type: application/json' \
  -H 'X-JSLB-Key: JSLB-...' \
  -H 'X-JSLB-Device: 0123456789abcdef0123456789abcdef' \
  -d '{"code":"console.log(1)","options":{"preset":"medium","seed":42}}'
```

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/api/health` | GET | 版本与运行环境 |
| `/api/plans` | GET | 套餐对照表与网页版策略（公开信息） |
| `/api/license` | GET / POST | 查询当前授权；POST `{key}` 激活 |
| `/api/obfuscate` | POST | `{code, options?, type?}` → `{code, stats, originalSize, obfuscatedSize, quota}`。**供程序调用**，界面不使用它（见"混淆只在浏览器内跑"） |

响应状态码：`400` 非法请求体/选项、`401` 卡密无效、`402` 未激活且要求激活、
`403` 选项被套餐闸门拦下、`413` 超出单文件限额、`422` 混淆失败、`429` 今日次数用尽。

## 选项

选项表在 `src/options-meta.js`：一处定义，网页界面控件与套餐闸门都从它生成。
新增一个选项只要在那里加一行，界面立刻出现控件、套餐闸门按同一个键判定。

界面上的每个选项控件直接对应 `src/options-meta.js` 里的一行；悬停可看到取值说明。
预设只提供默认值：同一次运行里显式改动的选项逐字段覆盖它——**只有被改动过的控件
才作为"显式选项"提交**，因此默认值不会莫名其妙触发套餐闸门。

`node tools/issue/keygen.js --plans` 可打印完整的选项与套餐对照表。

## 五类防护能力落在哪里

新增或调试某一类能力时，先知道它由哪些 pass 承担：

| 类别 | 承担者 | 要点 |
| --- | --- | --- |
| 多态混淆 | 全局 PRNG（`utils/rand.js`）+ `controlFlow` 滚动重键 + `stringArray` 运行期演化 | 固定 seed 逐字节复现，换 seed 后标识符集合与结构都变；扁平化状态机的状态值每次分派滚动异或重键（`--no-control-flow-rolling-key` 可关），字符串池槽位按会话熵演化，同一份产物每次运行的密文快照不同 |
| 代码变换 | `vm` / `wasm` / `controlFlow` / `objectKeys` / `templateToConcat` / `numberObf` / `logicalExpr` / `conditionObf` / `deadCode` / `opaquePredicates` / `functionWrapper` / `callProxy` / `mangle` | `numberObf` 把整数字面量改写成取值恒等的算术/位运算表达式（`--number-obfuscation-threshold` 控制命中率） |
| 反调试 | `debugProtection` + `envFingerprint` | 三类检测：环境侧信号（尺寸/时差/栈形态）、内建函数"原生文本"、内建函数"对象身份"（Function、defineProperty、getOwnPropertyDescriptor、call、eval 在头部快照后运行期比对），外加描述符 canary；命中走隐蔽断点 → 有界拖慢 → 确认投毒三级响应 |
| 自防御 | `stringArray` 自检 + `integrityCheck` | 装配期全池校验和 fail-closed，访问期再按抽样门重算旋转后的校验和（动态 xor 组查"密文与明文等长"不变式）；`integrityCheck` 对根级函数声明做 64 位双通道哈希，失配只置毒药标志 |
| 运行时保护 | `integrityCheck` / `vm` / `wasm` / `shell` / `rtlib` | 装载时的原生性探针（内建成员被换钩子即投毒）、入口交叉校验带一次性闩锁、外壳算术依赖式防篡改、原生调用收敛进 RT 内核 |

`integrityCheck` 的校验面分两批走：根级**函数声明**进头部校验循环（装载最早期，那时
只有函数声明已提升）；字符串池**访问器**走延迟校验——单独一块插在最后一条访问器
声明之后，那时函数已就位。改一处解码器文本即失配投毒，实测往解码器函数体里插一条
无害的 `0;` 就会被抓到。

限制：访问器声明若被 vm / wasm 搬进嵌套函数体（高档预设常见），这一处就放弃覆盖——
那种体往往还被 wasm 的特征匹配依赖，硬插进去会失配。宁可少覆盖一处，也不拿假失配
投毒去换覆盖率。

## 授权

套餐（`src/plans.js`）决定可用的选项范围、强度上限与配额，由卡密携带，命令行与界面都改不了。

订阅档（额度按自然日重置）:

| 档位 | 卡密字符 | 预设上限 | 单文件 | 每任务文件 | 每日次数 |
| --- | --- | --- | --- | --- | --- |
| Free | `F` | low | 128 KB | 1 | 3 |
| Plus | `P` | high | 4 MB | 5 | 20 |
| Team | `T` | max | 7 MB | 10 | 200 |
| Business | `B` | max | 10 MB | 10 | 1000 |

一次性额度包（**买断总次数，用完为止**，不按日重置；卡密自带的到期时间仍是硬上限）:

| 档位 | 卡密字符 | 预设上限 | 单文件 | 每任务文件 | 总额度 |
| --- | --- | --- | --- | --- | --- |
| Pack 100 | `S` | max | 10 MB | 10 | 100 次 |
| Pack 1000 | `M` | max | 10 MB | 10 | 1000 次 |
| Pack 10000 | `W` | max | 10 MB | 10 | 10000 次 |
| Pack Custom | `C` | max | 10 MB | 10 | 联系作者 |

额度包的能力跟随 Business（`max` 预设、无闸门），买的是次数而不是能力：适合不想
续费、只需要跑一批的场景。用尽后不会恢复，需要再买一张。

Plus 的预设上限是 `high`，闸门正好卡在 `high` 预设的取值上（能用整套 high，但不能把
单项往上调），只关掉 `consoleStub` 一个开关；Free 则关掉十二个。Team 与 Business 同为
`max` 且都不设闸门，差别只剩配额（7 MB / 200 次 对 10 MB / 1000 次）。

> **2026-09-22 删除 Pro 档**：原 Pro 的预设上限是 `medium`，夹在 Plus(medium) 与
> Team(high) 之间，删掉之后 Plus 提到 `high`、Team 提到 `max`，阶梯变为
> Free(low) < Plus(high) < Team(max) = Business(max)。
> **已签发的 Pro 卡密（套餐字符 `R`）随之全部作废**——`parseCode` 再也查不到 `R`
> 对应的档位，直接以 `reason:"plan"` 拒绝，需要重新签发。

订阅档与额度包**不排在同一条阶梯上**：两者的配额口径不同（一个按日、一个按总额），
`src/plan.js` 的档位阶梯不变式因此只在同族内比较。

`node tools/issue/keygen.js --plans` 随时打印这份对照表。
加档位时注意两条：**闸门缺省一律放行**（`undefined` 返回 `true`），关掉某个开关必须
逐项写 `false`；且**套餐自带的预设必须满足自己的每一条闸门**——`src/plan.js` 的
`assertConsistent()` 在模块加载时就会拦下不合规的定义，所以数值闸门不能比自带预设
更紧。**升预设上限时尤其注意**：闸门必须放行该预设的每一个取值，没有中间地带
（例如把上限提到 `medium`，就必须同时放行 `wasm`、`debugProtection`、`selfDefending`、
`integrityCheck`、`shell`、`stringArrayMixedEncoding` 这些 medium 用到的开关）。
2026-09-22 把 Plus 提到 `high` 时就踩过一次：`high` 会打开 `envFingerprint`，而旧的
Plus 闸门把它显式关着，改上限却忘了动那一条，加载期直接被 `assertConsistent()` 拦下——
**升上限必须逐条比对目标预设的取值，开关项（true/false）比数值项更容易漏**。
自测里有一条不变式：**低档的每一条闸门都不得超过高档**。

**两层机器绑定，卡密那层才是边界。** 卡密里带一段机器码的派生摘要（绑定段，16 字符
base32），它在 Ed25519 签名载荷内，所以"这张卡属于哪台机器"在**签发时就定死了**：拿到
别人的卡密到自己机器上激活一定失败，且**卡密上看不出机器码本身**（只有不可逆的 HMAC
摘要）。绑定的卡用 `--bind <机器码>` 签发，省略则是不绑定的通用卡（绑定段全 0，任何
机器都能激活，供企业批量与内部测试）。

本地记录里另有一份机器码与 HMAC 令牌，防的是把许可证记录直接拷到另一台机器——那一层
的密钥派生自公钥、是公开的，只留下篡改痕迹，**不是**安全边界。

- **网页/Worker**：浏览器里**没有**可靠的唯一硬件标识，机器码只能由**设备特征**派生
  （平台、CPU 核心数、屏幕尺寸与像素比、GPU 渲染器、时区、语言；不含任何随机量）。因此
  这是**设备特征绑定**，比硬件指纹弱一档——**同型号同配置的两台机器会算出同一个
  机器码，可以共用一张卡**。这是浏览器沙箱的物理上限，不是实现偷懒。
  好处是清掉站点数据、换浏览器、进隐私模式都**不会**换机器码，已激活的卡不会因此失效。
  用户在界面「机器码」一栏能看到自己的码，把它交给发布方用于 `--bind`。
  设备特征算法（字段集合或其顺序）一变，所有已签发的卡都会失效——改动前务必确认。

> **签发时的机器码来源**：请以**网页界面显示的那个码**为准。
> `keygen.js --machine` 打印的是本机 Node 环境的指纹（平台/主机名/网卡 MAC 等），
> 与浏览器算出的码**本来就不同**，只适合开发调试，不要拿它当用户的码去 `--bind`。

> **卡密格式 v4**：`JSLB-<套餐1>-<天数2>-<签发日3>-<编号8>-<绑定16>-<签名103>`，共 143 字符。
> 比 v3 多了绑定段，编号段同时由 24 字符压到 8 字符（40 bit，约 1.1 万亿个编号）。
> **v3 及更早的卡密在新版本上一律作废**，必须用新私钥重新签发（与 2026-09-20 换 Ed25519
> 那次的代价同类）。

### 让网页版必须激活

未激活时的行为由网页版策略 `JSLB_WEB_CONFIG` 决定，把 `requireLicense` 设为 `true`
即要求先激活，未激活一律拒绝（API 返回 `402`，界面直接提示失败）：

```toml
[vars]
JSLB_WEB_CONFIG = '{"requireLicense":true,"trialPreset":"low","trialMaxFileBytes":524288,"trialRunsPerDay":10}'
```

`trialRunsPerDay` 默认是 **10 次/天**（`src/platform.js` 的 `DEFAULT_WEB_CONFIG`）。
试用完全不限次数等于把它当成免费正式版，既没有激活动机也没有"试用"的样子；要放开
把它设回 `0`。

界面启动时会从 `/api/plans` 读回这份策略并套用，因此服务端要求激活时界面不会按
"允许试用"放行——两端判断始终一致。

部署方需要注意的边界：静态站点会把核心一起发给访问者。但**卡密是 Ed25519 签名的，
私钥只在签发方**，所以拿到全部源码也**签不出新卡密**——这是非对称签名拿到的性质，
也是"源码公开"这件事不再致命的原因。要再进一步让验签发生在服务端，部署 Worker
并用自己的密钥对即可（混淆仍留在浏览器内，只是授权由服务端判定）：

```bash
node tools/issue/keyrotate.js --write        # 生成密钥对：公钥进源码，私钥进 .jslb-signing-key
npx wrangler secret put JSLB_PUBLIC_KEY      # 值 = 上一步打印的公钥（可选；内置公钥也能用）
```

用**自己的**密钥对时，发卡与验签才同源：

```bash
JSLB_SIGNING_KEY=<base64 私钥种子> node tools/issue/keygen.js --plan plus --days 365
```

`tools/issue/keygen.js` 因此优先读环境变量 `JSLB_SIGNING_KEY`，读不到才退回项目根的
`.jslb-signing-key`（该文件在 `.gitignore` 里）。两处都没有时**明确报错**，不会签出
一张验不过的卡。

### 三个签发工具的分工

容易混，先说清楚：

| 工具 | 干什么 | 会不会动文件 |
| --- | --- | --- |
| `tools/issue/signingkey.js` | 生成**签名密钥对**，当场做签验往返自检 | 默认只打印；`--out <dir>` 才落盘 |
| `tools/issue/keyrotate.js` | **轮换**签名密钥对 | **会覆盖** `src/license-secret.js` 与 `.jslb-signing-key`，旧卡全部作废 |
| `tools/issue/keygen.js` | 用私钥**签发卡密**（`JSLB-...`） | 只写编号计数器与 `--ledger` 指定的台账 |

```bash
# 1) 生成密钥对（默认不碰任何文件，公钥私钥都打印出来）
npm run signingkey
npm run signingkey -- --out ./keys          # 落盘到 ./keys（已存在则拒绝覆盖，除非 --force）
npm run signingkey -- --seed <base64>       # 由种子确定性重建，用于恢复
npm run signingkey -- --check <公钥>        # 只校验公钥格式并打印指纹

# 2) 发卡
npm run keygen -- --plan plus --days 365 --count 5          # 5 张，逐行裸卡密（便于脚本）
npm run keygen -- --plan team --days 365 --count 3 --table # 对齐表格
npm run keygen -- --plan plus --count 100 --csv > batch.csv # CSV 导出
npm run keygen -- --plan plus --count 10 --ledger issued.csv  # 追加进台账
npm run keygen -- --plan plus --days 30 --date 2026-01-01   # 指定签发日（补发历史卡）
npm run keygen -- --check <卡密>                            # 校验一张卡

# 3) 绑定机器发卡（两步：先让用户报机器码，再签）
npm run keygen -- --machine                                # 在用户机器上跑，读出机器码
npm run keygen -- --plan plus --days 365 --bind <机器码>     # 本机签卡，只有那台机器能激活
npm run keygen -- --plan plus --days 365                    # 省略 --bind = 不绑定，通用卡
```

**`--date` 值得单独说**：签发日进卡密签名载荷，到期时间由"签发日 + 天数"推出。所以补发
一张标着 2026-01-01 的 30 天卡，有效期就是 2026-01-31，而不是"今天 + 30 天"。这是为了让
到期时间无法在本地被挪动（见 `src/license-core.js` 的 `expiryFromIssueDay`）。

**`--bind` 也别漏掉**：机器码由用户从界面"机器码"一栏读取（或在自己机器上跑 `--machine`）
报给签发方。卡密里存的是它的 HMAC 摘要，**看不出机器码本身**；但摘要在签名载荷内，所以
改一个字符就验签失败——**拿别人的卡密改到自己机器上是不可能的**。

`--bind` 只校验**格式**（24 个 Crockford base32 字符），不校验"这段文字是不是真的机器码"
——签发方无法反推。所以别把 `--check` 打印的绑定段当机器码再喂给 `--bind`：绑定段也是 16
个合法字符长度的 base32（长度不同，会被当场拒掉），但机器码与绑定段**都是 24 字符**的
base32，格式校验分不出来。喂错了只会摘两次摘要，签出一张**任何机器都激活不了**的卡，而
`--bind` 不会报错。核对方式：把机器码再跑一次 `--machine`，与对方报来的那串逐字符比。

**编号段只有 40 bit**（8 个 base32 字符，上限 1099511627775）。不显式给 `--id` 时由
`.keygen-state.json` 计数器分配，首次签发以当前毫秒时间戳**取模编号段跨度**为起点；计数器
一旦写出就不再受时间戳影响，逐次递增。若计数器被删后重新分配，新起点可能落在历史编号区间
内——需要严格保证编号不重复，就在调用方自己维护计数并用 `--id` 显式指定。

用自己的密钥对之后，浏览器手里那把内置公钥永远验不过卡密，所以界面做了两条配合：

- **激活交给服务端**。点"激活"先本地验签，验不过就把卡密 POST 给 `/api/license`，
  由 Worker 用它的公钥验。成功后授权记在服务端（绑 KV 时按设备码分键），
  之后每次请求只带设备码即可恢复。
- **策略与服务端对齐**。界面启动时从 `/api/plans` 读回网页版策略，因此服务端把
  `requireLicense` 设成 `true`，界面也会同步要求激活，不会一边拒绝一边放行。

### 混淆只在浏览器内跑

界面**没有**"服务端执行"这个选项，混淆一律在浏览器内完成：用访问者的 CPU，
代码不出本机，也不受服务端 CPU 限额约束。服务端只负责两件事——授权（`/api/license`）
与下发策略（`/api/plans`）。

这么定是因为代价不对称：免费版 Worker 单请求只有 **10 ms CPU**，实测 medium 预设
只能跑 4 KB 以内的输入，8 KB 就 `1102` 超限；而浏览器内执行没有这个天花板。
代价是本地运行服务端统计不到，因此服务端配额只对"激活/策略"这类请求有意义，
`runsPerDay` 这类配额实际上管不到浏览器内的混淆次数。

技术上没有障碍：核心的 `runJob` 只吃一个权益对象、**不再自己验签**，所以服务端
认定的授权同样能驱动本地执行——这正是能去掉服务端执行路径的前提。

界面在授权来自服务端时会提示本地运行不计数，免得配额对不上时莫名其妙。

未配置 secret 时用内置常量，方便自托管与本地开发。未激活时的行为由网页版策略决定
（`JSLB_WEB_CONFIG`，见下），默认允许试用：上限 `low` 预设、单文件 512 KB、
**每日 10 次**。把 `requireLicense` 设为 `true` 即要求先激活。

### 解除激活

界面上的"解除激活"同时清两端：本机的许可证记录，以及**服务端按设备码存的那一份**。

服务端那份必须带 `X-JSLB-Device` 才能删对——设备码进 KV 键名，缺了它服务端删的是
无后缀的共享键，这台设备的记录原封不动，刷新后授权又回来了（`src/license-web.js`
的 `scopedKey`）。解除走的是真正的删除（KV `delete` / localStorage `remove`），
不是写空串。

## 环境变量

| 变量 | 作用域 | 说明 |
| --- | --- | --- |
| `JSLABYRINTH_LANG` | 全部 | 语言 `zh`/`en`（浏览器可改用 `window.JSLB_ENV`） |
| `JSLABYRINTH_KEYGEN_STATE` | 发卡工具 | 编号计数器路径 |
| `JSLABYRINTH_SIGNING_KEY_FILE` | 发卡工具 | 签发私钥文件路径（默认 `.jslb-signing-key`） |
| `JSLB_SIGNING_KEY` | 发卡工具 | **签发私钥**（base64，32 字节种子）。**机密**，泄露 = 发卡权泄露 |
| `JSLB_WEB_CONFIG` | 网页/Worker | 网页版策略 JSON |
| `JSLB_PUBLIC_KEY` | 网页/Worker | 覆盖内置签发公钥（base64，非机密） |
| `JSLB_MACHINE_SALT` | 网页/Worker | 覆盖机器码派生盐（base64，非机密） |
| `JSLB_CORS_ORIGIN` | Worker | `/api/*` 的跨域来源，默认 `*` |
| `JSLB_DEVICE_ID` | 网页/Worker | 固定设备码（仅 KV 分键与试用计数），便于测试 |
| `JSLB_LIVE_ORIGIN` | 测试 | 线上验收目标域名（默认 `https://jslb.lllm.dpdns.org`） |
| `JSLB_SKIP_LIVE` | 测试 | 设为 `1` 跳过线上验收段，纯离线跑 |
| `DSH_VM_DEBUG` | 全部 | VM 编译失败时打印原因 |

> 已随转向纯云端移除：`JSLABYRINTH_LICENSE_KEY` / `JSLABYRINTH_LICENSE_FILE` /
> `JSLABYRINTH_LICENSE_DEBUG`（Node 端许可证文件机制）、`DSH_DUMP_PASSES`
> （只被已删的 CLI 使用）。现在激活一律在网页界面完成。

## 目录结构

按用途分：`src/` 是跨环境核心，`web/` 是界面，`worker/` 是 Cloudflare 入口，
`tools/` 按用途三分。`functions/` 与 `dist/` 的位置由外部规范决定
（Pages 只从项目根读函数，wrangler 指向 dist），不参与归整。

```
src/                跨环境核心：浏览器与 Worker 共用同一份，零宿主依赖
  index.js          公共入口（库用法、网页、Worker 都从这里取能力）
  obfuscate.js      核心：pass 编排与自校验
  options.js        默认选项          options-meta.js  选项元数据（界面与闸门共用）
  presets.js        强度预设          plans.js         套餐定义
  plan.js           套餐判定          options-gate.js  套餐闸门与提示（三端共用）
  html.js           HTML 内联脚本      pipeline.js      一次任务的完整流程
  platform.js       运行环境适配层（env/随机数/存储/KV/网页版策略/设备特征）
  license-core.js   许可证校验（三端共用）  license-codec.js  卡密与令牌编解码
  license-secret.js 签发公钥与自身摘要表（**只有公钥**，私钥在库外）
  license-web.js    网页/Worker 授权（设备特征机器码、localStorage/KV、试用）
  ast/              解析器、生成器、遍历、类型、WASM 二进制发射器
  passes/           二十个 pass（vm、wasm、stringArray、controlFlow……）
  utils/            hash（纯 JS SHA-256/512、HMAC、base64）、ed25519（纯 JS 签名/验签）、
                    encode、rand、hide、ws、zip

worker/             Cloudflare Worker 入口（Pages 的 functions/ 转调它）
  index.js          无任何 node: 依赖的纯 Web 代码，wrangler.toml 的 main 指向它

web/                网页界面源码（原生 ESM，无打包器，无第三方依赖）
tools/
  build/            构建与发布验证  build-web.js、verify-deploy.js
  test/             测试          selftest.js、hashtest.js、semantics.js、bench.js（性能基准）
  issue/            发卡与密钥    keygen.js（发卡）、signingkey.js（生成密钥对）、
                                  keyrotate.js（轮换）、selfdigest.js

functions/api/      Cloudflare Pages Functions（必须留在项目根，Pages 只从这里读）
dist/               构建产物（web/ 的界面 + src/ 的核心），不随仓库分发
```

`worker/` 与 `src/`、`web/` 一样零宿主依赖——三者都是能在浏览器和 workerd 里直接跑的
Web 标准代码。构建只复制 `src/` 与 `web/`，所以不需要任何排除表。

> **已移除**：原先的 `host/` 目录（`cli.js` 命令行、`directory.js` 目录批量、
> `license-node.js` Node 端许可证）随"全面转向云端"一并删除。这些能力在
> Cloudflare Worker 里物理上不存在对应物：Worker 拿不到 `os.hostname()` 与网卡 MAC，
> 也没有 debugger 可供反调试，更没有本地文件系统承载 `license.lic`。
> 现在唯一的授权通道是网页界面 + Worker + KV。

## 与改动前版本的差异

行为等价是硬要求：`low`/`medium`/`high`/`max` 四个预设在固定 seed 下的产物与改动前**逐字节相同**
（用同一份输入、同一个 seed 对比过），目录模式、HTML 模式、套餐闸门与配额语义也都保持原样。

> **例外（2026-09-19）**：`src/passes/wasm.js` 的 junk 段偏移修了一个单位错用
> （字下标当字节地址用，压在参数表上随机改掉 K1/K2，使 `nx` 自检以约四分之一的
> 概率失败）。该修复**改变了产物字节**，因此上面这条不变量对开了 `wasm` 的预设
> （`medium`/`high`/`max`）不再成立。变化是语义中性的——junk 段只是诱饵数据，
> 从无代码读取——已用"产物运行结果与原始源码逐字符一致"验证过。未开 `wasm` 的
> `low` 预设不受影响。同类改动请一并跑一遍多 seed 的 medium/high 产物执行比对。

为了跨环境，以下几点必须改动：

1. **CommonJS → ESM**。浏览器与 Worker 只认 ESM，`require`/`module.exports` 全部换成
   `import`/`export default`。所有模块都保留默认导出，调用形态基本不变。
2. **纯 JS 密码学**。`node:crypto` 只在 Node 可用、WebCrypto 又是异步的，卡密验签必须同步且
   三端一致，于是新增 `src/utils/hash.js`（SHA-256、HMAC-SHA256、base64 解码）。
   与 `node:crypto` 的逐位一致性由 `tools/test/hashtest.js` 覆盖（68 项，含分块边界与长密钥），
   改动前签发的卡密与 `license.lic` 仍然有效。
3. **数据文件 JSON → JS 模块**。原生 ESM 的 JSON 模块在各浏览器支持度不一，
   `options/presets/plans/builtin-*` 改成导出默认值的 `.js`。
4. **许可证拆成共用判定与宿主适配**。原 `src/license.js` 里宿主相关的部分拆出；共用的判定进
   `src/license-core.js`，网页/Worker 侧新增 `src/license-web.js`。自身文件摘要表覆盖的文件变了，
   `tools/issue/selfdigest.js` 已同步。
   （后续 2026-09-21 转向纯云端时，Node 侧那份 `host/license-node.js` 已删除，
   摘要表相应从 6 项缩到 5 项。）
5. **`Buffer` 与 `process` 出核心**。`Buffer.from(mod).toString('base64')`（wasm 档）与
   `process.env.DSH_*` 改成通用实现，`Buffer.byteLength` 改成 `platform.byteLength`。
6. **新增**：`src/platform.js`、`src/pipeline.js`、`src/options-meta.js`、`src/options-gate.js`、
   `src/index.js`、`src/utils/zip.js`、`src/version.js`、`functions/`、`web/`、
   `wrangler.toml`，以及 `tools/` 下的 `build-web.js`、`selftest.js`、`hashtest.js`。
7. **版本号**从 `src/version.js` 读（避免浏览器导入 JSON），`tools/issue/selfdigest.js --check`
   会顺带校验它与 `package.json` 一致。

## 测试

```bash
npm test                                 # 核心/HTML/目录/闸门/许可证/网页链路/Worker/ZIP/ESM/BigInt + 线上验收
JSLB_SKIP_LIVE=1 npm test                # 同上，但不打网络（纯离线段）
node tools/test/hashtest.js              # 118 项：SHA-256/512、HMAC、base64、Ed25519 与 node:crypto 逐位一致
npm run semantics                        # 语义保持扫描（42 用例 × 4 预设 × 3 seed = 528 次比对）
npm run bench                            # 混淆性能基准（各预设 × 各规模 + per-pass 分布）
node tools/issue/selfdigest.js --check   # 自身摘要表与版本号一致性
node tools/test/webfp.js                 # 浏览器指纹线上实测（playwright + 线上域名）
npm run verify                           # 发布验证：打线上域名核对接口与资源
```

### 网络依赖

除「线上验收」段外，`npm test` 全部离线运行，不读凭据、不写仓库内文件。
该段会请求已部署的 Cloudflare 站点，确认部署与策略真的生效：

| 环境变量 | 作用 |
| --- | --- |
| `JSLB_LIVE_ORIGIN` | 覆盖验收目标域名，默认 `https://jslb.lllm.dpdns.org` |
| `JSLB_SKIP_LIVE=1` | 跳过线上段，纯离线跑（无网环境、受限 CI 用这个） |

线上段失败时先分清两种原因：`站点不可达` 是环境/网络问题，`内容不符` 才是部署问题。
`tools/test/webfp.js` 与 `npm run verify` 同样需要网络，且都打同一个域名。

### 性能基准

`npm run bench` 输出各预设 × 各规模的耗时与吞吐，加 `--pass` 拆出每个 pass 的耗时分布，
`--json` 便于跨版本对比。脚本用固定 seed，结果可复现；单个用例超过 3 秒就只测一次
（高档位大输入动辄几十秒，重复测会把基准拖到半小时以上）。

**优化前后的实测对比**（Node 22，单线程，合成 JS 输入）：

| 预设 | 规模 | 优化前 | 优化后 | 提升 |
| --- | --- | --- | --- | --- |
| low | 2 KB | 22 ms | 17 ms | 1.3× |
| low | 20 KB | 102 ms | 58 ms | 1.8× |
| low | 80 KB | 348 ms | 207 ms | 1.7× |
| medium | 2 KB | 843 ms | 149 ms | **5.7×** |
| medium | 20 KB | 8285 ms | 789 ms | **10.5×** |
| medium | 80 KB | 25678 ms | 2952 ms | **8.7×** |
| high | 2 KB | 1203 ms | 369 ms | 3.3× |
| high | 20 KB | 21706 ms | 2329 ms | **9.3×** |

提升幅度**随输入变大而变大**，这是二次复杂度被消除的典型特征。

四处优化，都靠 CPU profile 定位而不是猜：

1. **代码生成的 O(n²)**（`generator.js`）。`_expressionStatement` 原本在生成完表达式后
   回头改写输出缓冲（`_out.slice(0, start) + '(' + _out.slice(start)`），每次都要复制
   整条已生成的输出。CPU profile 显示这一处**独占 24.7% 总耗时**（自耗时第一）。改成
   先把表达式渲染到独立缓冲再决定是否包括号，代价从"整条输出"降到"这一个表达式"。
2. **字符串转义与读取的逐字符循环**。外壳（shell）会把**整个载荷的 base64** 当成一个
   字符串字面量（几 MB），而 `_escapeString` 与 `_readString` 都是逐字符 `out += c`，
   于是变成几百万次单字符拼接。两处都加了"整段无需处理就一次切片返回"的快路径
   （用 `indexOf` / 正则走原生代码扫边界）。递归混淆引导器这一步因此从
   171 ms 降到 20 ms（medium），是本次收益最大的一处。
3. **作用域树改为惰性构建**（`traverse.js`）。原来只要调用方没写 `noScope: true` 就
   无条件 `buildScopes()`，从根重搭整棵作用域树。但控制流扁平化、函数包装、谓词注入
   这些 pass 根本不读 `path.scope`。改成首次访问 `path.scope` 时再建（`NodePath.scope`
   的 getter 本来就实现了这条路径），省下约 15% 总耗时。`noScope` 因此变成纯兼容标志。
4. **遍历热路径**（`traverse.js`）。`walk` 用索引循环替代 `for...of`（后者对数组每次
   新建迭代器），并把每节点的三次动态查找（`visitor[type]`、`FUNCTION_TYPES.has`、
   `visitor.ReferencedIdentifier`）提到遍历外一次性算好。

每个 pass 的耗时都记在 `obfuscate()` 返回的 `stats[].ms` 里，是墙钟时间、不消耗 PRNG，
**开着它构建与关着它构建产物完全一致**。剩下的最大单项是 `shell`——它会对引导器再跑
一遍完整流水线，而引导器里含整个载荷，所以本质上是"再混淆一个几 MB 的文件"。

### 语义保持扫描

`tools/test/semantics.js` 不进 `npm test`（太慢），按需跑：

```bash
npm run semantics                        # 完整扫描，约十分钟
node tools/test/semantics.js --quick     # 只跑 low/medium，1 个 seed
node tools/test/semantics.js -p medium -s 8 -f 逻辑
```

做法是每个用例先跑原始源码记下输出，再逐预设逐 seed 混淆后运行，**输出必须逐字符
相同**。这是唯一能抓住"静默产出错代码"那类缺陷的手段——单元断言抓不到，因为产物
能跑、只是结果不对。已用它验证过 `logicalExpr` 的交换缺陷（把修复回退后立刻报错）。

命中依赖随机数，所以单 seed 跑过不代表没问题，默认跨 3 个 seed。加用例时优先覆盖
**取值语义**容易被改错的地方：逻辑运算符作为运算数、复合赋值、短路求值的副作用顺序。

改过自身许可证相关文件（`src/license-core.js`、`src/license-codec.js`、
`src/license-secret.js`、`src/plan.js`、`src/plans.js`）后必须重跑
`node tools/issue/selfdigest.js --write`，否则校验会判定自身被篡改。
移动这几个文件的位置同样要重算——摘要把文件路径也算进去了。

## 已知问题

- 网页端授权只能在客户端校验，静态部署下可被绕过（见上文"授权"一节的说明）。
- `src/passes/wasm.js` 的 junk 段与 `src/passes/logicalExpr.js` 的交换条件都在
  2026-09-19 修过（前者随机触发自检失败，后者静默改值）。两处都补了回归测试：
  前者是构建期内存布局不变式，后者是 4 例 × 10 seed 的取值语义比对。
  这两类缺陷的共同点是**不报错**，所以宁可让测试慢几秒也要留着。

### 已修：逻辑表达式交换改值（2026-09-19）

原先 `logicalExpr` 把 `a || b` 交换成 `b || a`，注释写"两侧都是原子时求值结果不变"——
**那是错的**：`&&` 与 `||` 返回的是操作数的值而非布尔，`3 || 1` 得 3、`1 || 3` 得 1。
于是 `v = v + (b || 1)` 在 `b` 为真时结果被换成右操作数。命中依赖随机数，约 3/16 的
seed 会踩到，`medium` 才暴露（`low` 阈值 0.3、`high`/`max` 阈值 1 时另有其他变换兜住）。

修法：仅当两侧都**恒为布尔**（比较运算、`!`、布尔字面量）才允许交换。新条件刻意放在
`rng()` 之后，随机数消耗序列不变——实测 16 个 seed 里 13 个产物**逐字节未变**，
只有真正出错的 3 个变了。

> 早先 README 把这条记成"`class` 方法体的缺陷、与移植无关、关掉 stringArray 可规避"，
> 三处都不准确：普通函数同样复现，`logicalExpressions` 才是元凶（关掉它失败率归零），
> 且它是可修的。

### 已修：完整性校验的闩锁变量遮蔽函数（2026-09-19）

`integrityCheck` 给每个入口校验点生成一个 `var` 闩锁。闩锁名走 `uniqueName`，但
**只要与某个根级函数同名，变量赋值之后就会把同名的函数声明遮蔽掉**——头校验循环
里的 `("" + fn)` 取到的是变量的值 `"1"` 而不是函数源码，于是整片哈希假失配并投毒，
产物跑出来的字符串全是坏的，且不报任何错。

触发依赖随机流（哪个名字撞上哪个函数由 seed 决定），表现是"某个 seed 的某个用例
突然输出错"，正是最难缠的一类缺陷。修法：闩锁不再各占一个变量，改为存进一张以
随机键为属性名的表（`if(!L[key]){L[key]=1;V(peer,key);}`），属性键不可能与任何绑定
名相撞，遮蔽从结构上消失。

> 排查这类"静默产出错代码"的通用手法：把可疑的响应动作（投毒、损坏输出）
> 临时改成空操作，保持随机流不变再跑一次。仍然失败 ⇒ 与这个动作无关；
> 变通过 ⇒ 就是它在误触发。逐项排除比读代码快得多。
