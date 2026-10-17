#!/usr/bin/env node
/**
 * VM 保护：标识符冲突、动态操作码、分发表密文化、分块自解密、执行护栏与多层嵌套。
 *
 *   node test/vm.js
 *
 * 整跑全部用例：npm test（即 node test/selftest.js）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TMP, cleanTmp, counters, ok, report, runNode, runSync, section } from './_harness.js';
import obfuscateMod from '../src/obfuscate.js';
import plan from '../src/plan.js';

const { obfuscate } = obfuscateMod;
section('VM 保护与用户标识符冲突');
{
  // 2026-09-21 修掉的缺陷：解释器 case 体的局部名是硬编码的 a/b/c/v/f/k/o/x0，
  // 而跳转分支用 `var` 声明——var 提升到函数作用域，会把用户同名的变量整个覆盖掉。
  // 实测用户变量叫 a 时，第一条 if 的跳转分支把 a 写成跳转目标地址，之后 typeof a
  // 恒得 "number"、数值比较恒假，而且**不报错**。影响 medium/high/max（全部付费档位）。
  //
  // 覆盖要点：变量名叫 a（以及 b/c/x0/x1/f/k/o/v/n 这些解释器曾占用的名字）、
  // 函数里不止一条 if（否则跳转分支不执行，碰不到覆盖）、跨预设跨 seed。
  const cases = [
    // 参数为 a + 两条 if + typeof
    'function f(a){ if(a===0) return "n0"; if(typeof a==="number") return "num"; return "end"; }'
      + ' process.stdout.write([f(0), f(9), f("z")].join(" ") + "\\n");',
    // 局部变量 a 参与两条 if
    'function g(){ var a=7; if(a>5) return "big"; if(a<10) return "small"; return "no"; }'
      + ' process.stdout.write(g() + "\\n");',
    // a 作为循环变量（跳转回边）
    'function h(n){ var s=0, a=0; for(a=0; a<n; a++) s+=a; return s; } process.stdout.write(h(5) + "\\n");',
    // 一批曾经会让解释器撞名的标识符
    'function k(a,b,c,v,n,f,o){ if(a>b) return "ab"; if(c<v) return "cv"; if(n!==f) return "nf";'
      + ' return o; } process.stdout.write(k(2,1,3,4,5,6,"tail") + "\\n");',
    // a 上是对象，走 GETM / SETM / CALLM
    'function m(a){ if(a.length>2) return a.toUpperCase(); if(a.length===1) return "one";'
      + ' return "other"; } process.stdout.write([m("abcd"), m("x"), m("yz")].join(" ") + "\\n");',
  ];
  const runNode = (code, name) => {
    const file = path.join(TMP, name + '.js');
    fs.writeFileSync(file, code);
    // max 预设的 VM 产物在较慢宿主上单次执行实测 25~31s，30s 超时是边界值，
    // 会以 ETIMEDOUT 形式偶发误报（每次漂移到不同 case/seed，放宽后结果全对）。
    // 这里放到 90s 只影响夹具判定，不改变被判定产物的语义。
    return runSync(process.execPath, [file], { encoding: 'utf8', timeout: 90000 }).trim();
  };
  let mismatch = 0;
  let firstBad = '';
  for (let ci = 0; ci < cases.length; ci++) {
    const want = runSync(process.execPath, ['-e', cases[ci]], { encoding: 'utf8' }).trim();
    // vmProtection 只在 medium 及以上开启，low 也一并测作对照
    for (const preset of ['low', 'medium', 'high', 'max']) {
      for (let seed = 1; seed <= 3; seed++) {
        const out = obfuscate(cases[ci], { preset, seed }).code;
        let got;
        try { got = runNode(out, 'vm-' + ci + '-' + preset + '-' + seed); }
        catch (e) { got = 'THREW: ' + String(e.message).split('\n')[0]; }
        if (got !== want) {
          mismatch++;
          if (!firstBad) firstBad = '例' + ci + ' ' + preset + ' seed=' + seed
            + '：' + got.slice(0, 60) + '，应为 ' + want.slice(0, 60);
        }
      }
    }
  }
  ok(mismatch === 0, 'VM 保护不覆盖用户名为 a/b/c/v/n/f/o 的变量（5 例 × 4 预设 × 3 seed）', firstBad);
}

section('P3：动态操作码（vmDynOpcodes）· 链值驱动轮换');
{
  // 轮换量由**前一字的明文**驱动（2026-09-28）。解码端从 nCHAIN 算，编码端必须与
  // 它逐位一致；一旦不一致，字节码解成垃圾——而且通常不报错，是"能跑、结果错"。
  // 所以这里逐形态比对产物执行结果，而不是只看能不能构建。
  //
  // 输出必须走 process.stdout.write：**不能用 console.log**——max 预设的 consoleStub
  // 刻意清空 console.*，用它取输出会得到空串，从而把正确产物判成失败。
  const mk = (body) => body + '\nprocess.stdout.write(String(res)+"\\n");';
  const forms = [
    ['顺序循环', 'function f(a){var t=0;for(var i=0;i<a;i++)t+=i;return t;}var res=f(12);'],
    ['分支混合', 'function f(a){var t=0;for(var i=0;i<a;i++){if(i%3)t+=i;else if(i%5)t-=i;else t++;}return t;}var res=f(17);'],
    ['while + break/continue', 'function f(a){var t=0,i=0;while(i<a){i++;if(i%4===0)continue;if(i>18)break;t+=i;}return t;}var res=f(26);'],
    ['switch 密度分支', 'function f(a){var s=0;for(var i=0;i<a;i++){switch(i%4){case 0:s+=1;break;case 1:s+=10;break;case 2:s+=100;break;default:s-=1;}}return s;}var res=f(16);'],
    ['递归（深调用链）', 'function f(n){return n<2?n:f(n-1)+f(n-2);}var res=f(14);'],
    // 带标签的 continue：环上依赖最容易在这里出问题
    ['多跳转（环风险）', 'function f(a){var t=0,i=0;outer:while(i<a){i++;if(i%2)continue outer;if(i>9)break outer;t+=i;}return t;}var res=f(15);'],
    ['异常路径', 'function f(a){try{if(a>3)throw new Error("e");return a*2;}catch(e){return -1;}finally{}}var res=f(5)+","+f(2);'],
    ['闭包捕获可变状态', 'function mk(n){return function(x){return x+n;};}function f(a){var g=mk(a),t=0;for(var i=0;i<6;i++)t+=g(i);return t;}var res=f(8);'],
  ];
  let bad = '';
  let dynOn = 0;
  let offOk = 0;
  for (const [name, body] of forms) {
    const src = mk(body);
    const want = runNode(src, 'dyn-want.js').trim();
    if (want.startsWith('ERR') || want === '') { bad = name + ' 基线跑不通'; break; }
    for (const dyn of [true, false]) {
      for (const seed of [1, 5, 20260928]) {
        let got;
        try {
          const r = obfuscate(src, {
            preset: 'high', seed, shell: false, integrityCheck: false,
            vmDynOpcodes: dyn, wasm: false, wasmInterpreter: false,
          });
          got = runNode(r.code, 'dyn-' + dyn + '-' + seed + '.js').trim();
          if (dyn) {
            const s = r.stats.find((x) => x.pass === 'vm');
            if (s && s.result && s.result.dyn && s.result.dyn.applied) dynOn++;
          }
        } catch (e) { got = 'BUILD:' + String(e && e.message).slice(0, 60); }
        if (got !== want) {
          bad = name + ' dyn=' + dyn + ' seed=' + seed + ' 期望 ' + JSON.stringify(want)
            + ' 实得 ' + JSON.stringify(got);
          break;
        }
        if (!dyn) offOk++;
      }
      if (bad) break;
    }
    if (bad) break;
  }
  ok(bad === '', '链值驱动轮换在各形态/种子下语义正确（开与关都验）', bad);
  ok(dynOn > 0, 'vmDynOpcodes 开启时确实生效（dyn.applied）', 'applied 次数=' + dynOn);
  // 守护一个真实踩过的坑：opWordZ 与 opCanon 必须同开同关。曾经 opWordZ 无条件建，
  // 而 opCanon 只在 dynOps 下填，于是 **dynOps=false 时** opcode
  // 字被不动点循环重算成 (undefined - rot) & mask 的垃圾，整条字节码报废。
  // 2026-10-01 起 high 预设打开了 vmDynOpcodes，"关闭"这条路径不再由预设默认覆盖，
  // 所以这个断言改为直接显式关掉来验——覆盖面没变，措辞要跟上。
  ok(offOk > 0, '显式关闭 vmDynOpcodes 时仍能正确构建并运行', '通过 ' + offOk + ' 次');
}

section('P3：分发表密文化（vmDispatchEnc）');
{
  // 样例刻意只用一个 VM 函数并调用两次：P3-3 的「解码清零每次调用执行一遍」
  // 计数断言需要已知的调用次数。integrityCheck 关掉是为了让篡改变体直接测
  // 分发表本身，而不是被完整性校验先一步拦下（后者已由「篡改检出」段覆盖）。
  const src1 = 'function work(n){var a=0;for(var i=0;i<n;i++){if(i%2===0){a+=i*3;}else{a-=1;}}return a+"|"+(n>3?"big":"small");}\n'
    + 'process.stdout.write(work(9)+" "+work(2)+"\\n");';
  const want = runNode(src1, 'p3-want.js').trim();
  const vmStatOf = (r) => {
    const s = r.stats.find((x) => x.pass === 'vm');
    return s && s.result ? s.result : null;
  };
  // 产物里的标识符可能是 \uXXXX 转义序列（名字池含非 ASCII），统一按转义层文本匹配
  const NAME = '(?:\\\\u[0-9a-fA-F]{4}|[\\w$])(?:\\\\u[0-9a-fA-F]{4}|[\\w$])*';
  const escName = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** 15 秒兜底运行：篡改变体可能让解释器失去分发目标而空转，超时视作检出。 */
  const runSafe = (code, name) => {
    const file = path.join(TMP, name + '.js');
    fs.writeFileSync(file, code);
    try {
      return runSync(process.execPath, [file], { encoding: 'utf8', timeout: 15000 }).trim();
    } catch (e) { return 'ERR'; }
  };

  // ---- 形态统计用的样例与 src1 分开（2026-10-01 修正）----
  //
  // src1 只有一个函数能编译（work），这是 P3-3「解码清零每次调用执行一遍」的计数
  // 断言所需要的——它要求已知的调用次数。**但拿它做形态统计是不行的**：每个 seed
  // 只贡献一次伯努利试验，而形态 D 的设计概率是 75%（vm.js 里
  // randInt(0,3)===0 ? A/B/C : D）。8 次试验要求 ≥6 次命中，通过概率只有约 90%；
  // 就算放宽到 24 次 ≥14 次，seed 1..24 这个窗口本身对单函数样例仍可能整体偏低
  // （实测当前配置 13/24，改动前配置 17/24——扩到 48 seed 两者都是 67~69%，
  // 差异纯属窗口效应，与配置无关）。
  //
  // 真正的修法是**让每个 seed 贡献多次试验**：下面的 src3 有 3 个可编译函数，
  // 8 个 seed 就是 24 次判定，抖动被压掉。实测命中率在 8/24/48 seed 上分别是
  // 79%/72%/72%，与设计值 75% 吻合，且对配置改动不敏感（关掉 macro/dyn 是 83%/75%/78%）。
  const src3 = 'function work(n){var a=0;for(var i=0;i<n;i++){if(i%2===0){a+=i*3;}else{a-=1;}}return a+"|"+(n>3?"big":"small");}\n'
    + 'function tag(n){var s="";for(var i=0;i<n;i++){s+=String(i%3);}return s.length>2?"long":s;}\n'
    + 'function range(xs){var t=0;for(var i=0;i<xs.length;i++){if(xs[i]>1){t+=xs[i];}else{t-=1;}}return t;}\n'
    + 'process.stdout.write(work(9)+" "+tag(5)+" "+range([1,2,3]));';

  // 形态统计：关 → D 不出现；开 → D 成为主要形态，且存在「全 D」构建。
  //
  // **统计用 src3，行为验证用 src1**（两者分工不同，不能互换）：
  //   · src3 有 3 个可编译函数，每个 seed 贡献 3 次判定，抖动被压掉（见上面说明）；
  //   · src1 只有 1 个可编译函数，但它的**调用次数是已知的 2 次**，下面 P3-2/P3-3
  //     的篡改检出与「解码清零每次调用执行一遍」计数断言依赖这个性质。
  //     若把统计样例换成 src3，allD.code 就会带 3 个函数，计数断言要的 HIT2 变 HIT3。
  //
  // 阈值取「占比 ≥ 60%」而不是固定计数：src3 每 seed 3 次判定，8 seed 共 24 次，
  // 期望 18 次（75%），留 4 次的抖动余量。真退化（D 不再出现）会掉到 0，
  // 退化到 50% 时期望 12 次 < 14.4，同样会被抓住。
  const P3_SEEDS = 8;
  const P3_MIN_RATE = 0.6;
  let offBad = 0;
  let dCount = 0;
  let fnCount = 0;
  for (let seed = 1; seed <= P3_SEEDS; seed++) {
    const off = vmStatOf(obfuscate(src3, { preset: 'high', shell: false, vmDispatchEnc: false, integrityCheck: false, seed }));
    if (!off || off.forms.D !== 0) offBad++;
    const on = vmStatOf(obfuscate(src3, { preset: 'high', shell: false, vmDispatchEnc: true, integrityCheck: false, seed }));
    if (!on) continue;
    dCount += on.forms.D;
    fnCount += on.compiled;
  }
  const dRate = fnCount ? dCount / fnCount : 0;
  ok(offBad === 0, '关闭 vmDispatchEnc 时形态 D 不出现（' + P3_SEEDS + ' seed × 3 函数）');
  ok(dRate >= P3_MIN_RATE,
    '开启 vmDispatchEnc 时形态 D 成为主要形态（占比 ≥ ' + Math.round(P3_MIN_RATE * 100) + '%，设计值 75%）',
    dCount + '/' + fnCount + ' = ' + Math.round(dRate * 100) + '%');

  // 「全 D 构建」取自 src1：下面的双清零签名与计数断言要一个单函数产物
  let allD = null;
  for (let seed = 1; seed <= P3_SEEDS; seed++) {
    const rOn = obfuscate(src1, { preset: 'high', shell: false, vmDispatchEnc: true, integrityCheck: false, seed });
    const on = vmStatOf(rOn);
    if (on && on.compiled > 0 && on.forms.D === on.compiled) { allD = { seed, code: rOn.code }; break; }
  }
  ok(!!allD, '存在全 D 构建（分发映射全部进密文表）', allD ? 'seed=' + allD.seed : P3_SEEDS + ' 个 seed 都没出现全 D');

  // 全 D 构建的行为化验收：定位密文表 → 篡改必被检出 → 解码清零按调用次数执行
  if (allD) {
    const code = allD.code;
    // 形态 D 签名：解码收尾的两条相邻清零语句 C.length=0; BI.length=0;
    // 第一条名字必须能反查到一张纯数值大数组（≥9 元素，即 3 字 × ≥3 条目），
    // 排除恰好两连清零的其它结构
    const findArr = (text, name) => {
      const re = new RegExp('(var|,)\\s*' + escName(name) + '\\s*=\\s*\\[');
      const m = text.match(re);
      if (!m) return null;
      const start = m.index + m[0].length - 1;
      const end = text.indexOf(']', start); // 扁平整型数组无嵌套，首个 ] 即结尾
      if (end < 0) return null;
      return { start, end, text: text.slice(start + 1, end) };
    };
    const pairRe = new RegExp('(' + NAME + ')\\.length\\s*=\\s*0\\s*;\\s*(' + NAME + ')\\.length\\s*=\\s*0\\s*;', 'g');
    let pair = null;
    for (const m of code.matchAll(pairRe)) {
      const arr = findArr(code, m[1]);
      if (arr) {
        const elems = arr.text.split(',').map((s) => s.trim());
        if (elems.length >= 9 && elems.every((s) => Number.isFinite(Number(s)))) { pair = m; break; }
      }
    }
    ok(!!pair, '全 D 产物可定位「条目密文表 + 桶区间表」双清零签名');
    if (pair) {
      const cName = pair[1];
      // P3-2：翻转密文表中全部动作下标字（每条第目的第 3 个字），语义必然漂移
      const cArr = findArr(code, cName);
      const elems = cArr.text.split(',').map((s) => s.trim());
      const flipped = elems.map((s, i) => (i % 3 === 2 ? String(Number(s) ^ 1) : s)).join(',');
      const tampered = code.slice(0, cArr.start + 1) + flipped + code.slice(cArr.end);
      const got = runSafe(tampered, 'p3-tampered');
      ok(got !== want, '翻转密文表动作下标字即被检出（输出改变/抛错/超时）',
        got === want ? '篡改后输出不变' : got.slice(0, 40));
      // P3-3：在清零语句后注入计数探针，两次调用应恰好清零两次。
      // 注入文本必须以分号结尾：产物里清零语句之后可能紧跟 var 声明，
      // 少了分号会拼出 `+1var` 这种语法错误（真实的失败教训）
      const probed = code.replace(pairRe, (m) =>
        m + ';globalThis.__JSLB_P3HIT=(globalThis.__JSLB_P3HIT||0)+1;');
      const out2 = runSafe(probed + '\nif(globalThis.__JSLB_P3HIT!==undefined)process.stdout.write("|HIT"+globalThis.__JSLB_P3HIT);\n', 'p3-probe');
      // 样例自己的输出以 \n 结尾，探针计数另起一行；trim 只去首尾，中间的 \n 保留
      ok(out2 === want + '\n|HIT2', '解码与清零在每次调用时执行（2 次调用 → 计数 2）', JSON.stringify(out2).slice(0, 60));
    }
  }

  // P3-4 语义等价：medium（默认关）强制开与关，输出一致
  let semBad = 0;
  let semFirst = '';
  for (let seed = 1; seed <= 3; seed++) {
    for (const enc of [false, true]) {
      const code = obfuscate(src1, { preset: 'medium', shell: false, vmDispatchEnc: enc, seed }).code;
      let got;
      try { got = runNode(code, 'p3-sem-' + enc + '-' + seed).trim(); }
      catch (e) { got = 'THREW'; }
      if (got !== want) { semBad++; if (!semFirst) semFirst = 'enc=' + enc + ' seed=' + seed + ' → ' + got.slice(0, 40); }
    }
  }
  ok(semBad === 0, 'vmDispatchEnc 开与关的输出一致（medium × 3 seed）', semFirst);

  // P3-5 可复现：固定 seed 逐字节一致（enc 开）
  const ra = obfuscate(src1, { preset: 'high', shell: false, vmDispatchEnc: true, seed: 424242 }).code;
  const rb = obfuscate(src1, { preset: 'high', shell: false, vmDispatchEnc: true, seed: 424242 }).code;
  ok(ra === rb, 'vmDispatchEnc 开启下固定 seed 可复现');

  // P3-8 max 预设（含全部 VM 选项）语义不变
  let maxBad = 0;
  for (let seed = 1; seed <= 2; seed++) {
    const got = runNode(obfuscate(src1, { preset: 'max', seed }).code, 'p3-max-' + seed).trim();
    if (got !== want) maxBad++;
  }
  ok(maxBad === 0, 'max 预设语义不变（2 seed）');
}

