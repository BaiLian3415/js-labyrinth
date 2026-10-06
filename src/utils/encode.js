/**
 * 字符串编码。XOR 取原始码元形态，另配纯 JS 的 base64 与 RC4。
 * 这些函数既在构建期编码，也被生成进输出代码充当运行时解码器，
 * 所以必须能在浏览器里无依赖运行。
 */

// XOR 是默认编码，密钥逐码元参与，强度高于 hex 传输层。密文按原始码元
// 字符串存储，每码元等于明文码元 XOR 密钥码元，外面不再套 4 字符 hex。
// hex 只是传输编码，去掉它不影响密钥参与强度，构建期字面量却从每码元 4
// 字符降到约 1 字符，ASCII 主体大致如此，运行时解码与重加密每码元也从 4
// 次 HEXN 降到 1 次 CCO。构建期加密与运行时解码器必须同构。
function xorEncode(str, key) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    out += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return out;
}

function xorDecode(data, key) {
  let out = '';
  for (let i = 0; i < data.length; i++) {
    out += String.fromCharCode(data.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return out;
}

// 纯 JS base64，无依赖，浏览器与 Node 通用。
// 输入为 UTF-8 字节串，避免 16 位 charCode 溢出。
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64Encode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes.charCodeAt(i);
    const b2 = i + 1 < bytes.length ? bytes.charCodeAt(i + 1) : NaN;
    const b3 = i + 2 < bytes.length ? bytes.charCodeAt(i + 2) : NaN;
    const e1 = b1 >> 2;
    const e2 = ((b1 & 3) << 4) | (isNaN(b2) ? 0 : b2 >> 4);
    const e3 = isNaN(b2) ? 64 : ((b2 & 15) << 2) | (isNaN(b3) ? 0 : b3 >> 6);
    const e4 = isNaN(b3) ? 64 : b3 & 63;
    out += B64[e1] + B64[e2] + (e3 === 64 ? '=' : B64[e3]) + (e4 === 64 ? '=' : B64[e4]);
  }
  return out;
}

function b64Decode(s) {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = B64.indexOf(s[i]);
    if (c < 0) continue;
    buffer = (buffer << 6) | c;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return out;
}

// UTF-8 编解码。RC4 基于字节操作，需要这两个函数。
function utf8Encode(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) {
      out += String.fromCharCode(c);
    } else if (c < 0x800) {
      out += String.fromCharCode(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
    } else if (c < 0xD800 || c >= 0xE000) {
      out += String.fromCharCode(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    } else {
      // 代理对，emoji 等增补平面字符编成四字节
      i++;
      const c2 = str.charCodeAt(i);
      const cp = 0x10000 + (((c - 0xD800) << 10) | (c2 - 0xDC00));
      out += String.fromCharCode(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
    }
  }
  return out;
}

function utf8Decode(bytes) {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes.charCodeAt(i);
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i++;
    } else if (b < 0xE0) {
      out += String.fromCharCode(((b & 0x1F) << 6) | (bytes.charCodeAt(i + 1) & 0x3F));
      i += 2;
    } else if (b < 0xF0) {
      out += String.fromCharCode(((b & 0x0F) << 12) | ((bytes.charCodeAt(i + 1) & 0x3F) << 6) | (bytes.charCodeAt(i + 2) & 0x3F));
      i += 3;
    } else {
      const cp = ((b & 0x07) << 18) | ((bytes.charCodeAt(i + 1) & 0x3F) << 12) | ((bytes.charCodeAt(i + 2) & 0x3F) << 6) | (bytes.charCodeAt(i + 3) & 0x3F);
      const cp16 = cp - 0x10000;
      out += String.fromCharCode(0xD800 | (cp16 >> 10), 0xDC00 | (cp16 & 0x3FF));
      i += 4;
    }
  }
  return out;
}

