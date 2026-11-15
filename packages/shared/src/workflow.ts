/** Pure contract domain. All monetary values are integer fen; no database, filesystem or external calls. */
export type WorkflowRole = 'homeowner' | 'company' | 'platform';
export type WorkflowActor = { uid: number; role: 'homeowner' | 'company' | 'boss' };
/** 'signed_demo' is kept for contracts signed before real mode existed; 'signed' is a contract signed through a provider. */
export type WorkflowStatus = 'awaiting_company' | 'awaiting_homeowner' | 'ready_to_freeze' | 'frozen' | 'partially_signed' | 'signed' | 'signed_demo' | 'superseded';
/** A workflow is created in exactly one mode and never changes it. 'demo' is only reachable with CONTRACT_MODE=demo or on contracts that already exist. */
export type ContractMode = 'real' | 'demo';
export const getContractMode = (value: string | undefined): ContractMode => value === 'demo' ? 'demo' : 'real';
export const isSignedStatus = (status: WorkflowStatus | string): boolean => status === 'signed' || status === 'signed_demo';
export interface ContractParty { legalName: string; registrationId: string; representative: string; contact: string; address?: string }
export interface WorkflowAttachment { id: string; name: string; kind: 'reference' | 'plan' | 'quote' | 'material'; dataUrl?: string; url?: string; note?: string }
export interface StagePlan { id: string; name: string; amountCents: number; acceptanceCriteria: string; plannedDate?: string }
export interface ContractTerms {
  homeowner: ContractParty; company: ContractParty; platform: ContractParty;
  projectName: string; location: string; area: number; areaBasis: string; style: string; scope: string;
  totalCents: number; durationDays: number; feeBps: number; stages: StagePlan[]; attachments: WorkflowAttachment[];
  source: { project: unknown; quote: unknown; design: unknown };
}
export interface CompanyContractProfile { party: ContractParty; authorizedSignerName: string; sealDataUrl?: string; updatedAt: string; mode: 'demo' }
/** What a signing provider returns once a party has signed. Generic on purpose: no field belongs to one vendor. */
export interface SigningReceipt {
  provider: string; externalId: string; receiptId: string; signerVerified: boolean; signedAt: string; evidenceHash: string; certificateFingerprint?: string;
  /** The company and the platform sign for an organisation: the provider must also have verified the organisation and the signer's authority. */
  organizationVerified?: boolean;
  /** Optional echoes. When a provider returns them they must match what was asked for. */
  signerName?: string; termsHash?: string;
  /** Absent means signed. A session the signer declined or let expire is closed without a signature. */
  outcome?: 'signed' | 'declined' | 'expired';
}
/** What a payment provider returns for one money movement. */
export interface PaymentReceipt {
  provider: string; externalId: string; receiptId: string; status: 'pending' | 'succeeded' | 'failed'; amountCents: number; confirmedAt?: string; reconciled: boolean;
  /** Optional echo of the platform fee the provider split off a payout. When present it must equal the fee fixed at the platform's review. */
  feeCents?: number;
}
export interface WorkflowSignature {
  role: WorkflowRole; actorId: number; at: string; mode: ContractMode; signerName: string; signatureDataUrl?: string;
  sealDataUrl?: string; termsHash: string; assetVersion?: string; signatureHash?: string; sealHash?: string;
  sealBinding?: { contractId: string; version: number; mode: 'demo' };
  evidence?: SigningReceipt;
}
export interface ContractVersion {
  number: number; contractId: string; terms: ContractTerms; status: WorkflowStatus;
  confirmations: { company?: string; homeowner?: string }; signatures: WorkflowSignature[];
  termsHash?: string; finalFileHash?: string; frozenAt?: string; createdAt: string;
}
export interface StageAttempt { submittedAt: string; evidence: WorkflowAttachment[]; note: string; review?: 'accepted' | 'rejected'; reviewAt?: string; reason?: string }
export interface StageProgress { stageId: string; status: 'pending' | 'submitted' | 'rejected' | 'accepted' | 'settled' | 'cancelled'; attempts: StageAttempt[]; acceptedAt?: string; settledAt?: string; cancelledAt?: string; cancellationDisputeId?: string }
export interface WorkflowTransaction { id: string; requestKey: string; type: 'fund' | 'release' | 'refund'; amountCents: number; feeCents: number; netCents: number; stageId?: string; reason?: string; at: string; mode: ContractMode; receipt?: PaymentReceipt }
export interface WorkflowDispute { id: string; stageId: string; reason: string; evidence: WorkflowAttachment[]; status: 'open' | 'resolved'; createdAt: string; resolution?: { independentParty: string; basis: string; outcome: string; disposition: 'continue' | 'cancel_stage'; at: string } }
/** source='provider' marks a change that came from a provider receipt or callback rather than from a party. */
export interface WorkflowEvent { id: string; action: string; actorId: number; role: WorkflowRole; version: number; at: string; mode: ContractMode; note?: string; source?: 'provider' }
export interface AIReview { status: 'not_called' | 'succeeded' | 'failed'; mode: 'rules' | 'model'; summary?: string; issues?: string[]; at?: string; error?: string; tokensUsed?: number }
/**
 * One real action that has to go through a provider: a party signing, or money moving.
 * awaiting_review: money leaving the ledger waits for the platform's review and has not been sent anywhere.
 * creating: the server is (or was) asking the provider to open the session or payment.
 * pending: the provider accepted it; only the provider's receipt can close it.
 */
export type ProviderRequestKind = 'sign' | 'fund' | 'release' | 'refund';
export type ProviderRequestStatus = 'awaiting_review' | 'creating' | 'pending' | 'succeeded' | 'failed' | 'rejected' | 'cancelled';
export interface ProviderRequest {
  id: string; kind: ProviderRequestKind; status: ProviderRequestStatus; role: WorkflowRole; actorId: number; version: number;
  createdAt: string; updatedAt: string;
  signerName?: string; termsHash?: string; supplementId?: string;
  amountCents?: number; stageId?: string; reason?: string;
  /** Platform fee inside a payout, fixed when the platform approves it so the provider can split the payment. */
  feeCents?: number;
  provider?: string; externalId?: string; actionUrl?: string; expiresAt?: string;
  review?: { decision: 'approved' | 'rejected'; note: string; actorId: number; at: string };
  hold?: { disputeId: string; at: string };
  failure?: string; settledAt?: string;
}
/** A change to a signed contract. The signed contract text is never edited; a supplement signed by all three parties replaces the effective terms. */
export type SupplementStatus = 'proposed' | 'frozen' | 'partially_signed' | 'signed' | 'signed_demo' | 'withdrawn';
export interface ContractSupplement {
  id: string; number: number; status: SupplementStatus; reason: string; proposedBy: WorkflowRole; proposedAt: string;
  baseVersion: number; terms: ContractTerms; changes: string[]; confirmations: { company?: string; homeowner?: string };
  termsHash?: string; frozenAt?: string; signatures: WorkflowSignature[]; finalFileHash?: string;
  effectiveAt?: string; withdrawnAt?: string; withdrawnBy?: WorkflowRole;
}
export interface ReconciliationMismatch { transactionId: string; externalId: string; reason: string }
export interface ReconciliationReport { ok: boolean; checked: number; matched: number; mismatches: ReconciliationMismatch[]; at?: string; actorId?: number }
export interface WorkflowState {
  mode: ContractMode; id: string; orderId: number; projectId: number; homeownerId: number; companyId: number;
  revision: number; currentVersion: number; versions: ContractVersion[]; stages: StageProgress[];
  transactions: WorkflowTransaction[]; disputes: WorkflowDispute[]; events: WorkflowEvent[];
  legacyContract: boolean; legacyContent?: string; aiReview: AIReview;
  /** Absent on workflows stored before these features existed; read with ?? []. */
  providerRequests?: ProviderRequest[]; supplements?: ContractSupplement[]; reconciliation?: ReconciliationReport;
}
export interface WorkflowView extends WorkflowState {
  current: ContractVersion; status: WorkflowStatus; balanceCents: number; fundedCents: number; releasedCents: number;
  refundedCents: number; realizedFeeCents: number; reservedCents: number; availableCents: number;
  validation: { missing: string[]; errors: string[]; warnings: string[] };
  /** The terms in force: the signed contract, or the latest supplement all three parties signed. */
  effective: ContractTerms;
  draftText: string; todos: string[]; allowedActions: string[];
}
export type WorkflowAction = 'revise' | 'negotiate' | 'company_confirm' | 'homeowner_accept' | 'generate_draft' | 'freeze' | 'sign_demo' | 'sign'
  | 'submit_stage' | 'accept_stage' | 'reject_stage' | 'simulate_fund' | 'simulate_release' | 'simulate_refund' | 'fund' | 'release' | 'refund'
  | 'open_dispute' | 'resolve_dispute' | 'ai_review' | 'review_payout' | 'cancel_request'
  | 'propose_supplement' | 'confirm_supplement' | 'withdraw_supplement';
