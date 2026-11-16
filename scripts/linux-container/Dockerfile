# Linux development image for building, testing and packaging Cadencr from a
# macOS (or any Docker) host. Debian 12 matches the oldest glibc (2.36) our
# packages target among supported distros. See scripts/linux-container.sh.
FROM debian:12

ARG NODE_VERSION=22.19.0
ARG RUST_TOOLCHAIN=1.96.0

ENV DEBIAN_FRONTEND=noninteractive \
    CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:/usr/local/node/bin:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Build tools (vendored OpenSSL needs perl + make), packaging tools (rpmbuild),
# git/lsof the service shells out to, and Electron's runtime libraries + Xvfb
# for headless end-to-end launches.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl file git lsof perl pkg-config procps python3 rpm xz-utils \
      libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils libatspi2.0-0 libdrm2 \
      libgbm1 libxkbcommon0 libasound2 libsecret-1-0 xvfb xauth dbus-x11 \
    && rm -rf /var/lib/apt/lists/*

RUN arch="$(dpkg --print-architecture)" \
    && case "$arch" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) exit 1 ;; esac \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
      | tar -xJ -C /usr/local \
    && mv "/usr/local/node-v${NODE_VERSION}-linux-${node_arch}" /usr/local/node \
    && corepack enable

RUN curl -fsSL https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain "${RUST_TOOLCHAIN}" -c rustfmt -c clippy \
    && chmod -R a+w "$CARGO_HOME" "$RUSTUP_HOME"

# Tests and builds run as an unprivileged user: root bypasses the permission
# failures several tests rely on. `linux-container.sh e2e` stays root to install
# packages.
RUN useradd --create-home --uid 1000 dev

WORKDIR /src
