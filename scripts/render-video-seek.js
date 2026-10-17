#!/usr/bin/env node
/**
 * HTML animation → MP4 via deterministic frame-by-frame SEEK (Playwright + ffmpeg).
 *
 * 技术内核借鉴 HeyGen HyperFrames（Apache 2.0）的「冻结时钟 + seek 到时间戳截图」思路，
 * 不引入任何第三方包 —— 只用 playwright + ffmpeg，runtime 中立。
 *
 * 相比 recordVideo 路线解决的三个死结：
 *   1. 帧率不被 Chromium headless compositor 锁死 25fps —— --fps 原生任意帧率
 *   2. 不需要事后 minterpolate 插帧（有 ghosting + QuickTime 兼容 bug）—— 每帧都是真实 seek 画面
 *   3. 不录屏 → 无开头黑帧 → 不需要 trim / fontwait / __ready 偏移那套
 *   额外：同输入同输出 deterministic。
 *
 * 前提：动画必须走 Stage 时钟（assets/animation-skeleton.html 的写法），响应
 * window.__seekRender 冻结自驱时钟、暴露 window.__seek(t)。
 *
 * ── 依赖 ──────────────────────────────────────────────────────────────
 *   playwright（可用 NODE_PATH 指向任意 node_modules）+ 完整版 ffmpeg。
 *   ffmpeg 默认从 PATH 找；不在 PATH 时用 FFMPEG 环境变量指定绝对路径。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────
 *   NODE_PATH=$(npm root -g) node render-video-seek.js <html-file> [选项]
 *
 * 渲染范围
 *   --duration=30          从 --from 起算的时长（秒）
 *   --from=0               起点（秒）
 *   --to=<sec>             终点（秒）；给了它就忽略 --duration
 *   --stills=0.5,2.0       只导出这些时刻的 PNG，不编码（配合 --from 是绝对秒）
 *
 * 画面
 *   --fps=60               帧率（原生）
 *   --width=1920 --height=1080
 *   --concurrency=4        并行 worker 数（每个一个 page）
 *   --settle=2             seek 后等几个 rAF 再截图
 *   --keep-chrome          不隐藏播放控件（调试用）
 *
 * 编码
 *   --gop=<秒>             关键帧间隔；给了就每秒一个关键帧，方便后期逐秒 seek
 *   --audio=<file>         编码后自动混音（视频流直接 copy，不重编码）
 *   --keep-frames          成功也保留逐帧 PNG（换 CRF 重编码时不必重截）
 *
 * 容错
 *   --allow-errors         页面报错不判失败（默认：有 pageerror/console.error → 非零退出）
 *   --readytimeout=8       等 window.__seek 就绪的秒数
 *   --no-serve             用 file:// 加载（默认走本地 http server；file:// 下 ESM 与 fetch 会被 CORS 拦死）
 *
 * Output:
 *   同目录同名 .mp4。给了 --from/--to 时输出名为 <名>.<起>-<止>s.mp4，**不会覆盖成品**。
 *   --stills 输出到 <名>.stills/ 目录。
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { HIDE_CHROME_CSS, hideChromeInit } = require('./lib/hide-chrome.cjs');
const { startServer } = require('./lib/local-server.cjs');

function arg(name, def) {
  const p = process.argv.find(a => a.startsWith('--' + name + '='));
  return p ? p.slice(name.length + 3) : def;
}
function hasFlag(name) {
  return process.argv.includes('--' + name);
}

const HTML_FILE = process.argv[2];
if (!HTML_FILE || HTML_FILE.startsWith('--')) {
  console.error('Usage: node render-video-seek.js <html-file> [options]');
  console.error('Example: NODE_PATH=$(npm root -g) node render-video-seek.js my-animation.html --fps=60 --duration=12');
  console.error('         ... --from=3 --to=5     # 只渲 3s–5s，快速试片');
  console.error('         ... --stills=1,3,5      # 只导出 1s/3s/5s 三张静帧');
  console.error('         ... --resume            # 上次中断了？接着渲，已完成的帧直接复用');
  process.exit(1);
}

const DURATION    = parseFloat(arg('duration', '30'));
const FPS         = parseFloat(arg('fps', '60'));
const WIDTH       = parseInt(arg('width', '1920'));
const HEIGHT      = parseInt(arg('height', '1080'));
const CONCURRENCY = Math.max(1, parseInt(arg('concurrency', '4')));
const SETTLE      = Math.max(1, parseInt(arg('settle', '2')));
const READY_TIMEOUT = parseFloat(arg('readytimeout', '8'));
const FROM        = Math.max(0, parseFloat(arg('from', '0')));
const TO_RAW      = arg('to', null);
const STILLS_RAW  = arg('stills', null);
const AUDIO       = arg('audio', null);
const GOP_RAW     = arg('gop', null);
const KEEP_CHROME = hasFlag('keep-chrome');
const KEEP_FRAMES = hasFlag('keep-frames');
const ALLOW_ERRORS = hasFlag('allow-errors');
const NO_SERVE     = hasFlag('no-serve');       // 默认走本地 http；见 lib/local-server.cjs 顶部说明
const RESUME       = hasFlag('resume');         // 断点续渲：复用上一次留下的帧

const HTML_ABS = path.resolve(HTML_FILE);
const BASENAME = path.basename(HTML_FILE, path.extname(HTML_FILE));
const DIR      = path.dirname(HTML_ABS);

// 渲染范围 → 全局帧号 [F0, F1)。帧号是全局的（f/flimFPS = 绝对秒），
// 这样 --from=3 --to=5 截出来的帧和整片渲到同一时刻的帧逐像素一致。
const END = TO_RAW !== null ? parseFloat(TO_RAW) : FROM + DURATION;
const F0 = Math.round(FROM * FPS);
const F1 = Math.round(END * FPS);
const RANGE_GIVEN = FROM > 0 || TO_RAW !== null;

const STILLS = STILLS_RAW
  ? STILLS_RAW.split(',').map(s => parseFloat(s.trim())).filter(v => Number.isFinite(v))
  : null;

/* 逐帧目录
   默认用「时间戳 + pid」的一次性目录，多个渲染并发也不会互相踩。
   --resume 时改用一个**固定**目录，这样重启后能认回上次的帧。
   固定目录靠 job.json 认参数：fps/尺寸/范围一变就拒绝续渲，否则会拼出前后不一致的片子。 */
