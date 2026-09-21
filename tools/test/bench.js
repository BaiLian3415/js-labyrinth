// 混淆性能基准：测各预设 × 各规模的耗时，并拆出 per-pass 分布。
//
//   node tools/test/bench.js [--pass] [--json]
//
// 为什么要先测再优化：pass 之间的耗时差好几个数量级，凭直觉猜瓶颈十次九次错。
// 脚本只用固定 seed，因此结果可复现、可跨版本对比。
import { execFileSync } from 'node:child_process';
import obfuscateMod from '../../src/obfuscate.js';
import presets from '../../src/presets.js';

const obfuscate = obfuscateMod.default || obfuscateMod.obfuscate || obfuscateMod;
const ENT = { plan: 'business', preset: 'max', gates: {}, limits: {} };
const SEED = 20260920;

/** 造一段有代表性的输入：函数、类、闭包、字符串、模板、循环、对象字面量。 */
function makeInput(targetBytes) {
  const unit = `
function calc_%i(a, b) {
  var total = 0;
  for (var i = 0; i < b.length; i++) {
    total += a * b[i] + (i % 3 === 0 ? a - b[i] : b[i] / 2);
  }
  return total;
}
class Model_%i {
  constructor(opts) {
    this.name = opts && opts.name ? opts.name : "model-%i";
    this.items = [];
    this.config = { retries: 3, timeout: 1500, tags: ["alpha", "beta", "gamma"] };
  }
  add(item) { this.items.push(item); return this; }
  get summary() {
    return \`\${this.name}: \${this.items.length} items, retries=\${this.config.retries}\`;
  }
}
var registry_%i = (function () {
  var cache = {};
  return {
    put: function (k, v) { cache[k] = v; return Object.keys(cache).length; },
    get: function (k) { return cache.hasOwnProperty(k) ? cache[k] : null; },
  };
})();
var data_%i = [12, 45, 78, 23, 90, 11, 67];
console.log(calc_%i(3, data_%i), new Model_%i({ name: "m%i" }).add(1).summary, registry_%i.put("k", 7));
`;
  let out = '';
  let i = 0;
  while (out.length < targetBytes) {
    out += unit.replace(/%i/g, String(i++));
  }
  return out;
}

const SIZES = [
  { name: '小 2 KB', bytes: 2 * 1024 },
  { name: '中 20 KB', bytes: 20 * 1024 },
  { name: '大 80 KB', bytes: 80 * 1024 },
];

const PRESETS = ['low', 'medium', 'high', 'max'];
const json = process.argv.includes('--json');
const wantPass = process.argv.includes('--pass');

function timeIt(fn) {
  const t0 = performance.now();
  const r = fn();
  return { ms: performance.now() - t0, r };
}

const rows = [];
if (!json) console.log('混淆性能基准（seed=' + SEED + '，Node ' + process.version + '）\n');

for (const p of PRESETS) {
  for (const s of SIZES) {
    const src = makeInput(s.bytes);
    // 预热一次，避开 JIT 冷启动。
    // 慢用例（高档位 + 大输入）只测一次：单个用例动辄几十秒甚至几分钟，测三次
    // 会把整个基准拖到半小时以上，而那种量级的耗时本来也不受抖动影响。
    const SLOW_MS = 3000;
    const runs = [];
    let last = null;
    const t0 = timeIt(() => obfuscate(src, { preset: p, seed: SEED }));
    last = t0.r;
    if (t0.ms <= SLOW_MS) {
      for (let k = 0; k < 3; k++) {
        const t = timeIt(() => obfuscate(src, { preset: p, seed: SEED }));
        last = t.r;
        runs.push(t.ms);
      }
    } else {
      runs.push(t0.ms);
    }
    runs.sort((a, b) => a - b);
    const med = runs[Math.floor(runs.length / 2)];
    rows.push({
      preset: p,
      size: s.name,
      srcBytes: src.length,
      outBytes: last.code ? last.code.length : 0,
      ms: med,
      samples: runs.length,
      perPass: (last.stats || []).filter((x) => typeof x.ms === 'number'),
    });
    if (!json) {
      console.log('  ' + p.padEnd(7) + s.name.padEnd(10)
        + String(Math.round(src.length / 1024)).padStart(4) + ' KB -> '
        + String(Math.round((last.code ? last.code.length : 0) / 1024)).padStart(5) + ' KB   '
        + med.toFixed(0).padStart(7) + ' ms   '
        + (src.length / 1024 / (med / 1000)).toFixed(0).padStart(5) + ' KB/s'
        + (runs.length === 1 ? '   (单次)' : ''));
    }
  }
}

if (wantPass) {
  if (!json) console.log('\nper-pass 耗时分布（取大 80 KB 那一档）');
  for (const p of PRESETS) {
    const row = rows.find((r) => r.preset === p && r.size === '大 80 KB');
    if (!row) continue;
    const total = row.perPass.reduce((a, b) => a + b.ms, 0);
    const sorted = row.perPass.slice().sort((a, b) => b.ms - a.ms);
    if (!json) {
      console.log('\n  [' + p + '] pass 合计 ' + total.toFixed(0) + ' ms，总耗时 ' + row.ms.toFixed(0) + ' ms');
      for (const s2 of sorted) {
        if (s2.ms < 0.05) continue;
        const pct = (s2.ms / total) * 100;
        console.log('    ' + s2.pass.padEnd(18)
          + s2.ms.toFixed(1).padStart(7) + ' ms  '
          + pct.toFixed(1).padStart(5) + '%  '
          + '#'.repeat(Math.max(1, Math.round(pct / 2))));
      }
    }
  }
}

if (json) {
  console.log(JSON.stringify(rows.map((r) => ({
    preset: r.preset, size: r.size, srcBytes: r.srcBytes, outBytes: r.outBytes,
    ms: Number(r.ms.toFixed(2)),
    perPass: r.perPass.map((x) => [x.pass, Number(x.ms.toFixed(2))]),
  })), null, 2));
}
