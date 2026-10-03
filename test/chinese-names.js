import { cleanTmp, counters, ok, report, runNode, section } from './_harness.js';
import obfuscateMod from '../src/obfuscate.js';
import metaMod from '../src/options-meta.js';
import planMod from '../src/plan.js';
import gateMod from '../src/options-gate.js';
import randMod from '../src/utils/rand.js';
import { defaultCJKDict, normalizeCJKDict, isCJKName } from '../src/utils/cjk.js';

const { obfuscate } = obfuscateMod;
const meta = metaMod.default || metaMod;
const plan = planMod.default || planMod;
const gate = gateMod.default || gateMod;
const { setSeed } = randMod.default || randMod;

// 四个预设里 max 的 consoleStub 是开的（产物里 console 被打桩，输出为空），
// 语义比对统一显式关掉，否则读到的是"没报错"而不是真实结果。
const NO_STUB = { consoleStub: false };
const SAMPLE = 'function calc(alpha,beta){var total=alpha+beta;var cache={result:total,label:"x"};'
  + 'return cache.result+total;} console.log(calc(2,3));';
const SAMPLE_WANT = '10';

section('中文命名：字典');
{
  const d = defaultCJKDict();
  ok(d.length === 1024, '默认字典 1024 字', String(d.length));
  ok(new Set(d).size === 1024, '默认字典 1024 字互不重复', String(new Set(d).size));
  ok(!/[\uD800-\uDFFF]/.test(d), '字典不含代理对（两半都不是合法 ID_Start）');
  ok(!/[^\u3400-\u9fff]/.test(d), '字典全在 CJK 区');
  ok(d.startsWith('甲乙丙丁戊己庚辛壬癸'), '起手是天干甲乙丙丁…', d.slice(0, 10));

  // 每个字都得能真的当标识符，否则产物直接语法错
  let bad = 0;
  for (const ch of d) {
    try { new Function('var ' + ch + ' = 1;'); } catch (e) { bad++; }
  }
  ok(bad === 0, '字典里每个字都能作变量名', bad + ' 个不合法');

  // 自定义字典：去重、丢代理对
  const custom = normalizeCJKDict('天地玄黄天地\u{20000}');
  ok(custom === '天地玄黄', '自定义字典去重且剔除代理对', JSON.stringify(custom));
  ok(normalizeCJKDict('') === defaultCJKDict(), '留空回落到默认字典');
}

section('中文命名：可复现性与命名池');
{
  setSeed(7);
  const cjkMod = await import('../src/utils/cjk.js');
  const a = [...cjkMod.cjkNames('')].slice(0, 40).join('');
  setSeed(7);
  const b = [...cjkMod.cjkNames('')].slice(0, 40).join('');
  setSeed(8);
  const c = [...cjkMod.cjkNames('')].slice(0, 40).join('');
  ok(a === b, '同 seed 同字典顺序（可复现）');
  ok(a !== c, '换 seed 换一套字典顺序（不留指纹）');
  ok(!/^甲乙丙丁戊己庚辛壬癸$/.test(a), '发名不是字典原序（否则是强指纹）');

  setSeed(3);
  const used = new Set();
  const p = cjkMod.cjkNames('');
  let allUnique = true;
  for (let i = 0; i < 1024; i++) {
    const it = p.next();
    if (it.done || used.has(it.value)) { allUnique = false; break; }
    used.add(it.value);
  }
  ok(allUnique, '单字池 1024 个名字互不重复');
  const fb = cjkMod.uniqueCJKName(new Set(), '');
  ok(isCJKName(fb), '兜底发的也是中文名', fb);
}

