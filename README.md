# JsLabyrinth

JavaScript 混淆器，**完全运行在 Vercel 上**。界面与 JSON API 同域，混淆在服务端执行，
项目不依赖任何本地服务、不需要本地 hosts 映射。

| 场景 | 入口 | 说明 |
| --- | --- | --- |
| 网页界面 | `web/`（构建到 `dist/`） | 上传源码 → `/api/obfuscate` 云端执行 → 返回结果 |
| JSON API | `api/*.js` → `vercel/entry.js` → `server/handler.js` | 五个端点，程序化调用走这里 |

混淆核心（`src/obfuscate.js` 及其依赖：AST 解析器、生成器、二十个 pass、许可证编解码）
不引用任何 Node 内建模块，因此浏览器与服务端加载的是同一份代码、同一套选项表、
同一套套餐闸门。

`src/`、`web/`、`server/` 里**没有一行 `node:` 引用**，两者都是纯粹的 Web 标准代码。
`tools/` 下的脚本（发卡、自测、构建）是给维护者在本地用的开发工具，不属于运行时。

## 快速开始

```bash
# 1) 自测（末段会打线上站点做验收，需 JSLB_LIVE_ORIGIN=<域名>；纯离线用 JSLB_SKIP_LIVE=1）
npm test

# 2) 构建静态产物（云端执行形态：界面 + 公开模块，混淆核心不进产物）
npm run build:web:cloud

# 3) 本地预览：起与线上一致的 Vercel 运行时（静态资源 + /api/*）
npx vercel dev

# 4) 发布
npx vercel --prod
```

`build:web:cloud` 只对**公开模块**（授权链路与选项元数据，未激活界面要靠它们渲染激活
表单）做自混淆后下发；受保护模块（混淆核心）**根本不进产物**，混淆一律由
`/api/obfuscate` 在服务端执行。想在浏览器里本地跑混淆，用不带 `--cloud` 的
`npm run build:web`——那一支会把自混淆 + 模块体加密的核心放进 `dist/`，代价是核心随
静态资源公开（适合自建，不适合公开站点）。

浏览器内执行那一支（`npm run build:web`）对 `src/**` 分两层处理（种子固定，产物可复现）：

1. **自混淆**——用项目自己的混淆器跑一遍，实测综合 **1.31×**（预算 ≤1.5×）；
2. **模块体加密**——受保护模块在 `dist/` 里不再有源码文本，只剩明文 stub；
   真正的源码进一个密文载荷，浏览器靠一个引导层解密后以 Blob URL 动态 import 物化。

产物仍是合法 ESM——stub 会按模块**静态**再导出（ESM 的导出名必须在解析期确定），
所以跨文件引用不受影响；项目内依赖图无环，顶层 await 物化链不会死锁。

**按实测挑 pass，不按直觉**。真实代价结构（同一输入、同一种子、11 次取中位数）：

| pass | 运行期 | 说明 |
| --- | --- | --- |
| `objectKeyEncoding` | 21.37× | 每次属性访问变成分段解密取键 |
| `opaquePredicates` | **2.99×** | 单项第二贵 |
| `stringArray` | 2.59× | 阈值降到 0.10 仍要 1.65×，装不进预算 |
| `numberObfuscation` | 1.11× | |
| 控制流 / 死码 / 逻辑 / 条件 | 各 1.02~1.04× | 近乎免费 |
| 基线（全关昂贵项） | 0.99× | 混淆后的核心并不比原核心慢 |

于是当前配置 = 免费的全开 + 昂贵项全关。**改这几行前先跑 `npm run bench:selfobf`**。
字符串仍是明文，那一层由模块体加密补上。调试构建问题时用
`npm run build:web -- --plain` 退回逐字节复制（两层都跳过）。

> 云端执行部署（`build:web:cloud`）**不走这两层**：受保护模块压根不进产物，
> 混淆在服务端跑，浏览器只拿到公开模块。

## 激活

在网页界面里填入卡密即可。卡密由发布方用 `node tools/issue/keygen.js` 签发。

界面「机器码」一栏显示的是**这张授权的身份标识**：它由服务端在激活时随机签发，并
与卡密**永久绑定**——同一张卡此后在任何设备、任何时间取到的都是同一个值，激活之后
不再变化（`--bind` 绑机器发卡自 v5 起已废除，卡密不再携带绑定段）。
（签发工具是维护者本地用的开发工具，不是运行时组件。）

## 部署到 Vercel

```bash
npm run build:web:cloud        # 产出 dist/：界面 + 公开模块（核心不进产物）
npx vercel dev                 # 本地起 Vercel 运行时（静态资源 + /api/*），与线上一致
npx vercel --prod              # 发布（npm run deploy 等价）
```

**必须先在 Marketplace 装 Redis**（Upstash 或 Vercel 官方 Redis 都行，`vercel/store.js`
自动认）。Vercel 的函数是无状态的，没有云存储时授权记录与每日计数只在单实例内存里活着，
表现是"刚激活又提示未激活"。装完自动注入环境变量，`/api/health` 里 `store` 字段应显示
`redis` 或 `upstash`（显示 `memory` 就是没装成）。详见 DEPLOY.md 第 3 节。

`vercel.json` 已配好构建命令（`build:web:cloud`）、输出目录、区域、`JSLB_WEB_CONFIG`
与函数时长。`api/` 下每个路由一个文件（一行转发），逻辑在 `vercel/entry.js` → 
`server/handler.js`。

### 发布后必须验证

```bash
npm run verify -- https://你的域名
```

**配置写了、部署没报错，不等于生效。** 2026-09-19 就踩过这个坑：部署配置里
`JSLB_WEB_CONFIG` 明确写着 `requireLicense: true`，部署输出也把这条列进了
环境变量，但线上 `/api/plans` 返回的是代码里的默认值 `false`——**站点一直在无卡密
自由使用的试用模式**，而部署输出没有任何异常。

所以发布后固定打这几个探针（都不消耗配额，用的是随机设备码且期望被拒）：

1. `/api/health` 活着，`runtime=vercel`、`engine=vercel-functions`、`host=vercel-hobby`
2. `/api/plans` 的档位数与本地一致、`web.requireLicense` 与预期一致、`web.cloudOnly=true`，
   并且**逐档**比对预设上限、各项配额与关闭项
3. 无卡密 `POST /api/obfuscate` 被拒（默认期望 `402`）
4. 混淆核心不在静态产物里：`/src/index.js` 一律 404，而公开模块仍 200

第 2 项的逐档比对是为了防"部署的不是这份代码"：改了 `plans.js` 而忘记重新发布
（或发布到了别的服务）时，档位数常常还是一样的，只有逐字段比对才看得出。

任一项不过就别对外公布。排查顺序：① 确认域名指向的是哪个 Vercel 项目
（`npx vercel ls`）② 改一个醒目的值（如 `trialRunsPerDay: 7`）
重新发布，看 `/api/plans` 会不会跟着变 ③ 若不变，说明发布的不是同一个服务。

`vercel.json` 的 `buildCommand` 必须是 `npm run build:web:cloud`：`/api/plans` 强写
`cloudOnly=true`，而产物里没有混淆核心，两者必须对上，否则用户点运行只会看到一句
import 404。

完整部署流程（平台选型依据、Secrets 注入、自定义域名、常见报错排查）见
[`DEPLOY.md`](DEPLOY.md)；本地环境变量模板见 `.env.example`。

### 服务端是无状态的

没接云存储时，服务端不保留任何跨请求的东西：许可证记录、试用计数都是逐请求即弃，
`state`、设备码缓存、内存存储都在每个请求开头重置。这既是安全要求（一个函数实例会
连续处理互不相干的请求，共用模块级状态会把 A 的授权泄漏给 B），也决定了调用方式——
**每次请求都要带上卡密**（`X-JSLB-Key` 或请求体 `key`）与设备码（`X-JSLB-Device`），
否则请求按试用档处理。接上 Upstash（`JSLB_KV`）后记录按设备码分键持久化，计数才真正
跨请求、跨实例生效。

