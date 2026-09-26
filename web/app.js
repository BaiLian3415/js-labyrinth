/**
 * JsLabyrinth 网页界面。
 *
 * 混淆**只在浏览器内**执行：直接调用与命令行、Worker 同一份核心（./src/index.js），
 * 用的是访问者自己的 CPU，代码不出本机，也没有服务端 CPU 时限。服务端只负责
 * 授权（/api/license）与下发策略（/api/plans），不接触源码。
 *
 * 选项界面由 optionsMeta 的元数据渲染，与命令行的选项表同源：新增选项只要
 * 在 src/options-meta.js 里加一行，这里自动出现控件。只有被用户改动过的控件
 * 才作为"显式选项"提交，与命令行"你写什么才算显式"的口径一致，套餐闸门因此
 * 不会因为默认值把用户拦下。
 */
// 授权链路与选项元数据是公开的：未激活用户也要能打开界面、填卡密、激活。
//
// 混淆核心（index.js → obfuscate/pipeline/html → passes/ast）改成**激活后动态引入**
// （见下面的 loadCore）。这样那部分模块可以按设备鉴权下发——匿名请求拿到 403，
// 顺着首页 modulepreload 清单整包爬走的路就断了。代价是首次执行混淆要等模块下载，
// 所以激活成功后会提前预热一次。详见 DEPLOY.md 4.5。
import optionsMeta from './src/options-meta.js';
import optionsGate from './src/options-gate.js';
import plan from './src/plan.js';
import licenseWeb from './src/license-web.js';
import i18n from './src/i18n.js';
import platform from './src/platform.js';
import { makeZip } from './src/utils/zip.js';
import { VERSION } from './src/version.js';
import DEFAULTS from './src/options.js';
import PRESETS from './src/presets.js';

const PRESET_NAMES = Object.keys(PRESETS);
const runtimeInfo = {
  runtime: platform.runtime,
  isNode: platform.isNode,
  isBrowser: platform.isBrowser,
  isWorker: platform.isWorkerd,
  version: VERSION,
};

/**
 * 混淆核心按需加载。缓存 promise，避免每次执行都重新 import。
 *
 * 部署方开启核心鉴权下发后，/src/** 由服务端按设备 cookie 判定给不给。模块请求
 * 是浏览器自己发的普通 GET，带不了自定义头，身份全靠 cookie；cookie 由
 * /api/license 种下，但**前提是服务端认得这台设备**——只在本机验过卡密、没同步
 * 给服务端的话，cookie 指向的是一台"未授权设备"，模块请求照样 403。
 *
 * 所以 403 要先补登记（pushLicense）再重试一次，而不是直接把一句 TypeError
 * 甩给用户。重试必须换 URL：模块图会记住同一个 URL 的失败结果，同一个地址
 * 第二次 import 不会再发请求。
 */
let corePromise = null;
let coreRetried = false;
function loadCore() {
  if (!corePromise) corePromise = importCore();
  return corePromise;
}

async function importCore() {
  let status = 0;
  try {
    return await import('./src/index.js');
  } catch (e) {
    status = await probeCoreStatus();
    if (status === 403 && !coreRetried) {
      coreRetried = true;
      corePromise = null;
      await pushLicense();
      // 重试本身也必须包在 try 里，否则它抛的原生 TypeError 会直接冒到
      // run() 的 catch，被 `f.error = e.message` 原样显示成
      // "Failed to fetch dynamically imported module"——用户看到的是浏览器
      // 的黑话，而不是下面那句能指导操作的提示。
      try {
        return await import('./src/index.js?retry=' + Date.now());
      } catch (e2) {
        // 重试后又失败，原因可能已经变了（比如补登记仍被拒、或此刻断网），
        // 所以重新取一次状态码，别沿用第一次的结论去选文案。
        status = await probeCoreStatus();
      }
    }
    // 失败不缓存：重新激活后再点一次就能直接重试，不必刷新页面
    corePromise = null;
    throw new Error(t(status === 403 ? 'guiCoreBlocked' : 'guiCoreUnreachable', { code: status }));
  }
}

/**
 * 取核心模块的真实 HTTP 状态码。
 *
 * 动态 import 失败时浏览器只抛一句 TypeError，403（鉴权）与 404（资源缺失）、
 * 断网长得一模一样，没法据此给用户建议。这里补一次普通 fetch 拿状态码；
 * 连不上返回 0。
 * @returns {Promise<number>} 状态码，取不到时为 0
 */
async function probeCoreStatus() {
  const base = (state.apiBase || '').replace(/\/+$/, '');
  try {
    const r = await fetch(base + '/src/index.js', { headers: { accept: 'text/javascript' } });
    return r.status;
  } catch (e) {
    return 0;
  }
}

const { t, setLang } = i18n;
const { guiOptions, OPTION_GROUPS } = optionsMeta;

const STORE_KEY = 'jslabyrinth.gui.v1';

/** 界面状态。 */
const state = {
  lang: 'zh',
  theme: 'dark',
  preset: 'low',
  mode: 'auto',
  apiBase: '',
  apiKey: '',
  apiOnline: null,      // null=未探测 / true=授权服务可用 / false=连不上
  apiInfo: null,        // /api/health 的响应体，供诊断展示
  serverLicense: null,  // 服务端认定的授权（部署方覆盖根密钥时，本地验不了签）
  seed: '',
  touched: new Map(),   // 选项键 → 用户显式设定的值
  files: [],            // {name, code, out, status, stats, info, warnings, error}
  active: 0,
};

const $ = (id) => document.getElementById(id);
const els = {};

/**
 * 当前生效的权益。
 *
 * 优先用本地校验的结果（内置密钥）。本地验不出来时看服务端认定：部署方换了
 * 自己的卡密密钥并用 JSLB_CODE_KEY 覆盖了 Worker 的取值时，卡密就只由 Worker
 * 认得出，浏览器手里的内置密钥永远校验不过——这时授权来自 /api/license 的答复。
 *
 * 拿到这个权益就能驱动本地混淆：核心的 runJob 只吃权益对象、不再自己验签，
 * 所以服务端认定的授权同样有效——这正是可以把混淆完全留在浏览器内的前提。
 * 服务端只用来核授权与取策略，源码不上传。
 *
 * @returns {object|null} 权益对象，形制与 plan.describe 一致
 */
function currentEntitlements() {
  return licenseWeb.entitlements() || state.serverLicense;
}

/**
 * 授权是否只来自服务端（本地没有可验签的许可证记录）。
 * 只用于提示文案：本地执行不计数，服务端配额统计不到。
 */
function serverAttested() {
  return !licenseWeb.entitlements() && !!state.serverLicense;
}

