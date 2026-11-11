import { compile, plan, failureProbability, explainPath } from './core/retest.js';

window.__errs = [];
window.addEventListener('error', (e) => window.__errs.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason)));

const LS = 'flow-retest-v1';
const store = (() => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } })();
store.edits = store.edits || {};     // branchId -> {valueId: {nominal, tol}}
store.applied = store.applied || {}; // branchId -> {tests:[...], at}
const save = () => localStorage.setItem(LS, JSON.stringify(store));

const S = { model: null, C: null, err: null, branch: null, tab: 'requirements', req: null, filter: 'suspect', q: '', sort: 'status', kb: 0, P: null, pf: {} };
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const icons = () => window.lucide && window.lucide.createIcons({ attrs: { 'stroke-width': 1.75 } });
function toast(m) { const t = $('#toast'); t.innerHTML = m; t.hidden = false; icons(); clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2600); }

const STATUS = {
  'at-risk': { label: 'At risk', icon: 'triangle-alert', rank: 0 },
  fails: { label: 'Fails', icon: 'circle-x', rank: 1 },
  review: { label: 'Re-verify', icon: 'rotate-ccw', rank: 2 },
  proven: { label: 'Proven by analysis', icon: 'shield-check', rank: 3 },
  unchanged: { label: 'Value unchanged', icon: 'equal', rank: 4 },
  unaffected: { label: 'Not affected', icon: 'minus', rank: 5 }
};
const fmt = (x, unit) => {
  if (unit === '' || unit === undefined) return (Math.abs(x) < 2 ? (x * 100).toFixed(1) + '%' : x.toFixed(2));
  const d = Math.abs(x) >= 100 ? 1 : Math.abs(x) >= 10 ? 2 : 3;
  return x.toFixed(d) + (unit ? ' ' + unit : '');
};
const qUnit = (id) => (S.model.derived.find((d) => d.id === id) || S.model.values.find((v) => v.id === id) || {}).unit;
const ratioUnit = (u) => (u === '' ? '' : u);
const reqById = (id) => S.model.requirements.find((r) => r.id === id);
const testById = (id) => S.model.tests.find((t) => t.id === id);
const branch = () => S.model.branches.find((b) => b.id === S.branch);

function currentChange() {
  const base = branch().change;
  const edits = store.edits[S.branch] || {};
  const out = {};
  for (const [k, v] of Object.entries(base)) out[k] = { ...v };
  for (const [k, v] of Object.entries(edits)) out[k] = { ...(out[k] || {}), ...v };
  return out;
}
function compute() {
  S.P = plan(S.model, S.C, currentChange());
  S.pf = {};
  for (const r of S.P.reqs.filter((x) => x.status === 'at-risk')) S.pf[r.id] = failureProbability(S.model, S.C, currentChange(), reqById(r.id), 4000, 11);
}

// ---------------------------------------------------------------- routing: #/b/<branch>/<tab>?req=REQ-3&f=all
function parseHash() {
  const [path, qs] = location.hash.replace(/^#/, '').split('?');
  const p = new URLSearchParams(qs || '');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'b' && S.model.branches.some((b) => b.id === parts[1])) S.branch = parts[1];
  else S.branch = S.branch || S.model.branches[0].id;
  S.tab = ['requirements', 'tests', 'values', 'report'].includes(parts[2]) ? parts[2] : 'requirements';
  S.req = p.get('req') && reqById(p.get('req')) ? p.get('req') : null;
  S.filter = p.get('f') === 'all' ? 'all' : 'suspect';
}
function hash(over = {}) {
  const o = { branch: S.branch, tab: S.tab, req: S.req, filter: S.filter, ...over };
  const q = new URLSearchParams();
  if (o.req) q.set('req', o.req);
  if (o.filter === 'all') q.set('f', 'all');
  return `#/b/${o.branch}/${o.tab}${q.toString() ? '?' + q : ''}`;
}
const go = (over) => { const h = hash(over); if (location.hash !== h) location.hash = h; else render(); };

