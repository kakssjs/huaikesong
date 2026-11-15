// 数据层：PGlite（进程内 PostgreSQL，开发用）+ Drizzle ORM
// 生产切换阿里云 RDS：只改 createClient 一行（方案 §4.1）
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { pgTable, serial, text, integer, jsonb, doublePrecision } from 'drizzle-orm/pg-core';
import { eq, asc, and, inArray, isNotNull, lte } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { getMembershipTier } from './membership';
import { calculateContractorCommission } from './commission';
import { PRICE_REFERENCES, type PriceReference } from './price';

export const projects = pgTable('projects', {
  id: serial('id').primaryKey(),
  homeownerId: integer('homeowner_id'),
  name: text('name').notNull(),
  style: text('style').notNull(),
  budget: text('budget').notNull(),
  area: text('area'),
  needs: text('needs'),
  floorPlanPath: text('floor_plan_path'),
  requestKey: text('request_key'),
  // 房屋位置：省/市/区来自高德逆地理编码，小区与详细地址由业主选择或填写，经纬度用于详情页地图
  province: text('province'),
  city: text('city'),
  district: text('district'),
  community: text('community'),
  address: text('address'),
  lng: text('lng'),
  lat: text('lat'),
  stage: integer('stage').notNull().default(1),
  createdAt: text('created_at').notNull(),
});

export const tasks = pgTable('tasks', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').notNull(),
  fromAgent: text('from_agent').notNull(),
  toAgent: text('to_agent').notNull(),
  input: jsonb('input'),
  output: jsonb('output'),
  status: text('status').notNull().default('pending'), // pending|running|done|failed
  retry: integer('retry').notNull().default(0),
  tokensCost: integer('tokens_cost').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const results = pgTable('results', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').notNull(),
  kind: text('kind').notNull(), // plan|design|quote|match|qa
  content: jsonb('content').notNull(),
  createdAt: text('created_at').notNull(),
});

export interface TaskRecord {
  taskId: number;
  projectId: number;
  from: string;
  to: string;
  status: string;
  retryCount: number;
}

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  role: text('role').notNull(),
  name: text('name').notNull(),
  phone: text('phone'),
  email: text('email'),
  passwordHash: text('password_hash'),
  companyName: text('company_name'),
  license: text('license'),
  qualifications: jsonb('qualifications'),
  districts: jsonb('districts'),
  serviceTypes: jsonb('service_types'),
  specialties: jsonb('specialties'),
  companyScale: text('company_scale'),
  membershipTier: text('membership_tier').default('basic'),
  membershipStatus: text('membership_status').default('pending_payment'),
  membershipExpiresAt: text('membership_expires_at'),
  monthlyLeadQuota: integer('monthly_lead_quota').default(30),
  monthlyLeadsUsed: integer('monthly_leads_used').default(0),
  membershipPaidAmount: integer('membership_paid_amount').default(0),
  membershipStartedAt: text('membership_started_at'),
  /** 邮箱经验证码确认的时间；为空表示 email 只是填写的，没验证过，不能用来登录 */
  emailVerifiedAt: text('email_verified_at'),
  verified: integer('verified').notNull().default(0),
  createdAt: text('created_at').notNull(),
});

/** 待使用的邮箱验证码：只存 HMAC 摘要，不存明文；key = 用途:邮箱 */
export const emailCodes = pgTable('email_codes', {
  key: text('key').primaryKey(),
  codeHash: text('code_hash').notNull(),
  expiresAt: integer('expires_at').notNull(),   // Unix 秒
  attempts: integer('attempts').notNull().default(0),
});

/** 发信限额计数：key = 范围:对象:时间窗，到 expiresAt 为止 */
export const emailQuotas = pgTable('email_quotas', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  expiresAt: integer('expires_at').notNull(),   // Unix 秒
});

export const orders = pgTable('orders', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').notNull(),
  homeownerId: integer('homeowner_id').notNull(),
  companyId: integer('company_id'),
  status: text('status').notNull().default('open'),
  bidAmount: text('bid_amount'),
  bidWeeks: text('bid_weeks'),
  bidNote: text('bid_note'),
  matchScore: text('match_score'),
  homeownerConfirmedAt: text('homeowner_confirmed_at'),
  companyConfirmedAt: text('company_confirmed_at'),
  confirmedAt: text('confirmed_at'),
  contractedAt: text('contracted_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const bids = pgTable('bids', {
  id: serial('id').primaryKey(),
  orderId: integer('order_id').notNull(),
  companyId: integer('company_id').notNull(),
  companyName: text('company_name').notNull(),
  amount: text('amount').notNull(),
  weeks: text('weeks').notNull(),
  note: text('note'),
  estimatedCostCny: integer('estimated_cost_cny').default(0),
  profitCny: integer('profit_cny').default(0),
  platformCommissionCny: integer('platform_commission_cny').default(0),
  netProfitCny: integer('net_profit_cny').default(0),
  commissionBasis: text('commission_basis').default('gross_revenue'),
  bidRiskLevel: text('bid_risk_level').default('unknown'),
  bidRiskScore: integer('bid_risk_score').default(0),
  bidRiskReason: text('bid_risk_reason'),
  status: text('status').notNull().default('pending'),
  createdAt: text('created_at').notNull(),
});

export const projectConversations = pgTable('project_conversations', {
  id: serial('id').primaryKey(), orderId: integer('order_id').notNull(),
  homeownerId: integer('homeowner_id').notNull(), companyId: integer('company_id').notNull(),
  homeownerName: text('homeowner_name').notNull(), companyName: text('company_name').notNull(),
  homeownerReadId: integer('homeowner_read_id').notNull().default(0), companyReadId: integer('company_read_id').notNull().default(0),
  createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
});
export const conversationMessages = pgTable('conversation_messages', {
  id: serial('id').primaryKey(), conversationId: integer('conversation_id').notNull(),
  senderId: integer('sender_id').notNull(), text: text('text').notNull(), clientKey: text('client_key').notNull(),
  createdAt: text('created_at').notNull(),
});

export const commissionSettlements = pgTable('commission_settlements', {
  id: serial('id').primaryKey(),
  orderId: integer('order_id').notNull(),
  bidId: integer('bid_id').notNull(),
  companyId: integer('company_id').notNull(),
  companyName: text('company_name').notNull(),
  revenueCny: integer('revenue_cny').notNull(),
  estimatedCostCny: integer('estimated_cost_cny').notNull().default(0),
  profitCny: integer('profit_cny').notNull(),
  commissionRatePct: integer('commission_rate_pct').notNull().default(10),
  platformCommissionCny: integer('platform_commission_cny').notNull(),
  contractorNetProfitCny: integer('contractor_net_profit_cny').notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: text('created_at').notNull(),
  settledAt: text('settled_at'),
});

export const contracts = pgTable('contracts', {
  id: serial('id').primaryKey(),
  orderId: integer('order_id').notNull(),
  content: text('content').notNull(),
  homeownerSigned: integer('homeowner_signed').notNull().default(0),
  companySigned: integer('company_signed').notNull().default(0),
  createdAt: text('created_at').notNull(),
  signedAt: text('signed_at'),
});

