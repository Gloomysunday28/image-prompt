import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { parseArgs, decision, loadJob, validatePublish, checkResult, waitForUpload, fillDetails, finishWizard, verifyVideo, verifyAccount, openSession, main } from './youtube.mjs';
import { atomicJson } from './bilibili.mjs';
const account = 'UCpeGGzzzAdiUpaItWhzLalA';
const id = 'DoLS91cY0P4';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'youtube-script-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'video.mp4'), 'synthetic video');
  const manifest = { mode: 'publish', authorization: { terms_accepted: true }, video: { path: 'video.mp4' }, targets: [{ platform: 'youtube', account_id: account, title: '45秒，在海边搭一间温暖小屋', description: '中文简介。\n本视频由 AI 生成。', tags: ['微缩建筑','AI视频'], status: 'prepared', visibility: 'public', platform_fields: { original: true, commercial: false, altered_content: true, made_for_kids: false } }] };
  const file = join(dir, 'manifest.json'); await atomicJson(file, manifest);
  const options = { manifest: file, command: 'publish', timeout: 3000 };
  const job = await loadJob(options);
  return { dir, file, options, manifest, job };
}
async function pageFor(t) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(3000);
  // All test browsing stays on synthetic pages. No YouTube upload request is made.
  await page.route('**/*', route => route.fulfill({ status: 200, body: '<body></body>', contentType: 'text/html' }));
  return page;
}
const dashboard = `<a aria-label="YouTube Studio dashboard" href="https://studio.youtube.com/channel/${account}">Studio</a>`;
const fields = `<div role="textbox" contenteditable="true" aria-label="Add a title that describes your video (type @ to mention a channel)"></div><div role="textbox" contenteditable="true" aria-label="Tell viewers about your video (type @ to mention a channel)"></div>
<label><input type="radio" name="kids">No, it's not made for kids</label>
<button onclick="document.querySelector('#advanced').hidden=false;this.hidden=true" aria-label="Show advanced settings">Show more</button>
<section id="advanced" hidden><label><input type="radio" name="commercial">No, my video doesn’t include paid promotion</label><label><input type="radio" name="ai">Yes, AI was used</label><input aria-label="Tags"></section>`;

