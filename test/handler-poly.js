/**
 * 引导器原语的算法多态（handler algorithm polymorphism）。
 *
 * 跑法：node test/handler-poly.js
 *
 * 背景：外壳引导器的原语（32 位乘法、两条密钥流推进器、原地置换）原先是写死的一套。
 * `1103515245`、`<<13/>>>17/<<5`、16 位拆分乘法这些都是一搜就中的工具指纹——静态
 * 扫常量就能定位到本工具，不需要理解任何逻辑。现在每个原语给若干族实现，逐构建挑一族。
 *
 * 这些原语只用于在构建期与运行期之间自洽地产生密钥流（谁也不需要它的具体数值），
 * 所以换族不改变任何外部可观察行为——**前提是同一变体在两侧一致**。这正是本文件
 * 主要在钉的东西：变体文本与构建期直接实现必须逐位等价，且产物必须真能跑出正确结果。
 */
import { obfuscate } from '../src/index.js';
import * as shell from '../src/passes/shell.js';
import { ok, report, section, cleanTmp, runNode } from './_harness.js';

const SRC = [
  'function accumulate(list){',
  '  var running = 0;',
  '  for (var i = 0; i < list.length; i++) running += list[i] * (i + 1);',
  '  return running;',
  '}',
  'var label = "weighted-sum";',
  'process.stdout.write(String(accumulate([1,2,3]) + label.length));',
].join('\n');
// (1*1 + 2*2 + 3*3) = 14, "weighted-sum".length = 12 → 26
const WANT = String(14 + 'weighted-sum'.length);

const SEEDS = [1, 2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31];

/** 原语变体的可观测标记。用常量而不是函数名——名字随后会被 randomizeNames 换掉。 */
const LCG_MARKS = [
  ['glibc', /1103515245/],
  ['msvc', /214013/],
  ['nr', /1664525/],
];
const XS32_MARKS = [
  ['a-13-17-5', /<<13/],
  ['b-11-13-19', /<<11/],
  ['mulberry', /6[Dd]2[Bb]79[Ff]5/i],
];
const familiesIn = (code, marks) => marks.filter(([, re]) => re.test(code)).map(([n]) => n);

