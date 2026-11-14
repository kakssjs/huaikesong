const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ts = require('typescript');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const dir = path.join(__dirname, '.workflow-regression');
fs.mkdirSync(dir, { recursive: true });
for (const name of fs.readdirSync(path.join(__dirname, '../packages/shared/src')).filter(f => f.endsWith('.ts'))) {
  fs.writeFileSync(path.join(dir, name.replace(/\.ts$/, '.js')), ts.transpileModule(
    fs.readFileSync(path.join(__dirname, '../packages/shared/src', name), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText);
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yushe-workflow-'));
process.env.IRENO_PGLITE_DIR = dataDir;
process.env.RUNNER_ENABLED = 'false';
const db = require('./.workflow-regression/db.js');
const domain = fs.existsSync(path.join(dir, 'workflow.js')) ? require('./.workflow-regression/workflow.js') : {};
const service = fs.existsSync(path.join(dir, 'workflow-db.js')) ? require('./.workflow-regression/workflow-db.js') : {};
const sharp = require('sharp');
let image, sealImage;
before(async()=>{
  image='data:image/png;base64,'+(await sharp({create:{width:120,height:60,channels:4,background:{r:30,g:60,b:90,alpha:1}}}).png().toBuffer()).toString('base64');
  sealImage='data:image/png;base64,'+(await sharp({create:{width:180,height:180,channels:4,background:{r:190,g:35,b:30,alpha:0.7}}}).png().toBuffer()).toString('base64');
});
const party = name => ({ legalName: name, registrationId: 'DEMO-001', representative: name, contact: '演示联系人', address: '演示地址' });
const boss = { uid: 0, role: 'boss' };
after(async () => { await (await db.getDb()).$client.close(); fs.rmSync(dataDir, { recursive: true }); });

test('workflow feature exposes a pure, fen-based contract domain', () => {
  assert.equal(typeof domain.defaultStagePlan, 'function', 'missing workflow domain');
  assert.equal(typeof service.getOrderWorkflow, 'function', 'missing persisted workflow service');
  assert.equal(domain.defaultStagePlan(100003).reduce((s, x) => s + x.amountCents, 0), 100003);
  assert.throws(() => domain.validateImageDataUrl('data:image/svg+xml;base64,PHN2Zy8+'));
  assert.throws(() => domain.validateImageDataUrl('data:image/png;base64,SGVsbG8='));
  assert.equal(domain.validateImageDataUrl(image), image);
});

test('new bidding service fee uses transaction value at 3%, never legacy profit 10%', () => {
  const commission=require('./.workflow-regression/commission.js');
  assert.equal(typeof commission.estimateContractServiceFee,'function');
  const quote=commission.estimateContractServiceFee({amount:'10.000001',estimatedCost:'8',amountInWan:true});
  assert.equal(quote.revenueCny,100000.01); assert.equal(quote.platformCommissionCny,3000);
  assert.equal(quote.commissionRate,0.03); assert.match(quote.note,/预估|未收费/);
});

let fixtureNo = 0;
async function fixture() {
  const owner = await db.createUser({ role: 'homeowner', name: '<业主>', phone: `演示联系-${++fixtureNo}` });
  const company = await db.createUser({ role: 'company', name: '装企', companyName: '演示公司' });
  const other = await db.createUser({ role: 'company', name: '无关公司' });
  await db.setUserVerified(company.id, 1);
  await db.setCompanyMembership(company.id, { membershipStatus: 'active', membershipExpiresAt: new Date(Date.now()+86400000).toISOString() });
  const p = await db.createProject({ homeownerId: owner.id, name: '<测试项目>', style: '现代简约', area: '100', budget: '10', address: '演示工地' });
  await db.upsertResult(p.id, 'quote', { total: 100000, items: [{ item: '施工', qty: 100, unit: '㎡', price: 1000, total: 100000 }] });
  await db.upsertResult(p.id, 'design', { note: '原方案', imageUrl: 'https://example.test/reference.png' });
  const order = await db.createOrder({ projectId: p.id, homeownerId: owner.id });
  await db.createBid({ orderId: order.id, companyId: company.id, companyName: '演示公司', amount: '10', weeks: '8' });
  await db.selectOrderCompany(order.id, company.id);
  const actors = { owner: {uid:owner.id,role:'homeowner'}, company: {uid:company.id,role:'company'}, other:{uid:other.id,role:'company'}, boss };
  const f = { p, order, actors, view: null, seq: 0 };
  f.view = await service.getOrderWorkflow(order.id, actors.owner);
  f.act = async (who, action, payload = {}, extra = {}) => f.view = await service.actOnOrderWorkflow(order.id, actors[who], {
    action, expectedRevision: f.view.revision, requestKey: `request-${order.id}-${++f.seq}`, payload, ...extra });
  return f;
}
async function ready(f) {
  await service.putContractProfile(f.actors.company, { party:party('演示装企'), authorizedSignerName:'授权人', sealDataUrl:sealImage });
  await f.act('company','revise',{patch:{company:party('演示装企'),scope:'全部约定施工',durationDays:56}});
  await f.act('owner','revise',{patch:{homeowner:party('演示业主'),areaBasis:'实际施工面积'}});
  await f.act('boss','revise',{patch:{platform:party('予舍演示主体'),feeBps:300}});
  await f.act('company','company_confirm'); await f.act('owner','homeowner_accept');
  assert.deepEqual(f.view.validation.missing, []);
  await f.act('owner','freeze');
  return f;
}
async function signed(f) {
  await ready(f);
  await f.act('owner','sign_demo',{signerName:'业主',signatureDataUrl:image});
  await assert.rejects(f.act('company','sign_demo',{signerName:'公司',signatureDataUrl:image}), /授权/);
  await f.act('company','sign_demo',{signerName:'授权人',signatureDataUrl:image,authorizeSeal:true});
  await f.act('boss','sign_demo',{signerName:'平台',signatureDataUrl:image});
  assert.equal(f.view.status,'signed_demo'); return f;
}

test('company confirms first; missing data blocks freeze; negotiation archives confirmations and partial signatures', async () => {
  const f=await fixture();
  assert.equal(f.view.mode,'demo'); assert.ok(f.view.validation.missing.length);
  await assert.rejects(f.act('owner','homeowner_accept'), /公司/);
  await f.act('company','company_confirm'); await f.act('owner','homeowner_accept');
  await assert.rejects(f.act('owner','freeze'), /缺项|校验/);
  await ready(f); await f.act('owner','sign_demo',{signerName:'业主',signatureDataUrl:image});
  const oldVersion=f.view.currentVersion;
  await f.act('owner','negotiate',{totalCents:9999999,note:'申请调整'});
  assert.equal(f.view.currentVersion,oldVersion+1); assert.equal(f.view.status,'awaiting_company');
  assert.equal(f.view.current.signatures.length,0); assert.equal(f.view.versions.at(-2).signatures.length,1);
  assert.equal(f.view.current.terms.stages.reduce((s,x)=>s+x.amountCents,0),9999999);
  await assert.rejects(f.act('owner','homeowner_accept'),/公司/);
});

test('persistent snapshots, contract permissions, private company seal and escaped HTML are enforced', async () => {
  const f=await fixture();
  await assert.rejects(service.getOrderWorkflow(f.order.id,f.actors.other), /无权/);
  await service.putContractProfile(f.actors.company,{party:party('企业'),authorizedSignerName:'代表',sealDataUrl:image});
  assert.equal((await service.getContractProfile(f.actors.company)).sealDataUrl,image);
  await assert.rejects(service.getContractProfile(f.actors.owner), /公司/);
  assert.equal(JSON.stringify(f.view).includes(image),false);
  await db.upsertResult(f.p.id,'design',{note:'被替换方案'});
  const restored=await service.getOrderWorkflow(f.order.id,f.actors.boss);
  assert.equal(restored.current.terms.source.design.note,'原方案');
  assert.ok(domain.renderWorkflowHtml(restored).includes('&lt;测试项目&gt;'));
  assert.ok(domain.renderWorkflowHtml(restored).includes('演示'));
});

test('stage math and input validation reject spoofed assets and invalid allocations', async () => {
  const f=await fixture();
  await assert.rejects(f.act('company','revise',{patch:{stages:[{id:'x',name:'x',amountCents:2,acceptanceCriteria:'标准'}]}}),/合计/);
  await assert.rejects(f.act('owner','revise',{patch:{attachments:[{id:'x',name:'x',kind:'reference',dataUrl:'data:image/svg+xml;base64,PHN2Zy8+'}]}}),/图片|格式/);
  await assert.rejects(f.act('owner','revise',{patch:{company:party('伪造公司')}}),/无权/);
  await assert.rejects(f.act('company','revise',{patch:{totalCents:1.5}}),/整数/);
});

test('fee basis-point bounds are consistently inclusive 0 to 10000 in contracts, revisions and bid estimates', async()=>{
  const f=await fixture(),commission=require('./.workflow-regression/commission.js');
  for(const feeBps of [0,300,10000]){
    await f.act('boss','revise',{patch:{feeBps}});
    assert.equal(f.view.current.terms.feeBps,feeBps);
    assert.equal(domain.validateContractTerms(f.view.current.terms).errors.some(x=>/费率/.test(x)),false);
    assert.equal(commission.estimateContractServiceFee({amount:100,amountInWan:false,feeBps}).platformCommissionCny,feeBps/100);
  }
  for(const feeBps of [-1,10001,0.5]){
    await assert.rejects(f.act('boss','revise',{patch:{feeBps}}),/费率/);
    assert.throws(()=>commission.estimateContractServiceFee({amount:100,amountInWan:false,feeBps}),/费率/);
    assert.ok(domain.validateContractTerms({...f.view.current.terms,feeBps}).errors.some(x=>/费率/.test(x)));
  }
});

test('company signs with a contract-bound derived seal PNG; original seal stays only in the private profile', async()=>{
  const f=await signed(await fixture());
  const signature=f.view.current.signatures.find(x=>x.role==='company');
  assert.equal(signature.sealDataUrl===sealImage,false,'contract snapshot must not contain original seal bytes');
  for(const actor of [f.actors.owner,f.actors.company,f.actors.boss]){
    const view=await service.getOrderWorkflow(f.order.id,actor);
    assert.equal(JSON.stringify(view).includes(sealImage),false);
    assert.equal(domain.renderWorkflowHtml(view).includes(sealImage),false);
  }
  assert.equal((await service.getContractProfile(f.actors.company)).sealDataUrl,sealImage);
  const metadata=await sharp(Buffer.from(signature.sealDataUrl.split(',')[1],'base64')).metadata();
  assert.equal(metadata.format,'png');assert.ok(metadata.width<=640&&metadata.height<=480);
  assert.equal(typeof service.deriveContractSeal,'function');
  const v2=await service.deriveContractSeal(sealImage,f.view.current.contractId,f.view.currentVersion+1);
  assert.notEqual(v2,signature.sealDataUrl,'contract version must be visible in the watermarked derivative');
  for(const format of ['png','jpeg','webp']){
    const original=await sharp({create:{width:100,height:100,channels:3,background:'#aa2020'}}).toFormat(format).toBuffer();
    const encoded=`data:image/${format};base64,${original.toString('base64')}`;
    const derived=await service.deriveContractSeal(encoded,'contract-format-test',1);
    assert.match(derived,/^data:image\/png;base64,/);assert.notEqual(derived,encoded);
  }
  const invalid='data:image/png;base64,'+Buffer.from([137,80,78,71,13,10,26,10,...new Array(24).fill(0)]).toString('base64');
  await assert.rejects(service.putContractProfile(f.actors.company,{party:party('演示装企'),authorizedSignerName:'授权人',sealDataUrl:invalid}),/解码|图片/);
});

test('frozen draft and HTML expose safe, bounded quote itemization and design notes from the saved upstream snapshot', async()=>{
  const f=await fixture();
  assert.match(f.view.draftText,/施工.*100.*1000.*100000/);
  assert.match(f.view.draftText,/原方案/);
  const terms=structuredClone(f.view.current.terms);
  terms.source.quote={items:[{item:'<script>报价</script>',qty:1,unit:'套',price:200,total:200}]};
  terms.source.design={note:'<script>说明</script>',rooms:[{name:'客厅',description:'采光与动线'}],huge:'长'.repeat(100000),imageUrl:'https://example.test/image.png'};
  const view=domain.workflowView({...f.view,versions:[{...f.view.current,terms}]},f.actors.owner);
  assert.match(view.draftText,/采光与动线/);assert.ok(view.draftText.length<25000);
  const html=domain.renderWorkflowHtml(view);assert.ok(html.includes('&lt;script&gt;报价&lt;/script&gt;'));assert.equal(html.includes('<script>'),false);
  await db.upsertResult(f.p.id,'quote',{items:[{item:'替换报价'}]});await db.upsertResult(f.p.id,'design',{note:'替换说明'});
  const stable=await service.getOrderWorkflow(f.order.id,f.actors.owner);
  assert.match(stable.draftText,/原方案/);assert.equal(stable.draftText.includes('替换说明'),false);
});

test('documented independent cancellation releases an accepted unpaid stage reservation without erasing acceptance or signed terms', async()=>{
  const f=await signed(await fixture()),stageId=f.view.current.terms.stages[0].id,termsHash=f.view.current.termsHash,finalFileHash=f.view.current.finalFileHash;
  await f.act('owner','simulate_fund',{amountCents:f.view.current.terms.totalCents});
  await f.act('company','submit_stage',{stageId,evidence:[{id:'cancel-proof',name:'争议照片',kind:'reference',dataUrl:image}],note:'验收资料'});
  await f.act('owner','accept_stage',{stageId});await f.act('owner','open_dispute',{stageId,reason:'申请终止本阶段'});
  const disputeId=f.view.disputes[0].id;
  await assert.rejects(f.act('boss','resolve_dispute',{disputeId,disposition:'cancel_stage'}),/依据|处理/);
  await f.act('boss','resolve_dispute',{disputeId,independentParty:'演示独立调解方',basis:'各方确认的取消与退款记录',outcome:'取消阶段，退还未结算资金',disposition:'cancel_stage'});
  assert.equal(f.view.stages[0].status,'cancelled');assert.equal(f.view.stages[0].attempts.at(-1).review,'accepted');
  assert.equal(f.view.disputes[0].resolution.disposition,'cancel_stage');
  assert.equal(f.view.current.termsHash,termsHash);assert.equal(f.view.current.finalFileHash,finalFileHash);
  await assert.rejects(f.act('company','submit_stage',{stageId,evidence:[],note:'再次提交'}));
  await assert.rejects(f.act('owner','accept_stage',{stageId}));await assert.rejects(f.act('owner','simulate_release',{stageId}));
  await f.act('owner','simulate_refund',{amountCents:f.view.balanceCents,reason:'按独立处理依据退回未结算款'});
  assert.equal(f.view.balanceCents,0);assert.equal(f.view.refundedCents,f.view.fundedCents);assert.equal(f.view.releasedCents,0);
});

test('three parties sign explicitly; full signature locks text; legacy API and hard delete cannot bypass', async () => {
  const f=await signed(await fixture());
  assert.equal(f.view.current.signatures.length,3);
  const finalHtml=domain.renderWorkflowHtml(f.view);
  assert.equal(f.view.current.finalFileHash,require('node:crypto').createHash('sha256').update(finalHtml).digest('hex'));
  await f.act('owner','simulate_fund',{amountCents:1});
  assert.equal(domain.renderWorkflowHtml(f.view),finalHtml,'signed contract artifact must not change with the operational ledger');
  assert.equal(await db.getCommissionSettlementByOrder(f.order.id),null);
  await assert.rejects(f.act('company','revise',{patch:{scope:'改正文'}}),/补充协议|已签/);
  await assert.rejects(db.confirmOrder(f.order.id,'homeowner'), /新|工作流/);
  await assert.rejects(db.createContract({orderId:f.order.id,content:'旧绕行'}), /新|工作流/);
  await assert.rejects(db.selectOrderCompany(f.order.id,f.actors.company.uid), /工作流/);
  await assert.rejects(db.deleteProject(f.p.id), /保留|签|工作流/);
});

test('acceptance requires homeowner, rejected evidence can be resubmitted; unfunded or disputed stage cannot release', async () => {
  const f=await signed(await fixture()); const stageId=f.view.current.terms.stages[0].id;
  await assert.rejects(f.act('owner','simulate_release',{stageId}), /验收/);
  await f.act('company','submit_stage',{stageId,evidence:[{id:'e1',name:'阶段照片',kind:'reference',dataUrl:image}],note:'申请验收'});
  await assert.rejects(f.act('boss','accept_stage',{stageId}), /业主|无权/);
  await f.act('owner','reject_stage',{stageId,reason:'补充资料'});
  await f.act('company','submit_stage',{stageId,evidence:[{id:'e2',name:'整改照片',kind:'reference',dataUrl:image}],note:'整改完成'});
  await f.act('owner','accept_stage',{stageId}); assert.equal(f.view.stages[0].attempts.length,2);
  await assert.rejects(f.act('owner','simulate_release',{stageId}), /资金|余额/);
  await f.act('owner','simulate_fund',{amountCents:f.view.current.terms.totalCents});
  await assert.rejects(f.act('owner','simulate_refund',{amountCents:f.view.balanceCents,reason:'试图取走已验收阶段保障款'}), /验收|保留/);
  await f.act('company','open_dispute',{stageId,reason:'施工量有争议'});
  await assert.rejects(f.act('owner','simulate_release',{stageId}), /争议/);
  await assert.rejects(f.act('owner','simulate_refund',{amountCents:1,reason:'退出'}), /争议/);
  await assert.rejects(f.act('boss','resolve_dispute',{disputeId:f.view.disputes[0].id}),/依据|处理/);
  await f.act('boss','resolve_dispute',{disputeId:f.view.disputes[0].id,independentParty:'演示第三方调解机构',basis:'双方确认的处理记录',outcome:'同意继续履行'});
  await f.act('owner','simulate_release',{stageId});
  assert.equal(f.view.realizedFeeCents,Math.round(f.view.transactions.find(x=>x.type==='release').amountCents*0.03));
});

test('CAS, duplicate and concurrent release never double-pay; refund and fee ledger conserve funds', async () => {
  const f=await signed(await fixture()); const stageId=f.view.current.terms.stages[0].id;
  await f.act('owner','simulate_fund',{amountCents:f.view.current.terms.totalCents});
  await f.act('company','submit_stage',{stageId,evidence:[{id:'x',name:'证据',kind:'reference',dataUrl:image}],note:'完成'});
  await f.act('owner','accept_stage',{stageId});
  const cmd={action:'simulate_release',expectedRevision:f.view.revision,requestKey:'same-release-key',payload:{stageId}};
  const [a,b]=await Promise.all([service.actOnOrderWorkflow(f.order.id,f.actors.owner,cmd),service.actOnOrderWorkflow(f.order.id,f.actors.owner,cmd)]);
  assert.equal(a.transactions.filter(x=>x.type==='release').length,1); assert.equal(b.transactions.length,a.transactions.length);
  await assert.rejects(service.actOnOrderWorkflow(f.order.id,f.actors.owner,{...cmd,requestKey:'different-key'}),/版本/);
  await assert.rejects(service.actOnOrderWorkflow(f.order.id,f.actors.owner,{...cmd,payload:{stageId:'other'}}),/幂等|重复/);
  f.view=await service.getOrderWorkflow(f.order.id,f.actors.owner);
  const balance=f.view.balanceCents; await f.act('owner','simulate_refund',{amountCents:balance,reason:'未结算余款退回'});
  assert.equal(f.view.balanceCents,0); assert.equal(f.view.fundedCents,f.view.releasedCents+f.view.refundedCents);
  assert.equal(f.view.transactions.find(x=>x.type==='release').netCents+f.view.realizedFeeCents,f.view.releasedCents);
  await assert.rejects(f.act('owner','simulate_refund',{amountCents:1,reason:'重复退'}),/余额/);
});

test('asynchronous model review rejects stale versions and replay preflight does not invoke a model twice', async () => {
  const f=await ready(await fixture());
  const cmd={action:'ai_review',expectedRevision:f.view.revision,requestKey:'model-review-request',payload:{}};
  assert.equal(typeof service.prepareWorkflowCommand,'function');
  assert.equal((await service.prepareWorkflowCommand(f.order.id,f.actors.owner,cmd)).replayed,false);
  const reviewed=await service.recordAIReview(f.order.id,f.actors.owner,cmd,{status:'succeeded',mode:'model',summary:'仅供复核'});
  assert.equal(reviewed.aiReview.status,'succeeded');
  assert.equal((await service.prepareWorkflowCommand(f.order.id,f.actors.owner,cmd)).replayed,true);
  await assert.rejects(service.recordAIReview(f.order.id,f.actors.owner,{...cmd,requestKey:'stale-model-request'}, {status:'succeeded',mode:'model',summary:'旧版结果'}),/版本/);
});

test('independent concurrent payout requests have one winner and cumulative fee rounding reconciles to the signed total', async () => {
  const f=await fixture();await f.act('company','revise',{patch:{totalCents:100003}});await signed(f);
  await f.act('owner','simulate_fund',{amountCents:100003});
  for(const plan of f.view.current.terms.stages) {
    await f.act('company','submit_stage',{stageId:plan.id,evidence:[{id:'proof',name:'验收图',kind:'reference',dataUrl:image}],note:'施工完成'});
    await f.act('owner','accept_stage',{stageId:plan.id});
    const attempt={action:'simulate_release',expectedRevision:f.view.revision,payload:{stageId:plan.id}};
    const result=await Promise.allSettled([1,2].map(i=>service.actOnOrderWorkflow(f.order.id,f.actors.owner,{...attempt,requestKey:`concurrent-${plan.id}-${i}`})));
    assert.equal(result.filter(x=>x.status==='fulfilled').length,1);
    f.view=await service.getOrderWorkflow(f.order.id,f.actors.owner);
  }
  assert.equal(f.view.releasedCents,100003);assert.equal(f.view.realizedFeeCents,3000);assert.equal(f.view.balanceCents,0);
  assert.equal(f.view.transactions.filter(x=>x.type==='release').reduce((s,x)=>s+x.netCents+x.feeCents,0),100003);
});

test('existing signed contracts are read-only archives and never get synthetic demo signatures', async () => {
  const f=await fixture();
  // Create an independent historical fixture directly; current APIs no longer expose these legacy writes.
  const legacyProject=await db.createProject({homeownerId:f.actors.owner.uid,name:'旧合同',style:'现代简约',budget:'10'});
  const legacyOrder=await db.createOrder({projectId:legacyProject.id,homeownerId:f.actors.owner.uid});
  await db.createBid({orderId:legacyOrder.id,companyId:f.actors.company.uid,companyName:'公司',amount:'10',weeks:'8'});
  await db.selectOrderCompany(legacyOrder.id,f.actors.company.uid);await db.confirmOrder(legacyOrder.id,'company');await db.confirmOrder(legacyOrder.id,'homeowner');
  const old=await db.createContract({orderId:legacyOrder.id,content:'原历史合同内容'});
  await db.signContract(old.id,'homeowner');await db.signContract(old.id,'company');
  const view=await service.getOrderWorkflow(legacyOrder.id,f.actors.owner);
  assert.equal(view.legacyContract,true);assert.equal(view.draftText,'原历史合同内容');assert.deepEqual(view.allowedActions,[]);assert.equal(view.current.signatures.length,0);
  await assert.rejects(service.actOnOrderWorkflow(legacyOrder.id,f.actors.owner,{action:'generate_draft',expectedRevision:view.revision,requestKey:'legacy-archive-attempt',payload:{}}),/历史合同只读/);
});

function compileWebFile(sourceName,targetName,replacements={}) {
  let output=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../apps/web',sourceName),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  for(const [from,to]of Object.entries({'@i-renovation/shared':'./index.js','@i-renovation/shared/workflow':'./workflow.js','@i-renovation/shared/workflow-db':'./workflow-db.js','@/lib/auth':'./auth.js','@/lib/contract-agent':'./contract-agent.js','@/lib/llm':'./no-network.js',...replacements}))output=output.replaceAll(`require("${from}")`,`require("${to}")`);
  fs.writeFileSync(path.join(dir,targetName),output);return require(path.join(dir,targetName));
}
test('actual HTTP handlers enforce session, contract isolation, private seal, legacy write rejection and honest no-model status', async () => {
  process.env.SESSION_SECRET='isolated-workflow-secret-at-least-32-characters';
  delete process.env.LLM_API_KEY;
  fs.writeFileSync(path.join(dir,'no-network.js'),'exports.callLLM = async () => { throw new Error("TEST: external model must never be called"); };');
  const auth=compileWebFile('lib/auth.ts','auth.js');compileWebFile('lib/contract-agent.ts','contract-agent.js');
  const route=compileWebFile('app/api/orders/[id]/workflow/route.ts','workflow-route.js');
  const oldRoute=compileWebFile('app/api/orders/[id]/contract/route.ts','old-contract-route.js');
  const confirmRoute=compileWebFile('app/api/orders/[id]/confirm/route.ts','old-confirm-route.js');
  const profileRoute=compileWebFile('app/api/company/contract-profile/route.ts','profile-route.js');
  const projectRoute=compileWebFile('app/api/projects/[id]/route.ts','project-route.js');
  const {NextResponse}=require('next/server');
  const f=await ready(await fixture()),ctx={params:Promise.resolve({id:String(f.order.id)})};
  const req=(actor,method='GET',body)=>{const res=NextResponse.json({});if(actor)auth.setSessionCookie(res,actor.uid,actor.role);return new Request(`http://localhost/api/orders/${f.order.id}/workflow`,{method,headers:{...(actor?{cookie:res.headers.get('set-cookie').split(';')[0]}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});};
  assert.equal((await route.GET(req(null),ctx)).status,401);
  assert.equal((await route.GET(req(f.actors.other),ctx)).status,403);
  assert.equal((await oldRoute.POST(req(f.actors.owner,'POST',{}),ctx)).status,409);
  assert.equal((await confirmRoute.POST(req(f.actors.company,'POST',{}),ctx)).status,409);
  assert.equal((await profileRoute.GET(req(f.actors.owner))).status,403);
  const protectedDelete=await projectRoute.DELETE(req(f.actors.owner,'DELETE'),{params:Promise.resolve({id:String(f.p.id)})});
  assert.equal(protectedDelete.status,409);
  const profile=await profileRoute.GET(req(f.actors.company));assert.equal(profile.status,200);assert.equal((await profile.json()).sealDataUrl,sealImage);
  const noModel=await route.POST(req(f.actors.owner,'POST',{action:'ai_review',expectedRevision:f.view.revision,requestKey:'no-model-http-request',payload:{}}),ctx);
  assert.equal(noModel.status,503);const body=await noModel.json();assert.equal(body.workflow.aiReview.status,'not_called');
  const replay=await route.POST(req(f.actors.owner,'POST',{action:'ai_review',expectedRevision:f.view.revision,requestKey:'no-model-http-request',payload:{}}),ctx);
  assert.equal(replay.status,200);
  const htmlReq=new Request(`http://localhost/api/orders/${f.order.id}/workflow?format=html`,{headers:req(f.actors.owner).headers});
  const html=await route.GET(htmlReq,ctx);assert.match(html.headers.get('content-disposition'),/demo.html/);assert.match(await html.text(),/&lt;测试项目&gt;/);
});
