// 自混淆运行期预算基准。
//
// 为什么单独一个脚本：build-web.js 的 selfObfOptions 要按「运行期不超过多少倍」这个
// 预算挑 pass，而 pass 之间的运行期代价差好几个数量级——对象键编码把每次属性访问变成
// 分段解密，字符串池把每次取字符串变成解密加校验，而控制流平坦化只是多一层 switch
// 分派。凭直觉挑必错，所以这里实跑：
//
//   1) 把 src/** 用「基线 + 某个候选 pass」混淆一遍，写进 _selfobf-bench/<名>/src/**
//   2) 载入这份混淆后的核心，和原核心跑同一个混淆任务
//   3) 输出实测倍率（中位数，先热身一轮排掉 JIT 影响）
//
//   node tools/build/bench-selfobf.js                 # 跑默认候选阶梯
//   node tools/build/bench-selfobf.js --runs 7        # 每用例重复次数（默认 5）
//   node tools/build/bench-selfobf.js --job medium    # 被混淆任务的预设（默认 low）
//   node tools/build/bench-selfobf.js --only stringArray,controlFlowFlattening
//
// 产物目录 _selfobf-bench/ 在 .gitignore 里：它只是量的过程，不是发布产物。
// 同一份源码 + 固定 seed ⇒ 结果可复现、可跨版本对比。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, '_selfobf-bench');
const SEED = 20260920;
const ENT = { plan: 'business', preset: 'max', gates: {}, limits: {} };

