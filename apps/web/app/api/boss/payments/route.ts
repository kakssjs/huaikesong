import { NextResponse } from 'next/server';
import { decidePaymentRefund, listMembershipPayments, PaymentRefundError, recordPaymentTransaction } from '@i-renovation/shared';
import { requireSession } from '@/lib/auth';
import { payRequest, fetchTransaction } from '@/lib/opcpay';
import { refreshLedger, summarizeLedger, toLedger } from '@/lib/payment-ledger';

const noStore = { 'Cache-Control': 'no-store' };

// 老板查看全部会员付款账单。同时报告一人付当前开放的接口，避免把未开放的退款/账单说成可用
export async function GET(req: Request) {
  const s = await requireSession(req, ['boss']);
  if (s instanceof NextResponse) return s;
  try {
    const failed = await refreshLedger(await listMembershipPayments(), fetchTransaction, recordPaymentTransaction);
    const rows = toLedger(await listMembershipPayments());
    let provider: { refund: boolean; bills: boolean; transactionList: boolean; transactionQuery: boolean } | null = null;
    try {
      const c = (await payRequest('/capabilities')).capabilities ?? {};
      provider = { refund: c.refund === true, bills: c.bills === true, transactionList: c.transaction_list === true, transactionQuery: c.transaction_query === true };
    } catch { /* 能力查询失败时不猜测，界面显示“未能确认” */ }
    return NextResponse.json({ rows, summary: summarizeLedger(rows), provider, refreshFailed: failed }, { headers: noStore });
  } catch {
    return NextResponse.json({ error: '账单读取失败，请稍后重试' }, { status: 503, headers: noStore });
  }
}

// 处理退款申请。同意只是平台决定并记录；款项实际退回后，须由支付服务返回 REFUNDED 才算完成
export async function POST(req: Request) {
  const s = await requireSession(req, ['boss']);
  if (s instanceof NextResponse) return s;
  let body: { paymentId?: unknown; action?: unknown; note?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: '请求无效' }, { status: 400 }); }
  if (!Number.isSafeInteger(body.paymentId) || !['approve', 'reject'].includes(String(body.action))) {
    return NextResponse.json({ error: '参数不完整' }, { status: 400 });
  }
  try {
    const row = await decidePaymentRefund(body.paymentId as number, body.action as 'approve' | 'reject', body.note);
    return NextResponse.json({ ok: true, refund: row.refund }, { headers: noStore });
  } catch (error) {
    if (error instanceof PaymentRefundError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    return NextResponse.json({ error: '处理失败，请稍后重试' }, { status: 500 });
  }
}
