#!/usr/bin/env node
/**
 * 外壳形态与 WASM 档位：JSFuck 与引导层自检、碎片化、Anti-LLM。
 *
 *   node test/shell-wasm.js
 *
 * 整跑全部用例：npm test（即 node test/selftest.js）。
 */
import { SAMPLE, cleanTmp, counters, ok, report, runNode, section, throws } from './_harness.js';
import obfuscateMod from '../src/obfuscate.js';
import i18n from '../src/i18n.js';

const { obfuscate } = obfuscateMod;
section('JSFuck 壳形式（shellForm）');
{
  const jsfuck = await import('../src/passes/jsfuck.js');
  const shellMod = await import('../src/passes/shell.js');

  // 编码器：真 eval 往返。eval 只出现在本文件里，本文件不随 Worker 上传。
  {
    const cases = ['A', 'ab', 'function f(){return 1}', 'var x=1;x++;', '^&|<>;=?%*/-+', '  mixed 42 !'];
    let bad = 0;
    for (const c of cases) {
      let got;
      try { got = (0, eval)(jsfuck.decodeStrExpr(c)); } catch (e) { got = 'ERR ' + e.message; }
      if (got !== c) bad++;
    }
    ok(bad === 0, 'JSFuck 编码器：6 个 ASCII 用例真 eval 往返一致', bad + ' 项不符');
    ok((0, eval)(jsfuck.jsfuckProgram('return 6*7')) === 42, 'JSFuck 程序形态 Function(...)() 求值正确');
    throws(() => jsfuck.decodeStrExpr('中文'), 'JSFuck 编码器：非 ASCII 明确报错（不静默走样）');
  }

  // 预置：只由八个 JSFuck 字符构成 + 体积落在实测口径附近 + 超限构建失败
  {
    const pre = shellMod.jsfuckPrelude('_0xTestName');
    const expr = pre.slice(pre.indexOf('=') + 1, -1);
    ok(/^[\[\]()!+{}]+$/.test(expr), '预置表达式只由 [ ] ( ) ! + { } 构成', expr.slice(0, 24));
    // 每字节边际成本：用两段不同长度的编码差自己量出来（不碰模块内部常量）
    const e1 = jsfuck.decodeStrExpr('B'.repeat(64)).length;
    const e2 = jsfuck.decodeStrExpr('B'.repeat(128)).length;
    const rate = (e2 - e1) / 64;
    ok(rate < 120, '每字节成本在实测口径内（<120 字符/字节）', rate.toFixed(1));
    let msg = '';
    try { shellMod.jsfuckPrelude('_0xTestName', 1024); } catch (e) { msg = e.message; }
    // 只认数字（实际 46 KB / 核心 487 字符），不依赖 i18n 当前语言
    ok(/46\s*KB/.test(msg) && /487/.test(msg), '核心超限时构建失败并报出实际体积', msg.slice(0, 60));
  }

  // 端到端：产物仍是可执行 JS，且确实带上了纯 JSFuck 段
  const probe = (c) => (c.match(/[\[\]()!+{}]{40,}/g) || [])
    .reduce((a, b) => (b.length > a.length ? b : a), '');
  {
    const jf = obfuscate(SAMPLE, { preset: 'low', seed: 4242, shell: true, shellForm: 'jsfuck' });
    const st = {};
    for (const s of jf.stats || []) st[s.pass] = s.result;
    const out = runNode(jf.code, 'jf-low.js');
    ok(out.includes('hello world') && out.includes('big-even') && out.includes('13'),
      'jsfuck 壳产物可执行且语义不变', out.trim().split('\n').pop());
    ok(st.shell && st.shell.form === 'jsfuck', 'shell 统计标记为 jsfuck 形态', JSON.stringify(st.shell));
    ok(st.shell && st.shell.jsfuckChars > 4096, 'jsfuck 预置体积已计入统计');
    ok(probe(jf.code).length > 20000, '产物里存在整段纯 JSFuck 表达式',
      String(probe(jf.code).length));
    const classic = obfuscate(SAMPLE, { preset: 'low', seed: 4242, shell: true });
    ok(probe(classic.code).length < 100, 'classic 形态（默认）不产生纯 JSFuck 片段',
      String(probe(classic.code).length));
    ok(obfuscate(SAMPLE, { preset: 'low', seed: 4242, shell: true, shellForm: 'jsfuck' }).code === jf.code,
      'jsfuck 形态同 seed 逐字节可复现');
  }

  // 多层：外壳层数与 jsfuck 形态叠加，每层各带一份核心预置
  {
    const deep = obfuscate(SAMPLE, { preset: 'low', seed: 11, shell: true, shellDepth: 2, shellForm: 'jsfuck' });
    const out = runNode(deep.code, 'jf-depth2.js');
    ok(out.includes('hello world') && out.includes('big-even'),
      'shellDepth 2 + jsfuck 两层叠加仍可执行');
  }

  // 防篡改：jsfuck 形态下引导互锁必须仍然成立（盐经 K0 进核心）。
  // 旧口径是"删掉第一行（文件头注释）"——注释已去掉，改成**改引导里的锚点字面量**一位：
  // 盐由该字面量在运行期重算，改动后与构建期写下的 clean 不符，外壳密钥流错位。
  {
    const jf = obfuscate(SAMPLE, { preset: 'low', seed: 4242, shell: true, shellForm: 'jsfuck' });
    // 锚点字面量形状逐构建随机（2026-10-11 起不再有 'jr' 固定前缀），按结构定位：
    // 引导层排在最前面，取第一条 `var <名>="<纯字母数字 token>"`。
    const m = jf.code.match(/^\s*var [A-Za-z_$][\w$]*="([A-Za-z][A-Za-z0-9]{14,30})";?\s*$/m);
    ok(!!m, 'jsfuck 产物里找得到引导锚点字面量', m ? m[1] : '(未匹配)');
    let broken = 'RUNS';
    if (m) {
      const v = m[1];
      // 换首字符（尾巴是 base36，换"下一位"可能换回原字符导致假失败）
      const swapped = (v[0] === 'Z' ? 'Y' : 'Z') + v.slice(1);
      const tampered = jf.code.replace('"' + v + '"', '"' + swapped + '"');
      try { runNode(tampered, 'jf-cut.js'); } catch (e) { broken = 'BREAKS'; }
    }
    ok(broken === 'BREAKS', 'jsfuck 产物改引导锚点字面量后失效（互锁未被形态改动破坏）', broken);
  }
}

