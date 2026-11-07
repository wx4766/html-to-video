#!/usr/bin/env node
/**
 * beats.js · 从音频里量出「拍子在哪」
 * ---------------------------------------------------------------------------
 * 为什么需要它：所有「看着高级」的片子都遵守同一条潜规则 —— **切点落在拍上**。
 * 手工对齐是数着秒表挪关键帧，一条 60 秒的片子能耗掉半小时，改一句文案又得重来。
 * 把拍点算出来交给程序，镜头时长就能量化到整拍，"卡点"变成参数而不是手感。
 *
 * 为什么自己写而不是装个库：
 *   1. 这个项目的硬依赖只有 playwright + ffmpeg，多一个 npm 包就多一份装不上的风险
 *      （见 SKILL.md 的四条硬约束，Playwright 版本对不上就整条流水线红）。
 *   2. 我们不需要「音乐信息检索」级别的精度，只需要两件事：
 *      **周期**（BPM）和**相位**（第一拍落在哪）。这两件事用能量通量 + 自相关
 *      就够，误差通常 < 20ms，而人眼对 40ms 以内的切点差异基本无感。
 *
 * 算法（四步，全部是纯计算，不联网、不训练）：
 *   ① ffmpeg 解成 22.05kHz 单声道 f32 → 分帧算对数能量 + 低频能量（贝斯/底鼓）
 *   ② 能量通量 novelty[n] = max(0, E[n] − E[n−1])，再减掉局部均值（去掉整体渐强）
 *   ③ 自相关扫 60–200 BPM，找周期；对倍频/半频做一次「谁更像拍」的裁决
 *   ④ 固定周期，扫一个周期内的相位偏移，取「落点处通量之和」最大的那个
 *
 * 用法：
 *   node scripts/beats.js bgm.mp3                     # 人读：BPM / 拍点数 / 置信度
 *   node scripts/beats.js bgm.mp3 --out=beats.json    # 存成 JSON，给 --beats= 用
 *   node scripts/beats.js bgm.mp3 --json              # stdout 一行 JSON（Agent 用）
 *   node scripts/beats.js voice.m4a --bpm=0           # 只测「有没有稳定节拍」
 *
 * 输出 JSON 结构（v1）：
 *   { version, source, duration, sr, hop, bpm, confidence, offset,
 *     beats: [秒...], downbeats: [秒...], onsets: 个数 }
 *
 * 已知限制（写在这里，省得以后当成 bug 查）：
 *   · 纯人声（无伴奏配音）通常测不出稳定 BPM，confidence 会很低 —— 这是对的，
 *     旁白本来就该按句子切，不该按拍切。渲染器看到低置信度会告警而不是硬卡。
 *   · 自由速度（rubato）的钢琴曲、变速电子乐会得到一个"平均 BPM"，
 *     后半段可能整体偏移；需要严格对齐请用 --bpm/--offset 手工指定。
 *   · 只支持「每拍一个重音」的常见流行/电子/配乐；3/4 拍与复合拍不做区分，
 *     downbeats 一律按每 4 拍给一个（够用，且不会把 4/4 判错）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/* ── 参数 ──────────────────────────────────────────────────────────── */
function arg(name, def) {
  const p = process.argv.find((a) => a.startsWith('--' + name + '='));
  return p ? p.slice(name.length + 3) : def;
}
const hasFlag = (n) => process.argv.includes('--' + n);

const FILE = process.argv[2];
const CLI = require.main === module;
if (CLI && (!FILE || FILE.startsWith('--'))) {
  console.error('用法: node scripts/beats.js <音频或视频文件> [选项]');
  console.error('  --out=<file>      把结果写成 JSON（给渲染器 --beats= 用）');
  console.error('  --json            stdout 只输出一行 JSON');
  console.error('  --bpm=<数>        跳过 BPM 估计，直接按这个值算拍点');
  console.error('  --offset=<秒>     跳过相位估计，直接按这个起点算拍点');
  console.error('  --max-seconds=<n> 只分析前 n 秒（默认 900，防止长音频吃内存）');
  process.exit(1);
}

