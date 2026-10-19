/**
 * 输出侧能力用例：--gif / --poster / --batch / --concurrency=auto。
 *
 * 这几个都是「渲完之后的派生动作」，共同点是**错了也不该毁掉成片** ——
 * GIF 编不出来，MP4 照样要躺在目录里。所以这里既验产物存在，也验失败不连坐。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RENDER, TEMPLATES, run, tmpdir } from '../scripts/lib/testing.mjs';

function stage(template) {
  const dir = tmpdir('h2v-out-');
  const html = path.join(dir, template);
  fs.copyFileSync(path.join(TEMPLATES, template), html);
  return { dir, html };
}

test('--gif 出一张 GIF，--poster 抽一张封面（都不重渲）', { timeout: 300000 }, () => {
  const s = stage('title-card.html');
  const r = run(RENDER, [
    s.html, '--from=0', '--to=1', '--fps=12', '--width=640', '--height=360',
    '--gif=12,480', '--poster=0.5',
  ]);
  assert.equal(r.status, 0, `渲染应成功\n${r.stdout}${r.stderr}`);

  const gif = path.join(s.dir, 'title-card.0-1s.gif');
  const poster = path.join(s.dir, 'title-card.0-1s.poster.jpg');
  assert.ok(fs.existsSync(gif), '应产出同名 .gif');
  assert.ok(fs.statSync(gif).size > 2000, `GIF 不该是空文件，实际 ${fs.existsSync(gif) ? fs.statSync(gif).size : '-'} B`);
  assert.ok(fs.existsSync(poster), '应产出 .poster.jpg');
  assert.ok(fs.statSync(poster).size > 2000, '封面不该是空文件');
  assert.match(r.stdout, /gif: /);
  assert.match(r.stdout, /poster: /);
});

test('--batch 按顺序渲一串任务，最后打汇总表', { timeout: 300000 }, () => {
  const dir = tmpdir('h2v-batch-');
  const a = path.join(dir, 'a.html');
  const b = path.join(dir, 'b.html');
  fs.copyFileSync(path.join(TEMPLATES, 'title-card.html'), a);
  fs.copyFileSync(path.join(TEMPLATES, 'number-counter.html'), b);
  const jobs = path.join(dir, 'jobs.json');
  fs.writeFileSync(jobs, JSON.stringify([
    { html: a, duration: 0.5, fps: 6, width: 640, height: 360 },
    { html: b, duration: 0.5, fps: 6, width: 640, height: 360 },
  ]), 'utf8');

  const r = run(RENDER, [`--batch=${jobs}`]);
  const all = r.stdout + r.stderr;
  assert.equal(r.status, 0, `批量渲染应全部成功\n${all}`);
  assert.ok(fs.existsSync(path.join(dir, 'a.mp4')), '第一个任务应出片');
  assert.ok(fs.existsSync(path.join(dir, 'b.mp4')), '第二个任务应出片');
  assert.match(all, /批量汇总/, '最后要有汇总表');
  assert.match(all, /2\/2 成功/);
});

test('--batch 里有一个任务失败时，整体非零退出但其它任务照出片', { timeout: 300000 }, () => {
  const dir = tmpdir('h2v-batch2-');
  const a = path.join(dir, 'a.html');
  fs.copyFileSync(path.join(TEMPLATES, 'title-card.html'), a);
  const jobs = path.join(dir, 'jobs.json');
  fs.writeFileSync(jobs, JSON.stringify([
    { html: a, duration: 0.5, fps: 6, width: 640, height: 360 },
    { html: path.join(dir, '根本不存在.html'), duration: 0.5 },
  ]), 'utf8');

  const r = run(RENDER, [`--batch=${jobs}`]);
  assert.notEqual(r.status, 0, '有一个任务失败，整体就该非零退出（CI 才能拦住）');
  assert.ok(fs.existsSync(path.join(dir, 'a.mp4')), '失败的任务不该连坐掉已经渲好的那个');
  assert.match(r.stdout + r.stderr, /1\/2 成功/);
});

test('--concurrency=auto 会自己挑 worker 数并在日志里说明', { timeout: 300000 }, () => {
  const s = stage('title-card.html');
  const r = run(RENDER, [
    s.html, '--from=0', '--to=0.34', '--fps=6', '--width=640', '--height=360', '--concurrency=auto',
  ]);
  assert.equal(r.status, 0, `auto 并发应能出片\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /workers: \d+ \(auto\)/, '日志要写明是 auto 选的，别让人以为是默认的 4');
  const m = /workers: (\d+) \(auto\)/.exec(r.stdout);
  assert.ok(Number(m[1]) >= 1 && Number(m[1]) <= 8, `auto 选的 worker 数应在 1–8，实际 ${m[1]}`);
});
