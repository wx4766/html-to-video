/* 封面静态帧：1920×1080，缩略图尺寸下仍能一眼读懂主标题。 */
(function () {
  'use strict';
  const PL = window.PL, C = PL.C, F = PL.F, TAU = PL.TAU;
  const CP = window.__PROMO_COPY || window.PROMO_COPY.zh;
  const ZH = CP.lang === 'zh';
  const W0 = 1920, H0 = 1080;
  const cv = document.getElementById('stage');
  const W = window.innerWidth, H = window.innerHeight;
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d', { alpha: false });

  const T = {
    chip: ZH ? '开源 · 免费 · APACHE-2.0' : 'FREE · OPEN SOURCE · APACHE-2.0',
    title: ZH ? '代码即画面' : 'VIDEO AS CODE',
    sub: ZH ? 'HTML / Canvas → 确定性 MP4 · 逐帧可复现' : 'HTML / Canvas → deterministic MP4, frame by frame',
    // 与 README / 推广片统一到 scripts/ 路径；封面缩略图里命令越短越可读
    cmd: 'node scripts/render-video-seek.js slide.html',
    pts: ZH ? ['零费用', '中文不糊', '可进 CI'] : ['Zero cost', 'Perfect CJK text', 'CI-ready'],
    right: ZH ? '一份 HTML → 三套比例' : 'ONE HTML → THREE FORMATS',
    foot: ZH ? '画面由 html-to-video 逐帧渲染' : 'Frames rendered by html-to-video',
  };
  const BODY = F[CP.font];

  function draw(t) {
    g.setTransform(W / W0, 0, 0, H / H0, 0, 0);
    PL.backdrop(g, W0, H0, t);
    PL.orb(g, 300, 420, 700, PL.rgba(C.accent, 0.075));

    // 左：主信息
    PL.chip(g, T.chip, 110, 140, { size: 18, h: 42 });
    PL.text(g, T.title, 110, 400, {
      size: 122, weight: 700, font: BODY, color: C.ink, maxW: 860,
      track: 2, shadow: 'rgba(124,156,255,0.20)', shadowBlur: 44,
    });
    const uw = ZH ? 610 : 690;
    g.fillStyle = C.accent;
    PL.rr(g, 110, 434, uw, 7, 4); g.fill();
    PL.text(g, T.sub, 110, 510, {
      size: 29, font: BODY, color: C.sub, maxW: 850,
    });

    // 命令框
    PL.panel(g, 110, 590, 820, 82, { r: 14, fill: 'rgba(6,9,16,0.92)', stroke: 'rgba(255,255,255,0.15)' });
    g.fillStyle = C.accent;
    PL.rr(g, 112, 610, 4, 42, 2); g.fill();
    PL.text(g, '$', 138, 644, { size: 25, font: F.mono, color: C.accent });
    PL.text(g, T.cmd, 172, 642, {
      size: 23, font: F.mono, color: 'rgba(242,246,255,0.90)', maxW: 730,
    });

    // 三个要点
    let x = 110;
    for (const p of T.pts) {
      const w = PL.chip(g, p, x, 720, { size: 19, h: 48, pad: 22, fill: 'rgba(255,255,255,0.055)', stroke: 'rgba(255,255,255,0.16)', color: 'rgba(242,246,255,0.78)', font: BODY });
      x += w + 18;
    }

    PL.text(g, T.foot, 110, 900, {
      size: 21, font: BODY, color: 'rgba(242,246,255,0.64)',
    });

    // 右：三套真实比例
    PL.text(g, T.right, 1010, 300, {
      size: 22, font: F.mono, color: C.accent, track: 1.5,
    });
    const specs = [
      { w: 420, h: 236, label: '1920×1080' },
      { w: 210, h: 280, label: '1080×1440' },
      { w: 158, h: 280, label: '1080×1920' },
    ];
    const gap = 30, baseY = 790;
    let rx = 1010;
    for (const s of specs) {
      const y = baseY - s.h;
      // 轻微投影，让三块从背景里浮起来
      g.save();
      g.shadowColor = 'rgba(0,0,0,0.55)'; g.shadowBlur = 30; g.shadowOffsetY = 12;
      // 封面是静态物料，进度条用局部动画的 t/total 表示 p；
      // 若沿用全片 32.6s，1.00s 处只有 3% 会缩成一个小点，右侧显得没做完。
      PL.miniFrame(g, rx, y, s.w, s.h, 1.0, { caption: 'FRAME(t)', r: 9, total: 1.2 });
      g.restore();
      PL.text(g, s.label, rx + s.w / 2, 828, {
        size: 17, font: F.mono, color: C.sub, align: 'center', maxW: s.w + 40,
      });
      rx += s.w + gap;
    }

    // 底部橙色渐隐线
    const grd = g.createLinearGradient(0, 0, W0, 0);
    grd.addColorStop(0, PL.rgba(C.accent, 0.85));
    grd.addColorStop(0.55, PL.rgba(C.accent, 0.22));
    grd.addColorStop(1, PL.rgba(C.accent, 0));
    g.fillStyle = grd;
    g.fillRect(0, H0 - 6, W0, 6);
    PL.chrome(g, W0, H0, 0, CP.brand);
  }

  // 封面是静态帧：seek 到任何时刻都返回同一画面
  window.__seek = () => draw(0.8);
  if (window.__seekRender) { draw(0.8); window.__ready = true; }
  else draw(0.8);
})();
