'use strict';
/* 生境沙盒 · 前端 SPA（原生 JS，无构建步骤） */

const H = window.habitat;
const state = {
  persons: [],
  currentId: null,
  view: 'home',
  session: null,       // {id, messages: []}
  sessionScenario: '',
  predictions: [],
  importPreview: null,
  settings: null,
  interview: null,
};

/* ---------------- 工具 ---------------- */
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
}
function closeModal() { $('#modalBackdrop').hidden = true; }
$('#modalBackdrop').addEventListener('click', (e) => { if (e.target === $('#modalBackdrop')) closeModal(); });

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

const LAYER_NAMES = { basic: '基础信息', life: '生活结构', temperament: '人物性情', expression: '场景表达' };
const EPI_NAMES = { fact: '事实', inference: '推断', blank: '空白' };
const SRC_NAMES = { evidence: '证据支持', user: '用户陈述', ai: 'AI推断' };
const VERDICT_NAMES = {
  hit: '命中', partial: '部分命中', miss: '未命中', 'fact-error': '事实层错误',
  'material-missing': '材料缺失', 'temperament-error': '性情推断错', 'expression-error': '表达偏差',
};
const pct = (v) => (v == null ? '—' : Math.round(v * 100) + '%');

/* ---------------- 导航 ---------------- */
const NAV = [
  { id: 'home', label: '人物', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5"/></svg>' },
  { id: 'card', label: '生境卡', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>' },
  { id: 'evidence', label: '证据库', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 3h9l4 4v14H6z"/><path d="M9 12h6M9 16h6"/></svg>' },
  { id: 'import', label: '导入', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4v10m0 0 4-4m-4 4-4-4"/><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/></svg>' },
  { id: 'interview', label: '24问访谈', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.8.35-1.4.9-1.4 1.7v.5"/><circle cx="11.5" cy="17" r=".6" fill="currentColor"/></svg>' },
  { id: 'rehearsal', label: '演练', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a8 8 0 1 1-3.2-6.4L21 5l-.6 3.4A8 8 0 0 1 21 12Z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/></svg>' },
  { id: 'calibration', label: '校准闭环', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 3v4h-4"/></svg>' },
  { id: 'settings', label: '设置', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"/></svg>' },
];

function renderNav() {
  const nav = $('#nav');
  nav.innerHTML = NAV.map(n =>
    `<div class="nav-item ${state.view === n.id ? 'active' : ''}" data-view="${n.id}">
      ${n.icon}<span>${n.label}</span>
      <span class="nav-badge ${needsAttention(n.id) ? 'attn' : ''}"></span>
    </div>`).join('');
  nav.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => go(el.dataset.view));
  });
}
function needsAttention() { return false; }

function go(view) {
  if (view !== 'home' && !state.currentId) { toast('请先创建并选择一位人物', 'err'); return; }
  state.view = view;
  renderNav();
  render();
}

/* ---------------- 视图：人物 ---------------- */
async function viewHome(el) {
  state.persons = await H.persons.list() || [];
  el.innerHTML = `
    <div class="page-head">
      <div class="page-title">人物</div>
      <div class="page-desc">为每一位你想理解、想演练的真实对象建立一份<b>本地生境档案</b>。所有数据只保存在你自己的电脑上。</div>
    </div>
    ${state.persons.length ? `
      <div class="person-grid">
        ${state.persons.map((p, i) => `
          <div class="person-card" data-id="${p.id}">
            <div class="avatar ${['', 'jade', 'violet'][i % 3]}">${esc((p.name || '?').slice(0, 1))}</div>
            <div class="person-name">${esc(p.name)}</div>
            <div class="person-alias">${esc(p.alias || '暂无备注')}</div>
            <div class="person-stats">
              <span>创建 ${esc((p.createdAt || '').slice(0, 10))}</span>
            </div>
            <button class="btn danger sm person-del" data-del="${p.id}">删除</button>
          </div>`).join('')}
        <div class="person-card" id="addPersonCard" style="display:grid;place-items:center;min-height:170px;border-style:dashed;">
          <div style="text-align:center;color:var(--muted)">
            <div style="font-size:26px;margin-bottom:6px">＋</div>
            <div style="font-size:13px">新建人物档案</div>
          </div>
        </div>
      </div>` : `
      <div class="empty">
        <div class="empty-icon">◍</div>
        <div class="empty-title">还没有人物档案</div>
        <p>生境写法不为人物预写答案，而是用尽量少、彼此分工明确的内容，建立足以让"她"在陌生情境中继续生活的生成条件。从创建第一份档案开始。</p>
        <button class="btn primary" id="emptyAdd">创建第一份档案</button>
      </div>`}
  `;
  el.querySelectorAll('.person-card[data-id]').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-del]')) return;
      state.currentId = card.dataset.id;
      go('card');
    });
  });
  el.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = state.persons.find(x => x.id === btn.dataset.del);
      modal(`<h3>删除「${esc(p.name)}」？</h3>
        <p class="muted small">将删除其生境卡、证据、演练与访谈的全部本地数据，不可恢复。</p>
        <div class="modal-ops"><button class="btn ghost" id="mCancel">取消</button><button class="btn danger" id="mOk">确认删除</button></div>`);
      $('#mCancel').onclick = closeModal;
      $('#mOk').onclick = async () => { await H.persons.del({ id: p.id }); closeModal(); toast('已删除', 'ok'); viewHome(el); };
    });
  });
  const openCreate = () => {
    modal(`<h3>新建人物档案</h3>
    <label class="field"><span>称呼 *</span><input type="text" id="mName" placeholder="她 / 他的称呼" maxlength="20"></label>
    <label class="field"><span>备注（可选）</span><input type="text" id="mAlias" placeholder="例如：同事 / 朋友 / 暧昧对象" maxlength="30"></label>
    <div class="note">红线：档案数据仅限本人查看；本工具辅助理解与表达，不用于伤害他人。</div>
    <div class="modal-ops"><button class="btn ghost" id="mCancel">取消</button><button class="btn primary" id="mOk">创建</button></div>`);
    $('#mCancel').onclick = closeModal;
    $('#mOk').onclick = async () => {
      const name = $('#mName').value.trim();
      if (!name) return toast('请填写称呼', 'err');
      const b = await guard(() => H.persons.create({ name, alias: $('#mAlias').value.trim() }), '创建中…');
      if (b) { closeModal(); toast('已创建', 'ok'); state.currentId = b.id; go('card'); }
    };
  };
}

