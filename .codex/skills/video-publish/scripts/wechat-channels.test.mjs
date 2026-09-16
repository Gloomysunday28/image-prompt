import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { atomicJson, sha256 } from './bilibili.mjs';
import { parseArgs, parsePages, decision, captionFor, loadJob, stageVideo, validatePublish, pageDOM, uploadReady, matchRow, fillForm, submitOnce, verifyResult, verifyAccount, main } from './wechat-channels.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-script-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const video = join(dir, '原视频.mp4'); await writeFile(video, 'synthetic video');
  const manifest = { mode: 'publish', authorization: { user_instruction: '发布到微信视频号' }, video: { path: video, sha256: await sha256(video), size_bytes: 15, duration_seconds: 45.138 }, targets: [{ platform: 'wechat_channels', account_id: 'sphTest123', account_label: '测试视频号', title: '微缩小屋', description: '在溪边搭一座小屋。', tags: ['微缩世界', 'AI视频'], visibility: 'public', status: 'prepared', platform_fields: { ai_generated: true } }] };
  const file = join(dir, 'job.json'); await atomicJson(file, manifest);
  return { dir, file, manifest, job: await loadJob({ manifest: file, command: 'publish' }) };
}
async function browserFor(t, html) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const context = await browser.newContext(); await context.route('**/*', r => r.fulfill({ contentType: 'text/html', body: '' }));
  const page = await context.newPage();
  await page.setContent('<div id="host"></div>');
  // Match the live Wujie open shadow root; hidden templates must not count.
  await page.locator('#host').evaluate((e, html) => { e.attachShadow({ mode: 'open' }).innerHTML = html; }, html);
  const driver = {
    page,
    dom: async (_id, op, args = {}) => {
      const r = await page.evaluate(pageDOM, { op, ...args }); if (r?.error) throw new Error(r.error); return r;
    },
    snapshot: async () => 'uid=1_9 button "发表"',
    call: async name => { assert.equal(name, 'click'); await page.getByRole('button', { name: '发表', exact: true }).click(); },
  };
  return driver;
}
const form = `<span>测试视频号</span><div class="input-editor" contenteditable></div><input placeholder="填写短标题有机会获得更多流量" maxlength="16">
<div class="mark-tag-select"><span class="select-display" onclick="this.nextElementSibling.hidden=false">选择视频标注</span><div class="mark-tag-options" hidden><span class="option-main" onclick="this.parentElement.previousElementSibling.innerText=this.innerText;this.parentElement.hidden=true">含AI生成内容</span></div></div>
<div class="post-position-wrap"><div class="position-display" onclick="this.nextElementSibling.hidden=false">杭州市</div><div class="location-item" hidden><span class="name" onclick="this.parentElement.previousElementSibling.innerText=this.innerText;this.parentElement.hidden=true">不显示位置</span></div></div>
<span>不参与活动</span><span>选择链接</span><span>选择合集</span>
<input type="radio" value="0"><span>不定时</span><button>发表</button><video style="width:100px;height:80px"></video>
<div hidden><span>管理员本人验证</span><span>含AI生成内容</span></div>`;
async function mediaReady(b, duration = 45.138) {
  await b.page.locator('video').evaluate((e, duration) => { Object.defineProperty(e, 'duration', { configurable: true, value: duration }); Object.defineProperty(e, 'readyState', { configurable: true, value: 4 }); }, duration);
}

test('argument validation, conservative replay policy and captions', () => {
  assert.equal(parseArgs(['publish']).autoConnect, undefined);
  assert.throws(() => parseArgs(['publish', '--cdp-url', 'http://remote.test:9222']), /本机/);
  assert.throws(() => parseArgs(['publish', '--cdp-url', 'http://secret@localhost:9222']), /本机/);
  assert.throws(() => parseArgs(['publish', '--auto-connect', '--cdp-url', 'http://localhost:9222']));
  assert.equal(decision({ status: 'published' }), 'skip');
  assert.equal(decision({ status: 'published' }, { status: 'unknown' }), 'verify');
  assert.equal(decision({ status: 'failed', submitted_at: '2026-09-16' }), 'verify');
  assert.equal(decision({ status: 'prepared', upload_requested: true }), 'resume');
  assert.equal(captionFor({ description: '原文 #AI视频', tags: ['AI视频', '微缩建筑'] }), '原文 #AI视频\n#微缩建筑');
  assert.deepEqual(parsePages('1: 视频号助手 (https://channels.weixin.qq.com/platform) [selected]\n2: https://other.test/\n3: https://channels.weixin.qq.com/platform/post/create'), [{ id: 1, url: 'https://channels.weixin.qq.com/platform' }, { id: 3, url: 'https://channels.weixin.qq.com/platform/post/create' }]);
});

