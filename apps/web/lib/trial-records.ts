export interface TrialRecord {
  id: string; sample: string; kind: 'real' | 'synthetic'; role: string; systemSeconds: number;
  manualMinutes: number | null; modelCostCny: number | null; revisions: number;
  outcome: 'accepted' | 'rejected' | 'pending'; recordedAt: string;
}
export function validateTrial(input: unknown): TrialRecord {
  if (!input || typeof input !== 'object') throw Error('记录格式无效');
  const x = input as TrialRecord;
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (typeof x.id !== 'string' || !x.id || x.id.length > 80 || typeof x.sample !== 'string' || !x.sample.trim() || x.sample.length > 100
    || !['real', 'synthetic'].includes(x.kind) || !['floor_plan','designer','quote','qa','matcher'].includes(x.role)
    || !finite(x.systemSeconds) || x.systemSeconds <= 0 || x.systemSeconds > 86400
    || x.manualMinutes !== null && (!finite(x.manualMinutes) || x.manualMinutes <= 0 || x.manualMinutes > 10080)
    || x.modelCostCny !== null && (!finite(x.modelCostCny) || x.modelCostCny < 0 || x.modelCostCny > 100000)
    || !Number.isSafeInteger(x.revisions) || x.revisions < 0 || x.revisions > 10000
    || !['accepted','rejected','pending'].includes(x.outcome) || typeof x.recordedAt !== 'string' || !Number.isFinite(Date.parse(x.recordedAt))) throw Error('请检查样例编号、耗时、成本和验收结果；未知基线或成本请留空');
  return { id:x.id, sample:x.sample.trim(), kind:x.kind, role:x.role, systemSeconds:x.systemSeconds, manualMinutes:x.manualMinutes, modelCostCny:x.modelCostCny, revisions:x.revisions, outcome:x.outcome, recordedAt:x.recordedAt };
}
export function summarizeTrials(records: readonly TrialRecord[]) {
  const all=records.map(validateTrial), real=all.filter(x=>x.kind==='real');
  const times=real.map(x=>x.systemSeconds).sort((a,b)=>a-b), costs=real.filter(x=>x.modelCostCny!==null), paired=real.filter(x=>x.manualMinutes!==null), reviewed=real.filter(x=>x.outcome!=='pending');
  const baseline=paired.reduce((sum,x)=>sum+x.manualMinutes!*60,0), elapsed=paired.reduce((sum,x)=>sum+x.systemSeconds,0);
  return { realCount:real.length, syntheticCount:all.length-real.length,
    medianSeconds:times.length ? (times[Math.floor((times.length-1)/2)]+times[Math.floor(times.length/2)])/2 : null,
    costSampleCount:costs.length, meanCostCny:costs.length ? costs.reduce((sum,x)=>sum+x.modelCostCny!,0)/costs.length : null,
    pairedCount:paired.length, timeSavedPct:baseline>0 ? (baseline-elapsed)/baseline*100 : null,
    reviewedCount:reviewed.length, acceptanceRate:reviewed.length ? reviewed.filter(x=>x.outcome==='accepted').length/reviewed.length : null };
}
export function trialsCsv(records: readonly TrialRecord[]) {
  const escape=(value: unknown) => { const s=value===null?'':String(value); return '"'+(/^[\s]*[=+\-@]/.test(s)?"'"+s:s).replace(/"/g,'""')+'"'; };
  const rows=[['记录ID','样例编号','样本类型','岗位','系统耗时(秒)','人工基线(分钟)','手工记录调用成本(元)','人工修订次数','验收结果','记录时间'],
    ...records.map(validateTrial).map(x=>[x.id,x.sample,x.kind,x.role,x.systemSeconds,x.manualMinutes,x.modelCostCny,x.revisions,x.outcome,x.recordedAt])];
  return '\uFEFF'+rows.map(row=>row.map(escape).join(',')).join('\r\n');
}
