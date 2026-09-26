/**
 * Pass -1：产物中原生函数调用的收敛层。
 *
 * 数值与字符串原语全部收敛到内核自研函数，产物文本里不再出现 Math.imul、
 * String.fromCharCode、parseInt、slice、join、indexOf、toString(16)、RegExp
 * 这些原生 API 名。
 * 内核名字经 uniqueName 随机化后登记 ctx.rtNames，vm、controlFlow、deadCode、
 * opaquePredicates、callProxy、mangle 以及哨兵和入口校验点对它整函数或整绑定
 * 跳过，因为内核是解释器与解码器的引导层，二次编译会形成引导循环或热路径解释
 * 器嵌套。业务语义层仍由 VMP、stringArray 等全量覆盖，点访问形态另经
 * objectKeys 转拆段计算下标。
 */
import parser from '../ast/parser.js';
const { parse } = parser;
import rand from '../utils/rand.js';
const { uniqueName } = rand;
import ws from '../utils/ws.js';
const { wsCodes } = ws;
import t from '../ast/types.js';

// 内核源码，占位名 RTL_*，注入时统一随机改名
function kernelSource() {
  const tbl = (() => {
    let s = '"';
    for (let c = 0; c < 256; c++) {
      s += c < 0x20 || c > 0x7e ? '\\u' + c.toString(16).padStart(4, '0')
        : (c === 34 ? '\\"' : c === 92 ? '\\\\' : String.fromCharCode(c));
    }
    return s + '"';
  })();
  return `
var RTL_TBL = null;
function RTL_G() {
  if (!RTL_TBL) { RTL_TBL = ${tbl}; }
  return RTL_TBL;
}
var RTL_CM = null;
function RTL_CCO(s, i) {
  if (!RTL_CM) { var m = {}; var T = RTL_G(); for (var k = 0; k < 256; k++) { m[T[k]] = k; } RTL_CM = m; }
  var v = RTL_CM[s[i]];
  if (v === undefined) { return s.charCodeAt(i); }
  return v;
}
function RTL_FCC(c) {
  if (c < 256) { return RTL_G()[c]; }
  return String.fromCharCode(c);
}
function RTL_MUL(a, b) {
  a = a | 0; b = b | 0;
  var al = a & 65535; var ah = a >> 16;
  var bl = b & 65535; var bh = b >> 16;
  return (al * bl + ((ah * bl + al * bh) << 16)) | 0;
}
function RTL_HEXN(s, p) {
  var v = RTL_CCO(s, p);
  if (v < 64) { return v & 15; }
  return (v | 32) - 87;
}
function RTL_HEX4(v) {
  var o = '';
  var x = v & 65535;
  var T = RTL_G();
  for (var i = 3; i >= 0; i--) {
    var d = (x >>> (i * 4)) & 15;
    if (d < 10) { o += T[48 + d]; } else { o += T[87 + d]; }
  }
  return o;
}
function RTL_TOH(n) {
  var x = n >>> 0;
  var T = RTL_G();
  if (x === 0) { return T[48]; }
  var o = '';
  while (x > 0) {
    var d = x & 15;
    x = (x - d) / 16;
    if (d < 10) { o = T[48 + d] + o; } else { o = T[87 + d] + o; }
  }
  return o;
}
function RTL_JOIN(a, s) {
  var o = '';
  for (var i = 0; i < a.length; i++) {
    if (i > 0) { o += s; }
    o += a[i];
  }
  return o;
}
function RTL_IOF(s, t) {
  var n = s.length;
  var m = t.length;
  if (m === 0) { return 0; }
  if (m > n) { return -1; }
  for (var i = 0; i + m <= n; i++) {
    var j = 0;
    while (j < m && s[i + j] === t[j]) { j++; }
    if (j === m) { return i; }
  }
  return -1;
}
function RTL_SUB(s, f) {
  var o = '';
  for (var i = f; i < s.length; i++) { o += s[i]; }
  return o;
}
function RTL_COR(s) {
  var o = '';
  if (s.length > 0) { o += s[0]; }
  o += RTL_FCC(0xfffd);
  for (var i = 2; i < s.length; i++) { o += s[i]; }
  return o;
}
var RTL_WSSET = null;
function RTL_WS(s) {
  if (!RTL_WSSET) {
    RTL_WSSET = {};
    var L = [@@WS@@];
    for (var i = 0; i < L.length; i++) { RTL_WSSET[L[i]] = 1; }
  }
  var o = '';
  for (var k = 0; k < s.length; k++) {
    if (!RTL_WSSET[RTL_CCO(s, k)]) { o += s[k]; }
  }
  return o;
}
function RTL_TAS(t, a, b) {
  var r = new t.constructor(b - a);
  for (var i = 0; i < r.length; i++) { r[i] = t[a + i]; }
  return r;
}
function RTL_B64(s) {
  var o = [];
  var bi = 0;
  var ac = 0;
  for (var i = 0; i < s.length; i++) {
    var c = RTL_CCO(s, i);
    if (c === 61) { break; }
    var v = c > 96 ? c - 71 : (c > 64 ? c - 65 : (c > 47 ? c + 4 : (c === 43 ? 62 : (c === 47 ? 63 : -1))));
    if (v < 0) { continue; }
    ac = (ac << 6) | v;
    bi += 6;
    if (bi >= 8) { bi -= 8; o[o.length] = (ac >> bi) & 255; }
  }
  return o;
}
`.replace('@@WS@@', wsCodes().join(','));
}

