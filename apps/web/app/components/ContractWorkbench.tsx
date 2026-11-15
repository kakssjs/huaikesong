'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContractSupplement, ContractTerms, ProviderRequest, StagePlan, StageProgress, WorkflowAttachment, WorkflowDispute, WorkflowRole, WorkflowSignature, WorkflowView } from '@i-renovation/shared/workflow';
import CompanyContractProfile, { PartyFields } from './CompanyContractProfile';
import { AttachmentEditor, ImageInput } from './WorkflowImages';
import { canActOnStage, centsInput, money, parseFeePercent, parseYuan, stagesPayload, type StageInput } from './workflow-form';

const ROLES: Record<WorkflowRole, string> = { homeowner: '甲方 · 业主', company: '乙方 · 装修公司', platform: '丙方 · 平台' };
const STATES: Record<string, string> = {
  awaiting_company: '待公司确认', awaiting_homeowner: '待业主接受', ready_to_freeze: '待冻结合同', frozen: '已冻结待签署',
  partially_signed: '三方签署中', signed: '三方签署完成', signed_demo: '三方演示签署完成', superseded: '已归档旧版本', pending: '待施工提交',
  submitted: '待业主验收', rejected: '整改中', accepted: '验收通过', settled: '已结算', cancelled: '本阶段已解除',
};
const ACTIONS: Record<string, string> = {
  revise: '修订合同资料', negotiate: '业主还价', company_confirm: '公司确认报价与范围', homeowner_accept: '业主接受当前报价',
  generate_draft: '生成规则草案', freeze: '冻结当前合同版本', sign_demo: '本人演示签署', submit_stage: '提交阶段验收',
  accept_stage: '通过验收', reject_stage: '驳回并要求整改', simulate_fund: '模拟入金', simulate_release: '模拟拨付本阶段',
  simulate_refund: '模拟退款', open_dispute: '提出阶段争议', resolve_dispute: '记录独立处理结果', ai_review: 'AI 辅助复核',
  sign: '发起电子签署', fund: '发起入金', release: '申请阶段拨付', refund: '申请退款', review_payout: '复核出款',
  cancel_request: '撤回请求', propose_supplement: '提出补充协议', confirm_supplement: '确认补充协议', withdraw_supplement: '撤回补充协议',
  provider_sent: '服务商已受理请求', provider_signed: '服务商签署回执已记录', provider_settled: '服务商资金回执已记账',
  provider_failed: '服务商未完成请求', provider_cancelled: '服务商确认未执行', provider_receipt_held: '服务商回执待核对', reconcile: '与资金服务商对账',
};
/** What actually happened, in words a party can act on. A request to a provider is not a signature or a payment yet. */
const DONE: Record<string, string> = {
  sign: '已向电子签署服务商发起签署。请打开下方“服务商待办”里的链接完成签署，完成后点击“同步服务商结果”。',
  fund: '已向资金服务商发起入金。请打开下方“服务商待办”里的付款链接，付款后点击“同步服务商结果”。',
  release: '拨付请求已提交，等待平台复核；复核通过后由资金服务商执行。', refund: '退款请求已提交，等待平台复核；复核通过后由资金服务商执行。',
  review_payout: '复核结论已记录。', cancel_request: '请求已撤回。',
};
const REQUEST_KIND: Record<string, string> = { sign: '签署', fund: '入金', release: '阶段拨付', refund: '退款' };
const REQUEST_STATUS: Record<string, string> = {
  awaiting_review: '待平台复核', creating: '正在提交服务商', pending: '服务商处理中', succeeded: '已完成（服务商回执）',
  failed: '未完成', rejected: '平台已驳回', cancelled: '已撤回或作废',
};
const SUPPLEMENT_STATUS: Record<string, string> = {
  proposed: '待对方确认', frozen: '已冻结待签署', partially_signed: '三方签署中', signed: '三方已签署，已生效', signed_demo: '三方演示签署完成', withdrawn: '已撤回',
};
const OPEN = ['awaiting_review', 'creating', 'pending'];
/** Messages for the two server-side operations that are not workflow commands. */
const SERVER_OPS = {
  sync: { fail: '同步服务商结果失败，请稍后重试', done: '已同步服务商结果' },
  reconcile: { fail: '与资金服务商对账失败，请稍后重试', done: '已完成与资金服务商的对账' },
} as const;
type Act = (action: string, payload?: Record<string, unknown>) => Promise<boolean>;
const issue = (cause: unknown) => cause instanceof Error ? cause.message : '操作失败，请稍后重试';