// ---------------------------------------------------------------- sidebar
function renderSide() {
  const sel = $('#branch');
  if (!sel.options.length) sel.innerHTML = S.model.branches.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
  sel.value = S.branch;
  const changedSys = new Set(S.P.changed.map((id) => S.model.values.find((v) => v.id === id).system));
  const count = (sid) => S.model.requirements.filter((r) => (r.systems || []).includes(sid)).length;
  const kids = (pid) => S.model.systems.filter((s) => s.parent === pid);
  const rows = [`<div class="tn sel" style="padding-left:6px"><span class="chev"><i data-lucide="chevron-down" class="ic-s"></i></span><i data-lucide="layers" class="ic-s"></i><span>All Systems</span><span class="cnt">${S.model.requirements.length}</span></div>`];
  const walk = (pid, depth) => {
    for (const s of kids(pid)) {
      const has = kids(s.id).length;
      rows.push(`<div class="tn" style="padding-left:${8 + depth * 16}px" title="${esc(s.name)}"><span class="chev">${has ? '<i data-lucide="chevron-down" class="ic-s"></i>' : ''}</span><span class="sq" style="border-color:${s.color}"></span><span>${esc(s.name)}</span>${changedSys.has(s.id) ? '<span class="dot" title="Changed on this branch"></span>' : ''}<span class="cnt">${count(s.id) || ''}</span></div>`);
      walk(s.id, depth + 1);
    }
  };
  walk(null, 0);
  $('#tree').innerHTML = rows.join('');
}

