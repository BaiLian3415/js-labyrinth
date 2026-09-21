#!/usr/bin/env node
'use strict';
/**
 * 卡密计算工具。发卡方使用，不随最终用户分发。
 *
 * 用法:
 *   node tools/issue/keygen.js [选项]
 *
 * 选项:
 *   -P, --plan <s>     套餐名（订阅档 free|plus|pro|team|business，一次性额度包
 *                      pack100|pack1000|pack10000|packCustom），默认 free（最低档）
 *   -d, --days <n>     有效天数，0 表示永久，默认 365
 *   -c, --count <n>    生成数量，默认 1
 *   -i, --id <n>       起始编号，十进制文本，默认取计数器文件中的下一个编号
 *   -p, --prefix <s>   编号前缀文本，仅显示用，不参与签名
 *   -b, --bind <mid>   绑定机器码（24 字符 base32），该卡只能在这台机器上激活；
 *                      省略则不绑定，任何机器都能激活
 *   --machine          打印本机机器码后退出（把它发给签发方用 --bind 签卡）
 *   --plans            打印套餐权益对照表，不签发
 *   --check <code>     只校验一段卡密，不签发
 *   --json             以 JSON 输出，便于批量入库，编号为十进制字符串
 *   -h, --help         帮助
 *
 * 卡密格式: JSLB-<套餐段>-<天数段>-<签发日段>-<编号段>-<绑定段>-<签名段>
 *   例: node tools/issue/keygen.js --plan pro --days 30 --count 3
 *
 * 套餐段 1 个字符（F=Free、P=Plus、R=Pro、T=Team、B=Business、S/M/W/C=一次性
 * 额度包 100/1000/10000/定制），决定这张卡能用的混淆选项范围与配额，定义见
 * src/plans.js。套餐段进签名载荷，用户改卡密上的字符换不到高档权益。--plans
 * 可直接打印各档差异。
 *
 * 编号段为 8 个 Crockford base32 字符，共 40 bit，约 1.1 万亿个编号。
 *
 * 绑定段 16 个字符，是机器码的派生摘要（HMAC），**卡密上看不出机器码本身**。
 * 它同样进签名载荷，所以改一个字符就验签失败——拿别人的卡密改到自己机器上
 * 是不可能的。不绑定时该段为全 0。
 *
 * 默认编号由包根下的计数器文件 .keygen-state.json 分配，每签发一次递增，
 * 首次使用或计数器缺失时以当前毫秒时间戳**取模编号段跨度**为起点。不能直接用
 * 时间戳：13 位毫秒数超出 40 bit 编号段的上限，会让首次签发（含最常见的
 * --bind 签名场景）直接失败。取模后仍在进程间唯一，且计数器一旦写出就不再
 * 看时间戳。默认编号也不用时间戳低位截断——那种取值在同一秒内连跑多次会重复，
 * 签出完全相同的卡密。
 *
 * 签名算法与 src/license-codec.js 是同一份实现，签发与校验永远同源。根密钥
 * 来自 src/license-secret.js，轮换该文件后必须重新发卡。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import secret from '../../src/license-secret.js';
import codec from '../../src/license-codec.js';
import plan from '../../src/plan.js';
import { b64ToBytes, b64ToText } from '../../src/utils/hash.js';

const { B64_PUBLIC_KEY, B64_MACHINE_SALT } = secret;

// 签发私钥（Ed25519 种子，base64）。**这是全套系统里唯一的秘密**：拿到它就能签出
// 任意套餐、任意有效期的卡密，而所有验签方都持有对应公钥，一定通过。
//
// 优先读环境变量，其次读项目根的 .jslb-signing-key（该文件在 .gitignore 里）。
// 生产环境建议只用环境变量或密钥管理服务，别在磁盘上留副本。
//
//   JSLB_SIGNING_KEY=<base64> node tools/issue/keygen.js --plan pro --days 365
//
// 卡密用私钥签，验签只需公钥——所以浏览器与 Worker 那边爬走全部源码也签不出新卡。
const SIGNING_KEY = (() => {
  const fromEnv = process.env.JSLB_SIGNING_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const keyPath = process.env.JSLABYRINTH_SIGNING_KEY_FILE || null;
  const candidates = keyPath
    ? [keyPath]
    : [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.jslb-signing-key')];
  for (const p of candidates) {
    try {
      const text = fs.readFileSync(p, 'utf8').trim();
      if (text) return text;
    } catch (e) { /* 文件不存在就继续找下一个 */ }
  }
  return '';
})();

