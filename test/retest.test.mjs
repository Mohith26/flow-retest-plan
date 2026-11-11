import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  I, parse, vars, evalPoint, evalInterval, compile, evaluate, downstream, classify, minCostCover, plan, rng,
  wilson, failureProbability, explainPath
} from '../core/retest.js';

const model = JSON.parse(readFileSync(new URL('../data/model.json', import.meta.url)));
const results = JSON.parse(readFileSync(new URL('../data/results.json', import.meta.url)));
const C = compile(model);

test('parser respects precedence, functions and variables', () => {
  const env = { a: 2, b: 3, c: 4 };
  assert.equal(evalPoint(parse('a + b * c'), env), 14);
  assert.equal(evalPoint(parse('(a + b) * c'), env), 20);
  assert.equal(evalPoint(parse('sum(a, b, c) / 3'), env), 3);
  assert.equal(evalPoint(parse('sqrt(c) * sq(b) - min(a, b, c)'), env), 16);
  assert.equal(evalPoint(parse('-a + 1e1'), env), 8);
  assert.deepEqual([...vars(parse('n_cells * m_cell + m_bms'))].sort(), ['m_bms', 'm_cell', 'n_cells']);
  assert.throws(() => parse('a + (b'));
});

test('interval operations: signs, division guard, squares', () => {
  assert.deepEqual(I.mul([-2, 3], [-1, 4]), [-8, 12]);
  assert.deepEqual(I.sub([1, 2], [0.5, 3]), [-2, 1.5]);
  assert.deepEqual(I.sq([-3, 2]), [0, 9]);
  assert.throws(() => I.div([1, 2], [-1, 1]));
  assert.deepEqual(I.div([2, 4], [1, 2]), [1, 4]);
});

test('interval evaluation is sound on random expressions (property, 400 expressions x 200 samples)', () => {
  const r = rng(42);
  const names = ['x', 'y', 'z', 'w'];
  function gen(depth) {
    if (depth === 0 || r() < 0.25) return r() < 0.75 ? { v: names[Math.floor(r() * 4)] } : { n: +(0.5 + r() * 3).toFixed(2) };
    const k = r();
    if (k < 0.25) return { op: '+', a: gen(depth - 1), b: gen(depth - 1) };
    if (k < 0.45) return { op: '-', a: gen(depth - 1), b: gen(depth - 1) };
    if (k < 0.7) return { op: '*', a: gen(depth - 1), b: gen(depth - 1) };
    if (k < 0.8) return { op: 'sq', a: gen(depth - 1) };
    if (k < 0.9) return { op: 'max', a: gen(depth - 1), b: gen(depth - 1) };
    return { op: '/', a: gen(depth - 1), b: { op: '+', a: { n: 1 }, b: { op: 'sq', a: gen(depth - 2 < 0 ? 0 : depth - 2) } } };
  }
  for (let k = 0; k < 400; k++) {
    const ast = gen(4);
    const box = Object.fromEntries(names.map((n) => { const c = -2 + 4 * r(), h = r(); return [n, [c - h, c + h]]; }));
    const [lo, hi] = evalInterval(ast, box);
    for (let s = 0; s < 200; s++) {
      const env = Object.fromEntries(names.map((n) => [n, box[n][0] + r() * (box[n][1] - box[n][0])]));
      const x = evalPoint(ast, env);
      assert.ok(x >= lo - 1e-9 && x <= hi + 1e-9, `sample ${x} outside [${lo}, ${hi}]`);
    }
  }
});

test('compile orders derived values topologically and rejects cycles', () => {
  const pos = Object.fromEntries(C.order.map((id, i) => [id, i]));
  for (const id of C.order) for (const d of C.deps[id]) if (pos[d] !== undefined) assert.ok(pos[d] < pos[id], `${d} before ${id}`);
  assert.throws(() => compile({ derived: [{ id: 'a', formula: 'b + 1' }, { id: 'b', formula: 'a * 2' }] }), /cycle/);
});

test('downstream closure follows formulas transitively', () => {
  const d = downstream(model, C, ['m_cam']);
  for (const id of ['m_total', 'f1', 'inertia', 't_slew']) assert.ok(d.has(id), id);
  assert.ok(!d.has('dl_ratio') && !d.has('p_gen'));
  assert.deepEqual(explainPath(C, ['m_cam'], 't_slew'), ['m_cam', 'm_total', 'inertia', 't_slew']);
});

test('demo model is sound: Monte Carlo draws inside every worst-case interval, every branch', () => {
  const r = rng(9);
  for (const br of [{ change: {} }, ...model.branches]) {
    const { iv } = evaluate(model, C, br.change);
    for (let k = 0; k < 3000; k++) {
      const env = {};
      for (const v of model.values) { const [lo, hi] = iv[v.id]; env[v.id] = lo + r() * (hi - lo); }
      for (const id of C.order) {
        env[id] = evalPoint(C.asts[id], env);
        assert.ok(env[id] >= iv[id][0] - 1e-9 && env[id] <= iv[id][1] + 1e-9, `${id} escaped its interval`);
      }
    }
  }
});

