/**
 * camera.js —— 两层 API：底层「运镜」，上层「镜头语言」
 *
 * ┌ 第一层：运镜（v1.3 起，稳定）
 * │   kenburns / breath / handheld / shake / static —— 用参数描述位移与缩放。
 * │   CAM.at(cam, t, W, H) → { dx, dy, scale, rot }（像素单位）
 * │   CAM.push/pop/withCam 套用与还原。
 * │   适合：让静止画面「活过来」，呼吸感、持续漂浮。
 * │
 * └ 第二层：镜头语言（v1.8 起）
 *     move() / begin() / end() —— 用**一行自然语言**描述一个镜头：
 *       'dolly in, 3s, slow ease-in-out'
 *       'pan, 5s, medium, left'  'handheld, 1'  'whip, 0.3s'  '推镜, 3s, 慢'
 *     12 个命名运动，每个对应一种「观众该感觉到什么」；5 种缓动，含 inertia。
 *     适合：把分镜表里写的那句话直接喂给渲染器，而不是翻译成 from/to 数组。
 *
 * 两层的区别：运镜是**参数**（从哪到哪），镜头语言是**意图**（推、摇、环绕）。
 * 前者灵活但要求你知道终点坐标；后者一句话就能对齐专业分镜的写法。
 *
 * 词汇与参数取自 cinecode 的 camera-moves.md / camera.mjs（MIT © 2026 Sarp Yıldız），
 * 重写为 Canvas 2D 的等价实现：同样的运动名、缓动与手感，输出是 2D 变换。
 *
 * 自带的手持抖动用的是**确定性伪噪声**（正弦叠加 + 固定种子），不是 Math.random()：
 *   · 同输入同输出，并行 worker 渲出来的帧完全一致
 *   · 抖动频率、幅度都能调，不会变成「地震」
 *
 * 用法（第一层）：
 *   <script src="../lib/camera.js"></script>
 *   const cam = CAM.kenburns({ from:[0.02,-0.01,1.00], to:[-0.03,0.02,1.08], ease:MO.smooth });
 *
 *   // 每帧：先铺底（运镜会露边），再套运镜画内容，最后收掉
 *   g.fillStyle = TH.bg; g.fillRect(0,0,W,H);
 *   const tr = CAM.at(cam, t, W, H);
 *   CAM.push(g, tr, W, H);
 *   drawContent(g);
 *   CAM.pop(g);
 *
 * 用法（第二层）：
 *   const cam = CAM.move(CFG.camera, t, DUR);          // 比例单位，无镜头时返回 null
 *   if (cam) CAM.begin(g, cam, W, H);                   // 内含 save()
 *   drawContent(g);
 *   if (cam) CAM.end(g);                                // 内含 restore()
 *
 * 约定：
 *   1. 运镜会把画面缩放/平移，**先铺满底色**再套运镜，否则边缘会露出黑边（或上一帧的残影）。
 *   2. 缩放 < 1 一定会露边。要「拉远」就先把内容画得比视口大（overscan 1.15 之类）。
 *      第二层已经替你解决了：move() 的所有运动都保证 scale ≥ 1，位移量按放大余量裁剪。
 *   3. 手持抖动幅度按经验取 3–8 px（1080p），超过 12 px 就开始晕。
 */