/** 私钥是否可用。缺失时不能签发，只能验签。 */
const SIGNING_OK = (() => {
  if (!SIGNING_KEY) return false;
  try {
    return b64ToBytes(SIGNING_KEY).length === 32;
  } catch (e) {
    return false;
  }
})();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

/**
 * 默认编号的计数器文件。
 *
 * 默认编号必须跨进程唯一。同一秒内连跑两次，进程之间不共享状态，就会签出
 * 同一段卡密。可用环境变量 JSLABYRINTH_KEYGEN_STATE 指定其他路径。多个发卡
 * 终端各用各的计数器时，需自行保证区间不重叠。
 */
const STATE_PATH = process.env.JSLABYRINTH_KEYGEN_STATE || path.join(ROOT, '.keygen-state.json');

/** 计数器锁文件，并发签发时串行化读取、递增、写回三步。 */
const LOCK_PATH = STATE_PATH + '.lock';

/**
 * 锁文件过期阈值，单位毫秒。持有者崩溃后遗留的锁由后续进程接管。
 *
 * 定得比"实际持锁时长"宽松得多是不行的：锁只在读、递增、写回一个几十字节的
 * JSON 期间持有（毫秒级），而进程被 Ctrl-C 或超时杀掉时会留下锁文件。阈值若
 * 是 10 秒，那么杀掉后紧接着重跑就会在 10 秒窗口内直接失败，且失败信息只在
 * stderr——stdout 为空，看起来像"卡密签发没反应"。2 秒已经比真实持锁时间长
 * 三个数量级，足够容忍正常的并发争用。
 */
const LOCK_STALE_MS = 2000;

/** 取锁重试次数，以及每次重试前的等待毫秒数（合计约 5 秒）。 */
const LOCK_RETRIES = 250;
const LOCK_RETRY_MS = 20;

const HELP = `JsLabyrinth 卡密计算工具

用法: node tools/issue/keygen.js [选项]

  -P, --plan <s>     套餐名 ${plan.PLAN_NAMES.join('|')}（默认 ${plan.DEFAULT_PLAN}）
  -d, --days <n>     有效天数（0 = 永久；默认 365）
  -c, --count <n>    生成数量（默认 1）
  -i, --id <n>       起始编号（默认取计数器文件中的下一个编号）
  -p, --prefix <s>   编号前缀文本（仅显示用）
  -b, --bind <mid>   绑定机器码（24 字符 base32），该卡只能在这台机器上激活。
                     省略则不绑定。机器码由用户从界面或 --machine 读出后报给
                     签发方；卡密里存的是它的摘要，看不出机器码本身
      --machine      打印本机机器码后退出（不签发），把结果发给签发方
      --date <d>     签发日 YYYY-MM-DD（默认今天 UTC）。**进签名载荷**，
                     到期时间由它 + 天数推出，所以补发历史卡要显式指定
      --issue-day <n> 签发日的原始天数形式（距 2020-01-01 UTC 的天数）
      --table        以对齐表格输出（默认逐行裸卡密，便于脚本处理）
      --csv          以 CSV 输出（code,plan,planName,days,issueDay,issuedAt,id）
      --ledger <f>   把本次签发的卡密追加进台账文件 f（CSV，首次自动写表头）
      --plans        打印套餐权益对照表
      --check <code> 校验一段卡密并打印其套餐/天数/编号/绑定状态
      --json         以 JSON 输出
  -h, --help         帮助

示例:
  node tools/issue/keygen.js --plan plus --days 30 --count 5
  node tools/issue/keygen.js --plan business --days 0    # 企业版永久卡
  node tools/issue/keygen.js --plan pro --count 100 --csv > batch.csv
  node tools/issue/keygen.js --plan team --days 365 --ledger issued.csv --count 10
  node tools/issue/keygen.js --plan pro --days 30 --date 2026-01-01   # 补发指定签发日
  node tools/issue/keygen.js --machine                   # 打印本机机器码
  node tools/issue/keygen.js --plan pro --days 365 --bind <对方报来的机器码>
  node tools/issue/keygen.js --plans
  node tools/issue/keygen.js --check <卡密>
`;

