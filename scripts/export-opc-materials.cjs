// Generate the downloadable materials from the same facts used by /opc.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const mod = { exports: {} };
new Function('module', 'exports', ts.transpileModule(fs.readFileSync(path.join(root, 'apps/web/lib/opc-content.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(mod, mod.exports);
const { BUSINESS_CANVAS, ROLE_SHEETS, DEMO_STEPS } = mod.exports;
const sections = [
  '# 予舍｜商业模式画布、岗位说明与演示材料',
  '版本日期：2026-11-14。产品定位为 AI 装修智能体团队。本文描述当前方案；外部模型效果、成本、获客与收入数据没有实测的部分均不作完成承诺。',
  '## 一、商业模式画布',
  ...BUSINESS_CANVAS.map(item => `### ${item.title}\n\n${item.body}`),
  '## 二、岗位说明书',
  '主讲岗位建议候选为小测（图片户型识别路径）：具有真实模型入口，能将图片交接成可复核房间与几何数据。最终选用前必须完成真实模型预演；没有密钥或模型不可用时，不把人工画板路径称为模型成功。本轮未作“最稳定岗位”结论。',
  ...ROLE_SHEETS.map(role => `### ${role.name}\n\n- 输入：${role.input}\n- 执行方式：${role.work}\n- 交付：${role.output}\n- 人工介入：${role.human}\n- 验收标准：${role.acceptance}`),
  '### 签约与履约的接续边界',
  '签约辅助接续已确认的方案与报价，提供规则草案和可选模型复核。三方确认、签署、用章、施工验收和资金决定由有权限的人操作。当前签署、资金使用演示模式；正式电子签署、真实资金托管与出款未接入。',
  '## 三、5 分钟路演脚本',
  '| 时间 | 内容 | 操作与证据 |\n|---|---|---|\n' + DEMO_STEPS.map(row => `| ${row.join(' | ')} |`).join('\n'),
  '### 2 分钟问答准备',
  '- AI 做了什么？按真实路径解释图片识别与图像模型；调度、二维/3D、报价、QA 中的规则如实说明。\n- 谁付费？业主免费设计，装修公司按约定阶段结算承担服务费；会员独立，不等于已验证收入。\n- 人为什么需要介入？确认需求、价格、主体授权、签署和现场验收。\n- 效率与成本如何？提供实测样本；暂未测量就明确待测，不能填推算数字冒充结果。',
  '## 四、演示与备用流程',
  '1. 使用明确标记的合成户型与项目，准备可访问的模型配置，先完成一次真实预演。\n2. 主演示从真实输入开始，显示实际任务编号与本轮交付面板；成果仅“可复核”，不自动称为业主已接受。\n3. 缺输入时补资料；模型超时/失败时按真实提示重试或转人工，不能提前写入 done。\n4. 模型不可用时展示已保存成果或录像，注明生成时间和“备用历史结果”；人工画板路径注明人工标注。\n5. 合同样例演示时注明合成主体、演示签署和模拟资金。',
  '## 五、提交与评分证据',
  '| 维度 | 应提供的证据 | 当前材料对应 |\n|---|---|---|\n| 智能体 30 | 输入、实际执行、成果、异常处理 | 六岗位说明、项目任务及交付面板；模型现场预演待完成 |\n| 商业闭环 30 | 客户、价值、交付、定价与成本 | 本画布、方案确认与承接履约链；收入与成本待验证 |\n| 创新 25 | 相比原流程的明确改进 | 同源空间数据、可复核报价、版本合同与阶段记录；效果需案例证实 |\n| 表达 15 | 五分钟内清楚讲出问题与成果 | 本脚本及真实交付记录 |',
  '必交内容按海报为商业模式画布、岗位说明书、可演示 AI 员工；代码与文档齐全不等于已经完成现场真实模型演示。晋级后按完整手册准备 PPT。',
  '## 六、既有基础与赛内新增披露',
  '| 类别 | 内容 | 时间/提交/证据 |\n|---|---|---|\n| 既有基础 | 户型、设计、同源 3D、报价、质检、匹配与角色体系 | 保留原仓库和历史提交，现场说明 |\n| 本地前序修改 | 三方合同、签约履约；恢复团队定位 | 本地提交 adf4b00、2d9cef5；并非自动归为赛内成果 |\n| 本轮新增 | 交付证据、进度修正、报价与工期一致性、商业模式和岗位材料 | 以最终提交和修改记录为准 |\n| 赛事规定 48 小时内新增 | 待按实际参赛时间核实填写 | 待填写：开始时间、结束时间、提交号和演示证据 |',
  '不得仅依据本地修改日期，把前序或本轮工作全部宣称为赛事规定时间内新增。完整代码验证及未完成项见项目 docs/赛题对齐与后续修改记录.md。',
];
const content = sections.join('\n\n') + '\n';
for (const relative of ['docs/参赛交付材料.md', 'apps/web/public/docs/opc-materials.md']) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}
console.log('Updated docs/参赛交付材料.md and public download from shared OPC content');
