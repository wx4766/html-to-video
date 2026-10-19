/**
 * 人物库 FIG —— 参数化的扁平矢量小人（讲解 / 演示 / 故事类片子的角色）。
 *
 * 为什么是「代码画的人」而不是预置人物图片包：
 *   1. 版权干净 —— 没有一张外部图，全是几何图形拼的
 *   2. 风格必然统一 —— 和 SH 图标库同一套圆角 / 线宽语言，配色跟着主题走
 *   3. 任意分辨率清晰，任意姿势 / 表情 / 配色可调 —— 图片包做不到
 *   4. 不占体积 —— 人物图片包动辄几十 MB，还会把仓库撑成二进制库
 *
 * 用法：
 *   <script src="../lib/figures.js"></script>
 *   FIG.draw(g, { x: W*0.5, y: H*0.82, h: 420, t, pose:'wave', mood:'happy',
 *                 hair:'pony', hairColor:'#3A2E2A', top:'#3B6EF6', bottom:'#232A3A' });
 *   // 或直接用预设
 *   FIG.draw(g, FIG.preset('dev', { x, y, h, t, pose:'wave' }));
 *
 * 坐标系：x/y 是**脚底中心**，h 是身高像素。内部按「身高 = 1」的归一化坐标画，
 * 所以换分辨率只要改 h，不用重算比例。
 *
 * 确定性：所有微动（呼吸、挥手、走路）都只吃传入的 t，不用随机数、不读时钟。
 */
