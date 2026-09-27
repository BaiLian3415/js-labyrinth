/**
 * 自研 WebAssembly 二进制发射器，零依赖，只覆盖本项目 WASM VMP 档用到的子集。
 * 单模块单线性内存，支持数据段、内存与函数导出，函数体由 wasm pass 以操作码列表形式拼出。
 * 指令流合法性的责任在调用方：由它按 block/loop/if 加 br 深度组织结构化控制流，本模块不做完整 WAT 的校验。
 */

/** 无符号 LEB128。 */
function uleb(n) {
  const out = [];
  n = n >>> 0;
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

/** 有符号 LEB128，只用于 i32/i64 的小整数。 */
function sleb(n) {
  const out = [];
  let more = true;
  while (more) {
    let b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) more = false;
    else b |= 0x80;
    out.push(b);
  }
  return out;
}

/** i32.const 的完整指令序列，首字节即操作码。 */
function i32Const(v) {
  return [OP.i32_const, ...sleb(v | 0)];
}

/** f64.const 的完整指令序列，浮点按小端直写字节。 */
function f64Const(v) {
  return [OP.f64_const, ...Array.from(new Uint8Array(new Float64Array([v]).buffer))];
}

/** local.get 指令序列。 */
function localGet(i) {
  return [OP.local_get, ...uleb(i)];
}

/** local.set 指令序列。 */
function localSet(i) {
  return [OP.local_set, ...uleb(i)];
}

/** call 指令序列。 */
function call(fnIdx) {
  return [OP.call, ...uleb(fnIdx)];
}

/** i32.load / i32.store，对齐指数写 2 表示 4 字节，偏移固定为 0。 */
function i32Load() {
  return [OP.i32_load, 0x02, 0x00];
}
function i32Store() {
  return [OP.i32_store, 0x02, 0x00];
}

/** br 指令序列，后面跟跳转深度。 */
function br(depth) {
  return [OP.br, ...uleb(depth)];
}

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d]; // \0asm
const WASM_VERSION = [0x01, 0x00, 0x00, 0x00];

// 段 id，数值由 WASM 规范固定
const SEC_TYPE = 1;
const SEC_IMPORT = 2;
const SEC_FUNC = 3;
const SEC_TABLE = 4;
const SEC_MEM = 5;
const SEC_GLOBAL = 6;
const SEC_EXPORT = 7;
const SEC_START = 8;
const SEC_ELEM = 9;
const SEC_CODE = 10;
const SEC_DATA = 11;

// 值类型编码
const T_I32 = 0x7f;
const T_I64 = 0x7e;
const T_F32 = 0x7d;
const T_F64 = 0x7c;

const LIMIT_MIN = 0x00;   // 只给最小页数
const LIMIT_MAX = 0x01;   // 同时给最小与最大页数

// 操作码表，wasm pass 用这些常量拼函数体
const OP = {
  unreachable: 0x00, nop: 0x01,
  block: 0x02, loop: 0x03, if: 0x04, else: 0x05, end: 0x0b, br: 0x0c,
  br_if: 0x0d, br_table: 0x0e, return: 0x0f,
  call: 0x10, call_indirect: 0x11,
  drop: 0x1a, select: 0x1b,
  local_get: 0x20, local_set: 0x21, local_tee: 0x22,
  global_get: 0x23, global_set: 0x24,
  i32_load: 0x28, i64_load: 0x29, f64_load: 0x2b,
  i32_store: 0x36, i64_store: 0x37, f64_store: 0x39,
  memory_size: 0x3f, memory_grow: 0x40,
  i32_const: 0x41, i64_const: 0x42, f64_const: 0x44,
  i32_eqz: 0x45, i32_eq: 0x46, i32_ne: 0x47, i32_lt_s: 0x48,
  i32_lt_u: 0x49, i32_gt_s: 0x4a, i32_gt_u: 0x4b,
  i32_le_s: 0x4c, i32_le_u: 0x4d, i32_ge_s: 0x4e, i32_ge_u: 0x4f,
  i64_eqz: 0x50, i64_eq: 0x51,
  f64_eq: 0x61, f64_ne: 0x62, f64_lt: 0x63, f64_gt: 0x64,
  i32_add: 0x6a, i32_sub: 0x6b, i32_mul: 0x6c,
  i32_div_s: 0x6d, i32_rem_s: 0x6f,
  i32_and: 0x71, i32_or: 0x72, i32_xor: 0x73,
  i32_shl: 0x74, i32_shr_s: 0x75, i32_shr_u: 0x76,
  f64_abs: 0x99, f64_neg: 0x9a,
  f64_add: 0xa0, f64_sub: 0xa1, f64_mul: 0xa2, f64_div: 0xa3,
  f64_ceil: 0x9b, f64_floor: 0x9c, f64_trunc: 0x9d, f64_nearest: 0x9e,
  f64_convert_i32_s: 0xb7, i32_trunc_f64_s: 0xaa,
  i32_reinterpret_f64: 0xbc, f64_reinterpret_i32: 0xbd,
};

// block/loop/if 无返回值时的类型字节
const BLOCK_VOID = 0x40;

/**
 * 逐元素拼接。code/data 段体可达数百 KB，用 `dst.push(...src)` 展开实参
 * 会超出引擎的实参上限并抛 RangeError，所以拼接一律走循环。
 * @param {number[]} dst 目标字节数组，原地追加
 * @param {number[]|Uint8Array} src 待追加的字节
 * @returns {number[]} 追加后的 dst
 */
function pushAll(dst, src) {
  for (let i = 0; i < src.length; i++) dst.push(src[i]);
  return dst;
}

