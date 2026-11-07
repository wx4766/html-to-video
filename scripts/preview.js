#!/usr/bin/env node
/**
 * preview.js · 浏览器里"拖时间轴"看片子
 * ---------------------------------------------------------------------------
 * 逐帧渲染最反直觉的一点：改一句文案也要等几分钟才知道好不好看。
 * 但页面本身暴露了 `window.__seek(t)` —— 它就是一台"时间机器"：
 * 在浏览器里按同一个契约推帧，看到的就是渲染器将要截到的画面。
 *
 * 所以这个脚本做的事很简单：
 *   起本地 http（ESM / fetch 都能跑）→ 套一层带时间轴的外壳 → 把目标页面放进 iframe
 *   拖时间轴 / 按空格播放 / 按 ←→ 单帧步进 → 每帧直接调 iframe 里的 __seek(t)
 *
 * 为什么不做成截图流：截图是"结果"，这里是"过程"。
 * 调版式时想看的是"第 2.4 秒那一下"，不是"再渲一遍 2.4 秒的静帧"。
 *
 * 用法：
 *   node scripts/preview.js my-video.html --duration=8
 *   node scripts/preview.js my-video.html --duration=8 --fps=60 --open
 *   node scripts/preview.js my-video.html --duration=8 --story=shots.json --theme=vox
 *
 * 说明：外壳只是个 iframe + 滑块，不注入任何东西到你的页面里；
 * 关掉终端（Ctrl+C）服务器就停。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('./lib/local-server.cjs');

function arg(name, def) {
  const p = process.argv.find((a) => a.startsWith('--' + name + '='));
  return p ? p.slice(name.length + 3) : def;
}
const hasFlag = (n) => process.argv.includes('--' + n);

const FILE = process.argv[2];
if (!FILE || FILE.startsWith('--')) {
  console.error('用法: node scripts/preview.js <html> [--duration=8] [--fps=60] [--open]');
  process.exit(1);
}

const ABS = path.resolve(FILE);
if (!fs.existsSync(ABS)) {
  console.error(`✗ 找不到文件：${ABS}`);
  process.exit(1);
}
const DURATION = Math.max(0.2, parseFloat(arg('duration', '8')) || 8);
/* 画布比例：默认 16:9。竖屏项目用 --size=1080x1920，否则预览框是横的，
   模板按 16:9 排版，你却在竖屏里看 —— 会误判成"版式崩了"。 */
const SIZE_RAW = String(arg('size', '1920x1080')).toLowerCase();
const SIZE = (() => {
  const m = /^(\d+)x(\d+)$/.exec(SIZE_RAW);
  if (!m) { console.warn(`⚠ --size 要形如 1080x1920（收到 "${SIZE_RAW}"），按 1920x1080 预览`); return { w: 1920, h: 1080 }; }
  return { w: Math.max(64, +m[1]), h: Math.max(64, +m[2]) };
})();
const FPS = Math.max(1, parseInt(arg('fps', '60'), 10) || 60);
const THEME = arg('theme', null);
const STORY = arg('story', null);

/* 外壳页面：所有依赖都走 CDN 会断网；这里全部手写，零外部资源。 */
function shellHtml(targetUrl, opts) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>预览 · ${path.basename(ABS)}</title>
<style>
  :root { --bg:#0A0C12; --panel:#121724; --ink:#E9EEF8; --sub:rgba(233,238,248,.55); --accent:#FFB86B; }
  * { box-sizing: border-box; }
  html,body { margin:0; height:100%; background:var(--bg); color:var(--ink);
    font:14px/1.5 "Microsoft YaHei","PingFang SC",system-ui,sans-serif; overflow:hidden; }
  #wrap { display:flex; flex-direction:column; height:100%; }
  #stage { flex:1; display:flex; align-items:center; justify-content:center; padding:18px; min-height:0; position:relative; }
  iframe { border:1px solid rgba(255,255,255,.10); border-radius:10px; background:#000;
    box-shadow:0 18px 60px rgba(0,0,0,.45); }
  #bar { display:flex; align-items:center; gap:14px; padding:14px 18px; background:var(--panel);
    border-top:1px solid rgba(255,255,255,.08); }
  button { background:rgba(255,255,255,.08); color:var(--ink); border:0; border-radius:8px;
    padding:8px 14px; font-size:13px; cursor:pointer; }
  button:hover { background:rgba(255,255,255,.16); }
  #play { min-width:74px; background:var(--accent); color:#1A1206; font-weight:700; }
  input[type=range] { flex:1; accent-color: var(--accent); }
  #tc { font-family:ui-monospace,Consolas,monospace; font-size:13px; color:var(--sub); min-width:132px; text-align:right; }
  #hint { color:var(--sub); font-size:12px; }
</style></head>
<body><div id="wrap">
  <div id="stage"><iframe id="cv" src="${targetUrl}"></iframe></div>
  <div id="bar">
    <button id="play">▶ 播放</button>
    <input id="seek" type="range" min="0" max="${opts.duration}" step="${1 / opts.fps}" value="0">
    <span id="tc">0.000s / ${opts.duration.toFixed(3)}s</span>
    <span id="hint">空格 播放/暂停 · ← → 单帧</span>
  </div>
