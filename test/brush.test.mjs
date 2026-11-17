/**
 * brush.js 单测。
 *
 * 这一层最容易出的两类问题：
 *   1. 不确定性 —— 某个地方漏了 seed，每帧笔触都变，qa 的「同输入同输出」直接挂；
 *   2. 桶结构错位 —— 计数排序写错一格，绘制时就会用错颜色 / 用错线宽，
 *      画面「看起来还行」但其实是错的，最难肉眼发现。
 * 所以测的是结构不变量，不是像素。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BR = require('../assets/lib/brush.js');

const AREA = { x: 0, y: 0, w: 1920, h: 1080 };
const mk = (seed, extra) => BR.field(5000, Object.assign({
  seed, area: AREA, angle: BR.wind(0.2, 0.4, 7), len: [8, 40], wid: [1, 3.4],
  color: BR.jitterColor([40, 60, 96], 0.08, seed, 5),
}, extra || {}));

/* 最小 canvas 桩：只记录调用，不渲染。 */
function fakeCtx() {
  const calls = { stroke: 0, fill: 0, fillRect: 0, move: 0, styles: new Set(), widths: new Set() };
  const g = {
    save() {}, restore() {},
    beginPath() {}, lineTo() {}, quadraticCurveTo() {}, arc() {}, closePath() {},
    moveTo() { calls.move++; },
    stroke() { calls.stroke++; }, fill() { calls.fill++; },
    fillRect() { calls.fillRect++; },
    set strokeStyle(v) { calls.styles.add(v); },
    get strokeStyle() { return ''; },
    set fillStyle(v) { calls.styles.add(v); },
    get fillStyle() { return ''; },
    set lineWidth(v) { calls.widths.add(v); },
    get lineWidth() { return 1; },
    lineCap: 'butt', lineJoin: 'miter', globalAlpha: 1,
  };
  return { g, calls };
}

test('同 seed 同参数 → 逐点相同（确定性）', () => {
  const a = mk(11), b = mk(11);
  assert.equal(a.n, b.n);
  for (let i = 0; i < a.n; i += 37) {
    assert.equal(a.x[i], b.x[i]);
    assert.equal(a.y[i], b.y[i]);
    assert.equal(a.ang[i], b.ang[i]);
  }
});

test('换 seed 必须换结果（否则 seed 是摆设）', () => {
  const a = mk(11), b = mk(12);
  let diff = 0;
  for (let i = 0; i < a.n; i++) if (a.x[i] !== b.x[i]) diff++;
  assert.ok(diff > a.n * 0.9, `只有 ${diff}/${a.n} 个点不同`);
});

test('桶结构：边界单调、合计等于 n、桶内同色同粗', () => {
  const f = mk(3);
  assert.equal(f.start[0], 0);
  assert.equal(f.start[f.nB], f.n);
  for (let b = 0; b < f.nB; b++) {
    assert.ok(f.start[b] <= f.start[b + 1], `桶 ${b} 边界倒挂`);
    const c = f.ci[f.start[b]];
    const w = f.wl[f.start[b]];
    for (let i = f.start[b]; i < f.start[b + 1]; i++) {
      assert.equal(f.ci[i], c, '桶内出现第二种颜色');
      assert.equal(f.wl[i], w, '桶内出现第二档粗细');
    }
  }
});

test('颜色过多会被量化，桶数不会爆炸', () => {
  /* 连续渐变 = 每笔一个颜色。不量化的话桶数 = n，
     批量提交等于没做。 */
  const f = BR.field(8000, {
    seed: 5, area: AREA, len: [6, 30], wid: [1, 3],
    color: (x, y) => `rgb(${x / 3 | 0},${y / 3 | 0},140)`,
    maxColors: 36,
  });
  assert.ok(f.nC <= 40, `颜色数压不下来：${f.nC}`);
  assert.ok(f.nB <= f.nC * 3, `桶数 ${f.nB} 超过 色数×3`);
});

test('jitterColor 走档位：颜色数不超过 levels', () => {
  const f = BR.field(6000, {
    seed: 9, area: AREA, len: [6, 20], wid: [1, 2],
    color: BR.jitterColor([30, 44, 70], 0.1, 9, 4),
  });
  assert.ok(f.nC <= 4, `levels=4 却出了 ${f.nC} 种颜色`);
});

test('morph：k=0 等于 A，k=1 等于 B', () => {
  const a = mk(1, { color: 'rgb(10,20,30)' });
  const b = mk(2, { color: 'rgb(10,20,30)' });
  const n = Math.min(a.n, b.n);
  const m0 = BR.morph(a, b, 0);
  const m1 = BR.morph(a, b, 1);
  for (let i = 0; i < n; i += 29) {
    assert.ok(Math.abs(m0.x[i] - a.x[i]) < 1e-4);
    assert.ok(Math.abs(m1.x[i] - b.x[i]) < 1e-4);
  }
});

