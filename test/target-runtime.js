#!/usr/bin/env node
/**
 * 目标宿主（target runtime）：识别与受限降级。
 *
 *   node test/target-runtime.js
 *
 * 整跑全部用例：npm test（即 node test/selftest.js）。
 *
 * 要验的是三件事，前两件是回归防线，第三件是防误伤：
 *
 *   1. 认出 Cloudflare Worker 后，**跑不了的形态必须被强制关掉**——壳（eval 与
 *      动态 import 双双被禁）、两个 wasm 档（instantiate(buffer) 被禁）、
 *      debugProtection / antiCDP（时钟冻结 → 时序哨兵静默失效）。
 *      这三条都是"抛错"或"静默失效"级别，不关就是给一份跑不起来的产物。
 *   2. 关掉这件事**必须告警**，不能默默关：默默关等于用户以为保护着。
 *   3. 反过来，普通脚本绝不能被误判成 Worker——误判会把用户要的保护无谓砍掉。
 */
import { cleanTmp, counters, ok, report, runNode, section } from './_harness.js';
import obfuscateMod from '../src/obfuscate.js';
import * as target from '../src/target-runtime.js';
import optionsMeta from '../src/options-meta.js';
import DEFAULTS from '../src/options.js';

const { obfuscate } = obfuscateMod;

// 典型 module worker：ESM + export default + env 绑定 + async handler
const WORKER = `export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const key = url.searchParams.get('k');
    if (env.KV && key) {
      const hit = await env.KV.get(key);
      if (hit !== null) return new Response(hit);
    }
    let total = 0;
    for (let i = 0; i < 10; i++) { total += i * 3; }
    return new Response('sum=' + total, { status: 200 });
  },
};
`;

// 普通脚本：一定会被套壳，不该被误判
const PLAIN = 'function f(a){var r=0;for(var i=0;i<a;i++){if(i%2===0){r+=i*3;}else{r-=1;}}return r;}'
  + 'process.stdout.write(String(f(9)));';

section('目标宿主识别（结构性特征，不看字符串字面量）');
{
  ok(target.looksLikeCloudflareWorker(WORKER), '认得出 export default { fetch } 形态的 Worker');
  ok(!target.looksLikeCloudflareWorker(PLAIN), '普通脚本不被误判');
  // 误伤防线：字符串字面量里出现 cloudflare / fetch 不构成判据
  ok(!target.looksLikeCloudflareWorker("var s='cloudflare fetch worker';export const x=1;"),
    '只有字符串字面量提到 cloudflare/fetch 不算 Worker', '判据必须是结构而非字面量');
  ok(target.looksLikeCloudflareWorker("export default { async scheduled(e,env,ctx){ return null; } };"),
    '认得出 scheduled handler');
  ok(target.looksLikeCloudflareWorker("export default { async fetch(r){} };\naddEventListener('fetch',()=>{});"),
    '认得出 addEventListener("fetch") 的 service-worker 风格');
  ok(!target.looksLikeCloudflareWorker(''), '空源码不判为 Worker');
  ok(!target.looksLikeCloudflareWorker('var a=1;ctx.waitUntil(f());'),
    '非模块 + 只有 waitUntil 不判（要模块形态才算）');

  ok(target.resolveTarget('auto', WORKER) === 'cloudflare-worker', 'auto + Worker 源码 → cloudflare-worker');
  ok(target.resolveTarget('auto', PLAIN) === 'generic', 'auto + 普通脚本 → generic');
  ok(target.resolveTarget('browser', WORKER) === 'browser', '显式 browser 覆盖 auto 猜测');
  ok(target.resolveTarget('cloudflare-worker', PLAIN) === 'cloudflare-worker',
    '显式 cloudflare-worker 覆盖 auto 猜测（自动判断认不出时的兜底）');

  const cf = target.profileOf('cloudflare-worker');
  ok(cf.eval === false && cf.newFunction === false, 'CF Worker 档案：禁用 eval 与 new Function');
  ok(cf.wasmFromBuffer === false, 'CF Worker 档案：禁用 WebAssembly.instantiate(buffer)');
  ok(cf.clockFrozen === true, 'CF Worker 档案：时钟冻结');
  ok(target.isClockFrozen('cloudflare-worker') && !target.isClockFrozen('generic'),
    '时钟冻结判定只对受限目标为真');
  const fb = target.forbiddenShapes('cloudflare-worker').map((f) => f.key);
  ok(fb.includes('runtimeEval') && fb.includes('wasmFromBuffer'), '禁形清单含运行期 eval 与 wasm buffer');
  ok(target.forbiddenShapes('generic').length === 0, '通用宿主没有禁形（不因猜错而砍保护）');
  ok(target.forbiddenShapes('cloudflare-worker').every((f) => f.why && f.why.length > 10),
    '每条禁形都带"为什么"（否则将来会被当成多余规则删掉）');
}