设备码（`X-JSLB-Device`）由客户端随机生成并持久化，只用于云存储按设备分键；**机器码
已改由服务端签发并与卡密绑定，不再依赖它**，所以清掉浏览器存储不会让已激活的卡失效。
反过来，设备码本身仍是客户端提供的，清掉它只能重置**试用计数**——配额是"防误用"级别的，
不是防作弊级别的。

> **机器码为什么不再由设备特征派生（2026-09-25 改）**：浏览器只能拿到平台、CPU 核数、
> GPU 渲染器、时区、语言这类特征，而服务端根本没有 navigator / WebGL，派生出的是另一个
> 常量——界面上就表现为"激活前显示 A、激活后服务端回 B"；特征里任何一项漂移（GPU 渲染器
> 取不到、改时区/语言）还会让已激活的卡在 restore 时判成 machine 不一致，用户什么都没干
> 就被踢回未激活。现在改为激活时向 `/api/machine` 要一个码，服务端按**卡密编号**登记后
> 永久保存（云存储）；没接云存储时退化为"由卡号确定性派生"，同样恒等。离线时退回本机
> 缓存与设备特征值，并把结论记进本机缓存，保证刷新前后一致。

### 运行限制

- **免费档有硬约束**，全部按 Vercel Hobby 定（数字见 `src/host-limits.js`）：函数请求体
  4.5 MB、单次上传 2 MiB、每日 CPU 预算 300 s、函数时长 60 s。超限分别表现为 413、413、
  503（预算用尽）、超时。`/api/obfuscate` 在入口就预检这些，所以用户看到的是可读的
  中文/英文提示，而不是平台的 `FUNCTION_PAYLOAD_TOO_LARGE`。
- **核心模块图里不能有字符串代码生成**。浏览器的 CSP 与不少函数运行时禁用 `eval` 与
  `new Function`，跑起来直接报 `EvalError: Code generation from strings disallowed`。
  `src/passes/shell.js` 原先用 `(0, eval)(PRIMITIVES)` 保证"产物文本与构建期实现不漂移"，
  已改成手写等价实现，比对挪进 `tools/test/selftest.js`。自测里有一条守卫会拦住回退，
  改核心时别引入 `eval`/`new Function`。注意产物**里面**的引导器不受这条限制。


## JSON API

> **网页界面也用这一节**（云端执行部署）：界面把源码 POST 到 `/api/obfuscate`，
> 由服务端跑完整流水线。下面的接口同时给程序化调用用。

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
| `/api/machine` | POST | `{key}` → `{machine}`，取这张卡绑定的机器码（首次随机签发并永久登记，同卡恒等） |
| `/api/obfuscate` | POST | `{code, options?, type?}` → `{code, stats, originalSize, obfuscatedSize, quota}`。**供程序调用**，界面不使用它（见"混淆只在浏览器内跑"） |

响应状态码：`400` 非法请求体/选项、`401` 卡密无效、`402` 未激活且要求激活、
`403` 选项被套餐闸门拦下、`413` 超出单文件限额、`422` 混淆失败、`429` 今日次数用尽。

### 消息语言按请求协商

响应里的 `message`、`banner`、`quotaText` 等文案是**本地化过的**，语言按请求判定
（`server/handler.js` 的 `resolveLang`），优先级：

1. `X-JSLB-Lang: zh | en` —— 网页界面用它，值与用户在界面上选的语言严格一致；
2. `Accept-Language` —— 脚本 / curl 场景，浏览器也会自动带；
3. 环境变量 `JSLABYRINTH_LANG`，都没有则 `zh`（与既有调用方行为一致）。

只认 `zh` / `en`；其他取值一律回落，不会因为语言参数写错而让请求失败。
跨域调用若要用这个头，记得它在 CORS 的 `access-control-allow-headers` 里已放行。

> 为什么需要它：语言若只由服务端环境变量决定，界面切英文的访问者拿到的报错仍是中文
> ——`Activation failed: 激活失败: 未找到许可证文件` 这种中英夹杂就是这么来的。

## 选项

选项表在 `src/options-meta.js`：一处定义，网页界面控件与套餐闸门都从它生成。
新增一个选项只要在那里加一行，界面立刻出现控件、套餐闸门按同一个键判定。

界面上的每个选项控件直接对应 `src/options-meta.js` 里的一行；悬停可看到取值说明。
预设只提供默认值：同一次运行里显式改动的选项逐字段覆盖它——**只有被改动过的控件
才作为"显式选项"提交**，因此默认值不会莫名其妙触发套餐闸门。

`node tools/issue/keygen.js --plans` 可打印完整的选项与套餐对照表。

### JS 内嵌 HTML（同一个开关）

同一个 `html2mem` 也管**嵌在 JS 代码里的 HTML**：`innerHTML = "<div>…"`、`document.write`、
`insertAdjacentHTML`、`$(`…`)` 这些位置的字符串，以及带插值的模板 `<div>${x}</div>`，都会被换成
一个运行期解码调用，产物里只剩密文。

| 项 | 说明 |
| --- | --- |
| 与文档模式的差别 | 这边**不需要 DOM**：解码器只做「按标记把占位换回值、返回字符串」，所以产物在 Node / worker / ServiceWorker 里照样能跑（文档模式必须有 `document`） |
| 识别的两种来源 | ① 标签白名单命中 `<tag` / `</tag`；② 出现在 `innerHTML`/`outerHTML` 赋值右侧、`insertAdjacentHTML`/`document.write`/`createContextualFragment` 实参、jQuery 风格调用里。取**并集** |
| 为什么用白名单 | 避免把 `a < b`、`Map<string,X>`、`i<length` 误判成 HTML。代价是自定义标签（`<my-widget>`）在非 DOM 赋值处会漏，可用 `reservedStrings` 排除 |
| 插值模板 | 逐个静态片段加密，重建成 `_h(0)+x+_h(1)`；**全是变量、没有静态内容**的（`<ul>${items}</ul>`）会跳过，没有可加密的东西 |
| 实体 | 按**原样字符**加密（`&amp;` 仍是 5 个字符）。这与文档模式相反——那边要先解码成 `&`，因为写回用 `textContent` 要的是 DOM 值；这边字面量赋给 `innerHTML` 后由浏览器解码，先解码反而会把内容改写 |
| 不处理 | 带标签的模板（lit-html 的 `html\`…\``）。准星位置必须是真正的 TemplateLiteral，替换会让生成器抛错；且标签函数约定收到 `(strings, ...values)`，语义也变了。用普通模板 + `innerHTML` 赋值可覆盖绝大多数写法 |

执行顺序上它排在 `templateToConcat` 与 `stringArray` **之前**：`stringArray` 会把字面量收进池、
`templateToConcat` 会把模板拆成 `"a"+x+"b"`，两者都会让 HTML 认不出来。

### HTML 文本加密（HTML2MEM）

把 HTML 的**文本节点与属性值**（`href` / `src` / `integrity` / `nonce` 除外）加密成一段密文，页面里只留密文 + 一个还原 loader。
运行期 loader 解密进内存，按占位标记把 DOM 还原成与原文语义相同的样子。产物里不再有
任何正文/属性明文，view-source、grep、爬虫都拿不到。

