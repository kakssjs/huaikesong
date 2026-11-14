'use client';

import LeadHero, { openAuth } from './components/LeadHero';
import { AGENTS } from '@/lib/agents';

const TEAM = [
  { key: 'orchestrator', role: '任务调度', input: '项目需求与执行状态', output: '阶段分派、异常转交与人工待办' },
  { key: 'floor_plan', role: '户型识别', input: '上传或手绘的户型资料', output: '房间、布局与待核对的空间信息' },
  { key: 'designer', role: '方案设计', input: '户型数据、风格与居住需求', output: '方案数据，供二维图、同源 3D 与效果图使用' },
  { key: 'quote', role: '报价与工期', input: '设计方案、工程量与价格依据', output: '材料清单、费用明细与工期安排' },
  { key: 'qa', role: '交付质检', input: '布局、报价与生成结果', output: '完整性检查、问题清单与复核事项' },
  { key: 'matcher', role: '施工方匹配', input: '业主确认的需求、真实投标与公司资料', output: '候选比较、推荐理由与承接建议' },
];

const AGENT_FLOW = [
  { name: 'FloorPlan', label: '户型识别', body: '上传或手绘户型图，识别房间、面积与动线。' },
  { name: 'Designer', label: '二维设计', body: '按户型生成二维装修图：墙、门、窗与尺寸。' },
  { name: 'Render', label: '3D 呈现工具', body: '沿用设计环节的平面数据生成可环绕查看的 3D 模型，与效果图一起辅助核对方案。' },
  { name: 'Quote', label: '报价工期', body: '材料清单、报价与工期，逐项可核对。' },
  { name: 'QA', label: '交付质检', body: '检查布局、报价与结果完整性，问题需要修正或转交人工复核。' },
  { name: 'Matcher', label: '装修队匹配', body: '业主确认发布后，装修公司投标，匹配智能体按资质与真实投标择优推荐。' },
  { name: 'Contract', label: '签约与履约', body: 'AI 装修签约专员整理合同草案与缺项，三方确认后演示签署，再按阶段提交、验收与模拟结算。' },
];

const FEATURES = [
  { icon: '⬡', title: 'AI 户型识别', body: '上传户型图，AI 智能识别房间布局，自动计算面积与动线。' },
  { icon: '◈', title: '智能设计报价', body: 'AI 生成设计方案，自动计算报价与工期，全流程可视化。' },
  { icon: '⊞', title: '三方签约与阶段履约', body: '公司确认、业主议价、三方核对同一合同版本，施工验收与阶段结算逐项记录。' },
];

const GALLERY = [
  { src: '/images/gallery/modern-living.jpg', label: '现代简约', en: 'Modern' },
  { src: '/images/gallery/nordic-bedroom.jpg', label: '北欧风', en: 'Nordic' },
  { src: '/images/gallery/japanese-zen.jpg', label: '日式禅意', en: 'Zen' },
  { src: '/images/gallery/chinese-classic.jpg', label: '新中式', en: 'Chinese' },
  { src: '/images/gallery/industrial-kitchen.jpg', label: '工业风', en: 'Industrial' },
  { src: '/images/gallery/luxury-villa.jpg', label: '轻奢别墅', en: 'Luxury' },
  { src: '/images/gallery/french-elegant.jpg', label: '法式优雅', en: 'French' },
  { src: '/images/gallery/coastal-breeze.jpg', label: '地中海', en: 'Coastal' },
];

const BENEFITS = ['户型识别', '二维施工图', '3D 交互模型', '报价与工期', '匹配与签约'];

export default function Home() {
  return (
    <main>
      <LeadHero />

      <div className="landing-benefits">
        {BENEFITS.map((b, i) => (
          <span key={b}><b>0{i + 1}</b>{b}</span>
        ))}
      </div>

      <section className="home-section home-editorial">
        <p className="editorial-kicker">01 / THE I RENOVATION WAY</p>
        <h2>一支 AI 团队，协作完成装修方案与交付</h2>
        <p className="lead">从需求与调度、户型识别、设计和 3D，到报价、质检、施工方匹配，再衔接签约与履约。专项智能体分工接力，关键方案、价格、签署和验收由人确认。</p>
      </section>

      <section className="home-section home-team" id="agent-team" aria-labelledby="agent-team-title">
        <p className="editorial-kicker">THE AI TEAM</p>
        <h2 id="agent-team-title">每个岗位，都有清楚的输入与交付</h2>
        <p className="lead">调度串联任务，专项智能体处理各自环节；项目页记录实际任务状态与上下游交接。</p>
        <div className="home-team-grid">
          {TEAM.map(member => (
            <article className="home-team-member" key={member.key}>
              <h3>{AGENTS[member.key].name} · {member.role}</h3>
              <p><strong>接收：</strong>{member.input}</p>
              <p><strong>交付：</strong>{member.output}</p>
            </article>
          ))}
        </div>
        <p className="lead">签约专员接续已确认的方案与报价，整理合同草案、阶段计划和待确认事项，作为团队业务链的延伸。</p>
      </section>

      <section className="home-section home-features">
        {FEATURES.map((f) => (
          <div key={f.title} className="feature">
            <div className="ico-box" aria-hidden="true">{f.icon}</div>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
          </div>
        ))}
      </section>

      <section className="home-section home-gallery">
        <div className="home-gallery-head">
          <div>
            <p className="editorial-kicker">02 / STYLES</p>
            <h2>你想要的样子</h2>
          </div>
          <p>八种常见风格。选一种开始，再在对话里改到满意。</p>
        </div>
        <div className="gallery-grid">
          {GALLERY.map((g) => (
            <figure key={g.src} className="gallery-item">
              <img src={g.src} alt={g.label} loading="lazy" />
              <figcaption><span>{g.label}</span><small>{g.en}</small></figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section className="home-process">
        <p className="editorial-kicker">03 / CORE CHAIN</p>
        <h2>智能体流水线</h2>
        <ol className="steps-list">
          {AGENT_FLOW.map((s) => (
            <li key={s.name}>
              <span className="en">{s.name}</span>
              <strong>{s.label}</strong>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="home-section home-note">
        <h2>个人用户免费使用 AI 设计</h2>
        <p>户型识别、二维图、3D 模型、效果图与报价对业主免费。履约服务费由装修公司按签约费率、成功阶段结算承担，独立会员服务另列。</p>
      </section>

      <section className="home-section home-note">
        <p className="editorial-kicker">CONTRACT & DELIVERY</p>
        <h2>方案确认之后，每一步都有共同记录</h2>
        <p>公司先确认报价，业主接受或还价；合同冻结后由业主、装修公司与平台各自签署。施工方提交资料，业主明确验收，再模拟分期结算与服务费。</p>
        <p className="wf-muted">当前提供演示签署与模拟资金，尚非正式电子签署或真实资金托管。</p>
      </section>

      <section className="home-join">
        <p className="editorial-kicker">GET STARTED</p>
        <h2>装潢公司入驻，接到合适的单</h2>
        <p>提交执照与资质，经人工审核后即可参与业主发布的项目。</p>
        <div className="landing-actions">
          <button type="button" className="btn btn-light" onClick={() => openAuth('register')}>个人用户注册</button>
          <button type="button" className="btn btn-outline-light" onClick={() => openAuth('register')}>装潢公司入驻</button>
        </div>
      </section>

      <footer className="home-foot">予舍 · AI 装修与履约协同</footer>
    </main>
  );
}