section('受限目标：跑不了的形态被强制关掉 + 明确告警');
{
  const r = obfuscate(WORKER, { preset: 'high', seed: 7, shell: true, wasm: true, wasmInterpreter: true });
  const names = (r.stats || []).map((x) => x.pass);
  ok(!names.includes('shell'), 'Worker 目标下壳被关掉（eval/动态 import 皆被禁）',
    names.filter((n) => /shell/i.test(n)).join(','));
  ok(!names.includes('wasm'), 'Worker 目标下 wasm 档被关掉');
  ok(!names.includes('wasmInterpreter'), 'Worker 目标下 wasm 内核档被关掉');
  ok(!/createObjectURL/.test(r.code), '产物里没有 createObjectURL（workerd 的 URL 只支持 http/https）');
  ok(!/\beval\s*\(/.test(r.code), '产物里没有 eval(');

  const warns = (r.warnings || []).map(String);
  const hit = warns.find((w) => /shell/.test(w) && /Cloudflare/.test(w));
  ok(!!hit, '关掉壳这件事有告警，且点名了目标宿主', warns.join(' | ').slice(0, 120));
  ok(hit && /wasm/.test(hit), '告警里列出了被关的项', hit);
  ok(hit && /禁用|disallow/i.test(hit), '告警说清了原因', hit && hit.slice(0, 80));

  // 时序哨兵：时钟冻结 → 差值恒 0 → 阈值永不成立 → 静默失效。所以要关。
  ok(!names.includes('debugProtection'), 'Worker 目标下 debugProtection 被关掉（时钟冻结会静默失效）');
  ok(!names.includes('antiCDP'), 'Worker 目标下 antiCDP 被关掉');

  // 显式 target 与 auto 结果一致（不靠随机数）
  const r2 = obfuscate(WORKER, { preset: 'high', seed: 7, shell: true, target: 'cloudflare-worker' });
  ok(r2.code === r.code, '显式 target 与 auto 的判定结论一致（不依赖随机）');
}

section('防误伤：普通脚本仍全套保护');
{
  // 期望值与原生跑对比，不写死数字——写死过一次（把 f(9) 的 56 写成 36）。
  const plainWant = runNode(PLAIN, 'tr-plain-want.js').trim();
  const r = obfuscate(PLAIN, { preset: 'high', seed: 7, shell: true });
  const names = (r.stats || []).map((x) => x.pass);
  ok(names.includes('shell'), '普通脚本照套壳（没被误判成 Worker）',
    names.filter((n) => /shell/i.test(n)).join(','));
  ok(!(r.warnings || []).some((w) => /目标宿主/.test(String(w))), '普通脚本不产生目标宿主告警');
  ok(runNode(r.code, 'tr-plain.js').trim() === plainWant, '普通脚本语义不变',
    runNode(r.code, 'tr-plain2.js').trim() + ' want=' + plainWant);

  // 显式声明为 Worker 时，即使是普通脚本也要降级（用户说了算）
  const forced = obfuscate(PLAIN, { preset: 'high', seed: 7, shell: true, target: 'cloudflare-worker' });
  ok(!(forced.stats || []).some((x) => x.pass === 'shell'), '显式 target 强制生效，普通脚本也关壳');
}

section('Worker 产物真的能当 ESM 模块跑');
{
  // 前面几条只证明"形态对了"，这条证明"产物可用"：真写成 .mjs 真 import 真调 handler。
  // 回归意义很大——降级逻辑一旦写错，受害表现是"壳还在"，而本机上 Node 恰好能跑
  // data: URL 的 import，产物**看起来正常**，只有 workerd 上才炸。
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const r = obfuscate(WORKER, { preset: 'high', seed: 7, shell: true });
  const dir = mkdtempSync(join(tmpdir(), 'jslb-cfw-'));
  const file = join(dir, 'worker.mjs');
  writeFileSync(file, r.code, 'utf8');
  let mod = null;
  try { mod = await import('file:///' + file.replace(/\\/g, '/')); } catch (e) { mod = null; }
  ok(mod && typeof mod.default === 'object' && typeof mod.default.fetch === 'function',
    'Worker 产物可作为 ESM 模块加载并导出 fetch handler');
  if (mod && mod.default && typeof mod.default.fetch === 'function') {
    const env = { KV: { get: async (k) => (k === 'hit' ? 'CACHED' : null) } };
    const a = await mod.default.fetch(new Request('https://x.dev/?k=hit'), env, {});
    const b = await mod.default.fetch(new Request('https://x.dev/'), env, {});
    const ta = await a.text();
    const tb = await b.text();
    ok(a.status === 200 && ta === 'CACHED', 'KV 命中分支语义正确', a.status + ' ' + ta);
    ok(b.status === 200 && tb === 'sum=135', 'KV 未命中分支语义正确', b.status + ' ' + tb);
  }
}

section('选项面：target 三处同步');
{
  ok(DEFAULTS.target === 'auto', 'DEFAULTS.target 默认 auto');
  ok(optionsMeta.VALUE_OPTIONS.target && optionsMeta.VALUE_OPTIONS.target.kind === 'enum',
    'target 在界面元数据里是枚举项');
  const vals = optionsMeta.VALUE_OPTIONS.target.values;
  ok(vals.includes('auto') && vals.includes('cloudflare-worker'), '枚举含 auto 与 cloudflare-worker', vals.join(','));
  ok(optionsMeta.KNOWN_OPTION_KEYS.has('target'), 'target 是已知选项');
  // 与实现侧的目标表对拍（写死的话下次加目标必漏改一处）
  ok(vals.slice().sort().join(',') === target.TARGETS.slice().sort().join(','),
    '枚举与实现侧 TARGETS 同步', vals.join(',') + ' vs ' + target.TARGETS.join(','));
}

if (process.argv[1] && process.argv[1].endsWith('target-runtime.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}