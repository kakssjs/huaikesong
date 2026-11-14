import Link from 'next/link';
import { BUSINESS_CANVAS, DEMO_STEPS, ROLE_SHEETS } from '@/lib/opc-content';

export const metadata = { title: '团队岗位与服务交付 · 予舍', description: '了解予舍的装修服务流程、商业模式、六个岗位的职责与交付标准。' };

export default function OpcPage() {
  return (
    <main className="container opc-page">
      <p className="editorial-kicker">TEAM · SERVICE · DELIVERY</p>
      <h1>一支 AI 装修团队，<br />交出可以核对的成果</h1>
      <p>从户型和设计，到报价、质检与施工方匹配，再接续签约履约。专项岗位分工协作，业主、装修公司与平台各自确认关键决定。</p>
      <nav className="opc-nav" aria-label="服务说明导航">
        <a href="#business">商业模式画布</a><a href="#roles">岗位说明书</a><a href="#delivery">交付与验收</a><a href="#demo">演示流程</a>
      </nav>
      <Link href="/dashboard" className="btn btn-primary">进入我的项目，查看真实交付 →</Link>
      <p><a href="/docs/opc-materials.md" download>下载商业模式、岗位说明与演示材料（Markdown）</a></p>

      <section id="business" aria-labelledby="business-title">
        <h2 id="business-title">商业模式画布</h2>
        <p>以下是当前服务方案。获客、成本与业务效果仍需验证；画布不代表已有收入或真实资金托管。</p>
        <div className="opc-grid">{BUSINESS_CANVAS.map(item => <article key={item.title}><h3>{item.title}</h3><p>{item.body}</p></article>)}</div>
      </section>

      <section id="roles" aria-labelledby="roles-title">
        <h2 id="roles-title">岗位说明书</h2>
        <p>产品保留完整团队。深入演示一个岗位时，仍需要说明它从谁接收、交付给谁，以及哪些决定由人确认。</p>
        {ROLE_SHEETS.map(role => <article className="opc-role" key={role.name}>
          <h3>{role.name}</h3>
          <dl><dt>输入</dt><dd>{role.input}</dd><dt>执行方式</dt><dd>{role.work}</dd><dt>交付</dt><dd>{role.output}</dd><dt>人工介入</dt><dd>{role.human}</dd><dt>验收标准</dt><dd>{role.acceptance}</dd></dl>
        </article>)}
        <p>签约辅助接续已确认的方案与报价，提供规则草案和可选模型复核。签名、用章、接受价格、施工验收与资金决定由有权限的人操作。</p>
      </section>

      <section id="delivery" aria-labelledby="delivery-title">
        <h2 id="delivery-title">交付与验收</h2>
        <ol>
          <li>提交户型、面积、风格与需求；检查识别来源，必要时补充或纠正。</li>
          <li>在项目页查看本轮交付面板，核对二维、3D、图片、分项报价与质检。</li>
          <li>成果齐备后人工复核；旧任务成功、缺图或质检未通过均不等于本轮已经交付。</li>
          <li>业主确认方案后发布，装企实际投标，匹配给出比较建议，由业主选定。</li>
          <li>三方核对合同版本，再按阶段提交、验收及模拟结算；真实服务需另行接入。</li>
        </ol>
        <p>业主本人和平台可以下载已保存的交付记录。报告包含任务编号、执行方式、最新成果与待办，不自动替任何一方确认。</p>
      </section>

      <section id="demo" aria-labelledby="demo-title">
        <h2 id="demo-title">5 分钟演示流程</h2>
        <div className="wf-table-wrap"><table className="data-table"><thead><tr><th>时间</th><th>展示内容</th><th>操作与证据</th></tr></thead><tbody>{DEMO_STEPS.map(([time, title, detail]) => <tr key={time}><td>{time}</td><td>{title}</td><td>{detail}</td></tr>)}</tbody></table></div>
        <p>本地没有配置模型时，先展示真实的待补充或失败状态；已保存样例仅作为备用说明。模型调用成功和端到端交付质量需在正式演示环境单独验证。</p>
      </section>
    </main>
  );
}
