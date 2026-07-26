#!/bin/sh
# codex-kitchen 一键安装脚本
# 用法: curl -fsSL <your-repo-url>/install.sh | sh
# 可用环境变量覆盖:
#   CODEX_KITCHEN_REPO  git 仓库地址（默认下方占位符，请替换）
#   CODEX_KITCHEN_HOME  安装目录（默认 ~/.codex-kitchen）
set -e

REPO_URL="${CODEX_KITCHEN_REPO:-<your-repo-url>}"
INSTALL_DIR="${CODEX_KITCHEN_HOME:-$HOME/.codex-kitchen}"

if [ "$REPO_URL" = "<your-repo-url>" ]; then
  echo "❌ 请先设置仓库地址：CODEX_KITCHEN_REPO=<git-url> 或编辑本脚本中的占位符。"
  exit 1
fi

for cmd in git node npm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "❌ 未找到 $cmd，请先安装（需要 Node.js ≥ 18、npm、git）。"
    exit 1
  fi
done

NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "❌ Node.js 版本过低（当前 $(node -v)），需要 ≥ 18。"
  exit 1
fi

# 本地路径克隆时 git 会忽略 --depth 并告警，统一转成 file:// URL
case "$REPO_URL" in
  *://*|git@*) CLONE_URL="$REPO_URL" ;;
  *) CLONE_URL="file://$REPO_URL" ;;
esac

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "🍳 已有安装，拉取最新代码……"
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo "🍳 克隆仓库到 $INSTALL_DIR ……"
  git clone --depth 1 "$CLONE_URL" "$INSTALL_DIR"
fi

echo "🔗 npm link ……"
cd "$INSTALL_DIR"
npm link

echo ""
echo "✅ 安装完成！直接运行："
echo "   codex-kitchen          # 真实会话模式"
echo "   codex-kitchen --demo   # 演示模式"
