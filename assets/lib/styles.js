/* =========================================================================
   风格系统 SV · 把「视觉语言」和「版式内容」拆开
   -------------------------------------------------------------------------
   为什么要有这一层：

     现在 11 个模板各写各的 canvas 代码，配色靠 themes.js 换（只有 3 套）。
     结果是「版式能换，但看起来还是同一个软件做的」——
     深色科技风、米色文档风，两张图放一起没人分得清谁是谁。

     顶级做法（见 lemo / animate / mg-styles-15）是把风格做成插件：
     故事结构、时序、渲染器不变，风格只提供「绘画工具箱」——
     纸是什么纸、墨是什么墨、线多粗、字多紧、入场怎么动、签名元素是什么。

     于是「11 个模板 × 8 种风格 = 88 种观感」，而不是写 88 个模板。

   -------------------------------------------------------------------------
   用法：

     <script src="../lib/styles.js"></script>
     const ST = SV.get(CFG.style || 'riso');   // 没给就用默认
     const TH = ST.theme;                       // 兼容旧 themes.js 的字段

     // 背景（含纸纹/网格/透视地面，随时间极缓慢变化）
     SV.bg(g, ST, W, H, t);

     // 前景覆盖层（扫描线/颗粒/暗角）—— 画在所有内容之上
     SV.overlay(g, ST, W, H, t);

     // 文字（自动套字重/字距/描边/投影）
     SV.text(g, ST, '标题', x, y, size, { kind:'display', align:'left', p:0.4 });
     SV.text(g, ST, '正文', x, y, size, { kind:'body' });

     // 色块 / 卡片 / 强调条（每种风格的「面」都不一样）
     SV.card(g, ST, { x, y, w, h }, { p: 0.8, accent: true });
     SV.bar(g, ST, { x, y, w, h }, p);         // 条形图用的条

     // 手抖（粉笔/剪纸/水墨用；其余风格返回 0）
     const d = SV.boil(ST, t, i, 2.2);

   -------------------------------------------------------------------------
   硬约束（和整个项目一致）：

     1. **纯函数**：所有绘制只依赖传入的 t 与坐标，不读时钟、不用 Math.random。
        纹理噪点走 seeded PRNG（同一个 seed 永远同一张图），否则 QA 的
        「确定性」会亮红灯，多 worker 并行渲染也会各渲各的。
     2. **不写死 1920×1080**：所有尺寸按传入的 W/H 与 SF=√(SX·SY) 缩放。
     3. **背景必须铺满**：转场是离屏画布按 alpha 叠加的，风格背景留透明会闪底色。

   -------------------------------------------------------------------------
   加一种新风格要写什么（照着 STYLES 里任意一项抄结构）：

     id / cn / en / tags / dark      —— 目录信息
     theme                           —— 兼容 themes.js 的 11+5 个字段
     type                            —— display / body / mono 字体族、字重、字距
     bg(g,W,H,t,o)                   —— 底面（纸、网格、渐变、地平线）
     overlay(g,W,H,t,o)              —— 覆盖层，可为 null
     text(g,txt,x,y,size,o)          —— 文字画法（描边/投影/辉光/错位）
     card(g,box,o)                   —— 面（纸片/卡片/描边框/无）
     bar(g,box,p,o)                  —— 条（纯色/网点半调/描边）
     boil(t,i,amp)                   —— 手抖偏移（不需要就返回 0）
     motion                          —— { enter, overshoot, ease } 动效手感

   写完跑：
     node scripts/render-video-seek.js assets/style-gallery.html --stills=1 --width=1920 --height=1080
   看九宫格对不对，再进模板。
   ========================================================================= */
