import type { DeliveryStage } from '@i-renovation/shared/delivery';

export type WorkspaceTab = 'input' | 'design' | 'quote' | 'match' | 'fulfil' | 'records';
export type WorkflowPhase = 'input' | 'design' | 'estimate' | 'review' | 'match' | 'communicate' | 'fulfil';
export interface WorkspaceTask {
  id: number; toAgent: string; fromAgent: string; status: string;
  output?: { ask?: string; exception?: { detail?: string; ruleName?: string } } | null;
}
interface WorkspaceInput {
  delivery: { readyForReview: boolean; stages: readonly DeliveryStage[] };
  tasks: readonly WorkspaceTask[];
  order: { id: number; companyId: number | null; status: string; contractedAt?: string | null } | null;
  bids: readonly { id: number }[];
  orderFlow: 'loading' | 'ready' | 'error';
  confirmedTaskId: number | null;
}
export const WORKSPACE_TABS: { key: WorkspaceTab; label: string }[] = [
  { key: 'input', label: '需求与户型' }, { key: 'design', label: '设计与 3D' },
  { key: 'quote', label: '报价与质检' }, { key: 'match', label: '匹配与沟通' },
  { key: 'fulfil', label: '签约与履约' }, { key: 'records', label: '岗位交接' },
];
export const WORKFLOW_PHASES: { key: WorkflowPhase; label: string; owner: string; tab: WorkspaceTab; target: string }[] = [
  { key: 'input', label: '需求与户型', owner: '小测', tab: 'input', target: 'workspace-input' },
  { key: 'design', label: '设计与 3D', owner: '小设', tab: 'design', target: 'workspace-design' },
  { key: 'estimate', label: '报价与质检', owner: '小算 · 小检', tab: 'quote', target: 'workspace-quote' },
  { key: 'review', label: '业主确认', owner: '由你决定', tab: 'quote', target: 'project-quote' },
  { key: 'match', label: '发布与匹配', owner: '小桥', tab: 'match', target: 'workspace-match' },
  { key: 'communicate', label: '双方沟通', owner: '业主 · 装修公司', tab: 'match', target: 'project-communication' },
  { key: 'fulfil', label: '签约与履约', owner: '双方确认', tab: 'fulfil', target: 'workspace-fulfil' },
];
const ROLE_CONTEXT: Record<string, { input: string; tab: WorkspaceTab; target: string; phase: WorkflowPhase }> = {
  floor_plan: { input: '项目需求与已保存的户型输入', tab: 'input', target: 'workspace-input', phase: 'input' },
  designer: { input: '户型空间、门窗信息与设计风格', tab: 'design', target: 'workspace-design', phase: 'design' },
  quote: { input: '户型工程量、设计方案与参考价格', tab: 'quote', target: 'project-quote', phase: 'estimate' },
  qa: { input: '本轮户型、设计、3D、效果图与报价', tab: 'quote', target: 'workspace-quote', phase: 'estimate' },
  matcher: { input: '已发布需求、装修公司的真实投标与资质', tab: 'match', target: 'workspace-match', phase: 'match' },
};

