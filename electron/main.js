// electron/main.js · 桌面壳 · 大制不割
// 生命周期:单实例锁 → 数据目录迁移(userData)→ 动态端口起双 server → 窗口 + 托盘
// 关窗口 = 隐藏到托盘(代理常驻),托盘菜单真正退出

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  clipboard,
  dialog,
  nativeImage,
} = require("electron");
const path = require("path");
const fs = require("fs");
const net = require("net");
const crypto = require("crypto");

const APP_ROOT = path.resolve(__dirname, "..");

// ── 日志:console 双写 userData/logs/app.log(>5MB 轮转移到 .old) ──
const LOG_DIR = path.join(app.getPath("userData"), "logs");
const LOG_FILE = path.join(LOG_DIR, "app.log");
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
function appendLog(line) {
  try {
    try {
      if (fs.statSync(LOG_FILE).size > 5 * 1024 * 1024)
        fs.renameSync(LOG_FILE, LOG_FILE + ".old");
    } catch {}
    fs.appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch {}
}
const origLog = console.log.bind(console);
const origErr = console.error.bind(console);
console.log = (...a) => {
  origLog(...a);
  appendLog(a.map(String).join(" "));
};
console.error = (...a) => {
  origErr(...a);
  appendLog("[ERROR] " + a.map(String).join(" "));
};

// ── 首次运行迁移:userData 无 templates/ 时从种子拷内置模板;
//    无 state/ 时建目录(开发模式顺手把项目 state/ 的有效数据拷过来) ──
function ensureData() {
  const dataDir = app.getPath("userData");
  const seedTemplates = app.isPackaged
    ? path.join(process.resourcesPath, "seed-templates")
    : path.join(APP_ROOT, "templates");

  const tplDir = path.join(dataDir, "templates");
  const hasTpl = () => {
    try {
      return fs.readdirSync(tplDir).some((f) => f.endsWith(".txt"));
    } catch {
      return false;
    }
  };
  if (!hasTpl()) {
    fs.mkdirSync(tplDir, { recursive: true });
    try {
      for (const f of fs.readdirSync(seedTemplates)) {
        if (f.endsWith(".txt"))
          fs.copyFileSync(path.join(seedTemplates, f), path.join(tplDir, f));
      }
      console.log("[migrate] 内置模板已就位(" + tplDir + ")");
    } catch (e) {
      console.error("[migrate] seed templates fail: " + e.message);
    }
  }

  const stateDir = path.join(dataDir, "state");
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
    const oldState = path.join(APP_ROOT, "state");
    try {
      if (fs.existsSync(oldState)) {
        for (const f of fs.readdirSync(oldState)) {
          if (
            f === "pid" ||
            f === "sp-injector.log" ||
            f.startsWith("archive-") ||
            f.startsWith(".")
          )
            continue;
          if (!fs.statSync(path.join(oldState, f)).isFile()) continue;
          fs.copyFileSync(path.join(oldState, f), path.join(stateDir, f));
        }
        console.log("[migrate] 项目 state/ 已拷贝到 " + stateDir);
      }
    } catch (e) {
      console.error("[migrate] state copy fail: " + e.message);
    }
  }
}

// ── 端口:试绑探测,占用则 +1 递增 ──
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}
async function pickPort(base) {
  for (let p = base; p < base + 20; p++) if (await portFree(p)) return p;
  return crypto.randomInt(20000, 40000);
}

// 起双 server;EADDRINUSE 时整体 +1 重试
async function startBackend() {
  let proxyPort = await pickPort(8080);
  let panelPort = await pickPort(8088);
  const backendMod = require("../proxy.js");
  for (let i = 0; i < 10; i++) {
    try {
      return await backendMod.startProxy({ proxyPort, panelPort });
    } catch (e) {
      if (e && e.code === "EADDRINUSE") {
        proxyPort++;
        panelPort++;
        continue;
      }
      throw e;
    }
  }
  throw new Error("no available port");
}

// ── 窗口与托盘 ──
let win = null;
let tray = null;
let backend = null;
let quitting = false;

function showWin() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow(panelPort, proxyPort) {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: "#F6F7F9",
    icon: path.join(__dirname, "icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      additionalArguments: [
        "--sp-proxy-port=" + proxyPort,
        "--sp-panel-port=" + panelPort,
        "--sp-version=" + app.getVersion(),
      ],
    },
  });
  win.loadURL("http://127.0.0.1:" + panelPort + "/");
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function createTray(proxyPort) {
  const img = nativeImage
    .createFromPath(path.join(__dirname, "icon.png"))
    .resize({ width: 16 });
  tray = new Tray(img);
  tray.setToolTip("sp-injector · 道法自然");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "代理 " + proxyPort, enabled: false },
      { type: "separator" },
      {
        label: "显示面板",
        click: () => showWin(),
      },
      {
        label: "复制代理地址",
        click: () => clipboard.writeText("http://127.0.0.1:" + proxyPort),
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("double-click", () => showWin());
}

// ── 生命周期 ──
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showWin());

  app.whenReady().then(async () => {
    ensureData();
    process.env.SP_DATA_DIR = app.getPath("userData");
    try {
      backend = await startBackend();
    } catch (e) {
      console.error("[FATAL] backend start fail: " + (e && e.message));
      dialog.showErrorBox("sp-injector 启动失败", String((e && e.message) || e));
      app.exit(1);
      return;
    }
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ role: "editMenu" }, { role: "viewMenu" }]),
    );
    createWindow(backend.ports.panel, backend.ports.proxy);
    createTray(backend.ports.proxy);
    app.on("activate", () => showWin());
  });

  app.on("before-quit", () => {
    quitting = true;
    try {
      if (backend) {
        backend.proxyServer.close();
        backend.panelServer.close();
      }
    } catch {}
  });

  // 常驻托盘,不随窗口关闭退出
  app.on("window-all-closed", () => {});
}
