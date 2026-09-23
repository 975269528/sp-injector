// views/captures.js · System 抓取视图（列表 + 详情对比）
spApp.views = spApp.views || {};
spApp.views.captures = {
  selectedSeq: null,
  onEnter() {
    this.loadList();
    // 进入视图时启动轮询（每 5 秒）
    if (!spApp.viewTimers.captures) {
      spApp.viewTimers.captures = setInterval(() => {
        if (spApp.currentView === "captures") this.loadList();
      }, 5000);
    }
  },
  onLeave() {
    if (spApp.viewTimers.captures) {
      clearInterval(spApp.viewTimers.captures);
      delete spApp.viewTimers.captures;
    }
  },
  async loadList() {
    const data = await spApp.api.get("/api/captures").catch(() => ({ captures: [], stats: {} }));
    const list = data.captures || [];
    const st = data.stats || {};
    $("cap-count").textContent = `· 共 ${st.buffered || 0} 条 (注入 ${st.injected || 0} / 官方 ${st.official || 0})`;
    const tbody = $("cap-tbody");
    if (list.length === 0) {
      tbody.innerHTML = "";
      $("cap-empty").style.display = "";
      return;
    }
    $("cap-empty").style.display = "none";
    tbody.innerHTML = list
      .map((c) => {
        const t = new Date(c.ts).toLocaleTimeString("zh-CN", { hour12: false });
        const sel = c.seq === this.selectedSeq ? "sel" : "";
        return `
          <tr class="${sel}" data-seq="${c.seq}">
            <td class="mono">#${c.seq}</td>
            <td class="mono">${t}</td>
            <td>${c.model || "-"}</td>
            <td>${c.format}</td>
            <td class="mono">${c.originalLen}</td>
            <td class="mono">${c.mode === "official" ? "-" : c.injectedLen}</td>
            <td><span class="badge-mode ${c.mode}">${esc(spApp.modeCn[c.mode] || c.mode)}</span></td>
          </tr>
        `;
      })
      .join("");
    // 绑定点击
    tbody.querySelectorAll("tr").forEach((tr) => {
      tr.onclick = () => this.openDetail(parseInt(tr.dataset.seq, 10));
    });
  },
  async openDetail(seq) {
    this.selectedSeq = seq;
    // 高亮选中行
    document.querySelectorAll("#cap-tbody tr").forEach((tr) => {
      tr.classList.toggle("sel", parseInt(tr.dataset.seq, 10) === seq);
    });
    const data = await spApp.api.get("/api/captures/" + seq).catch(() => null);
    if (!data || !data.capture) return;
    const c = data.capture;
    $("cap-detail-card").style.display = "";
    $("cap-detail-seq").textContent = c.seq;
    $("cap-orig-len").textContent = `(${c.originalLen} 字)`;
    $("cap-inj-len").textContent = `(${c.injectedLen} 字)`;
    $("cap-orig").textContent = c.originalSystem || "(空)";
    $("cap-inj").textContent = c.mode === "official" ? "(official 模式，未修改)" : c.injectedSystem || "(空)";
    $("btn-cap-detail-copy").onclick = async () => {
      try {
        await navigator.clipboard.writeText(c.originalSystem || "");
        const b = $("btn-cap-detail-copy");
        const o = b.textContent;
        b.textContent = "已复制 ✓";
        setTimeout(() => (b.textContent = o), 1500);
      } catch {}
    };
  },
  bind() {
    const self = this;
    $("btn-cap-refresh").onclick = () => self.loadList();
    $("btn-cap-clear").onclick = async () => {
      if (!confirm("清空所有抓取记录？")) return;
      await spApp.api.post("/api/captures/clear", {});
      self.selectedSeq = null;
      $("cap-detail-card").style.display = "none";
      await self.loadList();
    };
  },
};
spApp.views.captures.bind();
