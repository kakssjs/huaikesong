const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(name, deps = {}) {
  let js = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../packages/shared/src', name), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', js)(mod, mod.exports, id => deps[id] ?? require(id));
  return mod.exports;
}
const { planFromRects } = load('plan.ts', { './price': {} });
const rect = (name, x, y, w, d) => ({ name, x, y, w, d });
const overlapWarnings = g => g.warnings.filter(w => w.includes('重叠'));

test('rooms that only touch or overlap slightly produce no overlap warning', () => {
  const touching = planFromRects([rect('客厅', 0, 0, 5, 4), rect('卧室', 5, 0, 4, 4)]);
  assert.deepEqual(overlapWarnings(touching), []);
  const slight = planFromRects([rect('客厅', 0, 0, 5, 4), rect('卧室', 4.9, 0, 4, 4)]);
  assert.deepEqual(overlapWarnings(slight), []);
});

test('a room that overlaps another by a large share is flagged for the owner to check', () => {
  const g = planFromRects([rect('客厅', 0, 0, 5, 6), rect('餐厅', 0, 3, 5, 6)]);
  const found = overlapWarnings(g);
  assert.equal(found.length, 1);
  assert.match(found[0], /客厅/);
  assert.match(found[0], /餐厅/);
  assert.match(found[0], /开放空间|请核对/);
});

test('the overlap warning reports each pair once and names a percentage of the smaller room', () => {
  const g = planFromRects([rect('A', 0, 0, 4, 4), rect('B', 0, 2, 4, 4), rect('C', 10, 0, 4, 4)]);
  const found = overlapWarnings(g);
  assert.equal(found.length, 1);
  assert.match(found[0], /\d+%/);
});

test('geometry is unchanged by the warning: same walls with and without overlap detection', () => {
  const g = planFromRects([rect('客厅', 0, 0, 5, 6), rect('餐厅', 0, 3, 5, 6)]);
  assert.equal(g.rooms.length, 2);
  assert.ok(g.walls.length >= 4);
});
