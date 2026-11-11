// Retest Plan: margin-aware change impact and minimum-cost re-verification for a requirements graph.
// Isomorphic ES module (browser + node). No dependencies.
//
// 1. Expressions over design values are evaluated with interval arithmetic, so every derived value gets a sound
//    worst-case range from the tolerances of its inputs (sampling can never leave the range).
// 2. A requirement downstream of a change is: Proven (worst case still meets its limit), Fails (best case misses),
//    or At risk (range straddles the limit). Non-numeric requirements on a changed system stay Needs re-verification.
// 3. The cheapest set of test cases that re-verifies every At-risk / Needs-re-verification requirement is found
//    exactly by branch and bound on weighted set cover (checked against brute force in the tests).

// ------------------------------------------------------------------ intervals
export const I = {
  make: (lo, hi) => [Math.min(lo, hi), Math.max(lo, hi)],
  add: (a, b) => [a[0] + b[0], a[1] + b[1]],
  sub: (a, b) => [a[0] - b[1], a[1] - b[0]],
  mul: (a, b) => { const p = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]]; return [Math.min(...p), Math.max(...p)]; },
  div: (a, b) => {
    if (b[0] <= 0 && b[1] >= 0) throw new Error('interval division by a range containing 0');
    return I.mul(a, [1 / b[1], 1 / b[0]]);
  },
  min: (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1])],
  max: (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1])],
  sqrt: (a) => { if (a[0] < 0) throw new Error('sqrt of negative interval'); return [Math.sqrt(a[0]), Math.sqrt(a[1])]; },
  sq: (a) => (a[0] >= 0 ? [a[0] * a[0], a[1] * a[1]] : a[1] <= 0 ? [a[1] * a[1], a[0] * a[0]] : [0, Math.max(a[0] * a[0], a[1] * a[1])]),
  width: (a) => a[1] - a[0]
};

// ------------------------------------------------------------------ expressions
// AST: {v:'id'} variable, {n:3.2} number, {op:'+'|'-'|'*'|'/'|'min'|'max', a, b}, {op:'sum', args:[...]}, {op:'sqrt'|'sq', a}
const OPS = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', min: 'min', max: 'max' };

/** Tiny recursive-descent parser for formulas like "cells * cap_ah * 3.6" or "sum(a, b, c)" or "sqrt(k / m)". */
export function parse(src) {
  const toks = src.match(/\s*([A-Za-z_][A-Za-z0-9_]*|\d*\.?\d+(?:e[-+]?\d+)?|[-+*/(),])/g).map((t) => t.trim());
  let i = 0;
  const peek = () => toks[i], next = () => toks[i++];
  function expr() { let a = term(); while (peek() === '+' || peek() === '-') { const o = next(); a = { op: o, a, b: term() }; } return a; }
  function term() { let a = unary(); while (peek() === '*' || peek() === '/') { const o = next(); a = { op: o, a, b: unary() }; } return a; }
  function unary() { if (peek() === '-') { next(); return { op: '-', a: { n: 0 }, b: unary() }; } return atom(); }
  function atom() {
    const t = next();
    if (t === '(') { const e = expr(); if (next() !== ')') throw new Error('expected )'); return e; }
    if (/^\d|^\./.test(t)) return { n: parseFloat(t) };
    if (peek() === '(') {
      next();
      const args = [];
      if (peek() !== ')') { args.push(expr()); while (peek() === ',') { next(); args.push(expr()); } }
      if (next() !== ')') throw new Error('expected ) after args');
      if (t === 'sum') return { op: 'sum', args };
      if (t === 'min' || t === 'max') return args.reduce((a, b) => ({ op: t, a, b }));
      if (t === 'sqrt' || t === 'sq') return { op: t, a: args[0] };
      throw new Error('unknown function ' + t);
    }
    return { v: t };
  }
  const e = expr();
  if (i !== toks.length) throw new Error('trailing tokens in ' + src);
  return e;
}

export function vars(ast, out = new Set()) {
  if (ast.v) out.add(ast.v);
  if (ast.a) vars(ast.a, out);
  if (ast.b) vars(ast.b, out);
  if (ast.args) ast.args.forEach((x) => vars(x, out));
  return out;
}

