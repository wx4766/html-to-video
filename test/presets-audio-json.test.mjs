/**
 * v1.5.0 三项能力的用例：多比例一次出、音画对齐、--json。
 *
 * 判据刻意都落在「产物本身」上：尺寸用 ffmpeg 读回来、时长用 ffmpeg 读回来、
 * JSON 必须能被 JSON.parse 且字段对得上真实文件。只看日志里出现了某个词不算数 ——
 * 日志是程序自己说的话，不是证据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { RENDER, run, tmpdir, copyTemplate, probeSize, toolEnv } from '../scripts/lib/testing.mjs';

function stage(template) {
  const dir = tmpdir('h2v-p150-');
  const html = path.join(dir, template);
  copyTemplate(template, html);
  return { dir, html };
}

/** 读媒体时长（秒）。用 ffmpeg 而不是自己算帧数 —— 要验的正是「实际落盘多长」。 */
function probeDur(file) {
  const r = spawnSync(toolEnv().FFMPEG || 'ffmpeg', ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const m = String(r.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/** 造一段指定长度的音频，避免测试依赖仓库里的二进制素材 */
function makeAudio(dir, seconds) {
  const out = path.join(dir, `voice-${seconds}s.m4a`);
  const r = spawnSync(toolEnv().FFMPEG || 'ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi',
    '-i', `sine=frequency=440:duration=${seconds}`, '-c:a', 'aac', out,
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, `造音频失败：${r.stderr}`);
  return out;
}

test('--presets 一条命令出多个比例，每个成片尺寸都对', { timeout: 300000 }, () => {
  const s = stage('bar-chart.html');
  const r = run(RENDER, [
    s.html, '--from=0', '--to=0.34', '--fps=6',
    '--presets=douyin,square', `--out=${path.join(s.dir, 'dist', 'chart.mp4')}`,
  ]);
  assert.equal(r.status, 0, `多比例应全部成功\n${r.stdout}${r.stderr}`);

  const v = path.join(s.dir, 'dist', 'chart-douyin.mp4');
  const q = path.join(s.dir, 'dist', 'chart-square.mp4');
  assert.ok(fs.existsSync(v), '9:16 版本应存在');
  assert.ok(fs.existsSync(q), '1:1 版本应存在');

  /* 关键判据：不是「文件生成了」，而是「尺寸真的按比例变了」 */
  assert.deepEqual(probeSize(v), { w: 1080, h: 1920 }, 'douyin 应是 1080×1920');
  assert.deepEqual(probeSize(q), { w: 1080, h: 1080 }, 'square 应是 1080×1080');
  assert.match(r.stdout, /比例汇总/);
  assert.match(r.stdout, /2\/2 成功/);
});

test('--preset 单比例按平台名定尺寸，拼错会列出可用名字', { timeout: 300000 }, () => {
  const s = stage('title-card.html');
  const ok = run(RENDER, [
    s.html, '--from=0', '--to=0.34', '--fps=6', '--preset=xiaohongshu',
  ]);
  assert.equal(ok.status, 0, `单比例应能出片\n${ok.stdout}${ok.stderr}`);
  // 给了 --to 时成片名带区间，这是既有约定，别按默认名找
  const out = path.join(s.dir, 'title-card.0-0.34s.mp4');
  assert.ok(fs.existsSync(out), `单比例应出片：${out}`);
  assert.deepEqual(probeSize(out), { w: 1080, h: 1440 }, '小红书 3:4 应是 1080×1440');

  const bad = run(RENDER, [s.html, '--from=0', '--to=0.34', '--fps=6', '--preset=papr']);
  assert.notEqual(bad.status, 0, '拼错预设名应直接失败，而不是悄悄用默认尺寸');
  assert.match(bad.stdout + bad.stderr, /不认识的预设名/);
  assert.match(bad.stdout + bad.stderr, /xiaohongshu/, '要告诉用户有哪些可选');
});

test('--audio 不给 duration 时按音频长度出片，尾音不被削掉', { timeout: 300000 }, () => {
  const s = stage('title-card.html');
  const audio = makeAudio(s.dir, 1.5);

  const r = run(RENDER, [s.html, '--fps=6', `--audio=${audio}`, '--json']);
  assert.equal(r.status, 0, `音频驱动应能出片\n${r.stdout}${r.stderr}`);

  const line = r.stdout.trim().split('\n').filter(l => l.trim().startsWith('{')).pop();
  assert.ok(line, '--json 应在 stdout 留下一个 JSON 对象');
  const info = JSON.parse(line);
  assert.equal(info.ok, true);
  assert.ok(info.output && fs.existsSync(info.output), `JSON 里的 output 应真实存在：${info.output}`);

  const dur = probeDur(info.output);
  assert.ok(dur >= 1.5, `成片不该比音频短（会削掉尾音），实际 ${dur}s`);
  assert.ok(dur < 1.5 + 0.5, `也不该多出一大段（超出半秒说明帧/时长算错了），实际 ${dur}s`);
  assert.ok(Math.abs(info.duration - dur) < 0.05, `JSON 报的时长要与文件一致：${info.duration} vs ${dur}`);
  /* 1.5s 的音频经 AAC 编码后实际是 1.5–1.6s，向上取整到整帧会得到 9–10 帧。
     这里验的是「没有削掉尾音」而不是精确帧数 —— 精确值取决于编码器的 padding。 */
  assert.ok(info.frames >= 9 && info.frames <= 11, `帧数应覆盖整段音频，实际 ${info.frames}`);
});

test('--audio-fit=pad：音频比视频短时补静音，而不是把成片截短', { timeout: 300000 }, () => {
  const s = stage('title-card.html');
  const audio = makeAudio(s.dir, 0.5);

  const pad = run(RENDER, [
    s.html, '--fps=6', '--duration=2', `--audio=${audio}`, '--audio-fit=pad', '--json',
  ]);
  assert.equal(pad.status, 0, `补静音模式应能出片\n${pad.stdout}${pad.stderr}`);
  const info = JSON.parse(pad.stdout.trim().split('\n').filter(l => l.trim().startsWith('{')).pop());
  const padDur = probeDur(info.output);
  assert.ok(padDur >= 1.9, `pad 模式应保住 2s 视频长度，实际 ${padDur}s`);

  /* 对照组：同样参数用默认 trim，成片应明显更短 —— 不给对照组，
     pad 生效也可能只是「它本来就长」。 */
  const trim = run(RENDER, [
    s.html, '--fps=6', '--duration=2', `--audio=${audio}`, '--json',
  ]);
  assert.equal(trim.status, 0);
  const tinfo = JSON.parse(trim.stdout.trim().split('\n').filter(l => l.trim().startsWith('{')).pop());
  const trimDur = probeDur(tinfo.output);
  assert.ok(trimDur < padDur - 0.3, `默认 trim 应比 pad 短，trim=${trimDur}s pad=${padDur}s`);
  assert.ok(tinfo.warnings.some(w => /比音频/.test(w)), '长度不一致必须在 warnings 里说清楚');
});

test('--json 的 stdout 只有一行 JSON，人读日志全部走 stderr', { timeout: 300000 }, () => {
  const s = stage('title-card.html');
  const r = run(RENDER, [s.html, '--from=0', '--to=0.34', '--fps=6', '--json']);

  assert.equal(r.status, 0, `应能出片\n${r.stdout}${r.stderr}`);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `stdout 只能有一行，实际 ${lines.length} 行：\n${r.stdout}`);
  const info = JSON.parse(lines[0]);
  for (const k of ['ok', 'output', 'width', 'height', 'fps', 'duration', 'frames', 'warnings']) {
    assert.ok(k in info, `JSON 缺少字段 ${k}`);
  }
  assert.equal(info.width, 1920);
  assert.equal(info.height, 1080);
  assert.ok(Array.isArray(info.warnings), 'warnings 应是数组（没有告警就是空数组）');
  assert.match(r.stderr, /Seek-rendering/, '人读日志应改道 stderr');
});
