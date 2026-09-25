/**
 * 域名锁定（P5 第二项）：混淆产物只允许在指定域名（及可选端口）上运行。
 *
 * 与 obfuscator.io 的 domainLock（明文域名数组 + 运行期 if 比对 + throw）的
 * 本质区别：这里的匹配结果是**密钥耦合**的——匹配贡献直接写进字符串池解密
 * 密钥的健康载体，不存在可以 NOP 的检测分支：
 *
 *   构建期  把白名单逐条散列成 32 位数值（逐构建随机盐），掩码编码后内嵌；
 *           选出授权贡献 Q（随机常量，拆成两个异或半片），横幅自检改写
 *           「健康常量 - Q」，字符串池读取端仍按健康常量求偏移；
 *   运行期  纯数值匹配 location.hostname / location.host（无任何字符串字面量，
 *           域名表不以明文出现）——授权主机给载体 +Q，偏移归零、字符串正常；
 *           非授权主机给载体加「宿主散列经 R 轮折叠」的 J，偏移非零，整池
 *           字符串静默变乱码（fail-closed，无报错、无可定位的判断点）。
 *
 * 篡改面：
 *   删除/NOP 引导调用        → 载体缺 +Q，授权域自己变乱码（Q≠0 设计）；
 *   改校验函数体             → 函数声明是根级 FunctionDeclaration，自动进入
 *                              integrityCheck 的哈希面，失配增量照常累加；
 *   硬编码 J 使其等于 Q      → J 是宿主名的折叠链，找齐需要 2^32 × R 轮
 *                              乘法离线搜索（R 逐构建随机 24~48）；
 *   换域名重签 Q             → 等价于重新混淆（逐构建随机盐/掩码/贡献值）。
 *
 * 匹配语义（与选项提示一致）：
 *   example.com        精确匹配该主机名；
 *   .example.com       该主机及其任意层子域（后缀按「点边界」切分匹配，
 *                      badexample.com 不会误中 example.com）；
 *   example.com:8443   额外锁定端口（对 location.host 比对；后缀条目不支持端口）。
 *
 * 降级链（无字符串池或无耦合链路时按强度递减）：
 *   coupled  couple 在且 stringArray 开 —— 上面的密钥耦合，默认形态；
 *   poison   stringArray 开但 couple 不在（如关了完整性校验）—— 失配写毒药
 *            键，池解码器损坏输出（有可清除的标志，弱一档）；
 *   throw    连池都没有 —— 失配装载期抛错（可被定位，最弱，仅兜底）。
 *
 * Node / 无 location 环境：hostname 视为空串，永远不匹配 —— 域名锁定构建
 * 本来就不承诺可在浏览器外运行，测试须在注入 location 的沙箱里做。
 */
import parser from '../ast/parser.js';
const { parse } = parser;
import rand from '../utils/rand.js';
const { randInt, uniqueName } = rand;
import i18n from '../i18n.js';
const { t: msg } = i18n;
import rtlib from './rtlib.js';

/** globalThis 兜底表达式，与 integrityCheck/banner 同构。 */
const GREF = '(typeof globalThis!=="undefined"?globalThis:typeof self!=="undefined"?self:' +
  'typeof window!=="undefined"?window:typeof global!=="undefined"?global:{})';

/** 运行期与构建期共用的加盐折叠散列：h = ((imul(h ^ cc, P)) >>> 0) ^ M。 */
function rtHash(str, salt, prime, mix) {
  let h = salt >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = ((Math.imul(h ^ str.charCodeAt(i), prime) >>> 0) ^ mix) >>> 0;
  }
  return h >>> 0;
}

/** J 折叠链在运行期模板里逐字内联（imul 双射 + 异或混合），无需构建期实现。 */

/**
 * 条目解析与校验。返回 { host, suffix, port }；非法输入抛 badDomainLock。
 * 宽容处理：trim、小写、剥尾随点； scheme:// 前缀剥掉但路径视为非法。
 */
