#!/usr/bin/env node
/**
 * 网页版构建：把界面与核心汇总到 dist/，供 Cloudflare Pages / Workers 静态资源发布。
 *
 *   node tools/build/build-web.js [--out dist]
 *
 * 不需要打包器：界面用的是原生 ESM（<script type="module">)，浏览器按 import 关系
 * 逐个取 src/ 下的模块，因此这里只做文件复制，产物与源码逐字节一致，也便于直接看
 * 线上跑的到底是哪份代码。代价是首次加载会发几十个模块请求——静态托管走 CDN，
 * 这部分开销可以接受，换来的是零构建工具链、零依赖。
 *
 * 为了不让这几十个请求串成一条长瀑布，构建期会从入口扫一遍模块图，把清单作为
 * modulepreload 注入首页（见 injectIndex）。这一步只改 dist/index.html，src/** 与
 * 界面脚本仍是逐字节复制过来的。
 *
 * 产物结构：
 *   dist/index.html  dist/app.js  dist/styles.css     界面
 *   dist/src/**                                       核心（与仓库里同一份源码）
 *   dist/404.html                                     自定义 404（not_found_handling 用）
 *
 * 不含 tools/、functions/、license.lic 等：发卡工具与本地许可证不该出现在公开站点上。
 * functions/ 由 Pages 从项目根目录读取，不需要进 dist。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../../src/version.js';
import { isGatedModuleId } from '../../worker/gate-policy.js';
import * as enc from './enc-loader.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 参与构建的核心目录。 */
const SRC_DIRS = ['src'];

/** 界面文件，web/ 下逐个复制。 */
const PUBLIC_DIR = 'web';

/** 同步等待 ms 毫秒。Node 没有同步 sleep，用 Atomics.wait 起一个不占 CPU 的等待。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 递归删除目录。
 *
 * Windows 上删"刚生成的产物目录"会间歇撞 EPERM，而且**不是瞬时**的：本项目就在
 * 同步盘目录下，实测锁能持续好几秒，rmSync 自带的重试（10 次 × 500 ms）也被耗光
 * 仍会失败，且报错路径是目录本身而不是某个子文件——说明有进程正持有这个目录的句柄
 * （同步盘客户端、杀软、搜索索引都会这么干）。
 *
 * 所以这里再加一层更长的退避重试；仍删不掉时**退化为清空内容**并打印警告：目录本身
 * 留着不影响构建（随后每个文件都会被重写），比直接让构建失败要好。
 */
function rmrf(p) {
  if (!fs.existsSync(p)) return;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      return;
    } catch (e) {
      const transient = e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'ENOTEMPTY');
      if (!transient) throw e;
      if (attempt === 5) { emptyDir(p, e); return; }
      sleepSync(1000 * (attempt + 1));
    }
  }
}

/** 目录删不掉的兜底：逐个清空子项；实在删不掉的留在原地并点名，不静默吞掉。 */
function emptyDir(dir, cause) {
  const left = [];
  for (const name of fs.readdirSync(dir)) {
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (e) {
      left.push(name);
    }
  }
  if (left.length) {
    console.warn('警告：无法删除的旧产物 ' + left.join(', ')
      + '（' + (cause && cause.code) + '）。构建会覆盖同名文件，但上面这些若已不再产出，'
      + '会成为残留，请人工确认。');
  }
}

/**
 * 删掉复制后剩下的空目录，返回删除个数。
 *
 * copyDir 先建目录再按过滤器筛文件，所以某个目录里的文件全被过滤器挡掉时会留下
 * 一个空壳。空目录不会真的上传，但会让"产物里有什么"变模糊，顺手清掉。
 */
function pruneEmptyDirs(dir) {
  let removed = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    removed += pruneEmptyDirs(p);
    if (fs.readdirSync(p).length === 0) {
      fs.rmdirSync(p);
      removed++;
    }
  }
  return removed;
}

/**
 * 从入口出发扫出整个模块图（只认静态 import 说明符）。
 *
 * 界面是原生 ESM，浏览器按 import 关系逐个取模块，几十个请求串成一条链，
 * 链路深度就是首屏延迟的乘数。浏览器解析到 HTML 里的 modulepreload 才会提前
 * 并行拉取，而原生 ESM 没有清单可依赖，所以这里在构建期把图扫出来写进
 * <head>。只做字符串匹配、只跟相对路径，够用且不需要解析器。
 *
 * @param {string} entryAbs 入口文件绝对路径
 * @returns {string[]} 除入口外的模块，路径为站点绝对形式（/src/...）
 */
