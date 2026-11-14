/** Pure contract domain. All monetary values are integer fen; no database, filesystem or external calls. */
export type WorkflowRole = 'homeowner' | 'company' | 'platform';
export type WorkflowActor = { uid: number; role: 'homeowner' | 'company' | 'boss' };
export type WorkflowStatus = 'awaiting_company' | 'awaiting_homeowner' | 'ready_to_freeze' | 'frozen' | 'partially_signed' | 'signed_demo' | 'superseded';
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
export interface WorkflowSignature {
  role: WorkflowRole; actorId: number; at: string; mode: 'demo'; signerName: string; signatureDataUrl: string;
  sealDataUrl?: string; termsHash: string; assetVersion?: string; signatureHash?: string; sealHash?: string;
  sealBinding?: { contractId: string; version: number; mode: 'demo' };
}
export interface ContractVersion {
  number: number; contractId: string; terms: ContractTerms; status: WorkflowStatus;
  confirmations: { company?: string; homeowner?: string }; signatures: WorkflowSignature[];
  termsHash?: string; finalFileHash?: string; frozenAt?: string; createdAt: string;
}
export interface StageAttempt { submittedAt: string; evidence: WorkflowAttachment[]; note: string; review?: 'accepted' | 'rejected'; reviewAt?: string; reason?: string }
export interface StageProgress { stageId: string; status: 'pending' | 'submitted' | 'rejected' | 'accepted' | 'settled' | 'cancelled'; attempts: StageAttempt[]; acceptedAt?: string; settledAt?: string; cancelledAt?: string; cancellationDisputeId?: string }
export interface WorkflowTransaction { id: string; requestKey: string; type: 'fund' | 'release' | 'refund'; amountCents: number; feeCents: number; netCents: number; stageId?: string; reason?: string; at: string; mode: 'demo' }
export interface WorkflowDispute { id: string; stageId: string; reason: string; evidence: WorkflowAttachment[]; status: 'open' | 'resolved'; createdAt: string; resolution?: { independentParty: string; basis: string; outcome: string; disposition: 'continue' | 'cancel_stage'; at: string } }
export interface WorkflowEvent { id: string; action: string; actorId: number; role: WorkflowRole; version: number; at: string; mode: 'demo'; note?: string }
export interface AIReview { status: 'not_called' | 'succeeded' | 'failed'; mode: 'rules' | 'model'; summary?: string; issues?: string[]; at?: string; error?: string; tokensUsed?: number }
export interface WorkflowState {
  mode: 'demo'; id: string; orderId: number; projectId: number; homeownerId: number; companyId: number;
  revision: number; currentVersion: number; versions: ContractVersion[]; stages: StageProgress[];
  transactions: WorkflowTransaction[]; disputes: WorkflowDispute[]; events: WorkflowEvent[];
  legacyContract: boolean; legacyContent?: string; aiReview: AIReview;
}
export interface WorkflowView extends WorkflowState {
  current: ContractVersion; status: WorkflowStatus; balanceCents: number; fundedCents: number; releasedCents: number;
  refundedCents: number; realizedFeeCents: number; validation: { missing: string[]; errors: string[]; warnings: string[] };
  draftText: string; todos: string[]; allowedActions: string[];
}
export type WorkflowAction = 'revise' | 'negotiate' | 'company_confirm' | 'homeowner_accept' | 'generate_draft' | 'freeze' | 'sign_demo'
  | 'submit_stage' | 'accept_stage' | 'reject_stage' | 'simulate_fund' | 'simulate_release' | 'simulate_refund' | 'open_dispute' | 'resolve_dispute' | 'ai_review';
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
export function validateContractTerms(t: ContractTerms) {
  const missing: string[]=[],errors: string[]=[],warnings: string[]=['规则生成草案；未经正式身份核验，不构成正式电子签署或真实资金托管。'];
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
export function initializeWorkflow(seed: {orderId:number;projectId:number;homeownerId:number;companyId:number;terms:ContractTerms;legacyContent?:string}, at=new Date().toISOString()): WorkflowState {
  return {mode:'demo',id:`workflow-${seed.orderId}`,orderId:seed.orderId,projectId:seed.projectId,homeownerId:seed.homeownerId,companyId:seed.companyId,revision:0,currentVersion:1,
    versions:[{number:1,contractId:`contract-${seed.orderId}`,terms:structuredClone(seed.terms),status:'awaiting_company',confirmations:{},signatures:[],createdAt:at}],
    stages:seed.terms.stages.map(s=>({stageId:s.id,status:'pending',attempts:[]})),transactions:[],disputes:[],events:[],legacyContract:seed.legacyContent!==undefined,
    ...(seed.legacyContent===undefined?{}:{legacyContent:seed.legacyContent}),aiReview:{status:'not_called',mode:'rules',summary:'规则草案，模型未调用'}};
}
export function assertWorkflowParty(s:WorkflowState,a:WorkflowActor) {
  if(a.role==='boss'&&a.uid===0)return;
  if((a.role==='homeowner'&&a.uid===s.homeownerId)||(a.role==='company'&&a.uid===s.companyId))return;
  return fail('无权访问该合同','FORBIDDEN',403);
}
export function ledgerTotals(s:WorkflowState) {
  const sum=(kind:string)=>s.transactions.filter(t=>t.type===kind).reduce((a,t)=>a+t.amountCents,0);
  const fundedCents=sum('fund'),releasedCents=sum('release'),refundedCents=sum('refund');
  return {fundedCents,releasedCents,refundedCents,balanceCents:fundedCents-releasedCents-refundedCents,realizedFeeCents:s.transactions.reduce((a,t)=>a+t.feeCents,0)};
}
const ROLE_ACTIONS:Record<WorkflowAction,WorkflowRole[]>={
  revise:['homeowner','company','platform'],negotiate:['homeowner'],company_confirm:['company'],homeowner_accept:['homeowner'],generate_draft:['homeowner','company','platform'],
  freeze:['homeowner','company','platform'],sign_demo:['homeowner','company','platform'],submit_stage:['company'],accept_stage:['homeowner'],reject_stage:['homeowner'],
  simulate_fund:['homeowner'],simulate_release:['homeowner'],simulate_refund:['homeowner'],open_dispute:['homeowner','company'],resolve_dispute:['platform'],ai_review:['homeowner','company','platform'],
};
export function validateCommand(cmd:WorkflowCommand) {
  if(!cmd||!Object.hasOwn(ROLE_ACTIONS,cmd.action)||!Number.isSafeInteger(cmd.expectedRevision)||cmd.expectedRevision<0||typeof cmd.requestKey!=='string'||!/^[A-Za-z0-9_.:-]{8,120}$/.test(cmd.requestKey))return fail('操作、版本或幂等请求键无效');
  if(cmd.payload!==undefined&&(!cmd.payload||typeof cmd.payload!=='object'||Array.isArray(cmd.payload)))return fail('payload必须是对象');
}
export function reduceWorkflow(state:WorkflowState,actor:WorkflowActor,cmd:WorkflowCommand,context:{at:string;termsHash?:string;profile?:CompanyContractProfile|null;signatureHash?:string;appliedSignatureDataUrl?:string;appliedSealDataUrl?:string;sealHash?:string;aiReview?:AIReview}):WorkflowState {
  validateCommand(cmd);assertWorkflowParty(state,actor);
  if(state.legacyContract)return fail('历史合同只读保留，请通过正式补充协议办理变更','LEGACY_READ_ONLY',409);
  if(state.revision!==cmd.expectedRevision)return fail('版本已更新，请刷新后重试','STALE_REVISION',409);
  const role=workflowRole(actor), action=cmd.action,p=cmd.payload??{},at=context.at;
  if(!ROLE_ACTIONS[action].includes(role))return fail('无权执行此操作，验收仅限业主本人','FORBIDDEN',403);
  const s=structuredClone(state),v=s.versions.at(-1)!, t=v.terms;
  const requireSigned=()=>{if(v.status!=='signed_demo')return fail('请先完成三方演示签署','INVALID_STATE',409);};
  const stage=()=>{const id=textValue(p.stageId,'阶段编号',true,100),plan=t.stages.find(x=>x.id===id),progress=s.stages.find(x=>x.stageId===id);if(!plan||!progress)return fail('阶段不存在');return {plan,progress};};
  const hasDispute=(id?:string)=>s.disputes.some(d=>d.status==='open'&&(!id||d.stageId===id));
  const amount=()=>positiveCents(p.amountCents);
  const addTransaction=(type:WorkflowTransaction['type'],amountCents:number,feeCents=0,stageId?:string)=>s.transactions.push({id:`tx-${s.orderId}-${s.revision+1}`,requestKey:cmd.requestKey,type,amountCents,feeCents,netCents:type==='release'?amountCents-feeCents:amountCents,stageId,at,mode:'demo'});
  if(action==='revise'||action==='negotiate') {
    if(v.status==='signed_demo')return fail('已签合同正文只读，变更须通过补充协议','SIGNED_READ_ONLY',409);
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
    const report=validateContractTerms(t);if(report.missing.length||report.errors.length)return fail(`合同存在缺项或校验错误：${[...report.missing,...report.errors].join('、')}`,'INCOMPLETE',409);
    if(!context.termsHash)return fail('缺少条款校验值');v.termsHash=context.termsHash;v.frozenAt=at;v.status='frozen';
  } else if(action==='sign_demo') {
    if(!['frozen','partially_signed'].includes(v.status)||!v.termsHash)return fail('请签署当前冻结版本','INVALID_STATE',409);
    if(v.signatures.some(x=>x.role===role))return fail('本方已完成此版本演示确认','INVALID_STATE',409);
    const signerName=textValue(p.signerName,'签署人姓名',true,200);
    validateImageDataUrl(p.signatureDataUrl);
    if(!context.appliedSignatureDataUrl)return fail('缺少绑定本合同版本的签名应用图');
    const signatureDataUrl=validateImageDataUrl(context.appliedSignatureDataUrl);
    let sealDataUrl:string|undefined,assetVersion:string|undefined;
    if(role==='company') {
      if(p.authorizeSeal!==true)return fail('公司必须明确授权本次合同用章');
      if(!context.profile?.sealDataUrl)return fail('请先保存本公司的私有公章与授权资料');
      if(signerName!==context.profile.authorizedSignerName)return fail('签署人须为企业资料中的授权人','FORBIDDEN',403);
      if(JSON.stringify(t.company)!==JSON.stringify(context.profile.party))return fail('公司资料已变化，请修订合同后重新确认','INVALID_STATE',409);
      if(!context.appliedSealDataUrl)return fail('缺少绑定本合同版本的公章应用图');
      sealDataUrl=validateImageDataUrl(context.appliedSealDataUrl);assetVersion=context.profile.updatedAt;
    }
    v.signatures.push({role,actorId:actor.uid,at,mode:'demo',signerName,signatureDataUrl,termsHash:v.termsHash,
      ...(sealDataUrl?{sealDataUrl,assetVersion,sealHash:context.sealHash,sealBinding:{contractId:v.contractId,version:v.number,mode:'demo' as const}}:{}),signatureHash:context.signatureHash});
    v.status=v.signatures.length===3?'signed_demo':'partially_signed';
  } else if(action==='submit_stage') {
    requireSigned();const {progress}=stage();if(!['pending','rejected'].includes(progress.status))return fail('此阶段不接受重复提交','INVALID_STATE',409);
    progress.attempts.push({submittedAt:at,evidence:validateAttachments(p.evidence,true),note:textValue(p.note,'施工说明',true,2000)});progress.status='submitted';
  } else if(action==='accept_stage'||action==='reject_stage') {
    requireSigned();const {progress}=stage();if(progress.status!=='submitted')return fail('仅可验收施工方已提交阶段','INVALID_STATE',409);
    const attempt=progress.attempts.at(-1)!;attempt.reviewAt=at;
    if(action==='reject_stage'){attempt.reason=textValue(p.reason,'驳回理由');attempt.review='rejected';progress.status='rejected';}
    else{attempt.review='accepted';progress.status='accepted';progress.acceptedAt=at;}
  } else if(action==='simulate_fund') {
    requireSigned();const value=amount(),totals=ledgerTotals(s);
    if(totals.fundedCents-totals.refundedCents+value>t.totalCents)return fail('模拟入金不得超过合同总价');addTransaction('fund',value);
  } else if(action==='simulate_release') {
    requireSigned();const {plan,progress}=stage();if(progress.status!=='accepted')return fail('此阶段须由业主验收通过，或已结算','INVALID_STATE',409);
    if(hasDispute(plan.id))return fail('该阶段存在未解决争议，未结算金额已冻结','DISPUTE_FROZEN',409);
    const totals=ledgerTotals(s);if(totals.balanceCents<plan.amountCents)return fail('可结算资金余额不足','INSUFFICIENT_FUNDS',409);
    // Cumulative fee rounding keeps the final total exact regardless of stage settlement order.
    const fee=Math.round((totals.releasedCents+plan.amountCents)*t.feeBps/10000)-totals.realizedFeeCents;
    addTransaction('release',plan.amountCents,fee,plan.id);progress.status='settled';progress.settledAt=at;
  } else if(action==='simulate_refund') {
    requireSigned();textValue(p.reason,'退款理由');if(hasDispute())return fail('存在未解决争议，禁止单方退款','DISPUTE_FROZEN',409);
    const value=amount(),balance=ledgerTotals(s).balanceCents;
    if(value>balance)return fail('退款超出未结算资金余额；已结算款须另行返还','INSUFFICIENT_FUNDS',409);
    const reserved=t.stages.filter(plan=>s.stages.some(progress=>progress.stageId===plan.id&&progress.status==='accepted')).reduce((sum,plan)=>sum+plan.amountCents,0);
    if(value>Math.max(0,balance-reserved))return fail('须保留已验收但未结算阶段的资金，不允许单方退款取走','ACCEPTED_FUNDS_RESERVED',409);
    addTransaction('refund',value);s.transactions.at(-1)!.reason=textValue(p.reason,'退款理由');
  } else if(action==='open_dispute') {
    requireSigned();const {plan}=stage();if(hasDispute(plan.id))return fail('该阶段已有未解决争议','INVALID_STATE',409);
    s.disputes.push({id:`dispute-${s.orderId}-${s.revision+1}`,stageId:plan.id,reason:textValue(p.reason,'争议说明'),evidence:validateAttachments(p.evidence??[]),status:'open',createdAt:at});
  } else if(action==='resolve_dispute') {
    requireSigned();const d=s.disputes.find(x=>x.id===p.disputeId);if(!d||d.status!=='open')return fail('未找到待处理争议','INVALID_STATE',409);
    const independentParty=textValue(p.independentParty,'独立处理方'),basis=textValue(p.basis,'处理依据'),outcome=textValue(p.outcome,'处理记录');
    const disposition=p.disposition??'continue';if(disposition!=='continue'&&disposition!=='cancel_stage')return fail('争议处理方式无效');
    if(disposition==='cancel_stage') {
      const progress=s.stages.find(x=>x.stageId===d.stageId);
      if(!progress||progress.status==='cancelled'||progress.status==='settled'||s.transactions.some(x=>x.type==='release'&&x.stageId===d.stageId))return fail('已结算或已取消阶段不能再次取消；已付资金须另行返还','INVALID_STATE',409);
      progress.status='cancelled';progress.cancelledAt=at;progress.cancellationDisputeId=d.id;
    }
    d.resolution={independentParty,basis,outcome,disposition,at};d.status='resolved';
  } else if(action==='ai_review') {
    if(!context.aiReview)return fail('规则草案，模型未调用；模型复核入口尚未配置','MODEL_NOT_CONFIGURED',409);s.aiReview=context.aiReview;
  }
  s.revision+=1;s.events.push({id:`event-${s.orderId}-${s.revision}`,action,actorId:actor.uid,role,version:s.currentVersion,at,mode:'demo',...(typeof p.note==='string'?{note:p.note.slice(0,2000)}:{})});
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
export function generateContractDraft(v:ContractVersion):string {
  const t=v.terms,money=(n:number)=>(n/100).toFixed(2);
  return ['予舍三方装修合同 · 演示规则草案（需人工复核）',`合同编号：${v.contractId}　版本：${v.number}`,
    `甲方（业主）：${t.homeowner.legalName||'待补充'}；乙方（施工企业）：${t.company.legalName||'待补充'}；丙方（平台）：${t.platform.legalName||'待补充'}`,
    `项目：${t.projectName}；施工地点：${t.location||'待补充'}`,
    `面积：${t.area}㎡（${t.areaBasis||'计量口径待确认'}）；风格：${t.style}；范围：${t.scope||'待补充'}`,
    `合同总价：${money(t.totalCents)}元；参考均价：${t.area>0?money(Math.round(t.totalCents/t.area)):'待确认'}元/㎡（仅为总价除以面积的参考，不重复计价）。`,
    `工期：${t.durationDays}天。具体开竣工日期、材料品牌规格、排除项、变更、保修和违约条款须由各方另行复核确认。`,
    `平台履约服务费由乙方承担，按每次成功模拟阶段结算金额的${t.feeBps/100}%计收；累计费用分位舍入，签署、入金和验收不计收入。`,
    ...t.stages.map((s,i)=>`第${i+1}期：${s.name}，${money(s.amountCents)}元；验收标准：${s.acceptanceCriteria}；计划日期：${s.plannedDate||'待约定'}。`),
    '施工方提交证据，业主明确验收通过后，仍须检查资金余额和争议状态。平台不代替业主验收，不作为独立仲裁机构。',
    '争议按双方约定提交独立处理方，保留证据和处理依据。已结算交易不得抹除，退款另记交易。',
    '附件清单：',...t.attachments.map(a=>`${a.name}（${a.dataUrl?'版本内图片快照':'外部参考链接，未冻结远程内容'}）${a.note||''}`),
    upstreamSnapshotText(t),
    '本文件为产品演示，签名、公章图片仅记录本方演示确认，不承诺正式法律效力；模拟余额不代表第三方真实托管或真实到账。'].join('\n');
}
export function workflowView(state:WorkflowState,actor:WorkflowActor):WorkflowView {
  assertWorkflowParty(state,actor);const current=state.versions.at(-1)!,status=current.status,role=workflowRole(actor);
  let allowedActions=(Object.keys(ROLE_ACTIONS)as WorkflowAction[]).filter(a=>ROLE_ACTIONS[a].includes(role));
  allowedActions=allowedActions.filter(a=>{
    if(state.legacyContract)return false;
    if(a==='revise'||a==='negotiate')return status!=='signed_demo';
    if(a==='company_confirm')return status==='awaiting_company';if(a==='homeowner_accept')return status==='awaiting_homeowner';
    if(a==='freeze')return status==='ready_to_freeze';if(a==='sign_demo')return ['frozen','partially_signed'].includes(status)&&!current.signatures.some(x=>x.role===role);
    if(['generate_draft','ai_review'].includes(a))return true;return status==='signed_demo';
  });
  const validation=validateContractTerms(current.terms);
  const todos=state.legacyContract?['历史合同只读保留']:status==='awaiting_company'?['施工企业确认当前报价、范围与工期']:status==='awaiting_homeowner'?['业主接受当前版本或提出议价']:status==='ready_to_freeze'?['补齐资料并冻结签署版本']:['frozen','partially_signed'].includes(status)?['业主','施工企业','平台'].filter((_,i)=>!current.signatures.some(x=>x.role===(['homeowner','company','platform']as const)[i])).map(x=>`${x}完成本方演示签署`):['按合同阶段提交资料，由业主验收并申请模拟结算'];
  return {...structuredClone(state),current:structuredClone(current),status,...ledgerTotals(state),validation,draftText:state.legacyContent??generateContractDraft(current),todos,allowedActions};
}
export const escapeHtml=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function renderWorkflowHtml(view:WorkflowView):string {
  const v=view.current,t=v.terms,e=escapeHtml;
  const images=t.attachments.map(a=>`<li>${e(a.name)} ${a.dataUrl?`<img alt="${e(a.name)}" src="${e(validateImageDataUrl(a.dataUrl))}">`:`<p>外部参考，未冻结远程内容：${e(a.url)}</p>`}${e(a.note)}</li>`).join('');
  const parties=[['甲方',t.homeowner],['乙方',t.company],['丙方',t.platform]].map(([label,p])=>{const party=p as ContractParty;return `<p>${label}：${e(party.legalName)}；登记资料：${e(party.registrationId)}；授权代表：${e(party.representative)}；联系：${e(party.contact)}</p>`;}).join('');
  const signs=v.signatures.map(s=>`<section><h3>${e(s.role)} · 已完成本方演示确认</h3><p>${e(s.signerName)} / ${e(s.at)} / v${v.number}</p><img alt="签名" src="${e(validateImageDataUrl(s.signatureDataUrl))}">${s.sealDataUrl?`<img alt="授权应用公章" src="${e(validateImageDataUrl(s.sealDataUrl))}">`:''}<p>条款校验值：${e(s.termsHash)}</p></section>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>予舍演示合同 ${e(v.contractId)}</title><style>body{font:15px/1.8 system-ui;max-width:900px;margin:40px auto;color:#222;padding:20px}pre{white-space:pre-wrap;font:inherit}img{max-width:320px;max-height:200px;object-fit:contain}header{border:2px solid #a35335;padding:12px}section{break-inside:avoid;border-top:1px solid #bbb;margin-top:20px}li{margin:12px 0}</style></head><body><header><strong>产品演示 · 非正式电子签 · 无真实资金</strong><p>合同 ${e(v.contractId)} / 版本 ${v.number} / 工作流 ${e(view.id)} / 状态 ${e(view.status)}</p></header>${parties}<pre>${e(view.draftText)}</pre><h2>附件</h2><ul>${images}</ul><h2>三方演示签署（${v.signatures.length}/3）</h2>${signs}<p>条款SHA-256：${e(v.termsHash||'尚未冻结')}</p><p>校验缺项：${e(view.validation.missing.join('、')||'无')}；${e(view.validation.warnings.join('；'))}</p><p>施工验收、争议和模拟资金交易另存履约账本，后续交易不改变本签署版本。</p></body></html>`;
}
