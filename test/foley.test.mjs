/**
 * foley.js 单测。
 *
 * 音频的 bug 是「听不出来但会毁片」的那类：相位反了、静音一段、
 * 采样率写错半秒。所以这里只验**可测量的物理事实**：
 * RIFF 头、采样率、声道数、时长、峰值不越界、不是全程静音。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'foley.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'h2v-foley-'));

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('--list 列出全部音色与预设', () => {
  const r = run(['--list']);
  assert.equal(r.status, 0);
  for (const v of ['wave', 'wind', 'hum', 'foghorn', 'paper', 'brush', 'impact', 'chime']) {
    assert.ok(r.stdout.includes(v), '缺少音色 ' + v);
  }
  assert.ok(r.stdout.includes('lighthouse'));
});

test('生成的 WAV 头部正确（48kHz / 立体声 / 16bit）', () => {
  const out = path.join(TMP, 'a.wav');
  const r = run(['--out=' + out, '--dur=3', '--preset=lighthouse']);
  assert.equal(r.status, 0, r.stderr);
  const b = fs.readFileSync(out);
  assert.equal(b.toString('ascii', 0, 4), 'RIFF');
  assert.equal(b.toString('ascii', 8, 12), 'WAVE');
  assert.equal(b.toString('ascii', 12, 16), 'fmt ');
  assert.equal(b.readUInt16LE(20), 1, 'PCM');
  assert.equal(b.readUInt16LE(22), 2, '立体声');
  assert.equal(b.readUInt32LE(24), 48000);
  assert.equal(b.readUInt16LE(34), 16);
  assert.equal(b.toString('ascii', 36, 40), 'data');
});

test('时长与 --dur 一致（误差 < 1 帧）', () => {
  const out = path.join(TMP, 'b.wav');
  const r = run(['--out=' + out, '--dur=5', '--preset=lighthouse']);
  assert.equal(r.status, 0, r.stderr);
  const b = fs.readFileSync(out);
  const dataBytes = b.readUInt32LE(40);
  const frames = dataBytes / 4;                    // 2 声道 × 16bit
  const secs = frames / 48000;
  assert.ok(Math.abs(secs - 5) < 0.02, '实际 ' + secs.toFixed(3) + 's');
});

test('不削波：峰值不超过 0 dBFS', () => {
  const out = path.join(TMP, 'c.wav');
  const r = run(['--out=' + out, '--dur=4', '--preset=lighthouse']);
  assert.equal(r.status, 0, r.stderr);
  const b = fs.readFileSync(out);
  let peak = 0;
  for (let o = 44; o < b.length; o += 2) peak = Math.max(peak, Math.abs(b.readInt16LE(o)));
  assert.ok(peak < 32767, '峰值 ' + peak + ' 已顶满，会削波');
  assert.ok(peak > 3000, '峰值 ' + peak + ' 太小，说明没声音');
});

test('不是全程静音：后半段仍有能量（雾笛/海浪不能提前结束）', () => {
  const out = path.join(TMP, 'd.wav');
  const r = run(['--out=' + out, '--dur=12', '--preset=lighthouse']);
  assert.equal(r.status, 0, r.stderr);
  const b = fs.readFileSync(out);
  const frames = b.readUInt32LE(40) / 4;
  let sum = 0;
  /* 取 8–11 秒这一段 */
  for (let i = Math.floor(frames * 0.66); i < Math.floor(frames * 0.92); i++) {
    const v = b.readInt16LE(44 + i * 4) / 32768;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / Math.floor(frames * 0.26));
  assert.ok(rms > 0.002, '后半段 RMS ' + rms.toFixed(4) + ' 接近静音');
});

test('事件表模式：自定义事件也能出声', () => {
  const ev = path.join(TMP, 'ev.json');
  fs.writeFileSync(ev, JSON.stringify([
    { t: 0.5, type: 'chime', gain: 0.6, f: 440 },
    { t: 1.5, type: 'impact', gain: 0.6 },
  ]));
  const out = path.join(TMP, 'e.wav');
  const r = run(['--out=' + out, '--dur=4', '--events=' + ev]);
  assert.equal(r.status, 0, r.stderr);
  const b = fs.readFileSync(out);
  let peak = 0;
  for (let o = 44; o < b.length; o += 2) peak = Math.max(peak, Math.abs(b.readInt16LE(o)));
  assert.ok(peak > 2000);
});

test('未知预设给出可行动的报错，而不是静默产出空文件', () => {
  const out = path.join(TMP, 'f.wav');
  const r = run(['--out=' + out, '--dur=2', '--preset=nope']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /没有这个预设/);
  assert.ok(!fs.existsSync(out), '失败时不该留下半截文件');
});
