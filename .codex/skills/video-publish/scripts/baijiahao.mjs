#!/usr/bin/env node
import { readFile, stat, mkdtemp, copyFile, chmod, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicJson, sha256, lock } from './bilibili.mjs';
import { Browser as DevToolsBrowser, parseArgs, decision } from './wechat-channels.mjs';
export { parseArgs, decision };

const ROOT = join(homedir(), '.local/share/video-publish/baijiahao');
export const ACCOUNT = 'https://baijiahao.baidu.com/builder/rc/settings/accountSet';
export const CREATE = 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2&is_from_cms=1';
export const LIST = 'https://baijiahao.baidu.com/builder/rc/content';
const now = () => new Date().toISOString();
const pause = ms => new Promise(r => setTimeout(r, ms));
const emit = value => console.log(JSON.stringify({ platform: 'baijiahao', ...value }));
const compact = s => String(s || '').trim().replace(/\s+/g, ' ');

export async function loadJob(o) {
  const file = resolve(o.manifest || join(ROOT, 'current.json'));
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  const targets = manifest.targets?.filter(t => t.platform === 'baijiahao') || [];
  if (targets.length !== 1) throw new Error('清单须且仅有一个 baijiahao 目标');
  const target = targets[0], account = String(target.account_id || '');
  if (!/^\d{10,}$/.test(account) || !target.account_label?.trim()) throw new Error('缺少百家号 ID 或名称；从账号信息页核对');
  if (!manifest.video?.path || !/^[a-f0-9]{64}$/.test(manifest.video.sha256 || '')) throw new Error('缺少原文件路径或 SHA-256');
  const video = resolve(dirname(file), manifest.video.path), hash = manifest.video.sha256;
  if (['check', 'stage', 'publish', 'resume'].includes(o.command)) {
    const st = await stat(video);
    if (!st.isFile() || !st.size || st.size !== manifest.video.size_bytes || await sha256(video) !== hash) throw new Error('源文件大小或 SHA-256 与清单不符');
  }
  const data = { ...manifest.defaults, ...Object.fromEntries(Object.entries(target).filter(([, v]) => v !== null)) };
  return { file, manifest, target, account, data, video, hash, key: `${account}-${hash}` };
}
export function validatePublish(job) {
  const d = job.data, f = d.platform_fields || {};
  if (job.manifest.mode !== 'publish' || d.visibility !== 'public' || d.scheduled_at) throw new Error('当前脚本只支持立即公开投稿');
  if (!job.manifest.authorization?.user_instruction?.trim()) throw new Error('缺少用户发布指令');
  if (!(job.manifest.video.size_bytes > 0) || !(job.manifest.video.duration_seconds > 0)) throw new Error('缺少素材大小或时长');
  if (f.ai_generated !== true) throw new Error('须确认 platform_fields.ai_generated=true');
  if (f.commercial === true || f.original === false || d.cover_path || (d.cover && !['平台默认封面', '平台自动生成的横版与竖版封面'].includes(d.cover)) || f.activity || f.location || f.mount || f.watermark) throw new Error('当前仅支持默认封面、无商业合作/转载/挂载/地点/活动/自定义水印');
  if (d.tags?.length) throw new Error('话题选择尚未适配；tags 应为空，不将普通文字伪装成已添加话题');
  const caption = f.caption ?? d.description ?? d.title;
  if (typeof caption !== 'string' || !caption.trim() || /[\r\n]/.test(caption)) throw new Error('缺少有效的单段作品描述');
  // Conservative upper bound; the page's counter remains authoritative.
  if ([...caption.trim()].length > 50) throw new Error('作品描述超过脚本支持的 50 字符，请先明确缩短文案');
  return { caption: caption.trim() };
}
export async function stageVideo(job) {
  const directory = await mkdtemp(join(tmpdir(), 'video-publish-baijiahao-'));
  const path = join(directory, basename(job.video));
  try {
    await copyFile(job.video, path); await chmod(path, 0o600);
    const st = await stat(path);
    if (st.size !== job.manifest.video.size_bytes || await sha256(path) !== job.hash) throw new Error('临时副本大小或 SHA-256 不符');
    return { directory, path, sha256: job.hash, size_bytes: st.size };
  } catch (e) { await rm(directory, { recursive: true, force: true }); throw e; }
}
export function parsePages(text) {
  return text.split('\n').flatMap(line => {
    const m = line.match(/^(\d+): .*?(https:\/\/baijiahao\.baidu\.com\/[^\s)]*)/);
    return m ? [{ id: Number(m[1]), url: m[2] }] : [];
  });
}
export class Browser extends DevToolsBrowser {
  async pages() { return parsePages(await this.call('list_pages')); }
  async dom(id, op, args = {}) {
    const text = await this.call('evaluate_script', { pageId: id, function: `() => (${pageDOM.toString()})(${JSON.stringify({ op, ...args })})`, waitForStableDom: op !== 'read' });
    const result = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (!result) throw new Error('DOM 结果无法解析');
    const value = JSON.parse(result[1]); if (value?.error) throw new Error(value.error); return value;
  }
}

