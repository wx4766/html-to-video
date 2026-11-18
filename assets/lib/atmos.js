/**
 * atmos.js —— 大气与后期（v2.1）
 *
 * ┌ 为什么单独一层 ────────────────────────────────────────────────
 * │ 几何对了、光对了，画面还是「干净得像模型展示」。
 * │ 真实画面里，光在空气里走：近处有雾、远处发光、镜头有颗粒、
 * │ 强光会在镜片上晕开。这些都不是几何，是**介质**。
 * │
 * │ 这一层全是 2D 合成操作，比在 3D 里做便宜两个数量级：
 * │   sky      多段渐变天空（地平线暖、天顶冷）
 * │   haze     贴地雾带，把远景「按距离」吃掉
 * │   beam     体积光束（分层梯形 + additive）
 * │   glow     点光源辉光
 * │   grain    胶片颗粒（预生成噪声贴图，不每帧随机）
 * │   water    水面高光带 + 倒影
 * │   dust     浮尘 / 雪 / 萤火
 * └──────────────────────────────────────────────────────────────
 *
 * 用法：
 *   AT.sky(g, W, H, { horizon: 0.62, stops: [[0,'#101828'],[1,'#d0844b']] });
 *   AT.beam(g, { x, y, angle: -0.2, spread: 0.16, len: 1200, color:'#ffe6b0', i:0.5 });
 */