function collectModules(entryAbs, outDirAbs) {
  const seen = new Set();
  const queue = [entryAbs];
  const out = [];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
    const re = /(?:^|[\s;{(])(?:import|export)\s+(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const spec = m[1];
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
      const dep = path.resolve(path.dirname(file), spec);
      if (!dep.startsWith(outDirAbs) || !fs.existsSync(dep)) continue;
      queue.push(dep);
      const rel = '/' + path.relative(outDirAbs, dep).split(path.sep).join('/');
      if (!out.includes(rel)) out.push(rel);
    }
  }
  return out;
}

/**
 * 把 modulepreload 清单与版本号注入产物首页。
 *
 * 源码里的 web/index.html 留着 <!--JSLB_PRELOAD--> 占位注释，直接预览时
 * 它是一句无害的注释；构建时替换成真实清单。
 */
function injectIndex(outDir) {
  const indexPath = path.join(outDir, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');
  const mods = collectModules(path.join(outDir, 'app.js'), outDir)
    .filter((p) => p !== '/app.js');
  const links = mods.map((p) => '<link rel="modulepreload" href="' + p + '">').join('\n');
  const stamp = '<meta name="jslabyrinth-build" content="v' + VERSION
    + ' ' + new Date().toISOString().slice(0, 10) + '">';
  html = html.replace('<!--JSLB_PRELOAD-->', links ? links + '\n' + stamp : stamp);
  fs.writeFileSync(indexPath, html);
  return mods.length;
}

/**
 * 404 页。走 Cloudflare 的 not_found_handling = "404-page" 时，访问者看到的是
 * 这一页，所以它得跟界面同一套配色，并且认深浅色偏好。
 */
function write404(outDir) {
  fs.writeFileSync(path.join(outDir, '404.html'), `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>404 — JsLabyrinth</title>
<link rel="stylesheet" href="/styles.css">
<style>
  body { display: flex; align-items: center; justify-content: center; }
  .box { text-align: center; padding: 32px 40px; background: var(--bg-pane);
    border: 1px solid var(--line); border-radius: var(--radius); }
  .box h1 { margin: 0 0 6px; font-size: 40px; }
  .box p { margin: 0 0 16px; color: var(--fg-dim); }
  .box a { color: var(--accent); text-decoration: none; }
  .box a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="box">
  <h1>404</h1>
  <p>这里没有你要的页面。</p>
  <a href="/">回到 JsLabyrinth</a>
</div>
</body>
</html>
`);
}

/** 递归复制目录，跳过隐藏文件与 node_modules。 */
function copyDir(from, to, filter) {
  fs.mkdirSync(to, { recursive: true });
  let count = 0;
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) {
      count += copyDir(src, dst, filter);
    } else {
      if (filter && !filter(src)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      count++;
    }
  }
  return count;
}

/** 递归列出目录下的 .js 文件，返回相对 from 的路径。 */
function listJs(dir, base) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const rel = base ? base + '/' + e.name : e.name;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJs(abs, rel));
    else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

/**
 * 自混淆用的混淆选项。
 *
 * **按实测挑 pass，不按直觉**。逐项实测（`tools/build/bench-selfobf.js` 可复现，
 * 同一输入、同一 seed，混淆后的核心 vs 原核心，11 次取中位数）：
 *
 *   对象键编码 objectKeyEncoding   21.37×  ← 每次属性访问变成分段解密取键 + 计算下标
 *   不透明谓词 opaquePredicates     2.99×  ← **单项第二贵**，旧文档漏了这条
 *   字符串池 stringArray            2.59×  ← 全量；阈值降到 0.10 仍要 1.65×
 *   数字混淆 numberObfuscation      1.11×
 *   条件混淆 conditionObfuscation   1.04×
 *   控制流平坦化 controlFlow        1.02×
 *   逻辑表达式 logicalExpressions   1.02×
 *   死代码注入 deadCodeInjection    1.02×
 *
 * 注意基线（关掉全部昂贵项）自身就是 **0.99×**——混淆后的核心并不比原核心慢，
 * 旧文档里"3.6× / 1.63×"两个数字都已过时，且把昂贵项指成了 objectKey/stringArray，
 * 漏掉了真正第二贵的 opaquePredicates。
 *
 * 于是本配置 = **免费的部分全开 + 昂贵项全关**：控制流 / 死码 / 逻辑 / 条件 /
 * 数字混淆五项，实测综合 **1.31×**，在"运行期不超过 1.5×"的预算内还剩 0.19× 余量。
 * 字符串池哪怕压到阈值 0.10 也要 1.65×，装不进预算，所以字符串仍是明文——
 * 这一层靠下面的模块体加密（见 tools/build/enc-loader.js）来补。
 *
 * 用 JSLB_BUILD_OBF_PRESET=low 可退回全量 low（70.6×，仅用于对比）。
 */
