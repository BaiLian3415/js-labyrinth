/**
 * Pass：Anti-LLM 加固。大语言模型读代码时最依赖三样东西——注释、命名、可见的
 * 业务句式。本 pass 直接对着这三样做对耗：
 *
 *   1) 误导性注记：以字符串字面量语句形式注入（生成器会丢真注释，字符串语句
 *      留得住，且 stringArray 会把它收进池里加密），内容是可读的工程口气，
 *      但与真实逻辑无关；
 *   2) 伪业务分支：不透明守卫（宿主探针 + 假环境变量比对）包住的整段"业务"
 *      计算，只引用内建全局与自己声明的局部，永不执行、被摘要时却很像正片；
 *   3) 命名污染：诱饵变量名走 uniqueName，与真实标识符同分布，人工分层命名
 *      习惯不再成立。
 *
 * 只处理普通函数体，VM 桥接体与机制层（RT 内核、字符串池访问器）跳过：那些
 * 位置的语句数会进入解释器帧大小计算，注入会改变帧布局。
 */
import t from '../ast/types.js';
import rand from '../utils/rand.js';
const { randInt, uniqueName } = rand;
import vmBoundary from './vmBoundary.js';

const { insideVmFunction } = vmBoundary;

// 注记与环境变量名逐构建组合（2026-10-11）：原来是 10 条注记 + 8 个 FLAG 常量，
// stringArray 阈值 <1 时注记留明文，跨构建统计产物明文即聚类出 antiLLM 档位。
// 改成槽位组合：TAG × 动词 × 对象 × 条件（8×8×8×8 = 4096 种注记），
// 头 × 核 × 尾（3×8×5 = 120 种 FLAG）。槽位全部按语法位置 curated
// （动词 + 名词短语 + 状语），组合恒通顺；随机性全部走 randInt（构建已播种），
// 同 seed 复现，不同 seed 换一批文本。
const NOTE_TAGS = ['TODO', 'NOTE', 'FIXME', 'PERF', 'SECURITY', 'COMPAT', 'WARNING', 'LEGACY'];
const NOTE_VERBS = ['keep', 'fold', 'drop', 'mirror', 'tune', 'hoist', 'guard', 'rebuild'];
const NOTE_OBJS = ['the legacy fallback', 'the index rebuild', 'the batch size', 'the hot loop',
  'the v1 payload shape', 'the shared cache', 'the rounding mode', 'the field name'];
const NOTE_CONDS = ['until the migration window closes', 'once the schema settles',
  'against the slowest downstream node', 'for settled amounts only', 'under workers',
  'after backfill', 'on purpose', 'for parity'];

const FLAG_HEADS = ['JSLB_', 'APP_', 'CFG_'];
const FLAG_CORES = ['TRACE', 'DIAG', 'COMPAT', 'REBUILD', 'FALLBACK', 'INDEX', 'LAYERS', 'PATH'];
const FLAG_TAILS = ['', '_V1', '_MODE', '_PATH', '_1'];

const pickSlot = (arr) => arr[randInt(0, arr.length - 1)];
// 前缀保留 `// TAG:` 形态：生成器会丢真注释，注记靠"注释样子的字符串语句"留存
const composeNote = () => '// ' + pickSlot(NOTE_TAGS) + ': ' + pickSlot(NOTE_VERBS) + ' '
  + pickSlot(NOTE_OBJS) + ' ' + pickSlot(NOTE_CONDS);
const composeFlag = () => pickSlot(FLAG_HEADS) + pickSlot(FLAG_CORES) + pickSlot(FLAG_TAILS);

/**
 * @param {object} ast AST，就地修改
 * @param {object} options 选项
 * @param {object} ctx pass 上下文
 * @returns {{notes:number, decoys:number, fns:number}}
 */
