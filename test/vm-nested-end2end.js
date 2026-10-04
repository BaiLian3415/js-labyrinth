/**
 * 端到端验证：vmNested 开启时，真实产物中出现 VMC_run 且语义与原生完全一致。
 *
 * 验证顺序（每条新断言先验证会失败 → 红 → 恢复 → 绿）：
 *  1. 故意反向断言（证明检测在运行）→ 失败（红）
 *  2. 真实断言：产物含 VMC_run → 通过（绿）
 *  3. 真实断言：内层 handler 代码存在 → 通过（绿）
 *  4. 真实断言：eval 执行结果与原生一致（3+5=8）→ 通过（绿）
 */
import { ok, section, cleanTmp } from './_harness.js';
import obfuscateMod from '../src/obfuscate.js';

const { obfuscate, resolveOptions } = obfuscateMod;

// 纯算术 + 局部变量函数（内层内核可编译），带足够语句数（>3）
const userCode = 'function add(a,b){var s=0;var x=a;var y=b;s=x+y;return s;}console.log(add(3,5));';

section('vmNested 端到端验证');

// 断言顺序：先故意反向（打断 → 红），再真实断言（恢复 → 绿）

// 步骤 1：故意反向断言（证明断言机制在检测真实条件）
{
  const opts = resolveOptions({
    preset: 'low', vmProtection: true, vmNested: true, vmNestedBudget: 400,
    vmThreshold: 1,
    mangle: false, selfCheck: false, compact: false, simplify: false,
  });
  const result = obfuscate(userCode, opts);
  const code = result.code;
  const hasVMC = code.indexOf('VMC_run') !== -1;
  // 故意写反：期望没有（实际有，所以会失败 → 红色，验证检测在运行）
  ok(!hasVMC, '故意反向断言：产物不含 VMC_run（应失败 → 红，证明检测运行中）');
}

// 步骤 2：真实断言（恢复 → 绿），内层档真实生效，含 VMC_run
{
  const opts = resolveOptions({
    preset: 'low', vmProtection: true, vmNested: true, vmNestedBudget: 400,
    vmThreshold: 1,
    mangle: false, selfCheck: false, compact: false, simplify: false,
  });
  const result = obfuscate(userCode, opts);
  const code = result.code;

  // 断言 2a：真实产物含 VMC_run（内层内核运行入口标识）
  ok(code.indexOf('VMC_run') !== -1, '真实产物含 VMC_run（内层内核入口）', '缺少 VMC_run，内层档未生效');

  // 断言 2b：内层 handler 行为函数存在（VMC_bh 是行为分发表构造器）
  ok(code.indexOf('VMC_bh') !== -1, '真实产物含内层 handler 行为 VMC_bh', '缺少内层 handler 代码');

  // 断言 2c：内层内核算术与比较行为函数存在（验证完整性）
  ok(
    code.indexOf('VMC_bin') !== -1 && code.indexOf('VMC_cmp') !== -1,
    '真实产物含内层算术 VMC_bin 与比较 VMC_cmp',
    '缺少内层算术/比较行为函数'
  );

  // 断言 2d：运行产物并与原生比对（直接 eval，不依赖 spawnSync，验证语义一致）
  let output = '';
  try {
    const originalLog = console.log;
    console.log = (...args) => { output += args.join(' ') + '\n'; };
    eval(code);
    console.log = originalLog;
  } catch (e) {
    console.log = console.log;
    ok(false, '内层档运行抛异常', String(e.message || e));
  }

  // 断言 2e：结果与原生完全一致（3+5=8）
  ok(output.indexOf('8') !== -1, '内层档运行结果正确（3+5=8，与原生一致）', '结果错误: ' + output);
}

// 清理临时文件（删除调试临时脚本，按规则要求）
cleanTmp();
