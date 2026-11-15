import { NextResponse } from 'next/server';
import { handleProviderCallback } from '@i-renovation/shared/workflow-db';
import { WorkflowError } from '@i-renovation/shared/workflow';

/**
 * Callback endpoint for a registered signing or payment provider: /api/contract-providers/signing/callback or .../payment/callback.
 * The provider adapter verifies the callback (its signature scheme, its timestamps). The callback only names a session or
 * movement; the server then fetches the provider's own record. The body is never written into a contract.
 */
export async function POST(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const kind = (await ctx.params).kind;
  if (kind !== 'signing' && kind !== 'payment') return NextResponse.json({ error: 'not found' }, { status: 404 });
  try {
    if (Number(req.headers.get('content-length')) > 1_000_000) return NextResponse.json({ error: 'payload too large' }, { status: 413 });
    const body = await req.text(); if (body.length > 1_000_000) return NextResponse.json({ error: 'payload too large' }, { status: 413 });
    const result = await handleProviderCallback(kind, { headers: Object.fromEntries(req.headers.entries()), body });
    return NextResponse.json({ ok: true, orderId: result.orderId });
  } catch (error) {
    if (error instanceof WorkflowError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    return NextResponse.json({ error: 'callback failed' }, { status: 500 });
  }
}
