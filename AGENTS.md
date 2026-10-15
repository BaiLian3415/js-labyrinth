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
| `dist/` | 构建产物，**不要手改**、也**不入库**（已 gitignore）。部署时由流水线自己跑 `build:web:cloud` 生成；本地只在要看界面时才 `npm run build:web`。调试先试 `-- --plain`。 |

## 常用命令

```bash
npm test                 # 全部自测（末段验线上，需 JSLB_LIVE_ORIGIN）；纯离线加 JSLB_SKIP_LIVE=1
node test/selftest.js vm # 只跑某一组（core/license/passes/vm…按文件名过滤）
npm run bench:selfobf    # 挑 pass 前的实测基准——按实测挑 pass，不按直觉
npm run build:web        # 界面 + 自混淆核心进 dist（浏览器本地执行形态）
npm run build:web:cloud  # 云端执行形态（核心不进产物，Vercel 部署走这支）
```

**不要手动部署，也不用为部署预生成 `dist/`**（2026-10-11 定）：仓库已绑定 GitHub
（`origin` = `BaiLian3415/js-labyrinth`，主分支 `main`），**push 到 `main` 即自动部署**；
`vercel.json` 的 `buildCommand` 就是 `npm run build:web:cloud`，`outputDirectory` 是
`dist` —— 产物由部署流水线自己构建，`dist/` 也已 gitignore、不入库。

- 别跑 `npm run deploy`（`package.json` 里那条 `npx vercel --prod` 留着只是历史，
  手动跑会绕过 GitHub 集成、也可能把本地未提交的状态推上线）；
- 本地只有在要看界面时才跑 `build:web`，它跟部署无关；
- 改完源码 `git push` 就完事，不需要 `dist/` 干净、也不需要本地验证部署。

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

## 产物构造：AST 合法 ≠ 打印形式合法（2026-10-12 实测）

- **生成器的"优先级括号"是逐位置手工维护的，新增节点类型必须同时补括号**。
  `src/ast/generator.js` 里绝大多数表达式位置走 `_str(expr, minPrec)`（优先级不够
  就补括号），少数直接 `_node(expr)`。`SequenceExpression` 的优先级最低（`PREC.Sequence=0`），
  而它恰好是 **AST 合法、但很多语法位置不接纳**的节点：`yield a, b` 读成 `(yield a), b`、
  `await a, b` 读成 `(await a), b`、`f(a, b)` 读成两个实参、`{k: a, b}` 读成两个属性、
  `[...a, b]` 展开的是 `a`、`var x = a, b` 变成两个 declarator、`class A { v = a, b }`
  变成两个字段。
- **实测踩到的那一处**：`_yieldExpression` 直接印操作数，而 numberObfuscation 的运行期
  状态形态（`rtState`）产出的正是逗号表达式，于是
  `class A { *it() { yield 9; } }` 被改成
  `yield C=C*48769+51123&131071, 126054494^C^(126054494^9^C)`，yield 出去的是计数器
  状态 65571 而不是 9。**构建期全绿、产物能跑、不报错**，症状只是"某个数字常量算错了"。
  30 个 seed 里错 1 个（high/medium seed 6、max seed 10），与 VM、扁平化都无关——
  先怀疑组合、最后定位到单 pass 的前提是错的。
- 已补的位置：`yield`/`await` 操作数、展开与剩余、解构默认值、计算属性键（对象/类方法/
  类字段）、标签模板的 tag、类字段初值、成员计算下标。判据是**运行结果**不是文本
  （每个用例的逗号左侧都有可观测副作用），见 `test/minify.js` 的"生成器优先级"一节，
  其中另有一条断言专门确认"去掉括号后值确实改变"，防止断言写成恒真。
- **节点工厂丢字段 = 往返一次就坏**：`ClassProperty` 曾经不带 `computed`，解析进来的
  计算键被打成 `class A { ("f")=1; }`（括号在、括号对没了），第二轮解析报"无效的属性键"。
  加节点字段时要问一句"生成器和 keys.js 是否都认它"。
- **自家解析器要能读回自家产物**。这条不变量正是上面那个 bug 的发现手段：给
  `test/passes-basic.js` 写"计算键往返可解析"的断言时，先撞上了 parser 的
  `get`/`set`/`async` 判定只认「标识符 + 左括号」，读不了 `get ["x"](){}`。已改成
  `_nameThenKey`（名字/字符串/数字/`[`/`#`，async 另允许 `*`），对象字面量的
  getter/setter 键也改走 `parsePropertyKey`。

## 外壳解码链 IR（2026-10-10 新增，`src/passes/shellir.js` + `shellemit.js`）

- **不要手写字节码。** 2026-10-09/10 连续两天各栽一次：先把 477 个字的栈式程序
  手写出来（错），改成"声明式 IR + 两处发射"才对。理由不是"手写慢"，而是**手写栈序
  必然错且错得安静**——见下面五条，每一条都不是算法问题。
- 结构：三地址 + **结构化**控制流（`If`/`For`/`Continue`），没有标签、没有回填。
  `&&`/`||`/三元**刻意不做表达式节点**——短路要求"压一半栈再跳走"，与"表达式恰好压
  一个值"这条不变量天然冲突，做成语句（`or1` / 嵌套 `If`）就没有这个问题。
- **唯一不变量**：`emitExpr` 发射完恰好在操作数栈上留一个值。整份文件里压栈只经
  `emitExpr`、弹栈只经 `pop()`。破坏它的后果只会是"三路对拍挂掉"，不会伪装成算错。
- 正确性靠**三路对拍**（`test/shell-bytecode.js`）：手写参考实现 ⟷ `emitJs` ⟷
  `emitVm`。基准必须是**独立逐句转写**自 shell.js 的第三路；只有两路时两个发射器完全
  可能一致地错（IR 写错一个符号，两边一起错，对拍照样全绿）。
- `emitVm` 内置 `verifyVm` 构建期自检：顺字流模拟栈深、核对槽位与跳转目标越界。
  这道检查的价值在于把"运行期读到 undefined"提前成"emitVm 返回前就炸，并指出 pc"。
- **已接进 shell.js**（2026-10-10）：`shellForm: 'bytecode'` 走这条路，接线点在
  `makeShellLayer` 的解码链分支——`if (bytecode) {…} else { classic 的 A/B/C 三段 }`，
  「字节→字符串」与「eval/import 交付」两段仍在 `else` 之后，两种形态共用。
  `shellWrap` 里传 `{ bytecode: true }` 作 variant（其余变体字段留 undefined 继续随机）。
