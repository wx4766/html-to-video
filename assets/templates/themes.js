/* =========================================================================
   内置主题 · 模板共用
   -------------------------------------------------------------------------
   用法（模板里）：
     <script src="./themes.js"></script>
     const TH = h2vTheme(window.__h2vTheme || CFG.theme);   // 渲染器 --theme 优先

   换主题只改 HTML 里的 CFG.theme，不用碰画布代码：
     CFG.theme = 'paper'   // 浅色，适合文档 / 教学 / 打印场景
     CFG.theme = 'neon'    // 黑紫底 + 霓虹色，适合科技 / 发布会
     CFG.theme = 'midnight'（默认）

   也可以不改文件，命令行直接覆盖（渲染器注入 window.__h2vTheme）：
     node scripts/render-video-seek.js 模板.html --theme=paper

   自定义：CFG.theme 也接受对象，字段同上，缺的从 midnight 补。

   ---------------------------------------------------------------------------
   字段分两类
   · 基础 11 个（bg / bgAlt / ink / sub / faint / panel / accent / accent2 /
     good / bad / glow）三套主题都有，模板可以直接取。
   · 可选 5 个（bgFar / accentDeep / accentSoft / sweep / onAccent）**只给非默认主题补**。
     midnight 一律不填 —— 模板里写成 `TH.accentDeep || '<原常量>'`，
     于是默认主题仍走历史常量，逐像素不变；换主题时才用新值。
     这么设计是为了「加主题能力」不背「默认画面偷偷变了」的债。
   ========================================================================= */
(function () {
  const MIDNIGHT = {
    bg: '#0A0C12',
    bgAlt: '#121724',
    ink: '#F4F7FC',          // 主文字
    sub: 'rgba(244,247,252,0.58)',   // 次要文字
    faint: 'rgba(244,247,252,0.10)', // 分隔线 / 网格
    panel: 'rgba(255,255,255,0.045)',// 卡片底
    accent: '#FFB86B',       // 强调
    accent2: '#7C9CFF',      // 次强调
    good: '#4ADE80',
    bad: '#FF6B6B',
    glow: 'rgba(255,184,107,0.16)',
    /* 可选字段刻意留空：默认主题继续用模板里的历史常量（逐像素不变） */
  };

  const PAPER = {
    bg: '#F7F4ED',
    bgAlt: '#EFEAE0',
    ink: '#1B1815',
    sub: 'rgba(27,24,21,0.60)',
    faint: 'rgba(27,24,21,0.12)',
    panel: 'rgba(27,24,21,0.045)',
    accent: '#C2410C',
    accent2: '#1D4ED8',
    good: '#15803D',
    bad: '#B91C1C',
    glow: 'rgba(194,65,12,0.10)',

    bgFar: '#EFEAE0',        // 背景渐变的远端
    accentDeep: '#9A3412',   // 强调色的深一档（渐变起点）
    accentSoft: '#0F766E',   // 次一级数据色（第二名条形 / 折线主色）
    sweep: '70,52,30',       // 环境光扫的 RGB —— 浅底上用白扫等于没画，改成暖褐
    onAccent: '#FFF8F0',     // 强调色块上的字（深色块配浅字）
  };

  const NEON = {
    bg: '#06050E',
    bgAlt: '#0E0B20',
    ink: '#EAF2FF',
    sub: 'rgba(234,242,255,0.58)',
    faint: 'rgba(124,92,255,0.22)',
    panel: 'rgba(124,92,255,0.09)',
    accent: '#8B5CF6',
    accent2: '#22D3EE',
    good: '#2DD4BF',
    bad: '#FB7185',
    glow: 'rgba(124,92,255,0.22)',

    bgFar: '#0E0B20',
    accentDeep: '#6D28D9',
    accentSoft: '#2DD4BF',
    sweep: '190,170,255',
    onAccent: '#0B0616',
  };

  window.H2V_THEMES = { midnight: MIDNIGHT, paper: PAPER, neon: NEON };

  window.h2vTheme = function (name) {
    if (name && typeof name === 'object') {
      window.__h2vThemeResolved = 'custom';
      return Object.assign({}, MIDNIGHT, name);
    }
    window.__h2vThemeResolved = window.H2V_THEMES[name] ? name : 'midnight';
    return window.H2V_THEMES[name] || MIDNIGHT;
  };

  /* '#RRGGBB' + alpha → 'rgba(r,g,b,a)'。
     光晕 / 阴影 / 渐变都要「同一个主题色的不同透明度」，模板自己去拆 hex 太啰嗦。
     也吃 '#RGB'。传进来已经不是 hex（比如本身带 alpha 的 rgba）就原样返回。 */
  window.h2vRgba = function (hex, a) {
    if (typeof hex !== 'string' || hex[0] !== '#') return hex;
    let h = hex.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    if (!Number.isFinite(n) || h.length !== 6) return hex;
    const al = (a === undefined) ? 1 : a;
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + al + ')';
  };
})();
