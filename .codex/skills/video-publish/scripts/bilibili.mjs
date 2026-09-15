#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, stat, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname, join, basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';

const exec = promisify(execFile);
const UPLOAD = 'https://member.bilibili.com/platform/upload/video/frame';
const MANAGER = 'https://member.bilibili.com/platform/upload-manager/article';
const DONE = new Set(['published', 'reviewing', 'scheduled']);
const now = () => new Date().toISOString();

export function parseArgs(args) {
  const command = args.shift() || 'help';
  if (!['help', 'login', 'inspect', 'check', 'publish', 'resume', 'verify', '--help'].includes(command)) throw new Error(`未知命令：${command}`);
  const options = { command, profile: 'main' };
  const values = new Set(['manifest', 'account', 'profile', 'cover', 'selectors', 'state-dir', 'cdp-url']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (args[i] === '--terms-accepted') options.termsAccepted = true;
    else if (args[i].startsWith('--') && values.has(key) && args[i + 1] && !args[i + 1].startsWith('--')) options[key] = args[++i];
    else throw new Error(`未知参数或缺少值：${args[i]}`);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(options.profile)) throw new Error('profile 只允许字母、数字、下划线和短横线');
  if (options.account && !/^\d+$/.test(options.account)) throw new Error('account 应是 B站数字 UID');
  if (options['cdp-url']) {
    const endpoint = new URL(options['cdp-url']);
    if (!['http:', 'ws:'].includes(endpoint.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('cdp-url 须为本机 Chrome 调试地址，不接受远程地址或凭据');
  }
  return options;
}

export async function openBrowserSession(chromium, options, state) {
  if (options['cdp-url']) {
    const browser = await chromium.connectOverCDP(options['cdp-url'], { noDefaults: true, timeout: 15000 });
    let page;
    try {
      const contexts = browser.contexts();
      if (contexts.length !== 1) throw new Error('已连接浏览器的上下文不唯一，无法确定登录环境');
      const context = contexts[0];
      page = await context.newPage();
      return { context, page, close: async () => {
        try { if (!page.isClosed()) await page.close(); }
        finally { await browser.close(); } // Disconnect from CDP; never close the borrowed context.
      } };
    } catch (error) { await browser.close(); throw error; }
  }
  const profile = join(state, 'profiles', options.profile);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false, viewport: null });
  return { context, page: context.pages()[0] || await context.newPage(), close: () => context.close() };
}

export async function atomicJson(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, file);
}

export async function lock(file) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`已有任务占用：${file}。先确认旧进程已退出，不能同时投稿。`); throw error; }
  await handle.writeFile(JSON.stringify({ pid: process.pid, at: now() }));
  return async () => { await handle.close(); await unlink(file); };
}

export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function resumeDecision(target, ledger) {
  // The ledger survives copying manifests. Unreconciled activity takes priority.
  const records = [target, ledger].filter(Boolean);
  if (records.some(x => x.upload_requested || x.upload_started || ['uploading', 'uploaded', 'draft', 'submitting', 'unknown'].includes(x.status))) return 'reconcile';
  if (records.some(x => DONE.has(x.status))) return 'skip';
  return 'new';
}

export async function loadJob(options) {
  if (!options.manifest || !options.account) throw new Error('需要 --manifest 清单路径 和 --account B站UID');
  const file = resolve(options.manifest);
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  const targets = manifest.targets?.filter(x => x.platform === 'bilibili') || [];
  if (targets.length !== 1) throw new Error('清单必须且只能有一条 bilibili 目标；不自动扩大发布平台');
  const target = targets[0];
  if (target.account_id && String(target.account_id) !== options.account) throw new Error('目标 UID 与清单已有账号不一致');
  if (!manifest.video?.path) throw new Error('清单缺少 video.path');
  const video = resolve(dirname(file), manifest.video.path);
  const info = await stat(video);
  if (!info.isFile() || !info.size) throw new Error('视频不是有效非空文件');
  const hash = await sha256(video);
  if (manifest.video.sha256 && manifest.video.sha256 !== hash) throw new Error('视频内容已变化，SHA-256 与清单不符');
  const data = { ...manifest.defaults, ...Object.fromEntries(Object.entries(target).filter(([, v]) => v !== null)) };
  if (!data.title?.trim() || [...data.title].length > 80) throw new Error('标题须为 1–80 字符；不会自动截断用户文案');
  if ([...(data.description || '')].length > 2000) throw new Error('简介超过 2000 字符');
  if (!Array.isArray(data.tags) || data.tags.length > 10 || data.tags.some(x => typeof x !== 'string' || !x.trim())) throw new Error('tags 须为最多 10 个非空字符串');
  return { file, manifest, target, data, video, hash, key: `${options.account}-${hash}` };
}

