'use strict';
/**
 * 关系图谱（跨人物）：从各对象的认知条目/档案中提取人物与关系，
 * 与有档案的人物节点合并成图。图谱是推导视图（带证据引用），用户手补的
 * 关系（source='user'）在重建时永远保留。条目变更时置 stale 标记。
 */
const { uid, now } = require('./store');
const P = require('./prompts');

const STANCES = ['positive', 'negative', 'neutral', 'complex'];

function ensureGraph(graph) {
  if (!graph || !Array.isArray(graph.nodes)) return { version: 1, updatedAt: null, stale: false, nodes: [], edges: [] };
  if (!Array.isArray(graph.edges)) graph.edges = [];
  return graph;
}

/** mock / 降级抽取：正则启发式（称呼词 + 引号名），诚实标注为弱提取 */
function heuristicExtract(bundles) {
  const people = [];
  const relations = [];
  const TITLE_RE = /(父亲|母亲|爸妈|爸爸|妈妈|哥哥|姐姐|弟弟|妹妹|爷爷|奶奶|外婆|外公|闺蜜|室友|同事|同学|上司|老板|老师|前男友|前女友|表妹|表哥|表姐|堂兄|堂妹|侄子|侄女|邻居)/;
  const seen = new Set();
  for (const b of bundles) {
    const list = (b.claims || []).concat(
      (b.profile && b.profile.slots) ? Object.entries(b.profile.slots)
        .filter(([k, v]) => ['family', 'hobbies', 'foods', 'likes', 'dislikes'].includes(k))
        .flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map(x => ({ id: 'profile-' + k + '-' + (x && x.text || x), text: (x && x.text) || '' }))) : []
    );
    for (const c of list) {
      const text = String(c && c.text || '');
      const m = text.match(TITLE_RE);
      if (!m) continue;
      const title = m[1];
      // 称呼后/前的 2~4 字中文名（如"闺蜜小林""她父亲老周"）
      const nm = text.match(new RegExp(title + '([\\u4e00-\\u9fa5]{2,4})')) || text.match(new RegExp('([\\u4e00-\\u9fa5]{2,4})' + title));
      const name = nm ? nm[1] : '她的' + title;
      const key = b.name + '→' + name + ':' + title;
      if (seen.has(key)) continue;
      seen.add(key);
      people.push({ name, role: b.name + ' 的' + title });
      relations.push({ a: b.name, b: name, type: title, stance: 'neutral', evidence: [c.id] });
    }
  }
  return { people, relations };
}

/**
 * 重建图谱：汇总所有对象的条目 → LLM（或 mock 启发式）抽取 → 合并 user 手补边。
 */