// ---------- i18n ----------

/** 把 data-i18n / data-i18n-title / data-i18n-ph / data-i18n-aria 标注的元素翻成当前语言。 */
function applyI18n() {
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
  }
  for (const el of document.querySelectorAll('[data-i18n-ph]')) {
    el.placeholder = t(el.dataset.i18nPh);
  }
  for (const el of document.querySelectorAll('[data-i18n-aria]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  }
  document.documentElement.lang = state.lang === 'zh' ? 'zh' : 'en';
  document.title = t('guiTitle');
}

/**
 * 主题按钮的文案：写"点下去会切到哪一侧"（与按钮上的图标同一语义），
 * 而不是"当前是哪一侧"。
 *
 * 它不能挂 data-i18n：那个属性归 applyI18n() 管，会把文案一律刷成写死的那一个键，
 * 于是每次加载/切语言后按钮都显示"深色"——哪怕此刻已经是深色主题。所以文案由这里
 * 按 state.theme 单独渲染，init 与切语言后各调一次。
 */
function renderThemeBtn() {
  els.themeBtn.querySelector('span').textContent =
    state.theme === 'light' ? t('guiThemeDark') : t('guiThemeLight');
}

// ---------- 选项面板 ----------

/**
 * 某个选项在当前预设下的取值。
 *
 * 界面显示的是"现在真正生效的值"，因此取预设里的字段，预设没有的字段才回退到
 * DEFAULTS。原先一律显示 DEFAULTS，会让选了 low 的用户看到 VM 各项都打着勾，
 * 与实际产物不符。用户显式改过的项优先显示用户值。
 */
function presetValue(key) {
  const p = PRESETS[state.preset];
  if (p && p[key] !== undefined) return p[key];
  return DEFAULTS[key];
}

/** 渲染选项控件。只在初始化与切换语言时重建。 */
function renderOptions() {
  const host = $('optCols');
  host.textContent = '';
  const groups = document.createElement('div');
  groups.className = 'opt-groups';

  const byGroup = new Map(OPTION_GROUPS.map((g) => [g.id, []]));
  for (const opt of guiOptions()) {
    if (!byGroup.has(opt.group)) byGroup.set(opt.group, []);
    byGroup.get(opt.group).push(opt);
  }

  for (const g of OPTION_GROUPS) {
    const list = byGroup.get(g.id) || [];
    if (!list.length) continue;
    // 每个分组渲染成一张卡片：标题栏是「图标 + 组名」，下面是选项行。
    const card = document.createElement('section');
    card.className = 'opt-card';

    const head = document.createElement('header');
    head.className = 'opt-card-head';
    head.appendChild(svgIcon(g.icon));
    const h = document.createElement('h4');
    h.textContent = state.lang === 'zh' ? g.zh : g.en;
    head.appendChild(h);
    card.appendChild(head);

    const body = document.createElement('div');
    body.className = 'opt-card-body';
    for (const opt of list) body.appendChild(renderOption(opt));
    card.appendChild(body);
    groups.appendChild(card);
  }
  host.appendChild(groups);
  refreshGateStyles();
}

/** 24×24 线性图标节点，路径数据来自 options-meta 的 CARD_ICONS。 */
function svgIcon(d) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (d) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

/**
 * ⓘ 说明按钮。提示文本放 data-tip，由 CSS 的 ::after 显示，不需要额外脚本状态。
 * 必须拦掉点击：这一行是 <label>，按钮在 label 里会被转成对控件的激活（开关就是翻转）。
 */
function infoBtn(tip) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'info';
  b.dataset.tip = tip;
  b.setAttribute('aria-label', tip);
  b.textContent = 'i';
  b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
  return b;
}

/**
 * 单个选项的控件。
 * 开关项渲染成 [开关] 名称 [ⓘ]（与图一致）；字符串项的输入框折到第二行整行宽，
 * 枚举与数值项的控件留在行尾。
 */
function renderOption(opt) {
  const row = document.createElement('div');
  row.className = 'opt-row' + (opt.kind === 'bool' ? ' is-bool' : '');
  row.dataset.key = opt.key;

  const label = state.lang === 'zh' ? opt.zh : opt.en;
  const hint = state.lang === 'zh' ? opt.hintZh : (opt.hintEn || opt.hintZh);
  const tip = [label, flagLabel(opt.key) || '', hint || ''].filter(Boolean).join('\n');

  const name = document.createElement('label');
  name.className = 'name';
  name.textContent = label;

  if (opt.kind === 'bool') {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.touched.has(opt.key) ? !!state.touched.get(opt.key) : !!presetValue(opt.key);
    cb.addEventListener('change', () => mark(opt.key, cb.checked, cb));
    row.append(cb, name);
    row.appendChild(infoBtn(tip));
    return row;
  }

  row.appendChild(name);
  row.appendChild(infoBtn(tip));

  let ctl;
  if (opt.kind === 'enum') {
    ctl = document.createElement('select');
    for (const v of opt.values) {
      const o = document.createElement('option');
      o.value = String(v);
      o.textContent = String(v);
      ctl.appendChild(o);
    }
    if (opt.intRange) {
      for (let i = opt.intRange[0]; i <= opt.intRange[1]; i++) {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = String(i);
        ctl.appendChild(o);
      }
    }
    // 预设下拉（顶部 chips 移除后的唯一预设入口）：显示当前预设而不是
    // presetValue('preset')——预设对象里没有 preset 字段，按通用逻辑会落到 undefined。
    const dv = opt.key === 'preset'
      ? (state.touched.has('preset') ? state.touched.get('preset') : state.preset)
      : (state.touched.has(opt.key) ? state.touched.get(opt.key) : presetValue(opt.key));
    ctl.value = String(dv);
    if (ctl.value !== String(dv)) ctl.value = String(opt.def);
  } else {
    ctl = document.createElement('input');
    ctl.type = opt.kind === 'string' ? 'text' : 'number';
    if (opt.kind === 'percent') { ctl.step = '0.05'; ctl.min = '0'; ctl.max = '1'; }
    if (opt.kind === 'count') { ctl.step = '1'; ctl.min = '0'; }
    if (opt.kind === 'int') {
      ctl.step = '1';
      if (opt.min !== undefined) ctl.min = String(opt.min);
      if (opt.max !== undefined) ctl.max = String(opt.max);
    }
    ctl.value = String(state.touched.has(opt.key) ? state.touched.get(opt.key) : presetValue(opt.key));
  }
  ctl.className = 'opt-ctl';
  if (opt.kind === 'string') ctl.classList.add('wide'); // 折行占满整行
  if (state.touched.has(opt.key)) ctl.classList.add('dirty');
  // 行不再是 <label> 包住控件，点名与控件的关联靠 for/id 保住
  ctl.id = 'opt-' + opt.key;
  name.htmlFor = ctl.id;

  if (opt.key === 'preset') {
    // 预设切换沿用原 chips 的语义（"选预设 = 整套套用这份默认值"）：
    // 连先前手改过的项一起清掉，否则改过的那几项会继续盖在新预设上，
    // 选了跟没选一样——这正是"自定义之后再选预设没反应"的原因。
    ctl.addEventListener('change', () => {
      if (state.preset === ctl.value && state.touched.size === 0) return;
      state.preset = ctl.value;
      state.touched.clear();
      renderOptions();   // 全部项跟着新预设走（含本行自己，dirty 态一并重置）
      saveState();
      refreshGateStyles();
      updatePresetHint();
    });
    row.appendChild(ctl);
    return row;
  }

  const commit = () => {
    let v = ctl.value;
    if (opt.kind === 'percent' || opt.kind === 'count' || opt.kind === 'int') {
      const n = Number(v);
      if (!Number.isFinite(n)) { ctl.value = String(opt.def); return; }
      v = n;
    }
    mark(opt.key, v, ctl);
  };
  ctl.addEventListener('change', commit);
  ctl.addEventListener('input', () => { ctl.classList.add('dirty'); });

  row.appendChild(ctl);
  return row;
}

