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
 *   --gif[=fps,width]      出片后再产一张 GIF（默认 15fps / 宽 960），两阶段 palette 优化
 *   --poster=<秒>          出片后再抽一张封面静帧（.jpg），发站 / 社媒用
 *
 * 多镜头
 *   --story=<file>         镜头表 JSON，注入 window.__story（配合 assets/lib/scenes.js）
 *   --scene-log=<file>     导出镜头时间轴 CSV（index,id,start,end,dur,trans_in,trans_dur）
 *
 * 批量
 *   --batch=<file.json>    一串任务按顺序渲（每项一组渲染参数），最后打汇总表
 *
 * 容错
 *   --allow-errors         页面报错不判失败（默认：有 pageerror/console.error → 非零退出）
 *   --readytimeout=8       等 window.__seek 就绪的秒数
 *   --no-serve             用 file:// 加载（默认走本地 http server；file:// 下 ESM 与 fetch 会被 CORS 拦死）
 *   --headed               开着浏览器窗口渲（调试用；并发自动降到 1，否则桌面上会开一排窗口）
 *
 * Output:
 *   同目录同名 .mp4。给了 --from/--to 时输出名为 <名>.<起>-<止>s.mp4，**不会覆盖成品**。
 *   --stills 输出到 <名>.stills/ 目录。
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const os = require('os');
const { HIDE_CHROME_CSS, hideChromeInit } = require('./lib/hide-chrome.cjs');
const { startServer } = require('./lib/local-server.cjs');
const { loadCues, cueAt } = require('./lib/cues.cjs');

function arg(name, def) {
  const p = process.argv.find(a => a.startsWith('--' + name + '='));
  return p ? p.slice(name.length + 3) : def;
}
function hasFlag(name) {
  return process.argv.includes('--' + name);
}

/**
 * 并发自适应：--concurrency=auto 时按 CPU 与可用内存挑 worker 数。
 * 每个 worker 是一个独立 Chromium 页面，实测常驻 0.4–0.8 GB。开太多不会更快
 * （页面之间抢 CPU），只会把内存吃光然后被系统杀掉。上限 8 是实测出来的拐点。
 */
function autoConcurrency() {
  const cpus = (os.cpus() && os.cpus().length) || 4;
  const freeGB = os.freemem() / 1073741824;
  const byCpu = Math.max(1, Math.floor(cpus * 0.75));
  const byMem = Math.max(1, Math.floor(freeGB / 0.6));
  return Math.max(1, Math.min(8, Math.min(byCpu, byMem)));
}

/** 批量任务：起子进程逐个渲，最后打汇总表 */
function runBatch(file) {
  let jobs;
  try {
    jobs = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  } catch (e) {
    console.error(`✗ 批量任务文件读不了：${file}`);
    console.error('  ' + String((e && e.message) || e).split('\n')[0]);
    process.exit(1);
  }
  if (!Array.isArray(jobs) || !jobs.length) {
    console.error('✗ 批量任务文件里要是一组对象：[{ "html": "...", "duration": 6 }, ...]');
    process.exit(1);
  }
  const FLAG_KEYS = new Set(['alpha', 'resume', 'keep-frames', 'allow-errors', 'keep-chrome', 'no-serve']);
  const VAL_KEYS = ['duration', 'from', 'to', 'fps', 'width', 'height', 'concurrency', 'settle',
    'audio', 'gop', 'srt', 'story', 'scene-log', 'poster', 'readytimeout', 'stills', 'tmpdir'];

  console.log(`▸ Batch: ${jobs.length} 个任务（${file}）`);
  const rows = [];
  let failed = 0;
  const t0 = Date.now();
  jobs.forEach((job, i) => {
    if (!job || !job.html) {
      console.error(`✗ [${i + 1}/${jobs.length}] 任务缺 html 字段`);
      failed++; rows.push({ n: i + 1, html: '(缺失)', ok: false, note: '缺 html' });
      return;
    }
    const args = [];
    for (const k of VAL_KEYS) if (job[k] != null) args.push(`--${k}=${job[k]}`);
    for (const k of FLAG_KEYS) if (job[k] === true) args.push('--' + k);
    if (job.gif != null) args.push(job.gif === true ? '--gif' : `--gif=${job.gif}`);

    console.log(`\n▸ [${i + 1}/${jobs.length}] ${job.html}${args.length ? '  ' + args.join(' ') : ''}`);
    const r = spawnSync(process.execPath, [__filename, job.html, ...args], { encoding: 'utf8' });
    const out = (r.stdout || '') + (r.stderr || '');
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    const ok = r.status === 0;
    if (!ok) failed++;
    const m = out.match(/✓ Done: (\S+)/);
    rows.push({ n: i + 1, html: job.html, ok, note: m ? m[1] : (ok ? 'ok' : 'exit ' + r.status) });
  });
  console.log('\n──────── 批量汇总 ────────');
  for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${String(r.n).padStart(2)}  ${r.html}  →  ${r.note}`);
  console.log(`  ${rows.length - failed}/${rows.length} 成功 · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  process.exit(failed ? 1 : 0);
}

