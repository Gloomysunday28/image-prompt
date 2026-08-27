# README synchronization

Apply only the sections relevant to the requested repository change, but never omit the works/example entry when an example image is supplied.

## Counts

Count prompt Markdown only. Exclude the root README and all Skill documentation:

```bash
prompt_count=$(rg --files -g '*.md' -g '!README.md' -g '!skills/**' | wc -l | tr -d ' ')
category_count=$(rg --files -g '*.md' -g '!README.md' -g '!skills/**' | cut -d/ -f1 | sort -u | wc -l | tr -d ' ')
printf 'prompts=%s categories=%s\n' "$prompt_count" "$category_count"
```

Update the `prompts-N-blue` and `categories-N-green` badges to those exact values.

## Prompt navigation

For every new prompt, add one row to `## 提示词导航`:

```markdown
| 分类 | [文件.md](分类/文件.md) | 16:9 | 长 | 一句话说明 |
```

Keep related variants adjacent. Encode spaces and parentheses in links when the existing README does so.

## Category guide

- For a new category, add its heading to the table of contents and add a `### 分类 · 主题` section before the next category.
- Describe the prompt's distinguishing composition, camera language, subject, and reusable constraint in one concise paragraph or bullet.
- For an existing category, update its entry when the prompt's authoritative content has materially changed.
- Link both the prompt and its original example image when both exist.

## Works/examples table

For every supplied example image:

1. Keep the original at `<category>/<name>.png`.
2. Create `preview/<slug>.jpg` at 680×383.
3. Add an image cell linking the preview to the original and a caption linking to the prompt:

```markdown
| <a href="分类/文件.png"><img src="preview/slug.jpg" width="340" height="191" /></a> |  |  |
| **分类 · 标题**<br />[`分类/文件.md`](分类/文件.md) |  |  |
```

Fill available cells in the previous incomplete row before adding a new row. Keep three cells per row and do not duplicate an existing work.

## Directory tree

- Add every new category, prompt, and original example image to `## 目录与命名规范`.
- Keep prompt/image pairs adjacent and use the same basename.
- Keep `preview/` summarized as the README thumbnail directory; individual preview filenames do not need to appear in the tree.
- Keep `skills/` separate from visual categories and never include it in prompt/category counts.

## Link verification

Check new links directly with `test -e` or equivalent. Verify the preview dimensions and confirm the README mentions the prompt, original image, and preview path.