(function (root) {
  'use strict';

  /* ── 通用小工具 ─────────────────────────────────────────────────── */

  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;

  const ease = {
    linear: (t) => clamp(t),
    outCubic: (t) => 1 - Math.pow(1 - clamp(t), 3),
    inCubic: (t) => Math.pow(clamp(t), 3),
    inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    outQuint: (t) => 1 - Math.pow(1 - clamp(t), 5),
    outBack: (t) => { const c = 1.70158, x = clamp(t) - 1; return 1 + (c + 1) * x * x * x + c * x * x; },
    outExpo: (t) => (1 - Math.pow(2, -10 * clamp(t))) / (1 - Math.pow(2, -10)),
    smooth: (t) => { t = clamp(t); return t * t * (3 - 2 * t); },
  };

  /* seeded PRNG：mulberry32。同 seed → 同序列，纹理才能「确定性」。 */
  function rng(seed) {
    let a = (seed | 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* 数值哈希：把 (i, t) 打散成 0..1。手抖用，必须是纯函数。 */
  function hash(i, t) {
    const n = Math.sin(i * 127.1 + Math.floor(t * 12) * 311.7) * 43758.5453;
    return n - Math.floor(n);
  }

  function hex2rgb(hex) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgba(hex, a) {
    const [r, gg, b] = hex2rgb(hex);
    return `rgba(${r},${gg},${b},${a})`;
  }
  /* 混色：t=0 → A，t=1 → B。半调叠印、墨色浓淡都要它。 */
  function mix(A, B, t) {
    const a = hex2rgb(A), b = hex2rgb(B);
    const c = [0, 1, 2].map((k) => Math.round(lerp(a[k], b[k], clamp(t))));
    return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  /* 纹理缓存：pattern 每帧重建很贵（1080p 一帧多 2~4ms），按 key 缓存。 */
  const _pat = new Map();
  function cached(key, make) {
    let v = _pat.get(key);
    if (!v) { v = make(); _pat.set(key, v); }
    return v;
  }

  /* 纸纹 / 颗粒：用离屏 canvas 生成一次，之后当 pattern 平铺。 */
  function noiseTile(size, seed, alpha, color) {
    return cached('nz' + size + '_' + seed + '_' + alpha + '_' + color, function () {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const x = c.getContext('2d');
      const img = x.createImageData(size, size);
      const R = rng(seed);
      const [r0, g0, b0] = hex2rgb(color || '#000000');
      for (let i = 0; i < img.data.length; i += 4) {
        const v = R();
        img.data[i] = r0;
        img.data[i + 1] = g0;
        img.data[i + 2] = b0;
        img.data[i + 3] = Math.round(v * v * 255 * alpha);  // 平方分布 → 稀疏颗粒，不是电视雪花
      }
      x.putImageData(img, 0, 0);
      return c;
    });
  }

  /* 半调网点：真正的印刷感来自「每色一套网角」。
     angle 弧度；step 网点间距；radiusRatio 点半径/间距；alpha 整体透明度。

     ⚠ 实现用「一个点做成 pattern，再整体旋转平铺」，不是逐点 loop。
     1080p 下 step=9 要画 2.5 万个 arc，一帧 40–60ms —— 一支 1 分钟的片子光网点
     就要多渲 1 分钟。pattern 版每帧只有 1 次 fillRect。 */
  function halftone(g, W, H, color, angle, step, radiusRatio, alpha) {
    const s = Math.max(3, Math.round(step));
    const tile = cached('ht' + s + '_' + radiusRatio + '_' + color, function () {
      const c = document.createElement('canvas');
      c.width = c.height = s;
      const x = c.getContext('2d');
      x.fillStyle = color;
      x.beginPath();
      x.arc(s / 2, s / 2, s * (radiusRatio || 0.34), 0, Math.PI * 2);
      x.fill();
      return c;
    });
    g.save();
    g.globalAlpha = alpha == null ? 1 : alpha;
    const pat = g.createPattern(tile, 'repeat');
    if (pat) {
      g.translate(W / 2, H / 2);
      g.rotate(angle);
      g.translate(-W / 2, -H / 2);
      g.fillStyle = pat;
      // 旋转后要覆盖到四角，边长得给到对角线量级
      const R = Math.ceil(Math.hypot(W, H)) + s * 2;
      g.fillRect(W / 2 - R, H / 2 - R, R * 2, R * 2);
    }
    g.restore();
  }

  /* 手撕纸边：把矩形四条边都打成毛边，得到一条闭合路径。
     早期版本只在一条边上用 tornEdge、其余 lineTo 直连，路径其实是断的
     （tornEdge 内部会 moveTo），画出来是「一坨」，影子完全不对。 */
  function tornRectPath(g, w, h, amp, seed) {
    const sides = [[[0, 0], [w, 0]], [[w, 0], [w, h]], [[w, h], [0, h]], [[0, h], [0, 0]]];
    g.beginPath();
    let first = true;
    for (let s = 0; s < 4; s++) {
      const [a, b] = sides[s];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(5, Math.round(len / 18));
      const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
      for (let i = 0; i <= n; i++) {
        if (s > 0 && i === 0) continue;          // 接缝处不重复落点
        const k = i / n;
        const d = (hash(s * 37 + i, seed) - 0.5) * amp * 2;
        const x = a[0] + (b[0] - a[0]) * k + nx * d;
        const y = a[1] + (b[1] - a[1]) * k + ny * d;
        if (first) { g.moveTo(x, y); first = false; } else g.lineTo(x, y);
      }
    }
    g.closePath();
  }

  /* 探测本机可用的中文字体，给每种风格挑最贴的。
     Windows 一定有 微软雅黑 / 宋体 / 楷体 / 黑体，macOS 有 苹方 / 宋体-简。 */
  const F = {
    sans: '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif',
    serif: '"Songti SC", "SimSun", "Noto Serif CJK SC", Georgia, serif',
    kai: '"Kaiti SC", "KaiTi", "STKaiti", "Songti SC", serif',
    hei: '"Microsoft YaHei", "SimHei", "PingFang SC", sans-serif',
    /* 等宽族一定要挂中文字体：不挂，中文会 fallback 到衬线，
       蓝图/霓虹那种「等宽气质」当场变成宋体，一眼就露馅。 */
    mono: 'ui-monospace, "Cascadia Mono", Consolas, "SF Mono", "Microsoft YaHei", monospace',
    impact: 'Impact, "Arial Black", "Microsoft YaHei", sans-serif',
  };

  /* 含中日韩字符的串不能套西文字距 —— 西文 tracking -0.03em 是「紧致」，
     中文同一数值会把字挤到一起。中文只保留 1/4 的量。 */
  const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;
  function trackFor(txt, tracking, size) {
    const k = CJK.test(txt) ? 0.25 : 1;
    return (tracking * size * k).toFixed(2) + 'px';
  }

  /* ── 风格定义 ─────────────────────────────────────────────────────
     每个风格都按同一份契约实现。写的时候反复问三个问题：
       · 这张图只看 0.3 秒，能认出是哪个风格吗？（识别度）
       · 换成长中文标题还成立吗？（中文适配）
       · 灰掉以后还有层次吗？（不靠颜色的结构）
     ──────────────────────────────────────────────────────────────── */

  const STYLES = {};

  /* ────────────────────────────────────────────────────────────────
     1. RISO · 三色孔版印刷
     配方：米白纸 + 荧光粉/蓝/绿三套网点（各自网角）+ 套印错位 + 粗黑标题
     最适合：观点输出、数据对比、独立杂志感的产品片
     ──────────────────────────────────────────────────────────────── */
  STYLES.riso = {
    id: 'riso', cn: '孔版印刷', en: 'Riso Print', dark: false,
    tags: ['印刷', '独立', '高饱和', '数据'],
    theme: {
      bg: '#F4EFE6', bgAlt: '#EBE3D5', ink: '#141210',
      sub: 'rgba(20,18,16,0.62)', faint: 'rgba(20,18,16,0.14)',
      panel: 'rgba(255,72,176,0.10)',
      accent: '#FF48B0', accent2: '#0078BF', good: '#00A95C', bad: '#E5484D',
      glow: 'rgba(255,72,176,0.20)',
      accentDeep: '#C42A84', accentSoft: '#00A95C', sweep: '255,72,176', onAccent: '#FFF7FB',
      bgFar: '#EBE3D5',
    },
    type: { display: F.hei, body: F.hei, mono: F.mono, weight: 900, tracking: -0.03, lead: 1.18 },
    motion: { enter: 0.42, overshoot: 1.0, ease: 'outCubic' },

    bg(g, W, H, t, o) {
      g.fillStyle = '#F4EFE6';
      g.fillRect(0, 0, W, H);
      // 纸张底色不均：两块大色斑，随时间极缓漂移（0.02Hz，肉眼看是「静」的）
      const S = Math.sqrt((W / 1920) * (H / 1080));
      const drift = Math.sin(t * 0.13) * 26 * S;
      const g1 = g.createRadialGradient(W * 0.18 + drift, H * 0.12, 0, W * 0.18, H * 0.12, W * 0.7);
      g1.addColorStop(0, 'rgba(255,236,214,0.85)');
      g1.addColorStop(1, 'rgba(255,236,214,0)');
      g.fillStyle = g1; g.fillRect(0, 0, W, H);
      const g2 = g.createRadialGradient(W * 0.9, H * 0.95, 0, W * 0.9, H * 0.95, W * 0.6);
      g2.addColorStop(0, 'rgba(226,210,190,0.7)');
      g2.addColorStop(1, 'rgba(226,210,190,0)');
      g.fillStyle = g2; g.fillRect(0, 0, W, H);

      // 三套网角：粉 75° / 蓝 15° / 绿 45°。这是印刷厂的真实规矩。
      // alpha 别给高：三层叠上去会互相叠深，纸就「脏」了。
      halftone(g, W, H, '#FF48B0', (75 * Math.PI) / 180, 9 * S, 0.30, 0.10);
      halftone(g, W, H, '#0078BF', (15 * Math.PI) / 180, 11 * S, 0.28, 0.075);
      halftone(g, W, H, '#00A95C', (45 * Math.PI) / 180, 13 * S, 0.26, 0.05);

      // 纸纤维
      const nz = noiseTile(160, 11, 0.10, '#6B5B45');
      g.save();
      g.globalAlpha = 0.5;
      g.fillStyle = g.createPattern(nz, 'repeat');
      g.fillRect(0, 0, W, H);
      g.restore();
    },

    overlay(g, W, H) {
      const S = Math.sqrt((W / 1920) * (H / 1080));
      // 套印脏边：四周一圈极淡的墨膜
      const v = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
      v.addColorStop(0, 'rgba(0,0,0,0)');
      v.addColorStop(1, 'rgba(80,60,40,0.10)');
      g.fillStyle = v; g.fillRect(0, 0, W, H);
      void S;
    },

    text(g, txt, x, y, size, o) {
      o = o || {};
      const kind = o.kind || 'body';
      const fam = kind === 'mono' ? this.type.mono : (kind === 'body' ? this.type.body : this.type.display);
      const wgt = kind === 'display' ? this.type.weight : (kind === 'sub' ? 600 : 700);
      g.save();
      g.font = `${wgt} ${size}px ${fam}`;
      g.textAlign = o.align || 'left';
      g.textBaseline = o.baseline || 'alphabetic';
      if ('letterSpacing' in g) g.letterSpacing = trackFor(txt, this.type.tracking, size);
      // 印刷错版：标题先印一层偏青的，再压黑色 —— 这是 riso 的灵魂
      if (kind === 'display') {
        g.globalAlpha = 0.55;
        g.fillStyle = '#0078BF';
        g.fillText(txt, x + size * 0.012, y + size * 0.008);
        g.fillStyle = '#FF48B0';
        g.fillText(txt, x - size * 0.010, y - size * 0.006);
        g.globalAlpha = 1;
      }
      g.fillStyle = o.color || (kind === 'sub' ? this.theme.sub : this.theme.ink);
      g.fillText(txt, x, y);
      g.restore();
    },

    /* 卡片返回「内容安全框」：风格不同，能放字的地方也不同（等距只能放顶面）。
       调用方拿返回值排字，才不会出现「文字压在立体块的斜面上」这种穿帮。 */
    card(g, box, o) {
      o = o || {};
      const S = o.S || 1;
      g.save();
      g.fillStyle = o.accent ? this.theme.accent : rgba('#FF48B0', 0.13);
      g.fillRect(box.x, box.y, box.w, box.h);
      // 网点必须 clip 在卡片内，否则会以画布中心为原点画到整屏 —— 早期版本就是这个 bug
      g.beginPath();
      g.rect(box.x, box.y, box.w, box.h);
      g.clip();
      g.translate(box.x, box.y);
      halftone(g, box.w, box.h, o.accent ? '#FFFFFF' : '#FF48B0', (75 * Math.PI) / 180, 7 * S, 0.30, o.accent ? 0.18 : 0.22);
      g.restore();
      if (o.border) {
        g.save();
        g.strokeStyle = this.theme.ink; g.lineWidth = 3 * S;
        g.strokeRect(box.x, box.y, box.w, box.h);
        g.restore();
      }
      const pad = 40 * (o.S || 1);
      return { x: box.x + pad, y: box.y + pad, w: box.w - pad * 2, h: box.h - pad * 2, ink: this.theme.ink };
    },

    bar(g, box, p, o) {
      o = o || {};
      const S = o.S || 1;
      const w = box.w * clamp(p);
      g.save();
      g.fillStyle = o.color || this.theme.accent;
      g.fillRect(box.x, box.y, w, box.h);
      g.beginPath();
      g.rect(box.x, box.y, w, box.h);
      g.clip();
      g.translate(box.x, box.y);
      halftone(g, Math.max(1, w), box.h, '#FFFFFF', (45 * Math.PI) / 180, 6 * S, 0.32, 0.30);
      g.restore();
    },

    boil(t, i, amp) { return Math.sin(i * 9.1 + Math.floor(t * 8) * 2.3) * amp * 0.25; },
  };

  /* ────────────────────────────────────────────────────────────────
     2. CUTPAPER · 剪纸拼贴
     配方：牛皮纸底 + 硬投影纸片 + 手撕边 + 微旋转 + 圆体字
     最适合：故事、人物、儿童/教育、有温度的产品叙事
     ──────────────────────────────────────────────────────────────── */
  STYLES.cutpaper = {
    id: 'cutpaper', cn: '剪纸拼贴', en: 'Cut Paper', dark: false,
    tags: ['手作', '暖', '故事', '儿童'],
    theme: {
      bg: '#E9DCC6', bgAlt: '#DFCFB4', ink: '#2A2118',
      sub: 'rgba(42,33,24,0.64)', faint: 'rgba(42,33,24,0.16)',
      panel: 'rgba(255,255,255,0.55)',
      accent: '#D9583B', accent2: '#2F6F62', good: '#4C7A3F', bad: '#B23A2E',
      glow: 'rgba(217,88,59,0.16)',
      accentDeep: '#A83C24', accentSoft: '#2F6F62', sweep: '217,88,59', onAccent: '#FFF6EE',
      bgFar: '#DFCFB4',
    },
    type: { display: F.hei, body: F.sans, mono: F.mono, weight: 800, tracking: 0.01, lead: 1.22 },
    motion: { enter: 0.55, overshoot: 1.12, ease: 'outBack' },

    bg(g, W, H, t) {
      g.fillStyle = '#E9DCC6';
      g.fillRect(0, 0, W, H);
      const S = Math.sqrt((W / 1920) * (H / 1080));
      // 牛皮纸纤维：斜向细纹
      g.save();
      g.globalAlpha = 0.20;
      g.strokeStyle = '#A88F6B';
      g.lineWidth = 1 * S;
      const R = rng(23);
      for (let i = 0; i < 220; i++) {
        const x = R() * W, y = R() * H, len = (10 + R() * 60) * S;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + len, y + len * 0.18); g.stroke();
      }
      g.restore();
      const nz = noiseTile(200, 31, 0.16, '#7A6446');
      g.save(); g.globalAlpha = 0.55; g.fillStyle = g.createPattern(nz, 'repeat'); g.fillRect(0, 0, W, H); g.restore();
      // 四角压暗
      const v = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.42, W / 2, H / 2, Math.max(W, H) * 0.78);
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(58,42,24,0.20)');
      g.fillStyle = v; g.fillRect(0, 0, W, H);
      void t;
    },

    overlay() {},

    /* 纸片：投影 → 纸面 → 纤维。四条边都是手撕边 —— 直边一出现立刻变「PPT 色块」。
       下面再垫一张错开的浅色纸，做出「两层纸叠着」的厚度。 */
    card(g, box, o) {
      o = o || {};
      const S = o.S || 1;
      const rot = (o.rot == null ? 0 : o.rot);
      const fill = o.accent ? this.theme.accent : (o.fill || '#FBF5E9');
      const seed = o.seed || 3;
      g.save();
      g.translate(box.x + box.w / 2, box.y + box.h / 2);
      g.rotate(rot);
      g.translate(-box.w / 2, -box.h / 2);

      // 垫在下面的第二张纸（略大、略偏、颜色更浅）
      g.save();
      g.translate(-4 * S, 5 * S);
      tornRectPath(g, box.w + 8 * S, box.h + 8 * S, 4.5 * S, seed + 7);
      g.fillStyle = '#E0D0B2';
      g.fill();
      g.restore();

      // 硬投影：不用 blur。模糊会让影子变「数字感」，剪纸的影子是锐的。
      g.save();
      g.translate(6 * S, 9 * S);
      tornRectPath(g, box.w, box.h, 5 * S, seed);
      g.fillStyle = 'rgba(58,42,24,0.34)';
      g.fill();
      g.restore();

      // 纸面
      tornRectPath(g, box.w, box.h, 5 * S, seed);
      g.fillStyle = fill;
      g.fill();

      // 纸的纤维
      g.save();
      g.clip();
      g.globalAlpha = 0.18;
      g.fillStyle = g.createPattern(noiseTile(120, 41, 0.4, '#6B5433'), 'repeat');
      g.fillRect(0, 0, box.w, box.h);
      g.restore();
      g.restore();

      const pad = 38 * S;
      return { x: box.x + pad, y: box.y + pad, w: box.w - pad * 2, h: box.h - pad * 2, ink: this.theme.ink };
    },

    bar(g, box, p, o) {
      o = o || {};
      const S = o.S || 1;
      const w = Math.max(0, box.w * clamp(p));
      if (w < 1) return;
      g.save();
      g.fillStyle = 'rgba(58,42,24,0.22)';
      g.fillRect(box.x + 3 * S, box.y + 4 * S, w, box.h);
      g.fillStyle = o.color || this.theme.accent;
      g.fillRect(box.x, box.y, w, box.h);
      g.restore();
    },

    text(g, txt, x, y, size, o) {
      o = o || {};
      const kind = o.kind || 'body';
      const fam = kind === 'mono' ? this.type.mono : (kind === 'display' ? this.type.display : this.type.body);
      g.save();
      g.font = `${kind === 'display' ? this.type.weight : 600} ${size}px ${fam}`;
      g.textAlign = o.align || 'left';
      g.textBaseline = o.baseline || 'alphabetic';
      // 纸上的字也是「贴上去的」：一道投影 + 一道上缘高光。
      // 只加 1.5px 的浅阴影等于没加，字看着还是「直接印在屏幕上」。
      const big = kind === 'display';
      const dx = big ? 4 : 1.5, dy = big ? 6 : 2.5;
      g.fillStyle = 'rgba(58,42,24,' + (big ? 0.26 : 0.30) + ')';
      g.fillText(txt, x + dx, y + dy);
      if (big) {
        g.fillStyle = 'rgba(255,255,255,0.55)';
        g.fillText(txt, x, y - 1.5);
      }
      g.fillStyle = o.color || (kind === 'sub' ? this.theme.sub : this.theme.ink);
      g.fillText(txt, x, y);
      g.restore();
    },

    boil(t, i, amp) { return Math.sin(i * 5.7 + Math.floor(t * 6) * 1.9) * amp * 0.35; },
  };

  /* ────────────────────────────────────────────────────────────────
     3. BLUEPRINT · 工程蓝图
     配方：深蓝底 + 双层格网 + 白色细线 + 等宽标注 + 尺寸线箭头
     最适合：技术讲解、架构图、API/SDK 介绍、硬核产品
     ──────────────────────────────────────────────────────────────── */
  STYLES.blueprint = {
    id: 'blueprint', cn: '工程蓝图', en: 'Blueprint', dark: true,
    tags: ['技术', '架构', '深色', '等宽'],
    theme: {
      bg: '#0A2547', bgAlt: '#0E2E56', ink: '#EAF4FF',
      sub: 'rgba(234,244,255,0.62)', faint: 'rgba(160,210,255,0.20)',
      panel: 'rgba(120,200,255,0.08)',
      accent: '#7FD4FF', accent2: '#FFD166', good: '#5CE1A0', bad: '#FF8A8A',
      glow: 'rgba(127,212,255,0.22)',
      accentDeep: '#3FA9E0', accentSoft: '#FFD166', sweep: '160,220,255', onAccent: '#062138',
      bgFar: '#081C36',
    },
    type: { display: F.mono, body: F.sans, mono: F.mono, weight: 700, tracking: 0.06, lead: 1.5 },
    motion: { enter: 0.7, overshoot: 1.0, ease: 'outQuint' },

    bg(g, W, H, t) {
      const S = Math.sqrt((W / 1920) * (H / 1080));
      const grad = g.createLinearGradient(0, 0, W * 0.3, H);
      grad.addColorStop(0, '#0C2B52');
      grad.addColorStop(0.55, '#0A2547');
      grad.addColorStop(1, '#071B34');
      g.fillStyle = grad; g.fillRect(0, 0, W, H);

      // 双层格网：20px 细 / 100px 粗。蓝图的味道全在这两条线。
      const fine = 20 * S, bold = 100 * S;
      const drift = (t * 6 * S) % bold;   // 极缓平移，暗示「画布在展开」
      g.save();
      g.strokeStyle = 'rgba(150,205,255,0.13)'; g.lineWidth = 1 * S;
      g.beginPath();
      for (let x = -(drift % fine); x < W + fine; x += fine) { g.moveTo(Math.round(x) + 0.5, 0); g.lineTo(Math.round(x) + 0.5, H); }
      for (let y = -drift; y < H + fine; y += fine) { g.moveTo(0, Math.round(y) + 0.5); g.lineTo(W, Math.round(y) + 0.5); }
      g.stroke();
      g.strokeStyle = 'rgba(160,215,255,0.26)'; g.lineWidth = 1.4 * S;
      g.beginPath();
      for (let x = -(drift % bold); x < W + bold; x += bold) { g.moveTo(Math.round(x) + 0.5, 0); g.lineTo(Math.round(x) + 0.5, H); }
      for (let y = -drift; y < H + bold; y += bold) { g.moveTo(0, Math.round(y) + 0.5); g.lineTo(W, Math.round(y) + 0.5); }
      g.stroke();
      g.restore();

      // 图框：蓝图必须有一个外框和内缩的标题栏
      const m = 34 * S;
      g.save();
      g.strokeStyle = 'rgba(200,235,255,0.5)'; g.lineWidth = 2 * S;
      g.strokeRect(m, m, W - m * 2, H - m * 2);
      g.strokeStyle = 'rgba(200,235,255,0.22)'; g.lineWidth = 1 * S;
      g.strokeRect(m + 8 * S, m + 8 * S, W - (m + 8 * S) * 2, H - (m + 8 * S) * 2);
      g.restore();
    },

    overlay(g, W, H) {
      const S = Math.sqrt((W / 1920) * (H / 1080));
      // 折痕 + 边缘磨损
      g.save();
      g.globalAlpha = 0.10; g.strokeStyle = '#FFFFFF'; g.lineWidth = 1 * S;
      g.beginPath(); g.moveTo(W * 0.5, 0); g.lineTo(W * 0.5, H); g.stroke();
      g.globalAlpha = 0.06;
      g.beginPath(); g.moveTo(0, H * 0.5); g.lineTo(W, H * 0.5); g.stroke();
      g.restore();
      const nz = noiseTile(180, 77, 0.09, '#9BD4FF');
      g.save(); g.globalAlpha = 0.35; g.fillStyle = g.createPattern(nz, 'repeat'); g.fillRect(0, 0, W, H); g.restore();
    },

    card(g, box, o) {
      o = o || {};
      const S = o.S || 1;
      g.save();
      g.fillStyle = o.accent ? 'rgba(127,212,255,0.18)' : 'rgba(6,26,50,0.72)';
      g.fillRect(box.x, box.y, box.w, box.h);
      g.strokeStyle = o.accent ? '#7FD4FF' : 'rgba(160,215,255,0.62)';
      g.lineWidth = 1.6 * S;
      g.strokeRect(box.x, box.y, box.w, box.h);
      // 四角十字标记：工程图的定位记号
      const c = 9 * S, e = 1.8 * S;
      g.strokeStyle = o.accent ? '#FFD166' : 'rgba(200,235,255,0.7)';
      g.lineWidth = e;
      const pts = [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]];
      for (const [px, py] of pts) {
        g.beginPath(); g.moveTo(px - c, py); g.lineTo(px + c, py); g.stroke();
        g.beginPath(); g.moveTo(px, py - c); g.lineTo(px, py + c); g.stroke();
      }
      g.restore();
      const pad = 34 * S;
      return { x: box.x + pad, y: box.y + pad, w: box.w - pad * 2, h: box.h - pad * 2, ink: this.theme.ink };
    },

    bar(g, box, p, o) {
      o = o || {};
      const S = o.S || 1;
      const w = Math.max(0, box.w * clamp(p));
      g.save();
      g.fillStyle = 'rgba(127,212,255,0.10)';
      g.fillRect(box.x, box.y, box.w, box.h);
      g.strokeStyle = 'rgba(160,215,255,0.45)'; g.lineWidth = 1 * S;
      g.strokeRect(box.x, box.y, box.w, box.h);
      if (w > 0.5) {
        g.fillStyle = o.color || '#7FD4FF';
        g.fillRect(box.x, box.y, w, box.h);
        // 右端一条亮边，像「已填充到此处」的标记
        g.fillStyle = '#EAF4FF';
        g.fillRect(box.x + w - 2 * S, box.y, 2 * S, box.h);
      }
      // 刻度线每 5% 一个
      g.strokeStyle = 'rgba(160,215,255,0.30)'; g.lineWidth = 1 * S;
      for (let k = 0; k <= 20; k++) {
        const x = box.x + (box.w * k) / 20;
        g.beginPath(); g.moveTo(x, box.y + box.h); g.lineTo(x, box.y + box.h + (k % 5 === 0 ? 7 : 4) * S); g.stroke();
      }
      g.restore();
    },

    text(g, txt, x, y, size, o) {
      o = o || {};
      const kind = o.kind || 'body';
      const fam = kind === 'body' ? this.type.body : this.type.mono;
      g.save();
      g.font = `${kind === 'display' ? 700 : 500} ${size}px ${fam}`;
      g.textAlign = o.align || 'left';
      g.textBaseline = o.baseline || 'alphabetic';
      if ('letterSpacing' in g) g.letterSpacing = trackFor(txt, this.type.tracking, size);
      if (kind === 'display') { g.shadowColor = 'rgba(127,212,255,0.55)'; g.shadowBlur = size * 0.35; }
      g.fillStyle = o.color || (kind === 'sub' ? this.theme.sub : this.theme.ink);
      g.fillText(txt, x, y);
      g.restore();
    },

    boil() { return 0; },
  };

  /* ────────────────────────────────────────────────────────────────
     4. CHALK · 黑板粉笔
     配方：墨绿黑板 + 双线抖动笔触 + 粉尘 + 楷体手写
     最适合：教学、科普、给小朋友讲、有「讲师在写」的现场感
     ──────────────────────────────────────────────────────────────── */
  STYLES.chalk = {
    id: 'chalk', cn: '黑板粉笔', en: 'Chalkboard', dark: true,
    tags: ['教学', '手写', '深色', '科普'],
    theme: {
      bg: '#1D2A24', bgAlt: '#243429', ink: '#F1F3EC',
      sub: 'rgba(241,243,236,0.66)', faint: 'rgba(241,243,236,0.16)',
      panel: 'rgba(255,255,255,0.05)',
      accent: '#FFE9A8', accent2: '#9BD3E8', good: '#A8D98A', bad: '#F0A0A8',
      glow: 'rgba(255,233,168,0.18)',
      accentDeep: '#E0C878', accentSoft: '#9BD3E8', sweep: '255,240,200', onAccent: '#1D2A24',
      bgFar: '#17211C',
    },
    type: { display: F.kai, body: F.kai, mono: F.mono, weight: 700, tracking: 0.01, lead: 1.34 },
    motion: { enter: 0.85, overshoot: 1.05, ease: 'outCubic' },

    bg(g, W, H) {
      const S = Math.sqrt((W / 1920) * (H / 1080));
      const grad = g.createRadialGradient(W * 0.42, H * 0.38, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.85);
      grad.addColorStop(0, '#26372D');
      grad.addColorStop(0.6, '#1D2A24');
      grad.addColorStop(1, '#131B17');
      g.fillStyle = grad; g.fillRect(0, 0, W, H);

      // 擦了又写的痕迹：几道横向淡淡的旧字迹带
      g.save();
      const R = rng(9);
      for (let i = 0; i < 5; i++) {
        const y = H * (0.12 + i * 0.17 + R() * 0.04);
        const h = (60 + R() * 90) * S;
        const lg = g.createLinearGradient(0, y, W, y + h);
        lg.addColorStop(0, 'rgba(255,255,255,0)');
        lg.addColorStop(0.4, 'rgba(238,242,230,0.030)');
        lg.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = lg; g.fillRect(0, y, W, h);
      }
      g.restore();

      const nz = noiseTile(220, 55, 0.22, '#FFFFFF');
      g.save(); g.globalAlpha = 0.18; g.fillStyle = g.createPattern(nz, 'repeat'); g.fillRect(0, 0, W, H); g.restore();
    },

    overlay(g, W, H) {
      const S = Math.sqrt((W / 1920) * (H / 1080));
      // 粉笔槽的投影
      const lg = g.createLinearGradient(0, H - 26 * S, 0, H);
      lg.addColorStop(0, 'rgba(0,0,0,0)');
      lg.addColorStop(1, 'rgba(0,0,0,0.42)');
      g.fillStyle = lg; g.fillRect(0, H - 26 * S, W, 26 * S);
    },

    card(g, box, o) {
      o = o || {};
      const S = o.S || 1;
      // 粉笔画框：手画的框四个角不闭合、边长不等 —— 用带抖动的折线，
      // 每边单独 2~3 个控制点，抖动幅度 3.5px 才看得出来（1.6px 肉眼等于直线）。
      g.save();
      g.strokeStyle = o.accent ? this.theme.accent : 'rgba(241,243,236,0.82)';
      g.lineWidth = 3.2 * S;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      const j = (k) => (hash(k, (o.seed || 1)) - 0.5) * 7 * S;
      g.beginPath();
      g.moveTo(box.x + j(1), box.y + j(2));
      g.lineTo(box.x + box.w * 0.5 + j(9), box.y + j(3));
      g.lineTo(box.x + box.w + j(4), box.y + j(5));
      g.lineTo(box.x + box.w + j(6), box.y + box.h * 0.55 + j(10));
      g.lineTo(box.x + box.w + j(7), box.y + box.h + j(8));
      g.lineTo(box.x + j(11), box.y + box.h + j(12));
      g.closePath();
      g.globalAlpha = 0.9; g.stroke();
      g.globalAlpha = 0.30; g.stroke();   // 描第二遍错开 → 粉笔的「双线」
      g.restore();
      const pad = 34 * S;
      return { x: box.x + pad, y: box.y + pad, w: box.w - pad * 2, h: box.h - pad * 2, ink: this.theme.ink };
    },

    bar(g, box, p, o) {
      o = o || {};
      const S = o.S || 1;
      const w = Math.max(0, box.w * clamp(p));
      g.save();
      g.fillStyle = o.color || this.theme.accent;
      // 粉笔填充：几道粗笔触叠出来，不是实心矩形。
      // 笔画数要少、线宽要大到互相重叠 —— 排成 7 条细线就成了「百叶窗」。
      const strokes = Math.max(3, Math.min(5, Math.round(box.h / (9 * S))));
      g.globalAlpha = 0.92;
      g.lineCap = 'round';
      for (let i = 0; i < strokes; i++) {
        const y = box.y + (box.h * (i + 0.5)) / strokes;
        const wob = Math.sin(i * 2.1) * 1.4 * S;
        g.beginPath();
        g.moveTo(box.x + wob, y);
        g.lineTo(box.x + w + wob, y - wob * 0.5);
        g.lineWidth = (box.h / strokes) * 1.18;
        g.strokeStyle = g.fillStyle;
        g.stroke();
      }
      g.restore();
    },

    text(g, txt, x, y, size, o) {
      o = o || {};
      const kind = o.kind || 'body';
      const fam = kind === 'mono' ? this.type.mono : this.type.display;
      g.save();
      g.font = `${this.type.weight} ${size}px ${fam}`;
      g.textAlign = o.align || 'left';
      g.textBaseline = o.baseline || 'alphabetic';
      // 粉尘：一层扩散 + 一层稍实。辉光别开太大，否则变成「发光白字」
      g.shadowColor = 'rgba(255,255,255,0.42)';
      g.shadowBlur = size * 0.10;
      g.fillStyle = o.color || (kind === 'sub' ? this.theme.sub : this.theme.ink);
      g.fillText(txt, x, y);
      g.shadowBlur = size * 0.03;
      g.fillText(txt, x, y);
      g.restore();
    },

    boil(t, i, amp) { return Math.sin(i * 13.3 + Math.floor(t * 10) * 3.1) * amp; },
  };

  /* ────────────────────────────────────────────────────────────────
     5. ISOMETRIC · 等距线稿
     配方：白底 + 30° 精确线稿 + 白面遮挡 + 一个深色强调 + 细无衬线
     最适合：机制解释、系统结构、流程、产品原理
     ──────────────────────────────────────────────────────────────── */
  STYLES.isometric = {
    id: 'isometric', cn: '等距线稿', en: 'Isometric', dark: false,
    tags: ['结构', '原理', '极简', '精确'],
    theme: {
      bg: '#F6F6F3', bgAlt: '#EDEDE7', ink: '#16181A',
      sub: 'rgba(22,24,26,0.60)', faint: 'rgba(22,24,26,0.10)',
      panel: '#FFFFFF',
      accent: '#16181A', accent2: '#3B7DD8', good: '#2E8B57', bad: '#C0392B',
      glow: 'rgba(59,125,216,0.12)',
      accentDeep: '#000000', accentSoft: '#3B7DD8', sweep: '0,0,0', onAccent: '#F6F6F3',
      bgFar: '#EDEDE7',
    },
    type: { display: F.sans, body: F.sans, mono: F.mono, weight: 600, tracking: -0.01, lead: 1.30 },
    motion: { enter: 0.6, overshoot: 1.0, ease: 'outQuint' },

    bg(g, W, H) {
      const S = Math.sqrt((W / 1920) * (H / 1080));
      g.fillStyle = '#F6F6F3'; g.fillRect(0, 0, W, H);
      // 极淡的等距参考网格。alpha 给到 0.055 会变成「斜纹布」，压到 0.035 才是底纹
      g.save();
      g.strokeStyle = 'rgba(22,24,26,0.035)'; g.lineWidth = 1 * S;
      const st = 64 * S;
      for (let k = -H; k < W + H; k += st) {
        g.beginPath(); g.moveTo(k, 0); g.lineTo(k + H * 0.5, H); g.stroke();
        g.beginPath(); g.moveTo(k, 0); g.lineTo(k - H * 0.5, H); g.stroke();
      }
      g.restore();
      void H;
    },

    overlay(g, W, H) {
      const v = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.max(W, H) * 0.8);
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(40,40,40,0.06)');
      g.fillStyle = v; g.fillRect(0, 0, W, H);
    },

    /* 等距板：顶面 + 左面 + 右面。它就是这个风格的基本积木。 */
    card(g, box, o) {
      o = o || {};
      const S = o.S || 1;
      const d = (o.depth == null ? 0.22 : o.depth) * box.h;
      const k = 0.5;   // 2:1 等距
      const x = box.x, y = box.y, w = box.w, h = box.h;
      g.save();
      g.lineWidth = 1.6 * S;
      g.strokeStyle = this.theme.ink;
      g.lineJoin = 'round';
      // 顶面
      g.beginPath();
      g.moveTo(x + w * 0.5, y);
      g.lineTo(x + w, y + h * k * 0.5);
      g.lineTo(x + w * 0.5, y + h * k);
      g.lineTo(x, y + h * k * 0.5);
      g.closePath();
      g.fillStyle = o.accent ? this.theme.ink : '#FFFFFF';
      g.fill(); g.stroke();
      // 左侧面
      g.beginPath();
      g.moveTo(x, y + h * k * 0.5);
      g.lineTo(x + w * 0.5, y + h * k);
      g.lineTo(x + w * 0.5, y + h * k + d);
      g.lineTo(x, y + h * k * 0.5 + d);
      g.closePath();
      g.fillStyle = o.accent ? '#2B2E31' : '#E9E9E3';
      g.fill(); g.stroke();
      // 右侧面
      g.beginPath();
      g.moveTo(x + w, y + h * k * 0.5);
      g.lineTo(x + w * 0.5, y + h * k);
      g.lineTo(x + w * 0.5, y + h * k + d);
      g.lineTo(x + w, y + h * k * 0.5 + d);
      g.closePath();
      g.fillStyle = o.accent ? '#3A3E42' : '#DDDDD6';
      g.fill(); g.stroke();
      g.restore();
      /* 等距板能放字的地方只有顶面（一个菱形）。内接矩形取菱形中间那条
         最宽的水平带：0.7w × 0.4h，中心略偏上。给大了会压到棱线，
         给小了字变成 40px 的注脚 —— 两种情况都难看。 */
      return {
        x: box.x + box.w * 0.18,
        y: box.y + box.h * 0.02,
        w: box.w * 0.64,
        h: box.h * 0.48,
        ink: o.accent ? this.theme.onAccent : this.theme.ink,
      };
    },

    bar(g, box, p, o) {
      o = o || {};
      const S = o.S || 1;
      const w = Math.max(0, box.w * clamp(p));
      g.save();
      g.fillStyle = 'rgba(22,24,26,0.06)';
      g.fillRect(box.x, box.y, box.w, box.h);
      g.fillStyle = o.color || this.theme.ink;
      g.fillRect(box.x, box.y, w, box.h);
      g.strokeStyle = this.theme.ink; g.lineWidth = 1.2 * S;
      g.strokeRect(box.x, box.y, box.w, box.h);
      g.restore();
    },

    text(g, txt, x, y, size, o) {
      o = o || {};
      const kind = o.kind || 'body';
      const fam = kind === 'mono' ? this.type.mono : this.type.body;
      g.save();
      g.font = `${kind === 'display' ? 600 : 450} ${size}px ${fam}`;
      g.textAlign = o.align || 'left';
      g.textBaseline = o.baseline || 'alphabetic';
      if ('letterSpacing' in g) g.letterSpacing = trackFor(txt, this.type.tracking, size);
      g.fillStyle = o.color || (kind === 'sub' ? this.theme.sub : this.theme.ink);
      g.fillText(txt, x, y);
      g.restore();
    },

    boil() { return 0; },
  };

  /* ────────────────────────────────────────────────────────────────
     6. SYNTHWAVE · 80s 霓虹
     配方：紫黑渐变 + 透视地面网格 + 条纹太阳 + 扫描线 + 色差
     最适合：音乐、游戏、复古科技、发布会倒计时
     ──────────────────────────────────────────────────────────────── */
  STYLES.synthwave = {
    id: 'synthwave', cn: '霓虹复古', en: 'Synthwave', dark: true,
    tags: ['复古', '音乐', '游戏', '高对比'],
    /* 地面网格每帧在往前流，底纹不能缓存 */
    bgAnimated: true,
    theme: {
      bg: '#12002E', bgAlt: '#1E0742', ink: '#FFF3FB',
      sub: 'rgba(255,243,251,0.66)', faint: 'rgba(255,45,149,0.24)',
      panel: 'rgba(255,45,149,0.12)',
      accent: '#FF2D95', accent2: '#22D3EE', good: '#5CE1E6', bad: '#FF6B6B',
      glow: 'rgba(255,45,149,0.30)',
      accentDeep: '#C4127A', accentSoft: '#22D3EE', sweep: '255,120,200', onAccent: '#12002E',
      bgFar: '#0A0018',
    },
    type: { display: F.impact, body: F.sans, mono: F.mono, weight: 700, tracking: 0.02, lead: 1.16 },
    motion: { enter: 0.5, overshoot: 1.06, ease: 'outExpo' },

    bg(g, W, H, t) {
      const S = Math.sqrt((W / 1920) * (H / 1080));
      const sky = g.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, '#0B0018');
      sky.addColorStop(0.42, '#2A0648');
      sky.addColorStop(0.62, '#6B1060');
      sky.addColorStop(0.70, '#12002E');
      sky.addColorStop(1, '#12002E');
      g.fillStyle = sky; g.fillRect(0, 0, W, H);

      const hz = H * 0.68;   // 地平线

      /* 条纹太阳：霓虹的招牌。位置有两个约束，都是为了「不挡内容」：
         ① 水平放右侧 —— 放正中会和左对齐的大标题抢视线；
         ② 圆心压到地平线**以下**，只露上半个圆 —— 原先圆心在地平线上方，
            太阳会盖住条形图右侧的数值（实测 bar-chart 的 96.2 被整个吃掉）。
         半沉的太阳也是 synthwave 的经典构图，不算妥协。 */
      const sunR = Math.min(W, H) * 0.16;
      const sunY = hz + sunR * 0.52;
      const sunX = W * 0.66;
      g.save();
      g.beginPath(); g.arc(sunX, sunY, sunR, 0, Math.PI * 2); g.clip();
      const sg = g.createLinearGradient(0, sunY - sunR, 0, sunY + sunR);
      sg.addColorStop(0, '#FFE45E');
      sg.addColorStop(0.45, '#FF6EC7');
      sg.addColorStop(1, '#FF2D95');
      g.fillStyle = sg; g.fillRect(0, sunY - sunR, W, sunR * 2);
      // 横向条纹缝隙
      g.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 7; i++) {
        const yy = sunY + sunR * (0.02 + i * 0.15);
        g.fillRect(0, yy, W, (4 + i * 1.6) * S);
      }
      g.restore();

      // 地面透视网格：横向线按平方分布（近处稀远处密），才是真透视
      g.save();
      g.strokeStyle = 'rgba(255,45,149,0.55)';
      g.lineWidth = 1.6 * S;
      g.shadowColor = '#FF2D95';
      g.shadowBlur = 12 * S;
      const flow = (t * 0.6) % 1;
      g.beginPath();
      for (let i = 0; i < 18; i++) {
        const k = (i + flow) / 18;
        const y = hz + (H - hz) * k * k;
        g.moveTo(0, y); g.lineTo(W, y);
      }
      // 纵向线汇聚到消失点
      for (let i = -14; i <= 14; i++) {
        const xb = W / 2 + i * (W / 10);
        g.moveTo(W / 2, hz); g.lineTo(xb, H);
      }
      g.stroke();
      g.restore();

      // 地平线辉光
      const hg = g.createLinearGradient(0, hz - 40 * S, 0, hz + 40 * S);
      hg.addColorStop(0, 'rgba(255,45,149,0)');
      hg.addColorStop(0.5, 'rgba(255,45,149,0.42)');
      hg.addColorStop(1, 'rgba(255,45,149,0)');
      g.fillStyle = hg; g.fillRect(0, hz - 40 * S, W, 80 * S);
    },

    overlay(g, W, H) {
      const S = Math.sqrt((W / 1920) * (H / 1080));
      // CRT 扫描线
      g.save();
      g.globalAlpha = 0.10;
      g.fillStyle = '#000000';
      for (let y = 0; y < H; y += 4 * S) g.fillRect(0, y, W, 2 * S);
      g.restore();
      // 暗角
      const v = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.30, W / 2, H / 2, Math.max(W, H) * 0.80);
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.55)');
      g.fillStyle = v; g.fillRect(0, 0, W, H);
    },

    card(g, box, o) {
      o = o || {};
      const S = o.S || 1;
      g.save();
      g.fillStyle = o.accent ? 'rgba(255,45,149,0.16)' : 'rgba(18,0,46,0.55)';
      g.fillRect(box.x, box.y, box.w, box.h);
      g.strokeStyle = o.accent ? '#FF2D95' : 'rgba(34,211,238,0.65)';
      g.lineWidth = 2 * S;
      g.shadowColor = o.accent ? '#FF2D95' : '#22D3EE';
      g.shadowBlur = 16 * S;
      g.strokeRect(box.x, box.y, box.w, box.h);
      g.restore();
      const pad = 34 * S;
      return { x: box.x + pad, y: box.y + pad, w: box.w - pad * 2, h: box.h - pad * 2, ink: this.theme.ink };
    },

    bar(g, box, p, o) {
      o = o || {};
      const S = o.S || 1;
      const w = Math.max(0, box.w * clamp(p));
      g.save();
      const grd = g.createLinearGradient(box.x, 0, box.x + box.w, 0);
      grd.addColorStop(0, '#22D3EE');
      grd.addColorStop(1, '#FF2D95');
      g.fillStyle = o.color || grd;
      g.fillRect(box.x, box.y, w, box.h);
      g.shadowColor = '#FF2D95'; g.shadowBlur = 18 * S;
      g.fillRect(box.x, box.y, w, box.h);
      g.restore();
    },

    text(g, txt, x, y, size, o) {
      o = o || {};
      const kind = o.kind || 'body';
      const fam = kind === 'mono' ? this.type.mono : (kind === 'display' ? this.type.display : this.type.body);
      g.save();
      g.font = `${kind === 'display' ? 700 : 500} ${size}px ${fam}`;
      g.textAlign = o.align || 'left';
      g.textBaseline = o.baseline || 'alphabetic';
      if (kind === 'display') {
        // 色差：红蓝只错开 0.4% 字号。错到 0.8% 中文会「发抖」，像信号干扰而不是 CRT 味
        g.globalAlpha = 0.55;
        g.fillStyle = '#22D3EE'; g.fillText(txt, x - size * 0.004, y);
        g.fillStyle = '#FF2D95'; g.fillText(txt, x + size * 0.004, y);
        g.globalAlpha = 1;
        g.shadowColor = '#FF2D95'; g.shadowBlur = size * 0.45;
      }
      g.fillStyle = o.color || (kind === 'sub' ? this.theme.sub : this.theme.ink);
      g.fillText(txt, x, y);
      g.restore();
    },

    boil() { return 0; },
  };

  /* ────────────────────────────────────────────────────────────────
     7. SWISS · 瑞士国际主义
     配方：白底 + 12 栏网格 + 巨大字号 + 单一信号红 + 硬切
     最适合：品牌片、观点、发布会开场、极简产品
     ──────────────────────────────────────────────────────────────── */
  STYLES.swiss = {
    id: 'swiss', cn: '瑞士网格', en: 'Swiss Grid', dark: false,
    tags: ['极简', '排版', '品牌', '高冲击'],
    theme: {
      bg: '#FBFBF9', bgAlt: '#F0F0EC', ink: '#0E0E0E',
      sub: 'rgba(14,14,14,0.58)', faint: 'rgba(14,14,14,0.12)',
      panel: 'rgba(14,14,14,0.04)',
      accent: '#E5322D', accent2: '#0E0E0E', good: '#0E0E0E', bad: '#E5322D',
      glow: 'rgba(229,50,45,0.10)',
      accentDeep: '#B8241F', accentSoft: '#0E0E0E', sweep: '14,14,14', onAccent: '#FBFBF9',
      bgFar: '#F0F0EC',
    },
    type: { display: F.hei, body: F.sans, mono: F.mono, weight: 900, tracking: -0.045, lead: 1.02 },
    motion: { enter: 0.34, overshoot: 1.0, ease: 'outExpo' },

    bg(g, W, H) {
      g.fillStyle = '#FBFBF9'; g.fillRect(0, 0, W, H);
      const S = Math.sqrt((W / 1920) * (H / 1080));
      const m = 96 * S;
      // 极细的基线网格：只在左边缘露一列刻度，不铺满（铺满就成了「方格纸」）
      g.save();
      g.strokeStyle = 'rgba(14,14,14,0.14)'; g.lineWidth = 1 * S;
      g.beginPath();
      g.moveTo(m, 0); g.lineTo(m, H);
      g.stroke();
      g.strokeStyle = 'rgba(14,14,14,0.06)';
      for (let i = 0; i <= 12; i++) {
        const x = m + ((W - m * 2) * i) / 12;
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 14 * S); g.stroke();
      }
      g.restore();
    },

    overlay() {},

    /* 瑞士风没有卡片，只有「色块」。圆角一律为零。 */
    card(g, box, o) {
      o = o || {};
      g.save();
      g.fillStyle = o.accent ? this.theme.accent : (o.fill || '#0E0E0E');
      g.fillRect(box.x, box.y, box.w, box.h);
      g.restore();
      /* 深色块里必须换成反白字。这条不加，黑色卡片上的黑字会整块消失 —— 
         gallery 第一版就踩了。 */
      const pad = 40 * (o.S || 1);
      return {
        x: box.x + pad, y: box.y + pad, w: box.w - pad * 2, h: box.h - pad * 2,
        ink: (o.accent ? this.theme.onAccent : '#FFFFFF'),
      };
    },

    bar(g, box, p, o) {
      o = o || {};
      const w = Math.max(0, box.w * clamp(p));
      g.save();
      g.fillStyle = 'rgba(14,14,14,0.045)';
      g.fillRect(box.x, box.y, box.w, box.h);
      g.fillStyle = o.color || this.theme.accent;
      g.fillRect(box.x, box.y, w, box.h);
      g.restore();
    },

    text(g, txt, x, y, size, o) {
      o = o || {};
      const kind = o.kind || 'body';
      const fam = kind === 'mono' ? this.type.mono : (kind === 'display' ? this.type.display : this.type.body);
      g.save();
      g.font = `${kind === 'display' ? this.type.weight : (kind === 'sub' ? 400 : 500)} ${size}px ${fam}`;
      g.textAlign = o.align || 'left';
      g.textBaseline = o.baseline || 'alphabetic';
      if ('letterSpacing' in g) g.letterSpacing = trackFor(txt, this.type.tracking, size);
      g.fillStyle = o.color || (kind === 'sub' ? this.theme.sub : this.theme.ink);
      g.fillText(txt, x, y);
      g.restore();
    },

    boil() { return 0; },
  };

  /* ────────────────────────────────────────────────────────────────
     8. INK · 水墨宣纸
     配方：宣纸纤维 + 墨色浓淡 + 飞白笔触 + 朱红印章 + 大留白
     最适合：国风、文化、历史、人物、茶/酒/文旅
     ──────────────────────────────────────────────────────────────── */
  STYLES.ink = {
    id: 'ink', cn: '水墨宣纸', en: 'Ink Wash', dark: false,
    tags: ['国风', '文化', '留白', '雅'],
    theme: {
      bg: '#F3EDE0', bgAlt: '#E8DFCC', ink: '#1A1614',
      sub: 'rgba(26,22,20,0.58)', faint: 'rgba(26,22,20,0.10)',
      panel: 'rgba(26,22,20,0.045)',
      accent: '#A8322A', accent2: '#4A5D4E', good: '#4A5D4E', bad: '#A8322A',
      glow: 'rgba(26,22,20,0.10)',
      accentDeep: '#7E211C', accentSoft: '#4A5D4E', sweep: '60,48,36', onAccent: '#F7F2E6',
      bgFar: '#E8DFCC',
    },
    type: { display: F.serif, body: F.serif, mono: F.mono, weight: 600, tracking: 0.02, lead: 1.44 },
    motion: { enter: 0.95, overshoot: 1.0, ease: 'outCubic' },

    bg(g, W, H, t) {
      const S = Math.sqrt((W / 1920) * (H / 1080));
      g.fillStyle = '#F3EDE0'; g.fillRect(0, 0, W, H);
      // 墨韵：两团极淡的晕，缓慢呼吸
      const br = 1 + Math.sin(t * 0.4) * 0.04;
      const r1 = W * 0.28 * br;
      const g1 = g.createRadialGradient(W * 0.72, H * 0.24, 0, W * 0.72, H * 0.24, r1);
      g1.addColorStop(0, 'rgba(60,52,44,0.10)');
      g1.addColorStop(1, 'rgba(60,52,44,0)');
      g.fillStyle = g1; g.fillRect(0, 0, W, H);
      const g2 = g.createRadialGradient(W * 0.16, H * 0.82, 0, W * 0.16, H * 0.82, W * 0.24 * br);
      g2.addColorStop(0, 'rgba(60,52,44,0.07)');
      g2.addColorStop(1, 'rgba(60,52,44,0)');
      g.fillStyle = g2; g.fillRect(0, 0, W, H);

      // 宣纸纤维：长短不一的细线，方向随机
      g.save();
      g.globalAlpha = 0.16;
      g.strokeStyle = '#9C8B70';
      g.lineWidth = 0.8 * S;
      const R = rng(17);
      for (let i = 0; i < 320; i++) {
        const x = R() * W, y = R() * H;
        const a = R() * Math.PI, len = (6 + R() * 46) * S;
        g.beginPath(); g.moveTo(x, y);
        g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
        g.stroke();
      }
      g.restore();
      const nz = noiseTile(200, 91, 0.14, '#8A785C');
      g.save(); g.globalAlpha = 0.45; g.fillStyle = g.createPattern(nz, 'repeat'); g.fillRect(0, 0, W, H); g.restore();
    },

    overlay(g, W, H) {
      const v = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.40, W / 2, H / 2, Math.max(W, H) * 0.85);
      v.addColorStop(0, 'rgba(0,0,0,0)');
      v.addColorStop(1, 'rgba(90,74,52,0.16)');
      g.fillStyle = v; g.fillRect(0, 0, W, H);
    },

    /* 水墨的「面」= 一笔泼墨。边缘必须毛、浓淡必须分层，
       实心矩形或均匀灰块一出现就不像画的了。 */
    card(g, box, o) {
      o = o || {};
      const S = o.S || 1;
      const seed = o.seed || 5;
      const inkColor = o.accent ? this.theme.accent : '#1A1614';
      /* 非 accent 卡是「淡墨晕」（文字要压在上面），accent 卡才是浓墨块。
         两层用同一套 alpha 会让普通卡变成黑砖，字全看不见。 */
      const A = o.accent ? [0.20, 0.92, 0.55] : [0.05, 0.15, 0.05];
      const blob = (grow, alpha, blur) => {
        const R = rng(seed);
        g.save();
        g.globalAlpha = alpha;
        g.fillStyle = inkColor;
        g.beginPath();
        const n = 30;
        for (let i = 0; i <= n; i++) {
          const a = (i / n) * Math.PI * 2;
          const rx = (box.w / 2 + grow) * (0.90 + R() * 0.18);
          const ry = (box.h / 2 + grow) * (0.84 + R() * 0.22);
          const x = box.x + box.w / 2 + Math.cos(a) * rx;
          const y = box.y + box.h / 2 + Math.sin(a) * ry;
          if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.closePath();
        g.filter = `blur(${blur * S}px)`;
        g.fill();
        g.restore();
      };
      // 外圈墨晕 → 主体 → 更深的芯
      blob(14 * S, A[0], 16 * S);
      blob(2 * S, A[1], 3.5 * S);
      blob(-box.w * 0.10, A[2], 8 * S);
      // 飞白只属于浓墨块。淡墨晕上开飞白会变成几道白杠，字都被划花
      if (o.accent) {
        g.save();
        g.globalCompositeOperation = 'destination-out';
        const R2 = rng(seed + 3);
        g.globalAlpha = 0.35;
        for (let i = 0; i < 6; i++) {
          const y = box.y + box.h * (0.15 + R2() * 0.7);
          g.fillRect(box.x + box.w * (0.1 + R2() * 0.5), y, box.w * (0.1 + R2() * 0.25), 1.6 * S);
        }
        g.restore();
      }
      const pad = Math.min(box.w, box.h) * 0.15;
      return {
        x: box.x + pad, y: box.y + pad, w: box.w - pad * 2, h: box.h - pad * 2,
        ink: o.accent ? this.theme.onAccent : this.theme.ink,
      };
    },

    bar(g, box, p, o) {
      o = o || {};
      const S = o.S || 1;
      const w = Math.max(0, box.w * clamp(p));
      if (w < 2) return;
      /* o.color 可能是字符串，也可能是 CanvasGradient（条形图模板传的是渐变）。
         渐变塞进 addColorStop 会直接抛异常，所以这里必须先判类型。 */
      const base = (typeof o.color === 'string') ? o.color : this.theme.ink;
      g.save();
      // 一笔横画：起笔重、收笔飞白
      const grd = g.createLinearGradient(box.x, 0, box.x + box.w, 0);
      grd.addColorStop(0, base);
      grd.addColorStop(0.88, base);
      /* 收笔淡出只留 12%、且不淡到 0.25 —— 数据条的末端一虚，
         读数就会以为「值没到那儿」。0.25 时最后 18% 几乎看不见，实测被误读。 */
      grd.addColorStop(1, rgba(base, 0.6));
      g.fillStyle = grd;
      g.beginPath();
      g.moveTo(box.x, box.y + box.h * 0.15);
      g.lineTo(box.x + w, box.y + box.h * 0.05);
      g.lineTo(box.x + w, box.y + box.h * 0.85);
      g.lineTo(box.x, box.y + box.h * 0.95);
      g.closePath();
      g.fill();
      // 飞白：几道白色细划痕
      g.globalCompositeOperation = 'destination-out';
      const R = rng(13);
      g.globalAlpha = 0.5;
      for (let i = 0; i < 5; i++) {
        const y = box.y + box.h * (0.2 + R() * 0.6);
        g.fillRect(box.x + w * (0.1 + R() * 0.6), y, w * 0.25, 1.4 * S);
      }
      g.restore();
    },

    text(g, txt, x, y, size, o) {
      o = o || {};
      const kind = o.kind || 'body';
      const fam = kind === 'mono' ? this.type.mono : this.type.display;
      g.save();
      g.font = `${kind === 'display' ? 600 : 400} ${size}px ${fam}`;
      g.textAlign = o.align || 'left';
      g.textBaseline = o.baseline || 'alphabetic';
      // 墨在纸上会「洇」：三层叠出来 —— 外圈扩散、内圈稍实、笔心最浓。
      // 只画一层 blur 会得到「发虚的字」，那是最廉价的水墨。
      if (kind === 'display') {
        g.fillStyle = this.theme.ink;
        g.filter = `blur(${size * 0.06}px)`; g.globalAlpha = 0.16; g.fillText(txt, x, y);
        g.filter = `blur(${size * 0.018}px)`; g.globalAlpha = 0.42; g.fillText(txt, x, y);
        g.filter = 'none'; g.globalAlpha = 1;
      }
      // 浓度：上浓下淡（笔锋起处重、收处轻）
      const lg = g.createLinearGradient(0, y - size * 0.85, 0, y + size * 0.12);
      lg.addColorStop(0, o.color || this.theme.ink);
      lg.addColorStop(1, o.color || mix(this.theme.ink, '#F3EDE0', 0.30));
      g.fillStyle = (kind === 'sub') ? this.theme.sub : lg;
      g.fillText(txt, x, y);
      g.restore();
    },

    boil(t, i, amp) { return Math.sin(i * 7.7 + Math.floor(t * 4) * 2.7) * amp * 0.4; },
  };

  /* ── 注册表与对外 API ───────────────────────────────────────────── */

  /* 别名：让用户能说「手绘」「蓝图」「印刷」「国风」也能命中 */
  const ALIAS = {
    印刷: 'riso', 孔版: 'riso', risograph: 'riso', print: 'riso',
    剪纸: 'cutpaper', 拼贴: 'cutpaper', paper: 'cutpaper', collage: 'cutpaper', kraft: 'cutpaper',
    蓝图: 'blueprint', 工程: 'blueprint', engineer: 'blueprint', cad: 'blueprint', technical: 'blueprint',
    黑板: 'chalk', 粉笔: 'chalk', 手写: 'chalk', chalkboard: 'chalk', classroom: 'chalk',
    等距: 'isometric', 线稿: 'isometric', iso: 'isometric', line: 'isometric',
    霓虹: 'synthwave', 复古: 'synthwave', 赛博: 'synthwave', cyberpunk: 'synthwave', retro: 'synthwave', vhs: 'synthwave',
    瑞士: 'swiss', 极简: 'swiss', 网格: 'swiss', minimal: 'swiss', grid: 'swiss', typographic: 'swiss',
    水墨: 'ink', 国风: 'ink', 宣纸: 'ink', 中国风: 'ink', inkwash: 'ink', chinese: 'ink',
  };

  function norm(id) {
    if (!id) return null;
    const k = String(id).trim().toLowerCase();
    if (STYLES[k]) return k;
    if (ALIAS[id]) return ALIAS[id];
    if (ALIAS[k]) return ALIAS[k];
    return null;
  }

  const DEFAULT = 'riso';

  function get(id) {
    const k = norm(id) || DEFAULT;
    const st = STYLES[k];
    // 冻结风格对象，避免模板里手滑改坏共享实例
    if (!st.__frozen) {
      st.__frozen = true;
      Object.freeze(st.motion);
      Object.freeze(st.type);
      Object.freeze(st.theme);
    }
    return st;
  }

  function list() {
    return Object.keys(STYLES).map((k) => ({
      id: k, cn: STYLES[k].cn, en: STYLES[k].en,
      dark: STYLES[k].dark, tags: STYLES[k].tags.slice(),
    }));
  }

  /* 名字拼错时不能静默回退 —— 用户会以为「换了风格没反应」。
     渲染器已经有这个规矩（--theme 拼错会列可用名），这里保持一致。 */
  function require(id) {
    const k = norm(id);
    if (!k) {
      throw new Error(`未知风格 "${id}"。可用：${Object.keys(STYLES).join(' / ')}`);
    }
    return get(k);
  }

  /* ── 高层绘制原语 ─────────────────────────────────────────────── */

  function bg(g, st, W, H, t, o) {
    g.save();
    st.bg(g, W, H, t || 0, o || {});
    g.restore();
  }

  /* 缓存的背景：把整张底纹预渲染到离屏 canvas，每帧只 drawImage 一次。
   *
   * 为什么必须缓存：riso 一帧要铺 2 个径向渐变 + 3 层旋转网点 + 1 层纸纹。
   * 每次都是全屏 fillRect，而 createPattern + 旋转变换要重新采样 ——
   * 实测 1080p 单帧 150~200ms，13 秒 60fps 的片子要渲 11 分钟。
   * 缓存后每帧只剩一次 drawImage，约 3~5ms，同一支片 1 分钟出头。
   *
   * 代价：底纹里的「极缓慢漂移」（0.13rad/s 的色斑呼吸、4% 的墨晕涨缩）
   * 会被冻住。这些变化一秒不到 2px，本来就看不出；换来 8 倍速度，值。
   * 真要动态底纹（水波、粒子），别用这个函数，直接调 SV.bg()。
   *
   * bucket：每 0.5 秒重新生成一次底纹。传 t 进来还能保留一半的慢变化；
   * 传 0 就是完全静态（最快）。多镜头页面建议传全局 t，别传镜头内 lt ——
   * lt 每个镜头从 0 重来，bucket 会反复失效，缓存等于没用。
   */
  const _bgCache = new Map();
  function bgCached(g, st, W, H, t, o, bucket) {
    // 底纹里真带动画（霓虹的地面网格在流动）就别缓存，冻住会露馅
    if (st.bgAnimated) { st.bg(g, W, H, t || 0, o || {}); return; }
    const b = bucket == null ? 1 : bucket;
    const slot = b > 0 ? Math.floor((t || 0) / b) : 0;
    const key = st.id + '|' + W + 'x' + H + '|' + slot;
    let c = _bgCache.get(key);
    if (!c) {
      // 只留当前这一格，别让缓存无限涨（一次渲染几百个 slot 就是几百张 1080p 位图）
      for (const k of _bgCache.keys()) if (k.startsWith(st.id + '|' + W + 'x' + H + '|')) _bgCache.delete(k);
      c = document.createElement('canvas');
      c.width = W; c.height = H;
      const x = c.getContext('2d');
      x.setTransform(1, 0, 0, 1, 0, 0);
      st.bg(x, W, H, slot * (b || 0), o || {});
      _bgCache.set(key, c);
    }
    g.drawImage(c, 0, 0);
  }

  function clearBgCache() { _bgCache.clear(); }

  function overlay(g, st, W, H, t, o) {
    if (!st.overlay) return;
    g.save();
    st.overlay(g, W, H, t || 0, o || {});
    g.restore();
  }

  function text(g, st, txt, x, y, size, o) {
    st.text(g, txt, x, y, size, o || {});
  }

  /* 注意：card 必须把风格返回的「内容安全框」透传出去，
     否则调用方拿到 undefined，文字排不上去（调试时表现为 reading 'x' of undefined）。 */
  function card(g, st, box, o) {
    return st.card(g, box, o || {});
  }

  function bar(g, st, box, p, o) {
    st.bar(g, box, p, o || {});
  }

  function boil(st, t, i, amp) {
    return st.boil ? st.boil(t, i, amp || 2) : 0;
  }

  /* 缓动函数：按名字取，模板里写字符串比传函数稳（JSON 也能表达） */
  function easeOf(name) {
    return ease[name] || ease.outCubic;
  }

  /* 入场：p 从 0 到 1，返回 {p, dy, scale, alpha}。
     把「该怎么做入场」也从模板里抽出来 —— 瑞士风是整块位移，剪纸是落下带过冲，
     这些细节是风格的一部分，不该每个模板各写一遍。 */
  function enter(st, p) {
    const e = easeOf(st.motion.ease)(clamp(p));
    const dy = (1 - e) * 28;
    const scale = 1 - (1 - e) * 0.03;
    const alpha = clamp(p * 2.2);
    return { p: e, dy, scale, alpha };
  }

  /* ── 节拍网格（配 scripts/beats.js 产出的 JSON） ─────────────
     竞品的「切点落在拍上」不是玄学：把镜头时长量化到 1/2 拍即可。
     这里只提供换算，真正的分析在 beats.js 里做。 */
  const BEAT = {
    /* 把秒数吸到最近的拍点；strength: 1=全拍, 0.5=半拍, 0.25=十六分音符 */
    snap(sec, bpm, strength) {
      const unit = 60 / (bpm || 120) * (strength || 1);
      return Math.round(sec / unit) * unit;
    },
    /* 一段总时长里，最接近目标时长的「整拍数」 */
    fitBeats(targetSec, bpm) {
      const unit = 60 / (bpm || 120);
      const n = Math.max(1, Math.round(targetSec / unit));
      return { beats: n, dur: n * unit };
    },
  };

  const SV = {
    STYLES, get, list, require, norm, DEFAULT, ALIAS,
    bg, overlay, text, card, bar, boil, enter, easeOf, ease, bgCached, clearBgCache,
    BEAT,
    /* 给模板用的便捷换算 */
    rgba, mix, clamp, lerp, rng, hash, halftone, tornRectPath, noiseTile, fonts: F,
  };

  root.SV = SV;
  if (typeof module === 'object' && module.exports) module.exports = SV;
})(typeof globalThis !== 'undefined' ? globalThis : this);
