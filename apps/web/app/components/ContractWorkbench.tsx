'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContractTerms, StagePlan, StageProgress, WorkflowAttachment, WorkflowDispute, WorkflowRole, WorkflowView } from '@i-renovation/shared/workflow';
import CompanyContractProfile, { PartyFields } from './CompanyContractProfile';
import { AttachmentEditor, ImageInput } from './WorkflowImages';
import { canActOnStage, centsInput, money, parseFeePercent, parseYuan, stagesPayload, type StageInput } from './workflow-form';

const ROLES: Record<WorkflowRole, string> = { homeowner: '甲方 · 业主', company: '乙方 · 装修公司', platform: '丙方 · 平台' };
const STATES: Record<string, string> = {
  awaiting_company: '待公司确认', awaiting_homeowner: '待业主接受', ready_to_freeze: '待冻结合同', frozen: '已冻结待签署',
  partially_signed: '三方签署中', signed_demo: '三方演示签署完成', superseded: '已归档旧版本', pending: '待施工提交',
  submitted: '待业主验收', rejected: '整改中', accepted: '验收通过', settled: '已模拟结算', cancelled: '本阶段已解除',
};
const ACTIONS: Record<string, string> = {
  revise: '修订合同资料', negotiate: '业主还价', company_confirm: '公司确认报价与范围', homeowner_accept: '业主接受当前报价',
  generate_draft: '生成规则草案', freeze: '冻结当前合同版本', sign_demo: '本人演示签署', submit_stage: '提交阶段验收',
  accept_stage: '通过验收', reject_stage: '驳回并要求整改', simulate_fund: '模拟入金', simulate_release: '模拟拨付本阶段',
  simulate_refund: '模拟退款', open_dispute: '提出阶段争议', resolve_dispute: '记录独立处理结果', ai_review: 'AI 辅助复核',
};
type Act = (action: string, payload?: Record<string, unknown>) => Promise<boolean>;
const issue = (cause: unknown) => cause instanceof Error ? cause.message : '操作失败，请稍后重试';

function Attachments({ items }: { items: WorkflowAttachment[] }) {
  if (!items.length) return <p className="wf-muted">暂无附件</p>;
  return <div className="wf-attachment-grid">{items.map(item => <div className="wf-attachment" key={item.id}>
    {item.dataUrl && <a href={item.dataUrl} download={item.name}><img src={item.dataUrl} alt={item.name} /></a>}
    {item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.name}</a> : <span>{item.name}</span>}
    <small>{item.dataUrl ? '图片已纳入本版本快照' : '外部内容未冻结'}</small>{item.note && <small>{item.note}</small>}
  </div>)}</div>;
}

