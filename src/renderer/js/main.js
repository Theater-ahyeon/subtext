'use strict';
/* 演练 · 入口：初始化宿主桥、全局特效、导航与首屏渲染 */
(() => {
  const HB = window.HB;

  (async function init() {
    HB.ui.initPointerGlow();
    HB.state.settings = await HB.H.settings.get().catch(() => null);
    HB.updateModeChip && HB.updateModeChip();
    HB.router.renderNav();
    HB.router.render();
  })();
})();