// Serialized into the browser; rendered DOM only, no application stores or tokens.
export function pageDOM(a) {
  const norm = s => String(s || '').trim().replace(/\s+/g, ' ');
  const visible = e => !!(e.getBoundingClientRect().width && e.getBoundingClientRect().height) && getComputedStyle(e).visibility !== 'hidden';
  const all = selector => [...document.querySelectorAll(selector)].filter(visible);
  const one = selector => { const es = all(selector); if (es.length !== 1) throw new Error(`控件不唯一：${selector}`); return es[0]; };
  const leaves = all('body *').filter(e => !e.children.length && !e.matches('script,style'));
  const exact = (text, scope = document) => {
    const es = [...scope.querySelectorAll('*')].filter(e => visible(e) && !e.children.length && norm(e.innerText) === text);
    if (es.length !== 1) throw new Error(`文字控件不唯一：${text}`); return es[0];
  };
  try {
    if (a.op === 'mark') { document.documentElement.dataset.baijiahaoPublishJob = a.key; return true; }
    if (a.op === 'fill') {
      const editor = one('[contenteditable="true"][role="textbox"]'); editor.focus();
      const range = document.createRange(); range.selectNodeContents(editor);
      const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      if (!document.execCommand('insertText', false, a.caption)) throw new Error('作品描述输入失败');
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: a.caption })); editor.blur(); return true;
    }
    if (a.op === 'openDeclaration') { one('input[placeholder="请选择创作声明"]').click(); return true; }
    if (a.op === 'selectAI') {
      const dialog = one('[role="dialog"]'); const label = exact('含AI生成内容', dialog);
      const radio = label.closest('label')?.querySelector('input[type=radio]') || label.parentElement.querySelector('input[type=radio]');
      if (!radio) throw new Error('找不到含AI生成内容对应单选框');
      if (!radio.checked) radio.click();
      if (!radio.checked) throw new Error('AI 声明未选中'); return true;
    }
    if (a.op === 'confirmDeclaration') { exact('确定', one('[role="dialog"]')).click(); return true; }
    const text = document.body.innerText;
    const editor = all('[contenteditable="true"][role="textbox"]')[0];
    const leafTexts = leaves.map(e => norm(e.innerText)).filter(Boolean);
    const countText = text.match(/(?:^|\n)\s*(\d+)\s*\/\s*(\d+)\s*(?:\n|$)/);
    const links = [...document.querySelectorAll('a[href]')];
    const rows = all('.article-info').map(e => {
      const link = e.querySelector('.title a[href]');
      let post_id = null;
      if (link) { try { post_id = new URL(link.href).searchParams.get('id'); } catch {} }
      return { caption: norm(link?.innerText), text: e.innerText, time: norm(e.querySelector('.time')?.innerText), post_id, preview_url: link?.href || null };
    });
    const buttons = all('button').map(e => ({ text: norm(e.innerText), disabled: e.disabled }));
    const captcha = /百度安全验证|请完成下方验证|拖动左侧滑块|扫码验证/.test(text);
    const accountId = text.match(/百家号ID[：:]\s*(\d+)/)?.[1] || null;
    const receipt = links.find(e => norm(e.innerText) === '查看发布状态');
    const covers = all('[data-testid="cover-preview"] img').map(e => ({ ready: e.complete && e.naturalWidth > 0 }));
    const state = { url: location.href, text, leafTexts, accountId, marker: document.documentElement.dataset.baijiahaoPublishJob || null,
      caption: norm(editor?.innerText), counter: countText ? { value: Number(countText[1]), max: Number(countText[2]) } : null,
      annotation: all('input[placeholder="请选择创作声明"]')[0]?.value || '', covers, buttons, rows, captcha,
      receipt: /提交成功，正在审核中/.test(text), management_url: receipt?.href || null,
      previewCopies: editor ? leaves.filter(e => norm(e.innerText) === norm(editor.innerText) && !editor.contains(e)).length : 0 };
    if (a.op === 'inspect') return { ...state, inputs: all('input,textarea,[contenteditable]').map(e => ({ tag: e.tagName, type: e.type, placeholder: e.getAttribute('placeholder'), role: e.getAttribute('role') })) };
    return state;
  } catch(e) { return { error: e.message }; }
}
export function guard(state) {
  if (state.captcha) throw new Error('需要用户手动完成百度安全验证；保留页面，不重传');
  if (/passport\.baidu\.com/.test(state.url) || /扫码登录|账号密码登录/.test(state.text)) throw new Error('需要用户在 Chrome 登录百家号');
}
export async function verifyAccount(browser, id, job, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do {
    const s = await browser.dom(id, 'read'); guard(s);
    if (s.accountId) {
      if (s.accountId !== job.account || !s.leafTexts.includes(job.target.account_label)) throw new Error('百家号 ID 或名称与清单不符');
      return;
    }
    await pause(500);
  } while (Date.now() < deadline);
  throw new Error('无法从账号信息页核验百家号 ID 和名称');
}
export function uploadReady(s, job) {
  guard(s);
  return s.marker === job.key && !!s.caption && /更换/.test(s.text) &&
    !/上传失败|转码失败|正在上传|上传中|处理中|转码中/.test(s.text) &&
    ![...s.text.matchAll(/(\d+(?:\.\d+)?)%/g)].some(m => Number(m[1]) < 100) &&
    s.covers.length >= 2 && s.covers.every(c => c.ready) &&
    s.buttons.some(b => b.text === '发布' && !b.disabled);
}
export async function waitUpload(browser, id, job, update, timeout) {
  const deadline = Date.now() + timeout; let beat = 0;
  do {
    const s = await browser.dom(id, 'read'); guard(s);
    if (/上传失败|转码失败/.test(s.text)) throw new Error('平台报告上传或转码失败；保留原表单检查');
    if (uploadReady(s, job)) { await update('uploaded', { evidence: '同一表单显示更换、横竖版封面已加载、发布按钮可用，无未完成进度' }); return; }
    const progress = s.text.match(/\d+(?:\.\d+)?%/)?.[0];
    if (Date.now() - beat > 10000) { if (progress) await update('uploading', { evidence: progress }); else emit({ event: 'waiting_for_upload' }); beat = Date.now(); }
    await pause(1500);
  } while (Date.now() < deadline);
  throw new Error('上传处理超时，保留临时副本及原表单，用 resume 恢复');
}
export function assertForm(s, job) {
  const { caption } = validatePublish(job);
  if (!uploadReady(s, job)) throw new Error('上传处理尚未完成');
  if (!s.leafTexts.includes('@' + job.target.account_label)) throw new Error('提交前账号名称不符');
  if (s.caption !== compact(caption) || s.previewCopies < 1 || !s.counter || s.counter.value <= 0 || s.counter.value > s.counter.max || s.annotation !== '含AI生成内容') throw new Error('描述、预览、计数或 AI 声明未保存');
}
export async function fillForm(browser, id, job) {
  const form = validatePublish(job); await browser.dom(id, 'fill', form);
  if ((await browser.dom(id, 'read')).annotation !== '含AI生成内容') {
    await browser.dom(id, 'openDeclaration'); await browser.dom(id, 'selectAI'); await browser.dom(id, 'confirmDeclaration');
  }
  assertForm(await browser.dom(id, 'read'), job); return form;
}
export async function submitOnce(browser, id, job, update) {
  if (decision(job.target) === 'verify' || decision(job.target) === 'skip') throw new Error('已有提交记录，只能核验，不能再次发布');
  assertForm(await browser.dom(id, 'read'), job);
  const buttons = [...(await browser.snapshot(id)).matchAll(/uid=(\S+) button "发布"(?:\s|$)/g)];
  if (buttons.length !== 1) throw new Error('发布按钮不唯一');
  await update('submitting', { submitted_at: now(), next_action: '等待回执；出现验证码时用户手动完成，不重复点击' });
  await browser.call('click', { pageId: id, uid: buttons[0][1] });
}
export function matchRow(state, job) {
  const expectedCaption = compact(job.target.description || job.data.description || job.data.title);
  const matches = state.rows.filter(r => {
    if (job.target.post_id) return r.post_id === String(job.target.post_id);
    const at = Date.parse(r.time.replace(' ', 'T') + '+08:00'), expected = Date.parse(job.target.submitted_at);
    return r.caption === expectedCaption && Number.isFinite(at) && Number.isFinite(expected) && Math.abs(at - expected) < 30 * 60000;
  });
  if (matches.length > 1) throw new Error('匹配到多个作品，不能猜测');
  const row = matches[0];
  if (row && row.caption !== expectedCaption) throw new Error('作品 ID 对应文案与清单不符');
  return row || null;
}
export function rowResult(row) {
  const status = /审核中/.test(row.text) ? 'reviewing' : /未通过|审核不通过|已撤回/.test(row.text) ? 'failed' : 'unknown';
  return { status, post_id: row.post_id, preview_url: row.preview_url, post_url: null,
    platform_published_at: row.time, evidence: row.text.slice(0,700),
    next_action: status === 'unknown' ? '作品管理有记录，但尚未确认公开访问；不重传' : null };
}
export async function verifyResult(browser, id, job, timeout = 30000) {
  const deadline = Date.now() + timeout;
  do {
    const s = await browser.dom(id, 'read'); guard(s); const row = matchRow(s, job);
    if (row) return rowResult(row);
    await pause(1000);
  } while (Date.now() < deadline);
  throw new Error('作品管理未找到唯一 ID 或文案与提交时间匹配的作品；不要重传');
}
export async function waitReceipt(browser, id, job, update, timeout) {
  const deadline = Date.now() + timeout; let waiting = false;
  do {
    const s = await browser.dom(id, 'read');
    if (s.captcha) {
      if (!waiting) { await update('blocked', { verification_required: true, error: '请在 Chrome 手动完成百度安全验证', next_action: '验证后脚本自动继续；若脚本已退出，使用 resume 或 verify，不重复发布' }); waiting = true; }
    } else {
      guard(s);
      if (s.receipt && s.management_url) {
        const url = new URL(s.management_url);
        if (url.origin !== 'https://baijiahao.baidu.com' || url.pathname !== '/builder/rc/content' || url.searchParams.get('app_id') !== job.account) throw new Error('回执账号或管理页不符');
        await update('reviewing', { management_url: s.management_url, verification_required: false, error: null, evidence: '提交成功，正在审核中' });
        await browser.goto(id, s.management_url); return;
      }
      if (new URL(s.url).pathname === '/builder/rc/content') return;
    }
    await pause(1000);
  } while (Date.now() < deadline);
  if (waiting) { await update('blocked', { verification_required: true, next_action: '在原页面完成验证后运行 resume 或 verify；不再次发布' }); return false; }
  throw new Error('提交后未取得回执；只核验，不重复点击发布');
}
async function readJson(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch(e) { if (e.code === 'ENOENT') return null; throw e; } }

