'use strict';
/**
 * 事件记忆（episodic memory）：
 *  - 粒度 = 事件段：一次演练由 LLM 提取 2~5 条事件句；一次现实对照记录 1 条真实反应原话
 *  - 向量：优先服务商 embedding（openai 兼容 / gemini / ollama）；不可用或失败时
 *    降级为本地词面 hash 向量（离线可用，结果标记 fallback，UI 如实提示）
 *  - 检索：单人物规模（数百~数千条）暴力余弦足够，不引入向量库依赖
 *  - 溯源红线：每条记忆必须挂 ref（演练场次 / 证据编号 / 预判 id），可查看、可删除、可重建
 */
const { uid, now } = require('./store');

const DIM = 128;
const MIN_SCORE = 0.22;      // 相似度阈值：低于此不召回（宁缺勿滥）
const MAX_ITEMS = 2000;      // 单人物记忆上限（超过时最旧的不再新增提示用户清理）
const MAX_TEXT = 300;

// ---------- 本地词面向量（离线降级） ----------
/** 字符 unigram(1)+bigram(2) 哈希向量：确定性、无需网络；对中文短文本的粗检索足够用 */
function hashEmbed(text, dim = DIM) {
  const v = new Float32Array(dim);
  const t = String(text || '').toLowerCase().replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, '');
  const add = (g, w) => {
    let h = 2166136261;
    for (let j = 0; j < g.length; j++) { h ^= g.charCodeAt(j); h = Math.imul(h, 16777619); }
    const idx = Math.abs(h) % dim;
    v[idx] += w;
  };
  for (let i = 0; i < t.length; i++) add(t[i], 1);
  for (let i = 0; i + 2 <= t.length; i++) add(t.slice(i, i + 2), 2);
  return l2(v);
}
function l2(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= s;
  return v;
}
function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function f32ToB64(v) { return Buffer.from(new Float32Array(v).buffer).toString('base64'); }
function b64ToF32(s) {
  const buf = Buffer.from(String(s), 'base64');
  // Buffer 的 ArrayBuffer 可能被池化（byteOffset ≠ 0），必须按偏移与长度切视图
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

// ---------- embedding 设置解析 ----------
/** 留空 = 跟随主 provider（仅 openai 兼容 / gemini / ollama 有 embedding 端点）；不可用返回 null → 降级 */
function resolveEmbedSettings(settings) {
  const p = (settings.embedProvider || '').trim() ||
    (['openai', 'gemini', 'ollama'].includes(settings.provider) ? settings.provider : '');
  if (!p) return null;
  const base = (settings.embedBaseUrl || '').trim();
  const model = (settings.embedModel || '').trim();
  if (p !== 'ollama' && !model) return null; // 除 ollama 外必须填模型名
  return {
    provider: p,
    baseUrl: base,
    model,
    apiKey: (settings.embedApiKey || '').trim(),
    timeoutMs: settings.timeoutMs || 90000,
  };
}
function embedIdOf(es) { return es ? `${es.provider}:${es.model}` : 'local:hash'; }

// ---------- 服务商 embedding ----------
const JSON_HEADERS = { 'Content-Type': 'application/json' };
async function httpJson(url, headers, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`Embedding API ${res.status} ${text.slice(0, 160)}`);
    return JSON.parse(text);
  } finally { clearTimeout(timer); }
}

