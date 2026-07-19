// views/routing.js · 路由配置（上游池 + 路由规则）
spApp.views = spApp.views || {};
spApp.views.routing = {
  upstreams: [],
  routes: [],
  onEnter() { this.load(); },
  async load() {
    const data = await spApp.api.get("/api/routing").catch(() => ({ upstreams: [], routes: [] }));
    this.upstreams = data.upstreams || [];
    this.routes = data.routes || [];
    this.renderUpstreams();
    this.renderRoutes();
  },
  renderUpstreams() {
    const tb = $("up-tbody");
    if (!this.upstreams.length) {
      tb.innerHTML = '<tr><td colspan="7" class="muted center">暂无上游。点「+ 添加上游」。</td></tr>';
      return;
    }
    const proxyOpts = (val) =>
      ["auto", "direct", "custom"]
        .map(
          (o) =>
            `<option value="${o}"${o === val ? " selected" : ""}>${o}${o === "auto" ? " · 系统代理" : o === "direct" ? " · 直连" : " · 指定"}</option>`,
        )
        .join("");
    tb.innerHTML = this.upstreams
      .map((u, i) => {
        const isCustom = (u.useProxy || "direct") === "custom";
        return `
      <tr>
        <td><input class="rt-input" data-u="${i}" data-k="name" value="${(u.name || "").replace(/"/g, "&quot;")}" style="width:100px" /></td>
        <td><input class="rt-input" data-u="${i}" data-k="host" value="${u.host || ""}" style="width:160px" /></td>
        <td><input class="rt-input" data-u="${i}" data-k="port" value="${u.port || 443}" style="width:60px" /></td>
        <td><input class="rt-input" data-u="${i}" data-k="pathPrefix" value="${u.pathPrefix || ""}" style="width:110px" /></td>
        <td><select class="rt-input rt-proxy" data-u="${i}" data-k="useProxy" style="width:120px">${proxyOpts(u.useProxy || "direct")}</select></td>
        <td><input class="rt-input rt-proxy-url" data-u="${i}" data-k="customProxyUrl" value="${u.customProxyUrl || ""}" style="width:150px" placeholder="http://127.0.0.1:7890" ${isCustom ? "" : 'disabled style="display:none;width:150px"'} /></td>
        <td><button class="btn btn-small btn-danger" data-u-del="${i}">删</button></td>
      </tr>`;
      })
      .join("");
    tb.querySelectorAll("[data-u-del]").forEach((b) => {
      b.onclick = () => {
        this.upstreams.splice(parseInt(b.dataset.uDel, 10), 1);
        this.renderUpstreams();
      };
    });
    // 普通输入
    tb.querySelectorAll(".rt-input[data-u]:not(.rt-proxy)").forEach((inp) => {
      inp.oninput = () => {
        const i = parseInt(inp.dataset.u, 10);
        this.upstreams[i][inp.dataset.k] = inp.value;
      };
    });
    // 代理模式下拉联动
    tb.querySelectorAll(".rt-proxy").forEach((sel) => {
      sel.onchange = () => {
        const i = parseInt(sel.dataset.u, 10);
        this.upstreams[i][sel.dataset.k] = sel.value;
        this.renderUpstreams(); // 重渲染以显示/隐藏 customProxyUrl
      };
    });
  },
  renderRoutes() {
    const box = $("rt-list");
    if (!this.routes.length) {
      box.innerHTML = '<div class="rt-empty">暂无规则。不配规则时全部走默认上游。</div>';
      return;
    }
    const self = this;
    const upOpts = (selId) =>
      this.upstreams.length
        ? this.upstreams
            .map((u) => `<option value="${u.id}"${u.id === selId ? " selected" : ""}>${u.name || u.id}</option>`)
            .join("")
        : '<option value="">(请先添加上游)</option>';

    box.innerHTML = this.routes
      .map((r, ri) => {
        const ups = Array.isArray(r.upstreams) && r.upstreams.length
          ? r.upstreams
          : r.upstreamId
            ? [{ upstreamId: r.upstreamId, apiKey: r.apiKey || "" }]
            : [];
        // 兼容旧结构 → 迁移到新结构
        r.upstreams = ups;
        delete r.upstreamId;
        delete r.apiKey;

        const upsHtml = ups
          .map((c, ui) => `
            <div class="rt-up-row" draggable="true" data-r="${ri}" data-ui="${ui}">
              <span class="rt-drag" title="拖拽排序">⠿</span>
              <span class="seq-mini">${ui + 1}</span>
              <select class="rt-input rt-up-sel" data-r="${ri}" data-ui="${ui}" style="width:150px">${upOpts(c.upstreamId)}</select>
              <input class="rt-input rt-up-key" data-r="${ri}" data-ui="${ui}" value="${(c.apiKey || "").replace(/"/g, "&quot;")}" style="width:200px" placeholder="sk-..." type="password" />
              <button class="btn btn-small btn-danger" data-r="${ri}" data-ui-del="${ui}">删</button>
            </div>`)
          .join("");

        return `
          <div class="rt-rule">
            <div class="rt-rule-head">
              <span class="muted" style="font-size:11px;">前缀</span>
              <input class="rt-input rt-prefix" data-r="${ri}" value="${(r.modelPrefix || "").replace(/"/g, "&quot;")}" style="width:200px" placeholder="如 GLM- / claude-" />
              <button class="btn btn-small" data-r-up-add="${ri}">+ 上游</button>
              <button class="btn btn-small btn-danger rt-rule-del" data-r-del="${ri}">删规则</button>
            </div>
            <div class="rt-ups">${upsHtml || '<div class="rt-empty">无上游，点「+ 上游」添加</div>'}</div>
          </div>`;
      })
      .join("");

    // modelPrefix
    box.querySelectorAll(".rt-prefix").forEach((inp) => {
      inp.oninput = () => {
        self.routes[parseInt(inp.dataset.r, 10)].modelPrefix = inp.value;
      };
    });
    // 上游选择/Key
    box.querySelectorAll(".rt-up-sel").forEach((sel) => {
      sel.onchange = () => {
        const ri = parseInt(sel.dataset.r, 10);
        const ui = parseInt(sel.dataset.ui, 10);
        self.routes[ri].upstreams[ui].upstreamId = sel.value;
      };
    });
    box.querySelectorAll(".rt-up-key").forEach((inp) => {
      inp.oninput = () => {
        const ri = parseInt(inp.dataset.r, 10);
        const ui = parseInt(inp.dataset.ui, 10);
        self.routes[ri].upstreams[ui].apiKey = inp.value;
      };
    });
    // 删上游
    box.querySelectorAll("[data-ui-del]").forEach((b) => {
      b.onclick = () => {
        const ri = parseInt(b.dataset.r, 10);
        const ui = parseInt(b.dataset.uiDel, 10);
        self.routes[ri].upstreams.splice(ui, 1);
        self.renderRoutes();
      };
    });
    // 加上游
    box.querySelectorAll("[data-r-up-add]").forEach((b) => {
      b.onclick = () => {
        const ri = parseInt(b.dataset.rUpAdd, 10);
        self.routes[ri].upstreams.push({ upstreamId: self.upstreams[0]?.id || "", apiKey: "" });
        self.renderRoutes();
      };
    });
    // 删规则
    box.querySelectorAll(".rt-rule-del").forEach((b) => {
      b.onclick = () => {
        self.routes.splice(parseInt(b.dataset.rDel, 10), 1);
        self.renderRoutes();
      };
    });
    // 拖拽排序（同一规则内）
    this.bindDnD(box);
  },
  // 拖拽：同一 rt-rule 内的 rt-up-row 排序
  bindDnD(box) {
    const self = this;
    let dragEl = null;
    let dragRi = -1;
    box.querySelectorAll(".rt-up-row").forEach((row) => {
      row.addEventListener("dragstart", (e) => {
        dragEl = row;
        dragRi = parseInt(row.dataset.r, 10);
        row.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragend", () => {
        row.classList.remove("dragging");
        box.querySelectorAll(".rt-up-row").forEach((r) => r.classList.remove("drag-over"));
      });
      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (!dragEl || parseInt(row.dataset.r, 10) !== dragRi) return;
        if (row === dragEl) return;
        // 在被拖元素前/后插入指示
        const rect = row.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        box.querySelectorAll(".rt-up-row").forEach((r) => r.classList.remove("drag-over"));
        row.classList.add("drag-over");
        row._after = after;
      });
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        if (!dragEl || parseInt(row.dataset.r, 10) !== dragRi || row === dragEl) return;
        const fromUi = parseInt(dragEl.dataset.ui, 10);
        let toUi = parseInt(row.dataset.ui, 10);
        const ups = self.routes[dragRi].upstreams;
        const [moved] = ups.splice(fromUi, 1);
        // 调整目标索引（删除后偏移）
        if (fromUi < toUi) toUi--;
        if (row._after) toUi++;
        ups.splice(toUi, 0, moved);
        self.renderRoutes();
      });
    });
  },
  newId() {
    return "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  },
  flash(msg, err) {
    const el = $("routing-status");
    el.textContent = msg;
    el.style.color = err ? "var(--danger)" : "var(--ok)";
    setTimeout(() => (el.textContent = ""), 2500);
  },
  bind() {
    const self = this;
    $("btn-up-add").onclick = () => {
      self.upstreams.push({
        id: self.newId(),
        name: "新上游",
        host: "",
        port: 443,
        pathPrefix: "",
        useProxy: "direct",
        customProxyUrl: "",
      });
      self.renderUpstreams();
    };
    $("btn-rt-add").onclick = () => {
      self.routes.push({
        id: self.newId(),
        modelPrefix: "",
        upstreams: [{ upstreamId: self.upstreams[0]?.id || "", apiKey: "" }],
      });
      self.renderRoutes();
    };
    const saveOne = async (path, key, list) => {
      // 先不带 force 试
      const r = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: list }),
      });
      if (r.status === 409) {
        // 触发保护：弹确认
        const data = await r.json().catch(() => ({}));
        if (!confirm(data.error || "将清空配置，确认？")) {
          throw new Error("cancel");
        }
        // 带 force 重试
        const r2 = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [key]: list, force: true }),
        });
        return r2.json();
      }
      return r.json();
    };
    $("btn-routing-save").onclick = async () => {
      try {
        await saveOne("/api/routing/upstreams", "upstreams", self.upstreams);
        await saveOne("/api/routing/routes", "routes", self.routes);
        await self.load();
        self.flash("已保存，立即生效");
      } catch (e) {
        if (e.message === "cancel") self.flash("已取消", true);
        else self.flash("保存失败", true);
      }
    };
  },
};
spApp.views.routing.bind();
