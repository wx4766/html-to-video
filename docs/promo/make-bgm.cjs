/* =========================================================================
   make-bgm.cjs — 程序化合成推广片配乐（无版权、无外部素材、确定性）
   120 BPM / A 小调 / Am-F-C-G 循环。镜头切点处加 impact + riser，音画卡点。
   输出 16-bit PCM WAV：bgm-main.wav (32.6s) / bgm-short.wav (20.5s)
   ========================================================================= */
const fs = require('fs');
const path = require('path');

const SR = 44100;
const BPM = 120;
const BEAT = 60 / BPM;
const OUT = __dirname;

/* 和弦：根音频率 + 三个和弦音（A 小调：Am / F / C / G） */
const CHORDS = [
  { bass: 55.00, notes: [220.00, 261.63, 329.63] }, // Am
  { bass: 43.65, notes: [174.61, 220.00, 261.63] }, // F
  { bass: 65.41, notes: [261.63, 329.63, 392.00] }, // C
  { bass: 49.00, notes: [196.00, 246.94, 293.66] }, // G
];

const CUTS_MAIN = [3.6, 8.4, 13.2, 19.0, 24.2, 28.8];
const CUTS_SHORT = [3.0, 8.2, 14.6];

function make(dur, cuts, name) {
  const N = Math.floor(SR * dur);
  const buf = new Float32Array(N);
  let seed = 20261104;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2147483648 - 1; };

  /* 在 [start, start+dur) 区间叠加一个带 ADSR 的音 */
  function tone(start, d, f0, amp, opt) {
    opt = opt || {};
    const i0 = Math.max(0, Math.floor(start * SR));
    const i1 = Math.min(N, Math.floor((start + d) * SR));
    if (i1 <= i0) return;
    const atk = opt.attack === undefined ? 0.008 : opt.attack;
    const rel = opt.release === undefined ? Math.min(0.12, d * 0.4) : opt.release;
    const f1 = opt.sweepTo || f0;
    const type = opt.type || 'sine';
    let phase = 0;
    for (let i = i0; i < i1; i++) {
      const lt = (i - i0) / SR;
      const p = lt / d;
      let env = 1;
      if (atk > 0 && lt < atk) env = lt / atk;
      const relStart = d - rel;
      if (lt > relStart) env *= Math.max(0, 1 - (lt - relStart) / rel);
      const f = f0 + (f1 - f0) * Math.pow(p, 1.6);
      phase += 2 * Math.PI * f / SR;
      let v;
      if (type === 'tri') v = 2 / Math.PI * Math.asin(Math.sin(phase));
      else if (type === 'square') v = Math.sign(Math.sin(phase)) * 0.6;
      else v = Math.sin(phase);
      // 轻微二次谐波，让 pad 不那么单薄
      if (opt.warm) v += 0.16 * Math.sin(phase * 2);
      buf[i] += v * amp * env;
    }
  }

  function noise(start, d, amp, opt) {
    opt = opt || {};
    const i0 = Math.max(0, Math.floor(start * SR));
    const i1 = Math.min(N, Math.floor((start + d) * SR));
    if (i1 <= i0) return;
    let prev = 0;
    const rise = opt.rise || 0;
    for (let i = i0; i < i1; i++) {
      const lt = (i - i0) / SR;
      const p = lt / d;
      let env = Math.pow(1 - p, opt.decayPow || 2);
      if (rise > 0) env *= Math.min(1, p / rise);
      const raw = rnd();
      // 高通：一阶差分，去掉低频浑浊
      const v = raw - prev * 0.86;
      prev = raw;
      buf[i] += v * amp * env;
    }
  }

  const bars = Math.ceil(dur / (BEAT * 4));
  for (let bar = 0; bar < bars; bar++) {
    const t0 = bar * BEAT * 4;
    const ch = CHORDS[bar % 4];
    if (t0 >= dur) break;

    // Pad：一小节的和弦，慢起慢收
    for (const f of ch.notes) {
      tone(t0, BEAT * 4 * 0.98, f, 0.052, { type: 'tri', attack: 0.42, release: 0.55, warm: true });
    }
    // Bass：每拍一下
    for (let b = 0; b < 4; b++) {
      const t = t0 + b * BEAT;
      if (t >= dur) break;
      tone(t, 0.30, ch.bass, 0.155, { type: 'sine', attack: 0.004, release: 0.20 });
    }
    // Kick：1 / 3 拍，低频扫频
    for (const b of [0, 2]) {
      const t = t0 + b * BEAT;
      if (t >= dur) break;
      tone(t, 0.20, 115, 0.235, { type: 'sine', attack: 0.002, release: 0.17, sweepTo: 44 });
    }
    // Snare / clap：2 / 4 拍
    for (const b of [1, 3]) {
      const t = t0 + b * BEAT;
      if (t >= dur) break;
      noise(t, 0.13, 0.048, { decayPow: 2.6 });
    }
    // Hat：八分音符
    for (let k = 0; k < 8; k++) {
      const t = t0 + k * BEAT / 2;
      if (t >= dur) break;
      noise(t, 0.045, k % 2 ? 0.018 : 0.030, { decayPow: 3.2 });
    }
    // Arp：十六分音符，和弦音循环，带一点延迟感
    for (let k = 0; k < 16; k++) {
      const t = t0 + k * BEAT / 4;
      if (t >= dur) break;
      const f = ch.notes[(k * 2 + bar) % 3] * (k % 8 >= 6 ? 2 : 1);
      tone(t, 0.16, f, 0.036, { type: 'tri', attack: 0.003, release: 0.12 });
    }
  }

  // 镜头切点：前 0.42s riser + 切点 impact
  for (const c of cuts) {
    if (c >= dur) continue;
    noise(Math.max(0, c - 0.42), 0.42, 0.032, { rise: 0.75, decayPow: 0.6 });
    tone(c, 0.36, 62, 0.105, { type: 'sine', attack: 0.002, release: 0.33, sweepTo: 38 });
    noise(c, 0.16, 0.030, { decayPow: 2.0 });
  }

  // 整体包络 + 软限幅
  const fadeIn = 0.55, fadeOut = 1.45;
  let peak = 0;
  for (let i = 0; i < N; i++) { const a = Math.abs(buf[i]); if (a > peak) peak = a; }
  const norm = peak > 0 ? 0.86 / peak : 1;
  const pcm = Buffer.alloc(N * 2);
  for (let i = 0; i < N; i++) {
    const tsec = i / SR;
    let env = 1;
    if (tsec < fadeIn) env = tsec / fadeIn;
    if (tsec > dur - fadeOut) env *= Math.max(0, (dur - tsec) / fadeOut);
    let v = Math.tanh(buf[i] * norm * 1.12) * env;
    const s = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    pcm.writeInt16LE(s, i * 2);
  }

  // WAV 头（单声道 16-bit PCM）
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(SR, 24);
  head.writeUInt32LE(SR * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(pcm.length, 40);
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.concat([head, pcm]));
  console.log(name + '  ' + dur.toFixed(2) + 's  ' + (fs.statSync(file).size / 1048576).toFixed(2) + ' MB  peak=' + peak.toFixed(3));
}

make(32.6, CUTS_MAIN, 'bgm-main.wav');
make(20.5, CUTS_SHORT, 'bgm-short.wav');