export function evalPoint(ast, env) {
  if (ast.v !== undefined) { if (!(ast.v in env)) throw new Error('unknown ' + ast.v); return env[ast.v]; }
  if (ast.n !== undefined) return ast.n;
  if (ast.op === 'sum') return ast.args.reduce((s, x) => s + evalPoint(x, env), 0);
  if (ast.op === 'sqrt') return Math.sqrt(evalPoint(ast.a, env));
  if (ast.op === 'sq') { const x = evalPoint(ast.a, env); return x * x; }
  const a = evalPoint(ast.a, env), b = evalPoint(ast.b, env);
  return ast.op === '+' ? a + b : ast.op === '-' ? a - b : ast.op === '*' ? a * b : ast.op === '/' ? a / b : ast.op === 'min' ? Math.min(a, b) : Math.max(a, b);
}

export function evalInterval(ast, env) {
  if (ast.v !== undefined) return env[ast.v];
  if (ast.n !== undefined) return [ast.n, ast.n];
  if (ast.op === 'sum') return ast.args.reduce((s, x) => I.add(s, evalInterval(x, env)), [0, 0]);
  if (ast.op === 'sqrt') return I.sqrt(evalInterval(ast.a, env));
  if (ast.op === 'sq') return I.sq(evalInterval(ast.a, env));
  return I[OPS[ast.op]](evalInterval(ast.a, env), evalInterval(ast.b, env));
}

// ------------------------------------------------------------------ model
/**
 * model = { values: [{id, name, unit, nominal, tol, tolKind:'abs'|'pct', system}], derived: [{id, name, unit, formula, system}],
 *           requirements: [{id, name, statement, quantity?, op?: '<='|'>=', limit?, systems: [], kind: 'numeric'|'qualitative'}],
 *           tests: [{id, name, hours, verifies: [reqId]}] }
 * change = { [valueId]: {nominal?, tol?} }
 */
export function compile(model) {
  const asts = {}, deps = {};
  for (const d of model.derived) { asts[d.id] = parse(d.formula); deps[d.id] = [...vars(asts[d.id])]; }
  // topological order of derived values
  const order = [], seen = new Set(), temp = new Set();
  const visit = (id) => {
    if (seen.has(id) || !asts[id]) return;
    if (temp.has(id)) throw new Error('cycle at ' + id);
    temp.add(id); deps[id].forEach(visit); temp.delete(id); seen.add(id); order.push(id);
  };
  model.derived.forEach((d) => visit(d.id));
  return { asts, deps, order };
}

function leafInterval(v, ch) {
  const nominal = ch && ch.nominal !== undefined ? ch.nominal : v.nominal;
  const tol = ch && ch.tol !== undefined ? ch.tol : v.tol;
  const t = v.tolKind === 'pct' ? Math.abs(nominal) * tol / 100 : tol;
  return [nominal - t, nominal + t];
}

/** Nominal values and worst-case intervals for every value under a change set. */
export function evaluate(model, compiled, change = {}) {
  const nom = {}, iv = {};
  for (const v of model.values) {
    const ch = change[v.id];
    nom[v.id] = ch && ch.nominal !== undefined ? ch.nominal : v.nominal;
    iv[v.id] = leafInterval(v, ch);
  }
  for (const id of compiled.order) { nom[id] = evalPoint(compiled.asts[id], nom); iv[id] = evalInterval(compiled.asts[id], iv); }
  return { nom, iv };
}

/** Everything that depends (transitively) on any of the given value ids. */
export function downstream(model, compiled, ids) {
  const rev = {};
  for (const [d, ds] of Object.entries(compiled.deps)) for (const x of ds) (rev[x] = rev[x] || []).push(d);
  const out = new Set(ids), stack = [...ids];
  while (stack.length) { const x = stack.pop(); for (const y of rev[x] || []) if (!out.has(y)) { out.add(y); stack.push(y); } }
  return out;
}

function meets(op, x, limit) { return op === '<=' ? x <= limit : x >= limit; }
/** Margin as a fraction of the limit (positive = inside), for a point value. */
export function margin(op, x, limit) { return op === '<=' ? (limit - x) / Math.abs(limit) : (x - limit) / Math.abs(limit); }

