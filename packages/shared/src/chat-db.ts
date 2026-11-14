// Server-only, private owner/company conversations. No model or contract actions.
import { and, asc, desc, eq, gt, lt, ne, sql } from 'drizzle-orm';
import { getDb, users, projects, orders, projectConversations as conversations, conversationMessages as messages } from './db';

export type ChatActor = { uid: number; role: string };
type Tx = Parameters<Parameters<Awaited<ReturnType<typeof getDb>>['transaction']>[0]>[0];
export class ChatError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const fail = (message: string, status = 400): never => { throw new ChatError(message, status); };
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const now = () => new Date().toISOString();

async function assertActor(tx: Tx, actor: ChatActor) {
  if (!positive(actor.uid) || !['homeowner', 'company'].includes(actor.role)) return fail('仅业主与装修公司可使用双方沟通', 403);
  const [user] = await tx.select().from(users).where(eq(users.id, actor.uid));
  if (!user || user.role !== actor.role) return fail('账号身份已失效', 403);
  return user;
}
async function authorized(tx: Tx, id: number, actor: ChatActor) {
  if (!positive(id)) return fail('会话编号无效');
  await assertActor(tx, actor);
  const [row] = await tx.select().from(conversations).where(eq(conversations.id, id));
  if (!row) return fail('会话不存在', 404);
  if (!(actor.role === 'homeowner' && row.homeownerId === actor.uid || actor.role === 'company' && row.companyId === actor.uid)) return fail('无权访问该会话', 403);
  return row;
}
async function view(tx: Tx, row: typeof conversations.$inferSelect, actor: ChatActor) {
  const [order] = await tx.select().from(orders).where(eq(orders.id, row.orderId));
  const [project] = order ? await tx.select({ name: projects.name }).from(projects).where(eq(projects.id, order.projectId)) : [];
  const [partner] = await tx.select({ role: users.role }).from(users).where(eq(users.id, row.companyId));
  const readId = actor.role === 'homeowner' ? row.homeownerReadId : row.companyReadId;
  const [count] = await tx.select({ value: sql<number>`count(*)::integer` }).from(messages).where(and(eq(messages.conversationId, row.id), gt(messages.id, readId), ne(messages.senderId, actor.uid)));
  const [last] = await tx.select({ text: messages.text, createdAt: messages.createdAt }).from(messages).where(eq(messages.conversationId, row.id)).orderBy(desc(messages.id)).limit(1);
  const writable = !!order && order.homeownerId === row.homeownerId && order.companyId === row.companyId && partner?.role === 'company'
    && !['open', 'bidding', 'cancelled', 'closed'].includes(order.status);
  return {
    id: row.id, orderId: row.orderId, projectId: order?.projectId ?? null, projectName: project?.name ?? '历史项目',
    contactName: actor.role === 'homeowner' ? row.companyName : row.homeownerName,
    participantRole: actor.role, ownId: actor.uid, unreadCount: Number(count?.value ?? 0),
    lastMessage: last?.text.slice(0, 120) ?? '', updatedAt: last?.createdAt ?? row.createdAt,
    writable, partnerReadId: actor.role === 'homeowner' ? row.companyReadId : row.homeownerReadId,
  };
}

export async function openOrderConversation(orderId: number, actor: ChatActor) {
  if (!positive(orderId)) return fail('订单编号无效');
  return (await getDb()).transaction(async tx => {
    await assertActor(tx, actor);
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
    if (!order) return fail('订单不存在', 404);
    if (!(actor.role === 'homeowner' && order.homeownerId === actor.uid || actor.role === 'company' && order.companyId === actor.uid)) return fail('仅业主与选定的装修公司可进入沟通', 403);
    if (!order.companyId || ['open', 'bidding', 'cancelled', 'closed'].includes(order.status)) return fail('业主选定装修公司后才能开始沟通', 409);
    const [owner] = await tx.select().from(users).where(eq(users.id, order.homeownerId));
    const [company] = await tx.select().from(users).where(eq(users.id, order.companyId));
    if (owner?.role !== 'homeowner' || company?.role !== 'company') return fail('沟通双方账号不可用', 409);
    const timestamp = now();
    await tx.insert(conversations).values({ orderId, homeownerId: owner.id, companyId: company.id,
      homeownerName: owner.name, companyName: company.companyName || company.name, createdAt: timestamp, updatedAt: timestamp }).onConflictDoNothing();
    const [row] = await tx.select().from(conversations).where(and(eq(conversations.orderId, orderId), eq(conversations.companyId, company.id)));
    return view(tx, row, actor);
  });
}

export async function listConversations(actor: ChatActor) {
  return (await getDb()).transaction(async tx => {
    await assertActor(tx, actor);
    const rows = await tx.select().from(conversations).where(eq(actor.role === 'homeowner' ? conversations.homeownerId : conversations.companyId, actor.uid)).orderBy(desc(conversations.updatedAt), desc(conversations.id));
    const output = [];
    for (const row of rows) output.push(await view(tx, row, actor));
    return output;
  });
}

