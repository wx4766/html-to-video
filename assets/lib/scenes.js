/**
 * 场景编排 SC —— 一个 HTML 里的多镜头时间轴 + 镜头间转场。
 *
 * 为什么需要它：一段 HTML 渲 6 秒单镜没问题，但一支真正能看的片子是「多个镜头 + 转场」。
 * 没有转场时镜头之间是硬切，观感上是「几段动画被拼起来」，不是「一支片子」。
 * 有了它：镜头表写在页面里，渲染器照旧只管按 t 推帧，转场在页面内合成 ——
 * 不需要 ffmpeg 拼接、不需要多渲几段再合并，一条命令照样出片。
 *
 * 全部是**纯函数**（时间 → 状态），不读时钟、不用随机数：
 *   · 同输入同输出，QA 的「确定性」检查能过
 *   · 多 worker 并行渲染不会各渲各的
 *
 * 用法：
 *   <script src="../lib/scenes.js"></script>
 *   const TL = SC.build([
 *     { id:'hook',  dur:3.0, draw:(g, lt, c) => drawHook(g, lt, c) },
 *     { id:'point', dur:4.0, trans:{ in:'slide', dur:0.5 }, draw:(g, lt, c) => drawPoint(g, lt, c) },
 *   ], { lead:0.35, tail:0.5 });
 *
 *   function frame(t) { SC.paint(g, TL, clamp(t,0,TL.dur-1e-4), { W, H, bg: TH.bg }); }
 *
 * 约定（重要）：
 *   1. draw(g, lt, c) 必须把**背景也画满**（不透明）。转场是按 alpha 叠加两张画的，
 *      镜头自己留透明，交叉溶解时会透出底色，看着像闪一下。
 *   2. lt 是该镜头内的局部时间 [0, dur)，镜头动画一律以 lt 为准，不要用全局 t。
 *   3. 转场窗口里，上一个镜头的 lt 会走到它自己的末尾（不会超），镜头动画不需要特殊处理。
 *   4. SC.expose(TL) 会把镜头表挂到 window.__sceneTable，配合渲染器的 --scene-log 导出 CSV。
 */
