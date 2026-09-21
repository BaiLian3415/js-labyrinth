import rand from './rand.js';
const { randInt } = rand;
import parser from '../ast/parser.js';
const { parse } = parser;
/**
 * 隐蔽语句构造工具，产物中不出现高指纹明文。
 *
 * debugger 触发器的隐蔽做法。源码里没有 "debugger" 明文，也没有明文的
 * charCode 序列 100,101,...。运行时用
 * Function(String.fromCharCode((m1^m2), ...)) 构造触发函数，m1^m2 恒等于
 * 目标 charCode，掩码每次构建随机，所以没有固定指纹。触发函数缓存在
 * globalThis 的构建期随机属性上，机制与毒药标志相同，走字符串属性访问，
 * 不落 var 绑定，mangle 重命名和语句搬移都影响不到它，同一 helpers 实例
 * 的所有注入点共用一份构造结果，热路径不重复构造。CSP 之类禁用 Function
 * 构造器的环境降级成空函数，检测失效但不影响原逻辑执行。
 */

/**
 * obfStrExpr 的 AST 版本。把表达式源码解析成节点，直接拼进 t.* 构造的
 * AST，head 检测点即走这条路径。掩码机制与源码注入路径 dbgVarSource、
 * buildSentinelSrc 相同。
 * @param {string} s 目标字符串
 * @param {string} [tbl] 运行时字符表绑定名
 * @returns {object} 表达式节点
 */
function obfStrNode(s, tbl) {
  return parse(obfStrExpr(s, tbl), { sourceType: 'script' }).program.body[0].expression;
}

// "debugger" 的 charCode 序列。仅构建期使用，不进入产物明文。
const DBG_CODES = [100, 101, 98, 117, 103, 103, 101, 114];

// globalThis 安全引用，与毒药标志同一模式
const GLOBAL_EXPR =
  '(typeof globalThis!=="undefined"?globalThis:typeof self!=="undefined"?self:' +
  'typeof window!=="undefined"?window:typeof global!=="undefined"?global:{})';

/**
 * 生成把字符串 s 拼出来的掩码恒等式表达式源码。
 * 每个字符写成 (0x m1 ^0x m2)，以该值作下标从运行时字符表取出，m1^m2
 * 恒等于 charCode，再拼接重组。产物里没有明文目标串，没有固定的
 * charCode 序列，也不出现 String.fromCharCode 调用点，掩码每次构建随机。
 * tbl 省略时回退 fromCharCode 形态，走无内核的降级链路。
 * @param {string} s 目标字符串
 * @param {string} [tbl] 运行时字符表绑定名
 * @returns {string} 表达式源码
 */
function obfStrExpr(s, tbl) {
  const parts = [];
  for (const c of s) {
    const m1 = 0x101 + randInt(0, 0xfefe);
    const m2 = m1 ^ c.charCodeAt(0);
    parts.push('(0x' + m1.toString(16) + '^0x' + m2.toString(16) + ')');
  }
  if (tbl) {
    // 字符表引用只求值一次就取回，tbl 形态是一次懒初始化 getter 调用。原
    // 写法每字符调一次表，在哨兵这类每次函数调用都要重组的位置会放大成
    // 数十万次内核调用，实测占关 VMP 产物总耗时约 70%。掩码、取字与拼接
    // 顺序都不变。
    if (parts.length > 2) {
      return '((function(_0T){return ' +
        parts.map((p) => '_0T[' + p + ']').join('+') + ';})(' + tbl + '))';
    }
    return '(' + parts.map((p) => tbl + '[' + p + ']').join('+') + ')';
  }
  const chunks = [];
  for (let i = 0; i < parts.length; i += 4) {
    chunks.push('String.fromCharCode(' + parts.slice(i, i + 4).join(',') + ')');
  }
  return '(' + chunks.join('+') + ')';
}

/**
 * 生成动态 debugger 触发器的构造器源码，由 Function 包裹表重组出的
 * "debugger"。tbl 提供时不出现 String.fromCharCode 调用点。
 * @param {string} [tbl] 运行时字符表绑定名
 * @returns {string} 构造器表达式源码
 */
function dbgFnSource(tbl) {
  const parts = [];
  for (const c of DBG_CODES) {
    const m1 = 0x101 + randInt(0, 0xfefe);
    const m2 = m1 ^ c;
    parts.push('(0x' + m1.toString(16) + '^0x' + m2.toString(16) + ')');
  }
  if (tbl) {
    return 'Function(' + parts.map((p) => tbl + '[' + p + ']').join('+') + ')';
  }
  return 'Function(String.fromCharCode(' + parts.join(',') + '))';
}

/**
 * 创建一组隐蔽 debugger 构造助手。
 * 同一实例即同一 cacheKey 下，所有注入点在运行时共享一份构造结果。
 * cacheKey 固定使用 `__d` 前缀，与毒药标志的 `__x` 前缀在字面上隔开。
 * 两者都存成 globalThis 属性，一旦撞名，调试缓存里的真值函数会被解码器
 * 误判成毒药标志，导致全量输出腐蚀。`__d` 与 `__x` 各自拼接随机 hex，
 * 其余部分逐构建唯一。
 * @param {string} [tbl] 运行时字符表绑定名，取自 ctx.rt.tbl
 * @returns {{ varSource: (name: string) => string }} varSource(name) 生成 `var NAME=G[k]||(G[k]=(安全构造));` 源码
 */
function makeDbgHelpers(tbl) {
  const cacheKey = '__d' + randInt(0x100000, 0xffffff).toString(16);
  const varSource = (name) =>
    'var ' + name + '=' + GLOBAL_EXPR + '["' + cacheKey + '"]||(' + GLOBAL_EXPR +
    '["' + cacheKey + '"]=(function(){try{return ' + dbgFnSource(tbl) +
    ';}catch(_0xe){return function(){};}})());';
  return { varSource };
}

export default { makeDbgHelpers, obfStrExpr, obfStrNode, dbgFnSource, GLOBAL_EXPR };
