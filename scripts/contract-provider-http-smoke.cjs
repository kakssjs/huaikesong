// Real-contract acceptance over HTTP on an isolated production build: signing, money, payout review, reconciliation,
// supplementary agreements and disputes go through the provider pipeline. The provider is scripts/test-contract-provider.mjs,
// a TEST-ONLY stand-in that stores sessions in a temp JSON file; this script plays the signer and the payer by editing that file.
// Synthetic accounts and data, a new temp database, no CONTRACT_MODE (so contracts are real), no model and no real money.
// Usage: npm run build, then: node scripts/contract-provider-http-smoke.cjs --isolated-demo
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const ts = require('typescript');
if (process.argv[2] !== '--isolated-demo') throw new Error('Explicit --isolated-demo is required');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.CONTRACT_PROVIDER_TEST_PORT || 3324);
const base = `http://127.0.0.1:${port}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yushe-contract-provider-'));
const providerState = path.join(scratch, 'provider.json');
const token = crypto.randomBytes(16).toString('hex');
const compiled = path.join(root, 'scripts', '.contract-provider-http');
fs.mkdirSync(compiled, { recursive: true });
for (const name of fs.readdirSync(path.join(root, 'packages/shared/src')).filter(f => f.endsWith('.ts'))) {
  fs.writeFileSync(path.join(compiled, name.replace(/\.ts$/, '.js')), ts.transpileModule(fs.readFileSync(path.join(root, 'packages/shared/src', name), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText);
}
process.env.IRENO_PGLITE_DIR = path.join(scratch, 'db');
const db = require('./.contract-provider-http/db.js');
const PASSWORD = 'DemoOnly2026!', BOSS_PHONE = '19900000000', BOSS_PASSWORD = crypto.randomBytes(12).toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let server, checks = 0;
const ok = (name, detail = '') => { checks++; console.log('PASS', name, detail); };

async function seed() {
  const salt = crypto.randomBytes(16);
  const passwordHash = `scrypt$${salt.toString('base64')}$${crypto.scryptSync(PASSWORD, salt, 32).toString('base64')}`;
  const owner = await db.createUser({ role: 'homeowner', name: '合成业主', phone: '19900000001', passwordHash });
  const company = await db.createUser({ role: 'company', name: '合成公司联系人', companyName: '合成装修公司', phone: '19900000002', passwordHash, license: 'SYNTHETIC-LICENSE' });
  await db.createUser({ role: 'homeowner', name: '无关业主', phone: '19900000003', passwordHash });
  await db.setUserVerified(company.id, 1);
  await db.setCompanyMembership(company.id, { membershipStatus: 'active', membershipExpiresAt: '2099-01-01T00:00:00.000Z' });
  const project = await db.createProject({ homeownerId: owner.id, name: '真实合同验收｜合成项目', style: '现代简约', budget: '10', area: '90', address: 'SYNTHETIC-ADDRESS' });
  await db.upsertResult(project.id, 'quote', { total: 100000, items: [{ item: '合成施工项', qty: 1, unit: '项', price: 100000, total: 100000 }] });
  const order = await db.createOrder({ projectId: project.id, homeownerId: owner.id });
  await db.createBid({ orderId: order.id, companyId: company.id, companyName: '合成装修公司', amount: '10', weeks: '8' });
  await db.selectOrderCompany(order.id, company.id);
  await (await db.getDb()).$client.close();
  return order.id;
}

async function startServer() {
  const logFile = fs.openSync(path.join(scratch, 'server.log'), 'a');
  const env = { ...process.env, NODE_ENV: 'production', RUNNER_ENABLED: 'false', COOKIE_SECURE: 'false', SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
    BOSS_PHONE, BOSS_PASSWORD, IRENO_PGLITE_DIR: path.join(scratch, 'db'), IRENO_UPLOAD_DIR: path.join(scratch, 'uploads'), LLM_API_KEY: '', AGNES_API_KEY: '',
    CONTRACT_PROVIDER_MODULE: path.join(root, 'scripts/test-contract-provider.mjs'), CONTRACT_PROVIDER_TEST_ONLY: '1',
    TEST_CONTRACT_PROVIDER_STATE: providerState, TEST_CONTRACT_PROVIDER_TOKEN: token };
  delete env.CONTRACT_MODE;
  server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)],
    { cwd: path.join(root, 'apps/web'), windowsHide: true, stdio: ['ignore', logFile, logFile], env });
  fs.closeSync(logFile);
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw new Error('isolated server exited; see ' + scratch);
    try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
    await sleep(500);
  }
  throw new Error('isolated server did not start');
}

const cookies = {};
async function login(role, phone, password = PASSWORD) {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, password }) });
  assert.equal(r.status, 200, 'login ' + role);
  cookies[role] = r.headers.get('set-cookie').split(';')[0];
}
async function call(role, route, { method = 'GET', body, expected = 200 } = {}) {
  const res = await fetch(base + route, { method, headers: { ...(cookies[role] ? { cookie: cookies[role] } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  assert.equal(res.status, expected, `${method} ${route}: ${String(text).slice(0, 400)}`);
  return json;
}
let orderId;
const wf = role => call(role, `/api/orders/${orderId}/workflow`);
async function act(role, action, payload = {}, expected = 200) {
  const state = await wf(role);
  return call(role, `/api/orders/${orderId}/workflow`, { method: 'POST', body: { action, expectedRevision: state.revision, requestKey: crypto.randomUUID(), payload }, expected });
}
const sync = role => call(role, `/api/orders/${orderId}/workflow/sync`, { method: 'POST' });
const provider = () => JSON.parse(fs.readFileSync(providerState, 'utf8'));
const editProvider = change => { const state = provider(); change(state); fs.writeFileSync(providerState, JSON.stringify(state, null, 2)); };
const signerFinishes = (externalId, extra = {}) => editProvider(s => Object.assign(s.sessions[externalId], { status: 'signed', signedAt: new Date().toISOString() }, extra));
const payerPays = externalId => editProvider(s => Object.assign(s.payments[externalId], { status: 'succeeded', confirmedAt: new Date().toISOString() }));
const lastRequest = view => (view.providerRequests ?? []).at(-1);
const party = (legalName, id, representative) => ({ legalName, registrationId: id, representative, contact: 'SYNTHETIC-CONTACT', address: 'SYNTHETIC-ADDRESS' });
const SIGNER = { owner: '合成业主', company: '合成公司授权人', platform: '合成平台授权人' };

async function signThroughProvider(role, extraPayload = {}, finish = {}) {
  const view = await act(role, 'sign', { signerName: SIGNER[role], ...extraPayload });
  const request = lastRequest(view);
  assert.equal(request.status, 'pending'); assert.match(request.actionUrl, /^https:\/\/esign\.acceptance\.invalid\//);
  signerFinishes(request.externalId, finish);
  return { request, view: await sync(role) };
}

async function run() {
  orderId = await seed();
  await startServer();
  await login('owner', '19900000001'); await login('company', '19900000002'); await login('stranger', '19900000003'); await login('platform', BOSS_PHONE, BOSS_PASSWORD);

  let view = await wf('owner');
  assert.equal(view.mode, 'real'); ok('without CONTRACT_MODE a new contract is real', view.status);
  await call('stranger', `/api/orders/${orderId}/workflow`, { expected: 403 }); ok('an unrelated account cannot read the contract', '403');
  await call('company', '/api/company/contract-profile', { method: 'PUT', body: { party: party('合成装修公司', 'SYN-COMPANY', SIGNER.company), authorizedSignerName: SIGNER.company } });
  await act('owner', 'revise', { patch: { homeowner: party('合成业主', '', '合成业主'), areaBasis: '套内面积', location: 'SYNTHETIC-SITE' } });
  await act('company', 'revise', { patch: { company: party('合成装修公司', 'SYN-COMPANY', SIGNER.company), scope: '合成范围：墙面与地面', durationDays: 56 } });
  await act('platform', 'revise', { patch: { platform: party('合成平台主体', 'SYN-PLATFORM', SIGNER.platform), feeBps: 300 } });
  await act('company', 'company_confirm'); await act('owner', 'homeowner_accept'); await act('owner', 'generate_draft');
  view = await act('owner', 'freeze'); assert.equal(view.status, 'frozen'); ok('confirmed and frozen', view.current.termsHash.slice(0, 12));
  await act('owner', 'sign_demo', { signerName: '合成业主', signatureDataUrl: 'data:image/png;base64,AAAA' }, 400);
  ok('a real contract does not take a demo signature', '400/409, nothing recorded');

  // --- signing through the provider -------------------------------------------------------------
  let { request, view: afterOwner } = await signThroughProvider('owner');
  assert.equal(afterOwner.current.signatures.length, 1); assert.equal(afterOwner.current.signatures[0].evidence.provider, 'acceptance-test-esign');
  ok('owner signs on the provider page; the signature is recorded only from the provider receipt', request.externalId);
  const seenByCompany = (await wf('company')).providerRequests.find(r => r.id === request.id);
  assert.equal(seenByCompany.actionUrl, undefined); ok('the signing link is visible only to the signer');
  await act('company', 'sign', { signerName: '不是授权人' }, 403); ok('the company signer must be its authorised signer', '403');
  ({ request } = await signThroughProvider('company', {}, { organizationVerified: false }));
  view = await wf('company');
  assert.equal(view.current.signatures.length, 1); assert.equal(view.providerRequests.find(r => r.id === request.id).status, 'failed');
  assert.match(view.providerRequests.find(r => r.id === request.id).failure, /主体|授权/);
  ok('a receipt without organisation verification does not count as the company signature');
  await signThroughProvider('company');
  const platformSign = await act('platform', 'sign', { signerName: SIGNER.platform });
  const platformRequest = lastRequest(platformSign);
  signerFinishes(platformRequest.externalId);
  const badCallback = await fetch(base + '/api/contract-providers/signing/callback', { method: 'POST', headers: { 'content-type': 'application/json', 'x-acceptance-token': 'wrong' }, body: JSON.stringify({ externalId: platformRequest.externalId }) });
  assert.equal(badCallback.status, 401); ok('an unverified provider callback is refused', '401');
  const callback = await fetch(base + '/api/contract-providers/signing/callback', { method: 'POST', headers: { 'content-type': 'application/json', 'x-acceptance-token': token }, body: JSON.stringify({ externalId: platformRequest.externalId }) });
  assert.equal(callback.status, 200);
  view = await wf('owner');
  assert.equal(view.status, 'signed'); assert.equal(view.current.signatures.length, 3); assert.match(view.current.finalFileHash, /^[0-9a-f]{64}$/);
  ok('a verified callback makes the server fetch the receipt; all three signed', view.status);
  const htmlRes = await fetch(base + `/api/orders/${orderId}/workflow?format=html`, { headers: { cookie: cookies.owner } });
  const html = await htmlRes.text();
  assert.equal(htmlRes.status, 200); assert.match(htmlRes.headers.get('content-disposition'), /-contract\.html/);
  assert.equal(htmlRes.headers.get('x-contract-artifact-sha256'), crypto.createHash('sha256').update(html).digest('hex'));
  assert.ok(html.includes('acceptance-test-esign')); assert.ok(!/演示|无真实资金/.test(html));
  ok('the signed contract file carries the provider evidence, no demo wording, and matches its SHA-256');
  await act('owner', 'revise', { patch: { area: 100 } }, 409); ok('the signed text is read-only', '409');

  // --- money in and out ---------------------------------------------------------------------------
  view = await act('owner', 'fund', { amountCents: view.current.terms.totalCents });
  const fund = lastRequest(view); assert.equal(fund.status, 'pending'); assert.match(fund.actionUrl, /^https:\/\/pay\.acceptance\.invalid\//);
  assert.equal(view.fundedCents, 0); ok('funding opens a checkout and records nothing yet', fund.externalId);
  payerPays(fund.externalId); view = await sync('owner');
  assert.equal(view.fundedCents, view.current.terms.totalCents); ok('the provider receipt credits the ledger', String(view.fundedCents));
  const [first, second] = view.current.terms.stages;
  const evidence = [{ id: 'proof', kind: 'reference', name: '合成阶段照片', url: 'https://example.invalid/photo.png' }];
  await act('company', 'submit_stage', { stageId: first.id, evidence, note: '合成：第一阶段完成' });
  await act('owner', 'accept_stage', { stageId: first.id });
  view = await act('owner', 'release', { stageId: first.id });
  const payout = lastRequest(view); assert.equal(payout.status, 'awaiting_review'); assert.equal(view.reservedCents, first.amountCents);
  ok('a payout waits for the platform review and reserves the money', String(view.reservedCents));
  await act('company', 'review_payout', { requestId: payout.id, decision: 'approve', note: '公司不能复核' }, 403); ok('only the platform reviews payouts', '403');
  view = await act('platform', 'review_payout', { requestId: payout.id, decision: 'approve', note: '验收与余额已核对（合成）' });
  const sent = view.providerRequests.find(r => r.id === payout.id); assert.equal(sent.status, 'pending'); assert.equal(sent.review.decision, 'approved');
  payerPays(sent.externalId); view = await sync('platform');
  const release = view.transactions.find(t => t.type === 'release');
  assert.equal(release.amountCents, first.amountCents); assert.equal(release.feeCents, Math.round(first.amountCents * 0.03)); assert.equal(view.stages[0].status, 'settled');
  ok('the approved payout is recorded from the receipt with the 3% contractor fee', `fee ${release.feeCents}`);
  view = await call('platform', `/api/orders/${orderId}/workflow/reconcile`, { method: 'POST' });
  assert.equal(view.reconciliation.ok, true); assert.equal(view.reconciliation.checked, 2); ok('reconciliation matches the provider records', '2/2');
  editProvider(s => { s.payments[fund.externalId].reportedAmountCents = 1; });
  view = await call('platform', `/api/orders/${orderId}/workflow/reconcile`, { method: 'POST' });
  assert.equal(view.reconciliation.ok, false); assert.match(view.reconciliation.mismatches[0].reason, /金额/); assert.equal(view.fundedCents, view.current.terms.totalCents);
  ok('a changed provider record shows as a mismatch and no amount is touched');
  editProvider(s => { delete s.payments[fund.externalId].reportedAmountCents; });
  await call('owner', `/api/orders/${orderId}/workflow/reconcile`, { method: 'POST', expected: 403 }); ok('only the platform reconciles', '403');

  // --- supplementary agreement --------------------------------------------------------------------
  view = await act('company', 'propose_supplement', { reason: '合成：业主要求延长工期两周', patch: { durationDays: 70 } });
  const supplement = view.supplements.at(-1); assert.equal(supplement.status, 'proposed');
  view = await act('owner', 'confirm_supplement', { supplementId: supplement.id }); assert.equal(view.supplements.at(-1).status, 'frozen');
  for (const role of ['owner', 'company', 'platform']) await signThroughProvider(role, { supplementId: supplement.id });
  view = await wf('owner');
  assert.equal(view.supplements.at(-1).status, 'signed'); assert.equal(view.effective.durationDays, 70); assert.equal(view.current.terms.durationDays, 56);
  ok('a supplement signed by all three changes the terms in force; the signed contract text is untouched', 'duration 56 -> 70');
  const supRes = await fetch(base + `/api/orders/${orderId}/workflow?format=html&supplement=${supplement.id}`, { headers: { cookie: cookies.company } });
  const supHtml = await supRes.text();
  assert.equal(supRes.status, 200); assert.ok(supHtml.includes('补充协议')); assert.equal(supRes.headers.get('x-contract-artifact-sha256'), crypto.createHash('sha256').update(supHtml).digest('hex'));
  ok('the supplement has its own signed file');

  // --- dispute while a payout is with the provider ------------------------------------------------
  await act('company', 'submit_stage', { stageId: second.id, evidence, note: '合成：第二阶段完成' });
  await act('owner', 'accept_stage', { stageId: second.id });
  view = await act('owner', 'release', { stageId: second.id });
  const payout2 = lastRequest(view);
  view = await act('platform', 'review_payout', { requestId: payout2.id, decision: 'approve', note: '已核对（合成）' });
  view = await act('company', 'open_dispute', { stageId: second.id, reason: '合成争议：工程量待核' });
  const held = view.providerRequests.find(r => r.id === payout2.id); assert.equal(held.status, 'pending'); assert.ok(held.hold);
  ok('a payout already with the provider is put on hold, not shown as frozen');
  const dispute = view.disputes.find(d => d.status === 'open');
  await act('platform', 'resolve_dispute', { disputeId: dispute.id, independentParty: '合成调解方', basis: '合成依据', outcome: '解除本阶段', disposition: 'cancel_stage' }, 409);
  ok('a stage cannot be cancelled while its payout is in flight', '409');
  editProvider(s => { s.payments[held.externalId].status = 'failed'; }); view = await sync('platform');
  assert.equal(view.providerRequests.find(r => r.id === payout2.id).status, 'failed'); assert.equal(view.stages[1].status, 'accepted');
  ok('the provider says the payout failed: nothing is recorded and the stage stays accepted');
  await act('platform', 'resolve_dispute', { disputeId: dispute.id, independentParty: '合成调解方', basis: '合成依据', outcome: '继续履约' });
  ok('the dispute can then be resolved');

  // Refund review and cancellation must release reservations without inventing a payment.
  view = await act('owner', 'refund', { amountCents: 10000, reason: '合成：退回多付金额' });
  let refund = lastRequest(view);
  assert.equal(refund.status, 'awaiting_review'); assert.equal(view.reservedCents, 10000);
  await act('company', 'review_payout', { requestId: refund.id, decision: 'approve', note: '越权测试' }, 403);
  view = await act('platform', 'review_payout', { requestId: refund.id, decision: 'reject', note: '合成：资料待补齐' });
  assert.equal(view.reservedCents, 0); assert.equal(view.refundedCents, 0);
  ok('rejected refund releases the reservation without moving funds');
  view = await act('owner', 'refund', { amountCents: 10000, reason: '合成：补齐退款依据' });
  refund = lastRequest(view);
  view = await act('owner', 'cancel_request', { requestId: refund.id });
  assert.equal(view.reservedCents, 0); assert.equal(view.refundedCents, 0);
  ok('owner can withdraw an unreviewed refund without moving funds');
  view = await act('owner', 'refund', { amountCents: 10000, reason: '合成：退款确认' });
  refund = lastRequest(view);
  view = await act('platform', 'review_payout', { requestId: refund.id, decision: 'approve', note: '合成：退款依据已核对' });
  const sentRefund = view.providerRequests.find(r => r.id === refund.id);
  assert.equal(view.refundedCents, 0); assert.equal(sentRefund.status, 'pending');
  payerPays(sentRefund.externalId); view = await sync('platform');
  assert.equal(view.refundedCents, 10000); assert.equal(view.balanceCents, 7990000); assert.equal(view.reservedCents, 0);
  await sync('platform'); view = await wf('owner');
  assert.equal(view.refundedCents, 10000);
  ok('refund records only a successful provider receipt and repeated sync does not double-refund');
  view = await call('platform', `/api/orders/${orderId}/workflow/reconcile`, { method: 'POST' });
  assert.equal(view.reconciliation.ok, true);
  assert.equal(view.reconciliation.checked, 3);
  ok('funding, payout and refund reconcile without changing the ledger');

  view = await act('owner', 'fund', { amountCents: 10000 });
  payerPays(lastRequest(view).externalId); view = await sync('owner');
  for (const stage of view.effective.stages.slice(1)) {
    if (view.stages.find(s => s.stageId === stage.id).status === 'pending') {
      await act('company', 'submit_stage', { stageId: stage.id, evidence, note: '合成：剩余阶段完成' });
      await act('owner', 'accept_stage', { stageId: stage.id });
    }
    view = await act('owner', 'release', { stageId: stage.id });
    const remaining = lastRequest(view);
    view = await act('platform', 'review_payout', { requestId: remaining.id, decision: 'approve', note: '合成：剩余阶段验收与余额核对' });
    payerPays(view.providerRequests.find(r => r.id === remaining.id).externalId); view = await sync('platform');
    assert.equal(view.stages.find(s => s.stageId === stage.id).status, 'settled');
  }
  assert.ok(view.stages.every(s => s.status === 'settled'));
  assert.equal(view.releasedCents, view.effective.totalCents);
  assert.equal(view.balanceCents, 0); assert.equal(view.reservedCents, 0); assert.equal(view.realizedFeeCents, 300000);
  assert.equal(view.fundedCents, view.releasedCents + view.refundedCents + view.balanceCents);
  ok('all four stages settle with exactly 3% total fee and conserved funds');
  view = await call('platform', `/api/orders/${orderId}/workflow/reconcile`, { method: 'POST' });
  assert.equal(view.reconciliation.ok, true); assert.equal(view.reconciliation.checked, 7);
  ok('final funding, four payouts and refund reconcile after full settlement');

  console.log(JSON.stringify({ ok: true, checks, orderId, status: view.status, transactions: view.transactions.length, supplements: view.supplements.length }));
}

run().then(() => { server?.kill(); fs.rmSync(scratch, { recursive: true, force: true }); },
  error => { console.error('FAIL', error.message); console.error('server log and data kept in', scratch); server?.kill(); process.exitCode = 1; });