(function (root) {
  'use strict';

  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;

  /* 自带三个缓动，不依赖 motion.js（这个库要能单独拷走用） */
  const linear = (t) => clamp(t);
  const smooth = (t) => { t = clamp(t); return t * t * (3 - 2 * t); };
  const outCubic = (t) => { t = clamp(t); return 1 - Math.pow(1 - t, 3); };
  const inOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  /* ── 转场 ──────────────────────────────────────────────────────────
     签名：(g, A, B, p, e, env)
       g    主画布上下文
       A/B  离屏画布（上一镜 / 下一镜），尺寸 = env.W × env.H
       p    原始进度 0..1；e 已缓动过的进度（多数转场用 e）
       env  { W, H, bg, SF }  SF 是字号缩放档，用来让描边粗细跟着分辨率走
     规则：先画 A 再画 B。不要让两张都半透明 —— 那会透出底色，观感是「闪」。
     ──────────────────────────────────────────────────────────────── */
  /* 转场选择速查（这条很重要，选错转场一眼就看出「业余」）：
     · 文字为主的深色版式 → 只用 fade / dip。
       带位移的转场（slide/push/rise/ wipe/zoom）会把上一镜的文字从中间切一半推走，
       观感是「画面坏了」，不是「镜头动了」。
     · slide / push / rise / wipe / zoom → 留给满幅图形、照片、色块这类
       边缘没有语义的镜头；或者两镜共用同一条左边距时用 rise 也还稳。 */

  const T = {};

  /** 把离屏画布贴到主画布：支持位移 / 缩放（围绕画面中心）/ alpha */
  function blit(g, src, alpha, dx, dy, scale, env) {
    if (alpha <= 0.0005) return;
    g.save();
    g.globalAlpha = alpha > 1 ? 1 : alpha;
    if (scale !== 1 || dx !== 0 || dy !== 0) {
      g.translate(env.W / 2 + dx, env.H / 2 + dy);
      if (scale !== 1) g.scale(scale, scale);
      g.translate(-env.W / 2, -env.H / 2);
    }
    g.drawImage(src, 0, 0, env.W, env.H);
    g.restore();
  }

  // 硬切：只在半程换画。trans.dur 给 0 时走这条（不给它留窗口）。
  T.cut = (g, A, B, p) => { blit(g, p < 0.5 ? A : B, 1, 0, 0, 1, { W: A.width, H: A.height }); };

  // 交叉溶解：最通用，讲理类片子默认用它
  T.fade = (g, A, B, p, e, env) => {
    blit(g, A, 1, 0, 0, 1, env);
    blit(g, B, e, 0, 0, 1, env);
  };

  // 经底色过渡（dip to color）：两段情绪差得远时用，比直接溶解干净
  // 用 e（缓动后）而不是 p：两端收放更软，中段不会「咔」一下全黑
  T.dip = (g, A, B, p, e, env) => {
    if (env.bg) {
      g.save();
      g.globalAlpha = 1;
      g.fillStyle = env.bg;
      g.fillRect(0, 0, env.W, env.H);
      g.restore();
    }
    if (e < 0.5) blit(g, A, 1 - e * 2, 0, 0, 1, env);
    else blit(g, B, (e - 0.5) * 2, 0, 0, 1, env);
  };

  // 推入：下一镜整块从右边推进来，上一镜留在下面不动（带一道分隔亮线，避免糊成一片）
  T.slide = (g, A, B, p, e, env) => {
    blit(g, A, 1, 0, 0, 1, env);
    const dx = env.W * (1 - e);
    blit(g, B, 1, dx, 0, 1, env);
    if (dx > 0.5) {
      g.save();
      g.globalAlpha = 0.16 * (1 - Math.abs(p - 0.5) * 2);
      g.fillStyle = env.edge || '#ffffff';
      g.fillRect(dx - 2 * (env.SF || 1), 0, 2 * (env.SF || 1), env.H);
      g.restore();
    }
  };

  // 推拉：两镜贴着一起走，中间没有缝（比 slide 更有「镜头在动」的感觉）
  T.push = (g, A, B, p, e, env) => {
    blit(g, A, 1, -env.W * e, 0, 1, env);
    blit(g, B, 1, env.W * (1 - e), 0, 1, env);
  };

  // 上推：下一镜从画面下方升起（竖屏 / 解说卡常用）
  T.rise = (g, A, B, p, e, env) => {
    blit(g, A, 1, 0, -env.H * 0.18 * e, 1, env);
    blit(g, B, 1, 0, env.H * (1 - e), 1, env);
  };

  // 变焦穿过：上一镜推近、下一镜从近处退回，视觉上是「一口气穿过去」
  T.zoom = (g, A, B, p, e, env) => {
    blit(g, A, 1, 0, 0, 1 + 0.26 * e, env);
    blit(g, B, e, 0, 0, 1.26 - 0.26 * e, env);
  };

  // 扫擦：下一镜被一条竖边揭开，边上带一道扫描亮线
  T.wipe = (g, A, B, p, e, env) => {
    blit(g, A, 1, 0, 0, 1, env);
    const x = env.W * e;
    if (x <= 0) return;
    g.save();
    g.beginPath();
    g.rect(0, 0, x, env.H);
    g.clip();
    g.drawImage(B, 0, 0, env.W, env.H);
    g.restore();
    const bw = 28 * (env.SF || 1);
    const grad = g.createLinearGradient(x - bw, 0, x, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(1, 'rgba(255,255,255,0.10)');
    g.save();
    g.globalAlpha = Math.sin(Math.PI * clamp(p)) * 0.9;
    g.fillStyle = grad;
    g.fillRect(Math.max(0, x - bw), 0, bw, env.H);
    g.restore();
  };

  const TRANSITIONS = T;
  const TRANS_NAMES = Object.keys(T).sort();

  /* ── 时间轴 ───────────────────────────────────────────────────── */

  /**
   * 把镜头表变成时间轴。
   *
   * 转场是**重叠**的：镜头 i 的入场转场占它自己开头的 trDur 秒，这段时间里
   * 上一镜走到自己的末尾 —— 所以总时长 = Σdur − Σ转场时长，镜头不会因此变长。
   *
   * @param {Array} shots  [{ id, dur, draw(g,lt,ctx), trans:{ in, dur } }]
   * @param {Object} opts  { lead 开场从底色淡入秒, tail 收尾淡出到底色秒,
   *                         trDur 默认转场时长, ease 转场缓动 }
   */
  function build(shots, opts = {}) {
    if (!Array.isArray(shots) || !shots.length) throw new Error('SC.build: 镜头表不能为空');
    const trDurDefault = opts.trDur != null ? opts.trDur : 0.5;
    const ease = opts.ease || outCubic;

    const list = shots.map((s, i) => {
      const dur = Number(s.dur);
      if (!isFinite(dur) || dur <= 0) throw new Error(`SC.build: 第 ${i + 1} 个镜头的 dur 不是正数（${s.dur}）`);
      if (typeof s.draw !== 'function') throw new Error(`SC.build: 第 ${i + 1} 个镜头没有 draw(g, lt, ctx)`);

      let name = 'cut';
      let tdur = 0;
      if (i > 0) {
        // 下一镜的 in 说了算；没写就看上一镜的 out；都没有才硬切
        const trIn = s.trans && s.trans.in;
        const trOut = shots[i - 1].trans && shots[i - 1].trans.out;
        name = trIn || trOut || 'cut';
        if (name !== 'cut') {
          tdur = s.trans && s.trans.dur != null ? s.trans.dur
            : (s.trans && s.trans.inDur != null ? s.trans.inDur : trDurDefault);
          tdur = Math.max(0, Math.min(tdur, Math.min(dur, shots[i - 1].dur) * 0.9));
          if (!(name in TRANSITIONS)) {
            throw new Error(`SC.build: 未知转场 "${name}"，可用：${TRANS_NAMES.join(' / ')}`);
          }
        }
      }
      return {
        index: i,
        id: s.id || `shot${i + 1}`,
        dur,
        draw: s.draw,
        transIn: name,
        transDur: name === 'cut' ? 0 : tdur,
        meta: s,
      };
    });

    // 起点：镜头 i 的开头与上一镜末尾重叠 trDur 秒
    let acc = 0;
    list.forEach((s, i) => {
      if (i > 0) acc -= s.transDur;
      s.start = acc;
      s.end = acc + s.dur;
      acc = s.end;
    });

    const lead = Math.max(0, Number(opts.lead) || 0);
    const tail = Math.max(0, Number(opts.tail) || 0);
    const tl = {
      shots: list,
      dur: acc,
      lead,
      tail,
      ease,
      _off: null,
    };
    return tl;
  }

  /** 时刻 t 落在哪个镜头、有没有在转场窗口里 */
  function at(tl, t) {
    const T0 = clamp(t, 0, tl.dur);
    const list = tl.shots;
    let i = 0;
    for (let k = 0; k < list.length; k++) {
      if (T0 >= list[k].start - 1e-9) i = k; else break;
    }
    const s = list[i];
    const lt = T0 - s.start;

    let tr = null;
    if (s.transDur > 0 && i > 0 && lt < s.transDur - 1e-9) {
      const prev = list[i - 1];
      tr = {
        name: s.transIn,
        // 上一镜在转场窗口里走完自己最后 transDur 秒
        a: i - 1, aLt: prev.dur - (s.transDur - lt),
        b: i, bLt: lt,
        p: lt / s.transDur,
      };
    }
    return { i, id: s.id, lt, dur: s.dur, start: s.start, end: s.end, shot: s, tr, t: T0, global: t };
  }

  /** 取（必要时新建）两张离屏画布；尺寸变了就重建 */
  function offscreens(tl, env) {
    if (typeof document === 'undefined') throw new Error('SC.paint 需要浏览器环境（离屏画布）');
    if (!tl._off) tl._off = [null, null];
    for (let k = 0; k < 2; k++) {
      let c = tl._off[k];
      if (!c) { c = document.createElement('canvas'); tl._off[k] = c; }
      if (c.width !== env.W || c.height !== env.H) { c.width = env.W; c.height = env.H; }
    }
    return tl._off;
  }

  /**
   * 把一个镜头画到指定上下文（离屏或主画布）。
   * @param {string} side 转场窗口里的身份：'a' 上一镜（正在退场）/ 'b' 下一镜（正在进场）/ null
   * @param {number} p    转场原始进度 0..1（不在转场窗口时为 0）
   */
  function paintShot(ctxOrCanvas, shot, lt, env, globalT, side, p) {
    const c = ctxOrCanvas;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.clearRect(0, 0, env.W, env.H);
    shot.draw(c, lt, {
      W: env.W, H: env.H, t: lt, dur: shot.dur, index: shot.index, id: shot.id, global: globalT,
      /* trans.dur > 0 表示这一镜是「带转场」进来的：转场本身已经在做透明度，
         镜头内部就别再来一遍整体淡入，否则两层叠起来前 0.3 秒会糊成一团。 */
      trans: { name: shot.transIn, dur: shot.transDur },
      /* 转场身份 + 进度：模板靠它做「退场把内容撤干净再让下一镜进来」。
         没有这个信息，两镜的标题会在同一位置叠成一团乱码 —— 这是文字类片子
         做交叉溶解最容易翻车的地方。 */
      role: { side: side || null, p: p || 0 },
      env,
    });
  }

  /**
   * 把 t 时刻的画面画到主画布 g。
   * 非转场帧走快路径（直接画到主画布），只有转场窗口才动用离屏合成。
   */
  function paint(g, tl, t, env) {
    const st = at(tl, t);
    env = env || {};
    const W = env.W, H = env.H;

    if (st.tr) {
      const [c1, c2] = offscreens(tl, env);
      const gA = c1.getContext('2d');
      const gB = c2.getContext('2d');
      paintShot(gA, tl.shots[st.tr.a], st.tr.aLt, env, st.t, 'a', st.tr.p);
      paintShot(gB, tl.shots[st.tr.b], st.tr.bLt, env, st.t, 'b', st.tr.p);

      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.clearRect(0, 0, W, H);
      if (env.bg) { g.fillStyle = env.bg; g.fillRect(0, 0, W, H); }
      TRANSITIONS[st.tr.name](g, c1, c2, st.tr.p, tl.ease(st.tr.p), env);
    } else {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.clearRect(0, 0, W, H);
      if (env.bg) { g.fillStyle = env.bg; g.fillRect(0, 0, W, H); }
      paintShot(g, st.shot, st.lt, env, st.t);
    }

    /* 开场淡入 / 收尾淡出：让片子有头有尾，不会「啪」地开始、啪地结束 */
    if (tl.lead > 0 && st.t < tl.lead) {
      g.save(); g.globalAlpha = 1 - st.t / tl.lead; g.fillStyle = env.bg; g.fillRect(0, 0, W, H); g.restore();
    }
    if (tl.tail > 0 && st.t > tl.dur - tl.tail) {
      g.save(); g.globalAlpha = 1 - (tl.dur - st.t) / tl.tail; g.fillStyle = env.bg; g.fillRect(0, 0, W, H); g.restore();
    }
    return st;
  }

  /** 镜头表挂到 window，供渲染器 --scene-log 导出 CSV 核对 */
  function expose(tl) {
    const table = tl.shots.map((s) => ({
      index: s.index, id: s.id, start: +s.start.toFixed(4), end: +s.end.toFixed(4),
      dur: +s.dur.toFixed(4), trans_in: s.transIn, trans_dur: +s.transDur.toFixed(4),
    }));
    if (typeof window !== 'undefined') window.__sceneTable = table;
    return table;
  }

  const SC = {
    build, at, paint, expose, paintShot,
    TRANSITIONS, TRANS_NAMES,
    ease: { linear, smooth, outCubic, inOutCubic },
    clamp, lerp,
  };

  root.SC = SC;
  if (typeof module === 'object' && module.exports) module.exports = SC;
})(typeof globalThis !== 'undefined' ? globalThis : this);