const RESUME_DIR = path.join(DIR, '.seek-tmp-resume');
const TMP_DIR   = RESUME ? RESUME_DIR : path.join(DIR, '.seek-tmp-' + Date.now() + '-' + process.pid);

const JOB = {
  html: HTML_ABS, fps: FPS, from: F0, to: F1,
  width: WIDTH, height: HEIGHT, settle: SETTLE, hideChrome: !KEEP_CHROME,
};
const STILL_DIR = path.join(DIR, BASENAME + '.stills');
const MP4_OUT   = path.join(DIR, RANGE_GIVEN
  ? `${BASENAME}.${trimNum(FROM)}-${trimNum(END)}s.mp4`
  : BASENAME + '.mp4');

function trimNum(v) { return String(Math.round(v * 1000) / 1000); }

/**
 * 删逐帧临时目录。**失败不能影响出片结果** —— 某些沙箱环境给 fs.rmSync 套了
 * 「批量删除保护」（一次删几十个文件会被拦下并抛错），成片明明已经写好了，
 * 不该因为清理不掉临时目录就判整次渲染失败。
 */
function cleanupTmp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (e) {
    const first = String((e && e.message) || e).split('\n')[0].slice(0, 160);
    console.warn(`⚠ 逐帧目录没能自动删除：${first}`);
    console.warn(`  成片没问题，手动删这个目录即可：${dir}`);
    return false;
  }
}

const TOTAL_FRAMES = STILLS ? STILLS.length : Math.max(0, F1 - F0);
if (!STILLS && TOTAL_FRAMES === 0) {
  console.error(`✗ 渲染范围为空（from=${FROM} to=${END} fps=${FPS}）。检查 --from/--to/--duration。`);
  process.exit(1);
}

/* ---------- 断点续渲 ---------- */