// RC4 流密码，在 UTF-8 字节上运算，支持 Unicode。
// 构建期加密与 decoderSource() 生成的运行时解码器必须使用同一套 KSA 与
// PRGA。任何一侧改动都会破坏互补性，密钥编排的变体同样要两侧同步实现，
// 一边单独改了，解密结果就是错的。
function rc4Crypt(input, key) {
  const s = [];
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key.charCodeAt(i % key.length)) % 256;
    const tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;
  }
  let out = '';
  let i = 0;
  j = 0;
  for (let k = 0; k < input.length; k++) {
    i = (i + 1) % 256;
    j = (j + s[i]) % 256;
    const tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;
    out += String.fromCharCode(input.charCodeAt(k) ^ s[(s[i] + s[j]) % 256]);
  }
  return out;
}

// RC4 输出是二进制字符串，包成 base64 再放进字符串字面量。相比旧的 hex
// 传输层，每字节从 2 字符降到 1.33 字符，解码用纯算术码值映射。
function rc4ToB64(input, key) {
  return b64Encode(rc4Crypt(input, key));
}

// 仿射参数派生：只依赖 key 文本，构建期与运行时用同一套折叠算出同一组 (a, b)。
// a 取奇数（mod 2^16 可逆的充要条件），b 任意 16 位。运行时解码器里复刻这两段
// 折叠，再用牛顿迭代现场求 a 的逆（5 轮即收敛到 32 位，取低 16 位就是 mod 2^16
// 的逆），不额外内嵌任何参数字面量。
function affineParams(key) {
  let a = 1;
  for (let i = 0; i < key.length; i++) a = (Math.imul(a, 31) + key.charCodeAt(i)) | 0;
  a |= 1;
  let b = 0;
  for (let i = key.length - 1; i >= 0; i--) b = (Math.imul(b, 131) + key.charCodeAt(i)) | 0;
  return { a: a & 0xffff, b: b & 0xffff };
}

// 仿射码元加密：y = (a*x + b) mod 65536。a*x < 2^32，float64 精确，无需 imul。
// 定义域覆盖全部 16 位码元（含孤立代理项），与 xor 同域，不同算子。
function affineEncode(str, key) {
  const { a, b } = affineParams(key);
  let out = '';
  for (let i = 0; i < str.length; i++) {
    out += String.fromCharCode((a * str.charCodeAt(i) + b) & 0xffff);
  }
  return out;
}

// 加法码元加密：y = (x + k) mod 65536，k 逐码元取自密钥。与 xor 同为逐码元
// 流加密，但算子是加/减——按 `^` 硬编码提取密钥流的还原器直接失效。
function addEncode(str, key) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    out += String.fromCharCode((str.charCodeAt(i) + key.charCodeAt(i % key.length)) & 0xffff);
  }
  return out;
}

// 倒序异或：先 xor 再整体倒序。密文布局与 xor 完全不同（首码元不再对应首明文），
 // 按"首部对齐"剥密钥流的写法错位；运行时解码循环是倒序累加，形态也不同。
function xorRevEncode(str, key) {
  const x = xorEncode(str, key);
  let out = '';
  for (let i = x.length - 1; i >= 0; i--) out += x[i];
  return out;
}

