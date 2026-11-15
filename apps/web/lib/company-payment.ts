import { getUser, setUserVerified, setCompanyMembership, getOrCreateOnlinePayment, observeOnlinePayments, expireOnlinePayment } from '@i-renovation/shared';
import { payRequest, entitlement, basicSku, purchaseLinks, membershipIdentity, membershipReturnUrl } from './opcpay';

export async function refreshCompanyMembership(companyId: number) {
  const company = await getUser(companyId);
  if (!company || company.role !== 'company') throw new Error('仅企业装修队可购买会员');
  if (company.demo === 1) return { active: true, expiresAt: company.membershipExpiresAt, demo: true };
  const data = await payRequest('/access', { user_id: membershipIdentity('company', companyId) });
  const expires = entitlement(data);
  await setCompanyMembership(companyId, {
    membershipTier: 'basic', membershipStatus: expires ? 'active' : 'pending_payment',
    membershipExpiresAt: expires || '', monthlyLeadQuota: 30,
  });
  if (expires) {
    await observeOnlinePayments(companyId, expires, membershipIdentity('company', companyId));
    // 用户决定（WORKFLOW.md 决策记录 2026-11-08）：付费确认即通过资质审核，不再人工逐个审核；
    // 老板驳回过的公司（verified = -1）不会因付费被重新放行
    if (company.verified === 0) await setUserVerified(companyId, 1);
  }
  return { active: !!expires, expiresAt: expires };
}

export async function companyCheckout(companyId: number) {
  if ((await getUser(companyId))?.demo === 1) throw new Error('演示账号不支持真实付款');
  const callbackUrl = membershipReturnUrl();
  const capabilities = await payRequest('/capabilities');
  if (capabilities.provider_configured !== true || capabilities.capabilities?.purchase_entry !== true || capabilities.capabilities?.entitlement_query !== true) {
    throw new Error('商户尚未开放会员购买或权益查询');
  }
  const sku = basicSku(await payRequest('/product'));
  const current = await refreshCompanyMembership(companyId);
  const payment = await getOrCreateOnlinePayment(companyId, current.expiresAt, {
    user_id: membershipIdentity('company', companyId), sku_id: sku, callback_url: callbackUrl,
    keyPrefix: membershipIdentity('membership', 0).slice(0, -1),
  });
  const body = payment.purchaseIntent;
  if (!body) throw new Error('购买记录尚未保存，请勿付款');
  let result;
  try {
    result = await payRequest('/purchase', body);
  } catch (error) {
    if ((error as { code?: string }).code === 'PURCHASE_ENTRY_EXPIRED') {
      await expireOnlinePayment(payment.id);
      throw new Error('原付款入口已失效，请重新点击购买');
    }
    throw error;
  }
  if (result.status !== 'READY' || result.idempotency_key !== body.idempotency_key) throw new Error('购买入口正在确认，请稍后重试；请勿重复付款');
  return { paymentId: payment.id, ...purchaseLinks(result) };
}
