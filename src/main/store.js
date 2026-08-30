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
  // Windows 下目标文件可能被杀软/索引器短暂占用，重试后降级（降级也先写临时名再 rename，保持尽量原子）
  const sab = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 3; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (err) {
      if (i === 2) {
        try {
          const tmp2 = file + '.cp-' + process.pid + '-' + Date.now();
          fs.copyFileSync(tmp, tmp2);
          fs.renameSync(tmp2, file);
          fs.rmSync(tmp, { force: true });
          return;
        } catch (copyErr) {
          try { fs.rmSync(tmp, { force: true }); } catch {}
          throw new Error('保存失败（文件可能被占用）: ' + (copyErr && copyErr.code || copyErr));
        }
      }
      try { Atomics.wait(sab, 0, 0, [50, 200][i] || 200); } catch { /* 主线程不支持时退化为同步 */ }
    }
  }
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
    this.reconcile();
  }

  /** 启动对账：persons 目录为唯一真相，修复索引漂移；损坏档案隔离到 corrupt/ 并可计数 */
  reconcile() {
    this.corruptCount = 0;
    try {
      const dir = path.join(this.dataDir, 'persons');
      const corruptDir = path.join(this.dataDir, 'corrupt');
      for (const f of fs.readdirSync(dir)) {
        if (f.includes('.tmp-') || f.includes('.cp-')) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch {} }
      }
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      const onDisk = [];
      for (const f of files) {
        const id = f.replace(/\.json$/, '');
        try {
          JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          onDisk.push(id);
        } catch {
          // 损坏档案：隔离保留（隐私承诺——不静默删除），但不进索引
          try {
            fs.mkdirSync(corruptDir, { recursive: true });
            fs.renameSync(path.join(dir, f), path.join(corruptDir, f.replace('.json', '') + '-' + Date.now() + '.json'));
            this.corruptCount++;
          } catch {}
        }
      }
      let index = this.listPersons();
      index = index.filter(p => onDisk.includes(p.id));
      for (const id of onDisk) {
        if (!index.some(p => p.id === id)) {
          try {
            const b = JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8'));
            index.push({ id, name: b.name || id, alias: b.alias || '', createdAt: b.createdAt || new Date().toISOString() });
          } catch { /* 不可达：上面已验证过 */ }
        }
      }
      atomicWrite(this.indexFile(), JSON.stringify(index, null, 2));
    } catch { /* 对账失败不阻塞启动 */ }
  }

  getCorruptCount() { return this.corruptCount || 0; }

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
  personFile(id) {
    // 防路径穿越：id 必须是纯文件名
    const safe = path.basename(String(id));
    if (safe !== String(id) || /[\\/.]/.test(String(id))) throw new Error('非法的人物 id');
    return path.join(this.dataDir, 'persons', safe + '.json');
  }

  // ---------- settings ----------
  static SETTING_KEYS = ['provider', 'baseUrl', 'apiKey', 'apiKeyEnc', 'model', 'temperature', 'analysisTemperature', 'timeoutMs'];
  loadSettings() {
    try { return { ...this.defaultSettings(), ...JSON.parse(fs.readFileSync(this.settingsFile(), 'utf8')) }; }
    catch { return this.defaultSettings(); }
  }
  saveSettings(patch) {
    const merged = { ...this.loadSettings(), ...patch };
    // 字段白名单：渲染层不能注入未知设置键
    for (const k of Object.keys(merged)) {
      if (!Store.SETTING_KEYS.includes(k)) delete merged[k];
    }
    atomicWrite(this.settingsFile(), JSON.stringify(merged, null, 2));
    return merged;
  }

  // ---------- persons ----------
  listPersons() {
    try {
      const v = JSON.parse(fs.readFileSync(this.indexFile(), 'utf8'));
      return Array.isArray(v) ? v : [];
    } catch { return []; }
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
    // 隐私承诺：删除必须是真删除。文件被占用导致 unlink 失败时明确报错，绝不静默（否则 reconcile 会把它当孤儿"复活"）
    try { fs.unlinkSync(this.personFile(id)); }
    catch (err) { throw new Error('删除失败：档案文件被占用（可能被杀毒软件/同步盘锁定），请稍后重试'); }
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
    // 命中率口径：有预测单且未撤销的归因全部计入分母；错误类 verdict（错但知道错在哪层）按未命中计，不再剔除
    const RESULT_VERDICTS = { hit: 'hit', partial: 'partial', miss: 'miss', 'fact-error': 'miss', 'material-missing': 'miss', 'temperament-error': 'miss', 'expression-error': 'miss' };
    const attributed = bundle.attributions.filter(a => a.predictionId && !a.undone);
    const valid = attributed.filter(a => RESULT_VERDICTS[a.verdict]);
    const unknown = attributed.length - valid.length;
    const hit = valid.filter(a => RESULT_VERDICTS[a.verdict] === 'hit').length;
    const partial = valid.filter(a => RESULT_VERDICTS[a.verdict] === 'partial').length;
    const total = valid.length;
    const byLayer = { basic: 0, life: 0, temperament: 0, expression: 0 };
    const byEpistemic = { fact: 0, inference: 0, blank: 0 };
    const bySource = { evidence: 0, user: 0, ai: 0 };
    for (const c of bundle.claims) {
      byLayer[c.layer] = (byLayer[c.layer] || 0) + 1;
      byEpistemic[c.epistemic] = (byEpistemic[c.epistemic] || 0) + 1;
      bySource[c.source] = (bySource[c.source] || 0) + 1;
    }
    const linkedFeedbacks = bundle.feedbacks.filter(f => f.predictionId && bundle.predictions.some(p => p.id === f.predictionId && p.status === 'attributed')).length;
    const openPredictions = bundle.predictions.filter(p => p.status === 'open').length;
    return {
      evidence: bundle.evidence.length,
      claims: bundle.claims.length,
      byLayer, byEpistemic, bySource,
      sessions: bundle.sessions.length,
      predictions: bundle.predictions.length,
      openPredictions,
      feedbacks: bundle.feedbacks.length,
      linkedFeedbacks,
      attributions: total,
      attributionsAll: attributed.length,
      unknownVerdicts: unknown,
      hitRateTop1: total ? hit / total : null,
      hitRateTop2: total ? (hit + partial) / total : null,
      loopCompletion: bundle.predictions.length ? Math.min(1, linkedFeedbacks / bundle.predictions.length) : null,
    };
  }
}

module.exports = { Store, atomicWrite, uid, now };