/** 记录一次显式设定。 */
function mark(key, value, ctl) {
  state.touched.set(key, value);
  if (ctl) ctl.classList.add('dirty');
  saveState();
  refreshGateStyles();
}

/** --flag 形式的选项名，给提示用。 */
function flagLabel(key) {
  try { return optionsMeta.flagName(key); } catch (e) { return '--' + key; }
}

/**
 * 按当前授权给越界的选项加灰：显式选项里被闸门拦下的逐个标注，
 * 用户提交前就能看到哪一项会被拒，而不是等运行后报错。
 */
function refreshGateStyles() {
  const ent = currentEntitlements();
  const explicit = explicitOptions();
  const res = ent ? optionsGate.checkOptions(explicit, ent) : { ok: true };
  const blocked = new Map();
  if (ent && !res.ok && res.kind === 'options') {
    for (const h of res.hits) blocked.set(h.key, h);
  }
  // 预设越界：顶部 chips 已移除，把抽屉「基础」组里的预设行标红，
  // 用户提交前就能看到哪一档会被拒，而不是等运行后报错。
  const presetBlocked = !!(ent && !res.ok && res.kind === 'preset');
  for (const row of document.querySelectorAll('.opt-row')) {
    const hit = blocked.get(row.dataset.key);
    const isPreset = row.dataset.key === 'preset';
    row.classList.toggle('gated', !!hit || (isPreset && presetBlocked));
    if (hit) row.title = optionsGate.violationText(hit, ent);
    else if (isPreset && presetBlocked) row.title = optionsGate.presetBlockedText(res, ent);
  }
}

// ---------- 预设 ----------

/**
 * 预设选择器下方的提示。授权带强度上限时把上限写出来：用户选了上层预设会被
 * 闸门拦下，事先说明比事后报错清楚。
 */
function limitsText(ent) {
  const lim = ent.limits;
  const parts = [];
  if (lim.maxFileBytes > 0) parts.push(t('guiLimitsFile', { file: plan.humanBytes(lim.maxFileBytes) }));
  if (lim.maxFilesPerRun > 0) parts.push(t('guiLimitsFiles', { files: lim.maxFilesPerRun }));
  if (lim.runsTotal > 0) parts.push(t('guiLimitsTotal', { total: lim.runsTotal }));
  else if (lim.runsPerDay > 0) parts.push(t('guiLimitsRuns', { runs: lim.runsPerDay }));
  // 额度按合同谈的档不给数字，写了会被当成自助可用的额度
  else parts.push(ent.note === 'contact' ? t('guiLimitsContact') : t('guiLimitsNoRuns'));
  return parts.join('，');
}

function updatePresetHint() {
  const ent = currentEntitlements();
  const base = t('guiPresetHint');
  els.presetHint.textContent = ent
    ? base + ' ' + t('guiPresetCeiling', { preset: ent.preset }) + ' · ' + limitsText(ent)
    : base;
}

// ---------- 输入文件 ----------

/** 换入一批文件；单个文件时直接进编辑框。 */
function setFiles(items) {
  state.files = items.map((it) => ({
    name: it.name,
    code: it.code,
    out: '',
    status: 'pending',
    stats: null,
    info: null,
    warnings: [],
    error: '',
  }));
  state.active = 0;
  renderFiles();
  const f = state.files[state.active];
  els.input.value = f ? f.code : '';
  els.input.disabled = state.files.length > 1;
  els.inInfo.textContent = state.files.length > 1
    ? t('guiFilesN', { n: state.files.length })
    : (f ? f.name : '');
  els.zipBtn.hidden = state.files.length < 2;
  els.zipBtn.textContent = t('guiDownloadZip', { n: state.files.length });
  showResult();
}

/** 文件标签栏。 */
function renderFiles() {
  const host = $('files');
  host.textContent = '';
  host.hidden = state.files.length <= 1;
  state.files.forEach((f, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = f.name;
    b.title = f.name;
    if (i === state.active) b.classList.add('active');
    if (f.status === 'ok') b.classList.add('ok');
    if (f.status === 'error') b.classList.add('err');
    b.addEventListener('click', () => {
      state.active = i;
      els.input.value = f.code;
      renderFiles();
      showResult();
    });
    host.appendChild(b);
  });
}

/** 把当前文件的处理结果铺到输出区。 */
function showResult() {
  const f = state.files[state.active];
  if (!f || !f.out) {
    els.output.value = '';
    els.outInfo.textContent = state.files.length ? t('guiSelectFile') : '';
    els.outSize.textContent = '';
    $('statsBox').hidden = true;
    return;
  }
  els.output.value = f.out;
  // 产物落位时淡入一次：混淆耗时可能几百毫秒到数秒，突然整屏换字会让人
  // 分不清"是不是又跑了一遍"，一次淡入就是"这次结果到了"的信号。
  replay(els.output, 'flash');
  els.outInfo.textContent = f.name;
  els.outSize.textContent = t('guiSize', {
    in: f.originalSize || 0,
    out: f.obfuscatedSize || 0,
    ratio: f.originalSize ? (f.obfuscatedSize / f.originalSize * 100).toFixed(1) : '0',
  });
  renderStats(f);
}

