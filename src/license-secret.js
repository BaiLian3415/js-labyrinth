/**
 * License 密钥与自身摘要表。
 *
 * B64_CODE_KEY 是对称卡密密钥（base64，32 字节）：v5 卡密的信息段加密与
 * 校验码都由它派生（见 license-codec.js）。签发方（tools/issue/keygen.js）与
 * 所有验签方（浏览器 / Worker）用同一把。
 *
 * ## 安全模型的诚实说明
 *
 * 密钥必须随源码分发（浏览器要本地验卡），所以拿到源码的人可以自己签发
 * 卡密——历史上 v4 曾用 Ed25519 避开这一点（公钥验签、私钥签发），v5 应
 * 签发方要求改回对称，安全边界随之降级。真正的强制在服务端：
 *
 *   - /api/obfuscate 逐请求用密钥校验卡密；
 *   - 云存储里的赎回登记实现"一卡一机"（redeem:<编号> → 赎回者机器码）；
 *   - 云端执行构建（build:web:cloud）根本不下发混淆核心，浏览器拿不到源码。
 *
 * 因此密钥的保密要求只对"离线分发场景"有意义：想换一把不进 git 的密钥，
 * 用 tools/issue/keyrotate.js --write 生成并落盘，然后部署方再用
 * `JSLB_CODE_KEY` 环境变量覆盖服务端取值（浏览器端会用
 * 内置值，两端不一致时服务端说了算）。
 *
 * B64_MACHINE_SALT 不是卡密密钥，只是机器码派生的盐。机器码本身是公开标识
 * （它就在设备 cookie 与请求头里），盐公开不影响安全。
 *
 * 轮换密钥用 tools/issue/keyrotate.js。轮换后所有旧卡密与所有 license 记录
 * 立即失效（密钥变了，校验必然失败），每台机器都要用新卡密重新激活。
 */

/** 卡密密钥（对称），base64，32 字节。签发与校验共用。 */
const B64_CODE_KEY = '6gXmaKGn+dQw8jVtvmp7VWBYAA+hS+vEKHgrBstPW54=';

/** 机器码派生的盐，base64。与卡密密钥无关，公开不影响安全。 */
const B64_MACHINE_SALT = 'SnNMYWJ5cmludGgvTGljZW5zZS92MTo6bWFjaGluZTo6c2FsdDo6MmYxOWM0';

/**
 * 自身文件的期望摘要表，每条 64 位 hex，顺序与 tools/issue/selfdigest.js 的 SELF_FILES 一致。
 *
 * 每条形如 sha256(rel + '\n' + 归一化文本) XOR HMAC(CODE_KEY, 'JSLB/SELF/' + i)。
 *
 * 掩码的密钥是卡密密钥，也就是随源码公开的，所以这张表只能挡住"随手改一行
 * 源码"这类改动，挡不住有心人（他们能自己算出掩码、重算整张表）。对称体系里
 * 库里没有秘密可供派生掩码，这是 v5 的固有属性。真正的强制在服务端（见上）。
 *
 * 摘要前先把源文本里的 64 位 hex 串填成 0，本表因此不参与自身的摘要计算，
 * 消除自引用。
 *
 * 改动 license-core.js、license-codec.js、license-secret.js、plan.js 或 plans.js
 * 后必须重算本表，漏跑会让校验判定自身被篡改：
 * node tools/issue/selfdigest.js --write
 */
const SELF_DIGESTS = [
  'ee4b6ee6fd990cfcd0abf3683a7f62dfbbcdc6b371be06538c0b28e771bbe5c6',
  'efe34f6e4e4f04076450026b1d1d84ab93698b31c50e2cf78994197e13a43dd0',
  'f3df4992c3f8eef142e104d711e207d6bfc6f5d7df4639b8f700c8fef54d551b',
  '8e7ad2da1a02242305201c5936c49a1bd9aec7ffd2065b621b5d53a45db2cd43',
  'db59ee770d840f04eb692f3f41b8fd5ec3d292999e3da943b4e674b48a1931e1',
];

export default { B64_CODE_KEY, B64_MACHINE_SALT, SELF_DIGESTS };
