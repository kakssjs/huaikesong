'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { loadChatDraft, saveChatDraft } from '@/lib/chat-drafts';

type Conversation = {
  id: number; orderId: number; projectId: number | null; projectName: string; contactName: string;
  participantRole: string; ownId: number; unreadCount: number; lastMessage: string; updatedAt: string;
  writable: boolean; partnerReadId: number;
};
type Message = { id: number; senderId: number; text: string; createdAt: string };
type MessagePage = { conversation: Conversation; messages: Message[]; hasMore: boolean };
const merge = (old: Message[], added: Message[]) => [...new Map([...old, ...added].map(m => [m.id, m])).values()].sort((a, b) => a.id - b.id);
const time = (date: string) => new Date(date).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', ...init });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || '沟通服务暂时不可用');
  return body as T;
}

export default function MessagesCenter({ initialConversation }: { initialConversation: number | null }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(initialConversation);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [olderLoading, setOlderLoading] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [sending, setSending] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  async function draftReply() {
    if (!conversation || !selectedId || drafts[selectedId]?.trim()) return;
    const id = selectedId, epoch = requestEpoch.current;
    setAiBusy(true); setSendError('');
    try {
      const response = await json<{ text: string }>('/api/company/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: conversation.orderId, conversationId: id, question: '请根据最近业主消息，起草关于报价、材料或工期的回复。' }) });
      if (currentId.current !== id || requestEpoch.current !== epoch) return;
      setDrafts(old => old[id]?.trim() ? old : { ...old, [id]: response.text });
      setDraftNotice('AI回复草稿已生成，请核对后点击发送；未自动发送。');
    } catch (e) { if (currentId.current === id) setSendError(e instanceof Error ? e.message : 'AI草稿失败'); }
    finally { setAiBusy(false); }
  }
  const [draftNotice, setDraftNotice] = useState('草稿仅保存在本标签页，最长保留 24 小时');
  const [listError, setListError] = useState('');
  const [error, setError] = useState('');
  const [sendError, setSendError] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const [readableCursor, setReadableCursor] = useState(0);
  const currentId = useRef(selectedId);
  const requestEpoch = useRef(0);
  const listEpoch = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const pollingCursor = useRef(0);
  const readAck = useRef(0);
  const readInFlight = useRef(false);
  const sendInFlight = useRef(false);
  const pending = useRef<Record<number, { text: string; clientKey: string }>>({});
  const draftOwners = useRef<Record<number, number>>({});
  const scrollAnchor = useRef<{ id: number; height: number; top: number } | null>(null);
  currentId.current = selectedId;

  const refreshList = useCallback(async () => {
    const epoch = ++listEpoch.current;
    try {
      const rows = await json<Conversation[]>('/api/conversations');
      if (listEpoch.current !== epoch) return;
      setConversations(rows); setListError('');
      setSelectedId(id => id ?? rows[0]?.id ?? null);
    } catch (e) { if (listEpoch.current === epoch) setListError(e instanceof Error ? e.message : '读取会话失败'); }
    finally { if (listEpoch.current === epoch) setListLoading(false); }
  }, []);

  useEffect(() => {
    void refreshList();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refreshList(); }, 8000);
    return () => clearInterval(timer);
  }, [refreshList]);

  useEffect(() => {
    const epoch = ++requestEpoch.current;
    setConversation(null); setMessages([]); setError(''); setSendError(''); setHasOlder(false);
    setAtBottom(true); setReadableCursor(0); setOlderLoading(false);
    pollingCursor.current = 0; readAck.current = 0; readInFlight.current = false; scrollAnchor.current = null;
    if (!selectedId) return;
    let cancelled = false, busy = false, initialized = false;
    const controller = new AbortController();
    setLoading(true);
    const poll = async () => {
      if (busy || cancelled || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        // Fetch every incremental page so a burst of >50 messages cannot disappear between polls.
        for (let batch = 0; batch < 5; batch++) {
          const page = await json<MessagePage>(`/api/conversations/${selectedId}/messages${initialized ? `?after=${pollingCursor.current}` : ''}`, { signal: controller.signal });
          if (cancelled || requestEpoch.current !== epoch) return;
          if (draftOwners.current[selectedId] !== page.conversation.ownId) {
            let restored = null;
            try { restored = loadChatDraft(sessionStorage, page.conversation.ownId, selectedId); } catch {}
            draftOwners.current[selectedId] = page.conversation.ownId;
            setDrafts(old => ({ ...old, [selectedId]: restored?.text ?? '' }));
            delete pending.current[selectedId];
            if (restored?.clientKey) pending.current[selectedId] = { text: restored.text.trim(), clientKey: restored.clientKey };
          }
          setConversation(page.conversation); setMessages(old => merge(old, page.messages)); setError('');
          if (!initialized) setHasOlder(page.hasMore);
          if (page.messages.length) {
            pollingCursor.current = Math.max(pollingCursor.current, page.messages.at(-1)!.id);
            setReadableCursor(pollingCursor.current);
          }
          const wasInitialized = initialized; initialized = true;
          if (!wasInitialized || !page.hasMore) break;
        }
      } catch (e) { if (!cancelled && requestEpoch.current === epoch) setError(e instanceof Error ? e.message : '新消息读取失败，将自动重试'); }
      finally { if (!cancelled && requestEpoch.current === epoch) setLoading(false); busy = false; }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    const focused = () => void poll();
    window.addEventListener('focus', focused); document.addEventListener('visibilitychange', focused);
    return () => { cancelled = true; requestEpoch.current++; controller.abort(); clearInterval(timer); window.removeEventListener('focus', focused); document.removeEventListener('visibilitychange', focused); };
  }, [selectedId]);

  useEffect(() => {
    if (!box.current) return;
    const anchor = scrollAnchor.current;
    if (anchor?.id === selectedId) {
      box.current.scrollTop = anchor.top + box.current.scrollHeight - anchor.height;
      scrollAnchor.current = null;
    } else if (atBottom) box.current.scrollTop = box.current.scrollHeight;
  }, [messages, selectedId, atBottom]);

  useEffect(() => {
    const epoch = requestEpoch.current;
    const mark = async () => {
      if (!selectedId || !readableCursor || !atBottom || readAck.current >= readableCursor || readInFlight.current || document.visibilityState !== 'visible' || !document.hasFocus()) return;
      readInFlight.current = true;
      try {
        await json(`/api/conversations/${selectedId}/read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ throughId: readableCursor }) });
        if (currentId.current === selectedId && requestEpoch.current === epoch) { readAck.current = Math.max(readAck.current, readableCursor); void refreshList(); }
      } catch { /* The next poll/focus retries; no optimistic unread clearing. */ }
      finally { if (currentId.current === selectedId && requestEpoch.current === epoch) readInFlight.current = false; }
    };
    void mark(); window.addEventListener('focus', mark); document.addEventListener('visibilitychange', mark);
    return () => { window.removeEventListener('focus', mark); document.removeEventListener('visibilitychange', mark); };
  }, [selectedId, readableCursor, atBottom, conversation, refreshList]);

  async function older() {
    if (!selectedId || !messages.length || olderLoading || !hasOlder) return;
    const id = selectedId, epoch = requestEpoch.current;
    setOlderLoading(true);
    try {
      const page = await json<MessagePage>(`/api/conversations/${id}/messages?before=${messages[0].id}`);
      if (currentId.current !== id || requestEpoch.current !== epoch) return;
      if (box.current) scrollAnchor.current = { id, height: box.current.scrollHeight, top: box.current.scrollTop };
      setMessages(old => merge(old, page.messages)); setHasOlder(page.hasMore); setError('');
    } catch (e) { if (currentId.current === id && requestEpoch.current === epoch) setError(e instanceof Error ? e.message : '历史消息读取失败'); }
    finally { if (currentId.current === id && requestEpoch.current === epoch) setOlderLoading(false); }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const id = selectedId, text = id ? (drafts[id] ?? '').trim() : '';
    if (!id || !text || text.length > 2000 || !conversation?.writable || loading || sendInFlight.current) return;
    if (pending.current[id]?.text !== text) pending.current[id] = { text, clientKey: crypto.randomUUID() };
    const body = pending.current[id];
    const ownId = conversation.ownId;
    try { saveChatDraft(sessionStorage, ownId, id, { text: drafts[id], clientKey: body.clientKey }); } catch {}
    const epoch = requestEpoch.current;
    sendInFlight.current = true; setSending(true); setSendError('');
    try {
      const sent = await json<Message>(`/api/conversations/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (draftOwners.current[id] === ownId) delete pending.current[id];
      try { if (loadChatDraft(sessionStorage, ownId, id)?.text.trim() === text) saveChatDraft(sessionStorage, ownId, id, { text: '' }); } catch {}
      setDrafts(old => draftOwners.current[id] === ownId && (old[id] ?? '').trim() === text ? { ...old, [id]: '' } : old);
      if (currentId.current === id && requestEpoch.current === epoch) {
        setMessages(old => merge(old, [sent]));
        // Poll cursor/read cursor advance only after a contiguous server read, not an own-send response.
        setAtBottom(true); setSendError('');
      }
      void refreshList();
    } catch (e) { if (currentId.current === id && requestEpoch.current === epoch) setSendError(e instanceof Error ? e.message : '发送失败，草稿已保留，可重试'); }
    finally { sendInFlight.current = false; setSending(false); }
  }

  const draft = selectedId ? drafts[selectedId] ?? '' : '';
  async function exportHistory() {
    if (!selectedId || exporting) return;
    const id=selectedId, epoch=requestEpoch.current;setExporting(true);
    try {
      const res=await fetch(`/api/conversations/${id}/export`,{cache:'no-store'});
      if(!res.ok)throw Error((await res.json()).error||'导出失败');
      const url=URL.createObjectURL(await res.blob()),link=document.createElement('a');
      link.href=url;link.download=`yushe-conversation-${id}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(e){if(currentId.current===id&&requestEpoch.current===epoch)setError(e instanceof Error?e.message:'导出失败');}
    finally{setExporting(false);}
  }
  return (
    <main className="container chat-page">
      <div className="chat-page-heading"><div><p className="editorial-kicker">PROJECT CONVERSATION</p><h1>项目沟通</h1><p>业主与选定装修公司交流材料、工期和施工细节。</p></div><Link href="/">返回首页</Link></div>
      {listError && <p role="alert" className="chat-error">{listError}。请确认已登录业主或装修公司账号。</p>}
      <div className="chat-layout">
        <aside className="chat-sidebar" aria-label="项目会话列表">
          <h2>我的会话</h2>
          {listLoading ? <p role="status">正在读取会话…</p> : !conversations.length && <p>暂无会话。业主选定装修公司后，在项目或订单中点击“沟通装修细节”。</p>}
          {conversations.map(c => <button type="button" className={`chat-contact ${selectedId === c.id ? 'active' : ''}`} key={c.id} onClick={() => { if (selectedId !== c.id) { requestEpoch.current++; setSelectedId(c.id); } }} aria-current={selectedId === c.id ? 'true' : undefined}>
            <span className="chat-contact-top"><strong data-no-translate>{c.contactName}</strong>{c.unreadCount > 0 && <span className="chat-unread" aria-label={`${c.unreadCount} 条未读`}>{c.unreadCount > 99 ? '99+' : c.unreadCount}</span>}</span>
            <span data-no-translate>{c.projectName}</span><small data-no-translate>{c.lastMessage || '可以开始交流装修细节'}</small>{!c.writable && <small>历史会话 · 只读</small>}
          </button>)}
        </aside>
        <section className="chat-thread" aria-label="当前沟通">
          {!selectedId ? <div className="chat-empty"><h2>让装修细节有共同记录</h2><p>从左侧选择项目会话，或先在项目中选定装修公司。</p></div> : <>
            <header className="chat-thread-heading"><div><h2 data-no-translate>{conversation?.contactName || '项目会话'}</h2><p data-no-translate>{conversation ? `${conversation.projectName} · 订单 #${conversation.orderId}` : '正在读取参与方信息'}</p></div>{conversation && <Link href={conversation.participantRole === 'company' ? '/contractor' : `/project/${conversation.projectId}`}>返回项目订单</Link>}</header>
            <p className="chat-boundary">聊天不会自动变更报价、合同或验收结果；协商一致后，请在相应流程正式确认。</p>
            {conversation&&<div className="chat-export"><button className="btn btn-ghost" type="button" onClick={()=>void exportHistory()} disabled={exporting}>{exporting?'正在导出…':'下载本会话记录'}</button><small>包含沟通原文，请自行核对分享范围。</small></div>}
            {error && <p role="alert" className="chat-error">{error}</p>}
            <div className="chat-messages" ref={box} tabIndex={0} aria-label="沟通历史" onScroll={() => { const el = box.current; if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 60); }}>
              {hasOlder && <button type="button" className="btn btn-ghost chat-history" disabled={olderLoading} onClick={() => void older()}>{olderLoading ? '正在读取…' : '加载更早消息'}</button>}
              {loading && <p role="status">正在读取消息…</p>}
              {!loading && !messages.length && !error && <p className="chat-empty">可以从材料选择、施工时间或现场需求开始沟通。</p>}
              <ol className="chat-message-list">{messages.map(m => <li key={m.id} className={`chat-message ${m.senderId === conversation?.ownId ? 'own' : ''}`}>
                <span className="chat-message-meta" data-no-translate>{m.senderId === conversation?.ownId ? '我' : conversation?.contactName} · {time(m.createdAt)}</span>
                <p data-no-translate>{m.text}</p>{m.senderId === conversation?.ownId && <small>{m.id <= conversation.partnerReadId ? '对方已读' : '已发送'}</small>}
              </li>)}</ol>
            </div>
            {!atBottom && <button type="button" className="btn btn-ghost" onClick={() => setAtBottom(true)}>回到最新消息 ↓</button>}
            <form onSubmit={send} className="chat-composer">
              {conversation && !conversation.writable && <p role="status">承接关系已变更或订单已关闭，此会话仅可阅读。</p>}
              <label htmlFor="chat-draft">装修细节</label>
              {conversation?.participantRole === 'company' && <button type="button" className="btn btn-ghost" style={{ marginBottom: 8 }} disabled={aiBusy || loading || !conversation.writable || !!draft.trim()} onClick={() => void draftReply()}>{aiBusy ? 'DeepSeek 正在起草…' : 'AI起草报价回复（审核后发送）'}</button>}
              <textarea id="chat-draft" rows={3} maxLength={2000} value={draft} disabled={!conversation?.writable || loading} placeholder="例如：厨房台面希望用石英石，能否确认材料型号和施工时间？" onChange={e => {
                if(!selectedId||!conversation)return;
                const text=e.target.value;setDrafts(old=>({...old,[selectedId]:text}));let saved=false;
                try{saved=saveChatDraft(sessionStorage,conversation.ownId,selectedId,{text,...(pending.current[selectedId]?.text===text.trim()?{clientKey:pending.current[selectedId].clientKey}:{})});}catch{}
                setDraftNotice(saved?'草稿已保存在本标签页':'浏览器未允许保存，当前页面内仍可继续编辑');
              }} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
              <small role="status">{draftNotice}</small>
              {sendError && <p role="alert" className="chat-error">{sendError}。草稿已保留，点击发送可重试。</p>}
              <div className="chat-composer-actions"><small>{draft.length}/2000 · Enter 发送，Shift + Enter 换行</small><button className="btn btn-primary" type="submit" disabled={sending || loading || !draft.trim() || !conversation?.writable}>{sending ? '发送中…' : '发送消息'}</button></div>
            </form>
          </>}
        </section>
      </div>
    </main>
  );
}