async function buildGraph(store, bundles, settings) {
  const graph = ensureGraph(store.loadGraph());
  const userEdges = graph.edges.filter(e => e.source === 'user');
  const userNodes = graph.nodes.filter(n => n.source === 'user');

  // 汇总条目文本（带 claim id 供引用）
  const parts = [];
  const personNames = [];
  for (const b of bundles) {
    personNames.push(b.name);
    const claims = (b.claims || []).filter(c => c.epistemic !== 'blank');
    if (!claims.length) continue;
    const lines = claims.map(c => `- [${c.id}] (${P.LAYER_NAMES[c.layer] || c.layer}) ${c.text}`);
    parts.push(`【对象：${b.name}${b.alias ? '(' + b.alias + ')' : ''}】\n${lines.join('\n')}`);
  }
  const peopleText = parts.join('\n\n') || '（暂无条目）';

  let extracted = { people: [], relations: [] };
  const mockLike = !settings.provider || settings.provider === 'mock' || !settings.apiKey && settings.provider !== 'ollama' && settings.provider !== 'gemini';
  const useMock = settings.provider === 'mock' || mockLike && !settings.apiKey;
  if (useMock || settings.provider === 'mock') {
    extracted = heuristicExtract(bundles);
  } else {
    const { chat, extractJson } = require('./llm');
    try {
      const raw = await chat(settings, [{ role: 'user', content: P.graphExtractPrompt(peopleText) }], { task: 'GRAPH', temperature: settings.analysisTemperature });
      const parsed = extractJson(raw);
      extracted = {
        people: (Array.isArray(parsed.people) ? parsed.people : []).slice(0, 40),
        relations: (Array.isArray(parsed.relations) ? parsed.relations : []).slice(0, 60),
      };
    } catch {
      extracted = heuristicExtract(bundles);
    }
  }

  // 节点：有档案的人物 + 抽取到的第三方
  const nodes = personNames.map(name => ({ id: 'person:' + name, kind: 'person', name, source: 'system' }));
  const personSet = new Set(personNames);
  for (const p of extracted.people) {
    const name = String(p && p.name || '').trim().slice(0, 20);
    if (!name || personSet.has(name)) continue;
    if (nodes.some(n => n.name === name)) continue;
    nodes.push({ id: 'figure:' + name, kind: 'figure', name, role: String(p.role || '').slice(0, 40), source: 'system' });
  }
  for (const n of userNodes) if (!nodes.some(x => x.id === n.id)) nodes.push(n);

  // 边：抽取关系（解析 a/b 到节点名）
  const nameById = new Map();
  for (const b of bundles) nameById.set(b.id, b.name);
  const edges = [];
  const resolveName = (who) => {
    const t = String(who || '').trim();
    if (!t) return null;
    if (t === 'TA' && personNames.length) return personNames[0];
    if (personSet.has(t)) return t;
    if (nameById.has(t)) return nameById.get(t);
    // 条目 id 直接引用 → 该对象本人
    return t;
  };
  for (const r of extracted.relations) {
    const a = resolveName(r.a), b = resolveName(r.b);
    if (!a || !b || a === b) continue;
    if (!nodes.some(n => n.name === a)) nodes.push({ id: 'figure:' + a, kind: 'figure', name: a, source: 'system' });
    if (!nodes.some(n => n.name === b)) nodes.push({ id: 'figure:' + b, kind: 'figure', name: b, source: 'system' });
    edges.push({
      id: uid(), a, b,
      type: String(r.type || '关系').slice(0, 20),
      stance: STANCES.includes(r.stance) ? r.stance : 'neutral',
      refs: (Array.isArray(r.evidence) ? r.evidence : []).slice(0, 4),
      source: 'ai', createdAt: now(),
    });
  }
  for (const e of userEdges) edges.push(e); // 用户手补永远保留

  const out = ensureGraph({ version: 1, updatedAt: now(), stale: false, nodes, edges });
  store.saveGraph(out);
  return out;
}

function markStale(store) {
  const g = store.loadGraph();
  if (g.stale) return;
  g.stale = true;
  store.saveGraph(g);
}

function addEdge(store, a, b, type, stance) {
  const graph = ensureGraph(store.loadGraph());
  const ea = String(a || '').trim().slice(0, 20);
  const eb = String(b || '').trim().slice(0, 20);
  if (!ea || !eb || ea === eb) throw new Error('两端名字不能为空且不能相同');
  const edge = {
    id: uid(), a: ea, b: eb,
    type: String(type || '关系').slice(0, 20),
    stance: STANCES.includes(stance) ? stance : 'neutral',
    refs: [], source: 'user', createdAt: now(),
  };
  graph.edges.push(edge);
  for (const name of [ea, eb]) {
    if (!graph.nodes.some(n => n.name === name)) {
      graph.nodes.push({ id: 'figure:' + name, kind: 'figure', name, source: 'user' });
    }
  }
  store.saveGraph(graph);
  return edge;
}

function removeEdge(store, edgeId) {
  const graph = ensureGraph(store.loadGraph());
  const before = graph.edges.length;
  graph.edges = graph.edges.filter(e => e.id !== edgeId);
  store.saveGraph(graph);
  return before - graph.edges.length;
}

module.exports = { ensureGraph, buildGraph, markStale, addEdge, removeEdge, heuristicExtract, STANCES };
