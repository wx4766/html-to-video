#!/usr/bin/env node
'use strict';
/* =========================================================================
   foley.js —— 程序化音效与氛围床
   -------------------------------------------------------------------------
   为什么需要它：一条片子的「质感」一半在声音。但外部音效素材有三个问题：
     1. 版权（商用要授权，很多「免费」库其实不能商用）
     2. 对不上（海浪的节奏和你镜头的呼吸不是一回事）
     3. 装不上（这个项目的硬依赖只有 playwright + ffmpeg）

   所以这里直接合成：噪声整形 + 滤波 + 包络。像「海浪」这种东西，
   本质就是「低频噪声 + 周期 7 秒的慢包络 + 一层高频泡沫」，
   用三十行代码就能做得比素材库更像「这一片海」。

   能力：
     · 程序化音色：wave / wind / hum / foghorn / paper / brush / impact / chime
     · 事件表：按秒摆放，带增益与声像
     · Schroeder 混响：4 comb + 2 allpass，给声音一个「空间」
     · 总线软限幅 + 归一化
     · 直接输出 48kHz / 16bit / 立体声 WAV，喂给 --audio

   用法：
     node scripts/foley.js --out=bed.wav --dur=41 --preset=lighthouse
     node scripts/foley.js --out=bed.wav --dur=20 --events=foley.json
     node scripts/foley.js --list                    列出所有音色

   events JSON：
     [{ "t": 5.5, "type": "foghorn", "gain": 0.5, "pan": 0 },
      { "t": 14.0, "type": "hum", "gain": 0.25, "dur": 26 }]
   ========================================================================= */

const fs = require('fs');

const argv = process.argv.slice(2);
const opt = (k, d = null) => {
  const p = argv.find((a) => a === '--' + k || a.startsWith('--' + k + '='));
  if (!p) return d;
  return p === '--' + k ? true : p.slice(k.length + 3);
};

const SR = 48000;
const OUT = opt('out', 'foley.wav');
const DUR = parseFloat(opt('dur', '20'));
const PRESET = opt('preset', null);
const SEED = parseInt(opt('seed', '7'), 10);

