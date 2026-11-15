// Real contracts through a provider: request -> provider -> receipt. Pure domain, no database and no network.
// Every test here uses in-memory receipts written by the test. Nothing in this file is a real provider.
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
const providers = load('contract-providers.ts', { './workflow': workflow });

const party = name => ({ legalName: name, registrationId: 'REG-001', representative: name, contact: '13800000000', address: '地址' });
const ACTORS = { owner: { uid: 1, role: 'homeowner' }, company: { uid: 2, role: 'company' }, boss: { uid: 0, role: 'boss' } };
const SIGNERS = { owner: '业主本人', company: '公司授权人', boss: '平台授权人' };
const PROFILE = { party: party('公司'), authorizedSignerName: SIGNERS.company, updatedAt: '2026-01-01T00:00:00.000Z', mode: 'demo' };
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHgAAAA8CAYAAACtrX6oAAAACXBIWXMAAAPoAAAD6AG1e1JrAAABNUlEQVR4nO2VwREDMRDCrhIqoZLtv4+kigxw0UN/D7LsR74P3Gs3eNIHgEMwl+AomEtwPNH6wy+BP9h5CQguGEqjULDzEhBcMJRGoWDnJSC4YCiNQsHOS0BwwVAahYKdl4DggqE0CgU7LwHBBUNpFAp2XgKCC4bSKBTsvAQEFwylUSjYeQkILhhKo1Cw8xIQXDCURqFg5yUguGAojULBzktAcMFQGoWCnZeA4IKhNAoFOy8BwQVDaRQKdl4CgguG0igU7LwEBBcMpVEo2HkJCC4YSqNQsPMSEFwwlEahYOclILhgKI1Cwc5LQHDBUBqFgp2XgOCCoTQKBTsvAcEFQ2kUCnZeAoILhtIoFOy8BAQXDKVRKNh5CQguGEqjULDzEhBcMJRGoWDnJSC4YCiNQsHOS/glX+QkzSKOlG3HAAAAAElFTkSuQmCC';
let clock = 0;
const at = () => new Date(Date.UTC(2026, 0, 3, 0, 0, ++clock)).toISOString();
const ctx = (extra = {}) => ({ at: at(), profile: PROFILE, ...extra });
const cmd = (state, action, payload = {}) => ({ action, expectedRevision: state.revision, requestKey: `request-${state.revision}-${action}`, payload });
const act = (state, who, action, payload = {}, extra = {}) => workflow.reduceWorkflow(state, ACTORS[who], cmd(state, action, payload), ctx(extra));
const requests = state => state.providerRequests ?? [];
const last = state => requests(state).at(-1);

function baseState(mode = 'real') {
  const terms = {
    homeowner: party('业主'), company: party('公司'), platform: party('平台'),
    projectName: '测试项目', location: '某地', area: 90, areaBasis: '建筑面积', style: '现代简约', scope: '全屋', totalCents: 1000000,
    durationDays: 60, feeBps: 300, stages: [{ id: 's1', name: '前期', amountCents: 400000, acceptanceCriteria: '验收' }, { id: 's2', name: '竣工', amountCents: 600000, acceptanceCriteria: '验收' }],
    attachments: [], source: { project: {}, quote: {}, design: {} },
  };
  return workflow.initializeWorkflow({ orderId: 1, projectId: 1, homeownerId: 1, companyId: 2, terms }, '2026-01-01T00:00:00.000Z', mode);
}
function frozen(mode = 'real') {
  const state = baseState(mode), v = state.versions.at(-1);
  v.status = 'frozen'; v.termsHash = 'a'.repeat(64); v.frozenAt = '2026-01-02T00:00:00.000Z';
  return state;
}
const signReceipt = (who, over = {}) => ({ provider: 'test-esign', externalId: `sign-${who}`, receiptId: `receipt-${who}`, signerVerified: true,
  organizationVerified: who !== 'owner', signedAt: '2026-01-03T00:00:00.000Z', evidenceHash: 'b'.repeat(64), ...over });
const payReceipt = (externalId, amountCents, over = {}) => ({ provider: 'test-pay', externalId, receiptId: `pay-${externalId}`, status: 'succeeded', amountCents,
  confirmedAt: '2026-01-04T00:00:00.000Z', reconciled: false, ...over });

/** One party signs through the provider: request, provider accepts the request, provider returns a receipt. */
function signThroughProvider(state, who, payload = {}) {
  state = act(state, who, 'sign', { signerName: SIGNERS[who], ...payload }, { provider: 'test-esign' });
  const request = last(state);
  state = workflow.providerRequestSent(state, request.id, { provider: 'test-esign', externalId: `sign-${who}${payload.supplementId ? '-supp' : ''}`, actionUrl: `https://esign.example.test/${who}` }, at());
  return workflow.settleProviderRequest(state, request.id, { signing: signReceipt(who, { externalId: `sign-${who}${payload.supplementId ? '-supp' : ''}`, receiptId: `receipt-${who}${payload.supplementId ?? ''}` }) }, at());
}
function signedReal() {
  let state = frozen('real');
  for (const who of ['owner', 'company', 'boss']) state = signThroughProvider(state, who);
  assert.equal(state.versions.at(-1).status, 'signed');
  return state;
}
/** Money in through the provider. */
function funded(state, amountCents, id = 'fund-1') {
  state = act(state, 'owner', 'fund', { amountCents }, { provider: 'test-pay' });
  const request = last(state);
  state = workflow.providerRequestSent(state, request.id, { provider: 'test-pay', externalId: id, actionUrl: 'https://pay.example.test/checkout' }, at());
  return workflow.settleProviderRequest(state, request.id, { payment: payReceipt(id, amountCents) }, at());
}
function accepted(state, stageId) {
  state = act(state, 'company', 'submit_stage', { stageId, evidence: [{ id: `proof-${stageId}`, name: '照片', kind: 'reference', url: 'https://example.test/a.png' }], note: '完成' });
  return act(state, 'owner', 'accept_stage', { stageId });
}

