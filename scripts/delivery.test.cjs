const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const sourcePath = path.join(__dirname, '../packages/shared/src/delivery.ts');
let api = {};
if (fs.existsSync(sourcePath)) {
  const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', compiled)(mod, mod.exports);
  api = mod.exports;
}
function report(overrides = {}) {
  assert.equal(typeof api.buildDeliveryReport, 'function', 'delivery report must be implemented');
  const project = { id: 1, name: '合成样例', style: '现代简约', budget: '15', area: '90', address: 'private', floorPlanPath: 'private-path' };
  const tasks = ['floor_plan', 'designer', 'quote', 'qa'].map((toAgent, i) => ({ id: i + 1, toAgent, fromAgent: 'orchestrator', status: 'done', tokensCost: 0 }));
  const results = [
    { kind: 'plan', content: { rooms: [{ name: '客厅', area: 30 }], source: 'user_studio' } },
    { kind: 'design', content: { svg: '<svg />' } },
    { kind: 'scene_model', content: { schema: 'test' } },
    { kind: 'decorations', content: { images: [{ room: '客厅', url: '/sample.png' }] } },
    { kind: 'quote', content: { total: 10000, items: [{ item: '测试', qty: 10, price: 1000, total: 10000 }], weeks: 4, schedule: [{ phase: '演示阶段', weeks: 4 }] } },
    { kind: 'qa', content: { passed: true } },
    { kind: 'signature', content: { seal: 'private' } },
  ];
  return api.buildDeliveryReport({ project, tasks, results, ...overrides });
}
test('a complete evidence chain is ready for human review, not accepted construction', () => {
  const r = report();
  assert.equal(r.readyForReview, true);
  assert.equal(r.completedStages, 4);
  assert.match(r.stages[0].execution, /人工/);
  assert.match(r.stages[2].execution, /规则/);
});
test('a new failed run supersedes all historical successes and invalidates downstream evidence', () => {
  const tasks = ['floor_plan', 'designer', 'quote', 'qa'].map((toAgent, i) => ({ id: i + 1, toAgent, status: 'done' }));
  tasks.push({ id: 5, toAgent: 'floor_plan', status: 'waiting_user' });
  const r = report({ tasks: tasks.reverse() });
  assert.equal(r.readyForReview, false);
  assert.equal(r.completedStages, 0);
  assert.equal(r.stages[0].status, 'waiting_user');
  assert.equal(r.stages[1].status, 'stale');
});
test('a downstream run does not hide a missing or unsuccessful upstream stage', () => {
  const r = report({ tasks: [{ id: 2, toAgent: 'quote', status: 'done' }] });
  assert.equal(r.readyForReview, false);
  assert.notEqual(r.stages[2].status, 'done');
});
test('done task without artifacts does not count as delivered', () => {
  const r = report({ results: [] });
  assert.equal(r.completedStages, 0);
  assert.equal(r.readyForReview, false);
});
test('failed QA and missing room images remain visible rather than passing as complete', () => {
  const r = report({ results: [
    { kind: 'plan', content: { rooms: [{ name: '客厅', area: 30 }], source: 'mimo' } },
    { kind: 'design', content: { svg: '<svg />' } },
    { kind: 'scene_model', content: { schema: 'test' } },
    { kind: 'decorations', content: { images: [{ room: '客厅' }], degraded: 'render_failed' } },
    { kind: 'quote', content: { total: 100, items: [{ total: 100 }] } },
    { kind: 'qa', content: { passed: false } },
  ] });
  assert.equal(r.readyForReview, false);
  assert.equal(r.stages[1].status, 'partial');
  assert.match(r.stages[0].execution, /模型/);
  assert.match(r.stages[1].nextAction, /效果图/);
});
test('inconsistent quote arithmetic blocks delivery review even with a done task', () => {
  const r = report({ results: [{ kind: 'quote', content: { total: 200, items: [{ total: 100 }] } }] });
  assert.equal(r.readyForReview, false);
  assert.notEqual(r.stages[2].status, 'done');
});
test('export excludes addresses, private result types, task input and arbitrary output', () => {
  const r = report({ tasks: [{ id: 9, toAgent: 'floor_plan', status: 'failed', input: { key: 'secret-input' }, output: { token: 'secret-output' } }] });
  const text = JSON.stringify(r);
  assert.doesNotMatch(text, /private|secret-input|secret-output|signature/);
  assert.equal(r.project.id, 1);
  assert.ok(r.generatedAt);
});
test('latest artifacts win even when results arrive in descending order', () => {
  const r = report({ results: [
    { id: 8, kind: 'qa', content: { passed: false } },
    { id: 2, kind: 'qa', content: { passed: true } },
  ] });
  assert.equal(r.artifacts.find(a => a.kind === 'qa').content.passed, false);
  assert.equal(r.readyForReview, false);
});
test('an artifact saved before the latest task cannot prove that task delivered', () => {
  const r = report({
    tasks: [{ id: 5, toAgent: 'floor_plan', status: 'done', createdAt: '2026-11-14T02:00:00Z' }],
    results: [{ kind: 'plan', createdAt: '2026-11-14T01:00:00Z', content: { rooms: [{ name: '客厅', area: 30 }] } }],
  });
  assert.notEqual(r.stages[0].status, 'done');
});
test('updating a scene without creating a task invalidates earlier QA evidence', () => {
  const base = report();
  const results = base.artifacts.map(a => ({ ...a, createdAt: '2026-11-14T01:00:00Z' }));
  results.find(a => a.kind === 'scene_model').createdAt = '2026-11-14T02:00:00Z';
  const r = report({ results });
  assert.equal(r.readyForReview, false);
  assert.equal(r.stages[3].status, 'stale');
});
test('changing marked floorplan input invalidates the old room output', () => {
  const base = report();
  const results = base.artifacts.map(a => ({ ...a, createdAt: '2026-11-14T01:00:00Z' }));
  results.push({ kind: 'floorplan', createdAt: '2026-11-14T02:00:00Z', content: { rects: [] } });
  const r = report({ results });
  assert.equal(r.readyForReview, false);
  assert.equal(r.stages[0].status, 'stale');
  assert.ok(!r.artifacts.some(a => a.kind === 'floorplan'));
});
test('legacy inconsistent quantities or phase durations cannot pass delivery review', () => {
  for (const broken of [
    { total: 7228, items: [{ qty: 10, price: 695, total: 7228 }], weeks: 4, schedule: [{ weeks: 4 }] },
    { total: 100, items: [{ qty: 1, price: 100, total: 100 }], weeks: 4, schedule: [{ weeks: 3 }, { weeks: 3 }] },
  ]) {
    const base = report();
    const results = base.artifacts.map(a => a.kind === 'quote' ? { kind: 'quote', content: broken } : a);
    const r = report({ results });
    assert.equal(r.readyForReview, false);
    assert.equal(r.stages[2].status, 'partial');
  }
});

