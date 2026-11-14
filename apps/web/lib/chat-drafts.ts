type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type ChatDraft = { text: string; clientKey?: string };
const key = (uid: number, conversationId: number) => `yushe.chat-draft.v1:${uid}:${conversationId}`;
export function loadChatDraft(store: Store, uid: number, conversationId: number, time = Date.now()): ChatDraft | null {
  try {
    const raw = store.getItem(key(uid, conversationId));
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (typeof value.text !== 'string' || value.text.length > 2000 || !Number.isFinite(value.savedAt) || time - value.savedAt > 86400000 || value.savedAt > time
      || value.clientKey !== undefined && (typeof value.clientKey !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(value.clientKey))) {
      store.removeItem(key(uid, conversationId)); return null;
    }
    return { text: value.text, ...(value.clientKey ? { clientKey: value.clientKey } : {}) };
  } catch { return null; }
}
export function saveChatDraft(store: Store, uid: number, conversationId: number, draft: ChatDraft, time = Date.now()): boolean {
  try {
    if (!draft.text.trim()) store.removeItem(key(uid, conversationId));
    else {
      if (draft.text.length > 2000) return false;
      store.setItem(key(uid, conversationId), JSON.stringify({ ...draft, savedAt: time }));
    }
    return true;
  } catch { return false; }
}
