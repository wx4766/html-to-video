/**
 * 冒烟用例 ⑤：DOM 文字的分块粒度（真开浏览器）。
 *
 * 背景：DOM 文字的框明明和 canvas 无关，却最容易误报。
 *   · 按「行框」推 → 同一行上的 <span> 和裸文字成了两块，互相判「叠字」
 *   · 按「文本节点」取并集 → 多行段落的并集框把行内 span 整个包住，也判「叠字」
 * 两种都实测过，都会 100% 误报。现在改成「一行一块」。
 *
 * 这个 fixture 里放三块文字，用来把判据钉死在中间：
 *   ① 出界标题  —— 必须报（证明 DOM 文字没被整体忽略，测试是有牙的）
 *   ② 多行段落 + 行内 span —— 不许报叠字
 *   ③ 同一行的 span + 裸文字 —— 不许被拆成两块互判叠字
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { QA, ROOT, run, tmpdir, readQaRow } from '../scripts/lib/testing.mjs';

test('QA 对照：DOM 文字按行分块，不误报多行段落', { timeout: 300000 }, () => {
  const out = tmpdir('h2v-qa-dom-');
  const fixture = path.join(ROOT, 'test', 'fixtures', 'dom-text.html');

  const r = run(QA, [
    fixture,
    '--duration=2', '--fps=10', '--samples=12',
    '--width=1920', '--height=1080',
    `--out=${out}`,
  ]);
  const all = r.stdout + r.stderr;

  assert.equal(r.status, 0, `没有页面报错，应正常结束\n${all}`);
  assert.ok(fs.existsSync(path.join(out, 'qa.md')), '应生成 qa.md');

  const md = fs.readFileSync(path.join(out, 'qa.md'), 'utf8');

  /* ① 有牙：真的出界的 DOM 文字必须被追上（否则「不误报」可以靠不检查来作弊） */
  assert.match(md, /半截字[\s\S]{0,40}右侧出界的标题字幕/, '出界的 DOM 文字必须被报出来');

  /* ②③ 不误报：多行段落 / 行内 span 不该被判叠字 */
  assert.doesNotMatch(md, /叠字/, `多行段落不该被判叠字：\n${md}`);
  assert.doesNotMatch(md, /进字幕带/, `这三块文字都在安全区内：\n${md}`);

  const row = readQaRow(out);
  assert.ok(row, 'qa.md 里应有指标行');
  assert.equal(row.frameIssues, '1', `框景线索应只有「半截字」这一条，实际 ${row.frameIssues} 条`);
  assert.equal(row.pageErrors, '0');
});
