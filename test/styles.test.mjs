/**
 * 风格库契约测试
 *
 * 为什么值得写：风格是「插件」，插件最容易出的问题不是画得丑，而是
 *   · 少一个字段 → 模板取到 undefined，画布全黑
 *   · card() 忘了返回内容安全框 → 调用方报 reading 'x' of undefined
 *   · 用了 Math.random → 每次渲出来不一样，确定性 QA 亮红灯
 * 这三类问题肉眼都要渲一遍才发现，一条断言就能挡住。
 *
 * 跑：node --test test/styles.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SV = require('../assets/lib/styles.js');

/* 一个假的 2D 上下文：只记调用，不真画。
   风格代码里会用到 filter / letterSpacing / createPattern 这些，
   所以用一个 Proxy 兜住任意方法名，避免每加一个 API 就要改桩。 */
function fakeCtx() {
  const calls = [];
  const state = { calls };
  const target = {
    canvas: { width: 1920, height: 1080 },
    // 属性赋值走 set，方法调用走 get
    setTransform() {}, save() {}, restore() {}, beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {}, arc() {}, rect() {}, fill() {}, stroke() {},
    fillRect() {}, strokeRect() {}, clip() {}, translate() {}, rotate() {}, scale() {},
    fillText() { calls.push('fillText'); }, measureText: () => ({ width: 100 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createPattern: () => ({}),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: () => ({ data: [0, 0, 0, 0] }),
    putImageData() {},
  };
  return new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'then') return undefined;       // 别让 await 把 ctx 当 thenable
      return undefined;
    },
    set(t, k, v) {
      t[k] = v;
      // 记下 filter 赋值：有几个风格靠 filter 做模糊，赋值丢失会静默变成实心块
      if (k === 'filter' && v !== 'none') calls.push('filter:' + v);
      return true;
    },
  });
}

const ids = SV.list().map((s) => s.id);

/* styles.js 的纸纹/网点要用离屏 canvas 生成纹理 tile。
   node 里没有 document，补一个最小实现 —— 不然整组测试都会在
   "document is not defined" 上失败，而真正要验的契约一条都没跑到。 */
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') throw new Error('测试桩只支持 canvas，收到 ' + tag);
      return { width: 0, height: 0, getContext: () => fakeCtx() };
    },
  };
}

test('至少 8 种风格，id 唯一', () => {
  assert.ok(ids.length >= 8, `风格只有 ${ids.length} 种`);
  assert.equal(new Set(ids).size, ids.length);
});

test('每种风格都实现完整契约', () => {
  for (const s of SV.list()) {
    const st = SV.get(s.id);
    for (const fn of ['bg', 'text', 'card', 'bar']) {
      assert.equal(typeof st[fn], 'function', `${s.id} 缺 ${fn}()`);
    }
    assert.ok(st.theme && st.theme.bg && st.theme.ink, `${s.id} 的 theme 不完整`);
    assert.ok(st.type && st.type.display && st.type.body, `${s.id} 的 type 不完整`);
    assert.ok(st.motion && typeof st.motion.enter === 'number', `${s.id} 缺 motion.enter`);
    assert.ok(st.cn && st.en, `${s.id} 缺中文名/英文名`);
    assert.ok(Array.isArray(st.tags) && st.tags.length, `${s.id} 缺 tags`);
  }
});

test('card() 必须返回内容安全框（含 ink 文字色）', () => {
  for (const s of SV.list()) {
    const st = SV.get(s.id);
    const box = { x: 100, y: 100, w: 600, h: 240 };
    const out = st.card(fakeCtx(), box, { S: 1, accent: true });
    assert.ok(out && typeof out === 'object', `${s.id}.card() 没返回对象`);
    for (const k of ['x', 'y', 'w', 'h']) {
      assert.equal(typeof out[k], 'number', `${s.id}.card() 返回的 ${k} 不是数字`);
    }
    assert.ok(out.w > 0 && out.h > 0, `${s.id}.card() 返回了空安全框`);
    assert.ok(out.x >= box.x - 1 && out.y >= box.y - 1, `${s.id}.card() 安全框跑出卡片左上角`);
    assert.ok(
      out.x + out.w <= box.x + box.w + 1 && out.y + out.h <= box.y + box.h + 1,
      `${s.id}.card() 安全框跑出卡片右下角`
    );
    assert.equal(typeof out.ink, 'string', `${s.id}.card() 没给 ink 文字色`);
  }
});

