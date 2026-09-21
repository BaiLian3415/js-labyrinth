/** 单次混淆任务：授权闸门 → 限额 → 混淆 → 记账。三端共用。 */
import obfuscateMod from './obfuscate.js';
import htmlMod from './html.js';
import platform from './platform.js';
import gate from './options-gate.js';
import i18n from './i18n.js';

const { obfuscate, resolveOptions } = obfuscateMod;
const { obfuscateDocument } = htmlMod;
const { t } = i18n;

export function looksLikeHtml(code) {
  return /<script[\s>]/i.test(code) || /<\/?(html|head|body)[\s>]/i.test(code);
}

export async function runJob(job) {
  const { code, options = {}, ent, consumeRun } = job;
  const type = job.type || 'auto';

  if (!ent) {
    return { ok: false, status: 401, message: t('licInvalid', { reason: t('licReason_missing') }) };
  }
  if (typeof code !== 'string' || code.trim() === '') {
    return { ok: false, status: 400, message: t('guiNoInput') };
  }

  const g = gate.checkOptions(options, ent);
  if (!g.ok) {
    const message = g.kind === 'preset'
      ? gate.presetBlockedText(g, ent)
      : [gate.violationText(g.hits[0], ent), ...g.hits.slice(1, 4).map((v) => '  ' + gate.violationText(v, ent))].join('\n');
    return { ok: false, status: 403, message, upgrade: gate.upgradeHint(ent) };
  }

  let merged;
  try {
    merged = resolveOptions({ ...options, preset: g.preset });
  } catch (e) {
    return { ok: false, status: 400, message: t('errorPrefix', { msg: e.message }) };
  }
  delete merged.config;

  const bytes = platform.byteLength(code);
  if (ent.limits.maxFileBytes > 0 && bytes > ent.limits.maxFileBytes) {
    return { ok: false, status: 413, message: gate.fileTooBigText(bytes, ent) };
  }

  const isHtml = type === 'html' || (type === 'auto' && looksLikeHtml(code));
  let result;
  try {
    if (isHtml) {
      const r = obfuscateDocument(code, merged);
      if (r.html === null) {
        return {
          ok: false,
          status: 422,
          message: t('htmlNoScripts', {
            ext: r.info.skippedExternal, type: r.info.skippedType, empty: r.info.skippedEmpty,
          }),
        };
      }
      result = {
        code: r.html,
        stats: r.stats || [],
        originalSize: r.originalSize,
        obfuscatedSize: r.obfuscatedSize,
        html: true,
        info: r.info,
        warnings: r.warnings,
      };
    } else {
      const r = obfuscate(code, merged);
      result = {
        code: r.code,
        stats: r.stats,
        originalSize: r.originalSize,
        obfuscatedSize: r.obfuscatedSize,
        html: false,
        info: null,
        warnings: [],
      };
    }
  } catch (e) {
    return { ok: false, status: 422, message: t('obfFail', { msg: (e && e.message) || String(e) }) };
  }

  if (typeof consumeRun === 'function') {
    const c = await consumeRun();
    if (!c || !c.ok) {
      const message = c && c.reason === 'quota'
        ? gate.quotaExhaustedText(ent, c.total)
        : t('licUsageWriteFailed', { msg: t('licReason_' + ((c && c.reason) || 'write')) });
      return { ok: false, status: c && c.reason === 'quota' ? 429 : 500, message };
    }
    result.quota = { used: c.used, total: c.total };
  }

  return { ok: true, status: 200, ...result };
}

export default { runJob, looksLikeHtml };