/**
 * 认参数。续渲最怕的是「上次 30fps、这次 60fps」却把两批帧混着编码 ——
 * 片子会前后抖，而且不报错。所以参数不一致直接拒绝，让人自己决定删不删。
 */
function checkResumeJob() {
  const p = path.join(RESUME_DIR, 'job.json');
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { prev = null; }
  if (prev && JSON.stringify(prev) !== JSON.stringify(JOB)) {
    console.error('✗ 续渲参数和上次不一致，混在一起会拼出前后不一致的片子。');
    console.error('  上次：' + JSON.stringify(prev));
    console.error('  这次：' + JSON.stringify(JOB));
    console.error('  处理：删掉这个目录重来，或换个参数从零开始 —— ' + RESUME_DIR);
    process.exit(1);
  }
  fs.mkdirSync(RESUME_DIR, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(JOB));
}

/**
 * 扫已有帧。三条都满足才算「可复用」：
 *   ① 文件名是 frame-XXXXXX.png
 *   ② 体积够大
 *   ③ 头 8 字节是 PNG 魔数
 * 截图时先写 .part 再改名，所以被 kill 的那一帧不会是 .png；
 * 但历史遗留或磁盘异常仍可能留下截断文件，多验一次不亏。
 */
function scanDoneFrames() {
  const done = new Set();
  let names = [];
  try { names = fs.readdirSync(RESUME_DIR); } catch (e) { return done; }
  const PNG_MAGIC = '89504e470d0a1a0a';
  for (const name of names) {
    if (name.endsWith('.part')) {
      try { fs.rmSync(path.join(RESUME_DIR, name), { force: true }); } catch (e) { /* 清不掉就留着 */ }
      continue;
    }
    const m = /^frame-(\d+)\.png$/.exec(name);
    if (!m) continue;
    const p = path.join(RESUME_DIR, name);
    try {
      if (fs.statSync(p).size < 512) continue;
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(8);
      fs.readSync(fd, buf, 0, 8, 0);
      fs.closeSync(fd);
      if (buf.toString('hex') !== PNG_MAGIC) continue;
      done.add(parseInt(m[1], 10));
    } catch (e) { /* 读不了就当没渲过 */ }
  }
  return done;
}

const DONE_FRAMES = (!STILLS && RESUME) ? scanDoneFrames() : new Set();
const PENDING = STILLS ? [] : (() => {
  const list = [];
  for (let f = F0; f < F1; f++) if (!DONE_FRAMES.has(f)) list.push(f);
  return list;
})();

console.log(`▸ Seek-rendering: ${HTML_FILE}`);
if (STILLS) {
  console.log(`  size: ${WIDTH}x${HEIGHT} · stills: ${STILLS.join(', ')}s → ${STILL_DIR}`);
} else {
  console.log(`  size: ${WIDTH}x${HEIGHT} · ${FPS}fps · ${trimNum(FROM)}–${trimNum(END)}s · frames: ${TOTAL_FRAMES} · workers: ${CONCURRENCY}`);
  console.log(`  output: ${MP4_OUT}`);
}

// 在 page 上下文里运行：等 SETTLE 个 rAF（让 React/Babel commit + 布局稳定后再截图）
async function waitRaf(page, n) {
  await page.evaluate((count) => new Promise(resolve => {
    let i = 0;
    const step = () => { i++; (i >= count) ? resolve() : requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }), n);
}

/* 画布比视口小 → 截图按 (0,0,W,H) 裁，右下角会被静默裁掉，画面照样出、只是缺一块。
   这是最阴的坑：改了 --width/--height 而页面把 canvas 尺寸写死就中招，且不报错。
   所以每个 page 就绪后量一次，量到就明确说出来。 */
const SIZE_WARN = new Set();
async function checkStageSize(page) {
  let msg = null;
  try {
    msg = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      const cw = Math.round(r.width), ch = Math.round(r.height);
      if (cw + 1 >= window.innerWidth && ch + 1 >= window.innerHeight) return null;
      return `画布 ${cw}×${ch} 小于视口 ${window.innerWidth}×${window.innerHeight}，截图只取左上角，右下会被裁掉`;
    });
  } catch (e) { return; }
  if (msg) SIZE_WARN.add(msg);
}

