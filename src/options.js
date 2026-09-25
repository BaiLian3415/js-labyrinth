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
  "vmMode": "global",
  "vmThreshold": 1,
  "vmDecoyOps": 256,
  // P3：分发条目表密文化。分发器的 (分发字 → 语义动作) 对应关系不再以
  // 明文比较链/表字面量出现，改为密文数组 + 运行期一次解密 + 动作函数表间接引用。
  "vmDispatchEnc": true,
  // P4：多态寄存器模型。逐函数从 M0 纯栈 / M1 寄存器优先 / M2 双栈分立 中随机抽一种。
  "vmPolymorph": false,
  // P4：字节码按块自解密。块边界逐构建随机，块密钥运行期派生，任一时刻内存里
  // 最多只有 1~2 块明文，线性 dump 拿不到完整指令流。
  "vmBlockDecrypt": false,
  // 测试用：强制单一寄存器模型（auto 表示按 vmPolymorph 随机）
  "vmModel": "auto",
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
