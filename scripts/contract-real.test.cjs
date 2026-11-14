const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function load(name, deps = {}) {
  const js = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../packages/shared/src', name), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', js)(mod, mod.exports, id => deps[id] ?? require(id));
  return mod.exports;
}
const workflow = load('workflow.ts');
const providers = fs.existsSync(path.join(__dirname, '../packages/shared/src/contract-providers.ts')) ? load('contract-providers.ts', { './workflow': workflow }) : {};

const party = name => ({ legalName: name, registrationId: 'REG-001', representative: name, contact: '13800000000', address: '地址' });
const ACTORS = { owner: { uid: 1, role: 'homeowner' }, company: { uid: 2, role: 'company' }, boss: { uid: 0, role: 'boss' } };

function baseState(mode) {
  const terms = {
    homeowner: party('业主'), company: party('公司'), platform: party('平台'),
    projectName: '测试项目', location: '某地', area: 90, areaBasis: '建筑面积', style: '现代简约', scope: '全屋', totalCents: 1000000,
    durationDays: 60, feeBps: 300, stages: [{ id: 's1', name: '前期', amountCents: 400000, acceptanceCriteria: '验收' }, { id: 's2', name: '竣工', amountCents: 600000, acceptanceCriteria: '验收' }],
    attachments: [], source: { project: {}, quote: {}, design: {} },
  };
  const state = workflow.initializeWorkflow({ orderId: 1, projectId: 1, homeownerId: 1, companyId: 2, terms }, '2026-01-01T00:00:00.000Z', mode);
  return state;
}
const frozen = state => {
  const v = state.versions.at(-1);
  v.status = 'frozen'; v.termsHash = 'a'.repeat(64); v.frozenAt = '2026-01-02T00:00:00.000Z';
  return state;
};
const cmd = (state, action, payload = {}) => ({ action, expectedRevision: state.revision, requestKey: `request-${state.revision}-${action}`, payload });
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHgAAAA8CAYAAACtrX6oAAAACXBIWXMAAAPoAAAD6AG1e1JrAAABNUlEQVR4nO2VwREDMRDCrhIqoZLtv4+kigxw0UN/D7LsR74P3Gs3eNIHgEMwl+AomEtwPNH6wy+BP9h5CQguGEqjULDzEhBcMJRGoWDnJSC4YCiNQsHOS0BwwVAahYKdl4DggqE0CgU7LwHBBUNpFAp2XgKCC4bSKBTsvAQEFwylUSjYeQkILhhKo1Cw8xIQXDCURqFg5yUguGAojULBzktAcMFQGoWCnZeA4IKhNAoFOy8BwQVDaRQKdl4CgguG0igU7LwEBBcMpVEo2HkJCC4YSqNQsPMSEFwwlEahYOclILhgKI1Cwc5LQHDBUBqFgp2XgOCCoTQKBTsvAcEFQ2kUCnZeAoILhtIoFOy8BAQXDKVRKNh5CQguGEqjULDzEhBcMJRGoWDnJSC4YCiNQsHOS/glX+QkzSKOlG3HAAAAAElFTkSuQmCC';
const PROFILE = { party: party('公司'), authorizedSignerName: 'company', updatedAt: '2026-01-01T00:00:00.000Z', mode: 'demo' };
const ctx = (extra = {}) => ({ at: '2026-01-03T00:00:00.000Z', profile: PROFILE, ...extra });

test('the contract mode is real unless CONTRACT_MODE is exactly demo', () => {
  assert.equal(typeof workflow.getContractMode, 'function', 'getContractMode is exported');
  for (const [value, expected] of [[undefined, 'real'], ['', 'real'], ['real', 'real'], ['DEMO', 'real'], ['demo ', 'real'], ['true', 'real'], ['demo', 'demo']]) {
    assert.equal(workflow.getContractMode(value), expected, JSON.stringify(value));
  }
});

test('a new workflow records the mode it was created in', () => {
  assert.equal(baseState('real').mode, 'real');
  assert.equal(baseState('demo').mode, 'demo');
  assert.equal(baseState().mode, 'real', 'default for a new workflow is real');
});

test('a real workflow refuses the demo signing and simulated money actions', () => {
  const state = frozen(baseState('real'));
  for (const action of ['sign_demo', 'simulate_fund', 'simulate_release', 'simulate_refund']) {
    assert.throws(() => workflow.reduceWorkflow(state, ACTORS.owner, cmd(state, action, { signerName: '业主', signatureDataUrl: 'x', amountCents: 1000, stageId: 's1' }), ctx()),
      /演示|真实|MODE/, action);
  }
});

test('a demo workflow refuses the real signing and payment actions', () => {
  const state = frozen(baseState('demo'));
  for (const action of ['sign', 'fund', 'release', 'refund']) {
    assert.throws(() => workflow.reduceWorkflow(state, ACTORS.owner, cmd(state, action, { amountCents: 1000, stageId: 's1' }), ctx()), /演示|真实|MODE/, action);
  }
});