- **classic 必须逐字节不变**：接线前后在 36 组配置（3 源码 × 4 预设 × 3 seed）上比对
  sha256，零差异。改默认形态的任何一行都是在破坏可复现性承诺，比收益大得多。
  （2026-10-11 补：这条约束的是**接线**类改动。安全修复可以改 classic 的 loader——
  见下面两条——但那样一来旧的逐字节基线必须重取，别拿旧 sha256 当回归依据。）
- **投毒响应必须铺满整条密文**（2026-10-11 实测）。原来只重掩前 ≤8 字节
  （`lim = min(L, 8)`）：钩 eval 实测拿到 166 KB 载荷、**只有头 8 字节是乱码**，
  攻击者补一个合法前导（`!function(){`）就整份救回来。要命的是**所有**检测
  （原生探针、差分校验、FNV 尾校验）背后都只有这一处响应——响应太弱等于检测没做。
  现在按 `bd` 派生的滚动密钥异或全长度；`bd === 0`（未改动）时整个分支不进入，
  逐字节不变，代价只在被篡改时多一次 O(n)。公式是自洽的（生成端与运行端同一份），
  所以**移位与遍历方向逐构建随机**：新增固定形态会立刻被 `test/passes-basic.js` 的
  跨 seed 结构相似度棘轮抓到（本轮实测 0.92 → 0.931 就是这么暴露的）。
- **原生性探针必须多路径**（2026-10-11 实测）。`(""+eval).indexOf("native")` 一行就能
  骗过：`hookedEval.toString=()=>'function eval(){[native code]}'`——实例属性优先于
  原型方法。现在 `_0ph` 查三条互相独立的路径：① 实例 `toString` 必须**仍等于**
  `Function.prototype.toString`（抓住上面那种自身属性伪造）；② 经**原型方法**调用
  stringify 目标、源码里必须含 native；③ 该原型方法 stringify 它自己也必须含 native。
  抛错一律判为被钩（fail-closed：让探针抛错本身就是绕过手法）。
  **残余风险（实测仍在，未解决）**：把 `Function.prototype.toString` 整条替换成
  会为"自己和目标"伪造 native 文本的函数，仍能骗过探针 dump 出内层载荷（产物随后
  跑不完，`vm: 解释器执行超限`）。彻底堵住需要一条 JS 不可观测的通道，属研究级，
  不在本轮范围——别把它当成"已经解决了"。
  **同一口径覆盖三处，缺一处等于没做**（2026-10-11 补齐）：`shell.js` 的 `_0ph`
  （classic 内联探针 + bytecode 形态的 `_0pw` 原语表外壳）、`rtgen.js` 的 `hb` 心跳、
  以及 rtgen 里 WebAssembly 获取器链的四个原生性检查。rtgen 那两处的实测：
  把 `RegExp.prototype.test` 换成**行为等价**的包装、只把自身 `toString` 伪造成
  "[native code]"，在 `wasmInterpreter` 内核档的热样本上——加固前产物照常输出
  正确结果（探针被骗过），加固后输出变成 `NaN`（内核 `pois` 置位，值语义入口
  一律返回 0）。
  **可达性事实**：`hb` 心跳来自多路复用导入链，而那条链要 `wasmvm` 传 `subCodes`
  才生成——所以**只有 `wasmInterpreter` 内核档**有这个探针；旧 `wasm` 档（high）
  压根没有心跳链，别拿 high 去验它（实测 high 加固前后都"无差异"，不是没生效，
  是没有这个探针）。同理，验这类探针的样本必须让心跳越过 `hbw[0] < 16` 那道门
  （小样本跑不满 16 次心跳，探针一次都不执行，会得出"没效果"的假结论）。
- **响应不能只落在可挂钩的全局属性上**（2026-10-11 实测）。健康载体与毒药键都是
  **全局属性**，而全局属性可以用 `Object.defineProperty` 钉死。实测三行
  （载体 `get→健康常量 / set→空操作`，毒药键同理）就能把**全部**检测的响应吞掉：
  钉死之后再篡改引导锚点字面量，产物照常输出正确结果（未钉时同样篡改会抛错）。
  检测再多，响应只有那几个落点时，三行就解除。**唯一实测有效的修法**是让响应走
  **载荷本地通道**：校验器的偏移**同时**累加到**访问器函数对象自己的一个随机名属性**
  （`couple.prop`），读取端 `dk = ((G[载体]|0) - OK) + (访问器[prop]|0)`。要解除就得
  改载荷代码，而访问器本体**在校验面内**（源码参与哈希），改它偏移立刻非零。
  - 关键设计：本地项**不需要初始值**——未改动时该属性从未被写过，`(undefined|0)` 就是 0，
    所以校验器的"早带"（先于池声明执行）不会误报，避开了"谁先执行"这个坑；写入必须
    **累加**（`x=((x|0)+delta)|0`）而不是覆盖，否则后一次 0 会把前一次的偏移抹掉。
  - **别在引导层加"锚点被改就把盐 XOR 常量"**（2026-10-11 试过，已回退）：盐本来就是
    **重算出来的散列**，字面量被改时 `nH` 必然 ≠ `clean`，外壳用错盐解出的载荷本来就是
    乱码——实测 `shell:true` 改锚点即抛错，加不加那句一模一样，纯安慰剂。唯一的例外是
    构造出 FNV 碰撞（`nH===clean`），而那时这句也不触发。
  - 因此**残余**（已知、未解决）：`shell:false` 且锚点被改时，若攻击者钉死载体与毒药键，
    这一路的响应确实会被解除。但 `shell:false` 的载荷本来就是明文，攻击者没有动机走这条
    路；这一路的价值在于"载荷被改"的检测，而那半边已由上面的本地通道覆盖。
  - 实测（2026-10-11）：把读取端那一项换成非零常量 → 字符串池立刻解错（THROWS），
    且**同时钉死全局载体与全部毒药键也照样 THROWS**；改造前读取端根本没有这一项。
    回归断言在 `test/passes-defense.js`（读取端/写入端两处 + "累加而非覆盖" + 关闭
    耦合链时读取端不读它）。判本地项时**别只搜 `["__d…"]`**：另有 pass 也用 `__d`
    前缀的全局属性名，只认读取端形态 `["__d…"]|0)`。
  - 教训：**"看起来更强"的改动也要 A/B 量一遍再写文档**。这条差点作为"数据内在响应"
    写进手册，实测才发现它与原行为完全等价（原来盐就已经是错的）。
- `_0ph`（探针判据）/`_0pw`（探针外壳）是 loader 固定名，**必须**留在
  `banner.js` 的 randomizeNames 名单里；`_0lim` 随 8 字节上限一起删除（名单里也别留死项）。
