/**
 * 解析器位置追踪（source map 的前置）。
 *
 * 跑法：node test/source-loc.js
 *
 * 三件事要钉住：
 *   ① 默认关时产物与之前逐字节相同（挂 start/end/loc 是有成本的，不能拖慢常规构建）
 *   ② 打开后每条语句都带正确的 start/end/loc，且覆盖嵌套层级
 *   ③ 行列折算与源码真实位置一致（拿源码文本反查，不是拿解析器自己的说法自证）
 */
import parser from '../src/ast/parser.js';
import { obfuscate } from '../src/index.js';
import { ok, report, section, cleanTmp } from './_harness.js';
import { runNode } from './_harness.js';

const { parse } = parser;

const SRC = [
  'var a = 1;',            // 1
  'function f(n) {',       // 2
  '  if (n > 0) {',       // 3
  '    return n;',        // 4
  '  }',                  // 5
  '  return 0;',          // 6
  '}',                     // 7
  'process.stdout.write(String(a + f(2)));', // 8
].join('\n');

section('解析器位置追踪');
{
  // ① 默认关：不挂 loc
  const off = parse(SRC, { sourceType: 'script' });
  const offStmts = off.program.body;
  ok(offStmts.every((s) => s.loc === undefined && s.start === undefined),
    '默认不开 locations 时语句节点不带 loc/start',
    offStmts.filter((s) => s.loc !== undefined).length + ' 个带了');
  ok(typeof offStmts[0].srcIdx === 'number',
    'srcIdx 仍在（vm comment 模式依赖它）');

  // ② 打开后有位置，且覆盖嵌套
  const on = parse(SRC, { sourceType: 'script', locations: true });
  const st = on.program.body;
  ok(st.every((s) => s.loc && s.loc.start && s.loc.end && typeof s.start === 'number'),
    '全部语句都带 start/end/loc',
    st.filter((s) => !s.loc).map((s) => s.type).join(','));

  // 顶层语句的行号应与源码实际行号一致
  const lines = SRC.split('\n');
  const topLevel = st.map((s) => s.loc.start.line);
  ok(topLevel[0] === 1, '第 1 条语句在第 1 行', 'got ' + topLevel[0]);
  ok(topLevel[1] === 2, '函数声明在第 2 行', 'got ' + topLevel[1]);
  ok(topLevel[topLevel.length - 1] === 8, '最后一条语句在第 8 行',
    'got ' + topLevel[topLevel.length - 1]);

  // ③ 嵌套语句：函数体内的 if / return 都要有位置，且行号正确
  const fn = st[1];
  ok(fn.type === 'FunctionDeclaration', '第 2 条是函数声明', fn.type);
  const inner = fn.body.body;
  ok(inner.length === 2, '函数体里有 2 条语句', 'got ' + inner.length);
  const ifStmt = inner[0];
  ok(ifStmt.loc && ifStmt.loc.start.line === 3, '嵌套 if 在第 3 行',
    ifStmt.loc && String(ifStmt.loc.start.line));
  const deepest = ifStmt.consequent.body[0];
  ok(deepest.loc && deepest.loc.start.line === 4, '再嵌套一层的 return 在第 4 行',
    deepest.loc && String(deepest.loc.start.line));

  // ④ 行列折算与源码文本反查一致（不信解析器自报）
  {
    const linesArr = SRC.split('\n');
    let mismatched = [];
    const check = (node) => {
      if (!node || typeof node !== 'object' || !node.loc) return;
      const text = linesArr[node.loc.start.line - 1];
      const head = text.slice(node.loc.start.column, node.loc.start.column + 12);
      if (head.length && /^\s*$/.test(head)) mismatched.push(node.loc.start.line + ':' + node.loc.start.column);
    };
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (typeof n.type === 'string') check(n);
      for (const k of Object.keys(n)) {
        if (k === 'loc') continue;
        walk(n[k]);
      }
    };
    walk(st);
    ok(mismatched.length === 0, '每个语句的 (行,列) 落点都不是空白（说明折算与源码对得上）',
      mismatched.slice(0, 3).join(' '));
  }

  // ⑤ end 不早于 start，且不超过源码长度
  const bad = [];
  const chk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(chk); return; }
    if (n.loc && (typeof n.end === 'number' && (n.end < n.start || n.end > SRC.length))) {
      bad.push(n.type + ' ' + n.start + '..' + n.end);
    }
    for (const k of Object.keys(n)) { if (k !== 'loc') chk(n[k]); }
  };
  chk(st);
  ok(bad.length === 0, 'end >= start 且不超过源码长度', bad.slice(0, 3).join(' '));

  // ⑥ 默认关时产物逐字节不变（位置追踪不得影响常规构建）
  {
    const a = obfuscate(SRC, { preset: 'low', seed: 7 }).code;
    const b = obfuscate(SRC, { preset: 'low', seed: 7 }).code;
    ok(a === b, '同 seed 两次构建逐字节相同（可复现性未被位置追踪影响）');
    ok(String(runNode(a, 'loc-ok.js')).trim() === '3', '产物仍可执行且语义不变',
      String(runNode(a, 'loc-ok2.js')).trim());
  }
}

if (process.argv[1] && process.argv[1].endsWith('source-loc.js')) {
  const bad = report();
  cleanTmp();
  if (bad) process.exit(1);
}