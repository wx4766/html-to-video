/**
 * lens.js 单测。
 *
 * 镜头代码的错误同样是「错了也能播」：推镜变成倒放、环绕变成穿模，
 * 只有盯着看十秒才发现。这里用几何不变量来锁死行为：
 * 距离必须等于参数、轨迹必须绕主体、推镜中点必须是几何平均。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LN = require('../assets/lib/lens.js');

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test('缓动：所有曲线端点必须是 0 和 1', () => {
  for (const [name, fn] of Object.entries(LN.EASE)) {
    assert.ok(Math.abs(fn(0)) < 1e-9, name + '(0)=' + fn(0));
    assert.ok(Math.abs(fn(1) - 1) < 1e-9, name + '(1)=' + fn(1));
  }
});

test('缓动：outCubic 起步快于线性（前 20% 走完 48%）', () => {
  assert.ok(LN.EASE.outCubic(0.2) > 0.45);
  assert.ok(LN.EASE.inExpo(0.2) < 0.1);
});

test('distFor：景别越紧机位越近，主体越大机位越远', () => {
  const wide = LN.distFor(100, 'wide');
  const close = LN.distFor(100, 'close');
  assert.ok(close < wide, '特写应该更近：close=' + close.toFixed(0) + ' wide=' + wide.toFixed(0));
  assert.ok(LN.distFor(200, 'close') > LN.distFor(100, 'close'));
  /* 显式 fill 覆盖：占画面越大越近 */
  assert.ok(LN.distFor(100, 'wide', 0.9) < LN.distFor(100, 'wide', 0.2));
});

test('orbitCam：机位到主体的距离等于 dist', () => {
  const t = [10, -100, 30];
  for (const d of [120, 500, 2000]) {
    const cam = LN.orbitCam(t, { az: 0.7, el: 0.2, dist: d, fov: 40, w: 800, h: 600 });
    assert.ok(Math.abs(dist(cam.pos, t) - d) < 1e-6, 'dist=' + d);
  }
});

test('orbitCam：el 为正时相机在主体上方（y 更小）', () => {
  const t = [0, 0, 0];
  const up = LN.orbitCam(t, { az: 0, el: 0.4, dist: 500 });
  const down = LN.orbitCam(t, { az: 0, el: -0.4, dist: 500 });
  assert.ok(up.pos[1] < -100);
  assert.ok(down.pos[1] > 100);
});

test('orbitTrack：中间时刻的方位角落在两端之间', () => {
  const t = [0, 0, 0];
  const keys = [[0, { az: 0, el: 0.1, dist: 900, fov: 40 }], [4, { az: 2, el: 0.1, dist: 900, fov: 40 }]];
  const mid = LN.orbitTrack(keys, t, 2, LN.EASE.linear);
  /* 反解方位角：pos 相对 target 的 atan2 位置 */
  const az = Math.atan2(mid.pos[0] - t[0], -(mid.pos[2] - t[2]));
  assert.ok(Math.abs(az - 1) < 0.02, 'az=' + az.toFixed(3));
});

test('orbitTrack：插值过程距离恒定（不穿模）', () => {
  const t = [0, -200, 0];
  const keys = [[0, { az: 0, el: 0.1, dist: 600, fov: 40 }], [5, { az: 3.0, el: -0.2, dist: 600, fov: 30 }]];
  for (let s = 0; s <= 5; s += 0.5) {
    const cam = LN.orbitTrack(keys, t, s);
    assert.ok(Math.abs(dist(cam.pos, t) - 600) < 1e-6, 't=' + s);
  }
});

test('push：中点距离是几何平均（对数插值）', () => {
  const t = [0, 0, 0];
  const cam = LN.push(t, { from: 100, to: 1600, u: 0.5, ease: LN.EASE.linear });
  assert.ok(Math.abs(dist(cam.pos, t) - 400) < 1e-6, 'sqrt(100*1600)=400，实际 ' + dist(cam.pos, t));
});

test('push：u=0 与 u=1 精确落在起点/终点', () => {
  const t = [0, 0, 0];
  assert.ok(Math.abs(dist(LN.push(t, { from: 250, to: 2000, u: 0 }).pos, t) - 250) < 1e-4);
  assert.ok(Math.abs(dist(LN.push(t, { from: 250, to: 2000, u: 1 }).pos, t) - 2000) < 1e-4);
});

test('handheld：位移幅度在设定值附近，且不会跳变', () => {
  const amps = [];
  for (let t = 0; t < 10; t += 0.05) {
    const h = LN.handheld(t, { amp: 1, speed: 1, seed: 3 });
    amps.push(Math.hypot(h.dx, h.dy));
  }
  assert.ok(Math.max(...amps) < 2.2, '最大 ' + Math.max(...amps));
  /* 呼吸可以瞬间接近零（两个正弦抵消），但不能长期躺零 */
  const avg = amps.reduce((a, b) => a + b, 0) / amps.length;
  assert.ok(avg > 0.4, '平均幅度 ' + avg.toFixed(2));
  /* 相邻帧差不应超过整体的 10%（否则是抖动不是呼吸） */
  let maxJump = 0;
  for (let i = 1; i < amps.length; i++) maxJump = Math.max(maxJump, Math.abs(amps[i] - amps[i - 1]));
  assert.ok(maxJump < 0.35, '最大帧间跳变 ' + maxJump.toFixed(3));
});

test('cut：按 t0 选中正确的镜头', () => {
  const shots = [{ t0: 0, cam: 1 }, { t0: 5, cam: 2 }, { t0: 9, cam: 3 }];
  assert.equal(LN.cut(shots, 0).cam, 1);
  assert.equal(LN.cut(shots, 4.99).cam, 1);
  assert.equal(LN.cut(shots, 5).cam, 2);
  assert.equal(LN.cut(shots, 100).cam, 3);
});

test('at：镜内进度按下一镜起点归一', () => {
  const shots = [{ t0: 0, cam: 1 }, { t0: 4, cam: 2 }];
  assert.ok(Math.abs(LN.at(shots, 2).u - 0.5) < 1e-9);
  assert.ok(Math.abs(LN.at(shots, 4).u) < 1e-9);
});
