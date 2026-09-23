// views/usage.js · 使用记录 · 调用明细 + 模型汇总(参照 sub2api UsageView)
spApp.views = spApp.views || {};

function _uFmtTok(n) {
  if (n == null) return "-";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
function _uFmtMs(v) {
  if (v == null) return "-";
  return v >= 1000 ? (v / 1000).toFixed(2) + " s" : Math.round(v) + " ms";
}
function _uCard(chip, icon, label, value, sub) {
  return `
    <div class="stat-card">
      <div class="sc-top">
        <span class="chip ${chip}">${spApp.icon(icon, 15)}</span>
        <span class="sc-label">${label}</span>
      </div>
      <div class="value">${value}</div>
      <div class="sub">${sub}</div>
    </div>`;
}
function _uTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return sameDay ? hm : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

spApp.views.usage = {
  page: 1,
  range: "all", // today | 7d | all
  status: "", // "" | ok | err
  model: "",
  tab: "detail", // detail | models
  _bound: false,

  onEnter() { this.bindOnce(); this.load(); },
  onState() { if (spApp.currentView === "usage") this.load(); },

  bindOnce() {
    if (this._bound) return;
    this._bound = true;
    const bindSeg = (id, attr, fn) => {
      const seg = $(id);
      if (!seg) return;
      seg.querySelectorAll(".seg-btn").forEach((b) => {
        b.onclick = () => {
          seg.querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("active", x === b));
          fn(b.dataset[attr]);
          this.load();
        };
      });
    };
    bindSeg("uf-range", "range", (v) => { this.range = v; this.page = 1; });
    bindSeg("uf-status", "status", (v) => { this.status = v; this.page = 1; });
    bindSeg("usage-tabs", "tab", (v) => {
      this.tab = v;
      $("usage-detail").style.display = v === "detail" ? "" : "none";
      $("usage-pager").style.display = v === "detail" ? "" : "none";
      $("usage-models").style.display = v === "models" ? "" : "none";
      // 清空按钮跟随 tab:明细清流水,汇总清模型统计
      $("btn-usage-clear").textContent = v === "models" ? "清空汇总" : "清空流水";
    });
    $("uf-model").onchange = () => { this.model = $("uf-model").value; this.page = 1; this.load(); };
    $("btn-usage-refresh").onclick = () => this.load();
    $("btn-usage-clear").onclick = async () => {
      if (this.tab === "models") {
        if (!confirm("清空模型汇总统计(全部口径)?不影响调用流水。")) return;
        await spApp.api.post("/api/model-stats/clear");
      } else {
        if (!confirm("清空全部调用流水?此操作不可恢复。")) return;
        await spApp.api.post("/api/usage/clear");
      }
      this.load();
    };
  },

  async load() {
    // 确保分页参数有效
    const currentPage = Math.max(1, parseInt(this.page, 10) || 1);
    const q = `page=${currentPage}&pageSize=50&range=${this.range}&status=${this.status}&model=${encodeURIComponent(this.model)}`;
    let d;
    try {
      d = await spApp.api.get("/api/usage?" + q);
    } catch {
      return;
    }
    this._data = d;
    // 模型下拉选项(保留当前选择)
    const sel = $("uf-model");
    const cur = sel.value;
    sel.innerHTML =
      `<option value="">全部模型</option>` +
      (d.models || []).map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
    sel.value = cur;
    this.cards(d.stats || {});
    if (this.tab === "detail") this.detail(d);
    else this.models();
    this.pager(d);
  },

  cards(st) {
    const tok = (st.tokIn || 0) + (st.tokOut || 0);
    const errRate = st.count ? ((st.errCount / st.count) * 100).toFixed(1) + "%" : "-";
    $("usage-cards").innerHTML = [
      _uCard("c-blue", "activity", "总请求", st.count || 0, "当前筛选范围内"),
      _uCard("c-amber", "database", "总 Tokens", _uFmtTok(tok), `输入 ${_uFmtTok(st.tokIn)} · 输出 ${_uFmtTok(st.tokOut)} · 缓存 ${_uFmtTok(st.tokCache)}`),
      _uCard("c-purple", "zap", "平均 TTFB", _uFmtMs(st.avgTtfb), `平均总时长 ${_uFmtMs(st.avgTotal)}`),
      _uCard("c-red", "alert", "失败请求", st.errCount || 0, `错误率 ${errRate}`),
    ].join("");
  },

  detail(d) {
    const rows = (d.entries || []);
    if (!rows.length) {
      $("usage-detail").innerHTML = `<p class="muted center" style="padding:24px 0;">暂无调用记录。发一条请求后点「刷新」。</p>`;
      return;
    }
    $("usage-detail").innerHTML = `
      <table class="cap-table usage-table">
        <thead><tr>
          <th>时间</th><th>模型</th><th>上游模型</th><th>上游</th><th>模式</th>
          <th>状态</th><th>TTFB</th><th>总耗时</th><th>输入</th><th>输出</th><th>缓存</th><th>错误信息</th>
        </tr></thead>
        <tbody>${rows.map((e) => {
          const errMsg = e.errMsg || "";
          const errDisplay = errMsg ? `<button class="btn-err-detail" data-seq="${e.seq}">查看错误</button>` : "";
          return `
          <tr>
            <td class="mono nowrap">${_uTime(e.ts)}</td>
            <td class="mono" title="${esc(e.model)}">${esc(e.model || "-")}</td>
            <td class="mono" title="${esc(e.targetModel)}">${esc(e.targetModel || "-")}</td>
            <td class="mono" title="${esc(e.upstream)}">${esc(e.upstream || "-")}</td>
            <td><span class="badge-mode ${esc(e.mode)}">${esc(spApp.modeCn[e.mode] || e.mode || "-")}</span></td>
            <td><span class="badge-st ${e.ok ? "st-ok" : "st-err"}">${e.ok ? "✓ " + e.status : "✗ " + (e.status || "?")}</span></td>
            <td class="mono">${_uFmtMs(e.ttfbMs)}</td>
            <td class="mono">${_uFmtMs(e.totalMs)}</td>
            <td class="mono">${_uFmtTok(e.tokIn)}</td>
            <td class="mono">${_uFmtTok(e.tokOut)}</td>
            <td class="mono">${_uFmtTok((e.tokCacheRead || 0) + (e.tokCacheCreate || 0))}</td>
            <td class="u-err">${errDisplay}</td>
          </tr>`;
        }).join("")}
        </tbody>
      </table>`;

    // 错误内容不从 HTML 属性取(引号会截断 JSON),按 seq 回查原始数据
    $("usage-detail").querySelectorAll(".btn-err-detail").forEach((btn) => {
      const entry = rows.find((r) => String(r.seq) === btn.dataset.seq);
      btn.onclick = () => this.showErrorModal((entry && entry.errMsg) || "");
    });
  },

  showErrorModal(errMsg) {
    // 尝试解析JSON格式的错误信息，如果是JSON则格式化显示
    let displayMsg = errMsg;
    try {
      const parsed = JSON.parse(errMsg);
      displayMsg = JSON.stringify(parsed, null, 2);
    } catch {
      // 如果不是JSON，保持原样
      displayMsg = errMsg;
    }

    // 创建模态框
    const modal = document.createElement("div");
    modal.className = "err-modal";
    
    // 直接设置textContent而不是innerHTML，避免HTML转义问题
    const content = document.createElement("div");
    content.className = "err-modal-content";
    
    const header = document.createElement("div");
    header.className = "err-modal-header";
    header.innerHTML = `<h3>错误详情</h3><button class="err-modal-close">${spApp.icon("close", 13)}</button>`;
    
    const body = document.createElement("div");
    body.className = "err-modal-body";
    
    const pre = document.createElement("pre");
    pre.className = "err-text";
    pre.textContent = displayMsg;  // 使用textContent避免HTML转义
    
    const copyBtn = document.createElement("button");
    copyBtn.className = "btn btn-small btn-copy-err";
    copyBtn.textContent = "复制错误信息";
    
    body.appendChild(pre);
    body.appendChild(copyBtn);
    content.appendChild(header);
    content.appendChild(body);
    modal.appendChild(content);
    document.body.appendChild(modal);

    // 关闭按钮
    modal.querySelector(".err-modal-close").onclick = () => modal.remove();
    modal.querySelector(".err-modal-content").onclick = (e) => e.stopPropagation();

    // 点击背景关闭
    modal.onclick = () => modal.remove();

    // 复制按钮 - 复制原始的错误信息（不是格式化后的）
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(errMsg);
        const originalText = copyBtn.textContent;
        copyBtn.textContent = "✓ 已复制";
        copyBtn.classList.add("copied");
        setTimeout(() => {
          copyBtn.textContent = originalText;
          copyBtn.classList.remove("copied");
        }, 1500);
      } catch {
        copyBtn.textContent = "复制失败";
        setTimeout(() => {
          copyBtn.textContent = "复制错误信息";
        }, 1500);
      }
    };
  },

  // 模型汇总:口径跟随页面时间筛选(今日→today,其余→all)
  async models() {
    let ms = {};
    try {
      ms = await spApp.api.get("/api/model-stats");
    } catch {
      return;
    }
    const bucket = this.range === "today" ? ms.today : ms.all;
    const list = (bucket && bucket.models) || [];
    if (!list.length) {
      $("usage-models").innerHTML = `<p class="muted center" style="padding:24px 0;">暂无数据。</p>`;
      return;
    }
    $("usage-models").innerHTML = `
      <table class="cap-table usage-table">
        <thead><tr>
          <th>模型</th><th>调用</th><th>失败</th><th>输入 Tok</th><th>输出 Tok</th><th>缓存 Tok</th><th>平均 TTFB</th><th>P95</th>
        </tr></thead>
        <tbody>${list.map((m) => `
          <tr>
            <td class="mono" title="${esc(m.model)}">${esc(m.model)}</td>
            <td class="mono">${m.count}</td>
            <td class="mono ${m.err ? "txt-err" : ""}">${m.err || 0}</td>
            <td class="mono">${_uFmtTok(m.tokIn)}</td>
            <td class="mono">${_uFmtTok(m.tokOut)}</td>
            <td class="mono">${_uFmtTok(m.tokCache)}</td>
            <td class="mono">${_uFmtMs(m.avgTtfb)}</td>
            <td class="mono">${_uFmtMs(m.p95Ttfb)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
      <p class="hint">口径:${this.range === "today" ? "今日" : "累计"} · 共 ${(bucket.total || 0)} 次调用</p>`;
  },

  pager(d) {
    if (this.tab !== "detail") {
      $("usage-pager").innerHTML = "";
      return;
    }
    const btn = (label, target, dis) =>
      `<button class="btn btn-small" data-p="${target}" ${dis ? "disabled" : ""}>${label}</button>`;
    
    // 确保分页信息有效
    const currentPage = Math.max(1, Math.min(d.page || 1, d.pages || 1));
    const totalPages = Math.max(1, d.pages || 1);
    const totalRecords = d.total || 0;
    
    $("usage-pager").innerHTML = `
      ${btn("« 上一页", currentPage - 1, currentPage <= 1)}
      <span class="pg-info">第 ${currentPage} / ${totalPages} 页 · 共 ${totalRecords} 条</span>
      ${btn("下一页 »", currentPage + 1, currentPage >= totalPages)}`;
    $("usage-pager").querySelectorAll("button[data-p]").forEach((b) => {
      b.onclick = () => {
        const targetPage = parseInt(b.dataset.p, 10);
        if (targetPage > 0 && targetPage <= totalPages) {
          this.page = targetPage;
          this.load();
        }
      };
    });
  },
};