/**
 * 把当前毫秒时间戳折回编号段能表示的范围，作为计数器的起始值。
 *
 * 时间戳是 13 位（约 1.8e12），编号段只有 40 bit（上限约 1.1e12），直接拿来当
 * 起始编号必然越界。**这里绝不能报错退出**：计数器文件只在首次签发时不存在，
 * 而 --bind 之类的普通签名因此失败会让人以为是机器码有问题，实际是编号分配
 * 出了问题（错误信息还只说"编号区间超出编码上限"，指向完全错误的方向）。
 *
 * 取模到 [0, MAX_ID] 而不是从 0 或 1 起数，是为了延续原来的意图：起点仍带
 * 时间戳信息，不同批次不会轻易撞在一起。跨度 2^40 毫秒约 34.8 年，取模后的
 * 值一段 2^24 毫秒（约 4.7 小时）内才可能重复——而计数器文件一旦写出，
 * 后续编号就从文件里的值往后数，不再看时间戳；只有计数器被删且恰好在同一个
 * 4.7 小时窗口内才会撞上旧编号，且要两条都命中。
 *
 * @param {number} ms 毫秒时间戳
 * @returns {bigint} 合法的起始编号
 */
function timestampSeedId(ms) {
  return BigInt(ms) % (codec.MAX_ID + 1n);
}

/** 全角字符判定，用于按显示宽度对齐表格。 */
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

/**
 * 按显示宽度右补空格。中文字符占两列，直接用 padEnd 会让表头与数据行错位。
 * @param {string} s 文本
 * @param {number} width 目标显示宽度
 * @returns {string} 补足空格后的文本
 */
function padDisplay(s, width) {
  let w = 0;
  for (const ch of s) w += WIDE.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(0, width - w));
}

/** 打印套餐权益对照表。整表由 src/plans.js 生成，不会与套餐定义走散。 */
function printPlans() {
  console.log('套餐权益对照（定义见 src/plans.js）\n');
  const head = ['套餐', '字符', '族', '预设上限', '单文件', '每任务文件', '次数额度', '本档不含的开关'];
  const widths = [12, 6, 14, 10, 12, 14, 14, 0];
  console.log('  ' + head.map((h, i) => (i === widths.length - 1 ? h : padDisplay(h, widths[i]))).join(''));
  for (const r of plan.rows()) {
    const lim = r.limits;
    const cells = [
      r.display,
      String(plan.planCode(r.name)),
      r.kind === 'pack' ? '一次性额度包' : '订阅',
      r.preset,
      plan.humanBytes(lim.maxFileBytes) || '不限',
      lim.maxFilesPerRun > 0 ? String(lim.maxFilesPerRun) : '不限',
      r.quotaText,
      r.offOptions.length
        ? r.offOptions.map((k) => '--' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())).join(' ')
        : '—',
    ];
    console.log('  ' + cells.map((c, i) => (i === cells.length - 1 ? c : padDisplay(c, widths[i]))).join(''));
  }
  console.log('\n  预设上限: 该档默认使用的混淆强度，显式指定更高档预设会被拒绝');
  console.log('  单文件 0 / 每任务 0 均表示不限');
  console.log('  订阅档的额度按自然日重置；一次性额度包买断总额度，用完为止（到期时间仍是硬上限）');
  console.log('  额度写"联系作者"的档按合同谈，价目表上不给自助额度');
}

/** 解析整数选项；非法时打印错误并退出。 */
function intArg(name, raw, min) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    console.error(`选项 ${name} 需要 ≥ ${min} 的整数，收到 "${raw}"`);
    process.exit(1);
  }
  return n;
}

