/**
 * 目录批量混淆：递归遍历输入目录，逐文件混淆 JS 脚本，输出目录镜像源结构。
 * 每个文件单独调用一次 obfuscate()，seed 固定时逐文件可复现；没有 seed 时各文件
 * 自己取 crypto 熵源，同一目录两次构建的产物不会相同。
 */
import fs from 'node:fs';
import path from 'node:path';
import obfuscateMod from '../src/obfuscate.js';
import i18n from '../src/i18n.js';
import platform from '../src/platform.js';

const { obfuscate } = obfuscateMod;
const { t } = i18n;

const JS_EXTS = new Set(['.js', '.mjs', '.cjs']);
const ALWAYS_SKIP = new Set(['node_modules', '.git']);

/**
 * @param {string} inputDir 输入目录，递归遍历
 * @param {string} outputDir 输出目录，自动创建并镜像源结构
 * @param {object} options 混淆选项，透传 obfuscate()，另有两个批量选项：
 *   dirCopyOthers 为真时非 JS 文件原样复制，默认跳过；
 *   dirSkip 追加要跳过的目录名，逗号分隔字符串或字符串数组。
 * @param {{display:string, limits:object, need:string}|null} [ent] 套餐权益。
 *   给了就按套餐限额逐文件判定：超出单文件字节数的文件与超出单任务文件数的
 *   后续文件都记为该文件的失败并继续，批量处理不被限额外的一两个文件打断，
 *   失败计数交给调用方决定退出码。limits 里 0 表示不限。
 * @returns {{ok:number, failed:number, copied:number, skipped:number, totalIn:number, totalOut:number, results:Array<{file:string, status:string, inSize?:number, outSize?:number, error?:string}>}}
 *   status 取值 ok | error | copied | skipped | skipped-dir | skipped-output
 */
function obfuscateDirectory(inputDir, outputDir, options, ent) {
  const inRoot = path.resolve(inputDir);
  const outRoot = path.resolve(outputDir);
  // 输出目录和输入目录相同会把源文件覆盖掉
  if (inRoot === outRoot) {
    throw new Error(t('dirSameAsInput'));
  }
  const outRootPfx = outRoot.endsWith(path.sep) ? outRoot : outRoot + path.sep;

  let skip = ALWAYS_SKIP;
  const extra = Array.isArray(options.dirSkip)
    ? options.dirSkip
    : String(options.dirSkip || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (extra.length) skip = new Set([...ALWAYS_SKIP, ...extra]);

  const copyOthers = !!options.dirCopyOthers;
  // 套餐文案在外面取好：walk 的循环变量也叫 ent，进去后这个名字被目录项遮住
  const lim = ent && ent.limits ? ent.limits : null;
  const planLabel = (ent && ent.display) || '';
  const need = (ent && ent.need) || '';
  const results = [];
  let ok = 0;
  let failed = 0;
  let copied = 0;
  let skipped = 0;
  let totalIn = 0;
  let totalOut = 0;
  /** 本次任务已处理的 JS 文件数，用于单任务文件数限额。 */
  let jsFiles = 0;

  const report = (file, status, extra2) =>
    results.push(Object.assign({ file, status }, extra2 || {}));

  function walk(dir, rel) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      failed++;
      report(rel, 'error', { error: t('dirReadDirError', { msg: e.message }) });
      return;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const relPath = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isSymbolicLink()) {
        // 不跟随符号链接，避免目录循环或走到源树之外
        skipped++;
        report(relPath, 'skipped');
        continue;
      }
      if (ent.isDirectory()) {
        const resolved = path.resolve(abs);
        // 隐藏目录以及 node_modules/.git 默认跳过，dirSkip 可以再追加
        if (ent.name.startsWith('.') || skip.has(ent.name)) {
          skipped++;
          report(relPath + '/', 'skipped-dir');
          continue;
        }
        if (resolved === outRoot || (resolved + path.sep).startsWith(outRootPfx)) {
          // 输出目录在输入目录内部，跳过这棵子树，否则会把产物再混淆一遍
          skipped++;
          report(relPath + '/', 'skipped-output');
          continue;
        }
        walk(abs, relPath);
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (!JS_EXTS.has(ext)) {
        if (copyOthers) {
          try {
            const dst = path.join(outRoot, relPath);
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.copyFileSync(abs, dst);
            copied++;
            report(relPath, 'copied');
          } catch (e) {
            failed++;
            report(relPath, 'error', { error: t('dirCopyError', { msg: e.message }) });
          }
        } else {
          skipped++;
          report(relPath, 'skipped');
        }
        continue;
      }
      // JS 脚本：混淆后按相对路径写入输出目录
      let code;
      try {
        code = fs.readFileSync(abs, 'utf8');
      } catch (e) {
        failed++;
        report(relPath, 'error', { error: t('dirReadFileError', { msg: e.message }) });
        continue;
      }
      // 套餐限额。超限的文件不算失败品之外的东西：它没被处理，也不计入产出字节
      if (lim) {
        jsFiles++;
        if (lim.maxFilesPerRun > 0 && jsFiles > lim.maxFilesPerRun) {
          failed++;
          report(relPath, 'error', {
            error: t('planTooManyFiles', { max: lim.maxFilesPerRun, plan: planLabel, need }),
          });
          continue;
        }
        const size = platform.byteLength(code);
        if (lim.maxFileBytes > 0 && size > lim.maxFileBytes) {
          failed++;
          report(relPath, 'error', {
            error: t('planFileTooBig', { size, limit: lim.maxFileBytes, plan: planLabel, need }),
          });
          continue;
        }
      }
      try {
        const r = obfuscate(code, options);
        const dst = path.join(outRoot, relPath);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, r.code);
        ok++;
        totalIn += r.originalSize;
        totalOut += r.obfuscatedSize;
        report(relPath, 'ok', { inSize: r.originalSize, outSize: r.obfuscatedSize });
      } catch (e) {
        // 单个文件失败只记录后继续，批量处理不该被一个文件打断；退出码由调用方按 failed 决定
        failed++;
        report(relPath, 'error', { error: (e && e.message) || String(e) });
      }
    }
  }

  walk(inRoot, '');
  return { ok, failed, copied, skipped, totalIn, totalOut, results };
}

const api = { obfuscateDirectory };

export default api;
export { obfuscateDirectory };