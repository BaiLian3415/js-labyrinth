import t from '../ast/types.js';
import rand from '../utils/rand.js';
import { uniqueCJKName } from '../utils/cjk.js';
import {
  createNamePool, isChineseNaming, wantsPropertyRename,
} from '../utils/naming.js';
const { uniqueName } = rand;
/**
 * 属性名重命名（对标 obfuscator.io 的 safe 模式）。
 *
 * 开不开由独立布尔项 `renameProperties` 决定（判定见 utils/naming.js 的
 * wantsPropertyRename，它同时认旧档位串的 `-props` 后缀）。这一项 2026-10-09 曾被
 * 并进 nameStyle 枚举（十档变体），2026-10-13 又拆回独立开关：两个正交的东西混在
 * 一个枚举里，用户为了改属性名得先把标识符形状也一起换掉。
 *
 * 与 mangle 的区别：mangle 改的是「绑定名」（变量/函数），本 pass 改的是「属性名」
 * ——成员访问 `obj.foo`、对象键 `{foo: 1}`、方法名 `{foo(){}}`、类方法/属性名。
 * 两处访问同一个属性，必须映射到同一个新名，否则运行期断链。
 *
 * safe 模式的保守判定：一个属性名只有当它既在本程序里被定义（对象/类键）、又
 * 在本程序里被访问（成员访问）时才重命名。这个「定义 ∩ 访问」策略天然排除了
 * 所有纯外部契约——`document.body`、`arr.length`、`promise.then` 这类只有访问、
 * 没有本程序定义的名字不会被碰。再叠加高风险名白名单（constructor/prototype/
 * __proto__/length/name/Function 与 Object 原型方法/迭代器与 Promise 方法/常见
 * DOM 属性）做双保险。
 *
 * 明确不做的事（safe 模式的固有局限，与 obf.io 一致）：
 *   - 不做跨对象的数据流关联：同名属性如果一半是内部对象、一半是外部库，会被
 *     一起改，可能破坏外部访问。文档已提示「可能破坏与外部代码共享的属性」。
 *   - 动态键访问 `obj[key]` / `{[key]: 1}` 里的 key 若运行时等于被改的旧名，会
 *     失配。与 obf.io 一样接受此局限。
 *   - 解构 pattern 里的 ObjectProperty（`const {foo} = obj`）是绑定名，不碰。
 *
 * 排在流水线最前（rtlib 之前）：只作用于用户代码，属性名还没被 objectKeys /
 * stringArray 改写成计算键 + 字符串池形态，此时 MemberExpression 的 property
 * 仍是干净的 Identifier / StringLiteral。
 */

// 高风险属性名白名单（safe 模式保守排除）
const RESERVED_PROPS = new Set((
  'constructor prototype __proto__ length name arguments caller callee ' +
  'call apply bind toString valueOf toLocaleString hasOwnProperty isPrototypeOf propertyIsEnumerable ' +
  'then catch finally next done value return throw default get set has delete clear add size ' +
  'keys values entries forEach iterator map filter reduce reduceRight some every find findIndex ' +
  'indexOf lastIndexOf includes push pop shift unshift slice splice concat join reverse sort fill flat flatMap ' +
  'split replace replaceAll trim trimStart trimEnd toUpperCase toLowerCase match matchAll search ' +
  'startsWith endsWith charAt charCodeAt substring substr padStart padEnd repeat test exec source flags lastIndex ' +
  'state status statusText body headers url method ok json text blob type target currentTarget ' +
  'preventDefault stopPropagation message data origin source parent children firstChild lastChild ' +
  'nodeType nodeName textContent innerHTML className id classList style attributes'
).trim().split(/\s+/));

/**
 * 取 `this.<prop>` 的属性名收进给定集合。对象不是 `this`（含 `super`）就什么都不做。
 *
 * 与访问面那套 MemberExpression 判定同构（点形态取 Identifier、计算形态取
 * StringLiteral），否则会出现"定义面认得、访问面认不得"的错配——那会让赋值点被改名
 * 而读取点没改，直接跑炸。
 * @param {object} member MemberExpression / OptionalMemberExpression
 * @param {Set<string>} out 收集目标
 */