test('advisory layout warning does not turn successful QA into missing images', () => {
  const baseline = report();
  const results = baseline.artifacts.map(a => ({ ...a, content: a.kind === 'qa' ? { passed: true, degraded: 'render_failed', checks: [{ ok: false, rule: 'low_confidence_floorplan', level: 'warn', detail: '房间「主卧」过窄（0.8×1.7m），尺寸以现场量房为准' }] } : a.content }));
  const tasks = baseline.tasks.map(t => ({ ...t, output: t.toAgent === 'qa' ? { passed: true, degraded: 'render_failed' } : {} }));
  assert.equal(report({ results, tasks }).readyForReview, true);
  results.find(a => a.kind === 'qa').content.checks.push({ ok: false, rule: 'render_failed', level: 'warn' });
  assert.equal(report({ results, tasks }).readyForReview, false);
});

test('overlap warnings remain blocking even when the old QA passed flag is true', () => {
  const base = report();
  const results = base.artifacts.map(a => ({ ...a, content: a.kind === 'qa' ? { passed: true, degraded: 'render_failed', checks: [{ ok: false, rule: 'low_confidence_floorplan', level: 'warn', detail: '房间重叠' }] } : a.content }));
  assert.equal(report({ results, tasks: base.tasks }).readyForReview, false);
});