function printSizeWarnings() {
  if (!SIZE_WARN.size) return;
  console.warn('');
  console.warn('⚠ 画面尺寸和视口对不上（成片会缺右下角，但不会报错）：');
  for (const m of SIZE_WARN) console.warn('  · ' + m);
  console.warn('  修法：canvas 尺寸跟随视口 ——');
  console.warn('    cv.width = window.innerWidth; cv.height = window.innerHeight;');
  console.warn('  （assets/templates/*.html 都已这样写，可直接照抄）');
  console.warn('');
}

// 一个 worker：开一个 page，goto，等 __seek 就绪，渲染分配给它的帧
async function renderFrames(context, url, frames, onPage) {
  const page = await context.newPage();
  onPage(page);
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });

  // 契约：__seek 就绪；或页面主动宣告启动失败
  // 注意签名是 waitForFunction(fn, arg, options)：arg 排第二，options 排第三。
  // 写成 waitForFunction(fn, {timeout}) 会把 options 当成传给页面的 arg，超时永远走默认 30s。
  await page.waitForFunction(
    () => window.__ready === true || !!window.__bootFailed,
    null,
    { timeout: READY_TIMEOUT * 1000 },
  );
  const bootFailed = await page.evaluate(() => window.__bootFailed || null);
  if (bootFailed) {
    throw new Error('页面自报启动失败（window.__bootFailed）：\n' + bootFailed);
  }
  if (await page.evaluate(() => typeof window.__seek !== 'function')) {
    throw new Error('__ready 为 true 但没暴露 window.__seek');
  }
  await checkStageSize(page);

  for (const f of frames) {
    const t = f / FPS;
    await page.evaluate((tt) => window.__seek(tt), t);
    await waitRaf(page, SETTLE);
    const finalPath = path.join(TMP_DIR, 'frame-' + String(f).padStart(6, '0') + '.png');
    // 先写 .part 再改名：渲染中途被 kill 时，不会留下半个 PNG 冒充「已完成」的帧，
    // --resume 才能只认真正画完的那些。
    const partPath = finalPath + '.part';
    // 注意：不能写 screenshot({ path: finalPath + '.part' })。
    // Playwright 按扩展名推断图片格式，'.part' 它认不出来，会抛
    // "unsupported mime type"。所以拿 Buffer 自己落盘，原子改名保留。
    const buf = await page.screenshot({
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    });
    fs.writeFileSync(partPath, buf);
    fs.renameSync(partPath, finalPath);
  }
  await page.close();
}

// 静帧模式：同一个 page 依次 seek + 截图到 stills 目录
async function renderStills(context, url, times, onPage) {
  const page = await context.newPage();
  onPage(page);
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(
    () => window.__ready === true || !!window.__bootFailed,
    null,
    { timeout: READY_TIMEOUT * 1000 },
  );
  const bootFailed = await page.evaluate(() => window.__bootFailed || null);
  if (bootFailed) throw new Error('页面自报启动失败（window.__bootFailed）：\n' + bootFailed);
  await checkStageSize(page);

  fs.mkdirSync(STILL_DIR, { recursive: true });
  for (const t of times) {
    await page.evaluate((tt) => window.__seek(tt), t);
    await waitRaf(page, SETTLE);
    const name = 't' + t.toFixed(3).padStart(8, '0') + '.png';
    await page.screenshot({
      path: path.join(STILL_DIR, name),
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    });
    console.log('  · ' + name);
  }
  await page.close();
}

