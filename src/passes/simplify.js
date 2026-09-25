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
 *     A else B 这类直接换成保留下来的那一支。被删块**永不执行**，删除不改变任何
 *     可观察行为；替换时**保留 block 原样**（不展开 body），let/const/class 的块
 *     作用域不变。
 *   空语句清除 —— 只清 Program / BlockStatement 体内的空语句，循环体/if 体的
 *     `;` 必须保留（for(;;); 删了会变语法错误）。
 *   声明合并 —— 相邻的 `var a; var b;` 并成 `var a,b;`（初始化器求值顺序不变）。
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
    noScope: true,
  });
  for (let i = dead.length - 1; i >= 0; i--) {
    const path = dead[i];
    const n = path.node;
    if (n.type === 'EmptyStatement') { path.remove(); stat.removed++; continue; }
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
