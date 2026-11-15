'use client';
import { useCallback, useEffect, useState } from 'react';
import ContractWorkbenchDialog from '../components/ContractWorkbenchDialog';
import { paymentStatusLabel, refundStatusText, type LedgerRow, type LedgerSummary } from '@/lib/payment-labels';

interface TaskRecord {
  id: number; projectId: number; projectName: string;
  fromAgent: string; toAgent: string; status: string;
  retry: number; tokensCost: number; createdAt: string; updatedAt: string;
}
interface Approval {
  id: string; type: string; level: '高' | '中' | '低'; subject: string; detail: string; action: string;
}
interface OrderRecord {
  id: number; projectId: number; projectName: string; status: string;
  bidAmount: string | null; bidWeeks: string | null; matchScore: string | null;
  createdAt: string; contractedAt: string | null;
}
interface CommissionSettlement {
  id: number; orderId: number; bidId: number; companyId: number; companyName: string;
  revenueCny: number; estimatedCostCny: number; profitCny: number; commissionRatePct: number;
  platformCommissionCny: number; contractorNetProfitCny: number; status: string; createdAt: string; settledAt?: string | null;
}
interface MembershipPayment {
  id: number; companyId: number; companyName: string; tier: string; billingCycle?: string; periodMonths?: number; amountCny: number;
  status: string; paymentReference?: string | null; createdAt: string; paidAt?: string | null;
}
interface BossData {
  projects: { id: number; name: string; style: string; budget: string; area: string | null; stage: number; createdAt: string }[];
  tasks: TaskRecord[];
  costs: {
    totalTokens: number; taskCount: number; doneCount: number; failedCount: number; imageCount: number;
    byAgent: { agent: string; tokens: number; count: number; failed: number }[];
  };
  orders: OrderRecord[];
  approvals: Approval[];
  membershipPayments?: MembershipPayment[];
  commissionSettlements?: CommissionSettlement[];
}

const AGENT_LABEL: Record<string, string> = {
  floor_plan: '户型识别', designer: '二维设计', render: '3D渲染', quote: '报价工期',
  matcher: '装修队匹配', growth: '增长获客', consultant: '顾问客服', qa: '质检', orchestrator: '调度器',
};

function statusTag(status: string) {
  const map: Record<string, { text: string; cls: string }> = {
    done: { text: '已完成', cls: 'tag tag-green' },
    running: { text: '执行中', cls: 'tag tag-cyan' },
    pending: { text: '排队中', cls: 'tag tag-purple' },
    failed: { text: '失败', cls: 'tag tag-orange' },
    escalated: { text: '已升级', cls: 'tag tag-orange' },
    waiting_user: { text: '待用户补充', cls: 'tag tag-orange' },
    open: { text: '开放竞标', cls: 'tag tag-cyan' },
    matched: { text: '已选定', cls: 'tag tag-purple' },
    confirmed: { text: '双方确认', cls: 'tag tag-green' },
    contracted: { text: '已签约', cls: 'tag tag-green' },
    homeowner_confirmed: { text: '业主已确认', cls: 'tag tag-orange' },
    company_confirmed: { text: '公司已确认', cls: 'tag tag-orange' },
  };
  const m = map[status];
  return <span className={m ? m.cls : 'tag tag-cyan'}>{m ? m.text : status}</span>;
}

function levelTag(level: string) {
  if (level === '高') return <span className="tag tag-orange">高</span>;
  if (level === '中') return <span className="tag tag-cyan">中</span>;
  return <span className="tag tag-green">低</span>;
}

type BossUser = { id: number; role: string; name: string; phone: string | null; email: string | null; companyName: string | null; createdAt: string; projectCount: number };

