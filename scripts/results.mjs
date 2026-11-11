// Computes the retest plan for every demo branch and writes data/results.json (headline numbers for README/email).
// Run: node scripts/results.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { compile, plan, failureProbability } from '../core/retest.js';
const model = JSON.parse(readFileSync('data/model.json', 'utf8'));
const C = compile(model);
const out = { generated_at: new Date().toISOString(), program: model.program, branches: {} };
for (const br of model.branches) {
  const p = plan(model, C, br.change);
  const atRisk = p.reqs.filter((r) => r.status === 'at-risk').map((r) => {
    const req = model.requirements.find((x) => x.id === r.id);
    const fp = failureProbability(model, C, br.change, req, 20000, 11);
    return { id: r.id, after: r.after, pFail: fp.p, ci: fp.ci };
  });
  out.branches[br.id] = {
    title: br.title, changed: p.changed, counts: p.counts, graph: p.graph,
    plan: { tests: p.cover.ids, hours: p.cover.cost, optimal: p.cover.optimal, nodes: p.cover.nodes },
    saving: p.saving, provenByAnalysis: p.reqs.filter((r) => r.status === 'proven').map((r) => r.id), atRisk,
    fails: p.reqs.filter((r) => r.status === 'fails').map((r) => r.id), review: p.reqs.filter((r) => r.status === 'review').map((r) => r.id)
  };
}
const h = out.branches['payload-camera-v2'];
out.headline = { branch: 'payload-camera-v2', graphRequirements: h.graph.requirements, graphTests: h.graph.tests, graphHours: h.graph.hours, proven: h.provenByAnalysis.length, planTests: h.plan.tests.length, planHours: h.plan.hours, saving: h.saving };
writeFileSync('data/results.json', JSON.stringify(out, null, 1));
for (const [k, b] of Object.entries(out.branches)) console.log(k, JSON.stringify(b.counts), 'graph', JSON.stringify(b.graph), 'plan', b.plan.tests.join(','), b.plan.hours + 'h', (b.saving * 100).toFixed(0) + '%', 'atRisk', b.atRisk.map((a) => a.id + ':' + (a.pFail * 100).toFixed(1) + '%').join(' '));
