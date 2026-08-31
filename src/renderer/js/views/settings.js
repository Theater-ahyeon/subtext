'use strict';
/* 彩排 · 视图：设置（模型服务接入 + 数据与隐私） */
(() => {
  const HB = window.HB;
  const { $, esc, toast, guard } = HB.ui;
  const H = HB.H;
  const state = HB.state;
  const { PROVIDER_META } = HB.C;

  async function viewSettings(el, draftProvider) {
    const [s, info] = await Promise.all([H.settings.get(), H.appInfo()]);
    state.settings = s;
    // draftProvider：表单里刚选、还没点保存的 provider，仅用于本次渲染
    const cur = draftProvider || s.provider;
    const meta = PROVIDER_META[cur] || PROVIDER_META.openai;
    el.innerHTML = `
      <div class="page-head">
        <div class="page-title">设置</div>
        <div class="page-desc">数据存储仅在本机；配置在线模型后，<b>理解卡与相关对话文本会发送给你所配置的模型服务商处理</b>，请自行选择可信服务商。API Key 经系统级加密保存（Windows DPAPI / macOS Keychain / Linux libsecret；系统密钥服务不可用时会明文保存并在此提示）。演示模式无需任何配置。</div>
      </div>
      <div class="panel hairline-top" data-glow>
        <div class="panel-title">模型服务</div>
        <label class="field"><span>接入格式（Provider）</span><select id="stProvider">
          ${Object.entries(PROVIDER_META).map(([k, v]) => `<option value="${k}" ${cur === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}
        </select></label>
        <div class="note mt8" id="provNote">${esc(meta.note || '')}</div>
        <div id="provCfg" class="${cur === 'mock' ? 'hidden' : ''}">
          <label class="field mt14"><span>API 地址（Base URL）</span><input type="text" id="stUrl" value="${esc(s.baseUrl)}" placeholder="${esc(meta.urlPh || '')}"></label>
          <label class="field ${meta.key ? '' : 'hidden'}"><span>${esc(meta.key ? 'API Key' : '')} ${s.hasApiKey ? '<span style="color:var(--green)">（已配置，留空则保持不变）</span>' : ''}</span>
            <input type="password" id="stKey" placeholder="${s.hasApiKey ? '········（已保存）' : 'sk-… / AIza… / sk-ant-…'}"></label>
          <label class="field"><span>模型</span>
            <div class="flex"><input type="text" id="stModel" value="${esc(s.model)}" placeholder="${esc(meta.modelPh || '')}" list="modelList" style="flex:1">
            <button class="btn sm" id="stFetchModels" data-canlist="1">获取模型列表</button></div>
            <datalist id="modelList"></datalist>
          </label>
          <label class="field"><span>最大输出 Tokens（Anthropic 必填，其他协议可选）</span><input type="number" id="stMaxTok" min="256" max="65536" step="256" value="${esc(String(s.maxTokens || 2048))}"></label>
          ${s.hasApiKey && !s.keyEncrypted ? '<div class="note red mt8">⚠ 本机系统密钥服务不可用，当前 API Key 以<b>明文</b>保存在 settings.json 中。请注意保护该文件，或更换支持系统密钥服务的环境。</div>' : ''}
        </div>
        <div class="mt20">
          <div class="panel-title">事件记忆向量化 <span class="muted small" style="font-weight:400">（彩排复盘与现实对照会自动记住事件段，供模拟日后自然承接）</span></div>
          <label class="field mt8"><span>Embedding 来源</span><select id="stEmbedProvider">
            <option value="" ${!s.embedProvider ? 'selected' : ''}>跟随主模型（openai / gemini / ollama 自动；其余走本地词面检索）</option>
            <option value="openai" ${s.embedProvider === 'openai' ? 'selected' : ''}>OpenAI 兼容 /v1/embeddings</option>
            <option value="ollama" ${s.embedProvider === 'ollama' ? 'selected' : ''}>Ollama 本地（/api/embed，全程离线）</option>
            <option value="gemini" ${s.embedProvider === 'gemini' ? 'selected' : ''}>Google Gemini Embedding</option>
          </select></label>
          <div class="row">
            <label class="field"><span>Embedding API 地址（留空 = 官方默认 / 与主模型一致）</span><input type="text" id="stEmbedUrl" value="${esc(s.embedBaseUrl)}" placeholder="http://localhost:11434"></label>
            <label class="field"><span>Embedding 模型（text-embedding-3-small / bge-m3 / nomic-embed-text / gemini-embedding-004）</span><input type="text" id="stEmbedModel" value="${esc(s.embedModel)}"></label>
          </div>
          <label class="field"><span>Embedding API Key（可选；Ollama 无需）</span><input type="text" id="stEmbedKey" placeholder="留空 = 保持不变"></label>
          <div class="note">向量化会把事件文本发送给你配置的 Embedding 服务商处理；选择 Ollama 可全程不出本机。服务商不可用时自动降级为本地词面检索（理解卡页会如实标记）。</div>
        </div>
        <div class="flex mt8">
          <button class="btn primary" id="stSave">保存</button>
          <button class="btn" id="stTest">测试连接</button>
          ${s.hasApiKey ? '<button class="btn danger sm" id="stClearKey">清除 Key</button>' : ''}
        </div>
      </div>
      <div class="panel" data-glow>
        <div class="panel-title">数据与隐私</div>
        <div class="report small">
          <ul>
            <li>数据目录：<code>${esc(info.dataDir)}</code>（仅本机）</li>
            <li>平台：${esc(info.platform)} · 版本 v${esc(info.version)}</li>
            <li>删除档案时，其全部数据同步删除。</li>
            ${info.corruptArchives ? `<li style="color:var(--indigo)">⚠ 检测到 ${info.corruptArchives} 份损坏的档案文件，已隔离到数据目录的 corrupt/ 子目录（未删除），可手动查看或清理。</li>` : ''}
          </ul>
        </div>
        <div class="note warn mt8">红线：分析真实第三方涉及隐私，请勿导入你无权处理的对话；档案仅限本人查看，不对外共享，不用于伤害性用途；引擎内置拒绝操控类请求。</div>
      </div>
    `;
    $('#stProvider').onchange = () => viewSettings(el, $('#stProvider').value);
    $('#stClearKey') && ($('#stClearKey').onclick = async () => {
      await H.settings.set({ apiKey: '' });
      state.settings = await H.settings.get();
      toast('已清除 API Key', 'ok');
      viewSettings(el);
    });
    $('#stFetchModels').onclick = async () => {
      // 先保存当前表单再拉取（models 请求使用已保存配置）
      await saveSettingsFromForm(el, { silent: true });
      const r = await guard(() => H.settings.models(), '获取模型列表…');
      if (r) {
        $('#modelList').innerHTML = r.models.map(m => `<option value="${esc(m)}"></option>`).join('');
        toast(`已获取 ${r.models.length} 个模型，在模型输入框中下拉选择`, 'ok');
      }
    };
    $('#stSave').onclick = () => saveSettingsFromForm(el, {});
    $('#stTest').onclick = async () => {
      await saveSettingsFromForm(el, { silent: true });
      const r = await guard(() => H.settings.test(), '测试中…');
      if (r) toast('连接正常：' + r.reply, 'ok');
    };
  }

  async function saveSettingsFromForm(el, { silent } = {}) {
    const provider = $('#stProvider').value;
    const patch = { provider };
    if (provider !== 'mock') {
      patch.baseUrl = $('#stUrl').value.trim();
      patch.model = $('#stModel').value.trim();
      patch.maxTokens = Math.max(256, Math.min(65536, Number($('#stMaxTok').value) || 2048));
      const keyEl = $('#stKey');
      if (keyEl && keyEl.value.trim()) patch.apiKey = keyEl.value.trim();
    }
    // 事件记忆向量化配置（独立于主模型）
    patch.embedProvider = $('#stEmbedProvider').value;
    patch.embedBaseUrl = $('#stEmbedUrl').value.trim();
    patch.embedModel = $('#stEmbedModel').value.trim();
    const embedKeyEl = $('#stEmbedKey');
    if (embedKeyEl && embedKeyEl.value.trim()) patch.embedApiKey = embedKeyEl.value.trim();
    await H.settings.set(patch);
    state.settings = await H.settings.get();
    updateModeChip();
    if (!silent) {
      toast('已保存', 'ok');
      viewSettings(el);
    }
  }

  function updateModeChip() {
    const chip = $('#modeChip');
    const p = state.settings ? state.settings.provider : 'mock';
    if (p === 'mock') {
      chip.textContent = '演示模式（离线）';
      chip.style.color = '';
    } else {
      const meta = PROVIDER_META[p] || { label: p };
      chip.textContent = (meta.label || p).split('（')[0] + ' · ' + (state.settings.model || '未设模型');
      chip.style.color = 'var(--emerald)';
    }
  }

  HB.views = HB.views || {};
  HB.views.settings = viewSettings;
  HB.updateModeChip = updateModeChip;
})();