- **与 jsfuck 互斥**：`jsfuck` 改的正是「密钥流 + 校验尾」那段**明文**，bytecode 形态
  里那段已经不在明文里。同时指定时以 bytecode 为准（`jsfuck && !useBytecode`）。
- 字节码形态的固定名分两类，**别把两类混为一谈**（2026-10-11 修正，原文档写的 `_0bv`
  在代码里根本不存在）：
  - 进 `banner.js` randomizeNames 名单的：`_0bw`（密文字节码）/`_0bt`（原语表）/
    `_0bc`（常量池）/`_0bl`（局部表）。它们在流水线内，靠名单逐构建改名。
  - 够不着、由 `makeShellLayer` 自建名字的：**解释器本体**（`bcFn`）与 JSFuck 核心名
    （`jsfuckCoreName`），形状都是「`identifierPrefix` + 9~13 位 hex」——长度也随机，
    免得固定位宽变成指纹；下界 9 位刻意长于 mangle 命名族上界（8 位 hex）以避开撞名，
    并逐名对着 `mode.usedNames` 查重（`shellWrap` 第二个入口必须把 `ctx.usedNames`
    传进来，否则那道守卫是死的）。
  - 解释器内部的短名（`_w`/`_t`/`_c`/`_k`/`_x`/`_p`）刻意不带 `_0` 前缀——`\b` 词边界
    匹配不到，且它们属于「通用解释器」这一固定形态，变化由操作码表逐构建随机承担。
- **局部表要一次性给全长度并把非输入槽填 0**：留洞的话万一读到是 `undefined` 而不是 0，
  是静默算错的典型来源。接线时最容易漏的两处是**变量名映射**（IR 槽位 ↔ `_0xx`）与
  **原语表顺序**（`xs32/mix/ipos/mul32/_0cc` 与 IR 里 `PRIM` 下标对齐），两处错了 IR
  层的三路对拍完全看不出来，只在运行期表现为解出乱码——所以必须另有端到端用例。
- `stats.form` 要逐个点名（classic/jsfuck/bytecode），把 bytecode 归到 classic 会让
  「这份产物外层能不能被顺着读」这个唯一在意的信息失效。
- **解释器多态**（`emitInterpreter` 的**五**条轴）：分发形态 3 种（`switch(op)` /
  `switch(稠密表[op])` / `if-else` 长链）× 循环骨架 3 种（`for(;;)` / `while(1)` /
  `for(;1;)`）× 局部短名 4 组（`namePool`）× **handler 发射顺序**（2026-10-11 加：
  每条 case/比较自带标签，顺序纯属写法）× **handler 算式等价式**（2026-10-11 加：
  对称算子交换 `a&b`↔`b&a`、`a<b`↔`b>a`，比较归一化 `(c)?1:0`↔`+!!(c)`，
  `x>>>0`↔`(x|0)>>>0`）。
  - 实测（10 seed / 45 对）：加后两条轴之前，**归一化形状完全相同的有 3 对、只有
    7/10 个不同形状**——形状相同就是可跨构建对号入座的签名锚点；加之后 **0 对、
    10/10 全不同**；对顺序敏感的相似度（LCS 比率）max 1.000 → 0.823、mean 0.888 → 0.735。
  - **`passes-basic` 的 bigram 多重集棘轮对这一轴是瞎的**（多重集对顺序不敏感，实测
    0.998 → 0.998）。这一轴由 `test/shell-bytecode.js` 的专门断言钉住（case 发射顺序
    不再升序、`truthify` 两种写法各出现一次、两轴都改变源码）——别指望相似度棘轮守它。
  - 只准用**逐位等价**的改写：只有对称算子能交换操作数（`a-b` 写成 `b-a`、`a<<b`
    写成 `b<<a` 是"错了但大部分用例看不出来"的典型，减法与移位会当场露馅）；
    `+!!(c)` 只把布尔化结果变 0/1，不对操作数多做一次求值。
  - `ri` 缺省时（三路对拍里不传 `randInt` 的那条路）这两个开关取 false、顺序不打乱，
    与改造前逐字节一致——所以新增轴不动摇那条对拍基线。
  - 短名池**必须连 case 体里的局部名一起参数化**（`NAME_SLOTS` 20 个槽一起分配）：
    那些名字是函数级 `var`，与池相撞就是同函数内重复声明——要么 SyntaxError，
    要么后者覆盖前者（表现为"某个操作码算错"，与病因隔两层）。
  - if-else 形态**必须先把操作码取进局部**再比较：`W[pc++]` 写在比较式里会被求值
    N 次（一条 case 一次），从第二个分支起全在拿操作数当操作码比。
  - 稠密表的表项值必须是**该操作码自己在 cases 里的下标 + 1**，与 case 标签同源；
    按各自排列发（一个用打乱序、一个用原序）会让两者对不上，执行到**别的**操作码的
    代码，症状是 `tbl[undefined].apply`。
  - **解释器本体不进自混淆流水线**（`mode.bytecodePrelude`，shellWrap 拼在流水线之外）。
    理由：流水线会把 case 标签的数字改写成带状态的逗号表达式（`controlFlow` 的
    `assignState`），标签值于是依赖可变状态 `M`——该 case 跑一次后 M 变了，**第二次**
    分发到同一操作码就连不上，落进 `default:throw "vm"`。产物跑完第一圈字节码就死，
    报错点与病因隔三层。这也是解释器本体不在 `randomizeNames` 名单里的原因（够不着），
    它的名字由 `makeShellLayer` 自建「`identifierPrefix` + 9~13 位 hex」。

## 预设强度与「静默变弱」（2026-10-10 实测）

- **预设漏写一项 = 静默变弱**，因为 `resolveOptions` 会回落 `DEFAULTS`。改预设时必须
  对着 `DEFAULTS` 逐项问一遍"这一项在低档是什么、在高档是什么"。已经踩到两处：
  - `debugProtectionInterval`：high 是 `1` ms，max 曾是 `2000` ms —— 强度档越高、
    反调试自检反而稀了 2000 倍。纯数值笔误，不报错。
  - `vmMacroOps` / `vmDynOpcodes`：high 开、max 不写。但**max 不需要补**——它们
    在 `wasmInterpreter` 内核档下本就不生效（实测补进 max 后产物与基线**逐字节相同**，
    vm stats 恒为 `macros.fused:0` / `dyn.applied:false`）。补了只是安慰剂，还会让
    读预设的人以为它开着。
