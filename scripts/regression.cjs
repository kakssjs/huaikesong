const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ts = require('typescript');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const dir = path.join(__dirname, '.regression');
fs.mkdirSync(dir, { recursive: true });
for (const name of fs.readdirSync(path.join(__dirname, '../packages/shared/src')).filter(f => f.endsWith('.ts'))) {
  const source = fs.readFileSync(path.join(__dirname, '../packages/shared/src', name), 'utf8');
  fs.writeFileSync(path.join(dir, name.replace(/\.ts$/, '.js')), ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText);
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'irenovation-regression-'));
process.env.IRENO_PGLITE_DIR = dataDir;
const db = require('./.regression/db.js');

test('project execution footer distinguishes running, review-ready and incomplete delivery', () => {
  const source = fs.readFileSync(path.join(__dirname, '../apps/web/app/project/[id]/page.tsx'), 'utf8');
  const tree = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  let phase;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'phaseLabel') phase = node.initializer.getText(tree);
    if (ts.isJsxExpression(node) && node.expression?.getText(tree).includes('流水线已暂停 — 请按上方提示')) expression = node.expression.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  const footer = new Function('tasks', 'delivery', 'waitingTasks', 'escalatedTasks', `return (${expression})`);
  assert.match(footer([{ status: 'running' }], { readyForReview: false }, [], []), /生成中/);
  assert.match(footer([{ status: 'done' }], { readyForReview: false }, [], []), /待修正/);
  assert.match(footer([{ status: 'done' }], { readyForReview: true }, [], []), /待.*确认/);
  assert.match(footer([], {}, [{}], []), /补充户型/);
  assert.match(footer([], {}, [], [{}]), /人工处理/);
  const label = new Function('order', 'delivery', 'data', `return (${phase})`);
  assert.equal(label(null, { readyForReview: false }, { project: { stage: 3 } }), '方案待复核');
  assert.equal(label(null, { readyForReview: true }, { project: { stage: 3 } }), '待业主确认');
  assert.equal(label({}, {}, {}), '施工匹配');
  assert.equal(label(null, {}, { project: { stage: 1 } }), '方案设计');
});

test('authentication changes reload the destination even when it is the current route', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../apps/web/app/components/AuthNav.tsx'), 'utf8');
  const tree = ts.createSourceFile('AuthNav.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = {};
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && ['handleSuccess', 'logout'].includes(node.name?.text)) functions[node.name.text] = node.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  const destinations = [];
  const context = vm.createContext({ window: { location: { assign: url => destinations.push(url) } },
    router: { push() {} }, setUser() {}, setModalMode() {}, localStorage: { setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: true }) });
  vm.runInContext(ts.transpileModule(Object.values(functions).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  for (const role of ['homeowner', 'company', 'boss']) context.handleSuccess({ id: 1, role, name: 'synthetic' });
  await context.logout();
  assert.deepEqual(destinations, ['/dashboard', '/contractor', '/boss', '/']);
  const alerts = [];
  context.window.alert = message => alerts.push(message);
  context.fetch = async () => ({ ok: false });
  await context.logout();
  context.fetch = async () => { throw new Error('offline'); };
  await context.logout();
  assert.equal(destinations.length, 4, 'failed logout must not navigate as though the session ended');
  assert.equal(alerts.length, 2, 'both server failure and offline logout must be visible');
  context.fetch = async () => ({ ok: true });
  context.localStorage.setItem = context.localStorage.removeItem = () => { throw new Error('storage blocked'); };
  context.handleSuccess({ id: 1, role: 'homeowner', name: 'synthetic' });
  await context.logout();
  assert.deepEqual(destinations.slice(-2), ['/dashboard', '/'], 'browser storage failure must not block session navigation');
});