// ---------------------------------------------------------------------------------------------------------------
// Contract file
// ---------------------------------------------------------------------------------------------------------------

test('a signed real contract can be exported; the file shows the provider evidence and never calls itself a demo', () => {
  const state = signedReal();
  const html = workflow.renderWorkflowHtml(workflow.workflowView(state, ACTORS.owner));
  assert.match(html, /receipt-owner/);
  assert.match(html, new RegExp('b'.repeat(64)));
  assert.match(html, /test-esign/);
  assert.equal(/演示|无真实资金|非正式电子签/.test(html), false, 'a real contract must not carry the demo wording');
});

test('a demo contract file keeps saying it is a demo', () => {
  let state = frozen('demo');
  state = act(state, 'owner', 'sign_demo', { signerName: '业主', signatureDataUrl: IMG }, { appliedSignatureDataUrl: IMG, signatureHash: 'd'.repeat(64) });
  const html = workflow.renderWorkflowHtml(workflow.workflowView(state, ACTORS.owner));
  assert.match(html, /产品演示/);
});

// ---------------------------------------------------------------------------------------------------------------
// Signing through a provider
// ---------------------------------------------------------------------------------------------------------------

test('asking to sign with a configured provider opens a request and records no signature yet', () => {
  const state = act(frozen(), 'owner', 'sign', { signerName: SIGNERS.owner }, { provider: 'test-esign' });
  assert.equal(state.versions.at(-1).signatures.length, 0);
  const request = last(state);
  assert.equal(request.kind, 'sign'); assert.equal(request.status, 'creating'); assert.equal(request.role, 'homeowner');
  assert.equal(request.termsHash, 'a'.repeat(64));
  assert.equal(request.externalId, undefined, 'the provider has not been called yet');
});

test('the signing link is shown only to the party who asked for it', () => {
  let state = act(frozen(), 'owner', 'sign', { signerName: SIGNERS.owner }, { provider: 'test-esign' });
  state = workflow.providerRequestSent(state, last(state).id, { provider: 'test-esign', externalId: 'sign-owner', actionUrl: 'https://esign.example.test/owner' }, at());
  assert.equal(last(state).status, 'pending');
  assert.equal(workflow.workflowView(state, ACTORS.owner).providerRequests.at(-1).actionUrl, 'https://esign.example.test/owner');
  for (const other of [ACTORS.company, ACTORS.boss]) {
    const seen = workflow.workflowView(state, other).providerRequests.at(-1);
    assert.equal(seen.status, 'pending');
    assert.equal(seen.actionUrl, undefined);
  }
});

test('a party cannot open a second signing request while one is still open', () => {
  const state = act(frozen(), 'owner', 'sign', { signerName: SIGNERS.owner }, { provider: 'test-esign' });
  assert.throws(() => act(state, 'owner', 'sign', { signerName: SIGNERS.owner }, { provider: 'test-esign' }), /进行中|待完成|已有/);
});

test('a provider receipt settles the request into a signature; settling again changes nothing', () => {
  let state = act(frozen(), 'owner', 'sign', { signerName: SIGNERS.owner }, { provider: 'test-esign' });
  const id = last(state).id;
  state = workflow.providerRequestSent(state, id, { provider: 'test-esign', externalId: 'sign-owner' }, at());
  const waiting = workflow.settleProviderRequest(state, id, { signing: null }, at());
  assert.equal(waiting.versions.at(-1).signatures.length, 0);
  assert.equal(last(waiting).status, 'pending', 'no receipt yet means still waiting');
  state = workflow.settleProviderRequest(state, id, { signing: signReceipt('owner') }, at());
  const v = state.versions.at(-1);
  assert.equal(v.signatures.length, 1); assert.equal(v.signatures[0].mode, 'real');
  assert.equal(v.signatures[0].evidence.receiptId, 'receipt-owner'); assert.equal(v.signatures[0].signerName, SIGNERS.owner);
  assert.equal(last(state).status, 'succeeded');
  const again = workflow.settleProviderRequest(state, id, { signing: signReceipt('owner') }, at());
  assert.equal(again.versions.at(-1).signatures.length, 1);
  assert.equal(again.revision, state.revision, 'a repeated callback must not write anything');
});

test('all three parties signing through the provider makes the contract signed', () => {
  const state = signedReal();
  assert.equal(state.versions.at(-1).signatures.length, 3);
  assert.deepEqual(requests(state).map(r => r.status), ['succeeded', 'succeeded', 'succeeded']);
});

test('a receipt for another session, or one that did not verify the signer, is never recorded as a signature', () => {
  let state = act(frozen(), 'owner', 'sign', { signerName: SIGNERS.owner }, { provider: 'test-esign' });
  const id = last(state).id;
  state = workflow.providerRequestSent(state, id, { provider: 'test-esign', externalId: 'sign-owner' }, at());
  const foreign = workflow.settleProviderRequest(state, id, { signing: signReceipt('owner', { externalId: 'someone-else' }) }, at());
  assert.equal(foreign.versions.at(-1).signatures.length, 0);
  assert.equal(last(foreign).status, 'pending', 'a receipt for a different session says nothing about this one');
  const unverified = workflow.settleProviderRequest(state, id, { signing: signReceipt('owner', { signerVerified: false }) }, at());
  assert.equal(unverified.versions.at(-1).signatures.length, 0);
  assert.equal(last(unverified).status, 'failed');
  assert.match(last(unverified).failure, /核验|实名|身份/);
});

