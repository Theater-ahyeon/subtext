'use strict';
/**
 * Electron 主进程：窗口 + IPC 编排。
 * 所有业务逻辑在 store/pipeline/parser/prompts（可在无 Electron 环境测试）。
 */
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./store');
const parser = require('./parser');
const pipeline = require('./pipeline');
const P = require('./prompts');
const { chat } = require('./llm');

const store = new Store();
let win = null;

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
function withPerson(id, fn) {
  const bundle = store.loadPerson(id);
  if (!bundle) throw new Error('人物不存在');
  return fn(bundle);
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });
}

// ---------- app ----------
handle('app:info', () => ({ version: app.getVersion(), dataDir: path.join(app.getPath('userData'), 'habitat-data'), platform: process.platform }));

// ---------- persons ----------
handle('persons:list', () => store.listPersons());
handle('persons:create', ({ name, alias }) => store.createPerson(name, alias));
handle('persons:delete', ({ id }) => store.deletePerson(id));
handle('persons:get', ({ id }) => withPerson(id, b => b));
handle('persons:update', ({ id, patch }) => withPerson(id, b => {
  if (patch.name) b.name = patch.name;
  if (patch.alias !== undefined) b.alias = patch.alias;
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
  return { added: added.length, total: b.evidence.length };
}));
handle('evidence:delete', ({ id, evidenceId }) => withPerson(id, b => {
  b.evidence = b.evidence.filter(e => e.id !== evidenceId);
  store.savePerson(b);
  return true;
}));

// ---------- import ----------
handle('import:parse', ({ text, selfName }) => parser.parseAuto(text, { selfName }));
handle('import:commit', ({ id, messages, sourceType }) => withPerson(id, b => {
  const added = [];
  for (const m of messages.slice(0, 20000)) {
    if (!m.text || !String(m.text).trim()) continue;
    added.push(store.addEvidence(b, { sourceType, text: String(m.text).slice(0, 4000), ts: m.ts || '', sender: m.sender || '', isSelf: m.isSelf }));
  }
  store.savePerson(b);
  return { added: added.length, total: b.evidence.length };
}));
handle('import:file', async ({ id, sourceType, selfName }) => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择聊天记录导出文件',
    filters: [{ name: '聊天记录导出', extensions: ['json', 'jsonl', 'csv', 'txt', 'ndjson'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return { canceled: true };
  const text = fs.readFileSync(r.filePaths[0], 'utf8');
  const parsed = parser.parseAuto(text, { selfName });
  const result = await withPerson(id, b => {
    const added = [];
    for (const m of parsed.messages.slice(0, 20000)) {
      added.push(store.addEvidence(b, { sourceType, text: m.text, ts: m.ts, sender: m.sender, isSelf: m.isSelf }));
    }
    store.savePerson(b);
    return { added: added.length, total: b.evidence.length, format: parsed.format };
  });
  return { canceled: false, ...result };
});

// ---------- card / claims ----------
handle('card:induce', ({ id }, progressCb) => withPerson(id, async b => {
  return pipeline.inductEvidence(store, b, store.loadSettings(), {});
}));
handle('claims:add', ({ id, claim }) => withPerson(id, b => {
  const c = store.addClaim(b, claim);
  store.savePerson(b);
  return c;
}));
handle('claims:update', ({ id, claimId, patch }) => withPerson(id, b => {
  const c = b.claims.find(x => x.id === claimId);
  if (!c) throw new Error('条目不存在');
  for (const k of ['layer', 'text', 'epistemic', 'confidence', 'note']) {
    if (patch[k] !== undefined) c[k] = patch[k];
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
handle('session:start', async ({ id, scenario }) => withPerson(id, async b => {
  const { session, reply } = await pipeline.startSession(store, b, store.loadSettings(), scenario);
  return { sessionId: session.id, reply, messages: session.messages };
}));
handle('session:send', async ({ id, sessionId, text }) => withPerson(id, async b => {
  if (P.redlineCheck(text)) {
    return { blocked: true, reply: '[系统提示] 这个请求涉及操控、打压或伤害性策略，本工具不提供。演练的目的是帮你更好地理解与表达自己——比如如何诚实地说出你的需求，或如何接住对方的拒绝。' };
  }
  const reply = await pipeline.twinTurn(store, b, store.loadSettings(), sessionId, text);
  return { reply };
}));
handle('session:end', async ({ id, sessionId }) => withPerson(id, async b => {
  return { report: await pipeline.endSession(store, b, store.loadSettings(), sessionId) };
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
  return { prediction: await pipeline.freezePrediction(store, b, store.loadSettings(), sessionId) };
}));
handle('prediction:list', ({ id }) => withPerson(id, b => b.predictions.map(p => ({ ...p, hypotheses: p.hypotheses }))));
handle('feedback:submit', async ({ id, predictionId, raw }) => withPerson(id, async b => {
  return pipeline.submitFeedback(store, b, store.loadSettings(), { predictionId, raw });
}));
handle('attribution:list', ({ id }) => withPerson(id, b => b.attributions));

// ---------- stats / radar ----------
handle('stats:get', ({ id }) => withPerson(id, b => store.computeStats(b)));
handle('radar:get', ({ id }) => withPerson(id, b => pipeline.topicRadar(b)));

// ---------- interview ----------
handle('interview:state', ({ id }) => withPerson(id, b => ({
  started: b.interview.started, currentQ: b.interview.currentQ, records: b.interview.records,
  summaries: b.interview.summaries, final: b.interview.final, suggestions: b.interview.suggestions,
  questions: P.INTERVIEW_QUESTIONS,
})));
handle('interview:answer', async ({ id, qid, answer, skipped }) => withPerson(id, async b => {
  return pipeline.interviewAnswer(store, b, store.loadSettings(), { qid, answer, skipped });
}));
handle('interview:probeAnswer', async ({ id, qid, answer }) => withPerson(id, async b => {
  return pipeline.interviewProbeAnswer(store, b, store.loadSettings(), { qid, answer });
}));
handle('interview:summary', async ({ id }) => withPerson(id, async b => {
  return { text: await pipeline.interviewSummary(store, b, store.loadSettings()) };
}));
handle('interview:finalize', async ({ id }) => withPerson(id, async b => {
  return pipeline.interviewFinalize(store, b, store.loadSettings());
}));
handle('interview:writeClaims', ({ id, indexes }) => withPerson(id, b => {
  return { written: pipeline.interviewWriteClaims(store, b, indexes) };
}));

// ---------- settings ----------
handle('settings:get', () => store.loadSettings());
handle('settings:set', (patch) => {
  if (patch.provider === 'openai') {
    // 允许保留 mock 的空 key，但连接测试会兜底
  }
  return store.saveSettings(patch);
});
handle('settings:test', async () => {
  const s = store.loadSettings();
  const reply = await chat(s, [{ role: 'user', content: '连接测试，请回复"连接正常"四个字。' }], { task: 'TWIN', temperature: 0, timeoutMs: 20000 });
  return { reply: String(reply).slice(0, 100) };
});

// ---------- export / import card ----------
handle('card:export', async ({ id }) => {
  const bundle = store.loadPerson(id);
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

// ---------- misc ----------
handle('shell:openPath', ({ p }) => shell.openPath(p));

app.on('uncatchException', () => {});
process.on('uncaughtException', (err) => {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'habitat-data', 'error.log'), new Date().toISOString() + ' ' + (err.stack || String(err)) + '\n'); } catch {}
});
