# YouTube 投稿脚本

入口：`scripts/youtube.mjs`。Playwright 直接操作 Studio 页面元素；不使用 OCR、截图坐标或非公开上传 API。复用同目录现有 `playwright-core` 依赖（缺失时 `npm ci`）。

## 本次已放入的路径与记录

脚本默认读取本机运行配置：

`/Users/weiguang/.local/share/video-publish/youtube/current.json`

配置包括：

- 源视频：`/Users/weiguang/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_7bojz8yro33122_c1e1/msg/video/2026-09/4b0428d0b26f8e99969deafd457e3db2_raw.mp4`
- 频道：`Martin`，`UCpeGGzzzAdiUpaItWhzLalA`。
- 标题：`45秒，在海边搭一间温暖小屋`，以及已使用的中文简介、AI 生成、无商业合作和非儿童专属声明。
- 已发布视频：`https://youtu.be/DoLS91cY0P4`。
- 管理页：`https://studio.youtube.com/video/DoLS91cY0P4/edit`。
- `status: published`：运行 `publish` 会跳过，不会把这条视频再传一次。

运行清单、状态及浏览器配置放在仓库外，不自动加入 Git。脚本可在其他机器通过 `--manifest /absolute/job.json` 指定其他清单，不硬编码本次素材为所有任务的默认内容。

## 命令

在 `scripts` 目录运行：

```sh
# 仅检查本地素材和记录，不打开浏览器
node youtube.mjs check

# 复用已启用 CDP 的浏览器，只核验本次已发布视频
node youtube.mjs verify --cdp-url http://127.0.0.1:9222

# 读取当前视频管理页控件属性，供校准选择器；不上传
node youtube.mjs inspect --cdp-url http://127.0.0.1:9222

# 新任务：清单须包含已获授权的素材、字段和声明
node youtube.mjs publish --manifest /absolute/new-job.json --cdp-url http://127.0.0.1:9222

# 恢复同一浏览器中仍打开的原上传向导，不选择新文件
node youtube.mjs resume --manifest /absolute/job.json --cdp-url http://127.0.0.1:9222
```

CDP 地址只是示例，必须替换成实际已启用的本机入口。未指定 CDP 或 profile 时，涉及网页的命令会说明原因并退出，不静默开启新浏览器。普通 Chrome 没有调试入口时，Playwright 不能直接连接。参见 [Playwright CDP 文档](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)。不擅自重启用户浏览器或把日常 Chrome 目录交给另一个进程。

用户明确选择独立持久化配置时：

```sh
node youtube.mjs login --profile main
node youtube.mjs publish --profile main --manifest /absolute/new-job.json
```

仅首次或登录失效时 `login`；用户自行完成登录，脚本核验频道后保留浏览器登录数据。YouTube profile 位于 `~/.local/share/video-publish/youtube/profiles/main`，不代表已有日常 Chrome 的登录已经转入。Cookie/token 不输出、不复制、不写入技能或记忆。

## 清单与支持范围

使用 [清单模板](../assets/publish-manifest.json) 建立新任务，只保留一条 YouTube target。需要：

- 顶层 `mode: publish`，`video.path`、`video.sha256`（首次 `check` 可现场计算）。
- `account_id`：明确的 UC 频道 ID；不按频道显示名猜测。可用 `--account` 校验，但不能覆盖不一致的已有账号。
- `title`（最多 100 字符）、`description`（最多 5000 字符）、`tags`（总长度最多 500 字符）。保持用户要求的语言。
- `visibility: public`、`scheduled_at: null`、`status: prepared`。
- `platform_fields.original: true`、`commercial: false`，`altered_content` 与 `made_for_kids` 都须为已经确认的布尔值。
- `authorization.terms_accepted: true` 或 `--terms-accepted` 可依据主技能中用户已给出的持续授权设置，清单记录来源，不要求用户逐次确认。新任务使用当前发布请求和持续授权，不复制旧视频的事实声明与发布结果。