function SignatureRecord({ s, demo }: { s: WorkflowSignature; demo: boolean }) {
  return <div><b>{ROLES[s.role]} · {s.signerName}</b><p>{new Date(s.at).toLocaleString()} · {demo ? '演示确认' : '电子签署（服务商回执）'}</p>
    {demo ? <><img className="wf-signature-preview" src={s.signatureDataUrl} alt="已应用于此版本的签名" />{s.sealDataUrl && <img className="wf-seal-preview" src={s.sealDataUrl} alt="已授权应用于此版本的公司公章" />}</>
      : s.evidence && <dl className="wf-facts">
        <div><dt>服务商</dt><dd data-no-translate>{s.evidence.provider}</dd></div><div><dt>回执号</dt><dd data-no-translate>{s.evidence.receiptId}</dd></div>
        <div><dt>实名核验</dt><dd>{s.evidence.signerVerified ? '已通过' : '未通过'}</dd></div>
        {s.role !== 'homeowner' && <div><dt>企业主体与授权核验</dt><dd>{s.evidence.organizationVerified ? '已通过' : '未通过'}</dd></div>}
        <div><dt>证据摘要</dt><dd className="wf-hash" data-no-translate>{s.evidence.evidenceHash}</dd></div>
      </dl>}
  </div>;
}

/** One party's signature on the contract or on a supplement. Demo contracts upload a signature image; real ones sign on the provider's page. */
function SignForm({ view, role, busy, act, supplement }: { view: WorkflowView; role: WorkflowRole; busy: boolean; act: Act; supplement?: ContractSupplement }) {
  const demo = view.mode === 'demo';
  const [signer, setSigner] = useState(''); const [signature, setSignature] = useState('');
  const [authorizeSeal, setAuthorizeSeal] = useState(false); const [confirmed, setConfirmed] = useState(false);
  const extra = supplement ? { supplementId: supplement.id } : {};
  return <form className="wf-section" onSubmit={async e => {
    e.preventDefault();
    const done = demo
      ? await act('sign_demo', { signerName: signer, signatureDataUrl: signature, ...(role === 'company' ? { authorizeSeal } : {}), ...extra })
      : await act('sign', { signerName: signer, ...extra });
    if (done) { setSignature(''); setConfirmed(false); setAuthorizeSeal(false); }
  }}>
    <h3>{demo ? '本方演示签署' : '本方电子签署'} · {supplement ? '补充协议' : '合同版本'} {supplement ? supplement.number : view.currentVersion}</h3>
    {!demo && <p className="wf-muted">{role === 'homeowner'
      ? '提交后由电子签署服务商核验签署人身份，并在服务商页面完成签署。只有服务商的签署回执会记入合同。'
      : '提交后由电子签署服务商核验签署人身份、企业主体与签署授权，并在服务商页面完成签署。只有服务商的签署回执会记入合同。'}</p>}
    <fieldset disabled={busy}><label>本人 / 授权签署人姓名<input value={signer} onChange={e => setSigner(e.target.value)} maxLength={200} required /></label>
      {demo && <ImageInput key={`${view.currentVersion}-${supplement?.id ?? ''}`} label="上传本人签名图片" value={signature} onChange={setSignature} handwrite disabled={busy} />}
      {demo && role === 'company' && <label className="wf-check"><input type="checkbox" checked={authorizeSeal} onChange={e => setAuthorizeSeal(e.target.checked)} />我有权为当前合同版本使用已保存的本公司公章，并明确授权本次用章</label>}
      <label className="wf-check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{demo ? '我已核对当前版本的主体、总价、分期、服务费与附件，并确认本次演示签署' : '我已核对上述版本的主体、总价、分期、服务费与附件，同意前往电子签署服务签署'}</label>
      <button type="submit" className="btn btn-primary" disabled={busy || !signer.trim() || !confirmed || (demo && (!signature || (role === 'company' && !authorizeSeal)))}>{demo ? '确认本方演示签署' : '前往电子签署'}</button></fieldset>
  </form>;
}

