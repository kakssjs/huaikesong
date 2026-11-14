'use client';
import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { validateTrial, summarizeTrials, trialsCsv, type TrialRecord } from '@/lib/trial-records';
const STORE='yushe.trial-records.v1';
const ROLES:Record<string,string>={floor_plan:'户型识别',designer:'方案设计',quote:'报价工期',qa:'交付质检',matcher:'施工方匹配'};
function readStored(){const value=JSON.parse(localStorage.getItem(STORE)||'[]');if(!Array.isArray(value)||value.length>500)throw Error('存储记录无效');const parsed=value.map(validateTrial);if(new Set(parsed.map(x=>x.id)).size!==parsed.length)throw Error('存在重复记录');return parsed;}
export default function TrialRecorder(){
  const [records,setRecords]=useState<TrialRecord[]>([]),[ready,setReady]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  useEffect(()=>{try{setRecords(readStored());setReady(true);}catch{setError('本机存储不可读取，已停止写入以保留原数据；请检查浏览器存储设置。');}},[]);
  const stats=summarizeTrials(records);
  function add(e:FormEvent<HTMLFormElement>){
    e.preventDefault();setError('');setNotice('');const form=e.currentTarget,f=new FormData(form);
    const optional=(key:string)=>String(f.get(key)||'').trim()===''?null:Number(f.get(key));
    try{
      const latest=readStored();if(latest.length>=500)throw Error('本机最多保存 500 条，请先下载备份。');
      const record=validateTrial({id:crypto.randomUUID(),sample:f.get('sample'),kind:f.get('kind'),role:f.get('role'),systemSeconds:Number(f.get('systemSeconds')),manualMinutes:optional('manualMinutes'),modelCostCny:optional('modelCostCny'),revisions:Number(f.get('revisions')),outcome:f.get('outcome'),recordedAt:new Date().toISOString()});
      const next=[...latest,record];localStorage.setItem(STORE,JSON.stringify(next));setRecords(next);setNotice('已保存到当前浏览器，可下载记录作为备份。');form.reset();
    }catch(e){setError(e instanceof Error?e.message:'保存失败，请检查输入和浏览器存储。');}
  }
  function download(format:'csv'|'json'){
    const value=format==='csv'?trialsCsv(records):JSON.stringify({schema:'yushe.trials.v1',exportedAt:new Date().toISOString(),source:'手工填写的试运行观察，未自动核验',summary:stats,records},null,2);
    const url=URL.createObjectURL(new Blob([value],{type:format==='csv'?'text/csv;charset=utf-8':'application/json'})),a=document.createElement('a');a.href=url;a.download=`yushe-trials.${format}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  const show=(value:number|null,unit='')=>value===null?'待测':`${Number(value.toFixed(2))}${unit}`;
  return <main className="container trials-page">
    <p className="editorial-kicker">TRIAL EVIDENCE</p><h1>试运行效果记录</h1><p>用样例编号记录实际观察，不填写姓名、电话或住址。数据仅保存在当前浏览器，不上传服务器，也不进入合同和资金流程。</p><Link href="/opc">返回团队与服务 →</Link>
    <section className="panel"><h2>真实样本统计</h2><p>真实样本 {stats.realCount} 条，合成样例 {stats.syntheticCount} 条。以下指标仅统计真实样本，数据均由你手工填写。</p>
      <dl className="trial-stats"><div><dt>系统耗时中位数</dt><dd>{show(stats.medianSeconds,' 秒')}</dd></div><div><dt>平均调用成本</dt><dd>{show(stats.meanCostCny,' 元')}<small>已知成本 {stats.costSampleCount} 条；未知值不按零计算</small></dd></div><div><dt>配对耗时减少比例</dt><dd>{show(stats.timeSavedPct,'%')}<small>有人工基线 {stats.pairedCount} 条；负值表示耗时增加</small></dd></div><div><dt>验收通过率</dt><dd>{show(stats.acceptanceRate===null?null:stats.acceptanceRate*100,'%')}<small>已验收 {stats.reviewedCount} 条；待验收不计入分母</small></dd></div></dl>
    </section>
    <section className="panel"><h2>新增一条观察</h2><form onSubmit={add}><div className="trial-form">
      <label>样例编号<input name="sample" maxLength={100} required placeholder="例如 HXT-001"/></label>
      <label>样本类型<select name="kind" defaultValue="synthetic"><option value="synthetic">合成/演示样例</option><option value="real">真实试运行</option></select></label>
      <label>验证岗位<select name="role">{Object.entries(ROLES).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
      <label>系统实际耗时（秒）<input name="systemSeconds" type="number" required min="0.01" max="86400" step="0.01"/></label>
      <label>人工对照耗时（分钟，可留空）<input name="manualMinutes" type="number" min="0.01" max="10080" step="0.01"/></label>
      <label>手工记录调用成本（元，可留空）<input name="modelCostCny" type="number" min="0" max="100000" step="0.0001"/></label>
      <label>人工修订次数<input name="revisions" type="number" min="0" max="10000" defaultValue="0" required/></label>
      <label>验收结果<select name="outcome" defaultValue="pending"><option value="pending">待验收</option><option value="accepted">通过</option><option value="rejected">未通过</option></select></label>
      </div><button className="btn btn-primary" type="submit" disabled={!ready}>保存观察记录</button></form>
      {error&&<p role="alert" className="chat-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
    </section>
    <section className="panel"><div className="trial-actions"><h2>观察记录</h2><button className="btn" type="button" disabled={!records.length} onClick={()=>download('csv')}>下载 CSV</button><button className="btn" type="button" disabled={!records.length} onClick={()=>download('json')}>下载 JSON 与统计</button></div>
      {!records.length?<p>尚无观察数据，不预填成功率或节省成本。</p>:<div className="wf-table-wrap"><table className="data-table"><thead><tr><th>编号</th><th>类型</th><th>岗位</th><th>耗时</th><th>人工基线</th><th>调用成本</th><th>修订</th><th>验收</th></tr></thead><tbody>{records.map(r=><tr key={r.id}><td data-no-translate>{r.sample}</td><td>{r.kind==='real'?'真实':'合成'}</td><td>{ROLES[r.role]}</td><td>{r.systemSeconds} 秒</td><td>{show(r.manualMinutes,' 分钟')}</td><td>{show(r.modelCostCny,' 元')}</td><td>{r.revisions}</td><td>{{pending:'待验收',accepted:'通过',rejected:'未通过'}[r.outcome]}</td></tr>)}</tbody></table></div>}
      <p>建议同类任务采用相同输入与计时范围，并保留对应项目、任务编号和交付文件。手工记录不能单独证明真实模型质量或经营收益。本机记录不跨账号隔离，适合个人开发预演；请使用编号，不保存客户信息。</p>
    </section>
  </main>;
}
