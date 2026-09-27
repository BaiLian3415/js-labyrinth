/**
 * 极小 Redis 客户端：只用 Node 内置的 node:net / node:tls，**零第三方依赖**。
 *
 * 为什么需要它：Vercel Marketplace 的「Redis（Official Redis for Vercel，背后是
 * Redis Cloud）」只会注入**一个**环境变量 `REDIS_URL`——标准 redis:// 连接串，
 * **没有 REST 接口**。官方示例的做法是 `npm install redis`。
 * 而本项目把「零依赖」当硬要求（部署方拿到源码 `node vercel/entry.js` 就能直接跑，
 * 不必先过一遍 npm 审计与供应链面），所以这里自己拼 RESP。
 *
 * 范围刻意收窄：只实现授权记录与用量计数真正用到的那几条命令
 * （GET / SET / DEL / INCRBY），走**同一条连接、命令串行化**。授权路径的并发极低
 * （一次请求才两三条命令），串行完全够用，换来的是不会出现"两条命令的回包交叉"
 * 这类难查的解析 bug。
 *
 * 协议细节（RESP2：不发 HELLO，服务端也就用 RESP2 回）：
 *   命令  *<参数个数>\r\n$<字节长度>\r\n<参数>\r\n...
 *   回包  +OK  -ERR ...  :123  $5\r\nhello  $-1  *2\r\n...
 * 四个容易踩的点，这里都处理了：
 *   1. 长度是**字节数**不是字符数——记录里有中文与 base64，按字符数算必然错位；
 *   2. 回包可能跨 TCP 分段到达，缓冲区不够时必须等下一个 chunk，不能当错误；
 *   3. scheme 决定传输方式，但**绝不从 TLS 往下掉**：`rediss://` 只走 TLS（握手失败
 *      就判失败，不改走明文），`redis://` 先明文、失败再升到 TLS（有些服务商会把
 *      TLS 端口的 scheme 写成 redis://）。实测 Vercel 官方 Redis 注入的连接串是
 *      `redis://…:10944`，那个端口是**明文**的（对同一端口发 TLS 握手会被回
 *      WRONG_VERSION_NUMBER），所以明文优先既不绕路也不多余。
 *   4. 命令级错误（-ERR）不该断连接，只有连接层失败才重连。
 *
 * 失败一律不抛给调用方：读不到返回 undefined/null，写不进去返回 false，
 * 授权模块据此提示"用量写不进去"——与 vercel/store.js 里 REST 版的契约一致。
 */

import net from 'node:net';
import tls from 'node:tls';

const CRLF = '\r\n';
/** 单条命令的读写超时。与 vercel/store.js 的 REST 超时同量级，超了就当这次没写成。 */
const DEFAULT_TIMEOUT_MS = 2500;
/** 建连 + 握手（AUTH/SELECT）的超时。免费档宁可判失败也别把请求挂死。 */
const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
/** 缓冲上限。单条命令最多写一条授权记录，8 MiB 足够；超了说明对端在说胡话，断掉重连。 */
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * 把一条命令编成 RESP 数组（参数按 UTF-8 文本编码）。
 *
 * 只支持文本：本项目存进 Redis 的值是 JSON 与 base64，本身就是文本。真要存二进制
 * 得再开一条"参数吃 Buffer"的路径。
 *
 * @param {Array<string|number>} args
 * @returns {Buffer}
 */
export function encodeCommand(args) {
  const list = Array.isArray(args) ? args : [args];
  const parts = [Buffer.from('*' + list.length + CRLF, 'utf8')];
  for (const arg of list) {
    const body = Buffer.from(arg === null || arg === undefined ? '' : String(arg), 'utf8');
    parts.push(Buffer.from('$' + body.length + CRLF, 'utf8'), body, Buffer.from(CRLF, 'utf8'));
  }
  return Buffer.concat(parts);
}

/** 从 start 处读一行（不含 CRLF）。找不到行尾返回 null——数据还没到齐。 */
function readLine(buf, start) {
  const idx = buf.indexOf(CRLF, start);
  if (idx < 0) return null;
  return { line: buf.toString('utf8', start, idx), next: idx + 2 };
}

/**
 * 解析一条回包。
 *
 * @param {Buffer} buf 从回包开头起的字节
 * @returns {{ok:boolean, value?:*, error?:string, rest:number}|null}
 *          null = 字节还不够一整条回包（等下一个 chunk 再调）；否则 rest 是本条回包
 *          之后剩下的字节数，调用方据此继续切。
 */
