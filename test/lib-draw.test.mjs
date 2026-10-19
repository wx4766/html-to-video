/**
 * 素材库（shapes / figures）的绘制单测。
 *
 * 这类代码最怕的不是「画错」（那要人眼看），而是**传了 NaN / Infinity 给 canvas** ——
 * 画面会整块消失或部分消失，控制台一声不响。所以用桩上下文把所有数字抓下来验一遍。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SH = require('../assets/lib/shapes.js');
const FIG = require('../assets/lib/figures.js');

/** 桩 canvas context：记录所有数字参数，遇到非有限值就记下来 */
function stubCtx() {
  const bad = [];
  const check = (name, args) => {
    args.forEach((v, i) => {
      if (typeof v === 'number' && !Number.isFinite(v)) bad.push(`${name}#${i}=${v}`);
    });
  };
  const noop = (name) => (...args) => { check(name, args); };
  const ctx = {
    bad,
    canvas: { width: 1920, height: 1080 },
    save: noop('save'), restore: noop('restore'),
    beginPath: noop('beginPath'), closePath: noop('closePath'),
    moveTo: noop('moveTo'), lineTo: noop('lineTo'),
    arc: noop('arc'), arcTo: noop('arcTo'), ellipse: noop('ellipse'),
    quadraticCurveTo: noop('quadraticCurveTo'), bezierCurveTo: noop('bezierCurveTo'),
    rect: noop('rect'), clip: noop('clip'),
    fill: noop('fill'), stroke: noop('stroke'),
    fillRect: noop('fillRect'), strokeRect: noop('strokeRect'), clearRect: noop('clearRect'),
    translate: noop('translate'), scale: noop('scale'), rotate: noop('rotate'),
    setTransform: noop('setTransform'), transform: noop('transform'),
    setLineDash: noop('setLineDash'),
    fillText: (t, x, y) => { check('fillText', [x, y]); },
    strokeText: (t, x, y) => { check('strokeText', [x, y]); },
    measureText: (t) => ({ width: String(t).length * 12 }),
    drawImage: noop('drawImage'),
    createLinearGradient: (...a) => { check('createLinearGradient', a); return { addColorStop: () => {} }; },
    createRadialGradient: (...a) => { check('createRadialGradient', a); return { addColorStop: () => {} }; },
    createPattern: () => ({}),
  };
  return ctx;
}

test('图标库：数量够用，且每一个都能画（无 NaN）', () => {
  const names = SH.iconNames();
  assert.ok(names.length >= 40, `图标太少：${names.length} 个`);
  const g = stubCtx();
  for (const n of names) {
    assert.equal(SH.icon(g, n, 10, 20, 48, { color: '#fff', width: 2 }), true, `画不出来：${n}`);
  }
  assert.deepEqual(g.bad, [], `图标绘制出现非有限值：${g.bad.slice(0, 5).join(', ')}`);
});

test('图标库：不存在的名字返回 false，不抛错', () => {
  const g = stubCtx();
  assert.equal(SH.icon(g, '肯定没这个图标', 0, 0, 24, {}), false);
  assert.equal(SH.hasIcon('check'), true);
  assert.equal(SH.hasIcon('肯定没这个图标'), false);
});

test('基础图形：全部无 NaN', () => {
  const g = stubCtx();
  SH.roundRect(g, 10, 20, 300, 120, 16); g.fillStyle = '#fff'; g.fill();
  SH.card(g, { x: 10, y: 20, w: 300, h: 120 }, { fill: '#111', stroke: '#333', radius: 18, shadow: 'rgba(0,0,0,.3)' });
  SH.pill(g, 10, 20, 200, 40, '#fff');
  SH.arrow(g, 10, 10, 300, 200, { color: '#fff' });
  SH.arrow(g, 10, 10, 300, 200, { color: '#fff', curve: [150, 40] });
  SH.elbow(g, [[10, 10], [200, 60], [300, 200]], { color: '#fff', dash: [6, 4] });
  SH.dashRect(g, 10, 10, 200, 120, { color: '#fff' });
  SH.progressArc(g, 100, 100, 40, 0.6, { color: '#fff', track: '#333' });
  SH.grid(g, 1920, 1080, { step: 120 });
  SH.dots(g, 1920, 1080, { step: 60 });
  SH.glow(g, 200, 200, 400, 'rgba(255,0,0,.3)');
  SH.vignette(g, 1920, 1080, 0.4);
  SH.mesh(g, 1920, 1080, ['#f00', '#0f0', '#00f'], 1.5);
  SH.corners(g, { x: 10, y: 10, w: 400, h: 300 }, { color: '#fff' });
  SH.sepLine(g, 10, 100, 800, {});
  assert.deepEqual(g.bad, [], `基础图形出现非有限值：${g.bad.slice(0, 5).join(', ')}`);
});

