/**
 * 冒烟用例 ②：对照组必须 FAIL。
 *
 * 质量门最大的风险是「永远 PASS」—— 一个只会说没问题的检测器等于没有。
 * 这里拿一个故意注入六类缺陷的页面喂给 qa.js，要求它真的叫出来。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { QA, ROOT, run, tmpdir } from '../scripts/lib/testing.mjs';

test('QA 对照组：六类缺陷的动画必须判失败并报出问题', { timeout: 300000 }, () => {
  const out = tmpdir('h2v-qa-broken-');
  const fixture = path.join(ROOT, 'test', 'fixtures', 'broken.html');

  const r = run(QA, [
    fixture,
    '--duration=6', '--fps=30', '--samples=60',
    '--width=1920', '--height=1080',
    `--out=${out}`,
  ]);
  const all = r.stdout + r.stderr;

  assert.notEqual(r.status, 0, `对照组必须非零退出（页面有注入的 console.error）\n${all}`);
  assert.match(all, /框景线索/, '应报出框景类问题（半截字 / 叠字 / 进字幕带）');
  assert.match(all, /不确定/, '应报出不确定性（画面里有 Math.random）');

  assert.ok(fs.existsSync(path.join(out, 'qa.md')), '失败也要留下报告，方便定位');
  const md = fs.readFileSync(path.join(out, 'qa.md'), 'utf8');
  assert.match(md, /半截字|叠字|字幕带/, '报告里应写明具体是哪种框景问题');
});