const HTML_FILE = process.argv[2];
if (arg('batch', null)) runBatch(arg('batch', null));

if (!HTML_FILE || HTML_FILE.startsWith('--')) {
  console.error('Usage: node render-video-seek.js <html-file> [options]');
  console.error('Example: NODE_PATH=$(npm root -g) node render-video-seek.js my-animation.html --fps=60 --duration=12');
  console.error('         ... --from=3 --to=5     # 只渲 3s–5s，快速试片');
  console.error('         ... --stills=1,3,5      # 只导出 1s/3s/5s 三张静帧');
  console.error('         ... --resume            # 上次中断了？接着渲，已完成的帧直接复用');
  console.error('         ... --alpha             # 透明背景输出（ProRes 4444 .mov），用于叠加合成');
  console.error('         ... --batch=jobs.json   # 一串任务按顺序渲');
  process.exit(1);
}

const DURATION    = parseFloat(arg('duration', '30'));
const FPS         = parseFloat(arg('fps', '60'));
const WIDTH       = parseInt(arg('width', '1920'));
const HEIGHT      = parseInt(arg('height', '1080'));
const CONC_RAW    = String(arg('concurrency', '4'));
const AUTO_CONC   = CONC_RAW === 'auto';
const HEADED      = hasFlag('headed');
let   CONCURRENCY = AUTO_CONC ? autoConcurrency() : Math.max(1, parseInt(CONC_RAW, 10) || 4);
if (HEADED && CONCURRENCY > 1) {
  // 开着窗口渲还并发 = 桌面上弹出一排浏览器，既看不清也互相抢焦点
  console.log(`  headed: 并发从 ${CONCURRENCY} 降到 1（有头模式就开一个窗口看）`);
  CONCURRENCY = 1;
}
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
const ALPHA        = hasFlag('alpha');          // 透明背景输出（叠加合成用）
const ALPHA_CODEC  = String(arg('alpha-codec', 'prores')).toLowerCase();
const CUES_FILE    = arg('srt', null) || arg('cues', null);   // 字幕时间轴（SRT / VTT / JSON）
const CUE_LOG      = arg('cue-log', null);      // 把「第几帧用了第几句」写成 CSV，用于核对时间误差
const STORY_FILE   = arg('story', null);        // 镜头表 JSON（配合 assets/lib/scenes.js）
const SCENE_LOG    = arg('scene-log', null);    // 镜头时间轴 CSV，用来核对镜头起止与转场
const GIF_RAW      = arg('gif', null);          // --gif 或 --gif=fps,width
const WANT_GIF     = hasFlag('gif') || GIF_RAW !== null;
const POSTER_AT    = arg('poster', null);       // 从成片里抽一帧当封面（秒）
const TMPDIR_RAW   = arg('tmpdir', null);       // 逐帧 PNG 放哪块盘（默认挨着 HTML）