/**
 * 解析编号选项；非法时打印错误并退出。
 *
 * 只接受十进制文本，避免 Number 静默丢精度，"1e30"、小数、带符号写法一律拒绝。
 * 编号段压到 8 字符（40 bit）后 Number 其实够用，仍用 BigInt 承载是为了让
 * MAX_ID 的越界判定与 license-codec 的 toIdSegment 口径一致——两边都判一次
 * 才不会出现"能分配但编不进卡密"的编号。
 * @param {string} name 选项名，报错用
 * @param {string} raw 原始取值
 * @returns {bigint} 非负编号
 */
function bigIdArg(name, raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!/^[0-9]+$/.test(s)) {
    console.error(`选项 ${name} 需要非负十进制整数，收到 "${raw}"`);
    process.exit(1);
  }
  return BigInt(s);
}

/**
 * 读取计数器文件中记录的最后编号。
 * @returns {{ok:boolean, last?:bigint|null, message?:string}} 文件不存在时 last 为 null
 */
function readLastId() {
  let text;
  try {
    text = fs.readFileSync(STATE_PATH, 'utf8');
  } catch (e) {
    // 文件不存在是正常的首次签发路径；其余读取错误无法安全分配编号
    if (e.code === 'ENOENT') return { ok: true, last: null };
    return { ok: false, message: `无法读取编号计数器 ${STATE_PATH}: ${e.message}` };
  }
  try {
    const parsed = JSON.parse(text);
    const raw = String(parsed && parsed.last != null ? parsed.last : '').trim();
    return { ok: true, last: /^[0-9]+$/.test(raw) ? BigInt(raw) : null };
  } catch {
    // 内容损坏时按无计数器处理，起点退回当前时间戳，仍不会签出重复编号
    return { ok: true, last: null };
  }
}

/**
 * 写回计数器文件。
 * @param {bigint} last 已发出的最大编号
 * @returns {{ok:boolean, message?:string}} 是否写入成功
 */
function writeLastId(last) {
  const body = JSON.stringify({ last: last.toString() }, null, 2) + '\n';
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, body);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: `无法写入编号计数器 ${STATE_PATH}: ${e.message}` };
  }
}

/**
 * 取计数器锁，把读取、递增、写回三步串行化。
 *
 * 并发进程没有锁就会读到同一个基线，分到同一段编号，签出完全相同的卡密。
 * 持有者崩溃会遗留锁文件，超过 LOCK_STALE_MS 后由后续进程接管。
 * @returns {number|null} 锁文件描述符，重试用尽后返回 null
 */
