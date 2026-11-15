'use client';

import { agentOf } from '@/lib/agents';
import { WORKFLOW_PHASES, type buildProjectWorkspace, type WorkspaceTab } from '@/lib/project-workspace';
import { DELIVERY_LABEL } from './DeliveryEvidence';

type Workspace = ReturnType<typeof buildProjectWorkspace>;
export function ProjectWorkflow({ workspace, needs, onNavigate }: {
  workspace: Workspace; needs?: string; onNavigate: (tab: WorkspaceTab, target: string) => void;
}) {
  const quoteStatus = workspace.handoffs.slice(2, 4).find(step => step.status !== 'done')?.status ?? 'done';
  const notes = {
    input: DELIVERY_LABEL[workspace.handoffs[0].status], design: DELIVERY_LABEL[workspace.handoffs[1].status],
    estimate: DELIVERY_LABEL[quoteStatus], review: workspace.ownerConfirmed ? '已有本轮确认' : workspace.readyForReview ? '待你确认' : '等待本轮交付',
    match: workspace.orderFlow !== 'ready' ? '订单信息待同步' : workspace.canChat ? '已选定公司' : workspace.orderPublished ? workspace.bidCount ? `${workspace.bidCount} 家已投标` : '等待真实投标' : '待确认与发布',
    communicate: workspace.canChat ? '已开放沟通' : '选定公司后开放', fulfil: workspace.signed ? '已有签约记录' : workspace.canChat ? '可进入工作台' : '待选定公司',
  };
  return <section className="project-workflow" aria-labelledby="project-workflow-title">
    <div className="workflow-heading"><div><span className="brief-eyebrow">ONE PROJECT · 一个项目，团队接力</span><h2 id="project-workflow-title">装修项目工作台</h2></div><span className="tag">当前 · {WORKFLOW_PHASES.find(p => p.key === workspace.current)?.label}</span></div>
    <ol className="workflow-journey" aria-label="装修全流程">
      {WORKFLOW_PHASES.map((phase, i) => <li key={phase.key}>
        <button type="button" aria-current={workspace.current === phase.key ? 'step' : undefined} onClick={() => onNavigate(phase.tab, phase.target)}>
          <span className="journey-number">{String(i + 1).padStart(2, '0')}</span><strong>{phase.label}</strong><small>{phase.owner}</small>
          <span className="journey-hint">{notes[phase.key]}</span>
        </button>
      </li>)}
    </ol>
    <div className="coordinator-card">
      <div className="record-mark lg" aria-hidden="true">调</div>
      <div className="coordinator-copy"><h3>小调 · 项目协同总览</h3><p role="status">{workspace.summary}</p><small>根据已保存的任务、成果和订单同步更新，关键决定由相关人员确认。</small></div>
      <button type="button" className="btn btn-primary workflow-primary" onClick={() => onNavigate(workspace.primary.tab, workspace.primary.target)}>{workspace.primary.label} →</button>
    </div>
    <div className="workspace-context" aria-label="实时岗位交接">
      <div>{workspace.handoffs.map(step => <p key={step.key}><strong>{agentOf(step.key).name} · {step.label}</strong><span className={step.status === 'done' ? 'tag tag-green' : 'tag'}>{DELIVERY_LABEL[step.status]}</span><span>{step.taskId === null ? '等待任务' : `${agentOf(step.fromAgent ?? 'orchestrator').name} → ${agentOf(step.key).name} · Task #${step.taskId}`}</span></p>)}</div>
      <button type="button" className="btn btn-ghost" onClick={() => onNavigate('records', 'workspace-records')}>展开岗位交接 →</button>
    </div>
    <details className="workflow-needs"><summary>本项目需求与协作目标</summary><p data-no-translate>{needs?.trim() || '尚未填写补充需求，请结合户型、风格和预算核对方案。'}</p><p>小测整理空间 → 小设形成方案 → 小算估算费用 → 小检核对交付 → 小桥辅助比较真实投标。小调汇总当前进度和待办。</p></details>
  </section>;
}

export function ProjectHandoffs({ workspace, onNavigate }: { workspace: Workspace; onNavigate: (tab: WorkspaceTab, target: string) => void }) {
  return <section className="panel project-handoffs" aria-labelledby="project-handoffs-title">
    <div className="delivery-heading"><div><h2 id="project-handoffs-title">岗位成果与真实交接</h2><p>按岗位展示最新任务。交接以已保存的任务记录为准，查看成果不会发起重跑。</p></div></div>
    <ol className="handoff-list">{workspace.handoffs.map(step => {
      const agent = agentOf(step.key);
      return <li key={step.key}>
        <div className="handoff-agent"><span className="record-mark" aria-hidden="true">{agent.name.slice(-1)}</span><h3>{agent.name} · {agent.role}</h3><span className={step.status === 'done' ? 'tag tag-green' : 'tag'}>{DELIVERY_LABEL[step.status]}</span></div>
        <dl><div><dt>输入</dt><dd>{step.input}</dd></div><div><dt>成果</dt><dd>{step.deliverable}</dd></div><div><dt>执行方式</dt><dd>{step.execution}</dd></div><div><dt>交接记录</dt><dd>{step.taskId === null ? '尚无任务，等待交接' : <>{agentOf(step.fromAgent ?? 'orchestrator').name} → {agent.name} · Task #{step.taskId}{step.nextTaskId !== null ? `；已建立后续 Task #${step.nextTaskId}` : '；后续交接或人工确认以实际记录为准'}</>}</dd></div></dl>
        <p>{step.nextAction}</p><button className="btn btn-ghost" type="button" onClick={() => onNavigate(step.tab, step.target)}>查看{step.label} →</button>
      </li>;
    })}</ol>
  </section>;
}

export function WorkspaceContext({ tab, workspace, onNavigate }: { tab: WorkspaceTab; workspace: Workspace; onNavigate: (tab: WorkspaceTab, target: string) => void }) {
  const steps = workspace.handoffs.filter(step => step.tab === tab);
  if (!steps.length) return null;
  return <div className="workspace-context"><div>{steps.map(step => <p key={step.key}><strong>{agentOf(step.key).name} · {step.label}</strong><span className="tag">{DELIVERY_LABEL[step.status]}</span><span>{step.nextAction}</span></p>)}</div><button type="button" className="btn btn-ghost" onClick={() => onNavigate('records', 'workspace-records')}>查看岗位交接 →</button></div>;
}