</div>
<script>
const DUR = ${opts.duration}, FPS = ${opts.fps};
const frame = document.getElementById('cv');
const seek = document.getElementById('seek');
const tc = document.getElementById('tc');
const playBtn = document.getElementById('play');
let t = 0, playing = false, raf = null, last = 0;

function apply(v) {
  t = Math.max(0, Math.min(DUR, v));
  seek.value = t;
  tc.textContent = t.toFixed(3) + 's / ' + DUR.toFixed(3) + 's';
  try {
    const w = frame.contentWindow;
    if (w && typeof w.__seek === 'function') w.__seek(t);
  } catch (e) { /* 页面还没就绪 */ }
}

function tick(now) {
  if (!playing) return;
  if (!last) last = now;
  const dt = (now - last) / 1000; last = now;
  let next = t + dt;
  if (next > DUR) { next = DUR; playing = false; playBtn.textContent = '▶ 播放'; }
  apply(next);
  if (playing) raf = requestAnimationFrame(tick);
}

function toggle() {
  playing = !playing;
  last = 0;
  playBtn.textContent = playing ? '❚❚ 暂停' : '▶ 播放';
  if (playing) { if (t >= DUR) t = 0; raf = requestAnimationFrame(tick); }
  else if (raf) cancelAnimationFrame(raf);
}

playBtn.onclick = toggle;
seek.oninput = (e) => { if (playing) toggle(); apply(parseFloat(e.target.value)); };
addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); toggle(); }
  if (e.code === 'ArrowRight') { e.preventDefault(); if (playing) toggle(); apply(t + 1 / FPS); }
  if (e.code === 'ArrowLeft') { e.preventDefault(); if (playing) toggle(); apply(t - 1 / FPS); }
});
/* 让 iframe 按目标画布比例填满可用空间 —— iframe 不写宽高就是 300×150，
   那尺寸下模板会按 300px 宽重新排版，看到的构图完全不是成片的样子。 */
const ASPECT = ${opts.w} / ${opts.h};
function fitFrame() {
  const box = document.getElementById('stage');
  const pad = 36;
  const availW = box.clientWidth - pad, availH = box.clientHeight - pad;
  let w = availW, h = w / ASPECT;
  if (h > availH) { h = availH; w = h * ASPECT; }
  frame.style.width = Math.max(160, Math.round(w)) + 'px';
  frame.style.height = Math.max(90, Math.round(h)) + 'px';
}
addEventListener('resize', fitFrame);
fitFrame();

frame.addEventListener('load', () => { fitFrame(); apply(t); });
apply(0);
</script></body></html>`;
}

(async () => {
  let srv;
  try {
    srv = await startServer();
  } catch (e) {
    console.error('✗ 本地服务器起不来：' + String((e && e.message) || e));
    process.exit(1);
  }

  /* 目标 URL 带上 --theme / --story 之类的"命令行注入"怎么办？
     预览不做注入（那要改页面加载时机），所以这两项只提示，不假装生效。 */
  if (THEME || STORY) {
    console.warn('⚠ --theme / --story 在预览模式不生效（它们靠渲染器注入）。');
    console.warn('  想看换风格的效果：直接改页面的 CFG，或用 --stills 出几张静帧。');
  }

  /* 关键一步：给页面注入 __seekRender。
     模板在顶层判断这个标记，决定"自驱动画"还是"完全由外部推帧"。
     不注入的话，页面自己的 rAF 循环会和我们的时间轴打架 ——
     拖动滑块时画面被两股力量来回改，看起来像掉帧。
     注入方式是"写一份同目录的临时副本"，而不是 query 参数：
     页面里的 ./themes.js、../lib/*.js 都是相对路径，副本必须落在原目录才解析得对。 */
  const src = fs.readFileSync(ABS, 'utf8');
  const inject = '<script>window.__seekRender = true; window.__preview = true;</script>';
  const patched = /<head[^>]*>/i.test(src)
    ? src.replace(/<head[^>]*>/i, (m) => m + inject)
    : inject + src;

  const targetPath = path.join(path.dirname(ABS), `.h2v-preview-${process.pid}${path.extname(ABS) || '.html'}`);
  fs.writeFileSync(targetPath, patched, 'utf8');

  const targetUrl = srv.url(targetPath);
  const shellPath = path.join(os.tmpdir(), `h2v-preview-${process.pid}.html`);
  fs.writeFileSync(shellPath, shellHtml(targetUrl, { duration: DURATION, fps: FPS, w: SIZE.w, h: SIZE.h }), 'utf8');

  const url = srv.url(shellPath);
  console.log('');
  console.log('▸ 预览已就绪');
  console.log('  ' + url);
  console.log(`  时长 ${DURATION}s · ${FPS}fps · 画布 ${SIZE.w}×${SIZE.h} · 拖时间轴或按空格播放`);
  console.log('  Ctrl+C 结束');

  if (hasFlag('open')) {
    const cmd = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    try { require('child_process').exec(`${cmd} "${url}"`); } catch (e) { /* 打不开就算了，URL 已经打印 */ }
  }

  const stop = async () => {
    try { await srv.close(); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(shellPath); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(targetPath); } catch (e) { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})();