- **`vmLayers >= 2` 是坏值，已钳到 1 并告警**（`obfuscate.js` 的 `clippedVmLayers`，
  文案 `warnVmLayersClipped`；界面 `min/max` 同步收到 1）。这是本项目**最难归因的
  一类坑**，教训比结论重要：
  - 2 层（把解释器循环本身再编译一次）在**小函数上完全正常**。2026-10-10 就是因为
    只用小程序验了一把（`a(9)`、`b(4)` 这类），把 `vmLayers: 2` 开进了 max 预设，
    回归因此漏网。**带循环的样本才有判别力**：纯 JS 路径循环约 **200~400 次**就死，
    wasm 路径 N≥5000 即线性内存耗尽（`memory access out of bounds`）。
  - 3 层更早就坏：连**不含循环**的函数都跑不完。
  - 根因方向：2 层把解释器循环编成外层字节码，内层的操作数栈与局部表全落在外层栈
    上，而这个栈的容量在**编译期**按被编译函数静态定出。小函数估得准，大函数实际
    用量超出估计就越界。要真修得让外层栈运行期可增长（wasm 侧还要线性内存增长），
    是 `vm.js` 的结构性改动，不是一行钳位。嵌套实现仍在 `vm.js` 里，只是选项层够不着。
  - 钳位而不是默默产出，理由同 target 降级：**会在某个循环次数上死掉的产物最坏**——
    大部分时候正常，用户会以为是自己代码触发了什么边界。
- **「在小样本上验过」不等于「验过」**。凡是带状态机/嵌套解释器/自增计数的东西，
  回归样本的规模必须越过它的已知边界；`test/vm.js` 的多层 VM 两节现在都固定用
  2000 次循环的样本，就是这个原因。
- **实测优先于读配置**。这一轮有三条结论与"看预设文件"的直觉相反（两条"漏写"里一条
  不用补、一条方向被误判为更弱实为更强：`wasmThreshold` 的 `0` 是**不设限**、
  `stringSplitThreshold` 降低是**拆得更多**）。凡是给预设提强度，先跑一次对比
  **产物字节数与 vm stats**，再决定。

## 选项说明的写法（2026-10-10 定，`src/options-meta.js`）

- 房规：**1~2 句短话**，只说「做什么」与「这个数值/枚举是什么意思」。不写实现细节、
  不写历史沿革、不写动机——动机在 README 与 AGENTS 里各有一处正本，选项提示只负责让
  用户在选一个值之前知道自己在选什么。当前平均 39 字/项，上限 220 字（`test/minify.js`
  有断言）。
- **简化不等于删掉警告**。`htmle` 的"loader 执行前没有正文""href/src 保持原样"是用户
  必须知道的事实，不是细节；删了会被 `live-verify.js` 拦下。凡是被测试点名的句子，
  都在说明它是"承重的"。
- 两个易漏处，`test/minify.js` 都有断言：
  - 布尔项的说明在 `BOOL_HINTS`，标签在 `BOOL_LABELS`。**两者是分开的两张表**，
    只在标签表里加一项、忘了 `BOOL_HINTS`，界面上就是一个没有任何说明的开关
    （`wasm`/`wasmInterpreter` 曾经如此）。断言以 `guiOptions()` 为准，不以
    `VALUE_OPTIONS` 为准——后者看不见布尔项。
  - 说明里点名别的选项时，改名/删项之后最容易漏改这种交叉引用，而它不报错，
    用户读到的是一个不存在的选项名。

### 这两天踩的坑（都是"手写栈序"的账单，与算法无关）

1. **弹栈必须 `SK[--sp]`，不是 `SK[sp--]`。** 后缀 `--` 取旧值再自减，于是读到的是
   "栈顶之上那一格"（越界 undefined），而真栈顶从没被弹出，栈指针整体偏一格。症状是
   `ADD` 算出 NaN、`AGET` 报 `undefined[undefined]`——离病因两层。
2. **操作数栈与局部表必须两个数组。** 图省事让栈直接用局部表（`pop` 读 `T[sp--]`、
   `push` 写 `T[sp++]=v`）时，每压一个值就覆盖一个局部（循环游标被冲成几十）。
3. **`op()` 必须返回"第一个操作数"的下标。** 写成 `const at = w.length; op(name, 0)`
   时 `at` 是**操作码**的位置，回填跳转目标就把操作码覆盖成了目标地址。
4. **取指口径**：`switch(W[pc++])` 执行完 pc 已越过操作码，操作数一律 `W[pc++]`；
   写 `W[++pc]` 每个操作数都读错一格，而程序照样跳得起来、只是跳去奇怪的地方。
5. **`JZ` 是无条件弹栈的。** `v = e || 1` 直接 `JZ` 判原值会判完就丢，末尾 `ST` 从
   空栈里弹。需要 `DUP` + `POP` 让"复制一份去判零"有正规表达。
6. **两个发射器共用一个 `switch` 块作用域时 `var a` 会互相盖**（U32 曾"借用"别的
   case 的 `var a`）。一元运算也要自己弹栈。
7. 校验尾 4 字节的移位**四项都要写**：大端序末项移位恰是 0，省掉也对，于是这处省事
   在大端全绿、**只在小端全错**。这就是对拍用例必须两种字节序各覆盖一组的原因。

## 引导层用「轻装档」（2026-10-11，`src/obfuscate.js` 的 `bootOpts`）

- **引导器自混淆过的是"每次启动都要跑一遍"的代码**，与载荷的性质根本不同：载荷是
  跑一次的业务逻辑，引导器是跑一次的开机程序。所以两者该用不同强度的档，此前没分开，
  max + 壳 1 层的**纯启动**要 3.2 s、壳 2 层 8.6 s。
- 轻装档关掉的是「会把直线代码炸开」的几项：`controlFlowFlattening`、
  `controlFlowLoopFlattening`、`functionWrapper`、`callProxy`、`deadCodeInjection`、
  `opaquePredicates`，顺带 `sentinelRate: 0`（哨兵要注入扁平化后的控制流，扁平化关了
  就没有落点）。保留的是几乎不增体积、且对隐藏引导器固定名有用的那几项：
  `logicalExpressions`、`conditionObfuscation`、`objectKeyEncoding`、
  `templateToConcat`、`mangle`。
- 实测收益（max，N=0 即纯启动）：壳 1 层 3235→688 ms、壳 2 层 8558→**1006 ms**、
  壳 3 层 15615→1519 ms；产物 545 KB → 99 KB。**载荷侧的保护一点没减**，减的只是
  "保护外壳自己"。
- 为什么这样减不亏：外壳**自带校验尾**（`_0bd` 差分校验），篡改引导器去改载荷会在
  外壳自己的校验处失败。所以给引导器再套 `integrityCheck`/`selfDefending` 是重复的。
- 这不是"给 max 开后门"——它对所有预设、所有壳形态生效，且与 `shellForm` 无关。

## 目标宿主约束（2026-10-09 新增）