(function (root) {
  'use strict';

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const TAU = Math.PI * 2;

  /* 把 '#rrggbb' 或 [r,g,b] 统一成 [r,g,b] */
  function rgb(c) {
    if (Array.isArray(c)) return c;
    if (typeof c === 'string' && c[0] === '#') {
      return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
    }
    return [255, 255, 255];
  }
  function rgba(c, a) {
    const v = rgb(c);
    return 'rgba(' + (v[0] | 0) + ',' + (v[1] | 0) + ',' + (v[2] | 0) + ',' + a + ')';
  }

  /* ── 天空 ────────────────────────────────────────────────────────
     horizon 是地平线在画面里的比例（0 顶 1 底）。
     stops 从 0（天顶）到 1（地平线），超出地平线的部分用最后一色平涂。 */
  function sky(g, W, H, o) {
    o = o || {};
    const hz = (o.horizon == null ? 0.6 : o.horizon) * H;
    const stops = o.stops || [[0, '#0d1424'], [0.55, '#3b3a52'], [1, '#c8794a']];
    const gd = g.createLinearGradient(0, 0, 0, hz);
    for (const [p, c] of stops) gd.addColorStop(clamp(p, 0, 1), c);
    g.fillStyle = gd;
    g.fillRect(0, 0, W, hz);
    /* 地平线以下是「远处地面」，给一个暗底，之后由地形/海面盖住 */
    g.fillStyle = o.below || stops[stops.length - 1][1];
    g.fillRect(0, hz, W, H - hz);
    /* 地平线光带：太阳落下去的位置，最亮的一条 */
    if (o.band) {
      /* 注意：这里必须用椭圆渐变，不能用 fillRect + 径向渐变 ——
         矩形填充会在左右两端留下一条硬边，看起来像贴了一条色带。 */
      const bw = o.bandW == null ? W * 0.34 : o.bandW;
      const bh = o.bandH == null ? H * 0.16 : o.bandH;
      const bx = o.bandX == null ? W * 0.5 : o.bandX;
      g.save();
      g.beginPath();
      g.rect(0, 0, W, hz);
      g.clip();
      g.translate(bx, hz);
      g.scale(1, bh / bw);
      const rg = g.createRadialGradient(0, 0, 0, 0, 0, bw);
      rg.addColorStop(0, rgba(o.band, o.bandI == null ? 0.8 : o.bandI));
      rg.addColorStop(0.35, rgba(o.band, 0.30));
      rg.addColorStop(0.72, rgba(o.band, 0.06));
      rg.addColorStop(1, rgba(o.band, 0));
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = rg;
      g.beginPath();
      g.arc(0, 0, bw, 0, TAU);
      g.fill();
      g.restore();
    }
  }

  /* ── 贴地雾 ──────────────────────────────────────────────────────
     from 到 to 是雾最浓的高度区间。用三条不同频率的横向噪声边，
     让雾的上边缘不是一条直线（直线一眼假）。 */
  function haze(g, W, H, o) {
    o = o || {};
    const y0 = (o.y == null ? 0.55 : o.y) * H;
    const h = (o.h == null ? 0.30 : o.h) * H;
    const col = o.color || '#2a2436';
    const i = o.i == null ? 0.55 : o.i;
    const gd = g.createLinearGradient(0, y0, 0, y0 + h);
    gd.addColorStop(0, rgba(col, 0));
    gd.addColorStop(0.45, rgba(col, i * 0.55));
    gd.addColorStop(1, rgba(col, i));
    g.fillStyle = gd;
    g.fillRect(0, y0, W, h);
    /* 顶部揉边：几个半透明椭圆把边界打毛 */
    g.save();
    const n = o.n == null ? 7 : o.n;
    for (let k = 0; k < n; k++) {
      const cx = ((k + 0.5) / n) * W + Math.sin(k * 7.3 + (o.seed || 1)) * W * 0.06;
      const cy = y0 + Math.sin(k * 3.1 + (o.seed || 1) * 2) * h * 0.10;
      const rr = W * (0.10 + 0.05 * Math.sin(k * 5.1));
      const rg = g.createRadialGradient(cx, cy, 0, cx, cy, rr);
      rg.addColorStop(0, rgba(col, i * 0.30));
      rg.addColorStop(1, rgba(col, 0));
      g.fillStyle = rg;
      g.beginPath();
      g.arc(cx, cy, rr, 0, TAU);
      g.fill();
    }
    g.restore();
  }

  /* ── 体积光束 ────────────────────────────────────────────────────
     从 (x,y) 出发，沿 angle 方向射出 len 长，起点半宽 w0、终点半宽 w1。
     分 layers 层叠加（每层更宽更淡），合起来就是「光在雾里」的软边。
     i 是强度，color 建议暖白。 */
  function beam(g, o) {
    const x = o.x, y = o.y;
    const ang = o.angle == null ? 0 : o.angle;
    const len = o.len == null ? 900 : o.len;
    const w0 = o.w0 == null ? 6 : o.w0;
    const w1 = o.w1 == null ? len * 0.22 : o.w1;
    const spread = o.spread == null ? 0.26 : o.spread;
    const rays = o.rays == null ? 54 : o.rays;
    const col = o.color || '#ffe3b0';
    const i = o.i == null ? 0.4 : o.i;
    g.save();
    g.globalCompositeOperation = 'lighter';
    /* 光束 = 一堆细射线，不是几层梯形。
       梯形叠加会在每层边界留下一条竖线（层数越少越明显），
       细射线则是「密集到看不出个体」，边缘靠 cos 衰减自然消失。 */
    for (let k = 0; k < rays; k++) {
      const t = ((k + 0.5) / rays) * 2 - 1;              // -1 … 1
      const fall = Math.pow(Math.cos(t * Math.PI * 0.5), 1.7);  // 中亮边暗
      if (fall < 0.015) continue;
      const a = ang + t * spread;
      const L = len * (0.60 + 0.40 * fall);              // 中间长、两边短
      const hw0 = Math.max(0.5, w0 * 0.5);
      /* 横向重叠要足够：hw1 若只比「射线间距」略大，相邻射线之间就是一条
         硬边界，几十条并排铺开就是一层可数的斜向条纹（在暗天空上尤其脏）。
         做成 ~2.5 倍重叠、单条 alpha 降下来，加起来才是连续的一束光。 */
      const hw1 = Math.max(0.8, (w1 / rays) * 5.4 * (0.55 + 0.45 * fall));
      const dx = Math.cos(a), dy = Math.sin(a);
      const nx = -dy, ny = dx;
      const gd = g.createLinearGradient(x, y, x + dx * L, y + dy * L);
      gd.addColorStop(0, rgba(col, i * fall * 0.135));
      gd.addColorStop(0.35, rgba(col, i * fall * 0.088));
      gd.addColorStop(0.72, rgba(col, i * fall * 0.028));
      gd.addColorStop(1, rgba(col, 0));
      g.fillStyle = gd;
      g.beginPath();
      g.moveTo(x + nx * hw0, y + ny * hw0);
      g.lineTo(x - nx * hw0, y - ny * hw0);
      g.lineTo(x + dx * L - nx * hw1, y + dy * L - ny * hw1);
      g.lineTo(x + dx * L + nx * hw1, y + dy * L + ny * hw1);
      g.closePath();
      g.fill();
    }
    g.restore();
  }

  /* ── 点光源辉光 ──────────────────────────────────────────────────
     四层半径叠加，比单层 radialGradient 更像真实镜头光晕
     （内核实、中层亮、外圈淡）。 */
  function glow(g, o) {
    const x = o.x, y = o.y;
    const r = o.r == null ? 120 : o.r;
    const col = o.color || '#ffd9a0';
    const i = o.i == null ? 0.6 : o.i;
    g.save();
    g.globalCompositeOperation = 'lighter';
    const rings = o.rings == null ? 4 : o.rings;
    for (let k = 0; k < rings; k++) {
      const t = k / Math.max(1, rings - 1);
      const rr = r * (0.18 + t * 0.95);
      const a = i * (1 - t * 0.78) * 0.55;
      const rg = g.createRadialGradient(x, y, 0, x, y, rr);
      rg.addColorStop(0, rgba(col, a));
      rg.addColorStop(0.45, rgba(col, a * 0.45));
      rg.addColorStop(1, rgba(col, 0));
      g.fillStyle = rg;
      g.beginPath();
      g.arc(x, y, rr, 0, TAU);
      g.fill();
    }
    g.restore();
  }

  /* ── 星芒 ────────────────────────────────────────────────────────
     强光源在镜头里的十字/米字光芒。不是真实的物理光，是镜头光圈叶片
     的衍射 —— 但观众认它，有它才像「拍到的光」，没它就是「画的光」。 */
  function flare(g, o) {
    const x = o.x, y = o.y;
    const len = o.len == null ? 140 : o.len;
    const col = o.color || '#fff3d0';
    const i = o.i == null ? 0.5 : o.i;
    g.save();
    g.globalCompositeOperation = 'lighter';
    const arms = [[0, 1], [Math.PI / 2, 1], [Math.PI / 4, 0.42], [-Math.PI / 4, 0.42]];
    for (const [ang, w] of arms) {
      const L = len * w;
      const a = i * (w > 0.5 ? 0.75 : 0.30);
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const gd = g.createLinearGradient(x - ca * L, y - sa * L, x + ca * L, y + sa * L);
      gd.addColorStop(0, rgba(col, 0));
      gd.addColorStop(0.5, rgba(col, a));
      gd.addColorStop(1, rgba(col, 0));
      g.strokeStyle = gd;
      g.lineWidth = 1.7;
      g.beginPath();
      g.moveTo(x - ca * L, y - sa * L);
      g.lineTo(x + ca * L, y + sa * L);
      g.stroke();
    }
    /* 一圈极淡的光环：镜片内部的反射 */
    if (o.ring !== false) {
      g.strokeStyle = rgba(col, i * 0.10);
      g.lineWidth = 1.2;
      g.beginPath();
      g.arc(x, y, len * 0.62, 0, TAU);
      g.stroke();
    }
    g.restore();
  }

  /* ── 胶片颗粒 ────────────────────────────────────────────────────
     预生成一张 256×256 噪声图做 pattern，每帧只改 translate 偏移。
     每帧现画噪声 = 6.5 万次 fillRect，一条 20 秒的片子要 20 分钟。 */
  let _grainTile = null, _grainKey = '';
  function grain(g, W, H, o) {
    o = o || {};
    const i = o.i == null ? 0.06 : o.i;
    if (i <= 0) return;
    if (!_grainTile || _grainKey !== 'v2') {
      _grainTile = document.createElement('canvas');
      _grainTile.width = _grainTile.height = 256;
      const gc = _grainTile.getContext('2d');
      const img = gc.createImageData(256, 256);
      /* xorshift32：原来的 LCG（*1103515245 & 0x7fffffff 再取高位）
         低阶相关太强，铺满全屏后能看出一层斜向细纹 —— 在纯色天空上
         尤其明显，像有人拿纱窗挡在镜头前。噪声必须是「看不出结构」的。 */
      let s = 0x9e3779b9;
      for (let p = 0; p < img.data.length; p += 4) {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        const v = 128 + ((s & 0xff) - 128) * 0.42;
        img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
        img.data[p + 3] = 255;
      }
      gc.putImageData(img, 0, 0);
      _grainKey = 'v2';
    }
    const pat = g.createPattern(_grainTile, 'repeat');
    if (!pat) return;
    const ox = (o.t || 0) * 37 % 256, oy = (o.t || 0) * 61 % 256;
    g.save();
    if (pat.setTransform && typeof DOMMatrix !== 'undefined') {
      pat.setTransform(new DOMMatrix().translate(ox, oy));
    }
    g.globalCompositeOperation = 'overlay';
    g.globalAlpha = i;
    g.fillStyle = pat;
    g.fillRect(0, 0, W, H);
    /* 抖动（dither）：暗部的大面积渐变在 8 位色深下一定会出台阶 ——
       天空、暗角、雾都是同心弧或横带，一条一条能数出来。
       'overlay' 在暗部是乘法，几乎没作用；所以再补一遍 'lighter' 的
       极低幅度加性噪声，只要 ±1~2 个色阶就足以把台阶打碎。
       dither: 0 关掉（矢量/图形类片子别要这个）。 */
    const dA = i * (o.dither == null ? 0.30 : o.dither);
    if (dA > 0) {
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = dA;
      g.fillRect(0, 0, W, H);
    }
    g.restore();
  }

  /* 倒影柱的小画布：只建一次，每帧清空重用。
     用离屏是为了「缩放着贴回去」——重采样能吃掉细条之间的接缝。 */
  let _refl = null;
  function reflCanvas() {
    if (typeof document === 'undefined') return null;
    if (!_refl) { _refl = document.createElement('canvas'); _refl.width = 192; _refl.height = 96; }
    return _refl;
  }

  /* ── 水面 ────────────────────────────────────────────────────────
     水面不是画出来的，是「反射 + 高光带」：
       · 一条横向镜面高光（太阳/月亮在水里的倒影柱）
       · 若干条随 t 摆动的水平亮线（波纹）
     波纹线要短、密度随距离增，否则像斑马线。 */
  function water(g, W, H, y, o) {
    o = o || {};
    const t = o.t || 0;
    const col = o.color || '#ffb072';
    const i = o.i == null ? 0.5 : o.i;
    const cx = o.x == null ? W * 0.5 : o.x;
    const depth = H - y;
    g.save();
    /* 底色：近处深、远处亮（远处反射天空） */
    const gd0 = g.createLinearGradient(0, y, 0, H);
    gd0.addColorStop(0, o.topColor || 'rgba(58,42,44,0.85)');
    gd0.addColorStop(0.35, o.midColor || 'rgba(26,26,38,0.92)');
    gd0.addColorStop(1, o.deepColor || 'rgba(10,12,20,1)');
    g.fillStyle = gd0;
    g.fillRect(0, y, W, depth);

    g.globalCompositeOperation = 'lighter';
    /* 倒影柱：一条光柱落在起伏的水上，是「上窄下宽、边缘发虚、被波纹切开」
       的一片，不是一根矩形。
       先画在 192×96 的小画布上，再整块贴回水面 —— 为什么不在主画布直接画：
       细条用 'lighter' 叠时，相邻两条的接缝会一明一暗，放大看就是一排竖细线。
       192 缩到画面里约 80 宽，重采样正好把接缝平均掉。
       （硬边、接缝、等距斜纹，本质是同一类错：眼睛能「数」出来。） */
    const wTop = W * 0.0055;
    const wBot = W * 0.021;
    const RC = reflCanvas();
    if (RC && depth > 2) {
      const rw = RC.width, rh = RC.height;
      const cg = RC.getContext('2d');
      cg.setTransform(1, 0, 0, 1, 0, 0);
      cg.clearRect(0, 0, rw, rh);
      cg.globalCompositeOperation = 'lighter';
      const halfT = (wTop / wBot) * rw * 0.5;
      const halfB = rw * 0.5;
      const STRIPS = 36;
      const dwS = (halfT * 2) / STRIPS;
      for (let s = 0; s < STRIPS; s++) {
        const u = ((s + 0.5) / STRIPS) * 2 - 1;          // -1 … 1
        const bell = Math.pow(1 - u * u, 1.5);           // 中间实、两侧归零
        if (bell < 0.006) continue;
        const a = 0.72 * bell;
        /* 光柱随水波轻摆，越靠近观众摆得越开（近处水面更「活」） */
        const sway = Math.sin(t * 0.85 + u * 4.6) * rw * 0.035 * (0.35 + Math.abs(u));
        const xa = rw * 0.5 + u * halfT - dwS * 0.6;
        const xb = rw * 0.5 + u * halfB + sway - dwS * 2;
        const gd = cg.createLinearGradient(0, 0, 0, rh);
        gd.addColorStop(0, rgba(col, a));
        gd.addColorStop(0.30, rgba(col, a * 0.78));
        gd.addColorStop(0.66, rgba(col, a * 0.30));
        gd.addColorStop(1, rgba(col, 0));
        cg.fillStyle = gd;
        cg.beginPath();
        cg.moveTo(xa, 0); cg.lineTo(xa + dwS * 1.2, 0);
        cg.lineTo(xb + dwS * 4, rh); cg.lineTo(xb, rh);
        cg.closePath(); cg.fill();
      }
      /* 被水波切开：横向暗缝，越往近处越密。
         没有这几道缝，倒影就是一张塑料膜 —— 太干净反而是假的。 */
      cg.globalCompositeOperation = 'destination-out';
      for (let k = 0; k < 9; k++) {
        const h1 = Math.sin(k * 12.9898 + 3.7 + Math.floor(t * 1.5) * 0.31) * 43758.5453;
        const r1 = h1 - Math.floor(h1);
        const yy = rh * (0.10 + Math.pow(r1, 0.8) * 0.86);
        const hh = rh * (0.008 + r1 * 0.030);
        const ga = cg.createLinearGradient(0, yy - hh, 0, yy + hh);
        ga.addColorStop(0, 'rgba(0,0,0,0)');
        ga.addColorStop(0.5, 'rgba(0,0,0,' + (0.55 + r1 * 0.45).toFixed(3) + ')');
        ga.addColorStop(1, 'rgba(0,0,0,0)');
        cg.fillStyle = ga;
        cg.fillRect(0, yy - hh, rw, hh * 2);
      }
      /* 贴回：形状已经在画布里，外面是透明的，不用再裁 */
      g.globalAlpha = clamp(i, 0, 1) * 0.95;
      g.drawImage(RC, cx - wBot, y, wBot * 2, depth);
      g.globalAlpha = 1;
    }
    /* 波纹：每行若干短段，长度/位置都随机，密度随距离增。
       整行画满会变成「扫描线」，这是水面最典型的假。 */
    const rows = o.rows == null ? 42 : o.rows;
    for (let r = 0; r < rows; r++) {
      const v = r / rows;
      const yy = y + Math.pow(v, 1.9) * depth;
      const segs = 5 + Math.round(v * 9);
      const rowA = i * 0.42 * (1 - v * 0.82);
      for (let sIdx = 0; sIdx < segs; sIdx++) {
        const h1 = Math.sin(r * 12.9898 + sIdx * 78.233 + Math.floor(t * 2) * 0.7) * 43758.5453;
        const rnd = h1 - Math.floor(h1);
        const h2 = Math.sin(r * 4.1 + sIdx * 21.7 + Math.floor(t * 2) * 1.3) * 1234.5678;
        const rnd2 = h2 - Math.floor(h2);
        const half = W * (0.012 + v * 0.10) * (0.35 + rnd2 * 0.65);
        const xx = cx + (rnd - 0.5) * W * (0.5 + v * 1.3);
        const a = rowA * (0.35 + rnd2 * 0.65);
        g.fillStyle = rgba(col, a);
        g.fillRect(xx - half, yy, half * 2, Math.max(0.8, 1.5 - v));
      }
    }
    g.restore();
  }

  /* ── 星空 ────────────────────────────────────────────────────────
     星星不是随机亮点：亮度要按幂律分布（少数亮星、大量暗星），
     靠近地平线要淡出（大气消光），并且有极缓慢的闪烁。
     均匀随机会得到一片「电视雪花」，那是最假的一种夜空。 */
  function stars(g, W, H, o) {
    o = o || {};
    const hz = (o.horizon == null ? 0.55 : o.horizon) * H;
    const n = o.n == null ? 260 : o.n;
    const t = o.t || 0;
    const I = o.i == null ? 1 : o.i;
    if (I <= 0.01) return;
    g.save();
    for (let k = 0; k < n; k++) {
      const h1 = Math.sin(k * 12.9898 + 4.1) * 43758.5453;
      const r1 = h1 - Math.floor(h1);
      const h2 = Math.sin(k * 78.233 + 1.7) * 24634.6345;
      const r2 = h2 - Math.floor(h2);
      const h3 = Math.sin(k * 37.719 + 9.3) * 9871.234;
      const r3 = h3 - Math.floor(h3);
      const x = r1 * W * 1.02 - W * 0.01;
      const y = Math.pow(r2, 1.55) * hz * 0.95;
      /* 地平线消光 */
      const ext = clamp(1 - y / (hz * 0.95), 0, 1);
      const a = Math.pow(r3, 2.6) * 0.95 * ext * I;
      if (a < 0.02) continue;
      const tw = 0.82 + 0.18 * Math.sin(t * 1.6 + k * 2.3);
      const rr = a > 0.45 ? 1.5 : 0.9;
      g.fillStyle = 'rgba(226,236,255,' + (a * tw).toFixed(3) + ')';
      g.beginPath();
      g.arc(x, y, rr, 0, TAU);
      g.fill();
      /* 亮星带一圈十字光芒 —— 这是「夜空」和「噪点」的区别 */
      if (a > 0.5) {
        g.strokeStyle = 'rgba(210,226,255,' + (a * 0.22).toFixed(3) + ')';
        g.lineWidth = 0.8;
        g.beginPath();
        g.moveTo(x - 3.5, y); g.lineTo(x + 3.5, y);
        g.moveTo(x, y - 3.5); g.lineTo(x, y + 3.5);
        g.stroke();
      }
    }
    g.restore();
  }

  /* ── 浮尘 ────────────────────────────────────────────────────────
     粒子只在「有光的地方」可见，所以按与光源的距离给 alpha。 */
  function dust(g, W, H, o) {
    o = o || {};
    const n = o.n == null ? 90 : o.n;
    const t = o.t || 0;
    const col = o.color || '#ffe9c8';
    const i = o.i == null ? 0.5 : o.i;
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (let k = 0; k < n; k++) {
      const s = k * 12.9898;
      const px = (Math.sin(s) * 0.5 + 0.5) * W + Math.sin(t * 0.23 + k) * 26;
      const py = ((Math.cos(s * 1.7) * 0.5 + 0.5) * H + t * (6 + (k % 7) * 3)) % H;
      const rr = 0.6 + (k % 5) * 0.55;
      const a = i * (0.25 + 0.75 * (Math.sin(t * 1.7 + k * 2.1) * 0.5 + 0.5));
      g.fillStyle = rgba(col, a * 0.5);
      g.beginPath();
      g.arc(px, py, rr, 0, TAU);
      g.fill();
    }
    g.restore();
  }

  const AT = { rgb, rgba, sky, haze, beam, glow, grain, water, dust, stars, flare };
  root.AT = AT;
  if (typeof module === 'object' && module.exports) module.exports = AT;
})(typeof globalThis !== 'undefined' ? globalThis : this);
