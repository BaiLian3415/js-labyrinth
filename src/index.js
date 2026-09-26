/** 跨环境公共入口（Node / 浏览器 / Vercel 函数）。Node 专有模块不从此导出。 */
import obfuscateMod from './obfuscate.js';
import htmlMod from './html.js';
import planMod from './plan.js';
import meta from './options-meta.js';
import gate from './options-gate.js';
import i18n from './i18n.js';
import platform from './platform.js';
import licenseWeb from './license-web.js';
import licenseCore from './license-core.js';
import codec from './license-codec.js';
import pipeline from './pipeline.js';
import zip from './utils/zip.js';
import hash from './utils/hash.js';
import encode from './utils/encode.js';
import rand from './utils/rand.js';
import { VERSION } from './version.js';

const { obfuscate, resolveOptions, DEFAULTS, PRESETS, PRESET_NAMES } = obfuscateMod;
const { processHtml, obfuscateDocument } = htmlMod;
const { runJob, looksLikeHtml } = pipeline;
const { makeZip } = zip;

const runtimeInfo = {
  runtime: platform.runtime,
  isNode: platform.isNode,
  isBrowser: platform.isBrowser,
  version: VERSION,
};

export {
  // 核心
  obfuscate,
  resolveOptions,
  DEFAULTS,
  PRESETS,
  PRESET_NAMES,
  // HTML
  processHtml,
  obfuscateDocument,
  // 一次任务的完整流程（闸门 + 限额 + 混淆 + 记账）
  runJob,
  looksLikeHtml,
  // 套餐与闸门
  planMod as plan,
  gate as optionsGate,
  meta as optionsMeta,
  // i18n
  i18n,
  // 运行环境
  platform,
  runtimeInfo,
  // 授权
  licenseWeb,
  licenseCore,
  codec as licenseCodec,
  // 工具
  makeZip,
  hash,
  encode,
  rand,
  VERSION,
};

export default {
  obfuscate,
  resolveOptions,
  DEFAULTS,
  PRESETS,
  PRESET_NAMES,
  processHtml,
  obfuscateDocument,
  runJob,
  looksLikeHtml,
  plan: planMod,
  optionsGate: gate,
  optionsMeta: meta,
  i18n,
  platform,
  runtimeInfo,
  licenseWeb,
  licenseCore,
  licenseCodec: codec,
  makeZip,
  hash,
  encode,
  rand,
  VERSION,
};
