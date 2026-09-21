/**
 * 极简 ZIP 打包器（store 模式，不压缩），零依赖。
 *
 * 网页界面把多个文件的混淆结果打成一个 .zip 下载，省去逐个另存。只写不压缩
 * 条目，兼容所有解压工具，除 CRC-32 外不需要任何压缩算法，浏览器与 Node 下
 * 行为一致（Node 侧同样可用，配合 Buffer/Blob 落盘）。
 */

/** CRC-32 查表，模块加载时按 IEEE 802.3 多项式生成一次。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * CRC-32。
 * @param {Uint8Array} bytes 数据
 * @returns {number} 32 位无符号校验值
 */
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * UTF-8 编码，跨环境实现（不依赖 TextEncoder，Node 老版本同样可用）。
 * @param {string} str 文本
 * @returns {Uint8Array} 字节
 */
function utf8(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length && str.charCodeAt(i + 1) >= 0xdc00 && str.charCodeAt(i + 1) < 0xe000) {
      const cp = 0x10000 + ((c - 0xd800) << 10) + (str.charCodeAt(++i) - 0xdc00);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return new Uint8Array(out);
}

/** DOS 时间/日期。ZIP 头用 1980 起算的 16 位字段，取不到时间就给固定值。 */
function dosTime(d) {
  // 1980-01-01 00:00:00 是 DOS 时间的零点，早于它的值不合法
  const year = d.getFullYear() < 1980 ? 1980 : d.getFullYear();
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** 小端写入工具：往字节数组里追加若干整数。 */
function push32(out, v) {
  out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}
function push16(out, v) {
  out.push(v & 0xff, (v >>> 8) & 0xff);
}

/**
 * 打包成 ZIP。
 *
 * @param {Array<{name:string, data:string|Uint8Array}>} files 条目列表，
 *   data 为字符串时按 UTF-8 落盘
 * @param {Date} [when] 条目时间戳，默认当前时间
 * @returns {Uint8Array} zip 字节
 */
export function makeZip(files, when) {
  const d = when || new Date();
  const { time, date } = dosTime(d);
  const out = [];
  const central = [];

  for (const f of files) {
    const nameBytes = utf8(String(f.name));
    const data = typeof f.data === 'string' ? utf8(f.data) : f.data;
    const crc = crc32(data);
    const offset = out.length;

    // 本地文件头
    push32(out, 0x04034b50);
    push16(out, 20);          // version needed
    push16(out, 0x0800);      // 文件名按 UTF-8
    push16(out, 0);           // 方法 0 = store
    push16(out, time);
    push16(out, date);
    push32(out, crc);
    push32(out, data.length); // 压缩后大小（不压缩，等于原大小）
    push32(out, data.length);
    push16(out, nameBytes.length);
    push16(out, 0);           // 无扩展字段
    for (let i = 0; i < nameBytes.length; i++) out.push(nameBytes[i]);
    for (let i = 0; i < data.length; i++) out.push(data[i]);

    // 中央目录项
    const c = [];
    push32(c, 0x02014b50);
    push16(c, 20);            // version made by
    push16(c, 20);            // version needed
    push16(c, 0x0800);
    push16(c, 0);
    push16(c, time);
    push16(c, date);
    push32(c, crc);
    push32(c, data.length);
    push32(c, data.length);
    push16(c, nameBytes.length);
    push16(c, 0);             // 扩展字段
    push16(c, 0);             // 注释
    push16(c, 0);             // 起始磁盘
    push16(c, 0);             // 内部属性
    push32(c, 0);             // 外部属性
    push32(c, offset);
    for (let i = 0; i < nameBytes.length; i++) c.push(nameBytes[i]);
    central.push(c);
  }

  const cdStart = out.length;
  let cdSize = 0;
  for (const c of central) {
    for (let i = 0; i < c.length; i++) out.push(c[i]);
    cdSize += c.length;
  }

  // 中央目录结束记录
  push32(out, 0x06054b50);
  push16(out, 0);
  push16(out, 0);
  push16(out, central.length);
  push16(out, central.length);
  push32(out, cdSize);
  push32(out, cdStart);
  push16(out, 0);

  return new Uint8Array(out);
}

export default { makeZip };
