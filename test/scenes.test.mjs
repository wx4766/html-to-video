/**
 * scenes.js 单测：镜头时间轴的算术最容易写错（转场重叠、局部时间越界），
 * 而这类错在画面上的表现是「某个镜头少了半秒」——肉眼很难发现，只能靠算。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SC = require('../assets/lib/scenes.js');

/** 三个镜头：2s / 3s / 1s，中间两个转场各 0.5s */
function demo(opts = {}) {
  return SC.build([
    { id: 'a', dur: 2.0, draw: () => {} },
    { id: 'b', dur: 3.0, trans: { in: 'fade', dur: 0.5 }, draw: () => {} },
    { id: 'c', dur: 1.0, trans: { in: 'push', dur: 0.5 }, draw: () => {} },
  ], opts);
}

test('总时长 = 镜头时长之和 − 转场重叠', () => {
  const tl = demo();
  // 2 + 3 + 1 − 0.5 − 0.5 = 5
  assert.equal(tl.dur, 5);
  assert.equal(tl.shots.length, 3);
});

test('镜头起点依次后移，转场段被重叠掉', () => {
  const tl = demo();
  assert.equal(tl.shots[0].start, 0);
  assert.equal(tl.shots[1].start, 1.5);   // 2.0 − 0.5
  assert.equal(tl.shots[2].start, 4.0);   // 1.5 + 3.0 − 0.5
  assert.equal(tl.shots[2].end, 5.0);
});

test('at()：非转场段返回镜头内局部时间', () => {
  const tl = demo();
  const s = SC.at(tl, 3.0);
  assert.equal(s.i, 1);
  assert.equal(s.tr, null);
  assert.ok(Math.abs(s.lt - 1.5) < 1e-9);
});

test('at()：转场窗口里给出两个镜头的局部时间', () => {
  const tl = demo();
  const s = SC.at(tl, 1.7);        // 落在 a→b 的转场里（1.5–2.0）
  assert.equal(s.i, 1);
  assert.ok(s.tr, '应该在转场窗口里');
  assert.equal(s.tr.name, 'fade');
  assert.equal(s.tr.a, 0);
  assert.equal(s.tr.b, 1);
  // 上一镜的局部时间 = t − 它自己的起点（转场期间正好走完它最后 0.5s）
  assert.ok(s.tr.aLt <= 2.0 + 1e-9 && s.tr.aLt >= 1.5 - 1e-9);
  assert.ok(Math.abs(s.tr.aLt - 1.7) < 1e-9);
  assert.ok(Math.abs(s.tr.bLt - 0.2) < 1e-9);
  assert.ok(Math.abs(s.tr.p - 0.4) < 1e-9);
});

test('at()：超界时间被夹住，不返回 undefined', () => {
  const tl = demo();
  assert.equal(SC.at(tl, -5).i, 0);
  assert.equal(SC.at(tl, 999).i, 2);
  assert.ok(SC.at(tl, 999).lt <= 1.0 + 1e-9);
});

test('转场时长不会吃掉镜头的一大半', () => {
  // 上一个镜头只有 1s，转场要 0.9s —— 必须被压到 0.9×1.0 以内
  const tl = SC.build([
    { id: 'a', dur: 1.0, draw: () => {} },
    { id: 'b', dur: 1.0, trans: { in: 'fade', dur: 0.9 }, draw: () => {} },
  ]);
  assert.ok(tl.shots[1].transDur <= 0.9 * 1.0 + 1e-9);
});

test('未知的转场名直接报错（而不是静默硬切）', () => {
  assert.throws(
    () => SC.build([
      { id: 'a', dur: 1, draw: () => {} },
      { id: 'b', dur: 1, trans: { in: '不存在的转场' }, draw: () => {} },
    ]),
    /未知转场/
  );
});

test('镜头缺 dur 或 draw 直接报错', () => {
  assert.throws(() => SC.build([{ id: 'a', draw: () => {} }]), /dur/);
  assert.throws(() => SC.build([{ id: 'a', dur: 1 }]), /draw/);
  assert.throws(() => SC.build([]), /不能为空/);
});

test('转场注册表齐全，名字可枚举', () => {
  for (const name of ['cut', 'fade', 'dip', 'slide', 'push', 'rise', 'zoom', 'wipe']) {
    assert.equal(typeof SC.TRANSITIONS[name], 'function', `缺转场 ${name}`);
  }
  assert.ok(SC.TRANS_NAMES.includes('fade'));
});

test('确定性：同一个 t 求两次结果完全一致', () => {
  const tl = demo();
  const a = JSON.stringify(SC.at(tl, 1.73));
  const b = JSON.stringify(SC.at(tl, 1.73));
  assert.equal(a, b);
});

test('expose() 导出镜头表，字段齐全', () => {
  const tl = demo();
  const table = SC.expose(tl);
  assert.equal(table.length, 3);
  for (const row of table) {
    for (const k of ['index', 'id', 'start', 'end', 'dur', 'trans_in', 'trans_dur']) {
      assert.ok(k in row, `镜头表缺字段 ${k}`);
      assert.notEqual(row[k], undefined);
    }
  }
  assert.equal(table[0].trans_in, 'cut');
  assert.equal(table[1].trans_in, 'fade');
  // 表里最后一个镜头的 end 必须等于总时长，--scene-log 才对得上
  assert.equal(table[table.length - 1].end, tl.dur);
});

test('lead / tail 不改变总时长（只是淡入淡出，不是加镜头）', () => {
  const base = demo();
  const fancy = demo({ lead: 0.4, tail: 0.6 });
  assert.equal(fancy.dur, base.dur);
  assert.equal(fancy.lead, 0.4);
  assert.equal(fancy.tail, 0.6);
});

/** 假上下文：只记录调用，不真画 */
function stubCtx() {
  const calls = [];
  return {
    calls,
    setTransform: (...a) => calls.push(['setTransform', ...a]),
    clearRect: (...a) => calls.push(['clearRect', ...a]),
    save() {}, restore() {},
  };
}

test('paintShot 把转场身份交给镜头（退场侧靠它撤内容）', () => {
  const tl = demo();
  let got = null;
  const shot = { ...tl.shots[1], draw: (g, lt, ctx) => { got = ctx; } };

  SC.paintShot(stubCtx(), shot, 0.3, { W: 8, H: 6 }, 1.5, 'a', 0.25);
  assert.equal(got.role.side, 'a');
  assert.equal(got.role.p, 0.25);
  assert.equal(got.trans.dur, 0.5);
  assert.equal(got.trans.name, 'fade');
  assert.equal(got.t, 0.3, '局部时间要原样传下去');

  // 不在转场窗口时 side 是 null，p 是 0 —— 模板据此走「无转场」分支
  SC.paintShot(stubCtx(), shot, 2.0, { W: 8, H: 6 }, 2.0, null, 0);
  assert.equal(got.role.side, null);
  assert.equal(got.role.p, 0);
});
