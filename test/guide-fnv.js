/**
 * 引导层 FNV 等价性回归测试。
 *
 * 验的是 banner.js 里**真正注入**的 FNV_FORMS（直接 import，不抄一份——抄的那份
 * 会与源码漂移，漂移了就等于没测）。每种写法都必须与 canonical fnv32 逐位相等：
 * 构建期用 fnv32 算 clean 写进引导，运行期由引导自己重算，两者不等就说明产物被改
 * 过（或这次改动写错了等价性）。
 *
 * 空串必须单列：do-while 型的写法至少执行一次，空串会读到 charCodeAt(0)=NaN，
 * 算出的值与 offset basis 对不上。第一版就踩了这个（见 FNV_FORMS 的注释）。
 */
import { fnv32, FNV_FORMS } from '../src/passes/banner.js';
import { ok, report, section, cleanTmp } from './_harness.js';
import { runNode } from './_harness.js';

section('引导层：FNV 写法等价性（构建期与运行期必须逐位相同）');
{
  const CASES = [
    'jr0123456789abcdeff0',
    'a',
    '',
    'x'.repeat(64),
    '中文nonce带汉字',
    '0123456789abcdef0123456789abcdef',
    '\u00e9\u4e2d\ud83d\ude00',
  ];
  ok(FNV_FORMS.length >= 2, '写法库非空（有多于一种结构可选）', 'length=' + FNV_FORMS.length);

  for (const form of FNV_FORMS) {
    const ids = new Set();
    for (const c of CASES) {
      const code = 'function t(){\n'
        + '  var L=' + JSON.stringify(c) + ';\n'
        + form.emit('L', 'H', 'K').join('\n') + '\n'
        + '  return H>>>0;\n}\nprocess.stdout.write(String(t()));';
      let got;
      try { got = Number(runNode(code, 'fnv-' + form.id + '.js').trim()); }
      catch (e) { got = 'ERR'; }
      const want = fnv32(c);
      if (got !== want) ids.add(JSON.stringify(c).slice(0, 24) + ' → ' + got + '≠' + want);
    }
    ok(ids.size === 0, form.id + '：与 canonical fnv32 逐位相等（含空串）',
      [...ids].slice(0, 3).join('; '));
  }

  // 各写法的输出文本必须互不相同，否则「随机挑一种」只是摆设
  const texts = FNV_FORMS.map((f) => f.emit('L', 'H', 'K').join('\n'));
  ok(new Set(texts).size === texts.length, '各写法的产物文本互不相同（结构确实变了）',
    'unique=' + new Set(texts).size + '/' + texts.length);

  // 字面量形态：素数与基数都不该固定以十进制出现。
  //
  // 这两个值是 FNV-1a 的规范参数（16777619 与 2166136261），**不能换值**——换了
  // 就不再是 FNV-1a，上面那条逐位相等的断言会当场失败。能做的只是换写法：
  // 16777619 === 0x01000193 === (1<<24)|0x193，2166136261 === 0x811c9dc5。
  // 全部写成十进制的话，"扫这两个字面量"就能定位到本工具，所以六族里必须有多族
  // 避开十进制形态。
  {
    const decPrime = texts.filter((t) => /\b16777619\b/.test(t)).length;
    const decBasis = texts.filter((t) => /\b2166136261\b/.test(t)).length;
    ok(decPrime < texts.length,
      '不是每族都用十进制写素数（扫 16777619 不足以定位）',
      decPrime + '/' + texts.length + ' 族仍是十进制');
    ok(decBasis < texts.length,
      '不是每族都用十进制写 offset basis（扫 2166136261 不足以定位）',
      decBasis + '/' + texts.length + ' 族仍是十进制');
    // 六族里已经不留十进制素数了（那正是目的），但另外两个注入点
    // ——shell 的 mix 与 rtgen 的加载链——各自还提供三种形态，所以整条流水线上
    // 三种写法都还在用。这里按模块分别确认，别混成一条断言。
    for (const [re, tag] of [[/0x01000193/i, 'hex'], [/\(1<<24\)\|0x193/, 'shift']]) {
      ok(texts.some((t) => re.test(t)), '引导六族里有素数的 ' + tag + ' 形态');
    }
    for (const [re, tag] of [[/\b2166136261\b/, 'dec'], [/0x811c9dc5/i, 'hex']]) {
      ok(texts.some((t) => re.test(t)), '引导六族里有 offset basis 的 ' + tag + ' 形态');
    }
  }

  // 另外两个注入点：shell 的 mix（算载荷校验尾）与 rtgen 的加载链。
  // 两者都用同一个素数，且同样**只能换写法不能换值**——mix 的输出就是校验尾，
  // 换值会让每个产物都解不开。这里逐族跑真代码比对。
  {
    const shellMod = await import('../src/passes/shell.js');
    const C = shellMod.PRIMITIVE_VARIANT_COUNTS;
    ok(C.mix >= 3, 'mix 有多种写法可选', 'mix 变体数=' + C.mix);
    const mixTexts = [];
    for (let mi = 0; mi < C.mix; mi++) {
      mixTexts.push(shellMod.buildPrimitivesText({ mul32: 0, lcg: 0, xs32: 0, shfl: 0, mix: mi }));
    }
    ok(new Set(mixTexts).size === mixTexts.length, 'mix 各变体的文本互不相同',
      'unique=' + new Set(mixTexts).size + '/' + mixTexts.length);
    ok(mixTexts.filter((t) => /\b16777619\b/.test(t)).length < mixTexts.length,
      'mix 不是每族都用十进制写素数',
      mixTexts.filter((t) => /\b16777619\b/.test(t)).length + '/' + mixTexts.length);
    const MIX_CASES = [[0, 1, 0, 1], [12345, 67, 3, 0], [0xdeadbeef, 0xff, 9, 1]];
    let mismatch = '';
    for (let mi = 0; mi < C.mix && !mismatch; mi++) {
      const v = { mul32: 0, lcg: 0, xs32: 0, shfl: 0, mix: mi };
      shellMod.setPrimitiveVariants(v);
      const fromText = (0, eval)('(function(){' + shellMod.buildPrimitivesText(v) + 'return mix;})()');
      for (const args of MIX_CASES) {
        const got = fromText(...args) >>> 0;
        const want = shellMod.primitivesDirect.mix(...args) >>> 0;
        if (got !== want) { mismatch = 'mix 变体 ' + mi + '：' + got + '≠' + want; break; }
      }
    }
    ok(mismatch === '', 'mix 各变体与构建期直接实现逐位相等（校验尾不能错）', mismatch);
    shellMod.setPrimitiveVariants(shellMod.DEFAULT_VARIANTS);
  }

  // 端到端：两个"任意选取"的公开常数（0x9e3779b9 黄金比例哈希、0x9e3779b1
  // 它的低一位邻值）原先写死，扫字面量即可定位。它们不是算法规范参数，
  // 已改成逐构建随机取奇数。
  {
    const { obfuscate } = await import('../src/index.js');
    const SRC = 'function accumulate(list){var running=0;'
      + 'for(var i=0;i<list.length;i++){running+=list[i]*(i+1);}return running;}\n'
      + 'process.stdout.write(String(accumulate([1,2,3])));';
    const GOLDEN = /0x9e3779b9|2654435769|0x9e3779b1|2654435761/;
    let hit = 0;
    const N = 12;
    for (let seed = 1; seed <= N; seed++) {
      const code = obfuscate(SRC, { preset: 'high', seed, vmProtection: true }).code;
      if (GOLDEN.test(code)) hit++;
      // 顺带确认产物仍可执行、语义不变（换常数的唯一风险就是这个）
      const got = String(runNode(code, 'golden-' + seed + '.js')).trim();
      ok(got === '14', 'seed=' + seed + ' 产物语义不变（期望 14）', got);
    }
    ok(hit === 0,
      '产物里不再出现黄金比例常数 0x9e3779b9 / 0x9e3779b1（' + hit + '/' + N + ' 次命中）');
  }
}

if (process.argv[1] && process.argv[1].endsWith('guide-fnv.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}