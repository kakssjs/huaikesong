/** Server-only persistent workflow service. Transactions and CAS protect the single PGlite process. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { and, eq, or, sql } from 'drizzle-orm';
import { getDb, orders, projects, users, results, contracts, bids, contractWorkflows as originalWorkflows, contractWorkflowVariants, workflowOperations, companyContractProfiles } from './db';
import { initializeWorkflow, getContractMode, isSignedStatus, reduceWorkflow, workflowView, renderWorkflowHtml, assertWorkflowParty, validateCommand, validateParty, validateImageDataUrl,
  textValue, defaultStagePlan, WorkflowError, providerRequestSent, providerRequestFailed, providerRequestCancelled, settleProviderRequest, reconcileWorkflow, recordReconciliation, workflowRole,
  platformAttention, effectiveTerms, type WorkflowActor, type WorkflowState, type WorkflowCommand, type ContractParty, type PaymentReceipt, type PlatformAttention,
  type ContractMode, type ContractTerms, type CompanyContractProfile, type WorkflowAttachment, type AIReview } from './workflow';
import { getContractProviders, type CallbackInput } from './contract-providers';

const selectedWorkflow = new AsyncLocalStorage<{ alternate:boolean; mode:ContractMode } | undefined>();
const workflowTable = () => selectedWorkflow.getStore()?.alternate ? contractWorkflowVariants : originalWorkflows;
const operationKey = (orderId:number,key:string) => selectedWorkflow.getStore()?.alternate
  ? `${orderId}:alternate:${selectedWorkflow.getStore()!.mode}:${key}` : `${orderId}:${key}`;
/** Mode is request-scoped; concurrent requests never change another party's selected contract. */
export async function withOrderWorkflowMode<T>(orderId:number,actor:WorkflowActor,mode:string|null|undefined,run:()=>Promise<T>):Promise<T> {
  if(mode!==undefined&&mode!==null&&mode!=='demo'&&mode!=='real')return error('合同模式无效');
  const [demoOrder] = await (await getDb()).select({ demo: projects.demo }).from(orders).innerJoin(projects, eq(projects.id, orders.projectId)).where(eq(orders.id, orderId));
  if (demoOrder?.demo === 1) {
    if (mode === 'real') return error('演示项目仅支持演示合同');
    mode = 'demo';
  }
  const original=await selectedWorkflow.run(undefined,()=>getOrderWorkflow(orderId,actor));
  return selectedWorkflow.run({alternate:!!mode&&mode!==original.mode,mode:(mode||original.mode) as ContractMode},run);
}

type Database = Awaited<ReturnType<typeof getDb>>;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
const globalQueue = globalThis as unknown as { __workflowQueue?: Promise<unknown> };
async function serial<T>(run:()=>Promise<T>):Promise<T> {
  const previous=globalQueue.__workflowQueue??Promise.resolve();const next=previous.catch(()=>{}).then(run);
  globalQueue.__workflowQueue=next.catch(()=>{});return next;
}
export function canonicalJson(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonicalJson).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  return JSON.stringify(value)??'null';
}
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const error=(message:string,code='INVALID_INPUT',status=400):never=>{throw new WorkflowError(message,code,status);};
const blankParty=(name='',contact=''):ContractParty=>({legalName:name,registrationId:'',representative:'',contact});
const PLATFORM_VIEW:WorkflowActor={uid:0,role:'boss'};
/** The digest the parties sign for a supplement: its terms bound to the signed contract it changes. */
function supplementDigest(state:WorkflowState,supplementId:string):string|undefined {
  const sup=(state.supplements??[]).find(x=>x.id===supplementId);if(!sup)return undefined;
  const base=state.versions.find(x=>x.number===sup.baseVersion);
  return digest({contractId:base?.contractId,baseVersion:sup.baseVersion,contractTermsHash:base?.termsHash,number:sup.number,reason:sup.reason,changes:sup.changes,terms:sup.terms});
}
/** Once fully signed, the exported file of the contract (and of each supplement) is fixed by its SHA-256. The file does not depend on who views it. */
function finalizeArtifacts(next:WorkflowState) {
  const current=next.versions.at(-1)!;
  if(isSignedStatus(current.status)&&!current.finalFileHash)current.finalFileHash=createHash('sha256').update(renderWorkflowHtml(workflowView(next,PLATFORM_VIEW))).digest('hex');
  for(const sup of next.supplements??[])if((sup.status==='signed'||sup.status==='signed_demo')&&!sup.finalFileHash)
    sup.finalFileHash=createHash('sha256').update(renderWorkflowHtml(workflowView(next,PLATFORM_VIEW),sup.id)).digest('hex');
}