test('the company and the platform sign as organisations: the provider must have verified the organisation and the authority to sign', () => {
  let state = signThroughProvider(frozen(), 'owner');
  state = act(state, 'company', 'sign', { signerName: SIGNERS.company }, { provider: 'test-esign' });
  const id = last(state).id;
  state = workflow.providerRequestSent(state, id, { provider: 'test-esign', externalId: 'sign-company' }, at());
  const refused = workflow.settleProviderRequest(state, id, { signing: signReceipt('company', { organizationVerified: false }) }, at());
  assert.equal(refused.versions.at(-1).signatures.length, 1);
  assert.equal(last(refused).status, 'failed');
  assert.match(last(refused).failure, /主体|授权|企业/);
  // The direct receipt path applies the same rule.
  assert.throws(() => act(frozen(), 'company', 'sign', { signerName: SIGNERS.company }, { signing: signReceipt('company', { organizationVerified: undefined }) }), /主体|授权|企业/);
  // A homeowner is a natural person: no organisation check.
  const owner = act(frozen(), 'owner', 'sign', { signerName: SIGNERS.owner }, { signing: signReceipt('owner', { organizationVerified: undefined }) });
  assert.equal(owner.versions.at(-1).signatures.length, 1);
});

test('the company signer must be the authorised signer saved in the company profile', () => {
  assert.throws(() => act(frozen(), 'company', 'sign', { signerName: '路人' }, { provider: 'test-esign' }), /授权/);
  assert.throws(() => act(frozen(), 'company', 'sign', { signerName: SIGNERS.company }, { provider: 'test-esign', profile: null }), /资料/);
});

test('when the provider echoes who signed and which terms it bound, both must match', () => {
  assert.throws(() => act(frozen(), 'owner', 'sign', { signerName: SIGNERS.owner }, { signing: signReceipt('owner', { signerName: '别人' }) }), /签署人|不一致/);
  assert.throws(() => act(frozen(), 'owner', 'sign', { signerName: SIGNERS.owner }, { signing: signReceipt('owner', { termsHash: 'f'.repeat(64) }) }), /条款|校验值|不一致/);
  const ok = act(frozen(), 'owner', 'sign', { signerName: SIGNERS.owner }, { signing: signReceipt('owner', { signerName: SIGNERS.owner, termsHash: 'a'.repeat(64) }) });
  assert.equal(ok.versions.at(-1).signatures.length, 1);
});

test('changing the contract cancels open signing requests, and a late receipt for the old version is not used', () => {
  let state = signThroughProvider(frozen(), 'owner');
  state = act(state, 'company', 'sign', { signerName: SIGNERS.company }, { provider: 'test-esign' });
  const id = last(state).id;
  state = workflow.providerRequestSent(state, id, { provider: 'test-esign', externalId: 'sign-company' }, at());
  state = act(state, 'owner', 'negotiate', { totalCents: 900000, note: '还价' });
  assert.equal(last(state).status, 'cancelled');
  const late = workflow.settleProviderRequest(state, id, { signing: signReceipt('company') }, at());
  assert.equal(late.versions.at(-1).signatures.length, 0);
  assert.equal(late.versions.at(-2).signatures.length, 1, 'the earlier partial signature stays on the archived version');
});

test('only the party who opened a signing request can cancel it', () => {
  let state = act(frozen(), 'owner', 'sign', { signerName: SIGNERS.owner }, { provider: 'test-esign' });
  const id = last(state).id;
  state = workflow.providerRequestSent(state, id, { provider: 'test-esign', externalId: 'sign-owner' }, at());
  assert.throws(() => act(state, 'company', 'cancel_request', { requestId: id }), /无权|本人/);
  state = act(state, 'owner', 'cancel_request', { requestId: id });
  assert.equal(last(state).status, 'cancelled');
  const again = act(state, 'owner', 'sign', { signerName: SIGNERS.owner }, { provider: 'test-esign' });
  assert.equal(last(again).status, 'creating', 'after cancelling, the party can start again');
});

// ---------------------------------------------------------------------------------------------------------------
// Money through a provider
// ---------------------------------------------------------------------------------------------------------------

test('funding is recorded only when the provider confirms it; an open request already counts against the contract total', () => {
  let state = act(signedReal(), 'owner', 'fund', { amountCents: 700000 }, { provider: 'test-pay' });
  const id = last(state).id;
  assert.equal(last(state).status, 'creating');
  assert.equal(state.transactions.length, 0);
  assert.throws(() => act(state, 'owner', 'fund', { amountCents: 400000 }, { provider: 'test-pay' }), /合同总价/);
  state = workflow.providerRequestSent(state, id, { provider: 'test-pay', externalId: 'fund-1', actionUrl: 'https://pay.example.test/1' }, at());
  const stillWaiting = workflow.settleProviderRequest(state, id, { payment: payReceipt('fund-1', 700000, { status: 'pending' }) }, at());
  assert.equal(stillWaiting.transactions.length, 0); assert.equal(last(stillWaiting).status, 'pending');
  state = workflow.settleProviderRequest(state, id, { payment: payReceipt('fund-1', 700000) }, at());
  assert.equal(state.transactions.length, 1);
  const tx = state.transactions[0];
  assert.equal(tx.type, 'fund'); assert.equal(tx.mode, 'real'); assert.equal(tx.receipt.receiptId, 'pay-fund-1');
  assert.equal(workflow.ledgerTotals(state).balanceCents, 700000);
  assert.equal(last(state).status, 'succeeded');
  const again = workflow.settleProviderRequest(state, id, { payment: payReceipt('fund-1', 700000) }, at());
  assert.equal(again.transactions.length, 1, 'a repeated callback must not credit twice');
});

test('a failed payment closes the request without touching the ledger', () => {
  let state = act(signedReal(), 'owner', 'fund', { amountCents: 500000 }, { provider: 'test-pay' });
  const id = last(state).id;
  state = workflow.providerRequestSent(state, id, { provider: 'test-pay', externalId: 'fund-1' }, at());
  state = workflow.settleProviderRequest(state, id, { payment: payReceipt('fund-1', 500000, { status: 'failed' }) }, at());
  assert.equal(state.transactions.length, 0); assert.equal(last(state).status, 'failed');
  const retry = act(state, 'owner', 'fund', { amountCents: 500000 }, { provider: 'test-pay' });
  assert.equal(last(retry).status, 'creating');
});