function renderStats(f) {
  const box = $('statsBox');
  const body = $('statsBody');
  body.textContent = '';
  if (!f.stats || !f.stats.length) { box.hidden = true; return; }
  const table = document.createElement('table');
  for (const s of f.stats) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    td1.textContent = s.pass;
    const td2 = document.createElement('td');
    let detail = '';
    try { detail = JSON.stringify(s.result); } catch (e) { detail = String(s.result); }
    td2.textContent = detail;
    tr.append(td1, td2);
    table.appendChild(tr);
  }
  body.appendChild(table);
  for (const w of f.warnings || []) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = t('warningPrefix') + w;
    body.appendChild(p);
  }
  box.hidden = false;
}

// ---------- 运行 ----------

/** 提交给核心的显式选项：只含用户改动过的控件。 */
function explicitOptions() {
  const out = { preset: state.preset };
  for (const [k, v] of state.touched) out[k] = v;
  if (state.seed !== '' && Number.isFinite(Number(state.seed))) out.seed = Number(state.seed);
  return out;
}

/**
 * 重播一次性 CSS 动画。
 *
 * 同一个 class 连续 add 两次浏览器不会重播，中间必须强制一次样式计算把
 * 动画状态"归零"。读 offsetWidth 是最省的写法（比 getComputedStyle 便宜，
 * 且这里只需要触发回流）。
 */
function replay(node, cls) {
  if (!node) return;
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
}

function setStatus(msg, kind) {
  els.status.textContent = msg || '';
  els.status.className = 'status' + (kind ? ' ' + kind : '');
  // 文案有变化才播，否则每次 saveState 都会闪一下
  if (msg) replay(els.status, 'flash');
}

/**
 * 开合选项抽屉。
 *
 * 不用 hidden 属性：hidden 是 display:none，浏览器不会对 display 变化做过渡，
 * 抽屉只会"啪"地出现/消失。改用 data-open + CSS 的 grid-template-rows
 * 0fr→1fr 做高度动画（见 styles.css）。
 *
 * aria-expanded 同步更新，收起后内容仍留在 DOM 里但由 CSS 的 visibility
 * 挡掉，不会被 tab 到。
 */
function setDrawer(open) {
  els.drawer.setAttribute('data-open', open ? '1' : '0');
  els.optsBtn.setAttribute('aria-expanded', String(open));
}

function setBusy(on) {
  els.runBtn.disabled = on;
  els.runBtn.textContent = on ? t('guiRunning') : t('guiRun');
  document.querySelectorAll('.busy-bar').forEach((n) => n.remove());
  if (on) {
    const bar = document.createElement('div');
    bar.className = 'busy-bar';
    document.body.appendChild(bar);
    setStatus(t('guiRunning'), 'busy');
  } else {
    document.querySelectorAll('.busy-bar').forEach((n) => n.remove());
  }
}

/** 让浏览器有机会重绘，再开始跑同步的重活。 */
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

/** 主流程：配额预检 → 逐文件处理 → 记账 → 渲染。 */
async function run() {
  const ent = currentEntitlements();
  if (!ent) {
    setStatus(t('guiFailed', { msg: t('licReason_missing') }), 'err');
    return;
  }
  if (!state.files.length) {
    const code = els.input.value;
    if (!code.trim()) { setStatus(t('guiNoInput'), 'warn'); return; }
    state.files = [{ name: suggestName(code), code, out: '', status: 'pending', stats: null, info: null, warnings: [], error: '' }];
    state.active = 0;
    renderFiles();
    els.zipBtn.hidden = true;
  } else if (state.files.length === 1 && !els.input.disabled) {
    // 单文件模式下输入框是唯一真相，每次运行都要重新读一遍。
    //
    // 原来只在 state.files 为空时读输入框，而第一次运行就会把 state.files 填成
    // 一项，于是**第二次运行沿用第一次缓存的源码**：用户改了代码再点运行，看到的
    // 还是旧结果，且没有任何提示。输入框上没有 input 监听写回 state.files，
    // 所以那条路径永远同步不上。
    //
    // 多文件模式（拖入多个文件）下输入框是只读的、只是当前标签的视图，那时不能
    // 覆盖，交给标签切换去改 state.files——所以这里限定 length === 1。
    // 文件名保留原值：用户改了内容不该让标签名跟着跳。
    const code = els.input.value;
    if (!code.trim()) { setStatus(t('guiNoInput'), 'warn'); return; }
    const f0 = state.files[0];
    f0.code = code;
    f0.out = '';
    f0.status = 'pending';
    f0.stats = null;
    f0.info = null;
    f0.warnings = [];
    f0.error = '';
    state.active = 0;
    renderFiles();
  }

  const options = explicitOptions();
  const res = optionsGate.checkOptions(options, ent);
  if (!res.ok) {
    const msg = res.kind === 'preset'
      ? optionsGate.presetBlockedText(res, ent)
      : optionsGate.violationText(res.hits[0], ent);
    refreshGateStyles();
    setStatus(t('guiBlocked', { msg }), 'err');
    return;
  }

  // 混淆一律在浏览器内跑：用访问者的 CPU，代码不出本机，也不受服务端 CPU 限额
  // 约束（免费版 Worker 单请求只有 10 ms，放服务端跑连几 KB 的输入都会超限）。
  // 服务端只负责授权（/api/license）与下发策略（/api/plans）。

  // 配额预检：与命令行一样，额度用尽时不必跑完再报错
  const q = await licenseWeb.quota();
  if (q && q.total > 0 && q.used >= q.total) {
    setStatus(optionsGate.quotaExhaustedText(ent, q.total), 'err');
    return;
  }

  setBusy(true);
  await nextFrame();
  const t0 = performance.now();
  let okCount = 0;
  let firstError = '';

  for (const f of state.files) {
    try {
      const { runJob } = await loadCore();
      const r = await runJob({ code: f.code, options, type: state.mode, ent });
      if (r.ok) {
        f.out = r.code;
        f.stats = r.stats;
        f.info = r.info;
        f.warnings = r.warnings || [];
        f.originalSize = r.originalSize;
        f.obfuscatedSize = r.obfuscatedSize;
        f.status = 'ok';
        okCount++;
      } else {
        f.status = 'error';
        f.error = r.message;
        if (!firstError) firstError = r.message;
      }
    } catch (e) {
      f.status = 'error';
      f.error = (e && e.message) || String(e);
      // 与上面 r.message 分支同口径：状态条拼的是文本，Error 对象经模板
      // 插值会带上 "Error: " 前缀
      if (!firstError) firstError = f.error;
    }
  }

  if (okCount > 0) {
    const rec = await licenseWeb.consumeRun();
    if (rec && !rec.ok && rec.reason === 'quota') {
      setStatus(optionsGate.quotaExhaustedText(ent, rec.total), 'warn');
    }
  }

  const ms = Math.round(performance.now() - t0);
  renderFiles();
  showResult();
  setBusy(false);
  if (firstError) {
    setStatus(t('guiFailed', { msg: firstError }), 'err');
  } else {
    setStatus(t('guiDone', { ms }), 'ok');
  }
  await refreshLicensePanel();
}