export default function BossConsole() {
  const [tab, setTab] = useState<'approvals' | 'tasks' | 'costs' | 'orders' | 'membership' | 'commissions' | 'users'>('approvals');
  const [userRows, setUserRows] = useState<BossUser[] | null>(null);
  const [userMsg, setUserMsg] = useState('');
  const [confirmUser, setConfirmUser] = useState<number | null>(null);
  const [userBusy, setUserBusy] = useState<number | null>(null);

  const loadUsers = useCallback(async () => {
    const res = await fetch('/api/boss/users');
    if (res.ok) setUserRows(await res.json()); else setUserMsg('读取用户列表失败');
  }, []);
  useEffect(() => { if (tab === 'users') loadUsers(); }, [tab, loadUsers]);

  type ProviderFlags = { refund: boolean; bills: boolean; transactionList: boolean; transactionQuery: boolean } | null;
  const [ledger, setLedger] = useState<{ rows: LedgerRow[]; summary: LedgerSummary; provider: ProviderFlags; refreshFailed: number[] } | null>(null);
  const [ledgerMsg, setLedgerMsg] = useState('');
  const [ledgerBusy, setLedgerBusy] = useState(false);
  const [decideFor, setDecideFor] = useState<{ id: number; action: 'approve' | 'reject' } | null>(null);
  const [decideNote, setDecideNote] = useState('');

  const loadLedger = useCallback(async () => {
    setLedgerBusy(true);
    try {
      const res = await fetch('/api/boss/payments', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) { setLedgerMsg(body.error ?? '读取账单失败'); return; }
      setLedger(body); setLedgerMsg('');
    } catch { setLedgerMsg('读取账单失败，请稍后重试'); }
    finally { setLedgerBusy(false); }
  }, []);
  useEffect(() => { if (tab === 'membership') void loadLedger(); }, [tab, loadLedger]);

  async function decideRefund() {
    if (!decideFor) return;
    setLedgerBusy(true);
    try {
      const res = await fetch('/api/boss/payments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentId: decideFor.id, action: decideFor.action, note: decideNote }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setLedgerMsg(body.error ?? '处理失败'); return; }
      setDecideFor(null); setDecideNote('');
      setLedgerMsg(decideFor.action === 'approve' ? '已记录同意。请在支付宝侧完成退款，到账后此处会随支付服务状态变为“已退款”' : '已驳回该退款申请');
      await loadLedger();
    } catch { setLedgerMsg('处理失败，请稍后重试'); }
    finally { setLedgerBusy(false); }
  }

  async function removeUser(id: number) {
    setUserBusy(id); setUserMsg('');
    try {
      const res = await fetch(`/api/boss/users?id=${id}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setUserMsg(body.error ?? '注销失败，请稍后重试'); return; }
      setUserMsg('已注销该用户');
      setConfirmUser(null);
      await loadUsers();
    } finally { setUserBusy(null); }
  }
  const [workflowMode, setWorkflowMode] = useState<'demo' | 'real' | undefined>(undefined);
  const [workflowOrder, setWorkflowOrder] = useState<number | null>(null);
  const [data, setData] = useState<BossData | null>(null);
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const [filterAgent, setFilterAgent] = useState<string>('all');
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const load = () => fetch('/api/boss').then(async r => {
      // 未登录或不是老板账号：停止轮询，显示提示
      if (r.status === 401 || r.status === 403) { setDenied(true); clearInterval(timer); return; }
      setData(await r.json());
    }).catch(() => {});
    load();
    timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, []);

  async function decideApproval(item: Approval, action: 'approve' | 'reject') {
    setApprovalBusy(item.id);
    try {
      const [kind, id] = item.id.split('_');
      const response = await fetch(kind === 'user' ? `/api/users/${id}/verify` : '/api/boss', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(kind === 'user' ? { action } : { taskId: Number(id), action: action === 'approve' ? 'retry' : 'dismiss' }),
      });
      if (!response.ok) throw new Error((await response.json()).error || '裁决失败');
      const refreshed = await fetch('/api/boss');
      if (!refreshed.ok) throw new Error('裁决已提交，列表刷新失败，请刷新页面');
      setData(await refreshed.json());
    } catch (error) { window.alert(error instanceof Error ? error.message : '裁决失败'); }
    finally { setApprovalBusy(null); }
  }

  const costs = data?.costs;
  const maxTokens = Math.max(1, ...(costs?.byAgent.map(a => a.tokens) ?? [1]));
  const agents = [...new Set((data?.tasks ?? []).map(t => t.toAgent))];
  const visibleTasks = (data?.tasks ?? [])
    .filter(t => filterAgent === 'all' || t.toAgent === filterAgent)
    .slice()
    .reverse();

  if (denied) {
    return (
      <main className="container" style={{ paddingTop: 32 }}>
        <div className="panel" style={{ maxWidth: 520, margin: '48px auto', textAlign: 'center' }}>
          <div className="panel-title"><div className="accent-bar" />仅限老板账号</div>
          <p style={{ color: 'var(--text-dim)', fontSize: 13, margin: '18px 0 22px' }}>
            请用老板账号登录后查看控制台。
          </p>
          <a href="/" className="btn btn-primary">返回首页登录</a>
        </div>
      </main>
    );
  }

  return (
    <main className="container" style={{ paddingTop: 32 }}>
      <div className="section-label" style={{ marginTop: 0 }}>
        <h2>经营与交付中心</h2>
        <div className="line" />
        <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
          经营概览
        </span>
      </div>

      <div className="stats-row" style={{ marginTop: 20, marginBottom: 20 }}>
        <div className="stat-card">
          <div className="label">待处理</div>
          <div className="value orange">{data?.approvals.length ?? '-'}</div>
        </div>
        <div className="stat-card">
          <div className="label">活跃项目</div>
          <div className="value cyan">{data?.projects.length ?? '-'}</div>
        </div>
        <div className="stat-card">
          <div className="label">模型调用成本</div>
          <div className="value purple">{(costs?.totalTokens ?? 0).toLocaleString()}</div>
        </div>
        <div className="stat-card">
          <div className="label">视觉方案</div>
          <div className="value green">{costs?.imageCount ?? '-'}</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap' }}>
        {([
          { key: 'approvals', label: '待处理事项' },
          { key: 'tasks', label: '执行进度' },
          { key: 'costs', label: '成本概览' },
          { key: 'orders', label: '合同与履约' },
          { key: 'membership', label: '会员与入驻' },
          { key: 'commissions', label: '历史利润分成（只读）' },
          { key: 'users', label: '用户管理' },
        ] as const).map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={tab === t.key ? 'btn btn-primary' : 'btn btn-ghost'}
            style={{ fontSize: 13 }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ---------- 审批队列 ---------- */}
      {tab === 'approvals' && (
        <>
          <p style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 16 }}>
            付款、合同、资质认证与安全承诺均由负责人确认，以下事项需要人工处理
          </p>
          {(data?.approvals ?? []).length === 0 && (
            <div className="panel" style={{ padding: 24, textAlign: 'center', color: 'var(--text-dim)', fontSize: 13 }}>
              暂无待处理事项
            </div>
          )}
          {(data?.approvals ?? []).map(item => (
            <div key={item.id} className="timeline-item">
              <div className="timeline-dot" />
              <div className="timeline-body" style={{ width: '100%' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
                  <span className="tag tag-purple">{item.type}</span>
                  <strong style={{ fontSize: 14 }}>{item.subject}</strong>
                  {levelTag(item.level)}
                </div>
                <p style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 10 }}>{item.detail}</p>
                {item.id.startsWith('contract_') ? <button className="btn btn-primary" onClick={() => { setWorkflowMode(item.id.split('_')[2] === 'demo' ? 'demo' : 'real'); setWorkflowOrder(Number(item.id.split('_')[1])); }}>打开合同履约</button>
                  : item.id.startsWith('order_') ? <button className="btn" onClick={() => setTab('orders')}>查看订单跟进</button> : (
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button className="btn btn-primary" disabled={approvalBusy !== null} onClick={() => void decideApproval(item, 'approve')}>
                      {item.id.startsWith('user_') ? '通过资质审核' : '重试任务'}
                    </button>
                    <button className="btn btn-ghost" disabled={approvalBusy !== null} onClick={() => void decideApproval(item, 'reject')}>
                      {item.id.startsWith('user_') ? '驳回资质' : '终止本次任务'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </>
      )}

      {/* ---------- 任务记录 ---------- */}
      {tab === 'tasks' && (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>Agent：</span>
            <button onClick={() => setFilterAgent('all')}
              className={`btn ${filterAgent === 'all' ? 'btn-primary' : 'btn-ghost'}`} style={{ fontSize: 11, padding: '3px 10px' }}>全部</button>
            {agents.map(a => (
              <button key={a} onClick={() => setFilterAgent(a)}
                className={`btn ${filterAgent === a ? 'btn-primary' : 'btn-ghost'}`} style={{ fontSize: 11, padding: '3px 10px' }}>
                {AGENT_LABEL[a] ?? a}
              </button>
            ))}
          </div>
          <div className="panel">
            <div className="wf-table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>Task</th><th>项目</th><th>交接</th><th>状态</th><th>重试</th><th>Tokens</th><th>时间</th></tr>
              </thead>
              <tbody>
                {visibleTasks.map(t => (
                  <tr key={t.id}>
                    <td style={{ fontFamily: 'var(--font-mono)' }}>#{t.id}</td>
                    <td>{t.projectName}</td>
                    <td style={{ fontSize: 12 }}>
                      {AGENT_LABEL[t.fromAgent] ?? t.fromAgent} → {AGENT_LABEL[t.toAgent] ?? t.toAgent}
                    </td>
                    <td>{statusTag(t.status)}</td>
                    <td>{t.retry}</td>
                    <td>{t.tokensCost ? t.tokensCost.toLocaleString() : '-'}</td>
                    <td style={{ fontSize: 11, color: 'var(--text-dim)' }}>{t.updatedAt.slice(5, 19).replace('T', ' ')}</td>
                  </tr>
                ))}
                {visibleTasks.length === 0 && (
                  <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 20 }}>暂无任务记录</td></tr>
                )}
              </tbody>
            </table>
            </div>
          </div>
        </>
      )}

      {/* ---------- 成本看板 ---------- */}
      {tab === 'costs' && (
        <>
          <div className="stats-row" style={{ marginBottom: 18 }}>
            <div className="stat-card">
              <div className="label">任务总数</div>
              <div className="value cyan">{costs?.taskCount ?? '-'}</div>
            </div>
            <div className="stat-card">
              <div className="label">完成 / 失败</div>
              <div className="value green">{costs?.doneCount ?? 0} / {costs?.failedCount ?? 0}</div>
            </div>
            <div className="stat-card">
              <div className="label">任务 Token 合计</div>
              <div className="value purple">{(costs?.totalTokens ?? 0).toLocaleString()}</div>
            </div>
            <div className="stat-card">
              <div className="label">图像调用</div>
              <div className="value orange">{costs?.imageCount ?? 0}</div>
            </div>
          </div>
          <div className="panel">
            <div className="panel-title">
              <div className="accent-bar" />
              模型调用成本 · 按执行环节
              <small>单位经济核算（方案 §3.3）</small>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
              {(costs?.byAgent ?? []).map(a => (
                <div key={a.agent}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                    <span>{AGENT_LABEL[a.agent] ?? a.agent} <span style={{ color: 'var(--text-dim)' }}>({a.count} 任务{a.failed ? ` · 失败 ${a.failed}` : ''})</span></span>
                    <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>{a.tokens.toLocaleString()}</span>
                  </div>
                  <div style={{ height: 8, borderRadius: 4, background: 'var(--accent-soft)', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', borderRadius: 4,
                      width: `${Math.max(2, (a.tokens / maxTokens) * 100)}%`,
                      background: 'linear-gradient(90deg, var(--accent), var(--accent3))',
                    }} />
                  </div>
                </div>
              ))}
              {(costs?.byAgent ?? []).length === 0 && (
                <p style={{ color: 'var(--text-dim)', fontSize: 13, textAlign: 'center', padding: 16 }}>暂无成本数据</p>
              )}
            </div>
            <p style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 14 }}>
              此处统计任务内 Token 和当前保存的效果图，不含手动生成、改图等全部调用；实际费用以模型服务商账单为准。
            </p>
          </div>
        </>
      )}

      {/* ---------- 入驻费 / 会员 ---------- */}
      {tab === 'membership' && (
        <>
          <p style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 14 }}>
            企业会员为独立客户资源服务，会员收款与合同工程款、履约服务费分别记录；权益以支付服务查询确认为准。
          </p>
          <div className="panel">
            <div className="wf-table-wrap">
            <table className="data-table">
              <thead><tr><th>公司</th><th>套餐</th><th>付费周期</th><th>入驻费</th><th>支付凭证</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>
                {(data?.membershipPayments ?? []).map(p => (
                  <tr key={p.id}>
                    <td>{p.companyName}</td>
                    <td>{p.tier}</td>
                    <td>{p.billingCycle === 'monthly' ? '按月' : p.billingCycle === 'quarterly' ? '按季' : '按年'}</td>
                    <td>¥{p.amountCny.toLocaleString()}</td>
                    <td>{p.paymentReference?.startsWith('opcpay:') ? '支付宝购买入口' : p.paymentReference || '-'}</td>
                    <td>{statusTag(p.status)}</td>
                    <td>
                      <span className="tag">{p.status === 'entitlement_confirmed' ? '权益已确认（非收款回执）' : p.status === 'paid' ? '历史已收款' : '由支付宝权益查询确认'}</span>
                    </td>
                  </tr>
                ))}
                {(data?.membershipPayments ?? []).length === 0 && (
                  <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 20 }}>暂无入驻费支付记录</td></tr>
                )}
              </tbody>
            </table>
            </div>
          </div>

          <div className="panel" style={{ marginTop: 16 }}>
            <div className="panel-title"><div className="accent-bar" />付款账单与退款<button className="btn btn-sm" style={{ marginLeft: 12 }} disabled={ledgerBusy} onClick={() => void loadLedger()}>刷新账单</button></div>
            {ledgerMsg && <p role="status" style={{ fontSize: 13 }}>{ledgerMsg}</p>}
            {ledger && (
              <>
                <div className="notice" style={{ marginBottom: 12, fontSize: 12 }}>
                  一人付接口目前：
                  {ledger.provider
                    ? <>单笔交易查询{ledger.provider.transactionQuery ? '可用' : '未开放'}；退款{ledger.provider.refund ? '已开放' : '未开放'}；官方对账账单{ledger.provider.bills ? '已开放' : '未开放'}；交易列表{ledger.provider.transactionList ? '已开放' : '未开放'}。</>
                    : <>暂时无法确认接口开放情况。</>}
                  本页账单由本站购买记录加单笔状态核验生成，不是支付宝官方对账单；平台同意退款只记录决定，退款是否完成以一人付返回“已退款”为准。
                </div>
                <div className="stat-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginBottom: 12 }}>
                  <div className="stat-card"><div className="label">已支付</div><div className="value green">{ledger.summary.paidCount} 笔 · ¥{ledger.summary.paidCny}</div></div>
                  <div className="stat-card"><div className="label">已退款</div><div className="value purple">{ledger.summary.refundedCount} 笔 · ¥{ledger.summary.refundedCny}</div></div>
                  <div className="stat-card"><div className="label">待支付 / 待确认</div><div className="value cyan">{ledger.summary.pendingCount} / {ledger.summary.unknownCount}</div></div>
                  <div className="stat-card"><div className="label">待处理退款</div><div className="value orange">{ledger.summary.refundRequested}</div></div>
                  <div className="stat-card"><div className="label">已同意待到账</div><div className="value orange">{ledger.summary.refundApproved}</div></div>
                </div>
                {ledger.refreshFailed.length > 0 && <p className="notice notice-warn">部分记录暂时无法向支付服务刷新，显示的是上次读取的结果。</p>}
                <div className="wf-table-wrap">
                  <table className="data-table">
                    <thead><tr><th>单号</th><th>公司</th><th>创建时间</th><th>金额</th><th>付款状态</th><th>最近核验</th><th>支付宝订单号</th><th>退款</th><th>操作</th></tr></thead>
                    <tbody>
                      {ledger.rows.map(r => (
                        <tr key={r.id}>
                          <td>{r.id}</td>
                          <td>{r.companyName}</td>
                          <td>{r.createdAt.slice(0, 16).replace('T', ' ')}</td>
                          <td>¥{r.amountCny}</td>
                          <td><span className={paymentStatusLabel(r).cls}>{paymentStatusLabel(r).text}</span></td>
                          <td>{r.payment?.checkedAt ? r.payment.checkedAt.slice(0, 16).replace('T', ' ') : '-'}</td>
                          <td>{r.payment?.tradeNo ?? '-'}</td>
                          <td>
                            {refundStatusText(r.refund)}
                            {r.refund?.reason ? <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>原因：{r.refund.reason}</div> : null}
                            {r.refund?.decisionNote ? <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>意见：{r.refund.decisionNote}</div> : null}
                          </td>
                          <td>
                            {r.refund?.status === 'requested' && (
                              <>
                                <button className="btn btn-sm btn-primary" disabled={ledgerBusy} onClick={() => { setDecideFor({ id: r.id, action: 'approve' }); setDecideNote(''); }}>同意</button>
                                <button className="btn btn-sm btn-danger" style={{ marginLeft: 6 }} disabled={ledgerBusy} onClick={() => { setDecideFor({ id: r.id, action: 'reject' }); setDecideNote(''); }}>驳回</button>
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                      {ledger.rows.length === 0 && <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 20 }}>暂无付款记录</td></tr>}
                    </tbody>
                  </table>
                </div>
                {decideFor && (
                  <div style={{ marginTop: 12 }}>
                    <label htmlFor="refund-note" style={{ fontSize: 13 }}>单号 {decideFor.id}：{decideFor.action === 'approve' ? '同意退款' : '驳回退款'}，处理意见（必填，2–200 字）</label>
                    <textarea id="refund-note" className="form-input" maxLength={200} value={decideNote} onChange={e => setDecideNote(e.target.value)} />
                    <button className="btn btn-primary" disabled={ledgerBusy || decideNote.trim().length < 2} onClick={() => void decideRefund()}>确认提交</button>
                    <button className="btn btn-ghost" style={{ marginLeft: 8 }} onClick={() => setDecideFor(null)}>取消</button>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}

      {/* ---------- 用户管理 ---------- */}
      {tab === 'users' && (
        <>
          <p style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 14 }}>
            注销会永久删除账号：业主的项目、订单、合同与户型图一并删除；装修公司的投标一并删除，已被选为施工方的公司不能注销。入驻费付款记录保留。
          </p>
          {userMsg && <p role="status" style={{ fontSize: 13, marginBottom: 12 }}>{userMsg}</p>}
          <div className="panel">
            <div className="wf-table-wrap">
            <table className="data-table">
              <thead><tr><th>ID</th><th>身份</th><th>姓名 / 公司</th><th>手机号</th><th>邮箱</th><th>项目</th><th>注册时间</th><th>操作</th></tr></thead>
              <tbody>
                {(userRows ?? []).map(u => (
                  <tr key={u.id}>
                    <td>{u.id}</td>
                    <td>{u.role === 'company' ? '装潢公司' : '个人用户'}</td>
                    <td>{u.companyName ? `${u.companyName}（${u.name}）` : u.name}</td>
                    <td>{u.phone ?? '-'}</td>
                    <td>{u.email ?? '-'}</td>
                    <td>{u.projectCount}</td>
                    <td>{u.createdAt.slice(0, 10)}</td>
                    <td>
                      {confirmUser === u.id ? (
                        <span style={{ display: 'inline-flex', gap: 6 }}>
                          <button className="btn" style={{ color: 'var(--accent-danger)' }} disabled={userBusy === u.id} onClick={() => removeUser(u.id)}>
                            {userBusy === u.id ? '注销中…' : '确认注销'}
                          </button>
                          <button className="btn btn-ghost" disabled={userBusy === u.id} onClick={() => setConfirmUser(null)}>取消</button>
                        </span>
                      ) : (
                        <button className="btn btn-ghost" onClick={() => { setConfirmUser(u.id); setUserMsg(''); }}>注销</button>
                      )}
                    </td>
                  </tr>
                ))}
                {userRows !== null && userRows.length === 0 && (
                  <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 20 }}>暂无注册用户</td></tr>
                )}
                {userRows === null && (
                  <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 20 }}>加载中...</td></tr>
                )}
              </tbody>
            </table>
            </div>
          </div>
        </>
      )}

      {/* ---------- 利润分成 ---------- */}
      {tab === 'commissions' && (
        <>
          <p style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 14 }}>
            以下为旧版利润分成历史记录，仅供只读归档。新合同由乙方按签约费率承担履约服务费，只在成功模拟阶段结算时计收，不重复计入历史分成。
          </p>
          <div className="stats-row" style={{ marginBottom: 16 }}>
            <div className="stat-card"><div className="label">累计利润</div><div className="value green">¥{(data?.commissionSettlements ?? []).reduce((s, x) => s + x.profitCny, 0).toLocaleString()}</div></div>
            <div className="stat-card"><div className="label">历史平台分成</div><div className="value purple">¥{(data?.commissionSettlements ?? []).reduce((s, x) => s + x.platformCommissionCny, 0).toLocaleString()}</div></div>
            <div className="stat-card"><div className="label">待结算</div><div className="value orange">{(data?.commissionSettlements ?? []).filter(x => x.status === 'pending').length}</div></div>
          </div>
          <div className="panel">
            <div className="wf-table-wrap">
            <table className="data-table">
              <thead><tr><th>订单</th><th>装修队</th><th>成交额</th><th>预估成本</th><th>利润</th><th>历史平台分成</th><th>净利</th><th>归档状态</th></tr></thead>
              <tbody>
                {(data?.commissionSettlements ?? []).map(x => (
                  <tr key={x.id}>
                    <td>ORDER_{x.orderId}</td><td>{x.companyName}</td>
                    <td>¥{x.revenueCny.toLocaleString()}</td><td>¥{x.estimatedCostCny.toLocaleString()}</td>
                    <td>¥{x.profitCny.toLocaleString()}</td><td>¥{x.platformCommissionCny.toLocaleString()}</td><td>¥{x.contractorNetProfitCny.toLocaleString()}</td>
                    <td><span className="tag">{x.status === 'settled' ? '历史已结算' : x.status === 'cancelled' ? '历史已作废' : '历史待结算'} · 只读</span></td>
                  </tr>
                ))}
                {(data?.commissionSettlements ?? []).length === 0 && (
                  <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 20 }}>暂无利润分成记录</td></tr>
                )}
              </tbody>
            </table>
            </div>
          </div>
        </>
      )}

      {/* ---------- 订单（第一单） ---------- */}
      {tab === 'orders' && (
        <>
          <p style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 14 }}>
            公司确认 → 业主接受或议价 → 三方签署 → 施工验收 → 分期结算。每份合同的签署与资金模式以工作台标注为准；真实合同仅按服务商回执记录，演示合同不发生真实资金流转。平台为合同当事方，独立争议处理结果另行记录。
          </p>
          <div className="panel">
            <div className="wf-table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>订单</th><th>项目</th><th>状态</th><th>报价（万元）</th><th>工期</th><th>匹配度</th><th>合同履约</th></tr>
              </thead>
              <tbody>
                {(data?.orders ?? []).map(o => (
                  <tr key={o.id}>
                    <td style={{ fontFamily: 'var(--font-mono)' }}>ORDER_{o.id}</td>
                    <td>{o.projectName}</td>
                    <td>{statusTag(o.status)}</td>
                    <td>{o.bidAmount ? Number(o.bidAmount).toLocaleString() : '-'}</td>
                    <td>{o.bidWeeks ? `${o.bidWeeks} 周` : '-'}</td>
                    <td>{o.matchScore ?? '-'}</td>
                    <td>{['open', 'bidding'].includes(o.status) ? <span className="wf-muted">待业主选择公司</span> : <button className="btn btn-ghost" type="button" onClick={() => { setWorkflowMode(undefined); setWorkflowOrder(o.id); }}>打开合同履约</button>}</td>
                  </tr>
                ))}
                {(data?.orders ?? []).length === 0 && (
                  <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 20 }}>
                    暂无订单 — 业主在项目页「发布到接单市场」后生成
                  </td></tr>
                )}
              </tbody>
            </table>
            </div>
          </div>
        </>
      )}

      {workflowOrder !== null && <ContractWorkbenchDialog orderId={workflowOrder} role="platform" initialMode={workflowMode} onClose={() => setWorkflowOrder(null)} />}
      <p style={{ textAlign: 'center', color: 'var(--text-dim)', fontSize: 11, marginTop: 24 }}>
        经营数据实时更新 · 所有执行过程、成本与结算记录可追溯
      </p>
    </main>
  );
}
