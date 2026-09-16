# B站脚本

入口：`scripts/bilibili.mjs`。直接使用 Playwright 操作网页元素，不调用模型、OCR 或截图识别，不使用非公开投稿 API。

## 执行入口

支持范围内的上传发布必须实际调用本脚本，不能用 CUA、无障碍控件逐步点击或截图识别替代。读取本说明和脚本源码不等于执行脚本。

1. 准备清单，复用会话中已确认的内容声明、账号和发布授权。
2. 检查依赖是否已安装；缺失时执行 `npm ci`。默认复用 `main` 配置，不要每次先运行 `login`；只有核验未登录或登录失效时才请用户登录。用户提供现有浏览器的本机 CDP 地址时通过 `--cdp-url` 连接。
3. 参数及所需授权齐全后运行 `publish`；已上传且未提交的本地表单使用 `resume` 继续，不重传文件。根据脚本回执更新清单，需要核验本次提交结果时使用 `verify`。
4. 运行失败时报告实际命令、失败阶段及错误，处理对应依赖、登录或选择器问题。没有运行过 `publish` 就明确说尚未执行投稿脚本；不要直接改用浏览器工具完成上传提交。

浏览器 DOM 工具仅用于必要的选择器校准。用户指定浏览器投稿或请求本脚本不支持的类型时，按 SKILL.md 的通用流程处理并说明原因。

## 当前支持和验证范围

- 本版实现**原创、无商业合作的 AI 视频，立即公开投稿**。其他声明、草稿和定时仍走 SKILL.md 的平台流程。
- 上传、标题、简介、标签、AI 声明、封面、提交回执与 BV 号按本次 B站页面流程实现。
- 2026-09-15 已用真实账号验证脚本上传、恢复表单、提交和读取 BV 回执（`BV11oen6WEEJ`，投稿回执为审核中）。本次经过选择器修正及 `resume` 恢复完成；尚不代表所有投稿类型或一次运行不中断的流程均已验证。
- 失败后没有自动截图兜底或自动重传。上传后中断需要先检查稿件管理、草稿与当前记录，再决定恢复方式。

## 安装和登录

在此 skill 的 `scripts` 目录执行：

```sh
npm ci
node bilibili.mjs login --profile main --account 23424850
```

`--account` 是目标 B站数字 UID，示例为本次已核验账号；其他账号须替换。浏览器打开后由用户登录，然后回终端按回车核验 UID。

默认使用已安装的 Google Chrome 和**独立的持久化配置目录**。`--profile` 默认为 `main`，本次已有登录保存在该配置；新开窗口不等于登录信息丢失。后续直接运行投稿命令，只有登录过期才运行 `login`。其他旧配置用 `--profile <原名称>` 明确指定，不复制 Cookie 或 token。

默认运行数据位于 `~/.local/share/video-publish/bilibili/`，包含 `profiles/`、`jobs/`、`artifacts/` 和 `locks/`。不提交这些目录，不复制或导出登录凭据。`--state-dir` 可指定其他运行目录，建议放在 Git 仓库外。

### 连接已经打开的浏览器

用户的浏览器已经提供本机 CDP 调试入口时，可直接连接，复用该浏览器的登录状态；仍由本脚本操作投稿：

```sh
node bilibili.mjs publish --cdp-url http://127.0.0.1:9222 --manifest /absolute/job.json --account 23424850 --terms-accepted
```

地址是示例，必须使用实际已启用的本机入口。连接模式不启动新的浏览器，只新建任务页面；结束时关闭任务页面并断开连接，保留原浏览器、原页面和登录状态。连接失败就报告错误，不默默启动另一浏览器。该连接生命周期已通过独立测试；本次真实 B站投稿使用的是持久化配置模式。

