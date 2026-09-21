#!/usr/bin/env node
/** Node 命令行入口。承担三件事：文件系统、参数解析、许可证闸门。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import obfuscateMod from '../src/obfuscate.js';
import i18n from '../src/i18n.js';
import lic from './license-node.js';
import plan from '../src/plan.js';
import meta from '../src/options-meta.js';
import gate from '../src/options-gate.js';
import platform from '../src/platform.js';
import { processHtml } from '../src/html.js';
import { obfuscateDirectory } from './directory.js';

const { obfuscate, resolveOptions } = obfuscateMod;
const { setLang, t, LANGS } = i18n;
const {
  VALUE_OPTIONS, BOOL_BY_FLAG, VALUE_BY_FLAG,
  KNOWN_OPTION_KEYS, FLAG_CANDIDATES, flagName,
} = meta;

platform.setEntropy((n) => new Uint8Array(crypto.randomBytes(n)));
platform.setPassDumper((name, code) => {
  fs.writeFileSync('_phase_' + name + '.js', code);
});

const SELF_PATH = fileURLToPath(import.meta.url);

function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function matchRate(a, b) {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 100 : Math.round((1 - editDistance(a, b) / max) * 100);
}

function suggestFlags(inputBody) {
  return FLAG_CANDIDATES
    .map((c) => ({
      d: c.display,
      r: Math.max(matchRate(inputBody, c.body), matchRate(inputBody, meta.toCamel(c.body))),
    }))
    .filter((x) => x.r >= 60)
    .sort((x, y) => y.r - x.r || x.d.length - y.d.length)
    .slice(0, 3)
    .map((x) => t('matchItem', { flag: x.d, rate: x.r }));
}

function usageError(message, inputBody) {
  let msg = t('errorPrefix', { msg: message });
  if (inputBody !== undefined) {
    const hits = suggestFlags(inputBody);
    msg += hits.length
      ? t('didYouMean', { hits: hits.join('\n  ') })
      : t('noCloseMatch');
  }
  return new Error(msg);
}

function argError(message, inputBody) {
  throw usageError(message, inputBody);
}

function coerceValue(flag, camel, raw) {
  if (raw === undefined || raw === '' || (raw !== null && raw.startsWith('--'))) {
    argError(t('missingValue', { flag }));
  }
  const spec = VALUE_OPTIONS[camel];
  if (spec.kind === 'string') return raw;
  if (spec.kind === 'enum') {
    if (spec.caseInsensitive) {
      const hit = spec.values.find((v) => v.toLowerCase() === String(raw).toLowerCase());
      if (hit !== undefined) return hit;
    }
    if (spec.values.includes(raw)) return raw;
    if (spec.intRange) {
      const n = Number(raw);
      if (Number.isInteger(n) && n >= spec.intRange[0] && n <= spec.intRange[1]) return n;
    }
    let msg = t('enumOnly', { flag, values: spec.values.join(' | ') });
    if (spec.intRange) msg += t('enumIntRange', { lo: spec.intRange[0], hi: spec.intRange[1] });
    msg += t('gotValue', { raw });
    const close = spec.values
      .map((v) => ({ v, r: matchRate(raw, v) }))
      .filter((x) => x.r >= 60)
      .sort((x, y) => y.r - x.r)
      .slice(0, 2)
      .map((x) => t('matchItem', { flag: x.v, rate: x.r }));
    if (close.length) msg += t('didYouMean', { hits: close.join('\n  ') });
    argError(msg);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) argError(t('mustBeNumber', { flag, raw }));
  if (spec.kind === 'percent') {
    if (n < 0 || n > 1) argError(t('mustBePercent', { flag, raw }));
    return n;
  }
  if (spec.kind === 'count') {
    if (!Number.isInteger(n) || n < 0) argError(t('mustBeCount', { flag, raw }));
    return n;
  }
  // kind === 'int'
  const lo = spec.min !== undefined ? spec.min : null;
  const hi = spec.max !== undefined ? spec.max : null;
  const desc = lo !== null && hi !== null ? t('rangeLoHi', { lo, hi })
    : lo !== null ? t('rangeMin', { lo }) : t('rangeMax', { hi });
  if (!Number.isInteger(n) || (lo !== null && n < lo) || (hi !== null && n > hi)) {
    argError(t('mustBeInt', { flag, desc, raw }));
  }
  return n;
}

function parseArgv(argv) {
  const opts = {};
  let input = null;
  let output = null;
  let help = false;
  let i = 0;

  const positional = (a) => {
    if (input === null) input = a;
    else if (output === null) output = a;
    else argError(t('extraPositional', { a }));
  };
  const pathValue = (flag, raw) => {
    if (raw === undefined || raw === '' || raw.startsWith('-')) {
      argError(t('missingValue', { flag }));
    }
    return raw;
  };

  while (i < argv.length) {
    const a = argv[i++];
    if (a === '--') {
      while (i < argv.length) positional(argv[i++]);
      break;
    }
    if (a === '-h' || a === '--help') { help = true; continue; }
    if (a === '-o') { output = pathValue(a, argv[i++]); continue; }
    if (a.startsWith('-') && !a.startsWith('--') && a !== '-') argError(t('unknownShort', { a }), a.slice(1));
    if (!a.startsWith('--')) { positional(a); continue; }

    const body = a.slice(2);
    const eq = body.indexOf('=');
    const key = eq >= 0 ? body.slice(0, eq) : body;
    const val = eq >= 0 ? body.slice(eq + 1) : null;
    const flag = `--${key}`;

    if (key === 'output') { output = pathValue(flag, val !== null ? val : argv[i++]); continue; }
    if (key === 'config') { opts.config = pathValue(flag, val !== null ? val : argv[i++]); continue; }

    const valueCamel = VALUE_BY_FLAG.get(key);
    if (valueCamel) {
      opts[valueCamel] = coerceValue(flag, valueCamel, val !== null ? val : argv[i++]);
      continue;
    }

    let target = BOOL_BY_FLAG.get(key);
    let want = true;
    if (target === undefined && key.startsWith('no-')) {
      const pos = key.slice(3);
      if (VALUE_BY_FLAG.has(pos)) argError(t('noFlagOnValueOption', { pos }));
      target = BOOL_BY_FLAG.get(pos);
      want = false;
    }
    if (target !== undefined) {
      if (val === null) opts[target] = want;
      else if (val === 'true' || val === 'false') opts[target] = (val === 'true') === want;
      else {
        const off = key.startsWith('no-') ? key.slice(3) : 'no-' + key;
        argError(t('boolNoValue', { flag, on: key, off }));
      }
      continue;
    }

    argError(t('unknownOption', { a }), key);
  }
  return { input, output, opts, help };
}

function printStats(stats, origSize, obsSize) {
  console.error('\n' + t('statsHeader'));
  for (const s of stats) {
    let detail = '';
    try { detail = JSON.stringify(s.result); } catch (e) { /* ignore */ }
    console.error(`  ${s.pass.padEnd(18)} ${detail}`);
  }
  const ratio = origSize > 0 ? (obsSize / origSize * 100).toFixed(1) : 0;
  console.error(t('statsSize', { in: origSize, out: obsSize, ratio }));
}

