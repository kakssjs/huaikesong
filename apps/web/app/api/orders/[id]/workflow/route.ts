import { withOrderWorkflowMode } from '@i-renovation/shared/workflow-db';
import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { getOrderWorkflow, actOnOrderWorkflow, recordAIReview, prepareWorkflowCommand } from '@i-renovation/shared/workflow-db';
import { renderWorkflowHtml, validateCommand, WorkflowError, type WorkflowCommand } from '@i-renovation/shared/workflow';
import { reviewContractTerms } from '@/lib/contract-agent';
import { callLLM } from '@/lib/llm';

const headers = { 'Cache-Control': 'no-store' };
const activeReviews = new Map<string, ReturnType<typeof reviewContractTerms>>();
function failure(error:unknown) {
  if(error instanceof WorkflowError)return NextResponse.json({error:error.message,code:error.code},{status:error.status,headers});
  return NextResponse.json({error:'合同工作流暂不可用，请稍后重试',code:'WORKFLOW_ERROR'},{status:500,headers});
}
export async function GET(req:Request,ctx:{params:Promise<{id:string}>}) {
  try {
    const actor=await requireSession(req);if(actor instanceof NextResponse)return actor;
    return await withOrderWorkflowMode(Number((await ctx.params).id),actor,new URL(req.url).searchParams.get('mode'),async()=>{
    const view=await getOrderWorkflow(Number((await ctx.params).id),actor);
    const query=new URL(req.url).searchParams;
    if(query.get('format')==='html') {
      const supplementId=query.get('supplement')??undefined;
      const supplement=supplementId?(view.supplements??[]).find(x=>x.id===supplementId):undefined;
      if(supplementId&&!supplement)throw new WorkflowError('补充协议不存在','NOT_FOUND',404);
      const fileHash=supplement?supplement.finalFileHash:view.current.finalFileHash;
      const name=`yushe-${view.orderId}-v${view.currentVersion}${supplement?`-supplement-${supplement.number}`:''}-${view.mode==='demo'?'demo':'contract'}.html`;
      return new Response(renderWorkflowHtml(view,supplementId),{headers:{...headers,'Content-Type':'text/html; charset=utf-8',
        'Content-Disposition':`attachment; filename="${name}"`,'X-Content-Type-Options':'nosniff',
        ...(fileHash?{'X-Contract-Artifact-SHA256':fileHash}:{})}});
    }
    return NextResponse.json(view,{headers});
  });
  }catch(error){return failure(error);}
}
export async function POST(req:Request,ctx:{params:Promise<{id:string}>}) {
  try {
    const actor=await requireSession(req);if(actor instanceof NextResponse)return actor;
    return await withOrderWorkflowMode(Number((await ctx.params).id),actor,new URL(req.url).searchParams.get('mode'),async()=>{
    if(Number(req.headers.get('content-length'))>20_000_000)throw new WorkflowError('请求文件总量过大');
    const raw=await req.text();if(raw.length>20_000_000)throw new WorkflowError('请求文件总量过大');
    let command:WorkflowCommand;try{command=JSON.parse(raw);}catch{throw new WorkflowError('请求JSON无效');}
    validateCommand(command);const id=Number((await ctx.params).id);
    if(command.action==='ai_review') {
      const {view,replayed}=await prepareWorkflowCommand(id,actor,command);
      if(replayed)return NextResponse.json(view,{headers});
      if(view.legacyContract)throw new WorkflowError('历史合同只读保留','LEGACY_READ_ONLY',409);
      if(view.revision!==command.expectedRevision)throw new WorkflowError('版本已更新，请刷新后复核','STALE_REVISION',409);
      if(view.validation.missing.length||view.validation.errors.length)throw new WorkflowError('请先补齐合同缺项与金额校验，再主动发起模型复核','INCOMPLETE',409);
      if(!process.env.LLM_API_KEY) {
        const saved=await recordAIReview(id,actor,command,{status:'not_called',mode:'rules',summary:'规则草案，模型未调用：未配置模型服务',at:new Date().toISOString()});
        return NextResponse.json({error:'规则草案，模型未调用：未配置模型服务',code:'MODEL_NOT_CONFIGURED',workflow:saved},{status:503,headers});
      }
      const t=view.current.terms;
      // Network call stays outside database locks. Original revision must still match when the result returns.
      let review;
      const reviewKey=`${view.mode}:${id}:${actor.uid}:${actor.role}:${command.requestKey}`;
      try {
        let pending=activeReviews.get(reviewKey);
        if(!pending) {
          pending=reviewContractTerms({area:t.area,areaBasis:t.areaBasis,style:t.style,scope:t.scope,totalCents:t.totalCents,durationDays:t.durationDays,
            feeBps:t.feeBps,stages:t.stages.map(({name,amountCents,acceptanceCriteria})=>({name,amountCents,acceptanceCriteria})),missing:view.validation.missing,errors:view.validation.errors},callLLM);
          activeReviews.set(reviewKey,pending);
        }
        review=await pending;
      }
      catch {
        const saved=await recordAIReview(id,actor,command,{status:'failed',mode:'model',summary:'模型复核未完成，合同内容未改变',error:'模型服务暂不可用或返回格式无效',at:new Date().toISOString()});
        return NextResponse.json({error:'模型复核未完成，请稍后重试；合同内容未改变',code:'MODEL_REVIEW_FAILED',workflow:saved},{status:503,headers});
      }
      finally {activeReviews.delete(reviewKey);}
      return NextResponse.json(await recordAIReview(id,actor,command,review),{headers});
    }
    // For a real signature or payment the service hands the new request to the provider before it returns (see actOnOrderWorkflow).
    return NextResponse.json(await actOnOrderWorkflow(id,actor,command),{headers});
  });
  }catch(error){return failure(error);}
}
