#!/usr/bin/env node
/**
 * VMP 增强：覆盖率阈值、宏指令深度与 stats 口径。
 *
 *   node test/vmp.js
 *
 * 整跑全部用例：npm test（即 node test/selftest.js）。
 */
import { execFileSync } from 'node:child_process';
import { cleanTmp, counters, ok, report, runNode, runSync, section } from './_harness.js';
import obfuscateMod from '../src/obfuscate.js';

const { obfuscate } = obfuscateMod;
section('VMP 增强（覆盖率 / 深度 / stats 口径）');
{
  const vmRun = (src, opts) => {
    const r = obfuscate(src, Object.assign({ seed: 5, consoleStub: false }, opts));
    const st = r.stats.find((x) => x.pass === 'vm');
    return { r, st: st ? st.result : null };
  };
  // runNode 返回的是 execFileSync 的**字符串**（encoding: 'utf8'），不是 {stdout} 对象。
  // 这一点与文件里别处的 runSafe 不同，后者自己包了 runSync 才用 .trim()。
  const runOf = (src) => String(runNode(src)).trim();

  // 样例刻意包含三个「2~3 条语句」的小函数——它们恰好落在 thr2 收、thr4 挡的区间。
  //
  // 为什么不用更常见的"三段式 if"样例：那个函数的语句数是 4，thr4 就已经收了它，
  // thr2 与 thr4 在它上面没有差别，断言会假失败（2026-10-01 首次跑就踩了这个）。
  // 现在这个组合样例实测 thr4=2 / thr2=3 / thr1=4，且 8 个 seed 上全部稳定。
  const SMALL = 'function tier(x) {\n'
    + '  if (x > 100) { return "a"; }\n'
    + '  if (x > 10) { return "b"; }\n'
    + '  return "c";\n'
    + '}\n'
    + 'function pair(n) {\n'
    + '  var a = n > 0 ? 1 : -1;\n'
    + '  var b = n > 1 ? 2 : -2;\n'
    + '  return a + b;\n'
    + '}\n'
    + 'function mul(n) {\n'
    + '  var r = 1;\n'
    + '  for (var i = 2; i <= n; i++) { r *= i; }\n'
    + '  return r;\n'
    + '}\n'
    + 'function report(n) {\n'
    + '  return tier(n) + "|" + pair(n) + "|" + mul(n);\n'
    + '}\n'
    + 'process.stdout.write(report(6));';
  const SMALL_WANT = 'c|3|720';

  // --- ① 覆盖率：medium 的阈值下调让小函数也进 VM ---
  {
    const before = vmRun(SMALL, { preset: 'medium', vmThreshold: 4 });
    const after = vmRun(SMALL, { preset: 'medium' });
    const base = runOf(SMALL);
    ok(base === SMALL_WANT, '样例的基准输出符合预期', base);
    ok(before.st && after.st && after.st.compiled > before.st.compiled,
      'medium：调低 vmThreshold 后进 VM 的函数变多',
      before.st.compiled + ' → ' + after.st.compiled);
    // high 本就 thr1，覆盖率应当等于 thr2 再加一点（单三元的那个函数只有 1 条语句）
    const hi = vmRun(SMALL, { preset: 'high' });
    ok(hi.st && hi.st.compiled > after.st.compiled,
      'high(thr1) 的覆盖率不低于 medium(thr2)（改动只落在 medium 预设上）',
      'medium=' + after.st.compiled + '  high=' + hi.st.compiled);
    ok(String(runNode(after.r.code)).trim() === base, 'medium 新阈值下语义一致');
    ok(String(runNode(before.r.code)).trim() === base, 'medium 旧阈值下语义一致');
    ok(String(runNode(hi.r.code)).trim() === base, 'high 下语义一致');
  }

  // --- ② 深度：high 的宏指令融合与动态操作码真的生效 ---
  {
    const off = vmRun(SMALL, { preset: 'high', vmMacroOps: false, vmDynOpcodes: false });
    const on = vmRun(SMALL, { preset: 'high' });
    ok(on.st && on.st.macros.fused > (off.st ? off.st.macros.fused : 0),
      'high：宏指令融合条数上升',
      (off.st ? off.st.macros.fused : '?') + ' → ' + (on.st ? on.st.macros.fused : '?'));
    ok(on.st && on.st.dyn.applied && !(off.st && off.st.dyn.applied),
      'high：动态操作码真的生效',
      'space=' + (on.st ? on.st.dyn.space : '?'));
    // 动态操作码要求字空间是 2 的幂，且必须 ≥ 实际用到的指令数
    if (on.st && on.st.dyn.applied) {
      const sp = on.st.dyn.space;
      ok(sp > 0 && (sp & (sp - 1)) === 0, '动态字空间是 2 的幂（还原式 &(N-1) 的前提）', String(sp));
    }
    ok(String(runNode(on.r.code)).trim() === runOf(SMALL), '打开宏指令 + 动态操作码后语义一致');
    // 产物确实变了（否则"生效"只是计数动了）
    ok(on.r.code !== off.r.code, '打开后产物与关闭时不同（不是只有计数变化）');
  }

  // --- ③ stats 口径：WASM 内核档不再报 decoy:0，并列出被屏蔽的项 ---
  {
    const js = vmRun(SMALL, { preset: 'max', wasmInterpreter: false });
    const wasm = vmRun(SMALL, { preset: 'max' });
    ok(js.st && js.st.ops.shared === false, 'JS 档：ops.shared 为 false');
    ok(wasm.st && wasm.st.ops.shared === true, 'WASM 内核档：ops.shared 为 true');
    // 修复前 wasm 档的 decoy 恒为 0，看起来像"整档没有干扰项"
    ok(wasm.st && wasm.st.ops.decoy > 100,
      'WASM 内核档：ops.decoy 按共享槽报，不再是 0', String(wasm.st && wasm.st.ops.decoy));
    ok(js.st && js.st.ops.decoy > 100, 'JS 档：ops.decoy 仍有值', String(js.st && js.st.ops.decoy));

    // 共享档三个数必须同单位：real=已占槽、decoy=空槽、total=表大小。
    // 若 real 仍按函数字面量累加（不同函数用到的指令种类会重复计数），再与全局的
    // 空槽数相加，total 会超过表大小——3 个函数时能算出 1040 而表只有 1024 槽。
    ok(wasm.st && wasm.st.ops.real + wasm.st.ops.decoy === wasm.st.ops.total,
      '共享档：real + decoy == total（同单位）',
      wasm.st ? wasm.st.ops.real + '+' + wasm.st.ops.decoy + '=' + wasm.st.ops.total : '?');
    ok(wasm.st && wasm.st.ops.total === 1024,
      '共享档：total 等于共享表大小（max 的 vmDecoyOps=1024）', String(wasm.st && wasm.st.ops.total));
    ok(js.st && js.st.ops.real + js.st.ops.decoy === js.st.ops.total,
      '逐函数档：real + decoy == total');

    // suppressed：配了但被 wasmInterpreter 屏蔽的项
    ok(Array.isArray(wasm.st && wasm.st.suppressed), 'suppressed 是数组');
    ok(wasm.st && wasm.st.suppressed.length === 0,
      'max 预设不再声称提供实际不存在的保护（2026-10-01 前这里是 vmBlockDecrypt）',
      JSON.stringify(wasm.st && wasm.st.suppressed));
    ok(js.st && (!js.st.suppressed || js.st.suppressed.length === 0),
      'JS 档：没有静默失效的项');

    // 逐项上报：显式配几项，逐项都该被列出来
    const many = vmRun(SMALL, {
      preset: 'max', vmJumpsEncoding: true, vmStackEncoding: true,
      vmMacroOps: true, vmDynOpcodes: true,
    });
    const sup = many.st ? many.st.suppressed : [];
    ok(sup.length === 4, 'WASM 内核档逐项报出被屏蔽的 4 项', sup.join(','));
    ok(!sup.includes('vmAsyncExecutor'), '未配置的项不进 suppressed（不制造噪声）');

    // 屏蔽是"配置无效"而非"降级出错"：产物仍能跑
    ok(String(runNode(wasm.r.code)).trim() === runOf(SMALL), 'WASM 内核档产物语义一致');
  }

  // --- 回归：low 档不开 VM，其余三档都开 ---
  {
    const low = vmRun(SMALL, { preset: 'low' });
    ok(!low.st || low.st.compiled === 0, 'low 档不开 VMP（改动未波及）',
      low.st ? String(low.st.compiled) : '(无 vm pass)');
    for (const p of ['medium', 'high', 'max']) {
      const v = vmRun(SMALL, { preset: p });
      ok(v.st && v.st.compiled > 0, p + ' 档有函数进 VM');
      ok(String(runNode(v.r.code)).trim() === runOf(SMALL), p + ' 档语义一致');
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('vmp.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}
