#!/usr/bin/env node
'use strict';
/* =========================================================================
   audio-master.js —— 响度母版（两遍线性归一）
   -------------------------------------------------------------------------
   为什么需要它：渲染器只负责「把音轨封进 MP4」，不管多响。
   实测我们自己渲的演示片是 -17.7 LUFS —— 发到抖音/B站/YouTube，平台会各自
   压一遍，观众听到的是"忽大忽小、人声被压扁"。

   正确做法是交付前统一到 -14 LUFS（网络标准）+ 真峰值 ≤ -1 dBTP。

   两个容易踩的坑（这版都处理了）：
   1. **loudnorm 会静默切到动态模式**。如果测得 LRA（响度范围）大于目标 LRA，
      ffmpeg 会悄悄换成压缩器，把你的混音压扁 —— 而它只在这行 JSON 里说。
      这里把 normalization_type 打出来，不是 linear 就明确警告。
   2. **AAC 编码会把真峰值抬高 0.5–0.7 dB**。带视频封装时目标压到 -2 dBTP，
      编码后重新测一遍，按实测值判断，而不是按理论值。

   用法：
     node scripts/audio-master.js mix.wav master.wav
     node scripts/audio-master.js mix.wav film.mp4 --video=picture.mp4
     node scripts/audio-master.js mix.wav out.mp4 --video=picture.mp4 --limit
     node scripts/audio-master.js mix.wav out.wav --I=-16 --TP=-1.5

   参数：--I 目标整体响度（-14）· --TP 真峰值上限 · --LRA 响度范围（20）
        --limit 峰值会顶破时，先增益再过前瞻限幅器，再线性归一
   ========================================================================= */

const fs = require('fs');
const { spawnSync } = require('child_process');

const FF = process.env.FFMPEG || 'ffmpeg';
const argv = process.argv.slice(2);

const opt = (k, d = null) => {
  const p = argv.find((a) => a === '--' + k || a.startsWith('--' + k + '='));
  if (!p) return d;
  return p === '--' + k ? true : p.slice(k.length + 3);
};

/* 位置参数只认不以 -- 开头的：这样 `mix.mp4 --video=mix.mp4 --out=final.mp4`
   和 `mix.mp4 final.mp4 --video=picture.mp4` 两种写法都能用。
   第一版把 argv[1] 直接当 out，于是 `--out=` 那次的 out 变成了 "--video=…"，
   ffmpeg 报 Unrecognized option（踩过）。 */
const positional = argv.filter((a) => !a.startsWith('--'));
const mix = positional[0];
const out = opt('out', positional[1] || null);
if (!mix || !out || mix.startsWith('--')) {
  console.log(`audio-master · 两遍线性响度归一

  node scripts/audio-master.js <mix.wav> <out.wav|out.mp4> [选项]
  node scripts/audio-master.js <film.mp4> --video=<film.mp4> --out=<final.mp4>

  --out=final.mp4       输出路径（也可以直接写在第二个位置参数）
  --video=picture.mp4   和画面一起封装（视频流直接 copy，音频转 AAC 320k/48k）
  --I=-14               目标整体响度 LUFS（默认 -14，网络交付标准）
  --TP=-1               真峰值上限 dBTP（带视频时内部会用 -2，因为 AAC 会抬峰值）
  --LRA=20              响度范围上限；超过会让 loudnorm 静默切成动态模式
  --no-limit            不先限幅（峰值会顶破时 loudnorm 会退回动态模式）

  为什么要"两遍"：第一遍只测量，第二遍用测得的数值做一次固定增益（linear=true），
  这样动态不被压缩。单遍 loudnorm 是"边测边压"，会改变你的混音。`);
  process.exit(2);
}

const VIDEO = opt('video', null);
const TARGET_I = parseFloat(opt('I', -14));
const TP_RAW = opt('TP', null);
const LRA = parseFloat(opt('LRA', 20));
/* 限幅默认开：BGM 类素材的 crest factor 常在 15 LU 以上，要靠线性增益
   推到 -14 LUFS 必然顶破峰值；不先限幅，loudnorm 只能悄悄退回动态模式。
   要"原样保留动态、宁可响度不达标"时用 --no-limit。 */
const USE_LIMIT = !argv.includes('--no-limit');

