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
}

if (process.argv[1] && process.argv[1].endsWith('guide-fnv.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}