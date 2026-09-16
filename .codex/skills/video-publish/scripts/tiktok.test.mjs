import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { atomicJson } from './bilibili.mjs';
import { parseArgs, decision, captionFor, loadJob, validatePublish, uploadEvidence, findResumePage, fillForm, ensurePublic, setToggle, resultFromRow, submitOnce, setPostPublic, main } from './tiktok.mjs';
const account = 'lunaticsms', id = '7685696182680571143';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tiktok-script-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'video.mp4'), 'synthetic video');
  const manifest = { mode:'publish', video:{path:'video.mp4',size_bytes:15,duration_seconds:45}, targets:[{platform:'tiktok',account_id:account,title:'海边小屋',description:'中文简介。\n本视频由 AI 生成。',tags:['微缩建筑','AI视频'],status:'prepared',visibility:'public',platform_fields:{original:true,commercial:false,ai_generated:true}}] };
  const file = join(dir, 'manifest.json'); await atomicJson(file, manifest);
  const options = { manifest:file, command:'publish', timeout:3000 };
  return {dir,file,options,manifest,job:await loadJob(options)};
}
async function pageFor(t) {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage(); page.setDefaultTimeout(1500);
  // Intercept every network request: fixtures cannot publish to a real account.
  await context.route('**/*', route => route.fulfill({contentType:'text/html; charset=utf-8',body:'<body></body>'}));
  return page;
}
const visibility = `<select aria-label="仅自己"><option value="self">仅自己</option><option value="public">所有人</option></select>`;
function form(sync=true) { return `<div contenteditable="true" role="textbox">video_raw</div><p id="count">9 / 4000</p>
<button onclick="document.querySelector('#more').hidden=false;this.hidden=true">显示更多</button><section id="more" hidden>
<label><input type="checkbox">AI 生成的内容</label><label><input type="checkbox" checked>内容披露</label></section>
<label><input type="radio" name="when">现在</label>${visibility}<button id="post">发布</button>
<script>window.posts=0;document.querySelector('#post').onclick=()=>window.posts++;
${sync ? `document.querySelector('[contenteditable]').oninput=e=>document.querySelector('#count').textContent=e.target.innerText.trim().length+' / 4000';` : ''}</script>`; }
function row(job, {privacy='所有人', review='内容审查中', caption=captionFor(job.data), postId=id, time=true}={}) {
 return `<div role="row"><span>00:45</span><a href="https://www.tiktok.com/@${account}/video/${postId}">${caption}</a><p>${review}</p><button>${privacy}</button>${time ? '<time datetime="2026-09-15T10:00:00Z">9月15日</time>' : ''}</div>`;
}

