/**
 * 主题用例：--theme 到底有没有改变画面，以及 --out 能不能把一份 HTML 出成多套配色。
 *
 * 这里刻意不只看「日志里出现了 theme: paper」——参数被接受不等于像素变了。
 * 真判据是**同一模板两套配色渲出来的文件不同**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RENDER, run, tmpdir, copyTemplate } from '../scripts/lib/testing.mjs';

function stage(template) {
  const dir = tmpdir('h2v-theme-');
  const html = path.join(dir, template);
  copyTemplate(template, html);
  return { dir, html };
}

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('--theme 换配色会真的改变像素（不只是参数被接受）', { timeout: 300000 }, () => {
  const s = stage('bar-chart.html');
  const outDir = path.join(s.dir, 'out');
  const common = ['--from=0', '--to=0.34', '--fps=6', '--width=640', '--height=360'];

  const dark = run(RENDER, [s.html, ...common, `--out=${path.join(outDir, 'dark.mp4')}`]);
  assert.equal(dark.status, 0, `默认配色应出片\n${dark.stdout}${dark.stderr}`);

  const paper = run(RENDER, [s.html, ...common, '--theme=paper', `--out=${path.join(outDir, 'paper.mp4')}`]);
  assert.equal(paper.status, 0, `paper 配色应出片\n${paper.stdout}${paper.stderr}`);
  assert.match(paper.stdout, /theme: paper/, '日志要写明生效的主题，否则用户无从确认');

  const darkFile = path.join(outDir, 'dark.mp4');
  const paperFile = path.join(outDir, 'paper.mp4');
  assert.ok(fs.existsSync(darkFile) && fs.existsSync(paperFile), '两套配色都该有产物');
  assert.notEqual(sha(darkFile), sha(paperFile),
    '换了主题却渲出一模一样的文件 —— 说明 --theme 根本没传到模板');
});

test('--out 指定成片路径，并自动建出上级目录', { timeout: 300000 }, () => {
  const s = stage('title-card.html');
  const out = path.join(s.dir, 'nested', 'deep', 'custom-name.mp4');

  const r = run(RENDER, [
    s.html, '--from=0', '--to=0.34', '--fps=6', '--width=640', '--height=360', `--out=${out}`,
  ]);
  assert.equal(r.status, 0, `--out 应能出片\n${r.stdout}${r.stderr}`);
  assert.ok(fs.existsSync(out), `成片应落在 --out 指定的位置：${out}`);
  assert.ok(fs.statSync(out).size > 1000, '成片不该是空文件');

  /* 老规矩（同目录同名）不该同时再产一个 —— 否则用户会拿到两个文件，分不清哪个是刚渲的 */
  const dflt = fs.readdirSync(s.dir).filter((n) => n.endsWith('.mp4'));
  assert.deepEqual(dflt, [], `给了 --out 就不该再往 HTML 旁边写：${dflt.join(', ')}`);
});

test('--theme 拼错不静默：照常出片，但明确说清回退到了哪个主题', { timeout: 300000 }, () => {
  const s = stage('title-card.html');
  const out = path.join(s.dir, 'typo.mp4');

  const r = run(RENDER, [
    s.html, '--from=0', '--to=0.34', '--fps=6', '--width=640', '--height=360',
    '--theme=papr', `--out=${out}`,
  ]);
  const all = r.stdout + r.stderr;
  assert.equal(r.status, 0, `主题名拼错不该毁掉整次渲染\n${all}`);
  assert.ok(fs.existsSync(out), '回退到默认主题后仍应出片');
  assert.match(all, /未被识别/, '必须明确告警，不能悄悄用默认色');
  assert.match(all, /midnight/, '要告诉用户实际用的是哪套');
});
