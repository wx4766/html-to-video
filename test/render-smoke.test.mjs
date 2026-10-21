/**
 * 冒烟用例 ①：最小出片链路。
 *
 * 要证明三件事：
 *   1. 一条命令能把 HTML 渲成 MP4（渲染器没坏）
 *   2. --width/--height 真的生效 —— 成片分辨率就是请求的那个，不是被裁的 1920×1080
 *   3. 模板已自适应视口，不该触发「画面尺寸和视口对不上」告警
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RENDER, TEMPLATES, run, tmpdir, probeSize, copyTemplate } from '../scripts/lib/testing.mjs';

test('最小出片：1280×720 渲 1 秒 6 帧', { timeout: 300000 }, () => {
  const dir = tmpdir();
  const html = path.join(dir, 'title-card.html');
  copyTemplate('title-card.html', html);

  const r = run(RENDER, [
    html, '--from=0', '--to=1', '--fps=6', '--width=1280', '--height=720',
  ]);
  const all = r.stdout + r.stderr;
  assert.equal(r.status, 0, `渲染应成功，实际退出码 ${r.status}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);

  const mp4 = path.join(dir, 'title-card.0-1s.mp4');
  assert.ok(fs.existsSync(mp4), '应产出 title-card.0-1s.mp4（片段名带起止秒，不覆盖成品）');
  assert.ok(fs.statSync(mp4).size > 20000, `成片不该是空文件，实际 ${fs.statSync(mp4).size} B`);

  assert.deepEqual(probeSize(mp4), { w: 1280, h: 720 }, '成片分辨率应与 --width/--height 一致');
  assert.ok(!/画面尺寸和视口对不上/.test(all), '模板已自适应视口，不该触发尺寸告警');
});

test('竖屏出片：1080×1920 不裁切', { timeout: 300000 }, () => {
  const dir = tmpdir();
  const html = path.join(dir, 'vertical-card.html');
  copyTemplate('vertical-card.html', html);

  const r = run(RENDER, [
    html, '--from=0', '--to=1', '--fps=6', '--width=1080', '--height=1920',
  ]);
  assert.equal(r.status, 0, `竖屏渲染应成功\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);

  const mp4 = path.join(dir, 'vertical-card.0-1s.mp4');
  assert.ok(fs.existsSync(mp4), '应产出竖屏成片');
  assert.deepEqual(probeSize(mp4), { w: 1080, h: 1920 }, '竖屏成片尺寸应为 1080×1920');
  assert.ok(!/画面尺寸和视口对不上/.test(r.stdout + r.stderr), '竖屏模板不该触发尺寸告警');
});