/* 带视频封装时目标压到 -2：AAC 编码会把真峰值抬 0.5–0.7 dB；
   但"是否合格"仍按用户给的 -1 判。 */
const ceilingCheck = TP_RAW != null ? parseFloat(TP_RAW) : -1;
const TP = TP_RAW != null ? parseFloat(TP_RAW) : (VIDEO ? -2 : -1);

function run(args) {
  const r = spawnSync(FF, ['-hide_banner', '-nostdin', ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000,
  });
  return { ok: r.status === 0, text: ((r.stderr || '') + (r.stdout || '')) };
}
function die(msg) { console.error('✗ ' + msg); process.exit(1); }

function lastJson(text) {
  const blocks = text.match(/\{[^{}]*\}/gs) || text.match(/\{[^{}]*\}/g);
  if (!blocks || !blocks.length) die('ffmpeg 输出里找不到 loudnorm 的 JSON（这个 ffmpeg 版本可能不支持 loudnorm）');
  try { return JSON.parse(blocks[blocks.length - 1]); }
  catch (e) { die('loudnorm JSON 解析失败：' + String(e.message)); }
}

function ebur128(file) {
  const r = run(['-i', file, '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-']);
  const t = r.text;
  const cut = t.slice(t.lastIndexOf('Summary:'));
  const get = (k) => {
    const m = new RegExp(k + ':\\s*(-?[\\d.]+|-inf)').exec(cut);
    return m ? m[1] : '?';
  };
  return { I: get('I'), LRA: get('LRA'), Peak: get('Peak') };
}

function duration(file) {
  const r = run(['-i', file]);
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(r.text);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0;
}

const target = `I=${TARGET_I}:TP=${TP}:LRA=${LRA}`;
const measure = (pre) => lastJson(run([
  '-i', mix, '-af', `${pre}loudnorm=${target}:print_format=json`, '-f', 'null', '-',
]).text);

console.log(`\nmaster · ${mix}${VIDEO ? '  →  ' + out + '（带画面）' : ''}`);

/* ---------- Pass 1：只测量 ---------- */
/* let 而不是 const：走 --limit 时限幅器会改变信号，必须用**限幅后**的测量值
   再去做第二遍。第一版这里没接返回值，pass 2 拿着"限幅前"的数值去归一，
   loudnorm 一比发现对不上，静默退回动态模式 —— 限幅白做。 */
let m = measure('');
console.log(`  pass 1  I=${m.input_i} LUFS  TP=${m.input_tp} dBTP  LRA=${m.input_lra} LU  thresh=${m.input_thresh}`);

let silent = false;
try { silent = !(parseFloat(m.input_i) > -70); } catch (e) { silent = true; }

