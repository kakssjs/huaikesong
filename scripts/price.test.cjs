const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const mod = { exports: {} };
new Function('module', 'exports', ts.transpileModule(fs.readFileSync(path.join(__dirname, '../packages/shared/src/price.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(mod, mod.exports);
const { calcQuote } = mod.exports;
test('fractional room quantities reproduce every line amount', () => {
  const quote = calcQuote([{ name: '客厅', area: 10.4 }, { name: '卧室', area: 9.9 }], '现代简约');
  for (const item of quote.items) assert.equal(item.total, Math.round(item.qty * item.price), item.item);
  assert.equal(quote.total, quote.items.reduce((sum, item) => sum + item.total, 0));
});
test('phase estimates add up to the published total duration', () => {
  for (const area of [20, 40, 90, 130, 500]) {
    const quote = calcQuote([{ name: '客厅', area }], '现代简约');
    assert.equal(quote.schedule.reduce((sum, phase) => sum + phase.weeks, 0), quote.weeks, `area ${area}`);
    assert.ok(quote.schedule.every(p => Number.isInteger(p.weeks) && p.weeks >= 1));
  }
});
