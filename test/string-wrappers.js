/**
 * stringArrayWrappers*：解码器包装链的层数与进入方式。
 *
 * 跑法：node test/string-wrappers.js
 *
 * 这里的核心风险是**语义**：进入第 j 层时实参要预先消掉的常量与 j 配套，
 * 一旦算错，产物照样能跑但取出的字符串全错。所以每组配置都真跑一遍产物比对输出，
 * 不靠 stats 自证。
 */
import { obfuscate } from '../src/index.js';
import { ok, report, section, cleanTmp, runNode } from './_harness.js';

/** 取 stringArray 这一趟的 stats。pass 的返回值挂在 result 下（见 obfuscate.js 的 timePass）。 */
const saOf = (r) => {
  const s = r.stats.find((x) => x.pass === 'stringArray');
  return (s && s.result) || {};
};
const saStats = (code, options) => {
  const r = obfuscate(code, options);
  return { code: r.code, sa: saOf(r) };
};

const SRC = [
  'var greeting = "hello world";',
  'var target = "api.example.com/v1/endpoint";',
  'var token = "Bearer abc123DEF456ghi789JKL";',
  'function describe(a, b) {',
  '  return a + "|" + b + "|" + greeting;',
  '}',
  'process.stdout.write(String(describe(target, token).length));',
].join('\n');
// describe(target, token) = "api.example.com/v1/endpoint|Bearer abc123DEF456ghi789JKL|hello world"
const WANT = String(('api.example.com/v1/endpoint' + '|' + 'Bearer abc123DEF456ghi789JKL' + '|' + 'hello world').length);

const base = (extra) => ({
  preset: 'low', shell: false, seed: 5,
  stringArray: true, stringArrayThreshold: 1, stringSplitThreshold: 0,
  stringSplitProbability: 0, selfDefending: false, deadCodeInjection: false,
  opaquePredicates: false, functionWrapper: false, decoyFunctions: false,
  callProxy: false, rotateStringArray: false,
  ...(extra || {}),
});

