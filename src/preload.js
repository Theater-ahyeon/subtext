'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload).then(r => {
  if (!r) throw new Error('IPC 无响应');
  if (r.ok) return r.data;
  throw new Error(r.error || '未知错误');
});

contextBridge.exposeInMainWorld('habitat', {
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
    file: (p) => invoke('import:file', p),
  },
  card: {
    induce: (p, onProgress) => new Promise((resolve, reject) => {
      const listener = (e, prog) => { if (onProgress) try { onProgress(prog); } catch {} };
      ipcRenderer.on('induce:progress', listener);
      ipcRenderer.invoke('card:induce', p).then(r => {
        ipcRenderer.removeListener('induce:progress', listener);
        if (r && r.ok) resolve(r.data); else reject(new Error((r && r.error) || '归纳失败'));
      }).catch(err => {
        ipcRenderer.removeListener('induce:progress', listener);
        reject(err);
      });
    }),
    compile: (p) => invoke('card:compile', p),
    addClaim: (p) => invoke('claims:add', p),
    updateClaim: (p) => invoke('claims:update', p),
    delClaim: (p) => invoke('claims:delete', p),
    addDyn: (p) => invoke('dynamic:add', p),
    resolveDyn: (p) => invoke('dynamic:resolve', p),
    export: (p) => invoke('card:export', p),
    importCard: () => invoke('card:import'),
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
    unseen: (p) => invoke('analysis:unseen', p),
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
});
