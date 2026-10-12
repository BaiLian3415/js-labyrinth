#!/usr/bin/env node
/**
 * 基础混淆 pass：逻辑表达式、数值常量、多态可复现、控制流扁平化。
 *
 *   node test/passes-basic.js
 *
 * 整跑全部用例：npm test（即 node test/selftest.js）。
 */
import { cleanTmp, ok, report, runNode, section } from './_harness.js';
import obfuscateMod from '../src/obfuscate.js';
import parserMod from '../src/ast/parser.js';
import keysMod from '../src/ast/keys.js';
import traverseMod from '../src/ast/traverse.js';
import generatorMod from '../src/ast/generator.js';
import numberObf from '../src/passes/numberObf.js';
import rand from '../src/utils/rand.js';

const { obfuscate } = obfuscateMod;
const { parse } = parserMod;
const traverse = traverseMod.default || traverseMod;
const generate = generatorMod.default || generatorMod;
section('逻辑表达式取值语义');
{
  // 2026-09-19 修掉的静默正确性缺陷：logicalExpr 原先把 `a || b` 交换成 `b || a`，
  // 依据是"两侧都是原子时求值结果不变"。但 && 与 || 返回的是**操作数的值**而非布尔：
  // `3 || 1` 得 3，`1 || 3` 得 1，交换会改值。原先这里只打一行提示、不判失败，
  // 理由是"原版也这样"——可它产出的是**语义不同的代码且不报错**，属于最危险的一类，
  // 必须判失败。修复后仅当两侧都恒为布尔（比较、!、布尔字面量）才允许交换。
  //
  // 命中依赖随机数，所以每个例子跑 10 个 seed：修复前实测约 3/16 会改坏，
  // 4 例 × 10 seed 漏检概率可忽略。
  const cases = [
    'function m(b) { var v = 0; v = v + (b || 1); return v; } console.log(m(0), m(3));',
    'function m(b) { var v = 0; v += b || 1; return v; } console.log(m(0), m(3));',
    'function m(b) { var v = 0; v += b && 2; return v; } console.log(m(0), m(3));',
    'function m(b) { var v = 10; v -= b || 1; return v; } console.log(m(0), m(3));',
  ];
  let mismatch = 0;
  let firstBad = '';
  for (let ci = 0; ci < cases.length; ci++) {
    const src = cases[ci] + '\n';
    const want = runNode(src, 'logi-plain-' + ci + '.js').trim();
    for (let seed = 1; seed <= 10; seed++) {
      const got = runNode(obfuscate(src, { preset: 'medium', seed }).code,
        'logi-' + ci + '-' + seed + '.js').trim();
      if (got !== want) {
        mismatch++;
        if (!firstBad) firstBad = '例' + ci + ' seed=' + seed + '：混淆后 ' + got + '，应为 ' + want;
      }
    }
  }
  ok(mismatch === 0, '逻辑表达式作运算数时取值语义保持（4 例 × 10 seed）', firstBad);
}