test('classification: proven never fails, fails never passes, statuses on a toy model', () => {
  const toy = {
    values: [{ id: 'a', nominal: 10, tol: 1, tolKind: 'abs', system: 's1' }, { id: 'b', nominal: 5, tol: 0, tolKind: 'abs', system: 's2' }],
    derived: [{ id: 'q', formula: 'a + b' }],
    requirements: [
      { id: 'R1', kind: 'numeric', quantity: 'q', op: '<=', limit: 20, systems: [] },
      { id: 'R2', kind: 'numeric', quantity: 'q', op: '<=', limit: 16.5, systems: [] },
      { id: 'R3', kind: 'numeric', quantity: 'q', op: '<=', limit: 13, systems: [] },
      { id: 'R4', kind: 'qualitative', systems: ['s1'] },
      { id: 'R5', kind: 'qualitative', systems: ['s2'] },
      { id: 'R6', kind: 'numeric', quantity: 'b', op: '<=', limit: 6, systems: ['s1'] }
    ],
    tests: [{ id: 'T1', hours: 1, verifies: ['R1', 'R2', 'R3'] }, { id: 'T2', hours: 2, verifies: ['R4'] }]
  };
  const tc = compile(toy);
  const out = classify(toy, tc, { a: { nominal: 11 } });
  const st = Object.fromEntries(out.reqs.map((r) => [r.id, r.status]));
  assert.deepEqual(st, { R1: 'proven', R2: 'at-risk', R3: 'fails', R4: 'review', R5: 'unaffected', R6: 'unchanged' });
  const p = plan(toy, tc, { a: { nominal: 11 } });
  assert.deepEqual(p.cover.ids, ['T1', 'T2']);
  for (const br of model.branches) {
    const pl = plan(model, C, br.change);
    for (const r of pl.reqs.filter((x) => x.status === 'proven')) {
      const req = model.requirements.find((x) => x.id === r.id);
      assert.equal(failureProbability(model, C, br.change, req, 1500, 3).p, 0, `${r.id} proven but sampled a failure`);
    }
  }
});

function brute(universe, sets) {
  let best = Infinity;
  const n = sets.length;
  for (let m = 1; m < 1 << n; m++) {
    let cost = 0; const cov = new Set();
    for (let i = 0; i < n; i++) if (m & (1 << i)) { cost += sets[i].cost; sets[i].covers.forEach((e) => cov.add(e)); }
    if (universe.every((e) => cov.has(e)) && cost < best) best = cost;
  }
  return best;
}

test('minimum-cost cover is optimal: matches brute force on 300 random instances (property)', () => {
  const r = rng(5);
  for (let k = 0; k < 300; k++) {
    const ne = 3 + Math.floor(r() * 9), ns = 3 + Math.floor(r() * 10);
    const universe = Array.from({ length: ne }, (_, i) => 'e' + i);
    const sets = Array.from({ length: ns }, (_, j) => ({ id: 's' + j, cost: 1 + Math.floor(r() * 40), covers: universe.filter(() => r() < 0.3) }));
    universe.forEach((e, i) => sets[i % ns].covers.push(e)); // make it feasible
    const res = minCostCover(universe, sets);
    assert.equal(res.cost, brute(universe, sets));
    const chosen = sets.filter((s) => res.ids.includes(s.id));
    assert.ok(universe.every((e) => chosen.some((s) => s.covers.includes(e))));
  }
});

test('minimum-cost cover reports uncoverable requirements', () => {
  const res = minCostCover(['a', 'b'], [{ id: 's', cost: 1, covers: ['a'] }]);
  assert.deepEqual(res.infeasible, ['b']);
});

test('plans always cover every at-risk and review requirement (random what-if edits, property)', () => {
  const r = rng(77);
  const editable = model.values.filter((v) => v.nominal !== 0 && v.tolKind === 'pct');
  for (let k = 0; k < 150; k++) {
    const change = {};
    for (let j = 0; j < 1 + Math.floor(r() * 3); j++) { const v = editable[Math.floor(r() * editable.length)]; change[v.id] = { nominal: v.nominal * (0.85 + 0.3 * r()) }; }
    const p = plan(model, C, change);
    const chosen = model.tests.filter((t) => p.cover.ids.includes(t.id));
    for (const id of p.need) assert.ok(chosen.some((t) => t.verifies.includes(id)), `${id} uncovered`);
    assert.ok(p.cover.cost <= p.graph.hours + 1e-9, 'plan never costs more than retesting every suspect link');
  }
});

test('Wilson interval contains the estimate and narrows with n', () => {
  const [a, b] = wilson(3, 100), [c, d] = wilson(30, 1000);
  assert.ok(a <= 0.03 && 0.03 <= b && c <= 0.03 && 0.03 <= d);
  assert.ok(d - c < b - a);
  assert.deepEqual(wilson(0, 0), [0, 1]);
});

test('headline numbers recompute exactly from data/model.json', () => {
  for (const [id, b] of Object.entries(results.branches)) {
    const br = model.branches.find((x) => x.id === id);
    const p = plan(model, C, br.change);
    assert.deepEqual(p.graph, b.graph);
    assert.deepEqual(p.cover.ids, b.plan.tests);
    assert.equal(p.cover.cost, b.plan.hours);
  }
  const h = results.headline;
  assert.equal(h.graphHours, 308);
  assert.equal(h.planHours, 68);
  assert.equal(h.planTests, 5);
  assert.ok(Math.abs(h.saving - (1 - 68 / 308)) < 1e-12);
});

test('baseline (no change) has every numeric requirement proven with margin', () => {
  const { iv } = evaluate(model, C, {});
  for (const r of model.requirements.filter((x) => x.kind === 'numeric')) {
    const [lo, hi] = iv[r.quantity];
    assert.ok(r.op === '<=' ? hi <= r.limit : lo >= r.limit, `${r.id} not proven at baseline`);
  }
});