/* 为什么只有 ProRes 4444，没有 VP9 alpha：
   实测把 PNG 序列（rgba）编成 --pix_fmt yuva420p + -auto-alt-ref 0，文件体积从 7.8KB
   涨到 16.8KB（alpha 数据确实写进去了），但 Chromium 播出来整帧 alpha 全 0 —— 连文字都透明。
   换 lossless / 固定码率 / -lag-in-frames 0 都一样。ffmpeg 侧也解不出 alpha（webm 把 alpha
   存在 BlockAdditional 里）。既然没法自证正确，就不把它作为可选项发布。
   真需要小体积透明素材，用 ProRes 导入剪辑软件后导出 webm，那是那边的事。 */
if (!ALPHA && ALPHA_CODEC !== 'prores') {
  console.warn('⚠ --alpha-codec 只在 --alpha 时才有意义，当前按普通 H.264 输出。');
}
if (ALPHA && ALPHA_CODEC !== 'prores') {
  console.error(`✗ --alpha-codec 目前只支持 prores（收到 "${ALPHA_CODEC}"）。`);
  console.error('  原因：VP9 的 alpha 在本机 ffmpeg 上实测编不出可用结果（播放整帧透明），');
  console.error('        与其给一个验不了的选项，不如只提供能自证的一种。');
  console.error('  ProRes 4444 是 Premiere / DaVinci / Final Cut / 剪映 都能直接识别的透明格式。');
  process.exit(1);
}

/* ProRes 4444：剪辑软件原生支持，10bit，体积约为 H.264 的 5–10 倍，但能直接拖进时间线用。 */
const OUT_EXT = ALPHA ? '.mov' : '.mp4';

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
   --tmpdir=<目录> 把逐帧目录放到别的盘 —— 1080p 一分钟片子要 2~3 GB 逐帧 PNG，
   系统盘经常没有这个余量（实测踩过 ENOSPC，渲到一半炸掉）。
   固定目录靠 job.json 认参数：fps/尺寸/范围一变就拒绝续渲，否则会拼出前后不一致的片子。 */
const TMP_ROOT   = TMPDIR_RAW ? path.resolve(TMPDIR_RAW) : DIR;
const RESUME_DIR = path.join(TMP_ROOT, '.seek-tmp-resume');
const TMP_DIR   = RESUME ? RESUME_DIR : path.join(TMP_ROOT, '.seek-tmp-' + Date.now() + '-' + process.pid);

/* 磁盘余量预检。
   一辆 1080p 的逐帧 PNG 约 1.35 MB/帧（实测 1920×1080 内容平均 1.34 MB），
   一分钟 30fps 就是 2.4 GB —— 系统盘经常没有这个余量。
   不预检的话，渲到一半 ENOSPC：半个目录留在盘上、报错是 `ENOSPC: no space left on device, write`，
   跟「渲染」看起来毫无关系。宁可开工前就说清楚。 */
(function preflightDisk() {
  const frames = Math.max(1, F1 - F0);
  const needGB = (frames * WIDTH * HEIGHT * 0.65) / 1e9;
  const existingRoot = (() => {
    let p = TMP_ROOT;
    while (p && !fs.existsSync(p)) {
      const up = path.dirname(p);
      if (up === p) break;
      p = up;
    }
    return p;
  })();
  let freeGB = null;
  try {
    const st = fs.statfsSync(existingRoot);
    freeGB = (st.bavail * st.bsize) / 1e9;
  } catch (e) {
    return;   // 拿不到就跳过，别因为探测失败挡住渲染
  }
  if (freeGB < needGB) {
    console.error(`✗ 逐帧目录所在磁盘只剩 ${freeGB.toFixed(2)} GB，这段片子逐帧约需 ${needGB.toFixed(2)} GB`);
    console.error(`  目录：${TMP_ROOT}`);
    console.error('  换一块盘：--tmpdir=D:\\h2v-tmp    或减小 --duration / --width / --fps');
    process.exit(1);
  }
  if (freeGB < needGB * 1.25) {
    console.warn(`⚠ 磁盘余量偏紧：可用 ${freeGB.toFixed(2)} GB，预计需要 ${needGB.toFixed(2)} GB`);
  }
})();

