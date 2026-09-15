#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { atomicJson, lock, sha256, openBrowserSession } from './bilibili.mjs';

const ROOT = join(homedir(), '.local/share/video-publish/youtube');
const STUDIO = 'https://studio.youtube.com/';
const now = () => new Date().toISOString();
const pause = ms => new Promise(r => setTimeout(r, ms));
const emit = data => console.log(JSON.stringify({ platform: 'youtube', ...data }));
const DONE = new Set(['published', 'scheduled']);
const CHANNEL = /^UC[\w-]{22}$/;
const VIDEO_ID = /^[\w-]{11}$/;
export const editURL = id => {
  if (!VIDEO_ID.test(id || '')) throw new Error('缺少有效 YouTube 视频 ID，不能猜测或新建视频');
  return `${STUDIO}video/${id}/edit`;
};

export function parseArgs(args) {
  const options = { command: args.shift() || 'help', timeout: 1800000 };
  if (!['help', '--help', 'check', 'login', 'inspect', 'publish', 'resume', 'verify'].includes(options.command)) throw new Error('未知命令');
  const keys = new Set(['manifest', 'account', 'profile', 'cdp-url', 'state-dir', 'selectors', 'timeout']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (args[i] === '--terms-accepted') options.termsAccepted = true;
    else if (args[i].startsWith('--') && keys.has(key) && args[i + 1] && !args[i + 1].startsWith('--')) options[key] = args[++i];
    else throw new Error(`未知参数或缺少值：${args[i]}`);
  }
  if (options.profile && !/^[\w-]+$/.test(options.profile)) throw new Error('无效 profile 名称');
  if (options.account && !CHANNEL.test(options.account)) throw new Error('account 必须是 UC 开头的频道 ID');
  if (options['cdp-url']) {
    const u = new URL(options['cdp-url']);
    if (!['http:', 'ws:'].includes(u.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash) throw new Error('CDP 只接受不带凭据的本机调试地址');
  }
  options.timeout = Number(options.timeout);
  if (!Number.isFinite(options.timeout) || options.timeout < 1000) throw new Error('timeout 须为至少 1000 毫秒');
  return options;
}

export function decision(...records) {
  records = records.filter(Boolean);
  if (records.some(t => ['submitting', 'unknown'].includes(t.status))) return 'verify';
  if (records.some(t => DONE.has(t.status))) return 'skip';
  if (records.some(t => t.upload_requested || t.post_id || ['uploading', 'uploaded', 'draft'].includes(t.status))) return 'resume';
  return 'new';
}

export async function loadJob(options) {
  const file = resolve(options.manifest || join(ROOT, 'current.json'));
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  const targets = manifest.targets?.filter(t => t.platform === 'youtube') || [];
  if (targets.length !== 1) throw new Error('清单须且只能包含一个 YouTube 目标');
  const target = targets[0];
  const account = options.account || target.account_id;
  if (!CHANNEL.test(account || '') || (target.account_id && target.account_id !== account)) throw new Error('频道 ID 缺失或与清单不一致');
  const data = { ...manifest.defaults, ...Object.fromEntries(Object.entries(target).filter(([, v]) => v !== null)) };
  if (!manifest.video?.path) throw new Error('缺少 video.path');
  const video = resolve(dirname(file), manifest.video.path);
  let hash = manifest.video.sha256;
  if (['check', 'publish', 'resume'].includes(options.command)) {
    const info = await stat(video);
    if (!info.isFile() || !info.size) throw new Error('源视频不是非空文件');
    const actual = await sha256(video);
    if (hash && hash !== actual) throw new Error('源视频 SHA-256 已变化');
    hash = actual;
  }
  if (!/^[a-f0-9]{64}$/.test(hash || '')) throw new Error('缺少源视频 SHA-256；先运行 check');
  return { file, manifest, target, data, account, video, hash, key: `${account}-${hash}` };
}

export function validatePublish(job, options) {
  const d = job.data, f = d.platform_fields || {};
  if (job.manifest.mode !== 'publish' || d.visibility !== 'public' || d.scheduled_at) throw new Error('当前脚本只支持立即公开，不支持定时或私密目标');
  if (!d.title?.trim() || [...d.title].length > 100 || /[<>]/.test(d.title)) throw new Error('标题须为 1–100 字符且不含尖括号');
  if (typeof d.description !== 'string' || [...d.description].length > 5000 || /[<>]/.test(d.description)) throw new Error('简介须为不超过 5000 字符的文本且不含尖括号');
  if (!Array.isArray(d.tags) || d.tags.some(t => typeof t !== 'string' || !t.trim() || t.includes(',')) || d.tags.join(',').length > 500) throw new Error('tags 不合法或超过 500 字符');
  if (f.original !== true || f.commercial !== false || typeof f.altered_content !== 'boolean' || typeof f.made_for_kids !== 'boolean') throw new Error('须确认原创、无商业合作、AI 声明和儿童受众；不猜测声明');
  if (d.cover_path || job.manifest.defaults?.cover_path) throw new Error('当前脚本使用平台默认截帧，不忽略自定义封面要求');
  if (!options.termsAccepted && job.manifest.authorization?.terms_accepted !== true) throw new Error('清单缺少本次上传条款同意记录；已同意可用 --terms-accepted');
}

// Roles/names come from the English Studio UI observed on 2026-09-15.
// CSS overrides are explicit calibration, never a silent screenshot fallback.
export async function control(page, selectors, key, factory, { optional = false, timeout = 12000 } = {}) {
  const locator = selectors[key] ? page.locator(selectors[key]) : factory(page);
  const until = Date.now() + timeout;
  do {
    const visible = [];
    for (let i = 0; i < await locator.count(); i++) if (await locator.nth(i).isVisible()) visible.push(locator.nth(i));
    if (visible.length > 1) throw new Error(`${key} 控件不唯一，请校准 --selectors`);
    if (visible.length === 1) return visible[0];
    await pause(150);
  } while (Date.now() < until);
  if (optional) return null;
  throw new Error(`找不到 ${key}；页面语言、登录或控件可能变化，请运行 inspect`);
}
const button = name => p => p.getByRole('button', { name, exact: true });
const titleField = p => p.getByRole('textbox', { name: 'Add a title that describes your video (type @ to mention a channel)', exact: true });
const descriptionField = p => p.getByRole('textbox', { name: 'Tell viewers about your video (type @ to mention a channel)', exact: true });
const readText = l => l.evaluate(e => 'value' in e ? e.value : e.innerText);
const bodyText = p => p.locator('body').innerText();

export async function verifyAccount(page, expected) {
  const home = await control(page, {}, 'channelDashboard', p => p.getByRole('link', { name: 'YouTube Studio dashboard', exact: true }));
  const url = new URL(await home.getAttribute('href'), STUDIO);
  const actual = url.pathname.match(/^\/channel\/(UC[\w-]{22})(?:\/|$)/)?.[1];
  if (actual !== expected || url.origin !== 'https://studio.youtube.com') throw new Error('当前登录频道与目标不一致；请在浏览器切换频道');
  return actual;
}

async function findPostId(page) {
  const links = await page.getByRole('link').evaluateAll(els => els.map(e => e.getAttribute('href') || ''));
  const ids = [...new Set(links.flatMap(href => {
    try { const u = new URL(href, STUDIO); return u.hostname === 'youtu.be' && VIDEO_ID.test(u.pathname.slice(1)) ? [u.pathname.slice(1)] : []; }
    catch { return []; }
  }))];
  if (ids.length > 1) throw new Error('页面出现多个视频链接，无法确定本次稿件');
  return ids[0];
}

export async function waitForUpload(page, filename, update, { timeout = 1800000 } = {}) {
  const until = Date.now() + timeout;
  let id, last = '', lastEmit = 0;
  while (Date.now() < until) {
    const text = await bodyText(page);
    if (/Upload failed|Processing abandoned|Error uploading|File is too large|Invalid file format/i.test(text)) throw new Error('YouTube 明确报告上传或处理失败');
    const currentId = await findPostId(page);
    if (currentId && currentId !== id) { id = currentId; await update('prepared', { post_id: id, evidence: '页面已生成本次视频 ID，尚未确认传输或上传完成' }); }
    const progress = text.split('\n').filter(l => /Uploading.*\d|\d.*uploaded|Processing up to|Upload complete|Checks complete/i.test(l)).join(' ').slice(0, 240);
    if (progress && (progress !== last || Date.now() - lastEmit > 20000)) {
      last = progress; lastEmit = Date.now();
      await update(/Uploading.*\d|\d.*uploaded/i.test(progress) ? 'uploading' : 'uploaded', { evidence: progress });
    }
    if (id && text.includes(filename) && /Upload complete|Processing up to|Checks complete/i.test(text)) return id;
    await pause(1000);
  }
  throw new Error('未能在时限内确认上传完成；保留记录，不自动重新上传');
}

async function chooseRadio(page, selectors, key, name) {
  const radio = await control(page, selectors, key, p => p.getByRole('radio', { name, exact: true }));
  await radio.check();
  if (!await radio.isChecked()) throw new Error(`${key} 未选中`);
}
export async function fillDetails(page, job, selectors = {}) {
  const title = await control(page, selectors, 'title', titleField);
  const desc = await control(page, selectors, 'description', descriptionField);
  await title.fill(job.data.title); await desc.fill(job.data.description); await desc.press('Tab');
  if ((await readText(title)).trim() !== job.data.title.trim() || (await readText(desc)).trim() !== job.data.description.trim()) throw new Error('标题或简介未正确写入');
  const f = job.data.platform_fields;
  await chooseRadio(page, selectors, 'audience', f.made_for_kids ? /^Yes, it's made for kids/ : "No, it's not made for kids");
  const more = await control(page, selectors, 'showMore', button('Show advanced settings'), { optional: true, timeout: 800 });
  if (more) await more.click();
  await chooseRadio(page, selectors, 'commercial', /^No, my video (doesn’t|doesn't) include paid promotion$/);
  await chooseRadio(page, selectors, 'ai', f.altered_content ? 'Yes, AI was used' : /^No, AI (wasn’t|wasn't) used$/);
  // Hashtags in description are retained. Tags field is an optional extra metadata field.
  if (job.data.tags.length) {
    const tags = await control(page, selectors, 'tags', p => p.getByRole('textbox', { name: 'Tags', exact: true }));
    await tags.fill(job.data.tags.join(',')); await tags.press('Enter'); await tags.press('Tab');
  }
}

export function checkResult(text) {
  if (/doesn.t affect the video right now/i.test(text)) return 'claim_no_current_impact';
  if (/No issues found/i.test(text)) return 'clear';
  return 'pending_or_restricted';
}
async function nextTo(page, selectors, heading) {
  await (await control(page, selectors, 'next', button('Next'))).click();
  await control(page, {}, `step:${heading}`, p => p.getByRole('heading', { name: heading, exact: true }));
}
export async function finishWizard(page, selectors, update, options) {
  await nextTo(page, selectors, 'Video elements');
  await nextTo(page, selectors, 'Checks');
  const until = Date.now() + options.timeout;
  let result;
  do {
    result = checkResult(await bodyText(page));
    if (result !== 'pending_or_restricted') break;
    if (/video (is |will be )?blocked|cannot be published/i.test(await bodyText(page))) throw new Error('版权检查阻止发布，请查看详情');
    await pause(1000);
  } while (Date.now() < until);
  if (result === 'pending_or_restricted') throw new Error('检查尚未完成或存在未识别限制；不自动忽略');
  await update('uploaded', { copyright_check: result, evidence: 'YouTube 检查完成' });
  await nextTo(page, selectors, 'Visibility');
  await chooseRadio(page, selectors, 'public', 'Public');
  const premiere = await control(page, selectors, 'premiere', p => p.getByRole('checkbox', { name: 'Set as instant Premiere', exact: true }), { optional: true, timeout: 500 });
  if (premiere?.isChecked && await premiere.isChecked()) { await premiere.uncheck(); }
  const submit = await control(page, selectors, 'publish', button('Publish'));
  await update('submitting', { submitted_at: now(), evidence: 'Public 已选，准备单次点击 Publish' });
  await submit.click(); // Never retry a potentially successful submission.
}

export async function verifyVideo(page, job, id, selectors = {}) {
  await page.goto(editURL(id), { waitUntil: 'domcontentloaded' });
  await control(page, {}, 'videoDetails', p => p.getByRole('heading', { name: 'Video details', exact: true }));
  await verifyAccount(page, job.account);
  const title = await control(page, selectors, 'title', titleField);
  if ((await readText(title)).trim() !== job.data.title.trim()) throw new Error('该 ID 的标题与清单不一致');
  const text = await bodyText(page);
  if (!text.includes(basename(job.video))) throw new Error('该 ID 的源文件名与清单不一致');
  const publicLabel = await control(page, selectors, 'publicStatus', p => p.getByText('Public', { exact: true }), { optional: true, timeout: 1000 });
  const privateLabel = await control(page, selectors, 'privateStatus', p => p.getByText('Private', { exact: true }), { optional: true, timeout: 500 });
  return { status: publicLabel ? 'published' : privateLabel ? 'draft' : 'unknown', post_id: id, post_url: `https://youtu.be/${id}`, management_url: editURL(id), evidence: publicLabel ? '已按 ID 核对频道、标题、源文件名；管理页 Visibility=Public' : '管理页尚未确认公开', quality_4k_complete: await page.getByRole('img', { name: '4K complete', exact: true }).count() > 0, copyright_notice: /Potential earning limitation/.test(text) ? 'Potential earning limitation' : null };
}

export async function inspectControls(page) {
  return page.locator('button,input,[role],textarea,[contenteditable]').evaluateAll(els => els.map(e => ({ tag: e.tagName.toLowerCase(), id: e.id, role: e.getAttribute('role'), type: e.getAttribute('type'), label: e.getAttribute('aria-label'), placeholder: e.getAttribute('placeholder') }))); // Never dump values, cookies, or upload URLs.
}

// Keep a failed CDP upload page available for resume. Never close a borrowed browser.
export async function openSession(chromium, options, state) {
  if (!options['cdp-url']) return openBrowserSession(chromium, options, state);
  const browser = await chromium.connectOverCDP(options['cdp-url'], { noDefaults: true, timeout: 15000 });
  try {
    const contexts = browser.contexts();
    if (contexts.length !== 1) throw new Error('浏览器上下文不唯一');
    const context = contexts[0], page = await context.newPage();
    return { context, page, close: async ({ keepPage = false } = {}) => {
      try { if (!keepPage && !page.isClosed()) await page.close(); }
      finally { await browser.close(); }
    } };
  } catch (e) { await browser.close(); throw e; }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (['help', '--help'].includes(options.command)) {
    console.log('YouTube DOM 投稿脚本\n命令：check | login | inspect | publish | resume | verify\n默认清单：' + join(ROOT, 'current.json') + '\n参数：--manifest JSON --account UC频道ID --cdp-url 本机入口 或 --profile main --selectors JSON --timeout 毫秒 --state-dir 目录 --terms-accepted\n默认不另起浏览器；指定 CDP 复用现有登录，或明确选择持久化 profile。详见 ../references/youtube-script.md'); return;
  }
  const job = await loadJob(options);
  const state = resolve(options['state-dir'] || ROOT);
  const ledgerFile = join(state, 'jobs', `${job.key}.json`);
  const readLedger = async () => { try { return JSON.parse(await readFile(ledgerFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; return null; } };
  let ledger = await readLedger();
  if (options.command === 'check') {
    validatePublish(job, options);
    emit({ decision: decision(job.target, ledger), status: ledger?.status || job.target.status, video: job.video, account: job.account, sha256: job.hash, post_id: ledger?.post_id || job.target.post_id }); return;
  }
  if (options.command === 'publish' && decision(job.target, ledger) !== 'new') { emit({ decision: decision(job.target, ledger), post_id: ledger?.post_id || job.target.post_id, note: '已有记录，不创建新视频；按 ID 核验或恢复' }); return; }
  if (!options['cdp-url'] && !options.profile) throw new Error('请提供已启用的 --cdp-url；或明确用 --profile main 保留独立登录。不会自动新开浏览器或复制 token');
  if (['publish', 'resume'].includes(options.command)) validatePublish(job, options);
  const release = await lock(join(state, 'locks', `${options['cdp-url'] ? 'cdp' : options.profile}.lock`));
  let releaseJob, session, page, mutated = false, submitted = false;
  const update = async (status, extra = {}) => {
    Object.assign(job.target, { status, account_id: job.account, last_verified_at: now(), ...extra });
    if (DONE.has(status)) job.target.upload_requested = false;
    job.manifest.video.sha256 = job.hash; job.manifest.updated_at = now();
    if (status === 'submitting') submitted = true; // Preserve uncertainty even if a later disk write fails.
    await atomicJson(ledgerFile, { ...job.target, sha256: job.hash });
    await atomicJson(job.file, job.manifest);
    emit({ status, ...extra });
  };
  try {
    releaseJob = await lock(`${ledgerFile}.lock`); ledger = await readLedger();
    if (ledger) for (const key of ['status', 'upload_requested', 'post_id', 'post_url', 'management_url', 'submitted_at', 'copyright_check']) if (ledger[key] !== undefined) job.target[key] = ledger[key];
    if (options.command === 'publish' && decision(job.target, ledger) !== 'new') throw new Error('另一任务已处理此视频，停止上传');
    const selectors = options.selectors ? JSON.parse(await readFile(resolve(options.selectors), 'utf8')) : {};
    const { chromium } = await import('playwright-core');
    session = await openSession(chromium, options, state);
    page = session.page; page.setDefaultTimeout(15000);
    await page.goto(STUDIO, { waitUntil: 'domcontentloaded' });
    if (options.command === 'login') {
      console.log('在浏览器中登录 YouTube 并选好频道后，回终端按回车。登录信息由浏览器保存。');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { await rl.question(''); } finally { rl.close(); }
    }
    await verifyAccount(page, job.account); emit({ account_verified: job.account });
    const id = ledger?.post_id || job.target.post_id;
    if (options.command === 'login') return;
    if (options.command === 'verify') {
      const result = await verifyVideo(page, job, id, selectors);
      // Read-only verification must not clear an unresolved submission merely because it is still private.
      if (result.status === 'published') await update(result.status, result);
      else emit(result);
      return;
    }
    if (options.command === 'inspect') {
      if (id) await page.goto(editURL(id), { waitUntil: 'domcontentloaded' });
      await control(page, {}, 'ready', id ? titleField : button('Upload videos'));
      emit({ controls: await inspectControls(page) }); return;
    }
    if (options.command === 'resume') {
      if (decision(job.target, ledger) !== 'resume' || !id) throw new Error('恢复要求已上传视频 ID 且没有已发布或结果不明记录；否则先 verify');
      // Resume the still-open upload wizard, not a second upload or an unrelated draft.
      if (!options['cdp-url']) throw new Error('resume 需 CDP 连接仍打开的原上传向导；已关闭的草稿请先 inspect 管理页');
      const candidates = [];
      for (const p of session.context.pages()) {
        if (p !== page && p.url().startsWith(STUDIO) && await findPostId(p) === id && await p.getByRole('tab', { name: 'Details', exact: true }).isVisible().catch(() => false)) candidates.push(p);
      }
      if (candidates.length !== 1) throw new Error('未找到唯一的原上传向导；不会重新上传或猜测草稿');
      page = candidates[0];
      if (!(await bodyText(page)).includes(basename(job.video))) throw new Error('恢复视频源文件名不一致');
      await verifyAccount(page, job.account);
      await page.getByRole('tab', { name: 'Details', exact: true }).click();
      await control(page, {}, 'details', p => p.getByRole('heading', { name: 'Details', exact: true }));
      mutated = true;
      await waitForUpload(page, basename(job.video), update, options);
    } else {
      await (await control(page, selectors, 'upload', button('Upload videos'))).click();
      const select = await control(page, selectors, 'selectFiles', button('Select files'));
      await update('prepared', { upload_requested: true, evidence: '即将选择文件，尚未确认传输' }); mutated = true;
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), select.click()]);
      await chooser.setFiles(job.video); emit({ event: 'file_selected', note: '等待网页进度，不等同上传中' });
      const newId = await waitForUpload(page, basename(job.video), update, options);
      await update('uploaded', { post_id: newId, post_url: `https://youtu.be/${newId}`, management_url: editURL(newId) });
    }
    await fillDetails(page, job, selectors);
    await finishWizard(page, selectors, update, options);
    await control(page, selectors, 'receipt', p => p.getByText('Video published', { exact: true }), { timeout: 60000 });
    await update('submitting', { evidence: '已收到 Video published 回执，正在管理页核验' });
    const result = await verifyVideo(page, job, job.target.post_id || id, selectors);
    await update(result.status === 'published' ? 'published' : 'unknown', { ...result, status: result.status === 'published' ? 'published' : 'unknown' });
  } catch (error) {
    if (mutated) await update(submitted ? 'unknown' : 'blocked', { error: error.message, next_action: submitted ? 'verify：按现有 ID 核验，不重传或重发' : '检查同一上传记录并校准选择器；不要清空状态重传' });
    throw error;
  } finally {
    try { await session?.close({ keepPage: mutated && page === session.page && !DONE.has(job.target.status) }); }
    finally { try { await releaseJob?.(); } finally { await release(); } }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { emit({ error: error.message }); process.exitCode = 1; });
