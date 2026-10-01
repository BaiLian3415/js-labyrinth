import keys from './keys.js';
const { VISITOR_KEYS } = keys;
import i18n from '../i18n.js';
const { t: msg } = i18n;
/**
 * 自研 AST 到代码的生成器，接口取 @babel/generator 的子集。
 * 默认输出紧凑单行代码，不额外插空格与换行，产物体积优先。
 * 括号按运算符优先级补，数字优先沿用 node.extra.raw 里的原始进制写法，
 * escapeNonAscii 打开时把非 ASCII 字符转成转义序列。
 */

// 表达式优先级，数字越大结合得越紧
const PREC = {
  Sequence: 0,
  Assignment: 1,
  Conditional: 2, // ?:
  LogicalOR: 3,   // ||
  LogicalNullish: 4, // ??
  LogicalAND: 5,  // &&
  BitwiseOR: 6,
  BitwiseXOR: 7,
  BitwiseAND: 8,
  Equality: 9,
  Relational: 10,
  Shift: 11,
  Additive: 12,
  Multiplicative: 13,
  Exponent: 14,
  Unary: 15,
  Update: 16,
  Call: 17,
  Member: 18,
  Primary: 19,
};

const OP_PREC = {
  '||': PREC.LogicalOR, '??': PREC.LogicalNullish, '&&': PREC.LogicalAND,
  '|': PREC.BitwiseOR, '^': PREC.BitwiseXOR, '&': PREC.BitwiseAND,
  '==': PREC.Equality, '!=': PREC.Equality, '===': PREC.Equality, '!==': PREC.Equality,
  '<': PREC.Relational, '>': PREC.Relational, '<=': PREC.Relational, '>=': PREC.Relational,
  'instanceof': PREC.Relational, 'in': PREC.Relational,
  '<<': PREC.Shift, '>>': PREC.Shift, '>>>': PREC.Shift,
  '+': PREC.Additive, '-': PREC.Additive,
  '*': PREC.Multiplicative, '/': PREC.Multiplicative, '%': PREC.Multiplicative,
  '**': PREC.Exponent,
};

