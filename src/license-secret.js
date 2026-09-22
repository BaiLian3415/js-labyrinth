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
 * 自身文件的期望摘要表，每条 64 位 hex，顺序与 tools/issue/selfdigest.js 的 SELF_FILES 一致。
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
 * 改动 license-core.js、license-codec.js、license-secret.js、plan.js 或 plans.js
 * 后必须重算本表，漏跑会让校验判定自身被篡改：
 * node tools/issue/selfdigest.js --write
 */
const SELF_DIGESTS = [
  '7f91c532b2c3932d7971feaa062d502c28ccad9a8a91de5b66478427bebaf6ad',
  '6442a9c998a2e746b7e05ba5c4d49128b49f883b07fddb038623f04883edb6a0',
  'e586a6eb637b3ff10f6aed01661cda0f626f3520f45670958b0499b58e3cdb02',
  'cbd602a189b8aba74477fc25e10daa39c23446214f2977da81aff039259e16c0',
  '5c00bde08947e894587936ebe3831256f857786c7a84114fa928233b4bab4116',
];

export default { B64_PUBLIC_KEY, B64_MACHINE_SALT, SELF_DIGESTS };