section('stringArrayWrappers*');
{
  // ① 默认（不设层数）→ 不包装，调用点直连解码器，入口名只有 1 个
  {
    const { code, sa } = saStats(SRC, base());
    ok(sa.wrapperLayers === 0, '默认不注入包装层', String(sa.wrapperLayers));
    // 无包装时 chain 只有解码器本体，每组各一个 accessor → 入口数等于组数
    ok(sa.wrapperEntries === sa.groups,
      '默认每组 1 个入口名（直连本组解码器）',
      'entries=' + sa.wrapperEntries + ' groups=' + sa.groups);
    ok(String(runNode(code, 'w-def.js')).trim() === WANT, '默认配置语义正确',
      String(runNode(code, 'w-def2.js')).trim());
  }

  // ② 显式层数 N → 每组恰好注入 N 层
  for (const n of [1, 2, 3, 5]) {
    const r = obfuscate(SRC, base({ stringArrayWrappersCount: n }));
    const sa = saOf(r);
    const groups = sa && sa.groups ? sa.groups : 0;
    ok(sa.wrapperLayers === n * groups,
      'stringArrayWrappersCount=' + n + ' → 每组 ' + n + ' 层（共 ' + (n * groups) + '）',
      'got ' + sa.wrapperLayers + ' layers, groups=' + groups);
    ok(String(runNode(r.code, 'w-' + n + '.js')).trim() === WANT,
      'stringArrayWrappersCount=' + n + ' 语义正确',
      String(runNode(r.code, 'w-' + n + 'b.js')).trim());
  }

  // ③ 0 层 = 显式不包装
  {
    const r = obfuscate(SRC, base({ stringArrayWrappersCount: 0 }));
    const sa = saOf(r);
    ok(sa.wrapperLayers === 0, 'stringArrayWrappersCount=0 → 不包装', String(sa.wrapperLayers));
    ok(String(runNode(r.code, 'w-0.js')).trim() === WANT, '0 层语义正确',
      String(runNode(r.code, 'w-0b.js')).trim());
  }

  // ④ 链式 + 占比 100 → 所有调用点只进最外层，入口名唯一
  {
    const r = obfuscate(SRC, base({
      stringArrayWrappersCount: 4, stringArrayWrappersChainedCalls: true,
      stringArrayWrappersChainedCallsThreshold: 100,
    }));
    const sa = saOf(r);
    ok(sa.wrapperEntries === sa.groups,
      '链式占比 100：每组恰好 1 个入口名（共 ' + sa.groups + ' 组）',
      'entries=' + sa.wrapperEntries + ' groups=' + sa.groups);
    ok(String(runNode(r.code, 'w-ch100.js')).trim() === WANT, '链式占比 100 语义正确',
      String(runNode(r.code, 'w-ch100b.js')).trim());
  }

  // ⑤ 非链式 → 入口名散在各层（每组 > 1 个）
  {
    const r = obfuscate(SRC, base({
      stringArrayWrappersCount: 4, stringArrayWrappersChainedCalls: false,
    }));
    const sa = saOf(r);
    ok(sa.wrapperEntries > sa.groups,
      '非链式：入口名多于组数（同一组内出现多种签名）',
      'entries=' + sa.wrapperEntries + ' groups=' + sa.groups);
    ok(String(runNode(r.code, 'w-nonchain.js')).trim() === WANT, '非链式语义正确',
      String(runNode(r.code, 'w-nonchainb.js')).trim());
  }

  // ⑥ 链式 + 占比 0 → 全部散到内层，入口名仍多于组数
  {
    const r = obfuscate(SRC, base({
      stringArrayWrappersCount: 4, stringArrayWrappersChainedCalls: true,
      stringArrayWrappersChainedCallsThreshold: 0,
    }));
    const sa = saOf(r);
    ok(sa.wrapperEntries > sa.groups, '占比 0：入口名散开', 'entries=' + sa.wrapperEntries);
    ok(String(runNode(r.code, 'w-th0.js')).trim() === WANT, '占比 0 语义正确',
      String(runNode(r.code, 'w-th0b.js')).trim());
  }

  // ⑦ 中间占比 → 既有最外层也有内层
  {
    const r = obfuscate(SRC, base({
      stringArrayWrappersCount: 4, stringArrayWrappersChainedCalls: true,
      stringArrayWrappersChainedCallsThreshold: 50,
    }));
    const sa = saOf(r);
    ok(sa.wrapperEntries > sa.groups, '占比 50：两种形态混合', 'entries=' + sa.wrapperEntries);
    ok(String(runNode(r.code, 'w-th50.js')).trim() === WANT, '占比 50 语义正确',
      String(runNode(r.code, 'w-th50b.js')).trim());
  }

  // ⑧ 非法值报错，且是本地化消息
  for (const bad of [-1, 11, 1.5, '3', true]) {
    let msgText = null;
    try {
      obfuscate(SRC, base({ stringArrayWrappersCount: bad }));
    } catch (e) {
      msgText = e && e.message ? e.message : String(e);
    }
    ok(!!msgText && /stringArrayWrappersCount/.test(msgText),
      'stringArrayWrappersCount=' + JSON.stringify(bad) + ' 抛参数错误', String(msgText));
  }

  // ⑨ 旧名仍生效（向后兼容）：stringArrayCallsTransform: true → 2~5 层
  {
    const seen = new Set();
    for (let seed = 1; seed <= 6; seed++) {
      const r = obfuscate(SRC, base({ stringArrayCallsTransform: true, seed }));
      const sa = saOf(r);
      // 逐组断言而不是取平均：旧行为是每组各自摇 2~5 层，平均值落在中间，
      // 用平均断言既可能误判通过也可能误判失败
      const per = sa.wrapperLayersPerGroup || [];
      ok(per.length === sa.groups && per.every((n) => Number.isInteger(n) && n >= 2 && n <= 5),
        '旧名 seed=' + seed + ' → 每组各 2~5 层', 'got ' + per.join(','));
      seen.add(per.join(','));
      ok(String(runNode(r.code, 'w-legacy-' + seed + '.js')).trim() === WANT,
        '旧名 seed=' + seed + ' 语义正确',
        String(runNode(r.code, 'w-legacy-' + seed + 'b.js')).trim());
    }
    ok(seen.size > 1, '旧名的层数逐构建变化（每组各自摇，不是全组统一）', [...seen].join(','));
  }

  // ⑩ 旧名为 false 时不包装
  {
    const r = obfuscate(SRC, base({ stringArrayCallsTransform: false }));
    const sa = saOf(r);
    ok(sa.wrapperLayers === 0, '旧名 false → 不包装', String(sa.wrapperLayers));
  }

  // ⑪ 可复现性：同 seed 两次构建逐字节相同（含开启包装的配置）
  for (const extra of [
    { stringArrayWrappersCount: 3 },
    { stringArrayWrappersCount: 4, stringArrayWrappersChainedCalls: false },
    { stringArrayWrappersCount: 4, stringArrayWrappersChainedCallsThreshold: 40 },
    { stringArrayCallsTransform: true },
  ]) {
    const a = obfuscate(SRC, base({ ...extra, seed: 42 })).code;
    const b = obfuscate(SRC, base({ ...extra, seed: 42 })).code;
    ok(a === b, '同 seed 可复现：' + JSON.stringify(extra));
  }

  // ⑫ 未设层数时不因新选项多消耗随机数（默认路径产物与旧版逐字节一致）
  {
    const a = obfuscate(SRC, base({ seed: 9 })).code;
    const b = obfuscate(SRC, base({ seed: 9, stringArrayWrappersChainedCalls: true,
      stringArrayWrappersChainedCallsThreshold: 100 })).code;
    ok(a === b, '未设层数时，链式相关选项不改变产物（不额外消耗随机数）');
  }

  // ⑬ 非链式 + 0 层：chain 只有解码器本体，入口名恒为 1，不越界
  {
    const r = obfuscate(SRC, base({
      stringArrayWrappersCount: 0, stringArrayWrappersChainedCalls: false,
    }));
    const sa = saOf(r);
    ok(sa.wrapperLayers === 0 && sa.wrapperEntries === sa.groups,
      '0 层 + 非链式：每组 1 个入口名且不越界',
      'layers=' + sa.wrapperLayers + ' entries=' + sa.wrapperEntries + ' groups=' + sa.groups);
    ok(String(runNode(r.code, 'w-zero-nonchain.js')).trim() === WANT, '0 层 + 非链式语义正确',
      String(runNode(r.code, 'w-zero-nonchainb.js')).trim());
  }
}

if (process.argv[1] && process.argv[1].endsWith('string-wrappers.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}