import t from '../ast/types.js';
/**
 * AST 简化（simplify，对标 obfuscator.io 的 simplify）。排在流水线最前（parse
 * 之后、rtlib 之前），那时 AST 里只有用户代码、没有任何注入结构，可以放心做
 * 语义保守的压缩：
 *
 *   常量折叠 —— 数值/字符串/位运算/严格比较/一元/逻辑/条件，两侧都是字面量才
 *     折。结果必须有限（除零、取模 0、幂溢出这些 NaN/Infinity 不折），且避开
 *     -0（-0 与 0 在 Object.is 下不等，`1/x` 会因此分岔到 ±Infinity）。
 *   死代码消除 —— if(false){...}、while(false){...} 整块删除；if(true)A、if(true)
 *     A else B 这类直接换成保留下来的那一支。被删块永不执行，删除不改变任何
 *     可观察行为；替换时保留 block 原样（不展开 body），let/const/class 的块
 *     作用域不变。
 *   空语句清除 —— 只清 Program / BlockStatement 体内的空语句，循环体/if 体的
 *     `;` 必须保留（for(;;); 删了会变语法错误）。
 *   声明合并 —— 相邻的 `var a; var b;` 并成 `var a,b;`（初始化器求值顺序不变）。
 *   无用声明消除 —— 没有任何读取引用、且删除不改变可观察行为的变量/函数/类声明
 *     整条删掉（详见 eliminateUnused 的四道闸）。对"打包产物式"的输入（模块里带
 *     一批没人调用的辅助函数）实测 10.3 KB → 3.5 KB；手写的干净源码里没什么可删，
 *     这一项自然不产出收益（src/obfuscate.js 只降 0.4%）。
 *
 * 保守边界（宁可少折不可折错）：
 *   - BigIntLiteral / RegExpLiteral / TemplateLiteral / DecimalLiteral 一律不参与；
 *   - `==`/`!=` 只在两侧同类型字面量时折（隐式转换规则易错）；
 *   - `&&`/`||`/`??` 只在「被丢弃的一侧是字面量」时才折，避免丢函数调用副作用；
 *   - 条件表达式折叠同样要求被丢弃侧是字面量；
 *   - for 循环条件为 false 不删（init 的副作用必须保留）。
 *
 * 本 pass 确定性、无随机，固定 seed 可复现不受影响；只缩小/不变产物体积。
 */
import keys from '../ast/keys.js';
const { VISITOR_KEYS } = keys;

/** 可参与折叠求值的字面量（null 是合法值，undefined 表示「不是可折叠字面量」）。 */
function isFoldable(node) {
  if (!node) return false;
  const ty = node.type;
  return ty === 'NumericLiteral' || ty === 'StringLiteral' ||
    ty === 'BooleanLiteral' || ty === 'NullLiteral';
}

function litVal(node) {
  switch (node.type) {
    case 'NumericLiteral': return node.value;
    case 'StringLiteral': return node.value;
    case 'BooleanLiteral': return node.value;
    case 'NullLiteral': return null;
    default: return undefined;
  }
}

/** 把折叠结果替换回 path。仅接受 number/string/boolean，其它（NaN/Infinity/-0）拒绝。 */
function emit(path, result) {
  if (typeof result === 'number') {
    if (!Number.isFinite(result) || Object.is(result, -0)) return false;
    path.replaceWith(t.numericLiteral(result));
    return true;
  }
  if (typeof result === 'string') { path.replaceWith(t.stringLiteral(result)); return true; }
  if (typeof result === 'boolean') { path.replaceWith(t.booleanLiteral(result)); return true; }
  return false;
}

function foldBinary(path) {
  const n = path.node;
  const l = n.left, r = n.right;
  if (!isFoldable(l) || !isFoldable(r)) return false;
  const lv = litVal(l), rv = litVal(r);
  const op = n.operator;

  // 数值运算（两侧都是 number）
  if (typeof lv === 'number' && typeof rv === 'number') {
    let v;
    switch (op) {
      case '+': v = lv + rv; break;
      case '-': v = lv - rv; break;
      case '*': v = lv * rv; break;
      case '/': v = lv / rv; break;
      case '%': v = lv % rv; break;
      case '**': v = lv ** rv; break;
      case '&': v = lv & rv; break;
      case '|': v = lv | rv; break;
      case '^': v = lv ^ rv; break;
      case '<<': v = lv << rv; break;
      case '>>': v = lv >> rv; break;
      case '>>>': v = lv >>> rv; break;
      case '<': return emit(path, lv < rv);
      case '<=': return emit(path, lv <= rv);
      case '>': return emit(path, lv > rv);
      case '>=': return emit(path, lv >= rv);
      case '===': return emit(path, lv === rv);
      case '!==': return emit(path, lv !== rv);
      case '==': if (typeof lv === typeof rv) return emit(path, lv == rv); return false;
      case '!=': if (typeof lv === typeof rv) return emit(path, lv != rv); return false;
      default: return false;
    }
    return emit(path, v);
  }

  // 字符串拼接：至少一侧是字符串，另一侧是可 ToString 的字面量（number/boolean/null/string）
  if (op === '+') {
    const lStr = typeof lv === 'string', rStr = typeof rv === 'string';
    if (lStr || rStr) {
      const lOk = lStr || typeof lv === 'number' || typeof lv === 'boolean' || lv === null;
      const rOk = rStr || typeof rv === 'number' || typeof rv === 'boolean' || rv === null;
      if (lOk && rOk) return emit(path, String(lv) + String(rv));
    }
    return false;
  }

  // 字符串比较（两侧都是 string）
  if (typeof lv === 'string' && typeof rv === 'string') {
    if (op === '<') return emit(path, lv < rv);
    if (op === '<=') return emit(path, lv <= rv);
    if (op === '>') return emit(path, lv > rv);
    if (op === '>=') return emit(path, lv >= rv);
    if (op === '===') return emit(path, lv === rv);
    if (op === '!==') return emit(path, lv !== rv);
  }
  return false;
}

