// Optional browser layer for chat-http-smoke.cjs. Uses only its isolated synthetic server.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
exports.run=async function run(s){
  assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(s.base),'Only isolated loopback servers are allowed');
  const packagePath=process.env.PLAYWRIGHT_CORE_PATH||path.join(__dirname,'../node_modules/playwright-core');
  const {chromium}=require(packagePath);
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  fs.mkdirSync(s.outDir,{recursive:true});
  const report=[];
  async function api(url,cookie,body){
    const res=await fetch(s.base+url,{method:body?'POST':'GET',headers:{cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    const value=await res.json();assert.equal(res.status,200,JSON.stringify(value));return value;
  }
  async function context(viewport,cookie,user){
    const ctx=await browser.newContext({viewport,isMobile:viewport.width<500,hasTouch:viewport.width<500,acceptDownloads:true});
    const split=cookie.indexOf('=');await ctx.addCookies([{name:cookie.slice(0,split),value:cookie.slice(split+1),url:s.base}]);
    await ctx.addInitScript(u=>localStorage.setItem('user',JSON.stringify(u)),user);
    return ctx;
  }
  const thread=await api(`/api/orders/${s.secondOrderId}/conversations`,s.ownerCookie,{});
  try{
    for(const width of [1440,390]){
      const viewport={width,height:900};
      const owner=await context(viewport,s.ownerCookie,{id:s.ownerId,role:'homeowner',name:'合成业主'});
      const company=await context(viewport,s.companyCookie,{id:s.companyId,role:'company',name:'合成公司'});
      const a=await owner.newPage(),b=await company.newPage(),errors=[];
      a.on('pageerror',e=>errors.push(e.message));b.on('pageerror',e=>errors.push(e.message));
      const step={width};
      try{
        await a.goto(`${s.base}/project/${s.projectId}`,{waitUntil:'networkidle'});
        await a.getByRole('button',{name:'沟通装修细节',exact:true}).click();
        await a.waitForURL(/\/messages\?conversation=/);await a.locator('#chat-draft:enabled').waitFor();step.ownerEntry=true;
        const navigation=await a.evaluate(()=>{const h=document.querySelector('.topbar').getBoundingClientRect(),n=document.querySelector('.topbar nav').getBoundingClientRect();return {headerBottom:h.bottom,navBottom:n.bottom};});
        assert.ok(navigation.navBottom<=navigation.headerBottom+1,`navigation exceeds its header at ${width}: ${JSON.stringify(navigation)}`);step.navigationContained=true;
        await b.goto(s.base+'/contractor',{waitUntil:'networkidle'});
        await b.getByRole('button',{name:'订单管理',exact:true}).click();
        await b.getByRole('button',{name:'沟通装修细节',exact:true}).first().click();
        await b.waitForURL(/\/messages\?conversation=/);await b.locator('#chat-draft:enabled').waitFor();step.companyEntry=true;
        // Company order order is not guaranteed, so explicitly open the matching conversation.
        await b.goto(`${s.base}/messages?conversation=${s.conversationId}`,{waitUntil:'networkidle'});
        await b.locator('#chat-draft:enabled').waitFor();
        const text=`浏览器 ${width}：厨房台面型号需要核对`;
        await a.bringToFront();await a.locator('#chat-draft').fill(text);await a.getByRole('button',{name:'发送消息',exact:true}).click();
        await a.locator('.chat-message p').getByText(text,{exact:true}).waitFor();
        await b.bringToFront();await b.locator('.chat-message p').getByText(text,{exact:true}).waitFor({timeout:15000});
        await b.locator('#chat-draft').fill(`公司回复 ${width}：明天带材料样板`);await b.getByRole('button',{name:'发送消息',exact:true}).click();
        await a.bringToFront();await a.locator('.chat-message p').getByText(`公司回复 ${width}：明天带材料样板`,{exact:true}).waitFor({timeout:15000});
        await a.locator('.chat-message').filter({hasText:text}).getByText('对方已读',{exact:true}).waitFor({timeout:15000});step.bidirectionalAndRead=true;
        const draft=`刷新恢复 ${width}：预留三个插座`;
        await a.locator('#chat-draft').fill(draft);await a.reload({waitUntil:'networkidle'});
        await a.waitForFunction(value=>document.querySelector('#chat-draft')?.value===value,draft);step.reloadDraft=true;
        await a.getByRole('button').filter({hasText:'聊天第二项目 合成资料'}).click();await a.locator('#chat-draft:enabled').waitFor();
        assert.equal(await a.locator('#chat-draft').inputValue(),'');await a.locator('#chat-draft').fill(`第二会话草稿 ${width}`);
        await a.getByRole('button').filter({hasText:'聊天HTTP合成项目'}).click();await a.waitForFunction(value=>document.querySelector('#chat-draft')?.value===value,draft);step.draftIsolation=true;
        // Connection drops after the server accepts the message; retry after reload must not duplicate it.
        const uncertain=`已接收但回包中断 ${width}`;let aborted=false;
        const intercept=async route=>{
          if(route.request().method()==='POST'&&!aborted&&route.request().postDataJSON()?.text===uncertain){aborted=true;await route.fetch();await route.abort('failed');}
          else await route.continue();
        };
        await a.route(`**/api/conversations/${s.conversationId}/messages`,intercept);
        await a.locator('#chat-draft').fill(uncertain);await a.getByRole('button',{name:'发送消息',exact:true}).click();
        await a.locator('.chat-composer .chat-error').waitFor();assert.equal(await a.locator('#chat-draft').inputValue(),uncertain);
        await a.reload({waitUntil:'networkidle'});await a.waitForFunction(value=>document.querySelector('#chat-draft')?.value===value,uncertain);
        await a.getByRole('button',{name:'发送消息',exact:true}).click();await a.waitForFunction(()=>document.querySelector('#chat-draft')?.value==='');
        const page=await api(`/api/conversations/${s.conversationId}/messages`,s.ownerCookie);
        assert.equal(page.messages.filter(m=>m.text===uncertain).length,1);await a.unroute(`**/api/conversations/${s.conversationId}/messages`,intercept);step.uncertainRetryNoDuplicate=true;
        await owner.setOffline(true);await a.locator('#chat-draft').fill(`断网草稿 ${width}`);await a.getByRole('button',{name:'发送消息',exact:true}).click();
        await a.locator('.chat-composer .chat-error').waitFor();assert.equal(await a.locator('#chat-draft').inputValue(),`断网草稿 ${width}`);
        await owner.setOffline(false);await a.getByRole('button',{name:'发送消息',exact:true}).click();await a.waitForFunction(()=>document.querySelector('#chat-draft')?.value==='');step.offlineRecovery=true;
        const download=a.waitForEvent('download');await a.getByRole('button',{name:'下载本会话记录',exact:true}).click();
        const d=await download,file=path.join(s.outDir,`conversation-${width}.json`);await d.saveAs(file);
        const transcript=JSON.parse(fs.readFileSync(file,'utf8'));assert.ok(transcript.messages.some(m=>m.text===text));assert.doesNotMatch(JSON.stringify(transcript),/clientKey|passwordHash/);step.export=true;
        if(width===1440){
          for(let i=0;i<130;i++)await api(`/api/conversations/${s.conversationId}/messages`,s.companyCookie,{text:`历史分页样例 ${i}`,clientKey:`history-fixture-${i}`});
          const full=await api(`/api/conversations/${s.conversationId}/export`,s.ownerCookie);
          await a.reload({waitUntil:'networkidle'});await a.waitForFunction(()=>document.querySelectorAll('.chat-message').length===50);
          await a.getByRole('button',{name:'加载更早消息',exact:true}).click();await a.waitForFunction(()=>document.querySelectorAll('.chat-message').length===100);
          let release,seen;const gate=new Promise(r=>release=r),held=new Promise(r=>seen=r);
          const delayed=async route=>{seen();await gate;await route.continue();};
          const pattern=`**/api/conversations/${s.conversationId}/messages?before=*`;
          await a.route(pattern,delayed);await a.getByRole('button',{name:'加载更早消息',exact:true}).click();await held;
          await a.getByRole('button').filter({hasText:'聊天第二项目 合成资料'}).click();
          await a.waitForFunction(()=>document.querySelector('.chat-thread-heading p')?.textContent.includes('聊天第二项目'));
          await a.getByRole('button').filter({hasText:'聊天HTTP合成项目'}).click();
          await a.waitForFunction(()=>document.querySelector('.chat-thread-heading p')?.textContent.includes('聊天HTTP合成项目')&&document.querySelectorAll('.chat-message').length===50);
          const delivered=a.waitForResponse(r=>r.url().includes(`/api/conversations/${s.conversationId}/messages?before=`));release();await delivered;await a.waitForTimeout(150);
          assert.equal(await a.locator('.chat-message').count(),50,'stale history response must be ignored');
          await a.unroute(pattern,delayed);
          await a.getByRole('button',{name:'加载更早消息',exact:true}).click();await a.waitForFunction(()=>document.querySelectorAll('.chat-message').length===100);
          await a.getByRole('button',{name:'加载更早消息',exact:true}).click();await a.waitForFunction(count=>document.querySelectorAll('.chat-message').length===count,full.messages.length);
          assert.equal(await a.locator('.chat-message p b').count(),0,'messages are plain text');step.delayedHistorySwitchNoGap=true;
        }
        assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false,'owner overflow');
        assert.equal(await b.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false,'company overflow');
        await a.screenshot({path:path.join(s.outDir,`owner-chat-${width}.png`),fullPage:true});await b.screenshot({path:path.join(s.outDir,`company-chat-${width}.png`),fullPage:true});
        await a.goto(s.base+'/trials',{waitUntil:'networkidle'});
        await a.getByLabel('样例编号',{exact:true}).fill('=HXT-001');
        await a.locator('select[name="kind"]').selectOption('real');
        await a.getByLabel('系统实际耗时（秒）',{exact:true}).fill('60');
        await a.getByLabel('人工对照耗时（分钟，可留空）',{exact:true}).fill('10');
        await a.locator('select[name="outcome"]').selectOption('accepted');
        await a.getByRole('button',{name:'保存观察记录',exact:true}).click();
        await a.getByText('=HXT-001',{exact:true}).waitFor();
        assert.ok((await a.locator('.trial-stats').innerText()).includes('90%'));
        await a.reload({waitUntil:'networkidle'});await a.getByText('=HXT-001',{exact:true}).waitFor();
        await a.getByLabel('样例编号',{exact:true}).fill('SYNTHETIC');
        await a.getByLabel('系统实际耗时（秒）',{exact:true}).fill('1');
        await a.getByRole('button',{name:'保存观察记录',exact:true}).click();
        await a.getByText('SYNTHETIC',{exact:true}).waitFor();
        const trialDownload=a.waitForEvent('download');await a.getByRole('button',{name:'下载 JSON 与统计',exact:true}).click();
        const trialFile=path.join(s.outDir,`trials-${width}.json`);await(await trialDownload).saveAs(trialFile);
        const result=JSON.parse(fs.readFileSync(trialFile,'utf8'));
        assert.equal(result.summary.realCount,1);assert.equal(result.summary.syntheticCount,1);assert.equal(result.summary.medianSeconds,60);assert.equal(result.summary.meanCostCny,null);
        const csvDownload=a.waitForEvent('download');await a.getByRole('button',{name:'下载 CSV',exact:true}).click();
        const csvFile=path.join(s.outDir,`trials-${width}.csv`);await(await csvDownload).saveAs(csvFile);assert.ok(fs.readFileSync(csvFile,'utf8').includes("'=HXT-001"));
        assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false,'trial form overflow');
        await a.screenshot({path:path.join(s.outDir,`trials-${width}.png`),fullPage:true});step.trialSaveReloadStatisticsExport=true;
        assert.deepEqual(errors,[]);step.pageErrors=0;report.push(step);
      }catch(error){await a.screenshot({path:path.join(s.outDir,`failure-${width}.png`),fullPage:true}).catch(()=>{});throw error;}
      finally{await owner.close();await company.close();}
    }
  }finally{await browser.close();}
  fs.writeFileSync(path.join(s.outDir,'chat-browser-report.json'),JSON.stringify(report,null,2));
  return {viewports:report,outDir:s.outDir};
};
