/** 国际化（zh / en）。缺 key 回退 zh，zh 也没有返回 key 本身。 */

import { VERSION as PKG_VERSION } from './version.js';
import platform from './platform.js';

const STRINGS = {
  zh: {
    // 参数错误与建议
    errorPrefix: '参数错误: {msg}',
    didYouMean: '\n您可能想输入:\n  {hits}',
    noCloseMatch: '\n未找到相近选项，完整列表见 --help。',
    matchItem: '{flag}（匹配率 {rate}%）',
    missingValue: '选项 {flag} 缺少取值',
    enumOnly: '{flag} 只接受: {values}',
    enumIntRange: '（或 {lo}~{hi} 的整数）',
    gotValue: '；收到 "{raw}"',
    mustBeNumber: '{flag} 的取值必须是数字；收到 "{raw}"',
    mustBePercent: '{flag} 的取值必须是 0~1 的数字；收到 "{raw}"',
    mustBeCount: '{flag} 的取值必须是非负整数；收到 "{raw}"',
    mustBeInt: '{flag} 的取值必须是整数 {desc}；收到 "{raw}"',
    rangeLoHi: '{lo}~{hi}',
    rangeMin: '≥ {lo}',
    rangeMax: '≤ {hi}',
    extraPositional: '多余的位置参数 "{a}"（只接受 <input> [output] 两个）',
    unknownShort: '未知短选项 "{a}"',
    unknownOption: '未知选项 "{a}"',
    noFlagOnValueOption: '选项 --{pos} 为值型选项，不支持 --no-{pos} 形式',
    boolNoValue: '开关选项 {flag} 不接受取值（用 --{on} 开、--{off} 关）',
    // 统计与进度
    statsHeader: '[混淆统计]',
    statsSize: '  大小: {in} -> {out} 字节 ({ratio}%)',
    warningPrefix: '警告: ',
    // HTML 处理
    htmlNoScripts: '未找到可混淆的内联脚本（外部 src: {ext}, 非 JS type: {type}, 空/空白: {empty}）',
    htmlBlockFailedWarn: '{n} 个脚本块混淆失败，已保留原样',
    htmlSummary: '内联脚本: 混淆 {n} 块（跳过 src {ext}、type {type}、空 {empty}{failedPart}）',
    htmlSummaryFailed: '、失败 {n}',
    htmlSharedWarning: '脚本块 #{n} 引用其他块的顶层声明（{names}）——重命名与 IIFE 包装会破坏跨块全局共享，请合并脚本或调整页面结构',
    htmlBlockError: '脚本块 #{n} 混淆失败，保留原样: {msg}',
    htmlFail: 'HTML 处理失败: {msg}',
    // 配置文件
    configReadError: '无法读取配置文件: {msg}',
    configNotObject: '配置文件顶层必须是 JSON 对象',
    configUnknownKey: '配置文件 "{file}" 含未知选项 "{k}"',
    badPreset: '未知的混淆强度预设 "{p}"；可用: {names}',
    // 目录批量
    dirStart: '目录批量混淆: {in} -> {out}',
    dirFail: '目录混淆失败: {msg}',
    dirSameAsInput: '输出目录不能与输入目录相同（会覆盖源文件）',
    dirReadDirError: '读取目录失败: {msg}',
    dirReadFileError: '读取失败: {msg}',
    dirCopyError: '复制失败: {msg}',
    dirOk: '  [OK] {file}  {in} -> {out} 字节',
    dirError: '  [ERR] {file}: {err}',
    dirCopied: '  [CP] {file}（原样复制）',
    dirSkippedDir: '  → 跳过目录 {file}',
    dirSkipped: '  → 跳过 {file}',
    dirDone: '完成: 混淆 {ok}，复制 {copied}，跳过 {skipped}，失败 {failed}；' +
      'JS 总字节 {in} -> {out}',
    // 文件读写与混淆结果
    inputReadError: '无法读取输入文件: {msg}',
    writeError: '无法写入输出文件: {msg}',
    written: '已写入: {path}',
    obfFail: '混淆失败: {msg}',
    badIdentifierPrefix: 'identifierPrefix 非法："{p}" 不是合法标识符前缀' +
      '（不得以数字开头、不得含标识符字符集以外的符号）。' +
      '正确的十六进制风格前缀是 "_0x"（下划线开头），而非 "0x"。',
    selfCheckFailed: '混淆后自检失败：发现 {n} 处未绑定引用（可能由重命名/替换漏改导致）:\n{shown}{more}' +
      '\n（如为宿主自定义全局，可用 --no-self-check 关闭此检查）',
    selfCheckMore: '\n…',
    // 许可证与激活
    licFirstRun: '未检测到有效许可证，首次运行需要激活。\n许可证将写入: {path}',
    licNeedTty: '当前不是交互式终端；可用环境变量 JSLABYRINTH_LICENSE_KEY 提供卡密。',
    licPrompt: '请输入卡密: ',
    licInvalid: '本地许可证无效（{reason}），需要重新激活。',
    licFail: '激活失败: {reason}',
    licHowTo: '请向发行方索取卡密；发卡工具: node tools/issue/keygen.js',
    licActivated: '激活成功，许可证已写入: {path}',
    licOkPerpetual: '许可证有效（套餐 {plan}，永久授权）  机器码: {machine}',
    licOkUntil: '许可证有效（套餐 {plan}，有效期至 {date}）  机器码: {machine}',
    licUsageLimited: '今日用量: {used}/{total} 次（套餐 {plan}）',
    licUsageUnlimited: '今日用量: {used} 次（套餐 {plan}，不限次数）',
    licUsageTotal: '累计用量: {used}/{total} 次（{plan}，一次性额度）',
    licUsageTotalUnlimited: '累计用量: {used} 次（{plan}，不限额度）',
    licUsageWriteFailed: '许可证用量写入失败: {msg}（本次任务未计入配额，请检查许可证文件权限）',
    licReason_missing: '未找到许可证文件',
    licReason_unreadable: '许可证文件无法读取',
    licReason_corrupt: '许可证文件已损坏',
    licReason_version: '许可证格式版本不受支持（旧版许可证需用新卡密重新激活）',
    licReason_code: '卡密无效',
    licReason_machine: '许可证绑定的是另一台机器',
    licReason_bind: '这张卡密绑定了另一台机器（需用本机机器码重新签发）',
    licReason_expirymismatch: '许可证到期时间与卡密不符',
    licReason_planmismatch: '许可证套餐与卡密不符',
    licReason_token: '许可证签名校验失败（文件被篡改）',
    licReason_expired: '许可证已过期',
    licReason_prefix: '卡密前缀不正确（应为 JSLB）',
    licReason_length: '卡密长度不正确（若为旧版卡密：v4 起带机器绑定段，旧卡一律作废，请重新签发）',
    licReason_alphabet: '卡密含非法字符',
    licReason_plan: '卡密套餐标识无效',
    licReason_signature: '卡密签名校验失败（需 Ed25519 私钥签发的新卡；旧版对称签名的卡已作废）',
    licReason_key: '签发公钥不可用（配置的 JSLB_PUBLIC_KEY 不是 32 字节 base64）',
    licReason_noinput: '未输入卡密',
    licReason_write: '许可证文件写入失败（目录不可写？）',
    licReason_quota: '今日混淆次数已用尽',
    licReason_nolicense: '尚未取得有效授权',
    licReason_trap: '运行环境校验未通过',
    // 套餐权益
    planNotSelectable: '套餐由卡密决定，不能用命令行切换（当前套餐: {plan}，机器码: {machine}）。' +
      '升级请联系发行方换发对应套餐的卡密: node tools/issue/keygen.js --plan <名称>',
    planPresetBlocked: '预设 {preset} 超出套餐 {plan} 的强度上限 {ceiling}{need}',
    planBoolBlocked: '选项 {flag} 不在套餐 {plan} 的可用范围内{need}',
    planNumBlocked: '选项 {flag} 取值 {value} 超出套餐 {plan} 的上限 {cap}{need}',
    planEnumBlocked: '选项 {flag} 取值 {value} 不在套餐 {plan} 的可选范围内（允许: {allowed}）{need}',
    planNeed: '；需 {plan} 或更高套餐',
    planNeedTop: '；需 {plan} 套餐',
    planUpgradeHint: '当前套餐 {plan}（{limits}）。升级套餐可解锁更多混淆选项与更高配额，' +
      '发卡: node tools/issue/keygen.js --plan <名称> --plans 查看对照',
    planLimits: '单文件 ≤ {file}，每任务 ≤ {files} 个文件，每日 ≤ {runs} 次',
    planLimitsPack: '单文件 ≤ {file}，每任务 ≤ {files} 个文件，总额度 {total} 次',
    planQuotaExhausted: '今日混淆次数已用尽（套餐 {plan}，每日 {total} 次），请明日再试{upgrade}。',
    planPackExhausted: '一次性额度已用尽（{plan}，共 {total} 次），请重新购买或联系作者。',
    planQuotaUpgrade: '或升级套餐',
    planQuotaDaily: '每日 {runs} 次',
    planQuotaDailyUnlimited: '每日不限次数',
    planQuotaPack: '总额度 {total} 次',
    planContactAuthor: '联系作者',
    planFileTooBig: '文件 {size} 字节超出套餐 {plan} 的单文件上限 {limit} 字节{need}',
    planTooManyFiles: '本次任务已处理 {max} 个 JS 文件，达到套餐 {plan} 的单任务上限{need}',
    planUnlimited: '不限',
    planFeatureAll: '全部选项',
    planFeatureExcept: '不含 {list}',
    planHelpHeader: '套餐权益（由卡密决定，命令行不可切换；发卡: node tools/issue/keygen.js --plan <名称>）:',
    planHelpRow: '  {display}  预设上限 {preset}；单文件 {file}；每任务 {files} 个文件；{quota}；{features}',
    // pass 内部错误
    vmBreakOutsideLoop: 'vm: break 不在循环内',
    vmContinueOutsideLoop: 'vm: continue 不在循环内',
    vmUnsupportedStatement: 'vm: 不支持的语句 {type}',
    vmChainSolveFailed: 'vm: 链值字求解失败',
    vmUnknownOpcode: 'vm: 未知操作码 {kind}',
    badStringArrayEvolve: 'stringArrayEvolve 非法: {v}（可用 "each" / "sparse" 或 0~7 整数）',
    // parser 与 generator
    parseUnterminatedTemplate: '模板串未闭合',
    parseUnterminatedString: '字符串未闭合',
    parseUnterminatedRegex: '正则未闭合',
    parseMultilineRegex: '正则跨行',
    parseUnclosedBlock: '块未闭合',
    parseUnclosedSwitch: 'switch 未闭合',
    parseTryNeedsCatch: 'try 必须有 catch 或 finally',
    parseThrowNoNewline: 'throw 后不能换行（ASI 不会插入分号）',
    parseUnclosedClass: 'class 未闭合',
    parseEmptyParens: '空的括号表达式',
    parseParenFailed: '括号表达式解析失败',
    parseExpectedValue: '期望 "{v}" 但得到 {got}',
    parseExpectedIdentPattern: '期望标识符或解构模式',
    parseExpectedSemicolon: '期望分号，得到 {got}',
    parseInvalidPropKey: '无效的属性键',
    parseExpectedIdent: '期望标识符',
    parseInvalidExport: '无效的 export',
    parseExpectedString: '期望字符串',
    parseUnexpectedToken: '意外的 token: {tok}（该语法可能不被本解析器支持）',
    parseInvalidObjectProp: '无效的对象属性',
    parseTemplateTokenError: '模板串 token 错误',
    parseTemplateExprUnclosed: '模板表达式未闭合',
    generatorMissingName: 'generator: Identifier 节点缺少 name（AST 已损坏）',
    generatorBadIdentifier: 'generator: 非法标识符名 "{nm}"（以数字开头——检查 identifierPrefix 配置，' +
      '十六进制风格前缀应为 "_0x" 而非 "0x"）',
    // 帮助文本
    help: `JsLabyrinth v${PKG_VERSION} — JS 代码混淆器
用法: node host/cli.js <input.js | input.html | inputDir> [output] [选项]
  -o, --output <file|dir>    输出文件（JS 默认 <input>.obfuscated.js，HTML 默认 .obfuscated.html）；
                             目录输入时为输出目录（默认 <inputDir>.obfuscated）
  --preset <low|medium|high|max>
                             混淆强度预设（--intensity 同义，大小写不敏感）：
                             low=轻量，无 VM/WASM/壳/反调试，保留可读与性能；
                             medium=均衡，开启 VM 与壳但降低密度；
                             high=强度优先（与默认配置一致的全量档）；
                             max=极限，VM/WASM 全覆盖 + 双层壳 + 最高密度。
                             预设只提供默认值，同一次调用里显式写的选项逐字段
                             覆盖它，例如 --preset max --no-debug-protection
  --config <file.json>       从 JSON 加载选项
  --lang <zh|en>             提示语言（默认 zh；也可用环境变量 JSLABYRINTH_LANG）
  --seed <n>                 固定随机种子
  --no-mangle                关闭标识符重命名
  --identifier-prefix <px>   标识符前缀（默认 _0x）
  --no-string-array          关闭字符串数组
  --string-array-encoding <none|xor|base64|rc4>
  --string-array-threshold <n>  字符串收集概率 0~1（默认 1）
  --string-array-evolve <each|sparse>
                              动态 xor 槽位密文演化门（默认 sparse）：each=
                              每次访问推进计数并原位重加密（热路径最贵）；
                              sparse=每组随机 1~3 的门掩码，两次演化之间
                              直接命中明文缓存（O(1)），密文快照仍按攻击者
                              不可见的时刻表漂移；也可传 0~7 整数自定
  --string-split-threshold <n> 参与拆段的最小字符串长度（默认 8：短串
                              拆段只产生调用点/池条目膨胀，不增加还原难度）
  --string-split-probability <n> 拆段概率 0~1（默认 1）
  --string-array-decompose <n> 字符串池分组倍数（默认 2）：越大分组越多，
                              每组独立算法/密钥/解码结构，破坏统一还原器
  --no-string-index-mask     关闭字符串数组索引 XOR 掩码
   --no-string-array-cache    关闭解码明文记忆（默认开：动态 XOR 槽位密文
                              演化门与投毒位检查仍每次访问生效，仅缓存已
                              解明明文与码元表）
  --no-control-flow          关闭控制流扁平化
  --no-vm                    关闭虚拟机保护（VMP）
  --vm-mode <global|comment|only-string>
                             VMP 目标筛选：global=全部可编译函数（默认）；
                             comment=仅 *-jsvmp-* 注释标记的函数（注释在函数
                             体内或紧贴声明之前）；only-string=仅函数体含
                             字符串字面量的函数，字符串以码元密文表进 VM，
                             不出现明文，调用时由 VM 指令解密还原出 string
                             再交回调用方
  --vm-threshold <n>         VMP 函数最小语句数（options.js 默认 1）
  --vm-decoy-ops <n>         每编译函数分发器枚举的分发字总数（默认 256：
                             真实操作码 + 每构建随机生成的干扰项 ≥1000+；
                             0 = 关闭干扰项）
  --no-wasm                  关闭 WASM 虚拟机档（默认开）
  --wasm-threshold <n>       搬入 WASM 的函数最小字节码字数（0 = 全部）
  --control-flow-threshold <n>  扁平化最小语句数（options.js 默认 1）
  --control-flow-probability <n> 扁平化概率 0~1（默认 1）
  --control-flow-depth <n>    扁平化嵌套层数 1~8（默认 1）
  --no-object-keys           关闭对象键编码
  --no-number-obfuscation    关闭数值常量混淆（整数字面量改写为取值恒等的算术
                              /位运算表达式，形态逐处随机）
  --number-obfuscation-threshold <n>
                              数值常量混淆概率 0~1（默认 0.6）
  --no-control-flow-rolling-key
                              关闭扁平化分派表的运行期滚动重键（默认开）：状态
                              变量以"异或当前轮密钥"的形式存放，密钥每次分派推进
                              一次，同一条边在同一次运行里不会取到同一个值
  --no-logical-expressions   关闭逻辑表达式混淆
  --no-condition-obfuscation 关闭条件表达式混淆（比较运算符取反）
  --no-opaque-predicates     关闭不透明谓词注入（默认开）
  --no-template-concat       关闭模板串降级
  --no-function-wrapper      关闭函数包装
  --no-dead-code             关闭死代码注入
  --no-honey-strings         关闭蜂蜜字符串（字符串池中的假 API key/endpoint 诱饵）
  --no-decoy-functions       关闭语义诱饵死函数（注入形似真实业务、永不调用的函数）
  --no-debug-protection      关闭反调试
  --debug-poison / --no-debug-poison
                             反调试确认投毒联动（默认开）：超过确认阈值的 debugger
                             暂停记一次确认命中，两次确认命中或一次确认 + Node
                             --inspect 证据 → 置毒药标志 → 字符串解码输出损坏；
                             stringArray 关闭时自动降级
  --debug-protection-interval <ms>
  --sentinel-rate <n>        函数级哨兵注入率 0~1（默认 0.35，抽样注入 +
                             逐函数独立变体——密度不带来线性强度）
  --console-stub             使 console 方法失效
  --no-self-defending        关闭字符串数组自检
  --no-self-check            关闭混淆后自校验（默认开，遇未绑定引用会报错）
  --no-shell                 关闭外层自研壳（默认开）：最终产物作为载荷经
                             反馈密钥流 XOR（xorshift32+前字节+位置，自同步）
                             + 双轮索引交织 + 种子派生 S-box + 4 字节校验尾 +
                             乱序字母表 base64 + 分段乱序；S-box/字母表/段序/
                             K0（XOR 三分片）全部种子运行期派生，产物无明文
                             常量表签名。任意单字节篡改 → 反馈链错位 → FNV
                             终态差量 → 载荷首 8 字节打碎（fail-closed；无期望
                             哈希常量可锚定、无独立条件检查可整体删除）；
                             base64 非法字符与非原生 eval/Function（钩子脱壳）
                             折叠进同一差量。引导器自身再过一遍流水线
                             （平坦化/不透明谓词/死代码等）。运行环境需允许
                             eval（CSP unsafe-eval 或本地脚本）且 eval/Function
                             未被钩子替换；ESM 与 CommonJS 源自动跳过套壳
  --shell-depth <n>          套壳层数（默认 1；>1 逐层递归套壳，每层引导器
                             独立混淆，体积与加载耗时随层数上升）
  --extra-globals <names>    宿主自定义全局白名单（逗号分隔，如 WebSocketPair）——
                             显式声明后自检保持开启，未声明的宿主全局仍报错
  --no-compact               保留换行缩进（格式化输出）
  --indent <n>               格式化输出的缩进宽度（默认 2）
  -h, --help                 帮助

{plans}
`,

    // 网页版：授权状态
    webTrialPlan: '试用',
    webTrialBanner: '试用模式（未激活）  机器码: {machine}',
    webTrialNeed: '；正式使用需激活卡密',
    webTrialUpgradeHint: '当前为试用模式（{limits}）。激活卡密可解锁已购套餐的全部权益与配额。',
    webTrialQuotaUpgrade: '或激活卡密',
    webActivated: '激活成功（套餐 {plan}）',
    webActivatedNoSync: '本机已激活（套餐 {plan}），但服务端未登记此设备；若混淆时提示核心模块加载失败，请检查服务地址后重新激活',
    webActivateFailed: '激活失败: {reason}',

    // 网页版：界面
    guiTitle: 'JsLabyrinth 混淆器',
    guiInput: '输入',
    guiOutput: '输出',
    guiRun: '开始混淆',
    guiRunning: '处理中…',
    guiCopy: '复制',
    guiCopied: '已复制',
    guiDownload: '下载',
    guiDownloadZip: '打包下载 ({n})',
    guiClear: '清空',
    guiOpenFiles: '打开文件',
    guiDropHint: '拖入 .js / .html 文件，或直接粘贴代码到左侧',
    guiMode: '输入类型',
    guiModeAuto: '自动识别',
    guiModeJs: 'JavaScript',
    guiModeHtml: 'HTML 内联脚本',
    guiOptions: '选项',
    guiPreset: '混淆强度预设',
    guiAdvanced: '逐项选项',
    guiSeedTitle: '随机种子',
    guiSeed: '留空即每次不同；填写后同样的输入产出同样的结果',
    guiApiEndpoint: '服务地址',
    guiLicense: '授权',
    guiLicenseKey: '卡密',
    guiActivate: '激活',
    guiDeactivate: '解除激活',
    guiDeactivateServerFailed: '已清除本机授权，但服务端未能确认解除（可能已离线）；刷新后若仍显示已激活，请检查服务地址后重试',
    guiDevice: '机器码',
    guiDone: '完成，用时 {ms} ms',
    guiFailed: '失败: {msg}',
    guiCoreBlocked: '核心模块未加载（HTTP {code}）：服务端未识别此设备的授权。请先解除激活再重新激活一次；仍失败则检查服务地址',
    guiCoreUnreachable: '核心模块未加载（HTTP {code}）：取不到混淆核心，请检查网络与服务地址',
    guiNoInput: '请先输入要混淆的代码',
    guiBlocked: '当前授权不允许这些选项: {msg}',
    guiSize: '大小 {in} → {out} 字节（{ratio}%）',
    guiFilesN: '{n} 个文件',
    guiSelectFile: '在左侧选择文件查看结果',
    guiPickFiles: '已载入 {n} 个文件',
    guiHtmlSummary: '内联脚本: 混淆 {n} 块（跳过 src {ext}、type {type}、空 {empty}{failedPart}）',
    guiReset: '恢复默认选项',
    guiPresetHint: '预设给出默认值；改动下面的选项即为显式覆盖，换预设会把这些改动一并清掉。',
    guiPresetCeiling: '强度上限: {preset}',
    guiLimitsFile: '单文件 ≤ {file}',
    guiLimitsFiles: '每任务 ≤ {files} 个文件',
    guiLimitsRuns: '每日 ≤ {runs} 次',
    guiLimitsNoRuns: '每日不限次数',
    guiLimitsTotal: '总额度 {total} 次',
    guiLimitsContact: '额度请联系作者',
    guiTrialHint: '未激活：{limits}。激活卡密可解锁已购套餐的全部权益与配额。',
    guiThemeDark: '深色',
    guiThemeLight: '浅色',
    guiStats: '混淆统计',
    guiStatsPass: 'pass',
    guiStatsResult: '结果',
    guiOverLimit: '文件 {size} 字节超出当前授权的单文件上限 {limit} 字节',
    guiCopiedHint: '结果已复制到剪贴板',
    guiDownloadHint: '结果已下载',
    guiClipboardFail: '复制失败，请手动选中输出内容',
    guiShortcut: '快捷键',
    guiShortcutRun: '运行',
    guiApiChecking: '检测 API…',
    guiApiOnline: 'API 可用',
    guiApiOffline: '未连接授权服务',
    guiApiOnlineHint: '授权服务可用（激活与策略从这里取）；混淆始终在浏览器内完成',
    guiApiOfflineHint: '未探测到同源授权服务：此站若要求卡密，需先能连上它',
    guiServerAttestedHint: '授权由服务端认定：混淆在浏览器内完成、代码不出本机，这部分运行不计入服务端每日配额',
    guiAriaPresets: '强度预设',
    guiAriaLang: '界面语言',
    guiAriaMode: '输入类型',
    guiAriaTheme: '切换深浅色',
    guiAriaOptions: '展开或收起选项面板',
    guiAriaOutput: '混淆结果',
  },

  en: {
    // argument errors and suggestions
    errorPrefix: 'Argument error: {msg}',
    didYouMean: '\nDid you mean:\n  {hits}',
    noCloseMatch: '\nNo similar option found; run --help for the full list.',
    matchItem: '{flag} (match {rate}%)',
    missingValue: 'option {flag} is missing a value',
    enumOnly: '{flag} only accepts: {values}',
    enumIntRange: ' (or an integer {lo}..{hi})',
    gotValue: '; got "{raw}"',
    mustBeNumber: '{flag} must be a number; got "{raw}"',
    mustBePercent: '{flag} must be a number between 0 and 1; got "{raw}"',
    mustBeCount: '{flag} must be a non-negative integer; got "{raw}"',
    mustBeInt: '{flag} must be an integer {desc}; got "{raw}"',
    rangeLoHi: '{lo}..{hi}',
    rangeMin: '>= {lo}',
    rangeMax: '<= {hi}',
    extraPositional: 'extra positional argument "{a}" (only <input> [output] are accepted)',
    unknownShort: 'unknown short option "{a}"',
    unknownOption: 'unknown option "{a}"',
    noFlagOnValueOption: 'option --{pos} takes a value; --no-{pos} is not supported',
    boolNoValue: 'switch option {flag} does not take a value (use --{on} to enable, --{off} to disable)',
    // stats and progress
    statsHeader: '[Obfuscation stats]',
    statsSize: '  Size: {in} -> {out} bytes ({ratio}%)',
    warningPrefix: 'Warning: ',
    // HTML 处理
    htmlNoScripts: 'No obfuscatable inline scripts found (external src: {ext}, non-JS type: {type}, empty/whitespace: {empty})',
    htmlBlockFailedWarn: '{n} script block(s) failed to obfuscate and were left unchanged',
    htmlSummary: 'Inline scripts: obfuscated {n} block(s) (skipped src {ext}, type {type}, empty {empty}{failedPart})',
    htmlSummaryFailed: ', failed {n}',
    htmlSharedWarning: 'script block #{n} references top-level declarations of other blocks ({names}) — renaming and IIFE wrapping break cross-block global sharing; merge the scripts or restructure the page',
    htmlBlockError: 'script block #{n} failed to obfuscate and was left unchanged: {msg}',
    htmlFail: 'HTML processing failed: {msg}',
    // config file
    configReadError: 'Cannot read config file: {msg}',
    configNotObject: 'config file top level must be a JSON object',
    configUnknownKey: 'config file "{file}" contains unknown option "{k}"',
    badPreset: 'unknown obfuscation strength preset "{p}"; available: {names}',

    // directory batch
    dirStart: 'Directory batch obfuscation: {in} -> {out}',
    dirFail: 'Directory obfuscation failed: {msg}',
    dirSameAsInput: 'output directory must differ from input directory (would overwrite source files)',
    dirReadDirError: 'failed to read directory: {msg}',
    dirReadFileError: 'read failed: {msg}',
    dirCopyError: 'copy failed: {msg}',
    dirOk: '  [OK] {file}  {in} -> {out} bytes',
    dirError: '  [ERR] {file}: {err}',
    dirCopied: '  [CP] {file} (copied as-is)',
    dirSkippedDir: '  → skipped directory {file}',
    dirSkipped: '  → skipped {file}',
    dirDone: 'Done: obfuscated {ok}, copied {copied}, skipped {skipped}, failed {failed}; ' +
      'total JS bytes {in} -> {out}',
    // file IO and obfuscation result
    inputReadError: 'Cannot read input file: {msg}',
    writeError: 'Cannot write output file: {msg}',
    written: 'Written: {path}',
    obfFail: 'Obfuscation failed: {msg}',
    badIdentifierPrefix: 'invalid identifierPrefix: "{p}" is not a legal identifier prefix ' +
      '(must not start with a digit and must contain only identifier characters). ' +
      'The correct hex-style prefix is "_0x" (underscore first), not "0x".',
    selfCheckFailed: 'post-obfuscation self-check failed: found {n} unbound reference(s) ' +
      '(likely missed renames/replacements):\n{shown}{more}' +
      '\n(if these are host-provided globals, disable this check with --no-self-check)',
    selfCheckMore: '\n…',
    // license and activation
    licFirstRun: 'No valid license found; first run requires activation.\nLicense will be written to: {path}',
    licNeedTty: 'stdin is not an interactive terminal; provide the key via JSLABYRINTH_LICENSE_KEY.',
    licPrompt: 'License key: ',
    licInvalid: 'Local license is invalid ({reason}); activation is required again.',
    licFail: 'Activation failed: {reason}',
    licHowTo: 'Request a license key from the vendor; issue keys with: node tools/issue/keygen.js',
    licActivated: 'Activated. License written to: {path}',
    licOkPerpetual: 'License valid (plan {plan}, perpetual)  machine: {machine}',
    licOkUntil: 'License valid (plan {plan}, until {date})  machine: {machine}',
    licUsageLimited: 'Runs today: {used}/{total} (plan {plan})',
    licUsageUnlimited: 'Runs today: {used} (plan {plan}, unlimited)',
    licUsageTotal: 'Runs used: {used}/{total} ({plan}, one-time pack)',
    licUsageTotalUnlimited: 'Runs used: {used} ({plan}, unlimited)',
    licUsageWriteFailed: 'Could not record license usage: {msg} (this run was not counted; check the license file permissions)',
    licReason_missing: 'no license file found',
    licReason_unreadable: 'license file cannot be read',
    licReason_corrupt: 'license file is corrupted',
    licReason_version: 'unsupported license format version (old licenses must be re-activated with a new key)',
    licReason_code: 'license key is invalid',
    licReason_machine: 'license is bound to a different machine',
    licReason_bind: 'this key is bound to a different machine (re-issue it for this machine\'s id)',
    licReason_expirymismatch: 'license expiry does not match the key',
    licReason_planmismatch: 'license plan does not match the key',
    licReason_token: 'license signature check failed (file was modified)',
    licReason_expired: 'license has expired',
    licReason_prefix: 'wrong key prefix (expected JSLB)',
    licReason_length: 'wrong key length (if this is an old key: v4 added a machine-binding segment, old keys are void — re-issue)',
    licReason_alphabet: 'key contains illegal characters',
    licReason_plan: 'key carries an unknown plan marker',
    licReason_signature: 'key signature check failed (needs a key issued with the Ed25519 private key; cards signed with the old symmetric scheme are void)',
    licReason_key: 'signing public key unusable (configured JSLB_PUBLIC_KEY is not 32 bytes of base64)',
    licReason_noinput: 'no key entered',
    licReason_write: 'could not write the license file (directory not writable?)',
    licReason_quota: 'the daily run quota is used up',
    licReason_nolicense: 'no valid license has been obtained yet',
    licReason_trap: 'the runtime integrity check failed',
    // plan entitlements
    planNotSelectable: 'The plan is carried by the license key and cannot be switched from the command line ' +
      '(current plan: {plan}, machine: {machine}). Ask the vendor for a key of the plan you need: ' +
      'node tools/issue/keygen.js --plan <name>',
    planPresetBlocked: 'preset {preset} exceeds the {ceiling} strength ceiling of plan {plan}{need}',
    planBoolBlocked: 'option {flag} is not available in plan {plan}{need}',
    planNumBlocked: 'option {flag} value {value} exceeds the {cap} ceiling of plan {plan}{need}',
    planEnumBlocked: 'option {flag} value {value} is not allowed in plan {plan} (allowed: {allowed}){need}',
    planNeed: '; requires {plan} or higher',
    planNeedTop: '; requires plan {plan}',
    planUpgradeHint: 'Current plan {plan} ({limits}). Upgrading unlocks more obfuscation options and higher quotas; ' +
      'issue keys with node tools/issue/keygen.js --plan <name>, see --plans for the comparison',
    planLimits: 'single file <= {file}, <= {files} files per run, <= {runs} runs per day',
    planLimitsPack: 'single file <= {file}, <= {files} files per run, {total} runs in total',
    planQuotaExhausted: 'The daily run quota is used up (plan {plan}, {total} runs per day); retry tomorrow{upgrade}.',
    planPackExhausted: 'The one-time quota is used up ({plan}, {total} runs in total); buy another pack or contact the author.',
    planQuotaUpgrade: ' or upgrade your plan',
    planQuotaDaily: '{runs} runs per day',
    planQuotaDailyUnlimited: 'unlimited runs per day',
    planQuotaPack: '{total} runs in total',
    planContactAuthor: 'contact the author',
    planFileTooBig: 'file is {size} bytes, over the {limit}-byte single-file limit of plan {plan}{need}',
    planTooManyFiles: 'this run already processed {max} JS files, the per-run limit of plan {plan}{need}',
    planUnlimited: 'unlimited',
    planFeatureAll: 'all options',
    planFeatureExcept: 'without {list}',
    planHelpHeader: 'Plan entitlements (carried by the license key, not switchable from the CLI; issue keys with ' +
      'node tools/issue/keygen.js --plan <name>):',
    planHelpRow: '  {display}  preset ceiling {preset}; single file {file}; {files} files per run; {quota}; {features}',
    // pass-internal errors
    vmBreakOutsideLoop: 'vm: break outside loop',
    vmContinueOutsideLoop: 'vm: continue outside loop',
    vmUnsupportedStatement: 'vm: unsupported statement {type}',
    vmChainSolveFailed: 'vm: chain value-word solving failed',
    vmUnknownOpcode: 'vm: unknown opcode {kind}',
    badStringArrayEvolve: 'invalid stringArrayEvolve: {v} (use "each" / "sparse" or an integer 0..7)',
    // parser 与 generator
    parseUnterminatedTemplate: 'unterminated template literal',
    parseUnterminatedString: 'unterminated string literal',
    parseUnterminatedRegex: 'unterminated regular expression',
    parseMultilineRegex: 'regular expression spans lines',
    parseUnclosedBlock: 'block is not closed',
    parseUnclosedSwitch: 'switch statement is not closed',
    parseTryNeedsCatch: 'try must have a catch or finally clause',
    parseThrowNoNewline: 'no line break allowed after throw (ASI does not insert a semicolon)',
    parseUnclosedClass: 'class body is not closed',
    parseEmptyParens: 'empty parentheses expression',
    parseParenFailed: 'parenthesized expression parse failed',
    parseExpectedValue: 'expected "{v}" but got {got}',
    parseExpectedIdentPattern: 'expected an identifier or destructuring pattern',
    parseExpectedSemicolon: 'expected a semicolon, got {got}',
    parseInvalidPropKey: 'invalid property key',
    parseExpectedIdent: 'expected an identifier',
    parseInvalidExport: 'invalid export',
    parseExpectedString: 'expected a string literal',
    parseUnexpectedToken: 'unexpected token: {tok} (this syntax may not be supported by the parser)',
    parseInvalidObjectProp: 'invalid object property',
    parseTemplateTokenError: 'template literal token error',
    parseTemplateExprUnclosed: 'template expression is not closed',
    generatorMissingName: 'generator: Identifier node has no name (AST is corrupted)',
    generatorBadIdentifier: 'generator: invalid identifier name "{nm}" (starts with a digit — ' +
      'check the identifierPrefix setting; the hex-style prefix should be "_0x", not "0x")',
    // help text
    help: `JsLabyrinth v${PKG_VERSION} — JavaScript code obfuscator
Usage: node host/cli.js <input.js | input.html | inputDir> [output] [options]
  -o, --output <file|dir>    Output file (JS default <input>.obfuscated.js, HTML default
                             .obfuscated.html); for directory input this is the output
                             directory (default <inputDir>.obfuscated)
  --preset <low|medium|high|max>
                             Obfuscation strength preset (--intensity is a synonym;
                             case-insensitive): low = light, no VM/WASM/shell/anti-debug,
                             keeps readability and performance; medium = balanced, VM
                             and shell on at lower density; high = strength first (the
                             same full config as the defaults); max = extreme, full
                             VM/WASM coverage + double shell at top density. A preset
                             only supplies defaults: explicit options in the same call
                             override it field by field, e.g.
                             --preset max --no-debug-protection
  --config <file.json>       Load options from a JSON file
  --lang <zh|en>             Message language (default zh; env JSLABYRINTH_LANG also works)
  --seed <n>                 Fixed random seed (reproducible output)
  --no-mangle                Disable identifier renaming
  --identifier-prefix <px>   Identifier prefix (default _0x)
  --no-string-array          Disable the string array
  --string-array-encoding <none|xor|base64|rc4>
  --string-array-threshold <n>  String collection probability 0~1 (default 1)
  --string-array-evolve <each|sparse>
                              Dynamic XOR slot ciphertext evolution gate (default sparse):
                              each = every access advances the counter and re-encrypts in
                              place (costliest on hot paths); sparse = per-group random
                              1~3 gate masks, repeated accesses between two evolutions hit
                              the plaintext cache directly (O(1)) while the ciphertext
                              snapshot still drifts on a schedule invisible to the
                              attacker; an integer 0~7 customizes the gate
  --string-split-threshold <n> Minimum string length eligible for splitting (default 8:
                              splitting short strings only inflates call sites/pool
                              entries without raising recovery difficulty)
  --string-split-probability <n> Split probability 0~1 (default 1)
  --string-array-decompose <n> String pool grouping multiplier (default 2): larger
                               values split the pool into more groups, each with its
                               own algorithm/key/decoder shape
  --no-string-index-mask     Disable the string array index XOR mask
  --no-string-array-cache    Disable decoded-plaintext memoization (on by default: the
                              dynamic XOR slot evolution gate and poison-bit checks still
                              run on every access; only decoded plaintext and code tables
                              are cached)
  --no-control-flow          Disable control flow flattening
  --no-vm                    Disable virtual machine protection (VMP)
  --vm-mode <global|comment|only-string>
                              VMP target selection: global = all compilable functions
                              (default); comment = only functions marked with *-jsvmp-*
                              comments (inside the body or immediately before the
                              declaration); only-string = only functions whose bodies
                              contain string literals, which are carried into the VM as
                              an encrypted code-unit table: no plaintext appears, and the
                              VM opcode decrypts and returns the string at call time
  --vm-threshold <n>         Minimum statement count per VMP function (options.js default 1)
  --vm-decoy-ops <n>         Total dispatch words in each compiled function's dispatcher
                              (default 256: real opcodes + per-build random decoys
                              >=1000+; 0 = disable decoys)
  --no-wasm                  Disable the WASM VM tier (on by default)
  --wasm-threshold <n>       Minimum bytecode word count for functions moved into WASM
                              (0 = all)
  --control-flow-threshold <n>  Minimum statement count for flattening (options.js default 1)
  --control-flow-probability <n> Flattening probability 0~1 (default 1)
  --control-flow-depth <n>    Flattening nesting depth 1~8 (default 1)
  --no-object-keys           Disable object key encoding
  --no-number-obfuscation    Disable number obfuscation (integer literals become
                              value-identical arithmetic/bitwise expressions)
  --number-obfuscation-threshold <n>
                              Number obfuscation probability 0~1 (default 0.6)
  --no-control-flow-rolling-key
                              Disable the runtime rolling re-key of the flattened dispatch
                              table (on by default): the state variable is stored XORed with
                              a key that advances on every dispatch, so the same edge never
                              carries the same value twice in a run
  --no-logical-expressions   Disable logical expression obfuscation
  --no-condition-obfuscation Disable condition obfuscation (comparison operator negation)
  --no-opaque-predicates     Disable opaque predicate injection (on by default)
  --no-template-concat       Disable template literal lowering
  --no-function-wrapper      Disable the function wrapper
  --no-dead-code             Disable dead code injection
  --no-honey-strings         Disable honey strings (fake API key/endpoint decoys in the
                              string pool)
  --no-decoy-functions       Disable semantic decoy dead functions (injects plausible
                              business functions that are never called)
  --no-debug-protection      Disable anti-debugging
  --debug-poison / --no-debug-poison
                              Anti-debug confirmed-poisoning linkage (on by default): a
                              debugger pause beyond the confirmation threshold counts as
                              one confirmed hit; two confirmed hits, or one confirmed hit
                              plus Node --inspect evidence, set the poison flag and corrupt
                              string decoding output; automatically downgraded when
                              stringArray is off
  --debug-protection-interval <ms>
  --sentinel-rate <n>        Function-level sentinel injection rate 0~1 (default 0.35;
                              sampled injection with per-function independent variants —
                              density does not bring linear strength)
  --console-stub             Neutralize console methods
  --no-self-defending        Disable string array self-defending
  --no-self-check            Disable post-obfuscation self-check (on by default; errors on
                              unbound references)
  --no-shell                 Disable the outer custom shell (on by default): the final
                              artifact ships as a payload through feedback keystream XOR
                              (xorshift32 + previous byte + position, self-synchronizing) +
                              double-round index interleaving + seed-derived S-box + 4-byte
                              checksum tail + shuffled-alphabet base64 + segment shuffling;
                              the S-box/alphabet/segment order/K0 (three XOR shards) are all
                              derived from the seed at runtime, so the artifact carries no
                              plaintext constant-table signature. Any single-byte tampering
                              desynchronizes the feedback chain and shatters the payload's
                              first 8 bytes via the FNV final delta (fail-closed; no
                              expected hash constant to anchor on, no standalone conditional
                              check to delete wholesale); illegal base64 characters and
                              non-native eval/Function (hooked unpacking) fold into the same
                              delta. The bootstrap itself goes through the pipeline once
                              more (flattening/opaque predicates/dead code etc.). The
                              runtime must allow eval (CSP unsafe-eval or local scripts)
                              and eval/Function must not be hook-replaced; ESM and CommonJS
                              sources automatically skip shell wrapping
  --shell-depth <n>          Shell layers (default 1; >1 shells recursively per layer, each
                              bootstrap independently obfuscated; size and load time grow
                              with depth)
  --extra-globals <names>    Host custom global whitelist (comma-separated, e.g.
                              WebSocketPair) — with an explicit declaration the self-check
                              stays on; undeclared host globals still error
  --no-compact               Keep newlines and indentation (formatted output)
  --indent <n>               Indent width for formatted output (default 2)
  -h, --help                 Help

{plans}
`,

    // web: license state
    webTrialPlan: 'Trial',
    webTrialBanner: 'Trial mode (not activated)  machine id: {machine}',
    webTrialNeed: '; activate a license key for production use',
    webTrialUpgradeHint: 'Running in trial mode ({limits}). Activate a license key to unlock the full entitlements and quotas of your plan.',
    webTrialQuotaUpgrade: ' or activate a license key',
    webActivated: 'Activated (plan {plan})',
    webActivatedNoSync: 'Activated locally (plan {plan}), but the server has no record for this device; if obfuscation reports that core modules failed to load, check the API endpoint and activate again',
    webActivateFailed: 'Activation failed: {reason}',

    // web: GUI
    guiTitle: 'JsLabyrinth Obfuscator',
    guiInput: 'Input',
    guiOutput: 'Output',
    guiRun: 'Obfuscate',
    guiRunning: 'Working…',
    guiCopy: 'Copy',
    guiCopied: 'Copied',
    guiDownload: 'Download',
    guiDownloadZip: 'Download .zip ({n})',
    guiClear: 'Clear',
    guiOpenFiles: 'Open files',
    guiDropHint: 'Drop .js / .html files here, or paste code on the left',
    guiMode: 'Input type',
    guiModeAuto: 'Auto detect',
    guiModeJs: 'JavaScript',
    guiModeHtml: 'HTML inline scripts',
    guiOptions: 'Options',
    guiPreset: 'Strength preset',
    guiAdvanced: 'Individual options',
    guiSeedTitle: 'Random seed',
    guiSeed: 'blank = different every run; a fixed value reproduces the same output',
    guiApiEndpoint: 'Service endpoint',
    guiLicense: 'License',
    guiLicenseKey: 'License key',
    guiActivate: 'Activate',
    guiDeactivate: 'Deactivate',
    guiDeactivateServerFailed: 'Local license cleared, but the server did not confirm deactivation; if it still shows as activated after a reload, check the API endpoint and retry',
    guiDevice: 'Machine id',
    guiDone: 'Done in {ms} ms',
    guiFailed: 'Failed: {msg}',
    guiCoreBlocked: 'Core module not loaded (HTTP {code}): the server does not recognise this device. Deactivate and activate again; if it still fails, check the API endpoint',
    guiCoreUnreachable: 'Core module not loaded (HTTP {code}): the obfuscation core could not be fetched. Check your network and the API endpoint',
    guiNoInput: 'Enter some code first',
    guiBlocked: 'Your license does not allow: {msg}',
    guiSize: 'Size {in} → {out} bytes ({ratio}%)',
    guiFilesN: '{n} files',
    guiSelectFile: 'Select a file on the left to see its result',
    guiPickFiles: 'Loaded {n} file(s)',
    guiHtmlSummary: 'Inline scripts: obfuscated {n} block(s) (skipped src {ext}, type {type}, empty {empty}{failedPart})',
    guiReset: 'Reset to defaults',
    guiPresetHint: 'A preset supplies defaults; editing an option below pins it explicitly, and switching preset clears those pins.',
    guiPresetCeiling: 'ceiling: {preset}',
    guiLimitsFile: 'single file <= {file}',
    guiLimitsFiles: '<= {files} files per run',
    guiLimitsRuns: '<= {runs} runs per day',
    guiLimitsNoRuns: 'unlimited runs per day',
    guiLimitsTotal: '{total} runs in total',
    guiLimitsContact: 'contact the author for quota',
    guiTrialHint: 'Not activated: {limits}. Activate a license key for the full entitlements and quotas of your plan.',
    guiThemeDark: 'Dark',
    guiThemeLight: 'Light',
    guiStats: 'Obfuscation stats',
    guiStatsPass: 'pass',
    guiStatsResult: 'result',
    guiOverLimit: 'file is {size} bytes, over the {limit}-byte single-file limit of the current license',
    guiCopiedHint: 'Result copied to clipboard',
    guiDownloadHint: 'Result downloaded',
    guiClipboardFail: 'Copy failed; select the output manually',
    guiShortcut: 'Shortcut',
    guiShortcutRun: 'run',
    guiApiChecking: 'Checking API…',
    guiApiOnline: 'API available',
    guiApiOffline: 'License service unreachable',
    guiApiOnlineHint: 'License service reachable (activation and policy come from here); obfuscation always runs in your browser',
    guiApiOfflineHint: 'No same-origin license service detected; if this site requires a key, it must be reachable',
    guiServerAttestedHint: 'License verified server-side: obfuscation runs in your browser and code never leaves this machine, so those runs are not counted against the server-side daily quota',
    guiAriaPresets: 'Strength preset',
    guiAriaLang: 'Interface language',
    guiAriaMode: 'Input type',
    guiAriaTheme: 'Toggle light/dark theme',
    guiAriaOptions: 'Show or hide the options panel',
    guiAriaOutput: 'Obfuscated output',
  },
};

const LANGS = Object.keys(STRINGS);

let current = 'zh';
const envLang = platform.env('JSLABYRINTH_LANG');
if (envLang && STRINGS[envLang]) current = envLang;

function setLang(code) {
  if (!STRINGS[code]) {
    throw new Error('unknown language "' + code + '" (available: ' + LANGS.join(', ') + ')');
  }
  current = code;
}

function getLang() {
  return current;
}

function t(key, params) {
  const table = STRINGS[current] || STRINGS.zh;
  let s = table[key];
  if (s === undefined) s = STRINGS.zh[key];
  if (s === undefined) return key;
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m));
}

export default { setLang, getLang, t, LANGS };
