#!/usr/bin/env node
/**
 * 分镜预演 · 渲全片之前先看一张「分镜板」
 * ---------------------------------------------------------------------------
 * 为什么要有这一步：
 *
 *   一支 60 秒 1080p 的片子，逐帧渲要 3~10 分钟。渲完才发现「第 4 个镜头字太小」
 *   「转场节奏不对」，改一轮又是几分钟 —— 而且 Agent 每改一次都要重跑。
 *
 *   分镜板只取每个镜头的**中点**渲一张静帧（通常在转场窗口之外，画面是稳定的），
 *   十几秒就能出，拼成一页带镜头名/时长/转场的图。人在这一页上就能判断：
 *   节奏对不对、层级清不清楚、有没有哪一镜是空的。
 *
 *   这是 lemo / animate / video-shotcraft 都在用的「预演闸门」：
 *   intake → story check → look check → storyboard → build。
 *   前面四步都很便宜，把贵的渲染放在确认之后。
 *
 * 用法
 *   node scripts/storyboard.js assets/style-film.html
 *   node scripts/storyboard.js my.html --cols=3 --theme=chalk
 *   node scripts/storyboard.js my.html --story=shots.json --width=1080 --height=1920
 *
 * 产出
 *   <html>.storyboard/
 *     ├── shot-01.png …          每个镜头一张中点静帧
 *     ├── storyboard.html        带标注的分镜板（浏览器直接打开）
 *     └── storyboard.png         分镜板截图（发给别人 / 贴 issue 用）
 *
 * 依赖：playwright（走 NODE_PATH）、render-video-seek.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

/* ── 参数 ───────────────────────────────────────────────────────────── */

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const has = (name) => process.argv.includes('--' + name);

const HTML = process.argv[2];
if (!HTML || HTML.startsWith('--') || !fs.existsSync(HTML)) {
  console.error('用法: node scripts/storyboard.js <动画.html> [--cols=4] [--theme=riso] [--story=shots.json]');
  console.error('      [--width=1920] [--height=1080] [--fps=60] [--duration=秒]');
  process.exit(1);
}

const ABS = path.resolve(HTML);
const WIDTH = Number(arg('width', 1920));
const HEIGHT = Number(arg('height', 1080));
const FPS = Number(arg('fps', 60));
const COLS = Number(arg('cols', 4));
const THEME = arg('theme', null);
const STORY = arg('story', null);
const DUR_ARG = arg('duration', null);
const TMPDIR = arg('tmpdir', null);
const OUT_DIR = arg('out', path.join(path.dirname(ABS), path.basename(ABS, path.extname(ABS)) + '.storyboard'));

/* ── 工具 ───────────────────────────────────────────────────────────── */

const pad2 = (n) => String(n).padStart(2, '0');

function fail(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

/* 懒加载 playwright：CJS 里 require 才认 NODE_PATH（ESM 的 import 不认） */
function requirePlaywright() {
  try {
    return require('playwright');
  } catch (e) {
    fail(
      '找不到 playwright。先装依赖：bash scripts/install-deps.sh\n' +
      '  或手动：export NODE_PATH=<node 工作区>/node_modules'
    );
  }
}

/* 读镜头表：scenes.js 的 SC.expose(TL) 会把时间轴挂到 window.__sceneTable。
   没暴露的页面（单镜头、或直接用 CFG 写死）就退化成「按总时长均分」。 */
async function readTimeline() {
  const { chromium } = requirePlaywright();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });

  /* --story 必须在页面脚本跑起来之前注入，否则读到的还是页面自带的默认镜头表。
     这正是「给了 8 个镜头，分镜板却只出 4 格」的原因 —— 时间轴是在加载时
     一次编译好的，加载完再喂 CSS/JSON 已经晚了。 */
  if (STORY) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.resolve(STORY), 'utf8'));
      const arr = Array.isArray(raw) ? raw : (Array.isArray(raw.shots) ? raw.shots : null);
      if (arr) await ctx.addInitScript((s) => { window.__story = s; }, arr);
      else console.warn('⚠ --story 文件里没有镜头数组（应为 [...] 或 {shots:[...]}），忽略');
    } catch (e) {
      console.warn('⚠ --story 读不了，分镜板会按页面默认镜头表算：' + String(e.message || e).split('\n')[0]);
    }
  }

  const page = await ctx.newPage();

  const warnings = [];
  page.on('pageerror', (e) => warnings.push('pageerror: ' + e.message));

  const url = pathToFileURL(ABS).href;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction('window.__ready === true', null, { timeout: 10000 });
  } catch (e) {
    await browser.close();
    fail('页面没就绪：' + String(e.message || e).split('\n')[0]);
  }

  const info = await page.evaluate(() => {
    const table = window.__sceneTable || null;
    // 页面若自己记了总时长（很多模板会），拿来当兜底
    const probe = window.__probe || null;
    const dur = (probe && probe.dur) || (window.TL && window.TL.dur) || null;
    return { table, dur };
  });

  await browser.close();
  return { ...info, warnings };
}

/* 调渲染器只出静帧。--stills 走的是同一条 seek 通道，所以预览和成片逐帧一致。 */
function renderStills(times) {
  const tmpStills = path.join(path.dirname(ABS), path.basename(ABS, path.extname(ABS)) + '.stills');
  fs.rmSync(tmpStills, { recursive: true, force: true });

  const args = [
    path.join(__dirname, 'render-video-seek.js'),
    ABS,
    '--stills=' + times.map((t) => t.toFixed(3)).join(','),
    '--width=' + WIDTH,
    '--height=' + HEIGHT,
  ];
  if (THEME) args.push('--theme=' + THEME);
  if (STORY) args.push('--story=' + path.resolve(STORY));
  if (DUR_ARG) args.push('--duration=' + DUR_ARG);
  if (TMPDIR) args.push('--tmpdir=' + TMPDIR);

  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });  if (r.status !== 0) {
    console.error((r.stderr || r.stdout || '').slice(-1500));
    fail('渲染静帧失败');
  }

  const files = fs.readdirSync(tmpStills).filter((f) => f.endsWith('.png')).sort();
  return { dir: tmpStills, files };
}