/* 确定性随机：同一条命令每次产出完全一样的音频（便于 A/B） */
let _s = SEED * 2654435761 % 2147483647;
function rnd() {
  _s = (_s * 1103515245 + 12345) & 0x7fffffff;
  return _s / 1073741824 - 1;   // -1 … 1
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ── 双二阶滤波器 ────────────────────────────────────────────────
   RBJ cookbook。四种模式够用了：低通（海浪/风底）、高通（泡沫/纸）、
   带通（风啸）、峰值（共振）。 */
function biquad(type, f, Q, sr) {
  const w = 2 * Math.PI * clamp(f, 20, sr * 0.45) / sr;
  const cw = Math.cos(w), sw = Math.sin(w);
  const alpha = sw / (2 * Q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; }
  else if (type === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; }
  else if (type === 'bp') { b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; }
  else { const A = Math.pow(10, Q / 40); b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; }
  const s = { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
  s.run = (x) => {
    const y = s.b0 * x + s.b1 * s.x1 + s.b2 * s.x2 - s.a1 * s.y1 - s.a2 * s.y2;
    s.x2 = s.x1; s.x1 = x; s.y2 = s.y1; s.y1 = y;
    return y;
  };
  return s;
}

/* ── 音色 ────────────────────────────────────────────────────────
   每个 voice 返回一个 (t) => 幅度 的函数，t 是绝对秒数。
   持续音色（wave/wind/hum）用这个接口；点状音色（foghorn/impact）
   由外层按事件起点调用。 */
const VOICES = {
  /* 海浪：低频噪声 + 周期涌 + 高频泡沫。
     「涌」的周期不是固定的 —— 真实海浪是 6~11 秒不规则，
     固定周期听十秒就会烦。 */
  wave(t, o) {
    const o1 = o || {};
    const period = o1.period || 7.4;
    const ph = Math.sin(t * Math.PI * 2 / period + Math.sin(t * 0.21) * 0.7);
    const swell = Math.pow(Math.abs(ph), 1.5);
    return 0.55 + swell * 0.55;
  },
  /* 风：带通噪声，强度由慢 LFO 控制，再叠一点阵风 */
  wind(t) {
    const gust = Math.sin(t * 0.13) * 0.5 + Math.sin(t * 0.37 + 1.7) * 0.3;
    return 0.45 + 0.35 * Math.max(0, gust) + 0.12 * Math.max(0, Math.sin(t * 0.9));
  },
  /* 灯丝嗡鸣：50Hz 基频 + 100/150Hz 泛音，极轻微 */
  hum(t) {
    return 0.6 + 0.4 * Math.sin(t * 1.1);
  },
  /* 雾笛：两个低频正弦 + 慢起音 + 长衰减。港口的声音都带一点「破」，
     所以加一点点噪声失真。 */
  foghorn(t, o) {
    const d = (o && o.dur) || 6.0;
    if (t < 0 || t > d) return 0;
    const atk = 0.9, rel = 2.6;
    const env = t < atk ? Math.pow(t / atk, 2) : t > d - rel ? Math.pow(clamp((d - t) / rel, 0, 1), 2.2) : 1;
    const f1 = 108, f2 = 163;
    const vib = 1 + Math.sin(t * 5.2) * 0.004;
    return env * (Math.sin(2 * Math.PI * f1 * t * vib) * 0.6 + Math.sin(2 * Math.PI * f2 * t * vib) * 0.34);
  },
  /* 纸：短促颗粒。翻页 = 十几个随机微脉冲。 */
  paper(t, o) {
    const d = (o && o.dur) || 1.2;
    if (t < 0 || t > d) return 0;
    const n = Math.floor(t * 22);
    const g = Math.abs(rnd()) > 0.55 ? 1 : 0.15;
    const env = Math.exp(-t * 3.5);
    return env * g * (0.6 + 0.4 * Math.sin(n * 12.9));
  },
  /* 笔触：带通噪声的短沙沙声 */
  brush(t, o) {
    const d = (o && o.dur) || 0.7;
    if (t < 0 || t > d) return 0;
    return Math.exp(-t * 5.0) * (0.7 + 0.3 * Math.sin(t * 40));
  },
  /* 撞击：低频扫频 + 噪声瞬态 */
  impact(t, o) {
    const d = (o && o.dur) || 1.6;
    if (t < 0 || t > d) return 0;
    const env = Math.exp(-t * 2.2);
    const f = 78 * Math.exp(-t * 1.1) + 34;
    return env * (Math.sin(2 * Math.PI * f * t) * 0.9 + Math.exp(-t * 26) * 0.5);
  },
  /* 钟/铃：几个不谐和泛音，衰减快。用于段落切换。 */
  chime(t, o) {
    const d = (o && o.dur) || 4.0;
    if (t < 0 || t > d) return 0;
    const f = (o && o.f) || 523.25;
    const env = Math.exp(-t * 1.15);
    return env * (
      Math.sin(2 * Math.PI * f * t) * 0.5 +
      Math.sin(2 * Math.PI * f * 2.76 * t) * 0.22 * Math.exp(-t * 1.8) +
      Math.sin(2 * Math.PI * f * 5.4 * t) * 0.10 * Math.exp(-t * 3.2)
    );
  },
};

/* ── 混响：Schroeder ─────────────────────────────────────────────
   4 个并联 comb（不同延迟）+ 2 个串联 allpass。
   没有混响的声音是「贴在耳朵上」的，加了之后才有「这里是个空间」。 */
function reverb(inL, inR, sr, o) {
  o = o || {};
  const wet = o.wet == null ? 0.28 : o.wet;
  const room = o.room == null ? 1 : o.room;
  const combs = [0.0297, 0.0371, 0.0411, 0.0437].map((d) => Math.max(1, Math.round(d * room * sr)));
  const aps = [0.005, 0.0017].map((d) => Math.max(1, Math.round(d * sr)));
  const fb = 0.80, damp = 0.35;

  function chain(input) {
    let out = new Float32Array(input.length);
    for (let c = 0; c < combs.length; c++) {
      const size = combs[c];
      const buf = new Float32Array(size);
      let idx = 0, lp = 0;
      for (let i = 0; i < input.length; i++) {
        const y = buf[idx];
        lp = y * (1 - damp) + lp * damp;
        buf[idx] = input[i] + lp * fb;
        idx = (idx + 1) % size;
        out[i] += y * 0.25;
      }
    }
    for (let a = 0; a < aps.length; a++) {
      const size = aps[a];
      const buf = new Float32Array(size);
      let idx = 0;
      const g = 0.5;
      for (let i = 0; i < out.length; i++) {
        const b = buf[idx];
        const y = -out[i] + b;
        buf[idx] = out[i] + b * g;
        idx = (idx + 1) % size;
        out[i] = y;
      }
    }
    return out;
  }
  const wl = chain(inL), wr = chain(inR);
  const L = new Float32Array(inL.length), R = new Float32Array(inR.length);
  for (let i = 0; i < inL.length; i++) {
    L[i] = inL[i] * (1 - wet) + wl[i] * wet;
    R[i] = inR[i] * (1 - wet) + wr[i] * wet;
  }
  return [L, R];
}

/* ── 预设 ────────────────────────────────────────────────────────
   lighthouse：一条 41 秒的海边夜戏。
     0 起    海浪 + 风底
     5.0     雾笛（中）
     13.6    灯亮 → 嗡鸣淡入（画面在这个点开始有光）
     20.2    灯室特写 → 一声轻铃
     27.6    雾笛（长，更远）
     31.0    拉出 → 低频一下
     38 起   整体渐弱收尾 */
const PRESETS = {
  lighthouse: {
    layers: [
      { type: 'wave', gain: 0.42, pan: -0.15, lfo: 7.4 },
      { type: 'wave', gain: 0.26, pan: 0.42, lfo: 9.1, tune: 1 },
      { type: 'wind', gain: 0.16, pan: 0.1 },
    ],
    events: [
      { t: 5.0, type: 'foghorn', gain: 0.42, dur: 6.5, pan: -0.2 },
      { t: 13.6, type: 'hum', gain: 0.10, dur: 27, pan: 0 },
      { t: 20.2, type: 'chime', gain: 0.16, f: 659.25, pan: 0.1 },
      { t: 27.6, type: 'foghorn', gain: 0.34, dur: 7.5, pan: 0.3 },
      { t: 31.0, type: 'impact', gain: 0.22, dur: 2.2, pan: 0 },
      { t: 36.4, type: 'chime', gain: 0.12, f: 392.0, pan: -0.05 },
    ],
    fadeIn: 2.5,
    fadeOut: 4.0,
    reverb: { wet: 0.30, room: 1.25 },
  },
};

/* ── 合成 ────────────────────────────────────────────────────────
   逐采样合成整条轨（41s × 48k = 197 万采样 × 2 声道，几百毫秒）。
   分层合成完再加混响，最后软限幅。 */
function render(spec) {
  const N = Math.floor(DUR * SR);
  const L = new Float32Array(N), R = new Float32Array(N);

  const panGain = (p) => {
    const a = (clamp(p, -1, 1) + 1) * Math.PI / 4;
    return [Math.cos(a), Math.sin(a)];
  };

  /* 持续层 */
  for (const ly of (spec.layers || [])) {
    const [gl, gr] = panGain(ly.pan || 0);
    const fn = VOICES[ly.type];
    if (!fn) continue;
    /* 每种持续层用自己的滤波链 */
    let fl, fr, fl2, fr2;
    if (ly.type === 'wave') {
      fl = biquad('lp', 520, 0.7, SR); fr = biquad('lp', 520, 0.7, SR);
      fl2 = biquad('hp', 1800, 0.8, SR); fr2 = biquad('hp', 1800, 0.8, SR);
    } else if (ly.type === 'wind') {
      fl = biquad('bp', 620, 1.1, SR); fr = biquad('bp', 680, 1.1, SR);
      fl2 = biquad('lp', 2400, 0.7, SR); fr2 = biquad('lp', 2400, 0.7, SR);
    } else {
      fl = biquad('lp', 4000, 0.7, SR); fr = biquad('lp', 4000, 0.7, SR);
      fl2 = biquad('lp', 4000, 0.7, SR); fr2 = biquad('lp', 4000, 0.7, SR);
    }
    const period = ly.lfo || 7.4;
    for (let i = 0; i < N; i++) {
      const t = i / SR;
      const env = fn(t, { period });
      /* 左右用同一个噪声源，但滤波略有差别 → 有宽度又不糊 */
      const n = rnd();
      if (ly.type === 'wave') {
        const lo = fl.run(n);
        const hi = fl2.run(n) * 0.35;
        const v = (lo * 1.0 + hi) * env * ly.gain;
        L[i] += v * gl * 1.4;
        R[i] += (fr.run(n) * 1.0 + fr2.run(n) * 0.35) * env * ly.gain * gr * 1.4;
      } else if (ly.type === 'wind') {
        L[i] += fl.run(n) * env * ly.gain * gl * 2.0;
        R[i] += fr.run(n) * env * ly.gain * gr * 2.0;
      } else {
        /* hum：正弦，不用噪声 */
        const v = (Math.sin(2 * Math.PI * 50 * t) * 0.5 + Math.sin(2 * Math.PI * 100 * t) * 0.3 + Math.sin(2 * Math.PI * 150 * t) * 0.12) * env * ly.gain;
        L[i] += v * gl; R[i] += v * gr;
      }
    }
  }

  /* 点状事件 */
  for (const ev of (spec.events || [])) {
    const fn = VOICES[ev.type];
    if (!fn) continue;
    const [gl, gr] = panGain(ev.pan || 0);
    const d = ev.dur || 2;
    const n0 = Math.floor(ev.t * SR);
    const n1 = Math.min(N, Math.floor((ev.t + d) * SR));
    let bp, bp2;
    if (ev.type === 'paper') { bp = biquad('hp', 2400, 0.7, SR); bp2 = biquad('hp', 2400, 0.7, SR); }
    else if (ev.type === 'brush') { bp = biquad('bp', 2600, 1.4, SR); bp2 = biquad('bp', 2600, 1.4, SR); }
    else if (ev.type === 'foghorn') { bp = biquad('lp', 420, 0.9, SR); bp2 = biquad('lp', 420, 0.9, SR); }
    else { bp = biquad('lp', 3000, 0.7, SR); bp2 = biquad('lp', 3000, 0.7, SR); }
    for (let i = n0; i < n1; i++) {
      const local = (i - n0) / SR;
      let v = fn(local, { dur: d, f: ev.f });
      if (ev.type === 'foghorn' || ev.type === 'impact') v = bp.run(v);
      if (ev.type === 'paper' || ev.type === 'brush') v = bp.run(v) * 0.8;
      const a = v * ev.gain;
      L[i] += a * gl; R[i] += a * gr;
    }
  }

  /* 混响 */
  const rv = spec.reverb || { wet: 0.25, room: 1 };
  const [rl, rr] = reverb(L, R, SR, rv);

  /* 淡入淡出 + 软限幅 + 归一化 */
  const fi = (spec.fadeIn || 1.5) * SR, fo = (spec.fadeOut || 3) * SR;
  let peak = 0;
  for (let i = 0; i < N; i++) {
    let g = 1;
    if (i < fi) g *= Math.pow(i / fi, 1.6);
    if (i > N - fo) g *= Math.pow(clamp((N - i) / fo, 0, 1), 1.4);
    const a = Math.tanh(rl[i] * g * 1.05);
    const b = Math.tanh(rr[i] * g * 1.05);
    rl[i] = a; rr[i] = b;
    const p = Math.max(Math.abs(a), Math.abs(b));
    if (p > peak) peak = p;
  }
  const norm = peak > 0.001 ? 0.89 / peak : 1;
  for (let i = 0; i < N; i++) { rl[i] *= norm; rr[i] *= norm; }
  return [rl, rr];
}

/* ── WAV ─────────────────────────────────────────────────────────
   16bit PCM 立体声。不用 24bit：平台转码都会降，16bit 足够且体积小一半。 */
function writeWav(path, L, R, sr) {
  const n = L.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 4, 40);
  let o = 44;
  const c16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(c16(L[i]), o); o += 2;
    buf.writeInt16LE(c16(R[i]), o); o += 2;
  }
  fs.writeFileSync(path, buf);
  return buf.length;
}

