'use strict';
/* 演练 · 视图：原话库（文字 + 截图存证，剪贴板粘贴，缩略图懒加载） */
(() => {
  const HB = window.HB;
  const { $, esc, toast, guard, modal, closeModal, attachImagePickers } = HB.ui;
  const H = HB.H;
  const state = HB.state;
  const { evidenceImage } = HB.api;

  async function viewEvidence(el) {
    const b = await guard(() => H.persons.get({ id: state.currentId }), '加载中…');
    if (!b) return;
    const SRC = { chat: '聊天', moments: '朋友圈', feedback: '现实反馈', interview: '访谈', other: '其他' };
    const list = [...b.evidence].sort((a, c) => c.seq - a.seq);
    el.innerHTML = `
      <div class="page-head">
        <div class="page-title">原话库 <span class="muted small" style="font-weight:400">${b.evidence.length} 条</span></div>
        <div class="page-desc">所有推断都必须能追溯到这里。<b>只存证，不评论</b> —— 归纳交给引擎。支持文字原文与<b>截图</b>（聊天截图、朋友圈截图均可；支持 Ctrl+V 直接粘贴）。</div>
      </div>
      <div class="panel hairline-top" data-glow id="eviPanel">
        <div class="panel-title">添加证据</div>
        <div class="row mb14">
          <label class="field" style="margin:0"><span>来源类型</span><select id="eviSrc">
            <option value="chat">聊天</option><option value="moments">朋友圈/QQ空间</option>
            <option value="feedback">现实反馈</option><option value="other">其他</option>
          </select></label>
        </div>
        <label class="field"><span>原文（完整粘贴，不要改写；仅截图时可留空）</span><textarea id="eviText" placeholder="她的原话 / 动态原文 / 她对你回复的真实反应"></textarea></label>
        <label class="field"><span>截图（可多选，或在此区域 Ctrl+V 粘贴；单张 ≤15MB）</span>
          <div class="evi-drop" id="eviDrop">点击选择图片，或按 Ctrl+V 粘贴截图</div>
        </label>
        <div id="eviQueue" class="evi-queue"></div>
        <div class="flex"><button class="btn primary" id="eviAdd">存证</button><span class="muted small">快捷键 Ctrl+Enter · 图片解析完全在本机/你配置的模型侧完成</span></div>
      </div>
      <div class="panel" data-glow>
        <div class="panel-title">素材列表</div>
        <div class="evi-toolbar">
          <div class="chips" id="eviFilter">
            <span class="chip active" data-fsrc="all">全部</span>
            ${Object.entries(SRC).map(([k, v]) => `<span class="chip" data-fsrc="${k}">${v}</span>`).join('')}
          </div>
          <input type="text" id="eviSearch" placeholder="搜索原文 / 发送者…" style="flex:1;min-width:180px">
        </div>
        <div id="eviList"></div>
      </div>
    `;

    // 列表渲染与筛选（客户端过滤）
    let filterSrc = 'all', filterQ = '';
    const visibleList = () => list.filter(e =>
      (filterSrc === 'all' || e.sourceType === filterSrc) &&
      (!filterQ || ((e.text || '') + ' ' + (e.sender || '')).toLowerCase().includes(filterQ.toLowerCase())));
    const renderList = () => {
      const rows = visibleList();
      $('#eviList').innerHTML = rows.length ? rows.map(e => `
          <div class="list-row">
            <span class="badge plain">#${e.seq}</span>
            <span class="badge plain">${esc(SRC[e.sourceType] || e.sourceType)}</span>
            <div class="grow">
              ${e.media ? `<div class="evi-thumb" data-img="${e.id}"><img data-thumb="${e.id}" alt="证据截图"></div>` : ''}
              <div class="evi-text" data-evi="${e.id}">${esc(e.text || '（截图证据）')}</div>
              <div class="list-sub">${esc(e.sender || '')}${e.ts ? ' · ' + esc(e.ts.replace('T', ' ').slice(0, 16)) : ''}${e.isSelf === true ? ' · 本人' : e.isSelf === false && e.sender ? ' · ' + esc(e.sender) : ''}</div></div>
            <button class="btn sm ghost" data-open="${e.id}">展开</button>
            <button class="btn sm ghost" data-del="${e.id}">删</button>
          </div>`).join('')
        : (list.length
          ? '<div class="muted small" style="padding:8px 2px">没有符合筛选条件的素材 —— 换个来源或清空搜索词试试。</div>'
          : '<div class="empty"><div class="empty-icon">▢</div><div class="empty-title">还没有素材</div><p>去「导入」页面批量粘贴聊天记录，或在这里手动存证（支持截图）。</p></div>');
      bindList();
    };
    const bindList = () => {
      // 缩略图懒加载
      $('#eviList').querySelectorAll('[data-thumb]').forEach(async (img) => {
        const url = await evidenceImage(b.id, img.dataset.thumb, true);
        if (url) img.src = url; else img.replaceWith(Object.assign(document.createElement('span'), { textContent: '⚠ 图片缺失', className: 'muted small' }));
      });
      $('#eviList').querySelectorAll('[data-open]').forEach(btn => {
        btn.onclick = () => { const t = $(`#eviList [data-evi="${btn.dataset.open}"]`); t.classList.toggle('open'); btn.textContent = t.classList.contains('open') ? '收起' : '展开'; };
      });
      $('#eviList').querySelectorAll('[data-img]').forEach(thumb => {
        thumb.onclick = async () => {
          const url = await evidenceImage(b.id, thumb.dataset.img, false);
          if (!url) return toast('原图读取失败', 'err');
          modal(`<h3>证据截图</h3><div style="text-align:center"><img src="${url}" style="max-width:100%;border-radius:10px"></div><div class="modal-ops"><button class="btn ghost" id="mClose">关闭</button></div>`);
          $('#mClose').onclick = closeModal;
        };
      });
      $('#eviList').querySelectorAll('[data-del]').forEach(btn => {
        btn.onclick = async () => { await H.evidence.del({ id: b.id, evidenceId: btn.dataset.del }); viewEvidence(el); };
      });
    };
    renderList();
    $('#eviFilter').querySelectorAll('[data-fsrc]').forEach(chip => {
      chip.onclick = () => {
        filterSrc = chip.dataset.fsrc;
        $('#eviFilter').querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        renderList();
      };
    });
    $('#eviSearch').addEventListener('input', (e) => { filterQ = e.target.value.trim(); renderList(); });

    // 待存证图片队列（File 对象 + 预览）
    const queue = [];
    const renderQueue = () => {
      $('#eviQueue').innerHTML = queue.map((f, i) => `
        <div class="evi-queue-item">
          <img src="${f.preview}" alt="待存证截图">
          <div class="evi-queue-meta">${esc(f.file.name || '剪贴板图片')} · ${Math.round(f.file.size / 1024)}KB</div>
          <button class="btn sm ghost" data-unq="${i}">✕</button>
        </div>`).join('');
      $('#eviQueue').querySelectorAll('[data-unq]').forEach(btn => {
        btn.onclick = () => { queue.splice(Number(btn.dataset.unq), 1); renderQueue(); };
      });
    };
    const addFiles = (files) => {
      for (const f of files.slice(0, 12 - queue.length)) {
        if (f.size > 15 * 1024 * 1024) { toast(`「${f.name}」超过 15MB，已跳过`, 'err'); continue; }
        queue.push({ file: f, preview: URL.createObjectURL(f) });
      }
      renderQueue();
    };
    attachImagePickers({ onFiles: addFiles, pasteZone: $('#eviDrop') });
    $('#eviDrop').onclick = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/png,image/jpeg,image/gif,image/webp';
      input.multiple = true;
      input.onchange = () => { if (input.files && input.files.length) addFiles([...input.files]); };
      input.click();
    };

    const readFileBase64 = (file) => new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || '').split(',')[1] || '');
      fr.onerror = () => reject(new Error('图片读取失败'));
      fr.readAsDataURL(file);
    });

    $('#eviAdd').onclick = async () => {
      const text = $('#eviText').value.trim();
      if (!text && !queue.length) return toast('请填写原文或添加截图', 'err');
      const btn = $('#eviAdd');
      btn.disabled = true;
      try {
        if (!queue.length) {
          const r = await H.evidence.add({ id: b.id, items: [{ sourceType: $('#eviSrc').value, text }] });
          toast(`已存证（共 ${r.total} 条）`, 'ok');
        } else {
          let total = 0;
          for (const f of queue) {
            const dataB64 = await readFileBase64(f.file);
            const r = await H.evidence.add({ id: b.id, items: [{
              sourceType: $('#eviSrc').value, text: f === queue[0] ? text : '', mediaB64: dataB64,
            }] });
            total = r.total;
          }
          toast(`已存证 ${queue.length} 张截图（共 ${total} 条）`, 'ok');
        }
        queue.forEach(f => URL.revokeObjectURL(f.preview));
        viewEvidence(el);
      } catch (err) {
        toast(err.message || '存证失败', 'err');
        btn.disabled = false;
      }
    };
    $('#eviText').addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'Enter') $('#eviAdd').click(); });
  }

  HB.views = HB.views || {};
  HB.views.evidence = viewEvidence;
})();
