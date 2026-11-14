import type { StagePlan } from '@i-renovation/shared/workflow';

export function parseYuan(value: string): number {
  const input = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(input)) throw new Error('请输入有效金额，最多两位小数');
  const [whole, fraction = ''] = input.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('金额超出支持范围');
  return Number(cents);
}

export function centsInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function money(cents: number): string {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2 }).format(cents / 100);
}

export function canActOnStage(status: string, allowedActions: string[], action: string): boolean {
  return status !== 'cancelled' && allowedActions.includes(action);
}

export function parseFeePercent(value: string): number {
  const bps = parseYuan(value);
  if (bps > 10000) throw new Error('服务费率须在 0% 至 100% 之间');
  return bps;
}

export type StageInput = Omit<StagePlan, 'amountCents'> & { amount: string };
export function stagesPayload(stages: StageInput[], totalCents: number): StagePlan[] {
  if (!stages.length || new Set(stages.map(s => s.id)).size !== stages.length) throw new Error('请保留至少一个阶段，且阶段编号不能重复');
  const result = stages.map(({ amount, ...s }) => {
    if (!s.name.trim() || !s.acceptanceCriteria.trim()) throw new Error('请填写每阶段名称与验收标准');
    const amountCents = parseYuan(amount);
    if (amountCents <= 0) throw new Error('每阶段金额必须大于零');
    return { ...s, amountCents };
  });
  if (result.reduce((sum, s) => sum + s.amountCents, 0) !== totalCents) throw new Error('分期金额合计必须等于合同总额');
  return result;
}
