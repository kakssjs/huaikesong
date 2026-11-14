import { readConversationMessages, sendConversationMessage } from '@i-renovation/shared/chat-db';
import { chatApi, chatJson } from '@/lib/chat-api';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return chatApi(req, async actor => {
    const url = new URL(req.url);
    return readConversationMessages(Number((await ctx.params).id), actor, {
      ...(url.searchParams.has('before') ? { before: Number(url.searchParams.get('before')) } : {}),
      ...(url.searchParams.has('after') ? { after: Number(url.searchParams.get('after')) } : {}),
    });
  });
}
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return chatApi(req, async actor => sendConversationMessage(Number((await ctx.params).id), actor, await chatJson(req)));
}
