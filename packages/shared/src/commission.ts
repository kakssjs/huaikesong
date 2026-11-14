export const CONTRACTOR_PROFIT_COMMISSION_RATE = 0.1;
export const CONTRACT_SERVICE_FEE_BPS = 300;

export interface CommissionQuote {
  revenueCny: number;
  estimatedCostCny: number;
  profitCny: number;
  commissionRate: number;
  platformCommissionCny: number;
  contractorNetProfitCny: number;
  basis: 'actual_profit' | 'estimated_cost' | 'gross_revenue';
  note: string;
}

export function wanToCny(wan: number | string): number {
  return Math.round((Number(String(wan).replace(/[^\d.]/g, '')) || 0) * 10000);
}

export function cnyToWan(cny: number): number {
  return Math.round((cny / 10000) * 100) / 100;
}

export function calculateContractorCommission(input: {
  amount: number | string;
  estimatedCost?: number | string | null;
  amountInWan?: boolean;
}): CommissionQuote {
  const revenueCny = input.amountInWan === false ? Math.round(Number(input.amount) || 0) : wanToCny(input.amount);
  const hasCost = input.estimatedCost !== undefined && input.estimatedCost !== null && String(input.estimatedCost).trim() !== '';
  const estimatedCostCny = hasCost
    ? (input.amountInWan === false ? Math.round(Number(input.estimatedCost) || 0) : wanToCny(input.estimatedCost!))
    : 0;
  const profitCny = hasCost ? Math.max(0, revenueCny - estimatedCostCny) : revenueCny;
  const platformCommissionCny = Math.round(profitCny * CONTRACTOR_PROFIT_COMMISSION_RATE);
  return {
    revenueCny,
    estimatedCostCny,
    profitCny,
    commissionRate: CONTRACTOR_PROFIT_COMMISSION_RATE,
    platformCommissionCny,
    contractorNetProfitCny: Math.max(0, profitCny - platformCommissionCny),
    basis: hasCost ? 'estimated_cost' : 'gross_revenue',
    note: hasCost
      ? '平台按装修队预计利润的 10% 收取服务费；项目结算时可按实际成本与利润复核。'
      : '未填写预计成本，暂按成交金额估算利润并收取 10% 平台服务费。',
  };
}

export function commissionLabel(quote: CommissionQuote) {
  return `利润 ¥${quote.profitCny.toLocaleString()} · 平台 10% ¥${quote.platformCommissionCny.toLocaleString()} · 装修队净利 ¥${quote.contractorNetProfitCny.toLocaleString()}`;
}

/** New bids only: advisory service-fee estimate. Actual demo fees arise solely from successful stage releases. */
export function estimateContractServiceFee(input: {amount:number|string;estimatedCost?:number|string|null;amountInWan?:boolean;feeBps?:number}):CommissionQuote {
  const multiplier=input.amountInWan===false?100:1_000_000;
  const revenueCents=Math.round(Number(input.amount)*multiplier), feeBps=input.feeBps??CONTRACT_SERVICE_FEE_BPS;
  const hasCost=input.estimatedCost!==undefined&&input.estimatedCost!==null&&String(input.estimatedCost).trim()!=='';
  const costCents=hasCost?Math.round(Number(input.estimatedCost)*multiplier):0;
  if(!Number.isSafeInteger(revenueCents)||revenueCents<=0||!Number.isSafeInteger(costCents)||costCents<0||!Number.isSafeInteger(feeBps)||feeBps<0||feeBps>10000)throw new Error('服务费预估金额或费率无效');
  const feeCents=Math.round(revenueCents*feeBps/10000),profitCents=Math.max(0,revenueCents-costCents);
  return {revenueCny:revenueCents/100,estimatedCostCny:costCents/100,profitCny:profitCents/100,commissionRate:feeBps/10000,
    platformCommissionCny:feeCents/100,contractorNetProfitCny:Math.max(0,profitCents-feeCents)/100,basis:'gross_revenue',
    note:`平台履约服务费预估：成交金额的${feeBps/100}%，由乙方承担；本次未收费，以合同约定及成功阶段结算为准。`};
}
