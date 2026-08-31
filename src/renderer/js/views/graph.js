'use strict';
/* 知微 · 视图：关系图谱（跨人物关系，力导向 SVG，条目变更自动标记待更新） */
(() => {
  const HB = window.HB;
  const { $, esc, toast, guard, modal, closeModal } = HB.ui;
  const H = HB.H;
  const state = HB.state;

  const STANCE_COLOR = { positive: '#4a7c59', negative: '#b05a52', neutral: '#8a8494', complex: '#6b5a9e' };
  const STANCE_LABEL = { positive: '亲近', negative: '紧张', neutral: '中性', complex: '复杂' };

  let nodes = [], edges = [], selected = null;
  let simTimer = null;

  /** 力导向：斥力 + 弹簧 + 向心，预迭代后渲染，拖拽时局部加温 */
  function simulate(iters) {
    const W = 860, H = 520, cx = W / 2, cy = H / 2;
    for (let it = 0; it < iters; it++) {
      const cool = 1 - it / iters;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy || 1;
          const f = 26000 / d2 * cool;
          const d = Math.sqrt(d2);
          dx /= d; dy /= d;
          a.vx += dx * f; a.vy += dy * f;
          b.vx -= dx * f; b.vy -= dy * f;
        }
      }
      for (const e of edges) {
        const a = nodes.find(n => n.id === e.a), b = nodes.find(n => n.id === e.b);
        if (!a || !b) continue;
        let dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const target = 170;
        const f = (d - target) * 0.012 * cool;
        dx /= d; dy /= d;
        a.vx += dx * f; a.vy += dy * f;
        b.vx -= dx * f; b.vy -= dy * f;
      }
      for (const n of nodes) {
        n.vx += (cx - n.x) * 0.008 * cool;
        n.vy += (cy - n.y) * 0.008 * cool;
        if (n.pinned) { n.vx = 0; n.vy = 0; continue; }
        n.x += Math.max(-14, Math.min(14, n.vx));
        n.y += Math.max(-14, Math.min(14, n.vy));
        n.vx *= 0.82; n.vy *= 0.82;
        n.x = Math.max(60, Math.min(W - 60, n.x));
        n.y = Math.max(50, Math.min(H - 50, n.y));
      }
    }
  }

  function renderSvg() {
    const svg = $('#graphSvg');
    if (!svg) return;
    const byName = new Map(nodes.map(n => [n.name, n]));
    const edgeHtml = edges.map(e => {
      const a = byName.get(e.a), b = byName.get(e.b);
      if (!a || !b) return '';
      const color = STANCE_COLOR[e.stance] || STANCE_COLOR.neutral;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const sel = selected && (selected.id === e.a || selected.id === e.b);
      return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${color}" stroke-width="${sel ? 2.5 : 1.4}" opacity="${sel ? 0.9 : 0.45}" ${e.source === 'user' ? 'stroke-dasharray="0"' : ''}/>
        <text x="${mx}" y="${my - 4}" text-anchor="middle" font-size="10.5" fill="${color}" opacity="${sel ? 0.95 : 0.7}">${esc(e.type)}</text>`;
    }).join('');
    const nodeHtml = nodes.map(n => {
      const isPerson = n.kind === 'person';
      const r = isPerson ? 26 : 20;
      const sel = selected && selected.id === n.id;
      return `<g class="gnode" data-id="${n.id}" style="cursor:pointer">
        <circle cx="${n.x}" cy="${n.y}" r="${r}" fill="${isPerson ? 'url(#gGrad)' : '#fbf6ec'}" stroke="${sel ? '#5b4a8a' : (isPerson ? '#8a5a2b' : 'var(--border-strong)')}" stroke-width="${sel ? 3 : 1.5}"/>
        <text x="${n.x}" y="${n.y + 4}" text-anchor="middle" font-size="14" font-weight="600" fill="${isPerson ? '#fff' : 'var(--text)'}">${esc(n.name.slice(0, 4))}</text>
        <text x="${n.x}" y="${n.y + r + 14}" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(n.name)}</text>
      </g>`;
    }).join('');
    svg.innerHTML = `
      <defs>
        <linearGradient id="gGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#6b5a9e"/><stop offset="1" stop-color="#8a5a2b"/>
        </linearGradient>
      </defs>
      ${edgeHtml}${nodeHtml}`;
    svg.querySelectorAll('.gnode').forEach(g => {
      const id = g.dataset.id;
      g.addEventListener('pointerdown', (e) => {
        const n = nodes.find(x => x.id === id);
        n.dragging = true; n.moved = 0;
        n.px = e.clientX; n.py = e.clientY;
        e.preventDefault();
      });
      g.addEventListener('pointermove', (e) => {
        const n = nodes.find(x => x.id === id);
        if (!n || !n.dragging) return;
        const svgR = svg.getBoundingClientRect();
        const scale = 900 / svgR.width;
        n.x = (e.clientX - svgR.left) * scale;
        n.y = (e.clientY - svgR.top) * (520 / svgR.height);
        n.moved += Math.abs(e.clientX - n.px) + Math.abs(e.clientY - n.py);
        n.px = e.clientX; n.py = e.clientY;
        renderSvg();
      });
      g.addEventListener('pointerup', () => {
        const n = nodes.find(x => x.id === id);
        if (!n) return;
        n.dragging = false;
        if (n.moved < 5) { selected = (selected && selected.id === id) ? null : n; showInfo(); }
        renderSvg();
      });
    });
  }

  function showInfo() {
    const box = $('#graphInfo');
    if (!box) return;
    if (!selected) { box.innerHTML = '<div class="muted small">点击节点查看关系详情；拖拽可整理布局。</div>'; return; }
    const rels = edges.filter(e => e.a === selected.name || e.b === selected.name);
    const relHtml = rels.length ? rels.map(e => {
      const otherId = e.a === selected.id ? e.b : e.a;
      const other = nodes.find(n => n.id === otherId);
      const otherName = other ? other.name : '?';
      return `<div class="list-row">
        <span class="verdict stance-${e.stance}">${STANCE_LABEL[e.stance] || e.stance}</span>
        <div class="grow"><div class="list-title">${esc(selected.name)} —${esc(e.type)}— ${esc(otherName)}</div>
        ${e.refs && e.refs.length ? `<div class="list-sub">证据条目 ${e.refs.length} 条</div>` : (e.source === 'user' ? '<div class="list-sub">手动添加</div>' : '')}</div>
        ${e.source === 'user' ? `<button class="btn sm danger" data-eredel="${e.id}">删</button>` : ''}
      </div>`;
    }).join('') : '<div class="muted small">暂无关系边。</div>';
    box.innerHTML = `
      <div class="panel-title">${esc(selected.name)} <span class="badge ${selected.kind === 'person' ? 'src-ai' : 'plain'}">${selected.kind === 'person' ? '有档案' : '第三方'}</span></div>
      ${selected.kind === 'person' ? '<button class="btn sm primary mt8" id="graphOpen">打开理解卡</button>' : ''}
      <div class="mt14">${relHtml}</div>`;
    const open = document.getElementById('graphOpen');
    if (open) open.onclick = () => {
      const p = state.persons.find(x => x.name === selected.name);
      if (!p) return toast('未找到该档案', 'err');
      state.currentId = p.id;
      state.currentName = p.name;
      HB.router.go('card');
    };
    box.querySelectorAll('[data-eredel]').forEach(btn => {
      btn.onclick = async () => {
        await guard(() => H.graph.removeEdge({ edgeId: btn.dataset.eredel }));
        await reload();
      };
    });
  }

  async function reload() {
    const r = await guard(() => H.graph.get());
    if (!r) return;
    const graph = r.graph || { nodes: [], edges: [] };
    const persons = r.persons || [];
    const W = 860, HT = 520;
    const old = new Map(nodes.map(n => [n.id, n]));
    nodes = (graph.nodes || []).map((n, i) => {
      const prev = old.get(n.id);
      return {
        ...n,
        x: prev ? prev.x : W / 2 + Math.cos(i * 2.4) * 180,
        y: prev ? prev.y : HT / 2 + Math.sin(i * 2.4) * 140,
        vx: 0, vy: 0,
      };
    });
    edges = graph.edges || [];
    $('#graphStale').textContent = graph.stale ? '· 有新素材，建议更新' : '';
    $('#graphStale').className = graph.stale ? 'badge inference' : 'badge blank';
    $('#graphCount').textContent = `${nodes.length} 节点 · ${edges.length} 条关系`;
    simulate(nodes.length ? 240 : 1);
    renderSvg();
    if (selected && !nodes.some(n => n.id === selected.id)) selected = null;
    showInfo();
  }

  async function viewGraph(el) {
    el.innerHTML = `
      <div class="page-head">
        <div class="page-title">关系图谱 <span class="badge" id="graphStale"></span>
          <button class="btn sm ghost" id="graphRebuild">从理解卡更新</button>
          <button class="btn sm ghost" id="graphAdd">手动添加关系</button>
        </div>
        <div class="page-desc">图谱由各对象的<b>理解卡条目</b>与档案自动推导（每条关系带证据），你手动添加的关系在更新时永远保留。TA 的生活里还有很多你看不到的人与事——图谱只画条目里有依据的部分。<span id="graphStale" class="badge"></span><span id="graphCount" class="muted small"></span></div>
      </div>
      <div class="panel hairline-top" data-glow style="padding:10px">
        <svg id="graphSvg" viewBox="0 0 900 520" style="width:100%;height:auto;display:block;touch-action:none"></svg>
      </div>
      <div class="panel" data-glow>
        <div class="panel-title">节点详情</div>
        <div id="graphInfo"><div class="muted small">加载中…</div></div>
      </div>
      <div class="panel" data-glow>
        <div class="panel-title">图例</div>
        <div class="flex" style="flex-wrap:wrap;gap:10px">
          <span class="badge fact">亲近</span><span class="badge plain">中性</span>
          <span class="badge inference">复杂</span><span class="badge" style="color:#b05a52;background:rgba(176,90,82,.08);border:1px solid rgba(176,90,82,.3)">紧张</span>
          <span class="muted small">渐变圆 = 有档案的对象 · 纸色圆 = 条目中提到的第三方 · 拖拽整理布局</span>
        </div>
      </div>
    `;
    await reload();
    $('#graphRebuild').onclick = async () => {
      const btn = $('#graphRebuild');
      btn.disabled = true;
      const r = await guard(() => H.graph.build(), '更新中…从理解卡提取人物与关系');
      btn.disabled = false;
      if (r) { toast(`图谱已更新（${r.built} 条关系来自理解卡）`, 'ok'); await reload(); }
    };
    $('#graphAdd').onclick = () => {
      modal(`<h3>手动添加关系</h3>
        <label class="field"><span>一端（名字或称呼）</span><input type="text" id="geA" maxlength="20" placeholder="如：她 / 小林 / 王阿姨"></label>
        <label class="field"><span>关系（如：闺蜜 / 父女 / 同事）</span><input type="text" id="geT" maxlength="20"></label>
        <label class="field"><span>另一端</span><input type="text" id="geB" maxlength="20" placeholder="如：TA / 她父亲"></label>
        <label class="field"><span>氛围</span><select id="geS">
          <option value="neutral">中性</option><option value="positive">亲近</option>
          <option value="negative">紧张</option><option value="complex">复杂</option>
        </select></label>
        <div class="modal-ops"><button class="btn ghost" id="geCancel">取消</button><button class="btn primary" id="geOk">添加</button></div>`);
      document.getElementById('geCancel').onclick = HB.ui.closeModal;
      document.getElementById('geOk').onclick = async () => {
        const a = document.getElementById('geA').value.trim();
        const b2 = document.getElementById('geB').value.trim();
        if (!a || !b2) return toast('两端名字都要填', 'err');
        await guard(() => H.graph.addEdge({ a, b: b2, type: document.getElementById('geT').value.trim() || '关系', stance: document.getElementById('geS').value }));
        HB.ui.closeModal();
        toast('关系已添加（手动添加的不会被自动更新覆盖）', 'ok');
        await reload();
      };
    };
  }

  HB.views = HB.views || {};
  HB.views.graph = viewGraph;
})();
