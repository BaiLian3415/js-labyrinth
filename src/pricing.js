/**
 * 价目表与购买条款 —— 定价页、订单服务、发卡工具三处共用的**唯一数据源**。
 *
 * 为什么单列一个模块而不是塞进 plans.js：plans.js 管的是「能力闸门」（哪个档能用哪些
 * 选项、配额多少），属于产品能力面；价格是**商业策略**，会单独调整（涨价、做活动、
 * 换计费周期），两者改动节奏完全不同。混在一起的话，改一次价格就要动闸门文件，
 * 而闸门文件里每一条都是安全边界，动它风险大得多。
 *
 * 三条硬规矩：
 *   1. 金额一律用**分**（整数）。用「元」的浮点数会出 `29.99*3 = 89.96999...` 这类
 *      误差，而支付核验是拿金额做等值比较的——差一分钱就是"付了不认"。
 *   2. 每个可购买的 (套餐, 周期) 组合都必须在 PRICES 里显式列价，**没有默认值**。
 *      漏一个键的后果是"页面显示 ¥0.00"或下单报错，绝不能让代码替产品猜价格。
 *   3. 周期天数会进卡密载荷（0 = 永久），上限 1023 天（见 license-codec 的 10 bit
 *      天数段）。改动 TERMS 里任何 days 都要跑 test/pricing.js。
 */

/** 计价币种。微信收款码只收人民币，先只留一种；多币种时的第一个改动点在这里。 */
export const CURRENCY = 'CNY';

/** 卡密天数段的编码上限（10 bit，见 src/license-codec.js）。 */
export const MAX_KEY_DAYS = 1023;

/**
 * 计费周期。
 *
 * `kind` 决定这个周期能挂在哪种套餐上：
 *   - subscription（订阅档 plus/team/business）：月付 / 年付 / 永久
 *   - pack（一次性额度包）：只有 once（买断次数），卡本身给 365 天有效期
 * 把 kind 写进数据里，是为了让 `termsFor()` 能自动挡住"给额度包选年付"这种组合，
 * 而不是靠调用点各判一遍（判漏了就是一笔错单）。
 */
export const TERMS = {
  month: { id: 'month', days: 30, kind: 'subscription' },
  year: { id: 'year', days: 365, kind: 'subscription' },
  perpetual: { id: 'perpetual', days: 0, kind: 'subscription' },
  once: { id: 'once', days: 365, kind: 'pack' },
};

/**
 * 价目表（单位：分）。
 *
 * 这里是**改价的唯一入口**：定价页、/api/pricing、下单金额校验、管理端对账全部读它。
 * 免费档写 `{ free: true }`，按合同报价的档写 `{ contact: true }`——两者都不是"没定价"，
 * 而是"不在线售卖"，所以用显式标记而不是缺键。
 */
export const PRICES = {
  free: { free: true },
  plus: { month: 2900, year: 29900, perpetual: 99900 },
  team: { month: 9900, year: 99900, perpetual: 299900 },
  business: { month: 29900, year: 299900, perpetual: 899900 },
  pack100: { once: 1900 },
  pack1000: { once: 9900 },
  pack10000: { once: 69900 },
  packCustom: { contact: true },
};

/** 该套餐是否在线售卖（有至少一个带价格的周期）。 */
export function isPurchasable(name) {
  const row = PRICES[name];
  if (!row || row.free || row.contact) return false;
  return Object.keys(row).some((k) => TERMS[k] && Number.isSafeInteger(row[k]) && row[k] > 0);
}

/** 该套餐可选的计费周期 id 列表（按 TERMS 声明顺序，价格不存在的周期不出现在列表里）。 */
export function termsFor(name) {
  const row = PRICES[name];
  if (!row || row.free || row.contact) return [];
  return Object.keys(TERMS).filter((t) => Number.isSafeInteger(row[t]) && row[t] > 0);
}

/**
 * 查一个 (套餐, 周期) 的价格。
 *
 * @param {string} name 套餐名（见 src/plans.js）
 * @param {string} term 周期 id（见 TERMS）
 * @returns {{ok:true,fen:number,currency:string,term:string,days:number}
 *          |{ok:false,reason:string}} reason: unknownPlan | freePlan | contactOnly
 *          | unknownTerm | termNotOffered
 */
export function priceOf(name, term) {
  const row = PRICES[name];
  if (!row) return { ok: false, reason: 'unknownPlan' };
  if (row.free) return { ok: false, reason: 'freePlan' };
  if (row.contact) return { ok: false, reason: 'contactOnly' };
  const t = TERMS[term];
  if (!t) return { ok: false, reason: 'unknownTerm' };
  const fen = row[term];
  if (!Number.isSafeInteger(fen) || fen <= 0) return { ok: false, reason: 'termNotOffered' };
  return { ok: true, fen, currency: CURRENCY, term, days: t.days };
}

/**
 * 金额格式化：分 → 显示文本。
 *
 * 刻意不带货币符号：符号由界面按语言给（中文「¥」、英文「CN¥」），免得文案层
 * 再拼一次字符串。整数金额省略小数位（¥29 而不是 ¥29.00）——价目表上更干净，
 * 而订单页会另给「实付 ¥29.00」这种精确到分的写法（formatted:true）。
 *
 * @param {number} fen 金额（分）
 * @param {boolean} [alwaysCents] 是否强制两位小数
 * @returns {string} 例如 "29" / "29.90" / "1,299.00"
 */