/** V2 demo workflow; historical contracts and membership payments stay separate. */
export const contractWorkflows = pgTable('contract_workflows', {
  orderId: integer('order_id').primaryKey(), projectId: integer('project_id').notNull(),
  revision: integer('revision').notNull(), state: jsonb('state').notNull(), updatedAt: text('updated_at').notNull(),
});
// The other mode of an existing order; the original row and its signed artifacts are never migrated.
export const contractWorkflowVariants = pgTable('contract_workflow_variants', {
  orderId: integer('order_id').primaryKey(), projectId: integer('project_id').notNull(),
  revision: integer('revision').notNull(), state: jsonb('state').notNull(), updatedAt: text('updated_at').notNull(),
});
export const workflowOperations = pgTable('workflow_operations', {
  key: text('key').primaryKey(), orderId: integer('order_id').notNull(), fingerprint: text('fingerprint').notNull(),
  revision: integer('revision').notNull(), createdAt: text('created_at').notNull(),
});
export const companyContractProfiles = pgTable('company_contract_profiles', {
  companyId: integer('company_id').primaryKey(), profile: jsonb('profile').notNull(), updatedAt: text('updated_at').notNull(),
});

/** What the payment service last verified for one purchase. NOT_FOUND means the service has no such purchase record. */
export type PaymentTransaction = {
  status: 'PAID' | 'PENDING' | 'REFUNDED' | 'UNKNOWN' | 'NOT_FOUND';
  tradeNo: string | null; checkedAt: string | null; fetchedAt: string; source: string | null;
};
/** A refund is requested here, decided by the platform, and only counted as refunded once the payment service verifies REFUNDED. */
export type PaymentRefund = {
  status: 'requested' | 'approved' | 'rejected' | 'withdrawn' | 'refunded';
  reason: string; requestedAt: string; decidedAt?: string; decisionNote?: string; confirmedAt?: string;
  history: Array<{ at: string; actor: 'company' | 'boss' | 'provider'; action: string; note?: string }>;
};

export const membershipPayments = pgTable('membership_payments', {
  id: serial('id').primaryKey(),
  companyId: integer('company_id').notNull(),
  companyName: text('company_name').notNull(),
  tier: text('tier').notNull(),
  billingCycle: text('billing_cycle').notNull().default('annual'),
  periodMonths: integer('period_months').notNull().default(12),
  amountCny: integer('amount_cny').notNull(),
  status: text('status').notNull().default('pending'),
  paymentReference: text('payment_reference'),
  purchaseIntent: jsonb('purchase_intent').$type<{ user_id: string; sku_id: string; callback_url: string; idempotency_key: string }>(),
  transactionSnapshot: jsonb('transaction_snapshot').$type<PaymentTransaction>(),
  refund: jsonb('refund').$type<PaymentRefund>(),
  createdAt: text('created_at').notNull(),
  paidAt: text('paid_at'),
});

/** 公开市场参考价（来源见 price.ts 的 PRICE_REFERENCES）：每条带来源链接、发布日期和采集日期 */
export const priceReferences = pgTable('price_references', {
  id: text('id').primaryKey(),
  city: text('city').notNull(),
  category: text('category').notNull(),
  item: text('item').notNull(),
  unit: text('unit').notNull(),
  low: doublePrecision('low').notNull(),
  high: doublePrecision('high').notNull(),
  note: text('note').notNull().default(''),
  sourceName: text('source_name').notNull(),
  sourceUrl: text('source_url').notNull(),
  publishedAt: text('published_at').notNull(),
  retrievedAt: text('retrieved_at').notNull(),
});

