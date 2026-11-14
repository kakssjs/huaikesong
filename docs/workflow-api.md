# 合同与履约演示 API

所有签署、资金和导出固定 `mode: "demo"`，不调用模型、签署商或真实支付。旧历史合同只读，不能转换成演示签署。

`GET /api/orders/:id/workflow` 返回 `WorkflowView`，按需初始化已中选订单；业主、该订单中选公司、boss 可读。boss 在本 API 内映射为 `platform`。其他投标公司的项目查看权不包含合同权。`GET ?format=html` 下载同一版本 HTML（所有用户字段转义）。

`POST /api/orders/:id/workflow`：`{ action, expectedRevision, requestKey, payload? }`。revision 是整个工作流的 CAS 整数，requestKey 是每次用户操作生成的唯一字符串（8～120 字符）。重复相同键和相同内容返回最新状态；不同内容复用键拒绝；过期 revision 返回 409。不接收 actor、成功状态或由客户端计算的费用。

```ts
type WorkflowRole = 'homeowner' | 'company' | 'platform';
type WorkflowStatus = 'awaiting_company' | 'awaiting_homeowner' | 'ready_to_freeze' | 'frozen' | 'partially_signed' | 'signed_demo' | 'superseded';
type ContractParty = { legalName: string; registrationId: string; representative: string; contact: string; address?: string };
type WorkflowAttachment = { id: string; name: string; kind: 'reference' | 'plan' | 'quote' | 'material'; dataUrl?: string; url?: string; note?: string };
type StagePlan = { id: string; name: string; amountCents: number; acceptanceCriteria: string; plannedDate?: string };
type ContractTerms = {
  homeowner: ContractParty; company: ContractParty; platform: ContractParty;
  projectName: string; location: string; area: number; areaBasis: string; style: string;
  scope: string; totalCents: number; durationDays: number; feeBps: number;
  stages: StagePlan[]; attachments: WorkflowAttachment[];
  source: { project: unknown; quote: unknown; design: unknown };
};
type WorkflowView = {
  mode: 'demo'; id: string; orderId: number; projectId: number; revision: number; currentVersion: number;
  status: WorkflowStatus; versions: ContractVersion[]; current: ContractVersion;
  stages: StageProgress[]; transactions: WorkflowTransaction[]; disputes: WorkflowDispute[]; events: WorkflowEvent[];
  balanceCents: number; fundedCents: number; releasedCents: number; refundedCents: number; realizedFeeCents: number;
  validation: { missing: string[]; errors: string[]; warnings: string[] }; draftText: string; todos: string[];
  allowedActions: string[]; legacyContract: boolean;
  aiReview: {status:'not_called'|'succeeded'|'failed';mode:'rules'|'model';summary?:string;issues?:string[];at?:string;error?:string;tokensUsed?:number};
};
// ContractVersion: number, contractId, terms, status, confirmations {company?,homeowner?},
// signatures [{role,actorId,at,mode,signerName,signatureDataUrl,sealDataUrl?,termsHash,assetVersion?,signatureHash?}], termsHash?, finalFileHash?, frozenAt?, createdAt.
// StageProgress: stageId,status ('pending'|'submitted'|'rejected'|'accepted'|'settled'|'cancelled'), attempts[], acceptedAt?, settledAt?, cancelledAt?, cancellationDisputeId?.
// 每次attempt保留submittedAt/evidence/note及review(rejected|accepted)/reviewAt/reason。
// WorkflowTransaction: id,requestKey,type ('fund'|'release'|'refund'),amountCents,feeCents,netCents,stageId?,at,mode:'demo'.
// WorkflowDispute: id,stageId,reason,evidence,status ('open'|'resolved'),createdAt,resolution?: {independentParty,basis,outcome,disposition:'continue'|'cancel_stage',at}。
// WorkflowEvent: id,action,actorId,role,version,at,mode:'demo',note?。
```

