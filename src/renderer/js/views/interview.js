'use strict';
/* 演练 · 视图：24 问（逐题作答 + 追问 + 中途总结 + 最终整合写卡） */
(() => {
  const HB = window.HB;
  const { $, esc, toast, guard, modal, closeModal, md } = HB.ui;
  const H = HB.H;
  const state = HB.state;
  const { LAYER_NAMES } = HB.C;

  async function viewInterview(el) {
    const st = await guard(() => H.interview.state({ id: state.currentId }), '加载中…');
    if (!st) return;
    state.interview = st;
    const doneCount = Object.keys(st.records).length;
    const q = st.questions.find(x => x.qid === st.currentQ);
    const currentRecord = q ? st.records[q.qid] : null;
    el.innerHTML = `
      <div class="page-head">
        <div class="page-title">24 问</div>
        <div class="page-desc">围绕 <b>24 个正式问题</b>逐步整理你对她的观察。它帮你把"说不上来的直觉"变成可验证的结构；追问不限次数。结果以<b>用户陈述</b>写入理解卡，并在对照复盘中优先被现实验证。</div>
      </div>
      <div class="stat-row mb14">
        <div class="stat-card violet" data-glow><div class="stat-num">${doneCount}<span class="unit">/ 24</span></div><div class="stat-label">已完成问题</div></div>
        <div class="stat-card jade" data-glow><div class="stat-num">${st.final ? '✓' : pct(doneCount / 24)}</div><div class="stat-label">访谈进度${st.final ? ' · 已完成整合' : ''}</div></div>
      </div>
      <div class="bar mb14 ${st.final ? 'jade' : ''}" aria-hidden="true"><i style="width:${Math.round(doneCount / 24 * 100)}%"></i></div>
      ${!st.started && !doneCount ? `
        <div class="panel" data-glow><div class="empty">
          <div class="empty-icon">◌</div>
          <div class="empty-title">从 Q1 开始</div>
          <p>建议在安静的时候做：回忆比想象可靠。中途可以随时「总结」，也可以「跳过」你说不准的问题——留白不是缺陷。</p>
          <button class="btn primary" id="ivStart">开始访谈</button>
        </div></div>` : `
        ${q ? `
        <div class="panel hairline-top" data-glow>
          <div class="panel-title">${esc(q.group)} · Q${String(q.qid).padStart(2, '0')} <span class="muted small" style="font-weight:400">${doneCount}/24</span></div>
          <div style="font-size:15.5px;line-height:1.7;margin:8px 0 4px">${esc(q.text)}</div>
          <div class="muted small">${esc(q.hint || '')}</div>
          <label class="field mt14"><span>你的回答（越具体越好 · Ctrl+Enter 提交）</span>
            <textarea id="ivAns" placeholder="她具体会怎么做？最近一次让你产生这种感觉是发生了什么？">${esc(currentRecord && currentRecord.answer || '')}</textarea></label>
          <div id="ivProbeBox"></div>
          <div class="flex mt8">
            <button class="btn primary" id="ivSubmit">提交回答</button>
            <button class="btn ghost" id="ivSkip">跳过（暂未确定）</button>
            <span class="flex-grow"></span>
            <button class="btn ghost sm" id="ivSummary">中途总结</button>
          </div>
        </div>` : `
        <div class="panel" data-glow><div class="empty">
          <div class="empty-icon">✓</div>
          <div class="empty-title">24 问已全部完成</div>
          <p>点击下方生成最终整合，然后选择要写入理解卡的条目。</p>
          <button class="btn primary" id="ivFinal">生成最终整合</button>
        </div></div>`}
        ${st.final ? finalPanel(st.final, st.suggestions) : ''}
        ${st.summaries && st.summaries.length ? `<div class="panel" data-glow><div class="panel-title">中途小结（最近一次）</div>${md(st.summaries[st.summaries.length - 1].text)}</div>` : ''}
        <div class="panel" data-glow><div class="panel-title">已回答记录</div>
          ${doneCount ? Object.keys(st.records).map(Number).sort((a, b) => a - b).map(qid => {
            const r = st.records[qid];
            return `<div class="list-row"><span class="badge plain">Q${String(qid).padStart(2, '0')}</span>
              <div class="grow"><div class="list-title">${esc((r.answer || '（暂未确定）').slice(0, 90))}</div>
              ${r.probeAnswer ? `<div class="list-sub">追问：${esc(r.probeAnswer.slice(0, 80))}</div>` : ''}</div></div>`;
          }).join('') : '<div class="muted small">还没有记录。</div>'}
        </div>`}
    `;
    const qid = st.currentQ;
    const ivAns = $('#ivAns');
    if (ivAns) {
      ivAns.focus();
      ivAns.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'Enter') submit(false); });
    }
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
          if (r2 && state.view === 'interview') viewInterview(el);
        };
      } else if (state.view === 'interview') viewInterview(el);
    };
    $('#ivSubmit') && ($('#ivSubmit').onclick = () => submit(false));
    $('#ivSkip') && ($('#ivSkip').onclick = () => submit(true));
    $('#ivStart') && ($('#ivStart').onclick = async () => {
      const ok = await guard(() => H.interview.start({ id: state.currentId }), '开启访谈…');
      if (ok) viewInterview(el);
    });
    $('#ivSummary') && ($('#ivSummary').onclick = async () => {
      const r = await guard(() => H.interview.summary({ id: state.currentId }), '整理中…');
      if (r) { modal(`<h3>中途小结</h3>${md(r)}<div class="modal-ops"><button class="btn ghost" id="mCancel">关闭</button></div>`); $('#mCancel').onclick = closeModal; }
    });
    $('#ivFinal') && ($('#ivFinal').onclick = async () => {
      const r = await guard(() => H.interview.finalize({ id: state.currentId }), '生成最终整合…');
      if (r) { toast('整合完成，请勾选要写入理解卡的条目', 'ok'); viewInterview(el); }
    });
  }

  function pct(v) { return v == null ? '—' : Math.round(v * 100) + '%'; }

  function finalPanel(final, suggestions) {
    return `
      <div class="panel hairline-top" data-glow>
        <div class="panel-title">最终整合 <span class="muted small" style="font-weight:400">${esc(final.ts.slice(0, 10))}</span></div>
        ${md(final.text)}
      </div>
      <div class="panel" data-glow>
        <div class="panel-title">写入理解卡</div>
        <div class="panel-sub">勾选你认为可靠的条目。<b>用户陈述 ≠ 她的事实</b> —— 写入的条目会在对照复盘中优先被现实验证。</div>
        ${suggestions.map((s, i) => `
          <label class="list-row" style="cursor:pointer">
            <input type="checkbox" data-sug="${i}" ${s.written ? 'disabled checked' : ''} style="width:16px;height:16px;flex:0 0 auto">
            <div class="grow"><div class="list-title" style="${s.written ? 'opacity:.5' : ''}">${esc(s.text)}</div>
            <div class="list-sub">${LAYER_NAMES[s.layer]} · ${s.kind === 'fact' ? '用户确定的事实' : '高可能推论'}${s.written ? ' · 已写入' : ''}</div></div>
          </label>`).join('')}
        <button class="btn primary mt8" id="ivWrite">写入勾选条目</button>
      </div>`;
  }

  // 勾选写卡（事件委托，跨渲染存活）
  document.addEventListener('click', async (e) => {
    const cb = e.target.closest('[data-sug]');
    if (cb) return; // checkbox 原生行为
    const btn = e.target.closest('#ivWrite');
    if (btn) {
      const boxes = [...document.querySelectorAll('[data-sug]')].filter(x => x.checked && !x.disabled);
      const idx = boxes.map(x => Number(x.dataset.sug));
      if (!idx.length) return toast('请先勾选条目', 'err');
      const r = await guard(() => H.interview.writeClaims({ id: state.currentId, indexes: idx }), '写入中…');
      if (r) { toast(`已写入 ${r.written.length} 条到理解卡`, 'ok'); viewInterview(document.getElementById('main')); }
    }
  });

  HB.views = HB.views || {};
  HB.views.interview = viewInterview;
})();
