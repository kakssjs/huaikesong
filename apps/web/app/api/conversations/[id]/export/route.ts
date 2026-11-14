import { exportConversation } from '@i-renovation/shared/chat-db';
import { chatApi } from '@/lib/chat-api';
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const response = await chatApi(req, async actor => exportConversation(Number((await ctx.params).id), actor));
  if (response.ok) {
    const id = Number((await ctx.params).id);
    response.headers.set('Content-Disposition', `attachment; filename="yushe-conversation-${id}.json"`);
    response.headers.set('X-Content-Type-Options', 'nosniff');
  }
  return response;
}
