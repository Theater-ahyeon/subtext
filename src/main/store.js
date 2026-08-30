'use strict';
/**
 * 存储层：本地优先，JSON 文件 + 原子写入。
 * 每个人物一个 bundle 文件；settings 与 person 索引分离。
 * 接口保持存储无关，后续可替换为 SQLite。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

function atomicWrite(file, data) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

class Store {
  constructor() {
    this.dataDir = null;
  }

  init(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(path.join(this.dataDir, 'persons'), { recursive: true });
    if (!fs.existsSync(this.indexFile())) atomicWrite(this.indexFile(), '[]');
    if (!fs.existsSync(this.settingsFile())) atomicWrite(this.settingsFile(), JSON.stringify(this.defaultSettings(), null, 2));
  }

  defaultSettings() {
    return {
      provider: 'mock', // 'mock' | 'openai'
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini',
      temperature: 0.7,
      analysisTemperature: 0.3,
      timeoutMs: 90000,
    };
  }

  indexFile() { return path.join(this.dataDir, 'index.json'); }
  settingsFile() { return path.join(this.dataDir, 'settings.json'); }
  personFile(id) { return path.join(this.dataDir, 'persons', id + '.json'); }

  // ---------- settings ----------
  loadSettings() {
    try { return { ...this.defaultSettings(), ...JSON.parse(fs.readFileSync(this.settingsFile(), 'utf8')) }; }
    catch { return this.defaultSettings(); }
  }
  saveSettings(patch) {
    const merged = { ...this.loadSettings(), ...patch };
    atomicWrite(this.settingsFile(), JSON.stringify(merged, null, 2));
    return merged;
  }

  // ---------- persons ----------
  listPersons() {
    try { return JSON.parse(fs.readFileSync(this.indexFile(), 'utf8')); }
    catch { return []; }
  }

  createPerson(name, alias) {
    const id = uid();
    const bundle = {
      id, name, alias: alias || '',
      createdAt: now(),
      claims: [],        // {id, layer, text, epistemic, source, refs, confidence, createdAt, updatedAt, note}
      dynamic: [],       // {id, text, asOf, resolved, createdAt}
      evidence: [],      // {id, seq, sourceType, text, ts, sender, isSelf, createdAt}
      sessions: [],      // {id, scenario, status, createdAt, endedAt, messages:[{role,content,ts}]}
      predictions: [],   // {id, sessionId, hypotheses:[{text,prob,basis,verify}], expected, frozenAt, status}
      feedbacks: [],     // {id, predictionId, sessionId, raw, createdAt}
      attributions: [],  // {id, feedbackId, predictionId, verdict, analysis, updates, createdAt}
      interview: { started: false, currentQ: 1, records: {}, summaries: [], final: null, suggestions: [], updatedAt: null },
    };
    atomicWrite(this.personFile(id), JSON.stringify(bundle, null, 2));
    const index = this.listPersons();
    index.push({ id, name, alias: bundle.alias, createdAt: bundle.createdAt });
    atomicWrite(this.indexFile(), JSON.stringify(index, null, 2));
    return bundle;
  }

  loadPerson(id) {
    try { return JSON.parse(fs.readFileSync(this.personFile(id), 'utf8')); }
    catch { return null; }
  }

  savePerson(bundle) {
    bundle.updatedAt = now();
    atomicWrite(this.personFile(bundle.id), JSON.stringify(bundle, null, 2));
    const index = this.listPersons();
    const entry = index.find(p => p.id === bundle.id);
    if (entry) { entry.name = bundle.name; entry.alias = bundle.alias; entry.updatedAt = bundle.updatedAt; }
    else index.push({ id: bundle.id, name: bundle.name, alias: bundle.alias, createdAt: bundle.createdAt });
    atomicWrite(this.indexFile(), JSON.stringify(index, null, 2));
    return bundle;
  }

  deletePerson(id) {
    try { fs.unlinkSync(this.personFile(id)); } catch {}
    atomicWrite(this.indexFile(), JSON.stringify(this.listPersons().filter(p => p.id !== id), null, 2));
  }

  // ---------- person 内部通用操作 ----------
  addEvidence(bundle, { sourceType, text, ts, sender, isSelf }) {
    const seq = (bundle.evidence.reduce((m, e) => Math.max(m, e.seq || 0), 0)) + 1;
    const item = { id: uid(), seq, sourceType, text, ts: ts || '', sender: sender || '', isSelf: isSelf == null ? null : !!isSelf, createdAt: now() };
    bundle.evidence.push(item);
    return item;
  }

  addClaim(bundle, { layer, text, epistemic, source, refs, confidence, note }) {
    const claim = {
      id: uid(), layer, text, 
      epistemic: epistemic || 'inference',
      source: source || 'ai',
      refs: refs || [],
      confidence: typeof confidence === 'number' ? confidence : 0.5,
      note: note || '', createdAt: now(), updatedAt: now(),
    };
    bundle.claims.push(claim);
    return claim;
  }

  // ---------- 统计 ----------
  computeStats(bundle) {
    const attributed = bundle.attributions.filter(a => a.predictionId);
    const hit = attributed.filter(a => a.verdict === 'hit').length;
    const partial = attributed.filter(a => a.verdict === 'partial').length;
    const total = attributed.length;
    const byLayer = { basic: 0, life: 0, temperament: 0, expression: 0 };
    const byEpistemic = { fact: 0, inference: 0, blank: 0 };
    const bySource = { evidence: 0, user: 0, ai: 0 };
    for (const c of bundle.claims) {
      byLayer[c.layer] = (byLayer[c.layer] || 0) + 1;
      byEpistemic[c.epistemic] = (byEpistemic[c.epistemic] || 0) + 1;
      bySource[c.source] = (bySource[c.source] || 0) + 1;
    }
    const openPredictions = bundle.predictions.filter(p => p.status === 'open').length;
    return {
      evidence: bundle.evidence.length,
      claims: bundle.claims.length,
      byLayer, byEpistemic, bySource,
      sessions: bundle.sessions.length,
      predictions: bundle.predictions.length,
      openPredictions,
      feedbacks: bundle.feedbacks.length,
      attributions: total,
      hitRateTop1: total ? hit / total : null,
      hitRateTop2: total ? (hit + partial) / total : null,
      loopCompletion: bundle.predictions.length ? bundle.feedbacks.filter(f => f.predictionId).length / bundle.predictions.length : null,
    };
  }
}

module.exports = { Store, atomicWrite, uid, now };