function selfObfOptions(preset) {
  if (preset !== 'low') {
    // 显式指定了预设（如 JSLB_BUILD_OBF_PRESET=medium）就完全按预设走
    return { preset };
  }
  return {
    preset: 'low',
    // 实测超预算，逐项关掉。改动这几行前先跑 tools/build/bench-selfobf.js
    objectKeyEncoding: false,   // 21.37×
    opaquePredicates: false,    //  2.99×
    stringArray: false,         //  2.59×（阈值 0.10 也要 1.65×）
    // 其余 low 默认项保持开启：控制流平坦化 / 死代码 / 逻辑表达式 / 条件混淆
    // 都是 1.0~1.04× 量级。low 预设里数字混淆默认关，这里显式打开。
    numberObfuscation: true,
    numberObfuscationThreshold: 0.5,
  };
}

/**
 * 用项目自己的混淆器把 src/** 跑一遍再写进 dist/。
 *
 * 为什么值得做：dist/ 里原本就是逐字节的完整源码，顺着首页的 modulepreload 清单
 * 可以一次性把 51 个模块全拉走。**鉴权下发（JSLB_GATE_CORE）已经挡住了匿名请求**，
 * 这一层是给"已激活用户"再抬一道逆向门槛——混淆后的代码仍然是合法 ESM，import
 * 绑定与文件路径原样保留，所以逐文件混淆不会破坏跨文件引用。
 *
 * 关键约束与代价：
 *   - **必须逐文件混淆**，不能合并成 bundle：项目是原生 ESM，界面按文件路径 import。
 *   - **产物必须仍是合法 ESM**：functionWrapper 检测到 import/export 会自行跳过
 *     （见 src/passes/functionWrapper.js），否则包进 IIFE 会把 export 吞掉。
 *   - **种子固定**，保证同一份源码每次构建得到相同产物，线上版本可比对。
 *   - 体积约 1.4 倍，运行期约 3.6 倍（见 selfObfOptions 的实测表）。
 *   - 调试线上问题时用 `--plain` 跳过这一步，产物与源码逐字节一致。
 *
 * 顺带一提：这一步本身就是混淆器最狠的自测——拿它混淆自己，产物一加载就会暴露
 * 任何语义破坏（2026-09-20 的 BigInt/谓词缺陷就是这么发现的）。
 *
 * @param {string} outDir 产物根目录
 * @param {object} opts 选项
 * @returns {Promise<{files:number, inBytes:number, outBytes:number, failed:string[], ms:number}>} 统计
 */
async function writeObfuscatedSrc(outDir, opts) {
  // 动态 import：只有开启自混淆时才加载核心，--plain 构建不必付这个代价
  const { default: core } = await import('../../src/index.js');
  const ent = { plan: 'business', preset: 'max', gates: {}, limits: {} };
  const options = selfObfOptions(opts.preset);
  const stats = {
    files: 0, inBytes: 0, outBytes: 0, failed: [], ms: 0,
  };
  const t0 = Date.now();
  for (const rel of listJs(path.join(ROOT, 'src'), '')) {
    const code = fs.readFileSync(path.join(ROOT, 'src', rel), 'utf8');
    stats.inBytes += code.length;
    const r = await core.runJob({
      code, options: Object.assign({ seed: opts.seed }, options), type: 'js', ent,
    });
    if (!r.ok) {
      // 不静默降级：产物里混一半明文一半混淆，最难排查
      stats.failed.push(rel + ': ' + String(r.message).split('\n')[0]);
      continue;
    }
    stats.outBytes += r.code.length;
    const dst = path.join(outDir, 'src', rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, r.code);
    stats.files++;
  }
  stats.ms = Date.now() - t0;
  return stats;
}

