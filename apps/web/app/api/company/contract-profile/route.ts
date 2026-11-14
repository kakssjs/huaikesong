import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { getContractProfile, putContractProfile } from '@i-renovation/shared/workflow-db';
import { WorkflowError } from '@i-renovation/shared/workflow';
const headers={'Cache-Control':'no-store'};
const failure=(error:unknown)=>NextResponse.json({error:error instanceof WorkflowError?error.message:'签约资料暂不可用',code:error instanceof WorkflowError?error.code:'PROFILE_ERROR'},
  {status:error instanceof WorkflowError?error.status:500,headers});
export async function GET(req:Request) {
  try{const actor=await requireSession(req,['company']);if(actor instanceof NextResponse)return actor;return NextResponse.json(await getContractProfile(actor),{headers});}catch(error){return failure(error);}
}
export async function PUT(req:Request) {
  try{
    const actor=await requireSession(req,['company']);if(actor instanceof NextResponse)return actor;
    if(Number(req.headers.get('content-length'))>1_500_000)throw new WorkflowError('公章图片文件过大');
    const raw=await req.text();if(raw.length>1_500_000)throw new WorkflowError('公章图片文件过大');
    let input:unknown;try{input=JSON.parse(raw);}catch{throw new WorkflowError('签约资料JSON无效');}
    return NextResponse.json(await putContractProfile(actor,input),{headers});
  }catch(error){return failure(error);}
}
