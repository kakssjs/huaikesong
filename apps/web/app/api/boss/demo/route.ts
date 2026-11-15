import { NextResponse } from 'next/server';
import { getDb, users, projects, orders, createBid, createTask, getOrder, getProject, getUser, listBidsByOrder, getResult } from '@i-renovation/shared';
import { eq } from 'drizzle-orm';
import { requireSession } from '@/lib/auth';
import { createDemoWorkspace, cleanDemoWorkspace } from '@/lib/demo-workspace';
import { evaluateBidRisk } from '@i-renovation/shared/fair-bidding';
import { estimateContractServiceFee, wanToCny } from '@i-renovation/shared/commission';

export async function GET(req: Request) {
  const actor = await requireSession(req, ['boss']); if (actor instanceof NextResponse) return actor;
  const db = await getDb();
  const accounts = await db.select({ id: users.id, name: users.name, phone: users.phone, role: users.role }).from(users).where(eq(users.demo, 1));
  const rows = await db.select({ id: projects.id, name: projects.name, orderId: orders.id, status: orders.status }).from(projects).innerJoin(orders, eq(orders.projectId, projects.id)).where(eq(projects.demo, 1));
  // 带上平台参考报价和已有投标：填写演示报价时有依据，也能看到哪支队伍还没报
  const demoProjects = await Promise.all(rows.map(async row => {
    const quote = (await getResult(row.id, 'quote'))?.content as { total?: number; weeks?: number } | undefined;
    return { ...row, referenceCny: Number(quote?.total) || 0, referenceWeeks: Number(quote?.weeks) || 0,
      bids: (await listBidsByOrder(row.orderId)).map(b => ({ companyId: b.companyId, amount: b.amount, weeks: b.weeks })) };
  }));
  return NextResponse.json({ accounts, projects: demoProjects }, { headers: { 'Cache-Control': 'no-store' } });
}
export async function POST(req: Request) {
  const actor = await requireSession(req, ['boss']); if (actor instanceof NextResponse) return actor;
  try {
    const body = await req.json();
    if (body.action === 'create') return NextResponse.json(await createDemoWorkspace(), { headers: { 'Cache-Control': 'no-store' } });
    if (body.action === 'clean') return NextResponse.json(await cleanDemoWorkspace());
    if (body.action !== 'bid') return NextResponse.json({ error: '操作无效' }, { status: 400 });
    const order = await getOrder(Number(body.orderId));
    const company = await getUser(Number(body.companyId));
    const project = order ? await getProject(order.projectId) : null;
    if (!order || project?.demo !== 1 || company?.demo !== 1 || company.role !== 'company' || order.status !== 'open') throw new Error('仅可为开放中的演示项目提交演示报价');
    const amount = Number(body.amount), weeks = Number(body.weeks);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(weeks) || weeks <= 0 || weeks > 104 || typeof body.note !== 'string' || body.note.length > 2000) throw new Error('请填写有效报价、工期与说明');
    if ((await listBidsByOrder(order.id)).some(b => b.companyId === company.id)) throw new Error('该演示公司已经投标');
    // 与公司端投标（api/bids）记录同样的风控和服务费预估，演示投标在各页面的显示与真实投标一致
    const commission = estimateContractServiceFee({ amount, amountInWan: true });
    const quote = await getResult(project.id, 'quote');
    const risk = evaluateBidRisk(wanToCny(amount), Number((quote?.content as { total?: number } | undefined)?.total ?? 0), 0);
    if (!risk.acceptable) throw new Error(risk.reason);
    const bid = await createBid({ orderId: order.id, companyId: company.id, companyName: company.companyName!, amount: String(amount), weeks: String(weeks), note: `【演示报价·人工确认】${body.note}`,
      profitCny: Math.round(commission.profitCny), platformCommissionCny: Math.round(commission.platformCommissionCny), netProfitCny: Math.round(commission.contractorNetProfitCny), commissionBasis: commission.basis,
      bidRiskLevel: risk.level, bidRiskScore: risk.score, bidRiskReason: risk.reason });
    await createTask(project.id, 'orchestrator', 'matcher', { projectId: project.id, orderId: order.id, reason: '演示报价已人工确认，运行匹配' });
    return NextResponse.json(bid);
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : '演示操作失败' }, { status: 400 }); }
}
