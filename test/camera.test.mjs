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

/* =====================================================================
   第二层：镜头语言（v1.8）
   这一层的坑和第一层不同：不是 NaN，是「露边」和「不确定」。
   露边 = 放大不足却平移，画到画布外，成片边缘一条底色；
   不确定 = 用了 Math.random，逐帧渲染时每帧抖成雪花。
   ===================================================================== */

test('camera line：英文/中文/速度词/缓动都能解析', () => {
  const cases = [
    ['dolly in, 3s, slow ease-in-out', 'dollyIn', 'inOut', 0.6, 3],
    ['dolly in, 3s', 'dollyIn', 'inertia', 1, 3],
    ['pan, 5s, medium, left', 'pan', 'inertia', 1, 5],
    ['handheld, 1', 'handheld', 'linear', 1, null],
    ['whip, 0.3s', 'whip', 'inOut', 1, 0.3],
    ['推镜, 3s, 慢', 'dollyIn', 'inertia', 0.6, 3],
    ['环绕', 'orbit', 'inertia', 1, null],
    ['固定', 'static', 'linear', 1, null],
  ];
  for (const [line, id, ease, amount, dur] of cases) {
    const p = CAM.parseLine(line);
    assert.ok(p, `解析失败：${line}`);
    assert.equal(p.id, id, line);
    assert.equal(p.ease, ease, line);
    assert.equal(p.amount, amount, line);
    assert.equal(p.dur, dur, line);
  }
});

test('camera line：认不出的词不算错，整条都认不出才返回 null', () => {
  assert.equal(CAM.parseLine('dolly in, 3s, toward the figure').id, 'dollyIn');
  assert.equal(CAM.parseLine('随便写点什么'), null);
  assert.equal(CAM.parseLine(''), null);
  assert.equal(CAM.parseLine(null), null);
});

test('缓动：端点固定且单调不减', () => {
  for (const [name, fn] of Object.entries(CAM.EASE)) {
    assert.equal(fn(0), 0, name);
    assert.ok(Math.abs(fn(1) - 1) < 1e-9, name);
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const v = fn(i / 20);
      assert.ok(v >= prev - 1e-9, `${name} 在 ${i / 20} 处回退`);
      prev = v;
    }
  }
});

test('inertia 两端都还有速度（切点不会"停住"）', () => {
  const e = CAM.EASE.inertia;
  assert.ok(e(0.02) / 0.02 > 0.3, '起点太慢');
  assert.ok((1 - e(0.98)) / 0.02 > 0.3, '终点太慢');
});

test('防露边：所有运动任意时刻 scale ≥ 1，位移不超过放大余量', () => {
  const lines = CAM.list().map((m) => m.id);
  let checked = 0;
  for (const id of lines) {
    for (let i = 0; i <= 40; i++) {
      const t = (i / 40) * 8;
      const c = CAM.move(id, t, 4);
      if (!c) continue;
      checked++;
      assert.ok(c.scale >= 1 - 1e-9, `${id}@${t}s scale=${c.scale} < 1（会露边）`);
      const maxT = (c.scale - 1) / 2 + 1e-9;
      assert.ok(Math.abs(c.tx) <= maxT, `${id}@${t}s tx=${c.tx} > ${maxT}`);
      assert.ok(Math.abs(c.ty) <= maxT, `${id}@${t}s ty=${c.ty} > ${maxT}`);
      assert.ok(c.blur >= 0 && c.blur <= 10.01, `${id}@${t}s blur=${c.blur}`);
      assert.ok(Number.isFinite(c.rot), `${id}@${t}s rot 非有限值`);
    }
  }
  assert.ok(checked > 200, `只检查了 ${checked} 个时刻`);
});

test('确定性：同一时刻渲两次完全一致（手持也一样）', () => {
  for (const line of ['handheld, 1', 'orbit, 6s', 'whip, 0.3s', 'dolly in, 3s']) {
    for (const t of [0, 0.37, 1.9, 4.4]) {
      assert.deepEqual(CAM.move(line, t, 5), CAM.move(line, t, 5), `${line}@${t}`);
    }
  }
});

test('手持是低频漂移：相邻帧位移 < 0.0008 画幅（不会看着像地震）', () => {
  let maxJump = 0;
  for (let i = 1; i <= 120; i++) {
    const a = CAM.move('handheld, 1', i / 30, 5);
    const b = CAM.move('handheld, 1', (i - 1) / 30, 5);
    maxJump = Math.max(maxJump, Math.abs(a.tx - b.tx), Math.abs(a.ty - b.ty));
  }
  assert.ok(maxJump < 0.0008, `相邻帧位移 ${maxJump} 太大`);
});

test('retime：定格 / 半速 / 不变 / 变速斜坡', () => {
  assert.equal(CAM.retime(3, [[2, 1], [2, 0]]), 2);
  assert.ok(Math.abs(CAM.retime(2, [[0, 0.5]]) - 1) < 1e-9);
  assert.ok(Math.abs(CAM.retime(3.5, [[0, 1]]) - 3.5) < 1e-9);
  const ramp = CAM.retime(1.4, [[0, 1], [1.4, 0.25]]);
  assert.ok(ramp > 0.7 && ramp < 1.4, `ramp=${ramp}`);
});

test('begin/end 成对，且 begin 会 save', () => {
  const calls = [];
  const g = { save: () => calls.push('save'), restore: () => calls.push('restore'),
    translate: () => {}, rotate: () => {}, scale: () => {}, filter: '' };
  const c = CAM.move('dolly in, 2s', 1, 4);
  CAM.begin(g, c, 1920, 1080);
  CAM.end(g);
  assert.deepEqual(calls, ['save', 'restore']);
});

test('begin(null) 什么都不做（没镜头时不能凭空多一对 save/restore）', () => {
  const calls = [];
  const g = { save: () => calls.push('save'), restore: () => calls.push('restore'),
    translate: () => {}, rotate: () => {}, scale: () => {}, filter: '' };
  CAM.begin(g, null, 1920, 1080);
  CAM.end(g);
  assert.deepEqual(calls, ['restore']); // end 无论如何 restore 一次，begin 没 save
});

test('词汇表：12 种运动，每个都有中文名与"观众感受"', () => {
  const list = CAM.list();
  assert.equal(list.length, 12);
  for (const m of list) assert.ok(m.cn && m.en && m.feel, `${m.id} 缺字段`);
});
