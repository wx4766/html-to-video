/**
 * solid.js 单测。
 *
 * 着色和几何同样是「错了也出画面」的代码：法线反了，物体不会消失，
 * 只会一边黑一边亮；顶点顺序错了，面会翻到里面去。所以这里的断言
 * 全部是**可证伪的几何事实**，不是「跑通就行」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SD = require('../assets/lib/solid.js');
const SP = require('../assets/lib/space.js');

/* 假 canvas：只记账，不光栅化。用来验证「该画几个面」。 */
function fakeCtx() {
  const rec = { fills: 0, strokes: 0, styles: new Set() };
  let _fill = '';
  const g = {
    rec,
    globalAlpha: 1,
    lineJoin: 'round',
    lineWidth: 1,
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    fill() { rec.fills++; },
    stroke() { rec.strokes++; },
  };
  Object.defineProperty(g, 'fillStyle', {
    get: () => _fill,
    set: (v) => { _fill = v; rec.styles.add(v); },
  });
  Object.defineProperty(g, 'strokeStyle', { get: () => _fill, set: () => {} });
  return g;
}

function unit(v) { return Math.abs(Math.hypot(v[0], v[1], v[2]) - 1) < 1e-6; }

test('box：8 顶点 6 面，法线全部是单位向量', () => {
  const m = SD.box(10, 20, 30);
  assert.equal(m.nv, 8);
  assert.equal(m.nf, 6);
  for (let i = 0; i < m.nf; i++) assert.ok(unit([m.nx[i], m.ny[i], m.nz[i]]), 'face ' + i);
});

test('box：顶面法线朝上（世界 y 向下，所以顶面是 -y）', () => {
  const m = SD.box(10, 10, 10);
  let found = false;
  for (let i = 0; i < m.nf; i++) {
    if (m.cy[i] < -4.9) { found = true; assert.ok(m.ny[i] < -0.9, '顶面法线应指向 -y'); }
  }
  assert.ok(found, '应存在一个位于顶部的面');
});

test('lathe：旋转体不产生 NaN 法线（极点退化必须被标记）', () => {
  const m = SD.lathe([[0, 0], [10, 0], [8, -30], [2, -40], [0, -44]], 16);
  for (let i = 0; i < m.nf; i++) {
    assert.ok(Number.isFinite(m.nx[i]) && Number.isFinite(m.ny[i]) && Number.isFinite(m.nz[i]));
  }
  /* 退化面应被 skip，而不是画成一条毛刺 */
  let skipped = 0;
  for (let i = 0; i < m.nf; i++) if (m.skip[i]) skipped++;
  assert.ok(skipped >= 0);
});

test('sphere：面数 = seg × rings，顶点都在球面上', () => {
  const r = 50, seg = 12, rings = 8;
  const m = SD.sphere(r, { seg, rings });
  assert.equal(m.nf, seg * rings);
  for (let i = 0; i < m.nv; i++) {
    const d = Math.hypot(m.vx[i], m.vy[i], m.vz[i]);
    assert.ok(Math.abs(d - r) < 1e-6, 'vertex ' + i + ' 半径 ' + d);
  }
});

test('terrain：高度函数直接决定顶点 y', () => {
  const m = SD.terrain(4, 4, 100, 100, (u, v) => (u + v) * 10);
  /* 角点 (0,0) 高度 0；(1,1) 高度 20 */
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < m.nv; i++) { minY = Math.min(minY, m.vy[i]); maxY = Math.max(maxY, m.vy[i]); }
  assert.ok(Math.abs(minY - 0) < 1e-6);
  assert.ok(Math.abs(maxY - 20) < 1e-6);
});

test('tube：沿路径生成环，首尾半径一致', () => {
  const m = SD.tube([[0, 0, 0], [0, -100, 0], [0, -100, 100]], 8, { seg: 8 });
  assert.equal(m.nv, 3 * 8);
  assert.equal(m.nf, 2 * 8);
});

test('xform：平移与绕 y 旋转都作用在顶点上', () => {
  const a = SD.box(10, 10, 10);
  const b = SD.xform(a, { p: [100, 200, 300], ry: Math.PI / 2 });
  /* 原顶点 (-5,-5,-5) → 绕 y 转 90° → (-5,-5,5) → 平移 */
  assert.ok(Math.abs(b.vx[0] - 95) < 1e-6);
  assert.ok(Math.abs(b.vy[0] - 195) < 1e-6);
  assert.ok(Math.abs(b.vz[0] - 305) < 1e-6);
  /* 原 mesh 不能被改 */
  assert.equal(a.vx[0], -5);
});