const DDL = `
CREATE TABLE IF NOT EXISTS projects (
  id serial PRIMARY KEY, homeowner_id integer, name text NOT NULL, style text NOT NULL, budget text NOT NULL,
  area text, needs text, floor_plan_path text, stage integer NOT NULL DEFAULT 1, created_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id serial PRIMARY KEY, project_id integer NOT NULL, from_agent text NOT NULL, to_agent text NOT NULL,
  input jsonb, output jsonb, status text NOT NULL DEFAULT 'pending', retry integer NOT NULL DEFAULT 0,
  tokens_cost integer NOT NULL DEFAULT 0, created_at text NOT NULL, updated_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS results (
  id serial PRIMARY KEY, project_id integer NOT NULL, kind text NOT NULL, content jsonb NOT NULL, created_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY, role text NOT NULL, name text NOT NULL,
  phone text, email text, password_hash text,
  company_name text, license text, qualifications jsonb,
  districts jsonb, service_types jsonb, specialties jsonb,
  company_scale text, membership_tier text DEFAULT 'basic', membership_status text DEFAULT 'pending_payment',
  membership_expires_at text, monthly_lead_quota integer DEFAULT 30, monthly_leads_used integer DEFAULT 0,
  membership_paid_amount integer DEFAULT 0, membership_started_at text,
  verified integer NOT NULL DEFAULT 0, created_at text NOT NULL
);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS province text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS district text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS community text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS lng text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS lat text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_scale text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS membership_tier text DEFAULT 'basic';
ALTER TABLE users ADD COLUMN IF NOT EXISTS membership_status text DEFAULT 'pending_payment';
ALTER TABLE users ADD COLUMN IF NOT EXISTS membership_expires_at text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_lead_quota integer DEFAULT 30;
ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_leads_used integer DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS membership_paid_amount integer DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS membership_started_at text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS request_key text;
CREATE TABLE IF NOT EXISTS email_codes (
  key text PRIMARY KEY, code_hash text NOT NULL, expires_at integer NOT NULL, attempts integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS email_quotas (
  key text PRIMARY KEY, count integer NOT NULL, expires_at integer NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id serial PRIMARY KEY, project_id integer NOT NULL, homeowner_id integer NOT NULL,
  company_id integer, status text NOT NULL DEFAULT 'open',
  bid_amount text, bid_weeks text, bid_note text, match_score text,
  homeowner_confirmed_at text, company_confirmed_at text,
  confirmed_at text, contracted_at text,
  created_at text NOT NULL, updated_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS bids (
  id serial PRIMARY KEY, order_id integer NOT NULL, company_id integer NOT NULL,
  company_name text NOT NULL, amount text NOT NULL, weeks text NOT NULL,
  note text, estimated_cost_cny integer DEFAULT 0, profit_cny integer DEFAULT 0,
  platform_commission_cny integer DEFAULT 0, net_profit_cny integer DEFAULT 0,
  commission_basis text DEFAULT 'gross_revenue', status text NOT NULL DEFAULT 'pending', created_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS project_conversations (
  id serial PRIMARY KEY, order_id integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  homeowner_id integer NOT NULL, company_id integer NOT NULL,
  homeowner_name text NOT NULL, company_name text NOT NULL,
  homeowner_read_id integer NOT NULL DEFAULT 0, company_read_id integer NOT NULL DEFAULT 0,
  created_at text NOT NULL, updated_at text NOT NULL,
  UNIQUE(order_id, company_id)
);
CREATE TABLE IF NOT EXISTS conversation_messages (
  id serial PRIMARY KEY, conversation_id integer NOT NULL REFERENCES project_conversations(id) ON DELETE CASCADE,
  sender_id integer NOT NULL, text text NOT NULL, client_key text NOT NULL, created_at text NOT NULL,
  UNIQUE(conversation_id, sender_id, client_key)
);
CREATE INDEX IF NOT EXISTS conversation_messages_history ON conversation_messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS project_conversations_owner ON project_conversations(homeowner_id);
CREATE INDEX IF NOT EXISTS project_conversations_company ON project_conversations(company_id);
CREATE TABLE IF NOT EXISTS commission_settlements (
  id serial PRIMARY KEY, order_id integer NOT NULL, bid_id integer NOT NULL, company_id integer NOT NULL,
  company_name text NOT NULL, revenue_cny integer NOT NULL, estimated_cost_cny integer DEFAULT 0,
  profit_cny integer NOT NULL, commission_rate_pct integer DEFAULT 10,
  platform_commission_cny integer NOT NULL, contractor_net_profit_cny integer NOT NULL,
  status text NOT NULL DEFAULT 'pending', created_at text NOT NULL, settled_at text
);
ALTER TABLE bids ADD COLUMN IF NOT EXISTS estimated_cost_cny integer DEFAULT 0;
ALTER TABLE bids ADD COLUMN IF NOT EXISTS profit_cny integer DEFAULT 0;
ALTER TABLE bids ADD COLUMN IF NOT EXISTS platform_commission_cny integer DEFAULT 0;
ALTER TABLE bids ADD COLUMN IF NOT EXISTS net_profit_cny integer DEFAULT 0;
ALTER TABLE bids ADD COLUMN IF NOT EXISTS commission_basis text DEFAULT 'gross_revenue';
ALTER TABLE bids ADD COLUMN IF NOT EXISTS bid_risk_level text DEFAULT 'unknown';
ALTER TABLE bids ADD COLUMN IF NOT EXISTS bid_risk_score integer DEFAULT 0;
ALTER TABLE bids ADD COLUMN IF NOT EXISTS bid_risk_reason text;
CREATE TABLE IF NOT EXISTS membership_payments (
  id serial PRIMARY KEY, company_id integer NOT NULL, company_name text NOT NULL,
  tier text NOT NULL, billing_cycle text NOT NULL DEFAULT 'annual', period_months integer DEFAULT 12,
  amount_cny integer NOT NULL, status text NOT NULL DEFAULT 'pending',
  payment_reference text, created_at text NOT NULL, paid_at text
);
CREATE TABLE IF NOT EXISTS contracts (
  id serial PRIMARY KEY, order_id integer NOT NULL, content text NOT NULL,
  homeowner_signed integer NOT NULL DEFAULT 0, company_signed integer NOT NULL DEFAULT 0,
  created_at text NOT NULL, signed_at text
);
CREATE TABLE IF NOT EXISTS contract_workflows (
  order_id integer PRIMARY KEY, project_id integer NOT NULL, revision integer NOT NULL,
  state jsonb NOT NULL, updated_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS contract_workflow_variants (
  order_id integer PRIMARY KEY, project_id integer NOT NULL, revision integer NOT NULL,
  state jsonb NOT NULL, updated_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_operations (
  key text PRIMARY KEY, order_id integer NOT NULL, fingerprint text NOT NULL, revision integer NOT NULL, created_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS company_contract_profiles (
  company_id integer PRIMARY KEY, profile jsonb NOT NULL, updated_at text NOT NULL
);
ALTER TABLE membership_payments ADD COLUMN IF NOT EXISTS billing_cycle text DEFAULT 'annual';
ALTER TABLE membership_payments ADD COLUMN IF NOT EXISTS period_months integer DEFAULT 12;
ALTER TABLE membership_payments ADD COLUMN IF NOT EXISTS purchase_intent jsonb;
ALTER TABLE membership_payments ADD COLUMN IF NOT EXISTS transaction_snapshot jsonb;
ALTER TABLE membership_payments ADD COLUMN IF NOT EXISTS refund jsonb;
CREATE TABLE IF NOT EXISTS price_references (
  id text PRIMARY KEY, city text NOT NULL, category text NOT NULL, item text NOT NULL, unit text NOT NULL,
  low double precision NOT NULL, high double precision NOT NULL, note text NOT NULL DEFAULT '',
  source_name text NOT NULL, source_url text NOT NULL, published_at text NOT NULL, retrieved_at text NOT NULL
);`;

const globalForDb = globalThis as unknown as { __dbPromise?: Promise<ReturnType<typeof drizzle>> };

export async function getDb() {
  if (!globalForDb.__dbPromise) {
    globalForDb.__dbPromise = (async () => {
      // 允许并行实例使用独立数据目录（IRENO_PGLITE_DIR），默认不变
      const dataDir = process.env.IRENO_PGLITE_DIR
        ? path.resolve(process.env.IRENO_PGLITE_DIR)
        : path.join(process.cwd(), '..', '..', '.pglite-data');
      fs.mkdirSync(dataDir, { recursive: true });
      const client = new PGlite(dataDir);
      await client.exec(DDL);
      const db = drizzle(client);
      // 载入随代码发布的参考价：按 id 更新，重复启动不会重复插入
      for (const r of PRICE_REFERENCES) {
        await db.insert(priceReferences).values(r).onConflictDoUpdate({ target: priceReferences.id, set: r });
      }
      return db;
    })();
  }
  return globalForDb.__dbPromise;
}

const now = () => new Date().toISOString();

export async function createProject(p: {
  name: string; style: string; budget: string; area?: string; needs?: string; floorPlanPath?: string; homeownerId?: number; requestKey?: string;
  province?: string; city?: string; district?: string; community?: string; address?: string; lng?: string; lat?: string;
}) {
  const db = await getDb();
  return db.transaction(async tx => {
    if (p.requestKey && p.homeownerId) {
      const [existing] = await tx.select().from(projects).where(and(eq(projects.homeownerId, p.homeownerId), eq(projects.requestKey, p.requestKey)));
      if (existing) return existing;
    }
    const [row] = await tx.insert(projects).values({ ...p, stage: 1, createdAt: now() }).returning();
    await tx.insert(tasks).values({ projectId: row.id, fromAgent: 'orchestrator', toAgent: 'floor_plan',
      input: { projectId: row.id }, status: 'pending', createdAt: now(), updatedAt: now() });
    return row;
  });
}

export async function getProjectsByHomeowner(homeownerId: number) {
  const db = await getDb();
  return db.select().from(projects).where(eq(projects.homeownerId, homeownerId)).orderBy(asc(projects.id));
}

export async function getProject(id: number) {
  const db = await getDb();
  const [row] = await db.select().from(projects).where(eq(projects.id, id));
  return row ?? null;
}

export async function createTask(projectId: number, from: string, to: string, input: unknown) {
  const db = await getDb();
  const ts = now();
  return db.transaction(async tx => {
  const [existing] = await tx.select().from(tasks).where(and(eq(tasks.projectId, projectId), eq(tasks.toAgent, to), inArray(tasks.status, ['pending', 'running'])));
  if (existing) return existing;
  if (to === 'floor_plan') await tx.delete(tasks).where(and(eq(tasks.projectId, projectId), eq(tasks.toAgent, to), eq(tasks.status, 'waiting_user')));
  const [row] = await tx.insert(tasks).values({
    projectId, fromAgent: from, toAgent: to, input: input as never,
    status: 'pending', retry: 0, tokensCost: 0, createdAt: ts, updatedAt: ts,
  }).returning();
  return row;
  });
}