function acquireLock() {
  for (let i = 0; i < LOCK_RETRIES; i++) {
    try {
      return fs.openSync(LOCK_PATH, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
    }
    try {
      // 持有者崩溃会留下锁文件，过期后接管
      if (Date.now() - fs.statSync(LOCK_PATH).mtimeMs > LOCK_STALE_MS) {
        fs.unlinkSync(LOCK_PATH);
        continue;
      }
    } catch {
      // 锁刚被持有者释放：立即重试即可拿到
    }
    const until = Date.now() + LOCK_RETRY_MS;
    while (Date.now() < until) { /* 等待持有者释放后重试 */ }
  }
  return null;
}

/**
 * 释放计数器锁。
 * @param {number|null} fd 锁文件描述符
 * @returns {void}
 */
function releaseLock(fd) {
  if (fd === null) return;
  try { fs.closeSync(fd); } catch { /* 描述符已关闭 */ }
  try { fs.unlinkSync(LOCK_PATH); } catch { /* 锁文件已被清理 */ }
}

/**
 * 在计数器锁内分配本次签发的编号区间，并把计数器推进到区间末尾。
 * @param {number} count 本次签发数量
 * @param {bigint|null} explicit 显式指定的起始编号；null 表示由计数器分配
 * @returns {{ok:boolean, id?:bigint, lastId?:bigint, message?:string}} 分配结果
 */
function allocateId(count, explicit) {
  const lock = acquireLock();
  if (lock === null) {
    return { ok: false, message: `编号计数器被占用或不可写（${LOCK_PATH}），请稍后重试或改用 --id 显式指定编号` };
  }
  try {
    const read = readLastId();
    if (!read.ok) return { ok: false, message: read.message };
    const stored = read.last;

    let id = explicit;
    if (id === null) {
      id = stored === null ? timestampSeedId(Date.now()) : stored + 1n;
    } else if (stored !== null && id <= stored) {
      console.error(`警告: 编号 ${id} 不大于计数器中的最后编号 ${stored}，可能重号`);
    }

    const lastId = id + BigInt(count - 1);
    if (lastId > codec.MAX_ID) {
      // 自动分配时起点就是计数器里的值加一，"溢出"意味着这个计数器用完了整段
      // 编号空间（40 bit / 2^40 个）。只有 --id 显式指定才可能是调用方给大了，
      // 两种情形给的建议不一样，混在一起说会把人引向错误的方向。
      const next = stored === null ? 0n : stored + 1n;
      return {
        ok: false,
        message: explicit === null
          ? `编号区间超出编码上限（${codec.ID_LEN} 字符 base32，上限 ${codec.MAX_ID}）：`
            + `计数器已用到 ${next}，再加 ${count} 张就放不下了。`
            + `请删除或改名 ${STATE_PATH} 让编号从新的时间戳起点重新分配`
            + `（旧编号不会因此失效），或用 --id 显式指定一段更大的区间。`
          : `编号区间超出编码上限（${codec.ID_LEN} 字符 base32，上限 ${codec.MAX_ID}）：`
            + `--id ${explicit} 加 ${count} 张后的末尾编号 ${lastId} 超界。`
            + `请把 --id 调到 ${codec.MAX_ID - BigInt(count - 1)} 以内（配合 --count ${count}）。`,
      };
    }

    // 先把计数器推进到本次用掉的编号，再打印卡密，写盘失败时不发出无法
    // 续接的编号。显式 --id 时只告警不中止，编号唯一性由调用方负责。
    const nextLast = stored !== null && stored > lastId ? stored : lastId;
    const written = writeLastId(nextLast);
    if (!written.ok && explicit === null) {
      return { ok: false, message: `${written.message}；已中止签发，可改用 --id 显式指定编号` };
    }
    return { ok: true, id, lastId };
  } finally {
    releaseLock(lock);
  }
}

/**
 * 解析套餐名；大小写不敏感，未知套餐时列出可选值并退出。
 * @param {string} name 选项名，报错用
 * @param {string} raw 原始取值
 * @returns {string} 套餐名
 */
function planArg(name, raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!plan.isPlan(s)) {
    console.error(`选项 ${name} 需要套餐名 ${plan.PLAN_NAMES.join(' | ')}，收到 "${raw}"`);
    process.exit(1);
  }
  return s;
}

/** 签发日段能表示的最大天数（3 个 base32 字符 = 15 bit）。 */
const MAX_ISSUE_DAY = (1 << 15) - 1;

/**
 * 把 YYYY-MM-DD 转成签发日的天数形式（距 codec.DAY_ZERO）。
 *
 * 签发日进卡密签名载荷，到期时间由它推出，所以补发历史卡必须显式指定日期，
 * 否则会按今天算。只接受 UTC 日期，不接受时间部分——签名载荷里存的是"天"。
 *
 * @param {string} raw 日期文本
 * @returns {number} 距 2020-01-01 UTC 的天数
 */
function dayFromDate(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) {
    console.error(`选项 --date 需要 YYYY-MM-DD 形式，收到 "${raw}"`);
    process.exit(1);
  }
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(ms)) {
    console.error(`无法解析日期 "${raw}"`);
    process.exit(1);
  }
  const day = Math.floor((ms - codec.DAY_ZERO) / 86400000);
  if (day < 0) {
    console.error(`签发日不能早于 2020-01-01（签发日段的零点），收到 "${raw}"`);
    process.exit(1);
  }
  return day;
}

/** 天数转回 YYYY-MM-DD，用于输出与台账。 */
function dateFromDay(day) {
  return new Date(codec.DAY_ZERO + day * 86400000).toISOString().slice(0, 10);
}

