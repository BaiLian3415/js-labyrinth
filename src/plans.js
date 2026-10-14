export default {
  // 配额口径（2026-09-26 起）：全部按宿主免费档包络反推，见 src/host-limits.js。
  // 之所以要往下压：云端执行时上行走 Vercel 函数，平台对请求体有 4.5 MB 硬线，
  // 而免费档的 CPU 额度也只够跑小文件；把配额写成"10 MB/1000 次"只会让用户跑到
  // 一半撞平台 413/超时。每个档的 maxFileBytes 必须 ≤ 该档预设的单文件上限
  // （host-limits.presetInputCap），plan.js 在加载期断言这一点。
  "free": {
    "rank": 0,
    "code": "F",
    "display": "Free",
    "preset": "low",
    "limits": {
      "maxFileBytes": 131072,
      "maxFilesPerRun": 1,
      "runsPerDay": 3,
      "runsTotal": 0
    },
    "gates": {
      "vmDecoyOps": 0,
      "vmDispatchEnc": false,
      "vmBlockDecrypt": false,
      "wasm": false,
      "callProxy": false,
      "honeyStrings": false,
      "decoyFunctions": false,
      "debugProtection": false,
      "antiCDP": false,
      "domainLock": [""],
      "simplify": false,
      // 命名风格。free 档只放行 Mangled 与 Mangled-shuffled，另外三档
      // （Hexadecimal / Dictionary / Chinese）都是 plus+ 才放行。2026-10-13 起默认档
      // 是 Mangled-shuffled，它与 Mangled 同形状、字母表逐构建打乱——free 档产物不再
      // 跨构建可 diff，这是有意为之（Mangled 是五档里唯一与 seed 无关的跨构建指纹）。
      // 放开与否是套餐策略决定，这里按现状对齐，不擅自给 free 扩能力。
      //
      // 属性名重命名 2026-10-13 从 nameStyle 的 `-props` 后缀拆成独立布尔项，于是下面
      // 这条 `"renameProperties": false` 闸门从"多余"变回必需：属性名改名是付费能力，
      // 而现在它不再由档位串承载，唯一拦住 free 的地方就是这条规则。
      // 拆开的另一个好处是这份白名单不必再守"只能列不带 -props 的档位"这条隐约束
      // ——那条约束一旦被违反，误列一个 *-props 就等于把付费能力白送，而 violations()
      // 不报错，只会说"free 也能用这档"。
      "nameStyle": [
        "Mangled", "Mangled-shuffled"
      ],
      "renameProperties": false,
      "debugPoison": false,
      "selfDefending": false,
      "envFingerprint": false,
      "integrityCheck": false,
      "shell": false,
      "consoleStub": false,
      "stringArrayMixedEncoding": false,
      "stringArrayCallsTransform": false,
      "stringArrayEncoding": [
        "none",
        "base64"
      ],
      "stringArrayThreshold": 0.5,
      "stringSplitProbability": 0.3,
      "stringArrayDecompose": 1,
      "controlFlowDepth": 1,
      "controlFlowProbability": 0.4,
      "deadCodeProbability": 0.2,
      "opaquePredicatesMax": 2,
      "sentinelRate": 0,
      "integrityPoisonPoints": 2,
      "wasmInterpreter": false,
      "stringScatter": false,
      "antiLLM": false,
      // HTMLE（HTML 文本加密 / JS 内嵌 HTML）：Plus 及以上可用。
      //
      // 为什么门槛设在 Plus 而不是更低：它要把产物内容换成密文并注入运行期解码器，
      // 属于「会明显改变产物形态」的功能，与 antiLLM / debugProtection 同级；
      // Free 档只给 low 预设与基础防护，不开这一档。
      //
      // htmleKey（固定密钥）刻意不加闸门：它是 htmle 的附属项，单独限制没有
      // 意义（没有 htmle 时它本来就不起作用），加了反而会让人以为能单独用。
      // 注意闸门只挂在 htmle 这一个键上，Plus 及以上没设这个键 = 全放行，
      // 与 antiLLM 的写法一致。
      "htmle": false,
      "rtDepth": 1,
      "shellDepth": 1,
      "shellForm": [
        "classic"
      ]
    }
  },
  // 2026-09-22 起：订阅档为 Free(low) < Plus(high) < Team(max) = Business(max)。
  // 提预设上限必须同时把闸门放宽到能放行该预设的每一个取值——high 会打开
  // envFingerprint，闸门若仍把它关着，加载期就会被 assertConsistent() 拦下。
  // Team 与 Business 同为 max 且都不设闸门，差别只剩配额。
  "plus": {
    "rank": 1,
    "code": "P",
    "display": "Plus",
    "preset": "high",
    "limits": {
      "maxFileBytes": 524288,
      "maxFilesPerRun": 3,
      "runsPerDay": 15,
      "runsTotal": 0
    },
    "gates": {
      "vmDecoyOps": 256,
      "vmDispatchEnc": true,
      "vmBlockDecrypt": false,
      "wasm": true,
      "callProxy": true,
      "honeyStrings": true,
      "decoyFunctions": true,
      "debugProtection": true,
      "antiCDP": true,
      "debugPoison": true,
      "selfDefending": true,
      "integrityCheck": true,
      "shell": true,
      "consoleStub": false,
      "stringArrayMixedEncoding": true,
      "stringArrayCallsTransform": false,
      "stringArrayEncoding": [
        "none",
        "xor",
        "base64",
        "rc4",
        "affine",
        "add",
        "xorrev"
      ],
      "stringArrayThreshold": 1,
      "stringSplitProbability": 1,
      "stringArrayDecompose": 3,
      "controlFlowDepth": 2,
      "controlFlowProbability": 1,
      "deadCodeProbability": 0.8,
      "opaquePredicatesMax": 6,
      "sentinelRate": 0.5,
      "integrityPoisonPoints": 4,
      "shellDepth": 1
    }
  },
  "team": {
    "rank": 2,
    "code": "T",
    "display": "Team",
    "preset": "max",
    "limits": {
      "maxFileBytes": 1048576,
      "maxFilesPerRun": 5,
      "runsPerDay": 50,
      "runsTotal": 0
    },
    "gates": {}
  },
  "business": {
    "rank": 3,
    "code": "B",
    "display": "Business",
    "preset": "max",
    // 2026-09-20：配额由"不限"改为有限值 1000/天。
    // 2026-09-26：再按 Vercel 免费档包络收敛到 200/天、单文件 1.25 MiB——
    // max 预设实测 87× 膨胀、170 ms/KB，免费档 CPU 与上传硬线撑不住更大的值。
    // 需要更高额度：升级 Vercel 套餐后用 JSLB_* 环境变量放宽包络（见 DEPLOY-VERCEL.md）。
    "limits": {
      "maxFileBytes": 1310720,
      "maxFilesPerRun": 8,
      "runsPerDay": 200,
      "runsTotal": 0
    },
    "gates": {}
  },
  // 一次性额度包。与订阅档不是一个阶梯：额度包不按日重置，买断 100/1000/10000
  // 次，用完为止（卡密自带的到期时间仍然是硬上限）。能力跟随 Business（max
  // 预设、无闸门），买的就是次数，不是能力。
  //
  // kind:"pack" 让 plan.js 把它单独成组：两族的配额口径不同，混在一条阶梯上
  // 比不出高低（订阅档的 runsTotal 恒为不限，额度包却是有限值），硬排会误报倒挂。
  "pack100": {
    "rank": 4,
    "code": "S",
    "display": "Pack 100",
    "kind": "pack",
    "preset": "max",
    "limits": {
      "maxFileBytes": 1310720,
      "maxFilesPerRun": 8,
      "runsPerDay": 0,
      "runsTotal": 100
    },
    "gates": {}
  },
  "pack1000": {
    "rank": 5,
    "code": "M",
    "display": "Pack 1000",
    "kind": "pack",
    "preset": "max",
    "limits": {
      "maxFileBytes": 1310720,
      "maxFilesPerRun": 8,
      "runsPerDay": 0,
      "runsTotal": 1000
    },
    "gates": {}
  },
  "pack10000": {
    "rank": 6,
    "code": "W",
    "display": "Pack 10000",
    "kind": "pack",
    "preset": "max",
    "limits": {
      "maxFileBytes": 1310720,
      "maxFilesPerRun": 8,
      "runsPerDay": 0,
      "runsTotal": 10000
    },
    "gates": {}
  },
  // 更大的额度按合同谈：卡上不设上限，价目表上写"联系作者"
  "packCustom": {
    "rank": 7,
    "code": "C",
    "display": "Pack Custom",
    "kind": "pack",
    "preset": "max",
    "note": "contact",
    "limits": {
      "maxFileBytes": 1310720,
      "maxFilesPerRun": 8,
      "runsPerDay": 0,
      "runsTotal": 0
    },
    "gates": {}
  }
};