async function decodeContractAsset(value:unknown) {
  const dataUrl=validateImageDataUrl(value);
  try {
    return await sharp(Buffer.from(dataUrl.split(',')[1],'base64'),{limitInputPixels:16_000_000,failOn:'warning',pages:1})
      .rotate().resize({width:420,height:240,fit:'inside',withoutEnlargement:true}).png().toBuffer({resolveWithObject:true});
  } catch {return error('图片无法解码或像素超过1600万，请重新上传有效PNG/JPEG/WebP');}
}
/** The supplied asset is composited, never synthesized. Only the contract-bound flattened PNG may leave the profile boundary. */
async function deriveContractAsset(value:unknown,contractId:string,version:number,label:string):Promise<string> {
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(contractId)||!Number.isSafeInteger(version)||version<1)return error('合同图片绑定标识无效');
  const decoded=await decodeContractAsset(value),binding=`${contractId} / v${version}`;
  // Generated ASCII identifiers only; user content is never inserted into SVG markup.
  const overlay=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect x="8" y="8" width="624" height="344" rx="8" fill="none" stroke="#985143" stroke-width="2"/><text x="320" y="38" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#723e35">DEMO ${label} - CONTRACT COPY</text><g transform="rotate(-15 320 180)" fill="#7f514a" opacity="0.57" font-family="sans-serif" font-size="21" text-anchor="middle"><text x="320" y="160">DEMO ${binding}</text><text x="320" y="212">DEMO ${binding}</text></g><text x="320" y="333" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#723e35">${binding}</text></svg>`);
  try {
    const output=await sharp({create:{width:640,height:360,channels:4,background:'#ffffff'}})
      .composite([{input:decoded.data,left:Math.floor((640-decoded.info.width)/2),top:Math.floor((360-decoded.info.height)/2)},{input:overlay}])
      .png({compressionLevel:9}).toBuffer();
    return validateImageDataUrl(`data:image/png;base64,${output.toString('base64')}`);
  } catch {return error('合同专用签章应用图处理失败，请重新上传');}
}
export const deriveContractSeal=(value:unknown,contractId:string,version:number)=>deriveContractAsset(value,contractId,version,'SEAL');