export function validatePublish(job, options) {
  if (job.manifest.mode !== 'publish' || job.data.visibility !== 'public' || job.data.scheduled_at) throw new Error('当前脚本只支持立即公开投稿；草稿、定时或其他可见性仍用 skill 原流程');
  if (!options.termsAccepted) throw new Error('B站上传会接受使用协议与社区公约；取得用户当次明确同意后才传 --terms-accepted');
  const fields = job.data.platform_fields || {};
  if (fields.creation_declaration !== '含AI生成内容' || fields.original !== true || fields.commercial !== false) throw new Error('本版适配原创、无商业合作的 AI 视频；须明确 platform_fields.original=true、commercial=false、creation_declaration="含AI生成内容"');
  if (!fields.category) throw new Error('须提供 platform_fields.category，例如 手工');
}

export function validateResume(job, ledger) {
  if ([job.target, ledger].filter(Boolean).some(x => x.submitted_at || x.post_id || ['submitting', 'unknown', ...DONE].includes(x.status))) throw new Error('已有提交记录，不能以恢复表单的方式再次提交');
  if (![job.target, ledger].filter(Boolean).some(x => x.upload_started && ['uploaded', 'blocked'].includes(x.status))) throw new Error('没有可恢复的已上传记录');
}

// Override only changed controls via --selectors. Never silently choose among duplicates.
async function locate(page, overrides, key, builders, { hidden = false, optional = false, allowMany = false, timeout = 8000 } = {}) {
  const until = Date.now() + timeout;
  do {
    for (const make of overrides[key] ? [f => f.locator(overrides[key])] : builders) {
      const matches = [];
      for (const frame of page.frames()) {
        const locator = make(frame);
        for (let i = 0; i < await locator.count(); i++) {
          const item = locator.nth(i);
          if (hidden || await item.isVisible()) matches.push(item);
        }
      }
      if (matches.length > 1 && !allowMany) throw new Error(`${key} 匹配 ${matches.length} 个控件，需要更精确的 --selectors 配置`);
      if (matches.length) return matches[0];
    }
    if (Date.now() < until) await new Promise(r => setTimeout(r, 200));
  } while (Date.now() < until);
  if (optional) return null;
  throw new Error(`找不到 ${key}，可能未登录或页面已改版；运行 inspect 检查，不自动改用截图点击`);
}

const text = value => frame => frame.getByText(value, { exact: true });
const placeholder = value => frame => frame.getByPlaceholder(value, { exact: true });

export async function selectVideo(page, selectors, video) {
  // The visible upload component and an internal buploader both expose file inputs.
  // Only the component input is wired to enter the submission form.
  const input = await locate(page, selectors, 'videoInput', [
    f => f.locator('.bcc-upload-wrapper input[type="file"][accept*=".mp4"]'),
  ], { hidden: true, optional: true, timeout: 15000 });
  if (input) await input.setInputFiles(video);
  else {
    const button = await locate(page, selectors, 'uploadButton', [text('上传视频')]);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button.click()]);
    await chooser.setFiles(video);
  }
}

