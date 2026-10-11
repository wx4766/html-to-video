/**
 * 动效时间库 MO —— 缓动、弹簧、步进、错开、拍号。
 *
 * 全部是「时间 → 数值」的**纯函数**，不读时钟、不碰 DOM。这一点和本技能的渲染契约
 * （冻结时钟 + window.__seek(t) 逐帧推）天然契合：只要画面写成 frame(t) 的纯函数，
 * 就能精确重现、同输入同输出。
 *
 * 用法（动画 HTML 里）：
 *   <script src="../lib/motion.js"></script>
 *   ...
 *   const e = MO.expoOut(MO.seg(t, 0.3, 1.4));   // 0..1 的进度
 *
 * 选缓动的一句话（原作者调研 8 支示范片后的结论）：
 *   讲解类（3b1b / 白板）用 MO.smooth 或 sineInOut —— 两端都停稳，不抢戏
 *   发布会风格（Apple / Material）用 MO.appleOut / MO.emphasized，或弹簧 MO.snappy
 *   动态文字（砸进来的大字）用 expoOut + MO.springHz
 *   拼贴 / 纪实（Vox）相机用 sineInOut 或长尾 MO.longTail；纸片按 MO.step(t, 12) 的一拍二步进
 *   Kurzgesagt 类动作用 MO.k75，循环动作 MO.easyEase
 *
 * 来源：huashu-art-motion（MIT）scripts/engine/lib/motion.js，去掉了引擎耦合
 * （原版依赖全局 U 工具与 STAGE 画布登记，这里改为自包含，可直接放进任意工程）。
 */