section('数值常量混淆');
{
  // 整数字面量被改写成恒等表达式，最容易出的错是"看起来恒等、求值不恒等"：
  // 0 与 -0、超过 2^31 的异或、键位与成员位被误改。这里覆盖这四类，跨 6 个
  // seed 跑 medium 与 high（阈值 0.5 / 0.8），命中依赖随机数，单 seed 不够。
  const cases = [
    'var a=[10,20,30];console.log(a[0]+a[2], a.length, 1/0, -7+3);',
    'function f(x){if(x===1024){return "k";}return -(255)+0;}console.log(f(1024),f(1),Object.is(-0,0-0));',
  ];
  let mismatch = 0;
  let firstBad = '';
  for (let ci = 0; ci < cases.length; ci++) {
    const src = cases[ci] + '\n';
    const want = runNode(src, 'num-plain-' + ci + '.js').trim();
    for (const preset of ['medium', 'high']) {
      for (let seed = 1; seed <= 6; seed++) {
        const got = runNode(obfuscate(src, { preset, seed }).code,
          'num-' + ci + '-' + preset + '-' + seed + '.js').trim();
        if (got !== want) {
          mismatch++;
          if (!firstBad) firstBad = '例' + ci + ' ' + preset + ' seed=' + seed + '：' + got + ' 应为 ' + want;
        }
      }
    }
  }
  ok(mismatch === 0, '数值常量改写后取值语义保持（2 例 × 2 预设 × 6 seed）', firstBad);

  // MBA（混合布尔算术）：位算与算术交织的恒等式。这里钉的是两件事——
  //   ① 取值恒等，尤其是 `(x & y) << 1` 那条：x + y = V 时 x&y ≤ V/2，
  //      所以左移不会翻负；把取值域放宽到 2^31 就会静默算错，边界值必须覆盖；
  //   ② 默认关、max 开：不改既有预设基线，且开关真的生效（不是只加了选项名）。
  {
    const vals = [2, 3, 4, 7, 8, 255, 256, 65535, 65536, 1048575, 1048576,
      0x1ffff, 0x20000, 0x3fffffe, 0x3fffffff];
    const mbaSrc = 'var o=[];\n'
      + vals.map((v) => `o.push(${v});`).join('\n')
      + '\nprocess.stdout.write(JSON.stringify(o));\n';
    const mbaWant = runNode(mbaSrc, 'mba-plain.js');
    let mbaBad = '';
    for (let seed = 1; seed <= 5 && !mbaBad; seed++) {
      const got = runNode(obfuscate(mbaSrc, {
        preset: 'medium', seed, numberObfuscationMBA: true,
        numberObfuscationThreshold: 1,
      }).code, 'mba-' + seed + '.js');
      if (got !== mbaWant) mbaBad = 'seed=' + seed + '：' + got.slice(0, 60) + ' 应为 ' + mbaWant.slice(0, 60);
    }
    ok(mbaBad === '', 'MBA 恒等式取值语义保持（边界值 × 5 seed）', mbaBad);

    const stMax = obfuscate(mbaSrc, { preset: 'max', seed: 3, shell: false }).stats
      .find((s) => s.pass === 'numberObf');
    ok(stMax && stMax.result.mba === true, 'max 预设启用 MBA', JSON.stringify(stMax && stMax.result));

    const on = obfuscate(mbaSrc, { preset: 'medium', seed: 3, shell: false, numberObfuscationMBA: true, numberObfuscationThreshold: 1 }).code;
    const off = obfuscate(mbaSrc, { preset: 'medium', seed: 3, shell: false, numberObfuscationMBA: false, numberObfuscationThreshold: 1 }).code;
    ok(on !== off, 'MBA 开关真的改变产物（不是空开关）');

    // 形态特征：位算与算术算子交织在同一棵表达式里。
    //
    // 这里**直接单跑 numberObf pass**，不走 obfuscate 的整条流水线。原因：这条形状
    // 不是 MBA 专属——外壳完整性校验里那段 Math.imul(h ^ s.charCodeAt(i), 16777619)
    // 就同时带 & 和 <<，RT 内核、字符串池、控制流也都会产出这类交织。整跑时命中与否
    // 取决于其它 pass 恰好 drew 了什么（实测开壳 8 个 seed 只命中 6 个），于是这条
    // 断言有两条坏路径：MBA 坏掉时可能照样绿（匹配到壳的代码），MBA 正常时也可能
    // 红（被别的 pass 的随机性带偏）。单跑 pass 后产物里只有 MBA 恒等式，形状只能
    // 来自它自己：实测关 MBA 时 8 个 seed 全部 0 处命中，开 MBA 时每档 4~8 处。
    const SHAPE_RE = /(?:&[^;]*\)\s*<<|&[^;]*\)\s*[+*]|[-+]\s*\([^()]*&)/;
    const runPass = (mba, seed) => {
      rand.setSeed(seed);
      const ast = parse(mbaSrc, { sourceType: 'script' });
      const stats = numberObf(ast,
        { numberObfuscationThreshold: 1, numberObfuscationMBA: mba },
        { traverse, rng: rand.rand, usedNames: new Set(), rt: null });
      const out = generate(ast, { compact: true });
      return { stats, code: typeof out === 'string' ? out : out.code };
    };
    const offHits = [];
    const onHits = [];
    for (let seed = 1; seed <= 8; seed++) {
      offHits.push(runPass(false, seed).code);
      onHits.push(runPass(true, seed).code);
    }
    const cleanMiss = offHits.map((c, i) => (SHAPE_RE.test(c) ? i + 1 : 0)).filter(Boolean);
    ok(cleanMiss.length === 0, '关 MBA 时产物里一处该形态都没有（形状确实来自 MBA）',
      '命中的 seed：' + (cleanMiss.join(',') || '（无）'));
    const onMiss = onHits.map((c, i) => (SHAPE_RE.test(c) ? 0 : i + 1)).filter(Boolean);
    ok(onMiss.length === 0, '开 MBA 时每个 seed 都出现该形态', '未命中的 seed：' + (onMiss.join(',') || '（无）'));
    // 单跑 pass 时 8 个 seed 的 replaced 数应当一致（阈值 1、无其他 pass 干扰），
    // 说明上面两组的差异只来自 MBA 开关本身。
    const repOn = runPass(true, 1).stats.replaced;
    const repOff = runPass(false, 1).stats.replaced;
    ok(repOn === repOff && repOn > 0,
      '单跑时开关只改写法不改替换数量（replaced=' + repOn + '/' + repOff + '）');
  }
}

