// app.js · 入口 · 路由 + 全局状态 + 初始化
spApp.state = {};
spApp.currentView = "overview";
spApp.viewTimers = {};
// $ 和 esc 已在 api.js 定义（最先加载），此处直接复用
// 模式/格式的中文显示
spApp.modeCn = { replace: "替换", prepend: "前置", keepSections: "保留章节", official: "官方" };
spApp.fmtCn = { anthropic: "Anthropic", openai: "OpenAI", responses: "Responses" };

// ── 深浅主题切换(顶栏右上,localStorage 记忆) ──
spApp.applyTheme = function (theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("sp-theme", theme);
  const btn = $("btn-theme");
  if (btn) btn.innerHTML = spApp.icon(theme === "dark" ? "sun" : "moon", 15);
};
(function () {
  const btn = $("btn-theme");
  if (!btn) return;
  const init = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  spApp.applyTheme(init);
  btn.onclick = () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    spApp.applyTheme(next);
    // 波浪图折线颜色依赖主题,就地重绘(用缓存数据,不重拉接口)
    const ov = spApp.views.overview;
    if (spApp.currentView === "overview" && ov && ov.waveData) ov.renderWave();
  };
})();

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
  // 同步地址栏 hash,刷新后据此恢复视图(replaceState 不产生历史记录)
  if (location.hash !== "#" + view) history.replaceState(null, "", "#" + view);
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
  renderSideStatus(s);
  // 各视图如果实现了 onState，通知它
  for (const name in spApp.views) {
    if (spApp.views[name].onState) {
      try { spApp.views[name].onState(s); } catch {}
    }
  }
};

// ── 侧栏底部状态速览:模式/格式/抓取,点击跳对应视图 ──
function renderSideStatus(s) {
  const box = $("side-status");
  if (!box) return;
  const modeCn = spApp.modeCn[s.mode] || s.mode || "-";
  const tpls = s.activeTemplates || [];
  box.innerHTML = `
    <div class="ss-row" data-goto="upstream" title="点击去「注入」页调整">
      <span class="k">${spApp.icon("inject", 12)}模式</span><span class="v">${esc(modeCn)}</span>
    </div>
    <div class="ss-row" data-goto="upstream">
      <span class="k">${spApp.icon("routing", 12)}格式</span><span class="v">${esc(spApp.fmtCn[s.format] || s.format || "-")}</span>
    </div>
    <div class="ss-row" data-goto="templates" title="点击去「模板」页">
      <span class="k">${spApp.icon("templates", 12)}模板</span>
      <span class="v">${tpls.length ? esc(tpls.length + " 个") : "无"}</span>
    </div>
    <div class="ss-row" data-goto="upstream">
      <span class="k">${spApp.icon("captures", 12)}抓取</span>
      <span class="v ${s.captureOn !== false ? "on" : "off"}">${s.captureOn !== false ? "开" : "关"}</span>
    </div>`;
  box.querySelectorAll(".ss-row").forEach((r) => {
    r.onclick = () => spApp.navigate(r.dataset.goto);
  });
}

// ── 全局 toast(右上角滑入,替代闪现文本) ──
spApp.toast = function (msg, type) {
  document.querySelectorAll(".sp-toast").forEach((t) => t.remove());
  const el = document.createElement("div");
  el.className = "sp-toast " + (type === "err" ? "t-err" : "t-ok");
  el.innerHTML = spApp.icon(type === "err" ? "alert" : "check", 14) + "<span></span>";
  el.querySelector("span").textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => {
    el.classList.add("t-out");
    setTimeout(() => el.remove(), 300);
  }, 2200);
};

// ── 代理地址:桌面模式读注入的动态端口,浏览器直开时回退"面板端口-8" ──
function fillAddr() {
  const desk = window.spDesktop;
  const proxyPort = desk && desk.proxyPort ? desk.proxyPort : parseInt(location.port || "8088", 10) - 8;
  $("addr-proxy").textContent = `${location.protocol}//${location.hostname}:${proxyPort}`;
  if (desk && desk.version) {
    $("app-ver").textContent = "v" + desk.version;
  }
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
// 地址栏 hash 被外部改变(手动改 URL 等)时同步切换视图;
// navigate 内部用 replaceState 改 hash 不会触发本事件,无循环风险
window.addEventListener("hashchange", () => {
  const v = (location.hash || "").replace(/^#/, "");
  if (spApp.views[v] && v !== spApp.currentView) spApp.navigate(v);
});

// ── 初始化 ──
(async () => {
  fillAddr();
  // settings 视图（纯运行信息，注入/路由状态在各专属视图看）
  spApp.views.settings = {
    onEnter() {
      const s = spApp.state || {};
      const desk = window.spDesktop || null;
      const proxyPort = desk && desk.proxyPort ? desk.proxyPort : (parseInt(location.port || "8088", 10) - 8 || 8080);
      const ver = desk && desk.version ? "桌面版 v" + desk.version : "命令行模式 v1.1";
      $("settings-info").innerHTML = `
        <div class="row"><div class="k">运行方式</div><div class="v">${desk ? "Electron 桌面客户端" : "浏览器(直开面板)"}</div></div>
        <div class="row"><div class="k">面板端口</div><div class="v">${location.port || 8088}</div></div>
        <div class="row"><div class="k">代理端口</div><div class="v">${proxyPort}</div></div>
        <div class="row"><div class="k">运行状态</div><div class="v">${s.stats ? "运行中" : "未知"}</div></div>
        <div class="row"><div class="k">版本</div><div class="v">${ver}</div></div>
      `;
    },
  };
  // 视图激活类已由 index.html 内联脚本按 hash 设置(防刷新闪烁);
  // 此处只同步对齐视图名,等全局状态就绪后再进视图——
  // 模板等视图的 onEnter 依赖 spApp.state(如已勾选模板),过早进入会丢状态
  const fromHash = (location.hash || "").replace(/^#/, "");
  const initialView = spApp.views[fromHash] ? fromHash : "overview";
  spApp.currentView = initialView;
  await spApp.loadState();
  const v = spApp.views[initialView];
  if (v && v.onEnter) v.onEnter();
  // 后台轮询全局状态
  setInterval(spApp.loadState, 8000);
})();