test('real signing without a provider receipt is refused and never recorded', () => {
  const state = frozen(baseState('real'));
  assert.throws(() => workflow.reduceWorkflow(state, ACTORS.owner, cmd(state, 'sign', { signerName: '业主' }), ctx()), /服务商|回执|未配置/);
  assert.equal(state.versions.at(-1).signatures.length, 0);
});

test('real signing records the provider evidence and the third signature makes the contract signed (not signed_demo)', () => {
  let state = frozen(baseState('real'));
  const receipt = who => ({ provider: 'test-esign', externalId: `ext-${who}`, receiptId: `rcpt-${who}`, signerVerified: true, signedAt: '2026-01-03T00:00:00.000Z', evidenceHash: 'b'.repeat(64), certificateFingerprint: 'c'.repeat(40) });
  for (const [who, actor] of [['owner', ACTORS.owner], ['company', ACTORS.company], ['boss', ACTORS.boss]]) {
    state = workflow.reduceWorkflow(state, actor, cmd(state, 'sign', { signerName: who }), ctx({ signing: receipt(who) }));
  }
  const v = state.versions.at(-1);
  assert.equal(v.status, 'signed');
  assert.equal(v.signatures.length, 3);
  assert.equal(v.signatures[0].mode, 'real');
  assert.equal(v.signatures[0].evidence.receiptId, 'rcpt-owner');
  assert.equal(v.signatures[0].evidence.provider, 'test-esign');
});

test('a signing receipt that does not verify the signer is refused', () => {
  const state = frozen(baseState('real'));
  const bad = { provider: 'test-esign', externalId: 'e', receiptId: 'r', signerVerified: false, signedAt: '2026-01-03T00:00:00.000Z', evidenceHash: 'b'.repeat(64) };
  assert.throws(() => workflow.reduceWorkflow(state, ACTORS.owner, cmd(state, 'sign', { signerName: '业主' }), ctx({ signing: bad })), /核验|实名|身份/);
});

test('the same party cannot sign the same real version twice', () => {
  let state = frozen(baseState('real'));
  const receipt = { provider: 'p', externalId: 'e', receiptId: 'r', signerVerified: true, signedAt: '2026-01-03T00:00:00.000Z', evidenceHash: 'b'.repeat(64) };
  state = workflow.reduceWorkflow(state, ACTORS.owner, cmd(state, 'sign', { signerName: '业主' }), ctx({ signing: receipt }));
  assert.throws(() => workflow.reduceWorkflow(state, ACTORS.owner, cmd(state, 'sign', { signerName: '业主' }), ctx({ signing: { ...receipt, receiptId: 'r2' } })), /已完成|重复/);
});

function signedReal() {
  let state = frozen(baseState('real'));
  const receipt = who => ({ provider: 'p', externalId: `e-${who}`, receiptId: `r-${who}`, signerVerified: true, signedAt: '2026-01-03T00:00:00.000Z', evidenceHash: 'b'.repeat(64) });
  for (const [who, actor] of [['owner', ACTORS.owner], ['company', ACTORS.company], ['boss', ACTORS.boss]]) state = workflow.reduceWorkflow(state, actor, cmd(state, 'sign', { signerName: who }), ctx({ signing: receipt(who) }));
  return state;
}
const payment = (over = {}) => ({ provider: 'pay-test', externalId: 'ext-pay', receiptId: 'pr-1', status: 'succeeded', amountCents: 1000000, confirmedAt: '2026-01-04T00:00:00.000Z', reconciled: false, ...over });

test('real funding needs a succeeded payment receipt whose amount matches the request', () => {
  const state = signedReal();
  assert.throws(() => workflow.reduceWorkflow(state, ACTORS.owner, cmd(state, 'fund', { amountCents: 500000 }), ctx()), /服务商|回执|未配置/);
  assert.throws(() => workflow.reduceWorkflow(state, ACTORS.owner, cmd(state, 'fund', { amountCents: 500000 }), ctx({ payment: payment({ status: 'pending', amountCents: 500000 }) })), /未成功|待确认|状态/);
  assert.throws(() => workflow.reduceWorkflow(state, ACTORS.owner, cmd(state, 'fund', { amountCents: 500000 }), ctx({ payment: payment({ amountCents: 400000 }) })), /金额/);
  const next = workflow.reduceWorkflow(state, ACTORS.owner, cmd(state, 'fund', { amountCents: 500000 }), ctx({ payment: payment({ amountCents: 500000 }) }));
  const tx = next.transactions.at(-1);
  assert.equal(tx.type, 'fund'); assert.equal(tx.mode, 'real'); assert.equal(tx.receipt.receiptId, 'pr-1');
  assert.equal(workflow.ledgerTotals(next).balanceCents, 500000);
});