section('P4：字节码分块自解密与可复现性');
{
  // 跳转密集样例：if/else 链、&&、??、循环回边——分块解密的块边界与跳转复位
  // 都在这里被踩到
  const jumpSrc = 'function work(a,b){var r=0;'
    + 'for(var i=0;i<a;i++){if(i%3===0){r+=i;}else if(i%3===1){r-=b&&1;}else{r^=i+3;}}'
    + 'var s=b??7;'
    + 'if(a>3&&b>0){r+=s;}else{r-=1;}'
    + 'while(r>100){r-=100;}'
    + 'if(r<0||s===0){r=r*-1+2;}'
    + 'return r;}'
    + 'process.stdout.write([work(17,3),work(4,0),work(25,9)].join(" ")+"\\n");';
  const want = runNode(jumpSrc, 'p4-want.js').trim();
  const vmStatOf = (r) => {
    const s = r.stats.find((x) => x.pass === 'vm');
    return s && s.result ? s.result : null;
  };

  // P4-5/P4-6 分块自解密：开与关，跳转密集样例全部正确
  let blkBad = 0;
  let blkFirst = '';
  for (const blk of [false, true]) {
    for (let seed = 1; seed <= 2; seed++) {
      const code = obfuscate(jumpSrc, {
        preset: 'high', shell: false, vmBlockDecrypt: blk, integrityCheck: false, seed,
      }).code;
      let got;
      try { got = runNode(code, 'p4-blk-' + blk + '-' + seed).trim(); } catch (e) { got = 'THREW'; }
      if (got !== want) { blkBad++; if (!blkFirst) blkFirst = 'blk=' + blk + ' seed=' + seed + ' → ' + got.slice(0, 40); }
    }
  }
  ok(blkBad === 0, 'vmBlockDecrypt 开与关输出一致（2 seed）', blkFirst);

  // P4-8 篡改块移位字面量即被检出：块号派生是取指式的一部分，改一位解密即错
  {
    // 必须隔离 wasm 档：块移位字面量在 **JS 侧取指式**里，而 high/max 现在默认走
    // wasm（取指搬进 WASM 模块），JS 产物里自然搜不到 >>>4/5/6。这条探针测的是
    // JS 侧那一层，所以显式关掉 wasm，与上面的 P4-5/P4-6 一样按档位分开测。
    const r = obfuscate(jumpSrc, { preset: 'high', shell: false, vmBlockDecrypt: true, integrityCheck: false, seed: 3, wasm: false, wasmInterpreter: false });
    let hit = 0;
    const patched = r.code.replace(/>>>\s*([456])(?![\d.])/g, (m, d) => {
      hit++;
      return '>>>' + (d === '6' ? '4' : Number(d) + 1);
    });
    if (hit === 0) {
      ok(false, '块移位字面量出现在取指式中', '产物里未找到 >>>4/5/6（结构变化，需更新探针）');
    } else {
      const file = path.join(TMP, 'p4-blk-tampered.js');
      fs.writeFileSync(file, patched);
      let got;
      try { got = runSync(process.execPath, [file], { encoding: 'utf8', timeout: 15000 }).trim(); }
      catch (e) { got = 'ERR'; }
      ok(got !== want, '篡改块移位字面量即被检出（' + hit + ' 处）',
        got === want ? '篡改后输出不变' : got.slice(0, 40));
    }
  }

  // P4-10 可复现：P3+P4 全开下固定 seed 逐字节一致
  {
    const opt = { preset: 'high', shell: false, vmBlockDecrypt: true, seed: 424242 };
    ok(obfuscate(jumpSrc, opt).code === obfuscate(jumpSrc, opt).code,
      'P3+P4 全开下固定 seed 可复现');
  }
}

