/**
 * light.js —— 光照、色温与大气（v2.0）
 *
 * ┌ 为什么需要它 ──────────────────────────────────────────────────
 * │ 「配色」和「光」不是一回事。同一组颜色，正午的硬光和黄昏的斜光
 * │ 完全是两支片。之前我们只有渐变背景 + 半透明遮罩，做不出
 * │ 「窗外从黄昏变到夜里，再亮起来」这种时间流逝。
 * │
 * │ 这一层给四样东西：
 * │   1. 色温（黑体辐射近似）—— 「暖」和「冷」可以算，不用手挑色号
 * │   2. 昼夜关键帧 —— 一句 daylight(t) 拿到整组环境光
 * │   3. 径向光 / 光束 —— 体积光的 2D 近似，便宜且够像
 * │   4. 全屏调色 + 暗角 + 泛光 —— 把画面「统一」成一种光
 * └──────────────────────────────────────────────────────────────
 *
 * 用法：
 *   <script src="../lib/light.js"></script>
 *   const L = LT.sky(LT.timeline([[0,'dusk'],[0.6,'night'],[1,'dawn']], T));
 *   LT.grade(g, W, H, L);            // 全屏统一色温
 *   LT.radial(g, {x:W*0.8, y:H*0.2, r:W*0.5, color:'#ffd9a0', i:0.5});
 *   LT.vignette(g, W, H, {amount:0.45});
 */
