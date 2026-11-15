import crypto from 'node:crypto';
import fs from 'node:fs';
import { eq, inArray, and } from 'drizzle-orm';
import { getDb, users, projects, orders, results, tasks, bids, contracts, contractWorkflows, contractWorkflowVariants, workflowOperations, projectConversations, conversationMessages, companyContractProfiles, commissionSettlements, generatePlanGeometry, planToSvg, calcQuote, listPriceReferences } from '@i-renovation/shared';
import { hashPassword } from './auth';

export async function createDemoWorkspace() {
  const db = await getDb();
  const prices = await listPriceReferences('杭州');
  return db.transaction(async tx => {
    const existing = await tx.select({ id: users.id }).from(users).where(eq(users.demo, 1));
    if (existing.length) throw new Error('已有演示账号，请先使用或清理，避免重复创建');
    const credentials: { phone: string; password: string; name: string; role: string }[] = [];
    const accounts = [];
    for (const [index, name] of ['【演示】体验业主', '【演示】简居装修队', '【演示】暖家装修队', '【演示】匠心装修队'].entries()) {
      const password = crypto.randomBytes(18).toString('base64url');
      const phone = `demo-${crypto.randomBytes(8).toString('hex')}`;
      const role = index === 0 ? 'homeowner' : 'company';
      const [account] = await tx.insert(users).values({ name, role, phone, demo: 1, companyName: index ? name : null,
        passwordHash: hashPassword(password), verified: 0, specialties: index === 1 ? ['现代简约', '小户型'] : index === 2 ? ['北欧', '收纳'] : ['新中式', '现代简约'], districts: ['演示区域'],
        serviceTypes: index === 1 ? ['基础装修', '局部改造'] : index === 2 ? ['全屋整装', '收纳优化'] : ['全案装修', '材料工艺'],
        membershipStatus: 'active', membershipExpiresAt: '2099-01-01T00:00:00.000Z', monthlyLeadQuota: 30,
        createdAt: new Date().toISOString() }).returning();
      accounts.push(account); credentials.push({ phone, password, name, role });
    }
    const samples = [];
    for (const area of [80, 100]) {
      const rooms = [{ name: '客厅', area: area * .4 }, { name: '卧室', area: area * .3 }, { name: '厨房', area: area * .2 }, { name: '卫生间', area: area * .1 }];
      const geometry = generatePlanGeometry(rooms, { totalArea: area });
      const quote = calcQuote(rooms, '现代简约', prices);
      const at = new Date().toISOString();
      const [project] = await tx.insert(projects).values({ homeownerId: accounts[0].id, demo: 1,
        name: `【演示】${area}㎡装修竞标样例`, area: String(area), style: '现代简约', budget: '20',
        needs: '合成资料，仅供报价、匹配与沟通演示；不代表真实客户、资质或完整设计交付。', stage: 3, createdAt: at }).returning();
      for (const [kind, content] of Object.entries({ plan: { rooms, geometry, source: 'demo', note: '合成户型，非客户原图' }, design: { rooms, geometry, svg: planToSvg(geometry, '现代简约', project.name), note: '程序生成的演示布局，不是完整交付' }, quote })) {
        await tx.insert(results).values({ projectId: project.id, kind, content, createdAt: at });
      }
      const [order] = await tx.insert(orders).values({ projectId: project.id, homeownerId: accounts[0].id, status: 'open', createdAt: at, updatedAt: at }).returning();
      samples.push({ projectId: project.id, orderId: order.id, name: project.name, total: quote.total, weeks: quote.weeks });
    }
    return { credentials, companies: accounts.slice(1).map(a => ({ id: a.id, name: a.name })), projects: samples };
  });
}

export async function cleanDemoWorkspace() {
  const db = await getDb();
  const uploaded: string[] = [];
  await db.transaction(async tx => {
    const demoProjects = await tx.select({ id: projects.id, floorPlanPath: projects.floorPlanPath }).from(projects).where(eq(projects.demo, 1));
    const projectIds = demoProjects.map(p => p.id);
    for (const p of demoProjects) if (p.floorPlanPath) uploaded.push(p.floorPlanPath);
    if (projectIds.length) {
      const running = await tx.select({ id: tasks.id }).from(tasks).where(and(inArray(tasks.projectId, projectIds), eq(tasks.status, 'running')));
      if (running.length) throw new Error('演示任务正在执行，请完成后再清理');
      const orderIds = (await tx.select({ id: orders.id }).from(orders).where(inArray(orders.projectId, projectIds))).map(o => o.id);
      if (orderIds.length) {
        for (const table of [contractWorkflows, contractWorkflowVariants]) {
          const rows = await tx.select().from(table).where(inArray(table.orderId, orderIds));
          if (rows.some(r => (r.state as { mode?: string }).mode !== 'demo')) throw new Error('发现真实合同，停止清理，请人工核对');
          await tx.delete(table).where(inArray(table.orderId, orderIds));
        }
        const conversationIds = (await tx.select({ id: projectConversations.id }).from(projectConversations).where(inArray(projectConversations.orderId, orderIds))).map(c => c.id);
        if (conversationIds.length) await tx.delete(conversationMessages).where(inArray(conversationMessages.conversationId, conversationIds));
        await tx.delete(projectConversations).where(inArray(projectConversations.orderId, orderIds));
        await tx.delete(workflowOperations).where(inArray(workflowOperations.orderId, orderIds));
        await tx.delete(commissionSettlements).where(inArray(commissionSettlements.orderId, orderIds));
        await tx.delete(contracts).where(inArray(contracts.orderId, orderIds));
        await tx.delete(bids).where(inArray(bids.orderId, orderIds));
        await tx.delete(orders).where(inArray(orders.id, orderIds));
      }
      await tx.delete(tasks).where(inArray(tasks.projectId, projectIds));
      await tx.delete(results).where(inArray(results.projectId, projectIds));
      await tx.delete(projects).where(inArray(projects.id, projectIds));
    }
    const ids = (await tx.select({ id: users.id }).from(users).where(eq(users.demo, 1))).map(u => u.id);
    if (ids.length) {
      await tx.delete(companyContractProfiles).where(inArray(companyContractProfiles.companyId, ids));
      await tx.delete(users).where(inArray(users.id, ids));
    }
  });
  // 演示业主上传过的户型图一并清理（与 deleteProject 相同；失败不影响清理结果）
  for (const file of uploaded) { try { fs.unlinkSync(file); } catch { /* ignore */ } }
  return { ok: true };
}
