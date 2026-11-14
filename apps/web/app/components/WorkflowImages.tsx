'use client';

import { useId, useRef, useState } from 'react';
import type { WorkflowAttachment } from '@i-renovation/shared/workflow';

async function imageFile(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 1024 * 1024) throw new Error('请选择不超过 1 MiB 的 PNG、JPEG 或 WebP 图片');
  const data = new Uint8Array(await file.arrayBuffer());
  const png = data[0] === 137 && data[1] === 80 && data[2] === 78 && data[3] === 71;
  const jpeg = data[0] === 255 && data[1] === 216 && data[2] === 255;
  const webp = String.fromCharCode(...data.slice(0, 4)) === 'RIFF' && String.fromCharCode(...data.slice(8, 12)) === 'WEBP';
  if (!(file.type === 'image/png' && png || file.type === 'image/jpeg' && jpeg || file.type === 'image/webp' && webp)) throw new Error('图片实际格式与文件类型不一致');
  return await new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('读取图片失败')); reader.readAsDataURL(file);
  });
}

export function ImageInput({ label, value, onChange, disabled = false, handwrite = false }: {
  label: string; value: string; onChange: (value: string) => void; disabled?: boolean; handwrite?: boolean;
}) {
  const id = useId();
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  return <div className="wf-image-input">
    <label htmlFor={id}>{label}</label>
    <input id={id} type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled || reading} onChange={async e => {
      const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
      setReading(true); setError('');
      try { onChange(await imageFile(file)); } catch (cause) { setError(cause instanceof Error ? cause.message : '读取图片失败'); } finally { setReading(false); }
    }} />
    {handwrite && <>
      <span className="wf-muted">也可以在下方亲笔手写签名</span>
      <canvas ref={canvas} width={720} height={180} className="wf-signature-pad" aria-label="亲笔手写签名画布" tabIndex={0}
        onPointerDown={e => {
          if (disabled) return; const c = canvas.current; const ctx = c?.getContext('2d'); if (!c || !ctx) return;
          c.setPointerCapture(e.pointerId); const rect = c.getBoundingClientRect();
          ctx.beginPath(); ctx.moveTo((e.clientX - rect.left) * c.width / rect.width, (e.clientY - rect.top) * c.height / rect.height);
          ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.strokeStyle = '#1d252a'; drawing.current = true;
        }}
        onPointerMove={e => {
          if (!drawing.current || disabled) return; const c = canvas.current; const ctx = c?.getContext('2d'); if (!c || !ctx) return;
          const rect = c.getBoundingClientRect(); ctx.lineTo((e.clientX - rect.left) * c.width / rect.width, (e.clientY - rect.top) * c.height / rect.height); ctx.stroke();
        }}
        onPointerUp={() => { if (drawing.current && canvas.current) { drawing.current = false; onChange(canvas.current.toDataURL('image/png')); } }}
        onPointerCancel={() => { drawing.current = false; }} />
      <button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => { const c = canvas.current; if (c) c.getContext('2d')?.clearRect(0, 0, c.width, c.height); onChange(''); }}>清除签名</button>
    </>}
    {value && <img className="wf-signature-preview" src={value} alt={label} />}
    {error && <p role="alert" className="wf-error">{error}</p>}
  </div>;
}

export function AttachmentEditor({ value, onChange, disabled = false, allowUrl = true }: {
  value: WorkflowAttachment[]; onChange: (value: WorkflowAttachment[]) => void; disabled?: boolean; allowUrl?: boolean;
}) {
  const id = useId(); const [error, setError] = useState(''); const [reading, setReading] = useState(false);
  const [url, setUrl] = useState(''); const [name, setName] = useState('');
  return <div className="wf-attachments">
    <label htmlFor={id}>附件图片（最多 12 张，每张不超过 1 MiB）</label>
    <input id={id} type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={disabled || reading || value.length >= 12} onChange={async e => {
      const files = Array.from(e.target.files ?? []); e.target.value = ''; setError('');
      if (value.length + files.length > 12) { setError('最多保存 12 个附件'); return; }
      setReading(true);
      try { const additions = await Promise.all(files.map(async file => ({ id: crypto.randomUUID(), name: file.name, kind: 'reference' as const, dataUrl: await imageFile(file) }))); onChange([...value, ...additions]); }
      catch (cause) { setError(cause instanceof Error ? cause.message : '读取图片失败'); } finally { setReading(false); }
    }} />
    {allowUrl && <div className="wf-inline">
      <label>外部参考名称<input value={name} disabled={disabled} onChange={e => setName(e.target.value)} /></label>
      <label>外部参考链接<input type="url" placeholder="https://" value={url} disabled={disabled} onChange={e => setUrl(e.target.value)} /></label>
      <button className="btn btn-ghost" type="button" disabled={disabled || value.length >= 12 || !url.trim() || !name.trim()} onClick={() => {
        try { if (new URL(url).protocol !== 'https:') throw new Error(); onChange([...value, { id: crypto.randomUUID(), name: name.trim(), kind: 'reference', url, note: '外部链接仅作参考，未冻结外部内容' }]); setUrl(''); setName(''); setError(''); }
        catch { setError('外部参考链接必须使用 HTTPS'); }
      }}>添加参考链接</button>
    </div>}
    <div className="wf-attachment-grid">{value.map((item, index) => <div className="wf-attachment" key={item.id}>
      {item.dataUrl && <img src={item.dataUrl} alt={item.name} />}
      {item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.name}</a> : <span>{item.name}</span>}
      {item.url && !item.dataUrl && <small>外部内容未冻结</small>}
      <label>附件用途<select disabled={disabled} value={item.kind} onChange={e => onChange(value.map((a, i) => i === index ? { ...a, kind: e.target.value as WorkflowAttachment['kind'] } : a))}>
        <option value="reference">风格参考</option><option value="plan">户型与图纸</option><option value="quote">报价清单</option><option value="material">材料清单</option>
      </select></label>
      <button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => onChange(value.filter((_, i) => index !== i))}>移除附件</button>
    </div>)}</div>
    {error && <p role="alert" className="wf-error">{error}</p>}
  </div>;
}
