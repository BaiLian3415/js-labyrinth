export default {
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
      "vmPolymorph": false,
      "vmBlockDecrypt": false,
      "wasm": false,
      "callProxy": false,
      "honeyStrings": false,
      "decoyFunctions": false,
      "debugProtection": false,
      "antiCDP": false,
      "domainLock": [""],
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
      "bannerText": [""],
      "wasmInterpreter": false,
      "stringScatter": false,
      "antiLLM": false,
      "rtDepth": 1,
      "shellDepth": 1
    }
  },
  // 2026-09-22 起：订阅档为 Free(low) < Plus(high) < Team(max) = Business(max)。
  // 提预设上限必须同时把闸门放宽到能放行该预设的**每一个**取值——high 会打开
  // envFingerprint，闸门若仍把它关着，加载期就会被 assertConsistent() 拦下。
  // Team 与 Business 同为 max 且都不设闸门，差别只剩配额。
  "plus": {
    "rank": 1,
    "code": "P",
    "display": "Plus",
    "preset": "high",
    "limits": {
      "maxFileBytes": 4194304,
      "maxFilesPerRun": 5,
      "runsPerDay": 20,
      "runsTotal": 0
    },
    "gates": {
      "vmDecoyOps": 256,
      "vmDispatchEnc": true,
      "vmPolymorph": false,
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
        "rc4"
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
      "wasmInterpreter": false,
      "rtDepth": 4,
      "shellDepth": 1
    }
  },
  "team": {
    "rank": 2,
    "code": "T",
    "display": "Team",
    "preset": "max",
    "limits": {
      "maxFileBytes": 7340032,
      "maxFilesPerRun": 10,
      "runsPerDay": 200,
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
    // 原来 runsPerDay=0（不限）+ note:"contact"，实际限制靠"不签卡"而不是代码，
    // 界面上也永远显示"联系作者"，数字看不到。改成有限值后：① 配额有真实上限，
    // ② 去掉 note 让界面显示"每日 1000 次"，③ 仍高于 Team 的 200，阶梯不倒挂。
    // 需要更高额度的客户按合同单独签卡（改这里或另出定制档）。
    "limits": {
      "maxFileBytes": 10485760,
      "maxFilesPerRun": 10,
      "runsPerDay": 1000,
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
      "maxFileBytes": 10485760,
      "maxFilesPerRun": 10,
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
      "maxFileBytes": 10485760,
      "maxFilesPerRun": 10,
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
      "maxFileBytes": 10485760,
      "maxFilesPerRun": 10,
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
      "maxFileBytes": 10485760,
      "maxFilesPerRun": 10,
      "runsPerDay": 0,
      "runsTotal": 0
    },
    "gates": {}
  }
};