function obfuscateHtml(code, merged) {
  const baseSeed = merged.seed !== undefined ? merged.seed : 1337;
  let lastStats = null;
  let lastSizes = null;
  const res = processHtml(code, (js, idx, m) => {
    const opts = { ...merged, seed: baseSeed + idx * 7919 };
    if (m.sharedNames.length) opts.selfCheck = false;
    const out = obfuscate(js, opts);
    lastStats = out.stats;
    lastSizes = [out.originalSize, out.obfuscatedSize];
    return out.code;
  });
  if (res.info.obfuscated === 0) {
    console.error(t('htmlNoScripts', {
      ext: res.info.skippedExternal, type: res.info.skippedType, empty: res.info.skippedEmpty,
    }));
    return { html: null, res };
  }
  for (const w of res.warnings) console.error(t('warningPrefix') + w);
  if (res.info.failed) console.error(t('warningPrefix') + t('htmlBlockFailedWarn', { n: res.info.failed }));
  console.error(t('htmlSummary', {
    n: res.info.obfuscated,
    ext: res.info.skippedExternal,
    type: res.info.skippedType,
    empty: res.info.skippedEmpty,
    failedPart: res.info.failed ? t('htmlSummaryFailed', { n: res.info.failed }) : '',
  }));
  if (lastStats) printStats(lastStats, lastSizes[0], lastSizes[1]);
  return { html: res.html, res };
}

