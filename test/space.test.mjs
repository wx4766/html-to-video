/**
 * space.js 单测。
 *
 * 投影是「错了也出画面」的那类代码 —— 基向量反了，画面照画，
 * 只是左右颠倒、上下颠倒，肉眼要盯很久才发现。
 * 所以这里所有断言都是**方向性**的：+x 必须在右，+y 必须在下。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SP = require('../assets/lib/space.js');

const CAM = () => SP.cam({ pos: [0, 0, -900], look: [0, 0, 0], fov: 45, w: 1920, h: 1080 });

test('原点投到画布中心，深度等于机距', () => {
  const c = CAM();
  const p = SP.project(c, [0, 0, 0]);
  assert.ok(Math.abs(p.x - 960) < 0.01);
  assert.ok(Math.abs(p.y - 540) < 0.01);
  assert.ok(Math.abs(p.z - 900) < 0.01);
  assert.ok(p.vis);
});

test('焦距 = (h/2)/tan(fov/2)，缩放比与它一致', () => {
  const c = CAM();
  const foc = (1080 / 2) / Math.tan((45 * Math.PI / 180) / 2);
  assert.ok(Math.abs(c._foc - foc) < 1e-6);
  const p = SP.project(c, [0, 0, 0]);
  assert.ok(Math.abs(p.s - foc / 900) < 1e-6);
});

test('方向：+x 在右，+y 在下（y 轴向下，别搞反）', () => {
  const c = CAM();
  assert.ok(SP.project(c, [100, 0, 0]).x > 960, '+x 应该在右边');
  assert.ok(SP.project(c, [-100, 0, 0]).x < 960, '-x 应该在左边');
  assert.ok(SP.project(c, [0, 100, 0]).y > 540, '+y 应该在下方');
  assert.ok(SP.project(c, [0, -100, 0]).y < 540, '-y 应该在上方');
});

test('投影随距离衰减：越远越小、越靠中心', () => {
  const c = CAM();
  const near = SP.project(c, [200, 0, 300]);
  const far = SP.project(c, [200, 0, 3000]);
  assert.ok(far.s < near.s);
  assert.ok(Math.abs(far.x - 960) < Math.abs(near.x - 960), '远处的点应该更靠中间');
});

test('近裁剪面之后不投影（vis=false）', () => {
  const c = CAM();
  assert.equal(SP.project(c, [0, 0, -5000]).vis, false);
  assert.equal(SP.project(c, [0, 0, -901]).vis, false);
});

test('俯仰：相机抬头时，地平线以下的内容上移', () => {
  const level = SP.cam({ pos: [0, -300, -900], look: [0, -300, 0], fov: 45, w: 1920, h: 1080 });
  const up = SP.cam({ pos: [0, -300, -900], look: [0, -700, 0], fov: 45, w: 1920, h: 1080 });
  const p1 = SP.project(level, [0, 0, 1000]);
  const p2 = SP.project(up, [0, 0, 1000]);
  assert.ok(p2.y > p1.y, '抬头后地面点应该往画面下方走');
});

test('深度排序：远的在前（先画）', () => {
  const c = CAM();
  const items = [{ p: [0, 0, 0], id: 'a' }, { p: [0, 0, 2400], id: 'far' }, { p: [0, 0, 900], id: 'mid' }];
  const order = SP.sort(c, items).map((o) => o.it.id);
  assert.deepEqual(order, ['far', 'mid', 'a']);
});

test('雾：near 之前 0、far 之后封顶，中间单调', () => {
  const c = CAM();
  assert.equal(SP.fog(c, 100), 0);
  assert.ok(Math.abs(SP.fog(c, 9000) - 0.82) < 1e-9);
  let last = -1;
  for (const z of [1200, 1800, 2400, 3000, 3600, 4200]) {
    const v = SP.fog(c, z);
    assert.ok(v >= last, '雾必须单调不减');
    last = v;
  }
});

test('lerpCam：中点位置在两个机位正中，fov 也插值', () => {
  const a = SP.cam({ pos: [0, 0, -1000], look: [0, 0, 0], fov: 50, w: 1920, h: 1080 });
  const b = SP.cam({ pos: [0, 0, 1000], look: [0, 0, 2000], fov: 30, w: 1920, h: 1080 });
  const m = SP.lerpCam(a, b, 0.5);
  assert.equal(m.pos[2], 0);
  assert.equal(m.look[2], 1000);
  assert.equal(m.fov, 40);
  assert.ok(Number.isFinite(m._foc));
});

test('track：端点原样返回，中间单调推进', () => {
  const a = SP.cam({ pos: [0, 0, -1000], look: [0, 0, 0], fov: 50, w: 1920, h: 1080 });
  const b = SP.cam({ pos: [0, 0, 500], look: [0, 0, 1500], fov: 35, w: 1920, h: 1080 });
  const keys = [[0, a], [4, b]];
  assert.equal(SP.track(keys, -1).pos[2], -1000);
  assert.equal(SP.track(keys, 9).pos[2], 500);
  let last = -Infinity;
  for (let t = 0; t <= 4; t += 0.25) {
    const z = SP.track(keys, t).pos[2];
    assert.ok(z >= last - 1e-9, '机位必须单调推进');
    last = z;
  }
});

test('roll 生效：滚转后点的屏幕位置改变', () => {
  const a = CAM();
  const b = SP.cam({ pos: [0, 0, -900], look: [0, 0, 0], fov: 45, roll: Math.PI / 4, w: 1920, h: 1080 });
  const p1 = SP.project(a, [200, 0, 0]);
  const p2 = SP.project(b, [200, 0, 0]);
  assert.ok(Math.abs(p1.y - p2.y) > 10, 'roll 没起作用');
  assert.ok(Math.abs(p1.x - p2.x) > 10, 'roll 没起作用');
});

test('正上/正下看不会退化出 NaN', () => {
  for (const pos of [[0, -1200, 0], [0, 1200, 0]]) {
    const c = SP.cam({ pos, look: [0, 0, 0], fov: 45, w: 1920, h: 1080 });
    const p = SP.project(c, [0, 0, 0]);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${pos} 出 NaN`);
  }
});

test('布局辅助：ring / grid / helix 数量与分布正确', () => {
  const r = SP.ring(8, 100, 0, 0);
  assert.equal(r.length, 8);
  for (const [x, y, z] of r) {
    assert.ok(Math.abs(y) < 1e-9);
    assert.ok(Math.abs(Math.hypot(x, z) - 100) < 1e-6, '半径不对');
  }
  assert.equal(SP.grid(4, 3, 100, 100, 0).length, 12);
  const h = SP.helix(10, 50, 20, 2, 0);
  assert.equal(h.length, 10);
  assert.ok(h[9][1] > h[0][1], '螺旋应该上升');
});

test('draw：回调拿到投影后的 x/y/s，且远的先画', () => {
  const c = CAM();
  const seen = [];
  const items = [
    { p: [0, 0, 0], draw: (g, q) => seen.push(['near', q]) },
    { p: [0, 0, 2000], draw: (g, q) => seen.push(['far', q]) },
  ];
  const g = { save() {}, restore() {}, translate() {}, globalAlpha: 1, filter: 'none' };
  SP.draw(g, c, items);
  assert.equal(seen[0][0], 'far');
  assert.equal(seen[1][0], 'near');
  assert.ok(seen[1][1].s > seen[0][1].s, '近的缩放比应该更大');
});
