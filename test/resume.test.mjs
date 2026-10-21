/**
 * 断点续渲：--resume 的三条底线。
 *
 * 这个功能最怕「看起来在续、其实是拼」—— 拼出来的片子和全量渲染差一点点，
 * 却没人会发现。所以三个用例分别盯：
 *   1. 缺帧能补齐，且补出来的帧与原帧**逐字节一致**（不是"差不多"）
 *   2. 参数变了必须拒绝 —— fps 从 10 改 12 还续渲，会拼出前抖后不抖的片子
 *   3. 帧全在时不做重复劳动，直接编码
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RENDER, TEMPLATES, run, tmpdir, copyTemplate } from '../scripts/lib/testing.mjs';

const FRAMES = 5; // 0.5s @ 10fps
const BASE_ARGS = ['--from=0', '--to=0.5', '--fps=10', '--width=640', '--height=360'];

function setup() {
  const dir = tmpdir('h2v-resume-');
  const html = path.join(dir, 'title-card.html');
  copyTemplate('title-card.html', html);
  return { dir, html, tmp: path.join(dir, '.seek-tmp-resume') };
}

const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
const framePath = (tmp, i) => path.join(tmp, `frame-${String(i).padStart(6, '0')}.png`);

test('续渲：删掉的帧补回来，且与原帧逐字节一致', { timeout: 300000 }, () => {
  const { html, dir, tmp } = setup();

  // 先完整渲一遍，留作基准
  const first = run(RENDER, [html, ...BASE_ARGS, '--resume', '--keep-frames']);
  assert.equal(first.status, 0, `首次渲染应成功\n${first.stdout}\n${first.stderr}`);
  assert.equal(fs.readdirSync(tmp).filter((f) => f.endsWith('.png')).length, FRAMES, '首次应产出 5 帧');

  const baseline = new Map();
  for (let i = 0; i < FRAMES; i++) baseline.set(i, md5(framePath(tmp, i)));

  // 挖两个洞：一个中间、一个末尾（末尾决定 -start_number 会不会提前收尾）
  for (const i of [2, 4]) fs.rmSync(framePath(tmp, i));

  const second = run(RENDER, [html, ...BASE_ARGS, '--resume', '--keep-frames']);
  const out = second.stdout + second.stderr;
  assert.equal(second.status, 0, `续渲应成功\n${out}`);
  assert.match(out, /已复用 3 帧，还需渲 2 帧/, `应只补渲缺的 2 帧\n${out}`);

  for (let i = 0; i < FRAMES; i++) {
    assert.equal(md5(framePath(tmp, i)), baseline.get(i), `frame-${i} 与基准不一致 —— 续渲不该改变已有帧的重绘结果`);
  }
  assert.ok(fs.existsSync(path.join(dir, 'title-card.0-0.5s.mp4')), '续渲后应产出成片');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('续渲：参数和上次不一致时必须拒绝', { timeout: 300000 }, () => {
  const { html, dir } = setup();
  // --keep-frames 是为了模拟「上次被打断、目录还在」的现场：正常渲染成功会清掉临时目录，
  // 那时 job.json 一并消失，本来就没有可比对的参数（也就不该拒绝）。
  const first = run(RENDER, [html, ...BASE_ARGS, '--resume', '--keep-frames']);
  assert.equal(first.status, 0, `首次渲染应成功\n${first.stdout}\n${first.stderr}`);

  // 同样的 HTML 和尺寸，只把 fps 改掉 —— 混着编码会让片子前后节奏不一致
  const bad = run(RENDER, [html, '--from=0', '--to=0.5', '--fps=12', '--width=640', '--height=360', '--resume']);
  const out = bad.stdout + bad.stderr;
  assert.notEqual(bad.status, 0, `参数不一致应非零退出\n${out}`);
  assert.match(out, /上次：/, `报错要给出上次的参数\n${out}`);
  assert.match(out, /这次：/, `报错要给出这次的参数\n${out}`);
  assert.match(out, /\.seek-tmp-resume/, `报错要指出该删哪个目录\n${out}`);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('续渲：帧全在时跳过截图，不做重复劳动', { timeout: 300000 }, () => {
  const { html, dir } = setup();
  const first = run(RENDER, [html, ...BASE_ARGS, '--resume', '--keep-frames']);
  assert.equal(first.status, 0, `首次渲染应成功\n${first.stdout}\n${first.stderr}`);

  const again = run(RENDER, [html, ...BASE_ARGS, '--resume', '--keep-frames']);
  const out = again.stdout + again.stderr;
  assert.equal(again.status, 0, `帧齐时重跑应成功\n${out}`);
  assert.match(out, /全在，跳过截图/, `帧齐时不该重截\n${out}`);
  assert.ok(!/Capturing \d+ frames across/.test(out), `帧齐时不该开 worker 截图\n${out}`);

  fs.rmSync(dir, { recursive: true, force: true });
});
