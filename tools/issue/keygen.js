#!/usr/bin/env node
'use strict';
/**
 * 卡密计算工具。发卡方使用，不随最终用户分发。
 *
 * 用法:
 *   node tools/issue/keygen.js [选项]
 *
 * 选项:
 *   -P, --plan <s>     套餐名（订阅档 free|plus|team|business，一次性额度包
 *                      pack100|pack1000|pack10000|packCustom），默认 free（最低档）
 *   -d, --days <n>     有效天数，0 表示永久，默认 365
 *   -c, --count <n>    生成数量，默认 1
 *   -i, --id <n>       显式指定起始编号（十进制）；省略时每张卡随机取编号
 *   -p, --prefix <s>   编号前缀文本，仅显示用
 *   --machine          打印本机机器码后退出（仅供开发调试；线上"一卡一机"由
 *                      服务端赎回登记实现，卡密不再绑定机器）
 *   --plans            打印套餐权益对照表，不签发
 *   --check <code>     只校验一段卡密，不签发
 *   --json             以 JSON 输出
 *   -h, --help         帮助
 *
 * 卡密格式 v5: JSLB-<编号段8>-<信息段16>-<校验码4>
 *   例: node tools/issue/keygen.js --plan plus --days 30 --count 3
 *
 * 编号段 8 个 Crockford base32 字符（40 bit，约 1.1 万亿），**随机生成**：它同时
 * 是服务端赎回登记的分键（"一卡一机"按编号登记），随机性保证多批发卡不撞号。
 * 需要可复现的编号时用 --id 显式指定。
 *
 * 信息段 16 个字符（80 bit）＝ 30 bit 明文（套餐 5 + 天数 10 + 签发日 15）加
 * 50 bit 随机 IV，用 HMAC 派生的密钥流异或加密。同一组参数两次签发会得到两段
 * 不同的卡密，但都能被同一把密钥解析。
 *
 * 校验码 4 个字符（20 bit）＝ 截断的 HMAC(密钥, 'JSLB5/CRC|编号段|信息段')。
 * 编号段与信息段的任何一位被改都会校验失败。
 *
 * **v5 起卡密不再绑定机器**（v4 的 --bind 与绑定段已废除）："一卡一次"由服务端
 * 的赎回登记实现——每张卡第一次激活时把卡密原文 + 赎回者机器码 + 时间戳登记进
 * KV，之后再输入同一卡密（无论是否本机）都会被拒绝（reason=used）。解绑需发卡
 * 方删除 KV 里的 jslb:redeem:<卡号> 键。见 src/license-web.js 的 activate()。
 *
 * 签发与校验用同一把对称密钥（src/license-secret.js 的 B64_CODE_KEY）。它随
 * 源码分发——拿到源码的人能自己签发，真正的强制在服务端（/api/obfuscate 逐请求
 * 校验 + 云存储赎回登记）。部署方可用环境变量 JSLB_CODE_KEY 覆盖。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import secret from '../../src/license-secret.js';
import codec from '../../src/license-codec.js';
import plan from '../../src/plan.js';

const { B64_CODE_KEY } = secret;

/**
 * 签发密钥（base64，32 字节）。**它等于发卡权**：拿到它就能签出任意套餐、
 * 任意有效期的卡密。
 *
 * 优先读环境变量，其次读项目根的 .jslb-code-key（该文件在 .gitignore 里）。
 * 注意对称密钥的固有局限：浏览器端验卡也需要它（随静态资源分发），所以它
 * 不构成"爬走源码也签不出卡"的边界——那由服务端赎回登记与门控承担。
 *
 *   JSLB_CODE_KEY=<base64> node tools/issue/keygen.js --plan plus --days 365
 */
