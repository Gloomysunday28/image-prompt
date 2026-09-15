import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, loadJob, validatePublish, validateResume, resumeDecision, atomicJson, lock, sha256, main, fillForm, selectVideo, waitForUpload, openBrowserSession } from './bilibili.mjs';
import { chromium } from 'playwright-core';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bili-publish-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'video.mp4'), 'fixture-video');
  const target = { platform: 'bilibili', account_id: '123', status: 'prepared', title: '海边小屋', description: '测试', tags: ['微缩'], visibility: 'public', platform_fields: { original: true, commercial: false, creation_declaration: '含AI生成内容', category: '手工' } };
  const manifest = { mode: 'publish', video: { path: 'video.mp4' }, defaults: {}, targets: [target] };
  const file = join(dir, 'job.json');
  await atomicJson(file, manifest);
  return { dir, file, manifest, options: { manifest: file, account: '123', termsAccepted: true } };
}

test('explicit CLI and safe profile names', () => {
  assert.equal(parseArgs(['inspect']).profile, 'main');
  assert.equal(parseArgs(['inspect', '--profile', 'previous']).profile, 'previous');
  assert.equal(parseArgs(['inspect', '--cdp-url', 'http://127.0.0.1:9222'])['cdp-url'], 'http://127.0.0.1:9222');
  assert.throws(() => parseArgs(['inspect', '--cdp-url', 'http://remote.example:9222']));
  assert.throws(() => parseArgs(['inspect', '--cdp-url', 'http://user:secret@localhost:9222']));
  assert.equal(parseArgs(['publish', '--profile', 'main', '--account', '123', '--terms-accepted']).termsAccepted, true);
  assert.throws(() => parseArgs(['publish', '--profile', '../Default']));
  assert.throws(() => parseArgs(['publish', '--account']));
  assert.throws(() => parseArgs(['delete']));
});

test('CDP reuses browser storage and disconnects without closing existing pages', async t => {
  const f = await fixture(t);
  const profile = join(f.dir, 'cdp-browser');
  const owner = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, args: ['--remote-debugging-port=0'] });
  t.after(() => owner.close());
  const existing = owner.pages()[0];
  await existing.setContent('<title>Existing user page</title><p>keep me</p>');
  await owner.addCookies([{ name: 'fixture_session', value: 'synthetic', domain: 'example.test', path: '/' }]);
  const [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
  const session = await openBrowserSession(chromium, { profile: 'main', 'cdp-url': `http://127.0.0.1:${port}` }, f.dir);
  assert.notEqual(session.page, existing);
  assert.equal((await session.context.cookies('https://example.test')).find(c => c.name === 'fixture_session')?.value, 'synthetic');
  await session.close();
  assert.equal(existing.isClosed(), false);
  assert.equal(await existing.title(), 'Existing user page');
  assert.equal(owner.pages().length, 1);
});

test('file paths resolve relative to manifest and content identity is checked', async t => {
  const f = await fixture(t);
  const job = await loadJob(f.options);
  assert.equal(job.video, join(f.dir, 'video.mp4'));
  assert.equal(job.hash, await sha256(job.video));
  f.manifest.video.sha256 = job.hash;
  await atomicJson(f.file, f.manifest);
  await writeFile(job.video, 'different-video');
  await assert.rejects(loadJob(f.options), /SHA-256/);
});

test('mismatched account and ambiguous B站 targets are rejected before browser launch', async t => {
  const f = await fixture(t);
  await assert.rejects(loadJob({ ...f.options, account: '456' }), /不一致/);
  f.manifest.targets.push({ ...f.manifest.targets[0] });
  await atomicJson(f.file, f.manifest);
  await assert.rejects(loadJob(f.options), /只能有一条/);
});

test('unsupported declarations, schedule and visibility cannot silently become public posts', async t => {
  const f = await fixture(t);
  const job = await loadJob(f.options);
  validatePublish(job, f.options);
  assert.throws(() => validatePublish(job, { ...f.options, termsAccepted: false }), /协议/);
  job.data.platform_fields.original = false;
  assert.throws(() => validatePublish(job, f.options), /原创/);
  job.data.platform_fields.original = true;
  job.data.scheduled_at = '2026-09-20T20:00:00+08:00';
  assert.throws(() => validatePublish(job, f.options), /立即公开/);
  job.data.scheduled_at = null;
  job.data.visibility = 'private';
  assert.throws(() => validatePublish(job, f.options), /立即公开/);
});

test('copied manifests cannot bypass published ledger; uncertain uploads require reconciliation', () => {
  assert.equal(resumeDecision({ status: 'prepared' }, { status: 'reviewing', post_id: 'BV123' }), 'skip');
  assert.equal(resumeDecision({ status: 'prepared' }, { status: 'submitting' }), 'reconcile');
  assert.equal(resumeDecision({ status: 'blocked', upload_started: true }), 'reconcile');
  assert.equal(resumeDecision({ status: 'published' }, { status: 'unknown' }), 'reconcile');
  assert.equal(resumeDecision({ status: 'blocked', upload_started: false }), 'new');
  assert.equal(resumeDecision({ status: 'prepared', upload_requested: true }), 'reconcile');
});