test('the same payment receipt cannot be used to fund twice', () => {
  let state = signedReal();
  state = workflow.reduceWorkflow(state, ACTORS.owner, cmd(state, 'fund', { amountCents: 400000 }), ctx({ payment: payment({ amountCents: 400000 }) }));
  assert.throws(() => workflow.reduceWorkflow(state, ACTORS.owner, cmd(state, 'fund', { amountCents: 400000 }), ctx({ payment: payment({ amountCents: 400000 }) })), /回执|重复/);
});

test('real release keeps the 3% fee borne by the contractor and the same acceptance, balance and dispute rules', () => {
  let state = signedReal();
  state = workflow.reduceWorkflow(state, ACTORS.owner, cmd(state, 'fund', { amountCents: 1000000 }), ctx({ payment: payment({ amountCents: 1000000 }) }));
  state = workflow.reduceWorkflow(state, ACTORS.company, cmd(state, 'submit_stage', { stageId: 's1', evidence: [{ id: 'e1', name: '照片', kind: 'reference', url: 'https://example.test/a.png' }], note: '完成' }), ctx());
  assert.throws(() => workflow.reduceWorkflow(state, ACTORS.owner, cmd(state, 'release', { stageId: 's1' }), ctx({ payment: payment({ receiptId: 'pr-2', amountCents: 400000 }) })), /验收/);
  state = workflow.reduceWorkflow(state, ACTORS.owner, cmd(state, 'accept_stage', { stageId: 's1' }), ctx());
  state = workflow.reduceWorkflow(state, ACTORS.owner, cmd(state, 'release', { stageId: 's1' }), ctx({ payment: payment({ receiptId: 'pr-2', amountCents: 400000 }) }));
  const tx = state.transactions.at(-1);
  assert.equal(tx.type, 'release'); assert.equal(tx.amountCents, 400000); assert.equal(tx.feeCents, 12000); assert.equal(tx.netCents, 388000);
  assert.equal(tx.mode, 'real');
});

test('real refund needs a receipt and still keeps accepted-but-unsettled money reserved', () => {
  let state = signedReal();
  state = workflow.reduceWorkflow(state, ACTORS.owner, cmd(state, 'fund', { amountCents: 1000000 }), ctx({ payment: payment({ amountCents: 1000000 }) }));
  state = workflow.reduceWorkflow(state, ACTORS.company, cmd(state, 'submit_stage', { stageId: 's1', evidence: [{ id: 'e1', name: '照片', kind: 'reference', url: 'https://example.test/a.png' }], note: '完成' }), ctx());
  state = workflow.reduceWorkflow(state, ACTORS.owner, cmd(state, 'accept_stage', { stageId: 's1' }), ctx());
  assert.throws(() => workflow.reduceWorkflow(state, ACTORS.owner, cmd(state, 'refund', { amountCents: 900000, reason: '想退' }), ctx({ payment: payment({ receiptId: 'pr-3', amountCents: 900000 }) })), /保留|已验收/);
  const next = workflow.reduceWorkflow(state, ACTORS.owner, cmd(state, 'refund', { amountCents: 600000, reason: '协商退款' }), ctx({ payment: payment({ receiptId: 'pr-3', amountCents: 600000 }) }));
  assert.equal(next.transactions.at(-1).type, 'refund');
});

test('both signed statuses count as signed for the actions that need a signed contract', () => {
  assert.equal(typeof workflow.isSignedStatus, 'function');
  assert.equal(workflow.isSignedStatus('signed'), true);
  assert.equal(workflow.isSignedStatus('signed_demo'), true);
  for (const status of ['awaiting_company', 'frozen', 'partially_signed', 'superseded']) assert.equal(workflow.isSignedStatus(status), false, status);
});

test('a signed real contract body is read-only just like a signed demo one', () => {
  const state = signedReal();
  assert.throws(() => workflow.reduceWorkflow(state, ACTORS.owner, cmd(state, 'revise', { patch: { area: 100 } }), ctx()), /只读|补充协议/);
});

test('a legacy demo workflow keeps working in demo semantics whatever the environment says', () => {
  let state = frozen(baseState('demo'));
  state.mode = 'demo';
  const next = workflow.reduceWorkflow(state, ACTORS.owner, cmd(state, 'sign_demo', { signerName: '业主', signatureDataUrl: IMG }), ctx({ appliedSignatureDataUrl: IMG, signatureHash: 'd'.repeat(64) }));
  assert.equal(next.versions.at(-1).signatures[0].mode, 'demo');
});

test('provider helpers are exposed and reject a missing provider honestly', () => {
  assert.equal(typeof providers.requireSigningProvider, 'function', 'contract-providers exports requireSigningProvider');
  assert.equal(typeof providers.requirePaymentProvider, 'function');
  assert.throws(() => providers.requireSigningProvider(undefined), /未配置/);
  assert.throws(() => providers.requirePaymentProvider(undefined), /未配置/);
  const signing = { name: 'x', createSignRequest: async () => ({}), fetchResult: async () => ({}) };
  assert.equal(providers.requireSigningProvider(signing), signing);
});