/* ── 主流程 ─────────────────────────────────────────────────────────── */

(async function main() {
  console.log('▸ 读时间轴: ' + path.basename(ABS));
  const { table, dur } = await readTimeline();

  let shots = [];
  if (Array.isArray(table) && table.length) {
    shots = table.map((s) => ({
      id: s.id,
      start: s.start,
      dur: s.dur,
      trans: s.trans_in && s.trans_in !== 'cut' ? `${s.trans_in} ${s.trans_dur}s` : 'cut',
    }));
    console.log(`  ${shots.length} 个镜头（来自 window.__sceneTable）`);
  } else {
    const total = Number(DUR_ARG) || Number(dur) || 10;
    const n = Math.max(1, Math.min(8, Math.round(total / 3) || 1));
    const step = total / n;
    shots = Array.from({ length: n }, (_, i) => ({
      id: 'shot' + (i + 1), start: i * step, dur: step, trans: '—',
    }));
    console.log(`  页面没暴露镜头表，按 ${total}s 均分 ${n} 张（想精确请看 scenes.js 的 SC.expose）`);
  }

  /* 取每镜中点：别贴着转场窗口，那里的画面是两张叠着的，看不出设计问题 */
  const times = shots.map((s) => s.start + s.dur / 2);
  const stamp0 = Date.now();

  console.log(`▸ 渲 ${times.length} 张分镜静帧 …`);
  const { dir, files } = renderStills(times);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outImgs = [];
  for (let i = 0; i < times.length; i++) {
    const src = path.join(dir, files[i]);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(OUT_DIR, `shot-${pad2(i + 1)}.png`);
    fs.copyFileSync(src, dst);
    outImgs.push({ file: path.basename(dst), shot: shots[i], t: times[i] });
  }
  if (!outImgs.length) fail('一张静帧都没出，检查 --stills 参数与页面 __seek 契约');

  const total = shots.reduce((a, s) => a + s.dur, 0);

  /* 分镜板：一页看完。转场名 + 时长 + 时间码都标上，
     这样「第 3 镜只有 1.2 秒」这种节奏问题不用播放就能看出来。 */
  const cols = Math.max(1, Math.min(COLS, outImgs.length));
  const card = (im, i) => `
    <figure>
      <img src="./${im.file}" alt="shot ${i + 1}">
      <figcaption>
        <b>${pad2(i + 1)} · ${im.shot.id}</b>
        <span class="m">${im.shot.dur.toFixed(2)}s · @${im.t.toFixed(2)}s · ${im.shot.trans}</span>
      </figcaption>
    </figure>`;

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>分镜板 · ${path.basename(ABS)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 28px; background: #0d0f14; color: #e8ecf4;
         font: 14px/1.5 "Microsoft YaHei", system-ui, sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: .02em; }
  .sub { color: #8b95a7; font-size: 13px; margin-bottom: 22px; }
  .grid { display: grid; grid-template-columns: repeat(${cols}, 1fr); gap: 16px; }
  figure { margin: 0; background: #151922; border: 1px solid #232936; border-radius: 8px; overflow: hidden; }
  img { width: 100%; display: block; }
  figcaption { padding: 9px 11px; display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  figcaption b { font-size: 13px; }
  .m { color: #7f8b9e; font-size: 11.5px; font-family: ui-monospace, Consolas, monospace; white-space: nowrap; }
</style></head><body>
  <h1>分镜板 · ${path.basename(ABS)}</h1>
  <div class="sub">${outImgs.length} 镜 · 合计 ${total.toFixed(2)}s · ${WIDTH}×${HEIGHT} · ${FPS}fps${
    THEME ? ' · 风格 ' + THEME : ''}</div>
  <div class="grid">${outImgs.map(card).join('')}</div>
</body></html>`;

  const htmlPath = path.join(OUT_DIR, 'storyboard.html');
  fs.writeFileSync(htmlPath, html, 'utf8');

  /* 再截一张整页 PNG：分镜板最常被「贴到聊天里问一句行不行」，
     一张图比一个 HTML 文件好用。 */
  let sheetPath = null;
  try {
    const { chromium } = requirePlaywright();
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' });
    sheetPath = path.join(OUT_DIR, 'storyboard.png');
    await page.screenshot({ path: sheetPath, fullPage: true });
    await browser.close();
  } catch (e) {
    console.warn('⚠ 整页截图失败（分镜板 HTML 仍然可用）：' + String(e.message || e).split('\n')[0]);
  }

  const cost = ((Date.now() - stamp0) / 1000).toFixed(1);
  console.log('');
  console.log(`✓ 分镜板: ${htmlPath}`);
  if (sheetPath) console.log(`✓ 整页图: ${sheetPath}`);
  console.log(`  ${outImgs.length} 镜 · ${cost}s（全片渲染约 ${(total * 0.8).toFixed(0)}~${(total * 3).toFixed(0)}s）`);
  console.log('');
  console.log('看完再渲全片：');
  console.log(`  bash assets/render.sh "${HTML}" --duration=${total.toFixed(2)} --fps=${FPS}` +
    (THEME ? ` --theme=${THEME}` : ''));
})();
