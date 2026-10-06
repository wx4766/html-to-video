#!/usr/bin/env node
/**
 * QA —— 一条命令验收一个逐帧动画，出数字 + 线索清单。交付前跑，别只看渲染器说成功。
 *
 * 为什么需要它：渲染器只保证「帧渲出来了」，不保证「画面是对的」。
 * 半截字、两串字压在一起、字跑出画面、整段卡住不动、每帧闪烁、
 * 同输入两次渲出不一样 —— 这些肉眼抽帧最容易漏，观众一眼就看见。
 *
 * 零新依赖：像素运算借 Chromium 自己解码（不引 numpy / PIL / sharp）。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────
 *   NODE_PATH=<node工作区>/node_modules node qa.js <html-file> [选项]
 *   bash ../qa.sh animation.html            # 自动读 ~/.workbuddy/.html2video-env
 *
 * 时间
 *   --duration=10          动画总时长（要和渲染时的 --duration 一致）
 *   --from=0 --to=<sec>    只验收这段
 *   --fps=30               采样帧率（越高越细，越慢）
 *   --samples=120          采样帧数上限（跳到 0.1s 以内，跳变判据才准）
 *   --skip=0.35            每段开头跳过的秒数（出场的镜头冲击不算问题）
 *
 * 画面
 *   --width=1920 --height=1080
 *   --settle=2             seek 后等几个 rAF 再截图
 *   --safe-bottom=0.15     画面底部这个比例内出现文字 → 警告「进字幕带」（烧录字幕会盖住）；0 关掉
 *   --keep-chrome          不隐藏播放控件（默认隐藏，和渲染器一致）
 *   --no-serve             用 file:// 加载（默认走本地 http server，和渲染器一致；
 *                          两者必须同源加载，否则 QA 看到的和成片不是一回事）
 *
 * 产物
 *   --out=<dir>            报告目录，默认 <html目录>/qa
 *
 * ── 确定性怎么验 ──────────────────────────────────────────────────
 *   在时间轴上抽 3 个时刻（首 / 中 / 末），各做两轮比对：
 *     · 热比对：同一个页面 seek 回去再截 —— 验「累积状态」污染
 *     · 冷比对：全新页面 seek 到同一时刻 —— 验「随机初始化」不一致
 *   任一时刻、任一轮有像素差就判不确定。以前只验最后一个采样时刻，
 *   随机数恰好在那帧稳定就漏检了 —— 所以别嫌它多花一次页面加载。
 *
 * ── 判据的脾气（经验阈值，不是规则）─────────────────────────────────
 *   运动 0.5%–8% 之间多数画面好看；最长静止 ≥3s 会提示（有意定格可以忽略）；
 *   跳变 > 0 先去看那一帧再判断（有意的节拍闪不算错）；
 *   框景线索都是「去看这一帧」的提示，不让 QA 失败，只有页面报错才判失败。
 *
 * ── 比对照的是缩小图 ────────────────────────────────────────────────
 *   截图在 CDP 层就缩到 480 宽（省掉 30 倍传输量），所以「运动%」是缩小后的
 *   像素占比，不是 1080p 原图的；判阈值时按这个口径看。
 *
 * ── 已知盲区（看报告时心里有数）─────────────────────────────────────
 *   ① 采样从 --skip 之后开始，段首和出场瞬间的问题看不到；
 *   ② 画进离屏 canvas 再 drawImage 上来的文字，外框追踪不到（只追直接 fillText/strokeText）；
 *   ③ 被图形挡住的文字查不到；两串都被盖住时可能误报「叠字」；
 *   ④ DOM 文字按行框量，一个 <p> 换行会算成两块。
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { HIDE_CHROME_CSS, hideChromeInit } = require('./lib/hide-chrome.cjs');
const { startServer } = require('./lib/local-server.cjs');

function arg(name, def) {
  const p = process.argv.find(a => a.startsWith('--' + name + '='));
  return p ? p.slice(name.length + 3) : def;
}
const hasFlag = name => process.argv.includes('--' + name);

const HTML_FILE = process.argv[2];
if (!HTML_FILE || HTML_FILE.startsWith('--')) {
  console.error('Usage: node qa.js <html-file> [options]');
  console.error('Example: NODE_PATH=$(npm root -g) node qa.js animation.html --duration=12 --fps=30');
  process.exit(1);
}

const DURATION = parseFloat(arg('duration', '10'));
const FROM     = Math.max(0, parseFloat(arg('from', '0')));
const TO_RAW   = arg('to', null);
const END      = TO_RAW !== null ? parseFloat(TO_RAW) : FROM + DURATION;
const FPS      = parseFloat(arg('fps', '30'));
const MAXSAMP  = parseInt(arg('samples', '120'));
const SKIP     = parseFloat(arg('skip', '0.35'));
const WIDTH    = parseInt(arg('width', '1920'));
const HEIGHT   = parseInt(arg('height', '1080'));
const SETTLE   = Math.max(1, parseInt(arg('settle', '2')));
const SAFE_BOTTOM = parseFloat(arg('safe-bottom', '0.15'));   // 底部 15% 视为字幕带
const KEEP_CHROME = hasFlag('keep-chrome');
const NO_SERVE    = hasFlag('no-serve');   // 加载方式必须和渲染器一致，否则验的不是同一个东西

const HTML_ABS = path.resolve(HTML_FILE);
const BASENAME = path.basename(HTML_FILE, path.extname(HTML_FILE));
const OUT_DIR  = path.resolve(arg('out', path.join(path.dirname(HTML_ABS), 'qa')));

/* ── 页内：文字外框钩子 ────────────────────────────────────────────
 * 包一层 fillText/strokeText，记下每个字符串画到屏幕上的外框（含当前变换）。
 * 只记「直接画」的；画进离屏缓冲再 drawImage 上来的记不到（见文件头的盲区②）。
 */