// ---------------------------------------------------------------------------
// ------------------------------------------------- 增强保护（引导层自检 / 碎片化 / Anti-LLM）

// ---------------------------------------------------------------- WASM 档位
// 阶段一恢复的 WASM 能力（见 e0d5d32 的移除与 fe2384a 的恢复）。这一段钉四件事：
//   ① 闸门按档位生效（free 拦、plus+ 放行）——闸门是恢复的一部分，不能只恢复选项；
//   ② 各预设的**默认**行为：low 关、medium/high 走旧 wasm 档、max 走解释器内核档；
//   ③ 显式关闭时不该有 wasm pass（那些需要纯 JS VM 行为的隔离测试依赖这一点）；
//   ④ 开着 wasm 也要同 seed 逐字节可复现。
// 语义正确性是底线：wasm 档把字节码搬进 WASM 模块、内核档把解释循环整体搬进去，
// 出错的表现都是"产物跑出错值"，所以每个预设都要真跑一遍比对。

section('WASM 档位（阶段一恢复）');
{
  // 宿主导入多路复用：导入数恒为 5（u1/u2/v2/bin/un），子码逐构建随机。
  // 按元数硬编码（"唯一的 (3→1) 就是 bin"）的还原写法必须失效：(2→1) 有两家。
  const WSRC = 'function a(n){var s=0;for(var i=0;i<n;i++)s+=i;return s;}\n'
    + 'function b(x){if(x<0)return -x;return x*2+1;}\n'
    + 'function c(o){return o.k?o.k.length:0;}\n'
    + 'process.stdout.write(a(9)+","+b(4)+","+b(-3)+","+c({k:"abcd"})+"\\n");';
  const want = runNode(WSRC, 'mux-want.js').trim();
  const subSetOf = (code) => new Set(
    [...code.matchAll(/if\s*\([A-Za-z_$][\w$]*===\s*(-?\d+)\)/g)]
      .map((m) => m[1])
      .filter((v) => Math.abs(+v) > 1000000));
  let semBad = 0, firstSem = '';
  const seen = [];
  let fusedSeen = 0;
  for (const seed of [21, 22]) {
    const r = obfuscate(WSRC, {
      preset: 'high', seed, shell: false, integrityCheck: false,
      wasmInterpreter: true, wasm: false, vmLayers: 1,
    });
    const vst = r.stats.find((x) => x.pass === 'vm');
    fusedSeen += (vst && vst.result && vst.result.fused && vst.result.fused.jumps) || 0;
    const ws = r.stats.find((x) => (x.pass || '').startsWith('wasm'));
    if (!ws || !ws.result || ws.result.imports !== 5) {
      semBad++;
      if (!firstSem) firstSem = 'seed=' + seed + ' imports=' + (ws && ws.result && ws.result.imports);
      continue;
    }
    seen.push(subSetOf(r.code));
    let got;
    try { got = runNode(r.code, 'mux-' + seed + '.js').trim(); } catch (e) { got = 'THREW'; }
    if (got !== want) { semBad++; if (!firstSem) firstSem = 'seed=' + seed + ' → ' + got.slice(0, 60); }
  }
  ok(semBad === 0, '复用导入下面向 2 seed 语义正确且导入数为 5', firstSem);
  // 融合关系跳转（JLT/JLTF 等）必须真的进模块：WSRC 的 i<n、x<0 都是关系测试，
  // 融合与否只看形状不看随机数，断言是确定性的。进模块不断言 NOP（8% 抽取，小函数可能一个抽不中）。
  ok(fusedSeen > 0, '融合关系跳转到达 wasm 内核档（2 seed 共 ' + fusedSeen + ' 条）', 'fusedSeen=' + fusedSeen);
  if (seen.length === 2) {
    const a = [...seen[0]].sort().join(','), b = [...seen[1]].sort().join(',');
    ok(seen[0].size >= 10 && a !== b, '子码逐构建变化（两 seed 无一相同）',
      'sizes=' + seen[0].size + '/' + seen[1].size);
  } else {
    ok(false, '子码集合提取成功（两 seed 产物）', 'seen=' + seen.length);
  }
}

if (process.argv[1] && process.argv[1].endsWith('shell-wasm.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}