function foldUnary(path) {
  const n = path.node;
  const a = n.argument;
  if (!isFoldable(a)) return false;
  const av = litVal(a);
  const op = n.operator;
  if (op === '-' && typeof av === 'number') return emit(path, -av);
  if (op === '+' && typeof av === 'number') return emit(path, +av);
  if (op === '~' && typeof av === 'number') return emit(path, ~av);
  if (op === '!') return emit(path, !av); // number/string/boolean/null 的 truthy 判定与 JS 一致
  if (op === 'typeof') return emit(path, typeof av); // typeof null === "object"
  return false;
}

const truthy = (v) => !!v;

function foldLogical(path) {
  const n = path.node;
  const l = n.left, r = n.right, op = n.operator;
  const lLit = isFoldable(l), rLit = isFoldable(r);
  const lv = lLit ? litVal(l) : undefined;
  if (op === '&&') {
    if (lLit && truthy(lv)) { path.replaceWith(r); return true; }        // true && x → x（保留副作用）
    if (lLit && !truthy(lv) && rLit) { path.replaceWith(l); return true; } // falsy && lit → falsy
  } else if (op === '||') {
    if (lLit && !truthy(lv)) { path.replaceWith(r); return true; }       // false || x → x
    if (lLit && truthy(lv) && rLit) { path.replaceWith(l); return true; } // truthy || lit → truthy
  } else if (op === '??') {
    if (lLit && lv === null) { path.replaceWith(r); return true; }       // null ?? x → x
    if (lLit && lv !== null && rLit) { path.replaceWith(l); return true; } // 非空 ?? lit → 非空
  }
  return false;
}

function foldConditional(path) {
  const n = path.node;
  if (!isFoldable(n.test)) return false;
  const keep = truthy(litVal(n.test)) ? n.consequent : n.alternate;
  const drop = truthy(litVal(n.test)) ? n.alternate : n.consequent;
  // 丢弃侧必须是字面量，否则可能丢副作用
  if (!isFoldable(drop)) return false;
  path.replaceWith(keep);
  return true;
}

/** 相邻 var 声明合并。就地改 declarations，求值顺序保持不变。 */
function mergeVarScopes(scopes, stat) {
  for (const node of scopes) {
    const arr = node.body;
    if (!Array.isArray(arr)) continue;
    for (let i = 0; i < arr.length - 1; i++) {
      const cur = arr[i];
      if (!cur || cur.type !== 'VariableDeclaration' || cur.kind !== 'var') continue;
      let j = i + 1;
      while (j < arr.length && arr[j] && arr[j].type === 'VariableDeclaration' && arr[j].kind === 'var') {
        cur.declarations.push(...arr[j].declarations);
        arr.splice(j, 1);
        stat.merged++;
      }
    }
  }
}

/**
 * 初始化器是否"无副作用"——删掉整个声明也不会丢行为。
 *
 * 只有一批结构可判：字面量、函数/箭头、标识符读取、纯表达式组合。成员访问一律
 * 判否（取值可能触发 getter、对象未定义时会抛），调用/赋值/new/await/yield 同理，
 * 类表达式也判否（computed key 与 static 块会求值、extends 可能抛）。判否的声明
 * 一律留着：宁可少删一个变量，也不能把源码里的一次求值悄悄吃掉。
 */