/** 段头格式：段 id，内容长度 uleb，随后是内容本身。 */
function section(id, contentBytes) {
  const out = [id];
  pushAll(out, uleb(contentBytes.length));
  return pushAll(out, contentBytes);
}

/** vec 编码：先写元素个数的 uleb，再依次写各元素字节。 */
function vec(itemsBytes) {
  const out = uleb(itemsBytes.length);
  for (const it of itemsBytes) pushAll(out, it);
  return out;
}

/**
 * 按 spec 组装出完整的 WASM 模块字节，各段按规范要求的顺序排列。
 * @param {object} spec 模块描述
 * @param {Array<{params:number[], results:number[]}>} spec.types 函数签名
 * @param {Array<{module:string, name:string, typeIdx:number, kind:number}>} [spec.imports] 导入项，kind 0 表示函数
 * @param {Array<{typeIdx:number, locals:number[][], body:number[]}>} spec.funcs 函数定义，locals 为 [个数, 类型] 对，body 已含 end
 * @param {number} [spec.memPages] 线性内存初始页数，一页 64KB
 * @param {Array<{name:string, kind:number, idx:number}>} [spec.exports] 导出项，kind 0/1/2/3 依次为函数、表、内存、全局（全局导出配合 spec.globals 使用）
 * @param {Array<{offsetBytes:number[], bytes:number[]}>} [spec.data] 数据段，偏移指令已编码在 offsetBytes 里
 * @param {number[]} [spec.nameBytes] 自定义 name 段的附加内容
 * @returns {Uint8Array} 模块字节
 */
function buildModule(spec) {
  const parts = [...WASM_MAGIC, ...WASM_VERSION];

  const types = spec.types.map((ty) =>
    [0x60, ...vec(ty.params.map((p) => [p])), ...vec(ty.results.map((r) => [r]))]);
  if (types.length) pushAll(parts, section(SEC_TYPE, vec(types)));

  // 模块名与字段名都是长度前缀加 UTF-8 字节
  if (spec.imports && spec.imports.length) {
    const items = spec.imports.map((im) => [
      ...uleb(im.module.length), ...[...im.module].map((c) => c.charCodeAt(0)),
      ...uleb(im.name.length), ...[...im.name].map((c) => c.charCodeAt(0)),
      0x00, ...uleb(im.typeIdx),
    ]);
    pushAll(parts, section(SEC_IMPORT, vec(items)));
  }

  // 每个函数只占一个 typeIdx
  if (spec.funcs.length) {
    pushAll(parts, section(SEC_FUNC, vec(spec.funcs.map((f) => [...uleb(f.typeIdx)]))));
  }

  // 内存由模块自己定义；若改成导入内存，这一段要整省掉
  if (spec.memPages) {
    pushAll(parts, section(SEC_MEM, vec([[LIMIT_MIN, ...uleb(spec.memPages)]])));
  }

  // 可变 i32 全局段（wasmvm 解释器的帧顶指针/计数器/nonce）。
  // init 是 i32 常量初值，编码为 i32.const 指令 + end。
  if (spec.globals && spec.globals.length) {
    const items = spec.globals.map((g) => [
      T_I32, g.mutable === false ? 0x00 : 0x01, ...i32Const(g.init), OP.end,
    ]);
    pushAll(parts, section(SEC_GLOBAL, vec(items)));
  }

  if (spec.exports && spec.exports.length) {
    const items = spec.exports.map((ex) => [
      ...uleb(ex.name.length), ...[...ex.name].map((c) => c.charCodeAt(0)),
      ex.kind, ...uleb(ex.idx),
    ]);
    pushAll(parts, section(SEC_EXPORT, vec(items)));
  }

  // 函数体先写自身长度，再写 locals 向量与指令字节
  if (spec.funcs.length) {
    const items = spec.funcs.map((f) => {
      const locals = f.locals || [];
      const localVec = vec(locals.map((l) => [...uleb(l[0]), l[1]]));
      const bodyBytes = [...localVec, ...f.body];
      return [...uleb(bodyBytes.length), ...bodyBytes];
    });
    pushAll(parts, section(SEC_CODE, vec(items)));
  }

  // 数据段一律落在 memory 0，偏移是已编码的 i32.const 指令
  if (spec.data && spec.data.length) {
    const items = spec.data.map((d) => [
      0x00, ...d.offsetBytes, ...uleb(d.bytes.length), ...d.bytes,
    ]);
    pushAll(parts, section(SEC_DATA, vec(items)));
  }

  // 自定义 name 段，id 0；里面放的是故意误导反编译器的假符号表
  if (spec.nameBytes && spec.nameBytes.length) {
    const name = 'name';
    const body = [...uleb(name.length), ...[...name].map((c) => c.charCodeAt(0)), ...spec.nameBytes];
    pushAll(parts, section(0, body));
  }

  return new Uint8Array(parts);
}

/**
 * 构造 name 自定义段里的函数名子段，即 subsection 1。
 * @param {Array<[number, string]>} pairs 函数下标与名字，下标必须按升序排列
 * @returns {number[]} 子段字节，含子段 id 与长度前缀
 */
function buildNameFuncs(pairs) {
  const items = pairs.map(([i, nm]) => [
    ...uleb(i), ...uleb(nm.length), ...[...nm].map((c) => c.charCodeAt(0)),
  ]);
  const payload = vec(items);
  return [1, ...uleb(payload.length), ...payload];
}

export default { uleb, sleb, OP, T_I32, T_F64, BLOCK_VOID, buildModule, vec, buildNameFuncs,
  i32Const, f64Const, localGet, localSet, call, i32Load, i32Store, br };
