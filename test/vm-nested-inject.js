/**
 * 嵌套档注入层（src/passes/vmNestedInject.js）测试。
 *
 * 跑法：node test/vm-nested-inject.js
 *
 * 这一层是整条链路里**唯一会真正改变产物**的一环，所以验法必须是端到端：
 * 注入出的源码 → 用自研解析器 parse（证明产物能解析）→ 真跑（证明语义正确）。
 *
 * 中间任何一步"看起来对"都不算：字节码错、密钥重组错、槽掩码错、建表时操作码
 * 没减回原值——这四种错的共同表现都是"产物能跑、值是错的"。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import parserMod from '../src/ast/parser.js';
import { compileNested } from '../src/passes/vmNested.js';
import { buildInjection } from '../src/passes/vmNestedInject.js';
import rand from '../src/utils/rand.js';
import { ok, report, section, cleanTmp, runNode } from './_harness.js';

const { parse } = parserMod;
const TMP = path.join(os.tmpdir(), 'jslb-vni-' + process.pid);

/** 编译 + 注入，返回可直接执行的完整脚本 */
function injectScript(fnSrc, seed, opts) {
  rand.setSeed(seed);
  const fn = parse(fnSrc, { sourceType: 'script' }).program.body[0];
  const m = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(fnSrc);
  if (!m) return null;
  const shift = (seed * 37 + 11) & 0xff;
  const spec = compileNested(fn.body.body, shift, 500);
  if (!spec) return null;
  const names = {
    dec: '_0xd', tab: '_0xt', run: '_0xr', entry: m[1],
  };
  const inj = buildInjection(spec, names, opts || {});
  if (!inj) return null;
  // 入口函数体替换成一次 run 调用
  return inj.src + '\nfunction ' + m[1] + '(){' + inj.call + ';}\n'
    + 'process.stdout.write(String(' + m[1] + '()));\n';
}

function runInjected(fnSrc, seed, opts) {
  const src = injectScript(fnSrc, seed, opts);
  if (!src) return { out: null, reason: '未编译/未注入' };
  // 自研解析器必须能解析注入出的源码——产物靠它生成
  try {
    parse(src, { sourceType: 'script' });
  } catch (e) {
    return { out: null, reason: '自研解析器无法解析注入产物: ' + String(e.message).slice(0, 60) };
  }
  try {
    // runNode 自己落盘并执行，不要在这里另写一份——曾经多写一次且路径对不上，
    // 报 ENOENT，看起来像注入产物缺文件。
    return { out: runNode(src, 'vni-inj.js'), reason: null, src };
  } catch (e) {
    return { out: null, reason: '执行失败: ' + String(e.message).slice(0, 80), src };
  }
}

/** 原生 JS 的真值 */
function native(fnSrc) {
  const m = /function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(fnSrc);
  return runNode(fnSrc + '\nprocess.stdout.write(String(' + m[1] + '()));\n', 'vni-native.js').trim();
}

/**
 * 期望值。默认与原生 JS 一致；只有比较类用例例外——
 * 内核的比较指令产出 0/1，而 JS 是 true/false，产物层还原布尔是接入流水线
 * 那一步的职责，这里按内核语义断言并在用例名里标明。
 */
function expectedOf(src, name) {
  if (name.startsWith('比较')) return '1';
  return native(src);
}