function TermsEditor({ view, role, busy, act, onClose }: { view: WorkflowView; role: WorkflowRole; busy: boolean; act: Act; onClose: () => void }) {
  const [terms, setTerms] = useState<ContractTerms>(() => structuredClone(view.current.terms));
  const [baseRevision] = useState(view.revision);
  const [amount, setAmount] = useState(centsInput(terms.totalCents));
  const [fee, setFee] = useState(centsInput(terms.feeBps));
  const [stages, setStages] = useState<StageInput[]>(terms.stages.map(s => ({ ...s, amount: centsInput(s.amountCents) })));
  const [note, setNote] = useState(''); const [error, setError] = useState('');
  const stale = baseRevision !== view.revision;
  const update = <K extends keyof ContractTerms>(key: K, value: ContractTerms[K]) => setTerms(previous => ({ ...previous, [key]: value }));
  return <form className="wf-section" onSubmit={async e => {
    e.preventDefault(); if (busy || stale) return; setError('');
    try {
      let patch: Partial<ContractTerms>;
      if (role === 'homeowner') patch = { homeowner: terms.homeowner, location: terms.location, area: terms.area, areaBasis: terms.areaBasis, style: terms.style, attachments: terms.attachments };
      else if (role === 'company') { const totalCents = parseYuan(amount); patch = { company: terms.company, scope: terms.scope, durationDays: terms.durationDays, totalCents, stages: stagesPayload(stages, totalCents), attachments: terms.attachments }; }
      else patch = { platform: terms.platform, feeBps: parseFeePercent(fee) };
      if (await act('revise', { patch, note })) onClose();
    } catch (cause) { setError(issue(cause)); }
  }}>
    <h3>修订本方合同资料</h3><p className="wf-muted">保存后创建新版本，并清空旧版确认与待签状态。已签版本保留归档。</p>
    <fieldset disabled={busy || stale}>
      <PartyFields value={terms[role]} onChange={party => update(role, party)} />
      {role === 'homeowner' && <div className="wf-form-grid">
        <label>施工地点<input value={terms.location} onChange={e => update('location', e.target.value)} required /></label>
        <label>约定面积（㎡）<input type="number" min="0.01" step="0.01" value={terms.area || ''} onChange={e => update('area', Number(e.target.value))} required /></label>
        <label>面积计量口径<input value={terms.areaBasis} onChange={e => update('areaBasis', e.target.value)} placeholder="建筑面积 / 套内面积 / 实际施工面积" required /></label>
        <label>装修风格<input value={terms.style} onChange={e => update('style', e.target.value)} required /></label>
      </div>}
      {role === 'company' && <>
        <label>施工范围、材料规格与排除项<textarea value={terms.scope} onChange={e => update('scope', e.target.value)} rows={4} required /></label>
        <div className="wf-form-grid"><label>合同总额（元）<input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} required /></label>
          <label>工期（自然日）<input type="number" min="1" step="1" value={terms.durationDays || ''} onChange={e => update('durationDays', Number(e.target.value))} required /></label></div>
        <h4>合同分期与验收标准</h4>
        {stages.map((s, index) => <div key={s.id} className="wf-stage-editor">
          <div className="wf-form-grid"><label>阶段名称<input value={s.name} onChange={e => setStages(old => old.map((x, i) => i === index ? { ...x, name: e.target.value } : x))} required /></label>
            <label>阶段金额（元）<input inputMode="decimal" value={s.amount} onChange={e => setStages(old => old.map((x, i) => i === index ? { ...x, amount: e.target.value } : x))} required /></label>
            <label>计划日期<input type="date" value={s.plannedDate ?? ''} onChange={e => setStages(old => old.map((x, i) => i === index ? { ...x, plannedDate: e.target.value } : x))} /></label></div>
          <label>验收标准<textarea rows={2} value={s.acceptanceCriteria} onChange={e => setStages(old => old.map((x, i) => i === index ? { ...x, acceptanceCriteria: e.target.value } : x))} required /></label>
          <button type="button" className="btn btn-ghost" disabled={stages.length <= 1} onClick={() => setStages(old => old.filter((_, i) => i !== index))}>移除此阶段</button>
        </div>)}
        <button type="button" className="btn btn-ghost" disabled={stages.length >= 12} onClick={() => setStages(old => [...old, { id: crypto.randomUUID(), name: '', amount: '', acceptanceCriteria: '' }])}>添加阶段</button>
        <p className="wf-muted">请逐期核对金额，分期合计必须等于合同总额。</p>
      </>}
      {role === 'platform' && <label>乙方承担的平台服务费率（%）<input inputMode="decimal" value={fee} onChange={e => setFee(e.target.value)} required /><small>只在成功模拟阶段结算时计收；签约后费率固定。</small></label>}
      {role !== 'platform' && <AttachmentEditor value={terms.attachments} onChange={attachments => update('attachments', attachments)} disabled={busy} />}
      <label>本次修订说明<textarea value={note} onChange={e => setNote(e.target.value)} rows={2} /></label>
      <button className="btn btn-primary" type="submit" disabled={busy || stale}>保存为新版本</button>
    </fieldset>
    {stale && <p role="alert" className="wf-error">共享记录已更新。请关闭编辑并重新打开，核对最新资料后再保存。</p>}
    {error && <p role="alert" className="wf-error">{error}</p>}
    <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>取消编辑</button>
  </form>;
}

