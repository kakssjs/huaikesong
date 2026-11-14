import { NextResponse } from 'next/server';
import { getContractByOrder, getOrder } from '@i-renovation/shared';
import { forbidden, isOrderParty, requireSession } from '@/lib/auth';

/** Legacy contracts remain readable. New draft/sign operations must pass the versioned workflow. */
export async function POST(req:Request,ctx:{params:Promise<{id:string}>}) {
  const actor=await requireSession(req);if(actor instanceof NextResponse)return actor;
  const id=Number((await ctx.params).id);if(!Number.isSafeInteger(id)||id<=0)return NextResponse.json({error:'订单编号无效'},{status:400});
  const order=await getOrder(id);if(!order)return NextResponse.json({error:'订单不存在'},{status:404});
  if(!isOrderParty(actor,order))return forbidden();
  return NextResponse.json({error:'历史合同只读保留；请使用新的三方合同工作流',code:'USE_WORKFLOW'},{status:409});
}
export async function GET(req:Request,ctx:{params:Promise<{id:string}>}) {
  const actor=await requireSession(req);if(actor instanceof NextResponse)return actor;
  const id=Number((await ctx.params).id);if(!Number.isSafeInteger(id)||id<=0)return NextResponse.json({error:'订单编号无效'},{status:400});
  const order=await getOrder(id);if(!order)return NextResponse.json({error:'订单不存在'},{status:404});
  if(!isOrderParty(actor,order))return forbidden();
  const contract=await getContractByOrder(id);if(!contract)return NextResponse.json({error:'合同不存在'},{status:404});
  return NextResponse.json({...contract,readOnly:true,legacy:true},{headers:{'Cache-Control':'no-store'}});
}
