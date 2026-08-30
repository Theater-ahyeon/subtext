'use strict';
/**
 * Electron 主进程：窗口 + IPC 编排。
 * 所有业务逻辑在 store/pipeline/parser/prompts（可在无 Electron 环境测试）。
 * 安全基线：id 严格校验、单实例锁、导航/弹窗拦截、API Key 用 safeStorage(DPAPI) 加密。
 */
const { app, BrowserWindow, ipcMain, dialog, Menu, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const util = require('util');
const { Store } = require('./store');
const parser = require('./parser');
const pipeline = require('./pipeline');
const P = require('./prompts');
const { chat } = require('./llm');

const store = new Store();
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
let win = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1080, minHeight: 700,
    backgroundColor: '#0d0f14',
    title: '生境沙盒 · Habitat Sandbox',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  // 渲染层被攻破时不允许导航或开新窗口
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  const menu = Menu.buildFromTemplate([
    { label: '视图', submenu: [
      { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
      { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
    ]},
  ]);
  Menu.setApplicationMenu(menu);
  store.init(path.join(app.getPath('userData'), 'habitat-data'));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---------- helpers ----------
function validId(id) {
  if (!ID_RE.test(String(id || ''))) throw new Error('非法的人物 id');
  return String(id);
}

function withPerson(id, fn) {
  const bundle = store.loadPerson(validId(id));
  if (!bundle) throw new Error('人物不存在');
  return fn(bundle);
}

/** 内部用完整设置（含解密后的 key）；渲染层永远拿不到明文 key */
function effectiveSettings() {
  const s = store.loadSettings();
  if (s.apiKeyEnc && !s.apiKey) {
    try { s.apiKey = safeStorage.decryptString(Buffer.from(s.apiKeyEnc, 'base64')); }
    catch { s.apiKey = ''; }
  }
  return s;
}

function encryptApiKey(settings, patch) {
  const out = { ...patch };
  if (typeof out.apiKey === 'string') {
    if (out.apiKey === '') {
      delete out.apiKey;
      out.apiKeyEnc = '';
    } else if (safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()) {
      try {
        out.apiKeyEnc = safeStorage.encryptString(out.apiKey).toString('base64');
        delete out.apiKey; // 明文不落盘
      } catch { /* 加密失败则退回明文（旧机制） */ }
    }
  }
  return out;
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, data: await fn(...args, event) };
    } catch (err) {
      const e = err || {};
      return { ok: false, error: e.message || String(err), blocked: !!e.blocked, reply: e.blocked || undefined };
    }
  });
}

// ---------- app ----------
handle('app:info', () => ({ version: app.getVersion(), dataDir: path.join(app.getPath('userData'), 'habitat-data'), platform: process.platform }));

// ---------- persons ----------
handle('persons:list', () => store.listPersons());
handle('persons:create', ({ name, alias }) => store.createPerson(String(name || '').slice(0, 20), String(alias || '').slice(0, 30)));
handle('persons:delete', ({ id }) => store.deletePerson(validId(id)));
handle('persons:get', ({ id }) => withPerson(id, b => b));
handle('persons:update', ({ id, patch }) => withPerson(id, b => {
  if (patch.name) b.name = String(patch.name).slice(0, 20);
  if (patch.alias !== undefined) b.alias = String(patch.alias).slice(0, 30);
  return store.savePerson(b);
}));

// ---------- evidence ----------
handle('evidence:add', ({ id, items }) => withPerson(id, b => {
  const added = [];
  for (const it of items.slice(0, 500)) {
    if (!it.text || !String(it.text).trim()) continue;
    added.push(store.addEvidence(b, { sourceType: it.sourceType || 'other', text: String(it.text).slice(0, 4000), ts: it.ts || '', sender: it.sender || '', isSelf: it.isSelf }));
  }
  store.savePerson(b);
  return { added: added.length, total: b.evidence.length, truncated: Math.max(0, (items || []).length - 500) };
}));
handle('evidence:delete', ({ id, evidenceId }) => withPerson(id, b => {
  b.evidence = b.evidence.filter(e => e.id !== evidenceId);
  store.savePerson(b);
  return true;
}));