function thisSideName(member, out) {
  const obj = member.object;
  if (!obj || obj.type !== 'ThisExpression') return;
  const prop = member.property;
  if (member.computed) {
    if (prop && prop.type === 'StringLiteral') out.add(prop.value);
  } else if (prop && prop.type === 'Identifier') {
    out.add(prop.name);
  }
}

/** 绑定形态（解构）里全部名字。解构的成员是绑定名，不参与属性判定（另见 collect）。 */
function patternNames(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'Identifier') { out.push(node.name); return out; }
  if (node.type === 'ObjectPattern' || node.type === 'ArrayPattern') {
    for (const el of node.properties || []) {
      if (el.type === 'RestElement') patternNames(el.argument, out);
      else patternNames(el.type === 'Property' ? el.value : el, out);
    }
    if (node.type === 'ArrayPattern') for (const el of node.elements || []) patternNames(el, out);
    return out;
  }
  if (node.type === 'AssignmentPattern') return patternNames(node.left, out);
  if (node.type === 'RestElement') return patternNames(node.argument, out);
  return out;
}

/**
 * 标出「对象名解析到本程序内建的命名空间」的成员访问节点。
 *
 * 为什么必须有出处分析：`NS.x = 1` 里的 `NS` 可能压根不是本程序的对象——它可以是
 * 函数形参（外部传进来的实例）、`var B = 外部对象` 的别名、或者一个没绑定的全局。
 * 不做出处就改名，改的是**调用方**的属性，直接跑炸。所以判据是：
 *
 *   一个名字在当前位置算「命名空间绑定」，当且仅当**可见作用域链上把它绑定的每一层
 *   都把它标成命名空间**；只要有一层是普通绑定（形参 / 非对象字面量初始化 /
 *   函数类声明 / catch / import / 解构 / 嵌套函数形参…），就一律不算。
 *
 * 命名空间绑定的定义只有两种：`var|let|const X = <对象字面量>`，以及
 * `var|let|const X = Y`（Y 在外层是命名空间）——就是 AGENTS 里点名的别名那条。
 *
 * 两条刻意的保守取舍，方向都是"少改名"而不是"改错名"：
 *   1. 作用域的绑定集按**整棵子树**扫（嵌套函数的形参也算进外层）。于是
 *      `var NS={}; function f(NS){NS.x=1}` 里外层的 NS 被内层形参遮蔽，整条都不改。
 *   2. 不做流分析：`var NS={}; NS.x=1; NS=外部对象;` 这种先建后换绑定的写法，改名
 *      可能改到后半个对象上。safe 模式本来就不做数据流关联（见文件头"明确不做的事"），
 *      这里与它保持同一条口径。
 *
 * @param {object} program Program 节点
 * @returns {Set<object>} 被标出的 MemberExpression 节点集合
 */