// 执行护栏（vmStepLimit）：原嵌套内层档 vmNestedLimit 平移后的有界失败路径。
// while(true) + 极小步数 → 必须按 vmOverrun 抛错而非挂死；正常循环 + 大步数 → 语义正确。
section('执行护栏：vmStepLimit（栈机后端共用）');
{
  const infSrc = 'function f(){var i=0;while(true){i++;}return i;}\n'
    + 'try { f(); process.stdout.write("no-throw\\n"); } catch (e) { process.stdout.write("thrown:" + e.message.split("\\n")[0].slice(0, 20) + "\\n"); }';
  const okSrc = 'function f(){var s=0;for(var i=0;i<10;i++)s+=i;return s;}\n'
    + 'process.stdout.write(f() + "\\n");';
  let infBad = 0, okBad = 0, firstInf = '', firstOk = '';
  // 小步数：必须抛出带策文的 Error（message 含 "vm: 解释器执行超限"）
  const code1 = obfuscate(infSrc, {
    preset: 'high', seed: 7, shell: false, integrityCheck: false,
    wasm: false, wasmInterpreter: false, vmStepLimit: 2000,
  }).code;
  const out1 = runNode(code1, 'guard-inf.js').trim();
  if (!out1.startsWith('thrown:')) { infBad++; firstInf = out1.slice(0, 80); }
  // 大步数：正常跑完
  const code2 = obfuscate(okSrc, {
    preset: 'high', seed: 7, shell: false, integrityCheck: false,
    wasm: false, wasmInterpreter: false,
  }).code;
  const out2 = runNode(code2, 'guard-ok.js').trim();
  if (out2 !== '45') { okBad++; firstOk = out2.slice(0, 80); }
  ok(infBad === 0, 'vmStepLimit 生效：死循环按 vmOverrun 抛错', firstInf);
  ok(okBad === 0, 'vmStepLimit 默认足够大：正常循环得 45', firstOk);
}

