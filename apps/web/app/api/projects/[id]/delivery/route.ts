import { NextResponse } from 'next/server';
import { buildDeliveryReport, getProject, listResults, listTasks } from '@i-renovation/shared';
import { canEditProject, forbidden, requireSession } from '@/lib/auth';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession(req); if (session instanceof NextResponse) return session;
  const id = Number((await ctx.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: '项目编号无效' }, { status: 400 });
  // Full delivery artifacts belong to the owner, not to every company browsing the marketplace.
  if (!(await canEditProject(session, id))) return forbidden();
  const project = await getProject(id);
  if (!project) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const [tasks, results] = await Promise.all([listTasks(id), listResults(id)]);
  const report = buildDeliveryReport({ project, tasks, results });
  const headers: Record<string, string> = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
  if (new URL(req.url).searchParams.get('download') === '1') headers['Content-Disposition'] = `attachment; filename="yushe-project-${id}-delivery.json"`;
  return NextResponse.json(report, { headers });
}
