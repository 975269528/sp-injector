// views/overview.js · 概览视图
spApp.views = spApp.views || {};
spApp.views.overview = {
  onEnter() { this.render(); },
  onState() { if (spApp.currentView === "overview") this.render(); },
  async render() {
    const s = spApp.state;
    const st = s.stats || {};
    // 统计卡
    const cap = await spApp.api.get("/api/captures").catch(() => ({ stats: {} }));
    const cs = cap.stats || {};
    $("stat-grid").innerHTML = `
      <div class="stat-card"><div class="label">总请求</div><div class="value">${st.totalRequests || 0}</div></div>
      <div class="stat-card ok"><div class="label">已注入</div><div class="value">${st.injected || 0}</div></div>
      <div class="stat-card muted"><div class="label">官方透传</div><div class="value">${cs.official || 0}</div></div>
      <div class="stat-card warn"><div class="label">System 抓取</div><div class="value">${cs.buffered || 0}</div></div>
    `;
    // 状态 KV
    const at = s.activeTemplates || [];
    const keep = s.sectionsKeep || [];
    const rt = await spApp.api.get("/api/routing").catch(() => ({ upstreams: [], routes: [] }));
    const upCount = (rt.upstreams || []).length;
    const routeCount = (rt.routes || []).length;
    $("overview-state").innerHTML = `
      <div class="row"><div class="k">注入模式</div><div class="v">${s.mode || "-"}</div></div>
      <div class="row"><div class="k">接口格式</div><div class="v">${s.format || "-"}</div></div>
      <div class="row"><div class="k">激活模板</div><div class="v">${at.length ? at.join(" + ") : "(无)"}</div></div>
      <div class="row"><div class="k">保留章节</div><div class="v">${keep.length ? keep.length + " 个" : "(无)"}</div></div>
      <div class="row"><div class="k">路由配置</div><div class="v">${upCount} 上游 / ${routeCount} 规则</div></div>
      <div class="row"><div class="k">Scripture 头</div><div class="v">${s.useHeader ? "开" : "关"}</div></div>
    `;
  },
};
