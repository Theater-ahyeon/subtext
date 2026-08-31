'use strict';
/* 生境沙盒 · 视图：深度分析（对 TA 的完整分析 / 对场景的推演分析） */
(() => {
  const HB = window.HB;
  const { $, esc, toast, guard, md } = HB.ui;
  const H = HB.H;
  const state = HB.state;

  let mode = 'person';
  let scenarioDraft = '';

  /** 原话库近 12 个月分布（本地统计，无网络） */
  function histogram(b) {
    const now = new Date();
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
    }
    const counts = months.map(ym => b.evidence.filter(e => (e.ts || e.createdAt || '').slice(0, 7) === ym).length);
    const max = Math.max(1, ...counts);
    return { months, counts, max };
  }

  function statRow(b, stats) {
    const mem = stats.memories || 0;
    return `
      <div class="stat-row mb14">
        <div class="stat-card violet" data-glow><div class="stat-num">${stats.evidence}<span class="unit">条</span></div><div class="stat-label">原话库素材</div></div>
        <div class="stat-card jade" data-glow><div class="stat-num">${stats.claims}<span class="unit">条</span></div><div class="stat-label">理解卡条目</div></div>
        <div class="stat-card blue" data-glow><div class="stat-num">${stats.sessions}<span class="unit">场</span></div><div class="stat-label">彩排场次</div></div>
        <div class="stat-card amber" data-glow><div class="stat-num">${mem}<span class="unit">段</span></div><div class="stat-label">事件记忆</div></div>
      </div>`;
  }

  function histoHtml(b) {
    const { months, counts, max } = histogram(b);
    return `
      <div class="panel" data-glow>
        <div class="panel-title">原话库近 12 个月分布</div>
        <div class="histo">
          ${months.map((m, i) => `<div class="hcol" title="${m}：${counts[i]} 条"><i style="height:${Math.max(3, Math.round(counts[i] / max * 84))}px"></i><span>${m.slice(5)}</span></div>`).join('')}
        </div>
      </div>`;
  }

  function personBody(b, stats) {
    return `
      ${statRow(b, stats)}
      ${histoHtml(b)}
      <div class="panel hairline-top" data-glow>
        <div class="panel-title">生成完整分析</div>
        <div class="panel-sub">汇总理解卡、原话库、事件记忆与对照复盘数据，输出一份完整的人物分析报告（画像 / 证据质量 / 沟通模式 / 模拟与现实 / 认知盲区 / 建议）。分析是行为推测，不是诊断。</div>
        <button class="btn primary btn-beam" id="anaPerson">生成对 TA 的完整分析</button>
      </div>
      <div id="anaReport"></div>`;
  }

  function scenarioBody(b, sessions) {
    return `
      <div class="panel hairline-top" data-glow>
        <div class="panel-title">场景描述</div>
        <label class="field"><span>要分析的场景（最近发生了什么、你们的关系阶段、这次对话的场合…）</span>
          <textarea id="anaScn" style="min-height:96px" placeholder="例如：她最近两周回复变慢，我想约她周末出来，把这段关系往前推一步">${esc(scenarioDraft)}</textarea></label>
        <div class="note">推演会检索事件记忆里的相关往事、汇总同类彩排与对照数据，给出 2~3 条反应路径（带可能性）、你的最优策略与风险提醒。</div>
        <div class="mt14"><button class="btn primary btn-beam" id="anaScnGo">生成场景推演</button></div>
      </div>
      ${sessions.length ? `
      <div class="panel" data-glow>
        <div class="panel-title">历史彩排 <span class="muted small" style="font-weight:400">${sessions.length} 场</span></div>
        ${sessions.slice().reverse().slice(0, 5).map(s => `
          <div class="list-row"><span class="badge ${s.status === 'active' ? 'inference' : 'fact'}">${s.status === 'active' ? '进行中' : '已结束'}</span>
          <div class="grow"><div class="list-title">${esc(s.scenario || '未命名场景').slice(0, 60)}</div>
          <div class="list-sub">${esc(s.createdAt.slice(0, 16)).replace('T', ' ')} · ${s.turns} 轮</div></div></div>`).join('')}
      </div>` : ''}
      <div id="anaReport"></div>`;
  }

  function bindPerson(el, b, stats) {
    $('#anaPerson').onclick = async () => {
      const btn = $('#anaPerson');
      btn.disabled = true;
      const r = await guard(() => H.analysis.person({ id: b.id }), '分析中…汇总理解卡与全部记忆');
      btn.disabled = false;
      if (!r) return;
      $('#anaReport').innerHTML = `<div class="panel hairline-top" data-glow><div class="panel-title">完整分析报告 <span class="muted small" style="font-weight:400">${new Date().toISOString().slice(0, 16).replace('T', ' ')}</span></div>${md(r.report)}</div>`;
    };
  }

  function bindScenario(el, b, sessions) {
    const ta = $('#anaScn');
    ta.addEventListener('input', () => { scenarioDraft = ta.value; });
    $('#anaScnGo').onclick = async () => {
      const scenario = ta.value.trim();
      if (!scenario) return toast('请先填写场景', 'err');
      const btn = $('#anaScnGo');
      btn.disabled = true;
      const r = await guard(() => H.analysis.scenario({ id: b.id, scenario }), '推演中…检索相关往事');
      btn.disabled = false;
      if (!r) return;
      const recalled = r.recalled || [];
      $('#anaReport').innerHTML = `
        ${recalled.length ? `<div class="note mt14">已检索到 <b>${recalled.length}</b> 段相关往事：${recalled.slice(0, 3).map(m => esc(m.text.slice(0, 40))).join('；')}…</div>` : '<div class="note mt14">事件记忆中没有与该场景直接相关的往事 —— 报告会基于理解卡推演。</div>'}
        <div class="panel hairline-top" data-glow><div class="panel-title">场景推演报告 <span class="muted small" style="font-weight:400">${new Date().toISOString().slice(0, 16).replace('T', ' ')}</span></div>${md(r.report)}</div>
        <div class="mt14 flex"><button class="btn primary" id="anaStart">以此场景开始彩排</button><span class="muted small">开场时她会自动想起上面检索到的相关往事</span></div>`;
      $('#anaStart').onclick = async () => {
        const res = await guard(() => H.session.start({ id: b.id, scenario, goal: '' }), '模拟生成中…她正在上场');
        if (res) {
          state.session = { id: res.sessionId, messages: res.messages };
          state.sessionScenario = scenario;
          state.sessionGoal = '';
          toast('彩排开始' + ((res.recalled || []).length ? `（她想起了 ${(res.recalled || []).length} 段相关往事）` : ''), 'ok');
          state.session = null; // 回到彩排页让用户确认场景配置
          HB.router.go('rehearsal');
        }
      };
    };
  }

  async function viewAnalysis(el) {
    const b = await guard(() => H.persons.get({ id: state.currentId }), '加载中…');
    if (!b) return;
    const stats = await guard(() => H.stats({ id: b.id }), '加载中…');
    if (!stats) return;
    const sessions = await guard(() => H.session.list({ id: b.id }), '加载中…');
    el.innerHTML = `
      <div class="page-head">
        <div class="page-title">深度分析 <span class="muted small" style="font-weight:400">${esc(b.name)}</span></div>
        <div class="page-desc">汇总理解卡、原话库、事件记忆与对照复盘数据，对<b>这个人</b>或<b>某个具体场景</b>做完整分析。分析是行为推测，不是诊断；材料不足处会明说。</div>
      </div>
      <div class="chips mb14">
        <span class="chip ${mode === 'person' ? 'active' : ''}" data-amode="person">对 TA 的完整分析</span>
        <span class="chip ${mode === 'scenario' ? 'active' : ''}" data-amode="scenario">对场景的推演分析</span>
      </div>
      <div id="anaBody">${mode === 'person' ? personBody(b, stats) : scenarioBody(b, sessions || [])}</div>
    `;
    el.querySelectorAll('[data-amode]').forEach(chip => {
      chip.onclick = () => { mode = chip.dataset.amode; viewAnalysis(el); };
    });
    if (mode === 'person') bindPerson(el, b, stats);
    else bindScenario(el, b, sessions || []);
  }

  HB.views = HB.views || {};
  HB.views.analysis = viewAnalysis;
})();