// 多层 VM（2026-10-17 实测重写）：`vmLayers: 2` 现在**真的嵌套两层**（layers=2），
// 且跨 seed 稳定终止、输出正确。
//
// 旧记录两次都错在观测面：层 2 不是死循环，而是**极慢**——部分构建的分桶哈希退化
// （DISP_P1 只有 17 位，分发字 < 1024 时 `imul(d,P1) >>> SH` 只能落到 0/1 两个桶，
// 一次分发线性扫约 500 条），f(4) 要 3s~56s。修法见 vm.js 的 DISP_P1 注释（只放大
// 内层解释器的乘数，层 1 字节不变）。这里的断言因此钉两件事：**真嵌套** 与
// **跨 seed 的语义正确**；性能退化另有专门一节按超时判。
section('多层 VM：vmLayers=2 真嵌套，且跨 seed 语义正确');
{
  const src = 'function a(n){var s=0;for(var i=0;i<n;i++)s+=(i*7+3)%13;return s;}\n'
    + 'function b(x){if(x<0)return -x%7;return x*2+1;}\n'
    + 'process.stdout.write(a(200)+","+b(4)+","+b(-3)+"\\n");';
  const want = runNode(src, 'layers-want.js').trim();

  // 1 层与 2 层各跑一遍：layers 必须如实报出来（1 层不许被误报成 2 层）
  for (const l of [1, 2]) {
    const r = obfuscate(src, {
      preset: 'high', seed: 7, shell: false, integrityCheck: false,
      wasm: false, wasmInterpreter: false, vmLayers: l,
    });
    const st = r.stats.find((x) => x.pass === 'vm');
    const layers = st && st.result && st.result.layers;
    ok(layers === l, 'vmLayers=' + l + ' 实际层数如实上报', 'layers=' + layers);
    let got;
    try { got = runNode(r.code, 'layers-' + l + '.js').trim(); } catch (e) { got = 'THREW:' + String(e.message).slice(0, 40); }
    ok(got === want, 'vmLayers=' + l + ' 的产物语义正确', got.slice(0, 60));
  }

  // 跨 8 个 seed 的层 2：每个都必须跑完且结果一致（这是"概率性坏构建"的回归面）。
  // 旧实现里约 15% 的 seed 会慢到分钟级；现在每个 seed 都必须在秒级跑完。
  let bad = '';
  const t0 = Date.now();
  for (let seed = 1; seed <= 8 && !bad; seed++) {
    const r = obfuscate(src, {
      preset: 'high', seed, shell: false, integrityCheck: false,
      wasm: false, wasmInterpreter: false, vmLayers: 2,
    });
    const st = r.stats.find((x) => x.pass === 'vm');
    if (!(st && st.result && st.result.layers === 2)) {
      bad = 'seed=' + seed + ' layers=' + (st && st.result && st.result.layers);
      break;
    }
    let got;
    try { got = runNode(r.code, 'layers2-s' + seed + '.js').trim(); } catch (e) { got = 'THREW'; }
    if (got !== want) { bad = 'seed=' + seed + ' got=' + got.slice(0, 40); }
  }
  const ms = Date.now() - t0;
  ok(bad === '', 'vmLayers=2 跨 8 seed：全部 layers=2 且语义正确', bad);
  // 8 个 seed × 201 次循环：修好后实测 < 20s；退化的构建单 seed 就要几十秒到分钟。
  ok(ms < 90000, 'vmLayers=2 跨 8 seed 的总耗时在秒级（退化构建会远超）', ms + 'ms');
}

