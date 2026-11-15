'use client';
import { useEffect, useState } from 'react';
import { FAIR_BID_POLICY } from '@i-renovation/shared/fair-bidding';
import { cnyToWan } from '@i-renovation/shared/commission';

type DemoProject = { id: number; name: string; orderId: number; status: string; referenceCny: number; referenceWeeks: number; bids: { companyId: number; amount: string; weeks: string }[] };

export default function DemoWorkspace() {
  const [data, setData] = useState<{ accounts: { id: number; name: string; phone: string; role: string }[]; projects: DemoProject[] }>({ accounts: [], projects: [] });
  const [credentials, setCredentials] = useState<{ name: string; phone: string; password: string }[]>([]);
  const [orderId, setOrderId] = useState(''), [companyId, setCompanyId] = useState('');
  const [amount, setAmount] = useState(''), [weeks, setWeeks] = useState(''), [note, setNote] = useState('');
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [confirmClean, setConfirmClean] = useState(false);
  async function load() { const r = await fetch('/api/boss/demo', { cache: 'no-store' }); if (!r.ok) throw new Error('读取演示数据失败'); setData(await r.json()); }
  useEffect(() => { void load().catch(e => setMessage(e.message)); }, []);
  async function action(action: string) {
    setBusy(true); setMessage('');
    try {
      const r = await fetch(action === 'ai' ? '/api/company/assistant' : '/api/boss/demo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, orderId: Number(orderId), companyId: Number(companyId), amount, weeks: Number(weeks), note }) });
      const body = await r.json(); if (!r.ok) throw new Error(body.error || '操作失败');
      if (action === 'create') setCredentials(body.credentials);
      if (action === 'ai') setNote(old => old.trim() ? old : body.text);
      if (action === 'clean') { setCredentials([]); setOrderId(''); setCompanyId(''); setConfirmClean(false); }
      if (action === 'bid') { setNote(''); setAmount(''); setWeeks(''); setCompanyId(''); }
      setMessage(action === 'ai' ? '说明草稿已生成。报价金额和工期请对照参考报价自行填写，核对后再确认提交。' : action === 'bid' ? '演示报价已提交，匹配任务已安排。可继续为下一支装修队报价。' : '操作完成');
      await load();
    } catch (e) { setMessage(e instanceof Error ? e.message : '操作失败'); }
    finally { setBusy(false); }
  }
  const companies = data.accounts.filter(a => a.role === 'company');
  const selected = data.projects.find(p => String(p.orderId) === orderId);
  const hasBid = (id: number) => !!selected?.bids.some(b => b.companyId === id);
  // 只有开放竞标中的演示项目、且该队尚未报价时才能提交
  const canBid = selected?.status === 'open' && !!companyId && !hasBid(Number(companyId));
  return <section className="panel"><h2>临时演示装修队与项目</h2><p>模拟账号只参与演示项目，未认证为真实装修队、不产生真实付款。AI只生成草稿，报价由你确认提交。</p>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '14px 0' }}>
      <button type="button" className="btn" disabled={busy || data.accounts.length > 0} onClick={() => void action('create')}>创建3支装修队及2个演示项目</button>
      <button type="button" className="btn" disabled={busy || !data.accounts.length} onClick={() => setConfirmClean(!confirmClean)}>清理演示数据</button>
    </div>
    {confirmClean && <div role="alert" className="notice notice-warn" style={{ marginBottom: 14 }}><p>将删除演示账号、演示项目及其报价、聊天和演示合同，真实账号与项目保留。</p><button type="button" className="btn" disabled={busy} onClick={() => void action('clean')}>确认清理演示数据</button></div>}
    {credentials.length > 0 && <details open><summary>演示登录凭据（密码仅本次显示，请自行保存）</summary>{credentials.map(c => <p key={c.phone}>{c.name} · 账号 {c.phone} · 密码 <code>{c.password}</code></p>)}</details>}
    <ul>{data.accounts.map(a => <li key={a.id}>{a.name} · {a.phone}</li>)}</ul>
    {data.accounts.length > 0 && data.projects.length === 0 && <p className="wf-muted">当前没有开放的演示项目：可以清理后重新创建，或用演示业主账号发布一个新项目。</p>}
    {data.projects.length > 0 && <>
      <div className="form-group"><label htmlFor="demo-order">演示项目</label><select id="demo-order" className="form-input" disabled={busy} value={orderId} onChange={e => { setOrderId(e.target.value); setNote(''); }}><option value="">请选择</option>{data.projects.map(p => <option key={p.id} value={p.orderId} disabled={p.status !== 'open'}>{p.name}{p.status !== 'open' ? '（已选定装修队，不再接受报价）' : ''}</option>)}</select>
        {selected && <p className="wf-muted">{selected.referenceCny > 0
          ? `平台参考报价 ¥${selected.referenceCny.toLocaleString()}（约 ${cnyToWan(selected.referenceCny)} 万元）· 参考工期 ${selected.referenceWeeks} 周。合理报价区间约 ${cnyToWan(selected.referenceCny * FAIR_BID_POLICY.minQuoteRatio)}–${cnyToWan(selected.referenceCny * FAIR_BID_POLICY.maxQuoteRatio)} 万元：低于下限会被拦截，高于上限会在匹配中降低优先级。`
          : '该项目暂无平台参考报价。'}
          {selected.bids.length > 0 ? ` 已报价：${selected.bids.map(b => `${companies.find(a => a.id === b.companyId)?.name ?? '装修队'} ${b.amount} 万元 / ${b.weeks} 周`).join('；')}。` : ' 尚无报价。'}</p>}</div>
      <div className="form-group"><label htmlFor="demo-company">装修队</label><select id="demo-company" className="form-input" disabled={busy} value={companyId} onChange={e => { setCompanyId(e.target.value); setNote(''); }}><option value="">请选择</option>{companies.map(a => <option key={a.id} value={a.id} disabled={hasBid(a.id)}>{a.name}{hasBid(a.id) ? '（已报价）' : ''}</option>)}</select></div>
      <div className="form-group"><label htmlFor="demo-amount">报价（万元）</label><input id="demo-amount" className="form-input" value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" /></div>
      <div className="form-group"><label htmlFor="demo-weeks">工期（周）</label><input id="demo-weeks" className="form-input" value={weeks} onChange={e => setWeeks(e.target.value)} inputMode="numeric" /></div>
      <div className="form-group"><label htmlFor="demo-note">报价说明</label>
        <button type="button" className="btn btn-ghost" style={{ marginBottom: 8 }} disabled={busy || !canBid || !!note.trim()} onClick={() => void action('ai')}>DeepSeek 生成报价说明草稿</button>
        <textarea id="demo-note" className="form-input" rows={6} maxLength={2000} value={note} onChange={e => setNote(e.target.value)} /></div>
      <button type="button" className="btn btn-primary" disabled={busy || !canBid || !amount || !weeks || !note} onClick={() => void action('bid')}>人工确认并提交演示报价</button>
      <p className="wf-muted">体验业主和公司沟通：保存上方账号，使用手机号密码登录；业主选定装修队后，在消息中心使用AI回复草稿。</p>
    </>}
    {message && <p role="status">{message}</p>}
  </section>;
}
