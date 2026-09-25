export default {
  "compact": true,
  "escapeNonAscii": true,
  "identifierPrefix": "_0x",
  "mangle": true,
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
  "extraGlobals": [],
  "wasmInterpreter": false,
  "rtDepth": 2,
  "stringScatter": false,
  "antiLLM": false,
  "bannerText": ""
};