/** 领取一条 pending 任务并置为 running（单进程 runner，乐观锁即可） */
export async function claimNextTask() {
  const db = await getDb();
  const [t] = await db.select().from(tasks).where(eq(tasks.status, 'pending')).orderBy(asc(tasks.id)).limit(1);
  if (!t) return null;
  const [claimed] = await db.update(tasks).set({ status: 'running', updatedAt: now() })
    .where(and(eq(tasks.id, t.id), eq(tasks.status, 'pending'))).returning();
  return claimed ?? null;
}

/** Called once before the single runner starts; interrupted work must not remain stuck forever. */
export async function recoverRunningTasks() {
  const db = await getDb();
  await db.update(tasks).set({ status: 'pending', updatedAt: now() }).where(eq(tasks.status, 'running'));
}

export async function finishTask(id: number, output: unknown, tokensCost: number, continuation?: { nextAgent?: string; stage?: number }) {
  const db = await getDb();
  await db.transaction(async tx => {
    const [task] = await tx.update(tasks).set({ status: 'done', output: output as never, tokensCost, updatedAt: now() }).where(and(eq(tasks.id, id), eq(tasks.status, 'running'))).returning();
    if (!task) return;
    if (continuation?.nextAgent) {
      const [existing] = await tx.select().from(tasks).where(and(eq(tasks.projectId, task.projectId), eq(tasks.toAgent, continuation.nextAgent), inArray(tasks.status, ['pending', 'running'])));
      if (!existing) await tx.insert(tasks).values({ projectId: task.projectId, fromAgent: task.toAgent, toAgent: continuation.nextAgent,
        input: { projectId: task.projectId }, status: 'pending', createdAt: now(), updatedAt: now() });
    }
    if (continuation?.stage) await tx.update(projects).set({ stage: continuation.stage }).where(eq(projects.id, task.projectId));
  });
}

export async function failTask(id: number, retry: number) {
  const db = await getDb();
  await db.update(tasks).set({ status: 'pending', retry, updatedAt: now() }).where(eq(tasks.id, id));
}

/** 异常升级：任务置 escalated，等待老板裁决（EXCEPTION_RULES action=escalate_boss） */
export async function escalateTask(id: number, output: unknown) {
  const db = await getDb();
  await db.update(tasks).set({ status: 'escalated', output: output as never, updatedAt: now() }).where(eq(tasks.id, id));
}

export async function decideTask(id: number, action: 'retry' | 'dismiss') {
  const db = await getDb();
  return db.transaction(async tx => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, id));
    if (!task || !['failed', 'escalated', 'waiting_user'].includes(task.status)) throw new Error('任务不存在或当前状态不需要裁决');
    const [updated] = await tx.update(tasks).set({ status: action === 'retry' ? 'pending' : 'cancelled', retry: 0,
      output: { ...(task.output as object || {}), bossDecision: action, decidedAt: now() }, updatedAt: now(),
    }).where(eq(tasks.id, id)).returning();
    return updated;
  });
}

/** 反问用户：任务置 waiting_user，等待业主补充信息后继续（action=reask_user） */
export async function waitingTask(id: number, output: unknown) {
  const db = await getDb();
  await db.update(tasks).set({ status: 'waiting_user', output: output as never, updatedAt: now() }).where(eq(tasks.id, id));
}

/** 用户补充/确认后恢复等待中的任务（waiting_user → pending，由 runner 续跑；标记 resumed 避免重复反问） */
export async function resumeWaitingTasks(projectId: number) {
  const db = await getDb();
  const rows = await db.select().from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.status, 'waiting_user')));
  for (const t of rows) {
    const prev = (t.output ?? {}) as Record<string, unknown>;
    await db.update(tasks).set({
      status: 'pending', retry: 0,
      output: { ...prev, resumed: true, resumedAt: now() } as never,
      updatedAt: now(),
    }).where(eq(tasks.id, t.id));
  }
  return rows.length;
}

export async function saveResult(projectId: number, kind: string, content: unknown) {
  const db = await getDb();
  await db.insert(results).values({ projectId, kind, content: content as never, createdAt: now() });
}

/** 覆盖式保存：同 kind 只保留最新一份（户型图更新、报价修订等场景） */
export async function upsertResult(projectId: number, kind: string, content: unknown) {
  const db = await getDb();
  await db.transaction(async tx => {
    const [project] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
    if (!project) throw new Error('项目已不存在');
    await tx.delete(results).where(and(eq(results.projectId, projectId), eq(results.kind, kind)));
    await tx.insert(results).values({ projectId, kind, content: content as never, createdAt: now() });
  });
}

export async function listResults(projectId: number) {
  const db = await getDb();
  return db.select().from(results).where(eq(results.projectId, projectId)).orderBy(asc(results.id));
}

export async function listTasks(projectId: number) {
  const db = await getDb();
  return db.select().from(tasks).where(eq(tasks.projectId, projectId)).orderBy(asc(tasks.id));
}

// ---- 全量查询（老板控制台） ----
export async function listAllProjects() {
  const db = await getDb();
  return db.select().from(projects).orderBy(asc(projects.id));
}

export async function listAllTasks() {
  const db = await getDb();
  return db.select().from(tasks).orderBy(asc(tasks.id));
}

export async function listAllOrders() {
  const db = await getDb();
  return db.select().from(orders).orderBy(asc(orders.id));
}

export async function getResult(projectId: number, kind: string) {
  const db = await getDb();
  const [row] = await db.select().from(results)
    .where(and(eq(results.projectId, projectId), eq(results.kind, kind))).orderBy(asc(results.id)).limit(1);
  return row ?? null;
}

// ---- Users ----
export async function createUser(u: {
  role: string; name: string; phone?: string; email?: string; passwordHash?: string;
  companyName?: string; license?: string; qualifications?: unknown;
  districts?: unknown; serviceTypes?: unknown; specialties?: unknown;
  companyScale?: string; membershipTier?: string; membershipStatus?: string; monthlyLeadQuota?: number;
  emailVerifiedAt?: string;
}) {
  const db = await getDb();
  return db.transaction(async tx => {
    if (u.phone) {
      const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.phone, u.phone));
      if (existing) throw new Error('该手机号已注册');
    }
    if (u.emailVerifiedAt && u.email) {
      const [existing] = await tx.select({ id: users.id }).from(users).where(and(eq(users.email, u.email), isNotNull(users.emailVerifiedAt)));
      if (existing) throw new Error('该邮箱已注册');
    }
    const [row] = await tx.insert(users).values({ ...u, verified: 0, createdAt: now() }).returning();
    return row;
  });
}

/** 按「已验证」的邮箱找账号（邮箱统一小写）。只填写、没验证过的邮箱找不到。 */
export async function getUserByVerifiedEmail(email: string) {
  const db = await getDb();
  const [row] = await db.select().from(users).where(and(eq(users.email, email), isNotNull(users.emailVerifiedAt)));
  return row ?? null;
}

// ---- 邮箱验证码 ----

const nowSec = () => Math.floor(Date.now() / 1000);

