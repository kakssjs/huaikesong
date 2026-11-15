import { NextResponse } from 'next/server';
import { listMembershipPayments, PaymentRefundError, recordPaymentTransaction, requestPaymentRefund, withdrawPaymentRefund } from '@i-renovation/shared';
import { requireSession } from '@/lib/auth';
import { fetchTransaction } from '@/lib/opcpay';
import { refreshLedger, summarizeLedger, toLedger } from '@/lib/payment-ledger';

const noStore = { 'Cache-Control': 'no-store' };

// 装修公司查看自己的会员付款账单：付款状态以一人付最近一次验签结果为准，读取失败时保留上次结果并标明
export async function GET(req: Request) {
  const s = await requireSession(req, ['company']);
  if (s instanceof NextResponse) return s;
  try {
    const failed = await refreshLedger(await listMembershipPayments(s.uid), fetchTransaction, recordPaymentTransaction);
    const rows = toLedger(await listMembershipPayments(s.uid));
    return NextResponse.json({ rows, summary: summarizeLedger(rows), refreshFailed: failed }, { headers: noStore });
  } catch {
    return NextResponse.json({ error: '账单读取失败，请稍后重试' }, { status: 503, headers: noStore });
  }
}

// 申请或撤回退款。公司只能操作自己的付款；是否已退款只看支付服务返回的 REFUNDED
export async function POST(req: Request) {
  const s = await requireSession(req, ['company']);
  if (s instanceof NextResponse) return s;
  let body: { paymentId?: unknown; action?: unknown; reason?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: '请求无效' }, { status: 400 }); }
  if (!Number.isSafeInteger(body.paymentId) || !['request', 'withdraw'].includes(String(body.action))) {
    return NextResponse.json({ error: '参数不完整' }, { status: 400 });
  }
  try {
    const row = body.action === 'request'
      ? await requestPaymentRefund(s.uid, body.paymentId as number, body.reason)
      : await withdrawPaymentRefund(s.uid, body.paymentId as number);
    return NextResponse.json({ ok: true, refund: row.refund }, { headers: noStore });
  } catch (error) {
    if (error instanceof PaymentRefundError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    return NextResponse.json({ error: '退款操作失败，请稍后重试' }, { status: 500 });
  }
}
