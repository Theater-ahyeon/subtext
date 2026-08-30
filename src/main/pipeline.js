'use strict';
/**
 * 业务流水线：归纳 → 生境卡 → 演练 → 预测冻结 → 现实回流 → 差异归因 → 卡片更新。
 * 所有 LLM 调用集中在此，main.js 只做 IPC 编排。
 */
const { chat, extractJson } = require('./llm');
const P = require('./prompts');

// ---------- 证据归纳 ----------
function chunkEvidence(bundle, chunkSize = 40) {
  const chunks = [];
  const list = [...bundle.evidence].sort((a, b) => a.seq - b.seq);
  for (let i = 0; i < list.length; i += chunkSize) {
    chunks.push(list.slice(i, i + chunkSize));
  }
  return chunks;
}

function evidenceLine(e) {
  const ts = e.ts ? `[${e.ts.replace('T', ' ').slice(0, 16)}] ` : '';
  const who = e.sender ? `${e.sender}${e.isSelf === true ? '(用户本人)' : ''}: ` : '';
  return `E${e.seq} ${ts}${who}${e.text.replace(/\s+/g, ' ').slice(0, 500)}`;
}

async function inductEvidence(store, bundle, settings, { onProgress } = {}) {
  const chunks = chunkEvidence(bundle);
  if (!chunks.length) throw new Error('暂无素材，请先导入聊天记录或添加证据');
  let newClaims = 0, blanks = [];
  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) onProgress({ step: i + 1, total: chunks.length });
    const existing = bundle.claims.filter(c => c.epistemic !== 'blank').map(c => `- [${P.LAYER_NAMES[c.layer]}] ${c.text}`).join('\n');
    const prompt = P.inductionPrompt(bundle, chunks[i].map(evidenceLine), existing);
    const raw = await chat(settings, [{ role: 'user', content: prompt }], { temperature: settings.analysisTemperature, task: 'INDUCE' });
    const parsed = extractJson(raw);
    const idBySeq = new Map(chunks[i].map(e => ['E' + e.seq, e.id]));
    for (const c of (parsed.claims || []).slice(0, 8)) {
      if (!c || !c.text || !P.LAYER_NAMES[c.layer]) continue;
      const text = String(c.text).slice(0, 200);
      // 简单去重：与现有条目高度相似的跳过
      const dup = bundle.claims.some(x => similar(x.text, text));
      if (dup) continue;
      const refs = (Array.isArray(c.refs) ? c.refs : []).map(r => idBySeq.get(String(r).toUpperCase())).filter(Boolean);
      bundle.claims.push({
        id: require('./store').uid(), layer: c.layer, text,
        epistemic: c.epistemic === 'fact' ? 'fact' : 'inference',
        source: 'ai', refs, confidence: clamp01(c.confidence), note: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      newClaims++;
    }
    if (Array.isArray(parsed.blanks)) {
      for (const b of parsed.blanks.slice(0, 6)) {
        const text = String(b).slice(0, 120);
        if (!text) continue;
        if (bundle.claims.some(x => similar(x.text, text))) continue;
        bundle.claims.push({
          id: require('./store').uid(), layer: 'life', text,
          epistemic: 'blank', source: 'ai', refs: [], confidence: 0, note: '待了解', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
      }
    }
    store.savePerson(bundle);
  }
  return { newClaims, total: bundle.claims.length, chunks: chunks.length };
}

function similar(a, b) {
  const na = String(a).replace(/\s/g, ''), nb = String(b).replace(/\s/g, '');
  if (!na || !nb) return false;
  if (na === nb) return true;
  const short = Math.min(na.length, nb.length);
  if (short < 6) return false;
  let hits = 0;
  for (let i = 0; i + 3 <= nb.length; i += 2) {
    const g = nb.slice(i, i + 3);
    if (na.includes(g)) hits++;
  }
  return hits / Math.max(1, Math.floor(nb.length / 2)) > 0.7;
}

function clamp01(v) {
  const n = Number(v);
  if (isNaN(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

// ---------- 演练 ----------
async function startSession(store, bundle, settings, scenario) {
  const session = { id: require('./store').uid(), scenario: scenario || '', status: 'active', createdAt: new Date().toISOString(), endedAt: null, messages: [] };
  bundle.sessions.push(session);
  const sys = P.twinSystemPrompt(bundle, session.scenario);
  const reply = await chat(settings, [
    { role: 'system', content: sys },
    { role: 'user', content: '（演练开始，请以她的身份自然开场）' },
  ], { task: 'TWIN' });
  session.messages.push({ role: 'user', content: '（演练开始）', ts: new Date().toISOString() });
  session.messages.push({ role: 'twin', content: reply, ts: new Date().toISOString() });
  store.savePerson(bundle);
  return { session, reply };
}

async function twinTurn(store, bundle, settings, sessionId, userText) {
  const session = bundle.sessions.find(s => s.id === sessionId);
  if (!session) throw new Error('演练会话不存在');
  if (session.status !== 'active') throw new Error('该演练已结束');
  session.messages.push({ role: 'user', content: userText, ts: new Date().toISOString() });
  const sys = P.twinSystemPrompt(bundle, session.scenario);
  const history = session.messages.map(m => ({ role: m.role === 'twin' ? 'assistant' : 'user', content: m.content }));
  const reply = await chat(settings, [{ role: 'system', content: sys }, ...history], { task: 'TWIN' });
  session.messages.push({ role: 'twin', content: reply, ts: new Date().toISOString() });
  store.savePerson(bundle);
  return reply;
}

function sessionTranscript(session, max = 60) {
  return session.messages
    .filter(m => m.role !== 'system')
    .slice(-max)
    .map(m => (m.role === 'twin' ? '她: ' : '用户: ') + m.content)
    .join('\n\n');
}

async function endSession(store, bundle, settings, sessionId) {
  const session = bundle.sessions.find(s => s.id === sessionId);
  if (!session) throw new Error('演练会话不存在');
  session.status = 'ended';
  session.endedAt = new Date().toISOString();
  const report = await chat(settings, [
    { role: 'user', content: P.reviewPrompt(bundle, sessionTranscript(session)) },
  ], { task: 'REVIEW', temperature: settings.analysisTemperature });
  if (!bundle.sessionReports) bundle.sessionReports = [];
  bundle.sessionReports.push({ sessionId, report, ts: new Date().toISOString() });
  store.savePerson(bundle);
  return report;
}

// ---------- 预测冻结 / 现实回流 / 归因 ----------
async function freezePrediction(store, bundle, settings, sessionId) {
  const session = bundle.sessions.find(s => s.id === sessionId);
  if (!session) throw new Error('演练会话不存在');
  const raw = await chat(settings, [
    { role: 'user', content: P.hypothesisPrompt(bundle, sessionTranscript(session)) },
  ], { task: 'HYPOTHESIS', temperature: settings.analysisTemperature });
  const parsed = extractJson(raw);
  const prediction = {
    id: require('./store').uid(), sessionId,
    hypotheses: (parsed.hypotheses || []).map(h => ({
      text: String(h.text || ''), prob: clamp01(h.prob), basis: String(h.basis || ''), verify: String(h.verify || ''),
    })).filter(h => h.text),
    expected: String(parsed.expected || ''),
    frozenAt: new Date().toISOString(), status: 'open',
  };
  bundle.predictions.push(prediction);
  store.savePerson(bundle);
  return prediction;
}

async function submitFeedback(store, bundle, settings, { predictionId, raw }) {
  const feedback = { id: require('./store').uid(), predictionId: predictionId || null, sessionId: null, raw, createdAt: new Date().toISOString() };
  if (predictionId) {
    const pred = bundle.predictions.find(p => p.id === predictionId);
    if (pred) {
      pred.status = 'attributed';
      feedback.sessionId = pred.sessionId;
    }
  }
  // 现实反应本身也是证据
  store.addEvidence(bundle, { sourceType: 'feedback', text: raw, ts: new Date().toISOString(), sender: bundle.name, isSelf: false });
  let transcript = '';
  if (feedback.sessionId) {
    const session = bundle.sessions.find(s => s.id === feedback.sessionId);
    if (session) transcript = sessionTranscript(session, 30);
  }
  const pred = predictionId ? bundle.predictions.find(p => p.id === predictionId) : null;
  const rawAttr = await chat(settings, [
    { role: 'user', content: P.attributionPrompt(bundle, pred, raw, transcript) },
  ], { task: 'ATTRIBUTION', temperature: settings.analysisTemperature });
  const attr = extractJson(rawAttr);
  const applied = applyUpdates(bundle, attr.updates || []);
  const record = {
    id: require('./store').uid(), feedbackId: feedback.id, predictionId: predictionId || null,
    verdict: ['hit', 'partial', 'miss', 'fact-error', 'material-missing', 'temperament-error', 'expression-error'].includes(attr.verdict) ? attr.verdict : 'miss',
    analysis: String(attr.analysis || ''), updates: applied, createdAt: new Date().toISOString(),
  };
  bundle.attributions.push(record);
  bundle.feedbacks.push(feedback);
  store.savePerson(bundle);
  return { record, applied };
}

/** 应用归因产生的卡片更新（最小修正，可解释可回滚——旧值进 note） */
function applyUpdates(bundle, updates) {
  const applied = [];
  for (const u of updates.slice(0, 6)) {
    try {
      if (u.action === 'add' && u.text && P.LAYER_NAMES[u.layer]) {
        const c = bundle.claims.find(x => similar(x.text, u.text));
        if (!c) {
          bundle.claims.push({
            id: require('./store').uid(), layer: u.layer, text: String(u.text).slice(0, 200),
            epistemic: 'inference', source: 'ai', refs: [], confidence: 0.6,
            note: '来自现实反馈归因: ' + String(u.reason || '').slice(0, 100),
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          });
          applied.push({ action: 'add', layer: u.layer, text: u.text });
        }
      } else if (u.action === 'update' && u.claimId && u.text) {
        const c = bundle.claims.find(x => x.id === u.claimId);
        if (c) {
          c.note = (c.note ? c.note + ' | ' : '') + `原: ${c.text}`;
          c.text = String(u.text).slice(0, 200);
          c.updatedAt = new Date().toISOString();
          applied.push({ action: 'update', claimId: c.id, text: c.text });
        }
      } else if (u.action === 'deprecate' && u.claimId) {
        const c = bundle.claims.find(x => x.id === u.claimId);
        if (c) {
          c.confidence = Math.max(0.05, (c.confidence || 0.5) - 0.3);
          c.note = (c.note ? c.note + ' | ' : '') + '归因标记不可靠: ' + String(u.reason || '').slice(0, 100);
          c.updatedAt = new Date().toISOString();
          applied.push({ action: 'deprecate', claimId: c.id });
        }
      }
    } catch { /* 单条更新失败不影响整体 */ }
  }
  return applied;
}

// ---------- 话题雷达（规则版：空白 + 待确认 → 可验证的问题） ----------
function topicRadar(bundle) {
  const blanks = bundle.claims.filter(c => c.epistemic === 'blank').slice(0, 12);
  const items = blanks.map(c => ({ from: '生境卡空白', text: c.text }));
  if (bundle.interview && Array.isArray(bundle.interview.suggestions)) {
    // final 中"仍待确认"的问题不结构化存储，用 records 中标注暂未确定的
  }
  for (const [qid, r] of Object.entries(bundle.interview.records || {})) {
    const note = r.note || '';
    if (/暂未确定|待确认/.test(note + (r.answer || ''))) {
      items.push({ from: `访谈Q${qid}待确认`, text: (r.answer || note).slice(0, 120) });
    }
  }
  return items;
}

// ---------- 24问访谈 ----------
function recordsDigest(records) {
  const lines = [];
  for (const qid of Object.keys(records).map(Number).sort((a, b) => a - b)) {
    const r = records[qid];
    lines.push(`Q${qid}(${r.question.slice(0, 18)}…): ${r.answer || '（跳过）'}` + (r.probeAnswer ? `｜追问: ${r.probeAnswer}` : ''));
  }
  return lines.join('\n');
}

async function interviewAnswer(store, bundle, settings, { qid, answer, skipped }) {
  const iv = bundle.interview;
  iv.started = true;
  const q = P.INTERVIEW_QUESTIONS.find(x => x.qid === qid);
  if (!q) throw new Error('问题不存在');
  const record = iv.records[qid] || { qid, question: q.text, answer: '', probe: null, probeAnswer: '', note: '', ts: new Date().toISOString() };
  if (skipped) {
    record.note = '暂未确定';
    iv.records[qid] = record;
    iv.currentQ = nextQ(iv);
    iv.updatedAt = new Date().toISOString();
    store.savePerson(bundle);
    return { record, nextQ: iv.currentQ, probe: null };
  }
  record.answer = answer;
  // 判断是否需要追问
  let probe = null;
  const digest = recordsDigest(Object.assign({}, iv.records, { [qid]: record }));
  const raw = await chat(settings, [
    { role: 'user', content: P.interviewProbePrompt(qid, q.text, answer, digest) },
  ], { task: 'INTERVIEW_PROBE', temperature: settings.analysisTemperature });
  const cleaned = raw.trim();
  if (cleaned && !/^ok$/i.test(cleaned)) probe = cleaned.slice(0, 300);
  record.probe = probe;
  iv.records[qid] = record;
  if (!probe) iv.currentQ = nextQ(iv);
  iv.updatedAt = new Date().toISOString();
  store.savePerson(bundle);
  return { record, nextQ: iv.currentQ, probe };
}

async function interviewProbeAnswer(store, bundle, settings, { qid, answer }) {
  const iv = bundle.interview;
  const record = iv.records[qid];
  if (!record) throw new Error('记录不存在');
  if (answer && answer.trim()) record.probeAnswer = answer.trim();
  iv.currentQ = nextQ(iv);
  iv.updatedAt = new Date().toISOString();
  store.savePerson(bundle);
  return { record, nextQ: iv.currentQ };
}

function nextQ(iv) {
  for (let i = 1; i <= 24; i++) {
    if (!iv.records[i] || (!iv.records[i].answer && iv.records[i].note !== '暂未确定')) return i;
  }
  return 25; // 全部完成
}

async function interviewSummary(store, bundle, settings) {
  const digest = recordsDigest(bundle.interview.records);
  if (!digest) throw new Error('还没有任何访谈记录');
  const raw = await chat(settings, [
    { role: 'user', content: P.interviewSummaryPrompt(digest) },
  ], { task: 'INTERVIEW_SUMMARY', temperature: settings.analysisTemperature });
  bundle.interview.summaries.push({ text: raw, ts: new Date().toISOString() });
  store.savePerson(bundle);
  return raw;
}

async function interviewFinalize(store, bundle, settings) {
  const digest = recordsDigest(bundle.interview.records);
  if (!digest) throw new Error('还没有任何访谈记录');
  const raw = await chat(settings, [
    { role: 'user', content: P.interviewFinalPrompt(digest) },
  ], { task: 'INTERVIEW_FINAL', temperature: settings.analysisTemperature });
  const parsed = extractJson(raw);
  bundle.interview.final = { text: String(parsed.final || raw), ts: new Date().toISOString() };
  bundle.interview.suggestions = (parsed.suggestions || []).map(s => ({
    layer: P.LAYER_NAMES[s.layer] ? s.layer : 'temperament',
    text: String(s.text || '').slice(0, 200),
    kind: s.kind === 'fact' ? 'fact' : 'inference',
    written: false,
  }));
  store.savePerson(bundle);
  return { final: bundle.interview.final, suggestions: bundle.interview.suggestions };
}

/** 将勾选的访谈建议写入生境卡（来源=用户陈述） */
function interviewWriteClaims(store, bundle, indexes) {
  const written = [];
  for (const i of indexes) {
    const s = bundle.interview.suggestions[i];
    if (!s || s.written) continue;
    const dup = bundle.claims.some(x => similar(x.text, s.text));
    if (dup) { s.written = true; continue; }
    bundle.claims.push({
      id: require('./store').uid(), layer: s.layer, text: s.text,
      epistemic: s.kind === 'fact' ? 'fact' : 'inference', source: 'user', refs: [],
      confidence: s.kind === 'fact' ? 0.85 : 0.6,
      note: '来自24问访谈', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    s.written = true;
    written.push(s.text);
  }
  store.savePerson(bundle);
  return written;
}

module.exports = {
  inductEvidence, startSession, twinTurn, endSession, sessionTranscript,
  freezePrediction, submitFeedback, applyUpdates, topicRadar,
  interviewAnswer, interviewProbeAnswer, interviewSummary, interviewFinalize, interviewWriteClaims,
  chunkEvidence, evidenceLine, similar, clamp01,
};
