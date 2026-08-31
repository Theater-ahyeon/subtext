'use strict';
/* 彩排 · 视图：理解卡（四层认知条目 + 动态状态 + 想多了解的 + 条目表单） */
(() => {
  const HB = window.HB;
  const { $, esc, toast, loading, guard, modal, closeModal } = HB.ui;
  const H = HB.H;
  const state = HB.state;
  const { LAYER_NAMES, EPI_NAMES, SRC_NAMES } = HB.C;

  async function viewCard(el) {
    const b = await guard(() => H.persons.get({ id: state.currentId }), '加载中…');
    if (!b) return;
    const stats = await H.stats({ id: b.id });
    const layers = ['basic', 'life', 'temperament', 'expression'];
    el.innerHTML = `
      <div class="page-head">
        <div class="page-title">${esc(b.name)} 的理解卡
          <button class="btn sm ghost" id="editPerson">编辑</button>
        </div>
        <div class="page-desc">${esc(b.alias || '')} · 素材 ${stats.evidence} 条 · 认知条目 ${stats.claims} 条（事实 ${stats.byEpistemic.fact} / 推断 ${stats.byEpistemic.inference} / 空白 ${stats.byEpistemic.blank}）</div>
        ${(!b.claims.length && !b.evidence.length) ? `
        <div class="note warn mt8" style="font-size:13px">
          <b>从这里开始：</b>① 去「导入」粘贴你们的聊天记录（或到「原话库」手动存证）→ ② 回来点「从素材归纳初稿」→ ③ 或者先做「24 问」，用你对她的了解冷启动。
        </div>` : ''}
      </div>
      <div class="panel hairline-top" data-glow>
        <div class="panel-title">理解卡引擎
          <button class="btn sm primary" id="induceBtn">从素材归纳初稿</button>
          <button class="btn sm ghost" id="compileBtn">预览注入给 AI 的卡片</button>
          <button class="btn sm ghost" id="exportBtn">导出</button>
        </div>
        <div class="panel-sub">四层分工：<b>基础信息</b>确定她站在哪里 · <b>生活结构</b>提供她能做什么 · <b>人物性情</b>说明她怎样理解事情 · <b>场景表达</b>描述她如何开口与行动。空白条目不进入 AI 的卡片。</div>
        ${layers.map(L => `
          <div class="mt14 layer" data-layer="${L}">
            <div class="flex mb14" style="justify-content:space-between">
              <div class="panel-title" style="margin:0">${LAYER_NAMES[L]}
                <span class="badge plain">${b.claims.filter(c => c.layer === L).length} 条</span>
              </div>
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
      <div class="panel hairline-top" data-glow>
        <div class="panel-title">想多了解的</div>
        <div class="panel-sub">由理解卡空白、<b>用户陈述待验证</b>与访谈待确认项生成 —— 这些是"你还不知道或还没验证的事"，可以在下次真实聊天中自然求证。</div>
        <div id="radarBox"><div class="muted small">加载中…</div></div>
      </div>
      <div class="panel hairline-top" data-glow>
        <div class="panel-title">事件记忆 <span class="muted small" style="font-weight:400" id="memCount"></span>
          <button class="btn sm ghost" id="memRebuild">重建向量</button>
          <button class="btn sm danger" id="memClear">清空</button>
        </div>
        <div class="panel-sub">彩排复盘与现实对照会自动把「发生过什么」存成事件段（向量化，可检索）。开场彩排时，相关往事会自动注入给她的模拟。每段都带来源，可单删。</div>
        <div id="memBox"><div class="muted small">加载中…</div></div>
      </div>
    `;

    $('#induceBtn').onclick = async () => {
      if (!b.evidence.length) { toast('暂无素材：请先到「导入」或「原话库」添加素材', 'err'); return; }
      loading(true, 'AI 正在按理解写法归纳素材…');
      try {
        const r = await H.card.induce({ id: b.id }, (p) => {
          $('#loadingText').textContent = `归纳进度：第 ${p.step} / ${p.total} 批素材…`;
        });
        toast(`归纳完成：新增 ${r.newClaims} 条、合并复现 ${r.mergedDups || 0} 条（共 ${r.total} 条，${r.chunks} 批${r.imageBatches ? `，含 ${r.imageBatches} 批截图` : ''}${r.textOnlyFallbacks ? `，${r.textOnlyFallbacks} 批因模型不支持图片已按文字占位归纳` : ''}）`, 'ok');
        if (state.view === 'card') viewCard(el);
      } catch (err) {
        toast(err.message || '归纳失败', 'err');
      } finally {
        loading(false);
      }
    };
    $('#compileBtn').onclick = async () => {
      const card = await guard(() => H.card.compile({ id: b.id }), '组装中…');
      if (card) {
        modal(`<h3>注入给 AI 的最小理解卡</h3><pre style="white-space:pre-wrap;font-size:12.5px;line-height:1.7">${esc(card)}</pre><div class="modal-ops"><button class="btn ghost" id="mClose">关闭</button></div>`);
        $('#mClose').onclick = closeModal;
      }
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
        state.currentName = $('#mName').value.trim();
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
    const radarBox = $('#radarBox');
    if (!radarBox) return; // 用户已切走视图
    radarBox.innerHTML = radar && radar.length
      ? radar.map(r => `<div class="list-row"><span class="badge plain">${esc(r.from)}</span><div class="grow list-title">${esc(r.text)}</div></div>`).join('')
      : '<div class="muted small">暂无空白或待确认项 —— 先导入素材并归纳，或从 24 问访谈沉淀。</div>';

    // 事件记忆面板
    const renderMem = (mem) => {
      const box = $('#memBox');
      if (!box) return;
      $('#memCount').textContent = mem.total
        ? `${mem.total} 段${mem.stale ? ' · 模型已变更，建议重建' : (mem.model === 'local:hash' ? ' · 本地词面检索' : '')}`
        : '';
      box.innerHTML = mem.items.length ? mem.items.map(m => `
        <div class="list-row">
          <span class="badge ${m.kind === 'reality' ? 'src-evidence' : 'src-ai'}">${m.kind === 'reality' ? '现实' : '彩排'}</span>
          <div class="grow"><div class="list-title">${esc(m.text)}</div>
          <div class="list-sub">${esc((m.ts || '').slice(0, 16)).replace('T', ' ')}${m.ref && m.ref.evidenceSeq ? ` · 证据 E${m.ref.evidenceSeq}` : ''}${m.ref && m.ref.sessionId ? ' · 来自彩排' : ''}</div></div>
          <button class="btn sm ghost" data-memdel="${m.id}">删</button>
        </div>`).join('')
        : '<div class="muted small">还没有事件记忆 —— 完成一场彩排复盘，或在对照复盘录入一次现实反应后会自动生成。</div>';
      box.querySelectorAll('[data-memdel]').forEach(btn => {
        btn.onclick = async () => { await guard(() => H.memory.del({ id: b.id, memoryId: btn.dataset.memdel })); loadMem(); };
      });
    };
    const loadMem = async () => {
      const mem = await guard(() => H.memory.list({ id: b.id }), '加载…');
      if (mem) renderMem(mem);
    };
    loadMem();
    $('#memRebuild') && ($('#memRebuild').onclick = async () => {
      const r = await guard(() => H.memory.rebuild({ id: b.id }), '重建中…');
      if (r) { toast(`已重建 ${r.rebuilt} 段记忆向量${r.fallback ? '（本地词面降级）' : ''}`, 'ok'); loadMem(); }
    });
    $('#memClear') && ($('#memClear').onclick = () => {
      modal(`<h3>清空事件记忆？</h3><p class="muted small">删除全部事件段（理解卡与证据不受影响），不可恢复。</p>
        <div class="modal-ops"><button class="btn ghost" id="mCancel">取消</button><button class="btn danger" id="mOk">清空</button></div>`);
      $('#mCancel').onclick = closeModal;
      $('#mOk').onclick = async () => { await H.memory.clear({ id: b.id }); closeModal(); toast('已清空', 'ok'); loadMem(); };
    });
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
        <label class="field"><span>置信度</span><input type="number" id="mConf" min="0" max="1" step="0.05" value="${esc(String(claim ? (claim.confidence ?? 0.6) : 0.6))}"></label>
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

  HB.views = HB.views || {};
  HB.views.card = viewCard;
})();
