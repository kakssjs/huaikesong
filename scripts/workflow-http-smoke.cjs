// Run only against a locally started, newly seeded isolated demo server.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const base = process.env.WORKFLOW_TEST_URL || 'http://127.0.0.1:3301';
const target = new URL(base);
assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname), 'HTTP acceptance is restricted to loopback');
const orderId = Number(process.env.WORKFLOW_TEST_ORDER || 1);
const cookies = {};
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAQCAIAAAD4YuoOAAAAKElEQVR4nGP8//8/Ay0BE01NZxi1gAgwGgcEwWgQEQSjQUQQDP0gAgB/9AMd3VwQnAAAAABJRU5ErkJggg==';
let checks = 0;
async function api(role, url, method = 'GET', body, expected = 200) {
  const response = await fetch(base + url, { method,
    headers: { ...(cookies[role] ? { cookie: cookies[role] } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(result).slice(0, 500)}`);
  checks++;
  return result;
}
async function view(role = 'owner') { return api(role, `/api/orders/${orderId}/workflow`); }
async function act(role, action, payload = {}, expected = 200) {
  const state = await view(role);
  return api(role, `/api/orders/${orderId}/workflow`, 'POST',
    { action, expectedRevision: state.revision, requestKey: crypto.randomUUID(), payload }, expected);
}
const party = (legalName, id, representative) => ({ legalName, registrationId: id, representative,
  contact: '演示联系方式 非真实', address: '演示地址 非真实' });
(async () => {
  for (const [role, phone, password] of [
    ['owner', '19900000001', 'DemoOnly2026!'], ['company', '19900000002', 'DemoOnly2026!'],
    ['stranger', '19900000003', 'DemoOnly2026!'], ['platform', '19900000000', 'DemoBossOnly2026!'],
  ]) {
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, password }) });
    assert.equal(r.status, 200, `login ${role}`);
    cookies[role] = r.headers.get('set-cookie').split(';')[0];
  }
  await api('stranger', `/api/orders/${orderId}/workflow`, 'GET', undefined, 403);
  await api('owner', '/api/company/contract-profile', 'GET', undefined, 403);
  let current = await view();
  const staleRevision = current.revision;
  await act('owner', 'homeowner_accept', {}, 409);
  await api('company', '/api/company/contract-profile', 'PUT', {
    party: party('演示装企 合成主体', 'DEMO-COMPANY', '演示公司授权人'), authorizedSignerName: '演示公司授权人', sealDataUrl: image,
  });
  await act('owner', 'revise', { patch: { homeowner: party('演示业主', '', '演示业主'), areaBasis: '套内面积',
    location: '演示施工地址 非真实', attachments: [{ id: 'demo-reference', kind: 'reference', name: '合成演示参考图', dataUrl: image, note: '合成样例' }] } });
  await act('company', 'revise', { patch: { company: party('演示装企 合成主体', 'DEMO-COMPANY', '演示公司授权人'),
    scope: '演示墙面与地面施工 <script>alert("untrusted")</script>', durationDays: 56 } });
  await act('platform', 'revise', { patch: { platform: party('演示平台 合成主体', 'DEMO-PLATFORM', '演示平台授权人'), feeBps: 300 } });
  await api('owner', `/api/orders/${orderId}/workflow`, 'POST', { action: 'generate_draft',
    expectedRevision: staleRevision, requestKey: crypto.randomUUID(), payload: {} }, 409);
  await act('company', 'company_confirm');
  await act('owner', 'negotiate', { totalCents: 10000000, note: '演示议价与版本重确认' });
  await act('owner', 'homeowner_accept', {}, 409);
  await act('company', 'company_confirm');
  await act('owner', 'homeowner_accept');
  current = await act('owner', 'generate_draft');
  assert.deepEqual(current.validation.errors, []);
  assert.deepEqual(current.validation.missing, []);
  await act('owner', 'ai_review', {}, 503);
  await act('owner', 'freeze');
  await act('owner', 'sign_demo', { signerName: '演示业主', signatureDataUrl: image });
  await act('company', 'sign_demo', { signerName: '演示公司授权人', signatureDataUrl: image, authorizeSeal: true });
  current = await act('platform', 'sign_demo', { signerName: '演示平台授权人', signatureDataUrl: image });
  assert.equal(current.status, 'signed_demo');
  assert.equal(current.current.signatures.length, 3);
  await act('owner', 'revise', { patch: { area: 100 } }, 409);
  await api('owner', `/api/orders/${orderId}/contract`, 'POST', { signer: 'homeowner' }, 409);
  await api('company', `/api/orders/${orderId}/confirm`, 'POST', {}, 409);
  const companyView = await view('company');
  assert.equal(companyView.current.termsHash, current.current.termsHash);
  const htmlRes = await fetch(base + `/api/orders/${orderId}/workflow?format=html`, { headers: { cookie: cookies.owner } });
  assert.equal(htmlRes.status, 200);
  const html = await htmlRes.text();
  assert.ok(!html.includes('<script>alert("untrusted")</script>'));
  assert.ok(html.includes('演示'));
  await act('owner', 'simulate_fund', { amountCents: 10000000 });
  const first = current.current.terms.stages[0].id;
  const second = current.current.terms.stages[1].id;
  const evidence = [{ id: 'stage-evidence', kind: 'reference', name: '合成进度证据', dataUrl: image }];
  await act('company', 'submit_stage', { stageId: first, evidence, note: '演示阶段完成' });
  await act('owner', 'simulate_release', { stageId: first }, 409);
  await act('owner', 'reject_stage', { stageId: first, reason: '演示验收驳回' });
  await act('company', 'submit_stage', { stageId: first, evidence, note: '演示整改后重提' });
  await act('owner', 'accept_stage', { stageId: first });
  await act('company', 'simulate_release', { stageId: first }, 403);
  current = await view();
  const body = { action: 'simulate_release', expectedRevision: current.revision, requestKey: crypto.randomUUID(), payload: { stageId: first } };
  const replies = await Promise.all([1, 2].map(() => api('owner', `/api/orders/${orderId}/workflow`, 'POST', body)));
  current = replies[1];
  assert.equal(current.transactions.filter(t => t.type === 'release' && t.stageId === first).length, 1);
  assert.equal(current.realizedFeeCents, 60000);
  await act('company', 'submit_stage', { stageId: second, evidence, note: '第二阶段演示' });
  await act('owner', 'accept_stage', { stageId: second });
  current = await act('company', 'open_dispute', { stageId: second, reason: '演示争议冻结' });
  await act('owner', 'simulate_release', { stageId: second }, 409);
  await act('owner', 'simulate_refund', { amountCents: 10000, reason: '争议中不应退款' }, 409);
  const dispute = current.disputes.find(d => d.status === 'open');
  await act('platform', 'resolve_dispute', { disputeId: dispute.id, independentParty: '演示独立处理方', basis: '仅用于流程测试的合成依据', outcome: '演示争议已协商解决' });
  current = await act('owner', 'simulate_release', { stageId: second });
  assert.equal(current.releasedCents + current.refundedCents + current.balanceCents, current.fundedCents);
  assert.equal(current.realizedFeeCents, 150000);
  console.log(JSON.stringify({ ok: true, checks, orderId, revision: current.revision,
    signatures: current.current.signatures.length, releaseCount: current.transactions.filter(t => t.type === 'release').length,
    realizedFeeCents: current.realizedFeeCents, mode: current.mode }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