/* ---------------- 视图：生境卡 ---------------- */
async function viewCard(el) {
  const b = await guard(() => H.persons.get({ id: state.currentId }), '加载中…');
  if (!b) return;
  const stats = await H.stats({ id: b.id });
  const layers = ['basic', 'life', 'temperament', 'expression'];
  el.innerHTML = `
    <div class="page-head">
      <div class="page-title">${esc(b.name)} 的生境卡
        <button class="btn sm ghost" id="editPerson">编辑</button>
      </div>
      <div class="page-desc">${esc(b.alias || '')} · 素材 ${stats.evidence} 条 · 认知条目 ${stats.claims} 条（事实 ${stats.byEpistemic.fact} / 推断 ${stats.byEpistemic.inference} / 空白 ${stats.byEpistemic.blank}）</div>
    </div>
    <div class="panel">
      <div class="panel-title">生境卡引擎
        <button class="btn sm primary" id="induceBtn">从素材归纳初稿</button>
        <button class="btn sm ghost" id="compileBtn">预览注入给 AI 的卡片</button>
        <button class="btn sm ghost" id="exportBtn">导出</button>
      </div>
      <div class="panel-sub">四层分工：<b>基础信息</b>确定她站在哪里 · <b>生活结构</b>提供她能做什么 · <b>人物性情</b>说明她怎样理解事情 · <b>场景表达</b>描述她如何开口与行动。空白条目不进入 AI 的卡片。</div>
      ${layers.map(L => `
        <div class="mt14">
          <div class="flex mb14" style="justify-content:space-between">
            <div class="panel-title" style="margin:0">${LAYER_NAMES[L]}</div>
            <button class="btn sm ghost" data-add="${L}">＋ 添加</button>
          </div>
          ${(b.claims.filter(c => c.layer === L)).sort((a, c) => (a.epistemic === 'blank') - (c.epistemic === 'blank') || c.confidence - a.confidence).map(c => `
            <div class="claim-item ${c.epistemic === 'blank' ? 'blank-item' : ''}" data-claim="${c.id}">
              <div class="claim-text">${esc(c.text)}
                <div class="claim-meta">
                  <span class="badge ${c.epistemic}">${EPI_NAMES[c.epistemic]}</span>
                  <span class="badge src-${c.source}">${SRC_NAMES[c.source]}</span>
                  ${c.refs && c.refs.length ? `<span class="badge plain">引用证据 ×${c.refs.length}</span>` : ''}
                  ${c.note ? `<span class="muted small">${esc(c.note).slice(0, 60)}</span>` : ''}
                </div>
                ${c.epistemic !== 'blank' ? `<div class="conf-wrap bar"><i style="width:${Math.round((c.confidence || 0) * 100)}%"></i></div>` : ''}
              </div>
              <div class="claim-ops">
                <button class="btn sm ghost" data-edit="${c.id}">改</button>
                <button class="btn sm ghost" data-del="${c.id}">删</button>
              </div>
            </div>`).join('') || '<div class="muted small" style="padding:4px 2px">这一层还没有内容 —— 空着是允许的，不要为了完整而编造。</div>'}
        </div>`).join('')}

      <div class="mt20">
        <div class="flex mb14" style="justify-content:space-between">
          <div class="panel-title" style="margin:0">动态状态 <span class="muted small" style="font-weight:400">（易过期信息只放这里，不进静态人设）</span></div>
          <button class="btn sm ghost" id="addDyn">＋ 记录</button>
        </div>
        ${b.dynamic.filter(d => !d.resolved).map(d => `
          <div class="list-row">
            <div class="grow"><div class="list-title">${esc(d.text)}</div><div class="list-sub">${esc(d.asOf.slice(0, 16)).replace('T', ' ')}</div></div>
            <button class="btn sm ghost" data-resolve="${d.id}">翻篇</button>
          </div>`).join('') || '<div class="muted small">暂无进行中的动态状态。</div>'}
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">话题雷达</div>
      <div class="panel-sub">由生境卡空白与访谈待确认项生成 —— 这些是"你还不知道的事"，可以在下次真实聊天中自然求证。</div>
      <div id="radarBox"><div class="muted small">加载中…</div></div>
    </div>
  `;

  $('#induceBtn').onclick = async () => {
    const r = await guard(() => H.card.induce({ id: b.id }), 'AI 正在按生境写法归纳素材…（可能较慢）');
    if (r) { toast(`归纳完成：新增 ${r.newClaims} 条（共 ${r.total} 条，${r.chunks} 批素材）`, 'ok'); viewCard(el); }
  };
  $('#compileBtn').onclick = async () => {
    const card = await guard(() => H.card.compile({ id: b.id }), '组装中…');
    if (card) modal(`<h3>注入给 AI 的最小生境卡</h3><pre style="white-space:pre-wrap;font-size:12.5px;line-height:1.7">${esc(card)}</pre><div class="modal-ops"><button class="btn ghost" onclick="document.getElementById('modalBackdrop').hidden=true">关闭</button></div>`);
  };
  $('#exportBtn').onclick = async () => {
    const r = await guard(() => H.card.export({ id: b.id }), '导出中…');
    if (r && !r.canceled) toast('已导出到 ' + r.path, 'ok');
  };
  $('#editPerson').onclick = () => {
    modal(`<h3>编辑人物</h3>
      <label class="field"><span>称呼</span><input type="text" id="mName" value="${esc(b.name)}" maxlength="20"></label>
      <label class="field"><span>备注</span><input type="text" id="mAlias" value="${esc(b.alias || '')}" maxlength="30"></label>
      <div class="modal-ops"><button class="btn ghost" id="mCancel">取消</button><button class="btn primary" id="mOk">保存</button></div>`);
    $('#mCancel').onclick = closeModal;
    $('#mOk').onclick = async () => {
      await H.persons.update({ id: b.id, patch: { name: $('#mName').value.trim(), alias: $('#mAlias').value.trim() } });
      closeModal(); viewCard(el);
    };
  };
  el.querySelectorAll('[data-add]').forEach(btn => {
    btn.onclick = () => claimForm(b, btn.dataset.add, null, () => viewCard(el));
  });
  el.querySelectorAll('[data-edit]').forEach(btn => {
    btn.onclick = () => {
      const c = b.claims.find(x => x.id === btn.dataset.edit);
      claimForm(b, c.layer, c, () => viewCard(el));
    };
  });
  el.querySelectorAll('[data-del]').forEach(btn => {
    btn.onclick = async () => { await H.card.delClaim({ id: b.id, claimId: btn.dataset.del }); toast('已删除'); viewCard(el); };
  });
  el.querySelectorAll('[data-resolve]').forEach(btn => {
    btn.onclick = async () => { await H.card.resolveDyn({ id: b.id, dynId: btn.dataset.resolve }); viewCard(el); };
  });
  $('#addDyn').onclick = () => {
    modal(`<h3>记录动态状态</h3>
      <label class="field"><span>她近期的状态 / 事件（会过期的信息）</span><textarea id="mDyn" placeholder="例如：最近在赶项目，回复变慢；刚和家人吵完架"></textarea></label>
      <div class="modal-ops"><button class="btn ghost" id="mCancel">取消</button><button class="btn primary" id="mOk">记录</button></div>`);
    $('#mCancel').onclick = closeModal;
    $('#mOk').onclick = async () => {
      const t = $('#mDyn').value.trim();
      if (!t) return toast('请填写内容', 'err');
      await H.card.addDyn({ id: b.id, text: t });
      closeModal(); viewCard(el);
    };
  };
  const radar = await guard(() => H.radar({ id: b.id }), '加载…');
  $('#radarBox').innerHTML = radar && radar.length
    ? radar.map(r => `<div class="list-row"><span class="badge plain">${esc(r.from)}</span><div class="grow list-title">${esc(r.text)}</div></div>`).join('')
    : '<div class="muted small">暂无空白或待确认项 —— 先导入素材并归纳，或从 24 问访谈沉淀。</div>';
}