const argv = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const RUNS = Math.max(1, Number(argVal('runs', 5)));
const JOB_PRESET = argVal('job', 'low');
const ONLY = argVal('only', '').split(',').map((s) => s.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// 候选阶梯
//
// 基线 = build-web.js 当前的配置（关掉全部运行期昂贵 pass）。每一条候选只加一项，
// 这样量出来的差值就是该项**独立**的运行期代价；组合项用于验证代价是否叠加。
// ---------------------------------------------------------------------------

const BASELINE = {
  preset: 'low',
  objectKeyEncoding: false,
  stringArray: false,
  controlFlowFlattening: false,
  opaquePredicates: false,
  deadCodeInjection: false,
  logicalExpressions: false,
  conditionObfuscation: false,
};

const CANDIDATES = [
  { id: 'baseline', name: '基线（现行配置）', add: {} },
  { id: 'controlFlowFlattening', name: '+ 控制流平坦化', add: { controlFlowFlattening: true } },
  { id: 'deadCodeInjection', name: '+ 死代码注入', add: { deadCodeInjection: true } },
  { id: 'opaquePredicates', name: '+ 不透明谓词', add: { opaquePredicates: true } },
  { id: 'logicalExpressions', name: '+ 逻辑表达式', add: { logicalExpressions: true } },
  { id: 'conditionObfuscation', name: '+ 条件混淆', add: { conditionObfuscation: true } },
  { id: 'numberObfuscation', name: '+ 数字混淆', add: { numberObfuscation: true, numberObfuscationThreshold: 0.5 } },
  { id: 'stringArray', name: '+ 字符串池', add: { stringArray: true } },
  { id: 'stringArrayLow', name: '+ 字符串池(阈值 0.3/base64)', add: { stringArray: true, stringArrayThreshold: 0.3, stringArrayEncoding: 'base64' } },
  { id: 'objectKeyEncoding', name: '+ 对象键编码', add: { objectKeyEncoding: true } },
  { id: 'cheap4', name: '便宜四项（控制流+死码+谓词+逻辑）', add: { controlFlowFlattening: true, deadCodeInjection: true, opaquePredicates: true, logicalExpressions: true } },
  { id: 'cheap5', name: '便宜五项（+条件）', add: { controlFlowFlattening: true, deadCodeInjection: true, opaquePredicates: true, logicalExpressions: true, conditionObfuscation: true } },
  { id: 'cheap5_stringLow', name: '便宜五项 + 字符串池(阈值 0.3)', add: { controlFlowFlattening: true, deadCodeInjection: true, opaquePredicates: true, logicalExpressions: true, conditionObfuscation: true, stringArray: true, stringArrayThreshold: 0.3, stringArrayEncoding: 'base64' } },

  // 第二轮：第一轮实测把真实代价结构量清楚了——
  //   对象键编码 21.4×、字符串池 2.6×、**不透明谓词 2.99×**（这条不在旧文档的
  //   昂贵名单里，是旧文档指错方向的地方）、数字混淆 1.11×，
  //   控制流/死码/逻辑/条件几乎免费（各 1.02~1.04×）。
  // 于是第二轮改为「去掉谓词 + 逐步降低字符串池阈值」，找 ≤1.5× 的最强组合。
  { id: 'core4', name: '免费四项（控制流+死码+逻辑+条件）', add: { controlFlowFlattening: true, deadCodeInjection: true, logicalExpressions: true, conditionObfuscation: true } },
  { id: 'core4_num', name: '免费四项 + 数字混淆', add: { controlFlowFlattening: true, deadCodeInjection: true, logicalExpressions: true, conditionObfuscation: true, numberObfuscation: true, numberObfuscationThreshold: 0.5 } },
  { id: 'sa10', name: '仅字符串池(阈值 0.10)', add: { stringArray: true, stringArrayThreshold: 0.1, stringArrayEncoding: 'base64' } },
  { id: 'sa15', name: '仅字符串池(阈值 0.15)', add: { stringArray: true, stringArrayThreshold: 0.15, stringArrayEncoding: 'base64' } },
  { id: 'core4_num_sa10', name: '免费四项+数字+字符串池(0.10)', add: { controlFlowFlattening: true, deadCodeInjection: true, logicalExpressions: true, conditionObfuscation: true, numberObfuscation: true, numberObfuscationThreshold: 0.5, stringArray: true, stringArrayThreshold: 0.1, stringArrayEncoding: 'base64' } },
  { id: 'core4_num_sa15', name: '免费四项+数字+字符串池(0.15)', add: { controlFlowFlattening: true, deadCodeInjection: true, logicalExpressions: true, conditionObfuscation: true, numberObfuscation: true, numberObfuscationThreshold: 0.5, stringArray: true, stringArrayThreshold: 0.15, stringArrayEncoding: 'base64' } },
  { id: 'core4_num_sa20', name: '免费四项+数字+字符串池(0.20)', add: { controlFlowFlattening: true, deadCodeInjection: true, logicalExpressions: true, conditionObfuscation: true, numberObfuscation: true, numberObfuscationThreshold: 0.5, stringArray: true, stringArrayThreshold: 0.2, stringArrayEncoding: 'base64' } },
];

const active = ONLY.length ? CANDIDATES.filter((c) => ONLY.includes(c.id)) : CANDIDATES;

// ---------------------------------------------------------------------------
// 被测输入：用项目自己的真实模块，比合成样本更接近线上实际负载
//
// 别用 web/app.js：它含动态 import()，会撞上混淆器一个**既有的**缺陷
// （`t.import is not a function`）。build:web 只混淆 src/**，所以那条缺陷不在
// 线上路径上——但也意味着这里只能拿 src 里的文件当输入。
// ---------------------------------------------------------------------------

const INPUT_FILES = [
  'src/passes/domainLock.js',
  'src/passes/controlFlow.js',
  'src/ast/generator.js',
];

function listJs(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...listJs(path.join(dir, e.name), rel));
    else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out.sort();
}

const inputs = INPUT_FILES.map((rel) => {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return { rel, code, kb: Math.round(code.length / 1024) };
});

// ---------------------------------------------------------------------------
// 把 src/** 用给定选项混淆进 _selfobf-bench/<id>/src/**
// ---------------------------------------------------------------------------

async function buildVariant(core, id, options) {
  const dir = path.join(OUT, id);
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = [];
  for (const rel of listJs(SRC)) {
    const code = fs.readFileSync(path.join(SRC, rel), 'utf8');
    const r = await core.runJob({
      code, options: Object.assign({ seed: SEED }, options), type: 'js', ent: ENT,
    });
    if (!r.ok) {
      failed.push(rel + ': ' + String(r.message).split('\n')[0]);
      continue;
    }
    const dst = path.join(dir, 'src', rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, r.code);
  }
  return { dir, failed };
}