/**
 * 本机机器码，24 字符 base32。
 *
 * 算法必须与 host/license-node.js 的 machineId() 逐字段一致，否则 --machine
 * 打出来的码签成卡后在本机激活会失败。这里刻意**不 import license-node.js**
 * ——那个模块带了反调试探针与陷阱逻辑，一加载就会检测调试器、跑自校验，签发
 * 工具不该被这些副作用牵连。代价是同一套指纹逻辑有两份实现，改动时必须同步。
 *
 * @returns {string} 机器码
 */
function localMachineId() {
  const norm = (s) => String(s || '').trim().toLowerCase();
  const macs = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      const m = String(ni.mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
      if (m.length !== 12 || m === '000000000000') continue;
      macs.push(m);
    }
  }
  macs.sort();
  const parts = [
    'JSLB-MACHINE-1',
    norm(os.platform()),
    norm(os.arch()),
    norm(os.hostname()),
    norm(os.userInfo().username),
    norm(os.cpus()[0] && os.cpus()[0].model),
    macs.join(','),
  ].join('|');
  const raw = crypto.scryptSync(parts, b64ToText(B64_MACHINE_SALT), 32, { N: 16384, r: 8, p: 1 });
  return codec.digestToB32(raw.toString('hex'), 24);
}

/**
 * 归一化并校验 --bind 的机器码。
 *
 * 卡密里的绑定段是机器码的派生摘要，所以这里只接受机器码本身；长度或字符集
 * 不对就直接报错退出，免得把一段摘要当成机器码再摘要一次，签出一张谁也激活
 * 不了的卡。
 *
 * 注意这里只查**格式**，查不出"这段文字到底是不是机器码"——摘要不可逆，签发
 * 方没有反推手段。能拦下的只有长度或字符集不对的输入（例如手抄时混进了分隔
 * 符、少了几位）。机器码与绑定段都可能恰好是 24 个合法 base32 字符，格式校验
 * 分不出来，所以**把绑定段当机器码喂进来不会被拦**，只会摘两次摘要。要核对
 * 就重新跑一次 --machine，与对方报来的那串逐字符比。
 *
 * @param {string} raw 机器码文本
 * @returns {string} 归一化的机器码
 */
function bindArg(raw) {
  const s = String(raw == null ? '' : raw).trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (s.length !== 24 || !codec.isB32Text(s)) {
    console.error(`选项 --bind 需要 24 个 Crockford base32 字符的机器码，收到 "${raw}"`);
    console.error('用 node tools/issue/keygen.js --machine 可打印本机机器码；');
    console.error('用户的机器码从界面「机器码」一栏读取，或让用户运行同一命令。');
    process.exit(1);
  }
  return s;
}

/**
 * CSV 单元格转义：含逗号、引号、换行或首尾空格时用双引号包裹，内部引号翻倍。
 * 卡密本身只含 [0-9A-Z-]，不会触发，但套餐显示名与台账路径可能。
 */
function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]|^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** 台账表头，列顺序与 --csv 一致，末尾多一列签发时刻。 */
const LEDGER_HEADER = 'code,plan,planName,days,issueDay,issuedAt,id,bind';

/**
 * 把本次签发的卡密追加进台账（CSV）。文件不存在时先写表头。
 *
 * 用 appendFileSync 单行追加：一行远小于 PIPE_BUF，POSIX 下 O_APPEND 写是原子的。
 * 多终端并发发卡时仍建议各自用不同台账文件（编号计数器同理，见 acquireLock）。
 *
 * @param {string} file 台账路径
 * @param {object[]} rows 待写入的行
 * @returns {void} 写失败时打印错误并退出
 */