if (silent) {
  /* 全静音：不要"归一"成噪声。保持原样并说清楚原因 —— 刻意的默片是对的，
     但"忘了接音轨"必须让人看见。 */
  const args = VIDEO
    ? ['-y', '-i', VIDEO, '-i', mix, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-af', 'apad', '-c:a', 'aac', '-b:a', '128k', '-shortest', out]
    : ['-y', '-i', mix, '-c:a', 'pcm_s24le', out];
  const r = run(args);
  if (!r.ok) die('封装失败：' + r.text.slice(-500));
  console.log('  ⚠ 音轨整体低于 -70 LUFS（等于没有声音）。保留原样。');
  console.log('    如果这不是刻意的默片，说明音乐/配音没接上。');
  console.log('✓ 完成（未做响度归一）');
  process.exit(0);
}

let gain = TARGET_I - parseFloat(m.input_i);
let ceiling = TP - 1.5;

/* ---------- 需要限幅时：先增益 + 前瞻限幅，再重新测 ---------- */
function limited(g0, c0) {
  let g = g0, c = c0, mm = m;
  for (let i = 0; i < 4; i++) {
    /* level=false 很关键：level=true（默认）会把输出自动抬到 0 dB，
       于是 loudnorm 测到的峰值永远顶格，只能退回动态模式。
       另外这个 ffmpeg 版本的 alimiter 没有 latency 参数（加了会整条 filter 解析失败）。 */
    const pre = `volume=${g.toFixed(2)}dB,alimiter=limit=${Math.pow(10, c / 20).toFixed(4)}:attack=5:release=60:level=false,`;
    mm = measure(pre);
    console.log(`  limit   +${g.toFixed(2)} dB → 限幅 ${c.toFixed(1)} dBFS  ⇒  I=${mm.input_i} LUFS  TP=${mm.input_tp} dBTP  LRA=${mm.input_lra} LU`);
    const over = parseFloat(mm.input_tp) + (TARGET_I - parseFloat(mm.input_i)) - (TP - 0.3);
    if (over <= 0) break;
    c -= over + 0.3;
    g += over + 0.3;
  }
  return { pre: `volume=${g.toFixed(2)}dB,alimiter=limit=${Math.pow(10, c / 20).toFixed(4)}:attack=5:release=60:level=false,`, m: mm, gain: g, ceiling: c };
}

let pre = '';
if (USE_LIMIT && parseFloat(m.input_tp) + gain > TP - 0.5) {
  const r = limited(gain, ceiling);
  pre = r.pre; gain = r.gain; ceiling = r.ceiling;
  m = r.m;                       // 关键：用限幅后的测量值重算（见上面的注释）
}

/* ---------- Pass 2：线性归一 + 编码，然后实测复核 ---------- */
let result = null;
for (let attempt = 0; attempt < 4; attempt++) {
  if (parseFloat(m.input_lra) > LRA) {
    console.log(`  ⚠ 测得 LRA ${m.input_lra} LU > 目标 ${LRA} LU：loudnorm 会切到**动态模式**（等于加压缩器）。`);
    console.log(`    想保住动态就把 --LRA 调到 ${Math.ceil(parseFloat(m.input_lra))}。`);
  }
  const af = `${pre}loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:` +
    `measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=json`;

  let args;
  if (VIDEO) {
    const vd = duration(VIDEO), md = duration(mix);
    if (attempt === 0 && Math.abs(vd - md) > 0.1) {
      console.log(`  ⚠ 混音 ${md.toFixed(2)}s / 画面 ${vd.toFixed(2)}s：${md < vd ? '尾部补静音' : '音频在最后一帧截断'}`);
    }
    args = ['-y', '-i', VIDEO, '-i', mix, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
      '-af', af + ',apad', '-c:a', 'aac', '-b:a', '320k', '-ar', '48000',
      '-movflags', '+faststart', '-shortest', out];
  } else {
    args = ['-y', '-i', mix, '-af', af, '-ar', '48000', '-c:a', 'pcm_s24le', out];
  }

  const r = run(args);
  if (!r.ok) die('编码失败：' + r.text.slice(-600));
  result = lastJson(r.text);
  console.log(`  pass 2  type=${result.normalization_type}  I=${result.output_i}  TP=${result.output_tp}  LRA=${result.output_lra}`);
  if (result.normalization_type !== 'linear') {
    console.log('  ⚠ 实际跑了**动态模式**：混音被压缩过。把峰值压下来再母版，或提高 --LRA。');
  }

  const v = ebur128(out);
  console.log(`  实测    I=${v.I} LUFS  LRA=${v.LRA} LU  真峰值=${v.Peak} dBFS`);

  const iVal = parseFloat(v.I), pVal = parseFloat(v.Peak);
  const loudOk = Math.abs(iVal - TARGET_I) <= 1.0;
  if (loudOk && pVal <= ceilingCheck) {
    console.log(`✓ 达标（目标 ${TARGET_I} LUFS ±1，真峰值 ≤ ${ceilingCheck} dBTP）\n`);
    process.exit(0);
  }
  if (attempt === 3) {
    die(`超出目标（实测 ${v.I} LUFS / ${v.Peak} dBTP）。先把混音峰值压下来再跑一次。`);
  }
  const over = pVal - ceilingCheck + 0.3;
  console.log(`  编码后峰值超了 ${(over - 0.3).toFixed(1)} dB：限幅器再低 ${over.toFixed(1)} dB 重编`);
  const rr = limited(gain + over, ceiling - over);
  pre = rr.pre; m.input_i = rr.m.input_i; m.input_tp = rr.m.input_tp;
  m.input_lra = rr.m.input_lra; m.input_thresh = rr.m.input_thresh; m.target_offset = rr.m.target_offset;
  gain = rr.gain; ceiling = rr.ceiling;
}