const TEXT_HOOK = `(() => {
  const P = CanvasRenderingContext2D.prototype;
  const sv = P.save, rs = P.restore, cl = P.clip, cr = P.clearRect, fr = P.fillRect;
  // 记住「当前有没有 clip」：滚动数字、按笔顺揭开的字画在 clip 里，外框比看得见的大，
  // 不拿去判叠字（否则假阳性一片）
  P.save = function () { (this.__cs || (this.__cs = [])).push(!!this.__clip); return sv.apply(this, arguments); };
  P.restore = function () { if (this.__cs && this.__cs.length) this.__clip = this.__cs.pop(); return rs.apply(this, arguments); };
  P.clip = function () { this.__clip = true; return cl.apply(this, arguments); };
  const full = (ctx, x, y, w, h) => {
    const T = ctx.getTransform(); if (T.b !== 0 || T.c !== 0) return false;
    const xs = [T.a * x + T.e, T.a * (x + w) + T.e], ys = [T.d * y + T.f, T.d * (y + h) + T.f];
    return Math.min(...xs) <= 0 && Math.min(...ys) <= 0 && Math.max(...xs) >= ctx.canvas.width && Math.max(...ys) >= ctx.canvas.height;
  };
  P.clearRect = function (x, y, w, h) { if (full(this, x, y, w, h)) this.canvas.__tb = []; return cr.apply(this, arguments); };
  P.fillRect = function (x, y, w, h) { if (full(this, x, y, w, h)) this.canvas.__tb = []; return fr.apply(this, arguments); };
  for (const k of ['width', 'height']) {
    const d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, k);
    Object.defineProperty(HTMLCanvasElement.prototype, k, { get: d.get, set(v) { this.__tb = []; d.set.call(this, v); }, configurable: true });
  }
  const push = (ctx, rec) => {
    const L = ctx.canvas.__tb || (ctx.canvas.__tb = []);
    L.push(rec); if (L.length > 6000) L.splice(0, 3000);
  };
  for (const fn of ['fillText', 'strokeText']) {
    const orig = P[fn];
    P[fn] = function (text, x, y, maxW) {
      if (this.globalAlpha > 0.15 && String(text).trim()) {
        const m = this.measureText(text), T = this.getTransform();
        let x0 = x - m.actualBoundingBoxLeft, x1 = x + m.actualBoundingBoxRight;
        if (maxW && x1 - x0 > maxW) x1 = x0 + maxW;
        const y0 = y - m.actualBoundingBoxAscent, y1 = y + m.actualBoundingBoxDescent;
        const xs = [], ys = [];
        for (const [px, py] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
          xs.push(T.a * px + T.c * py + T.e); ys.push(T.b * px + T.d * py + T.f);
        }
        push(this, [String(text).slice(0, 24), xs, ys, !!this.__clip]);
      }
      return orig.apply(this, arguments);
    };
  }
})();`;