function StageCard({ plan, progress, view, busy, act }: { plan: StagePlan; progress: StageProgress | undefined; view: WorkflowView; busy: boolean; act: Act }) {
  const [note, setNote] = useState(''); const [evidence, setEvidence] = useState<WorkflowAttachment[]>([]);
  const [reason, setReason] = useState(''); const [disputeReason, setDisputeReason] = useState('');
  const [disputeEvidence, setDisputeEvidence] = useState<WorkflowAttachment[]>([]);
  const status = progress?.status ?? 'pending';
  const can = (action: string) => canActOnStage(status, view.allowedActions, action);
  const restricted = view.disputes.some(d => d.stageId === plan.id && d.status === 'open');
  return <article className="wf-stage-card">
    <div className="wf-heading"><h4>{plan.name}</h4><span className="tag">{STATES[status]}</span><strong>{money(plan.amountCents)}</strong></div>
    <p>{plan.acceptanceCriteria}</p>{plan.plannedDate && <p className="wf-muted">计划日期：{plan.plannedDate}</p>}
    {restricted && <p className="wf-error">本阶段争议未处理，未结算金额受限：{status === 'settled' ? money(0) : money(plan.amountCents)}</p>}
    {(progress?.attempts ?? []).map((attempt, index) => <details key={index} className="wf-attempt">
      <summary>第 {index + 1} 次提交 · {new Date(attempt.submittedAt).toLocaleString()} · {attempt.review === 'accepted' ? '已通过' : attempt.review === 'rejected' ? '已驳回' : '待验收'}</summary>
      <p>{attempt.note}</p><Attachments items={attempt.evidence} />{attempt.reason && <p className="wf-error">整改原因：{attempt.reason}</p>}
    </details>)}
    {can('submit_stage') && ['pending', 'rejected'].includes(status) && <form onSubmit={async e => { e.preventDefault(); if (await act('submit_stage', { stageId: plan.id, evidence, note })) { setEvidence([]); setNote(''); } }}>
      <fieldset disabled={busy}><label>施工进度或整改说明<textarea value={note} onChange={e => setNote(e.target.value)} required rows={2} /></label>
        <AttachmentEditor value={evidence} onChange={setEvidence} disabled={busy} allowUrl={false} />
        <button className="btn btn-primary" type="submit" disabled={busy || !evidence.length || !note.trim()}>{status === 'rejected' ? '提交整改后验收' : '提交阶段验收'}</button></fieldset>
    </form>}
    {status === 'submitted' && (can('accept_stage') || can('reject_stage')) && <div className="wf-stage-actions">
      {can('accept_stage') && <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void act('accept_stage', { stageId: plan.id })}>本人确认通过验收</button>}
      {can('reject_stage') && <form onSubmit={async e => { e.preventDefault(); if (await act('reject_stage', { stageId: plan.id, reason })) setReason(''); }}>
        <label>驳回及整改原因<textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} required disabled={busy} /></label>
        <button className="btn btn-ghost" disabled={busy || !reason.trim()} type="submit">驳回并要求整改</button>
      </form>}
    </div>}
    {can('simulate_release') && status === 'accepted' && <button className="btn btn-primary" type="button" disabled={busy || restricted || view.balanceCents < plan.amountCents} onClick={() => void act('simulate_release', { stageId: plan.id })}>模拟拨付本阶段</button>}
    {status === 'accepted' && view.balanceCents < plan.amountCents && <p className="wf-muted">模拟余额不足，请业主先模拟入金。</p>}
    {can('open_dispute') && <details className="wf-dispute-form"><summary>提出本阶段争议</summary>
      <form onSubmit={async e => { e.preventDefault(); if (await act('open_dispute', { stageId: plan.id, reason: disputeReason, evidence: disputeEvidence })) { setDisputeReason(''); setDisputeEvidence([]); } }}>
        <fieldset disabled={busy}><label>争议事项与依据<textarea rows={2} value={disputeReason} onChange={e => setDisputeReason(e.target.value)} required /></label>
          <AttachmentEditor value={disputeEvidence} onChange={setDisputeEvidence} disabled={busy} allowUrl={false} />
          <button type="submit" className="btn btn-ghost" disabled={busy || !disputeReason.trim() || restricted}>提出阶段争议</button></fieldset>
      </form></details>}
  </article>;
}

