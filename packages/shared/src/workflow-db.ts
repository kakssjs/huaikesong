/** Server-only persistent workflow service. Transactions and CAS protect the single PGlite process. */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { and, eq } from 'drizzle-orm';
import { getDb, orders, projects, users, results, contracts, bids, contractWorkflows, workflowOperations, companyContractProfiles } from './db';
import { initializeWorkflow, getContractMode, isSignedStatus, reduceWorkflow, workflowView, renderWorkflowHtml, assertWorkflowParty, validateCommand, validateParty, validateImageDataUrl,
  textValue, defaultStagePlan, WorkflowError, type WorkflowActor, type WorkflowState, type WorkflowCommand, type ContractParty,
  type ContractTerms, type CompanyContractProfile, type WorkflowAttachment, type AIReview } from './workflow';

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
  const at=new Date().toISOString();const state=initializeWorkflow({orderId:id,projectId:project.id,homeownerId:owner.id,companyId:company.id,terms,...(legacy?{legacyContent:legacy.content}:{})},at,getContractMode(process.env.CONTRACT_MODE));
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
    const [prior]=await tx.select().from(workflowOperations).where(eq(workflowOperations.key,`${orderId}:${cmd.requestKey}`));
    if(prior&&prior.fingerprint!==fingerprint)return error('幂等请求键已被不同内容或身份使用','IDEMPOTENCY_CONFLICT',409);
    if(!prior&&state.revision!==cmd.expectedRevision)return error('版本已更新，请刷新后重试','STALE_REVISION',409);
    return {view:workflowView(state,actor),replayed:!!prior};
  });});
}
async function apply(orderId:number,actor:WorkflowActor,cmd:WorkflowCommand,review?:AIReview) {
  validateCommand(cmd);
  return serial(async()=>{
    const db=await getDb();return db.transaction(async tx=>{
      const state=await loadOrCreate(tx,orderId,actor);
      const key=`${orderId}:${cmd.requestKey}`,fingerprint=digest({uid:actor.uid,role:actor.role,action:cmd.action,payload:cmd.payload??{}});
      const [prior]=await tx.select().from(workflowOperations).where(eq(workflowOperations.key,key));
      if(prior) {if(prior.fingerprint!==fingerprint)return error('幂等请求键已被不同内容或身份使用','IDEMPOTENCY_CONFLICT',409);return workflowView(state,actor);}
      if(state.revision!==cmd.expectedRevision)return error('版本已更新，请刷新后重试','STALE_REVISION',409);
      if(cmd.action==='ai_review'&&!review)return error('规则草案，模型未调用；请使用服务端模型复核入口','MODEL_NOT_CONFIGURED',503);
      const [profileRow]=await tx.select().from(companyContractProfiles).where(eq(companyContractProfiles.companyId,state.companyId));
      const profile=profileRow?.profile as CompanyContractProfile|null,version=state.versions.at(-1)!;
      let appliedSignatureDataUrl:string|undefined,appliedSealDataUrl:string|undefined;
      if(cmd.action==='sign_demo') {
        if(actor.role==='company') {
          if(cmd.payload?.authorizeSeal!==true)return error('公司必须明确授权本次合同用章');
          if(!profile?.sealDataUrl)return error('请先保存本公司的私有公章与授权资料');
          appliedSealDataUrl=await deriveContractSeal(profile.sealDataUrl,version.contractId,version.number);
        }
        appliedSignatureDataUrl=await deriveContractAsset(cmd.payload?.signatureDataUrl,version.contractId,version.number,`SIGNATURE ${actor.role.toUpperCase()}`);
      }
      const at=new Date().toISOString();const next=reduceWorkflow(state,actor,cmd,{at,profile,appliedSignatureDataUrl,appliedSealDataUrl,
        termsHash:digest(version.terms),signatureHash:typeof cmd.payload?.signatureDataUrl==='string'?digest(cmd.payload.signatureDataUrl):undefined,
        sealHash:appliedSealDataUrl?digest(appliedSealDataUrl):undefined,aiReview:review});
      const current=next.versions.at(-1)!;
      if(isSignedStatus(current.status)&&!current.finalFileHash)current.finalFileHash=createHash('sha256').update(renderWorkflowHtml(workflowView(next,actor))).digest('hex');
      const [saved]=await tx.update(contractWorkflows).set({revision:next.revision,state:next as never,updatedAt:at})
        .where(and(eq(contractWorkflows.orderId,orderId),eq(contractWorkflows.revision,cmd.expectedRevision))).returning({revision:contractWorkflows.revision});
      if(!saved)return error('版本已更新，请刷新后重试','STALE_REVISION',409);
      await tx.insert(workflowOperations).values({key,orderId,fingerprint,revision:next.revision,createdAt:at});
      return workflowView(next,actor);
    });
  });
}
export const actOnOrderWorkflow=(orderId:number,actor:WorkflowActor,cmd:WorkflowCommand)=>apply(orderId,actor,cmd);
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
