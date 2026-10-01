#!/usr/bin/env bash
# 逐帧渲染包装器：<animation.html> → <animation.mp4>
#
# 用法：
#   bash render.sh animation.html --duration=12 --fps=60 --width=1920 --height=1080 --concurrency=4
#
# 环境解析顺序（先到先得）：
#   1. 环境变量 WB_NODE_WORKSPACE（node 工作区，内含 playwright + @ffmpeg-installer）
#   2. 配置文件 $HOME/.workbuddy/.html2video-env（装好后写一次，长期生效）
#   3. 都没有 → 报错并给出安装指引
#
# 为什么用配置文件而不是 ${VAR:-默认值}：某些用户名含撇号（如 O'Brien），
# 路径写进 ${VAR:-...} 会被 bash 当成引号开始，报 bad substitution。
# 配置文件走 source，天然规避这个问题。
set -euo pipefail

ENV_FILE="${WB_ENV_FILE:-$HOME/.workbuddy/.html2video-env}"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi

if [ -z "${WB_NODE_WORKSPACE:-}" ]; then
  echo "✗ 未配置 node 工作区路径（WB_NODE_WORKSPACE）。" >&2
  echo >&2
  echo "  方式一（推荐，一次配置长期生效）—— 新建 $ENV_FILE：" >&2
  echo '    WB_NODE_WORKSPACE="<你的 node 工作区绝对路径>"' >&2
  echo >&2
  echo "  方式二（临时生效）—— 直接 export：" >&2
  echo '    export WB_NODE_WORKSPACE="<路径>"' >&2
  echo >&2
  echo "  该目录需已安装依赖：" >&2
  echo '    cd "$WB_NODE_WORKSPACE" && npm install playwright@1.49.1 @ffmpeg-installer/ffmpeg' >&2
  exit 1
fi

# 完整版 ffmpeg：Windows 落在 win32-x64/，其它平台落在包根
FFMPEG_BIN="$WB_NODE_WORKSPACE/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe"
if [ ! -f "$FFMPEG_BIN" ]; then
  FFMPEG_BIN="$WB_NODE_WORKSPACE/node_modules/@ffmpeg-installer/ffmpeg"
fi

if [ ! -f "$FFMPEG_BIN" ]; then
  echo "✗ 找不到完整版 ffmpeg：$FFMPEG_BIN" >&2
  echo "  装法：cd \"$WB_NODE_WORKSPACE\" && npm install @ffmpeg-installer/ffmpeg" >&2
  exit 1
fi

export NODE_PATH="$WB_NODE_WORKSPACE/node_modules"
export FFMPEG="$FFMPEG_BIN"

# 定位脚本目录：保持调用时的路径风格，不要 cd && pwd。
# 在 Git Bash 下 pwd 会返回 POSIX 风格（/c/Users/...），Windows 版 Node 会把它
# 解析成 C:\c\Users\...（凭空多一段）而报 MODULE_NOT_FOUND。
# 有 cygpath 时统一转成 Windows 风格；相对路径（如 "assets"）会原样返回。
SCRIPT_DIR="$(dirname "${BASH_SOURCE[0]}")"
if command -v cygpath >/dev/null 2>&1; then
  SCRIPT_DIR="$(cygpath -w "$SCRIPT_DIR" 2>/dev/null || printf '%s' "$SCRIPT_DIR")"
fi
RENDERER="$SCRIPT_DIR/../scripts/render-video-seek.js"

if [ ! -f "$RENDERER" ]; then
  echo "✗ 找不到渲染器：$RENDERER" >&2
  exit 1
fi

exec node "$RENDERER" "$@"
