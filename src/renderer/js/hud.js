'use strict';
/* 演练 · 人物状态栏（HUD）：游戏风格快捷总览，数据全部来自本机档案 */
(() => {
  const HB = window.HB;
  const { esc, modal, guard, toast, closeModal } = HB.ui;
  const H = HB.H;

  const pct = (v) => (v == null ? '—' : Math.round(v * 100) + '%');

  /** 成长阶段：按素材/条目/演练/差异分析的粗略热度分 */
  function tierOf(score) {
    if (score >= 90) return { name: '同频', lv: 5 };
    if (score >= 50) return { name: '默契', lv: 4 };
    if (score >= 25) return { name: '渐熟', lv: 3 };
    if (score >= 10) return { name: '初识', lv: 2 };
    return { name: '初见', lv: 1 };
  }

  /** 横向数值条 */
  function bar(label, value, max, cls, text) {
    const p = max > 0 ? Math.min(1, value / max) : 0;
    return `
      <div class="hud-bar">
        <span class="lbl">${label}</span>
        <span class="hud-track"><i class="hud-fill ${cls || ''}" style="width:${Math.round(p * 100)}%"></i></span>
        <span class="val">${text}</span>
      </div>`;
  }

  const P_SLOTS = HB.C.PROFILE_SLOTS;

  function slotVals(prof, key) {
    const s = prof && prof.slots && prof.slots[key];
    if (!s) return [];
    return Array.isArray(s) ? s.map(x => x.text) : [s.value];
  }

  function profileHtml(b) {
    const prof = b.profile || { slots: {} };
    const srcBadge = (source) => source === 'user' ? '' : (source === 'ai' ? ' <span class="hud-t">AI</span>' : '');
    const singles = P_SLOTS.filter(d => d.type === 'single').map(d => {
      const vals = slotVals(prof, d.key);
      const s = prof.slots && prof.slots[d.key];
      return `<div class="hud-pslot"><span class="lbl">${d.label}</span><span class="val ${vals.length ? '' : 'is-empty'}">${esc(vals[0] || '—')}${vals.length ? srcBadge(s && s.source) : ''}</span></div>`;
    }).join('');
    const multis = P_SLOTS.filter(d => d.type === 'multi').map(d => {
      const vals = slotVals(prof, d.key);
      return `<div class="hud-prow"><span class="lbl">${d.label}</span><span class="chips">${vals.length ? vals.map(v => `<span class="badge plain">${esc(v)}</span>`).join('') : '<span class="muted small">—</span>'}</span></div>`;
    }).join('');
    return `<div class="hud-pgrid">${singles}</div>${multis}`;
  }

  /** 档案编辑器：单值输入框 + 多值逗号分隔 */
  function profileEditor(id, b) {
    const prof = b.profile || { slots: {} };
    const fields = P_SLOTS.map(d => {
      const vals = slotVals(prof, d.key);
      if (d.type === 'single') {
        return `<label class="field"><span>${d.label}</span><input type="text" data-pslot="${d.key}" value="${esc(vals[0] || '')}" maxlength="40"></label>`;
      }
      return `<label class="field"><span>${d.label}（多个用逗号分隔）</span><input type="text" data-pslot="${d.key}" value="${esc(vals.join('，'))}" maxlength="200"></label>`;
    }).join('');
    modal(`<h3>编辑档案</h3>
      <p class="muted small">你手填的内容不会被「从理解卡提取」覆盖。证据原文永远是事实的第一来源。</p>
      ${fields}
      <div class="modal-ops"><button class="btn ghost" id="peCancel">取消</button><button class="btn primary" id="peSave">保存</button></div>`);
    document.getElementById('peCancel').onclick = closeModal;
    document.getElementById('peSave').onclick = async () => {
      const slots = {};
      document.querySelectorAll('[data-pslot]').forEach(inp => {
        const def = P_SLOTS.find(d => d.key === inp.dataset.pslot);
        const raw = inp.value.trim();
        if (def.type === 'single') slots[def.key] = { value: raw };
        else slots[def.key] = raw ? raw.split(/[,，、\n]+/).map(t => ({ text: t.trim() })).filter(x => x.text) : [];
      });
      const r = await guard(() => H.profile.set({ id, slots }), '保存中…');
      if (r) { closeModal(); toast('档案已保存', 'ok'); open(id); }
    };
  }

  async function open(id) {
    const data = await guard(async () => {
      const [b, stats, sessions, interview, radar] = await Promise.all([
        H.persons.get({ id }),
        H.stats({ id }),
        H.session.list({ id }).catch(() => []),
        H.interview.state({ id }).catch(() => null),
        H.radar({ id }).catch(() => []),
      ]);
      return { b, stats, sessions: sessions || [], interview, radar: radar || [] };
    }, '读取人物状态…');
    if (!data) return;
    const { b, stats, sessions, interview, radar } = data;

    const claims = b.claims || [];
    const byLayer = { basic: 0, life: 0, temperament: 0, expression: 0 };
    let confSum = 0, confN = 0;
    claims.forEach(c => {
      byLayer[c.layer] = (byLayer[c.layer] || 0) + 1;
      if (c.epistemic !== 'blank') { confSum += (c.confidence || 0); confN++; }
    });
    const avgConf = confN ? confSum / confN : null;
    const epi = stats.byEpistemic || { fact: 0, inference: 0, blank: 0 };
    const epiTotal = Math.max(1, claims.length);
    const doneQ = interview ? Object.keys(interview.records || {}).length : 0;
    const activeSessions = sessions.filter(s => s.status === 'active').length;
    const latest = sessions.slice().sort((a, c) => (c.createdAt || '').localeCompare(a.createdAt || ''))[0];
    const dyn = (b.dynamic || []).filter(d => !d.resolved);
    const score = (stats.evidence || 0) * 1 + claims.length * 2 + sessions.length * 3 + (stats.attributions || 0) * 4;
    const tier = tierOf(score);

    modal(`
      <div class="hud-head">
        <div class="avatar hud-avatar">${esc((b.name || '?').slice(0, 1))}</div>
        <div class="grow">
          <div class="hud-name">${esc(b.name)} <span class="hud-tier">${tier.name} · Lv${tier.lv}</span></div>
          <div class="hud-alias">${esc(b.alias || '暂无备注')} · 建档 ${esc((b.createdAt || '').slice(0, 10))}</div>
        </div>
      </div>

      <div class="hud-profile">
        <div class="hud-profile-head">
          <span class="hud-k">档案</span>
          <button class="btn sm ghost" id="hudProfExtract">从理解卡提取</button>
          <button class="btn sm ghost" id="hudProfEdit">编辑</button>
        </div>
        ${profileHtml(b)}
      </div>

      <div class="hud-bars">
        ${bar('同频度', claims.length, 28, '', `${claims.length} / 28 条`)}
        ${bar('平均把握', avgConf == null ? 0 : avgConf, 1, 'green', avgConf == null ? '—' : (Math.round(avgConf * 100) + '%'))}
        ${bar('闭环命中 Top1', stats.hitRateTop1 == null ? 0 : stats.hitRateTop1, 1, 'blue', (stats.attributions || 0) ? pct(stats.hitRateTop1) : '—')}
        ${bar('24 问', doneQ, 24, 'jade', doneQ + ' / 24')}
        <div class="hud-bar">
          <span class="lbl">认知构成</span>
          <span class="hud-stack" aria-hidden="true">
            <i class="f" style="width:${Math.round(epi.fact / epiTotal * 100)}%"></i><i class="i" style="width:${Math.round(epi.inference / epiTotal * 100)}%"></i><i class="b" style="width:${Math.round(epi.blank / epiTotal * 100)}%"></i>
          </span>
          <span class="val wide small">事实 ${epi.fact} · 推断 ${epi.inference} · 空白 ${epi.blank}</span>
        </div>
      </div>

      <div class="hud-chips">
        <span class="badge plain">素材 E# ×${stats.evidence || 0}</span>
        <span class="badge plain">认知条目 ${claims.length}</span>
        <span class="badge plain">演练 ${sessions.length} 场${activeSessions ? `（${activeSessions} 场进行中）` : ''}</span>
        <span class="badge plain">待对照预测 ${stats.openPredictions || 0}</span>
        <span class="badge plain">想多了解 ${radar.length} 条</span>
      </div>

      <div class="hud-layers">
        <div class="hud-layer" style="--lc:#5c7fa3"><span class="lbl">基础信息</span><span class="hud-track"><i style="width:${Math.round(byLayer.basic / 8 * 100)}%"></i></span><span class="val">${byLayer.basic} / 8</span></div>
        <div class="hud-layer" style="--lc:#4a7c59"><span class="lbl">生活结构</span><span class="hud-track"><i style="width:${Math.round(byLayer.life / 8 * 100)}%"></i></span><span class="val">${byLayer.life} / 8</span></div>
        <div class="hud-layer" style="--lc:#6b5a9e"><span class="lbl">人物性情</span><span class="hud-track"><i style="width:${Math.round(byLayer.temperament / 8 * 100)}%"></i></span><span class="val">${byLayer.temperament} / 8</span></div>
        <div class="hud-layer" style="--lc:#b97f2e"><span class="lbl">场景表达</span><span class="hud-track"><i style="width:${Math.round(byLayer.expression / 8 * 100)}%"></i></span><span class="val">${byLayer.expression} / 8</span></div>
      </div>

      ${dyn.length ? `
      <div class="hud-row">
        <span class="hud-k">当前动态</span>
        <div class="grow">
          ${dyn.slice(0, 2).map(d => `<div class="hud-line">${esc(d.text)} <span class="hud-t">${esc((d.asOf || '').slice(5, 16)).replace('T', ' ')}</span></div>`).join('')}
          ${dyn.length > 2 ? `<div class="hud-line muted">…还有 ${dyn.length - 2} 条动态</div>` : ''}
        </div>
      </div>` : ''}
      ${latest ? `
      <div class="hud-row">
        <span class="hud-k">最近演练</span>
        <div class="grow"><div class="hud-line">${esc(latest.scenario || '未命名场景')} <span class="hud-t">${esc(latest.createdAt.slice(0, 16)).replace('T', ' ')} · ${latest.turns} 轮${latest.status === 'active' ? ' · 进行中' : ''}</span></div></div>
      </div>` : ''}

      <div class="note mt14">状态栏只汇总本机档案数据 —— 它是理解辅助，不是评判表。空白多，说明还有很多值得了解的地方。</div>
      <div class="modal-ops"><button class="btn ghost" id="hudClose">关闭</button><button class="btn primary" id="hudGo">打开理解卡</button></div>
    `);
    const ex = document.getElementById('hudProfExtract');
    if (ex) ex.onclick = async () => {
      ex.disabled = true;
      const r = await guard(() => H.profile.extract({ id }), '提取档案…');
      if (r) { toast('档案已从理解卡更新（仅填有依据的项，不覆盖你手填的内容）', 'ok'); open(id); }
      else ex.disabled = false;
    };
    const ed = document.getElementById('hudProfEdit');
    if (ed) ed.onclick = () => profileEditor(id, b);
    const close = document.getElementById('hudClose');
    if (close) close.onclick = () => HB.ui.closeModal();
    const go = document.getElementById('hudGo');
    if (go) go.onclick = () => { HB.ui.closeModal(); HB.router.go('card'); };
  }

  HB.hud = { open };
})();
