// Synthetic accounts and a fresh isolated database; no AI, payment or production data.
// Run after build: node scripts/chat-http-smoke.cjs --isolated-demo
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { eq } = require('drizzle-orm');
const ts = require('typescript');
const assert = require('node:assert/strict');
if (process.argv[2] !== '--isolated-demo') throw new Error('Explicit --isolated-demo required');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yushe-chat-http-'));
const runtime = path.join(__dirname, '.chat-http');
fs.mkdirSync(runtime, { recursive: true });
for (const file of fs.readdirSync(path.join(root, 'packages/shared/src')).filter(f => f.endsWith('.ts'))) {
  fs.writeFileSync(path.join(runtime, file.replace(/\.ts$/, '.js')), ts.transpileModule(fs.readFileSync(path.join(root, 'packages/shared/src', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText);
}
process.env.IRENO_PGLITE_DIR = path.join(scratch, 'db');
const db = require('./.chat-http/db.js');
let child;
let requests = 0;
const base = 'http://127.0.0.1:3316';
async function request(route, status, cookie, method = 'GET', body) {
  const res = await fetch(base + route, { method, headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal(res.status, status, `${method} ${route}`); requests++;
  return res;
}
async function login(phone) {
  const res = await request('/api/auth/login', 200, null, 'POST', { phone, password: 'DemoOnly2026!' });
  return res.headers.get('set-cookie').split(';')[0];
}
(async () => {
  const salt = crypto.randomBytes(16);
  const passwordHash = `scrypt$${salt.toString('base64')}$${crypto.scryptSync('DemoOnly2026!', salt, 32).toString('base64')}`;
  const owner = await db.createUser({ role: 'homeowner', name: '聊天演示业主 合成资料', phone: '19900000001', passwordHash });
  const company = await db.createUser({ role: 'company', name: '聊天演示公司', companyName: '合成承接公司', phone: '19900000002', passwordHash });
  await db.createUser({ role: 'homeowner', name: '其他合成业主', phone: '19900000003', passwordHash });
  const otherCompany = await db.createUser({ role: 'company', name: '其他合成公司', phone: '19900000004', passwordHash });
  const p = await db.createProject({ homeownerId: owner.id, name: '聊天HTTP合成项目', style: '现代简约', budget: '15' });
  const order = await db.createOrder({ projectId: p.id, homeownerId: owner.id });
  const p2 = await db.createProject({ homeownerId: owner.id, name: '未选定公司合成项目', style: '现代简约', budget: '15' });
  const openOrder = await db.createOrder({ projectId: p2.id, homeownerId: owner.id });
  const p3 = await db.createProject({ homeownerId: owner.id, name: '聊天第二项目 合成资料', style: '现代简约', budget: '15' });
  const secondOrder = await db.createOrder({ projectId: p3.id, homeownerId: owner.id });
  const storage = await db.getDb();
  await storage.update(db.orders).set({ companyId: company.id, status: 'matched' }).where(eq(db.orders.id, order.id));
  await storage.update(db.orders).set({ companyId: company.id, status: 'matched' }).where(eq(db.orders.id, secondOrder.id));
  await storage.$client.close();
  const out = fs.openSync(path.join(scratch, 'server.log'), 'a');
  child = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', '3316'], {
    cwd: path.join(root, 'apps/web'), windowsHide: true, stdio: ['ignore', out, out],
    env: { ...process.env, NODE_ENV: 'production', RUNNER_ENABLED: 'false', SESSION_SECRET: crypto.randomBytes(48).toString('hex'), COOKIE_SECURE: 'false', MIMO_API_KEY: '', DEEPSEEK_API_KEY: '', opcpay_api_key: '', BOSS_PHONE: '19900000000', BOSS_PASSWORD: 'DemoOnly2026!' },
  });
  fs.closeSync(out);
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error('Isolated server exited: ' + scratch);
    try { if ((await fetch(base + '/messages')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, 'isolated server must start');
  assert.ok((await (await request('/messages', 200)).text()).includes('项目沟通'));
  await request('/api/conversations', 401);
  const a = await login('19900000001'), b = await login('19900000002'), stranger = await login('19900000003'), other = await login('19900000004'), boss = await login('19900000000');
  await request('/api/conversations', 403, boss);
  await request(`/api/orders/${openOrder.id}/conversations`, 409, a, 'POST');
  await request(`/api/orders/${order.id}/conversations`, 403, other, 'POST');
  const c = await (await request(`/api/orders/${order.id}/conversations`, 200, a, 'POST')).json();
  const companyThread = await (await request(`/api/orders/${order.id}/conversations`, 200, b, 'POST', { companyId: otherCompany.id })).json();
  assert.equal(companyThread.id, c.id);
  assert.equal((await (await request('/api/conversations', 200, stranger)).json()).length, 0);
  const url = `/api/conversations/${c.id}`;
  await request(url + '/messages', 403, stranger);
  await request(url + '/messages', 403, other);
  const body = { text: '厨房台面使用石英石，插座预留三个。<b>纯文本</b>', clientKey: 'http-retry-message', senderId: otherCompany.id };
  const sent = await (await request(url + '/messages', 200, a, 'POST', body)).json();
  assert.equal(sent.senderId, owner.id);
  const retry = await (await request(url + '/messages', 200, a, 'POST', body)).json();
  assert.equal(sent.id, retry.id);
  await request(url + '/messages', 409, a, 'POST', { ...body, text: '不能覆盖原消息' });
  await request(url + '/messages', 400, a, 'POST', { text: ' ', clientKey: 'http-empty-key' });
  await request(url + '/messages', 400, a, 'POST', { text: 'a'.repeat(2001), clientKey: 'http-long-key' });
  await request(url + '/messages?before=bad', 400, b);
  const beforeRead = (await (await request('/api/conversations', 200, b)).json()).find(row => row.id === c.id);
  assert.equal(beforeRead.unreadCount, 1);
  const page = await (await request(url + '/messages', 200, b)).json();
  assert.equal(page.messages.length, 1); assert.equal(page.messages[0].text, body.text);
  await request(url + '/read', 200, b, 'POST', { throughId: sent.id });
  const afterRead = (await (await request('/api/conversations', 200, b)).json()).find(row => row.id === c.id);
  assert.equal(afterRead.unreadCount, 0);
  const reply = await (await request(url + '/messages', 200, b, 'POST', { text: '可以，明天确认材料型号。', clientKey: 'http-company-reply' })).json();
  const increment = await (await request(url + `/messages?after=${sent.id}`, 200, a)).json();
  assert.equal(increment.messages.length, 1); assert.equal(increment.messages[0].id, reply.id);
  assert.equal(increment.conversation.partnerReadId, sent.id);
  await request(url + '/read', 403, stranger, 'POST', { throughId: reply.id });
  await request(url + '/read', 400, b, 'POST', { throughId: 999999 });
  const exported = await request(url + '/export', 200, a);
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  assert.match(exported.headers.get('cache-control'), /no-store/);
  const transcript = await exported.json(); assert.equal(transcript.messages.length,2);
  assert.doesNotMatch(JSON.stringify(transcript), /http-retry-message|clientKey|passwordHash/);
  await request(url + '/export', 200, b);
  await request(url + '/export', 403, stranger);
  await request(url + '/export', 403, boss);
  const trialPage = await (await request('/trials', 200)).text();
  assert.ok(trialPage.includes('试运行效果记录'));
  let browserReport;
  if (process.argv.includes('--browser')) browserReport = await require('./chat-browser-checks.cjs').run({ base, ownerCookie:a, companyCookie:b, ownerId:owner.id, companyId:company.id, conversationId:c.id, projectId:p.id, secondOrderId:secondOrder.id, outDir:path.join(scratch,'browser') });
  console.log(JSON.stringify({ status: 'passed', requests, browserReport, fixture: 'synthetic accounts and selected order; no AI/payment calls', evidenceDirectory: scratch }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { child?.kill(); });
