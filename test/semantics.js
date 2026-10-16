#!/usr/bin/env node
/**
 * 语义保持扫描。零依赖，按需跑（不进 npm test，太慢）：
 *
 *   node test/semantics.js                 # 全部用例 × 四个预设 × 3 个 seed
 *   node test/semantics.js --quick         # 只跑 low/medium，1 个 seed
 *   node test/semantics.js -p medium -s 8  # 指定预设与 seed 数
 *   node test/semantics.js -f 逻辑          # 只跑名字含该子串的用例
 *
 * 做法：每个用例都是一段自带 console.log 的完整小程序。先跑原始源码记下输出，
 * 再逐预设逐 seed 混淆后运行，输出必须逐字符相同。
 *
 * 为什么要有这个：今天（2026-09-19）连撞两个静默缺陷——wasm junk 段随机压坏
 * 参数表、logicalExpr 把 `a || b` 交换成 `b || a`（`||` 返回操作数的值，不是布尔）。
 * 两者都不报错，产物"看起来能跑"，只是结果不对。单元断言抓不到这种，必须真的
 * 把产物跑起来比对输出。
 *
 * 命中依赖随机数，所以每个用例要跨多个 seed 跑——单次跑过不代表没问题。
 *
 * 有一处必须显式覆盖预设默认值：**consoleStub 关掉**。max 预设默认开着它，会把
 * console.* 置空，而本文件的用例全是 console.log 程序——不关的话 max 档 44/44
 * 全灭，且症状（实得空串）与"产物算错了"无法从报告上区分。详见下面循环里的注释。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import obfuscateMod from '../src/obfuscate.js';

const { obfuscate, resolveOptions } = obfuscateMod;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 用例集。每条都是一段能独立跑出确定输出的程序。
 * 覆盖面刻意对着各个 pass 来：逻辑/比较运算、复合赋值、三元、字符串与模板、
 * 对象键、类与 this、闭包、异常、循环、解构、短路求值的副作用顺序。
 */