function namespaceMembers(program) {
  const marked = new Set();
  const scopes = [{ bound: new Set(), ns: new Set() }];

  const isNsInParent = (name) => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i].bound.has(name)) return scopes[i].ns.has(name);
    }
    return false;   // 没绑定 → 全局/外部，绝不当成命名空间
  };

  // 一个作用域的绑定集：整棵子树扫一遍，嵌套函数的绑定也收进来（保守遮蔽）。
  function scanScope(body) {
    const bound = new Set();
    const ns = new Set();
    const other = new Set();
    const bind = (names, isNs) => {
      for (const nm of names) { bound.add(nm); (isNs ? ns : other).add(nm); }
    };
    const visit = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { for (const c of n) visit(c); return; }
      if (typeof n.type !== 'string') return;
      switch (n.type) {
        case 'VariableDeclarator': {
          // 别名 `var B = A` 的判定顺序：先看**本作用域正在累积的**绑定，再看外层。
          // 顺序不能反——顶层作用域是在 scanScope 的调用**之后**才挂进 scopes 的，
          // 只查外层的话 `var A={}; var B=A;` 在顶层永远解析不出来（2026-10-15 实测：
          // 别名那条正例 renamed 一直是 1，少改一个）。
          const fromLocal = ns.has(n.init && n.init.name) && bound.has(n.init && n.init.name);
          const isNs = !!n.init && (n.init.type === 'ObjectExpression'
            || (n.init.type === 'Identifier' && (fromLocal || isNsInParent(n.init.name))));
          bind(patternNames(n.id, []), isNs);
          break;
        }
        case 'FunctionDeclaration':
        case 'ClassDeclaration':
          if (n.id && n.id.name) bind([n.id.name], false);
          // 形参一律普通绑定。FunctionDeclaration 与另两种必须**一起**处理：
          // scanScope 收的是整个函数节点，形参是 FunctionDeclaration 的直接子节点，
          // 只处理函数表达式那两种会漏掉声明式的形参（2026-10-15 实测：
          // `var NS={a:1}; function f(NS){NS.b=2}` 的遮蔽判不出来，多改了 b）。
          for (const p of n.params || []) bind(patternNames(p, []), false);
          break;
        case 'FunctionExpression':
        case 'ArrowFunctionExpression': {
          for (const p of n.params || []) bind(patternNames(p, []), false);
          if (n.id && n.id.name) bind([n.id.name], false);
          break;
        }
        case 'CatchClause':
          bind(patternNames(n.param, []), false);
          break;
        case 'ImportSpecifier': case 'ImportDefaultSpecifier':
        case 'ImportNamespaceSpecifier':
          if (n.local && n.local.name) bind([n.local.name], false);
          else if (n.id && n.id.name) bind([n.id.name], false);
          break;
        case 'AssignmentExpression':
          // 赋值给标识符在 sloppy 模式下也会建绑定，按普通绑定处理
          if (n.left && n.left.type === 'Identifier') bind([n.left.name], false);
          break;
        default: break;
      }
      for (const k of Object.keys(n)) {
        if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra') continue;
        const v = n[k];
        if (Array.isArray(v)) { for (const c of v) visit(c); }
        else if (v && typeof v.type === 'string') visit(v);
      }
    };
    visit(body);
    for (const nm of other) ns.delete(nm);
    return { bound, ns };
  }

  // 第二遍：带着作用域栈走，标出对象解析到命名空间的成员访问。
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const c of n) walk(c); return; }
    if (typeof n.type !== 'string') return;
    const ty = n.type;
    if (ty === 'MemberExpression' || ty === 'OptionalMemberExpression') {
      if (n.object && n.object.type === 'Identifier' && isNsInParent(n.object.name)) marked.add(n);
    }
    let pushed = false;
    if (ty === 'FunctionDeclaration' || ty === 'FunctionExpression'
      || ty === 'ArrowFunctionExpression') {
      // 必须传**整个函数节点**而不是 n.body：形参是 body 的兄弟节点，只扫 body
      // 就把形参整个漏掉，`function f(NS){NS.x=1}` 的遮蔽判不出来（2026-10-15 实测：
      // 遮蔽那条反例多改了 1 个属性）。
      scopes.push(scanScope(n));
      pushed = true;
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra') continue;
      const v = n[k];
      if (Array.isArray(v)) { for (const c of v) walk(c); }
      else if (v && typeof v.type === 'string') walk(v);
    }
    if (pushed) scopes.pop();
  };
  // 顶层作用域必须先建好，否则顶层 `var NS = {…}` 在 walk 时解析不到
  scopes[0] = scanScope(program);
  walk(program);
  return marked;
}

