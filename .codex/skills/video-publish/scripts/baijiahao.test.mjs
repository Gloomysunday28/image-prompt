import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { atomicJson, sha256 } from './bilibili.mjs';
import { parseArgs, parsePages, decision, loadJob, validatePublish, stageVideo, pageDOM, uploadReady, fillForm, submitOnce, verifyAccount, matchRow, rowResult, waitReceipt, main, ACCOUNT, LIST } from './baijiahao.mjs';

async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'baijiahao-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const video=join(dir,'原视频_raw.mp4');await writeFile(video,'synthetic video');
  const manifest={mode:'publish',authorization:{user_instruction:'发布到百家号'},video:{path:video,sha256:await sha256(video),size_bytes:15,duration_seconds:45.138},targets:[{platform:'baijiahao',account_id:'1876470897107369',account_label:'测试账号',title:'溪边微缩小屋',description:'溪边微缩小屋',tags:[],visibility:'public',status:'prepared',platform_fields:{ai_generated:true}}]};
  const file=join(dir,'manifest.json');await atomicJson(file,manifest);
  return {dir,file,job:await loadJob({manifest:file,command:'publish'})};
}
async function browserFor(t,html) {
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const context=await browser.newContext();await context.route('**/*',r=>r.fulfill({body:'',contentType:'text/html'}));
  const page=await context.newPage();await page.goto(ACCOUNT);await page.setContent(html);
  const driver={page,dom:async(_id,op,args={})=>{const r=await page.evaluate(pageDOM,{op,...args});if(r?.error)throw new Error(r.error);return r;},snapshot:async()=> 'uid=1_8 button "发布"',call:async(name)=>{assert.equal(name,'click');await page.getByRole('button',{name:'发布',exact:true}).click();}};
  return driver;
}
const form=`<span>@测试账号</span><div contenteditable="true" role="textbox" oninput="document.querySelector('#preview').textContent=this.innerText;document.querySelector('#counter').textContent=this.innerText.length+'/50'">old_filename_raw</div><p id="preview">old_filename_raw</p><p id="counter">16/50</p>
<span>更换</span><div data-testid="cover-preview"><img style="width:30px;height:30px" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="></div><div data-testid="cover-preview"><img style="width:30px;height:30px" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="></div>
<input placeholder="请选择创作声明" readonly onclick="document.querySelector('[role=dialog]').hidden=false"><div role="dialog" hidden><label><input type="radio" name="declaration"><span>无需声明</span></label><label><input type="radio" name="declaration" value="ai"><span>含AI生成内容</span></label><button onclick="document.querySelector('input[placeholder]').value=document.querySelector('input[value=ai]').checked?'含AI生成内容':'';this.parentElement.hidden=true">确定</button></div><button>发布</button><div hidden>百度安全验证</div>`;