const CASES = [
  // ---- 逻辑运算与取值语义（logicalExpr 的重点）----
  ['逻辑 or 作运算数', 'function m(b){var v=0;v=v+(b||1);return v;}console.log(m(0),m(3),m(-1));'],
  ['逻辑 and 作运算数', 'function m(b){var v=0;v=v+(b&&2);return v;}console.log(m(0),m(3),m(-1));'],
  ['复合赋值 += 与 or', 'function m(b){var v=0;v+=b||1;return v;}console.log(m(0),m(3));'],
  ['复合赋值 -= 与 or', 'function m(b){var v=10;v-=b||1;return v;}console.log(m(0),m(3));'],
  ['复合赋值 *= 与 and', 'function m(b){var v=2;v*=b&&3;return v;}console.log(m(0),m(4));'],
  ['or 返回对象', 'function m(a,b){return a||b;}console.log(JSON.stringify(m(null,{x:1})),JSON.stringify(m({y:2},{z:3})));'],
  ['and 返回原值', 'function m(a,b){return a&&b;}console.log(m(1,"s"),m(0,"s"),m("",5));'],
  ['nullish 不误伤', 'function m(b){var v=0;v+=b??7;return v;}console.log(m(0),m(3),m(null),m(undefined));'],
  ['嵌套逻辑链', 'function m(a,b,c){return a||b||c;}console.log(m(0,0,3),m(1,2,3),m(0,2,0));'],
  ['逻辑运算作条件', 'function m(a,b){if(a>1||b>1)return "big";return "small";}console.log(m(0,2),m(0,0),m(3,0));'],
  ['三元的真值语义', 'function m(a,b){return a?b:a;}console.log(m(0,9),m(5,9),m("",1),m("x",1));'],
  ['取反与真值', 'function m(a){return !a;}console.log(m(0),m(1),m(""),m("x"),m(null));'],
  ['De Morgan 两侧', 'function m(a,b){return !(a&&b);}console.log(m(1,1),m(1,0),m(0,0));'],
  ['短路副作用顺序', 'var log=[];function t(x){log.push(x);return x;}var r=t(0)||t(1)||t(2);console.log(r,log.join(","));'],
  ['and 短路副作用顺序', 'var log=[];function t(x){log.push(x);return x;}var r=t(1)&&t(2)&&t(0);console.log(r,log.join(","));'],

  // ---- 比较与数值 ----
  ['比较运算取值', 'console.log(1<2,2<=2,3>4,4>=4,1==1,1===1,1!=2,1!==2);'],
  ['位运算与负数', 'console.log(-1>>>0,(-5)|0,5&3,5^3,1<<31,(1<<31)>>31);'],
  ['浮点与 NaN', 'console.log(0.1+0.2,NaN===NaN,isNaN(NaN),1/0,-1/0);'],
  ['字符串比较', 'console.log("a"<"b","10"<"9","abc"==="abc");'],

  // ---- 字符串与模板 ----
  ['模板字面量', 'var n=3,s="x";console.log(`a${n}b${s}c`, `${n+1}`);'],
  ['字符串方法', 'var s="Hello World";console.log(s.length,s.toUpperCase(),s.indexOf("o"),s.slice(0,5));'],
  ['转义与 Unicode', 'console.log("tab\\there","nl\\nend","\\u4e2d\\u6587","\\u{1F600}".length);'],

  // ---- 对象与键 ----
  ['对象键访问', 'var o={a:1,"b-c":2,3:"three"};console.log(o.a,o["b-c"],o[3]);'],
  ['键名是关键字', 'var o={if:1,class:2,default:3};console.log(o.if,o.class,o.default);'],
  ['计算键', 'var k="dyn";var o={[k]:1,[k+"2"]:2};console.log(o.dyn,o.dyn2);'],
  ['getter 副作用', 'var n=0;var o={get v(){n++;return n;}};console.log(o.v,o.v,n);'],
  ['in 与 hasOwnProperty', 'var o={a:1};console.log("a" in o,"b" in o,o.hasOwnProperty("a"));'],

  // ---- 类与 this ----
  ['类方法与 this', 'class C{constructor(s){this.v=s;}inc(b){this.v+=b||1;return this.v;}}var c=new C(3);console.log(c.inc(0),c.inc(4));'],
  ['类静态与继承', 'class A{static s(){return "A";}m(){return "a";}}class B extends A{m(){return "b"+super.m();}}console.log(A.s(),new B().m());'],
  ['类字段与方法简写', 'class C{v=1;get d(){return this.v*2;}m(){return this.v;}}var c=new C();console.log(c.v,c.d,c.m());'],

  // ---- 闭包与函数 ----
  ['闭包计数器', 'function mk(){var n=0;return function(){return ++n;};}var f=mk();console.log(f(),f(),f());'],
  ['默认参数与 rest', 'function f(a,b=2,...r){return a+b+r.length;}console.log(f(1),f(1,3),f(1,3,4,5));'],
  ['解构参数', 'function f({a,b=9},[c,d]){return a+b+c+d;}console.log(f({a:1},[2,3]));'],
  ['递归', 'function fib(n){return n<2?n:fib(n-1)+fib(n-2);}console.log(fib(10));'],
  ['IIFE 与作用域', 'var x=1;var r=(function(){var x=2;return x;})();console.log(x,r);'],

  // ---- 控制流 ----
  ['switch 与穿透', 'function f(n){var r="";switch(n){case 1:r+="a";case 2:r+="b";break;default:r+="z";}return r;}console.log(f(1),f(2),f(9));'],
  ['try/catch/finally', 'function f(){try{throw new Error("e");}catch(e){return "c:"+e.message;}finally{}}console.log(f());'],
  ['循环与 break/continue', 'var r=[];for(var i=0;i<6;i++){if(i===2)continue;if(i===5)break;r.push(i);}console.log(r.join(","));'],
  ['for-of 与 for-in', 'var a=[1,2];var s=0;for(var v of a)s+=v;var k=[];for(var p in {x:1,y:2})k.push(p);console.log(s,k.join(","));'],
  ['while 与 do-while', 'var i=0;while(i<3)i++;var j=0;do{j++;}while(j<2);console.log(i,j);'],
  ['标签与嵌套跳出', 'var r=[];outer:for(var i=0;i<3;i++){for(var j=0;j<3;j++){if(j===1)continue outer;r.push(i+":"+j);}}console.log(r.join(","));'],

  // ---- 边界 ----
  ['空函数与 undefined', 'function f(){}console.log(f(),typeof undefined,typeof null);'],
  ['数组方法链', 'console.log([3,1,2].sort().map(function(x){return x*2;}).join("-"));'],
  // 块级作用域的函数绑定（2026-10-16 补）。整份用例集原先几乎全是 `var` + 函数声明，
  // 于是漏掉了一个 P0：integrityCheck 的校验器体里曾对每个绑定发
  // `if(REF){REF[prop]+=delta}`，而校验器会被机层预注册循环在**任何用户代码之前**调用
  // ——`const f = () => {}` 在那一刻是 TDZ，`typeof f` 同样抛（TDZ 上 typeof 也
  // ReferenceError，守卫救不了），产物加载即挂。`const` + 箭头函数是现代 JS 最常见的
  // 写法，用例集必须钉住它。
  ['const 箭头函数', 'const f=(n)=>n*2;console.log(f(21));'],
  ['let 箭头函数与后置引用', 'let f=(n)=>n+1;const g=()=>f(41);console.log(g());'],
  ['const 函数表达式', 'const f=function(n){return n-1;};console.log(f(43));'],
  ['const 类表达式', 'const C=class{constructor(v){this.v=v;}get x(){return this.v;}};console.log(new C(9).x);'],
  ['const 箭头函数互相引用', 'const a=(n)=>n*3;const b=(n)=>a(n)+1;console.log(b(14));'],
  ['const 箭头函数闭包与默认参数', 'const mk=(k)=>(v=2)=>v*k;console.log(mk(3)(),mk(3)(4));'],
  ['立即返回对象', 'function f(){return {a:1,b:function(){return 2;}};}console.log(f().a,f().b());'],
];

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jslb-sem-'));

