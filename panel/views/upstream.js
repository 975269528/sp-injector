// views/upstream.js · 注入控制（接口格式 + 注入模式 + Scripture 头 + 抓取开关 + 保留章节）
// 上游 API 配置已移至「路由」视图
spApp.views = spApp.views || {};
spApp.views.upstream = {
  onEnter() {
    this.loadSections();
    this.renderBanner();
    $("sections-config").style.display =
      spApp.state.mode === "keepSections" ? "" : "none";
  },
  onState(s) {
    document.querySelectorAll(".seg-btn[data-mode]").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === s.mode);
    });
    document.querySelectorAll(".seg-btn[data-format]").forEach((b) => {
      b.classList.toggle("active", b.dataset.format === s.format);
    });
    $("toggle-header").checked = s.useHeader;
    $("toggle-capture").checked = s.captureOn !== false;
    $("sections-config").style.display = s.mode === "keepSections" ? "" : "none";
    this.renderBanner(); // 常显更新
  },
  // 常显：当前已保留哪些章节（从 state.sectionsKeep 取，不依赖抓取）
  renderBanner() {
    const el = $("sections-banner");
    if (!el) return;
    const keep = spApp.state.sectionsKeep || [];
    if (!keep.length) {
      el.style.display = "none";
      return;
    }
    el.style.display = "";
    el.innerHTML =
      `<span class="sb-label">已保留章节（keepSections 模式按下列顺序追加到经文后）：</span>` +
      `<div class="sb-items">` +
      keep
        .map(
          (title, i) =>
            `<span class="sb-item"><span class="sb-seq">${i + 1}</span><span class="sb-title">${title}</span><button class="sb-del" data-title="${title.replace(/"/g, "&quot;")}" title="删除">${spApp.icon("close", 11)}</button></span>`,
        )
        .join("") +
      `</div>`;
    el.querySelectorAll(".sb-del").forEach((b) => {
      b.onclick = () => this.removeSection(b.dataset.title);
    });
  },
  // 单个删除：从 sectionsKeep 移除并保存
  async removeSection(title) {
    const keep = (spApp.state.sectionsKeep || []).filter((t) => t !== title);
    await spApp.api.post("/api/sections/keep", { keep });
    await spApp.loadState();
    this.renderBanner();
    this.toast("已移除: " + title);
  },
  async loadSections() {
    const data = await spApp.api.get("/api/sections").catch(() => null);
    if (!data) return;
    const box = $("sections-list");
    const hint = $("sections-hint");
    if (!data.hasCapture || !data.sections.length) {
      box.innerHTML = "";
      const keep = data.keep || [];
      if (keep.length) {
        hint.innerHTML =
          `已保留章节（持久化，重启不丢）：<b>${keep.join(", ")}</b><br>` +
          `当前无抓取记录可供重新解析。发一条请求后，这些章节会被自动勾选。`;
      } else {
        hint.textContent = "暂无抓取记录。先发一条请求（任何模式），章节会自动解析出来供勾选。";
      }
      hint.style.display = "";
      return;
    }
    hint.style.display = "none";
    const keep = data.keep || [];
    box.innerHTML = data.sections
      .map(
        (sec) => `
        <label class="sec-item">
          <input type="checkbox" class="sec-cb" data-title="${sec.title.replace(/"/g, "&quot;")}" ${keep.includes(sec.title) ? "checked" : ""} />
          <span class="sec-title">${sec.title}</span>
          <span class="sec-meta">${sec.chars}字 · L${sec.level}</span>
        </label>
      `,
      )
      .join("");
    box.querySelectorAll(".sec-cb").forEach((cb) => {
      cb.onchange = () => this.saveSections();
    });
  },
  async saveSections() {
    const keep = [...document.querySelectorAll(".sec-cb:checked")].map((cb) => cb.dataset.title);
    await spApp.api.post("/api/sections/keep", { keep });
    await spApp.loadState();
    this.toast("保留章节已保存");
  },
  // 轻量提示:全局 toast
  toast(msg) {
    if (spApp.toast) spApp.toast(msg);
  },
  bind() {
    const self = this;
    document.querySelectorAll(".seg-btn[data-mode]").forEach((b) => {
      b.onclick = async () => {
        await spApp.api.post("/api/state/mode", { mode: b.dataset.mode });
        await spApp.loadState();
        if (b.dataset.mode === "keepSections") {
          $("sections-config").style.display = "";
          await self.loadSections();
        } else {
          $("sections-config").style.display = "none";
        }
        self.toast("模式 → " + b.dataset.mode);
      };
    });
    document.querySelectorAll(".seg-btn[data-format]").forEach((b) => {
      b.onclick = async () => {
        await spApp.api.post("/api/state/format", { format: b.dataset.format });
        await spApp.loadState();
        self.toast("格式 → " + b.dataset.format);
      };
    });
    $("toggle-header").onchange = async (e) => {
      await spApp.api.post("/api/state/header", { on: e.target.checked });
      await spApp.loadState();
      self.toast("头 " + (e.target.checked ? "开" : "关"));
    };
    $("toggle-capture").onchange = async (e) => {
      await spApp.api.post("/api/state/capture", { on: e.target.checked });
      await spApp.loadState();
      self.toast("抓取 " + (e.target.checked ? "开" : "关"));
    };
  },
};
spApp.views.upstream.bind();
