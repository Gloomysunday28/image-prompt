---
name: image-scene-inventor
description: Decide what image project to make and hand back finished, professional prompts in both Chinese and English in one pass. Use when the user has no idea what to make at all, wants a brief or assignment rather than a scene, wants inspiration or random scenes, asks what else an image-prompt template can shoot, wants a coherent series/diptych/triptych/nine-grid or an A-B variable test, wants to break out of a template's default look, or says things like 不知道做什么 / 随便来点 / 给点灵感 / 这个模板还能拍什么 / 帮我想画面. Rolls real dice over a brief pool and a scene-axis pool, applies template levers, then emits a complete paste-ready bilingual prompt pair with Negative Prompt for every image.
---

# Image Scene Inventor

用户的问题分两层，这个 Skill 从**上面那层**开始：

1. **做什么事** —— 出一张还是一组？组图靠什么串起来？锁哪条变量？给谁看？（默认层）
2. **做成什么画面** —— 具体到情境、镜头、光线、材质。

不要求用户先给前提。零输入直接跑，从命题一路做到可粘贴的完整 Prompt。

## 铁律

- **用户说的话是硬约束，骰子只填空白**。见下面「用户给了前提怎么办」。
- **必须真掷骰**。每次都先跑 `scripts/roll.py`。不要凭感觉"随机想"——那样只会反复落在同几个安全答案上。
- **默认从命题层开始**。用户没说要做什么时，先给他一个"做什么事"，而不是直接甩三个孤立画面。
- **媒介必须显式决定，不许默默走路线默认值**。见下面「媒介」。
- **一次交付到底**。命题、场景、完整 Prompt 一起给，不要只给创意清单等用户点单。
- **每份 Prompt 出中英两版**，两版信息逐项对应。见 [references/prompt-structure.md](references/prompt-structure.md)。
- **不改用户的文件**。除非用户另外要求保存或入库。

## 本 Skill 的文件

下面的路径都相对于**本 SKILL.md 所在目录**。执行脚本前先确定这个目录的绝对路径，不要假设当前工作目录是任何特定仓库的根。

| 路径 | 作用 |
| --- | --- |
| `scripts/roll.py` | 掷骰脚本，只依赖 Python 3 标准库 |
| `assets/briefs.json` | 命题池：任务形态 / 母题 / 约束 / 练习项 / 交付 |
| `assets/axes.json` | 场景轴池：10 条路线各自的可变维度 |
| `references/template-levers.md` | 每条路线的锁死项 / 自由变量 / 高收益改法 / 失败信号 |
| `references/prompt-structure.md` | Prompt 节序、数字要求、双语规则、Negative Prompt 选择 |

**本 Skill 自带全部所需知识，不依赖任何其他 Skill 或任何特定仓库。**

两个可选增强，有就用、没有就跳过，绝不因为缺席而降级或报错：

- 如果 `image-prompt-generator` Skill 也已安装，可以用 Skill 工具按**名字**调用它来写最终 Prompt，它的路线目录更细。**不要用相对路径去读它的文件**——两个 Skill 不保证被装在同一棵目录树里。
- `assets/axes.json` 每条路线的 `sources` 字段记的是 `Gloomysunday28/image-prompt` 仓库里的源提示词文件（如 `怪兽/近距离大鸟.md`）。**只有当用户的工作目录里确实存在这些文件时**才去读，用来贴近原样张的保真度；不存在就完全忽略，`references/template-levers.md` 已经把每条路线的风格骨架写全了。

## 用户给了前提怎么办

零输入是**默认**，不是**唯一**。用户只要说了任何条件——主体、题材、画风、媒介、情绪、用途、画幅——那都是**硬约束**：

1. 先用用户的话把**路线**和**媒介**定下来，这两项不参与掷骰。
2. 骰子只负责填用户**没有指定**的轴。
3. 用户的话和骰子冲突时，**永远是骰子让路**，直接换掉那一条，不要试图调和。
4. 用户的话和路线默认值冲突时，**永远是路线默认值让路**。

绝不能出现"用户说了 X，输出还是路线默认的 Y"。

### 媒介

媒介是独立于路线的一条轴，在 `assets/axes.json` 里：`universal.媒介` 是全部七种及其渲染语言，每条路线有 `默认媒介` 和 `可用媒介`。

**用户的措辞直接决定媒介，优先级高于路线默认值：**

| 用户说 | 媒介 |
| --- | --- |
| 治愈系、温柔、柔和、清新、日系 | 柔光胶片摄影 或 2D 动画背景——**不要用硬派纪实实拍** |
| 动画感、宫崎骏、新海诚、手绘、赛璐璐 | 2D 动画背景 |
| 水彩、淡彩、透明感、留白 | 水彩淡彩 |
| 插画、厚涂、概念图、笔触 | 厚涂数字插画 |
| 海报、复古印刷、丝网印 | 丝网印复古海报 |
| 实拍、纪实、照片、真实感、电影感 | 实拍摄影 |
| 什么都没说 | 走路线 `默认媒介`，但仍要在输出里写明是哪种 |

用 `-m` 传给脚本（模糊匹配即可：`-m 动画`、`-m 水彩`、`-m 胶片`）。用户点名了某条路线不支持的媒介，照给，脚本会标注为非常规组合。

`--media` 可以列出全部七种媒介及各自的渲染语言与禁忌。

## 流程

### 1. 掷骰

**命题模式（默认）** —— 用户不知道要做什么：

```bash
python3 <本 SKILL.md 所在目录>/scripts/roll.py
```