function claimForm(b, layer, claim, done) {
  modal(`<h3>${claim ? '编辑' : '添加'}${LAYER_NAMES[layer]}条目</h3>
    <label class="field"><span>内容 *</span><textarea id="mText" placeholder="${layer === 'temperament' ? '用倾向措辞：她往往…、容易…、很难…（不要「永远」）' : '事实与限制，一句话说清'}">${esc(claim ? claim.text : '')}</textarea></label>
    <div class="row">
      <label class="field"><span>认识层级</span><select id="mEpi">
        <option value="inference" ${claim && claim.epistemic === 'inference' ? 'selected' : ''}>推断</option>
        <option value="fact" ${claim && claim.epistemic === 'fact' ? 'selected' : ''}>事实</option>
        <option value="blank" ${claim && claim.epistemic === 'blank' ? 'selected' : ''}>空白（待了解）</option>
      </select></label>
      <label class="field"><span>来源</span><select id="mSrc">
        <option value="user" ${claim && claim.source === 'user' ? 'selected' : ''}>用户陈述</option>
        <option value="evidence" ${claim && claim.source === 'evidence' ? 'selected' : ''}>证据支持</option>
        <option value="ai" ${claim && claim.source === 'ai' ? 'selected' : ''}>AI推断</option>
      </select></label>
      <label class="field"><span>置信度</span><input type="number" id="mConf" min="0" max="1" step="0.05" value="${claim ? claim.confidence : 0.6}"></label>
    </div>
    <label class="field"><span>备注（可选）</span><input type="text" id="mNote" value="${esc(claim ? claim.note || '' : '')}"></label>
    <div class="modal-ops"><button class="btn ghost" id="mCancel">取消</button><button class="btn primary" id="mOk">${claim ? '保存' : '添加'}</button></div>`);
  $('#mCancel').onclick = closeModal;
  $('#mOk').onclick = async () => {
    const text = $('#mText').value.trim();
    if (!text) return toast('请填写内容', 'err');
    const payload = { layer, text, epistemic: $('#mEpi').value, source: $('#mSrc').value, confidence: Number($('#mConf').value) || 0.5, note: $('#mNote').value.trim() };
    if (claim) await H.card.updateClaim({ id: b.id, claimId: claim.id, patch: payload });
    else await H.card.addClaim({ id: b.id, claim: payload });
    closeModal(); toast('已保存', 'ok'); done();
  };
}

/* ---------------- 视图：证据库 ---------------- */
async function viewEvidence(el) {
  const b = await guard(() => H.persons.get({ id: state.currentId }), '加载中…');
  if (!b) return;
  const SRC = { chat: '聊天', moments: '朋友圈', feedback: '现实反馈', interview: '访谈', other: '其他' };
  const list = [...b.evidence].sort((a, c) => c.seq - a.seq);
  el.innerHTML = `
    <div class="page-head">
      <div class="page-title">证据库 <span class="muted small" style="font-weight:400">${b.evidence.length} 条</span></div>
      <div class="page-desc">所有推断都必须能追溯到这里。<b>只存证，不评论</b> —— 归纳交给引擎。</div>
    </div>
    <div class="panel">
      <div class="panel-title">手动添加证据</div>
      <div class="row mb14">
        <label class="field" style="margin:0"><span>来源类型</span><select id="eviSrc">
          <option value="chat">聊天</option><option value="moments">朋友圈/QQ空间</option>
          <option value="feedback">现实反馈</option><option value="other">其他</option>
        </select></label>
      </div>
      <label class="field"><span>原文（完整粘贴，不要改写）</span><textarea id="eviText" placeholder="她的原话 / 动态原文 / 她对你回复的真实反应"></textarea></label>
      <div class="flex"><button class="btn primary" id="eviAdd">存证</button><span class="muted small">快捷键 Ctrl+Enter</span></div>
    </div>
    <div class="panel">
      <div class="panel-title">素材列表</div>
      ${list.length ? list.map(e => `
        <div class="list-row">
          <span class="badge plain">#${e.seq}</span>
          <span class="badge plain">${SRC[e.sourceType] || e.sourceType}</span>
          <div class="grow"><div class="evi-text" data-evi="${e.id}">${esc(e.text)}</div>
            <div class="list-sub">${esc(e.sender || '')}${e.ts ? ' · ' + esc(e.ts.replace('T', ' ').slice(0, 16)) : ''}${e.isSelf === true ? ' · 本人' : e.isSelf === false && e.sender ? ' · ' + esc(e.sender) : ''}</div></div>
          <button class="btn sm ghost" data-open="${e.id}">展开</button>
          <button class="btn sm ghost" data-del="${e.id}">删</button>
        </div>`).join('') : '<div class="empty"><div class="empty-icon">▢</div><div class="empty-title">还没有素材</div><p>去「导入」页面批量粘贴聊天记录，或在这里手动存证。</p></div>'}
    </div>
  `;
  $('#eviAdd').onclick = async () => {
    const text = $('#eviText').value.trim();
    if (!text) return toast('请填写原文', 'err');
    const r = await guard(() => H.evidence.add({ id: b.id, items: [{ sourceType: $('#eviSrc').value, text }] }), '存证中…');
    if (r) { toast(`已存证（共 ${r.total} 条）`, 'ok'); viewEvidence(el); }
  };
  el.querySelectorAll('[data-open]').forEach(btn => {
    btn.onclick = () => { const t = $(`[data-evi="${btn.dataset.open}"]`); t.classList.toggle('open'); btn.textContent = t.classList.contains('open') ? '收起' : '展开'; };
  });
  el.querySelectorAll('[data-del]').forEach(btn => {
    btn.onclick = async () => { await H.evidence.del({ id: b.id, evidenceId: btn.dataset.del }); viewEvidence(el); };
  });
}

