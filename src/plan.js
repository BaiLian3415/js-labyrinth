import PLANS from './plans.js';
import PRESETS from './presets.js';
import i18n from './i18n.js';

/** 套餐权益：卡密套餐标识 → 可用选项范围 + 配额上限。
 *  唯一事实来源是 src/plans.js；本模块只负责解读与判定。
 *  模块加载时断言一致性，改歪立即抛错。 */

const PLAN_NAMES = Object.keys(PLANS);
const DEFAULT_PLAN = PLAN_NAMES[0];
const BY_RANK = [...PLAN_NAMES].sort((a, b) => PLANS[a].rank - PLANS[b].rank);
const PRESET_ORDER = Object.keys(PRESETS);
const CODE_CHAR = /^[0-9A-HJKMNP-TV-Z]$/;
const LIMIT_KEYS = ['maxFileBytes', 'maxFilesPerRun', 'runsPerDay', 'runsTotal'];

const PACK_KIND = 'pack';
const SUB_KIND = 'subscription';
const kindOf = (name) => (PLANS[name] && PLANS[name].kind === PACK_KIND ? PACK_KIND : SUB_KIND);
const SUB_NAMES = BY_RANK.filter((n) => kindOf(n) === SUB_KIND);
const PACK_NAMES = BY_RANK.filter((n) => kindOf(n) === PACK_KIND);
const isPack = (name) => kindOf(name) === PACK_KIND;

const { t } = i18n;

const isPlan = (name) => Object.prototype.hasOwnProperty.call(PLANS, name);

function displayName(name) {
  return isPlan(name) ? PLANS[name].display : String(name);
}

function rank(name) {
  return isPlan(name) ? PLANS[name].rank : -1;
}

function presetCeiling(name) {
  return PLANS[name].preset;
}

function limits(name) {
  return PLANS[name].limits;
}

function gates(name) {
  return PLANS[name].gates;
}

function describe(name) {
  const p = PLANS[name];
  return {
    name,
    display: p.display,
    rank: p.rank,
    preset: p.preset,
    kind: kindOf(name),
    note: p.note || '',
    limits: p.limits,
    gates: p.gates,
  };
}

function quotaLimit(ent) {
  const lim = (ent && ent.limits) || {};
  return lim.runsTotal > 0 ? lim.runsTotal : (lim.runsPerDay || 0);
}

function isCumulative(ent) {
  return !!ent && !!ent.limits && ent.limits.runsTotal > 0;
}

function planFromCode(ch) {
  for (const name of PLAN_NAMES) {
    if (PLANS[name].code === ch) return name;
  }
  return null;
}

function planCode(name) {
  return isPlan(name) ? PLANS[name].code : null;
}

function gateAllows(gate, value) {
  if (gate === undefined) return true;
  if (gate === false) return value === false;
  if (typeof gate === 'number') {
    return typeof value === 'number' && Number.isFinite(value) && value <= gate;
  }
  if (Array.isArray(gate)) return gate.indexOf(value) >= 0;
  return true;
}

function gateNotLooserThan(a, b) {
  if (b === undefined) return true;   // 高档未设闸门 = 全放行，a 不可能更松
  if (a === undefined) return false;  // a 未设而 b 有限制 → a 更松
  if (a === false) return true;       // false 是最紧的一档
  if (b === false) return false;      // a 不是 false 而 b 是 → a 更松
  if (typeof a === 'number' && typeof b === 'number') return a <= b;
  if (Array.isArray(a) && Array.isArray(b)) return a.every((v) => b.indexOf(v) >= 0);
  return true;                        // 类型不同，不判断
}

function violations(opts, planName) {
  const g = gates(planName);
  const out = [];
  for (const key of Object.keys(g)) {
    if (!Object.prototype.hasOwnProperty.call(opts, key)) continue;
    const value = opts[key];
    if (value === undefined) continue;
    if (gateAllows(g[key], value)) continue;
    out.push({
      key,
      value,
      gate: g[key],
      kind: g[key] === false ? 'bool' : (typeof g[key] === 'number' ? 'num' : 'enum'),
      allowed: Array.isArray(g[key]) ? g[key] : null,
      unlock: unlock(key, value),
    });
  }
  return out;
}

function unlock(key, value) {
  const names = SUB_NAMES.filter((n) => gateAllows(PLANS[n].gates[key], value));
  return {
    plans: names,
    display: names.length ? displayName(names[0]) : '',
    higher: names.length > 1,
  };
}

function next(name) {
  const ladder = isPack(name) ? PACK_NAMES : SUB_NAMES;
  const i = ladder.indexOf(name);
  return i >= 0 && i + 1 < ladder.length ? ladder[i + 1] : null;
}

function quotaText(name) {
  if (!isPlan(name)) return '';
  const lim = PLANS[name].limits;
  if (lim.runsTotal > 0) return t('planQuotaPack', { total: lim.runsTotal });
  if (PLANS[name].note === 'contact') return t('planContactAuthor');
  return lim.runsPerDay > 0
    ? t('planQuotaDaily', { runs: lim.runsPerDay })
    : t('planQuotaDailyUnlimited');
}

