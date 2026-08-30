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
  let newClaims = 0, mergedDups = 0, blanks = [];
  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) onProgress({ step: i + 1, total: chunks.length });
    const existing = bundle.claims.filter(c => c.epistemic !== 'blank').map(c => `- [${P.LAYER_NAMES[c.layer]}] ${c.text}`).join('\n');
    const prompt = P.inductionPrompt(bundle, chunks[i].map(evidenceLine), existing);
    const raw = await chat(settings, [{ role: 'user', content: prompt }], { temperature: settings.analysisTemperature, task: 'INDUCE' });
    const parsed = extractJson(raw);
    const idBySeq = new Map(chunks[i].map(e => ['E' + e.seq, e.id]));
    for (const c of (parsed.claims || []).slice(0, 8)) {
      if (!c || !c.text || !P.LAYER_NAMES[c.layer]) continue;
      const text = clampText(c.text, 200);
      const refs = (Array.isArray(c.refs) ? c.refs : []).map(r => idBySeq.get(String(r).toUpperCase())).filter(Boolean);
      // 证据链纪律：无溯源引用的条目不得以"事实"入库（防提示注入伪造事实）
      const epistemic = (c.epistemic === 'fact' && refs.length) ? 'fact' : 'inference';
      const dup = bundle.claims.find(x => similar(x.text, text) && x.epistemic !== 'blank');
      if (dup) {
        // 重复不丢弃而是合并：跨场景复现提升置信度并留痕
        dup.confidence = clamp01(Math.max(dup.confidence || 0, Number(c.confidence) || 0.5) + 0.05);
        if (!/复现于新素材/.test(dup.note || '')) dup.note = (dup.note ? dup.note + ' | ' : '') + '复现于新素材';
        dup.updatedAt = new Date().toISOString();
        mergedDups++;
        continue;
      }
      bundle.claims.push({
        id: require('./store').uid(), layer: c.layer, text,
        epistemic, source: 'ai', refs, confidence: clamp01(c.confidence),
        note: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      newClaims++;
    }
    if (Array.isArray(parsed.blanks)) {
      for (const b of parsed.blanks.slice(0, 6)) {
        const text = clampText(typeof b === 'string' ? b : b && b.text, 120);
        if (!text) continue;
        const layer = (typeof b === 'object' && b && P.LAYER_NAMES[b.layer]) ? b.layer : 'life';
        if (bundle.claims.some(x => similar(x.text, text))) continue;
        bundle.claims.push({
          id: require('./store').uid(), layer, text,
          epistemic: 'blank', source: 'ai', refs: [], confidence: 0, note: '待了解', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
      }
    }
    store.savePerson(bundle);
  }
  return { newClaims, mergedDups, total: bundle.claims.length, chunks: chunks.length };
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

const clampText = (v, n) => String(v == null ? '' : v).slice(0, n);

// ---------- 演练 ----------
async function startSession(store, bundle, settings, scenario, goal) {
  if (P.redlineCheck(scenario || '')) throw new Error('场景包含操控/打压/伤害类内容，本工具不提供此类演练。请改写为中性情境描述，例如"你们因小事冷战三天，你想修复关系"。');
  if (P.redlineCheck(goal || '')) throw new Error('演练目标包含操控/打压/伤害类内容，本工具不提供此类演练。目标请写成你想练习的表达方式，例如"练习接住拒绝"。');
  const session = { id: require('./store').uid(), scenario: clampText(scenario, 2000), goal: clampText(goal, 2000), status: 'active', createdAt: new Date().toISOString(), endedAt: null, messages: [] };
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
  if (P.redlineCheck(userText)) {
    const err = new Error('REDLINE');
    err.blocked = '[系统提示] 这个请求涉及操控、打压或伤害性策略，本工具不提供。演练的目的是帮你更好地理解与表达自己——比如如何诚实地说出你的需求，或如何接住对方的拒绝。';
    throw err;
  }
  session.messages.push({ role: 'user', content: clampText(userText, 4000), ts: new Date().toISOString() });
  const sys = P.twinSystemPrompt(bundle, session.scenario);
  // 长会话轮换：只发最近 24 条，防止 token 失控（更早的上下文由生境卡承载）
  const history = session.messages.slice(-24).map(m => ({ role: m.role === 'twin' ? 'assistant' : 'user', content: m.content }));
  const reply = await chat(settings, [{ role: 'system', content: sys }, ...history], { task: 'TWIN' });
  session.messages.push({ role: 'twin', content: reply, ts: new Date().toISOString() });
  store.savePerson(bundle);
  return reply;
}

function sessionTranscript(session, max = 60) {
  return session.messages
    .filter(m => m.role !== 'system')
    .slice(-max)
    .map(m => (m.role === 'twin' ? '她: ' : '用户: ') + m.content.replace(/\r?\n+/g, ' ⏎ '))
    .join('\n\n');
}

async function endSession(store, bundle, settings, sessionId) {
  const session = bundle.sessions.find(s => s.id === sessionId);
  if (!session) throw new Error('演练会话不存在');
  if (session.status === 'ended' && (bundle.sessionReports || []).some(r => r.sessionId === sessionId)) {
    throw new Error('该演练已结束且已有复盘报告');
  }
  const report = await chat(settings, [
    { role: 'user', content: P.reviewPrompt(bundle, sessionTranscript(session), session.goal) },
  ], { task: 'REVIEW', temperature: settings.analysisTemperature });
  // 报告成功生成后才落"已结束"状态：失败时会话仍可重试复盘
  session.status = 'ended';
  session.endedAt = new Date().toISOString();
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
    hypotheses: (parsed.hypotheses || []).slice(0, 6).map(h => ({
      text: clampText(h.text, 300), prob: clamp01(h.prob),
      basis: clampText(h.basis, 300), verify: clampText(h.verify, 300),
    })).filter(h => h.text),
    expected: clampText(parsed.expected, 500),
    frozenAt: new Date().toISOString(), status: 'open',
  };
  if (!prediction.hypotheses.length) throw new Error('未能生成有效假设（模型返回为空），请重试');
  bundle.predictions.push(prediction);
  store.savePerson(bundle);
  return prediction;
}

async function submitFeedback(store, bundle, settings, { predictionId, raw }) {
  if (P.redlineCheck(raw)) throw new Error('反馈内容包含操控/伤害类描述，本工具不处理这类内容');
  const text = clampText(raw, 4000);
  let pred = null;
  if (predictionId) {
    pred = bundle.predictions.find(p => p.id === predictionId);
    if (!pred) throw new Error('预测单不存在');
    if (pred.status !== 'open') throw new Error('该预测单已归因过，请刷新页面');
  }
  const feedback = { id: require('./store').uid(), predictionId: predictionId || null, sessionId: pred ? pred.sessionId : null, raw: text, createdAt: new Date().toISOString() };
  if (pred) pred.status = 'attributed';
  // 现实反应本身也是证据
  store.addEvidence(bundle, { sourceType: 'feedback', text, ts: new Date().toISOString(), sender: bundle.name, isSelf: false });
  let transcript = '';
  if (feedback.sessionId) {
    const session = bundle.sessions.find(s => s.id === feedback.sessionId);
    if (session) transcript = sessionTranscript(session, 30);
  }
  const rawAttr = await chat(settings, [
    { role: 'user', content: P.attributionPrompt(bundle, pred, text, transcript) },
  ], { task: 'ATTRIBUTION', temperature: settings.analysisTemperature });
  const attr = extractJson(rawAttr);
  const applied = applyUpdates(bundle, attr.updates || []);
  const record = {
    id: require('./store').uid(), feedbackId: feedback.id, predictionId: predictionId || null,
    verdict: ['hit', 'partial', 'miss', 'fact-error', 'material-missing', 'temperament-error', 'expression-error'].includes(attr.verdict) ? attr.verdict : 'miss',
    analysis: clampText(attr.analysis, 2000), updates: applied, undone: false, createdAt: new Date().toISOString(),
  };
  bundle.attributions.push(record);
  bundle.feedbacks.push(feedback);
  store.savePerson(bundle);
  return { record, applied };
}

/** 应用归因产生的卡片更新（最小修正，记录旧值以便撤销） */
function applyUpdates(bundle, updates) {
  const applied = [];
  for (const u of updates.slice(0, 6)) {
    if (!u || typeof u !== 'object') continue;
    try {
      if (u.action === 'add' && u.text && P.LAYER_NAMES[u.layer]) {
        const text = clampText(u.text, 200);
        const dup = bundle.claims.find(x => similar(x.text, text));
        if (!dup) {
          const claim = {
            id: require('./store').uid(), layer: u.layer, text,
            epistemic: 'inference', source: 'ai', refs: [], confidence: 0.6,
            note: '来自现实反馈归因: ' + clampText(u.reason, 100),
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          };
          bundle.claims.push(claim);
          applied.push({ action: 'add', claimId: claim.id, layer: u.layer, text });
        }
      } else if (u.action === 'update' && u.claimId && u.text) {
        const c = bundle.claims.find(x => x.id === u.claimId);
        if (c) {
          const prevText = c.text;
          c.note = (c.note ? c.note + ' | ' : '') + `原: ${c.text}`;
          c.text = clampText(u.text, 200);
          c.updatedAt = new Date().toISOString();
          applied.push({ action: 'update', claimId: c.id, text: c.text, prevText });
        }
      } else if (u.action === 'deprecate' && u.claimId) {
        const c = bundle.claims.find(x => x.id === u.claimId);
        if (c) {
          const prevConf = c.confidence;
          c.confidence = Math.max(0.05, (c.confidence || 0.5) - 0.3);
          c.note = (c.note ? c.note + ' | ' : '') + '归因标记不可靠: ' + clampText(u.reason, 100);
          c.updatedAt = new Date().toISOString();
          applied.push({ action: 'deprecate', claimId: c.id, prevConf });
        }
      }
    } catch { /* 单条更新失败不影响整体 */ }
  }
  return applied;
}

/** 撤销一次归因对卡片的所有修改（决策权在用户） */
function undoAttribution(store, bundle, attributionId) {
  const record = bundle.attributions.find(a => a.id === attributionId);
  if (!record) throw new Error('归因记录不存在');
  if (record.undone) throw new Error('该归因已撤销过');
  const reverted = [];
  for (const u of (record.updates || [])) {
    try {
      if (u.action === 'add' && u.claimId) {
        const c = bundle.claims.find(x => x.id === u.claimId);
        if (!c) continue;
        // 归因之后用户又编辑过的条目不删，避免误伤
        if (c.updatedAt && record.createdAt && c.updatedAt > record.createdAt && c.text !== u.text) {
          reverted.push('跳过（已被编辑）: ' + (c.text || '').slice(0, 20));
          continue;
        }
        bundle.claims = bundle.claims.filter(x => x.id !== u.claimId);
        reverted.push('删 ' + (u.text || '').slice(0, 20));
      } else if (u.action === 'update' && u.claimId && u.prevText) {
        const c = bundle.claims.find(x => x.id === u.claimId);
        if (c) {
          c.text = u.prevText;
          // 清掉当时追加的"原: …"备注段
          if (c.note) c.note = c.note.split(' | ').filter(seg => !seg.startsWith('原: ')).join(' | ');
          c.updatedAt = new Date().toISOString();
          reverted.push('还原 ' + u.prevText.slice(0, 20));
        }
      } else if (u.action === 'deprecate' && u.claimId && typeof u.prevConf === 'number') {
        const c = bundle.claims.find(x => x.id === u.claimId);
        if (c) {
          c.confidence = u.prevConf;
          if (c.note) c.note = c.note.split(' | ').filter(seg => !seg.startsWith('归因标记不可靠')).join(' | ');
          reverted.push('恢复置信度 ' + c.text.slice(0, 20));
        }
      }
    } catch { /* 单条撤销失败不影响其余 */ }
  }
  record.undone = true;
  // 关联反馈退出闭环分子，防止撤销后重复提交导致闭环率超 100%
  const fb = bundle.feedbacks.find(f => f.id === record.feedbackId);
  if (fb) fb.predictionId = null;
  if (record.predictionId) {
    const pred = bundle.predictions.find(p => p.id === record.predictionId);
    if (pred) pred.status = 'open';
  }
  store.savePerson(bundle);
  return reverted;
}

// ---------- 话题雷达（规则版：空白 + 用户陈述待验证 + 访谈待确认） ----------
function topicRadar(bundle) {
  const items = [];
  for (const c of bundle.claims.filter(c => c.epistemic === 'blank').slice(0, 12)) {
    items.push({ from: '生境卡空白', text: c.text });
  }
  // 兑现"用户陈述优先被现实验证"的承诺：无证据引用的用户陈述列入待验证
  for (const c of bundle.claims.filter(c => c.source === 'user' && !c.refs.length && c.epistemic !== 'blank').slice(0, 8)) {
    items.push({ from: '用户陈述·待验证', text: c.text });
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
  if (!skipped && P.redlineCheck(answer)) throw new Error('回答包含操控/伤害类描述，本工具不记录这类内容');
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
  record.answer = clampText(answer, 4000);
  // 重答同一题：清掉上一轮的追问残留
  record.probe = null;
  record.probeAnswer = '';
  // 判断是否需要追问
  let probe = null;
  const digest = recordsDigest(Object.assign({}, iv.records, { [qid]: record }));
  const raw = await chat(settings, [
    { role: 'user', content: P.interviewProbePrompt(qid, q.text, record.answer, digest) },
  ], { task: 'INTERVIEW_PROBE', temperature: settings.analysisTemperature });
  const cleaned = raw.trim();
  const isOk = /^(ok|okay|好[的呀]?|可以|通过|fine|no[_ ]?need)\s*[。.!！]?$/i.test(cleaned);
  if (cleaned && !isOk) probe = clampText(cleaned, 300);
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

/** 将勾选的访谈建议写入生境卡（来源=用户陈述，一律以"推断"认识层级落库） */
function interviewWriteClaims(store, bundle, indexes) {
  const written = [];
  for (const raw of indexes) {
    const i = Number(raw);
    if (!Number.isInteger(i) || i < 0 || i >= bundle.interview.suggestions.length) continue;
    const s = bundle.interview.suggestions[i];
    if (!s || s.written) continue;
    const dup = bundle.claims.some(x => similar(x.text, s.text));
    if (dup) { s.written = true; continue; }
    bundle.claims.push({
      id: require('./store').uid(), layer: s.layer, text: s.text,
      // 纪律统一：无证据引用的条目不得以"事实"身份进卡（与归纳器同一规则），用户陈述以推断+待验证落库
      epistemic: 'inference', source: 'user', refs: [],
      confidence: s.kind === 'fact' ? 0.7 : 0.6,
      note: '来自24问访谈 · 用户陈述·待验证', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    s.written = true;
    written.push(s.text);
  }
  store.savePerson(bundle);
  return written;
}

module.exports = {
  inductEvidence, startSession, twinTurn, endSession, sessionTranscript,
  freezePrediction, submitFeedback, applyUpdates, undoAttribution, topicRadar,
  interviewAnswer, interviewProbeAnswer, interviewSummary, interviewFinalize, interviewWriteClaims,
  chunkEvidence, evidenceLine, similar, clamp01,
};