export function parseReply(buf) {
  if (!buf || buf.length === 0) return null;
  const head = readLine(buf, 0);
  if (!head) return null;
  const type = head.line.charAt(0);
  const body = head.line.slice(1);

  switch (type) {
    case '+':
      return { ok: true, value: body, rest: head.next };
    case '-':
      // 服务端是在的，只是这条命令不成立（WRONGTYPE 之类）。连接仍然可用，不该因此断。
      return { ok: false, error: body, rest: head.next };
    case ':':
      return { ok: true, value: Number(body), rest: head.next };
    case '$': {
      const len = Number(body);
      if (!Number.isFinite(len)) return { ok: false, error: 'bad bulk length', rest: head.next };
      if (len < 0) return { ok: true, value: null, rest: head.next };
      if (buf.length < head.next + len + 2) return null; // 半条，等下一段
      return {
        ok: true,
        value: buf.toString('utf8', head.next, head.next + len),
        rest: head.next + len + 2,
      };
    }
    case '*': {
      const count = Number(body);
      if (!Number.isFinite(count)) return { ok: false, error: 'bad array length', rest: head.next };
      if (count < 0) return { ok: true, value: null, rest: head.next };
      const out = [];
      let off = head.next;
      for (let i = 0; i < count; i++) {
        const item = parseReply(buf.subarray(off));
        if (!item) return null; // 数组也可能断在半条
        if (!item.ok) return { ok: false, error: item.error, rest: off + item.rest };
        out.push(item.value);
        off += item.rest; // item.rest 是相对 subarray 的偏移
      }
      return { ok: true, value: out, rest: off };
    }
    // RESP3 这三种类型不会真出现（没发 HELLO 就是 RESP2），但认掉它们比真收到时
    // 抛一个看不懂的错好。
    case '_':
      return { ok: true, value: null, rest: head.next };
    case '#':
      return { ok: true, value: body === 't', rest: head.next };
    case ',':
      return { ok: true, value: Number(body), rest: head.next };
    default:
      return { ok: false, error: 'unknown reply type: ' + type, rest: head.next };
  }
}


/** 拆连接串。scheme 决定首选传输方式，但最终以"连得上并能 AUTH"为准。 */
function parseRedisUrl(raw) {
  const u = new URL(String(raw));
  const dbMatch = /^\/(\d+)$/.exec(u.pathname || '');
  return {
    host: u.hostname,
    port: Number(u.port) || 6379,
    secure: u.protocol === 'rediss:',
    username: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
    db: dbMatch ? Number(dbMatch[1]) : 0,
  };
}

/**
 * 一条连接上的读写配对。
 *
 * 命令是串行的，任何时刻至多一条命令在等回包，所以一个 waiter 就够——这正是
 * "不写 pipelining"能成立的前提。回包切在共享缓冲区上，drain() 一次可能连切多条
 * （上一次的余量 + 新到的整包），只有 waiter 存在时才会切。
 */
function createSession(sock) {
  let buf = Buffer.alloc(0);
  let waiter = null;
  let dead = false;

  function settle(err, value) {
    const w = waiter;
    if (!w) return;
    waiter = null;
    if (w.timer) clearTimeout(w.timer);
    if (err) w.reject(err);
    else w.resolve(value);
  }

  function drain() {
    while (waiter && !dead) {
      const reply = parseReply(buf);
      if (!reply) return; // 半条，等下一个 chunk
      buf = buf.subarray(reply.rest);
      settle(reply.ok ? null : new Error(reply.error), reply.value);
    }
  }

  sock.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    if (buf.length > MAX_BUFFER_BYTES) {
      dead = true;
      settle(new Error('redis reply too large'));
      sock.destroy();
      return;
    }
    drain();
  });
  // 连接断了：当前这条命令只能算失败；没在等回包时静默标记，等下次命令重连。
  sock.on('error', (e) => { dead = true; settle(e); });
  sock.on('close', () => { dead = true; settle(new Error('redis connection closed')); });

  return {
    get dead() { return dead; },
    read(timeoutMs) {
      if (dead) return Promise.reject(new Error('redis connection closed'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          dead = true;
          settle(new Error('redis read timeout'));
          sock.destroy();
        }, timeoutMs);
        // 定时器不吊事件循环：有在途命令时 write() 会把 socket ref 回来。
        if (timer && typeof timer.unref === 'function') timer.unref();
        waiter = { resolve, reject, timer };
        drain();
      });
    },
    write(args) {
      if (dead) throw new Error('redis connection closed');
      if (typeof sock.ref === 'function') sock.ref(); // 别让事件循环在命令半路空闲退出
      return sock.write(encodeCommand(args));
    },
    release() {
      // 空闲时 unref：连接留着复用，但不让 Node 进程（或本地脚本）一直不退出。
      if (!dead && typeof sock.unref === 'function') sock.unref();
    },
    destroy() {
      dead = true;
      try { sock.destroy(); } catch { /* 已经断了 */ }
    },
  };
}

/** host 是 IP 时不能设 SNI（RFC 6066 不允许），Node 会告警，所以判一下。 */
function tlsOptionsFor(host, port) {
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.indexOf(':') >= 0;
  return isIp ? { host, port } : { host, port, servername: host };
}