| 项 | 说明 |
| --- | --- |
| 选项 | `html2mem`（开关）、`html2memKey`（0 = 由 seed 决定 / 填值 = 无视 seed） |
| 作用面 | **文本节点 + 属性值**；`script` / `style` / `noscript` / `template` 的内容不碰 |
| 保留原样 | `href` / `src` / `integrity` / `nonce`、无值属性（`disabled`）、`<style>` 内容、注释、doctype |
| 保留原因 | 上面这几个属性在 **HTML 解析阶段**就被浏览器读走（发起请求、校验哈希、对照 CSP），加密会让资源加载失败；`<style>` 内容是样式表，混淆它没有意义（内联脚本本来就照常混淆） |
| 产物新增 | `</body>` 前一段 `<script>` loader（约 1 KB）+ 一段 base64 密文 |
| 统计 | 返回值的 `html2mem`：`values` 值数、`bytes` 密文字节、`key` 本次密钥 |

**这是混淆，不是保密。** 密钥与解密逻辑都在页面里，打开开发者工具的人照样能 dump 出还原后
的 DOM。它挡的是「随手看源码 / 静态扫描」，不是「有决心的人」。要真保密只能放服务端。

两个代价要知道：页面在 loader 执行前**没有正文**，无 JS 环境与爬虫看到的是空页；还原后
的 HTML 与源码不是逐字节相同（因为加密的是**解码后的值**，`&amp;` 还原成 `&`），
渲染结果一致。

实现上有两个容易做错的地方，`src/html2mem.js` 都处理了并有断言：

1. **加密的是解码后的值**。源码写 `&amp;`、DOM 里是 `&`；加密 `&amp;` 再用
   `textContent` 写回，页面就会显示字面的 `&amp;`。所以取值时先解实体，写回时用
   `textContent` / `setAttribute`（都按字面处理），两边正好对上。未知实体与越界数值
   实体原样保留——原样保留意味着还原后与原文一致，行为不改变。
2. **占位标记不能和原文撞**。标记用两个控制字符包一个下标；原文里若已含这两个字符就换
   一组，最多试若干组。

只在 **HTML 输入**时生效，JS 输入不受影响。加密在**内联脚本混淆之后**做：脚本块里若有
`</script>` 字面量会被 HTML 解析器提前截断，混淆后的产物更可能带上这种东西；先混淆完
再扫，扫描器看到的已经是最终形态。

## 五类防护能力落在哪里

新增或调试某一类能力时，先知道它由哪些 pass 承担：

| 类别 | 承担者 | 要点 |
| --- | --- | --- |
| 多态混淆 | 全局 PRNG（`utils/rand.js`）+ `controlFlow` 滚动重键 + `stringArray` 运行期演化 | 固定 seed 逐字节复现，换 seed 后标识符集合与结构都变；扁平化状态机的状态值每次分派滚动异或重键（`--no-control-flow-rolling-key` 可关），字符串池槽位按会话熵演化，同一份产物每次运行的密文快照不同 |
| 代码变换 | `vm` / `controlFlow` / `objectKeys` / `templateToConcat` / `numberObf` / `logicalExpr` / `conditionObf` / `deadCode` / `opaquePredicates` / `functionWrapper` / `callProxy` / `mangle` | `numberObf` 把整数字面量改写成取值恒等的算术/位运算表达式（`--number-obfuscation-threshold` 控制命中率） |
| 反调试 | `debugProtection` + `envFingerprint` | 三类检测：环境侧信号（尺寸/时差/栈形态）、内建函数"原生文本"、内建函数"对象身份"（Function、defineProperty、getOwnPropertyDescriptor、call、eval 在头部快照后运行期比对），外加描述符 canary；命中走隐蔽断点 → 有界拖慢 → 确认投毒三级响应 |
| Anti-CDP | `antiCDP` | Chrome DevTools Protocol / 自动化框架（Puppeteer、Playwright、ChromeDriver、Selenium）检测：console 序列化探针（Runtime.enable 下 log 触发 1 次访问器、debug 触发 2 次，累计 ≥2 即硬证据）、`navigator.webdriver`、驱动注入属性精确比对与 `$cdc_*` 子串扫描；V2/V3 由定时器周期复查，命中与反调试共链投毒。原生 console 引用在反调试失效化之前捕获，consoleStub 不影响探针。用自动化做端到端测试的构建请关闭本项 |
| 域名锁定 | `domainLock` | 产物只允许在指定域名（及可选端口）上运行。白名单逐构建随机盐散列成数值表内嵌（产物里没有任何域名明文），匹配结果与字符串池解密密钥耦合：授权主机给健康载体补 +Q 归零偏移、字符串正常；非授权主机整池静默乱码，没有可 NOP 的检测分支。详见下文「域名锁定」 |
| 自防御 | `stringArray` 自检 + `integrityCheck` | 装配期全池校验和 fail-closed，访问期再按抽样门重算旋转后的校验和（动态 xor 组查"密文与明文等长"不变式）；`integrityCheck` 对根级函数声明做 64 位双通道哈希，失配只置毒药标志 |
| 运行时保护 | `integrityCheck` / `vm` / `shell` / `shellForm` / `rtlib` / 引导层（`passes/banner.js`） | 引导层（健康载体 + 盐互锁，见下文「引导层」）、装载时的原生性探针（内建成员被换钩子即投毒）、入口交叉校验带一次性闩锁、外壳算术依赖式防篡改、`shellForm: 'jsfuck'` 把密钥流与校验核心编成六字符 JSFuck 表达式（见下文「外壳形态」）、原生调用收敛进 RT 内核 |

`integrityCheck` 的校验面分两批走：根级**函数声明**进头部校验循环（装载最早期，那时
只有函数声明已提升）；字符串池**访问器**走延迟校验——单独一块插在最后一条访问器
声明之后，那时函数已就位。改一处解码器文本即失配投毒，实测往解码器函数体里插一条
无害的 `0;` 就会被抓到。

限制：访问器声明若被 vm 搬进嵌套函数体（高档预设常见），这一处就放弃覆盖——
那种体是 VM 解释执行的结构，硬插进去会失配。宁可少覆盖一处，也不拿假失配
投毒去换覆盖率。

### 域名锁定（`domainLock`）

逗号分隔的域名白名单（Free 档不可用，Plus 及以上可开）：`example.com` 精确匹配、
`.example.com` 含该主机与任意层子域（点边界切分，`badexample.com` 不会误中）、
`example.com:8443` 额外锁端口（对 `location.host` 比对；后缀条目不支持端口）。

与 obfuscator.io 的 `domainLock`（明文域名数组 + 运行期 if 比对 + throw）的本质
区别在于匹配结果是**密钥耦合**的，与完整性校验共用同一条链路：

- 构建期把白名单逐条散列成 32 位数值（逐构建随机盐），掩码编码后内嵌；同时选出
  授权贡献 Q（随机常量，拆成两个异或半片），引导层按「健康常量 − Q」写载体；
- 运行期校验函数是纯数值匹配（没有任何字符串字面量，域名表不以明文出现）：授权
  主机给载体 +Q，字符串池读取端偏移归零、一切正常；非授权主机给载体加「宿主散列
  经 R 轮折叠」的 J，偏移非零，**整池字符串静默变乱码**——没有报错、没有抛点、
  没有可 NOP 的 if 分支，fail-closed；
- 校验函数是根级函数声明，自动进入 `integrityCheck` 的哈希面：篡改函数体即失配
  投毒；删除引导调用则 +Q 缺失，授权域自己乱码（Q≠0 设计）；硬编码 J 使其等于 Q
  需要对折叠链做 2^32 × R 轮的离线搜索；换域名重签等价于重新混淆。

降级链（按强度递减）：`coupled`（默认，密钥耦合）→ `poison`（关了完整性校验时，
失配写毒药键，有可清除的标志）→ `throw`（连字符串池都没有时，装载期显式抛错，
仅兜底）。

限制：Node / 无 `location` 环境视 hostname 为空、永不匹配——域名锁定的构建本来
就不承诺可在浏览器外运行；做无浏览器沙箱的自动化测试时不要开本项。