/** 占用一次发信额度；超过 limit 返回 false。窗口到期后从 1 重新计。 */
export async function takeEmailQuota(key: string, periodSec: number, limit: number): Promise<boolean> {
  const db = await getDb();
  return db.transaction(async tx => {
  const t = nowSec();
  const [row] = await tx.select().from(emailQuotas).where(eq(emailQuotas.key, key));
  if (!row || row.expiresAt <= t) {
    await tx.insert(emailQuotas).values({ key, count: 1, expiresAt: t + periodSec })
      .onConflictDoUpdate({ target: emailQuotas.key, set: { count: 1, expiresAt: t + periodSec } });
    return true;
  }
  if (row.count >= limit) return false;
  await tx.update(emailQuotas).set({ count: row.count + 1 }).where(eq(emailQuotas.key, key));
  return true;
  });
}

/** 保存（或替换）某个用途和邮箱的验证码摘要，重置错误次数。顺带清掉过期的码和额度。 */
export async function saveEmailCode(key: string, codeHash: string, ttlSec: number) {
  const db = await getDb();
  const t = nowSec();
  await db.delete(emailCodes).where(lte(emailCodes.expiresAt, t));
  await db.delete(emailQuotas).where(lte(emailQuotas.expiresAt, t));
  await db.insert(emailCodes).values({ key, codeHash, expiresAt: t + ttlSec, attempts: 0 })
    .onConflictDoUpdate({ target: emailCodes.key, set: { codeHash, expiresAt: t + ttlSec, attempts: 0 } });
}

export async function consumeEmailCodeHash(key: string, codeHash: string) {
  const db = await getDb();
  return db.transaction(async tx => {
    const [row] = await tx.select().from(emailCodes).where(eq(emailCodes.key, key));
    if (!row || row.expiresAt <= nowSec() || row.attempts >= 5) return false;
    const expected = Buffer.from(row.codeHash, 'hex');
    const actual = Buffer.from(codeHash, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) {
      await tx.update(emailCodes).set({ attempts: row.attempts + 1 }).where(eq(emailCodes.key, key));
      return false;
    }
    await tx.delete(emailCodes).where(eq(emailCodes.key, key));
    return true;
  });
}

export async function deleteEmailCode(key: string) {
  const db = await getDb();
  await db.delete(emailCodes).where(eq(emailCodes.key, key));
}

export async function getUser(id: number) {
  const db = await getDb();
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row ?? null;
}

export async function getUserByPhone(phone: string) {
  const db = await getDb();
  const [row] = await db.select().from(users).where(eq(users.phone, phone));
  return row ?? null;
}

export async function listCompanies() {
  const db = await getDb();
  return db.select().from(users).where(eq(users.role, 'company'));
}

/** 老板人工审核资质（★ Agent 不得代为认证）：1=通过 -1=驳回 0=待审核 */
export async function setUserVerified(id: number, value: 1 | -1) {
  const db = await getDb();
  await db.update(users).set({ verified: value }).where(eq(users.id, id));
}

/** 装修队补充/更新资质材料，重置为待审核（verified=0） */
export async function updateCompanyProfile(id: number, patch: Partial<{
  companyName: string; license: string; qualifications: unknown;
  districts: unknown; serviceTypes: unknown; specialties: unknown;
}>) {
  const db = await getDb();
  await db.update(users).set({ ...patch, verified: 0 }).where(and(eq(users.id, id), eq(users.role, 'company')));
}

/** 开通/调整装修队会员套餐。支付网关回调或老板线下确认后调用。 */
export async function setCompanyMembership(id: number, patch: Partial<{
  companyScale: string; membershipTier: string; membershipStatus: string; membershipExpiresAt: string;
  monthlyLeadQuota: number; monthlyLeadsUsed: number; membershipPaidAmount: number; membershipStartedAt: string;
}>) {
  const db = await getDb();
  await db.update(users).set(patch).where(and(eq(users.id, id), eq(users.role, 'company')));
}

/** 进入新的自然月时重置客户资源用量 */
export async function ensureCurrentLeadPeriod(id: number) {
  const db = await getDb();
  const [row] = await db.select().from(users).where(eq(users.id, id));
  if (!row) return null;
  const currentMonth = now().slice(0, 7);
  const periodMonth = (row.membershipStartedAt ?? '').slice(0, 7);
  if (periodMonth !== currentMonth) {
    await db.update(users).set({ monthlyLeadsUsed: 0, membershipStartedAt: now() }).where(eq(users.id, id));
    return { ...row, monthlyLeadsUsed: 0, membershipStartedAt: now() };
  }
  return row;
}

export async function listMembershipPayments(companyId?: number) {
  const db = await getDb();
  return companyId
    ? db.select().from(membershipPayments).where(eq(membershipPayments.companyId, companyId)).orderBy(asc(membershipPayments.id))
    : db.select().from(membershipPayments).orderBy(asc(membershipPayments.id));
}

export async function getOrCreateOnlinePayment(companyId: number, baseline: string | null, intent?: { user_id: string; sku_id: string; callback_url: string; keyPrefix: string }) {
  const db = await getDb();
  return db.transaction(async tx => {
    const pending = await tx.select().from(membershipPayments).where(and(
      eq(membershipPayments.companyId, companyId), eq(membershipPayments.status, 'pending')));
    const existing = pending.find(p => p.paymentReference?.startsWith('opcpay:') && (intent ? p.purchaseIntent?.user_id === intent.user_id : !p.purchaseIntent));
    if (existing) return existing;
    const [company] = await tx.select().from(users).where(and(eq(users.id, companyId), eq(users.role, 'company')));
    if (!company) throw new Error('Company not found');
    const [row] = await tx.insert(membershipPayments).values({ companyId,
      companyName: company.companyName || company.name, tier: 'basic', amountCny: 39,
      billingCycle: 'monthly', periodMonths: 1, status: 'pending', createdAt: now(),
      paymentReference: 'opcpay:' + (baseline || ''),
    }).returning();
    if (intent) {
      const purchaseIntent = { user_id: intent.user_id, sku_id: intent.sku_id, callback_url: intent.callback_url, idempotency_key: `${intent.keyPrefix}${row.id}` };
      await tx.update(membershipPayments).set({ purchaseIntent }).where(eq(membershipPayments.id, row.id));
      return { ...row, purchaseIntent };
    }
    return row;
  });
}

// An entitlement observation is not a payment receipt; never fabricate paid amounts or transaction IDs.
export async function observeOnlinePayments(companyId: number, expires: string, providerUserId?: string) {
  const db = await getDb();
  await db.transaction(async tx => {
    const pending = await tx.select().from(membershipPayments).where(and(
      eq(membershipPayments.companyId, companyId), eq(membershipPayments.status, 'pending')));
    for (const payment of pending) {
      if (!payment.paymentReference?.startsWith('opcpay:')) continue;
      if (providerUserId && payment.purchaseIntent?.user_id !== providerUserId) continue;
      const baseline = payment.paymentReference.slice(7);
      if (!baseline || Date.parse(expires) > Date.parse(baseline)) {
        await tx.update(membershipPayments).set({ status: 'entitlement_confirmed' }).where(eq(membershipPayments.id, payment.id));
      }
    }
  });
}