section('多态与可复现');
{
  const src = 'function add(a,b){return a+b;}console.log(add(2,3));';
  // 固定 seed 必须逐字节复现，这是"可复现构建"的底线，也是上面几组语义测试
  // 能定位到具体 seed 的前提
  const a = obfuscate(src, { preset: 'medium', seed: 424242 }).code;
  const b = obfuscate(src, { preset: 'medium', seed: 424242 }).code;
  ok(a === b, '同一 seed 两次构建逐字节相同');

  // 多态：不同 seed 的产物不仅是常量不同，连标识符集合与分派结构都不同。
  // 只比字节会漏掉"只换常量不换结构"的假多态，所以同时看标识符集合的重叠度
  const ids = (code) => {
    const set = new Set();
    for (const m of code.matchAll(/[\p{L}_$][\p{L}\p{N}_$]*/gu)) set.add(m[0]);
    return set;
  };
  const s1 = obfuscate(src, { preset: 'medium', seed: 11 }).code;
  const s2 = obfuscate(src, { preset: 'medium', seed: 12 }).code;
  const i1 = ids(s1);
  const i2 = ids(s2);
  let shared = 0;
  for (const n of i1) if (i2.has(n)) shared++;
  const overlap = shared / Math.max(1, Math.min(i1.size, i2.size));
  ok(s1 !== s2, '不同 seed 的产物不同');
  ok(overlap < 0.6, '不同 seed 的标识符集合重叠度低于 60%（结构级多态）',
    '重叠度 ' + overlap.toFixed(2));

  // 跨 seed 结构多态（2026-10 多态混淆）：上面只看了标识符集合，这里看骨架。
  // 口径有二：① AST 归一化 token（名字/字面量抹掉，只留节点类型与算子拼写）
  // bigram 多重集 Jaccard——常量与改名对此口径不可见，只有语句形态分叉才算数；
  // ② 原始 token bigram Jaccard（名字常量保留，最接近文本相似度工具的读数）。
  // 引导器语句多态 + 解码三形态 + 原语多族 + VM/解释器形态多态把它们分别从
  // ~0.93/~0.39 压下来；阈值是防回退的棘轮（4 seed 6 对里取 max，28 对全采样
  // max 结构 0.91、原文 0.37，留余量）。
  {
    const { VISITOR_KEYS } = keysMod;
    const structToks = (ast) => {
      const out = [];
      const walk = (node) => {
        if (!node || typeof node.type !== 'string') return;
        switch (node.type) {
          case 'Identifier': out.push('ID'); return;
          case 'StringLiteral': out.push('STR'); return;
          case 'NumericLiteral': out.push('NUM'); return;
          case 'BooleanLiteral': out.push('BOOL'); return;
          case 'NullLiteral': out.push('NULL'); return;
          case 'RegExpLiteral': out.push('REGEX'); return;
          case 'TemplateLiteral': out.push('TPL'); break;
          case 'BinaryExpression': case 'LogicalExpression':
            out.push('Bin:' + node.operator); break;
          case 'UnaryExpression': out.push('Una:' + node.operator); break;
          case 'UpdateExpression':
            out.push('Upd:' + node.operator + (node.prefix ? ':pre' : ':post')); break;
          case 'AssignmentExpression': out.push('Assign:' + node.operator); break;
          case 'VariableDeclaration': out.push('Decl:' + node.kind); break;
          case 'MemberExpression': out.push(node.computed ? 'Mem:C' : 'Mem:D'); break;
          case 'CallExpression': out.push('Call'); break;
          case 'NewExpression': out.push('New'); break;
          case 'FunctionDeclaration': case 'FunctionExpression':
          case 'ArrowFunctionExpression': out.push('Func'); break;
          default: out.push(node.type);
        }
        const ks = VISITOR_KEYS[node.type] || [];
        for (const k of ks) {
          const v = node[k];
          if (Array.isArray(v)) { for (const c of v) walk(c); }
          else if (v && typeof v.type === 'string') walk(v);
        }
      };
      walk(ast.type === 'File' && ast.program ? ast.program : ast);
      return out;
    };
    const rawToks = (code) => {
      const toks = [];
      const re = /([A-Za-z_$][\w$]*)|(\d+(?:\.\d+)?)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|\s+|(.)/g;
      let m;
      while ((m = re.exec(code))) {
        if (m[1]) toks.push('ID:' + m[1]);
        else if (m[2]) toks.push('NUM:' + m[2]);
        else if (m[3]) toks.push('STR');
        else if (m[4] === undefined) { /* 空白跳过 */ }
        else toks.push(m[4]);
      }
      return toks;
    };
    const bigramJ = (a, b) => {
      const cnt = (toks) => {
        const m = new Map();
        for (let i = 0; i + 1 < toks.length; i++) {
          const k = toks[i] + '\x00' + toks[i + 1];
          m.set(k, (m.get(k) || 0) + 1);
        }
        return m;
      };
      const A = cnt(a), B = cnt(b);
      let inter = 0, union = 0;
      for (const [k, v] of A) { inter += Math.min(v, B.get(k) || 0); union += Math.max(v, B.get(k) || 0); }
      for (const [k, v] of B) { if (!A.has(k)) union += v; }
      return inter / Math.max(1, union);
    };
    const stJ = bigramJ(
      structToks(parse(s1, { sourceType: 'script' })),
      structToks(parse(s2, { sourceType: 'script' })));
    const rawJ = bigramJ(rawToks(s1), rawToks(s2));
    // 再加两组 seed，6 对里取 max：单对撞大运（同形态全中）拉不出回退，其它对能。
    const s3 = obfuscate(src, { preset: 'medium', seed: 13 }).code;
    const s4 = obfuscate(src, { preset: 'medium', seed: 14 }).code;
    const codes = [s1, s2, s3, s4];
    let stMax = 0, rawMax = 0;
    for (let i = 0; i < codes.length; i++) {
      for (let j = i + 1; j < codes.length; j++) {
        stMax = Math.max(stMax, bigramJ(
          structToks(parse(codes[i], { sourceType: 'script' })),
          structToks(parse(codes[j], { sourceType: 'script' }))));
        rawMax = Math.max(rawMax, bigramJ(rawToks(codes[i]), rawToks(codes[j])));
      }
    }
    ok(stJ < 0.92 && stMax < 0.92, '不同 seed 的归一化结构 bigram 相似度低于 92%（骨架级多态）',
      '结构相似度 单对 ' + stJ.toFixed(3) + ' / 6 对 max ' + stMax.toFixed(3));
    ok(rawJ < 0.4 && rawMax < 0.4, '不同 seed 的原始文本 bigram 相似度低于 40%',
      '原文相似度 单对 ' + rawJ.toFixed(3) + ' / 6 对 max ' + rawMax.toFixed(3));

    // 原生函数单点收敛（2026-10）：fromCharCode / charCodeAt / Uint8Array 在外层
    // 产物里各只允许声明行那 1 处，调用点一律走别名。数之前先剥字符串字面量，
    // 免得池密文里的巧合子串干扰计数（12/10 字符的长名不会出现在随机名里，
    // split/join 短则可能，故一律先剥）。
    // 本组数与抽取形态无关，4 seed 全断言：
    //   fromCharCode 恒 1（引导器别名声明；解码器里的在壳内密文里，不可见）；
    //   charCodeAt 恒 2（别名声明 1 + 引导 FNV 6 族各 1）；
    //   Uint8Array 恒 1（别名声明）。
    // split/join 随形态浮动，只设上限防回退（8 seed 实测 max split=2/join=3；
    // join 含二次流水线 stringArray 自带的一处，模板侧最多 2 处）。
    {
      const stripStr = (code) => code.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""');
      const count = (code, name) => (stripStr(code).match(new RegExp(name, 'g')) || []).length;
      let natBad = '';
      for (const [i, code] of codes.entries()) {
        const fcc = count(code, 'fromCharCode');
        const cca = count(code, 'charCodeAt');
        const u8 = count(code, 'Uint8Array');
        const sp = count(code, 'split');
        const jn = count(code, 'join');
        if (fcc !== 1 || cca !== 2 || u8 !== 1 || sp > 2 || jn > 3) {
          natBad = 'seed=' + [11, 12, 13, 14][i] + ' fromCharCode=' + fcc
            + ' charCodeAt=' + cca + ' Uint8Array=' + u8 + ' split=' + sp + ' join=' + jn;
          break;
        }
      }
      ok(!natBad, '原生函数名出现次数收敛（fromCharCode=1/charCodeAt=2/Uint8Array=1/split≤2/join≤3）', natBad);
    }
  }

  // 运行期滚动重键：开关两态都得跑得对，且产物不同
  const base = {
    preset: 'medium', vmProtection: false, stringArray: false,
    debugProtection: false, envFingerprint: false, integrityCheck: false,
    shell: false, mangle: false, controlFlowFlattening: true,
    controlFlowDepth: 2, controlFlowThreshold: 1, controlFlowProbability: 1,
  };
  const cfSrc = 'function f(n){var a=0;for(var i=0;i<n;i++){if(i%2===0){a+=i*3;}else{a-=1;}}return a;}\nconsole.log(f(3),f(7),f(20));';
  const cfWant = runNode(cfSrc, 'cf-plain.js').trim();
  let cfBad = 0;
  const outs = [];
  for (const rolling of [false, true]) {
    for (let seed = 1; seed <= 3; seed++) {
      const code = obfuscate(cfSrc, { ...base, controlFlowRollingKey: rolling, seed }).code;
      outs.push(code);
      if (runNode(code, 'cf-' + rolling + '-' + seed + '.js').trim() !== cfWant) cfBad++;
    }
  }
  ok(cfBad === 0, '分派表滚动重键开与关的语义都正确（2 × 3 seed）');
  ok(outs[0] !== outs[3], '滚动重键改变了产物结构（同 seed 下开与关不同）');
}