/* ── 页内：seek 一帧并回收文字外框 ─────────────────────────────── */
async function captureFrame([t, settle]) {
  document.querySelectorAll('canvas').forEach(c => { c.__tb = []; });
  window.__seek(t);
  await new Promise(res => { let i = 0; const s = () => { i++; i >= settle ? res() : requestAnimationFrame(s); }; requestAnimationFrame(s); });
  const W = innerWidth, H = innerHeight, out = [];
  document.querySelectorAll('canvas').forEach(c => {
    const L = c.__tb || [];
    if (!L.length) return;
    const r = c.getBoundingClientRect();
    const kx = c.width ? r.width / c.width : 1, ky = c.height ? r.height / c.height : 1;
    for (const [txt, xs, ys, clipped] of L) {
      const X = xs.map(v => (r.left + v * kx) / W), Y = ys.map(v => (r.top + v * ky) / H);
      out.push([txt, Math.min(...X), Math.min(...Y), Math.max(...X), Math.max(...Y), !!clipped]);
    }
  });
  // DOM 文字：按行框取（渲染器支持 DOM/CSS 动画，fillText 钩子看不到这些）
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const s = node.nodeValue;
    if (!s || !s.trim()) continue;
    const p = node.parentElement;
    if (!p) continue;
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) continue;
    if (p.closest('[data-video-hidden]')) continue;
    const cs = getComputedStyle(p);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) {
      if (r.width < 8 || r.height < 8) continue;
      out.push([s.trim().slice(0, 24), r.left / W, r.top / H, r.right / W, r.bottom / H, false]);
    }
  }
  return out;
}

/* ── 页内：字体可用性 + 字形自检 ──────────────────────────────────
 * 缺字形是「静默失败」：canvas 会悄悄回退到别的字体，画面变样但没人报错。
 * 这里做两件事：
 *   1. document.fonts.check 查 CSS 里声明的 family 在不在
 *   2. 对比测量法查回退：同一个字用「目标字体」和「不存在的字体」量宽度，
 *      一样宽说明目标字体根本没生效
 */
function fontCheck() {
  const out = { families: [], fallback: [], missing: [] };
  const fams = new Set();
  document.querySelectorAll('*').forEach(el => {
    const f = getComputedStyle(el).fontFamily;
    if (!f) return;
    f.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      .forEach(x => { if (!/^(sans-serif|serif|monospace|cursive|fantasy|system-ui|ui-|inherit|initial|unset)$/i.test(x)) fams.add(x); });
  });
  const probe = '中文Aa1';
  const c = document.createElement('canvas').getContext('2d');
  const width = (family) => { c.font = '40px ' + family; return c.measureText(probe).width; };
  const ghost = width('"__WB_NoSuchFont__", monospace');
  for (const f of fams) {
    let ok = true;
    try { ok = document.fonts.check('40px "' + f + '"'); } catch (e) { ok = true; }
    out.families.push([f, ok]);
    if (!ok) out.missing.push(f);
    else if (Math.abs(width('"' + f + '", monospace') - ghost) < 0.01) out.fallback.push(f);
  }
  return out;
}