// ---------- 同源服务探活（授权与策略）----------

/**
 * 把界面当前的语言带给服务端。
 *
 * 服务端文案的语言原本由它自己的环境变量决定，界面切英文后，API 返回的报错与
 * 授权横幅仍是中文（"Activation failed: 激活失败: ..." 这种中英夹杂）。带上这个头，
 * 服务端就按界面语言回（见 worker/index.js 的 resolveLang）。
 * @returns {object} 请求头片段
 */
function langHeader() {
  return { 'X-JSLB-Lang': state.lang === 'en' ? 'en' : 'zh' };
}

/**
 * 探一次 /api/health，判断同源是否真的挂了服务。
 *
 * 纯静态部署（只发 dist/、不带 API）里这个地址会返回 404 页面，界面据此提示
 * "需要授权服务"，而不是等用户点了激活才发现连不上。探活失败不算错误：
 * 混淆本身在浏览器内完成，不依赖服务端。
 */
async function probeApi() {
  const base = (state.apiBase || '').replace(/\/+$/, '');
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), 4000) : null;
  try {
    const res = await fetch(base + '/api/health', {
      headers: { accept: 'application/json', ...langHeader() },
      signal: ctl ? ctl.signal : undefined,
    });
    const data = res.ok ? await res.json().catch(() => null) : null;
    state.apiOnline = !!(data && data.ok === true && data.engine);
    state.apiInfo = data || null;
  } catch (e) {
    state.apiOnline = false;
    state.apiInfo = null;
  } finally {
    if (timer) clearTimeout(timer);
  }
  renderApiState();
  if (state.apiOnline) await syncServerPolicy();
}

/**
 * 拉服务端的网页版策略，并按设备码尝试恢复服务端授权。
 *
 * 网页版策略（是否强制卡密、试用上限）本来只配在服务端，浏览器不知道；不拉的话
 * 部署方把 requireLicense 设成 true，界面还会按默认的"允许试用"放行浏览器内执行，
 * 两端判断对不上。/api/plans 里带的就是这份公开信息，正好拿来对齐。
 */
async function syncServerPolicy() {
  const base = (state.apiBase || '').replace(/\/+$/, '');
  try {
    const res = await fetch(base + '/api/plans', { headers: { accept: 'application/json', ...langHeader() } });
    const data = res.ok ? await res.json().catch(() => null) : null;
    if (data && data.web) platform.setWebConfig(data.web);
  } catch (e) { /* 拿不到就沿用当前策略 */ }

  // 策略可能刚变成"必须激活"，本地结论要重算
  const ens = await licenseWeb.ensure();
  if (ens.ok && !ens.trial) {
    state.serverLicense = null;
    // 本地已有授权**也要**同步一次服务端：核心模块按设备 cookie 下发，而 cookie
    // 只在服务端认得这台设备时才管用。上次会话只在本地验过卡密的话，服务端这边
    // 是没有记录的，模块请求会全部 403。同步完再预热核心，免得首次执行要等模块。
    const s = await pushLicense();
    state.serverLicense = s.ok ? s : null;
    if (!s.ok) {
      const q = await callLicenseApi({});
      if (q.ok) state.serverLicense = q;
    }
    loadCore().catch(() => {});
    await refreshLicensePanel();
    return;
  }
  if (!ens.ok) {
    // 本地没有可用授权：问服务端这台设备有没有记录（绑了 KV 才有，按设备码分键）
    const s = await callLicenseApi({});
    if (s.ok && !s.trial) {
      state.serverLicense = s;
      setStatus(t('webActivated', { plan: s.display || plan.displayName(s.plan) }), 'ok');
    }
  }
  await refreshLicensePanel();
}

/**
 * 调同源 /api/license。带 key 是激活，不带是查询（服务端按设备码从 KV 恢复）。
 * @param {object} body 请求体
 * @returns {Promise<object>} 成功时为服务端的授权快照，失败时 {ok:false, message}
 */
async function callLicenseApi(body) {
  const base = (state.apiBase || '').replace(/\/+$/, '');
  const device = await licenseWeb.deviceCode();
  try {
    const res = await fetch(base + '/api/license', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-JSLB-Device': device, ...langHeader() },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.ok) return data;
    return { ok: false, status: res.status, message: (data && data.message) || ('HTTP ' + res.status) };
  } catch (e) {
    return { ok: false, message: (e && e.message) || String(e) };
  }
}

/**
 * 把本机许可证同步给服务端（补登记）。
 *
 * 界面激活走的是本地验签：内置密钥认得卡密就直接返回了，服务端根本不知道这台
 * 设备。开了核心鉴权下发之后这就成了硬伤——cookie 种是种下了，指向的设备在服务
 * 端没有记录，模块请求一律 403，界面上只看到"动态 import 失败"。
 *
 * 送的是已签名的许可证记录而不是卡密原文：服务端照样验机器码绑定，界面这边
 * 也不必为了重试把卡密再存一份。纯静态部署（没有同源服务）直接跳过。
 * @returns {Promise<{ok:boolean}>} 结果
 */
async function pushLicense() {
  if (!state.apiOnline) return { ok: false, message: 'offline' };
  const rec = await licenseWeb.exportRecord();
  if (!rec) return { ok: false, message: 'no-record' };
  return callLicenseApi({ record: rec });
}

/** 把探活结果写到顶栏徽标与抽屉里的提示。 */
function renderApiState() {
  const badge = els.apiState;
  if (!badge) return;
  // 记下切换前的语义，只有"真的变了"才弹一下，避免轮询每次心跳都动
  const prev = badge.dataset.state || '';
  const next = state.apiOnline === null ? 'checking' : (state.apiOnline ? 'online' : 'offline');
  if (state.apiOnline === null) {
    badge.hidden = false;
    badge.className = 'badge';
    badge.textContent = t('guiApiChecking');
    badge.title = '';
  } else if (state.apiOnline) {
    badge.hidden = false;
    badge.className = 'badge online';
    badge.textContent = t('guiApiOnline');
    badge.title = t('guiApiOnlineHint');
  } else {
    badge.hidden = false;
    badge.className = 'badge offline';
    badge.textContent = t('guiApiOffline');
    badge.title = t('guiApiOfflineHint');
  }
  badge.dataset.state = next;
  // 首次渲染（prev 为空）不弹，之后状态跃迁才弹
  if (prev && prev !== next) replay(badge, 'pop');
  if (els.apiHint) {
    if (state.apiOnline === false) els.apiHint.textContent = t('guiApiOfflineHint');
    else if (state.apiOnline && serverAttested()) els.apiHint.textContent = t('guiServerAttestedHint');
    else if (state.apiOnline) els.apiHint.textContent = t('guiApiOnlineHint');
    else els.apiHint.textContent = '';
  }
}

/** 依据内容猜一个输出名。 */
function suggestName(code) {
  return /<script[\s>]/i.test(code) || /<\/?(html|body|head)[\s>]/i.test(code)
    ? 'input.html' : 'input.js';
}

// ---------- 输出：复制与下载 ----------

async function copyOut() {
  const text = els.output.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    setStatus(t('guiCopiedHint'), 'ok');
  } catch (e) {
    els.output.select();
    setStatus(t('guiClipboardFail'), 'warn');
  }
}