// 字节异或 + base64：UTF-8 字节先与密钥异或，再走标准 base64。解码管线是
// base64 与 rc4 的交叉形状（unb64 → xor → utf8），但没有 RC4 的 KSA/PRGA 状态机。
function b64xorEncode(str, key) {
  const raw = utf8Encode(str);
  let xored = '';
  for (let i = 0; i < raw.length; i++) {
    xored += String.fromCharCode(raw.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return b64Encode(xored);
}

/**
 * 生成运行时重建密钥的表达式源码，产物中不再明文内嵌 key。
 * key 的每个 charCode 与随机掩码异或，写成 (0x..^0x..)，运行时以该值
 * 作下标去查字符表 rt.tbl，求值即还原出 key 字符串，产物中不出现
 * String.fromCharCode 调用点。tbl 缺失时回退 fromCharCode 形态。
 * @param {string} key 密钥文本
 * @param {function(number, number): number} randInt 随机整数生成器
 * @param {string} [tbl] 运行时字符表绑定名
 * @returns {string} 表达式源码
 */
function buildKeyExpr(key, randInt, tbl) {
  const parts = [];
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    const m1 = 0x101 + randInt(0, 0xfefe); // 保证两个操作数都 > 0xff
    const m2 = m1 ^ c;
    parts.push('(0x' + m1.toString(16) + '^0x' + m2.toString(16) + ')');
  }
  if (tbl) {
    return '(' + parts.map((p) => tbl + '[' + p + ']').join('+') + ')';
  }
  // 每 4 个字符一组 String.fromCharCode，减少调用次数
  const chunks = [];
  for (let i = 0; i < parts.length; i += 4) {
    chunks.push('String.fromCharCode(' + parts.slice(i, i + 4).join(',') + ')');
  }
  return '(' + chunks.join('+') + ')';
}

/**
 * 生成运行时解码器的源码，结果会被包进字符串数组 IIFE。
 * 生成的函数只有一个参数 _0xs，是编码后的字符串，key 已内嵌其中。
 * encoding 取 'none' | 'xor' | 'base64' | 'rc4' | 'affine' | 'add' | 'xorrev' | 'b64xor'。
 * 传入 rt 后所有原语改走自研内核 FCC、CCO、HEXN、TOH，产物中不再出现
 * parseInt、String.fromCharCode、indexOf、substr 调用点。
 * @param {string} encoding 编码方式
 * @param {string} [key] 密钥文本
 * @param {function(number, number): number} randInt 随机整数生成器
 * @param {object} [rt] 运行时内核
 * @returns {string} 解码函数源码
 */
function decoderSource(encoding, key, randInt, rt) {
  if (!rt || !rt.fcc || !rt.cco) {
    return legacyDecoderSource(encoding, key, randInt);
  }
  const { fcc, cco } = rt;
  const keyExpr = key !== undefined ? buildKeyExpr(key, randInt, rt.tblCall) : '';
  if (encoding === 'none') {
    return 'function(_0xs){return _0xs;}';
  }
  if (encoding === 'xor') {
    // 输入是原始码元密文，每码元等于明文码元 ^ 密钥码元，逐码元 CCO 后 XOR
    return [
      'function(_0xs){',
      'var _0xo=\'\';',
      'var _0k=' + keyExpr + ';',
      'for(var _0xk=0;_0xk<_0xs.length;_0xk++){',
      'var _0c=' + cco + '(_0xs,_0xk)^' + cco + '(_0k,_0xk%_0k.length);',
      '_0xo+=' + fcc + '(_0c);',
      '}',
      'return _0xo;',
      '}'
    ].join('');
  }
  if (encoding === 'base64') {
    // base64 还原字节，再按 UTF-8 还原文本。码值经纯算术映射，产物里没有 alphabet 明文，也没有 indexOf。
    return [
      'function(_0xs){',
      'var _0xo=\'\';var _0b=0;var _0t=0;',
      'for(var _0k=0;_0k<_0xs.length;_0k++){',
      'var _0q=' + cco + '(_0xs,_0k);',
      'if(_0q===61)break;',
      'var _0c=_0q>96?_0q-71:(_0q>64?_0q-65:(_0q>47?_0q+4:(_0q===43?62:(_0q===47?63:-1))));',
      'if(_0c<0)continue;',
      '_0b=(_0b<<6)|_0c;_0t+=6;',
      'if(_0t>=8){_0t-=8;_0xo+=' + fcc + '((_0b>>_0t)&0xff);}',
      '}',
      'var _0r=\'\';var _0p=0;',
      'while(_0p<_0xo.length){',
      'var _0d=' + cco + '(_0xo,_0p);',
      'if(_0d<0x80){_0r+=' + fcc + '(_0d);_0p++;}',
      'else if(_0d<0xE0){',
      '_0r+=' + fcc + '(((_0d&0x1F)<<6)|(' + cco + '(_0xo,_0p+1)&0x3F));_0p+=2;',
      '}else if(_0d<0xF0){',
      '_0r+=' + fcc + '(((_0d&0x0F)<<12)|((' + cco + '(_0xo,_0p+1)&0x3F)<<6)|(' + cco + '(_0xo,_0p+2)&0x3F));_0p+=3;',
      '}else{',
      'var _0e=((_0d&0x07)<<18)|((' + cco + '(_0xo,_0p+1)&0x3F)<<12)|((' + cco + '(_0xo,_0p+2)&0x3F)<<6)|(' + cco + '(_0xo,_0p+3)&0x3F);',
      'var _0f=_0e-0x10000;',
      '_0r+=' + fcc + '(0xD800|(_0f>>10))+' + fcc + '(0xDC00|(_0f&0x3FF));_0p+=4;',
      '}',
      '}',
      'return _0r;',
      '}'
    ].join('');
  }
  if (encoding === 'rc4') {
    // 输入是 base64 形式的密文字节。先用纯算术码值映射解码，再走 RC4，最后按 UTF-8 还原，全部使用自研原语。
    return [
      'function(_0xs){',
      'var _0k=' + keyExpr + ';',
      'var _0d=\'\';var _0bb=0;var _0bt=0;',
      'for(var _0h=0;_0h<_0xs.length;_0h++){',
      'var _0q=' + cco + '(_0xs,_0h);',
      'if(_0q===61)break;',
      'var _0v=_0q>96?_0q-71:(_0q>64?_0q-65:(_0q>47?_0q+4:(_0q===43?62:(_0q===47?63:-1))));',
      'if(_0v<0)continue;',
      '_0bb=(_0bb<<6)|_0v;_0bt+=6;',
      'if(_0bt>=8){_0bt-=8;_0d+=' + fcc + '((_0bb>>_0bt)&0xff);}',
      '}',
      'var _0s=[];',
      'for(var _0i=0;_0i<256;_0i++)_0s[_0i]=_0i;',
      'var _0j=0;',
      'for(var _0i=0;_0i<256;_0i++){',
      '_0j=(_0j+_0s[_0i]+' + cco + '(_0k,_0i%_0k.length))%256;',
      'var _0t=_0s[_0i];_0s[_0i]=_0s[_0j];_0s[_0j]=_0t;',
      '}',
      'var _0o=\'\';var _0a=0;_0j=0;',
      'for(var _0m=0;_0m<_0d.length;_0m++){',
      '_0a=(_0a+1)%256;',
      '_0j=(_0j+_0s[_0a])%256;',
      'var _0t=_0s[_0a];_0s[_0a]=_0s[_0j];_0s[_0j]=_0t;',
      '_0o+=' + fcc + '(' + cco + '(_0d,_0m)^_0s[(_0s[_0a]+_0s[_0j])%256]);',
      '}',
      'var _0r=\'\';var _0p=0;',
      'while(_0p<_0o.length){',
      'var _0b=' + cco + '(_0o,_0p);',
      'if(_0b<0x80){_0r+=' + fcc + '(_0b);_0p++;}',
      'else if(_0b<0xE0){',
      '_0r+=' + fcc + '(((_0b&0x1F)<<6)|(' + cco + '(_0o,_0p+1)&0x3F));_0p+=2;',
      '}else if(_0b<0xF0){',
      '_0r+=' + fcc + '(((_0b&0x0F)<<12)|((' + cco + '(_0o,_0p+1)&0x3F)<<6)|(' + cco + '(_0o,_0p+2)&0x3F));_0p+=3;',
      '}else{',
      'var _0c=((_0b&0x07)<<18)|((' + cco + '(_0o,_0p+1)&0x3F)<<12)|((' + cco + '(_0o,_0p+2)&0x3F)<<6)|(' + cco + '(_0o,_0p+3)&0x3F);',
      'var _0q2=_0c-0x10000;',
      '_0r+=' + fcc + '(0xD800|(_0q2>>10))+' + fcc + '(0xDC00|(_0q2&0x3FF));_0p+=4;',
      '}',
      '}',
      'return _0r;',
      '}'
    ].join('');
  }
  if (encoding === 'affine') {
    // 仿射码元解密：先从 key 现场复刻 (a, b)，牛顿迭代求 a 的逆，再逐码元解。
    // 牛顿步用 Math.imul 保证 32 位语义；最终掩 0xffff 落回码元域。
    return [
      'function(_0xs){',
      'var _0k=' + keyExpr + ';',
      'var _0a=1;for(var _0i=0;_0i<_0k.length;_0i++){_0a=(Math.imul(_0a,31)+' + cco + '(_0k,_0i))|0;}_0a|=1;',
      'var _0b=0;for(var _0j=_0k.length-1;_0j>=0;_0j--){_0b=(Math.imul(_0b,131)+' + cco + '(_0k,_0j))|0;}_0b&=0xffff;',
      'var _0ai=1;for(var _0n=0;_0n<5;_0n++){_0ai=Math.imul(_0ai,2-Math.imul(_0a&0xffff,_0ai));}_0ai&=0xffff;',
      'var _0xo=\'\';',
      'for(var _0xk=0;_0xk<_0xs.length;_0xk++){',
      'var _0c=' + cco + '(_0xs,_0xk);',
      '_0xo+=' + fcc + '((_0ai*((_0c-_0b)&0xffff))&0xffff);',
      '}',
      'return _0xo;',
      '}'
    ].join('');
  }
  if (encoding === 'add') {
    // 加法码元解密：逐码元减密钥。算子是 +/- 而非 ^，按异或提取密钥流失效。
    return [
      'function(_0xs){',
      'var _0k=' + keyExpr + ';',
      'var _0xo=\'\';',
      'for(var _0xk=0;_0xk<_0xs.length;_0xk++){',
      'var _0c=(' + cco + '(_0xs,_0xk)-' + cco + '(_0k,_0xk%_0k.length))&0xffff;',
      '_0xo+=' + fcc + '(_0c);',
      '}',
      'return _0xo;',
      '}'
    ].join('');
  }
  if (encoding === 'xorrev') {
    // 倒序异或解密：从尾向头累加，密钥下标按原位置 (len-1-i) 取。
    return [
      'function(_0xs){',
      'var _0k=' + keyExpr + ';',
      'var _0xo=\'\';',
      'for(var _0xk=_0xs.length-1;_0xk>=0;_0xk--){',
      'var _0c=' + cco + '(_0xs,_0xk)^' + cco + '(_0k,(_0xs.length-1-_0xk)%_0k.length);',
      '_0xo+=' + fcc + '(_0c);',
      '}',
      'return _0xo;',
      '}'
    ].join('');
  }
  if (encoding === 'b64xor') {
    // 先算术 unb64，再逐字节异或密钥，最后 UTF-8 还原。管线是 base64 与 rc4 的
    // 交叉形状，但没有 KSA/PRGA 状态机；密钥游标按输出字节计数。
    return [
      'function(_0xs){',
      'var _0k=' + keyExpr + ';',
      'var _0xo=\'\';var _0b=0;var _0t=0;var _0kp=0;',
      'for(var _0k2=0;_0k2<_0xs.length;_0k2++){',
      'var _0q=' + cco + '(_0xs,_0k2);',
      'if(_0q===61)break;',
      'var _0c=_0q>96?_0q-71:(_0q>64?_0q-65:(_0q>47?_0q+4:(_0q===43?62:(_0q===47?63:-1))));',
      'if(_0c<0)continue;',
      '_0b=(_0b<<6)|_0c;_0t+=6;',
      'if(_0t>=8){_0t-=8;var _0by=((_0b>>_0t)&0xff)^' + cco + '(_0k,_0kp%_0k.length);_0kp++;_0xo+=' + fcc + '(_0by);}',
      '}',
      'var _0r=\'\';var _0p=0;',
      'while(_0p<_0xo.length){',
      'var _0d=' + cco + '(_0xo,_0p);',
      'if(_0d<0x80){_0r+=' + fcc + '(_0d);_0p++;}',
      'else if(_0d<0xE0){',
      '_0r+=' + fcc + '(((_0d&0x1F)<<6)|(' + cco + '(_0xo,_0p+1)&0x3F));_0p+=2;',
      '}else if(_0d<0xF0){',
      '_0r+=' + fcc + '(((_0d&0x0F)<<12)|((' + cco + '(_0xo,_0p+1)&0x3F)<<6)|(' + cco + '(_0xo,_0p+2)&0x3F));_0p+=3;',
      '}else{',
      'var _0e=((_0d&0x07)<<18)|((' + cco + '(_0xo,_0p+1)&0x3F)<<12)|((' + cco + '(_0xo,_0p+2)&0x3F)<<6)|(' + cco + '(_0xo,_0p+3)&0x3F);',
      'var _0f=_0e-0x10000;',
      '_0r+=' + fcc + '(0xD800|(_0f>>10))+' + fcc + '(0xDC00|(_0f&0x3FF));_0p+=4;',
      '}',
      '}',
      'return _0r;',
      '}'
    ].join('');
  }
  throw new Error('unknown encoding: ' + encoding);
}

/** 无内核时的降级解码器，直接用原生函数。 */
function legacyDecoderSource(encoding, key, randInt) {
  const keyExpr = key !== undefined ? buildKeyExpr(key, randInt) : '';
  if (encoding === 'none') {
    return 'function(_0xs){return _0xs;}';
  }
  if (encoding === 'xor') {
    return [
      'function(_0xs){',
      'var _0xo=\'\';',
      'var _0k=' + keyExpr + ';',
      'for(var _0xk=0;_0xk<_0xs.length;_0xk++){',
      'var _0c=_0xs.charCodeAt(_0xk)^_0k.charCodeAt(_0xk%_0k.length);',
      '_0xo+=String.fromCharCode(_0c);',
      '}',
      'return _0xo;',
      '}'
    ].join('');
  }
  if (encoding === 'base64') {
    return [
      'function(_0xs){',
      'var _0xo=\'\';var _0b=0;var _0t=0;',
      'var _0a=\'' + B64 + '\';',
      'for(var _0k=0;_0k<_0xs.length;_0k++){',
      'var _0c=_0a.indexOf(_0xs[_0k]);',
      'if(_0c<0)continue;',
      '_0b=(_0b<<6)|_0c;_0t+=6;',
      'if(_0t>=8){_0t-=8;_0xo+=String.fromCharCode((_0b>>_0t)&0xff);}',
      '}',
      'var _0r=\'\';var _0p=0;',
      'while(_0p<_0xo.length){',
      'var _0d=_0xo.charCodeAt(_0p);',
      'if(_0d<0x80){_0r+=String.fromCharCode(_0d);_0p++;}',
      'else if(_0d<0xE0){',
      '_0r+=String.fromCharCode(((_0d&0x1F)<<6)|(_0xo.charCodeAt(_0p+1)&0x3F));_0p+=2;',
      '}else if(_0d<0xF0){',
      '_0r+=String.fromCharCode(((_0d&0x0F)<<12)|((_0xo.charCodeAt(_0p+1)&0x3F)<<6)|(_0xo.charCodeAt(_0p+2)&0x3F));_0p+=3;',
      '}else{',
      'var _0e=((_0d&0x07)<<18)|((_0xo.charCodeAt(_0p+1)&0x3F)<<12)|((_0xo.charCodeAt(_0p+2)&0x3F)<<6)|(_0xo.charCodeAt(_0p+3)&0x3F);',
      'var _0f=_0e-0x10000;',
      '_0r+=String.fromCharCode(0xD800|(_0f>>10),0xDC00|(_0f&0x3FF));_0p+=4;',
      '}',
      '}',
      'return _0r;',
      '}'
    ].join('');
  }
  if (encoding === 'rc4') {
    return [
      'function(_0xs){',
      'var _0k=' + keyExpr + ';',
      'var _0d=\'\';var _0bb=0;var _0bt=0;',
      'var _0a=\'' + B64 + '\';',
      'for(var _0h=0;_0h<_0xs.length;_0h++){',
      'var _0c=_0a.indexOf(_0xs[_0h]);',
      'if(_0c<0)continue;',
      '_0bb=(_0bb<<6)|_0c;_0bt+=6;',
      'if(_0bt>=8){_0bt-=8;_0d+=String.fromCharCode((_0bb>>_0bt)&0xff);}',
      '}',
      'var _0s=[];',
      'for(var _0i=0;_0i<256;_0i++)_0s[_0i]=_0i;',
      'var _0j=0;',
      'for(var _0i=0;_0i<256;_0i++){',
      '_0j=(_0j+_0s[_0i]+_0k.charCodeAt(_0i%_0k.length))%256;',
      'var _0t=_0s[_0i];_0s[_0i]=_0s[_0j];_0s[_0j]=_0t;',
      '}',
      'var _0o=\'\';var _0a2=0;_0j=0;',
      'for(var _0m=0;_0m<_0d.length;_0m++){',
      '_0a2=(_0a2+1)%256;',
      '_0j=(_0j+_0s[_0a2])%256;',
      'var _0t=_0s[_0a2];_0s[_0a2]=_0s[_0j];_0s[_0j]=_0t;',
      '_0o+=String.fromCharCode(_0d.charCodeAt(_0m)^_0s[(_0s[_0a2]+_0s[_0j])%256]);',
      '}',
      'var _0r=\'\';var _0p=0;',
      'while(_0p<_0o.length){',
      'var _0b=_0o.charCodeAt(_0p);',
      'if(_0b<0x80){_0r+=String.fromCharCode(_0b);_0p++;}',
      'else if(_0b<0xE0){',
      '_0r+=String.fromCharCode(((_0b&0x1F)<<6)|(_0o.charCodeAt(_0p+1)&0x3F));_0p+=2;',
      '}else if(_0b<0xF0){',
      '_0r+=String.fromCharCode(((_0b&0x0F)<<12)|((_0o.charCodeAt(_0p+1)&0x3F)<<6)|(_0o.charCodeAt(_0p+2)&0x3F));_0p+=3;',
      '}else{',
      'var _0c=((_0b&0x07)<<18)|((_0o.charCodeAt(_0p+1)&0x3F)<<12)|((_0o.charCodeAt(_0p+2)&0x3F)<<6)|(_0o.charCodeAt(_0p+3)&0x3F);',
      'var _0q=_0c-0x10000;',
      '_0r+=String.fromCharCode(0xD800|(_0q>>10),0xDC00|(_0q&0x3FF));_0p+=4;',
      '}',
      '}',
      'return _0r;',
      '}'
    ].join('');
  }
  if (encoding === 'affine') {
    return [
      'function(_0xs){',
      'var _0k=' + keyExpr + ';',
      'var _0a=1;for(var _0i=0;_0i<_0k.length;_0i++){_0a=(Math.imul(_0a,31)+_0k.charCodeAt(_0i))|0;}_0a|=1;',
      'var _0b=0;for(var _0j=_0k.length-1;_0j>=0;_0j--){_0b=(Math.imul(_0b,131)+_0k.charCodeAt(_0j))|0;}_0b&=0xffff;',
      'var _0ai=1;for(var _0n=0;_0n<5;_0n++){_0ai=Math.imul(_0ai,2-Math.imul(_0a&0xffff,_0ai));}_0ai&=0xffff;',
      'var _0xo=\'\';',
      'for(var _0xk=0;_0xk<_0xs.length;_0xk++){',
      '_0xo+=String.fromCharCode((_0ai*((_0xs.charCodeAt(_0xk)-_0b)&0xffff))&0xffff);',
      '}',
      'return _0xo;',
      '}'
    ].join('');
  }
  if (encoding === 'add') {
    return [
      'function(_0xs){',
      'var _0k=' + keyExpr + ';',
      'var _0xo=\'\';',
      'for(var _0xk=0;_0xk<_0xs.length;_0xk++){',
      '_0xo+=String.fromCharCode((_0xs.charCodeAt(_0xk)-_0k.charCodeAt(_0xk%_0k.length))&0xffff);',
      '}',
      'return _0xo;',
      '}'
    ].join('');
  }
  if (encoding === 'xorrev') {
    return [
      'function(_0xs){',
      'var _0k=' + keyExpr + ';',
      'var _0xo=\'\';',
      'for(var _0xk=_0xs.length-1;_0xk>=0;_0xk--){',
      '_0xo+=String.fromCharCode(_0xs.charCodeAt(_0xk)^_0k.charCodeAt((_0xs.length-1-_0xk)%_0k.length));',
      '}',
      'return _0xo;',
      '}'
    ].join('');
  }
  if (encoding === 'b64xor') {
    return [
      'function(_0xs){',
      'var _0k=' + keyExpr + ';',
      'var _0xo=\'\';var _0b=0;var _0t=0;var _0kp=0;',
      'var _0a=\'' + B64 + '\';',
      'for(var _0h=0;_0h<_0xs.length;_0h++){',
      'var _0c=_0a.indexOf(_0xs[_0h]);',
      'if(_0c<0)continue;',
      '_0b=(_0b<<6)|_0c;_0t+=6;',
      'if(_0t>=8){_0t-=8;var _0by=((_0b>>_0t)&0xff)^_0k.charCodeAt(_0kp%_0k.length);_0kp++;_0xo+=String.fromCharCode(_0by);}',
      '}',
      'var _0r=\'\';var _0p=0;',
      'while(_0p<_0xo.length){',
      'var _0d=_0xo.charCodeAt(_0p);',
      'if(_0d<0x80){_0r+=String.fromCharCode(_0d);_0p++;}',
      'else if(_0d<0xE0){',
      '_0r+=String.fromCharCode(((_0d&0x1F)<<6)|(_0xo.charCodeAt(_0p+1)&0x3F));_0p+=2;',
      '}else if(_0d<0xF0){',
      '_0r+=String.fromCharCode(((_0d&0x0F)<<12)|((_0xo.charCodeAt(_0p+1)&0x3F)<<6)|(_0xo.charCodeAt(_0p+2)&0x3F));_0p+=3;',
      '}else{',
      'var _0e=((_0d&0x07)<<18)|((_0xo.charCodeAt(_0p+1)&0x3F)<<12)|((_0xo.charCodeAt(_0p+2)&0x3F)<<6)|(_0xo.charCodeAt(_0p+3)&0x3F);',
      'var _0f=_0e-0x10000;',
      '_0r+=String.fromCharCode(0xD800|(_0f>>10),0xDC00|(_0f&0x3FF));_0p+=4;',
      '}',
      '}',
      'return _0r;',
      '}'
    ].join('');
  }
}

export default { xorEncode, xorDecode, b64Encode, b64Decode, rc4Crypt, rc4ToB64, utf8Encode, utf8Decode, affineEncode, affineParams, addEncode, xorRevEncode, b64xorEncode, decoderSource, buildKeyExpr, B64 };