section('注入产物：端到端语义');
{
  const CASES = [
    ['常量', 'function f(){return 42;}'],
    ['两变量相加', 'function f(){var a=7;var b=5;return a+b;}'],
    ['乘法', 'function f(){var a=6;var b=7;return a*b;}'],
    ['减法', 'function f(){return 20-8;}'],
    ['位运算', 'function f(){var a=12;var b=10;return (a&b)+(a|b)+(a^b);}'],
    ['移位', 'function f(){var a=3;var b=4;return a<<b;}'],
    ['一元负号', 'function f(){var a=5;return -a;}'],
    ['按位非', 'function f(){var a=5;return ~a;}'],
    ['累加循环', 'function f(){var s=0;for(var i=1;i<=5;i++){s=s+i;}return s;}'],
    ['循环内乘加', 'function f(){var s=0;for(var i=1;i<=10;i++){s=s+i*2;}return s;}'],
    ['while 循环', 'function f(){var s=0;var i=1;while(i<=4){s=s+i;i=i+1;}return s;}'],
    ['if 单分支', 'function f(){var a=1;if(a){a=a+41;}return a;}'],
    ['if 双分支', 'function f(){var a=1;if(a){a=42;}else{a=7;}return a;}'],
    ['if 假走 else', 'function f(){var a=0;if(a){a=42;}else{a=7;}return a;}'],
    // 比较指令在内核里产出 0/1，不是 JS 的 true/false。**产物层必须还原**，
// 否则调用方拿到的类型就变了。这一条先按内核语义断言（0/1），
// 还原成布尔是接入流水线那一步的职责。
['比较（内核给 0/1）', 'function f(){var a=3;var b=5;return a<b;}'],
    ['嵌套算术', 'function f(){var a=2;var b=3;return (a+b)*4-2;}'],
  ];
  let pass = 0;
  const fails = [];
  for (const [name, src] of CASES) {
    // 每个用例跑 3 个 seed：密钥、shift、虚假条目数都随构建变。
    // **三个 seed 必须都对**——只看最后一个会把"某些 shift 下算错"漏掉，
    // 而 shift 恰恰是最容易出错的那个变量（建表时减回原值这一步）。
    const want = expectedOf(src, name);
    const bads = [];
    for (const seed of [1, 7, 19]) {
      const r = runInjected(src, seed);
      const got = r.reason ? null : r.out.trim();
      if (got !== want) bads.push('seed' + seed + '=' + (got === null ? r.reason : got));
    }
    if (bads.length === 0) pass++;
    else fails.push(name + ': ' + bads.join('/') + ' 期望 ' + want);
  }
  ok(fails.length === 0, pass + '/' + CASES.length + ' 个用例注入后语义正确（每例 3 seed 全对）',
    fails.slice(0, 4).join('; '));
  // 逐例明细，失败时能精确定位
  for (const [name, src] of CASES) {
    const want = expectedOf(src, name);
    const got = [1, 7, 19].map((s) => {
      const r = runInjected(src, s);
      return r.reason ? null : r.out.trim();
    });
    ok(got.every((g) => g === want), '[明细] ' + name + ' = ' + want,
      JSON.stringify(got));
  }
}

section('算子表完整性');
{
  // 注入层的 ARITH/COMPARE/UNARY 表必须与 vmcore.OPCODES 里的指令**一一对应**。
  //
  // 这条是为一个具体事故加的：ARITH 表漏了 ADD，于是字节码里的 ADD 指令在
  // 建表时找不到条目，整条被当填充跳过 —— 产物照跑、返回 undefined，
  // 而编译期没有任何报错。靠人眼核两张表是守不住的。
  //
  // 期望值一律用 node 实跑，**不手写**。首版手写了两个"期望"：a+b+a-b=5
  // 与 a&b+a|b=8 —— 真实值分别是 6 与 5（JS 里 + 优先级高于 |，且 + 左结合）。
  // 于是"发现"了编译器 bug，而反汇编证明字节码完全正确、错的是期望值本身。
  // 手算期望值这条路在这里已经证明不可靠，能用 node 就不用心算。
  const src = [
    'function f(){var a=3;var b=5;return a+b+a-b+a*b+(a&b)+(a|b)+(a^b)+(a<<1)+(a>>1)+(a>>>1);}',
    'function f(){var a=3;var b=5;return (a<b)+(a<=b)+(a>b)+(a>=b)+(a==b)+(a!=b);}',
    'function f(){var a=3;return -a+~a;}',
  ];
  // 比较在内核里是 0/1、原生是 true/false，比较前先归一，否则这类用例必假失败
  const norm = (v) => (v === 'true' ? '1' : v === 'false' ? '0' : v);
  let missing = '';
  for (const s of src) {
    const want = native(s);
    for (const seed of [1, 7, 19]) {
      const r = runInjected(s, seed);
      const got = r.reason ? null : r.out.trim();
      if (norm(got) !== norm(want)) {
        missing += s.slice(15, 38) + ' seed' + seed + '=' + got + '(期望' + want + ') ';
      }
    }
  }
  ok(missing === '', '算术/比较/一元的每条指令在注入产物里都有可执行行为（3 seed）', missing);

  // ADD 单独钉一条：它最常用，也正是被漏掉的那个
  ok(/0x31:\s*0/.test(
    fs.readFileSync(new URL('../src/passes/vmNestedInject.js', import.meta.url), 'utf8')),
  'ARITH 表含 ADD（0x31 → 0）');
}