function DisputeCard({ dispute, view, busy, act }: { dispute: WorkflowDispute; view: WorkflowView; busy: boolean; act: Act }) {
  const [party, setParty] = useState(''); const [basis, setBasis] = useState(''); const [outcome, setOutcome] = useState('');
  const [disposition, setDisposition] = useState<'continue' | 'cancel_stage'>('continue');
  const stage = view.current.terms.stages.find(s => s.id === dispute.stageId);
  const stageStatus = view.stages.find(s => s.stageId === dispute.stageId)?.status;
  const canCancel = stageStatus !== undefined && !['settled', 'cancelled'].includes(stageStatus);
  return <article className="wf-stage-card"><h4>{stage?.name ?? dispute.stageId} · {dispute.status === 'open' ? '争议处理中' : '已记录处理结果'}</h4>
    <p>{dispute.reason}</p><Attachments items={dispute.evidence} />
    <p className="wf-muted">受限范围：本阶段未结算金额；已完成的结算记录保留。</p>
    {dispute.resolution ? <dl className="wf-facts"><div><dt>独立处理方</dt><dd>{dispute.resolution.independentParty}</dd></div><div><dt>处理依据</dt><dd>{dispute.resolution.basis}</dd></div><div><dt>处理结果</dt><dd>{dispute.resolution.outcome}</dd></div></dl>
      : view.allowedActions.includes('resolve_dispute') && <form onSubmit={e => { e.preventDefault(); void act('resolve_dispute', { disputeId: dispute.id, independentParty: party, basis, outcome, disposition }); }}>
        <fieldset disabled={busy}><label>独立处理方<input value={party} onChange={e => setParty(e.target.value)} required /></label><label>处理依据<textarea value={basis} onChange={e => setBasis(e.target.value)} required rows={2} /></label><label>处理结果<textarea value={outcome} onChange={e => setOutcome(e.target.value)} required rows={2} /></label>
          <label>处理安排<select value={disposition} onChange={e => setDisposition(e.target.value as 'continue' | 'cancel_stage')}>
            <option value="continue">继续履约</option>
            <option value="cancel_stage" disabled={!canCancel}>依据独立处理结果解除本阶段并允许退款</option>
          </select></label>
          <p className="wf-muted">解除仅适用于未结算阶段，须填写独立处理方与依据；已结算资金和原验收历史保留。</p>
          <p className="wf-muted">平台只记录处理方与依据；解除争议限制不会自动拨付或退款。</p><button className="btn btn-primary" type="submit" disabled={busy || !party.trim() || !basis.trim() || !outcome.trim() || disposition === 'cancel_stage' && !canCancel}>记录独立处理结果</button></fieldset>
      </form>}
  </article>;
}

