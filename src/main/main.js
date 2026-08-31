'use strict';
/**
 * Electron 主进程：窗口 + IPC 编排。
 * 全部业务路由在 api-core（与 Web 宿主共用同一份实现）；此处只保留：
 * 窗口/菜单/单实例锁/安全基线、safeStorage(DPAPI) 密钥加密、文件对话框三类宿主能力。
 */
const { app, BrowserWindow, ipcMain, dialog, Menu, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { createCore, MAX_IMPORT_BYTES } = require('./api-core');

let win = null;
let core = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

// 数据目录钉住：产品改名（彩排）后 userData 默认路径会跟随新名字变化，
// 这里显式钉在旧目录 %APPDATA%/habitat-sandbox，保证老用户档案无感延续。
app.setPath('userData', path.join(app.getPath('appData'), 'habitat-sandbox'));

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1080, minHeight: 700,
    backgroundColor: '#f6efe4',
    title: '彩排 · Rehearsal',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  // SPA 无合法导航需求：一律拦截（防止被注入渲染层把窗口导到本地恶意页面获得 IPC 桥）
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
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

  const dataDir = path.join(app.getPath('userData'), 'habitat-data');
  core = createCore({
    dataDir,
    version: app.getVersion(),
    platform: process.platform,
    secure: {
      /** 渲染层永远拿不到明文 key：读取时解密 */
      unwrapSettings(s) {
        if (s.apiKeyEnc && !s.apiKey) {
          try { s.apiKey = safeStorage.decryptString(Buffer.from(s.apiKeyEnc, 'base64')); }
          catch { s.apiKey = ''; }
        }
        if (s.embedApiKeyEnc && !s.embedApiKey) {
          try { s.embedApiKey = safeStorage.decryptString(Buffer.from(s.embedApiKeyEnc, 'base64')); }
          catch { s.embedApiKey = ''; }
        }
        return s;
      },
      /** 写入时加密；加密不可用则退回明文（settings:get 的 keyEncrypted=false 会向 UI 暴露此状态） */
      encryptPatch(_current, patch) {
        const out = { ...patch };
        delete out.apiKeyEnc;      // 密文只允许主进程写入，渲染层不能直写
        delete out.embedApiKeyEnc;
        const crypt = (plain) => {
          if (safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()) {
            try { return { enc: safeStorage.encryptString(plain).toString('base64') }; } catch { return { plain }; }
          }
          return { plain };
        };
        for (const [key, encKey] of [['apiKey', 'apiKeyEnc'], ['embedApiKey', 'embedApiKeyEnc']]) {
          if (typeof out[key] === 'string') {
            if (out[key] === '') {
              delete out[key];
              out[encKey] = ''; // 显式清除（UI"清除 Key"按钮）
            } else {
              const r = crypt(out[key]);
              if (r.enc) { out[encKey] = r.enc; delete out[key]; }
            }
          }
        }
        return out;
      },
    },
  });

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---------- IPC 注册：与 Web 宿主共享的路由 ----------
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

app.whenReady().then(() => {
  for (const [channel, fn] of Object.entries(core.routes)) {
    if (channel === 'card:induce') {
      // 归纳进度：经 event.sender 推送到渲染层（Web 宿主无此通道，垫片忽略进度回调）
      handle(channel, (payload, event) => core.routes[channel](payload, (prog) => {
        try { event.sender.send('induce:progress', prog); } catch {}
      }));
    } else {
      handle(channel, fn);
    }
  }

  // ---------- 仅 Electron：文件对话框三类 ----------
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
    const result = await core.importTextFromBuffer(id, buf, sourceType, selfName);
    return { canceled: false, ...result };
  });

  handle('card:export', async ({ id }) => {
    const { filename, data } = core.exportCardData({ id });
    const r = await dialog.showSaveDialog(win, {
      title: '导出理解卡',
      defaultPath: filename,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2), 'utf8');
    return { path: r.filePath };
  });

  handle('card:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '导入理解卡',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    let data;
    try { data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')); }
    catch { throw new Error('文件不是合法 JSON'); }
    return core.importCardData({ data });
  });
});

function logError(err) {
  if (!core) return;
  try {
    const home = app.getPath('home');
    // 脱敏：本机用户路径替换为 ~
    const text = (err && err.stack ? err.stack : String(err)).split(home).join('~');
    core.logError({ stack: text });
  } catch {}
}
process.on('uncaughtException', logError);
process.on('unhandledRejection', (reason) => logError(reason instanceof Error ? reason : new Error(String(reason))));