async function authorizedOrder(tx:Tx,id:number,actor:WorkflowActor) {
  if(!Number.isSafeInteger(id)||id<=0)return error('订单编号无效');
  const [order]=await tx.select().from(orders).where(eq(orders.id,id));if(!order)return error('订单不存在','NOT_FOUND',404);
  const allowed=actor.role==='boss'&&actor.uid===0||actor.role==='homeowner'&&actor.uid===order.homeownerId||actor.role==='company'&&actor.uid===order.companyId;
  if(!allowed)return error('无权访问该订单的合同','FORBIDDEN',403);
  if(actor.role!=='boss') {const [user]=await tx.select({role:users.role}).from(users).where(eq(users.id,actor.uid));if(!user||user.role!==actor.role)return error('账号身份已失效','FORBIDDEN',403);}
  if(!order.companyId)return error('须先选定承接装修公司','INVALID_STATE',409);
  return order;
}
function sourceAttachments(design:unknown):WorkflowAttachment[] {
  const output:WorkflowAttachment[]=[],seen=new Set<string>();
  const walk=(value:unknown,depth:number)=>{
    if(depth>5||output.length>=12)return;
    if(typeof value==='string'&&/^https:\/\//.test(value)&&/\.(png|jpe?g|webp)(\?|$)/i.test(value)&&!seen.has(value)) {
      seen.add(value);output.push({id:`source-reference-${output.length+1}`,name:`设计参考图${output.length+1}`,kind:'reference',url:value,note:'外部参考链接，仅记录链接，不保证远程内容不变'});
    } else if(Array.isArray(value))value.slice(0,30).forEach(x=>walk(x,depth+1));
    else if(value&&typeof value==='object')Object.values(value).slice(0,40).forEach(x=>walk(x,depth+1));
  };walk(design,0);return output;
}
async function loadOrCreate(tx:Tx,id:number,actor:WorkflowActor):Promise<WorkflowState> {
  const contractWorkflows=workflowTable();
  const order=await authorizedOrder(tx,id,actor);
  const [existing]=await tx.select().from(contractWorkflows).where(eq(contractWorkflows.orderId,id));
  if(existing) {const s=existing.state as unknown as WorkflowState;assertWorkflowParty(s,actor);return s;}
  const [project]=await tx.select().from(projects).where(eq(projects.id,order.projectId));
  const [owner]=await tx.select().from(users).where(eq(users.id,order.homeownerId));
  const [company]=await tx.select().from(users).where(eq(users.id,order.companyId!));
  if(!project||!owner||!company)return error('项目或签约主体已不存在','INCOMPLETE',409);
  const [profileRow]=await tx.select().from(companyContractProfiles).where(eq(companyContractProfiles.companyId,company.id));
  const profile=profileRow?.profile as CompanyContractProfile|undefined;
  const sourceRows=await tx.select().from(results).where(eq(results.projectId,project.id));
  const result=(kind:string)=>sourceRows.filter(r=>r.kind===kind).at(-1)?.content??null;
  const quote=result('quote'),design=result('design');
  const [acceptedBid]=await tx.select().from(bids).where(and(eq(bids.orderId,id),eq(bids.companyId,company.id),eq(bids.status,'accepted')));
  const totalCents=Math.round(Number(order.bidAmount)*1_000_000);
  if(!Number.isSafeInteger(totalCents)||totalCents<4||totalCents>100_000_000_000||!acceptedBid)return error('缺少有效中选报价，不能整理合同','INCOMPLETE',409);
  const area=Number(String(project.area??'').match(/[\d.]+/)?.[0])||0;
  const terms:ContractTerms={homeowner:blankParty(owner.name,owner.phone||owner.email||''),
    company:profile?.party??{...blankParty(company.companyName||company.name,company.phone||company.email||''),registrationId:company.license||''},platform:blankParty(),
    projectName:project.name,location:[project.province,project.city,project.district,project.community,project.address].filter(Boolean).join(' '),
    area,areaBasis:'',style:project.style,scope:'',totalCents,durationDays:Math.round(Number(order.bidWeeks)*7)||0,feeBps:300,
    stages:defaultStagePlan(totalCents),attachments:sourceAttachments(design),source:{
      project:{id:project.id,name:project.name,area:project.area,style:project.style,needs:project.needs,location:[project.province,project.city,project.district,project.address].filter(Boolean).join(' ')},
      quote:quote&&typeof quote==='object'?{...quote as Record<string,unknown>,selectedOffer:{bidId:acceptedBid.id,amountWan:acceptedBid.amount,weeks:acceptedBid.weeks,note:acceptedBid.note}}:quote,
      design:{...(design&&typeof design==='object'?design as Record<string,unknown>:{}),floorplan:result('floorplan'),plan:result('plan')},
    }};
  const [legacy]=await tx.select().from(contracts).where(eq(contracts.orderId,id));
  const at=new Date().toISOString();const state=initializeWorkflow({orderId:id,projectId:project.id,homeownerId:owner.id,companyId:company.id,terms,...(legacy&&!selectedWorkflow.getStore()?.alternate?{legacyContent:legacy.content}:{})},at,project.demo === 1 ? 'demo' : selectedWorkflow.getStore()?.mode??getContractMode(process.env.CONTRACT_MODE));
  if(selectedWorkflow.getStore()?.alternate) { state.id+=`-${state.mode}`; state.versions[0].contractId+=`-${state.mode}`; }
  await tx.insert(contractWorkflows).values({orderId:id,projectId:project.id,revision:0,state:state as never,updatedAt:at});return state;
}
export async function getOrderWorkflow(orderId:number,actor:WorkflowActor) {
  return serial(async()=>{const db=await getDb();return db.transaction(async tx=>workflowView(await loadOrCreate(tx,orderId,actor),actor));});
}
/** Preflight for a slow server adapter: permission, idempotency and revision are checked before any external call. */
export async function prepareWorkflowCommand(orderId:number,actor:WorkflowActor,cmd:WorkflowCommand) {
  validateCommand(cmd);
  return serial(async()=>{const db=await getDb();return db.transaction(async tx=>{
    const state=await loadOrCreate(tx,orderId,actor),fingerprint=digest({uid:actor.uid,role:actor.role,action:cmd.action,payload:cmd.payload??{}});
    const [prior]=await tx.select().from(workflowOperations).where(eq(workflowOperations.key,operationKey(orderId,cmd.requestKey)));
    if(prior&&prior.fingerprint!==fingerprint)return error('幂等请求键已被不同内容或身份使用','IDEMPOTENCY_CONFLICT',409);
    if(!prior&&state.revision!==cmd.expectedRevision)return error('版本已更新，请刷新后重试','STALE_REVISION',409);
    return {view:workflowView(state,actor),replayed:!!prior};
  });});
}
async function apply(orderId:number,actor:WorkflowActor,cmd:WorkflowCommand,review?:AIReview) {
  const contractWorkflows=workflowTable();
  validateCommand(cmd);
  return serial(async()=>{
    const db=await getDb();return db.transaction(async tx=>{
      const state=await loadOrCreate(tx,orderId,actor);
      const key=operationKey(orderId,cmd.requestKey),fingerprint=digest({uid:actor.uid,role:actor.role,action:cmd.action,payload:cmd.payload??{}});
      const [prior]=await tx.select().from(workflowOperations).where(eq(workflowOperations.key,key));
      if(prior) {if(prior.fingerprint!==fingerprint)return error('幂等请求键已被不同内容或身份使用','IDEMPOTENCY_CONFLICT',409);return workflowView(state,actor);}
      if(state.revision!==cmd.expectedRevision)return error('版本已更新，请刷新后重试','STALE_REVISION',409);
      if(cmd.action==='ai_review'&&!review)return error('规则草案，模型未调用；请使用服务端模型复核入口','MODEL_NOT_CONFIGURED',503);
      const [profileRow]=await tx.select().from(companyContractProfiles).where(eq(companyContractProfiles.companyId,state.companyId));
      const profile=profileRow?.profile as CompanyContractProfile|null,version=state.versions.at(-1)!;
      const supplementId=typeof cmd.payload?.supplementId==='string'?cmd.payload.supplementId:undefined;
      const supplement=supplementId?(state.supplements??[]).find(x=>x.id===supplementId):undefined;
      let appliedSignatureDataUrl:string|undefined,appliedSealDataUrl:string|undefined;
      if(cmd.action==='sign_demo') {
        // A supplement's demo signature and seal are bound to the supplement, so they cannot be lifted onto the contract.
        const bindId=supplement?`${version.contractId}-s${supplement.number}`:version.contractId;
        if(actor.role==='company') {
          if(cmd.payload?.authorizeSeal!==true)return error('公司必须明确授权本次合同用章');
          if(!profile?.sealDataUrl)return error('请先保存本公司的私有公章与授权资料');
          appliedSealDataUrl=await deriveContractSeal(profile.sealDataUrl,bindId,version.number);
        }
        appliedSignatureDataUrl=await deriveContractAsset(cmd.payload?.signatureDataUrl,bindId,version.number,`SIGNATURE ${actor.role.toUpperCase()}`);
      }
      // Which provider would carry this action. Without one, real actions are refused (503) rather than recorded.
      const providers=getContractProviders();
      const provider=cmd.action==='sign'?providers.signing?.name:['fund','release','refund','review_payout'].includes(cmd.action)?providers.payment?.name:undefined;
      const supplementTermsHash=cmd.action==='confirm_supplement'&&supplement?supplementDigest(state,supplement.id):undefined;
      const at=new Date().toISOString();const next=reduceWorkflow(state,actor,cmd,{at,profile,appliedSignatureDataUrl,appliedSealDataUrl,
        termsHash:digest(version.terms),signatureHash:typeof cmd.payload?.signatureDataUrl==='string'?digest(cmd.payload.signatureDataUrl):undefined,
        sealHash:appliedSealDataUrl?digest(appliedSealDataUrl):undefined,aiReview:review,provider,supplementTermsHash});
      finalizeArtifacts(next);
      const [saved]=await tx.update(contractWorkflows).set({revision:next.revision,state:next as never,updatedAt:at})
        .where(and(eq(contractWorkflows.orderId,orderId),eq(contractWorkflows.revision,cmd.expectedRevision))).returning({revision:contractWorkflows.revision});
      if(!saved)return error('版本已更新，请刷新后重试','STALE_REVISION',409);
      await tx.insert(workflowOperations).values({key,orderId,fingerprint,revision:next.revision,createdAt:at});
      return workflowView(next,actor);
    });
  });
}
/** Actions that can open a request the server has to hand to a signing or payment provider. */
const PROVIDER_ACTIONS=new Set(['sign','fund','review_payout']);
export async function actOnOrderWorkflow(orderId:number,actor:WorkflowActor,cmd:WorkflowCommand) {
  const view=await apply(orderId,actor,cmd);
  // A real signature or payment the command just opened is handed to the provider now, outside the database lock. The returned view then
  // carries the provider link for the party; nothing is signed or paid until the provider receipt arrives.
  if(PROVIDER_ACTIONS.has(cmd.action)&&(view.providerRequests??[]).some(r=>r.status==='creating'&&!r.hold)) {
    await dispatchProviderRequests(orderId);return getOrderWorkflow(orderId,actor);
  }
  // A dispute has just put a payout that is already with the provider on hold: ask the provider to stop it, if it can.
  if(cmd.action==='open_dispute'&&(view.providerRequests??[]).some(r=>r.hold&&r.status==='pending')) {
    await stopHeldPayouts(orderId);return getOrderWorkflow(orderId,actor);
  }
  return view;
}
/** Called only by a server adapter, never with a client-provided model result. CAS discards stale asynchronous reviews. */
export const recordAIReview=(orderId:number,actor:WorkflowActor,cmd:WorkflowCommand,review:AIReview)=>{
  if(cmd.action!=='ai_review')return Promise.reject(new WorkflowError('模型复核操作无效'));
  return apply(orderId,actor,cmd,review);
};
async function requireCompany(tx:Tx,actor:WorkflowActor) {
  if(actor.role!=='company')return error('仅公司本人可访问私有签约资料','FORBIDDEN',403);
  const [user]=await tx.select().from(users).where(eq(users.id,actor.uid));if(!user||user.role!=='company')return error('公司账号已失效','FORBIDDEN',403);
}
export async function getContractProfile(actor:WorkflowActor):Promise<CompanyContractProfile|null> {
  return serial(async()=>{const db=await getDb();return db.transaction(async tx=>{await requireCompany(tx,actor);const [row]=await tx.select().from(companyContractProfiles).where(eq(companyContractProfiles.companyId,actor.uid));return row?.profile as CompanyContractProfile??null;});});
}
export async function putContractProfile(actor:WorkflowActor,input:unknown):Promise<CompanyContractProfile> {
  if(actor.role!=='company')return error('仅公司本人可访问私有签约资料','FORBIDDEN',403);
  if(!input||typeof input!=='object'||Array.isArray(input))return error('签约资料格式无效');const p=input as Record<string,unknown>;
  const profile:CompanyContractProfile={party:validateParty(p.party),authorizedSignerName:textValue(p.authorizedSignerName,'企业授权签署人',true,200),mode:'demo',updatedAt:new Date().toISOString(),
    ...(p.sealDataUrl?{sealDataUrl:validateImageDataUrl(p.sealDataUrl)}:{})};
  if(profile.sealDataUrl)await decodeContractAsset(profile.sealDataUrl);
  return serial(async()=>{const db=await getDb();return db.transaction(async tx=>{await requireCompany(tx,actor);await tx.insert(companyContractProfiles).values({companyId:actor.uid,profile:profile as never,updatedAt:profile.updatedAt})
    .onConflictDoUpdate({target:companyContractProfiles.companyId,set:{profile:profile as never,updatedAt:profile.updatedAt}});return profile;});});
}

