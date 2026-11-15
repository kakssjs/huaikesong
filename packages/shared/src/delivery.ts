// Read-only delivery evidence. Task IDs describe execution order; old results do not prove a new run succeeded.
export interface DeliveryTask {
  id: number; toAgent: string; fromAgent?: string; status: string;
  createdAt?: string; updatedAt?: string; tokensCost?: number; output?: unknown;
}
export interface DeliveryArtifact { id?: number; kind: string; content: unknown; createdAt?: string }
export interface DeliveryProject { id: number; name: string; style: string; area?: string | null; budget: string }
export type DeliveryStatus = 'pending' | 'running' | 'done' | 'failed' | 'waiting_user' | 'escalated' | 'stale' | 'partial' | 'blocked';
export interface DeliveryStage {
  key: string; label: string; status: DeliveryStatus; taskId: number | null;
  execution: string; deliverable: string; nextAction: string;
}
const CORE = [
  { key: 'floor_plan', label: '户型识别', deliverable: '房间面积、空间数据与识别来源' },
  { key: 'designer', label: '方案设计', deliverable: '二维方案、同源 3D 与房间效果图' },
  { key: 'quote', label: '报价与工期', deliverable: '有依据的费用明细与工期估算' },
  { key: 'qa', label: '交付质检', deliverable: '规则检查结果与人工复核事项' },
] as const;
const ALLOWED = ['plan', 'design', 'scene_model', 'decorations', 'quote', 'qa'];
const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export function isAdvisoryLayoutWarning(detail: unknown): boolean {
  return typeof detail === 'string' && detail.split('；').every(text => /^房间「[^」]+」过窄（[^）]+），尺寸以现场量房为准$/.test(text));
}