/** 输出文件名：源名 + .obfuscated.后缀。 */
function outName(f) {
  const isHtml = f.info ? true : /\.(html?|xhtml)$/i.test(f.name);
  const base = f.name.replace(/\.(js|mjs|cjs|html?|xhtml)$/i, '');
  return base + '.obfuscated' + (isHtml ? '.html' : '.js');
}

function download(name, data, type) {
  const blob = new Blob([data], { type: type || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function downloadActive() {
  const f = state.files[state.active];
  if (!f || !f.out) { setStatus(t('guiNoInput'), 'warn'); return; }
  download(outName(f), f.out);
  setStatus(t('guiDownloadHint'), 'ok');
}

function downloadZip() {
  const done = state.files.filter((f) => f.out);
  if (!done.length) { setStatus(t('guiNoInput'), 'warn'); return; }
  const bytes = makeZip(done.map((f) => ({ name: outName(f), data: f.out })));
  download('jslabyrinth-obfuscated.zip', bytes, 'application/zip');
  setStatus(t('guiDownloadHint'), 'ok');
}

// ---------- 授权面板 ----------

async function refreshLicensePanel() {
  const ent = currentEntitlements();
  // 记录切换前的观感，只有真的变了才弹一下（激活成功那一刻最需要这个反馈）
  const prevLic = els.licBadge.dataset.state || '';
  const nextLic = !ent ? 'missing' : (ent.trial ? 'trial' : 'licensed:' + (ent.display || ''));
  if (!ent) {
    els.licBadge.textContent = t('licReason_missing');
    els.licBadge.className = 'badge';
    els.licInfo.textContent = '';
    els.licDevice.textContent = t('guiDevice') + ': ' + (await licenseWeb.machineId());
    els.licBadge.dataset.state = nextLic;
    if (prevLic && prevLic !== nextLic) replay(els.licBadge, 'pop');
    return;
  }
  const trial = !!ent.trial;
  els.licBadge.textContent = trial ? t('webTrialPlan') : ent.display;
  els.licBadge.className = 'badge ' + (trial ? 'trial' : 'licensed');
  els.licBadge.title = trial ? t('guiTrialHint', { limits: limitsText(ent) }) : '';
  els.licBadge.dataset.state = nextLic;
  if (prevLic && prevLic !== nextLic) replay(els.licBadge, 'pop');
  // 用量一律按**本地**记录显示，不能用服务端那份。
  //
  // 界面这一侧的混淆在浏览器内跑，consumeRun 只把用量写进本地签名记录；服务端那份
  // 是 /api/obfuscate 的计数，浏览器跑多少次它都不知道（这是设计如此，见
  // license-web.importRecord 的说明：服务端拒绝采纳客户端推上来的用量，否则客户端
  // 每刷新一次页面就把服务端的累计计数清零）。
  //
  // 原先这里在 state.serverLicense 存在时直接显示服务端的 quotaText，于是有两个症状：
  //   1) 跑完一次不刷新次数——显示的是一份激活时刻的服务端快照；
  //   2) 刷新页面后先看到本地计数，紧接着被服务端的旧值（通常是 0）覆盖掉。
  // 而 state.serverLicense 在**本地有记录**时也会被赋值（见 syncLicenseWithServer），
  // 所以这条分支的"本地没有可读的记录"前提并不成立。
  const localQuota = await licenseWeb.quotaText();
  if (state.serverLicense) {
    // 服务端答复仍提供横幅与机器码（那两项不随用量变化），只是用量换成本地的；
    // 本地确实没有记录时（比如换了浏览器、只剩 cookie）才回落到服务端那份。
    els.licInfo.textContent = (state.serverLicense.banner || '')
      + (localQuota ? '\n' + localQuota
        : (state.serverLicense.quotaText ? '\n' + state.serverLicense.quotaText : ''));
    els.licInfo.style.whiteSpace = 'pre-line';
    // 服务端没激活时它回的机器码是服务端自己环境派生的展示值，与这台机器无关；
    // 那种情况下仍显示本机那个。已激活时两端必须一致——机器码由服务端签发并与
    // 卡密绑定，本机那份记录里存的就是同一个值。
    const serverMachine = state.serverLicense.trial ? '' : (state.serverLicense.machine || '');
    els.licDevice.textContent = t('guiDevice') + ': ' + (serverMachine || (await licenseWeb.machineId()));
    els.quota.textContent = localQuota || state.serverLicense.quotaText || '';
  } else {
    const banner = await licenseWeb.bannerText();
    els.licInfo.textContent = banner + (localQuota ? '\n' + localQuota : '');
    els.licInfo.style.whiteSpace = 'pre-line';
    els.licDevice.textContent = t('guiDevice') + ': ' + (await licenseWeb.machineId());
    els.quota.textContent = localQuota;
  }
  refreshGateStyles();
  updatePresetHint();
}

/**
 * 按当前授权状态刷新状态栏文案。
 *
 * 抽成函数是为了切语言时也能重刷：这些句子是 t() 拼出来的，语言一变就必须重算，
 * 否则英文界面下会一直留着初始化时写下的中文（"试用模式（未激活）…"）。
 * init 与语言切换共用这一处，避免两份逻辑漂移。
 */
async function refreshStatusFromLicense() {
  const ens = await licenseWeb.ensure();
  if (!ens.ok) {
    setStatus(t('webActivateFailed', { reason: t('licReason_' + (ens.reason || 'missing')) }), 'err');
  } else if (ens.trial) {
    setStatus(t('webTrialBanner', { machine: await licenseWeb.machineId() }), 'warn');
  } else {
    setStatus(t('webActivated', { plan: (licenseWeb.entitlements() || {}).display || '' }), 'ok');
  }
}

async function activate() {
  const key = els.licKey.value.trim();
  if (!key) return;

  // 1) 本地验签：内置密钥认得这张卡（自托管、未覆盖 secret 的部署走这条）
  const r = await licenseWeb.activate(key);
  if (r.ok) {
    els.licKey.value = '';
    state.apiKey = key;
    // 本地验过也必须同步给服务端：核心模块按设备 cookie 下发，服务端没这台
    // 设备的记录就 403。同步失败不回滚本地授权——混淆在浏览器内完成，离线时
    // 本就能用；但要把话说清楚，否则用户只会看到一句 import 失败。
    const s = await pushLicense();
    state.serverLicense = s.ok ? s : null;
    if (s.ok) {
      loadCore().catch(() => {});
      setStatus(t('webActivated', { plan: plan.displayName(r.plan) }), 'ok');
    } else if (state.apiOnline) {
      setStatus(t('webActivatedNoSync', { plan: plan.displayName(r.plan) }), 'warn');
    } else {
      setStatus(t('webActivated', { plan: plan.displayName(r.plan) }), 'ok');
    }
    await refreshLicensePanel();
    return;
  }

  // 2) 本地验不过就问服务端。部署方换了自己的卡密密钥（JSLB_CODE_KEY 覆盖）时，
  //    只有 Worker 认得出卡密，浏览器手里的内置密钥永远校验不过——这一步是那种
  //    部署下唯一能激活的路径。
  if (state.apiOnline) {
    const s = await callLicenseApi({ key });
    if (s.ok) {
      els.licKey.value = '';
      state.apiKey = key;
      state.serverLicense = s;
      setStatus(t('webActivated', { plan: s.display || plan.displayName(s.plan) }), 'ok');
      await refreshLicensePanel();
      return;
    }
    // 服务端返回的 message 已是完整句子（它按请求语言自己拼好"激活失败: …"），
    // 这里直接显示；再套一层 webActivateFailed 会变成"激活失败: 激活失败: …"。
    setStatus(s.message || t('webActivateFailed', { reason: t('licReason_' + r.reason) }), 'err');
    return;
  }

  setStatus(t('webActivateFailed', { reason: t('licReason_' + r.reason) }), 'err');
}

async function deactivate() {
  await licenseWeb.deactivate();
  state.apiKey = '';
  // 输入框里的卡密也清掉：留着的话浏览器刷新时会把表单值填回来，看上去就像
  // 解除没生效（浏览器会记住刷新前的表单内容）。
  els.licKey.value = '';
  state.serverLicense = null;
  let serverCleared = true;
  if (state.apiOnline) {
    // 服务端按设备码存了记录，不清掉的话下一次恢复又会被认成已激活。
    // 必须走 callLicenseApi：设备码在 X-JSLB-Device 里，缺了它服务端删的是
    // 无后缀的共享键，这台设备的记录原封不动——刷新后授权又回来了。
    const s = await callLicenseApi({ deactivate: true });
    serverCleared = s.ok === true;
  }
  // 回到试用态（策略要求强制激活时这里会给出未激活），面板才不会停留在旧权益
  await licenseWeb.ensure();
  await refreshLicensePanel();
  setStatus(serverCleared ? t('webDeactivated') : t('guiDeactivateServerFailed'), serverCleared ? 'ok' : 'warn');
}

// ---------- 文件载入 ----------

/** 读取 File 列表（含拖入的目录）。 */
async function loadFiles(fileList) {
  const items = [];
  for (const file of fileList) {
    const name = file.relPath || file.name;
    if (/\.(js|mjs|cjs|html?|xhtml|txt)$/i.test(name)) {
      items.push({ name, code: await file.text() });
    }
  }
  if (!items.length) { setStatus(t('guiNoInput'), 'warn'); return; }
  setFiles(items);
  setStatus(t('guiPickFiles', { n: items.length }), 'ok');
}

/**
 * 拖放解析：支持目录。浏览器给的是 FileSystemEntry，需要递归读；
 * 不支持该接口时退回 dataTransfer.files。
 */
async function entriesFromDrop(dt) {
  const out = [];
  const items = dt.items ? [...dt.items] : [];
  const roots = items.map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
  if (!roots.length) {
    for (const f of dt.files) out.push(f);
    return out;
  }

  const readFile = (entry, path) => new Promise((resolve) => {
    entry.file((file) => {
      // File 的 name 是只读的，挂一个相对路径副本供命名使用
      Object.defineProperty(file, 'relPath', { value: path + file.name });
      resolve(file);
    }, () => resolve(null));
  });
  const readDir = (entry, path) => new Promise((resolve) => {
    const reader = entry.createReader();
    const all = [];
    const step = () => reader.readEntries(async (batch) => {
      if (!batch.length) { resolve(all); return; }
      for (const e of batch) {
        if (e.isFile) {
          const f = await readFile(e, path);
          if (f) all.push(f);
        } else if (e.isDirectory && !e.name.startsWith('.') && e.name !== 'node_modules') {
          all.push(...await readDir(e, path + e.name + '/'));
        }
      }
      step();
    }, () => resolve(all));
    step();
  });

  for (const root of roots) {
    if (root.isFile) {
      const f = await readFile(root, '');
      if (f) out.push(f);
    } else if (root.isDirectory) {
      out.push(...await readDir(root, root.name + '/'));
    }
  }
  return out;
}

// ---------- 持久化 ----------

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      lang: state.lang,
      theme: state.theme,
      preset: state.preset,
      mode: state.mode,
      apiBase: state.apiBase,
      seed: state.seed,
      touched: [...state.touched],
    }));
  } catch (e) { /* 隐私模式下写不了，不影响使用 */ }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s && typeof s === 'object') {
      if (typeof s.lang === 'string') state.lang = s.lang;
      if (typeof s.theme === 'string') state.theme = s.theme;
      if (typeof s.preset === 'string' && PRESET_NAMES.includes(s.preset)) state.preset = s.preset;
      if (typeof s.mode === 'string') state.mode = s.mode;
      if (typeof s.apiBase === 'string') state.apiBase = s.apiBase;
      if (typeof s.seed === 'string') state.seed = s.seed;
      if (Array.isArray(s.touched)) state.touched = new Map(s.touched);
    }
    // 授权模块自己也要知道服务地址：机器码是向它要的，界面在 A、机器码去 B 取
    // 就会出现"激活前后两个机器码"。
    licenseWeb.setApiBase(state.apiBase);
  } catch (e) { /* 存档损坏就按默认值起 */ }
}

