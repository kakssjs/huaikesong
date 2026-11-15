// Browser acceptance against an isolated production server with synthetic data. No model or payment calls.
// Usage: node scripts/browser-acceptance.cjs --isolated-demo
// Playwright is resolved from PLAYWRIGHT_CORE_PATH, then the repo, then a few known local installs.
// Chrome is resolved from CHROME_PATH, then the usual install locations. Output goes to BROWSER_ACCEPTANCE_OUT or the temp dir.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const ts = require('typescript');
if (process.argv[2] !== '--isolated-demo') throw new Error('Explicit --isolated-demo is required');

const root = path.resolve(__dirname, '..');
const firstExisting = list => list.filter(Boolean).find(p => fs.existsSync(p));
const playwrightPath = firstExisting([
  process.env.PLAYWRIGHT_CORE_PATH,
  path.join(root, 'node_modules/playwright-core'),
  path.join(root, 'node_modules/playwright'),
  'D:/chatgpt/3dgongfang/studio/node_modules/playwright-core',
]);
const chromePath = firstExisting([
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]);
if (!playwrightPath) throw new Error('playwright-core not found: set PLAYWRIGHT_CORE_PATH to its folder');
if (!chromePath) throw new Error('Chrome/Edge not found: set CHROME_PATH to the executable');
const { chromium } = require(playwrightPath);