test('a succeeded receipt for a different amount is not recorded and the request stays open for a person to look at', () => {
  let state = act(signedReal(), 'owner', 'fund', { amountCents: 500000 }, { provider: 'test-pay' });
  const id = last(state).id;
  state = workflow.providerRequestSent(state, id, { provider: 'test-pay', externalId: 'fund-1' }, at());
  state = workflow.settleProviderRequest(state, id, { payment: payReceipt('fund-1', 499999) }, at());
  assert.equal(state.transactions.length, 0);
  assert.equal(last(state).status, 'pending');
  assert.match(last(state).failure, /金额/);
});

test('a payout is not sent to the provider until the platform has reviewed it, and it reserves the money meanwhile', () => {
  let state = accepted(accepted(funded(signedReal(), 600000), 's1'), 's2');
  state = act(state, 'owner', 'release', { stageId: 's1' }, { provider: 'test-pay' });
  const request = last(state);
  assert.equal(request.kind, 'release'); assert.equal(request.status, 'awaiting_review'); assert.equal(request.amountCents, 400000);
  assert.equal(state.transactions.filter(t => t.type === 'release').length, 0);
  const totals = workflow.ledgerTotals(state);
  assert.equal(totals.balanceCents, 600000); assert.equal(totals.reservedCents, 400000); assert.equal(totals.availableCents, 200000);
  assert.throws(() => act(state, 'owner', 'release', { stageId: 's1' }, { provider: 'test-pay' }), /进行中|已有|重复/);
  assert.throws(() => act(state, 'owner', 'release', { stageId: 's2' }, { provider: 'test-pay' }), /余额/);
  assert.throws(() => act(state, 'owner', 'refund', { amountCents: 300000, reason: '退' }, { provider: 'test-pay' }), /余额|保留/);
});

test('only the platform reviews payouts; a rejection frees the reserved money', () => {
  let state = act(accepted(funded(signedReal(), 1000000), 's1'), 'owner', 'release', { stageId: 's1' }, { provider: 'test-pay' });
  const id = last(state).id;
  for (const who of ['owner', 'company']) assert.throws(() => act(state, who, 'review_payout', { requestId: id, decision: 'approve', note: '同意' }, { provider: 'test-pay' }), /无权/);
  assert.throws(() => act(state, 'boss', 'review_payout', { requestId: id, decision: 'approve' }, { provider: 'test-pay' }), /复核意见/);
  const rejected = act(state, 'boss', 'review_payout', { requestId: id, decision: 'reject', note: '收款主体待核实' });
  assert.equal(last(rejected).status, 'rejected'); assert.equal(last(rejected).review.decision, 'rejected');
  assert.equal(workflow.ledgerTotals(rejected).reservedCents, 0);
  assert.equal(rejected.stages[0].status, 'accepted', 'the acceptance itself is untouched');
});

test('an approved payout goes to the provider and is recorded on its receipt with the 3% fee borne by the contractor', () => {
  let state = act(accepted(funded(signedReal(), 1000000), 's1'), 'owner', 'release', { stageId: 's1' }, { provider: 'test-pay' });
  const id = last(state).id;
  state = act(state, 'boss', 'review_payout', { requestId: id, decision: 'approve', note: '验收与余额已核对' }, { provider: 'test-pay' });
  assert.equal(last(state).status, 'creating'); assert.equal(last(state).review.decision, 'approved');
  assert.equal(last(state).feeCents, 12000, 'the fee is fixed at the review, so the provider can be told how to split the payout');
  state = workflow.providerRequestSent(state, id, { provider: 'test-pay', externalId: 'payout-1' }, at());
  state = workflow.settleProviderRequest(state, id, { payment: payReceipt('payout-1', 400000) }, at());
  const tx = state.transactions.at(-1);
  assert.equal(tx.type, 'release'); assert.equal(tx.amountCents, 400000); assert.equal(tx.feeCents, 12000); assert.equal(tx.netCents, 388000);
  assert.equal(tx.stageId, 's1'); assert.equal(tx.receipt.receiptId, 'pay-payout-1');
  assert.equal(state.stages[0].status, 'settled');
  assert.equal(workflow.ledgerTotals(state).reservedCents, 0);
});

test('a refund goes through the same platform review and still cannot take money reserved for accepted work', () => {
  let state = accepted(funded(signedReal(), 1000000), 's1');
  assert.throws(() => act(state, 'owner', 'refund', { amountCents: 700000, reason: '想退' }, { provider: 'test-pay' }), /保留|已验收/);
  state = act(state, 'owner', 'refund', { amountCents: 600000, reason: '协商退款' }, { provider: 'test-pay' });
  const id = last(state).id;
  assert.equal(last(state).status, 'awaiting_review');
  state = act(state, 'boss', 'review_payout', { requestId: id, decision: 'approve', note: '双方已确认' }, { provider: 'test-pay' });
  state = workflow.providerRequestSent(state, id, { provider: 'test-pay', externalId: 'refund-1' }, at());
  state = workflow.settleProviderRequest(state, id, { payment: payReceipt('refund-1', 600000) }, at());
  const tx = state.transactions.at(-1);
  assert.equal(tx.type, 'refund'); assert.equal(tx.reason, '协商退款'); assert.equal(workflow.ledgerTotals(state).balanceCents, 400000);
});

test('the party who asked for a payout can withdraw it while it waits for review; nobody else can', () => {
  let state = act(accepted(funded(signedReal(), 1000000), 's1'), 'owner', 'release', { stageId: 's1' }, { provider: 'test-pay' });
  const id = last(state).id;
  assert.throws(() => act(state, 'company', 'cancel_request', { requestId: id }), /无权|本人/);
  state = act(state, 'owner', 'cancel_request', { requestId: id });
  assert.equal(last(state).status, 'cancelled');
  assert.equal(workflow.ledgerTotals(state).reservedCents, 0);
});