/* ---------------- 视图：导入 ---------------- */
async function viewImport(el) {
  state.importPreview = null;
  el.innerHTML = `
    <div class="page-head">
      <div class="page-title">导入聊天素材</div>
      <div class="page-desc">支持 GitHub 常见导出工具的格式：<b>留痕 MemoTrace / WeChatMsg</b>（微信 JSON / CSV / TXT）、<b>QQ 导出 TXT</b>（时间戳行）、通用 JSON 数组、JSONL、以及任意直接粘贴的对话文本。解析完全在本机完成。</div>
    </div>
    <div class="panel">
      <div class="panel-title">方式一：粘贴文本</div>
      <label class="field"><span>粘贴聊天记录原文</span><textarea id="impText" style="min-height:150px" placeholder='支持例如：
留痕 JSON：[{"sender":"她","msg":"…","CreateTime":"1700000000","is_sender":0},…]
QQ TXT：2024-01-01 12:00:00 她的昵称
今天有点累，回头说
普通粘贴：她：今天有点累，回头说'></textarea></label>
      <div class="row">
        <label class="field"><span>素材类型</span><select id="impSrc">
          <option value="chat">聊天</option><option value="moments">朋友圈/QQ空间</option>
          <option value="other">其他</option>
        </select></label>
        <label class="field"><span>你的昵称（用于区分"本人"，可选）</span><input type="text" id="impSelf" placeholder="你在聊天中显示的名字"></label>
      </div>
      <div class="flex"><button class="btn primary" id="impParse">解析预览</button></div>
      <div id="impPreview" class="mt14"></div>
    </div>
    <div class="panel">
      <div class="panel-title">方式二：选择文件</div>
      <div class="panel-sub">支持 .json / .jsonl / .csv / .txt（UTF-8 编码）</div>
      <button class="btn" id="impFile">选择文件并导入</button>
    </div>
    <div class="panel">
      <div class="panel-title">格式对照说明</div>
      <div class="report small">
        <ul>
          <li><strong>留痕 MemoTrace JSON</strong>：字段 sender / nick / msg / CreateTime / is_sender —— 自动识别</li>
          <li><strong>WeChatMsg CSV</strong>：表头含 StrContent / SenderName / CreateTime 等 —— 自动识别</li>
          <li><strong>QQ 导出 TXT</strong>：形如 <code>2024-01-01 12:00:00 昵称(QQ号)\\n内容</code> —— 自动识别</li>
          <li><strong>微信合并转发复制文本</strong>：形如 <code>昵称\\n12:05\\n内容</code> 或 <code>昵称：内容</code> —— 尽力识别</li>
          <li>识别不了的行会被跳过并在统计中显示；<b>导入前先看解析预览确认</b>。</li>
        </ul>
      </div>
    </div>
  `;
  $('#impParse').onclick = async () => {
    const text = $('#impText').value;
    if (!text.trim()) return toast('请先粘贴内容', 'err');
    const r = await guard(() => H.imp.parse({ text, selfName: $('#impSelf').value }), '解析中…');
    if (!r) return;
    state.importPreview = r;
    $('#impPreview').innerHTML = `
      <div class="note">识别格式：<b>${r.format.toUpperCase()}</b> · 解析出 <b>${r.stats.parsed}</b> 条消息${r.stats.skipped ? `（跳过 ${r.stats.skipped} 行）` : ''}</div>
      <div class="mt8" style="max-height:200px;overflow-y:auto;border:1px solid var(--border-soft);border-radius:10px;padding:10px 14px">
        ${r.messages.slice(0, 12).map(m => `<div class="small" style="margin-bottom:6px"><span class="badge plain">${esc(m.sender || '?')}${m.isSelf === true ? '·本人' : ''}</span> ${esc(m.text.slice(0, 120))}</div>`).join('')}
        ${r.messages.length > 12 ? `<div class="muted small">…还有 ${r.messages.length - 12} 条</div>` : ''}
      </div>
      <div class="mt14 flex"><button class="btn primary" id="impCommit" ${r.stats.parsed ? '' : 'disabled'}>确认导入 ${r.stats.parsed} 条</button></div>
    `;
    $('#impCommit') && ($('#impCommit').onclick = async () => {
      const res = await guard(() => H.imp.commit({ id: state.currentId, messages: r.messages, sourceType: $('#impSrc').value }), '导入中…');
      if (res) { toast(`已导入 ${res.added} 条，证据库共 ${res.total} 条`, 'ok'); state.importPreview = null; }
    });
  };
  $('#impFile').onclick = async () => {
    const src = $('#impSrc').value;
    const r = await guard(() => H.imp.file({ id: state.currentId, sourceType: src, selfName: $('#impSelf').value }), '导入中…');
    if (r && !r.canceled) toast(`已导入 ${r.added} 条（格式 ${r.format.toUpperCase()}）`, 'ok');
  };
}