const port = Number(process.env.BROWSER_ACCEPTANCE_PORT || 3322);
const base = `http://127.0.0.1:${port}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yushe-browser-'));
const outDir = process.env.BROWSER_ACCEPTANCE_OUT || path.join(scratch, 'out');
fs.mkdirSync(outDir, { recursive: true });
const compiled = path.join(root, 'scripts', '.browser-acceptance');
fs.mkdirSync(compiled, { recursive: true });
for (const name of fs.readdirSync(path.join(root, 'packages/shared/src')).filter(f => f.endsWith('.ts'))) {
  fs.writeFileSync(path.join(compiled, name.replace(/\.ts$/, '.js')), ts.transpileModule(fs.readFileSync(path.join(root, 'packages/shared/src', name), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText);
}
process.env.IRENO_PGLITE_DIR = path.join(scratch, 'db');
const db = require('./.browser-acceptance/db.js');
const { calcQuote } = require('./.browser-acceptance/price.js');
const { generatePlanGeometry, planToSvg } = require('./.browser-acceptance/plan.js');
const { buildSceneModel } = require('./.browser-acceptance/scene3d.js');

const PASSWORD = 'DemoOnly2026!';
const OWNER_PHONE = '19900000001';
const VIEWPORTS = [{ width: 1440, height: 1000 }, { width: 390, height: 844 }];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let server;

async function seed() {
  const salt = crypto.randomBytes(16);
  const passwordHash = `scrypt$${salt.toString('base64')}$${crypto.scryptSync(PASSWORD, salt, 32).toString('base64')}`;
  const owner = await db.createUser({ role: 'homeowner', name: '合成业主', phone: OWNER_PHONE, passwordHash });
  const rooms = [{ name: '客厅', area: 30 }, { name: '主卧', area: 20 }, { name: '次卧', area: 15 }, { name: '厨房', area: 10 }, { name: '卫生间', area: 8 }];
  // 每个视口各用一个独立项目：点“重新质检”会新建待执行的质检任务（验收服务器关闭了 Runner），不能影响另一个视口。
  const projectIds = {};
  for (const width of VIEWPORTS.map(v => v.width)) {
    const project = await db.createProject({ homeownerId: owner.id, name: `浏览器验收｜合成项目 ${width}`, style: '现代简约', budget: '15', area: '83', address: 'PRIVATE-ADDRESS' });
    const geometry = generatePlanGeometry(rooms, { totalArea: 83 });
    const sceneModel = buildSceneModel(geometry, rooms, project.style, { source: 'floor_plan' });
    const chain = [
      ['floor_plan', [['plan', { rooms, geometry, source: 'user_studio', confidence: 'high', note: '合成数据，非模型识别', warnings: geometry.warnings }]]],
      ['designer', [['design', { svg: planToSvg(geometry, project.style, project.name), rooms, geometry, style: project.style, note: '合成数据' }],
        ['scene_model', sceneModel], ['decorations', { images: rooms.map(r => ({ room: r.name, url: '/interiors/living.jpg' })), style: project.style }]]],
      ['quote', [['quote', calcQuote(rooms, project.style)]]],
      ['qa', [['qa', { passed: true, checks: [], checkedAt: new Date().toISOString(), note: '合成夹具，非实际质检' }]]],
    ];
    for (const [i, [agent, results]] of chain.entries()) {
      const task = await db.claimNextTask(); assert.equal(task.toAgent, agent);
      for (const [kind, content] of results) await db.upsertResult(project.id, kind, content);
      await db.finishTask(task.id, { fixtureOnly: true }, 0, chain[i + 1] ? { nextAgent: chain[i + 1][0] } : { stage: 3 });
    }
    projectIds[width] = project.id;
  }
  await (await db.getDb()).$client.close();
  return { projectIds };
}

async function startServer() {
  const log = fs.openSync(path.join(scratch, 'server.log'), 'a');
  server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: path.join(root, 'apps/web'), windowsHide: true, stdio: ['ignore', log, log],
    env: { ...process.env, NODE_ENV: 'production', RUNNER_ENABLED: 'false', COOKIE_SECURE: 'false', SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
      LLM_API_KEY: '', AGNES_API_KEY: '', opcpay_api_key: '', BOSS_PHONE: '19900000000', BOSS_PASSWORD: crypto.randomBytes(12).toString('hex'),
      IRENO_PGLITE_DIR: path.join(scratch, 'db'), IRENO_UPLOAD_DIR: path.join(scratch, 'uploads') },
  });
  fs.closeSync(log);
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw new Error('isolated server exited; see ' + scratch);
    try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
    await sleep(500);
  }
  throw new Error('isolated server did not start');
}

async function run() {
  const { projectIds } = await seed();
  await startServer();
  const browser = await chromium.launch({ headless: true, executablePath: chromePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const report = [];
  try {
    for (const viewport of VIEWPORTS) {
      const projectId = projectIds[viewport.width];
      const context = await browser.newContext({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500, acceptDownloads: true });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      const step = { width: viewport.width };
      const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2);

      // 首页与导航
      await page.goto(base + '/', { waitUntil: 'networkidle' });
      step.homeOverflow = await overflow();
      await page.screenshot({ path: path.join(outDir, `home-${viewport.width}.png`), fullPage: true });

      // 团队与服务页：四个锚点标题与材料下载链接
      await page.goto(base + '/opc', { waitUntil: 'networkidle' });
      for (const title of ['商业模式画布', '岗位说明书', '交付与验收']) await page.getByRole('heading', { name: title }).first().waitFor();
      step.opcHeadings = true;
      assert.ok(await page.locator('a[href="/docs/opc-materials.md"]').count() > 0, 'materials download link');
      step.opcOverflow = await overflow();
      await page.screenshot({ path: path.join(outDir, `opc-${viewport.width}.png`), fullPage: true });

      // 登录
      await page.goto(base + '/', { waitUntil: 'networkidle' });
      await page.locator('[data-auth="login"]').click();
      await page.getByPlaceholder('请输入注册手机号').fill(OWNER_PHONE);
      await page.getByPlaceholder('请输入密码', { exact: true }).fill(PASSWORD);
      await page.getByRole('button', { name: '登录', exact: true }).last().click();
      // 登录成功后页面自己跳转到工作台（AuthNav 的 location.assign）；等它落地，避免与下面的 goto 互相打断。
      await page.waitForURL(/\/dashboard/, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => !!JSON.parse(localStorage.getItem('user') || '{}').id);
      step.login = true;

      // 新建项目：保存后刷新仍在
      await page.goto(base + '/dashboard', { waitUntil: 'networkidle' });
      const projectName = `浏览器验收新建 ${viewport.width}`;
      await page.locator('input[name="name"]').fill(projectName);
      await page.locator('input[name="area"]').fill('56');
      await page.locator('input[name="budget"]').fill('15');
      await page.locator('textarea[name="needs"]').fill('验收测试，非真实用户项目');
      await page.locator('form').filter({ has: page.locator('input[name="name"]') }).locator('button[type="submit"],button:not([type])').last().click();
      await page.waitForURL(/\/project\/\d+/, { timeout: 20000 });
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByText(projectName, { exact: false }).first().waitFor();
      step.createAndReload = true;
      await page.getByRole('heading', { name: '装修项目工作台', exact: true }).waitFor();
      assert.equal(await page.getByRole('tab', { name: '需求与户型', exact: true }).getAttribute('aria-selected'), 'true');
      await page.getByRole('tab', { name: '匹配与沟通', exact: true }).click();
      await page.getByText('业主选定承接装修公司后，这里会开放本项目的私密沟通入口。', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '沟通装修细节', exact: true }).count(), 0);
      step.unselectedChatLocked = true;

      // 带完整成果的合成项目：交付面板、3D 视角、导出、交付 JSON 下载
      await page.goto(`${base}/project/${projectId}`, { waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: '本轮交付与人工复核' }).waitFor();
      step.deliveryPanel = true;
      assert.equal(await page.getByRole('tab', { name: '报价与质检', exact: true }).getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator('.workflow-journey [aria-current="step"]').innerText().then(t => t.includes('业主确认')), true);
      await page.locator('.workflow-primary').click();
      await page.waitForFunction(() => document.activeElement.id === 'project-quote');
      const adjustment = page.getByLabel('报价调整百分比');
      await adjustment.fill('2');
      await page.getByRole('tab', { name: '岗位交接', exact: true }).click();
      await page.getByRole('heading', { name: '岗位成果与真实交接' }).waitFor();
      assert.equal(await page.locator('.handoff-list > li').count(), 5);
      assert.match(await page.locator('.handoff-list').innerText(), /Task #/);
      assert.equal(await page.getByRole('tabpanel').count(), 1, 'one visible work area');
      await page.getByRole('tab', { name: '报价与质检', exact: true }).click();
      assert.equal(await adjustment.inputValue(), '2', 'switching work area preserves edits');
      await adjustment.fill('0');
      await page.getByRole('tab', { name: '设计与 3D', exact: true }).click();
      await page.getByRole('tab', { name: '设计与 3D', exact: true }).press('ArrowRight');
      assert.equal(await page.getByRole('tab', { name: '报价与质检', exact: true }).getAttribute('aria-selected'), 'true');
      await page.getByRole('tab', { name: '设计与 3D', exact: true }).click();
      step.unifiedWorkspace = true;
      await page.getByRole('button', { name: '俯视', exact: true }).first().click();
      await page.getByRole('button', { name: '透视', exact: true }).first().click();
      step.views3D = true;
      // 一次导出会连续下载 7 个文件：GLB、两个 Blender 脚本和 4 个 JSON。收集全部再逐个核对。
      const exported = [];
      const onDownload = d => exported.push(d);
      page.on('download', onDownload);
      await page.getByRole('button', { name: '导出 Blender / Pascal', exact: true }).click();
      for (let i = 0; i < 60 && exported.length < 7; i++) await sleep(500);
      const names = exported.map(d => d.suggestedFilename()).sort();
      assert.equal(exported.length, 7, `expected 7 export files, got ${exported.length}: ${names.join(', ')}`);
      for (const expected of ['.glb', 'fangwu3d-blender-cycles.py', 'fangwu3d-blender-batch.py', 'fangwu3d-pascal-editor.json', 'fangwu3d-material-library.json', 'fangwu3d-furniture-library.json', 'fangwu3d-blender-job.json']) {
        assert.ok(names.some(n => n.endsWith(expected)), `missing export file ${expected}; got: ${names.join(', ')}`);
      }
      const glbFile = exported.find(d => d.suggestedFilename().endsWith('.glb'));
      await glbFile.saveAs(path.join(outDir, `scene-${viewport.width}.glb`));
      step.exportGLB = fs.statSync(path.join(outDir, `scene-${viewport.width}.glb`)).size;
      assert.ok(step.exportGLB > 1000, 'GLB is not empty');
      const glbHead = fs.readFileSync(path.join(outDir, `scene-${viewport.width}.glb`)).subarray(0, 4).toString('ascii');
      assert.equal(glbHead, 'glTF', 'GLB magic header');
      step.exportFiles = names.length;
      for (const d of exported.filter(d => d.suggestedFilename().endsWith('.json'))) {
        const file = path.join(outDir, `${viewport.width}-${d.suggestedFilename()}`);
        await d.saveAs(file);
        JSON.parse(fs.readFileSync(file, 'utf8'));
      }
      step.exportJsonValid = true;
      page.off('download', onDownload);
      await page.getByRole('tab', { name: '报价与质检', exact: true }).click();
      const json = page.waitForEvent('download', { timeout: 20000 });
      await page.getByRole('button', { name: '下载交付记录' }).click();
      const jsonFile = await json;
      await jsonFile.saveAs(path.join(outDir, `delivery-${viewport.width}.json`));
      const delivery = JSON.parse(fs.readFileSync(path.join(outDir, `delivery-${viewport.width}.json`), 'utf8'));
      assert.equal(delivery.readyForReview, true);
      assert.doesNotMatch(JSON.stringify(delivery), /PRIVATE-/);
      step.deliveryDownload = true;
      // Confirmed data must survive an automatic publication failure and expose a real retry action.
      await page.route('**/api/orders', route => route.request().method() === 'POST' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '合成断网：发布暂不可用' }) }) : route.continue());
      const publicationError = new Promise(resolve => page.once('dialog', async dialog => { const text = dialog.message(); await dialog.dismiss(); resolve(text); }));
      await page.getByRole('button', { name: '✓ 最终确认方案', exact: true }).click();
      assert.match(await publicationError, /发布/);
      await page.unroute('**/api/orders');
      await page.waitForFunction(() => document.querySelector('.workflow-journey [aria-current="step"]')?.textContent.includes('发布与匹配'));
      await page.locator('.workflow-primary').click();
      await page.getByRole('button', { name: '重试发布项目', exact: true }).click();
      await page.getByText('⏳ 已发布到接单市场，正在等待装修公司发布投标数据…（收到报价后自动开始综合匹配）', { exact: true }).waitFor();
      step.failedPublishRecovery = true;
      await page.getByRole('tab', { name: '报价与质检', exact: true }).click();
      await page.getByRole('button', { name: '重新质检当前成果' }).click();
      await page.getByText('复检已提交').waitFor();
      step.recheckNotice = true;
      await page.waitForFunction(() => document.querySelector('.workflow-journey [aria-current="step"]')?.textContent.includes('报价与质检'));
      await page.getByRole('button', { name: '查看当前任务 →', exact: true }).waitFor();
      await page.locator('.workflow-primary').click();
      await page.waitForFunction(() => document.activeElement.id === 'workspace-quote');
      step.nextActionAfterRecheck = true;
      await page.getByRole('tab', { name: '签约与履约', exact: true }).click();
      await page.getByText('请先选定装修公司，再进入现有合同与履约工作台。', { exact: true }).waitFor();
      await page.getByRole('tab', { name: '岗位交接', exact: true }).click();
      step.projectOverflow = await overflow();
      await page.screenshot({ path: path.join(outDir, `project-${viewport.width}.png`), fullPage: true });

      assert.equal(step.homeOverflow, false, `home horizontal overflow at ${viewport.width}`);
      assert.equal(step.opcOverflow, false, `opc horizontal overflow at ${viewport.width}`);
      assert.equal(step.projectOverflow, false, `project horizontal overflow at ${viewport.width}`);
      assert.deepEqual(errors, [], 'no uncaught page errors');
      step.pageErrors = errors.length;
      report.push(step);
      await context.close();
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(outDir, 'browser-acceptance.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: 'passed', fixture: 'synthetic, no model/payment calls', viewports: report.length, outDir, report }, null, 1));
}

run().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { if (server) server.kill(); });
