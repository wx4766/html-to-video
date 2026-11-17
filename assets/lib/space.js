/**
 * space.js —— 2.5D 空间：透视投影 + 深度排序（v2.0）
 *
 * ┌ 它是什么，不是什么 ────────────────────────────────────────────
 * │ 不是 3D 引擎：没有网格、没有光照模型、没有 z-buffer。
 * │ 只解决一件事 —— **让镜头在一个连续空间里移动**，而不是换幻灯片。
 * │
 * │ 物体是「贴在空间里的平面片」（billboard），按相机深度排序，
 * │ 按距离缩放、加雾。够用来做：
 * │   · 镜头从远处推到某个结构上（细胞课件那类「镜头移过去讲」）
 * │   · Pong 打到一半，视角滚转成一条 3D 通道
 * │   · 一队卡片/碑/门沿着 z 轴排开，镜头穿过去
 * │   · 鸟瞰一张散落的数据卡片阵列
 * └──────────────────────────────────────────────────────────────
 *
 * 坐标约定（和 canvas 一致，y 向下）：
 *   世界坐标 [x, y, z]，x 右、y 下、z 朝远离观众。
 *   相机在 pos，看向 look；相机空间 z>0 才在镜头前。
 *   屏幕投影：sx = cx + f·x/z，sy = cy + f·y/z，f = (h/2)/tan(fov/2)。
 *
 * 用法：
 *   <script src="../lib/space.js"></script>
 *   const cam = SP.cam({ pos:[0,0,-900], look:[0,0,0], fov:45, w:W, h:H });
 *   const items = [
 *     { p:[0,0,0],    draw:(g,q)=>{...} },   // q = {x,y,s,z,alpha}
 *     { p:[400,0,600], draw:(g,q)=>{...} },
 *   ];
 *   SP.draw(g, cam, items);
 */
