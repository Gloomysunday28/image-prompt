# 百家号投稿脚本

入口：`scripts/baijiahao.mjs`。复用其他渠道的 MCP 连接、参数解析、原子写入和锁机制，使用当前页面 DOM 完成账号核验、上传、文案替换、AI 声明、单次提交、验证码等待及作品管理核验。

## 连接与命令

在技能 `scripts` 目录使用现有 Node.js 22.12+ 和 `npm ci` 安装的依赖。默认 `--auto-connect` 连接已开启远程调试的 Chrome；支持 `--cdp-url` 本机 HTTP/WebSocket 地址，不自动开启调试、重启浏览器、复制登录凭据或关闭用户浏览器。工具能操作浏览器不代表独立进程可以 autoConnect；出现 `DevToolsActivePort` 缺失时如实说明连接不可用，不反复重试或宣称已经发布。

```sh
node baijiahao.mjs check
node baijiahao.mjs inspect --page-id 34
node baijiahao.mjs stage --manifest /absolute/job.json
node baijiahao.mjs login --manifest /absolute/job.json
node baijiahao.mjs publish --manifest /absolute/new-job.json --page-id 34
node baijiahao.mjs resume --manifest /absolute/job.json --page-id 34
node baijiahao.mjs verify --manifest /absolute/job.json --page-id 34
```

`page-id` 必须来自当前脚本连接的 `list_pages`，示例数字不是固定 ID；存在多个百家号标签页时要求显式指定。全部命令支持 `--manifest`；默认清单为 `~/.local/share/video-publish/baijiahao/current.json`。`--state-dir` 默认同目录，用于持久化去重记录与锁。`--timeout` 默认 1800000 毫秒，控制上传或验证码等待；作品管理核验最多 30 秒。

`check` 只检查源文件、清单和查重决策。`stage` 只创建本地副本，返回目录，调用方负责清理。`inspect` 读取当前 DOM，不上传。`login` 等待用户自行登录后核对账号。

## 清单字段

一份清单仅一个 `platform: baijiahao` 目标，沿用 [清单模板](../assets/publish-manifest.json)。

- `authorization.user_instruction` 保存本次用户指令；`video.path` 为指定原文件，SHA-256、大小和时长必须真实。
- `account_id` 为账号信息页显示的百家号 ID，使用字符串；`account_label` 为账号名称。核验使用可见页面，不以 URL 参数作为身份证据。
- 目前仅支持 `mode: publish`、`visibility: public`，不填 `scheduled_at`。
- `platform_fields.ai_generated: true` 表示素材含 AI 内容已经确认。商业合作、转载、自定义封面、挂载、地点、活动、水印设置暂不支持。
- “作品描述”使用 `platform_fields.caption`，其次 `description`，再其次 `title`。仅支持单段、最多 50 字符，不自动截断；同时核验平台计数。`tags` 留空，目前不自动选择话题。实际写入的描述会回写清单。
- 使用平台自动生成的横竖版封面。富文本先选中全部默认文件名再替换，核对预览、计数与编辑器一致；在创作声明弹窗选择“含AI生成内容”，确定后核验表单真实值。

## 临时目录与恢复

网站选择文件必须使用 `os.tmpdir()` 返回的真实系统临时目录。macOS 的微信沙盒路径、仓库路径、字面 `/tmp` 都可能被工具拒绝；本次成功目录是 `/var/folders/.../T/`。脚本按原文件名复制，验证大小和 SHA-256，不转码、不修改原片。上传完成后清理本次副本；仍在上传或超时时保留路径，不中断浏览器读取。清单保留原始 `video.path`，另记 `video.upload_path` 和目标的 `upload_staging_path`。

选择文件前持久化 `upload_requested` 并在原表单写入账号 ID + SHA-256 标记。`resume` 只恢复未刷新且标记一致的原表单，不重选文件。页面显示“更换”、两个封面加载完成、发布按钮可用且无未完成进度/处理状态才继续；选择文件成功本身不表示上传完成。

提交前把 `submitting` 与时间写入清单和持久化去重记录，然后只点击一次发布。出现百度安全验证时输出 `blocked` 和人工操作提示，保留页面等待；脚本不解验证码、不再次点击发布。用户验证后可能自动提交，脚本从回执继续。等待超时退出后，用 `resume` 等待/核验原提交，或 `verify` 查作品管理；已提交身份始终保留。

`published`、`reviewing`、`scheduled` 记录阻止新上传；`submitting`、`unknown`、已有作品 ID 或提交时间只允许核验。更换清单名称不能绕过同一账号+SHA-256 去重。`verify` 连接失败会保留先前已核验状态并单独记录 `verification_error`。

## 结果与验证边界

回执必须明确“提交成功，正在审核中”，且链接中的账号与清单一致。作品管理优先按作品 ID 匹配并核对文案；无 ID 时需完整文案和提交时间唯一匹配。审核中记 `reviewing`，未通过/撤回记 `failed`；其他状态保持 `unknown`，当前尚未实现公开访问核验，不把管理预览页当公开链接。`preview_url`、`post_id` 均来自实际页面。

本次默认清单已保留账号 `dadas16`、百家号 ID `1876470897107369`、作品 ID `1876471463795444347` 和浏览器核验的审核中结果；新视频创建新清单，不复制旧作品结果。

`node --test baijiahao.test.mjs` 使用本地隔离页面验证临时副本校验、原文件变化拦截、范围校验、富文本覆盖、账号 ID、提交前持久化、验证码等待/恢复、唯一作品匹配和去重。完整真实投稿由浏览器工具完成；新脚本的 autoConnect 核验尝试因缺少 DevToolsActivePort 未连接成功，**尚未实测新脚本完整上传投稿**。不为测试重复发布已提交视频。
