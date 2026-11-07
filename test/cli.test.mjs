/**
 * CLI 外壳（bin/h2v.js）与 doctor（scripts/doctor.js）
 *
 * 这一层最容易"看起来没问题"：命令能跑、输出像样，但退出码不对（CI 就不认）、
 * 或者 h2v new 只拷了 HTML 忘了 themes.js（用户第一次出片就 404）。
 * 所以这里全是"能算出来"的断言，不截图、不渲染。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'h2v.js');

const run = (args, opt = {}) => spawnSync(process.execPath, [CLI, ...args], {
  encoding: 'utf8', cwd: opt.cwd || ROOT, env: process.env, timeout: 60000,
});

test('h2v styles 列出全部 12 种风格（含新增四种）', () => {
  const r = run(['styles']);
  assert.equal(r.status, 0, r.stderr);
  for (const id of ['riso', 'ink', 'watercolor', 'pencil', 'vox', 'clay']) {
    assert.match(r.stdout, new RegExp('\\b' + id + '\\b'), `缺风格 ${id}`);
  }
});

test('h2v templates 列出 14 个模板（含新增三个）', () => {
  const r = run(['templates']);
  assert.equal(r.status, 0, r.stderr);
  for (const f of ['quote-card.html', 'chapter-card.html', 'ui-showcase.html']) {
    assert.match(r.stdout, new RegExp(f.replace('.', '\\.')));
  }
});

test('h2v new 会把 themes.js 一起拷过去', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2v-new-'));
  const r = run(['new', 'my-video', '--template=quote-card'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'my-video.html')), '应生成 my-video.html');
  assert.ok(fs.existsSync(path.join(dir, 'themes.js')), '必须带上 themes.js，否则换主题 404');
});

test('h2v new 不覆盖已有文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2v-new2-'));
  fs.writeFileSync(path.join(dir, 'x.html'), '<!-- mine -->');
  const r = run(['new', 'x'], { cwd: dir });
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'x.html'), 'utf8'), '<!-- mine -->');
});

test('未知子命令：非零退出，并把用法打出来', () => {
  const r = run(['rm-rf-everything']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /不认识的命令/);
});

test('doctor --json：结构可解析，且退出码与 ok 一致', () => {
  const r = run(['doctor', '--json']);
  const j = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(typeof j.ok, 'boolean');
  assert.ok(Array.isArray(j.checks) && j.checks.length >= 4, '至少查 Node / Playwright / ffmpeg / 字体');
  assert.ok(j.checks.every((c) => ['ok', 'warn', 'fail'].includes(c.level)));
  assert.equal(r.status === 0, j.ok === true && !j.checks.some((c) => c.level === 'warn'));
});
