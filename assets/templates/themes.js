/* =========================================================================
   内置主题 · 三个模板共用
   -------------------------------------------------------------------------
   用法（模板里）：
     <script src="./themes.js"></script>
     const T = h2vTheme(CFG.theme);        // 名字不在表里就回退 midnight

   换主题只改 HTML 里的 CFG.theme，不用碰画布代码：
     CFG.theme = 'paper'   // 浅色，适合文档 / 教学 / 打印场景
     CFG.theme = 'neon'    // 黑紫底 + 霓虹色，适合科技 / 发布会
     CFG.theme = 'midnight'（默认）

   自定义：CFG.theme 也接受对象，字段同上，缺的从 midnight 补。
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
  };

  window.H2V_THEMES = { midnight: MIDNIGHT, paper: PAPER, neon: NEON };

  window.h2vTheme = function (name) {
    if (name && typeof name === 'object') return Object.assign({}, MIDNIGHT, name);
    return window.H2V_THEMES[name] || MIDNIGHT;
  };
})();
