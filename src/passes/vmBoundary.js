import vm from './vm.js';
const { isVMCompiled } = vm;
/**
 * 判断 path 是否位于某个 VM 已编译函数体内，嵌套的内部函数和片段闭包也算。
 *
 * 后期结构变换 pass 整体跳过 VM 函数，因为解释器骨架是 wasm 桥接做特征匹配
 * 的依据，动它会破坏匹配。代价是片段闭包内拿不到 condition/logical 这些变换，
 * 闭包里的字符串、数字、标识符仍由 stringArray 和 mangle 处理。
 */

function insideVmFunction(path) {
  let p = path;
  while (p) {
    const n = p.node;
    if (!n) return false;
    if (isVMCompiled(n) || n.__rtKernel) return true;
    p = p.parentPath;
  }
  return false;
}

export default { insideVmFunction };
