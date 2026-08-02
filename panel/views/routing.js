// views/routing.js · 上游池 + 模型映射（客户端名 → 上游真实模型）
spApp.views = spApp.views || {};
spApp.views.routing = {
  upstreams: [],
  mappings: [],
  onEnter() {
    this.load();
  },
  onLeave() {},
  onState() {},
  async load() {
    const self = this;
    const [upData, mmData] = await Promise.all([
      spApp.api.get("/api/upstreams").catch(() => ({ upstreams: [] })),
      spApp.api.get("/api/mappings").catch(() => ({ mappings: [] })),
    ]);
    self.upstreams = upData.upstreams || [];
    self.mappings = mmData.mappings || [];
    self.renderUpstreams();
    self.renderMappings();
  },
  // ── 上游池表格 ───────────────────────────────────────────────
  renderUpstreams() {
    const self = this;
    const tb = $("up-tbody");
    if (!this.upstreams.length) {
      tb.innerHTML = '<tr><td colspan="8" class="muted center">暂无上游。点「+ 添加上游」。</td></tr>';
      return;
    }
    const proxyOpts = (val) =>
      ["auto", "direct"]
        .map(
          (o) =>
            `<option value="${o}"${o === val ? " selected" : ""}>${o}${o === "auto" ? " · 系统代理" : " · 直连"}</option>`,
        )
        .join("");
    const q = (s) => esc(String(s == null ? "" : s)).replace(/"/g, "&quot;");
    tb.innerHTML = this.upstreams
      .map((u, i) => {
        const models = Array.isArray(u.models) ? u.models : [];
        const modelHtml = models.length
          ? `模型: ${models.map((m) => q(m && m.name)).join(", ")} <span class="muted">(${models.length}个)</span>`
          : `<span class="muted">模型: (未拉取,点「拉取」)</span>`;
        return `
      <tr>
        <td><input class="rt-input" data-u="${i}" data-k="name" value="${q(u.name)}" style="width:100px" /></td>
        <td><input class="rt-input" data-u="${i}" data-k="host" value="${q(u.host)}" style="width:160px" /></td>
        <td><input class="rt-input" data-u="${i}" data-k="port" value="${q(u.port == null ? 443 : u.port)}" style="width:60px" /></td>
        <td><input class="rt-input" data-u="${i}" data-k="pathPrefix" value="${q(u.pathPrefix)}" style="width:110px" /></td>
        <td><select class="rt-input rt-proxy" data-u="${i}" data-k="useProxy" style="width:110px">${proxyOpts(u.useProxy || "direct")}</select></td>
        <td><input class="rt-input" data-u="${i}" data-k="modelsPath" value="${q(u.modelsPath || "/models")}" style="width:110px" placeholder="/models" /></td>
        <td><input class="rt-input" data-u="${i}" data-k="apiKey" value="${q(u.apiKey)}" style="width:160px" placeholder="sk-..." type="password" /></td>
        <td style="white-space:nowrap">
          <button class="btn btn-small" data-fetch="${i}">拉取</button>
          <button class="btn btn-small btn-danger" data-u-del="${i}">删</button>
        </td>
      </tr>
      <tr><td colspan="8" class="up-models">${modelHtml}</td></tr>`;
      })
      .join("");

    // 普通输入（除代理模式 select 外）
    tb.querySelectorAll(".rt-input[data-u]:not(.rt-proxy)").forEach((inp) => {
      inp.oninput = () => {
        const i = parseInt(inp.dataset.u, 10);
        self.upstreams[i][inp.dataset.k] = inp.value;
      };
    });
    // 代理模式（已无 custom，不再联动显隐，但仍写入 useProxy 字段）
    tb.querySelectorAll(".rt-proxy").forEach((sel) => {
      sel.onchange = () => {
        const i = parseInt(sel.dataset.u, 10);
        self.upstreams[i].useProxy = sel.value;
      };
    });
    // 删除上游
    tb.querySelectorAll("[data-u-del]").forEach((b) => {
      b.onclick = () => {
        self.upstreams.splice(parseInt(b.dataset.uDel, 10), 1);
        self.renderUpstreams();
      };
    });
    // 拉取模型
    tb.querySelectorAll("[data-fetch]").forEach((b) => {
      b.onclick = async () => {
        const i = parseInt(b.dataset.fetch, 10);
        const up = self.upstreams[i];
        if (!up || !up.id) {
          self.flash("上游缺少 id,请先保存", true);
          return;
        }
        const oldText = b.textContent;
        b.disabled = true;
        b.textContent = "拉取中...";
        try {
          const r = await spApp.api.post(
            `/api/upstreams/${encodeURIComponent(up.id)}/fetch-models`,
          );
          if (r && r.error) throw new Error(r.error);
          self.flash(`拉取到 ${r.count} 个模型`);
          await self.load(); // 后端已写回 models,重新加载
        } catch (e) {
          self.flash("拉取失败: " + (e.message || ""), true);
        } finally {
          b.disabled = false;
          b.textContent = oldText;
        }
      };
    });
  },
  // ── 模型映射 ─────────────────────────────────────────────────
  renderMappings() {
    const self = this;
    const box = $("mm-list");
    if (!this.mappings.length) {
      box.innerHTML = '<div class="rt-empty">暂无映射。点「+ 添加映射」。</div>';
      return;
    }
    const q = (s) => esc(String(s == null ? "" : s)).replace(/"/g, "&quot;");
    const upOpts = (selId) =>
      this.upstreams.length
        ? this.upstreams
            .map((u) => `<option value="${q(u.id)}"${u.id === selId ? " selected" : ""}>${q(u.name || u.id)}</option>`)
            .join("")
        : '<option value="">(请先添加上游)</option>';
    // 取某候选所选上游的 models[].name,作为 targetModel 软提示
    const modelNamesOf = (upstreamId) => {
      const up = this.upstreams.find((u) => u.id === upstreamId);
      return Array.isArray(up && up.models)
        ? up.models.map((m) => m && m.name).filter(Boolean)
        : [];
    };

    box.innerHTML = this.mappings
      .map((m, mi) => {
        const ups = Array.isArray(m.upstreams) ? m.upstreams : [];
        // 注入模式下拉：留空(全局) + replace/prepend/official/keepSections
        const modeOpts = (val) =>
          ["", "replace", "prepend", "official", "keepSections"]
            .map((o) => `<option value="${o}"${o === (val || "") ? " selected" : ""}>${o === "" ? "(全局)" : o}</option>`)
            .join("");
        const upsHtml = ups.length
          ? ups
              .map((c, ci) => {
                const names = modelNamesOf(c.upstreamId);
                const dlOpts = names.map((n) => `<option value="${q(n)}">`).join("");
                return `
            <div class="rt-up-row" draggable="true" data-mi="${mi}" data-ci="${ci}">
              <span class="rt-drag" title="拖拽排序">⠿</span>
              <span class="seq-mini">${ci + 1}</span>
              <select class="rt-input mm-up-sel" data-mi="${mi}" data-ci="${ci}" style="width:150px">${upOpts(c.upstreamId)}</select>
              <input class="rt-input mm-target" data-mi="${mi}" data-ci="${ci}" list="dl-mm-${mi}-${ci}" value="${q(c.targetModel)}" style="width:200px" placeholder="(不改写,留空)" autocomplete="off" />
              <datalist id="dl-mm-${mi}-${ci}">${dlOpts}</datalist>
              <button class="btn btn-small btn-danger" data-mi="${mi}" data-ci-del="${ci}">删</button>
            </div>`;
              })
              .join("")
          : '<div class="rt-empty">无候选,点「+ 候选」添加</div>';

        return `
        <div class="rt-rule">
          <div class="rt-rule-head">
            <span class="muted" style="font-size:11px;">客户端名</span>
            <input class="rt-input mm-client" data-mi="${mi}" value="${q(m.clientModel)}" style="width:200px" placeholder="如 gpt-4o 或 glm-4.6" />
            <span class="muted" style="font-size:11px;">注入模式</span>
            <select class="rt-input mm-mode" data-mi="${mi}" style="width:120px">${modeOpts(m.mode)}</select>
            <button class="btn btn-small" data-mi-up-add="${mi}">+ 候选</button>
            <button class="btn btn-small btn-danger rt-rule-del" data-mi-del="${mi}">删映射</button>
          </div>
          <div class="mm-ups">${upsHtml}</div>
        </div>`;
      })
      .join("");

    // 客户端名
    box.querySelectorAll(".mm-client").forEach((inp) => {
      inp.oninput = () => {
        self.mappings[parseInt(inp.dataset.mi, 10)].clientModel = inp.value;
      };
    });
    // 注入模式（覆盖全局，留空表示用全局）
    box.querySelectorAll(".mm-mode").forEach((sel) => {
      sel.onchange = () => {
        self.mappings[parseInt(sel.dataset.mi, 10)].mode = sel.value;
      };
    });
    // 候选:上游选择(切换后 datalist 要跟随,重渲染)
    box.querySelectorAll(".mm-up-sel").forEach((sel) => {
      sel.onchange = () => {
        const mi = parseInt(sel.dataset.mi, 10);
        const ci = parseInt(sel.dataset.ci, 10);
        self.mappings[mi].upstreams[ci].upstreamId = sel.value;
        self.renderMappings();
      };
    });
    // 候选:真实模型名
    box.querySelectorAll(".mm-target").forEach((inp) => {
      inp.oninput = () => {
        const mi = parseInt(inp.dataset.mi, 10);
        const ci = parseInt(inp.dataset.ci, 10);
        self.mappings[mi].upstreams[ci].targetModel = inp.value;
      };
    });
    // 删候选
    box.querySelectorAll("[data-ci-del]").forEach((b) => {
      b.onclick = () => {
        const mi = parseInt(b.dataset.mi, 10);
        const ci = parseInt(b.dataset.ciDel, 10);
        self.mappings[mi].upstreams.splice(ci, 1);
        self.renderMappings();
      };
    });
    // 加候选
    box.querySelectorAll("[data-mi-up-add]").forEach((b) => {
      b.onclick = () => {
        const mi = parseInt(b.dataset.miUpAdd, 10);
        self.mappings[mi].upstreams.push({
          upstreamId: (self.upstreams[0] && self.upstreams[0].id) || "",
          targetModel: "",
        });
        self.renderMappings();
      };
    });
    // 删映射
    box.querySelectorAll(".rt-rule-del").forEach((b) => {
      b.onclick = () => {
        self.mappings.splice(parseInt(b.dataset.miDel, 10), 1);
        self.renderMappings();
      };
    });
    // 拖拽排序(同一映射内)
    this.bindDnD(box);
  },
  // 拖拽:同一 rt-rule 内的 rt-up-row 排序(数据在 mappings[mi].upstreams)
  bindDnD(box) {
    const self = this;
    let dragEl = null;
    let dragMi = -1;
    box.querySelectorAll(".rt-up-row").forEach((row) => {
      row.addEventListener("dragstart", (e) => {
        dragEl = row;
        dragMi = parseInt(row.dataset.mi, 10);
        row.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragend", () => {
        row.classList.remove("dragging");
        box.querySelectorAll(".rt-up-row").forEach((r) => r.classList.remove("drag-over"));
      });
      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (!dragEl || parseInt(row.dataset.mi, 10) !== dragMi) return;
        if (row === dragEl) return;
        const rect = row.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        box.querySelectorAll(".rt-up-row").forEach((r) => r.classList.remove("drag-over"));
        row.classList.add("drag-over");
        row._after = after;
      });
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        if (!dragEl || parseInt(row.dataset.mi, 10) !== dragMi || row === dragEl) return;
        const fromCi = parseInt(dragEl.dataset.ci, 10);
        let toCi = parseInt(row.dataset.ci, 10);
        const ups = self.mappings[dragMi].upstreams;
        const [moved] = ups.splice(fromCi, 1);
        // 删除后偏移修正
        if (fromCi < toCi) toCi--;
        if (row._after) toCi++;
        ups.splice(toCi, 0, moved);
        self.renderMappings();
      });
    });
  },
  newId() {
    return "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  },
  mmId() {
    return "m_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
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
        modelsPath: "/models",
        apiKey: "",
        models: [],
      });
      self.renderUpstreams();
    };
    $("btn-mm-add").onclick = () => {
      self.mappings.push({
        id: self.mmId(),
        clientModel: "",
        mode: "",
        upstreams: [
          {
            upstreamId: (self.upstreams[0] && self.upstreams[0].id) || "",
            targetModel: "",
          },
        ],
      });
      self.renderMappings();
    };
    const saveOne = async (path, key, list) => {
      // 先不带 force 试
      const r = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: list }),
      });
      if (r.status === 409) {
        // 触发保护:弹确认
        const data = await r.json().catch(() => ({}));
        if (!confirm(data.error || "将清空配置,确认?")) {
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
        await saveOne("/api/upstreams", "upstreams", self.upstreams);
        await saveOne("/api/mappings", "mappings", self.mappings);
        await self.load();
        self.flash("已保存,立即生效");
      } catch (e) {
        if (e.message === "cancel") self.flash("已取消", true);
        else self.flash("保存失败", true);
      }
    };
  },
};
spApp.views.routing.bind();