- `src/target-runtime.js` 是**产物目标运行时**的唯一事实源。注意与
  `src/host-limits.js` 区分：后者讲的是**部署方**（Vercel 函数）的包络，与产物跑在哪
  是两件事。
- workerd 的硬限制（Cloudflare 官方文档 "Web standards"，2026-04-23 版）：
  禁 `eval()`、禁 `new Function`、禁 `WebAssembly.compile` / `instantiate(buffer)` /
  `compileStreaming` / `instantiateStreaming`；`Date.now()` 与 `performance.now()`
  **冻结**在最后一次 I/O、不随代码执行推进；URL 只支持 http/https；timers 只在
  Request Context 内可用；开了 `global_navigator` 时 `navigator.userAgent ===
  'Cloudflare-Workers'`。
- **受限目标下强制关掉 + 告警，绝不默默关**（`obfuscate.js` 里 `suppressedByTarget`）：
  关掉 shell、wasm 两档、debugProtection、antiCDP。前三个是抛错级别；后两个是
  **静默失效**（时钟冻结 → 差值恒 0 → 阈值永不成立）。统一在 `i18n.js` 的
  `warnTargetSuppressed` 里说清"关了哪些、为什么"。
- 识别只看**结构性**特征（`export default {fetch|scheduled|queue|email}`、
  `addEventListener('fetch'|'scheduled')`、`env.X` + `ctx.waitUntil` 且是模块），
  不看字符串字面量——否则代码里写个 `'cloudflare'` 就被误判。判不准靠
  `target: 'cloudflare-worker'` 显式兜底。
- 改动壳/wasm/时序哨兵时要问一句"这在 workerd 上能跑吗"。今天的教训：Worker 脚本走
  ESM 壳（`createObjectURL` + 动态 `import()`），workerd 两条都不通，产物
  **434 KB 且部署即抛**；关掉壳后 42 KB 且能正常跑。"保护层看着有、产物不可用"比没有
  保护更糟。

## 命名策略（2026-10-13 拆分后）

- **两个正交的东西分两个选项**：`nameStyle` 只管**标识符的名字形状**，5 档（Mangled /
  Mangled-shuffled / Hexadecimal / Dictionary / Chinese）；「连属性名/对象键一起改」是
  独立布尔项 `renameProperties`（界面上是单独一个开关）。2026-09 曾把后者编码进档位串的
  `-props` 后缀（10 档变体），2026-10-13 拆开：想改属性名就得先把标识符形状也一起换掉，
  而界面显隐还得为每个基础档写两条 `oneOf`——两个都不值当。
  合法值以 `src/utils/naming.js` 的 `NAME_STYLES` 为**唯一真源**，`options-meta.js`
  的枚举与它对拍（`test/minify.js` 有断言）——写死字符串的话下次加档必然漏改一处，
  而那种漂移表征是"选项能选但没效果"，从产物里看不出来。
- **旧 `-props` 写法必须继续可用**：`parseNameStyle` 仍认后缀，`resolveOptions` 把它
  归一化成 `nameStyle: 基础档` + `renameProperties: true`。删键而不留兼容路径就是
  `resolveOptions` 的静默保留（本仓库明令禁止的失败形态）。
  **归一化必须在 `resolveOptions` 里做，不能放到后面的归一化块**：那里已经看不到
  `src`（用户原始输入），而四个预设都显式带了 `renameProperties: false`（套餐闸门要求
  被约束的键在预设里有取值，`plan.js` 的 `assertConsistent` 会报缺项），于是分不清
  "这个 false 来自预设还是来自用户"。优先级固定为
  **用户显式的 `renameProperties` > 档位串旧后缀 > 预设/默认值**。
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
- **属性名的「定义面」要覆盖全部定义语法**（2026-10-15 修过一个洞）：`renameProperties`
  只改「程序内定义 ∩ 被访问」，而定义面原先只收**字面量**类节点（ObjectProperty /
  ObjectMethod / ClassMethod / ClassProperty）。`this.foo = v` 是实例字段唯一的定义形式，
  落在访问面而非定义面 → 候选为空 → **整个类的实例属性一个都改不了**，原名原样留在产物里
  （实测 Account 类 8 个成员只改掉 4 个）。现在 AssignmentExpression / UpdateExpression 的
  `this.<prop>` 也计入定义面。
  - **`super.foo = v` 不算定义**：它走原型链上的 setter，不在本类上建属性。误收进定义面
    的话子类赋值被改名而父类读取没改 → 属性分裂、语义静默走错。
  - 新增定义形态时，**判定必须与访问面那套 MemberExpression 逻辑同构**（点形态取
    Identifier、计算形态取 StringLiteral）。定义面认得而访问面认不得 → 赋值点改名而读取点
    不改 → 直接跑炸。
  - **改这块前先问一句"这个语法在这个语言里还有别的定义形式吗"**：解构模式里的
    ObjectProperty 是绑定名不是属性名（已排除）；静态块 `static { this.x = 1 }` **已经
    覆盖**（判据 `object.type === 'ThisExpression'` 在静态块里同样成立，而属性改名是
    纯名称替换，静态/实例落在不同存储上与改名无关）；`#private` 是 PrivateName 不改；
    **`对象名.属性 = v` 明确不覆盖**——`obj` 可能是函数形参（外部传入），也可能有别名
    （`var B = A; B.x = 1`），不做出处分析就改名会改坏调用方。要覆盖它得先做别名分析。
  - **探针的名字不能取自 `RESERVED_PROPS`**（value/state/type/data/size/length…）。
    那些名字本来就该原样保留，拿它们当探针会把"刻意的白名单"误读成"漏改了"——
    2026-10-15 写静态块断言时用 `value` 当探针，断言挂掉后一度以为静态块是坏的，
    白排查一轮。
- **套餐闸门两条并存**：`plans.js` 的 `nameStyle` 白名单（free 只放行 Mangled 与
  Mangled-shuffled）+ `renameProperties: false`。拆开之后第二条从"多余"变回必需——
  属性名改名是付费能力而它不再由档位串承载，唯一拦住 free 的就是这条规则。
  好处是白名单不必再守"只能列不带 `-props` 的档位"这条隐约束（违反它会把付费能力白送，
  且 `violations()` 不报错，只会说"free 也能用这档"）。档位匹配大小写不敏感（`options-meta`
  导出了 `toCamel`，但**仓库内没有消费方**，不存在「CLI 自动转驼峰」这回事，别照着假设）。
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
- 多层 VM（`vmLayers`）：实现仍在 `vm.js` 里，但**选项层已关闭**——`>= 2` 一律钳到 1
  （见上一节）。形态是：外层函数体把解释器循环本身再编译一次，内外层各自带独立的
  G/H/K/S 表、掩码与字节码加密材料；stats 报 `layers`（实际嵌套层数，现恒为 1），
  wasm 档下要嵌套的函数会改走 JS 路径让路（`nestedJs`）。要重新放开得先修外层栈的
  运行期增长，不是把钳位删掉就行。