(function (root) {
  'use strict';

  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;

  /**
   * 确定性伪噪声，值域约 [-1, 1]。
   * 三个互质频率叠加，看起来不规则但完全可复现 —— 同一个 seed 每次跑都一样。
   */
  function noise(seed, t) {
    const s = (seed || 0) * 1.0;
    return (
      0.60 * Math.sin(t * 1.7 + s * 12.9898) +
      0.28 * Math.sin(t * 3.1 + s * 78.2330) +
      0.12 * Math.sin(t * 5.3 + s * 39.4250)
    );
  }

  /** 空变换（什么都不做） */
  const IDENTITY = { dx: 0, dy: 0, scale: 1, rot: 0 };

  /**
   * 求某时刻的变换。返回 { dx, dy, scale, rot }：
   *   dx/dy 像素位移（已按 W/H 归一化比例换算成像素）
   *   scale 缩放，rot 旋转弧度
   */
  function at(cam, t, W, H) {
    if (!cam) return { ...IDENTITY };
    const w = W || 1920, h = H || 1080;
    const ease = cam.ease || ((x) => x);
    // loop = 一个完整来回的周期（去了再回）：t=0 与 t=loop 取值相同，不会漂
    const p = cam.loop
      ? (() => {
          const q = (((t % cam.loop) + cam.loop) % cam.loop) / cam.loop;
          return q < 0.5 ? q * 2 : 2 - q * 2;
        })()
      : clamp((t - (cam.t0 || 0)) / (cam.dur || 1));
    const e = ease(p);
    const out = { dx: 0, dy: 0, scale: 1, rot: 0 };

    switch (cam.kind) {
      case 'kenburns': {
        const [x0, y0, s0] = cam.from || [0, 0, 1];
        const [x1, y1, s1] = cam.to || [0, 0, 1];
        // 位移按画面尺寸比例走，缩放直接插值
        out.dx = lerp(x0, x1, e) * w;
        out.dy = lerp(y0, y1, e) * h;
        out.scale = lerp(s0, s1, e);
        break;
      }
      case 'pan': {
        const [x0, y0] = cam.from || [0, 0];
        const [x1, y1] = cam.to || [0, 0];
        out.dx = lerp(x0, x1, e) * w;
        out.dy = lerp(y0, y1, e) * h;
        break;
      }
      case 'zoom': {
        const [cx, cy] = cam.center || [0, 0];
        out.scale = lerp(cam.from != null ? cam.from : 1, cam.to != null ? cam.to : 1.08, e);
        out.dx = cx * w; out.dy = cy * h;
        break;
      }
      case 'handheld': {
        const amp = cam.amp != null ? cam.amp : 5;         // 像素（1080p 基准）
        const freq = cam.freq != null ? cam.freq : 1.6;    // 抖动速度
        const seed = cam.seed != null ? cam.seed : 7;
        const k = (h / 1080) || 1;                          // 跟着分辨率放大，4K 不会变成微抖
        out.dx = noise(seed, t * freq) * amp * k;
        out.dy = noise(seed + 31, t * freq) * amp * k * 0.8;
        out.rot = noise(seed + 71, t * freq) * (cam.rotAmp != null ? cam.rotAmp : 0.0016);
        break;
      }
      case 'shake': {
        // 撞击 / 强调用的衰减震动：一起一落，衰减到 0（不是持续抖）
        const amp = cam.amp != null ? cam.amp : 14;
        const freq = cam.freq != null ? cam.freq : 3.4;
        const decay = cam.decay != null ? cam.decay : 5;
        const seed = cam.seed != null ? cam.seed : 3;
        const env = Math.exp(-decay * Math.max(0, t - (cam.t0 || 0)));
        const k = (h / 1080) || 1;
        out.dx = noise(seed, t * freq * 2.2) * amp * env * k;
        out.dy = noise(seed + 17, t * freq * 2.2) * amp * env * k;
        break;
      }
      case 'static':
      default:
        break;
    }
    return out;
  }

  /** 多个运镜叠加（顺序无关，逐项累加；scale 相乘） */
  function stack(cams, t, W, H) {
    const out = { dx: 0, dy: 0, scale: 1, rot: 0 };
    for (const c of cams || []) {
      const r = at(c, t, W, H);
      out.dx += r.dx; out.dy += r.dy; out.scale *= r.scale; out.rot += r.rot;
    }
    return out;
  }

  /** 套用变换：画内容之前调用，之后必须 pop */
  function push(g, tr, W, H) {
    g.save();
    if (!tr) return;
    g.translate(W / 2 + (tr.dx || 0), H / 2 + (tr.dy || 0));
    if (tr.rot) g.rotate(tr.rot);
    if (tr.scale && tr.scale !== 1) g.scale(tr.scale, tr.scale);
    g.translate(-W / 2, -H / 2);
  }

  function pop(g) { g.restore(); }

  /**
   * 一次性包裹：CAM.with(g, tr, W, H, () => { ...画内容... })
   * 忘了 pop 会让后续所有帧不断叠加变换 —— 用这个写法不会忘。
   */
  function withCam(g, tr, W, H, fn) { push(g, tr, W, H); try { fn(); } finally { pop(g); } }

  /** 推拉镜头（Ken Burns）的快捷构造 */
  function kenburns(opts) {
    return Object.assign({ kind: 'kenburns', from: [0.02, -0.01, 1.0], to: [-0.03, 0.015, 1.09], dur: 6 }, opts || {});
  }

  /**
   * 呼吸：极轻的持续缩放，专门治「画面死了」。
   * loop = 一个完整来回的秒数（默认 4.2s 去、4.2s 回）；
   * 幅度 1.4% 是经验值 —— 再大就看出「在缩放」而不是「在呼吸」。
   */
  function breath(opts) {
    return Object.assign({
      kind: 'zoom', from: 1.0, to: 1.014, dur: 4.2, loop: 4.2,
      ease: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
    }, opts || {});
  }

  /* =======================================================================
     第二层：镜头语言（v1.8）
     ======================================================================= */

  /* 缓动。inertia = 35% linear + 65% smoothstep：两端都还有速度。
     这是「镜头在动、切点也在动」的关键 —— 用 in-out 缓动，切点前一帧几乎静止，
     观众觉得"停住了"再切，节奏就散了。 */
  const EASE = {
    linear: (k) => k,
    in: (k) => k * k * k,
    out: (k) => 1 - Math.pow(1 - k, 3),
    inOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
    inertia: (k) => 0.35 * k + 0.65 * k * k * (3 - 2 * k),
  };

  /* 每个运动只回答一个问题：观众该感觉到什么。写分镜先想这个，再挑名字。 */
  const VOCAB = {
    dollyIn:   { cn: '推镜',     en: 'dolly in',           feel: '亲近、紧张、"这件事重要"',        def: { dur: 4,   ease: 'inertia' } },
    dollyOut:  { cn: '拉镜',     en: 'dolly out',          feel: '孤立、释放、交代环境',            def: { dur: 5,   ease: 'inOut' } },
    pan:       { cn: '横摇',     en: 'pan',                feel: '扫视、跟随、把两件事连起来',      def: { dur: 4,   ease: 'inertia' } },
    tilt:      { cn: '纵摇',     en: 'tilt',               feel: '仰视=敬畏，俯视=发现与重量',      def: { dur: 3.5, ease: 'inOut' } },
    orbit:     { cn: '环绕',     en: 'orbit',              feel: '审视、强调、英雄感',              def: { dur: 6,   ease: 'inertia' } },
    crane:     { cn: '升降',     en: 'crane',              feel: '希望、尺度、从上方揭示',          def: { dur: 5,   ease: 'inOut' } },
    handheld:  { cn: '手持',     en: 'handheld',           feel: '在场、紧迫、纪实',                def: { dur: null, ease: 'linear' } },
    dollyZoom: { cn: '变焦推拉', en: 'dolly zoom',         feel: '醒悟、不安、失真（一片只用一次）', def: { dur: 3.5, ease: 'inOut' } },
    rackFocus: { cn: '拉焦',     en: 'rack focus',         feel: '注意力从一处移到另一处',          def: { dur: 1.2, ease: 'inOut' } },
    whip:      { cn: '甩镜',     en: 'whip pan',           feel: '能量、跳切、喜剧',                def: { dur: 0.32, ease: 'inOut' } },
    pushTo:    { cn: '推近细节', en: 'push-in on detail',  feel: '"看这里"：线索、一个表情',        def: { dur: 3,   ease: 'inOut' } },
    static:    { cn: '固定',     en: 'locked off',         feel: '让主体或光自己动',                def: { dur: null, ease: 'linear' } },
  };

  /* 别名：中英文、常见写法、以及"用户脑子里那个词" */
  const ALIAS = {};
  const put = (names, id) => names.forEach((n) => { ALIAS[n] = id; });
  put(['dolly in', 'dolly-in', 'dollyin', 'push in', 'push-in', 'zoom in', 'push', '推镜', '推', '推进', '推近'], 'dollyIn');
  put(['dolly out', 'dolly-out', 'dollyout', 'pull back', 'pull-back', 'pullback', 'zoom out', '拉镜', '拉', '拉远', '后拉'], 'dollyOut');
  put(['pan', 'pan left', 'pan right', '横摇', '摇镜', '摇'], 'pan');
  put(['tilt', 'tilt up', 'tilt down', '纵摇', '俯仰', '抬头', '低头'], 'tilt');
  put(['orbit', 'arc', '环绕', '环绕镜头'], 'orbit');
  put(['crane', 'pedestal', 'rise', '升降', '升起', '降下'], 'crane');
  put(['handheld', 'hand-held', 'hand held', '手持', '手持感'], 'handheld');
  put(['dolly zoom', 'dolly-zoom', 'vertigo', '变焦推拉', '眩晕'], 'dollyZoom');
  put(['rack focus', 'rack-focus', 'focus pull', 'focus-pull', '拉焦', '移焦'], 'rackFocus');
  put(['whip', 'whip pan', 'whip-pan', '甩镜', '甩'], 'whip');
  put(['push to', 'push-to', '推近细节', '推向细节'], 'pushTo');
  put(['static', 'locked', 'locked off', 'still', '固定', '静止', '不动'], 'static');

  const EASE_ALIAS = {
    'linear': 'linear', '直线': 'linear',
    'ease-in': 'in', 'easein': 'in', 'in': 'in', '加速': 'in',
    'ease-out': 'out', 'easeout': 'out', 'out': 'out', '减速': 'out',
    'ease-in-out': 'inOut', 'easeinout': 'inOut', 'in-out': 'inOut', 'inout': 'inOut', '缓': 'inOut', '缓入缓出': 'inOut',
    'inertia': 'inertia', '惯性': 'inertia',
  };
  /* 速度词：改幅度，不改时长 */
  const SPEED_ALIAS = { slow: 0.6, medium: 1, fast: 1.55, 慢: 0.6, 中: 1, 快: 1.55 };
  const ANCHOR_ALIAS = {
    left: [0.3, 0.5], right: [0.7, 0.5], top: [0.5, 0.3], bottom: [0.5, 0.7],
    center: [0.5, 0.5], 左: [0.3, 0.5], 右: [0.7, 0.5], 上: [0.5, 0.3], 下: [0.5, 0.7], 中: [0.5, 0.5],
  };

  /* 解析一行 camera line。容错优先：这是给人写的自然语言，不是配置 ——
     一个拼错的速度词不该让整条片子渲不出来。 */
  function parseLine(line) {
    if (!line) return null;
    if (typeof line === 'object') {
      const id = ALIAS[String(line.move || '').toLowerCase()] || line.move;
      if (!VOCAB[id]) return null;
      return norm({ id, dur: line.dur, ease: line.ease, amount: line.amount, anchor: line.anchor });
    }
    const s = String(line).trim();
    if (!s) return null;
    const parts = s.split(/[,，;；]/).map((x) => x.trim()).filter(Boolean);
    let id = null, dur = null, ease = null, amount = null, anchor = null, bare = null;

    for (const raw of parts) {
      const low = raw.toLowerCase().replace(/\s+/g, ' ');
      if (!id && ALIAS[low]) { id = ALIAS[low]; continue; }
      /* 带单位的数字才是时长；裸数字先存着 —— 'handheld, 1' 里的 1 是幅度，
         'dolly in, 3' 里的 3 才是秒。到收尾时按运动类型决定。 */
      const md = /^(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds|秒)$/.exec(low);
      if (md) { dur = parseFloat(md[1]); continue; }
      const mb = /^(\d+(?:\.\d+)?)$/.exec(low);
      if (mb) { bare = parseFloat(mb[1]); continue; }
      let hit = false;
      for (const tok of low.split(/\s+/)) {
        if (!ease && EASE_ALIAS[tok]) { ease = EASE_ALIAS[tok]; hit = true; }
        else if (amount == null && SPEED_ALIAS[tok] != null) { amount = SPEED_ALIAS[tok]; hit = true; }
      }
      if (hit) continue;
      if (!anchor && ANCHOR_ALIAS[low]) { anchor = ANCHOR_ALIAS[low]; continue; }
      if (!id && ALIAS[low.replace(/ /g, '-')]) { id = ALIAS[low.replace(/ /g, '-')]; continue; }
      /* 其余词（"toward the figure" 这类目标描述）不参与计算 */
    }
    if (!id) return null;
    /* 裸数字的归属：手持/固定这类没有"时长"概念的运动，它表示幅度 */
    if (bare != null) {
      if (VOCAB[id].def.dur == null) { if (amount == null) amount = bare; }
      else if (dur == null) dur = bare;
    }
    return norm({ id, dur, ease, amount, anchor });
  }

  function norm(o) {
    const v = VOCAB[o.id];
    return {
      id: o.id,
      dur: o.dur != null ? Math.max(0.05, o.dur) : null,
      ease: o.ease || v.def.ease,
      amount: o.amount != null ? Math.max(0, o.amount) : 1,
      anchor: o.anchor || [0.5, 0.5],
    };
  }

  /* 手持用另一套 hash 噪声（第一层的 noise 是正弦叠加，适合"呼吸"，不适合"手"） */
  function hhash(i, seed) {
    const s = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
    return s - Math.floor(s);
  }
  function hnoise(x, seed) {
    const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    return hhash(i, seed) * (1 - u) + hhash(i + 1, seed) * u;
  }

  /* 求某时刻的镜头。返回 null = 这一帧没有镜头运动，调用方照旧画。
     tx/ty 是**比例**（0.02 = 画宽的 2%），begin() 再乘真实像素 ——
     这样同一份 CFG 换 1080p / 竖屏都不用改。 */
  function move(line, t, dur, opts) {
    opts = opts || {};
    const p = parseLine(line);
    if (!p || p.id === 'static') return null;

    const a = p.amount;
    const span = p.dur != null ? p.dur : (dur || 4);
    const k = clamp(t / Math.max(0.05, span), 0, 1);
    const e = (EASE[p.ease] || EASE.inOut)(k);
    const cam = { id: p.id, scale: 1, tx: 0, ty: 0, rot: 0, blur: 0, bgScale: 1, anchor: p.anchor.slice(), k, e };

    switch (p.id) {
      /* 推：0.14 是上限，再大就成了滑板变焦 */
      case 'dollyIn':
        cam.scale = 1 + 0.14 * a * e;
        break;
      /* 拉：不真的缩到 1 以下（会露边），而是"从略推近回到正常"，观感仍是拉远 */
      case 'dollyOut':
        cam.scale = 1 + 0.14 * a * (1 - e);
        break;
      /* 横摇/纵摇：位移量必须与放大余量精确相等，否则边缘露底 */
      case 'pan':
        cam.scale = 1 + 0.075 * a;
        cam.tx = (e - 0.5) * 0.075 * a;
        break;
      case 'tilt':
        cam.scale = 1 + 0.075 * a;
        cam.ty = (e - 0.5) * 0.075 * a;
        break;
      /* 环绕：平面做不出真视差，用"弧线位移 + 轻微旋转"暗示 2.5D */
      case 'orbit':
        cam.scale = 1 + 0.10 * a;
        cam.tx = Math.sin((e - 0.5) * Math.PI * 0.5) * 0.048 * a;
        cam.ty = Math.sin((e - 0.5) * Math.PI) * 0.012 * a;
        cam.rot = (e - 0.5) * 1.6 * a;
        break;
      case 'crane':
        cam.scale = 1 + 0.06 * a;
        cam.ty = (e - 0.5) * 0.054 * a;
        break;
      /* 变焦推拉：主体尺寸变、背景反向缩放。模板愿意分层时用 bgScale */
      case 'dollyZoom':
        cam.scale = 1 + 0.10 * a * e;
        cam.bgScale = 1 - 0.10 * a * e;
        break;
      /* 拉焦：落点清晰，中段最糊；opts.reverse 则从清晰到糊 */
      case 'rackFocus':
        cam.scale = 1 + 0.05 * a;
        cam.blur = 7 * a * (opts.reverse ? e : 1 - e) * Math.sin(Math.PI * Math.min(1, e * 1.15));
        break;
      /* 甩镜：极短、横向位移大、带运动模糊 */
      case 'whip': {
        const dir = opts.dir === -1 ? -1 : 1;
        cam.scale = 1 + 0.22 * a;
        cam.tx = dir * (e - 0.5) * 0.11 * a;
        cam.blur = 9 * a * Math.sin(Math.PI * e);
        break;
      }
      /* 推近细节：基准点从画面中心移到指定点，同时放大 */
      case 'pushTo': {
        const ax = opts.ax != null ? opts.ax : p.anchor[0];
        const ay = opts.ay != null ? opts.ay : p.anchor[1];
        cam.scale = 1 + 0.16 * a * e;
        cam.anchor = [0.5 + (ax - 0.5) * e, 0.5 + (ay - 0.5) * e];
        break;
      }
      /* 手持：低频漂移（0.25–1.1Hz），不是逐帧随机；幅度按画幅比例，很克制 */
      case 'handheld': {
        const n = (f, o) => 2 * hnoise(t * f + o, 7) - 1;
        cam.scale = 1 + 0.012 * a;
        cam.tx = a * (0.0026 * n(1.1, 0) + 0.0018 * n(0.3, 40));
        cam.ty = a * (0.0022 * n(1.0, 20) + 0.0014 * n(0.27, 60));
        cam.rot = a * 0.12 * n(0.8, 80);
        break;
      }
      default:
        return null;
    }

    /* 防露边：以中心为轴放大 scale 倍，最多能平移 (scale-1)/2 的画幅。
       任何组合超过这个量都会画到画布外 —— 露一条底色边，比不动还难看。 */
    const maxT = Math.max(0, (cam.scale - 1) / 2);
    cam.tx = clamp(cam.tx, -maxT, maxT);
    cam.ty = clamp(cam.ty, -maxT, maxT);
    cam.blur = clamp(cam.blur, 0, 10);
    return cam;
  }

  /* 套用 / 还原。begin 内含 save()，end 内含 restore()，成对使用不会污染状态 */
  function begin(g, cam, W, H) {
    if (!cam) return;
    const ax = cam.anchor[0] * W, ay = cam.anchor[1] * H;
    g.save();
    g.translate(ax + cam.tx * W, ay + cam.ty * H);
    g.scale(cam.scale, cam.scale);
    if (cam.rot) g.rotate((cam.rot * Math.PI) / 180);
    g.translate(-ax, -ay);
    /* ctx.filter 在 Chromium 支持，Safari 老版本没有 —— 没有就退化成"不糊"，
       宁可少一层效果，也不能因为滤镜缺失整帧渲不出来 */
    if (cam.blur > 0.4 && 'filter' in g) g.filter = `blur(${cam.blur.toFixed(2)}px)`;
  }
  function endCam(g) { g.restore(); }

  /* 时间重映射（慢动作 / 延时 / 定格）：输入 [[t, speed], ...]，速度在相邻点间线性过渡。
     [[0,1],[1.4,0.25]] = 1.4 秒内从常速降到 1/4 速。 */
  function retime(t, keys) {
    if (!keys || !keys.length) return t;
    let acc = 0, pt = 0, ps = keys[0][1];
    for (const kp of keys) {
      const kt = kp[0], ks = kp[1];
      if (kt > pt) {
        if (t <= kt) {
          const s = ps + ((ks - ps) * (t - pt)) / (kt - pt);
          return acc + ((t - pt) * (ps + s)) / 2;
        }
        acc += ((kt - pt) * (ps + ks)) / 2;
      }
      pt = kt; ps = ks;
    }
    return acc + (t - pt) * ps;
  }

  /* 给 CLI / 文档用 */
  function list() {
    return Object.keys(VOCAB).map((id) => ({
      id, cn: VOCAB[id].cn, en: VOCAB[id].en, feel: VOCAB[id].feel,
      dur: VOCAB[id].def.dur, ease: VOCAB[id].def.ease,
    }));
  }

  const CAM = {
    /* 第一层：运镜（参数式） */
    at, stack, push, pop, withCam, noise, kenburns, breath, IDENTITY, clamp, lerp,
    /* 第二层：镜头语言（意图式） */
    EASE, VOCAB, parseLine, move, begin, end: endCam, retime, list,
  };

  root.CAM = CAM;
  if (typeof module === 'object' && module.exports) module.exports = CAM;
})(typeof globalThis !== 'undefined' ? globalThis : this);