### AST 简化（`simplify`）

混淆前对用户代码做一轮语义保守的 AST 压缩（对标 obfuscator.io 的 `simplify`）：
常量折叠（数值/字符串/位运算/严格比较/一元/逻辑/条件表达式，两侧都是字面量才折）、
死代码消除（`if(false)`/`while(false)` 整块删除、`if(true)` 取保留下来的那一支、
`if(false)A else B` 取 `B`）、空语句清除、相邻 `var` 声明合并、**无用声明消除
（DCE）**——没有任何读取引用、初始化器也无副作用的变量/函数/类声明整条删掉，且
删除不会丢掉副作用（有副作用的初始化、有写入的绑定、模块导出面、脚本顶层的全局
属性一律保留；`with` 出现时整体跳过）。只有缩小或不改产物体积，确定性、无随机，
固定 seed 可复现。

保守边界（宁可少折不可折错）：除零、取模 0、幂溢出这类 NaN/Infinity 不折；避开
`-0`（与 0 在 `Object.is` 下不等）；`==`/`!=` 只在两侧同类型字面量时折；`&&`/`||`/
`??` 与条件表达式只在「被丢弃的一侧是字面量」时才折，避免丢函数调用副作用；
`for(;false;)` 不删（init 的副作用必须保留）。

排序在整条流水线最前（parse 之后、任何注入之前），只作用于用户代码，与其它混淆
pass 无冲突。Paid 档（plus+）可显式开启，free 档闸门锁死 `false`。

### 压缩能力：真的能当 minifier 用（`simplify` + `nameStyle`）

`mangle` 默认走 `Mangled`（`nameStyle` 的默认档）：`a`…`Z$_` → `aa`… 的规范短名，长度
递增、**按引用次数从多到少发放**（最常出现的绑定拿最短的名字），已占用的名字与关键字
一律跳过。叠加 `compact`（去空白）就是"当 minifier 用"的完整配置。

同输入实测（相对 terser `compress+mangle` 的倍数，越小越好；`npm run bench:minify`
可复现，两个参考实现都是 `npm install --no-save terser javascript-obfuscator` 临时装的）：

| 输入 | 原始 | terser | 我们（默认 Mangled） | 我们（Mangled-shuffled+DCE） | obfuscator.io（compact+simplify） |
| --- | --- | --- | --- | --- | --- |
| `src/obfuscate.js` | 15.5 KB | 7.6 KB | 12.1 KB（1.59×） | **12.1 KB（1.59×）** | 12.5 KB（1.63×） |
| `src/passes/vm.js` | 145.2 KB | 64.1 KB | 75.3 KB（1.18×） | **75.1 KB（1.17×）** | 123.2 KB（1.92×） |
| `src/ast/parser.js` | 58.0 KB | 34.1 KB | 40.0 KB（1.18×） | **40.0 KB（1.18×）** | 50.8 KB（1.49×） |
| bundle 式模块（含死代码） | 9.9 KB | 0.3 KB | 10.3 KB | **3.5 KB** | 13.6 KB |

（2026-09-27 实测：Node 24 + terser 5.51.2 + javascript-obfuscator 5.8.0。）

读法与边界：真实源码上我们落在 terser 的 1.18~1.59×；bundle 那行的倍数被 terser 的内联
能力拉大（它把整段折成 0.3 KB），可比的是绝对体积 3.5 KB 对 13.6 KB——obfuscator.io 不
做无用声明消除。短名不复用作用域（本 pass 直接改节点、不维护作用域图），所以密集小作用域
的代码会比 terser 略胖；terser 的表达式级优化（内联、序列化、丢空 `if`）本工具不做，这是
"1.2~1.6× 而不是 1.0×"的主因。

排序与开关：`nameStyle` 默认 `Mangled`，free 档闸门只放行它，Plus 及以上可切其余三档；
`simplify` 同样 plus+ 可开。四档的取舍见下节。

### 四档命名策略（`--name-style`）

四档与 obfuscator.io 的 `identifierNamesGenerator` 同一套命名，便于横向对比产物。共用
同一套发放机制——长度递增、**按引用次数从多到少发放**、跳过已占用名与关键字、不复用
作用域、池空退回随机名。区别在池子里装的是什么，以及发名顺序固不固定：

| 档位 | 样子 | 发名顺序 | 定位 |
| --- | --- | --- | --- |
| `Mangled`（默认） | `a`…`Z$_` → `aa`… | 固定 | 体积最小；**与 seed 无关**，两次构建可逐字节 diff、跨机器结果一致。代价是产物里必然出现 a、b、c… 的发名顺序，指纹最强 |
| `Mangled-shuffled` | 同上，字母表换一套 | 随 seed | 体积与 `Mangled` 完全相同（名字长度一样），但产物里没有一套可辨识的字母表。**混淆发布用这档** |
| `Hexadecimal` | `a7`、`f30`、`0e91` | 随 seed | 一个字母 + 十六进制位，从 **2 字符**起步。一样短但完全无规律。`if`（`i`+`f`）这类正好落在该形状里的关键字由关键字表跳过 |
| `Dictionary` | `value`、`index`、`result1` | 随 seed | 固定 64 词表。栈和断点里还认得出变量，调试成本最低；产物最大，且**词表可枚举**，认的人拿同一份词表就能把改名批量还原。发布产物别用 |

体积对照（`npm run bench:minify` 可复现；Node 24 + terser 5.51.2 + javascript-obfuscator
5.8.0，2026-09-27；同一 seed 只换 `nameStyle`，其余用上面那套"当 minifier 用"的配置，
不开 DCE。倍数是相对 terser 同输入产物的体积，越小越好）：

| 输入 | terser | Mangled | Mangled-shuffled | Hexadecimal | Dictionary |
| --- | --- | --- | --- | --- | --- |
| `src/obfuscate.js` | 7.6 KB | 12.1 KB（1.59×） | 12.1 KB（1.59×） | 12.5 KB（1.63×） | 14.2 KB（1.86×） |
| `src/passes/vm.js` | 64.1 KB | 75.3 KB（1.18×） | 75.3 KB（1.18×） | 76.8 KB（1.20×） | 95.9 KB（1.50×） |
| `src/ast/parser.js` | 34.1 KB | 40.0 KB（1.18×） | 40.0 KB（1.18×） | 40.5 KB（1.19×） | 45.2 KB（1.33×） |
| bundle 式模块（含死代码） | 0.3 KB | 10.3 KB | 10.3 KB | 10.5 KB | 14.1 KB |

`Mangled` 与 `Mangled-shuffled` 的名字长度分布完全相同，所以在"当 minifier 用"的配置下
产物**逐字节等长**（三份真实输入实测 12433/77147/41006 字节，两档完全一致）——"要不要
打乱"是纯粹的抗指纹取舍，不花体积。`Hexadecimal` 大 1~3%，`Dictionary` 大 13~27%。

一个容易踩的细节：`Mangled` 的命名池不打乱，**不消耗随机数**，而 `Mangled-shuffled` 要消
耗。开着其它 pass 时两档的随机流位置不同，后续 pass（字符串池密钥、注入名等）的产物会有
零点几个百分点的差异——那不是名字的功劳。想比较命名本身的体积差异，把其它 pass 关掉再量。

选档：要最小体积、且产物要能跨构建逐字节复现（回归对比、两版 diff）用 `Mangled`；
对外发布用 `Mangled-shuffled`；要产物里完全找不到规律用 `Hexadecimal`；调试与代码
审计用 `Dictionary`。

档名**大小写敏感**。旧档名（`random` / `short`）或拼错的档名会回落到默认档 `Mangled`，
既不抛异常，也不会静默出一份没约定的产物。

