// electron/preload.js · 把动态端口与版本注入渲染进程
// 面板 app.js 读 window.spDesktop(无此对象时说明是浏览器直开,回退老推导)

const { contextBridge } = require("electron");

function argInt(key) {
  const prefix = "--" + key + "=";
  for (const a of process.argv) {
    if (a.startsWith(prefix)) return parseInt(a.slice(prefix.length), 10);
  }
  return null;
}

contextBridge.exposeInMainWorld("spDesktop", {
  proxyPort: argInt("sp-proxy-port") || 8080,
  panelPort: argInt("sp-panel-port") || 8088,
  version: (() => {
    const prefix = "--sp-version=";
    for (const a of process.argv) if (a.startsWith(prefix)) return a.slice(prefix.length);
    return "";
  })(),
});