export async function expireOnlinePayment(id: number) {
  const db = await getDb();
  await db.update(membershipPayments).set({ status: 'entry_expired' })
    .where(and(eq(membershipPayments.id, id), eq(membershipPayments.status, 'pending')));
}

export class PaymentRefundError extends Error {
  constructor(message: string, public code: string, public status = 409) { super(message); this.name = 'PaymentRefundError'; }
}

/** Keeps what the payment service last verified for one purchase. REFUNDED is final and closes any refund request. */
export async function recordPaymentTransaction(id: number, snapshot: PaymentTransaction) {
  const db = await getDb();
  return db.transaction(async tx => {
    const [row] = await tx.select().from(membershipPayments).where(eq(membershipPayments.id, id));
    if (!row) return null;
    const old = row.transactionSnapshot;
    if (old?.status === 'REFUNDED' && snapshot.status !== 'REFUNDED') return row;
    if (old?.checkedAt && snapshot.checkedAt && Date.parse(snapshot.checkedAt) < Date.parse(old.checkedAt)) return row;
    const values: Partial<typeof membershipPayments.$inferInsert> = { transactionSnapshot: snapshot };
    if (snapshot.status === 'REFUNDED' && row.refund?.status !== 'refunded') {
      const at = snapshot.checkedAt || snapshot.fetchedAt, prior = row.refund;
      values.refund = {
        status: 'refunded', reason: prior?.reason ?? '支付服务确认已退款（无站内申请）', requestedAt: prior?.requestedAt ?? at,
        ...(prior?.decidedAt ? { decidedAt: prior.decidedAt } : {}), ...(prior?.decisionNote ? { decisionNote: prior.decisionNote } : {}),
        confirmedAt: at, history: [...(prior?.history ?? []), { at, actor: 'provider', action: 'refunded' }],
      };
      values.status = 'refunded';
    }
    await tx.update(membershipPayments).set(values).where(eq(membershipPayments.id, id));
    return { ...row, ...values };
  });
}

/** A company asks for its own paid purchase to be refunded. Only a purchase the payment service verified as PAID qualifies. */
export async function requestPaymentRefund(companyId: number, paymentId: number, reason: unknown) {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length < 5 || text.length > 200) throw new PaymentRefundError('退款原因需 5–200 字', 'INVALID_REASON', 400);
  const db = await getDb();
  return db.transaction(async tx => {
    const [row] = await tx.select().from(membershipPayments).where(and(eq(membershipPayments.id, paymentId), eq(membershipPayments.companyId, companyId)));
    if (!row) throw new PaymentRefundError('付款记录不存在', 'NOT_FOUND', 404);
    if (row.transactionSnapshot?.status !== 'PAID') throw new PaymentRefundError('仅支付服务已确认为“已支付”的付款可申请退款', 'NOT_PAID');
    if (row.refund && ['requested', 'approved', 'refunded'].includes(row.refund.status)) throw new PaymentRefundError('该笔付款已有进行中或已完成的退款', 'REFUND_IN_PROGRESS');
    const at = now();
    const refund: PaymentRefund = { status: 'requested', reason: text, requestedAt: at,
      history: [...(row.refund?.history ?? []), { at, actor: 'company', action: 'request', note: text }] };
    await tx.update(membershipPayments).set({ refund }).where(eq(membershipPayments.id, paymentId));
    return { ...row, refund };
  });
}

/** The company can take the request back until the platform has decided. */
export async function withdrawPaymentRefund(companyId: number, paymentId: number) {
  const db = await getDb();
  return db.transaction(async tx => {
    const [row] = await tx.select().from(membershipPayments).where(and(eq(membershipPayments.id, paymentId), eq(membershipPayments.companyId, companyId)));
    if (!row) throw new PaymentRefundError('付款记录不存在', 'NOT_FOUND', 404);
    if (row.refund?.status !== 'requested') throw new PaymentRefundError('只有待平台处理的退款申请可以撤回', 'NOT_REQUESTED');
    const at = now();
    const refund: PaymentRefund = { ...row.refund, status: 'withdrawn', history: [...row.refund.history, { at, actor: 'company', action: 'withdraw' }] };
    await tx.update(membershipPayments).set({ refund }).where(eq(membershipPayments.id, paymentId));
    return { ...row, refund };
  });
}

/** Platform decision. Approving records the decision only; the money moves outside this app and REFUNDED must be verified by the payment service. */
export async function decidePaymentRefund(paymentId: number, decision: 'approve' | 'reject', note: unknown) {
  const text = typeof note === 'string' ? note.trim() : '';
  if (text.length < 2 || text.length > 200) throw new PaymentRefundError('处理意见需 2–200 字', 'INVALID_NOTE', 400);
  const db = await getDb();
  return db.transaction(async tx => {
    const [row] = await tx.select().from(membershipPayments).where(eq(membershipPayments.id, paymentId));
    if (!row) throw new PaymentRefundError('付款记录不存在', 'NOT_FOUND', 404);
    if (row.refund?.status !== 'requested') throw new PaymentRefundError('该付款没有待处理的退款申请', 'NOT_REQUESTED');
    const at = now();
    const refund: PaymentRefund = { ...row.refund, status: decision === 'approve' ? 'approved' : 'rejected', decidedAt: at, decisionNote: text,
      history: [...row.refund.history, { at, actor: 'boss', action: decision, note: text }] };
    await tx.update(membershipPayments).set({ refund }).where(eq(membershipPayments.id, paymentId));
    return { ...row, refund };
  });
}

/** 每月 1 日重置客户资源用量 */
export async function resetMonthlyLeadUsage(id: number) {
  const db = await getDb();
  await db.update(users).set({ monthlyLeadsUsed: 0 }).where(and(eq(users.id, id), eq(users.role, 'company')));
}

/** 保存密码哈希（登录时把旧的明文密码升级为哈希） */
export async function setUserPasswordHash(id: number, passwordHash: string) {
  const db = await getDb();
  await db.update(users).set({ passwordHash }).where(eq(users.id, id));
}

// ---- Orders ----
export async function createOrder(o: {
  projectId: number; homeownerId: number; status?: string;
}) {
  const db = await getDb();
  const ts = now();
  return db.transaction(async tx => {
    const [existing] = await tx.select().from(orders).where(eq(orders.projectId, o.projectId)).orderBy(asc(orders.id)).limit(1);
    if (existing) return existing;
    const [row] = await tx.insert(orders).values({ ...o, status: 'open', createdAt: ts, updatedAt: ts }).returning();
    return row;
  });
}

export async function getOrder(id: number) {
  const db = await getDb();
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  return row ?? null;
}

export async function getOrderByProject(projectId: number) {
  const db = await getDb();
  const [row] = await db.select().from(orders).where(eq(orders.projectId, projectId)).orderBy(asc(orders.id)).limit(1);
  return row ?? null;
}

export async function listOrdersByHomeowner(homeownerId: number) {
  const db = await getDb();
  return db.select().from(orders).where(eq(orders.homeownerId, homeownerId)).orderBy(asc(orders.id));
}

export async function listOrdersByCompany(companyId: number) {
  const db = await getDb();
  return db.select().from(orders).where(eq(orders.companyId, companyId)).orderBy(asc(orders.id));
}