/**
 * 模块体加密：把上一步写进 dist/src 的受保护模块换成「明文 stub + 一个密文载荷」。
 *
 * 必须在自混淆之后跑——加密的输入就是自混淆的产物，两层叠加（先混淆、再加密）。
 * 顺序反了没有意义：加密后自混淆器看不到明文，没法改写 AST。
 *
 * 受保护集合取自 `worker/gate-policy.js`，与 Worker 侧的匿名 403 判定是**同一份名单**。
 * 为什么要共用：这两个集合必须严格相等，偏大偏小都不报错、只在线上表现为怪现象
 * （见 gate-policy.js 头注释）。这里的失败模式是致命的：若某个受保护模块没被加密却
 * 被 403，浏览器取不到它；若被加密却没被 403，等于把密文与引导层一起公开。
 *
 * 公开模块（激活表单的静态依赖）保持明文直出——未激活界面必须能渲染出激活表单。
 *
 * @param {string} outDir 产物根目录
 * @param {{seed:number, keyText?:string}} opts
 * @returns {{stubs:number, packBytes:number, loaderBytes:number, plain:number}}
 */
function writeEncryptedCore(outDir, opts) {
  const LOADER = '__jslb_core.js';
  const PACK = '__core.pack';
  const srcOut = path.join(outDir, 'src');
  const loaderAbs = path.join(srcOut, LOADER);

  const modules = {};
  let stubs = 0;
  let plainCount = 0;

  for (const rel of listJs(path.join(ROOT, 'src'))) {
    if (!isGatedModuleId(rel)) {
      plainCount++;
      continue;
    }
    const obfPath = path.join(srcOut, rel);
    if (!fs.existsSync(obfPath)) {
      throw new Error('受保护模块在 dist 里不存在，无法加密: ' + rel);
    }

    // 导出名从**原始**源码枚举：自混淆产物里 export 语句的形态可能被生成器改写，
    // 原始源码是最可靠的依据。枚举不全会让浏览器 import 到 undefined，且只在走到
    // 那条 import 时才炸，所以 collectExportNames 对 export * 是直接抛错的。
    const original = fs.readFileSync(path.join(ROOT, 'src', rel), 'utf8');
    const shape = {
      default: enc.hasDefaultExport(original),
      names: enc.collectExportNames(original),
    };

    modules[rel] = fs.readFileSync(obfPath, 'utf8');

    // stub → 引导层的相对说明符。ESM 说明符必须是 POSIX 分隔符，且**必须**以 ./
    // 或 ../ 开头：裸的名字会被当成包名去 node_modules 找。
    let toLoader = path.relative(path.dirname(obfPath), loaderAbs).split(path.sep).join('/');
    if (!toLoader.startsWith('.')) toLoader = './' + toLoader;

    fs.writeFileSync(obfPath, enc.renderStub(rel, toLoader, shape));
    stubs++;
  }

  const keyWords = opts.keyText
    ? enc.keyWordsFromText(opts.keyText)
    : enc.keyWordsFromSeed(opts.seed);

  const packed = enc.packModules(modules, keyWords);

  // 构建期往返自检：解不回来就说明密钥或格式有问题，宁可构建失败也不发一份
  // 浏览器一加载就抛的产物。
  const back = enc.unpackModules(packed, keyWords);
  if (Object.keys(back.modules).length !== stubs) {
    throw new Error('载荷往返自检失败：模块数 ' + Object.keys(back.modules).length + ' ≠ ' + stubs);
  }

  fs.writeFileSync(path.join(srcOut, PACK), packed);
  const loader = enc.renderLoader({ keyWords, packRel: './' + PACK, moduleCount: stubs });
  fs.writeFileSync(loaderAbs, loader);

  return { stubs, packBytes: packed.length, loaderBytes: Buffer.byteLength(loader), plain: plainCount };
}

