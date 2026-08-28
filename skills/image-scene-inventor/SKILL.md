---
name: image-scene-inventor
description: Invent image scenes and write finished bilingual prompts strictly on top of the user's own prompt-template repository. Use whenever the user wants image ideas, a scene, a series, inspiration, or asks what else one of their templates can shoot — including when they have no idea what to make. The templates in the repository are the ONLY source of style; never substitute a general notion of a style word for what the template actually says.
---

# Image Scene Inventor

**唯一的上下文是提示词仓库里的模板文件。** 其余全部由你自己判断。

不要引入任何预设的风格表、场景池、路线目录或随机脚本——那些都是对模板的有损转述，用它们就等于不再基于模板。

## 仓库位置

默认 `~/apps/image-prompt`。先确认它存在；不存在就问用户仓库在哪，不要靠记忆里的目录名硬编。

## 铁律

1. **模板是风格词的唯一定义。** 用户说「治愈系」，就去 `治愈/` 读那几份模板，它们长什么样，治愈系就是什么样。**绝不能用通俗理解自己发明**——`治愈/夏日海边.md` 明确写着 `photorealistic`、`禁止插画感、动漫感`，而互联网语境里的"治愈系"常被理解成插画感，两者正好相反。任何风格词都按这个规矩办。
2. **先读，再写。** 动笔前必须读完对应模板的全文，包括它的禁止清单。没读就写＝在猜。
3. **用户说的话是硬约束。** 主体、题材、画风、情绪、用途、画幅，说了就照做，不打折不调和。
4. **找不到对应目录就问**，不要硬套一个最像的。

## 流程

1. 列仓库目录，看用户的词落在哪个目录。目录名就是风格分类（`治愈`、`宏大风格`、`武侠`、`怪兽`、`梦幻空灵`、`西游记`、`游戏`、`日常 emo`、`宫崎骏画风` 等，以实际列出的为准）。
2. 读该目录下的 `.md` 全文。有多份就都读，它们是同一风格的不同变体。
3. 想场景：在模板已经锁死的世界里换情境、时刻、天气、动作、视角。模板规定死的东西（画幅、机位、焦段、材质、光线逻辑、禁止清单）**不许动**。
4. 写 Prompt：沿用模板的语言和颗粒度——它写到「电车占画面宽度 55%–65%」「海平线 45%–48%」这种精度，你也要写到这种精度。
5. 用户完全没想法时：先列出仓库里有哪些风格目录，挑一个（或让他挑），然后照 1–4 走。可以顺手提几种成组玩法——三联「之前/当中/之后」、只换一个变量的对照组、同一世界的九宫格——但这是建议，不是必须。

## 输出

每份 Prompt 出**两个互相独立的版本**，各自完整、各自能直接粘贴：

- **中文版：纯中文，不许出现英文。** 模板里的英文术语必须译出，不能照抄。例如 `photorealistic` → 写实摄影质感，`turquoise cyan` → 通透青绿，`sapphire blue` → 浓郁宝蓝，`glittering specular reflections` → 密集银白镜面反光，`anamorphic lens flare` → 变形宽银幕镜头眩光，`sunstar` → 太阳星芒，`bloom` → 高光溢出。**唯一例外**是胶片、器材、品牌的型号名（Kodak Ektar、Fujifilm Velvia、ARRI Alexa），它们没有通行中译，保留原名。
- **英文版：纯英文，不许出现中文。**
- 两版的数字、构图、材质、光线、Negative 条目**逐项对应**，只有语言不同。
- **Negative Prompt 跟着各自版本的语言走**：中文版写中文，英文版写英文。模板自己的「禁止：…」那一行就是现成素材，中文版直接沿用它的原措辞，不要翻译成英文再塞回来。
- **正向部分不写否定句。** 不要写「这不是插画」「不是海报」——模型对正文里的 `插画`、`海报` 一样会产生注意力。排除项一律进 Negative Prompt，写成并列的术语，不写成句子。
- 成组图：共享设定逐字一致，只让一条变量变化。
- 直接给成品，不留占位符，不夹解释。

## 自检

- 这份 Prompt 的风格定义，是从模板里读来的，还是我自己想的？
- 模板的禁止清单，我有没有违反？
- 用户明确说过的每一条，都照做了吗？
- 中文版里还有英文吗（型号名除外）？英文版里还有中文吗？
- 两版的数字和 Negative 条目对得上吗？正向里还有否定句吗？
