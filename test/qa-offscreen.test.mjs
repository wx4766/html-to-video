/**
 * 回归用例：离屏 canvas 上的文字也要被追到。
 *
 * 起因是 qa.js 的已知盲区 —— 只 hook fillText/strokeText，
 * 文字画进离屏 canvas 再 drawImage 上来就完全看不见（Three.js、图表库都走这条）。
 * 修法是 drawImage 时把源 canvas 记录的文字框做坐标映射。
 *
 * 对照页 test/fixtures/offscreen-text.html 把离屏文字贴到右下角、右半出界：
 *   · 没有映射 → 主画布上只有一个 drawImage，文字框为 0，框景检测必然 0
 *   · 有映射   → 应报出「半截字：离屏文字应该被追上」
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { QA, ROOT, run, tmpdir } from '../scripts/lib/testing.mjs';

test('QA 盲区回归：离屏 canvas 的文字出界能被检出', { timeout: 240000 }, () => {
  const out = tmpdir('h2v-qa-offscreen-');
  const fixture = path.join(ROOT, 'test', 'fixtures', 'offscreen-text.html');

  const r = run(QA, [
    fixture,
    '--duration=1', '--fps=10', '--samples=7',
    '--width=1920', '--height=1080',
    `--out=${out}`,
  ]);
  const all = r.stdout + r.stderr;

  assert.match(all, /框景线索/, '应当报出框景问题，否则说明离屏文字又追不到了');
  assert.match(all, /半截字/, '应当识别为半截字');
  assert.match(all, /离屏文字应该被追上/, '应当报出具体那串文字');
});