export async function readConversationMessages(id: number, actor: ChatActor, page: { before?: number; after?: number } = {}) {
  if (page.before !== undefined && !positive(page.before) || page.after !== undefined && (!Number.isSafeInteger(page.after) || page.after < 0) || page.before !== undefined && page.after !== undefined) return fail('消息分页参数无效');
  return (await getDb()).transaction(async tx => {
    const conversation = await authorized(tx, id, actor);
    const forward = page.after !== undefined;
    const rows = await tx.select({ id: messages.id, senderId: messages.senderId, text: messages.text, createdAt: messages.createdAt }).from(messages)
      .where(and(eq(messages.conversationId, id), page.before !== undefined ? lt(messages.id, page.before) : undefined, forward ? gt(messages.id, page.after!) : undefined))
      .orderBy(forward ? asc(messages.id) : desc(messages.id)).limit(51);
    const selected = rows.slice(0, 50);
    return { conversation: await view(tx, conversation, actor), messages: forward ? selected : selected.reverse(), hasMore: rows.length > 50 };
  });
}

export async function sendConversationMessage(id: number, actor: ChatActor, body: { text?: unknown; clientKey?: unknown }) {
  if (typeof body.text !== 'string' || !body.text.trim() || body.text.trim().length > 2000) return fail('消息应为 1～2000 字的文字');
  if (typeof body.clientKey !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(body.clientKey)) return fail('消息发送标识无效，请刷新后重试');
  const text = body.text.trim(), clientKey = body.clientKey;
  return (await getDb()).transaction(async tx => {
    const row = await authorized(tx, id, actor);
    const where = and(eq(messages.conversationId, id), eq(messages.senderId, actor.uid), eq(messages.clientKey, clientKey));
    const [previous] = await tx.select().from(messages).where(where);
    if (previous) {
      if (previous.text !== text) return fail('相同发送标识不能用于不同消息', 409);
      return { id: previous.id, senderId: previous.senderId, text: previous.text, createdAt: previous.createdAt };
    }
    if (!(await view(tx, row, actor)).writable) return fail('承接关系已变更或订单已关闭，该会话仅可阅读', 409);
    const [sent] = await tx.insert(messages).values({ conversationId: id, senderId: actor.uid, text, clientKey, createdAt: now() }).onConflictDoNothing().returning();
    const saved = sent ?? (await tx.select().from(messages).where(where))[0];
    if (!saved || saved.text !== text) return fail('发送标识冲突，请重试', 409);
    await tx.update(conversations).set({ updatedAt: saved.createdAt }).where(eq(conversations.id, id));
    return { id: saved.id, senderId: saved.senderId, text: saved.text, createdAt: saved.createdAt };
  });
}

export async function markConversationRead(id: number, actor: ChatActor, throughId: number) {
  if (!positive(throughId)) return fail('已读消息编号无效');
  return (await getDb()).transaction(async tx => {
    await authorized(tx, id, actor);
    const [message] = await tx.select({ id: messages.id }).from(messages).where(and(eq(messages.conversationId, id), eq(messages.id, throughId)));
    if (!message) return fail('已读消息不属于当前会话');
    const column = actor.role === 'homeowner' ? conversations.homeownerReadId : conversations.companyReadId;
    await tx.update(conversations).set(actor.role === 'homeowner' ? { homeownerReadId: sql`greatest(${column}, ${throughId})` } : { companyReadId: sql`greatest(${column}, ${throughId})` }).where(eq(conversations.id, id));
    return { ok: true };
  });
}

export async function exportConversation(id: number, actor: ChatActor) {
  return (await getDb()).transaction(async tx => {
    const row = await authorized(tx, id, actor);
    const history = await tx.select({ id: messages.id, senderId: messages.senderId, text: messages.text, createdAt: messages.createdAt })
      .from(messages).where(eq(messages.conversationId, id)).orderBy(asc(messages.id)).limit(10001);
    if (history.length > 10000) return fail('会话超过一万条消息，暂不支持完整导出；请先使用历史分页查看', 409);
    const c = await view(tx, row, actor);
    return { schema: 'yushe.conversation.v1', exportedAt: now(), conversation: { id:row.id, orderId:row.orderId, projectName:c.projectName, homeowner:row.homeownerName, company:row.companyName },
      messages: history.map(m=>({ id:m.id, sender:m.senderId===row.homeownerId?'homeowner':'company', text:m.text, createdAt:m.createdAt })),
      note:'双方沟通记录，仅供本人保存与核对；导出不表示双方确认变更报价、合同或验收。分享范围由下载者决定。' };
  });
}
