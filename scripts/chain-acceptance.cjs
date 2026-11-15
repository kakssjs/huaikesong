// Main business chain on an isolated production server with synthetic data. No model or real payment calls.
// owner publishes -> unpaid company is refused -> paid company bids -> matcher runs (rules, no model) ->
// owner selects -> contract workflow opens for owner/company/platform -> stranger is refused. Then the browser
// opens the company console, the boss console and the owner's project page.
// Usage: npm run build, then: node scripts/chain-acceptance.cjs --isolated-demo
// Add --http-only to run the API and Runner checks without launching a browser.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const ts = require('typescript');
if (process.argv[2] !== '--isolated-demo') throw new Error('Explicit --isolated-demo is required');

const root = path.resolve(__dirname, '..');
const httpOnly = process.argv.includes('--http-only');
const firstExisting = list => list.filter(Boolean).find(p => fs.existsSync(p));
const playwrightPath = firstExisting([process.env.PLAYWRIGHT_CORE_PATH, path.join(root, 'node_modules/playwright-core'), path.join(root, 'node_modules/playwright'), 'D:/chatgpt/3dgongfang/studio/node_modules/playwright-core']);
const chromePath = firstExisting([process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium']);
if (!httpOnly && !playwrightPath) throw new Error('playwright-core not found: set PLAYWRIGHT_CORE_PATH');
if (!httpOnly && !chromePath) throw new Error('Chrome not found: set CHROME_PATH');
const chromium = httpOnly ? null : require(playwrightPath).chromium;

const port = Number(process.env.CHAIN_ACCEPTANCE_PORT || 3323);
const base = `http://127.0.0.1:${port}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yushe-chain-'));
const outDir = process.env.CHAIN_ACCEPTANCE_OUT || path.join(scratch, 'out');
fs.mkdirSync(outDir, { recursive: true });
const compiled = path.join(root, 'scripts', '.chain-acceptance');
fs.mkdirSync(compiled, { recursive: true });
for (const name of fs.readdirSync(path.join(root, 'packages/shared/src')).filter(f => f.endsWith('.ts'))) {
  fs.writeFileSync(path.join(compiled, name.replace(/\.ts$/, '.js')), ts.transpileModule(fs.readFileSync(path.join(root, 'packages/shared/src', name), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText);
}
process.env.IRENO_PGLITE_DIR = path.join(scratch, 'db');
const db = require('./.chain-acceptance/db.js');
const { calcQuote } = require('./.chain-acceptance/price.js');
const { generatePlanGeometry, planToSvg } = require('./.chain-acceptance/plan.js');
const { buildSceneModel } = require('./.chain-acceptance/scene3d.js');

const PASSWORD = 'DemoOnly2026!';
const BOSS_PHONE = '19900000000';
const BOSS_PASSWORD = crypto.randomBytes(12).toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let server, checks = 0;
const log = [];
const ok = (name, detail = '') => { checks++; log.push({ name, detail }); console.log('PASS', name, detail); };

async function api(route, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(base + route, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text.slice(0, 200); }
  return { status: res.status, json };
}
async function login(phone, password = PASSWORD) {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, password }) });
  assert.equal(res.status, 200, 'login ' + phone);
  return res.headers.get('set-cookie').split(';')[0];
}

async function seed() {
  const salt = crypto.randomBytes(16);
  const passwordHash = `scrypt$${salt.toString('base64')}$${crypto.scryptSync(PASSWORD, salt, 32).toString('base64')}`;
  const owner = await db.createUser({ role: 'homeowner', name: '合成业主', phone: '19900000001', passwordHash });
  const stranger = await db.createUser({ role: 'homeowner', name: '无关业主', phone: '19900000003', passwordHash });
  const mk = (suffix, name) => db.createUser({ role: 'company', name: name + '联系人', phone: '1990000001' + suffix, passwordHash, companyName: name,
    license: 'DEMO-LICENSE-NOT-REAL', membershipTier: 'basic', membershipStatus: 'pending_payment', monthlyLeadQuota: 30,
    districts: ['演示区'], serviceTypes: ['全包'], specialties: ['现代简约'] });
  const paid = await mk('1', '演示装修公司甲（已付费）');
  const unpaid = await mk('2', '演示装修公司乙（未付费）');
  // 第三家公司从未提交审核通过：老板「待处理事项」里应出现资质审核
  const pending = await mk('3', '演示装修公司丙（待审核）');
  await db.setUserVerified(paid.id, 1);
  await db.setUserVerified(unpaid.id, 1);
  const rooms = [{ name: '客厅', area: 30 }, { name: '主卧', area: 20 }, { name: '次卧', area: 15 }, { name: '厨房', area: 10 }, { name: '卫生间', area: 8 }];
  const project = await db.createProject({ homeownerId: owner.id, name: '主链验收｜合成项目', style: '现代简约', budget: '15', area: '83', address: 'PRIVATE-ADDRESS' });
  const geometry = generatePlanGeometry(rooms, { totalArea: 83 });
  const sceneModel = buildSceneModel(geometry, rooms, project.style, { source: 'floor_plan' });
  const chain = [
    ['floor_plan', [['plan', { rooms, geometry, source: 'user_studio', confidence: 'high', note: '合成数据，非模型识别', warnings: geometry.warnings }]]],
    ['designer', [['design', { svg: planToSvg(geometry, project.style, project.name), rooms, geometry, style: project.style, note: '合成数据' }],
      ['scene_model', sceneModel], ['decorations', { images: rooms.map(r => ({ room: r.name, url: '/interiors/living.jpg' })), style: project.style }]]],
    ['quote', [['quote', calcQuote(rooms, project.style)]]],
    ['qa', [['qa', { passed: true, checks: [], checkedAt: new Date().toISOString(), note: '合成夹具，非实际质检' }]]],
  ];
  for (const [i, [agent, results]] of chain.entries()) {
    const task = await db.claimNextTask(); assert.equal(task.toAgent, agent);
    for (const [kind, content] of results) await db.upsertResult(project.id, kind, content);
    await db.finishTask(task.id, { fixtureOnly: true }, 0, chain[i + 1] ? { nextAgent: chain[i + 1][0] } : { stage: 3 });
  }
  const quote = calcQuote(rooms, project.style);
  await (await db.getDb()).$client.close();
  return { projectId: project.id, paidId: paid.id, unpaidId: unpaid.id, quoteTotal: quote.total, strangerId: stranger.id, pendingCompanyName: '演示装修公司丙（待审核）' };
}

async function startServer(paidId) {
  const logFile = fs.openSync(path.join(scratch, 'server.log'), 'a');
  server = spawn(process.execPath, ['--require', path.join(root, 'scripts/test-payments.cjs'), path.join(root, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: path.join(root, 'apps/web'), windowsHide: true, stdio: ['ignore', logFile, logFile],
    env: { ...process.env, NODE_ENV: 'production', RUNNER_ENABLED: 'true', COOKIE_SECURE: 'false', SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
      LLM_API_KEY: '', AGNES_API_KEY: '', opcpay_api_key: 'test-fixture-only', TEST_PAYMENT_COMPANY_IDS: `company-${paidId}`,
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

async function waitFor(fn, what, tries = 60) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(1000); }
  throw new Error('timeout waiting for ' + what);
}

async function httpChain(s) {
  const ownerCookie = await login('19900000001');
  const strangerCookie = await login('19900000003');
  const paidCookie = await login('19900000011');
  const unpaidCookie = await login('19900000012');
  const bossCookie = await login(BOSS_PHONE, BOSS_PASSWORD);

  // 1. 发布：未确认方案不能发布；确认后才能发布；重复发布幂等
  let r = await api('/api/orders', { method: 'POST', body: { projectId: s.projectId }, cookie: ownerCookie });
  assert.equal(r.status, 409, 'publish without owner confirmation'); ok('发布前必须先确认当前一轮方案', `409 ${r.json.error}`);
  r = await api('/api/orders', { method: 'POST', body: { projectId: s.projectId }, cookie: strangerCookie });
  assert.equal(r.status, 403); ok('无关业主不能为别人的项目发布订单', '403');
  r = await api(`/api/projects/${s.projectId}/results`, { method: 'POST', body: { kind: 'decision', content: { adjustPct: 0 } }, cookie: ownerCookie });
  assert.equal(r.status, 200); ok('业主确认方案与报价', `finalTotal=${r.json.decision.finalTotal}`);
  r = await api('/api/orders', { method: 'POST', body: { projectId: s.projectId }, cookie: ownerCookie });
  assert.equal(r.status, 200); assert.equal(r.json.status, 'open');
  const orderId = r.json.id; ok('确认后发布到接单市场', `order ${orderId} open`);
  r = await api('/api/orders', { method: 'POST', body: { projectId: s.projectId }, cookie: ownerCookie });
  assert.equal(r.json.id, orderId); ok('重复发布返回同一订单（幂等）');

  // 2. 未付费公司：看不到接单市场、不能投标
  r = await api('/api/orders?status=open', { cookie: unpaidCookie });
  assert.equal(r.status, 402); ok('未付费公司看不到接单市场', '402');
  r = await api('/api/bids', { method: 'POST', body: { orderId, amount: String(s.quoteTotal / 10000), weeks: '8' }, cookie: unpaidCookie });
  assert.equal(r.status, 402, 'unpaid company bid refused'); ok('未付费公司不能投标（权益查询为需购买）', `402 ${r.json.error}`);
  r = await api('/api/projects/' + s.projectId, { cookie: unpaidCookie });
  assert.equal(r.status, 403); ok('未付费公司看不到项目详情', '403');

  // 3. 已付费公司：先刷新权益（真实使用时公司页面打开就会刷新），再看到接单市场、低价被拦、合理报价通过、不能重复投标
  r = await api('/api/orders?status=open', { cookie: paidCookie });
  assert.equal(r.status, 402); ok('付款前（权益未刷新）付费公司也看不到接单市场', '402');
  r = await api('/api/company/membership/access', { cookie: paidCookie });
  assert.equal(r.status, 200); assert.equal(r.json.active, true); ok('刷新权益：支付夹具返回有效会员，资质随付费通过', `active, expires ${r.json.expiresAt.slice(0, 10)}`);
  r = await api('/api/company/membership/access', { cookie: unpaidCookie });
  assert.equal(r.status, 200); assert.equal(r.json.active, false); ok('刷新权益：未付费公司仍为无效', 'active=false');
  r = await api('/api/orders?status=open', { cookie: paidCookie });
  assert.equal(r.status, 200); assert.ok(r.json.some(o => o.id === orderId)); ok('付费公司看得到接单市场里的订单');
  r = await api('/api/bids', { method: 'POST', body: { orderId, amount: String(s.quoteTotal * 0.5 / 10000), weeks: '8' }, cookie: paidCookie });
  assert.equal(r.status, 422); ok('明显低于合理区间的报价被拦截', `422 ${r.json.error}`);
  const amountWan = (s.quoteTotal / 10000).toFixed(2);
  r = await api('/api/bids', { method: 'POST', body: { orderId, amount: amountWan, weeks: '8', note: '合成投标，仅用于验收', estimatedCost: (s.quoteTotal * 0.8 / 10000).toFixed(2) }, cookie: paidCookie });
  assert.equal(r.status, 200, JSON.stringify(r.json)); ok('合理报价投标成功', `¥${amountWan} 万，8 周`);
  r = await api('/api/bids', { method: 'POST', body: { orderId, amount: amountWan, weeks: '8' }, cookie: paidCookie });
  assert.equal(r.status, 409); ok('同一公司同一项目不能重复投标', '409');

  // 4. 报价保密：公司只看自己的，业主看全部；无关业主不能看
  r = await api('/api/bids?orderId=' + orderId, { cookie: ownerCookie });
  assert.equal(r.status, 200); assert.equal(r.json.length, 1); ok('业主能看到投标', `${r.json.length} 份`);
  r = await api('/api/bids?orderId=' + orderId, { cookie: strangerCookie });
  assert.equal(r.status, 403); ok('无关业主不能看投标', '403');

  // 5. 投标触发匹配智能体（没有模型密钥，应按规则评分并如实标注）
  const match = await waitFor(async () => {
    const p = (await api('/api/projects/' + s.projectId, { cookie: ownerCookie })).json;
    return p.results?.find(x => x.kind === 'match')?.content;
  }, '匹配结果');
  assert.equal(match.matchedBy, 'rules'); assert.equal(match.contractors.length, 1);
  assert.match(match.contractors[0].reason, /报价与平台测算接近/);
  assert.match(match.summary, /暂不可用|规则/);
  ok('投标触发匹配；无模型密钥时如实按规则评分', `matchedBy=${match.matchedBy}, score=${match.contractors[0].score}`);
  assert.ok(!JSON.stringify(match).includes('PRIVATE-')); ok('匹配结果不含私有字段');

  // 6. 选定公司；已选定后合同工作流对三方可见、对无关人不可见
  r = await api('/api/orders/' + orderId, { method: 'PATCH', body: { status: 'matched', companyId: s.unpaidId }, cookie: ownerCookie });
  assert.equal(r.status, 400); ok('不能选定没有投标的公司', '400');
  r = await api('/api/orders/' + orderId, { method: 'PATCH', body: { status: 'matched', companyId: s.paidId }, cookie: strangerCookie });
  assert.equal(r.status, 403); ok('无关业主不能替别人选定公司', '403');
  r = await api('/api/orders/' + orderId, { method: 'PATCH', body: { status: 'matched', companyId: s.paidId }, cookie: ownerCookie });
  assert.equal(r.status, 200); assert.equal(r.json.status, 'matched'); assert.equal(r.json.companyId, s.paidId);
  ok('业主选定真实投标公司', `order ${orderId} matched`);
  r = await api('/api/orders/' + orderId, { method: 'PATCH', body: { status: 'contracted' }, cookie: ownerCookie });
  assert.equal(r.status, 400); ok('不能绕过合同流程直接把订单改成已签约', '400');
  for (const [who, cookie, expected] of [['业主', ownerCookie, 200], ['中选公司', paidCookie, 200], ['平台', bossCookie, 200], ['无关业主', strangerCookie, 403], ['落选公司', unpaidCookie, 403]]) {
    r = await api(`/api/orders/${orderId}/workflow`, { cookie });
    assert.equal(r.status, expected, who); ok(`合同工作流可见性：${who}`, String(r.status));
  }
  r = await api(`/api/orders/${orderId}/workflow`, { cookie: ownerCookie });
  assert.equal(r.json.status === undefined, false); ok('合同工作流起始状态', `status=${r.json.status}, revision=${r.json.revision}`);

  // Run a newly submitted project through the real Runner, with external model services disabled.
  const form = new FormData(); form.set('name', '合成流水线恢复验收'); form.set('area', '60'); form.set('style', '现代简约');
  const created = await fetch(base + '/api/projects', { method: 'POST', headers: { cookie: ownerCookie }, body: form });
  assert.equal(created.status, 200); const freshId = (await created.json()).id;
  await waitFor(async () => (await api(`/api/projects/${freshId}`, { cookie: ownerCookie })).json.tasks?.some(t => t.status === 'waiting_user'), '缺户型等待补充');
  ok('新建项目缺户型时等待用户补充，不生成假户型');
  r = await api(`/api/projects/${freshId}/results`, { method: 'POST', cookie: ownerCookie, body: { kind: 'floorplan', upsert: true, content: {
    rects: [{ name: '客厅', x: 0, y: 0, w: 400, d: 300 }, { name: '卧室', x: 400, y: 0, w: 400, d: 300 }],
  } } }); assert.equal(r.status, 200);
  r = await api(`/api/projects/${freshId}/resume`, { method: 'POST', cookie: ownerCookie }); assert.equal(r.status, 200); assert.equal(r.json.resumed, 1);
  const generated = await waitFor(async () => {
    const p = (await api(`/api/projects/${freshId}`, { cookie: ownerCookie })).json;
    return p.results?.some(x => x.kind === 'quote') && p.results?.some(x => x.kind === 'qa') ? p : null;
  }, '恢复后生成二维三维报价与质检');
  for (const kind of ['plan', 'design', 'scene_model', 'quote', 'qa']) assert.ok(generated.results.some(x => x.kind === kind), kind);
  assert.equal(generated.results.find(x => x.kind === 'plan').content.source, 'user_studio');
  ok('补充手绘房间后恢复真实任务链，生成二维、三维、报价及质检');
  r = await api(`/api/projects/${freshId}/delivery`, { cookie: ownerCookie });
  assert.equal(r.json.readyForReview, false);
  r = await api('/api/orders', { method: 'POST', cookie: ownerCookie, body: { projectId: freshId } }); assert.equal(r.status, 409);
  ok('图像服务未配置时如实标记缺图，禁止未齐备项目发布');
  return { orderId, ownerCookie };
}

async function browserChain(s, orderId) {
  const browser = await chromium.launch({ headless: true, executablePath: chromePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const out = [];
  try {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
      const page = await context.newPage();
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2);
      const step = { width: viewport.width };
      const signIn = async (phone, password) => {
        await page.goto(base + '/', { waitUntil: 'networkidle' });
        await page.locator('[data-auth="login"]').click();
        await page.getByPlaceholder('请输入注册手机号').fill(phone);
        await page.getByPlaceholder('请输入密码', { exact: true }).fill(password);
        await page.getByRole('button', { name: '登录', exact: true }).last().click();
        await page.waitForFunction(() => !!JSON.parse(localStorage.getItem('user') || '{}').role);
      };
      const signOut = async () => { await context.clearCookies(); await page.evaluate(() => localStorage.clear()); };

      // 公司端：「我的竞价」里有这份投标；「订单管理」里有中选订单，并能打开合同工作台
      await signIn('19900000011', PASSWORD);
      await page.goto(base + '/contractor', { waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: '以专业能力，获得长期项目' }).waitFor();
      await page.getByRole('button', { name: '我的竞价', exact: true }).click();
      await page.getByText('我的竞价记录').waitFor({ timeout: 20000 });
      await page.getByText(`${(s.quoteTotal / 10000).toFixed(2)}万`, { exact: false }).first().waitFor({ timeout: 20000 });
      step.companyBidRow = true;
      await page.getByRole('button', { name: '订单管理', exact: true }).click();
      await page.getByRole('button', { name: '打开签约与履约工作台' }).waitFor({ timeout: 20000 });
      step.companyOrderRow = true;
      await page.getByRole('button', { name: '打开签约与履约工作台' }).click();
      await page.getByText('待公司确认').first().waitFor({ timeout: 20000 });
      step.companyContractWorkbench = true;
      step.companyOverflow = await overflow();
      await page.screenshot({ path: path.join(outDir, `company-${viewport.width}.png`), fullPage: true });
      await signOut();

      // 老板端：七个标签逐个点开，并核对各自的内容
      await signIn(BOSS_PHONE, BOSS_PASSWORD);
      await page.goto(base + '/boss', { waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: '经营与交付中心' }).waitFor();
      step.bossConsole = true;
      const bossTab = name => page.getByRole('button', { name, exact: true }).click();
      // 待处理事项：订单跟进、待审核公司资质
      await page.getByText('订单跟进（第一单）').first().waitFor({ timeout: 20000 });
      await page.getByText('装修队资质审核').first().waitFor({ timeout: 20000 });
      await page.getByText(s.pendingCompanyName, { exact: false }).first().waitFor({ timeout: 20000 });
      step.bossApprovals = true;
      // 执行进度：任务记录里有四个环节的交接
      await bossTab('执行进度');
      await page.screenshot({path:path.join(outDir,`boss-tasks-${viewport.width}.png`),fullPage:true});
      fs.writeFileSync(path.join(outDir,`boss-tasks-${viewport.width}.txt`),await page.locator('body').innerText());
      await page.locator('thead th').filter({ hasText: /^交接$/ }).waitFor({ timeout: 20000 });
      await page.getByText('调度器 → 户型识别').first().waitFor({ timeout: 20000 });
      await page.getByText('报价工期 → 质检').first().waitFor({ timeout: 20000 });
      assert.ok(await page.getByText('已完成').count() >= 4, 'four finished fixture tasks');
      step.bossTasks = true;
      // 成本概览：任务总数、执行环节成本；合成夹具没有模型调用，Token 应为 0
      await bossTab('成本概览');
      await page.getByText('任务总数').waitFor({ timeout: 20000 });
      await page.getByText('模型调用成本 · 按执行环节').waitFor({ timeout: 20000 });
      step.bossCosts = true;
      // 合同与履约：订单行有「打开合同履约」，点开能看到合同工作台（平台方）
      await bossTab('合同与履约');
      await page.getByText('ORDER_' + orderId).first().waitFor({ timeout: 20000 });
      await page.getByRole('button', { name: '打开合同履约' }).click();
      await page.getByText('待公司确认').first().waitFor({ timeout: 20000 });
      await page.getByRole('button', { name: '关闭工作台' }).click();
      step.bossOrdersAndWorkbench = true;
      // 会员与入驻：付费公司刷新权益后应有一条「权益已确认」记录（本次没有走购买入口，所以也可能为空，按实际断言）
      await bossTab('会员与入驻');
      await page.getByText('企业会员为独立客户资源服务', { exact: false }).waitFor({ timeout: 20000 });
      step.bossMembership = true;
      // 历史利润分成：只读归档，没有历史记录时显示空状态
      await bossTab('历史利润分成（只读）');
      await page.getByText('仅供只读归档', { exact: false }).waitFor({ timeout: 20000 });
      await page.getByText('暂无利润分成记录').waitFor({ timeout: 20000 });
      step.bossCommissions = true;
      // 用户管理：能列出业主和公司；点「注销」只出现二次确认，取消后不删除
      await bossTab('用户管理');
      await page.getByText('合成业主').first().waitFor({ timeout: 20000 });
      await page.getByText(s.pendingCompanyName, { exact: false }).first().waitFor({ timeout: 20000 });
      const unpaidRow = page.locator('tr', { hasText: s.pendingCompanyName });
      await unpaidRow.getByRole('button', { name: '注销', exact: true }).click();
      await unpaidRow.getByRole('button', { name: '确认注销' }).waitFor({ timeout: 20000 });
      await unpaidRow.getByRole('button', { name: '取消' }).click();
      await unpaidRow.getByRole('button', { name: '注销', exact: true }).waitFor({ timeout: 20000 });
      step.bossUsersWithConfirm = true;
      step.bossOverflow = await overflow();
      await page.screenshot({ path: path.join(outDir, `boss-${viewport.width}.png`), fullPage: true });
      await signOut();

      // 业主端：项目页显示已选定公司，合同工作台出现
      await signIn('19900000001', PASSWORD);
      await page.goto(`${base}/project/${s.projectId}`, { waitUntil: 'networkidle' });
      await page.getByText('匹配的装修队').first().waitFor({ timeout: 20000 });
      step.ownerMatchPanel = true;
      // 选定公司后项目页隐藏竞标动态，直接显示合同工作台；起始状态是「待公司确认」
      await page.getByText('待公司确认').first().waitFor({ timeout: 20000 });
      step.ownerContractWorkbench = true; step.ownerOverflow = await overflow();
      await page.screenshot({ path: path.join(outDir, `owner-${viewport.width}.png`), fullPage: true });

      assert.equal(step.companyOverflow, false, 'company page horizontal overflow'); assert.equal(step.bossOverflow, false, 'boss page horizontal overflow'); assert.equal(step.ownerOverflow, false, 'owner page horizontal overflow');
      assert.deepEqual(errors, [], 'no uncaught page errors'); step.pageErrors = 0;
      out.push(step);
      await context.close();
    }
  } finally { await browser.close(); }
  return out;
}

(async () => {
  const s = await seed();
  await startServer(s.paidId);
  const { orderId } = await httpChain(s);
  const browser = httpOnly ? { skipped: 'Explicit --http-only; browser checks were not run' } : await browserChain(s, orderId);
  fs.writeFileSync(path.join(outDir, 'chain-acceptance.json'), JSON.stringify({ log, browser }, null, 2));
  console.log(JSON.stringify({ status: 'passed', fixture: 'synthetic accounts and saved results; no model or real payment calls', httpChecks: checks, browser, outDir }, null, 1));
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { if (server) server.kill(); });
