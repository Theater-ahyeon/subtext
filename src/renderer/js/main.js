'use strict';
/* 演练 · 入口：初始化宿主桥、全局特效、导航与首屏渲染 */
(() => {
  const HB = window.HB;

  (async function init() {
    HB.ui.initPointerGlow();
    HB.state.settings = await HB.H.settings.get().catch(() => null);
    // 恢复上次选择的对象：刷新/重启后左侧各页直接可用
    try {
      const savedId = localStorage.getItem('habitat_last_person');
      if (savedId) {
        const persons = (await HB.H.persons.list().catch(() => [])) || [];
        const p = persons.find(x => x.id === savedId);
        if (p) { HB.state.currentId = p.id; HB.state.currentName = p.name; }
        else localStorage.removeItem('habitat_last_person');
      }
    } catch {}
    HB.updateModeChip && HB.updateModeChip();
    HB.router.renderNav();
    HB.router.render();
  })();
})();
