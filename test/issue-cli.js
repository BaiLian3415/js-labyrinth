#!/usr/bin/env node
/**
 * 签发工具命令行（v5 随机编号）。
 *
 *   node test/issue-cli.js
 *
 * 整跑全部用例：npm test（即 node test/selftest.js）。
 */
import path from 'node:path';
import { ROOT, cleanTmp, ok, report, runSync, section } from './_harness.js';
import codec from '../src/license-codec.js';
import plan from '../src/plan.js';
import hash from '../src/utils/hash.js';


// 测试专用签发密钥对。
//
// 真私钥不随源码分发（这正是换成非对称的目的），所以自测不能拿它签卡——也不该
// 拿。测试自己固定一对：种子写死在这里，公钥由它派生，再通过 setKeyMaterial /
// JSLB_CODE_KEY 注入到 license-web 与 Worker。走的签发/校验代码路径与线上完全
// 相同，只有密钥不同。种子是公开的常量，仅供测试，绝不能用于真实发卡。
const TEST_CODE_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
section('签发工具命令行（v5 随机编号）');
{
  // 这一节必须真的把 keygen.js 当子进程跑，不能只调 codec。v5 的编号随机生成、
  // 无计数器；密钥从 JSLB_CODE_KEY 环境变量注入（假密钥是 32 字节非零 base64，
  // 签出的卡密语法合法且能被同一把假密钥解析）。
  const KEYGEN = path.join(ROOT, 'tools', 'issue', 'keygen.js');
  const FAKE_KEY = hash.bytesToB64(new Uint8Array(32).fill(7));
  const env = {
    ...process.env,
    JSLB_CODE_KEY: FAKE_KEY,
  };
  const gen = (args) => runSync(process.execPath, [KEYGEN, ...args], {
    encoding: 'utf8', timeout: 30000, env,
  });
  const genFail = (args, customEnv) => {
    try {
      runSync(process.execPath, [KEYGEN, ...args], { encoding: 'utf8', timeout: 30000, env: customEnv || env });
      return null;
    } catch (e) {
      return String((e.stderr || '') + (e.stdout || ''));
    }
  };

  // 默认签发：随机编号。产物必须是 v5 三段结构，且能被同一把密钥解析。
  const first = gen(['--plan', 'plus', '--days', '365']);
  const line = first.trim().split('\n')[0].trim();
  ok(line.startsWith('JSLB-'), '默认签发得到卡密', line.slice(0, 24) + '…');
  ok(codec.normalizeCode(line).length === 4 + codec.BODY_LEN, '卡密总长 = 前缀4+编号8+信息16+校验4');
  const parsedFirst = codec.parseCode(FAKE_KEY, line);
  ok(parsedFirst.ok && parsedFirst.plan === 'plus' && parsedFirst.days === 365,
    'keygen 产物可用其密钥解析，套餐天数正确');

  // 随机编号：两次签发卡密必然不同（随机编号 + 随机 IV）
  const second = gen(['--plan', 'plus', '--days', '365']);
  ok(second.trim() !== first.trim(), '两次签发卡密不同（随机编号与随机 IV）');

  // --count 3 出 3 张互不相同的卡密（批内随机去重）
  const batch = gen(['--plan', 'plus', '--days', '365', '--count', '3']).trim().split('\n');
  ok(batch.length === 3 && new Set(batch).size === 3, '--count 3 出 3 张互不相同的卡密',
    String(batch.length) + ' 行 / ' + new Set(batch).size + ' 张');

  // --id 显式指定：编号可还原
  const explicit = gen(['--plan', 'plus', '--days', '30', '--id', '12345']);
  const parsedExplicit = codec.parseCode(FAKE_KEY, explicit.trim());
  ok(parsedExplicit.ok && parsedExplicit.id === '12345', '--id 指定的编号可从卡密还原');

  // --id 越界：错误信息必须指向 --id
  const tooBig = genFail(['--plan', 'plus', '--id', String(Number(codec.MAX_ID) + 1)]);
  ok(tooBig !== null && /--id/.test(tooBig), '显式 --id 越界时报错并点出 --id',
    String(tooBig).trim().split('\n').pop());

  // --bind 已废除：报错要给出"改用赎回模型"的指引
  const bindErr = genFail(['--plan', 'plus', '--bind', 'ABCDEFGHJKMNPQRSTVWXYZ01']);
  ok(bindErr !== null && /绑定/.test(bindErr), '--bind 已废除并给出指引',
    String(bindErr).trim().split('\n')[0]);

  // 无环境变量、磁盘上也没有 .jslb-code-key 时，keygen 按设计**回退内置密钥**
  // （CODE_KEY 的兜底分支：内置密钥部署下签发与 --check 同源，开箱即用）。
  // 这里曾经断言"必须报错"，那是回退逻辑加进来之前的旧口径，已随实现过期。
  const noKeyEnv = { ...process.env };
  delete noKeyEnv.JSLB_CODE_KEY;
  const fallbackIssue = genFail(['--plan', 'plus'], noKeyEnv);
  ok(fallbackIssue === null, '无密钥时回退内置密钥签发（开箱即用，不再报错）',
    String(fallbackIssue).trim().split('\n')[0]);

  // 真正走报错分支的是"密钥存在但不可用"：32 字节 base64 之外的取值一律拒绝，
  // 免得把配置错误表现成"所有卡密都校验失败"
  const badKeyEnv = { ...process.env, JSLB_CODE_KEY: 'not-a-32-byte-base64-key' };
  const badKey = genFail(['--plan', 'plus'], badKeyEnv);
  ok(badKey !== null && /密钥/.test(badKey), '密钥不可用时明确报错并指出设置方式',
    String(badKey).trim().split('\n')[0]);

  // --machine 不需要密钥：即使在密钥不可用的环境下也必须正常
  const machineOut = runSync(process.execPath, [KEYGEN, '--machine', '--json'], {
    encoding: 'utf8', timeout: 30000, env: badKeyEnv,
  });
  let parsedMachine = null;
  try { parsedMachine = JSON.parse(machineOut.trim()); } catch { /* 下面断言报错 */ }
  ok(parsedMachine && parsedMachine.machine && parsedMachine.machine.length === 24
    && codec.isB32Text(parsedMachine.machine),
  '--machine 无需密钥即可打印 24 字符机器码',
  parsedMachine ? parsedMachine.machine : machineOut.trim());
}

if (process.argv[1] && process.argv[1].endsWith('issue-cli.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}
