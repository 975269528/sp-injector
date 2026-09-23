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
  // ── 上游池卡片(modelsPath 不再暴露 UI,默认 /models) ──────────
  renderUpstreams() {
    const self = this;
    const box = $("up-cards");
    if (!this.upstreams.length) {
      box.innerHTML = '<div class="rt-empty" style="grid-column:span 2;">暂无上游。点「+ 添加上游」。</div>';
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
    box.innerHTML = this.upstreams
      .map((u, i) => {
        const models = Array.isArray(u.models) ? u.models : [];
        const modelHtml = models.length
          ? `<span class="um-count">${models.length}</span> 个
             <div class="um-tags">${models
               .map((m) => `<span class="um-tag" title="${q(m && m.name)}">${q(m && m.name)}</span>`)
               .join("")}</div>`
          : `<span class="um-empty">(未拉取,点「拉取」自动获取)</span>`;
        return `
      <div class="up-card" data-card="${i}">
        <div class="up-card-head">
          <input class="rt-input up-name" data-u="${i}" data-k="name" value="${q(u.name)}" placeholder="上游名称" />
          <button class="btn btn-small" data-fetch="${i}">${spApp.icon("refresh", 12)}拉取</button>
          <button class="btn btn-small btn-danger" data-u-del="${i}">${spApp.icon("trash", 12)}删除</button>
        </div>
        <div class="up-card-grid">
          <label class="span2">域名<input class="rt-input" data-u="${i}" data-k="host" value="${q(u.host)}" placeholder="api.example.com" /></label>
          <label>端口<input class="rt-input" data-u="${i}" data-k="port" value="${q(u.port == null ? 443 : u.port)}" /></label>
          <label>出站代理<select class="rt-input rt-proxy" data-u="${i}" data-k="useProxy">${proxyOpts(u.useProxy || "direct")}</select></label>
          <label class="span2">路径前缀<input class="rt-input" data-u="${i}" data-k="pathPrefix" value="${q(u.pathPrefix)}" placeholder="如 /api/v3" /></label>
          <label class="span2">API Key<input class="rt-input" data-u="${i}" data-k="apiKey" value="${q(u.apiKey)}" placeholder="sk-..." type="password" /></label>
        </div>
        <div class="up-card-models">模型 ${modelHtml}</div>
      </div>`;
      })
      .join("");

    // 普通输入(除代理模式 select 外)
    box.querySelectorAll(".rt-input[data-u]:not(.rt-proxy)").forEach((inp) => {
      inp.oninput = () => {
        const i = parseInt(inp.dataset.u, 10);
        self.upstreams[i][inp.dataset.k] = inp.value;
      };
    });
    // 代理模式(写入 useProxy 字段)
    box.querySelectorAll(".rt-proxy").forEach((sel) => {
      sel.onchange = () => {
        const i = parseInt(sel.dataset.u, 10);
        self.upstreams[i].useProxy = sel.value;
      };
    });
    // 删除上游
    box.querySelectorAll("[data-u-del]").forEach((b) => {
      b.onclick = () => {
        self.upstreams.splice(parseInt(b.dataset.uDel, 10), 1);
        self.renderUpstreams();
      };
    });
    // 拉取模型
    box.querySelectorAll("[data-fetch]").forEach((b) => {
      b.onclick = async () => {
        const i = parseInt(b.dataset.fetch, 10);
        const up = self.upstreams[i];
        if (!up || !up.id) {
          self.flash("上游缺少 id,请先保存", true);
          return;
        }
        const oldHtml = b.innerHTML;
        b.disabled = true;
        b.innerHTML = spApp.icon("refresh", 12) + "拉取中...";
        try {
          const r = await spApp.api.post(
            "/api/upstreams/" + encodeURIComponent(up.id) + "/fetch-models",
          );
          if (r && r.error) throw new Error(r.error);
          self.flash("拉取到 " + r.count + " 个模型");
          await self.load(); // 后端已写回 models,重新加载
        } catch (e) {
          self.flash("拉取失败: " + (e.message || ""), true);
        } finally {
          b.disabled = false;
          b.innerHTML = oldHtml;
        }
      };
    });
  },
  // ── 模型映射(折叠式:一行摘要,点击展开编辑) ──────────────────
  // 摘要目标串:候选1 → targetModel@上游名 / 候选2 ...
  _sumTargets(m) {
    const ups = Array.isArray(m.upstreams) ? m.upstreams : [];
    if (!ups.length) return "(无候选)";
    return ups
      .map((c) => {
        const up = this.upstreams.find((u) => u.id === c.upstreamId);
        const upName = (up && up.name) || c.upstreamId || "?";
        const tm = c.targetModel ? c.targetModel : "(原名)";
        return esc(tm) + '<span class="sep">@</span>' + esc(upName);
      })
      .join('<span class="sep">/</span>');
  },
  renderMappings() {
    const self = this;
    const box = $("mm-list");
    if (!this.mappings.length) {
      box.innerHTML = '<div class="rt-empty">暂无映射。点「+ 添加映射」。</div>';
      return;
    }
    this._expanded = this._expanded || {};
    const q = (s) => esc(String(s == null ? "" : s)).replace(/"/g, "&quot;");
    const MODE_LABELS = { "": "全局", replace: "替换", prepend: "前置", official: "原样透传", keepSections: "保留章节" };
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
        const open = !!this._expanded[m.id];
        const modeVal = m.mode || "";
        const modeBadge = modeVal
          ? `<span class="badge-mode ${modeVal}">${MODE_LABELS[modeVal]}</span>`
          : `<span class="badge-mode">全局模式</span>`;
        // 注入模式下拉:留空(全局) + 四种模式(value 保留英文供后端校验)
        const modeOpts = (val) =>
          ["", "replace", "prepend", "official", "keepSections"]
            .map((o) => `<option value="${o}"${o === (val || "") ? " selected" : ""}>${MODE_LABELS[o] || o}</option>`)
            .join("");
        const ups = Array.isArray(m.upstreams) ? m.upstreams : [];
        const upsHtml = ups.length
          ? ups
              .map((c, ci) => {
                const names = modelNamesOf(c.upstreamId);
                const dlOpts = names.map((n) => `<option value="${q(n)}">`).join("");
                return `
            <div class="rt-up-row" draggable="true" data-mi="${mi}" data-ci="${ci}">
              <span class="rt-drag" title="拖拽排序">${spApp.icon("grip", 14)}</span>
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
        <div class="rt-rule ${open ? "open" : ""}" data-mid="${q(m.id)}">
          <div class="rt-rule-sum" data-toggle="${q(m.id)}" title="点击展开/收起编辑">
            <span class="rt-sum-chev">${spApp.icon("chevron", 13)}</span>
            <span class="rt-sum-client">${q(m.clientModel) || "(未命名)"}</span>
            ${modeBadge}
            <span class="rt-sum-targets">${this._sumTargets(m)}</span>
          </div>
          <div class="rt-rule-body">
            <div class="rt-rule-head">
              <span class="muted" style="font-size:11px;">客户端名</span>
              <input class="rt-input mm-client" data-mi="${mi}" value="${q(m.clientModel)}" style="width:200px" placeholder="如 gpt-4o 或 glm-4.6" />
              <span class="muted" style="font-size:11px;">注入模式</span>
              <select class="rt-input mm-mode" data-mi="${mi}" style="width:120px">${modeOpts(m.mode)}</select>
              <button class="btn btn-small" data-mi-up-add="${mi}">+ 候选</button>
              <button class="btn btn-small btn-danger rt-rule-del" data-mi-del="${mi}">删映射</button>
            </div>
            <div class="mm-ups">${upsHtml}</div>
          </div>
        </div>`;
      })
      .join("");

    // 摘要行:点击展开/收起(不重渲染,只切 class)
    box.querySelectorAll(".rt-rule-sum").forEach((sum) => {
      sum.onclick = (e) => {
        if (e.target.closest("button, input, select")) return; // 按钮区不触发
        const rule = sum.closest(".rt-rule");
        const mid = sum.dataset.toggle;
        const nowOpen = rule.classList.toggle("open");
        if (nowOpen) self._expanded[mid] = true;
        else delete self._expanded[mid];
      };
    });
    // 客户端名(编辑时同步摘要行)
    box.querySelectorAll(".mm-client").forEach((inp) => {
      inp.oninput = () => {
        const mi = parseInt(inp.dataset.mi, 10);
        self.mappings[mi].clientModel = inp.value;
        const rule = inp.closest(".rt-rule");
        const sc = rule.querySelector(".rt-sum-client");
        if (sc) sc.textContent = inp.value || "(未命名)";
      };
    });
    // 注入模式(覆盖全局,留空表示用全局;同步摘要徽章)
    box.querySelectorAll(".mm-mode").forEach((sel) => {
      sel.onchange = () => {
        const mi = parseInt(sel.dataset.mi, 10);
        self.mappings[mi].mode = sel.value;
        self.renderMappings(); // 徽章样式随模式变化,整体重渲染最稳
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
    // 候选:真实模型名(编辑时同步摘要)
    box.querySelectorAll(".mm-target").forEach((inp) => {
      inp.oninput = () => {
        const mi = parseInt(inp.dataset.mi, 10);
        const ci = parseInt(inp.dataset.ci, 10);
        self.mappings[mi].upstreams[ci].targetModel = inp.value;
        const rule = inp.closest(".rt-rule");
        const st = rule.querySelector(".rt-sum-targets");
        if (st) st.innerHTML = self._sumTargets(self.mappings[mi]);
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
        const mi = parseInt(b.dataset.miDel, 10);
        delete self._expanded[self.mappings[mi].id];
        self.mappings.splice(mi, 1);
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
      const m = {
        id: self.mmId(),
        clientModel: "",
        mode: "",
        upstreams: [
          {
            upstreamId: (self.upstreams[0] && self.upstreams[0].id) || "",
            targetModel: "",
          },
        ],
      };
      self._expanded = self._expanded || {};
      self._expanded[m.id] = true; // 新映射自动展开,直接可编辑
      self.mappings.push(m);
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
