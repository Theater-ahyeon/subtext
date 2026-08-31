'use strict';
/* 彩排 · DOM 工具：选择器、转义、受限 markdown、toast、loading、模态、图片拾取、指针辉光 */
(() => {
  const HB = (window.HB = window.HB || {});

  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 3600);
  }

  function loading(show, text = '处理中…') {
    $('#loading').hidden = !show;
    $('#loadingText').textContent = text;
  }

  async function guard(promiseFn, loadText) {
    loading(true, loadText);
    try { return await promiseFn(); }
    catch (err) { toast(err.message || String(err), 'err'); return null; }
    finally { loading(false); }
  }

  function modal(html) {
    $('#modal').innerHTML = html;
    $('#modalBackdrop').hidden = false;
    // 焦点管理：进入模态时聚焦首个可交互控件，Esc 可关闭
    const focusable = $('#modal').querySelector('input, textarea, select, button');
    if (focusable) focusable.focus();
  }
  function closeModal() {
    $('#modalBackdrop').hidden = true;
    $('#modal').innerHTML = '';
  }
  $('#modalBackdrop').addEventListener('click', (e) => { if (e.target === $('#modalBackdrop')) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modalBackdrop').hidden) closeModal();
  });

  /** 受限 markdown：先转义，再渲染标题/列表/加粗 */
  function md(text) {
    const lines = esc(text).split(/\r?\n/);
    let html = '', inUl = false;
    for (const line of lines) {
      const t = line.trim();
      if (/^###\s/.test(t)) { if (inUl) { html += '</ul>'; inUl = false; } html += `<h3>${t.replace(/^###\s*/, '')}</h3>`; }
      else if (/^##\s/.test(t)) { if (inUl) { html += '</ul>'; inUl = false; } html += `<h2>${t.replace(/^##\s*/, '')}</h2>`; }
      else if (/^[-*]\s/.test(t)) { if (!inUl) { html += '<ul>'; inUl = true; } html += `<li>${inline(t.replace(/^[-*]\s*/, ''))}</li>`; }
      else if (t === '') { if (inUl) { html += '</ul>'; inUl = false; } }
      else { if (inUl) { html += '</ul>'; inUl = false; } html += `<p>${inline(t)}</p>`; }
    }
    if (inUl) html += '</ul>';
    function inline(s) { return s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'); }
    return `<div class="report">${html}</div>`;
  }

  /** 公共图片拾取：选文件 或 从剪贴板粘贴（返回 File 数组） */
  function attachImagePickers({ onFiles, pasteZone }) {
    const take = (files) => {
      const imgs = [...files].filter(f => /^image\//.test(f.type));
      if (imgs.length) onFiles(imgs);
      else toast('请选择图片文件（PNG / JPG / GIF / WebP）', 'err');
    };
    if (pasteZone) {
      pasteZone.addEventListener('paste', (e) => {
        const files = [...((e.clipboardData && e.clipboardData.files) || [])];
        if (files.length) { e.preventDefault(); take(files); }
      });
    }
    return { take };
  }

  /** Card Hover Effect：指针跟随辉光，写入被悬停元素的 --mx/--my */
  function initPointerGlow() {
    document.addEventListener('pointermove', (e) => {
      const t = e.target && e.target.closest && e.target.closest('[data-glow]');
      if (!t) return;
      const r = t.getBoundingClientRect();
      t.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      t.style.setProperty('--my', (e.clientY - r.top) + 'px');
    }, { passive: true });
  }

  HB.ui = { $, esc, toast, loading, guard, modal, closeModal, md, attachImagePickers, initPointerGlow };
})();
