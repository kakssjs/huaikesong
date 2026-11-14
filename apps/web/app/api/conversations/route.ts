import { listConversations } from '@i-renovation/shared/chat-db';
import { chatApi } from '@/lib/chat-api';

export async function GET(req: Request) {
  return chatApi(req, actor => listConversations(actor));
}
