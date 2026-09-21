import t from '../ast/types.js';
import generate from '../ast/generator.js';
import parser from '../ast/parser.js';
const { parse } = parser;
import rand from '../utils/rand.js';
const { randInt, randHex, uniqueName } = rand;
import vm from './vm.js';
const { isVMCompiled } = vm;
import rtlib from './rtlib.js';
import hide from '../utils/hide.js';
const { obfStrExpr } = hide;
import ws from '../utils/ws.js';
const { WS_CHARS } = ws;
/**
 * 执行前完整性校验，配合自愈式防篡改。必须晚于所有改写 AST 的 pass 运行，
 * 构建期以最终代码生成选项输出函数文本并计算哈希，运行期用
 * Function.prototype.toString 取回同一段文本比对，哈希基于去空白后的函数文本，
 * 容忍 functionWrapper 造成的缩进深度差异。失配只把 globalThis 下随机属性上的毒药
 * 标志置位，stringArray 解码器读到即损坏输出，流程继续但数据已坏。
 *
 * 哈希表按显式随机键查表而不是按 fn.name：键与函数引用成对出现在头校验循环里，
 * 表项和调用点不依赖任何可推断的名字。装载时另做一次原生性探针：
 * Function.prototype.toString 等内建成员被换成钩子即投毒——解壳与去断点的第一步
 * 正是替换它们。
 *
 * 校验面只收根级函数声明：校验器插在装载最早期（内核之后），var 绑定的函数那时
 * 还是 undefined，把函数表达式或字符串池访问器放进头部循环只会集体假失配。
 */
const stripWs = (s) => {
  let out = '';
  for (const ch of s) if (!WS_CHARS.includes(ch)) out += ch;
  return out;
};

/**
 * 构建期哈希器，两条结构不同的 32 位通道，A 为 FNV-1a 变体，B 为 FNV-1 变体
 * 加位置混合，收尾交叉混合后输出 64 位。
 *
 * 必须加宽到 64 位，因为单通道 32 位输出空间的同哈希补丁可以用生日攻击或中间
 * 相遇在 2^16 次试算内构造出来，反混淆者改一处代码后重算出相同的 32 位哈希就能
 * 静默通过校验，定位加重签只需一次试算脚本。加宽后伪造要同时匹配两条通道，试算
 * 量升到 2^64 才可行。换哈希族不解决这个问题，宽度才是安全属性。
 *
 * 返回的 fn 供构建期对函数文本求值并返回 { lo, hi }，verifierBody 生成运行期
 * 对同一段文本求出同一组值的语句源码，变量名由调用方注入，两者算法逐字段一致。
 * 运行期乘法走内核 MUL，字符取码走 CCO，产物中不出现 Math.imul 与 charCodeAt
 * 的调用点。
 *
 * @param {string} loopVar 运行期循环变量名
 * @param {object} rt RT 内核名字表，缺失时回退原生调用以保证降级可运行
 */
