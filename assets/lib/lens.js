/**
 * lens.js —— 镜头语言（v2.1）
 *
 * ┌ 为什么「镜头动」不等于「有镜头语言」 ──────────────────────────
 * │ v2.0 的运镜是：给两个机位，插值过去。结果镜头永远走直线，
 * │ 永远匀速，永远不抖 —— 一眼看出是程序。
 * │
 * │ 真实摄影机的运动有三件事是程序插值做不到的：
 * │   1. **绕主体转**（不是穿过主体）→ 球坐标插值，不是两点插值
 * │   2. **尺度是对数的**（推近 2 倍和推近 4 倍，观感差一样多）
 * │   3. **手在抖**（哪怕三脚架也有呼吸；完全静止反而假）
 * │
 * │ 这一层给：
 * │   orbitCam / orbitTrack   球坐标机位与轨道插值
 * │   push                     对数推拉（尺度连续体）
 * │   frame                    给物体半径 + 景别，自动算距离
 * │   handheld                 手持呼吸
 * │   cut                      切镜表
 * └──────────────────────────────────────────────────────────────
 */
(function (root) {
  'use strict';

  const SP = root.SP || (typeof require === 'function' ? require('./space.js') : null);
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;

  /* ── 缓动 ────────────────────────────────────────────────────────
     默认不要用 smoothstep：它起步和收尾都太慢，前 0.5 秒几乎不动，
     自动检测（hook 判定）会把它当成静止画面。
     推镜用 outCubic / outQuint（前快后慢），摇镜用 inOutSine。 */
  const EASE = {
    linear: (t) => t,
    inQuad: (t) => t * t,
    outQuad: (t) => 1 - (1 - t) * (1 - t),
    inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
    inCubic: (t) => t * t * t,
    outCubic: (t) => 1 - Math.pow(1 - t, 3),
    inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    outQuint: (t) => 1 - Math.pow(1 - t, 5),
    outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
    inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
    /* 「先冲一下再回来」：用在揭示镜头，像手推了一下 */
    outBack: (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2),
    /* 前段几乎不动、后段猛推：用在「停住 → 突然发现」的镜头 */
    inExpo: (t) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
  };

  /* ── 景别 ────────────────────────────────────────────────────────
     fill = 主体占画面高度的比例。真实摄影的景别就是这件事的通俗说法：
     大远景主体占 1/10，特写占 9/10。 */
  const SIZE = {
    extremeWide: { fov: 62, fill: 0.14 },
    wide: { fov: 52, fill: 0.30 },
    medium: { fov: 40, fill: 0.52 },
    close: { fov: 30, fill: 0.74 },
    macro: { fov: 20, fill: 0.92 },
  };

  /* 给「物体半径 + 景别」，算出机位该退多远。
     fov 是竖直视场角，所以用画面高度算，不用宽度。 */
  function distFor(radius, size, fill) {
    const s = SIZE[size] || SIZE.medium;
    const f = fill == null ? s.fill : fill;
    return radius / Math.tan((s.fov * Math.PI / 180) / 2) / Math.max(0.02, f);
  }

  /* ── 球坐标机位 ──────────────────────────────────────────────────
     az 方位角（0 = 正后方，绕 y 轴），el 仰角（正 = 从上方看），
     dist 距离，fov 视场。这是摄影机的自然参数：
     推 = dist 变小，摇 = az 变，升降 = el 变。
     用 SP.cam 输出，所以能和 SP 的投影/绘制直接对接。 */
  function orbitCam(target, o) {
    o = o || {};
    const az = o.az == null ? 0 : o.az;
    const el = o.el == null ? 0.12 : o.el;
    const dist = o.dist == null ? 800 : o.dist;
    const ce = Math.cos(el);
    const pos = [
      target[0] + Math.sin(az) * ce * dist,
      target[1] - Math.sin(el) * dist,
      target[2] - Math.cos(az) * ce * dist,
    ];
    const look = o.lookAt || target;
    return SP.cam({
      pos,
      look,
      fov: o.fov == null ? 40 : o.fov,
      roll: o.roll || 0,
      w: o.w, h: o.h, near: o.near,
    });
  }

  /* 轨道关键帧：keys = [[t, {az, el, dist, fov, roll}], ...]
     在参数空间插值（不是在世界坐标插值），所以镜头是绕着主体转的弧线。
     这是「斯坦尼康绕人转」和「穿模直线飞过去」的区别。 */
  function orbitTrack(keys, target, t, ease) {
    if (!keys.length) throw new Error('LN.orbitTrack: 至少一个机位');
    const e = ease || EASE.inOutSine;
    if (t <= keys[0][0]) return orbitCam(target, keys[0][1]);
    const last = keys[keys.length - 1];
    if (t >= last[0]) return orbitCam(target, last[1]);
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i], b = keys[i + 1];
      if (t >= a[0] && t < b[0]) {
        const k = e(clamp((t - a[0]) / Math.max(1e-6, b[0] - a[0]), 0, 1));
        const o = {};
        for (const key of ['az', 'el', 'dist', 'fov', 'roll']) {
          const av = a[1][key], bv = b[1][key];
          if (av != null || bv != null) o[key] = lerp(av == null ? bv : av, bv == null ? av : bv, k);
        }
        /* 视角目标也能动（跟拍时主体在移动） */
        const la = a[1].lookAt || target, lb = b[1].lookAt || target;
        o.lookAt = [lerp(la[0], lb[0], k), lerp(la[1], lb[1], k), lerp(la[2], lb[2], k)];
        o.w = (a[1].w || (b[1].w)); o.h = (a[1].h || (b[1].h));
        o.near = a[1].near == null ? b[1].near : a[1].near;
        return orbitCam(target, o);
      }
    }
    return orbitCam(target, last[1]);
  }

  /* ── 对数推拉 ────────────────────────────────────────────────────
     从 d0 推到 d1。距离按**对数**插值：两次「距离减半」的观感一样，
     线性插值会让前半段几乎不动、后半段猛地撞上去。
     这就是芝诺那支片子「从手指推到皮肤纹理」能连续的原因。 */
  function push(target, o) {
    const d0 = o.from, d1 = o.to;
    const u = clamp(o.u == null ? 0 : o.u, 0, 1);
    const e = (o.ease || EASE.inOutCubic)(u);
    const dist = Math.exp(lerp(Math.log(Math.max(1e-4, d0)), Math.log(Math.max(1e-4, d1)), e));
    const az = o.az == null ? 0 : o.az;
    const el = o.el == null ? 0.12 : o.el;
    const fov = lerp(o.fov0 == null ? 40 : o.fov0, o.fov1 == null ? 40 : o.fov1, e);
    return orbitCam(target, { az, el, dist, fov, roll: o.roll, w: o.w, h: o.h, near: o.near });
  }

  /* ── 手持呼吸 ────────────────────────────────────────────────────
     三个不同频率的正弦叠加，不是随机抖动（随机会像地震）。
     幅度单位是像素，roll 单位是弧度。
     返回一个 modifier，交给 apply() 作用在相机上。 */
  function handheld(t, o) {
    o = o || {};
    const amp = o.amp == null ? 1.2 : o.amp;
    const spd = o.speed == null ? 1 : o.speed;
    const ph = o.seed || 0;
    return {
      dx: (Math.sin(t * 1.7 * spd + ph) * 0.55 + Math.sin(t * 3.9 * spd + ph * 2) * 0.28) * amp,
      dy: (Math.cos(t * 1.3 * spd + ph * 1.7) * 0.50 + Math.cos(t * 4.7 * spd + ph) * 0.22) * amp,
      roll: (Math.sin(t * 0.9 * spd + ph * 3) * 0.0016 + Math.sin(t * 2.3 * spd) * 0.0008) * amp,
    };
  }

  /* 把呼吸作用到相机上：屏幕方向的抖动，用相机的 r/u 基平移。
     直接改 pos 会在世界坐标里抖，斜视角下方向就错了。 */
  function apply(cam, hh) {
    if (!hh || (!hh.dx && !hh.dy && !hh.roll)) return cam;
    /* 1 像素抖动 ≈ 目标平面上的世界距离 */
    const k = (cam._foc ? 1 / cam._foc : 0.001) * 2.2;
    cam.pos = [
      cam.pos[0] + cam._r[0] * hh.dx * k + cam._u[0] * hh.dy * k,
      cam.pos[1] + cam._r[1] * hh.dx * k + cam._u[1] * hh.dy * k,
      cam.pos[2] + cam._r[2] * hh.dx * k + cam._u[2] * hh.dy * k,
    ];
    cam.roll += hh.roll;
    return SP.basis(cam);
  }

  /* ── 切镜 ────────────────────────────────────────────────────────
     shots = [{ t0, cam | fn(t), fade? }]，返回 { cam, idx, shotT }。
     切点不做淡入淡出（淡入淡出是「转场」，切是「剪」）；
     硬切比叠化有力，除非要表达时间流逝。 */
  function cut(shots, t) {
    let idx = 0;
    for (let i = 0; i < shots.length; i++) if (t >= shots[i].t0) idx = i;
    const s = shots[idx];
    return { cam: typeof s.cam === 'function' ? s.cam(t) : s.cam, idx, shotT: t - s.t0, shot: s };
  }

  /* 把秒表转成「第几镜 + 镜内进度」，方便模板里写 if */
  function at(shots, t) {
    const r = cut(shots, t);
    const next = shots[r.idx + 1];
    const dur = (next ? next.t0 : (shots[r.idx].t1 || r.shotT + 1)) - r.shot.t0;
    return { idx: r.idx, u: clamp(r.shotT / Math.max(1e-6, dur), 0, 1), local: r.shotT, cam: r.cam };
  }

  const LN = {
    EASE, SIZE, distFor, orbitCam, orbitTrack, push, handheld, apply, cut, at,
    clamp, lerp, TAU,
  };
  root.LN = LN;
  if (typeof module === 'object' && module.exports) module.exports = LN;
})(typeof globalThis !== 'undefined' ? globalThis : this);
