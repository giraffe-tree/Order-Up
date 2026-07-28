#!/bin/bash
# codex-kitchen 一键重启脚本：清理所有正在运行的旧实例，再重新启动
# 用法: ./start.sh [codex-kitchen 参数...]
#   ./start.sh                # 清理旧实例后，真实会话模式启动
#   ./start.sh --demo         # 演示模式
#   ./start.sh --port 4900 --no-open   # 参数原样透传给 bin/codex-kitchen.js
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 只看 --help 时不动任何进程
for arg in "$@"; do
  if [ "$arg" = "-h" ] || [ "$arg" = "--help" ]; then
    exec node "$SCRIPT_DIR/bin/codex-kitchen.js" --help
  fi
done

# 精确匹配三种进程形态（正则匹配完整命令行）：
#   node bin/codex-kitchen.js ...        （仓库内直接跑 / npm start）
#   node /path/to/.../bin/codex-kitchen  （npm link 后的全局命令，bin 软链到 js 入口）
#   node /path/to/.../order-up-now       （npm 全局安装 / npx 运行，bin 名为 order-up-now）
# 命令必须是 node 开头，避免误杀编辑器、grep 等其他含 "codex-kitchen" 字样的进程
MATCH_RE='^node .*(codex-kitchen(\.js)?|order-up-now)([[:space:]]|$)'

collect_pids() {
  pgrep -f "$MATCH_RE" 2>/dev/null || true
}

# 收集旧实例 PID（排除脚本自身及其父进程，防御极端情况）
PIDS=()
while IFS= read -r pid; do
  [ -z "$pid" ] && continue
  [ "$pid" = "$$" ] && continue
  [ "$pid" = "$PPID" ] && continue
  PIDS+=("$pid")
done < <(collect_pids)

if [ "${#PIDS[@]}" -eq 0 ]; then
  echo "🍳 没有发现正在运行的 codex-kitchen 实例。"
else
  echo "🧹 发现 ${#PIDS[@]} 个正在运行的 codex-kitchen 实例："

  # 记录每个实例监听的端口，便于之后确认释放
  PORTS=()
  while IFS= read -r port; do
    [ -n "$port" ] && PORTS+=("$port")
  done < <(
    lsof -a -p "$(IFS=,; echo "${PIDS[*]}")" -nP -iTCP -sTCP:LISTEN 2>/dev/null \
      | awk 'NR>1 {print $9}' | sed -E 's/.*:([0-9]+)$/\1/' | sort -u || true
  )

  for pid in "${PIDS[@]}"; do
    cmdline="$(ps -p "$pid" -o command= 2>/dev/null || echo '(已退出)')"
    echo "   PID $pid  →  $cmdline"
  done

  # 先优雅终止（SIGTERM），最多等待 6 秒
  echo "🧯 发送 SIGTERM ……"
  kill -TERM "${PIDS[@]}" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    alive=0
    for pid in "${PIDS[@]}"; do
      kill -0 "$pid" 2>/dev/null && alive=1 && break
    done
    [ "$alive" -eq 0 ] && break
    sleep 0.5
  done

  # 还没退出的用 SIGKILL 兜底
  SURVIVORS=()
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      SURVIVORS+=("$pid")
    fi
  done
  if [ "${#SURVIVORS[@]}" -gt 0 ]; then
    echo "🔪 ${#SURVIVORS[@]} 个进程未响应 TERM，强制 SIGKILL：${SURVIVORS[*]}"
    kill -KILL "${SURVIVORS[@]}" 2>/dev/null || true
    sleep 0.5
  fi
  echo "✅ 旧实例已全部关闭。"

  # 确认端口已释放
  if [ "${#PORTS[@]}" -gt 0 ]; then
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      busy=()
      for port in "${PORTS[@]}"; do
        if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
          busy+=("$port")
        fi
      done
      [ "${#busy[@]}" -eq 0 ] && break
      sleep 0.5
    done
    if [ "${#busy[@]}" -eq 0 ]; then
      echo "🔓 端口已释放：$(IFS=' '; echo "${PORTS[*]}")"
    else
      echo "⚠️  以下端口仍被占用（可能被其他程序占用，入口会自动自增端口）：$(IFS=' '; echo "${busy[*]}")"
    fi
  fi
fi

echo ""
echo "🔥 重新启动 codex-kitchen ……"
cd "$SCRIPT_DIR"
exec node bin/codex-kitchen.js "$@"