## 增强保护系统（引导层 / 碎片化 / Anti-LLM）

2026-09-24 加入的一层，全部由选项驱动，默认只在 `max` 预设上打开（Plus 及以上
可以显式开启其中大部分）：

| 能力 | 选项 | 默认开启 | 要点 |
| --- | --- | --- | --- |
| 字符串碎片化 | `stringScatter` | 仅 `max`；Plus 可显式开 | 池内容拆成多个载体分散声明 |
| Anti-LLM | `antiLLM` | 仅 `max`；Plus 可显式开 | 误导注记 + 伪业务分支 |
| 引导层自检 | 无（始终注入） | 全档生效 | 写字符串池健康载体 + 盐与外壳密钥流互锁 |

### 引导层（原「文件头横幅」，2026-09-30 起不再写注释）

产物**不再有文件头注释**。原先 `/*! JsLabyrinth vX.Y … protected build / Author: Heling */`
承担三件事：署名与反 LLM 声明、引导自检的比对锚点、以及写入字符串池的健康载体。
前两件随注释一起去掉了（署名不再是产物的一部分），**第三件与互锁全部保留**，只是把
比对锚点从"注释正文"换成了引导内部的**随机字面量**。

引导层注入到产物最前面，做两件事：

1. **健康载体**：`global[<随机名>] = (OK - Q + (盐 - 期望盐))|0`。未被改动时偏移恒为 0，
   字符串池首次访问时读它当密钥偏移；域名锁定按 `+Q` 补回。删掉引导 → 载体没人写 →
   池读取端算出 `-OK` → 整池字符串静默乱码。
2. **盐**：外壳层把它运行期取值异或进载荷密钥流（见 `shell.makeShellLayer`）。盐不对或
   缺失，载荷就解不开。

**引导层不可删除**：盐 = `fnv32(引导内的随机字面量)`，构建期把期望值写死，运行期由引导
自己重算比对。改动那个字面量 → 盐错位 → 外壳密钥流解不开；删掉整段引导 → `saltVar`
未定义 + 载体缺失 → 同样坏。原来的"删/改文件头注释 → 失效"这条性质因此**不再依赖任何
注释**，改判一个字节照样触发。


### 外壳形态（`shellForm`）

`classic`（默认）与 `jsfuck` 两种。`jsfuck` 把引导器里**「密钥流生成 + 校验尾差量」
那段核心**改写成纯 JSFuck 表达式——只由 `[ ] ( ) ! + { }` 八个字符构成（语法上只有
下标、调用、一元运算与加法；`{}` 只作 `[]+{}` / `+{}` 两个基串，因为 `c`/`o`/`j`
只有 `"[object Object]"` 给得出，见 [jsfuck.js](src/passes/jsfuck.js) 头注释），
运行期经 `Function` 构造器编回函数再调用；引导器其余部分（段装载、表派生、投毒）
一字不动。

- 这段核心正是"密文怎么被解出来、校验尾怎么算"的那一段，静态可读性归零：
  表达式里没有任何标识符、字符串或数字字面量，连 `%` 都是
  `escape(" ")[0]` 现取。配合外壳本来就把载荷打碎，反 LLM / 反人工阅读多一层。
- **代价固定且可预期**：每层一份核心预置，单份实测 **79 字符/字节 × 487 字节核心 +
  8181 字符固定开销 = 46528 字符（45.4 KB）**。整个产物的增量**与载荷大小基本无关**：
  实测 30 B 载荷 +107.6 KB、25 KB 载荷 +107.1 KB（外层一份 + 内层那份随载荷一起被外层
  加密膨胀），即小输入上占比大、大输入上约 +37%。Free 档不可用，Plus 及以上可开。
- 编码口径：`unescape('%XX')` 每条字节要重新内联一遍 `%` 的取用链（2969 字符/字节，
  其中 `get('%')` 占 98%）；改用占位符 + 一次 `.split().join()` 后降到 68~88 字符/字节
  （核心这段 79），38 倍。`String.fromCharCode` 因为同样没有变量可用反而要 8819
  字符/字节，更贵两个量级。细节与实测依据见 `src/passes/jsfuck.js` 头注释。
- 核心表达式有体积上限（`JSFUCK_MAX_CHARS`，512 KB）：改核心时不小心把整段引导器
  搬进来，**构建期直接失败并报出实际体积**，不会悄悄产出几百 KB。想扩大切面（把表
  派生、段装载也搬进 JSFuck）时，按同样的传参方式改写 `JSFUCK_CORE` 即可。

### 字符串碎片化（`stringScatter`）

关闭时每组字符串池是**一个**加密数组字面量；开启后池内容按逐次随机的 2~4 片
逐项切开，分散到多个载体数组里声明（载体名随机、顺序打乱），运行期按位拼回。
静态面上不再有任何一处集中存放整池密文，索引与片段分处不同的声明。
自检校验和仍然按**拼回后**的池重算，语义与关闭时完全一致。

### Anti-LLM（`antiLLM`）

大模型读代码依赖注释、命名与可见的业务句式，本 pass 对三样各做一层对耗：
误导性工程注记（以字符串语句形式注入，随后被字符串池收走加密）、不透明守卫包住的
伪业务分支（只引用内建全局与自身局部，永不执行却像正片）、与真实标识符同分布的
诱饵命名。

### 与既有产物字节的关系

`max` 预设与全档引导层会改变产物字节（新能力 + 引导层注入），这属于本节的既定
变更。2026-09-30 起**引导层不再写文件头注释**，于是全档产物都去掉了开头那段
`/*! … */`——这是本节记录的第二次全档字节变更。

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

另有参与闸门的新选项：Free 的外壳形态锁在 `classic`、命名策略锁在
`random`、关掉碎片化与 Anti-LLM；Plus 可以把外壳形态切成 `jsfuck`、
把命名策略切成 `short`、开碎片化与 Anti-LLM；碎片化与 Anti-LLM 之外的更高强度
组合留给 Team/Business。
**HTML2MEM**（`html2mem`）同样受闸门约束：**Free 不可用，Plus 及以上可用**。它会把产物内容换成密文
并注入运行期解码器，明显改变产物形态，与 `antiLLM`、`debugProtection` 同级。配套的
`html2memKey`（固定密钥）**刻意不加闸门**——它是 `html2mem` 的附属项，没有 `html2mem` 时本就不起作用，
单独限制反而会让人以为能单独用。四个预设里 `html2mem` 都默认 `false`，新功能不改变默认产物形态。
注意：加闸门必须先让该选项存在于**所有**预设里，否则 `plan.js` 的 `assertConsistent()` 在加载期
就会抛「预设 low 达不到闸门要求项」——这条是硬拦的，写闸门时先改 `presets.js`。

Plus 的预设上限是 `high`，闸门正好卡在 `high` 预设的取值上（能用整套 high，但不能把
单项往上调），只关掉 `consoleStub` 一个开关；Free 则关掉十二个。Team 与 Business 同为
`max` 且都不设闸门，差别只剩配额（7 MB / 200 次 对 10 MB / 1000 次）。

订阅档与额度包**不排在同一条阶梯上**：两者的配额口径不同（一个按日、一个按总额），
`src/plan.js` 的档位阶梯不变式因此只在同族内比较。

