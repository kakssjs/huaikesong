const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yushe-contract-agent-'));
const source = path.join(__dirname, '../apps/web/lib/contract-agent.ts');
let agent = {};
if (fs.existsSync(source)) {
  const target = path.join(dir, 'contract-agent.cjs');
  fs.writeFileSync(target, ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText);
  agent = require(target);
}
after(() => {
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(dir, { recursive: true, force: true });
});
const input = { area: 90, areaBasis: '套内面积', style: '现代简约', scope: '地板与墙面',
  totalCents: 10000000, durationDays: 60, feeBps: 300,
  stages: [{ name: '第一期', amountCents: 10000000, acceptanceCriteria: '人工验收' }],
  missing: [], errors: [] };

test('contract review sends engineering data while excluding identity and signature fields', async () => {
  assert.equal(typeof agent.reviewContractTerms, 'function');
  let sent;
  const result = await agent.reviewContractTerms({ ...input, homeowner: { phone: 'private-phone-value' },
    sealDataUrl: 'private-seal-value', source: { password: 'private-password-value' } }, async messages => {
    sent = messages;
    return { text: JSON.stringify({ summary: '请人工核对材料范围', issues: ['明确材料品牌'] }), tokensUsed: 42 };
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.mode, 'model');
  assert.equal(result.tokensUsed, 42);
  assert.deepEqual(result.issues, ['明确材料品牌']);
  const body = JSON.stringify(sent);
  assert.ok(body.includes('10000000'));
  assert.ok(!body.includes('private-phone-value'));
  assert.ok(!body.includes('private-seal-value'));
  assert.ok(!body.includes('private-password-value'));
});

test('contract reviewer cannot return monetary mutations or signing instructions as executable output', async () => {
  assert.equal(typeof agent.reviewContractTerms, 'function');
  await assert.rejects(agent.reviewContractTerms(input, async () => ({
    text: JSON.stringify({ summary: 'ok', issues: [], totalCents: 1, action: 'simulate_release' }), tokensUsed: 1,
  })), /格式|复核/);
  assert.equal(input.totalCents, 10000000);
});

test('malformed model response fails without including its raw content in the error', async () => {
  assert.equal(typeof agent.reviewContractTerms, 'function');
  await assert.rejects(agent.reviewContractTerms(input, async () => ({ text: 'private-invalid-response', tokensUsed: 1 })), error => {
    assert.ok(!error.message.includes('private-invalid-response'));
    return true;
  });
});

test('contract review treats invalid engineering inputs as errors before invoking the model', async () => {
  assert.equal(typeof agent.reviewContractTerms, 'function');
  let called = false;
  await assert.rejects(agent.reviewContractTerms({ ...input, totalCents: -1 }, async () => {
    called = true; return { text: '{}', tokensUsed: 0 };
  }));
  assert.equal(called, false);
});
