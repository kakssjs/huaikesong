const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function moduleFor(name) {
  const file = path.join(__dirname, '../apps/web/lib', name + '.ts');
  if (!fs.existsSync(file)) return {};
  const mod = { exports: {} };
  new Function('module', 'exports', ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(mod, mod.exports);
  return mod.exports;
}
const trials = moduleFor('trial-records'), drafts = moduleFor('chat-drafts');
const memory = () => { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k,v) => map.set(k,v), removeItem: k => map.delete(k) }; };
const sample = overrides => ({ id: 'sample-001', sample: '户型01', kind: 'real', role: 'floor_plan', systemSeconds: 60, manualMinutes: 10, modelCostCny: null, revisions: 1, outcome: 'accepted', recordedAt: '2026-11-14T09:00:00Z', ...overrides });
test('trial summary never mixes synthetic evidence with real results or unknown costs with zero', () => {
  assert.equal(typeof trials.summarizeTrials, 'function');
  const r = trials.summarizeTrials([sample(), sample({ id:'two', systemSeconds:180, modelCostCny:2, outcome:'rejected' }), sample({ id:'fake', kind:'synthetic', systemSeconds:1, modelCostCny:0 })]);
  assert.equal(r.realCount, 2); assert.equal(r.syntheticCount, 1); assert.equal(r.medianSeconds,120);
  assert.equal(r.costSampleCount,1); assert.equal(r.meanCostCny,2); assert.equal(r.acceptanceRate,0.5); assert.equal(r.timeSavedPct,80);
});
test('missing baselines and unreviewed samples produce no invented savings or acceptance rate', () => {
  assert.equal(typeof trials.summarizeTrials, 'function');
  const r=trials.summarizeTrials([sample({ manualMinutes:null, outcome:'pending' })]);
  assert.equal(r.timeSavedPct,null); assert.equal(r.acceptanceRate,null); assert.equal(r.meanCostCny,null);
});
test('trial inputs reject negative, non-finite or ambiguous values', () => {
  assert.equal(typeof trials.validateTrial, 'function');
  for(const patch of [{systemSeconds:-1},{systemSeconds:Infinity},{modelCostCny:-2},{revisions:1.2},{kind:'unknown'},{manualMinutes:0}]) assert.throws(()=>trials.validateTrial(sample(patch)));
  assert.equal(trials.validateTrial(sample({modelCostCny:0})).modelCostCny,0);
});
test('CSV export escapes quotes, newlines and spreadsheet formulas', () => {
  assert.equal(typeof trials.trialsCsv, 'function');
  const csv=trials.trialsCsv([sample({sample:'=SUM(1,2)\n"示例"'})]);
  assert.ok(csv.includes("'=SUM(1,2)")); assert.ok(csv.includes('""示例""'));
});
test('draft and retry identity survive reload only for the same account and conversation', () => {
  assert.equal(typeof drafts.saveChatDraft, 'function');
  const s=memory(); drafts.saveChatDraft(s,1,2,{text:'材料型号',clientKey:'retry-key-001'},1000);
  assert.equal(drafts.loadChatDraft(s,1,2,2000).clientKey,'retry-key-001');
  assert.equal(drafts.loadChatDraft(s,2,2,2000),null); assert.equal(drafts.loadChatDraft(s,1,3,2000),null);
});
test('draft storage expiry and unavailable storage fail safely', () => {
  assert.equal(typeof drafts.saveChatDraft, 'function');
  const s=memory();drafts.saveChatDraft(s,1,2,{text:'旧草稿'},1000);
  assert.equal(drafts.loadChatDraft(s,1,2,1000+25*3600000),null);
  const denied={getItem(){throw Error()},setItem(){throw Error()},removeItem(){throw Error()}};
  assert.equal(drafts.loadChatDraft(denied,1,2),null);
  assert.equal(drafts.saveChatDraft(denied,1,2,{text:'保留内存草稿'}),false);
});