test('project submission uses the server session even when browser identity cache is unavailable', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../apps/web/app/components/NewProjectForm.tsx'), 'utf8');
  const tree = ts.createSourceFile('NewProjectForm.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let submit;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'submit') submit = node.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  const destinations = [], errors = [], requests = [];
  const context = vm.createContext({ busy: false, setBusy() {}, setError: value => errors.push(value),
    requestKey: { current: 'synthetic-retry' }, FormData: class { set() {} },
    localStorage: { getItem() { throw new Error('storage unavailable'); } }, navigator: { onLine: true },
    router: { push: url => destinations.push(url) },
    fetch: async url => { requests.push(url); return { ok: true, status: 200, json: async () => ({ id: 42 }) }; } });
  vm.runInContext(ts.transpileModule(submit, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  await context.submit({ preventDefault() {}, currentTarget: {} });
  assert.deepEqual(requests, ['/api/auth/me', '/api/projects']);
  assert.deepEqual(destinations, ['/project/42']);
  assert.deepEqual(errors, ['']);
});

test('navigation and account pages recover identity from the server rather than stale browser cache', async () => {
  const vm = require('node:vm');
  for (const [file, role] of [['components/AuthNav.tsx', 'homeowner'], ['dashboard/page.tsx', 'homeowner'], ['contractor/page.tsx', 'company']]) {
    const source = fs.readFileSync(path.join(__dirname, '../apps/web/app', file), 'utf8');
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let effect;
    function visit(node) {
      if (!effect && ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect') effect = node.arguments[0].getText(tree);
      ts.forEachChild(node, visit);
    }
    visit(tree);
    for (const blockedStorage of [false, true]) {
      const users = [], calls = [], identity = { id: 42, role, name: 'server identity' };
      const context = vm.createContext({ setUser: user => users.push(user), setAuthChecked() {},
        localStorage: { getItem() { if (blockedStorage) throw new Error('storage blocked'); return JSON.stringify({ id: 99, role, name: 'stale identity' }); }, setItem() {}, removeItem() {} },
        fetch: async url => { calls.push(url); return { ok: true, status: 200, json: async () => identity }; } });
      vm.runInContext(ts.transpileModule(`(${effect})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
      await new Promise(setImmediate);
      assert.equal(users.at(-1)?.id, 42, `${file}: server identity with blockedStorage=${blockedStorage}`);
      assert.ok(calls.includes('/api/auth/me'));
    }
  }
});

test('bid matching compares bid and reference quote in yuan', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../apps/web/lib/runner.ts'), 'utf8');
  const tree = ts.createSourceFile('runner.ts', source, ts.ScriptTarget.Latest, true);
  const scoreBid = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'scoreBid');
  const context = vm.createContext({ evaluateBidRisk: require('./.regression/fair-bidding.js').evaluateBidRisk });
  vm.runInContext(ts.transpileModule(scoreBid.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const bid = amount => context.scoreBid(undefined, { amount, weeks: '8' }, '现代简约', 100000);
  assert.match(bid('10').reason, /报价与平台测算接近/);
  assert.match(bid('13').reason, /报价基本合理/);
  assert.match(bid('20').reason, /报价明显高于平台测算/);
  assert.match(bid('6').reason, /报价低于平台测算/);
  assert.ok(bid('10').score > bid('20').score);
});
after(async () => { await (await db.getDb()).$client.close(); fs.rmSync(dataDir, { recursive: true }); });
test('project publication retries produce a single order', async () => {
  const owner = await db.createUser({ role: 'homeowner', name: 'test' });
  const p = await db.createProject({ homeownerId: owner.id, name: 'test', style: '现代简约', budget: '15' });
  const [a, b] = await Promise.all([1, 2].map(() => db.createOrder({ projectId: p.id, homeownerId: owner.id })));
  assert.equal(a.id, b.id);
});
test('concurrent task claims cannot claim the same task', async () => {
  const claimed = await Promise.all([db.claimNextTask(), db.claimNextTask()]);
  const ids = claimed.filter(Boolean).map(t => t.id);
  assert.equal(new Set(ids).size, ids.length);
});
test('second retry stays pending for the configured third attempt', async () => {
  const t = await db.createTask(1, 'test', 'floor_plan', {});
  await db.failTask(t.id, 2);
  const row = (await db.listTasks(1)).find(x => x.id === t.id);
  assert.equal(row.status, 'pending');
});
test('duplicate phone registration cannot create multiple accounts', async () => {
  await db.createUser({ role: 'homeowner', name: 'test', phone: '19912340001' });
  await assert.rejects(db.createUser({ role: 'homeowner', name: 'other', phone: '19912340001' }));
});
test('membership, bidding, selection, concurrent confirmations and signatures form one transaction-safe lifecycle', async () => {
  const owner = await db.createUser({ role: 'homeowner', name: 'owner' });
  const company = await db.createUser({ role: 'company', name: 'company' });
  await db.setUserVerified(company.id, 1);
  await db.setCompanyMembership(company.id, { membershipTier: 'basic', membershipStatus: 'active',
    membershipExpiresAt: new Date(Date.now() + 86400000).toISOString(), monthlyLeadQuota: 30 });
  const p = await db.createProject({ homeownerId: owner.id, name: 'lifecycle', style: '现代简约', budget: '15' });
  const order = await db.createOrder({ projectId: p.id, homeownerId: owner.id });
  await assert.rejects(db.createContract({ orderId: order.id, content: 'premature' }));
  const offers = await Promise.allSettled([1, 2].map(() => db.createBid({ orderId: order.id, companyId: company.id,
    companyName: 'company', amount: '15', weeks: '8', estimatedCostCny: 120000, commissionBasis: 'estimated_cost' })));
  assert.equal(offers.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await db.getUser(company.id)).monthlyLeadsUsed, 1);
  const selected = await db.selectOrderCompany(order.id, company.id);
  assert.equal(selected.bidAmount, '15');
  await Promise.all([db.confirmOrder(order.id, 'homeowner'), db.confirmOrder(order.id, 'company')]);
  assert.equal((await db.getOrder(order.id)).status, 'confirmed');
  const contracts = await Promise.all([1, 2].map(() => db.createContract({ orderId: order.id, content: 'test contract' })));
  assert.equal(contracts[0].id, contracts[1].id);
  await Promise.all([db.signContract(contracts[0].id, 'homeowner'), db.signContract(contracts[0].id, 'company')]);
  assert.equal((await db.getOrder(order.id)).status, 'contracted');
  assert.equal((await db.getCommissionSettlementByOrder(order.id)).platformCommissionCny, 3000);
  await db.signContract(contracts[0].id, 'company');
  await db.confirmOrder(order.id, 'homeowner');
  assert.equal((await db.getOrder(order.id)).status, 'contracted');
  // V2 preserves already-signed historical contracts and settlement facts.
  await assert.rejects(db.deleteProject(p.id), /保留|已签/);
  assert.ok(await db.getCommissionSettlementByOrder(order.id));
  assert.ok(await db.getProject(p.id));
});
test('invalid overwrite rolls back the original result and interrupted tasks are recoverable', async () => {
  const p = await db.createProject({ name: 'rollback', style: '现代简约', budget: '10' });
  await db.upsertResult(p.id, 'test', { original: true });
  await assert.rejects(db.upsertResult(p.id, 'test', null));
  assert.deepEqual((await db.getResult(p.id, 'test')).content, { original: true });
  const t = await db.claimNextTask();
  assert.ok(t);
  await db.recoverRunningTasks();
  assert.equal((await db.listTasks(t.projectId)).find(x => x.id === t.id).status, 'pending');
});
test('retrying project submission with the same request key does not create duplicate projects or tasks', async () => {
  const owner = await db.createUser({ role: 'homeowner', name: 'retry' });
  const input = { homeownerId: owner.id, requestKey: 'request-1', name: 'test', style: '现代简约', budget: '15' };
  const [a, b] = await Promise.all([db.createProject(input), db.createProject(input)]);
  assert.equal(a.id, b.id);
  assert.equal((await db.listTasks(a.id)).length, 1);
});
test('email codes are single-use under concurrent requests and quota cannot be bypassed concurrently', async () => {
  const crypto = require('node:crypto');
  const digest = crypto.createHash('sha256').update('123456').digest('hex');
  await db.saveEmailCode('test-email', digest, 60);
  const consumed = await Promise.all([db.consumeEmailCodeHash('test-email', digest), db.consumeEmailCodeHash('test-email', digest)]);
  assert.equal(consumed.filter(Boolean).length, 1);
  const quota = await Promise.all([1, 2, 3].map(() => db.takeEmailQuota('test-limit', 60, 1)));
  assert.equal(quota.filter(Boolean).length, 1);
});
test('finishing a task schedules its next agent in the same commit and rerunning does not duplicate it', async () => {
  const p = await db.createProject({ name: 'chain', style: '现代简约', budget: '10' });
  let claimed;
  do { claimed = await db.claimNextTask(); } while (claimed && claimed.projectId !== p.id);
  assert.ok(claimed);
  await db.finishTask(claimed.id, { ok: true }, 123, { nextAgent: 'designer' });
  await db.finishTask(claimed.id, { ok: true }, 123, { nextAgent: 'designer' });
  const rows = await db.listTasks(p.id);
  assert.equal(rows.find(t => t.id === claimed.id).tokensCost, 123);
  assert.equal(rows.filter(t => t.toAgent === 'designer').length, 1);
});
test('real email code logic delivers to a test outbox, accepts once and rejects exhausted codes', async () => {
  for (const file of ['auth', 'email']) {
    const source = fs.readFileSync(path.join(__dirname, '../apps/web/lib', file + '.ts'), 'utf8');
    fs.writeFileSync(path.join(dir, file + '.js'), ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText.replaceAll("require(\"@i-renovation/shared\")", "require(\"./index.js\")"));
  }
  process.env.SESSION_SECRET = 'isolated-test-secret-12345678901234567890';
  process.env.NODE_ENV = 'test';
  process.env.EMAIL_ENABLED = 'true';
  process.env.EMAIL_DEV_OUTBOX = path.join(dataDir, 'outbox.jsonl');
  const email = require('./.regression/email.js');
  await email.issueCode('qa@example.test', 'register', '127.0.0.1');
  const first = JSON.parse(fs.readFileSync(process.env.EMAIL_DEV_OUTBOX, 'utf8').trim());
  assert.equal(await email.consumeCode('qa@example.test', first.code, 'register'), true);
  assert.equal(await email.consumeCode('qa@example.test', first.code, 'register'), false);
  await email.issueCode('locked@example.test', 'register', '127.0.0.2');
  const last = JSON.parse(fs.readFileSync(process.env.EMAIL_DEV_OUTBOX, 'utf8').trim().split('\n').at(-1));
  const wrong = last.code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal(await email.consumeCode('locked@example.test', wrong, 'register'), false);
  assert.equal(await email.consumeCode('locked@example.test', last.code, 'register'), false);
});
test('boss task decisions are persisted and cannot silently approve already-completed tasks', async () => {
  const p = await db.createProject({ name: 'decision', style: '现代简约', budget: '10' });
  const [t] = await db.listTasks(p.id);
  await db.escalateTask(t.id, { reason: 'test failure' });
  await db.decideTask(t.id, 'retry');
  assert.equal((await db.listTasks(p.id))[0].status, 'pending');
  await db.escalateTask(t.id, { reason: 'test again' });
  await db.decideTask(t.id, 'dismiss');
  assert.equal((await db.listTasks(p.id))[0].status, 'cancelled');
  await assert.rejects(db.decideTask(t.id, 'retry'));
});