(function (root) {
  'use strict';

  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const TAU = Math.PI * 2;

  /* 归一化身体比例（身高 = 1，y 从 0 头顶 到 1 脚底，x = 0 为身体中线） */
  const P = {
    headCY: 0.112, headR: 0.105,
    neckY0: 0.205, neckY1: 0.245,
    shoulderY: 0.255, waistY: 0.56,
    shoulderHW: 0.115, waistHW: 0.098,
    armTop: 0.275, armLen: 0.24,
    hipY: 0.55, footY: 0.955,
    legHW: 0.052,
  };

  const DEFAULTS = {
    x: 0, y: 0, h: 420, t: 0,
    skin: '#F0C39B',
    hair: 'short',          // short | buzz | pony | bun | long | bald
    hairColor: '#33302F',
    top: '#3B6EF6',         // 上衣
    topAlt: null,           // 上衣拼色（领口 / 袖子）
    bottom: '#232A3A',      // 下装
    shoe: '#151A24',
    accent: '#FFB86B',      // 围巾 / 徽章之类的点缀
    mood: 'happy',          // happy | smile | neutral | sad | surprised | think
    look: 0,                // -1 看左 … +1 看右
    pose: 'idle',           // idle | wave | point | present | think | walk
    flip: false,
    outline: null,          // 给个颜色就加描边（浅色背景上更清楚）
    outlineWidth: 0,
    alpha: 1,
    shadow: true,
    glasses: false,
  };

  /** 三个开箱预设（够用，别再做第四个 —— 参数调一下就行） */
  const PRESETS = {
    guide:  { hair: 'short', hairColor: '#33302F', top: '#3B6EF6', bottom: '#232A3A', mood: 'happy',   accent: '#FFB86B' },
    dev:    { hair: 'buzz',  hairColor: '#2B2B33', top: '#2F3A52', bottom: '#1B2130', mood: 'smile',   glasses: true, accent: '#4ADE80' },
    host:   { hair: 'pony',  hairColor: '#4A2F2A', top: '#E0574F', bottom: '#2A2230', mood: 'happy',   accent: '#FFD166' },
    teacher:{ hair: 'bun',   hairColor: '#3A2E2A', top: '#5B8C5A', bottom: '#2C3327', mood: 'smile',   glasses: true, accent: '#F2E8CF' },
  };

  function preset(name, over = {}) {
    const base = PRESETS[name] || PRESETS.guide;
    return Object.assign({ pose: 'idle' }, DEFAULTS, base, over);
  }

  /* ── 局部小工具（都在归一化坐标里画） ───────────────────────────── */

  function ell(g, cx, cy, rx, ry, fill, lw, stroke) {
    g.beginPath();
    g.ellipse(cx, cy, Math.max(0, rx), Math.max(0, ry), 0, 0, TAU);
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); }
  }

  function limb(g, x0, y0, x1, y1, w, color, round = true) {
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.strokeStyle = color;
    g.lineWidth = w;
    g.lineCap = round ? 'round' : 'butt';
    g.stroke();
  }

  /** 颜色变暗 / 变亮：k<0 往黑混，k>0 往白混（0..1）。
   *  用途：手臂和上衣同色时，「手」会像浮在衣服上的色块 —— 袖子必须差一档亮度。 */
  function shade(hex, k) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    const to = k < 0 ? 0 : 255;
    const a = Math.min(1, Math.abs(k));
    const mix = (v) => Math.round(v + (to - v) * a);
    return '#' + [(n >> 16) & 255, (n >> 8) & 255, n & 255]
      .map((v) => mix(v).toString(16).padStart(2, '0')).join('');
  }

  /** 躯干：上宽下窄的圆角梯形，带肩线 */
  function torso(g, o, breath) {
    const { shoulderY, waistY, shoulderHW, waistHW } = P;
    const sh = shoulderHW * (1 + breath * 0.5);
    g.beginPath();
    g.moveTo(-sh, shoulderY + 0.03);
    g.quadraticCurveTo(-sh - 0.012, shoulderY - 0.005, -sh * 0.62, shoulderY - 0.012);
    g.lineTo(sh * 0.62, shoulderY - 0.012);
    g.quadraticCurveTo(sh + 0.012, shoulderY - 0.005, sh, shoulderY + 0.03);
    g.quadraticCurveTo(sh + 0.006, waistY * 0.72, waistHW, waistY);
    g.lineTo(-waistHW, waistY);
    g.quadraticCurveTo(-sh - 0.006, waistY * 0.72, -sh, shoulderY + 0.03);
    g.closePath();
    g.fillStyle = o.top;
    g.fill();
    if (o.topAlt) {
      // 领口拼色：一条横带，让衣服不像一块纯色板
      g.save();
      g.clip();
      g.fillStyle = o.topAlt;
      g.fillRect(-0.2, shoulderY - 0.015, 0.4, 0.045);
      g.restore();
    }
  }

  /** 短发底：一顶盖住上半球的实心「帽子」。
   *
   *  两个坑都踩过：
   *  1. 早期用 arc + closePath 画月牙，闭合弦让填充变成一条细带 → 像顶了个发网。
   *  2. 之后改成「上半圆 + 发际线曲线」，但参数语义写成「往下压多深」，
   *     算出来的发际线落在眼睛下面（眼睛在 headCY+0.04R），整个人像戴了顶
   *     压到眼皮的黑头盔。现在参数统一成 **fringe = 发际线相对头心的高度**
   *     （单位 headR，负值在上），眉毛在 -0.30R，所以默认 -0.30 才不挡脸。
   */
  function hairCap(g, o, fringe) {
    const { headCY, headR } = P;
    const r = headR * 1.04;
    const fy = headCY + headR * (fringe != null ? fringe : -0.30);
    /* 鬓角要往下包到耳上（头心 +0.35R），只在头心高度收边会露头皮，
       看着像一顶浮在头顶的小帽子。 */
    const a = 0.36;
    const sx = Math.cos(a), sy = Math.sin(a);
    g.beginPath();
    g.arc(0, headCY, r, Math.PI + a, Math.PI * 2 - a);   // 左鬓 → 头顶 → 右鬓
    g.quadraticCurveTo(r * 0.86, fy + headR * 0.12, r * 0.26, fy);
    g.quadraticCurveTo(-r * 0.42, fy - headR * 0.02, -r * sx, headCY + r * sy);
    g.closePath();
    g.fillStyle = o.hairColor;
    g.fill();
  }

  function hairBack(g, o) {
    const { headCY, headR } = P;
    if (o.hair === 'bald') return;
    if (o.hair === 'long') {
      g.beginPath();
      g.moveTo(-headR * 1.04, headCY - headR * 0.10);
      g.quadraticCurveTo(-headR * 1.30, headCY + headR * 1.35, -headR * 0.80, headCY + headR * 1.52);
      g.lineTo(headR * 0.80, headCY + headR * 1.52);
      g.quadraticCurveTo(headR * 1.30, headCY + headR * 1.35, headR * 1.04, headCY - headR * 0.10);
      g.closePath();
      g.fillStyle = o.hairColor;
      g.fill();
      return;
    }
    if (o.hair === 'pony') {
      // 侧马尾：一条从耳后垂下来的弧带，比一个圆点更像头发
      g.beginPath();
      g.moveTo(headR * 0.86, headCY - headR * 0.34);
      g.quadraticCurveTo(headR * 1.55, headCY + headR * 0.30, headR * 1.12, headCY + headR * 1.05);
      g.quadraticCurveTo(headR * 0.98, headCY + headR * 0.55, headR * 0.74, headCY + headR * 0.02);
      g.closePath();
      g.fillStyle = o.hairColor;
      g.fill();
      ell(g, headR * 0.98, headCY - headR * 0.34, headR * 0.20, headR * 0.16, o.hairColor);
      return;
    }
    if (o.hair === 'bun') {
      ell(g, 0, headCY - headR * 1.12, headR * 0.40, headR * 0.34, o.hairColor);
    }
  }

  function hairFront(g, o) {
    const { headCY, headR } = P;
    if (o.hair === 'bald') return;

    if (o.hair === 'buzz') { hairCap(g, o, -0.38); return; }
    if (o.hair === 'bun' || o.hair === 'pony') { hairCap(g, o, -0.31); return; }

    // short / long：刘海偏一侧
    hairCap(g, o, -0.27);
    g.save();
    g.globalAlpha = 0.20;
    g.beginPath();
    g.moveTo(-headR * 0.14, headCY - headR * 0.92);
    g.quadraticCurveTo(headR * 0.10, headCY - headR * 0.62, headR * 0.52, headCY - headR * 0.24);
    g.strokeStyle = '#000';
    g.lineWidth = headR * 0.14;
    g.lineCap = 'round';
    g.stroke();
    g.restore();
  }

  function face(g, o, t) {
    const { headCY, headR } = P;
    const look = clamp(o.look || 0, -1, 1);
    const ex = headR * 0.36 + look * headR * 0.10;   // 眼睛随视线平移
    const ey = headCY + headR * 0.04;
    const blink = (() => {                            // 眨眼：周期性，确定性
      const c = (t * 0.28) % 1;
      return c > 0.965 ? 1 : 0;
    })();

    // 眼睛
    const er = headR * (blink ? 0.03 : 0.085);
    ell(g, -ex, ey, er, blink ? er * 0.35 : er * 1.15, '#26262E');
    ell(g, ex, ey, er, blink ? er * 0.35 : er * 1.15, '#26262E');
    if (!blink) {
      ell(g, -ex + headR * 0.02, ey - headR * 0.03, er * 0.32, er * 0.32, 'rgba(255,255,255,.9)');
      ell(g, ex + headR * 0.02, ey - headR * 0.03, er * 0.32, er * 0.32, 'rgba(255,255,255,.9)');
    }

    // 眉毛：情绪主要靠它
    const bx = ex, by = ey - headR * 0.34;
    g.save();
    g.strokeStyle = o.hairColor;
    g.lineWidth = headR * 0.09;
    g.lineCap = 'round';
    const browTilt = o.mood === 'sad' ? 0.16 : o.mood === 'surprised' ? -0.10 : o.mood === 'think' ? 0.14 : -0.04;
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(s * bx - headR * 0.11, by + browTilt * headR * (s > 0 ? 1 : -1) * -1);
      g.quadraticCurveTo(s * bx, by - headR * (0.08 + (o.mood === 'surprised' ? 0.08 : 0)),
        s * bx + headR * 0.11, by + browTilt * headR * (s > 0 ? 1 : -1));
      g.stroke();
    }
    g.restore();

    // 嘴
    const my = headCY + headR * 0.44;
    g.save();
    g.strokeStyle = '#8A4B44';
    g.lineWidth = headR * 0.075;
    g.lineCap = 'round';
    g.beginPath();
    if (o.mood === 'happy') {
      g.moveTo(-headR * 0.22, my - headR * 0.02);
      g.quadraticCurveTo(0, my + headR * 0.22, headR * 0.22, my - headR * 0.02);
      g.stroke();
    } else if (o.mood === 'smile') {
      g.moveTo(-headR * 0.18, my);
      g.quadraticCurveTo(0, my + headR * 0.12, headR * 0.18, my);
      g.stroke();
    } else if (o.mood === 'sad') {
      g.moveTo(-headR * 0.18, my + headR * 0.08);
      g.quadraticCurveTo(0, my - headR * 0.12, headR * 0.18, my + headR * 0.08);
      g.stroke();
    } else if (o.mood === 'surprised') {
      ell(g, 0, my + headR * 0.02, headR * 0.13, headR * 0.16, '#8A4B44');
    } else {
      g.moveTo(-headR * 0.14, my);
      g.lineTo(headR * 0.14, my);
      g.stroke();
    }
    g.restore();

    // 腮红：只给开心的
    if (o.mood === 'happy') {
      g.save();
      g.globalAlpha = 0.16;
      ell(g, -headR * 0.62, headCY + headR * 0.22, headR * 0.16, headR * 0.10, '#FF7A7A');
      ell(g, headR * 0.62, headCY + headR * 0.22, headR * 0.16, headR * 0.10, '#FF7A7A');
      g.restore();
    }

    if (o.glasses) {
      g.save();
      const lr = headR * 0.175;
      g.strokeStyle = 'rgba(46,50,64,.9)';
      g.lineWidth = headR * 0.055;
      for (const s of [-1, 1]) {
        g.beginPath();
        g.arc(s * ex, ey, lr, 0, TAU);
        g.fillStyle = 'rgba(255,255,255,.10)';
        g.fill();
        g.stroke();
      }
      g.beginPath();
      g.moveTo(-ex + lr, ey);
      g.lineTo(ex - lr, ey);
      g.stroke();
      g.restore();
    }
  }

  /**
   * 画一个人。
   * @param {CanvasRenderingContext2D} g
   * @param {object} o 见 DEFAULTS；pose / mood / hair / t 是常用几个
   */
  function draw(g, o = {}) {
    const c = Object.assign({}, DEFAULTS, o);
    const t = c.t || 0;
    const h = Math.max(1, c.h);

    g.save();
    g.globalAlpha = c.alpha;
    g.translate(c.x, c.y - h);
    g.scale(c.flip ? -h : h, h);
    g.lineJoin = 'round';

    /* 呼吸 + 轻微重心摆动：画面不会「死」 */
    const breath = Math.sin(t * 1.9) * 0.012;
    const sway = Math.sin(t * 0.9) * 0.006;

    if (c.shadow) {
      g.save();
      g.globalAlpha = c.alpha * 0.20;
      ell(g, 0, P.footY + 0.02, 0.16, 0.026, '#000');
      g.restore();
    }

    /* 腿 */
    const walk = c.pose === 'walk' ? Math.sin(t * 5.2) : 0;
    for (const s of [-1, 1]) {
      const swing = walk * (s === 1 ? 1 : -1);
      const hipX = s * P.legHW, hipY = P.hipY;
      const kneeX = hipX + swing * 0.03, kneeY = P.hipY + 0.20;
      const footX = hipX + swing * 0.075, footY = P.footY - Math.abs(swing) * 0.02;
      limb(g, hipX, hipY, kneeX, kneeY, 0.080, c.bottom);
      limb(g, kneeX, kneeY, footX, footY, 0.070, c.bottom);
      ell(g, footX + s * 0.012, footY + 0.012, 0.046, 0.026, c.shoe);
    }

    /* 躯干（呼吸让肩线上下一点点） */
    g.save();
    g.translate(sway, breath * 0.4);
    torso(g, c, breath);

    /* 手臂：pose 决定姿态 */
    const shY = P.armTop;
    const armW = 0.072;
    /* 袖子比上衣暗一档：不暗的话，垂下来的手臂整条融进上衣里，
       只剩一只肤色的手贴在胯边 —— 看着像「浮在身上的色块」。 */
    const sleeve = c.topAlt || shade(c.top, -0.14);
    const armSwing = walk * 0.6;
    const waveT = t;
    for (const s of [-1, 1]) {
      const sx = s * (P.shoulderHW - 0.012);
      let ex, ey, mx, my;
      if (c.pose === 'wave' && s === 1) {
        ex = sx + 0.085; ey = shY - 0.20 + Math.sin(waveT * 6.0) * 0.018;
        mx = sx + 0.115; my = shY - 0.095;
      } else if (c.pose === 'point' && s === 1) {
        ex = sx + 0.135; ey = shY + 0.055;
        mx = sx + 0.075; my = shY + 0.075;
      } else if (c.pose === 'present') {
        ex = sx + s * 0.075; ey = shY + 0.10;
        mx = sx + s * 0.085; my = shY + 0.055;
      } else if (c.pose === 'think' && s === 1) {
        ex = -0.02; ey = P.headCY + P.headR * 0.55;
        mx = sx + 0.02; my = shY + 0.02;
      } else {
        // 垂手：往外撇 0.05，袖口要露在躯干轮廓外，手才不会孤零零的
        ex = sx + s * 0.050 + armSwing * (s === 1 ? 1 : -1) * 0.02;
        ey = shY + 0.215 - Math.abs(armSwing) * 0.01;
        mx = sx + s * 0.062; my = shY + 0.115;
      }
      // 两段画（肩→肘→手），比一条直线自然
      g.beginPath();
      g.moveTo(sx, shY);
      g.quadraticCurveTo(mx, my, ex, ey);
      g.strokeStyle = sleeve;
      g.lineWidth = armW;
      g.lineCap = 'round';
      g.stroke();
      // 手：比袖口小一圈，压一道同色系深边 —— 纯肤色圆点贴在袖子上会看成「球」
      ell(g, ex, ey, 0.030, 0.034, c.skin, 0.008, shade(c.skin, -0.30));
    }

    /* 脖子 + 头 */
    g.fillStyle = c.skin;
    g.fillRect(-0.028, P.neckY0, 0.056, P.neckY1 - P.neckY0 + 0.01);

    const headBob = Math.sin(t * 1.9 + 0.6) * 0.004;
    g.save();
    g.translate(0, headBob);
    hairBack(g, c);
    ell(g, 0, P.headCY, P.headR, P.headR * 1.06, c.skin);
    hairFront(g, c);
    face(g, c, t);
    g.restore();

    g.restore();   // 躯干 translate
    g.restore();   // 全局
    return c;
  }

  /** 量文字宽度并在超宽时缩字号（气泡里的正文用） */
  function fitFont(g, text, px, maxW, fontOf) {
    g.save();
    g.font = fontOf(px);
    const w = g.measureText(text).width;
    g.restore();
    if (w <= maxW || w <= 0) return px;
    return Math.max(px * 0.55, px * maxW / w);
  }

  /**
   * 对话气泡（画框 + 尾巴 + 文字）。
   * @param {object} box  { x, y, w, h } 气泡框（tail 朝左下，默认指向说话人）
   */
  function say(g, box, lines, o = {}) {
    const r = o.radius != null ? o.radius : 18;
    const padX = o.padX != null ? o.padX : 26;
    const basePx = o.size != null ? o.size : 28;
    const SANS = o.font || '"Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
    const list = Array.isArray(lines) ? lines : String(lines == null ? '' : lines).split('\n');

    g.save();
    if (o.shadow) {
      g.shadowColor = o.shadow;
      g.shadowBlur = 26;
      g.shadowOffsetY = 8;
    }
    g.beginPath();
    g.moveTo(box.x + r, box.y);
    g.arcTo(box.x + box.w, box.y, box.x + box.w, box.y + box.h, r);
    g.arcTo(box.x + box.w, box.y + box.h, box.x, box.y + box.h, r);
    g.arcTo(box.x, box.y + box.h, box.x, box.y, r);
    g.arcTo(box.x, box.y, box.x + box.w, box.y, r);
    g.closePath();
    g.fillStyle = o.fill || 'rgba(255,255,255,.94)';
    g.fill();
    g.shadowColor = 'transparent'; g.shadowBlur = 0; g.shadowOffsetY = 0;
    if (o.stroke) { g.strokeStyle = o.stroke; g.lineWidth = o.width || 1.5; g.stroke(); }
    g.restore();

    /* 尾巴：一个小三角，默认从气泡左下角指向说话人 */
    if (o.tail !== false) {
      const tx = o.tailX != null ? o.tailX : box.x + box.w * 0.22;
      const size = o.tailSize != null ? o.tailSize : Math.min(28, box.h * 0.32);
      /* tailLean：尾巴尖往哪偏。-1 = 指向左下（人物在气泡左边时用），
         +1 = 指向右下，0 = 正下方。默认 +0.1 略偏右。 */
      const lean = o.tailLean != null ? o.tailLean : 0.1;
      g.save();
      g.fillStyle = o.fill || 'rgba(255,255,255,.94)';
      g.beginPath();
      if (o.tailSide === 'left') {
        // 气泡在人物右侧时用：尾巴长在左边缘，指向说话的人
        const ty = o.tailY != null ? o.tailY : box.y + box.h * 0.55;
        g.moveTo(box.x, ty);
        g.lineTo(box.x - size, ty + size * (0.18 + lean * 0.15));
        g.lineTo(box.x, ty + size * 0.9);
      } else if (o.tailSide === 'right') {
        const ty = o.tailY != null ? o.tailY : box.y + box.h * 0.55;
        g.moveTo(box.x + box.w, ty);
        g.lineTo(box.x + box.w + size, ty + size * (0.18 + lean * 0.15));
        g.lineTo(box.x + box.w, ty + size * 0.9);
      } else if (o.tailSide === 'top') {
        g.moveTo(tx, box.y);
        g.lineTo(tx + size * (0.55 + lean * 0.5), box.y - size);
        g.lineTo(tx + size * 1.05, box.y);
      } else {
        g.moveTo(tx, box.y + box.h);
        g.lineTo(tx + size * (0.55 + lean * 0.5), box.y + box.h + size);
        g.lineTo(tx + size * 1.05, box.y + box.h);
      }
      g.closePath();
      g.fill();
      g.restore();
    }

    /* 正文 */
    const lh = basePx * (o.lineHeight != null ? o.lineHeight : 1.45);
    const total = lh * list.length;
    let y = box.y + box.h / 2 - total / 2 + basePx * 0.72;
    g.save();
    g.fillStyle = o.color || '#1A1E26';
    g.textAlign = o.align || 'center';
    const tx = o.align === 'left' ? box.x + padX : box.x + box.w / 2;
    for (const raw of list) {
      const px = fitFont(g, raw, basePx, box.w - padX * 2, (p) => `${o.weight || 500} ${p}px ${SANS}`);
      g.font = `${o.weight || 500} ${px}px ${SANS}`;
      g.fillText(raw, tx, y);
      y += lh;
    }
    g.restore();
    return box;
  }

  const FIG = { draw, say, preset, PRESETS, DEFAULTS, P, fitFont, ell, limb, shade };

  root.FIG = FIG;
  if (typeof module === 'object' && module.exports) module.exports = FIG;
})(typeof globalThis !== 'undefined' ? globalThis : this);