| action | 角色 | payload 与行为 |
|---|---|---|
| revise | 三方 | `{patch: Partial<ContractTerms>, note?: string}`；业主可改本人资料、面积/口径/风格、地点、参考附件；公司可改自身资料、范围、金额、工期、阶段、附件；平台可改自身资料与feeBps。source不可改。创建新版本，清空全部确认/签署，保留旧版；全签后拒绝，须补充协议。修改总价未传stages时自动按旧阶段比例重分配。 |
| negotiate | 业主 | `{totalCents:number,note:string}`；新版本等待公司再确认。 |
| company_confirm | 公司 | `{}`；确认当前报价/范围/工期。 |
| homeowner_accept | 业主 | `{}`；必须公司已确认，进入ready_to_freeze。 |
| generate_draft | 三方 | `{}`；生成规则草案、缺项与一致性校验（明确未调用模型）。 |
| ai_review | 三方 | `{}`；主动发起只读工程复核。先鉴权/幂等/CAS/缺项检查，仅有模型配置时调用；数据不含主体、联系方式、签章图。结果写顶层aiReview，不能改合同或资金；异步期间改版则409丢弃结果。缺配置或失败为503，响应附`workflow`表示已持久化的诚实状态；同键重试返回200且不再调用模型。 |
| freeze | 三方 | `{}`；双方确认且无缺项/金额错误后固定条款hash。 |
| sign_demo | 三方 | `{signerName:string,signatureDataUrl:string,authorizeSeal?:boolean}`；只能本人角色签署。公司必须显式authorizeSeal=true且已保存私有公章。全部签署后signed_demo。 |
| submit_stage | 公司 | `{stageId:string,evidence:WorkflowAttachment[],note:string}`；未结算阶段提交证据/整改。 |
| accept_stage | 业主 | `{stageId:string}`；仅可验收已提交阶段。 |
| reject_stage | 业主 | `{stageId:string,reason:string}`；保留驳回与重提历史。 |
| simulate_fund | 业主 | `{amountCents:number}`；已三方签署后模拟充值，不算收入。 |
| simulate_release | 业主 | `{stageId:string}`；服务端检查验收、争议及余额，金额/服务费取签约版本。 |
| simulate_refund | 业主 | `{amountCents:number,reason:string}`；仅可退未结算余额，且保留已验收未结算阶段金额，无未决争议；理由入交易历史，已结算款不回写。 |
| open_dispute | 业主/公司 | `{stageId:string,reason:string,evidence?:WorkflowAttachment[]}`；冻结本阶段未结算额。 |
| resolve_dispute | 平台 | `{disputeId:string,independentParty:string,basis:string,outcome:string,disposition?:'continue'|'cancel_stage'}`；默认continue兼容。cancel_stage须有独立处理方和依据且阶段未结算，将进度标记cancelled、保留验收历史与原签约阶段金额，禁止再次提交/验收/出款；释放该阶段的未付资金保留，可另发退款。已结算款不能用此操作抹除，不从自由文本推断执行。 |

`GET/PUT /api/company/contract-profile` 仅当前公司可读写。PUT `{party: ContractParty, authorizedSignerName:string, sealDataUrl?:string}`，返回自有资料；原公章仅保存私有数据库，使用时必须明确授权。服务端sharp实际解码（最多1600万像素）后，合成含contractId/version与DEMO标识的640×360派生PNG；只有派生图进入签署快照，原图不进入合同视图或导出。签名也生成绑定版本和角色的应用图，原签名请求仅存hash。其他方看不到可复用原章资料。上传仅PNG/JPEG/WebP，magic与声明类型一致，每张最大1MiB，最多12个附件；禁止SVG。URL参考必须https且注明未冻结外部内容。

前端使用 `import type {...} from '@i-renovation/shared/workflow'`，如需金额/默认阶段函数也可从该纯模块导入。不得从shared主入口导入运行时代码（会引入db/fs）。错误响应 `{error, code}`，401未登录，403角色/归属不符，404订单不存在，409状态/版本冲突，400输入不合规。金额全部使用整数分；feeBps允许0至10000的整数，300表示3%，费用由乙方承担，仅成功模拟阶段结算计收。

历史合同原文通过legacyContent/draftText只读呈现，legacyContract=true时allowedActions为空，不补造三方签署事件。已有工作流的项目禁止硬删；历史已签或有分成历史的项目也禁止删除（409 HISTORY_PROTECTED）。

三方全签时保存`current.finalFileHash`（稳定HTML文件的SHA-256）；HTML响应带`X-Contract-Artifact-SHA256`。后续验收、交易、争议和模型复核另存履约账本，不改已签HTML内容。冻结条款摘要`termsHash`与最终含签章文件摘要分别记录，签名逐方加入不视为条款变更。

`draftText`追加从当前版本冻结的`source.quote`读取的数量/单位/单价/小计及中选报价说明，以及`source.design`的可读说明。上游报价段最多6000字符、设计段最多9000字符，并显示截取提示；图片/URL/base64等字段不混入说明。输出为纯文本，HTML统一转义，工作台沿用draftText展示；上游活数据覆盖不会回写该快照。

服务端实现：`getOrderWorkflow(orderId, actor)`、`actOnOrderWorkflow(orderId, actor, command)`；慢速适配器先`prepareWorkflowCommand`，再调用`recordAIReview(orderId, actor, command, review)`按原revision保存。公司资料`getContractProfile(actor)`、`putContractProfile(actor,input)`。原始公章仅这两个公司私有接口可读；合同仅包含明确授权后应用的资产副本。
