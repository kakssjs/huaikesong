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

// Payment ledger: transaction reads must be bound to the stored purchase and never invent a status.
const { fetchTransaction } = await import('../apps/web/lib/opcpay.ts');
const { refreshLedger, toLedger, summarizeLedger, MIN_REFRESH_MS } = await import('../apps/web/lib/payment-ledger.ts');
const { paymentStatusLabel, refundStatusText } = await import('../apps/web/lib/payment-labels.ts');
process.env.opcpay_api_key = 'test-only';
const intentRow = (id, extra = {}) => ({ id, companyId: 1, companyName: 'c', amountCny: 39, status: 'pending', createdAt: '2026-11-15T00:00:00.000Z',
  purchaseIntent: { user_id: 'u-' + id, idempotency_key: 'k-' + id, sku_id: 's', callback_url: 'https://x.example/' }, transactionSnapshot: null, refund: null, ...extra });
const answer = (row, over = {}) => ({ project_id: 'p', user_id: row.purchaseIntent.user_id, idempotency_key: row.purchaseIntent.idempotency_key,
  status: 'PAID', trade_no: 'T-9', checked_at: '2026-11-15T02:00:00Z', status_source: 'ALIPAY_PURCHASE_QUERY_V3', created_at: '2026-11-15T00:00:00Z', fetched_at: '2026-11-15T02:00:10Z', ...over });
const calls = [];
globalThis.fetch = async (url, options) => {
  calls.push({ url: String(url), method: options.method, body: options.body ? JSON.parse(options.body) : undefined });
  return new Response(JSON.stringify(globalThis.__reply));
};
const row1 = intentRow(1);
globalThis.__reply = answer(row1);
const tx = await fetchTransaction(row1);
assert.equal(calls[0].url, 'https://ai6666.com/opcpay/api/pay/v1/transactions/query');
assert.equal(calls[0].method, 'POST');
assert.deepEqual(calls[0].body, { user_id: 'u-1', idempotency_key: 'k-1' });
assert.equal(tx.status, 'PAID');
assert.equal(tx.tradeNo, 'T-9');
assert.equal(tx.checkedAt, '2026-11-15T02:00:00Z');
globalThis.__reply = answer(row1, { status: 'UNKNOWN', trade_no: null, checked_at: null, status_source: null });
const unknown = await fetchTransaction(row1);
assert.deepEqual([unknown.status, unknown.tradeNo, unknown.checkedAt, unknown.source], ['UNKNOWN', null, null, null]);
globalThis.__reply = answer(row1, { user_id: 'someone-else' });
await assert.rejects(fetchTransaction(row1), /其他购买/);
globalThis.__reply = answer(row1, { idempotency_key: 'k-other' });
await assert.rejects(fetchTransaction(row1), /其他购买/);
globalThis.__reply = answer(row1, { status: 'SETTLED' });
await assert.rejects(fetchTransaction(row1), /无法识别/);
await assert.rejects(fetchTransaction(intentRow(2, { purchaseIntent: null })), /没有一人付购买编号/);
globalThis.fetch = async () => new Response(JSON.stringify({ error: 'x', error_code: 'NOT_FOUND', request_id: 'r', retryable: false }), { status: 404 });
assert.equal((await fetchTransaction(row1)).status, 'NOT_FOUND');
globalThis.fetch = async () => new Response('{}', { status: 503 });
await assert.rejects(fetchTransaction(row1));

// Refresh only what can still change, and keep the old snapshot when the provider is unavailable.
const nowMs = Date.parse('2026-11-15T03:00:00Z');
const fresh = intentRow(3, { transactionSnapshot: { status: 'PAID', tradeNo: 'T', checkedAt: null, fetchedAt: new Date(nowMs - 5000).toISOString(), source: null } });
const refunded = intentRow(4, { transactionSnapshot: { status: 'REFUNDED', tradeNo: 'T', checkedAt: null, fetchedAt: '2020-01-01T00:00:00.000Z', source: null } });
const legacyRow = intentRow(5, { purchaseIntent: null });
let reads = 0;
globalThis.fetch = async () => { reads++; throw new Error('network down'); };
const saved = [];
const save = async (id, snapshot) => { saved.push([id, snapshot.status]); };
assert.deepEqual(await refreshLedger([fresh, refunded, legacyRow], fetchTransaction, save, nowMs), [], 'recent, refunded and legacy rows are not read');
assert.equal(reads, 0);
assert.ok(MIN_REFRESH_MS >= 15000);
assert.deepEqual(await refreshLedger([intentRow(6)], fetchTransaction, save, nowMs), [6], 'a failed read is reported, not hidden');
assert.deepEqual(saved, [], 'a failed read saves nothing');
globalThis.__reply = answer(intentRow(12));
globalThis.fetch = async () => new Response(JSON.stringify(globalThis.__reply));
assert.deepEqual(await refreshLedger([intentRow(12)], fetchTransaction, save, nowMs), []);
assert.deepEqual(saved, [[12, 'PAID']]);

// The ledger counts only what the provider verified, and labels never call an unverified record paid.
const ledger = toLedger([
  intentRow(7, { transactionSnapshot: { status: 'PAID', tradeNo: 'T', checkedAt: 'a', fetchedAt: 'a', source: 's' } }),
  intentRow(8, { transactionSnapshot: { status: 'REFUNDED', tradeNo: 'T', checkedAt: 'a', fetchedAt: 'a', source: 's' } }),
  intentRow(9, { transactionSnapshot: { status: 'UNKNOWN', tradeNo: null, checkedAt: null, fetchedAt: 'a', source: null } }),
  intentRow(10), legacyRow,
  intentRow(11, { transactionSnapshot: { status: 'PAID', tradeNo: 'T', checkedAt: 'a', fetchedAt: 'a', source: 's' }, refund: { status: 'requested', reason: 'r', requestedAt: 'a', history: [] } }),
]);
const totals = summarizeLedger(ledger);
assert.deepEqual([totals.paidCount, totals.paidCny, totals.refundedCount, totals.refundedCny, totals.unknownCount, totals.refundRequested], [2, 78, 1, 39, 1, 1]);
assert.equal(paymentStatusLabel(ledger[3]).text, '未核验');
assert.equal(paymentStatusLabel(ledger[4]).text, '旧站/线下记录');
assert.equal(paymentStatusLabel(ledger[2]).text, '待确认');
assert.equal(refundStatusText({ status: 'approved' }), '平台已同意，等待退款到账');
assert.equal(refundStatusText(null), '-');
delete process.env.opcpay_api_key;
globalThis.fetch = original;
console.log('PASS: transaction reads bound to the stored purchase, unknown/404/failed reads never become a status, ledger totals count verified records only');