// ---------------------------------------------------------------------------------------------------------------
// Provider flow. Network calls to a provider never happen inside the database lock. Every write goes through
// mutateWorkflow, which re-reads the stored state, so a late or repeated provider answer is a no-op.
// ---------------------------------------------------------------------------------------------------------------
async function readWorkflow(orderId:number):Promise<WorkflowState> {
  const contractWorkflows=workflowTable();
  return serial(async()=>{const db=await getDb();const [row]=await db.select().from(contractWorkflows).where(eq(contractWorkflows.orderId,orderId));
    if(!row)return error('合同不存在','NOT_FOUND',404);return row.state as unknown as WorkflowState;});
}
async function mutateWorkflow(orderId:number,change:(state:WorkflowState,at:string)=>WorkflowState):Promise<WorkflowState> {
  const contractWorkflows=workflowTable();
  return serial(async()=>{const db=await getDb();return db.transaction(async tx=>{
    const [row]=await tx.select().from(contractWorkflows).where(eq(contractWorkflows.orderId,orderId));if(!row)return error('合同不存在','NOT_FOUND',404);
    const state=row.state as unknown as WorkflowState,at=new Date().toISOString(),next=change(state,at);
    if(next===state)return state;
    finalizeArtifacts(next);
    const [saved]=await tx.update(contractWorkflows).set({revision:next.revision,state:next as never,updatedAt:at})
      .where(and(eq(contractWorkflows.orderId,orderId),eq(contractWorkflows.revision,state.revision))).returning({revision:contractWorkflows.revision});
    if(!saved)return error('版本已更新，请刷新后重试','STALE_REVISION',409);
    return next;
  });});
}
const inflight=(globalThis as unknown as {__providerInflight?:Set<string>}).__providerInflight??=new Set<string>();
const message=(cause:unknown)=>(cause instanceof Error?cause.message:String(cause)).slice(0,300);
/** A provider that never answers must not keep a request, or the HTTP request that started it, open for ever. CONTRACT_PROVIDER_TIMEOUT_MS overrides the 20 s default. */
const providerTimeoutMs=()=>{const value=Number(process.env.CONTRACT_PROVIDER_TIMEOUT_MS);return Number.isFinite(value)&&value>=100?value:20_000;};
function withTimeout<T>(work:Promise<T>):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined;const limit=providerTimeoutMs();
  return Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(`服务商在 ${Math.round(limit/1000)} 秒内没有响应`)),limit);})]).finally(()=>clearTimeout(timer));
}
const externalIdOf=(result:{externalId?:unknown}|null|undefined):string=>{
  if(!result||typeof result.externalId!=='string'||!result.externalId.trim())throw new Error('服务商没有返回外部单号');
  return result.externalId;
};