export async function waitForUpload(page, onProgress, { timeout = 300000, selectors = {} } = {}) {
  const until = Date.now() + timeout;
  let last = '';
  do {
    for (const frame of page.frames()) {
      const body = await frame.locator('body').innerText().catch(() => '');
      if (/(上传失败|上传出错|文件格式不支持|文件大小超出)/.test(body)) throw new Error('页面报告上传失败；请查看控件诊断和上传页面');
      const complete = selectors.uploadComplete ? frame.locator(selectors.uploadComplete) : frame.getByText('上传完成', { exact: true });
      for (let i = 0; i < await complete.count(); i++) if (await complete.nth(i).isVisible()) return;
      const progress = body.split('\n').filter(line => /上传中|上传进度|上传速度|剩余时间|\d+(?:\.\d+)?\s*(?:KB|MB)\/s/i.test(line) && !/https?:|token|cookie/i.test(line)).join(' ').slice(0, 200);
      if (progress && progress !== last) { last = progress; await onProgress(progress); }
    }
    await new Promise(r => setTimeout(r, 500));
  } while (Date.now() < until);
  throw new Error(last ? `上传等待超时；最后页面进度：${last}` : '未取得网页上传进度或完成提示，不能确认文件开始传输');
}

export async function fillForm(page, job, selectors, cover) {
  const title = await locate(page, selectors, 'title', [placeholder('请输入稿件标题')]);
  await title.fill(job.data.title);
  const description = await locate(page, selectors, 'description', [
    f => f.getByRole('textbox', { name: '填写更全面的相关信息，让更多的人能找到你的视频吧', exact: true }),
    f => f.locator('[contenteditable="true"][data-placeholder*="填写更全面"]'),
    f => f.locator('[contenteditable="true"]:visible'),
  ]);
  await description.fill(job.data.description || '');
  const declaration = await locate(page, selectors, 'declaration', [placeholder('请选择符合您视频内容的创作声明')]);
  await declaration.click();
  await (await locate(page, selectors, 'aiDeclaration', [text('含AI生成内容')])).click();
  await title.click();
  if (await declaration.inputValue() !== '含AI生成内容') throw new Error('AI 声明未成功写入');

  // Read the selected category from the actual form control, not unrelated recommended tags.
  const category = job.data.platform_fields.category;
  const categoryControl = await locate(page, selectors, 'category', [
    f => f.locator('input[placeholder*="分区"]'),
    f => f.locator('.select-item-cont:visible'),
  ], { optional: true, timeout: 500 });
  if (!categoryControl) throw new Error('分区控件尚未定位；请用 inspect 校准 category 选择器，不能凭推荐标签推断分区');
  const categoryValue = await categoryControl.evaluate(el => el.value || el.innerText || '');
  if (categoryValue.trim() !== category) {
    await categoryControl.click();
    await (await locate(page, selectors, 'categoryOption', [text(category)])).click();
    const selected = await categoryControl.evaluate(el => el.value || el.innerText || '');
    if (selected.trim() !== category) throw new Error('分区选择未生效');
  }

  const tags = await locate(page, selectors, 'tags', [placeholder('按回车键Enter创建标签')]);
  await tags.fill('');
  for (let i = 0; i < 10; i++) await tags.press('Backspace');
  for (const tag of [...new Set(job.data.tags)]) { await tags.fill(tag); await tags.press('Enter'); }

  const coverInput = await locate(page, selectors, 'coverInput', [
    f => f.locator('.cover-upload input[type="file"][accept*="image"]'),
    f => f.locator('input[type="file"][accept*="image"]'),
    f => f.locator('input[type="file"][accept*=".jpg"]'),
  ], { hidden: true, optional: true, timeout: 1000 });
  if (coverInput) await coverInput.setInputFiles(cover);
  else {
    const addCover = await locate(page, selectors, 'addCover', [text('添加封面'), text('封面设置')]);
    await addCover.click();
    await (await locate(page, selectors, 'coverInput', [f => f.locator('.cover-upload input[type="file"][accept*="image"]'), f => f.locator('input[type="file"][accept*="image"]')], { hidden: true })).setInputFiles(cover);
  }
  const confirmCover = await locate(page, selectors, 'confirmCover', [
    text('完成'),
    f => f.getByRole('button', { name: '完成', exact: true }),
    f => f.getByRole('button', { name: '确定', exact: true }),
  ], { optional: true, timeout: 1500 });
  if (confirmCover) await confirmCover.click();
  await locate(page, selectors, 'coverReady', [text('封面设置')]);
  if (await title.inputValue() !== job.data.title) throw new Error('标题校验失败');
  const actualDescription = await description.evaluate(el => el.value ?? el.innerText);
  if (actualDescription.trim() !== (job.data.description || '').trim()) throw new Error('简介校验失败');

  const commercial = await locate(page, selectors, 'commercial', [
    f => f.locator('label.bcc-checkbox:visible').filter({ hasText: /^\s*增加商业推广信息\s*$/ }).locator('input[type="checkbox"]'),
    f => f.getByRole('checkbox', { name: '增加商业推广信息', exact: true }),
  ], { hidden: true });
  await commercial.setChecked(false);
  // Some releases use a native checkbox, others a switch. Require observable state.
  const schedule = await locate(page, selectors, 'schedule', [
    f => f.getByRole('switch', { name: '定时发布', exact: true }),
    f => f.getByRole('checkbox', { name: '定时发布', exact: true }),
    f => f.getByRole('heading', { name: '定时发布', exact: true }).locator('..').locator('[role="switch"],input[type="checkbox"]'),
    f => f.locator('.time-container .switch-container:visible'),
  ]);
  const nativeSchedule = await schedule.evaluate(el => el.matches('input[type="checkbox"],[role="switch"],[role="checkbox"]'));
  if (nativeSchedule) await schedule.setChecked(false);
  else if (await schedule.evaluate(el => el.className.trim()) !== 'switch-container') throw new Error('定时开关不是已校准的关闭状态，停止提交');
  if (await commercial.isChecked() || (nativeSchedule && await schedule.isChecked())) throw new Error('商业推广或定时发布未关闭');
}