(async () => {
  const t0 = Date.now();
  const pageErrors = [];
  const pageWarnings = [];
  const onPage = (page, tag) => {
    page.on('pageerror', e => pageErrors.push(`[worker${tag}] pageerror: ${String(e && e.message || e)}`));
    page.on('console', m => {
      if (m.type() === 'error') pageErrors.push(`[worker${tag}] console.error: ${m.text()}`);
      else if (m.type() === 'warning') pageWarnings.push(`[worker${tag}] console.warn: ${m.text()}`);
    });
  };

  if (!STILLS) {
    if (RESUME) {
      checkResumeJob();
      // 放在校验之后：参数对不上就直接退出了，不该先说「还需渲 N 帧」让人以为要开跑。
      if (DONE_FRAMES.size) console.log(`  resume: 已复用 ${DONE_FRAMES.size} 帧，还需渲 ${PENDING.length} 帧`);
    } else fs.mkdirSync(TMP_DIR, { recursive: true });
  }

  // 默认走本地 http：file:// 下 <script type="module"> 和 fetch() 会被 CORS 拦死，
  // 用 ESM / 读本地 JSON 的动画项目在 file:// 下根本起不来。http 是 file:// 的超集。
  // 真起不来（端口被禁等）就退回 file://——只 warn，不判失败。
  let server = null;
  let url = 'file://' + HTML_ABS;
  if (!NO_SERVE) {
    try {
      server = await startServer();
      url = server.url(HTML_ABS);
      console.log(`  load: ${url}`);
    } catch (e) {
      console.warn(`⚠ 本地 http server 起不来，退回 file://（ESM / fetch 可能受限）：${String((e && e.message) || e)}`);
      console.warn('  若确认不需要 ESM/fetch，加 --no-serve 可去掉这条提示。');
      server = null;
    }
  }

  // 第一次用最常见的一堵墙：playwright 装了但没下浏览器内核。
  // 它默认抛的是裸栈 trace（browserType.launch: Executable doesn't exist at ...），
  // 对第一次点进来的人等于劝退 —— 这里换成一句人话加一条命令。
  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/Executable doesn't exist|playwright install|Looks like Playwright/i.test(msg)) {
      console.error('');
      console.error('✗ 浏览器内核还没装（截图要靠它）。装一次就行，之后不用再管：');
      console.error('');
      console.error('    npx playwright install chromium');
      console.error('');
      console.error('  没有 ffmpeg 的话，一条命令连它一起装好：');
      console.error('    bash scripts/install-deps.sh');
      console.error('');
      console.error('  装完直接重跑刚才那条命令，不需要改任何配置。');
      process.exit(1);
    }
    throw e;
  }

  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });

  // 关键信号：__seekRender 让 Stage 冻结 wall-clock rAF，改由外部 __seek 推帧
  await context.addInitScript(() => {
    window.__recording = true;
    window.__seekRender = true;
  });

  if (!KEEP_CHROME) {
    await context.addInitScript(hideChromeInit, HIDE_CHROME_CSS);
  }

  let captured = 0;
  try {
    if (STILLS) {
      console.log(`▸ Capturing ${STILLS.length} still(s)…`);
      await renderStills(context, url, STILLS, p => onPage(p, 0));
      captured = STILLS.length;
    } else if (!PENDING.length) {
      console.log(`▸ ${TOTAL_FRAMES} 帧全在，跳过截图，直接编码`);
    } else {
      // 把待渲帧 round-robin 分给 CONCURRENCY 个 worker（每个 page 独立 window，seek 互不干扰）
      const buckets = Array.from({ length: CONCURRENCY }, () => []);
      PENDING.forEach((f, i) => buckets[i % CONCURRENCY].push(f));
      console.log(`▸ Capturing ${PENDING.length} frames across ${CONCURRENCY} workers…`);
      await Promise.all(buckets.map((b, i) => b.length ? renderFrames(context, url, b, p => onPage(p, i)) : Promise.resolve()));
      captured = PENDING.length;
    }
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/__seek|__ready/.test(msg)) {
      console.error('');
      console.error('✗ 动画没有暴露 window.__seek（或未就绪）。');
      console.error('  seek 渲染只支持走冻结时钟的动画（见 assets/animation-skeleton.html 的「渲染契约」段）。');
      console.error('  纯 CSS @keyframes / Lottie / 手写非确定动画不吃 __seek，本渲染器不适用。');
      console.error('');
    } else if (/Timeout .* exceeded/.test(msg)) {
      // 「等 __ready 超时」本身不含任何线索，得把最常见的三个原因摆出来，否则只能干瞪眼
      console.error('');
      console.error('✗ 等 window.__ready 超时 —— 页面始终没宣告就绪。最常见的三个原因：');
      console.error(`  1) 用了 ESM（<script type="module">）或 fetch()，却以 file:// 加载。`);
      console.error(`     默认已走本地 http server；若你加了 --no-serve，去掉它再试。`);
      console.error('  2) 启动就报错了（资源 404、语法错误、依赖没装），脚本根本没跑到 __ready。');
      console.error('     渲染开头会打印 http 地址（默认模式），把它粘到浏览器里打开看控制台最直接。');
      console.error(`  3) 启动逻辑比 ${READY_TIMEOUT}s 还慢（大字体 / 大数据）。加 --readytimeout=30。`);
      console.error('');
    }
    await browser.close();
    cleanupTmp(TMP_DIR);
    console.error(msg.slice(0, 800));
    process.exit(1);
  }

  await browser.close();
  if (server) { try { await server.close(); } catch (e) { /* 关不掉也不影响成片 */ } }
  printSizeWarnings();

  // ── 报错检查：在编码之前，先把「画面可能是坏的」这件事说清楚 ──
  // 保留成片（能直接看）但最终非零退出，让脚本/CI 能感知失败。
  // 同一个页面报错会被每个 worker 各报一遍，按内容归并后再打印，否则 1 条真错误看着像 4 条。
  const summarize = (list) => {
    const m = new Map();
    for (const x of list) {
      const key = x.replace(/^\[worker\d+\]\s*/, '');
      m.set(key, (m.get(key) || 0) + 1);
    }
    return [...m.entries()];
  };
  if (pageWarnings.length) {
    const uniq = summarize(pageWarnings);
    console.warn(`⚠ 页面有 ${uniq.length} 类 console.warn（共 ${pageWarnings.length} 条，${CONCURRENCY} 个 worker 各报一遍）：`);
    uniq.slice(0, 10).forEach(([msg, n]) => console.warn(`  ${n > 1 ? '×' + n + ' ' : ''}${msg}`));
    if (uniq.length > 10) console.warn(`  …另有 ${uniq.length - 10} 类`);
  }
  const errorsFatal = pageErrors.length > 0 && !ALLOW_ERRORS;
  if (pageErrors.length) {
    const uniq = summarize(pageErrors);
    console.error(`${errorsFatal ? '✗' : '⚠'} 页面报错 ${uniq.length} 类（共 ${pageErrors.length} 条）${errorsFatal ? '，成片可能是坏的' : '，--allow-errors 已忽略'}：`);
    uniq.slice(0, 20).forEach(([msg, n]) => console.error(`  ${n > 1 ? '×' + n + ' ' : ''}${msg}`));
    if (uniq.length > 20) console.error(`  …另有 ${uniq.length - 20} 类`);
  }

  if (STILLS) {
    console.log(`✓ Done: ${captured} 张静帧 → ${STILL_DIR}`);
    if (pageErrors.length && errorsFatal) {
      console.error('✗ 因页面报错判为失败（静帧已产出，供你核对）。');
      process.exit(1);
    }
    return;
  }

  /* 帧完整性：ffmpeg 的 -start_number 从 F0 起按序号连读，中间缺一张就会提前收尾，
     而且不报错 —— 成片会莫名变短。所以按「帧号必须连续覆盖 [F0,F1)」来验，
     而不是只数个数（续渲时最可能出现空洞）。 */
  const present = new Set();
  for (const f of fs.readdirSync(TMP_DIR)) {
    const m = /^frame-(\d+)\.png$/.exec(f);
    if (m) present.add(parseInt(m[1], 10));
  }
  const pngCount = present.size;
  if (pngCount === 0) {
    console.error('✗ 没有截到任何帧');
    process.exit(1);
  }
  const missing = [];
  for (let f = F0; f < F1; f++) if (!present.has(f)) missing.push(f);
  if (missing.length) {
    console.error(`✗ 缺帧 ${missing.length} / ${TOTAL_FRAMES}（如 ${missing.slice(0, 5).join(', ')}），不能编码。`);
    console.error('  加 --resume 重跑可补齐缺口，或删掉逐帧目录重来：' + TMP_DIR);
    process.exit(1);
  }
  console.log(`▸ Captured ${pngCount}/${TOTAL_FRAMES} frames. Encoding H.264…`);

  // PNG 序列 → MP4。无 trim（本来就没黑帧），输入输出帧率都设 FPS。
  const enc = [
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-crf', '18', '-preset', 'medium',
    '-r', String(FPS), '-movflags', '+faststart',
  ];
  if (GOP_RAW !== null) {
    // 每秒一个关键帧：后期剪辑按秒 seek 不会冻帧（搬运自 huashu render.py --spec）
    const g = Math.max(1, Math.round(parseFloat(GOP_RAW) * FPS));
    enc.push('-g', String(g), '-keyint_min', String(g), '-sc_threshold', '0');
  }

  const audioTmp = AUDIO ? MP4_OUT + '.noaudio.mp4' : null;
  const encodeTarget = audioTmp || MP4_OUT;

  const ffmpegArgs = [
    '-y',
    '-framerate', String(FPS),
    '-start_number', String(F0),
    '-i', path.join(TMP_DIR, 'frame-%06d.png'),
    ...enc,
    encodeTarget,
  ];
  const ffmpeg = spawnSync(process.env.FFMPEG || 'ffmpeg', ffmpegArgs, { stdio: ['ignore', 'ignore', 'pipe'] });

  if (ffmpeg.status !== 0) {
    // 注意：spawn 失败（例如 ffmpeg 不在 PATH）时 stderr 为 null/undefined，
    // 直接 .toString() 会在错误处理里二次崩溃，把真正的报错盖掉。
    const detail = ffmpeg.stderr
      ? ffmpeg.stderr.toString().slice(-2000)
      : String((ffmpeg.error && ffmpeg.error.message) || 'ffmpeg 未找到，检查 PATH 或设置 FFMPEG 环境变量');
    console.error('✗ ffmpeg failed:\n' + detail);
    console.error(`  帧已保留在 ${TMP_DIR}，修好 ffmpeg 后可手动编码，不必重截：`);
    console.error(`    ffmpeg -y -framerate ${FPS} -start_number ${F0} -i "${path.join(TMP_DIR, 'frame-%06d.png')}" \\`);
    console.error(`      -c:v libx264 -pix_fmt yuv420p -crf 18 -preset medium -r ${FPS} -movflags +faststart out.mp4`);
    process.exit(1);
  }

  // 混音：视频流 copy，只编音频，快且不掉画质
  if (AUDIO) {
    const span = (F1 - F0) / FPS;
    const mux = spawnSync(process.env.FFMPEG || 'ffmpeg', [
      '-y', '-v', 'error',
      '-i', audioTmp,
      '-ss', String(FROM), '-t', String(span),
      '-i', path.resolve(AUDIO),
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      '-shortest', '-movflags', '+faststart',
      MP4_OUT,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (mux.status !== 0) {
      const d = mux.stderr ? mux.stderr.toString().slice(-1500) : '（ffmpeg 未找到）';
      console.error('✗ 混音失败：\n' + d);
      console.error(`  无声版留在这里：${audioTmp}`);
      process.exit(1);
    }
    try { fs.rmSync(audioTmp, { force: true }); } catch (e) { /* 删不掉也不影响成片 */ }
  }

  if (KEEP_FRAMES) {
    console.log(`▸ 逐帧 PNG 保留在 ${TMP_DIR}（${(pngCount * 0.44).toFixed(0)} MB 上下）`);
  } else {
    cleanupTmp(TMP_DIR);
  }

  const mp4Size = (fs.statSync(MP4_OUT).size / 1024 / 1024).toFixed(1);
  console.log(`✓ Done: ${MP4_OUT} (${mp4Size} MB · ${FPS}fps native · ${((Date.now() - t0) / 1000).toFixed(0)}s)`);

  if (errorsFatal) {
    console.error('✗ 因页面报错判为失败（成片已产出，供你核对）。修完再渲；确属无关报错可加 --allow-errors。');
    process.exit(1);
  }
})();
