# 合同与履约 API

合同有两种模式，创建工作流时确定，之后不变：

- `mode: "real"`（默认）：真实合同。签署和资金只接受 `sign`、`fund`、`release`、`refund`，并且每一次都必须有电子签署服务商或资金服务商返回的回执才会记录。**仓库不内置任何服务商，也没有接入任何服务商**；未配置时这些动作返回 503 `PROVIDER_NOT_CONFIGURED`，不会记录，也不会降级成演示。
- `mode: "demo"`：演示合同。`CONTRACT_MODE=demo` 决定原合同默认模式，也可用 `?mode=demo` 进入同订单独立的演示合同；此前已创建的每份合同保持自身模式，不随环境变量改变。演示合同只接受 `sign_demo`、`simulate_fund`、`simulate_release`、`simulate_refund`，不调用模型、签署商或真实支付。

两种模式互相拒绝对方的动作：真实合同收到演示动作、演示合同收到真实动作，都不会记录。只要请求本身格式有效，返回 409 `MODE_MISMATCH`；若请求里的图片或字段先通不过输入校验（例如 `sign_demo` 带了无效图片），则先返回 400 `INVALID_INPUT`。无论哪个错误码，都没有任何记录被写入，因此演示的签名和模拟资金不会被当作真实记录。旧历史合同只读，不能转换成任何一种签署。

`CONTRACT_MODE` 的取值只有精确的 `demo` 才启用演示，其余（未设置、空串、`DEMO`、`true` 等）一律是真实模式。

`GET /api/orders/:id/workflow` 返回 `WorkflowView`，按需初始化已中选订单；业主、该订单中选公司、boss 可读。boss 在本 API 内映射为 `platform`。其他投标公司的项目查看权不包含合同权。`GET ?format=html` 下载同一版本 HTML（所有用户字段转义）。

`POST /api/orders/:id/workflow`：`{ action, expectedRevision, requestKey, payload? }`。revision 是整个工作流的 CAS 整数，requestKey 是每次用户操作生成的唯一字符串（8～120 字符）。重复相同键和相同内容返回最新状态；不同内容复用键拒绝；过期 revision 返回 409。不接收 actor、成功状态或由客户端计算的费用。

```ts
type WorkflowRole = 'homeowner' | 'company' | 'platform';
type ContractMode = 'real' | 'demo';
// signed：真实合同三方签署完成；signed_demo：演示合同（含改动前已签的旧合同）三方签署完成。两者都视为“已签署”，正文只读。
type WorkflowStatus = 'awaiting_company' | 'awaiting_homeowner' | 'ready_to_freeze' | 'frozen' | 'partially_signed' | 'signed' | 'signed_demo' | 'superseded';
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
// 签署服务商返回的回执。字段是各家服务商通用的，不对应任何一家的接口。
type SigningReceipt = { provider: string; externalId: string; receiptId: string; signerVerified: boolean; signedAt: string; evidenceHash: string; certificateFingerprint?: string };
// 资金服务商对一次资金变动返回的回执。
type PaymentReceipt = { provider: string; externalId: string; receiptId: string; status: 'pending' | 'succeeded' | 'failed'; amountCents: number; confirmedAt?: string; reconciled: boolean };
type WorkflowView = {
  mode: ContractMode; id: string; orderId: number; projectId: number; revision: number; currentVersion: number;
  status: WorkflowStatus; versions: ContractVersion[]; current: ContractVersion;
  stages: StageProgress[]; transactions: WorkflowTransaction[]; disputes: WorkflowDispute[]; events: WorkflowEvent[];
  balanceCents: number; fundedCents: number; releasedCents: number; refundedCents: number; realizedFeeCents: number;
  reservedCents: number; availableCents: number; effective: ContractTerms; // effective = 现行条款（已签合同，或最近一份三方签署的补充协议）
  providerRequests?: ProviderRequest[]; supplements?: ContractSupplement[]; reconciliation?: ReconciliationReport;
  validation: { missing: string[]; errors: string[]; warnings: string[] }; draftText: string; todos: string[];
  allowedActions: string[]; legacyContract: boolean;
  aiReview: {status:'not_called'|'succeeded'|'failed';mode:'rules'|'model';summary?:string;issues?:string[];at?:string;error?:string;tokensUsed?:number};
};
// ProviderRequest: id, kind ('sign'|'fund'|'release'|'refund'), status (见“请求状态”), role, actorId, version, signerName?, termsHash?, supplementId?, amountCents?, stageId?, reason?, provider?, externalId?, actionUrl?（仅发起人可见）, expiresAt?, review?{decision,note,actorId,at}, hold?, failure?, createdAt, updatedAt, settledAt?.
// ContractSupplement: id, number, status ('proposed'|'frozen'|'partially_signed'|'signed'|'signed_demo'|'withdrawn'), reason, proposedBy, baseVersion, terms, changes[], confirmations, termsHash?, signatures[], finalFileHash?, effectiveAt?.
// SigningReceipt 另有可选字段：organizationVerified?（公司与平台必须为 true）、signerName?、termsHash?（回显时须与请求一致）、outcome?（'signed'|'declined'|'expired'）。
// ContractVersion: number, contractId, terms, status, confirmations {company?,homeowner?},
// signatures [{role,actorId,at,mode,signerName,termsHash,
//   演示合同: signatureDataUrl, sealDataUrl?, assetVersion?, signatureHash?, sealHash?, sealBinding?
//   真实合同: evidence: SigningReceipt（无签名图片，证据由服务商回执承载）}], termsHash?, finalFileHash?, frozenAt?, createdAt.
// StageProgress: stageId,status ('pending'|'submitted'|'rejected'|'accepted'|'settled'|'cancelled'), attempts[], acceptedAt?, settledAt?, cancelledAt?, cancellationDisputeId?.
// 每次attempt保留submittedAt/evidence/note及review(rejected|accepted)/reviewAt/reason。
// WorkflowTransaction: id,requestKey,type ('fund'|'release'|'refund'),amountCents,feeCents,netCents,stageId?,reason?,at,mode: ContractMode,receipt?: PaymentReceipt（真实合同必有）。
// WorkflowDispute: id,stageId,reason,evidence,status ('open'|'resolved'),createdAt,resolution?: {independentParty,basis,outcome,disposition:'continue'|'cancel_stage',at}。
// WorkflowEvent: id,action,actorId,role,version,at,mode: ContractMode,note?。
```