section('原语算法多态');
{
  const C = shell.PRIMITIVE_VARIANT_COUNTS;
  let combos = 0;
  const mismatch = [];
  const degenerate = [];

  // ① 全部变体组合：产物文本 ≡ 构建期直接实现。两侧一旦不同族，构建期算出的
  //    密钥流与运行期解出来的不一致，载荷会变乱码——这是本功能唯一会静默出错的地方。
  const probe = [0, 1, 2, 0x7fffffff, 0x80000000, 0xffffffff, 0x12345678, 0xdeadbeef, 0x9e3779b9];
  for (let a = 0; a < C.mul32; a++) {
    for (let b = 0; b < C.lcg; b++) {
      for (let c = 0; c < C.xs32; c++) {
        for (let d = 0; d < C.shfl; d++) {
          const v = { mul32: a, lcg: b, xs32: c, shfl: d };
          shell.setPrimitiveVariants(v);
          // 从文本 eval 出实现（Node 允许 eval；产物与核心里一处 eval 都不能有，
          // 所以这一步只发生在本测试文件里）
          const fromText = (0, eval)('(function(){' + shell.buildPrimitivesText(v) +
            'return {mul32:mul32,lcg:lcg,xs32:xs32,shfl:shfl,ipos:ipos,mix:mix};})()');
          const direct = shell.primitivesDirect;
          combos++;
          const tag = JSON.stringify(v);
          for (const s of probe) {
            if (fromText.mul32(s, 0xffffffff) !== direct.mul32(s, 0xffffffff)) mismatch.push(tag + ' mul32(' + s + ')');
            if (fromText.lcg(s) !== direct.lcg(s)) mismatch.push(tag + ' lcg(' + s + ')');
            if (fromText.xs32(s) !== direct.xs32(s)) mismatch.push(tag + ' xs32(' + s + ')');
            if (fromText.mix(s, 0x9e3779b9, s & 255, 1) !== direct.mix(s, 0x9e3779b9, s & 255, 1)) mismatch.push(tag + ' mix(' + s + ')');
            if (fromText.ipos(s, 40503, 2654435761, 257) !== direct.ipos(s, 40503, 2654435761, 257)) mismatch.push(tag + ' ipos(' + s + ')');
          }
          for (const n of [0, 1, 2, 7, 64, 257]) {
            const mk = () => Array.from({ length: n }, (_, i) => i);
            const r1 = fromText.shfl(mk(), 0xc0ffee);
            const r2 = direct.shfl(mk(), 0xc0ffee);
            if (r1.length !== r2.length || r1.some((x, i) => x !== r2[i])) mismatch.push(tag + ' shfl(n=' + n + ')');
          }
          // ② 非退化：密钥流推进器不能落进短周期。首版有个 (11,19,8) 的三元组
          //    4096 步只取到 84 个值——产物照样能跑（两侧一起退化），但密钥流质量
          //    没了，白白换掉一个指纹，所以这里要单独断言。
          for (const gen of ['lcg', 'xs32']) {
            let x = 0xc0ffee;
            const seen = new Set();
            for (let i = 0; i < 4096; i++) { x = direct[gen](x); seen.add(x); }
            if (seen.size < 1000) degenerate.push(tag + ' ' + gen + '（4096 步只取 ' + seen.size + ' 个值）');
          }
        }
      }
    }
  }
  ok(mismatch.length === 0, '全部 ' + combos + ' 种变体组合：产物文本与构建期实现逐位一致',
    mismatch.slice(0, 3).join(' | '));
  ok(degenerate.length === 0, '全部变体的密钥流推进器非退化', degenerate.slice(0, 3).join(' | '));

  // ③ mul32 两族必须给出同一结果——这是"只换写法不改行为"的前提。
  //    Math.imul 是 ES2015 才进规范的，所以保留 16 位拆分那一族；两者同值才能自由切换。
  {
    shell.setPrimitiveVariants({ mul32: 0 });
    const m0 = probe.map((s) => shell.primitivesDirect.mul32(s, 0xffffffff));
    shell.setPrimitiveVariants({ mul32: 1 });
    const m1 = probe.map((s) => shell.primitivesDirect.mul32(s, 0xffffffff));
    ok(JSON.stringify(m0) === JSON.stringify(m1), 'mul32 的两族给出同一结果（可自由切换）',
      m0.map((x, i) => (x === m1[i] ? '' : i + ':' + x + '!=' + m1[i])).filter(Boolean).join(' '));
    ok(m0.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffffffff),
      'mul32 结果落在 uint32 区间', m0.filter((x) => !(x >= 0 && x <= 0xffffffff)).join(','));
  }

  // ④ choosePrimitiveVariants 对同一随机源序列给出同一族（可复现的前提）
  {
    const seq = () => { let i = 0; const v = [0.11, 0.87, 0.42, 0.99, 0.5]; return () => v[i++ % v.length]; };
    const r1 = shell.choosePrimitiveVariants(seq());
    const r2 = shell.choosePrimitiveVariants(seq());
    ok(JSON.stringify(r1) === JSON.stringify(r2), '同一随机源序列挑出同一族变体',
      JSON.stringify(r1) + ' vs ' + JSON.stringify(r2));
    ok(Object.keys(r1).every((k) => r1[k] >= 0 && r1[k] < C[k]),
      '变体下标都落在各族范围内', JSON.stringify(r1));
    // 每个原语的下标都要能覆盖到全范围，不能只摇出中间某几族。
    // 逐个原语单独扫：四个下标是同一串随机数连摇四下取的，它们彼此耦合，
    // 合成"组合去重"来数只能得到 8 种（首版就这么数错了，是采样器的性质、
    // 不是选择器的性质）。
    for (const p of Object.keys(C)) {
      const got = new Set();
      for (let i = 0; i < 200; i++) {
        let k = 0;
        const base = i / 200;
        // choosePrimitiveVariants 按固定顺序 mul32/lcg/xs32/shfl 各摇一次，
        // 这里让每个原语都轮到整个值域：把同一条扫描重复 C[p] 轮并整体平移。
        const order = ['mul32', 'lcg', 'xs32', 'shfl'];
        const slot = order.indexOf(p);
        const v = shell.choosePrimitiveVariants(() => (((base + slot / 4) + (k++) / 4) % 1));
        got.add(v[p]);
      }
      ok(got.size === C[p], p + ' 的变体下标覆盖全部 ' + C[p] + ' 族',
        '只取到 ' + [...got].sort().join(','));
    }
    // 两端都要压到：随机源恒为 0 → 全 0；恒接近 1 → 全最大值
    {
      const lo = shell.choosePrimitiveVariants(() => 0);
      ok(Object.keys(lo).every((k) => lo[k] === 0), '随机源恒 0 → 全取 0 号变体', JSON.stringify(lo));
      const hi = shell.choosePrimitiveVariants(() => 0.999999);
      ok(Object.keys(hi).every((k) => hi[k] === C[k] - 1),
        '随机源接近 1 → 全取末号变体', JSON.stringify(hi));
    }
  }
  shell.setPrimitiveVariants(shell.DEFAULT_VARIANTS);
}

