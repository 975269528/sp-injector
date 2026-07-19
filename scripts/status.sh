#!/usr/bin/env bash
# sp-injector 状态脚本
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
PORT_PROXY="${SP_PROXY_PORT:-8080}"
PORT_PANEL="${SP_PANEL_PORT:-8088}"
PID_FILE="state/pid"

echo "=== sp-injector status ==="
if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    echo "process: RUNNING pid=$PID"
  else
    echo "process: NOT running (stale pid $PID)"
  fi
else
  echo "process: NOT running"
fi

echo ""
if command -v curl >/dev/null 2>&1; then
  HEALTH="$(curl -s --max-time 3 "http://127.0.0.1:$PORT_PROXY/__health" 2>/dev/null || true)"
  if [[ -n "$HEALTH" ]]; then
    echo "proxy: OK"
    echo "$HEALTH"
  else
    echo "proxy: NO response"
  fi
fi

echo ""
echo "panel : http://127.0.0.1:$PORT_PANEL"
echo "proxy : http://127.0.0.1:$PORT_PROXY"
