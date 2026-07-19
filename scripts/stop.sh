#!/usr/bin/env bash
# sp-injector 停止脚本
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
PID_FILE="state/pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "[sp-injector] not running (no pid file)"
  exit 0
fi
PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [[ -z "$PID" ]]; then
  echo "[sp-injector] pid file empty"
  rm -f "$PID_FILE"
  exit 0
fi
if ! kill -0 "$PID" 2>/dev/null; then
  echo "[sp-injector] process $PID not alive"
  rm -f "$PID_FILE"
  exit 0
fi
kill "$PID" 2>/dev/null || true
sleep 1
if kill -0 "$PID" 2>/dev/null; then
  kill -9 "$PID" 2>/dev/null || true
fi
rm -f "$PID_FILE"
echo "[sp-injector] stopped PID=$PID"
