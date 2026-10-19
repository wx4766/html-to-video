/**
 * 多镜头用例：explain.html 是本仓库唯一走 scenes.js 的模板，
 * 它一坏，整个「一份 HTML 出多镜头片子」的能力就没了，而且坏法很隐蔽
 * （转场错位、镜头时间算错 —— 画面照样出，只是不对）。
 *
 * 这里验三件事：
 *   1. 模板能渲、且六个库文件都加载成功（有报错渲染器会非零退出）
 *   2. --scene-log 导出的镜头表和页面里的镜头表一致
 *   3. --story 能整份换掉剧本（LLM 写 JSON 出片这条路要通）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RENDER, TEMPLATES, run, tmpdir } from '../scripts/lib/testing.mjs';

/** 把模板连同它依赖的 themes.js / ../lib 一起摆进临时目录（保持相对路径结构） */
function stage(template) {
  const root = tmpdir('h2v-shot-');
  const dir = path.join(root, 'page');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(TEMPLATES, template), path.join(dir, template));
  const themes = path.join(TEMPLATES, 'themes.js');
  if (fs.existsSync(themes)) fs.copyFileSync(themes, path.join(dir, 'themes.js'));
  fs.cpSync(path.resolve(TEMPLATES, '..', 'lib'), path.join(root, 'lib'), { recursive: true });
  return { root, dir, html: path.join(dir, template) };
}

test('多镜头模板能出片，且镜头表导出一致', { timeout: 300000 }, () => {
  const s = stage('explainer.html');
  const logCsv = path.join(s.root, 'shots.csv');
  const r = run(RENDER, [
    s.html, '--from=0', '--to=2', '--fps=12', '--width=960', '--height=540',
    '--concurrency=2', `--scene-log=${logCsv}`,
  ]);
  const all = r.stdout + r.stderr;
  assert.equal(r.status, 0, `多镜头渲染应成功\n${all}`);

  const mp4 = path.join(s.dir, 'explainer.0-2s.mp4');
  assert.ok(fs.existsSync(mp4), '应产出 explainer.0-2s.mp4');
  assert.ok(fs.statSync(mp4).size > 20000, '成片不该是空文件');

  assert.ok(fs.existsSync(logCsv), '应产出镜头表 CSV');
  const rows = fs.readFileSync(logCsv, 'utf8').trim().split('\n');
  assert.equal(rows[0], 'index,id,start,end,dur,trans_in,trans_dur', 'CSV 表头固定，别改名');
  assert.equal(rows.length, 6, `默认剧本 5 个镜头 + 表头，实际 ${rows.length} 行`);
  assert.match(rows[1], /^0,hook,/);
  assert.match(rows[2], /^1,why,.*fade|slide/);
  // 镜头首尾相接：上一镜的 end 就是下一镜的 start（转场是重叠，不是插空隙）
  const cells = rows.slice(1).map(l => l.split(','));
  for (let i = 1; i < cells.length; i++) {
    const prevEnd = Number(cells[i - 1][3]);
    const curStart = Number(cells[i][2]);
    assert.ok(curStart < prevEnd, `镜头 ${i} 应和上一镜有重叠（转场段），实际 start=${curStart} 上一镜 end=${prevEnd}`);
  }
});

test('--story 整份换掉剧本：JSON 里的镜头 id 进成片时间轴', { timeout: 300000 }, () => {
  const s = stage('explainer.html');
  const story = path.join(s.root, 'story.json');
  fs.writeFileSync(story, JSON.stringify([
    { kind: 'title', id: 'json-a', dur: 1.0, title: 'JSON 里的一号镜头' },
    { kind: 'outro', id: 'json-b', dur: 1.0, title: 'JSON 里的二号镜头', trans: { in: 'fade', dur: 0.4 } },
  ]), 'utf8');
  const logCsv = path.join(s.root, 'shots2.csv');
  const r = run(RENDER, [
    s.html, '--from=0', '--to=1.6', '--fps=12', '--width=640', '--height=360',
    '--concurrency=2', `--story=${story}`, `--scene-log=${logCsv}`,
  ]);
  assert.equal(r.status, 0, `带 --story 的渲染应成功\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /镜头表: 2 个镜头/, '启动日志应说明用了几镜的镜头表');

  const rows = fs.readFileSync(logCsv, 'utf8').trim().split('\n');
  assert.equal(rows.length, 3, '镜头表被换成了 2 个镜头');
  assert.match(rows[1], /^0,json-a,/);
  assert.match(rows[2], /^1,json-b,.*fade/);
});

test('镜头表总时长与 --duration 不一致时会告警（不是静默多一截黑屏）', { timeout: 300000 }, () => {
  const s = stage('explainer.html');
  const logCsv = path.join(s.root, 'shots3.csv');
  // 默认剧本 17.6s，这里只渲 1s —— 差得远，必须提醒
  const r = run(RENDER, [
    s.html, '--from=0', '--to=1', '--fps=12', '--width=640', '--height=360',
    '--concurrency=2', `--scene-log=${logCsv}`,
  ]);
  const all = r.stdout + r.stderr;
  assert.equal(r.status, 0, '时长不一致是警告不是失败');
  assert.match(all, /镜头表总时长/, '应提示镜头表总时长与渲染时长不一致');
});