const CODE_KEY = (() => {
  const fromEnv = process.env.JSLB_CODE_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const keyPath = process.env.JSLABYRINTH_CODE_KEY_FILE || null;
  const candidates = keyPath
    ? [keyPath]
    : [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.jslb-code-key')];
  for (const p of candidates) {
    try {
      const text = fs.readFileSync(p, 'utf8').trim();
      if (text) return text;
    } catch (e) { /* 文件不存在就继续找下一个 */ }
  }
  // 都没有时回退到内置密钥：内置密钥部署下签发与 --check 同源，开箱即用。
  return B64_CODE_KEY;
})();

/** 密钥是否可用。缺失时不能签发，只能校验（校验用内置 B64_CODE_KEY 即可）。 */
const KEY_OK = (() => {
  if (!CODE_KEY) return false;
  try {
    const b = Buffer.from(CODE_KEY, 'base64');
    return b.length === 32;
  } catch (e) {
    return false;
  }
})();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const HELP = `JsLabyrinth 卡密计算工具（v5）

用法: node tools/issue/keygen.js [选项]

  -P, --plan <s>     套餐名 ${plan.PLAN_NAMES.join('|')}（默认 ${plan.DEFAULT_PLAN}）
  -d, --days <n>     有效天数（0 = 永久；默认 365）
  -c, --count <n>    生成数量（默认 1）
  -i, --id <n>       显式指定起始编号（十进制；省略时每张卡随机取编号）
  -p, --prefix <s>   编号前缀文本（仅显示用）
      --machine      打印本机机器码后退出（不签发）
      --date <d>     签发日 YYYY-MM-DD（默认今天 UTC）。**进加密载荷**，
                     到期时间由它 + 天数推出，所以补发历史卡要显式指定
      --issue-day <n> 签发日的原始天数形式（距 2020-01-01 UTC 的天数）
      --table        以对齐表格输出（默认逐行裸卡密，便于脚本处理）
      --csv          以 CSV 输出（code,plan,planName,days,issueDay,issuedAt,id）
      --ledger <f>   把本次签发的卡密追加进台账文件 f（CSV，首次自动写表头）
      --plans        打印套餐权益对照表
      --check <code> 校验一段卡密并打印其套餐/天数/编号
      --json         以 JSON 输出
  -h, --help         帮助

示例:
  node tools/issue/keygen.js --plan plus --days 30 --count 5
  node tools/issue/keygen.js --plan business --days 0    # 企业版永久卡
  node tools/issue/keygen.js --plan plus --count 100 --csv > batch.csv
  node tools/issue/keygen.js --plan team --days 365 --ledger issued.csv --count 10
  node tools/issue/keygen.js --plan plus --days 30 --date 2026-01-01   # 补发指定签发日
  node tools/issue/keygen.js --machine                   # 打印本机机器码（调试用）
  node tools/issue/keygen.js --plans
  node tools/issue/keygen.js --check <卡密>

说明:
  v5 起卡密不再绑定机器（--bind 已废除）。每张卡的编号随机生成；"一卡一机"
  由服务端在首次激活时登记赎回者机器码实现，第二台机器再用同一卡密会被拒。
`;

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
 * 用 BigInt 承载是为了让 MAX_ID 的越界判定与 license-codec 的 toIdSegment 口径
 * 一致——两边都判一次才不会出现"能分配但编不进卡密"的编号。
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
 * 随机取一个 40 bit 编号。
 *
 * 编号段空间约 1.1 万亿：批内连号已无意义（v4 时代递增编号是为了跨进程唯一，
 * v5 改为随机 + 大空间，百万张以内的碰撞概率可忽略），批量签发时仍做批内
 * 去重。randomBytes 是 CSPRNG——绝不能用项目里的 PRNG，那是可复现的伪随机。
 * @returns {bigint} [0, 2^40) 内的随机编号
 */
function randomId() {
  const b = crypto.randomBytes(5);
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v & codec.MAX_ID;
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

/** 签发日段能表示的最大天数（15 bit）。 */
const MAX_ISSUE_DAY = (1 << 15) - 1;

/**
 * 把 YYYY-MM-DD 转成签发日的天数形式（距 codec.DAY_ZERO）。
 *
 * 签发日在加密载荷里，到期时间由它推出，所以补发历史卡必须显式指定日期，
 * 否则会按今天算。只接受 UTC 日期，不接受时间部分——载荷里存的是"天"。
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
    console.error(`签发日不能早于 2020-01-01（签发日的零点），收到 "${raw}"`);
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
 * 供 `--machine` 打印当前机器的码。**v5 卡密不再绑定机器**，这个码仅供开发
 * 调试与对照（网页侧 src/license-web.js 用浏览器指纹派生同一形制的码）。
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
  const raw = crypto.scryptSync(parts, Buffer.from(secret.B64_MACHINE_SALT, 'base64').toString('utf8'), 32, { N: 16384, r: 8, p: 1 });
  return codec.digestToB32(raw.toString('hex'), 24);
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
const LEDGER_HEADER = 'code,plan,planName,days,issueDay,issuedAt,id';

/**
 * 把本次签发的卡密追加进台账（CSV）。文件不存在时先写表头。
 *
 * 用 appendFileSync 单行追加：一行远小于 PIPE_BUF，POSIX 下 O_APPEND 写是原子的。
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
  const head = ['卡密', '套餐', '天数', '签发日', '编号'];
  const cells = rows.map((r) => [
    r.code, plan.displayName(r.plan),
    r.days === 0 ? '永久' : r.days + ' 天',
    dateFromDay(r.issueDay), r.id,
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
  let id = null; // 未显式指定编号时保持 null，每张卡随机取
  let prefix = '';
  let asJson = false;
  let asCsv = false;
  let asTable = false;
  let ledgerPath = null;
  let issueDay = null;
  let check = null;
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
      case '-b': case '--bind':
        console.error('v5 起卡密不再绑定机器，--bind 已废除。');
        console.error('"一卡一次"由服务端在首次激活时登记（卡密 + 机器码 + 时间戳）实现：');
        console.error('直接签发不绑定卡即可，同一卡密再次使用会被拒绝（reason=used），');
        console.error('换机或误清数据需删除 KV 里的 jslb:redeem:<卡号> 键解绑。');
        process.exit(1);
        break;
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

  // 只打印本机机器码，不签发。不需要密钥，因此放在密钥检查之前。
  if (showMachine) {
    const mid = localMachineId();
    if (asJson) console.log(JSON.stringify({ machine: mid }));
    else {
      console.log(mid);
      console.error('机器码仅供开发调试；v5 卡密不绑定机器，"一卡一机"由服务端赎回登记实现。');
    }
    return;
  }

  if (issueDay !== null && issueDay > MAX_ISSUE_DAY) {
    console.error(`签发日超出编码上限（距 2020-01-01 最多 ${MAX_ISSUE_DAY} 天，约到 2109 年）`);
    process.exit(1);
  }

  if (check !== null) {
    const res = codec.parseCode(B64_CODE_KEY, check);
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
      issueDay: res.issueDay,
    };
    if (asJson) console.log(JSON.stringify(info));
    else {
      console.log(`卡密有效: ${res.code}`);
      console.log(`  套餐: ${plan.displayName(res.plan)}（预设上限 ${plan.presetCeiling(res.plan)}）`);
      console.log(`  编号: ${res.id}`);
      console.log(`  有效期: ${res.days === 0 ? '永久' : res.days + ' 天'}`);
      console.log(`  签发日: ${dateFromDay(res.issueDay)}`);
      console.log('  绑定: 不绑定（v5 一卡一机由服务端赎回登记实现）');
    }
    return;
  }

  if (days > 1023) {
    console.error('有效天数超出编码上限（0~1023 天；0 表示永久）');
    process.exit(1);
  }

  // 签发必须有密钥。这里明确报错而不是让 issueCode 返回 null——后者会表现为
  // "签不出卡密"但不给原因，让人无从排查。
  if (!KEY_OK) {
    console.error([
      '缺少签发密钥，无法签发卡密。',
      '',
      '卡密的加密与校验码用同一把对称密钥（32 字节 base64）。设置方式二选一：',
      '',
      '  1) 环境变量（推荐）：',
      '       JSLB_CODE_KEY=<base64 密钥> node tools/issue/keygen.js --plan plus --days 365',
      '  2) 项目根的 .jslb-code-key 文件（已在 .gitignore 里），内容是一行 base64。',
      '',
      '  生成新密钥：node tools/issue/keyrotate.js --write',
      '没有密钥时仍可校验卡密：node tools/issue/keygen.js --check <卡密>',
    ].join('\n'));
    process.exit(1);
  }

  // 显式 --id 时越界必须在这里报错并点出 --id：如果漏到 issueCode 返回 null，
  // 表现只是"编号无法编码"，会让人误以为密钥或套餐出了问题。
  if (id !== null && id + BigInt(count - 1) > codec.MAX_ID) {
    console.error('选项 --id ' + id + ' 加 ' + count + ' 张后的末尾编号 '
      + (id + BigInt(count - 1)) + ' 超出编号上限（' + codec.ID_LEN + ' 字符 base32，上限 ' + codec.MAX_ID + '）。');
    console.error('请把 --id 调到 ' + (codec.MAX_ID - BigInt(count - 1)) + ' 以内（配合 --count ' + count + '）。');
    process.exit(1);
  }

  // 签发日在加密载荷。省略时由 issueCode 取当天 UTC，这里显式算一次是为了
  // 让同一批卡密共用同一个日期——跨零点签发时逐张取当天会让同批卡分成两天。
  const day = issueDay === null ? Math.floor((Date.now() - codec.DAY_ZERO) / 86400000) : issueDay;
  const issuedAt = new Date().toISOString();

  const issued = [];
  const seen = new Set();
  for (let k = 0; k < count; k++) {
    // 编号：显式 --id 时按区间顺延；否则逐张随机（批内去重，防极端撞号）
    const cur = id !== null
      ? id + BigInt(k)
      : (() => {
        let v = randomId();
        while (seen.has(v.toString())) v = randomId();
        seen.add(v.toString());
        return v;
      })();
    const code = codec.issueCode(CODE_KEY, planName, days, cur, day);
    if (!code) {
      console.error(`编号 ${cur} 无法编码`);
      process.exit(1);
    }
    issued.push({
      code, plan: planName, id: cur.toString(), days, issueDay: day, issuedAt,
      perpetual: days === 0,
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
      ].join(','));
    }
    return;
  }
  if (asTable) {
    printTable(issued);
    console.error(`已签发 ${issued.length} 段卡密（套餐 ${plan.displayName(planName)}，`
      + `有效期 ${days === 0 ? '永久' : days + ' 天'}，签发日 ${dateFromDay(day)}，编号随机）`);
    return;
  }
  for (const it of issued) {
    console.log(prefix ? `${prefix}\t${it.code}` : it.code);
  }
  const label = days === 0 ? '永久' : days + ' 天';
  console.error(`已签发 ${issued.length} 段卡密（套餐 ${plan.displayName(planName)}，有效期 ${label}，`
    + `签发日 ${dateFromDay(day)}，编号随机、一卡一机由服务端赎回登记实现）`);
}

main(process.argv.slice(2));
