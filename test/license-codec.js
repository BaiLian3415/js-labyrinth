#!/usr/bin/env node
/**
 * 卡密与令牌的编解码往返，以及篡改检测。
 *
 *   node test/license-codec.js
 *
 * 整跑全部用例：npm test（即 node test/selftest.js）。
 */
import path from 'node:path';
import { ROOT, cleanTmp, ok, report, runSync, section } from './_harness.js';
import codec from '../src/license-codec.js';
import licCore from '../src/license-core.js';
import secret from '../src/license-secret.js';
import hash from '../src/utils/hash.js';


// 测试专用签发密钥对。
//
// 真私钥不随源码分发（这正是换成非对称的目的），所以自测不能拿它签卡——也不该
// 拿。测试自己固定一对：种子写死在这里，公钥由它派生，再通过 setKeyMaterial /
// JSLB_CODE_KEY 注入到 license-web 与 Worker。走的签发/校验代码路径与线上完全
// 相同，只有密钥不同。种子是公开的常量，仅供测试，绝不能用于真实发卡。
const TEST_CODE_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
section('卡密与令牌');
{
  // v5：对称卡密密钥 + 加密信息段 + 校验码（格式 JSLB-编号8-信息16-校验4）。
  // 密钥随源码分发（见 license-secret.js 的说明），防篡改靠校验码；"一卡一机"
  // 由服务端赎回登记承担，卡密不再携带绑定段。
  const key = TEST_CODE_KEY;
  const code = codec.issueCode(key, 'plus', 30, '12345');
  ok(!!code && code.startsWith('JSLB-'), '可签发 Plus/30 天卡密', code);
  ok(codec.normalizeCode(code).length === 4 + codec.BODY_LEN,
    '卡密总长 = 前缀4+编号8+信息16+校验4', String(codec.normalizeCode(code).length));
  const parsed = codec.parseCode(key, code);
  ok(parsed.ok && parsed.plan === 'plus' && parsed.days === 30, '卡密可解析且套餐天数正确');
  ok(parsed.id === '12345', '编号可还原（40 bit）');
  ok(typeof parsed.issueDay === 'number' && parsed.issueDay >= 0, '卡密带签发日');
  ok(parsed.bound === false && parsed.bindSeg === codec.BIND_NONE, 'v5 卡密不携带绑定段');
  ok(codec.parseCode(key, code.toLowerCase().replace(/-/g, ' ')).ok, '小写与分隔符容错');

  // 同一参数两次签发产出不同卡密（信息段带随机 IV），但都能被同一把密钥解析
  const again = codec.issueCode(key, 'plus', 30, '12345');
  ok(again !== code, '同参数两次签发卡密不同（随机 IV）');
  const againParsed = codec.parseCode(key, again);
  ok(againParsed.ok && againParsed.id === '12345' && againParsed.plan === 'plus',
    '随机 IV 不影响解析');

  // 校验码覆盖编号段与信息段：改任何一段的一位都必须被拒
  const flipChar = (t, i) => {
    const c = t[i] === '0' ? '1' : '0';
    return t.slice(0, i) + c + t.slice(i + 1);
  };
  ok(!codec.parseCode(key, flipChar(code, 6)).ok, '改编号段一位即被拒');
  ok(!codec.parseCode(key, flipChar(code, 16)).ok, '改信息段一位即被拒');
  ok(!codec.parseCode(key, flipChar(code, code.length - 1)).ok, '改校验码一位即被拒');
  // 末位改成与当前值**不同**的字符：直接写死 '0' 时，若签发出的校验码末位本就是
  // '0'，这行等于没改，解析自然成功——概率性假红（1/32），与上面的 flipChar 同理
  ok(!codec.parseCode(key, code.slice(0, -1) + (code.endsWith('0') ? '1' : '0')).ok, '改末位失败');
  ok(!codec.parseCode(key, 'JSLB-' + '0'.repeat(8) + '-' + '0'.repeat(16) + '-' + '0'.repeat(4)).ok,
    '全零编号+全零信息+全零校验被拒');

  // 对称体系下"没有正确的密钥就签不出能通过校验的卡"：错误密钥签出的卡密
  // 在校验码这一步必然失败（这里验的是拿错密钥冒充不会意外通过）。
  const otherKey = hash.bytesToB64(new Uint8Array(32).fill(9));
  const forged = codec.issueCode(otherKey, 'business', 0, '99999');
  ok(!!forged && !codec.parseCode(key, forged).ok, '错误密钥签发的卡密无法通过校验');

  // 编号段超界必须拒绝
  ok(codec.issueCode(key, 'plus', 30, '1099511627775') !== null, '编号上限内可签发');
  ok(codec.issueCode(key, 'plus', 30, '1099511627776') === null, '编号超 40 bit 上限时拒绝签发');
  ok(codec.MAX_ID === 1099511627775n, '编号上限恰为 2^40-1', String(codec.MAX_ID));

  // 签发日在加密载荷里，到期时间由它推出——这是"本地改不了自己的有效期"的依据。
  // 用 2026-01-01（距零点 2192 天）签 30 天，到期必须是 2026-01-31，而不是"激活时刻 + 30 天"。
  {
    const day = 2192; // 2026-01-01 距 2020-01-01 UTC 的天数
    const c = codec.issueCode(key, 'plus', 30, '12345', day);
    const p = codec.parseCode(key, c);
    ok(p.ok && p.issueDay === day, '签发日可从卡密还原', String(p.issueDay));
    const exp = licCore.expiryFromIssueDay(p);
    ok(exp === codec.DAY_ZERO + (day + 30) * 86400000,
      '到期时间 = 签发日 + 天数（不采信记录里的 issuedAt）',
      new Date(exp).toISOString().slice(0, 10));
    ok(new Date(exp).toISOString().slice(0, 10) === '2026-01-31',
      '2026-01-01 签的 30 天卡到期日为 2026-01-31');
    // 永久卡不受签发日影响
    const perm = codec.parseCode(key, codec.issueCode(key, 'plus', 0, '12345', day));
    ok(licCore.expiryFromIssueDay(perm) === codec.PERPETUAL, '永久卡到期时间为 0');
  }

  const mid = 'ABCDEFGHJKMNPQRSTVWXYZ01';
  const token = codec.makeToken(key, mid, 0, '2026-01-01', 3);
  ok(codec.verifyToken(key, token, mid, 0, '2026-01-01', 3), '令牌验签通过');
  ok(!codec.verifyToken(key, token, mid, 0, '2026-01-01', 4), '改用量次数后验签失败');
  ok(!codec.verifyToken(key, token, 'ZZZZZZZZZZZZZZZZZZZZZZZ1', 0, '2026-01-01', 3), '换机器码后验签失败');
  // 令牌密钥由卡密密钥派生，换一把密钥就对不上
  ok(!codec.verifyToken(secret.B64_CODE_KEY, token, mid, 0, '2026-01-01', 3), '换密钥后令牌验签失败');

  // 纯 JS HMAC 与 node:crypto 的一致性由 test/hashtest.js 覆盖，这里只跑它
  const ht = runSync(process.execPath, [path.join(ROOT, 'test', 'hashtest.js')], { encoding: 'utf8' });
  ok(ht.includes('全部通过'), 'hash 实现与 node:crypto 逐位一致', ht.trim().split('\n').pop());
}

if (process.argv[1] && process.argv[1].endsWith('license-codec.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}