// vmLayers 的钳位与告警（2026-10-17 从 >1→1 放宽到 >2→2）。四个取值都钉：
// 1/2 原样生效且不告警；3/8 钳到 2 且告警点名请求值；每个都真跑一遍产物。
section('vmLayers：1/2 原样生效，>2 钳到 2 并告警');
{
  const src = 'function a(n){var s=0;for(var i=0;i<n;i++)s+=(i*7+3)%13;return s;}\n'
    + 'process.stdout.write(String(a(200)));';
  const want = runNode(src, 'layers-clip-want.js').trim();

  for (const asked of [1, 2]) {
    const r = obfuscate(src, { preset: 'high', seed: 7, shell: false, vmLayers: asked });
    const st = r.stats.find((x) => x.pass === 'vm');
    ok(st && st.result && st.result.layers === asked,
      'vmLayers=' + asked + ' 原样生效（不被钳）', 'layers=' + (st && st.result && st.result.layers));
    ok(!(r.warnings || []).some((x) => /vmLayers/.test(String(x))), 'vmLayers=' + asked + ' 不产生钳位告警');
    ok(runNode(r.code, 'layers-ok-' + asked + '.js').trim() === want,
      'vmLayers=' + asked + ' 的产物语义正确');
    // 构建期 IR 校验器：每个编译函数都过一遍（compiled 与 verified 对齐）
    const compiled = st && st.result && st.result.compiled;
    ok(st && st.result && (st.result.verified | 0) >= (compiled | 0) && (compiled | 0) > 0,
      'vmLayers=' + asked + ' 的每个编译函数都通过构建期 IR 校验',
      'verified=' + (st && st.result && st.result.verified) + ' compiled=' + compiled);
  }
  // 嵌套形态的外层步数闸门必须按 4096 倍放大：否则合法的重载荷会先撞 1e8 误报
  // vmOverrun（实测 2 万次循环即触发）。用 1e6 的 vmStepLimit 看产物里的字面量：
  // 层 2 应出现 4096000000，层 1 只应出现 1000000。
  {
    const r1s = obfuscate(src, { preset: 'high', seed: 7, shell: false, vmLayers: 1, vmStepLimit: 1000000 });
    const r2s = obfuscate(src, { preset: 'high', seed: 7, shell: false, vmLayers: 2, vmStepLimit: 1000000 });
    ok(r2s.code.includes('4096000000'), '层 2 的外层步数闸门按 4096 倍放大');
    ok(!r1s.code.includes('4096000000'), '层 1 不放大步数闸门（逐字节口径不变）');
  }
  for (const asked of [3, 8]) {
    const r = obfuscate(src, { preset: 'high', seed: 7, shell: false, vmLayers: asked });
    const st = r.stats.find((x) => x.pass === 'vm');
    ok(st && st.result && st.result.layers === 2,
      'vmLayers=' + asked + ' 被钳到 2', 'layers=' + (st && st.result && st.result.layers));
    const w = (r.warnings || []).map(String).find((x) => /vmLayers/.test(x));
    ok(!!w && w.includes(String(asked)), 'vmLayers=' + asked + ' 的钳位有告警且点名了请求值',
      (r.warnings || []).map(String).join(' | ').slice(0, 100));
    ok(runNode(r.code, 'layers-clip-' + asked + '.js').trim() === want,
      'vmLayers=' + asked + ' 钳到 2 后语义正确');
  }
}

