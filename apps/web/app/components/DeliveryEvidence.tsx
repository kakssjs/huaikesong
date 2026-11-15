'use client';

import { useState } from 'react';
import type { buildDeliveryReport, DeliveryStatus } from '@i-renovation/shared/delivery';

export const DELIVERY_LABEL: Record<DeliveryStatus | 'cancelled', string> = {
  pending: '待开始', running: '进行中', done: '可复核', failed: '执行失败',
  waiting_user: '待补充', escalated: '待人工处理', stale: '待重新交付', partial: '交付不完整', blocked: '前序待处理',
  cancelled: '已停止',
};

export default function DeliveryEvidence({ report }: { report: ReturnType<typeof buildDeliveryReport> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rechecking, setRechecking] = useState(false);
  const [notice, setNotice] = useState('');
  async function retryFailed() {
    setBusy(true); setError(''); setNotice('');
    try {
      const res = await fetch(`/api/projects/${report.project.id}/replan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ retry: true }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || '重试提交失败');
      setNotice(`已提交失败环节重试，后续岗位自动接力 · Task #${body.taskId}`);
    } catch (e) { setError(e instanceof Error ? e.message : '重试提交失败'); }
    finally { setBusy(false); }
  }
  async function recheck() {
    setRechecking(true); setError(''); setNotice('');
    try {
      const res = await fetch(`/api/projects/${report.project.id}/recheck`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: '交付面板发起最新成果复检' }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || '复检提交失败');
      setNotice(`复检已提交，等待执行 · Task #${body.taskId}`);
    } catch (e) { setError(e instanceof Error ? e.message : '复检提交失败'); }
    finally { setRechecking(false); }
  }
  async function download() {
    setBusy(true); setError('');
    try {
      const res = await fetch(`/api/projects/${report.project.id}/delivery?download=1`, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(res.status === 403 ? '完整交付记录仅供业主本人和平台下载' : body.error || '下载失败，请重试');
      }
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement('a');
      link.href = url; link.download = `yushe-project-${report.project.id}-delivery.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e instanceof Error ? e.message : '下载失败，请重试'); }
    finally { setBusy(false); }
  }
  return (
    <section className="panel delivery-evidence" aria-labelledby="delivery-evidence-title">
      <div className="delivery-heading">
        <div>
          <h2 id="delivery-evidence-title">本轮交付与人工复核</h2>
          <p>{report.readyForReview ? '所有岗位已自动完成，无需逐项审批；请在方案确认区一次确认。' : '团队自动接力；失败补齐与重新质检分开操作，具体问题见下方。'}</p>
        </div>
        <button type="button" className="btn" onClick={() => void download()} disabled={busy}>{busy ? '正在下载…' : '下载交付记录'}</button>
      </div>
      {error && <p role="alert" className="delivery-error">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <ol className="delivery-stages">
        {report.stages.map(stage => (
          <li key={stage.key}>
            <div className="delivery-stage-title"><strong>{stage.label}</strong><span className={stage.status === 'done' ? 'tag tag-green' : 'tag'}>{DELIVERY_LABEL[stage.status]}</span></div>
            <p>{stage.deliverable}</p>
            <small>{stage.execution}</small>
            <p className="delivery-action">{stage.nextAction}{stage.taskId !== null && <small> · Task #{stage.taskId}</small>}</p>
          </li>
        ))}
      </ol>
      {report.artifacts.filter(a => a.kind === 'qa').map(a => {
        const qa = a.content as { checks?: { check: string; ok: boolean; detail?: string; level?: string }[] };
        return <div key="qa-checks"><h3>本次质检明细</h3><ul>{qa.checks?.map((check, i) => <li key={i}><strong>{check.ok ? '通过' : check.level === 'critical' ? '需修正' : '提示'} · {check.check}</strong><p>{check.detail}</p></li>)}</ul></div>;
      })}
      <button type="button" className="btn" disabled={busy || rechecking || report.stages.some(s => s.status === 'running' || s.status === 'pending')} onClick={() => void retryFailed()}>补齐 / 重试失败步骤</button>
      <button type="button" className="btn" disabled={busy || rechecking || report.stages.some(s => s.status === 'running' || s.status === 'pending')} onClick={() => void recheck()}>{rechecking ? '正在提交…' : '重新质检当前成果'}</button>
      <p className="wf-muted">可复核表示当前任务与成果满足基础检查；方案、价格、合同签署和施工验收仍由相关人员确认。下载包含已保存成果，请由业主决定分享范围。</p>
      <a href="/opc">查看团队岗位与服务说明 →</a>
    </section>
  );
}