- 字符串去集中化：池校验哈希基数/乘数逐组随机（`stringArray.js hashItems`，
  FNV 字面量只剩 banner 引导哈希）；accessor 解码累加与返回点各 3 形态；
  VM 位置散列（`strPosExpr`）异或结合律 3 形态。
- 控制流去确定性：`controlFlow.js assignState` 30% 包恒真条件
  （形态见下一条，2026-10-11 起已不是"两臂同形"）；不透明谓词 guard 熵为
  `Date.now() ^ performance.now()*1000` 双时钟互锁。
- **恒真谓词不许两臂同形**（2026-10-11 实测）。旧形态 `typeof state==='number'?A:A`
  的两臂是**逐字克隆**，所以"两臂结构相等即折叠"这条**零语义**捷径就够把所有包裹删掉
  ——AST 比一下两臂即可，5 个 seed 实测能折掉 **29 处**（每 seed 5~10 处），等于没加。
  现在：① 两臂语义恒等但**文本不同**（`A` 与 `(0,A)`/`(void 0,A)`——逗号表达式返回
  右值，对任意值恒等，不改类型也不多求值）；② 谓词扩成 5 种**对任意值恒真**的
  位运算恒等式，操作数一律先 `|0` 归一化到 int32（state 万一不是数字也恒真）：
  `(S>>1)*2+(S&1)===S`、`(S&-2)|(S&1)===S`、`(S^(S&1))+(S&1)===S`、
  `((S|1)>S)===((S&1)===0)`、以及原来的 `typeof S==='number'`。
  实测同样 5 个 seed：可零语义折叠的包裹 **29 → 1**（那 1 处来自别的 pass 的偶发三元）。
  回归断言在 `test/passes-basic.js`（AST 上统计两臂结构相等的三元数，阈值 ≤1）。
  - **量这类东西必须关掉 VM**：函数被搬进字节码解释器后扁平化不落在可见代码上，
    第一版度量因此得到"0 个谓词"的假结论（差点白放过这个弱点）。
  - 恒等式一律走**移位/按位**，不用乘法：`(S>>1)*2` 在 float64 里精确
    （`|S>>1|*2 ≤ 2^31`），而 `S*S` **不精确**——大数先被舍入成 float64 再 ToInt32，
    奇偶性就不保了，`(S*S-S)&1===0` 这种"数学上恒真"的写法在 JS 里是错的。
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

## 套餐定价与购买订单（2026-10-11，`src/pricing.js` + `src/orders.js`）

- **价格只有一个数据源**：`src/pricing.js` 的 `PRICES`。金额一律用**分**（整数）——
  用元做浮点会出现 `29.99*3 = 89.96999…`，而支付核验是等值比较，差一分就是"付了不认"。
  能力面（闸门/配额）取自 `src/plans.js`，价格取自 pricing——两处拼在一起渲染，
  页面上写的权益才等于闸门实际放行的权益（这一页最容易出的错就是"写 high、只放行 medium"）。
- **`normalizeFen` 不做元换算**：订单全链路是分，悄悄按 ×100 解释一个整数会让
  29900（分）变 2,990,000。买家手输的"元"文本走 `parseYuan()`。这两个函数分开是
  被一次真实故障逼出来的（`amount: 29900` 被判成金额不符）。
- **订单号不是凭据**：取卡必须再给 10 字符查询码（50 bit CSPRNG），KV 里只存它的
  sha256（`order:<id>` 的 `qh` 字段）。所有随机数走 CSPRNG，**不得**用项目那套可复现
  PRNG——可复现就意味着别人能算出你的查询码。
- **交易单号防重放**（`txid:<单号>` → 订单号）：同一单号换订单即拒；订单表、索引、
  限流计数共用 `env.JSLB_KV`（与 license-web 的 `redeem:`/`machine:` 同一命名风格）。
- **签发幂等**：`issueKey` 对已 issued 的订单直接回原卡，重复回调/重复确认不会多签；
  签发用 `licenseWeb.activeCodeKey()`——**必须与浏览器端同源**，否则签出来的卡
  客服端一律解析失败（这正是导出 `activeCodeKey()` 而不是各处自己读环境变量的原因）。
- **没配 KV 不建单**（503）：订单活不过一个实例的话，买家付了钱查不到单，比暂时不能
  下单糟得多。
- **人工核验是默认形态**：收款用个人微信收款码，没有商户回调。管理端两条路：
  `/api/admin-order`（Bearer `JSLB_ADMIN_TOKEN`，未配恒 403）与
  `tools/issue/orders.js`（可 `--kv` 直连存储，不需要站点在线）。接商户号后配
  `JSLB_PAY_WEBHOOK_SECRET` 走 `/api/pay-notify` 自动发卡——签名是
  HMAC-SHA256(**原始请求体**)，重新序列化会因键序变化必然失配。
- `src/orders.js` 是**服务端模块**，已加进 `tools/build/gate-policy.js` 的
  `GATED_PREFIXES`：不挡它就会被当公开模块下发到浏览器（白给一份取卡鉴权实现，
  还会触发构建期那条「已下发但没进 modulepreload」告警）。加 `src/*.js` 时先问一句
  "浏览器要不要它"——`isGatedModuleId` 的默认是**公开**。
- 改完价格/订单逻辑必跑：`node test/pricing.js`（价目表一致性 + 订单全链路 +
  取卡鉴权 + 防重放 + 限流 + 回调签名 + 错误文案双语齐全）与 `node test/orders-api.js`
  （把 `server/handler.js` 当黑盒：状态码、鉴权、幂等、降级）。后者用 `codec.parseCode`
  反验签发出的卡密，且**必须用 `licenseWeb.activeCodeKey()`**——密钥是模块级状态，
  同进程里别的测试可能已覆盖过它；第一版写死内置密钥，单跑绿、进全套红。
- 测试读 KV 时**别直接读 `env.JSLB_KV`**：`server/handler.js` 的 `prepareEnv` 会给键名
  加 `jslb:` 前缀（只暴露 get/put/del）。走 `platform.getKv()` 才是线上同一层，
  直接读裸键会永远读到空——`test/orders-api.js` 的过期用例踩过这个坑。

## Anti-CDP 的 stealth 判据与已知残余（2026-10-12 实测）

- **V2 现在两条判据**：① `navigator.webdriver === true`；② **navigator 实例上存在
  自有 `webdriver` 属性**。② 针对的是 stealth 框架的标准手法
  `Object.defineProperty(navigator,'webdriver',{get:()=>false})`——它把 ① 整个绕过去。
