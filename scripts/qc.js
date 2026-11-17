#!/usr/bin/env node
'use strict';
/* =========================================================================
   qc.js —— 成片质检
   -------------------------------------------------------------------------
   为什么需要它：渲染器只保证「帧出得来、码流合法」，不保证「片子能看」。
   实际翻车过的几类，全都不报错、只在成片里才看得见：

     · 片尾两秒音乐还在放、画面已经空了（镜头表 20.47s vs 时间轴 18.25s）
     · 首帧是黑的，两秒后才出现标题 —— 观众第一反应是"卡了"
     · 某一镜忘了写入场，冻在那里 3 秒
     · 混音响度 -22 LUFS，发到平台被压成一团
     · 同一句话在两处重复（复制镜头表时漏改）

   这些用肉眼抽帧很难发现，用 ffmpeg 量一遍却是一眼的事。
   检查项与判据参考 cinecode 的 qc.py（MIT © 2026 Sarp Yıldız），重写为 Node 版：
   只依赖 ffmpeg（不引入 ffprobe，也不引入第三方包）。

   用法：
     node scripts/qc.js film.mp4                 # 全套，hook 不过则退出码 1
     node scripts/qc.js film.mp4 --only=hook,dup # 只跑几项
     node scripts/qc.js film.mp4 --json          # 给 agent 的结构化结果
     node scripts/qc.js film.mp4 --out=review/x  # 指定输出目录

   判据（不是"参考值"，是硬线）：
     hook    前 2 秒必须有运动：相邻帧平均差 ≥ 0.35，且每 2 帧至少有 0.02 的变化
             实测基线：纯色静止 0.00 · 极简标题卡 0.36~0.42 · 加颗粒 0.71
             （实拍片请用 --hook-min=0.5，颗粒会垫高基线）
     loud    网络交付：整体响度 -14 LUFS ±1，真峰值 ≤ -1 dBTP
     dup     完全重复的相邻帧 = 0（有就是渲了同一帧两次）
     freeze  ≥1.5 秒完全没有变化 = 0（长片里刻意定格请显式放行）
   ========================================================================= */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const FF = process.env.FFMPEG || 'ffmpeg';
const argv = process.argv.slice(2);

const opt = (k, d = null) => {
  const p = argv.find((a) => a === '--' + k || a.startsWith('--' + k + '='));
  if (!p) return d;
  if (p === '--' + k) return true;
  return p.slice(k.length + 3);
};
const flag = (k) => argv.includes('--' + k);

const file = argv.find((a) => !a.startsWith('--'));
if (!file) { console.log(USAGE()); process.exit(2); }
if (!fs.existsSync(file)) { console.error(`✗ 没有这个文件：${file}`); process.exit(2); }

const JSON_OUT = flag('json');
const ONLY = String(opt('only', '')).trim();
const EVERY = Number(opt('every', 2)) || 2;
const COLS = Number(opt('cols', 6)) || 6;
/* 默认 0.35 而不是 0.5：实测纯色静止片 0.00、加颗粒静止片 0.71、
   极简标题卡（开镜头）0.42 /（关镜头）0.36。0.5 是照着实拍片定的 ——
   颗粒本身就贡献 0.2~0.7。数字画面没有颗粒，用 0.5 会把「有动但很克制」误判成「没动」。 */
const HOOK_MIN = Number(opt('hook-min', 0.35));
const name = path.basename(file).replace(/\.[^.]+$/, '');
const OUT = path.resolve(opt('out', path.join('review', 'qc-' + name)));

const LINES = [];
const say = (s) => { LINES.push(s); if (!JSON_OUT) console.log(s); };

function USAGE() {
  return `qc · 成片质检（只依赖 ffmpeg）

  node scripts/qc.js <video.mp4> [选项]

  --only=hook,dup,loud   只跑指定检查
  --json                 输出结构化结果（stdout 只有 JSON）
  --out=dir              报告与缩略图输出目录（默认 review/qc-<名字>）
  --every=2 --cols=6     contact sheet 的抽帧间隔与列数
  --hook-min=0.35        首 2 秒运动能量下限（实拍片建议 0.5）

  检查项：hook · info · dup · freeze · black · bright · cuts · loud · sheet`;
}

/* ffmpeg 的 stderr 里带着我们需要的全部信息（包括 -i 时"没有输出文件"的报错） */
function run(args, opts) {
  return spawnSync(FF, ['-hide_banner', '-nostdin', ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: (opts && opts.timeout) || 600000,
  });
}
function tail(r) { return ((r.stderr || '') + (r.stdout || '')).trim(); }

