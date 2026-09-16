# TikTok 投稿脚本

入口：`scripts/tiktok.mjs`，使用 Playwright 操作 Studio 的 DOM。上传、文案输入、声明、权限选择、单次发布及结果核验均写在脚本中，不依赖截图坐标或剪贴板。复用同目录 `playwright-core`，依赖缺失时运行 `npm ci`。

## 本机任务

默认清单：`/Users/weiguang/.local/share/video-publish/tiktok/current.json`。

已填入本次视频的原路径、SHA-256、109792448 字节、45.138005 秒、中文文案、账号 `lunaticsms`、原创/AI生成/无商业合作声明和 `visibility: public`。

源文件：`/Users/weiguang/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_7bojz8yro33122_c1e1/msg/video/2026-09/4b0428d0b26f8e99969deafd457e3db2_raw.mp4`。

2026-09-15 实际读取到的作品 ID：`7685696182680571143`。平台显示“内容审查中”“仅自己”，文案为文件名；清单记为 `blocked`，不能声称已公开。当前任务运行 `publish` 会提示核验已有作品，不重传。AI 标签尚未核验；`set-public` 只修复权限，不代表同时修好了文案和 AI 标签。

本机清单和账号登录数据位于仓库外；可用 `--manifest` 指定新任务。新视频用 [清单模板](../assets/publish-manifest.json) 建立新文件，仅保留一个 TikTok target，不复制旧作品 ID 或提交状态。

## 命令

在技能的 `scripts` 目录运行：

```sh
# 本地检查素材、文案和本次状态
node tiktok.mjs check

# 已有作品：只核验这条作品
node tiktok.mjs verify --cdp-url http://127.0.0.1:9222

# 查看控件以校准选择器，不上传、不提交
node tiktok.mjs inspect --cdp-url http://127.0.0.1:9222

# 已有作品：按 ID 改为所有人，刷新核验保存结果
node tiktok.mjs set-public --cdp-url http://127.0.0.1:9222 --selectors /absolute/selectors.json

# 新任务：上传、填文案/声明、设所有人、发布、核验
node tiktok.mjs publish --manifest /absolute/new-job.json --cdp-url http://127.0.0.1:9222

# 恢复仍打开的已上传表单，不再次选择文件
node tiktok.mjs resume --manifest /absolute/job.json --cdp-url http://127.0.0.1:9222
```

端口是示例，必须使用实际已启用的本机 CDP 入口。日常 Chrome 已登录不代表启用了该入口；当前会话没有可连接的 Chrome 调试端口。脚本不自动重启 Chrome，不导出或记住 token。只有用户选择独立浏览器配置时，才使用：

```sh
node tiktok.mjs login --profile main
node tiktok.mjs publish --profile main --manifest /absolute/new-job.json
```

该配置保存在 `~/.local/share/video-publish/tiktok/profiles/main`，以后复用登录；不能假装继承了日常 Chrome 的登录。

## 输入与运行行为

- 必须提供有效的 `video.path`、`size_bytes`、`duration_seconds`。上传前检查实际大小和 SHA-256；页面上传完成证据同时需要文件名、MB 大小和预览时长。
- `account_id` 为 TikTok 用户名，不带 @。从 Studio 自己显示的账号链接核对，不通过主动打开目标主页伪造账号验证。
- `mode: publish`，`visibility: public`，不定时；声明 `original: true`、`commercial: false`、`ai_generated` 为已确认布尔值。
- 中文标题、描述、标签合成一段文案，补充未出现的标签。编辑器文字与平台 `/4000` 计数必须同步，否则停止。标签不能带空格。
- 默认视频帧封面，不添加位置；自定义封面、定时和商业推广未支持，明确报错。可选自动检查引导关闭，不擅自修改全局设置。
- 设置“所有人”后读取控件真实状态；不能设置成功就不提交。AI 与商业声明开关必须提供原生 checked、aria-checked 或 data-state。
- 明确出现条款接受要求时，沿用本任务已取得的同意；`--terms-accepted` 只能代表用户实际同意，不能用来替用户接受。
- JSON 行输出实际进度；没有百分比/完成证据时只报等待。默认超时30分钟，可用 `--timeout` 传毫秒数。
- 提交前写入 `submitting`，仅点一次发布。超时或结果不明记 `unknown`，下次只能核验。
- 结果按账号、作品 ID、时长、文案及权限核验。没有已知 ID 时还要求同一行的明确提交时间在本次操作附近，不仅凭标题认定。私密或文案不符记 `blocked`；审核中且所有人记 `reviewing`，明确已发布且所有人才记 `published`。
- 状态双写清单与 `jobs/<账号-SHA256>.json`，同一账号有进程锁。清单改名不会绕过已有记录。不额外浏览历史作品查重。
- CDP 连接保留用户原标签页；失败时保留脚本上传页以便恢复。`resume` 只匹配唯一的文件名、大小、时长，不宣称能从页面验证远端文件 SHA-256。关闭的草稿不自动重建。

## DOM 校准与当前限制

`--selectors /absolute/selectors.json` 接受「键 → 已从当前 DOM 读取的 CSS 选择器」，每个操作控件须唯一。可覆盖：`account`、`upload`、`selectFiles`、`caption`、`captionCounter`、`showMore`、`ai`、`commercial`、`now`、`visibility`、`everyoneOption`、`publish`、`managePosts`、`content`、`resultRow`、`postVisibility`、`postEveryoneOption`、`privacySave`、`cancelAutoChecks`、`dismissTutorial`。

`postVisibility` 相对于指定作品行，其他操作键相对于页面。`resultRow` 必须包住且只包住一条作品的链接、时长、隐私和状态。`inspect` 只输出标签、role、ID、状态，不输出 token 或表单内容。

实站上传页已观察到“已上传（109.79MB）”、中文描述、`37 / 4000`、“现在”“所有人”“显示更多”“发布”。AI 开关及隐私菜单尚未取得可靠 DOM；作品列表的无障碍树未提供标准 row，需要校准 `resultRow`。真实列表的审查完成时间/公开状态若没有脚本可识别的标记，也需要适配，不能用缺少审核文字推断成功。遇到缺失状态立即说明具体字段，不盲点或重传。

## 验证范围

隔离合成网页测试覆盖：素材身份、中文输入同步、声明、从私密切换所有人、不可读取状态拦截、单次提交前持久化、按 ID 识别权限/文案错误、审核状态、已有作品改权限并刷新验证、恢复表单唯一性、不重复上传。

**尚未在真实 TikTok 上完成脚本端到端验证。** 实站视频由此前交互上传并已出现作品 ID；不能把隔离测试称为真实投稿成功，也不要为了测试重新发布它。