test('morph 的角度走最短弧，不会整圈倒转', () => {
  /* A 在 179°，B 在 -179°，线性插值会经过 0°（转 358°），
     最短弧应该经过 180°（转 2°）。 */
  const a = BR.field(1, { seed: 1, area: AREA, angle: Math.PI * 0.994, len: 10, wid: 2 });
  const b = BR.field(1, { seed: 1, area: AREA, angle: -Math.PI * 0.994, len: 10, wid: 2 });
  const m = BR.morph(a, b, 0.5);
  /* 中点应在 ±π 附近，而不是 0 */
  assert.ok(Math.abs(Math.abs(m.ang[0]) - Math.PI) < 0.05, `中点角度 ${m.ang[0]}`);
});

test('morph 结果同样可以直接绘制（桶结构完好）', () => {
  const a = mk(4), b = mk(5);
  const m = BR.morph(a, b, 0.4);
  assert.equal(m.start[m.nB], m.n);
  const { g, calls } = fakeCtx();
  BR.draw(g, m, { alpha: 1 });
  assert.ok(calls.stroke > 0, 'morph 后的场没画出任何东西');
  assert.equal(calls.stroke, m.nB, 'stroke 次数应等于非空桶数（同色同粗一次提交）');
});

test('draw：reveal 0 不画、0.5 画一半、1 全画', () => {
  const f = mk(6);
  /* 注意：stroke 次数不随 reveal 变（桶非空就提交一次），
     要看的是进到路径里的**笔数**。 */
  for (const [rv, lo, hi] of [[0, 0, 0], [0.5, 0.42, 0.58], [1, 0.999, 1.001]]) {
    const { g, calls } = fakeCtx();
    BR.draw(g, f, { reveal: rv });
    if (rv === 0) { assert.equal(calls.move, 0); assert.equal(calls.stroke, 0); continue; }
    const ratio = calls.move / f.n;
    assert.ok(ratio >= lo && ratio <= hi, `reveal=${rv} 实际画了 ${(ratio * 100).toFixed(1)}%`);
  }
});

test('draw 的同色同粗只提交一次（这是性能的全部意义）', () => {
  const f = mk(8, { color: 'rgb(50,60,70)' });
  const { g, calls } = fakeCtx();
  BR.draw(g, f, { alpha: 1 });
  assert.equal(calls.stroke, f.nB);
  assert.ok(f.nB <= 6, `单色单粗不该有 ${f.nB} 个桶`);
});

test('textPoints 在 node 里给出明确错误，而不是静默返回空', () => {
  assert.throws(() => BR.textPoints('测试'), /浏览器环境/);
});

test('snap 把笔触吸到点集上（k=1 时误差极小）', () => {
  const f = BR.field(400, { seed: 2, area: { x: 0, y: 0, w: 200, h: 200 }, len: 4, wid: 1 });
  const pts = { n: 1, xy: Float32Array.from([100, 100]) };
  BR.snap(f, pts, { k: 1 });
  for (let i = 0; i < f.n; i++) {
    assert.ok(Math.abs(f.x[i] - 100) < 1e-3 && Math.abs(f.y[i] - 100) < 1e-3);
  }
});

test('wind / vortex 返回有限角度（不会有 NaN 传进 cos）', () => {
  const w = BR.wind(0.3, 0.5, 2), v = BR.vortex(0, 0, 1);
  for (const [x, y] of [[0, 0], [100, -200], [-500, 900]]) {
    assert.ok(Number.isFinite(w(x, y)), 'wind 出 NaN');
    assert.ok(Number.isFinite(v(x, y)), 'vortex 出 NaN');
  }
  /* 圆心处不能除零 */
  assert.ok(Number.isFinite(v(0, 0)));
});

test('12 万笔的生成与 morph 在可接受时间内', () => {
  const t0 = Date.now();
  const f = BR.field(120000, {
    seed: 7, area: AREA, angle: BR.vortex(960, 540, 1), len: [8, 44], wid: [1.1, 3.6],
    color: BR.jitterColor([38, 58, 92], 0.1, 7, 6),
  });
  const gen = Date.now() - t0;
  const t1 = Date.now();
  BR.morph(f, f, 0.5);
  const mo = Date.now() - t1;
  assert.ok(gen < 900, `生成 12 万笔用了 ${gen}ms`);
  assert.ok(mo < 600, `morph 12 万笔用了 ${mo}ms`);
});