// ---------------------------------------------------------------- main
function header() {
  const b = branch(), applied = store.applied[S.branch];
  const edits = Object.keys(store.edits[S.branch] || {}).length;
  return `<div class="ph">
    <h1>Retest Plan <span class="br"><span class="chipbr"><i data-lucide="git-branch" class="ic-s"></i>${esc(b.name)}</span><i data-lucide="arrow-right" class="ic-s"></i><span class="chipbr">Common</span><span class="muted">${esc(b.title)} · ${esc(b.author)}${edits ? ` · <span class="warn">${edits} what-if edit${edits > 1 ? 's' : ''}</span>` : ''}</span></span></h1>
    <div class="bar">
      ${applied ? `<button class="btn applied" data-act="unapply"><i data-lucide="check" class="ic"></i>Plan applied · ${applied.tests.length} runs pending</button>` : `<button class="btn primary" data-act="apply" ${S.P.cover.infeasible ? 'disabled' : ''}><i data-lucide="plus" class="ic"></i>Apply plan to Test Plans<span class="split"><i data-lucide="chevron-down" class="ic-s"></i></span></button>`}
      <button class="btn soft" data-act="csv"><i data-lucide="download" class="ic"></i>Export CSV</button>
      <button class="btn" data-act="json" title="Export JSON"><i data-lucide="braces" class="ic"></i></button>
      <span class="grow"></span>
      <label class="find"><i data-lucide="search" class="ic muted"></i><input id="find" placeholder="Find in view..." value="${esc(S.q)}" aria-label="Find in view"></label>
      <button class="btn hide-md" data-act="toggle-filter" title="Show unaffected requirements"><i data-lucide="sliders-horizontal" class="ic"></i>Display</button>
      <button class="btn" data-act="sort"><i data-lucide="arrow-down-up" class="ic"></i>Sort by: ${S.sort === 'status' ? 'Status' : 'ID'}</button>
      <button class="btn hide-md" data-act="toggle-filter"><i data-lucide="filter" class="ic"></i>Filters${S.filter === 'suspect' ? ' (1)' : ''}</button>
      <button class="btn" data-act="views" title="Saved views"><i data-lucide="layout-grid" class="ic"></i>Views</button>
    </div>
    <div class="tabs" role="tablist">
      ${[['requirements', 'Requirements', 'square-check-big', S.P.reqs.filter((r) => r.suspect).length], ['tests', 'Test Cases', 'flask-conical', S.P.cover.ids ? S.P.cover.ids.length : 0], ['values', 'Design Values', 'variable', S.P.changed.length], ['report', 'Report', 'file-text', null]].map(([k, l, ic, c]) => `<a role="tab" aria-selected="${S.tab === k}" class="tab ${S.tab === k ? 'on' : ''}" href="${hash({ tab: k, req: null })}"><i data-lucide="${ic}" class="ic"></i>${l}${c !== null ? `<span class="c">${c}</span>` : ''}</a>`).join('')}
    </div>
  </div>`;
}
function cards() {
  const P = S.P, n = (s) => P.reqs.filter((r) => r.status === s).length;
  const planH = P.cover.cost || 0;
  return `<div class="cards">
    <div class="card"><div class="k"><i data-lucide="git-fork" class="ic-s"></i>Suspect by traceability</div><div class="v num">${P.graph.requirements} <small>reqs · ${P.graph.tests} tests</small></div><div class="d">${P.graph.hours} test-hours if all re-run</div></div>
    <div class="card"><div class="k"><i data-lucide="shield-check" class="ic-s" style="color:var(--green)"></i>Proven by worst-case analysis</div><div class="v num">${n('proven') + n('unchanged')}</div><div class="d">Existing evidence still holds</div></div>
    <div class="card"><div class="k"><i data-lucide="triangle-alert" class="ic-s" style="color:var(--amber)"></i>At risk or failing</div><div class="v num">${n('at-risk') + n('fails')}</div><div class="d">${n('fails')} fail even in the best case</div></div>
    <div class="card"><div class="k"><i data-lucide="rotate-ccw" class="ic-s" style="color:var(--violet)"></i>Re-verify (no numeric model)</div><div class="v num">${n('review')}</div><div class="d">On changed systems</div></div>
    <div class="card hl"><div class="k"><i data-lucide="list-restart" class="ic-s" style="color:var(--primary)"></i>Minimum retest plan</div><div class="v num">${P.cover.ids ? P.cover.ids.length : 0} <small>tests · ${planH} h</small></div><div class="d"><span class="save">${Math.round(P.saving * 100)}% fewer test-hours</span></div></div>
  </div>`;
}
function rangeBar(r, req, w = 150) {
  // before (gray) and after (colored) worst-case ranges vs the limit
  const lo = Math.min(r.before[0], r.after[0], req.limit), hi = Math.max(r.before[1], r.after[1], req.limit);
  const pad = (hi - lo) * 0.08 || 1, L = lo - pad, H = hi + pad, x = (v) => ((v - L) / (H - L)) * w;
  const col = r.status === 'proven' ? '#138661' : r.status === 'fails' ? '#c8331f' : r.status === 'at-risk' ? '#d98a00' : '#9a9aa4';
  return `<svg class="mbar" width="${w}" height="18" viewBox="0 0 ${w} 18" aria-hidden="true"><rect x="${x(r.before[0])}" y="2" width="${Math.max(2, x(r.before[1]) - x(r.before[0]))}" height="5" rx="2" fill="#d6d5dc"/><rect x="${x(r.after[0])}" y="10" width="${Math.max(2, x(r.after[1]) - x(r.after[0]))}" height="6" rx="2" fill="${col}" opacity=".85"/><line x1="${x(req.limit)}" x2="${x(req.limit)}" y1="0" y2="18" stroke="#1b1b1f" stroke-width="1.5" stroke-dasharray="2 2"/></svg>`;
}
function statement(req) {
  return esc(req.statement).replace(/\{([^}]+)\}/g, '<span class="vchip">$1</span>');
}
function visibleReqs() {
  let rows = S.P.reqs.map((r) => ({ r, req: reqById(r.id) }));
  if (S.filter === 'suspect') rows = rows.filter((x) => x.r.suspect);
  if (S.q) { const q = S.q.toLowerCase(); rows = rows.filter((x) => (x.req.id + ' ' + x.req.name + ' ' + x.req.statement).toLowerCase().includes(q)); }
  const idn = (id) => +id.split('-')[1];
  rows.sort((a, b) => (S.sort === 'status' ? STATUS[a.r.status].rank - STATUS[b.r.status].rank : 0) || idn(a.r.id) - idn(b.r.id));
  return rows;
}
function renderReqs() {
  const rows = visibleReqs();
  const inPlan = new Set(S.P.cover.ids || []);
  if (!rows.length) return `<div class="tw"><div class="empty"><i data-lucide="search-x" class="ic"></i><div style="margin-top:8px">${S.q ? `No requirements match "${esc(S.q)}".` : 'Nothing on this branch touches a requirement.'}</div><button class="btn" style="margin-top:12px" data-act="clear">Clear filters</button></div></div>`;
  return `<div class="tw"><table class="t" aria-label="Requirements impacted by this branch"><colgroup><col style="width:34px"><col style="width:66px"><col style="width:15%"><col><col style="width:168px"><col style="width:156px"><col style="width:66px"><col style="width:17%"></colgroup>
  <thead><tr><th><span class="cb"></span></th>${['ID', 'Name', 'Statement', 'Worst case on branch', 'Status', 'P(fail)', 'Re-verified by'].map((h) => `<th><span class="thx">${h}<i data-lucide="ellipsis-vertical" class="ic-s kebab"></i></span></th>`).join('')}</tr></thead><tbody>
  ${rows.map(({ r, req }, i) => {
    const u = req.quantity ? qUnit(req.quantity) : null;
    const wc = r.after ? `<div class="iv num">${fmt(r.after[0], u)} – ${fmt(r.after[1], u)}</div>${rangeBar(r, req)}` : '<span class="muted">No numeric model</span>';
    const pf = S.pf[r.id] ? `<span class="num" title="95% CI ${(S.pf[r.id].ci[0] * 100).toFixed(2)}-${(S.pf[r.id].ci[1] * 100).toFixed(2)}%">${S.pf[r.id].p < 0.001 ? '&lt;0.1%' : (S.pf[r.id].p * 100).toFixed(1) + '%'}</span>` : r.status === 'fails' ? '<span class="neg">≈100%</span>' : r.status === 'proven' || r.status === 'unchanged' ? '<span class="pos num">0%</span>' : '<span class="muted">–</span>';
    const tests = S.model.tests.filter((t) => t.verifies.includes(r.id));
    const needs = r.status === 'at-risk' || r.status === 'review';
    const chips = needs ? tests.filter((t) => inPlan.has(t.id)).map((t) => `<span class="tchip in">${t.id} <b>${esc(t.name)}</b></span>`).join('') : r.status === 'fails' ? '<span class="neg">Redesign before testing</span>' : r.status === 'proven' ? '<span class="muted">Analysis (worst case)</span>' : r.status === 'unchanged' ? '<span class="muted">Existing evidence</span>' : '<span class="muted">–</span>';
    return `<tr data-req="${r.id}" class="${S.req === r.id ? 'sel' : ''} ${i === S.kb ? 'kb' : ''}"><td><span class="cb"></span></td><td class="id">${r.id}</td><td>${esc(req.name)}</td><td class="stmt">${statement(req)}</td><td>${wc}</td><td><span class="st ${r.status}"><i data-lucide="${STATUS[r.status].icon}" class="ic-s"></i>${STATUS[r.status].label}</span></td><td>${pf}</td><td>${chips}</td></tr>`;
  }).join('')}</tbody></table></div>
  <div class="toggle" style="margin-top:10px" data-act="toggle-filter"><span class="cb" style="${S.filter === 'all' ? 'background:var(--primary);border-color:var(--primary)' : ''}"></span>Show requirements not affected by this branch (${S.P.reqs.filter((r) => !r.suspect).length})</div>`;
}
function donut(planH, graphH) {
  const f = graphH ? planH / graphH : 0, R = 46, Cc = 2 * Math.PI * R;
  return `<svg width="120" height="120" viewBox="0 0 120 120" role="img" aria-label="${planH} of ${graphH} test-hours"><circle cx="60" cy="60" r="${R}" fill="none" stroke="#e7f8f0" stroke-width="10"/><circle cx="60" cy="60" r="${R}" fill="none" stroke="#4219e8" stroke-width="10" stroke-dasharray="${(f * Cc).toFixed(1)} ${Cc.toFixed(1)}" transform="rotate(-90 60 60)" stroke-linecap="round"/><text x="60" y="58" text-anchor="middle" font-size="22" font-weight="600" font-family="Inter" fill="#1b1b1f">${planH}h</text><text x="60" y="76" text-anchor="middle" font-size="11" font-family="Inter" fill="#6b6b76">of ${graphH}h</text></svg>`;
}
function renderTests() {
  const P = S.P, inPlan = new Set(P.cover.ids || []), graph = new Set(P.graphTests.map((t) => t.id));
  const applied = store.applied[S.branch];
  const list = S.model.tests.filter((t) => graph.has(t.id) || inPlan.has(t.id) || S.filter === 'all');
  return `<div class="donut" style="margin-bottom:14px">${donut(P.cover.cost || 0, P.graph.hours)}<div class="legend"><div><i style="border-color:#4219e8;background:#4219e8"></i>Retest plan: ${(P.cover.ids || []).length} tests, ${P.cover.cost || 0} h</div><div><i style="border-color:#8fdcbc"></i>Skipped (proven by analysis or not needed): ${P.graph.tests - (P.cover.ids || []).length} tests, ${P.graph.hours - (P.cover.cost || 0)} h</div><div class="muted" style="font-size:12px;max-width:520px;margin-top:4px">Exact minimum-cost set cover over the requirements that still need evidence (branch and bound, ${P.cover.nodes || 0} nodes). Every at-risk and re-verify requirement keeps at least one test.</div></div></div>
  <div class="tw"><table class="t" aria-label="Test cases"><colgroup><col style="width:34px"><col style="width:72px"><col style="width:26%"><col style="width:92px"><col style="width:64px"><col><col style="width:150px"></colgroup>
  <thead><tr><th><span class="cb"></span></th><th>ID</th><th>Name</th><th>Test Plan</th><th>Hours</th><th>Verifies</th><th>Retest decision</th></tr></thead><tbody>
  ${list.map((t) => {
    const why = t.verifies.map((id) => { const r = P.byId[id]; return `<span class="tchip ${r && (r.status === 'at-risk' || r.status === 'review') ? 'in' : ''}" title="${esc(reqById(id).name)}">${id} <b>${esc(STATUS[r.status].label)}</b></span>`; }).join('');
    const needsAny = t.verifies.some((id) => P.need.includes(id));
    const dec = inPlan.has(t.id) ? (applied && applied.tests.includes(t.id) ? '<span class="st pending"><i data-lucide="clock" class="ic-s"></i>Run pending</span>' : '<span class="st review"><i data-lucide="list-restart" class="ic-s"></i>Re-run</span>') : needsAny ? '<span class="st unchanged" title="Its requirements are re-verified by a cheaper test in the plan"><i data-lucide="check" class="ic-s"></i>Skip · covered</span>' : graph.has(t.id) ? '<span class="st proven" title="Every requirement it verifies is proven by worst-case analysis or unchanged"><i data-lucide="check" class="ic-s"></i>Skip · proven</span>' : '<span class="muted">Not suspect</span>';
    return `<tr><td><span class="cb"></span></td><td class="id">${t.id}</td><td>${esc(t.name)}</td><td class="muted">${esc(t.plan)}</td><td class="num">${t.hours}</td><td>${why}</td><td>${dec}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}