/**
 * Hands every request the workflow opened (status creating) to its provider, using the request id as idempotency key.
 * A payout that a dispute has put on hold is not sent: nothing new leaves while the dispute is open.
 */
export async function dispatchProviderRequests(orderId:number):Promise<void> {
  const state=await readWorkflow(orderId),{signing,payment}=getContractProviders();
  for(const r of (state.providerRequests??[]).filter(x=>x.status==='creating'&&!x.hold)) {
    if(inflight.has(r.id))continue;inflight.add(r.id);
    try {
      const terms=effectiveTerms(state);
      if(r.kind==='sign') {
        if(!signing){await mutateWorkflow(orderId,(s,at)=>providerRequestFailed(s,r.id,'未配置电子签署服务商',at));continue;}
        const version=state.versions.find(x=>x.number===r.version)??state.versions.at(-1)!,sup=r.supplementId?(state.supplements??[]).find(x=>x.id===r.supplementId):undefined;
        const signed=sup?sup.terms:version.terms,party=r.role==='homeowner'?signed.homeowner:r.role==='company'?signed.company:signed.platform;
        let result;
        try {
          result=await withTimeout(signing.createSignRequest({requestId:r.id,contractId:version.contractId,version:version.number,role:r.role,termsHash:r.termsHash??'',
            ...(sup?{supplement:{id:sup.id,number:sup.number}}:{}),signer:{name:r.signerName??'',party,organization:r.role!=='homeowner'}}));
          externalIdOf(result);
        } catch(cause){await mutateWorkflow(orderId,(s,at)=>providerRequestFailed(s,r.id,`电子签署服务商未受理：${message(cause)}`,at));continue;}
        await mutateWorkflow(orderId,(s,at)=>providerRequestSent(s,r.id,{provider:signing.name,externalId:result.externalId,actionUrl:result.signUrl,expiresAt:result.expiresAt},at));
      } else {
        if(!payment){await mutateWorkflow(orderId,(s,at)=>providerRequestFailed(s,r.id,'未配置资金服务商',at));continue;}
        let result;
        try {
          // The provider is told who pays or is paid and, for a payout, how much of it is the platform fee, so that it can split the payment.
          result=await withTimeout(payment.createPayment({contractId:state.versions.at(-1)!.contractId,kind:r.kind,amountCents:r.amountCents??0,idempotencyKey:r.id,
            ...(r.stageId?{stageId:r.stageId}:{}),...(r.reason?{reason:r.reason}:{}),
            ...(r.kind==='fund'?{payer:terms.homeowner}:r.kind==='release'?{payee:terms.company,platformFeeCents:r.feeCents??0}
              :{payee:terms.homeowner,relatedExternalIds:state.transactions.filter(x=>x.type==='fund'&&x.receipt?.provider===payment.name).map(x=>x.receipt!.externalId)})}));
          externalIdOf(result);
        } catch(cause){await mutateWorkflow(orderId,(s,at)=>providerRequestFailed(s,r.id,`资金服务商未受理：${message(cause)}`,at));continue;}
        await mutateWorkflow(orderId,(s,at)=>providerRequestSent(s,r.id,{provider:payment.name,externalId:result.externalId,actionUrl:result.payUrl},at));
      }
    } finally {inflight.delete(r.id);}
  }
}