section('中文命名：四档预设');
{
  // 这一节刻意关掉 shell：汉字标识符要「看得见」才验得了，而 medium 及以上默认
  // shell:true 会把整段载荷加密，标识符不再是明文文本——那是外壳的既定行为，不是
  // 中文命名失效（实测 shell:false 时四档分别有 297/3477/7447/8687 个汉字，
  // shell:true 时四档都是 0）。
  //
  // 顺带记一笔：这条断言以前在 medium/high/max 上是**假绿**——它靠的是引导层与
  // 外壳前奏里泄漏的汉字机械名（rand.uniqueName 产出、经原始文本路径进产物），
  // 而那些名字恰好在加密载荷之外。2026-10-03 修掉那个泄漏后断言才变红，说明它
  // 验的从来不是本特性。现在改成在 shell 关掉的前提下直接验汉字标识符。
  for (const preset of ['low', 'medium', 'high', 'max']) {
    let r = null;
    let built = true;
    try {
      r = obfuscate(SAMPLE, {
        preset, seed: 11, nameStyle: 'Chinese', renameProperties: true, shell: false, ...NO_STUB,
      });
    } catch (e) {
      built = false;
      ok(false, preset + ' 档构建成功', e.message);
    }
    if (!built) continue;
    let out = null;
    try {
      out = String(runNode(r.code, 'cjk-' + preset + '.js')).trim();
    } catch (e) {
      const line = String((e && e.stderr) || e.message).split('\n').find((l) => /Error/.test(l)) || '运行失败';
      ok(false, preset + ' 档产物可执行且语义一致', line);
      continue;
    }
    ok(out === SAMPLE_WANT, preset + ' 档产物语义与原源码一致', out);
    ok(/[\u3400-\u9fff]/.test(r.code), preset + ' 档产物含可见汉字（shell:false，载荷未加密）');
    // integrityCheck 会用同一份 genOpts 重算哈希；漏传 chineseNames 时产物一加载
    // 就被自己投毒，症状是 console.log 取不到方法，所以这一条是回归防线
    ok(!/\balpha\b/.test(r.code), preset + ' 档原变量名已消失');
  }
}

section('中文命名：转义与自校验');
{
  // 关掉字符串池，那句"你好"才留在源码里，才能验证字面量的转义口径没被改动
  const r = obfuscate('var s="你好";function f(a){return a+1;}console.log(f(1));',
    { preset: 'low', seed: 5, nameStyle: 'Chinese', stringArray: false, ...NO_STUB });
  ok(/[\u3400-\u9fff]/.test(r.code), '标识符位置是可见汉字（未被转义）');
  ok(String(runNode(r.code, 'cjk-esc.js')).trim() === '2', '开 escapeNonAscii 也能正常执行');
  ok(r.code.includes('\\u4f60'), '字符串字面量里的中文仍按 escapeNonAscii 转义（该开关的口径没变）');

  // 关掉 chineseNames 时不能退回汉字池。注意不能断言"一个汉字都没有"——
  // rand.uniqueName 的命名族里本来就有一档 CJK 字形名（约三成），那是既有行为，
  // 与本选项无关。这里比的是密度：开了以后应当是压倒性多数。
  const off = obfuscate(SAMPLE, { preset: 'low', seed: 11, ...NO_STUB });
  const on = obfuscate(SAMPLE, { preset: 'low', seed: 11, nameStyle: 'Chinese', ...NO_STUB });
  const density = (code) => {
    const decls = code.match(/(?:var|let|const|function)\s+[\u3400-\u9fff]/g) || [];
    return decls.length;
  };
  const offN = density(off.code);
  const onN = density(on.code);
  ok(onN > offN * 3, '打开后汉字声明数远多于默认', '关=' + offN + ' 开=' + onN);
  ok(onN > 3, '打开后确实以汉字为主', String(onN));
}