/* ---------------- 视图：24问访谈 ---------------- */
async function viewInterview(el) {
  const st = await guard(() => H.interview.state({ id: state.currentId }), '加载中…');
  if (!st) return;
  state.interview = st;
  const doneCount = Object.keys(st.records).length;
  const q = st.questions.find(x => x.qid === st.currentQ);
  el.innerHTML = `
    <div class="page-head">
      <div class="page-title">24问访谈</div>
      <div class="page-desc">围绕 <b>24 个正式问题</b>逐步整理你对她的观察。它帮你把"说不上来的直觉"变成可验证的结构；追问不限次数。结果以<b>用户陈述</b>写入生境卡，并在校准闭环中优先被现实验证。</div>
    </div>
    <div class="stat-row mb14">
      <div class="stat-card amber"><div class="stat-num">${doneCount}<span class="unit">/ 24</span></div><div class="stat-label">已完成问题</div></div>
      <div class="stat-card jade"><div class="stat-num">${st.final ? '✓' : pct(doneCount / 24)}</div><div class="stat-label">访谈进度${st.final ? ' · 已完成整合' : ''}</div></div>
    </div>
    ${!st.started && !doneCount ? `
      <div class="panel"><div class="empty">
        <div class="empty-icon">◌</div>
        <div class="empty-title">从 Q1 开始</div>
        <p>建议在安静的时候做：回忆比想象可靠。中途可以随时「总结」，也可以「跳过」你说不准的问题——留白不是缺陷。</p>
        <button class="btn primary" id="ivStart">开始访谈</button>
      </div></div>` : `
      ${q ? `
      <div class="panel">
        <div class="panel-title">${esc(q.group)} · Q${String(q.qid).padStart(2, '0')} <span class="muted small" style="font-weight:400">${doneCount}/24</span></div>
        <div style="font-size:15.5px;line-height:1.7;margin:8px 0 4px">${esc(q.text)}</div>
        <div class="muted small">${esc(q.hint || '')}</div>
        <label class="field mt14"><span>你的回答（越具体越好）</span>
          <textarea id="ivAns" placeholder="她具体会怎么做？最近一次让你产生这种感觉是发生了什么？"></textarea></label>
        <div id="ivProbeBox"></div>
        <div class="flex mt8">
          <button class="btn primary" id="ivSubmit">提交回答</button>
          <button class="btn ghost" id="ivSkip">跳过（暂未确定）</button>
          <span class="flex-grow"></span>
          <button class="btn ghost sm" id="ivSummary">中途总结</button>
        </div>
      </div>` : `
      <div class="panel"><div class="empty">
        <div class="empty-icon">✓</div>
        <div class="empty-title">24 问已全部完成</div>
        <p>点击下方生成最终整合，然后选择要写入生境卡的条目。</p>
        <button class="btn primary" id="ivFinal">生成最终整合</button>
      </div></div>`}
      ${st.final ? finalPanel(st.final, st.suggestions) : ''}
      ${st.summaries && st.summaries.length ? `<div class="panel"><div class="panel-title">中途小结（最近一次）</div>${md(st.summaries[st.summaries.length - 1].text)}</div>` : ''}
      <div class="panel"><div class="panel-title">已回答记录</div>
        ${doneCount ? Object.keys(st.records).map(Number).sort((a, b) => a - b).map(qid => {
          const r = st.records[qid];
          return `<div class="list-row"><span class="badge plain">Q${String(qid).padStart(2, '0')}</span>
            <div class="grow"><div class="list-title">${esc((r.answer || '（暂未确定）').slice(0, 90))}</div>
            ${r.probeAnswer ? `<div class="list-sub">追问：${esc(r.probeAnswer.slice(0, 80))}</div>` : ''}</div></div>`;
        }).join('') : '<div class="muted small">还没有记录。</div>'}
      </div>`}
  `;
  const qid = st.currentQ;
  const submit = async (skipped) => {
    const answer = skipped ? '' : $('#ivAns').value.trim();
    if (!skipped && !answer) return toast('请填写回答，或选择跳过', 'err');
    const r = await guard(() => H.interview.answer({ id: state.currentId, qid, answer, skipped }), '记录中…');
    if (!r) return;
    if (r.probe) {
      $('#ivProbeBox').innerHTML = `
        <div class="note warn mt8"><b>追问：</b>${esc(r.probe)}</div>
        <label class="field mt8"><span>补充回答（或留空跳过）</span><textarea id="ivProbeAns" style="min-height:64px"></textarea></label>
        <button class="btn sm primary" id="ivProbeOk">确认补充</button>`;
      $('#ivProbeOk').onclick = async () => {
        const pa = $('#ivProbeAns') ? $('#ivProbeAns').value.trim() : '';
        const r2 = await guard(() => H.interview.probeAnswer({ id: state.currentId, qid, answer: pa }), '记录中…');
        if (r2) viewInterview(el);
      };
    } else viewInterview(el);
  };
  $('#ivSubmit') && ($('#ivSubmit').onclick = () => submit(false));
  $('#ivSkip') && ($('#ivSkip').onclick = () => submit(true));
  $('#ivStart') && ($('#ivStart').onclick = () => viewInterview(el));
  $('#ivSummary') && ($('#ivSummary').onclick = async () => {
    const r = await guard(() => H.interview.summary({ id: state.currentId }), '整理中…');
    if (r) { modal(`<h3>中途小结</h3>${md(r)}<div class="modal-ops"><button class="btn ghost" id="mCancel">关闭</button></div>`); $('#mCancel').onclick = closeModal; }
  });
  $('#ivFinal') && ($('#ivFinal').onclick = async () => {
    const r = await guard(() => H.interview.finalize({ id: state.currentId }), '生成最终整合…');
    if (r) { toast('整合完成，请勾选要写入生境卡的条目', 'ok'); viewInterview(el); }
  });
}

