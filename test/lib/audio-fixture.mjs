/**
 * 测试用的合成音频（不往仓库里放 mp3）
 *
 * 为什么自己写 WAV 头而不调 ffmpeg 生成：
 *   期望值必须是**算得出来的**。用 ffmpeg 的 lavfi 拼一条鼓点，得先验证 lavfi 的
 *   节拍是不是真的落在 0.5 的整数倍上；自己写样本就没有这层不确定 ——
 *   第 k 个 kick 就在 k*period 秒，误差是浮点精度级。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const SR = 22050;

export function tmpDir(prefix = 'h2v-audio-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 16bit 单声道 WAV。ffmpeg 能直接读，不需要任何依赖。 */
export function writeWav(file, samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
  return file;
}

/** 确定性伪随机（测试要可复现，不能用 Math.random） */
export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** 鼓组：kick 每拍、2/4 拍加军鼓、反拍加 hat */
export function drumLoop(seconds, bpm, opts = {}) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const period = 60 / bpm;
  const R = rng(7);
  const at = (s) => Math.max(0, Math.round(s * SR));
  for (let k = 0; k * period < seconds; k++) {
    let s0 = at(k * period);
    for (let i = 0; i < 0.1 * SR && s0 + i < n; i++) {
      const t = i / SR;
      out[s0 + i] += 0.9 * Math.sin(2 * Math.PI * 62 * t) * Math.exp(-t * 26);
    }
    if (k % 4 === 1 || k % 4 === 3) {
      s0 = at(k * period);
      for (let i = 0; i < 0.09 * SR && s0 + i < n; i++) {
        const t = i / SR;
        out[s0 + i] += 0.55 * (R() * 2 - 1) * Math.exp(-t * 40);
      }
    }
    if (opts.hats !== false) {
      s0 = at((k + 0.5) * period);
      for (let i = 0; i < 0.04 * SR && s0 + i < n; i++) {
        const t = i / SR;
        out[s0 + i] += 0.12 * (R() * 2 - 1) * Math.exp(-t * 90);
      }
    }
  }
  return out;
}

export function hasFfmpeg() {
  const r = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-version'], { encoding: 'utf8' });
  return r.status === 0;
}
