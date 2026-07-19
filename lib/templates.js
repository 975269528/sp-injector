// lib/templates.js · 模板 CRUD · 三十辐共一毂
// 纯文本文件存储 · 名字严格校验防路径穿越

const fs = require("fs");
const path = require("path");
const { TEMPLATES_DIR, BUILTIN, NAME_RE } = require("./config");

function tplPath(name) {
  return path.join(TEMPLATES_DIR, `${name}.txt`);
}

function isValidName(name) {
  return typeof name === "string" && NAME_RE.test(name);
}

// 列表：扫描 *.txt，返回 [{name, chars}]
function list() {
  if (!fs.existsSync(TEMPLATES_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(TEMPLATES_DIR)) {
    if (!f.endsWith(".txt")) continue;
    const name = f.slice(0, -4);
    try {
      const chars = fs.readFileSync(path.join(TEMPLATES_DIR, f), "utf8")
        .length;
      out.push({ name, chars, builtin: BUILTIN.has(name) });
    } catch {}
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// 读全文
function read(name) {
  if (!isValidName(name)) throw new Error("invalid name");
  const p = tplPath(name);
  if (!fs.existsSync(p)) throw new Error("not found");
  return fs.readFileSync(p, "utf8");
}

// 保存
function save(name, content) {
  if (!isValidName(name)) throw new Error("invalid name");
  if (typeof content !== "string") throw new Error("content must be string");
  if (!fs.existsSync(TEMPLATES_DIR))
    fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
  fs.writeFileSync(tplPath(name), content, "utf8");
  return { name, chars: content.length };
}

// 新建空模板
function create(name) {
  if (!isValidName(name)) throw new Error("invalid name");
  const p = tplPath(name);
  if (fs.existsSync(p)) throw new Error("already exists");
  fs.writeFileSync(p, "", "utf8");
  return { name, chars: 0 };
}

// 删除（内置禁删）
function remove(name) {
  if (!isValidName(name)) throw new Error("invalid name");
  if (BUILTIN.has(name)) throw new Error("builtin cannot be deleted");
  const p = tplPath(name);
  if (!fs.existsSync(p)) throw new Error("not found");
  fs.unlinkSync(p);
  return { name };
}

module.exports = { isValidName, list, read, save, create, remove };
