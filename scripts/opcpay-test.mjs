import assert from 'node:assert/strict';
import { basicSku, entitlement, purchaseLinks, payRequest, membershipIdentity, membershipReturnUrl } from '../apps/web/lib/opcpay.ts';
delete process.env.MEMBERSHIP_PAYMENT_NAMESPACE;
assert.equal(membershipIdentity('company', 12), 'company-12');
process.env.MEMBERSHIP_PAYMENT_NAMESPACE = 'yushe-dual';
assert.equal(membershipIdentity('company', 12), 'yushe-dual-company-12');
assert.equal(membershipIdentity('membership', 12), 'yushe-dual-membership-12');
process.env.MEMBERSHIP_PAYMENT_NAMESPACE = 'bad prefix';
assert.throws(() => membershipIdentity('company', 12));
delete process.env.MEMBERSHIP_PAYMENT_NAMESPACE;
delete process.env.PUBLIC_BASE_URL;
assert.throws(() => membershipReturnUrl());
process.env.PUBLIC_BASE_URL = 'https://39.105.92.190:8443';
assert.equal(membershipReturnUrl(), 'https://39.105.92.190:8443/contractor?payment_return=1');
process.env.PUBLIC_BASE_URL = 'javascript:alert(1)';
assert.throws(() => membershipReturnUrl());
const option = { sku_id: 'S0806000213862097', billing_mode: 'ONE_TIME_DURATION', duration_period: 'MONTH', currency: 'CNY', price: '39.00' };
assert.equal(basicSku({ capability_status: 'ENABLED', charging_options: [option] }), option.sku_id);
assert.equal(basicSku({ capability_status: 'ENABLED', charging_options: [{ ...option, sku_id: 'actual-project-sku' }] }), 'actual-project-sku');
assert.throws(() => basicSku({ capability_status: 'ENABLED', charging_options: [option, option] }));
for (const changed of [{ price: '165.00' }, { duration_period: 'YEAR' }, { sku_id: '' }]) {
  assert.throws(() => basicSku({ capability_status: 'ENABLED', charging_options: [{ ...option, ...changed }] }));
}
assert.equal(entitlement({ decision: 'PURCHASE_REQUIRED', access_granted: false }), null);
assert.equal(entitlement({ decision: 'ALLOW', access_granted: true, valid_until: '2099-01-01 08:00:00' }), '2099-01-01T00:00:00.000Z');
assert.throws(() => entitlement({ decision: 'ALLOW', access_granted: true }));
assert.throws(() => entitlement({ status: 'READY' }));
assert.throws(() => entitlement({ decision: 'ALLOW', access_granted: true, requires_consumption: true, valid_until: '2099-01-01' }));
assert.throws(() => purchaseLinks({ purchase_url: 'javascript:alert(1)' }));
assert.throws(() => purchaseLinks({ purchase_url: 'https://alipay.com.evil.example/' }));
assert.ok(purchaseLinks({ purchase_url: 'alipays://platformapi/startapp?appId=test' }));
process.env.opcpay_api_key = 'test-only';
const original = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  assert.equal(options.headers.Authorization, 'Bearer test-only');
  assert.equal(options.redirect, 'error');
  return new Response(JSON.stringify({ decision: 'DENY', access_granted: false }));
};
assert.equal((await payRequest('/access', { user_id: 'company-1' })).decision, 'DENY');
globalThis.fetch = async () => new Response('{}', { status: 503 });
await assert.rejects(payRequest('/product'));

const purchase = { user_id: 'new-company-1', idempotency_key: 'new-membership-10', sku_id: 'actual-project-sku', callback_url: 'https://example.com:8443/contractor?payment_return=1' };
const attempts = [];
globalThis.fetch = async (url, options) => {
  attempts.push(JSON.parse(options.body));
  if (attempts.length === 1) throw new Error('response lost after provider created entry');
  return new Response(JSON.stringify({ status: 'READY', idempotency_key: purchase.idempotency_key }));
};
await assert.rejects(payRequest('/purchase', purchase));
assert.equal((await payRequest('/purchase', purchase)).idempotency_key, purchase.idempotency_key);
assert.deepEqual(attempts, [purchase, purchase]);
delete process.env.opcpay_api_key;
await assert.rejects(payRequest('/product'), /暂未配置/);
globalThis.fetch = original;
console.log('PASS: only 39 CNY/month, fail-closed entitlements, China timezone, safe payment links and provider failures');