export async function listOpenOrders() {
  const db = await getDb();
  return db.select().from(orders).where(eq(orders.status, 'open'));
}

export async function updateOrder(id: number, patch: Partial<{ companyId: number; status: string; bidAmount: string; bidWeeks: string; bidNote: string; matchScore: string; homeownerConfirmedAt: string; companyConfirmedAt: string; confirmedAt: string; contractedAt: string }>) {
  const db = await getDb();
  await db.update(orders).set({ ...patch, updatedAt: now() }).where(eq(orders.id, id));
}

export async function selectOrderCompany(id: number, companyId: number) {
  const db = await getDb();
  return db.transaction(async tx => {
    const [workflow] = await tx.select({ orderId: contractWorkflows.orderId }).from(contractWorkflows).where(eq(contractWorkflows.orderId, id));
    if (workflow) throw new Error('已有合同工作流，不能通过旧接口更换中选公司');
    const [order] = await tx.select().from(orders).where(eq(orders.id, id));
    if (!order || !['open', 'matched'].includes(order.status)) throw new Error('当前状态不能更换装修队');
    const [bid] = await tx.select().from(bids).where(and(eq(bids.orderId, id), eq(bids.companyId, companyId)));
    const [company] = await tx.select().from(users).where(eq(users.id, companyId));
    if (!bid || !company || company.verified !== 1 || company.membershipStatus !== 'active' ||
        !company.membershipExpiresAt || Date.parse(company.membershipExpiresAt) <= Date.now()) throw new Error('请选择已审核且有有效会员的真实投标公司');
    await tx.update(bids).set({ status: 'rejected' }).where(eq(bids.orderId, id));
    await tx.update(bids).set({ status: 'accepted' }).where(eq(bids.id, bid.id));
    const [updated] = await tx.update(orders).set({ companyId, status: 'matched', bidAmount: bid.amount,
      bidWeeks: bid.weeks, bidNote: bid.note, updatedAt: now() }).where(eq(orders.id, id)).returning();
    return updated;
  });
}

export async function confirmOrder(id: number, signer: 'homeowner' | 'company') {
  const db = await getDb();
  return db.transaction(async tx => {
    const [workflow] = await tx.select({ orderId: contractWorkflows.orderId }).from(contractWorkflows).where(eq(contractWorkflows.orderId, id));
    if (workflow) throw new Error('请使用新的合同工作流确认操作');
    const [order] = await tx.select().from(orders).where(eq(orders.id, id));
    if (!order?.companyId || !['matched', 'homeowner_confirmed', 'company_confirmed', 'confirmed', 'contracted'].includes(order.status)) throw new Error('请先选定有效投标公司');
    if (['confirmed', 'contracted'].includes(order.status)) return order;
    const homeownerConfirmedAt = order.homeownerConfirmedAt || (signer === 'homeowner' ? now() : null);
    const companyConfirmedAt = order.companyConfirmedAt || (signer === 'company' ? now() : null);
    const both = !!homeownerConfirmedAt && !!companyConfirmedAt;
    const [updated] = await tx.update(orders).set({ homeownerConfirmedAt, companyConfirmedAt,
      status: both ? 'confirmed' : `${signer}_confirmed`, confirmedAt: both ? now() : null, updatedAt: now(),
    }).where(eq(orders.id, id)).returning();
    return updated;
  });
}

// ---- Bids ----
export async function createBid(b: {
  orderId: number; companyId: number; companyName: string; amount: string; weeks: string; note?: string;
  estimatedCostCny?: number; profitCny?: number; platformCommissionCny?: number; netProfitCny?: number; commissionBasis?: string;
  bidRiskLevel?: string; bidRiskScore?: number; bidRiskReason?: string;
}) {
  const db = await getDb();
  return db.transaction(async tx => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, b.orderId));
    const [company] = await tx.select().from(users).where(eq(users.id, b.companyId));
    if (!order || order.status !== 'open') throw new Error('订单不接受投标');
    if (!company || company.role !== 'company' || company.verified !== 1) throw new Error('请先完成资质审核');
    if (company.membershipStatus !== 'active' || !company.membershipExpiresAt || Date.parse(company.membershipExpiresAt) <= Date.now()) throw new Error('请先开通有效会员');
    const [existing] = await tx.select().from(bids).where(and(eq(bids.orderId, b.orderId), eq(bids.companyId, b.companyId)));
    if (existing) throw new Error('同一项目不能重复投标');
    const used = company.membershipStartedAt?.slice(0, 7) === now().slice(0, 7) ? Number(company.monthlyLeadsUsed ?? 0) : 0;
    if (used >= Number(company.monthlyLeadQuota ?? 30)) throw new Error('本月客户资源额度已用完');
    const active = await tx.select({ id: bids.id }).from(bids).innerJoin(orders, eq(bids.orderId, orders.id))
      .where(and(eq(bids.companyId, b.companyId), inArray(bids.status, ['pending', 'accepted']), inArray(orders.status, ['open', 'matched', 'homeowner_confirmed', 'company_confirmed', 'confirmed'])));
    if (active.length >= getMembershipTier(company.membershipTier).maxActiveBids) throw new Error('同时参与的项目已达套餐上限');
    const [row] = await tx.insert(bids).values({ ...b, status: 'pending', createdAt: now() }).returning();
    await tx.update(users).set({ monthlyLeadsUsed: used + 1, ...(company.membershipStartedAt?.slice(0, 7) === now().slice(0, 7) ? {} : { membershipStartedAt: now() }) }).where(eq(users.id, b.companyId));
    return row;
  });
}

export async function getCommissionSettlementByOrder(orderId: number) {
  const db = await getDb();
  const [row] = await db.select().from(commissionSettlements).where(eq(commissionSettlements.orderId, orderId)).limit(1);
  return row ?? null;
}

export async function setCommissionSettlementStatus(id: number, status: 'settled' | 'cancelled') {
  const db = await getDb();
  const [row] = await db.update(commissionSettlements).set({ status, settledAt: status === 'settled' ? now() : null }).where(eq(commissionSettlements.id, id)).returning();
  return row ?? null;
}

export async function listBidsByOrder(orderId: number) {
  const db = await getDb();
  return db.select().from(bids).where(eq(bids.orderId, orderId)).orderBy(asc(bids.id));
}

/** 业主选定中标方：中标 bid → accepted，同订单其余 pending bid → rejected */


// ---- Contracts ----
export async function createContract(c: { orderId: number; content: string }) {
  const db = await getDb();
  return db.transaction(async tx => {
    const [workflow] = await tx.select({ orderId: contractWorkflows.orderId }).from(contractWorkflows).where(eq(contractWorkflows.orderId, c.orderId));
    if (workflow) throw new Error('请使用新的合同工作流，不创建旧合同');
    const [order] = await tx.select().from(orders).where(eq(orders.id, c.orderId));
    if (!order || !['confirmed', 'contracted'].includes(order.status)) throw new Error('双方确认后才能生成合同');
    const [existing] = await tx.select().from(contracts).where(eq(contracts.orderId, c.orderId));
    if (existing) return existing;
    const [row] = await tx.insert(contracts).values({ ...c, homeownerSigned: 0, companySigned: 0, createdAt: now() }).returning();
    return row;
  });
}

