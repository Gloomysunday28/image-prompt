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

- **每份 Prompt 出中英两版**，两版的数字、材质、光线、Negative 条目逐项对应。英文用摄影或美术的行业术语，不写翻译腔。
- **正向部分不写否定句。** 不要写「这不是插画」「不是海报」——模型对正文里的 `插画`、`海报` 一样会产生注意力。所有排除项进 Negative Prompt，且写成术语（`illustration, poster layout`），不写成句子。模板自己的「禁止：…」那一行就是现成的 Negative 素材。
- 成组图：共享设定逐字一致，只让一条变量变化。
- 直接给成品，不留占位符，不夹解释。

## 自检

- 这份 Prompt 的风格定义，是从模板里读来的，还是我自己想的？
- 模板的禁止清单，我有没有违反？
- 用户明确说过的每一条，都照做了吗？
- 中英两版对得上吗？正向里还有否定句吗？
