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
 * Chromium 的「不安全端口」黑名单 —— 落在名单里的端口，页面导航会直接被拒：
 *   page.goto: net::ERR_UNSAFE_PORT at http://127.0.0.1:3659/...
 *
 * 我们让系统随机分端口（listen(0)），偶尔就会分到名单里的某一个（3659 实测撞过），
 * 渲染必失败，而报错信息跟端口分配毫无关系，排查时会误以为是页面本身坏了。
 * 所以分到不安全端口就换一个，最多试 8 次。
 *
 * 名单连同区间段一起展开，别只抄零散几个 —— 6665-6669 这种区间同样会撞。
 */
const UNSAFE_PORTS = (() => {
  const s = new Set([
    1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
    87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
    139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
    540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
    2049, 3659, 4045, 5060, 5061, 6000, 6566, 6697, 10080,
  ]);
  for (let p = 6665; p <= 6669; p++) s.add(p);   // IRC，Chromium 也拦
  return s;
})();

function isUnsafePort(port) {
  return UNSAFE_PORTS.has(Number(port));
}

/** 起一个只绑 127.0.0.1 的静态服务器，端口交给系统分配（0），跳过 Chromium 不安全端口 */
function startServer(retries = 8) {
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
      /* 撞上 Chromium 黑名单就重来。极低概率事件，但一旦发生就是「渲染莫名失败」。 */
      if (isUnsafePort(port) && retries > 0) {
        server.close(() => {
          startServer(retries - 1).then(resolve, reject);
        });
        return;
      }
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

module.exports = { startServer, toUrlPath, fromUrlPath, isUnsafePort, UNSAFE_PORTS };
