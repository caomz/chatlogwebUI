#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION_NAME="${CHATLOGWEBUI_TMUX_SESSION:-chatlogwebui}"
LOG_DIR="${CHATLOGWEBUI_LOG_DIR:-/tmp}"
LOG_FILE="${CHATLOGWEBUI_LOG_FILE:-$LOG_DIR/chatlogwebui.log}"
PORT="${PORT:-}"

read_env_port() {
  local env_file="$ROOT_DIR/.env"
  if [[ -z "$PORT" && -f "$env_file" ]]; then
    PORT="$(awk -F= '
      /^[[:space:]]*#/ { next }
      /^[[:space:]]*PORT[[:space:]]*=/ {
        value=$2
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        gsub(/^["'\'']|["'\'']$/, "", value)
        print value
      }
    ' "$env_file" | tail -n 1)"
  fi
  PORT="${PORT:-3000}"
}

require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "缺少命令: $name"
    exit 1
  fi
}

is_port_listening() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
}

is_http_ready() {
  if ! command -v curl >/dev/null 2>&1; then
    return 0
  fi
  curl -fsS --max-time 5 "http://127.0.0.1:$PORT/" >/dev/null 2>&1
}

print_status() {
  echo "项目目录: $ROOT_DIR"
  echo "tmux session: $SESSION_NAME"
  echo "日志文件: $LOG_FILE"
  echo "访问地址: http://localhost:$PORT"
}

read_env_port
require_command node
require_command npm
require_command tmux
require_command lsof

cd "$ROOT_DIR"
mkdir -p "$LOG_DIR"

echo "Chatlog Web UI 一键启动"
print_status
echo

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "服务已经在 tmux session 中运行: $SESSION_NAME"
  if is_port_listening; then
    if is_http_ready; then
      echo "端口 $PORT 已监听，Web UI 可访问。无需重复启动。"
    else
      echo "端口 $PORT 已监听，但 Web UI 首页暂时不可访问。"
      echo "请查看日志: tail -n 80 \"$LOG_FILE\""
    fi
  else
    echo "注意: tmux session 存在，但端口 $PORT 未监听。请查看日志或先运行 ./one-click-stop.sh 后再启动。"
  fi
  exit 0
fi

if is_port_listening; then
  echo "端口 $PORT 已被占用，未启动新服务。"
  echo "占用进程:"
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN || true
  echo
  echo "如果这是旧的 chatlogwebUI 进程，请先运行: ./one-click-stop.sh"
  exit 1
fi

if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
  echo "未发现 node_modules，开始安装依赖: npm install"
  npm install
fi

echo "启动服务..."
tmux new-session -d -s "$SESSION_NAME" -c "$ROOT_DIR" "PORT=\"$PORT\" node server.js >> \"$LOG_FILE\" 2>&1"

sleep 2

if is_port_listening && is_http_ready; then
  echo "启动成功: http://localhost:$PORT"
  echo "查看日志: tail -f \"$LOG_FILE\""
  echo "进入 session: tmux attach -t \"$SESSION_NAME\""
elif is_port_listening; then
  echo "端口 $PORT 已监听，但 Web UI 首页暂时不可访问。"
  echo "请查看日志: tail -n 80 \"$LOG_FILE\""
  exit 1
else
  echo "启动命令已执行，但端口 $PORT 暂未监听。"
  echo "请查看日志: tail -n 80 \"$LOG_FILE\""
  exit 1
fi