/** 按 secure 建一条**已认证**的连接。失败抛错，由调用方决定要不要换传输方式重试。 */
function openSession(target, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('redis connect timeout')), timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();

    const sock = target.secure
      ? tls.connect(tlsOptionsFor(target.host, target.port))
      : net.connect({ host: target.host, port: target.port });
    sock.once(target.secure ? 'secureConnect' : 'connect', () => {
      const session = createSession(sock);
      (async () => {
        // 有密码才 AUTH。Redis Cloud 走 ACL（用户名 + 密码），URL 里两个都有；
        // 只有密码的老库发单参数形式。
        if (target.password) {
          session.write(target.username
            ? ['AUTH', target.username, target.password]
            : ['AUTH', target.password]);
          await session.read(timeoutMs);
        }
        if (target.db) { // Redis Cloud 只有 0 号库，URL 路径为空时这一步直接跳过
          session.write(['SELECT', String(target.db)]);
          await session.read(timeoutMs);
        }
        session.release();
        finish(null, session);
      })().catch((e) => {
        sock.destroy();
        finish(e);
      });
    });
    sock.once('error', (e) => { sock.destroy(); finish(e); });
  });
}

/**
 * 建客户端。同一实例内复用一条连接；断了就重连，重连时先试上次成功的传输方式。
 */
function createClient(options) {
  const target = parseRedisUrl(options.url);
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const connectTimeoutMs = Number(options.connectTimeoutMs) > 0
    ? Number(options.connectTimeoutMs)
    : DEFAULT_CONNECT_TIMEOUT_MS;
  let preferred = target.secure ? 'tls' : 'tcp';
  let session = null;
  let connecting = null;
  // 命令串行：tail 是一条命令接一条命令的链，并发调用因此不会让字节交错。
  let tail = Promise.resolve();

  async function ensure() {
    if (session && !session.dead) return session;
    if (connecting) return connecting; // 别的命令正在建连，共享它
    session = null;
    connecting = (async () => {
      // 试哪些传输方式，规则只有一条：**不往下掉安全等级**。
      //   连接串写 rediss:// → 只试 TLS。写明要加密就不能因为握手失败而改走明文，
      //     那种情况宁可判失败（写入返回 false、授权模块提示用量写不进去）。
      //   连接串写 redis://  → 先明文后 TLS。有些服务商会把 TLS 端口的 scheme 写成
      //     redis://，这时从明文升级到 TLS 是升级而不是降级，所以允许回退。
      // 试出来的可用方式会被记进 preferred，同一实例的后面几条命令直接走它。
      const order = target.secure
        ? ['tls']
        : (preferred === 'tcp' ? ['tcp', 'tls'] : ['tls', 'tcp']);
      let lastErr = null;
      for (const mode of order) {
        try {
          const s = await openSession({ ...target, secure: mode === 'tls' }, connectTimeoutMs);
          preferred = mode;
          connecting = null;
          return s;
        } catch (e) {
          lastErr = e;
        }
      }
      connecting = null;
      throw lastErr || new Error('redis connect failed');
    })();
    return connecting;
  }

  async function runOnce(args) {
    let s = null;
    try {
      s = await ensure();
      s.write(args);
      const value = await s.read(timeoutMs);
      s.release();
      return value;
    } catch (e) {
      // 只有连接层失败才丢连接：命令级错误（-ERR）时 s.dead 为 false，说明服务端还活着。
      if (!s || s.dead) session = null;
      return undefined;
    }
  }

  return {
    target,
    /** 发一条命令。成功返回值，失败返回 undefined（不抛）。 */
    command(args) {
      const job = tail.then(() => runOnce(args), () => runOnce(args));
      tail = job.then(() => {}, () => {});
      return job;
    },
    close() {
      if (session) session.destroy();
      session = null;
    },
  };
}

/**
 * 建一个走标准 Redis 协议的云存储，形状与 vercel/store.js 里 REST 版完全一致。
 *
 * @param {string} url redis:// 或 rediss:// 连接串
 * @param {{timeoutMs?:number, connectTimeoutMs?:number}} [options]
 * @returns {{kind:'redis', kv:object, addNumber:function, close:function}}
 */
export function createTcpStore(url, options) {
  const client = createClient({ url, ...(options || {}) });
  return {
    kind: 'redis',
    note: '',
    kv: {
      async get(key) {
        const v = await client.command(['GET', String(key)]);
        return v === undefined || v === null ? null : String(v);
      },
      async put(key, value) {
        const v = await client.command(['SET', String(key), String(value)]);
        return v === 'OK';
      },
      async delete(key) {
        await client.command(['DEL', String(key)]);
      },
    },
    async addNumber(key, delta) {
      const v = await client.command(['INCRBY', String(key), String(Math.round(Number(delta) || 0))]);
      return Number.isFinite(Number(v)) ? Number(v) : null;
    },
    /** 只给测试与脚本用：断开连接。 */
    close() { client.close(); },
  };
}

export default { createTcpStore, encodeCommand, parseReply };
