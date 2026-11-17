/**
 * brush.js —— 大规模笔触场（v2.0）
 *
 * ┌ 为什么单独一层 ────────────────────────────────────────────────
 * │ 版式模板一次画几十个元素，styles.js 的 fillRect 量级够用。
 * │ 但「70 万次模拟笔触」「每帧 150 万笔」那种片子不是靠更精细的代码，
 * │ 是靠数量级：单笔在十万笔的密度里根本看不出来，能看出来的是整体的
 * │ 疏密、方向、留白和边界。这一层专门解决「量」。
 * │
 * │ 实测（1920×1080，单帧）：10 万笔 fillRect 约 1.4s；
 * │ 分桶后批量 stroke 约 90ms —— 差 15 倍以上，因为状态切换从 10 万次
 * │ 降到十几个（颜色 × 粗细）。
 * └──────────────────────────────────────────────────────────────
 *
 * 四件事：
 *   BR.field(n, opts)          生成笔触场（TypedArray 存，确定性 rng）
 *   BR.draw(g, f, opts)        按「颜色 × 粗细」分桶批量提交
 *   BR.morph(a, b, k)          两个场之间插值 → 「纸张聚成鸟」
 *   BR.textPoints(text, opts)  文字轮廓采样 → 笔触有地方可去
 *
 * 确定性：所有随机来自 hash(seed, i)，不用 Math.random()。
 *   同参数同输出 —— 渲染器逐帧 seek、多 worker 并行才成立。
 *
 * 用法：
 *   <script src="../lib/brush.js"></script>
 *   const f = BR.field(120000, {
 *     seed: 7, area: { x: 0, y: 0, w: W, h: H },
 *     angle: BR.vortex(W / 2, H / 2, 0.8),
 *     len: [10, 46], wid: [1.2, 3.2],
 *     color: (x, y) => `rgba(${...},0.7)`,
 *   });
 *   BR.draw(g, f, { alpha: 0.9, reveal: k });
 */