/* 字幕时间轴：解析一次，之后每帧只是查表。
   模板侧约定：读到 window.__cues 就用它，没有就退回自己 CFG 里写的时间。 */
let CUES = null;
if (CUES_FILE) {
  try {
    CUES = loadCues(CUES_FILE);
  } catch (e) {
    console.error(`✗ 字幕文件读不了：${CUES_FILE}`);
    console.error('  ' + String((e && e.message) || e).split('\n')[0]);
    process.exit(1);
  }
  if (!CUES.length) {
    console.error(`✗ 字幕文件里没解析出任何一句：${CUES_FILE}`);
    console.error('  SRT 需要形如「00:00:00,500 --> 00:00:02,300」的时间行，且下面跟着正文。');
    process.exit(1);
  }
}

/* 镜头表：整份注入 window.__story，模板（如 explainer.html）拿它换掉自己的 CFG.story。
   这样 LLM / 脚本只要产出 JSON 就能改片子内容，不用去改 HTML 里的代码。 */
let STORY = null;
if (STORY_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(STORY_FILE), 'utf8'));
    STORY = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.shots) ? parsed.shots : null);
  } catch (e) {
    console.error(`✗ 镜头表读不了：${STORY_FILE}`);
    console.error('  ' + String((e && e.message) || e).split('\n')[0]);
    process.exit(1);
  }
  if (!STORY || !STORY.length) {
    console.error(`✗ 镜头表里没有镜头：${STORY_FILE}`);
    console.error('  要是一组对象：[{ "kind":"title", "dur":3, "title":"..." }, ...]');
    process.exit(1);
  }
  for (const s of STORY) {
    if (!s || !(Number(s.dur) > 0)) {
      console.error(`✗ 镜头表里有个镜头没写 dur（或不是正数）：${JSON.stringify(s).slice(0, 120)}`);
      process.exit(1);
    }
  }
}

const JOB = {
  html: HTML_ABS, fps: FPS, from: F0, to: F1,
  width: WIDTH, height: HEIGHT, settle: SETTLE, hideChrome: !KEEP_CHROME,
  cues: CUES ? path.resolve(CUES_FILE) : null,
  story: STORY ? path.resolve(STORY_FILE) : null,
};
const STILL_DIR = path.join(DIR, BASENAME + '.stills');
const MP4_OUT   = path.join(DIR, RANGE_GIVEN
  ? `${BASENAME}.${trimNum(FROM)}-${trimNum(END)}s${OUT_EXT}`
  : BASENAME + OUT_EXT);

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
  console.log(`  size: ${WIDTH}x${HEIGHT} · ${FPS}fps · ${trimNum(FROM)}–${trimNum(END)}s · frames: ${TOTAL_FRAMES} · workers: ${CONCURRENCY}${AUTO_CONC ? ' (auto)' : ''}`);
  if (STORY) {
    const total = STORY.reduce((a, s) => a + (Number(s.dur) || 0), 0);
    console.log(`  镜头表: ${STORY.length} 个镜头（${STORY_FILE}）· 时长合计 ${total.toFixed(2)}s → window.__story`);
  }
  if (ALPHA) console.log(`  alpha: ProRes 4444 (.mov) —— 背景透明，供叠加合成`);
  if (CUES) {
    const last = CUES[CUES.length - 1];
    console.log(`  字幕: ${CUES.length} 句 · ${CUES[0].start.toFixed(2)}–${last.end.toFixed(2)}s → window.__cues`);
  }
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

/* --alpha 时把 html/body 的背景强制让开。
   必须在页面加载完之后做：addInitScript 跑在文档解析之前，那时 documentElement 还是 null，
   往它上面 appendChild 会直接抛 "Cannot read properties of null"。 */
async function applyAlphaCss(page) {
  if (!ALPHA) return;
  try {
    await page.addStyleTag({
      content: 'html,body{background:transparent !important;background-color:transparent !important;}',
    });
  } catch (e) {
    // 没有 head 的怪页面就跳过，模板自身读到 __transparent 也会跳过底色
  }
}