/** Read-only presentation model. Never runs agents or makes business decisions. */
export function buildProjectWorkspace(input: WorkspaceInput) {
  const latest = new Map<string, WorkspaceTask>();
  for (const task of input.tasks) if (task.id > (latest.get(task.toAgent)?.id ?? -1)) latest.set(task.toAgent, task);
  const selected = !!input.order && input.order.companyId !== null && !['open', 'bidding'].includes(input.order.status);
  const qaTaskId = input.delivery.stages.find(s => s.key === 'qa')?.taskId;
  const ownerConfirmed = input.delivery.readyForReview && qaTaskId != null && input.confirmedTaskId === qaTaskId;
  const matcher = latest.get('matcher');
  const currentTasks = [...latest.values()].filter(task => task.toAgent === 'matcher'
    ? input.delivery.readyForReview
    : input.delivery.stages.some(stage => stage.taskId === task.id && stage.status === task.status));
  const waitingTasks = currentTasks.filter(task => task.status === 'waiting_user');
  const escalatedTasks = currentTasks.filter(task => task.status === 'escalated');
  // Existing resume API resumes all waiting tasks. Avoid reviving superseded branches from this workspace.
  const canResume = waitingTasks.length > 0 && input.tasks.filter(task => task.status === 'waiting_user').every(task => waitingTasks.some(current => current.id === task.id));
  const handoffs = input.delivery.stages.map((stage, i) => {
    const task = latest.get(stage.key);
    const next = latest.get(input.delivery.stages[i + 1]?.key ?? 'matcher');
    return { ...stage, status: task?.status === 'cancelled' ? 'cancelled' as const : stage.status, ...ROLE_CONTEXT[stage.key], fromAgent: task?.fromAgent ?? null,
      nextTaskId: stage.status === 'done' && task && next && next.id > task.id && next.fromAgent === stage.key ? next.id : null };
  });
  handoffs.push({ key: 'matcher', label: '公司匹配', status: matcher?.status === 'done' ? 'done' : matcher?.status === 'failed' ? 'failed' : matcher?.status === 'running' ? 'running' : matcher?.status === 'waiting_user' ? 'waiting_user' : matcher?.status === 'escalated' ? 'escalated' : matcher?.status === 'cancelled' ? 'cancelled' : 'pending',
    taskId: matcher?.id ?? null, execution: '真实投标与资质规则；可选模型辅助比较', deliverable: '投标比较与匹配建议，由业主选择公司',
    nextAction: selected ? '已选定公司，可进入双方沟通' : '发布后等待真实投标，选定公司后开放沟通',
    ...ROLE_CONTEXT.matcher, fromAgent: matcher?.fromAgent ?? null, nextTaskId: null });
  const result = (current: WorkflowPhase, summary: string, label: string, tab: WorkspaceTab, target: string) => ({
    current, summary, primary: { label, tab, target }, handoffs, canChat: selected, waitingTasks, escalatedTasks, canResume,
    readyForReview: input.delivery.readyForReview, ownerConfirmed, orderPublished: !!input.order,
    bidCount: input.bids.length, orderFlow: input.orderFlow,
    signed: selected && !!(input.order?.contractedAt || input.order?.status === 'contracted'),
  });
  const incomplete = input.delivery.stages.find(s => s.status !== 'done');
  if (incomplete) {
    const role = ROLE_CONTEXT[incomplete.key];
    const task = latest.get(incomplete.key);
    const detail = task?.output?.ask || task?.output?.exception?.detail;
    const summary = task?.status === 'cancelled' ? `${incomplete.label}任务已停止，需要平台检查后重新安排。`
      : incomplete.status === 'pending' ? (task ? '任务已排队，等待前序交接或开始执行。' : '等待岗位任务开始；请先核对项目需求与户型资料。')
      : incomplete.status === 'running' ? `${incomplete.label}正在执行，成果保存后将由现有流程继续交接。`
      : incomplete.status === 'stale' ? `${incomplete.label}的输入或上游已更新，当前成果待重新交付。${incomplete.nextAction}`
      : `${incomplete.label}需要处理：${detail || incomplete.nextAction}`;
    return result(role.phase, summary, incomplete.status === 'running' || incomplete.status === 'pending' ? '查看当前任务' : '处理本轮待办', role.tab, role.target);
  }
  if (input.orderFlow !== 'ready') return result('match', input.orderFlow === 'error' ? '订单或投标信息读取失败，暂不判断发布和选择状态。' : '正在加载订单与投标信息，稍后更新下一步。', '查看订单状态', 'match', 'workspace-match');
  if (selected) {
    if (input.order!.contractedAt || input.order!.status === 'contracted') return result('fulfil', '订单已有签约记录，请在履约工作台查看实际合同与阶段状态。', '进入履约工作台', 'fulfil', 'workspace-fulfil');
    return result('communicate', '已选定装修公司，可以沟通材料、工期和施工细节；合同事项由双方正式确认。', '与选定公司沟通', 'match', 'project-communication');
  }
  if (input.order) {
    if (!input.bids.length) return result('match', '项目已发布，等待装修公司真实投标；收到投标后由小桥辅助比较。', '查看投标进度', 'match', 'workspace-match');
    if (matcher?.status === 'failed' || matcher?.status === 'escalated' || matcher?.status === 'waiting_user') return result('match', matcher.status === 'failed' ? '小桥匹配任务失败，请查看交接记录和现有投标，必要时由平台处理。' : '小桥匹配任务需要人工处理，请查看任务记录和现有投标。', '查看匹配与投标', 'match', 'workspace-match');
    return result('match', matcher?.status === 'running' || matcher?.status === 'pending' ? '小桥匹配任务正在处理真实投标；最终选择由你决定。' : `已收到 ${input.bids.length} 家公司的真实投标，请比较方案与报价后选择承接公司。`, '比较投标并选择公司', 'match', 'workspace-match');
  }
  if (ownerConfirmed) return result('match', '本轮方案已由业主确认，请查看发布状态；尚未发布时可从发布区继续。', '查看发布状态', 'match', 'workspace-match');
  return result('review', '本轮户型、设计、报价与质检成果已齐备，请你复核方案与价格后确认发布。', '复核并确认方案', 'quote', 'project-quote');
}
