// lib/sectionParser.js · 按 markdown # 标题切章节
// 把官方 system 切成 [{title, level, content}] 数组，供 keepSections 模式选择性保留

// 解析 system 文本成章节列表
// 规则：以 # 或 ## 或 ### 开头的行作为章节标题，到下一个同级或更高级标题之前为其内容
function parseSections(text) {
  if (!text || typeof text !== "string") return [];
  const lines = text.split(/\r?\n/);
  const sections = [];
  let cur = null; // {title, level, raw}
  let preface = []; // 第一个标题前的内容（如果有）

  const isHeading = (l) => /^(#{1,6})\s+(.+?)\s*$/.test(l);

  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) {
      // 遇到新标题：封存当前
      if (cur) sections.push(cur);
      cur = {
        title: m[2].trim(),
        level: m[1].length,
        content: line + "\n",
        raw: line,
      };
    } else if (cur) {
      cur.content += line + "\n";
    } else {
      preface.push(line);
    }
  }
  if (cur) sections.push(cur);

  // 若有前言（标题前内容）且非空，作为特殊章节 "_preface"
  const preText = preface.join("\n").trim();
  if (preText && sections.length > 0) {
    sections.unshift({ title: "(标题前内容)", level: 0, content: preText + "\n", raw: "" });
  }
  return sections;
}

// 从章节列表中按标题提取（keep 是标题数组）
function extractKept(sections, keep) {
  if (!Array.isArray(keep) || keep.length === 0) return "";
  const keepSet = new Set(keep);
  const kept = sections.filter((s) => keepSet.has(s.title));
  return kept.map((s) => s.content).join("\n").trim();
}

// 列出所有标题（供面板勾选）
function listTitles(sections) {
  return sections.map((s) => ({ title: s.title, level: s.level, chars: s.content.length }));
}

module.exports = { parseSections, extractKept, listTitles };
