#!/usr/bin/env bash
# 冒烟测试包装器：渲染全量前先跑这个，先截几帧确认画面。
#
# 用法：
#   bash smoke.sh [animation.html]
#   SMOKE_T="0,1,2" SMOKE_W=1280 SMOKE_H=720 bash smoke.sh
#
# 环境解析与 render.sh 完全一致（环境变量 → 配置文件 ~/.workbuddy/.html2video-env）。
set -euo pipefail

ENV_FILE="${WB_ENV_FILE:-$HOME/.workbuddy/.html2video-env}"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi

if [ -z "${WB_NODE_WORKSPACE:-}" ]; then
  echo "✗ 未配置 node 工作区路径（WB_NODE_WORKSPACE）。参见 render.sh 的报错指引。" >&2
  exit 1
fi

export NODE_PATH="$WB_NODE_WORKSPACE/node_modules"

# 定位脚本目录：保持调用时的路径风格，不要 cd && pwd。
# 在 Git Bash 下 pwd 会返回 POSIX 风格（/c/Users/...），Windows 版 Node 会把它
# 解析成 C:\c\Users\...（凭空多一段）而报 MODULE_NOT_FOUND。
# 有 cygpath 时统一转成 Windows 风格；相对路径（如 "assets"）会原样返回。
SCRIPT_DIR="$(dirname "${BASH_SOURCE[0]}")"
if command -v cygpath >/dev/null 2>&1; then
  SCRIPT_DIR="$(cygpath -w "$SCRIPT_DIR" 2>/dev/null || printf '%s' "$SCRIPT_DIR")"
fi

exec node "$SCRIPT_DIR/smoke.cjs" "$@"