function renderValues() {
  const ch = currentChange(), edits = store.edits[S.branch] || {};
  const changed = new Set(Object.keys(ch));
  const vals = S.model.values.filter((v) => changed.has(v.id) || S.filter === 'all' || v.tolKind === 'pct' && v.tol > 0 && S.model.values.indexOf(v) < 0);
  const all = S.filter === 'all' ? S.model.values : S.model.values.filter((v) => changed.has(v.id));
  return `<div class="bar" style="margin-bottom:10px"><span class="muted">Edit a value or its tolerance to run a what-if on this branch. Everything recomputes instantly.</span><span class="grow"></span>${Object.keys(edits).length ? '<button class="btn" data-act="reset-edits"><i data-lucide="undo-2" class="ic"></i>Reset what-if edits</button>' : ''}<button class="btn" data-act="toggle-filter">${S.filter === 'all' ? 'Show changed only' : `Show all ${S.model.values.length} values`}</button></div>
  <div class="tw"><table class="t" aria-label="Design values"><colgroup><col style="width:34%"><col style="width:120px"><col style="width:120px"><col style="width:130px"><col style="width:110px"><col></colgroup>
  <thead><tr><th>Name</th><th>System</th><th>Common</th><th>This branch</th><th>Tolerance</th><th>Source</th></tr></thead><tbody>
  ${all.map((v) => {
    const c = ch[v.id] || {}, sys = S.model.systems.find((s) => s.id === v.system);
    const nom = c.nominal ?? v.nominal, tol = c.tol ?? v.tol, isCh = c.nominal !== undefined && c.nominal !== v.nominal;
    return `<tr><td>${esc(v.name)} <span class="muted">(${v.id})</span></td><td><span class="tchip"><span class="sq" style="display:inline-block;width:9px;height:9px;border:1.5px solid ${sys.color};border-radius:2px"></span>${esc(sys.name)}</span></td><td class="num muted">${v.nominal} ${esc(v.unit)}</td>
      <td><input class="inp num ${isCh ? 'ch' : ''}" data-edit="${v.id}" data-field="nominal" value="${nom}" aria-label="${esc(v.name)} on branch"> <span class="muted">${esc(v.unit)}</span></td>
      <td><input class="inp num" style="width:64px" data-edit="${v.id}" data-field="tol" value="${tol}" aria-label="${esc(v.name)} tolerance"> <span class="muted">${v.tolKind === 'pct' ? '%' : esc(v.unit)}</span></td><td class="muted" style="font-size:12.5px">${esc(v.source || '')}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}