/* ── 页内（辅助页）：解码截图、缩放、逐像素比对、出热图 ─────────── */
const HELPER_SETUP = (w) => {
  window.__w = w;
  window.__frames = [];
  window.addFrame = (b64) => new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const h = Math.max(1, Math.round(window.__w * img.height / img.width));
      const c = document.createElement('canvas');
      c.width = window.__w; c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, window.__w, h);
      window.__frames.push(g.getImageData(0, 0, window.__w, h).data);
      res(window.__frames.length - 1);
    };
    img.onerror = rej;
    img.src = 'data:image/png;base64,' + b64;
  });
  // 相邻两帧差异像素占比（%）；max-channel 差 > 12 记一个
  window.diffPct = (i, j) => {
    const a = window.__frames[i], b = window.__frames[j];
    if (!a || !b) return null;
    let cnt = 0, total = 0;
    for (let k = 0; k < a.length; k += 4) {
      const d = Math.max(Math.abs(a[k] - b[k]), Math.abs(a[k + 1] - b[k + 1]), Math.abs(a[k + 2] - b[k + 2]));
      if (d > 12) cnt++;
      total++;
    }
    return cnt / total * 100;
  };
  // 最大通道差（0–255），用于确定性判定
  window.maxDiff = (i, j) => {
    const a = window.__frames[i], b = window.__frames[j];
    if (!a || !b) return null;
    let m = 0;
    for (let k = 0; k < a.length; k += 4) {
      const d = Math.max(Math.abs(a[k] - b[k]), Math.abs(a[k + 1] - b[k + 1]), Math.abs(a[k + 2] - b[k + 2]));
      if (d > m) m = d;
    }
    return m;
  };
  // 近空白：与画面主色（各通道中位数）差 >24 的像素占比 <0.3%
  window.nearBlank = (i) => {
    const f = window.__frames[i];
    if (!f) return false;
    const px = [];
    for (let k = 0; k < f.length; k += 8) px.push([f[k], f[k + 1], f[k + 2]]);   // 每 2 像素采一个
    const med = [0, 1, 2].map(ch => {
      const v = px.map(p => p[ch]).sort((x, y) => x - y);
      return v[Math.floor(v.length / 2)];
    });
    let cnt = 0;
    for (const p of px) if (Math.max(Math.abs(p[0] - med[0]), Math.abs(p[1] - med[1]), Math.abs(p[2] - med[2])) > 24) cnt++;
    return cnt / px.length < 0.003;
  };
  // 全段运动热图（相邻帧差累加），返回 PNG dataURL
  window.heatmap = (from, to) => {
    const n = window.__frames.length;
    if (n < 2) return null;
    const h = window.__frames[0].length / 4 / window.__w;
    const acc = new Float32Array(window.__w * h);
    const lo = from == null ? 0 : from, hi = to == null ? n - 1 : to;
    for (let i = lo + 1; i <= hi; i++) {
      const a = window.__frames[i - 1], b = window.__frames[i];
      for (let p = 0, k = 0; k < a.length; k += 4, p++) {
        const d = Math.max(Math.abs(a[k] - b[k]), Math.abs(a[k + 1] - b[k + 1]), Math.abs(a[k + 2] - b[k + 2]));
        if (d > 12) acc[p]++;
      }
    }
    let mx = 1; for (let i = 0; i < acc.length; i++) if (acc[i] > mx) mx = acc[i];
    const c = document.createElement('canvas'); c.width = window.__w; c.height = h;
    const g = c.getContext('2d');
    const id = g.createImageData(window.__w, h);
    // 底图取第一帧灰度，热区叠加红色
    const base = window.__frames[lo];
    for (let p = 0, k = 0; p < acc.length; p++, k += 4) {
      const gray = (base[k] * 0.3 + base[k + 1] * 0.59 + base[k + 2] * 0.11) * 0.45;
      const heat = acc[p] / mx;
      id.data[k]     = Math.min(255, gray + heat * 235);
      id.data[k + 1] = gray * (1 - heat * 0.55);
      id.data[k + 2] = gray * (1 - heat * 0.55);
      id.data[k + 3] = 255;
    }
    g.putImageData(id, 0, 0);
    return c.toDataURL('image/png');
  };
};

/* ── 框景判定（纯几何，移植自 huashu qa.py 的算法，去掉 numpy） ── */
function frameIssues(boxes, band) {
  const out = [], vis = [];
  for (const [txt, x0, y0, x1, y1, clipped] of boxes) {
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0 || h < 0.008) continue;              // 太小（<~9px）不管
    const ix0 = Math.max(x0, 0), iy0 = Math.max(y0, 0);
    const ix1 = Math.min(x1, 1), iy1 = Math.min(y1, 1);
    if (ix1 <= ix0 || iy1 <= iy0) continue;                    // 整个在画外（镜头没拍到）
    const frac = (ix1 - ix0) * (iy1 - iy0) / (w * h);
    if (frac < 0.9 && frac > 0.1) out.push(['半截字', txt]);
    if (band > 0 && iy1 > 1 - band + 0.004 && frac > 0.1) out.push(['进字幕带', txt]);
    if (!clipped) vis.push([txt, x0, y0, x1, y1]);
  }
  // 叠字：两串不同的字外框重叠面积占小块面积 > 30%
  for (let i = 0; i < vis.length; i++) {
    for (let j = i + 1; j < vis.length; j++) {
      const A = vis[i], B = vis[j];
      if (A[0] === B[0]) continue;                             // 同一串画两遍（描边＋填色、投影）
      const ow = Math.min(A[3], B[3]) - Math.max(A[1], B[1]);
      const oh = Math.min(A[4], B[4]) - Math.max(A[2], B[2]);
      if (ow <= 0 || oh <= 0) continue;
      const small = Math.min((A[3] - A[1]) * (A[4] - A[2]), (B[3] - B[1]) * (B[4] - B[2]));
      if (small > 0 && ow * oh / small > 0.3) out.push(['叠字', A[0] + '｜' + B[0]]);
    }
  }
  return out;
}
/** 同一个问题连续出现够久才报（镜头摇过去那几帧的半截字是正常的）。
 *  minS 跟着采样间隔走：采得稀时报得保守些，免得把一帧的偶然当问题。
 *  单帧闪一下就过的穿帮交给「跳变」指标，不在这里报。 */