test('without a provider and without a receipt the real actions are still refused and nothing is recorded', () => {
  assert.throws(() => act(signedReal(), 'owner', 'fund', { amountCents: 1 }), /服务商|回执|未配置/, 'fund');
  const state = accepted(funded(signedReal(), 600000), 's1');
  for (const [action, payload] of [['release', { stageId: 's1' }], ['refund', { amountCents: 1, reason: '退' }]]) {
    assert.throws(() => act(state, 'owner', action, payload), /服务商|回执|未配置/, action);
  }
  assert.throws(() => act(frozen(), 'owner', 'sign', { signerName: SIGNERS.owner }), /服务商|回执|未配置/);
});

test('two payouts on their way at once each get their own fee, and the fees still add up to 3% of what was paid out', () => {
  let state = accepted(accepted(funded(signedReal(), 1000000), 's1'), 's2');
  const ids = {};
  for (const stageId of ['s1', 's2']) {
    state = act(state, 'owner', 'release', { stageId }, { provider: 'test-pay' });
    ids[stageId] = last(state).id;
    state = act(state, 'boss', 'review_payout', { requestId: ids[stageId], decision: 'approve', note: '已核对' }, { provider: 'test-pay' });
    state = workflow.providerRequestSent(state, ids[stageId], { provider: 'test-pay', externalId: `payout-${stageId}` }, at());
  }
  const fees = Object.fromEntries(requests(state).filter(r => r.kind === 'release').map(r => [r.stageId, r.feeCents]));
  assert.deepEqual(fees, { s1: 12000, s2: 18000 });
  // The second one settles first: each transaction carries the fee that was fixed for it.
  state = workflow.settleProviderRequest(state, ids.s2, { payment: payReceipt('payout-s2', 600000) }, at());
  assert.equal(state.transactions.at(-1).feeCents, 18000);
  state = workflow.settleProviderRequest(state, ids.s1, { payment: payReceipt('payout-s1', 400000) }, at());
  assert.equal(state.transactions.at(-1).feeCents, 12000);
  const totals = workflow.ledgerTotals(state);
  assert.equal(totals.releasedCents, 1000000); assert.equal(totals.realizedFeeCents, 30000); assert.equal(totals.balanceCents, 0);
});

test('a payout that fails does not leave its fee behind: the next review computes against what was really paid', () => {
  let state = accepted(accepted(funded(signedReal(), 1000000), 's1'), 's2');
  const approve = (stageId, externalId) => {
    state = act(state, 'owner', 'release', { stageId }, { provider: 'test-pay' });
    const id = last(state).id;
    state = act(state, 'boss', 'review_payout', { requestId: id, decision: 'approve', note: '已核对' }, { provider: 'test-pay' });
    state = workflow.providerRequestSent(state, id, { provider: 'test-pay', externalId }, at());
    return id;
  };
  const first = approve('s1', 'payout-a');
  state = workflow.settleProviderRequest(state, first, { payment: payReceipt('payout-a', 400000, { status: 'failed' }) }, at());
  assert.equal(state.transactions.filter(t => t.type === 'release').length, 0); assert.equal(workflow.ledgerTotals(state).reservedCents, 0);
  const second = approve('s2', 'payout-b');
  assert.equal(requests(state).find(r => r.id === second).feeCents, 18000, '3% of the 600000 that is actually leaving, not of 1000000');
  state = workflow.settleProviderRequest(state, second, { payment: payReceipt('payout-b', 600000) }, at());
  const retry = approve('s1', 'payout-c');
  state = workflow.settleProviderRequest(state, retry, { payment: payReceipt('payout-c', 400000) }, at());
  assert.equal(workflow.ledgerTotals(state).realizedFeeCents, 30000);
});

test('when the provider reports the fee it split off, it must be the fee fixed at the review', () => {
  let state = act(accepted(funded(signedReal(), 1000000), 's1'), 'owner', 'release', { stageId: 's1' }, { provider: 'test-pay' });
  const id = last(state).id;
  state = act(state, 'boss', 'review_payout', { requestId: id, decision: 'approve', note: '已核对' }, { provider: 'test-pay' });
  state = workflow.providerRequestSent(state, id, { provider: 'test-pay', externalId: 'payout-1' }, at());
  const wrong = workflow.settleProviderRequest(state, id, { payment: payReceipt('payout-1', 400000, { feeCents: 1 }) }, at());
  assert.equal(wrong.transactions.filter(t => t.type === 'release').length, 0);
  assert.equal(requests(wrong).find(r => r.id === id).status, 'pending'); assert.match(requests(wrong).find(r => r.id === id).failure, /服务费/);
  const right = workflow.settleProviderRequest(state, id, { payment: payReceipt('payout-1', 400000, { feeCents: 12000 }) }, at());
  assert.equal(right.transactions.at(-1).feeCents, 12000); assert.equal(right.transactions.at(-1).netCents, 388000);
});

// ---------------------------------------------------------------------------------------------------------------
// Disputes and money that is already on its way
// ---------------------------------------------------------------------------------------------------------------

test('a dispute withdraws a payout that is still waiting for review and blocks its approval', () => {
  let state = act(accepted(funded(signedReal(), 1000000), 's1'), 'owner', 'release', { stageId: 's1' }, { provider: 'test-pay' });
  const id = last(state).id;
  state = act(state, 'company', 'open_dispute', { stageId: 's1', reason: '工程量有争议' });
  assert.equal(last(state).status, 'cancelled');
  assert.throws(() => act(state, 'boss', 'review_payout', { requestId: id, decision: 'approve', note: '同意' }, { provider: 'test-pay' }), /未找到|待复核/);
  assert.throws(() => act(state, 'owner', 'release', { stageId: 's1' }, { provider: 'test-pay' }), /争议/);
});