function renderReport() {
  const P = S.P, b = branch();
  const line = (s) => P.reqs.filter((r) => r.status === s).map((r) => `${r.id} ${esc(reqById(r.id).name)}`).join('; ') || 'none';
  return `<div class="report"><h3>Merge readiness: ${esc(b.name)} → Common</h3>
  <p>${esc(b.title)}. Changed design values: ${P.changed.map((id) => `<span class="vchip">${id}</span>`).join(' ')}.</p>
  <p>Traceability marks <b>${P.graph.requirements}</b> requirements and <b>${P.graph.tests}</b> test cases suspect (${P.graph.hours} test-hours). Worst-case interval analysis over every design-value tolerance proves <b>${P.reqs.filter((r) => r.status === 'proven').length}</b> of them still met, so their existing evidence stands.</p>
  <h3>Needs new evidence</h3><p>At risk: ${line('at-risk')}.<br>Re-verify (no numeric model): ${line('review')}.<br>Fails in every case: ${line('fails')}.</p>
  <h3>Retest plan</h3><p>${(P.cover.ids || []).map((id) => `${id} ${esc(testById(id).name)} (${testById(id).hours} h)`).join('<br>') || 'No tests needed.'}<br><b>${P.cover.cost || 0} test-hours</b> instead of ${P.graph.hours} (${Math.round(P.saving * 100)}% fewer), the minimum over all test combinations that re-verify every requirement above.</p>
  <h3>Proven by analysis</h3><p>${line('proven')}.</p></div>`;
}
function renderDrawer() {
  if (!S.req) return '';
  const r = S.P.byId[S.req], req = reqById(S.req);
  const u = req.quantity ? qUnit(req.quantity) : null;
  const path = req.quantity ? explainPath(S.C, S.P.changed, req.quantity) : null;
  const tests = S.model.tests.filter((t) => t.verifies.includes(req.id));
  const inPlan = new Set(S.P.cover.ids || []);
  const pf = S.pf[req.id];
  const sysNames = (req.systems || []).map((s) => S.model.systems.find((x) => x.id === s).name).join(', ');
  return `<aside class="drawer" aria-label="${esc(req.id)} details">
    <div class="dh"><span>Requirements</span><i data-lucide="chevron-right" class="ic-s"></i><span>${esc(req.id)}</span><span class="grow"></span><button class="btn" data-act="close" aria-label="Close (Esc)"><i data-lucide="x" class="ic"></i></button></div>
    <div class="db"><h2>${esc(req.name)}</h2><p class="stmt">${statement(req)}</p>
    <div class="fields">
      <span class="k">Status on branch</span><span><span class="st ${r.status}"><i data-lucide="${STATUS[r.status].icon}" class="ic-s"></i>${STATUS[r.status].label}</span></span>
      <span class="k">Stage</span><span><span class="stage">${req.stage}</span></span>
      <span class="k">Systems</span><span>${esc(sysNames)}</span>
      ${req.quantity ? `<span class="k">Quantity</span><span>${esc(S.model.derived.find((d) => d.id === req.quantity)?.name || req.quantity)}</span>
      <span class="k">Limit</span><span><span class="vchip">${req.op === '<=' ? '≤' : '≥'} ${fmt(req.limit, u)}</span>${req.source ? ` <span class="muted">${esc(req.source)}</span>` : ''}</span>
      <span class="k">Common (nominal)</span><span class="num">${fmt(r.nomBefore ?? 0, u)} <span class="muted">worst ${fmt(req.op === '<=' ? (r.before || [0, 0])[1] : (r.before || [0, 0])[0], u)}</span></span>
      <span class="k">Branch (nominal)</span><span class="num">${r.nomAfter !== undefined ? fmt(r.nomAfter, u) : '–'} <span class="muted">worst ${r.after ? fmt(req.op === '<=' ? r.after[1] : r.after[0], u) : '–'}</span></span>
      <span class="k">Worst-case margin</span><span class="num ${r.worstMargin >= 0 ? 'pos' : 'neg'}">${r.worstMargin !== undefined ? (r.worstMargin * 100).toFixed(1) + '%' : '–'}</span>
      ${pf ? `<span class="k">P(fail)</span><span class="num">${(pf.p * 100).toFixed(2)}% <span class="muted">95% CI ${(pf.ci[0] * 100).toFixed(2)}–${(pf.ci[1] * 100).toFixed(2)}%, ${pf.n.toLocaleString()} draws, tolerances as 3σ</span></span>` : ''}` : `<span class="k">Verification</span><span>Qualitative; any change to its system needs new evidence.</span>`}
    </div>
    ${r.after ? `<div class="sect">Common vs branch, worst-case range against the limit</div>${rangeBar(r, req, 420)}<div class="muted" style="font-size:12px;margin-top:2px">Gray: Common · colored: branch · dashed: limit. Ranges are sound interval bounds over every input tolerance.</div>` : ''}
    ${path ? `<div class="sect">Why it is suspect</div><div class="path">${path.map((id, i) => `<span class="p ${i === 0 ? 'ch' : ''}">${esc(id)}</span>${i < path.length - 1 ? '<i data-lucide="arrow-right" class="ic-s muted"></i>' : ''}`).join('')}</div>` : r.suspect ? `<div class="sect">Why it is suspect</div><div class="muted">It traces to a system changed on this branch.</div>` : ''}
    <div class="sect">Verified by</div>${tests.map((t) => `<div class="bar" style="padding:5px 0;border-bottom:1px solid var(--line2)"><span class="id muted" style="width:56px">${t.id}</span><span class="grow">${esc(t.name)}</span><span class="muted num">${t.hours} h</span>${inPlan.has(t.id) ? '<span class="st review">In plan</span>' : '<span class="st unaffected">Not run</span>'}</div>`).join('') || '<div class="muted">No linked tests</div>'}
    </div></aside>`;
}
function render() {
  const m = $('#main');
  if (S.err) { m.innerHTML = `<div class="state"><i data-lucide="cloud-off" class="ic"></i><h3>Couldn't load the project</h3><div>${esc(S.err)}</div><button class="btn" style="margin-top:12px" data-act="reload">Retry</button></div>`; icons(); return; }
  if (!S.model) { m.innerHTML = `<div class="ph"><div class="skel" style="height:24px;width:260px"></div><div class="skel" style="height:33px;margin-top:16px"></div></div><div class="body"><div class="cards">${'<div class="skel" style="height:78px"></div>'.repeat(5)}</div>${'<div class="skel" style="height:40px;margin-bottom:6px"></div>'.repeat(8)}</div>`; return; }
  parseHash();
  compute();
  renderSide();
  const body = S.tab === 'tests' ? renderTests() : S.tab === 'values' ? renderValues() : S.tab === 'report' ? renderReport() : renderReqs();
  m.innerHTML = header() + `<div class="body">${cards()}${body}</div>` + renderDrawer();
  icons();
  document.title = `Retest Plan · ${S.branch} | Flow`;
}