const JSON_MODE = hasFlag('json');
const OUT = arg('out', null);
const FORCE_BPM = arg('bpm', null) !== null ? Number(arg('bpm', null)) : null;
const FORCE_OFFSET = arg('offset', null) !== null ? Number(arg('offset', null)) : null;
const MAX_SEC = Math.max(10, Number(arg('max-seconds', '900')) || 900);

const SR = 22050;          // 采样率：22.05k 对节拍足够，且是 44.1k 的整数分之一
const HOP = 256;           // 帧移 ≈ 11.6ms —— 拍点定位精度的上限就是这个量级
const WIN = 1024;          // 帧长 ≈ 46ms，覆盖一个底鼓的完整衰减

/* ── ① 解码：ffmpeg → f32le 单声道 ────────────────────────────────────
   不走 wav 中转（要多一次落盘、还要自己解 RIFF 头），直接吃 f32le 管道。
   ffmpeg 一定在（渲染器本来就依赖它），路径优先用 FFMPEG 环境变量。 */
function decode(file, maxSeconds) {
  const ff = process.env.FFMPEG || 'ffmpeg';
  const r = spawnSync(ff, [
    '-v', 'error', '-i', file,
    '-t', String(maxSeconds || MAX_SEC),
    '-ac', '1', '-ar', String(SR),
    '-f', 'f32le', '-',
  ], { maxBuffer: 1024 * 1024 * 512, encoding: 'buffer' });

  if (r.error) {
    console.error(`✗ 起不了 ffmpeg：${r.error.message}`);
    console.error('  装法见 SKILL.md「先装依赖」；也可以用 FFMPEG=<绝对路径> 指定。');
    process.exit(1);
  }
  const err = String(r.stderr || '');
  if (r.status !== 0 || !r.stdout || !r.stdout.length) {
    console.error(`✗ 解码失败：${path.basename(file)}`);
    if (err.trim()) console.error('  ' + err.trim().split('\n').slice(-3).join('\n  '));
    else console.error('  文件可能不是音视频，或者这段不支持（试着先转成 .wav / .m4a）。');
    process.exit(1);
  }
  /* Buffer 的 byteOffset 可能不是 4 的倍数（管道分块拼接），必须按 byteOffset 取切片，
     否则 Float32Array 会抛 "start offset of Float32Array should be a multiple of 4"。 */
  const buf = r.stdout;
  const n = Math.floor(buf.length / 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/* ── ② 特征：对数能量 + 低频能量 ─────────────────────────────────────
   只用总能量的话，一段「镲片密集」的段落会把拍点全带偏；
   叠一路低频（<150Hz）能抓住底鼓/贝斯，这才是人脚打拍子的依据。 */
function features(pcm) {
  const nFrames = Math.max(1, Math.floor(pcm.length / HOP) + 1);
  const lp = new Float32Array(pcm.length);
  // 一阶低通（RC），fc≈150Hz：a = dt/(RC+dt)
  const dt = 1 / SR;
  const rc = 1 / (2 * Math.PI * 150);
  const a = dt / (rc + dt);
  let y = 0;
  for (let i = 0; i < pcm.length; i++) { y += a * (pcm[i] - y); lp[i] = y; }

  /* 窗口要**以帧时刻为中心**，不能从帧时刻往后取。
     向后取（start = f*HOP）会让每一帧提前半个窗长"看见"声音：
     实测 0.25s 的军鼓会在 0.209s 的帧里就出现，全部拍点系统性偏早 40ms，
     而 40ms 恰好是"卡点准不准"的临界值 —— 人耳听得出画面抢了一点点。
     居中后 帧 f 的时间就是 f*HOP/SR，误差压到半个帧移（≈6ms）。 */
  const eFull = new Float32Array(nFrames);
  const eLow = new Float32Array(nFrames);
  const half = WIN >> 1;
  for (let f = 0; f < nFrames; f++) {
    const s = f * HOP - half;
    let sf = 0, sl = 0;
    for (let i = 0; i < WIN; i++) {
      const k = s + i;
      if (k < 0 || k >= pcm.length) continue;      // 首尾越界补零
      const v = pcm[k];
      const w = lp[k];
      sf += v * v; sl += w * w;
    }
    eFull[f] = Math.log1p(sf * 1000);
    eLow[f] = Math.log1p(sl * 6000);
  }

  /* 通量：只用正向差分。负向差分是"声音变安静"，那不是拍点，
     留着会把每拍的尾巴也当成一个 onset，周期估计直接翻倍。 */
  const nov = new Float32Array(nFrames);
  for (let f = 1; f < nFrames; f++) {
    const df = Math.max(0, eFull[f] - eFull[f - 1]);
    const dl = Math.max(0, eLow[f] - eLow[f - 1]);
    nov[f] = df + 1.8 * dl;
  }

  /* 去局部均值：整段渐强的副歌不该被判定成"每帧都是拍"。
     窗口取 0.35s（≈ 2 拍 @ 170BPM），比一拍略宽，不会把拍本身减掉。 */
  const L = 30;
  const out = new Float32Array(nFrames);
  let sum = 0;
  for (let i = 0; i < Math.min(L, nFrames); i++) sum += nov[i];
  for (let f = 0; f < nFrames; f++) {
    const lo = Math.max(0, f - L), hi = Math.min(nFrames - 1, f + L);
    const k = hi - lo + 1;
    let s = 0;
    for (let i = lo; i <= hi; i++) s += nov[i];
    out[f] = Math.max(0, nov[f] - (s / k) * 1.15);
  }
  return { nov: out, nFrames, eFull, eLow, mean: sum / Math.max(1, Math.min(L, nFrames)) };
}

/* ── ③ 周期：自相关 + 倍频裁决 ────────────────────────────────────────
   自相关在 2 倍周期上天然也有一个峰（每两拍也是一个"周期"），
   不去裁决就会把 128 BPM 认成 64 BPM。裁决方式：把候选周期的
   「拍点落地强度」算一遍，谁高用谁 —— 比按 BPM 范围硬截更可靠。 */
function estimate(ft) {
  const { nov, nFrames } = ft;
  const fps = SR / HOP;                   // 每秒多少帧 ≈ 86.1
  const lagMin = Math.round(fps * 60 / 200);   // 200 BPM
  const lagMax = Math.round(fps * 60 / 60);    // 60 BPM

  const score = (lag) => {
    if (lag < 2) return 0;
    let s = 0;
    for (let i = lag; i < nFrames; i++) s += nov[i] * nov[i - lag];
    return s / (nFrames - lag);           // 按样本数归一，长 lag 才不会被系统性压低
  };

  /* 零延迟自相关（= 通量总能量），用来把「自相关峰」归一化成 0..1 的节拍清晰度。
     白噪声也有自相关，只是峰值只有总能量的百分之几 —— 这个比值是区分
     「有鼓点」和「听起来像鼓点」最硬的一条证据。 */
  let ac0 = 0;
  for (let i = 0; i < nFrames; i++) ac0 += nov[i] * nov[i];
  ac0 /= Math.max(1, nFrames);

  /* 全静音 / 纯数字静默：通量恒为 0，自相关全是 0，此时"峰"到处都是，
     不加这一条会从空信号里凭空算出一个 BPM 和一串拍点（实测 7 个）。 */
  if (ac0 < 1e-9) return null;

  const ac = new Float64Array(lagMax + 2);
  for (let l = lagMin; l <= lagMax; l++) ac[l] = score(l);

  /* 找局部极大值，再按「拍点强度」排序。
     只取全局最大是不够的：底鼓与军鼓交替时，2 拍周期常常比 1 拍还强。 */
  const cands = [];
  for (let l = lagMin + 1; l < lagMax; l++) {
    if (ac[l] >= ac[l - 1] && ac[l] >= ac[l + 1]) cands.push(l);
  }
  cands.sort((x, y) => ac[y] - ac[x]);
  const top = cands.slice(0, 6);
  if (!top.length) return null;

  const gridScore = (lag) => {
    // 相位粗扫 + 邻域取峰，衡量"这个周期能不能踩在真的 onset 上"
    let best = 0;
    for (let off = 0; off < lag; off += Math.max(1, Math.round(lag / 24))) {
      let s = 0, k = 0;
      for (let p = off; p < nFrames; p += lag) {
        const i = Math.round(p);
        s += nov[i] + 0.5 * (nov[i - 1] || 0) + 0.5 * (nov[i + 1] || 0);
        k++;
      }
      if (k) s /= k;
      if (s > best) best = s;
    }
    return best;
  };

  let best = null;
  for (const lag of top) {
    const g = gridScore(lag);
    const final = g * (1 + 0.15 * (ac[lag] || 0) / (ac[top[0]] || 1));
    if (!best || final > best.final) best = { lag, final, grid: g };
  }
  if (!best) return null;

  /* ── 八度修正（tempo octave）────────────────────────────────────────
     自相关对「半速」有天然偏好：底鼓每拍都在响，那么「每两拍」也是一个
     完美的周期。实测 120BPM 的鼓点循环会被认成 60BPM —— 出来的是
     「隔一拍切一次」，看着像卡点，其实丢了整整一半的切点。

     判据：如果「一半的周期」也能把网格踩得几乎一样准，那真实拍子就是更快的那个。
     反方向（2 倍周期）不能这么推：周期拉长只会漏掉拍点，分数必然下降，
     分数接近只能说明"漏掉的那些拍很弱"，不能说明拍子更慢。 */
  for (let i = 0; i < 2; i++) {
    const half = best.lag / 2;
    if (half < lagMin || half > lagMax) break;
    if (gridScore(half) < best.grid * 0.78) break;
    best = { lag: half, grid: gridScore(half), final: best.final };
  }

  /* 抛物线插值：把整数 lag 细化到小数，BPM 才不会是 3 的倍数跳变。
     八度修正后 lag 可能是 .5，取整后再插值 —— 自相关只在整数 lag 上有值。 */
  const l0 = Math.max(lagMin, Math.min(lagMax, Math.round(best.lag)));
  const y0 = ac[l0 - 1] || 0, y1 = ac[l0] || 0, y2 = ac[l0 + 1] || 0;
  const denom = (y0 - 2 * y1 + y2);
  const shift = Math.abs(denom) > 1e-9 ? 0.5 * (y0 - y2) / denom : 0;
  const lagF = l0 + Math.max(-0.5, Math.min(0.5, shift));

  return {
    lag: lagF,
    bpm: 60 * SR / (HOP * lagF),
    ac: ac[l0] || 0,
    clarity: ac0 > 1e-9 ? (ac[l0] || 0) / ac0 : 0,
  };
}

/* ── ④ 相位：固定周期，扫一个周期内的起点 ─────────────────────────── */
function phase(ft, lagF) {
  const { nov, nFrames } = ft;
  const step = 0.25;                    // 1/4 帧 ≈ 2.9ms，比帧移还细

  /* 「拍点处有多强」与「拍与拍之间有多强」的差，才是节拍存在的证据。
     旧版拿"拍点强度 / 全曲平均"当置信度，结果白噪声也能拿满分 ——
     噪声经过去均值后全是孤立尖峰，随便怎么摆网格都能踩中几个。 */
  const hit = (start) => {
    let s = 0, k = 0;
    for (let p = start; p < nFrames; p += lagF) {
      const i = Math.round(p);
      s += nov[i] + 0.6 * (nov[i - 1] || 0) + 0.6 * (nov[i + 1] || 0);
      k++;
    }
    return k ? s / k : 0;
  };

  let best = { off: 0, score: -1 };
  for (let off = 0; off < lagF; off += step) {
    const v = hit(off);
    if (v > best.score) best = { off, score: v };
  }

  /* 半拍处取对照。真实鼓点上"正拍"远强于"反拍"（底鼓 vs 空拍），
     噪声上两者一样强 —— 这个比值把两种情况分开。 */
  const offbeat = hit(best.off + lagF / 2);
  const contrast = best.score > 1e-6 ? (best.score - offbeat) / best.score : 0;

  /* 再乘一个「拍点一致性」：拍点强度的变异系数越低越像真节拍。
     自由速度的钢琴每拍强弱差很多，会被这一项压低，避免硬卡出一堆奇怪切点。 */
  const vals = [];
  for (let p = best.off; p < nFrames; p += lagF) {
    const i = Math.round(p);
    vals.push(nov[i] + 0.6 * (nov[i - 1] || 0) + 0.6 * (nov[i + 1] || 0));
  }
  const mean = vals.reduce((x, y2) => x + y2, 0) / Math.max(1, vals.length);
  const sd = Math.sqrt(vals.reduce((x, y2) => x + (y2 - mean) ** 2, 0) / Math.max(1, vals.length));
  const steadiness = mean > 1e-6 ? Math.max(0, 1 - sd / mean) : 0;

  /* 两个独立证据相乘/加权：
       clarity   —— 自相关峰占总能量的比例（周期性存在吗）
       contrast  —— 正拍比反拍强多少（网格踩的是鼓点还是噪声）
     只用其一会各自翻车：噪声的 contrast 会被"172 个候选相位里挑最好"抬高，
     而一段持续的低频嗡鸣可能有不错的 clarity 却没有任何拍点。 */
  const clarity = arguments.length > 2 ? arguments[2] : 1;
  /* 映射区间是量出来的，不是拍的：鼓点循环 clarity≈0.9，棕噪声≈0.3。
     0.22 以下一律当成"没有周期性"，0.57 以上当成"拍子很硬"。 */
  const periodicity = Math.max(0, Math.min(1, (clarity - 0.22) / 0.35));
  const conf = Math.max(0, Math.min(1,
    periodicity * 0.7 + Math.max(0, contrast) * 0.3 * (0.5 + 0.5 * steadiness)));
  return { off: best.off, conf };
}

/* ── 主流程 ─────────────────────────────────────────────────────────── */

/**
 * 分析一个音频/视频文件的节拍。渲染器直接 require 这个函数（不走子进程解析 stdout），
 * CLI 只是它的一层壳 —— 两条路径共用同一份实现，不会出现"命令行说 120、渲染器按 118 卡"。
 *
 * @param {string} file  音频或视频文件
 * @param {{bpm?:number|null, offset?:number|null, maxSeconds?:number, debug?:boolean}} [opt]
 * @returns {{version:number,source:string,duration:number,bpm:number|null,confidence:number,
 *            offset:number|null,beats:number[],downbeats:number[],elapsedMs:number}}
 */
function analyze(file, opt) {
  opt = opt || {};
  const t0 = Date.now();
  const pcm = decode(file, opt.maxSeconds);
  const duration = pcm.length / SR;
  const ft = features(pcm);

  let est = estimate(ft);
  if (opt.debug) {
    console.error('estimate:', JSON.stringify(est));
  }
  if (opt.bpm) {
    const lagF = 60 * SR / (HOP * opt.bpm);
    est = { lag: lagF, bpm: opt.bpm, ac: 1, clarity: 1 };
  }

  let offsetSec = opt.offset == null ? null : opt.offset;
  let confidence = 1;
  if (est) {
    if (offsetSec === null) {
      const ph = phase(ft, est.lag, est.clarity || 0);
      offsetSec = ph.off * HOP / SR;
      confidence = opt.bpm ? 1 : ph.conf;
    }
    /* offset 是"第一个落在分析窗口里的拍"，它前面通常还有拍子（只是被切掉了）。
       往回归一拍，让时间轴从头就有拍点 —— 否则前 0.4 秒是个无法卡点的空洞。 */
    const period0 = 60 / est.bpm;
    while (offsetSec - period0 >= -1e-9) offsetSec -= period0;
    if (offsetSec < 0) offsetSec += period0;
  }

  const beats = [];
  if (est) {
    const period = 60 / est.bpm;
    for (let t = offsetSec; t < duration - 1e-6; t += period) beats.push(Math.round(t * 1000) / 1000);
  }

  return {
    version: 1,
    source: path.basename(file),
    duration: Math.round(duration * 1000) / 1000,
    sr: SR, hop: HOP,
    bpm: est ? Math.round(est.bpm * 100) / 100 : null,
    confidence: Math.round(confidence * 1000) / 1000,
    offset: est ? Math.round(offsetSec * 1000) / 1000 : null,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    onsets: ft.nFrames,
    elapsedMs: Date.now() - t0,
  };
}

/** 把秒数吸到最近的拍点（给渲染器 / 模板复用） */
function snap(sec, meta, dir) {
  if (!meta || !meta.bpm || !meta.beats || !meta.beats.length) return sec;
  const period = 60 / meta.bpm;
  const i = Math.round((sec - meta.offset) / period);
  const at = meta.offset + i * period;
  if (dir === 'up') return at >= sec - 1e-6 ? at : at + period;
  if (dir === 'down') return at <= sec + 1e-6 ? at : at - period;
  return at;
}

module.exports = { analyze, snap, SR, HOP };

/* ── CLI 壳 ─────────────────────────────────────────────────────────── */
if (CLI) {
  const meta = analyze(FILE, {
    bpm: FORCE_BPM && FORCE_BPM > 0 ? FORCE_BPM : null,
    offset: FORCE_OFFSET,
    maxSeconds: MAX_SEC,
    debug: !!process.env.BEATS_DEBUG,
  });

  if (FORCE_BPM !== null && !(FORCE_BPM > 0)) {
    console.error(`✗ --bpm 要正数（收到 ${FORCE_BPM}）。想让它自己测就别给这个参数。`);
    process.exit(1);
  }

  if (!meta.bpm || !meta.beats.length) {
    console.error('✗ 没测出稳定节拍。');
    console.error('  纯人声/环境音的片子在物理上就没有周期性重音，这不是 bug。');
    console.error('  想让画面照样卡点：用 --bpm=120 --offset=0 手工给一个网格。');
    meta.bpm = null; meta.beats = []; meta.downbeats = [];
  }

  if (OUT) {
    const p = path.resolve(OUT);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(meta, null, 2) + '\n');
  }

  if (JSON_MODE) {
    process.stdout.write(JSON.stringify(meta) + '\n');
    if (!meta.bpm) process.exitCode = 2;
  } else {
    console.log(`▸ ${meta.source}  ${meta.duration}s`);
    if (meta.bpm) {
      console.log(`  BPM: ${meta.bpm}    拍点: ${meta.beats.length}    小节: ${(meta.duration / (60 / meta.bpm) / 4).toFixed(1)}`);
      console.log(`  首拍: ${meta.offset}s    置信度: ${meta.confidence}`);
      if (meta.confidence < 0.3) {
        console.warn('⚠ 置信度偏低：这段音频可能没有稳定的鼓点（纯配音/自由速度）。');
        console.warn('  按 --snap=beats 卡点会把镜头长度拉得很难看，建议先确认。');
      }
    } else {
      console.warn('⚠ 没有稳定节拍（见上面的说明）。');
    }
    if (OUT) console.log(`  → ${path.resolve(OUT)}`);
    console.log(`  ${meta.elapsedMs}ms`);
    if (!meta.bpm) process.exitCode = 2;
  }
}
