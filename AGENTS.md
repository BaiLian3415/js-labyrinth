# AGENTS.md

给在本仓库里工作的编码代理及维护者的操作手册。

## 项目是什么

JsLabyrinth：JavaScript 代码混淆与运行时防护。完整运行于 Vercel，Web 控制台
与 JSON API 同域部署，混淆在服务端执行。核心（`src/`）是纯 Web 标准代码。

## 目录约定

| 路径 | 角色 |
| --- | --- |
| `src/` | 混淆核心：AST 解析器/生成器（`src/ast/`）、二十来个 pass（`src/passes/`）、许可证编解码、选项表与套餐闸门。**只用 Web 标准 API，不得 import `node:*`**。 |
| `web/` | 浏览器界面（构建产物为 `dist/`）。同样不允许 `node:` 引用。 |
| `server/`、`api/`、`vercel/` | 服务端执行端（API 路由、自混淆入口）。 |
| `test/` | 自测。单文件可独立 `node test/<file>.js`；共享 `test/_harness.js` 的断言/执行工具。**测试 import src，方向永远单向**。 |
| `tools/` | 维护者本地工具：发卡、构建、验收。 |
| `dist/` | 构建产物，**不要手改**；改源码后用 `npm run build:web`（或 `:cloud`）重新生成。调试先试 `-- --plain`。 |

## 常用命令

```bash
npm test                 # 全部自测（末段验线上，需 JSLB_LIVE_ORIGIN）；纯离线加 JSLB_SKIP_LIVE=1
node test/selftest.js vm # 只跑某一组（core/license/passes/vm…按文件名过滤）
npm run bench:selfobf    # 挑 pass 前的实测基准——按实测挑 pass，不按直觉
npm run build:web        # 界面 + 自混淆核心进 dist（浏览器本地执行形态）
npm run build:web:cloud  # 云端执行形态（核心不进产物，Vercel 部署走这支）
```

## 改动铁律

1. **语义不得因保护而改变**。pass 的任何产物都必须跑出与原生一致的结果；
   编译不了就**放弃这个函数**（保留原样），绝不产出半成品字节码/半成品壳。
2. **核心模块图禁止 `eval` / `new Function` / `Function.prototype.toString` /
   运行期字符串代码生成**。产物构造一律走 AST（`src/ast/types.js` 的 `t.*`）；
   字符串字面量保留的场景由 `__noPool` 标记处理。`test/minify.js` 有对应断言。
3. **选项必须三处同步**：`src/options.js`（默认值）、`src/options-meta.js`
   （UI 元数据）、`src/i18n.js`（错误文案/说明）。漏一处界面即报 undefined 或抛错。
   **删选项还要多看两处**：`src/presets.js`（四个预设各写一遍）与 `src/plans.js`
   （套餐闸门白名单）。删布尔项时 `BOOL_OPTIONS` 由 `DEFAULTS` 自动派生，不用手改。
   **未知选项键会被静默保留**（`resolveOptions` 不报错、也不警告），所以删键/改键名是
   静默失效而非报错——改名或删键必须在 README 写迁移说明并加回归断言。
4. **逐字节可复现是特性**：同一种子同选项必须产出同一份产物。新增随机性要走
   `src/utils/rand.js` 的 `randInt`/`shuffle`/`uniqueName`，不要直接 `Math.random()`；
   固定指纹用的常量逐构建随机化，见各 pass 的注释。
5. **名字流（uniqueName）顺序即产物字节**：给同一条链路加/减一个随机名会改变
   产物形态，属正常；但**对同一配置已有产物做回归比对**时要预期这一点。
6. **JIT/热路径零开销原则**：解释器之外不留每指令都走的额外逻辑；护栏类
   检查（如 vmStepLimit）放解释器体内、按需可关。
7. 注释用中文、说清"为什么"（尤其静默算错/假失败这类教训），不只写"是什么"。