- **② 的依据是实测过的，不是推理**：headless Chromium（自动化已开）下
  `Object.getOwnPropertyDescriptor(navigator,'webdriver')` 为 `null`，该属性是
  `Navigator.prototype` 上的访问器（`in navigator` 为 true）；在实例上 defineProperty
  之后实例上才出现自有访问器。规范也把 webdriver 定义在原型上。**"自动化本身不产生
  自有属性，只有注入才会"** ——所以 ② 是硬证据，可以直接投毒，不必走衰减计数。
- **两条想当然的判据，实测否掉**：
  - `delete navigator.webdriver` 在 Chromium 里**根本无效**（原型属性还在，读到的仍是
    true），所以"属性缺失"不是现实 evasion 路径。而按缺失判假又会在 2018 年前的
    浏览器上大面积误报——误报即投毒（内核 `pois` 置位、值语义入口全返回 0），不做。
  - **原型级覆盖**（`delete Navigator.prototype.webdriver` 后重新 defineProperty）
    实例上不留任何痕迹，纯 JS 侧无法与引擎原生访问器区分。这是**已知残余**，按可
    枚举性/可配置性去猜会踩到 Safari 等引擎的实现差异，风险不对称，不做。
    `test/anti-analysis.js` 有一条断言专门把这个残余钉住（原型级覆盖不投毒），
    将来有人补上要一并改那条断言。
- **沙箱基准形态不能用 `{ webdriver: false }`**：那本身就是自有数据属性，恰好会被
  判据 ② 命中，拿它测"不误报"是无效的。真实形态是 `Object.create(proto)`，proto 上
  是可枚举可配置的访问器、实例上什么都没有（`cdp-sandbox.js` 的 `makeNavigator`）。
  两种注入形态都要测：`{get:()=>false}` 与 `{value:false}`。

## 验篡改检测：样本选错会恒"通过"（2026-10-13 实测）

测 integrityCheck 能不能检出篡改，判据是**投毒的可观测后果**，不是"输出变了"。
两个各自都能让断言恒真的坑：

- **输出里必须有池化字符串**。投毒的表现是整池解码偏移，产物若只吐数字
  （`process.stdout.write(String(f()))`），投毒与否输出逐位相同——断言看起来通过，
  其实什么都没测到。样本要写成 `'V=' + f()` 这种带字符串字面量的形态。
- **`stringArrayThreshold` 是「收集概率」，0 不是「不设限」**。给 0 等于把字符串池
  整个关掉，于是既没有访问器（`stats.integrityCheck.machinery` 为 0）也没有投毒
  出口，篡改照样生效。要全量入池就给 1。同一批里 `wasmThreshold: 0` 才是"不设限"，
  两个 0 含义正好相反，别互相当依据。
- **篡改判据写反也会自欺**：`got !== clean` 会把"篡改生效"判成"已检出"。正确口径是
  `got !== 篡改后的期望值`——投毒生效时输出仍不是篡改后的值。
- 顺带一条**测试自身的坏味道**：stats 字段若在赋值前就被读走，报出来的数会恒为 0，
  而"报 0"很容易被当成"没生效"然后改机制。`integrityCheck` 里 `userFns` 就这样
  错过一次（`deferredInjected` 在注入块内才赋值）。

## 「复现不出来」不等于「没问题」（2026-10-13）

上一轮把 `renameProperties` 的名池撞名判成"未确认"，理由是 5 个 `-props` 档 ×
25 个 seed 全干净。**那条结论是错的，样本写错了**：撞名要成立必须是
「另一个属性被改名后拿到 `x`」+「`x` 早已以字符串形态存在」，而当时的样本里那个
属性只定义没访问，不进候选集，名池压根没被叫到。重写样本后
`Mangled-props` **40/40 确定性错**。

教训三条：

1. **否定结论要用多个形态重证**，尤其当判据本身有前置条件时。复现失败先问
   "我的样本真的触发了那个路径吗"，而不是先怀疑机制。
2. **代理/工具给的发现，先自己复现再采信**——但复现不了不等于发现是错的，
   只等于**我的样本不够**。这两个结论的后果完全相反，别混。
3. 名池类缺陷要按**档位**分别扫：形状不同则命中率天差地别（`Mangled-props` 40/40、
   `Mangled-shuffled-props` 12/40、`Dictionary-props` 6/40，而
   `Hexadecimal-props` / `Chinese-props` 0/40——后者不撞纯属形状不相交的侥幸，
   不是它们更安全）。只测一个档位会把"没复现"当成"没问题"。

## 体积分档（2026-10-15，`sizeProfile`）

- **先量 pass 级体积贡献再动手**：`DSH_DUMP_PASSES=1` 的转储按 pass 排序后取长度差，
  就能得到"谁吃了多少字节"。实测 max 档 34 KB 文件：`debugProtection` +187 KB、
  `vm` +289 KB、`antiCDP` +27 KB，其余全在个位数百分比。**壳层的算法本身不是大头**
  （见下一节，那两个数曾长期写错）。
- **不是每个旋钮都是杠杆，必须逐个量**。`vmThreshold` 一度被列进 `compact` 档，实测
  后发现**它是噪声**：同一文件上 1→12 省 8.6×，1→4~1→8 一点没省，20 反而更大——换阈值
  改变被编译的函数集合 → AST 尺寸变 → 后面每个 pass 的注入数跟着变。**包一个效果取决于
  随机流的旋钮等于骗用户**，已移出。同理，任何"显式设了某项体积一定更大"的断言都不成立。
- **`compact` 档只收"砍掉不损失防护能力"的旋钮**（`shellDepth` 2→1、`decoyFunctions`、
  `stringScatter`）。`debugProtection` / `antiCDP` 各能再省 26~29%，那是拿防护换体积。
  `test/minify.js` 有一条断言把这份禁列清单钉住——防止后来者"顺手"把它们加回去。
- **显式设置优先**：判据看 `src`（用户原始输入）而不是解析后的 `options`——后者那三个键
  全都带着预设取值（max 的 `shellDepth` 就是 2），用 `options` 判等于分档永远不生效。
  这与 `-props` 归一化踩的是同一个坑（见命名策略一节）。
- **`__sizeProfileApplied` 即便为空也要赋值**：空数组是有效状态（用户三项全显式设过、
  分档无事可做），与"压根没选分档"必须能区分。留 `undefined` 会让 stats 少一条记录，
  而用户看到"体积没变"时第一个怀疑的就是"这功能没生效"。