function prescanLang(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') break;
    let v;
    if (a === '--lang') v = argv[i + 1];
    else if (a.startsWith('--lang=')) v = a.slice('--lang='.length);
    else continue;
    if (v !== undefined && LANGS.includes(v)) setLang(v);
  }
}

function prescanPlan(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') return;
    if (a === '--plan' || a.startsWith('--plan=')) {
      const ent = lic.entitlements();
      console.error(t('planNotSelectable', {
        plan: ent ? ent.display : '?',
        machine: lic.machineId(),
      }));
      process.exit(1);
    }
  }
}

function printUpgradeHint(ent) {
  const hint = gate.upgradeHint(ent);
  if (hint) console.error(hint);
}

function planHelpTable() {
  const lines = plan.rows().map((r) => t('planHelpRow', {
    display: r.display.padEnd(9),
    preset: r.preset.padEnd(7),
    file: plan.humanBytes(r.limits.maxFileBytes) || t('planUnlimited'),
    files: r.limits.maxFilesPerRun > 0 ? r.limits.maxFilesPerRun : t('planUnlimited'),
    quota: r.quotaText,
    features: r.offOptions.length
      ? t('planFeatureExcept', { list: r.offOptions.map(flagName).join(' ') })
      : t('planFeatureAll'),
  }));
  return t('planHelpHeader') + '\n' + lines.join('\n');
}

function recordRun() {
  const ent = lic.entitlements();
  const r = lic.consumeRun();
  if (r.ok) {
    console.error(lic.quotaText());
    return;
  }
  if (r.reason === 'quota') {
    console.error(gate.quotaExhaustedText(ent, r.total));
  } else {
    console.error(t('licUsageWriteFailed', { msg: t('licReason_' + r.reason) }));
  }
  process.exitCode = 1;
}

