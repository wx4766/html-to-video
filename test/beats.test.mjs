/**
 * 节拍分析测试（scripts/beats.js）
 *
 * 为什么用「合成音频」而不是带一个 mp3 进仓库：
 *   1. 版权干净，仓库不用挂二进制素材；
 *   2. 期望值是算出来的，不是"听上去差不多"—— 120BPM 的拍点必须落在 0.5 的倍数上，
 *      差 40ms 就该红：人耳听不出来，但观众能"感觉画面抢了"。
 *
 * 三条断言对应三种真实故障：
 *   · BPM 测成一半/一倍 —— 自相关对半速有天然偏好，八度修正写错就会"隔一拍切一次"
 *   · 拍点系统性偏早 —— 分析窗从帧时刻往后取，会提前半个窗长"看见"声音
 *   · 没有节拍的音频也报高置信度 —— 渲染器据此硬卡点，会把旁白片切得莫名其妙
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { SR, tmpDir, writeWav, rng, drumLoop, hasFfmpeg } from './lib/audio-fixture.mjs';

const require = createRequire(import.meta.url);
const beats = require('../scripts/beats.js');

const TMP = tmpDir('h2v-beats-');
const SKIP = hasFfmpeg() ? false : '本机没有 ffmpeg（设 FFMPEG=<路径> 后再跑）';

test('120BPM 鼓点：BPM、拍距、相位都对得上', { skip: SKIP }, () => {
  const f = writeWav(path.join(TMP, 'drum120.wav'), drumLoop(8, 120));
  const m = beats.analyze(f);

  assert.ok(m.bpm, '应该测出 BPM');
  assert.ok(Math.abs(m.bpm - 120) < 2, `BPM 应接近 120，实际 ${m.bpm}（八度修正出错？）`);

  const period = 60 / m.bpm;
  for (let i = 1; i < m.beats.length; i++) {
    assert.ok(Math.abs((m.beats[i] - m.beats[i - 1]) - period) < 0.02, '相邻拍间隔应与周期一致');
  }

  /* 相位：每拍都应落在 0.5s 的整数倍附近（容差 35ms ≈ 半个帧移 + 一帧窗）。
     这一条挡的是"整条时间轴平移半个窗长"那种系统性偏早。 */
  const worst = Math.max(...m.beats.map((t) => Math.abs(t - Math.round(t / 0.5) * 0.5)));
  assert.ok(worst < 0.035, `拍点整体偏移 ${(worst * 1000).toFixed(0)}ms，超过 35ms`);

  assert.ok(m.confidence > 0.55, `鼓点循环的置信度应偏高，实际 ${m.confidence}`);
});

test('90BPM：慢速也能测对（不被倍频带偏）', { skip: SKIP }, () => {
  const f = writeWav(path.join(TMP, 'drum90.wav'), drumLoop(9, 90));
  const m = beats.analyze(f);
  assert.ok(Math.abs(m.bpm - 90) < 3, `BPM 应接近 90，实际 ${m.bpm}`);
});

test('无节拍的棕噪声：不该自信地说"这是 120 拍"', { skip: SKIP }, () => {
  const n = Math.round(6 * SR);
  const R = rng(11);
  const out = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) { acc = acc * 0.985 + (R() * 2 - 1) * 0.15; out[i] = acc; }
  const m = beats.analyze(writeWav(path.join(TMP, 'noise.wav'), out));
  assert.ok(m.confidence < 0.45, `噪声的置信度应偏低，实际 ${m.confidence}`);
});

test('静音：不产生拍点，也不抛错', { skip: SKIP }, () => {
  const m = beats.analyze(writeWav(path.join(TMP, 'silence.wav'), new Float32Array(Math.round(2 * SR))));
  assert.equal(m.beats.length, 0);
  assert.equal(m.bpm, null);
});

test('--bpm 强制：跳过估计，按给定 BPM 铺满全片', { skip: SKIP }, () => {
  const f = writeWav(path.join(TMP, 'any.wav'), new Float32Array(Math.round(2 * SR)));
  const m = beats.analyze(f, { bpm: 100, offset: 0 });
  assert.equal(m.bpm, 100);
  assert.ok(m.beats.length >= 3, '2 秒 / 100BPM 应该有 3 个以上拍点');
  assert.ok(Math.abs(m.beats[1] - 0.6) < 0.001, '100BPM 的拍距应是 0.6s');
});

test('snap()：向上/向下/就近吸到拍点', () => {
  const meta = { bpm: 120, offset: 0, beats: [0, 0.5, 1, 1.5] };
  assert.equal(beats.snap(0.62, meta, 'up'), 1);
  assert.equal(beats.snap(0.62, meta, 'down'), 0.5);
  assert.equal(beats.snap(0.62, meta), 0.5);
  assert.equal(beats.snap(0.4, meta), 0.5);
  // 没有节拍信息时原样返回（不能让调用方拿到 NaN）
  assert.equal(beats.snap(0.62, { bpm: null }), 0.62);
});