function finalPanel(final, suggestions) {
  return `
    <div class="panel">
      <div class="panel-title">最终整合 <span class="muted small" style="font-weight:400">${esc(final.ts.slice(0, 10))}</span></div>
      ${md(final.text)}
    </div>
    <div class="panel">
      <div class="panel-title">写入生境卡</div>
      <div class="panel-sub">勾选你认为可靠的条目。<b>用户陈述 ≠ 她的事实</b> —— 写入的条目会在校准闭环中优先被现实验证。</div>
      ${suggestions.map((s, i) => `
        <label class="list-row" style="cursor:pointer">
          <input type="checkbox" data-sug="${i}" ${s.written ? 'disabled checked' : ''} style="width:16px;height:16px;flex:0 0 auto">
          <div class="grow"><div class="list-title" style="${s.written ? 'opacity:.5' : ''}">${esc(s.text)}</div>
          <div class="list-sub">${LAYER_NAMES[s.layer]} · ${s.kind === 'fact' ? '用户确定的事实' : '高可能推论'}${s.written ? ' · 已写入' : ''}</div></div>
        </label>`).join('')}
      <button class="btn primary mt8" id="ivWrite">写入勾选条目</button>
    </div>`;
}

document.addEventListener('click', async (e) => {
  const cb = e.target.closest('[data-sug]');
  if (cb) return; // checkbox 原生行为
  const btn = e.target.closest('#ivWrite');
  if (btn) {
    const boxes = [...document.querySelectorAll('[data-sug]')].filter(x => x.checked && !x.disabled);
    const idx = boxes.map(x => Number(x.dataset.sug));
    if (!idx.length) return toast('请先勾选条目', 'err');
    const r = await guard(() => H.interview.writeClaims({ id: state.currentId, indexes: idx }), '写入中…');
    if (r) { toast(`已写入 ${r.written.length} 条到生境卡`, 'ok'); viewInterview(document.getElementById('main')); }
  }
});

/* ---------------- 视图：演练 ---------------- */
const SCENARIOS = [
  { id: 'custom', label: '自定义', text: '' },
  { id: 'daily', label: '日常闲聊', text: '一段日常的聊天，轻松自然，最近有一周没联系了。' },
  { id: 'date', label: '初次约会', text: '第一次正式约会后的散步，气氛还行，你想进一步了解她。' },
  { id: 'cold', label: '化解冷战', text: '你们因为一件小事冷战了三天，你主动来找她。' },
  { id: 'sorry', label: '道歉', text: '你之前说错了话伤了她的感受，现在当面道歉。' },
  { id: 'talk', label: '重要谈话', text: '有一件重要但可能让她不舒服的事需要当面沟通。' },
  { id: 'ask', label: '提出请求', text: '你需要请她帮一个不太小的忙，不确定她是否愿意。' },
];

async function viewRehearsal(el) {
  const sessions = await guard(() => H.session.list({ id: state.currentId }), '加载中…');
  if (!sessions) return;
  if (state.session) return renderChat(el, sessions);
  el.innerHTML = `
    <div class="page-head">
      <div class="page-title">演练沙盒</div>
      <div class="page-desc">在数字孪生身上<b>彩排重要对话</b>。她由生境卡生成——卡片越准，她越像。演练结束后可冻结预测单，等你拿到她的真实反应，回「校准闭环」对照学习。</div>
    </div>
    <div class="panel">
      <div class="panel-title">选择场景</div>
      <div class="chips mb14" id="scnChips">
        ${SCENARIOS.map((s, i) => `<span class="chip ${i === 0 ? 'active' : ''}" data-scn="${i}">${s.label}</span>`).join('')}
      </div>
      <label class="field"><span>场景补充（对 AI 可见，她看不到）</span>
        <textarea id="scnText" placeholder="补充背景：最近发生了什么、你们的关系阶段、你这次想达成的目标…"></textarea></label>
      <div class="note">红线提醒：本工具不提供操控、打压类策略；演练的目的是更诚实地表达与更好地理解。</div>
      <div class="mt14"><button class="btn primary" id="scnStart">开始演练</button></div>
    </div>
    <div class="panel">
      <div class="panel-title">历史演练</div>
      ${sessions.length ? sessions.slice().reverse().map(s => `
        <div class="list-row">
          <span class="badge ${s.status === 'active' ? 'inference' : 'fact'}">${s.status === 'active' ? '进行中' : '已结束'}</span>
          <div class="grow"><div class="list-title">${esc(s.scenario || '未命名场景')}</div>
          <div class="list-sub">${esc(s.createdAt.slice(0, 16)).replace('T', ' ')} · ${s.turns} 轮</div></div>
          <button class="btn sm ghost" data-view="${s.id}">查看</button>
        </div>`).join('') : '<div class="muted small">还没有演练记录。</div>'}
    </div>
  `;
  let scnIdx = 0;
  el.querySelectorAll('[data-scn]').forEach(chip => {
    chip.onclick = () => {
      scnIdx = Number(chip.dataset.scn);
      el.querySelectorAll('[data-scn]').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      $('#scnText').value = SCENARIOS[scnIdx].text;
    };
  });
  $('#scnStart').onclick = async () => {
    const scenario = $('#scnText').value.trim();
    const r = await guard(() => H.session.start({ id: state.currentId, scenario }), '孪生生成中…她正在上场');
    if (r) {
      state.session = { id: r.sessionId, messages: r.messages };
      state.sessionScenario = scenario;
      toast('演练开始', 'ok'); renderChat(el, sessions);
    }
  };
  el.querySelectorAll('[data-view]').forEach(btn => {
    btn.onclick = async () => {
      const r = await guard(() => H.session.get({ id: state.currentId, sessionId: btn.dataset.view }), '加载中…');
      if (!r) return;
      state.session = { id: r.session.id, messages: r.session.messages, readonly: r.session.status === 'ended' };
      state.sessionScenario = r.session.scenario;
      renderChat(el, sessions, r.report);
    };
  });
}

