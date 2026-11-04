/* =========================================================================
   promo-lib.js — 推广片共用绘制层
   纯函数、无随机数、不读时钟：所有画面只由 t 决定，符合 html-to-video 的
   「frame(t) 纯函数」契约。同一帧渲两次逐像素一致。
   ========================================================================= */
(function (root) {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, p) => a + (b - a) * p;

  const C = {
    bg: '#07090F',
    bg2: '#0D1220',
    ink: '#F2F6FF',
    // B站 / YouTube 会二次压制，0.5 以下的灰在手机上一压就没了。
    // 独立审片指出小字偏灰，这里整体抬一档，层次靠字号而不是靠压暗。
    sub: 'rgba(242,246,255,0.68)',
    dim: 'rgba(242,246,255,0.46)',
    faint: 'rgba(242,246,255,0.10)',
    line: 'rgba(255,255,255,0.085)',
    panel: 'rgba(255,255,255,0.045)',
    panel2: 'rgba(255,255,255,0.075)',
    accent: '#FFB86B',
    accent2: '#7C9CFF',
    cyan: '#5EEAD4',
    good: '#4ADE80',
    bad: '#FF8585',   // 原 #FF6B6B 经 H.264 + 平台二次压制后偏暗红，独立审片点名
  };

  const F = {
    zh: '"Microsoft YaHei","PingFang SC",system-ui,sans-serif',
    en: '"Segoe UI",Inter,Arial,system-ui,sans-serif',
    mono: 'Consolas,"SF Mono",ui-monospace,monospace',
  };

  const P = { C, F, TAU, clamp, lerp };

  P.rgba = function (hex, a) {
    if (typeof hex !== 'string' || hex[0] !== '#') return hex;
    let h = hex.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  };

  /* 缓动 */
  P.smooth = t => { t = clamp(t, 0, 1); return t * t * t * (10 - 15 * t + 6 * t * t); };
  P.expoOut = t => { t = clamp(t, 0, 1); return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t); };
  P.expoIn = t => { t = clamp(t, 0, 1); return t <= 0 ? 0 : Math.pow(2, 10 * t - 10); };
  P.backOut = (t, s) => { t = clamp(t, 0, 1); s = s || 1.7; const q = t - 1; return 1 + (s + 1) * q * q * q + s * q * q; };
  P.seg = (t, a, b) => clamp((t - a) / (b - a), 0, 1);
  P.at = (t, a, d, ease) => (ease || P.smooth)(clamp((t - a) / d, 0, 1));

  /* 圆角矩形 path */
  P.rr = function (g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  };

  P.panel = function (g, x, y, w, h, o) {
    o = o || {};
    P.rr(g, x, y, w, h, o.r === undefined ? 16 : o.r);
    if (o.fill) { g.fillStyle = o.fill; g.fill(); }
    if (o.stroke) { g.lineWidth = o.lw || 1; g.strokeStyle = o.stroke; g.stroke(); }
  };

  /* 文字：支持字距（逐字绘制，跨机器稳定）与最大宽度自动缩放 */
  P.text = function (g, s, x, y, o) {
    o = o || {};
    const size = o.size || 32;
    const weight = o.weight || 400;
    const font = o.font || F.zh;
    g.save();
    g.font = weight + ' ' + size + 'px ' + font;
    g.fillStyle = o.color || C.ink;
    g.textBaseline = o.baseline || 'alphabetic';
    // 必须相乘：外层可能已在做镜头淡入淡出 / 分组淡出。
    // 早期版本这里写成赋值，把外层 alpha 覆盖掉，导致带 alpha 的文字
    // 在整组退场后仍孤零零留在画面上。
    if (o.alpha !== undefined) g.globalAlpha *= o.alpha;
    if (o.shadow) { g.shadowColor = o.shadow; g.shadowBlur = o.shadowBlur || 24; }
    const track = o.track || 0;
    let use = size;
    if (o.maxW) {
      const w = P.measure(g, String(s), track);
      if (w > o.maxW) {
        use = Math.max(10, size * o.maxW / w);
        g.font = weight + ' ' + use + 'px ' + font;
      }
    }
    const str = String(s);
    const tw = P.measure(g, str, track * use / size);
    let sx = x;
    if (o.align === 'center') sx = x - tw / 2;
    else if (o.align === 'right') sx = x - tw;
    if (track) {
      let cx = sx;
      for (const ch of str) {
        g.fillText(ch, cx, y);
        cx += g.measureText(ch).width + track * use / size;
      }
    } else {
      g.fillText(str, sx, y);
    }
    g.restore();
    return tw;
  };

  P.measure = function (g, s, track) {
    let w = 0;
    for (const ch of String(s)) w += g.measureText(ch).width + (track || 0);
    return w;
  };

  P.wrap = function (g, s, maxW, size, font, weight) {
    g.save();
    g.font = (weight || 400) + ' ' + size + 'px ' + (font || F.zh);
    const lines = [];
    let cur = '';
    for (const ch of String(s)) {
      const test = cur + ch;
      if (g.measureText(test).width > maxW && cur) { lines.push(cur); cur = ch; }
      else cur = test;
    }
    if (cur) lines.push(cur);
    g.restore();
    return lines;
  };

  /* 背景：深色渐变 + 细网格 + 两团缓慢漂移的光 + 固定种子点阵 */
  P.backdrop = function (g, W, H, t) {
    const grd = g.createLinearGradient(0, 0, W, H);
    grd.addColorStop(0, '#070910');
    grd.addColorStop(0.55, C.bg);
    grd.addColorStop(1, '#0A0E1A');
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);

    // 光斑：位置是 t 的纯函数（缓慢漂移）
    P.orb(g, W * (0.16 + 0.035 * Math.sin(t * 0.19)), H * 0.20, Math.max(W, H) * 0.46, P.rgba(C.accent, 0.075));
    P.orb(g, W * (0.88 + 0.03 * Math.cos(t * 0.16)), H * 0.86, Math.max(W, H) * 0.48, P.rgba(C.accent2, 0.085));

    // 网格
    g.save();
    g.strokeStyle = 'rgba(255,255,255,0.028)';
    g.lineWidth = 1;
    const gap = 80;
    const off = (t * 5) % gap;
    g.beginPath();
    for (let x = -gap + off; x < W + gap; x += gap) { g.moveTo(x, 0); g.lineTo(x, H); }
    for (let y = -gap + off; y < H + gap; y += gap) { g.moveTo(0, y); g.lineTo(W, y); }
    g.stroke();
    g.restore();

    // 固定种子星点（LCG，不用 Math.random）
    g.save();
    let seed = 20261104;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 90; i++) {
      const x = rnd() * W, y = rnd() * H, r = 0.5 + rnd() * 1.1;
      const a = 0.06 + 0.10 * (0.5 + 0.5 * Math.sin(t * 0.8 + i * 1.7));
      g.fillStyle = 'rgba(255,255,255,' + a.toFixed(3) + ')';
      g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    }
    g.restore();
  };

  P.orb = function (g, x, y, r, color) {
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, color);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  };

  /* 镜头切换时的一道横向扫描亮线 */
  P.scan = function (g, W, H, t, cutTimes) {
    for (const c of cutTimes) {
      const d = t - c;
      if (d < 0 || d > 0.42) continue;
      const p = d / 0.42;
      const x = W * P.expoOut(p);
      const grd = g.createLinearGradient(x - 180, 0, x, 0);
      grd.addColorStop(0, 'rgba(255,255,255,0)');
      grd.addColorStop(1, P.rgba(C.accent, 0.14 * (1 - p)));
      g.fillStyle = grd;
      g.fillRect(x - 180, 0, 180, H);
      g.fillStyle = P.rgba(C.accent, 0.35 * (1 - p));
      g.fillRect(x - 1.5, 0, 2, H);
    }
  };

  /* 顶部细品牌条 + 右下角角标，全片常驻（建立品牌一致性） */
  P.chrome = function (g, W, H, t, label) {
    g.save();
    g.strokeStyle = 'rgba(255,255,255,0.10)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, 3); g.lineTo(W, 3); g.stroke();
    const p = (t * 0.055) % 1;
    g.fillStyle = P.rgba(C.accent, 0.85);
    g.fillRect(p * W - 90, 0, 180, 3);
    g.restore();

    P.text(g, label || 'HTML → VIDEO', W - 56, H - 40, {
      size: 15, font: F.mono, color: 'rgba(242,246,255,0.42)', align: 'right', track: 1.2,
    });
  };

  /* 小标签 / 胶囊 */
  P.chip = function (g, s, x, y, o) {
    o = o || {};
    const size = o.size || 17;
    g.save();
    g.font = (o.weight || 600) + ' ' + size + 'px ' + (o.font || F.mono);
    const w = g.measureText(s).width + (o.pad || 26) * 2;
    const h = o.h || 36;
    P.panel(g, x, y, w, h, {
      r: h / 2,
      fill: o.fill || P.rgba(C.accent, 0.10),
      stroke: o.stroke || P.rgba(C.accent, 0.35),
    });
    P.text(g, s, x + w / 2, y + h / 2 + size * 0.34, {
      size, font: o.font || F.mono, color: o.color || C.accent,
      align: 'center', weight: o.weight || 600,
    });
    g.restore();
    return w;
  };

  /* 代码面板：逐行打字，带行号、语法着色 */
  P.codeBox = function (g, x, y, w, h, lines, reveal, o) {
    o = o || {};
    P.panel(g, x, y, w, h, { r: 14, fill: 'rgba(6,9,16,0.86)', stroke: 'rgba(255,255,255,0.11)' });
    // 窗口标题栏
    g.save();
    g.fillStyle = 'rgba(255,255,255,0.035)';
    P.rr(g, x, y, w, 44, 14); g.fill();
    g.fillRect(x, y + 30, w, 14);
    g.restore();
    const dots = ['#FF6B6B', '#FFB86B', '#4ADE80'];
    for (let i = 0; i < 3; i++) {
      g.fillStyle = dots[i];
      g.beginPath(); g.arc(x + 26 + i * 22, y + 22, 5, 0, TAU); g.fill();
    }
    P.text(g, o.title || 'frame.js', x + w / 2, y + 28, {
      size: 15, font: F.mono, color: 'rgba(242,246,255,0.42)', align: 'center',
    });

    const fs = o.size || 21;
    const lh = o.lineH || 34;
    let total = 0;
    P.text(g, '', 0, 0, {});
    g.save();
    g.font = '400 ' + fs + 'px ' + F.mono;
    for (let i = 0; i < lines.length; i++) total += lines[i].length;
    let consumed = 0;
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      const yy = y + 44 + 34 + i * lh;
      if (yy > y + h - 12) break;
      P.text(g, String(i + 1).padStart(2, '0'), x + 24, yy, {
        size: fs * 0.8, font: F.mono, color: 'rgba(242,246,255,0.20)',
      });
      const local = clamp((reveal * total - consumed), 0, L.length);
      const shown = L.slice(0, Math.floor(local));
      // 语法着色：关键字 / 字符串 / 数字 / 注释
      const parts = P.syntax(shown);
      let cx = x + 62;
      for (const p of parts) {
        P.text(g, p.s, cx, yy, { size: fs, font: F.mono, color: p.c });
        g.save(); g.font = '400 ' + fs + 'px ' + F.mono;
        cx += g.measureText(p.s).width;
        g.restore();
      }
      // 光标
      if (i === Math.min(lines.length - 1, Math.floor(reveal * lines.length)) && reveal < 1 && local > 0) {
        g.fillStyle = C.accent;
        g.fillRect(cx + 2, yy - fs * 0.82, 2, fs * 1.02);
      }
      consumed += L.length;
    }
    g.restore();
  };

  P.syntax = function (s) {
    const out = [];
    const re = /(\/\/.*$|"[^"]*"|'[^']*'|\b(?:const|let|function|return|window|if|new|true|false|null)\b|\b\d+(?:\.\d+)?\b|#[0-9A-Fa-f]{3,6})/g;
    let last = 0, m;
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) out.push({ s: s.slice(last, m.index), c: 'rgba(242,246,255,0.80)' });
      const v = m[0];
      let c = C.accent2;
      if (v[0] === '"' || v[0] === "'" || v[0] === '#') c = C.accent;
      else if (/^\d/.test(v)) c = C.cyan;
      else if (v.slice(0, 2) === '//') c = 'rgba(242,246,255,0.30)';
      out.push({ s: v, c });
      last = m.index + v.length;
    }
    if (last < s.length) out.push({ s: s.slice(last), c: 'rgba(242,246,255,0.80)' });
    return out;
  };

  /* 一个「真实渲染结果」的小画面：时间码 + 时间轴 + 圆点。
     用来在多个镜头里证明同一份画面可以出现在任意比例里。

     ⚠️ 早期版本这里放了一个滚到 12,800 的假「已渲染帧数」。独立审片判定为
     P1：本片主打「确定性 / 逐像素精确」，画面里却同时出现 12,782、12,800
     和全片的 978 帧，而且三种不同尺寸都显示同一个 12,800 —— 观众会认为
     所有数据都是编的。现在只呈现 frame(t) 的自变量 t：同一个 t，在任意
     比例里必然是同一帧、同一个时间码，这正是要卖的东西。 */
  P.miniFrame = function (g, x, y, w, h, t, o) {
    o = o || {};
    g.save();
    P.rr(g, x, y, w, h, o.r === undefined ? 8 : o.r);
    g.clip();
    const grd = g.createLinearGradient(x, y, x + w, y + h);
    grd.addColorStop(0, '#0B1020');
    grd.addColorStop(1, '#131A2E');
    g.fillStyle = grd; g.fillRect(x, y, w, h);

    const pad = w * 0.09;
    // 顶部小标签
    g.fillStyle = P.rgba(C.accent, 0.85);
    g.fillRect(x + pad, y + h * 0.16, w * 0.13, Math.max(2, h * 0.018));

    // 唯一的大数字 = 当前帧的时间码（frame(t) 的自变量），不是任何计数。
    // 单位与数字一体绘制：之前把 "s" 单独用 0.42 倍字号画在右边，
    // 静帧目验发现在小框里那个 s 看起来就是一个多余的小句点
    // （"28.30."），对一个主打像素级精确的工具是硬伤。
    const fsize = Math.min(w * 0.20, h * 0.26);
    P.text(g, t.toFixed(2) + 's', x + pad, y + h * 0.55, {
      size: fsize, weight: 700, font: F.en, color: C.ink,
      maxW: w - pad * 2,
    });
    P.text(g, o.caption || 'FRAME(t)', x + pad, y + h * 0.66, {
      size: Math.max(9, w * 0.036), font: F.mono, color: P.rgba(C.ink, 0.58), track: 1,
      maxW: w - pad * 2,
    });

    // 底部时间轴：与 self 镜头浏览器窗里的 scrubber 同源（t / 全片时长）
    const p = P.clamp(t / (o.total || 32.6), 0, 1);
    g.fillStyle = 'rgba(255,255,255,0.10)';
    P.rr(g, x + pad, y + h * 0.78, w - pad * 2, Math.max(3, h * 0.028), 4); g.fill();
    g.fillStyle = C.accent;
    P.rr(g, x + pad, y + h * 0.78, (w - pad * 2) * p, Math.max(3, h * 0.028), 4); g.fill();
    // 右上角呼吸圆点
    const blink = 0.45 + 0.4 * Math.sin(t * 2.4);
    g.fillStyle = P.rgba(C.good, blink);
    g.beginPath(); g.arc(x + w - pad, y + h * 0.18, Math.max(3, w * 0.014), 0, TAU); g.fill();
    g.restore();

    P.panel(g, x, y, w, h, { r: o.r === undefined ? 8 : o.r, stroke: 'rgba(255,255,255,0.16)' });
  };

  /* 图标：只画推广片需要的几个，线性风格 */
  P.icon = function (g, kind, cx, cy, s, color, lw) {
    g.save();
    g.translate(cx - s / 2, cy - s / 2);
    g.scale(s / 24, s / 24);
    g.strokeStyle = color; g.fillStyle = color;
    g.lineWidth = (lw || 2) * 24 / s;
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath();
    if (kind === 'check') { g.moveTo(4, 12.5); g.lineTo(9.5, 17.5); g.lineTo(20, 6); g.stroke(); }
    else if (kind === 'cross') { g.moveTo(6, 6); g.lineTo(18, 18); g.moveTo(18, 6); g.lineTo(6, 18); g.stroke(); }
    else if (kind === 'code') { g.moveTo(8.5, 6); g.lineTo(3.5, 12); g.lineTo(8.5, 18); g.moveTo(15.5, 6); g.lineTo(20.5, 12); g.lineTo(15.5, 18); g.stroke(); }
    else if (kind === 'wave') {
      g.moveTo(2, 12);
      for (let i = 0; i <= 20; i++) { const x = 2 + i; const y = 12 + 6 * Math.sin(i * 0.7) * (1 - i / 26); g.lineTo(x, y); }
      g.stroke();
    }
    else if (kind === 'braces') { g.moveTo(9, 4); g.lineTo(5, 4); g.lineTo(5, 10); g.lineTo(3, 12); g.lineTo(5, 14); g.lineTo(5, 20); g.lineTo(9, 20); g.stroke(); g.beginPath(); g.moveTo(15, 4); g.lineTo(19, 4); g.lineTo(19, 10); g.lineTo(21, 12); g.lineTo(19, 14); g.lineTo(19, 20); g.lineTo(15, 20); g.stroke(); }
    else if (kind === 'grid') { for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { g.beginPath(); g.rect(3 + i * 7, 3 + j * 7, 5, 5); g.stroke(); } }
    else if (kind === 'terminal') { g.beginPath(); g.rect(3, 4, 18, 16); g.stroke(); g.beginPath(); g.moveTo(6.5, 9); g.lineTo(10, 12); g.lineTo(6.5, 15); g.moveTo(11, 16); g.lineTo(16, 16); g.stroke(); }
    else if (kind === 'star') { g.moveTo(12, 3); g.lineTo(14.7, 9.2); g.lineTo(21.5, 9.9); g.lineTo(16.4, 14.4); g.lineTo(17.8, 21); g.lineTo(12, 17.6); g.lineTo(6.2, 21); g.lineTo(7.6, 14.4); g.lineTo(2.5, 9.9); g.lineTo(9.3, 9.2); g.closePath(); g.stroke(); }
    else if (kind === 'bolt') { g.moveTo(13.5, 2.5); g.lineTo(5.5, 13.5); g.lineTo(11, 13.5); g.lineTo(9, 21.5); g.lineTo(18.5, 9.5); g.lineTo(12.8, 9.5); g.closePath(); g.stroke(); }
    else if (kind === 'play') { g.moveTo(8, 5.4); g.lineTo(18.4, 12); g.lineTo(8, 18.6); g.closePath(); g.fill(); }
    g.restore();
  };

  root.PL = P;
})(window);
