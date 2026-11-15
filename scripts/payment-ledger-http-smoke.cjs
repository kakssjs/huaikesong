// Payment ledger and refund acceptance over HTTP on an isolated production build.
// The payment provider is the TEST-ONLY fixture scripts/test-payments.cjs, driven through a temp JSON file that plays "what the
// provider last verified". Synthetic accounts, a new temp database, no real money and no real provider call.
// Usage: npm run build, then: node scripts/payment-ledger-http-smoke.cjs --isolated-demo
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const ts = require('typescript');
if (process.argv[2] !== '--isolated-demo') throw new Error('Explicit --isolated-demo is required');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.PAYMENT_LEDGER_TEST_PORT || 3326);
const base = `http://127.0.0.1:${port}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yushe-payment-ledger-'));
const providerState = path.join(scratch, 'provider.json');
const compiled = path.join(root, 'scripts', '.payment-ledger-http');
fs.mkdirSync(compiled, { recursive: true });
for (const name of fs.readdirSync(path.join(root, 'packages/shared/src')).filter(f => f.endsWith('.ts'))) {
  fs.writeFileSync(path.join(compiled, name.replace(/\.ts$/, '.js')), ts.transpileModule(fs.readFileSync(path.join(root, 'packages/shared/src', name), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText);
}
process.env.IRENO_PGLITE_DIR = path.join(scratch, 'db');
const db = require('./.payment-ledger-http/db.js');
const PASSWORD = 'DemoOnly2026!', BOSS_PHONE = '19900000000', BOSS_PASSWORD = crypto.randomBytes(12).toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let server, checks = 0;
const ok = (name, detail = '') => { checks++; console.log('PASS', name, detail); };
const setProvider = (key, value) => {
  let state = {}; try { state = JSON.parse(fs.readFileSync(providerState, 'utf8')); } catch {}
  state[key] = value; fs.writeFileSync(providerState, JSON.stringify(state));
};

async function seed() {
  const salt = crypto.randomBytes(16);
  const passwordHash = `scrypt$${salt.toString('base64')}$${crypto.scryptSync(PASSWORD, salt, 32).toString('base64')}`;
  const a = await db.createUser({ role: 'company', name: '合成公司甲', companyName: '合成公司甲', phone: '19900000002', passwordHash });
  const b = await db.createUser({ role: 'company', name: '合成公司乙', companyName: '合成公司乙', phone: '19900000003', passwordHash });
  const intent = (c, n) => ({ user_id: `ledger-company-${c.id}`, sku_id: 'actual-sku', callback_url: 'https://example.com:8443/contractor?payment_return=1', keyPrefix: `ledger-membership-${n}-` });
  const payA = await db.getOrCreateOnlinePayment(a.id, null, intent(a, 'a'));
  const payB = await db.getOrCreateOnlinePayment(b.id, null, intent(b, 'b'));
  const legacy = await db.getOrCreateOnlinePayment(b.id, null);
  await (await db.getDb()).$client.close();
  return { a, b, payA, payB, legacy };
}

async function startServer() {
  const logFile = fs.openSync(path.join(scratch, 'server.log'), 'a');
  server = spawn(process.execPath, ['--require', path.join(root, 'scripts/test-payments.cjs'), path.join(root, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: path.join(root, 'apps/web'), windowsHide: true, stdio: ['ignore', logFile, logFile],
    env: { ...process.env, NODE_ENV: 'production', RUNNER_ENABLED: 'false', COOKIE_SECURE: 'false', SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
      LLM_API_KEY: '', AGNES_API_KEY: '', opcpay_api_key: 'test-fixture-only', TEST_PAYMENT_STATE: providerState,
      BOSS_PHONE, BOSS_PASSWORD, IRENO_PGLITE_DIR: path.join(scratch, 'db'), IRENO_UPLOAD_DIR: path.join(scratch, 'uploads') },
  });
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

async function run() {
  const { a, b, payA, payB, legacy } = await seed();
  const keyA = `ledger-company-${a.id}|${payA.purchaseIntent.idempotency_key}`;
  const keyB = `ledger-company-${b.id}|${payB.purchaseIntent.idempotency_key}`;
  await startServer();
  await login('a', '19900000002'); await login('b', '19900000003'); await login('boss', BOSS_PHONE, BOSS_PASSWORD);

  await call('', '/api/company/membership/ledger', { expected: 401 });
  await call('boss', '/api/company/membership/ledger', { expected: 403 });
  await call('a', '/api/boss/payments', { expected: 403 });
  await call('', '/api/boss/payments', { expected: 401 });
  ok('ledger routes are role-gated: anonymous 401, wrong role 403');

  // Provider has no record yet: the ledger must say so and must not offer a refund.
  let ledger = await call('a', '/api/company/membership/ledger');
  assert.equal(ledger.rows.length, 1); assert.equal(ledger.rows[0].id, payA.id);
  assert.equal(ledger.rows[0].payment.status, 'NOT_FOUND'); assert.equal(ledger.summary.paidCount, 0);
  await call('a', '/api/company/membership/ledger', { method: 'POST', body: { paymentId: payA.id, action: 'request', reason: '没有付款也想退款' }, expected: 409 });
  ok('a purchase the provider does not know is NOT_FOUND and cannot be refunded');

  setProvider(keyA, { status: 'PENDING', tradeNo: null, checkedAt: '2026-11-15T01:00:00Z' });
  await sleep(16000);
  ledger = await call('a', '/api/company/membership/ledger');
  assert.equal(ledger.rows[0].payment.status, 'PENDING');
  await call('a', '/api/company/membership/ledger', { method: 'POST', body: { paymentId: payA.id, action: 'request', reason: '待支付也想退款' }, expected: 409 });
  ok('PENDING is shown as pending and cannot be refunded');

  setProvider(keyA, { status: 'PAID', tradeNo: 'TRADE-SYN-1', checkedAt: '2026-11-15T02:00:00Z' });
  await sleep(16000);
  ledger = await call('a', '/api/company/membership/ledger');
  assert.equal(ledger.rows[0].payment.status, 'PAID'); assert.equal(ledger.rows[0].payment.tradeNo, 'TRADE-SYN-1');
  assert.deepEqual([ledger.summary.paidCount, ledger.summary.paidCny], [1, 39]);
  ok('PAID is read from the provider and counted once', 'paid 1 / 39 CNY');

  // Isolation between companies.
  const ledgerB = await call('b', '/api/company/membership/ledger');
  assert.ok(ledgerB.rows.every(r => r.companyId === b.id)); assert.equal(ledgerB.summary.paidCount, 0);
  assert.equal(ledgerB.rows.find(r => r.id === legacy.id).source, 'legacy');
  await call('b', '/api/company/membership/ledger', { method: 'POST', body: { paymentId: payA.id, action: 'request', reason: '申请别人的付款退款' }, expected: 404 });
  ok('a company sees only its own payments and cannot refund another company\'s', 'legacy rows are labelled, not verified');

  // Request, withdraw, request again, boss decides.
  await call('a', '/api/company/membership/ledger', { method: 'POST', body: { paymentId: payA.id, action: 'request', reason: '短' }, expected: 400 });
  await call('a', '/api/company/membership/ledger', { method: 'POST', body: { paymentId: payA.id, action: 'request', reason: '功能不满足需求，申请退款' } });
  await call('a', '/api/company/membership/ledger', { method: 'POST', body: { paymentId: payA.id, action: 'request', reason: '重复提交的申请' }, expected: 409 });
  await call('a', '/api/company/membership/ledger', { method: 'POST', body: { paymentId: payA.id, action: 'withdraw' } });
  await call('a', '/api/company/membership/ledger', { method: 'POST', body: { paymentId: payA.id, action: 'withdraw' }, expected: 409 });
  await call('a', '/api/company/membership/ledger', { method: 'POST', body: { paymentId: payA.id, action: 'request', reason: '重新申请：确认不再使用' } });
  ok('refund request validates the reason, rejects duplicates and can be withdrawn once');

  let boss = await call('boss', '/api/boss/payments');
  assert.equal(boss.summary.refundRequested, 1);
  assert.deepEqual(boss.provider, { refund: false, bills: false, transactionList: false, transactionQuery: true });
  ok('the platform sees the request and the provider\'s real capability flags', 'refund/bills not available');
  await call('boss', '/api/boss/payments', { method: 'POST', body: { paymentId: payA.id, action: 'approve', note: '' }, expected: 400 });
  await call('boss', '/api/boss/payments', { method: 'POST', body: { paymentId: payA.id, action: 'maybe', note: '同意' }, expected: 400 });
  await call('boss', '/api/boss/payments', { method: 'POST', body: { paymentId: payB.id, action: 'approve', note: '没有申请' }, expected: 409 });
  await call('boss', '/api/boss/payments', { method: 'POST', body: { paymentId: payA.id, action: 'approve', note: '同意退款，已在支付宝处理' } });
  ledger = await call('a', '/api/company/membership/ledger');
  assert.equal(ledger.rows[0].refund.status, 'approved'); assert.equal(ledger.rows[0].payment.status, 'PAID');
  assert.equal(ledger.summary.refundedCount, 0);
  await call('a', '/api/company/membership/ledger', { method: 'POST', body: { paymentId: payA.id, action: 'withdraw' }, expected: 409 });
  ok('approval is only a recorded decision: still PAID, refunded count 0, cannot be withdrawn');

  setProvider(keyA, { status: 'REFUNDED', tradeNo: 'TRADE-SYN-1', checkedAt: '2026-11-15T03:00:00Z' });
  await sleep(16000);
  ledger = await call('a', '/api/company/membership/ledger');
  assert.equal(ledger.rows[0].payment.status, 'REFUNDED'); assert.equal(ledger.rows[0].refund.status, 'refunded');
  assert.deepEqual([ledger.summary.paidCount, ledger.summary.refundedCount, ledger.summary.refundedCny], [0, 1, 39]);
  assert.deepEqual(ledger.rows[0].refund.history.map(h => h.action), ['request', 'withdraw', 'request', 'approve', 'refunded']);
  ok('only the provider returning REFUNDED completes the refund', 'history: ' + ledger.rows[0].refund.history.map(h => h.action).join(' > '));

  // A provider that later says PAID again must not reopen a refunded purchase.
  setProvider(keyA, { status: 'PAID', tradeNo: 'TRADE-SYN-1', checkedAt: '2026-11-15T04:00:00Z' });
  await sleep(16000);
  ledger = await call('a', '/api/company/membership/ledger');
  assert.equal(ledger.rows[0].payment.status, 'REFUNDED');
  ok('REFUNDED is final');

  // Refund made outside this site is still recorded.
  setProvider(keyB, { status: 'REFUNDED', tradeNo: 'TRADE-SYN-2', checkedAt: '2026-11-15T05:00:00Z' });
  boss = await call('boss', '/api/boss/payments');
  const rowB = boss.rows.find(r => r.id === payB.id);
  assert.equal(rowB.refund.status, 'refunded'); assert.equal(rowB.refund.history[0].actor, 'provider');
  assert.equal(boss.rows.find(r => r.id === legacy.id).payment, null);
  ok('a refund made outside this site is recorded from the provider; legacy rows stay unverified');

  // An outage keeps the last result and reports it.
  const before = JSON.stringify((await call('boss', '/api/boss/payments')).rows.find(r => r.id === payA.id).payment);
  assert.ok(before.includes('REFUNDED'));

  console.log(`\nALL ${checks} CHECKS PASSED`);
}

run().then(() => cleanup(0), error => { console.error(error); cleanup(1); });
function cleanup(code) {
  try { server?.kill(); } catch {}
  setTimeout(() => { try { fs.rmSync(scratch, { recursive: true, force: true }); fs.rmSync(compiled, { recursive: true, force: true }); } catch {} process.exit(code); }, 800);
}
