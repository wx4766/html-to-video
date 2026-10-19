/**
 * camera.js 单测：运镜的坑是「抖起来没完」和「NaN 传进 transform」。
 * NaN 一旦进到 translate/scale，画面整帧消失但不报错 —— 是最难查的一类。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CAM = require('../assets/lib/camera.js');

const finite = (o) => Object.values(o).every(v => typeof v === 'number' && Number.isFinite(v));

test('空运镜返回单位变换（不 nan、不 undefined）', () => {
  const tr = CAM.at(null, 1.2, 1920, 1080);
  assert.deepEqual(tr, { dx: 0, dy: 0, scale: 1, rot: 0 });
});

test('kenburns：起止值与插值都要有限', () => {
  const cam = CAM.kenburns({ from: [0.02, -0.01, 1.0], to: [-0.03, 0.02, 1.08], dur: 6 });
  for (const t of [0, 0.5, 1, 3, 6, 7.5, 100]) {
    const tr = CAM.at(cam, t, 1920, 1080);
    assert.ok(finite(tr), `t=${t} 出现非有限值：${JSON.stringify(tr)}`);
  }
  const a = CAM.at(cam, 0, 1920, 1080);
  const b = CAM.at(cam, 6, 1920, 1080);
  assert.ok(Math.abs(a.dx - 0.02 * 1920) < 1e-6, '起点位移应按画面宽度换算');
  assert.ok(Math.abs(b.scale - 1.08) < 1e-6);
});

test('handheld：确定性（同种子同结果）且幅度不超设定', () => {
  const cam = { kind: 'handheld', amp: 6, freq: 1.6, seed: 7 };
  const a = CAM.at(cam, 3.33, 1920, 1080);
  const b = CAM.at(cam, 3.33, 1920, 1080);
  assert.deepEqual(a, b, '抖动必须是确定性的，否则多 worker 会各渲各的');
  assert.notEqual(a.dx, 0, '抖动不该恒为 0');
  for (let t = 0; t < 10; t += 0.07) {
    const tr = CAM.at(cam, t, 1920, 1080);
    assert.ok(Math.abs(tr.dx) <= 6 * 1.001, `位移超出 amp：${tr.dx}`);
    assert.ok(Math.abs(tr.dy) <= 6 * 1.001);
  }
});

test('handheld：换种子得到不同的抖动（否则「种子」就是摆设）', () => {
  const a = CAM.at({ kind: 'handheld', amp: 6, seed: 1 }, 2.0, 1920, 1080);
  const b = CAM.at({ kind: 'handheld', amp: 6, seed: 2 }, 2.0, 1920, 1080);
  assert.notEqual(a.dx, b.dx);
});

test('shake：撞击式震动会衰减到 0（不是一直抖）', () => {
  const cam = { kind: 'shake', amp: 14, t0: 1.0, decay: 5 };
  const early = CAM.at(cam, 1.05, 1920, 1080);
  const late = CAM.at(cam, 4.0, 1920, 1080);
  assert.ok(Math.abs(early.dx) > 1, '刚撞上那一下要有位移');
  assert.ok(Math.abs(late.dx) < 0.05, '衰减之后应该基本静止');
});

test('breath：循环运镜在一个周期后回到起点，不会漂', () => {
  const cam = CAM.breath({ dur: 3.2, loop: 3.2 });
  const a = CAM.at(cam, 0, 1920, 1080);
  const mid = CAM.at(cam, 1.6, 1920, 1080);
  const b = CAM.at(cam, 3.2, 1920, 1080);
  assert.ok(Math.abs(a.scale - b.scale) < 1e-3, `一个周期后应回到同一缩放：${a.scale} vs ${b.scale}`);
  assert.ok(mid.scale > a.scale, '半程应缩到最远端');
  // 默认的呼吸幅度要「看不出来」，1.5% 以内
  assert.ok(Math.abs(mid.scale - a.scale) < 0.015, '默认呼吸幅度不该超过 1.5%');
});

test('stack：多个运镜叠加，scale 相乘、位移相加', () => {
  const st = CAM.stack([
    { kind: 'zoom', from: 1, to: 1.1, dur: 2 },
    { kind: 'pan', from: [0, 0], to: [0.1, 0], dur: 2 },
  ], 1, 1920, 1080);
  assert.ok(finite(st));
  assert.ok(Math.abs(st.scale - 1.05) < 1e-6);
  assert.ok(Math.abs(st.dx - 0.05 * 1920) < 1e-6);
});

test('push/pop 成对：内容画到一半抛错，也必须 restore', () => {
  const calls = [];
  const g = { save: () => calls.push('save'), restore: () => calls.push('restore'),
    translate: () => {}, rotate: () => {}, scale: () => {} };

  CAM.withCam(g, CAM.at(CAM.breath(), 1, 1920, 1080), 1920, 1080, () => { calls.push('draw'); });
  assert.deepEqual(calls, ['save', 'draw', 'restore']);

  assert.throws(
    () => CAM.withCam(g, CAM.at(CAM.breath(), 1, 1920, 1080), 1920, 1080, () => { throw new Error('炸了'); }),
    /炸了/,
    '内容的异常要继续往外抛（不能把画面错误吞掉）'
  );
  assert.equal(
    calls.filter(c => c === 'save').length, calls.filter(c => c === 'restore').length,
    '内容抛错时也必须 restore，否则变换会一直叠加到后面的帧'
  );
});
