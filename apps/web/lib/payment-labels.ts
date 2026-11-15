import type { LedgerRow } from './payment-ledger';

export type { LedgerRow };
export type LedgerSummary = {
  paidCount: number; paidCny: number; refundedCount: number; refundedCny: number;
  pendingCount: number; unknownCount: number; refundRequested: number; refundApproved: number;
};

const PAYMENT_LABEL: Record<string, { text: string; cls: string }> = {
  PAID: { text: '已支付', cls: 'tag tag-green' },
  PENDING: { text: '待支付', cls: 'tag tag-cyan' },
  REFUNDED: { text: '已退款', cls: 'tag tag-purple' },
  UNKNOWN: { text: '待确认', cls: 'tag tag-orange' },
  NOT_FOUND: { text: '支付服务无此记录', cls: 'tag tag-orange' },
};

const REFUND_LABEL: Record<string, string> = {
  requested: '待平台处理', approved: '平台已同意，等待退款到账', rejected: '平台已驳回', withdrawn: '已撤回', refunded: '已退款',
};

/** Label for the payment service's last verified status. A record with no snapshot has never been verified. */
export function paymentStatusLabel(row: Pick<LedgerRow, 'payment' | 'source'>) {
  if (row.source === 'legacy') return { text: '旧站/线下记录', cls: 'tag tag-cyan' };
  return row.payment ? PAYMENT_LABEL[row.payment.status] : { text: '未核验', cls: 'tag tag-orange' };
}

export function refundStatusText(refund: LedgerRow['refund']): string {
  return refund ? (REFUND_LABEL[refund.status] ?? refund.status) : '-';
}