/* ── CLI ───────────────────────────────────────────────────────── */
if (opt('list')) {
  console.log('可用音色：\n  ' + Object.keys(VOICES).join('\n  '));
  console.log('\n预设：\n  ' + Object.keys(PRESETS).join('\n  '));
  process.exit(0);
}

let spec;
if (opt('events')) {
  spec = JSON.parse(fs.readFileSync(opt('events'), 'utf8'));
  if (Array.isArray(spec)) spec = { events: spec };
  spec.fadeIn = spec.fadeIn == null ? 0.8 : spec.fadeIn;
  spec.fadeOut = spec.fadeOut == null ? 1.5 : spec.fadeOut;
} else if (PRESET) {
  spec = PRESETS[PRESET];
  if (!spec) { console.error('✗ 没有这个预设：' + PRESET + '（可用：' + Object.keys(PRESETS).join(', ') + '）'); process.exit(1); }
} else {
  console.error('✗ 需要 --preset=<名字> 或 --events=<json>；用 --list 看有哪些');
  process.exit(1);
}

const t0 = Date.now();
const [L, R] = render(spec);
const bytes = writeWav(OUT, L, R, SR);
let peak = 0, sum = 0;
for (let i = 0; i < L.length; i++) {
  const v = Math.max(Math.abs(L[i]), Math.abs(R[i]));
  if (v > peak) peak = v;
  sum += L[i] * L[i] + R[i] * R[i];
}
const rms = Math.sqrt(sum / (L.length * 2));
console.log(`✓ ${OUT}`);
console.log(`  ${(DUR).toFixed(2)}s · ${SR}Hz · 立体声 · ${(bytes / 1048576).toFixed(2)} MB · 合成 ${Date.now() - t0}ms`);
console.log(`  峰值 ${(20 * Math.log10(peak || 1e-9)).toFixed(1)} dBFS · RMS ${(20 * Math.log10(rms || 1e-9)).toFixed(1)} dBFS`);