普通 Chrome 未启用调试入口时不能直接连接。不要为了连接而擅自重启用户浏览器、改动默认配置或导出凭据。Chrome 对默认用户数据目录的调试有限制，不能简单把 `userDataDir` 指向日常浏览器目录。参考 [Playwright CDP 连接](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp) 与 [Chrome 调试入口说明](https://developer.chrome.com/blog/remote-debugging-port)。

## 准备清单

沿用 [publish-manifest.json](../assets/publish-manifest.json) 模板，移除 `target_template`，仅将目标实例放入 `targets`。视频路径及封面路径可为绝对路径，也可相对清单所在目录。B站目标需包含：

```json
{
  "platform": "bilibili",
  "account_id": "23424850",
  "title": "45秒，在海边搭一间温暖小屋",
  "description": "从地基、墙架到弧形屋顶，一间海边微缩小屋慢慢成形。",
  "tags": ["微缩建筑", "海边小屋", "治愈系"],
  "visibility": "public",
  "scheduled_at": null,
  "status": "prepared",
  "platform_fields": {
    "category": "手工",
    "creation_declaration": "含AI生成内容",
    "original": true,
    "commercial": false
  }
}
```

清单顶层 `mode` 为 `publish`，`video.path` 为源视频。原创/AI/商业字段依据当前素材及已确认事实填写，不能凭模板或默认同意偏好推断。

封面优先使用 `--cover`，其次 `defaults.cover_path` 或目标的 `cover_path`。均未提供时用本地 `ffmpeg` 从视频 80% 位置提取一帧，保存到运行目录，不覆盖或重编码源视频。需要本机已安装 `ffmpeg` 和 `ffprobe`。执行前应查看该帧是否适合作封面，不合适则传入另一个已有封面。

## 检查和发布

```sh
# 只检查文件、参数和已有记录，不打开浏览器，不上传。
node bilibili.mjs check --manifest /absolute/job.json --account 23424850 --terms-accepted

# 用户已要求发布；普通上传协议按主技能的持续授权处理后执行。
node bilibili.mjs publish --profile main --manifest /absolute/job.json --account 23424850 --terms-accepted

# 恢复同一浏览器配置内已上传、未提交的单个视频表单，不再次上传文件。
node bilibili.mjs resume --profile main --manifest /absolute/job.json --account 23424850 --terms-accepted

# 只打开对应稿件进度页并读取文字，不重发。
node bilibili.mjs verify --profile main --manifest /absolute/job.json --account 23424850
```

`--terms-accepted` 可依据主技能中用户已给出的持续授权传入，清单记录授权来源；普通上传协议不逐次询问。涉及本次发布之外的付费或其他操作不包含在此授权中。`publish` 是实际上传及投稿命令，不能把它作为检查命令运行。

成功状态先记录为 `reviewing`，返回 BV 号与管理页；不把投稿成功夸大为公开审核通过。`verify` 输出页面实际文字供代理判断，不自动推断审核结果。

`file_selected` 只表示已选择文件。只有网页出现上传进度时才记录 `uploading` 并输出 `upload_progress`；网页明确显示“上传完成”后记录 `uploaded`。`upload_requested` 用于保存已尝试选择文件的恢复状态，不证明文件已传输。

`resume` 要求清单或本地记录显示已上传，且不存在提交时间、作品 ID 或提交结果不明状态。它仅恢复页面明确显示的一个未提交视频，并核对标题、文件名和上传完成提示；不匹配就停止，不自动重新上传。

## 页面改版与首次校准

```sh
node bilibili.mjs inspect --profile main --account 23424850
node bilibili.mjs publish --profile main --manifest /absolute/job.json --account 23424850 --terms-accepted --selectors /absolute/selectors.json
```

`inspect` 读取上传入口的表单 DOM 属性，不上传、不打印输入框值或 Cookie。上传后的专属字段需要在已存在的投稿表单上另外用浏览器 DOM 工具检查，不能为了校准重复上传同一稿件。

覆盖文件为「字段名 → CSS 选择器」对象；必须从实际 DOM 取得，不能把示例当成已验证值。可覆盖字段：`videoInput`、`uploadButton`、`uploadComplete`、`restore`、`restoredFile`、`title`、`description`、`declaration`、`aiDeclaration`、`category`、`categoryOption`、`tags`、`coverInput`、`addCover`、`confirmCover`、`coverReady`、`commercial`、`schedule`、`submit`、`receipt`、`progress`。选择器会在页面及 iframe 中查找，只有唯一匹配才执行操作；只读的上传完成提示允许多个匹配。商业复选框从可见标签定位内部 input；定时开关支持原生状态及本次已校准的关闭类名，未知状态停止提交。

运行出错会把控件属性写到 `artifacts/<UID-SHA256>/controls.json`，方便修正选择器；文件不包含输入框值、Cookie 或截图。

## 重复保护与失败处理

- 用户要求跳过重复上传检查时，不额外打开稿件管理查重；本节的本地状态保护仍由脚本执行。保护触发时报告实际阻塞，不擅自清空记录，也不转到浏览器绕过。
- 文件 SHA-256 和账号 UID 组成记录键；更换清单文件名也不能绕过同一运行目录的重复保护。
- 清单或本地记录已有 `reviewing`、`scheduled`、`published` 时跳过。若任一记录显示尚未核对的上传/提交，则优先要求核对。
- `upload_requested=true`、`uploading`、`uploaded`、`submitting`、`unknown` 或 `upload_started=true` 时不自动重传。已上传未提交的表单优先使用 `resume`；提交超时记 `unknown`，不能用 `resume` 再次提交。成功回执已确认后再读 BV 号失败，仍保留 `reviewing`。
- 上传后、提交前失败会关闭脚本专用浏览器；不能保证网站保存草稿。需查看稿件/草稿管理，确认不存在稿件且用户要求重试后，才人工修正清单和同键 `jobs/*.json` 的状态及 `upload_started` 标志。不提供自动强制重发开关。
- 同一浏览器配置和同一视频账号组合各有进程锁。异常退出遗留锁时，核对文件中的 PID 已退出后再删除锁，不能在运行中删锁。
- 本次已投稿的 `BV1g2en6wEsu` 应保留原清单中的 `reviewing` 状态，只能校验或查看进度，不能为测试再发一遍。
