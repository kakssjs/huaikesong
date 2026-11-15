import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { syncOrderWorkflow } from '@i-renovation/shared/workflow-db';
import { WorkflowError } from '@i-renovation/shared/workflow';

const headers = { 'Cache-Control': 'no-store' };
/** Any party of the order can ask the server to fetch the providers' records for open requests. No data from the browser is recorded. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireSession(req); if (actor instanceof NextResponse) return actor;
    return NextResponse.json(await syncOrderWorkflow(Number((await ctx.params).id), actor), { headers });
  } catch (error) {
    if (error instanceof WorkflowError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers });
    return NextResponse.json({ error: '同步服务商结果失败，请稍后重试', code: 'WORKFLOW_ERROR' }, { status: 500, headers });
  }
}
