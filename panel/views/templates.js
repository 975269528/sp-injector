// views/templates.js · 模板视图（多选 + 编辑器）
spApp.views = spApp.views || {};
spApp.views.templates = {
  currentEdit: null,
  onEnter() { this.loadTemplates(); },
  async loadTemplates() {
    const { templates } = await spApp.api.get("/api/templates");
    const active = spApp.state.activeTemplates || [];
    const box = $("tpl-list");
    box.innerHTML = "";
    for (const t of templates) {
      const idx = active.indexOf(t.name);
      const isActive = idx >= 0;
      const isFocus = t.name === this.currentEdit;
      const div = document.createElement("div");
      div.className = "tpl-item";
      if (isActive) div.classList.add("active");
      if (isFocus) div.classList.add("focus");
      div.dataset.name = t.name;
      div.innerHTML = `
        <div class="row1">
          <input type="checkbox" class="tpl-cb" ${isActive ? "checked" : ""} />
          <span class="name">${t.name}</span>
          ${isActive ? `<span class="seq-num">${idx + 1}</span>` : ""}
        </div>
        <span class="meta">${t.chars}字${t.builtin ? "·内置" : ""}</span>
      `;
      div.querySelector(".tpl-cb").onchange = (e) => {
        e.stopPropagation();
        this.toggleActive(t.name, e.target.checked);
      };
      div.onclick = (e) => {
        if (e.target.classList.contains("tpl-cb")) return;
        this.openEditor(t.name);
      };
      box.appendChild(div);
    }
    // 若没在编辑，打开第一个
    if (!this.currentEdit && templates[0]) this.openEditor(templates[0].name);
  },
  async toggleActive(name, on) {
    let list = [...(spApp.state.activeTemplates || [])];
    if (on) { if (!list.includes(name)) list.push(name); }
    else { list = list.filter((n) => n !== name); }
    await spApp.api.post("/api/state/templates", { names: list });
    await spApp.loadState();
    await this.loadTemplates();
    if (this.currentEdit) {
      const isActive = list.includes(this.currentEdit);
      $("edit-name-active").style.display = isActive ? "" : "none";
    }
  },
  async openEditor(name) {
    try {
      const { content } = await spApp.api.get("/api/templates/" + encodeURIComponent(name));
      this.currentEdit = name;
      const isActive = (spApp.state.activeTemplates || []).includes(name);
      $("edit-name").textContent = name;
      $("edit-name-active").style.display = isActive ? "" : "none";
      $("editor").value = content;
      $("edit-chars").textContent = content.length + " 字";
      $("edit-status").textContent = "";
      document.querySelectorAll(".tpl-item").forEach((el) => {
        el.classList.toggle("focus", el.dataset.name === name);
      });
    } catch (e) {
      this.flash("读取失败", true);
    }
  },
  flash(msg, err) {
    const el = $("edit-status");
    el.textContent = msg;
    el.style.color = err ? "var(--danger)" : "var(--ok)";
    setTimeout(() => (el.textContent = ""), 2500);
  },
  bind() {
    const self = this;
    $("editor").addEventListener("input", (e) => {
      $("edit-chars").textContent = e.target.value.length + " 字";
    });
    $("btn-save").onclick = async () => {
      if (!self.currentEdit) return;
      try {
        await spApp.api.post("/api/templates/" + encodeURIComponent(self.currentEdit), {
          content: $("editor").value,
        });
        self.flash("已保存");
        await self.loadTemplates();
      } catch { self.flash("保存失败", true); }
    };
    $("btn-activate").onclick = async () => {
      if (!self.currentEdit) return;
      const list = spApp.state.activeTemplates || [];
      const on = !list.includes(self.currentEdit);
      await self.toggleActive(self.currentEdit, on);
    };
    $("btn-reload").onclick = () => {
      if (self.currentEdit) self.openEditor(self.currentEdit);
    };
    $("btn-delete").onclick = async () => {
      if (!self.currentEdit) return;
      if (!confirm("删除模板 " + self.currentEdit + "？内置不可删。")) return;
      try {
        await spApp.api.del("/api/templates/" + encodeURIComponent(self.currentEdit));
        self.flash("已删除");
        self.currentEdit = null;
        await self.loadTemplates();
      } catch (e) { self.flash("删除失败", true); }
    };
    $("btn-new").onclick = async () => {
      const name = prompt("新模板名：");
      if (!name) return;
      try {
        await spApp.api.put("/api/templates/new/" + encodeURIComponent(name), {});
        self.flash("已创建");
        await self.loadTemplates();
        self.openEditor(name);
      } catch (e) { self.flash("创建失败: " + e.message || "", true); }
    };
  },
};
// 绑定一次（DOM 已就绪）
spApp.views.templates.bind();
