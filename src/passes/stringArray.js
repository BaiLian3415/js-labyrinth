import t from '../ast/types.js';
import parser from '../ast/parser.js';
const { parse } = parser;
import rand from '../utils/rand.js';
const { randInt, shuffle, randAlpha, randHex } = rand;
import encode from '../utils/encode.js';
const { xorEncode, b64Encode, rc4ToB64, utf8Encode, decoderSource, buildKeyExpr } = encode;
import rtlib from './rtlib.js';
import i18n from '../i18n.js';
const { t: msg } = i18n;
/**
 * 字符串数组池：把可收集的字符串字面量集中进每组一个数组，调用点改为
 * accessor(索引) 取值。长串按长度拆成 2 到 3 段后分散到不同组，
 * 静态只能看到片段，且与垃圾串混在一起。编码算法按组分配，xor 组用动态
 * 密钥，每次访问推进密钥偏移并原位重加密，数组本身随访问演化。
 *
 * 演化由门控调度：((槽计数 ^ 会话熵) & gate) === 0 时才推进计数并重加密。
 * gate 为 0 时每次访问都演化，默认的稀疏档每组取 1 到 3，热路径重复访问
 * 在两次演化之间命中 O(1) 明文缓存，密文快照仍按外部不可见的节奏漂移。
 * 计数与密文同步推进，解码自洽。会话熵取自运行时 Date/performance，
 * 每次运行的演化时刻都不同。
 *
 * 自愈毒链：根作用域持有一个全局属性键（__poisonKey，字符串字面量而非局部
 * 绑定，mangle 不会改名）。integrityCheck 在检测到篡改时把它置为非零，
 * 每个 accessor 在访问时检查该标志，置位后损坏返回值（首字符替换为 U+FFFD）
 * 但继续运行，数据错误而流程不崩，毒化点难以定位。机制细节见
 * integrityCheck.js 文件头。
 *
 * 索引掩码：调用点传入 pos ^ mask，accessor 先用 mask 异或还原 pos，
 * 再做旋转换算。
 *
 * 访问期自检（options.selfDefending）：装配期那次全池校验和只覆盖装载瞬间，
 * 之后改池无人过问。现在访问期再查一次——静态组按抽样门重算旋转后的全池
 * 校验和，动态 xor 组的密文每次演化都会变、校验和必然漂移，改查"密文与明文
 * 等长"这条演化不变式。命中一律损坏本次输出，与投毒同一口径：数据坏而流程
 * 继续，不给攻击者可定位的抛出点。
 *
 * 旋转语义：数组写入后左旋 R 次，原先第 p 位的元素落到 (p - R + len) % len，
 * accessor 把传入的原始索引 p 换算成当前位置。
 *
 * 体积与运行时预算：本 pass 是产物体积和解析延迟的主要来源，以下几处保持
 * 注入代码精简且不降低强度。xor 组直接用原始码元承载密文，构建期密文字面量
 * 约 1 字符/码元，省掉 hex 的 4 字符；会话熵与全局对象引用作为共享引导语句
 * 在根作用域只输出一次，不再逐组内联 typeof 探测链和熵闭包，各 accessor
 * 按名引用；解码器 IIFE 内部绑定用每次构建随机生成的 3 到 5 字符短名并登记
 * 进 ctx.keepNames，否则 mangle 会把每处引用拉长到 7 到 24 字节的随机名
 * （CJK 字形名还要 \uXXXX 转义），撑大注入头部；accessor IIFE 标记为
 * __saMachinery，debugProtection 对其跳过逐调用自哈希哨兵，理由与跳过
 * VM 体和 RT 内核相同，accessor 每次取字符串都要执行，哨兵自哈希会把一次性
 * 成本摊成每次访问的成本。用户真实函数的哨兵照常注入。
 */

// RT 内核函数体内的字符串不入池：COR/FCC/ACCESSOR 互相引用，入池会形成
// 解码器自举环，毒化路径下 COR 经 accessor 回到 COR 会无限递归
function insideRtKernel(path) {
  let p = path.parentPath;
  while (p) {
    if (p.node && p.node.__rtKernel) return true;
    p = p.parentPath;
  }
  return false;
}

function isEligible(path) {
  const p = path.parentPath;
  if (!p) return false;
  if (path.node.__noPool) return false; // RT 内核字符表，解码器自举依赖它，不入池
  if (insideRtKernel(path)) return false; // 内核函数体整体不入池
  const n = p.node;
  if (p.isDirective() || (n && n.type === "Directive")) return false;
  if (p.isObjectProperty()) {
    if (n.computed) return true;
    // 值位置的字符串正常收集，键位置的也收集：收集阶段先把父属性置 computed，
    // 替换阶段才能在键位放进解码调用。{"__proto__": v} 这类字面量键转成计算
    // 属性会改变原型设置语义，跳过
    if (n.key === path.node) return path.node.value !== "__proto__";
    return true;
  }
  if (p.isObjectMethod() && !n.computed) return false;
  if (p.isClassMethod() && !n.computed) return false;
  if (p.isMemberExpression() && !n.computed) return false;
  if (p.isImportDeclaration() || p.isExportNamedDeclaration() || p.isExportAllDeclaration() || p.isExportDefaultDeclaration()) return false;
  return true;
}

const SURROGATE_RE = /[\uD800-\uDFFF]/;

function splitInto(value) {
  const n = value.length;
  // 拆段数按长度定档，短于 24 字符固定 2 段，达到 24 才取 2 到 3 段。
  // 短串拆 3 段只会撑大调用点和池条目，片段太短也没有语义可藏，
  // 不增加静态分析难度。
  const k = n >= 24 ? randInt(2, 3) : 2;
  const cuts = new Set();
  while (cuts.size < k - 1) cuts.add(randInt(1, n - 1));
  const sorted = [...cuts].sort((a, b) => a - b);
  const parts = [];
  let prev = 0;
  for (const c of sorted) {
    parts.push(value.slice(prev, c));
    prev = c;
  }
  parts.push(value.slice(prev));
  return parts;
}

