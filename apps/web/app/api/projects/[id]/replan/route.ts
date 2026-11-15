import { NextResponse } from 'next/server';
import { createTask, getProject, listTasks, listResults } from '@i-renovation/shared';
import { buildDeliveryReport } from '@i-renovation/shared/delivery';
import { canEditProject, forbidden, requireSession } from '@/lib/auth';

// 按用户户型图（识别/手绘房间）重新生成：重建 floor_plan 任务，整条 CORE_CHAIN 重跑
// （施工图 / 各房间渲染图 / 报价 / 匹配全部按新房间重算）
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const s = await requireSession(req); if (s instanceof NextResponse) return s;
  const id = Number((await ctx.params).id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  const project = await getProject(id);
  if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await canEditProject(s, id))) return forbidden();
  let body: { reason?: string; retry?: boolean };
  try { const text = await req.text(); body = text ? JSON.parse(text) : {}; }
  catch { return NextResponse.json({ error: '请求参数无效' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || (body.reason !== undefined && typeof body.reason !== 'string')) return NextResponse.json({ error: '请求参数无效' }, { status: 400 });
  if (body.retry !== undefined && typeof body.retry !== 'boolean') return NextResponse.json({ error: '请求参数无效' }, { status: 400 });
  const tasks = await listTasks(id);
  const active = tasks.find(t => ['floor_plan', 'designer', 'quote', 'qa'].includes(t.toAgent) && ['pending', 'running'].includes(t.status));
  if (active) return NextResponse.json({ ok: true, taskId: active.id, alreadyRunning: true });
  let agent = 'floor_plan';
  if (body.retry) {
    const report = buildDeliveryReport({ project, tasks, results: await listResults(id) });
    const step = report.stages.find(s => s.status !== 'done');
    if (!step || step.key === 'qa') return NextResponse.json({ error: '生成成果已齐备，请单独使用重新质检。' }, { status: 409 });
    if (step.status === 'escalated' || step.status === 'waiting_user') return NextResponse.json({ error: '请先处理需补充资料或平台裁决的问题，不能直接重试。' }, { status: 409 });
    agent = step.key;
  }
  const task = await createTask(id, 'orchestrator', agent, {
    projectId: id,
    repair: body.retry === true,
    reason: body.reason ?? '按用户识别/手绘的房间重新生成设计包',
  });
  return NextResponse.json({ ok: true, taskId: task.id });
}