function parseEntry(raw) {
  let e = String(raw == null ? '' : raw).trim().toLowerCase();
  const bad = () => new Error(msg('badDomainLock', { p: String(raw).slice(0, 40) }));
  const scheme = e.match(/^[a-z][a-z0-9+.-]*:\/\//);
  if (scheme) e = e.slice(scheme[0].length);
  e = e.replace(/\.+$/, '');
  if (!e || e.includes('/') || e.includes('?') || e.includes('#')) throw bad();
  let suffix = false;
  if (e.startsWith('.')) { suffix = true; e = e.slice(1); }
  let port = null;
  const ci = e.lastIndexOf(':');
  if (ci >= 0) {
    const p = e.slice(ci + 1);
    if (!/^\d{1,5}$/.test(p) || Number(p) < 1 || Number(p) > 65535) throw bad();
    if (suffix) throw bad(); // 后缀 + 端口语义含糊，V1 直接拒绝
    port = p;
    e = e.slice(0, ci);
  }
  if (!e || e.includes('..')) throw bad();
  const labels = e.split('.');
  if (!labels.every((l) => /^[a-z0-9_-]{1,63}$/.test(l))) throw bad();
  return { host: e, suffix, port };
}

export default function domainLock(ast, options, ctx) {
  const raw = options.domainLock;
  const entries = (Array.isArray(raw) ? raw : [raw])
    .map((s) => String(s == null ? '' : s).trim()).filter(Boolean);
  if (!entries.length) return { injected: false, entries: 0 };

  const parsed = entries.map(parseEntry);
  const program = ast.type === 'File' ? ast.program : ast;
  const couple = ctx.couple || null;
  // coupled 需要「有人写（横幅+本 pass）也有人读（字符串池）」：池关着时
  // 往载体写贡献毫无效果，必须走降级
  const poisonKeys = Array.isArray(program.__poisonKeys) && program.__poisonKeys.length
    ? program.__poisonKeys : null;
  const mode = (couple && options.stringArray !== false) ? 'coupled'
    : (poisonKeys ? 'poison' : 'throw');

  // ---- 构建期常量（逐构建随机）----
  const saltH = randInt(0x1000000, 0x7fffffff);   // hostname 折叠盐
  const saltP = randInt(0x1000000, 0x7fffffff);   // host:port 折叠盐
  const prime = randInt(0x1000193, 0x7ffffff5) | 1; // 折叠乘数（奇数，imul 双射）
  const mixA = randInt(0x10000, 0x7ffffff0);      // 折叠混合项
  const encR = randInt(0x100000, 0x7ffffff0);     // 数值表掩码
  const rounds = randInt(24, 48);                 // J 折叠轮数
  const foldA = randInt(0x10000, 0x7ffffff0);
  const foldB = randInt(0x10000, 0x7ffffff0);
  // 授权贡献 Q：拆成两个 <2^31 的异或半片，QA^QB 非零才收
  let qa = 0, qb = 0, qv = 0;
  do {
    qa = randInt(0x100000, 0x7ffffff0);
    qb = randInt(0x100000, 0x7ffffff0);
    qv = (qa ^ qb) >>> 0;
  } while (qv === 0);

  // 白名单 → 数值表（掩码编码后内嵌）
  const enc = (h) => '0x' + ((h ^ encR) >>> 0).toString(16);
  const ea = [];  // 精确主机名
  const sa = [];  // 后缀条目的宿主散列
  const pa = [];  // 主机:端口 精确
  for (const en of parsed) {
    if (en.port != null) pa.push(rtHash(en.host + ':' + en.port, saltP, prime, mixA));
    else if (en.suffix) sa.push(rtHash(en.host, saltH, prime, mixA));
    else ea.push(rtHash(en.host, saltH, prime, mixA));
  }

  // ---- 运行期校验函数（纯数值 + 无字符串字面量的 location 访问）----
  const fn = uniqueName(ctx.usedNames, '_0x');
  const L = [];
  const P = (s) => L.push(s);
  P('function ' + fn + '(){');
  P('var d="",k="";');
  // 不用 typeof location 判存在（会引入字符串字面量并被池化，早带执行时
  // 授权贡献还没写入）；裸引用放 try 里，Node 的 ReferenceError 走空串分支
  P('try{d=location.hostname||"";k=location.host||"";}catch(e){}');
  P('d=(d||"")+"";k=(k||"")+"";');
  P('while(d.length>0&&d.charCodeAt(d.length-1)===46){d=d.slice(0,d.length-1);}');
  P('var hh=0x' + saltH.toString(16) + ',hp=0x' + saltP.toString(16) + ',i=0,j=0,c=0,m=0,n=d.length;');
  P('for(i=0;i<n;i++){c=d.charCodeAt(i);hh=((Math.imul(hh^c,0x' + prime.toString(16) + ')>>>0)^0x' + mixA.toString(16) + ');}');
  P('for(i=0;i<k.length;i++){c=k.charCodeAt(i);hp=((Math.imul(hp^c,0x' + prime.toString(16) + ')>>>0)^0x' + mixA.toString(16) + ');}');
  P('var EA=[' + ea.map(enc).join(',') + '],SA=[' + sa.map(enc).join(',') + '],PA=[' + pa.map(enc).join(',') + '],KM=0x' + encR.toString(16) + ';');
  // 精确：整串散列对 EA；后缀条目的「裸域本身」也走整串比对（.example.com
  // 同时匹配 example.com 与任意子域）
  P('for(i=0;i<EA.length;i++){if(hh===(EA[i]^KM)){m=1;break;}}');
  P('if(!m){for(i=0;i<SA.length;i++){if(hh===(SA[i]^KM)){m=1;break;}}}');
  P('for(i=0;i<PA.length;i++){if(hp===(PA[i]^KM)){m=1;break;}}');
  // 后缀匹配：每个点后的切片逐个现算散列比对（O(n²) 字符，n 是主机名长度，
  // 可忽略）。点边界保证 badexample.com 不中 .example.com；整串（i=0）的散列
  // 就是 hh，已在精确比对里覆盖
  P('for(i=1;!m&&i<n;i++){');
  P('if(d.charCodeAt(i-1)===46){');
  P('var hs=0x' + saltH.toString(16) + ';');
  P('for(j=i;j<n;j++){hs=((Math.imul(hs^d.charCodeAt(j),0x' + prime.toString(16) + ')>>>0)^0x' + mixA.toString(16) + ');}');
  P('for(j=0;j<SA.length;j++){if(hs===(SA[j]^KM)){m=1;break;}}');
  P('}');
  P('}');

  // 载体引用只在 coupled 模式下需要（poison/throw 模式 couple 可能为空）
  const cref = couple ? GREF + '["' + couple.name + '"]' : null;
  if (mode === 'coupled') {
    // 授权：+Q（横幅已写 OK-Q，这里补齐后读取端偏移归零）
    P('if(m){' + cref + '=((' + cref + '|0)+(0x' + qa.toString(16) + '^0x' + qb.toString(16) + '))|0;}');
    P('else{');
    P('var q=hh;');
    P('for(i=0;i<' + rounds + ';i++){q=((Math.imul(q^0x' + foldA.toString(16) + ',0x9e3779b1)>>>0)^0x' + foldB.toString(16) + ');}');
    P(cref + '=((' + cref + '|0)+q)|0;');
    P('}');
  } else if (mode === 'poison') {
    // 降级：失配写毒药键，字符串池解码器损坏输出
    const writes = poisonKeys
      .map((k) => GREF + '["' + k + '"]=0x' + (randInt(1, 0xffff) | 1).toString(16) + ';')
      .join('');
    P('if(!m){' + writes + '}');
  } else {
    // 最弱兜底：装载期显式失败
    P('if(!m){throw new Error("JsLabyrinth: this build is locked to another domain");}');
  }
  P('}');
  // throw 模式的失配抛错不能被自己的 try/catch 吞掉——那种形态下没有第二个
  // 失效层（无池可乱码），引导调用必须裸奔让错误浮出来；coupled/poison 的
  // 意外异常方向本来就是 fail-closed（贡献缺失 → 乱码），保留兜底 catch
  P(mode === 'throw' ? fn + '();' : 'try{' + fn + '();}catch(e){}');

  let stmts = [];
  try {
    stmts = parse(L.join(''), { sourceType: 'script' }).program.body;
  } catch (e) {
    // 静默降级在这里是错误方向：横幅已按「OK - Q」写死，没人补 +Q 会让
    // 授权域自己也乱码。模板拼接出错必须让构建立即失败
    stmts = [];
  }
  if (!stmts.length) throw new Error('domainLock: internal template parse failure');
  // 早带：内核之后、晚带全部头部与字符串池 IIFE 之前。授权贡献必须在任何
  // 池访问之前落位；早带里池访问器尚未定义，不存在窗口期访问
  rtlib.insertHeadEarly(ctx, program, stmts);
  if (mode === 'coupled') couple.q = qv;

  return {
    injected: true,
    entries: parsed.length,
    mode,
    exact: ea.length,
    suffix: sa.length,
    port: pa.length,
    rounds,
    saltH,
    hostFn: fn,
  };
};
