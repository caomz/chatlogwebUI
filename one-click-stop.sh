#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION_NAME="${CHATLOGWEBUI_TMUX_SESSION:-chatlogwebui}"
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

process_cwd() {
  local pid="$1"
  lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
}

is_chatlogwebui_node_process() {
  local pid="$1"
  local command_line
  local cwd

  command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  cwd="$(process_cwd "$pid")"

  [[ "$cwd" == "$ROOT_DIR" && "$command_line" == *"node server.js"* ]]
}

stop_pid() {
  local pid="$1"
  echo "停止进程 PID=$pid"
  kill "$pid" 2>/dev/null || true

  for _ in {1..20}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done

  echo "进程 PID=$pid 未正常退出，发送 SIGKILL"
  kill -9 "$pid" 2>/dev/null || true
}

read_env_port
require_command tmux
require_command lsof

echo "Chatlog Web UI 一键停止"
echo "项目目录: $ROOT_DIR"
echo "tmux session: $SESSION_NAME"
echo "端口: $PORT"
echo

stopped_any=0

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "停止 tmux session: $SESSION_NAME"
  tmux kill-session -t "$SESSION_NAME"
  stopped_any=1
else
  echo "未发现 tmux session: $SESSION_NAME"
fi

while IFS= read -r pid; do
  if [[ -n "$pid" ]] && is_chatlogwebui_node_process "$pid"; then
    stop_pid "$pid"
    stopped_any=1
  elif [[ -n "$pid" ]]; then
    echo "端口 $PORT 仍被其他进程占用，未处理 PID=$pid"
    ps -p "$pid" -o pid=,command= 2>/dev/null || true
  fi
done < <(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)

sleep 1

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "停止完成，但端口 $PORT 仍有监听。请检查上面的进程信息。"
  exit 1
fi

if [[ "$stopped_any" -eq 1 ]]; then
  echo "停止成功。端口 $PORT 当前未监听。"
else
  echo "没有发现需要停止的 chatlogwebUI 服务。端口 $PORT 当前未监听。"
fi
