/**
 * domainLockRedirectUrl 的行为与安全边界。
 *
 * 跑法：node test/domain-redirect.js（单跑，不进整体 selftest）
 */
import { obfuscate } from '../src/index.js';
import { ok, report, section, cleanTmp } from './_harness.js';

section('域名锁定：重定向地址');
{
  const SRC = 'process.stdout.write("ok");';

  // throw 降级：字符串池关掉、integrityCheck 关掉，couple 为空 → mode=throw
  const throwMode = { preset: 'low', stringArray: false, integrityCheck: false, mangle: false, shell: false };
  const dl = { domainLock: 'example.com' };

  // ① 配了合法地址 → 产物里有 location.replace，且在 throw 之前
  const withRedirect = obfuscate(SRC, {
    ...throwMode, ...dl, domainLockRedirectUrl: '/denied', seed: 5,
  });
  const st1 = (withRedirect.stats || []).find((s) => s.pass === 'domainLock');
  ok(!!withRedirect.code.includes('location.replace("/denied")'),
    '产物含 location.replace("/denied")');
  ok(!!st1 && st1.result && st1.result.redirect === true,
    'stats.domainLock.redirect=true（如实报告跳转真的生效）',
    JSON.stringify(st1 && st1.result));
  const iRe = withRedirect.code.indexOf('location.replace');
  const iThrow = withRedirect.code.indexOf('this build is locked to another domain');
  ok(iRe >= 0 && iThrow >= 0 && iRe < iThrow,
    '跳转排在抛错之前（非授权域看到空白页而不是英文报错）',
    'replace@' + iRe + ' throw@' + iThrow);

  // ② 未配 → 没有跳转
  const noRedirect = obfuscate(SRC, { ...throwMode, ...dl, seed: 5 });
  ok(!noRedirect.code.includes('location.replace'), '未配重定向时产物里没有跳转语句');

  // ③ 危险 scheme 必须被拒（否则这个选项就是往产物里注入任意脚本的入口）
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x']) {
    const r = obfuscate(SRC, { ...throwMode, ...dl, domainLockRedirectUrl: bad, seed: 5 });
    const st = (r.stats || []).find((s) => s.pass === 'domainLock');
    ok(!r.code.includes('location.replace(' + JSON.stringify(bad)),
      '危险 scheme 被忽略：' + bad.slice(0, 24));
    ok(!!st && st.result && String(st.result.suppressed || '').includes('domainLockRedirectUrl'),
      '危险 scheme 在 stats.suppressed 里列出（不静默失效）：' + bad.slice(0, 20),
      JSON.stringify(st && st.result && st.result.suppressed));
  }

  // ④ 合法绝对地址与相对地址都收
  for (const good of ['https://x.example/denied', 'http://x.example/', './gone', '../up']) {
    const r = obfuscate(SRC, { ...throwMode, ...dl, domainLockRedirectUrl: good, seed: 5 });
    ok(r.code.includes('location.replace(' + JSON.stringify(good) + ')'),
      '合法地址被接受：' + good);
  }

  // ⑤ coupled/poison 降级下跳转是死代码 —— 如实报 false，不谎称生效
  {
    const coupled = obfuscate(SRC, {
      preset: 'low', domainLock: 'example.com', domainLockRedirectUrl: '/denied',
      stringArray: true, integrityCheck: true, seed: 5,
    });
    const st = (coupled.stats || []).find((s) => s.pass === 'domainLock');
    const mode = st && st.result && st.result.mode;
    ok(mode !== 'throw' ? (st.result.redirect === false) : true,
      '非 throw 降级下 redirect 如实报 false（配了但不生效）',
      'mode=' + mode + ' redirect=' + JSON.stringify(st && st.result && st.result.redirect));
  }
}

if (process.argv[1] && process.argv[1].endsWith('domain-redirect.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}