/**
 * Classifies every requirement for a change set.
 *  graph: what plain suspect propagation flags (numeric requirement downstream of a changed value, or any requirement
 *         on a system that owns a changed value), plus the tests linked to those requirements.
 *  status per requirement: 'unaffected' | 'unchanged' (on a changed system, value independent of the change) | 'proven' |
 *  'at-risk' | 'fails' | 'review' (qualitative, needs re-verification)
 */
export function classify(model, compiled, change) {
  const changed = Object.keys(change).filter((k) => {
    const v = model.values.find((x) => x.id === k); const c = change[k];
    return v && ((c.nominal !== undefined && c.nominal !== v.nominal) || (c.tol !== undefined && c.tol !== v.tol));
  });
  const before = evaluate(model, compiled, {});
  const after = evaluate(model, compiled, change);
  const down = downstream(model, compiled, changed);
  const changedSystems = new Set(changed.map((id) => model.values.find((v) => v.id === id).system));
  const reqs = model.requirements.map((r) => {
    const onSystem = (r.systems || []).some((s) => changedSystems.has(s));
    if (r.kind === 'numeric') {
      const suspect = down.has(r.quantity) || onSystem;
      if (!suspect) return { id: r.id, suspect, status: 'unaffected' };
      const [lo, hi] = after.iv[r.quantity];
      const worst = r.op === '<=' ? hi : lo, best = r.op === '<=' ? lo : hi;
      // on a changed system but its value does not depend on the change: existing evidence still applies
      const status = !down.has(r.quantity) ? 'unchanged' : meets(r.op, worst, r.limit) ? 'proven' : !meets(r.op, best, r.limit) ? 'fails' : 'at-risk';
      return {
        id: r.id, suspect, status, before: before.iv[r.quantity], after: after.iv[r.quantity],
        nomBefore: before.nom[r.quantity], nomAfter: after.nom[r.quantity],
        marginBefore: margin(r.op, before.nom[r.quantity], r.limit), marginAfter: margin(r.op, after.nom[r.quantity], r.limit),
        worstMargin: margin(r.op, worst, r.limit)
      };
    }
    return { id: r.id, suspect: onSystem, status: onSystem ? 'review' : 'unaffected' };
  });
  const suspectReqs = new Set(reqs.filter((r) => r.suspect).map((r) => r.id));
  const graphTests = model.tests.filter((t) => t.verifies.some((id) => suspectReqs.has(id)));
  return { changed, before, after, down, reqs, byId: Object.fromEntries(reqs.map((r) => [r.id, r])), graphTests };
}

// ------------------------------------------------------------------ minimum-cost cover
/**
 * Exact weighted set cover by branch and bound. universe: array of element ids; sets: [{id, cost, covers:[elem]}].
 * Returns {ids, cost, optimal:true, nodes} or {infeasible:[elems]} if some element has no covering set.
 */