`node tools/issue/keygen.js --plans` 随时打印这份对照表。
加档位时注意两条：**闸门缺省一律放行**（`undefined` 返回 `true`），关掉某个开关必须
逐项写 `false`；且**套餐自带的预设必须满足自己的每一条闸门**——`src/plan.js` 的
`assertConsistent()` 在模块加载时就会拦下不合规的定义，所以数值闸门不能比自带预设
更紧。**升预设上限时尤其注意**：闸门必须放行该预设的每一个取值，没有中间地带
（例如把上限提到 `medium`，就必须同时放行 `debugProtection`、`selfDefending`、
`integrityCheck`、`shell`、`stringArrayMixedEncoding` 这些 medium 用到的开关）。
2026-09-22 把 Plus 提到 `high` 时就踩过一次：`high` 会打开 `envFingerprint`，而旧的
Plus 闸门把它显式关着，改上限却忘了动那一条，加载期直接被 `assertConsistent()` 拦下——
**升上限必须逐条比对目标预设的取值，开关项（true/false）比数值项更容易漏**。
自测里有一条不变式：**低档的每一条闸门都不得超过高档**。

> **⚠️ v5 更新（2026-09-24）：卡密改为对称格式，本节及下文的 Ed25519/绑定段描述是 v4 历史背景。**
> 卡密为 `JSLB-编号8-信息16-校验4`：对称卡密密钥（`B64_CODE_KEY`）随源码分发（浏览器要本地
> 验卡），签发方与验证方共用一把；不再有公钥/私钥之分，卡密也不携带机器绑定段——"一卡一机"
> 由服务端 KV 赎回登记实现（首次激活登记赎回者机器码，其他机器再用同一卡密即被拒）。
> 拿到源码的人能自己造卡，真正的强制在服务端（逐请求校验 + 赎回登记 + 门控）。安全模型以
> `src/license-codec.js` 与 `src/license-secret.js` 的头注释为准。

**机器码由服务端签发，与卡密永久绑定（2026-09-25 起）。** 激活时客户端向 `/api/machine`
要一个机器码，服务端按**卡密编号**随机签发并登记进 KV（`machine:<编号>`）；此后同一张卡
在任何设备、任何时间取到的都是同一个值。服务端没绑 KV 时退化为"由卡号确定性派生"
（同一张卡恒等），所以"永久绑定"不依赖存储是否可用。离线或纯静态部署下退回本机缓存与
设备特征值。

> **v4 历史背景（已废除）**：旧版卡密带一段机器码的派生摘要（绑定段，16 字符 base32）在
> Ed25519 签名载荷内，"这张卡属于哪台机器"在签发时定死，用 `--bind <机器码>` 签发。v5 起
> 卡密不携带绑定段，`--bind` 直接报错作废，"一卡一机"由服务端 KV 赎回登记实现——首次激活
> 登记赎回者的机器码，别的机器再用同一张卡即被拒（reason=used）。

本地记录里另有一份机器码与 HMAC 令牌，防的是把许可证记录直接拷到另一台机器——那一层的
密钥派生自卡密密钥、是公开的，只留下篡改痕迹，**不是**安全边界。

- **网页/服务端**：机器码与浏览器设备特征**无关**了，因此清掉站点数据、换浏览器、进隐私
  模式都不会换机器码——已激活的卡不会因为环境变动而失效。旧的"设备特征派生"只剩一个用途：
  未激活且拿不到服务端时，界面那一栏的兜底展示值。

> **卡密格式 v4**：`JSLB-<套餐1>-<天数2>-<签发日3>-<编号8>-<绑定16>-<签名103>`，共 143 字符。
> 比 v3 多了绑定段，编号段同时由 24 字符压到 8 字符（40 bit，约 1.1 万亿个编号）。
> **v3 及更早的卡密在新版本上一律作废**，必须用新私钥重新签发（与 2026-09-20 换 Ed25519
> 那次的代价同类）。

### 让网页版必须激活

未激活时的行为由网页版策略 `JSLB_WEB_CONFIG` 决定，把 `requireLicense` 设为 `true`
即要求先激活，未激活一律拒绝（API 返回 `402`，界面直接提示失败）：

```jsonc
// vercel.json
"env": {
  "JSLB_WEB_CONFIG": "{\"requireLicense\":true,\"trialPreset\":\"low\",\"trialMaxFileBytes\":524288,\"trialRunsPerDay\":10}"
}
```

`trialRunsPerDay` 默认是 **10 次/天**（`src/platform.js` 的 `DEFAULT_WEB_CONFIG`）。
试用完全不限次数等于把它当成免费正式版，既没有激活动机也没有"试用"的样子；要放开
把它设回 `0`。

界面启动时会从 `/api/plans` 读回这份策略并套用，因此服务端要求激活时界面不会按
"允许试用"放行——两端判断始终一致。

部署方需要注意的边界：**卡密是 Ed25519 签名的，私钥只在签发方**，所以拿到全部源码也
**签不出新卡密**——这是非对称签名拿到的性质，也是"源码公开"这件事不再致命的原因。
（云端执行部署下混淆核心压根不在静态产物里，这一层比"加密后公开"更靠前。）
要再进一步让验签发生在服务端，用自己的密钥对即可（Vercel 项目设置里配
`JSLB_CODE_KEY` 环境变量）：

```bash
node tools/issue/keyrotate.js --write        # 生成密钥对：公钥进源码，私钥进 .jslb-code-key
# 然后在 Vercel 项目设置里加环境变量 JSLB_CODE_KEY = 上一步打印的公钥（可选；内置公钥也能用）
```

用**自己的**密钥对时，发卡与验签才同源：

```bash
JSLB_CODE_KEY=<base64 私钥种子> node tools/issue/keygen.js --plan plus --days 365
```

`tools/issue/keygen.js` 因此优先读环境变量 `JSLB_CODE_KEY`，读不到才退回项目根的
`.jslb-code-key`（该文件在 `.gitignore` 里）。两处都没有时**明确报错**，不会签出
一张验不过的卡。

### 三个签发工具的分工

容易混，先说清楚：

| 工具 | 干什么 | 会不会动文件 |
| --- | --- | --- |
| `tools/issue/signingkey.js` | 生成**签名密钥对**，当场做签验往返自检 | 默认只打印；`--out <dir>` 才落盘 |
| `tools/issue/keyrotate.js` | **轮换**签名密钥对 | **会覆盖** `src/license-secret.js` 与 `.jslb-code-key`，旧卡全部作废 |
| `tools/issue/keygen.js` | 用私钥**签发卡密**（`JSLB-...`） | 只写编号计数器与 `--ledger` 指定的台账 |

```bash
# 1) 生成密钥对（默认不碰任何文件，公钥私钥都打印出来）
npm run signingkey
npm run signingkey -- --out ./keys          # 落盘到 ./keys（已存在则拒绝覆盖，除非 --force）
npm run signingkey -- --seed <base64>       # 由种子确定性重建，用于恢复
npm run signingkey -- --check <密钥>        # 只校验密钥格式并打印指纹

# 2) 发卡
npm run keygen -- --plan plus --days 365 --count 5          # 5 张，逐行裸卡密（便于脚本）
npm run keygen -- --plan team --days 365 --count 3 --table # 对齐表格
npm run keygen -- --plan plus --count 100 --csv > batch.csv # CSV 导出
npm run keygen -- --plan plus --count 10 --ledger issued.csv  # 追加进台账
npm run keygen -- --plan plus --days 30 --date 2026-01-01   # 指定签发日（补发历史卡）
npm run keygen -- --check <卡密>                            # 校验一张卡

# 3) 查一张卡绑定到了哪台机器（机器码由服务端签发，见"机器码"一节）
curl -s -X POST https://<host>/api/machine -H 'content-type: application/json' \
  -d '{"key":"JSLB-..."}'                                  # → {"ok":true,"machine":"…","issued":false}
```

> **`--bind` 已废除（v5）**：卡密不再携带机器绑定段，"一卡一机"由服务端 KV 赎回登记
> 实现。想解绑一张卡，删掉它那条赎回登记（`jslb:redeem:<编号>`）即可；机器码绑定在
> `jslb:machine:<编号>`，一并删掉才会重新签发一个新的。

