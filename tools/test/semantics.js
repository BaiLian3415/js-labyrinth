#!/usr/bin/env node
/**
 * 语义保持扫描。零依赖，按需跑（不进 npm test，太慢）：
 *
 *   node tools/test/semantics.js                 # 全部用例 × 四个预设 × 3 个 seed
 *   node tools/test/semantics.js --quick         # 只跑 low/medium，1 个 seed
 *   node tools/test/semantics.js -p medium -s 8  # 指定预设与 seed 数
 *   node tools/test/semantics.js -f 逻辑          # 只跑名字含该子串的用例
 *
 * 做法：每个用例都是一段自带 console.log 的完整小程序。先跑原始源码记下输出，
 * 再逐预设逐 seed 混淆后运行，输出必须逐字符相同。
 *
 * 为什么要有这个：今天（2026-09-19）连撞两个**静默**缺陷——wasm junk 段随机压坏
 * 参数表、logicalExpr 把 `a || b` 交换成 `b || a`（`||` 返回操作数的值，不是布尔）。
 * 两者都不报错，产物"看起来能跑"，只是结果不对。单元断言抓不到这种，必须真的
 * 把产物跑起来比对输出。
 *
 * 命中依赖随机数，所以每个用例要跨多个 seed 跑——单次跑过不代表没问题。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import obfuscateMod from '../../src/obfuscate.js';

const { obfuscate, resolveOptions } = obfuscateMod;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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
  ['立即返回对象', 'function f(){return {a:1,b:function(){return 2;}};}console.log(f().a,f().b());'],
];

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jslb-sem-'));

// stdio 显式写成数组：默认的 stdin 管道在部分 Windows 环境（父进程标准句柄来自
// 上层宿主）会让 spawnSync 直接 EBUSY，整份比对会在第一个用例崩掉。
const SYNC_STDIO = ['ignore', 'pipe', 'pipe'];

/** 跑一段代码，返回 stdout（去掉尾空白）；抛错则返回带标记的字符串。 */
function runCode(code, tag) {
  const f = path.join(TMP, tag + '.js');
  fs.writeFileSync(f, code);
  try {
    return execFileSync(process.execPath, [f], { encoding: 'utf8', timeout: 20000, stdio: SYNC_STDIO }).trim();
  } catch (e) {
    const out = (e.stdout || '').toString().trim();
    const err = (e.stderr || '').toString().split('\n')[0].slice(0, 60);
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
      console.log('用法: node tools/test/semantics.js [--quick] [-p 预设] [-s seed数] [-f 过滤]');
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
        const r = obfuscate(code, resolveOptions({ preset, seed }));
        got = runCode(r.code, 'obf');
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

fs.rmSync(TMP, { recursive: true, force: true });
process.exit(bad === 0 ? 0 : 1);