// 同级运算符里右结合的那些，决定右侧子表达式要不要补括号
const RIGHT_ASSOC = new Set(['**', '=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '>>>=', '|=', '^=', '&=', '**=', '&&=', '||=', '??=']);

/**
 * 字符串字面量是否需要转义的快速判定。
 *
 * 默认模式只转义双引号、反斜杠与 C0 控制字符（含 \0 \b \t \n \v \f \r）；
 * escapeNonAscii 打开时额外转义 0x7f 及以上（含代理对的两半）。
 *
 * 这两个正则只用于"整串扫一遍、无命中就免去逐字符处理"的快速判定，真正的转义
 * 仍走 _escapeString 的慢路径，两边判据必须一致：
 *   慢路径转义条件 = 字符是 " 或 \ 或 cp < 0x20，或（escapeNonAscii 且 cp > 0x7e）
 * 注意 0x7e（~）在两种模式下都不转义，所以宽判定的下界是 0x7f。
 */
const NEEDS_ESCAPE_ASCII = /["\\\u0000-\u001f]/;
const NEEDS_ESCAPE_WIDE = /["\\\u0000-\u001f\u007f-\uffff]/;

/**
 * 表达式打印出来之后的末字符，只有后缀自增自减会产出 + 或 -。
 * 二元运算符与操作数都带同样的符号时，中间必须补空格，否则 a++ + ++a 会粘成
 * a+++++a、a - -b 会粘成 a--b，两种都过不了词法分析。
 */
function trailingSign(node) {
  if (node && node.type === 'UpdateExpression' && !node.prefix) return node.operator[0];
  return '';
}

/** 表达式打印出来之后的首字符，只有前缀一元运算与前缀自增自减会产出 + 或 -。 */
function leadingSign(node) {
  if (!node) return '';
  if (node.type === 'UnaryExpression' && (node.operator === '+' || node.operator === '-')) return node.operator;
  if (node.type === 'UpdateExpression' && node.prefix) return node.operator[0];
  return '';
}

class Generator {
  constructor(options) {
    this.options = options || {};
    this.compact = this.options.compact !== false;
    this.escapeNonAscii = !!this.options.escapeNonAscii;
    this.indent = options && options.indent !== undefined ? options.indent : 2;
    // keepRaw：命中「不混淆项」名单的文本原样写出，不做 \uXXXX 转义。
    //
    // escapeNonAscii 的四个预设都是开的，它会把非 ASCII 一律转义——包括那些用户
    // 点名要保留的名字。名字确实没被改名（排除是生效的），但产物里写成
    // \u8ba4\u8bc1\u4ee4\u724c，用户按中文去 grep 一个字都搜不到，于是合理地判断
    // 「勾了没效果」。这里的取舍是：显式勾选优先于通用转义开关，勾了就把原文
    // 写出来。代价是产物文本含非 ASCII 字节（与 escapeNonAscii:false 同样的前提：
    // 文件必须按 UTF-8 提供/解析，页面要有 charset 声明）。
    this.keepRaw = typeof this.options.keepRaw === 'function' ? this.options.keepRaw : null;
    this._depth = 0; // 当前缩进层级，非紧凑模式才用得上
    this._out = '';
  }

  _s(s) { if (s) this._out += s; }

  /** 非紧凑模式下换行并补当前层级的缩进，已经在行首时只调整缩进，不重复换行。 */
  _nl() {
    if (this.compact) return;
    const want = this._depth * this.indent;
    // 从末尾往前跳过空格，就能判断是不是停在行首
    let i = this._out.length;
    while (i > 0 && this._out[i - 1] === ' ') i--;
    if (i === 0 || this._out[i - 1] === '\n') {
      // 停在行首，把旧缩进换成当前深度的
      this._out = this._out.slice(0, i) + ' '.repeat(want);
      return;
    }
    this._out += '\n' + ' '.repeat(want);
  }

  _str(expr, minPrec, side) {
    const prec = this._exprPrec(expr);
    let needParen = prec < minPrec;
    // 优先级相同就要看结合性：右结合运算符出现在左侧、左结合运算符出现在右侧时
    // 必须补括号，否则重解析出的结合顺序会反过来。** 是唯一的右结合二元运算符，
    // (23)2 漏了括号会变成 2(32)。
    if (!needParen && prec === minPrec && side) {
      const rightAssoc = expr.type === 'AssignmentExpression' || RIGHT_ASSOC.has(expr.operator);
      needParen = side === 'right' ? !rightAssoc : rightAssoc;
    }
    if (needParen) this._s('(');
    this._node(expr);
    if (needParen) this._s(')');
  }

  _exprPrec(node) {
    if (!node) return PREC.Primary;
    switch (node.type) {
      case 'SequenceExpression': return PREC.Sequence;
      case 'AssignmentExpression': return PREC.Assignment;
      case 'ConditionalExpression': return PREC.Conditional;
      case 'LogicalExpression':
        return node.operator === '??' ? PREC.LogicalNullish : node.operator === '||' ? PREC.LogicalOR : PREC.LogicalAND;
      case 'BinaryExpression': return OP_PREC[node.operator] || PREC.Primary;
      case 'UnaryExpression': return PREC.Unary;
      case 'UpdateExpression': return PREC.Update;
      case 'CallExpression': case 'OptionalCallExpression': return PREC.Call;
      case 'NewExpression': return PREC.Member;
      case 'MemberExpression': case 'OptionalMemberExpression': return PREC.Member;
      case 'YieldExpression': case 'AwaitExpression': return PREC.Unary;
      case 'SpreadElement': case 'RestElement': return PREC.Unary;
      // 箭头函数的语法层级是赋值表达式，本身不是原子表达式。
      // 当成 Primary 会让 () => {} instanceof F、!() => {} 这类写法丢掉必需的括号，
      // 重解析时要么结合错，要么直接语法错误。函数与类表达式是原子表达式，不受影响。
      case 'ArrowFunctionExpression': return PREC.Assignment;
      default: return PREC.Primary;
    }
  }

  generate(node) {
    this._out = '';
    if (node && node.type === 'File') node = node.program;
    this._node(node);
    // 非紧凑模式补一个收尾换行，与 Babel 的输出习惯一致
    if (!this.compact) this._s('\n');
    return this._out;
  }

  _node(node) {
    if (!node) return;
    switch (node.type) {
      case 'Program': this._program(node); break;
      case 'BlockStatement': this._blockStatement(node); break;
      case 'Directive': this._directive(node); break;
      // 语句
      case 'ExpressionStatement': this._expressionStatement(node); break;
      case 'VariableDeclaration': this._variableDeclaration(node); break;
      case 'VariableDeclarator': this._variableDeclarator(node); break;
      case 'IfStatement': this._ifStatement(node); break;
      case 'ForStatement': this._forStatement(node); break;
      case 'ForInStatement': this._forInStatement(node); break;
      case 'ForOfStatement': this._forOfStatement(node); break;
      case 'WhileStatement': this._whileStatement(node); break;
      case 'DoWhileStatement': this._doWhileStatement(node); break;
      case 'SwitchStatement': this._switchStatement(node); break;
      case 'SwitchCase': this._switchCase(node); break;
      case 'BreakStatement': this._breakStatement(node); break;
      case 'ContinueStatement': this._continueStatement(node); break;
      case 'ReturnStatement': this._returnStatement(node); break;
      case 'ThrowStatement': this._throwStatement(node); break;
      case 'TryStatement': this._tryStatement(node); break;
      case 'CatchClause': this._catchClause(node); break;
      case 'DebuggerStatement': this._debuggerStatement(); break;
      case 'LabeledStatement': this._labeledStatement(node); break;
      case 'WithStatement': this._withStatement(node); break;
      case 'EmptyStatement': this._stmtEnd(); break;
      case 'FunctionDeclaration': this._functionDeclaration(node); break;
      case 'ClassDeclaration': this._classDeclaration(node); break;
      case 'ImportDeclaration': this._importDeclaration(node); break;
      case 'ExportNamedDeclaration': this._exportNamedDeclaration(node); break;
      case 'ExportDefaultDeclaration': this._exportDefaultDeclaration(node); break;
      case 'ExportAllDeclaration': this._exportAllDeclaration(node); break;
      case 'Identifier': {
        const nm = node.name;
        if (!nm || typeof nm !== 'string') {
          throw new TypeError(msg('generatorMissingName'));
        }
        // 名字以数字开头只可能来自配置错误，比如前缀被写成了 0x。
        // 这种产物一旦生成就是坏语法，宁可在生成期直接报错，也不要静默写出去。
        if (/^[0-9]/.test(nm)) {
          throw new Error(msg('generatorBadIdentifier', { nm }));
        }
        this._s(this._escapeIdent(nm));
        break;
      }
      case 'StringLiteral': this._stringLiteral(node); break;
      case 'NumericLiteral': this._numericLiteral(node); break;
      case 'BooleanLiteral': this._s(node.value ? 'true' : 'false'); break;
      case 'NullLiteral': this._s('null'); break;
      case 'RegExpLiteral': this._s('/' + node.pattern + '/' + (node.flags || '')); break;
      case 'BigIntLiteral': this._s(node.value + 'n'); break;
      // Decimal（提案阶段的十进制字面量，1.5m 那种）。parser 不产出它，
      // keys.js / types.js 声明了它，所以谁要是真拿 t.decimalLiteral() 造一个，
      // 这里必须能打印出来——原先漏了这个 case，节点会落到 default 静默打印成空串。
      case 'DecimalLiteral': this._s(node.extra && node.extra.raw ? node.extra.raw : String(node.value) + 'm'); break;
      case 'TemplateLiteral': this._templateLiteral(node); break;
      case 'TaggedTemplateExpression': this._taggedTemplate(node); break;
      case 'ThisExpression': this._s('this'); break;
      case 'Super': this._s('super'); break;
      case 'ArrayExpression': this._arrayExpression(node); break;
      case 'ObjectExpression': this._objectExpression(node); break;
      case 'ObjectProperty': this._objectProperty(node); break;
      case 'ObjectMethod': this._objectMethod(node); break;
      case 'FunctionExpression': this._functionExpression(node); break;
      case 'ArrowFunctionExpression': this._arrowFunction(node); break;
      case 'ClassExpression': this._classExpression(node); break;
      case 'UnaryExpression': this._unaryExpression(node); break;
      case 'UpdateExpression': this._updateExpression(node); break;
      case 'BinaryExpression': this._binaryExpression(node); break;
      case 'LogicalExpression': this._binaryExpression(node); break; // 打印方式与 binary 相同
      case 'AssignmentExpression': this._assignmentExpression(node); break;
      case 'ConditionalExpression': this._conditionalExpression(node); break;
      case 'CallExpression': this._callExpression(node); break;
      case 'OptionalCallExpression': this._callExpression(node); break;
      case 'NewExpression': this._newExpression(node); break;
      case 'MemberExpression': this._memberExpression(node); break;
      case 'OptionalMemberExpression': this._memberExpression(node); break;
      case 'SequenceExpression': this._sequenceExpression(node); break;
      case 'SpreadElement': this._s('...'); this._node(node.argument); break;
      case 'RestElement': this._s('...'); this._node(node.argument); break;
      case 'AssignmentPattern': this._node(node.left); this._s('='); this._node(node.right); break;
      case 'ObjectPattern': this._objectExpression(node); break;
      case 'ArrayPattern': this._arrayExpression(node); break;
      case 'YieldExpression': this._yieldExpression(node); break;
      case 'AwaitExpression': this._s('await '); this._node(node.argument); break;
      case 'ParenthesizedExpression': this._s('('); this._node(node.expression); this._s(')'); break;
      case 'MetaProperty': this._s(node.meta.name + '.' + node.property.name); break;
      case 'Import': this._s('import'); break;
      case 'PrivateName': this._s('#'); this._node(node.id); break;
      case 'ClassBody': this._classBody(node); break;
      case 'ClassMethod': this._classMethod(node); break;
      case 'ClassProperty': this._classProperty(node); break;
      case 'StaticBlock': this._staticBlock(node); break;
      case 'ImportSpecifier': this._importSpecifier(node); break;
      case 'ImportDefaultSpecifier': this._s(node.local.name); break;
      case 'ImportNamespaceSpecifier': this._s('* as ' + node.local.name); break;
      case 'ExportSpecifier': this._exportSpecifier(node); break;
      default:
        // 不静默吞掉未知节点类型。原先是 break，于是任何没写 case 的节点都会
        // 打印成空串：产物仍能解析、仍能跑，只是少了一块代码——正是本项目最怕的
        // 那类「静默产出错代码」缺陷（README「已知问题」里记的两个都是这一类）。
        // 抛出来能让它在构建期就变成一次明确的失败。
        throw new Error('generator: 未实现的节点类型 ' + node.type);
    }
  }

  _sep() { this._s(this.compact ? '' : ' '); }

  /** 写语句结尾的分号，非紧凑模式下再接一个换行缩进 */
  _stmtEnd() { this._s(';'); if (!this.compact) this._nl(); }

  _program(node) {
    for (const d of node.directives || []) this._node(d);
    for (let i = 0; i < node.body.length; i++) {
      if (i > 0 || (node.directives || []).length > 0) this._nl();
      this._node(node.body[i]);
    }
  }

  _directive(node) {
    this._stringLiteral(node.value);
    this._stmtEnd();
  }

  _expressionStatement(node) {
    // 先把表达式渲染到独立缓冲，再决定要不要包括号。
    //
    // 不能渲染进主缓冲后回头改：那需要 this._out.slice(0, start) + '(' + this._out.slice(start)，
    // 每次都要复制整条已生成的输出，语句一多就是 O(n²)。实测在 6 KB 输入 / 424 KB 产物的
    // 中档配置下，这一处独占 24.7% 的总耗时（CPU profile 自耗时第一）。
    // 换成独立缓冲后，代价只与这一个表达式的长度成正比。
    const saved = this._out;
    this._out = '';
    this._node(node.expression);
    const exprOut = this._out;
    this._out = saved;

    // 语句首的花括号会被读成块语句，function/class 开头的表达式会被读成声明。
    // 对象字面量藏在成员访问、调用、序列表达式的左端时首字符同样是花括号，
    // 所以按实际产出的首字符判断，比逐个枚举节点类型可靠。
    const expr = node.expression;
    const leadBrace = exprOut[0] === '{';
    const isDeclLike = expr.type === 'FunctionExpression' || expr.type === 'ClassExpression';
    if (leadBrace || isDeclLike) this._out += '(' + exprOut + ')';
    else this._out += exprOut;
    this._stmtEnd();
  }

  _variableDeclaration(node, noSemi) {
    this._s(node.kind + ' ');
    for (let i = 0; i < node.declarations.length; i++) {
      if (i > 0) this._s(',');
      this._node(node.declarations[i]);
    }
    if (!noSemi) this._stmtEnd();
  }

  _variableDeclarator(node) {
    this._node(node.id);
    // 初始化表达式按赋值级优先级打印，序列表达式不加括号的话
    // const n=a,b,c 会被读成三个 declarator，后两个还没有初始化值
    if (node.init !== null) { this._sep(); this._s('='); this._sep(); this._str(node.init, PREC.Assignment); }
  }

  _ifStatement(node) {
    this._s('if(');
    this._node(node.test);
    this._s(')');
    // 有 alternate 时 consequent 不能是裸语句：分支交换类变换会把 else-if 链
    // 变成 consequent 为裸 if 的形态，打印成 if(a) if(b) X else Y 后，
    // 重新解析时 else 会绑到内层 if 上，语义就变了。套一层块把绑定固定下来，
    // 单条语句加块不改变执行结果。
    if (node.alternate && node.consequent.type !== 'BlockStatement') {
      this._blockStatement({ type: 'BlockStatement', body: [node.consequent] });
    } else {
      this._node(node.consequent);
    }
    if (node.alternate) {
      // 块可以紧贴 else，其它节点必须隔一个空格，否则 else 会和后面的标识符粘成一个词
      if (node.alternate.type === 'BlockStatement') this._s('else');
      else this._s('else ');
      this._node(node.alternate);
    }
  }

  _forStatement(node) {
    this._s('for(');
    if (node.init) {
      if (node.init.type === 'VariableDeclaration') this._variableDeclaration(node.init, true);
      else this._node(node.init);
    }
    this._s(';');
    if (node.test) this._node(node.test);
    this._s(';');
    if (node.update) this._node(node.update);
    this._s(')');
    this._node(node.body);
  }

  _forInStatement(node) {
    this._s('for(');
    if (node.left.type === 'VariableDeclaration') this._variableDeclaration(node.left, true);
    else this._node(node.left);
    this._s(' in ');
    // 右侧是赋值级，逗号表达式不补括号会被 for 读成额外的头部分句
    this._str(node.right, PREC.Assignment);
    this._s(')');
    this._node(node.body);
  }

  _forOfStatement(node) {
    // for await 的 await 在左括号外侧，写进括号里会产出
    // for(await const v of x) 这种非法形式，await 会被当成迭代目标的开头
    this._s('for');
    if (node.await) this._s(' await');
    this._s('(');
    if (node.left.type === 'VariableDeclaration') this._variableDeclaration(node.left, true);
    else this._node(node.left);
    this._s(' of ');
    // for-of 右侧只接受赋值表达式，逗号表达式必须补括号
    this._str(node.right, PREC.Assignment);
    this._s(')');
    this._node(node.body);
  }

  _whileStatement(node) {
    this._s('while(');
    this._node(node.test);
    this._s(')');
    this._node(node.body);
  }

  _doWhileStatement(node) {
    this._s('do');
    this._node(node.body);
    this._s('while(');
    this._node(node.test);
    this._s(');');
  }

  _switchStatement(node) {
    this._s('switch(');
    this._node(node.discriminant);
    this._s(')');
    if (node.cases.length === 0) { this._s('{}'); return; }
    this._s('{');
    this._depth++;
    for (const c of node.cases) { this._nl(); this._node(c); }
    this._depth--;
    this._nl();
    this._s('}');
  }

  _switchCase(node) {
    if (node.test) { this._s('case '); this._node(node.test); } else { this._s('default'); }
    this._s(':');
    if (node.consequent.length > 0) {
      this._depth++;
      for (const s of node.consequent) { this._nl(); this._node(s); }
      this._depth--;
    }
  }

  _breakStatement(node) {
    this._s('break');
    // 标签前必须留空格，紧凑模式下 _sep 是空串，不能拿它来补
    if (node.label) { this._s(' '); this._node(node.label); }
    this._stmtEnd();
  }

  _continueStatement(node) {
    this._s('continue');
    if (node.label) { this._s(' '); this._node(node.label); }
    this._stmtEnd();
  }

  _returnStatement(node) {
    this._s('return');
    if (node.argument) { this._s(' '); this._node(node.argument); }
    this._stmtEnd();
  }

  _throwStatement(node) {
    this._s('throw ');
    this._node(node.argument);
    this._stmtEnd();
  }

  _tryStatement(node) {
    this._s('try');
    this._node(node.block);
    if (node.handler) this._node(node.handler);
    if (node.finalizer) { this._s('finally'); this._node(node.finalizer); }
  }

  _catchClause(node) {
    this._s('catch');
    if (node.param) { this._s('('); this._node(node.param); this._s(')'); }
    this._node(node.body);
  }

  _debuggerStatement() {
    this._s('debugger');
    this._stmtEnd();
  }

  _labeledStatement(node) {
    this._node(node.label);
    this._s(':');
    this._node(node.body);
  }

  _withStatement(node) {
    this._s('with(');
    this._node(node.object);
    this._s(')');
    this._node(node.body);
  }

  _blockStatement(node) {
    if (node.body.length === 0 && !(node.directives || []).length) {
      this._s('{}');
      return;
    }
    this._s('{');
    this._depth++;
    for (const d of node.directives || []) { this._nl(); this._node(d); }
    for (let i = 0; i < node.body.length; i++) { this._nl(); this._node(node.body[i]); }
    this._depth--;
    this._nl();
    this._s('}');
  }

  _functionDeclaration(node) {
    if (node.async) this._s('async ');
    this._s('function');
    if (node.generator) this._s('*');
    if (node.id) { this._s(' '); this._node(node.id); this._s(' '); }
    this._s('(');
    for (let i = 0; i < node.params.length; i++) {
      if (i > 0) this._s(',');
      this._node(node.params[i]);
    }
    this._s(')');
    this._node(node.body);
  }

  _functionExpression(node) {
    if (node.async) this._s('async ');
    this._s('function');
    if (node.generator) this._s('*');
    if (node.id) { this._s(' '); this._node(node.id); this._s(' '); }
    this._s('(');
    for (let i = 0; i < node.params.length; i++) {
      if (i > 0) this._s(',');
      this._node(node.params[i]);
    }
    this._s(')');
    this._node(node.body);
  }

  _arrowFunction(node) {
    const single = node.params.length === 1 && node.params[0].type === 'Identifier';
    if (node.async) this._s('async ');
    if (single) {
      this._node(node.params[0]);
    } else {
      this._s('(');
      for (let i = 0; i < node.params.length; i++) {
        if (i > 0) this._s(',');
        this._node(node.params[i]);
      }
      this._s(')');
    }
    this._s('=>');
    if (node.body.type === 'BlockStatement') {
      this._node(node.body);
    } else if (node.body.type === 'ObjectExpression' || node.body.type === 'SequenceExpression') {
      // 这两种表达式体不套括号会被当成块语句或参数列表
      this._s('(');
      this._node(node.body);
      this._s(')');
    } else {
      this._node(node.body);
    }
  }

  _classDeclaration(node) {
    this._s('class');
    if (node.id) { this._s(' '); this._node(node.id); }
    if (node.superClass) { this._s(' extends '); this._node(node.superClass); }
    this._s(' ');
    this._node(node.body);
  }

  _classExpression(node) {
    this._s('class');
    if (node.id) { this._s(' '); this._node(node.id); }
    if (node.superClass) { this._s(' extends '); this._node(node.superClass); }
    this._s(' ');
    this._node(node.body);
  }

  _classBody(node) {
    if (node.body.length === 0) { this._s('{}'); return; }
    this._s('{');
    this._depth++;
    for (const m of node.body) { this._nl(); this._node(m); }
    this._depth--;
    this._nl();
    this._s('}');
  }

  _classMethod(node) {
    if (node.static) { this._s('static '); }
    if (node.kind === 'get' || node.kind === 'set') { this._s(node.kind + ' '); }
    if (node.async) { this._s('async '); }
    if (node.generator) { this._s('*'); }
    this._node(node.key);
    this._s('(');
    for (let i = 0; i < node.params.length; i++) {
      if (i > 0) this._s(',');
      this._node(node.params[i]);
    }
    this._s(')');
    this._node(node.body);
  }

  _classProperty(node) {
    if (node.static) { this._s('static '); }
    this._node(node.key);
    if (node.value !== null) { this._sep(); this._s('='); this._sep(); this._node(node.value); }
    this._stmtEnd();
  }

  _staticBlock(node) {
    this._s('static ');
    this._blockStatement(node);
  }

  _importDeclaration(node) {
    this._s('import');
    this._s(' ');
    if (node.specifiers.length > 0) {
      // 命名导入要包在花括号里，default 与命名空间说明符在外面，
      // 排列顺序固定为 default、命名、命名空间，如 import def, { a as b }, * as ns
      const named = [];
      let def = null;
      let ns = null;
      for (const spec of node.specifiers) {
        if (spec.type === 'ImportSpecifier') named.push(spec);
        else if (spec.type === 'ImportDefaultSpecifier') def = spec;
        else if (spec.type === 'ImportNamespaceSpecifier') ns = spec;
      }
      const parts = [];
      if (def) parts.push(def.local.name);
      if (named.length > 0) {
        parts.push('{' + named.map((spec) => {
          const imp = spec.imported.name;
          const loc = spec.local.name;
          return imp === loc ? imp : imp + ' as ' + loc;
        }).join(',') + '}');
      }
      if (ns) parts.push('* as ' + ns.local.name);
      this._s(parts.join(',') + ' from ');
    }
    this._s(JSON.stringify(node.source.value));
    this._stmtEnd();
  }

  _importSpecifier(node) {
    this._node(node.imported);
    this._s(' as ');
    this._node(node.local);
  }

  _exportNamedDeclaration(node) {
    this._s('export');
    if (node.declaration) {
      this._s(' ');
      this._node(node.declaration);
    } else {
      this._s(' ');
      this._s('{');
      for (let i = 0; i < node.specifiers.length; i++) {
        if (i > 0) this._s(',');
        this._node(node.specifiers[i]);
      }
      this._s('}');
      if (node.source) { this._s(' from '); this._s(JSON.stringify(node.source.value)); }
      this._stmtEnd();
    }
  }

  _exportDefaultDeclaration(node) {
    this._s('export default ');
    this._node(node.declaration);
    if (node.declaration.type !== 'FunctionDeclaration' && node.declaration.type !== 'ClassDeclaration') {
      this._stmtEnd();
    }
  }

  _exportAllDeclaration(node) {
    this._s('export * from ');
    this._s(JSON.stringify(node.source.value));
    this._stmtEnd();
  }

  _exportSpecifier(node) {
    this._node(node.local);
    if (node.exported !== node.local) { this._s(' as '); this._node(node.exported); }
  }

  _stringLiteral(node) {
    this._s(this._escapeString(node.value));
  }

  _escapeString(s) {
    // 快路径：整串不需要转义时直接拼接返回。
    //
    // 逐字符循环对短字符串无所谓，但外壳（shell）会把整个载荷的 base64 当成
    // 一个字符串字面量，动辄几 MB——那时逐字符的 switch + 拼接就是 500 万次迭代，
    // 实测占"递归混淆引导器"这一步耗时的 65.8%，也就是整个 shell 步骤的主要成本。
    // 正则扫描在原生代码里跑，量级上快得多；只有真的含需转义字符时才走慢路径。
    //
    // wide 与 escapeNonAscii 分开：命中 keepRaw 的串仍要按"非宽"规则转义引号与
    // 控制字符（否则字面量会坏掉），只是不再把非 ASCII 写成 \uXXXX。
    const wide = this.escapeNonAscii && !this._keepRaw(s);
    const re = wide ? NEEDS_ESCAPE_WIDE : NEEDS_ESCAPE_ASCII;
    if (!re.test(s)) return '"' + s + '"';

    let out = '"';
    for (let i = 0; i < s.length; i++) {
      const cp = s.charCodeAt(i);
      if (cp > 0x7e && wide) {
        out += '\\u' + cp.toString(16).padStart(4, '0');
        continue;
      }
      switch (s[i]) {
        case '"': out += '\\"'; break;
        case '\\': out += '\\\\'; break;
        case '\n': out += '\\n'; break;
        case '\r': out += '\\r'; break;
        case '\t': out += '\\t'; break;
        case '\b': out += '\\b'; break;
        case '\f': out += '\\f'; break;
        case '\v': out += '\\v'; break;
        // NUL 只能写成 \u0000。写成 \0 再跟数字会被当成八进制转义，
        // 严格模式下直接报错，非严格模式含义也变了。密文池里 NUL 后面
        // 正好接数字的情况是会出现的。
        case '\0': out += '\\u0000'; break;
        default:
          if (cp < 0x20) {
            out += '\\u' + cp.toString(16).padStart(4, '0');
          } else {
            out += s[i];
          }
      }
    }
    out += '"';
    return out;
  }

  /** 命中 keepRaw 名单（未配置时恒 false，零额外开销）。 */
  _keepRaw(text) {
    if (!this.keepRaw || typeof text !== 'string' || text === '') return false;
    return this.keepRaw(text) === true;
  }

  // escapeNonAscii 打开时把标识符里的非 ASCII 字符写成 \uXXXX，
  // 标识符位置的转义在语法上合法，var \u4e00 = 1 能正常解析。
  // 命中 keepRaw 的名字原样写出：用户就是要在产物里搜得到它。
  _escapeIdent(name) {
    if (!this.escapeNonAscii || this._keepRaw(name)) return name;
    let out = '';
    for (let i = 0; i < name.length; i++) {
      const cp = name.charCodeAt(i);
      out += cp > 0x7e ? '\\u' + cp.toString(16).padStart(4, '0') : name[i];
    }
    return out;
  }

  _numericLiteral(node) {
    if (node.extra && node.extra.raw) {
      this._s(node.extra.raw);
    } else {
      this._s(String(node.value));
    }
  }

  _templateLiteral(node) {
    this._s('`');
    for (let i = 0; i < node.quasis.length; i++) {
      this._s(this._escapeTemplate(node.quasis[i].value.cooked));
      if (i < node.expressions.length) {
        this._s('${');
        this._node(node.expressions[i]);
        this._s('}');
      }
    }
    this._s('`');
  }

  // 把模板段的 cooked 文本写回源码，反斜杠、反引号和 ${ 都要重新转义，
  // 否则解析时解码出的裸字符会再次被当成转义或插值。
  // escapeNonAscii 打开时连非 ASCII 与 \r 一起转义，模板内的换行本身合法，保持原样。
  // 命中 keepRaw 的整段同样只做语法必需的转义（反斜杠、反引号、\${、\r、行分隔符），
  // 不把非 ASCII 写成 \uXXXX——与字符串字面量同一口径。
  _escapeTemplate(s) {
    const wide = this.escapeNonAscii && !this._keepRaw(s);
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const cp = s.charCodeAt(i);
      if (cp > 0x7e && wide) {
        out += '\\u' + cp.toString(16).padStart(4, '0');
        continue;
      }
      switch (s[i]) {
        case '\\': out += '\\\\'; break;
        case '`': out += '\\`'; break;
        case '$':
          if (s[i + 1] === '{') { out += '\\${'; i++; break; }
          out += '$';
          break;
        case '\r': out += '\\r'; break;
        case '\u2028': out += '\\u2028'; break;
        case '\u2029': out += '\\u2029'; break;
        default: out += s[i];
      }
    }
    return out;
  }

  _taggedTemplate(node) {
    this._node(node.tag);
    this._templateLiteral(node.quasi);
  }

  _arrayExpression(node) {
    this._s('[');
    for (let i = 0; i < node.elements.length; i++) {
      if (i > 0) this._s(',');
      if (node.elements[i] === null) continue;
      // 元素之间的逗号是分隔符，序列表达式不加括号会被拆成多个元素
      this._str(node.elements[i], PREC.Assignment);
    }
    this._s(']');
  }

  _objectExpression(node) {
    this._s('{');
    for (let i = 0; i < node.properties.length; i++) {
      if (i > 0) this._s(',');
      this._node(node.properties[i]);
    }
    this._s('}');
  }

  _objectProperty(node) {
    if (node.computed) this._s('[');
    this._node(node.key);
    if (node.computed) this._s(']');
    if (node.shorthand) {
      // 带默认值的简写只在等号右边取值，等号左边的名字已经打过了
      if (node.value && node.value.type === 'AssignmentPattern') {
        this._s('=');
        this._node(node.value.right);
      }
      return;
    }
    this._s(':');
    // 属性值里的序列表达式要加括号，不然逗号会被读成属性分隔符
    this._str(node.value, PREC.Assignment);
  }

  _objectMethod(node) {
    if (node.kind === 'get' || node.kind === 'set') { this._s(node.kind + ' '); }
    if (node.async) { this._s('async '); }
    if (node.generator) { this._s('*'); }
    if (node.computed) this._s('[');
    this._node(node.key);
    if (node.computed) this._s(']');
    this._s('(');
    for (let i = 0; i < node.params.length; i++) {
      if (i > 0) this._s(',');
      this._node(node.params[i]);
    }
    this._s(')');
    this._node(node.body);
  }

  _unaryExpression(node) {
    const op = node.operator;
    this._s(op);
    const needSpace = op === 'typeof' || op === 'void' || op === 'delete' || op === 'await';
    if (needSpace) this._s(' ');
    // 两个相同的 +/- 挨在一起会粘成 -- 或 ++，中间补一个空格
    if (node.argument.type === 'UnaryExpression' && (op === '-' || op === '+') && node.argument.operator === op) {
      this._s(' ');
    }
    if (node.prefix && (op === '++' || op === '--')) {
      this._str(node.argument, PREC.Update, 'left');
    } else {
      this._str(node.argument, PREC.Unary, 'right');
    }
  }

  _updateExpression(node) {
    if (node.prefix) {
      this._s(node.operator);
      this._str(node.argument, PREC.Update, 'right');
    } else {
      this._str(node.argument, PREC.Update, 'left');
      this._s(node.operator);
    }
  }

  _binaryExpression(node) {
    const prec = OP_PREC[node.operator] || PREC.Assignment;
    const isExp = node.operator === '**';
    // in 和 instanceof 是单词运算符，紧凑模式也得留空格，不然会和操作数连成一个词
    const sep = (this.compact && node.operator !== 'in' && node.operator !== 'instanceof')
      ? '' : ' ';
    // ?? 不能与 || / && 直接相邻。?? 的优先级高于 || 却低于 &&，
    // 靠优先级挡不住 (a??b)||c 与 (a&&b)??c 这两个方向，只能在这里单独判。
    const nullishMix = (a, b) =>
      (a === '??' && (b === '||' || b === '&&')) || ((a === '||' || a === '&&') && b === '??');
    const leftMix = node.left.type === 'LogicalExpression' && nullishMix(node.operator, node.left.operator);
    const rightMix = node.right.type === 'LogicalExpression' && nullishMix(node.operator, node.right.operator);
    if (leftMix) this._s('(');
    // 指数运算符的左侧不许出现一元表达式，(-2)**2 去掉括号会变成语法错误
    const unaryLeft = isExp && node.left.type === 'UnaryExpression';
    if (unaryLeft) this._s('(');
    this._str(node.left, prec, 'left');
    if (unaryLeft) this._s(')');
    if (leftMix) this._s(')');
    // a++ + ++a、a - -b 这类写法，运算符与操作数之间必须留一个空格
    if (sep === '' && trailingSign(node.left) === node.operator[0]) this._s(' ');
    this._s(sep);
    this._s(node.operator);
    this._s(sep);
    if (sep === '' && leadingSign(node.right) === node.operator[node.operator.length - 1]) this._s(' ');
    if (rightMix) this._s('(');
    this._str(node.right, prec, 'right');
    if (rightMix) this._s(')');
  }

  _assignmentExpression(node) {
    // 解构赋值要包住整个赋值表达式，写成 ({a} = b) 才合法。
    // 只包模式那一半会变成对对象字面量赋值，V8 会报 Invalid left-hand side in assignment。
    const leftIsPattern = node.left && (node.left.type === 'ObjectPattern' || node.left.type === 'ArrayPattern');
    if (leftIsPattern) this._s('(');
    this._str(node.left, PREC.Assignment, 'left');
    this._sep();
    this._s(node.operator);
    this._sep();
    this._str(node.right, PREC.Assignment, 'right');
    if (leftIsPattern) this._s(')');
  }

  _conditionalExpression(node) {
    // test 位置的最低优先级是 ||，条件表达式本身落在这一层就会结合错：
    // (1?2:3)?4:5 不加括号会打印成 1?2:3?4:5，读回去变成 1?2:(3?4:5)
    this._str(node.test, PREC.LogicalOR, 'left');
    this._s('?');
    // consequent 不允许出现逗号表达式，alternate 允许右嵌套，
    // 两者的最低优先级都是赋值，统一按赋值级打印
    this._str(node.consequent, PREC.Assignment);
    this._s(':');
    this._str(node.alternate, PREC.Assignment);
  }

  _callExpression(node) {
    // 这三种表达式当 callee 时必须自己带括号：函数与类不加会被读成声明，
    // 箭头函数体后直接跟 () 本身就非法，()=>{}() 和 async()=>{}() 都过不了
    const callee = node.callee;
    if (callee && (callee.type === 'FunctionExpression' || callee.type === 'ClassExpression' || callee.type === 'ArrowFunctionExpression')) {
      this._s('(');
      this._node(callee);
      this._s(')');
    } else {
      this._str(callee, PREC.Call, 'left');
    }
    // 可选调用必须保留 ?.，丢掉就退化成普通调用，被调用值为 null 或 undefined
    // 时不再短路，直接抛 TypeError。a?.b() 与 a?.b?.() 的区别就在这一位
    if (node.optional) this._s('?.');
    this._s('(');
    for (let i = 0; i < node.arguments.length; i++) {
      if (i > 0) this._s(',');
      // 实参也要过优先级检查，序列表达式不加括号的话，
      // 里面的逗号会被读成参数分隔符
      this._str(node.arguments[i], PREC.Assignment);
    }
    this._s(')');
  }

  _newExpression(node) {
    this._s('new ');
    // callee 是这三种表达式时自己带括号，否则 new 的作用范围会跑偏
    const callee = node.callee;
    if (callee && (callee.type === 'FunctionExpression' || callee.type === 'ClassExpression' || callee.type === 'ArrowFunctionExpression')) {
      this._s('(');
      this._node(callee);
      this._s(')');
    } else {
      this._str(callee, PREC.Member, 'left');
    }
    this._s('(');
    for (let i = 0; i < node.arguments.length; i++) {
      if (i > 0) this._s(',');
      this._str(node.arguments[i], PREC.Assignment);
    }
    this._s(')');
  }

  _memberExpression(node) {
    // object 是这三种表达式时自己带括号，()=>{}.x 和 function(){}.x 都非法
    const obj = node.object;
    if (obj && (obj.type === 'FunctionExpression' || obj.type === 'ClassExpression' || obj.type === 'ArrowFunctionExpression')) {
      this._s('(');
      this._node(obj);
      this._s(')');
    } else {
      this._str(obj, PREC.Member, 'left');
    }
    if (node.computed) {
      this._s('[');
      this._node(node.property);
      this._s(']');
    } else {
      if (node.optional) this._s('?.');
      else this._s('.');
      this._node(node.property);
    }
  }

  _sequenceExpression(node) {
    for (let i = 0; i < node.expressions.length; i++) {
      if (i > 0) this._s(',');
      // 元素处在赋值级：箭头函数无需补括号，但嵌套的逗号表达式必须补，
      // 否则内层的逗号会被读成本层元素的分隔符
      this._str(node.expressions[i], PREC.Assignment);
    }
  }

  _yieldExpression(node) {
    this._s('yield');
    if (node.delegate) this._s('*');
    if (node.argument) { this._s(' '); this._node(node.argument); }
  }
}

function generate(ast, options) {
  const g = new Generator(options);
  const code = g.generate(ast);
  return { code };
}

export default generate;
