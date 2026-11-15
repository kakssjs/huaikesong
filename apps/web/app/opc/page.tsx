import Link from 'next/link';
import { ROLE_SHEETS } from '@/lib/opc-content';

export const metadata = { title: '团队与服务 · 予舍', description: '了解予舍 AI 装修团队与户型、设计、报价及施工匹配服务。' };

export default function OpcPage() {
  return (
    <main className="container opc-page">
      <p className="editorial-kicker">TEAM · SERVICE · DELIVERY</p>
      <h1>团队与服务</h1>
      <p>予舍是一支分工协作的 AI 装修团队，帮助你整理户型、规划空间、了解预算，并比较装修公司的方案，让装修准备更清楚、更省心。</p>

      <section aria-labelledby="service-title">
        <h2 id="service-title">我们能帮你做什么</h2>
        <p>从上传户型和填写需求开始，团队接力完成空间识别、二维与 3D 方案、房间效果图、报价及工期估算，并检查成果是否完整。方案确认后，你可以比较装修公司的真实投标，选定公司并沟通施工细节。</p>
      </section>

      <section id="roles" aria-labelledby="roles-title">
        <h2 id="roles-title">认识我们的团队</h2>
        <div className="opc-grid">{ROLE_SHEETS.map(role => <article key={role.name}>
          <h3>{role.name}</h3>
          <p>{role.output}</p>
        </article>)}</div>
      </section>

      <p>设计与预算供装修准备参考，尺寸和施工方案以现场量房及专业人员确认为准。</p>
      <Link href="/dashboard" className="btn btn-primary">开始我的装修项目 →</Link>
    </main>
  );
}
