// Test-only preload for the isolated acceptance server: node --require scripts/test-payments.cjs ...
// It answers the payment provider's entitlement/product requests with fixed fixtures so a synthetic company
// can bid. Every other request goes through unchanged. Never load this in a production server.
const GRANTED = new Set((process.env.TEST_PAYMENT_COMPANY_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
const original = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('https://ai6666.com/opcpay/api/pay/v1')) return original.call(this, input, init);
  const path = url.slice('https://ai6666.com/opcpay/api/pay/v1'.length);
  const body = init && init.body ? JSON.parse(String(init.body)) : {};
  const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  if (path === '/access') {
    const allowed = GRANTED.has(String(body.user_id));
    return json(allowed
      ? { decision: 'ALLOW', access_granted: true, valid_until: new Date(Date.now() + 30 * 86400000).toISOString() }
      : { decision: 'PURCHASE_REQUIRED', access_granted: false });
  }
  if (path === '/capabilities') {
    return json({ api_version: '1.1', provider_configured: true, capabilities: { transaction_query: true, entitlement_query: true, purchase_entry: true, refund: false, refund_query: false, bills: false, transaction_list: false } });
  }
  if (path === '/transactions/query' && process.env.TEST_PAYMENT_STATE) {
    // The test script writes { "<user_id>|<idempotency_key>": { status, tradeNo, checkedAt } } to decide what the provider "verified".
    let state = {};
    try { state = JSON.parse(require('node:fs').readFileSync(process.env.TEST_PAYMENT_STATE, 'utf8')); } catch {}
    const known = state[`${body.user_id}|${body.idempotency_key}`];
    if (!known) return new Response(JSON.stringify({ error: '未找到记录', error_code: 'NOT_FOUND', request_id: 'test', retryable: false }), { status: 404, headers: { 'content-type': 'application/json' } });
    return json({ project_id: 'test-project', user_id: body.user_id, idempotency_key: body.idempotency_key, status: known.status,
      trade_no: known.tradeNo ?? null, checked_at: known.checkedAt ?? null, status_source: known.checkedAt ? 'ALIPAY_PURCHASE_QUERY_V3' : null,
      created_at: '2026-11-15T00:00:00Z', fetched_at: new Date().toISOString() });
  }
  return new Response(JSON.stringify({ error_code: 'TEST_FIXTURE_NOT_SUPPORTED' }), { status: 501, headers: { 'content-type': 'application/json' } });
};
