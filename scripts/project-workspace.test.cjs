const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const file = path.join(__dirname, '../apps/web/lib/project-workspace.ts');
let api = {};
if (fs.existsSync(file)) {
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} }; new Function('module', 'exports', compiled)(mod, mod.exports); api = mod.exports;
}
const keys = ['floor_plan', 'designer', 'quote', 'qa'];
function fixture(overrides = {}) {
  return { delivery: { readyForReview: true, stages: keys.map((key, i) => ({ key, label: key, status: 'done', taskId: i + 1, deliverable: key + '成果', execution: '测试规则', nextAction: '人工复核' })) },
    tasks: keys.map((toAgent, i) => ({ id: i + 1, toAgent, fromAgent: i ? keys[i - 1] : 'orchestrator', status: 'done' })),
    order: null, bids: [], orderFlow: 'ready', confirmedTaskId: null, ...overrides };
}
function build(input = fixture()) { assert.equal(typeof api.buildProjectWorkspace, 'function', 'workspace summary is implemented'); return api.buildProjectWorkspace(input); }
test('current complete delivery needs owner confirmation and routes to quote', () => {
  const result = build(); assert.equal(result.current, 'review'); assert.equal(result.primary.tab, 'quote');
  assert.match(result.primary.label, /确认/); assert.equal(result.canChat, false);
});
test('initial work without a task never claims agent execution', () => {
  const f = fixture({ tasks: [] }); f.delivery.readyForReview = false; f.delivery.stages.forEach(s => { s.status = 'pending'; s.taskId = null; });
  const r = build(f); assert.equal(r.current, 'input'); assert.match(r.summary, /等待/); assert.equal(r.handoffs[0].taskId, null);
});
test('latest waiting task gives an actual question but old failed task does not block success', () => {
  const f = fixture(); f.tasks.unshift({ id: 0, toAgent: 'designer', fromAgent: 'floor_plan', status: 'failed' });
  assert.equal(build(f).current, 'review');
  f.delivery.readyForReview = false; f.delivery.stages[1].status = 'waiting_user'; f.delivery.stages[1].taskId = 10;
  f.tasks.push({ id: 10, toAgent: 'designer', fromAgent: 'orchestrator', status: 'waiting_user', output: { ask: '请核实门窗' } });
  const r = build(f); assert.equal(r.primary.tab, 'design'); assert.match(r.summary, /请核实门窗/);
});
test('stale dependencies take priority even with an existing selected company', () => {
  const f = fixture({ order: { id: 1, companyId: 2, status: 'matched', contractedAt: null } });
  f.delivery.readyForReview = false; f.delivery.stages[1].status = 'stale';
  const r = build(f); assert.equal(r.current, 'design'); assert.equal(r.canChat, true); assert.match(r.summary, /重新|更新|旧/);
});
test('old owner confirmation cannot advance an unpublished new delivery', () => {
  const r = build(fixture({ confirmedTaskId: 1 })); assert.equal(r.current, 'review');
  const current = build(fixture({ confirmedTaskId: 4 })); assert.match(current.primary.label, /发布/); assert.equal(current.primary.tab, 'match');
});
test('order load or network failure never pretends project is unpublished', () => {
  for (const orderFlow of ['loading', 'error']) {
    const r = build(fixture({ orderFlow })); assert.equal(r.primary.tab, 'match'); assert.match(r.summary, /读取|加载/);
    assert.doesNotMatch(r.primary.label, /确认方案|发布项目/);
  }
});
test('waiting for real bids and matching execution/failure remain distinct', () => {
  const f = fixture({ order: { id: 1, companyId: null, status: 'open' } });
  assert.match(build(f).summary, /投标/); assert.equal(build(f).canChat, false);
  f.bids = [{ id: 9 }]; f.tasks.push({ id: 5, toAgent: 'matcher', fromAgent: 'orchestrator', status: 'running' });
  assert.match(build(f).summary, /匹配|比较/); assert.match(build(f).handoffs.at(-1).status, /running/);
  f.tasks.at(-1).status = 'failed'; assert.match(build(f).summary, /失败/);
});
test('only a selected company opens chat and contracted orders route to existing fulfilment', () => {
  const f = fixture({ order: { id: 2, companyId: 8, status: 'matched', contractedAt: null } });
  assert.equal(build(f).canChat, true); assert.equal(build(f).primary.tab, 'match'); assert.equal(build(f).current, 'communicate');
  f.order.status = 'contracted'; f.order.contractedAt = '2026-11-15';
  const r = build(f); assert.equal(r.current, 'fulfil'); assert.equal(r.primary.tab, 'fulfil');
  assert.doesNotMatch(r.summary, /验收完成|已付款|履约完成/);
  f.order.status = 'open'; assert.equal(build(f).canChat, false);
});
test('handoffs use recorded sender and task id; missing receiver task is waiting, not handed off', () => {
  const f = fixture(); f.tasks[1].fromAgent = 'orchestrator';
  const r = build(f); assert.equal(r.handoffs[1].fromAgent, 'orchestrator'); assert.equal(r.handoffs[1].taskId, 2);
  assert.equal(r.handoffs[0].nextTaskId, null);
  assert.equal(r.handoffs[1].nextTaskId, 3);
  f.tasks = f.tasks.filter(t => t.toAgent !== 'designer'); f.delivery.stages[1].taskId = null; f.delivery.stages[1].status = 'pending';
  assert.equal(build(f).handoffs[0].nextTaskId, null);
});
test('cancelled task is stopped instead of falsely queued', () => {
  const f = fixture(); f.tasks[0].status = 'cancelled'; f.delivery.readyForReview = false; f.delivery.stages[0].status = 'pending';
  const r = build(f); assert.match(r.summary, /停止/); assert.doesNotMatch(r.summary, /已排队/); assert.equal(r.handoffs[0].status, 'cancelled');
});
test('superseded waiting task never creates a resume banner or restarts the old branch', () => {
  const f = fixture(); f.delivery.readyForReview = false;
  f.delivery.stages[0].status = 'running'; f.delivery.stages[0].taskId = 10;
  f.delivery.stages[1].status = 'stale';
  f.tasks[1].status = 'waiting_user';
  f.tasks.push({ id: 10, toAgent: 'floor_plan', fromAgent: 'orchestrator', status: 'running' });
  assert.deepEqual(build(f).waitingTasks, []); assert.equal(build(f).canResume, false);
  f.delivery.stages[0].status = 'waiting_user'; f.tasks.at(-1).status = 'waiting_user';
  assert.deepEqual(build(f).waitingTasks.map(t => t.id), [10]);
  assert.equal(build(f).canResume, false, 'global resume API would also resume old waiting task');
  f.tasks[1].status = 'cancelled'; assert.equal(build(f).canResume, true);
});
