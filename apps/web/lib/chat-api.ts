import { NextResponse } from 'next/server';
import { ChatError, type ChatActor } from '@i-renovation/shared/chat-db';
import { requireSession } from './auth';

export async function chatApi(req: Request, work: (actor: ChatActor) => Promise<unknown>) {
  const actor = await requireSession(req, ['homeowner', 'company']);
  if (actor instanceof NextResponse) return actor;
  try {
    return NextResponse.json(await work(actor), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof ChatError ? error.message : '沟通服务暂时不可用，请稍后重试' },
      { status: error instanceof ChatError ? error.status : 500, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
export async function chatJson(req: Request): Promise<Record<string, unknown>> {
  if (Number(req.headers.get('content-length')) > 16384) throw new ChatError('请求内容过大', 413);
  const text = await req.text();
  if (Buffer.byteLength(text, 'utf8') > 16384) throw new ChatError('请求内容过大', 413);
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new ChatError('请提交有效的消息内容'); }
}
