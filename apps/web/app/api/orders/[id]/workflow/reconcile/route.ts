import { withOrderWorkflowMode } from '@i-renovation/shared/workflow-db';
import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { reconcileOrderWorkflow } from '@i-renovation/shared/workflow-db';
import { WorkflowError } from '@i-renovation/shared/workflow';

const headers = { 'Cache-Control': 'no-store' };
/** Platform only: compares the recorded money movements with the payment provider's records and stores the result. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireSession(req, ['boss']); if (actor instanceof NextResponse) return actor;
    return await withOrderWorkflowMode(Number((await ctx.params).id),actor,new URL(req.url).searchParams.get('mode'),async()=>{
    return NextResponse.json(await reconcileOrderWorkflow(Number((await ctx.params).id), actor), { headers });
    });
  } catch (error) {
    if (error instanceof WorkflowError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers });
    return NextResponse.json({ error: '对账失败，请稍后重试', code: 'WORKFLOW_ERROR' }, { status: 500, headers });
  }
}
