/* =========================================================================
   promo-main.js — 横屏主片（1920×1080 / 30fps / 32.6s / 七镜头）
   本片自身就是 html-to-video 的输出：画面 = frame(t) 的纯函数。
   渲染：node scripts/render-video-seek.js docs/promo/promo-zh.html ...
   ========================================================================= */
(function () {
  'use strict';

  const PL = window.PL;
  const C = PL.C, F = PL.F, TAU = PL.TAU;
  const CP = window.__PROMO_COPY || window.PROMO_COPY.zh;
  const BODY = F[CP.font];

  const W0 = 1920, H0 = 1080;
  const cv = document.getElementById('stage');
  const W = window.innerWidth, H = window.innerHeight;
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d', { alpha: false });

  /* 镜头表：非重叠时间轴 + 每镜自身淡入淡出（经底色过渡，文字不叠字） */
  const SHOTS = [
    { id: 'hook',  dur: 3.6 },
    { id: 'code',  dur: 4.8 },
    { id: 'det',   dur: 4.8 },
    { id: 'ratio', dur: 5.8 },
    { id: 'auto',  dur: 5.2 },
    { id: 'self',  dur: 4.6 },
    { id: 'cta',   dur: 3.8 },
  ];
  let acc = 0;
  for (const s of SHOTS) { s.start = acc; acc += s.dur; }
  const DUR = acc;                       // 32.6
  const CUTS = SHOTS.slice(1).map(s => s.start);

  function shotAt(t) {
    for (let i = SHOTS.length - 1; i >= 0; i--) {
      if (t >= SHOTS[i].start) return { i, lt: t - SHOTS[i].start, s: SHOTS[i] };
    }
    return { i: 0, lt: 0, s: SHOTS[0] };
  }

  /* ── 通用小件 ─────────────────────────────────────────────────────── */
  function sectionHead(y, tag, title, sub, lt) {
    const a = PL.at(lt, 0.05, 0.5);
    PL.chip(g, tag, 140, y, { size: 16, h: 34 });
    PL.text(g, title, 140, y + 112, {
      size: 56, weight: 700, font: BODY, color: C.ink,
      alpha: a, maxW: W0 - 280,
    });
    PL.text(g, sub, 140, y + 158, {
      size: 23, font: BODY, color: C.sub, alpha: PL.at(lt, 0.22, 0.6), maxW: W0 - 280,
    });
  }

  function cmdBar(x, y, w, s, lt, delay) {
    const a = PL.at(lt, delay || 0, 0.55);
    const e = PL.at(lt, delay || 0, 0.7, PL.expoOut);
    g.save();
    g.globalAlpha *= a;
    g.translate(0, (1 - e) * 26);
    PL.panel(g, x, y, w, 64, { r: 12, fill: 'rgba(6,9,16,0.9)', stroke: 'rgba(255,255,255,0.13)' });
    // 左侧竖条：干净的强调，不用整块渐变（整块渐变会在命令框里糊出一个脏色块）
    g.fillStyle = C.accent;
    PL.rr(g, x + 2, y + 15, 3, 34, 2); g.fill();
    PL.text(g, '$', x + 26, y + 42, { size: 24, font: F.mono, color: C.accent });
    PL.text(g, s, x + 58, y + 41, {
      size: 24, font: F.mono, color: 'rgba(242,246,255,0.90)', maxW: w - 100,
    });
    // 右端一个呼吸光标，保持画面「活」
    g.fillStyle = PL.rgba(C.accent, 0.30 + 0.35 * (0.5 + 0.5 * Math.sin(lt * 5)));
    g.fillRect(x + w - 30, y + 24, 2, 18);
    g.restore();
  }

  /* ── 镜头 1：痛点钩子 ─────────────────────────────────────────────── */
  function shotHook(lt, t) {
    const cmdReveal = PL.at(lt, 0.04, 0.72);
    const exit = PL.at(lt, 1.12, 0.40);
    const keep = 1 - exit;

    // 0 秒三件东西同时在场：品牌、一句冲突陈述、正在失败的终端。
    // 独立审片指出前 3 秒信息密度低（主问句原来要等到 2.10s 才出现），
    // B站技术区这个时间已经流失一半观众了，这里整体前移约 1 秒。
    PL.text(g, CP.lang === 'zh' ? 'html-to-video · 一种不同的做法' : 'html-to-video · a different approach',
      W0 / 2, 150, {
        size: 20, font: BODY, color: C.sub, align: 'center',
        alpha: PL.at(lt, 0, 0.30),
      });
    PL.text(g, CP.hookKicker, W0 / 2, 214, {
      size: 22, font: BODY, color: C.accent, align: 'center',
      alpha: PL.at(lt, 0.02, 0.34), maxW: W0 - 240, track: 0.5,
    });

    // 终端里的一行命令 + 三条失败反馈 + 递增重试次数
    g.save();
    g.globalAlpha *= keep;
    g.translate(0, -exit * 46);
    const bx = 500, by = 252, bw = 920, bh = 268;
    PL.panel(g, bx, by, bw, bh, { r: 16, fill: 'rgba(6,9,16,0.82)', stroke: 'rgba(255,255,255,0.12)' });
    PL.text(g, '>', bx + 34, by + 62, { size: 30, font: F.mono, color: C.accent });
    const shown = CP.hookCmd.slice(0, Math.floor(cmdReveal * CP.hookCmd.length));
    PL.text(g, shown, bx + 68, by + 62, { size: 30, font: F.mono, color: C.ink });
    if (cmdReveal < 1 && shown.length > 2) {
      g.fillStyle = C.accent;
      g.fillRect(bx + 72 + shown.length * 18, by + 38, 2, 30);
    }
    // 重试计数：把「抽卡」的荒谬量化出来，且是 t 的纯函数
    const attempt = 8 + Math.floor(lt * 13);
    PL.text(g, 'attempt #' + attempt, bx + bw - 34, by + 62, {
      size: 22, font: F.mono, color: C.bad, align: 'right',
      alpha: PL.at(lt, 0.02, 0.30),
    });
    for (let i = 0; i < CP.hookFail.length; i++) {
      const a = PL.at(lt, 0.10 + i * 0.13, 0.24);
      if (a <= 0) continue;
      const yy = by + 132 + i * 44;
      g.save(); g.globalAlpha *= a;
      g.fillStyle = C.bad;
      g.fillRect(bx + 46, yy - 9, 7, 7);
      PL.text(g, CP.hookFail[i], bx + 68, yy, { size: 23, font: BODY, color: C.bad });
      g.restore();
    }
    g.restore();

    // 主问句砸入（与终端做交叉溶解：痛点被答案顶掉）
    const inA = PL.at(lt, 1.15, 0.62, PL.expoOut);
    if (inA > 0) {
      g.save();
      g.globalAlpha *= inA;
      const dy = (1 - inA) * 46;
      PL.text(g, CP.hookTitle, W0 / 2, 470 + dy, {
        size: 92, weight: 700, font: BODY, color: C.ink, align: 'center',
        maxW: W0 - 200, track: 2, shadow: 'rgba(124,156,255,0.16)', shadowBlur: 40,
      });
      PL.text(g, CP.hookTitle2, W0 / 2, 590 + dy, {
        size: 92, weight: 700, font: BODY, color: C.accent, align: 'center',
        maxW: W0 - 200, track: 2, shadow: 'rgba(255,184,107,0.22)', shadowBlur: 44,
      });
      g.restore();
    }
    // 下划线 + 副标题
    const u = PL.at(lt, 1.62, 0.62, PL.expoOut);
    g.save();
    g.globalAlpha *= u;
    g.fillStyle = C.accent;
    g.fillRect(W0 / 2 - 190 * u, 636, 380 * u, 3);
    PL.text(g, CP.hookSub, W0 / 2, 700, {
      size: 25, font: BODY, color: C.sub, align: 'center', maxW: W0 - 240,
    });
    g.restore();
  }

  /* ── 镜头 2：代码长成画面 ─────────────────────────────────────────── */
  function shotCode(lt, t) {
    sectionHead(92, CP.s2Tag, CP.s2Title, CP.s2Sub, lt);
    const reveal = PL.at(lt, 0.28, 2.30, PL.expoOut);
    const p = PL.expoOut(PL.seg(reveal, 0, 1));

    const cx = 140, cy = 300, cw = 760, ch = 560;
    const px = 1020, py = 300, pw = 760, ph = 560;
    PL.codeBox(g, cx, cy, cw, ch, CP.s2Code, reveal, { size: 21, lineH: 40, title: 'frame.js' });
    // 用一行注释填满代码框下半部，同时把「确定性」这条主张再说一遍
    PL.text(g, '// no Math.random() · no Date.now()', cx + 62, cy + ch - 54, {
      size: 18, font: F.mono, color: 'rgba(242,246,255,0.54)',
      alpha: PL.at(lt, 1.4, 0.5),
    });

    // 连接线 + 流动光点
    g.save();
    g.strokeStyle = 'rgba(255,184,107,0.30)';
    g.lineWidth = 1.5;
    g.setLineDash([7, 9]);
    g.beginPath(); g.moveTo(cx + cw + 10, cy + ch / 2); g.lineTo(px - 10, cy + ch / 2); g.stroke();
    g.setLineDash([]);
    for (let i = 0; i < 3; i++) {
      const q = ((lt * 0.55 + i / 3) % 1);
      const x = cx + cw + 10 + q * (px - cx - cw - 20);
      g.fillStyle = PL.rgba(C.accent, 0.9 * Math.sin(Math.PI * q));
      g.beginPath(); g.arc(x, cy + ch / 2, 4.5, 0, TAU); g.fill();
    }
    g.restore();

    // 预览窗口：与代码里的 fillRect 完全对应
    PL.panel(g, px, py, pw, ph, { r: 14, fill: 'rgba(9,13,24,0.95)', stroke: 'rgba(255,255,255,0.16)' });
    g.save();
    PL.rr(g, px, py, pw, 48, 14);
    g.fillStyle = 'rgba(255,255,255,0.045)'; g.fill();
    g.fillRect(px, py + 34, pw, 14);
    g.restore();
    PL.text(g, 'preview.html  ·  frame(1.20s)', px + 26, py + 31, {
      size: 17, font: F.mono, color: 'rgba(242,246,255,0.62)',
    });
    // 内容区
    const ix = px + 66, iy = py + 96;
    PL.text(g, 'RENDER PROGRESS', ix, iy, {
      size: 16, font: F.mono, color: C.dim, track: 2,
    });
    g.fillStyle = 'rgba(255,255,255,0.09)';
    PL.rr(g, ix, iy + 46, pw - 132, 18, 9); g.fill();
    g.fillStyle = C.accent;
    g.shadowColor = PL.rgba(C.accent, 0.55); g.shadowBlur = 26;
    PL.rr(g, ix, iy + 46, (pw - 132) * p, 18, 9); g.fill();
    g.shadowBlur = 0;
    // 进度条末端的脉冲光点：p 到 1 之后画面仍有持续微动，不会「死」掉
    const ex = ix + (pw - 132) * p;
    g.fillStyle = PL.rgba('#FFFFFF', 0.45 + 0.35 * (0.5 + 0.5 * Math.sin(lt * 7)));
    g.beginPath(); g.arc(ex, iy + 55, 5.5, 0, TAU); g.fill();
    PL.text(g, 'p = ' + p.toFixed(2), ix, iy + 138, {
      size: 62, weight: 700, font: F.en, color: C.ink,
    });
    // drawTitle(g, p) 的结果：文字随 p 淡入并轻微上浮
    g.save();
    g.globalAlpha *= PL.clamp((p - 0.28) / 0.55, 0, 1);
    PL.text(g, CP.lang === 'zh' ? '每一帧都由代码决定' : 'EVERY FRAME IS CODE',
      ix, iy + 250 - (1 - PL.clamp((p - 0.28) / 0.55, 0, 1)) * 18, {
      size: 34, weight: 600, font: BODY, color: C.accent,
    });
    g.restore();
    // 底部输出条：左侧规格、右侧持续滚动的帧号（与「逐帧渲染」的主张呼应）
    PL.text(g, CP.s2Out, px + 26, py + ph - 28, {
      size: 15, font: F.mono, color: 'rgba(242,246,255,0.66)', track: 1,
    });
    // 不再放「frame NNN / 978」：那会和 self 镜头的渲染进度形成第二套
    // 互不相干的计数。全片只允许 self 镜头一处出现帧数。
    PL.text(g, 'seek-driven · zero drift', px + pw - 26, py + ph - 28, {
      size: 15, font: F.mono, color: 'rgba(242,246,255,0.66)', align: 'right',
    });

    PL.text(g, CP.lang === 'zh' ? '每一帧 = f(t)。不录屏，不抽卡。' : 'Every frame = f(t). No recording. No sampling.',
      W0 / 2, 960, { size: 23, font: BODY, color: C.sub, align: 'center' });
  }

  /* ── 镜头 3：确定性 ───────────────────────────────────────────────── */
  function shotDet(lt, t) {
    sectionHead(92, 'DETERMINISTIC', CP.s3Title, CP.s3Sub, lt);

    const fy = 340, fw = 500, fh = 300;
    const xs = [300, 1120];
    for (let i = 0; i < 2; i++) {
      const a = PL.at(lt, 0.28 + i * 0.20, 0.55, PL.expoOut);
      g.save();
      g.globalAlpha *= a;
      g.translate(0, (1 - a) * 26);
      PL.text(g, 'PASS ' + (i + 1), xs[i], fy - 24, {
        size: 16, font: F.mono, color: C.dim, track: 2,
      });
      PL.text(g, CP.s3Frame, xs[i] + fw, fy - 24, {
        size: 16, font: F.mono, color: C.dim, align: 'right',
      });
      // 两张卡里是「同一帧」：固定 t0=3.80s，时间码与 s3Frame 完全对应
      PL.miniFrame(g, xs[i], fy, fw, fh, 3.8, {
        caption: 'FRAME(t) · SAME PIXELS', total: DUR,
      });
      // 卡面扫描光（让画面保持「活」）
      const sx = xs[i] + ((lt * 190 + i * 90) % (fw + 200)) - 100;
      g.save();
      PL.rr(g, xs[i], fy, fw, fh, 8); g.clip();
      const grd = g.createLinearGradient(sx - 60, 0, sx + 60, 0);
      grd.addColorStop(0, 'rgba(255,255,255,0)');
      grd.addColorStop(0.5, 'rgba(255,255,255,0.075)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.fillRect(sx - 60, fy, 120, fh);
      g.restore();
      g.restore();
    }

    // 中间等号
    PL.text(g, '=', W0 / 2, fy + fh / 2 + 22, {
      size: 58, font: F.en, color: C.sub, align: 'center',
    });

    // 绿色结论徽章
    const b = PL.at(lt, 1.15, 0.62, PL.backOut);
    if (b > 0) {
      g.save();
      g.translate(W0 / 2, 742);
      g.scale(0.7 + 0.3 * b, 0.7 + 0.3 * b);
      g.rotate((1 - b) * -0.06);
      g.globalAlpha *= PL.clamp(b * 1.4, 0, 1);
      const bw = 400, bh = 74;
      PL.panel(g, -bw / 2, -bh / 2, bw, bh, {
        r: 37, fill: PL.rgba(C.good, 0.12), stroke: PL.rgba(C.good, 0.55), lw: 1.5,
      });
      PL.icon(g, 'check', -bw / 2 + 48, 0, 26, C.good, 2.6);
      PL.text(g, CP.s3Badge, -bw / 2 + 82, 11, {
        size: 27, weight: 700, font: F.mono, color: C.good, track: 1,
      });
      g.restore();
    }

    // 三个要点
    for (let i = 0; i < CP.s3Items.length; i++) {
      const a = PL.at(lt, 1.15 + i * 0.18, 0.42);
      if (a <= 0) continue;
      const x = 500 + i * 310;
      g.save(); g.globalAlpha *= a;
      const ok = CP.s3Items[i].indexOf('✓') >= 0;
      PL.chip(g, CP.s3Items[i], x, 858, {
        size: 19, h: 46,
        fill: ok ? PL.rgba(C.good, 0.10) : 'rgba(255,255,255,0.065)',
        stroke: ok ? PL.rgba(C.good, 0.42) : 'rgba(255,255,255,0.18)',
        color: ok ? C.good : 'rgba(242,246,255,0.66)',
        font: F.mono, pad: 20,
      });
      g.restore();
    }
  }

  /* ── 镜头 4：一稿多发 ─────────────────────────────────────────────── */
  function ratiosLayout() {
    const sizes = [[560, 315], [300, 400], [225, 400]];
    const gap = 62;
    const total = sizes.reduce((a, s) => a + s[0], 0) + gap * 2;
    let x = (W0 - total) / 2;
    const baseY = 650;
    return sizes.map((s, i) => {
      const o = { x, y: baseY - s[1], w: s[0], h: s[1] };
      x += s[0] + gap;
      return o;
    });
  }

  function drawRatios(g2, boxes, t, scale, ox, oy) {
    g2.save();
    g2.translate(ox || 0, oy || 0);
    if (scale && scale !== 1) g2.scale(scale, scale);
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      PL.miniFrame(g2, b.x, b.y, b.w, b.h, t, { caption: 'FRAME(t)', r: 7, total: DUR });
    }
    g2.restore();
  }

  function shotRatio(lt, t) {
    sectionHead(92, 'ONE SOURCE · ALL FORMATS', CP.s4Title, CP.s4Sub, lt);
    const boxes = ratiosLayout();

    for (let i = 0; i < boxes.length; i++) {
      const a = PL.at(lt, 0.32 + i * 0.28, 0.66, PL.expoOut);
      g.save();
      g.globalAlpha *= a;
      const b = boxes[i];
      g.translate(b.x + b.w / 2, b.y + b.h / 2);
      g.scale(0.90 + 0.10 * a, 0.90 + 0.10 * a);
      g.translate(-(b.x + b.w / 2), -(b.y + b.h / 2));
      PL.miniFrame(g, b.x, b.y, b.w, b.h, t, { caption: 'FRAME(t)', r: 8, total: DUR });
      g.restore();

      g.save();
      g.globalAlpha *= PL.at(lt, 0.55 + i * 0.28, 0.45);
      PL.text(g, CP.s4Sizes[i], b.x + b.w / 2, 690, {
        size: 19, font: F.mono, color: C.ink, align: 'center',
      });
      PL.text(g, CP.s4Labels[i], b.x + b.w / 2, 722, {
        size: 18, font: BODY, color: C.sub, align: 'center', maxW: b.w + 60,
      });
      g.restore();
    }
    cmdBar(300, 790, 1320, CP.s4Cmd, lt, 1.45);
    // README 明确写的是「保证尺寸，不保证构图」，旧文案「构图也自适应」
    // 属于过度承诺，和一个主打确定性的工具定位相冲，这里改回诚实表述。
    PL.text(g, CP.lang === 'zh'
      ? '三种尺寸真实渲染，不是把横屏裁一刀；版式跟视口自适应'
      : 'Three real renders, not a crop; layout follows the viewport',
      W0 / 2, 910, { size: 21, font: BODY, color: 'rgba(242,246,255,0.72)', align: 'center' });
  }

  /* ── 镜头 5：为自动化而生 ─────────────────────────────────────────── */
  function shotAuto(lt, t) {
    sectionHead(92, 'BUILT FOR AGENTS', CP.s5Title, CP.s5Sub, lt);
    const cw = 520, ch = 372, gap = 60, x0 = (W0 - (cw * 3 + gap * 2)) / 2, y0 = 310;
    for (let i = 0; i < 3; i++) {
      const a = PL.at(lt, 0.28 + i * 0.24, 0.60, PL.expoOut);
      const x = x0 + i * (cw + gap);
      g.save();
      g.globalAlpha *= a;
      g.translate(0, (1 - a) * 34);
      PL.panel(g, x, y0, cw, ch, { r: 18, fill: C.panel, stroke: 'rgba(255,255,255,0.12)' });
      // 顶部一条循环进度线
      const q = (lt * 0.24 + i * 0.31) % 1;
      g.fillStyle = PL.rgba(C.accent, 0.55);
      g.fillRect(x + 30 + q * (cw - 60) - 40, y0, 80, 2.5);
      // 图标
      PL.panel(g, x + 32, y0 + 34, 64, 64, {
        r: 16, fill: PL.rgba(C.accent, 0.11), stroke: PL.rgba(C.accent, 0.32),
      });
      PL.icon(g, CP.s5Cards[i].icon, x + 64, y0 + 66, 30, C.accent, 2);
      PL.text(g, '0' + (i + 1), x + cw - 34, y0 + 74, {
        size: 18, font: F.mono, color: C.dim, align: 'right',
      });
      PL.text(g, CP.s5Cards[i].t, x + 32, y0 + 162, {
        size: 31, weight: 700, font: BODY, color: C.ink, maxW: cw - 64,
      });
      const lines = CP.s5Cards[i].d.split('\n');
      PL.text(g, lines[0], x + 32, y0 + 212, {
        size: 18, font: F.mono, color: C.cyan, maxW: cw - 64,
      });
      PL.text(g, lines[1], x + 32, y0 + 258, {
        size: 20, font: BODY, color: C.sub, maxW: cw - 64,
      });
      // 底部细分隔 + 勾
      g.strokeStyle = 'rgba(255,255,255,0.08)';
      g.beginPath(); g.moveTo(x + 32, y0 + 300); g.lineTo(x + cw - 32, y0 + 300); g.stroke();
      PL.icon(g, 'check', x + 50, y0 + 332, 20, C.good, 2.4);
      PL.text(g, CP.lang === 'zh' ? '有自动化测试覆盖' : 'covered by tests', x + 72, y0 + 339, {
        size: 17, font: BODY, color: C.dim,
      });
      g.restore();
    }
    cmdBar(140, 760, 1640, CP.s5Cmd, lt, 1.25);
    PL.text(g, CP.lang === 'zh'
      ? '109/109 项测试通过 · --json 一行结果，不用正则去猜日志'
      : '109/109 tests passing · --json, no log scraping',
      W0 / 2, 892, { size: 21, font: BODY, color: 'rgba(242,246,255,0.72)', align: 'center' });
  }

  /* ── 镜头 6：自指 ─────────────────────────────────────────────────── */
  function shotSelf(lt, t) {
    const a0 = PL.at(lt, 0.05, 0.5);
    PL.chip(g, CP.s6Tag, 140, 76, { size: 16, h: 34 });
    PL.text(g, CP.s6Title, 140, 176, {
      size: 52, weight: 700, font: BODY, color: C.ink, alpha: a0, maxW: W0 - 280,
    });
    PL.text(g, CP.s6Sub, 140, 218, {
      size: 22, font: BODY, color: C.sub, alpha: PL.at(lt, 0.18, 0.5),
    });

    const bx = 120, by = 270, bw = 1060, bh = 600;
    // 浏览器窗
    PL.panel(g, bx, by, bw, bh, { r: 16, fill: 'rgba(8,11,20,0.96)', stroke: 'rgba(255,255,255,0.18)' });
    g.save();
    PL.rr(g, bx, by, bw, 56, 16);
    g.fillStyle = 'rgba(255,255,255,0.055)'; g.fill();
    g.fillRect(bx, by + 40, bw, 16);
    g.restore();
    const dots = ['#FF6B6B', '#FFB86B', '#4ADE80'];
    for (let i = 0; i < 3; i++) {
      g.fillStyle = dots[i];
      g.beginPath(); g.arc(bx + 32 + i * 24, by + 28, 6, 0, TAU); g.fill();
    }
    PL.panel(g, bx + 130, by + 12, 620, 32, { r: 16, fill: 'rgba(0,0,0,0.30)', stroke: 'rgba(255,255,255,0.06)' });
    PL.text(g, 'localhost:8787/promo-zh.html', bx + 150, by + 34, {
      size: 15, font: F.mono, color: C.dim,
    });
    // 窗内的「被渲染的一帧」：缩小的三比例画面，按真实比例居中铺满取景区
    const sc = 0.80;
    const layout = ratiosLayout();
    const totalW = layout.reduce((a, b) => a + b.w, 0) * sc + 62 * sc * 2;
    let cx = bx + 24 + (bw - 48 - totalW) / 2;
    const baseY = by + 76 + (bh - 116) / 2 + 400 * sc / 2;
    const boxes = layout.map(b => {
      const o = { x: cx, y: baseY - b.h * sc, w: b.w * sc, h: b.h * sc };
      cx += b.w * sc + 62 * sc;
      return o;
    });
    g.save();
    PL.rr(g, bx + 24, by + 76, bw - 48, bh - 116, 10); g.clip();
    const grd = g.createLinearGradient(bx, by, bx + bw, by + bh);
    grd.addColorStop(0, '#0A0E1A'); grd.addColorStop(1, '#111827');
    g.fillStyle = grd; g.fillRect(bx + 24, by + 76, bw - 48, bh - 116);
    drawRatios(g, boxes, t);
    // 取景区底部的时间轴：暗示「这是成片里的一帧」，同时填掉下方留白
    const tlX = bx + 70, tlY = by + bh - 58, tlW = bw - 140;
    g.fillStyle = 'rgba(255,255,255,0.10)';
    PL.rr(g, tlX, tlY, tlW, 4, 2); g.fill();
    const tq = PL.clamp(t / DUR, 0, 1);
    g.fillStyle = C.accent;
    PL.rr(g, tlX, tlY, tlW * tq, 4, 2); g.fill();
    g.beginPath(); g.arc(tlX + tlW * tq, tlY + 2, 6, 0, TAU); g.fill();
    PL.text(g, '00:00', tlX, tlY - 14, { size: 14, font: F.mono, color: C.dim });
    PL.text(g, '00:32', tlX + tlW, tlY - 14, { size: 14, font: F.mono, color: C.dim, align: 'right' });
    g.restore();
    // 取景框四角
    g.save();
    g.strokeStyle = PL.rgba(C.accent, 0.75); g.lineWidth = 2;
    const fx = bx + 40, fy2 = by + 92, fw2 = bw - 80, fh2 = bh - 148, L = 26;
    const corners = [[fx, fy2, 1, 1], [fx + fw2, fy2, -1, 1], [fx, fy2 + fh2, 1, -1], [fx + fw2, fy2 + fh2, -1, -1]];
    for (const [x, y, sx, sy] of corners) {
      g.beginPath(); g.moveTo(x + sx * L, y); g.lineTo(x, y); g.lineTo(x, y + sy * L); g.stroke();
    }
    g.restore();

    // 终端
    const tx = 1220, ty = 270, tw = 580, th = 600;
    PL.panel(g, tx, ty, tw, th, { r: 16, fill: 'rgba(4,6,12,0.96)', stroke: 'rgba(255,255,255,0.16)' });
    PL.text(g, 'render-video-seek.js', tx + 28, ty + 42, {
      size: 17, font: F.mono, color: C.dim,
    });
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.beginPath(); g.moveTo(tx + 24, ty + 62); g.lineTo(tx + tw - 24, ty + 62); g.stroke();
    // 全片唯一的帧数来源：DUR × 30 = 978。日志、进度条、Done 标记全部
    // 由同一个 pp 派生。旧版把「978 / 978 完成态」写死在日志里，又同时
    // 画「522 / 978 进行态」进度条，独立审片判定为定位级 P1：
    // 一个主打确定性的工具，自己的宣传片里数字对不上，等于自毁。
    const TOTAL = Math.round(DUR * 30);
    const pp = PL.clamp((lt - 0.40) / 3.00, 0, 1);
    const cur = Math.round(pp * TOTAL);
    const delays = [0.30, 0.58, 3.02, 3.42];   // ffmpeg / Done 要等快渲完才出现
    const durs   = [0.38, 0.32, 0.32, 0.30];
    for (let i = 0; i < CP.s6Log.length; i++) {
      if (i === 3 && pp < 1) continue;         // ✓ Done 只在真的渲完时出现
      const a = PL.at(lt, delays[i], durs[i]);
      if (a <= 0) continue;
      const full = CP.s6Log[i]
        .replace('{CUR}', String(cur))
        .replace('{TOTAL}', String(TOTAL));
      // 进度行不做打字机：数字必须跟着进度条实时走
      const n = i === 1 ? full.length
        : Math.floor(full.length * PL.clamp((lt - delays[i]) / 0.30, 0, 1));
      g.save(); g.globalAlpha *= a;
      PL.text(g, full.slice(0, n), tx + 28, ty + 116 + i * 62, {
        size: 19, font: F.mono,
        color: full[0] === '✓' ? C.good : (i === 2 ? C.accent : 'rgba(242,246,255,0.82)'),
        maxW: tw - 56,
      });
      g.restore();
    }
    // 进度条
    g.fillStyle = 'rgba(255,255,255,0.09)';
    PL.rr(g, tx + 28, ty + th - 106, tw - 56, 10, 5); g.fill();
    g.fillStyle = C.accent;
    PL.rr(g, tx + 28, ty + th - 106, (tw - 56) * pp, 10, 5); g.fill();
    PL.text(g, cur + ' / ' + TOTAL + ' frames', tx + 28, ty + th - 62, {
      size: 17, font: F.mono, color: C.sub,
    });
    if (pp >= 1) PL.icon(g, 'play', tx + tw - 48, ty + th - 70, 22, C.accent, 2);
  }

  /* ── 镜头 7：CTA ──────────────────────────────────────────────────── */
  function shotCta(lt, t) {
    const a = PL.at(lt, 0.10, 0.65, PL.expoOut);
    PL.orb(g, W0 / 2, 400, 640, PL.rgba(C.accent, 0.07 + 0.02 * Math.sin(t * 1.3)));
    g.save();
    g.globalAlpha *= a;
    g.translate(0, (1 - a) * 30);
    PL.text(g, CP.s7Title, W0 / 2, 390, {
      size: 104, weight: 700, font: BODY, color: C.ink, align: 'center',
      maxW: W0 - 160, track: 2, shadow: 'rgba(124,156,255,0.20)', shadowBlur: 48,
    });
    PL.text(g, CP.s7Sub, W0 / 2, 458, {
      size: 26, font: BODY, color: C.sub, align: 'center', maxW: W0 - 200,
    });
    g.restore();

    cmdBar(340, 530, 1240, CP.s7Cmd, lt, 0.55);

    const s = PL.at(lt, 1.00, 0.6);
    g.save();
    g.globalAlpha *= s;
    PL.icon(g, 'star', W0 / 2 - 300, 672, 30, C.accent, 2.4);
    PL.text(g, CP.s7Url, W0 / 2, 682, {
      size: 28, font: F.mono, color: C.accent, align: 'center', track: 0.5,
    });
    g.restore();

    // 只写本片自身可核验的硬数字。旧版写了会过时的 star 数，且
    // 20px / 0.56 灰的小字被独立审片误读成「189 项测试」，这里一并抬亮加大。
    PL.text(g, CP.s7Stats, W0 / 2, 752, {
      size: 23, font: F.mono, color: 'rgba(242,246,255,0.80)', align: 'center',
      alpha: PL.at(lt, 1.25, 0.5), maxW: W0 - 200,
    });

    // 片尾署名：整支片子的自证
    const f = PL.at(lt, 1.45, 0.6);
    g.save();
    g.globalAlpha *= f;
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.beginPath(); g.moveTo(560, 792); g.lineTo(1360, 792); g.stroke();
    PL.text(g, CP.s7Foot, W0 / 2, 840, {
      size: 20, font: BODY, color: 'rgba(242,246,255,0.72)', align: 'center',
    });
    g.restore();
  }

  const DRAW = {
    hook: shotHook, code: shotCode, det: shotDet,
    ratio: shotRatio, auto: shotAuto, self: shotSelf, cta: shotCta,
  };

  function frame(t) {
    t = PL.clamp(t, 0, DUR - 1e-4);
    g.setTransform(W / W0, 0, 0, H / H0, 0, 0);
    PL.backdrop(g, W0, H0, t);
    const s = shotAt(t);
    const fadeIn = PL.smooth(PL.seg(s.lt, 0, 0.30));
    const fadeOut = 1 - PL.smooth(PL.seg(s.lt, s.s.dur - 0.26, s.s.dur));
    g.save();
    g.globalAlpha = Math.min(fadeIn, fadeOut);
    DRAW[s.s.id](s.lt, t);
    g.restore();
    PL.scan(g, W0, H0, t, CUTS);
    PL.chrome(g, W0, H0, t, CP.brand);
  }

  window.__seek = frame;
  if (window.__seekRender) {
    frame(0);
    window.__ready = true;
  } else {
    const t0 = performance.now();
    (function loop() { frame((performance.now() - t0) / 1000); requestAnimationFrame(loop); })();
  }
})();