输出一个完整命题：任务形态（出几张、怎么串）+ 母题 + 约束 + 交付画幅 + 每一张的场景种子。

| 用户说 | 参数 |
| --- | --- |
| 不知道做什么 / 随便来点 | 无参数 |
| 就用某个模板 | `-r <route key>` |
| 我想做组图 / 想做对照 / 指定玩法 | `-f <编号>`（先 `--forms` 看清单） |
| 张数换一下 | `-n N` |
| 要更野 | `--wild` |
| 上次那个再来一遍 | `--seed <数字>` |
| 有哪些路线 / 玩法 | `--list` / `--forms` |

**场景模式** —— 用户已经知道要做什么，只缺画面：

```bash
python3 <本 SKILL.md 所在目录>/scripts/roll.py scene -n 3 [-r <route>] [--wild]
```

### 2. 把种子变成场景

读 [references/template-levers.md](references/template-levers.md)，找到该路线的**锁死项 / 自由变量 / 高收益改法**。

- 骰子给的是原料，不是成品。把各条轴组合成**一个连贯、有因果的画面**，删掉互相打架的条目，必要时就近替换。
- **母题**要在每一张里都能看见，但不能靠同一个手法实现两次。
- **约束**是硬的。做不到就换场景，不要偷偷放宽。
- 「反差注入」和「跨路线杂交」要真正落到画面上；只写在描述里不算。
- 一个场景只推**一个**高收益改法。
- 组图（`locked` / `hybrid`）里，**共享设定必须逐字一致**，只有变化轴允许不同——这是整组风格统一的唯一保证。
- `varied` 组图反过来：风格各不相同，但叙事必须接得上。

### 3. 生成 Prompt

按 [references/prompt-structure.md](references/prompt-structure.md) 写。要点：

- 按路线选输出形态：分节长文 / 密集短段 / 参数化模板。
- **正向部分里不许出现任何否定句**（"这不是海报""不是飞船""不是神光"）。所有排除项一律下沉到 Negative Prompt，写成术语不写成句子。
- **按媒介选写法**：给 2D 动画背景写"24mm 广角""景深""传感器噪点"是错的；那里控制视角要靠透视收敛、前景遮挡比例、色块分层。
- 每份出**中文版 + English 版**两个代码块，画幅、焦段、机位、距离、角度、主体占比、地平线、尺寸、光源、材质、Negative 条目逐项对应；英文版用摄影制片术语，不写翻译腔。
- 控制构图的地方写**确切数字**。命题给了交付画幅时以它为准。
- 近景 / 中景 / 远景各放什么、视线怎么被引导过去，必须写清楚。
- Negative Prompt 针对该路线的典型失败模式，不能否掉正向里要求的东西。

### 4. 自检

按 template-levers.md 末尾的「打开度自检」逐条过一遍，再加三条：

- 中英两版的每一个数字和每一条 Negative 都对得上吗？
- Prompt 里还剩下"史诗""震撼""氛围感"这类不产生具体结果的词吗？
- 正向部分里还有否定句吗？有就搬进 Negative Prompt。
- 用户明确说过的每一条，输出里都照做了吗？
- 这份 Prompt 的术语和当前媒介对得上吗（没给插画写摄影参数、没给摄影写笔触）？
- 组图的共享设定是不是真的一个字都没变？

## 输出格式

### 命题模式

```markdown
## 这次做什么：〈任务形态〉

〈两三句：这组图靠什么串起来、母题是什么、约束是什么、成品什么画幅。不要复述骰子。〉

**共享设定（每张都不变）**：〈世界、材质、光线、镜头族，一段话讲完；varied 组图这里改写共同母题〉

---

### 第 N 张 ·〈四到八个字的画名〉

- **变的是**：〈这张和上一张唯一的差别〉
- **一句话画面**：〈一句能看见的画面〉

**中文版**

〈完整中文 Prompt，含 Negative Prompt〉

**English**

〈完整英文 Prompt，含 Negative prompt，信息与中文版逐项对应〉
```

### 场景模式

```markdown
### 场景 N ·〈四到八个字的场景名〉

- **路线**：〈中文路线名〉
- **一句话画面**：〈一句能看见的画面〉
- **打开点**：〈这次用的高收益改法或杂交，一句话说清它把模板推去了哪〉

**中文版** → 代码块
**English** → 代码块
```

### 通用约定

- 一次最多出 **3 组**完整 Prompt（每组含中英两版）。命题要求 4 张以上时（九宫格等），先给全部「画名 + 变的是 + 一句话画面」清单，再展开前 3 组，并说明其余可以点名展开。
- 不要解释掷骰过程、不要罗列轴名、不要复述 Skill 规则。用户要的是命题和 Prompt。
- 用户嫌这个命题不合胃口时，直接重掷，不要追问他想要什么。
- 用户点名要改某张（换天气、换时段、换机位）时，锁住共享设定，只动他指定的那一处，中英两版一起重出。

## 扩池

- 新玩法写进 `assets/briefs.json` 的 `任务形态`：`名称` / `张数` / `路线模式`（`locked` 同路线单变量、`varied` 每张换路线、`hybrid` 同题材两种语法）/ `变化轴`（轴名、`随机` 或 `无`）/ `说明`。
- 新画面点子追加进 `assets/axes.json` 对应路线的轴数组；新增一条路线要补 `name` / `catalog_route` / `sources` / `axes`，同时在 `references/template-levers.md` 里补它的锁死项与高收益改法。
- 每条都必须是**能被看见的具体画面**，不要写"很震撼""有氛围"这类形容词。