## 命名策略（2026-10-09 重构后）

- **一个选项管全部重命名**：`nameStyle` 是唯一入口，10 档 = 5 个基础档（Mangled /
  Mangled-shuffled / Hexadecimal / Dictionary / Chinese）× 带/不带 `-props` 后缀。
  合法值以 `src/utils/naming.js` 的 `NAME_STYLES` 为**唯一真源**，`options-meta.js`
  的枚举与它对拍（`test/minify.js` 有断言）——写死字符串的话下次加档必然漏改一处，
  而那种漂移表征是"选项能选但没效果"，从产物里看不出来。
- **档位解析只认一处**：`naming.js` 的 `parseNameStyle` / `baseNameStyle` /
  `wantsPropertyRename` / `isChineseNaming`。消费方五处（`mangle`、`renameProperties`、
  `obfuscate` 调度、`integrityCheck` 重算哈希、`options-meta` 枚举与文案），
  谁也不许自己判 `nameStyle`。前后两次同类事故：`chineseNames` 布尔项时期三处各判一遍，
  漂移出"名字是汉字却被转义成 \uXXXX"，产物被自己的完整性校验投毒。
- **名池实现在 `naming.js`，标识符与属性名共用**（`createNamePool`）。原先四个生成器
  私住在 `passes/mangle.js`，`renameProperties` 拿不到 → 它对非 Chinese 档一律发
  `_0x` 随机名，**选了 Hexadecimal 对属性名毫无影响，那一档对属性是假的**。名池是有状态
  的迭代器，两个 pass 各 `createNamePool()` 拿独立的一条流；防撞靠两边都把新名写回
  `ctx.usedNames`。
- **`renameProperties` 布尔项已删除**（并入 `-props` 档）。套餐闸门随之从
  `plans.js` 的一条独立规则改成 `nameStyle` 白名单：free 档白名单**只能列不带
  `-props` 的那一档**，误列一个就把付费能力白送，且 `violations()` 不报错。档位匹配大小写不敏感（`options-meta` 导出了 `toCamel`，但
  **仓库内没有消费方**，不存在「CLI 自动转驼峰」这回事，别照着假设）。
- `identifierPrefix`（默认 `_0x`）**不是**风格选项：它是 8 个文件里机器代码名
  （rtlib/rtgen/shell/banner/esmFold/antiLLM/…）的前缀，以及 `mangle` 名池耗尽时的
  兜底生成器。别把它和 `Hexadecimal` 当成同一件事的两条路。
- 探针要验"名字形状"时记得关 `objectKeyEncoding`：它把属性名拆成计算键
  （`["k"+"e"+"y"]`、`["n","a","m","e"].join("")`），产物里就看不到点号形态的名字。
  另有一坑：`obfuscateDocument` 在 `info.obfuscated === 0`（文档无内联 `<script>`）时
  `html` 返回 **null**，不是产物。

## VM 架构现状（2026-10 重构后）

- `src/passes/vm.js` 是唯一的 VM：AST → 自定义栈机字节码 → 解释器。
  寄存器式后端（`vmRegisterVM`）与多态寄存器模型（`vmPolymorph`/`vmModel`，
  M0/M1/M2/M3）已整体移除，只保留纯栈式核心 VM。
- 多层 VM（`vmLayers`，默认 1）：`2` 把解释器循环本身作为函数体再编译一次，
  外层字节码的解释动作由第二份字节码执行；`3` 再套一层。内外层各自带独立的
  G/H/K/S 表、掩码与字节码加密材料；stats 报 `layers`（实际嵌套层数）。
  wasm 档下要嵌套的函数改走 JS 路径（桥接里无解释器可套），最内层仍以桥接进
  模块；stats 报 `nestedJs`（让路数）。嵌套失败回退单层，不影响语义。