test('grain 在无 document 环境下安静跳过（node 里跑测试不该炸）', () => {
  const g = stubCtx();
  SH.grain(g, 1920, 1080, 0.04);
  assert.deepEqual(g.bad, []);
});

const MOODS = ['happy', 'smile', 'neutral', 'sad', 'surprised', 'think'];
const POSES = ['idle', 'wave', 'point', 'present', 'think', 'walk'];
const HAIRS = ['short', 'buzz', 'pony', 'bun', 'long', 'bald'];

test('人物：任意 预设 × 表情 × 姿势 × 发型 都画得出来且无 NaN', () => {
  const g = stubCtx();
  for (const name of Object.keys(FIG.PRESETS)) {
    for (const mood of MOODS) {
      for (const pose of POSES) {
        for (const hair of HAIRS) {
          FIG.draw(g, FIG.preset(name, { x: 400, y: 900, h: 420, t: 1.7, mood, pose, hair }));
        }
      }
    }
  }
  assert.deepEqual(g.bad, [], `人物绘制出现非有限值：${g.bad.slice(0, 5).join(', ')}`);
});

test('人物：h 为 0 或负数时不产生 NaN（防御除零）', () => {
  const g = stubCtx();
  FIG.draw(g, { x: 0, y: 0, h: 0, t: 0 });
  FIG.draw(g, { x: 0, y: 0, h: -100, t: 0 });
  assert.deepEqual(g.bad, [], `异常身高出现非有限值：${g.bad.slice(0, 5).join(', ')}`);
});

test('shade()：往黑 / 往白混，非法输入原样返回', () => {
  // 袖子和上衣必须差一档，人物才不会「没有胳膊」—— 这个函数是那条规则的底座
  assert.equal(FIG.shade('#808080', -0.5), '#404040');
  assert.equal(FIG.shade('#808080', 0), '#808080');
  assert.equal(FIG.shade('#000000', 0.5), '#808080');
  assert.equal(FIG.shade('#FFB86B', -1), '#000000');
  assert.equal(FIG.shade('rgba(1,2,3,.5)', -0.2), 'rgba(1,2,3,.5)', '非 hex 原样返回，不炸');
  assert.equal(FIG.shade(undefined, -0.2), undefined);
});

test('人物：袖子按上衣色暗一档画（否则手臂融进衣服里，只剩一只手浮着）', () => {
  const g = stubCtx();
  const stroked = [];
  g.stroke = () => { if (typeof g.strokeStyle === 'string') stroked.push(g.strokeStyle); };
  const p = FIG.preset('guide', { x: 100, y: 500, h: 300, t: 0, pose: 'idle' });
  FIG.draw(g, p);
  const sleeve = FIG.shade(p.top, -0.14);
  assert.ok(stroked.includes(sleeve), `袖色 ${sleeve} 没画出来，实际描边色：${[...new Set(stroked)].join(' ')}`);
  assert.ok(!stroked.includes(p.top), '袖子不能和上衣同色');
});

test('人物：确定性 —— 同一 t 画两次，调用序列一模一样', () => {
  const seq = () => {
    const log = [];
    const g = stubCtx();
    for (const k of ['arc', 'ellipse', 'quadraticCurveTo', 'lineTo', 'moveTo', 'fillRect']) {
      const orig = g[k];
      g[k] = (...a) => { log.push(k + ':' + a.map(v => typeof v === 'number' ? v.toFixed(6) : v).join(',')); return orig(...a); };
    }
    FIG.draw(g, FIG.preset('guide', { x: 100, y: 500, h: 300, t: 2.5, pose: 'wave' }));
    return log.join('|');
  };
  assert.equal(seq(), seq(), '人物必须是 t 的纯函数，否则并行渲染会各渲各的');
});

test('对话气泡：换行数组与字符串都能画，且无 NaN', () => {
  const g = stubCtx();
  FIG.say(g, { x: 100, y: 100, w: 600, h: 200 }, ['第一行', '第二行'], { size: 28 });
  FIG.say(g, { x: 100, y: 100, w: 600, h: 200 }, '一行', { size: 28, align: 'left', tail: false });
  FIG.say(g, { x: 100, y: 100, w: 600, h: 200 }, [], { size: 28 });
  assert.deepEqual(g.bad, [], `气泡出现非有限值：${g.bad.slice(0, 5).join(', ')}`);
});