export async function getContractByOrder(orderId: number) {
  const db = await getDb();
  const [row] = await db.select().from(contracts).where(eq(contracts.orderId, orderId)).orderBy(asc(contracts.id)).limit(1);
  return row ?? null;
}

export async function signContract(id: number, signer: 'homeowner' | 'company') {
  const db = await getDb();
  return db.transaction(async tx => {
    const [contract] = await tx.select().from(contracts).where(eq(contracts.id, id));
    if (!contract) throw new Error('合同不存在');
    const [workflow] = await tx.select({ orderId: contractWorkflows.orderId }).from(contractWorkflows).where(eq(contractWorkflows.orderId, contract.orderId));
    if (workflow) throw new Error('请使用新的合同工作流，不触发旧整单分成');
    const [order] = await tx.select().from(orders).where(eq(orders.id, contract.orderId));
    if (!order?.companyId || !['confirmed', 'contracted'].includes(order.status)) throw new Error('订单尚未由双方确认');
    const field = signer === 'homeowner' ? { homeownerSigned: 1 } : { companySigned: 1 };
    const [updated] = await tx.update(contracts).set(field).where(eq(contracts.id, id)).returning();
    if (updated.homeownerSigned && updated.companySigned) {
      const [bid] = await tx.select().from(bids).where(and(eq(bids.orderId, order.id), eq(bids.companyId, order.companyId), eq(bids.status, 'accepted')));
      if (!bid) throw new Error('缺少中标报价');
      const [settlement] = await tx.select().from(commissionSettlements).where(eq(commissionSettlements.orderId, order.id));
      if (!settlement) {
        const quote = calculateContractorCommission({ amount: bid.amount, estimatedCost: bid.commissionBasis === 'gross_revenue' ? null : Number(bid.estimatedCostCny) / 10000, amountInWan: true });
        await tx.insert(commissionSettlements).values({ orderId: order.id, bidId: bid.id, companyId: bid.companyId,
          companyName: bid.companyName, revenueCny: quote.revenueCny, estimatedCostCny: quote.estimatedCostCny,
          profitCny: quote.profitCny, platformCommissionCny: quote.platformCommissionCny,
          contractorNetProfitCny: quote.contractorNetProfitCny, status: 'pending', createdAt: now() });
      }
      if (!updated.signedAt) await tx.update(contracts).set({ signedAt: now() }).where(eq(contracts.id, id));
      if (order.status !== 'contracted') await tx.update(orders).set({ status: 'contracted', contractedAt: now(), updatedAt: now() }).where(eq(orders.id, order.id));
    }
    return updated;
  });
}

// ---- 项目删除（级联清理：合同 → 投标 → 订单 → 任务 → 结果 → 项目 + 户型图文件） ----
export async function deleteProject(id: number) {
  const db = await getDb();
  const project = await getProject(id);
  if (!project) return false;
  const [workflow] = await db.select({ orderId: contractWorkflows.orderId }).from(contractWorkflows).where(eq(contractWorkflows.projectId, id));
  if (workflow) throw new Error('已有合同工作流，项目及履约历史必须保留');
  const orderRows = await db.select({ id: orders.id }).from(orders).where(eq(orders.projectId, id));
  const orderIds = orderRows.map(o => o.id);
  await db.transaction(async tx => {
    const [activeWorkflow] = await tx.select({ orderId: contractWorkflows.orderId }).from(contractWorkflows).where(eq(contractWorkflows.projectId, id));
    if (activeWorkflow) throw new Error('已有合同工作流，项目及履约历史必须保留');
    if (orderIds.length > 0) {
      const historical = await tx.select().from(contracts).where(inArray(contracts.orderId, orderIds));
      if (historical.some(c => c.homeownerSigned || c.companySigned || c.signedAt)) throw new Error('已签合同及资金历史必须保留，不能删除项目');
      const settlements = await tx.select().from(commissionSettlements).where(inArray(commissionSettlements.orderId, orderIds));
      if (settlements.length) throw new Error('已有结算历史必须保留，不能删除项目');
      await tx.delete(commissionSettlements).where(inArray(commissionSettlements.orderId, orderIds));
      await tx.delete(contracts).where(inArray(contracts.orderId, orderIds));
      await tx.delete(bids).where(inArray(bids.orderId, orderIds));
    }
    await tx.delete(orders).where(eq(orders.projectId, id));
    await tx.delete(tasks).where(eq(tasks.projectId, id));
    await tx.delete(results).where(eq(results.projectId, id));
    await tx.delete(projects).where(eq(projects.id, id));
  });
  // 上传的户型图文件一并清理（失败不影响删除结果）
  if (project.floorPlanPath) {
    try { fs.unlinkSync(project.floorPlanPath); } catch { /* ignore */ }
  }
  return true;
}

// ---- 老板注销用户 ----
/** 老板控制台的用户列表（不含密码哈希），附带业主项目数 */
export async function listAllUsers() {
  const db = await getDb();
  const [rows, projectRows] = await Promise.all([
    db.select({
      id: users.id, role: users.role, name: users.name, phone: users.phone, email: users.email,
      companyName: users.companyName, createdAt: users.createdAt,
    }).from(users).orderBy(asc(users.id)),
    db.select({ homeownerId: projects.homeownerId }).from(projects),
  ]);
  const count = new Map<number, number>();
  for (const p of projectRows) if (p.homeownerId != null) count.set(p.homeownerId, (count.get(p.homeownerId) ?? 0) + 1);
  return rows.map(u => ({ ...u, projectCount: count.get(u.id) ?? 0 }));
}

/**
 * 注销用户（仅老板操作）。业主：连同其全部项目（订单、投标、合同、分成记录、户型图）一并删除，与删除项目相同。
 * 装修公司：删除其投标；若已被选为某订单的施工方，拒绝注销，以免业主的订单与合同失去对方。
 * 入驻费 / 会员付款记录保留，作为收款凭证。
 */
export async function deleteUser(id: number): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'has_orders' }> {
  const db = await getDb();
  const user = await getUser(id);
  if (!user) return { ok: false, reason: 'not_found' };
  if (user.role === 'company') {
    const awarded = await db.select({ id: orders.id }).from(orders).where(eq(orders.companyId, id));
    if (awarded.length > 0) return { ok: false, reason: 'has_orders' };
    await db.transaction(async tx => {
      await tx.delete(bids).where(eq(bids.companyId, id));
      await tx.delete(users).where(eq(users.id, id));
    });
    return { ok: true };
  }
  const own = await db.select({ id: projects.id }).from(projects).where(eq(projects.homeownerId, id));
  for (const p of own) await deleteProject(p.id);
  await db.delete(users).where(eq(users.id, id));
  return { ok: true };
}

// ---- 市场参考价 ----
export async function listPriceReferences(city?: string): Promise<PriceReference[]> {
  const db = await getDb();
  const rows = city
    ? await db.select().from(priceReferences).where(inArray(priceReferences.city, [city, '全国'])).orderBy(asc(priceReferences.id))
    : await db.select().from(priceReferences).orderBy(asc(priceReferences.id));
  return rows as PriceReference[];
}
