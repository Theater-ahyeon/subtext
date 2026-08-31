'use strict';
/**
 * 知微 · Web 宿主：把与 Electron 共享的业务路由（api-core）以本地 HTTP 服务暴露。
 *
 *   node web/server.js [--port 4173] [--data <数据目录>]
 *
 * 安全边界：
 *   - 只监听 127.0.0.1，不对局域网开放；无鉴权，因此不要用 0.0.0.0 启动
 *   - 与桌面版共用同一数据目录（可用 --data 覆盖）；⚠ 桌面版与网页版同时写入存在并发覆盖风险，二选一运行
 *   - 无 Cookie/会话；CSP 与渲染层转义沿用渲染层自身基线
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createCore } = require('../src/main/api-core');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('-') ? process.argv[i + 1] : def;
}

function defaultDataDir() {
  switch (process.platform) {
    case 'win32': return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'habitat-sandbox', 'habitat-data');
    case 'darwin': return path.join(os.homedir(), 'Library', 'Application Support', 'habitat-sandbox', 'habitat-data');
    default: return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'habitat-sandbox', 'habitat-data');
  }
}

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const PORT = Number(arg('port', process.env.HABITAT_WEB_PORT || 4173));
const DATA_DIR = path.resolve(arg('data', process.env.HABITAT_DATA_DIR || defaultDataDir()));

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const core = createCore({
  dataDir: DATA_DIR,
  version: pkg.version,
  platform: process.platform,
  secure: {
    // Web 宿主无系统密钥服务：API Key 明文保存于 settings.json（keyEncrypted=false 会在设置页如实提示）
    unwrapSettings: (s) => s,
    encryptPatch: (_current, patch) => patch,
  },
});
const ALLOWED = new Set(Object.keys(core.routes));

const MAX_BODY = 25 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

let indexHtml = null;
let indexMtime = 0;
function getIndexHtml() {
  const file = path.join(RENDERER, 'index.html');
  const mtime = fs.statSync(file).mtimeMs;
  if (indexHtml === null || mtime !== indexMtime) {
    indexHtml = fs.readFileSync(file, 'utf8')
      .replace('<script src="js/constants.js"></script>',
        '<script src="/js/habitat-http.js"></script>\n  <script src="js/constants.js"></script>');
    indexMtime = mtime;
  }
  return indexHtml;
}

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function serveStatic(res, urlPath) {
  const rel = decodeURIComponent(urlPath).replace(/\+/g, ' ');
  const target = path.resolve(path.join(RENDERER, rel));
  if (!target.startsWith(RENDERER + path.sep) && target !== RENDERER) return send(res, 403, JSON.stringify({ ok: false, error: '禁止访问' }));
  let file = target;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, JSON.stringify({ ok: false, error: '未找到' }));
  const ext = path.extname(file).toLowerCase();
  send(res, 200, fs.readFileSync(file), MIME[ext] || 'application/octet-stream');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, JSON.stringify({ ok: true, data: { status: 'up', dataDir: DATA_DIR } }));
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, getIndexHtml(), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && url.pathname === '/js/habitat-http.js') {
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'web', 'habitat-http.js')), 'text/javascript; charset=utf-8');
    }

    if (req.method === 'GET') return serveStatic(res, url.pathname);

    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const channel = url.pathname.slice(5);
      if (!ALLOWED.has(channel)) return send(res, 404, JSON.stringify({ ok: false, error: '未知接口' }));

      let raw = '';
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) return send(res, 413, JSON.stringify({ ok: false, error: '请求体过大' }));
        raw += chunk;
      }
      let payload = {};
      if (raw) {
        try { payload = JSON.parse(raw); } catch { return send(res, 400, JSON.stringify({ ok: false, error: '请求不是合法 JSON' })); }
      }

      const fn = core.routes[channel];
      try {
        const data = await fn(payload);
        return send(res, 200, JSON.stringify({ ok: true, data: data === undefined ? null : data }));
      } catch (err) {
        const e = err || {};
        return send(res, 200, JSON.stringify({ ok: false, error: e.message || String(err), blocked: !!e.blocked, reply: e.blocked || undefined }));
      }
    }

    send(res, 404, JSON.stringify({ ok: false, error: '未找到' }));
  } catch (err) {
    core.logError(err);
    send(res, 500, JSON.stringify({ ok: false, error: '服务内部错误' }));
  }
});

// 仅本机回环地址：该服务无鉴权，禁止对局域网开放
server.listen(PORT, '127.0.0.1', () => {
  console.log('知微 · Web 宿主已启动');
  console.log('  地址:     http://127.0.0.1:' + PORT);
  console.log('  数据目录: ' + DATA_DIR);
  console.log('  注意:     与桌面版共用档案时，请勿同时运行两者并写入');
  process.on('uncaughtException', (err) => core.logError(err));
  process.on('unhandledRejection', (reason) => core.logError(reason instanceof Error ? reason : new Error(String(reason))));
});
