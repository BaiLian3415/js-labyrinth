#!/usr/bin/env node
/**
 * 本地预览服务器（仅开发用，零依赖）。
 *
 *   node tools/build/serve.js [--port 8787] [--host 127.0.0.1] [--dist] [--api]
 *
 * 默认直接从仓库映射，不需要先构建：
 *   /             → web/index.html
 *   /app.js 等    → web/ 下的文件
 *   /src/**       → 仓库里的 src/**（与线上完全同一份源码）
 *
 * --dist          以 dist/ 为根，用来验证构建产物（先跑 npm run build:web）
 * --api           在进程内挂上 Worker 处理器，/api/* 走 host/worker.js。
 *                 这样不装 wrangler 也能在本地试 Worker API 与授权流程。
 *
 * 注意：此服务器仅供本机预览，不做任何认证，别拿它当生产服务器。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function parseArgs(argv) {
  const out = { port: 8787, host: '127.0.0.1', dist: false, api: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]) || out.port;
    else if (a === '--host') out.host = argv[++i] || out.host;
    else if (a === '--dist') out.dist = true;
    else if (a === '--api') out.api = true;
    else if (a === '--help' || a === '-h') {
      console.log('用法: node tools/build/serve.js [--port 8787] [--host 127.0.0.1] [--dist] [--api]');
      process.exit(0);
    }
  }
  return out;
}

/**
 * 请求路径 → 磁盘路径。
 * 两种布局：dist 模式（单一根目录）与仓库模式（界面在 web/，核心在 src/）。
 */
function resolveFile(urlPath, opts) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  if (clean.includes('\0')) return null;

  if (opts.dist) {
    const root = path.join(ROOT, 'dist');
    const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root)) return null; // 目录穿越
    return fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : null;
  }

  if (clean === '/' || clean === '/index.html') return path.join(ROOT, 'web', 'index.html');
  if (clean === '/app.js' || clean === '/styles.css') return path.join(ROOT, 'web', clean.slice(1));

  const rel = clean.replace(/^\/+/, '');
  const abs = path.resolve(ROOT, rel);
  if (!abs.startsWith(ROOT)) return null;
  if (!/^src[\\/]/.test(rel) && !/^web[\\/]/.test(rel)) return null; // 只放行界面与核心
  return fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const worker = opts.api ? (await import('../../host/worker.js')).default : null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // Worker API：把 Node 的请求体读全，交给同一份处理器
    if (worker && url.pathname.startsWith('/api/')) {
      try {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        const request = new Request(url.href, {
          method: req.method,
          headers: req.headers,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
        });
        const out = await worker.fetch(request, {}, {});
        res.writeHead(out.status, Object.fromEntries(out.headers));
        res.end(Buffer.from(await out.arrayBuffer()));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('API error: ' + ((e && e.stack) || e));
      }
      return;
    }

    const file = resolveFile(url.pathname, opts);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 ' + url.pathname + '\n');
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });

  server.listen(opts.port, opts.host, () => {
    const base = 'http://' + opts.host + ':' + opts.port + '/';
    console.log('JsLabyrinth 预览: ' + base);
    console.log('  根目录: ' + (opts.dist ? 'dist/' : '仓库（web/ + src/）'));
    console.log('  Worker API: ' + (opts.api ? '已挂载（/api/health、/api/obfuscate、/api/license、/api/plans）' : '未挂载（加 --api 开启）'));
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