(function (root) {
  'use strict';

  const TAU = Math.PI * 2;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function norm(a) {
    const L = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / L, a[1] / L, a[2] / L];
  }

  /* ── 相机 ────────────────────────────────────────────────────────
     只有 pos / look / fov / roll 四个自由度。roll 用来做「视角滚转」
     （Pong 变通道那种镜头歪过去的效果），默认 0。 */
  function cam(o) {
    o = o || {};
    const c = {
      pos: o.pos ? o.pos.slice() : [0, 0, -900],
      look: o.look ? o.look.slice() : [0, 0, 0],
      fov: o.fov == null ? 45 : o.fov,
      roll: o.roll == null ? 0 : o.roll,
      w: o.w || 1920,
      h: o.h || 1080,
      near: o.near == null ? 1 : o.near,
    };
    basis(c);
    return c;
  }

  /* 由 pos/look/roll 算出正交基。每帧调用一次，之后 project 只做点积，
     比每次重新算 cross 快得多。 */
  function basis(c) {
    const f = norm(sub(c.look, c.pos));
    /* 手性推导（别凭直觉改这三行，反了就是左右颠倒且上下颠倒）：
       世界 x 右、y 下、z 前（远离相机），屏幕 x 右、y 下。
       理想基：f=[0,0,1] 时 r=[1,0,0]、u=[0,1,0]。
         r = f × worldUp，worldUp 取 [0,-1,0]（世界上方）→ [1,0,0] ✓
         u = f × r → [0,1,0] ✓
       c.roll 绕视线旋转 r/u。 */
    let r = cross(f, [0, -1, 0]);
    if (Math.hypot(r[0], r[1], r[2]) < 1e-6) r = [1, 0, 0];  // 正上/正下看：退化
    r = norm(r);
    let u = norm(cross(f, r));
    if (c.roll) {
      const ca = Math.cos(c.roll), sa = Math.sin(c.roll);
      const r2 = [r[0] * ca - u[0] * sa, r[1] * ca - u[1] * sa, r[2] * ca - u[2] * sa];
      const u2 = [u[0] * ca + r[0] * sa, u[1] * ca + r[1] * sa, u[2] * ca + r[2] * sa];
      r = r2; u = u2;
    }
    c._f = f; c._r = r; c._u = u;
    c._foc = (c.h / 2) / Math.tan((c.fov * Math.PI / 180) / 2);
    c._cx = c.w / 2; c._cy = c.h / 2;
    return c;
  }

  /* 原地改相机（改完自动重算基） */
  function set(c, o) {
    if (o.pos) c.pos = o.pos.slice();
    if (o.look) c.look = o.look.slice();
    if (o.fov != null) c.fov = o.fov;
    if (o.roll != null) c.roll = o.roll;
    if (o.w != null) c.w = o.w;
    if (o.h != null) c.h = o.h;
    return basis(c);
  }

  /* 两机位之间插值。look 也插值 —— 只插 pos 会让镜头「绕着看」，
     像甩头；一起插才是「推过去」。 */
  function lerpCam(a, b, k, out) {
    const o = out || cam({ w: a.w, h: a.h });
    o.pos = [lerp(a.pos[0], b.pos[0], k), lerp(a.pos[1], b.pos[1], k), lerp(a.pos[2], b.pos[2], k)];
    o.look = [lerp(a.look[0], b.look[0], k), lerp(a.look[1], b.look[1], k), lerp(a.look[2], b.look[2], k)];
    o.fov = lerp(a.fov, b.fov, k);
    o.roll = lerp(a.roll, b.roll, k);
    o.w = a.w; o.h = a.h; o.near = a.near;
    return basis(o);
  }

  /* ── 投影 ────────────────────────────────────────────────────────
     返回 { x, y, z, s, vis }：
       x,y  屏幕像素坐标（可能画布外）
       z    相机空间深度（用来排序、算雾）
       s    「1 世界单位 = 多少像素」的比例，物体用它自己缩放
       vis  z 是否在近裁剪面之前 */
  function project(c, p) {
    const dx = p[0] - c.pos[0], dy = p[1] - c.pos[1], dz = p[2] - c.pos[2];
    const z = dx * c._f[0] + dy * c._f[1] + dz * c._f[2];
    if (z <= c.near) return { x: 0, y: 0, z, s: 0, vis: false };
    const rx = dx * c._r[0] + dy * c._r[1] + dz * c._r[2];
    const uy = dx * c._u[0] + dy * c._u[1] + dz * c._u[2];
    const inv = c._foc / z;
    return {
      x: c._cx + rx * inv,
      y: c._cy + uy * inv,
      z,
      s: inv,           // 该处 1 单位 = s 像素
      vis: true,
    };
  }

  /* 世界单位 → 屏幕像素的缩放比（给 lineWidth、字号用） */
  function sizeAt(c, p) {
    const q = project(c, p);
    return q.vis ? q.s : 0;
  }

  /* 按深度从远到近排序（远的先画，近的盖住远的）。
     拷贝一份再排，不改调用方的数组。 */
  function sort(c, items) {
    const arr = items.map((it) => {
      const dx = it.p[0] - c.pos[0], dy = it.p[1] - c.pos[1], dz = it.p[2] - c.pos[2];
      const z = dx * c._f[0] + dy * c._f[1] + dz * c._f[2];
      return { it, z };
    });
    arr.sort((a, b) => b.z - a.z);
    return arr;
  }

  /* 雾：near 之前 0，far 之后满。用于「远处淡进背景色」，
     是伪造深度的最便宜也最有效的一招。 */
  function fog(c, z, o) {
    o = o || {};
    const near = o.near == null ? 1200 : o.near;
    const far = o.far == null ? 4200 : o.far;
    const max = o.max == null ? 0.82 : o.max;
    return clamp((z - near) / (far - near), 0, 1) * max;
  }

  /* 把一组物体画到画布上：排序 + 投影 + 调 draw 回调。
     draw(g, q) 里 q = {x, y, s, z, alpha, fog}，
     alpha 已按雾衰减，直接用即可。 */
  function draw(g, c, items, o) {
    o = o || {};
    const sorted = sort(c, items);
    for (let i = 0; i < sorted.length; i++) {
      const { it, z } = sorted[i];
      const q = project(c, it.p);
      if (!q.vis) continue;
      const fg = fog(c, z, o);
      const alpha = (it.alpha == null ? 1 : it.alpha) * (1 - fg);
      if (alpha <= 0.004) continue;
      g.save();
      /* 物体是「平面片」：平移过去、按距离缩放，回调在本地坐标画。
         s = 1 时 1 单位 = 1 像素（在 z = foc 的参考面上）。 */
      g.translate(q.x, q.y);
      g.globalAlpha *= alpha;
      if (o.fogColor) {
        /* 雾色叠加：远处物体往背景色里沉，比单纯透明更像空气 */
        g.globalAlpha *= 1;
      }
      it.draw(g, { x: q.x, y: q.y, s: q.s, z, alpha, fog: fg });
      g.restore();
    }
  }

  /* ── 布局辅助 ────────────────────────────────────────────────────
     摆物体最费事的不是画，是算坐标。这几个函数把常见排布一次算好。 */

  /* 一排：沿 z 轴排开（镜头穿过去的「走廊」） */
  function rowZ(n, z0, zStep, y) {
    const out = [];
    for (let i = 0; i < n; i++) out.push([0, y || 0, z0 + i * zStep]);
    return out;
  }

  /* 环形：绕 y 轴一圈（祭坛、传送门阵列、细胞器） */
  function ring(n, radius, y, phase) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + (phase || 0);
      out.push([Math.cos(a) * radius, y || 0, Math.sin(a) * radius]);
    }
    return out;
  }

  /* 立面网格：xy 平面上一片（数据卡片阵列、砖墙、书架） */
  function grid(nx, ny, w, h, z, gap) {
    const out = [];
    const gw = gap == null ? w * 1.12 : gap;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        out.push([(i - (nx - 1) / 2) * gw, (j - (ny - 1) / 2) * gw, (z || 0) + (j % 2 ? gw * 0.12 : 0)]);
      }
    }
    return out;
  }

  /* 螺旋：绕 y 轴上升（分子结构、螺旋楼梯） */
  function helix(n, radius, yStep, turns, phase) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU * turns + (phase || 0);
      out.push([Math.cos(a) * radius, (i - n / 2) * yStep, Math.sin(a) * radius]);
    }
    return out;
  }

  /* ── 相机轨道 ────────────────────────────────────────────────────
     给「环绕」「从上方俯冲到侧面」这类运动一个不用手算坐标的写法。 */
  function orbit(target, radius, y, angle, fov) {
    return {
      pos: [target[0] + Math.cos(angle) * radius, target[1] + (y || 0), target[2] + Math.sin(angle) * radius],
      look: target.slice(),
      fov,
    };
  }

  /* 关键帧相机：[[t0, camA], [t1, camB], ...] → 任意时刻的相机。
     用在「一个世界、一条镜头轨迹」的片子里：镜头表只写几个机位，
     中间由这里插值。 */
  function track(keys, t, ease) {
    if (!keys.length) throw new Error('SP.track: 至少一个机位');
    const e = ease || ((x) => x * x * (3 - 2 * x));
    if (t <= keys[0][0]) return keys[0][1];
    const last = keys[keys.length - 1];
    if (t >= last[0]) return last[1];
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i], b = keys[i + 1];
      if (t >= a[0] && t < b[0]) {
        const k = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
        return lerpCam(a[1], b[1], e(k));
      }
    }
    return last[1];
  }

  /* 让相机保持看向一个运动中的点（跟拍）。
     返回新 pos：在「离目标保持 dist 距离、方向为 dir」的位置。 */
  function follow(target, dir, dist) {
    const d = norm(dir);
    return [target[0] - d[0] * dist, target[1] - d[1] * dist, target[2] - d[2] * dist];
  }

  const SP = {
    cam, set, basis, lerpCam, project, sizeAt, sort, fog, draw,
    rowZ, ring, grid, helix, orbit, track, follow,
    sub, dot, cross, norm, lerp, clamp,
    TAU,
  };

  root.SP = SP;
  if (typeof module === 'object' && module.exports) module.exports = SP;
})(typeof globalThis !== 'undefined' ? globalThis : this);