**`--date` 值得单独说**：签发日进卡密签名载荷，到期时间由"签发日 + 天数"推出。所以补发
一张标着 2026-01-01 的 30 天卡，有效期就是 2026-01-31，而不是"今天 + 30 天"。这是为了让
到期时间无法在本地被挪动（见 `src/license-core.js` 的 `expiryFromIssueDay`）。

**机器码不再是发卡输入**：它由服务端在激活时随机签发并写进 KV，签发方不需要（也无法）
预先知道。用户报机器码给签发方去 `--bind` 这套流程随 v5 一起作废了。

`--check <卡密>` 仍可用来确认一张卡的套餐、天数、签发日与编号；要查"这张卡现在绑在哪个
机器码上"，查服务端 KV 的 `jslb:machine:<编号>`，或 POST 一次 `/api/machine`（返回的就是
那个恒定值，`issued=false` 表示此前已签发过）。

**编号段只有 40 bit**（8 个 base32 字符，上限 1099511627775）。不显式给 `--id` 时由
`.keygen-state.json` 计数器分配，首次签发以当前毫秒时间戳**取模编号段跨度**为起点；计数器
一旦写出就不再受时间戳影响，逐次递增。若计数器被删后重新分配，新起点可能落在历史编号区间
内——需要严格保证编号不重复，就在调用方自己维护计数并用 `--id` 显式指定。

用自己的密钥对之后，浏览器手里那把内置公钥永远验不过卡密，所以界面做了两条配合：

- **激活交给服务端**。点"激活"先本地验签，验不过就把卡密 POST 给 `/api/license`，
  由服务端用它的公钥验。成功后授权记在服务端（接云存储时按设备码分键），
  之后每次请求只带设备码即可恢复。
- **策略与服务端对齐**。界面启动时从 `/api/plans` 读回网页版策略，因此服务端把
  `requireLicense` 设成 `true`，界面也会同步要求激活，不会一边拒绝一边放行。

### 混淆在哪里跑

界面有**两种**执行模式，由部署决定（`cloudOnly`，`/api/plans` 下发）：

- **云端执行**（本部署，Vercel）：源码 POST 到 `/api/obfuscate`，服务端跑完整流水线。
  代价是吃服务端的 CPU 与带宽预算，收益是**混淆核心不随静态资源下发**，爬站点的
  人拿不到实现。免费档的硬约束（请求体 4.5 MB、单次上传 2 MiB、每日 CPU 300 s、
  函数 60 s）由入口预检强制，超了给的是可读提示。
- **浏览器内执行**（`build:web` 不带 `--cloud`，自建/离线用）：用访问者的 CPU，代码
  不出本机，没有服务端天花板。代价是核心随静态资源公开（已自混淆 + 模块体加密，
  但密钥也随静态资源走）。

**云端执行下两个计数器是分开的，且这是设计如此**（2026-09-25 修显示 bug 时确认）：

| 计数器 | 存在哪 | 统计什么 | 谁读它 |
| --- | --- | --- | --- |
| 本机用量 | 本地签名记录（`consumeRun` 写） | 界面里每一次混淆 | 界面显示的用量、界面侧的配额判定 |
| 服务端用量 | 云存储 | 只有 `/api/obfuscate` 的调用 | 服务端配额判定、程序化调用 |

云端执行时界面在**每个文件成功后**也记一次本机用量，就是为了与服务端那份对齐，
否则两边会越走越远。

两者不合并是有意的：服务端**拒绝采纳**客户端推上来的用量（见 `license-web.importRecord`
的说明——客户端每刷新一次页面就会推一次记录，无脑覆盖等于把服务端累计的用量清零，
`/api/obfuscate` 那边扣的配额会被冲掉，等于白送额度）。

所以**界面上的用量一律按本机记录显示**，不能用服务端那份：服务端那份通常是 0，
显示它会出现"跑完不刷新、刷新后被 0 覆盖"这两个症状。

只有在"本机没有可验签的记录、授权全靠服务端"这个少见的态下才回落到服务端那份，
此时状态栏会说明这一点（`guiServerAttestedHint`）——注意那条提示只在**这个态**出现，
本机有记录时用量走本地、提示也就不该出现。

技术上没有障碍：核心的 `runJob` 只吃一个权益对象、**不再自己验签**，所以服务端
认定的授权同样能驱动本地执行——这正是能去掉服务端执行路径的前提。

未配置 secret 时用内置常量，方便自托管与本地开发。未激活时的行为由网页版策略决定
（`JSLB_WEB_CONFIG`，见下），默认允许试用：上限 `low` 预设、单文件 512 KB、
**每日 10 次**。把 `requireLicense` 设为 `true` 即要求先激活。

### 解除激活

界面上的"解除激活"同时清两端：本机的许可证记录，以及**服务端按设备码存的那一份**。

服务端那份必须带 `X-JSLB-Device` 才能删对——设备码进存储键名，缺了它服务端删的是
无后缀的共享键，这台设备的记录原封不动，刷新后授权又回来了（`src/license-web.js`
的 `scopedKey`）。解除走的是真正的删除（存储 `delete` / localStorage `remove`），
不是写空串。

## 环境变量

| 变量 | 作用域 | 说明 |
| --- | --- | --- |
| `JSLABYRINTH_LANG` | 全部 | 语言 `zh`/`en`（浏览器可改用 `window.JSLB_ENV`）。**服务端只是兜底默认**：文案的语言按请求判定（`X-JSLB-Lang` > `Accept-Language` > 本变量），见「JSON API」一节 |
| `JSLABYRINTH_KEYGEN_STATE` | 发卡工具 | 编号计数器路径 |
| `JSLABYRINTH_CODE_KEY_FILE` | 发卡工具 | 签发私钥文件路径（默认 `.jslb-code-key`） |
| `JSLB_CODE_KEY` | 发卡工具 | **签发私钥**（base64，32 字节种子）。**机密**，泄露 = 发卡权泄露 |
| `JSLB_WEB_CONFIG` | 网页/服务端 | 网页版策略 JSON |
| `JSLB_CODE_KEY` | 网页/服务端 | 覆盖内置签发公钥（base64，非机密） |
| `JSLB_MACHINE_SALT` | 网页/服务端 | 覆盖机器码派生盐（base64，非机密）。只影响未激活时的**兜底**机器码，已激活卡的机器码由服务端签发，与它无关 |
| `JSLB_CORS_ORIGIN` | 服务端 | `/api/*` 的跨域来源，默认 `*` |
| `JSLB_DEVICE_ID` | 网页/服务端 | 固定设备码（仅存储分键与试用计数），便于测试 |
| `JSLB_LIVE_ORIGIN` | 测试 | 线上验收目标站点（**必须显式给**，如 `https://<站点>.vercel.app`；不给则跳过该段） |
| `JSLB_SKIP_LIVE` | 测试 | 设为 `1` 跳过线上验收段，纯离线跑 |
| `DSH_VM_DEBUG` | 全部 | VM 编译失败时打印原因 |

> 已随转向纯云端移除：`JSLABYRINTH_LICENSE_KEY` / `JSLABYRINTH_LICENSE_FILE` /
> `JSLABYRINTH_LICENSE_DEBUG`（Node 端许可证文件机制）、`DSH_DUMP_PASSES`
> （只被已删的 CLI 使用）。现在激活一律在网页界面完成。

## 目录结构

按用途分：`src/` 是跨环境核心，`web/` 是界面，`server/` 是平台无关的服务端实现，
`api/` + `vercel/` 是 Vercel 的接入层，`tools/` 按用途三分。`dist/` 是构建产物，
由 `vercel.json` 的 `outputDirectory` 指定，不参与归整。

