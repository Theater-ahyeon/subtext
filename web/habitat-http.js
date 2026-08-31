'use strict';
/**
 * 浏览器版 window.habitat 垫片：与 Electron preload.js 完全相同的 API 形状，
 * 传输层从 ipcRenderer.invoke 换成 POST /api/<channel>（同源，无跨域）。
 * 宿主差异：
 *   - card.induce 的进度回调在 Web 下为空实现（桌面版经 IPC 推送实时进度）
 *   - card.export / card.importCard / imp.file 改为浏览器文件下载与选择
 */
(function () {
  const invoke = async (channel, payload) => {
    let r;
    try {
      r = await fetch('/api/' + channel, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      });
    } catch {
      throw new Error('无法连接本地服务，请确认网页版服务已启动（node web/server.js）');
    }
    let j;
    try { j = await r.json(); } catch { throw new Error('服务响应异常（HTTP ' + r.status + '）'); }
    if (!j) throw new Error('无响应');
    if (j.ok) return j.data;
    const err = new Error(j.error || '未知错误');
    if (j.blocked) err.blocked = j.blocked;
    throw err;
  };

  const pickFile = (accept) => new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files && input.files[0] ? input.files[0] : null);
    input.click();
  });

  const readBase64 = (file) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || '').split(',')[1] || '');
    fr.onerror = () => reject(new Error('文件读取失败'));
    fr.readAsDataURL(file);
  });

  const downloadJson = (filename, data) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  window.habitat = {
    appInfo: () => invoke('app:info'),
    persons: {
      list: () => invoke('persons:list'),
      create: (p) => invoke('persons:create', p),
      del: (p) => invoke('persons:delete', p),
      get: (p) => invoke('persons:get', p),
      update: (p) => invoke('persons:update', p),
    },
    evidence: {
      add: (p) => invoke('evidence:add', p),
      del: (p) => invoke('evidence:delete', p),
      media: (p) => invoke('evidence:media', p),
    },
    imp: {
      parse: (p) => invoke('import:parse', p),
      commit: (p) => invoke('import:commit', p),
      file: async (p) => {
        const f = await pickFile('.json,.jsonl,.csv,.txt,.ndjson');
        if (!f) return { canceled: true };
        if (f.size > 20 * 1024 * 1024) throw new Error(`文件超过 20MB（当前 ${Math.round(f.size / 1024 / 1024)}MB），请先拆分后再导入`);
        const dataB64 = await readBase64(f);
        return invoke('import:file:data', { id: p.id, sourceType: p.sourceType, selfName: p.selfName, size: f.size, dataB64 });
      },
    },
    card: {
      induce: (p /* , onProgress —— Web 下无实时进度 */) => invoke('card:induce', p),
      compile: (p) => invoke('card:compile', p),
      addClaim: (p) => invoke('claims:add', p),
      updateClaim: (p) => invoke('claims:update', p),
      delClaim: (p) => invoke('claims:delete', p),
      addDyn: (p) => invoke('dynamic:add', p),
      resolveDyn: (p) => invoke('dynamic:resolve', p),
      export: async (p) => {
        const r = await invoke('card:export:data', p);
        downloadJson(r.filename, r.data);
        return { path: r.filename };
      },
      importCard: async () => {
        const f = await pickFile('.json,application/json');
        if (!f) return { canceled: true };
        let data;
        try { data = JSON.parse(await f.text()); }
        catch { throw new Error('文件不是合法 JSON'); }
        return invoke('card:import:data', { data });
      },
    },
    session: {
      start: (p) => invoke('session:start', p),
      send: (p) => invoke('session:send', p),
      end: (p) => invoke('session:end', p),
      list: (p) => invoke('session:list', p),
      get: (p) => invoke('session:get', p),
    },
    loop: {
      freeze: (p) => invoke('prediction:freeze', p),
      predictions: (p) => invoke('prediction:list', p),
      feedback: (p) => invoke('feedback:submit', p),
      attributions: (p) => invoke('attribution:list', p),
      undo: (p) => invoke('attribution:undo', p),
    },
    profile: {
      set: (p) => invoke('profile:set', p),
      extract: (p) => invoke('profile:extract', p),
    },
    analysis: {
      person: (p) => invoke('analysis:person', p),
      scenario: (p) => invoke('analysis:scenario', p),
      followUp: (p) => invoke('analysis:followUp', p),
    },
    memory: {
      list: (p) => invoke('memory:list', p),
      del: (p) => invoke('memory:delete', p),
      clear: (p) => invoke('memory:clear', p),
      rebuild: (p) => invoke('memory:rebuild', p),
      recall: (p) => invoke('memory:recall', p),
    },
    stats: (p) => invoke('stats:get', p),
    radar: (p) => invoke('radar:get', p),
    interview: {
      state: (p) => invoke('interview:state', p),
      start: (p) => invoke('interview:start', p),
      answer: (p) => invoke('interview:answer', p),
      probeAnswer: (p) => invoke('interview:probeAnswer', p),
      summary: (p) => invoke('interview:summary', p),
      finalize: (p) => invoke('interview:finalize', p),
      writeClaims: (p) => invoke('interview:writeClaims', p),
    },
    settings: {
      get: () => invoke('settings:get'),
      set: (p) => invoke('settings:set', p),
      test: () => invoke('settings:test'),
      models: () => invoke('settings:models'),
    },
  };
})();