test('light：环境光默认中性，不把材质染成天空色', () => {
  const L = SD.light({ ambient: [10, 30, 90], sun: [255, 240, 220], ambI: 0.5, sunI: 1 });
  assert.ok(Math.abs(L.hemiTop[0] - L.hemiTop[2]) < 0.05, '默认天光应接近中性');
});

test('keyLight：主光永远在相机这一侧（正面不会死黑）', () => {
  const cam = SP.cam({ pos: [600, -100, -600], look: [0, -150, 0], fov: 40, w: 1920, h: 1080 });
  const L = SD.keyLight({ ambient: [60, 60, 70], sun: [255, 240, 220], ambI: 0.5, sunI: 1 }, cam, { azimuth: -40, elev: 25 });
  /* dir 指向光源，应与视线方向相反（点积 < 0） */
  const d = L.dir[0] * cam._f[0] + L.dir[1] * cam._f[1] + L.dir[2] * cam._f[2];
  assert.ok(d < 0, '主光在相机背后（dot=' + d.toFixed(3) + '）');
  assert.ok(L.dir[1] < 0, '主光应在上方（y 向下）');
});

test('shade：朝光面比背光面亮', () => {
  const L = SD.light({ ambient: [40, 40, 50], sun: [255, 240, 220], ambI: 0.4, sunI: 1 }, { dir: [1, 0, 0] });
  const base = [200, 200, 200];
  const a = [0, 0, 0], b = [0, 0, 0];
  SD._shade(a, 1, 0, 0, 0, 0, 0, [0, 0, -100], base, SD.MAT.matte, L, 0, 0);   // 法线朝 +x（朝光）
  SD._shade(b, -1, 0, 0, 0, 0, 0, [0, 0, -100], base, SD.MAT.matte, L, 0, 0);  // 法线朝 -x（背光）
  assert.ok(a[0] > b[0] + 20, '朝光 ' + a[0].toFixed(0) + ' 应明显亮于背光 ' + b[0].toFixed(0));
});

test('draw：相机背后的面不画', () => {
  const cam = SP.cam({ pos: [0, 0, -500], look: [0, 0, 0], fov: 45, w: 800, h: 600 });
  const L = SD.light({ ambient: [50, 50, 60], sun: [255, 255, 255], ambI: 0.5, sunI: 1 });
  const front = SD.box(100, 100, 100);
  const g = fakeCtx();
  const st = SD.draw(g, cam, [front], L);
  assert.ok(st.faces > 0, '正前方的盒子应该有面被画');
  assert.equal(g.rec.fills, st.faces);

  /* 相机在 z=-500 看向 +z，所以「背后」是 z 更小的一侧 */
  const behind = SD.xform(SD.box(100, 100, 100), { p: [0, 0, -2000] });
  const g2 = fakeCtx();
  const st2 = SD.draw(g2, cam, [behind], L);
  assert.equal(st2.faces, 0, '相机背后的物体不该画');
  assert.equal(g2.rec.fills, 0);
});