// stdio 显式写成数组：默认的 stdin 管道在部分 Windows 环境（父进程标准句柄来自
// 上层宿主）会让 spawnSync 直接 EBUSY，整份比对会在第一个用例崩掉。
const SYNC_STDIO = ['ignore', 'pipe', 'pipe'];

// 单次执行的超时上限，按预设分档。
//
// 原先一律 20s。实测 max 档产物**合法地**要 10~25s：shell 的解码循环是主要
// 成本（同一份源码 max 无壳只要 0.16s，加壳后 9~22s，665KB 产物），而且波动很大
// ——取决于构建期随机出来的引导器结构与机器负载。于是 20s 卡在正常区间中间，
// 表现为随机的 ETIMEDOUT：整轮 528 次比对里 3~5 个用例随机翻车，看起来像语义
// 不一致，实际是超时。
//
// 这里不是"把断言放宽"：真正的死循环仍然会被任何有限超时抓到，这里只是把上限
// 抬到 max 档的正常耗时之上，并且对便宜的预设保持原来的 20s，不拖慢整体。
const RUN_TIMEOUT = { low: 20000, medium: 20000, high: 30000, max: 90000 };

/** 跑一段代码，返回 stdout（去掉尾空白）；抛错则返回带标记的字符串。 */
function runCode(code, tag, timeoutMs) {
  const f = path.join(TMP, tag + '.js');
  fs.writeFileSync(f, code);
  try {
    return execFileSync(process.execPath, [f],
      { encoding: 'utf8', timeout: timeoutMs || 20000, stdio: SYNC_STDIO }).trim();
  } catch (e) {
    const out = (e.stdout || '').toString().trim();
    const err = (e.stderr || '').toString().split('\n')[0].slice(0, 60);
    // 超时要单独标出来：混在「抛错」里会被读成语义不一致，而 ETIMEDOUT 与
    // 语义错误是两回事，排查方向完全不同。
    if (e.killed || e.signal === 'SIGTERM') {
      return '<超时> 超过 ' + (timeoutMs || 20000) + 'ms 未结束';
    }
    return '<抛错> ' + (err || e.message.slice(0, 60)) + (out ? ' | stdout=' + out : '');
  }
}