/**
 * A dispute puts payouts that are already with the provider on hold. This asks the provider to stop them, if it can.
 * Only a confirmation from the provider closes the request; without it the request stays on hold and the provider receipt decides.
 */
export async function stopHeldPayouts(orderId:number):Promise<void> {
  const state=await readWorkflow(orderId),{payment}=getContractProviders();
  if(!payment?.cancelPayment)return;
  for(const r of (state.providerRequests??[]).filter(x=>x.hold&&x.status==='pending'&&x.externalId&&x.provider===payment.name)) {
    try {
      if(await withTimeout(payment.cancelPayment(r.externalId!))===true)
        await mutateWorkflow(orderId,(s,at)=>providerRequestCancelled(s,r.id,'争议期间已由资金服务商撤回，资金没有划出',at));
    } catch(cause){console.warn(`[contract-provider] 撤回 ${r.id} 失败：`,message(cause));}
  }
}

type ProviderScope = { provider:string; kind:'signing'|'payment' };
/** Asks providers for receipts. A verified callback scopes both the lookup and sync to its provider and request category. */
export async function syncProviderRequests(orderId:number,onlyExternalId?:string,scope?:ProviderScope):Promise<void> {
  if(!scope) {
    await dispatchProviderRequests(orderId);
    await stopHeldPayouts(orderId);
  }
  const state=await readWorkflow(orderId),{signing,payment}=getContractProviders();
  for(const r of (state.providerRequests??[]).filter(x=>x.status==='pending'&&x.externalId&&(!onlyExternalId||x.externalId===onlyExternalId)
    &&(!scope||(x.provider===scope.provider&&(x.kind==='sign')===(scope.kind==='signing'))))) {
    try {
      if(r.kind==='sign') {
        if(!signing||signing.name!==r.provider)continue;
        const receipt=await withTimeout(signing.fetchResult(r.externalId!));
        if(receipt)await mutateWorkflow(orderId,(s,at)=>settleProviderRequest(s,r.id,{signing:receipt},at));
      } else {
        if(!payment||payment.name!==r.provider)continue;
        const receipt=await withTimeout(payment.fetchPayment(r.externalId!));
        if(receipt)await mutateWorkflow(orderId,(s,at)=>settleProviderRequest(s,r.id,{payment:receipt},at));
      }
    } catch(cause){console.warn(`[contract-provider] 查询 ${r.id} 失败：`,message(cause));}
  }
}

