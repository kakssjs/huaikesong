'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function ProjectChatButton({ orderId }: { orderId: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function open() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const res = await fetch(`/api/orders/${orderId}/conversations`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || '暂时无法进入沟通');
      router.push(`/messages?conversation=${body.id}`);
    } catch (e) { setError(e instanceof Error ? e.message : '暂时无法进入沟通'); }
    finally { setBusy(false); }
  }
  return <span className="chat-entry"><button className="btn" type="button" disabled={busy} onClick={() => void open()}>{busy ? '正在进入…' : '沟通装修细节'}</button>{error && <span role="alert" className="chat-error">{error}</span>}</span>;
}