/** 字符串数组 → 字面量 JSON（碎片载体用）。 */
function listLiteral(xs) {
  return "[" + xs.map((s) => JSON.stringify(s)).join(",") + "]";
}

function globalRef() {
  return '(typeof globalThis!=="undefined"?globalThis:typeof self!=="undefined"?self:typeof window!=="undefined"?window:typeof global!=="undefined"?global:{})';
}

export default function stringArray(ast, options, ctx) {
  const { traverse, rng } = ctx;
  const used = ctx.usedNames;
  const encoding = options.stringArrayEncoding || "xor";
  const threshold = options.stringArrayThreshold !== undefined ? options.stringArrayThreshold : 0.9;
  const splitThreshold = options.stringSplitThreshold !== undefined ? options.stringSplitThreshold : 12;
  const splitProbability = options.stringSplitProbability !== undefined ? options.stringSplitProbability : 0.5;
  const useIndexMask = options.stringIndexMask !== false;
  // 解密分散化：拆更多组，每组独立算法、密钥和解码结构
  const decompose = options.stringArrayDecompose !== undefined ? options.stringArrayDecompose : 2;
  // 动态 xor 槽位演化门。取 0 表示每次访问都推进计数并重加密；默认的
  // "sparse" 每组随机取 1 到 3，热路径重复访问在两次演化之间命中 O(1)
  // 明文缓存，密文快照仍按外部不可见的节奏漂移
  const evolveOpt = options.stringArrayEvolve !== undefined ? options.stringArrayEvolve : "sparse";
  let evolveFixed = null;
  if (evolveOpt === "each") evolveFixed = 0;
  else if (evolveOpt === "sparse") evolveFixed = null;
  else if (typeof evolveOpt === "number" && Number.isInteger(evolveOpt) && evolveOpt >= 0 && evolveOpt <= 7) evolveFixed = evolveOpt;
  else throw new Error(msg("badStringArrayEvolve", { v: JSON.stringify(evolveOpt) }));
  // 多进制编码：各组可用不同编码算法，破坏统一还原器。无论是否混编，
  // 恒有至少一组走 xor 并带动态密钥和访问后原位重加密，这一特性不随
  // 用户指定的主编码算法而缺失
  // 字符串碎片化：把每组的池内容拆成多个短载体分散声明，运行期拼回；
  // 静态面上不再有任何一处集中存放整池密文
  const scatter = options.stringScatter === true;
  let scatterCarriers = 0;
  let scatterItems = 0;

  const mixedEncoding = options.stringArrayMixedEncoding !== false;
  // 诱饵串：垃圾串池里混入高信号假串，包含假密钥、假 URL、假 token。
  // 语义分析和 LLM 归纳会被引向并不存在的外部资产
  const honey = options.honeyStrings !== false;
  // reservedStrings：匹配的字符串字面量不收集 / 不拆分 / 不编码（正则保留名单）

  // 两类并成一个匹配器。字面量必须转义并**加锚点**：reservedStrings 那边是用户手写的
  // 正则、语义本就是不锚定的 test，若把字面量直接丢进去，"abc" 会连 "abcd" 一起命中。
  const reservedRe = (options.reservedStrings || [])
    .map((s) => { try { return new RegExp(s); } catch (e) { return null; } })
    .filter(Boolean);
  const isReservedString = (v) => reservedRe.length > 0 && reservedRe.some((re) => re.test(v));

  const candidates = [];
  traverse(ast, {
    StringLiteral(path) {
      if (!isEligible(path)) return;
      if (isReservedString(path.node.value)) return;
      if (rng() > threshold) return;
      // 非计算属性的键位置字符串要先置 computed，才能在键位换成解码调用
      const pp = path.parentPath;
      if (pp && pp.isObjectProperty && pp.isObjectProperty() && !pp.node.computed && pp.node.key === path.node) {
        pp.node.computed = true;
      }
      candidates.push({ path, value: path.node.value, parts: null });
    },
    TemplateLiteral(path) {
      if (path.node.expressions.length > 0) return;
      if (rng() > threshold) return;
      const quasis = path.node.quasis;
      if (quasis.length !== 1) return;
      const q = quasis[0].value;
      const value = q.cooked !== undefined && q.cooked !== null ? q.cooked : q.raw;
      if (isReservedString(value)) return;
      candidates.push({ path, value, parts: null });
    },
    noScope: true,
  });

  if (candidates.length === 0) return { count: 0, items: 0, groups: 0, split: 0 };

  let splitCount = 0;
  // splitThreshold 是最小可拆长度，options.js 默认 1，即长于 1 字符就能拆。
  // 长度小于 2 的串拆不出两段，会产生空段，所以下界取 2。
  if (encoding !== "none" && splitThreshold >= 1) {
    for (const c of candidates) {
      if (c.value.length >= Math.max(2, splitThreshold) && !SURROGATE_RE.test(c.value) && rng() < splitProbability) {
        c.parts = splitInto(c.value);
        splitCount++;
      }
    }
  }

  const valueToIdx = new Map();
  const items = [];
  const addItem = (v) => {
    if (!valueToIdx.has(v)) {
      valueToIdx.set(v, items.length);
      items.push(v);
    }
  };
  for (const c of candidates) {
    if (c.parts) for (const p of c.parts) addItem(p);
    else addItem(c.value);
  }

  // 组数随 items 数量扩展，默认取 decompose 倍再加随机量，每组独立编码算法、
  // 密钥和解码结构，不再固定成 2 到 3 个统一 IIFE。组数同时按条目密度封顶，
  // 约 6 条一组：条目少时不为凑组数生成多个解码 IIFE，每个组头一到两 KB，
  // 小组多组只是纯粹的头部膨胀。
  const minGroups = items.length <= 12 ? 1 : 2;
  const densityCap = Math.max(minGroups, Math.ceil(items.length / 6));
  const groupCount = Math.min(Math.max(minGroups, items.length <= 12 ? 1 : randInt(minGroups, minGroups + decompose)), densityCap, 8);
  const groups = Array.from({ length: groupCount }, () => []);
  for (let i = 0; i < items.length; i++) groups[i % groupCount].push(items[i]);

  const valueToAccessor = new Map();

  const iifeStatements = [];
  // 毒药标志多点化：N 个独立全局属性，integrityCheck 全部置位，解码器
  // 任一置位即毒化输出。清除需要找到全部 N 个随机属性名。
  const poisonCount = Math.min(4, Math.max(2, options.integrityPoisonPoints !== undefined ? options.integrityPoisonPoints : 3));
  const poisonKeys = [];
  while (poisonKeys.length < poisonCount) {
    let k;
    do {
      k = '__x' + randInt(0x100000, 0xffffff).toString(16);
    } while (poisonKeys.includes(k));
    poisonKeys.push(k);
  }
    const poisonKey = poisonKeys[0];

  // 注入代码短名：每构建随机生成并豁免 mangle。IIFE 内部绑定有解码循环、
  // 缓存、计数器等约 30 个，交给 mangle 改名会让每次引用变成 7 到 24 字节的
  // 随机名，CJK 字形名还要 \uXXXX 转义，是注入头部膨胀的主要常数项。
  // 这里每构建生成一批 3 到 5 字符的短随机名，登记进 used 防撞，
  // 同时登记 keepNames 让 mangle 原样保留，逐构建随机，不产生跨产物指纹。
  // 访问器名和池数组名同批生成，调用点的每个访问器调用随之缩短。
  const keep = ctx.keepNames || (ctx.keepNames = new Set());
  const nm = {};
  const shortName = (slot) => {
    for (;;) {
      let name;
      const roll = randInt(0, 2);
      if (roll === 0) name = "_" + randHex(randInt(2, 4));
      else if (roll === 1) name = "$" + randHex(randInt(2, 3));
      else name = "_0x" + randHex(randInt(1, 2));
      if (!used.has(name)) {
        used.add(name);
        keep.add(name);
        if (slot !== undefined) nm[slot] = name;
        return name;
      }
    }
  };
  for (const slot of [
    "arr", "rot", "g", "e", "et", "ee", "ee2",
    "i", "s", "o", "m", "mc", "cc", "ka", "kl", "k",
    "c", "cu", "cu2", "j", "j2", "kp", "kp2", "zk", "zi", "zc",
    "n2", "r", "h", "z", "q", "u", "tp", "zr", "dec",
    // 密钥耦合偏移（P0）：首次访问时从健康载体读出的解密密钥偏移量。
    // 未启用耦合时这个绑定不会出现在产物里
    "dk",
  ]) shortName(slot);
  // 访问期自检用的计数器与重算临时量，见 buildIifeSource 里的抽样校验。
  // 只在自检开启时分配：短名分配会消耗 PRNG，低档预设关了自检，多分配五个
  // 名字会让整条随机流后移，产物字节随之全变，可复现性比对就对不上了
  if (options.selfDefending) {
    for (const slot of ["cn", "h2", "z2", "q2", "u2"]) shortName(slot);
  }

  // 共享引导语句：全局对象引用加会话熵。全部组复用同一绑定，产物里只出现
  // 一次，旧写法逐组内联 typeof 链和熵闭包，每组重复约 400 字节的纯头部。
  // 会话熵用于派生动态密钥，运行时从时间和性能计数器取值，带 try/typeof
  // 守卫，Node、浏览器和 Workers 都安全。首次解密仍用构建态计数 0，正确性
  // 不受影响；此后每个槽的计数器演化混入会话熵，密文演化路径按会话熵、
  // 槽位和访问次数分化，静态 dump 出的密文快照每次运行都不同，彼此不可复用
  const sharedSrc = "var " + nm.g + "=" + globalRef() + ";var " + nm.e + "=(function(){var " + nm.et + "=0;" +
    "try{" + nm.et + "=(new Date().getTime())&0xff;}catch(" + nm.ee + "){}" +
    'try{if(typeof performance!=="undefined"&&performance.now)' + nm.et + "^=(performance.now()*1000)&0xff;}catch(" + nm.ee2 + "){}" +
    "return " + nm.et + ";})();";
  const sharedParsed = parse(sharedSrc, { sourceType: "script" });
  const sharedStatements = sharedParsed.program.body;
  for (const st of sharedStatements) markMachinery(st);

  // 每组独立的算法池，不同组用不同算法，破坏统一还原器。xor、base64 和 rc4
  // 的结构各不相同，反混淆器要分别还原。
  const ALGO_POOL = ["xor", "base64", "rc4"];
  // 恒有至少一组走 xor 动态密钥，其余组按 mixedEncoding 决定混编还是统一算法
  const forcedXorGroup = randInt(0, groupCount - 1);
  const groupAlgos = [];
  for (let g = 0; g < groupCount; g++) {
    groupAlgos.push(g === forcedXorGroup
      ? "xor"
      : (mixedEncoding ? ALGO_POOL[randInt(0, ALGO_POOL.length - 1)] : encoding));
  }
  for (let g = 0; g < groupCount; g++) {
    const groupItems = groups[g];
    const junkCount = randInt(2, 4);
    for (let i = 0; i < junkCount; i++) groupItems.push(honey && randInt(0, 1) === 0 ? honeyString() : randomGarbage());

    const order = groupItems.map((_, i) => i);
    shuffle(order);
    const shuffled = order.map((i) => groupItems[i]);
    const posMap = new Map();
    for (let p = 0; p < shuffled.length; p++) posMap.set(shuffled[p], p);

    // 每组算法预先分配好，恒选的动态 xor 已占一组
    const groupEnc = groupAlgos[g];
    // 密钥碎片化：密钥不以单个明文出现，拆成 2 到 3 片，运行时重组
    const key = groupEnc !== "none" ? randAlpha(randInt(8, 20)) : "";
    const encodedItems = shuffled.map((s) => {
      switch (groupEnc) {
        case "none": return s;
        case "xor": return xorEncode(s, key);
        case "base64": return b64Encode(utf8Encode(s));
        case "rc4": return rc4ToB64(utf8Encode(s), key);
        default: throw new Error("unknown encoding: " + groupEnc);
      }
    });

    const maxRot = Math.min(13, Math.max(0, shuffled.length - 1));
    const rotation = options.stringArrayRotate === false ? 0 : randInt(0, maxRot);
    const mask = useIndexMask ? randInt(0x100, 0xffffff) : 0;
    const checksum = options.selfDefending ? hashItems(encodedItems) : null;
    // 访问期校验和必须按**旋转后**的顺序算：装配期的校验跑在旋转之前，而访问
    // 期看到的池已经左旋过 R 位，FNV 与顺序相关，直接拿旋转前的期望值比对会
    // 每一组都失配，把正常产物自己毒掉
    // 注意旋转的是**密文**数组：池里存的是 encodedItems，运行期重算走的也是它
    const rotatedItems = rotation > 0
      ? encodedItems.slice(rotation).concat(encodedItems.slice(0, rotation))
      : encodedItems;
    const checksumRot = options.selfDefending ? hashItems(rotatedItems) : null;
    // 访问器名和池数组名：短随机名并豁免 mangle，调用点每次都会引用访问器名
    const accessorName = shortName();
    const listVar = shortName();
    // 字符串碎片化：池内容按固定片数逐项切开，分散到多个载体数组里声明，
    // 运行期按位拼回。静态看到的是若干互不相干的短串载体，没有任何一处
    // 集中存放整池；片数、载体名与切点逐次随机。
    let arrExpr = null;
    if (scatter && encodedItems.length) {
      const fragCount = Math.min(randInt(2, 4), Math.max(1, Math.floor(encodedItems[0].length / 2) || 1));
      scatterItems += encodedItems.length;
      scatterCarriers += fragCount;
      const carriers = [];
      for (let cf = 0; cf < fragCount; cf++) carriers.push([]);
      for (const s of encodedItems) {
        const n = s.length;
        if (fragCount < 2 || n < fragCount) {
          carriers[0].push(s);
          for (let cf = 1; cf < fragCount; cf++) carriers[cf].push("");
          continue;
        }
        let prev = 0;
        for (let cf = 0; cf < fragCount; cf++) {
          const end = cf === fragCount - 1 ? n : Math.max(prev + 1, Math.min(n - (fragCount - cf - 1), Math.round((n * (cf + 1)) / fragCount)));
          carriers[cf].push(s.slice(prev, end));
          prev = end;
        }
      }
      const carrierNames = [];
      for (let cf = 0; cf < fragCount; cf++) {
        const nm2 = shortName();
        carrierNames.push(nm2);
        const stmt = parse("var " + nm2 + "=" + listLiteral(carriers[cf]) + ";", { sourceType: "script" }).program.body[0];
        markMachinery(stmt);
        // 载体数组是 stringScatter 的运行时必需物（关闭调用点包装时也要在），
        // 所以这里无条件进共享 IIFE——原先写了个 stringArrayCallsTransform 的
        // 分支但两臂完全相同，是个留下的死分支。
        iifeStatements.push(stmt);
      }
      const ps = [];
      for (let cf = 0; cf < fragCount; cf++) ps.push("a" + cf);
      arrExpr = "(function(" + ps.join(",") + "){var o=[],q;for(q=0;q<a0.length;q++){o[q]=" +
        ps.map((p) => p + "[q]").join("+") + ";}return o;})(" + carrierNames.join(",") + ")";
    }

    const iifeSource = buildIifeSource({
      listVar, encodedItems, encoding: groupEnc, key, rotation, mask,
      selfDefending: !!options.selfDefending, checksum, checksumRot, poisonKeys,
      rt: ctx.rt, cache: options.stringArrayCache !== false,
      evolveMask: evolveFixed !== null ? evolveFixed : randInt(1, 3),
      nm, arrExpr,
      // 密钥耦合：把完整性校验的偏移量混进解密密钥，见 buildIifeSource 的说明
      couple: ctx.couple || null,
    });
    const parsed = parse("var " + accessorName + "=" + iifeSource + ";", { sourceType: "script" });
    // 标记为引导机制函数。debugProtection 的内联哨兵每次调用都要重哈希自身
    // 源码，调用越频繁成本越高，这与它对 VM 体和 RT 内核整函数跳过的理由
    // 一致：高频机制层加哨兵的保护价值趋近于零。解码器每次访问都被调用，
    // 整段跳过。用户真实函数的哨兵覆盖不受影响。
    markMachinery(parsed.program.body[0]);
    iifeStatements.push(parsed.program.body[0]);
    // 登记访问器，供 integrityCheck 把它纳入校验面。取的是 IIFE 返回出去的那个
    // 函数节点：运行期 accessor.toString() 拿到的正是这一段文本，构建期哈希同一
    // 个节点即可逐字比对。语句节点一并给出，校验器据此定位"声明之后"的插入点——
    // 装载最早期访问器还是 undefined，不能在头部循环里引用。
    const accFn = returnedFn(parsed.program.body[0]);
    if (accFn) {
      const progNode = ast.type === "File" ? ast.program : ast;
      (progNode.__saAccessors || (progNode.__saAccessors = []))
        .push({ stmt: parsed.program.body[0], name: accessorName, node: accFn });
    }

    // 调用点包装链：每个 accessor 外面再包 2 到 5 层单表达式函数，每层把索引
    // 再 XOR 一个构建期常量（与 mask 正交：要还原真实索引必须整条剥完链条、
    // 并累出各层常量的异或和），最外层才是调用点入口。层间链式调用，每层另带
    // 0 到 4 个从不使用的 junk 参数，逐层签名各不相同。包装层标记为
    // __saMachinery——访问频度与 accessor 相同，debugProtection 同样跳过哨兵；
    // 名字走 shortName 豁免 mangle。全部随机量（层数、常量、名字、junk 个数）
    // 只在选项开启时消耗 PRNG：关闭它的预设随机流不动，产物逐字节可复现。
    let entryName = accessorName;
    let entryXor = 0;
    let entryJunk = 0;
    if (options.stringArrayCallsTransform === true) {
      const layers = randInt(2, 5);
      let prevName = accessorName;
      for (let li = 0; li < layers; li++) {
        const layerConst = randInt(0x100, 0xffffff);
        entryXor ^= layerConst;
        const idxParam = shortName();
        const junkCount = randInt(0, 4);
        const junkParams = [];
        for (let jj = 0; jj < junkCount; jj++) junkParams.push(shortName());
        const wName = shortName();
        const wrapperSrc = "var " + wName + "=function(" + [idxParam].concat(junkParams).join(",") +
          "){return " + prevName + "(" + idxParam + "^0x" + layerConst.toString(16) + ");};";
        const wparsed = parse(wrapperSrc, { sourceType: "script" });
        markMachinery(wparsed.program.body[0]);
        iifeStatements.push(wparsed.program.body[0]);
        prevName = wName;
        entryJunk = junkCount;
      }
      entryName = prevName;
    }

    for (const v of groupItems) {
      const pos = posMap.get(v);
      if (pos !== undefined && !valueToAccessor.has(v)) {
        valueToAccessor.set(v, { accessorName, pos, mask, entryName, entryXor, entryJunk });
      }
    }
  }

  const program = ast.type === "File" ? ast.program : ast;
  // 共享引导语句（gref 和熵）先于各组 IIFE 插入，保证绑定先建立
  rtlib.insertHead(ctx, program, [...sharedStatements, ...iifeStatements]);
  program.__poisonKey = poisonKey;
  program.__poisonKeys = poisonKeys;

  // 调用点：走包装链入口（未开包装链时 entryName 即 accessor 本名）。实参是
  // (pos ^ mask) ^ entryXor——entryXor 为链上各层常量的异或和，accessor 侧
  // 逐层还原后收到的仍是 pos ^ mask，语义与无包装链完全一致。junk 实参个数
  // 与入口层形参一一对应，值逐调用点随机。
  const makeCall = (acc) => {
    const args = [t.numericLiteral((acc.pos ^ acc.mask) ^ (acc.entryXor || 0))];
    const jn = acc.entryJunk || 0;
    for (let k = 0; k < jn; k++) args.push(t.numericLiteral(randInt(0, 0xffff)));
    return t.callExpression(t.identifier(acc.entryName || acc.accessorName), args);
  };

  let replaced = 0;
  for (const c of candidates) {
    if (c.parts) {
      const exprs = [];
      let ok = true;
      for (const p of c.parts) {
        const acc = valueToAccessor.get(p);
        if (!acc) { ok = false; break; }
        exprs.push(makeCall(acc));
      }
      if (!ok) continue;
      let expr = exprs[0];
      for (let i = 1; i < exprs.length; i++) expr = t.binaryExpression("+", expr, exprs[i]);
      c.path.replaceWith(expr);
      replaced++;
    } else {
      const acc = valueToAccessor.get(c.value);
      if (!acc) continue;
      c.path.replaceWith(makeCall(acc));
      replaced++;
    }
  }

  if (replaced > 0) {
    traverse(ast, {
      Program(path) {
        path.scope.crawl();
      },
      noScope: true,
    });
  }
  return { count: replaced, items: items.length, groups: groupCount, split: splitCount,
    scatterCarriers, scatterItems };
};