export default function antiLLM(ast, options, ctx) {
  const idp = options.identifierPrefix || '_0x';
  let notes = 0;
  let decoys = 0;
  let fns = 0;

  const noteStmt = () => t.expressionStatement(t.stringLiteral(composeNote()));

  /** 伪业务分支：宿主探针 + 假环境变量比对，永假但形状真实。 */
  const decoyStmt = () => {
    const nSeed = uniqueName(ctx.usedNames, idp);
    const nSum = uniqueName(ctx.usedNames, idp);
    const nTag = uniqueName(ctx.usedNames, idp);
    const flag = composeFlag();
    const lo = randInt(0x1000, 0xffff);
    const hi = randInt(0x10000, 0xfffff);
    const test = t.logicalExpression('&&',
      t.binaryExpression('!==',
        t.unaryExpression('typeof', t.identifier('process')),
        // "undefined" 字面量会进产物明文：typeof void 0 逐位恒等于它（见本轮
        // typeof-void 替换），且无字面量可锚
        t.unaryExpression('typeof', t.unaryExpression('void', t.numericLiteral(0), true), true)),
      t.logicalExpression('&&',
        t.memberExpression(t.identifier('process'), t.identifier('env'), false),
        t.binaryExpression('===',
          t.memberExpression(
            t.memberExpression(t.identifier('process'), t.identifier('env'), false),
            t.identifier(flag), false),
          t.stringLiteral('1'))));
    const body = t.blockStatement([
      t.variableDeclaration('var', [
        t.variableDeclarator(t.identifier(nSeed), t.numericLiteral(0)),
        t.variableDeclarator(t.identifier(nSum), t.numericLiteral(0)),
        t.variableDeclarator(t.identifier(nTag), t.stringLiteral('')),
      ]),
      t.expressionStatement(t.assignmentExpression('=',
        t.identifier(nSeed),
        t.binaryExpression('^',
          t.binaryExpression('&',
            t.callExpression(t.memberExpression(t.identifier('Date'), t.identifier('now'), false), []),
            t.numericLiteral(0xffff)),
          t.numericLiteral(lo)))),
      t.expressionStatement(t.assignmentExpression('=',
        t.identifier(nSum),
        t.binaryExpression('+',
          t.identifier(nSeed),
          t.numericLiteral(hi)))),
      t.expressionStatement(t.assignmentExpression('=',
        t.identifier(nTag),
        t.binaryExpression('+',
          t.callExpression(t.identifier('String'), [t.identifier(nSum)]),
          t.stringLiteral('-trace')))),
      t.ifStatement(
        t.binaryExpression('>', t.identifier(nSum), t.numericLiteral(0xfffff)),
        t.blockStatement([
          t.expressionStatement(t.assignmentExpression('=',
            t.identifier(nTag),
            t.callExpression(
              t.memberExpression(t.identifier(nTag), t.identifier('slice'), false),
              [t.numericLiteral(1)]))),
        ])),
    ]);
    return t.ifStatement(test, body);
  };

  const injectInto = (body) => {
    if (!body || body.type !== 'BlockStatement') return;
    if (body.body.length < 3) return;
    const rounds = randInt(1, 3);
    for (let r = 0; r < rounds; r++) {
      const at = randInt(0, body.body.length);
      if (randInt(0, 1) === 0) {
        body.body.splice(at, 0, noteStmt());
        notes++;
      } else {
        body.body.splice(at, 0, decoyStmt());
        decoys++;
      }
    }
  };

  ctx.traverse(ast, {
    Function: (path) => {
      const node = path.node;
      if (!node.body || node.body.type !== 'BlockStatement') return;
      if (insideVmFunction(path)) return;
      if (node.__rtKernel || node.__saMachinery) return;
      if (node.body.__llmTouched) return;
      node.body.__llmTouched = true;
      fns++;
      injectInto(node.body);
    },
    noScope: true,
  });

  // 顶层也铺一层：纯表达式脚本（没有函数）同样需要误导面
  const prog = ast.type === 'File' ? ast.program : ast;
  if (Array.isArray(prog.body) && prog.body.length >= 2) {
    const rounds = randInt(1, 2);
    for (let r = 0; r < rounds; r++) {
      const at = randInt(0, prog.body.length);
      if (randInt(0, 1) === 0) { prog.body.splice(at, 0, noteStmt()); notes++; }
      else { prog.body.splice(at, 0, decoyStmt()); decoys++; }
    }
  }

  return { notes, decoys, fns };
}