export default function ContractWorkbench({ orderId, role }: { orderId: number; role: WorkflowRole }) {
  const [view, setView] = useState<WorkflowView | null>(null); const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(''); const lock = useRef(false);
  const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [editing, setEditing] = useState(false);
  const [offer, setOffer] = useState(''); const [offerNote, setOfferNote] = useState('');
  const [signer, setSigner] = useState(''); const [signature, setSignature] = useState('');
  const [authorizeSeal, setAuthorizeSeal] = useState(false); const [confirmVersion, setConfirmVersion] = useState(false);
  const [fund, setFund] = useState(''); const [refund, setRefund] = useState(''); const [refundReason, setRefundReason] = useState('');
  const api = `/api/orders/${orderId}/workflow`;
  const refresh = useCallback(async () => {
    const response = await fetch(api, { cache: 'no-store' }); const data = await response.json();
    if (!response.ok) throw new Error(data.error || '合同工作台读取失败');
    if (!data?.current?.terms) throw new Error('当前订单暂无可显示的合同资料');
    setView(data as WorkflowView);
  }, [api]);
  useEffect(() => { setView(null); setLoading(true); setError(''); setEditing(false); void refresh().catch(cause => setError(issue(cause))).finally(() => setLoading(false)); }, [refresh]);
  useEffect(() => { setConfirmVersion(false); setAuthorizeSeal(false); setSignature(''); }, [view?.currentVersion]);

  const act: Act = async (action, payload = {}) => {
    if (!view || lock.current || !view.allowedActions.includes(action)) return false;
    lock.current = true; setBusy(action); setError(''); setMessage('');
    try {
      const response = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, expectedRevision: view.revision, requestKey: crypto.randomUUID(), payload }) });
      const data = await response.json();
      if (response.status === 409) {
        await refresh(); setError((data.error || '共享版本已变化') + '。已刷新最新记录，请核对后重新操作；原请求未自动重试。'); return false;
      }
      if (!response.ok) {
        if (data.workflow?.current?.terms) setView(data.workflow as WorkflowView);
        throw new Error(response.status === 503 && action === 'ai_review' ? (data.error || 'AI 复核未配置或暂不可用，规则草案仍可使用') : (data.error || '操作失败，请稍后重试'));
      }
      setView(data as WorkflowView); setMessage((ACTIONS[action] ?? action) + '已记录');
      if (action === 'sign_demo') { setSignature(''); setConfirmVersion(false); setAuthorizeSeal(false); }
      return true;
    } catch (cause) { setError(issue(cause)); return false; } finally { lock.current = false; setBusy(''); }
  };

  if (!view) return <section className="panel contract-workbench" aria-label="合同履约工作台" aria-busy={loading}>
    <h2>合同履约工作台</h2>{loading ? <p role="status">正在读取三方共享合同…</p> : <><p role="alert" className="wf-error">{error || '当前订单暂无合同资料'}</p><button className="btn btn-primary" onClick={async () => { setLoading(true); setError(''); try { await refresh(); } catch (cause) { setError(issue(cause)); } finally { setLoading(false); } }}>重新读取</button></>}
  </section>;

  const terms = view.current.terms;
  const can = (action: string) => view.allowedActions.includes(action);
  const ownSignature = view.current.signatures.find(s => s.role === role);
  return <section className="panel contract-workbench" aria-label="合同履约工作台" aria-busy={!!busy}>
    <div className="wf-heading"><div><p className="editorial-kicker">AI 装修签约专员</p><h2>合同履约工作台</h2></div><span className="tag tag-orange">演示签署 · 模拟资金</span></div>
    <p className="wf-muted">三方核对同一份合同，逐阶段提交、验收与模拟结算。当前资金记录不代表真实托管或到账。</p>
    <div className="wf-heading"><span>{ROLES[role]}</span><span className="tag tag-cyan">{STATES[view.status] ?? view.status}</span><span>订单 #{orderId} · 合同版本 {view.currentVersion} · 修订号 {view.revision}</span>
      <button className="btn btn-ghost" type="button" disabled={!!busy || loading} onClick={async () => { setError(''); setLoading(true); try { await refresh(); setMessage('已取得共享最新记录'); } catch (cause) { setError(issue(cause)); } finally { setLoading(false); } }}>刷新共享记录</button>
      <a className="btn btn-ghost" href={`${api}?format=html`} target="_blank" rel="noreferrer">下载 / 打印当前合同</a>
    </div>
    <div aria-live="polite" aria-atomic="true">{error && <p role="alert" className="wf-error">{error}</p>}{message && <p className="wf-success">{message}</p>}{busy && <p role="status">正在记录操作，请稍候…</p>}</div>
    {view.legacyContract && <div className="wf-section"><h3>历史合同只读归档</h3><p>历史合同不能转换为演示签署；后续变更须另行办理补充协议。</p>{view.legacyContent && <pre className="wf-draft" data-no-translate>{view.legacyContent}</pre>}</div>}
    <div className="wf-stats">{[['合同总额', terms.totalCents], ['累计模拟入金', view.fundedCents], ['模拟可用余额', view.balanceCents], ['累计模拟拨付', view.releasedCents], ['累计模拟退款', view.refundedCents], ['已模拟计收服务费', view.realizedFeeCents]].map(([label, amount]) => <div key={label}><span>{label}</span><strong>{money(Number(amount))}</strong></div>)}</div>
    <p className="wf-muted">乙方承担服务费 {(terms.feeBps / 100).toFixed(2)}%，仅按成功模拟阶段结算计收。参考均价 {terms.area > 0 ? money(Math.round(terms.totalCents / terms.area)) : '待补充面积'} / ㎡，不与合同总额重复相加。</p>
    <div className="wf-party-grid">{(['company', 'homeowner', 'platform'] as const).map(key => {
      const signed = view.current.signatures.find(s => s.role === key);
      const confirmed = key === 'platform' ? null : view.current.confirmations[key];
      return <div className="wf-party" key={key}><h3>{ROLES[key]}</h3><b>{terms[key].legalName || '待补充签约主体'}</b><p>{terms[key].contact || '待补充联系方式'}</p><small>{signed ? '本方已完成演示签署' : confirmed ? '本方已确认当前条款' : key === 'platform' ? '待本方复核签署' : '待本方确认'}</small>{signed && <small>{signed.signerName} · {new Date(signed.at).toLocaleString()}</small>}</div>;
    })}</div>
    <details className="wf-section"><summary>项目资料与当前附件</summary><dl className="wf-facts">{[['项目', terms.projectName], ['施工地点', terms.location], ['面积与口径', `${terms.area} ㎡ · ${terms.areaBasis}`], ['风格', terms.style], ['施工范围', terms.scope], ['工期', `${terms.durationDays} 个自然日`]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || '待补充'}</dd></div>)}</dl><Attachments items={terms.attachments} /></details>
    <div className="wf-section"><h3>待办与规则校验</h3>{view.todos.length > 0 ? <ul>{view.todos.map((todo, i) => <li key={i}>{todo}</li>)}</ul> : <p>当前没有待办事项</p>}
      {view.validation.missing.length > 0 && <><h4>待补全资料</h4><ul>{view.validation.missing.map((s, i) => <li key={i}>{s}</li>)}</ul></>}
      {view.validation.errors.map((s, i) => <p className="wf-error" key={i}>{s}</p>)}{view.validation.warnings.map((s, i) => <p className="wf-muted" key={i}>{s}</p>)}
      <div className="wf-inline">{can('revise') && <button className="btn btn-ghost" disabled={!!busy} onClick={() => setEditing(v => !v)}>{editing ? '收起资料编辑' : '补全 / 修订本方资料'}</button>}
        {['generate_draft', 'ai_review', 'company_confirm', 'homeowner_accept', 'freeze'].filter(can).map(action => <button type="button" key={action} className={['company_confirm', 'homeowner_accept', 'freeze'].includes(action) ? 'btn btn-primary' : 'btn btn-ghost'} disabled={!!busy || editing} onClick={() => void act(action)}>{ACTIONS[action]}</button>)}
      </div><p className="wf-muted">规则草案无需模型。AI 复核为可选辅助，不替代三方确认。</p>
      {view.aiReview && <div><b>{view.aiReview.mode === 'model' ? 'AI 辅助复核记录' : '规则检查记录'}</b><p>{view.aiReview.error || view.aiReview.summary || '尚未调用模型复核'}</p>{view.aiReview.issues?.map((item, i) => <p key={i}>{item}</p>)}</div>}
    </div>
    {editing && can('revise') && <TermsEditor key={orderId} view={view} role={role} busy={!!busy} act={act} onClose={() => setEditing(false)} />}
    {can('negotiate') && <details className="wf-section"><summary>向公司提出还价</summary><form onSubmit={async e => { e.preventDefault(); try { if (await act('negotiate', { totalCents: parseYuan(offer), note: offerNote })) { setOffer(''); setOfferNote(''); } } catch (cause) { setError(issue(cause)); } }}>
      <fieldset disabled={!!busy}><label>建议合同总额（元）<input inputMode="decimal" value={offer} onChange={e => setOffer(e.target.value)} required /></label><label>还价理由与范围说明<textarea value={offerNote} onChange={e => setOfferNote(e.target.value)} rows={2} required /></label><p className="wf-muted">提交后生成新版本，等待公司重新确认。</p><button className="btn btn-primary" type="submit" disabled={!!busy}>提交还价</button></fieldset></form></details>}
    <details className="wf-section" open={view.status === 'ready_to_freeze' || view.status === 'frozen'}><summary>三方合同草案与冻结内容</summary><pre className="wf-draft" data-no-translate>{view.draftText || '请先生成规则草案'}</pre>{view.current.termsHash && <p className="wf-hash">条款校验值：{view.current.termsHash}</p>}</details>
    {role === 'company' && !view.legacyContract && <CompanyContractProfile defaultParty={terms.company} onSaved={profile => { if (!signer) setSigner(profile.authorizedSignerName); }} />}
    {can('sign_demo') && !ownSignature && <form className="wf-section" onSubmit={e => { e.preventDefault(); void act('sign_demo', { signerName: signer, signatureDataUrl: signature, ...(role === 'company' ? { authorizeSeal } : {}) }); }}>
      <h3>本方演示签署 · 版本 {view.currentVersion}</h3><fieldset disabled={!!busy}><label>本人 / 授权签署人姓名<input value={signer} onChange={e => setSigner(e.target.value)} maxLength={200} required /></label>
        <ImageInput key={view.currentVersion} label="上传本人签名图片" value={signature} onChange={setSignature} handwrite disabled={!!busy} />
        {role === 'company' && <label className="wf-check"><input type="checkbox" checked={authorizeSeal} onChange={e => setAuthorizeSeal(e.target.checked)} />我有权为当前合同版本使用已保存的本公司公章，并明确授权本次用章</label>}
        <label className="wf-check"><input type="checkbox" checked={confirmVersion} onChange={e => setConfirmVersion(e.target.checked)} />我已核对当前版本的主体、总价、分期、服务费与附件，并确认本次演示签署</label>
        <button type="submit" className="btn btn-primary" disabled={!!busy || !signature || !signer.trim() || !confirmVersion || role === 'company' && !authorizeSeal}>确认本方演示签署</button></fieldset>
    </form>}
    {view.current.signatures.length > 0 && <details className="wf-section"><summary>当前版本签署记录</summary><div className="wf-party-grid">{view.current.signatures.map(s => <div key={s.role}><b>{ROLES[s.role]} · {s.signerName}</b><p>{new Date(s.at).toLocaleString()} · 演示确认</p><img className="wf-signature-preview" src={s.signatureDataUrl} alt="已应用于此版本的签名" />{s.sealDataUrl && <img className="wf-seal-preview" src={s.sealDataUrl} alt="已授权应用于此版本的公司公章" />}</div>)}</div></details>}
    <div className="wf-section"><h3>合同阶段与履约记录</h3>{terms.stages.map(plan => <StageCard key={`${view.currentVersion}-${plan.id}`} plan={plan} progress={view.stages.find(s => s.stageId === plan.id)} view={view} busy={!!busy} act={act} />)}</div>
    {(can('simulate_fund') || can('simulate_refund')) && <div className="wf-section"><h3>模拟资金指令</h3><div className="wf-form-grid">
      {can('simulate_fund') && <form onSubmit={async e => { e.preventDefault(); try { if (await act('simulate_fund', { amountCents: parseYuan(fund) })) setFund(''); } catch (cause) { setError(issue(cause)); } }}><fieldset disabled={!!busy}><label>模拟入金金额（元）<input inputMode="decimal" value={fund} onChange={e => setFund(e.target.value)} required /></label><button className="btn btn-primary" disabled={!!busy} type="submit">模拟入金</button></fieldset></form>}
      {can('simulate_refund') && <form onSubmit={async e => { e.preventDefault(); try { if (await act('simulate_refund', { amountCents: parseYuan(refund), reason: refundReason })) { setRefund(''); setRefundReason(''); } } catch (cause) { setError(issue(cause)); } }}><fieldset disabled={!!busy}><label>模拟退款金额（元）<input inputMode="decimal" value={refund} onChange={e => setRefund(e.target.value)} required /></label><label>退款依据<textarea value={refundReason} onChange={e => setRefundReason(e.target.value)} rows={2} required /></label><button className="btn btn-ghost" disabled={!!busy || view.balanceCents <= 0} type="submit">模拟退款</button></fieldset></form>}
    </div></div>}
    {view.disputes.length > 0 && <div className="wf-section"><h3>争议与处理依据</h3>{view.disputes.map(d => <DisputeCard key={d.id} dispute={d} view={view} busy={!!busy} act={act} />)}</div>}
    <details className="wf-section"><summary>模拟资金流水</summary><div className="wf-table-wrap"><table className="data-table"><thead><tr><th>时间</th><th>类型</th><th>金额</th><th>服务费</th><th>乙方净结算</th></tr></thead><tbody>{view.transactions.map(tx => <tr key={tx.id}><td>{new Date(tx.at).toLocaleString()}</td><td>{tx.type === 'fund' ? '模拟入金' : tx.type === 'refund' ? '模拟退款' : '模拟阶段拨付'}</td><td>{money(tx.amountCents)}</td><td>{money(tx.feeCents)}</td><td>{tx.type === 'release' ? money(tx.netCents) : '—'}</td></tr>)}{!view.transactions.length && <tr><td colSpan={5}>暂无模拟资金记录</td></tr>}</tbody></table></div></details>
    <details className="wf-section"><summary>版本与操作历史</summary>{view.versions.map(v => <details className="wf-version" key={v.number}><summary>版本 {v.number} · {STATES[v.status]} · {money(v.terms.totalCents)} · {v.signatures.length} 方演示签署</summary><p>{v.terms.scope}</p><p>工期 {v.terms.durationDays} 天 · 乙方服务费 {(v.terms.feeBps / 100).toFixed(2)}%</p><Attachments items={v.terms.attachments} />{v.signatures.map(s => <p key={s.role}>{ROLES[s.role]} · {s.signerName} · {new Date(s.at).toLocaleString()}</p>)}</details>)}
      <ol className="wf-events">{view.events.slice().reverse().map(event => <li key={event.id}>{ACTIONS[event.action] ?? event.action} · {ROLES[event.role]} · 版本 {event.version} · {new Date(event.at).toLocaleString()}{event.note && <p>{event.note}</p>}</li>)}</ol></details>
    {view.status === 'signed_demo' && <p className="wf-success">当前已签合同只读归档，变更须另行办理补充协议。阶段验收与模拟资金继续独立记录。</p>}
  </section>;
}
