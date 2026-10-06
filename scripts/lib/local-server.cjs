/**
 * 本地 http 静态服务器 —— 给渲染器 / 验收器加载页面用。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────
 * file:// 下浏览器会开同源限制：
 *   · <script type="module"> 直接被 CORS 拦死（模块脚本不允许 file:// 源）
 *   · fetch / XMLHttpRequest 读本地 JSON、csv 全部失败
 *   · import.meta、动态 import() 同样废掉
 * 也就是说：用 Vite / esbuild / 原生 ESM 组织起来的动画项目，在 file:// 下根本加载不起来。
 * 走 http 就没这些事，而且 file:// 下能跑的东西在 http 下照样能跑 —— 是严格超集。
 *
 * ── 为什么 URL 里带完整绝对路径 ──────────────────────────────────
 * 页面里常见 `<script src="../lib/motion.js">`。要让 `..` 在浏览器里解析对，
 * URL 必须保留真实的目录层级；把 URL 拍平成 `/my.html` 会让 `../lib/`
 * 解析到 `/lib/`（错一层）。所以根就取磁盘根，URL 里放完整路径。
 *
 * 这是本机的、只绑 127.0.0.1 的一次性服务器，和直接打开本地文件同信任级别。
 *
 * ── 用法 ──────────────────────────────────────────────────────────
 *   const { startServer } = require('./local-server.cjs');
 *   let srv = null, url = 'file://' + HTML_ABS;
 *   try { srv = await startServer(); url = srv.url(HTML_ABS); }
 *   catch (e) { srv = null; }        // 起不来就退回 file://，只 warn 不失败
 *   ...
 *   if (srv) await srv.close();
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',      // 漏了这条 ESM 照样加载失败
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/** 绝对路径 → URL 路径（逐段编码，中文 / 空格 / 撇号都不会坏） */
function toUrlPath(abs) {
  let p = String(abs).split(path.sep).join('/');
  if (!p.startsWith('/')) p = '/' + p;             // Windows: C:/... → /C:/...
  return p.split('/').map(encodeURIComponent).join('/');
}

/** URL 路径 → 绝对路径；解析不出来返回 null */
function fromUrlPath(u) {
  let p;
  try {
    p = decodeURIComponent(String(u).split('?')[0].split('#')[0]);
  } catch (e) {
    return null;
  }
  // Windows 下 URL 是 /C:/Users/...，去掉前导斜杠才是可解析的路径
  if (process.platform === 'win32') p = p.replace(/^\/+/, '');
  return p ? path.resolve(p) : null;
}

function send(res, file) {
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  fs.createReadStream(file)
    .on('error', () => { try { res.end(); } catch (e) { /* 连接已断 */ } })
    .pipe(res);
}

/**
 * 起一个只绑 127.0.0.1 的静态服务器，端口交给系统分配（0）。
 * @returns {Promise<{port:number, url:(abs:string)=>string, close:()=>Promise<void>}>}
 */
function startServer() {
  const server = http.createServer((req, res) => {
    let abs = fromUrlPath(req.url);
    if (!abs) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('bad request');
      return;
    }
    fs.stat(abs, (err, st) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 ' + abs);
        return;
      }
      if (st.isDirectory()) {
        const idx = path.join(abs, 'index.html');
        fs.stat(idx, (e2, st2) => {
          if (!e2 && st2.isFile()) send(res, idx);
          else {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('directory listing disabled');
          }
        });
        return;
      }
      send(res, abs);
    });
  });

  // 有连接就别让 Node 卡在退出上
  server.on('connection', (sock) => { sock.setNoDelay(true); });

  return new Promise((resolve, reject) => {
    const onErr = (e) => reject(e);
    server.once('error', onErr);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onErr);
      const port = server.address().port;
      resolve({
        port,
        url: (abs) => `http://127.0.0.1:${port}${toUrlPath(path.resolve(abs))}`,
        close: () => new Promise((done) => {
          try { server.close(() => done()); } catch (e) { done(); }
        }),
      });
    });
  });
}

module.exports = { startServer, toUrlPath, fromUrlPath };