/* 把整条时间轴交给页面。只注入一次，模板自己按 t 查句 —— 
   逐帧注入会让 seek 变成两次 evaluate，白白多一轮往返。 */
async function injectCues(page) {
  if (!CUES) return;
  try {
    await page.evaluate(cs => { window.__cues = cs; }, CUES);
  } catch (e) {
    // 注入失败就让模板用自己 CFG 里的时间表，不阻断渲染
  }
}

/* 镜头表必须在页面脚本跑起来**之前**注入：模板是在加载时就把镜头表编译成时间轴的
   （SC.build 在顶层执行），加载完再 evaluate 已经晚了 —— 页面早按自己的 CFG 建好了。
   所以走 context.addInitScript，和 __seekRender / __transparent 同一条路。 */
async function injectStoryInit(context) {
  if (!STORY) return;
  try {
    await context.addInitScript(ss => { window.__story = ss; }, STORY);
  } catch (e) {
    console.warn('⚠ 镜头表注入失败，模板会用它自己的 CFG.story：' + String((e && e.message) || e));
  }
}

/* 镜头时间轴：模板调了 SC.expose() 才会挂上 window.__sceneTable。
   拿它导出 CSV，并且和 --duration 对一下 —— 最常见的错是镜头表总时长和 --duration 不一致，
   表现是结尾多出一截静止画面（或者片子被截断）。 */
