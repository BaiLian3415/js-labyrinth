export default {
  "compact": true,
  "escapeNonAscii": true,
  // AST 简化（simplify）：混淆前对用户代码做常量折叠 / 死代码消除 / 空语句
  // 清除 / 声明合并，缩小产物。默认关（预设不动，避免改既有产物基线），
  // Paid 档（plus+）可显式开启；free 档闸门锁死 false。
  "simplify": false,
  "identifierPrefix": "_0x",
  "mangle": true,
  // 命名策略（Paid 档，plus+；free 档闸门锁死 random）。random 是原来的随机混族
  // 长名（防指纹优先）；short 走 minifier 式短名池：长度递增、字母逐构建打乱、
  // 按引用次数分配，实测把"纯压缩"产物体积从 2.40× terser 降到 1.18~1.58×。
  "nameStyle": "random",
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
  // 关掉后字节码以**明文整数数组**存在（操作码编号、跳转目标、常量下标都直接可读），
  // 只保留下游的混淆——这是给排查问题用的弱档，不是安全档。
  // 受影响的三项：分块自解密（vmBlockDecrypt）失效——没有密文可再分层；
  // 运行时密钥取值（vmRuntimeKeyGetter）失效——没有掩码可守门。
  // 编译期密钥**不失效**：它仍照常派生字符串表散列与分发仿射常数，所以产物仍随
  // 密钥变化（防指纹那层还在），只是不再有"取错密钥就崩"的门禁。
  // WASM 内核档的取指按加密布局硬编码，该档强制保持编码，本项对它无效。
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
  // 也不需要桶内线性扫描。条目按字下标就地存放，**位置即字**，每项只存一个加密的
  // 动作下标，运行期解成直接寻址表 M，分发就是一次 A[M[t]]() 加一个返回值判断，即 O(1)。
  // 相对形态 D：每项 3 字降到 1 字、丢掉桶区间表、分发从"取区间再扫描"变成一次下标，
  // 更小也更快；两者的「字 → 语义」都只在运行期解出，静态隐藏程度相同。
  "vmCompactDispatcher": false,
  // 跳转编码。关闭时跳转指令的操作数里存的是目标的**绝对字下标**；开启后改存
  // 「目标字下标 − 本指令字下标」的差值，运行期用取指游标把本指令的字下标还原回来
  // 再加回去。差值意味着这个操作数脱离它所在的位置就没有意义：静态 dump 出解密后的
  // 字节码也只能看到一串相对位移，要还原控制流图必须先确定每条指令的字跨度
  // （JMP/条件跳转为 3 个字、JANDK 系为 4 个字）。
  // 注意：字流本身仍是逐字加密的，这一层是叠加在它之上的第二层，不是替代。
  // WASM 内核档的解释器在模块内、按绝对下标硬编码，该档自动关闭本项。
  "vmJumpsEncoding": false,
  // 栈编码。操作数栈上装的是任意 JS 值，XOR 只对数字成立，所以编码函数对非数字透明：
  // 值 v 是 32 位整数且非 -0 时栈上存 v ^ K，否则原样存。K 逐函数随机（并入 vmCompileKey
  // 的密钥流）。编解码是同一个幂等函数：压栈时编码、出栈时解码。
  // 于是内存里 dump 操作数栈看到的不再是真实操作数；浮点、大整数、字符串、对象一律明文
  // 通过——这是这一层的边界，不是漏洞。代价是每次压栈/出栈多一次函数调用。
  // WASM 内核档的栈在模块里，该档自动关闭本项。
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
  // 全局——与 functionWrapper 的取舍相同。需要 vmProtection；WASM 内核档忽略本项。
  "vmWrapTopLevel": false,
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
  // **必须与 vmCompileKey 同时设置**，缺编译期密钥时 pass 入口直接报错。
  // 代价：运行契约变了——产物只有在宿主提供该密钥时才能跑；每个函数多带约 1~2 KB。
  // WASM 解释器内核档的取指在 WASM 模块里，改不了，该档自动忽略本项。
  "vmRuntimeKeyGetter": "",
  "wasm": true,
  "wasmThreshold": 1,
  "objectKeyEncoding": true,
  "numberObfuscation": true,
  "numberObfuscationThreshold": 0.6,
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
  "debugProtectionInterval": 1,
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
  "wasmInterpreter": false,
  "rtDepth": 2,
  "stringScatter": false,
  "antiLLM": false,
  "bannerText": ""
};
