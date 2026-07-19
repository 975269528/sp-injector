// app.js · 入口 · 路由 + 全局状态 + 初始化
spApp.state = {};
spApp.currentView = "overview";
spApp.viewTimers = {};
// $ 和 esc 已在 api.js 定义（最先加载），此处直接复用

// ── 导航 ──
spApp.navigate = function (view) {
  if (spApp.currentView === view) return;
  // onLeave：停掉当前视图的轮询
  const prev = spApp.views[spApp.currentView];
  if (prev && prev.onLeave) prev.onLeave();
  if (spApp.viewTimers[spApp.currentView]) {
    clearInterval(spApp.viewTimers[spApp.currentView]);
    delete spApp.viewTimers[spApp.currentView];
  }
  // 切换
  spApp.currentView = view;
  document.querySelectorAll(".nav-item").forEach((n) => {
    n.classList.toggle("active", n.dataset.view === view);
  });
  document.querySelectorAll(".view").forEach((v) => {
    v.classList.toggle("active", v.id === "view-" + view);
  });
  // onEnter
  const next = spApp.views[view];
  if (next && next.onEnter) next.onEnter();
};

// ── 全局状态 ──
spApp.loadState = async function () {
  try {
    spApp.state = await spApp.api.get("/api/state");
  } catch (e) {
    $("run-dot").style.background = "var(--danger)";
    $("run-text").textContent = "未连接";
    return;
  }
  const s = spApp.state;
  $("run-dot").style.background = "var(--ok)";
  $("run-text").textContent = "运行中";
  // 各视图如果实现了 onState，通知它
  for (const name in spApp.views) {
    if (spApp.views[name].onState) {
      try { spApp.views[name].onState(s); } catch {}
    }
  }
};

// ── 代理地址 ──
function fillAddr() {
  const panelOrigin = location.origin;
  const panelPort = parseInt(location.port || "8088", 10);
  const proxyPort = panelPort - 8;
  $("addr-proxy").textContent = `${location.protocol}//${location.hostname}:${proxyPort}`;
}
$("btn-copy-addr").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("addr-proxy").textContent);
    const btn = $("btn-copy-addr");
    const old = btn.textContent;
    btn.textContent = "已复制 ✓";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = old; btn.classList.remove("copied"); }, 1500);
  } catch {}
};

// ── 导航绑定 ──
document.querySelectorAll(".nav-item").forEach((n) => {
  n.onclick = () => spApp.navigate(n.dataset.view);
});

// ── 初始化 ──
(async () => {
  fillAddr();
  // settings 视图（纯运行信息，注入/路由状态在各专属视图看）
  spApp.views.settings = {
    onEnter() {
      const s = spApp.state || {};
      $("settings-info").innerHTML = `
        <div class="row"><div class="k">面板端口</div><div class="v">${location.port || 8088}</div></div>
        <div class="row"><div class="k">代理端口</div><div class="v">${(parseInt(location.port||"8088",10)-8)||8080}</div></div>
        <div class="row"><div class="k">运行状态</div><div class="v">${s.stats ? "运行中" : "未知"}</div></div>
        <div class="row"><div class="k">出站网络</div><div class="v">${s.effective_proxy || "直连"}</div></div>
        <div class="row"><div class="k">版本</div><div class="v">sp-injector v2.0</div></div>
      `;
    },
  };
  await spApp.loadState();
  // 进入默认视图
  if (spApp.views.overview && spApp.views.overview.onEnter) spApp.views.overview.onEnter();
  // 后台轮询全局状态
  setInterval(spApp.loadState, 8000);
})();