test('browser choice, public target and source identity are enforced', async t => {
  const f = await fixture(t);
  assert.equal(parseArgs(['publish']).profile,undefined);
  assert.equal(parseArgs(['verify','--account','@lunaticsms']).account,account);
  for (const url of ['http://remote.test:9222','http://secret@localhost:9222']) assert.throws(()=>parseArgs(['verify','--cdp-url',url]));
  validatePublish(f.job); f.job.data.visibility='private'; assert.throws(()=>validatePublish(f.job),/立即公开/);
  f.job.data.visibility='public'; f.job.manifest.video.duration_seconds=undefined; assert.throws(()=>validatePublish(f.job),/时长/);
  f.manifest.video.sha256=f.job.hash; await atomicJson(f.file,f.manifest); await writeFile(f.job.video,'different bytes');
  await assert.rejects(loadJob(f.options),/SHA-256/);
});
test('caption preserves Chinese and does not repeat title or hashtags', () => {
  const data = {title:'海边小屋',description:'海边小屋\nAI 视频\n#建筑',tags:['建筑','AI视频']};
  assert.equal(captionFor(data),'海边小屋\nAI 视频\n#建筑\n#AI视频');
});
test('existing and uncertain posts do not trigger a new upload', async t => {
  const f=await fixture(t);
  assert.equal(decision({status:'prepared'},{status:'published'}),'skip');
  assert.equal(decision({status:'reviewing'},{status:'unknown'}),'verify');
  assert.equal(decision({status:'blocked',post_id:id}),'verify');
  assert.equal(decision({upload_requested:true}),'resume');
  f.manifest.targets[0].post_id=id; f.manifest.targets[0].status='blocked'; await atomicJson(f.file,f.manifest);
  await main(['publish','--manifest',f.file,'--state-dir',f.dir]); // Must exit before creating a browser.
});
test('file selection alone is not uploaded; completion needs name, size and duration', async t => {
  const {job}=await fixture(t), page=await pageFor(t);
  job.manifest.video.size_bytes=109792448;
  await page.setContent('<p>video.mp4 已选择</p>'); assert.equal(await uploadEvidence(page,job),null);
  await page.setContent('<p>video.mp4 已上传（109.79MB） 00:00:00 / 00:00:45</p>');
  assert.equal((await uploadEvidence(page,job)).duration_seconds,45);
  job.manifest.video.duration_seconds=undefined; await assert.rejects(uploadEvidence(page,job),/时长/);
});
test('resume requires exactly one matching upload form', async t => {
  const {job}=await fixture(t), page=await pageFor(t); job.manifest.video.size_bytes=109792448;
  await page.goto('https://www.tiktok.com/tiktokstudio/upload');
  await page.setContent('<p>video.mp4 已上传（109.79MB） 00:00:00 / 00:00:45</p>');
  assert.equal(await findResumePage(page.context(),job),page);
  const another=await page.context().newPage(); await another.goto('https://www.tiktok.com/tiktokstudio/upload');
  await another.setContent(await page.content()); await assert.rejects(findResumePage(page.context(),job),/唯一/);
});
test('Chinese form saves real input, disclosures and Everyone before one submission', async t => {
  const {job}=await fixture(t), page=await pageFor(t), states=[];
  await page.setContent(form());
  const caption=await fillForm(page,job,{},1000);
  assert.equal(await page.getByRole('textbox').innerText(),caption);
  assert.equal(await page.getByRole('checkbox',{name:'AI 生成的内容'}).isChecked(),true);
  assert.equal(await page.getByRole('checkbox',{name:'内容披露'}).isChecked(),false);
  assert.equal(await page.getByRole('combobox').inputValue(),'public');
  await submitOnce(page,job,{},async (status,extra)=>{assert.equal(await page.evaluate(()=>window.posts),0);states.push({status,...extra});},{timeout:1000});
  assert.equal(states[0].status,'submitting'); assert.ok(states[0].submitted_at);
  assert.equal(await page.evaluate(()=>window.posts),1);
});
test('stale caption counter blocks submission even if editor text looks correct', async t => {
  const {job}=await fixture(t), page=await pageFor(t);
  await page.setContent(form(false));
  await assert.rejects(fillForm(page,job,{},100),/字符计数/);
  assert.equal(await page.evaluate(()=>window.posts),0);
});
test('ambiguous toggle state and ineffective public selection stop', async t => {
  const page=await pageFor(t);
  await page.setContent('<button role="switch" aria-label="AI">AI</button>');
  await assert.rejects(setToggle(page,{},'ai',/^AI$/,true),/状态/);
  await page.setContent('<div role="combobox" aria-label="仅自己">仅自己</div><button role="option">所有人</button>');
  await assert.rejects(ensurePublic(page),/权限必须/);
});
test('reviewing private video is blocked; same ID exposes caption mismatch', async t => {
  const {job}=await fixture(t), page=await pageFor(t); job.target.submitted_at='2026-09-15T10:00:30Z';
  await page.setContent(row(job,{privacy:'仅自己'}));
  let result=await resultFromRow(page.getByRole('row'),job,id);
  assert.equal(result.status,'blocked'); assert.equal(result.actual_visibility,'non_public');
  await page.setContent(row(job,{caption:'video_raw'}));
  result=await resultFromRow(page.getByRole('row'),job,id); assert.equal(result.status,'blocked'); assert.match(result.error,/文案/);
  await page.setContent(row(job)); result=await resultFromRow(page.getByRole('row'),job);
  assert.equal(result.status,'reviewing'); assert.equal(result.actual_visibility,'public');
  await page.setContent(row(job,{review:'已发布',time:false}));
  assert.equal(await resultFromRow(page.getByRole('row'),job),null);
  assert.equal((await resultFromRow(page.getByRole('row'),job,id)).status,'published');
  assert.equal(await resultFromRow(page.getByRole('row'),job,'7685696182680571999'),null);
});
test('existing post privacy is changed without uploading and verified after reload', async t => {
  const {job}=await fixture(t), page=await pageFor(t); job.target.post_id=id;
  let saved=false;
  await page.route('https://www.tiktok.com/tiktokstudio/content',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:row(job,{privacy:saved?'所有人':'仅自己'})+'<button role="menuitem" id="everyone">所有人</button>'}));
  await page.goto('https://www.tiktok.com/tiktokstudio/content');
  await page.exposeFunction('saveFixture',()=>{saved=true;});
  await page.locator('#everyone').evaluate(e=>e.onclick=()=>window.saveFixture());
  const result=await setPostPublic(page,job);
  assert.equal(saved,true); assert.equal(result.actual_visibility,'public'); assert.equal(result.status,'reviewing');
});