(function (root) {
  'use strict';

  const clamp = (v, a = 0, b = 1) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, t) => a + (b - a) * t;

  const MO = {};

  /* ── 小工具（顺手挂在 MO 上，动画里常用） ───────────────────────── */
  MO.clamp = clamp;
  MO.lerp = lerp;

  /* ── 时间片：把绝对时间 t 换算成 0..1 的进度 ─────────────────────── */
  MO.seg = (t, a, b) => clamp((t - a) / (b - a));            // [a,b] → 0..1
  MO.at = (t, t0, dur) => clamp((t - t0) / dur);             // [t0, t0+dur] → 0..1
  MO.anim = (lt, start, dur, ease = MO.smooth) => ease(clamp((lt - start) / dur));

  // 步进时间：把连续时间量化成 fps 步。拼贴纸片／打字／荧光笔「一拍二」= 12fps；
  // 故事型角色 24fps；相机仍按 60fps 平滑。
  MO.step = (t, fps = 12) => Math.floor(t * fps + 1e-6) / fps;

  /* ── manim 缓动（3b1b / manim rate_functions.py） ────────────────── */
  // smooth = 6t⁵−15t⁴+10t³：两端速度、加速度都为 0。讲解类片子的默认缓动。
  MO.smooth = t => { t = clamp(t); return t * t * t * (10 - 15 * t + 6 * t * t); };
  const sig = x => 1 / (1 + Math.exp(-x));
  MO.smoothCE = (t, inflection = 10) => {   // ManimCE 版：拐点可调
    const e = sig(-inflection / 2);
    return clamp((sig(inflection * (t - 0.5)) - e) / (1 - 2 * e));
  };
  MO.thereAndBack = t => MO.smooth(t < 0.5 ? 2 * t : 2 * (1 - t));   // Indicate 用：去了又回
  MO.rushInto = t => 2 * MO.smooth(t / 2);                            // 慢起、冲进终点
  MO.rushFrom = t => 2 * MO.smooth(t / 2 + 0.5) - 1;                  // 冲出、慢收
  MO.doubleSmooth = t => t < 0.5 ? 0.5 * MO.smooth(2 * t) : 0.5 * (1 + MO.smooth(2 * t - 1));
  MO.wiggle = (t, wiggles = 2) => MO.thereAndBack(t) * Math.sin(wiggles * Math.PI * t);

  // manim LaggedStart(lag_ratio=r)：n 个子动画里第 i 个在总进度 p 下的局部进度。
  // 总长 = 1+(n-1)·r 个单位，第 i 个占 [i·r, i·r+1]。做「逐字/逐项依次入场」用这个。
  MO.lagged = (i, n, p, r = 0.05) => clamp(p * (1 + (n - 1) * r) - i * r);

  /* ── 常用解析缓动（AE / CSS 名字） ──────────────────────────────── */
  MO.linear = p => p;
  MO.sineInOut = p => -(Math.cos(Math.PI * p) - 1) / 2;
  MO.cubicIn = p => p * p * p;
  MO.cubicOut = p => 1 - Math.pow(1 - p, 3);
  MO.cubicInOut = p => p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  MO.quartOut = p => 1 - Math.pow(1 - p, 4);
  MO.quintOut = p => 1 - Math.pow(1 - p, 5);
  MO.quintInOut = p => p < .5 ? 16 * p ** 5 : 1 - Math.pow(-2 * p + 2, 5) / 2;
  MO.expoIn = p => p <= 0 ? 0 : Math.pow(2, 10 * p - 10);
  MO.expoOut = p => p >= 1 ? 1 : 1 - Math.pow(2, -10 * p);            // 动效设计最常用：快出慢停
  MO.expoInOut = p => p <= 0 ? 0 : p >= 1 ? 1 : p < .5 ? Math.pow(2, 20 * p - 10) / 2 : (2 - Math.pow(2, -20 * p + 10)) / 2;

  // backOut 过冲：s=1.70158 约 10%；2.2 约 13%；2.6 约 17%；3.5 约 23%
  MO.backOut = (p, s = 1.70158) => { const q = p - 1; return 1 + (s + 1) * q * q * q + s * q * q; };
  // 弹性落定：过冲一次再回（贴纸「啪」地落下）
  MO.elasticOut = p => p <= 0 ? 0 : p >= 1 ? 1 : Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * (2 * Math.PI / 3)) + 1;

  /* ── CSS cubic-bezier(x1,y1,x2,y2)：牛顿法由 x 求参数，再取 y ──── */
  MO.bezier = (x1, y1, x2, y2) => {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const X = s => ((ax * s + bx) * s + cx) * s;
    const Y = s => ((ay * s + by) * s + cy) * s;
    const dX = s => (3 * ax * s + 2 * bx) * s + cx;
    return p => {
      if (p <= 0) return 0; if (p >= 1) return 1;
      let s = p;
      for (let k = 0; k < 8; k++) {
        const e = X(s) - p, d = dX(s);
        if (Math.abs(e) < 1e-6 || Math.abs(d) < 1e-6) break;
        s -= e / d;
      }
      return Y(clamp(s));
    };
  };
  MO.appleOut = MO.bezier(0.25, 0.1, 0.25, 1);     // CSS `ease`：苹果官网/发布会过渡
  MO.emphasized = MO.bezier(0.2, 0, 0, 1);         // Material 3 emphasized：长尾减速
  MO.k75 = MO.bezier(0.75, 0, 0.25, 1);            // Kurzgesagt「其他动作用 75% influence」
  MO.easyEase = MO.bezier(0.333, 0, 0.667, 1);     // AE Easy Ease：循环动作
  MO.longTail = MO.bezier(0.33, 0, 0.2, 1);        // Vox「沿线追过去」「拉出揭示」：起步快、长尾落定

  /* ── 弹簧 ───────────────────────────────────────────────────────── */
  // SwiftUI 参数化（WWDC23 Animate with springs）：
  //   stiffness=(2π/duration)²，damping=4π(1-bounce)/duration → ζ=1-bounce，ω=2π/duration
  // 返回 0→1 的位移（可 >1 = 过冲）。t 单位秒。
  MO.spring = (t, { duration = 0.5, bounce = 0, v0 = 0 } = {}) => {
    if (t <= 0) return 0;
    const w = 2 * Math.PI / duration, z = 1 - bounce;
    let x;                                        // x = 剩余位移（1→0）
    if (Math.abs(z - 1) < 1e-4) {
      x = Math.exp(-w * t) * (1 + (w - v0) * t);
    } else if (z < 1) {
      const wd = w * Math.sqrt(1 - z * z);
      x = Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w - v0) / wd) * Math.sin(wd * t));
    } else {
      const r = Math.sqrt(z * z - 1), a = -w * (z - r), b = -w * (z + r);
      const A = (-v0 - b) / (a - b);
      x = A * Math.exp(a * t) + (1 - A) * Math.exp(b * t);
    }
    return 1 - x;
  };
  // 发布会长用的三档：.smooth(bounce 0) / .snappy(0.15) / .bouncy(0.3)
  MO.smoothSpring = t => MO.spring(t, { duration: 0.5, bounce: 0 });
  MO.snappy = t => MO.spring(t, { duration: 0.5, bounce: 0.15 });
  MO.bouncy = t => MO.spring(t, { duration: 0.5, bounce: 0.3 });

  // 频率/衰减参数化的欠阻尼弹簧阶跃响应（动态文字用）：freq Hz、decay 1/s。
  //   freq 3 / decay 6 第一次过冲 ≈37%（砸进来的大字）；2.5 / 9 ≈16%（常规弹入）；2.2 / 10 ≈8%（主词落定）
  MO.springHz = (t, freq = 2.5, decay = 9) => t <= 0 ? 0 : 1 - Math.exp(-decay * t) * Math.cos(2 * Math.PI * freq * t);

  // 到位后的余振（Dan Ebberts 惯性回弹）：amp·sin(2πft)/e^(decay·t)。
  // 换姿势的身体挤压、被撞后的镜头震动都用它。
  MO.settle = (t, amp, freq = 3, decay = 5) => t <= 0 ? 0 : amp * Math.sin(2 * Math.PI * freq * t) / Math.exp(decay * t);

  /* ── 持续微动 ───────────────────────────────────────────────────── */
  // 漂浮：两频正弦叠加。周期避开 5s 左右（HIG：~0.2Hz 的持续摆动让人不适）
  MO.float = (t, amp = 6, period = 4, ph = 0) =>
    amp * (0.75 * Math.sin(2 * Math.PI * t / period + ph) + 0.25 * Math.sin(2 * Math.PI * t / (period * 0.53) + ph * 1.7));

  /* ── 反查与拍号 ─────────────────────────────────────────────────── */
  // 缓动的反函数（二分）：「线头/计数在什么时刻到达 y」。
  // 例：折线按 smooth 画，求画到某个 x 的时刻（用于给事件标注定时）。
  MO.invert = (ease, y, iters = 30) => {
    let a = 0, b = 1;
    for (let i = 0; i < iters; i++) { const m = (a + b) / 2; if (ease(m) < y) a = m; else b = m; }
    return (a + b) / 2;
  };
  // 拍 → 秒
  MO.beat = (n, bpm = 120) => n * 60 / bpm;
  // 揭开那一帧落在拍上：段起点 = 小节线 − 揭开点 × 转场时长
  MO.onBeat = (barTime, revealP, trDur) => barTime - revealP * trDur;

  /* ── 逐项入场：一条常用封装 ─────────────────────────────────────── */
  /**
   * 把一串元素按 lagged 依次弹出，返回每个元素在当前进度下的数值。
   * @param {number} t     当前时间（秒）
   * @param {number} n     元素个数
   * @param {object} o     { t0 起始秒, dur 单个元素时长, stagger 每个间隔秒, ease 缓动 }
   * @returns {number[]}   长度 n，每项 0..1（可能略过冲）
   */
  MO.stagger = (t, n, { t0 = 0, dur = 0.5, stagger = 0.08, ease = MO.expoOut } = {}) =>
    Array.from({ length: n }, (_, i) => ease(clamp((t - t0 - i * stagger) / dur)));

  root.MO = MO;
  if (typeof module === 'object' && module.exports) module.exports = MO;
})(typeof globalThis !== 'undefined' ? globalThis : this);