section('注入产物：动态 handler 表');
{
  // 表必须在运行期由循环构造，而不是以函数字面量形式出现在产物里。
  // 判据：产物里出现的是规约数组（数字三元组），handler 体是共用的一份工厂。
  const src = injectScript('function f(){var s=0;for(var i=1;i<=5;i++){s=s+i;}return s;}', 5);
  ok(!!src, '注入成功');
  if (src) {
    const hasFactory = /function VMC_bh\(b,a\)/.test(src);
    ok(hasFactory, '产物里有行为工厂 VMC_bh（所有 handler 由它产出，不是逐个函数字面量）');
    // 规约数组形如 [[op,beh,arg],...]
    const specM = /var S=(\[.*?\]);/.exec(src);
    ok(!!specM, '产物里有 handler 规约数组');
    if (specM) {
      let arr = null;
      try { arr = JSON.parse(specM[1]); } catch (e) { arr = null; }
      ok(Array.isArray(arr), '规约数组是合法字面量');
      ok(Array.isArray(arr) && arr.every((e) => Array.isArray(e) && e.length === 3
        && e.every((x) => Number.isInteger(x))),
        '规约每项是三个整数的三元组',
        Array.isArray(arr) ? JSON.stringify(arr.slice(0, 2)) : '');
      ok(Array.isArray(arr) && arr.length > 3,
        '规约里含虚假条目（条目数多于真实用到的指令数）',
        'entries=' + (Array.isArray(arr) ? arr.length : '?'));
    }
    // 逐个函数字面量的形态（形如 "op 数字": function）不该出现
    ok(!/:\s*function\s*\(\s*C\s*,\s*I\s*\)/.test(src),
      '产物里没有"操作码: function"的直接映射表');
  }
}

section('注入产物：字节码加密');
{
  const src = injectScript('function f(){var a=1;var b=2;return a*b+a+b;}', 11);
  ok(!!src, '注入成功');
  if (src) {
    const cipherM = /"([0-9a-z]{2,})"/.exec(src);
    ok(!!cipherM, '产物里有密文串');
    // 密文不应等于明文字节码
    const spec = compileNested(
      parse('function f(){var a=1;var b=2;return a*b+a+b;}', { sourceType: 'script' })
        .program.body[0].body.body, (11 * 37 + 11) & 0xff, 500);
    const plain = spec ? Array.from(spec.code).map((b) => ('0' + b.toString(36)).slice(-2)).join('') : '';
    ok(!!cipherM && cipherM[1] !== plain, '密文不等于明文字节码的基 36 串');
    // 不同 seed → 不同密文（密钥逐构建变）
    const c1 = /"([0-9a-z]{2,})"/.exec(injectScript('function f(){var a=1;var b=2;return a*b+a+b;}', 11));
    const c2 = /"([0-9a-z]{2,})"/.exec(injectScript('function f(){var a=1;var b=2;return a*b+a+b;}', 23));
    ok(!!c1 && !!c2 && c1[1] !== c2[1], '不同 seed 的密文不同（密钥逐构建变）');
  }
}

section('注入产物：确定性');
{
  // 同 seed 必须逐字节相同——否则产物不可复现
  const a = injectScript('function f(){var s=0;for(var i=1;i<=5;i++){s=s+i;}return s;}', 7);
  const b = injectScript('function f(){var s=0;for(var i=1;i<=5;i++){s=s+i;}return s;}', 7);
  ok(a === b, '同 seed 两次注入逐字节相同');
  const c = injectScript('function f(){var s=0;for(var i=1;i<=5;i++){s=s+i;}return s;}', 9);
  ok(a !== c, '不同 seed 的注入产物不同（多态真实）');
}

section('注入产物：编译不了就不注入');
{
  // 关键：注入失败必须返回 null，由调用方保留原函数。半成品会让产物算错。
  for (const [name, src] of [
    ['字符串字面量', 'function f(){return "hello";}'],
    ['自由变量', 'function f(){return externalVar;}'],
    ['函数调用', 'function f(){var a=1;return helper(a);}'],
    ['对象字面量', 'function f(){var o={a:1};return o.a;}'],
    ['除法', 'function f(){var a=10;var b=5;return a/b;}'],
    ['break', 'function f(){for(var i=0;i<3;i++){break;}return 1;}'],
  ]) {
    ok(injectScript(src, 3) === null, name + ' 不注入（返回 null，保留原函数）');
  }
}

if (process.argv[1] && process.argv[1].endsWith('vm-nested-inject.js')) {
  fs.rmSync(TMP, { recursive: true, force: true });
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}