test('a payout already with the provider is put on hold, not pretended frozen; if it still succeeds the fact is recorded', () => {
  let state = act(accepted(funded(signedReal(), 1000000), 's1'), 'owner', 'release', { stageId: 's1' }, { provider: 'test-pay' });
  const id = last(state).id;
  state = act(state, 'boss', 'review_payout', { requestId: id, decision: 'approve', note: '已核对' }, { provider: 'test-pay' });
  state = workflow.providerRequestSent(state, id, { provider: 'test-pay', externalId: 'payout-1' }, at());
  state = act(state, 'owner', 'open_dispute', { stageId: 's1', reason: '发现质量问题' });
  const held = requests(state).find(r => r.id === id);
  assert.equal(held.status, 'pending', 'the money may already have left; only the provider can say');
  assert.equal(held.hold.disputeId, state.disputes[0].id);
  assert.throws(() => act(state, 'boss', 'resolve_dispute', { disputeId: state.disputes[0].id, independentParty: '调解机构', basis: '依据', outcome: '解除', disposition: 'cancel_stage' }), /在途|出款/);
  // The provider could not stop it and reports success: record what happened.
  const paid = workflow.settleProviderRequest(state, id, { payment: payReceipt('payout-1', 400000) }, at());
  assert.equal(paid.transactions.at(-1).type, 'release');
  assert.equal(paid.stages[0].status, 'settled');
  assert.equal(paid.disputes[0].status, 'open', 'the dispute stays open for the parties to resolve');
  // The provider did stop it: the money stays where it was.
  const stopped = workflow.providerRequestCancelled(state, id, '服务商已撤销出款', at());
  assert.equal(requests(stopped).find(r => r.id === id).status, 'cancelled');
  assert.equal(stopped.transactions.filter(t => t.type === 'release').length, 0);
  assert.equal(stopped.stages[0].status, 'accepted');
});

// ---------------------------------------------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------------------------------------------

test('reconciliation compares every recorded movement with what the provider says now', () => {
  const state = funded(signedReal(), 600000);
  const ok = workflow.reconcileWorkflow(state, { 'fund-1': payReceipt('fund-1', 600000, { reconciled: true }) });
  assert.equal(ok.ok, true); assert.equal(ok.checked, 1); assert.equal(ok.matched, 1); assert.deepEqual(ok.mismatches, []);
  const amount = workflow.reconcileWorkflow(state, { 'fund-1': payReceipt('fund-1', 590000) });
  assert.equal(amount.ok, false); assert.match(amount.mismatches[0].reason, /金额/);
  const missing = workflow.reconcileWorkflow(state, { 'fund-1': null });
  assert.equal(missing.ok, false); assert.match(missing.mismatches[0].reason, /查不到|没有/);
  const reversed = workflow.reconcileWorkflow(state, { 'fund-1': payReceipt('fund-1', 600000, { status: 'failed' }) });
  assert.equal(reversed.ok, false); assert.match(reversed.mismatches[0].reason, /状态/);
});

test('the reconciliation result is stored by the platform only and does not change any amount', () => {
  const state = funded(signedReal(), 600000);
  const report = workflow.reconcileWorkflow(state, { 'fund-1': payReceipt('fund-1', 590000) });
  assert.throws(() => workflow.recordReconciliation(state, ACTORS.owner, report, at()), /无权|平台/);
  const saved = workflow.recordReconciliation(state, ACTORS.boss, report, at());
  assert.equal(saved.reconciliation.ok, false); assert.equal(saved.reconciliation.mismatches.length, 1);
  assert.equal(workflow.ledgerTotals(saved).balanceCents, 600000);
  assert.equal(saved.transactions[0].amountCents, 600000);
});

// ---------------------------------------------------------------------------------------------------------------
// Supplementary agreements
// ---------------------------------------------------------------------------------------------------------------

const NEW_STAGES = [{ id: 's1', name: '前期', amountCents: 400000, acceptanceCriteria: '验收' }, { id: 's2', name: '竣工', amountCents: 500000, acceptanceCriteria: '验收' }, { id: 's3', name: '增项', amountCents: 300000, acceptanceCriteria: '增项验收' }];

test('a signed contract is changed only by a supplementary agreement, which needs a signed contract and a real change', () => {
  assert.throws(() => act(frozen(), 'company', 'propose_supplement', { reason: '增项', patch: { scope: '全屋加阳台' } }), /签署/);
  const state = signedReal();
  assert.throws(() => act(state, 'company', 'propose_supplement', { reason: '增项', patch: {} }), /变更/);
  assert.throws(() => act(state, 'boss', 'propose_supplement', { reason: '增项', patch: { scope: '全屋加阳台' } }), /无权/);
  assert.throws(() => act(state, 'company', 'propose_supplement', { reason: '增项', patch: { company: party('别的公司') } }), /无权|不能/);
  const next = act(state, 'company', 'propose_supplement', { reason: '业主要求增加阳台封窗', patch: { scope: '全屋加阳台', totalCents: 1200000, stages: NEW_STAGES, durationDays: 75 } });
  const supplement = next.supplements.at(-1);
  assert.equal(supplement.status, 'proposed'); assert.equal(supplement.number, 1); assert.equal(supplement.proposedBy, 'company');
  assert.equal(supplement.terms.totalCents, 1200000); assert.ok(supplement.confirmations.company);
  assert.equal(next.versions.at(-1).terms.totalCents, 1000000, 'the signed contract itself is not edited');
  assert.equal(workflow.effectiveTerms(next).totalCents, 1000000, 'nothing takes effect before all three have signed');
  assert.throws(() => act(next, 'owner', 'propose_supplement', { reason: '再改', patch: { scope: '再改' } }), /已有|进行中/);
});