async function makeCover(job, options, artifacts) {
  const provided = options.cover || job.data.cover_path;
  if (provided) {
    const file = resolve(dirname(job.file), provided);
    if (!(await stat(file)).isFile()) throw new Error('封面文件不存在');
    return file;
  }
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', job.video]);
  const duration = Number(JSON.parse(stdout).format.duration);
  if (!(duration > 0)) throw new Error('无法读取视频时长以提取封面');
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  const file = join(artifacts, 'cover.jpg');
  await exec('ffmpeg', ['-v', 'error', '-y', '-ss', String(duration * 0.8), '-i', job.video, '-frames:v', '1', '-q:v', '2', file]);
  return file;
}

async function account(context, expected) {
  const page = await context.newPage();
  try {
    await page.goto('https://space.bilibili.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/^https:\/\/space\.bilibili\.com\/\d+(?:[/?#]|$)/, { timeout: 15000 });
    const uid = new URL(page.url()).pathname.split('/')[1];
    if (expected && uid !== expected) throw new Error(`当前登录 UID ${uid} 与目标 ${expected} 不一致，停止上传`);
    return uid;
  } catch (error) { throw new Error(`账号核对失败，请先运行 login。${error.message}`); }
  finally { await page.close(); }
}

async function inspect(page) {
  const frames = [];
  for (const frame of page.frames()) {
    frames.push({ url: frame.url().split('?')[0], controls: await frame.locator('input,textarea,button,select,[contenteditable="true"],[role="button"]').evaluateAll(nodes => nodes.map(el => ({
      tag: el.tagName, type: el.getAttribute('type'), id: el.id, name: el.getAttribute('name'), class: el.className,
      placeholder: el.getAttribute('placeholder'), accept: el.getAttribute('accept'),
      label: el.getAttribute('aria-label'), text: el.matches('button,[role="button"]') ? el.innerText?.slice(0, 100) : undefined,
    }))) });
  }
  return frames;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const publishing = ['publish', 'resume'].includes(options.command);
  if (['help', '--help'].includes(options.command)) {
    console.log('B站 DOM 发布脚本\n命令：login | inspect | check | publish | resume | verify\n参数：--profile 名称（默认 main） --cdp-url 本机现有浏览器地址 --account UID --manifest JSON路径 --cover 图片路径 --selectors JSON路径 --state-dir 运行目录 --terms-accepted\n登录状态保存在 profile 中；只在未登录或登录过期时运行 login。publish 上传投稿；resume 恢复已上传未提交表单。详见 ../references/bilibili-script.md');
    return;
  }
  const state = resolve(options['state-dir'] || join(homedir(), '.local/share/video-publish/bilibili'));
  const job = ['check', 'publish', 'resume', 'verify'].includes(options.command) ? await loadJob(options) : null;
  const ledgerFile = job && join(state, 'jobs', `${job.key}.json`);
  let ledger;
  try { if (ledgerFile) ledger = JSON.parse(await readFile(ledgerFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const decision = job && resumeDecision(job.target, ledger);
  if (options.command === 'check') {
    if (decision === 'new') validatePublish(job, options);
    console.log(JSON.stringify({ platform: 'bilibili', decision, account: options.account, title: job.data.title, sha256: job.hash, status: ledger?.status || job.target.status }, null, 2));
    return;
  }
  if (options.command === 'publish' && decision !== 'new') {
    console.log(JSON.stringify({ decision, reason: decision === 'skip' ? '已有成功/审核/排期记录，不重发' : '已有上传或提交记录，须先核对现有稿件，不自动重传', post_id: ledger?.post_id || job.target.post_id }));
    if (decision === 'reconcile') process.exitCode = 2;
    return;
  }
  if (publishing) validatePublish(job, options);
  if (options.command === 'resume') validateResume(job, ledger);
  const unlock = await lock(join(state, 'locks', `${options['cdp-url'] ? 'cdp' : options.profile}.lock`));
  let unlockJob, context, page, browserSession;
  let uploadRequested = false, uploadStarted = false, submitting = false, mayUpdate = false;
  if (options.command === 'resume') { uploadRequested = true; uploadStarted = true; }
  const update = async (status, extra = {}) => {
    Object.assign(job.target, { status, account_id: options.account, upload_requested: uploadRequested && !DONE.has(status), upload_started: uploadStarted && !DONE.has(status), last_verified_at: now(), ...extra });
    job.manifest.updated_at = now(); job.manifest.video.sha256 = job.hash;
    // Ledger first: a failed manifest write must not lose protection against a second upload.
    await atomicJson(ledgerFile, { ...job.target, sha256: job.hash });
    await atomicJson(job.file, job.manifest);
  };
  try {
    if (job) {
      unlockJob = await lock(`${ledgerFile}.lock`);
      try { ledger = JSON.parse(await readFile(ledgerFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (options.command === 'publish' && resumeDecision(job.target, ledger) !== 'new') throw new Error('另一任务已处理此视频，停止重复上传');
      if (options.command === 'resume') validateResume(job, ledger);
      mayUpdate = true;
    }
    const { chromium } = await import('playwright-core');
    browserSession = await openBrowserSession(chromium, options, state);
    ({ context, page } = browserSession);
    console.log(JSON.stringify({ browser_mode: options['cdp-url'] ? 'existing_browser' : 'persistent_profile', profile: options.profile }));
    page.setDefaultTimeout(12000);
    const selectors = options.selectors ? JSON.parse(await readFile(resolve(options.selectors), 'utf8')) : {};
    if (options.command === 'login') {
      await page.goto(UPLOAD);
      console.log('请在脚本打开的 B站页面中登录。登录完成后回到终端按回车；登录状态由浏览器保留，不读取或打印凭据。');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { await rl.question(''); } finally { rl.close(); }
      console.log(JSON.stringify({ logged_in_uid: await account(context, options.account), profile: options.profile }));
      return;
    }
    const uid = await account(context, options.account);
    console.log(JSON.stringify({ account_verified: uid }));
    if (options.command === 'verify') {
      const id = ledger?.post_id || job.target.post_id;
      await page.goto(id && /^BV[0-9A-Za-z]+$/.test(id) ? `https://member.bilibili.com/platform/upload-manager/archive-process?bvid=${id}` : MANAGER);
      console.log(JSON.stringify({ post_id: id || null, management_url: page.url(), note: '只读取状态，不重新提交', text: (await page.locator('body').innerText()).slice(0, 10000) }));
      return;
    }
    await page.goto(UPLOAD, { waitUntil: 'domcontentloaded' });
    if (options.command === 'inspect') { console.log(JSON.stringify(await inspect(page), null, 2)); return; }
    const cover = await makeCover(job, options, join(state, 'artifacts', job.key));
    if (options.command === 'resume') {
      const restore = await locate(page, selectors, 'restore', [text('继续编辑')], { timeout: 30000 });
      const body = await page.locator('body').innerText();
      if (!/本地浏览器存在1个未提交的视频/.test(body)) throw new Error('本地未提交视频数量不唯一，停止恢复');
      await restore.click();
      const restoredTitle = await locate(page, selectors, 'title', [placeholder('请输入稿件标题')]);
      if (await restoredTitle.inputValue() !== job.data.title) throw new Error('恢复的稿件标题与清单不一致');
      await locate(page, selectors, 'restoredFile', [text(basename(job.video, extname(job.video)))]);
      await locate(page, selectors, 'uploadComplete', [text('上传完成')], { allowMany: true });
      uploadRequested = true;
      uploadStarted = true;
    } else {
    uploadRequested = true;
    await update('prepared', { error: null, cover, evidence: '准备选择文件，尚未确认网页上传进度' });
    await selectVideo(page, selectors, job.video);
    console.log(JSON.stringify({ file_selected: true, note: '已选择文件，等待网页确认上传状态' }));
    await waitForUpload(page, async progress => {
      uploadStarted = true;
      await update('uploading', { evidence: `页面进度：${progress}` });
      console.log(JSON.stringify({ upload_progress: progress }));
    }, { selectors });
    uploadStarted = true;
    }
    await update('uploaded');
    console.log(JSON.stringify({ status: 'uploaded', evidence: '页面显示上传完成' }));
    await fillForm(page, job, selectors, cover);
    const submit = await locate(page, selectors, 'submit', [text('立即投稿')]);
    console.log(JSON.stringify({ submitting: { account: uid, title: job.data.title, cover, declaration: '含AI生成内容' } }));
    submitting = true;
    await update('submitting', { submitted_at: now() });
    await submit.click();
    await locate(page, selectors, 'receipt', [text('恭喜你上传第一个稿件，成为UP主~'), text('投稿成功'), text('查看进度')], { timeout: 30000 });
    await update('reviewing', { evidence: '投稿后页面显示成功回执', error: null });
    const progress = await locate(page, selectors, 'progress', [text('查看进度')]);
    await progress.click();
    await page.waitForURL(url => /^BV[0-9A-Za-z]+$/.test(url.searchParams.get('bvid') || ''), { timeout: 15000 });
    const id = new URL(page.url()).searchParams.get('bvid');
    await update('reviewing', { post_id: id, management_url: page.url(), next_action: '等待平台审核；使用 verify 查看进度' });
    console.log(JSON.stringify({ status: 'reviewing', bvid: id, management_url: page.url(), manifest: job.file }, null, 2));
  } catch (error) {
    if (page && job) {
      try {
        const diagnostic = join(state, 'artifacts', job.key, 'controls.json');
        await atomicJson(diagnostic, await inspect(page));
        console.error(`控件诊断（无截图、无输入框值）：${diagnostic}`);
      } catch { /* Diagnostics must not replace the original error or lose the ledger. */ }
    }
    if (job && mayUpdate && publishing) {
      const status = DONE.has(job.target.status) ? job.target.status : submitting ? 'unknown' : 'blocked';
      await update(status, { error: error.message, next_action: uploadRequested ? '核对本次上传状态，不能直接重发' : '补齐信息或校准选择器后继续' });
    }
    throw error;
  } finally {
    try { await browserSession?.close(); }
    finally { try { await unlockJob?.(); } finally { await unlock(); } }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