test('中文名与常见别名都能解析', () => {
  const cases = {
    riso: 'riso', 印刷: 'riso', 孔版: 'riso', print: 'riso',
    剪纸: 'cutpaper', 拼贴: 'cutpaper', paper: 'cutpaper',
    蓝图: 'blueprint', 工程: 'blueprint', cad: 'blueprint',
    黑板: 'chalk', 粉笔: 'chalk', chalkboard: 'chalk',
    等距: 'isometric', 线稿: 'isometric', iso: 'isometric',
    霓虹: 'synthwave', 复古: 'synthwave', cyberpunk: 'synthwave',
    瑞士: 'swiss', 极简: 'swiss', grid: 'swiss',
    水墨: 'ink', 国风: 'ink', 宣纸: 'ink',
  };
  for (const [input, want] of Object.entries(cases)) {
    assert.equal(SV.norm(input), want, `"${input}" 应解析成 ${want}`);
    assert.equal(SV.get(input).id, want);
  }
  // 大小写不敏感
  assert.equal(SV.norm('RISO'), 'riso');
  assert.equal(SV.norm('Swiss'), 'swiss');
});

test('拼错风格名不静默回退（require 要抛），get 才回退', () => {
  assert.throws(() => SV.require('risoo'), /未知风格/);
  assert.equal(SV.get('risoo').id, SV.DEFAULT);   // get 宽容，require 严格
});

test('seeded 随机是纯函数：同 seed 同序列', () => {
  const a = SV.rng(7), b = SV.rng(7), c = SV.rng(8);
  const sa = Array.from({ length: 6 }, () => a());
  const sb = Array.from({ length: 6 }, () => b());
  const sc = Array.from({ length: 6 }, () => c());
  assert.deepEqual(sa, sb, '同 seed 序列不一致');
  assert.notDeepEqual(sa, sc, '不同 seed 序列相同，随机是假的');
});

test('hash(t) 在同一时间片内稳定，跨时间片变化', () => {
  // 手抖是按 1/12 秒一个时间片算的，同片内必须完全一致，否则每帧乱跳
  assert.equal(SV.hash(3, 1.00), SV.hash(3, 1.02));
  assert.notEqual(SV.hash(3, 1.00), SV.hash(3, 1.20));
});

test('enter() 的进度单调、首尾夹紧', () => {
  for (const s of SV.list()) {
    const st = SV.get(s.id);
    const e0 = SV.enter(st, -1), e1 = SV.enter(st, 0.5), e2 = SV.enter(st, 2);
    assert.ok(e0.alpha <= 0.001, `${s.id} 入场起点没淡入`);
    assert.ok(e2.alpha >= 0.999, `${s.id} 入场终点没全显`);
    assert.ok(e1.alpha > e0.alpha && e1.alpha <= e2.alpha, `${s.id} alpha 不单调`);
  }
});

test('每种风格画背景不报错，且不依赖传入之外的时钟', () => {
  for (const s of SV.list()) {
    const st = SV.get(s.id);
    const g = fakeCtx();
    assert.doesNotThrow(() => SV.bg(g, st, 1920, 1080, 0, {}), `${s.id}.bg 抛错`);
    assert.doesNotThrow(() => SV.overlay(g, st, 1920, 1080, 0, { S: 1 }), `${s.id}.overlay 抛错`);
    assert.doesNotThrow(() => SV.text(g, st, '用代码做视频', 100, 200, 120, { kind: 'display' }), `${s.id}.text 抛错`);
    assert.doesNotThrow(() => SV.bar(g, st, { x: 100, y: 300, w: 800, h: 30 }, 0.6, { S: 1 }), `${s.id}.bar 抛错`);
  }
});

test('波尔（手抖）不改变同帧结果', () => {
  for (const s of SV.list()) {
    const st = SV.get(s.id);
    const a = SV.boil(st, 3.14, 5, 2);
    const b = SV.boil(st, 3.14, 5, 2);
    assert.equal(a, b, `${s.id}.boil 不是纯函数`);
    assert.ok(Number.isFinite(a));
  }
});

test('bar() 能吃 CanvasGradient（条形图模板传的就是渐变）', () => {
  // 真实事故：ink 的 bar 把 o.color 直接塞进 addColorStop，
  // 模板传渐变时整条流水线在「水墨条形图」上崩掉，其它 7 种风格都没事。
  const fakeGradient = { __gradient: true, addColorStop() {} };
  for (const s of SV.list()) {
    const st = SV.get(s.id);
    assert.doesNotThrow(
      () => SV.bar(fakeCtx(), st, { x: 10, y: 20, w: 400, h: 30 }, 0.6, { S: 1, color: fakeGradient }),
      `${s.id}.bar 不接受渐变`
    );
  }
});

test('节拍网格换算：snap 落在拍点上，fitBeats 给整拍', () => {
  // 120bpm → 一拍 0.5s
  assert.equal(SV.BEAT.snap(0.62, 120, 1), 0.5);
  assert.equal(SV.BEAT.snap(0.78, 120, 1), 1.0);
  assert.equal(SV.BEAT.snap(0.30, 120, 0.5), 0.25);   // 半拍网格
  const f = SV.BEAT.fitBeats(3.3, 120);
  assert.equal(f.beats, 7);                            // 3.3/0.5 ≈ 6.6 → 7 拍
  assert.ok(Math.abs(f.dur - 3.5) < 1e-9);
});