function renderChat(el, sessions, report) {
  el.innerHTML = `
    <div class="page-head">
      <div class="page-title">演练中 <span class="muted small" style="font-weight:400">${state.session.readonly ? '· 只读回放' : ''}</span></div>
      <div class="page-desc">${esc((state.sessionScenario || '未命名场景').slice(0, 120))}</div>
    </div>
    <div class="panel">
      <div class="chat-wrap">
        <div class="chat-scroll" id="chatScroll">
          ${state.session.messages.map(m => chatBubble(m)).join('')}
        </div>
        ${state.session.readonly ? '' : `
        <div class="chat-input">
          <input type="text" id="chatText" placeholder="说点什么…（她按生境卡回应）" maxlength="2000">
          <button class="btn primary" id="chatSend">发送</button>
        </div>
        <div class="flex mt14">
          <button class="btn sm" id="freezeBtn">冻结预测单</button>
          <button class="btn sm" id="endBtn">结束并生成复盘</button>
          <span class="muted small">预测单 = 你结束前对"她现实中会如何回应"的多假设快照，供之后对照现实校准。</span>
        </div>`}
      </div>
    </div>
    ${report ? `<div class="panel"><div class="panel-title">复盘报告</div>${md(report)}</div>` : ''}
    <div class="mt14"><button class="btn ghost sm" id="backScn">← 返回场景列表</button></div>
  `;
  const scroll = $('#chatScroll');
  scroll.scrollTop = scroll.scrollHeight;
  const send = async () => {
    const text = $('#chatText').value.trim();
    if (!text) return;
    $('#chatText').value = '';
    state.session.messages.push({ role: 'user', content: text, ts: new Date().toISOString() });
    appendBubble({ role: 'user', content: text });
    const r = await guard(() => H.session.send({ id: state.currentId, sessionId: state.session.id, text }), '她在想怎么回…');
    if (!r) return;
    if (r.blocked) {
      state.session.messages.push({ role: 'system', content: r.reply, ts: new Date().toISOString() });
      appendBubble({ role: 'system', content: r.reply });
      return;
    }
    state.session.messages.push({ role: 'twin', content: r.reply, ts: new Date().toISOString() });
    appendBubble({ role: 'twin', content: r.reply });
  };
  $('#chatSend') && ($('#chatSend').onclick = send);
  $('#chatText') && ($('#chatText').addEventListener('keydown', e => { if (e.key === 'Enter') send(); }));
  $('#freezeBtn') && ($('#freezeBtn').onclick = async () => {
    const r = await guard(() => H.loop.freeze({ id: state.currentId, sessionId: state.session.id }), '生成预测单…');
    if (r) {
      modal(`<h3>预测单已冻结</h3>
        ${r.prediction.hypotheses.map(h => `
          <div class="hypo-card">
            <div class="hypo-head"><span class="badge inference">${Math.round(h.prob * 100)}%</span>
              <div class="hypo-text">${esc(h.text)}</div></div>
            <div class="hypo-meta"><b>依据：</b>${esc(h.basis)}<br><b>验证：</b>${esc(h.verify)}</div>
          </div>`).join('')}
        <div class="note">预期形态：${esc(r.prediction.expected)}</div>
        <div class="modal-ops"><button class="btn ghost" id="mCancel">关闭</button><button class="btn primary" id="mGo">去校准闭环</button></div>`);
      $('#mCancel').onclick = closeModal;
      $('#mGo').onclick = () => { closeModal(); state.session = null; go('calibration'); };
    }
  });
  $('#endBtn') && ($('#endBtn').onclick = async () => {
    const r = await guard(() => H.session.end({ id: state.currentId, sessionId: state.session.id }), '生成复盘报告…');
    if (r) {
      state.session.readonly = true;
      renderChat(el, sessions, r.report);
      toast('演练已结束', 'ok');
    }
  });
  $('#backScn').onclick = () => { state.session = null; viewRehearsal(el); };
}

function chatBubble(m) {
  if (m.role === 'system') return `<div class="chat-msg sys"><div class="bubble">${esc(m.content)}</div></div>`;
  const cls = m.role === 'twin' ? 'twin' : 'user';
  const who = m.role === 'twin' ? '她（孪生）' : '你';
  return `<div class="chat-msg ${cls}"><div><div class="who">${who}</div><div class="bubble">${esc(m.content)}</div></div></div>`;
}
function appendBubble(m) {
  const scroll = $('#chatScroll');
  if (!scroll) return;
  scroll.insertAdjacentHTML('beforeend', chatBubble(m));
  scroll.scrollTop = scroll.scrollHeight;
}

