const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ts = require('typescript');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { eq } = require('drizzle-orm');
const runtime = path.join(__dirname, '.chat-test');
fs.mkdirSync(runtime, { recursive: true });
for (const file of fs.readdirSync(path.join(__dirname, '../packages/shared/src')).filter(f => f.endsWith('.ts'))) {
  fs.writeFileSync(path.join(runtime, file.replace(/\.ts$/, '.js')), ts.transpileModule(fs.readFileSync(path.join(__dirname, '../packages/shared/src', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText);
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yushe-chat-test-'));
process.env.IRENO_PGLITE_DIR = dataDir;
const db = require('./.chat-test/db.js');
const chat = fs.existsSync(path.join(runtime, 'chat-db.js')) ? require('./.chat-test/chat-db.js') : {};
let owner, company, otherCompany, stranger;
before(async () => {
  owner = await db.createUser({ role: 'homeowner', name: '合成业主' });
  company = await db.createUser({ role: 'company', name: '合成公司联系人', companyName: '合成装修公司' });
  otherCompany = await db.createUser({ role: 'company', name: '其他公司' });
  stranger = await db.createUser({ role: 'homeowner', name: '其他业主' });
});
after(async () => { await (await db.getDb()).$client.close(); fs.rmSync(dataDir, { recursive: true }); });
const actor = u => ({ uid: u.id, role: u.role });
async function fixture(selected = true) {
  assert.equal(typeof chat.openOrderConversation, 'function', 'chat service must be implemented');
  const project = await db.createProject({ homeownerId: owner.id, name: '聊天测试合成项目', style: '现代简约', budget: '15' });
  const order = await db.createOrder({ projectId: project.id, homeownerId: owner.id });
  if (selected) await (await db.getDb()).update(db.orders).set({ companyId: company.id, status: 'matched' }).where(eq(db.orders.id, order.id));
  return { project, order };
}
test('communication only opens after selection, never for other companies or homeowners', async () => {
  const { order } = await fixture(false);
  await assert.rejects(chat.openOrderConversation(order.id, actor(owner)), e => e.status === 409);
  await (await db.getDb()).update(db.orders).set({ companyId: company.id, status: 'matched' }).where(eq(db.orders.id, order.id));
  await assert.rejects(chat.openOrderConversation(order.id, actor(otherCompany)), e => e.status === 403);
  await assert.rejects(chat.openOrderConversation(order.id, actor(stranger)), e => e.status === 403);
  const a = await chat.openOrderConversation(order.id, actor(owner));
  const b = await chat.openOrderConversation(order.id, actor(company));
  assert.equal(a.id, b.id);
});
test('concurrent entry creates one conversation', async () => {
  const { order } = await fixture();
  const rows = await Promise.all([actor(owner), actor(company)].map(a => chat.openOrderConversation(order.id, a)));
  assert.equal(rows[0].id, rows[1].id);
});
test('messages are isolated and preserve plain text without becoming business commands', async () => {
  const { order } = await fixture();
  const c = await chat.openOrderConversation(order.id, actor(owner));
  const m = await chat.sendConversationMessage(c.id, actor(owner), { text: '  墙面改暖白色 <script>alert(1)</script>  ', clientKey: 'plain-text-1' });
  assert.equal(m.senderId, owner.id);
  assert.equal(m.text, '墙面改暖白色 <script>alert(1)</script>');
  await assert.rejects(chat.readConversationMessages(c.id, actor(stranger)), e => e.status === 403);
  await assert.rejects(chat.sendConversationMessage(c.id, actor(otherCompany), { text: '越权', clientKey: 'invalid-key-1' }), e => e.status === 403);
  assert.equal((await db.getOrder(order.id)).status, 'matched');
  assert.equal((await chat.readConversationMessages(c.id, actor(company))).messages.length, 1);
});
test('send retries are idempotent and a reused key cannot change message content', async () => {
  const { order } = await fixture();
  const c = await chat.openOrderConversation(order.id, actor(owner));
  const body = { text: '厨房插座预留三个', clientKey: 'retry-message-1' };
  const rows = await Promise.all([1, 2].map(() => chat.sendConversationMessage(c.id, actor(owner), body)));
  assert.equal(rows[0].id, rows[1].id);
  await assert.rejects(chat.sendConversationMessage(c.id, actor(owner), { ...body, text: '修改原文' }), e => e.status === 409);
  await assert.rejects(chat.sendConversationMessage(c.id, actor(owner), { text: ' ', clientKey: 'empty-message' }), e => e.status === 400);
  await assert.rejects(chat.sendConversationMessage(c.id, actor(owner), { text: 'a'.repeat(2001), clientKey: 'long-message' }), e => e.status === 400);
});
test('read cursor is scoped to displayed messages and never moves backwards', async () => {
  const { order } = await fixture();
  const c = await chat.openOrderConversation(order.id, actor(owner));
  const a = await chat.sendConversationMessage(c.id, actor(owner), { text: '第一条', clientKey: 'read-first-msg' });
  const b = await chat.sendConversationMessage(c.id, actor(owner), { text: '新到的一条', clientKey: 'read-second-msg' });
  await chat.markConversationRead(c.id, actor(company), a.id);
  let row = (await chat.listConversations(actor(company))).find(r => r.id === c.id);
  assert.equal(row.unreadCount, 1);
  await chat.markConversationRead(c.id, actor(company), b.id);
  await chat.markConversationRead(c.id, actor(company), a.id);
  row = (await chat.listConversations(actor(company))).find(r => r.id === c.id);
  assert.equal(row.unreadCount, 0);
  const f2 = await fixture(); const c2 = await chat.openOrderConversation(f2.order.id, actor(owner));
  const foreign = await chat.sendConversationMessage(c2.id, actor(owner), { text: '其他会话', clientKey: 'foreign-message' });
  await assert.rejects(chat.markConversationRead(c.id, actor(company), foreign.id), e => e.status === 400);
});
test('history and incremental pages have no gaps or duplicates', async () => {
  const { order } = await fixture(); const c = await chat.openOrderConversation(order.id, actor(owner));
  for (let i = 0; i < 55; i++) await chat.sendConversationMessage(c.id, actor(owner), { text: `消息${i}`, clientKey: `pagination-${i}` });
  const recent = await chat.readConversationMessages(c.id, actor(company));
  assert.equal(recent.messages.length, 50); assert.equal(recent.hasMore, true);
  const older = await chat.readConversationMessages(c.id, actor(company), { before: recent.messages[0].id });
  assert.equal(older.messages.length, 5);
  const all = [...older.messages, ...recent.messages];
  assert.equal(new Set(all.map(m => m.id)).size, 55);
  const next = await chat.readConversationMessages(c.id, actor(company), { after: all[0].id });
  assert.equal(next.messages.length, 50); assert.equal(next.hasMore, true);
  const tail = await chat.readConversationMessages(c.id, actor(company), { after: next.messages.at(-1).id });
  assert.equal(tail.messages.length, 4);
});
test('old company keeps read-only history after replacement and cannot read the new conversation', async () => {
  const { order } = await fixture(); const c = await chat.openOrderConversation(order.id, actor(owner));
  await chat.sendConversationMessage(c.id, actor(company), { text: '旧方案沟通', clientKey: 'before-replace' });
  await (await db.getDb()).update(db.orders).set({ companyId: otherCompany.id }).where(eq(db.orders.id, order.id));
  const history = await chat.readConversationMessages(c.id, actor(company));
  assert.equal(history.conversation.writable, false);
  await assert.rejects(chat.sendConversationMessage(c.id, actor(owner), { text: '不应继续', clientKey: 'after-replace' }), e => e.status === 409);
  const next = await chat.openOrderConversation(order.id, actor(otherCompany));
  assert.notEqual(next.id, c.id);
  await assert.rejects(chat.readConversationMessages(next.id, actor(company)), e => e.status === 403);
});
test('deleted or forged accounts and platform accounts cannot become chat participants', async () => {
  const { order } = await fixture();
  await assert.rejects(chat.openOrderConversation(order.id, { uid: 0, role: 'boss' }), e => e.status === 403);
  await assert.rejects(chat.openOrderConversation(order.id, { uid: company.id, role: 'homeowner' }), e => e.status === 403);
});
test('reselecting the same company resumes its own history without exposing the other company conversation', async () => {
  const { order } = await fixture(); const c = await chat.openOrderConversation(order.id, actor(owner));
  await chat.sendConversationMessage(c.id, actor(owner), { text: '原公司的沟通', clientKey: 'first-selection' });
  await (await db.getDb()).update(db.orders).set({ companyId: otherCompany.id }).where(eq(db.orders.id, order.id));
  const other = await chat.openOrderConversation(order.id, actor(otherCompany));
  await (await db.getDb()).update(db.orders).set({ companyId: company.id }).where(eq(db.orders.id, order.id));
  const resumed = await chat.openOrderConversation(order.id, actor(company));
  assert.equal(resumed.id, c.id); assert.equal(resumed.writable, true);
  assert.equal((await chat.readConversationMessages(other.id, actor(otherCompany))).conversation.writable, false);
  await assert.rejects(chat.readConversationMessages(other.id, actor(company)), e => e.status === 403);
});
test('deleting an eligible project removes its conversation and messages', async () => {
  const { order, project } = await fixture(); const c = await chat.openOrderConversation(order.id, actor(owner));
  await chat.sendConversationMessage(c.id, actor(owner), { text: '删除夹具', clientKey: 'delete-fixture' });
  await db.deleteProject(project.id);
  await assert.rejects(chat.readConversationMessages(c.id, actor(owner)), e => e.status === 404);
});
test('chat export is private, includes history and does not mark messages read', async () => {
  assert.equal(typeof chat.exportConversation, 'function');
  const { order } = await fixture(); const c = await chat.openOrderConversation(order.id, actor(owner));
  await chat.sendConversationMessage(c.id, actor(owner), { text: '材料型号待核对', clientKey: 'export-message-1' });
  const result = await chat.exportConversation(c.id, actor(company));
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].text, '材料型号待核对');
  assert.doesNotMatch(JSON.stringify(result), /export-message-1|passwordHash|clientKey/);
  assert.equal((await chat.listConversations(actor(company))).find(x => x.id === c.id).unreadCount, 1);
  await assert.rejects(chat.exportConversation(c.id, actor(stranger)), e => e.status === 403);
  await assert.rejects(chat.exportConversation(c.id, { uid: 0, role: 'boss' }), e => e.status === 403);
});