section('控制流扁平化：大函数体');
{
  // 回归：flatten 原先是"先递归算剩余列表"的尾递归（flatten(list.slice(1), next)），
  // 递归深度等于语句条数——一个几千条语句的函数体（打包产物的 IIFE、代码生成器的
  // 输出）就会 "Maximum call stack size exceeded"，且每层复制数组是 O(n²)。
  // 改成从尾到头倒序迭代后，条数只受内存限制。12000 条在改动前必爆，用它守住。
  const parts = ['function big(){'];
  for (let i = 0; i < 12000; i++) parts.push('var v' + i + ' = ' + i + ' + String(' + i + ').length;');
  parts.push('var s = 0;');
  parts.push('for (var k = 0; k < 20; k++) { if (k % 3 === 0) { s += k; } else { s += v0 + v11999; } }');
  parts.push('return [v0, v11999, s].join("|");');
  parts.push('}');
  parts.push('console.log(big());');
  const bigSrc = parts.join('\n');
  const want = runNode(bigSrc, 'cf-big-plain.js').trim();

  let code = '';
  let err = '';
  try {
    code = obfuscate(bigSrc, { preset: 'low', seed: 20260920 }).code;
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  ok(!err, '12000 条语句的函数体不触发栈溢出（原实现必爆）', err);
  ok(!!code && runNode(code, 'cf-big-obf.js').trim() === want, '大函数体产物语义与原源码一致');
}

section('控制流扁平化：恒真谓词包裹不许"零语义"折叠');
{
  // 旧形态是 `cond ? A : A`——两臂逐字相同，任何工具（AST 比较两臂，甚至三行正则）
  // 都能不看语义直接折成 `A`，30% 的状态写入包裹等于没加。现在两臂语义恒等但**文本
  // 不同**（`A` 与 `(0,A)`/`(void 0,A)`），且谓词逐构建从 5 种位运算/typeof 恒等式里挑。
  //
  // 判据放在 AST 上（比正则可靠）：统计"两臂结构相等"的三元节点数。注意要关掉 VM，
  // 否则函数被搬进字节码解释器，扁平化根本不落在这段代码上——第一版度量就是这么
  // 得出"0 个谓词"的假结论。别的 pass 也可能产出结构相等的三元（实测偶发 0~1 个），
  // 所以阈值取 ≤1，而改造前是每 seed 5~10 个。
  const src = [
    'function a(x){if(x>3){return x*2}else{return x-1}}',
    'function b(x){var s=0;for(var i=0;i<x;i++){if(i%2){s+=i}else{s-=1}}return s}',
    'function c(x){if(x){if(x>10){return 1}else{return 2}}else{return 3}}',
    'console.log(a(4)+b(4)+c(4));',
  ].join('\n');
  const strip = (n) => {
    if (!n || typeof n !== 'object') return n;
    if (Array.isArray(n)) return n.map(strip);
    const o = {};
    for (const k of Object.keys(n)) {
      if (k === 'start' || k === 'end' || k === 'loc' || k === 'extra') continue;
      o[k] = strip(n[k]);
    }
    return o;
  };
  const walk = (n, fn) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach((c) => walk(c, fn)); return; }
    if (n.type) fn(n);
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      walk(n[k], fn);
    }
  };
  let worstSame = 0;
  let worstSeed = 0;
  for (const seed of [11, 22, 33, 44]) {
    const code = obfuscate(src, {
      preset: 'medium', seed, shell: false, bannerSkip: true,
      vmProtection: false, controlFlowFlattening: true,
    }).code;
    const ast = parse(code, { sourceType: 'script' });
    let same = 0;
    walk(ast, (n) => {
      if (n.type !== 'ConditionalExpression') return;
      if (JSON.stringify(strip(n.consequent)) === JSON.stringify(strip(n.alternate))) same++;
    });
    if (same > worstSame) { worstSame = same; worstSeed = seed; }
  }
  ok(worstSame <= 1, '恒真谓词的两臂不再结构相等（零语义折叠失效）',
    '最多 ' + worstSame + ' 个（seed ' + worstSeed + '），改造前每 seed 5~10 个');
}

