'use strict';
/**
 * LLM Provider 抽象层。
 * - openai：任意 OpenAI 兼容接口（baseUrl + key + model）
 * - mock：确定性演示模式，离线可跑通全部流程
 * opts.task 用于 mock 分流，真实 provider 忽略。
 */

const MOCK_REPLY = {
  TWIN: '（她抬起头，把手机扣在桌上）「……所以你今天找我，是有事吧？」',
  REVIEW: [
    '## 复盘报告（演示模式）',
    '### 一、孪生演绎质量',
    '- 连续性：本轮扮演与生境卡中的性情倾向一致，未出现性格漂移。',
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
    '- 她最近的作息压力来源（生境卡中缺失）——下次聊天可以自然带出。',
  ].join('\n'),
  HYPOTHESIS: JSON.stringify({
    hypotheses: [
      { text: '她最近在忙一件不想多谈的事，回复变短是自我保护，不是对你不满', prob: 0.45, basis: '生境卡性情层：压力期倾向于收缩表达', verify: '聊轻松话题时观察她是否恢复平时句长' },
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
    blanks: ['她作息与工作压力来源', '她对哪些话题明显更有兴趣'],
  }),
  INTERVIEW_PROBE: '这个说法具体会表现成什么行为？例如她最近一次让你产生这种感觉，是发生了什么？',
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
  if (task === 'INTERVIEW_SUMMARY') return MOCK_REPLY.INTERVIEW_SUMMARY;
  if (task === 'INTERVIEW_FINAL') return MOCK_REPLY.INTERVIEW_FINAL;
  return MOCK_REPLY.TWIN;
}

function normalizeBaseUrl(url) {
  let u = (url || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (/\/openai\/deployments\//.test(u) || /azure\.com/i.test(u)) {
    throw new Error('暂不支持 Azure 原生端点，请使用 OpenAI 兼容网关地址（以 /v1 结尾或包含 /v1/chat/completions）');
  }
  // 带查询参数的地址（如 ?api-key=…）：路径补全后把查询串接回
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

async function chat(settings, messages, opts = {}) {
  const temperature = typeof opts.temperature === 'number' ? opts.temperature : settings.temperature;
  const timeoutMs = opts.timeoutMs || settings.timeoutMs || 90000;
  if (settings.provider === 'mock') {
    await new Promise(r => setTimeout(r, 150));
    return mockRespond(messages, opts);
  }
  const url = normalizeBaseUrl(settings.baseUrl);
  if (!url) throw new Error('API 地址为空，请到设置页配置');
  if (!settings.apiKey) throw new Error('未配置 API Key，请到设置页配置，或切换到演示模式');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + settings.apiKey },
        body: JSON.stringify({ model: settings.model, messages, temperature, stream: false }),
        signal: ctrl.signal,
      });
    } catch (err) {
      if (err && (err.name === 'AbortError' || /abort/i.test(String(err)))) {
        throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）。可在设置中调大超时，或检查网络/代理。`);
      }
      const code = err && err.cause && err.cause.code ? err.cause.code : '';
      throw new Error('网络请求失败' + (code ? '（' + code + '）' : '') + '：请检查网络连接与 API 地址');
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let hint = '';
      if (res.status === 401 || res.status === 403) hint = '：请检查 API Key';
      else if (res.status === 404) hint = '：请检查 API 地址与模型名';
      else if (res.status === 413 || res.status === 400) hint = '：内容可能过长，建议结束本场演练后新开一场，或减少素材';
      else if (res.status === 429) hint = '：触发速率限制，稍后再试';
      throw new Error(`API ${res.status}${hint} ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error('API 返回为空');
    return content;
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
  // 后→前尝试：模型常先回显格式示例再给真实结果
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

module.exports = { chat, extractJson, normalizeBaseUrl, mockRespond };