section('指纹分散');
{
  const lcgSeen = new Set();
  const xs32Seen = new Set();
  let withGlibc = 0;
  let allOk = true;
  let firstBad = '';

  // ⑤ 逐构建换族：多组 seed 下出现的族要分散，且每个产物都必须能跑出正确结果。
  //    跑产物这一条才是真正的护栏——变体选择如果和实际发出的文本对不上，
  //    静态断言全绿而产物是一堆乱码。
  for (const seed of SEEDS) {
    const code = obfuscate(SRC, { preset: 'low', seed, shell: true, shellDepth: 1 }).code;
    for (const f of familiesIn(code, LCG_MARKS)) lcgSeen.add(f);
    for (const f of familiesIn(code, XS32_MARKS)) xs32Seen.add(f);
    if (/1103515245/.test(code)) withGlibc++;
    const got = String(runNode(code, 'hp-' + seed + '.js')).trim();
    if (got !== WANT) { allOk = false; firstBad = 'seed=' + seed + ' → ' + got; }
  }
  ok(allOk, '12 组 seed 的产物都能跑出正确结果（变体两侧一致）', firstBad);
  ok(lcgSeen.size >= 2, 'lcg 族在多组构建间分散（至少 2 族）', [...lcgSeen].join(','));
  ok(xs32Seen.size >= 2, 'xs32 族在多组构建间分散（至少 2 族）', [...xs32Seen].join(','));
  ok(withGlibc < SEEDS.length,
    '旧指纹 1103515245 不再每个产物都出现（' + withGlibc + '/' + SEEDS.length + ' 次）',
    withGlibc + '/' + SEEDS.length);
}

section('多层壳与可复现性');
{
  // ⑥ 多层壳。实测下来静态只能看到**最外层**那一族的常量：内层壳整体是外层的
  //    载荷，被加密后嵌在密文里，所以内层的原语常量根本不在产物里。
  //    这不是缺陷反而是好事（少一层静态面），但它意味着"两层用不同族"这件事
  //    没法从产物上断言——只能断言最外层那族逐构建仍然在换。
  const d2Seen = new Set();
  let d2Ok = true;
  let d2Bad = '';
  for (const seed of [2, 3, 5, 7, 11, 13]) {
    const code = obfuscate(SRC, { preset: 'low', seed, shell: true, shellDepth: 2 }).code;
    for (const f of familiesIn(code, LCG_MARKS)) d2Seen.add(f);
    const got = String(runNode(code, 'hp-d2-' + seed + '.js')).trim();
    if (got !== WANT) { d2Ok = false; d2Bad = 'seed=' + seed + ' → ' + got; }
  }
  ok(d2Ok, '双层壳产物可运行且语义正确', d2Bad);
  ok(d2Seen.size >= 2, '双层壳时最外层的 lcg 族仍在逐构建分散', [...d2Seen].join(','));

  // 双层壳时静态只应看到一族（内层已加密）。若这里看到两族以上，说明内层壳的
  // 原语明文漏在产物里了——那才是要拦的回归。
  {
    let maxFams = 0;
    for (const seed of [2, 3, 5, 7, 11, 13]) {
      const code = obfuscate(SRC, { preset: 'low', seed, shell: true, shellDepth: 2 }).code;
      maxFams = Math.max(maxFams, familiesIn(code, LCG_MARKS).length);
    }
    ok(maxFams === 1, '双层壳的产物里静态只出现一族 lcg 常量（内层已加密）',
      '最多同时出现 ' + maxFams + ' 族');
  }

  // ⑦ 可复现性：变体选择走 seeded rand，同 seed 必须逐字节相同。
  for (const seed of [3, 11, 29]) {
    const a = obfuscate(SRC, { preset: 'low', seed, shell: true, shellDepth: 1 }).code;
    const b = obfuscate(SRC, { preset: 'low', seed, shell: true, shellDepth: 1 }).code;
    ok(a === b, 'seed=' + seed + ' 两次构建逐字节相同（变体选择可复现）');
  }

  // ⑧ 不开壳时不受影响：变体只在 makeShellLayer 里挑，没套壳就不该有任何变化。
  {
    const a = obfuscate(SRC, { preset: 'low', seed: 5, shell: false }).code;
    const b = obfuscate(SRC, { preset: 'low', seed: 5, shell: false }).code;
    ok(a === b, 'shell:false 时产物可复现');
  }
}

// 原语变体是模块级可变状态。本文件跑完把它钉回默认档：selftest 里各测试文件
// 跑在同一进程里，留下的任意一档会让后面比对 PRIMITIVES_TEXT（默认档文本）的
// 用例（例如 minify.js 那条）读到不一致的构建期实现。
shell.setPrimitiveVariants(shell.DEFAULT_VARIANTS);

if (process.argv[1] && process.argv[1].endsWith('handler-poly.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}