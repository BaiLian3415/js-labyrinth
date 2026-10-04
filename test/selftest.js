#!/usr/bin/env node
/**
 * 自测入口。直接跑：
 *
 *   npm test            （即 node test/selftest.js）
 *   npm test -- --verbose
 *   JSLB_SKIP_LIVE=1 npm test       仅跑离线段，完全不打网络
 *   npm test -- core                只跑名字里带 core 的那一个文件
 *
 * 用例按主题拆在同目录的多个文件里，本文件只负责按顺序加载并汇总：
 *
 *   core-obfuscate   核心混淆、HTML 内联脚本、套餐闸门
 *   license-codec    卡密与令牌的编解码往返、篡改检测
 *   license-web      端到端激活、裸键串扰、自锚定、额度包、赎回、机器码
 *   issue-cli        签发工具命令行
 *   web-pipeline     runJob 浏览器侧链路、服务端路由、云存储 RESP
 *   zip              ZIP 打包结构
 *   passes-basic     逻辑表达式、数值常量、多态可复现、控制流扁平化
 *   chinese-names    中文命名：字典、命名池、四档预设、转义与套餐闸门
 *   passes-defense   自防御、密钥耦合、多时钟源、ESM 绑定、BigInt
 *   esm-fold         ESM 模块折叠：形态折叠、绑定改写、活再导出、顶层 await、max 可复现
 *   guide-fnv        引导层 FNV 多种等价写法：构建期与运行期逐位相同
 *   domain-redirect  域名锁定重定向：跳转位置、合法地址、危险 scheme 拒绝
 *   force-strings    强制入池字符串：绕过抽样阈值、优先级、非法正则
 *   source-loc       解析器位置追踪：语句级 start/end/loc，默认关闭
 *   string-wrappers  字符串池调用点包装链：层数、链式占比、任意层进入
 *   handler-poly     引导器原语算法多态：变体族、两侧一致、指纹分散
 *   vm               VM 保护、动态操作码、分发表密文化、寄存器模型
 *   anti-analysis    Anti-CDP 与域名锁定
 *   minify           AST 简化、DCE、命名策略、属性名重命名、杂项
 *   shell-wasm       JSFuck 壳形态与 WASM 档位
 *   vmp              VMP 覆盖率 / 深度 / stats 口径
 *   live-verify      线上验收（打已部署站点）
 *
 * 拆分的理由：一个文件近 4000 行时，改一行要找半天，且任何一处语法错要等整跑
 * 完才发现。各文件之间只共享 _harness.js 的断言与执行工具，彼此无状态依赖，
 * 因此也可以单独 `node test/<file>.js` 跑那一个文件。
 *
 * 覆盖范围与拆分前一致；线上验收是唯一打网络的段，需要无网环境时设
 * JSLB_SKIP_LIVE=1 跳过。
 *
 * 不写仓库内文件（临时目录用完即删）。
 */
import { cleanTmp, report } from './_harness.js';

// import 顺序即执行顺序，与拆分前一致。live-verify 放最后：它要打网络，
// 前面全挂了也还能看到它的结果。
const FILES = [
  'core-obfuscate.js',
  'license-codec.js',
  'license-web.js',
  'issue-cli.js',
  'web-pipeline.js',
  'zip.js',
  'passes-basic.js',
  'passes-defense.js',
  'esm-fold.js',
  'guide-fnv.js',
  'domain-redirect.js',
  'force-strings.js',
  'source-loc.js',
  'string-wrappers.js',
  'handler-poly.js',
  'chinese-names.js',
  'vm.js',
  'anti-analysis.js',
  'minify.js',
  'shell-wasm.js',
  'vmp.js',
  'live-verify.js',
];

const filter = process.argv.slice(2).find((a) => !a.startsWith('-'));
const picked = filter ? FILES.filter((f) => f.includes(filter)) : FILES;
if (!picked.length) {
  console.error('没有匹配到用例文件：' + filter);
  console.error('可选：\n  ' + FILES.join('\n  '));
  process.exit(2);
}

// 每个文件顶层就会跑自己的断言，这里只负责 import。
for (const f of picked) await import('./' + f);

cleanTmp();

const failed = report();
if (failed) process.exit(1);
