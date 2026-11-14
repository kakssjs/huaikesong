// Isolated local verification fixture. Never grants rights in an existing database.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const { eq } = require('drizzle-orm');
const root = path.resolve(__dirname, '..');
const destination = process.env.IRENO_PGLITE_DIR;
if (process.env.NODE_ENV === 'production' || process.argv[2] !== '--isolated-demo' || !destination || !path.isAbsolute(destination)) {
  throw new Error('Only allowed with --isolated-demo and a new absolute IRENO_PGLITE_DIR outside production');
}
const resolved = path.resolve(destination);
if (resolved === path.parse(resolved).root || fs.existsSync(resolved)) {
  throw new Error('Refusing to overwrite an existing database; choose a new isolated demo directory');
}
const runtime = path.join(__dirname, '.contract-http');
fs.mkdirSync(runtime, { recursive: true });
for (const file of fs.readdirSync(path.join(root, 'packages/shared/src')).filter(x => x.endsWith('.ts'))) {
  fs.writeFileSync(path.join(runtime, file.replace(/\.ts$/, '.js')), ts.transpileModule(
    fs.readFileSync(path.join(root, 'packages/shared/src', file), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText);
}
const db = require('./.contract-http/db.js');
function hash(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${crypto.scryptSync(password, salt, 32).toString('base64')}`;
}
(async () => {
  const passwordHash = hash('DemoOnly2026!');
  const owner = await db.createUser({ role: 'homeowner', name: '演示业主 合成资料', phone: '19900000001', passwordHash });
  const company = await db.createUser({ role: 'company', name: '演示公司授权人', companyName: '演示装修公司 合成主体',
    phone: '19900000002', passwordHash, license: 'DEMO-LICENSE-NOT-REAL', membershipStatus: 'active' });
  const stranger = await db.createUser({ role: 'homeowner', name: '隔离权限测试账号', phone: '19900000003', passwordHash });
  const storage = await db.getDb();
  await storage.update(db.users).set({ verified: 1, membershipStatus: 'active',
    membershipExpiresAt: '2099-01-01T00:00:00.000Z', monthlyLeadQuota: 30 }).where(eq(db.users.id, company.id));
  const project = await db.createProject({ homeownerId: owner.id, name: '合同履约演示 合成90㎡项目', style: '现代简约',
    budget: '10', area: '90', city: '演示城市', address: '演示地址 非真实住宅', needs: '墙面和地面装修，资料仅供演示' });
  await db.upsertResult(project.id, 'quote', { total: 100000, items: [{ item: '演示施工项目', qty: 1, unit: '项', price: 100000, total: 100000, source: '合成演示价格 非市场报价' }], weeks: 8 });
  await db.upsertResult(project.id, 'qa', { passed: true });
  await db.upsertResult(project.id, 'decision', { confirmed: true, mode: 'demo' });
  const order = await db.createOrder({ projectId: project.id, homeownerId: owner.id });
  await db.createBid({ orderId: order.id, companyId: company.id, companyName: company.companyName, amount: '10', weeks: '8', note: '仅用于隔离本地演示' });
  await db.selectOrderCompany(order.id, company.id);
  const state = { mode: 'demo', database: resolved, ownerId: owner.id, companyId: company.id, strangerId: stranger.id,
    projectId: project.id, orderId: order.id };
  fs.writeFileSync(path.join(runtime, 'state.json'), JSON.stringify(state, null, 2));
  console.log(JSON.stringify(state));
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  await (await db.getDb()).$client.close();
});