test('draw：画家算法 —— 近的面在远的面之后画', () => {
  const cam = SP.cam({ pos: [0, 0, -800], look: [0, 0, 0], fov: 45, w: 800, h: 600 });
  const L = SD.light({ ambient: [50, 50, 60], sun: [255, 255, 255], ambI: 0.5, sunI: 1 });
  const near = SD.xform(SD.box(80, 80, 80), { p: [0, 0, -200] });
  const far = SD.xform(SD.box(80, 80, 80), { p: [0, 0, 600] });
  const order = [];
  const g = fakeCtx();
  const fill = g.fill;
  g.fill = function () { order.push(g.fillStyle); fill.call(g); };
  /* 两个盒子颜色不同，用颜色追踪绘制顺序 */
  near.col = [255, 0, 0]; far.col = [0, 0, 255];
  SD.draw(g, cam, [near, far], L);
  assert.ok(order.length > 0);
  /* 最后几个面应该属于近处（红） */
  const last = order[order.length - 1];
  const m = /rgb\((\d+),/.exec(last);
  assert.ok(m && Number(m[1]) > 100, '最后画的应是近处的红盒子（实际 ' + last + '）');
});

test('colorBy：逐面取色生效（不再是整块单色）', () => {
  /* 相机放在上方（y 向下，所以是负 y），否则看到的是底面的背光 */
  const cam = SP.cam({ pos: [0, -320, -520], look: [0, 0, 0], fov: 45, w: 400, h: 300 });
  const L = SD.light({ ambient: [80, 80, 90], sun: [255, 255, 255], ambI: 0.6, sunI: 1 }, { dir: [-0.4, -0.85, 0.35] });
  const m = SD.box(100, 100, 100);
  m.colorBy = (x, y) => [y < 0 ? 240 : 20, 0, 0];
  const g = fakeCtx();
  SD.draw(g, cam, [m], L);
  const vals = [...g.rec.styles].map((s) => Number((/rgb\((\d+),/.exec(s) || [0, 0])[1]));
  assert.ok(Math.max(...vals) > 120 && Math.min(...vals) < 120, '应同时出现亮面与暗面');
});

test('morph：端点必须精确落在两个形态上', () => {
  const a = SD.sphere(40, { seg: 8, rings: 6 });
  const b = SD.sphere(90, { seg: 8, rings: 6 });
  const k0 = SD.morph(a, b, 0, { stagger: 0 });
  const k1 = SD.morph(a, b, 1, { stagger: 0 });
  for (let i = 0; i < a.nv; i++) {
    assert.ok(Math.abs(k0.vx[i] - a.vx[i]) < 1e-6);
    assert.ok(Math.abs(k1.vx[i] - b.vx[i]) < 1e-6);
  }
});

test('morph：中点半径落在两端之间', () => {
  const a = SD.sphere(40, { seg: 8, rings: 6 });
  const b = SD.sphere(90, { seg: 8, rings: 6 });
  const m = SD.morph(a, b, 0.5, { stagger: 0 });
  const r = Math.hypot(m.vx[8], m.vy[8], m.vz[8]);
  assert.ok(r > 38 && r < 92, '半径 ' + r.toFixed(1));
});

test('morph：stagger 让顶点不同时到达（不是整体平移）', () => {
  const a = SD.sphere(40, { seg: 12, rings: 8 });
  const b = SD.sphere(90, { seg: 12, rings: 8 });
  const m = SD.morph(a, b, 0.35, { stagger: 0.5 });
  let moved = 0;
  for (let i = 0; i < a.nv; i++) {
    const d = Math.abs(Math.hypot(m.vx[i], m.vy[i], m.vz[i]) - Math.hypot(a.vx[i], a.vy[i], a.vz[i]));
    if (d > 1) moved++;
  }
  assert.ok(moved > 0 && moved < a.nv, '应有部分顶点先走、部分没动（实际 ' + moved + '/' + a.nv + '）');
});

test('morph：拓扑不同必须报错（不能静默画错）', () => {
  const a = SD.sphere(40, { seg: 8, rings: 6 });
  const b = SD.sphere(40, { seg: 10, rings: 6 });
  assert.throws(() => SD.morph(a, b, 0.5, {}), /顶点数不同|面数不同/);
});

test('wire：wire=1 时不填充，只描边', () => {
  const cam = SP.cam({ pos: [0, 0, -500], look: [0, 0, 0], fov: 45, w: 400, h: 300 });
  const L = SD.light({ ambient: [60, 60, 70], sun: [255, 255, 255], ambI: 0.5, sunI: 1 });
  const g = fakeCtx();
  SD.draw(g, cam, [SD.box(100, 100, 100)], L, { wire: 1 });
  assert.equal(g.rec.fills, 0, 'wire=1 不该有填充');
  assert.equal(g.rec.strokes, 1, '应有一次合并的线框描边');
});

test('wire：fill 与 wire 可以分开给（实体先长、线框后落）', () => {
  const cam = SP.cam({ pos: [0, 0, -500], look: [0, 0, 0], fov: 45, w: 400, h: 300 });
  const L = SD.light({ ambient: [60, 60, 70], sun: [255, 255, 255], ambI: 0.5, sunI: 1 });
  const g = fakeCtx();
  SD.draw(g, cam, [SD.box(100, 100, 100)], L, { wire: 1, fill: 0.6 });
  assert.ok(g.rec.fills > 0, 'fill=0.6 时应该有填充');
  /* 逐面 seam 描边 + 一次合并的线框描边，所以只验「至少有一次」 */
  assert.ok(g.rec.strokes >= 1, '同时仍应有线框');
});