// ---------------------------------------------------------------- export
function exportData(kind) {
  const P = S.P;
  const rows = P.reqs.filter((r) => r.suspect).map((r) => {
    const req = reqById(r.id);
    return { id: r.id, name: req.name, status: r.status, quantity: req.quantity || '', limit: req.limit ?? '', branch_worst_lo: r.after ? +r.after[0].toPrecision(6) : '', branch_worst_hi: r.after ? +r.after[1].toPrecision(6) : '', p_fail: S.pf[r.id] ? +S.pf[r.id].p.toFixed(5) : '', retest_with: S.model.tests.filter((t) => t.verifies.includes(r.id) && (P.cover.ids || []).includes(t.id)).map((t) => t.id).join(' ') };
  });
  let blob, name = `retest-plan-${S.branch}.${kind}`;
  if (kind === 'json') blob = new Blob([JSON.stringify({ branch: S.branch, change: currentChange(), graph: P.graph, plan: { tests: P.cover.ids, hours: P.cover.cost }, saving: P.saving, requirements: rows }, null, 1)], { type: 'application/json' });
  else { const cols = Object.keys(rows[0]); blob = new Blob([[cols.join(','), ...rows.map((r) => cols.map((c) => JSON.stringify(r[c] ?? '')).join(','))].join('\n')], { type: 'text/csv' }); }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`<i data-lucide="check" class="ic-s"></i>Exported ${rows.length} requirements`);
}