/* ---------- 元信息（用 ffmpeg -i，不依赖 ffprobe） ---------- */
function probe() {
  const r = run(['-i', file]);
  const s = r.stderr || '';
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
  const dur = m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0;
  const v = /Stream #0:0[^\n]*Video:\s*([^,\s]+)[^\n]*?(\d{2,5})x(\d{2,5})/.exec(s);
  const fps = /(\d+(?:\.\d+)?)\s*fps/.exec(s);
  const a = /Stream #\d+:\d+[^\n]*Audio:\s*([^,\s]+)[^\n]*?(\d+)\s*Hz/.exec(s);
  const br = /bitrate:\s*(\d+)\s*kb\/s/.exec(s);
  return {
    duration: dur,
    width: v ? +v[2] : 0, height: v ? +v[3] : 0,
    vcodec: v ? v[1] : null,
    fps: fps ? parseFloat(fps[1]) : 0,
    acodec: a ? a[1] : null, sampleRate: a ? +a[2] : 0,
    kbps: br ? +br[1] : 0,
    bytes: fs.statSync(file).size,
  };
}

/* ---------- 1. hook：前 2 秒必须有运动 ----------
   做法：缩到 160px 灰图 → 相邻帧求差 → signalstats 输出每帧平均亮度。
   灰度差 0 = 两帧完全一样；静态画面 + 颗粒大约 0.2~0.3；一个推镜 0.8~5。 */
function checkHook() {
  const r = run(['-t', '2', '-i', file, '-vf',
    'scale=160:-2,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
    '-an', '-f', 'null', '-']);
  const vals = [...(r.stdout || '').matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)].map((m) => parseFloat(m[1]));
  if (!vals.length) return { ok: false, mean: 0, low: 0, steps: 0, why: '没有测到帧（文件损坏或不是视频）' };
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  /* 每 2 帧取最大，再取最小 —— 允许"画在二拍上"（每张画停两帧），但不允许整段静止 */
  let low = Infinity;
  for (let i = 0; i < Math.max(1, vals.length - 1); i++) low = Math.min(low, Math.max(vals[i], vals[i + 1]));
  const ok = mean >= HOOK_MIN && low >= 0.02;
  return {
    ok, mean, low, steps: vals.length,
    why: ok ? '' : (mean < HOOK_MIN
      ? `前 2 秒几乎没有运动（均值 ${mean.toFixed(2)} < ${HOOK_MIN}）：不要用静止标题开场、不要从黑场淡入`
      : '中间有连续两帧完全不动（可能是冻结或重复帧）'),
  };
}

/* ---------- 2. dup：完全重复的相邻帧 ---------- */
function checkDup() {
  const r = run(['-i', file, '-map', '0:v', '-f', 'framemd5', '-']);
  const hashes = [];
  for (const line of (r.stdout || '').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.trim().split(',');
    if (parts.length >= 6) hashes.push(parts[5].trim());
  }
  const idx = [];
  for (let i = 1; i < hashes.length; i++) if (hashes[i] === hashes[i - 1]) idx.push(i);
  return { frames: hashes.length, dups: idx.length, first: idx.slice(0, 12) };
}

/* ---------- 3. freeze：连续 N 秒没有任何变化 ---------- */
function checkFreeze() {
  const r = run(['-i', file, '-vf', 'freezedetect=n=-60dB:d=1.5', '-map', '0:v', '-f', 'null', '-']);
  const s = (r.stderr || '') + (r.stdout || '');
  const spans = [...s.matchAll(/freeze_start:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));
  return { count: spans.length, starts: spans.slice(0, 12) };
}

/* ---------- 4. black：黑场 ---------- */
function checkBlack() {
  const r = run(['-i', file, '-vf', 'blackdetect=d=0.1:pic_th=0.98:pix_th=0.10', '-an', '-f', 'null', '-']);
  const s = (r.stderr || '') + (r.stdout || '');
  const hits = [...s.matchAll(/black_start:\s*([\d.]+)\s*black_end:\s*([\d.]+)/g)]
    .map((m) => ({ start: +m[1], end: +m[2], dur: +(+m[2] - +m[1]).toFixed(2) }));
  return { count: hits.length, spans: hits.slice(0, 12) };
}

/* ---------- 5. bright：亮度分布（L* 近似） ----------
   为什么关心：全片 L* < 12 的采样超过 15%，在手机户外基本看不清；
   这是"导出后才发现太暗"的唯一客观指标。 */
function checkBright() {
  const r = run(['-i', file, '-vf', 'fps=4,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-an', '-f', 'null', '-']);
  const vals = [...(r.stdout || '').matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)].map((m) => parseFloat(m[1]));
  if (!vals.length) return { samples: 0 };
  const lstar = (y) => {
    const v = Math.min(Math.max((y - 16) / 219, 0), 1);
    return v > 0.008856 ? 116 * Math.pow(v, 1 / 2.4) - 16 : 903.3 * v;
  };
  const L = vals.map(lstar);
  const dark = L.filter((x) => x < 12).length / L.length * 100;
  return {
    samples: L.length,
    mean: +(L.reduce((a, b) => a + b, 0) / L.length).toFixed(1),
    min: +Math.min(...L).toFixed(1),
    max: +Math.max(...L).toFixed(1),
    veryDark: +dark.toFixed(1),
  };
}

