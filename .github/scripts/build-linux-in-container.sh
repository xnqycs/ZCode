#!/usr/bin/env bash
# 在 glibc 2.28 容器内构建 Linux 安装包。
#
# 仓库声明的 Linux 运行时下限是 glibc 2.28：node-pty、bfs、ugrep 的预编译产物都以
# 该版本为基线。GitHub 的 ubuntu-24.04 runner 自带 glibc 2.39，直接在其上安装或
# 重编译原生依赖会把产物下限抬高，所以 Linux 打包统一在 rockylinux:8 中执行。
set -euo pipefail

: "${ZCODE_TARGET_ARCH:?ZCODE_TARGET_ARCH must be x64 or arm64}"
NODE_VERSION="${NODE_VERSION:-24.14.0}"
PNPM_VERSION="${PNPM_VERSION:-10.33.2}"
WORKSPACE_ROOT="$(pwd)"

# 容器以 root 运行；构建结束后把工作区还给 runner 用户，避免收尾清理和
# artifact 上传遇到 root 拥有的 node_modules / dist。
cleanup_ownership() {
  if [ -n "${HOST_UID:-}" ] && [ -n "${HOST_GID:-}" ]; then
    chown -R "${HOST_UID}:${HOST_GID}" "${WORKSPACE_ROOT}" || true
  fi
}
trap cleanup_ownership EXIT

case "${ZCODE_TARGET_ARCH}" in
  x64 | arm64) ;;
  *)
    echo "Unsupported ZCODE_TARGET_ARCH: ${ZCODE_TARGET_ARCH}" >&2
    exit 1
    ;;
esac

echo "==> Installing build dependencies (glibc 2.28)"
dnf install -y --setopt=install_weak_deps=False \
  bsdtar \
  ca-certificates \
  curl \
  gcc \
  gcc-c++ \
  gcc-toolset-12 \
  git \
  make \
  python3 \
  python3.11 \
  rpm-build \
  tar \
  unzip \
  xz

# electron-builder 的便携 fpm 会把自带 OpenSSL 1.1 注入 LD_LIBRARY_PATH。
# Rocky 8 的 librpmio 依赖系统 OpenSSL 的 EVP_md2；继承便携 Ruby 的路径后
# rpmbuild 会以 127 退出。只在 rpmbuild 子进程里恢复系统库路径。
cat > /usr/local/bin/rpmbuild <<'EOF'
#!/bin/sh
unset LD_LIBRARY_PATH
exec /usr/bin/rpmbuild "$@"
EOF
chmod 0755 /usr/local/bin/rpmbuild

echo "==> Installing Node ${NODE_VERSION}"
curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${ZCODE_TARGET_ARCH}.tar.xz"
tar -xJf "node-v${NODE_VERSION}-linux-${ZCODE_TARGET_ARCH}.tar.xz" -C /usr/local --strip-components=1
rm -f "node-v${NODE_VERSION}-linux-${ZCODE_TARGET_ARCH}.tar.xz"

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack enable
corepack prepare "pnpm@${PNPM_VERSION}" --activate

# 容器内的 root 与 runner checkout 的属主不同；构建脚本会读取 git 元数据。
git config --global --add safe.directory "$PWD"

node --version
pnpm --version
ldd --version | head -n 1

# Rocky 8 默认 gcc 是 8，node-pty 需要 C++20；使用 GCC 12 但保持系统 glibc 2.28。
source /opt/rh/gcc-toolset-12/enable
gcc --version | head -n 1

# Rocky 8 默认 python3 是 3.6；node-gyp 11 的 gyp 生成器使用了 3.8+ 语法。
export npm_config_python="${npm_config_python:-/usr/bin/python3.11}"
export PYTHON="${PYTHON:-/usr/bin/python3.11}"

echo "==> Installing workspace dependencies"
pnpm install --frozen-lockfile

echo "==> Building workspace"
pnpm build:bootstrap

echo "==> Preparing platform runtime assets"
pnpm prepare:desktop-runtime

# GCC 12 只服务 node-gyp；打包阶段不再编译原生模块。恢复系统 PATH 和库路径，
# 避免 fpm 的便携 Ruby / rpmbuild / pacman 工具继承 toolset 的较新 libstdc++。
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
unset LD_LIBRARY_PATH

echo "==> Packaging Linux ${ZCODE_TARGET_ARCH}"
pnpm bundle:desktop -- --os linux --arch "${ZCODE_TARGET_ARCH}" --skip-build --skip-prepare