/* ---------------- 视图：校准闭环 ---------------- */
async function viewCalibration(el) {
  const [preds, attrs, stats] = await Promise.all([
    H.loop.predictions({ id: state.currentId }).catch(() => null),
    H.loop.attributions({ id: state.currentId }).catch(() => null),
    H.stats({ id: state.currentId }),
  ]);
  if (!preds || !attrs || !stats) return;
  el.innerHTML = `
    <div class="page-head">
      <div class="page-title">校准闭环</div>
      <div class="page-desc">核心循环：<b>预测冻结 → 现实回流 → 差异归因 → 卡片更新</b>。AI 的扮演是一次预测，她的真实反应是真值，差值就是学习信号。</div>
    </div>
    <div class="stat-row mb14">
      <div class="stat-card amber"><div class="stat-num">${pct(stats.hitRateTop1)}</div><div class="stat-label">Top1 命中率（${stats.attributions} 次归因）</div></div>
      <div class="stat-card jade"><div class="stat-num">${pct(stats.hitRateTop2)}</div><div class="stat-label">Top2 命中率</div></div>
      <div class="stat-card blue"><div class="stat-num">${pct(stats.loopCompletion)}</div><div class="stat-label">闭环完成率（${stats.feedbacks}/${stats.predictions}）</div></div>
      <div class="stat-card violet"><div class="stat-num">${stats.openPredictions}<span class="unit">个</span></div><div class="stat-label">待回流预测单</div></div>
    </div>
    <div class="panel">
      <div class="panel-title">预测单</div>
      ${preds.length ? preds.slice().reverse().map(p => `
        <div class="hypo-card">
          <div class="hypo-head">
            <span class="badge ${p.status === 'open' ? 'inference' : 'fact'}">${p.status === 'open' ? '待回流' : '已归因'}</span>
            <span class="muted small">冻结于 ${esc(p.frozenAt.slice(0, 16)).replace('T', ' ')}</span>
          </div>
          ${p.hypotheses.map(h => `
            <div class="mt8"><div class="flex"><span class="badge inference" style="min-width:44px;justify-content:center">${Math.round(h.prob * 100)}%</span>
            <div class="hypo-text">${esc(h.text)}</div></div>
            <div class="hypo-meta"><b>验证：</b>${esc(h.verify)}</div></div>`).join('')}
          ${p.expected ? `<div class="note mt8">预期形态：${esc(p.expected)}</div>` : ''}
          ${p.status === 'open' ? `
            <div class="mt14">
              <label class="field"><span>她在现实中的真实反应（原话优先，不要转述）</span>
                <textarea id="fb-${p.id}" placeholder="把她的实际回复原文粘贴到这里；沉默/未回复也写下来"></textarea></label>
              <button class="btn primary sm" data-fb="${p.id}">提交现实反馈并归因</button>
            </div>` : ''}
        </div>`).join('') : '<div class="muted small">还没有预测单 —— 在演练中点「冻结预测单」生成。</div>'}
    </div>
    <div class="panel">
      <div class="panel-title">归因历史</div>
      ${attrs.length ? attrs.slice().reverse().map(a => `
        <div class="list-row">
          <span class="verdict ${a.verdict}">${VERDICT_NAMES[a.verdict] || a.verdict}</span>
          <div class="grow"><div class="list-sub" style="color:var(--text)">${esc(a.analysis.slice(0, 160))}</div>
          ${a.updates && a.updates.length ? `<div class="list-sub">卡片更新：${a.updates.map(u => `${u.action === 'add' ? '＋' : u.action === 'update' ? '✎' : '↓'}${esc((u.text || '').slice(0, 40))}`).join('；')}</div>` : ''}</div>
          <span class="muted small">${esc(a.createdAt.slice(0, 10))}</span>
        </div>`).join('') : '<div class="muted small">暂无归因记录。</div>'}
    </div>
  `;
  el.querySelectorAll('[data-fb]').forEach(btn => {
    btn.onclick = async () => {
      const raw = $(`#fb-${btn.dataset.fb}`).value.trim();
      if (!raw) return toast('请填写她的真实反应', 'err');
      const r = await guard(() => H.loop.feedback({ id: state.currentId, predictionId: btn.dataset.fb, raw }), '差异归因中…');
      if (r) {
        toast(`归因完成：${VERDICT_NAMES[r.record.verdict] || r.record.verdict}，卡片更新 ${r.applied.length} 处`, 'ok');
        viewCalibration(el);
      }
    };
  });
}

/* ---------------- 视图：设置 ---------------- */
async function viewSettings(el) {
  const [s, info] = await Promise.all([H.settings.get(), H.appInfo()]);
  state.settings = s;
  el.innerHTML = `
    <div class="page-head">
      <div class="page-title">设置</div>
      <div class="page-desc">模型调用完全在本地发起，API Key 只保存在本机。演示模式无需任何配置即可体验全部流程。</div>
    </div>
    <div class="panel">
      <div class="panel-title">模型服务</div>
      <label class="field"><span>Provider</span><select id="stProvider">
        <option value="mock" ${s.provider === 'mock' ? 'selected' : ''}>演示模式（离线内置样例）</option>
        <option value="openai" ${s.provider === 'openai' ? 'selected' : ''}>OpenAI 兼容接口</option>
      </select></label>
      <div id="openaiCfg" class="${s.provider === 'openai' ? '' : 'hidden'}">
        <label class="field"><span>API 地址（Base URL）</span><input type="text" id="stUrl" value="${esc(s.baseUrl)}" placeholder="https://api.openai.com/v1 或任意兼容网关"></label>
        <label class="field"><span>API Key</span><input type="password" id="stKey" value="${esc(s.apiKey)}" placeholder="sk-…"></label>
        <label class="field"><span>模型</span><input type="text" id="stModel" value="${esc(s.model)}" placeholder="gpt-4o-mini / deepseek-chat / …"></label>
      </div>
      <div class="flex mt8">
        <button class="btn primary" id="stSave">保存</button>
        <button class="btn" id="stTest">测试连接</button>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">数据与隐私</div>
      <div class="report small">
        <ul>
          <li>数据目录：<code>${esc(info.dataDir)}</code>（仅本机，不上传任何数据）</li>
          <li>平台：${esc(info.platform)} · 版本 v${esc(info.version)}</li>
          <li>删除人物档案时，其全部数据同步删除。</li>
        </ul>
      </div>
      <div class="note warn mt8">红线：分析真实第三方涉及隐私，档案仅限本人查看，不对外共享，不用于伤害性用途；引擎内置拒绝操控类请求。</div>
    </div>
  `;
  $('#stProvider').onchange = () => $('#openaiCfg').classList.toggle('hidden', $('#stProvider').value !== 'openai');
  $('#stSave').onclick = async () => {
    const patch = { provider: $('#stProvider').value };
    if (patch.provider === 'openai') {
      patch.baseUrl = $('#stUrl').value.trim();
      patch.apiKey = $('#stKey').value.trim();
      patch.model = $('#stModel').value.trim();
    }
    await H.settings.set(patch);
    state.settings = await H.settings.get();
    updateModeChip();
    toast('已保存', 'ok');
  };
  $('#stTest').onclick = async () => {
    const r = await guard(() => H.settings.test(), '测试中…');
    if (r) toast('连接正常：' + r.reply, 'ok');
  };
}

function updateModeChip() {
  const chip = $('#modeChip');
  if (state.settings && state.settings.provider === 'openai') {
    chip.textContent = 'OpenAI 兼容 · ' + (state.settings.model || '未设置模型');
    chip.style.color = 'var(--jade)';
  } else {
    chip.textContent = '演示模式（离线）';
    chip.style.color = '';
  }
}

/* ---------------- 路由 ---------------- */
const VIEWS = { home: viewHome, card: viewCard, evidence: viewEvidence, import: viewImport, interview: viewInterview, rehearsal: viewRehearsal, calibration: viewCalibration, settings: viewSettings };

async function render() {
  const el = $('#main');
  const fn = VIEWS[state.view] || viewHome;
  try { await fn(el); } catch (err) { el.innerHTML = `<div class="empty"><div class="empty-title">加载失败</div><p>${esc(err.message)}</p></div>`; }
  updateModeChip();
}

(async function init() {
  state.settings = await H.settings.get().catch(() => null);
  updateModeChip();
  renderNav();
  render();
})();