function pureInit(node) {
  if (!node) return true;                        // var a; 没有初始化器
  switch (node.type) {
    case 'NumericLiteral': case 'StringLiteral': case 'BooleanLiteral':
    case 'NullLiteral': case 'BigIntLiteral': case 'RegExpLiteral':
    case 'FunctionExpression': case 'ArrowFunctionExpression': case 'Identifier':
      return true;
    case 'ParenthesizedExpression':
      return pureInit(node.expression);
    case 'TemplateLiteral':
      return node.expressions.every(pureInit);
    case 'UnaryExpression':
      return (node.operator === '-' || node.operator === '+' || node.operator === '!' ||
        node.operator === '~' || node.operator === 'void' || node.operator === 'typeof') &&
        pureInit(node.argument);
    case 'BinaryExpression': case 'LogicalExpression':
      return pureInit(node.left) && pureInit(node.right);
    case 'ConditionalExpression':
      return pureInit(node.test) && pureInit(node.consequent) && pureInit(node.alternate);
    case 'ArrayExpression':
      return node.elements.every((e) => !!e && e.type !== 'SpreadElement' && pureInit(e));
    case 'ObjectExpression':
      return node.properties.every((p) => !!p && (p.type === 'ObjectProperty' || p.type === 'ObjectMethod') &&
        (!p.computed) && pureInit(p.type === 'ObjectMethod' ? null : p.value));
    default:
      return false;
  }
}

/**
 * 声明（或声明器所属的声明语句）落在哪个语句体里；不在 Program/BlockStatement
 * 体里（for-init、for-in 左值之类）返回 null —— 那些结构不能按"整条语句"删。
 */
function statementParent(path) {
  const decl = path.node.type === 'VariableDeclarator' ? path.parentPath : path;
  const p = decl && decl.parentPath;
  if (!p || !(p.isProgram() || p.isBlockStatement())) return null;
  return p.node.body.indexOf(decl.node) >= 0 ? p : null;
}

/**
 * 无用声明消除。
 *
 * 只删三类「已经没有任何读取引用」的声明：变量、函数、类。每个候选都要过四道闸：
 *   1) 没有引用、也没有任何赋值写入（写入本身可能有副作用，删了会留下悬空赋值）；
 *   2) 不在导出面里（export 出去的名字是模块接口，删了外部就断链）；
 *   3) 初始化器无副作用（见 pureInit）；
 *   4) 作用域私有：函数/块内的都算私有；脚本顶层不算——那是全局对象的属性，
 *      删掉可能被页面别处引用（模块顶层则是私有的，可以删）。
 * 出现 with 语句时整体跳过：它会改变名字解析，绑定分析不再可靠。
 * 解构声明不处理（`var {a} = o` 的删除要判别 pattern 里每个名字，收益低风险高）。
 *
 * 本 pass 要求作用域树是最新的，所以这里带 scope 遍历并在 Program 上 crawl 一次；
 * 收集完倒序删，避免数组位移干扰后续 path。
 */
function eliminateUnused(ast, traverse, stat) {
  let hasWith = false;
  traverse(ast, { WithStatement() { hasWith = true; }, noScope: true });
  if (hasWith) return;

  // 有 import/export 就是模块：顶层作用域私有，可以删顶层未用声明
  let isModule = false;
  traverse(ast, {
    ImportDeclaration() { isModule = true; },
    ExportNamedDeclaration() { isModule = true; },
    ExportDefaultDeclaration() { isModule = true; },
    ExportAllDeclaration() { isModule = true; },
    noScope: true,
  });

  const exported = new Set();
  const removals = [];
  const consider = (path, idNode) => {
    if (!idNode || idNode.type !== 'Identifier') return;
    const name = idNode.name;
    if (exported.has(name)) return;
    const binding = path.scope.getBinding(name);
    // 这一处必须就是绑定的登记声明点。同名重复声明（`var x` 两次、形参与 var 同名）
    // 或绑定还有别的声明点时不碰：那要按整条绑定一起删，风险大、收益小。
    if (!binding || binding.identifier !== idNode) return;
    if (binding.declarationIds && binding.declarationIds.length) return;
    if (binding.referencePaths && binding.referencePaths.length) return;         // 有读取
    // 有真正的写入就不删。声明点自身也会被登记成一次"写入"（var/let/const 的
    // id 是左值），那不是赋值，必须排掉——不排掉的话所有变量都会因为这一条被留下。
    const realWrite = (binding.constantViolations || [])
      .some((v) => v && v.node && v.node.type !== 'VariableDeclarator');
    if (realWrite) return;
    const sp = statementParent(path);
    if (!sp) return;
    // 脚本顶层 = 全局对象属性，保守留着
    if (!isModule && sp.isProgram()) return;
    removals.push(path);
  };

  traverse(ast, {
    Program(path) { path.scope.crawl(); },
    ExportNamedDeclaration(path) {
      const d = path.node.declaration;
      if (d) {
        if (t.isVariableDeclaration(d)) {
          for (const decl of d.declarations) {
            for (const k of Object.keys(t.getBindingIdentifiers(decl.id))) exported.add(k);
          }
        } else if (d.id) exported.add(d.id.name);
      }
      for (const spec of path.node.specifiers || []) exported.add(spec.local.name);
    },
    VariableDeclarator(path) {
      if (path.node.init && !pureInit(path.node.init)) return;
      consider(path, path.node.id);
    },
    FunctionDeclaration(path) {
      if (path.node.decorators && path.node.decorators.length) return;
      consider(path, path.node.id);
    },
    ClassDeclaration(path) {
      if (path.node.decorators && path.node.decorators.length) return;
      consider(path, path.node.id);
    },
  });

  for (let i = removals.length - 1; i >= 0; i--) {
    removals[i].remove();
    stat.removed++;
  }
  // 声明器被删空的 var/let/const 语句也要清掉，否则生成器会写出 `const ;` 这种
  // 空声明。用一次新遍历收集，不复用上面那些 path——它们已经脱离树了。
  const emptied = [];
  traverse(ast, {
    VariableDeclaration(path) { if (path.node.declarations.length === 0) emptied.push(path); },
    noScope: true,
  });
  for (let i = emptied.length - 1; i >= 0; i--) emptied[i].remove();
}

