import type { listMembershipPayments, PaymentTransaction } from '@i-renovation/shared';

// The provider asks for at least 15 seconds between status reads and caps each key at 120 requests a minute.
export const MIN_REFRESH_MS = 15000;

type Row = Awaited<ReturnType<typeof listMembershipPayments>>[number];

/** Refreshes the records that can still change: not yet refunded and not read in the last 15 seconds. Failures keep the old snapshot. */
export async function refreshLedger(
  rows: Row[],
  read: (row: Row) => Promise<PaymentTransaction>,
  save: (id: number, snapshot: PaymentTransaction) => Promise<unknown>,
  now = Date.now(),
) {
  const stale = rows.filter(r => r.purchaseIntent && r.transactionSnapshot?.status !== 'REFUNDED'
    && !(r.transactionSnapshot && now - Date.parse(r.transactionSnapshot.fetchedAt) < MIN_REFRESH_MS));
  const failures: number[] = [];
  for (const row of stale.slice(0, 20)) {
    try { await save(row.id, await read(row)); } catch { failures.push(row.id); }
  }
  return failures;
}

export type LedgerRow = {
  id: number; companyId: number; companyName: string; amountCny: number; createdAt: string; entryStatus: string;
  source: 'opcpay' | 'legacy'; payment: PaymentTransaction | null; refund: Row['refund'];
};

export function toLedger(rows: Row[]): LedgerRow[] {
  return rows.map(r => ({
    id: r.id, companyId: r.companyId, companyName: r.companyName, amountCny: r.amountCny, createdAt: r.createdAt, entryStatus: r.status,
    source: r.purchaseIntent ? 'opcpay' : 'legacy', payment: r.transactionSnapshot ?? null, refund: r.refund ?? null,
  }));
}

/** Totals count only what the provider verified. The provider returns no amounts, so the amount is the plan price recorded here. */
export function summarizeLedger(rows: LedgerRow[]) {
  const sum = (status: string) => rows.filter(r => r.payment?.status === status).reduce((n, r) => n + r.amountCny, 0);
  const count = (status: string) => rows.filter(r => r.payment?.status === status).length;
  return {
    paidCount: count('PAID'), paidCny: sum('PAID'), refundedCount: count('REFUNDED'), refundedCny: sum('REFUNDED'),
    pendingCount: count('PENDING'), unknownCount: count('UNKNOWN'),
    refundRequested: rows.filter(r => r.refund?.status === 'requested').length,
    refundApproved: rows.filter(r => r.refund?.status === 'approved').length,
  };
}
