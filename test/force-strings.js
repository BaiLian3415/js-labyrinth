/**
 * forceTransformStrings：点名要入池的串必须真的入池，且不受抽样阈值影响。
 *
 * 跑法：node test/force-strings.js
 */
import { obfuscate } from '../src/index.js';
import { ok, report, section, cleanTmp } from './_harness.js';
import { runNode } from './_harness.js';

section('强制入池字符串');
{
  const SECRET = 'sk-live-ABCDEF0123456789';
  const PLAIN = 'visible-plain-text';
  const build = (src, opts) => obfuscate(src, {
    preset: 'low', mangle: false, shell: false, seed: 1, ...opts,
  });

  // ① threshold=0 时只有被点名的串能进池
  {
    const src = `var s="${SECRET}";var p="${PLAIN}";process.stdout.write(String(s.length+p.length));`;
    const r = build(src, { stringArrayThreshold: 0, forceTransformStrings: [SECRET] });
    ok(!r.code.includes(SECRET), 'threshold=0 时点名的密钥串已不在产物明文里');
    ok(r.code.includes(PLAIN), 'threshold=0 时未点名的串留在明文（对照：确实按点名筛选）');
    ok(String(runNode(r.code, 'fs-1.js')).trim() === String(SECRET.length + PLAIN.length),
      '产物语义不变');
  }

  // ② threshold=1 时点名照样入池（这才是这条选项的意义：不靠概率）
  {
    const src = `var s="${SECRET}";process.stdout.write(String(s.length));`;
    let leaked = 0;
    for (const seed of [1, 2, 3, 5, 8, 13, 21, 34]) {
      const r = build(src, { stringArrayThreshold: 1, seed, forceTransformStrings: [SECRET] });
      if (r.code.includes(SECRET)) leaked++;
    }
    ok(leaked === 0, 'threshold=1（必然全收）下点名串 8 个 seed 都不泄漏', '泄漏 ' + leaked + ' 次');

    // 对照：同样 8 个 seed 但不点名 —— 说明"泄漏"本来就会发生，这正是要解决的问题
    // （forceSecretStrings:false 锁定旧行为：内置启发式默认会收走这个密钥形态的串）
    let leakedNoForce = 0;
    for (const seed of [1, 2, 3, 5, 8, 13, 21, 34]) {
      const r = build(src, { stringArrayThreshold: 0, seed, forceSecretStrings: false });
      if (r.code.includes(SECRET)) leakedNoForce++;
    }
    ok(leakedNoForce > 0, '对照：threshold=0 且不点名时确实会漏（这条选项针对的就是它）',
      '不点名时泄漏 ' + leakedNoForce + '/8');
  }

  // ③ 正则而非全等：只点名前缀就够
  {
    const src = `var a="tok_aaa";var b="tok_bbb";var c="other";process.stdout.write(String(a.length+b.length+c.length));`;
    const r = build(src, { stringArrayThreshold: 0, forceTransformStrings: ['^tok_'] });
    ok(!r.code.includes('tok_aaa') && !r.code.includes('tok_bbb'),
      '正则 ^tok_ 命中两个串并都入池');
    ok(r.code.includes('other'), '未命中的串留在明文');
  }

  // ④ 优先级：点名压过 reservedStrings（配了却不生效是最难查的配置错误）
  {
    const src = `var s="${SECRET}";process.stdout.write(String(s.length));`;
    const r = build(src, {
      stringArrayThreshold: 0,
      reservedStrings: [SECRET],
      forceTransformStrings: [SECRET],
    });
    ok(!r.code.includes(SECRET),
      '同时配 reservedStrings 与 forceTransformStrings 时以强制为准（确实入池了）');
    // 只配 reservedStrings 时应当留在明文
    const only = build(src, { stringArrayThreshold: 0, reservedStrings: [SECRET] });
    ok(only.code.includes(SECRET), '只配 reservedStrings 时确实留在明文（对照）');
  }

  // ⑤ 非法正则不能让构建失败（与 reservedStrings 同口径：跳过而不是抛）
  // （forceSecretStrings:false 锁定旧行为：这个密钥形态的串默认会被内置启发式收走，
  // 测"非法正则被跳过"必须先关掉它，否则断言的"仍在明文里"不成立）
  {
    const src = `var s="${SECRET}";process.stdout.write(String(s.length));`;
    let threw = false;
    let r = null;
    try {
      r = build(src, { stringArrayThreshold: 0, forceSecretStrings: false, forceTransformStrings: ['([unclosed'] });
    } catch (e) { threw = true; }
    ok(!threw, '非法正则被跳过而不是让构建失败');
    ok(r && r.code.includes(SECRET), '非法正则被跳过后该串仍按普通阈值处理（在明文里）');
  }

  // ⑥ 空模板字面量形态也认（StringLiteral 之外的第二个入口）
  {
    const src = 'var t=`' + SECRET + '`;process.stdout.write(String(t.length));';
    const r = build(src, { stringArrayThreshold: 0, forceTransformStrings: [SECRET] });
    ok(!r.code.includes(SECRET), '无插值的模板字面量同样被点名入池');
  }

  // ⑦ 内置强制（forceSecretStrings，默认开）：看着像密钥/端点的串不点名也恒进池，
  //   不靠概率；reservedStrings 明确保留的除外；关掉回到纯概率。
  {
    const S1 = 'sk_live_51Hb3kL9xQ2mZ8vB4nT6';
    const S2 = 'https://api.example.com/v1/pay';
    const S3 = 'a1b2c3d4e5f60718293a4b5c6';
    const S4 = '550e8400-e29b-41d4-a716-446655440000';
    const src = 'var box=["' + [S1, S2, S3, S4, 'hello', 'OK'].join('","') + '"];'
      + 'process.stdout.write(String(box.length));';
    // low 档阈值 0.5：不强制的话每个串各有一半概率留明文
    let leaked = 0, first = '';
    for (const seed of [1, 2, 3]) {
      const r = build(src, { stringArrayThreshold: 0.5, seed });
      for (const s of [S1, S2, S3, S4]) {
        if (r.code.includes(s)) { leaked++; if (!first) first = 'seed=' + seed + ' 漏 ' + s.slice(0, 16); }
      }
    }
    ok(leaked === 0, '密钥形态串不点名也恒进池（3 seed×4 串零泄漏）', first);
    // 保留名单明确要留的，内置启发式不覆盖（与 forceTransformStrings 压过保留正好反过来）
    const kept = build(src, { stringArrayThreshold: 0.5, seed: 1, reservedStrings: [S1] });
    ok(kept.code.includes(S1) && ![S2, S3, S4].some((s) => kept.code.includes(s)),
      'reservedStrings 明确保留的不被内置强制覆盖（其余照常入池）');
    // 逃生舱：关掉回到纯概率（旧行为可复现）
    let leakedOff = 0;
    for (const seed of [1, 2, 3]) {
      const r = build(src, { stringArrayThreshold: 0, seed, forceSecretStrings: false });
      if ([S1, S2, S3, S4].some((s) => r.code.includes(s))) leakedOff++;
    }
    ok(leakedOff > 0, '关掉后回到纯概率（对照：旧行为仍在）', 'leakedOff=' + leakedOff + '/3');
    const r0 = build(src, { stringArrayThreshold: 0.5, seed: 7 });
    ok(String(runNode(r0.code, 'fs-7.js')).trim() === '6', '内置强制不改变语义');
  }
}

if (process.argv[1] && process.argv[1].endsWith('force-strings.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}