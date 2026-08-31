'use strict';
/* 演练 · 常量：导航、术语映射、场景模板、服务商元信息 */
(() => {
  const HB = (window.HB = window.HB || {});

  HB.C = {
    LAYER_NAMES: { basic: '基础信息', life: '生活结构', temperament: '人物性情', expression: '场景表达' },
    EPI_NAMES: { fact: '事实', inference: '推断', blank: '空白' },
    SRC_NAMES: { evidence: '证据支持', user: '用户陈述', ai: 'AI推断' },
    VERDICT_NAMES: {
      hit: '命中', partial: '部分命中', miss: '未命中', 'fact-error': '事实层错误',
      'material-missing': '材料缺失', 'temperament-error': '性情推断错', 'expression-error': '表达偏差',
      'model-bias': '扮演偏差',
    },

    PROFILE_SLOTS: [
      { key: 'gender', label: '性别', type: 'single' },
      { key: 'birthday', label: '生日 / 年龄', type: 'single' },
      { key: 'occupation', label: '职业', type: 'single' },
      { key: 'location', label: '所在地', type: 'single' },
      { key: 'family', label: '家庭', type: 'multi' },
      { key: 'hobbies', label: '爱好', type: 'multi' },
      { key: 'foods', label: '喜爱的食物', type: 'multi' },
      { key: 'likes', label: '喜欢', type: 'multi' },
      { key: 'dislikes', label: '讨厌 / 雷区', type: 'multi' },
    ],

    NAV: [
      { id: 'home', label: '关系', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5"/></svg>' },
      { id: 'graph', label: '关系图谱', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="6" cy="6" r="2.6"/><circle cx="18" cy="5" r="2.6"/><circle cx="12" cy="18" r="2.6"/><path d="M7.8 7.6 10.8 16M16.2 7 13.2 16M8.5 6h7"/></svg>' },
      { id: 'card', label: '理解卡', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>' },
      { id: 'evidence', label: '原话库', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 3h9l4 4v14H6z"/><path d="M9 12h6M9 16h6"/></svg>' },
      { id: 'import', label: '导入', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4v10m0 0 4-4m-4 4-4-4"/><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/></svg>' },
      { id: 'interview', label: '24 问', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.8.35-1.4.9-1.4 1.7v.5"/><circle cx="11.5" cy="17" r=".6" fill="currentColor"/></svg>' },
      { id: 'rehearsal', label: '演练', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a8 8 0 1 1-3.2-6.4L21 5l-.6 3.4A8 8 0 0 1 21 12Z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/></svg>' },
      { id: 'calibration', label: '对照复盘', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 3v4h-4"/></svg>' },
      { id: 'analysis', label: '深度分析', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/><path d="M8 11h6M11 8v6"/></svg>' },
      { id: 'settings', label: '设置', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"/></svg>' },
    ],

    SCENARIOS: [
      { id: 'custom', label: '自定义', text: '' },
      { id: 'daily', label: '日常闲聊', text: '一段日常的聊天，轻松自然，最近有一周没联系了。' },
      { id: 'date', label: '初次约会', text: '第一次正式约会后的散步，气氛还行，你想进一步了解她。' },
      { id: 'cold', label: '化解冷战', text: '你们因为一件小事冷战了三天，你主动来找她。' },
      { id: 'sorry', label: '道歉', text: '你之前说错了话伤了她的感受，现在当面道歉。' },
      { id: 'talk', label: '重要谈话', text: '有一件重要但可能让她不舒服的事需要当面沟通。' },
      { id: 'ask', label: '提出请求', text: '你需要请她帮一个不太小的忙，不确定她是否愿意。' },
    ],

    PROVIDER_META: {
      mock: { label: '演示模式（离线内置样例回复）', note: '无需任何配置，可体验全部流程。' },
      openai: {
        label: 'OpenAI 兼容（ChatGPT / DeepSeek / Kimi / GLM / Qwen / OpenRouter / OneAPI 等网关）',
        urlPh: '留空 = https://api.openai.com/v1；其他网关填到 /v1（自动补全 /chat/completions）',
        modelPh: 'gpt-4o-mini / deepseek-chat / moonshot-v1-8k / glm-4.7 …',
        key: true,
        note: '绝大多数国产模型与中转网关都是这个格式。',
      },
      azure: {
        label: 'Azure OpenAI',
        urlPh: '完整部署地址：https://资源名.openai.azure.com/openai/deployments/部署名/chat/completions?api-version=2024-10-21',
        modelPh: '（无需填写：部署名在地址中）',
        key: true,
        note: '填 Azure 资源的密钥（Azure Portal → Keys and Endpoint）。',
      },
      anthropic: {
        label: 'Anthropic Claude',
        urlPh: '留空 = https://api.anthropic.com',
        modelPh: 'claude-sonnet-4-5 / claude-opus-4-6 …',
        key: true,
        note: '使用 Messages API（x-api-key 头）。',
      },
      gemini: {
        label: 'Google Gemini',
        urlPh: '留空 = https://generativelanguage.googleapis.com',
        modelPh: 'gemini-2.5-flash / gemini-2.5-pro …',
        key: true,
        note: '使用 Google AI generateContent 原生协议（x-goog-api-key 头）。',
      },
      ollama: {
        label: 'Ollama 本地模型（完全离线，隐私最优）',
        urlPh: '留空 = http://localhost:11434',
        modelPh: 'llama3.3 / qwen3:14b …（本地已 pull 的模型）',
        key: false,
        note: '无需密钥。数据全程不出本机——与"本地优先"红线最契合的接入方式。',
      },
    },
  };
})();
