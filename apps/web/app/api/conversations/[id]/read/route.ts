import { markConversationRead } from '@i-renovation/shared/chat-db';
import { chatApi, chatJson } from '@/lib/chat-api';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return chatApi(req, async actor => markConversationRead(Number((await ctx.params).id), actor, Number((await chatJson(req)).throughId)));
}
