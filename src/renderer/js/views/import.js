'use strict';
/* 彩排 · 视图：导入（粘贴解析预览 / 文件导入） */
(() => {
  const HB = window.HB;
  const { $, esc, toast, guard } = HB.ui;
  const H = HB.H;
  const state = HB.state;

  async function viewImport(el) {
    state.importPreview = null;
    el.innerHTML = `
      <div class="page-head">
        <div class="page-title">导入聊天素材</div>
        <div class="page-desc">支持 GitHub 常见导出工具的格式：<b>留痕 MemoTrace / WeChatMsg</b>（微信 JSON / CSV / TXT）、<b>QQ 导出 TXT</b>（时间戳行）、通用 JSON 数组、JSONL、以及任意直接粘贴的对话文本。解析完全在本机完成。</div>
        <div class="note red mt8">知情提示：你即将录入与<b>真实第三方</b>的私人对话。仅用于你自己的理解与沟通练习，请勿导入你无权处理的对话，勿公开分享档案。</div>
      </div>
      <div class="panel hairline-top" data-glow>
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
      <div class="panel" data-glow>
        <div class="panel-title">方式二：选择文件</div>
        <div class="panel-sub">支持 .json / .jsonl / .csv / .txt（UTF-8 编码）</div>
        <button class="btn" id="impFile">选择文件并导入</button>
      </div>
      <details class="panel" data-glow>
        <summary class="panel-title" style="margin:0;cursor:pointer">格式对照说明 <span class="muted small" style="font-weight:400">（点击展开）</span></summary>
        <div class="report small mt14">
          <ul>
            <li><strong>留痕 MemoTrace JSON</strong>：字段 sender / nick / msg / CreateTime / is_sender —— 自动识别</li>
            <li><strong>WeChatMsg CSV</strong>：表头含 StrContent / SenderName / CreateTime 等 —— 自动识别</li>
            <li><strong>QQ 导出 TXT</strong>：形如 <code>2024-01-01 12:00:00 昵称(QQ号)\\n内容</code> —— 自动识别</li>
            <li><strong>微信合并转发复制文本</strong>：形如 <code>昵称\\n12:05\\n内容</code> 或 <code>昵称：内容</code> —— 尽力识别</li>
            <li>识别不了的行会被跳过并在统计中显示；<b>导入前先看解析预览确认</b>。</li>
          </ul>
        </div>
      </details>
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
        if (res) {
          toast(`已导入 ${res.added} 条，原话库共 ${res.total} 条` + (res.truncated ? `（⚠ 超出上限，截断 ${res.truncated} 条）` : ''), res.truncated ? 'err' : 'ok');
          state.importPreview = null;
        }
      });
    };
    $('#impFile').onclick = async () => {
      const src = $('#impSrc').value;
      const r = await guard(() => H.imp.file({ id: state.currentId, sourceType: src, selfName: $('#impSelf').value }), '导入中…');
      if (r && !r.canceled) toast(`已导入 ${r.added} 条（格式 ${r.format.toUpperCase()}）` + (r.truncated ? `（⚠ 截断 ${r.truncated} 条）` : ''), r.truncated ? 'err' : 'ok');
    };
  }

  HB.views = HB.views || {};
  HB.views.import = viewImport;
})();