function collect(node, parent, defs, uses, nsMembers) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const c of node) collect(c, node, defs, uses, nsMembers); return; }
  if (typeof node.type !== 'string') return;
  const ty = node.type;

  if (ty === 'MemberExpression' || ty === 'OptionalMemberExpression') {
    const prop = node.property;
    if (node.computed) {
      if (prop && prop.type === 'StringLiteral') uses.add(prop.value);
    } else if (prop && prop.type === 'Identifier') {
      uses.add(prop.name);
    }
  } else if (ty === 'ObjectProperty') {
    // 解构 pattern 里的 ObjectProperty 是绑定名（const {foo} = obj），不是属性名
    if (!parent || parent.type !== 'ObjectPattern') {
      if (node.computed) {
        if (node.key && node.key.type === 'StringLiteral') defs.add(node.key.value);
      } else if (node.key && node.key.type === 'Identifier') {
        defs.add(node.key.name);
      }
    }
  } else if (ty === 'ObjectMethod' || ty === 'ClassMethod' || ty === 'ClassProperty') {
    if (node.computed) {
      if (node.key && node.key.type === 'StringLiteral') defs.add(node.key.value);
    } else if (node.key && node.key.type === 'Identifier') {
      defs.add(node.key.name);
    }
  } else if (ty === 'AssignmentExpression' && node.left
    && (node.left.type === 'MemberExpression' || node.left.type === 'OptionalMemberExpression')) {
    // `this.foo = v` 是实例字段**唯一的定义形式**（类字段语法之外的写法）。
    // 不认它就等于类实例属性一个都改不了：定义面只收对象/类字面量节点，
    // 而构造函数里那句成员赋值既不是 ObjectProperty 也不是 ClassProperty，
    // 只落在 uses 里 → 候选集为空 → 原名原样留在产物里
    // （2026-10-13 实测：Account 类的 this.balance / this.owner 原名残留，
    // 6 个成员只改掉 3 个）。
    //
    // `super.foo = v` **不算定义**：它走原型链上的 setter，不在本类上建属性。
    thisSideName(node.left, defs);
    // `NS.foo = v`（对象名解析到本程序内建命名空间时）同样是定义形式。少了它，
    // "先建空对象再挂方法/常量" 这种写法一个属性都改不了——2026-10-15 实测：
    // 40 个 seed 上 namespace 形态的属性全部原样残留。
    // 出处判定在 namespaceMembers 里（形参 / 外部别名 / 未绑定全局一律不算），
    // 见那里的说明。
    if (nsMembers && nsMembers.has(node.left)) {
      const prop = node.left.property;
      if (node.left.computed) {
        if (prop && prop.type === 'StringLiteral') defs.add(prop.value);
      } else if (prop && prop.type === 'Identifier') {
        defs.add(prop.name);
      }
    }
  } else if (ty === 'UpdateExpression' && node.argument
    && (node.argument.type === 'MemberExpression' || node.argument.type === 'OptionalMemberExpression')) {
    // `this.n++` 读改写，既是访问也是定义，两边都收。
    thisSideName(node.argument, defs);
    thisSideName(node.argument, uses);
    if (nsMembers && nsMembers.has(node.argument)) {
      const prop = node.argument.property;
      if (node.argument.computed) {
        if (prop && prop.type === 'StringLiteral') defs.add(prop.value);
      } else if (prop && prop.type === 'Identifier') {
        defs.add(prop.name);
      }
    }
  }

  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra') continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const c of v) collect(c, node, defs, uses, nsMembers); }
    else if (v && typeof v === 'object' && typeof v.type === 'string') {
      collect(v, node, defs, uses, nsMembers);
    }
  }
}

function rewrite(node, parent, map) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const c of node) rewrite(c, node, map); return; }
  if (typeof node.type !== 'string') return;
  const ty = node.type;

  if (ty === 'MemberExpression' || ty === 'OptionalMemberExpression') {
    const prop = node.property;
    if (node.computed) {
      if (prop && prop.type === 'StringLiteral' && map.has(prop.value)) prop.value = map.get(prop.value);
    } else if (prop && prop.type === 'Identifier' && map.has(prop.name)) {
      prop.name = map.get(prop.name);
    }
  } else if (ty === 'ObjectProperty') {
    if (!parent || parent.type !== 'ObjectPattern') {
      if (node.computed) {
        if (node.key && node.key.type === 'StringLiteral' && map.has(node.key.value)) {
          node.key.value = map.get(node.key.value);
        }
      } else if (node.key && node.key.type === 'Identifier' && map.has(node.key.name)) {
        if (node.shorthand) {
          // {foo} → {_0xabc: foo}：key 与 value 可能指向同一节点，先取旧名再分离
          const oldName = node.key.name;
          node.key = t.identifier(map.get(oldName));
          node.value = t.identifier(oldName);
          node.shorthand = false;
        } else {
          node.key.name = map.get(node.key.name);
        }
      }
    }
  } else if (ty === 'ObjectMethod' || ty === 'ClassMethod' || ty === 'ClassProperty') {
    if (node.computed) {
      if (node.key && node.key.type === 'StringLiteral' && map.has(node.key.value)) {
        node.key.value = map.get(node.key.value);
      }
    } else if (node.key && node.key.type === 'Identifier' && map.has(node.key.name)) {
      node.key.name = map.get(node.key.name);
    }
  }

  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra') continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const c of v) rewrite(c, node, map); }
    else if (v && typeof v === 'object' && typeof v.type === 'string') rewrite(v, node, map);
  }
}