test('a supplementary agreement cannot rewrite a stage that has already been submitted, accepted or paid', () => {
  const state = accepted(funded(signedReal(), 1000000), 's1');
  const changed = NEW_STAGES.map(s => s.id === 's1' ? { ...s, amountCents: 300000 } : s.id === 's2' ? { ...s, amountCents: 600000 } : s);
  assert.throws(() => act(state, 'company', 'propose_supplement', { reason: '改已验收阶段', patch: { totalCents: 1200000, stages: changed } }), /已提交|已验收|不能变更|锁定/);
  assert.throws(() => act(state, 'company', 'propose_supplement', { reason: '删已验收阶段', patch: { totalCents: 600000, stages: [NEW_STAGES[1], { ...NEW_STAGES[2], amountCents: 100000 }] } }), /已提交|已验收|不能变更|锁定/);
  assert.throws(() => act(state, 'company', 'propose_supplement', { reason: '只改总价', patch: { totalCents: 1200000 } }), /分期/);
});

test('the other side confirms, all three sign through the provider, and only then do the new terms and stages apply', () => {
  let state = accepted(funded(signedReal(), 1000000), 's1');
  const before = state.versions.at(-1);
  state = act(state, 'company', 'propose_supplement', { reason: '增加阳台封窗', patch: { scope: '全屋加阳台', totalCents: 1200000, stages: NEW_STAGES, durationDays: 75 } });
  const id = state.supplements.at(-1).id;
  assert.throws(() => act(state, 'company', 'confirm_supplement', { supplementId: id }, { supplementTermsHash: 'c'.repeat(64) }), /已确认|对方/);
  assert.throws(() => act(state, 'owner', 'sign', { signerName: SIGNERS.owner, supplementId: id }, { provider: 'test-esign' }), /冻结|确认/);
  state = act(state, 'owner', 'confirm_supplement', { supplementId: id }, { supplementTermsHash: 'c'.repeat(64) });
  assert.equal(state.supplements.at(-1).status, 'frozen'); assert.equal(state.supplements.at(-1).termsHash, 'c'.repeat(64));
  for (const who of ['owner', 'company']) state = signThroughProvider(state, who, { supplementId: id });
  assert.equal(state.supplements.at(-1).status, 'partially_signed');
  assert.equal(workflow.effectiveTerms(state).totalCents, 1000000);
  state = signThroughProvider(state, 'boss', { supplementId: id });
  const supplement = state.supplements.at(-1);
  assert.equal(supplement.status, 'signed'); assert.equal(supplement.signatures.length, 3);
  assert.equal(supplement.signatures[0].termsHash, 'c'.repeat(64));
  assert.equal(workflow.effectiveTerms(state).totalCents, 1200000);
  assert.deepEqual(state.stages.map(s => [s.stageId, s.status]), [['s1', 'accepted'], ['s2', 'pending'], ['s3', 'pending']]);
  const after = state.versions.at(-1);
  assert.equal(after.termsHash, before.termsHash); assert.equal(after.terms.totalCents, 1000000); assert.equal(after.signatures.length, 3);
  assert.equal(workflow.workflowView(state, ACTORS.owner).effective.totalCents, 1200000);
});

test('after a supplementary agreement, payouts use the new stage amounts and the fee still adds up over the new total', () => {
  let state = accepted(funded(signedReal(), 1000000), 's1');
  state = act(state, 'company', 'propose_supplement', { reason: '增项', patch: { totalCents: 1200000, stages: NEW_STAGES } });
  const id = state.supplements.at(-1).id;
  state = act(state, 'owner', 'confirm_supplement', { supplementId: id }, { supplementTermsHash: 'c'.repeat(64) });
  for (const who of ['owner', 'company', 'boss']) state = signThroughProvider(state, who, { supplementId: id });
  state = funded(state, 200000, 'fund-2');
  let fee = 0;
  for (const [stageId, amount] of [['s1', 400000], ['s2', 500000], ['s3', 300000]]) {
    if (stageId !== 's1') state = accepted(state, stageId);
    state = act(state, 'owner', 'release', { stageId }, { provider: 'test-pay' });
    const request = last(state).id;
    state = act(state, 'boss', 'review_payout', { requestId: request, decision: 'approve', note: '已核对' }, { provider: 'test-pay' });
    state = workflow.providerRequestSent(state, request, { provider: 'test-pay', externalId: `payout-${stageId}` }, at());
    state = workflow.settleProviderRequest(state, request, { payment: payReceipt(`payout-${stageId}`, amount) }, at());
    fee += state.transactions.at(-1).feeCents;
  }
  const totals = workflow.ledgerTotals(state);
  assert.equal(totals.releasedCents, 1200000); assert.equal(totals.balanceCents, 0); assert.equal(fee, 36000); assert.equal(totals.realizedFeeCents, 36000);
});

test('a supplementary agreement can be withdrawn before it is fully signed, and a demo contract signs it the demo way', () => {
  let state = signedReal();
  state = act(state, 'owner', 'propose_supplement', { reason: '延长工期', patch: { durationDays: 90 } });
  const id = state.supplements.at(-1).id;
  state = act(state, 'company', 'withdraw_supplement', { supplementId: id });
  assert.equal(state.supplements.at(-1).status, 'withdrawn');
  assert.equal(workflow.effectiveTerms(state).durationDays, 60);
  const again = act(state, 'owner', 'propose_supplement', { reason: '延长工期', patch: { durationDays: 90 } });
  assert.equal(again.supplements.at(-1).number, 2);

  let demo = frozen('demo');
  for (const who of ['owner', 'company', 'boss']) {
    demo = act(demo, who, 'sign_demo', { signerName: who === 'company' ? SIGNERS.company : who, signatureDataUrl: IMG, ...(who === 'company' ? { authorizeSeal: true } : {}) },
      { appliedSignatureDataUrl: IMG, signatureHash: 'd'.repeat(64), ...(who === 'company' ? { profile: { ...PROFILE, sealDataUrl: IMG }, appliedSealDataUrl: IMG, sealHash: 'e'.repeat(64) } : {}) });
  }
  assert.equal(demo.versions.at(-1).status, 'signed_demo');
  demo = act(demo, 'owner', 'propose_supplement', { reason: '延长工期', patch: { durationDays: 90 } });
  const demoId = demo.supplements.at(-1).id;
  demo = act(demo, 'company', 'confirm_supplement', { supplementId: demoId }, { supplementTermsHash: 'c'.repeat(64) });
  assert.throws(() => act(demo, 'owner', 'sign', { signerName: '业主', supplementId: demoId }, { provider: 'test-esign' }), /演示|真实|MODE/);
  for (const who of ['owner', 'company', 'boss']) {
    demo = act(demo, who, 'sign_demo', { signerName: who === 'company' ? SIGNERS.company : who, signatureDataUrl: IMG, supplementId: demoId, ...(who === 'company' ? { authorizeSeal: true } : {}) },
      { appliedSignatureDataUrl: IMG, signatureHash: 'd'.repeat(64), ...(who === 'company' ? { profile: { ...PROFILE, sealDataUrl: IMG }, appliedSealDataUrl: IMG, sealHash: 'e'.repeat(64) } : {}) });
  }
  assert.equal(demo.supplements.at(-1).status, 'signed_demo');
  assert.equal(workflow.effectiveTerms(demo).durationDays, 90);
  const html = workflow.renderWorkflowHtml(workflow.workflowView(demo, ACTORS.owner), demoId);
  assert.match(html, /补充协议/); assert.match(html, /延长工期/); assert.match(html, /产品演示/);
});