// ---------------------------------------------------------------- events
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act],[data-req],[data-noop]');
  if (!el) return;
  if (el.dataset.noop !== undefined) { e.preventDefault(); toast('Only Retest Plan is part of this concept demo'); return; }
  if (el.dataset.req) { S.kb = [...document.querySelectorAll('.t tbody tr')].indexOf(el); return go({ req: el.dataset.req }); }
  const a = el.dataset.act;
  if (a === 'close') return go({ req: null });
  if (a === 'csv' || a === 'json') return exportData(a);
  if (a === 'toggle-filter') return go({ filter: S.filter === 'all' ? 'suspect' : 'all' });
  if (a === 'sort') { S.sort = S.sort === 'status' ? 'id' : 'status'; return render(); }
  if (a === 'clear') { S.q = ''; return go({ filter: 'all' }); }
  if (a === 'apply') { store.applied[S.branch] = { tests: [...S.P.cover.ids], at: Date.now() }; save(); toast(`<i data-lucide="check" class="ic-s"></i>Created ${S.P.cover.ids.length} pending test runs on ${esc(S.branch)}`); return render(); }
  if (a === 'unapply') { delete store.applied[S.branch]; save(); toast('Removed pending runs'); return render(); }
  if (a === 'reset-edits') { delete store.edits[S.branch]; delete store.applied[S.branch]; save(); return render(); }
  if (a === 'reload') { S.err = null; return load(); }
  if (a === 'views') { toast('Saved views: Default (suspect only), All requirements. Use Filters to switch.'); return; }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'branch') return go({ branch: e.target.value, req: null });
  const inp = e.target.closest('[data-edit]');
  if (!inp) return;
  const v = S.model.values.find((x) => x.id === inp.dataset.edit), f = inp.dataset.field, val = parseFloat(inp.value);
  if (!isFinite(val) || (f === 'tol' && val < 0)) { inp.value = f === 'tol' ? v.tol : v.nominal; toast('Enter a valid number'); return; }
  const ed = (store.edits[S.branch] = store.edits[S.branch] || {});
  ed[v.id] = { ...(ed[v.id] || {}), [f]: val };
  const base = branch().change[v.id] || {};
  if ((ed[v.id].nominal === undefined || ed[v.id].nominal === (base.nominal ?? v.nominal)) && (ed[v.id].tol === undefined || ed[v.id].tol === (base.tol ?? v.tol))) delete ed[v.id];
  delete store.applied[S.branch];
  save();
  try { render(); } catch (err) { delete ed[v.id]; save(); render(); toast('That value makes a formula undefined (e.g. divides by zero); reverted'); }
});
document.addEventListener('input', (e) => { if (e.target.id === 'find') { S.q = e.target.value; const pos = e.target.selectionStart; render(); const f = $('#find'); f.focus(); f.setSelectionRange(pos, pos); } });
document.addEventListener('keydown', (e) => {
  if (!S.model) return;
  const typing = e.target instanceof Element && e.target.matches('input, select');
  if (e.key === '/' && !typing) { e.preventDefault(); $('#find')?.focus(); return; }
  if (typing) { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.key === 'Escape' && S.req) return go({ req: null });
  if (e.key === 'e') return exportData('csv');
  if (S.tab === 'requirements') {
    const rows = [...document.querySelectorAll('.t tbody tr')];
    if (!rows.length) return;
    if (e.key === 'j' || e.key === 'ArrowDown') { S.kb = Math.min(rows.length - 1, S.kb + 1); e.preventDefault(); }
    else if (e.key === 'k' || e.key === 'ArrowUp') { S.kb = Math.max(0, S.kb - 1); e.preventDefault(); }
    else if (e.key === 'Enter') return go({ req: rows[S.kb].dataset.req });
    else return;
    rows.forEach((r, i) => r.classList.toggle('kb', i === S.kb));
    rows[S.kb].scrollIntoView({ block: 'nearest' });
    if (S.req) go({ req: rows[S.kb].dataset.req });
  }
});
window.addEventListener('hashchange', render);

async function load() {
  render();
  try {
    const r = await fetch('data/model.json');
    if (!r.ok) throw new Error(`HTTP ${r.status} loading data/model.json`);
    S.model = await r.json();
    S.C = compile(S.model);
  } catch (e) { S.err = e.message || String(e); }
  render();
}
window.addEventListener('DOMContentLoaded', load);
