/**
 * 自定义运行时（RT）生成器：为 WASM 解释器内核档生成逐次不同的宿主运行时。
 *
 * 生成物包含三部分：
 *   1) 值语义层：句柄表（值 ↔ i32 句柄）、空闲句柄表、帧表栈，以及二十个随机
 *      命名的导函数（常量/片段/属性读写/调用/构造/二元与一元运算/字符串密文
 *      还原/心跳）；
 *   2) 桥接层：每个 VM 化函数体内只剩一句 `BRI(f, G, H, K, J, [参数...])`，
 *      参数在桥接里转成句柄后交给 WASM 解释器，返回值再解回 JS 值；
 *   3) 加载链：WASM 字节以标准 base64 分段存放，逐次随机决定段数、段序、掺入
 *      填充字符与解码后滚动散列；WebAssembly 句柄经 rtDepth 层随机化的获取器
 *      链逐层做原生性检查后取得；编译、实例化、锚定字与探针校验、表层解密、
 *      时序种子注入各自成一步，任何一步不过即置毒。
 *
 * 生成物只使用标准成员（WebAssembly、Uint8Array、Int32Array、Date、
 * Function.prototype.toString、Reflect.construct），结构、名字、常数、层数、
 * 段划分逐次随 PRNG 漂移：同一份输入换 seed 得到的运行时逻辑不同。
 */
import rand from '../utils/rand.js';
const { randInt, shuffle, uniqueName } = rand;
import encode from '../utils/encode.js';

const { b64Encode } = encode;

/** 二元运算符 → 宿主闭包体。 */
const BIN_BODY = {
  '+': 'A + B', '-': 'A - B', '*': 'A * B', '/': 'A / B', '%': 'A % B',
  '**': 'A ** B', '==': 'A == B', '!=': 'A != B', '===': 'A === B',
  '!==': 'A !== B', '<': 'A < B', '<=': 'A <= B', '>': 'A > B', '>=': 'A >= B',
  '<<': 'A << B', '>>': 'A >> B', '>>>': 'A >>> B', '&': 'A & B', '|': 'A | B',
  '^': 'A ^ B', 'in': 'A in B', 'instanceof': 'A instanceof B',
};
/** 一元运算符 → 宿主闭包体。 */
const UN_BODY = {
  '-': '-A', '+': '+A', '!': '!A', '~': '~A', 'typeof': 'typeof A', 'void': 'void A',
};

/** Uint8Array → 普通字节数组。 */
function bytesArr(u8) {
  const out = new Array(u8.length);
  for (let i = 0; i < u8.length; i++) out[i] = u8[i];
  return out;
}

/**
 * 生成宿主运行时源码。
 * @param {object} spec wasmvm 传入的规格（见 wasmvm.js 调用处）
 * @returns {{source:string, layers:number}}
 */
