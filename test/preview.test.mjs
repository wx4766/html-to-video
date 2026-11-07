/**
 * preview.js：预览服务器能起来、能出外壳页、能清理临时副本
 *
 * 这条用例挡的是"看起来能用其实不能用"：
 *   · 外壳页 200 但 iframe src 指错（相对路径少一层）→ 用户看到白屏
 *   · 注入 __seekRender 的临时副本没删 → 用户目录里留下一堆 .h2v-preview-*
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'assets', 'templates', 'title-card.html');

test('preview 起服务 → 外壳页可访问 → 退出时清理临时文件', { timeout: 60000 }, async () => {
  const dir = path.dirname(TARGET);
  const before = new Set(fs.readdirSync(dir).filter((f) => f.startsWith('.h2v-preview-')));

  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'preview.js'), TARGET, '--duration=3'], {
    cwd: ROOT, env: process.env,
  });

  const url = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('等不到预览 URL：' + buf)), 20000);
    child.stdout.on('data', (d) => {
      buf += String(d);
      const m = /http:\/\/127\.0\.0\.1:\d+\/\S+/.exec(buf);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    });
    child.stderr.on('data', (d) => { buf += String(d); });
    child.on('exit', (c) => { if (c) { clearTimeout(timer); reject(new Error('进程提前退出：' + buf)); } });
  });

  const res = await fetch(url);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<iframe/, '外壳页里应有 iframe');
  assert.match(html, /__seek/, '外壳页应通过 __seek 推帧');

  /* iframe 指向的是注入过 __seekRender 的副本，不是原文件 */
  const m = /<iframe[^>]+src="([^"]+)"/.exec(html);
  assert.ok(m, '应能解析出 iframe src');
  const inner = await (await fetch(m[1])).text();
  assert.match(inner, /__seekRender/, '副本必须注入 __seekRender，否则页面自播会和时间轴打架');

  child.kill('SIGTERM');
  await new Promise((r) => child.on('exit', r));

  const after = fs.readdirSync(dir).filter((f) => f.startsWith('.h2v-preview-'));
  const leaked = after.filter((f) => !before.has(f));
  assert.deepEqual(leaked, [], `临时副本没清理：${leaked.join(', ')}`);
});