function main(argv) {
  const outIdx = argv.indexOf('--out');
  const outName = outIdx >= 0 && argv[outIdx + 1] ? argv[outIdx + 1] : 'dist';
  const outDir = path.resolve(ROOT, outName);

  if (path.relative(ROOT, outDir).startsWith('..')) {
    console.error('输出目录必须在项目内: ' + outName);
    process.exit(1);
  }

  rmrf(outDir);
  fs.mkdirSync(outDir, { recursive: true });

  let files = 0;
  files += copyDir(path.join(ROOT, PUBLIC_DIR), outDir, (p) => !p.endsWith('.map'));

  // 核心默认自混淆后写入；--plain 或 JSLB_BUILD_PLAIN=1 时退回逐字节复制（调试用）
  const plain = argv.includes('--plain') || process.env.JSLB_BUILD_PLAIN === '1';
  const obfPreset = process.env.JSLB_BUILD_OBF_PRESET || 'low';
  const obfSeed = Number(process.env.JSLB_BUILD_OBF_SEED || 20260920);
  return (async () => {
    let obf = null;
    let encl = null;
    if (plain) {
      for (const d of SRC_DIRS) {
        files += copyDir(path.join(ROOT, d), path.join(outDir, d), (p) => p.endsWith('.js'));
      }
    } else {
      obf = await writeObfuscatedSrc(outDir, { preset: obfPreset, seed: obfSeed });
      if (obf.failed.length) {
        console.error('自混淆失败 ' + obf.failed.length + ' 个文件，构建中止：');
        for (const f of obf.failed) console.error('  ' + f);
        console.error('排查用 --plain 构建未混淆版本。');
        process.exit(1);
      }
      files += obf.files;

      // 第二层：模块体加密。受保护模块在 dist 里不再有源码文本。
      // JSLB_BUILD_ENC_KEY 可换成部署方自己的密钥（此时产物不再与默认构建逐字节相同）。
      encl = writeEncryptedCore(outDir, { seed: obfSeed, keyText: process.env.JSLB_BUILD_ENC_KEY });
      files += 2; // 引导层 __jslb_core.js + 载荷 __core.pack
    }
    pruneEmptyDirs(outDir);

    // 静态页与 API 同源时不需要 CORS；这里只补一个 Pages 用的 404 兜底
    write404(outDir);

    const mods = injectIndex(outDir);

    const bytes = dirSize(outDir);
    console.log('已生成 ' + path.relative(ROOT, outDir) + '/：' + files + ' 个文件，' + (bytes / 1024).toFixed(0) + ' KB，v' + VERSION);
    if (obf) {
      console.log('  核心已自混淆（预设 ' + obfPreset + ' + 运行期优化档，种子 ' + obfSeed + '）：'
        + obf.files + ' 个文件，' + (obf.inBytes / 1024).toFixed(0) + ' KB -> '
        + (obf.outBytes / 1024).toFixed(0) + ' KB（' + (obf.outBytes / obf.inBytes).toFixed(1)
        + ' 倍），耗时 ' + obf.ms + ' ms');
    } else {
      console.log('  核心未混淆（--plain）：与源码逐字节一致，仅供调试');
    }
    if (encl) {
      console.log('  核心已模块体加密：' + encl.stubs + ' 个受保护模块 → 明文 stub + '
        + (encl.packBytes / 1024).toFixed(0) + ' KB 载荷，引导层 '
        + (encl.loaderBytes / 1024).toFixed(1) + ' KB；'
        + encl.plain + ' 个公开模块（激活表单依赖）保持明文');
    }
    console.log('  首页已注入 ' + mods + ' 条 modulepreload（原生 ESM 的请求瀑布在构建期拉平）');
    console.log('  Pages:  npx wrangler pages deploy ' + outName);
    console.log('  Worker: npx wrangler deploy');
    console.log('');
    console.log('  注意：dist/ 里含 src/license-secret.js 的卡密密钥（对称，随静态资源公开）。');
    console.log('  对称体系里拿到源码就能造卡——真正的强制在服务端：逐请求校验、KV 赎回登记');
    console.log('  （一卡一次）与 JSLB_GATE_CORE 门控，见 license-codec.js 的头注释。');
    console.log('  签发密钥：环境变量 JSLB_CODE_KEY 或 .jslb-code-key（gitignore）。');
    console.log('  发卡（缺密钥会明确报错）：');
    console.log('    JSLB_CODE_KEY=<base64 密钥> node tools/issue/keygen.js --plan plus --days 365');
  })();
}

function dirSize(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return n;
}

// main 现在是 async（自混淆要 await runJob），未捕获的拒绝必须显式报错退出，
// 否则构建失败会被静默吞掉，dist/ 留下半份产物。
main(process.argv.slice(2)).catch((e) => {
  console.error("构建失败: " + ((e && e.message) || String(e)));
  process.exit(1);
});
