// Production HTTP verification with a fresh synthetic fixture. No model or payment calls.
// Run after npm run build: node scripts/delivery-http-smoke.cjs --isolated-demo
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const ts = require('typescript');
if (process.argv[2] !== '--isolated-demo') throw new Error('Explicit --isolated-demo is required');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yushe-delivery-http-'));
const compiled = path.join(root, 'scripts', '.delivery-http');
fs.mkdirSync(compiled, { recursive: true });
for (const name of fs.readdirSync(path.join(root, 'packages/shared/src')).filter(f => f.endsWith('.ts'))) {
  fs.writeFileSync(path.join(compiled, name.replace(/\.ts$/, '.js')), ts.transpileModule(fs.readFileSync(path.join(root, 'packages/shared/src', name), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText);
}
process.env.IRENO_PGLITE_DIR = path.join(scratch, 'db');
process.env.IRENO_UPLOAD_DIR = path.join(scratch, 'uploads');
const db = require('./.delivery-http/db.js');
const { calcQuote } = require('./.delivery-http/price.js');
let server;
let checks = 0;
const base = 'http://127.0.0.1:3314';
async function request(route, status, cookie, method = 'GET', body) {
  const res = await fetch(base + route, { method, headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  assert.equal(res.status, status, `${method} ${route}`); checks++;
  return res;
}
async function login(phone) {
  const res = await request('/api/auth/login', 200, null, 'POST', { phone, password: 'DemoOnly2026!' });
  return res.headers.get('set-cookie').split(';')[0];
}
(async () => {
  const salt = crypto.randomBytes(16);
  const passwordHash = `scrypt$${salt.toString('base64')}$${crypto.scryptSync('DemoOnly2026!', salt, 32).toString('base64')}`;
  const owner = await db.createUser({ role: 'homeowner', name: '合成业主', phone: '19900000001', passwordHash });
  await db.createUser({ role: 'company', name: '合成公司', phone: '19900000002', passwordHash });
  await db.createUser({ role: 'homeowner', name: '其他合成业主', phone: '19900000003', passwordHash });
  const project = await db.createProject({ homeownerId: owner.id, name: '交付接口测试｜合成夹具非AI输出', style: '现代简约', budget: '15', area: '90', address: 'PRIVATE-ADDRESS', floorPlanPath: 'PRIVATE-PATH' });
  const rooms = [{ name: '客厅', area: 50.4 }, { name: '卧室', area: 39.6 }];
  const output = {
    floor_plan: [['plan', { rooms, source: 'user_studio' }]],
    designer: [['design', { svg: '<svg />' }], ['scene_model', { schema: 'synthetic-test-only' }], ['decorations', { images: rooms.map(room => ({ room: room.name, url: '/synthetic-test-only.png' })) }]],
    quote: [['quote', calcQuote(rooms, project.style)]],
    qa: [['qa', { passed: true, note: 'Synthetic HTTP fixture, not model execution or actual QA' }]],
  };
  const chain = Object.keys(output);
  for (const [i, key] of chain.entries()) {
    const task = await db.claimNextTask(); assert.equal(task.toAgent, key);
    for (const [kind, content] of output[key]) await db.upsertResult(project.id, kind, content);
    await db.finishTask(task.id, { fixtureOnly: true, privateValue: 'PRIVATE-TASK-OUTPUT' }, 0, chain[i + 1] ? { nextAgent: chain[i + 1] } : { stage: 3 });
  }
  await db.saveResult(project.id, 'signature', { seal: 'PRIVATE-SEAL' });
  await (await db.getDb()).$client.close();
  const log = fs.openSync(path.join(scratch, 'server.log'), 'a');
  server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', '3314'], {
    cwd: path.join(root, 'apps/web'), windowsHide: true, stdio: ['ignore', log, log],
    env: { ...process.env, NODE_ENV: 'production', RUNNER_ENABLED: 'false', SESSION_SECRET: crypto.randomBytes(48).toString('hex'), COOKIE_SECURE: 'false', LLM_API_KEY: '', YIRENFU_API_KEY: '', BOSS_PHONE: '19900000000', BOSS_PASSWORD: 'DemoOnly2026!' },
  });
  fs.closeSync(log);
  let started = false;
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error('Isolated server exited; inspect ' + scratch);
    try { if ((await fetch(base + '/opc')).ok) { started = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(started, 'isolated server started');
  const page = await (await request('/opc', 200)).text();
  for (const title of ['商业模式画布', '岗位说明书', '交付与验收', '5 分钟演示流程']) assert.ok(page.includes(title), title);
  const materials = await (await request('/docs/opc-materials.md', 200)).text();
  assert.ok(materials.includes('赛事规定 48 小时内新增'));
  await request(`/api/projects/${project.id}/delivery`, 401);
  const ownerCookie = await login('19900000001');
  const companyCookie = await login('19900000002');
  const strangerCookie = await login('19900000003');
  const bossCookie = await login('19900000000');
  await request('/api/auth/login', 400, null, 'POST', null);
  const malformedLogin = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(malformedLogin.status, 400); checks++;
  const tasksBeforeInvalid = (await (await request(`/api/projects/${project.id}`, 200, ownerCookie)).json()).tasks.length;
  for (const operation of ['replan', 'recheck']) {
    await request(`/api/projects/${project.id}/${operation}`, 400, ownerCookie, 'POST', null);
    await request(`/api/projects/${project.id}/${operation}`, 400, ownerCookie, 'POST', { reason: { unexpected: true } });
    for (const invalidBody of ['{', '[]']) {
      const invalid = await fetch(base + `/api/projects/${project.id}/${operation}`, { method: 'POST', headers: { cookie: ownerCookie, 'content-type': 'application/json' }, body: invalidBody });
      assert.equal(invalid.status, 400); checks++;
    }
  }
  const tasksAfterInvalid = (await (await request(`/api/projects/${project.id}`, 200, ownerCookie)).json()).tasks.length;
  assert.equal(tasksAfterInvalid, tasksBeforeInvalid, 'invalid requests must not queue any tasks');
  await request(`/api/projects/${project.id}/delivery`, 403, companyCookie);
  await request(`/api/projects/${project.id}/delivery`, 403, strangerCookie);
  await request('/api/projects/invalid/delivery', 400, ownerCookie);
  const res = await request(`/api/projects/${project.id}/delivery?download=1`, 200, ownerCookie);
  assert.match(res.headers.get('content-disposition'), /attachment/);
  assert.match(res.headers.get('cache-control'), /no-store/);
  const report = await res.json();
  assert.equal(report.readyForReview, true);
  assert.equal(report.completedStages, 4);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE-/);
  await request(`/api/projects/${project.id}/delivery`, 200, bossCookie);
  await request(`/api/projects/${project.id}/results`, 200, ownerCookie, 'POST', { kind: 'decision', content: { adjustPct: 0 } });
  await request(`/api/projects/${project.id}/replan`, 200, ownerCookie, 'POST', { reason: 'Synthetic rerun test' });
  const rerun = await (await request(`/api/projects/${project.id}/delivery`, 200, ownerCookie)).json();
  assert.equal(rerun.readyForReview, false);
  assert.equal(rerun.completedStages, 0);
  assert.equal(rerun.stages[1].status, 'stale');
  await request(`/api/projects/${project.id}/results`, 409, ownerCookie, 'POST', { kind: 'decision', content: { adjustPct: 0 } });
  await request('/api/orders', 409, ownerCookie, 'POST', { projectId: project.id });

  // Exercise public registration and project creation instead of relying only on seeded accounts.
  const registration = { role: 'homeowner', name: '合成注册业主', phone: '19900000009', password: 'DemoOnly2026!' };
  await request('/api/auth/register', 400, null, 'POST', { ...registration, role: 'boss' });
  await request('/api/auth/register', 400, null, 'POST', { ...registration, password: 'short' });
  const registered = await request('/api/auth/register', 200, null, 'POST', registration);
  const registeredCookie = registered.headers.get('set-cookie').split(';')[0];
  const identity = await (await request('/api/auth/me', 200, registeredCookie)).json();
  assert.equal(identity.name, registration.name); assert.equal(identity.passwordHash, undefined);
  await request('/api/auth/register', 409, null, 'POST', registration);
  await request('/api/auth/login', 401, null, 'POST', { phone: registration.phone, password: 'wrong-password' });
  await request('/api/auth/logout', 200, registeredCookie, 'POST');
  const signedOut = await request('/api/auth/logout', 200, registeredCookie, 'POST');
  const expiredCookie = signedOut.headers.get('set-cookie').split(';')[0];
  await request('/api/auth/me', 401, expiredCookie);
  const newCookie = await login(registration.phone);
  for (const floorPlan of ['not-a-file', new Blob(['not-an-image'], { type: 'image/png' })]) {
    const invalid = new FormData(); invalid.set('name', '合成非法上传'); invalid.set('floorPlan', floorPlan);
    const response = await fetch(base + '/api/projects', { method: 'POST', headers: { cookie: newCookie }, body: invalid });
    assert.equal(response.status, 400, 'invalid floorPlan must not silently create a project'); checks++;
  }
  const upload = new FormData(); upload.set('name', '合成有效上传');
  upload.set('floorPlan', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }), '../../outside.png');
  const uploaded = await fetch(base + '/api/projects', { method: 'POST', headers: { cookie: newCookie }, body: upload });
  assert.equal(uploaded.status, 200); checks++;
  const uploadedId = (await uploaded.json()).id;
  const uploadedProject = (await (await request(`/api/projects/${uploadedId}`, 200, newCookie)).json()).project;
  assert.match(path.basename(uploadedProject.floorPlanPath), /^[a-f0-9-]{36}\.png$/);
  assert.equal(fs.existsSync(uploadedProject.floorPlanPath), true);
  await request(`/api/projects/${uploadedId}`, 200, newCookie, 'DELETE');
  assert.equal(fs.existsSync(uploadedProject.floorPlanPath), false, 'deleting a project cleans its uploaded file');
  async function createForm() {
    const form = new FormData(); form.set('name', '合成表单新项目'); form.set('area', '56.5');
    form.set('style', '现代简约'); form.set('budget', '10'); form.set('requestKey', 'synthetic-project-retry');
    const response = await fetch(base + '/api/projects', { method: 'POST', headers: { cookie: newCookie }, body: form });
    assert.equal(response.status, 200); checks++; return response.json();
  }
  const created = await createForm(), retried = await createForm(); assert.equal(created.id, retried.id);
  await request(`/api/projects/${created.id}`, 403, ownerCookie);
  await request(`/api/projects/${created.id}`, 200, newCookie);
  await request(`/api/projects/${created.id}`, 403, ownerCookie, 'DELETE');
  await request(`/api/projects/${created.id}`, 200, newCookie, 'DELETE');
  await request(`/api/projects/${created.id}`, 403, newCookie);
  await request(`/api/projects/${created.id}`, 404, bossCookie);

  const companyRegistration = { ...registration, role: 'company', phone: '19900000008', companyName: '合成注册公司', membershipTier: 'basic', billingCycle: 'monthly' };
  const companyResponse = await request('/api/auth/register', 200, null, 'POST', companyRegistration);
  const newCompanyCookie = companyResponse.headers.get('set-cookie').split(';')[0];
  const newCompany = await companyResponse.json();
  await request('/api/orders?status=open', 403, newCompanyCookie);
  await request(`/api/users/${newCompany.id}/verify`, 403, newCompanyCookie, 'POST', { action: 'approve' });
  await request(`/api/users/${newCompany.id}/verify`, 200, bossCookie, 'POST', { action: 'approve' });
  await request('/api/orders?status=open', 402, newCompanyCookie);
  await request(`/api/projects/${project.id}/replan`, 200, ownerCookie, 'POST');
  console.log(JSON.stringify({ status: 'passed', requests: checks, fixture: 'synthetic saved artifacts, no model/payment calls', evidenceDirectory: scratch }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { if (server) server.kill(); });
