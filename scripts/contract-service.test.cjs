// Real contracts at the service level: a real (temporary) database and the real workflow service, with an in-memory
// provider written for this test. Nothing here is a real e-signature or payment provider and nothing leaves the process.
// It covers what the pure domain tests cannot: handing requests to a provider, fetching receipts, callbacks, timeouts,
// concurrency, reconciliation, the platform's to-do list, and a demo supplement through the storage layer.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const dir = path.join(__dirname, '.contract-service');
fs.mkdirSync(dir, { recursive: true });
for (const name of fs.readdirSync(path.join(__dirname, '../packages/shared/src')).filter(f => f.endsWith('.ts'))) {
  fs.writeFileSync(path.join(dir, name.replace(/\.ts$/, '.js')), ts.transpileModule(
    fs.readFileSync(path.join(__dirname, '../packages/shared/src', name), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText);
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yushe-contract-service-'));
process.env.IRENO_PGLITE_DIR = dataDir;
process.env.RUNNER_ENABLED = 'false';
delete process.env.CONTRACT_MODE; // new contracts are real unless a test says otherwise
process.env.CONTRACT_PROVIDER_TIMEOUT_MS = '300';
const db = require('./.contract-service/db.js');
const domain = require('./.contract-service/workflow.js');
const service = require('./.contract-service/workflow-db.js');
const registry = require('./.contract-service/contract-providers.js');
const sharp = require('sharp');
const { eq } = require('drizzle-orm');

test('membership retries preserve purchase identity and isolate copied legacy records', async () => {
  const company = await db.createUser({ role: 'company', name: '支付隔离合成公司' });
  const legacy = await db.getOrCreateOnlinePayment(company.id, null);
  const intent = { user_id: `new-company-${company.id}`, sku_id: 'actual-sku', callback_url: 'https://example.com:8443/contractor?payment_return=1', keyPrefix: 'new-membership-' };
  const [first, second] = await Promise.all([db.getOrCreateOnlinePayment(company.id, null, intent), db.getOrCreateOnlinePayment(company.id, null, intent)]);
  assert.notEqual(first.id, legacy.id);
  assert.equal(first.id, second.id);
  const retry = await db.getOrCreateOnlinePayment(company.id, null, { ...intent, sku_id: 'changed', callback_url: 'https://changed.example/' });
  assert.deepEqual(retry.purchaseIntent, first.purchaseIntent);
  assert.equal(retry.purchaseIntent.idempotency_key, `new-membership-${first.id}`);
  await db.observeOnlinePayments(company.id, '2099-01-01T00:00:00Z', intent.user_id);
  const rows = await db.listMembershipPayments(company.id);
  assert.equal(rows.find(x => x.id === legacy.id).status, 'pending');
  assert.equal(rows.find(x => x.id === first.id).status, 'entitlement_confirmed');
});

test('payment refunds follow the provider: only PAID can be refunded, the platform decision is recorded, and only REFUNDED closes it', async () => {
  const company = await db.createUser({ role: 'company', name: '退款合成公司' });
  const other = await db.createUser({ role: 'company', name: '另一家合成公司' });
  const intent = { user_id: 'refund-company-' + company.id, sku_id: 'actual-sku', callback_url: 'https://example.com:8443/contractor?payment_return=1', keyPrefix: 'refund-membership-' };
  const payment = await db.getOrCreateOnlinePayment(company.id, null, intent);
  const snap = (status, checkedAt) => ({ status, tradeNo: status === 'PAID' || status === 'REFUNDED' ? 'T-1' : null, checkedAt, fetchedAt: checkedAt || '2026-11-15T00:00:00.000Z', source: checkedAt ? 'ALIPAY_PURCHASE_QUERY_V3' : null });
  const refundError = async (run, code) => assert.rejects(run, e => e instanceof db.PaymentRefundError && e.code === code);

  await refundError(db.requestPaymentRefund(company.id, payment.id, '不想继续使用了'), 'NOT_PAID');
  await db.recordPaymentTransaction(payment.id, snap('PENDING', '2026-11-15T01:00:00.000Z'));
  await refundError(db.requestPaymentRefund(company.id, payment.id, '不想继续使用了'), 'NOT_PAID');
  await db.recordPaymentTransaction(payment.id, snap('UNKNOWN', null));
  await refundError(db.requestPaymentRefund(company.id, payment.id, '不想继续使用了'), 'NOT_PAID');

  await db.recordPaymentTransaction(payment.id, snap('PAID', '2026-11-15T02:00:00.000Z'));
  await refundError(db.requestPaymentRefund(other.id, payment.id, '不想继续使用了'), 'NOT_FOUND');
  await refundError(db.requestPaymentRefund(company.id, payment.id, '短'), 'INVALID_REASON');
  const [a, b] = await Promise.allSettled([db.requestPaymentRefund(company.id, payment.id, '不想继续使用了'), db.requestPaymentRefund(company.id, payment.id, '不想继续使用了')]);
  assert.equal([a, b].filter(x => x.status === 'fulfilled').length, 1);
  await refundError(db.decidePaymentRefund(payment.id, 'approve', '同'.repeat(1)), 'INVALID_NOTE');

  await db.withdrawPaymentRefund(company.id, payment.id);
  await refundError(db.withdrawPaymentRefund(company.id, payment.id), 'NOT_REQUESTED');
  await refundError(db.decidePaymentRefund(payment.id, 'approve', '已核对'), 'NOT_REQUESTED');
  await db.requestPaymentRefund(company.id, payment.id, '重新申请，原因同前');
  await db.decidePaymentRefund(payment.id, 'reject', '不符合退款条件');
  await db.requestPaymentRefund(company.id, payment.id, '再次申请退款');
  await db.decidePaymentRefund(payment.id, 'approve', '同意，已在支付宝处理');
  await refundError(db.requestPaymentRefund(company.id, payment.id, '重复申请退款'), 'REFUND_IN_PROGRESS');
  await refundError(db.withdrawPaymentRefund(company.id, payment.id), 'NOT_REQUESTED');

  let row = (await db.listMembershipPayments(company.id)).find(x => x.id === payment.id);
  assert.equal(row.refund.status, 'approved');
  assert.notEqual(row.status, 'refunded', 'an approval alone never counts as refunded');

  await db.recordPaymentTransaction(payment.id, snap('PAID', '2026-11-15T01:30:00.000Z'));
  row = (await db.listMembershipPayments(company.id)).find(x => x.id === payment.id);
  assert.equal(row.transactionSnapshot.checkedAt, '2026-11-15T02:00:00.000Z', 'an older reading never replaces a newer one');

  await db.recordPaymentTransaction(payment.id, snap('REFUNDED', '2026-11-15T03:00:00.000Z'));
  row = (await db.listMembershipPayments(company.id)).find(x => x.id === payment.id);
  assert.equal(row.refund.status, 'refunded');
  assert.equal(row.status, 'refunded');
  assert.equal(row.refund.confirmedAt, '2026-11-15T03:00:00.000Z');
  assert.deepEqual(row.refund.history.map(h => h.action), ['request', 'withdraw', 'request', 'reject', 'request', 'approve', 'refunded']);
  await db.recordPaymentTransaction(payment.id, snap('PAID', '2026-11-15T04:00:00.000Z'));
  row = (await db.listMembershipPayments(company.id)).find(x => x.id === payment.id);
  assert.equal(row.transactionSnapshot.status, 'REFUNDED', 'REFUNDED is final');
  await refundError(db.requestPaymentRefund(company.id, payment.id, '已退款后再申请'), 'NOT_PAID');

  const direct = await db.getOrCreateOnlinePayment(other.id, null, { ...intent, user_id: 'refund-company-' + other.id });
  await db.recordPaymentTransaction(direct.id, snap('REFUNDED', '2026-11-15T05:00:00.000Z'));
  const closed = (await db.listMembershipPayments(other.id)).find(x => x.id === direct.id);
  assert.equal(closed.refund.status, 'refunded', 'a refund made outside this site is still recorded');
  assert.deepEqual(closed.refund.history.map(h => h.actor), ['provider']);
});

let image, sealImage;
before(async () => {
  image = 'data:image/png;base64,' + (await sharp({ create: { width: 120, height: 60, channels: 4, background: { r: 30, g: 60, b: 90, alpha: 1 } } }).png().toBuffer()).toString('base64');
  sealImage = 'data:image/png;base64,' + (await sharp({ create: { width: 180, height: 180, channels: 4, background: { r: 190, g: 35, b: 30, alpha: 0.7 } } }).png().toBuffer()).toString('base64');
});
after(async () => { registry.registerContractProviders({ signing: undefined, payment: undefined }); await (await db.getDb()).$client.close(); fs.rmSync(dataDir, { recursive: true }); });

const party = name => ({ legalName: name, registrationId: 'SYN-001', representative: name, contact: 'SYNTHETIC', address: 'SYNTHETIC' });
const boss = { uid: 0, role: 'boss' };
const SIGNER = { owner: '合成业主', company: '合成授权人', boss: '合成平台授权人' };
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** An in-memory provider the test controls: it can refuse, hang, forget the id, and decide when a party has signed or paid. */
function memoryProviders() {
  const sessions = new Map(), payments = new Map(), calls = { sign: [], pay: [], cancel: [] };
  let seq = 0;
  const trouble = self => { if (self.hang) return new Promise(() => {}); if (self.failWith) { const m = self.failWith; self.failWith = null; throw new Error(m); } return null; };
  const signing = { name: 'memory-esign', hang: false, failWith: null, forgetId: false,
    async createSignRequest(input) {
      calls.sign.push(input); const t = trouble(this); if (t) return t;
      if (this.forgetId) return { signUrl: 'https://esign.memory.invalid/none' };
      const existing = [...sessions.values()].find(s => s.requestId === input.requestId);
      if (existing) return { externalId: existing.externalId, signUrl: existing.signUrl };
      const externalId = `ms-${crypto.randomUUID()}-${++seq}`, signUrl = `https://esign.memory.invalid/${externalId}`;
      sessions.set(externalId, { externalId, signUrl, requestId: input.requestId, input, done: false, extra: {} });
      return { externalId, signUrl };
    },
    async fetchResult(externalId) {
      const s = sessions.get(externalId); if (!s || !s.done) return null;
      return { provider: this.name, externalId, receiptId: `r-${externalId}`, signerVerified: true, organizationVerified: s.input.signer.organization ? true : undefined,
        signerName: s.input.signer.name, termsHash: s.input.termsHash, signedAt: new Date().toISOString(), evidenceHash: 'e'.repeat(64), ...s.extra };
    },
    async verifyCallback(input) { return input.headers['x-token'] === 'good' ? { externalId: JSON.parse(input.body).externalId } : null; } };
  const payment = { name: 'memory-pay', hang: false, failWith: null, down: false, canCancel: false,
    async createPayment(input) {
      calls.pay.push(input); const t = trouble(this); if (t) return t;
      const existing = [...payments.values()].find(p => p.input.idempotencyKey === input.idempotencyKey);
      if (existing) return { externalId: existing.externalId };
      const externalId = `mp-${crypto.randomUUID()}-${++seq}`; payments.set(externalId, { externalId, input, status: 'pending' });
      return { externalId, ...(input.kind === 'fund' ? { payUrl: `https://pay.memory.invalid/${externalId}` } : {}) };
    },
    async fetchPayment(externalId) {
      if (this.down) throw new Error('provider is down');
      const p = payments.get(externalId); if (!p) return null;
      return { provider: this.name, externalId, receiptId: `p-${externalId}`, status: p.status, amountCents: p.amount ?? p.input.amountCents,
        confirmedAt: new Date().toISOString(), reconciled: p.status === 'succeeded', ...(p.input.kind === 'release' ? { feeCents: p.input.platformFeeCents } : {}) };
    },
    async cancelPayment(externalId) { calls.cancel.push(externalId); const p = payments.get(externalId); if (!this.canCancel || !p || p.status !== 'pending') return false; p.status = 'failed'; return true; } };
  return { signing, payment, sessions, payments, calls };
}

let fixtureNo = 0;
async function fixture(mode) {
  const n = ++fixtureNo;
  if (mode === 'demo') process.env.CONTRACT_MODE = 'demo'; else delete process.env.CONTRACT_MODE;
  const owner = await db.createUser({ role: 'homeowner', name: '合成业主', phone: `1990001${String(n).padStart(4, '0')}` });
  const company = await db.createUser({ role: 'company', name: '合成联系人', companyName: '合成装修公司' });
  const other = await db.createUser({ role: 'company', name: '无关公司' });
  await db.setUserVerified(company.id, 1);
  await db.setCompanyMembership(company.id, { membershipStatus: 'active', membershipExpiresAt: new Date(Date.now() + 86400000).toISOString() });
  const p = await db.createProject({ homeownerId: owner.id, name: `合成项目 ${n}`, style: '现代简约', area: '100', budget: '10', address: 'SYNTHETIC' });
  await db.upsertResult(p.id, 'quote', { total: 100000, items: [{ item: '施工', qty: 100, unit: '㎡', price: 1000, total: 100000 }] });
  const order = await db.createOrder({ projectId: p.id, homeownerId: owner.id });
  await db.createBid({ orderId: order.id, companyId: company.id, companyName: '合成装修公司', amount: '10', weeks: '8' });
  await db.selectOrderCompany(order.id, company.id);
  const actors = { owner: { uid: owner.id, role: 'homeowner' }, company: { uid: company.id, role: 'company' }, other: { uid: other.id, role: 'company' }, boss };
  const f = { order, actors, seq: 0, view: await service.getOrderWorkflow(order.id, actors.owner) };
  delete process.env.CONTRACT_MODE;
  f.act = async (who, action, payload = {}) => f.view = await service.actOnOrderWorkflow(order.id, actors[who], {
    action, expectedRevision: (await service.getOrderWorkflow(order.id, actors[who])).revision, requestKey: `request-${order.id}-${++f.seq}`, payload });
  f.refresh = async (who = 'owner') => f.view = await service.getOrderWorkflow(order.id, actors[who]);
  f.last = () => (f.view.providerRequests ?? []).at(-1);
  return f;
}
async function frozen(f, withSeal = false) {
  await service.putContractProfile(f.actors.company, { party: party('合成装修公司'), authorizedSignerName: SIGNER.company, ...(withSeal ? { sealDataUrl: sealImage } : {}) });
  await f.act('company', 'revise', { patch: { company: party('合成装修公司'), scope: '合成范围', durationDays: 56 } });
  await f.act('owner', 'revise', { patch: { homeowner: party('合成业主'), areaBasis: '套内面积' } });
  await f.act('boss', 'revise', { patch: { platform: party('合成平台'), feeBps: 300 } });
  await f.act('company', 'company_confirm'); await f.act('owner', 'homeowner_accept'); await f.act('owner', 'freeze');
  assert.equal(f.view.status, 'frozen');
  return f;
}
/** One party signs: the service opens the session with the provider, the test plays the signer, a sync records the receipt. */
async function signVia(f, providers, who, extra = {}) {
  await f.act(who, 'sign', { signerName: SIGNER[who], ...extra });
  const request = f.last(); assert.equal(request.status, 'pending', request.failure);
  providers.sessions.get(request.externalId).done = true;
  await service.syncProviderRequests(f.order.id);
  return request;
}
async function signedReal(providers) {
  const f = await frozen(await fixture());
  for (const who of ['owner', 'company', 'boss']) await signVia(f, providers, who);
  await f.refresh(); assert.equal(f.view.status, 'signed');
  return f;
}
const pay = async (f, providers, externalId) => { providers.payments.get(externalId).status = 'succeeded'; await service.syncProviderRequests(f.order.id); return f.refresh(); };
async function fund(f, providers, amountCents) { await f.act('owner', 'fund', { amountCents }); return pay(f, providers, f.last().externalId); }
async function accepted(f, stageId) {
  await f.act('company', 'submit_stage', { stageId, evidence: [{ id: `proof-${stageId}`, name: '合成照片', kind: 'reference', url: 'https://example.invalid/a.png' }], note: '合成：完成' });
  await f.act('owner', 'accept_stage', { stageId });
}
async function approvedPayout(f, stageId) {
  await f.act('owner', 'release', { stageId });
  const id = f.last().id;
  await f.act('boss', 'review_payout', { requestId: id, decision: 'approve', note: '合成：已核对' });
  return f.view.providerRequests.find(r => r.id === id);
}

test('with no provider registered, a real contract refuses to sign or move money and records nothing', async () => {
  registry.registerContractProviders({ signing: undefined, payment: undefined });
  const f = await frozen(await fixture());
  assert.equal(f.view.mode, 'real');
  await assert.rejects(f.act('owner', 'sign', { signerName: SIGNER.owner }), error => error.code === 'PROVIDER_NOT_CONFIGURED' && error.status === 503);
  await assert.rejects(f.act('owner', 'sign_demo', { signerName: SIGNER.owner, signatureDataUrl: image }), error => error.code === 'MODE_MISMATCH');
  await f.refresh();
  assert.equal(f.view.current.signatures.length, 0); assert.deepEqual(f.view.providerRequests, []);
  await assert.rejects(service.reconcileOrderWorkflow(f.order.id, boss), error => error.code === 'PROVIDER_NOT_CONFIGURED');
});

test('signing goes to the provider, the link is private, and only the provider receipt becomes a signature', async () => {
  const providers = memoryProviders(); registry.registerContractProviders(providers);
  const f = await frozen(await fixture());
  await f.act('owner', 'sign', { signerName: SIGNER.owner });
  const request = f.last();
  assert.equal(request.status, 'pending'); assert.equal(request.provider, 'memory-esign'); assert.match(request.actionUrl, /^https:\/\/esign\.memory\.invalid\//);
  assert.equal(f.view.current.signatures.length, 0, 'opening a session is not a signature');
  const sent = providers.calls.sign.at(-1);
  assert.equal(sent.requestId, request.id); assert.equal(sent.termsHash, f.view.current.termsHash); assert.equal(sent.signer.name, SIGNER.owner);
  assert.equal(sent.signer.organization, false); assert.equal(sent.signer.party.legalName, '合成业主');
  for (const who of ['company', 'boss']) assert.equal((await service.getOrderWorkflow(f.order.id, f.actors[who])).providerRequests.at(-1).actionUrl, undefined);
  await service.syncProviderRequests(f.order.id); await f.refresh();
  assert.equal(f.view.current.signatures.length, 0, 'the party has not finished on the provider page');
  providers.sessions.get(request.externalId).done = true;
  await Promise.all([service.syncProviderRequests(f.order.id), service.syncProviderRequests(f.order.id), service.syncOrderWorkflow(f.order.id, f.actors.company)]);
  await f.refresh();
  assert.equal(f.view.current.signatures.length, 1, 'three syncs at once still record one signature');
  assert.equal(f.view.current.signatures[0].evidence.receiptId, `r-${request.externalId}`); assert.equal(f.view.status, 'partially_signed');
  await signVia(f, providers, 'company'); await signVia(f, providers, 'boss'); await f.refresh();
  assert.equal(f.view.status, 'signed');
  assert.equal(providers.calls.sign.at(-1).signer.organization, true);
  const html = domain.renderWorkflowHtml(f.view);
  assert.equal(f.view.current.finalFileHash, sha(html), 'the file digest is fixed when the last receipt arrives');
  assert.equal(/演示/.test(html), false);
  await assert.rejects(service.syncOrderWorkflow(f.order.id, f.actors.other), /无权/);
});

test('a provider that refuses, forgets the id or never answers does not leave a signature or an incoming payment stuck', async () => {
  const providers = memoryProviders(); registry.registerContractProviders(providers);
  const f = await frozen(await fixture());
  providers.signing.failWith = 'maintenance window';
  await f.act('owner', 'sign', { signerName: SIGNER.owner });
  assert.equal(f.last().status, 'failed'); assert.match(f.last().failure, /maintenance window/);
  providers.signing.forgetId = true;
  await f.act('owner', 'sign', { signerName: SIGNER.owner });
  assert.equal(f.last().status, 'failed'); assert.match(f.last().failure, /外部单号/);
  providers.signing.forgetId = false; providers.signing.hang = true;
  const started = Date.now();
  await f.act('owner', 'sign', { signerName: SIGNER.owner });
  assert.ok(Date.now() - started < 5000, 'the request must come back');
  assert.equal(f.last().status, 'failed'); assert.match(f.last().failure, /没有响应/);
  providers.signing.hang = false;
  await signVia(f, providers, 'owner'); await f.refresh();
  assert.equal(f.view.current.signatures.length, 1, 'after the provider recovers the party can sign');
  assert.equal(f.view.providerRequests.filter(r => r.status === 'failed').length, 3);
});

test('money in: the checkout is recorded only when the provider confirms it, once', async () => {
  const providers = memoryProviders(); registry.registerContractProviders(providers);
  const f = await signedReal(providers);
  const total = f.view.current.terms.totalCents;
  await f.act('owner', 'fund', { amountCents: total });
  const request = f.last();
  assert.equal(request.status, 'pending'); assert.match(request.actionUrl, /^https:\/\/pay\.memory\.invalid\//);
  assert.equal(providers.calls.pay.at(-1).payer.legalName, '合成业主'); assert.equal(providers.calls.pay.at(-1).idempotencyKey, request.id);
  assert.equal(f.view.fundedCents, 0);
  await assert.rejects(f.act('owner', 'fund', { amountCents: 1 }), /合同总价/);
  providers.payments.get(request.externalId).status = 'succeeded';
  await Promise.all([service.syncProviderRequests(f.order.id), service.syncProviderRequests(f.order.id)]);
  await f.refresh();
  assert.equal(f.view.fundedCents, total); assert.equal(f.view.transactions.length, 1); assert.equal(f.view.transactions[0].receipt.provider, 'memory-pay');
});

test('a payout is sent only after the platform review, with the payee and the fee split, and is recorded from the receipt', async () => {
  const providers = memoryProviders(); registry.registerContractProviders(providers);
  const f = await signedReal(providers);
  await fund(f, providers, f.view.current.terms.totalCents);
  const [first] = f.view.effective.stages;
  await accepted(f, first.id);
  const before = providers.calls.pay.length;
  await f.act('owner', 'release', { stageId: first.id });
  assert.equal(f.last().status, 'awaiting_review'); assert.equal(providers.calls.pay.length, before, 'nothing goes to the provider before the review');
  assert.deepEqual((await service.listPlatformAttention()).filter(x => x.orderId === f.order.id).map(x => x.kind), ['payout_review']);
  await assert.rejects(f.act('company', 'review_payout', { requestId: f.last().id, decision: 'approve', note: '越权' }), error => error.status === 403);
  const id = f.last().id;
  await f.act('boss', 'review_payout', { requestId: id, decision: 'approve', note: '合成：验收与余额已核对' });
  const sent = providers.calls.pay.at(-1), request = f.view.providerRequests.find(r => r.id === id);
  assert.equal(request.status, 'pending');
  assert.equal(sent.kind, 'release'); assert.equal(sent.amountCents, first.amountCents); assert.equal(sent.platformFeeCents, Math.round(first.amountCents * 0.03));
  assert.equal(sent.payee.legalName, '合成装修公司'); assert.equal(sent.stageId, first.id);
  await pay(f, providers, request.externalId);
  const tx = f.view.transactions.at(-1);
  assert.equal(tx.type, 'release'); assert.equal(tx.feeCents, sent.platformFeeCents); assert.equal(tx.netCents, first.amountCents - sent.platformFeeCents);
  assert.equal(f.view.stages[0].status, 'settled'); assert.equal(f.view.reservedCents, 0);
  assert.deepEqual((await service.listPlatformAttention()).filter(x => x.orderId === f.order.id), []);
});

test('a payout the provider did not clearly accept stays open and is re-sent with the same key, never duplicated', async () => {
  const providers = memoryProviders(); registry.registerContractProviders(providers);
  const f = await signedReal(providers);
  await fund(f, providers, f.view.current.terms.totalCents);
  const [first] = f.view.effective.stages;
  await accepted(f, first.id);
  providers.payment.failWith = 'gateway timeout';
  const request = await approvedPayout(f, first.id);
  assert.equal(request.status, 'creating', 'money going out is not written off as failed: the provider may have created it');
  assert.match(request.failure, /gateway timeout/); assert.equal(f.view.reservedCents, first.amountCents);
  assert.deepEqual((await service.listPlatformAttention()).filter(x => x.orderId === f.order.id).map(x => x.kind), ['provider_check']);
  await service.syncProviderRequests(f.order.id); await f.refresh();
  const resent = f.view.providerRequests.find(r => r.id === request.id);
  assert.equal(resent.status, 'pending');
  assert.deepEqual(providers.calls.pay.slice(-2).map(c => c.idempotencyKey), [request.id, request.id]);
  assert.equal([...providers.payments.values()].filter(p => p.input.kind === 'release').length, 1);
});

test('a refund is reviewed, tells the provider which payments it relates to, and is recorded from the receipt', async () => {
  const providers = memoryProviders(); registry.registerContractProviders(providers);
  const f = await signedReal(providers);
  await fund(f, providers, f.view.current.terms.totalCents);
  const funding = f.view.transactions[0].receipt.externalId;
  await f.act('owner', 'refund', { amountCents: 100000, reason: '合成：协商退款' });
  const id = f.last().id; assert.equal(f.last().status, 'awaiting_review');
  await f.act('boss', 'review_payout', { requestId: id, decision: 'approve', note: '合成：双方已确认' });
  const sent = providers.calls.pay.at(-1);
  assert.equal(sent.kind, 'refund'); assert.equal(sent.payee.legalName, '合成业主'); assert.deepEqual(sent.relatedExternalIds, [funding]); assert.equal(sent.reason, '合成：协商退款');
  await pay(f, providers, f.view.providerRequests.find(r => r.id === id).externalId);
  assert.equal(f.view.refundedCents, 100000); assert.equal(f.view.transactions.at(-1).reason, '合成：协商退款');
});

test('a dispute stops a payout the provider can still stop, and leaves on hold one it cannot', async () => {
  const providers = memoryProviders(); registry.registerContractProviders(providers);
  const f = await signedReal(providers);
  await fund(f, providers, f.view.current.terms.totalCents);
  const [first, second] = f.view.effective.stages;
  await accepted(f, first.id); await accepted(f, second.id);
  const one = await approvedPayout(f, first.id), two = await approvedPayout(f, second.id);
  providers.payment.canCancel = true;
  await f.act('company', 'open_dispute', { stageId: first.id, reason: '合成争议' });
  assert.deepEqual(providers.calls.cancel, [one.externalId], 'only the disputed stage is stopped');
  let stopped = f.view.providerRequests.find(r => r.id === one.id);
  assert.equal(stopped.status, 'cancelled'); assert.match(stopped.failure, /撤回/);
  assert.equal(f.view.stages[0].status, 'accepted'); assert.equal(f.view.transactions.filter(t => t.type === 'release').length, 0);
  assert.equal(f.view.providerRequests.find(r => r.id === two.id).status, 'pending');
  providers.payment.canCancel = false;
  await f.act('owner', 'open_dispute', { stageId: second.id, reason: '合成争议二' });
  const held = f.view.providerRequests.find(r => r.id === two.id);
  assert.equal(held.status, 'pending'); assert.ok(held.hold, 'the provider could not stop it, so it is on hold, not shown as frozen');
  const dispute = f.view.disputes.find(d => d.stageId === second.id);
  await assert.rejects(f.act('boss', 'resolve_dispute', { disputeId: dispute.id, independentParty: '合成调解方', basis: '依据', outcome: '解除', disposition: 'cancel_stage' }), error => error.code === 'PAYOUT_IN_FLIGHT');
  await pay(f, providers, two.externalId);
  assert.equal(f.view.stages[1].status, 'settled', 'it went through after all: the fact is recorded');
  assert.equal(f.view.disputes.find(d => d.stageId === second.id).status, 'open');
});

test('a payout on hold that never reached the provider is not sent while the dispute is open', async () => {
  const providers = memoryProviders(); registry.registerContractProviders(providers);
  const f = await signedReal(providers);
  await fund(f, providers, f.view.current.terms.totalCents);
  const [first] = f.view.effective.stages;
  await accepted(f, first.id);
  providers.payment.failWith = 'network';
  const request = await approvedPayout(f, first.id);
  assert.equal(request.status, 'creating');
  await f.act('company', 'open_dispute', { stageId: first.id, reason: '合成争议' });
  const calls = providers.calls.pay.length;
  await service.syncProviderRequests(f.order.id); await f.refresh();
  assert.equal(providers.calls.pay.length, calls, 'nothing new leaves during a dispute');
  assert.equal(f.view.providerRequests.find(r => r.id === request.id).status, 'creating');
  await f.act('boss', 'resolve_dispute', { disputeId: f.view.disputes[0].id, independentParty: '合成调解方', basis: '依据', outcome: '继续履约' });
  await service.syncProviderRequests(f.order.id); await f.refresh();
  assert.equal(f.view.providerRequests.find(r => r.id === request.id).status, 'pending', 'once the dispute is resolved to continue, it is sent');
});

test('reconciliation is the platform reading the provider records again; it reports differences and changes no amount', async () => {
  const providers = memoryProviders(); registry.registerContractProviders(providers);
  const f = await signedReal(providers);
  const total = f.view.current.terms.totalCents;
  await fund(f, providers, total);
  let view = await service.reconcileOrderWorkflow(f.order.id, boss);
  assert.equal(view.reconciliation.ok, true); assert.equal(view.reconciliation.checked, 1);
  await assert.rejects(service.reconcileOrderWorkflow(f.order.id, f.actors.owner), error => error.status === 403);
  providers.payments.get(view.transactions[0].receipt.externalId).amount = total - 1;
  view = await service.reconcileOrderWorkflow(f.order.id, boss);
  assert.equal(view.reconciliation.ok, false); assert.match(view.reconciliation.mismatches[0].reason, /金额/); assert.equal(view.fundedCents, total);
  assert.deepEqual((await service.listPlatformAttention()).filter(x => x.orderId === f.order.id).map(x => x.kind), ['reconciliation']);
  providers.payment.down = true; const revision = view.revision;
  await assert.rejects(service.reconcileOrderWorkflow(f.order.id, boss), error => error.code === 'PROVIDER_UNAVAILABLE' && error.status === 503);
  assert.equal((await f.refresh('boss')).revision, revision, 'an unreachable provider records nothing');
});

test('a verified callback only points the server at a session; an unverified or unknown one is refused', async () => {
  const providers = memoryProviders(); registry.registerContractProviders(providers);
  const f = await frozen(await fixture());
  await f.act('owner', 'sign', { signerName: SIGNER.owner });
  const { externalId } = f.last();
  assert.equal(await service.findOrderByProviderReference(externalId), f.order.id);
  assert.equal(await service.findOrderByProviderReference('no-such-session'), null);
  assert.equal(await service.findOrderByProviderReference("x' OR '1'='1"), null);
  const body = JSON.stringify({ externalId, signerVerified: true, forged: 'a callback body is never a receipt' });
  await assert.rejects(service.handleProviderCallback('signing', { headers: { 'x-token': 'bad' }, body }), error => error.code === 'INVALID_CALLBACK' && error.status === 401);
  await assert.rejects(service.handleProviderCallback('signing', { headers: { 'x-token': 'good' }, body: JSON.stringify({ externalId: 'no-such-session' }) }), error => error.status === 404);
  await assert.rejects(service.handleProviderCallback('signing', { headers: { 'x-token': 'good' }, body: 'not json' }), error => error.status === 401);
  await service.handleProviderCallback('signing', { headers: { 'x-token': 'good' }, body });
  assert.equal((await f.refresh()).current.signatures.length, 0, 'the provider says the party has not signed, whatever the callback body claims');
  providers.sessions.get(externalId).done = true;
  assert.deepEqual(await service.handleProviderCallback('signing', { headers: { 'x-token': 'good' }, body }), { orderId: f.order.id });
  assert.equal((await f.refresh()).current.signatures.length, 1);
  await assert.rejects(service.handleProviderCallback('payment', { headers: { 'x-token': 'good' }, body }), error => error.status === 404, 'the payment provider here has no callback check');
});

test('callbacks distinguish providers that reuse an external id and reject ambiguous references', async () => {
  const fixtures = [];
  for (const name of ['isolated-esign-a', 'isolated-esign-b']) {
    const providers = memoryProviders(); providers.signing.name = name;
    const create = providers.signing.createSignRequest.bind(providers.signing);
    providers.signing.createSignRequest = async input => {
      const result = await create(input), session = providers.sessions.get(result.externalId);
      session.externalId = 'shared-session-number'; session.done = true;
      providers.sessions.set(session.externalId, session);
      return { ...result, externalId: session.externalId };
    };
    registry.registerContractProviders(providers);
    const f = await frozen(await fixture());
    await f.act('owner', 'sign', { signerName: SIGNER.owner });
    fixtures.push({ f, providers });
  }
  const callback = { headers: { 'x-token': 'good' }, body: JSON.stringify({ externalId: 'shared-session-number' }) };
  assert.deepEqual(await service.handleProviderCallback('signing', callback), { orderId: fixtures[1].f.order.id });
  assert.equal((await fixtures[1].f.refresh()).current.signatures.length, 1);
  assert.equal((await fixtures[0].f.refresh()).current.signatures.length, 0);

  // The same provider claiming the same reference for two contracts is ambiguous: never pick the first row.
  const duplicate = await frozen(await fixture());
  await duplicate.act('owner', 'sign', { signerName: SIGNER.owner });
  await assert.rejects(service.handleProviderCallback('signing', callback), error => error.code === 'AMBIGUOUS_PROVIDER_REFERENCE' && error.status === 409);
  assert.equal((await duplicate.refresh()).current.signatures.length, 0);
});

test('a signing callback cannot also settle a payment with the same provider name and external id', async () => {
  const providers = memoryProviders(); providers.payment.name = providers.signing.name;
  providers.payment.verifyCallback = providers.signing.verifyCallback;
  registry.registerContractProviders(providers);
  const f = await signedReal(providers);
  await f.act('owner', 'fund', { amountCents: 10000 });
  const fundId = f.last().externalId;
  await f.act('company', 'propose_supplement', { reason: '合成：回调隔离验收', patch: { durationDays: 70 } });
  const supplementId = f.view.supplements.at(-1).id;
  await f.act('owner', 'confirm_supplement', { supplementId });
  const create = providers.signing.createSignRequest.bind(providers.signing);
  providers.signing.createSignRequest = async input => {
    const result = await create(input), session = providers.sessions.get(result.externalId);
    session.externalId = fundId; session.done = true;
    providers.sessions.set(fundId, session);
    return { ...result, externalId: fundId };
  };
  await f.act('owner', 'sign', { signerName: SIGNER.owner, supplementId });
  providers.payments.get(fundId).status = 'succeeded';
  const callback = { headers: { 'x-token': 'good' }, body: JSON.stringify({ externalId: fundId }) };
  await service.handleProviderCallback('signing', callback);
  await f.refresh();
  assert.equal(f.view.supplements.at(-1).signatures.length, 1);
  assert.equal(f.view.fundedCents, 0, 'the signing callback must not query or settle money');
  await service.handleProviderCallback('payment', callback);
  assert.equal((await f.refresh()).fundedCents, 10000);
});

test('a provider reusing a signing reference for two parties on one contract is rejected', async () => {
  const providers = memoryProviders(); providers.signing.name = 'duplicate-party-esign';
  const create = providers.signing.createSignRequest.bind(providers.signing);
  providers.signing.createSignRequest = async input => {
    const result = await create(input), session = providers.sessions.get(result.externalId);
    session.externalId = 'same-contract-duplicate'; session.done = true;
    providers.sessions.set(session.externalId, session);
    return { ...result, externalId: session.externalId };
  };
  registry.registerContractProviders(providers);
  const f = await frozen(await fixture());
  await f.act('owner', 'sign', { signerName: SIGNER.owner });
  await f.act('company', 'sign', { signerName: SIGNER.company });
  await assert.rejects(service.handleProviderCallback('signing', { headers: { 'x-token': 'good' }, body: JSON.stringify({ externalId: 'same-contract-duplicate' }) }),
    error => error.code === 'AMBIGUOUS_PROVIDER_REFERENCE' && error.status === 409);
  assert.equal((await f.refresh()).current.signatures.length, 0);
});

test('one order retains independent demo and real contracts, including signatures, money and idempotency', async () => {
  const providers = memoryProviders(); registry.registerContractProviders(providers);
  const f = await frozen(await fixture('demo'));
  await service.putContractProfile(f.actors.company, { party: party('合成装修公司'), authorizedSignerName: SIGNER.company, sealDataUrl: sealImage });
  for (const who of ['owner', 'company', 'boss']) await f.act(who, 'sign_demo', { signerName: SIGNER[who], signatureDataUrl: image, ...(who === 'company' ? { authorizeSeal: true } : {}) });
  await f.act('owner', 'simulate_fund', { amountCents: 10000 });
  const demo = await f.refresh(), demoHash = demo.current.finalFileHash;
  const inMode = (mode, run) => service.withOrderWorkflowMode(f.order.id, f.actors.owner, mode, run);
  const real = await inMode('real', () => service.getOrderWorkflow(f.order.id, f.actors.owner));
  assert.equal(real.mode, 'real'); assert.equal(real.status, 'awaiting_company');
  assert.equal(real.fundedCents, 0); assert.equal(real.current.signatures.length, 0); assert.equal(real.transactions.length, 0);
  assert.notEqual(real.current.contractId, demo.current.contractId);
  const changed = await inMode('real', () => service.actOnOrderWorkflow(f.order.id, f.actors.owner, { action: 'revise', expectedRevision: real.revision, requestKey: 'same-key-in-both-modes', payload: { patch: { areaBasis: '真实合同面积' } } }));
  const demoChanged = await inMode('demo', () => service.actOnOrderWorkflow(f.order.id, f.actors.owner, { action: 'generate_draft', expectedRevision: demo.revision, requestKey: 'same-key-in-both-modes', payload: {} }));
  assert.equal(changed.current.terms.areaBasis, '真实合同面积');
  assert.equal(demoChanged.fundedCents, 10000); assert.equal(demoChanged.current.finalFileHash, demoHash);
  const [againDemo, againReal] = await Promise.all(['demo', 'real'].map(mode => inMode(mode, () => service.getOrderWorkflow(f.order.id, f.actors.owner))));
  assert.equal(againDemo.mode, 'demo'); assert.equal(againReal.mode, 'real');
  assert.equal(againDemo.current.signatures.length, 3); assert.equal(againReal.current.signatures.length, 0);
  assert.equal((await f.refresh()).mode, 'demo', 'legacy callers still see the original contract');
  await assert.rejects(inMode('invalid', () => f.refresh()), error => error.status === 400);
  await assert.rejects(service.withOrderWorkflowMode(f.order.id, { uid: f.actors.owner.uid + 10000, role: 'homeowner' }, 'real', () => f.refresh()), error => error.status === 403);
});

test('provider callbacks reach the real counterpart of a demo order and platform tasks identify its mode', async () => {
  const providers = memoryProviders(); registry.registerContractProviders(providers);
  const f = await frozen(await fixture('demo'));
  const inReal = run => service.withOrderWorkflowMode(f.order.id, f.actors.owner, 'real', run);
  await inReal(() => frozen(f));
  await inReal(() => f.act('owner', 'sign', { signerName: SIGNER.owner }));
  const request = f.last(); providers.sessions.get(request.externalId).done = true;
  await service.handleProviderCallback('signing', { headers: { 'x-token': 'good' }, body: JSON.stringify({ externalId: request.externalId }) });
  assert.equal((await inReal(() => service.getOrderWorkflow(f.order.id, f.actors.owner))).current.signatures.length, 1);
  assert.equal((await f.refresh()).current.signatures.length, 0);
  assert.ok((await service.listPlatformAttention()).some(x => x.orderId === f.order.id && x.mode === 'real'));
});

test('a contract stored before these features existed still opens and works', async () => {
  const providers = memoryProviders(); registry.registerContractProviders(providers);
  const f = await frozen(await fixture());
  const storage = await db.getDb();
  const [row] = await storage.select().from(db.contractWorkflows).where(eq(db.contractWorkflows.orderId, f.order.id));
  const { providerRequests, supplements, reconciliation, ...older } = row.state;
  await storage.update(db.contractWorkflows).set({ state: older }).where(eq(db.contractWorkflows.orderId, f.order.id));
  const view = await f.refresh();
  assert.deepEqual(view.providerRequests, []); assert.equal(view.reservedCents, 0); assert.equal(view.effective.totalCents, view.current.terms.totalCents);
  assert.deepEqual((await service.listPlatformAttention()).filter(x => x.orderId === f.order.id).map(x => x.kind), ['platform_signature']);
  await signVia(f, providers, 'owner');
  assert.equal((await f.refresh()).current.signatures.length, 1);
});

test('a real supplement: proposed, confirmed, signed through the provider, then it replaces the terms in force and has its own file', async () => {
  const providers = memoryProviders(); registry.registerContractProviders(providers);
  const f = await signedReal(providers);
  const signedHash = f.view.current.finalFileHash;
  await f.act('company', 'propose_supplement', { reason: '合成：延长工期', patch: { durationDays: 70 } });
  const id = f.view.supplements.at(-1).id;
  await f.act('owner', 'confirm_supplement', { supplementId: id });
  const frozenSupplement = f.view.supplements.at(-1);
  assert.equal(frozenSupplement.status, 'frozen'); assert.match(frozenSupplement.termsHash, /^[0-9a-f]{64}$/);
  assert.notEqual(frozenSupplement.termsHash, f.view.current.termsHash, 'the supplement has its own digest');
  for (const who of ['owner', 'company', 'boss']) {
    const request = await signVia(f, providers, who, { supplementId: id });
    assert.equal(providers.calls.sign.at(-1).supplement.id, id); assert.equal(providers.calls.sign.at(-1).termsHash, frozenSupplement.termsHash);
    assert.equal(request.supplementId, id);
  }
  await f.refresh();
  const supplement = f.view.supplements.at(-1);
  assert.equal(supplement.status, 'signed'); assert.equal(f.view.effective.durationDays, 70); assert.equal(f.view.current.terms.durationDays, 56);
  assert.equal(supplement.finalFileHash, sha(domain.renderWorkflowHtml(f.view, id)));
  assert.equal(f.view.current.finalFileHash, signedHash); assert.equal(signedHash, sha(domain.renderWorkflowHtml(f.view)), 'the signed contract file is untouched');
});

test('a demo contract signs a supplement the demo way, with a seal bound to that supplement', async () => {
  registry.registerContractProviders({ signing: undefined, payment: undefined });
  const f = await frozen(await fixture('demo'), true);
  assert.equal(f.view.mode, 'demo');
  for (const who of ['owner', 'company', 'boss']) await f.act(who, 'sign_demo', { signerName: SIGNER[who], signatureDataUrl: image, ...(who === 'company' ? { authorizeSeal: true } : {}) });
  assert.equal(f.view.status, 'signed_demo');
  const contractHash = f.view.current.finalFileHash, contractSeal = f.view.current.signatures.find(s => s.role === 'company').sealDataUrl;
  await f.act('owner', 'propose_supplement', { reason: '合成：延长工期', patch: { durationDays: 90 } });
  const id = f.view.supplements.at(-1).id;
  await f.act('company', 'confirm_supplement', { supplementId: id });
  await assert.rejects(f.act('owner', 'sign', { signerName: SIGNER.owner, supplementId: id }), error => error.code === 'MODE_MISMATCH');
  for (const who of ['owner', 'company', 'boss']) await f.act(who, 'sign_demo', { signerName: SIGNER[who], signatureDataUrl: image, supplementId: id, ...(who === 'company' ? { authorizeSeal: true } : {}) });
  const supplement = f.view.supplements.at(-1), companySignature = supplement.signatures.find(s => s.role === 'company');
  assert.equal(supplement.status, 'signed_demo'); assert.equal(f.view.effective.durationDays, 90); assert.equal(f.view.status, 'signed_demo');
  assert.equal(companySignature.sealBinding.contractId, `${f.view.current.contractId}-s1`);
  assert.notEqual(companySignature.sealDataUrl, contractSeal, 'the seal image is derived for the supplement, not copied from the contract');
  assert.notEqual(companySignature.sealDataUrl, sealImage);
  const html = domain.renderWorkflowHtml(f.view, id);
  assert.equal(supplement.finalFileHash, sha(html)); assert.match(html, /产品演示/); assert.match(html, /补充协议 1/);
  assert.equal(f.view.current.finalFileHash, contractHash); assert.equal(contractHash, sha(domain.renderWorkflowHtml(f.view)));
});
