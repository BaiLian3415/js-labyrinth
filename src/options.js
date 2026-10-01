export default {
  "compact": true,
  "escapeNonAscii": true,
  // AST 简化（simplify）：混淆前对用户代码做常量折叠 / 死代码消除 / 空语句
  // 清除 / 声明合并，缩小产物。默认关（预设不动，避免改既有产物基线），
  // Paid 档（plus+）可显式开启；free 档闸门锁死 false。
  "simplify": false,
  "identifierPrefix": "_0x",
  "mangle": true,
  // 命名策略（Paid 档，plus+；free 档闸门锁死 Mangled）。四档，与 obfuscator.io 的
  // identifierNamesGenerator 同一套命名：
  //   Mangled           规范短名（a、b、c…），决定性、与 seed 无关、可逐字节 diff，
  //                     体积最小，但产物里必然出现发名顺序，指纹最强
  //   Mangled-shuffled  同样形状，字母表逐构建打乱——体积相当且不留字母表指纹，
  //                     混淆发布用这档
  //   Hexadecimal       字母 + 十六进制位（a7 / f30），一样短但完全无规律
  //   Dictionary        固定 64 词表的可读名，调试友好；产物更大、词表可枚举
  //                     故抗指纹弱，定位是调试档不是发布档
  "nameStyle": "Mangled",
  // 属性名重命名（renameProperties，safe 模式）：改成员访问 obj.foo / 对象键
  // {foo:1} / 方法名 / 类方法·类属性名的属性名。只改「程序内定义 ∩ 访问」的
  // 属性，叠加高风险名白名单。与外部代码共享属性可能被破坏（safe 模式固有局限）。
  // Paid 档（plus+）可用；free 档闸门锁死 false。
  "renameProperties": false,
  "stringArray": true,
  "stringArrayEncoding": "rc4",
  "stringArrayMixedEncoding": true,
  "stringArrayEvolve": "sparse",
  "stringArrayDecompose": 2,
  "stringArrayThreshold": 1,
  "stringArrayRotate": true,
  "stringArrayCache": true,
  "stringSplitThreshold": 1,
  "stringSplitProbability": 1,
  "stringIndexMask": true,
  "stringArrayCallsTransform": false,
  "controlFlowFlattening": true,
  "controlFlowThreshold": 1,
  "controlFlowProbability": 1,
  "controlFlowDepth": 2,
  "controlFlowLoopFlattening": true,
  "vmProtection": true,
  // 字节码编码。开启时每个字节码字按「值 ^ 位置散列 ^ 掩码 ^ 链值 ^ 块密钥」逐字
  // 加密，取指做同一逆运算，并在每次调用入口把整个 B 数组原位重写一遍。
  // 关掉后字节码以明文整数数组存在（操作码编号、跳转目标、常量下标都直接可读），
  // 只保留下游的混淆——这是给排查问题用的弱档，不是安全档。
  // 受影响的三项：分块自解密（vmBlockDecrypt）失效——没有密文可再分层；
  // 运行时密钥取值（vmRuntimeKeyGetter）失效——没有掩码可守门。
  // 编译期密钥不失效：它仍照常派生字符串表散列与分发仿射常数，所以产物仍随
  // 密钥变化（防指纹那层还在），只是不再有"取错密钥就崩"的门禁。
  "vmBytecodeEncoding": true,
  "vmMode": "global",
  "vmThreshold": 1,
  "vmDecoyOps": 256,
  // P3：分发条目表密文化。分发器的 (分发字 → 语义动作) 对应关系不再以
  // 明文比较链/表字面量出现，改为密文数组 + 运行期一次解密 + 动作函数表间接引用。
  "vmDispatchEnc": true,
  // 紧凑分发器。默认关，分发形态由 vmDispatchEnc 决定（75% 走密文表形态 D，其余
  // 走 A/B/C）。开启后强制走形态 E——直接寻址：分发字空间本来就是稠密的
  // （0..总数-1 的一次全排列），所以字本身就是下标，不需要桶、不需要桶区间表、
  // 也不需要桶内线性扫描。条目按字下标就地存放，位置即字，每项只存一个加密的
  // 动作下标，运行期解成直接寻址表 M，分发就是一次 A[M[t]]() 加一个返回值判断，即 O(1)。
  // 相对形态 D：每项 3 字降到 1 字、丢掉桶区间表、分发从"取区间再扫描"变成一次下标，
  // 更小也更快；两者的「字 → 语义」都只在运行期解出，静态隐藏程度相同。
  "vmCompactDispatcher": false,
  // 跳转编码。关闭时跳转指令的操作数里存的是目标的绝对字下标；开启后改存
  // 「目标字下标 − 本指令字下标」的差值，运行期用取指游标把本指令的字下标还原回来
  // 再加回去。差值意味着这个操作数脱离它所在的位置就没有意义：静态 dump 出解密后的
  // 字节码也只能看到一串相对位移，要还原控制流图必须先确定每条指令的字跨度
  // （JMP/条件跳转为 3 个字、JANDK 系为 4 个字）。
  // 注意：字流本身仍是逐字加密的，这一层是叠加在它之上的第二层，不是替代。
  "vmJumpsEncoding": false,
  // 栈编码。操作数栈上装的是任意 JS 值，XOR 只对数字成立，所以编码函数对非数字透明：
  // 值 v 是 32 位整数且非 -0 时栈上存 v ^ K，否则原样存。K 逐函数随机（并入 vmCompileKey
  // 的密钥流）。编解码是同一个幂等函数：压栈时编码、出栈时解码。
  // 于是内存里 dump 操作数栈看到的不再是真实操作数；浮点、大整数、字符串、对象一律明文
  // 通过——这是这一层的边界，不是漏洞。代价是每次压栈/出栈多一次函数调用。
  "vmStackEncoding": false,
  // 顶层初始化包装。VMP 原本只覆盖函数体，顶层语句（引导、注册、初始化调用）
  // 完全不受保护。开启后整个顶层序列搬进一个合成函数体，走同一套编译流程，产物里
  // 这段代码由 VM 解释器执行，顶层控制流与常量同样从静态视图里消失。
  // 三条跳过条件与 functionWrapper 同源（都是"顶层搬进函数体会改语义"的情形）：
  // 含 import/export 的 ESM、顶层 this（顶层箭头函数里的也算）、自由引用
  // require/module/exports 的 CommonJS。此外整段顶层必须通过区域判定，含
  // try/switch/标签/with 与带 break/continue 的循环、不到 vmThreshold 的都保持原样
  // （统计里 reason 记 uncompilable / not-compiled）。
  // 代价：顶层 var/function/let/const 声明随之变成包装函数的局部绑定，不再泄漏到
  // 全局——与 functionWrapper 的取舍相同。需要 vmProtection。
  "vmWrapTopLevel": false,
  // 宏指令（vmMacroOps）。把连续的操作数装载指令合并成一条 MPKn（n 取 2~4）：
  // 原本 n 条各自取指、各自分发的指令，变成一条指令一次取指、一次分发，n 个操作数
  // 打包成 n 个「(下标 << 2) | 源位」的字跟在后面，源位在运行期用条件表达式选。
  // 可融合的成员是指令集里只做「取一个值压栈」的四条：取常量、取槽位、取外层名
  // getter、取常量池闭包；取字符串（还原循环）与 EXEC（结果丢弃）会截断窗口。
  // 宏的动作体由被合并指令的动作体按原顺序拼接而成，语义等价是构造性的；
  // 跳转目标不落在被合并的区间内（跳转靠指令下标定位），所以控制流不受影响。
  // 收益在运行期与静态面：指令条数、取指次数、分发次数同时下降，字节码字流更短，
  // 且"哪条指令"这一步多了一层只有运行期才知道的源位解码。代价是每种段长多一个
  // 分发条目（最多三条），动作体比单条装载指令长——函数里融合段很少时净体积会变大。
  "vmMacroOps": false,
  // 动态操作码（vmDynOpcodes）。分发字到语义的对应关系不再是全函数唯一的一张表：
  // 存进字节码的编号是「规范编号 − 本条指令 opcode 字下标的位置轮换量」，取指之后由
  // 解释器按同一式子把轮换量加回来得到规范编号，再分桶、比对、查表。位置轮换量 =
  // ((字下标 × P) ^ Q) & (N-1)，P 与 Q 逐函数随机。于是同一个存储值在不同位置指向
  // 不同动作：静态 dump 出解密后的字节码，看到的只是一串与位置耦合的编号，要把分发字
  // 与语义对齐必须先算清每条指令的字下标与轮换公式。
  // 与逐调用轮换的关系：掩码与链值在每次调用入口整体重写 B，那层管"字长什么样"，
  // 本项管"字还原成哪个编号"，两层叠在同一条取指路径上，互不依赖。
  // 代价：取指后多一次乘法、异或与掩码；还原用 &(N-1)，字空间必须是 2 的幂，开启时把
  // 槽位数上取整、多出的槽位并进干扰项。
  "vmDynOpcodes": false,
  // 寄存器式虚拟机（Register-Based VM）。默认关。开启后函数体不再编译成栈机字节码，
  // 而是编译成寄存器机字节码：每条指令的操作数都是显式寄存器号，运行期从一个
  // 寄存器文件 R 里读写，没有「栈顶」这种隐式操作数。表达式求值因此变成「结果落进
  // 哪个寄存器」——指令形如 R_BIN_* 目标,左,右；调用形如 R_CALL_n 目标,被调,实参…；
  // 条件跳转显式带一个条件寄存器。
  // 与栈机不只是形态差别：栈机的数据流是「隐式栈顶 + 位置」，反编译按 pop 顺序两两
  // 配对就能还原表达式树；寄存器机里同一个值整段生命周期里有稳定身份（寄存器号），
  // 数据流是一张「寄存器 → 寄存器」的图，值的产生与消费跨指令、可跨越基本块，
  // 按栈配对的老办法失效；指令集本身也换了一套（操作数个数与栈机完全不同），
  // 针对栈机指令集写死的还原规则无法复用。
  // 分配策略是 LIFO 复用：表达式求值完立即把临时寄存器还回池子，所以寄存器文件很小，
  // 但编号是显式的、语句之间不复位，内存里 dump 寄存器文件看到的是当前活跃值集合，
  // 而不是「按序压入」的栈。
  // 与其它选项的关系：这是一套独立的代码生成后端。开启时下面几项对该函数不生效——
  // 栈编码（没有操作数栈可编码）、多态寄存器模型（本身就是寄存器机，不再抽栈/寄存器
  // 混合结构）。宏指令融合在寄存器后端
  // 仍然生效：连续的操作数装载指令合并成一条 RMPKn，n 个
  // 「(下标 << 6) | (目标寄存器 << 2) | 源位」打包字跟在后面。
  // 其余选项（字节码编码、跳转编码、分发形态、动态操作码、干扰项、编译期密钥、
  // 运行时密钥取值、分块自解密）都作用在字流与分发层，与本项正交。
  "vmRegisterVM": false,
  // 异步执行器（Async Executor）。默认关。VMP 原本一律跳过 async 函数（解释器是同步
  // 循环，没法在里面等 Promise），于是现代代码里占比很大的一类函数完全不受保护。
  // 开启后 async 函数体也走同一套编译流程：`await x` 编译成一条 AWAIT 指令，而解释器
  // 循环本身写在 async 函数体内，所以执行到 AWAIT 时 `await` 天然把整个解释器挂起，
  // Promise settle 之后从下一条指令继续——挂起与恢复交给 JS 引擎，不需要把解释器改写成
  // 状态机或续体，语义与源码逐条对等：返回值照常被 async 包装成 Promise，throw 照常
  // 变成 rejected promise，await 之后的控制流（含循环回边）照常。
  // 三条约束：
  //   · 只用分发形态 A(switch) 与 C(嵌套 if)——它们的动作体直接内联在 async 函数体里；
  //     B/D/E 的动作体装在箭头函数里，非 async 箭头里写 await 是语法错误。开启本项时
  //     async 函数被强制走 A/C，密文条目表（vmDispatchEnc）与直接寻址形态
  //     （vmCompactDispatcher）对它们不参与。
  //   · await 不能出现在会被搬进非 async 闭包的位置：片段表达式（对象/类/模板串/
  //     正则/可选链/spread 调用等整体降级成闭包的表达式）、for-in/for-of 与解构声明的
  //     EXEC 片段、以及非 async 的嵌套函数。命中这类位置的函数整函数保持原样不编译
  //     （保守降级），绝不产出语法错误的产物。
  //   · async 生成器（async function*）与 `for await` 一律不编译。
  // 代价：async 函数本身每次调用多一层 Promise（这是 async 语义的开销，不是本项引入的），
  // 解释器每条 AWAIT 多一次 microtask 往返。
  "vmAsyncExecutor": false,
  // P4：多态寄存器模型。逐函数从 M0 纯栈 / M1 寄存器优先 / M2 双栈分立 中随机抽一种。
  "vmPolymorph": false,
  // P4：字节码按块自解密。块边界逐构建随机，块密钥运行期派生，任一时刻内存里
  // 最多只有 1~2 块明文，线性 dump 拿不到完整指令流。
  "vmBlockDecrypt": false,
  // 测试用：强制单一寄存器模型（auto 表示按 vmPolymorph 随机）
  "vmModel": "auto",
  // 编译期密钥。留空（默认）时 VM 的全部密钥材料来自 randInt，每次构建都不同，
  // 产物与改动前逐字节一致。填了密钥则由「密钥 + 函数序号」哈希派生这些材料：
  // 掩码（MASK_*）、位置散列、轮换函数（ROT_*）、字符串表散列（STR_*）、
  // 分发仿射常数（DISP_*）、链种子（CHAIN_SEED）、分块密钥（BK_*）。
  // 效果是两件事：① 同一密钥每次构建产物可复现；② 没有密钥就复现不出掩码与
  // 位置散列，字节码字的解密式就凑不出来——防护从"随机"变成"需要凭据"。
  "vmCompileKey": "",
  // 运行时密钥取值。一个运行期表达式（如 window.__VM_KEY__），产物在每个 VM 函数
  // 开头求值它，用取回的值重跑一遍与构建期相同的密钥派生，把结果当初始掩码、位置
  // 散列常数、轮换函数与链种子。取回的值不等于编译期密钥时派生出另一套掩码，
  // 字节码字解出来是垃圾，函数随即崩掉——这才构成门禁。
  // 必须与 vmCompileKey 同时设置，缺编译期密钥时 pass 入口直接报错。
  // 代价：运行契约变了——产物只有在宿主提供该密钥时才能跑；每个函数多带约 1~2 KB。
  "vmRuntimeKeyGetter": "",
  // ---- WASM 档位（阶段一：恢复能力，默认关闭）----
  // 这两个档位在 e0d5d32 被整体移除（原因见那次提交：它们与 JS 侧多项 VM 特性互斥，
  // 且 wasmInterpreter 与 wasm 两档本身也互斥）。此处按"恢复能力、不动默认"的方式接回：
  // 选项存在、pass 可跑，本文件（无 preset 的手写选项集）默认全关。
  // 历史默认（medium/high/max 的 wasm:true、max 的 wasmInterpreter:true）已由预设承担，
  // 见 presets.js；不带 preset 的调用仍保持全关。
  //
  // 注意 wasmInterpreter 会屏蔽一批栈机专有的选项（vmJumpsEncoding / vmStackEncoding /
  // vmMacroOps / vmDynOpcodes / vmRegisterVM / vmAsyncExecutor / vmBlockDecrypt /
  // vmRuntimeKeyGetter）——模块内的解释器按绝对下标与既有指令集硬编码，这些机制在那里
  // 没有对应物。被屏蔽的项会在 stats 的 suppressed 字段里逐项列出，不静默失效。
  //
  // 互斥关系仍然成立，由 obfuscate 的挂载点保证：
  //   if (options.wasmInterpreter) wasmvm(...); else if (options.wasm) wasm(...);
  // 即内核档优先接管，旧档不介入。共存要靠"嵌套"（外层 JS VM 保护内层 WASM 解释器），
  // 那是阶段二的新接口，不是这里把两个开关同时打开就能得到的。
  //
  // 宿主约束：workerd 只允许静态导入 .wasm，构建期自检因此走能力探测
  // （wasm.js 的 wasmCompilable()），不支持就跳过自检、产物照常产出。
  "wasm": false,
  /** 只有语句数达到该值的函数才搬进 WASM（0 表示不设限）。 */
  "wasmThreshold": 1,
  /** 解释器内核档：把解释循环整体编译进共享 WASM 模块，JS 侧只剩桥接调用。 */
  "wasmInterpreter": false,
  /** 自定义运行时深度（只被 WASM 宿主运行时生成器消费）。 */
  "rtDepth": 2,
  "objectKeyEncoding": true,
  "numberObfuscation": true,
  "numberObfuscationThreshold": 0.6,
  // MBA（混合布尔算术）。把数值字面量改写成位运算与算术交织的恒等式，例如
  //   V  ->  (x ^ y) + 2*(x & y)       // x + y = V，进位恒等式
  // 与相邻的单一算子形态相比，化简它必须先认出进位恒等式这一族关系，只按算子做
  // 局部折叠的工具会失效或算错。精确性前提见 numberObf.js 的 mbaForms：取值域
  // 限定在 int32 非负区间，`<< 1` 不会翻负，全部中间量都在双精度精确整数内。
  // 默认关（不改既有产物基线），max 预设启用；无额外运行期开销。
  "numberObfuscationMBA": false,
  "controlFlowRollingKey": true,
  "logicalExpressions": true,
  "logicalExpressionsThreshold": 1,
  "conditionObfuscation": true,
  "conditionObfuscationThreshold": 1,
  "opaquePredicates": true,
  "opaquePredicatesProbability": 1,
  "opaquePredicatesMax": 6,
  "templateToConcat": true,
  "functionWrapper": true,
  "callProxy": true,
  "deadCodeInjection": true,
  "deadCodeProbability": 1,
  "honeyStrings": true,
  "decoyFunctions": true,
  "debugProtection": true,
  // 反调试自检间隔（ms）。debugProtection 读 `options.debugProtectionInterval || 4000`，
  // 所以这里的默认值必须是非 0 的真值——原先写 1 会让兜底永不触发，实际按
  // perTd = max(200, interval/2 × 系数) 退化成每 200ms 一次时间差检测，比本值贵 20 倍。
  // 四个预设都显式给了这项（low/medium 4000、high 1、max 2000），所以这只影响
  // 不带 preset 的手写选项集；改这里不影响任何预设的产物字节。
  "debugProtectionInterval": 4000,
  // Anti-CDP：Chrome DevTools Protocol / 自动化框架检测。console 序列化探针
  // （Runtime.enable 特征）、navigator.webdriver、驱动注入属性扫描；命中与
  // 反调试共链投毒。用 Puppeteer/Playwright 做端到端测试时请关掉本项。
  "antiCDP": true,
  // 域名锁定（P5 第二项）：逗号分隔的域名白名单。example.com 精确匹配、
  // .example.com 含任意层子域、example.com:8443 额外锁端口；留空关闭。
  // 匹配结果密钥耦合进字符串池解密密钥：非授权域整池乱码、删引导调用授权域
  // 自己乱码、改校验函数体被完整性校验检出。Paid 档可用（plus+）。
  "domainLock": "",
  "sentinelRate": 0.5,
  "debugPoison": true,
  "consoleStub": false,
  "selfDefending": true,
  "envFingerprint": true,
  "integrityCheck": true,
  "integrityPoisonPoints": 4,
  "selfCheck": true,
  "shell": true,
  "shellDepth": 1,
  // 外壳形态（Paid 档，plus+；free 档闸门锁死 classic）。classic 是原来的
  // 明文引导器形态；jsfuck 把「密钥流生成 + 校验尾差量」那段核心编成纯 JSFuck
  // 表达式（只由 [ ] ( ) ! + { } 八个字符构成），引导器其余部分不变。代价是
  // 每层固定多约 45.4 KB（实测 79 字符/字节 × 487 字节核心 + 8.1K 固定开销）。
  "shellForm": "classic",
  "extraGlobals": [],
  // reservedNames / reservedStrings：正则保留名单。匹配的绑定名不改名、匹配的
  // 字符串字面量不收集/不拆分/不编码。逗号分隔的正则文本（减混淆的兼容性功能，
  // 不收费门控）。
  "reservedNames": [],
  "reservedStrings": [],
  // HTML2MEM：把 HTML 的文本节点与属性值加密成密文，运行期由 loader 解回 DOM。
  // 只在 HTML 输入时起作用（JS 输入没有这一步）。这是混淆不是保密——密钥和
  // 解密逻辑都在页面里，打开开发者工具的人照样能 dump 出还原后的 DOM。
  "html2mem": false,
  // 固定密钥。0 = 由种子决定，所以同 seed 天然可复现；填具体值则无视种子，
  // 适合需要跨种子保持同一份密文形态的场景。
  "html2memKey": 0,
  "stringScatter": false,
  "antiLLM": false
};