function persistent(ts, perFrame, minS) {
  const runs = [], open = new Map();
  perFrame.forEach((list, k) => {
    const cur = new Set(list.map(x => x[0] + '\u0000' + x[1]));
    for (const key of [...open.keys()]) {
      if (!cur.has(key)) {
        const [t0, t1] = open.get(key); open.delete(key);
        if (t1 - t0 >= minS) runs.push([key, t0, t1]);
      }
    }
    for (const key of cur) {
      if (open.has(key)) open.set(key, [open.get(key)[0], ts[k]]);
      else open.set(key, [ts[k], ts[k]]);
    }
  });
  for (const [key, [t0, t1]] of open) if (t1 - t0 >= minS) runs.push([key, t0, t1]);
  return runs.sort((a, b) => a[1] - b[1]).map(([k, t0, t1]) => {
    const [kind, txt] = k.split('\u0000');
    return { kind, text: txt, lt: [+t0.toFixed(2), +t1.toFixed(2)] };
  });
}
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

(async () => {
  const t0 = Date.now();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const errors = [];
  const pageErrors = [];
  const warns = [];

  console.log(`▸ QA: ${HTML_FILE}`);
  console.log(`  ${WIDTH}x${HEIGHT} · ${FROM}–${END}s · ${FPS}fps 采样 · 段首跳过 ${SKIP}s`);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });
  await context.addInitScript(() => { window.__recording = true; window.__seekRender = true; });
  await context.addInitScript(TEXT_HOOK);
  if (!KEEP_CHROME) await context.addInitScript(hideChromeInit, HIDE_CHROME_CSS);

  const page = await context.newPage();
  page.on('pageerror', e => { const s = String(e && e.message || e); errors.push('pageerror: ' + s); pageErrors.push(s); });
  page.on('console', m => {
    if (m.type() === 'error') { errors.push('console.error: ' + m.text()); pageErrors.push(m.text()); }
    else if (m.type() === 'warning') warns.push(m.text());
  });

  // 和渲染器同源加载：渲染器默认走本地 http，QA 也走，否则验的不是同一个东西
  let server = null;
  let targetUrl = 'file://' + HTML_ABS;
  if (!NO_SERVE) {
    try {
      server = await startServer();
      targetUrl = server.url(HTML_ABS);
    } catch (e) {
      console.warn(`⚠ 本地 http server 起不来，退回 file://：${String((e && e.message) || e)}`);
      server = null;
    }
  }

  await page.goto(targetUrl, { waitUntil: 'load', timeout: 60000 });

  let ready = true;
  // 签名是 waitForFunction(fn, arg, options)：arg 排第二，options 排第三。
  // 写成 waitForFunction(fn, {timeout}) 会把 options 当成传给页面的 arg，超时永远走默认 30s。
  try {
    await page.waitForFunction(() => window.__ready === true || !!window.__bootFailed, null, { timeout: 30000 });
  } catch (e) { ready = false; }
  const bootFailed = ready ? await page.evaluate(() => window.__bootFailed || null) : null;

  if (!ready || bootFailed || !(await page.evaluate(() => typeof window.__seek === 'function'))) {
    console.error('✗ 渲染契约没就绪：需要 window.__ready = true 且 window.__seek 是函数。');
    if (bootFailed) console.error('  页面自报启动失败：' + bootFailed);
    console.error('  参考 assets/animation-skeleton.html 的「渲染契约」段。');
    console.error(`  加载方式：${server ? 'http' : 'file://'}。若页面用了 ESM / fetch，别加 --no-serve。`);
    await browser.close();
    if (server) { try { await server.close(); } catch (e) { /* 忽略 */ } }
    process.exit(1);
  }
  console.log('  [OK] __seek 契约就绪');

  /* 字体自检 */
  const fonts = await page.evaluate(fontCheck).catch(() => null);
  if (fonts) {
    if (fonts.missing.length) console.log('  ⚠ 字体不可用（会悄悄回退，换机器画面就变）：' + fonts.missing.join('、'));
    if (fonts.fallback.length) console.log('  ⚠ 疑似未生效（宽度与兜底字体一致）：' + fonts.fallback.join('、'));
    if (!fonts.missing.length && !fonts.fallback.length && fonts.families.length) {
      console.log('  [OK] 字体可用：' + fonts.families.slice(0, 6).join(' / '));
    }
  }

  /* 辅助页：只做像素解码与比对，不跑动画 */
  const hctx = await browser.newContext();
  const helper = await hctx.newPage();
  await helper.setContent('<html><body></body></html>');
  const SCALE_W = 480;                       // 比对用的缩放宽度
  await helper.evaluate(HELPER_SETUP, SCALE_W);

  /* 截图在 CDP 层就缩放（Page.captureScreenshot 的 clip.scale）：
     1920×1080 的 PNG 一张 1MB 上下，传 30 张要 30MB；缩到 480 宽后只剩几十 KB。
     不行就退回整尺寸截图（helper 里再缩放，只是慢一点）。
     CDP 会话绑在 page 上，所以做成参数 —— 冷启动页要用另一条。 */
  const newCdp = async (pg) => { try { return await pg.context().newCDPSession(pg); } catch (e) { return null; } };

  const grabPng = async (pg, cdpSess) => {
    if (cdpSess) {
      try {
        const r = await cdpSess.send('Page.captureScreenshot', {
          format: 'png',
          clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: SCALE_W / WIDTH },
        });
        if (r && r.data) return r.data;
      } catch (e) { /* 落到整尺寸 */ }
    }
    const buf = await pg.screenshot({ clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
    return buf.toString('base64');
  };

  /* 采样时刻 */
  const lt0 = SKIP;
  const lt1 = Math.max(lt0 + 0.2, END - FROM - 0.02);
  const n = Math.min(MAXSAMP, Math.max(4, Math.round((lt1 - lt0) * FPS)));
  const ts = Array.from({ length: n }, (_, i) => FROM + lt0 + (lt1 - lt0) * i / (n - 1));
  const spacing = n > 1 ? (lt1 - lt0) / (n - 1) : 0.5;   // 相邻采样间隔（秒）
  if (spacing > 0.15) {
    // 采样太稀时，一段快速位移在相邻两帧之间看着就像「跳」——是采样假象，不是穿帮
    console.log(`  ⚠ 采样间隔 ${spacing.toFixed(2)}s 偏大，跳变可能误报。建议 --samples=${Math.min(600, Math.ceil((lt1 - lt0) / 0.1))}（或提高 --fps）覆盖到 ≤0.1s`);
  }

  const makeShot = (pg, cdpSess) => async (t) => {
    const ms0 = Date.now();
    const boxes = await pg.evaluate(captureFrame, [t, SETTLE]);
    const ms = Date.now() - ms0;
    const b64 = await grabPng(pg, cdpSess);
    const idx = await helper.evaluate(b => window.addFrame(b), b64);
    return { ms, boxes, idx, t };
  };
  const shot = makeShot(page, await newCdp(page));

  /* 确定性采样点：首 / 中 / 末（去重）。
     以前只在最后一个采样时刻验一次 —— 随机数恰好在那帧稳定就漏检了，这是真盲区。
     分散到多个时刻，混在中间的随机性才藏不住。 */
  const detIdx = [...new Set(n >= 3 ? [0, Math.floor((n - 1) / 2), n - 1] : [n - 1])];
  const detTs = detIdx.map(i => ts[i]);

  const frames = [], costMs = [], boxSets = [];
  for (const t of ts) {
    const r = await shot(t);
    frames.push(r.idx); costMs.push(r.ms); boxSets.push(r.boxes);
  }
  // 热比对：同一个页面 seek 回去再截 —— 验「累积状态」污染（改了全局变量没复原之类）
  const hotShots = [];
  for (const t of detTs) hotShots.push(await shot(t));

  /* 冷比对：全新页面（JS 状态归零）seek 到同样的时刻 —— 验「随机初始化」不一致。
     只多一次页面加载，比逐点重开页面便宜得多。 */
  const coldShots = [];
  {
    const cp = await context.newPage();
    cp.on('pageerror', e => { const s = String(e && e.message || e); errors.push('pageerror: ' + s); pageErrors.push(s); });
    cp.on('console', m => {
      if (m.type() === 'error') { errors.push('console.error: ' + m.text()); pageErrors.push(m.text()); }
      else if (m.type() === 'warning') warns.push(m.text());
    });
    await cp.goto(targetUrl, { waitUntil: 'load', timeout: 60000 });
    await cp.waitForFunction(() => window.__ready === true || !!window.__bootFailed, null, { timeout: 30000 });
    const bf = await cp.evaluate(() => window.__bootFailed || null);
    if (bf) errors.push('cold page __bootFailed: ' + bf);
    if (!(await cp.evaluate(() => typeof window.__seek === 'function'))) {
      console.error('✗ 冷启动页没有 window.__seek，确定性验不了。');
      await browser.close();
      if (server) { try { await server.close(); } catch (e) { /* 忽略 */ } }
      process.exit(1);
    }
    const shotCold = makeShot(cp, await newCdp(cp));
    for (const t of detTs) coldShots.push(await shotCold(t));
    await cp.close();
  }

  /* 指标 */
  const diffs = [];
  for (let i = 1; i < frames.length; i++) diffs.push(await helper.evaluate(([a, b]) => window.diffPct(a, b), [frames[i - 1], frames[i]]));
  let detMax = 0;
  const detBad = [];
  for (let k = 0; k < detTs.length; k++) {
    const i = detIdx[k];
    const dH = await helper.evaluate(([a, b]) => window.maxDiff(a, b), [frames[i], hotShots[k].idx]);
    const dC = await helper.evaluate(([a, b]) => window.maxDiff(a, b), [frames[i], coldShots[k].idx]);
    const d = Math.max(dH || 0, dC || 0);
    if (d > detMax) detMax = d;
    if (d > 0) detBad.push({ t: +detTs[k].toFixed(3), hot: dH, cold: dC });
  }
  const blanks = [];
  for (const idx of frames) blanks.push(await helper.evaluate(i => window.nearBlank(i), idx));

  const med = median(diffs);
  // 只认「孤立」的跳：跟它前后各 3 对的典型变化量比。
  // 数字快速滚动、大幅推镜这类连续快动作会被邻域基线一起抬高，不该报——那不是穿帮。
  // 参考基线兜底到 0.5%：全片大部分静止时中位数≈0，不兜底会把正常的入场都报成跳变。
  const neigh = (i) => {
    const nb = [];
    for (let k = Math.max(0, i - 3); k < i; k++) nb.push(diffs[k]);
    for (let k = i + 1; k <= Math.min(diffs.length - 1, i + 3); k++) nb.push(diffs[k]);
    return nb.length ? median(nb) : 0;
  };
  const spikes = [];
  diffs.forEach((d, i) => { if (d > 3 && d > 6 * Math.max(neigh(i), 0.5)) spikes.push(+ts[i + 1].toFixed(3)); });
  // 保留全片中位数，写进报告备查
  const medianPct = +med.toFixed(2);
  const stillPct = diffs.length ? diffs.filter(d => d < 0.05).length / diffs.length * 100 : 100;
  // 最长连续静止时长：比「静止比例」可操作 —— 「停住 4.2 秒」直接告诉你该不该剪
  let stillRun = 0, run = 0;
  for (const d of diffs) { if (d < 0.05) { run++; if (run > stillRun) stillRun = run; } else run = 0; }
  const stillRunS = +(stillRun * spacing).toFixed(2);

  /* 框景：把两轮取帧的文字外框按时间归并（同 t 取过两次，去重） */
  const minS = Math.max(0.25, spacing * 1.5);
  const perFrame = boxSets.map(b => frameIssues(b, SAFE_BOTTOM));
  const framing = persistent(ts, perFrame, minS);
  const blanksRun = persistent(ts, blanks.map(b => (b ? [['近空白', '']] : [])), minS);

  const report = {
    html: HTML_ABS, size: [WIDTH, HEIGHT], range: [FROM, END], fps: FPS, samples: n,
    metrics: {
      motion_pct: +mean(diffs).toFixed(2),
      motion_max: diffs.length ? +Math.max(...diffs).toFixed(2) : 0,
      still_pairs_pct: +stillPct.toFixed(1),
      still_run_s: stillRunS,
      median_pct: medianPct,
      spike_ratio: +(diffs.length ? Math.max(...diffs) / Math.max(medianPct, 0.5) : 0).toFixed(1),
      spikes_at: spikes,
      ms_mean: +mean(costMs).toFixed(1),
      ms_max: Math.max(...costMs),
      deterministic: detMax === 0,
      det_maxdiff: detMax,
      det_points: detTs.length,
      det_checked_at: detTs.map(t => +t.toFixed(3)),
      det_failed_at: detBad,
    },
    framing: framing.concat(blanksRun).sort((a, b) => a.lt[0] - b.lt[0]),
    text_boxes_tracked: boxSets.reduce((a, b) => a + b.length, 0),
    fonts: fonts || null,
    page_errors: errors,
    warnings: warns,
    warnings_note: warns.length ? 'console.warn 不计入失败，但值得看一眼' : '',
  };

  /* 热图 */
  let heatPath = null;
  const heatUrl = await helper.evaluate(() => window.heatmap(0, null));
  if (heatUrl) {
    heatPath = path.join(OUT_DIR, BASENAME + '.heat.png');
    fs.writeFileSync(heatPath, Buffer.from(heatUrl.split(',')[1], 'base64'));
  }
  await browser.close();
  if (server) { try { await server.close(); } catch (e) { /* 忽略 */ } }

  const m = report.metrics;
  const verdict = [];
  if (stillRunS >= 3) verdict.push(`最长静止 ${stillRunS}s：画面连续 ${stillRunS} 秒完全不动。有意定格（数据图待读）可以忽略；否则补一点持续微动（慢速光扫/呼吸）或把片子剪短`);
  if (m.motion_pct > 8) verdict.push('运动偏大：' + m.motion_pct + '%（>8% 可能太闹）');
  if (spikes.length) verdict.push('有跳变：' + spikes.slice(0, 5).join(', ') + 's —— 去看那几帧再判断');
  if (!m.deterministic) {
    const bad = m.det_failed_at || [];
    const at = bad.map(x => x.t + 's').join(', ');
    verdict.push('不确定：验了 ' + m.det_points + ' 个时刻，' + bad.length + ' 处两次渲有像素差'
      + (at ? '（' + at + '）' : '') + '（max ' + m.det_maxdiff + '）—— 画面里混进了随机数/Date/时间累积状态');
  }
  if (report.framing.length) verdict.push('框景线索 ' + report.framing.length + ' 条 —— 逐条看时间点');
  if (errors.length) verdict.push('页面报错 ' + errors.length + ' 条');

  const rows = [
    '# QA 报告 · ' + path.basename(HTML_ABS),
    '',
    `规格：${WIDTH}×${HEIGHT} · ${FROM}–${END}s · ${FPS}fps 采样 ${n} 帧 · ${new Date().toISOString()}`,
    '',
    '| 运动% | 最长静止 s | 静止帧对% | 跳变 | 均/峰 ms | 确定性 | 框景 | 页面报错 |',
    '|---|---|---|---|---|---|---|---|',
    `| ${m.motion_pct} | ${m.still_run_s} | ${stillPct.toFixed(1)} | ${spikes.length} | ${m.ms_mean}/${m.ms_max} | ${m.deterministic ? '✓' : '✗ ' + m.det_maxdiff} | ${report.framing.length} | ${errors.length} |`,
  ];
  if (verdict.length) rows.push('', '## 结论', ...verdict.map(v => '- ' + v));
  if (report.framing.length) {
    rows.push('', `## 框景线索（持续 ≥${minS.toFixed(2)}s；去看这一帧再判断）`);
    report.framing.forEach(f => rows.push(`- ${f.kind} t=${f.lt[0]}–${f.lt[1]}s　${f.text}`));
  }
  if (fontWarned(report)) rows.push('', '## 字体', ...[report.fonts.missing.map(f => '- ⚠ 不可用：' + f), report.fonts.fallback.map(f => '- ⚠ 疑似未生效：' + f)].flat());
  if (warns.length) rows.push('', '## console.warn', ...warns.slice(0, 20).map(w => '- ' + w));
  if (errors.length) rows.push('', '## 页面报错', ...errors.slice(0, 30).map(e => '- ' + e));
  rows.push('', '> 判据是经验阈值不是规则。运动 0.5%–8% 多数好看；跳变 >0 先看帧；框景线索是「去看一眼」的提示，不是错误。');

  fs.writeFileSync(path.join(OUT_DIR, 'qa.json'), JSON.stringify(report, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, 'qa.md'), rows.join('\n') + '\n');

  const pad = (s, w) => String(s).padEnd(w);
  console.log('');
  console.log('  ' + pad('运动%', 9) + pad('最长静止s', 11) + pad('静止帧对%', 11) + pad('跳变', 7) + pad('均/峰ms', 12) + pad('确定性', 8) + pad('框景', 6) + '报错');
  console.log('  ' + pad(m.motion_pct, 9) + pad(m.still_run_s, 11) + pad(stillPct.toFixed(1), 11) + pad(spikes.length, 7) + pad(m.ms_mean + '/' + m.ms_max, 12) + pad(m.deterministic ? '✓' : '✗', 8) + pad(report.framing.length, 6) + errors.length);
  if (report.framing.length) {
    console.log('');
    report.framing.forEach(f => console.log(`  · ${f.kind}  t=${f.lt[0]}–${f.lt[1]}s  ${f.text}`));
  }
  if (verdict.length) { console.log(''); verdict.forEach(v => console.log('  → ' + v)); }
  console.log('');
  console.log(`  报告：${path.join(OUT_DIR, 'qa.md')}`);
  if (heatPath) console.log(`  热图：${heatPath}`);
  console.log(`  用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  if (errors.length) {
    console.error(`\n✗ 页面运行时报错 ${errors.length} 条，见 qa.md`);
    process.exit(1);
  }
})();

/* 字体有没有值得写进报告的问题 */
function fontWarned(report) {
  return report.fonts && ((report.fonts.missing && report.fonts.missing.length) || (report.fonts.fallback && report.fonts.fallback.length));
}
