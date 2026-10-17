/**
 * 冒烟用例 ③：正常模板必须 PASS。
 *
 * 与 qa-detects 成对存在 —— 一个证明「坏的一定报」，一个证明「好的不误报」。
 * 缺任何一边，判据都可能被悄悄放宽。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { QA, TEMPLATES, run, tmpdir, readQaRow } from '../scripts/lib/testing.mjs';

test('QA 正常模板：timeline 应通过六维验收', { timeout: 300000 }, () => {
  const out = tmpdir('h2v-qa-clean-');

  const r = run(QA, [
    path.join(TEMPLATES, 'timeline.html'),
    '--duration=4', '--fps=30', '--samples=40',
    '--width=1920', '--height=1080',
    `--out=${out}`,
  ]);
  assert.equal(r.status, 0, `正常模板应通过，实际退出码 ${r.status}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);

  const row = readQaRow(out);
  assert.ok(row, 'qa.md 里应有指标行');
  assert.equal(row.deterministic, '✓', '确定性必须是 ✓（同输入同输出）');
  assert.equal(row.frameIssues, '0', '框景线索应为 0');
  assert.equal(row.pageErrors, '0', '页面报错应为 0');
  assert.equal(row.spikes, '0', '跳变应为 0');
});