| action | 模式 | 角色 | payload 与行为 |
|---|---|---|---|
| revise | 两者 | 三方 | `{patch: Partial<ContractTerms>, note?: string}`；业主可改本人资料、面积/口径/风格、地点、参考附件；公司可改自身资料、范围、金额、工期、阶段、附件；平台可改自身资料与feeBps。source不可改。创建新版本，清空全部确认/签署，保留旧版；全签后拒绝，须补充协议。修改总价未传stages时自动按旧阶段比例重分配。 |
| negotiate | 两者 | 业主 | `{totalCents:number,note:string}`；新版本等待公司再确认。 |
| company_confirm | 两者 | 公司 | `{}`；确认当前报价/范围/工期。 |
| homeowner_accept | 两者 | 业主 | `{}`；必须公司已确认，进入ready_to_freeze。 |
| generate_draft | 两者 | 三方 | `{}`；生成规则草案、缺项与一致性校验（明确未调用模型）。 |
| ai_review | 两者 | 三方 | `{}`；主动发起只读工程复核。先鉴权/幂等/CAS/缺项检查，仅有模型配置时调用；数据不含主体、联系方式、签章图。结果写顶层aiReview，不能改合同或资金；异步期间改版则409丢弃结果。缺配置或失败为503，响应附`workflow`表示已持久化的诚实状态；同键重试返回200且不再调用模型。 |
| freeze | 两者 | 三方 | `{}`；双方确认且无缺项/金额错误后固定条款hash。 |
| sign_demo | 仅演示 | 三方 | `{signerName:string,signatureDataUrl:string,authorizeSeal?:boolean}`；只能本人角色签署。公司必须显式authorizeSeal=true且已保存私有公章。全部签署后signed_demo。 |
| sign | 仅真实 | 三方 | `{signerName:string, supplementId?:string}`；发起签署，向服务商创建签署会话，返回的请求带 `actionUrl`，此时**不记录签署**。签署记录由服务端取得的 `SigningReceipt` 写入。要求回执 `signerVerified=true`、`provider/externalId/receiptId` 非空、`evidenceHash` 为 64 位十六进制，且同一服务商的同一回执号不能用于两次签署；同一角色同一版本不能重复签署。公司签署时其合同主体资料须与已保存的签约资料一致。无回执返回 503 `PROVIDER_NOT_CONFIGURED`，回执未核验签署人返回 409 `SIGNER_NOT_VERIFIED`。三方全签后status为signed。 |
| submit_stage | 两者 | 公司 | `{stageId:string,evidence:WorkflowAttachment[],note:string}`；未结算阶段提交证据/整改。 |
| accept_stage | 两者 | 业主 | `{stageId:string}`；仅可验收已提交阶段。 |
| reject_stage | 两者 | 业主 | `{stageId:string,reason:string}`；保留驳回与重提历史。 |
| simulate_fund | 仅演示 | 业主 | `{amountCents:number}`；已三方签署后模拟充值，不算收入。 |
| simulate_release | 仅演示 | 业主 | `{stageId:string}`；服务端检查验收、争议及余额，金额/服务费取签约版本。 |
| simulate_refund | 仅演示 | 业主 | `{amountCents:number,reason:string}`；仅可退未结算余额，且保留已验收未结算阶段金额，无未决争议；理由入交易历史，已结算款不回写。 |
| fund | 仅真实 | 业主 | `{amountCents:number}`；创建服务商付款请求（含付款链接），回执成功且金额一致才入账。已发起未结束的入金请求也计入合同总价上限。回执须 `status='succeeded'` 且 `amountCents` 与本次金额完全相等，同一服务商的同一回执号只能用一次；累计入金不得超过合同总价。 |
| release | 仅真实 | 业主 | `{stageId:string}`；申请拨付，进入平台复核（见“出款复核”），回执金额须等于该阶段金额。验收、争议冻结、余额检查与演示相同；服务费由乙方承担，按累计结算额和签约费率逐阶段计收（默认 3%，分位舍入）。 |
| refund | 仅真实 | 业主 | `{amountCents:number,reason:string}`；申请退款，进入平台复核。规则同 simulate_refund：只退未结算余额，保留已验收未结算阶段的资金，有未决争议时禁止。 |
| review_payout | 仅真实 | 平台 | `{requestId:string,decision:"approve"|"reject",note:string}`；复核待复核的拨付或退款。 |
| cancel_request | 仅真实 | 发起人 | `{requestId:string}`；撤回自己的签署请求（未完成时）或尚未复核的出款请求。 |
| propose_supplement | 两者 | 业主/公司 | `{reason:string,patch:object}`；见“补充协议”。 |
| confirm_supplement | 两者 | 业主/公司 | `{supplementId:string}`；另一方确认，两方都确认后冻结。 |
| withdraw_supplement | 两者 | 三方 | `{supplementId:string}`；全部签署前撤回。 |
| open_dispute | 两者 | 业主/公司 | `{stageId:string,reason:string,evidence?:WorkflowAttachment[]}`；冻结本阶段未结算额。 |
| resolve_dispute | 两者 | 平台 | `{disputeId:string,independentParty:string,basis:string,outcome:string,disposition?:'continue'|'cancel_stage'}`；默认continue兼容。cancel_stage须有独立处理方和依据且阶段未结算，将进度标记cancelled、保留验收历史与原签约阶段金额，禁止再次提交/验收/出款；释放该阶段的未付资金保留，可另发退款。已结算款不能用此操作抹除，不从自由文本推断执行。 |