function runMain() {
  prescanLang(process.argv.slice(2));
  prescanPlan(process.argv.slice(2));
  let parsed;
  try {
    parsed = parseArgv(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const { input, output, opts, help } = parsed;
  if (opts.lang) setLang(opts.lang);

  if (help || !input) {
    console.log(t('help', { plans: planHelpTable() }));
    if (!help && !input) process.exitCode = 1;
    return;
  }

  let fileOpts = {};
  if (opts.config) {
    try {
      fileOpts = JSON.parse(fs.readFileSync(opts.config, 'utf8'));
    } catch (e) {
      console.error(t('configReadError', { msg: e.message }));
      process.exit(1);
    }
    if (typeof fileOpts !== 'object' || fileOpts === null || Array.isArray(fileOpts)) {
      console.error(t('errorPrefix', { msg: t('configNotObject') }));
      process.exit(1);
    }
    for (const k of Object.keys(fileOpts)) {
      if (!KNOWN_OPTION_KEYS.has(k)) {
        console.error(usageError(t('configUnknownKey', { file: opts.config, k }), k).message);
        process.exit(1);
      }
    }
  }

  const ent = lic.entitlements();
  if (!ent) {
    console.error(t('licInvalid', { reason: t('licReason_missing') }));
    process.exit(1);
  }
  const explicit = { ...fileOpts, ...opts };
  delete explicit.config;
  delete explicit.lang;

  const g = gate.checkOptions(explicit, ent);
  if (!g.ok) {
    if (g.kind === 'preset') {
      console.error(usageError(gate.presetBlockedText(g, ent)).message);
    } else {
      console.error(usageError(gate.violationText(g.hits[0], ent)).message);
      for (const v of g.hits.slice(1, 4)) console.error('  ' + gate.violationText(v, ent));
    }
    printUpgradeHint(ent);
    process.exit(1);
  }

  const quotaNow = lic.quota();
  if (quotaNow && quotaNow.total > 0 && quotaNow.used >= quotaNow.total) {
    console.error(gate.quotaExhaustedText(ent, quotaNow.total));
    printUpgradeHint(ent);
    process.exit(1);
  }

  let merged;
  try {
    merged = resolveOptions({ ...explicit, preset: g.preset });
  } catch (e) {
    console.error(t('errorPrefix', { msg: e.message }));
    process.exit(1);
  }
  delete merged.config;
  if (merged.lang) setLang(merged.lang);
  delete merged.lang;

  let inputIsDir = false;
  try { inputIsDir = fs.statSync(input).isDirectory(); } catch (e) { /* 文件分支处理 */ }
  if (inputIsDir) {
    const outDir = output || path.join(path.dirname(path.resolve(input)), path.basename(path.resolve(input)) + '.obfuscated');
    console.error(t('dirStart', { in: input, out: outDir }));
    let r;
    try {
      lic.watchdog('directory');
      r = obfuscateDirectory(input, outDir, merged, {
        display: ent.display,
        limits: ent.limits,
        need: gate.limitNeedHint(ent),
      });
    } catch (e) {
      console.error(t('dirFail', { msg: e.message }));
      process.exit(1);
    }
    for (const it of r.results) {
      if (it.status === 'ok') console.error(t('dirOk', { file: it.file, in: it.inSize, out: it.outSize }));
      else if (it.status === 'error') console.error(t('dirError', { file: it.file, err: it.error }));
      else if (it.status === 'copied') console.error(t('dirCopied', { file: it.file }));
      else if (it.status === 'skipped-dir' || it.status === 'skipped-output') console.error(t('dirSkippedDir', { file: it.file }));
      else console.error(t('dirSkipped', { file: it.file }));
    }
    console.error(t('dirDone', {
      ok: r.ok, copied: r.copied, skipped: r.skipped, failed: r.failed,
      in: r.totalIn, out: r.totalOut,
    }));
    if (r.failed) process.exitCode = 1;
    recordRun();
    lic.watchdog('directory-done');
    return;
  }

  let code;
  try {
    code = fs.readFileSync(input, 'utf8');
  } catch (e) {
    console.error(t('inputReadError', { msg: e.message }));
    process.exit(1);
  }

  const inputBytes = platform.byteLength(code);
  if (ent.limits.maxFileBytes > 0 && inputBytes > ent.limits.maxFileBytes) {
    console.error(gate.fileTooBigText(inputBytes, ent));
    process.exit(1);
  }

  const isHtml = /\.(html?|xhtml)$/i.test(input);

  if (isHtml) {
    let htmlRes;
    try {
      lic.watchdog('html');
      htmlRes = obfuscateHtml(code, merged);
    } catch (e) {
      console.error(t('htmlFail', { msg: e.stack }));
      process.exit(1);
    }
    if (htmlRes.html === null) {
      process.exit(1);
    }
    const outPath = output || input.replace(/(\.[^.]+)?$/, '') + '.obfuscated.html';
    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, htmlRes.html);
    } catch (e) {
      console.error(t('writeError', { msg: e.message }));
      process.exit(1);
    }
    console.error(t('written', { path: outPath }));
    recordRun();
    return;
  }

  let result;
  try {
    lic.watchdog('file');
    result = obfuscate(code, merged);
  } catch (e) {
    console.error(t('obfFail', { msg: e.stack }));
    process.exit(1);
  }

  const outPath = output || input.replace(/\.js$/, '') + '.obfuscated.js';
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, result.code);
  } catch (e) {
    console.error(t('writeError', { msg: e.message }));
    process.exit(1);
  }

  console.error(t('written', { path: outPath }));

  printStats(result.stats, result.originalSize, result.obfuscatedSize);
  recordRun();
  lic.watchdog('done');
}

const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH;

if (isMain) {
  lic.guard(runMain).catch((e) => {
    if (e && e.message === lic.TRAP_MARK) lic.trapExit('unhandled');
    console.error(t('obfFail', { msg: (e && e.stack) || String(e) }));
    process.exit(1);
  });
}

export { runMain, parseArgv, usageError, coerceValue, obfuscateHtml, SELF_PATH, isMain, printStats };
