/**
 * 渲染器 × 节拍：三条「说好了要做到」的事
 *
 *   1. `--beats` 把拍点注入到**页面脚本执行之前**（addInitScript）。
 *      这条最容易被写错：改成加载完再 evaluate，页面早就按自己的 CFG 建好时间轴了，
 *      现象是"参数加了但一点反应都没有"，而且不报错。
 *   2. `--snap=beats` 把片长吸到拍点，成片不会停在半个拍子上。
 *   3. 参数用法错了要**明确失败**，不能悄悄按默认值出片（卡点片差半拍就废了）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir, writeWav, drumLoop, hasFfmpeg } from './lib/audio-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = tmpDir('h2v-render-beats-');
const SKIP = hasFfmpeg() ? false : '本机没有 ffmpeg（设 FFMPEG=<路径> 后再跑）';

function render(html, args) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'render-video-seek.js'), html, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 180000,
  });
  let json = null;
  try { json = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch (e) { /* 非 JSON 模式 */ }
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || ''), json };
}

test('--beats 在页面脚本执行前注入拍点', { skip: SKIP }, () => {
  const wav = writeWav(path.join(TMP, 'a.wav'), drumLoop(4, 120));
  const r = render('test/fixtures/beats-probe.html', [
    '--beats', `--audio=${wav}`, '--duration=1', '--fps=8', '--width=320', '--height=180',
    '--stills=0.5', '--json', `--out=${path.join(TMP, 'probe.mp4')}`,
  ]);
  assert.equal(r.code, 0, `渲染应成功（页面没拿到 __beats 就会 throw）：\n${r.err.slice(-800)}`);
  assert.ok(r.json, 'stdout 应是一行 JSON');
  assert.ok(r.json.beats && r.json.beats.bpm, 'JSON 结果里应有节拍信息');
  assert.ok(Math.abs(r.json.beats.bpm - 120) < 3, `BPM 应接近 120，实际 ${r.json.beats.bpm}`);
});

test('--snap=beats 把片长吸到拍点', { skip: SKIP }, () => {
  const wav = writeWav(path.join(TMP, 'b.wav'), drumLoop(6, 120));
  const out = path.join(TMP, 'snap.mp4');
  const r = render('assets/templates/title-card.html', [
    `--audio=${wav}`, '--beats', '--snap=beats', '--duration=1.1',
    '--fps=10', '--width=320', '--height=180', '--concurrency=2', '--json', `--out=${out}`,
  ]);
  assert.equal(r.code, 0, r.err.slice(-600));
  assert.ok(r.json.duration >= 1.1, '对齐只能往后吸，不能把片子改短');
  /* 120BPM → 0.5s 一拍；成片时长应落在整帧边界上，且不超过 1.1 + 1 拍 */
  assert.ok(r.json.duration <= 1.1 + 0.5 + 0.2, `时长被拉太远：${r.json.duration}s`);
  assert.ok(fs.existsSync(out), '成片应写出');
});

test('--beats 没给音轨：明确失败，而不是按默认时长出片', () => {
  const r = render('test/fixtures/beats-probe.html', ['--beats', '--duration=1', '--stills=0.5']);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /--beats 需要一条音轨/, '要指出缺什么、怎么补');
});

test('--snap 拼错：明确失败并给出唯一合法值', () => {
  const r = render('test/fixtures/beats-probe.html', ['--snap=beat', '--duration=1', '--stills=0.5']);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /--snap 只认 beats/);
});

test('--beats=<json> 用预先算好的网格，不再分析音频', { skip: SKIP }, () => {
  const wav = writeWav(path.join(TMP, 'c.wav'), drumLoop(4, 120));
  const jf = path.join(TMP, 'grid.json');
  const m = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'beats.js'), wav, `--out=${jf}`], { encoding: 'utf8' });
  assert.equal(m.status, 0, m.stderr);
  const grid = JSON.parse(fs.readFileSync(jf, 'utf8'));

  const r = render('test/fixtures/beats-probe.html', [
    `--beats=${jf}`, '--duration=1', '--fps=8', '--width=320', '--height=180', '--stills=0.5', '--json',
  ]);
  assert.equal(r.code, 0, r.err.slice(-600));
  assert.equal(r.json.beats.bpm, grid.bpm, 'BPM 应与预计算文件一致');
  assert.equal(r.json.beats.count, grid.beats.length, '拍点数应与预计算文件一致');
});