// ---------------------------------------------------------------------------------------------------------------
// What the parties are told
// ---------------------------------------------------------------------------------------------------------------

test('the view offers only the actions that make sense for the mode, the role and what is open', () => {
  let state = act(accepted(funded(signedReal(), 1000000), 's1'), 'owner', 'release', { stageId: 's1' }, { provider: 'test-pay' });
  const owner = workflow.workflowView(state, ACTORS.owner), boss = workflow.workflowView(state, ACTORS.boss), company = workflow.workflowView(state, ACTORS.company);
  assert.ok(boss.allowedActions.includes('review_payout'));
  assert.equal(owner.allowedActions.includes('review_payout'), false); assert.equal(company.allowedActions.includes('review_payout'), false);
  assert.ok(owner.allowedActions.includes('cancel_request')); assert.equal(company.allowedActions.includes('cancel_request'), false);
  assert.ok(owner.allowedActions.includes('propose_supplement') && company.allowedActions.includes('propose_supplement'));
  assert.equal(boss.allowedActions.includes('propose_supplement'), false);
  for (const view of [owner, boss, company]) for (const demoOnly of ['sign_demo', 'simulate_fund', 'simulate_release', 'simulate_refund']) assert.equal(view.allowedActions.includes(demoOnly), false);
  assert.equal(owner.reservedCents, 400000); assert.equal(owner.availableCents, 600000);
  assert.ok(boss.todos.some(todo => /复核/.test(todo)));
});

test('the platform is told what on a contract is waiting for it', () => {
  assert.equal(typeof workflow.platformAttention, 'function');
  assert.deepEqual(workflow.platformAttention(baseState()), [], 'nothing before the contract is frozen');
  const frozenKinds = workflow.platformAttention(frozen()).map(x => x.kind);
  assert.deepEqual(frozenKinds, ['platform_signature']);
  let state = signThroughProvider(signThroughProvider(frozen(), 'owner'), 'company');
  state = act(state, 'boss', 'sign', { signerName: SIGNERS.boss }, { provider: 'test-esign' });
  assert.deepEqual(workflow.platformAttention(state), [], 'the platform has already asked to sign');
  state = act(accepted(funded(signedReal(), 1000000), 's1'), 'owner', 'release', { stageId: 's1' }, { provider: 'test-pay' });
  let items = workflow.platformAttention(state);
  assert.deepEqual(items.map(x => x.kind), ['payout_review']); assert.equal(items[0].orderId, 1); assert.match(items[0].detail, /4000\.00/);
  state = act(state, 'owner', 'cancel_request', { requestId: last(state).id });
  state = act(state, 'company', 'open_dispute', { stageId: 's1', reason: '有争议' });
  state = workflow.recordReconciliation(state, ACTORS.boss, workflow.reconcileWorkflow(state, {}), at());
  assert.deepEqual(workflow.platformAttention(state).map(x => x.kind).sort(), ['dispute', 'reconciliation']);
  // A receipt that could not be recorded is something the platform has to look at.
  let held = act(signedReal(), 'owner', 'fund', { amountCents: 500000 }, { provider: 'test-pay' });
  held = workflow.providerRequestSent(held, last(held).id, { provider: 'test-pay', externalId: 'fund-1' }, at());
  held = workflow.settleProviderRequest(held, last(held).id, { payment: payReceipt('fund-1', 1) }, at());
  assert.deepEqual(workflow.platformAttention(held).map(x => x.kind), ['provider_check']);
});

test('a provider that is missing its name or a required method is refused when it is registered', () => {
  assert.throws(() => providers.registerContractProviders({ signing: { name: 'x', createSignRequest: async () => ({}) } }), /fetchResult/);
  assert.throws(() => providers.registerContractProviders({ payment: { createPayment: async () => ({}), fetchPayment: async () => null } }), /name/);
  assert.throws(() => providers.registerContractProviders({ payment: { name: ' ', createPayment: async () => ({}), fetchPayment: async () => null } }), /name/);
  assert.equal(providers.getContractProviders().signing, undefined); assert.equal(providers.getContractProviders().payment, undefined);
});

test('the provider registry starts empty and hands back exactly what a deployment registered', () => {
  assert.equal(typeof providers.registerContractProviders, 'function');
  const before = providers.getContractProviders();
  assert.equal(before.signing, undefined); assert.equal(before.payment, undefined);
  const signing = { name: 'x', createSignRequest: async () => ({}), fetchResult: async () => null };
  providers.registerContractProviders({ signing });
  assert.equal(providers.getContractProviders().signing, signing);
  assert.equal(providers.getContractProviders().payment, undefined);
  providers.registerContractProviders({ signing: undefined });
  assert.equal(providers.getContractProviders().signing, undefined);
});
