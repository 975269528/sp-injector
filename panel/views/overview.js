// views/overview.js · 概览视图 · sub2api 风格统计卡 + 日期区间 + 24h柱状图 + 模型波浪趋势图
spApp.views = spApp.views || {};

function _fmtTok(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
function _fmtMs(v) {
  if (v == null) return "-";
  return v >= 1000 ? (v / 1000).toFixed(2) + " s" : Math.round(v) + " ms";
}
// 模型名 hash → 色相:同一模型永远同色(浅色版:更饱和更深,白底上可读)
function _hueOf(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
function _hueCss(name) {
  const dark = document.documentElement.dataset.theme === "dark";
  return `hsl(${_hueOf(name)},${dark ? 60 : 70}%,${dark ? 62 : 45}%)`;
}
// 统计卡:彩色浅底图标 + 标签 + 大数字 + 副行
function _statCard(chip, icon, label, value, sub) {
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
function _isoDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

spApp.views.overview = {
  from: _isoDate(new Date()), // 日期区间(含两端),默认今日
  to: _isoDate(new Date()),
  metric: "tok", // 波浪图指标: count | tok
  hidden: {}, // 波浪图图例点击隐藏的模型
  waveData: null,
  _bound: false,

  onEnter() { this.bindOnce(); this.render(); },
  onState() { if (spApp.currentView === "overview") this.render(); },

  bindOnce() {
    if (this._bound) return;
    this._bound = true;
    const presetBtns = $("ov-presets").querySelectorAll(".seg-btn");
    presetBtns.forEach((b) => {
      b.onclick = () => {
        presetBtns.forEach((x) => x.classList.toggle("active", x === b));
        this.applyPreset(b.dataset.p);
        this.render();
      };
    });
    $("ov-from").onchange = () => { this.from = $("ov-from").value || this.from; this.render(); };
    $("ov-to").onchange = () => { this.to = $("ov-to").value || this.to; this.render(); };
    const metricBtns = $("wave-metric").querySelectorAll(".seg-btn");
    metricBtns.forEach((b) => {
      b.onclick = () => {
        metricBtns.forEach((x) => x.classList.toggle("active", x === b));
        this.metric = b.dataset.m;
        this.renderWave();
      };
    });
    $("btn-ov-clear").onclick = async () => {
      if (!confirm("清空全部统计数据?概览卡片、趋势图与使用记录流水都会归零,不可恢复。")) return;
      await spApp.api.post("/api/model-stats/clear");
      await spApp.api.post("/api/usage/clear");
      this.hidden = {};
      this.render();
    };
    // 初始化输入框
    $("ov-from").value = this.from;
    $("ov-to").value = this.to;
  },

  applyPreset(p) {
    const now = new Date();
    this.to = _isoDate(now);
    if (p === "today") this.from = this.to;
    else if (p === "7d") this.from = _isoDate(new Date(now.getTime() - 6 * 86400 * 1000));
    else if (p === "30d") this.from = _isoDate(new Date(now.getTime() - 29 * 86400 * 1000));
    $("ov-from").value = this.from;
    $("ov-to").value = this.to;
  },

  async render() {
    const s = spApp.state || {};
    const st = s.stats || {};
    const cap = await spApp.api.get("/api/captures").catch(() => ({ stats: {} }));
    const cs = cap.stats || {};
    let ms = { today: {}, all: {}, rpm: 0, tpm: 0, custom: null };
    try {
      ms = await spApp.api.get(`/api/model-stats?from=${this.from}&to=${this.to}`);
    } catch {}
    const td = ms.today || {};
    const al = ms.all || {};
    // 区间口径:有 custom 用 custom,否则退回今日
    const rg = ms.custom || td;
    const rgLabel = ms.custom ? `${this.from} ~ ${this.to}` : "今日";
    const tokRg = (rg.tokIn || 0) + (rg.tokOut || 0);
    const tokAll = (al.tokIn || 0) + (al.tokOut || 0);
    const rgErr = rg.models ? rg.models.reduce((a, m) => a + (m.err || 0), 0) : 0;
    const okRate = rg.total ? Math.round(((rg.total - rgErr) / rg.total) * 100) : null;
    const injRate = st.totalRequests ? Math.round(((st.injected || 0) / st.totalRequests) * 100) : 0;

    $("stat-grid").innerHTML = [
      _statCard("c-blue", "activity", "区间请求", rg.total || 0, `${esc(rgLabel)} · 累计 ${al.total || 0}`),
      _statCard("c-amber", "database", "区间 Tokens", _fmtTok(tokRg), `输入 ${_fmtTok(rg.tokIn)} · 输出 ${_fmtTok(rg.tokOut)} · 缓存 ${_fmtTok(rg.tokCache)}`),
      _statCard("c-purple", "zap", "平均响应 TTFB", _fmtMs(rg.avgTtfb), `P95 ${_fmtMs(rg.p95Ttfb)}`),
      _statCard("c-red", "alert", "区间失败", rgErr, okRate == null ? "暂无调用" : `成功率 ${okRate}%`),
      _statCard("c-cyan", "trend", "每分钟请求 RPM", ms.rpm || 0, `TPM ${_fmtTok(ms.tpm)}(实时)`),
      _statCard("c-green", "inject", "已注入", st.injected || 0, `注入率 ${injRate}%`),
      _statCard("c-gray", "shield", "官方透传", cs.official || 0, `总请求 ${st.totalRequests || 0}`),
      _statCard("c-indigo", "layers", "累计 Tokens", _fmtTok(tokAll), `输入 ${_fmtTok(al.tokIn)} · 输出 ${_fmtTok(al.tokOut)} · 缓存 ${_fmtTok(al.tokCache)}`),
    ].join("");

    // 状态 KV
    const at = s.activeTemplates || [];
    const keep = s.sectionsKeep || [];
    const ups = s.upstreamCount != null ? s.upstreamCount : 0;
    const mms = s.mappingCount != null ? s.mappingCount : 0;
    const modeCn = spApp.modeCn[s.mode] || s.mode || "-";
    const fmtCn = spApp.fmtCn[s.format] || s.format || "-";
    $("overview-state").innerHTML = `
      <div class="row"><div class="k">注入模式</div><div class="v"><span class="badge-mode ${esc(s.mode || "")}">${esc(modeCn)}</span></div></div>
      <div class="row"><div class="k">接口格式</div><div class="v">${esc(fmtCn)}</div></div>
      <div class="row"><div class="k">激活模板</div><div class="v">${at.length ? esc(at.join(" + ")) : "(无)"}</div></div>
      <div class="row"><div class="k">保留章节</div><div class="v">${keep.length ? keep.length + " 个" : "(无)"}</div></div>
      <div class="row"><div class="k">上游/映射</div><div class="v">${ups} 上游 / ${mms} 映射</div></div>
      <div class="row"><div class="k">Scripture 头</div><div class="v">${s.useHeader ? "开" : "关"}</div></div>
      <div class="row"><div class="k">抓取</div><div class="v">${s.captureOn !== false ? "开" : "关"}</div></div>
    `;

    // 近 24 小时柱状趋势
    let hours = [];
    try {
      const tr = await spApp.api.get("/api/model-stats/trend");
      hours = tr.hours || [];
    } catch {}
    this.trend(hours);

    // 波浪图
    this.loadWave();
  },

  // 24 根柱的柱状图:悬停看该小时调用与 token
  trend(hours) {
    const sum = hours.reduce((a, h) => a + (h.count || 0), 0);
    $("trend-sum").textContent = `24h 共 ${sum} 次`;
    if (!sum) {
      $("ov-trend").innerHTML = `<div class="chart-empty">暂无调用数据<br><span class="muted">发一条请求后,这里会出现趋势柱状图</span></div>`;
      return;
    }
    const W = 720, H = 170, PAD_B = 22, PAD_T = 8;
    const max = Math.max(...hours.map((h) => h.count || 0), 1);
    const bw = W / hours.length;
    const bars = hours
      .map((h, i) => {
        const bh = Math.max(((h.count || 0) / max) * (H - PAD_B - PAD_T), h.count ? 3 : 0);
        const x = i * bw + bw * 0.18;
        const y = H - PAD_B - bh;
        const cur = i === hours.length - 1;
        const lab = i % 4 === 0 || cur;
        return `
          <g>
            <title>${esc(h.label)} · ${h.count} 次 · in ${_fmtTok(h.tokIn)} / out ${_fmtTok(h.tokOut)}</title>
            <rect x="${x}" y="${y}" width="${bw * 0.64}" height="${bh}" rx="3"
              class="tr-bar ${cur ? "cur" : ""}"/>
            ${lab ? `<text x="${i * bw + bw / 2}" y="${H - 6}" class="tr-lab">${esc(h.label)}</text>` : ""}
          </g>`;
      })
      .join("");
    $("ov-trend").innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="trend" preserveAspectRatio="none">${bars}</svg>`;
  },

  // ── 波浪图:每模型一条平滑曲线,悬停显示该时段所有模型用量 ──
  async loadWave() {
    const fromTs = new Date(this.from + "T00:00:00").getTime();
    const toTs = new Date(this.to + "T23:59:59").getTime();
    let d = null;
    try {
      d = await spApp.api.get(`/api/usage/trend?fromTs=${fromTs}&toTs=${toTs}`);
    } catch {}
    this.waveData = d;
    this.renderWave();
  },

  renderWave() {
    const d = this.waveData;
    const box = $("wave-box");
    if (!d || !d.buckets || !d.buckets.length) {
      $("wave-legend").innerHTML = "";
      box.innerHTML = `<div class="chart-empty">暂无调用数据</div>`;
      return;
    }
    const buckets = d.buckets;
    const val = (v) => (this.metric === "count" ? v.count : v.tokIn + v.tokOut);
    const valLabel = this.metric === "count" ? "次" : "tok";

    // 模型总量排序,取前 8 条画线
    const totals = {};
    let hasAny = false;
    for (const b of buckets) {
      for (const [m, v] of Object.entries(b.models)) {
        const t = totals[m] || (totals[m] = { count: 0, tok: 0 });
        t.count += v.count;
        t.tok += v.tokIn + v.tokOut;
        hasAny = true;
      }
    }
    const allModels = Object.entries(totals)
      .sort((a, b) => b[1].tok + b[1].count - (a[1].tok + a[1].count))
      .map(([m]) => m);
    const shown = allModels.slice(0, 8).filter((m) => !this.hidden[m]);
    if (!hasAny) {
      $("wave-legend").innerHTML = "";
      box.innerHTML = `<div class="chart-empty">暂无调用数据<br><span class="muted">该时间段内没有请求经过代理</span></div>`;
      return;
    }

    // 图例(点击切换显隐)
    $("wave-legend").innerHTML = allModels
      .slice(0, 8)
      .map(
        (m) => `
        <span class="wl-item ${this.hidden[m] ? "off" : ""}" data-m="${esc(m)}">
          <i class="wl-dot" style="background:${_hueCss(m)}"></i>${esc(m)}
        </span>`,
      )
      .join("");
    $("wave-legend").querySelectorAll(".wl-item").forEach((el) => {
      el.onclick = () => {
        const m = el.dataset.m;
        if (this.hidden[m]) delete this.hidden[m];
        else this.hidden[m] = true;
        this.renderWave();
      };
    });

    // 坐标系
    const W = 1000, H = 250, PL = 46, PR = 14, PT = 12, PB = 26;
    const iw = W - PL - PR, ih = H - PT - PB;
    const n = buckets.length;
    const xAt = (i) => PL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
    let max = 1;
    for (const b of buckets)
      for (const m of shown) {
        const v = b.models[m];
        if (v) max = Math.max(max, val(v));
      }
    const yAt = (v) => PT + ih - (v / max) * ih;

    // 横向网格 + Y 轴刻度
    let grid = "";
    for (let g = 0; g <= 4; g++) {
      const y = PT + (ih * g) / 4;
      const v = max - ((max - 0) * g) / 4;
      grid += `<line x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}" class="wv-grid"/>`;
      grid += `<text x="${PL - 6}" y="${y + 3}" class="wv-tick" text-anchor="end">${this.metric === "count" ? Math.round(v) : _fmtTok(v)}</text>`;
    }
    // X 轴标签(最多 8 个)
    const stepLab = Math.max(1, Math.ceil(n / 8));
    let xlabels = "";
    buckets.forEach((b, i) => {
      if (i % stepLab === 0 || i === n - 1) {
        xlabels += `<text x="${xAt(i)}" y="${H - 6}" class="wv-tick" text-anchor="middle">${esc(b.label)}</text>`;
      }
    });

    // 平滑曲线(中点二次贝塞尔)
    const pathFor = (m) => {
      const pts = buckets.map((b, i) => [xAt(i), yAt(b.models[m] ? val(b.models[m]) : 0)]);
      if (pts.length === 1) return `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
      let dstr = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
      for (let i = 1; i < pts.length; i++) {
        const mx = (pts[i - 1][0] + pts[i][0]) / 2;
        const my = (pts[i - 1][1] + pts[i][1]) / 2;
        dstr += ` Q ${pts[i - 1][0].toFixed(1)} ${pts[i - 1][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
      }
      dstr += ` T ${pts[pts.length - 1][0].toFixed(1)} ${pts[pts.length - 1][1].toFixed(1)}`;
      return dstr;
    };
    const lines = shown
      .map((m, i) => {
        const dstr = pathFor(m);
        // 面积填充(很淡)增强波浪观感
        const area = `${dstr} L ${xAt(n - 1)} ${PT + ih} L ${xAt(0)} ${PT + ih} Z`;
        return `
          <path d="${area}" fill="${_hueCss(m)}" opacity="0.07"/>
          <path d="${dstr}" fill="none" stroke="${_hueCss(m)}" stroke-width="2"
            class="wv-line" vector-effect="non-scaling-stroke" data-m="${esc(m)}"/>`;
      })
      .join("");

    box.innerHTML = `
      <svg id="wave-svg" viewBox="0 0 ${W} ${H}" class="wave-svg" preserveAspectRatio="none">
        ${grid}${xlabels}${lines}
        <line id="wave-guide" x1="0" y1="${PT}" x2="0" y2="${PT + ih}" class="wv-guide" style="display:none"/>
        <rect x="${PL}" y="${PT}" width="${iw}" height="${ih}" fill="transparent" id="wave-hit"/>
      </svg>
      <div id="wave-tip" class="wave-tip" style="display:none;"></div>`;

    // 悬停:最近桶的竖线 + tooltip 列出该时段所有模型用量
    const svg = $("wave-svg");
    const tip = $("wave-tip");
    const guide = $("wave-guide");
    svg.addEventListener("mousemove", (ev) => {
      const rect = svg.getBoundingClientRect();
      const vx = ((ev.clientX - rect.left) / rect.width) * W;
      if (vx < PL - 4 || vx > W - PR + 4) {
        tip.style.display = "none";
        guide.style.display = "none";
        return;
      }
      const i = Math.max(0, Math.min(n - 1, Math.round(((vx - PL) / iw) * (n - 1))));
      guide.setAttribute("x1", xAt(i));
      guide.setAttribute("x2", xAt(i));
      guide.style.display = "";
      const b = buckets[i];
      const rows = Object.entries(b.models)
        .sort((a, c) => val(c[1]) - val(a[1]))
        .map(
          ([m, v]) => `
            <div class="wt-row">
              <i class="wt-dot" style="background:${_hueCss(m)}"></i>
              <span class="wt-name" title="${esc(m)}">${esc(m)}</span>
              <span class="wt-val">${v.count} 次 · ${_fmtTok(v.tokIn + v.tokOut)} ${valLabel === "次" ? "" : "tok"}</span>
            </div>`,
        )
        .join("");
      tip.innerHTML = `<div class="wt-time">${esc(b.label)}</div>${rows || '<div class="muted">无调用</div>'}`;
      tip.style.display = "";
      const boxRect = box.getBoundingClientRect();
      const relX = ev.clientX - boxRect.left;
      const relY = ev.clientY - boxRect.top;
      const tw = tip.offsetWidth || 260;
      tip.style.left = Math.max(4, Math.min(relX + 14, boxRect.width - tw - 8)) + "px";
      tip.style.top = Math.max(4, relY - tip.offsetHeight - 12) + "px";
    });
    svg.addEventListener("mouseleave", () => {
      tip.style.display = "none";
      guide.style.display = "none";
    });
  },
};
