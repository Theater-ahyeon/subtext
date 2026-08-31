'use strict';
/* 演练 · 视图：对照复盘（统计 + 预判对照 + 直接录入 + 差异分析历史/撤销） */
(() => {
  const HB = window.HB;
  const { $, esc, toast, guard } = HB.ui;
  const H = HB.H;
  const state = HB.state;
  const { VERDICT_NAMES } = HB.C;

  const pct = (v) => (v == null ? '—' : Math.round(v * 100) + '%');

  async function viewCalibration(el) {
    const [preds, attrs, stats] = await Promise.all([
      H.loop.predictions({ id: state.currentId }).catch(() => null),
      H.loop.attributions({ id: state.currentId }).catch(() => null),
      H.stats({ id: state.currentId }),
    ]);
    if (!preds || !attrs || !stats) return;
    const noLoop = !stats.predictions && !stats.attributionsAll;
    el.innerHTML = `
      <div class="page-head">
        <div class="page-title">对照复盘</div>
        <div class="page-desc">核心循环：<b>预测冻结 → 现实对照 → 差异分析 → 卡片更新</b>。AI 的扮演是一次预测，她的真实反应是真值，差值就是学习信号。差异分析对卡片的修改可以撤销；<b>扮演偏差</b>（模拟没演好，而非理解卡错）会单独归类，不计入命中率。</div>
      </div>
      <div class="stat-row mb14">
        <div class="stat-card violet" data-glow><div class="stat-num">${pct(stats.hitRateTop1)}</div><div class="stat-label">Top1 命中率（${stats.attributions} 次有效差异分析，错判按未命中计入${stats.unknownVerdicts ? `，${stats.unknownVerdicts} 次无效不计` : ''}）</div></div>
        <div class="stat-card jade" data-glow><div class="stat-num">${pct(stats.hitRateTop2)}</div><div class="stat-label">Top2 命中率</div></div>
        <div class="stat-card blue" data-glow><div class="stat-num">${pct(stats.loopCompletion)}</div><div class="stat-label">闭环完成率（已对照 ${stats.linkedFeedbacks} / 预判 ${stats.predictions}）</div></div>
        <div class="stat-card amber" data-glow><div class="stat-num">${stats.openPredictions}<span class="unit">个</span></div><div class="stat-label">待对照预判</div></div>
      </div>
      ${stats.brierSamples ? `<div class="note mt8">预判校准（Top1 Brier）：<b>${Math.round(stats.brierTop1 * 1000) / 1000}</b>（${stats.brierSamples} 次有据可查的对照）。越接近 0 越准，0.25 相当于瞎猜；持续偏高说明预测系统性过自信，下预判时建议整体调保守。</div>` : ''}
    ${noLoop ? `
      <div class="panel" data-glow><div class="empty">
        <div class="empty-icon">⟳</div>
        <div class="empty-title">闭环还没有开始</div>
        <p>在「演练」中聊一个真实场景 → 结束前「写下预判」→ 回到这里录入她在现实中的真实反应。闭环完成率与命中率会从这里开始积累。</p>
        <button class="btn primary" id="goRehearsal">去演练</button>
      </div></div>` : ''}
      <div class="panel hairline-top" data-glow>
        <div class="panel-title">预判</div>
        ${preds.length ? preds.slice().reverse().map(p => `
          <div class="hypo-card">
            <div class="hypo-head">
              <span class="badge ${p.status === 'open' ? 'inference' : 'fact'}">${p.status === 'open' ? '待对照' : '已差异分析'}</span>
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
                  <textarea data-fbtext="${p.id}" placeholder="把她的实际回复原文粘贴到这里；沉默/未回复也写下来"></textarea></label>
                <button class="btn primary sm" data-fb="${p.id}">提交现实反应并差异分析</button>
              </div>` : ''}
          </div>`).join('') : '<div class="muted small">还没有预判 —— 在演练中点「写下预判」生成。</div>'}
      </div>
      <div class="panel" data-glow>
        <div class="panel-title">直接录入现实反应 <span class="muted small" style="font-weight:400">（没有预判也可以对照：AI 会对照理解卡差异分析）</span></div>
        <label class="field"><span>她的真实反应原文</span><textarea id="directFb" placeholder="例如她对你某次真实回复/行为的反应原话"></textarea></label>
        <button class="btn sm primary" id="directFbBtn">录入并差异分析</button>
      </div>
      <div class="panel" data-glow>
        <div class="panel-title">差异分析历史</div>
        ${attrs.length ? attrs.slice().reverse().map(a => `
          <div class="list-row">
            <span class="verdict ${a.verdict}">${VERDICT_NAMES[a.verdict] || a.verdict}</span>
            <div class="grow"><div class="list-sub" style="color:var(--text)">${esc(a.analysis.slice(0, 160))}</div>
            ${a.updates && a.updates.length ? `<div class="list-sub">卡片更新：${a.updates.map(u => `${u.action === 'add' ? '＋' : u.action === 'update' ? '✎' : '↓'}${esc((u.text || '').slice(0, 40))}`).join('；')}</div>` : ''}
            ${a.undone ? '<div class="list-sub" style="color:var(--green)">已撤销</div>' : ''}</div>
            <span class="muted small">${esc(a.createdAt.slice(0, 10))}</span>
            ${a.updates && a.updates.length && !a.undone ? `<button class="btn sm ghost" data-undo="${a.id}">撤销</button>` : ''}
          </div>`).join('') : '<div class="muted small">暂无差异分析记录。</div>'}
      </div>
    `;
    $('#goRehearsal') && ($('#goRehearsal').onclick = () => HB.router.go('rehearsal'));
    el.querySelectorAll('[data-fb]').forEach(btn => {
      btn.onclick = async () => {
        const pid = btn.dataset.fb;
        const raw = $(`[data-fbtext="${pid}"]`).value.trim();
        if (!raw) return toast('请填写她的真实反应', 'err');
        btn.disabled = true;
        const r = await guard(() => H.loop.feedback({ id: state.currentId, predictionId: pid, raw }), '差异分析中…');
        if (r) {
          toast(`差异分析完成：${VERDICT_NAMES[r.record.verdict] || r.record.verdict}，卡片更新 ${r.applied.length} 处（可撤销）${r.memoryNote ? '；' + r.memoryNote : ''}`, 'ok');
          if (state.view === 'calibration') viewCalibration(el);
        } else btn.disabled = false;
      };
    });
    $('#directFbBtn').onclick = async () => {
      const raw = $('#directFb').value.trim();
      if (!raw) return toast('请填写她的真实反应', 'err');
      const btn = $('#directFbBtn');
      btn.disabled = true;
      const r = await guard(() => H.loop.feedback({ id: state.currentId, predictionId: null, raw }), '差异分析中…');
      if (r) {
        toast(`差异分析完成：${VERDICT_NAMES[r.record.verdict] || r.record.verdict}，卡片更新 ${r.applied.length} 处${r.memoryNote ? '；' + r.memoryNote : ''}`, 'ok');
        if (state.view === 'calibration') viewCalibration(el);
      } else btn.disabled = false;
    };
    el.querySelectorAll('[data-undo]').forEach(btn => {
      btn.onclick = async () => {
        const r = await guard(() => H.loop.undo({ id: state.currentId, attributionId: btn.dataset.undo }), '撤销中…');
        if (r) { toast(`已撤销 ${r.reverted.length} 处卡片修改`, 'ok'); if (state.view === 'calibration') viewCalibration(el); }
      };
    });
  }

  HB.views = HB.views || {};
  HB.views.calibration = viewCalibration;
})();