function parseArgs(argv) {
  const out = { presets: ['low', 'medium', 'high', 'max'], seeds: 3, filter: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--quick') { out.presets = ['low', 'medium']; out.seeds = 1; }
    else if (a === '-p' || a === '--preset') out.presets = [argv[++i]];
    else if (a === '-s' || a === '--seeds') out.seeds = Number(argv[++i]) || 3;
    else if (a === '-f' || a === '--filter') out.filter = argv[++i] || '';
    else if (a === '-h' || a === '--help') {
      console.log('用法: node test/semantics.js [--quick] [-p 预设] [-s seed数] [-f 过滤]');
      process.exit(0);
    }
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
const cases = CASES.filter(([name]) => !opts.filter || name.includes(opts.filter));

console.log('语义保持扫描：' + cases.length + ' 个用例 × ' + opts.presets.join('/')
  + ' × ' + opts.seeds + ' 个 seed');
console.log('');

let checked = 0;
let bad = 0;
const failures = [];

for (const [name, src] of cases) {
  const code = src + '\n';
  const expected = runCode(code, 'plain');
  if (expected.startsWith('<抛错>')) {
    console.log('  ⚠ 用例本身跑不起来，跳过：' + name + '  ' + expected);
    continue;
  }
  const marks = [];
  for (const preset of opts.presets) {
    for (let seed = 1; seed <= opts.seeds; seed++) {
      let got;
      try {
        // consoleStub:false —— 每个用例都是自带 console.log 的小程序，而 max 预设
        // 的 consoleStub 默认开着，会把 console.* 全部置空，于是产物输出恒为 ""、
        // 44 个用例在 max 档全军覆没。那是 consoleStub 的既定语义（不是缺陷），
        // 与"产物算错了"在报告里长得一模一样（实得都是空串），所以必须在这里显式
        // 关掉：这份扫描要验的是**语义**，输出通道得是能出声的那个。
        // 关掉不影响任何被测 pass——consoleStub 不参与表达式取值或控制流变换。
        const r = obfuscate(code, resolveOptions({ preset, seed, consoleStub: false }));
        got = runCode(r.code, 'obf', RUN_TIMEOUT[preset] || 20000);
      } catch (e) {
        got = '<混淆抛错> ' + e.message.split('\n')[0].slice(0, 50);
      }
      checked++;
      if (got === expected) { marks.push('·'); continue; }
      bad++;
      marks.push('X');
      failures.push({ name, preset, seed, expected, got });
    }
  }
  console.log('  ' + (marks.includes('X') ? '❌' : '✅') + ' ' + name.padEnd(22)
    + marks.join(' ') + (marks.includes('X') ? '' : ''));
}

console.log('');
if (bad === 0) {
  console.log('✅ 全部通过：' + checked + ' 次比对，语义全部保持');
} else {
  console.log('❌ 有 ' + bad + '/' + checked + ' 次比对语义不一致：');
  const seen = new Set();
  for (const f of failures) {
    const key = f.name + '|' + f.got;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log('  - ' + f.name + ' [' + f.preset + ' seed=' + f.seed + ']');
    console.log('      期望 ' + JSON.stringify(f.expected));
    console.log('      实得 ' + JSON.stringify(f.got));
  }
}

// ---- 属性名重命名档（renameProperties: true）----
//
// 上面那轮走预设默认选项，而默认**不含** renameProperties，于是属性改名这条链路
// 从没被端到端跑过。它是静默算错的高发区：定义面与访问面一旦不同面（`this.n=`
// 改了名、解构 `{n}` 没改），读回的是 undefined 而不是报错，单元断言抓不到。
// 2026-10-16 就是这么漏掉两个缺陷的（解构键、以及属性定义形态）。
//
// 用例单列、只跑 low/medium/max × 2 seed，总时长可控。
const PROP_CASES = [
  ['this.x= 与成员读', 'function C(n){this.n=n;this.m=n*2;}var c=new C(3);console.log(c.n,c.m);'],
  ['this.x= 与解构读', 'function C(n){this.n=n;}var c=new C(3);const {n}=c;console.log(n);'],
  ['this.x= 与重命名解构读', 'function C(n){this.n=n;}var c=new C(3);const {n:q}=c;console.log(q);'],
  ['解构形参', 'function C(n){this.n=n;}function g({n}){return n;}console.log(g(new C(5)));'],
  ['嵌套解构', 'var o={a:{b:4}};const {a:{b}}=o;console.log(b);'],
  ['命名空间对象挂属性', 'var NS={};NS.tag="t";NS.n=1;console.log(NS.tag,NS.n,NS.n+1);'],
  ['命名空间别名链', 'var A={p:1};var B=A;B.q=2;console.log(A.p,A.q,B.p,B.q);'],
  ['对象字面量与方法简写', 'var o={v:1,m(){return this.v;},get d(){return this.v*2;}};console.log(o.m(),o.d);'],
  ['类字段与方法/静态', 'class C{v=1;m(){return this.v;}static s(){return "S";}}console.log(new C().m(),C.s());'],
  ['计算键定义与读', 'var k="dyn";var o={[k]:1};o[k]=2;console.log(o.dyn,o["dyn"]);'],
  ['继承里的 this.x=', 'class A{constructor(){this.a=1;}}class B extends A{constructor(){super();this.b=2;}}var x=new B();console.log(x.a,x.b);'],
  ['读写混合与自增', 'var ns={c:0};ns.c++;ns.c+=5;console.log(ns.c);'],
];
{
  const propOpts = { low: 20000, medium: 30000, max: 90000 };
  const presets = opts.presets.filter((p) => propOpts[p]);
  const seeds = Math.min(2, opts.seeds);
  console.log('\n属性名重命名档（' + presets.join('/') + ' × ' + seeds + ' seed）：');
  let pChecked = 0, pBad = 0;
  for (const [name, src] of PROP_CASES) {
    const code = src + '\n';
    const expected = runCode(code, 'prop-plain');
    if (expected.startsWith('<抛错>')) continue;
    const marks = [];
    for (const preset of presets) {
      for (let seed = 1; seed <= seeds; seed++) {
        let got;
        try {
          const r = obfuscate(code, resolveOptions({
            preset, seed, consoleStub: false, renameProperties: true,
          }));
          got = runCode(r.code, 'prop-obf', propOpts[preset]);
        } catch (e) {
          got = '<混淆抛错> ' + e.message.split('\n')[0].slice(0, 50);
        }
        pChecked++;
        if (got === expected) { marks.push('·'); continue; }
        pBad++;
        marks.push('X');
        console.log('  - ' + name + ' [' + preset + ' seed=' + seed + '] 期望 '
          + JSON.stringify(expected) + ' 实得 ' + JSON.stringify(got));
      }
    }
    console.log('  ' + (marks.includes('X') ? '❌' : '✅') + ' ' + name.padEnd(24) + marks.join(' '));
  }
  console.log(pBad === 0
    ? '  ✅ 属性改名档全部通过：' + pChecked + ' 次比对'
    : '  ❌ 属性改名档有 ' + pBad + '/' + pChecked + ' 次不一致');
  bad += pBad;
  checked += pChecked;
}

fs.rmSync(TMP, { recursive: true, force: true });
process.exit(bad === 0 ? 0 : 1);
