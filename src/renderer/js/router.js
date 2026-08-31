'use strict';
/* 演练 · 路由：导航渲染、视图切换、主渲染循环 */
(() => {
  const HB = window.HB;
  const { $, esc } = HB.ui;
  const state = HB.state;
  const { NAV } = HB.C;

  function needsAttention() { return false; }

  function renderNav() {
    const nav = $('#nav');
    nav.innerHTML = NAV.map(n =>
      `<div class="nav-item ${state.view === n.id ? 'active' : ''}" data-view="${n.id}" data-glow role="link" tabindex="0"
        ${state.view === n.id ? 'aria-current="page"' : ''}>
        ${n.icon}<span>${n.label}</span>
        <span class="nav-badge ${needsAttention(n.id) ? 'attn' : ''}"></span>
      </div>`).join('');
    nav.querySelectorAll('.nav-item').forEach(el => {
      el.addEventListener('click', () => go(el.dataset.view));
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(el.dataset.view); }
      });
    });
    updatePersonChip();
  }

  function updatePersonChip() {
    const chip = $('#personChip');
    if (!chip) return;
    const show = state.currentId && state.view !== 'home';
    chip.hidden = !show;
    if (show) chip.querySelector('.person-chip-name').textContent = state.currentName || '当前人物';
  }

  // 侧栏当前人物 chip：点击快捷打开状态栏
  const personChip = $('#personChip');
  if (personChip) {
    personChip.classList.add('clickable');
    personChip.title = '点击查看状态栏';
    personChip.addEventListener('click', () => {
      if (state.currentId) HB.hud.open(state.currentId);
    });
  }

  function go(view) {
    // 设置与人物页不依赖当前人物；其余视图需要先选择人物
    if (!['home', 'settings'].includes(view) && !state.currentId) { toast('请先创建并选择一位对象', 'err'); return; }
    state.view = view;
    renderNav();
    render();
  }

  const VIEWS = () => HB.views;

  async function render() {
    const el = $('#main');
    const fn = VIEWS()[state.view] || HB.views.home;
    try { await fn(el); } catch (err) { el.innerHTML = `<div class="empty"><div class="empty-title">加载失败</div><p>${esc(err.message)}</p></div>`; }
    HB.updateModeChip && HB.updateModeChip();
  }

  HB.router = { renderNav, updatePersonChip, go, render };
})();