export function formatFen(fen, alwaysCents) {
  const n = Number(fen);
  if (!Number.isFinite(n)) return '';
  const neg = n < 0;
  const abs = Math.abs(Math.round(n));
  const yuan = Math.floor(abs / 100);
  const cents = abs % 100;
  const grouped = String(yuan).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = (!cents && !alwaysCents) ? grouped : grouped + '.' + String(cents).padStart(2, '0');
  return (neg ? '-' : '') + body;
}

/** 年付相对月付省下的比例（0~0.99）；没有月付价或没有年付价时返回 null。 */
export function yearlySaving(name) {
  const row = PRICES[name] || {};
  if (!Number.isSafeInteger(row.month) || !Number.isSafeInteger(row.year)) return null;
  if (row.month <= 0 || row.year <= 0) return null;
  const full = row.month * 12;
  if (row.year >= full) return null;
  return Math.round((1 - row.year / full) * 100) / 100;
}

/**
 * 定价页/接口用的整表：能力面取自 plan.rows()（闸门与配额的真源），价格取自本模块。
 *
 * 两处数据拼在一起而不是各写一遍，是为了让"页面上写的权益"永远等于"闸门实际放行的
 * 权益"——这是这一页最容易出的错：价格表写 high 预设、闸门却只放行到 medium。
 *
 * @param {object} plan plan.js 模块（注入以免形成循环依赖）
 * @returns {object[]} 每个套餐一行
 */
export function rows(plan) {
  return plan.rows().map((r) => {
    const row = PRICES[r.name] || {};
    const prices = termsFor(r.name).map((t) => ({
      term: t,
      days: TERMS[t].days,
      fen: row[t],
      text: formatFen(row[t]),
    }));
    return {
      name: r.name,
      display: r.display,
      kind: r.kind,
      preset: r.preset,
      presetCeiling: plan.presetCeiling(r.name),
      maxFileBytes: r.limits.maxFileBytes,
      maxFilesPerRun: r.limits.maxFilesPerRun,
      runsPerDay: r.limits.runsPerDay,
      runsTotal: r.limits.runsTotal,
      quotaText: r.quotaText,
      offOptions: r.offOptions,
      free: !!row.free,
      contact: !!row.contact,
      prices,
      yearlySaving: yearlySaving(r.name),
    };
  });
}

/**
 * 自检：价目表必须与套餐表一一对应，且没有任何"看不见的坑"。
 *
 * 由 test/pricing.js 调用，纯函数、不抛异常（返回问题列表），便于测试打印。
 * 检查项：
 *   - PRICES 的每个键都是合法套餐（写错名字 = 永远查不到价格）
 *   - 每个套餐都有价格行；非 free/contact 的必须有 ≥1 个周期价
 *   - 周期必须是 TERMS 里的，且 kind 与套餐族匹配（订阅档不给 once、额度包不给 month/year）
 *   - 金额是正整数的分；天数在 0..MAX_KEY_DAYS 内
 *   - 年付不贵于 12 个月（否则页面上的"年付"是坑用户）
 *
 * @param {object} plan plan.js 模块
 * @returns {string[]} 问题描述列表（空数组 = 通过）
 */
export function problems(plan) {
  const out = [];
  const names = plan.PLAN_NAMES;
  for (const k of Object.keys(PRICES)) {
    if (!names.includes(k)) out.push(`PRICES 里的 "${k}" 不是合法套餐名`);
  }
  for (const name of names) {
    const row = PRICES[name];
    if (!row) { out.push(`套餐 ${name} 没有价格行`); continue; }
    if (row.free && row.contact) out.push(`${name} 同时标了 free 与 contact`);
    if (row.free || row.contact) continue;
    const isPack = plan.rows().find((r) => r.name === name).kind === 'pack';
    const terms = Object.keys(row).filter((t) => TERMS[t]);
    if (!terms.length) out.push(`${name} 没有任何周期价`);
    for (const t of terms) {
      const fen = row[t];
      if (!Number.isSafeInteger(fen) || fen <= 0) out.push(`${name}.${t} 必须是正整数分，收到 ${fen}`);
      const kind = TERMS[t].kind;
      if (isPack && kind !== 'pack') out.push(`额度包 ${name} 不该有订阅周期 ${t}`);
      if (!isPack && kind === 'pack') out.push(`订阅档 ${name} 不该有买断周期 ${t}`);
      const days = TERMS[t].days;
      if (!Number.isInteger(days) || days < 0 || days > MAX_KEY_DAYS) {
        out.push(`周期 ${t} 的天数 ${days} 超出 0..${MAX_KEY_DAYS}`);
      }
    }
    for (const t of Object.keys(row)) {
      if (!TERMS[t]) out.push(`${name} 用了未定义的周期 "${t}"`);
    }
    const saving = yearlySaving(name);
    if (saving !== null && saving < 0) out.push(`${name} 年付比 12 个月月付还贵`);
  }
  return out;
}

export default {
  CURRENCY, MAX_KEY_DAYS, TERMS, PRICES,
  isPurchasable, termsFor, priceOf, formatFen, yearlySaving, rows, problems,
};
