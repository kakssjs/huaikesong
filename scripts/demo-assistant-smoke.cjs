// Isolated synthetic accounts + local model stub; never targets production.
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), http = require('http');
const { spawn } = require('child_process');
const assert = require('assert/strict');
if (process.argv[2] !== '--isolated-demo') throw new Error('Use --isolated-demo');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yushe-demo-'));
const base = 'http://127.0.0.1:3337';
const password = crypto.randomBytes(20).toString('hex');
let server, model;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(check, label) { for (let i = 0; i < 80; i++) { const value = await check(); if (value) return value; await wait(500); } throw new Error(`timed out: ${label}`); }
async function call(url, cookie, body, method = body ? 'POST' : 'GET', status = 200) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await res.json(); assert.equal(res.status, status, `${method} ${url}: ${JSON.stringify(data).slice(0,150)}`);
  return { data, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
(async () => {
  model = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: '【演示报价草稿】报价以项目参考清单为依据，现场量房后确认，不是正式承诺。' } }], usage: { total_tokens: 20 } })); }); });
  await new Promise(r => model.listen(3338, '127.0.0.1', r));
  const log = fs.openSync(path.join(scratch, 'server.log'), 'a');
  server = spawn(process.execPath, [path.resolve(__dirname, '../node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', '3337'], { cwd: path.resolve(__dirname, '../apps/web'), windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, NODE_ENV: 'production', RUNNER_ENABLED: 'true', COOKIE_SECURE: 'false', SESSION_SECRET: crypto.randomBytes(48).toString('hex'), BOSS_PHONE: '19900000000', BOSS_PASSWORD: password, IRENO_PGLITE_DIR: path.join(scratch, 'db'), LLM_BASE_URL: 'http://127.0.0.1:3338', LLM_MODEL: 'stub', LLM_API_KEY: 'test-only', opcpay_api_key: '' } });
  fs.closeSync(log);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await wait(500); }
  const boss = (await call('/api/auth/login', null, { phone: '19900000000', password })).cookie;
  await call('/api/boss/demo', null, null, 'GET', 401);
  const demo = (await call('/api/boss/demo', boss, { action: 'create' })).data;
  assert.equal(demo.companies.length, 3); assert.equal(demo.projects.length, 2);
  const owner = (await call('/api/auth/login', null, demo.credentials[0])).cookie;
  const companies = [];
  for (const cred of demo.credentials.slice(1)) companies.push((await call('/api/auth/login', null, cred)).cookie);
  const sample = demo.projects[0];
  assert.equal((await call('/api/orders?status=open', companies[0])).data.length, 2);
  const draft = (await call('/api/company/assistant', companies[0], { orderId: sample.orderId })).data;
  assert.match(draft.text, /演示/);
  assert.equal((await call(`/api/bids?orderId=${sample.orderId}`, owner)).data.length, 0, 'AI cannot submit bids');
  await call('/api/company/assistant', owner, { orderId: sample.orderId }, 'POST', 403);
  for (const [index, company] of demo.companies.entries()) {
    await call('/api/boss/demo', boss, { action: 'bid', orderId: sample.orderId, companyId: company.id, amount: (sample.total * (1 + index * .04) / 10000).toFixed(4), weeks: sample.weeks + index, note: draft.text });
  }
  assert.equal((await call(`/api/bids?orderId=${sample.orderId}`, owner)).data.length, 3);
  // The stub answers with prose, so the matcher falls back to its rule scores; it must still rank the unverified demo teams.
  const match = await until(async () => {
    const found = (await call(`/api/projects/${sample.projectId}`, owner)).data.results.find(r => r.kind === 'match')?.content;
    return found?.contractors?.length === 3 && found;
  }, 'matcher ranks all three demo bids');
  assert.ok(match.contractors.every(c => c.verified === false && /演示/.test(c.reason)), 'demo teams are ranked without a fake certification');
  const listed = (await call('/api/boss/demo', boss)).data.projects.find(p => p.orderId === sample.orderId);
  assert.equal(listed.referenceCny, sample.total); assert.equal(listed.bids.length, 3);
  assert.ok(!(await call('/api/boss', boss)).data.approvals.some(a => demo.companies.some(c => a.id === `user_${c.id}`)), 'demo teams never enter the real qualification queue');
  await call(`/api/users/${demo.companies[0].id}/verify`, boss, { action: 'approve' }, 'POST', 403);
  await call(`/api/orders/${sample.orderId}`, owner, { status: 'matched', companyId: demo.companies[0].id }, 'PATCH');
  const conversation = (await call(`/api/orders/${sample.orderId}/conversations`, owner, {})).data;
  await call(`/api/conversations/${conversation.id}/messages`, owner, { text: '厨房报价包括哪些材料？', clientKey: crypto.randomUUID() });
  await call('/api/company/assistant', companies[0], { orderId: sample.orderId, conversationId: conversation.id });
  assert.equal((await call(`/api/conversations/${conversation.id}/messages`, owner)).data.messages.length, 1, 'AI cannot send chat');
  await call('/api/company/assistant', companies[1], { orderId: sample.orderId, conversationId: conversation.id }, 'POST', 403);
  await call(`/api/orders/${sample.orderId}/workflow?mode=real`, owner, null, 'GET', 400);
  assert.equal((await call(`/api/orders/${sample.orderId}/workflow?mode=demo`, owner)).data.mode, 'demo');
  if (process.argv.includes('--browser')) {
    const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || 'D:/chatgpt/3dgongfang/studio/node_modules/playwright-core');
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    try {
      for (const width of [1440, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 1000 } });
        const addCookie = async cookie => context.addCookies([{ name: cookie.slice(0, cookie.indexOf('=')), value: cookie.slice(cookie.indexOf('=') + 1), domain: '127.0.0.1', path: '/', httpOnly: true, secure: false }]);
        await addCookie(boss);
        const page = await context.newPage();
        await page.goto(base + '/boss');
        await page.getByRole('button', { name: '用户管理', exact: true }).click();
        await page.getByRole('heading', { name: '临时演示装修队与项目' }).waitFor();
        // The first sample already has a selected team and takes no more quotes; draft for the one still open.
        await page.getByLabel('演示项目', { exact: true }).selectOption(String(demo.projects[1].orderId));
        await page.getByText('平台参考报价').waitFor();
        await page.getByLabel('装修队', { exact: true }).selectOption(String(demo.companies[0].id));
        await page.getByRole('button', { name: 'DeepSeek 生成报价说明草稿' }).click();
        await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some(t => t.value.includes('演示报价草稿')));
        await page.screenshot({ path: path.join(scratch, `boss-${width}.png`), fullPage: true });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await addCookie(owner);
        await page.goto(`${base}/project/${sample.projectId}`);
        await page.locator('#workspace-tab-match').click();
        await page.getByText('匹配的装修队').waitFor();
        await page.getByText('演示装修队 · 未做资质认证').first().waitFor();
        await page.screenshot({ path: path.join(scratch, `owner-match-${width}.png`), fullPage: true });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await addCookie(companies[0]);
        await page.goto(`${base}/messages?conversation=${conversation.id}`);
        await page.getByRole('button', { name: 'AI起草报价回复（审核后发送）' }).click();
        await page.waitForFunction(() => document.querySelector('#chat-draft')?.value.includes('演示报价草稿'));
        await page.screenshot({ path: path.join(scratch, `company-chat-${width}.png`), fullPage: true });
        assert.equal((await call(`/api/conversations/${conversation.id}/messages`, owner)).data.messages.length, 1, 'browser AI remains a draft');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await addCookie(companies[1]);
        await page.goto(base + '/contractor');
        await page.getByText('临时演示装修队').waitFor();
        await page.getByRole('button', { name: '参与竞价 →' }).first().click();
        await page.getByRole('button', { name: 'AI报价说明草稿（人工确认后提交）' }).click();
        await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some(t => t.value.includes('演示报价草稿')));
        await page.screenshot({ path: path.join(scratch, `contractor-${width}.png`), fullPage: true });
        assert.equal((await call(`/api/bids?orderId=${demo.projects[1].orderId}`, owner)).data.length, 0, 'company-side AI draft submits nothing');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await context.close();
      }
    } finally { await browser.close(); }
  }
  await call('/api/boss/demo', boss, { action: 'clean' });
  assert.equal((await call('/api/boss/demo', boss)).data.accounts.length, 0);
  console.log(JSON.stringify({ status: 'passed', fixture: 'synthetic accounts, local model stub, no real payments', scratch }));
})().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(async () => { if (server && server.exitCode === null) { server.kill(); await new Promise(r => server.once('exit', r)); } if (model) await new Promise(r => model.close(r)); });
