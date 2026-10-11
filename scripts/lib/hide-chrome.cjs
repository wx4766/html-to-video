/**
 * 录屏/截图前隐藏「播放器 chrome」的共享规则。
 *
 * 为什么要抽成模块：渲染器（render-video-seek.js）和验收器（qa.js）必须
 * 看到完全一样的画面 —— 渲染器藏掉了时间码，验收器却把它量进去，就会
 * 报一堆假问题。规则放一处，两边 require，不会漂移。
 *
 * 两层：
 *   1. HIDE_CHROME_CSS —— 白名单式：这些 class 名一律 display:none
 *   2. hideChromeBars() —— 启发式：position:fixed/sticky 贴在顶/底、
 *      高度 < 25% 视口、且含按钮或时间码的元素，判为播放控件
 *
 * 想保留 chrome（调试用）就不注入，渲染器/qa 都有 --keep-chrome。
 */

// 与历史版本保持一致（老用户的动画可能已经在用这些 class 名做「不录制」标记）
const HIDE_CHROME_CSS = `
  .no-record,
  .progress, .progress-bar,
  .counter, .tCur,
  .phases, .phase-label, .phase,
  .replay, button.replay,
  .masthead, .kicker, .title,
  .footer,
  [data-role="chrome"], [data-record="hidden"] {
    display: none !important;
  }
`;

/**
 * 传给 context.addInitScript(hideChromeInit, HIDE_CHROME_CSS)
 * 在页面上下文执行，注意：这里不能闭包引用 Node 侧变量。
 */
function hideChromeInit(css) {
  const HIDE_MARK = 'data-video-hidden';

  function injectStyle() {
    const style = document.createElement('style');
    style.setAttribute('data-inject', 'render-video-chrome-hide');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function hideChromeBars() {
    const vh = window.innerHeight;
    document.querySelectorAll('div, nav, header, footer, section, aside')
      .forEach(el => {
        if (el.hasAttribute(HIDE_MARK)) return;
        // 显式豁免：作者想让某块出现在成片里，标 data-record-keep="true"
        if (el.dataset.recordKeep === 'true') return;
        const s = getComputedStyle(el);
        if (s.position !== 'fixed' && s.position !== 'sticky') return;
        const r = el.getBoundingClientRect();
        if (r.height > vh * 0.25) return;
        const atBottom = r.bottom >= vh - 30;
        const atTop = r.top <= 30 && r.height < 80;
        if (!atBottom && !atTop) return;
        const txt = el.textContent || '';
        const hasBtn = !!el.querySelector('button, [role="button"]');
        const hasCtrls = /[⏸▶⏮⏭↻↺↩↪]|\d+\.\d+\s*s/.test(txt);
        if (hasBtn || hasCtrls) {
          el.style.setProperty('display', 'none', 'important');
          el.setAttribute(HIDE_MARK, '1');
        }
      });
  }

  const start = () => {
    injectStyle();
    hideChromeBars();
    // 播放控件常常是后挂上去的，观察 6 秒足够覆盖首屏
    const obs = new MutationObserver(hideChromeBars);
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 6000);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}

module.exports = { HIDE_CHROME_CSS, hideChromeInit };