function makeHasher(loopVar, rt) {
  const mul = (h, p) => rt && rt.mul ? rt.mul + '(' + h + ',' + p + ')' : 'Math.imul(' + h + ',' + p + ')';
  const codeExpr = (tv, iv) => rt && rt.cco ? rt.cco + '(' + tv + ',' + iv + ')' : tv + '.charCodeAt(' + iv + ')';
  // 全部取随机奇数，产物中不存在 FNV 标准基值与乘数的签名
  const basisA = randInt(0x100, 0xfffffe) * 2 + 1;
  const basisB = randInt(0x100, 0xfffffe) * 2 + 1;
  const primeA = randInt(0x10000, 0x7ffffe) * 2 + 1;
  const primeB = randInt(0x10000, 0x7ffffe) * 2 + 1;
  const primeC = randInt(0x10000, 0x7ffffe) * 2 + 1;
  const primeD = randInt(0x10000, 0x7ffffe) * 2 + 1;
  const fn = (s) => {
    let a = basisA;
    let b = basisB;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      a = Math.imul((a ^ c) >>> 0, primeA) >>> 0;
      b = Math.imul(b, primeB) >>> 0;
      b = (b ^ ((c + i) >>> 0)) >>> 0;
    }
    a = Math.imul((a ^ (b >>> 16)) >>> 0, primeC) >>> 0;
    b = Math.imul((b ^ (a >>> 13)) >>> 0, primeD) >>> 0;
    // 两条通道各自独立输出，不把 a、b 折叠成同一个 64 位值的两个半区，
    // 否则攻击者只需匹配折叠后的单一值
    return { lo: a >>> 0, hi: b >>> 0 };
  };
  const verifierBody = (aVar, bVar, cVar, tVar) =>
    'for(var ' + loopVar + '=0;' + loopVar + '<' + tVar + '.length;' + loopVar + '++){' +
    'var ' + cVar + '=' + codeExpr(tVar, loopVar) + ';' +
    aVar + '=' + mul(aVar + '^' + cVar, primeA) + '>>>0;' +
    bVar + '=' + mul(bVar, primeB) + '>>>0;' +
    bVar + '=(' + bVar + '^((' + cVar + '+' + loopVar + ')>>>0))>>>0;' +
    '}' +
    aVar + '=' + mul('(' + aVar + '^(' + bVar + '>>>16))>>>0', primeC) + '>>>0;' +
    bVar + '=' + mul('(' + bVar + '^(' + aVar + '>>>13))>>>0', primeD) + '>>>0;';
  return { fn, verifierBody, mul, primeB, basisA, basisB };
}

/** 访问 globalThis 的表达式源码，无局部 var 绑定，mangle 不会波及。 */
function globalRef() {
  return '(typeof globalThis!=="undefined"?globalThis:typeof self!=="undefined"?self:typeof window!=="undefined"?window:typeof global!=="undefined"?global:{})';
}