export function minCostCover(universe, sets) {
  const U = [...new Set(universe)];
  const idx = new Map(U.map((e, i) => [e, i]));
  const S = sets.map((s) => ({ id: s.id, cost: s.cost, mask: s.covers.filter((e) => idx.has(e)).map((e) => idx.get(e)) })).filter((s) => s.mask.length);
  const coverers = U.map((_, i) => S.filter((s) => s.mask.includes(i)));
  const infeasible = U.filter((_, i) => !coverers[i].length);
  if (infeasible.length) return { infeasible };
  const n = U.length;
  // greedy upper bound
  let best = Infinity, bestSet = null;
  {
    const cov = new Array(n).fill(false); let left = n, cost = 0; const pick = [];
    while (left) {
      let bs = null, br = Infinity;
      for (const s of S) { const gain = s.mask.filter((i) => !cov[i]).length; if (gain && s.cost / gain < br) { br = s.cost / gain; bs = s; } }
      pick.push(bs); cost += bs.cost; for (const i of bs.mask) if (!cov[i]) { cov[i] = true; left--; }
    }
    best = cost; bestSet = pick;
  }
  const minCost = coverers.map((cs) => Math.min(...cs.map((s) => s.cost)));
  let nodes = 0;
  const cov = new Array(n).fill(0);
  const chosen = [];
  function lowerBound() {
    // disjoint packing: greedily take uncovered elements whose coverers don't overlap; sum of their min costs is a valid bound
    let lb = 0; const used = new Set();
    const els = [];
    for (let i = 0; i < n; i++) if (!cov[i]) els.push(i);
    els.sort((a, b) => minCost[b] - minCost[a]);
    for (const i of els) {
      if (coverers[i].some((s) => used.has(s))) continue;
      coverers[i].forEach((s) => used.add(s));
      lb += minCost[i];
    }
    return lb;
  }
  function dfs(cost) {
    nodes++;
    let pick = -1, fewest = Infinity;
    for (let i = 0; i < n; i++) if (!cov[i] && coverers[i].length < fewest) { fewest = coverers[i].length; pick = i; }
    if (pick < 0) { if (cost < best - 1e-9) { best = cost; bestSet = [...chosen]; } return; }
    if (cost + lowerBound() >= best - 1e-9) return;
    const opts = [...coverers[pick]].sort((a, b) => a.cost / a.mask.length - b.cost / b.mask.length);
    for (const s of opts) {
      if (chosen.includes(s)) continue;
      chosen.push(s); for (const i of s.mask) cov[i]++;
      dfs(cost + s.cost);
      for (const i of s.mask) cov[i]--; chosen.pop();
    }
  }
  dfs(0);
  return { ids: bestSet.map((s) => s.id).sort(), cost: best, optimal: true, nodes };
}

/** Full retest plan for a change: classification + exact min-cost tests + graph baseline. */
export function plan(model, compiled, change) {
  const c = classify(model, compiled, change);
  const need = c.reqs.filter((r) => r.status === 'at-risk' || r.status === 'review').map((r) => r.id);
  const cover = need.length ? minCostCover(need, model.tests.map((t) => ({ id: t.id, cost: t.hours, covers: t.verifies }))) : { ids: [], cost: 0, nodes: 0 };
  const graphHours = c.graphTests.reduce((a, t) => a + t.hours, 0);
  const counts = {};
  for (const r of c.reqs) counts[r.status] = (counts[r.status] || 0) + 1;
  return {
    ...c, need, cover, counts,
    graph: { requirements: c.reqs.filter((r) => r.suspect).length, tests: c.graphTests.length, hours: graphHours },
    saving: graphHours ? 1 - (cover.cost || 0) / graphHours : 0
  };
}

// ------------------------------------------------------------------ Monte Carlo failure probability
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function randn(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }

/** Wilson score interval for a binomial proportion. */
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}

/**
 * P(requirement fails) with every tolerance read as a 3-sigma normal, truncated to its tolerance band.
 * Returns {p, ci:[lo,hi], n}. Used only to order at-risk items; the plan itself uses the worst-case intervals.
 */
export function failureProbability(model, compiled, change, req, n = 4000, seed = 7) {
  const r = rng(seed);
  const leaves = model.values.map((v) => { const [lo, hi] = leafInterval(v, change[v.id]); return { id: v.id, mid: (lo + hi) / 2, half: (hi - lo) / 2 }; });
  let fails = 0;
  const env = {};
  for (let k = 0; k < n; k++) {
    for (const l of leaves) { let z; do { z = randn(r); } while (Math.abs(z) > 3); env[l.id] = l.mid + (l.half * z) / 3; }
    for (const id of compiled.order) env[id] = evalPoint(compiled.asts[id], env);
    if (!meets(req.op, env[req.quantity], req.limit)) fails++;
  }
  return { p: fails / n, ci: wilson(fails, n), n };
}

/** Path(s) from changed values to a quantity, for "why is this flagged" explanations. */
export function explainPath(compiled, changed, quantity) {
  const memo = {};
  const find = (id) => {
    if (memo[id] !== undefined) return memo[id];
    if (changed.includes(id)) return (memo[id] = [id]);
    const ds = compiled.deps[id] || [];
    for (const d of ds) { const p = find(d); if (p) return (memo[id] = [...p, id]); }
    return (memo[id] = null);
  };
  return find(quantity);
}