// 把解码器 IIFE 内的所有函数节点标为引导机制层，debugProtection 依据此标记
// 跳过内联哨兵。与它跳过 VM 体和 RT 内核的原因相同：高频调用点会把每次
// 调用的自哈希成本放大，而且机制函数没有用户语义需要保护。用户真实函数
// 照常注入。
function markMachinery(node) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const c of node) markMachinery(c);
    return;
  }
  if (typeof node.type === "string" &&
      (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" ||
       node.type === "ArrowFunctionExpression")) {
    node.__saMachinery = true;
  }
  for (const k of Object.keys(node)) {
    if (k === "loc" || k === "start" || k === "end" || k === "extra") continue;
    markMachinery(node[k]);
  }
}

/**
 * 取 IIFE 形式访问器里返回出去的那个函数节点。
 * `var A=(function(a,r){...return function(i){...};})([...],0xN)` 中，运行期
 * A.toString() 是 return 后面那个函数，构建期要与其逐字比对就得找同一个节点。
 */
function returnedFn(stmt) {
  const decl = stmt && stmt.declarations && stmt.declarations[0];
  const init = decl && decl.init;
  if (!init || init.type !== "CallExpression") return null;
  const callee = init.callee;
  if (!callee || !callee.body || !callee.body.body) return null;
  for (const s of callee.body.body) {
    if (s.type === "ReturnStatement" && s.argument &&
        (s.argument.type === "FunctionExpression" || s.argument.type === "ArrowFunctionExpression")) {
      return s.argument;
    }
  }
  return null;
}

