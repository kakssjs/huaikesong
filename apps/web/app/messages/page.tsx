import MessagesCenter from '../components/MessagesCenter';

export const metadata = { title: '项目沟通 · 予舍', description: '业主与选定的装修公司围绕同一项目交流装修细节。' };
export default async function MessagesPage({ searchParams }: { searchParams: Promise<{ conversation?: string }> }) {
  const id = Number((await searchParams).conversation);
  return <MessagesCenter initialConversation={Number.isSafeInteger(id) && id > 0 ? id : null} />;
}