/* ---------- 6. cuts：硬切点 ---------- */
function checkCuts() {
  const r = run(['-i', file, '-vf', 'select=\'gt(scene,0.3)\',metadata=print:file=-', '-an', '-f', 'null', '-']);
  const ts = [...(r.stdout || '').matchAll(/pts_time:([\d.]+)/g)].map((m) => parseFloat(m[1]));
  return { count: ts.length, at: ts.map((t) => +t.toFixed(2)).slice(0, 40) };
}

/* ---------- 7. loud：EBU R128 响度 ---------- */
function checkLoud() {
  const r = run(['-i', file, '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-']);
  const s = (r.stderr || '') + (r.stdout || '');
  const cut = s.slice(s.lastIndexOf('Summary:'));
  const get = (k) => {
    const m = new RegExp(k + ':\\s*(-?[\\d.]+|-inf)').exec(cut);
    return m ? m[1] : null;
  };
  const I = get('I'), LRA = get('LRA'), Peak = get('Peak');
  const silent = I === null || I === '-inf';
  const ok = !silent && Math.abs(parseFloat(I) + 14) <= 1 && parseFloat(Peak) <= -1;
  /* 静音也报出来：有声轨却 -70 LUFS 以下，多半是音轨没接上 */
  return { I, LRA, Peak, ok, silent };
}

/* ---------- 8. sheet：一页缩略图 + 时间码 ---------- */
function checkSheet(p, info) {
  if (!info.duration) return { ok: false, why: '不知道时长' };
  const n = Math.max(1, Math.ceil(info.duration / EVERY));
  const cols = Math.min(COLS, n);
  const rows = Math.ceil(n / cols);
  const dst = path.join(OUT, 'sheet.jpg');
  const r = run(['-y', '-i', file, '-vf',
    `select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${EVERY - 0.001})',scale=320:-2,tile=${cols}x${rows}:padding=4:margin=4`,
    '-frames:v', '1', '-update', '1', dst]);
  if (r.status !== 0) return { ok: false, why: tail(r).slice(-200) };
  const idx = [];
  for (let i = 0; i < n; i++) {
    const t = i * EVERY;
    idx.push(`row ${Math.floor(i / cols) + 1} col ${(i % cols) + 1}: ${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}`);
  }
  fs.writeFileSync(path.join(OUT, 'sheet-index.txt'), idx.join('\n') + '\n', 'utf8');
  return { ok: true, tiles: n, cols, rows, file: dst };
}

/* ---------- 调度 ---------- */
const CHECK_ORDER = ['hook', 'info', 'dup', 'freeze', 'black', 'bright', 'cuts', 'loud', 'sheet'];
const want = ONLY ? ONLY.split(',').map((s) => s.trim()).filter(Boolean) : CHECK_ORDER;

if (!JSON_OUT) {
  console.log(`\nqc · ${path.basename(file)}\n${'─'.repeat(58)}`);
}
fs.mkdirSync(OUT, { recursive: true });

const info = probe();
const out = { file, out: OUT, checks: {} };
let hookOk = true;