function hashItems(items) {
  let h = 0x811c9dc5;
  for (const s of items) {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
}

function buildIifeSource({ listVar, encodedItems, encoding, key, rotation, mask, selfDefending, checksum, checksumRot, poisonKeys, rt, cache, evolveMask, nm, arrExpr, couple }) {
  const arrLit = "[" + encodedItems.map((s) => JSON.stringify(s)).join(",") + "]";
  // 碎片化时调用方给出「多载体拼回」表达式；默认仍是单个数组字面量
  const arrArg = arrExpr || arrLit;
  const dynamicXor = encoding === "xor";
  // xor 组用内联演化解码器，decoderSource 只有非 xor 组才需要
  const dec = dynamicXor ? "" : decoderSource(encoding, key, randInt, rt);
  const keyExpr = buildKeyExpr(key, randInt, rt && rt.tblCall);
  // rt 缺失即内核被绕过时的原生回退
  const fcc = (rt && rt.fcc) ? ((c) => rt.fcc + "(" + c + ")") : ((c) => "String.fromCharCode(" + c + ")");
  const cco = (expr, i) => (rt && rt.cco) ? rt.cco + "(" + expr + "," + i + ")" : expr + ".charCodeAt(" + i + ")";
  // gref 和熵绑定由共享引导语句在根作用域声明，这里只引用
  const gref = nm.g;
  // ---- 密钥耦合（P0）----
  //
  // 解密密钥偏移 dk 从健康载体（一个随机全局属性）读出，装载期由 integrityCheck
  // 写入「健康常量 + 累计偏移」，横幅自检再追加横幅偏移。代码未被改动时
  // dk === 0，下面每一处耦合式子都退化成恒等，密文与明文逐位不变；任一处被改
  // → dk ≠ 0 → 解码整体偏移，字符串静默变乱码。
  //
  // 惰性求值：池 IIFE 可能在装载早期就执行，那时校验器还没跑；而 dk 只影响
  // 解码结果、不影响装配，所以推迟到首次访问时定值即可，且顺带绕开
  // 「头部块插入顺序」这一层实现依赖。
  //
  // 读取端用 (值|0)-OK：校验器被整体删除时读到 undefined，得到 -OK 而非 0，
  // 于是「删掉校验器」也修不好字符串——这条没有对应的 if，攻击者找不到可以
  // NOP 的判断。
  const cRef = couple ? gref + "[\"" + couple.name + "\"]" : null;
  const OK_LIT = couple ? "0x" + (couple.ok >>> 0).toString(16) : null;
  // 每次访问重算偏移，不做"首次定值 + 缓存"：池访问器可能在装载早期就被调用
  // （例如 debugProtection 的哨兵在装载早期就立刻跑），那时校验器
  // 还没写健康值，缓存下来的 -OK 会把正常产物自己打成乱码。每次读一个属性、
  // 做一次减法，成本可忽略；好处是横幅的偏移、各校验点累加的偏移在任何时刻
  // 到达都能立刻生效，不存在"先解出的明文留着好数据"的窗口。
  const dkDecl = couple ? "var " + nm.dk + "=((" + cRef + "|0)-" + OK_LIT + ");" : "";
  // 非 xor 组的密钥不以整数形式参与，改在解码结果上做一次恒等扰动：把首码元异或
  // 一个由 dk 折叠出的掩码。折叠走按位或——只有 dk 每一位都是 0 才得到 0，不存在
  // 「dk 非零但掩码为零」的白名单情形；dk === 0 时整式恒等于原字符串（逐位可
  // 验证），正常产物不受影响。
  //
  // **空串必须跳过**：池里的空串有实际用途（拼名时的 join("") 分隔符），而空串没有
  // 首码元，charCodeAt(0) 是 NaN，fromCharCode(NaN) 会把它变成 "\u0000" 之类的脏
  // 字符，拼出来的方法名就错了（实测表现为 "undefined is not a function"）。长度
  // 判断只影响空串、与毒化语义无关。
  const dkMix = couple
    ? "(((" + nm.dk + "|(" + nm.dk + ">>>8)|(" + nm.dk + ">>>16)|(" + nm.dk + ">>>24))&0xffff)&0xff)"
    : null;
  const dkMutate = couple
    ? "if(" + nm.o + ".length){" + nm.o + "=" + fcc(cco(nm.o, "0") + "^" + dkMix) + "+" + nm.o + ".slice(1);}"
    : null;
  // 多点毒药检查：任一标志置位就损坏输出，与 integrityCheck 的置位集合联动
  const poisonTest = poisonKeys
    .map((k) => gref + '["' + k + '"]')
    .join('||') || 'false';
  // 明文缓存：槽位密文按演化门推进，两次演化之间直接返回缓存明文
  const cacheOpen = cache ? "var " + nm.o + "=" + nm.m + "[" + nm.i + "];if(" + nm.o + "===undefined){" : "var " + nm.o + "=";
  const cacheClose = cache ? nm.m + "[" + nm.i + "]=" + nm.o + ";" + nm.mc + "[" + nm.i + "]=" + nm.c + ";}" : "";
  const lines = [];
  lines.push("(function(" + nm.arr + "," + nm.rot + "){");
  lines.push("var " + listVar + "=" + nm.arr + ";");
  if (selfDefending) lines.push("var " + nm.cn + "=0;");
  if (cache) lines.push("var " + nm.m + "=[];");
  if (dynamicXor) {
    if (cache) lines.push("var " + nm.mc + "=[];");
    lines.push("var " + nm.k + "=" + keyExpr + ";");
    // 密钥码表在装配期展开一次，热路径不再逐字符对密钥串取码，密钥游标用
    // 自增回绕替代每字符取模。原始码元密文下，解码和重加密每码元各一次
    // CCO 或 XOR 加 FCC。密文演化序列、槽位内容和访问语义都不变。
    // 密钥耦合的偏移不在这里并入（会固化成装配期的值），改在解码/重加密的
    // 每码元 XOR 里各带一次，见下面的 cu、cu2。
    lines.push("var " + nm.kl + "=" + nm.k + ".length;var " + nm.ka + "=[];" +
      "for(var " + nm.zk + "=0;" + nm.zk + "<" + nm.kl + ";" + nm.zk + "++)" + nm.ka + "[" + nm.zk + "]=" + cco(nm.k, nm.zk) + ";");
    lines.push("var " + nm.cc + "=[];for(var " + nm.zi + "=0;" + nm.zi + "<" + listVar + ".length;" + nm.zi + "++)" + nm.cc + "[" + nm.zi + "]=0;");
  } else {
    lines.push("var " + nm.dec + "=" + dec + ";");
  }
  // 全池 FNV 校验和的源码模板。装配期跑一次（失配即抛，fail-closed），
  // 访问期另起一组临时名按抽样门再跑（失配改为损坏输出，流程不崩）。
  // 两组临时名不同，避免同名的 var 在同一作用域里互相覆盖。
  const poolHashLoop = (hVar, zVar, qVar, uVar) =>
    "var " + hVar + "=0x811c9dc5;" +
    "for(var " + zVar + "=0;" + zVar + "<" + listVar + ".length;" + zVar + "++){" +
    "var " + qVar + "=" + listVar + "[" + zVar + "];" +
    "for(var " + uVar + "=0;" + uVar + "<" + qVar + ".length;" + uVar + "++){" +
    hVar + "^=" + cco(qVar, uVar) + ";" + hVar + "=(" + hVar + "*0x01000193)>>>0;" +
    "}" +
    "}";
  if (selfDefending && checksum !== null && checksum !== undefined) {
    lines.push(poolHashLoop(nm.h, nm.z, nm.q, nm.u));
    lines.push("if(" + nm.h + "!==0x" + checksum.toString(16) + '){throw new Error("bad");}');
  }
  if (rotation > 0) {
    // 左旋用纯索引轮转，不引入 push/shift 这类原生调用点
    lines.push("while(!!" + nm.rot + "){var " + nm.tp + "=" + listVar + "[0];");
    lines.push("for(var " + nm.zr + "=1;" + nm.zr + "<" + listVar + ".length;" + nm.zr + "++)" + listVar + "[" + nm.zr + "-1]=" + listVar + "[" + nm.zr + "];");
    lines.push(listVar + "[" + listVar + ".length-1]=" + nm.tp + ";" + nm.rot + "--;}");
  }
  lines.push("return function(" + nm.i + "){");
  lines.push(nm.i + "=+" + nm.i + ";");
  // 每次访问现算密钥偏移，见 dkDecl 的说明
  if (couple) lines.push(dkDecl);
  if (mask > 0) {
    lines.push(nm.i + "=" + nm.i + "^0x" + mask.toString(16) + ";");
  }
  if (rotation > 0) {
    lines.push(nm.i + "=" + nm.i + "-0x" + rotation.toString(16) + ";");
    lines.push("if(" + nm.i + "<0)" + nm.i + "+=" + listVar + ".length;");
  }
  lines.push("var " + nm.s + "=" + listVar + "[" + nm.i + "];");
  if (selfDefending) {
    lines.push('if(' + nm.s + '===undefined){throw new Error("missing");}');
    lines.push("if(" + listVar + ".length!==0x" + encodedItems.length.toString(16) + '){throw new Error("bad");}');
  }
  if (dynamicXor) {
    // 冷访问：原始密文逐码元与密钥码表异或后再用 FCC 重组，明文和明文码元表
    // 都缓存，每码元一次 CCO，hex 半字节解码链整体去掉。
    // 热访问：直接返回明文缓存，O(1)。只有演化门 ((槽计数 ^ 会话熵) & 演化掩码)
    // 为 0 时才推进计数并从码元表原位重加密，每码元一次 XOR 加 FCC。
    // 掩码为 0 时每次访问都演化。计数与密文同步推进，解码自洽。
    lines.push(cacheOpen);
    // 首段的 O=""; 让 cache=false 时的 var O= 拼接成合法的链式赋值
    lines.push(nm.o + '="";var ' + nm.c + "=[];for(var " + nm.j + "=0," + nm.kp + "=" + nm.cc + "[" + nm.i + "]%" + nm.kl + ";" + nm.j + "<" + nm.s + ".length;" + nm.j + "++){");
    lines.push("var " + nm.cu + "=" + cco(nm.s, nm.j) + "^" + nm.ka + "[" + nm.kp + "]" + (couple ? "^" + nm.dk : "") + ";" + nm.c + "[" + nm.c + ".length]=" + nm.cu + ";" + nm.o + "+=" + fcc(nm.cu) + ";");
    lines.push(nm.kp + "++;if(" + nm.kp + ">=" + nm.kl + "){" + nm.kp + "=0;}}");
    lines.push(cacheClose);
    // 重加密的码元源：缓存开启时取明文码元表，stringArrayCache=false 时从刚
    // 解码出的明文即时重建，每码元一次 CCO，只有演化命中的访问才付出这个成本
    lines.push(cache
      ? "var " + nm.c2 + "=" + nm.mc + "[" + nm.i + "];"
      : "var " + nm.c2 + "=[];for(var " + nm.zc + "=0;" + nm.zc + "<" + nm.o + ".length;" + nm.zc + "++)" + nm.c2 + "[" + nm.zc + "]=" + cco(nm.o, nm.zc) + ";");
    lines.push("if(((" + nm.cc + "[" + nm.i + "]^" + nm.e + ")&0x" + evolveMask.toString(16) + ")===0){");
    // 新计数偏移由访问序数加会话熵混合项得到，重加密和计数器写入共用同一
    // 偏移，保证下次访问时解密自洽
    lines.push("var " + nm.n2 + "=" + nm.cc + "[" + nm.i + "]+1+(((" + nm.i + "^" + nm.e + ")+(" + nm.i + "&" + nm.e + "))&0xff);");
    lines.push('var ' + nm.r + '="";');
    lines.push("for(var " + nm.j2 + "=0," + nm.kp2 + "=" + nm.n2 + "%" + nm.kl + ";" + nm.j2 + "<" + nm.c2 + ".length;" + nm.j2 + "++){");
    lines.push("var " + nm.cu2 + "=" + nm.c2 + "[" + nm.j2 + "]^" + nm.ka + "[" + nm.kp2 + "]" + (couple ? "^" + nm.dk : "") + ";" + nm.r + "+=" + fcc(nm.cu2) + ";");
    lines.push(nm.kp2 + "++;if(" + nm.kp2 + ">=" + nm.kl + "){" + nm.kp2 + "=0;}}");
    lines.push(listVar + "[" + nm.i + "]=" + nm.r + ";");
    lines.push(nm.cc + "[" + nm.i + "]=" + nm.n2 + ";}");
    const corrupt = (rt && rt.cor) ? rt.cor + "(" + nm.o + ")"
      : nm.o + ".slice(0,1)+" + fcc("0xfffd") + "+" + nm.o + ".slice(2)";
    // 自洽校验：异或密文与明文等长，改动池里任一槽位的长度即当场损坏输出。
    // 演化只是原位重加密，长度不变，所以这条不变量全程成立，代价 O(1)。
    if (selfDefending) {
      lines.push("if(" + nm.o + ".length!==" + nm.s + ".length){" + nm.o + "=" + corrupt + ";}");
    }
    lines.push("if(" + poisonTest + "){" + nm.o + "=" + corrupt + ";}");
    lines.push("return " + nm.o + ";");
  } else {
    lines.push(cache ? "var " + nm.o + "=" + nm.m + "[" + nm.i + "];if(" + nm.o + "===undefined){" + nm.o + "=" + nm.dec + "(" + nm.s + ");"
      + (couple ? dkMutate : "") + nm.m + "[" + nm.i + "]=" + nm.o + ";}"
      : "var " + nm.o + "=" + nm.dec + "(" + nm.s + ");" + (couple ? dkMutate : ""));
    const corrupt = (rt && rt.cor) ? rt.cor + "(" + nm.o + ")"
      : nm.o + ".slice(0,1)+" + fcc("0xfffd") + "+" + nm.o + ".slice(2)";
    // 访问期全池校验和重算。静态组的池内容不再变化，装配期算出的校验和全程
    // 有效，于是可以在访问期按抽样门重算；动态 xor 组的槽位每次演化都原位重
    // 加密，校验和必然漂移，不能这么查，改走上面的等长不变量。
    // 抽样门逐组随机取 15~255，把重算成本摊到 1/N 的访问上，热路径不退化。
    // 命中即损坏本次输出而不是抛出：与毒化响应同一口径，数据坏而流程不崩。
    if (selfDefending && checksumRot !== null && checksumRot !== undefined) {
      const gate = [15, 31, 63, 127, 255][randInt(0, 4)];
      lines.push("if(((" + nm.cn + "++)&0x" + gate.toString(16) + ")===0){" +
        poolHashLoop(nm.h2, nm.z2, nm.q2, nm.u2) +
        "if(" + nm.h2 + "!==0x" + checksumRot.toString(16) + "){" + nm.o + "=" + corrupt + ";}}");
    }
    lines.push("if(" + poisonTest + "){" + nm.o + "=" + corrupt + ";}");
    lines.push("return " + nm.o + ";");
  }
  lines.push("};");
  lines.push("})(" + arrArg + "," + "0x" + rotation.toString(16) + ")");
  return lines.join("");
}

function randomGarbage() {
  const pick = randInt(0, 2);
  if (pick === 0) return randAlpha(randInt(4, 16));
  if (pick === 1) return randAlpha(randInt(2, 6)) + "_" + randAlpha(randInt(2, 6));
  return randAlpha(randInt(2, 8)) + "\\n" + randAlpha(randInt(2, 8));
}

/**
 * 生成诱饵串：形似高价值资产的随机假串，混进垃圾串池。内容全部随机生成，
 * 复现构建里也逐构建唯一，语义上指向并不存在的外部资产。LLM 对产物在做什么
 * 的归纳、人工溯源，以及按字符串价值排序的静态脱壳策略，都会被这些高信号
 * 假串带偏。
 */
const HONEY_TLDS = ['com', 'net', 'io', 'dev', 'api', 'cloud', 'svc'];
const HONEY_SCHEMES = ['https', 'wss'];
function randUpper(len) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < len; i++) s += A[randInt(0, A.length - 1)];
  return s;
}
function randB64ish(len) {
  const C = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
  let s = '';
  for (let i = 0; i < len; i++) s += C[randInt(0, C.length - 1)];
  return s;
}
function honeyString() {
  switch (randInt(0, 5)) {
    case 0: // 假 API key，OpenAI 风格
      return 'sk-' + randAlpha(4) + randB64ish(randInt(28, 40));
    case 1: // 假 endpoint URL
      return HONEY_SCHEMES[randInt(0, HONEY_SCHEMES.length - 1)] + '://' +
        randAlpha(randInt(4, 9)) + '-' + randAlpha(randInt(3, 6)) + '.' +
        HONEY_TLDS[randInt(0, HONEY_TLDS.length - 1)] + '/v' + randInt(1, 3) + '/' + randHex(12);
    case 2: // 假 JWT
      return randB64ish(randInt(6, 10)) + '.' + randB64ish(randInt(24, 40)) + '.' + randB64ish(randInt(28, 43));
    case 3: // 假 Bearer token 或会话 id
      return (randInt(0, 1) ? 'Bearer ' : 'sess_') + randHex(randInt(24, 40));
    case 4: // 假 AWS access key
      return 'AKIA' + randUpper(randInt(12, 16));
    default: // 假配置 JSON 片段
      return '{"api_key":"' + randHex(16) + '","endpoint":"' +
        randAlpha(randInt(4, 8)) + '.' + HONEY_TLDS[randInt(0, HONEY_TLDS.length - 1)] +
        '","timeout":' + randInt(3, 30) + '}';
  }
}