section('死代码注入：守卫不许出现自反 `X !== X`（单规则可折叠）');
{
  // 旧形态有一路 `g !== g`（pick === 9，10%）：自反规则三行正则即折叠为 false，
  // 与另三路数论谓词（模 3 同余、位模式、进位奇偶）强度断层，等于白送一个定位器。
  // 2026-10-11 删掉该分支并入数论谓词。
  //
  // 判据放在 AST 上：统计"两侧结构相等"的 `!==` 测试 if。junk 语句只产表达式语句、
  // 永不产 if；别的 pass 的 `!==`（快照比对、翻转）两侧恒不同——能命中这个形状的
  // 只有死代码守卫。seed 取旧码实测 nổ 过的 [1,7,11,19]（旧码在 20 seed 里 nổ 11 个，
  // 本组旧码计 2+2+1+4 = 9 处），新码必须全 0。
  const src = [
    'function a(x){var s=x+1;if(s>2){s+=x;}else{s-=1;}return s;}',
    'function b(x){var s=0;for(var i=0;i<x;i++){if(i%2){s+=i;}else{s-=2;}}return s;}',
    'function c(x){var s=x;s*=2;if(s>100){s-=50;}return s;}',
    'process.stdout.write([a(4),b(5),c(60)].join(" "));',
  ].join('\n');
  const strip = (n) => {
    if (!n || typeof n !== 'object') return n;
    if (Array.isArray(n)) return n.map(strip);
    const o = {};
    for (const k of Object.keys(n)) {
      if (k === 'start' || k === 'end' || k === 'loc' || k === 'extra') continue;
      o[k] = strip(n[k]);
    }
    return o;
  };
  const walk = (n, fn) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach((c) => walk(c, fn)); return; }
    if (n.type) fn(n);
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      walk(n[k], fn);
    }
  };
  let worst = 0, worstSeed = 0;
  for (const seed of [1, 7, 11, 19]) {
    const code = obfuscate(src, { preset: 'medium', seed, shell: false, bannerSkip: true }).code;
    const ast = parse(code, { sourceType: 'script' });
    let n = 0;
    walk(ast, (x) => {
      if (x.type !== 'IfStatement' || !x.test || x.test.type !== 'BinaryExpression') return;
      if (x.test.operator !== '!==') return;
      if (JSON.stringify(strip(x.test.left)) === JSON.stringify(strip(x.test.right))) n++;
    });
    if (n > worst) { worst = n; worstSeed = seed; }
  }
  ok(worst === 0, '死代码守卫无自反恒假（`g !== g` 已删）', '最多 ' + worst + ' 处（seed ' + worstSeed + '）');
}