// ---------------------------------------------------------------------------
// 计时：热身一轮，再重复 RUNS 次取中位数
// ---------------------------------------------------------------------------

async function timeVariant(core, label) {
  const per = [];
  for (const input of inputs) {
    const opts = { preset: JOB_PRESET, seed: SEED };
    const job = () => core.runJob({ code: input.code, options: opts, type: 'js', ent: ENT });

    const warm = await job();
    if (!warm.ok) throw new Error(label + ' 跑 ' + input.rel + ' 失败: ' + String(warm.message).split('\n')[0]);

    const times = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = performance.now();
      const r = await job();
      times.push(performance.now() - t0);
      if (!r.ok) throw new Error(label + ' 跑 ' + input.rel + ' 失败: ' + String(r.message).split('\n')[0]);
    }
    times.sort((a, b) => a - b);
    per.push({ rel: input.rel, kb: input.kb, ms: times[Math.floor(times.length / 2)] });
  }
  return per;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const plain = (await import(pathToFileURL(path.join(SRC, 'index.js')).href)).default;

console.log('自混淆运行期基准');
console.log('  被测任务预设 : ' + JOB_PRESET);
console.log('  输入         : ' + inputs.map((i) => i.rel + ' (' + i.kb + ' KB)').join(', '));
console.log('  重复         : ' + RUNS + ' 次取中位数（含 1 轮热身）');
console.log('  候选数       : ' + active.length);
console.log('');

process.stdout.write('原核心计时 …');
const plainTimes = await timeVariant(plain, '原核心');
console.log(' 完成');
console.log('');

const rows = [];
for (const cand of active) {
  const options = Object.assign({}, BASELINE, cand.add);
  process.stdout.write('构建 ' + cand.name + ' …');
  const built = await buildVariant(plain, cand.id, options);
  if (built.failed.length) {
    console.log(' ❌ 构建失败：');
    for (const f of built.failed) console.log('     ' + f);
    rows.push({ name: cand.name, error: true });
    continue;
  }
  let times;
  try {
    const mod = (await import(pathToFileURL(path.join(built.dir, 'src/index.js')).href)).default;
    times = await timeVariant(mod, cand.name);
  } catch (e) {
    console.log(' ❌ 载入/执行失败: ' + e.message);
    rows.push({ name: cand.name, error: true });
    continue;
  }
  console.log(' done');
  rows.push({ name: cand.name, times });
}

console.log('');
console.log('=== 实测量（同一任务，混淆后的核心 vs 原核心）===');
const head = ['候选配置'.padEnd(34), ...inputs.map((i) => (i.kb + ' KB').padStart(10)), '综合'.padStart(10)];
console.log(head.join(' '));
console.log('-'.repeat(head.join(' ').length));

const plainTotal = plainTimes.reduce((s, t) => s + t.ms, 0);
const summary = [];
for (const row of rows) {
  if (row.error) {
    console.log(row.name.padEnd(34) + ' 构建或执行失败');
    continue;
  }
  const cells = row.times.map((t, i) => (t.ms / plainTimes[i].ms).toFixed(2) + '×');
  const total = row.times.reduce((s, t) => s + t.ms, 0);
  const ratio = total / plainTotal;
  summary.push({ name: row.name, ratio });
  console.log(row.name.padEnd(34) + ' ' +
    cells.map((c) => c.padStart(10)).join(' ') + ' ' + (ratio.toFixed(2) + '×').padStart(10));
}

console.log('');
console.log('原核心绝对耗时（中位数）: ' +
  plainTimes.map((t) => t.rel.replace('src/', '').replace('web/', '') + ' ' + t.ms.toFixed(0) + ' ms').join(' | '));
console.log('');
console.log('=== 按综合倍率排序（≤1.50× 为预算内）===');
for (const s of summary.sort((a, b) => a.ratio - b.ratio)) {
  console.log((s.ratio <= 1.5 ? '  ✅ ' : '  ❌ ') + s.ratio.toFixed(2) + '×  ' + s.name);
}