- 字符串去集中化：池校验哈希基数/乘数逐组随机（`stringArray.js hashItems`，
  FNV 字面量只剩 banner 引导哈希）；accessor 解码累加与返回点各 3 形态；
  VM 位置散列（`strPosExpr`）异或结合律 3 形态。
- 控制流去确定性：`controlFlow.js assignState` 30% 包恒真条件
 （`typeof state==='number'`，两分支同一 rhs 克隆）；不透明谓词 guard 熵为
  `Date.now() ^ performance.now()*1000` 双时钟互锁。
- WASM 宿主导入多路复用：按栈元数合并为 u1/u2/v2/bin/un 五入口
 （`wasmvm.js IMPORT_DEFS` + `makeSubCodes`，经 spec 传 `rtgen.js` 分发链），
  子码逐构建稀疏随机；stats 报 `imports`（恒为 5，加回逐语义导入即拦截）。
  改宿主语义时同步改三处：IMPORT_DEFS、codegen 调用点、rtgen 分支体。
- 执行护栏（原嵌套内层档 `vmNestedLimit` 平移而来）：
  `vmStepLimit` 指令步数上限 + 操作数栈深度上限，超限抛 `vmOverrun`。
  `vmStepLimit: 0` 关闭步数闸门。
- 解释器形态：`dispatchForm`（switch/表驱动/嵌套 if/直接寻址）× 循环骨架 ×
  分发桶函数 × junk 声明逐构建随机；单字节码加密用
  「值 ^ posMask ^ 掩码 ^ 链值 ^ 块密钥」，入口按掩码原位重写 B。
- 单层复杂度（2026-10）：融合关系跳转 12 种（JLT/JLE/JGT/JGE/JEQ/JNE 真极性 +
  JLTF 等假极性，比较+条件跳转一字；假极性把 `!` 包在原比较外面，NaN 下
  !(a<b) 与 a>=b 不等价，不敢反转算子）+ 流干扰 NOP（融合后按 8% 注入，
  跳转下标同步重定位；动作为空，进分发即下一条）。发射器只看测试形状
  （关系/恒等比较必融，与随机数无关）；门控：vmDecoyOps=0 时连 NOP 一起关。
  stats.fused 报 {jumps, nops}。WASM 侧经共享 FUSED_REL_OPS 表 + 宿主 bin
  按字查关系算子（imports 恒为 5，不加新导入），NOP 在模块里是空动作。
- **插 NOP 的坏邻接铁律**：`[跳转的链值字][1 字指令][该跳转的目标]` 三连会让
  链求解出现 2-环（链值字按定义取自「目标的前一字」，而 1 字指令在 dynOps 下的
  明文又取自链值字）。wordAt 的不动点循环对环上的链字**保留首轮猜测且静默不自洽**
  —— 不抛错、不触发收敛校验，只是解错：跳转落点按错链值解密 → 落点是非法操作码 →
  级联偏移（整包输出乱码 / undefined / 提前 END）。所以 NOP 一律不插在
  「code[i] 是跳转且 code[i+1] 是任一跳转目标」这个间隔上（`badAdj` 护栏）。
  没有 NOP 时中间那条必须恰是 1 字指令，概率极低，NOP 让它从「极低」变成「每条 8%」。
  定位手法见 `src/passes/vm.js` 该护栏注释：分发前临时打一行 `console.log(npc+":"+dispT)`
  拿执行轨迹，与构建期的 pos 表 / canon 逆表对账；切 `vmDynOpcodes:false` 与
  `vmDecoyOps:0` 各自能消掉症状即坐实本条。回归测试见 `test/vm.js`
  「NOP 不许插在『跳转链字 ↔ 该跳转目标』之间」。