(function (root) {
  'use strict';

  const TAU = Math.PI * 2;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /* ── 确定性随机 ──────────────────────────────────────────────────
     整数哈希。用 Math.imul 而不是普通 *，因为 JS 的双精度浮点乘
     32 位整数会丢低位，换个引擎（V8 / JSC / SpiderMonkey）结果就变。 */
  function hash(seed, i) {
    let h = Math.imul(seed | 0, 0x27d4eb2d) + Math.imul(i | 0, 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  /* 2D 值噪声：给方向场用（漩涡、风、水流）。双线性插值 + 五次平滑，
     比单纯 hash 少一些网格纹。 */
  function nz(x, y, seed) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const a = hash(seed, xi * 73856093 ^ yi * 19349663);
    const b = hash(seed, (xi + 1) * 73856093 ^ yi * 19349663);
    const c = hash(seed, xi * 73856093 ^ (yi + 1) * 19349663);
    const d = hash(seed, (xi + 1) * 73856093 ^ (yi + 1) * 19349663);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  }

  /* 角度辅助：所有方向场都返回弧度，调用方不用记约定。
     · 0 指向右，顺时针为正（和 Canvas 的 arc 一致）
     · 返回函数 (x, y) => rad，可直接传给 field 的 angle */
  function dir(rad) { return () => rad; }
  function vortex(cx, cy, swirl, base) {
    /* 围着 (cx,cy) 打旋。纯切向会画出一圈圈同心圆（像水波不像流体），
       所以近处用切向，远处指数退回起始方向 base —— 出来的是一团旋，
       边缘自然散开。swirl 越大越卷。 */
    const b0 = base == null ? 0 : base;
    const sw = swirl == null ? 1 : swirl;
    return (x, y) => {
      const dx = x - cx, dy = y - cy;
      const a = Math.atan2(dy, dx) + Math.PI / 2;
      const r = Math.sqrt(dx * dx + dy * dy) || 1;
      const k = Math.min(1, 420 / r);
      return lerp(b0, a, sw * k * k);
    };
  }
  function wind(rad, wobble, seed) {
    // 一个主方向 + 噪声摆动：油画里的笔触几乎不会绝对平行
    const w = wobble == null ? 0.45 : wobble;
    return (x, y) => rad + (nz(x * 0.0016, y * 0.0016, seed || 11) - 0.5) * Math.PI * w;
  }

  /* ── 颜色解析与量化 ──────────────────────────────────────────────
     桶数 = 颜色数 × 粗细档。颜色每笔都不同时桶数会爆炸到 n，
     于是 12 万笔变成 12 万次 stroke —— 批量提交的意义全没了。
     所以：(a) jitterColor 走固定档位；(b) field 兜底，超过 maxColors
     就把通道量化到 16 级合并。 */
  function parseColor(c) {
    if (typeof c !== 'string') return null;
    if (c[0] === '#') {
      const h = c.slice(1);
      const x = (s) => parseInt(s, 16);
      if (h.length === 3) return [x(h[0] + h[0]), x(h[1] + h[1]), x(h[2] + h[2]), 1];
      if (h.length === 6) return [x(h.slice(0, 2)), x(h.slice(2, 4)), x(h.slice(4, 6)), 1];
      if (h.length === 8) return [x(h.slice(0, 2)), x(h.slice(2, 4)), x(h.slice(4, 6)), x(h.slice(6, 8)) / 255];
      return null;
    }
    const m = c.match(/^rgba?\(([^)]+)\)$/);
    if (!m) return null;
    const p = m[1].split(',').map((v) => parseFloat(v));
    return [p[0], p[1], p[2], p[3] == null ? 1 : p[3]];
  }

  function quantizeColors(cols, maxColors) {
    /* 步长按「要压到多少色」反推：通道分 L 级 → 最多 L³ 种颜色。
       alpha 再分 5 档，但实际绝大多数笔触 alpha 相同，不会真乘 5。 */
    const L = Math.max(2, Math.round(Math.cbrt(Math.max(4, maxColors))));
    const q = Math.ceil(256 / L);
    const map = new Map();
    const out = [];
    const remap = new Int32Array(cols.length);
    for (let i = 0; i < cols.length; i++) {
      const c = parseColor(cols[i]);
      if (!c) { remap[i] = i; continue; }
      const r0 = Math.min(L - 1, (c[0] / q) | 0);
      const g0 = Math.min(L - 1, (c[1] / q) | 0);
      const b0 = Math.min(L - 1, (c[2] / q) | 0);
      const a0 = Math.round(c[3] * 4);
      const key = r0 + ',' + g0 + ',' + b0 + ',' + a0;
      let k = map.get(key);
      if (k === undefined) {
        k = out.length;
        out.push(`rgba(${r0 * q},${g0 * q},${b0 * q},${a0 / 4})`);
        map.set(key, k);
      }
      remap[i] = k;
    }
    return { cols: out, remap };
  }

  /* ── 数值化参数 ──────────────────────────────────────────────────
     len / wid 允许写 [min,max] / 数字 / (i,r)=>v。
     统一成函数，免得生成循环里到处 if。 */
  function asRange(v, defA, defB) {
    if (typeof v === 'function') return v;
    if (Array.isArray(v)) { const a = v[0], b = v[1] == null ? v[0] : v[1]; return (i, r) => lerp(a, b, r); }
    if (typeof v === 'number') return () => v;
    return (i, r) => lerp(defA, defB, r);
  }

  /* ── 生成笔触场 ──────────────────────────────────────────────────
     分布默认「抖动网格」而不是纯随机：纯随机会聚簇、留大片空洞，
     十万笔看起来仍然稀。抖动网格每格一笔、格内随机偏移，密度才均匀。 */
  function field(n, opts) {
    opts = opts || {};
    n = Math.max(1, Math.floor(n));
    const seed = (opts.seed == null ? 1 : opts.seed) | 0;
    const A = opts.area || { x: 0, y: 0, w: 1920, h: 1080 };
    const place = opts.place || 'grid';

    const lenOf = asRange(opts.len, 12, 40);
    const widOf = asRange(opts.wid, 1.2, 3.0);
    const angOf = typeof opts.angle === 'function' ? opts.angle
      : Array.isArray(opts.angle) ? () => lerp(opts.angle[0], opts.angle[1], hash(seed, 3))
        : typeof opts.angle === 'number' ? () => opts.angle : null;
    const colOf = typeof opts.color === 'function' ? opts.color : null;
    const colList = Array.isArray(opts.color) ? opts.color : null;
    const curve = opts.curve == null ? 0.28 : opts.curve;
    const jitter = opts.jitter == null ? 1 : opts.jitter;

    const x = new Float32Array(n), y = new Float32Array(n);
    const ang = new Float32Array(n), len = new Float32Array(n);
    const wid = new Float32Array(n), cv = new Float32Array(n);

    // 网格：cols×rows 略多于 n，多出来的格子不用
    let gx = 0, gy = 0, cell = 0;
    if (place === 'grid') {
      const ar = A.w / A.h;
      gy = Math.max(1, Math.round(Math.sqrt(n / ar)));
      gx = Math.max(1, Math.ceil(n / gy));
      cell = Math.min(A.w / gx, A.h / gy);
    }

    const cols = [];
    const colIdx = new Map();
    const ci = new Uint16Array(n);

    for (let i = 0; i < n; i++) {
      const r1 = hash(seed, i * 4 + 1), r2 = hash(seed, i * 4 + 2);
      const r3 = hash(seed, i * 4 + 3), r4 = hash(seed, i * 4 + 4);

      let px, py;
      if (place === 'grid') {
        const kx = i % gx, ky = (i / gx) | 0;
        px = A.x + (kx + 0.5 + (r1 - 0.5) * jitter) * cell;
        py = A.y + (ky + 0.5 + (r2 - 0.5) * jitter) * cell;
      } else if (place === 'fibonacci') {
        // 黄金角螺旋：均匀度最好，适合「粒子聚成圆/球」的起点
        const ga = i * 2.399963229728653;
        const rr = Math.sqrt((i + 0.5) / n);
        px = A.x + A.w * 0.5 + Math.cos(ga) * rr * A.w * 0.5;
        py = A.y + A.h * 0.5 + Math.sin(ga) * rr * A.h * 0.5;
      } else {
        px = A.x + r1 * A.w;
        py = A.y + r2 * A.h;
      }
      if (typeof opts.warp === 'function') { const q = opts.warp(px, py, i); px = q[0]; py = q[1]; }

      x[i] = px; y[i] = py;
      ang[i] = angOf ? angOf(px, py, i, r3) : r3 * TAU;
      len[i] = lenOf(i, r4);
      wid[i] = widOf(i, r1);
      cv[i] = (r2 - 0.5) * 2 * curve;

      // 颜色：字符串直接入表；函数按点取色（渐变、按密度上色都靠它）
      let c;
      if (colOf) c = colOf(px, py, i);
      else if (colList) c = colList[i % colList.length];
      else c = '#222';
      let idx = colIdx.get(c);
      if (idx === undefined) { idx = cols.length; cols.push(c); colIdx.set(c, idx); }
      ci[i] = idx;
    }

    /* 粗细分三档：线宽是 stroke 的状态，只能按桶切换。
       分 3 档已经能表现笔触的轻重，分 10 档桶数爆炸、状态切换又变多。 */
    const wMin = opts.widMin == null ? 1.1 : opts.widMin;
    const wMax = opts.widMax == null ? 4.0 : opts.widMax;
    const wLev = [wMin, (wMin + wMax) * 0.5, wMax];

    /* 颜色过多就量化合并。桶数 = 色数 × 粗细档，色数一爆炸，
       批量提交就退化成「每笔一次 stroke」，白分桶了。 */
    const maxColors = opts.maxColors == null ? 32 : opts.maxColors;
    if (cols.length > maxColors) {
      const qz = quantizeColors(cols, maxColors);
      for (let i = 0; i < n; i++) ci[i] = qz.remap[ci[i]];
      cols.length = 0;
      for (let i = 0; i < qz.cols.length; i++) cols.push(qz.cols[i]);
    }

    const out = { n, seed, cols, wLev, x, y, ang, len, wid, cv, ci };
    reindex(out);
    return out;
  }

  /* 按 (颜色, 粗细档) 重排所有数组，并预计算桶边界。
     计数排序 O(n)，比 Array.sort 快一个量级，且结果稳定。 */
  function reindex(f) {
    const n = f.n;
    const nC = f.cols.length, nW = f.wLev.length;
    const wl = new Uint8Array(n);
    const bk = new Uint8Array(n);

    // 档位：按 wid 在 [wMin,wMax] 里的位置取
    const lo = f.wLev[0], hi = f.wLev[nW - 1];
    for (let i = 0; i < n; i++) {
      const t = hi > lo ? (f.wid[i] - lo) / (hi - lo) : 0;
      wl[i] = t < 0.5 ? (t < 0.22 ? 0 : 1) : 2;
      bk[i] = f.ci[i] * nW + wl[i];
    }

    const nB = nC * nW;
    const start = new Int32Array(nB + 1);
    for (let i = 0; i < n; i++) start[bk[i] + 1]++;
    for (let b = 0; b < nB; b++) start[b + 1] += start[b];

    const pos = Int32Array.from(start.subarray(0, nB));
    const ox = new Float32Array(n), oy = new Float32Array(n);
    const oa = new Float32Array(n), ol = new Float32Array(n);
    const ow = new Float32Array(n), oc = new Float32Array(n);
    const oi = new Uint16Array(n), owl = new Uint8Array(n), obk = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const k = pos[bk[i]]++;
      ox[k] = f.x[i]; oy[k] = f.y[i]; oa[k] = f.ang[i];
      ol[k] = f.len[i]; ow[k] = f.wid[i]; oc[k] = f.cv[i]; oi[k] = f.ci[i];
      owl[k] = wl[i]; obk[k] = bk[i];
    }

    f.x = ox; f.y = oy; f.ang = oa; f.len = ol; f.wid = ow; f.cv = oc; f.ci = oi;
    f.wl = owl; f.bucket = obk;
    f.start = start;          // 桶 b 覆盖 [start[b], start[b+1])
    f.nB = nB;
    f.nW = nW; f.nC = nC;
    return f;
  }

  /* ── 绘制 ────────────────────────────────────────────────────────
     reveal：每桶按比例从头画。为什么不是全局截断 ——
     全局截断会让「先画完颜色 A 的三万笔，再轮到 B」，看起来像染色；
     每桶齐头并进才像「一幅画同时被画出来」。 */
  function draw(g, f, o) {
    o = o || {};
    const alpha = o.alpha == null ? 1 : o.alpha;
    const reveal = o.reveal == null ? 1 : clamp(o.reveal, 0, 1);
    if (reveal <= 0 || alpha <= 0) return;

    const nW = f.nW, nC = f.nC;
    const wMul = o.widMul == null ? 1 : o.widMul;

    g.save();
    g.globalAlpha = alpha;
    g.lineCap = 'round';
    g.lineJoin = 'round';

    for (let b = 0; b < f.nB; b++) {
      const s = f.start[b], e = f.start[b + 1];
      if (e <= s) continue;
      const cnt = s + Math.round((e - s) * reveal);
      if (cnt <= s) continue;

      const ci = (b / nW) | 0, wl = b % nW;
      g.strokeStyle = f.cols[ci];
      g.lineWidth = f.wLev[wl] * wMul;
      g.beginPath();
      for (let i = s; i < cnt; i++) {
        const px = f.x[i], py = f.y[i], a = f.ang[i];
        const hl = f.len[i] * 0.5;
        const ca = Math.cos(a), sa = Math.sin(a);
        const x1 = px - ca * hl, y1 = py - sa * hl;
        const x2 = px + ca * hl, y2 = py + sa * hl;
        if (f.cv[i] === 0) { g.moveTo(x1, y1); g.lineTo(x2, y2); continue; }
        // 控制点沿法线偏：笔触有弧度，不是直棍
        const nx = -sa * f.cv[i] * f.len[i], ny = ca * f.cv[i] * f.len[i];
        g.moveTo(x1, y1);
        g.quadraticCurveTo(px + nx, py + ny, x2, y2);
      }
      g.stroke();
    }
    g.restore();
  }

  /* 点画模式：每个笔触画成一小段（点、短线），适合作星光、纸屑、雨。
     比 draw 便宜一半 —— 没有曲线计算。 */
  function drawDots(g, f, o) {
    o = o || {};
    const alpha = o.alpha == null ? 1 : o.alpha;
    const reveal = o.reveal == null ? 1 : clamp(o.reveal, 0, 1);
    if (reveal <= 0 || alpha <= 0) return;
    const nW = f.nW;
    g.save();
    g.globalAlpha = alpha;
    g.lineCap = 'round';
    for (let b = 0; b < f.nB; b++) {
      const s = f.start[b], e = f.start[b + 1];
      const cnt = s + Math.round((e - s) * reveal);
      if (cnt <= s) continue;
      const ci = (b / nW) | 0, wl = b % nW;
      g.fillStyle = f.cols[ci];
      const r = f.wLev[wl] * 0.5;
      for (let i = s; i < cnt; i++) {
        g.beginPath();
        g.arc(f.x[i], f.y[i], r, 0, TAU);
        g.fill();
      }
    }
    g.restore();
  }

  /* ── 形态插值 ────────────────────────────────────────────────────
     两个场笔数必须一致（用 n = min 截断）。位置线性、角度走最短弧、
     长度与粗细线性。桶结构沿用 b —— 颜色不该在变形中途变，
     变了会像「换了一层皮」。 */
  function morph(a, b, k, out) {
    const n = Math.min(a.n, b.n);
    const o = out && out.n === n ? out : {
      n, cols: b.cols, wLev: b.wLev,
      x: new Float32Array(n), y: new Float32Array(n),
      ang: new Float32Array(n), len: new Float32Array(n),
      wid: new Float32Array(n), cv: new Float32Array(n),
      ci: new Uint16Array(n),
    };
    const t = clamp(k, 0, 1);
    for (let i = 0; i < n; i++) {
      o.x[i] = lerp(a.x[i], b.x[i], t);
      o.y[i] = lerp(a.y[i], b.y[i], t);
      // 最短弧：直接 lerp 角度会在 ±π 处整圈倒转
      let d = b.ang[i] - a.ang[i];
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      o.ang[i] = a.ang[i] + d * t;
      o.len[i] = lerp(a.len[i], b.len[i], t);
      o.wid[i] = lerp(a.wid[i], b.wid[i], t);
      o.cv[i] = lerp(a.cv[i], b.cv[i], t);
      o.ci[i] = b.ci[i];
    }
    o.cols = b.cols; o.wLev = b.wLev;
    /* 桶归属按 b 的索引重算：morph 出来的场每帧都重建，
       重排一次是 O(n) 计数排序，10 万笔约 8ms，可接受。 */
    reindex(o);
    return o;
  }

  /* ── 文字轮廓采样 ────────────────────────────────────────────────
     把一段字变成点集，笔触就能「聚成字」再散开。
     只在浏览器里有 document；node 端测试跳过。 */
  function textPoints(text, o) {
    o = o || {};
    if (typeof document === 'undefined') throw new Error('BR.textPoints 需要浏览器环境');
    const W = o.W || 1200, H = o.H || 400;
    const size = o.size || Math.min(H * 0.62, W / Math.max(1, text.length) * 1.7);
    const step = o.step || 3;

    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#fff';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `${o.weight || 700} ${size}px ${o.font || '"Noto Sans SC", system-ui, sans-serif'}`;
    g.fillText(text, W / 2 + (o.dx || 0), H / 2 + (o.dy || 0));

    const d = g.getImageData(0, 0, W, H).data;
    const xs = [];
    for (let yy = 0; yy < H; yy += step) {
      for (let xx = 0; xx < W; xx += step) {
        if (d[(yy * W + xx) * 4] > 128) { xs.push(xx, yy); }
      }
    }
    return { n: xs.length / 2, xy: Float32Array.from(xs), W, H };
  }

  /* 把场的坐标「吸附」到点集：k=0 原位，k=1 完全贴到最近点。
     用网格哈希找最近点，10 万 × 2 万不至于 O(n²)。 */
  function snap(f, pts, o) {
    o = o || {};
    const k = o.k == null ? 1 : clamp(o.k, 0, 1);
    const cell = o.cell || 12;
    const grid = new Map();
    const P = pts.xy, np = pts.n;
    for (let i = 0; i < np; i++) {
      const gx = (P[i * 2] / cell) | 0, gy = (P[i * 2 + 1] / cell) | 0;
      const key = gx * 100003 + gy;
      let arr = grid.get(key);
      if (!arr) { arr = []; grid.set(key, arr); }
      arr.push(i);
    }
    for (let i = 0; i < f.n; i++) {
      const px = f.x[i], py = f.y[i];
      const gx = (px / cell) | 0, gy = (py / cell) | 0;
      let best = -1, bd = Infinity;
      /* 逐层扩圈（+1 而不是 ×2）。倍增会跳过目标所在的层：
         目标在第 7 层，序列 1,2,4,8 就永远够不到它。 */
      for (let ring = 1; ring <= 24 && best < 0; ring++) {
        for (let ox = -ring; ox <= ring; ox++) {
          for (let oy = -ring; oy <= ring; oy++) {
            /* 只扫这一圈的最外层（切比雪夫距离 = ring）。
               之前的写法是「两个分量都不等于 ring 就跳过」——
               那会把 (6,7) 这种真正需要的格子也跳掉，目标永远找不到。 */
            if (ring > 1 && Math.max(Math.abs(ox), Math.abs(oy)) !== ring) continue;
            const arr = grid.get((gx + ox) * 100003 + (gy + oy));
            if (!arr) continue;
            for (let q = 0; q < arr.length; q++) {
              const j = arr[q];
              const dx = P[j * 2] - px, dy = P[j * 2 + 1] - py;
              const dd = dx * dx + dy * dy;
              if (dd < bd) { bd = dd; best = j; }
            }
          }
        }
      }
      if (best < 0) continue;
      f.x[i] = lerp(px, P[best * 2], k);
      f.y[i] = lerp(py, P[best * 2 + 1], k);
    }
    return f;
  }

  /* 从场的当前状态复制一份（做 morph 的 A 端点时常用） */
  function clone(f) {
    return {
      n: f.n, seed: f.seed, cols: f.cols, wLev: f.wLev,
      x: Float32Array.from(f.x), y: Float32Array.from(f.y),
      ang: Float32Array.from(f.ang), len: Float32Array.from(f.len),
      wid: Float32Array.from(f.wid), cv: Float32Array.from(f.cv),
      ci: Uint16Array.from(f.ci),
      wl: f.wl, bucket: f.bucket, start: f.start, nB: f.nB, nW: f.nW, nC: f.nC,
    };
  }

  const BR = {
    hash, nz, field, reindex, draw, drawDots, morph, textPoints, snap, clone,
    dir, vortex, wind, lerp, clamp,
    /* 常用配色预设：省得每次手写一堆 rgba */
    ink(col, a) { return `rgba(${col[0]},${col[1]},${col[2]},${a == null ? 1 : a})`; },
    jitterColor(base, amt, seed, levels) {
      /* 同一色系里的细微差异：笔触之间颜色要有一点不一样，
         否则十万笔糊成一块色板。但必须走**档位**，不能连续——
         连续抖动每笔一个色，桶数直接等于笔数。 */
      const L = Math.max(2, levels || 6);
      return (x, y, i) => {
        const step = Math.floor(hash(seed, i) * L);
        const k = (step / (L - 1) - 0.5) * 2;
        const r = Math.round(clamp(base[0] + k * amt * 255, 0, 255));
        const g = Math.round(clamp(base[1] + k * amt * 255, 0, 255));
        const b = Math.round(clamp(base[2] + k * amt * 255, 0, 255));
        return `rgb(${r},${g},${b})`;
      };
    },
  };

  root.BR = BR;
  if (typeof module === 'object' && module.exports) module.exports = BR;
})(typeof globalThis !== 'undefined' ? globalThis : this);