支持平台默认截帧封面、立即公开、原始视频文件。定时、商业推广、自定义封面和关闭后重新打开的草稿尚不支持；遇到这些设置明确报错，不默默忽略。AI 标签选择按 `altered_content`，不把所有视频都标成 AI。

## 固定执行流程

1. 校验文件 SHA-256、清单、频道 ID、本地状态和进程锁。额外浏览历史稿件查重不是脚本步骤。
2. 打开 Studio，从页面的频道 dashboard 链接核对当前登录频道；不强制跳到目标频道 URL 后假装验证成功。
3. `Upload videos` → `Select files` → Playwright 文件选择器直接传入源文件绝对路径。避开原生文件窗口与剪贴板输入问题。
4. 尽早保存页面生成的视频 ID；该 ID 或文件选择不证明正在传输。出现进度才报上传中，出现原文件名、ID 和处理/上传完成提示才进入已上传阶段。
5. 直接填中文标题、简介、标签；核验文本，再选择儿童受众、无付费推广、AI 使用声明。
6. `Video elements` → `Checks`：等明确检查结果。`No issues found` 放行；`doesn’t affect the video right now` 记录版权声明后放行。只出现 `Claimed content found` 不足以判定安全，限制或未知结果不会自动忽略。
7. `Visibility` → `Public`，关闭 instant Premiere，持久化 `submitting` 后单次点击 `Publish`。
8. 读取 `Video published` 回执，再打开本视频管理页核对频道、标题、源文件名和保存后的 `Public`；回执或标题本身不足以记为已公开。

默认最长等上传/检查各 30 分钟，可用 `--timeout` 设置毫秒数。事件按 JSON 行输出，无后台定时任务。`check`、`inspect`、选文件和看到视频 ID 都不应汇报为发布成功。

## 恢复和诊断

- 本地 `jobs/<频道-SHA256>.json` 优先保存状态，清单更名不会绕过同一状态目录的保护。已公开/排期跳过；`submitting` 或 `unknown` 只能先 `verify`，不自动再次提交。
- `resume` 需要未提交的现有 ID、CDP、唯一匹配 ID 和源文件名的原上传向导。重新切回 Details 后继续；找不到原向导则停止，不创建新上传。已关闭草稿需读取管理页后另行适配，不能宣称脚本支持恢复。
- CDP 下上传失败会保留任务页面并断开连接，便于下一次恢复。已有其他页面和浏览器始终保留；成功时关闭脚本新建的任务页。独立 profile 退出时关闭窗口，登录仍保留，但不能保证未完成向导保留。
- `verify` 仅按本次 ID 读取管理页，不查全频道重复项、不编辑。核验公开才更新为 `published`；仍私密时报告 `draft`，不会清掉先前结果不明的保护。
- 页面语言/布局变化：`inspect` 输出控件 role、标签和 ID，不输出输入值或凭据。通过 `--selectors /absolute/selectors.json` 传「字段名 → 已从 DOM 校准的 CSS 选择器」。每个操作控件必须唯一。
- 可覆盖：`upload`、`selectFiles`、`title`、`description`、`audience`、`showMore`、`commercial`、`ai`、`tags`、`next`、`public`、`premiere`、`publish`、`receipt`、`publicStatus`、`privateStatus`。步骤标题和版权文字当前按英文 Studio 实现；非英文页面应校准代码，不能只更换一个选择器就宣称全部适配。

## 已验证范围

测试使用隔离的合成网页，覆盖中文输入和声明、完整向导、版权条件、单次提交、按 ID 核验、无进度不误报、已发布不重传、频道和源文件校验、CDP 断开保留页面。

本视频此前由浏览器工具发布成功；新脚本尚未在真实 YouTube 上完整运行上传发布。不要为验证脚本重发该视频，也不要把合成网页测试称为真实平台投稿成功。
