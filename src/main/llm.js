'use strict';
/**
 * LLM Provider 抽象层 —— 多协议适配器架构。
 * 支持格式：
 *  - openai   ：OpenAI Chat Completions 兼容（DeepSeek/Kimi/GLM/Qwen/OpenRouter/OneAPI/新版网关等）
 *  - azure    ：Azure OpenAI（部署 URL + api-key 头）
 *  - anthropic：Anthropic Claude Messages API（x-api-key + anthropic-version）
 *  - gemini   ：Google AI generateContent（x-goog-api-key）
 *  - ollama   ：Ollama 本地模型（/api/chat，无需密钥）
 *  - mock     ：离线演示模式
 * 每个适配器导出纯函数 build()/parse()，可在无网络环境单测。
 */

const DEFAULT_BASE = {
  openai: 'https://api.openai.com/v1',
  azure: '',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  ollama: 'http://localhost:11434',
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function splitQuery(url) {
  const qIdx = url.indexOf('?');
  if (qIdx === -1) return [url, ''];
  return [url.slice(0, qIdx), url.slice(qIdx)];
}

/** OpenAI 兼容 URL 归一化（补 /v1/chat/completions；容忍尾斜杠、query、Gemini 风格 /openai 结尾） */
function normalizeBaseUrl(url) {
  let u = (url || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (/\/openai\/deployments\//.test(u) || /azure\.com/i.test(u)) {
    throw new Error('这是 Azure 部署地址，请把 Provider 切换为 Azure OpenAI 并将部署完整地址填入 API 地址');
  }
  const qIdx = u.indexOf('?');
  let query = '';
  if (qIdx !== -1) { query = u.slice(qIdx); u = u.slice(0, qIdx).replace(/\/+$/, ''); }
  let out;
  if (u.endsWith('/chat/completions')) out = u;
  else if (u.endsWith('/openai')) out = u + '/chat/completions'; // Gemini OpenAI 兼容层
  else if (/\/v\d+(beta)?$/.test(u)) out = u + '/chat/completions';
  else out = u + '/v1/chat/completions';
  return out + query;
}

/** 拆出 system 提示词与对话消息（供 system 独立传输的协议使用） */
function splitSystem(messages) {
  const systemParts = [];
  const rest = [];
  for (const m of messages) {
    if (m.role === 'system') systemParts.push(m.content);
    else rest.push(m);
  }
  return { system: systemParts.join('\n\n'), messages: rest };
}

/** 消息 content 是否为多模态块数组（含图片） */
function hasImages(messages) {
  return (messages || []).some(m => Array.isArray(m.content) && m.content.some(p => p && p.type === 'image'));
}

/**
 * 统一多模态形状 → 各协议请求体。上游允许两种 content：
 *   字符串（纯文本）或 [{type:'text',text}, {type:'image',mime,dataB64}]（图片为原始 base64，无 data: 前缀）。
 * 纯文本路径保持原样直传（不复制消息体）；只有包含图片的消息才转换。
 */
const IMAGE_PREFIX_RE = /^data:[^,]*,/;
function stripDataUrl(s) { return String(s || '').replace(IMAGE_PREFIX_RE, ''); }
function textOf(m) { return Array.isArray(m.content) ? m.content.filter(p => p && p.type === 'text').map(p => p.text).join('\n') : m.content; }
function imagesOf(m) { return Array.isArray(m.content) ? m.content.filter(p => p && p.type === 'image') : []; }

/** OpenAI 兼容 Chat Completions：content_parts 数组 */
function toOpenAIMessages(messages) {
  if (!hasImages(messages)) return messages;
  return messages.map(m => {
    const imgs = imagesOf(m);
    if (!imgs.length) return { role: m.role, content: textOf(m) };
    const parts = [];
    const txt = textOf(m);
    if (txt) parts.push({ type: 'text', text: txt });
    for (const im of imgs) parts.push({ type: 'image_url', image_url: { url: `data:${im.mime || 'image/png'};base64,${stripDataUrl(im.dataB64)}` } });
    return { role: m.role, content: parts };
  });
}

/** Anthropic Messages：system 独立 + content blocks */
function toAnthropicMessages(messages) {
  const { system, messages: rest } = splitSystem(messages);
  const out = rest.map(m => {
    const imgs = imagesOf(m);
    if (!imgs.length) return { role: m.role, content: textOf(m) };
    const blocks = [];
    const txt = textOf(m);
    if (txt) blocks.push({ type: 'text', text: txt });
    for (const im of imgs) blocks.push({ type: 'image', source: { type: 'base64', media_type: im.mime || 'image/png', data: stripDataUrl(im.dataB64) } });
    return { role: m.role, content: blocks };
  });
  return { system, messages: out };
}

/** Gemini generateContent：role 映射 + inline_data parts */
function toGeminiContents(messages) {
  const { system, messages: rest } = splitSystem(messages);
  const contents = rest.map(m => {
    const imgs = imagesOf(m);
    const parts = [];
    const txt = textOf(m);
    if (txt) parts.push({ text: txt });
    for (const im of imgs) parts.push({ inlineData: { mimeType: im.mime || 'image/png', data: stripDataUrl(im.dataB64) } });
    if (!parts.length) parts.push({ text: '' });
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });
  return { system, contents };
}

/** Ollama /api/chat：images 数组（与 message 同序） */
function toOllamaMessages(messages) {
  if (!hasImages(messages)) return messages;
  return messages.map(m => {
    const imgs = imagesOf(m);
    if (!imgs.length) return { role: m.role, content: textOf(m) };
    return { role: m.role, content: textOf(m), images: imgs.map(im => stripDataUrl(im.dataB64)) };
  });
}

const ADAPTERS = {
  openai: {
    label: 'OpenAI 兼容',
    keyLabel: 'API Key',
    needsKey: true,
    build({ settings, messages, temperature, maxTokens }) {
      const url = normalizeBaseUrl(settings.baseUrl || DEFAULT_BASE.openai);
      const body = { model: settings.model, messages: toOpenAIMessages(messages), temperature, stream: false };
      if (maxTokens) body.max_tokens = maxTokens;
      return { url, headers: { ...JSON_HEADERS, 'Authorization': 'Bearer ' + (settings.apiKey || '') }, body };
    },
    parse(data) {
      const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!content) throw new Error('API 返回为空');
      return content;
    },
    modelsUrl(settings) {
      const [base, query] = splitQuery((settings.baseUrl || DEFAULT_BASE.openai).replace(/\/+$/, ''));
      const u = base.replace(/\/chat\/completions$/, '');
      return (/\/v\d+(beta)?$/.test(u) ? u : u + '/v1') + '/models' + query;
    },
    parseModels(data) { return (data && data.data || []).map(m => m.id).filter(Boolean); },
    modelsHeaders(settings) { return { 'Authorization': 'Bearer ' + (settings.apiKey || '') }; },
  },

  azure: {
    label: 'Azure OpenAI',
    keyLabel: 'API Key（Azure 资源密钥）',
    needsKey: true,
    build({ settings, messages, temperature, maxTokens }) {
      const url = (settings.baseUrl || '').trim();
      if (!url) throw new Error('请填入 Azure 部署的完整 Chat Completions 地址（含 api-version 查询参数）');
      const body = { messages: toOpenAIMessages(messages), temperature, stream: false };
      if (maxTokens) body.max_tokens = maxTokens;
      return { url, headers: { ...JSON_HEADERS, 'api-key': settings.apiKey || '' }, body };
    },
    parse(data) {
      const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!content) throw new Error('API 返回为空');
      return content;
    },
    modelsUrl: null, // 部署制，无模型列表
  },

  anthropic: {
    label: 'Anthropic Claude',
    keyLabel: 'API Key（sk-ant-…）',
    needsKey: true,
    build({ settings, messages, temperature, maxTokens }) {
      const base = (settings.baseUrl || DEFAULT_BASE.anthropic).trim().replace(/\/+$/, '');
      const url = base.endsWith('/v1/messages') ? base : base + '/v1/messages';
      const { system, messages: rest } = toAnthropicMessages(messages);
      const body = {
        model: settings.model,
        max_tokens: maxTokens || 2048, // Anthropic 必填
        temperature,
        messages: rest,
        stream: false,
      };
      if (system) body.system = system;
      return { url, headers: { ...JSON_HEADERS, 'x-api-key': settings.apiKey || '', 'anthropic-version': '2023-06-01' }, body };
    },
    parse(data) {
      const parts = data && data.content || [];
      const text = parts.filter(p => p && p.type === 'text').map(p => p.text).join('');
      if (!text) throw new Error('API 返回为空');
      return text;
    },
    modelsUrl(settings) {
      const base = (settings.baseUrl || DEFAULT_BASE.anthropic).trim().replace(/\/+$/, '');
      return base.endsWith('/v1') ? base + '/models' : base + '/v1/models';
    },
    parseModels(data) { return (data && data.data || []).map(m => m.id).filter(Boolean); },
    modelsHeaders(settings) { return { 'x-api-key': settings.apiKey || '', 'anthropic-version': '2023-06-01' }; },
  },

  gemini: {
    label: 'Google Gemini',
    keyLabel: 'API Key（AIza…）',
    needsKey: true,
    build({ settings, messages, temperature, maxTokens }) {
      const base = (settings.baseUrl || DEFAULT_BASE.gemini).trim().replace(/\/+$/, '');
      const model = (settings.model || '').trim();
      if (!model) throw new Error('请填写 Gemini 模型名（如 gemini-2.5-flash）');
      const url = base + '/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
      const { system, contents } = toGeminiContents(messages);
      const body = {
        contents,
        generationConfig: { temperature, maxOutputTokens: maxTokens || 2048 },
      };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      return { url, headers: { ...JSON_HEADERS, 'x-goog-api-key': settings.apiKey || '' }, body };
    },
    parse(data) {
      const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts || [];
      const text = parts.map(p => p.text || '').join('');
      if (!text) {
        const reason = data && data.candidates && data.candidates[0] && data.candidates[0].finishReason;
        throw new Error('API 返回为空' + (reason ? `（finishReason: ${reason}，可能被安全策略拦截）` : ''));
      }
      return text;
    },
    modelsUrl(settings) {
      const base = (settings.baseUrl || DEFAULT_BASE.gemini).trim().replace(/\/+$/, '');
      return base + '/v1beta/models';
    },
    parseModels(data) {
      return (data && data.models || [])
        .filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
        .map(m => String(m.name || '').replace(/^models\//, ''))
        .filter(Boolean);
    },
    modelsHeaders(settings) { return { 'x-goog-api-key': settings.apiKey || '' }; },
  },

  ollama: {
    label: 'Ollama 本地模型',
    keyLabel: null,
    needsKey: false,
    build({ settings, messages, temperature }) {
      const base = (settings.baseUrl || DEFAULT_BASE.ollama).trim().replace(/\/+$/, '');
      const url = base + '/api/chat';
      const body = { model: settings.model, messages: toOllamaMessages(messages), stream: false, options: { temperature } };
      return { url, headers: { ...JSON_HEADERS }, body };
    },
    parse(data) {
      const content = data && data.message && data.message.content;
      if (!content) throw new Error('API 返回为空');
      return content;
    },
    modelsUrl(settings) {
      const base = (settings.baseUrl || DEFAULT_BASE.ollama).trim().replace(/\/+$/, '');
      return base + '/api/tags';
    },
    parseModels(data) { return (data && data.models || []).map(m => m.name).filter(Boolean); },
    modelsHeaders() { return {}; },
  },
};

const MOCK_REPLY = {
  TWIN: '（她抬起头，把手机扣在桌上）「……所以你今天找我，是有事吧？」',
  REVIEW: [
    '## 复盘报告（演示模式）',
    '### 一、模拟演绎质量',
    '- 连续性：本轮扮演与理解卡中的性情倾向一致，未出现性格漂移。',
    '- 变化性：对不同话题的回应体量有区分，未复读固定动作。',
    '- 迁移能力：面对卡片未覆盖的问题时，回复停留在试探而非编造往事，符合"留白"原则。',
    '- 独立性：她有自己的事情线（工作压力），未完全围绕你的问题打转。',
    '- 时间连续：动态状态（赶项目）被自然带入口吻，没有回到过时状态。',
    '- 成长能力：面对你的道歉，她的回应比历史记录中的防御姿态略有松动，变化有依据。',
    '### 二、你的沟通复盘',
    '- 有效：开头直接说明来意，给了对方确定感。',
    '- 可改进：连续追问两件事，她只回应了第一件——一次一个问题是更稳的节奏。',
    '### 三、下轮演练建议',
    '- 试一个她明确拒绝你的分支，练习接住拒绝后继续对话。',
    '### 四、现实验证清单',
    '- 她最近的作息压力来源（理解卡中缺失）——下次聊天可以自然带出。',
  ].join('\n'),
  HYPOTHESIS: JSON.stringify({
    hypotheses: [
      { text: '她最近在忙一件不想多谈的事，回复变短是自我保护，不是对你不满', prob: 0.45, basis: '理解卡性情层：压力期倾向于收缩表达', verify: '聊轻松话题时观察她是否恢复平时句长' },
      { text: '她对当前话题不感兴趣，但出于礼貌维持回应', prob: 0.35, basis: '场景表达层：不熟的话题常用短句维持', verify: '换一个她熟悉的领域看参与度' },
      { text: '她没注意到你语气里的试探，按字面意思回答', prob: 0.2, basis: '历史记录中她曾明确说不擅长读暗示', verify: '把话说明确再看反应' },
    ],
    expected: '她会先问清你的目的，回应偏短，主动延续话题的概率低。',
  }),
  ATTRIBUTION: JSON.stringify({
    verdict: 'partial',
    analysis: '现实回应的方向与预测一致（她确实先确认目的），但表达比预期更主动，主动延续了一个话题——材料缺失：卡片缺少她近期生活结构的信息，导致低估了她的主动性。',
    updates: [
      { action: 'add', layer: 'life', text: '近期有明确的时间压力来源，但对信任的人会主动腾出精力', reason: '现实反馈显示她主动延续话题' },
    ],
  }),
  INDUCE: JSON.stringify({
    claims: [
      { layer: 'temperament', text: '面对不确定的请求，往往先确认目的再决定投入程度', epistemic: 'inference', refs: ['E1'], confidence: 0.7 },
      { layer: 'expression', text: '回复偏短，问题驱动，很少先寒暄', epistemic: 'inference', refs: ['E1', 'E2'], confidence: 0.6 },
    ],
    blanks: [
      { text: '她作息与工作压力来源', layer: 'life' },
      { text: '她对哪些话题明显更有兴趣', layer: 'temperament' },
    ],
  }),
  INTERVIEW_PROBE: '这个说法具体会表现成什么行为？例如她最近一次让你产生这种感觉，是发生了什么？',
  ANALYZE_PERSON: [
    '## 一、TA 是谁 —— 整合画像',
    '- 理解卡显示：面对不确定的请求往往先确认目的再决定投入程度（推断，把握中等）。',
    '- 生活结构层记录了近期有时间压力来源，但对信任的人会主动腾出精力。',
    '## 二、证据与理解的质量',
    '- 证据规模尚小，以上结论以推断为主；作息与压力来源仍是空白。',
    '## 三、沟通与情绪模式',
    '- 回复偏短、问题驱动，很少先寒暄；压力期会进一步收缩表达。',
    '## 四、模拟 vs 现实',
    '- 暂无足够的对照数据；开始写下预判并在现实对照后，本节会给出命中率与偏差解读。',
    '## 五、认知盲区',
    '- ① 作息与压力来源；② 她对哪些话题明显更有兴趣；③ 家庭与亲密关系的边界。',
    '## 六、给用户的建议',
    '- 下次聊天自然带出作息话题；观察她对计划变动的第一反应；不要连续追问两件事。',
  ].join('\n'),
  ANALYZE_SCENARIO: [
    '## 一、TA 在这个场景的反应路径',
    '- 高可能：先确认你的目的，再决定投入程度（理解卡·性情层）。',
    '- 中可能：以短句维持礼貌回应，不主动延续话题（理解卡·表达层）。',
    '- 低可能：直接敞开谈近期压力（仅有现实对照中一次主动延展的孤例）。',
    '## 二、相关往事',
    '- 事件记忆中有同场景的历史演练记录，开场时她会带着上一次的结论而来。',
    '## 三、历史演练与现实对照',
    '- 暂无现实对照数据；演练里的表现仅供参考。',
    '## 四、你的最优策略',
    '- 开场直接说明来意，给她确定感；一次只问一件事；接受"嗯"不是同意，留出追问空间。',
    '## 五、风险与提醒',
    '- 避免连续试探；避免在她说"忙"的时候继续推进话题。',
  ].join('\n'),
  PROFILE: JSON.stringify({
    profile: { gender: '', birthday: '', occupation: '编辑', location: '', family: [], hobbies: [], foods: [], likes: ['守约的人'], dislikes: ['临时打乱安排'] },
  }),
  INTERVIEW_SUMMARY: '## 中途小结（演示模式）\n- 已确定：她重视约定\n- 待确认：核心信念层尚未触及',
  INTERVIEW_FINAL: JSON.stringify({
    final: '# 创作思路整合（演示模式）\n## 一、用户已经确定的内容\n- 她重视约定与责任\n## 十、高可能推论\n- 她可能对"被临时打乱安排"敏感',
    suggestions: [
      { layer: 'temperament', text: '重视约定，认定的责任不会轻易放下', kind: 'fact' },
      { layer: 'temperament', text: '可能对临时变动敏感，倾向于提前确认计划', kind: 'inference' },
    ],
  }),
};

function mockRespond(messages, opts = {}) {
  const task = opts.task || 'TWIN';
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  if (task === 'TWIN') return MOCK_REPLY.TWIN;
  if (task === 'INDUCE') return MOCK_REPLY.INDUCE;
  if (task === 'REVIEW') return MOCK_REPLY.REVIEW;
  if (task === 'HYPOTHESIS') return MOCK_REPLY.HYPOTHESIS;
  if (task === 'ATTRIBUTION') return MOCK_REPLY.ATTRIBUTION;
  if (task === 'INTERVIEW_PROBE') {
    // 演示模式：回答足够具体（含行为细节）就通过，否则追问 —— 模拟真实判定
    const content = (lastUser && lastUser.content) || '';
    const m = content.match(/「([^」]*)」/);
    const answer = m ? m[1] : '';
    return answer.length > 10 ? 'OK' : MOCK_REPLY.INTERVIEW_PROBE;
  }
  if (task === 'ANALYZE_PERSON') return MOCK_REPLY.ANALYZE_PERSON;
  if (task === 'ANALYZE_SCENARIO') return MOCK_REPLY.ANALYZE_SCENARIO;
  if (task === 'PROFILE') return MOCK_REPLY.PROFILE;
  if (task === 'INTERVIEW_SUMMARY') return MOCK_REPLY.INTERVIEW_SUMMARY;
  if (task === 'INTERVIEW_FINAL') return MOCK_REPLY.INTERVIEW_FINAL;
  return MOCK_REPLY.TWIN;
}

/** 从各协议错误响应体里提取可读信息 */
function extractProviderError(provider, bodyText) {
  try {
    const v = JSON.parse(bodyText);
    if (v && v.error) {
      if (typeof v.error === 'string') return v.error;
      if (v.error.message) return v.error.message;
    }
    if (v && v.message) return v.message;
  } catch { /* 原样截断返回 */ }
  return bodyText.slice(0, 200);
}

function statusHint(status) {
  if (status === 401 || status === 403) return '：密钥无效或无权限，请检查 API Key';
  if (status === 404) return '：地址或模型名不存在，请检查 API 地址与模型名';
  if (status === 413 || status === 400) return '：内容可能过长或参数有误，建议结束本场演练后新开一场，或减少素材';
  if (status === 429) return '：触发速率限制，稍后再试';
  if (status >= 500) return '：服务商暂时故障，稍后再试';
  return '';
}

/** 从服务商报错文本识别"当前模型不支持图片输入"，用于归纳管线自动降级重试 */
function looksLikeVisionUnsupported(errText) {
  const t = String(errText || '');
  return /image|multimodal|vision|视觉|图片|multimedia|input_type|not support|unsupported.*(content|modal)/i.test(t) && !/rate|limit|timeout|超时|429/i.test(t);
}

async function httpJson(url, headers, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    } catch (err) {
      if (err && (err.name === 'AbortError' || /abort/i.test(String(err)))) {
        throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）。可在设置中调大超时，或检查网络/代理。`);
      }
      const code = err && err.cause && err.cause.code ? err.cause.code : '';
      throw new Error('网络请求失败' + (code ? '（' + code + '）' : '') + '：请检查网络连接与 API 地址');
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      throw new Error(`API ${res.status}${statusHint(res.status)} ${extractProviderError('generic', text)}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 统一入口：按 settings.provider 分发到对应协议适配器。
 * opts: { temperature, maxTokens, timeoutMs, task(mock 用) }
 */
async function chat(settings, messages, opts = {}) {
  const temperature = typeof opts.temperature === 'number' ? opts.temperature : settings.temperature;
  const timeoutMs = opts.timeoutMs || settings.timeoutMs || 90000;
  if (settings.provider === 'mock') {
    await new Promise(r => setTimeout(r, 150));
    return mockRespond(messages, opts);
  }
  const adapter = ADAPTERS[settings.provider];
  if (!adapter) throw new Error(`不支持的 Provider：${settings.provider}，请到设置页重新选择`);
  if (adapter.needsKey && !settings.apiKey) {
    throw new Error(`未配置 ${adapter.label} 的 API Key，请到设置页填写，或切换到演示模式`);
  }
  const { url, headers, body } = adapter.build({ settings, messages, temperature, maxTokens: opts.maxTokens || settings.maxTokens });
  const data = await httpJson(url, headers, body, timeoutMs);
  return adapter.parse(data);
}

/** 拉取模型列表（azure 部署制不支持） */
async function fetchModels(settings) {
  const adapter = ADAPTERS[settings.provider];
  if (!adapter || !adapter.modelsUrl) throw new Error('该 Provider 不支持拉取模型列表（Azure 为部署制，请直接填部署地址）');
  const url = adapter.modelsUrl(settings);
  const headers = adapter.modelsHeaders(settings);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`API ${res.status}${statusHint(res.status)} ${extractProviderError('generic', text)}`);
    const list = adapter.parseModels(JSON.parse(text));
    if (!list.length) throw new Error('服务商返回了空模型列表');
    return list;
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('拉取模型列表超时');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 从 LLM 文本中鲁棒地提取 JSON（容忍多个代码围栏与前后说明；后出现的候选优先——真实结果惯例在后，示例在前） */
function extractJson(text) {
  if (!text) throw new Error('LLM 返回为空');
  const tryParse = (s) => { try { const v = JSON.parse(s); return (v !== null && typeof v === 'object') ? v : null; } catch { return null; } };
  const candidates = [];
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
  let m;
  while ((m = fenceRe.exec(text)) !== null) candidates.push(m[1].trim());
  candidates.push(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  for (let i = candidates.length - 1; i >= 0; i--) {
    const v = tryParse(candidates[i]);
    if (v) return v;
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i];
    const first = Math.min(...['{', '['].map(ch => { const idx = c.indexOf(ch); return idx === -1 ? Infinity : idx; }));
    if (first === Infinity) continue;
    const open = c[first];
    const close = open === '{' ? '}' : ']';
    const last = c.lastIndexOf(close);
    if (last > first) {
      const v = tryParse(c.slice(first, last + 1));
      if (v) return v;
    }
  }
  throw new Error('LLM 返回的 JSON 无法解析：' + String(text).slice(0, 160));
}

module.exports = {
  chat, extractJson, normalizeBaseUrl, mockRespond, extractProviderError,
  ADAPTERS, DEFAULT_BASE, fetchModels, splitSystem,
  hasImages, toOpenAIMessages, toAnthropicMessages, toGeminiContents, toOllamaMessages,
  looksLikeVisionUnsupported,
};
