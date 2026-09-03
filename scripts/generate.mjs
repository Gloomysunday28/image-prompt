#!/usr/bin/env node
// 唯一数据源：data/prompts/caseN.md 的 front-matter + 正文
// 产出：data/prompts.json、docs/gallery.md、README.md 内的生成区块
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PROMPT_DIR = path.join(ROOT, 'data/prompts');
const REPO = 'https://github.com/Gloomysunday28/image-prompt';

function parse(file) {
  const raw = fs.readFileSync(path.join(PROMPT_DIR, file), 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error(`${file} 缺少 front-matter`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      v = v.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
    } else {
      v = v.replace(/^"(.*)"$/, '$1');
    }
    meta[k] = v;
  }
  const prompt = raw.slice(m[0].length).trim();
  const id = Number(meta.id);
  return {
    id,
    title: meta.title,
    category: meta.category,
    type: meta.type,
    styles: meta.styles || [],
    scenes: meta.scenes || [],
    aspect: meta.aspect,
    summary: meta.summary,
    image: meta.image ? `data/images/${meta.image}` : null,
    thumb: fs.existsSync(path.join(ROOT, `data/images/thumbs/case${id}.jpg`))
      ? `data/images/thumbs/case${id}.jpg` : null,
    source: `data/prompts/case${id}.md`,
    galleryUrl: `${REPO}/blob/main/docs/gallery.md#case-${id}`,
    prompt,
    promptPreview: prompt.replace(/\s+/g, ' ').slice(0, 120),
  };
}

const cases = fs.readdirSync(PROMPT_DIR)
  .filter(f => /^case\d+\.md$/.test(f))
  .map(parse)
  .sort((a, b) => a.id - b.id);

// ---- data/prompts.json ----
fs.writeFileSync(path.join(ROOT, 'data/prompts.json'),
  JSON.stringify({ total: cases.length, generatedFrom: 'data/prompts/', cases }, null, 2) + '\n');

// ---- docs/gallery.md ----
const g = [];
g.push('> [返回 README 首页](../README.md) | [VEO 3 视频提示词方法](./veo3.md)\n');
g.push('## 🖼️ 提示词画廊\n');
g.push(`当前总数 ${cases.length}。本文件由 \`scripts/generate.mjs\` 生成，请勿手改；改 \`data/prompts/caseN.md\` 后重新生成。\n`);
g.push('| # | 标题 | 分类 | 类型 | 画幅 | 一句话 |');
g.push('| --- | --- | --- | --- | --- | --- |');
for (const c of cases) {
  g.push(`| ${c.id} | [${c.title}](#case-${c.id}) | ${c.category} | ${c.type} | ${c.aspect} | ${c.summary} |`);
}
g.push('\n<!-- GENERATED:GALLERY:START -->\n');
for (const c of cases) {
  g.push(`<a name="case-${c.id}"></a>\n`);
  g.push(`### 例 ${c.id}：${c.title}\n`);
  if (c.image) g.push(`![${c.title}](../${c.image})\n`);
  g.push(`**分类：** ${c.category} ｜ **类型：** ${c.type} ｜ **画幅：** ${c.aspect}\n`);
  g.push(`**标签：** ${[...c.styles, ...c.scenes].map(t => `\`${t}\``).join(' ')}\n`);
  g.push(`**源文件：** [${c.source}](../${c.source})\n`);
  g.push('**提示词：**\n');
  g.push('```text');
  g.push(c.prompt);
  g.push('```\n');
  g.push('***\n');
}
g.push('<!-- GENERATED:GALLERY:END -->');
fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs/gallery.md'), g.join('\n') + '\n');

// ---- README 生成区块 ----
const byCat = new Map();
for (const c of cases) {
  if (!byCat.has(c.category)) byCat.set(c.category, []);
  byCat.get(c.category).push(c);
}
const overview = [];
overview.push('| 分类 | 条数 | 类型分布 | 提示词 |');
overview.push('| --- | --- | --- | --- |');
for (const [cat, list] of byCat) {
  const types = [...new Set(list.map(c => c.type))].join(' / ');
  const links = list.map(c => `[${c.title}](docs/gallery.md#case-${c.id})`).join('、');
  overview.push(`| **${cat}** | ${list.length} | ${types} | ${links} |`);
}

const featured = cases.filter(c => c.thumb);
const cards = [];
for (let i = 0; i < featured.length; i += 3) {
  const row = featured.slice(i, i + 3);
  cards.push('| ' + row.map(c =>
    `<a href="${c.image}"><img src="${c.thumb}" width="300" /></a>`).join(' | ') + ' |');
  if (i === 0) cards.push('| ' + row.map(() => ':---:').join(' | ') + ' |');
  cards.push('| ' + row.map(c =>
    `**例 ${c.id}·${c.title}**<br />[查看提示词](docs/gallery.md#case-${c.id})`).join(' | ') + ' |');
}

function inject(md, key, content) {
  const s = `<!-- GENERATED:${key}:START -->`, e = `<!-- GENERATED:${key}:END -->`;
  const re = new RegExp(`${s}[\\s\\S]*?${e}`);
  if (!re.test(md)) throw new Error(`README 缺少 ${key} 标记`);
  return md.replace(re, `${s}\n\n${content}\n\n${e}`);
}
const readmePath = path.join(ROOT, 'README.md');
let readme = fs.readFileSync(readmePath, 'utf8');
readme = inject(readme, 'OVERVIEW', overview.join('\n'));
readme = inject(readme, 'GALLERY', cards.join('\n'));
readme = readme.replace(/badge\/提示词-\d+/g, `badge/提示词-${cases.length}`);
fs.writeFileSync(readmePath, readme);

console.log(`✓ ${cases.length} 条 → data/prompts.json、docs/gallery.md、README.md`);