真实动作的错误码：`PROVIDER_NOT_CONFIGURED`（503，没有服务商或没有回执）、`SIGNER_NOT_VERIFIED`（409）、`INVALID_RECEIPT`（409，回执缺字段或摘要无效）、`RECEIPT_NOT_SUCCEEDED`（409，回执状态不是成功）、`RECEIPT_AMOUNT_MISMATCH`（409）、`RECEIPT_REUSED`（409）、`MODE_MISMATCH`（409）。

**服务商适配器（没有内置任何一家，需要部署方实现并注册）**：`packages/shared/src/contract-providers.ts` 定义 `SigningProvider`（`createSignRequest`、`fetchResult`、可选 `verifyCallback`）和 `PaymentProvider`（`createPayment`、`fetchPayment`、可选 `verifyCallback`），以及 `registerContractProviders`、`getContractProviders`、`requireSigningProvider`、`requirePaymentProvider`。部署方导出 `{ signing, payment }` 模块，启动服务时用环境变量 `CONTRACT_PROVIDER_MODULE` 指向它，由 `apps/web/instrumentation.ts` 加载注册；加载失败只写日志，真实动作继续返回 503。

**服务端流程**（真实合同）：

1. 当事人发 `sign`、`fund`，或平台对 `release`/`refund` 请求做 `review_payout` 通过。工作流只记下一条“服务商请求”（`providerRequests`），状态 `creating`，**不记录签署或资金**。
2. 路由在数据库锁之外调用适配器（`createSignRequest` / `createPayment`，以请求 id 作幂等键），把服务商页面链接 `actionUrl` 记入请求，状态变 `pending`。链接只对发起人可见。服务商拒绝受理则请求变 `failed`，并写明原因。
3. 当事人在服务商页面完成。随后由 `POST /api/orders/:id/workflow/sync`（订单任一当事人可调用）或服务商回调触发服务端向服务商查询（`fetchResult` / `fetchPayment`）。**浏览器提交的任何回执都不被接受**。
4. 只有服务商返回的回执通过校验才记录：签署回执须属于本次会话、签署人已核验、公司和平台须通过企业主体与授权核验（`organizationVerified`）、回执回显的签署人与条款摘要须与请求一致、回执号不可复用；资金回执须成功、金额与请求完全一致、回执号不可复用。签署人拒绝或会话过期则请求 `failed`，不记录。回执金额不一致等情形不入账，保留为 `pending` 并写入 `failure`，等待人工核对。
5. 合同在请求期间被修改或补充协议被撤回时，未完成的签署请求作废，迟到的回执不会被采用。

