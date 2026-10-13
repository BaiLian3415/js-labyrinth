export default {
  "compact": true,
  "escapeNonAscii": true,
  // 产物最终跑在什么宿主里。'auto'（默认）按源码结构特征判断；判不准时用显式值。
  //
  // 为什么要显式存在：`auto` 认 Cloudflare Worker 靠的是 `export default {fetch}`
  // 这类**结构性**特征，自定义写法（把 handler 拼出来、或用别的框架约定）会认不出，
  // 于是壳照套、产物在 workerd 上部署即抛。显式声明是这类场景的兜底。
  //
  // 认成受限目标时会**强制关掉跑不了的形态并告警**（不是默默关）：壳（eval 与
  // 动态 import 双双被禁）、两个 wasm 档（instantiate(buffer) 被禁）、以及
  // debugProtection / antiCDP（该宿主时钟冻结，时序哨兵静默失效）。见 target-runtime.js。
  "target": "auto",
  // AST 简化（simplify）：混淆前对用户代码做常量折叠 / 死代码消除 / 空语句
  // 清除 / 声明合并，缩小产物。默认关（预设不动，避免改既有产物基线），
  // Paid 档（plus+）可显式开启；free 档闸门锁死 false。
  "simplify": false,
  "identifierPrefix": "_0x",
  "mangle": true,
  // 命名策略（Paid 档，plus+；free 档闸门只放行不带 -props 的两档）。五个基础档 + 每个基础档的
  // 一个带属性名变体，共十档（合法值以 utils/naming.js 的 NAME_STYLES 为准）：
  //   Mangled           规范短名（a、b、c…），决定性、与 seed 无关、可逐字节 diff，
  //                     体积最小，但产物里必然出现发名顺序，指纹最强——只做调试档，
  //                     不做默认（2026-10-13 起默认换成 Mangled-shuffled）
  //   Mangled-shuffled  同样形状，字母表逐构建打乱——体积相当且不留字母表指纹，
  //                     默认档，混淆发布用这档
  //   Hexadecimal       字母 + 十六进制位（a7 / f30），一样短但完全无规律
  //   Dictionary        固定 64 词表的可读名，调试友好；产物更大、词表可枚举
  //                     故抗指纹弱，定位是调试档不是发布档
  //   Chinese           标识符换成汉字（甲乙丙丁…）。产物里汉字原样写出、不做
  //                     \uXXXX 转义（见 generator 的 _escapeIdent），因此要求
  //                     产物按 UTF-8 提供
  //
  // 后缀 `-props`（如 `Hexadecimal-props`）= 连属性名/对象键一起改，改的是成员访问
  // obj.foo、对象键 {foo:1}、方法名、类方法与类属性名。只改「程序内定义 ∩ 访问」的
  // 属性，叠加高风险名白名单；与外部代码共享的属性可能被破坏（safe 模式固有局限）。
  // 属性名走与标识符同一个名池，所以选哪档属性名就是哪档形状。
  //
  // 为什么写进档位而不留一个独立布尔项（2026-10-09）：属性名重命名原本是独立的
  // renameProperties 开关，而它的实现只对 Chinese 档认 nameStyle、其余一律发
  // `_0x` 随机名——也就是说选了 Hexadecimal 之后属性名完全不受影响，那一档对属性
  // 而言是假的。写进档位后属性名真正跟随档位，选一次就够，不必再勾第二个开关。
  //
  // 2026-10-01：Chinese 原本也是独立布尔开关 chineseNames，同样并入本枚举。
  // 这两次都属破坏性变更：旧存档与 CLI 的 --chinese-names / --rename-properties
  // 不再识别（选项系统保留未知键但没人读，所以是静默失效而非报错）。
  "nameStyle": "Mangled-shuffled",
  // Dictionary 档的自定义词表。留空用内置的 64 词表（见 utils/naming.js 的
  // DICTIONARY_WORDS）。逗号/空白/换行分隔，逐词校验后去重：非法标识符、关键字、
  // 重复词会被丢掉，全部非法时回落到内置词表。词越长产物越大，且这一档词表本来
  // 就可枚举（认的人拿同一份词表就能把改名批量还原），所以定位是调试/审计而非发布。
  // 只在 nameStyle 是 Dictionary / Dictionary-props 时被读。
  "nameDictionary": "",
  // 汉字字典。留空用内置默认字典（1024 字，起手甲乙丙丁戊己庚辛壬癸）。
  // 自定义时逐构建打乱后发名，所以顺序只影响"哪些字会被用到"，不影响可复现性。
  // 只在 nameStyle = Chinese 时被读。
  "chineseDictionary": "",
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
  // 包装层数：解码器外面再包 N 层单表达式函数，每层把索引异或一个构建期常量并带
  // 0~4 个从不使用的 junk 形参。0 = 不包装（默认）；1~10 = 恰好这么多层。
  // 旧选项 stringArrayCallsTransform 仍可用：它为 true 且本项保持 0 时，层数逐组
  // 随机取 2~5；本项大于 0 时以本项为准。
  // 与上游 javascript-obfuscator 的 stringArrayWrappersCount 同名同义。
  "stringArrayWrappersCount": 0,
  // true = 调用点只出现最外层那一个函数；false = 调用点在各层之间分散，
  // 同一份产物出现多种签名，静态分析无法假定固定形态。
  "stringArrayWrappersChainedCalls": true,
  // 链式调用开启时走最外层的调用点占比（0~100），其余分散到内层。100 = 只有一种形态。
  "stringArrayWrappersChainedCallsThreshold": 100,
  "controlFlowFlattening": true,
  "controlFlowThreshold": 1,
  "controlFlowProbability": 1,
  "controlFlowDepth": 2,
  "controlFlowLoopFlattening": true,
  "vmProtection": true,
  // 解释器执行护栏（原嵌套内层档的 vmNestedLimit 已平移到此）：
  // 单次函数调用里解释器最多执行多少条字节码指令，超了抛错。
  // 死循环/失控执行不再静默挂死宿主——这是有界失败路径，不是性能调优项。
  // 栈机与寄存器后端共用。0 = 关闭该检查。
  "vmStepLimit": 100000000,
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
  // P4：字节码按块自解密。块边界逐构建随机，块密钥运行期派生，任一时刻内存里
  // 最多只有 1~2 块明文，线性 dump 拿不到完整指令流。
  "vmBlockDecrypt": false,
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
  // 多层 VM。1（默认）= 单层：函数体就是解释器本体。2 = 嵌套：把解释器循环本身
  // 作为一个独立函数体再过同一道 VM 编译——外层字节码的「解释动作」被编成第二份
  // 字节码，内外层各自带独立的 G/H/K/S 表、掩码与字节码加密材料。代价是每个 VM
  // 函数多编译一份字节码，且内层循环的解释开销叠加，运行约慢一倍。
  // 3 = 再套一层。3 层以上成本指数上升，且解释循环本身再次要求 form-C 的无 switch
  // 形态，收益递减。
  "vmLayers": 1,
  // ---- WASM 档位（阶段一：恢复能力，默认关闭）----
  // 这两个档位在 e0d5d32 被整体移除（原因见那次提交：它们与 JS 侧多项 VM 特性互斥，
  // 且 wasmInterpreter 与 wasm 两档本身也互斥）。此处按"恢复能力、不动默认"的方式接回：
  // 选项存在、pass 可跑，本文件（无 preset 的手写选项集）默认全关。
  // 历史默认（medium/high/max 的 wasm:true、max 的 wasmInterpreter:true）已由预设承担，
  // 见 presets.js；不带 preset 的调用仍保持全关。
  //
  // 注意 wasmInterpreter 会屏蔽一批栈机专有的选项（vmJumpsEncoding / vmStackEncoding /
  // vmMacroOps / vmDynOpcodes / vmAsyncExecutor / vmBlockDecrypt /
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
  "esmFold": true,
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
  // 非授权域在「装载期抛错」那种降级下先跳这里再抛错；另两种降级走不到（见
  // domainLock.js 的注释）。只接受相对地址与 http(s)。
  "domainLockRedirectUrl": "",
  "sentinelRate": 0.5,
  "debugPoison": true,
  "consoleStub": false,
  "selfDefending": true,
  "envFingerprint": true,
  "integrityCheck": true,
  "integrityPoisonPoints": 4,
  "selfCheck": true,
  // 内部选项：跳过引导层（盐互锁 + 健康载体 + 保留名单明文清单）。HTMLE 的逐块混淆
  // 与部分测试用它；界面不提供控件（options-meta 里标了 guiHide），只经 API/配置传入。
  //
  // 为什么必须在这里声明（2026-10-11 补）：它原先只被 obfuscate.js 读，既不在
  // DEFAULTS、也不在 options-meta，于是 KNOWN_OPTION_KEYS 里查不到——API 传进来
  // 生效但没人知道它存在，属"被读却三处都查不到"的漂移。声明之后未知键告警也能
  // 正确区分"内部键"与"拼错的键"。
  "bannerSkip": false,
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
  // 命中的一律收进字符串池，绕过 stringArrayThreshold 的随机抽样。密钥/URL/特征串
  // 这类不能靠概率——某次构建恰好没收就直接裸奔。冲突时压过 reservedStrings。
  "forceTransformStrings": [],
  // 内置的"看着像密钥就强制入池"（默认开）：多字符类、无空白、够长或种类够散的串
  // （密钥/口令牌/端点/长纯数字）绕过 stringArrayThreshold 的抽样，恒进池。
  // 与 forceTransformStrings 的区别：那是用户点名，这里是形态启发式；误判只增体积、
  // 不断语义。用户显式 reservedStrings 的串不受它影响（保留名单是明确决定，内置
  // 启发式不覆盖——与 forceTransformStrings 压过保留名单正好反过来）。关掉回到纯概率。
  "forceSecretStrings": true,
  // ESM 载荷的基准 URL。套壳后载荷经 blob:/data: URL 加载，这两种地址没有目录
  // 上下文，`./dep.js` 一律解析失败，所以带相对说明符的 ESM 必须给这个值，
  // 构建期会改写成绝对地址。形如 'file:///D:/app/' 或 'https://cdn/app/'。
  // 只对 ESM 载荷有意义；非 ESM 忽略。
  "moduleBase": "",
  // HTMLE：把 HTML 的文本节点与属性值加密成密文，运行期由 loader 解回 DOM。
  // 只在 HTML 输入时起作用（JS 输入没有这一步）。这是混淆不是保密——密钥和
  // 解密逻辑都在页面里，打开开发者工具的人照样能 dump 出还原后的 DOM。
  "htmle": false,
  // 固定密钥。0 = 由种子决定，所以同 seed 天然可复现；填具体值则无视种子，
  // 适合需要跨种子保持同一份密文形态的场景。
  "htmleKey": 0,
  "stringScatter": false,
  "antiLLM": false
};