/** Real contracts only: every signature and money movement that goes through a provider, with its true status. */
function ProviderRequests({ view, role, busy, act, onSync, onReconcile }: { view: WorkflowView; role: WorkflowRole; busy: boolean; act: Act; onSync: () => void; onReconcile: () => void }) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const requests = [...(view.providerRequests ?? [])].reverse();
  const stageName = (id?: string) => view.effective.stages.find(s => s.id === id)?.name ?? id;
  const can = (action: string) => view.allowedActions.includes(action);
  return <div className="wf-section"><h3>服务商待办与记录</h3>
    <p className="wf-muted">签署与资金只在服务商回执到达后才记录。服务商页面完成后，点击“同步服务商结果”；已配置回调的部署会自动同步。</p>
    <div className="wf-inline"><button type="button" className="btn btn-ghost" disabled={busy} onClick={onSync}>同步服务商结果</button>
      {role === 'platform' && <button type="button" className="btn btn-ghost" disabled={busy} onClick={onReconcile}>与资金服务商对账</button>}</div>
    {view.reconciliation && <p className={view.reconciliation.ok ? 'wf-success' : 'wf-error'}>上次对账 {view.reconciliation.at ? new Date(view.reconciliation.at).toLocaleString() : ''}：核对 {view.reconciliation.checked} 笔，一致 {view.reconciliation.matched} 笔{view.reconciliation.mismatches.map(m => `；${m.externalId}：${m.reason}`).join('')}</p>}
    {!requests.length ? <p className="wf-muted">暂无服务商请求</p> : <div className="wf-table-wrap"><table className="data-table"><thead><tr><th>事项</th><th>发起方</th><th>金额 / 阶段</th><th>状态</th><th>操作</th></tr></thead><tbody>
      {requests.map((r: ProviderRequest) => {
        const mine = r.role === role;
        return <tr key={r.id}>
          <td>{REQUEST_KIND[r.kind]}{r.supplementId ? ` · 补充协议 ${(view.supplements ?? []).find(x => x.id === r.supplementId)?.number ?? ''}` : ''}<br /><small data-no-translate>{new Date(r.createdAt).toLocaleString()}</small></td>
          <td>{ROLES[r.role]}{r.signerName && <><br /><small data-no-translate>{r.signerName}</small></>}</td>
          <td>{r.amountCents !== undefined ? money(r.amountCents) : '—'}{r.stageId && <><br /><small>{stageName(r.stageId)}</small></>}{r.reason && <><br /><small data-no-translate>{r.reason}</small></>}</td>
          <td>{REQUEST_STATUS[r.status] ?? r.status}{r.hold && <><br /><small className="wf-error">本阶段已提出争议，出款结果以服务商为准</small></>}
            {r.failure && <><br /><small className={r.status === 'failed' || r.status === 'pending' ? 'wf-error' : 'wf-muted'}>{r.failure}</small></>}
            {r.review && <><br /><small>{r.review.decision === 'approved' ? '平台已通过：' : '平台已驳回：'}<span data-no-translate>{r.review.note}</span></small></>}</td>
          <td>{mine && r.status === 'pending' && r.actionUrl && <a className="btn btn-primary" href={r.actionUrl} target="_blank" rel="noopener noreferrer">{r.kind === 'sign' ? '前往服务商页面签署' : '前往服务商页面付款'}</a>}
            {mine && can('cancel_request') && (r.kind === 'sign' ? ['creating', 'pending'].includes(r.status) : r.status === 'awaiting_review') && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void act('cancel_request', { requestId: r.id })}>撤回</button>}
            {r.status === 'awaiting_review' && can('review_payout') && <span className="wf-review">
              <input aria-label="复核意见" placeholder="复核意见（必填）" value={notes[r.id] ?? ''} onChange={e => setNotes(old => ({ ...old, [r.id]: e.target.value }))} />
              <button type="button" className="btn btn-primary" disabled={busy || !(notes[r.id] ?? '').trim()} onClick={() => void act('review_payout', { requestId: r.id, decision: 'approve', note: notes[r.id] })}>通过并交服务商执行</button>
              <button type="button" className="btn btn-ghost" disabled={busy || !(notes[r.id] ?? '').trim()} onClick={() => void act('review_payout', { requestId: r.id, decision: 'reject', note: notes[r.id] })}>驳回</button></span>}</td>
        </tr>;
      })}</tbody></table></div>}
  </div>;
}