export async function main(args = process.argv.slice(2)) {
  const o = parseArgs(args);
  if (['help','--help'].includes(o.command)) { console.log(`百家号 DOM 投稿脚本\ncheck | stage | login | inspect | publish | resume | verify\n默认清单 ${ROOT}/current.json\n--manifest JSON --auto-connect 或 --cdp-url 本机地址\n--state-dir 目录 --page-id ID --timeout 毫秒\n详见 ../references/baijiahao-script.md`); return; }
  const job = await loadJob(o), stateDir = resolve(o['state-dir'] || ROOT), ledgerFile = join(stateDir, 'jobs', `${job.key}.json`);
  let ledger = await readJson(ledgerFile);
  if (o.command === 'check') { emit({ decision: decision(job.target, ledger), account: job.account, sha256: job.hash, ...validatePublish(job) }); return; }
  if (o.command === 'stage') { emit({ staged: await stageVideo(job), note: '仅本地副本；调用方用完清理' }); return; }
  if (o.command === 'publish' && decision(job.target, ledger) !== 'new') { emit({ decision: decision(job.target, ledger), note: '已有记录，不重复上传' }); return; }
  if (['publish','resume'].includes(o.command)) validatePublish(job);
  const release = await lock(join(stateDir, 'locks', 'browser.lock'));
  let releaseJob, browser, staged, touched = false, submitted = false, uploaded = false;
  const update = async (status, extra = {}) => {
    if (status === 'submitting') submitted = true;
    Object.assign(job.target, extra, { status, last_verified_at: now() });
    job.manifest.updated_at = now();
    await atomicJson(ledgerFile, { ...job.target, sha256: job.hash }); await atomicJson(job.file, job.manifest);
    emit({ status, ...extra });
  };
  try {
    releaseJob = await lock(`${ledgerFile}.lock`); ledger = await readJson(ledgerFile);
    const d = decision(job.target, ledger);
    if (o.command === 'publish' && d !== 'new') throw new Error('状态变化，停止重复上传');
    for (const key of ['post_id','submitted_at','description','verification_required','upload_staging_path']) if (ledger?.[key] != null) job.target[key] = ledger[key];
    browser = new Browser(); await browser.connect(o);
    let pages = await browser.pages(), id;
    if (o['page-id']) { id = pages.find(p => p.id === Number(o['page-id']))?.id; if (!id) throw new Error('指定标签页不是百家号'); }
    else if (pages.length === 1) id = pages[0].id;
    else if (pages.length > 1) throw new Error('存在多个百家号标签页，用 --page-id 指定');
    else { await browser.call('new_page', { url: ACCOUNT }); id = (await browser.pages())[0]?.id; }
    if (!id) throw new Error('没有可用百家号标签页');
    if (o.command === 'inspect') { emit({ page_id: id, state: await browser.dom(id, 'inspect') }); return; }
    // Verify the real account from rendered settings, never from a URL supplied by us.
    // Use a separate tab so an upload or captcha page stays intact.
    const before = new Set((await browser.pages()).map(p => p.id));
    await browser.call('new_page', { url: ACCOUNT, background: true });
    const added = (await browser.pages()).filter(p => !before.has(p.id));
    if (added.length !== 1) throw new Error('无法建立唯一账号核验页');
    try { await verifyAccount(browser, added[0].id, job, o.command === 'login' ? o.timeout : 15000); }
    finally { await browser.call('close_page', { pageId: added[0].id }); }
    emit({ account_verified: job.account, page_id: id });
    if (o.command === 'login') return;
    if (o.command === 'verify' || (o.command === 'resume' && ['verify','skip'].includes(d))) {
      submitted = !!job.target.submitted_at;
      const state = await browser.dom(id, 'read');
      if (state.captcha || state.receipt) { if (await waitReceipt(browser,id,job,update,o.timeout) === false) return; }
      else if (new URL(state.url).pathname === '/builder/rc/edit') {
        // Do not destroy the original form while reconciling an uncertain submit.
        const old = new Set((await browser.pages()).map(p => p.id)); await browser.call('new_page', { url: LIST });
        id = (await browser.pages()).find(p => !old.has(p.id))?.id; if (!id) throw new Error('无法打开作品管理');
      } else await browser.goto(id, LIST);
      const result = await verifyResult(browser,id,job,Math.min(o.timeout,30000));
      await update(result.status, { ...result, management_url: LIST, error: null, verification_required: false }); return;
    }
    if (o.command === 'resume' && d !== 'resume') throw new Error('没有可恢复的上传记录');
    if (o.command === 'publish') {
      const current = await browser.dom(id, 'read');
      if (new URL(current.url).pathname === '/builder/rc/edit' && (current.caption || current.marker)) throw new Error('已有编辑表单，不覆盖；使用新标签页或 resume');
      await browser.goto(id, CREATE);
      let input; const until = Date.now()+15000;
      do { input = (await browser.snapshot(id)).match(/uid=(\S+) button "上传视频"/); if(input) break; await pause(500); } while(Date.now()<until);
      if (!input) throw new Error('找不到上传视频入口');
      staged = await stageVideo(job); await browser.dom(id,'mark',{ key:job.key });
      job.manifest.video.upload_path = staged.path;
      await update('prepared', { upload_requested:true, upload_staging_path:staged.path, attempts:(job.target.attempts||0)+1, evidence:'临时副本已校验，尚未确认上传开始' }); touched = true;
      await browser.call('upload_file',{ pageId:id,uid:input[1],filePaths:[staged.path] });
    } else {
      const state = await browser.dom(id,'read');
      if (state.marker !== job.key || new URL(state.url).searchParams.get('type') !== 'videoV2') throw new Error('原上传表单身份不符或已刷新，不能猜测源文件'); touched=true;
    }
    await waitUpload(browser,id,job,update,o.timeout); uploaded=true;
    const form = await fillForm(browser,id,job);
    await update('uploaded',{ description:form.caption,cover:'平台默认封面',platform_fields:{...job.target.platform_fields,ai_generated:true,creation_statement:'含AI生成内容'} });
    await submitOnce(browser,id,job,update);
    if (await waitReceipt(browser,id,job,update,o.timeout) === false) return;
    const result=await verifyResult(browser,id,job,Math.min(o.timeout,30000));
    await update(result.status,{...result,management_url:LIST,error:null,verification_required:false});
  } catch(e) {
    if (submitted) await update('unknown',{error:e.message,next_action:'核验现有作品，不重复提交'});
    else if (o.command==='verify') await update(job.target.status,{verification_error:e.message,next_action:'浏览器可连接后重试 verify；保留上次已核验状态，不重传'});
    else if(touched) await update(job.target.status,{error:e.message,next_action:'保留原表单，inspect 后 resume，不重传'});
    throw e;
  } finally {
    await browser?.close().catch(()=>{});
    if(staged && (!touched || uploaded)) await rm(staged.directory,{recursive:true,force:true});
    await releaseJob?.(); await release();
  }
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) main().catch(e=>{emit({error:e.message});process.exitCode=1;});
