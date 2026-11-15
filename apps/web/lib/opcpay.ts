import { opcpay } from 'opcpay';
import type { PaymentTransaction } from '@i-renovation/shared';

// Keep the namespace stable: changing it disconnects previously purchased memberships.
export function membershipIdentity(kind: 'company' | 'membership', id: number): string {
  const namespace = process.env.MEMBERSHIP_PAYMENT_NAMESPACE || '';
  if (namespace && !/^[a-zA-Z0-9_-]{1,40}$/.test(namespace)) throw new Error('会员支付实例标识无效');
  return `${namespace ? namespace + '-' : ''}${kind}-${id}`;
}

export function membershipReturnUrl(): string {
  const base = new URL(process.env.PUBLIC_BASE_URL || '');
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('会员支付返回地址配置无效');
  }
  return new URL('/contractor?payment_return=1', base).href;
}

// Only the server calls this API; identities always come from the signed company session.
export async function payRequest(path: string, body?: Record<string, unknown>) {
  const key = process.env.opcpay_api_key;
  if (!key) throw new Error('支付宝收款暂未配置');
  try {
    return await new opcpay().request<any>(path, body);
  } catch (cause) {
    // Do not expose provider error bodies or credentials through public API errors.
    const error = new Error('支付服务暂不可用，请稍后使用原记录重试');
    Object.assign(error, { code: (cause as { code?: string }).code });
    throw error;
  }
}

export function basicSku(product: any): string {
  const options = product.charging_options?.filter((p: any) => typeof p.sku_id === 'string' && p.sku_id &&
    p.billing_mode === 'ONE_TIME_DURATION' && p.duration_period === 'MONTH' &&
    p.currency === 'CNY' && p.price === '39.00');
  if (product.capability_status !== 'ENABLED' || options?.length !== 1) throw new Error('当前基础月会员与商户实际套餐不匹配，暂不可购买');
  return options[0].sku_id;
}

export function entitlement(data: any) {
  if (!['ALLOW', 'DENY', 'PURCHASE_REQUIRED'].includes(data.decision) || typeof data.access_granted !== 'boolean') {
    throw new Error('权益结果尚未确认，请稍后刷新');
  }
  if (data.decision !== 'ALLOW' || data.access_granted !== true) return null;
  if (data.requires_consumption === true) throw new Error('当前会员仅支持时长套餐，不能凭余额直接开放服务');
  const value = data.valid_until;
  if (typeof value !== 'string') throw new Error('会员有效期尚未确认');
  const expires = new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? value.replace(' ', 'T') + '+08:00' : value);
  if (!Number.isFinite(expires.getTime())) throw new Error('会员有效期无效');
  return expires.getTime() > Date.now() ? expires.toISOString() : null;
}

export function purchaseLinks(data: any) {
  const link = (value: unknown) => {
    if (typeof value !== 'string') return undefined;
    const url = new URL(value);
    const alipay = url.hostname === 'alipay.com' || url.hostname.endsWith('.alipay.com');
    if (url.protocol === 'alipays:' || (url.protocol === 'https:' && alipay)) return value;
    throw new Error('支付服务返回了无效的付款地址');
  };
  const purchaseUrl = link(data.purchase_url);
  const qrCode = link(data.purchase_qr_code);
  if (!purchaseUrl && !qrCode) throw new Error('尚未获得付款地址，请稍后重试');
  return { purchaseUrl, qrCode };
}

/** Reads the provider's last verified status for one purchase. Never invents a status the provider did not return. */
export async function fetchTransaction(row: { purchaseIntent?: { user_id: string; idempotency_key: string } | null }): Promise<PaymentTransaction> {
  const intent = row.purchaseIntent;
  if (!intent) throw new Error('该记录是旧站或线下记录，没有一人付购买编号');
  const fetchedAt = new Date().toISOString();
  try {
    const data = await payRequest('/transactions/query', { user_id: intent.user_id, idempotency_key: intent.idempotency_key });
    if (data.user_id !== intent.user_id || data.idempotency_key !== intent.idempotency_key) throw new Error('支付服务返回了其他购买的记录');
    if (!['PAID', 'PENDING', 'REFUNDED', 'UNKNOWN'].includes(data.status)) throw new Error('支付服务返回了无法识别的状态');
    const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
    return { status: data.status, tradeNo: text(data.trade_no), checkedAt: text(data.checked_at), fetchedAt, source: text(data.status_source) };
  } catch (error) {
    // 404 means the service has no purchase under this user and key; any other failure is not an answer.
    if ((error as { code?: string }).code === 'NOT_FOUND') return { status: 'NOT_FOUND', tradeNo: null, checkedAt: null, fetchedAt, source: null };
    throw error;
  }
}
