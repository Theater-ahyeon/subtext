'use strict';
/* 生境沙盒 · 视图：深度分析（对 TA 的完整分析 / 对场景的推演分析） */
(() => {
  const HB = window.HB;
  const { $, esc, toast, guard, md } = HB.ui;
  const H = HB.H;
  const state = HB.state;

  let mode = 'person';
  let scenarioDraft = '';
  let lastDigest = null;
  let anaHistory = [];

  /** 原话库洞察（第一性：把已存证据转化为统计洞察，全部本地计算） */
  function computeInsights(b) {
    const items = b.evidence.filter(e => e.ts && e.ts.includes('T')).sort((a, c) => a.ts.localeCompare(c.ts));
    const hours = new Array(24).fill(0);
    for (const e of items) {
      const h = Number(e.ts.slice(11, 13));
      if (!isNaN(h)) hours[h]++;
    }
    // 会话片段：间隔超过 6 小时视为新片段，片段首条 = 发起者
    const GAP = 6 * 3600 * 1000;
    const segs = [];
    let cur = null, lastTs = 0;
    for (const e of items) {
      const t = Date.parse(e.ts);
      if (isNaN(t)) continue;
      if (!cur || t - lastTs > GAP) { cur = { init: e.isSelf, n: 1 }; segs.push(cur); }
      else cur.n++;
      lastTs = t;
    }
    const multi = segs.filter(s => s.n >= 2);
    const taInit = multi.filter(s => s.init === false).length;
    const meInit = multi.filter(s => s.init === true).length;
    // 回复间隔：发送者切换处的间隔（分钟），限 24 小时内
    const gaps = [];
    for (let i = 1; i < items.length; i++) {
      if (items[i].isSelf !== null && items[i - 1].isSelf !== null && items[i].isSelf !== items[i - 1].isSelf) {
        const g = (Date.parse(items[i].ts) - Date.parse(items[i - 1].ts)) / 60000;
        if (g >= 0 && g < 1440) gaps.push(g);
      }
    }
    const med = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : null;
    const avgLen = (isSelf) => {
      const arr = items.filter(e => e.isSelf === isSelf && e.text);
      return arr.length ? Math.round(arr.reduce((s, e) => s + e.text.length, 0) / arr.length) : null;
    };
    return {
      dated: items.length, total: b.evidence.length, hours,
      segCount: multi.length, taInit, meInit,
      medGap: med, taLen: avgLen(false), meLen: avgLen(true),
    };
  }

  function insightsHtml(ins) {
    if (ins.dated < 3) return '';
    const peak = ins.hours.indexOf(Math.max(...ins.hours));
    const fmtGap = ins.medGap == null ? '—' : (ins.medGap < 60 ? Math.round(ins.medGap) + ' 分钟' : (ins.medGap / 60).toFixed(1) + ' 小时');
    return `
      <div class="panel" data-glow>
        <div class="panel-title">原话库洞察 <span class="muted small" style="font-weight:400">${ins.dated}/${ins.total} 条有时间戳</span></div>
        <div class="stat-row mb14">
          <div class="stat-card violet" data-glow><div class="stat-num">${ins.taInit}<span class="unit">/${ins.segCount}</span></div><div class="stat-label">TA 先开口的会话片段</div></div>
          <div class="stat-card blue" data-glow><div class="stat-num">${fmtGap}</div><div class="stat-label">TA 回复间隔中位数</div></div>
          <div class="stat-card jade" data-glow><div class="stat-num">${ins.taLen == null ? '—' : ins.taLen}<span class="unit">字</span></div><div class="stat-label">TA 平均消息长度</div></div>
          <div class="stat-card amber" data-glow><div class="stat-num">${ins.meLen == null ? '—' : ins.meLen}<span class="unit">字</span></div><div class="stat-label">我平均消息长度</div></div>
        </div>
        <div class="panel-sub">TA 消息的高峰时段：<b>${String(peak).padStart(2, '0')}:00 前后</b>（按时间戳小时统计；间隔超过 6 小时视为新会话片段）</div>
        <div class="histo">
          ${ins.hours.map((c, h) => `<div class="hcol" title="${String(h).padStart(2, '0')}:00 — ${c} 条"><i style="height:${Math.max(3, Math.round(c / Math.max(1, Math.max(...ins.hours))) * 60)}px"></i><span>${h % 3 === 0 ? String(h).padStart(2, '0') : ''}</span></div>`).join('')}
        </div>
      </div>`;
  }

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
        <div class="stat-card blue" data-glow><div class="stat-num">${stats.sessions}<span class="unit">场</span></div><div class="stat-label">演练场次</div></div>
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
    const ins = computeInsights(b);
    return `
      ${statRow(b, stats)}
      ${insightsHtml(ins)}
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
        <div class="note">推演会检索事件记忆里的相关往事、汇总同类演练与对照数据，给出 2~3 条反应路径（带可能性）、你的最优策略与风险提醒。</div>
        <div class="mt14"><button class="btn primary btn-beam" id="anaScnGo">生成场景推演</button></div>
      </div>
      ${sessions.length ? `
      <div class="panel" data-glow>
        <div class="panel-title">历史演练 <span class="muted small" style="font-weight:400">${sessions.length} 场</span></div>
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
      lastDigest = r.digest || null;
      anaHistory = [];
      $('#anaReport').innerHTML = `
        <div class="panel hairline-top" data-glow>
          <div class="panel-title">完整分析报告 <span class="muted small" style="font-weight:400">${new Date().toISOString().slice(0, 16).replace('T', ' ')}</span></div>
          ${md(r.report)}
        </div>
        <div class="panel" data-glow>
          <div class="panel-title">继续追问</div>
          <div class="panel-sub">基于同一份本地数据与上面的报告继续提问（例如："TA 为什么回避冲突？""帮我规划下次聊什么"）。</div>
          <div id="anaQA"></div>
          <div class="flex">
            <input type="text" id="anaQ" placeholder="追问…" maxlength="500" style="flex:1">
            <button class="btn primary" id="anaQGo">发送</button>
          </div>
        </div>`;
      $('#anaQGo').onclick = ask;
      $('#anaQ').addEventListener('keydown', e => { if (e.key === 'Enter') ask(); });
    };
    async function ask() {
      const q = $('#anaQ').value.trim();
      if (!q) return toast('请输入追问', 'err');
      const btn = $('#anaQGo'), input = $('#anaQ');
      btn.disabled = true;
      const r = await guard(() => H.analysis.followUp({ id: b.id, digest: lastDigest, history: anaHistory, question: q }), '分析中…');
      btn.disabled = false;
      if (!r) return;
      anaHistory.push({ q, a: r.answer });
      input.value = '';
      $('#anaQA').insertAdjacentHTML('beforeend',
        `<div class="list-row"><span class="badge plain">问</span><div class="grow"><div class="list-title">${esc(q)}</div></div></div>
         <div class="panel" data-glow style="margin-bottom:12px">${md(r.answer)}</div>`);
      const qa = $('#anaQA');
      qa.scrollTop = qa.scrollHeight;
      qa.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
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
        <div class="mt14 flex"><button class="btn primary" id="anaStart">以此场景开始演练</button><span class="muted small">开场时她会自动想起上面检索到的相关往事</span></div>`;
      $('#anaStart').onclick = async () => {
        const res = await guard(() => H.session.start({ id: b.id, scenario, goal: '' }), '模拟生成中…她正在上场');
        if (res) {
          state.session = { id: res.sessionId, messages: res.messages };
          state.sessionScenario = scenario;
          state.sessionGoal = '';
          toast('演练开始' + ((res.recalled || []).length ? `（她想起了 ${(res.recalled || []).length} 段相关往事）` : ''), 'ok');
          state.session = null; // 回到演练页让用户确认场景配置
          HB.router.go('rehearsal');
        }
      };
    };
  }

  const DOMAIN_LAYER = { '工作': 'life', '家庭': 'life', '健康': 'life', '社交': 'life', '情绪': 'temperament', '关系': 'temperament', '其他': 'life' };
  const LIKE_MAP = { high: '高', mid: '中', low: '低' };

  function unseenBody(b) {
    return `
      <div class="panel hairline-top" data-glow>
        <div class="panel-title">收到的消息</div>
        <label class="field"><span>消息原文（粘贴 TA 突然发来的消息，多条按顺序粘贴）</span>
          <textarea id="unseenMsg" style="min-height:88px" placeholder="把 TA 的原话原样粘贴到这里，不要改写"></textarea></label>
        <label class="field"><span>背景补充（可选：多久没联系、之前发生了什么、你注意到的反常之处）</span>
          <textarea id="unseenCtx" style="min-height:64px" placeholder="例如：我们已经两周没说话了，之前她回复一直很短"></textarea></label>
        <div class="note">TA 在自己的生活里活动，很多事你并不知道。分析会先用理解卡与已知事件解释；解释不通的部分，会给出「未知因素假说」——每条都带支持线索与自然求证方式。假说不是事实。</div>
        <div class="mt14"><button class="btn primary btn-beam" id="unseenGo">解读这条消息</button></div>
      </div>
      <div id="unseenReport"></div>`;
  }

  function renderUnseen(b, r) {
    const hypHtml = (r.hypotheses || []).length ? (r.hypotheses || []).map((h, i) => `
      <div class="hypo-card">
        <div class="hypo-head">
          <span class="badge ${h.likelihood === 'high' ? 'fact' : h.likelihood === 'mid' ? 'inference' : 'blank'}">${LIKE_MAP[h.likelihood] || '中'}可能</span>
          <span class="badge plain">${esc(h.domain)}</span>
          <div class="hypo-text">${esc(h.text)}</div>
        </div>
        ${h.signals ? `<div class="hypo-meta"><b>支持线索：</b>${esc(h.signals)}</div>` : ''}
        ${h.verify ? `<div class="hypo-meta"><b>自然求证：</b>${esc(h.verify)}</div>` : ''}
        <div class="flex mt8">
          <button class="btn sm ghost" data-hblank="${i}">转为想多了解的</button>
          <button class="btn sm ghost" data-hdyn="${i}">记为动态状态</button>
        </div>
      </div>`).join('') : '<div class="muted small">本次没有给出未知因素假说 —— 已知因素足以解释，或材料不足。没有假说是好事。</div>';
    $('#unseenReport').innerHTML = `
      <div class="panel hairline-top" data-glow>
        <div class="panel-title">字面解读</div>
        ${md(r.literal || '（无）')}
        <div class="panel-title mt14">已知因素的解释</div>
        ${md(r.known || '（无）')}
        <div class="panel-title mt14">未知因素假说</div>
        <div class="panel-sub">假说 ≠ 事实。每条都给出了自然求证的方式——求证优先于推断。</div>
        ${hypHtml}
        <div class="panel-title mt14">建议的回应方式</div>
        ${md(r.response || '（无）')}
        ${r.caveat ? `<div class="note warn mt14">${esc(r.caveat)}</div>` : ''}
      </div>`;
    (r.hypotheses || []).forEach((h, i) => {
      const blankBtn = document.querySelector(`[data-hblank="${i}"]`);
      const dynBtn = document.querySelector(`[data-hdyn="${i}"]`);
      if (blankBtn) blankBtn.onclick = async () => {
        await guard(() => H.card.addClaim({ id: b.id, claim: { layer: DOMAIN_LAYER[h.domain] || 'life', text: `待验证：${h.text}`, epistemic: 'blank', source: 'ai', refs: [], confidence: 0, note: `来自突发解读（${LIKE_MAP[h.likelihood]}可能）` } }));
        toast('已转入理解卡空白层，可在「想多了解的」里看到', 'ok');
        blankBtn.disabled = true;
      };
      if (dynBtn) dynBtn.onclick = async () => {
        await guard(() => H.card.addDyn({ id: b.id, text: `待观察：${h.text}` }));
        toast('已记为动态状态', 'ok');
        dynBtn.disabled = true;
      };
    });
  }

  function bindUnseen(el, b) {
    $('#unseenGo').onclick = async () => {
      const message = $('#unseenMsg').value.trim();
      if (!message) return toast('请粘贴消息原文', 'err');
      const btn = $('#unseenGo');
      btn.disabled = true;
      const r = await guard(() => H.analysis.unseen({ id: b.id, message, context: $('#unseenCtx').value.trim() }), '解读中…检索相关往事');
      btn.disabled = false;
      if (!r) return;
      renderUnseen(b, r);
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
        <span class="chip ${mode === 'unseen' ? 'active' : ''}" data-amode="unseen">突发消息解读</span>
      </div>
      <div id="anaBody">${mode === 'person' ? personBody(b, stats) : mode === 'unseen' ? unseenBody(b) : scenarioBody(b, sessions || [])}</div>
    `;
    el.querySelectorAll('[data-amode]').forEach(chip => {
      chip.onclick = () => { mode = chip.dataset.amode; viewAnalysis(el); };
    });
    if (mode === 'person') bindPerson(el, b, stats);
    else if (mode === 'unseen') bindUnseen(el, b);
    else bindScenario(el, b, sessions || []);
  }

  HB.views = HB.views || {};
  HB.views.analysis = viewAnalysis;
})();
