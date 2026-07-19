#!/usr/bin/env bash
# sp-injector 启动脚本（bash / Git Bash）
# 后台起 node 进程，写 PID 文件
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
PORT_PROXY="${SP_PROXY_PORT:-8080}"
PORT_PANEL="${SP_PANEL_PORT:-8088}"
PID_FILE="state/pid"
LOG_FILE="state/sp-injector.log"

mkdir -p state

# 已在运行？
if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    echo "[sp-injector] already running PID=$PID"
    echo "  panel : http://127.0.0.1:$PORT_PANEL"
    echo "  proxy : http://127.0.0.1:$PORT_PROXY"
    exit 0
  fi
fi

echo "[sp-injector] starting..."
nohup node proxy.js > "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"

# 等待端口起来
sleep 1
if kill -0 "$NEW_PID" 2>/dev/null; then
  echo "[sp-injector] started PID=$NEW_PID"
  echo "  panel : http://127.0.0.1:$PORT_PANEL"
  echo "  proxy : http://127.0.0.1:$PORT_PROXY"
  echo "  log   : $LOG_FILE"
  echo "  stop  : ./scripts/stop.sh"
else
  echo "[sp-injector] start FAILED, see $LOG_FILE"
  exit 1
fi
