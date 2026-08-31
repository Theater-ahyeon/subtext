'use strict';
/* 演练 · 视图：人物（档案网格 + 新建/导入/删除） */
(() => {
  const HB = window.HB;
  const { $, esc, toast, guard, modal, closeModal } = HB.ui;
  const H = HB.H;
  const state = HB.state;

  async function viewHome(el) {
    state.persons = await H.persons.list() || [];
    // 每位人物的素材/条目计数（本地数据，逐个查询即可）
    const statsList = await Promise.all(state.persons.map(p => H.stats({ id: p.id }).catch(() => null)));
    el.innerHTML = `
      <div class="page-head">
        <div class="page-title">关系</div>
        <div class="page-desc">为每一位你想理解、想演练的真实对象建立一份<b>本地关系档案</b>。档案只保存在你自己的电脑上；配置在线模型后，相关文本会发送给你配置的模型服务商。</div>
        <div class="mt8"><button class="btn sm ghost" id="importCardBtn">导入卡片文件</button></div>
      </div>
      ${state.persons.length ? `
        <div class="person-grid">
          ${state.persons.map((p, i) => {
            const s = statsList[i];
            return `
            <div class="person-card" data-glow data-id="${p.id}" style="--i:${i}">
              <div class="avatar ${['', 'jade', 'violet'][i % 3]}">${esc((p.name || '?').slice(0, 1))}</div>
              <div class="person-name">${esc(p.name)}</div>
              <div class="person-alias">${esc(p.alias || '暂无备注')}</div>
              <div class="person-stats">
                <span><b>${s ? s.evidence : '—'}</b> 素材</span>
                <span><b>${s ? s.claims : '—'}</b> 条目</span>
                <span>创建 ${esc((p.createdAt || '').slice(0, 10))}</span>
              </div>
              <div class="mt14"><button class="btn sm ghost hud-btn" data-hud="${p.id}" title="查看状态栏">◧ 状态栏</button></div>
              <button class="btn danger sm person-del" data-del="${p.id}">删除</button>
            </div>`;
          }).join('')}
          <div class="person-card" id="addPersonCard" style="display:grid;place-items:center;min-height:170px;border-style:dashed;">
            <div style="text-align:center;color:var(--muted)">
              <div style="font-size:26px;margin-bottom:6px">＋</div>
              <div style="font-size:13px">新建档案</div>
            </div>
          </div>
        </div>` : `
        <div class="empty">
          <div class="empty-icon">◍</div>
          <div class="empty-title">还没有档案</div>
          <p>理解写法不为人物预写答案，而是用尽量少、彼此分工明确的内容，建立足以让"她"在陌生情境中继续生活的生成条件。从创建第一份档案开始。</p>
          <button class="btn primary" id="emptyAdd">创建第一份档案</button>
        </div>`}
    `;
    el.querySelectorAll('.person-card[data-id]').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-del]')) return;
        if (e.target.closest('[data-hud]')) {
          e.stopPropagation();
          HB.hud.open(card.dataset.id);
          return;
        }
        const p = state.persons.find(x => x.id === card.dataset.id);
        state.currentId = card.dataset.id;
        state.currentName = p ? p.name : '';
        state.session = null;
        HB.router.go('card');
      });
    });
    el.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const p = state.persons.find(x => x.id === btn.dataset.del);
        modal(`<h3>删除「${esc(p.name)}」？</h3>
          <p class="muted small">将删除其理解卡、证据、演练与访谈的全部本地数据，不可恢复。</p>
          <div class="modal-ops"><button class="btn ghost" id="mCancel">取消</button><button class="btn danger" id="mOk">确认删除</button></div>`);
        $('#mCancel').onclick = closeModal;
        $('#mOk').onclick = async () => { await H.persons.del({ id: p.id }); closeModal(); toast('已删除', 'ok'); viewHome(el); };
      });
    });
    const openCreate = () => {
      modal(`<h3>新建档案</h3>
      <label class="field"><span>称呼 *</span><input type="text" id="mName" placeholder="她 / 他的称呼" maxlength="20"></label>
      <label class="field"><span>备注（可选）</span><input type="text" id="mAlias" placeholder="例如：同事 / 朋友 / 暧昧对象" maxlength="30"></label>
      <div class="note">红线：档案数据仅限本人查看；本工具辅助理解与表达，不用于伤害他人。</div>
      <div class="modal-ops"><button class="btn ghost" id="mCancel">取消</button><button class="btn primary" id="mOk">创建</button></div>`);
      $('#mCancel').onclick = closeModal;
      $('#mOk').onclick = async () => {
        const name = $('#mName').value.trim();
        if (!name) return toast('请填写称呼', 'err');
        const b = await guard(() => H.persons.create({ name, alias: $('#mAlias').value.trim() }), '创建中…');
        if (b) { closeModal(); toast('已创建', 'ok'); state.currentId = b.id; state.currentName = name; state.session = null; HB.router.go('card'); }
      };
    };
    $('#addPersonCard') && ($('#addPersonCard').onclick = openCreate);
    $('#emptyAdd') && ($('#emptyAdd').onclick = openCreate);
    $('#importCardBtn').onclick = async () => {
      const r = await guard(() => H.card.importCard(), '导入中…');
      if (r && !r.canceled) { toast(`已导入「${r.name}」（${r.claims} 条认知条目）`, 'ok'); state.currentId = r.id; state.currentName = r.name || ''; state.session = null; HB.router.go('card'); }
    };
  }

  HB.views = HB.views || {};
  HB.views.home = viewHome;
})();
