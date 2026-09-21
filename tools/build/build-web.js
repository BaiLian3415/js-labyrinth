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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 参与构建的核心目录。 */
const SRC_DIRS = ['src'];

/** 界面文件，web/ 下逐个复制。 */
const PUBLIC_DIR = 'web';

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
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
 * **不是 low 预设**——直接套 low 会让混淆后的核心慢 70 倍，浏览器里一个 20 KB
 * 的文件要等 8 秒。逐项实测（同一输入，混淆后的核心跑 medium 档，与原核心比）：
 *
 *   low 全量                                70.6×
 *   关 objectKeyEncoding                    27.9×   ← 单项最大，把每次属性访问变成
 *                                                    分段解密取键 + 计算下标
 *   再关 stringArray                        10.8×   ← 每次取字符串都要解密校验
 *   再关 谓词/死码/逻辑/条件                  3.6×   ← 本配置
 *
 * 代价说清楚：本配置**保留**重命名（名字全不可读）与 RT 内核（原生 API 名不出现），
 * 但字符串字面量、控制流结构保持明文。想更硬就往上加，代价见上表。
 * 用 JSLB_BUILD_OBF_PRESET=low 可退回全量 low（慢 70 倍，仅用于对比）。
 */
function selfObfOptions(preset) {
  if (preset !== 'low') {
    // 显式指定了预设（如 JSLB_BUILD_OBF_PRESET=medium）就完全按预设走
    return { preset };
  }
  return {
    preset: 'low',
    objectKeyEncoding: false,
    stringArray: false,
    controlFlowFlattening: false,
    opaquePredicates: false,
    deadCodeInjection: false,
    logicalExpressions: false,
    conditionObfuscation: false,
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
    console.log('  首页已注入 ' + mods + ' 条 modulepreload（原生 ESM 的请求瀑布在构建期拉平）');
    console.log('  Pages:  npx wrangler pages deploy ' + outName);
    console.log('  Worker: npx wrangler deploy');
    console.log('');
    console.log('  注意：dist/ 里含 src/license-secret.js，但里面**只有公钥**，随静态资源');
    console.log('  公开不影响安全——卡密是 Ed25519 签名的，没有私钥就签不出新卡。');
    console.log('  签发私钥只在签发方：环境变量 JSLB_SIGNING_KEY 或 .jslb-signing-key（gitignore）。');
    console.log('  发卡（缺私钥会明确报错）：');
    console.log('    JSLB_SIGNING_KEY=<base64 种子> node tools/issue/keygen.js --plan pro --days 365');
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
