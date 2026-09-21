/**
 * License 密钥的公开部分与自身摘要表。
 *
 * **这里只有公钥。** 卡密用 Ed25519 签发，私钥（32 字节种子）只存在于签发方：
 * 环境变量 `JSLB_SIGNING_KEY`（base64）或项目根的 `.jslb-signing-key`（gitignore）。
 * 私钥一旦泄露就等于发卡权泄露——可以签出任意套餐、任意有效期的卡密，而且所有
 * 验签方都持有对应公钥，一定通过。因此它绝不能进源码、不能进 `dist/`。
 *
 * 换成非对称的动机就在这里：原先用 HMAC-SHA256 对称签名，浏览器端本地校验必须
 * 持有同一把密钥，而密钥随静态资源公开，拿到源码的人就能自己签发卡密。现在
 * 浏览器只放公钥，**爬走全部源码也签不出新卡**。
 *
 * B64_MACHINE_SALT 不是签名密钥，只是机器码派生的盐。机器码本身是公开标识
 * （它就在设备 cookie 与请求头里），盐公开不影响安全。
 *
 * 轮换密钥用 tools/issue/keyrotate.js。轮换后所有旧卡密与所有 license.lic 立即
 * 失效（公钥变了，验签必然失败），每台机器都要用新卡密重新激活。
 */

/** Ed25519 公钥，base64，32 字节。验签用，公开无妨。 */
const B64_PUBLIC_KEY = '6gXmaKGn+dQw8jVtvmp7VWBYAA+hS+vEKHgrBstPW54=';

/** 机器码派生的盐，base64。与签发私钥无关，公开不影响安全。 */
const B64_MACHINE_SALT = 'SnNMYWJ5cmludGgvTGljZW5zZS92MTo6bWFjaGluZTo6c2FsdDo6MmYxOWM0';

/**
 * 自身文件的期望摘要表，每条 64 位 hex，顺序与 host/license-node.js 的 SELF_FILES 一致。
 *
 * 每条形如 sha256(rel + '\n' + 归一化文本) XOR HMAC(PUBLIC_KEY, 'JSLB/SELF/' + i)。
 *
 * **掩码的密钥现在是公钥，也就是公开的**，所以这张表只能挡住"随手改一行源码"
 * 这类改动，挡不住有心人（他们能自己算出掩码、重算整张表）。这是换成非对称之后
 * 的必然结果：库里不再有任何秘密可供派生掩码。真正的安全边界是**私钥不在库里**
 * ——改源码最多骗过本机的自检，签不出能在别处通过验签的卡密。
 *
 * 摘要前先把源文本里的 64 位 hex 串填成 0，本表因此不参与自身的摘要计算，
 * 消除自引用。
 *
 * 改动 license-node.js、license-core.js、license-codec.js、license-secret.js、plan.js 或 plans.js
 * 后必须重算本表，漏跑会让工具判定自身被篡改并拒绝运行：
 * node tools/issue/selfdigest.js --write
 */
const SELF_DIGESTS = [
  '6c715f0559889e70a770c065ad8383da49bcf7e750a0f1375af3fc70aa92ac17',
  'a67d0160984b64e312bb44e3a68ebaa5aa284be98cc78ffb519fb977d5bc847c',
  '7d8243a3d1b48dc288c4b7ef55f22932bc8b5663e5bdc7d893c6bde075a05f64',
  'd5570e81916898955f133d5323164bf87cf9c0d38b8a0f5baa567e80ded95c00',
  '1a183846331871ad5ce04aa611124f20fc249b1a56c754ecb80d7a695e5317b4',
  '107f0771f5647898bce41cf815eaa5a5d66bd56c4966a98665cf963d5b685dca',
];

export default { B64_PUBLIC_KEY, B64_MACHINE_SALT, SELF_DIGESTS };
