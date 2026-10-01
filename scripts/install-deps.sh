#!/usr/bin/env bash
# 一键装依赖：探测浏览器缓存 → 挑匹配的 playwright 版本 → 装完整版 ffmpeg → 写配置文件。
#
# 用法：
#   bash install-deps.sh [node工作区路径]
#   bash install-deps.sh ~/.workbuddy/binaries/node/workspace
#
# 装完会写 ~/.workbuddy/.html2video-env，之后 render.sh / smoke.sh 开箱即用。
#
# 为什么探测：playwright-core@X 只认自己 browsers.json 里声明的 chromium build 号，
# 不匹配会报 "Executable doesn't exist"。而某些网络环境下 chromium 根本下不下来，
# 此时正确做法是迁就已有缓存挑版本，而不是硬装最新版。
set -euo pipefail

WORKSPACE="${1:-${WB_NODE_WORKSPACE:-$HOME/.workbuddy/binaries/node/workspace}}"
ENV_FILE="${WB_ENV_FILE:-$HOME/.workbuddy/.html2video-env}"

if ! command -v node >/dev/null 2>&1; then
  echo "✗ 没找到 node。先装 Node.js（>=18）再跑本脚本。" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "✗ 没找到 npm。" >&2
  exit 1
fi

mkdir -p "$WORKSPACE"
echo "▸ node 工作区：$WORKSPACE"

# 定位脚本目录：保持调用时路径风格（Git Bash 的 pwd 会给 Windows 版 Node 下毒，见 render.sh 注释）
SCRIPT_DIR="$(dirname "${BASH_SOURCE[0]}")"
if command -v cygpath >/dev/null 2>&1; then
  SCRIPT_DIR="$(cygpath -w "$SCRIPT_DIR" 2>/dev/null || printf '%s' "$SCRIPT_DIR")"
fi

echo "▸ 探测本机浏览器缓存…"
DETECT="$(node "$SCRIPT_DIR/detect-env.js")"
eval "$DETECT"
echo "  缓存目录：${CACHE_DIR:-（未找到）}"
echo "  已有 build：${FOUND_BUILDS:-（无）}"
echo "  建议版本：${RECOMMEND_PW}（${RECOMMEND_REASON}）"

if [ "${RECOMMEND_PW}" = "latest" ]; then
  PW_PKG="playwright"
  echo "  → 装最新版 playwright"
else
  PW_PKG="playwright@${RECOMMEND_PW}"
  echo "  → 复用已有缓存，锁定 playwright@${RECOMMEND_PW}"
fi

echo "▸ 安装 playwright + 完整版 ffmpeg…"
cd "$WORKSPACE"
npm install --save-exact "${PW_PKG}" @ffmpeg-installer/ffmpeg --no-audit --no-fund

if [ "${NEED_DOWNLOAD:-0}" = "1" ]; then
  echo "▸ 缓存为空，下载 chromium（这步可能较慢，失败多半是网络问题）…"
  npx playwright install chromium || {
    echo "✗ chromium 下载失败。" >&2
    echo "  若网络受限：装一个与已有缓存 build 号匹配的旧版 playwright 即可复用，无需下载。" >&2
    echo "  已有 build：${FOUND_BUILDS:-（无）}" >&2
    exit 1
  }
fi

mkdir -p "$(dirname "$ENV_FILE")"
cat > "$ENV_FILE" <<EOF
# html-to-video 技能的本机环境配置（由 install-deps.sh 生成）
WB_NODE_WORKSPACE="${WORKSPACE}"
EOF
echo "▸ 已写入配置：$ENV_FILE"

FF="$WORKSPACE/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe"
if [ ! -f "$FF" ]; then FF="$WORKSPACE/node_modules/@ffmpeg-installer/ffmpeg"; fi
if [ -f "$FF" ]; then
  echo
  echo "✓ 依赖就绪。ffmpeg：$FF"
  echo
  echo "下一步："
  echo "  bash assets/smoke.sh your-animation.html      # 先冒烟"
  echo "  bash assets/render.sh your-animation.html --duration=12 --fps=60"
else
  echo "✗ ffmpeg 未落到预期位置，检查 npm install 输出。" >&2
  exit 1
fi