请求状态：`awaiting_review`（出款等待平台复核，尚未发给服务商，同时保留金额）、`creating`、`pending`（服务商已受理，只有服务商回执能结束它）、`succeeded`、`failed`、`rejected`（平台驳回）、`cancelled`。

`POST /api/orders/:id/workflow/sync`：任一当事人，取回所有未完成请求的服务商记录。`POST /api/orders/:id/workflow/reconcile`：仅平台；把每笔由回执入账的资金流水与资金服务商当前记录逐笔比对，结果写入 `reconciliation`（`ok`、`checked`、`matched`、`mismatches[]`），**只报告差异，不改任何金额**；服务商暂时不可查询时返回 503 `PROVIDER_UNAVAILABLE` 且不记录结果；未配置资金服务商返回 503 `PROVIDER_NOT_CONFIGURED`。`POST /api/contract-providers/signing/callback` 与 `.../payment/callback`：由适配器的 `verifyCallback` 校验，校验失败 401 `INVALID_CALLBACK`；回调只指明要查哪一笔，正文从不写入合同；请求体上限 1 MB。

回调以“适配器服务商名称 + 签署/支付类别 + 外部单号”定位订单，仅同步该范围内的回执，不因回调派发其他待发送请求。不同服务商或类别的相同单号互不干扰；同一范围若对应多个合同或同一合同内的多个请求，返回 409 `AMBIGUOUS_PROVIDER_REFERENCE`，不选择第一条、不修改合同，须人工核对服务商编号映射。适配器名称应保持稳定并唯一标识同一服务商实例。主动同步接口仍可按当事人权限处理整个订单的待办。

**出款复核**：真实合同的 `release`（申请拨付）与 `refund`（申请退款）先生成 `awaiting_review` 请求并保留金额（`reservedCents`，`availableCents = balanceCents − reservedCents`）。只有平台可 `review_payout`：`{requestId, decision: "approve"|"reject", note}`（复核意见必填）；通过时会重新检查验收、争议、余额与“已验收款保留”，再交服务商；驳回则释放保留。发起人可在复核前用 `cancel_request` 撤回；已交给服务商的出款不能在本地撤回。该阶段提出争议时，等待复核的出款被撤回，已在服务商处理的出款标记 `hold`（“暂停”，结果仍以服务商回执为准），出款未结清的阶段不能被 `resolve_dispute` 解除（409 `PAYOUT_IN_FLIGHT`）。

**补充协议**（已签合同只能这样变更）：`propose_supplement` `{reason, patch}`（业主或公司；`patch` 只能含 `scope`、`totalCents`、`durationDays`、`stages`、`attachments`、`area`、`areaBasis`、`style`、`location`；改总价须同时给出新的分期；不能改当事人资料、平台费率或上游快照）→ 对方 `confirm_supplement` `{supplementId}` → 冻结并算出 `termsHash` → 三方各自 `sign`/`sign_demo`（payload 带 `supplementId`）→ 全部签署后取代对应条款，`view.effective` 给出现行条款。已提交、验收或结算的阶段不能变更（409 `STAGE_LOCKED`）；同一时间只有一份进行中的补充协议（409 `SUPPLEMENT_IN_PROGRESS`）；`withdraw_supplement` 可在全部签署前撤回。补充协议有独立文件：`GET ?format=html&supplement=<id>`，响应头 `X-Contract-Artifact-SHA256`。已签合同正文和它的 `finalFileHash` 不变。