test('staging preserves bytes and rejects changed originals', async t => {
  const { job, file } = await fixture(t), staged = await stageVideo(job); t.after(() => rm(staged.directory, { recursive: true, force: true }));
  assert.ok(staged.path.startsWith(tmpdir())); assert.equal(staged.sha256, job.hash);
  assert.deepEqual(await readFile(staged.path), await readFile(job.video));
  await writeFile(job.video, 'different video');
  await assert.rejects(loadJob({ manifest: file, command: 'publish' }), /SHA-256/);
  await assert.rejects(stageVideo(job), /校验失败/);
});

test('unsupported settings and unconfirmed declarations block publication', async t => {
  const { job } = await fixture(t); validatePublish(job);
  for (const change of [{ visibility: 'private' }, { scheduled_at: '2026-09-17' }, { cover: '/custom.png' }, { platform_fields: { ai_generated: false } }, { platform_fields: { ai_generated: true, commercial: true } }]) {
    assert.throws(() => validatePublish({ ...job, data: { ...job.data, ...change } }));
  }
});

test('shadow DOM input saves Chinese text and applies AI/immediate settings', async t => {
  const { job } = await fixture(t), b = await browserFor(t, form); await mediaReady(b);
  await fillForm(b, 1, job);
  const s = await b.dom(1, 'read');
  assert.equal(s.caption, captionFor(job.data)); assert.equal(s.title, '微缩小屋'); assert.equal(s.immediate, true);
  assert.ok(s.texts.includes('含AI生成内容')); assert.ok(!s.texts.includes('管理员本人验证'));
  assert.equal(s.annotation, '含AI生成内容'); assert.equal(s.location, '不显示位置');
  assert.equal(uploadReady(s, job), true);
  assert.equal(uploadReady({ ...s, texts: [...s.texts, '99%'] }, job), false);
  assert.equal(uploadReady({ ...s, videos: [{ duration: 44, ready: 4 }] }, job), false);
  await b.dom(1, 'mark', { key: job.key }); assert.equal((await b.dom(1, 'read')).marker, job.key);
});

test('submit persists intent before one click; processing prevents any click', async t => {
  const { job } = await fixture(t), b = await browserFor(t, form); await mediaReady(b); await fillForm(b, 1, job);
  const events = []; const original = b.call;
  b.call = async (...args) => { events.push('click'); return original(...args); };
  await submitOnce(b, 1, job, async status => events.push(status));
  assert.deepEqual(events, ['submitting', 'click']);
  await b.page.locator('#host').evaluate(e => { const span = document.createElement('span'); span.textContent = '正在处理文件'; e.shadowRoot.append(span); });
  await assert.rejects(submitOnce(b, 1, job, async () => events.push('bad')), /尚未完成/);
  assert.deepEqual(events, ['submitting', 'click']);
});

test('account verification uses actual visible ID, never only the name', async t => {
  const { job } = await fixture(t), b = await browserFor(t, '<span>sphWrong999</span><span>测试视频号</span>');
  await assert.rejects(verifyAccount(b, 1, job, 500), /ID 与清单不符/);
});

test('result matching requires full caption, timestamp and uniqueness', async t => {
  const { job } = await fixture(t); job.target.submitted_at = '2026-09-16T06:57:20Z';
  const row = { caption: captionFor(job.data), text: '2026年09月16日 14:57' };
  assert.ok(matchRow({ rows: [row] }, job));
  assert.equal(matchRow({ rows: [{ ...row, text: '2026年09月15日 14:57' }] }, job), null);
  assert.equal(matchRow({ rows: [{ ...row, caption: '别的文案' }] }, job), null);
  assert.throws(() => matchRow({ rows: [row, row] }, job), /多个/);
  job.target.submitted_at = 'invalid'; assert.equal(matchRow({ rows: [row] }, job), null);
});

test('verification checks privacy and playable duration without changing privacy', async t => {
  const { job } = await fixture(t); job.target.submitted_at = '2026-09-16T06:57:20Z';
  const row = { caption: captionFor(job.data), text: '2026年09月16日 14:57' }, ops = [];
  const b = { dom: async (_id, op) => {
    ops.push(op);
    if (op !== 'read') return true;
    return { texts: ['设为仅自己可见', '取消'], rows: [row], videos: [{ duration: 45.138, ready: 4 }] };
  } };
  assert.equal((await verifyResult(b, 1, job, 1000)).status, 'published');
  assert.deepEqual(ops, ['read', 'privacy', 'read', 'clickText', 'preview', 'read', 'closePreview']);
  b.dom = async (_id, op) => op === 'read' ? { texts: [], rows: [{ ...row, text: row.text + '\n处理中' }] } : assert.fail('processing must not open controls');
  assert.equal((await verifyResult(b, 1, job, 1000)).status, 'unknown');
});

test('published local ledger prevents a new upload even with a renamed manifest', async t => {
  const { dir, file, job } = await fixture(t);
  await atomicJson(join(dir, 'jobs', job.key + '.json'), { status: 'published' });
  // No browser is running: this must return before loading/connecting a driver.
  await main(['publish', '--manifest', file, '--state-dir', dir]);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).targets[0].status, 'prepared');
});