```
src/                跨环境核心：浏览器与服务端共用同一份，零宿主依赖
  index.js          公共入口（库用法、网页、服务端都从这里取能力）
  obfuscate.js      核心：pass 编排与自校验
  options.js        默认选项          options-meta.js  选项元数据（界面与闸门共用）
  presets.js        强度预设          plans.js         套餐定义
  plan.js           套餐判定          options-gate.js  套餐闸门与提示（三端共用）
  html.js           HTML 内联脚本      pipeline.js      一次任务的完整流程
  platform.js       运行环境适配层（env/随机数/存储/KV/网页版策略/设备特征）
  license-core.js   许可证校验（三端共用）  license-codec.js  卡密与令牌编解码
  license-secret.js 签发公钥与自身摘要表（**只有公钥**，私钥在库外）
  license-web.js    网页/服务端授权（服务端签发机器码、localStorage/云存储、试用）
  ast/              解析器、生成器、遍历、类型
  passes/           各 pass（vm、stringArray、controlFlow……）
  utils/            hash（纯 JS SHA-256/512、HMAC、base64）、ed25519（纯 JS 签名/验签）、
                    encode、rand、hide、ws、zip

server/            平台无关的服务端实现（Vercel 接入层转调它）
  handler.js        /api/* 的实现：授权判定、混淆执行、机器码签发

api/                Vercel 函数入口，每个路由一个文件（一行转发）
  health.js  plans.js  license.js  machine.js  obfuscate.js

vercel/             Vercel 接入层
  entry.js          共用入口：上传预检 / CPU 预算记账 / 流式回执 / health 上报
  store.js          云存储适配：Upstash REST / 标准 Redis 连接串 / 单实例内存
  redis-tcp.js      零依赖 RESP 客户端（走 REDIS_URL 时用，只依赖 node:net + node:tls）

web/                网页界面源码（原生 ESM，无打包器，无第三方依赖）
tools/
  build/            构建与发布验证  build-web.js（自混淆 + 模块体加密）、
                                  enc-loader.js（加密层实现与引导层生成）、
                                  bench-selfobf.js（自混淆运行期预算基准）、
                                  verify-encryption.js（加密层端到端校验）、
                                  verify-deploy.js（发布验证）
  test/             测试          selftest.js、hashtest.js、semantics.js、bench.js（性能基准）
  issue/            发卡与密钥    keygen.js（发卡）、signingkey.js（生成密钥对）、
                                  keyrotate.js（轮换）、selfdigest.js

dist/               构建产物（web/ 的界面 + src/ 的公开模块），不随仓库分发
```

`server/` 与 `src/`、`web/` 一样零宿主依赖——三者都是能在浏览器和 Vercel 函数里直接跑的
Web 标准代码。构建只复制 `src/` 与 `web/`，所以不需要任何排除表；`--cloud` 再按
`tools/build/gate-policy.js` 剔掉受保护模块。

> **已移除**：原先的 `host/` 目录（`cli.js` 命令行、`directory.js` 目录批量、
> `license-node.js` Node 端许可证）随"全面转向云端"一并删除。这些能力在
> Vercel 函数里物理上不存在对应物：拿不到 `os.hostname()` 与网卡 MAC，
> 也没有 debugger 可供反调试，更没有本地文件系统承载 `license.lic`。
> 现在唯一的授权通道是网页界面 + `/api/*` + 云存储。

## 与改动前版本的差异

行为等价是硬要求：`low`/`medium`/`high`/`max` 四个预设在固定 seed 下的产物与改动前**逐字节相同**
（用同一份输入、同一个 seed 对比过），目录模式、HTML 模式、套餐闸门与配额语义也都保持原样。

> **例外（2026-09-26）**：WASM 相关档位已整体移除——`wasm`、`wasmInterpreter`、
> `wasmThreshold`、`rtDepth` 四个选项，以及 `src/passes/wasm.js`、
> `src/passes/wasmvm.js`、`src/passes/rtgen.js`、`src/ast/wasm.js` 四个模块。
> `medium`/`high`/`max` 此前默认开着 `wasm` 档，产物字节因此改变（少一层 WASM 化
> 与配套运行时）；`low` 此前本就关闭该档，产物不变。同类"删功能"改动请一并跑一遍
> 多 seed 的 medium/high 产物执行比对。

为了跨环境，以下几点必须改动：

1. **CommonJS → ESM**。浏览器与服务端函数只认 ESM，`require`/`module.exports` 全部换成
   `import`/`export default`。所有模块都保留默认导出，调用形态基本不变。
2. **纯 JS 密码学**。`node:crypto` 只在 Node 可用、WebCrypto 又是异步的，卡密验签必须同步且
   三端一致，于是新增 `src/utils/hash.js`（SHA-256、HMAC-SHA256、base64 解码）。
   与 `node:crypto` 的逐位一致性由 `tools/test/hashtest.js` 覆盖（68 项，含分块边界与长密钥），
   改动前签发的卡密与 `license.lic` 仍然有效。
3. **数据文件 JSON → JS 模块**。原生 ESM 的 JSON 模块在各浏览器支持度不一，
   `options/presets/plans/builtin-*` 改成导出默认值的 `.js`。
4. **许可证拆成共用判定与宿主适配**。原 `src/license.js` 里宿主相关的部分拆出；共用的判定进
   `src/license-core.js`，网页/服务端侧新增 `src/license-web.js`。自身文件摘要表覆盖的文件变了，
   `tools/issue/selfdigest.js` 已同步。
   （后续 2026-09-21 转向纯云端时，Node 侧那份 `host/license-node.js` 已删除，
   摘要表相应从 6 项缩到 5 项。）
5. **`Buffer` 与 `process` 出核心**。`Buffer.from(...).toString('base64')` 与
   `process.env.DSH_*` 改成通用实现，`Buffer.byteLength` 改成 `platform.byteLength`。
6. **新增**：`src/platform.js`、`src/pipeline.js`、`src/options-meta.js`、`src/options-gate.js`、
   `src/index.js`、`src/utils/zip.js`、`src/version.js`、`functions/`、`web/`、
   `vercel.json`、`api/`、`server/`，以及 `tools/` 下的 `build-web.js`、`selftest.js`、`hashtest.js`。
7. **版本号**从 `src/version.js` 读（避免浏览器导入 JSON），`tools/issue/selfdigest.js --check`
   会顺带校验它与 `package.json` 一致。

## 测试

```bash
npm test                                 # 核心/HTML/目录/闸门/许可证/网页链路/服务端路由/ZIP/ESM/BigInt + 线上验收
JSLB_SKIP_LIVE=1 npm test                # 同上，但不打网络（纯离线段）
node tools/test/hashtest.js              # 118 项：SHA-256/512、HMAC、base64、Ed25519 与 node:crypto 逐位一致
npm run semantics                        # 语义保持扫描（42 用例 × 4 预设 × 3 seed = 528 次比对）
npm run bench                            # 混淆性能基准（各预设 × 各规模 + per-pass 分布）
node tools/issue/selfdigest.js --check   # 自身摘要表与版本号一致性
node tools/test/webfp.js                 # 浏览器指纹线上实测（playwright + 线上域名）
npm run build:web && npm run verify:enc  # 加密层端到端校验（对 dist，见 README「构建」一节）
npm run bench:selfobf                    # 自混淆运行期预算基准（逐 pass 代价，可复现）
npm run verify                           # 发布验证：打线上域名核对接口、资源与门控
```

### 网络依赖

除「线上验收」段外，`npm test` 全部离线运行，不读凭据、不写仓库内文件。
该段会请求已部署的 Vercel 站点，确认部署与策略真的生效：

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
- `src/passes/logicalExpr.js` 的交换条件在 2026-09-19 修过（静默改值），补了
  4 例 × 10 seed 的取值语义比对回归。这类缺陷的共同点是**不报错**，所以宁可让
  测试慢几秒也要留着。

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