前置条件不满足时先返回对应的 409：例如合同未冻结时 `sign` 返回 `INVALID_STATE`，未完成三方签署时 `fund` 返回 `INVALID_STATE`；没有注册服务商时，`sign` 在请求创建后被标记 `failed`（“未配置电子签署服务商”），`release`、`refund` 的复核通过返回 503 `PROVIDER_NOT_CONFIGURED`，签名数和资金账本不变。

`GET/PUT /api/company/contract-profile` 仅当前公司可读写。PUT `{party: ContractParty, authorizedSignerName:string, sealDataUrl?:string}`，返回自有资料；原公章仅保存私有数据库，使用时必须明确授权。服务端sharp实际解码（最多1600万像素）后，合成含contractId/version与DEMO标识的640×360派生PNG；只有派生图进入签署快照，原图不进入合同视图或导出。签名也生成绑定版本和角色的应用图，原签名请求仅存hash。其他方看不到可复用原章资料。上传仅PNG/JPEG/WebP，magic与声明类型一致，每张最大1MiB，最多12个附件；禁止SVG。URL参考必须https且注明未冻结外部内容。

前端使用 `import type {...} from '@i-renovation/shared/workflow'`，如需金额/默认阶段函数也可从该纯模块导入。不得从shared主入口导入运行时代码（会引入db/fs）。错误响应 `{error, code}`，401未登录，403角色/归属不符，404订单不存在，409状态/版本冲突，400输入不合规。金额全部使用整数分；feeBps允许0至10000的整数，300表示3%，费用由乙方承担，仅成功的阶段结算计收（演示合同为模拟结算，真实合同为带成功回执的结算）。服务费规则在两种模式下相同，未改变。

历史合同原文通过legacyContent/draftText只读呈现，legacyContract=true时allowedActions为空，不补造三方签署事件。已有工作流的项目禁止硬删；历史已签或有分成历史的项目也禁止删除（409 HISTORY_PROTECTED）。

三方全签（`signed` 或 `signed_demo`）时保存`current.finalFileHash`（稳定HTML文件的SHA-256）；HTML响应带`X-Contract-Artifact-SHA256`。真实合同的HTML正文末尾说明签署回执和资金回执以服务商为准，不再写“产品演示、不承诺法律效力”；条款的法律效力和适用法律仍须各方自行复核。后续验收、交易、争议和模型复核另存履约账本，不改已签HTML内容。冻结条款摘要`termsHash`与最终含签章文件摘要分别记录，签名逐方加入不视为条款变更。

`draftText`追加从当前版本冻结的`source.quote`读取的数量/单位/单价/小计及中选报价说明，以及`source.design`的可读说明。上游报价段最多6000字符、设计段最多9000字符，并显示截取提示；图片/URL/base64等字段不混入说明。输出为纯文本，HTML统一转义，工作台沿用draftText展示；上游活数据覆盖不会回写该快照。

服务端实现：`getOrderWorkflow(orderId, actor)`、`actOnOrderWorkflow(orderId, actor, command)`；慢速适配器先`prepareWorkflowCommand`，再调用`recordAIReview(orderId, actor, command, review)`按原revision保存。公司资料`getContractProfile(actor)`、`putContractProfile(actor,input)`。原始公章仅这两个公司私有接口可读；合同仅包含明确授权后应用的资产副本。


## 同订单演示与真实合同并存

工作台提供“演示合同 / 真实合同”按钮。GET、POST `/api/orders/:id/workflow`、POST `/sync`、POST `/reconcile` 支持查询参数 `mode=demo|real`；HTML及补充协议下载同样携带 mode。省略 mode 保持原合同兼容行为，非法值返回400。授权仍按订单参与方检查，模式选择不会绕过权限。

首次进入另一模式时，按当前中选报价及项目资料创建未确认的新合同，不复制原合同的签名、流水、阶段验收、争议、补充协议或模型复核结果。公司私有签约资料仍按公司账号共用；每份合同须各自确认和签署。切换仅改变当前查看/操作对象，不转换旧合同的法律或资金性质。

原记录保留在 contract_workflows，另一份保存在新增的 contract_workflow_variants；启动自动建表，不重写原合同、不清库。两份合同使用独立幂等命名空间和合同编号；请求内模式隔离，不改变其他参与方当前查看模式。回调查询两处真实请求存储并沿原回调隔离规则处理；平台待办标明模式，并打开相应合同。