/** Runs a sync for a party of the order. */
export async function syncOrderWorkflow(orderId:number,actor:WorkflowActor) {
  await getOrderWorkflow(orderId,actor);
  await syncProviderRequests(orderId);
  return getOrderWorkflow(orderId,actor);
}

/** The platform compares every recorded money movement with the payment provider's current records. No amount is changed. */
export async function reconcileOrderWorkflow(orderId:number,actor:WorkflowActor) {
  const view=await getOrderWorkflow(orderId,actor);
  if(workflowRole(actor)!=='platform')return error('仅平台可以发起对账','FORBIDDEN',403);
  const {payment}=getContractProviders();
  if(!payment)return error('尚未配置资金服务商，无法对账','PROVIDER_NOT_CONFIGURED',503);
  const lookup:Record<string,PaymentReceipt|null>={};
  for(const tx of view.transactions.filter(x=>x.receipt)) {
    const externalId=tx.receipt!.externalId;if(externalId in lookup)continue;
    try{lookup[externalId]=await withTimeout(payment.fetchPayment(externalId));}catch(cause){return error(`资金服务商暂时无法查询（${message(cause)}），本次没有记录对账结果`,'PROVIDER_UNAVAILABLE',503);}
  }
  const report=reconcileWorkflow(view,lookup);
  await mutateWorkflow(orderId,(s,at)=>recordReconciliation(s,actor,report,at));
  return getOrderWorkflow(orderId,actor);
}