// ---------- 初始化 ----------

async function init() {
  for (const id of ['lang', 'themeBtn', 'optsBtn', 'mode', 'openBtn', 'clearBtn',
    'fileInput', 'files', 'input', 'inInfo', 'output', 'outInfo', 'outSize', 'statsBox',
    'statsBody', 'runBtn', 'copyBtn', 'dlBtn', 'zipBtn', 'drawer', 'apiBase', 'apiHint',
    'licKey', 'actBtn', 'deactBtn', 'licInfo', 'licDevice', 'licBadge', 'seed', 'presetHint',
    'resetBtn', 'status', 'quota', 'ver', 'inputPane', 'outputPane', 'apiState', 'shortcutHint',
    'compareBtn', 'compareModal', 'compareClose', 'compareBackdrop']) {
    els[id] = $(id);
  }

  loadState();
  setLang(state.lang);
  els.lang.value = state.lang;
  document.documentElement.className = state.theme === 'light' ? 'light' : '';
  els.ver.textContent = 'v' + VERSION + ' · ' + runtimeInfo.runtime;
  els.mode.value = state.mode;
  els.apiBase.value = state.apiBase;
  els.seed.value = state.seed;

  applyI18n();
  renderThemeBtn();   // 必须在 applyI18n() 之后：见 renderThemeBtn 的说明
  renderOptions();

  // 事件绑定
  els.lang.addEventListener('change', async () => {
    state.lang = els.lang.value;
    setLang(state.lang);
    applyI18n();
    renderThemeBtn();   // 主题文案不挂 data-i18n，切语言后要自己重渲染
    renderOptions();
    renderFiles();
    showResult();
    renderApiState();
    renderShortcutHint();
    // 授权面板与配额、状态栏都是"渲染一次"的（不走 data-i18n），切语言必须重刷，
    // 否则英文界面下这三处会一直停在初始化时的中文。
    await refreshLicensePanel();
    await refreshStatusFromLicense();
    saveState();
  });

  els.themeBtn.addEventListener('click', () => {
    state.theme = state.theme === 'light' ? 'dark' : 'light';
    document.documentElement.className = state.theme === 'light' ? 'light' : '';
    renderThemeBtn();
    saveState();
  });

  els.optsBtn.addEventListener('click', () => {
    setDrawer(els.drawer.getAttribute('data-open') !== '1');
  });

  // 混淆强度对比弹窗：打开/关闭（Esc、点背景、点 ✕ 均关闭）。
  const openCompare = () => { els.compareModal.hidden = false; };
  const closeCompare = () => { els.compareModal.hidden = true; };
  els.compareBtn.addEventListener('click', openCompare);
  els.compareClose.addEventListener('click', closeCompare);
  els.compareBackdrop.addEventListener('click', closeCompare);

  els.mode.addEventListener('change', () => { state.mode = els.mode.value; saveState(); });
  els.runBtn.addEventListener('click', run);
  els.copyBtn.addEventListener('click', copyOut);
  els.dlBtn.addEventListener('click', downloadActive);
  els.zipBtn.addEventListener('click', downloadZip);

  els.openBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    loadFiles([...els.fileInput.files]);
    els.fileInput.value = '';
  });

  els.clearBtn.addEventListener('click', () => {
    setFiles([]);
    els.input.value = '';
    els.inInfo.textContent = '';
    setStatus('');
  });

  els.seed.addEventListener('input', () => {
    state.seed = els.seed.value.trim();
    saveState();
  });

  els.apiBase.addEventListener('change', () => {
    state.apiBase = els.apiBase.value.trim();
    licenseWeb.setApiBase(state.apiBase);
    saveState();
    state.apiOnline = null;
    renderApiState();
    probeApi();
  });
  els.licKey.addEventListener('change', () => { state.apiKey = els.licKey.value.trim(); });
  els.actBtn.addEventListener('click', activate);
  els.deactBtn.addEventListener('click', deactivate);

  els.resetBtn.addEventListener('click', () => {
    state.touched.clear();
    els.seed.value = '';
    state.seed = '';
    renderOptions();
    saveState();
    updatePresetHint();
  });

  // 拖放
  for (const pane of [els.inputPane, els.outputPane]) {
    pane.addEventListener('dragover', (e) => { e.preventDefault(); pane.classList.add('dragover'); });
    pane.addEventListener('dragleave', () => pane.classList.remove('dragover'));
    pane.addEventListener('drop', async (e) => {
      e.preventDefault();
      pane.classList.remove('dragover');
      const files = await entriesFromDrop(e.dataTransfer);
      if (files.length) loadFiles(files);
    });
  }

  // Ctrl/Cmd + Enter 运行
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    else if (e.key === 'Escape' && !els.compareModal.hidden) { els.compareModal.hidden = true; }
  });

  // 手机屏幕寸土寸金：首屏默认收起选项抽屉，把高度留给输入/输出面板
  // （桌面保持 HTML 里的默认展开）。只在加载时判断一次，之后由"选项"按钮接管。
  if (window.matchMedia && window.matchMedia('(max-width: 640px)').matches) {
    setDrawer(false);
  }

  // 授权：优先恢复已激活卡密，否则按网页版策略进入试用
  await refreshStatusFromLicense();
  await refreshLicensePanel();

  // 探一次同源的授权服务。连不上时（纯静态部署）界面会提示，但混淆本身在浏览器
  // 内完成，不依赖它，所以不阻断。
  renderShortcutHint();
  await probeApi();
  // 授权由服务端认定时本地执行不计数，先说清楚，免得配额对不上时莫名其妙
  if (serverAttested()) setStatus(t('guiServerAttestedHint'), 'warn');
}

/** 状态栏里的快捷键提示。Ctrl 与 ⌘ 各一个键帽，两平台都对得上。 */
function renderShortcutHint() {
  const host = els.shortcutHint;
  if (!host) return;
  host.textContent = '';
  const label = document.createElement('span');
  label.textContent = t('guiShortcut') + ' ';
  const k1 = document.createElement('kbd');
  k1.textContent = 'Ctrl';
  const k2 = document.createElement('kbd');
  k2.textContent = '⌘';
  const plus = document.createTextNode(' / ');
  const k3 = document.createElement('kbd');
  k3.textContent = 'Enter';
  const tail = document.createElement('span');
  tail.textContent = ' ' + t('guiShortcutRun');
  host.append(label, k1, plus, k2, document.createTextNode(' + '), k3, tail);
}

window.addEventListener('DOMContentLoaded', () => {
  init().catch((e) => {
    const el = document.getElementById('status');
    if (el) { el.textContent = 'init failed: ' + ((e && e.message) || e); el.className = 'status err'; }
  });
});
