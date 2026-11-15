import { NextResponse } from 'next/server';
import { createTask, getProject, listTasks } from '@i-renovation/shared';
import { canEditProject, forbidden, requireSession } from '@/lib/auth';

// 重新质检：老板裁决「重跑」或报价修订后触发 QA 复检（EXCEPTION_RULES 流程闭环）
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const s = await requireSession(req); if (s instanceof NextResponse) return s;
  const id = Number((await ctx.params).id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  const project = await getProject(id);
  if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await canEditProject(s, id))) return forbidden();
  let body: { reason?: string };
  try { const text = await req.text(); body = text ? JSON.parse(text) : {}; }
  catch { return NextResponse.json({ error: '请求参数无效' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || (body.reason !== undefined && typeof body.reason !== 'string')) return NextResponse.json({ error: '请求参数无效' }, { status: 400 });
  const active = (await listTasks(id)).find(t => ['floor_plan', 'designer', 'quote', 'qa'].includes(t.toAgent) && ['pending', 'running'].includes(t.status));
  if (active) return NextResponse.json({ error: '当前岗位仍在执行，请完成后再单独质检。' }, { status: 409 });
  const task = await createTask(id, 'orchestrator', 'qa', { projectId: id, reason: body.reason ?? '重新质检（QA recheck）' });
  return NextResponse.json({ ok: true, taskId: task.id });
}
