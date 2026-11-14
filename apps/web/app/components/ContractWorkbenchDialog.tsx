'use client';

import { useEffect, useId, useRef } from 'react';
import type { WorkflowRole } from '@i-renovation/shared/workflow';
import ContractWorkbench from './ContractWorkbench';

export default function ContractWorkbenchDialog({ orderId, role, onClose }: { orderId: number; role: WorkflowRole; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null); const titleId = useId();
  useEffect(() => { const el = dialog.current; el?.showModal(); const previous = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { el?.close(); document.body.style.overflow = previous; }; }, []);
  return <dialog ref={dialog} className="wf-dialog" aria-labelledby={titleId} onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="wf-dialog-header"><h2 id={titleId}>订单 #{orderId} · 签约与履约</h2><button type="button" className="btn btn-ghost" onClick={onClose} autoFocus>关闭工作台</button></div>
    <ContractWorkbench orderId={orderId} role={role} />
  </dialog>;
}