export interface WorkflowCommand { action: WorkflowAction; expectedRevision: number; requestKey: string; payload?: Record<string, unknown> }
export class WorkflowError extends Error { constructor(message: string, public code = 'INVALID_INPUT', public status = 400) { super(message); this.name = 'WorkflowError'; } }
const fail = (message: string, code = 'INVALID_INPUT', status = 400): never => { throw new WorkflowError(message, code, status); };
export const workflowRole = (actor: WorkflowActor): WorkflowRole => actor.role === 'boss' ? 'platform' : actor.role;
export function textValue(value: unknown, name: string, required = true, max = 2000): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) return fail(`${name}缺失或格式无效`);
  return value.trim();
}
export function positiveCents(value: unknown, name = '金额'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 100_000_000_000) return fail(`${name}必须是正数整数分`);
  return value;
}
export function validateImageDataUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1_398_200) return fail('图片不得超过1MiB');
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4) return fail('图片仅支持PNG/JPEG/WebP，不支持SVG或无效格式');
  let raw: string;
  try { raw = atob(match[2]); } catch { return fail('图片编码无效'); }
  if (raw.length > 1024 * 1024 || raw.length < 12) return fail('图片大小无效');
  const byte = (i: number) => raw.charCodeAt(i);
  const valid = match[1] === 'png' ? raw.length >= 24 && [137,80,78,71,13,10,26,10].every((v,i)=>byte(i)===v)
    : match[1] === 'jpeg' ? byte(0)===255 && byte(1)===216 && byte(2)===255 && byte(raw.length-2)===255 && byte(raw.length-1)===217
    : raw.slice(0,4)==='RIFF' && raw.slice(8,12)==='WEBP';
  if (!valid) return fail('图片实际类型与声明格式不一致');
  return value;
}
export function validateParty(value: unknown): ContractParty {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('主体资料格式无效');
  const p = value as Record<string, unknown>;
  return { legalName:textValue(p.legalName,'主体名称',false,200),registrationId:textValue(p.registrationId,'登记资料',false,200),
    representative:textValue(p.representative,'授权代表',false,200),contact:textValue(p.contact,'联系方式',false,200),
    ...(p.address === undefined ? {} : {address:textValue(p.address,'主体地址',false,400)}) };
}
export function validateAttachments(value: unknown, requireEvidence = false): WorkflowAttachment[] {
  if (!Array.isArray(value) || value.length > 12 || (requireEvidence && !value.length)) return fail('附件数量应为1至12项，参考附件可为空');
  const ids = new Set<string>(); let bytes = 0;
  return value.map(raw => {
    if (!raw || typeof raw !== 'object') return fail('附件格式无效');
    const id=textValue(raw.id,'附件编号',true,100), name=textValue(raw.name,'附件名',true,200);
    if (ids.has(id)) return fail('附件编号不能重复'); ids.add(id);
    if (!['reference','plan','quote','material'].includes(raw.kind)) return fail('附件类型无效');
    const item: WorkflowAttachment={id,name,kind:raw.kind};
    if (raw.dataUrl !== undefined) { item.dataUrl=validateImageDataUrl(raw.dataUrl); bytes+=item.dataUrl.length; }
    if (raw.url !== undefined) {
      const url=textValue(raw.url,'参考链接',true,2000);
      try { const parsed = new URL(url); if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return fail('外部参考仅允许HTTPS链接'); } catch { return fail('参考链接无效'); }
      item.url=url;
    }
    if (!item.url && !item.dataUrl) return fail('附件须提供图片或HTTPS参考链接');
    if (raw.note !== undefined) item.note=textValue(raw.note,'附件说明',false,1000);
    if (bytes > 8_000_000) return fail('全部附件图片合计过大');
    return item;
  });
}
export function defaultStagePlan(totalCents: number): StagePlan[] {
  positiveCents(totalCents); const names=['基础及隐蔽工程','中期工程','后期工程','竣工'];
  return allocateStages(names.map((name,i)=>({id:`stage-${i+1}`,name,amountCents:[20,30,30,20][i],acceptanceCriteria:'按双方约定的施工清单、材料规格与现场验收记录验收'})),totalCents);
}
function allocateStages(stages: StagePlan[], total: number): StagePlan[] {
  const basis=stages.reduce((s,x)=>s+x.amountCents,0); let used=0;
  return stages.map((s,i)=>{ const amountCents=i===stages.length-1?total-used:Math.floor(total*s.amountCents/basis); used+=amountCents; return {...s,amountCents}; });
}
function validateStages(value: unknown,total: number): StagePlan[] {
  if (!Array.isArray(value) || !value.length || value.length>12) return fail('分期期数应为1至12期');
  const ids=new Set<string>();
  const stages=value.map(s=>{
    const id=textValue(s?.id,'阶段编号',true,100); if(ids.has(id))return fail('阶段编号不能重复');ids.add(id);
    return {id,name:textValue(s?.name,'阶段名称',true,100),amountCents:positiveCents(s?.amountCents,'阶段金额'),acceptanceCriteria:textValue(s?.acceptanceCriteria,'验收标准',true,2000),
      ...(s?.plannedDate===undefined?{}:{plannedDate:textValue(s.plannedDate,'阶段日期',false,100)})};
  });
  if (stages.reduce((s,x)=>s+x.amountCents,0)!==total) return fail('分期金额合计必须等于合同总价');return stages;
}
export function validateContractTerms(t: ContractTerms, mode: ContractMode='demo') {
  const missing: string[]=[],errors: string[]=[],warnings: string[]=[mode==='real'
    ?'规则生成草案，签署前须由各方人工复核条款；签署以电子签署服务商的回执为准，资金以资金服务商的回执为准。'
    :'规则生成草案；未经正式身份核验，不构成正式电子签署或真实资金托管。'];
  for(const [label,p] of [['业主',t.homeowner],['公司',t.company],['平台',t.platform]] as const) {
    if(!p.legalName)missing.push(`${label}主体名称`); if(!p.contact)missing.push(`${label}联系方式`);
    if(label!=='业主'&&!p.registrationId)missing.push(`${label}登记资料`);
    if(label!=='业主'&&!p.representative)missing.push(`${label}授权代表`);
  }
  if(!t.location)missing.push('施工地点');if(!(t.area>0))missing.push('面积');if(!t.areaBasis)missing.push('面积计量口径');if(!t.style)missing.push('装修风格');if(!t.scope)missing.push('施工范围');
  try {positiveCents(t.totalCents);validateStages(t.stages,t.totalCents);}catch(e){errors.push((e as Error).message);}
  if(!Number.isSafeInteger(t.durationDays)||t.durationDays<=0)missing.push('施工工期');
  if(!Number.isSafeInteger(t.feeBps)||t.feeBps<0||t.feeBps>10000)errors.push('费率应为0至10000个基点');
  if(t.attachments.some(x=>x.url))warnings.push('外部参考链接仅为参考，未冻结远程文件内容；验收以约定清单为准。');
  if(!t.attachments.length)warnings.push('尚未附加参考图或图纸，请在签署前人工复核。');
  return {missing,errors,warnings};
}
export function initializeWorkflow(seed: {orderId:number;projectId:number;homeownerId:number;companyId:number;terms:ContractTerms;legacyContent?:string}, at=new Date().toISOString(), mode:ContractMode='real'): WorkflowState {
  return {mode,id:`workflow-${seed.orderId}`,orderId:seed.orderId,projectId:seed.projectId,homeownerId:seed.homeownerId,companyId:seed.companyId,revision:0,currentVersion:1,
    versions:[{number:1,contractId:`contract-${seed.orderId}`,terms:structuredClone(seed.terms),status:'awaiting_company',confirmations:{},signatures:[],createdAt:at}],
    stages:seed.terms.stages.map(s=>({stageId:s.id,status:'pending',attempts:[]})),transactions:[],disputes:[],events:[],providerRequests:[],supplements:[],legacyContract:seed.legacyContent!==undefined,
    ...(seed.legacyContent===undefined?{}:{legacyContent:seed.legacyContent}),aiReview:{status:'not_called',mode:'rules',summary:'规则草案，模型未调用'}};
}
export function assertWorkflowParty(s:WorkflowState,a:WorkflowActor) {
  if(a.role==='boss'&&a.uid===0)return;
  if((a.role==='homeowner'&&a.uid===s.homeownerId)||(a.role==='company'&&a.uid===s.companyId))return;
  return fail('无权访问该合同','FORBIDDEN',403);
}
const OPEN_REQUEST:ProviderRequestStatus[]=['awaiting_review','creating','pending'];
const OPEN_SUPPLEMENT:SupplementStatus[]=['proposed','frozen','partially_signed'];
export const isOpenRequest=(r:ProviderRequest)=>OPEN_REQUEST.includes(r.status);
/** Money that has left, or may be leaving, through a provider and so cannot be promised to anything else. */
export function ledgerTotals(s:WorkflowState) {
  const sum=(kind:string)=>s.transactions.filter(t=>t.type===kind).reduce((a,t)=>a+t.amountCents,0);
  const fundedCents=sum('fund'),releasedCents=sum('release'),refundedCents=sum('refund'),balanceCents=fundedCents-releasedCents-refundedCents;
  const reservedCents=(s.providerRequests??[]).filter(r=>(r.kind==='release'||r.kind==='refund')&&isOpenRequest(r)).reduce((a,r)=>a+(r.amountCents??0),0);
  return {fundedCents,releasedCents,refundedCents,balanceCents,reservedCents,availableCents:balanceCents-reservedCents,realizedFeeCents:s.transactions.reduce((a,t)=>a+t.feeCents,0)};
}
/** The terms in force. A signed contract is never edited; the latest supplement signed by all three parties takes over. */
export function effectiveTerms(s:WorkflowState):ContractTerms {
  const signed=(s.supplements??[]).filter(x=>x.status==='signed'||x.status==='signed_demo');
  return signed.length?signed[signed.length-1].terms:s.versions.at(-1)!.terms;
}
export const openSupplement=(s:WorkflowState)=>(s.supplements??[]).find(x=>OPEN_SUPPLEMENT.includes(x.status));
const ROLE_ACTIONS:Record<WorkflowAction,WorkflowRole[]>={
  revise:['homeowner','company','platform'],negotiate:['homeowner'],company_confirm:['company'],homeowner_accept:['homeowner'],generate_draft:['homeowner','company','platform'],
  freeze:['homeowner','company','platform'],sign_demo:['homeowner','company','platform'],sign:['homeowner','company','platform'],submit_stage:['company'],accept_stage:['homeowner'],reject_stage:['homeowner'],
  simulate_fund:['homeowner'],simulate_release:['homeowner'],simulate_refund:['homeowner'],fund:['homeowner'],release:['homeowner'],refund:['homeowner'],
  open_dispute:['homeowner','company'],resolve_dispute:['platform'],ai_review:['homeowner','company','platform'],
  review_payout:['platform'],cancel_request:['homeowner','company','platform'],
  propose_supplement:['homeowner','company'],confirm_supplement:['homeowner','company'],withdraw_supplement:['homeowner','company'],
};
/** Actions that only make sense in one mode. A workflow never accepts the other mode's actions, so demo money can never pass for real money. */
const DEMO_ONLY:WorkflowAction[]=['sign_demo','simulate_fund','simulate_release','simulate_refund'];
const REAL_ONLY:WorkflowAction[]=['sign','fund','release','refund','review_payout','cancel_request'];
export function validateCommand(cmd:WorkflowCommand) {
  if(!cmd||!Object.hasOwn(ROLE_ACTIONS,cmd.action)||!Number.isSafeInteger(cmd.expectedRevision)||cmd.expectedRevision<0||typeof cmd.requestKey!=='string'||!/^[A-Za-z0-9_.:-]{8,120}$/.test(cmd.requestKey))return fail('操作、版本或幂等请求键无效');
  if(cmd.payload!==undefined&&(!cmd.payload||typeof cmd.payload!=='object'||Array.isArray(cmd.payload)))return fail('payload必须是对象');
}
export interface ReduceContext {
  at:string;termsHash?:string;profile?:CompanyContractProfile|null;signatureHash?:string;appliedSignatureDataUrl?:string;appliedSealDataUrl?:string;sealHash?:string;aiReview?:AIReview;
  /** Receipt a signing provider returned for this very command. Present only when the server really called the provider. */
  signing?:SigningReceipt;
  /** Receipt a payment provider returned for this very command. */
  payment?:PaymentReceipt;
  /**
   * Name of the provider the server has configured for this action (signing provider for sign, payment provider for money).
   * With it, a real action opens a provider request instead of failing; the request is recorded only when the provider's receipt arrives.
   */
  provider?:string;
  /** Digest the server computed over a supplement's frozen terms; needed when the second party confirms it. */
  supplementTermsHash?:string;
}
/** Checks a signing receipt against what was asked. Returns the reason it cannot be recorded, or null. */
function signingReceiptProblem(r:SigningReceipt,role:WorkflowRole,signerName:string,termsHash:string):{message:string;code:string}|null {
  if(!r.signerVerified)return {message:'服务商未完成签署人实名核验，签署无效',code:'SIGNER_NOT_VERIFIED'};
  if(role!=='homeowner'&&r.organizationVerified!==true)return {message:'服务商未核验企业主体及签署人授权，签署无效',code:'ORGANIZATION_NOT_VERIFIED'};
  for(const [name,value] of [['服务商',r.provider],['外部单号',r.externalId],['回执号',r.receiptId]] as const)if(typeof value!=='string'||!value.trim())return {message:`签署回执缺少${name}`,code:'INVALID_RECEIPT'};
  if(typeof r.evidenceHash!=='string'||!/^[0-9a-f]{64}$/i.test(r.evidenceHash))return {message:'签署回执的证据摘要无效',code:'INVALID_RECEIPT'};
  if(r.signerName!==undefined&&r.signerName!==signerName)return {message:'服务商回执中的签署人与本次签署人不一致',code:'INVALID_RECEIPT'};
  if(r.termsHash!==undefined&&r.termsHash!==termsHash)return {message:'服务商回执绑定的条款校验值与本次签署的版本不一致',code:'INVALID_RECEIPT'};
  return null;
}
const allSignatures=(s:WorkflowState)=>[...s.versions.flatMap(v=>v.signatures),...(s.supplements??[]).flatMap(x=>x.signatures)];
/** Stage progress follows the stage plan of the terms in force; progress of kept stages is preserved. */
function applySupplement(s:WorkflowState,sup:ContractSupplement,at:string) {
  sup.status=s.mode==='demo'?'signed_demo':'signed';sup.effectiveAt=at;
  const old=new Map(s.stages.map(x=>[x.stageId,x]));
  s.stages=sup.terms.stages.map(plan=>old.get(plan.id)??{stageId:plan.id,status:'pending',attempts:[]});
}
function systemEvent(s:WorkflowState,action:string,at:string,note?:string) {
  s.revision+=1;s.events.push({id:`event-${s.orderId}-${s.revision}`,action,actorId:0,role:'platform',version:s.currentVersion,at,mode:s.mode,source:'provider',...(note?{note:note.slice(0,2000)}:{})});
}
/** Readable list of what a supplement changes. */
function describeChanges(base:ContractTerms,next:ContractTerms):string[] {
  const out:string[]=[],money=(n:number)=>`${(n/100).toFixed(2)}元`;
  if(base.totalCents!==next.totalCents)out.push(`合同总价：${money(base.totalCents)} → ${money(next.totalCents)}`);
  if(base.durationDays!==next.durationDays)out.push(`工期：${base.durationDays}天 → ${next.durationDays}天`);
  if(base.scope!==next.scope)out.push(`施工范围：${next.scope.slice(0,300)}`);
  if(base.area!==next.area||base.areaBasis!==next.areaBasis)out.push(`面积：${base.area}㎡（${base.areaBasis}）→ ${next.area}㎡（${next.areaBasis}）`);
  if(base.style!==next.style)out.push(`风格：${base.style} → ${next.style}`);
  if(base.location!==next.location)out.push(`施工地点：${next.location.slice(0,200)}`);
  if(JSON.stringify(base.stages)!==JSON.stringify(next.stages))out.push(`分期：${next.stages.map(s=>`${s.name} ${money(s.amountCents)}`).join('；')}`);
  if(JSON.stringify(base.attachments)!==JSON.stringify(next.attachments))out.push(`附件：${next.attachments.length} 项`);
  return out;
}
export function reduceWorkflow(state:WorkflowState,actor:WorkflowActor,cmd:WorkflowCommand,context:ReduceContext):WorkflowState {
  validateCommand(cmd);assertWorkflowParty(state,actor);
  if(state.legacyContract)return fail('历史合同只读保留，请通过正式补充协议办理变更','LEGACY_READ_ONLY',409);
  if(state.revision!==cmd.expectedRevision)return fail('版本已更新，请刷新后重试','STALE_REVISION',409);
  const role=workflowRole(actor), action=cmd.action,p=cmd.payload??{},at=context.at;
  if(!ROLE_ACTIONS[action].includes(role))return fail(action==='accept_stage'||action==='reject_stage'?'无权执行此操作，验收仅限业主本人':'无权执行此操作','FORBIDDEN',403);
  const mode=state.mode;
  if(mode==='real'&&DEMO_ONLY.includes(action))return fail('本合同为真实合同，不接受演示签署或模拟资金操作','MODE_MISMATCH',409);
  if(mode==='demo'&&REAL_ONLY.includes(action))return fail('本合同为演示合同，不接受真实签署或真实资金操作','MODE_MISMATCH',409);
  const s=structuredClone(state),v=s.versions.at(-1)!, t=v.terms;
  s.providerRequests??=[];s.supplements??=[];
  const requests=s.providerRequests,supplements=s.supplements;
  const requireSigned=()=>{if(!isSignedStatus(v.status))return fail(mode==='demo'?'请先完成三方演示签署':'请先完成三方签署','INVALID_STATE',409);};
  // Money and stages always follow the terms in force, which a signed supplement may have replaced.
  const eff=()=>effectiveTerms(s);
  const stage=()=>{const id=textValue(p.stageId,'阶段编号',true,100),plan=eff().stages.find(x=>x.id===id),progress=s.stages.find(x=>x.stageId===id);if(!plan||!progress)return fail('阶段不存在');return {plan,progress};};
  const findRequest=()=>{const id=textValue(p.requestId,'请求编号',true,120);return requests.find(r=>r.id===id);};
  const openRequestFor=(match:(r:ProviderRequest)=>boolean)=>requests.some(r=>isOpenRequest(r)&&match(r));
  const newRequest=(fields:Omit<ProviderRequest,'id'|'role'|'actorId'|'version'|'createdAt'|'updatedAt'>)=>{
    const request:ProviderRequest={id:`req-${s.orderId}-${s.revision+1}`,role,actorId:actor.uid,version:s.currentVersion,createdAt:at,updatedAt:at,...fields};
    requests.push(request);return request;
  };
  /** Accepted stages whose money is not yet covered by an open payout request: a refund may not take it. */
  const acceptedReserve=()=>{const covered=new Set(requests.filter(r=>r.kind==='release'&&isOpenRequest(r)).map(r=>r.stageId));
    return eff().stages.filter(plan=>!covered.has(plan.id)&&s.stages.some(x=>x.stageId===plan.id&&x.status==='accepted')).reduce((sum,plan)=>sum+plan.amountCents,0);};
  const findSupplement=()=>{const id=textValue(p.supplementId,'补充协议编号',true,120),sup=supplements.find(x=>x.id===id);if(!sup)return fail('补充协议不存在','NOT_FOUND',404);return sup;};
  /** What a signature goes on: the frozen contract version, or a frozen supplement. */
  const signTarget=()=>{
    if(p.supplementId===undefined) {
      if(!['frozen','partially_signed'].includes(v.status)||!v.termsHash)return fail('请签署当前冻结版本','INVALID_STATE',409);
      return {signatures:v.signatures,termsHash:v.termsHash,terms:t,contractId:v.contractId,number:v.number,sup:undefined as ContractSupplement|undefined};
    }
    const sup=findSupplement();
    if(!['frozen','partially_signed'].includes(sup.status)||!sup.termsHash)return fail('请先由双方确认并冻结补充协议，再签署','INVALID_STATE',409);
    return {signatures:sup.signatures,termsHash:sup.termsHash,terms:sup.terms,contractId:`${v.contractId}-s${sup.number}`,number:v.number,sup};
  };
  const completeSignature=(target:ReturnType<typeof signTarget>,signedMode:ContractMode)=>{
    if(target.sup){if(target.signatures.length===3)applySupplement(s,target.sup,at);else target.sup.status='partially_signed';}
    else v.status=v.signatures.length===3?(signedMode==='demo'?'signed_demo':'signed'):'partially_signed';
  };
  const requireCompanySigner=(terms:ContractTerms,signerName:string,supplement=false)=>{
    if(!context.profile)return fail('请先保存本公司的签约主体资料');
    if(signerName!==context.profile.authorizedSignerName)return fail('签署人须为企业资料中的授权人','FORBIDDEN',403);
    // A signed contract cannot be revised, so for a supplement the saved profile has to be put back in line with the signed party details.
    if(JSON.stringify(terms.company)!==JSON.stringify(context.profile.party))return fail(supplement?'公司签约资料与已签合同中的主体资料不一致，请把签约资料改回一致后再签署补充协议':'公司资料已变化，请修订合同后重新确认','INVALID_STATE',409);
  };
  /** Signing sessions opened for a version or supplement that no longer exists in that form are void. */
  const voidSignRequests=(match:(r:ProviderRequest)=>boolean,reason:string)=>{for(const r of requests)if(r.kind==='sign'&&isOpenRequest(r)&&match(r)){r.status='cancelled';r.failure=reason;r.updatedAt=at;}};
  const hasDispute=(id?:string)=>s.disputes.some(d=>d.status==='open'&&(!id||d.stageId===id));
  const amount=()=>positiveCents(p.amountCents);
  const addTransaction=(type:WorkflowTransaction['type'],amountCents:number,feeCents=0,stageId?:string,receipt?:PaymentReceipt)=>s.transactions.push({id:`tx-${s.orderId}-${s.revision+1}`,requestKey:cmd.requestKey,type,amountCents,feeCents,netCents:type==='release'?amountCents-feeCents:amountCents,stageId,at,mode,...(receipt?{receipt}:{})});
  /** A real money movement is recorded only against a succeeded provider receipt for exactly this amount, and a receipt is never reused. */
  const requireReceipt=(expected:number):PaymentReceipt=>{
    const r=context.payment;
    if(!r)return fail('尚未配置资金服务商或未取得服务商回执，不能记录真实资金变动','PROVIDER_NOT_CONFIGURED',503);
    if(r.status!=='succeeded')return fail(`服务商回执状态为${r.status==='pending'?'待确认':'未成功'}，不能记录入账或出款`,'RECEIPT_NOT_SUCCEEDED',409);
    if(r.amountCents!==expected)return fail('服务商回执金额与本次操作金额不一致','RECEIPT_AMOUNT_MISMATCH',409);
    if(s.transactions.some(x=>x.receipt&&x.receipt.provider===r.provider&&x.receipt.receiptId===r.receiptId))return fail('该服务商回执已使用过，不能重复入账','RECEIPT_REUSED',409);
    return r;
  };
  if(action==='revise'||action==='negotiate') {
    if(isSignedStatus(v.status))return fail('已签合同正文只读，变更须通过补充协议','SIGNED_READ_ONLY',409);
    if(s.versions.length>=100)return fail('版本数量已达上限，请归档后联系平台');
    let patch:Record<string,unknown>;
    if(action==='negotiate') {textValue(p.note,'议价说明');patch={totalCents:positiveCents(p.totalCents)};}
    else {if(!p.patch||typeof p.patch!=='object'||Array.isArray(p.patch))return fail('缺少条款变更');patch=p.patch as Record<string,unknown>;}
    const allowed=action==='negotiate'?['totalCents']:role==='homeowner'?['homeowner','location','area','areaBasis','style','attachments']:role==='company'?['company','scope','totalCents','durationDays','stages','attachments']:['platform','feeBps'];
    if(!Object.keys(patch).length||Object.keys(patch).some(k=>!allowed.includes(k)))return fail('无权修改其他当事人的资料或条款字段','FORBIDDEN',403);
    const next=structuredClone(t);
    for(const [key,value]of Object.entries(patch)) {
      if(['homeowner','company','platform'].includes(key))(next as any)[key]=validateParty(value);
      else if(key==='totalCents')next.totalCents=positiveCents(value);
      else if(key==='durationDays'){if(!Number.isSafeInteger(value)||Number(value)<1||Number(value)>3650)return fail('工期必须为1至3650天整数');next.durationDays=Number(value);}
      else if(key==='area'){if(typeof value!=='number'||!Number.isFinite(value)||value<=0||value>100000)return fail('面积须为有效正数');next.area=value;}
      else if(key==='feeBps'){if(!Number.isSafeInteger(value)||Number(value)<0||Number(value)>10000)return fail('费率应为0至10000个基点');next.feeBps=Number(value);}
      else if(key==='attachments')next.attachments=validateAttachments(value);
      else if(key!=='stages')(next as any)[key]=textValue(value,key,true,4000);
    }
    if(patch.totalCents!==undefined&&patch.stages===undefined)next.stages=allocateStages(t.stages,next.totalCents);
    next.stages=validateStages(patch.stages??next.stages,next.totalCents);
    v.status='superseded';const number=s.currentVersion+1;s.currentVersion=number;
    voidSignRequests(r=>r.supplementId===undefined,'合同已修订，本次签署请求作废，请对新版本重新签署');
    s.versions.push({number,contractId:v.contractId,terms:next,status:'awaiting_company',confirmations:{},signatures:[],createdAt:at});
    s.stages=next.stages.map(x=>({stageId:x.id,status:'pending',attempts:[]}));s.aiReview={status:'not_called',mode:'rules',summary:'版本已变化；规则草案，模型未调用'};
  } else if(action==='company_confirm') {
    if(v.status!=='awaiting_company')return fail('当前版本不处于待公司确认状态','INVALID_STATE',409);
    v.confirmations.company=at;v.status='awaiting_homeowner';
  } else if(action==='homeowner_accept') {
    if(v.status!=='awaiting_homeowner'||!v.confirmations.company)return fail('公司须先确认当前方案与报价','INVALID_STATE',409);
    v.confirmations.homeowner=at;v.status='ready_to_freeze';
  } else if(action==='freeze') {
    if(v.status!=='ready_to_freeze')return fail('须先完成公司与业主确认','INVALID_STATE',409);
    const report=validateContractTerms(t,mode);if(report.missing.length||report.errors.length)return fail(`合同存在缺项或校验错误：${[...report.missing,...report.errors].join('、')}`,'INCOMPLETE',409);
    if(!context.termsHash)return fail('缺少条款校验值');v.termsHash=context.termsHash;v.frozenAt=at;v.status='frozen';
  } else if(action==='sign_demo') {
    const target=signTarget();
    if(target.signatures.some(x=>x.role===role))return fail('本方已完成此版本演示确认','INVALID_STATE',409);
    const signerName=textValue(p.signerName,'签署人姓名',true,200);
    validateImageDataUrl(p.signatureDataUrl);
    if(!context.appliedSignatureDataUrl)return fail('缺少绑定本合同版本的签名应用图');
    const signatureDataUrl=validateImageDataUrl(context.appliedSignatureDataUrl);
    let sealDataUrl:string|undefined,assetVersion:string|undefined;
    if(role==='company') {
      if(p.authorizeSeal!==true)return fail('公司必须明确授权本次合同用章');
      if(!context.profile?.sealDataUrl)return fail('请先保存本公司的私有公章与授权资料');
      requireCompanySigner(target.terms,signerName,!!target.sup);
      if(!context.appliedSealDataUrl)return fail('缺少绑定本合同版本的公章应用图');
      sealDataUrl=validateImageDataUrl(context.appliedSealDataUrl);assetVersion=context.profile!.updatedAt;
    }
    target.signatures.push({role,actorId:actor.uid,at,mode:'demo',signerName,signatureDataUrl,termsHash:target.termsHash,
      ...(sealDataUrl?{sealDataUrl,assetVersion,sealHash:context.sealHash,sealBinding:{contractId:target.contractId,version:target.number,mode:'demo' as const}}:{}),signatureHash:context.signatureHash});
    completeSignature(target,'demo');
  } else if(action==='sign') {
    const target=signTarget();
    if(target.signatures.some(x=>x.role===role))return fail('本方已完成此版本签署，不能重复签署','INVALID_STATE',409);
    const signerName=textValue(p.signerName,'签署人姓名',true,200);
    if(role==='company')requireCompanySigner(target.terms,signerName,!!target.sup);
    const r=context.signing;
    if(r) {
      // A receipt the server already holds for this command (for example recorded from the provider's own records).
      const problem=signingReceiptProblem(r,role,signerName,target.termsHash);if(problem)return fail(problem.message,problem.code,409);
      if(allSignatures(s).some(x=>x.evidence&&x.evidence.provider===r.provider&&x.evidence.receiptId===r.receiptId))return fail('该签署回执已被使用','RECEIPT_REUSED',409);
      target.signatures.push({role,actorId:actor.uid,at,mode:'real',signerName,termsHash:target.termsHash,evidence:{...r}});
      completeSignature(target,'real');
    } else if(context.provider) {
      // Opens a signing session request; the signature is recorded only when the provider's receipt arrives.
      if(openRequestFor(x=>x.kind==='sign'&&x.role===role&&x.supplementId===target.sup?.id))return fail('本方已有进行中的签署请求，请先完成或撤回','REQUEST_IN_PROGRESS',409);
      newRequest({kind:'sign',status:'creating',provider:context.provider,signerName,termsHash:target.termsHash,...(target.sup?{supplementId:target.sup.id}:{})});
    } else return fail('尚未配置电子签署服务商或未取得签署回执，不能记录真实签署','PROVIDER_NOT_CONFIGURED',503);
  } else if(action==='submit_stage') {
    requireSigned();const {plan,progress}=stage();if(!['pending','rejected'].includes(progress.status))return fail('此阶段不接受重复提交','INVALID_STATE',409);
    const pendingChange=openSupplement(s);
    if(pendingChange&&JSON.stringify(pendingChange.terms.stages.find(x=>x.id===plan.id))!==JSON.stringify(plan))return fail('该阶段正在补充协议中变更，请先完成或撤回补充协议再提交','SUPPLEMENT_IN_PROGRESS',409);
    progress.attempts.push({submittedAt:at,evidence:validateAttachments(p.evidence,true),note:textValue(p.note,'施工说明',true,2000)});progress.status='submitted';
  } else if(action==='accept_stage'||action==='reject_stage') {
    requireSigned();const {progress}=stage();if(progress.status!=='submitted')return fail('仅可验收施工方已提交阶段','INVALID_STATE',409);
    const attempt=progress.attempts.at(-1)!;attempt.reviewAt=at;
    if(action==='reject_stage'){attempt.reason=textValue(p.reason,'驳回理由');attempt.review='rejected';progress.status='rejected';}
    else{attempt.review='accepted';progress.status='accepted';progress.acceptedAt=at;}
  } else if(action==='simulate_fund') {
    requireSigned();const value=amount(),totals=ledgerTotals(s);
    if(totals.fundedCents-totals.refundedCents+value>eff().totalCents)return fail('模拟入金不得超过合同总价');addTransaction('fund',value);
  } else if(action==='simulate_release') {
    requireSigned();const {plan,progress}=stage();if(progress.status!=='accepted')return fail('此阶段须由业主验收通过，或已结算','INVALID_STATE',409);
    if(hasDispute(plan.id))return fail('该阶段存在未解决争议，未结算金额已冻结','DISPUTE_FROZEN',409);
    const totals=ledgerTotals(s);if(totals.balanceCents<plan.amountCents)return fail('可结算资金余额不足','INSUFFICIENT_FUNDS',409);
    // Cumulative fee rounding keeps the final total exact regardless of stage settlement order.
    const fee=Math.round((totals.releasedCents+plan.amountCents)*eff().feeBps/10000)-totals.realizedFeeCents;
    addTransaction('release',plan.amountCents,fee,plan.id);progress.status='settled';progress.settledAt=at;
  } else if(action==='simulate_refund') {
    requireSigned();textValue(p.reason,'退款理由');if(hasDispute())return fail('存在未解决争议，禁止单方退款','DISPUTE_FROZEN',409);
    const value=amount(),balance=ledgerTotals(s).balanceCents;
    if(value>balance)return fail('退款超出未结算资金余额；已结算款须另行返还','INSUFFICIENT_FUNDS',409);
    if(value>Math.max(0,balance-acceptedReserve()))return fail('须保留已验收但未结算阶段的资金，不允许单方退款取走','ACCEPTED_FUNDS_RESERVED',409);
    addTransaction('refund',value);s.transactions.at(-1)!.reason=textValue(p.reason,'退款理由');
  } else if(action==='fund') {
    requireSigned();const value=amount(),totals=ledgerTotals(s);
    // Payments already asked for count too, so two open checkouts cannot together exceed the contract total.
    const asked=requests.filter(r=>r.kind==='fund'&&isOpenRequest(r)).reduce((sum,r)=>sum+(r.amountCents??0),0);
    if(totals.fundedCents-totals.refundedCents+asked+value>eff().totalCents)return fail('入金不得超过合同总价');
    if(context.payment)addTransaction('fund',value,0,undefined,requireReceipt(value));
    else if(context.provider)newRequest({kind:'fund',status:'creating',provider:context.provider,amountCents:value});
    else requireReceipt(value);
  } else if(action==='release') {
    requireSigned();const {plan,progress}=stage();if(progress.status!=='accepted')return fail('此阶段须由业主验收通过，或已结算','INVALID_STATE',409);
    if(hasDispute(plan.id))return fail('该阶段存在未解决争议，未结算金额已冻结','DISPUTE_FROZEN',409);
    if(openRequestFor(r=>r.kind==='release'&&r.stageId===plan.id))return fail('该阶段已有进行中的拨付请求','REQUEST_IN_PROGRESS',409);
    const totals=ledgerTotals(s);if(totals.availableCents<plan.amountCents)return fail('可结算资金余额不足','INSUFFICIENT_FUNDS',409);
    if(context.payment) {
      const receipt=requireReceipt(plan.amountCents);
      const fee=Math.round((totals.releasedCents+plan.amountCents)*eff().feeBps/10000)-totals.realizedFeeCents;
      addTransaction('release',plan.amountCents,fee,plan.id,receipt);progress.status='settled';progress.settledAt=at;
    } else if(context.provider)newRequest({kind:'release',status:'awaiting_review',stageId:plan.id,amountCents:plan.amountCents});
    else requireReceipt(plan.amountCents);
  } else if(action==='refund') {
    requireSigned();const reason=textValue(p.reason,'退款理由');if(hasDispute())return fail('存在未解决争议，禁止单方退款','DISPUTE_FROZEN',409);
    const value=amount(),available=ledgerTotals(s).availableCents;
    if(value>available)return fail('退款超出未结算资金余额；已结算款须另行返还','INSUFFICIENT_FUNDS',409);
    if(value>Math.max(0,available-acceptedReserve()))return fail('须保留已验收但未结算阶段的资金，不允许单方退款取走','ACCEPTED_FUNDS_RESERVED',409);
    if(context.payment){addTransaction('refund',value,0,undefined,requireReceipt(value));s.transactions.at(-1)!.reason=reason;}
    else if(context.provider)newRequest({kind:'refund',status:'awaiting_review',amountCents:value,reason});
    else requireReceipt(value);
  } else if(action==='open_dispute') {
    requireSigned();const {plan}=stage();if(hasDispute(plan.id))return fail('该阶段已有未解决争议','INVALID_STATE',409);
    const disputeId=`dispute-${s.orderId}-${s.revision+1}`;
    s.disputes.push({id:disputeId,stageId:plan.id,reason:textValue(p.reason,'争议说明'),evidence:validateAttachments(p.evidence??[]),status:'open',createdAt:at});
    // Money not yet handed to a provider is withdrawn. Money already with the provider may have left: it is put on hold and only the provider's answer closes it.
    for(const r of requests) {
      if(!isOpenRequest(r)||!(r.kind==='refund'||(r.kind==='release'&&r.stageId===plan.id)))continue;
      if(r.status==='awaiting_review'){r.status='cancelled';r.failure=r.kind==='refund'?'存在未解决争议，待复核的退款请求已撤回':'本阶段已提出争议，待复核的拨付请求已撤回';}
      else r.hold={disputeId,at};
      r.updatedAt=at;
    }
  } else if(action==='resolve_dispute') {
    requireSigned();const d=s.disputes.find(x=>x.id===p.disputeId);if(!d||d.status!=='open')return fail('未找到待处理争议','INVALID_STATE',409);
    const independentParty=textValue(p.independentParty,'独立处理方'),basis=textValue(p.basis,'处理依据'),outcome=textValue(p.outcome,'处理记录');
    const disposition=p.disposition??'continue';if(disposition!=='continue'&&disposition!=='cancel_stage')return fail('争议处理方式无效');
    if(disposition==='cancel_stage') {
      if(openRequestFor(r=>r.kind==='release'&&r.stageId===d.stageId))return fail('该阶段有在途出款，须等资金服务商确认结果后再处理','PAYOUT_IN_FLIGHT',409);
      const progress=s.stages.find(x=>x.stageId===d.stageId);
      if(!progress||progress.status==='cancelled'||progress.status==='settled'||s.transactions.some(x=>x.type==='release'&&x.stageId===d.stageId))return fail('已结算或已取消阶段不能再次取消；已付资金须另行返还','INVALID_STATE',409);
      progress.status='cancelled';progress.cancelledAt=at;progress.cancellationDisputeId=d.id;
    }
    d.resolution={independentParty,basis,outcome,disposition,at};d.status='resolved';
    for(const r of requests)if(r.hold?.disputeId===d.id){delete r.hold;r.updatedAt=at;}
  } else if(action==='ai_review') {
    if(!context.aiReview)return fail('规则草案，模型未调用；模型复核入口尚未配置','MODEL_NOT_CONFIGURED',409);s.aiReview=context.aiReview;
  } else if(action==='review_payout') {
    const r=findRequest();if(!r||r.status!=='awaiting_review')return fail('未找到待复核的出款请求','INVALID_STATE',409);
    const decision=p.decision;if(decision!=='approve'&&decision!=='reject')return fail('复核结论无效');
    const note=textValue(p.note,'复核意见',true,1000);
    if(decision==='reject'){r.status='rejected';r.review={decision:'rejected',note,actorId:actor.uid,at};}
    else {
      if(!context.provider)return fail('尚未配置资金服务商，不能执行出款','PROVIDER_NOT_CONFIGURED',503);
      // Conditions are checked again: things may have changed since the party asked.
      if(r.kind==='release') {
        const progress=s.stages.find(x=>x.stageId===r.stageId);
        if(progress?.status!=='accepted')return fail('该阶段已不处于验收通过待结算状态','INVALID_STATE',409);
        if(hasDispute(r.stageId))return fail('该阶段存在未解决争议，未结算金额已冻结','DISPUTE_FROZEN',409);
      } else if(hasDispute())return fail('存在未解决争议，禁止单方退款','DISPUTE_FROZEN',409);
      const totals=ledgerTotals(s),others=totals.availableCents+(r.amountCents??0);
      if(others<(r.amountCents??0))return fail('可用余额不足','INSUFFICIENT_FUNDS',409);
      if(r.kind==='refund'&&(r.amountCents??0)>Math.max(0,others-acceptedReserve()))return fail('须保留已验收但未结算阶段的资金，不允许单方退款取走','ACCEPTED_FUNDS_RESERVED',409);
      if(r.kind==='release') {
        // The fee is fixed now, because the provider has to split the payout between the contractor and the platform.
        // It is cumulative over everything paid out or on its way out, so the total stays exact whatever order the payouts settle in.
        const onTheWay=requests.filter(x=>x.kind==='release'&&x.id!==r.id&&(x.status==='creating'||x.status==='pending'));
        const paidOut=totals.releasedCents+onTheWay.reduce((sum,x)=>sum+(x.amountCents??0),0),feesSoFar=totals.realizedFeeCents+onTheWay.reduce((sum,x)=>sum+(x.feeCents??0),0);
        r.feeCents=Math.max(0,Math.round((paidOut+(r.amountCents??0))*eff().feeBps/10000)-feesSoFar);
      }
      r.status='creating';r.provider=context.provider;r.review={decision:'approved',note,actorId:actor.uid,at};
    }
    r.updatedAt=at;
  } else if(action==='cancel_request') {
    const r=findRequest();if(!r)return fail('请求不存在','NOT_FOUND',404);
    if(r.actorId!==actor.uid||r.role!==role)return fail('只能撤回本人发起的请求','FORBIDDEN',403);
    const cancellable=r.kind==='sign'?['creating','pending'].includes(r.status):r.status==='awaiting_review';
    if(!cancellable)return fail(r.kind==='sign'?'该签署请求已结束':'该请求已交给资金服务商，须以服务商结果为准，不能在本地撤回','INVALID_STATE',409);
    r.status='cancelled';r.failure='发起方已撤回';r.updatedAt=at;
  } else if(action==='propose_supplement') {
    requireSigned();
    if(openSupplement(s))return fail('已有进行中的补充协议，请先完成或撤回','SUPPLEMENT_IN_PROGRESS',409);
    const reason=textValue(p.reason,'变更原因',true,2000);
    if(!p.patch||typeof p.patch!=='object'||Array.isArray(p.patch)||!Object.keys(p.patch).length)return fail('补充协议须包含至少一项变更');
    const patch=p.patch as Record<string,unknown>;
    // Parties, the platform fee and the frozen upstream snapshot are not changed by a supplement.
    const allowed=['scope','totalCents','durationDays','stages','attachments','area','areaBasis','style','location'];
    if(Object.keys(patch).some(k=>!allowed.includes(k)))return fail('补充协议不能变更当事人资料、平台费率或上游快照','FORBIDDEN',403);
    if(patch.totalCents!==undefined&&patch.stages===undefined)return fail('变更合同总价时须同时给出新的分期安排');
    const base=eff(),next=structuredClone(base);
    for(const [key,value]of Object.entries(patch)) {
      if(key==='totalCents')next.totalCents=positiveCents(value);
      else if(key==='durationDays'){if(!Number.isSafeInteger(value)||Number(value)<1||Number(value)>3650)return fail('工期必须为1至3650天整数');next.durationDays=Number(value);}
      else if(key==='area'){if(typeof value!=='number'||!Number.isFinite(value)||value<=0||value>100000)return fail('面积须为有效正数');next.area=value;}
      else if(key==='attachments')next.attachments=validateAttachments(value);
      else if(key!=='stages')(next as any)[key]=textValue(value,key,true,4000);
    }
    next.stages=validateStages(patch.stages??next.stages,next.totalCents);
    for(const progress of s.stages) {
      if(progress.status==='pending')continue;
      const before=base.stages.find(x=>x.id===progress.stageId),after=next.stages.find(x=>x.id===progress.stageId);
      if(before&&(!after||after.name!==before.name||after.amountCents!==before.amountCents||after.acceptanceCriteria!==before.acceptanceCriteria))
        return fail(`阶段「${before.name}」已提交、验收或结算，补充协议不能变更或删除该阶段`,'STAGE_LOCKED',409);
    }
    const changes=describeChanges(base,next);if(!changes.length)return fail('补充协议内容与现行条款相同，没有变更');
    const number=supplements.length+1;
    supplements.push({id:`supplement-${s.orderId}-${number}`,number,status:'proposed',reason,proposedBy:role,proposedAt:at,baseVersion:s.currentVersion,
      terms:next,changes,confirmations:{[role]:at},signatures:[]});
  } else if(action==='confirm_supplement') {
    const sup=findSupplement();if(sup.status!=='proposed')return fail('没有待确认的补充协议','INVALID_STATE',409);
    if(sup.confirmations[role as 'homeowner'|'company'])return fail('本方已确认该补充协议，请等待对方确认','INVALID_STATE',409);
    sup.confirmations[role as 'homeowner'|'company']=at;
    if(sup.confirmations.homeowner&&sup.confirmations.company) {
      if(!context.supplementTermsHash)return fail('缺少补充协议校验值');
      sup.termsHash=context.supplementTermsHash;sup.frozenAt=at;sup.status='frozen';
    }
  } else if(action==='withdraw_supplement') {
    const sup=findSupplement();if(!OPEN_SUPPLEMENT.includes(sup.status))return fail('该补充协议已签署或已撤回，不能再撤回','INVALID_STATE',409);
    sup.status='withdrawn';sup.withdrawnAt=at;sup.withdrawnBy=role;
    voidSignRequests(r=>r.supplementId===sup.id,'补充协议已撤回，本次签署请求作废');
  }
  s.revision+=1;s.events.push({id:`event-${s.orderId}-${s.revision}`,action,actorId:actor.uid,role,version:s.currentVersion,at,mode,...(typeof p.note==='string'?{note:p.note.slice(0,2000)}:{})});
  return s;
}
/** Human-readable excerpts from frozen upstream data. They are plain text and never interpreted as HTML or instructions. */
function upstreamSnapshotText(t:ContractTerms):string {
  const short=(value:unknown,max=300)=>typeof value==='string'?value.slice(0,max):typeof value==='number'&&Number.isFinite(value)?String(value):'待确认';
  const q=t.source.quote&&typeof t.source.quote==='object'&&!Array.isArray(t.source.quote)?t.source.quote as Record<string,unknown>:{};
  const quoteLines=['上游报价明细快照（人民币元；上游参考报价与签约总价不同时，以经确认的合同总价及范围为准，不重复计价）'];
  if(q.total!==undefined)quoteLines.push(`上游参考总计：${short(q.total)}元。`);
  if(Array.isArray(q.items)) {
    for(const [i,raw]of q.items.slice(0,100).entries()) {
      if(!raw||typeof raw!=='object')continue;const item=raw as Record<string,unknown>;
      quoteLines.push(`${i+1}. ${short(item.item??item.name)}：数量 ${short(item.qty)} ${short(item.unit,40)}；单价 ${short(item.price)} 元；小计 ${short(item.total)} 元${item.source?`；依据 ${short(item.source)}`:''}。`);
    }
    if(q.items.length>100)quoteLines.push('其余报价项目超出摘要上限，请另行核对完整冻结报价数据。');
  } else quoteLines.push('未提供可读取的分项明细，请签署前人工核对。');
  const offer=q.selectedOffer&&typeof q.selectedOffer==='object'?q.selectedOffer as Record<string,unknown>:null;
  if(offer)quoteLines.push(`中选报价：${short(offer.amountWan)}万元；工期 ${short(offer.weeks)}周；施工方说明：${short(offer.note,800)}。`);
  const designLines:string[]=[],labels:Record<string,string>={note:'说明',summary:'摘要',description:'设计说明',rooms:'空间',name:'名称',style:'风格',palette:'配色',materials:'材料',furniture:'家具',lighting:'照明',suggestions:'建议'};
  let remaining=9000,omitted=false;
  const append=(line:string)=>{if(remaining<=0){omitted=true;return;}const clipped=line.slice(0,Math.min(1200,remaining));designLines.push(clipped);remaining-=clipped.length+1;if(clipped.length<line.length)omitted=true;};
  const walk=(value:unknown,label:string,depth:number)=>{
    if(depth>5||remaining<=0){omitted=true;return;}
    if(typeof value==='string'){if(!/^data:|^https?:\/\//i.test(value))append(`${label}：${value.slice(0,1200)}`);if(value.length>1200)omitted=true;}
    else if(typeof value==='number'||typeof value==='boolean')append(`${label}：${String(value)}`);
    else if(Array.isArray(value)){value.slice(0,24).forEach((x,i)=>walk(x,`${label}${i+1}`,depth+1));if(value.length>24)omitted=true;}
    else if(value&&typeof value==='object') {
      const entries=Object.entries(value);for(const [key,child]of entries.slice(0,30)) {
        if(/image|base64|svg|url|geometry|walls|openings|floorplan|^plan$/i.test(key))continue;
        walk(child,label?`${label}·${labels[key]??key.slice(0,60)}`:labels[key]??key.slice(0,60),depth+1);
      }if(entries.length>30)omitted=true;
    }
  };walk(t.source.design,'',0);
  return `${quoteLines.join('\n').slice(0,6000)}\n上游设计说明快照：\n${designLines.join('\n')||'未提供可读取的设计正文，请人工核对方案附件。'}${omitted?'\n设计内容超出摘要上限，已截取；完整冻结数据另存本合同版本。':''}`;
}
export function generateContractDraft(v:ContractVersion,mode:ContractMode='demo'):string {
  const t=v.terms,money=(n:number)=>(n/100).toFixed(2);
  return [mode==='real'?'予舍三方装修合同 · 规则草案（需人工复核）':'予舍三方装修合同 · 演示规则草案（需人工复核）',`合同编号：${v.contractId}　版本：${v.number}`,
    `甲方（业主）：${t.homeowner.legalName||'待补充'}；乙方（施工企业）：${t.company.legalName||'待补充'}；丙方（平台）：${t.platform.legalName||'待补充'}`,
    `项目：${t.projectName}；施工地点：${t.location||'待补充'}`,
    `面积：${t.area}㎡（${t.areaBasis||'计量口径待确认'}）；风格：${t.style}；范围：${t.scope||'待补充'}`,
    `合同总价：${money(t.totalCents)}元；参考均价：${t.area>0?money(Math.round(t.totalCents/t.area)):'待确认'}元/㎡（仅为总价除以面积的参考，不重复计价）。`,
    `工期：${t.durationDays}天。具体开竣工日期、材料品牌规格、排除项、变更、保修和违约条款须由各方另行复核确认。`,
    `平台履约服务费由乙方承担，按每次成功${mode==='real'?'':'模拟'}阶段结算金额的${t.feeBps/100}%计收；累计费用分位舍入，签署、入金和验收不计收入。`,
    ...t.stages.map((s,i)=>`第${i+1}期：${s.name}，${money(s.amountCents)}元；验收标准：${s.acceptanceCriteria}；计划日期：${s.plannedDate||'待约定'}。`),
    '施工方提交证据，业主明确验收通过后，仍须检查资金余额和争议状态。平台不代替业主验收，不作为独立仲裁机构。',
    ...(mode==='real'?['每笔阶段拨付和退款先由平台复核，再交资金服务商执行，以服务商的成功回执记账；已交给服务商的出款在争议期间只能由服务商确认是否撤回。']:[]),
    '争议按双方约定提交独立处理方，保留证据和处理依据。已结算交易不得抹除，退款另记交易。',
    '附件清单：',...t.attachments.map(a=>`${a.name}（${a.dataUrl?'版本内图片快照':'外部参考链接，未冻结远程内容'}）${a.note||''}`),
    upstreamSnapshotText(t),
    mode==='real'
      ? '本合同由各方通过电子签署服务商完成签署，签署回执、证据摘要与条款校验值记录在合同履约记录中；资金入账、拨付与退款均以资金服务商的成功回执为准。条款内容、条款效力及适用法律须由各方自行复核，必要时咨询律师。'
      : '本文件为产品演示，签名、公章图片仅记录本方演示确认，不承诺正式法律效力；模拟余额不代表第三方真实托管或真实到账。'].join('\n');
}
// ---------------------------------------------------------------------------------------------------------------
// Provider events. These are not party actions: the server calls them with what the provider itself returned.
// A receipt is never taken from a browser. Each function returns the same object when nothing changes.
// ---------------------------------------------------------------------------------------------------------------
const REQUEST_WORD:Record<ProviderRequestKind,string>={sign:'签署',fund:'入金',release:'阶段拨付',refund:'退款'};
const ROLE_WORD:Record<WorkflowRole,string>={homeowner:'业主',company:'施工企业',platform:'平台'};
function requestIndex(state:WorkflowState,requestId:string):number {
  const index=(state.providerRequests??[]).findIndex(r=>r.id===requestId);
  if(index<0)return fail('服务商请求不存在','NOT_FOUND',404);
  return index;
}
const safeHttps=(value:unknown):string|undefined=>{
  if(typeof value!=='string'||value.length>2000)return undefined;
  try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:undefined;}catch{return undefined;}
};
/** The provider accepted the request: from now on only its receipt can close it. */
export function providerRequestSent(state:WorkflowState,requestId:string,result:{provider:string;externalId:string;actionUrl?:string;expiresAt?:string},at:string):WorkflowState {
  const index=requestIndex(state,requestId);
  if(state.providerRequests![index].status!=='creating')return state;
  if(typeof result.externalId!=='string'||!result.externalId.trim()||typeof result.provider!=='string'||!result.provider.trim())return fail('服务商没有返回外部单号','INVALID_RECEIPT',502);
  const s=structuredClone(state),r=s.providerRequests![index];
  r.status='pending';r.provider=result.provider;r.externalId=result.externalId;r.updatedAt=at;delete r.failure;
  const actionUrl=safeHttps(result.actionUrl);if(actionUrl)r.actionUrl=actionUrl;
  if(typeof result.expiresAt==='string')r.expiresAt=result.expiresAt.slice(0,40);
  systemEvent(s,'provider_sent',at,`${ROLE_WORD[r.role]}的${REQUEST_WORD[r.kind]}请求已由${r.provider}受理（${r.externalId}）`);
  return s;
}
/**
 * The server could not get the provider to accept the request. Nothing happened for a signature or an incoming payment, so the request fails.
 * Money going out stays open: the provider may have created it before the error, so the platform re-sends it with the same idempotency key.
 */
export function providerRequestFailed(state:WorkflowState,requestId:string,reason:string,at:string):WorkflowState {
  const index=requestIndex(state,requestId);
  if(state.providerRequests![index].status!=='creating')return state;
  const s=structuredClone(state),r=s.providerRequests![index];
  r.failure=reason.slice(0,500);r.updatedAt=at;
  if(r.kind==='sign'||r.kind==='fund')r.status='failed';
  systemEvent(s,'provider_failed',at,`${REQUEST_WORD[r.kind]}请求未被服务商受理：${r.failure}`);
  return s;
}
/** The provider confirmed the session or payment was stopped and nothing was signed or moved. */
export function providerRequestCancelled(state:WorkflowState,requestId:string,reason:string,at:string):WorkflowState {
  const index=requestIndex(state,requestId);
  if(!['creating','pending'].includes(state.providerRequests![index].status))return state;
  const s=structuredClone(state),r=s.providerRequests![index];
  r.status='cancelled';r.failure=reason.slice(0,500);r.updatedAt=at;
  systemEvent(s,'provider_cancelled',at,`服务商确认${REQUEST_WORD[r.kind]}未执行：${r.failure}`);
  return s;
}
/** Records what the provider says happened. Signatures and transactions are written only here (or with a server-held receipt in reduceWorkflow). */
export function settleProviderRequest(state:WorkflowState,requestId:string,outcome:{signing?:SigningReceipt|null;payment?:PaymentReceipt|null},at:string):WorkflowState {
  const index=requestIndex(state,requestId);
  if(state.providerRequests![index].status!=='pending')return state;
  const s=structuredClone(state),r=s.providerRequests![index];
  const close=(status:ProviderRequestStatus,failure?:string)=>{r.status=status;r.updatedAt=at;if(failure)r.failure=failure;else delete r.failure;if(status==='succeeded')r.settledAt=at;};
  const note=(failure:string)=>{r.failure=failure;r.updatedAt=at;systemEvent(s,'provider_receipt_held',at,failure);return s;};
  if(r.kind==='sign') {
    const receipt=outcome.signing;if(!receipt)return state;
    if(receipt.provider!==r.provider||receipt.externalId!==r.externalId)return note('收到的签署回执不属于本次签署会话，未记录');
    if(receipt.outcome&&receipt.outcome!=='signed'){close('failed',receipt.outcome==='declined'?'签署人在服务商页面拒绝签署，未记录签署':'签署会话已过期，未记录签署');systemEvent(s,'provider_failed',at,r.failure);return s;}
    const v=s.versions.at(-1)!,sup=r.supplementId?(s.supplements??[]).find(x=>x.id===r.supplementId):undefined;
    const target=r.supplementId
      ?sup&&['frozen','partially_signed'].includes(sup.status)&&sup.termsHash===r.termsHash?{signatures:sup.signatures,sup}:null
      :['frozen','partially_signed'].includes(v.status)&&v.termsHash===r.termsHash&&r.version===s.currentVersion?{signatures:v.signatures,sup:undefined}:null;
    if(!target){close('cancelled','合同或补充协议已变更，本次签署未记录');systemEvent(s,'provider_failed',at,r.failure);return s;}
    if(target.signatures.some(x=>x.role===r.role)){close('failed','本方已签署该版本，本次回执未重复记录');systemEvent(s,'provider_failed',at,r.failure);return s;}
    const problem=signingReceiptProblem(receipt,r.role,r.signerName??'',r.termsHash??'');
    if(problem){close('failed',problem.message);systemEvent(s,'provider_failed',at,problem.message);return s;}
    if(allSignatures(s).some(x=>x.evidence&&x.evidence.provider===receipt.provider&&x.evidence.receiptId===receipt.receiptId)){close('failed','该签署回执已被使用');systemEvent(s,'provider_failed',at,r.failure);return s;}
    target.signatures.push({role:r.role,actorId:r.actorId,at,mode:'real',signerName:r.signerName??'',termsHash:r.termsHash??'',evidence:{...receipt}});
    if(target.sup){if(target.signatures.length===3)applySupplement(s,target.sup,at);else target.sup.status='partially_signed';}
    else v.status=v.signatures.length===3?'signed':'partially_signed';
    close('succeeded');
    systemEvent(s,'provider_signed',at,`${ROLE_WORD[r.role]}${target.sup?`补充协议${target.sup.number}`:''}签署回执已记录（${receipt.provider} ${receipt.receiptId}）`);
    return s;
  }
  const receipt=outcome.payment;if(!receipt)return state;
  if(receipt.provider!==r.provider||receipt.externalId!==r.externalId)return note('收到的资金回执不属于本次请求，未记录');
  if(receipt.status==='pending')return state;
  if(receipt.status==='failed'){close('failed','资金服务商返回失败，没有发生资金变动');systemEvent(s,'provider_failed',at,`${REQUEST_WORD[r.kind]}失败：${r.failure}`);return s;}
  const amountCents=r.amountCents??0;
  if(receipt.status!=='succeeded')return note('资金回执状态无法识别，未记录');
  if(receipt.amountCents!==amountCents)return note(`服务商回执金额 ${receipt.amountCents} 分与请求金额 ${amountCents} 分不一致，未入账，请平台与服务商核对`);
  if(s.transactions.some(x=>x.receipt&&x.receipt.provider===receipt.provider&&x.receipt.receiptId===receipt.receiptId))return note('该资金回执已入账过，未重复记录，请平台核对');
  const totals=ledgerTotals(s),id=`tx-${s.orderId}-${s.revision+1}`,base={id,requestKey:r.id,amountCents,at,mode:s.mode,receipt:{...receipt}};
  if(r.kind==='fund')s.transactions.push({...base,type:'fund',feeCents:0,netCents:amountCents});
  else if(r.kind==='refund')s.transactions.push({...base,type:'refund',feeCents:0,netCents:amountCents,...(r.reason?{reason:r.reason}:{})});
  else {
    // The fee is the one fixed at the platform's review and sent to the provider with the payout. (Requests stored before that existed fall back to the cumulative formula.)
    const fee=r.feeCents??Math.max(0,Math.round((totals.releasedCents+amountCents)*effectiveTerms(s).feeBps/10000)-totals.realizedFeeCents);
    if(receipt.feeCents!==undefined&&receipt.feeCents!==fee)return note(`服务商回执中的平台服务费 ${receipt.feeCents} 分与复核时确定的 ${fee} 分不一致，未入账，请平台与服务商核对`);
    s.transactions.push({...base,type:'release',feeCents:fee,netCents:amountCents-fee,stageId:r.stageId});
    const progress=s.stages.find(x=>x.stageId===r.stageId);if(progress){progress.status='settled';progress.settledAt=at;}
  }
  close('succeeded');
  systemEvent(s,'provider_settled',at,`${REQUEST_WORD[r.kind]} ${(amountCents/100).toFixed(2)} 元已按服务商回执记账（${receipt.provider} ${receipt.receiptId}）${r.hold?'；出款时本阶段存在未解决争议，争议继续处理':''}`);
  return s;
}
/** Compares every movement recorded from a provider receipt with what the provider reports now. Pure: the caller fetches the provider records. */
export function reconcileWorkflow(state:WorkflowState,lookup:Record<string,PaymentReceipt|null|undefined>):ReconciliationReport {
  const real=state.transactions.filter(x=>x.receipt),mismatches:ReconciliationMismatch[]=[];
  for(const tx of real) {
    const mine=tx.receipt!,theirs=lookup[mine.externalId],add=(reason:string)=>mismatches.push({transactionId:tx.id,externalId:mine.externalId,reason});
    if(!theirs)add('服务商查不到这笔记录');
    else if(theirs.status!=='succeeded')add(`服务商状态为${theirs.status}，与已记账的成功记录不符`);
    else if(theirs.amountCents!==tx.amountCents)add(`金额不一致：本地 ${tx.amountCents} 分，服务商 ${theirs.amountCents} 分`);
    else if(theirs.provider!==mine.provider||theirs.receiptId!==mine.receiptId)add('服务商或回执号与本地记录不一致');
  }
  return {ok:mismatches.length===0,checked:real.length,matched:real.length-mismatches.length,mismatches};
}
/** Stores a reconciliation result. Only the platform does this, and it never changes an amount. */
export function recordReconciliation(state:WorkflowState,actor:WorkflowActor,report:ReconciliationReport,at:string):WorkflowState {
  assertWorkflowParty(state,actor);
  if(workflowRole(actor)!=='platform')return fail('仅平台可以记录对账结果','FORBIDDEN',403);
  const s=structuredClone(state);
  s.reconciliation={ok:report.ok,checked:report.checked,matched:report.matched,mismatches:report.mismatches.slice(0,200),at,actorId:actor.uid};
  s.revision+=1;s.events.push({id:`event-${s.orderId}-${s.revision}`,action:'reconcile',actorId:actor.uid,role:'platform',version:s.currentVersion,at,mode:s.mode,
    note:report.ok?`对账一致：核对 ${report.checked} 笔`:`对账发现 ${report.mismatches.length} 笔不一致，共核对 ${report.checked} 笔`});
  return s;
}
/** What on this contract is waiting for the platform. The platform console lists these so a payout request or a dispute is not left unseen. */
export interface PlatformAttention { orderId:number; kind:'payout_review'|'platform_signature'|'dispute'|'reconciliation'|'provider_check'; level:'高'|'中'; detail:string }
export function platformAttention(state:WorkflowState):PlatformAttention[] {
  if(state.legacyContract)return [];
  const out:PlatformAttention[]=[],requests=state.providerRequests??[],current=state.versions.at(-1)!,money=(n:number)=>`${(n/100).toFixed(2)} 元`;
  const add=(kind:PlatformAttention['kind'],level:PlatformAttention['level'],detail:string)=>out.push({orderId:state.orderId,kind,level,detail});
  const review=requests.filter(r=>r.status==='awaiting_review');
  if(review.length)add('payout_review','高',`${review.length} 笔出款待平台复核，合计 ${money(review.reduce((sum,r)=>sum+(r.amountCents??0),0))}`);
  const platformSignPending=(signatures:WorkflowSignature[],supplementId?:string)=>!signatures.some(x=>x.role==='platform')
    &&!requests.some(r=>r.kind==='sign'&&r.role==='platform'&&r.supplementId===supplementId&&isOpenRequest(r));
  if(['frozen','partially_signed'].includes(current.status)&&platformSignPending(current.signatures))add('platform_signature','中','合同已冻结，待平台签署');
  const sup=openSupplement(state);
  if(sup&&['frozen','partially_signed'].includes(sup.status)&&platformSignPending(sup.signatures,sup.id))add('platform_signature','中',`补充协议 ${sup.number} 已冻结，待平台签署`);
  const disputes=state.disputes.filter(d=>d.status==='open').length;
  if(disputes)add('dispute','高',`${disputes} 项阶段争议待记录独立处理结果`);
  if(state.reconciliation&&!state.reconciliation.ok)add('reconciliation','高',`上次对账有 ${state.reconciliation.mismatches.length} 笔与资金服务商记录不一致`);
  const stuck=requests.filter(r=>isOpenRequest(r)&&r.status!=='awaiting_review'&&r.failure).length;
  if(stuck)add('provider_check','高',`${stuck} 笔服务商请求需要核对（服务商未受理或回执不一致）`);
  return out;
}
export function workflowView(state:WorkflowState,actor:WorkflowActor):WorkflowView {
  assertWorkflowParty(state,actor);const current=state.versions.at(-1)!,status=current.status,role=workflowRole(actor);
  const requests=state.providerRequests??[],openSup=openSupplement(state);
  const own=(r:ProviderRequest)=>r.actorId===actor.uid&&r.role===role;
  const signable=(signatures:WorkflowSignature[],supplementId?:string)=>!signatures.some(x=>x.role===role)
    &&!(state.mode==='real'&&requests.some(r=>r.kind==='sign'&&isOpenRequest(r)&&r.role===role&&r.supplementId===supplementId));
  const contractSignable=['frozen','partially_signed'].includes(status)&&signable(current.signatures);
  const supplementSignable=!!openSup&&['frozen','partially_signed'].includes(openSup.status)&&signable(openSup.signatures,openSup.id);
  let allowedActions=(Object.keys(ROLE_ACTIONS)as WorkflowAction[]).filter(a=>ROLE_ACTIONS[a].includes(role));
  allowedActions=allowedActions.filter(a=>{
    if(state.legacyContract)return false;
    if(DEMO_ONLY.includes(a)&&state.mode!=='demo')return false;
    if(REAL_ONLY.includes(a)&&state.mode!=='real')return false;
    if(a==='revise'||a==='negotiate')return !isSignedStatus(status);
    if(a==='company_confirm')return status==='awaiting_company';if(a==='homeowner_accept')return status==='awaiting_homeowner';
    if(a==='freeze')return status==='ready_to_freeze';if(a==='sign_demo'||a==='sign')return contractSignable||supplementSignable;
    if(a==='review_payout')return requests.some(r=>r.status==='awaiting_review');
    if(a==='cancel_request')return requests.some(r=>own(r)&&(r.kind==='sign'?['creating','pending'].includes(r.status):r.status==='awaiting_review'));
    if(a==='propose_supplement')return isSignedStatus(status)&&!openSup;
    if(a==='confirm_supplement')return openSup?.status==='proposed'&&!openSup.confirmations[role as 'homeowner'|'company'];
    if(a==='withdraw_supplement')return !!openSup;
    if(['generate_draft','ai_review'].includes(a))return true;return isSignedStatus(status);
  });
  const validation=validateContractTerms(current.terms,state.mode);
  const signWord=state.mode==='demo'?'演示签署':'电子签署',settleWord=state.mode==='demo'?'申请模拟结算':'申请结算';
  const todos=state.legacyContract?['历史合同只读保留']:status==='awaiting_company'?['施工企业确认当前报价、范围与工期']:status==='awaiting_homeowner'?['业主接受当前版本或提出议价']:status==='ready_to_freeze'?['补齐资料并冻结签署版本']:['frozen','partially_signed'].includes(status)?['业主','施工企业','平台'].filter((_,i)=>!current.signatures.some(x=>x.role===(['homeowner','company','platform']as const)[i])).map(x=>`${x}完成本方${signWord}`):[`按合同阶段提交资料，由业主验收并${settleWord}`];
  if(!state.legacyContract) {
    const awaiting=requests.filter(r=>r.status==='awaiting_review').length;
    if(role==='platform'&&awaiting)todos.push(`平台复核 ${awaiting} 笔待出款请求`);
    const mine=requests.filter(r=>own(r)&&r.status==='pending'&&r.actionUrl).length;
    if(mine)todos.push(`在服务商页面完成本方 ${mine} 项${state.mode==='real'?'签署或付款':''}待办，完成后点击“同步服务商结果”`);
    if(openSup)todos.push(openSup.status==='proposed'?`补充协议 ${openSup.number} 待双方确认`:`三方${signWord}补充协议 ${openSup.number}`);
    if(role==='platform'&&state.reconciliation&&!state.reconciliation.ok)todos.push('对账发现不一致，请与资金服务商核对');
  }
  const providerRequests=requests.map(r=>{const copy=structuredClone(r);if(!own(r))delete copy.actionUrl;return copy;});
  return {...structuredClone(state),providerRequests,current:structuredClone(current),status,...ledgerTotals(state),validation,effective:structuredClone(effectiveTerms(state)),
    draftText:state.legacyContent??generateContractDraft(current,state.mode),todos,allowedActions};
}
export const escapeHtml=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const HTML_HEAD=(title:string)=>`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${title}</title><style>body{font:15px/1.8 system-ui;max-width:900px;margin:40px auto;color:#222;padding:20px}pre{white-space:pre-wrap;font:inherit}img{max-width:320px;max-height:200px;object-fit:contain}header{border:2px solid #a35335;padding:12px}section{break-inside:avoid;border-top:1px solid #bbb;margin-top:20px}li{margin:12px 0}</style></head>`;
/** Evidence of a provider-signed signature, as it appears in an exported contract or supplement. */
function realSignatureHtml(s:WorkflowSignature,number:number):string {
  const e=escapeHtml,r=s.evidence;
  return `<section><h3>${e(ROLE_WORD[s.role])} · 已通过电子签署服务签署</h3><p>${e(s.signerName)} / 记录时间 ${e(s.at)} / v${number}</p>`
    +(r?`<p>服务商：${e(r.provider)}；外部单号：${e(r.externalId)}；回执号：${e(r.receiptId)}；服务商签署时间：${e(r.signedAt)}</p><p>签署人实名核验：${r.signerVerified?'已通过':'未通过'}${s.role==='homeowner'?'':`；企业主体与签署授权核验：${r.organizationVerified?'已通过':'未通过'}`}</p><p>证据摘要：${e(r.evidenceHash)}</p>${r.certificateFingerprint?`<p>证书指纹：${e(r.certificateFingerprint)}</p>`:''}`:'<p>缺少服务商回执</p>')
    +`<p>条款校验值：${e(s.termsHash)}</p></section>`;
}
function demoSignatureHtml(s:WorkflowSignature,number:number):string {
  const e=escapeHtml;
  return `<section><h3>${e(s.role)} · 已完成本方演示确认</h3><p>${e(s.signerName)} / ${e(s.at)} / v${number}</p><img alt="签名" src="${e(validateImageDataUrl(s.signatureDataUrl))}">${s.sealDataUrl?`<img alt="授权应用公章" src="${e(validateImageDataUrl(s.sealDataUrl))}">`:''}<p>条款校验值：${e(s.termsHash)}</p></section>`;
}
/** The exported contract, or with supplementId one of its supplements. A signed file never includes the later ledger, so its digest stays stable. */
export function renderWorkflowHtml(view:WorkflowView,supplementId?:string):string {
  if(supplementId!==undefined)return renderSupplementHtml(view,supplementId);
  const v=view.current,t=v.terms,e=escapeHtml;
  const images=t.attachments.map(a=>`<li>${e(a.name)} ${a.dataUrl?`<img alt="${e(a.name)}" src="${e(validateImageDataUrl(a.dataUrl))}">`:`<p>外部参考，未冻结远程内容：${e(a.url)}</p>`}${e(a.note)}</li>`).join('');
  const parties=[['甲方',t.homeowner],['乙方',t.company],['丙方',t.platform]].map(([label,p])=>{const party=p as ContractParty;return `<p>${label}：${e(party.legalName)}；登记资料：${e(party.registrationId)}；授权代表：${e(party.representative)}；联系：${e(party.contact)}</p>`;}).join('');
  if(view.mode==='real') {
    const signs=v.signatures.map(s=>realSignatureHtml(s,v.number)).join('');
    return `${HTML_HEAD(`予舍三方装修合同 ${e(v.contractId)}`)}<body><header><strong>三方装修合同 · 签署以电子签署服务商回执为准</strong><p>合同 ${e(v.contractId)} / 版本 ${v.number} / 工作流 ${e(view.id)} / 状态 ${e(view.status)}</p></header>${parties}<pre>${e(view.draftText)}</pre><h2>附件</h2><ul>${images}</ul><h2>三方电子签署（${v.signatures.length}/3）</h2>${signs}<p>条款SHA-256：${e(v.termsHash||'尚未冻结')}</p><p>校验缺项：${e(view.validation.missing.join('、')||'无')}；${e(view.validation.warnings.join('；'))}</p><p>施工验收、争议和资金交易另存履约账本，后续交易不改变本签署版本；合同变更以三方签署的补充协议为准。</p></body></html>`;
  }
  const signs=v.signatures.map(s=>demoSignatureHtml(s,v.number)).join('');
  return `${HTML_HEAD(`予舍演示合同 ${e(v.contractId)}`)}<body><header><strong>产品演示 · 非正式电子签 · 无真实资金</strong><p>合同 ${e(v.contractId)} / 版本 ${v.number} / 工作流 ${e(view.id)} / 状态 ${e(view.status)}</p></header>${parties}<pre>${e(view.draftText)}</pre><h2>附件</h2><ul>${images}</ul><h2>三方演示签署（${v.signatures.length}/3）</h2>${signs}<p>条款SHA-256：${e(v.termsHash||'尚未冻结')}</p><p>校验缺项：${e(view.validation.missing.join('、')||'无')}；${e(view.validation.warnings.join('；'))}</p><p>施工验收、争议和模拟资金交易另存履约账本，后续交易不改变本签署版本。</p></body></html>`;
}
function renderSupplementHtml(view:WorkflowView,supplementId:string):string {
  const sup=(view.supplements??[]).find(x=>x.id===supplementId);if(!sup)return fail('补充协议不存在','NOT_FOUND',404);
  const e=escapeHtml,t=sup.terms,money=(n:number)=>`${(n/100).toFixed(2)}元`,v=view.versions.find(x=>x.number===sup.baseVersion)??view.current,demo=view.mode==='demo';
  const statusWord:Record<SupplementStatus,string>={proposed:'待双方确认',frozen:'已冻结待签署',partially_signed:'签署中',signed:'三方已签署，已生效',signed_demo:'三方演示签署完成',withdrawn:'已撤回'};
  const terms=[`合同总价：${money(t.totalCents)}`,`工期：${t.durationDays}天`,`面积：${t.area}㎡（${t.areaBasis}）`,`风格：${t.style}`,`施工地点：${t.location}`,`施工范围：${t.scope}`,
    ...t.stages.map((s,i)=>`第${i+1}期：${s.name}，${money(s.amountCents)}；验收标准：${s.acceptanceCriteria}；计划日期：${s.plannedDate||'待约定'}`)].map(x=>`<li>${e(x)}</li>`).join('');
  const signs=sup.signatures.map(s=>demo?demoSignatureHtml(s,v.number):realSignatureHtml(s,v.number)).join('');
  return `${HTML_HEAD(`${demo?'予舍演示合同':'予舍三方装修合同'} ${e(v.contractId)} 补充协议 ${sup.number}`)}<body><header><strong>${demo?'产品演示 · 非正式电子签 · 无真实资金 · ':''}补充协议 ${sup.number}</strong><p>原合同 ${e(v.contractId)} / 签署版本 ${sup.baseVersion} / 原合同条款校验值 ${e(v.termsHash||'')} / 状态 ${e(statusWord[sup.status])}</p></header>`
    +`<p>本补充协议由${e(ROLE_WORD[sup.proposedBy])}于 ${e(sup.proposedAt)} 提出，经业主与施工企业确认，三方签署后取代原合同中对应的条款；原合同其余条款及已签正文不变，已提交、验收或结算的阶段不受影响。</p>`
    +`<h2>变更原因</h2><pre>${e(sup.reason)}</pre><h2>变更内容</h2><ul>${sup.changes.map(x=>`<li>${e(x)}</li>`).join('')}</ul><h2>变更后的主要条款</h2><ul>${terms}</ul>`
    +`<h2>三方${demo?'演示':'电子'}签署（${sup.signatures.length}/3）</h2>${signs}<p>补充协议条款SHA-256：${e(sup.termsHash||'尚未冻结')}</p>${sup.effectiveAt?`<p>生效时间：${e(sup.effectiveAt)}</p>`:''}</body></html>`;
}
