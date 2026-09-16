#!/usr/bin/env node
import { readFile, stat, mkdtemp, copyFile, chmod, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { atomicJson, sha256, lock } from './bilibili.mjs';

const ROOT = join(homedir(), '.local/share/video-publish/wechat_channels');
const HOME = 'https://channels.weixin.qq.com/platform';
const CREATE = `${HOME}/post/create`, LIST = `${HOME}/post/list`;
const now = () => new Date().toISOString();
const pause = ms => new Promise(r => setTimeout(r, ms));
const compact = s => String(s || '').trim().replace(/\s+/g, ' ');
const emit = value => console.log(JSON.stringify({ platform: 'wechat_channels', ...value }));

export function parseArgs(args) {
  const o = { command: args.shift() || 'help', timeout: 1800000 };
  if (!['help', '--help', 'check', 'stage', 'login', 'inspect', 'publish', 'resume', 'verify'].includes(o.command)) throw new Error('未知命令');
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (args[i] === '--auto-connect') o.autoConnect = true;
    else if (args[i].startsWith('--') && ['manifest', 'state-dir', 'cdp-url', 'page-id', 'timeout'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) o[key] = args[++i];
    else throw new Error(`未知参数或缺少值：${args[i]}`);
  }
  if (o.autoConnect && o['cdp-url']) throw new Error('连接方式只能选择一种');
  if (o['cdp-url']) {
    const u = new URL(o['cdp-url']);
    if (!['http:', 'ws:'].includes(u.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash) throw new Error('CDP 只接受无凭据的本机地址');
  }
  if (o['page-id'] && !/^\d+$/.test(o['page-id'])) throw new Error('page-id 必须是整数');
  o.timeout = Number(o.timeout);
  if (!Number.isFinite(o.timeout) || o.timeout < 1000) throw new Error('timeout 至少为 1000 毫秒');
  return o;
}

export function decision(...records) {
  const rs = records.filter(Boolean);
  if (rs.some(t => ['submitting', 'unknown'].includes(t.status))) return 'verify';
  if (rs.some(t => ['published', 'reviewing', 'scheduled'].includes(t.status))) return 'skip';
  if (rs.some(t => t.submitted_at || t.post_id)) return 'verify';
  if (rs.some(t => t.upload_requested || ['uploading', 'uploaded', 'draft'].includes(t.status))) return 'resume';
  return 'new';
}

export function captionFor(data) {
  let result = (data.description || '').trim();
  const present = new Set(result.match(/#[^\s#]+/gu) || []);
  const missing = (data.tags || []).map(t => '#' + t.replace(/^#/, '')).filter(t => !present.has(t));
  if (missing.length) result += '\n' + [...new Set(missing)].join(' ');
  return result.trim();
}

export async function loadJob(o) {
  const file = resolve(o.manifest || join(ROOT, 'current.json'));
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  const targets = manifest.targets?.filter(t => t.platform === 'wechat_channels') || [];
  if (targets.length !== 1) throw new Error('清单须包含且仅包含一个微信视频号目标');
  const target = targets[0], account = target.account_id;
  if (!/^sph[A-Za-z0-9_-]+$/.test(account || '') || !target.account_label?.trim()) throw new Error('缺少视频号 ID 或名称');
  if (!manifest.video?.path || !/^[a-f0-9]{64}$/.test(manifest.video.sha256 || '')) throw new Error('缺少源文件路径或 SHA-256');
  const video = resolve(dirname(file), manifest.video.path), hash = manifest.video.sha256;
  if (['check', 'stage', 'publish', 'resume'].includes(o.command)) {
    const st = await stat(video);
    if (!st.isFile() || !st.size || st.size !== manifest.video.size_bytes || await sha256(video) !== hash) throw new Error('源文件大小或 SHA-256 与清单不符');
  }
  const data = { ...manifest.defaults, ...Object.fromEntries(Object.entries(target).filter(([, v]) => v !== null)) };
  return { file, manifest, target, account, video, hash, data, key: `${account}-${hash}` };
}

export function validatePublish(job) {
  const d = job.data, f = d.platform_fields || {};
  if (job.manifest.mode !== 'publish' || d.visibility !== 'public' || d.scheduled_at) throw new Error('当前脚本只支持立即公开发布');
  if (!job.manifest.authorization?.user_instruction?.trim()) throw new Error('清单缺少用户发布指令');
  if (!Number.isFinite(job.manifest.video.size_bytes) || !(job.manifest.video.size_bytes > 0) || !Number.isFinite(job.manifest.video.duration_seconds) || !(job.manifest.video.duration_seconds > 0)) throw new Error('缺少有效大小或时长');
  if (f.ai_generated !== true) throw new Error('当前脚本只支持已确认含 AI 生成内容的视频');
  if (f.commercial === true || f.original === false) throw new Error('商业合作或转载声明尚未支持');
  if (d.cover_path || (d.cover && d.cover !== '平台默认封面') || (f.location && f.location !== '不显示位置') || f.collection || f.link || f.activity) throw new Error('当前脚本只使用默认封面、不显示位置、不关联合集/链接/活动');
  if (typeof d.description !== 'string' || !d.description.trim() || !Array.isArray(d.tags) || d.tags.some(t => typeof t !== 'string' || !/^#?[^\s#]+$/u.test(t))) throw new Error('描述或话题无效');
  const title = f.short_title ?? d.title;
  if (typeof title !== 'string' || !title.trim()) throw new Error('缺少短标题');
  return { caption: captionFor(d), title: title.trim() };
}

// Use the OS temp root explicitly allowed by chrome-devtools-mcp. Never disable
// path validation, use symlinks, or silently transcode the original.
export async function stageVideo(job) {
  const directory = await mkdtemp(join(tmpdir(), 'video-publish-wechat-'));
  const path = join(directory, basename(job.video));
  try {
    await copyFile(job.video, path); await chmod(path, 0o600);
    const st = await stat(path);
    if (st.size !== job.manifest.video.size_bytes || await sha256(path) !== job.hash) throw new Error('临时上传副本校验失败');
    return { directory, path, sha256: job.hash, size_bytes: st.size };
  } catch (e) { await rm(directory, { recursive: true, force: true }); throw e; }
}

export class Browser {
  async connect(o) {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const entry = fileURLToPath(new URL('./bin/chrome-devtools-mcp.js', import.meta.resolve('chrome-devtools-mcp')));
    const args = [entry, '--no-usage-statistics', '--no-performance-crux'];
    if (o['cdp-url']) args.push(o['cdp-url'].startsWith('ws:') ? '--wsEndpoint' : '--browserUrl', o['cdp-url']);
    else args.push('--autoConnect');
    this.transport = new StdioClientTransport({ command: process.execPath, args, env: { ...process.env }, stderr: 'pipe' });
    this.transport.stderr?.on('data', () => {}); // Do not persist browser logs or credentials.
    this.client = new Client({ name: 'wechat-channels-publisher', version: '1.0.0' });
    await this.client.connect(this.transport);
  }
  async call(name, args = {}) {
    const r = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
    const text = (r.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (r.isError || /^Error:/m.test(text)) throw new Error(text.slice(0, 700));
    return text;
  }
  async pages() { return parsePages(await this.call('list_pages')); }
  async snapshot(id) { return this.call('take_snapshot', { pageId: id }); }
  async dom(id, op, data = {}) {
    const text = await this.call('evaluate_script', { pageId: id, function: `() => (${pageDOM.toString()})(${JSON.stringify({ op, ...data })})`, waitForStableDom: op !== 'read' });
    const result = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (!result) throw new Error('浏览器没有返回可解析的 DOM 结果');
    const value = JSON.parse(result[1]);
    if (value?.error) throw new Error(value.error);
    return value;
  }
  async goto(id, url) { await this.call('navigate_page', { pageId: id, type: 'url', url }); }
  async close() { await this.client?.close(); } // Disconnect, leave Chrome and its tabs open.
}

export function parsePages(text) {
  return text.split('\n').flatMap(line => {
    const m = line.match(/^(\d+): .*?(https:\/\/channels\.weixin\.qq\.com\/[^\s)]*)/);
    return m ? [{ id: Number(m[1]), url: m[2] }] : [];
  });
}

// This function is serialized into the page. It uses only rendered DOM and the
// HTML media element API; no Vue stores, private endpoints, cookies or tokens.
export function pageDOM(a) {
  const roots = [document], seen = new Set(), nodes = [];
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i]; if (seen.has(root)) continue; seen.add(root);
    for (const e of root.querySelectorAll('*')) { nodes.push(e); if (e.shadowRoot) roots.push(e.shadowRoot); }
  }
  const norm = s => String(s || '').trim().replace(/\s+/g, ' ');
  const visible = e => !!(e.getBoundingClientRect().width && e.getBoundingClientRect().height) && getComputedStyle(e).visibility !== 'hidden';
  const matches = selector => nodes.filter(e => e.matches(selector) && visible(e));
  const one = selector => { const es = matches(selector); if (es.length !== 1) throw new Error(`DOM 控件不唯一或不可见：${selector}`); return es[0]; };
  const textNodes = nodes.filter(e => visible(e) && e.children.length === 0 && !e.matches('script,style'));
  const exact = text => {
    const es = textNodes.filter(e => norm(e.innerText) === text);
    if (es.length !== 1) throw new Error(`文字控件不唯一或不可见：${text}`);
    return es[0];
  };
  const setInput = (e, text) => {
    if (e.maxLength > 0 && [...text].length > e.maxLength) throw new Error('短标题超过当前页面长度限制');
    Object.getOwnPropertyDescriptor(e.ownerDocument.defaultView.HTMLInputElement.prototype, 'value').set.call(e, text);
    e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const rows = matches('.post-feed-item');
  const chosenRow = () => {
    const found = rows.filter(e => norm(e.querySelector('.post-title')?.innerText) === norm(a.caption) && (!a.timeText || e.innerText.includes(a.timeText)));
    if (found.length !== 1) throw new Error('没有唯一匹配文案和时间的作品行');
    return found[0];
  };
  try {
    if (a.op === 'clickText') { exact(a.text).click(); return true; }
    if (a.op === 'fill') {
      const editor = one('.input-editor[contenteditable]'); editor.focus();
      const range = document.createRange(); range.selectNodeContents(editor);
      const selection = editor.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      if (!editor.ownerDocument.execCommand('insertText', false, a.caption)) throw new Error('描述编辑器输入失败');
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: a.caption }));
      editor.blur(); setInput(one('input[placeholder="填写短标题有机会获得更多流量"]'), a.title);
      return true;
    }
    if (a.op === 'immediate') {
      const radio = matches('input[type=radio]').filter(e => e.value === '0');
      if (radio.length !== 1) throw new Error('不定时控件不唯一');
      if (!radio[0].checked) radio[0].click(); return radio[0].checked;
    }
    if (a.op === 'openAnnotation') { one('.mark-tag-select .select-display').click(); return true; }
    if (a.op === 'selectAI') {
      const options = matches('.mark-tag-options .option-main').filter(e => norm(e.innerText) === '含AI生成内容');
      if (options.length !== 1) throw new Error('AI 标注选项不唯一'); options[0].click(); return true;
    }
    if (a.op === 'openLocation') { one('.post-position-wrap .position-display').click(); return true; }
    if (a.op === 'clearLocation') {
      const options = matches('.post-position-wrap .location-item .name').filter(e => norm(e.innerText) === '不显示位置');
      if (options.length !== 1) throw new Error('不显示位置选项不唯一'); options[0].click(); return true;
    }
    if (a.op === 'mark') { document.documentElement.dataset.videoPublishJob = a.key; return true; }
    if (a.op === 'privacy') {
      const wrap = [...chosenRow().querySelectorAll('.opr-item-wrap')].find(e => norm(e.innerText) === '可见权限');
      if (!wrap) throw new Error('作品尚无可见权限入口'); wrap.querySelector('.opr-item').click(); return true;
    }
    if (a.op === 'preview') {
      const thumb = chosenRow().querySelector('img.thumb'); if (!thumb) throw new Error('作品没有预览封面'); thumb.click(); return true;
    }
    if (a.op === 'closePreview') { matches('video').forEach(e => e.pause()); one('.close-icon.weui-icon-filled-close').click(); return true; }
    const texts = textNodes.map(e => norm(e.innerText)).filter(Boolean);
    const editor = matches('.input-editor[contenteditable]'), title = matches('input[placeholder="填写短标题有机会获得更多流量"]');
    return {
      url: location.href, texts, marker: document.documentElement.dataset.videoPublishJob || null,
      caption: editor.length === 1 ? editor[0].innerText.trim() : null, title: title.length === 1 ? title[0].value : null,
      annotation: matches('.mark-tag-select .select-display').map(e => norm(e.innerText)).join(''),
      location: matches('.post-position-wrap .position-display').map(e => norm(e.innerText)).join(''),
      immediate: matches('input[type=radio]').some(e => e.value === '0' && e.checked),
      videos: matches('video').map(e => ({ duration: Number.isFinite(e.duration) ? e.duration : null, ready: e.readyState })),
      rows: rows.map(e => ({ caption: e.querySelector('.post-title')?.innerText || '', text: e.innerText })),
      controls: a.op === 'inspect' ? matches('input,button,[contenteditable]').map(e => ({ tag: e.tagName, type: e.getAttribute('type'), placeholder: e.getAttribute('placeholder'), role: e.getAttribute('role'), class: e.className })) : undefined,
    };
  } catch (e) { return { error: e.message }; }
}

export function guard(state) {
  const text = state.texts.join('\n');
  if (/管理员本人验证|实名信息核验|扫码验证|验证码|你还不能发表视频/.test(text)) throw new Error('页面要求人工登录、身份验证或管理权限；保留页面等待处理');
  if (/上传失败|发表失败|格式不支持|不支持.{0,8}格式/.test(text)) throw new Error('平台明确报告上传或发表失败');
  if (/(?:点击|继续|发表|上传).{0,30}(?:即表示|代表).{0,30}(?:同意|接受)/.test(text)) throw new Error('页面出现新增条款要求，需按主技能及当前授权处理');
}

export function uploadReady(state, job) {
  guard(state);
  if (state.texts.some(t => /^(\d+(?:\.\d+)?%|正在处理文件|取消上传)$/.test(t))) return false;
  return state.videos.some(v => v.ready >= 2 && Math.abs(v.duration - job.manifest.video.duration_seconds) < 0.5);
}

export async function waitUpload(browser, id, job, update, timeout) {
  const deadline = Date.now() + timeout; let last = '', beat = 0;
  do {
    const state = await browser.dom(id, 'read');
    if (uploadReady(state, job)) { await update('uploaded', { evidence: `页面预览已就绪，时长 ${job.manifest.video.duration_seconds} 秒匹配` }); return; }
    const progress = state.texts.filter(t => /^(\d+(?:\.\d+)?%|正在处理文件|取消上传)$/.test(t)).join(' ');
    if (progress && progress !== last) { last = progress; await update('uploading', { evidence: progress }); }
    if (Date.now() - beat > 20000) { emit({ event: 'waiting_for_upload', evidence: progress || '等待页面上传证据' }); beat = Date.now(); }
    await pause(1500);
  } while (Date.now() < deadline);
  throw new Error('上传处理超时，保留同一表单，使用 resume；不重传');
}

export async function fillForm(browser, id, job) {
  const form = validatePublish(job); await browser.dom(id, 'fill', form);
  let state = await browser.dom(id, 'read');
  if (state.annotation !== '含AI生成内容') {
    await browser.dom(id, 'openAnnotation');
    await browser.dom(id, 'selectAI');
  }
  if (state.location !== '不显示位置') {
    await browser.dom(id, 'openLocation');
    await browser.dom(id, 'clearLocation');
  }
  await browser.dom(id, 'immediate');
  state = await browser.dom(id, 'read'); guard(state);
  if (compact(state.caption) !== compact(form.caption) || state.title !== form.title || !state.immediate || state.annotation !== '含AI生成内容' || state.location !== '不显示位置' || !state.texts.includes('不参与活动') || !state.texts.includes('选择链接') || !state.texts.includes('选择合集')) throw new Error('文案、声明或发布设置未保存，停止提交');
  return form;
}

export function matchRow(state, job) {
  const matches = state.rows.filter(r => compact(r.caption) === compact(captionFor(job.data))).flatMap(r => {
    const m = r.text.match(/(\d{4})年(\d{2})月(\d{2})日 (\d{2}):(\d{2})/);
    const timeText = m?.[0];
    const at = m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+08:00` : null;
    const expected = job.target.platform_published_at || job.target.submitted_at;
    if (!at || !Number.isFinite(Date.parse(expected)) || Math.abs(Date.parse(at) - Date.parse(expected)) > 5 * 60000) return [];
    return [{ ...r, timeText, publishedAt: at }];
  });
  if (matches.length > 1) throw new Error('出现多个相同文案和时间的作品，停止猜测');
  return matches[0] || null;
}

export async function verifyResult(browser, id, job, timeout = 60000) {
  const deadline = Date.now() + timeout;
  do {
    const state = await browser.dom(id, 'read'); guard(state);
    const row = matchRow(state, job);
    if (row) {
      const identity = { caption: row.caption, timeText: row.timeText };
      if (/审核中/.test(row.text)) return { status: 'reviewing', evidence: row.text.slice(0, 500), platform_published_at: row.publishedAt };
      if (/处理中|转码中/.test(row.text)) return { status: 'unknown', evidence: '已提交，作品仍在处理中', platform_published_at: row.publishedAt };
      await browser.dom(id, 'privacy', identity);
      const privacy = await browser.dom(id, 'read');
      const isPublic = privacy.texts.includes('设为仅自己可见');
      const isPrivate = privacy.texts.includes('设为所有人可见') || privacy.texts.includes('设为公开');
      if (privacy.texts.includes('取消')) await browser.dom(id, 'clickText', { text: '取消' });
      if (!isPublic) return { status: isPrivate ? 'blocked' : 'unknown', actual_visibility: isPrivate ? 'private' : 'unknown', evidence: '无法确认公开权限；未修改作品权限' };
      await browser.dom(id, 'preview', identity);
      let media;
      do { media = await browser.dom(id, 'read'); if (media.videos.some(v => v.ready >= 2)) break; await pause(500); } while (Date.now() < deadline);
      const valid = media.videos.some(v => v.ready >= 2 && Math.abs(v.duration - job.manifest.video.duration_seconds) < 0.5);
      await browser.dom(id, 'closePreview');
      if (!valid) throw new Error('作品预览未就绪或时长与原片不符');
      return { status: 'published', actual_visibility: 'public', platform_published_at: row.publishedAt, evidence: `作品时间 ${row.timeText}、完整文案、预览时长匹配；权限弹窗为“设为仅自己可见”，已取消。`, post_url: job.target.post_url || null };
    }
    if (state.rows.some(r => compact(r.caption) === compact(captionFor(job.data)) && /处理中|审核中/.test(r.text))) return { status: 'unknown', evidence: '匹配文案作品处理中，尚无时间用于唯一核验；不重复提交' };
    await pause(1500);
  } while (Date.now() < deadline);
  throw new Error('没有取得唯一匹配文案和发表时间的作品；保留待核实状态，不重传');
}

export async function verifyAccount(browser, id, job, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do {
    const s = await browser.dom(id, 'read'); guard(s);
    if (s.texts.includes(job.account) && s.texts.includes(job.target.account_label)) return;
    if (s.texts.some(t => /^sph[A-Za-z0-9_-]+$/.test(t) && t !== job.account)) throw new Error('当前视频号 ID 与清单不符');
    await pause(500);
  } while (Date.now() < deadline);
  throw new Error('未核验目标视频号 ID 和名称；请在 Chrome 登录视频号助手');
}

export async function submitOnce(browser, id, job, update) {
  const state = await browser.dom(id, 'read');
  if (!uploadReady(state, job)) throw new Error('上传尚未完成，不能发表');
  if (!state.texts.includes(job.target.account_label)) throw new Error('提交前账号名称发生变化');
  const { caption, title } = validatePublish(job);
  if (compact(state.caption) !== compact(caption) || state.title !== title || !state.immediate || state.annotation !== '含AI生成内容' || state.location !== '不显示位置') throw new Error('提交前表单发生变化');
  const snapshot = await browser.snapshot(id);
  const buttons = [...snapshot.matchAll(/uid=(\S+) button "发表"(?:\s|$)/g)];
  if (buttons.length !== 1) throw new Error('发表按钮不唯一');
  await update('submitting', { submitted_at: now(), evidence: '原视频、预览时长和表单均核验完成，准备单次提交' });
  await browser.call('click', { pageId: id, uid: buttons[0][1] });
}

async function readJson(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch(e) { if (e.code === 'ENOENT') return null; throw e; } }

export async function main(args = process.argv.slice(2)) {
  const o = parseArgs(args);
  if (['help', '--help'].includes(o.command)) { console.log(`微信视频号 DOM 投稿脚本\ncheck | stage | login | inspect | publish | resume | verify\n默认清单：${ROOT}/current.json\n默认通过 Chrome DevTools autoConnect 复用已登录 Chrome\n--manifest JSON --auto-connect 或 --cdp-url 本机地址\n--state-dir 目录 --page-id ID --timeout 毫秒\n详见 ../references/wechat-channels-script.md`); return; }
  const job = await loadJob(o), stateDir = resolve(o['state-dir'] || ROOT), ledgerFile = join(stateDir, 'jobs', `${job.key}.json`);
  let ledger = await readJson(ledgerFile);
  if (o.command === 'check') { emit({ decision: decision(job.target, ledger), account: job.account, video: job.video, sha256: job.hash, ...validatePublish(job) }); return; }
  if (o.command === 'stage') { emit({ staged: await stageVideo(job), note: '本地副本，尚未上传；调用方用完删除该目录' }); return; }
  if (o.command === 'publish' && decision(job.target, ledger) !== 'new') { emit({ decision: decision(job.target, ledger), note: '已有上传或提交记录，使用 resume/verify，不重传' }); return; }
  if (['publish', 'resume'].includes(o.command)) validatePublish(job);
  const release = await lock(join(stateDir, 'locks', 'browser.lock'));
  let releaseJob, browser, staged, submitting = false, touched = false;
  const update = async (status, extra = {}) => {
    if (status === 'submitting') submitting = true;
    Object.assign(job.target, extra, { status, last_verified_at: now() });
    if (['published', 'reviewing'].includes(status)) Object.assign(job.target, { error: null, next_action: null, upload_requested: false });
    job.manifest.updated_at = now();
    await atomicJson(ledgerFile, { ...job.target, sha256: job.hash }); await atomicJson(job.file, job.manifest);
    emit({ status, ...extra });
  };
  try {
    releaseJob = await lock(`${ledgerFile}.lock`); ledger = await readJson(ledgerFile);
    const d = decision(job.target, ledger);
    if (o.command === 'publish' && d !== 'new') throw new Error('状态变化，停止重复上传');
    if (o.command === 'resume' && d !== 'resume') throw new Error('resume 仅恢复尚未提交的原上传表单');
    for (const k of ['post_id', 'post_url', 'submitted_at', 'platform_published_at']) if (ledger?.[k]) job.target[k] = ledger[k];
    browser = new Browser(); await browser.connect(o);
    let pages = await browser.pages(), id;
    if (o['page-id']) { const p = pages.find(p => p.id === Number(o['page-id'])); if (!p) throw new Error('指定标签页不是视频号助手'); id = p.id; }
    else if (pages.length === 1) id = pages[0].id;
    else if (pages.length > 1) throw new Error('存在多个视频号助手标签页，请用 --page-id 指定');
    else { const result = await browser.call('new_page', { url: HOME }); id = parsePages(result).find(p => p.url === HOME)?.id; if (!id) throw new Error('未取得视频号标签页'); }
    if (o.command === 'inspect') { emit({ page_id: id, state: await browser.dom(id, 'inspect') }); return; }
    // Never navigate away from an in-flight upload. Account verification uses a
    // separate home tab for resume, then closes only that temporary tab.
    if (o.command === 'resume') {
      const original = await browser.dom(id, 'read');
      if (original.url !== CREATE || original.marker !== job.key) throw new Error('原表单身份标记缺失；不能猜测、重传或恢复另一视频');
      const before = new Set(pages.map(p => p.id));
      await browser.call('new_page', { url: HOME, background: true });
      const created = (await browser.pages()).filter(p => !before.has(p.id));
      if (created.length !== 1) throw new Error('无法建立唯一账号核验页面');
      try { await verifyAccount(browser, created[0].id, job); } finally { await browser.call('close_page', { pageId: created[0].id }); }
    } else {
      if (pages.find(p => p.id === id)?.url === CREATE) throw new Error('已有未完成发表页面，保留原表单；请用 inspect/resume 或另开首页');
      await browser.goto(id, HOME);
      await verifyAccount(browser, id, job, o.command === 'login' ? o.timeout : 15000);
    }
    emit({ account_verified: job.account, page_id: id });
    if (o.command === 'login') return;
    if (o.command === 'verify') {
      await browser.goto(id, LIST);
      const result = await verifyResult(browser, id, job, Math.min(o.timeout, 60000));
      await update(result.status, { ...result, management_url: LIST }); return;
    }
    if (o.command === 'publish') {
      await browser.goto(id, CREATE);
      let snap, input;
      const until = Date.now() + 15000;
      do { snap = await browser.snapshot(id); input = snap.match(/uid=(\S+) button "上传时长[^"\n]+"/); if (input) break; await pause(500); } while (Date.now() < until);
      if (!input) throw new Error('找不到视频上传入口');
      staged = await stageVideo(job);
      await browser.dom(id, 'mark', { key: job.key });
      await update('prepared', { upload_requested: true, upload_staging_path: staged.path, attempts: (job.target.attempts || 0) + 1, evidence: '临时副本 SHA-256、大小匹配；准备选择文件，尚未确认上传开始' }); touched = true;
      await browser.call('upload_file', { pageId: id, uid: input[1], filePaths: [staged.path] });
    } else touched = true;
    await waitUpload(browser, id, job, update, o.timeout);
    const form = await fillForm(browser, id, job);
    await update('uploaded', { description: form.caption, platform_fields: { ...job.target.platform_fields, short_title: form.title, video_annotation: '含AI生成内容', location: '不显示位置' } });
    await submitOnce(browser, id, job, update);
    const until = Date.now() + 15000;
    let s;
    do { s = await browser.dom(id, 'read'); guard(s); if (s.url === LIST) break; await pause(500); } while (Date.now() < until);
    if (s.url !== LIST) throw new Error('发表后未取得作品管理回执，不能再次点击发表');
    const result = await verifyResult(browser, id, job, Math.min(o.timeout, 60000));
    await update(result.status, { ...result, management_url: LIST });
  } catch (e) {
    if (submitting || o.command === 'verify') await update('unknown', { error: e.message, next_action: '只核验现有作品，不重传' });
    else if (touched) await update(job.target.status, { error: e.message, next_action: '保留浏览器原表单，inspect 后 resume；不重传' });
    throw e;
  } finally {
    await browser?.close().catch(() => {});
    if (staged && (!touched || submitting || job.target.status === 'uploaded')) await rm(staged.directory, { recursive: true, force: true });
    await releaseJob?.(); await release();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch(e => { emit({ error: e.message }); process.exitCode = 1; });