test('only local CDP; pages are scoped; uncertain records take precedence',()=>{
  assert.throws(()=>parseArgs(['publish','--cdp-url','https://remote.test']),/本机/);
  assert.deepEqual(parsePages('2: 百家号 (https://baijiahao.baidu.com/builder/rc/home) [selected]\n3: https://qiyehao.baidu.com/unauth'),[{id:2,url:'https://baijiahao.baidu.com/builder/rc/home'}]);
  assert.equal(decision({status:'reviewing'}),'skip');
  assert.equal(decision({status:'blocked',submitted_at:'2026-09-16'}),'verify');
  assert.equal(decision({status:'prepared',upload_requested:true}),'resume');
  assert.equal(decision({status:'published'},{status:'unknown'}),'verify');
});
test('OS temporary copy preserves exact filename/bytes and catches source changes',async t=>{
  const {job,file}=await fixture(t),stage=await stageVideo(job);t.after(()=>rm(stage.directory,{recursive:true,force:true}));
  assert.ok(stage.path.startsWith(tmpdir()));assert.ok(stage.path.endsWith('/原视频_raw.mp4'));assert.deepEqual(await readFile(stage.path),await readFile(job.video));
  await writeFile(job.video,'changed');await assert.rejects(loadJob({manifest:file,command:'publish'}),/SHA-256/);await assert.rejects(stageVideo(job),/SHA-256/);
});
test('requires factual AI declaration and rejects unsupported scope',async t=>{
  const {job}=await fixture(t);validatePublish(job);
  for(const data of [{tags:['微缩']},{visibility:'private'},{scheduled_at:'2026-09-17'},{platform_fields:{}},{platform_fields:{ai_generated:true,commercial:true}},{description:'长'.repeat(51)},{cover_path:'/cover.png'}])assert.throws(()=>validatePublish({...job,data:{...job.data,...data}}));
});
test('clears default filename; verifies saved preview/count and actual AI radio',async t=>{
  const {job}=await fixture(t),b=await browserFor(t,form);await b.dom(1,'mark',{key:job.key});await fillForm(b,1,job);
  const s=await b.dom(1,'read');assert.equal(s.caption,'溪边微缩小屋');assert.equal(s.previewCopies,1);assert.equal(s.counter.value,6);assert.equal(s.annotation,'含AI生成内容');assert.equal(s.captcha,false);assert.equal(uploadReady(s,job),true);
  assert.equal(uploadReady({...s,text:s.text+'\n99%'},job),false);assert.equal(uploadReady({...s,covers:[]},job),false);assert.equal(uploadReady({...s,marker:'other'},job),false);
});
test('persist submitting before the only click; block a second attempt',async t=>{
  const {job}=await fixture(t),b=await browserFor(t,form);await b.dom(1,'mark',{key:job.key});await fillForm(b,1,job);
  const events=[],call=b.call;b.call=async(...args)=>{events.push('click');return call(...args);};
  await submitOnce(b,1,job,async(status,extra)=>{events.push(status);Object.assign(job.target,extra,{status});});
  assert.deepEqual(events,['submitting','click']);await assert.rejects(submitOnce(b,1,job,()=>assert.fail()),/已有提交记录/);assert.equal(events.length,2);
});
test('account verification requires visible stable ID, not a URL parameter',async t=>{
  const {job}=await fixture(t),b=await browserFor(t,'<div>测试账号</div><p>百家号ID：1876470897107369</p>');await verifyAccount(b,1,job,1000);
  await b.page.setContent('<div>测试账号</div><p>百家号ID：99999999999999</p>');await assert.rejects(verifyAccount(b,1,job,1000),/不符/);
});
test('known post ID wins; new receipt requires full caption and time; no guessed public status',async t=>{
  const {job}=await fixture(t);job.target.submitted_at='2026-09-16T07:10:00Z';
  const row={post_id:'1234567890123',caption:job.data.description,time:'2026-09-16 15:10:40',text:'溪边微缩小屋\n2026-09-16 15:10:40\n审核中',preview_url:'https://baijiahao.baidu.com/builder/preview/s?id=1234567890123'};
  assert.equal(matchRow({rows:[row]},job),row);assert.equal(matchRow({rows:[{...row,time:'2026-09-15 15:10:40'}]},job),null);assert.throws(()=>matchRow({rows:[row,row]},job),/多个/);
  job.target.post_id=row.post_id;assert.equal(matchRow({rows:[{...row,time:'other'}]},job)?.post_id,row.post_id);assert.throws(()=>matchRow({rows:[{...row,caption:'wrong'}]},job),/文案/);
  assert.equal(rowResult(row).status,'reviewing');assert.equal(rowResult({...row,text:'已发布'}).status,'unknown');assert.equal(rowResult(row).post_url,null);
});
test('captcha waits for human completion then follows receipt without clicking again',async t=>{
  const {job}=await fixture(t);let reads=0;const events=[];
  const b={dom:async()=>++reads===1?{captcha:true}:{captcha:false,url:LIST,text:'提交成功，正在审核中',receipt:true,management_url:LIST+'?app_id='+job.account},goto:async(_id,url)=>events.push(url)};
  await waitReceipt(b,1,job,async(s)=>events.push(s),3000);assert.deepEqual(events,['blocked','reviewing',LIST+'?app_id='+job.account]);
});
test('captcha timeout retains submitted identity; wrong account receipt is rejected',async t=>{
  const {job}=await fixture(t);job.target.submitted_at='2026-09-16T07:10:00Z';
  const b={dom:async()=>({captcha:true})};assert.equal(await waitReceipt(b,1,job,async(s,e)=>Object.assign(job.target,e,{status:s}),1),false);assert.equal(decision(job.target),'verify');
  b.dom=async()=>({captcha:false,url:LIST,text:'提交成功，正在审核中',receipt:true,management_url:LIST+'?app_id=99999999999999'});await assert.rejects(waitReceipt(b,1,job,()=>{},1),/回执账号/);
});
test('ledger prevents uploading same source through a new manifest without opening browser',async t=>{
  const {job,dir,file}=await fixture(t);await atomicJson(join(dir,'jobs',job.key+'.json'),{status:'reviewing',post_id:'1234567890123'});
  await main(['publish','--manifest',file,'--state-dir',dir]);assert.equal(JSON.parse(await readFile(file,'utf8')).targets[0].status,'prepared');
});