export default function integrityCheck(ast, options, ctx) {
  if (options.integrityCheck === false) return { checked: 0, sentinels: 0, entryPoints: 0 };
  // rtlib 关掉时 ctx.rt 不存在，下面的 rt && rt.x 会各自走回退形态
  const rt = ctx.rt || {};
  const program = ast.type === 'File' ? ast.program : ast;

  // 根作用域定位，functionWrapper 的产物是单条 IIFE 调用表达式语句。
  let rootBody = program.body;
  if (program.body.length === 1 && program.body[0].type === 'ExpressionStatement') {
    const ex = program.body[0].expression;
    if (ex.type === 'CallExpression' && ex.callee.type === 'FunctionExpression' &&
        ex.callee.body && ex.arguments.length === 0) {
      rootBody = ex.callee.body.body;
    }
  }

  // 收集校验目标，在注入之前快照。
  //
  // 校验面原先只有根级 FunctionDeclaration，机制层（字符串池访问器、var 绑定
  // 的函数表达式）改了没人发现，而它们恰恰是还原者最先动的地方。现在按"函数
  // 引用 + 显式键"登记：运行期取 fn.toString()，构建期生成同一节点的文本，两
  // 者逐字比对。显式键取代旧的 fn.name 查表，匿名函数表达式也能进表。
  const targets = rootBody.filter((s) => s.type === 'FunctionDeclaration' && s.id && s.id.name);
  // 机制层（字符串池访问器）走**延迟校验**：头部循环插在装载最早期，那时
  // `var accessor = ...` 还没执行，引用到的是 undefined，哈希必然假失配。
  // 于是单独生成一块校验，插到最后一条访问器声明之后——那时函数已就位，
  // 且仍在用户代码之前。可见性按**语句节点身份**判定：vm / wasm 会把部分根级
  // 语句搬进嵌套函数，搬走之后语句就不在 rootBody 里了，此时放弃，不留悬空引用。
  // 可见性过滤：只收声明**仍在 rootBody 里**的访问器。vm / wasm 会把部分根级
  // 语句搬进嵌套函数体，那种情况下硬插校验块会失配（搬进的体往往还被 wasm 的
  // 特征匹配依赖），宁可放弃这一处的覆盖，也不要拿假失配投毒去换覆盖率。
  const deferred = [];
  for (const t of (program.__saAccessors || [])) {
    if (rootBody.indexOf(t.stmt) >= 0) deferred.push({ ref: t.name, node: t.node, stmt: t.stmt });
  }

  // 每个校验目标一个随机键。键取代 fn.name 做表下标：函数表达式的 name 要么
  // 为空要么可被推断，靠它查表会把机制层排除在校验面之外。
  const usedKeys = new Set();
  const keyLit = () => {
    let k;
    do { k = "'__f" + randHex(8) + "'"; } while (usedKeys.has(k));
    usedKeys.add(k);
    return k;
  };
  const keyOf = new Map();
  for (const d of deferred) keyOf.set(d.node, keyLit());
  for (const fn of targets) keyOf.set(fn, keyLit());

  const genOpts = {
    compact: options.compact !== false,
    escapeNonAscii: !!options.escapeNonAscii,
    indent: options.indent !== undefined ? options.indent : 2,
  };

  // 毒药标志做成多点，N 个独立全局属性全部置位才算完成毒化，解码器
  // 检查到任一置位就损坏输出，攻击者必须找齐并清除全部 N 个随机属性名
  // 才能解除，漏一个数据仍是坏的。stringArray 声明过就复用它的属性名
  // 集合，否则本 pass 自己生成。
  const poisonCount = Math.min(4, Math.max(2, options.integrityPoisonPoints !== undefined ? options.integrityPoisonPoints : 3));
  let poisonKeys = program.__poisonKeys;
  if (!poisonKeys || !poisonKeys.length) {
    let first = program.__poisonKey;
    poisonKeys = [];
    if (first) poisonKeys.push(first);
    while (poisonKeys.length < poisonCount) {
      let k2;
      do {
        k2 = '__x' + randInt(0x100000, 0xffffff).toString(16);
      } while (poisonKeys.includes(k2));
      poisonKeys.push(k2);
    }
  }
  const setPoisonSrc = () => poisonKeys
    .map((k) => globalRef() + '["' + k + '"]=0x' + (randInt(1, 0xffff) | 1).toString(16) + ';')
    .join('');

  // 哨兵函数在构建期生成，运行期做精确子串校验，同时是哈希交叉目标。
  // 标记表达式从三种恒真算术式里逐哨兵随机挑选，消息串也逐哨兵随机并经
  // m1 异或 m2 掩码重组，不留固定 marker 字节序列。
  const sentCount = randInt(1, 3);
  const sentinels = [];
  for (let i = 0; i < sentCount; i++) {
    const name = uniqueName(ctx.usedNames, '_0x');
    const n1 = randInt(0x1000, 0xffff);
    const n2 = randInt(0x1000, 0xffff);
    const n3 = randInt(0x1000, 0xffff);
    let retStmt;
    const form = randInt(0, 2);
    if (form === 0) {
      const c = (n1 ^ n2) + n3;
      retStmt = t.returnStatement(t.binaryExpression('===',
        t.binaryExpression('+',
          t.binaryExpression('^', t.numericLiteral(n1), t.numericLiteral(n2)),
          t.numericLiteral(n3)),
        t.numericLiteral(c)));
    } else if (form === 1) {
      const c = (n1 + n2) ^ n3;
      retStmt = t.returnStatement(t.binaryExpression('===',
        t.binaryExpression('^',
          t.binaryExpression('+', t.numericLiteral(n1), t.numericLiteral(n2)),
          t.numericLiteral(n3)),
        t.numericLiteral(c)));
    } else {
      // imul 的产物按 int32 比较，与运行期表达式同一口径，RT MUL 逐位等价
      const c = Math.imul(n1, n2 | 1) ^ n3;
      retStmt = t.returnStatement(t.binaryExpression('===',
        t.binaryExpression('^',
          rtlib.mulCall(ctx, t.numericLiteral(n1), t.binaryExpression('|', t.numericLiteral(n2), t.numericLiteral(1))),
          t.numericLiteral(n3)),
        t.numericLiteral(c)));
    }
    // marker 与运行期 haystack 用同一套去空白口径，runtime 先按 WS_CHARS
    // 剥离再查子串，build 侧同样先剥离，compact 取什么值都不影响
    const marker = stripWs(generate(retStmt, genOpts).code);
    // 形参名同样逐构建随机，硬编码单字母既会与产物自身的生成名同形，也可能
    // 与被混淆代码的同名绑定形成遮蔽，语义上无害但破坏了无固定名的约定
    const qf = uniqueName(ctx.usedNames, '_0x');
    const qm = uniqueName(ctx.usedNames, '_0x');
    const mw = uniqueName(ctx.usedNames, '_0x');
    sentinels.push({
      name,
      node: t.functionDeclaration(t.identifier(name), [], t.blockStatement([retStmt])),
      // 运行期子串校验器，marker 经掩码恒等式重组，去空白走内核 WS，与构建期
      // stripWs 同表，不构造 RegExp，也没有 /\s+/g 字面量和固定 marker 字节序列
      markerExpr: '(function(){var ' + qm + '=' + obfStrExpr(marker, rt && rt.tblCall) + ';return function(' + qf +
        '){return ' + (rt && rt.iof
          ? rt.iof + '(' + (rt.ws ? rt.ws + '("" + ' + qf + ')' : '("" + ' + qf + ').replace(new RegExp("[\\\\s]","g"),"")') + ',' + qm + ')>-1;};})()'
          : '("" + ' + qf + ').replace(new RegExp("["+' + obfStrExpr(WS_CHARS) + '+"]","g"),"").indexOf(' + qm + ')>-1;};})()'),
    });
  }

  // 入口校验点抽样，从根函数里挑非 VM 编译且有块体的，每个在入口注入
  // 对 peer 函数的交叉校验调用，优先覆盖体量大的函数，最多 10 个。
  const entryCandidates = targets.filter((fn) =>
    !isVMCompiled(fn) && !rtlib.isRtFn(ctx, fn) && fn.body && fn.body.type === 'BlockStatement');
  const sampleSize = Math.min(entryCandidates.length, 10);
  const sorted = [...entryCandidates].sort((a, b) =>
    (b.body ? b.body.body.length : 0) - (a.body ? a.body.body.length : 0));
  const entryTargets = [];
  const peerPool = [...targets]; // peer 只从根函数里选，都在校验面内且名字在 root
  for (let i = 0; i < sampleSize && i < sorted.length; i++) {
    const fn = sorted[i];
    const pool = peerPool.filter((f) => f !== fn);
    if (!pool.length) break;
    const peer = pool[randInt(0, pool.length - 1)];
    entryTargets.push({ fn, peer: peer.id.name, peerKey: keyOf.get(peer) });
  }

  // 入口校验点注入，必须在计算哈希之前完成，因为校验语句会进入函数体文本。
  // 引用的是 peer 而非自身，被校验函数的文本不变，哈希才稳定。每个校验点带一次
  // 性闩锁，篡改在首次调用就会被发现并投毒，检测语义不变，但 peer 的源码哈希不
  // 会在热函数的每次调用上重做，否则被抽样到大函数时单次运行代价没有上界。
  // 闩锁存在一张表上而不是各自一个 var。独立变量会与函数同名时把函数遮蔽掉：
  // var 赋值之后，同作用域里同名的函数声明就被变量取代，头校验循环里的
  // (""+fn) 取到的是变量的值（"1"）而不是函数源码，于是整片哈希假失配并被
  // 投毒，产物静默跑错。属性键用的是随机键串，与任何绑定名都不可能撞上。
  const verifierName = uniqueName(ctx.usedNames, '_0x');
  const latchObj = uniqueName(ctx.usedNames, '_0x');
  let entryInjected = 0;
  for (const ep of entryTargets) {
    const body = ep.fn.body;
    if (!body || !body.body) continue;
    const callStmt = parse(
      'if(!' + latchObj + '[' + ep.peerKey + ']){' + latchObj + '[' + ep.peerKey + ']=1;' +
      verifierName + '(' + ep.peer + ',' + ep.peerKey + ');}',
      { sourceType: 'script' }).program.body[0];
    let k = 0;
    // 跳过头部指令（Directive）以保持 'use strict' 有效
    while (k < body.body.length && body.body[k].type === 'Directive') k++;
    body.body.splice(k, 0, callStmt);
    entryInjected++;
  }

  // 构建期哈希，放在入口校验点注入之后，以最终生成的文本为准。目标包括
  // 用户函数与全部哨兵，哨兵本身也在被校验面内，形成交叉。
  const hashTargets = [...targets, ...sentinels.map((s) => s.node), ...deferred.map((d) => d.node)];

  // 校验器是单条根级 FunctionDeclaration，哈希表自包含在对象字面量里，
  // 键是每份产物随机生成的键串，值是期望哈希与掩码的异或，除毒药变量
  // 外不依赖外部绑定。头校验循环调用它完成整体哈希面。
  // 内部名全部走 uniqueName，本 pass 在 mangle 之后注入，不随机就会成为跨构建
  // 固定签名，每份产物同名同位。
  const nZ = uniqueName(ctx.usedNames, '_0x');
  const nTab = uniqueName(ctx.usedNames, '_0x');
  const nTxt = uniqueName(ctx.usedNames, '_0x');
  const nHashA = uniqueName(ctx.usedNames, '_0x');
  const nHashB = uniqueName(ctx.usedNames, '_0x');
  const nCh = uniqueName(ctx.usedNames, '_0x');
  const nK = uniqueName(ctx.usedNames, '_0x');
  const nEnt = uniqueName(ctx.usedNames, '_0x');
  for (const s of sentinels) keyOf.set(s.node, keyLit());
  const nLoop = uniqueName(ctx.usedNames, '_0x');
  const nHf = uniqueName(ctx.usedNames, '_0x');
  const nHi = uniqueName(ctx.usedNames, '_0x');
  const peekVars = sentinels.map(() => uniqueName(ctx.usedNames, '_0x'));
  const hasher = makeHasher(nLoop, rt);
  // 两条通道各用独立掩码，共用掩码会让期望值带同一常量偏移，攻击者求出该偏移
  // 就能同时还原两条通道，加宽失效
  const hashMaskA = randInt(0x10000, 0xffff00);
  const hashMaskB = randInt(0x10000, 0xffff00);
  const hashes = hashTargets.map((fn) => {
    const h = hasher.fn(stripWs(generate(fn, genOpts).code));
    return { lo: (h.lo ^ hashMaskA) >>> 0, hi: (h.hi ^ hashMaskB) >>> 0 };
  });
  // 表项是 [lo, hi] 两元素数组，单值表项等于把 64 位折叠回 32 位
  const tableEntries = hashTargets
    .map((fn, i) => keyOf.get(fn) + ':[0x' + hashes[i].lo.toString(16) +
      ',0x' + hashes[i].hi.toString(16) + ']')
    .join(',');
  // 头校验循环引用的 (函数, 键) 对
  const refPairs = targets.map((fn) => '[' + fn.id.name + ',' + keyOf.get(fn) + ']')
    .concat(sentinels.map((s) => '[' + s.name + ',' + keyOf.get(s.node) + ']'));
  // 空白剥离在运行期走内核 WS，与构建期 stripWs 同表，不构造 RegExp，
  // 也没有 /\s+/g 字面量与字符集掩码串
  const wsStrip = rt && rt.ws
    ? nTxt + '=' + rt.ws + '(' + nTxt + ');'
    : nTxt + '=' + nTxt + '.replace(new RegExp("["+' + obfStrExpr(WS_CHARS) + '+"]","g"),"");';
  const verifierLines = [];
  // 哈希表在根级只建一次并懒初始化，避免依赖插入顺序，否则每次校验调用都要
  // 重建三十多个键的对象字面量
  const nTabGlob = uniqueName(ctx.usedNames, '_0x');
  verifierLines.push('var ' + latchObj + '={};');
  verifierLines.push('var ' + nTabGlob + '=null;');
  verifierLines.push('function ' + verifierName + '(' + nZ + ',' + nK + '){');
  verifierLines.push('var ' + nTab + '=' + nTabGlob + ';if(!' + nTab + '){' + nTab + '=' + nTabGlob + '={' + tableEntries + '};}');
  verifierLines.push('var ' + nTxt + '=(""+' + nZ + ');');
  verifierLines.push(wsStrip);
  // 两条通道分别初始化，同一初值会让它们共享状态，加宽失效
  verifierLines.push('var ' + nHashA + '=0x' + (hasher.basisA >>> 0).toString(16) +
    ';var ' + nHashB + '=0x' + (hasher.basisB >>> 0).toString(16) + ';');
  verifierLines.push(hasher.verifierBody(nHashA, nHashB, nCh, nTxt));
  // 函数被整体删除或改名时查不到表项，后续取下标会抛 TypeError 中断宿主流程。
  // 这里先判缺失就投毒，保持数据坏但流程不崩的响应语义。
  verifierLines.push('var ' + nEnt + '=' + nTab + '[' + nK + '];' +
    'if(!' + nEnt + '){' + setPoisonSrc() + 'return;}');
  // 掩码以字面量内联，校验器经 wasm 布局后可能先于任何根级 var 赋值被调用，
  // 读外部 var 会拿到 undefined 而假失配投毒。两条通道掩码不同，求出单一偏移
  // 无法同时还原
  const maskLitA = '0x' + (hashMaskA >>> 0).toString(16);
  const maskLitB = '0x' + (hashMaskB >>> 0).toString(16);
  verifierLines.push('if((' + nHashA + '>>>0)!==((' + nEnt + '[0]^' + maskLitA + ')>>>0)' +
    '||(' + nHashB + '>>>0)!==((' + nEnt + '[1]^' + maskLitB + ')>>>0)){' +
    setPoisonSrc() + '}');
  verifierLines.push('}');
  // 哨兵精确子串校验器，每个哨兵一个运行期闭包，marker 经掩码重组
  for (let i = 0; i < sentinels.length; i++) {
    verifierLines.push('var ' + peekVars[i] + '=' + sentinels[i].markerExpr + ';');
  }
  // 头校验循环，对每个被校验函数含哨兵调用校验器完成整体哈希面，哨兵另外做
  // 一次精确子串校验，防的是针对哨兵体内容的定向重写
  const headLines = [];
  headLines.push('(function(){');
  headLines.push('var ' + nHf + '=[' + refPairs.join(',') + '];');
  headLines.push('for(var ' + nHi + '=0;' + nHi + '<' + nHf + '.length;' + nHi + '++){' +
    verifierName + '(' + nHf + '[' + nHi + '][0],' + nHf + '[' + nHi + '][1]);}');
  for (let i = 0; i < sentinels.length; i++) {
    headLines.push('if(!' + peekVars[i] + '(' + sentinels[i].name + ')){' + setPoisonSrc() + '}');
  }
  // 原生性探针：解壳与去断点的第一步就是把 Function.prototype.toString 这一类
  // 内建成员换成钩子，这里在装载时抽查两处仍为原生实现，非原生即投毒。探针只
  // 在装载时跑一次，特征串经掩码重组，产物里没有 "native code" 明文。
  {
    const nat = obfStrExpr('native code', rt && rt.tblCall);
    const iof = (hay, needle) => (rt && rt.iof
      ? rt.iof + '(' + hay + ',' + needle + ')'
      : '(' + hay + ').indexOf(' + needle + ')');
    const isNative = (expr) => 'typeof ' + expr + '==="function"&&' + iof('("" + ' + expr + ')', nat) + '>-1';
    const pool = [
      isNative('(typeof Object!=="undefined"?Object.defineProperty:undefined)'),
      isNative('(typeof String!=="undefined"&&String.prototype?String.prototype.split:undefined)'),
      isNative('(typeof Array!=="undefined"&&Array.prototype?Array.prototype.join:undefined)'),
    ];
    const probes = ['(typeof Function==="undefined"||!Function.prototype?true:' + isNative('Function.prototype.toString') + ')']
      .concat([pool[randInt(0, pool.length - 1)]]);
    headLines.push('try{if(!(' + probes.join('&&') + ')){' + setPoisonSrc() + '}}catch(_0w){}');
  }
  headLines.push('})();');
  const verifierParsed = parse(
    verifierLines.concat(headLines).join(''),
    { sourceType: 'script' }).program.body;

  // 插入校验器，走早带，位置在内核之后、其余头部注入之前，掩码赋值必须
  // 先于被入口注入引用的宿主函数求值。
  rtlib.insertHeadEarly(ctx, program, verifierParsed);
  program.__poisonKeys = poisonKeys;
  program.__poisonKey = poisonKeys[0];

  // 哨兵函数声明附加到 rootBody 末尾
  rootBody.push(...sentinels.map((s) => s.node));

  // 机制层延迟校验。改一处解码器文本即失配投毒：还原者最先动的就是解码器，
  // 而它过去完全不在校验面内。
  //
  // 访问器声明不一定还在 rootBody —— vm / wasm 会把部分根级语句搬进嵌套函数，
  // 所以按**语句节点**找回它实际所在的语句块，就地插一个一次性校验块（挂在
  // 闩锁表上，即便落在热函数里也只跑一次）。落在 VM 已编译函数体内的跳过：
  // 那里的代码是按字节码步执行的，插进去既不会被正常执行也破坏匹配。
  let deferredInjected = 0;
  if (deferred.length) {
    let at = -1;
    for (const d of deferred) {
      const i = rootBody.indexOf(d.stmt);
      if (i > at) at = i;
    }
    if (at >= 0) {
      const nDf = uniqueName(ctx.usedNames, '_0x');
      const nDi = uniqueName(ctx.usedNames, '_0x');
      const pairs = deferred.map((d) => '[' + d.ref + ',' + keyOf.get(d.node) + ']');
      // 不加闩锁守卫：块就在根体里、随装载跑一次；而闩锁表是校验器块里的
      // var，wasm 布局会把根级语句重排，延迟块有可能排到它前面，那时读到的是
      // undefined
      const block = parse(
        '(function(){var ' + nDf + '=[' + pairs.join(',') + '];' +
        'for(var ' + nDi + '=0;' + nDi + '<' + nDf + '.length;' + nDi + '++){' +
        verifierName + '(' + nDf + '[' + nDi + '][0],' + nDf + '[' + nDi + '][1]);}})();',
        { sourceType: 'script' }).program.body;
      rootBody.splice(at + 1, 0, ...block);
      deferredInjected = deferred.length;
    }
  }

  return {
    checked: targets.length,
    machinery: deferredInjected,
    sentinels: sentinels.length,
    entryPoints: entryInjected,
  };
};
