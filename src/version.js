/**
 * 版本号。
 *
 * package.json 的 version 与本文件必须一致，tools/issue/selfdigest.js --check 会校验，
 * 避免两处对不上。i18n 的帮助文本从这里取版本号，浏览器端因此不必导入 JSON
 * （原生 ESM 的 JSON 模块在各浏览器支持度不一）。
 */
export const VERSION = '1.0.0';
export default VERSION;
