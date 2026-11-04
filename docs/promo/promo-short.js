/* =========================================================================
   promo-short.js — 9:16 Shorts（1080×1920 / 30fps / 20.5s / 四镜头）
   竖屏不是把横屏裁一刀：全部重新排版，底部 15%（288px）为平台按钮安全区。
   ========================================================================= */
(function () {
  'use strict';

  const PL = window.PL;
  const C = PL.C, F = PL.F, TAU = PL.TAU;
  const CP = window.__PROMO_COPY || window.PROMO_COPY.zh;
  const BODY = F[CP.font];
  const ZH = CP.lang === 'zh';
  const S = {
    brandLine: ZH ? 'html-to-video · 一种不同的做法' : 'html-to-video · a different approach',
    hookCmd: ZH ? 'ai.generate("改一个字")' : 'ai.generate("change one word")',
    hookFail: ZH ? ['× 画面又变了', '× 文字糊了'] : ['× different output again', '× unreadable text'],
    hook1: ZH ? '做视频' : 'What if video',
    hook2: ZH ? '像写代码一样？' : 'worked like code?',
    hookSub: ZH ? '不抽卡 · 不录屏 · 每帧可复现' : 'No sampling. Every frame reproducible.',
    hookKicker: ZH ? '同一句提示词 · 每次都不是同一支片子' : 'SAME PROMPT · DIFFERENT OUTPUT',
    // 竖版开场下半屏原本空 500px，这里放一组对照，把留白变成信息
    cmpBad: ZH ? '反复生成' : 'Regenerate',
    cmpBadA: ZH ? '改一个字，重跑一遍' : 'Change one word, rerun',
    cmpBadB: ZH ? '画面还是对不上' : 'Still not the same',
    cmpGood: ZH ? 'frame(t)' : 'frame(t)',
    cmpGoodA: ZH ? '改一行代码' : 'Change one line',
    cmpGoodB: ZH ? '只变那一处，逐像素可复现' : 'Only that pixel changes',
    s2Tag: 'CODE → FRAME',
    s2Title: ZH ? '画面 = f(t)' : 'A frame = f(t)',
    s2Sub: ZH ? '写下 frame(t)，它就长成动画' : 'Write frame(t). Watch it move.',
    s2Foot: ZH ? '每一帧都由代码决定' : 'EVERY FRAME IS CODE',
    s3Tag: 'ONE SOURCE · ALL FORMATS',
    s3Title: ZH ? '一份 HTML' : 'One HTML.',
    s3Title2: ZH ? '三套比例' : 'Three formats.',
    s3Sub: ZH ? '一条命令，横屏 / 3:4 / 竖屏一次出齐' : 'One command. Landscape, 3:4, vertical.',
    s3Cmd: '--presets=youtube,xiaohongshu,douyin',
    s3Foot: ZH ? '尺寸按比例真实渲染' : 'Real pixels, not cropped',
    s4Tag: 'DOGFOODING',
    s4Title: ZH ? '你正在看的这一帧' : 'The frame you are watching',
    s4Title2: ZH ? '也是它渲的' : 'was rendered by it',
    s4Sub: ZH ? '本片每一帧都来自 frame(t)' : 'Every frame came from frame(t)',
    s4Url: 'github.com/wx4766/html-to-video',
    // 竖版只有 20.5s × 30fps = 615 帧，旧版写 978（横屏主片的帧数）是硬伤
    s4Stats: ZH ? '615 帧 · 20.5s · 9:16 · Apache-2.0' : '615 frames · 20.5s · 9:16 · Apache-2.0',
    s4Foot: ZH ? '本片由 html-to-video 逐帧渲染' : 'Rendered frame by frame with html-to-video',
    s4Clone: 'git clone https://github.com/wx4766/html-to-video',
  };

  const W0 = 1080, H0 = 1920;
  const SAFE = 288;                  // 底部 15% 平台按钮区
  const cv = document.getElementById('stage');
  const W = window.innerWidth, H = window.innerHeight;
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d', { alpha: false });

  const SHOTS = [
    { id: 'hook',  dur: 3.0 },
    { id: 'code',  dur: 5.2 },
    { id: 'ratio', dur: 6.4 },
    { id: 'cta',   dur: 5.9 },
  ];
  let acc = 0;
  for (const s of SHOTS) { s.start = acc; acc += s.dur; }
  const DUR = acc;                    // 20.5
  const CUTS = SHOTS.slice(1).map(s => s.start);

  function shotAt(t) {
    for (let i = SHOTS.length - 1; i >= 0; i--) {
      if (t >= SHOTS[i].start) return { i, lt: t - SHOTS[i].start, s: SHOTS[i] };
    }
    return { i: 0, lt: 0, s: SHOTS[0] };
  }

  function head(y, tag, title, sub, lt, title2) {
    PL.chip(g, tag, 70, y, { size: 15, h: 34 });
    const a = PL.at(lt, 0.05, 0.48);
    PL.text(g, title, 70, y + 116, {
      size: 68, weight: 700, font: BODY, color: C.ink, alpha: a, maxW: W0 - 140,
    });
    if (title2) {
      PL.text(g, title2, 70, y + 204, {
        size: 68, weight: 700, font: BODY, color: C.accent, alpha: PL.at(lt, 0.16, 0.48),
        maxW: W0 - 140,
      });
    }
    PL.text(g, sub, 70, y + (title2 ? 262 : 174), {
      size: 23, font: BODY, color: C.sub, alpha: PL.at(lt, 0.26, 0.5), maxW: W0 - 140,
    });
  }

  function cbar(y, s, lt, delay) {
    const a = PL.at(lt, delay || 0, 0.5);
    g.save();
    g.globalAlpha *= a;
    const x = 70, w = W0 - 140, h = 72;
    PL.panel(g, x, y, w, h, { r: 12, fill: 'rgba(6,9,16,0.9)', stroke: 'rgba(255,255,255,0.13)' });
    g.fillStyle = C.accent;
    PL.rr(g, x + 2, y + 17, 3, 38, 2); g.fill();
    PL.text(g, '$', x + 24, y + 47, { size: 23, font: F.mono, color: C.accent });
    PL.text(g, s, x + 56, y + 46, {
      size: 22, font: F.mono, color: 'rgba(242,246,255,0.90)', maxW: w - 84,
    });
    g.restore();
  }

  /* ── 1. 钩子 ──────────────────────────────────────────────────────── */
  function shotHook(lt, t) {
    PL.text(g, S.brandLine, W0 / 2, 170, {
      size: 20, font: BODY, color: C.sub, align: 'center', alpha: PL.at(lt, 0, 0.30),
    });
    PL.text(g, S.hookKicker, W0 / 2, 248, {
      size: 20, font: BODY, color: C.accent, align: 'center',
      alpha: PL.at(lt, 0.02, 0.32), maxW: W0 - 120,
    });

    const rev = PL.at(lt, 0.04, 0.72);
    // 竖版垂直空间够：终端不撤，留到镜头结束。旧版 1.1s 就让它淡出，
    // 静帧目验发现 1.5–3.0s 上半屏（y 300–800）整整空掉一半，划走风险高。
    g.save();
    const bx = 70, by = 300, bw = W0 - 140, bh = 290;
    PL.panel(g, bx, by, bw, bh, { r: 16, fill: 'rgba(6,9,16,0.84)', stroke: 'rgba(255,255,255,0.12)' });
    PL.text(g, '>', bx + 30, by + 62, { size: 28, font: F.mono, color: C.accent });
    const shown = S.hookCmd.slice(0, Math.floor(rev * S.hookCmd.length));
    PL.text(g, shown, bx + 62, by + 62, { size: 27, font: F.mono, color: C.ink, maxW: bw - 100 });
    if (rev < 1 && shown.length > 2) {
      g.fillStyle = C.accent;
      g.fillRect(bx + 66 + shown.length * 16, by + 40, 2, 28);
    }
    PL.text(g, 'attempt #' + (8 + Math.floor(lt * 13)), bx + bw - 30, by + 62, {
      size: 19, font: F.mono, color: C.bad, align: 'right', alpha: PL.at(lt, 0.02, 0.30),
    });
    for (let i = 0; i < S.hookFail.length; i++) {
      const a = PL.at(lt, 0.10 + i * 0.16, 0.24);
      if (a <= 0) continue;
      g.save(); g.globalAlpha *= a;
      g.fillStyle = C.bad;
      g.fillRect(bx + 40, by + 133 + i * 54, 8, 8);
      PL.text(g, S.hookFail[i], bx + 62, by + 142 + i * 54, {
        size: 25, font: BODY, color: C.bad,
      });
      g.restore();
    }
    g.restore();

    const a = PL.at(lt, 1.35, 0.55, PL.expoOut);
    g.save();
    g.globalAlpha *= a;
    g.translate(0, (1 - a) * 40);
    PL.text(g, S.hook1, W0 / 2, 900, {
      size: 82, weight: 700, font: BODY, color: C.ink, align: 'center',
      maxW: W0 - 100, shadow: 'rgba(124,156,255,0.18)', shadowBlur: 38,
    });
    PL.text(g, S.hook2, W0 / 2, 1010, {
      size: 82, weight: 700, font: BODY, color: C.accent, align: 'center',
      maxW: W0 - 100, shadow: 'rgba(255,184,107,0.20)', shadowBlur: 40,
    });
    const u = PL.at(lt, 1.80, 0.45, PL.expoOut);
    g.fillStyle = C.accent;
    g.fillRect(W0 / 2 - 130 * u, 1058, 260 * u, 3);
    PL.text(g, S.hookSub, W0 / 2, 1130, {
      size: 24, font: BODY, color: C.sub, align: 'center', maxW: W0 - 120,
    });
    g.restore();

    // 对照卡：把 1230–1480 的空白变成「为什么值得继续看」的答案。
    // 独立审片指出竖版开场下半屏留白过大，短视频划走率极高。
    const ca = PL.at(lt, 1.05, 0.55, PL.expoOut);
    if (ca > 0) {
      g.save();
      g.globalAlpha *= ca;
      g.translate(0, (1 - ca) * 28);
      const cy = 1230, ch = 250, cw = 440, rx = 570;
      PL.panel(g, 70, cy, cw, ch, {
        r: 16, fill: 'rgba(255,133,133,0.07)', stroke: 'rgba(255,133,133,0.32)', lw: 1.5,
      });
      PL.icon(g, 'cross', 116, cy + 52, 26, C.bad, 2.4);
      PL.text(g, S.cmpBad, 154, cy + 62, {
        size: 29, weight: 700, font: BODY, color: C.bad, maxW: cw - 100,
      });
      PL.text(g, S.cmpBadA, 110, cy + 138, { size: 21, font: BODY, color: C.sub, maxW: cw - 80 });
      PL.text(g, S.cmpBadB, 110, cy + 182, { size: 21, font: BODY, color: C.sub, maxW: cw - 80 });

      PL.panel(g, rx, cy, cw, ch, {
        r: 16, fill: PL.rgba(C.good, 0.07), stroke: PL.rgba(C.good, 0.34), lw: 1.5,
      });
      PL.icon(g, 'check', rx + 46, cy + 52, 26, C.good, 2.4);
      PL.text(g, S.cmpGood, rx + 84, cy + 62, {
        size: 29, weight: 700, font: F.mono, color: C.good, maxW: cw - 100,
      });
      PL.text(g, S.cmpGoodA, rx + 40, cy + 138, { size: 21, font: BODY, color: C.sub, maxW: cw - 80 });
      PL.text(g, S.cmpGoodB, rx + 40, cy + 182, { size: 21, font: BODY, color: C.sub, maxW: cw - 80 });

      PL.text(g, '→', W0 / 2, cy + 148, {
        size: 34, font: BODY, color: C.accent, align: 'center',
      });
      g.restore();
    }
  }

  /* ── 2. 代码在上、画面在下（竖屏天然适合这个因果链） ──────────────── */
  function shotCode(lt, t) {
    head(120, S.s2Tag, S.s2Title, S.s2Sub, lt);
    const rev = PL.at(lt, 0.28, 2.10, PL.expoOut);
    const p = PL.expoOut(PL.seg(rev, 0, 1));
    PL.codeBox(g, 70, 420, W0 - 140, 540, CP.s2Code, rev, {
      size: 23, lineH: 45, title: 'frame.js',
    });
    PL.text(g, '// no Math.random() · no Date.now()', 116, 906, {
      size: 19, font: F.mono, color: 'rgba(242,246,255,0.54)',
      alpha: PL.at(lt, 1.4, 0.5),
    });

    // 中间的向下连接：流动光点
    g.save();
    g.strokeStyle = 'rgba(255,184,107,0.32)';
    g.lineWidth = 2;
    g.setLineDash([7, 10]);
    g.beginPath(); g.moveTo(W0 / 2, 972); g.lineTo(W0 / 2, 1070); g.stroke();
    g.setLineDash([]);
    for (let i = 0; i < 3; i++) {
      const q = (lt * 0.6 + i / 3) % 1;
      g.fillStyle = PL.rgba(C.accent, 0.9 * Math.sin(Math.PI * q));
      g.beginPath(); g.arc(W0 / 2, 972 + q * 98, 5, 0, TAU); g.fill();
    }
    g.restore();

    // 预览窗
    const px = 70, py = 1080, pw = W0 - 140, ph = 420;
    PL.panel(g, px, py, pw, ph, { r: 16, fill: 'rgba(9,13,24,0.95)', stroke: 'rgba(255,255,255,0.16)' });
    g.save();
    PL.rr(g, px, py, pw, 48, 16); g.fillStyle = 'rgba(255,255,255,0.05)'; g.fill();
    g.fillRect(px, py + 34, pw, 14);
    g.restore();
    PL.text(g, 'preview.html · frame(1.20s)', px + 26, py + 31, {
      size: 16, font: F.mono, color: C.dim,
    });
    g.fillStyle = 'rgba(255,255,255,0.09)';
    PL.rr(g, px + 44, py + 108, pw - 88, 18, 9); g.fill();
    g.fillStyle = C.accent;
    g.shadowColor = PL.rgba(C.accent, 0.55); g.shadowBlur = 24;
    PL.rr(g, px + 44, py + 108, (pw - 88) * p, 18, 9); g.fill();
    g.shadowBlur = 0;
    const ex = px + 44 + (pw - 88) * p;
    g.fillStyle = PL.rgba('#FFFFFF', 0.45 + 0.35 * (0.5 + 0.5 * Math.sin(lt * 7)));
    g.beginPath(); g.arc(ex, py + 117, 6, 0, TAU); g.fill();
    PL.text(g, 'p = ' + p.toFixed(2), px + 44, py + 210, {
      size: 58, weight: 700, font: F.en, color: C.ink,
    });
    g.save();
    g.globalAlpha *= PL.clamp((p - 0.3) / 0.5, 0, 1);
    PL.text(g, S.s2Foot, px + 44, py + 286, {
      size: 30, weight: 600, font: BODY, color: C.accent,
    });
    g.restore();
    // 竖版自己的总帧数是 615，不再借用横屏的 978；全片帧数只在 CTA 出现一次
    PL.text(g, 'seek-driven · zero drift', px + pw - 26, py + ph - 26, {
      size: 16, font: F.mono, color: 'rgba(242,246,255,0.66)', align: 'right',
    });

    PL.text(g, ZH ? '不录屏 · 不抽卡 · 逐帧可复现' : 'No recording. No sampling. Reproducible.',
      W0 / 2, 1580, {
        size: 23, font: BODY, color: 'rgba(242,246,255,0.72)', align: 'center',
        alpha: PL.at(lt, 1.3, 0.5),
      });
  }

  /* ── 3. 一大两小的真实比例 ────────────────────────────────────────── */
  function shotRatio(lt, t) {
    head(120, S.s3Tag, S.s3Title, S.s3Sub, lt, S.s3Title2);

    const big = { x: 90, y: 470, w: 900, h: 480 };
    const a0 = PL.at(lt, 0.30, 0.62, PL.expoOut);
    g.save();
    g.globalAlpha *= a0;
    g.translate(big.x + big.w / 2, big.y + big.h / 2);
    g.scale(0.94 + 0.06 * a0, 0.94 + 0.06 * a0);
    g.translate(-(big.x + big.w / 2), -(big.y + big.h / 2));
    PL.miniFrame(g, big.x, big.y, big.w, big.h, t, { caption: 'FRAME(t)', r: 10, total: DUR });
    g.restore();

    const smalls = [
      { x: 190, y: 1030, w: 270, h: 360 },
      { x: 620, y: 1030, w: 202, h: 360 },
    ];
    for (let i = 0; i < 2; i++) {
      const a = PL.at(lt, 0.72 + i * 0.28, 0.58, PL.expoOut);
      const b = smalls[i];
      g.save();
      g.globalAlpha *= a;
      g.translate(0, (1 - a) * 24);
      PL.miniFrame(g, b.x, b.y, b.w, b.h, t, { caption: 'FRAME(t)', r: 9, total: DUR });
      PL.text(g, i === 0 ? '1080 × 1440' : '1080 × 1920', b.x + b.w / 2, 1426, {
        size: 18, font: F.mono, color: C.sub, align: 'center', maxW: b.w + 80,
      });
      g.restore();
    }
    PL.text(g, '1920 × 1080 · YouTube / B站', W0 / 2, 1000, {
      size: 19, font: F.mono, color: C.sub, align: 'center', alpha: a0,
    });
    cbar(1470, S.s3Cmd, lt, 1.55);
    // 底部 15%（y>1632）是平台按钮区，所有关键文字必须收在安全线以上
    PL.text(g, S.s3Foot, W0 / 2, 1596, {
      size: 21, font: BODY, color: 'rgba(242,246,255,0.72)', align: 'center',
      alpha: PL.at(lt, 1.9, 0.5),
    });
  }

  /* ── 4. 自指 + CTA ────────────────────────────────────────────────── */
  function shotCta(lt, t) {
    PL.chip(g, S.s4Tag, 70, 150, { size: 15, h: 34 });
    PL.orb(g, W0 / 2, 620, 560, PL.rgba(C.accent, 0.07 + 0.02 * Math.sin(t * 1.3)));
    const a = PL.at(lt, 0.10, 0.62, PL.expoOut);
    g.save();
    g.globalAlpha *= a;
    g.translate(0, (1 - a) * 34);
    PL.text(g, S.s4Title, W0 / 2, 560, {
      size: 62, weight: 700, font: BODY, color: C.ink, align: 'center',
      maxW: W0 - 90, shadow: 'rgba(124,156,255,0.18)', shadowBlur: 36,
    });
    PL.text(g, S.s4Title2, W0 / 2, 650, {
      size: 62, weight: 700, font: BODY, color: C.accent, align: 'center',
      maxW: W0 - 90, shadow: 'rgba(255,184,107,0.20)', shadowBlur: 40,
    });
    PL.text(g, S.s4Sub, W0 / 2, 720, {
      size: 24, font: BODY, color: C.sub, align: 'center', maxW: W0 - 100,
    });
    g.restore();

    // 渲染进度：本片真实帧数 = DUR × 30 = 615，与 s4Stats 同源。
    // 旧版借用横屏主片的 978，是本片最明显的自相矛盾。
    const TOTAL = Math.round(DUR * 30);
    const pp = PL.at(lt, 0.6, 1.5, PL.expoOut);
    g.fillStyle = 'rgba(255,255,255,0.10)';
    PL.rr(g, 110, 830, W0 - 220, 12, 6); g.fill();
    g.fillStyle = C.accent;
    PL.rr(g, 110, 830, (W0 - 220) * pp, 12, 6); g.fill();
    PL.text(g, Math.round(pp * TOTAL) + ' / ' + TOTAL + ' frames', W0 / 2, 894, {
      size: 21, font: F.mono, color: C.sub, align: 'center',
    });

    cbar(980, S.s4Clone, lt, 0.9);

    const s = PL.at(lt, 1.35, 0.55);
    g.save();
    g.globalAlpha *= s;
    PL.icon(g, 'star', 280, 1160, 30, C.accent, 2.4);
    PL.text(g, S.s4Url, W0 / 2 + 16, 1172, {
      size: 26, font: F.mono, color: C.accent, align: 'center', maxW: W0 - 180,
    });
    g.restore();
    PL.text(g, S.s4Stats, W0 / 2, 1250, {
      size: 21, font: F.mono, color: 'rgba(242,246,255,0.78)', align: 'center',
      alpha: PL.at(lt, 1.6, 0.5), maxW: W0 - 120,
    });

    const f = PL.at(lt, 2.0, 0.6);
    g.save();
    g.globalAlpha *= f;
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.beginPath(); g.moveTo(190, 1360); g.lineTo(890, 1360); g.stroke();
    PL.text(g, S.s4Foot, W0 / 2, 1422, {
      size: 21, font: BODY, color: 'rgba(242,246,255,0.72)', align: 'center',
      maxW: W0 - 120,
    });
    g.restore();
  }

  const DRAW = { hook: shotHook, code: shotCode, ratio: shotRatio, cta: shotCta };

  function frame(t) {
    t = PL.clamp(t, 0, DUR - 1e-4);
    g.setTransform(W / W0, 0, 0, H / H0, 0, 0);
    PL.backdrop(g, W0, H0, t);
    const s = shotAt(t);
    const fadeIn = PL.smooth(PL.seg(s.lt, 0, 0.28));
    const fadeOut = 1 - PL.smooth(PL.seg(s.lt, s.s.dur - 0.24, s.s.dur));
    g.save();
    g.globalAlpha = Math.min(fadeIn, fadeOut);
    DRAW[s.s.id](s.lt, t);
    g.restore();
    PL.scan(g, W0, H0, t, CUTS);
    PL.chrome(g, W0, H0, t, CP.brand);
  }

  window.__seek = frame;
  if (window.__seekRender) { frame(0); window.__ready = true; }
  else {
    const t0 = performance.now();
    (function loop() { frame((performance.now() - t0) / 1000); requestAnimationFrame(loop); })();
  }
})();
