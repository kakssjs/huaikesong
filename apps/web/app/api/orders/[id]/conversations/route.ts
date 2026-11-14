import { openOrderConversation } from '@i-renovation/shared/chat-db';
import { chatApi } from '@/lib/chat-api';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return chatApi(req, async actor => openOrderConversation(Number((await ctx.params).id), actor));
}
