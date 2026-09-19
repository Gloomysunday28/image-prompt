# 本机生产路径与声音复现

这些是当前机器已有的组件路径，使用前检查存在。技能里的样本、人物图与声音配置已独立保存，不依赖旧输出目录维持声音身份。

遵守主技能的两次确认顺序：想法获批后，以下配音工具仅用于本期15秒正文试听；试听获批后才可运行全片配音、口型与剪辑。组件可用不代表用户已批准进入后续阶段。

## 固定配音

优先用技能脚本，输入UTF-8正文文本，输出WAV与元数据：

```bash
python3 <skill-dir>/scripts/synthesize_voice.py --text-file <正文.txt> --output <配音.wav>
```

脚本读取固定声音参数，默认正常语速 `+0%`，不降低语速；不能传另一个voice。支持 `--check` 检查组件、素材校验值及配置；`--ffmpeg /绝对路径/ffmpeg` 可更换可执行文件路径，不更换声音。已生成的本声线MP3可用 `--raw-mp3` 加 `--events-json` 重新处理，避免重复网络请求；不能把其他声音的MP3当作本声线输入。

已有 Edge TTS 包目录：
`/Users/caijiadi/image-prompt/outputs/tang-taizong-20260918/work/edge_tts_pkg`

已有 FFmpeg：
`/Users/caijiadi/image-prompt/tools/sadtalker-bin/ffmpeg`

脚本先尝试当前Python环境的edge_tts，再尝试上述本机路径。若不可用，配置隔离环境中的对应依赖；不能改用另一声音。保留原始MP3、WordBoundary事件与处理后的WAV。词边界减去裁切偏移后才可用于字幕，字幕拼接偏移必须来自实际音频长度。

处理沿用批准成片：24kHz单声道，60Hz高通，目标-18LUFS、峰值-2dBTP，末尾40毫秒短淡出。淡出只能落在末字后的区域；自动阈值不能代替结尾抽听。

## 首尾口型

本地可用的 SadTalker 环境：

- Python：`/Users/caijiadi/image-prompt/tools/sadtalker-env/bin/python`
- 兼容入口：`/Users/caijiadi/image-prompt/tools/run_sadtalker_local.py`
- 模型目录：`/Users/caijiadi/image-prompt/tools/SadTalker`

用技能 `assets/narrator.png`，以及已完成配音中头、尾各自的真实片段生成；口型输入可临时转16kHz，但成片音轨沿用原母版。

```bash
/Users/caijiadi/image-prompt/tools/sadtalker-env/bin/python \
  /Users/caijiadi/image-prompt/tools/run_sadtalker_local.py \
  --source_image <skill-dir>/assets/narrator.png \
  --driven_audio <头段或尾段.wav> \
  --result_dir <本段输出目录> \
  --preprocess full --still --batch_size 1 --size 256
```

该环境有针对本机MPS的兼容处理，不要绕过入口直接运行上游 inference.py。生成较慢，应留进度记录，完成后检查再交付。不要为省等待用静止头像冒充已生成的口型视频。

## 剪辑与验证

- 数字人标题遵循主技能“数字人画面的醒目标题”：保留原始右侧数字人近景，后期在左侧留白叠加分行大标题，按规定的字号与配色渲染，并检查实际成片原尺寸及宽480px预览。旧项目标题位置、字号、颜色不可直接沿用。若通过ASS指定颜色，注意它使用BGR顺序，先转换主技能中的RGB色值，并从合成结果核对颜色。
- 使用音频母版累计时长计算镜头、字幕与章节时间；25fps视频用累计时间四舍五入到帧，避免每段取整导致累计漂移。
- 最终映射画面流与原始配音母版，丢弃所有场景视频和数字人视频自带音轨。
- 本机FFmpeg可用 `h264_videotoolbox`、`libass` 与中文字体 `/System/Library/Fonts/Hiragino Sans GB.ttc`。能力应以实际环境为准。
- 完整解码检查：`ffmpeg -v error -i <成片.mp4> -map 0:v:0 -map 0:a:0 -f null -`。记录退出码、错误输出、时长、尺寸及抽检结果。

旧项目 `/Users/caijiadi/image-prompt/outputs/李世民一生-正式成片/work` 可参考时间线、字幕和音视频拼接实现，但旧 `produce_avatar.py` 含中段数字人，旧 `render.py` 存在整章长时间用同图的逻辑。不能直接复制它们作为本技能的新视频模板；按当前首尾数字人和逐句场景要求重新编排。