export function buildDeliveryReport(input: { project: DeliveryProject; tasks: readonly DeliveryTask[]; results: readonly DeliveryArtifact[] }) {
  const latest = new Map<string, DeliveryTask>();
  for (const task of input.tasks) if (task.id > (latest.get(task.toAgent)?.id ?? -1)) latest.set(task.toAgent, task);
  const byKind = new Map<string, DeliveryArtifact>();
  for (const result of input.results) {
    if ([...ALLOWED, 'floorplan'].includes(result.kind) && (!byKind.has(result.kind) || (result.id ?? 0) > (byKind.get(result.kind)?.id ?? 0))) byKind.set(result.kind, result);
  }
  const content = (kind: string) => obj(byKind.get(kind)?.content);
  const plan = content('plan');
  const quote = content('quote');
  const images = arr(content('decorations').images);
  const rooms = arr(plan.rooms);
  const qa = content('qa');
  const qaChecks = arr(qa.checks).map(obj);
  const advisoryOnly = qa.passed === true && qaChecks.length > 0 && qaChecks.every(c => c.ok === true || (c.ok === false && c.level === 'warn' && c.rule === 'low_confidence_floorplan' && isAdvisoryLayoutWarning(c.detail)));
  const quoteItems = arr(quote.items);
  const quoteTotal = Number(quote.total);
  const schedule = arr(quote.schedule);
  const validQuote = quoteItems.length > 0 && Number.isFinite(quoteTotal) && quoteTotal > 0
    && quoteItems.every(i => {
      const { qty, price, total } = obj(i);
      return typeof qty === 'number' && Number.isFinite(qty) && qty > 0
        && typeof price === 'number' && Number.isFinite(price) && price >= 0
        && typeof total === 'number' && Number.isFinite(total) && total >= 0 && Math.round(qty * price) === total;
    })
    && Math.abs(quoteItems.reduce<number>((s, i) => s + Number(obj(i).total), 0) - quoteTotal) <= 1
    && Number.isInteger(quote.weeks) && Number(quote.weeks) > 0 && schedule.length > 0
    && schedule.every(p => Number.isInteger(obj(p).weeks) && Number(obj(p).weeks) > 0)
    && schedule.reduce<number>((sum, p) => sum + Number(obj(p).weeks), 0) === quote.weeks;
  const imagesComplete = rooms.length > 0 && images.length === rooms.length
    && images.every(i => typeof obj(i).url === 'string' && !!obj(i).url || typeof obj(i).b64 === 'string' && !!obj(i).b64)
    && !content('decorations').degraded;
  const evidence: Record<string, boolean> = {
    floor_plan: rooms.length > 0 && rooms.every(r => Number(obj(r).area) > 0 && typeof obj(r).name === 'string'),
    designer: typeof content('design').svg === 'string' && !!content('design').svg && !!content('scene_model').schema && imagesComplete,
    quote: validQuote,
    qa: qa.passed === true && (!qa.degraded || advisoryOnly),
  };
  const execution: Record<string, string> = {
    floor_plan: plan.source === 'llm' || plan.source === 'mimo' ? '模型识别 + 程序化几何换算' : plan.source === 'user_studio' ? '人工标注 + 程序化几何换算' : '来源未记录，需核对',
    designer: '程序化二维与同源 3D；效果图调用图像模型',
    quote: '参考价格与工程量规则计算，非独立模型推理',
    qa: '程序化规则质检，非现场施工验收',
  };
  const stages: DeliveryStage[] = [];
  const required: Record<string, string[]> = { floor_plan: ['plan'], designer: ['design', 'scene_model', 'decorations'], quote: ['quote'], qa: ['qa'] };
  const dependencies: Record<string, string[]> = { floor_plan: ['floorplan'], designer: ['plan'], quote: ['plan', 'design'], qa: ['plan', 'design', 'scene_model', 'decorations', 'quote'] };
  let newestUpstreamId = -1;
  for (const step of CORE) {
    const task = latest.get(step.key);
    const taskTime = Date.parse(task?.createdAt ?? '');
    const oldArtifact = required[step.key].some(kind => {
      const time = Date.parse(byKind.get(kind)?.createdAt ?? '');
      return Number.isFinite(taskTime) && Number.isFinite(time) && time < taskTime;
    });
    const ownTimes = required[step.key].map(kind => Date.parse(byKind.get(kind)?.createdAt ?? '')).filter(Number.isFinite);
    const dependencyChanged = ownTimes.length > 0 && dependencies[step.key].some(kind => {
      const time = Date.parse(byKind.get(kind)?.createdAt ?? '');
      return Number.isFinite(time) && time > Math.min(...ownTimes);
    });
    let status: DeliveryStatus = task && ['pending', 'running', 'done', 'failed', 'waiting_user', 'escalated'].includes(task.status) ? task.status as DeliveryStatus : 'pending';
    let nextAction = status === 'running' ? '正在执行，请等待结果' : status === 'waiting_user' ? '在项目页补充资料后继续' : status === 'escalated' ? '等待平台人工处理' : status === 'failed' ? '检查失败任务并重试' : status === 'pending' ? '等待前序交接或开始执行' : '交付物待人工复核';
    if (task && task.id < newestUpstreamId) {
      status = 'stale'; nextAction = '上游已重新执行，当前为旧成果，请等待本轮重新交付';
    } else if (task?.status === 'done' && dependencyChanged) {
      status = 'stale'; nextAction = '输入或依赖成果已更新，请重新执行本环节并复核';
    } else if (task?.status === 'done' && (!evidence[step.key] || oldArtifact || (obj(task.output).degraded && !(step.key === 'qa' && advisoryOnly)) || obj(task.output).fallback || obj(task.output).exception)) {
      status = 'partial';
      nextAction = oldArtifact ? '当前产物早于本轮任务，请重新生成并复核' : step.key === 'designer' && !imagesComplete ? '效果图未完整交付，请补生成并复核' : step.key === 'qa' ? '质检未通过或结果缺失，请修正后重新检查' : '交付物缺失、数字不一致或发生降级，请复核后重试';
    } else if (status === 'done' && stages.some(s => s.status !== 'done')) {
      status = 'blocked'; nextAction = '前序成果尚未完整交付，请先处理前序问题';
    }
    if (status === 'done') nextAction = '本岗位已完成，无需单独审批';
    if (step.key === 'qa' && ['partial', 'waiting_user', 'escalated', 'failed'].includes(status) && typeof content('qa').note === 'string') nextAction = String(content('qa').note);
    stages.push({ ...step, taskId: task?.id ?? null, status, execution: execution[step.key], nextAction });
    newestUpstreamId = Math.max(newestUpstreamId, task?.id ?? -1);
  }
  const { id, name, style, area, budget } = input.project;
  return {
    schema: 'yushe.delivery.v1', generatedAt: new Date().toISOString(),
    project: { id, name, style, area, budget },
    readyForReview: stages.every(s => s.status === 'done'),
    completedStages: stages.filter(s => s.status === 'done').length,
    stages,
    tasks: [...latest.values()].map(t => ({ id: t.id, fromAgent: t.fromAgent, toAgent: t.toAgent, status: t.status, createdAt: t.createdAt, updatedAt: t.updatedAt })),
    artifacts: [...byKind.values()].filter(a => ALLOWED.includes(a.kind)).map(a => ({ kind: a.kind, createdAt: a.createdAt, content: a.content })),
    boundary: '本报告整理已保存的任务和成果，不发起模型调用；可复核不等于人工已接受、施工验收通过或完成签约。原始图片和成果可能包含用户资料，请由业主决定分享范围。',
  };
}