// ---------- import ----------
handle('import:parse', ({ text, selfName }) => parser.parseAuto(String(text || '').slice(0, MAX_IMPORT_BYTES * 2), { selfName }));
handle('import:commit', ({ id, messages, sourceType }) => withPerson(id, b => {
  const LIMIT = 20000;
  const list = (messages || []).slice(0, LIMIT);
  const added = [];
  for (const m of list) {
    if (!m.text || !String(m.text).trim()) continue;
    added.push(store.addEvidence(b, { sourceType, text: String(m.text).slice(0, 4000), ts: m.ts || '', sender: m.sender || '', isSelf: m.isSelf }));
  }
  store.savePerson(b);
  return { added: added.length, total: b.evidence.length, truncated: Math.max(0, (messages || []).length - LIMIT) };
}));
handle('import:file', async ({ id, sourceType, selfName }) => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择聊天记录导出文件',
    filters: [{ name: '聊天记录导出', extensions: ['json', 'jsonl', 'csv', 'txt', 'ndjson'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return { canceled: true };
  const p = r.filePaths[0];
  const st = fs.statSync(p);
  if (st.size > MAX_IMPORT_BYTES) throw new Error(`文件超过 20MB（当前 ${Math.round(st.size / 1024 / 1024)}MB），请先拆分后再导入`);
  const buf = await fs.promises.readFile(p);
  let text = buf.toString('utf8');
  // GBK 检测：UTF-8 解码后出现大量替换符 → 用 GBK 重解码（QQ/TXT 导出常见 ANSI 编码）
  const bad = (text.match(/\uFFFD/g) || []).length;
  if (bad > text.length * 0.001) {
    try { text = new util.TextDecoder('gbk').decode(buf); } catch { /* 无 GBK 解码器则保留 utf8 结果 */ }
  }
  const parsed = parser.parseAuto(text, { selfName });
  const result = await withPerson(id, b => {
    const LIMIT = 20000;
    const list = parsed.messages.slice(0, LIMIT);
    const added = [];
    for (const m of list) {
      added.push(store.addEvidence(b, { sourceType, text: m.text, ts: m.ts, sender: m.sender, isSelf: m.isSelf }));
    }
    store.savePerson(b);
    return { added: added.length, total: b.evidence.length, format: parsed.format, truncated: Math.max(0, parsed.messages.length - LIMIT) };
  });
  return { canceled: false, ...result };
});

// ---------- card / claims ----------
handle('card:induce', ({ id }, event) => withPerson(id, async b => {
  return pipeline.inductEvidence(store, b, effectiveSettings(), {
    onProgress: (prog) => { try { event.sender.send('induce:progress', prog); } catch {} },
  });
}));
handle('claims:add', ({ id, claim }) => withPerson(id, b => {
  const c = store.addClaim(b, { ...claim, text: String(claim.text || '').slice(0, 200) });
  store.savePerson(b);
  return c;
}));
handle('claims:update', ({ id, claimId, patch }) => withPerson(id, b => {
  const c = b.claims.find(x => x.id === claimId);
  if (!c) throw new Error('条目不存在');
  for (const k of ['layer', 'text', 'epistemic', 'confidence', 'note']) {
    if (patch[k] !== undefined) c[k] = k === 'text' ? String(patch[k]).slice(0, 200) : patch[k];
  }
  c.updatedAt = new Date().toISOString();
  store.savePerson(b);
  return c;
}));
handle('claims:delete', ({ id, claimId }) => withPerson(id, b => {
  b.claims = b.claims.filter(c => c.id !== claimId);
  store.savePerson(b);
  return true;
}));
handle('dynamic:add', ({ id, text }) => withPerson(id, b => {
  const d = { id: require('./store').uid(), text: String(text).slice(0, 300), asOf: new Date().toISOString(), resolved: false, createdAt: new Date().toISOString() };
  b.dynamic.push(d);
  store.savePerson(b);
  return d;
}));
handle('dynamic:resolve', ({ id, dynId }) => withPerson(id, b => {
  const d = b.dynamic.find(x => x.id === dynId);
  if (d) d.resolved = true;
  store.savePerson(b);
  return d;
}));
handle('card:compile', ({ id }) => withPerson(id, b => P.compileCard(b)));

// ---------- session / rehearsal ----------
handle('session:start', async ({ id, scenario, goal }) => withPerson(id, async b => {
  const { session, reply } = await pipeline.startSession(store, b, effectiveSettings(), scenario, goal);
  return { sessionId: session.id, reply, messages: session.messages };
}));
handle('session:send', async ({ id, sessionId, text }) => withPerson(id, async b => {
  try {
    const reply = await pipeline.twinTurn(store, b, effectiveSettings(), sessionId, text);
    return { reply };
  } catch (err) {
    if (err && err.blocked) return { blocked: true, reply: err.blocked };
    throw err;
  }
}));
handle('session:end', async ({ id, sessionId }) => withPerson(id, async b => {
  return { report: await pipeline.endSession(store, b, effectiveSettings(), sessionId) };
}));
handle('session:list', ({ id }) => withPerson(id, b => b.sessions.map(s => ({ id: s.id, scenario: s.scenario, status: s.status, createdAt: s.createdAt, turns: s.messages.filter(m => m.role === 'user').length }))));
handle('session:get', ({ id, sessionId }) => withPerson(id, b => {
  const s = b.sessions.find(x => x.id === sessionId);
  if (!s) throw new Error('会话不存在');
  const report = (b.sessionReports || []).find(r => r.sessionId === sessionId);
  return { session: s, report: report ? report.report : null };
}));

// ---------- prediction / feedback ----------
handle('prediction:freeze', async ({ id, sessionId }) => withPerson(id, async b => {
  return { prediction: await pipeline.freezePrediction(store, b, effectiveSettings(), sessionId) };
}));
handle('prediction:list', ({ id }) => withPerson(id, b => b.predictions));
handle('feedback:submit', async ({ id, predictionId, raw }) => withPerson(id, async b => {
  return pipeline.submitFeedback(store, b, effectiveSettings(), { predictionId, raw });
}));
handle('attribution:list', ({ id }) => withPerson(id, b => b.attributions));
handle('attribution:undo', ({ id, attributionId }) => withPerson(id, b => {
  return { reverted: pipeline.undoAttribution(store, b, attributionId) };
}));

// ---------- stats / radar ----------
handle('stats:get', ({ id }) => withPerson(id, b => store.computeStats(b)));
handle('radar:get', ({ id }) => withPerson(id, b => pipeline.topicRadar(b)));

// ---------- interview ----------
handle('interview:state', ({ id }) => withPerson(id, b => ({
  started: b.interview.started, currentQ: b.interview.currentQ, records: b.interview.records,
  summaries: b.interview.summaries, final: b.interview.final, suggestions: b.interview.suggestions,
  questions: P.INTERVIEW_QUESTIONS,
})));
handle('interview:start', ({ id }) => withPerson(id, b => {
  b.interview.started = true;
  if (!b.interview.currentQ) b.interview.currentQ = 1;
  store.savePerson(b);
  return true;
}));
handle('interview:answer', async ({ id, qid, answer, skipped }) => withPerson(id, async b => {
  return pipeline.interviewAnswer(store, b, effectiveSettings(), { qid, answer, skipped });
}));
handle('interview:probeAnswer', async ({ id, qid, answer }) => withPerson(id, async b => {
  return pipeline.interviewProbeAnswer(store, b, effectiveSettings(), { qid, answer });
}));
handle('interview:summary', async ({ id }) => withPerson(id, async b => {
  return { text: await pipeline.interviewSummary(store, b, effectiveSettings()) };
}));
handle('interview:finalize', async ({ id }) => withPerson(id, async b => {
  return pipeline.interviewFinalize(store, b, effectiveSettings());
}));
handle('interview:writeClaims', ({ id, indexes }) => withPerson(id, b => {
  return { written: pipeline.interviewWriteClaims(store, b, indexes) };
}));

// ---------- settings ----------
handle('settings:get', () => {
  const s = store.loadSettings();
  return { ...s, apiKey: '', hasApiKey: !!(s.apiKey || s.apiKeyEnc), keyEncrypted: !!s.apiKeyEnc };
});
handle('settings:set', (patch) => store.saveSettings(encryptApiKey(store.loadSettings(), patch || {})));
handle('settings:test', async () => {
  const s = effectiveSettings();
  const reply = await chat(s, [{ role: 'user', content: '连接测试，请回复"连接正常"四个字。' }], { task: 'TWIN', temperature: 0, timeoutMs: 20000 });
  return { reply: String(reply).slice(0, 100) };
});

// ---------- export / import card ----------
handle('card:export', async ({ id }) => {
  const bundle = store.loadPerson(validId(id));
  if (!bundle) throw new Error('人物不存在');
  const r = await dialog.showSaveDialog(win, {
    title: '导出生境卡',
    defaultPath: `${bundle.name}-生境卡-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return { canceled: true };
  const exportData = {
    format: 'habitat-sandbox-card', version: 1, exportedAt: new Date().toISOString(),
    name: bundle.name, alias: bundle.alias,
    claims: bundle.claims, dynamic: bundle.dynamic,
    interviewFinal: bundle.interview.final ? bundle.interview.final.text : null,
    compiledCard: P.compileCard(bundle),
  };
  fs.writeFileSync(r.filePath, JSON.stringify(exportData, null, 2), 'utf8');
  return { path: r.filePath };
});

handle('card:import', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '导入生境卡',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return { canceled: true };
  let data;
  try { data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')); }
  catch { throw new Error('文件不是合法 JSON'); }
  if (data.format !== 'habitat-sandbox-card' || !Array.isArray(data.claims)) {
    throw new Error('不是本工具导出的生境卡文件（缺少 format 标识）');
  }
  const bundle = store.createPerson(String(data.name || '导入人物').slice(0, 18) + '（导入）', String(data.alias || '').slice(0, 30));
  bundle.claims = data.claims
    .filter(c => c && c.text && P.LAYER_NAMES[c.layer])
    .map(c => ({
      id: require('./store').uid(), layer: c.layer,
      text: String(c.text).slice(0, 200),
      epistemic: ['fact', 'inference', 'blank'].includes(c.epistemic) ? c.epistemic : 'inference',
      source: ['evidence', 'user', 'ai'].includes(c.source) ? c.source : 'ai',
      refs: [], confidence: typeof c.confidence === 'number' ? c.confidence : 0.5,
      note: '来自导入卡片' + (c.note ? '：' + String(c.note).slice(0, 80) : ''),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));
  if (Array.isArray(data.dynamic)) {
    bundle.dynamic = data.dynamic
      .filter(d => d && d.text)
      .map(d => ({ id: require('./store').uid(), text: String(d.text).slice(0, 300), asOf: typeof d.asOf === 'string' ? d.asOf : new Date().toISOString(), resolved: !!d.resolved, createdAt: new Date().toISOString() }));
  }
  store.savePerson(bundle);
  return { id: bundle.id, name: bundle.name, claims: bundle.claims.length };
});

process.on('uncaughtException', (err) => {
  try {
    const logFile = path.join(app.getPath('userData'), 'habitat-data', 'error.log');
    // 简单轮转：超过 512KB 重写
    try { if (fs.statSync(logFile).size > 512 * 1024) fs.writeFileSync(logFile, ''); } catch {}
    fs.appendFileSync(logFile, new Date().toISOString() + ' ' + (err.stack || String(err)) + '\n');
  } catch {}
});
