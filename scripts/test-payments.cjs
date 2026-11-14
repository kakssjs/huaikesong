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
  return new Response(JSON.stringify({ error_code: 'TEST_FIXTURE_NOT_SUPPORTED' }), { status: 501, headers: { 'content-type': 'application/json' } });
};