function appendLedger(file, rows) {
  const abs = path.resolve(ROOT, file);
  try {
    const fresh = !fs.existsSync(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const lines = rows.map((r) => [
      csvCell(r.code), csvCell(r.plan), csvCell(plan.displayName(r.plan)),
      csvCell(r.days), csvCell(r.issueDay), csvCell(r.issuedAt), csvCell(r.id),
      csvCell(r.bind || ''),
    ].join(','));
    const body = (fresh ? LEDGER_HEADER + '\n' : '') + lines.join('\n') + '\n';
    fs.appendFileSync(abs, body);
    console.error(`台账已追加 ${rows.length} 行: ${abs}`);
  } catch (e) {
    console.error(`台账写入失败（${abs}）: ${e && e.message}`);
    process.exit(1);
  }
}

/** 按显示宽度对齐的表格输出。 */
function printTable(rows) {
  const head = ['卡密', '套餐', '天数', '签发日', '编号', '绑定'];
  const cells = rows.map((r) => [
    r.code, plan.displayName(r.plan),
    r.days === 0 ? '永久' : r.days + ' 天',
    dateFromDay(r.issueDay), r.id,
    r.bind ? r.bind : '不绑定',
  ]);
  const widths = head.map((h, i) => Math.max(
    ...[h, ...cells.map((c) => c[i])].map((s) => {
      let w = 0;
      for (const ch of s) w += WIDE.test(ch) ? 2 : 1;
      return w;
    }),
  ));
  const line = (cols) => '  ' + cols.map((c, i) => (i === cols.length - 1 ? c : padDisplay(c, widths[i] + 2))).join('');
  console.log(line(head));
  console.log('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
  for (const c of cells) console.log(line(c));
}

function main(argv) {
  let planName = plan.DEFAULT_PLAN;
  let days = 365;
  let count = 1;
  let id = null; // 未显式指定编号时保持 null，由计数器分配
  let prefix = '';
  let asJson = false;
  let asCsv = false;
  let asTable = false;
  let ledgerPath = null;
  let issueDay = null;
  let check = null;
  let bind = null;
  let showMachine = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-h': case '--help': console.log(HELP); return;
      case '-P': case '--plan': planName = planArg(a, next()); break;
      case '--plans': printPlans(); return;
      case '--machine': showMachine = true; break;
      case '-d': case '--days': days = intArg(a, next(), 0); break;
      case '-c': case '--count': count = intArg(a, next(), 1); break;
      case '-i': case '--id': id = bigIdArg(a, next()); break;
      case '-b': case '--bind': bind = bindArg(next()); break;
      case '-p': case '--prefix': prefix = String(next() || ''); break;
      case '--date': issueDay = dayFromDate(next()); break;
      case '--issue-day': issueDay = intArg(a, next(), 0); break;
      case '--table': asTable = true; break;
      case '--csv': asCsv = true; break;
      case '--ledger': ledgerPath = String(next() || ''); break;
      case '--check': check = next(); break;
      case '--json': asJson = true; break;
      default:
        console.error(`未知选项 "${a}"（用 --help 查看用法）`);
        process.exit(1);
    }
  }

  // 只打印本机机器码，不签发。不需要私钥，因此放在私钥检查之前。
  if (showMachine) {
    const mid = localMachineId();
    if (asJson) console.log(JSON.stringify({ machine: mid }));
    else {
      console.log(mid);
      console.error('把上面这串机器码发给签发方，用 --bind <机器码> 签出的卡密只能在本机激活。');
    }
    return;
  }

  if (issueDay !== null && issueDay > MAX_ISSUE_DAY) {
    console.error(`签发日超出编码上限（距 2020-01-01 最多 ${MAX_ISSUE_DAY} 天，约到 2109 年）`);
    process.exit(1);
  }

  if (check !== null) {
    const res = codec.parseCode(B64_PUBLIC_KEY, check);
    if (!res.ok) {
      if (asJson) console.log(JSON.stringify({ valid: false, reason: res.reason }));
      else console.error(`卡密无效（原因: ${res.reason}）`);
      process.exit(1);
    }
    const info = {
      valid: true,
      code: res.code,
      plan: res.plan,
      planName: plan.displayName(res.plan),
      id: res.id,
      days: res.days,
      perpetual: res.days === 0,
      bound: res.bound,
      // 绑定段是摘要，本身不可逆；给出它只为核对"两张卡绑的是不是同一台机器"
      bindSeg: res.bound ? res.bindSeg : '',
      issueDay: res.issueDay,
    };
    if (asJson) console.log(JSON.stringify(info));
    else {
      console.log(`卡密有效: ${res.code}`);
      console.log(`  套餐: ${plan.displayName(res.plan)}（预设上限 ${plan.presetCeiling(res.plan)}）`);
      console.log(`  编号: ${res.id}`);
      console.log(`  有效期: ${res.days === 0 ? '永久' : res.days + ' 天'}`);
      console.log(`  签发日: ${dateFromDay(res.issueDay)}`);
      console.log(`  绑定: ${res.bound ? '已绑定机器 ' + res.bindSeg : '不绑定（任何机器可激活）'}`);
    }
    return;
  }

  if (days > 1023) {
    console.error('有效天数超出编码上限（0~1023 天；0 表示永久）');
    process.exit(1);
  }

  // 签发必须有私钥。这里明确报错而不是让 issueCode 返回 null——后者会表现为
  // "编号无法编码"，让人以为是编号出了问题，实际是缺密钥。
  if (!SIGNING_OK) {
    console.error([
      '缺少签发私钥，无法签发卡密。',
      '',
      '卡密用 Ed25519 签名，私钥只在签发方持有，不随源码分发。设置方式二选一：',
      '',
      '  1) 环境变量（推荐，生产环境用这个）：',
      '       JSLB_SIGNING_KEY=<base64 私钥种子> node tools/issue/keygen.js --plan pro --days 365',
      '  2) 项目根的 .jslb-signing-key 文件（已在 .gitignore 里），内容是一行 base64。',
      '',
      '没有私钥时仍可校验卡密：node tools/issue/keygen.js --check <卡密>',
      '重新生成密钥对：node tools/issue/keyrotate.js --write',
    ].join('\n'));
    process.exit(1);
  }

  const allocated = allocateId(count, id);
  if (!allocated.ok) {
    console.error(allocated.message);
    process.exit(1);
  }
  const startId = allocated.id;
  const lastId = allocated.lastId;

  // 签发日进签名载荷。省略时由 issueCode 取当天 UTC，这里显式算一次是为了
  // 让同一批卡密共用同一个日期——跨零点签发时逐张取当天会让同批卡分成两天。
  const day = issueDay === null ? Math.floor((Date.now() - codec.DAY_ZERO) / 86400000) : issueDay;
  const issuedAt = new Date().toISOString();

  const issued = [];
  for (let k = 0; k < count; k++) {
    const cur = startId + BigInt(k);
    const code = codec.issueCode(SIGNING_KEY, planName, days, cur, day, bind);
    if (!code) {
      console.error(`编号 ${cur} 无法编码`);
      process.exit(1);
    }
    issued.push({
      code, plan: planName, id: cur.toString(), days, issueDay: day, issuedAt,
      perpetual: days === 0, bind: bind || '',
    });
  }

  if (ledgerPath) appendLedger(ledgerPath, issued);

  if (asJson) {
    console.log(JSON.stringify(issued.length === 1 ? issued[0] : issued, null, 2));
    return;
  }
  if (asCsv) {
    console.log(LEDGER_HEADER);
    for (const it of issued) {
      console.log([
        csvCell(it.code), csvCell(it.plan), csvCell(plan.displayName(it.plan)),
        csvCell(it.days), csvCell(it.issueDay), csvCell(it.issuedAt), csvCell(it.id),
        csvCell(it.bind),
      ].join(','));
    }
    return;
  }
  if (asTable) {
    printTable(issued);
    console.error(`已签发 ${issued.length} 段卡密（套餐 ${plan.displayName(planName)}，`
      + `有效期 ${days === 0 ? '永久' : days + ' 天'}，签发日 ${dateFromDay(day)}，`
      + `编号 ${startId}~${lastId}，绑定 ${bind ? bind : '不绑定'}）`);
    return;
  }
  for (const it of issued) {
    console.log(prefix ? `${prefix}\t${it.code}` : it.code);
  }
  const label = days === 0 ? '永久' : days + ' 天';
  console.error(`已签发 ${issued.length} 段卡密（套餐 ${plan.displayName(planName)}，有效期 ${label}，`
    + `编号 ${startId}~${lastId}，绑定 ${bind ? bind : '不绑定'}）`);
}

main(process.argv.slice(2));