const RT_SLOTS = ['tbl', 'cm', 'cco', 'fcc', 'mul', 'hexn', 'hex4', 'toh', 'join', 'iof', 'sub', 'cor', 'wsset', 'ws', 'tas', 'b64'];

/**
 * 注入内核，在全部混淆 pass 之前、vm 之前执行，登记 ctx.rt 名字表与
 * ctx.rtNames 跳过集合。
 * @returns {{injected:number}} 插入的顶层语句数
 */
function rtlib(ast, options, ctx) {
  const program = ast.type === 'File' ? ast.program : ast;
  const prefix = options.identifierPrefix || '_0x';

  const parsed = parse(kernelSource(), { sourceType: 'script' });

  // 收集内核根绑定并改名
  const renames = new Map();
  for (const s of parsed.program.body) {
    if (s.type === 'FunctionDeclaration' && s.id) {
      const slot = s.id.name.replace(/^RTL_/, '').toLowerCase();
      renames.set(s.id.name, uniqueName(ctx.usedNames, prefix));
    } else if (s.type === 'VariableDeclaration') {
      for (const d of s.declarations) {
        if (d.id && d.id.name) renames.set(d.id.name, uniqueName(ctx.usedNames, prefix));
      }
    }
  }
  // 声明与引用一起改名，内核自包含，没有需要排除的外部标识符
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.type === 'Identifier' && renames.has(n.name)) n.name = renames.get(n.name);
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'name') continue;
      walk(n[key]);
    }
  };
  walk(parsed.program);

  // 标记 __rtKernel 让结构变换 pass 经 vmBoundary 的 insideVmFunction 整函数
  // 豁免，热原语体内不注入 logicalExpr、conditionObf、objectKeys，这些包装按
  // 每字符调用计成本，放大后无法接受
  for (const s of parsed.program.body) {
    if (s.type === 'FunctionDeclaration') s.__rtKernel = true;
  }

  // 码表字面量标记 __noPool，跳过 stringArray 收集。码表不是业务字符串，
  // 进池会让每个原语都要先跑一遍解码器才能自举
  let marked = 0;
  const markLit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(markLit); return; }
    if (n.type === 'StringLiteral' && typeof n.value === 'string' && n.value.length === 256) {
      n.__noPool = true; marked++;
    }
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra') continue;
      markLit(n[key]);
    }
  };
  markLit(parsed.program);

  // 登记名字表与跳过集合
  const slotOfName = (name) => name.replace(/^RTL_/, '').toLowerCase();
  const rt = {};
  const names = new Set();
  for (const [oldName, newName] of renames) {
    const slot = slotOfName(oldName);
    rt[slot] = newName;
    names.add(newName);
  }
  // 表访问统一走 G()，懒初始化且依赖函数提升，与语句顺序无关。rt.tbl 保留
  // var 名供内核内部使用，外部消费方一律用 rt.tblCall 串形态
  rt.tblCall = rt.g ? rt.g + '()' : rt.tbl;
  ctx.rt = rt;
  ctx.rtNames = names;

  // 插入程序头部，位于 Directive 之后
  let ins = 0;
  while (ins < program.body.length && program.body[ins].type === 'Directive') ins++;
  program.body.splice(ins, 0, ...parsed.program.body);
  // 头部锚定按节点身份记录，callProxy 等后续 pass 会在 0 位插语句，下标必然漂移
  ctx.rtKernelStmts = parsed.program.body.slice();
  ctx.earlyStmts = [];
  ctx.headStmts = [];

  return { injected: parsed.program.body.length, marked };
};