function presetAllowed(planName, presetName) {
  const want = PRESET_ORDER.indexOf(String(presetName == null ? '' : presetName).toLowerCase());
  const ceiling = PRESET_ORDER.indexOf(presetCeiling(planName));
  return want >= 0 && ceiling >= 0 && want <= ceiling;
}

function rows() {
  return BY_RANK.map((name) => {
    const p = PLANS[name];
    return {
      name,
      display: p.display,
      rank: p.rank,
      preset: p.preset,
      kind: kindOf(name),
      note: p.note || '',
      limits: p.limits,
      quotaText: quotaText(name),
      offOptions: Object.keys(p.gates).filter((k) => p.gates[k] === false),
    };
  });
}

function humanBytes(n) {
  if (!n) return null;
  if (n >= 1048576) return (n / 1048576) + ' MB';
  if (n >= 1024) return (n / 1024) + ' KB';
  return n + ' B';
}

function assertConsistent() {
  const problems = [];
  const codes = new Map();
  const ranks = new Map();
  for (const name of PLAN_NAMES) {
    const p = PLANS[name];
    if (codes.has(p.code)) problems.push(`套餐 ${name} 与 ${codes.get(p.code)} 的套餐字符 "${p.code}" 重复`);
    else codes.set(p.code, name);
    if (!CODE_CHAR.test(String(p.code))) problems.push(`套餐 ${name} 的套餐字符 "${p.code}" 不在 base32 字符表内`);
    if (ranks.has(p.rank)) problems.push(`套餐 ${name} 与 ${ranks.get(p.rank)} 的 rank ${p.rank} 重复`);
    else ranks.set(p.rank, name);
    for (const k of LIMIT_KEYS) {
      const v = p.limits[k];
      if (!Number.isSafeInteger(v) || v < 0) problems.push(`套餐 ${name} 的配额 ${k} 必须是非负整数，收到 ${JSON.stringify(v)}`);
    }
    const preset = PRESETS[p.preset];
    if (!preset) {
      problems.push(`套餐 ${name} 引用的预设 "${p.preset}" 不存在于 presets.js`);
      continue;
    }
    for (const key of Object.keys(p.gates)) {
      const presetValue = preset[key];
      if (presetValue === undefined) {
        problems.push(`套餐 ${name} 自带的预设 ${p.preset} 缺少被闸门约束的选项 ${key}`);
      } else if (!gateAllows(p.gates[key], presetValue)) {
        problems.push(`套餐 ${name} 的闸门 ${key}=${JSON.stringify(p.gates[key])} 拦下了自带预设 ${p.preset} 的取值 ${JSON.stringify(presetValue)}`);
      }
    }
  }
  for (const ladder of [SUB_NAMES, PACK_NAMES]) {
    for (let i = 0; i + 1 < ladder.length; i++) {
      const lo = ladder[i];
      const hi = ladder[i + 1];
      const loP = PLANS[lo];
      const hiP = PLANS[hi];
      if (PRESET_ORDER.indexOf(loP.preset) > PRESET_ORDER.indexOf(hiP.preset)) {
        problems.push(`档位阶梯：${lo} 的预设上限 ${loP.preset} 高于 ${hi} 的 ${hiP.preset}`);
      }
      for (const k of LIMIT_KEYS) {
        const a = loP.limits[k] === 0 ? Infinity : loP.limits[k];
        const b = hiP.limits[k] === 0 ? Infinity : hiP.limits[k];
        if (a > b) problems.push(`档位阶梯：${lo} 的 ${k}(${loP.limits[k]}) 大于 ${hi} 的 (${hiP.limits[k]})`);
      }
      if (isPack(lo) && loP.limits.runsTotal === 0 && loP.note !== 'contact') {
        problems.push(`额度包 ${lo} 的 runsTotal 必须为正数（0 只留给 note:"contact" 的定制档）`);
      }
      for (const k of Object.keys(loP.gates)) {
        if (!gateNotLooserThan(loP.gates[k], hiP.gates[k])) {
          problems.push(`档位阶梯：${lo} 的闸门 ${k}=${JSON.stringify(loP.gates[k])}`
            + ` 比 ${hi} 的 ${JSON.stringify(hiP.gates[k])} 更松`);
        }
      }
    }
  }
  if (problems.length) {
    throw new Error('套餐配置不一致（检查 src/plans.js 与 src/presets.js）:\n  ' + problems.join('\n  '));
  }
}

assertConsistent();

export default {
  PLANS,
  PLAN_NAMES,
  DEFAULT_PLAN,
  BY_RANK,
  SUB_NAMES,
  PACK_NAMES,
  isPlan,
  isPack,
  kindOf,
  displayName,
  rank,
  presetCeiling,
  limits,
  gates,
  describe,
  planFromCode,
  planCode,
  gateAllows,
  violations,
  unlock,
  next,
  presetAllowed,
  rows,
  quotaText,
  quotaLimit,
  isCumulative,
  humanBytes,
};
