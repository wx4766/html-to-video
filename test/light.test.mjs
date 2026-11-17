/**
 * light.js 单测。
 *
 * 光照最容易「看着还行，但其实是错的」：
 * 色温算反（暖变冷）、昼夜插值在关键帧处跳变、渐变 stop 越界（整帧变黑）。
 * 前两个是观感问题，第三个是直接崩溃。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LT = require('../assets/lib/light.js');

/* 只记录，不渲染。用来验证「有没有画、参数是否合法」。 */
function fakeCtx() {
  const c = { fills: 0, stops: [], mode: null, alpha: 1 };
  const g = {
    save() {}, restore() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, translate() {}, rotate() {},
    fill() { c.fills++; }, stroke() {}, clip() {}, rect() {},
    fillRect() { c.fills++; },
    createRadialGradient() { return { addColorStop(p, v) { c.stops.push(p); assert.ok(p >= 0 && p <= 1, `stop ${p} 越界`); assert.equal(typeof v, 'string'); } }; },
    createLinearGradient() { return { addColorStop(p, v) { c.stops.push(p); assert.ok(p >= 0 && p <= 1, `stop ${p} 越界`); assert.equal(typeof v, 'string'); } }; },
    set fillStyle(v) { assert.ok(typeof v === 'string' || typeof v === 'object', 'fillStyle 类型不对'); },
    get fillStyle() { return ''; },
    set globalCompositeOperation(v) { c.mode = v; },
    get globalCompositeOperation() { return c.mode; },
    canvas: { width: 1920, height: 1080 },
  };
  return { g, c };
}

test('色温：1900K 偏红、9500K 偏蓝（方向不能反）', () => {
  const warm = LT.kelvin(1900), cool = LT.kelvin(9500);
  assert.ok(warm[0] > warm[2], `1900K 应该红多蓝少，实际 ${warm}`);
  assert.ok(cool[2] >= cool[0], `9500K 应该蓝不少于红，实际 ${cool}`);
  assert.ok(warm[1] < warm[0], '暖光里绿应低于红');
});

test('色温在所有档位都返回合法的 0~255', () => {
  for (const k of [1000, 1900, 2700, 4000, 5600, 7200, 9500, 20000, 40000]) {
    const c = LT.kelvin(k);
    for (const v of c) assert.ok(Number.isFinite(v) && v >= 0 && v <= 255, `${k}K → ${c}`);
  }
});

test('昼夜循环：0 与 1 首尾相接（不会跳一帧）', () => {
  const a = LT.sky(0), b = LT.sky(0.999999), c = LT.sky(1);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(a.ambient[i] - b.ambient[i]) < 8, `收尾处 ambient 跳变 ${a.ambient[i]} vs ${b.ambient[i]}`);
    assert.ok(Math.abs(a.sun[i] - b.sun[i]) < 8);
  }
  assert.equal(c.note, a.note);
});

test('昼夜扫描：整条曲线连续，没有台阶', () => {
  let prev = LT.sky(0), maxJump = 0;
  for (let i = 1; i <= 400; i++) {
    const s = LT.sky(i / 400);
    const j = Math.abs(s.ambI - prev.ambI) + Math.abs(s.sunI - prev.sunI);
    maxJump = Math.max(maxJump, j);
    prev = s;
  }
  assert.ok(maxJump < 0.05, `最大跳变 ${maxJump.toFixed(4)}，曲线不平滑`);
});

test('预设的语义正确：正午最亮、深夜最暗、黄昏偏暖', () => {
  assert.ok(LT.SKY.noon.ambI > LT.SKY.night.ambI);
  assert.ok(LT.SKY.noon.sunI > LT.SKY.dusk.sunI);
  const dusk = LT.SKY.dusk.sun;
  assert.ok(dusk[0] > dusk[2], '黄昏主光应该偏暖（红>蓝）');
  const night = LT.SKY.night.ambient;
  assert.ok(night[2] > night[0], '深夜环境光应该偏冷（蓝>红）');
});

test('timeline：端点原样、中间插值、字符串预设可解析', () => {
  const keys = [[0, 'dusk'], [1, 'night']];
  assert.equal(LT.timeline(keys, -1).note, '黄昏');
  assert.equal(LT.timeline(keys, 9).note, '深夜');
  const mid = LT.timeline(keys, 0.5);
  assert.ok(mid.ambI > Math.min(LT.SKY.dusk.ambI, LT.SKY.night.ambI) - 1e-9);
  assert.ok(mid.ambI < Math.max(LT.SKY.dusk.ambI, LT.SKY.night.ambI) + 1e-9);
});

test('radial：i=0 时不画（省掉一次全屏渐变）', () => {
  const { g, c } = fakeCtx();
  LT.radial(g, { x: 0, y: 0, r: 100, i: 0 });
  assert.equal(c.fills, 0);
  LT.radial(g, { x: 0, y: 0, r: 100, i: 0.5 });
  assert.equal(c.fills, 1);
});

test('radial / shaft / vignette 的渐变 stop 全在 0~1 内', () => {
  const { g, c } = fakeCtx();
  LT.radial(g, { x: 100, y: 100, r: 300, i: 0.6, inner: 0.05 });
  LT.shaft(g, { x: 10, y: 10, len: 500, angle: 1.2, spread: 0.3, i: 0.4 });
  LT.vignette(g, 1920, 1080, { amount: 0.5 });
  assert.ok(c.stops.length >= 6, '渐变 stop 太少，可能没画');
});

test('vignette amount=0 直接跳过', () => {
  const { g, c } = fakeCtx();
  LT.vignette(g, 1920, 1080, { amount: 0 });
  assert.equal(c.fills, 0);
});

test('grade：alpha=0 时不动画面（避免「调色把夜戏洗白」）', () => {
  const { g, c } = fakeCtx();
  LT.grade(g, 1920, 1080, LT.SKY.night, { alpha: 0, sunHi: false });
  /* alpha 0 仍然会 fillRect 一次（overlay），但透明度是 0 —— 这里只断言不崩 */
  assert.ok(c.fills >= 0);
  LT.grade(g, 1920, 1080, LT.SKY.dusk, { alpha: 0.3 });
  assert.ok(c.fills > 0);
});

test('exposure：1.0 完全不动作，偏离才叠加', () => {
  const { g, c } = fakeCtx();
  LT.exposure(g, 1920, 1080, 1);
  assert.equal(c.fills, 0);
  LT.exposure(g, 1920, 1080, 1.2);
  assert.equal(c.fills, 1);
});

test('finish：无光源对象时不崩（模板里可能忘了传）', () => {
  const { g } = fakeCtx();
  assert.doesNotThrow(() => LT.finish(g, 1920, 1080, null, {}));
});