/** 返回 { vecs: Float32Array[], model }；失败抛错，由调用方决定是否降级 */
async function providerEmbed(es, texts) {
  if (es.provider === 'openai') {
    const base = (es.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '').replace(/\/embeddings$/, '');
    const url = (/\/v\d+(beta)?$/.test(base) ? base : base + '/v1') + '/embeddings';
    const data = await httpJson(url, { ...JSON_HEADERS, Authorization: 'Bearer ' + es.apiKey }, { model: es.model, input: texts }, es.timeoutMs);
    const vecs = (data.data || []).map(d => l2(new Float32Array(d.embedding)));
    if (vecs.length !== texts.length) throw new Error('embedding 返回数量不符');
    return vecs;
  }
  if (es.provider === 'ollama') {
    const base = (es.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
    const data = await httpJson(base + '/api/embed', JSON_HEADERS, { model: es.model, input: texts }, es.timeoutMs);
    const vecs = (data.embeddings || []).map(v => l2(new Float32Array(v)));
    if (vecs.length !== texts.length) throw new Error('embedding 返回数量不符');
    return vecs;
  }
  if (es.provider === 'gemini') {
    const base = (es.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
    const url = base + '/v1beta/models/' + encodeURIComponent(es.model) + ':batchEmbedContents';
    const data = await httpJson(url, { ...JSON_HEADERS, 'x-goog-api-key': es.apiKey }, {
      requests: texts.map(t => ({ model: 'models/' + es.model, content: { parts: [{ text: t }] } })),
    }, es.timeoutMs);
    const vecs = (data.embeddings || []).map(e => l2(new Float32Array(e.values)));
    if (vecs.length !== texts.length) throw new Error('embedding 返回数量不符');
    return vecs;
  }
  throw new Error('该 Provider 不支持 embedding');
}

// ---------- 存储结构 ----------
function ensureMemories(bundle) {
  if (!bundle.memories || !Array.isArray(bundle.memories.items)) {
    bundle.memories = { version: 1, model: '', dim: DIM, items: [], ledger: {} };
  }
  if (!bundle.memories.ledger) bundle.memories.ledger = {};
  return bundle.memories;
}

/** 当前 embedding 设置与记忆库的模型不一致时返回 true（需要重建） */
function needsRebuild(bundle, settings) {
  const m = ensureMemories(bundle);
  const es = resolveEmbedSettings(settings);
  const id = embedIdOf(es);
  return m.items.length > 0 && m.model !== id;
}

/** 用当前设置给一批文本算向量；服务商失败自动降级本地向量（结果如实标记） */
async function embedTexts(bundle, settings, texts) {
  const es = resolveEmbedSettings(settings);
  const mem = ensureMemories(bundle);
  if (es) {
    try {
      const vecs = await providerEmbed(es, texts);
      const model = embedIdOf(es);
      if (mem.model && mem.model !== model) mem.stale = true;
      mem.model = model;
      mem.dim = vecs[0].length;
      return { vecs, fallback: false, model };
    } catch (err) {
      // 服务商失败 → 本地降级（不静默：调用方拿到 fallback 标记用于 UI 提示）
      const vecs = texts.map(t => hashEmbed(t));
      mem.model = 'local:hash';
      mem.dim = DIM;
      return { vecs, fallback: true, model: 'local:hash', error: String(err && err.message || err).slice(0, 160) };
    }
  }
  const vecs = texts.map(t => hashEmbed(t));
  mem.model = 'local:hash';
  mem.dim = DIM;
  return { vecs, fallback: true, model: 'local:hash' };
}

/** 写入事件（已去重、已截断）；返回新增条数 */
async function writeEvents(bundle, settings, { kind, events, ref }) {
  const mem = ensureMemories(bundle);
  const clean = [];
  for (const e of (events || []).slice(0, 6)) {
    const text = String(e && e.text || '').trim().slice(0, MAX_TEXT);
    if (!text) continue;
    if (mem.items.some(i => i.text === text)) continue;
    clean.push({ text, ts: (e && e.ts) || now() });
  }
  if (!clean.length) return { added: 0, fallback: false };
  if (mem.items.length >= MAX_ITEMS) return { added: 0, fallback: false, full: true };
  const { vecs, fallback, error } = await embedTexts(bundle, settings, clean.map(c => c.text));
  for (let i = 0; i < clean.length; i++) {
    mem.items.push({
      id: uid(), kind, text: clean[i].text, ts: clean[i].ts,
      ref: ref || {}, vec: f32ToB64(vecs[i]), createdAt: now(),
    });
  }
  return { added: clean.length, fallback, error };
}

/** 演练结束：LLM 提取事件句并写入（ledger 防重复记忆同一场） */
async function rememberSession(store, bundle, settings, session, { chat, extractJson, P }) {
  const mem = ensureMemories(bundle);
  if (mem.ledger[session.id]) return { added: 0, skipped: true };
  const transcript = session.messages
    .filter(m => m.role !== 'system')
    .slice(-40)
    .map(m => (m.role === 'twin' ? '她: ' : '用户: ') + String(m.content).replace(/\r?\n+/g, ' '))
    .join('\n');
  let events = [];
  if (settings.provider !== 'mock') {
    try {
      const raw = await chat(settings, [{ role: 'user', content: P.eventExtractPrompt(session.scenario, transcript) }], { task: 'MEMORY', temperature: 0.2 });
      const parsed = extractJson(raw);
      events = (parsed.events || []).slice(0, 5);
    } catch { events = naiveEvents(session); }
  } else {
    events = naiveEvents(session);
  }
  const r = await writeEvents(bundle, settings, {
    kind: 'rehearsal',
    events: events.map(e => ({ text: typeof e === 'string' ? e : e && e.text, ts: session.endedAt || now() })),
    ref: { sessionId: session.id },
  });
  mem.ledger[session.id] = true;
  store.savePerson(bundle);
  return { ...r, events: events.length };
}

/** 无网络/失败时的兜底提取：取首条用户消息与末条模拟回应作极简事件（明确弱于 LLM 版本） */
function naiveEvents(session) {
  const users = session.messages.filter(m => m.role === 'user' && !/^\（演练开始）$/.test(m.content));
  const twins = session.messages.filter(m => m.role === 'twin');
  const out = [];
  if (users[0]) out.push({ text: '演练「' + String(session.scenario || '未命名').slice(0, 30) + '」：用户说了「' + users[0].content.slice(0, 60) + '」' });
  if (twins[twins.length - 1]) out.push({ text: '演练末尾她的回应：「' + twins[twins.length - 1].content.slice(0, 60) + '」' });
  return out.slice(0, 2);
}

/** 现实对照：真实反应原话入记忆（引用证据编号） */
async function rememberReality(store, bundle, settings, { text, ref }) {
  const r = await writeEvents(bundle, settings, {
    kind: 'reality',
    events: [{ text, ts: now() }],
    ref: ref || {},
  });
  store.savePerson(bundle);
  return r;
}

/** 检索：返回 { items:[{id,kind,text,ts,ref,score}], fallback, stale } */
async function recall(bundle, settings, query, { k = 4 } = {}) {
  const mem = ensureMemories(bundle);
  if (!query.trim() || !mem.items.length) return { items: [], fallback: false, stale: false };
  const es = resolveEmbedSettings(settings);
  let qvec = null, fallback = false;
  if (es) {
    try {
      const vecs = await providerEmbed(es, [query]);
      qvec = vecs[0];
    } catch { fallback = true; }
  } else fallback = true;
  if (!qvec) qvec = hashEmbed(query);
  const modelMismatch = mem.model && mem.model !== embedIdOf(es);
  // 阈值：真实 embedding 语义空间分得更开（0.25）；本地词面向量噪声高（0.22），宁可多召回由排序兜底
  const minScore = fallback ? 0.22 : 0.25;
  const scored = [];
  for (const it of mem.items) {
    if (!it.vec) continue;
    let v;
    try { v = b64ToF32(it.vec); } catch { continue; }
    if (v.length !== qvec.length) continue; // 维度不一致（模型换过）→ 需重建
    const score = cosine(qvec, v);
    if (score >= minScore) scored.push({ score, item: it });
  }
  scored.sort((a, b) => b.score - a.score);
  return {
    items: scored.slice(0, k).map(s => ({
      id: s.item.id, kind: s.item.kind, text: s.item.text, ts: s.item.ts, ref: s.item.ref,
      score: Math.round(s.score * 100) / 100,
    })),
    fallback, stale: modelMismatch,
  };
}

/** 列表（给管理面板；不返回向量） */
function list(bundle) {
  const mem = ensureMemories(bundle);
  return {
    model: mem.model, stale: !!mem.stale, total: mem.items.length,
    items: mem.items.slice().reverse().map(i => ({ id: i.id, kind: i.kind, text: i.text, ts: i.ts, ref: i.ref })),
  };
}
function remove(bundle, memoryId) {
  const mem = ensureMemories(bundle);
  const before = mem.items.length;
  mem.items = mem.items.filter(i => i.id !== memoryId);
  return before - mem.items.length;
}
function clear(bundle) {
  bundle.memories = { version: 1, model: '', dim: DIM, items: [], ledger: {} };
}
/** 重建：按当前 embedding 设置重算全部向量 */
async function rebuild(store, bundle, settings) {
  const mem = ensureMemories(bundle);
  if (!mem.items.length) { store.savePerson(bundle); return { rebuilt: 0, fallback: false }; }
  const texts = mem.items.map(i => i.text);
  const { vecs, fallback, model } = await embedTexts(bundle, settings, texts);
  mem.items.forEach((it, i) => { it.vec = f32ToB64(vecs[i]); });
  mem.model = model;
  mem.stale = false;
  store.savePerson(bundle);
  return { rebuilt: mem.items.length, fallback };
}

module.exports = {
  DIM, MIN_SCORE, hashEmbed, cosine, f32ToB64, b64ToF32,
  resolveEmbedSettings, embedIdOf, providerEmbed, embedTexts,
  ensureMemories, needsRebuild, writeEvents, rememberSession, rememberReality,
  recall, list, remove, clear, rebuild, naiveEvents,
};