for (const k of want) {
  try {
    if (k === 'hook') {
      const r = checkHook();
      hookOk = r.ok && hookOk;
      out.checks.hook = r;
      say(`== hook（前 2 秒必须有运动，下限 ${HOOK_MIN}）`);
      say(`   steps=${r.steps} mean=${r.mean.toFixed(2)} low=${r.low.toFixed(3)}  ${r.ok ? 'PASS' : 'FAIL'}`);
      if (!r.ok) say(`   ✗ ${r.why}`);
      if (!r.ok) say('   修法：让第一个镜头从第 1 帧就在动（推镜/横摇/元素入场），不要静止标题 + 淡入');
    } else if (k === 'info') {
      out.checks.info = info;
      say('== info');
      say(`   ${info.width}x${info.height} · ${info.fps}fps · ${info.duration.toFixed(2)}s · ${info.vcodec || '?'} · ${(info.bytes / 1048576).toFixed(1)} MB · ${info.kbps} kb/s`);
      say(`   audio: ${info.acodec ? `${info.acodec} ${info.sampleRate}Hz` : 'none'}`);
    } else if (k === 'dup') {
      const r = checkDup();
      out.checks.dup = r;
      say(`== dup（完全重复的相邻帧）`);
      say(`   frames=${r.frames} duplicates=${r.dups}${r.dups ? '  前几处：' + r.first.join(', ') : ''}  ${r.dups === 0 ? 'PASS' : 'FAIL'}`);
    } else if (k === 'freeze') {
      const r = checkFreeze();
      out.checks.freeze = r;
      say(`== freeze（≥1.5s 完全不动）`);
      say(`   ${r.count === 0 ? 'none  PASS' : 'FAIL: 起点 ' + r.starts.join(', ')}`);
    } else if (k === 'black') {
      const r = checkBlack();
      out.checks.black = r;
      say(`== black（≥0.1s 黑场）`);
      say(`   ${r.count === 0 ? 'none' : r.spans.map((s) => `${s.start}–${s.end}s`).join(' , ')}`);
      if (r.count) say('   注意：首尾刻意的黑场也要确认——观众看到的是"卡了"');
    } else if (k === 'bright') {
      const r = checkBright();
      out.checks.bright = r;
      say(`== bright（L* 亮度，4 采样/秒）`);
      if (!r.samples) say('   没有采样');
      else {
        say(`   均值 ${r.mean} · 最低 ${r.min} · 最高 ${r.max} · L*<12 占 ${r.veryDark}%`);
        if (r.veryDark > 15) say('   ⚠ 超过 15% 的画面接近全黑，手机户外会看不清');
      }
    } else if (k === 'cuts') {
      const r = checkCuts();
      out.checks.cuts = r;
      say(`== cuts（硬切，scene>0.3）`);
      say(`   ${r.count} 处${r.count ? '：' + r.at.join(' / ') + 's' : ''}`);
    } else if (k === 'loud') {
      if (!info.acodec) {
        out.checks.loud = { noAudio: true };
        say('== loud（EBU R128）');
        say('   无音轨（静默片）—— 如果要配音，检查 --audio 是否接上');
        continue;
      }
      const r = checkLoud();
      out.checks.loud = r;
      say(`== loud（EBU R128）`);
      if (r.silent) say('   整体响度 -inf：有音轨但几乎没有声音');
      else say(`   I=${r.I} LUFS · LRA=${r.LRA} LU · 真峰值=${r.Peak} dBFS   ${r.ok ? 'PASS' : 'WARN'}`);
      if (!r.ok && !r.silent) say('   目标：I = -14 LUFS ±1，真峰值 ≤ -1 dBTP（用 h2v master 一步到位）');
    } else if (k === 'sheet') {
      const r = checkSheet(null, info);
      out.checks.sheet = r;
      say(`== sheet（每 ${EVERY}s 一格，${r.cols || 0} 列）`);
      say(r.ok ? `   ${r.file}（索引：sheet-index.txt）` : `   FAIL: ${r.why}`);
    }
  } catch (e) {
    out.checks[k] = { error: String((e && e.message) || e) };
    say(`== ${k}: 检查本身出错 —— ${String((e && e.message) || e)}`);
  }
}

say(`${'─'.repeat(58)}`);

const fails = [];
if (out.checks.hook && !out.checks.hook.ok) fails.push('hook');
if (out.checks.dup && out.checks.dup.dups > 0) fails.push('dup');
if (out.checks.freeze && out.checks.freeze.count > 0) fails.push('freeze');

/* 待处理项：不影响退出码，但必须写进总结，否则「全部通过」会盖掉它们 */
const warns = [];
if (out.checks.loud && !out.checks.loud.ok && !out.checks.loud.noAudio && !out.checks.loud.silent) {
  warns.push(`loud ${out.checks.loud.I} LUFS（跑 h2v master 归到 −14）`);
}
if (out.checks.loud && out.checks.loud.silent) warns.push('loud 有音轨但近乎静音');
if (out.checks.sheet && out.checks.sheet.ok === false) warns.push('sheet 生成失败');
if (out.checks.bright && out.checks.bright.veryDark > 15) warns.push(`bright 近全黑 ${out.checks.bright.veryDark}%`);

if (!JSON_OUT) {
  if (fails.length) console.log(`✗ ${fails.length} 项未通过：${fails.join(' / ')}（报告：${OUT}/report.txt）`);
  else if (warns.length) console.log(`✓ 硬规则全通过 · ⚠ 待处理 ${warns.length} 项：${warns.join(' / ')}（报告：${OUT}/report.txt）`);
  else console.log(`✓ 全部通过（报告：${OUT}/report.txt）`);
}

out.ok = fails.length === 0;
out.fails = fails;
out.warns = warns;
fs.writeFileSync(path.join(OUT, 'report.txt'), LINES.join('\n') + '\n', 'utf8');

if (JSON_OUT) {
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}
/* hook 是硬规则：不过就是 1，让脚本/agent 没法把"没过的片子"读成"过了" */
process.exit(out.ok ? 0 : 1);