// 分桶退化的回归（2026-10-17 定位到的"挂死"真因）：固定复现配方（preset low +
// vmDecoyOps 1024 + 分发表加密）下，旧构建的 `DISP_P1` 只有 17 位，`imul(d,P1) >>> SH`
// 只落 0/1 桶 → 每次分发线性扫约 500 条：f(4) 要 56s，300 次循环要上百秒。
// 修法是内层解释器改用 31 位奇数乘数（层 1 不变，见 vm.js 的 DISP_P1）。
// 判据用**硬超时**：退化构建 300 次循环 >100s，修好后 < 1s，15s 是安全的分界。
section('层 2 分桶分发：不退化成线性扫描（构建期哈希乘数）');
{
  const src = 'function f(n){var s=0;for(var i=0;i<300;i++){s+=(i*7+n)%13;}return s;}'
    + 'process.stdout.write(String(f(4)));';
  const want = runNode(src, 'layers-dispatch-want.js').trim();
  const r = obfuscate(src, {
    preset: 'low', seed: 3, shell: false, debugProtection: false, antiCDP: false,
    integrityCheck: false, selfDefending: false, envFingerprint: false, domainLock: false,
    wasm: false, wasmInterpreter: false, vmLayers: 2, vmProtection: true, mangle: false,
    stringArray: true, stringArrayThreshold: 1, vmThreshold: 1, vmDecoyOps: 1024,
    vmDispatchEnc: true, antiLLM: true, controlFlowFlattening: false,
    controlFlowLoopFlattening: false, deadCodeInjection: false, opaquePredicates: false,
    functionWrapper: false, callProxy: false, numberObfuscation: false, simplify: false,
    logicalExpressions: false, conditionObfuscation: false, transformTemplate: false,
    templateToConcat: false, unicodeStrings: false, stringConcat: false,
    objectKeyEncoding: false, renameProperties: false,
  });
  const st = r.stats.find((x) => x.pass === 'vm');
  ok(st && st.result && st.result.layers === 2, '复现配方下确实跑出层 2',
    'layers=' + (st && st.result && st.result.layers));
  const file = path.join(TMP, 'layers-dispatch.js');
  fs.writeFileSync(file, r.code);
  let got = '', timedOut = false;
  const t0 = Date.now();
  try {
    got = String(runSync(process.execPath, [file], { encoding: 'utf8', timeout: 15000 })).trim();
  } catch (e) {
    timedOut = !!(e && (e.killed || e.signal || e.code === 'ETIMEDOUT'));
    got = timedOut ? 'TIMEOUT' : 'THREW';
  }
  const ms = Date.now() - t0;
  ok(!timedOut, '层 2 的 300 次循环没有超时（退化构建需要上百秒）', ms + 'ms');
  ok(got === want, '层 2 的 300 次循环输出正确', String(got).slice(0, 40));
}