let sceneTableDone = false;
async function captureSceneTable(page) {
  if (!SCENE_LOG || sceneTableDone) return;
  let table = null;
  try {
    table = await page.evaluate(() => (Array.isArray(window.__sceneTable) ? window.__sceneTable : null));
  } catch (e) { return; }
  if (!table || !table.length) return;
  sceneTableDone = true;
  const rows = ['index,id,start,end,dur,trans_in,trans_dur'];
  for (const s of table) {
    rows.push([s.index, s.id, s.start, s.end, s.dur, s.trans_in || 'cut', s.trans_dur || 0].join(','));
  }
  const p = path.resolve(SCENE_LOG);
  try {
    fs.writeFileSync(p, rows.join('\n') + '\n', 'utf8');
    console.log(`  scene-log: ${p}（${table.length} 个镜头）`);
  } catch (e) {
    console.warn('⚠ 镜头表 CSV 写不了：' + String((e && e.message) || e));
    return;
  }
  const total = table[table.length - 1].end;
  const span = (F1 - F0) / FPS;
  if (Math.abs(total - span) > 0.05) {
    console.warn(`⚠ 镜头表总时长 ${total.toFixed(2)}s 与本次渲染 ${span.toFixed(2)}s 不一致`);
    console.warn(`  差 ${(span - total).toFixed(2)}s —— 结尾会多一截静止画面（或片子被截断）。`);
    console.warn('  改 --duration，或改镜头表里各镜头的 dur。');
  }
}

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
const CUE_HITS = CUE_LOG ? new Map() : null;

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
  await applyAlphaCss(page);
  await injectCues(page);
  await captureSceneTable(page);
  await checkStageSize(page);

  for (const f of frames) {
    const t = f / FPS;
    if (CUE_HITS) {
      const c = cueAt(CUES, t);
      CUE_HITS.set(f, c ? c.index : -1);
    }
    await page.evaluate((tt) => window.__seek(tt), t);
    await waitRaf(page, SETTLE);
    const finalPath = path.join(TMP_DIR, 'frame-' + String(f).padStart(6, '0') + '.png');
    // 先写 .part 再改名：渲染中途被 kill 时，不会留下半个 PNG 冒充「已完成」的帧，
    // --resume 才能只认真正画完的那些。
    const partPath = finalPath + '.part';
    // 注意：不能写 screenshot({ path: finalPath + '.part' })。
    // Playwright 按扩展名推断图片格式，'.part' 它认不出来，会抛
    // "unsupported mime type"。所以拿 Buffer 自己落盘，原子改名保留。
    // 只在 --alpha 时才传 omitBackground：显式传 false 也会让 Chromium 走另一条
    // PNG 编码路径（色彩标记从 icc 变成 unknown），画面 PSNR 只有 83dB 而不是 inf。
    // 不用透明的人不该为此付出任何差异。
    const shotOpts = { clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } };
    if (ALPHA) shotOpts.omitBackground = true;
    const buf = await page.screenshot(shotOpts);
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
  await applyAlphaCss(page);
  await injectCues(page);
  await captureSceneTable(page);
  await checkStageSize(page);

  fs.mkdirSync(STILL_DIR, { recursive: true });
  for (const t of times) {
    await page.evaluate((tt) => window.__seek(tt), t);
    await waitRaf(page, SETTLE);
    const name = 't' + t.toFixed(3).padStart(8, '0') + '.png';
    const stillOpts = { path: path.join(STILL_DIR, name), clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } };
    if (ALPHA) stillOpts.omitBackground = true;
    await page.screenshot(stillOpts);
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
    browser = await chromium.launch({ headless: !HEADED });
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

  if (ALPHA) {
    /* 透明输出要两件事同时成立，少一件就白底：
       ① 页面自身背景透明（html/body 的 background 必须让开，模板也要跳过背景层绘制）
       ② 截图时 omitBackground: true（Playwright 默认铺白底）
       模板侧约定：读到 window.__transparent 为 true 就不画背景。
       注意这里只置标志 —— 插 <style> 要等文档解析，放到 applyAlphaCss() 里做。 */
    await context.addInitScript(() => { window.__transparent = true; });
  }

  if (!KEEP_CHROME) {
    await context.addInitScript(hideChromeInit, HIDE_CHROME_CSS);
  }

  await injectStoryInit(context);

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
  const CODEC_LABEL = ALPHA ? 'ProRes 4444' : 'H.264';
  console.log(`▸ Captured ${pngCount}/${TOTAL_FRAMES} frames. Encoding ${CODEC_LABEL}…`);

  /* 字幕命中表：验证「画面里的句子和音频时间对得上」时，凭这张表就能算出误差，
     不必靠肉眼看。列含义：帧号 / 该帧时刻 / 用到的第几句 / 该句起止。 */
  if (CUE_HITS && CUE_HITS.size) {
    const rows = ['frame,t,cue_index,cue_start,cue_end'];
    [...CUE_HITS.keys()].sort((a, b) => a - b).forEach(f => {
      const idx = CUE_HITS.get(f);
      const c = idx >= 0 ? CUES[idx] : null;
      rows.push([f, (f / FPS).toFixed(4), idx,
        c ? c.start.toFixed(3) : '', c ? c.end.toFixed(3) : ''].join(','));
    });
    const p = path.resolve(CUE_LOG);
    fs.writeFileSync(p, rows.join('\n') + '\n', 'utf8');
    console.log(`  cue-log: ${p}（${CUE_HITS.size} 帧）`);
  }

  /* 编码参数
     · 普通   H.264 yuv420p crf18，兼容性最高
     · alpha  ProRes 4444 + yuva444p10le，剪辑软件直接拖进时间线就是透明背景 */
  const enc = ALPHA
    ? ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le',
      '-vendor', 'apl0', '-qscale:v', '11', '-r', String(FPS), '-movflags', '+faststart']
    : ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium',
      '-r', String(FPS), '-movflags', '+faststart'];

  if (ALPHA) {
    // prores_ks 不是所有 ffmpeg 构建都有（比如只开了 libx264 的精简版）。
    // 让它跑到一半才报 "Unknown encoder" 不如提前说清楚。
    const probe = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const list = probe.status === 0 && probe.stdout ? probe.stdout.toString() : '';
    if (list && !list.includes(' prores_ks ')) {
      console.error('✗ 这个 ffmpeg 构建里没有 prores_ks，输出不了透明视频。');
      console.error('  装一个完整版：bash scripts/install-deps.sh');
      console.error(`  帧已留在 ${TMP_DIR}，装好后可直接手动编码，不必重截。`);
      process.exit(1);
    }
  }
  if (GOP_RAW !== null && ALPHA) {
    console.warn('⚠ --gop 只对 H.264 生效，透明输出时忽略。');
  }
  if (GOP_RAW !== null && !ALPHA) {
    // 每秒一个关键帧：后期剪辑按秒 seek 不会冻帧（搬运自 huashu render.py --spec）
    const g = Math.max(1, Math.round(parseFloat(GOP_RAW) * FPS));
    enc.push('-g', String(g), '-keyint_min', String(g), '-sc_threshold', '0');
  }

  const audioTmp = AUDIO ? MP4_OUT.replace(/\.[^.]+$/, '') + '.noaudio' + OUT_EXT : null;
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
    console.error(`      ${enc.join(' ')} out${OUT_EXT}`);
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

  /* ── 派生格式：GIF 与封面 ──────────────────────────────────────────
     这两步都不重渲（直接从成片转），所以放在出片之后：渲一次，发好几个地方。
     GIF 必须走两阶段 palette，直接 -i x.mp4 out.gif 会因为 256 色抖动糊成一片。 */
  if (WANT_GIF) {
    let gFps = 15, gW = 960;
    if (GIF_RAW) {
      const parts = String(GIF_RAW).split(',').map(s => s.trim());
      if (parts[0]) gFps = Math.max(1, Math.min(60, parseInt(parts[0], 10) || 15));
      if (parts[1]) gW = Math.max(64, parseInt(parts[1], 10) || 960);
    }
    const gifOut = MP4_OUT.replace(/\.[^.]+$/, '') + '.gif';
    const pal = gifOut + '.palette.png';
    const vf = `fps=${gFps},scale=${gW}:-1:flags=lanczos`;
    const ff = process.env.FFMPEG || 'ffmpeg';
    const r1 = spawnSync(ff, ['-y', '-v', 'error', '-i', MP4_OUT, '-vf', vf + ',palettegen=stats_mode=diff', pal],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    const r2 = r1.status === 0
      ? spawnSync(ff, ['-y', '-v', 'error', '-i', MP4_OUT, '-i', pal, '-lavfi',
        `${vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, gifOut],
        { stdio: ['ignore', 'ignore', 'pipe'] })
      : null;
    try { fs.rmSync(pal, { force: true }); } catch (e) { /* 清不掉不碍事 */ }
    if (!r2 || r2.status !== 0) {
      const d = r2 && r2.stderr ? r2.stderr.toString().slice(-600) : (r1.stderr ? r1.stderr.toString().slice(-600) : '');
      console.error('✗ GIF 生成失败（成片不受影响）：\n' + d);
    } else {
      console.log(`  gif: ${gifOut} (${(fs.statSync(gifOut).size / 1024 / 1024).toFixed(2)} MB · ${gFps}fps · 宽 ${gW})`);
    }
  }

  if (POSTER_AT !== null) {
    const sec = Math.max(0, parseFloat(POSTER_AT));
    if (!Number.isFinite(sec)) {
      console.warn(`⚠ --poster 的时间读不出来（${POSTER_AT}），跳过封面`);
    } else {
      const posterOut = MP4_OUT.replace(/\.[^.]+$/, '') + '.poster.jpg';
      const r = spawnSync(process.env.FFMPEG || 'ffmpeg',
        ['-y', '-v', 'error', '-ss', String(sec), '-i', MP4_OUT, '-frames:v', '1', '-q:v', '2', posterOut],
        { stdio: ['ignore', 'ignore', 'pipe'] });
      if (r.status !== 0) {
        const d = r.stderr ? r.stderr.toString().slice(-600) : '';
        console.error('✗ 封面抽取失败（成片不受影响）：\n' + d);
      } else {
        console.log(`  poster: ${posterOut}（第 ${sec}s）`);
      }
    }
  }

  if (errorsFatal) {
    console.error('✗ 因页面报错判为失败（成片已产出，供你核对）。修完再渲；确属无关报错可加 --allow-errors。');
    process.exit(1);
  }
})();
