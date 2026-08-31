'use strict';
/* 彩排 · 视图：彩排（场景选择 + TA 的模拟对话 + 预测冻结 + 复盘报告） */
(() => {
  const HB = window.HB;
  const { $, esc, toast, guard, modal, closeModal, md } = HB.ui;
  const H = HB.H;
  const state = HB.state;
  const { SCENARIOS } = HB.C;

  async function viewRehearsal(el) {
    const sessions = await guard(() => H.session.list({ id: state.currentId }), '加载中…');
    if (!sessions) return;
    if (state.session) return renderChat(el, sessions);
    el.innerHTML = `
      <div class="page-head">
        <div class="page-title">彩排沙盒</div>
        <div class="page-desc">在TA 的模拟身上<b>彩排重要对话</b>。她由理解卡生成——卡片越准，她越像。彩排结束后可写下预判，等你拿到她的真实反应，回「对照复盘」对照学习。</div>
      </div>
      <div class="panel hairline-top" data-glow>
        <div class="panel-title">选择场景</div>
        <div class="chips mb14" id="scnChips">
          ${SCENARIOS.map((s, i) => `<span class="chip ${i === 0 ? 'active' : ''}" data-scn="${i}">${s.label}</span>`).join('')}
        </div>
        <label class="field"><span>情境设定（她也能感知到的客观情境）</span>
          <textarea id="scnText" placeholder="最近发生了什么、你们的关系阶段、这次对话的场合…"></textarea></label>
        <label class="field"><span>彩排目标（只有复盘教练看得到，她不知道）</span>
          <textarea id="scnGoal" style="min-height:56px" placeholder="你这次想达成什么？例如：弄清她最近的疏远是不是因为我的话；练习接住拒绝"></textarea></label>
        <div class="note">红线提醒：本工具不提供操控、打压类策略；彩排的目的是更诚实地表达与更好地理解。</div>
        <div class="mt14"><button class="btn primary btn-beam" id="scnStart">开始彩排</button></div>
      </div>
      <div class="panel" data-glow>
        <div class="panel-title">历史彩排</div>
        ${sessions.length ? sessions.slice().reverse().map(s => `
          <div class="list-row">
            <span class="badge ${s.status === 'active' ? 'inference' : 'fact'}">${s.status === 'active' ? '进行中' : '已结束'}</span>
            <div class="grow"><div class="list-title">${esc(s.scenario || '未命名场景')}</div>
            <div class="list-sub">${esc(s.createdAt.slice(0, 16)).replace('T', ' ')} · ${s.turns} 轮</div></div>
            <button class="btn sm ghost" data-view="${s.id}">查看</button>
          </div>`).join('') : '<div class="muted small">还没有彩排记录。</div>'}
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
      const goal = $('#scnGoal').value.trim();
      const r = await guard(() => H.session.start({ id: state.currentId, scenario, goal }), '模拟生成中…她正在上场');
      if (r) {
        state.session = { id: r.sessionId, messages: r.messages };
        state.sessionScenario = scenario;
        state.sessionGoal = goal;
        const nRecall = (r.recalled || []).length;
        toast('彩排开始' + (nRecall ? `（她想起了 ${nRecall} 段相关往事）` : ''), 'ok');
        renderChat(el, sessions);
      }
    };
    el.querySelectorAll('[data-view]').forEach(btn => {
      btn.onclick = async () => {
        const r = await guard(() => H.session.get({ id: state.currentId, sessionId: btn.dataset.view }), '加载中…');
        if (!r) return;
        state.session = { id: r.session.id, messages: r.session.messages, readonly: r.session.status === 'ended' };
        state.sessionScenario = r.session.scenario;
        state.sessionGoal = r.session.goal || '';
        renderChat(el, sessions, r.report);
      };
    });
  }

  function renderChat(el, sessions, report) {
    el.innerHTML = `
      <div class="page-head">
        <div class="page-title">彩排中 <span class="muted small" style="font-weight:400">${state.session.readonly ? '· 只读回放' : ''}</span></div>
        <div class="page-desc">${esc((state.sessionScenario || '未命名场景').slice(0, 120))}</div>
      </div>
      <div class="panel hairline-top">
        <div class="chat-wrap">
          <div class="chat-scroll" id="chatScroll">
            ${state.session.messages.map(m => chatBubble(m)).join('')}
          </div>
          ${state.session.readonly ? (report ? '' : `
          <div class="flex mt14">
            <button class="btn sm primary" id="regenReportBtn">重新生成复盘</button>
            <span class="muted small">上次复盘生成失败（会话已保留），可重试。</span>
          </div>`) : `
          <div class="chat-input">
            <input type="text" id="chatText" placeholder="说点什么…（她按理解卡回应）" maxlength="2000">
            <button class="btn primary" id="chatSend">发送</button>
          </div>
          <div class="flex mt14">
            <button class="btn sm" id="freezeBtn">写下预判</button>
            <button class="btn sm" id="endBtn">结束并生成复盘</button>
            <span class="muted small">结束彩排前可写下预判 = 对"她现实中会如何回应"的多假设快照；之后到「对照复盘」录入她的真实反应。</span>
          </div>`}
        </div>
      </div>
      ${report ? `<div class="panel" data-glow><div class="panel-title">复盘报告</div>${md(report)}</div>` : ''}
      <div class="mt14"><button class="btn ghost sm" id="backScn">← 返回场景列表</button></div>
    `;
    const scroll = $('#chatScroll');
    scroll.scrollTop = scroll.scrollHeight;
    const input = $('#chatText');
    input && input.focus();
    const setPending = (pending) => {
      if ($('#chatSend')) $('#chatSend').disabled = pending;
      if ($('#chatText')) $('#chatText').disabled = pending;
      const tip = $('#typingIndicator');
      if (tip) tip.remove();
      if (pending) {
        scroll.insertAdjacentHTML('beforeend',
          `<div class="chat-msg twin" id="typingIndicator"><div><div class="who">她（模拟）</div><div class="bubble typing"><span></span><span></span><span></span></div></div></div>`);
        scroll.scrollTop = scroll.scrollHeight;
      }
    };
    const send = async () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      state.session.messages.push({ role: 'user', content: text, ts: new Date().toISOString() });
      appendBubble({ role: 'user', content: text });
      setPending(true);
      let r = null;
      try {
        r = await H.session.send({ id: state.currentId, sessionId: state.session.id, text });
      } catch (err) {
        toast(err.message || String(err), 'err');
      } finally {
        setPending(false);
        input.focus();
      }
      if (!r) {
        // 失败回滚：用户消息未落盘，从界面与会话状态中撤回
        state.session.messages.pop();
        removeLastBubble('user');
        input.value = text;
        return;
      }
      if (r.blocked) {
        // 红线拦截：撤回用户消息（未入库），显示系统提示
        state.session.messages.pop();
        removeLastBubble('user');
        input.value = text;
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
      const r = await guard(() => H.loop.freeze({ id: state.currentId, sessionId: state.session.id }), '生成预判…');
      if (r) {
        modal(`<h3>预判已冻结</h3>
          ${r.prediction.hypotheses.map(h => `
            <div class="hypo-card">
              <div class="hypo-head"><span class="badge inference">${Math.round(h.prob * 100)}%</span>
                <div class="hypo-text">${esc(h.text)}</div></div>
              <div class="hypo-meta"><b>依据：</b>${esc(h.basis)}<br><b>验证：</b>${esc(h.verify)}</div>
            </div>`).join('')}
          <div class="note">预期形态：${esc(r.prediction.expected)}</div>
          <div class="modal-ops"><button class="btn ghost" id="mCancel">关闭</button><button class="btn primary" id="mGo">去对照复盘</button></div>`);
        $('#mCancel').onclick = closeModal;
        $('#mGo').onclick = () => { closeModal(); state.session = null; HB.router.go('calibration'); };
      }
    });
    $('#endBtn') && ($('#endBtn').onclick = async () => {
      const r = await guard(() => H.session.end({ id: state.currentId, sessionId: state.session.id }), '生成复盘报告…');
      if (r) {
        state.session.readonly = true;
        renderChat(el, sessions, r.report);
        toast('彩排已结束' + (r.memoryNote ? '，' + r.memoryNote : ''), 'ok');
      }
    });
    $('#regenReportBtn') && ($('#regenReportBtn').onclick = async () => {
      const r = await guard(() => H.session.end({ id: state.currentId, sessionId: state.session.id }), '重新生成复盘报告…');
      if (r) renderChat(el, sessions, r.report);
    });
    $('#backScn').onclick = () => { state.session = null; viewRehearsal(el); };
  }

  function chatBubble(m) {
    if (m.role === 'system') return `<div class="chat-msg sys"><div class="bubble">${esc(m.content)}</div></div>`;
    const cls = m.role === 'twin' ? 'twin' : 'user';
    const who = m.role === 'twin' ? '她（模拟）' : '你';
    return `<div class="chat-msg ${cls}"><div><div class="who">${who}</div><div class="bubble">${esc(m.content)}</div></div></div>`;
  }
  function appendBubble(m) {
    const scroll = $('#chatScroll');
    if (!scroll) return;
    scroll.insertAdjacentHTML('beforeend', chatBubble(m));
    scroll.scrollTop = scroll.scrollHeight;
  }
  function removeLastBubble(role) {
    const scroll = $('#chatScroll');
    if (!scroll) return;
    const msgs = scroll.querySelectorAll('.chat-msg.' + role);
    if (msgs.length) msgs[msgs.length - 1].remove();
  }

  HB.views = HB.views || {};
  HB.views.rehearsal = viewRehearsal;
})();