// 多层 VM × WASM 解释器内核（2026-10-17 随层 2 放开改写）。要点两条：
//   ① wasmInterpreter 下要嵌套的函数改走 JS 路径（bridge 体里没有可嵌套的解释器），
//      stats.nestedJs 计数；② layers 必须是 2、产物在规模样本上语义正确。
section('多层 VM × WASM：嵌套让路走 JS，层 2 语义正确');
{
  const src = 'function a(n){var s=0;for(var i=0;i<n;i++)s+=i;return s;}\n'
    + 'function b(x){if(x<0)return -x;return x*2+1;}\n'
    + 'process.stdout.write(a(200)+","+b(4)+","+b(-3)+"\\n");';
  const want = runNode(src, 'layers-wasm-want.js').trim();
  const r = obfuscate(src, {
    preset: 'high', seed: 7, shell: false, integrityCheck: false,
    wasmInterpreter: true, wasm: false, vmLayers: 2,
  });
  const st = r.stats.find((x) => x.pass === 'vm');
  const ws = r.stats.find((x) => (x.pass || '').startsWith('wasm'));
  ok(st && st.result && st.result.layers === 2, 'wasm 档下 vmLayers=2 同样嵌套 2 层',
    'layers=' + (st && st.result && st.result.layers));
  ok(st && st.result && (st.result.nestedJs | 0) >= 1, 'wasm 档下要嵌套的函数改走 JS 路径',
    'nestedJs=' + (st && st.result && st.result.nestedJs));
  ok(ws && ws.result && ws.result.smoke === 'ok', 'wasm 档冒烟通过',
    'smoke=' + (ws && ws.result && ws.result.smoke));
  let got;
  try { got = runNode(r.code, 'layers-wasm-2.js').trim(); } catch (e) { got = 'THREW'; }
  ok(got === want, 'wasm 档层 2 产物语义一致', got.slice(0, 60));
}


section('单层复杂度：融合关系跳转 + 流干扰 NOP');
{
  // JLT/JLTF 等 12 种融合跳转 + 流 NOP（8% 抽取）是单层 VM 的复杂度主体。
  // 融合与否只看测试形状（关系/恒等比较必融），与随机数无关；NOP 抽取看概率，
  // 3 组 seed 累计断言（两函数上百条指令，全抽不中概率可忽略）。
  const src = 'function f(n){var a=0;for(var i=0;i<n;i++){if(i%2===0){a+=i*3;}else{a-=1;}}return a;}\n'
    + 'function g(t){var s=0;while(s<t){s++;if(s>100){s-=50;}else if(s===7){s+=3;}}return s;}\n'
    + 'process.stdout.write(f(20)+","+g(9)+"\\n");';
  const want = runNode(src, 'sc-want.js').trim();
  let semBad = 0, firstSem = '', jumps = 0, nops = 0;
  for (const seed of [11, 12, 13]) {
    const r = obfuscate(src, { preset: 'high', seed, shell: false, wasm: false, wasmInterpreter: false });
    const st = r.stats.find((x) => x.pass === 'vm');
    jumps += (st && st.result && st.result.fused && st.result.fused.jumps) || 0;
    nops += (st && st.result && st.result.fused && st.result.fused.nops) || 0;
    let got;
    try { got = runNode(r.code, 'sc-' + seed + '.js').trim(); } catch (e) { got = 'THREW'; }
    if (got !== want) { semBad++; if (!firstSem) firstSem = 'seed=' + seed + ' → ' + got.slice(0, 60); }
  }
  ok(semBad === 0, '融合+NOP 下 3 seed 语义全部正确', firstSem);
  ok(jumps > 0, '融合关系跳转确实用上了（3 seed 共 ' + jumps + ' 条）', 'jumps=' + jumps);
  ok(nops > 0, '流干扰 NOP 确实注入了（3 seed 共 ' + nops + ' 条）', 'nops=' + nops);
}