(function (root) {
  'use strict';

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /* ── 色温 ────────────────────────────────────────────────────────
     Tanner Helland 的黑体辐射近似：输入开尔文，输出 RGB。
     1900K 烛光橙，2700K 白炽灯暖，5600K 日光，9000K 阴天冷蓝。 */
  function kelvin(K) {
    const T = clamp(K, 1000, 40000) / 100;
    let r, g, b;
    if (T <= 66) {
      r = 255;
      g = 99.4708025861 * Math.log(T) - 161.1195681661;
    } else {
      r = 329.698727446 * Math.pow(T - 60, -0.1332047592);
      g = 288.1221695283 * Math.pow(T - 60, -0.0755148492);
    }
    if (T >= 66) b = 255;
    else if (T <= 19) b = 0;
    else b = 138.5177312231 * Math.log(T - 10) - 305.0447927307;
    return [clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255)];
  }

  /* ── 昼夜预设 ────────────────────────────────────────────────────
     每个预设是「环境光 + 主光」两组颜色加两个强度。
     ambient 是阴影里的颜色（决定画面「底子」），sun 是受光面的颜色。
     这两个必须分开：只调一个会变成「加滤镜」，不是「换时间」。 */
  const SKY = {
    night: { ambient: [16, 22, 46], sun: [90, 120, 200], ambI: 0.34, sunI: 0.30, K: 9500, note: '深夜' },
    dawn: { ambient: [58, 52, 78], sun: [255, 178, 138], ambI: 0.52, sunI: 0.62, K: 3600, note: '黎明' },
    noon: { ambient: [188, 204, 226], sun: [255, 252, 244], ambI: 0.86, sunI: 1.00, K: 5600, note: '正午' },
    golden: { ambient: [92, 60, 56], sun: [255, 190, 116], ambI: 0.62, sunI: 1.00, K: 2200, note: '日落' },
    dusk: { ambient: [64, 44, 58], sun: [255, 146, 82], ambI: 0.48, sunI: 0.86, K: 2700, note: '黄昏' },
    overcast: { ambient: [148, 158, 172], sun: [206, 214, 224], ambI: 0.78, sunI: 0.56, K: 7200, note: '阴天' },
    candle: { ambient: [42, 26, 18], sun: [255, 176, 92], ambI: 0.30, sunI: 0.72, K: 1900, note: '烛光' },
  };

  /* 任意 t 的昼夜循环：0=深夜 → 0.25 黎明 → 0.5 正午 → 0.75 黄昏 → 1=深夜 */
  const CYCLE = [
    [0.00, 'night'], [0.18, 'dawn'], [0.42, 'noon'],
    [0.68, 'dusk'], [0.86, 'night'], [1.00, 'night'],
  ];

  function mixSky(a, b, k) {
    return {
      ambient: [lerp(a.ambient[0], b.ambient[0], k), lerp(a.ambient[1], b.ambient[1], k), lerp(a.ambient[2], b.ambient[2], k)],
      sun: [lerp(a.sun[0], b.sun[0], k), lerp(a.sun[1], b.sun[1], k), lerp(a.sun[2], b.sun[2], k)],
      ambI: lerp(a.ambI, b.ambI, k),
      sunI: lerp(a.sunI, b.sunI, k),
      K: lerp(a.K, b.K, k),
      note: k < 0.5 ? a.note : b.note,
    };
  }

  /* 关键帧插值：keys 可以是 [[t, 'dusk'], ...] 或 [[t, {…}], ...] */
  function timeline(keys, t) {
    if (!keys || !keys.length) return SKY.noon;
    const get = (v) => (typeof v === 'string' ? (SKY[v] || SKY.noon) : v);
    if (t <= keys[0][0]) return get(keys[0][1]);
    const last = keys[keys.length - 1];
    if (t >= last[0]) return get(last[1]);
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i], b = keys[i + 1];
      if (t >= a[0] && t < b[0]) {
        const k = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
        /* 用 smoothstep 而不是线性：光的变化从来不是匀速的，
           太阳落下最后一段会快，线性插值会显得假。 */
        const e = k * k * (3 - 2 * k);
        return mixSky(get(a[1]), get(b[1]), e);
      }
    }
    return get(last[1]);
  }

  function sky(t) {
    const x = ((t % 1) + 1) % 1;
    return timeline(CYCLE, x);
  }

  /* ── 绘制原语 ──────────────────────────────────────────────────── */

  function rgba(c, a) {
    if (typeof c === 'string') return c;
    return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a == null ? 1 : a})`;
  }

  /* 径向光：中心亮、边缘散。inner 控制「核心」大小（0~1），
     越大越像聚光灯，越小越像弥漫的天光。 */
  function radial(g, o) {
    const x = o.x, y = o.y, r = o.r;
    const i = o.i == null ? 0.5 : o.i;
    if (i <= 0 || r <= 0) return;
    const gr = g.createRadialGradient(x, y, Math.max(0.01, r * (o.inner == null ? 0.05 : o.inner)), x, y, r);
    const col = o.color || [255, 240, 210];
    gr.addColorStop(0, rgba(col, i));
    gr.addColorStop(0.55, rgba(col, i * 0.42));
    gr.addColorStop(1, rgba(col, 0));
    g.save();
    g.globalCompositeOperation = o.mode || 'lighter';
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
    g.restore();
  }

  /* 光束（体积光的 2D 近似）：从一点向一个方向张开的锥形。
     用一个梯形 + 沿长度的渐变。看着廉价但动了之后很像那么回事。 */
  function shaft(g, o) {
    const x = o.x, y = o.y;
    const len = o.len == null ? 700 : o.len;
    const a = o.angle == null ? Math.PI / 2 : o.angle;   // 默认朝下
    const spread = o.spread == null ? 0.28 : o.spread;   // 张开角（弧度）
    const w0 = o.w0 == null ? 24 : o.w0;
    const i = o.i == null ? 0.28 : o.i;
    if (i <= 0) return;

    g.save();
    g.translate(x, y);
    g.rotate(a);
    const gr = g.createLinearGradient(0, 0, len, 0);
    const col = o.color || [255, 240, 210];
    gr.addColorStop(0, rgba(col, i));
    gr.addColorStop(0.35, rgba(col, i * 0.58));
    gr.addColorStop(1, rgba(col, 0));
    g.fillStyle = gr;
    g.globalCompositeOperation = o.mode || 'lighter';
    g.beginPath();
    g.moveTo(0, -w0 / 2);
    g.lineTo(len, -len * Math.tan(spread) - w0 * 0.2);
    g.lineTo(len, len * Math.tan(spread) + w0 * 0.2);
    g.lineTo(0, w0 / 2);
    g.closePath();
    g.fill();
    g.restore();
  }

  /* 全屏调色：把画面往一种色温上推。
     mode 默认 'overlay' —— 它保留明暗，只改色相，
     比 'multiply'（整体变暗）或 'screen'（整体发白）更像真正的光。 */
  function grade(g, W, H, L, o) {
    o = o || {};
    if (!L) return;
    const amb = L.ambient;
    const a = o.alpha == null ? 0.30 : o.alpha;
    g.save();
    g.globalCompositeOperation = o.mode || 'overlay';
    g.fillStyle = rgba(amb, a * (o.ambMul == null ? 1 : o.ambMul));
    g.fillRect(0, 0, W, H);
    /* 主光的高光：往受光色偏一点，让「亮的地方更暖/更冷」，
       而不是整幅一起偏色。这是模拟光而不是加滤镜的关键。 */
    if (o.sunHi !== false) {
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = rgba(L.sun, 0.020 + 0.030 * L.sunI);
      g.fillRect(0, 0, W, H);
    }
    g.restore();
  }

  /* 暗角：四角压暗。amount 0~1，0.5 已经很重。
     摄影里几乎所有镜头都有暗角，没有它画面会显得「平」。 */
  function vignette(g, W, H, o) {
    o = o || {};
    const amt = o.amount == null ? 0.38 : o.amount;
    if (amt <= 0) return;
    const gr = g.createRadialGradient(
      W * (o.cx == null ? 0.5 : o.cx), H * (o.cy == null ? 0.5 : o.cy), Math.min(W, H) * 0.28,
      W * 0.5, H * 0.5, Math.hypot(W, H) * 0.62,
    );
    gr.addColorStop(0, 'rgba(0,0,0,0)');
    gr.addColorStop(1, rgba(o.color || [0, 0, 0], amt));
    g.save();
    g.globalCompositeOperation = o.mode || 'source-over';
    g.fillStyle = gr;
    g.fillRect(0, 0, W, H);
    g.restore();
  }

  /* 泛光：把画面亮部模糊一遍叠回去。要一张离屏画布做中转。
     成本：一次全屏 blur，1080p 约 8~14ms/帧。只在「要有光」时才用。 */
  function bloom(g, W, H, o) {
    o = o || {};
    if (typeof document === 'undefined') return;
    if (!bloom._c) bloom._c = document.createElement('canvas');
    const c = bloom._c;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const cg = c.getContext('2d');
    cg.setTransform(1, 0, 0, 1, 0, 0);
    cg.clearRect(0, 0, W, H);
    /* 阈值：只留亮部。用 'lighter' 叠两次 + 一半 alpha，
       比逐像素阈值便宜得多，效果够。 */
    cg.drawImage(g.canvas, 0, 0);
    cg.globalCompositeOperation = 'multiply';
    cg.fillStyle = 'rgba(110,110,110,1)';
    cg.fillRect(0, 0, W, H);
    cg.globalCompositeOperation = 'source-over';

    g.save();
    g.globalCompositeOperation = o.mode || 'lighter';
    g.globalAlpha = o.alpha == null ? 0.55 : o.alpha;
    if (typeof g.filter === 'string') g.filter = `blur(${o.radius == null ? 18 : o.radius}px)`;
    g.drawImage(c, 0, 0);
    g.filter = 'none';
    g.restore();
  }

  /* 闪白 / 闪色：转场点、快门、爆炸。 */
  function flash(g, W, H, color, a) {
    if (a <= 0) return;
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = rgba(color || [255, 255, 255], a);
    g.fillRect(0, 0, W, H);
    g.restore();
  }

  /* 全局曝光：整幅乘一个亮度。夜戏压到 0.85，太阳直射抬到 1.1。 */
  function exposure(g, W, H, v) {
    if (!v || Math.abs(v - 1) < 0.005) return;
    g.save();
    if (v > 1) {
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = `rgba(255,255,255,${(v - 1) * 0.55})`;
    } else {
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = `rgba(0,0,0,${(1 - v) * 0.85})`;
    }
    g.fillRect(0, 0, W, H);
    g.restore();
  }

  /* 把一组光照一次性套到画布上（背景 → 主体 → 收尾）。
     顺序很重要：暗角在调色之后，泛光在暗角之前 —— 反了会把暗角也糊亮。 */
  function finish(g, W, H, L, o) {
    o = o || {};
    if (L) {
      grade(g, W, H, L, o.grade);
      exposure(g, W, H, L.exposure == null ? (0.72 + 0.34 * L.ambI) : L.exposure);
    }
    if (o.bloom) bloom(g, W, H, o.bloom);
    if (o.vignette !== 0) vignette(g, W, H, o.vignette);
  }

  const LT = {
    kelvin, SKY, CYCLE, sky, timeline, mixSky,
    radial, shaft, grade, vignette, bloom, flash, exposure, finish, rgba,
    lerp, clamp,
  };

  root.LT = LT;
  if (typeof module === 'object' && module.exports) module.exports = LT;
})(typeof globalThis !== 'undefined' ? globalThis : this);
