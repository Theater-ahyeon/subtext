'use strict';
/**
 * 共享 API 核心：Electron IPC 与 Web HTTP 两个宿主共用的全部业务路由。
 * 宿主差异通过依赖注入解决：
 *   - secure：API Key 的加密策略（Electron=safeStorage/DPAPI；Web=明文落盘，keyEncrypted=false 会在设置页如实提示）
 *   - appInfo：版本号来源（Electron=app.getVersion()；Web=package.json）
 *   - dataDir：数据目录（Web 默认与桌面版同一目录，共用档案）
 * 浏览器端特有的文件传输（导入/导出）走 *:data 通道，由渲染层垫片编码后提交。
 */
const path = require('path');
const fs = require('fs');
const util = require('util');
const { Store, uid } = require('./store');
const parser = require('./parser');
const pipeline = require('./pipeline');
const P = require('./prompts');
const { chat, fetchModels } = require('./llm');
const memory = require('./memory');

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const CLAIM_LAYERS = ['basic', 'life', 'temperament', 'expression'];
const CLAIM_EPISTEMICS = ['fact', 'inference', 'blank'];

function createCore({ dataDir, version, platform, secure }) {
  const store = new Store();
  store.init(dataDir);

  function validId(id) {
    if (!ID_RE.test(String(id || ''))) throw new Error('非法的人物 id');
    return String(id);
  }

  // 人物级互斥：所有读-改-写按 personId 串行，防并发覆盖（演练双发/归纳期间编辑）
  const personLocks = new Map();
  function withPerson(id, fn) {
    const pid = validId(id);
    const prev = personLocks.get(pid) || Promise.resolve();
    const next = prev.then(() => {
      const bundle = store.loadPerson(pid);
      if (!bundle) throw new Error('档案不存在');
      return fn(bundle);
    });
    personLocks.set(pid, next.catch(() => {}));
    return next;
  }

  /** 内部用完整设置（含解密后的 key）；宿主 UI 永远拿不到明文 key */
  function effectiveSettings() {
    return secure.unwrapSettings(store.loadSettings());
  }

  /** 聊天导出原始字节 → UTF-8/GBK 解码（QQ/TXT 导出常见 ANSI）→ 解析 */
  function decodeChatBuffer(buf) {
    let text = buf.toString('utf8');
    const bad = (text.match(/\uFFFD/g) || []).length;
    if (bad > text.length * 0.001) {
      try { text = new util.TextDecoder('gbk').decode(buf); } catch { /* 无 GBK 解码器则保留 utf8 结果 */ }
    }
    return text;
  }

  function importParsedMessages(b, parsed, sourceType) {
    const LIMIT = 20000;
    const list = parsed.messages.slice(0, LIMIT);
    for (const m of list) {
      if (!m.text || !String(m.text).trim()) continue;
      store.addEvidence(b, { sourceType, text: String(m.text).slice(0, 4000), ts: m.ts || '', sender: m.sender || '', isSelf: m.isSelf });
    }
    store.savePerson(b);
    return { added: list.length, total: b.evidence.length, format: parsed.format, truncated: Math.max(0, parsed.messages.length - LIMIT) };
  }

  const routes = {
    // ---------- app ----------
    'app:info': () => ({ version, dataDir, platform, corruptArchives: store.getCorruptCount() }),

    // ---------- persons ----------
    'persons:list': () => store.listPersons(),
    'persons:create': ({ name, alias }) => store.createPerson(String(name || '').slice(0, 20), String(alias || '').slice(0, 30)),
    'persons:delete': ({ id }) => { validId(id); store.deletePerson(id); store.purgePersonMedia(id); return true; },
    'persons:get': ({ id }) => withPerson(id, b => b),
    'persons:update': ({ id, patch }) => withPerson(id, b => {
      if (patch.name) b.name = String(patch.name).slice(0, 20);
      if (patch.alias !== undefined) b.alias = String(patch.alias).slice(0, 30);
      return store.savePerson(b);
    }),

    // ---------- evidence ----------
    'evidence:add': ({ id, items }) => withPerson(id, b => {
      const added = [];
      for (const it of items.slice(0, 500)) {
        const text = String(it.text || '').slice(0, 4000);
        let media = null, mediaMime = null;
        // 图片证据：字节校验+落盘在 store 层（魔数白名单，不信渲染层声明的 mime）
        if (it.mediaB64) {
          try {
            const saved = store.saveImage(b.id, Buffer.from(String(it.mediaB64), 'base64'));
            media = saved.media; mediaMime = saved.mime;
          } catch (err) { throw err; }
        }
        if (!text.trim() && !media) continue;
        added.push(store.addEvidence(b, {
          sourceType: String(it.sourceType || 'other').slice(0, 64),
          text, media, mediaMime,
          ts: String(it.ts || '').slice(0, 64),
          sender: String(it.sender || '').slice(0, 64),
          isSelf: it.isSelf,
        }));
      }
      store.savePerson(b);
      return { added: added.length, total: b.evidence.length, truncated: Math.max(0, (items || []).length - 500) };
    }),
    'evidence:delete': ({ id, evidenceId }) => withPerson(id, b => {
      const item = b.evidence.find(e => e.id === evidenceId);
      b.evidence = b.evidence.filter(e => e.id !== evidenceId);
      if (item && item.media) store.deleteImage(b.id, item.media);
      store.savePerson(b);
      return true;
    }),
    /** 图片字节读取（渲染层 <img> 用）。*:data 风格：Web 走垫片；Electron 由 main 直接返回 base64 */
    'evidence:media': ({ id, evidenceId, thumb }) => {
      validId(id);
      const bundle = store.loadPerson(id);
      if (!bundle) throw new Error('档案不存在');
      const item = bundle.evidence.find(e => e.id === evidenceId);
      if (!item || !item.media) throw new Error('该证据没有图片');
      const f = store.readImage(id, item.media, { thumb: !!thumb });
      if (!f) throw new Error('图片文件缺失（可能被外部删除）');
      return { dataB64: f.data.toString('base64'), mime: f.mime };
    },

    // ---------- import ----------
    'import:parse': ({ text, selfName }) => parser.parseAuto(String(text || '').slice(0, MAX_IMPORT_BYTES * 2), { selfName }),
    'import:commit': ({ id, messages, sourceType }) => withPerson(id, b => {
      const LIMIT = 20000;
      const list = (messages || []).slice(0, LIMIT);
      const added = [];
      for (const m of list) {
        if (!m.text || !String(m.text).trim()) continue;
        added.push(store.addEvidence(b, { sourceType, text: String(m.text).slice(0, 4000), ts: m.ts || '', sender: m.sender || '', isSelf: m.isSelf }));
      }
      store.savePerson(b);
      return { added: added.length, total: b.evidence.length, truncated: Math.max(0, (messages || []).length - LIMIT) };
    }),
    /** Web 专用：渲染层读取文件后以 base64 提交原始字节，编码检测在宿主侧完成 */
    'import:file:data': async ({ id, sourceType, selfName, size, dataB64 }) => {
      if (!Number.isFinite(size) || size > MAX_IMPORT_BYTES) throw new Error(`文件超过 20MB（当前 ${Math.round((size || 0) / 1024 / 1024)}MB），请先拆分后再导入`);
      const buf = Buffer.from(String(dataB64 || ''), 'base64');
      const parsed = parser.parseAuto(decodeChatBuffer(buf), { selfName });
      const result = await withPerson(id, b => importParsedMessages(b, parsed, sourceType));
      return { canceled: false, ...result };
    },

    // ---------- card / claims ----------
    'card:induce': ({ id }, onProgress) => withPerson(id, b => pipeline.inductEvidence(store, b, effectiveSettings(), {
      onProgress: (prog) => { if (onProgress) try { onProgress(prog); } catch {} },
    })),
    'claims:add': ({ id, claim }) => withPerson(id, b => {
      if (P.redlineCheck(claim && claim.text)) throw new Error('内容包含操控/伤害类描述，本工具不录入这类内容');
      const c = store.addClaim(b, { ...claim, text: String(claim.text || '').slice(0, 200) });
      store.savePerson(b);
      return c;
    }),
    'claims:update': ({ id, claimId, patch }) => withPerson(id, b => {
      const c = b.claims.find(x => x.id === claimId);
      if (!c) throw new Error('条目不存在');
      if (patch.text !== undefined) {
        if (P.redlineCheck(patch.text)) throw new Error('内容包含操控/伤害类描述，本工具不录入这类内容');
        c.text = String(patch.text).slice(0, 200);
      }
      if (patch.layer !== undefined && CLAIM_LAYERS.includes(patch.layer)) c.layer = patch.layer;
      if (patch.epistemic !== undefined && CLAIM_EPISTEMICS.includes(patch.epistemic)) c.epistemic = patch.epistemic;
      if (patch.confidence !== undefined) c.confidence = Math.min(1, Math.max(0, Number(patch.confidence) || 0));
      if (patch.note !== undefined) c.note = String(patch.note).slice(0, 200);
      c.updatedAt = new Date().toISOString();
      store.savePerson(b);
      return c;
    }),
    'claims:delete': ({ id, claimId }) => withPerson(id, b => {
      b.claims = b.claims.filter(c => c.id === claimId ? false : true);
      store.savePerson(b);
      return true;
    }),
    'dynamic:add': ({ id, text }) => withPerson(id, b => {
      if (P.redlineCheck(text)) throw new Error('内容包含操控/伤害类描述，本工具不录入这类内容');
      const d = { id: uid(), text: String(text).slice(0, 300), asOf: new Date().toISOString(), resolved: false, createdAt: new Date().toISOString() };
      b.dynamic.push(d);
      store.savePerson(b);
      return d;
    }),
    'dynamic:resolve': ({ id, dynId }) => withPerson(id, b => {
      const d = b.dynamic.find(x => x.id === dynId);
      if (d) d.resolved = true;
      store.savePerson(b);
      return d;
    }),
    'card:compile': ({ id }) => withPerson(id, b => P.compileCard(b)),

    // ---------- session / rehearsal ----------
    'session:start': ({ id, scenario, goal }) => withPerson(id, async b => {
      const { session, reply } = await pipeline.startSession(store, b, effectiveSettings(), scenario, goal);
      return { sessionId: session.id, reply, messages: session.messages };
    }),
    'session:send': ({ id, sessionId, text }) => withPerson(id, async b => {
      try {
        const reply = await pipeline.twinTurn(store, b, effectiveSettings(), sessionId, text);
        return { reply };
      } catch (err) {
        if (err && err.blocked) return { blocked: true, reply: err.blocked };
        throw err;
      }
    }),
    'session:end': ({ id, sessionId }) => withPerson(id, async b => pipeline.endSession(store, b, effectiveSettings(), sessionId)),
    'session:list': ({ id }) => withPerson(id, b => b.sessions.map(s => ({ id: s.id, scenario: s.scenario, status: s.status, createdAt: s.createdAt, turns: s.messages.filter(m => m.role === 'user').length }))),
    'session:get': ({ id, sessionId }) => withPerson(id, b => {
      const s = b.sessions.find(x => x.id === sessionId);
      if (!s) throw new Error('会话不存在');
      const report = (b.sessionReports || []).find(r => r.sessionId === sessionId);
      return { session: s, report: report ? report.report : null };
    }),

    // ---------- prediction / feedback ----------
    'prediction:freeze': ({ id, sessionId }) => withPerson(id, async b => ({ prediction: await pipeline.freezePrediction(store, b, effectiveSettings(), sessionId) })),
    'prediction:list': ({ id }) => withPerson(id, b => b.predictions),
    'feedback:submit': ({ id, predictionId, raw }) => withPerson(id, b => pipeline.submitFeedback(store, b, effectiveSettings(), { predictionId, raw })),
    'attribution:list': ({ id }) => withPerson(id, b => b.attributions),
    'attribution:undo': ({ id, attributionId }) => withPerson(id, b => ({ reverted: pipeline.undoAttribution(store, b, attributionId) })),

    // ---------- 事件记忆 ----------
    'memory:list': ({ id }) => withPerson(id, b => memory.list(b)),
    'memory:delete': ({ id, memoryId }) => withPerson(id, b => { const removed = memory.remove(b, memoryId); store.savePerson(b); return { removed }; }),
    'memory:clear': ({ id }) => withPerson(id, b => { memory.clear(b); store.savePerson(b); return true; }),
    'memory:rebuild': ({ id }) => withPerson(id, async b => memory.rebuild(store, b, effectiveSettings())),
    'memory:recall': ({ id, query }) => withPerson(id, async b => memory.recall(b, effectiveSettings(), String(query || '').slice(0, 2000), { k: 8 })),

    // ---------- stats / radar ----------
    'stats:get': ({ id }) => withPerson(id, b => store.computeStats(b)),
    'radar:get': ({ id }) => withPerson(id, b => pipeline.topicRadar(b)),

    // ---------- 人物档案槽位 ----------
    'profile:set': ({ id, slots }) => withPerson(id, b => {
      const P = require('./prompts');
      const prof = pipeline.ensureProfile(b);
      const keys = new Set(P.PROFILE_KEYS);
      for (const [key, val] of Object.entries(slots || {})) {
        if (!keys.has(key)) continue;
        const def = P.PROFILE_SLOTS.find(d => d.key === key);
        if (def.type === 'single') {
          const text = String(val && val.value || '').slice(0, 40);
          if (text) prof.slots[key] = { value: text, source: 'user' };
          else delete prof.slots[key];
        } else if (Array.isArray(val)) {
          const arr = val.map(x => ({ text: String(x && x.text || x || '').slice(0, 40), source: 'user' })).filter(x => x.text).slice(0, 10);
          if (arr.length) prof.slots[key] = arr;
          else delete prof.slots[key];
        }
      }
      prof.updatedAt = new Date().toISOString();
      store.savePerson(b);
      return b.profile;
    }),
    'profile:extract': ({ id }) => withPerson(id, async b => ({ profile: await pipeline.profileExtract(store, b, effectiveSettings()) })),

    // ---------- 深度分析 ----------
    'analysis:person': ({ id }) => withPerson(id, async b => {
      const r = await pipeline.analyzePerson(store, b, effectiveSettings());
      const digest = pipeline.personDigest(b, store);
      return { ...r, digest };
    }),
    'analysis:unseen': ({ id, message, context }) => withPerson(id, async b => pipeline.analyzeUnseen(store, b, effectiveSettings(), { message, context })),
    'analysis:followUp': ({ id, digest, history, question }) => withPerson(id, async b => ({
      answer: (await pipeline.analysisFollowUp(store, b, effectiveSettings(), { digest, history, question })).answer,
    })),
    'analysis:scenario': ({ id, scenario }) => withPerson(id, async b => pipeline.analyzeScenario(store, b, effectiveSettings(), scenario)),

    // ---------- interview ----------
    'interview:state': ({ id }) => withPerson(id, b => ({
      started: b.interview.started, currentQ: b.interview.currentQ, records: b.interview.records,
      summaries: b.interview.summaries, final: b.interview.final, suggestions: b.interview.suggestions,
      questions: P.INTERVIEW_QUESTIONS,
    })),
    'interview:start': ({ id }) => withPerson(id, b => {
      b.interview.started = true;
      if (!b.interview.currentQ) b.interview.currentQ = 1;
      store.savePerson(b);
      return true;
    }),
    'interview:answer': ({ id, qid, answer, skipped }) => withPerson(id, b => pipeline.interviewAnswer(store, b, effectiveSettings(), { qid, answer, skipped })),
    'interview:probeAnswer': ({ id, qid, answer }) => withPerson(id, b => pipeline.interviewProbeAnswer(store, b, effectiveSettings(), { qid, answer })),
    'interview:summary': ({ id }) => withPerson(id, async b => ({ text: await pipeline.interviewSummary(store, b, effectiveSettings()) })),
    'interview:finalize': ({ id }) => withPerson(id, b => pipeline.interviewFinalize(store, b, effectiveSettings())),
    'interview:writeClaims': ({ id, indexes }) => withPerson(id, b => ({ written: pipeline.interviewWriteClaims(store, b, indexes) })),

    // ---------- settings ----------
    'settings:get': () => {
      const s = store.loadSettings();
      return { ...s, apiKey: '', hasApiKey: !!(s.apiKey || s.apiKeyEnc), keyEncrypted: !!s.apiKeyEnc };
    },
    'settings:set': (patch) => store.saveSettings(secure.encryptPatch(store.loadSettings(), patch || {})),
    'settings:test': async () => {
      const s = effectiveSettings();
      const reply = await chat(s, [{ role: 'user', content: '连接测试，请回复"连接正常"四个字。' }], { task: 'TWIN', temperature: 0, timeoutMs: 25000 });
      return { reply: String(reply).slice(0, 100) };
    },
    'settings:models': async () => {
      const s = effectiveSettings();
      const list = await fetchModels(s);
      return { models: list.slice(0, 100) };
    },

    // ---------- 导出 / 导入（数据部分；文件对话框由宿主实现） ----------
    'card:export:data': ({ id }) => {
      const bundle = store.loadPerson(validId(id));
      if (!bundle) throw new Error('档案不存在');
      return {
        filename: `${bundle.name}-理解卡-${new Date().toISOString().slice(0, 10)}.json`,
        data: {
          format: 'rehearsal-card', version: 2, exportedAt: new Date().toISOString(),
          name: bundle.name, alias: bundle.alias,
          claims: bundle.claims, dynamic: bundle.dynamic,
          interviewFinal: bundle.interview.final ? bundle.interview.final.text : null,
          compiledCard: P.compileCard(bundle),
        },
      };
    },
    'card:import:data': ({ data }) => {
      const FORMAT_IDS = ['rehearsal-card', 'habitat-sandbox-card']; // 兼容旧版导出文件
      if (!data || !FORMAT_IDS.includes(data.format) || !Array.isArray(data.claims)) {
        throw new Error('不是本工具导出的理解卡文件（缺少 format 标识）');
      }
      const bundle = store.createPerson(String(data.name || '导入人物').slice(0, 18) + '（导入）', String(data.alias || '').slice(0, 30));
      bundle.claims = data.claims
        .filter(c => c && c.text && P.LAYER_NAMES[c.layer])
        .map(c => ({
          id: uid(), layer: c.layer,
          text: String(c.text).slice(0, 200),
          epistemic: CLAIM_EPISTEMICS.includes(c.epistemic) ? c.epistemic : 'inference',
          source: ['evidence', 'user', 'ai'].includes(c.source) ? c.source : 'ai',
          refs: [], confidence: typeof c.confidence === 'number' ? c.confidence : 0.5,
          note: '来自导入卡片' + (c.note ? '：' + String(c.note).slice(0, 80) : ''),
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }));
      if (Array.isArray(data.dynamic)) {
        bundle.dynamic = data.dynamic
          .filter(d => d && d.text)
          .map(d => ({ id: uid(), text: String(d.text).slice(0, 300), asOf: typeof d.asOf === 'string' ? d.asOf : new Date().toISOString(), resolved: !!d.resolved, createdAt: new Date().toISOString() }));
      }
      store.savePerson(bundle);
      return { id: bundle.id, name: bundle.name, claims: bundle.claims.length };
    },
  };

  return {
    routes,
    store,
    withPerson,
    validId,
    /** 供宿主「另存为」流程使用：返回导出数据对象 */
    exportCardData: routes['card:export:data'],
    importCardData: routes['card:import:data'],
    /** Electron 的 import:file 在对话框读文件后复用此处解码+解析+落库 */
    importTextFromBuffer: async (id, buf, sourceType, selfName) => {
      if (buf.length > MAX_IMPORT_BYTES) throw new Error(`文件超过 20MB（当前 ${Math.round(buf.length / 1024 / 1024)}MB），请先拆分后再导入`);
      const parsed = parser.parseAuto(decodeChatBuffer(buf), { selfName });
      return withPerson(id, b => importParsedMessages(b, parsed, sourceType));
    },
    logError(err) {
      try {
        const logFile = path.join(dataDir, 'error.log');
        try { if (fs.statSync(logFile).size > 512 * 1024) fs.writeFileSync(logFile, ''); } catch {}
        const text = (err && err.stack ? err.stack : String(err));
        fs.appendFileSync(logFile, new Date().toISOString() + ' ' + text + '\n');
      } catch {}
    },
  };
}

module.exports = { createCore, MAX_IMPORT_BYTES };