/** Changes after signing go through a supplementary agreement: proposed by the homeowner or the company, confirmed by the other, signed by all three. */
function Supplements({ view, role, busy, act, api }: { view: WorkflowView; role: WorkflowRole; busy: boolean; act: Act; api: string }) {
  const list = view.supplements ?? [];
  const can = (action: string) => view.allowedActions.includes(action);
  const base = view.effective;
  const [reason, setReason] = useState(''); const [scope, setScope] = useState(base.scope); const [days, setDays] = useState(String(base.durationDays));
  const [amount, setAmount] = useState(centsInput(base.totalCents));
  const [stages, setStages] = useState<StageInput[]>(base.stages.map(s => ({ ...s, amount: centsInput(s.amountCents) })));
  const [error, setError] = useState('');
  const locked = (id: string) => (view.stages.find(s => s.stageId === id)?.status ?? 'pending') !== 'pending';
  if (!list.length && !can('propose_supplement')) return null;
  return <div className="wf-section"><h3>补充协议</h3>
    <p className="wf-muted">{view.mode === 'demo'
      ? '已签合同正文不再修改。变更由业主或施工企业提出、对方确认，三方演示签署后才取代对应条款；已提交、验收或结算的阶段不能变更。'
      : '已签合同正文不再修改。变更由业主或施工企业提出、对方确认，三方电子签署后才取代对应条款；已提交、验收或结算的阶段不能变更。'}</p>
    {list.map(sup => <details className="wf-version" key={sup.id} open={['proposed', 'frozen', 'partially_signed'].includes(sup.status)}>
      <summary>补充协议 {sup.number} · {SUPPLEMENT_STATUS[sup.status] ?? sup.status} · 提出方 {ROLES[sup.proposedBy]} · {sup.signatures.length}/3 方签署</summary>
      <p data-no-translate>{sup.reason}</p><ul>{sup.changes.map((c, i) => <li key={i} data-no-translate>{c}</li>)}</ul>
      <p className="wf-muted">{sup.confirmations.homeowner ? '业主已确认' : '业主待确认'} · {sup.confirmations.company ? '施工企业已确认' : '施工企业待确认'}{sup.termsHash && <> · 条款校验值 <span className="wf-hash" data-no-translate>{sup.termsHash.slice(0, 16)}…</span></>}</p>
      <div className="wf-party-grid">{sup.signatures.map(s => <SignatureRecord key={s.role} s={s} demo={view.mode === 'demo'} />)}</div>
      <div className="wf-inline">
        {sup.status === 'proposed' && can('confirm_supplement') && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act('confirm_supplement', { supplementId: sup.id })}>确认补充协议</button>}
        {['proposed', 'frozen', 'partially_signed'].includes(sup.status) && can('withdraw_supplement') && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void act('withdraw_supplement', { supplementId: sup.id })}>撤回补充协议</button>}
        <a className="btn btn-ghost" href={`${api}?format=html&supplement=${encodeURIComponent(sup.id)}`} target="_blank" rel="noreferrer">下载补充协议</a>
      </div>
    </details>)}
    {can('propose_supplement') && <details><summary>提出补充协议</summary><form onSubmit={async e => {
      e.preventDefault(); setError('');
      try {
        const patch: Record<string, unknown> = {};
        if (scope.trim() !== base.scope) patch.scope = scope.trim();
        if (Number(days) !== base.durationDays) patch.durationDays = Number(days);
        const totalCents = parseYuan(amount), plan = stagesPayload(stages, totalCents);
        if (totalCents !== base.totalCents || JSON.stringify(plan) !== JSON.stringify(base.stages)) { patch.totalCents = totalCents; patch.stages = plan; }
        if (!Object.keys(patch).length) throw new Error('请至少修改一项条款');
        if (await act('propose_supplement', { reason, patch })) setReason('');
      } catch (cause) { setError(issue(cause)); }
    }}><fieldset disabled={busy}>
      <label>变更原因<textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} required /></label>
      <label>施工范围、材料规格与排除项<textarea rows={3} value={scope} onChange={e => setScope(e.target.value)} required /></label>
      <div className="wf-form-grid"><label>工期（自然日）<input type="number" min="1" step="1" value={days} onChange={e => setDays(e.target.value)} required /></label>
        <label>合同总额（元）<input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} required /></label></div>
      {stages.map((s, index) => <div key={s.id} className="wf-stage-editor"><div className="wf-form-grid">
        <label>阶段名称<input value={s.name} disabled={locked(s.id)} onChange={e => setStages(old => old.map((x, i) => i === index ? { ...x, name: e.target.value } : x))} required /></label>
        <label>阶段金额（元）<input inputMode="decimal" value={s.amount} disabled={locked(s.id)} onChange={e => setStages(old => old.map((x, i) => i === index ? { ...x, amount: e.target.value } : x))} required /></label></div>
        <label>验收标准<textarea rows={2} value={s.acceptanceCriteria} disabled={locked(s.id)} onChange={e => setStages(old => old.map((x, i) => i === index ? { ...x, acceptanceCriteria: e.target.value } : x))} required /></label>
        {locked(s.id) ? <p className="wf-muted">本阶段已提交、验收或结算，不能变更</p> : <button type="button" className="btn btn-ghost" disabled={stages.length <= 1} onClick={() => setStages(old => old.filter((_, i) => i !== index))}>移除此阶段</button>}
      </div>)}
      <button type="button" className="btn btn-ghost" disabled={stages.length >= 12} onClick={() => setStages(old => [...old, { id: crypto.randomUUID(), name: '', amount: '', acceptanceCriteria: '' }])}>添加阶段</button>
      <p className="wf-muted">分期合计必须等于新的合同总额。提交后本方视为已确认，等待对方确认。</p>
      <button className="btn btn-primary" type="submit" disabled={busy || !reason.trim()}>提交补充协议</button></fieldset>
      {error && <p role="alert" className="wf-error">{error}</p>}</form></details>}
  </div>;
}

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
      {role === 'platform' && <label>乙方承担的平台服务费率（%）<input inputMode="decimal" value={fee} onChange={e => setFee(e.target.value)} required /><small>{view.mode === 'demo' ? '只在成功模拟阶段结算时计收；签约后费率固定。' : '只在资金服务商确认成功的阶段拨付时计收；签约后费率固定。'}</small></label>}
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
  const demo = view.mode === 'demo';
  const payoutOpen = (view.providerRequests ?? []).some(r => r.kind === 'release' && r.stageId === plan.id && OPEN.includes(r.status));
  const statusLabel = status === 'settled' ? (demo ? '已模拟结算' : '已结算（服务商回执）') : STATES[status];
  return <article className="wf-stage-card">
    <div className="wf-heading"><h4>{plan.name}</h4><span className="tag">{statusLabel}</span><strong>{money(plan.amountCents)}</strong></div>
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
    {can('release') && status === 'accepted' && !payoutOpen && <button className="btn btn-primary" type="button" disabled={busy || restricted || view.availableCents < plan.amountCents} onClick={() => void act('release', { stageId: plan.id })}>申请拨付本阶段（平台复核后由资金服务商执行）</button>}
    {!demo && status === 'accepted' && payoutOpen && <p className="wf-muted">本阶段拨付请求处理中，结果以资金服务商回执为准。</p>}
    {status === 'accepted' && !payoutOpen && (demo ? view.balanceCents : view.availableCents) < plan.amountCents && <p className="wf-muted">{demo ? '模拟余额不足，请业主先模拟入金。' : '可用余额不足，请业主先入金。'}</p>}
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
  // After a supplement the stage plan in force may contain stages the signed contract did not have.
  const stage = view.effective.stages.find(s => s.id === dispute.stageId) ?? view.current.terms.stages.find(s => s.id === dispute.stageId);
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
  const [fund, setFund] = useState(''); const [refund, setRefund] = useState(''); const [refundReason, setRefundReason] = useState('');
  const api = `/api/orders/${orderId}/workflow`;
  const refresh = useCallback(async () => {
    const response = await fetch(api, { cache: 'no-store' }); const data = await response.json();
    if (!response.ok) throw new Error(data.error || '合同工作台读取失败');
    if (!data?.current?.terms) throw new Error('当前订单暂无可显示的合同资料');
    setView(data as WorkflowView);
  }, [api]);
  useEffect(() => { setView(null); setLoading(true); setError(''); setEditing(false); void refresh().catch(cause => setError(issue(cause))).finally(() => setLoading(false)); }, [refresh]);

  /** Server-side operations that are not workflow commands: fetch the providers' records, or (platform) reconcile. */
  const runServer = async (path: 'sync' | 'reconcile') => {
    if (lock.current) return; lock.current = true; setBusy(path); setError(''); setMessage('');
    try {
      const response = await fetch(`${api}/${path}`, { method: 'POST' }); const data = await response.json();
      if (!response.ok) throw new Error(data.error || SERVER_OPS[path].fail);
      setView(data as WorkflowView); setMessage(SERVER_OPS[path].done);
    } catch (cause) { setError(issue(cause)); } finally { lock.current = false; setBusy(''); }
  };

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
      const next = data as WorkflowView; setView(next);
      // A provider that did not accept the request is reported as it is, not as a success.
      const opened = (action === 'sign' || action === 'fund') ? (next.providerRequests ?? []).filter(r => r.role === role && r.kind === action).at(-1) : undefined;
      if (opened?.status === 'failed') { setError(opened.failure || '服务商没有受理本次请求'); return false; }
      setMessage(DONE[action] ?? (ACTIONS[action] ?? action) + '已记录');
      return true;
    } catch (cause) { setError(issue(cause)); return false; } finally { lock.current = false; setBusy(''); }
  };

  if (!view) return <section className="panel contract-workbench" aria-label="合同履约工作台" aria-busy={loading}>
    <h2>合同履约工作台</h2>{loading ? <p role="status">正在读取三方共享合同…</p> : <><p role="alert" className="wf-error">{error || '当前订单暂无合同资料'}</p><button className="btn btn-primary" onClick={async () => { setLoading(true); setError(''); try { await refresh(); } catch (cause) { setError(issue(cause)); } finally { setLoading(false); } }}>重新读取</button></>}
  </section>;

  const terms = view.current.terms, effective = view.effective ?? terms;
  const can = (action: string) => view.allowedActions.includes(action);
  const demo = view.mode === 'demo';
  const signed = view.status === 'signed' || view.status === 'signed_demo';
  const openSign = (supplementId?: string) => (view.providerRequests ?? []).some(r => r.kind === 'sign' && r.role === role && r.supplementId === supplementId && OPEN.includes(r.status));
  const contractSignable = can(demo ? 'sign_demo' : 'sign') && ['frozen', 'partially_signed'].includes(view.status) && !view.current.signatures.some(s => s.role === role) && !openSign();
  const openSupplement = (view.supplements ?? []).find(x => ['frozen', 'partially_signed'].includes(x.status));
  const supplementSignable = !!openSupplement && can(demo ? 'sign_demo' : 'sign') && !openSupplement.signatures.some(s => s.role === role) && !openSign(openSupplement.id);
  const stats: [string, number][] = demo
    ? [['合同总额', effective.totalCents], ['累计模拟入金', view.fundedCents], ['模拟可用余额', view.balanceCents], ['累计模拟拨付', view.releasedCents], ['累计模拟退款', view.refundedCents], ['已模拟计收服务费', view.realizedFeeCents]]
    : [['现行合同总额', effective.totalCents], ['累计入金', view.fundedCents], ['账户余额', view.balanceCents], ['待出款保留', view.reservedCents], ['可用余额', view.availableCents], ['累计拨付', view.releasedCents], ['累计退款', view.refundedCents], ['已计收服务费', view.realizedFeeCents]];
  return <section className="panel contract-workbench" aria-label="合同履约工作台" aria-busy={!!busy}>
    <div className="wf-heading"><div><p className="editorial-kicker">AI 装修签约专员</p><h2>合同履约工作台</h2></div><span className="tag tag-orange">{demo ? '演示签署 · 模拟资金' : '电子签署 · 资金服务商回执'}</span></div>
    <p className="wf-muted">{demo ? '三方核对同一份合同，逐阶段提交、验收与模拟结算。当前资金记录不代表真实托管或到账。'
      : '三方核对同一份合同。签署在电子签署服务商页面完成，入金、拨付与退款由资金服务商执行；只记录服务商回执，每笔出款先经平台复核。未接入服务商的部署只能整理和冻结合同。'}</p>
    <div className="wf-heading"><span>{ROLES[role]}</span><span className="tag tag-cyan">{STATES[view.status] ?? view.status}</span><span>订单 #{orderId} · 合同版本 {view.currentVersion} · 修订号 {view.revision}</span>
      <button className="btn btn-ghost" type="button" disabled={!!busy || loading} onClick={async () => { setError(''); setLoading(true); try { await refresh(); setMessage('已取得共享最新记录'); } catch (cause) { setError(issue(cause)); } finally { setLoading(false); } }}>刷新共享记录</button>
      <a className="btn btn-ghost" href={`${api}?format=html`} target="_blank" rel="noreferrer">下载 / 打印当前合同</a>
    </div>
    <div aria-live="polite" aria-atomic="true">{error && <p role="alert" className="wf-error">{error}</p>}{message && <p className="wf-success">{message}</p>}{busy && <p role="status">正在记录操作，请稍候…</p>}</div>
    {view.legacyContract && <div className="wf-section"><h3>历史合同只读归档</h3><p>历史合同不能转换为演示签署；后续变更须另行办理补充协议。</p>{view.legacyContent && <pre className="wf-draft" data-no-translate>{view.legacyContent}</pre>}</div>}
    <div className="wf-stats">{stats.map(([label, amount]) => <div key={label}><span>{label}</span><strong>{money(amount)}</strong></div>)}</div>
    <p className="wf-muted">乙方承担服务费 {(effective.feeBps / 100).toFixed(2)}%{demo ? '，仅按成功模拟阶段结算计收' : '，仅按资金服务商确认成功的阶段拨付计收'}。参考均价 {effective.area > 0 ? money(Math.round(effective.totalCents / effective.area)) : '待补充面积'} / ㎡，不与合同总额重复相加。</p>
    <div className="wf-party-grid">{(['company', 'homeowner', 'platform'] as const).map(key => {
      const signature = view.current.signatures.find(s => s.role === key);
      const confirmed = key === 'platform' ? null : view.current.confirmations[key];
      return <div className="wf-party" key={key}><h3>{ROLES[key]}</h3><b>{terms[key].legalName || '待补充签约主体'}</b><p>{terms[key].contact || '待补充联系方式'}</p><small>{signature ? (demo ? '本方已完成演示签署' : '本方已通过电子签署服务签署') : confirmed ? '本方已确认当前条款' : key === 'platform' ? '待本方复核签署' : '待本方确认'}</small>{signature && <small>{signature.signerName} · {new Date(signature.at).toLocaleString()}</small>}</div>;
    })}</div>
    <details className="wf-section"><summary>项目资料与当前附件</summary><dl className="wf-facts">{[['项目', terms.projectName], ['施工地点', effective.location], ['面积与口径', `${effective.area} ㎡ · ${effective.areaBasis}`], ['风格', effective.style], ['施工范围', effective.scope], ['工期', `${effective.durationDays} 个自然日`]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || '待补充'}</dd></div>)}</dl><Attachments items={effective.attachments} /></details>
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
    {role === 'company' && !view.legacyContract && <CompanyContractProfile defaultParty={terms.company} />}
    {contractSignable && <SignForm key={`contract-${view.currentVersion}`} view={view} role={role} busy={!!busy} act={act} />}
    {view.current.signatures.length > 0 && <details className="wf-section"><summary>当前版本签署记录</summary><div className="wf-party-grid">{view.current.signatures.map(s => <SignatureRecord key={s.role} s={s} demo={demo} />)}</div></details>}
    {!demo && !view.legacyContract && <ProviderRequests view={view} role={role} busy={!!busy} act={act} onSync={() => void runServer('sync')} onReconcile={() => void runServer('reconcile')} />}
    {signed && <Supplements key={`supplements-${(view.supplements ?? []).map(x => `${x.id}:${x.status}`).join('|')}`} view={view} role={role} busy={!!busy} act={act} api={api} />}
    {supplementSignable && openSupplement && <SignForm key={`supplement-${openSupplement.id}`} view={view} role={role} busy={!!busy} act={act} supplement={openSupplement} />}
    <div className="wf-section"><h3>合同阶段与履约记录</h3>{effective.stages.map(plan => <StageCard key={`${view.currentVersion}-${plan.id}`} plan={plan} progress={view.stages.find(s => s.stageId === plan.id)} view={view} busy={!!busy} act={act} />)}</div>
    {(can('simulate_fund') || can('simulate_refund')) && <div className="wf-section"><h3>模拟资金指令</h3><div className="wf-form-grid">
      {can('simulate_fund') && <form onSubmit={async e => { e.preventDefault(); try { if (await act('simulate_fund', { amountCents: parseYuan(fund) })) setFund(''); } catch (cause) { setError(issue(cause)); } }}><fieldset disabled={!!busy}><label>模拟入金金额（元）<input inputMode="decimal" value={fund} onChange={e => setFund(e.target.value)} required /></label><button className="btn btn-primary" disabled={!!busy} type="submit">模拟入金</button></fieldset></form>}
      {can('simulate_refund') && <form onSubmit={async e => { e.preventDefault(); try { if (await act('simulate_refund', { amountCents: parseYuan(refund), reason: refundReason })) { setRefund(''); setRefundReason(''); } } catch (cause) { setError(issue(cause)); } }}><fieldset disabled={!!busy}><label>模拟退款金额（元）<input inputMode="decimal" value={refund} onChange={e => setRefund(e.target.value)} required /></label><label>退款依据<textarea value={refundReason} onChange={e => setRefundReason(e.target.value)} rows={2} required /></label><button className="btn btn-ghost" disabled={!!busy || view.balanceCents <= 0} type="submit">模拟退款</button></fieldset></form>}
    </div></div>}
    {(can('fund') || can('refund')) && <div className="wf-section"><h3>资金指令（由资金服务商执行）</h3><p className="wf-muted">入金会生成服务商付款链接；退款先经平台复核，再由服务商执行。只有服务商的成功回执会记账。</p><div className="wf-form-grid">
      {can('fund') && <form onSubmit={async e => { e.preventDefault(); try { if (await act('fund', { amountCents: parseYuan(fund) })) setFund(''); } catch (cause) { setError(issue(cause)); } }}><fieldset disabled={!!busy}><label>入金金额（元）<input inputMode="decimal" value={fund} onChange={e => setFund(e.target.value)} required /></label><button className="btn btn-primary" disabled={!!busy} type="submit">发起入金</button></fieldset></form>}
      {can('refund') && <form onSubmit={async e => { e.preventDefault(); try { if (await act('refund', { amountCents: parseYuan(refund), reason: refundReason })) { setRefund(''); setRefundReason(''); } } catch (cause) { setError(issue(cause)); } }}><fieldset disabled={!!busy}><label>退款金额（元）<input inputMode="decimal" value={refund} onChange={e => setRefund(e.target.value)} required /></label><label>退款依据<textarea value={refundReason} onChange={e => setRefundReason(e.target.value)} rows={2} required /></label><button className="btn btn-ghost" disabled={!!busy || view.availableCents <= 0} type="submit">申请退款</button></fieldset></form>}
    </div></div>}
    {view.disputes.length > 0 && <div className="wf-section"><h3>争议与处理依据</h3>{view.disputes.map(d => <DisputeCard key={d.id} dispute={d} view={view} busy={!!busy} act={act} />)}</div>}
    <details className="wf-section"><summary>{demo ? '模拟资金流水' : '资金流水（服务商回执）'}</summary><div className="wf-table-wrap"><table className="data-table"><thead><tr><th>时间</th><th>类型</th><th>金额</th><th>服务费</th><th>乙方净结算</th>{!demo && <th>服务商回执</th>}</tr></thead><tbody>{view.transactions.map(tx => <tr key={tx.id}><td>{new Date(tx.at).toLocaleString()}</td><td>{tx.mode === 'demo' ? (tx.type === 'fund' ? '模拟入金' : tx.type === 'refund' ? '模拟退款' : '模拟阶段拨付') : (tx.type === 'fund' ? '入金' : tx.type === 'refund' ? '退款' : '阶段拨付')}</td><td>{money(tx.amountCents)}</td><td>{money(tx.feeCents)}</td><td>{tx.type === 'release' ? money(tx.netCents) : '—'}</td>{!demo && <td data-no-translate>{tx.receipt ? `${tx.receipt.provider} · ${tx.receipt.receiptId}` : '—'}</td>}</tr>)}{!view.transactions.length && <tr><td colSpan={demo ? 5 : 6}>{demo ? '暂无模拟资金记录' : '暂无资金记录'}</td></tr>}</tbody></table></div></details>
    <details className="wf-section"><summary>版本与操作历史</summary>{view.versions.map(v => <details className="wf-version" key={v.number}><summary>版本 {v.number} · {STATES[v.status]} · {money(v.terms.totalCents)} · {v.signatures.length}/3 {demo ? '方演示签署' : '方电子签署'}</summary><p>{v.terms.scope}</p><p>工期 {v.terms.durationDays} 天 · 乙方服务费 {(v.terms.feeBps / 100).toFixed(2)}%</p><Attachments items={v.terms.attachments} />{v.signatures.map(s => <p key={s.role}>{ROLES[s.role]} · {s.signerName} · {new Date(s.at).toLocaleString()}</p>)}</details>)}
      <ol className="wf-events">{view.events.slice().reverse().map(event => <li key={event.id}>{ACTIONS[event.action] ?? event.action} · {event.source === 'provider' ? '服务商回执' : ROLES[event.role]} · 版本 {event.version} · {new Date(event.at).toLocaleString()}{event.note && <p>{event.note}</p>}</li>)}</ol></details>
    {signed && <p className="wf-success">{demo ? '当前已签合同只读归档，变更须另行办理补充协议。阶段验收与模拟资金继续独立记录。' : '当前已签合同只读归档，变更须通过三方签署的补充协议。阶段验收与资金继续独立记录。'}</p>}
  </section>;
}