/** 当前根语句数组，functionWrapper 之后即单 IIFE 体。 */
function rootArr(program) {
  if (program.body.length === 1 && program.body[0].type === 'ExpressionStatement') {
    const ex = program.body[0].expression;
    if (ex.type === 'CallExpression' && ex.callee.type === 'FunctionExpression' &&
        ex.callee.body && ex.arguments.length === 0) return ex.callee.body.body;
  }
  return program.body;
}

/** 锚点：给定节点集合在 body 中出现的最大下标加 1，且不小于 Directive 尾。 */
function anchorAfter(body, nodeSets) {
  const anchors = new Set();
  for (const list of nodeSets) for (const n of list) anchors.add(n);
  let last = -1;
  for (let i = 0; i < body.length; i++) if (anchors.has(body[i])) last = i;
  let d = 0;
  while (d < body.length && body[d].type === 'Directive') d++;
  return Math.max(last + 1, d);
}

/**
 * 头部注入区协议（晚带）。立即执行且引用内核或解码器的头部语句，例如反调试
 * 头部与环境指纹，按 pass 顺序追加在既有头部内容之后，锚定用节点身份而非下标。
 * @param {object} ctx pass 上下文
 * @param {object} program Program 节点
 * @param {Array<object>} stmts 待插入语句
 */
function insertHead(ctx, program, stmts) {
  const body = rootArr(program);
  const ins = anchorAfter(body, [ctx.rtKernelStmts || [], ctx.earlyStmts || [], ctx.headStmts || []]);
  body.splice(ins, 0, ...stmts);
  for (const s of stmts) ctx.headStmts.push(s);
};

/**
 * 头部注入区协议（早带）。位置紧随内核之后、晚带内容之前，供 integrityCheck
 * 校验器块使用：掩码赋值必须先于任何调用校验器的宿主函数执行，放到晚带会读到
 * undefined 而假失配投毒。
 * @param {object} ctx pass 上下文
 * @param {object} program Program 节点
 * @param {Array<object>} stmts 待插入语句
 */
function insertHeadEarly(ctx, program, stmts) {
  const body = rootArr(program);
  const ins = anchorAfter(body, [ctx.rtKernelStmts || [], ctx.earlyStmts || []]);
  body.splice(ins, 0, ...stmts);
  for (const s of stmts) ctx.earlyStmts.push(s);
};

/** Math.imul 等价调用节点，MUL 缺失时回退原生调用，保证工具链可降级运行。 */
function mulCall(ctx, a, b) {
  if (ctx && ctx.rt && ctx.rt.mul) {
    return t.callExpression(t.identifier(ctx.rt.mul), [a, b]);
  }
  return t.callExpression(
    t.memberExpression(t.identifier('Math'), t.identifier('imul'), false), [a, b]);
};

/** 是否 RT 内核根函数声明，用于二次结构变换的整函数豁免判定。 */
function isRtFn(ctx, fn) {
  return !!(ctx && ctx.rtNames && fn && fn.type === 'FunctionDeclaration' &&
    fn.id && ctx.rtNames.has(fn.id.name));
};

// 默认导出仍是 rtlib 函数本身，附加方法挂在函数对象上，
// rtlib.insertHead(...) / rtlib.mulCall(...) 这类调用形态保持不变
rtlib.insertHead = insertHead;
rtlib.insertHeadEarly = insertHeadEarly;
rtlib.mulCall = mulCall;
rtlib.isRtFn = isRtFn;

export default rtlib;
export { insertHead, insertHeadEarly, mulCall, isRtFn };