- 形态多态（`src/utils/morph.js`，只收逐位等价的 AST 二/三选一：`declKind`、
  `yodaEq`、`relCmp`、`negCmp`、`boolLit`、`incUpd`、`loopTrue`、`retVoid`、
  `memberDot`；`numLit` 只改原文写法）。铁律：只用于生成的机器代码（不动用户
  AST），操作数必须纯（标识符/字面量/纯数据成员读），`incUpd` 只进 for-update
  槽且目标是数值计数器，loader 顶层一律保留 `var`（载荷 eval 同作用域，
  `var` 改 `let` 会把同名复用变 SyntaxError）。
- 外壳引导器语句多态（`shell.js` 内 `P()` 字符串模板二/三选 + `decStyle`
  解码三形态（0 内联双层循环 / 1 分段 for 助手 / 2 分段 forEach 助手，
  1/2 外层拼回语句也不同构） + 偶数界计数循环展开 ×2 + 装载期死代码 0~14 条）：
  for/while、比较方向、点/方括号调用、var 合/分、xor/加法结合律括号、链式赋值；
  全部手验等价，语义网靠 `test/semantics.js` + `test/handler-poly.js`。
  引导器新固定名必须进 `banner.js randomizeNames` 名单，否则成指纹。
- 原语新族：`mul32-C`（8 位拆分精确式，无循环——移位加版曾在此处，因 32 轮
  循环经控制流扁平化后把大载荷装载拖慢到触发反调试时延拖慢正反馈、产物运行
  超过 60s 测试超时，已弃用；handler-poly ③ 已推广到全族两两等价）、
  `shfl-C`（由内向外、新数组返回；调用点一律取返回值，不依赖原地改写）。
- 原生函数单点收敛（shell 引导器）：`String.fromCharCode`/`charCodeAt`/
  `Uint8Array`/`Array` 各取一次别名（`_0fc`/`_0cc`/`_0U8`/`_0Ar`），调用点只写
  别名；`split`/`join` 给手工拆合二选一。medium 外层实测 fromCharCode=1、
  charCodeAt=2（含引导 FNV）、Uint8Array=1，passes-basic 有精确棘轮。
  教训两条：别名化时不得丢掉查表（如 `_0m2[_0cc(…)]` 写成 `_0cc(…)` 会整包
  解出乱码）；引导器字符串模板只用引号字面量，不用反引号（二次流水线的
  templateToConcat/stringArray 处理含表达式模板会 corrupt 字母表）。
- `"undefined"` 字面量清零：全部 `typeof X==="undefined"` 改写成
  `typeof X===typeof void 0`（逐位恒等，无字面量、无原生、无作用域依赖，
  跨 cjs/esm/严格模式都安全）。发射点在 hide.js、banner、domainLock、
  integrityCheck、stringArray、antiCDP、debugProtection、envFingerprint、
  wasm、antiLLM、opaquePredicates；medium/max 外层实测 0 处。构建期字符串
  （platform、parser 关键字表、绑定名过滤）与 VM 内部 `undefined` 标识不碰。
- WASM 档（`wasm`/`wasmInterpreter`）把取指/分发搬进模块，**关闭**一套运行期
  选项（见 vm() 里 OFF 表）；改动 JS 侧取指式时要同步核对 `src/passes/wasm.js`
  与 `src/passes/wasmvm.js` 的同构实现。
- 已删除：嵌套内层档（`src/passes/vmNested.js`、`src/passes/vmNestedInject.js`、
  `src/core/vmcore.js` 与对应测试）。撤销原因：只认 int32 子集（任意 JS 值会
  静默算错）、第二份手写内核维护贵、实测性价比不成立；其护栏特性已并入
  vm.js 解释器。

## 提交前自检

```bash
JSLB_SKIP_LIVE=1 npm test        # 全绿才收工
node test/passes-basic.js        # 改 pass 时先跑这组
node test/vm.js                  # 改 vm 时先跑这组
```

新增/删除 pass 或选项时同步检查：`src/pipeline.js` 的注册顺序、
`test/selftest.js` 的文件清单、`DEPLOY.md` 与 `README.md` 的说明、
`dist/` 是否需要重建。
