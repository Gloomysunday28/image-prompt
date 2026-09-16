# 微信视频号投稿脚本

入口：`scripts/wechat-channels.mjs`。把已跑通的视频号助手流程写为可重复执行的 DOM 自动化：本地检查、临时副本、上传进度、中文描述与短标题、AI 标注、不定时发表、单次提交、内容管理核验。

## 环境与连接

在技能 `scripts` 目录运行 `npm ci`，使用 Node.js 22.12+。依赖固定版本的 `chrome-devtools-mcp` 和 MCP SDK，与其他渠道共用 `package.json`。

默认使用 Chrome DevTools `autoConnect` 连接已经允许远程调试、已登录视频号助手的日常 Chrome；首次连接若 Chrome 显示授权提示，由用户完成。支持 `--cdp-url http://127.0.0.1:<实际端口>` 或本机 WebSocket 入口。不会自动重启 Chrome、创建独立登录配置或导出 Cookie/token；也不关闭用户浏览器。

存在多个视频号标签页时，错误会提示指定 `--page-id`；ID 从当前连接的 `list_pages` 获取。只操作目标账号，首页核对视频号 ID 与名称。已有发表页不被新建投稿覆盖；恢复需要原表单身份标记。

## 命令

```sh
# 默认读取本机 current.json；本地检查，不上传
node wechat-channels.mjs check

# 只核验已有作品
node wechat-channels.mjs verify

# 从当前视频号页面读取 DOM 控件；不上传、不提交
node wechat-channels.mjs inspect

# 等待用户在 Chrome 自行登录，随后核对账号
node wechat-channels.mjs login

# 新视频：上传、填表、标注、发表及核验
node wechat-channels.mjs publish --manifest /absolute/new-job.json

# 上传中断：恢复仍打开且由脚本标记过的原表单，不重新选文件
node wechat-channels.mjs resume --manifest /absolute/job.json

# 仅生成工具允许读取的临时副本，返回绝对路径与校验值
node wechat-channels.mjs stage --manifest /absolute/job.json
```

所有命令可指定 `--manifest`。浏览器命令默认 `--auto-connect`，与 `--cdp-url` 二选一。`--state-dir` 指定本地记录目录，默认 `~/.local/share/video-publish/wechat_channels/`；`--timeout` 为毫秒，上传默认 30 分钟。使用同一 state-dir 保留查重记录；不要通过改目录来重发已有作品。

## 清单与范围

从 [清单模板](../assets/publish-manifest.json) 创建本次清单，目标仅保留一个 `platform: wechat_channels`。填写：

- `authorization.user_instruction`：用户的本次发布指令。
- `video.path`：用户明确指定的原文件；`sha256`、`size_bytes`、`duration_seconds` 必须来自真实检测。
- `account_id`：首页显示的 `sph...` 视频号 ID；`account_label`：视频号名称。
- `mode: publish`、`visibility: public`，不填写定时时间。
- `description`、`tags`、`title`。短标题可用 `platform_fields.short_title` 覆盖，短标题不自动重复到描述中；标签补充时去重，最终文案写入清单。
- `platform_fields.ai_generated: true`：用户或任务上下文已确认包含 AI 内容。脚本填写“含AI生成内容”，不自动声称原创或真实拍摄。

当前支持默认封面、不显示位置、不定时、无关联商品/链接/合集/活动。其他可见性、非 AI 标注、商业合作、转载、自定义封面和平台草稿尚不支持，脚本明确报错，不悄悄忽略设置。

## 上传路径与恢复

上传工具的允许目录包含系统 `os.tmpdir()`，在 macOS 通常为 `/var/folders/.../T`。微信沙盒文件路径、仓库路径和字面 `/tmp` 不一定在允许范围内。脚本创建随机临时目录，将原文件按原名复制进去，再核对大小和 SHA-256。视频内容不变，不转码、不压缩、不关闭工具路径限制。

`stage` 只创建本地文件，调用方使用完后删除返回的临时目录。`publish` 在上传完成后清理自身临时副本；上传仍在进行或超时时保留副本及路径，供原浏览器继续读取。运行记录、账号信息和临时素材留在仓库外。

页面出现百分比或“正在处理文件”才记录对应进度。视频预览可播放且时长与清单一致后，才允许填写并提交。已选择文件不等于已上传。

选择文件前写入 `upload_requested`，页面保存任务身份标记，避免进程中断后新建重复稿件。`resume` 只接受仍打开、未刷新且身份标记匹配的原表单；用独立首页标签核验账号后恢复，不能从已关闭的草稿推断源文件。上传未完成的临时副本保留在 `upload_staging_path`。

提交前双写 `submitting` 到清单及 `jobs/<视频号ID-SHA256>.json`，仅点击一次发表；本地进程锁防止并发操作。提交后异常记 `unknown`，只能核验，不能再次点发表。

## 结果与本次已发布作品

进入内容管理后，按完整文案和发表时间匹配唯一作品，再打开“可见权限”并取消对话框：“设为仅自己可见”表示目前公开。随后打开预览核对可播放与时长；不修改作品权限。管理列表时间按中国标准时间解析。仅标题相似、作品数量增加、缺少审核文字均不足以独立认定成功。

“处理中”记 `unknown` 并说明提交已发生；审核中记 `reviewing`。缺少唯一时间/文案证据或权限/预览无法核验时保留待核实状态。脚本不反复刷新、重传或自动修复旧作品。

本次默认清单位于 `~/.local/share/video-publish/wechat_channels/current.json`，保留原视频 `e29b1fba1441989aec9a7b14afe52ebf_raw.mp4`、账号 `IAmFineThankS3595`、标题“在溪边搭一座微缩小屋”和已发布状态；时间为 2026-09-16 14:57（北京时间）。再次 `publish` 会输出 `skip`，不会上传。新视频另建清单，不复制作品结果。

未从网页取得作品 ID 或公开链接时如实留空，返回真实[内容管理页](https://channels.weixin.qq.com/platform/post/list)，不拼接作品链接、不读取凭据。页面控件变化时运行 `inspect` 并依据当前 DOM 修正脚本。

## 验证范围

`node --test wechat-channels.test.mjs` 在隔离网页中验证：临时副本保持原字节、源文件变更拦截、声明及范围校验、Shadow DOM 中文输入、上传处理门槛、单次提交前写入状态、真实账号 ID 校验、发表时间与文案的唯一匹配、权限/预览核验、本地记录防重复。

2026-09-16 已实际运行新脚本 `verify`，成功核验本次作品为公开。完整上传和发表此前由浏览器工具完成；**没有用新脚本重新发布这条视频，也尚未完成新脚本的真实上传端到端验证。**