section('控制流扁平化：死 case 谓词不许字面量自反（`g===g` 类）');
{
  // 死 case 的旧谓词只有两路字面量自反：`guard===guard` 与 `(guard^65280)===` 同形，
  // 不看任何上下文就能折掉，grep 个 65280 即定位全部假 case。2026-10-11 改为复用
  // assignState 的 5 种位运算/typeof 恒等式（依赖 live 的 state 变量，判定需位级推理）。
  // 死状态永不命中，谓词永不求值，无运行期语义影响。
  //
  // 判据只认旧两式的精确形状（数字自等 / 含 65280 的同形两侧），opaque 的 `g===g`
  //（标识符两侧）与快照比对（两侧恒不同）都不会误伤。seed 取旧码实测 nổ 过的
  // [1,9,14]（旧码计 3+6+5 = 14 处），新码必须全 0。注意关掉 VM，否则函数被搬进
  // 字节码解释器，扁平化不落可见代码（见上一节注释）。
  const src = [
    'function a(x){var s=0;for(var i=0;i<x;i++){if(i%2){s+=i;}else{s-=1;}}return s;}',
    'function b(x){var s=x;if(s>3){s*=2;}else{s+=10;}while(s>100){s-=7;}return s;}',
    'process.stdout.write([a(9),b(4)].join(" "));',
  ].join('\n');
  const strip = (n) => {
    if (!n || typeof n !== 'object') return n;
    if (Array.isArray(n)) return n.map(strip);
    const o = {};
    for (const k of Object.keys(n)) {
      if (k === 'start' || k === 'end' || k === 'loc' || k === 'extra') continue;
      o[k] = strip(n[k]);
    }
    return o;
  };
  const walk = (n, fn) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach((c) => walk(c, fn)); return; }
    if (n.type) fn(n);
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      walk(n[k], fn);
    }
  };
  const has65280 = (n) => {
    let found = false;
    walk(n, (x) => { if (x.type === 'NumericLiteral' && x.value === 65280) found = true; });
    return found;
  };
  let worst = 0, worstSeed = 0;
  for (const seed of [1, 9, 14]) {
    const code = obfuscate(src, {
      preset: 'medium', seed, shell: false, bannerSkip: true,
      vmProtection: false, controlFlowFlattening: true,
    }).code;
    const ast = parse(code, { sourceType: 'script' });
    let n = 0;
    walk(ast, (x) => {
      if (x.type !== 'IfStatement' || !x.test || x.test.type !== 'BinaryExpression') return;
      if (x.test.operator !== '===') return;
      const L = x.test.left, R = x.test.right;
      if (L.type === 'NumericLiteral' && R.type === 'NumericLiteral' && L.value === R.value) { n++; return; }
      if (JSON.stringify(strip(L)) === JSON.stringify(strip(R)) && (has65280(L) || has65280(R))) n++;
    });
    if (n > worst) { worst = n; worstSeed = seed; }
  }
  ok(worst === 0, '死 case 谓词无字面量自反（`65280` 指纹已消失）', '最多 ' + worst + ' 处（seed ' + worstSeed + '）');
}

section('条件混淆：Yoda 式（字面量左置）真实出现');
{
  // 新增的第五类变换：`x===1` 写成 `1===x`（=== 复用 morph.yodaEq，!== 保持算子
  // 换两侧；==/!= 不做，morph 的等价证书只到 ===/!== 为止）。门限 0.2 先于方向翻转。
  //
  // 判据：字面量在左、标识符在右的 ===/!==（fixture 里比较一律写成标识符在左，
  // 别的变换都不移动字面量到左侧：FLIP/!! 保序，SWAP 只动关系算子，numberObf
  // 把字面量展成表达式而非搬家）。隔离配置关掉 VM/完整性/数字改写/死代码——
  // 机器代码与 junk 都可能偶发同形（旧码 20 seed 里 junk 巧合出 4 处），隔离后
  // 该形态唯一对应 Yoda：旧码 20 seed 全 0，新码 20 seed 全 nổ。seed 取 [1,2,3]
  //（新码计 2+2+3 处），断言每 seed ≥1 且产物语义正确。
  const src = [
    'function f(x,y){var t=(x!==2);var u=(y===3);while(x>0){if(x===1){t+=u;}else{t-=1;}x--;}return t+(y===x?100:0);}',
    'process.stdout.write(String(f(3,5)));',
  ].join('\n');
  const walk = (n, fn) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach((c) => walk(c, fn)); return; }
    if (n.type) fn(n);
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      walk(n[k], fn);
    }
  };
  const countYoda = (code) => {
    let n = 0;
    walk(parse(code, { sourceType: 'script' }), (x) => {
      if (x.type !== 'BinaryExpression') return;
      if (x.operator !== '===' && x.operator !== '!==') return;
      if (x.left && x.left.type === 'NumericLiteral' && x.right && x.right.type === 'Identifier') n++;
    });
    return n;
  };
  const opts = (seed) => ({
    preset: 'medium', seed, shell: false, bannerSkip: true,
    vmProtection: false, integrityCheck: false, numberObfuscation: false,
    deadCodeInjection: false,
  });
  const want = runNode(src, 'yoda-want.js').trim();
  let bad = '';
  for (const seed of [1, 2, 3]) {
    const code = obfuscate(src, opts(seed)).code;
    if (countYoda(code) < 1) { bad = 'seed=' + seed + ' 没出现 Yoda 形态'; break; }
    let got;
    try { got = runNode(code, 'yoda-' + seed + '.js').trim(); } catch (e) { got = 'THREW'; }
    if (got !== want) { bad = 'seed=' + seed + ' 语义不对：实得 ' + got.slice(0, 40) + '，应为 ' + want; break; }
  }
  ok(!bad, 'Yoda 式出现且语义正确（3 seed）', bad);
}