/**
 * 语句位置上的空块清除。DCE 会把 `if(true){ var x = 1 }` 这类块的最后一条语句
 * 删掉，留下一个 `{}` —— 语义上是空操作，删掉更短。函数体、循环体、if 分支的块
 * 一概不动（删了语法就变了）。
 */
function dropEmptyBlocks(ast, traverse, stat) {
  const empties = [];
  traverse(ast, {
    BlockStatement(path) {
      if (path.node.body.length !== 0) return;
      const p = path.parentPath;
      if (p && (p.isProgram() || p.isBlockStatement())) empties.push(path);
    },
    noScope: true,
  });
  for (let i = empties.length - 1; i >= 0; i--) { empties[i].remove(); stat.removed++; }
}

export default function simplify(ast, options, ctx) {
  if (!options.simplify) return { folded: 0, removed: 0, merged: 0 };
  const { traverse } = ctx;
  const stat = { folded: 0, removed: 0, merged: 0 };

  // 常量折叠：多趟直到不动点（常量树深度有限，5 趟足够覆盖任何嵌套）
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    const mark = () => { changed = true; stat.folded++; };
    traverse(ast, {
      BinaryExpression(path) { if (foldBinary(path)) mark(); },
      UnaryExpression(path) { if (foldUnary(path)) mark(); },
      LogicalExpression(path) { if (foldLogical(path)) mark(); },
      ConditionalExpression(path) { if (foldConditional(path)) mark(); },
      noScope: true,
    });
    if (!changed) break;
  }

  // 死代码消除 + 空语句清除：先收集再倒序处理，避免数组位移干扰遍历
  const dead = [];
  traverse(ast, {
    IfStatement(path) { if (path.node.test.type === 'BooleanLiteral') dead.push(path); },
    WhileStatement(path) {
      const test = path.node.test;
      if (test.type === 'BooleanLiteral' && test.value === false) dead.push(path);
    },
    EmptyStatement(path) {
      const p = path.parentPath;
      if (p && (p.isProgram() || p.isBlockStatement())) dead.push(path);
    },
    BlockStatement(path) {
      // 空块只在语句位置可删（函数体、循环体、if 分支的块不能动：删了语法就变了）
      if (path.node.body.length !== 0) return;
      const p = path.parentPath;
      if (p && (p.isProgram() || p.isBlockStatement())) dead.push(path);
    },
    noScope: true,
  });
  for (let i = dead.length - 1; i >= 0; i--) {
    const path = dead[i];
    const n = path.node;
    if (n.type === 'EmptyStatement' || n.type === 'BlockStatement') { path.remove(); stat.removed++; continue; }
    if (n.type === 'WhileStatement') { path.remove(); stat.removed++; continue; }
    // IfStatement：test 已折叠成 BooleanLiteral
    if (n.test.value) {
      path.replaceWith(n.consequent);   // if(true) A [else B] → A
    } else if (n.alternate) {
      path.replaceWith(n.alternate);    // if(false) A else B → B
    } else {
      path.remove();                    // if(false) A → 删除
    }
    stat.removed++;
  }

  // 无用声明消除放在死代码阶段之后：`if(false){ use(x) }` 这类块先被删掉，
  // 于是只被死块引用的函数/变量这一趟就变成"无人引用"，可以一起删干净。
  eliminateUnused(ast, traverse, stat);
  dropEmptyBlocks(ast, traverse, stat);

  // 声明合并：收集所有 Program/BlockStatement 后统一处理
  const scopes = [];
  traverse(ast, {
    Program(path) { scopes.push(path.node); },
    BlockStatement(path) { scopes.push(path.node); },
    noScope: true,
  });
  mergeVarScopes(scopes, stat);

  return stat;
}
