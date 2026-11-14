const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const Module = require('node:module');
const file = path.join(__dirname, '../apps/web/app/components/workflow-form.tsx');
let ui = {};
if (fs.existsSync(file)) {
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = new Module(file, module); loaded.filename = file; loaded.paths = module.paths; loaded._compile(source, file); ui = loaded.exports;
}
// Catches rounding by floating point, accidental yuan/cent mixing and permissive numeric parsing.
test('contract inputs preserve cents and reject ambiguous or unsafe money', () => {
  assert.equal(typeof ui.parseYuan, 'function', 'money input converter is implemented');
  for (const [input, cents] of [['0.01', 1], ['39', 3900], ['19.90', 1990], ['100000.29', 10000029]]) assert.equal(ui.parseYuan(input), cents);
  for (const input of ['', '-1', '1.001', '1e3', 'NaN', 'Infinity', '900719925474099.91']) assert.throws(() => ui.parseYuan(input));
  assert.equal(ui.centsInput(10000029), '100000.29');
});
// Catches a stage form submitting a different total or losing one cent during editing.
test('stage editor submits the exact contract total and rejects duplicate stages', () => {
  assert.equal(typeof ui.stagesPayload, 'function', 'stage input converter is implemented');
  const stages = [{ id: 's1', name: '前期', amount: '0.01', acceptanceCriteria: '照片' }, { id: 's2', name: '竣工', amount: '100.28', acceptanceCriteria: '现场验收' }];
  assert.deepEqual(ui.stagesPayload(stages, 10029).map(s => s.amountCents), [1, 10028]);
  assert.throws(() => ui.stagesPayload(stages, 10030));
  assert.throws(() => ui.stagesPayload([stages[0], { ...stages[1], id: 's1' }], 10029));
});
// Catches treating 3% as 3 basis points or permitting invalid fee percentages.
test('fee inputs convert a percentage to integer basis points', () => {
  assert.equal(typeof ui.parseFeePercent, 'function', 'fee input converter is implemented');
  assert.equal(ui.parseFeePercent('3'), 300); assert.equal(ui.parseFeePercent('3.25'), 325);
  assert.equal(ui.parseFeePercent('50'), 5000); assert.equal(ui.parseFeePercent('100'), 10000);
  for (const value of ['100.01', '-1', '', '3.333']) assert.throws(() => ui.parseFeePercent(value));
});
// A workflow may allow actions on other stages; cancelled stages must remain read-only.
test('cancelled stages cannot expose workflow-wide construction or payment actions', () => {
  assert.equal(typeof ui.canActOnStage, 'function', 'stage cancellation guard is implemented');
  const allowed = ['submit_stage', 'accept_stage', 'reject_stage', 'simulate_release', 'open_dispute'];
  for (const action of allowed) assert.equal(ui.canActOnStage('cancelled', allowed, action), false);
  assert.equal(ui.canActOnStage('submitted', allowed, 'accept_stage'), true);
  assert.equal(ui.canActOnStage('submitted', [], 'accept_stage'), false);
});
