'use client';

import { useEffect, useState } from 'react';
import type { CompanyContractProfile as Profile, ContractParty } from '@i-renovation/shared/workflow';
import { ImageInput } from './WorkflowImages';

const EMPTY_PARTY: ContractParty = { legalName: '', registrationId: '', representative: '', contact: '', address: '' };

export function PartyFields({ value, onChange, disabled = false }: { value: ContractParty; onChange: (party: ContractParty) => void; disabled?: boolean }) {
  const fields: Array<[keyof ContractParty, string]> = [['legalName', '签约主体名称'], ['registrationId', '身份或登记资料'], ['representative', '授权代表'], ['contact', '联系方式'], ['address', '主体地址']];
  return <div className="wf-form-grid">{fields.map(([key, label]) => <label key={key}>{label}<input maxLength={key === 'address' ? 400 : 200} disabled={disabled} value={value[key] ?? ''} onChange={e => onChange({ ...value, [key]: e.target.value })} /></label>)}</div>;
}

export default function CompanyContractProfile({ defaultParty, onSaved }: { defaultParty: ContractParty; onSaved?: (profile: Profile) => void }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [party, setParty] = useState(defaultParty ?? EMPTY_PARTY);
  const [signer, setSigner] = useState(''); const [seal, setSeal] = useState('');
  const [authorized, setAuthorized] = useState(false); const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  useEffect(() => {
    let live = true;
    fetch('/api/company/contract-profile', { cache: 'no-store' }).then(async response => {
      const data = await response.json(); if (!response.ok) throw new Error(data.error || '读取企业签约资料失败');
      if (!live || !data) return;
      setProfile(data); if (data.party) setParty(data.party); setSigner(data.authorizedSignerName ?? ''); setSeal(data.sealDataUrl ?? '');
    }).catch(cause => { if (live) setError(cause instanceof Error ? cause.message : '读取企业签约资料失败'); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  return <details className="wf-section">
    <summary>本公司私有签约资料与公章</summary>
    <p className="wf-muted">仅本公司账号可读取原章。保存资料不会修改已冻结合同；每次签署仍须单独确认用章授权。</p>
    {loading ? <p role="status">正在读取签约资料…</p> : <form onSubmit={async e => {
      e.preventDefault(); if (busy || !authorized) return; setBusy(true); setError(''); setMessage('');
      try {
        const response = await fetch('/api/company/contract-profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ party, authorizedSignerName: signer, ...(seal ? { sealDataUrl: seal } : {}) }) });
        const data = await response.json(); if (!response.ok) throw new Error(data.error || '保存企业签约资料失败');
        setProfile(data); setAuthorized(false); setMessage('企业签约资料已保存；当前合同条款需另行修订确认'); onSaved?.(data);
      } catch (cause) { setError(cause instanceof Error ? cause.message : '保存企业签约资料失败'); } finally { setBusy(false); }
    }}>
      <fieldset disabled={busy}><PartyFields value={party} onChange={setParty} />
        <label>企业授权签署人<input maxLength={200} value={signer} onChange={e => setSigner(e.target.value)} required /></label>
        <ImageInput label="上传本公司有权使用的公章" value={seal} onChange={setSeal} disabled={busy} />
        <label className="wf-check"><input type="checkbox" checked={authorized} onChange={e => setAuthorized(e.target.checked)} />我有权保存上述公司资料及公章</label>
        <button type="submit" className="btn btn-primary" disabled={busy || !authorized}>{busy ? '保存中…' : '保存私有签约资料'}</button>
      </fieldset>
      {profile?.updatedAt && <p className="wf-muted">上次保存：{new Date(profile.updatedAt).toLocaleString()}</p>}
    </form>}
    {error && <p role="alert" className="wf-error">{error}</p>}<p role="status">{message}</p>
  </details>;
}