export default function renameProperties(ast, options, ctx) {
  if (!wantsPropertyRename(options)) return { renamed: 0 };
  const used = new Set(ctx.usedNames);
  const prefix = options.identifierPrefix || '_0x';
  // 属性名与标识符走**同一个名池**（utils/naming.js 的 createNamePool）。此前这里
  // 只对 Chinese 档认 nameStyle、其余一律发 `_0x` 随机名，于是「选了
  // Hexadecimal、属性名却是 _0x 形状」——那一档对属性而言是假的。现在选什么档，
  // 属性名就是什么形状。
  //
  // 名池是有状态的迭代器，所以这里另要一条流：与 mangle 共用一条会让两边的发放
  // 顺序互相踩。防撞靠的是两边都把新名写回 ctx.usedNames（见本函数末尾），因此
  // 同一构建里"变量叫甲"与"属性也叫甲"不会冲突。
  const pool = createNamePool(options);
  const chinese = isChineseNaming(options);
  const nextName = () => {
    for (;;) {
      const it = pool.next();
      if (it.done) return chinese ? uniqueCJKName(used, options.chineseDictionary || '')
        : uniqueName(used, prefix);
      if (used.has(it.value)) continue;
      used.add(it.value);
      return it.value;
    }
  };
  const program = ast.type === 'File' ? ast.program : ast;

  const defs = new Set();
  const uses = new Set();
  // 出处分析必须在 collect 之前跑完：它要看到整棵 AST 才能判作用域
  const nsMembers = namespaceMembers(program);
  collect(program, null, defs, uses, nsMembers);

  // 只以**字符串形态**出现的属性名（`o['x']`、`{'x': 1}`）不在 ctx.usedNames 里：
  // 那个集合的种子来自 Identifier 节点（obfuscate.js 的收集），而字符串形态的属性名
  // 是 StringLiteral。它们没进防撞集，名池就可能把 'x' 发给**另一个**属性，两个属性
  // 被合并成一个——静默算错、产物照跑不报错。2026-10-13 实测：Mangled-shuffled-props
  // 在 30 个 seed 里错 3 个（`var o={alpha:1}; o.alpha=6; o['b']=2;` 里 alpha 改名
  // 后拿到 'b'，与字符串形态的 'b' 撞成同一个属性，读回 6 而不是 2）。
  // 修法：把定义面与访问面全部并进防撞集。写回 ctx.usedNames 时要把这批**排除**——
  // 它们只用于本地防撞，混进去会缩小 mangle 等后置 pass 的取名空间、让产物字节漂移，
  // 那是超出本修复范围的改动。
  const reservedOnly = new Set();
  for (const s of defs) if (!used.has(s)) { used.add(s); reservedOnly.add(s); }
  for (const s of uses) if (!used.has(s)) { used.add(s); reservedOnly.add(s); }

  // 候选 = 定义 ∩ 访问，再排除白名单
  const map = new Map();
  for (const name of defs) {
    if (!uses.has(name)) continue;
    if (RESERVED_PROPS.has(name)) continue;
    if (!map.has(name)) map.set(name, nextName());
  }
  if (map.size === 0) return { renamed: 0 };

  rewrite(program, null, map);

  // 新名写回 ctx.usedNames：后续 mangle 等 pass 靠它避撞。reservedOnly 只用于本地
  // 防撞，不写回（见上面那段说明）。
  for (const n of used) { if (!reservedOnly.has(n)) ctx.usedNames.add(n); }
  return { renamed: map.size };
}