- **新选项的回归测试要在老码上干净失败**：整节先判 `VALUE_OPTIONS.sizeProfile` 存在，
  否则老码会在第一条断言前**崩掉整份测试文件**——崩掉会掩盖后面所有断言，双向判别
  也就无从谈起。

## 壳层体积实测（2026-10-15；先前文档里的 0.65 倍 / 139 KB 两个数都是错的）

拆开量的口径：把 `shellWrap` 的 `bootObfuscate` 换成直通函数，就能分别量到「壳的编码链」
与「loader 自混淆」两块。结论按这个口径重写：

- **壳的编码链没有膨胀**：直通 loader ÷ 理论 base64 = **1.005~1.010**（不补 padding 的
  base64 本身略低于 4/3）。先前"壳自身固定开销 139 KB"是把**载荷侧的注入运行时**
  （debugProtection/字符串池/探针）算到壳头上了——12 字节源码的裸产物就有 261 KB。
  壳自身固定开销实测约 **20 KB/层**。
- **每加一层 = 整体 ×1.34**（一次 base64）。`shellDepth:1/2/3` 实测 588/800/1081 KB。
- **小文件的固定开销大头是 `debugProtection`，且它是常量**：源码 0.2 KB 涨到 105 KB，
  注入量恒为 **164.1 KB**（另一份样本 188 KB，含 vm 那遍）。不是按函数复制，所以没有
  "共用一份"的可优化空间；它是真防护，`compact` 档排除它是对的。其余：antiCDP 27 KB、
  stringArray 16.5 KB、opaquePredicates 15 KB、envFingerprint 12.6 KB。
- **`debugProtection` 那 164 KB 里没有可 dedup 的大常量表**：数字占 27%、标识符 47%，
  最长数字 10 位、1239 个 8~10 位 hex。是代码不是数据。

### 两个潜在缺陷（量出来了但没动，改前先读这段）

1. **产物实际加密层数 = `shellDepth` + 1**，而 `stats.shell.layers` 只报 `shellDepth`。
   `obfuscate.js` 先 `shellWrap` 造壳，`guardLayer` 之后**又调一次
   `shell.makeShellLayer`**（`banner.js`）把壳的产物整体再 base64 一遍——因为引导层排在
   套壳之后，那时才知道盐。实测去掉那层：`shellDepth:1` 从 651 KB → 478 KB（**−25%**），
   `shellDepth:2` 从 1105 → 826 KB。
2. **`bootOpts` 漏了 `wasmInterpreter: false`**（只关了 `wasm`）。今天**休眠**：实测开关它
   对 loader 体积无差别（487.7 KB 两边相同）。但若哪天引导层够得上 wasmInterpreter 的门槛，
   引导器会被编译成 WebAssembly 模块——既是启动期的大开销（与「轻装档」的初衷相反），
   又撞 workerd 禁 `WebAssembly.compile` 这条硬限制（见「目标宿主约束」一节）。

### 为什么那层冗余但不能删（2026-10-15 实测，已回滚）

算法上它确实冗余：同一段 `makeShellLayer`、同一套算法，只是换一个随机密钥再跑一遍。
删掉它的实测代价有三条，**前两条是防护回退**：

- **跨构建指纹压制下降**：`test/passes-basic.js` 的 6 对 bigram 相似度 max 从 **0.356
  升到 0.399~0.405**，越过该测试 0.40 的线。根因不是"少了一层随机性"这么含糊：
  `rawToks` 把整段 base64 当**单个 token**，密文对相似度几乎零贡献，**loader 的明文骨架
  就是全部信号**——实测 loader 明文自身跨 seed 相似度就有 **0.41~0.42**、277 个 3-gram
  逐构建相同。那多出来的一层起的是**稀释**作用。
- **bytecode 形态的解释器落到明文**：`bytecodePrelude` 拼在壳层之外，原先被外层加密着，
  删层后明文出现 `new Uint8Array(`，`shell-bytecode.js` 的「不新增明文缓冲区构造」断言
  由 0 → 1 挂掉。
- `charCodeAt` 可见次数 2 → 3：loader 的 S-box/字符表访问器原先在加密的里层。它顺带暴露
  一处**早已存在的漏网**——loader 明文区 `prototype` 出现 0 次，即 loader 根本没做
  AGENTS「原生函数单点收敛」那套别名（`_0fc`/`_0cc`/`_0U8`/`_0Ar`），全是直接方法调用。

**结论：loader 多态性才是真杠杆**，不是层数。要删那层，先把 loader 的明文骨架做出跨构建
差异（现在它自身的相似度 0.41 就压在 0.40 那条线上）。按本仓库规矩（`compact` 档只收
"砍掉不损失防护能力"的旋钮），这属于拿防护换体积，不默认开。

### 量这块时的两个探针陷阱

- **`DSH_DUMP_PASSES` 会被壳的递归调用污染**：壳构建会递归调 `obfuscate(loaderSrc,
  bootOpts)`，那次调用走同一个 dumper，把外层同名转储**覆盖成 loader 的**（loader 源码
  里含几百 KB 载荷，看着像"壳给载荷塞了 648 KB"）。要分离就用**数组**收转储、按 pass 名字
  第一次重复处切开；或者用 `stats` 里的 `·generate.bytes`（免疫递归污染）。
- **别拿 `shellDepth:1` 的基线去比 max 预设**：max 是 `shellDepth:2`，早期几版量"膨胀
  1.78×"就是这么错的——那其实是 3 层（2 + guardLayer 补的那层）。

## 提交前自检

```bash
JSLB_SKIP_LIVE=1 npm test        # 全绿才收工
node test/passes-basic.js        # 改 pass 时先跑这组
node test/vm.js                  # 改 vm 时先跑这组
npm run build:web && npm run verify:enc   # 改 shell / 加密层 / tools/build 后必跑
```

`verify:enc` 那一条不是可选项：`npm test` 只覆盖 `src/` 的明文源码，碰不到 `dist/`，
而模块体加密层的静默失败模式（导出名枚举漏一个、相对说明符改写漏一种形态）在构建期
一个都拦不住。2026-10-11 就是它揪出来的：`enc-loader` 的静态导出枚举不认
`export function*`，`utils/cjk.js` 的 `cjkNames` 因此没进 stub，浏览器执行形态
（`build:web`）整份加密核心在 materialize 时链接期报错——而 `npm test` 全绿。
改 `tools/build/` 下任何东西之后，跑一遍再收工。

新增/删除 pass 或选项时同步检查：`src/pipeline.js` 的注册顺序、
`test/selftest.js` 的文件清单、`DEPLOY.md` 与 `README.md` 的说明。

发布不用做任何额外动作：**push 到 `main` 即自动部署**（见「常用命令」），
不需要本地重建 `dist/`、也不需要跑 `npm run deploy`。
