/**
 * 套餐闸门：判定"这张授权能用哪些选项、到什么强度"。
 * 命令行、网页、Worker API 共用，三端结论一致。
 *
 * 两层判定：
 *   预设 — 用户未指定时的基线，不得越过权益 preset 上限；
 *   闸门 — 显式选项逐个比对 ent.gates，未约束的放行。
 */
import plan from './plan.js';
import PRESETS from './presets.js';
import meta from './options-meta.js';
import i18n from './i18n.js';

const { t } = i18n;
const { flagName } = meta;

const PRESET_ORDER = Object.keys(PRESETS);

export function presetRank(name) {
  return PRESET_ORDER.indexOf(String(name == null ? '' : name).toLowerCase());
}

export function effectivePreset(explicit, ent) {
  if (explicit && explicit.preset !== undefined && explicit.preset !== null && explicit.preset !== '') {
    return String(explicit.preset).toLowerCase();
  }
  return ent.preset;
}

export function checkOptions(explicit, ent) {
  const want = effectivePreset(explicit, ent);
  if (presetRank(want) < 0 || presetRank(want) > presetRank(ent.preset)) {
    return { ok: false, preset: want, kind: 'preset', wantPreset: want, ceiling: ent.preset };
  }
  const hits = violationsOf(explicit || {}, ent);
  if (hits.length) return { ok: false, preset: want, kind: 'options', hits };
  return { ok: true, preset: want };
}

export function violationsOf(opts, ent) {
  const g = ent.gates || {};
  const out = [];
  for (const key of Object.keys(g)) {
    if (!Object.prototype.hasOwnProperty.call(opts, key)) continue;
    const value = opts[key];
    if (value === undefined) continue;
    if (plan.gateAllows(g[key], value)) continue;
    out.push({
      key,
      value,
      gate: g[key],
      kind: g[key] === false ? 'bool' : (typeof g[key] === 'number' ? 'num' : 'enum'),
      allowed: Array.isArray(g[key]) ? g[key] : null,
      unlock: plan.unlock(key, value),
    });
  }
  return out;
}

export function violationText(v, ent) {
  const need = v.unlock.display
    ? (v.unlock.higher
      ? t('planNeed', { plan: v.unlock.display })
      : t('planNeedTop', { plan: v.unlock.display }))
    : '';
  const flag = flagName(v.key);
  if (v.kind === 'bool') return t('planBoolBlocked', { flag, plan: ent.display, need });
  if (v.kind === 'num') {
    return t('planNumBlocked', { flag, plan: ent.display, value: v.value, cap: v.gate, need });
  }
  return t('planEnumBlocked', {
    flag, plan: ent.display, value: v.value, allowed: v.allowed.join(' | '), need,
  });
}

export function presetBlockedText(res, ent) {
  return t('planPresetBlocked', {
    preset: res.wantPreset,
    plan: ent.display,
    ceiling: res.ceiling,
    need: limitNeedHint(ent),
  });
}

export function limitNeedHint(ent) {
  if (ent.trial) return t('webTrialNeed');
  const nx = plan.next(ent.plan);
  return nx
    ? t('planNeed', { plan: plan.displayName(nx) })
    : t('planNeedTop', { plan: plan.displayName(ent.plan) });
}

export function limitsText(ent) {
  const lim = ent.limits;
  const file = plan.humanBytes(lim.maxFileBytes) || t('planUnlimited');
  const files = lim.maxFilesPerRun > 0 ? lim.maxFilesPerRun : t('planUnlimited');
  // 额度包买的是总次数，写"每日 N 次"会让用户以为隔天还能再用
  if (lim.runsTotal > 0) return t('planLimitsPack', { file, files, total: lim.runsTotal });
  return t('planLimits', {
    file,
    files,
    runs: lim.runsPerDay > 0 ? lim.runsPerDay : t('planUnlimited'),
  });
}

export function upgradeHint(ent) {
  if (ent.trial) return t('webTrialUpgradeHint', { limits: limitsText(ent) });
  if (!plan.next(ent.plan)) return '';
  return t('planUpgradeHint', { plan: ent.display, limits: limitsText(ent) });
}

export function quotaExhaustedText(ent, total) {
  // 额度包的次数用完就没了，"明日再试"是错的提示
  if (ent.limits && ent.limits.runsTotal > 0) {
    return t('planPackExhausted', { plan: ent.display, total });
  }
  return t('planQuotaExhausted', {
    plan: ent.display,
    total,
    upgrade: ent.trial ? t('webTrialQuotaUpgrade') : (plan.next(ent.plan) ? t('planQuotaUpgrade') : ''),
  });
}

export function fileTooBigText(size, ent) {
  return t('planFileTooBig', {
    size,
    limit: ent.limits.maxFileBytes,
    plan: ent.display,
    need: limitNeedHint(ent),
  });
}

export function tooManyFilesText(ent) {
  return t('planTooManyFiles', {
    max: ent.limits.maxFilesPerRun,
    plan: ent.display,
    need: limitNeedHint(ent),
  });
}

export function gate(explicit, ent) {
  const res = checkOptions(explicit, ent);
  if (res.ok) return { ok: true, preset: res.preset };
  if (res.kind === 'preset') return { ok: false, preset: res.preset, message: presetBlockedText(res, ent) };
  const first = res.hits[0];
  const rest = res.hits.slice(1, 4).map((v) => '  ' + violationText(v, ent));
  return {
    ok: false,
    preset: res.preset,
    message: [violationText(first, ent), ...rest].join('\n'),
  };
}

export default {
  presetRank,
  effectivePreset,
  checkOptions,
  violationsOf,
  violationText,
  presetBlockedText,
  limitNeedHint,
  limitsText,
  upgradeHint,
  quotaExhaustedText,
  fileTooBigText,
  tooManyFilesText,
  gate,
};
