'use strict';
/**
 * 存储层：本地优先，JSON 文件 + 原子写入。
 * 每个人物一个 bundle 文件；settings 与 person 索引分离。
 * 接口保持存储无关，后续可替换为 SQLite。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nativeImage } = (() => {
  // 桌面宿主复用 Electron nativeImage 缩图；Web 宿主（纯 Node）退化为"原图即缩略图"
  try { return { nativeImage: require('electron').nativeImage }; } catch { return { nativeImage: null }; }
})();

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

/** 图片安全边界：只认 PNG/JPEG/GIF/WebP 魔数（不信任扩展名/渲染层声明），大小上限 15MB */
const IMAGE_MAGIC = [
  { ext: 'png', mime: 'image/png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 },
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  { ext: 'gif', mime: 'image/gif', test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  { ext: 'webp', mime: 'image/webp', test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
];
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const THUMB_MAX_DIM = 320;

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
      provider: 'mock', // 'mock' | 'openai' | 'azure' | 'anthropic' | 'gemini' | 'ollama'
      baseUrl: '',       // 留空时使用该协议的官方默认地址
      apiKey: '',
      apiKeyEnc: '',
      model: '',
      temperature: 0.7,
      analysisTemperature: 0.3,
      maxTokens: 2048,
      timeoutMs: 90000,
      // 事件记忆向量化：留空 = 跟随主 provider（anthropic/azure 无 embedding 端点时自动降级本地词面检索）
      embedProvider: '',
      embedBaseUrl: '',
      embedApiKey: '',
      embedApiKeyEnc: '',
      embedModel: '',
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

  // ---------- 证据图片（本地文件，不进 JSON 档案） ----------
  mediaDir(personId) { return path.join(this.dataDir, 'media', this.safeMediaName(personId)); }

  /** media 文件名同样只允许 uuid 形状，杜绝穿越与后缀注入 */
  safeMediaName(name) {
    const s = String(name || '');
    if (!/^[0-9a-zA-Z-]+$/.test(s)) throw new Error('非法的媒体文件名');
    return s;
  }

  /** 校验字节并落盘原图 + 生成缩略图（nativeImage 不可用时缩略图=原图字节） */
  saveImage(personId, buf) {
    if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('图片内容为空');
    if (buf.length > MAX_IMAGE_BYTES) throw new Error(`图片超过 15MB（当前 ${Math.round(buf.length / 1024 / 1024)}MB），请压缩后再存证`);
    const kind = IMAGE_MAGIC.find(k => { try { return k.test(buf); } catch { return false; } });
    if (!kind) throw new Error('不支持的图片格式（仅 PNG / JPG / GIF / WebP）');
    const dir = this.mediaDir(personId);
    fs.mkdirSync(dir, { recursive: true });
    const name = uid();
    const file = path.join(dir, name + '.' + kind.ext);
    const thumb = path.join(dir, name + '.thumb.' + (kind.ext === 'jpg' ? 'jpg' : kind.ext));
    atomicWrite(file, buf);
    let thumbBuf = buf;
    try {
      if (nativeImage) {
        const img = nativeImage.createFromBuffer(buf);
        if (!img.isEmpty()) {
          const sz = img.getSize();
          if (Math.max(sz.width, sz.height) > THUMB_MAX_DIM) {
            thumbBuf = img.resize({ width: Math.min(sz.width, THUMB_MAX_DIM) }).toJPEG(72);
          } else {
            thumbBuf = kind.ext === 'jpg' ? img.toJPEG(72) : buf;
          }
        }
      }
    } catch { /* 缩略图失败不阻塞存证 */ }
    atomicWrite(thumb, thumbBuf);
    return { media: name + '.' + kind.ext, mime: kind.mime };
  }

  /** 读取指定媒体文件（原图或缩略图）；不存在返回 null */
  readImage(personId, media, { thumb = false } = {}) {
    const base = path.basename(String(media || ''));
    if (!/^[0-9a-zA-Z-]+\.(png|jpg|gif|webp)$/.test(base)) return null;
    let file = path.join(this.mediaDir(personId), base);
    if (thumb) {
      const t = file.replace(/\.([a-z]+)$/, '.thumb.$1');
      if (fs.existsSync(t)) file = t;
    }
    try { return { data: fs.readFileSync(file), mime: IMAGE_MAGIC.find(k => k.ext === base.split('.').pop()) ? (IMAGE_MAGIC.find(k => k.ext === base.split('.').pop()).mime) : 'application/octet-stream' }; }
    catch { return null; }
  }

  deleteImage(personId, media) {
    if (!media) return;
    const base = path.basename(String(media));
    if (!/^[0-9a-zA-Z-]+\.(png|jpg|gif|webp)$/.test(base)) return;
    for (const f of [base, base.replace(/\.([a-z]+)$/, '.thumb.$1')]) {
      try { fs.rmSync(path.join(this.mediaDir(personId), f), { force: true }); } catch {}
    }
  }

  /** 删除人物时清空其媒体目录（隐私承诺：删除=真删除） */
  purgePersonMedia(personId) {
    try { fs.rmSync(this.mediaDir(personId), { recursive: true, force: true }); } catch {}
  }

  // ---------- settings ----------
  static SETTING_KEYS = ['provider', 'baseUrl', 'apiKey', 'apiKeyEnc', 'model', 'temperature', 'analysisTemperature', 'maxTokens', 'timeoutMs', 'embedProvider', 'embedBaseUrl', 'embedApiKey', 'embedApiKeyEnc', 'embedModel'];
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
  addEvidence(bundle, { sourceType, text, ts, sender, isSelf, media, mediaMime }) {
    const seq = (bundle.evidence.reduce((m, e) => Math.max(m, e.seq || 0), 0)) + 1;
    const item = { id: uid(), seq, sourceType, text, ts: ts || '', sender: sender || '', isSelf: isSelf == null ? null : !!isSelf, createdAt: now() };
    if (media) { item.media = media; item.mediaMime = mediaMime || 'image/png'; }
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
    // 命中率口径：有预判且未撤销的差异分析全部计入分母；错误类 verdict（错但知道错在哪层）按未命中计。
    // model-bias（模拟扮演偏离理解卡）不进命中率——它衡量扮演质量而非理解卡质量，单列计数。
    const RESULT_VERDICTS = { hit: 'hit', partial: 'partial', miss: 'miss', 'fact-error': 'miss', 'material-missing': 'miss', 'temperament-error': 'miss', 'expression-error': 'miss' };
    const OUTCOME = { hit: 1, partial: 0.5 }; // Brier 真实结果编码：命中=1，部分=0.5，其余=0
    const attributed = bundle.attributions.filter(a => a.predictionId && !a.undone);
    const scored = attributed.filter(a => RESULT_VERDICTS[a.verdict]);
    const modelBiased = attributed.filter(a => a.verdict === 'model-bias').length;
    const unknown = attributed.length - scored.length - modelBiased;
    const hit = scored.filter(a => RESULT_VERDICTS[a.verdict] === 'hit').length;
    const partial = scored.filter(a => RESULT_VERDICTS[a.verdict] === 'partial').length;
    const total = scored.length;
    // Brier 校准（Top1 口径）：冻结时记录的 Top1 假设概率 vs 真实结果；旧归因无 topProb 则跳过
    let brierSum = 0, brierSamples = 0;
    for (const a of attributed) {
      if (typeof a.topProb !== 'number' || !RESULT_VERDICTS[a.verdict]) continue;
      const outcome = OUTCOME[a.verdict] || 0;
      brierSum += Math.pow(a.topProb - outcome, 2);
      brierSamples++;
    }
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
      modelBiased,
      hitRateTop1: total ? hit / total : null,
      hitRateTop2: total ? (hit + partial) / total : null,
      loopCompletion: bundle.predictions.length ? Math.min(1, linkedFeedbacks / bundle.predictions.length) : null,
      brierTop1: brierSamples ? brierSum / brierSamples : null,
      brierSamples,
      memories: (bundle.memories && bundle.memories.items) ? bundle.memories.items.length : 0,
    };
  }
}

module.exports = { Store, atomicWrite, uid, now };