section('方法名/类字段名入池（objectKeys 的定义点）');
{
  // objectKeys 原先只转 ObjectProperty 与 MemberExpression：调用点早就是下标形态，
  // 但**定义点**的键一直是明文，`{zzRender(){}}` / `class{zzRender(){}}` 是产物里唯一
  // 还能被静态 grep 出来的 API 面。下面这组按老码必 FAIL / 新码必 PASS 的口径写。
  //
  // 判别样本用 zz 前缀的自造名：产物里的机器名是 hex 十六进制，不可能含非 hex 字母，
  // 所以明文计数不会被 `identifierPrefix` 生成的 `_0x…` 误伤。
  const mkSrc = [
    'const zzObj = {',
    '  zzGreet(n) { return "hi " + n; },',
    '  get zzSize() { return 3; },',
    '  async zzLoad() { return 1; },',
    '};',
    'class ZzWidget {',
    '  constructor(v) { this.v = v; }',
    '  zzRender(m) { let s = 0; for (let i = 0; i < 3; i++) s += i; return "r:" + m + this.v + s; }',
    '  static zzMake() { return new ZzWidget(1); }',
    '  get zzLabel() { return "L"; }',
    '  zzField = 7;',
    '  static zzStatic = 8;',
    '};',
    'process.stdout.write([',
    '  zzObj.zzGreet("a"), zzObj.zzSize, new ZzWidget(2).zzLabel,',
    '  ZzWidget.zzMake().v, new ZzWidget(3).zzRender("x"), new ZzWidget(1).zzField,',
    '  ZzWidget.zzStatic,',
    '].join("|"));',
  ].join('\n');
  const NAMES = ['zzGreet', 'zzSize', 'zzLoad', 'zzRender', 'zzMake', 'zzLabel', 'zzField', 'zzStatic'];
  const plainCount = (code) => NAMES.reduce((n, name) => n +
    (code.match(new RegExp('(?<![A-Za-z0-9_$])' + name + '(?![A-Za-z0-9_$])', 'g')) || []).length, 0);

  const base = { preset: 'high', shell: false, integrityCheck: false };

  // ① 明文方法名/字段名必须归零。老码基线：定义点各留 1 处（调用点早已转下标）。
  {
    let bad = '';
    for (const seed of [1, 2, 3]) {
      const n = plainCount(obfuscate(mkSrc, { ...base, seed }).code);
      if (n > 0) { bad = 'seed=' + seed + ' 仍留 ' + n + ' 处明文方法名'; break; }
    }
    ok(!bad, '方法名与类字段名不落明文（3 seed，老码各留 1 处）', bad);
  }

  // ② 生成器必须成对支持 computed 类键。直接喂"键不是合法属性名"的计算键：
  // 老生成器忽略 computed 直接印 key，产出的 class 体是语法错误（`"a"+"b"(){}`），
  // 重新解析即炸——这正是接线时最容易漏、且只在解析期才暴露的一处。
  {
    let bad = '';
    const cases = [
      'class A { ["a"+"b"](){} }',
      'class A { ["p"+"q"]=1; }',
      'class A { static ["s"+"t"](){} }',
      'class A { get ["g"+"h"](){ return 1; } }',
      'var o = { ["x"+"y"](){}, ["m"+"n"]: 1 };',
    ];
    for (const c of cases) {
      const out = generate(parse(c, { sourceType: 'script' })).code;
      try { parse(out, { sourceType: 'script' }); } catch (e) { bad = c + ' → 往返后不可解析：' + out.slice(0, 60); break; }
    }
    ok(!bad, '生成器支持 computed 类方法/类字段/对象方法键', bad);
  }

  // ③ VM 已编译的方法，其键同样要转。这条单独钉住"守卫看方法自身"的写法：
  //   insideVmFunction 从节点向上找，方法体被 VM 编译时方法节点自身即命中，
  //   于是最常见的情形（普通类方法进 VM）被整个跳过，实测 8 个方法名漏 7 个。
  //   先断言 vm 确实编译了这些方法，防止将来 vm 阈值变化让本用例空转。
  //   stats 是 [{pass, result, ms}] 数组，不是按 pass 名的对象。
  {
    let bad = '';
    const r = obfuscate(mkSrc, { ...base, seed: 5, vmProtection: true });
    const entry = (r.stats || []).find((e) => e.pass === 'vm');
    const compiled = entry && entry.result ? entry.result.compiled : 0;
    if (!(compiled > 0)) { bad = 'vm 未编译任何函数（compiled=' + compiled + '），本用例失去判别力'; }
    else {
      const n = plainCount(r.code);
      if (n > 0) bad = 'vm 已编译 ' + compiled + ' 个函数，仍留 ' + n + ' 处明文方法名';
    }
    ok(!bad, 'VM 编译过的方法其键照样转（守卫只看容器）', bad);
  }

  // ④ 语义逐位不变：把全部形态一次跑齐（构造/取值/静态/字段/异步/生成器/私有名）。
  {
    const src = [
      'const zzObj = {',
      '  zzGreet(n) { return "hi " + n; },',
      '  get zzSize() { return 3; },',
      '  set zzSize(v) { this._s = v; },',
      '  async zzLoad() { return 1; },',
      '  *zzGen() { yield 1; yield 2; },',
      "  'zz-dash'() { return 'dash'; },",
      '  constructor() { return "ctor"; },',
      '  __proto__() { return "proto"; },',
      '};',
      'class ZzWidget {',
      '  constructor(v) { this.v = v; }',
      '  zzRender(m) { let s = 0; for (let i = 0; i < 3; i++) s += i; return "r:" + m + this.v + s; }',
      '  static zzMake() { return new ZzWidget(1); }',
      '  get zzLabel() { return "L"; }',
      '  static async zzFetch() { return 5; }',
      '  *zzIter() { yield 9; }',
      '  zzField = 7;',
      '  static zzStatic = 8;',
      '  #zzPriv = 9;',
      '  zzPriv() { return this.#zzPriv; }',
      '}',
      'const zzW = new ZzWidget(2);',
      'zzObj.zzSize = 11;',
      'const zzOut = [zzObj.zzGreet("a"), zzObj.zzSize, zzObj._s, zzW.zzLabel, ZzWidget.zzMake().v,',
      '  zzW.zzRender("x"), zzW.zzField, ZzWidget.zzStatic, zzW.zzPriv(),',
      '  zzObj["zz-dash"](), zzObj.constructor(), zzObj.__proto__()].join("|");',
      'let zzIt = [];',
      'for (const x of zzObj.zzGen()) zzIt.push(x);',
      'for (const y of zzW.zzIter()) zzIt.push(y);',
      'Promise.all([zzObj.zzLoad(), ZzWidget.zzFetch()]).then((v) => {',
      '  process.stdout.write(zzOut + "|" + zzIt.join(",") + "|" + v.join(","));',
      '});',
    ].join('\n');
    const want = runNode(src, 'mk-want.js').trim();
    let bad = '';
    const cases = [
      ['low', {}, {}], ['medium', {}, {}], ['high', {}, {}], ['max', {}, {}],
      ['high', { nameStyle: 'Mangled-props' }, {}],
      ['max', { nameStyle: 'Mangled-shuffled-props' }, {}],
      ['low', { vmProtection: false }, {}],
      ['high', { stringArray: false }, {}],
      ['high', { objectKeyEncoding: true, reservedStrings: ['^zzRender$'] }, { expectPlain: ['zzRender'] }],
    ];
    for (const [preset, extra, expect] of cases) {
      const r = obfuscate(src, { preset, seed: 7, shell: false, integrityCheck: false, ...extra });
      let got;
      try { got = runNode(r.code, 'mk-' + preset + '-' + Object.keys(extra).join('')).trim(); }
      catch (e) { got = 'THREW'; }
      if (got !== want) { bad = preset + ' ' + JSON.stringify(extra) + ' 实得 ' + got.slice(0, 60) + '，应为 ' + want.slice(0, 60); break; }
      // ⑤ 选项面：关掉 objectKeyEncoding 就必须回到明文（选项被尊重）。
      if (extra.objectKeyEncoding === false && plainCount(r.code) === 0) {
        bad = 'objectKeyEncoding:false 仍把方法名藏起来了，选项没被尊重'; break;
      }
      // ⑥ reservedStrings 承诺"该串不收集/不拆分"，方法键命中即必须保持明文。
      for (const nm of (expect.expectPlain || [])) {
        const c = (r.code.match(new RegExp('(?<![A-Za-z0-9_$])' + nm + '(?![A-Za-z0-9_$])', 'g')) || []).length;
        if (c === 0) { bad = 'reservedStrings 命中的 ' + nm + ' 仍被隐藏，保留名单失效'; break; }
      }
      if (bad) break;
    }
    ok(!bad, '方法名入池后语义逐位不变 + 选项面被尊重（9 组配置）', bad);
  }

  // ⑦ 三处禁改面：类 constructor（转计算键会让类丢掉构造函数）、对象 __proto__ 方法、
  //    私有名键。三者共同点是老码天然满足、新码一旦写错就静默坏语义——
  //    constructor 那条最毒：`new` 直接抛，而产物在构建期完全正常。
  {
    let bad = '';
    const src = [
      'class ZzC { constructor(v) { this.v = v; } zzM() { return this.v * 2; } }',
      'var zzO = { __proto__() { return "pm"; } };',
      'class ZzD { #zzP = 3; zzGet() { return this.#zzP; } }',
      'process.stdout.write(new ZzC(21).zzM() + zzO.__proto__() + new ZzD().zzGet());',
    ].join('\n');
    const want = runNode(src, 'mk-skip-want.js').trim();
    const r = obfuscate(src, { preset: 'high', seed: 11, shell: false, integrityCheck: false });
    // constructor 键必须保持非计算
    const ctorComputed = (() => {
      const walk = (n, fn) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach((c) => walk(c, fn)); return; }
        if (n.type) fn(n);
        for (const k of Object.keys(n)) { if (k === 'loc' || k === 'start' || k === 'end') continue; walk(n[k], fn); }
      };
      let hit = false;
      walk(parse(src, { sourceType: 'script' }), (x) => {
        if (x.type === 'ClassMethod' && x.key && x.key.name === 'constructor' && x.computed) hit = true;
      });
      return hit;
    })();
    // 这是对**源码**的静态核对：确认源里的 constructor 键确实是非计算的，
    // 从而产物里它一定保持明文 constructor —— 即下面的明文断言才有判别力。
    if (ctorComputed) bad = '样本前提错误：源里的 constructor 键是计算键';
    else if (!/(?<![A-Za-z0-9_$])constructor(?![A-Za-z0-9_$])/.test(r.code)) bad = 'constructor 键被隐藏了（不该转）';
    let got;
    try { got = runNode(r.code, 'mk-skip.js').trim(); } catch (e) { got = 'THREW'; }
    if (!bad && got !== want) bad = '禁改面样本语义不对：实得 ' + got.slice(0, 40) + '，应为 ' + want;
    ok(!bad, 'constructor / __proto__ / 私有名键不转，语义正确', bad);
  }
}

if (process.argv[1] && process.argv[1].endsWith('passes-basic.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}