test('CLI keeps browser reuse explicit and rejects remote credential endpoints', () => {
  assert.equal(parseArgs(['verify']).profile, undefined);
  assert.equal(parseArgs(['publish','--profile','main']).profile,'main');
  assert.throws(() => parseArgs(['publish','--cdp-url','http://outside.test:9222']));
  assert.throws(() => parseArgs(['publish','--cdp-url','http://user:secret@localhost:9222']));
  assert.throws(() => parseArgs(['publish','--timeout','NaN']));
});
test('source identity, account and declarations are validated before upload', async t => {
  const { file, options, manifest, job } = await fixture(t);
  validatePublish(job, options);
  await assert.rejects(loadJob({ ...options, account: 'UCaaaaaaaaaaaaaaaaaaaaaa' }), /频道/);
  job.data.platform_fields.altered_content = undefined;
  assert.throws(() => validatePublish(job, options), /声明/);
  manifest.video.sha256 = job.hash; await atomicJson(file, manifest);
  await writeFile(job.video, 'changed');
  await assert.rejects(loadJob(options), /SHA-256/);
});
test('published and uncertain records cannot trigger another upload', async t => {
  const f = await fixture(t);
  assert.equal(decision({ status: 'prepared' }, { status: 'published' }), 'skip');
  assert.equal(decision({ status: 'published' }, { status: 'unknown' }), 'verify');
  assert.equal(decision({ upload_requested: true }), 'resume');
  f.manifest.targets[0].status = 'published'; f.manifest.targets[0].post_id = id;
  await atomicJson(f.file, f.manifest);
  await main(['publish', '--manifest', f.file, '--state-dir', f.dir]); // No browser configuration: must skip before any launch.
});
test('copyright claims require explicit no-current-impact evidence', () => {
  assert.equal(checkResult('Claimed content found.'), 'pending_or_restricted');
  assert.equal(checkResult('This doesn’t affect the video right now, but if you start earning from YouTube, it can have an impact on your earnings.'), 'claim_no_current_impact');
  assert.equal(checkResult('No issues found'), 'clear');
});
test('selecting a file or obtaining an ID alone never reports transmission/completion', async t => {
  const page = await pageFor(t), events = [];
  await page.setContent(`<p>video.mp4</p><a href="https://youtu.be/${id}">video</a>`);
  await assert.rejects(waitForUpload(page, 'video.mp4', async (status, extra) => events.push({status,...extra}), {timeout:100}), /上传完成/);
  assert.equal(events.length,1); assert.equal(events[0].status,'prepared');
  assert.equal(events[0].post_id,id);
  await page.locator('body').evaluate(e => { e.append('Processing up to 4K ... 3 minutes left'); });
  assert.equal(await waitForUpload(page, 'video.mp4', async () => {}, {timeout:2000}), id);
});
test('Chinese metadata, disclosures, wizard, claim handling and one publish click', async t => {
  const { job } = await fixture(t), page = await pageFor(t), states = [];
  await page.setContent(`${dashboard}<h1>Details</h1><section id="details">${fields}</section><section id="steps"></section><button id="next">Next</button>
  <script>
  let step=0;window.submissions=0;
  document.querySelector('#next').onclick=()=>{step++;document.querySelector('#details').hidden=true;
    if(step===1)document.querySelector('#steps').innerHTML='<h1>Video elements</h1>';
    if(step===2)document.querySelector('#steps').innerHTML='<h1>Checks</h1><p>Claimed content was found. This doesn’t affect the video right now, but if you start earning from YouTube, it can have an impact on your earnings.</p>';
    if(step===3){document.querySelector('#next').hidden=true;document.querySelector('#steps').innerHTML='<h1>Visibility</h1><label><input type="radio" name="visibility">Public</label><label><input type="checkbox" checked>Set as instant Premiere</label><button id="publish">Publish</button>';document.querySelector('#publish').onclick=()=>{window.submissions++;document.querySelector('#steps').innerHTML='<p>Video published</p>';};}
  };
  </script>`);
  await verifyAccount(page,account);
  await assert.rejects(verifyAccount(page,'UCaaaaaaaaaaaaaaaaaaaaaa'),/不一致/);
  await fillDetails(page,job);
  assert.equal(await page.getByRole('textbox').first().innerText(),job.data.title);
  assert.equal(await page.getByRole('textbox').nth(1).innerText(),job.data.description);
  for (const name of ["No, it's not made for kids", 'Yes, AI was used', 'No, my video doesn’t include paid promotion']) assert.equal(await page.getByRole('radio',{name,exact:true}).isChecked(),true);
  await finishWizard(page,{},async (status, extra) => {
    if(status==='submitting') { assert.equal(await page.evaluate(()=>window.submissions),0); assert.equal(await page.getByRole('checkbox').isChecked(),false); }
    states.push({status,...extra});
  },{timeout:3000});
  assert.equal(await page.evaluate(()=>window.submissions),1);
  assert.equal(states[0].copyright_check,'claim_no_current_impact');
  assert.equal(states.at(-1).status,'submitting');
});
test('verification requires same channel, title, filename and saved Public status', async t => {
  const { job } = await fixture(t), page = await pageFor(t);
  const savedTitle = job.data.title;
  await page.route(`https://studio.youtube.com/video/${id}/edit`, route => route.fulfill({ contentType:'text/html; charset=utf-8',body:`${dashboard}<h1>Video details</h1>${fields}<p>video.mp4</p><p>Public</p><img alt="4K complete"><script>document.querySelector('[contenteditable]').textContent=${JSON.stringify(savedTitle)};</script>` }));
  const result = await verifyVideo(page,job,id);
  assert.equal(result.status,'published'); assert.equal(result.quality_4k_complete,true);
  job.data.title='other'; await assert.rejects(verifyVideo(page,job,id),/标题/);
});
test('CDP keeps existing pages and failed upload page available after disconnect', async t => {
  const f = await fixture(t), profile = join(f.dir,'browser');
  const owner = await chromium.launchPersistentContext(profile,{channel:'chrome',headless:true,args:['--remote-debugging-port=0']});
  t.after(()=>owner.close());
  const original = owner.pages()[0]; await original.setContent('<title>Original</title>');
  const [port] = (await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n');
  const session = await openSession(chromium,{'cdp-url':`http://127.0.0.1:${port}`},f.dir);
  await session.page.setContent('<title>Recoverable upload</title>');
  await session.close({keepPage:true});
  assert.equal(original.isClosed(),false);
  assert.equal(owner.pages().length,2);
  const clean = await openSession(chromium,{'cdp-url':`http://127.0.0.1:${port}`},f.dir);
  await clean.close(); assert.equal(owner.pages().length,2);
});