// 回归防线：NOP 与「跳转链字 → 1 字指令 → 该跳转目标」的坏邻接。插入这种 NOP 会让链
// 求解出现 2-环，wordAt 对环上的链字保留首轮猜测且**静默**不自洽（不抛错），跳转落点
// 按错链值解密 → 落点是非法操作码 → 级联偏移。实测症状：整包输出乱码 / undefined /
// 提前 END，切 vmDynOpcodes:false 或 vmDecoyOps:0 各自能消掉症状。
//
// 样本是当时真实踩中的那个（for + if/else-if/else + ?? + && + while + ||），seed 与
// 配置逐条照抄当时失败的组合，所以断言是确定性的；下面再扫一圈别的 seed 防邻接形态变化。
section('回归：NOP 不许插在「跳转链字 ↔ 该跳转目标」之间（链求解 2-环）');
{
  const src = 'function work(a,b){var r=0;'
    + 'for(var i=0;i<a;i++){if(i%3===0){r+=i;}else if(i%3===1){r-=b&&1;}else{r^=i+3;}}'
    + 'var s=b??7;'
    + 'if(a>3&&b>0){r+=s;}else{r-=1;}'
    + 'while(r>100){r-=100;}'
    + 'if(r<0||s===0){r=r*-1+2;}'
    + 'return r;}'
    + 'process.stdout.write([work(17,3),work(4,0),work(25,9)].join(" ")+"\\n");';
  const want = runNode(src, 'chain-want.js').trim();
  // blk 关/开 × dynOps 开（踩中时 dynOps 是开的，且 enc 开）。wasm 关掉以隔离纯 JS 取指式。
  let bad = 0, first = '';
  let covered = 0;
  for (const blk of [false, true]) {
    for (let seed = 1; seed <= 4; seed++) {
      const r = obfuscate(src, {
        preset: 'high', seed, shell: false, integrityCheck: false,
        wasm: false, wasmInterpreter: false, vmBlockDecrypt: blk,
      });
      const st = r.stats.find((x) => x.pass === 'vm');
      const nops = (st && st.result && st.result.fused && st.result.fused.nops) || 0;
      if (nops > 0) covered++;
      let got;
      try { got = runNode(r.code, 'chain-' + blk + '-' + seed + '.js').trim(); } catch (e) { got = 'THREW'; }
      if (got !== want) { bad++; if (!first) first = 'blk=' + blk + ' seed=' + seed + ' → ' + got.slice(0, 60); }
    }
  }
  ok(bad === 0, '坏邻接被拦住：blk 开/关 × 4 seed 语义全对', first);
  // 覆盖确认：不能因为「一个 NOP 都没插」而假通过（那样这组断言是空跑的）
  ok(covered === 8, '8 组配置都真的注入了 NOP（断言非空跑）', 'covered=' + covered);
}

section('回归：VM 编译失败必须回滚半改写的函数体（不能留下剥掉 var 的 for-in）');
{
  // 2026-10-11 修掉的缺陷：compileFunction 中途抛错时，for-in/of 的 `s.left` 剥 var、
  // stripVars、rewriteFragStrings 等改写已经落到输入 AST 上，而 catch 只记 failed++。
  // 残留的 `for (k in …)`（k 已无声明）随后被构建后自检以"未绑定引用"拦下，整单构建抛错。
  // 修法是筛查通过后先 structuredClone 快照函数体，失败即换回；成功路径只多一次克隆，
  // 不消耗随机流，产物字节不变。
  //
  // 覆盖要点：65 形参保证走到 wasm 段（vmWasmTooManyParams）才抛——此时发射改写已发生；
  // controlFlow 关掉以免 for-in 在 vm 之前被改形；三件套缺一不可：failed 计数（真走了
  // 失败路径，否则是空跑）、`for (var` 仍在（回滚生效）、产物输出正确（回滚体语义完整）。
  const ps = Array.from({ length: 65 }, (_, i) => 'a' + (i + 1));
  const src = 'function f(' + ps.join(',') + '){var t=0;for(var k in {p:1,q:2}){t++;}return t+a1+a65;}'
    + 'var res=f(' + ps.map((_, i) => String(i + 1)).join(',') + ');'
    + 'process.stdout.write(String(res));';
  const want = runNode(src, 'vmfail-want.js').trim();
  let bad = '', failedTotal = 0, varKept = 0;
  for (const seed of [7, 42]) {
    let r = null, buildErr = '';
    try {
      r = obfuscate(src, {
        preset: 'high', seed, shell: false, integrityCheck: false,
        controlFlowFlattening: false, controlFlowLoopFlattening: false,
        wasm: false, wasmInterpreter: true, vmThreshold: 1,
      });
    } catch (e) { buildErr = String((e && e.message) || e).split('\n')[0]; }
    if (!r) { bad = 'seed=' + seed + ' 构建抛错：' + buildErr.slice(0, 80); break; }
    const st = r.stats.find((x) => x.pass === 'vm');
    failedTotal += (st && st.result && st.result.failed) || 0;
    if (/for\s*\(\s*var\b/.test(r.code)) varKept++;
    let got;
    try { got = runNode(r.code, 'vmfail-' + seed + '.js').trim(); } catch (e) { got = 'THREW'; }
    if (got !== want) { bad = 'seed=' + seed + ' 语义不对：实得 ' + got.slice(0, 40) + '，应为 ' + want; break; }
  }
  ok(!bad, '失败函数被回滚：构建成功、产物输出正确（2 seed）', bad);
  // 覆盖确认：failed 必须恰为 2（每 seed 各 1 次），否则函数可能因别的原因被提前筛掉，
  // 上面两条断言就成了空跑
  ok(failedTotal === 2, '两 seed 各走一次真实失败路径（failed=1+1）', 'failedTotal=' + failedTotal);
  ok(varKept === 2, '回滚后 `for (var` 声明仍在（不是半剥离的 `for (k in`）', 'varKept=' + varKept);
}

if (process.argv[1] && process.argv[1].endsWith('vm.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}