/** Everything across all contracts that is waiting for the platform: payout reviews, its own signatures, disputes, reconciliation differences. */
export async function listPlatformAttention():Promise<PlatformAttention[]> {
  return serial(async()=>{const db=await getDb();const rows=[...await db.select({state:originalWorkflows.state}).from(originalWorkflows),...await db.select({state:contractWorkflowVariants.state}).from(contractWorkflowVariants)];
    return rows.flatMap(row=>platformAttention(row.state as unknown as WorkflowState).map(item=>({...item,mode:(row.state as unknown as WorkflowState).mode})));});
}

/** Finds the order a provider session or movement belongs to. */
export async function findOrderByProviderReference(externalId:string,scope?:ProviderScope):Promise<number|null> {
  const contractWorkflows=workflowTable();
  if(typeof externalId!=='string'||!externalId||externalId.length>200)return null;
  return serial(async()=>{const db=await getDb();
    const references=scope?(scope.kind==='signing'?['sign']:['fund','release','refund']).map(kind=>({externalId,provider:scope.provider,kind})):[{externalId}];
    const rows=await db.select({orderId:contractWorkflows.orderId,state:contractWorkflows.state}).from(contractWorkflows)
      .where(or(...references.map(reference=>sql`${contractWorkflows.state} @> ${JSON.stringify({providerRequests:[reference]})}::jsonb`))).limit(2);
    const repeated=rows.some(row=>((row.state as unknown as WorkflowState).providerRequests??[]).filter(r=>r.externalId===externalId
      &&(!scope||(r.provider===scope.provider&&(r.kind==='sign')===(scope.kind==='signing')))).length>1);
    if(rows.length>1||repeated)return error('服务商单号对应多个请求，请人工核对','AMBIGUOUS_PROVIDER_REFERENCE',409);
    return rows[0]?.orderId??null;});
}

/** A provider callback only tells the server which session or movement to look at; the record itself is fetched from the provider. */
export async function handleProviderCallback(kind:'signing'|'payment',input:CallbackInput):Promise<{orderId:number}> {
  const providers=getContractProviders(),provider=kind==='signing'?providers.signing:providers.payment;
  if(!provider?.verifyCallback)return error('未配置该服务商的回调校验','PROVIDER_NOT_CONFIGURED',404);
  let reference;
  try{reference=await withTimeout(provider.verifyCallback(input));}catch{reference=null;}
  if(!reference?.externalId)return error('服务商回调校验未通过','INVALID_CALLBACK',401);
  const scope={provider:provider.name,kind};
  const matches=[];
  for(const alternate of [false,true]) {
    const orderId=await selectedWorkflow.run({alternate,mode:'real'},()=>findOrderByProviderReference(reference.externalId,scope));
    if(orderId)matches.push({orderId,alternate});
  }
  if(matches.length>1)return error('服务商单号对应多个请求，请人工核对','AMBIGUOUS_PROVIDER_REFERENCE',409);
  const {orderId,alternate}=matches[0]??{};
  if(!orderId)return error('没有找到对应的签署或资金请求','NOT_FOUND',404);
  await selectedWorkflow.run({alternate:!!alternate,mode:'real'},()=>syncProviderRequests(orderId,reference.externalId,scope));
  return {orderId};
}