section('中文命名：完整预设矩阵（回归防线）');
{
  // 这段刻意**不用** NO_STUB：四档预设里 max 的 consoleStub 默认开着，正是要验它在
  // 中文命名下也不把产物弄坏（见下面 2026-10-01 的背景）。consoleStub 的既定语义是
  // 把 console.* 置空，所以 max 档**拿 console 比对输出只会得到空串**——那是它的
  // 文档行为，不是产物坏了（README「VMP 增强」一节有记）。因此语义断言改走
  // process.stdout.write（String() 包一层：write 不接受 number）。
  //
  // 两个形态都要跑：console.log 形态验「加载不抛 + consoleStub 下不投毒」，
  // stdout 形态验「语义逐位正确」。只用后者会漏掉 console 路径上的问题。
  //
  // 背景（2026-10-01 定位）：integrityCheck 有两处口径不一致——
  //   entryCandidates 排除了 !isVMCompiled(fn)，
  //   而哈希面 targets（更早，收集全部根级函数声明）漏了同一条件。
  // 被 VM / wasm 搬走函数的桩仍留在 rootBody 里，运行期 fn.toString() 拿到的是桩
  // 文本，与构建期对同一节点生成的文本形态不同 → 比对必然失配 → 失配的处置就是
  // 投毒。症状是产物加载即抛 `console[...] is not a function`。
  const MATRIX = 'function addTotals(alpha,beta){var runningTotal=alpha+beta;return runningTotal;}'
    + ' console.log(addTotals(3,4));';
  const MATRIX_OUT = 'function addTotals(alpha,beta){var runningTotal=alpha+beta;return runningTotal;}'
    + ' process.stdout.write(String(addTotals(3,4)));';
  const WANT = '7';

  for (const preset of ['low', 'medium', 'high', 'max']) {
    for (const style of ['Chinese', 'Mangled']) {
      const label = preset + ' + ' + style;
      // 形态一：console.log —— 断言"能构建、能加载"（投毒会在这里抛）
      let r;
      try {
        r = obfuscate(MATRIX, { preset, seed: 9, nameStyle: style });
      } catch (e) {
        ok(false, label + ' 构建成功', e.message);
        continue;
      }
      try {
        runNode(r.code, 'cjk-matrix-' + preset + '-' + style + '.js');
        ok(true, label + ' 产物可执行（完整性校验不得投毒）');
      } catch (e) {
        const line = String((e && e.stderr) || e.message).split('\n')
          .find((l) => /Error/.test(l)) || '运行失败';
        ok(false, label + ' 产物可执行（完整性校验不得投毒）', line.slice(0, 120));
        continue;
      }
      // 形态二：process.stdout.write —— 断言语义逐位正确（绕开 consoleStub 的置空语义）
      let out;
      try {
        const r2 = obfuscate(MATRIX_OUT, { preset, seed: 9, nameStyle: style });
        out = String(runNode(r2.code, 'cjk-matrix-out-' + preset + '-' + style + '.js')).trim();
      } catch (e) {
        const line = String((e && e.stderr) || e.message).split('\n')
          .find((l) => /Error/.test(l)) || '运行失败';
        ok(false, label + ' 产物语义正确', line.slice(0, 120));
        continue;
      }
      ok(out === WANT, label + ' 产物语义正确', 'got=' + out + ' want=' + WANT);
    }
  }
}

section('中文命名：属性名与套餐闸门');
{
  const r = obfuscate(SAMPLE, { preset: 'low', seed: 11, nameStyle: 'Chinese', renameProperties: true, ...NO_STUB });
  ok(!/result/.test(r.code), '属性名也被换成中文（原名不残留）');
  ok(String(runNode(r.code, 'cjk-prop.js')).trim() === SAMPLE_WANT, '属性改名后语义不变');

  // free 档的命名风格锁死在 Mangled，中文命名属于"非 Mangled"，同样锁死
  ok(gate.violationsOf({ nameStyle: 'Chinese' }, plan.describe('free')).length === 1,
    'free 档被闸门拦下');
  for (const p of ['plus', 'team', 'business']) {
    ok(gate.violationsOf({ nameStyle: 'Chinese' }, plan.describe(p)).length === 0,
      p + ' 档可用');
  }
  // 四个预设都必须声明这一项，否则 plan.js 的套餐一致性断言会拒绝加载
  for (const preset of ['low', 'medium', 'high', 'max']) {
    const r2 = obfuscate(SAMPLE, { preset, seed: 1, ...NO_STUB });
    ok(typeof r2.code === 'string' && r2.code.length > 0, preset + ' 档声明 chineseNames 且可构建');
  }
  ok(meta.VALUE_OPTIONS.nameStyle.values.includes('Chinese'),
    'Chinese 是 nameStyle 的合法枚举值（GUI/CLI 都能识别）');
  ok(!meta.KNOWN_OPTION_KEYS.has('chineseNames'),
    'chineseNames 布尔项已移除（2026-10-01 并入 nameStyle 枚举）');
  ok(meta.KNOWN_OPTION_KEYS.has('chineseDictionary'), 'chineseDictionary 是已知选项');
}

if (process.argv[1] && process.argv[1].endsWith('chinese-names.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}