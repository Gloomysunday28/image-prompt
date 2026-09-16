#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { atomicJson, sha256, lock } from './bilibili.mjs';
import { control, openSession } from './youtube.mjs';

const ROOT = join(homedir(), '.local/share/video-publish/tiktok');
const STUDIO = 'https://www.tiktok.com/tiktokstudio';
const now = () => new Date().toISOString();
const pause = ms => new Promise(r => setTimeout(r, ms));
const emit = data => console.log(JSON.stringify({ platform: 'tiktok', ...data }));
const DONE = new Set(['published', 'reviewing', 'scheduled']);
const PUBLIC = /^(所有人|Everyone)$/;
const norm = s => String(s).replace(/\r\n/g, '\n').trim();
const compact = s => norm(s).replace(/\s+/g, ' ');
const button = name => p => p.getByRole('button', { name, exact: true });
const textOf = page => page.locator('body').innerText();
const supportedHost = u => ['www.tiktok.com', 'tiktok.com'].includes(u.hostname) && u.protocol === 'https:';
export function parseArgs(args) {
  const o = { command: args.shift() || 'help', timeout: 1800000 };
  if (!['help', '--help', 'check', 'login', 'inspect', 'publish', 'resume', 'verify', 'set-public'].includes(o.command)) throw new Error('未知命令');
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (key === 'terms-accepted' && args[i] === '--terms-accepted') o.termsAccepted = true;
    else if (args[i].startsWith('--') && ['manifest', 'account', 'profile', 'cdp-url', 'state-dir', 'selectors', 'timeout'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) o[key] = args[++i];
    else throw new Error(`未知参数或缺少值：${args[i]}`);
  }
  if (o.profile && !/^[\w-]+$/.test(o.profile)) throw new Error('无效 profile');
  if (o.account) o.account = o.account.replace(/^@/, '');
  if (o['cdp-url']) {
    const u = new URL(o['cdp-url']);
    if (!['http:', 'ws:'].includes(u.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash) throw new Error('CDP 只接受无凭据的本机地址');
  }
  o.timeout = Number(o.timeout);
  if (!Number.isFinite(o.timeout) || o.timeout < 1000) throw new Error('timeout 至少为 1000 毫秒');
  return o;
}
export function decision(...records) {
  records = records.filter(Boolean);
  if (records.some(t => ['submitting', 'unknown'].includes(t.status))) return 'verify';
  if (records.some(t => DONE.has(t.status))) return 'skip';
  if (records.some(t => t.submitted_at || t.post_id)) return 'verify';
  if (records.some(t => t.upload_requested || ['uploaded', 'uploading', 'draft'].includes(t.status))) return 'resume';
  return 'new';
}
export function captionFor(data) {
  let caption = norm(data.description || '');
  if (data.title?.trim() && !caption.startsWith(data.title.trim())) caption = `${data.title.trim()}\n${caption}`;
  const tags = (data.tags || []).map(t => t.replace(/^#/, ''));
  const missing = tags.filter(t => !new RegExp(`(?:^|\\s)#${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'u').test(caption));
  if (missing.length) caption += '\n' + missing.map(t => '#' + t).join(' ');
  return norm(caption);
}
export async function loadJob(o) {
  const file = resolve(o.manifest || join(ROOT, 'current.json'));
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  const targets = manifest.targets?.filter(t => t.platform === 'tiktok') || [];
  if (targets.length !== 1) throw new Error('清单须包含且仅包含一个 TikTok 目标');
  const target = targets[0], account = o.account || target.account_id;
  if (!/^[A-Za-z0-9_.]{2,24}$/.test(account || '') || (target.account_id && target.account_id !== account)) throw new Error('TikTok 用户名缺失或与清单不一致');
  if (target.post_id && !/^\d{15,25}$/.test(target.post_id)) throw new Error('无效作品 ID');
  if (!manifest.video?.path) throw new Error('缺少 video.path');
  const video = resolve(dirname(file), manifest.video.path);
  let hash = manifest.video.sha256;
  if (['check', 'publish', 'resume'].includes(o.command)) {
    const st = await stat(video);
    if (!st.isFile() || !st.size) throw new Error('源视频不是非空文件');
    if (manifest.video.size_bytes !== st.size) throw new Error('源文件大小与清单不符');
    const actual = await sha256(video);
    if (hash && hash !== actual) throw new Error('源视频 SHA-256 与清单不符');
    hash = actual;
  }
  if (!/^[a-f0-9]{64}$/.test(hash || '')) throw new Error('缺少源文件 SHA-256');
  const data = { ...manifest.defaults, ...Object.fromEntries(Object.entries(target).filter(([, v]) => v !== null)) };
  return { file, manifest, target, account, video, hash, data, key: `${account}-${hash}` };
}
export function validatePublish(job) {
  const d = job.data, f = d.platform_fields || {};
  if (!Number.isFinite(job.manifest.video.size_bytes) || job.manifest.video.size_bytes <= 0 || !Number.isFinite(job.manifest.video.duration_seconds) || job.manifest.video.duration_seconds <= 0) throw new Error('清单缺少有效视频大小或时长');
  if (d.title != null && typeof d.title !== 'string') throw new Error('title 必须是文本');
  if (job.manifest.mode !== 'publish' || d.visibility !== 'public' || d.scheduled_at) throw new Error('当前脚本仅支持立即公开');
  if (f.original !== true || f.commercial !== false || typeof f.ai_generated !== 'boolean') throw new Error('须确认原创、无商业合作及 AI 声明');
  if (typeof d.description !== 'string' || !Array.isArray(d.tags) || d.tags.some(t => typeof t !== 'string' || !/^#?[^\s#]+$/u.test(t))) throw new Error('描述或 tags 不合法');
  const caption = captionFor(d);
  if (!caption || caption.length > 4000) throw new Error('最终文案须为 1–4000 字符');
  if (d.cover_path || d.location || f.location) throw new Error('当前脚本使用默认封面、不添加位置；不能忽略自定义设置');
  return caption;
}
export async function verifyAccount(page, expected, selectors = {}) {
  // Studio's own account link; never infer account from a URL we navigated to ourselves.
  const link = await control(page, selectors, 'account', p => p.getByRole('link', { name: expected, exact: true }));
  const u = new URL(await link.getAttribute('href'), STUDIO);
  if (!supportedHost(u) || u.pathname !== `/@${expected}`) throw new Error('当前 TikTok 账号不一致');
}
async function containsVisible(page, regex) { return page.getByText(regex).first().isVisible().catch(() => false); }
export async function assertNoGate(page, authorizedTerms = false) {
  const text = await textOf(page);
  if (/验证码|安全验证|Verify to continue|complete the captcha/i.test(text)) throw new Error('页面要求人工验证；不自动完成验证码');
  if (/上传失败|发布失败|Upload failed|Couldn't upload|Couldn't post/i.test(text)) throw new Error('平台明确报告上传或发布失败');
  if (!authorizedTerms && /(?:点击|选择|继续|发布|上传).{0,50}(?:即表示|代表).{0,50}(?:同意|接受)|by (?:clicking|posting|uploading).{0,100}(?:agree|accept)/i.test(text)) throw new Error('页面出现明确的条款接受要求；取得本次同意后记录 terms_accepted 再继续');
}
export async function dismissOnboarding(page, selectors = {}) {
  // Only the observed informational/onboarding prompts; never select a global opt-in.
  if (await containsVisible(page, /^(开启自动内容检查？|Turn on automatic content checks\?)$/)) {
    await (await control(page, selectors, 'cancelAutoChecks', button(/^(取消|Cancel)$/))).click();
  }
  if (await containsVisible(page, /全新编辑功能已上线|New editing features/)) {
    await (await control(page, selectors, 'dismissTutorial', button(/^(知道了|Got it)$/))).click();
  }
}
export async function uploadEvidence(page, job) {
  const text = await textOf(page);
  const match = text.match(/已上传[（(]([\d.]+)\s*MB[）)]|Uploaded\s*[（(]([\d.]+)\s*MB[）)]/i);
  const size = Number(match?.[1] || match?.[2]);
  const expectedSize = job.manifest.video.size_bytes / 1000000;
  const hasFile = text.includes(basename(job.video));
  if (!hasFile || !match) return null;
  if (!Number.isFinite(expectedSize) || Math.abs(size - expectedSize) > 0.15) throw new Error('页面上传大小与源文件不符');
  const duration = text.match(/\/\s*(\d\d):(\d\d):(\d\d)/);
  if (!duration) return null;
  const seconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
  if (!Number.isFinite(job.manifest.video.duration_seconds) || Math.abs(seconds - job.manifest.video.duration_seconds) > 1) throw new Error('页面预览时长与清单不符');
  return { evidence: `已上传 ${size} MB；文件名与 ${seconds} 秒预览匹配`, size_mb: size, duration_seconds: seconds };
}
export async function waitForUpload(page, job, update, o, selectors = {}) {
  const until = Date.now() + o.timeout;
  let last = '', heartbeat = 0;
  do {
    await dismissOnboarding(page, selectors); await assertNoGate(page, o.termsAccepted || job.manifest.authorization?.terms_accepted === true);
    const ready = await uploadEvidence(page, job);
    if (ready) { await update('uploaded', ready); return; }
    const text = await textOf(page);
    const progress = text.split('\n').filter(l => /上传中.*\d|Uploading.*\d|\d+(?:\.\d+)?\s*%/.test(l)).join(' ').slice(0, 180);
    if (progress && progress !== last) { last = progress; await update('uploading', { evidence: progress }); }
    if (Date.now() - heartbeat > 20000) { emit({ event: 'waiting_for_upload', evidence: progress || '等待网页上传证据，尚未确认传输' }); heartbeat = Date.now(); }
    await pause(1000);
  } while (Date.now() < until);
  throw new Error('等待上传完成超时；保留原表单，不自动重传');
}
export async function findResumePage(context, job, excluded) {
  const candidates = [];
  for (const p of context.pages()) {
    if (p === excluded) continue;
    let u; try { u = new URL(p.url()); } catch { continue; }
    if (supportedHost(u) && u.pathname === '/tiktokstudio/upload' && await uploadEvidence(p, job)) candidates.push(p);
  }
  if (candidates.length !== 1) throw new Error('找不到唯一匹配源文件名、大小、时长的已上传表单；不重传或猜测草稿');
  return candidates[0];
}
export async function setToggle(page, selectors, key, label, value) {
  // Never interpret color/position/classes as checked state. Custom controls require calibrated selector + real state attribute.
  let item = await control(page, selectors, key, p => p.getByRole('switch', { name: label }), { optional: true, timeout: 600 });
  if (!item) item = await control(page, selectors, key, p => p.getByRole('checkbox', { name: label }));
  const read = async () => item.evaluate(e => {
    if (e instanceof HTMLInputElement && ['checkbox', 'radio'].includes(e.type)) return e.checked;
    if (['true', 'false'].includes(e.getAttribute('aria-checked'))) return e.getAttribute('aria-checked') === 'true';
    if (['checked', 'unchecked'].includes(e.getAttribute('data-state'))) return e.getAttribute('data-state') === 'checked';
    return null;
  });
  const previous = await read();
  if (previous === null) throw new Error(`${key} 无可核验开关状态，必须校准 DOM；不盲点`);
  if (previous !== value) await item.click();
  const until = Date.now() + 3000;
  while (await read() !== value && Date.now() < until) await pause(100);
  if (await read() !== value) throw new Error(`${key} 未成功设置`);
}
export async function fillForm(page, job, selectors = {}, timeout = 10000) {
  await dismissOnboarding(page, selectors);
  const caption = validatePublish(job);
  const editor = await control(page, selectors, 'caption', p => p.locator('[contenteditable="true"][role="textbox"]'));
  await editor.fill(caption); await editor.press('Tab');
  const until = Date.now() + timeout;
  let saved = false;
  do {
    const editorText = await editor.innerText();
    const counter = await control(page, selectors, 'captionCounter', p => p.getByText(/^\s*\d+\s*\/\s*4000\s*$/), { timeout: 600 });
    const count = Number((await counter.innerText()).match(/\d+/)?.[0]);
    // CUA once changed DOM text while TikTok's real caption remained the filename (37/4000).
    if (norm(editorText) === caption && count === caption.length) { saved = true; break; }
    await pause(150);
  } while (Date.now() < until);
  if (!saved) throw new Error('文案与平台字符计数未同步，不能提交表面已改写但实际未保存的文本');
  const more = await control(page, selectors, 'showMore', p => p.getByText(/^(显示更多|Show more)$/), { optional: true, timeout: 600 });
  if (more) await more.click(); // Playwright scrolls the DOM control into view.
  await setToggle(page, selectors, 'ai', /AI[- ]generated content|AI 生成的内容|AI 生成内容|AI生成内容|人工智能生成的内容/i, job.data.platform_fields.ai_generated);
  await setToggle(page, selectors, 'commercial', /Disclose (?:post|commercial) content|内容披露|披露.*内容|商业内容披露/i, false);
  const immediate = await control(page, selectors, 'now', p => p.getByRole('radio', { name: /^(现在|Now)$/, exact: true }));
  await immediate.check();
  await ensurePublic(page, selectors);
  if (!await immediate.isChecked()) throw new Error('立即发布未核验');
  return caption;
}
// Handle both a native select and a calibrated accessible custom combobox.
export async function ensurePublic(page, selectors = {}) {
  const visibility = await control(page, selectors, 'visibility', p => p.getByRole('combobox', { name: /^(所有人|Everyone|仅自己|Only you|朋友|Friends)$/ }));
  const read = () => visibility.evaluate(e => e.tagName === 'SELECT' ? e.selectedOptions[0]?.textContent : e.innerText || e.getAttribute('aria-label') || '');
  if (!PUBLIC.test(norm(await read()))) {
    if (await visibility.evaluate(e => e.tagName === 'SELECT')) {
      const options = await visibility.locator('option').evaluateAll(es => es.map(e => ({ label: e.textContent.trim(), value: e.value })));
      const matches = options.filter(o => PUBLIC.test(o.label));
      if (matches.length !== 1) throw new Error('所有人选项不唯一或不存在');
      await visibility.selectOption(matches[0].value);
    } else {
      await visibility.click();
      await (await control(page, selectors, 'everyoneOption', p => p.getByRole('option', { name: PUBLIC, exact: true }))).click();
    }
  }
  if (!PUBLIC.test(norm(await read()))) throw new Error('权限必须是所有人；未设置成功，停止提交');
}
export function parsePostURL(href, expected) {
  try { const u = new URL(href, STUDIO), m = u.pathname.match(/^\/@([^/]+)\/video\/(\d{15,25})\/?$/); return supportedHost(u) && m && m[1] === expected ? { post_id: m[2], post_url: `https://www.tiktok.com/@${expected}/video/${m[2]}` } : null; } catch { return null; }
}
export async function resultFromRow(row, job, expectedId) {
  const caption = captionFor(job.data), text = await row.innerText();
  const captionMatches = compact(text).includes(compact(caption));
  if (!expectedId && !captionMatches) return null;
  const links = await row.locator('a[href]').evaluateAll(es => es.map(e => e.getAttribute('href')));
  const posts = [...new Map(links.map(l => parsePostURL(l, job.account)).filter(Boolean).map(p => [p.post_id, p])).values()];
  if (posts.length !== 1 || (expectedId && posts[0].post_id !== expectedId)) return null;
  const durationNodes = await row.getByText(/^\d{1,2}:\d{2}$/).allTextContents();
  const duration = durationNodes.length === 1 ? durationNodes[0].match(/^(\d{1,2}):(\d{2})$/) : text.match(/(?:^|\s)(\d{1,2}):(\d{2})(?:\s|$)/);
  if (!duration || Math.abs(Number(duration[1]) * 60 + Number(duration[2]) - job.manifest.video.duration_seconds) > 1) return null;
  if (!expectedId) {
    const submitted = Date.parse(job.target.submitted_at);
    const stamps = await row.locator('time[datetime]').evaluateAll(es => es.map(e => e.getAttribute('datetime')));
    if (!Number.isFinite(submitted) || !stamps.some(s => Math.abs(Date.parse(s) - submitted) < 120000)) return null;
  }
  const reviewing = /内容审查中|审核中|Under review|Processing/i.test(text);
  const published = /(?:^|\n)\s*(已发布|Published)\s*(?:\n|$)/i.test(text);
  const privacyLabels = await row.getByRole('button', { name: /^(所有人|Everyone|仅自己|Only you|朋友|Friends)$/, exact: true }).allTextContents();
  const publicLabel = privacyLabels.length === 1 && PUBLIC.test(norm(privacyLabels[0]));
  const privateLabel = privacyLabels.length === 1 && /^(仅自己|Only you|朋友|Friends)$/.test(norm(privacyLabels[0]));
  if (privateLabel || !captionMatches) return { ...posts[0], status: 'blocked', actual_visibility: privateLabel ? 'non_public' : publicLabel ? 'public' : 'unknown', actual_review_status: reviewing ? 'reviewing' : 'unknown', evidence: '已找到本次作品，但权限或文案与清单不符', error: [privateLabel && '权限不是所有人', !captionMatches && '文案与清单不一致'].filter(Boolean).join('；'), next_action: '编辑这条已存在的作品，不重新上传' };
  if (!publicLabel || (!reviewing && !published)) return null;
  return { ...posts[0], actual_visibility: 'public', status: reviewing ? 'reviewing' : 'published', evidence: reviewing ? '管理行：同账号、文案、时长、ID/提交时间，审核中' : '管理行：同账号、文案、时长、ID/提交时间，已发布且公开' };
}
export function resultRows(page, job, selectors = {}) {
  const rows = selectors.resultRow ? page.locator(selectors.resultRow) : page.getByRole('row');
  // A known ID restricts inspection to this exact post, even when other posts are visible.
  return job.target.post_id ? rows.filter({ has: page.locator(`a[href*="/video/${job.target.post_id}"]`) }) : rows;
}
export async function setPostPublic(page, job, selectors = {}) {
  if (!/^\d{15,25}$/.test(job.target.post_id || '') || job.data.visibility !== 'public') throw new Error('set-public 需要已知作品 ID 和所有人目标');
  const rows = resultRows(page, job, selectors);
  if (await rows.count() !== 1) throw new Error('当前作品行不唯一；先用 inspect 校准 resultRow');
  const row = rows.first();
  // Read canonical ID and duration before changing this existing post.
  const match = await resultFromRow(row, job, job.target.post_id);
  if (!match) throw new Error('作品账号、ID、时长或状态无法核验');
  const privacy = await control(row, selectors, 'postVisibility', p => p.getByRole('button', { name: /^(所有人|Everyone|仅自己|Only you|朋友|Friends)$/, exact: true }));
  if (!PUBLIC.test(norm(await privacy.innerText()))) {
    await privacy.click();
    const option = await control(page, selectors, 'postEveryoneOption', p => p.getByRole('menuitem', { name: PUBLIC, exact: true }));
    await option.click();
    const save = await control(page, selectors, 'privacySave', button(/^(保存|Save|确认|Confirm)$/), { optional: true, timeout: 800 });
    if (save) await save.click();
  }
  // A changed menu label is not proof that the platform saved the permission.
  await page.reload({ waitUntil: 'domcontentloaded' });
  const result = await verifyResult(page, job, selectors, 15000);
  if (result.actual_visibility !== 'public') throw new Error('刷新后权限仍不是所有人，尚未公开');
  return result;
}
export async function verifyResult(page, job, selectors = {}, timeout = 60000) {
  const until = Date.now() + timeout;
  do {
    const rows = resultRows(page, job, selectors);
    const matches = [];
    for (let i = 0; i < await rows.count(); i++) {
      const row = rows.nth(i);
      if (await row.isVisible()) { const result = await resultFromRow(row, job, job.target.post_id); if (result) matches.push(result); }
    }
    if (matches.length > 1) throw new Error('存在多个匹配发布记录，不能猜测结果');
    if (matches.length === 1) return matches[0];
    await pause(1000);
  } while (Date.now() < until);
  throw new Error('未取得匹配文案、时长和 ID/提交时间的管理行；需 inspect 校准结果容器，不能宣称发布成功');
}
export async function submitOnce(page, job, selectors, update, o) {
  await assertNoGate(page, o.termsAccepted || job.manifest.authorization?.terms_accepted === true);
  const text = await textOf(page);
  if (/检查中|正在检查|Checking|Check in progress/.test(text)) throw new Error('内容检查尚在进行，等待完成后再提交');
  if (/发现版权问题|存在版权问题|将被静音|将被屏蔽|Copyright issues found|will be muted|will be blocked/i.test(text)) throw new Error('检查提示版权或播放限制；需先查看具体结果');
  await ensurePublic(page, selectors);
  const submit = await control(page, selectors, 'publish', button(/^(发布|Post)$/));
  await update('submitting', { submitted_at: now(), evidence: '文案计数与公开/AI声明核验完成，准备单次提交' });
  await submit.click();
  // A confirmation, notice, or ambiguous result must never cause an automatic second Post click.
}
export async function inspect(page) {
  return page.locator('input,button,[role],[contenteditable],label').evaluateAll(es => es.map(e => ({ tag: e.tagName, id: e.id, role: e.getAttribute('role'), type: e.getAttribute('type'), label: e.getAttribute('aria-label'), text: e.matches('button,label,[role="switch"]') ? (e.innerText || '').slice(0,160) : undefined, checked: e.getAttribute('aria-checked'), state: e.getAttribute('data-state') }))); // No form values, cookies, or signed URLs.
}
export async function main(args = process.argv.slice(2)) {
  const o = parseArgs(args);
  if (['help', '--help'].includes(o.command)) { console.log(`TikTok DOM 投稿脚本\ncheck | login | inspect | publish | resume | verify | set-public\n默认清单：${ROOT}/current.json\n--manifest JSON --account 用户名 --cdp-url 本机入口 或 --profile main\n--selectors JSON --state-dir 目录 --timeout 毫秒 --terms-accepted\n详见 ../references/tiktok-script.md`); return; }
  const job = await loadJob(o), state = resolve(o['state-dir'] || ROOT), ledgerFile = join(state, 'jobs', `${job.key}.json`);
  const readLedger = async () => { try { return JSON.parse(await readFile(ledgerFile, 'utf8')); } catch(e) { if (e.code !== 'ENOENT') throw e; return null; } };
  let ledger = await readLedger();
  if (o.command === 'check') { emit({ decision: decision(job.target, ledger), account: job.account, status: job.target.status, video: job.video, sha256: job.hash, caption: validatePublish(job) }); return; }
  if (o.command === 'publish' && decision(job.target, ledger) !== 'new') { emit({ decision: decision(job.target, ledger), note: '已有上传或发布记录，不选择文件；使用 resume 或 verify' }); return; }
  if (!o['cdp-url'] && !o.profile) throw new Error('需要已启用的 --cdp-url，或明确选择 --profile main；不自动另起浏览器或复制登录凭据');
  if (['publish', 'resume'].includes(o.command)) validatePublish(job);
  if (o.command === 'resume' && (!o['cdp-url'] || decision(job.target, ledger) !== 'resume')) throw new Error('resume 只恢复 CDP 中仍打开且无提交记录的原表单');
  const release = await lock(join(state, 'locks', `${o['cdp-url'] ? 'cdp' : o.profile}.lock`));
  let releaseJob, session, page, touched = false, submitting = false;
  const update = async (status, extra = {}) => {
    if (status === 'submitting') submitting = true;
    Object.assign(job.target, extra, { status, last_verified_at: now() });
    if (DONE.has(status)) { job.target.upload_requested = false; job.target.error = null; job.target.next_action = null; }
    job.manifest.updated_at = now(); job.manifest.video.sha256 = job.hash;
    await atomicJson(ledgerFile, { ...job.target, sha256: job.hash }); await atomicJson(job.file, job.manifest);
    emit({ status, ...extra });
  };
  try {
    releaseJob = await lock(`${ledgerFile}.lock`); ledger = await readLedger();
    const d = decision(job.target, ledger);
    if ((o.command === 'publish' && d !== 'new') || (o.command === 'resume' && d !== 'resume')) throw new Error('状态已变化，停止重复上传/提交');
    for (const k of ['post_id', 'post_url', 'submitted_at']) if (ledger?.[k]) job.target[k] = ledger[k];
    const selectors = o.selectors ? JSON.parse(await readFile(resolve(o.selectors), 'utf8')) : {};
    const { chromium } = await import('playwright-core');
    session = await openSession(chromium, o, state); page = session.page; page.setDefaultTimeout(15000);
    await page.goto(STUDIO, { waitUntil: 'domcontentloaded' });
    if (o.command === 'login') { const rl = createInterface({ input:process.stdin, output:process.stdout }); try { await rl.question('在浏览器自行登录 TikTok 并选好账号后按回车：'); } finally { rl.close(); } }
    await verifyAccount(page, job.account, selectors); emit({ account_verified: job.account });
    if (o.command === 'login') return;
    if (['verify', 'set-public'].includes(o.command)) {
      await (await control(page, selectors, 'content', button(/^(作品|Posts)$/))).click();
      const result = o.command === 'set-public' ? await setPostPublic(page, job, selectors) : await verifyResult(page, job, selectors, Math.min(o.timeout,60000));
      await update(result.status, { ...result, management_url: page.url() }); return;
    }
    if (o.command === 'inspect' || o.command === 'resume') {
      if (d === 'resume' && o['cdp-url']) page = await findResumePage(session.context, job, page);
      else if (o.command === 'resume') throw new Error('原表单不存在');
      else { await (await control(page, selectors, 'content', button(/^(作品|Posts)$/))).click(); }
      if (o.command === 'inspect') { emit({ controls: await inspect(page), note: '仅诊断，不上传或提交' }); return; }
      touched = true;
    } else {
      await (await control(page, selectors, 'upload', button(/^(上传|Upload)$/))).click();
      await assertNoGate(page, o.termsAccepted || job.manifest.authorization?.terms_accepted === true);
      const select = await control(page, selectors, 'selectFiles', button(/^(选择视频|Select video)$/));
      await update('prepared', { upload_requested: true, evidence: '准备选择文件，尚未确认传输' }); touched = true;
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), select.click()]);
      await chooser.setFiles(job.video); emit({ event: 'file_selected' });
    }
    await waitForUpload(page, job, update, o, selectors);
    const caption = await fillForm(page, job, selectors);
    await update('uploaded', { actual_caption: caption });
    await submitOnce(page, job, selectors, update, o);
    // A visible success receipt may offer a separate route to the saved content list.
    if (await containsVisible(page, /视频已上传|发布成功|已发布|Your video has been uploaded|Post uploaded|Posted successfully/i)) {
      const manage = await control(page, selectors, 'managePosts', button(/^(管理作品|Manage posts|View posts|作品|Posts)$/), { optional: true, timeout: 1000 });
      if (manage) await manage.click();
    }
    const result = await verifyResult(page, job, selectors, 60000);
    await update(result.status, { ...result, management_url: page.url() });
  } catch (e) {
    if (touched) await update(submitting ? 'unknown' : 'blocked', { error: e.message, next_action: submitting ? 'verify：核验这次提交，不再次发布' : 'inspect 校准原表单，resume 继续，不重传' });
    throw e;
  } finally {
    try { await session?.close({ keepPage: touched && page === session.page && !DONE.has(job.target.status) }); }
    finally { try { await releaseJob?.(); } finally { await release(); } }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(e => { emit({ error: e.message }); process.exitCode = 1; });
