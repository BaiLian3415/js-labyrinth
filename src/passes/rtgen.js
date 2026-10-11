/**
 * 自定义运行时（RT）生成器：为 WASM 解释器内核档生成逐次不同的宿主运行时。
 *
 * 生成物包含三部分：
 *   1) 值语义层：句柄表（值 ↔ i32 句柄）、空闲句柄表、帧表栈，以及五个随机
 *      命名的导入函数（u1/u2 复用值语义入口、v2 复用副作用入口、二元与一元
 *      运算、字符串密文还原走 mks 子码、心跳走 hb 子码）；
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

  // ---- 2) 宿主复用入口 ----
  //
  // 导入表只有 u1/u2/v2/bin/un 五个入口（见 wasmvm.js IMPORT_DEFS），其中 u1/u2/v2
  // 是按栈元数合并的多路复用入口：首参是逐构建随机的稀疏子码，决定真实语义分支。
  // hook 单个导入只能看到（子码, 句柄…），子码→语义映射只存在于下面的分发链，
  // 且逐构建重排分支顺序、重随机子码。按元数硬编码（"唯一的 (3→1) 就是 bin"）
  // 的还原写法彻底失效：(2→1) 有 u1/un 两家，(3→1) 有 u2/bin 两家。
  //
  // 各语义分支先生成私有函数（uk 随机名，从不导出），分发链只做子码比对转发。
  // 分支体与此前逐导入函数的实现逐字一致，语义等价是文本级的。
  const sub = spec.subCodes;
  if (!sub || !sub.u1 || !sub.u2 || !sub.v2) throw new Error('rtgen: 缺少复用子码表（wasmvm 传入）');
  const I = [];
  const priv = {};
  const defPriv = (key, args, body) => { const n = uk(); priv[key] = n; I.push('function ' + n + '(' + args + ') { ' + body + ' }'); };
  defPriv('ldc', 'k', 'if (' + N.pois + ') { return 0; } '
    + 'var v = ' + N.cur + '().k[k]; '
    + 'if (v === void 0) { return 0; } if (v === null) { return 1; } '
    + 'if (v === true) { return 2; } if (v === false) { return 3; } return ' + N.mkh + '(v);');
  defPriv('frag', 'k', 'if (' + N.pois + ') { return 0; } '
    + 'return ' + N.mkh + '(' + N.cur + '().k[k]());');
  defPriv('get', 'i', 'if (' + N.pois + ') { return 0; } '
    + 'return ' + N.mkh + '(' + N.cur + '().g[i]());');
  defPriv('bool', 'h', 'return ' + N.tab + '[h] ? 1 : 0;');
  defPriv('nul', 'h', 'return ' + N.tab + '[h] != null ? 1 : 0;');
  defPriv('mks', 'si', 'if (' + N.pois + ') { return 0; } '
    + 'var F = ' + N.cur + '(), row = F.j[si], Q = F.p, o = "", x, z; '
    + 'for (x = 0; x < row.length; x++) { '
    + 'z = ((' + N.mul + '(' + N.mul + '(si + 1, Q[0]) + x, Q[1]) >>> 8) ^ Q[2] ^ Q[3]) >>> 0; '
    + 'o += ' + N.fcc + '(row[x] ^ z); } '
    + 'return ' + N.mkh + '(o);');
  defPriv('thr', 'h', 'throw ' + N.tab + '[h];');
  defPriv('getm', 'a,b', 'if (' + N.pois + ') { return 0; } '
    + 'return ' + N.mkh + '(' + N.tab + '[a][' + N.tab + '[b]]);');
  defPriv('call', 'n,p', 'if (' + N.pois + ') { return 0; } '
    + 'var f = ' + N.tab + '[' + N.mv + '[p]], a = [], i; '
    + 'for (i = 0; i < n; i++) { a[i] = ' + N.tab + '[' + N.mv + '[p + 1 + i]]; } '
    + 'return ' + N.mkh + '(f.apply(void 0, a));');
  defPriv('callm', 'n,p', 'if (' + N.pois + ') { return 0; } '
    + 'var o = ' + N.tab + '[' + N.mv + '[p]], f = o[' + N.tab + '[' + N.mv + '[p + 1]]], a = [], i; '
    + 'for (i = 0; i < n; i++) { a[i] = ' + N.tab + '[' + N.mv + '[p + 2 + i]]; } '
    + 'return ' + N.mkh + '(f.apply(o, a));');
  defPriv('lnew', 'n,p', 'if (' + N.pois + ') { return 0; } '
    + 'var a = [], i; for (i = 0; i < n; i++) { a[i] = ' + N.tab + '[' + N.mv + '[p + 1 + i]]; } '
    + 'return ' + N.mkh + '(Reflect.construct(' + N.tab + '[' + N.mv + '[p]], a));');
  defPriv('arr', 'n,p', 'if (' + N.pois + ') { return 0; } '
    + 'var a = [], i; for (i = 0; i < n; i++) { a[i] = ' + N.tab + '[' + N.mv + '[p + i]]; } '
    + 'return ' + N.mkh + '(a);');
  defPriv('set', 'i,h', N.cur + '().h[i](' + N.tab + '[h]);');
  defPriv('setm', 'a,b,c', N.tab + '[a][' + N.tab + '[b]] = ' + N.tab + '[c];');
  defPriv('exec', 'k', 'if (' + N.pois + ') { return; } ' + N.cur + '().k[k]();');
  defPriv('rel', 'h', 'if (h >= 4) { ' + N.fre + '.push(h); }');
  defPriv('fail', 'c', spec.debug === true ? 'console.error("[rt] mark " + c); return; ' : N.pois + ' = 1; ');
  defPriv('hb', '', 'if (' + N.pois + ') { return; } '
    + N.hbw + '[0]++; if (' + N.hbw + '[0] < 16) { return; } ' + N.hbw + '[0] = 0; '
    // 原生性判定必须多路径（与 shell 的 _0ph 同一口径，见 AGENTS）。
    // 旧写法 `("" + Function.prototype.toString)` 走**实例属性**，一行就能骗过：
    // `Function.prototype.toString.toString = () => 'function toString(){[native code]}'`。
    // 现在三条独立路径：① 自身属性没被换（`X.toString === Function.prototype.toString`）
    // ② 经**原型方法**调用 stringify（own 属性伪造骗不到）③ 该原型方法自证也是原生。
    // 代价：每 16 次心跳多两次属性读（stringify 次数与改造前相同），可忽略。
    + 'var FT = Function.prototype.toString; '
    + 'if (typeof FT !== "function" || Function.prototype.toString.toString !== FT '
    + '|| RegExp.prototype.test.toString !== FT) { ' + N.pois + ' = 1; } '
    + 'if (("" + FT.call(Function.prototype.toString)).indexOf(' + N.nat + ') < 0) { '
    + N.pois + ' = 1; } '
    + 'if (("" + FT.call(RegExp.prototype.test)).indexOf(' + N.nat + ') < 0) { '
    + N.pois + ' = 1; }');
  // 分发链：分支顺序逐构建打乱，子码字面量只出现在这里。未知子码返回 0/直接返回，
  // 不抛错——真实执行不到，分析者无法用"未知子码抛错"区分真假路径。
  const chain = (fn, grp, args, retZero) => {
    const keys = shuffle(Object.keys(grp));
    let s = 'function ' + fn + '(' + args + ') { ';
    for (const k of keys) {
      const callArgs = { ldc: 'x', frag: 'x', get: 'x', bool: 'x', nul: 'x', mks: 'x', thr: 'x',
        getm: 'a,b', call: 'a,b', callm: 'a,b', lnew: 'a,b', arr: 'a,b',
        set: 'a,b', setm: 'a,b,c', exec: 'a', rel: 'a', fail: 'a', hb: '' }[k === 'new' ? 'lnew' : k];
      const app = priv[k === 'new' ? 'lnew' : k] + '(' + (k === 'hb' ? '' : callArgs) + ')';
      s += 'if (s===' + (grp[k] | 0) + ') { ' + (retZero ? 'return ' + app + ';' : app + '; return;') + ' } ';
    }
    s += retZero ? 'return 0; }' : 'return; }';
    return s;
  };
  I.push(chain(impFn.u1, sub.u1, 's,x', true));
  I.push(chain(impFn.u2, sub.u2, 's,a,b', true));
  I.push(chain(impFn.v2, sub.v2, 's,a,b,c', false));
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
  // 乘数是 FNV 的素数，属算法规范参数，不能换值（E2 由它派生，两侧必须一致）。
  // 只能换写法：16777619 === 0x01000193 === (1<<24)|0x193。逐构建挑一种，
  // "扫十进制 16777619 字面量"这招就不总能命中。
  const hvPrime = ['16777619', '0x01000193', '((1<<24)|0x193)'][randInt(0, 2)];
  let hv = hashBase >>> 0;
  for (let i = 0; i < raw.length; i++) hv = (Math.imul(hv ^ raw[i], 16777619) >>> 0) >>> 0;
  const E1 = randInt(1, 0xffffffff) >>> 0;
  const E2 = (E1 ^ hv) | 0;
  P('function ' + N.hv + '(b) { var h = ' + hashBase + ' >>> 0, i; '
    + 'for (i = 0; i < b.length; i++) { h = ' + N.mul + '(h ^ b[i], ' + hvPrime + ') >>> 0; } return h >>> 0; }');
  // 获取器链：逐层原生性检查，层数与形态逐次随机。
  // 检查同样走"原型方法调用 + 自身属性未被换"两路（与 hb/_0ph 同口径）：
  // `(W.Module + "")` 只看实例属性，伪造一个 toString 就能让这条链认下假 WebAssembly。
  const scNames = [];
  for (let d = 0; d <= layers; d++) scNames.push(uk());
  const FTS = 'Function.prototype.toString';
  const natCall = (expr) => '(' + FTS + '.call(' + expr + ') + "").indexOf(' + N.nat + ') >= 0';
  const notSpoofed = (expr) => '(' + expr + '.toString === ' + FTS + ')';
  const checks = [
    (W) => '(' + natCall(W + '.Module') + ' && ' + notSpoofed(W + '.Module') + ')',
    (W) => '(' + natCall(W + '.Instance') + ' && ' + notSpoofed(W + '.Instance') + ')',
    (W) => '(' + natCall(W + '.instantiate') + ' && ' + notSpoofed(W + '.instantiate') + ')',
    (W) => '(' + natCall(W + '.compile') + ' && ' + notSpoofed(W + '.compile') + ')',
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
