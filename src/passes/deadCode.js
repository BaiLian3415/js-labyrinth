import t from '../ast/types.js';
import rand from '../utils/rand.js';
const { randInt, uniqueName, randAlpha, randHex } = rand;
import vmBoundary from './vmBoundary.js';
const { insideVmFunction } = vmBoundary;
import rtlib from './rtlib.js';
/**
 * 死代码注入。Program 头部插入一个永不执行的垃圾 IIFE，函数体内再插入
 * 由恒假 guard 包裹的垃圾语句。guard 初值取自运行期熵，常量传播无法直接
 * 判定不可达，需要先求出 guard 的取值或走数据流分析。注入密度由
 * options.deadCodeProbability 控制，默认 0.7，按函数计；顶层语义诱饵函数
 * 由 options.decoyFunctions 控制，默认开启。注入标识符全部随机命名，后续
 * mangle 会再次改名。
 */

export default function deadCode(ast, options, ctx) {
  const { traverse, rng } = ctx;
  const used = ctx.usedNames;
  // 按函数计的注入命中概率，0~1，默认 0.7
  const probability = options.deadCodeProbability !== undefined ? options.deadCodeProbability : 0.7;
  let injected = 0;
  let boundRefs = 0;

  // 生成恒为 false 但非字面量的不可达条件，随机选两种形态之一：
  //   var g=E;  if (g === g + 1) { body }   任意 g 下恒假
  //   var g=E;  if (g !== g) { body }       g 非 NaN 时恒假
  //
  // guard 初值取自运行期熵，即时间戳低 31 位，不是构建期字面量。初值若是
  // 字面量，折叠器传播该常量后 g === 0x123 一步化简为 false，不可达性退化
  // 成 O(1) 判断。初值在运行期取值未知时，判死要先求出 g，或走真实数据流
  // 推理。
  //
  // 主形态曾用 g === g + 1：它不能靠自反规则 x === x → true 消去，但只要把握
  // 运算符的分配律就能整式化简（x === x + 1 恒假），现代压缩器的常量传播加
  // 代数简化会把它当死分支直接删掉，死块随之消失。
  //
  // 现在改为数论不透明谓词：分支条件对任意整数取值恒假，但要判定它是恒假
  // 必须用到模运算性质（h³ ≡ h (mod 3)）、按位取反的性质（x|~x 恒为 -1）或
  // 整数奇偶性（x ^ (x-1) 恒为奇数），编译器的代数简化与常量传播都覆盖不到。
  //
  // 取值必须先收窄：guard 初值是 Date.now() 派生的 int32，直接做 h³ 会溢出到
  // 双精度并丢掉精确的模 3 性质，所以先 & 0xff 取到 0..255，三次方最大
  // 16581375，全程精确整数。
  const guardInit = () => t.binaryExpression('&',
    t.binaryExpression('|',
      t.callExpression(
        t.memberExpression(t.identifier('Date'), t.identifier('now'), false), []),
      t.numericLiteral(0)),
    t.numericLiteral(0x7fffffff));

  function makeUnreachableGuard(body) {
    const guard = uniqueName(used, '_0x');
    const g = () => t.identifier(guard);
    const pick = randInt(0, 9);
    let cond;
    if (pick <= 3) {
      // (h³ - h) % 3 !== 0，h = g & 0xff。h³ - h = h(h-1)(h+1) 是三个连续整数的
      // 乘积，必含一个 3 的倍数，故模 3 恒为 0，条件恒假。
      //
      // 判定它需要模运算知识：常量传播与代数化简都不覆盖 % 3 的同余性质，而
      // 求值必须先拿到 g 的运行期取值。取值先 & 0xff 收窄到 0..255，三次方最大
      // 16581375，全程精确整数——直接对 Date.now() 派生的 int32 求三次方会溢出
      // 到双精度，同余性质不再成立（那时就不是恒假了）。
      const h = uniqueName(used, '_0x');
      const narrowed = () => t.binaryExpression('&', g(), t.numericLiteral(0xff));
      const cubeMinus = t.binaryExpression('-',
        t.binaryExpression('*',
          t.binaryExpression('*', t.identifier(h), t.identifier(h)),
          t.identifier(h)),
        t.identifier(h));
      cond = t.callExpression(
        t.functionExpression(null, [t.identifier(h)], t.blockStatement([
          t.returnStatement(t.binaryExpression('!==',
            t.binaryExpression('%', cubeMinus, t.numericLiteral(3)),
            t.numericLiteral(0))),
        ])),
        [narrowed()]);
    } else if (pick <= 6) {
      // (g | ~g) > -1：按位取反后与原值按位或，结果恒为 -1，恒不大于 -1。
      // 判定要先算出 g 的完整位模式
      cond = t.binaryExpression('>',
        t.binaryExpression('|', g(), t.unaryExpression('~', g(), true)),
        t.numericLiteral(-1));
    } else if (pick <= 8) {
      // ((g ^ (g - 1)) & 1) === 0：相邻两个整数异或得到的是低位起连续的 1，
      // 恒为奇数，与 1 相与恒为 1，条件恒假。判定需用到进位传播的性质
      cond = t.binaryExpression('===',
        t.binaryExpression('&',
          t.binaryExpression('^', g(), t.binaryExpression('-', g(), t.numericLiteral(1))),
          t.numericLiteral(1)),
        t.numericLiteral(0));
    } else {
      // g !== g，g 非 NaN 时恒假。自反规则可直接折叠为 false，形态多样性用，
      // 概率压到十分之一
      cond = t.binaryExpression('!==', g(), g());
    }
    return [
      t.variableDeclaration('var', [t.variableDeclarator(t.identifier(guard), guardInit())]),
      t.ifStatement(cond, t.blockStatement(body)),
    ];
  }

  // 生成一段看似真实的垃圾语句，供死代码体使用。
  // 形态无固定模板：表达式树深度、节点形态、操作数形态每条独立随机，
  // 位运算、算术、比较、成员访问、序列五族与字面量、引用两类操作数随机
  // 组合，统计上不存在可归一化的重复模板。
  // scopeNames 为函数真实绑定名，取参数与局部声明。垃圾语句以一定概率
  // 引用它们，让死代码与活代码共享数据流，活性分析无法以引用了未声明名
  // 为由一键剔除死块。
  const junkExpr = (depth, scopeNames) => {
    if (depth >= 3) {
      // 叶子节点，30% 概率用真实绑定名，没有可用名字则退化为字面量
      if (scopeNames && scopeNames.length && rng() < 0.3) {
        return t.identifier(scopeNames[randInt(0, scopeNames.length - 1)]);
      }
      return t.numericLiteral(randInt(0, 0xffff)); // 深度上限，只出原子节点
    }
    const kind = randInt(0, 6);
    if (kind === 0) {
      // 位运算
      const op = ['^', '&', '|', '>>', '<<', '>>>'][randInt(0, 5)];
      return t.binaryExpression(op, junkExpr(depth + 1, scopeNames), junkExpr(depth + 1, scopeNames));
    }
    if (kind === 1) {
      // 算术
      const op = ['+', '-', '*', '%'][randInt(0, 3)];
      return t.binaryExpression(op, junkExpr(depth + 1, scopeNames), junkExpr(depth + 1, scopeNames));
    }
    if (kind === 2) {
      // 比较/逻辑
      if (randInt(0, 1)) {
        const op = ['===', '!==', '<', '>'][randInt(0, 3)];
        return t.binaryExpression(op, junkExpr(depth + 1, scopeNames), junkExpr(depth + 1, scopeNames));
      }
      const op = ['&&', '||'][randInt(0, 1)];
      return t.logicalExpression(op, junkExpr(depth + 1, scopeNames), junkExpr(depth + 1, scopeNames));
    }
    if (kind === 3) {
      // 操作数原子：大数值字面量。死代码里的位运算与算术链要逐位求值才能
      // 确认无副作用，用大数做不透明运算，人工与自动化还原都容易算错。
      return t.numericLiteral(randInt(0, 0xfffffff));
    }
    if (kind === 4) {
      // 成员访问：数组字面量下标，或真实绑定名的成员读取
      if (scopeNames && scopeNames.length && rng() < 0.4) {
        return t.memberExpression(
          t.identifier(scopeNames[randInt(0, scopeNames.length - 1)]),
          junkExpr(depth + 1, null), true);
      }
      return t.memberExpression(
        t.arrayExpression([t.numericLiteral(randInt(0, 9)), junkExpr(depth + 1, null)]),
        t.numericLiteral(randInt(0, 1)), true);
    }
    if (kind === 5) {
      // typeof 守卫，读取绑定不会抛错，同时增强活代码的假象
      if (scopeNames && scopeNames.length) {
        const nm = scopeNames[randInt(0, scopeNames.length - 1)];
        return t.unaryExpression('typeof', t.identifier(nm), true);
      }
      return t.unaryExpression('typeof', junkExpr(depth + 1, null), true);
    }
    // 序列表达式，即嵌套逗号
    return t.sequenceExpression([junkExpr(depth + 1, scopeNames), junkExpr(depth + 1, scopeNames)]);
  };
  function makeJunkStmt(scopeNames) {
    const e = junkExpr(0, scopeNames);
    if (scopeNames && scopeNames.length) boundRefs++;
    return t.expressionStatement(e);
  }

  // 注入到 Program 头部的垃圾 IIFE
  function buildJunkIIFE() {
    const fnName = uniqueName(used, '_0x');
    const arrName = uniqueName(used, '_0x');
    const iName = uniqueName(used, '_0x');
    const n = randInt(2, 5);

    const arrElems = [];
    for (let i = 0; i < n; i++) {
      arrElems.push(t.numericLiteral(randInt(1, 0xff)));
    }

    // function fn(a){ return a * 0x539 + 0x1; }
    const fnExpr = t.functionExpression(
      t.identifier(fnName),
      [t.identifier('_0xa')],
      t.blockStatement([
        t.returnStatement(
          t.binaryExpression('+',
            t.binaryExpression('*', t.identifier('_0xa'), t.numericLiteral(0x539)),
            t.numericLiteral(0x1))
        ),
      ])
    );

    // 数组 + 循环（函数体里引用 IIFE 参数 _0xfn）
    const body = [
      t.variableDeclaration('var', [
        t.variableDeclarator(t.identifier(arrName), t.arrayExpression(arrElems)),
      ]),
      t.forStatement(
        t.variableDeclaration('var', [
          t.variableDeclarator(t.identifier(iName), t.numericLiteral(0)),
        ]),
        t.binaryExpression('<', t.identifier(iName), t.memberExpression(t.identifier(arrName), t.identifier('length'), false)),
        t.updateExpression('++', t.identifier(iName)),
        t.blockStatement([
          t.expressionStatement(
            t.assignmentExpression('=',
              t.memberExpression(t.identifier(arrName), t.identifier(iName), true),
              t.callExpression(t.identifier('_0xfn'), [
                t.memberExpression(t.identifier(arrName), t.identifier(iName), true),
              ]))
          ),
        ])
      ),
      // 永远不可达：guard 变量比较，不是 1===2 这类字面量形态
      ...makeUnreachableGuard([
        t.expressionStatement(
          t.callExpression(t.identifier('_0xfn'), [
            t.memberExpression(t.identifier(arrName), t.numericLiteral(0), true),
          ])
        ),
      ]),
    ];

    // (function(fn){ ...body... })(fn)
    const iife = t.callExpression(
      t.functionExpression(null, [t.identifier('_0xfn')], t.blockStatement(body)),
      [fnExpr]
    );
    return t.expressionStatement(iife);
  }

  // 垃圾 IIFE 直接插入 Program 头部，不需要遍历全树，根节点为 File 或 Program
  const program = ast.type === 'File' ? ast.program : ast;
  // 保留头部的 'use strict' 指令，插到它之后
  let ins = 0;
  while (ins < program.body.length && program.body[ins].type === 'Directive') ins++;
  program.body.splice(ins, 0, buildJunkIIFE());
  injected++;

  // 语义诱饵函数：注入 1~3 个形似真实业务、但永不被调用的顶层函数，干扰
  // 对文件用途的归纳。函数体只引用宿主全局白名单与内建（fetch、document、
  // localStorage、atob、JSON、Date 等），selfCheck 才能通过，且语句位无害。
  const decoyEnabled = options.decoyFunctions !== false;
  let decoyCount = 0;
  if (decoyEnabled) {
    decoyCount = randInt(1, 3);
    const decoyBody = (a, b) => {
      const strA = t.stringLiteral(randAlpha(randInt(6, 14)));
      const strB = t.stringLiteral(randHex(12));
      // 浅层构造助手，避免深嵌套括号
      const member = (obj, prop) => t.memberExpression(t.identifier(obj), t.identifier(prop), false);
      const call = (callee, args) => t.callExpression(callee, args);
      const varDecl = (name, init) => t.variableDeclaration('var', [
        t.variableDeclarator(t.identifier(name), init)]);
      const guard = (stmts) => t.tryStatement(
        t.blockStatement(stmts),
        t.catchClause(t.identifier('_0e'), t.blockStatement([])),
        null);
      switch (randInt(0, 3)) {
        case 0: { // 网络请求形态
          const payload = t.objectExpression([
            t.objectProperty(t.identifier('t'), t.identifier(b)),
            t.objectProperty(t.identifier('nonce'), strB),
          ]);
          const req = call(t.identifier('fetch'), [
            t.identifier(b),
            t.objectExpression([
              t.objectProperty(t.identifier('method'), t.stringLiteral('POST')),
              t.objectProperty(t.identifier('headers'), t.objectExpression([
                t.objectProperty(t.stringLiteral('content-type'), t.stringLiteral('application/json')),
              ])),
              t.objectProperty(t.identifier('body'),
                call(member('JSON', 'stringify'), [payload])),
            ]),
          ]);
          return [guard([
            varDecl(a, req),
            t.expressionStatement(call(member('console', 'log'), [t.identifier(a)])),
          ])];
        }
        case 1: { // DOM 形态
          return [guard([
            varDecl(a, call(member('document', 'createElement'), [t.stringLiteral('div')])),
            t.expressionStatement(call(member(a, 'setAttribute'), [
              t.binaryExpression('+', t.stringLiteral('data-'), t.identifier(b)),
              strA,
            ])),
            t.expressionStatement(call(
              t.memberExpression(member('document', 'body'), t.identifier('appendChild'), false),
              [t.identifier(a)])),
          ])];
        }
        case 2: { // 存储形态
          const rec = t.objectExpression([
            t.objectProperty(t.identifier('v'), t.identifier(b)),
            t.objectProperty(t.identifier('ts'), call(member('Date', 'now'), [])),
          ]);
          return [guard([
            t.expressionStatement(call(member('localStorage', 'setItem'), [
              strA,
              call(member('JSON', 'stringify'), [rec]),
            ])),
          ])];
        }
        default: { // 编解码形态
          const fromArr = call(member('Array', 'from'), [t.identifier(a)]);
          const xorArrow = t.arrowFunctionExpression([t.identifier('c')],
            t.binaryExpression('^',
              call(member('c', 'charCodeAt'), [t.numericLiteral(0)]),
              t.numericLiteral(randInt(1, 0xff))));
          const decoded = call(t.memberExpression(fromArr, t.identifier('map'), false), [xorArrow]);
          return [guard([
            varDecl(a, call(t.identifier('atob'), [t.identifier(b)])),
            varDecl(b, decoded),
            t.expressionStatement(t.identifier(a)),
          ])];
        }
      }
    };
    const decoyInserts = [];
    for (let i = 0; i < decoyCount; i++) {
      const fname = uniqueName(used, '_0x');
      const p1 = uniqueName(used, '_0x');
      const p2 = uniqueName(used, '_0x');
      // 体与参数同名传递，体内引用 a=p1、b=p2，保证绑定一致，否则 selfCheck
      // 会报未绑定引用
      decoyInserts.push(t.functionDeclaration(
        t.identifier(fname),
        [t.identifier(p1), t.identifier(p2)],
        t.blockStatement(decoyBody(p1, p2))));
    }
    program.body.splice(ins + 1, 0, ...decoyInserts);
  }

  traverse(ast, {
    Function(path) {
      // RT 内核引导层不注垃圾，热原语按每字符计成本
      if (rtlib.isRtFn(ctx, path.node)) return;
      // VM 解释器骨架跳过，契约见 vmBoundary.js：注入位置取 return 之后或
      // 函数末尾，在解释器结构上没有语义，且引用收集在槽位化后的函数体上
      // 不可靠
      if (insideVmFunction(path)) return;
      if (rng() > probability) return;
      const bodyPath = path.get('body');
      if (!bodyPath.isBlockStatement()) return;
      const stmts = bodyPath.node.body;
      if (stmts.length < 2) return;

      // 收集本函数真实绑定名，取参数与函数体直接顶层声明，供垃圾语句引用。
      // 只收顶层：for 头与 if 块内的块级 let/const 作用域不含注入点，引用会
      // 成为悬空名并被 selfCheck 拒绝。注入点在函数体顶层的 return 之后或
      // 末尾，同名的顶层引用必然有绑定。
      const scopeNames = [];
      try {
        const fn = path.node;
        for (const p of fn.params || []) {
          const ids = t.getBindingIdentifiers(p);
          for (const k of Object.keys(ids)) scopeNames.push(k);
        }
        for (const s of fn.body.body || []) {
          if (s.type === 'VariableDeclaration') {
            for (const d of s.declarations) {
              const ids = t.getBindingIdentifiers(d.id);
              for (const k of Object.keys(ids)) scopeNames.push(k);
            }
          } else if (s.type === 'FunctionDeclaration' && s.id) {
            scopeNames.push(s.id.name);
          }
        }
      } catch (e) { /* 收集失败则退化为纯字面量垃圾 */ }
      // 名单去重，并剔除与宿主全局和内建冲突的名字，避免悬空误判
      const seen = new Set();
      const safe = [];
      for (const nm of scopeNames) {
        if (nm === 'arguments' || nm === 'undefined') continue;
        if (seen.has(nm)) continue;
        seen.add(nm);
        safe.push(nm);
      }

      // 有 return 就在它之后注入不可达代码，否则追加到函数体末尾
      let insertIdx = -1;
      for (let i = 0; i < stmts.length; i++) {
        if (t.isReturnStatement(stmts[i])) { insertIdx = i + 1; break; }
      }
      const junkBody = [];
      const junkCount = randInt(3, 6);
      for (let i = 0; i < junkCount; i++) junkBody.push(makeJunkStmt(safe));
      const junk = makeUnreachableGuard(junkBody);

      if (insertIdx >= 0) {
        stmts.splice(insertIdx, 0, ...junk);
      } else {
        stmts.push(...junk);
      }
      injected++;
    },
    noScope: true,
  });

  return { injected, boundRefs, decoys: decoyCount };
};