test('selects the visible upload component instead of the internal uploader and requires page evidence', async t => {
  const f = await fixture(t);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <div class="bcc-upload-wrapper"><input type="file" accept=".mp4" onchange="document.querySelector('#form').hidden=false"></div>
    <input type="file" name="buploader" accept=".mp4">
    <div id="form" hidden>稿件标题</div><div id="progress"></div>
  `);
  await selectVideo(page, {}, join(f.dir, 'video.mp4'));
  assert.equal(await page.locator('#form').isVisible(), true);
  assert.equal(await page.locator('[name=buploader]').evaluate(el => el.files.length), 0);
  const progress = [];
  await assert.rejects(waitForUpload(page, p => progress.push(p), { timeout: 50 }), /不能确认文件开始传输/);
  assert.deepEqual(progress, []);
  await page.locator('#progress').evaluate(el => {
    el.textContent = '上传中 5 MB/s';
    setTimeout(() => { el.textContent = '上传完成'; }, 1000);
  });
  await waitForUpload(page, p => progress.push(p), { timeout: 5000 });
  assert.deepEqual(progress, ['上传中 5 MB/s']);
});

test('exclusive lock prevents concurrent jobs and can be reacquired after release', async t => {
  const f = await fixture(t);
  const file = join(f.dir, 'job.lock');
  const release = await lock(file);
  await assert.rejects(lock(file), /已有任务占用/);
  await release();
  const releaseAgain = await lock(file);
  await releaseAgain();
});

test('resume only accepts uploaded forms with no evidence of an earlier submission', () => {
  const job = { target: { status: 'blocked', upload_started: true } };
  validateResume(job, null);
  assert.throws(() => validateResume({ target: { status: 'prepared', upload_requested: true } }, null), /没有可恢复/);
  assert.throws(() => validateResume(job, { status: 'unknown' }), /已有提交记录/);
  assert.throws(() => validateResume(job, { status: 'reviewing', post_id: 'BV123' }), /已有提交记录/);
  assert.throws(() => validateResume(job, { submitted_at: '2026-09-15' }), /已有提交记录/);
});

test('atomic manifest update preserves unrelated targets', async t => {
  const f = await fixture(t);
  const other = { platform: 'youtube', status: 'published', post_id: 'untouched' };
  f.manifest.targets.push(other);
  await atomicJson(f.file, f.manifest);
  const job = await loadJob(f.options);
  job.target.status = 'reviewing';
  await atomicJson(f.file, job.manifest);
  assert.deepEqual(JSON.parse(await readFile(f.file)).targets[1], other);
});

test('CLI skips already submitted job without launching a browser or changing the manifest', async t => {
  const f = await fixture(t);
  f.manifest.targets[0].status = 'reviewing';
  f.manifest.targets[0].post_id = 'BV1g2en6wEsu';
  await atomicJson(f.file, f.manifest);
  const before = await readFile(f.file, 'utf8');
  await main(['publish', '--manifest', f.file, '--account', '123', '--state-dir', join(f.dir, 'state')]);
  assert.equal(await readFile(f.file, 'utf8'), before);
});

test('DOM form workflow fills and verifies fields without screenshots or submitting', async t => {
  const f = await fixture(t);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <input id="title" placeholder="请输入稿件标题">
    <textarea aria-label="填写更全面的相关信息，让更多的人能找到你的视频吧"></textarea>
    <input id="declaration" readonly placeholder="请选择符合您视频内容的创作声明">
    <button id="ai" onclick="document.querySelector('#declaration').value=this.textContent">含AI生成内容</button>
    <input id="category" value="手工">
    <span id="tags">旧标签</span><input id="tag" placeholder="按回车键Enter创建标签">
    <input id="cover" type="file" accept="image/*" onchange="document.querySelector('#ready').hidden=false">
    <span id="ready" hidden>封面设置</span>
    <label><input type="checkbox" checked>增加商业推广信息</label>
    <label><input type="checkbox" checked>定时发布</label>
    <button onclick="window.submitted=true">立即投稿</button>
    <script>
      window.tags=['旧标签'];
      document.querySelector('#tag').addEventListener('keydown',e=>{
        if(e.key==='Backspace' && !e.target.value) window.tags.pop();
        if(e.key==='Enter'){window.tags.push(e.target.value);e.target.value='';}
        document.querySelector('#tags').textContent=window.tags.join(',');
      });
    </script>
  `);
  const cover = join(f.dir, 'cover.jpg');
  await writeFile(cover, 'mock-image-file');
  const job = await loadJob(f.options);
  await fillForm(page, job, { category: '#category' }, cover);
  assert.equal(await page.locator('#title').inputValue(), '海边小屋');
  assert.equal(await page.locator('#declaration').inputValue(), '含AI生成内容');
  assert.deepEqual(await page.evaluate(() => window.tags), ['微缩']);
  assert.equal(await page.locator('#cover').evaluate(el => el.files[0].name), 'cover.jpg');
  assert.equal(await page.getByRole('checkbox', { name: '增加商业推广信息' }).isChecked(), false);
  assert.equal(await page.getByRole('checkbox', { name: '定时发布' }).isChecked(), false);
  assert.equal(await page.evaluate(() => Boolean(window.submitted)), false);
  await page.locator('textarea').evaluate(el => el.after(el.cloneNode(true)));
  await assert.rejects(fillForm(page, job, { category: '#category' }, cover), /description 匹配 2/);
});
