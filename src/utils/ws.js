/**
 * 空白字符集只在这里定义。构建期文本归一与运行期 RTL_WS 必须逐码一致。
 * integrityCheck 的 stripWs 和 rtlib 注入的内核都读这张表，不走 /\s/。
 */
const WS_CHARS = ' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';

/**
 * WS_CHARS 的码点数组，充当 RTL_WS 的运行时判定表，与构建期同一集合。
 * @returns {number[]} 空白字符码点
 */
function wsCodes() {
  const out = [];
  for (let i = 0; i < WS_CHARS.length; i++) out.push(WS_CHARS.charCodeAt(i));
  return out;
}

export default { WS_CHARS, wsCodes };
