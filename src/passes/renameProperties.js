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
 * 开不开由 `nameStyle` 的档位决定：带 `-props` 后缀的那几档才跑本 pass（判定见
 * utils/naming.js 的 wantsPropertyRename）。原先它是个独立的 `renameProperties`
 * 布尔项，2026-10-09 并入档位。
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

function collect(node, parent, defs, uses) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const c of node) collect(c, node, defs, uses); return; }
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
  }

  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra') continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const c of v) collect(c, node, defs, uses); }
    else if (v && typeof v === 'object' && typeof v.type === 'string') collect(v, node, defs, uses);
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
  collect(program, null, defs, uses);

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