function buildLoader(spec) {
  const {
    ctx, options = {}, modBytes, modName, impNameOf, expNames, importDefs,
    binWords, unWords, strParams, anchorVal, probeIdx, probeVal, layout,
  } = spec;

  const depthOpt = options.rtDepth !== undefined ? options.rtDepth | 0 : 2;
  const layers = Math.max(1, Math.min(8, depthOpt)) + randInt(0, 2);
  const used = ctx.usedNames;
  const prefix = options.identifierPrefix || '_0x';
  const uk = () => uniqueName(used, prefix);
  const rt = ctx.rt || {};
  const MUL = rt.mul || 'Math.imul';
  const FCC = rt.fcc || 'String.fromCharCode';

  // 全部顶层名字一次生成，字符串拼接时复用
  const N = {};
  for (const k of ['mv', 'av', 'tab', 'fre', 'fr', 'pois', 'run', 'mem',
    'mkh', 'rlh', 'cur', 'mul', 'fcc', 'bw', 'uw', 'sp', 'hbw',
    'gs', 'gi', 'gather', 'dec', 'hv', 'imp', 'nat', 'pi', 'pv', 'tests']) N[k] = uk();
  const impFn = {};
  for (const [k] of importDefs) impFn[k] = uk();

  const L = [];
  const P = (s) => L.push(s);
  const DBG = spec.debug === true;
  const dbg = (tag) => { if (DBG) P('  console.error("[rt] ' + tag + '");'); };

  // ---- 1) 值表、句柄与帧表 ----
  P('var ' + N.mv + ' = null, ' + N.av + ' = null, ' + N.tab + ' = [], '
    + N.fre + ' = [], ' + N.fr + ' = [], ' + N.pois + ' = 0, '
    + N.run + ' = null, ' + N.mem + ' = null;');
  P('function ' + N.mul + '(a, b) { return ' + MUL + '(a, b); }');
  P('function ' + N.fcc + '(c) { return ' + FCC + '(c); }');
  P('function ' + N.mkh + '(v) {');
  P('  if (v === void 0) { return 0; }');
  P('  if (v === null) { return 1; }');
  P('  if (v === true) { return 2; }');
  P('  if (v === false) { return 3; }');
  P('  var h = ' + N.fre + '.pop();');
  P('  if (h === void 0) { h = ' + N.tab + '.length; }');
  P('  ' + N.tab + '[h] = v;');
  P('  return h;');
  P('}');
  P('function ' + N.rlh + '(h) { if (h >= 4) { ' + N.fre + '.push(h); } }');
  P('function ' + N.cur + '() { return ' + N.fr + '[' + N.fr + '.length - 1]; }');

  // ---- 2) 宿主导函数 ----
  const I = [];
  I.push('function ' + impFn.ldc + '(k) { if (' + N.pois + ') { return 0; } '
    + 'var v = ' + N.cur + '().k[k]; '
    + 'if (v === void 0) { return 0; } if (v === null) { return 1; } '
    + 'if (v === true) { return 2; } if (v === false) { return 3; } return ' + N.mkh + '(v); }');
  I.push('function ' + impFn.frag + '(k) { if (' + N.pois + ') { return 0; } '
    + 'return ' + N.mkh + '(' + N.cur + '().k[k]()); }');
  I.push('function ' + impFn.exec + '(k) { if (' + N.pois + ') { return; } ' + N.cur + '().k[k](); }');
  I.push('function ' + impFn.get + '(i) { if (' + N.pois + ') { return 0; } '
    + 'return ' + N.mkh + '(' + N.cur + '().g[i]()); }');
  I.push('function ' + impFn.set + '(i, h) { ' + N.cur + '().h[i](' + N.tab + '[h]); }');
  I.push('function ' + impFn.getm + '(a, b) { if (' + N.pois + ') { return 0; } '
    + 'return ' + N.mkh + '(' + N.tab + '[a][' + N.tab + '[b]]); }');
  I.push('function ' + impFn.setm + '(a, b, c) { ' + N.tab + '[a][' + N.tab + '[b]] = ' + N.tab + '[c]; }');
  I.push('function ' + impFn.bool + '(h) { return ' + N.tab + '[h] ? 1 : 0; }');
  I.push('function ' + impFn.nul + '(h) { return ' + N.tab + '[h] != null ? 1 : 0; }');
  I.push('function ' + impFn.thr + '(h) { throw ' + N.tab + '[h]; }');
  I.push('function ' + impFn.rel + '(h) { if (h >= 4) { ' + N.fre + '.push(h); } }');
  I.push('function ' + impFn.fail + '(c) { ' + (spec.debug ? 'console.error("[rt] mark " + c); return; ' : N.pois + ' = 1; ') + '}');
  I.push('function ' + impFn.call + '(n, p) { if (' + N.pois + ') { return 0; } '
    + 'var f = ' + N.tab + '[' + N.mv + '[p]], a = [], i; '
    + 'for (i = 0; i < n; i++) { a[i] = ' + N.tab + '[' + N.mv + '[p + 1 + i]]; } '
    + 'return ' + N.mkh + '(f.apply(void 0, a)); }');
  I.push('function ' + impFn.callm + '(n, p) { if (' + N.pois + ') { return 0; } '
    + 'var o = ' + N.tab + '[' + N.mv + '[p]], f = o[' + N.tab + '[' + N.mv + '[p + 1]]], a = [], i; '
    + 'for (i = 0; i < n; i++) { a[i] = ' + N.tab + '[' + N.mv + '[p + 2 + i]]; } '
    + 'return ' + N.mkh + '(f.apply(o, a)); }');
  I.push('function ' + impFn.new + '(n, p) { if (' + N.pois + ') { return 0; } '
    + 'var a = [], i; for (i = 0; i < n; i++) { a[i] = ' + N.tab + '[' + N.mv + '[p + 1 + i]]; } '
    + 'return ' + N.mkh + '(Reflect.construct(' + N.tab + '[' + N.mv + '[p]], a)); }');
  I.push('function ' + impFn.arr + '(n, p) { if (' + N.pois + ') { return 0; } '
    + 'var a = [], i; for (i = 0; i < n; i++) { a[i] = ' + N.tab + '[' + N.mv + '[p + i]]; } '
    + 'return ' + N.mkh + '(a); }');
  // 字符串密文行还原：与 vm.js 的 strHash 逐位一致
  I.push('function ' + impFn.mks + '(si) { if (' + N.pois + ') { return 0; } '
    + 'var F = ' + N.cur + '(), row = F.j[si], Q = F.p, o = "", x, z; '
    + 'for (x = 0; x < row.length; x++) { '
    + 'z = ((' + N.mul + '(' + N.mul + '(si + 1, Q[0]) + x, Q[1]) >>> 8) ^ Q[2] ^ Q[3]) >>> 0; '
    + 'o += ' + N.fcc + '(row[x] ^ z); } '
    + 'return ' + N.mkh + '(o); }');
  // 心跳：内建函数原生性抽查（每 16 次心跳抽样一次，避开热路径字符串分配）
  I.push('function ' + impFn.hb + '() { if (' + N.pois + ') { return; } '
    + N.hbw + '[0]++; if (' + N.hbw + '[0] < 16) { return; } ' + N.hbw + '[0] = 0; '
    + 'if (("" + Function.prototype.toString).indexOf(' + N.nat + ') < 0) { ' + N.pois + ' = 1; } '
    + 'if (("" + RegExp.prototype.test).indexOf(' + N.nat + ') < 0) { ' + N.pois + ' = 1; } }');
  P(I.join('\n'));
  P('var ' + N.hbw + ' = [0];');
  P('var ' + N.nat + ' = "' + 'native' + '";');

  // ---- 3) 运算符闭包表（按分发字直查，字→语义映射逐次漂移） ----
  const binNames = binWords.map(() => uk());
  const unNames = unWords.map(() => uk());
  P(binWords.map(([w, op], i) => {
    const body = BIN_BODY[op];
    if (!body) throw new Error('rtgen: unsupported binary op ' + op);
    return 'function ' + binNames[i] + '(A, B) { return ' + body + '; }';
  }).join('\n'));
  P(unWords.map(([w, op], i) => {
    const body = UN_BODY[op];
    if (!body) throw new Error('rtgen: unsupported unary op ' + op);
    return 'function ' + unNames[i] + '(A) { return ' + body + '; }';
  }).join('\n'));
  P('var ' + N.bw + ' = [], ' + N.uw + ' = [];');
  P(shuffle(binWords.map((_, i) => i))
    .map((i) => N.bw + '[' + binWords[i][0] + '] = ' + binNames[i] + ';').join('\n'));
  P(shuffle(unWords.map((_, i) => i))
    .map((i) => N.uw + '[' + unWords[i][0] + '] = ' + unNames[i] + ';').join('\n'));
  P('function ' + impFn.bin + '(d, a, b) { if (' + N.pois + ') { return 0; } '
    + 'return ' + N.mkh + '(' + N.bw + '[d](' + N.tab + '[a], ' + N.tab + '[b])); }');
  P('function ' + impFn.un + '(d, a) { if (' + N.pois + ') { return 0; } '
    + 'return ' + N.mkh + '(' + N.uw + '[d](' + N.tab + '[a])); }');
  // 每函数字符串密文参数表（P/K1/K2/M0）
  P('var ' + N.sp + ' = [' + strParams.map((q) => '[' + q.join(',') + ']').join(', ') + '];');

  // ---- 4) 桥接函数 ----
  const briName = ctx.__vmBridgeName;
  if (!briName) throw new Error('rtgen: 缺少桥接函数名（vm pass 未以 wasmInterpreter 模式运行）');
  P('function ' + briName + '(f, g, h, k, j, a) {');
  P('  var n = a.length, i, r, v;');
  P('  if (n > ' + layout.MAXA + ') { n = ' + layout.MAXA + '; }');
  P('  for (i = 0; i < n; i++) { ' + N.av + '[i] = ' + N.mkh + '(a[i]); }');
  P('  ' + N.fr + '.push({ g: g, h: h, k: k, j: j, p: ' + N.sp + '[f] });');
  P('  try {');
  P('    r = ' + N.run + '(f, n);');
  P('    v = ' + N.tab + '[r];');
  P('  } finally { ' + N.fr + '.pop(); }');
  P('  ' + N.rlh + '(r);');
  P('  return v;');
  P('}');

  // ---- 5) 模块字节：分段存放 + 段序置换 + 填充字符 + 自研解码 ----
  const b64 = b64Encode(bytesArr(modBytes).map((c) => String.fromCharCode(c)).join(''));
  const segCount = Math.max(3, randInt(3, 9), Math.ceil(b64.length / 16384));
  const segLen = Math.ceil(b64.length / segCount);
  // 填充字符必须落在 base64 字母表之外：解码器按"未知字符跳过"处理，
  // 用字母表内字符会被当成真实数据，段流整体错位。
  const FILL = '!#$%&()*,-.:;<=>?@[]^_{|}~';
  const segs = [];
  for (let s = 0; s < segCount; s++) {
    let seg = b64.slice(s * segLen, (s + 1) * segLen);
    if (seg) {
      const cut = randInt(0, seg.length);
      let filler = '';
      const fn = randInt(1, 5);
      for (let f = 0; f < fn; f++) filler += FILL[randInt(0, FILL.length - 1)];
      seg = seg.slice(0, cut) + filler + seg.slice(cut);
    }
    segs.push(seg);
  }
  const ord = shuffle(segs.map((_, i) => i));
  const slots = new Array(segs.length);
  for (let j = 0; j < segs.length; j++) { slots[ord[j]] = segs[j]; }
  P('var ' + N.gs + ' = [' + slots.map((s) => JSON.stringify(s)).join(', ') + '];');
  // 取回顺序即存储置换本身：slots[ord[j]] 里放的是原始第 j 段
  P('var ' + N.gi + ' = [' + ord.join(', ') + '];');
  P('function ' + N.gather + '() { var s = "", i; '
    + 'for (i = 0; i < ' + N.gi + '.length; i++) { s += ' + N.gs + '[' + N.gi + '[i]]; } return s; }');
  const b64map = uk();
  P('var ' + b64map + ' = null;');
  P('function ' + N.dec + '(s) { var o = [], acc = 0, bl = 0, i, c, v; '
    + 'if (!' + b64map + ') { ' + b64map + ' = {}; var T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; '
    + 'for (i = 0; i < 64; i++) { ' + b64map + '[T[i]] = i; } } '
    + 'for (i = 0; i < s.length; i++) { c = s[i]; v = ' + b64map + '[c]; '
    + 'if (v === void 0) { continue; } acc = acc * 64 + v; bl += 6; '
    + 'if (bl > 7) { bl -= 8; o[o.length] = (acc >>> bl) & 255; acc &= (1 << bl) - 1; } } '
    + 'return o; }');

  // ---- 6) 加载链 ----
  const raw = bytesArr(modBytes);
  const hashBase = randInt(1, 0xffffffff) >>> 0;
  let hv = hashBase >>> 0;
  for (let i = 0; i < raw.length; i++) hv = (Math.imul(hv ^ raw[i], 16777619) >>> 0) >>> 0;
  const E1 = randInt(1, 0xffffffff) >>> 0;
  const E2 = (E1 ^ hv) | 0;
  P('function ' + N.hv + '(b) { var h = ' + hashBase + ' >>> 0, i; '
    + 'for (i = 0; i < b.length; i++) { h = ' + N.mul + '(h ^ b[i], 16777619) >>> 0; } return h >>> 0; }');
  // 获取器链：逐层原生性检查，层数与形态逐次随机
  const scNames = [];
  for (let d = 0; d <= layers; d++) scNames.push(uk());
  const checks = [
    (W) => '(' + W + '.Module + "").indexOf(' + N.nat + ') >= 0',
    (W) => '(' + W + '.Instance + "").indexOf(' + N.nat + ') >= 0',
    (W) => '(' + W + '.instantiate + "").indexOf(' + N.nat + ') >= 0',
    (W) => '(' + W + '.compile + "").indexOf(' + N.nat + ') >= 0',
    (W) => 'typeof ' + W + '.Module === "function"',
  ];
  P('function ' + scNames[0] + '() { '
    + 'return (typeof WebAssembly === "object" && WebAssembly) ? WebAssembly : null; }');
  for (let d = 1; d <= layers; d++) {
    const c = checks[randInt(0, checks.length - 1)];
    const style = randInt(0, 2);
    const body = style === 0
      ? 'var W = ' + scNames[d - 1] + '(); if (!W) { return null; } '
        + 'if (!(' + c('W') + ')) { return null; } return W;'
      : style === 1
        ? 'var W = ' + scNames[d - 1] + '(); if (!W) { return null; } '
          + 'var q = ' + randInt(3, 99) + '; while (q > 0) { q--; } ' + N.mul + '(q, 1); '
          + 'if (!(' + c('W') + ')) { return null; } return W;'
        : 'var W = ' + scNames[d - 1] + '(); return (W && (' + c('W') + ')) ? W : null;';
    P('function ' + scNames[d] + '() { ' + body + ' }');
  }
  P('var ' + N.imp + ' = {}; ' + N.imp + '[' + JSON.stringify(modName) + '] = {};');
  for (const [k] of importDefs) {
    P(N.imp + '[' + JSON.stringify(modName) + '][' + JSON.stringify(impNameOf[k]) + '] = ' + impFn[k] + ';');
  }
  P('var ' + N.pi + ' = [' + probeIdx.join(', ') + '], '
    + N.pv + ' = [' + probeVal.map((v) => (v | 0)).join(', ') + '];');
  P('(function () {');
  P('  var b, W, M, Ie, E, k;');
  P('  b = ' + N.dec + '(' + N.gather + '());');
  if (DBG) {
    P('  console.error("[rt] hash " + ' + N.hv + '(b) + " vs " + ((' + E1 + ' ^ ' + E2 + ') >>> 0)'
      + ' + " len " + b.length + " segs " + ' + N.gs + '.length);');
  }
  P('  if (' + N.hv + '(b) !== ((' + E1 + ' ^ ' + E2 + ') >>> 0)) { ' + N.pois + ' = 1; return; }');
  P('  W = ' + scNames[layers] + '();');
  P('  if (!W) { ' + N.pois + ' = 1; return; }');
  P('  try {');
  P('    M = new W.Module(new Uint8Array(b));');
  P('    Ie = new W.Instance(M, ' + N.imp + ');');
  P('    E = Ie.exports;');
  P('    ' + N.run + ' = E[' + JSON.stringify(expNames.run) + '];');
  P('    ' + N.mem + ' = E[' + JSON.stringify(expNames.mem) + '];');
  P('    ' + N.mv + ' = new Int32Array(' + N.mem + '.buffer);');
  P('    ' + N.av + ' = new Int32Array(' + N.mem + '.buffer, ' + (layout.ARGAREA * 4) + ', ' + layout.MAXA + ');');
  P('    ' + N.tab + ' = [void 0, null, true, false];');
  if (DBG) P('  console.error("[rt] instantiated");');
  P('    if ((E[' + JSON.stringify(expNames.anchor) + ']() >>> 0) !== ((' + (anchorVal | 0) + ') >>> 0)) { '
    + N.pois + ' = 1; return; }');
  if (DBG) dbg('anchor ok');
  P('    for (k = 0; k < ' + N.pi + '.length; k++) { '
    + 'if ((E[' + JSON.stringify(expNames.prb) + '](' + N.pi + '[k]) >>> 0) !== (' + N.pv + '[k] >>> 0)) { '
    + N.pois + ' = 1; return; } }');
  if (DBG) dbg('probes ok');
  P('    if (E[' + JSON.stringify(expNames.ini) + ']() !== 0) { ' + N.pois + ' = 1; return; }');
  if (DBG) dbg('ini ok');
  if (DBG) {
    P('  console.error("[rt] PT0=[" + [].slice.call(' + N.mv + ', ' + layout.PTB + ', ' + (layout.PTB + 8) + ').join(",") + "]");');
  }
  P('    E[' + JSON.stringify(expNames.snn) + ']((Date.now ? Date.now() : 0) | 0);');
  if (DBG) dbg('snn ok');
  P('  } catch (e) { ' + N.pois + ' = 1; '
    + (DBG ? 'console.error("[rt] load threw: " + e.message + " | " + e.stack); ' : '') + '}');
  P('})();');

  return { source: L.join('\n'), layers, names: N, impFn };
}

export default { buildLoader };
