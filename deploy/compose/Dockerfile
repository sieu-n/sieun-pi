# syntax=docker/dockerfile:1
# One image for a dev sw factory instance: apps/chat (server and web client) and pi-host, run as two services by compose.yaml at the repo root.
# The build context is the checkout itself (c193: no clone, archive or copy); Dockerfile.dockerignore keeps node_modules, dist and .git out.
# Debian trixie, because pi-pool's token hook (packages/pi-pool/bin/pi-pool-token) needs glibc 2.38 and bookworm has 2.36.
FROM node:26.12.1-trixie-slim AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git procps python3 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.9.7 /uv /uvx /usr/local/bin/
# pi-rlm builds each kernel's venv with `uv venv --python 3.11` (packages/pi-rlm/src/core/python.ts); trixie ships 3.13, so 3.11 is baked in.
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python
RUN uv python install 3.11 && chmod -R a+rX /opt/uv-python
WORKDIR /app
# Every COPY from the checkout makes its files readable by all: the box writes them 0600 under UMask=0077, and the instance runs as any
# uid (compose.pool.yaml uses the box user). Manifests first, so a source edit reuses the npm ci layers. These are the dependency
# folders scripts/install-pi-host-box.mjs and scripts/release-apps-chat.mjs install.
COPY --chmod=a+rX package.json package-lock.json ./
COPY --chmod=a+rX packages/package.json packages/package-lock.json packages/
COPY --chmod=a+rX packages/pi-claude-rules/package.json packages/pi-claude-rules/
COPY --chmod=a+rX packages/pi-family/package.json packages/pi-family/
COPY --chmod=a+rX packages/pi-harness/package.json packages/pi-harness/
COPY --chmod=a+rX packages/pi-history/package.json packages/pi-history/
COPY --chmod=a+rX packages/pi-host/package.json packages/pi-host/
COPY --chmod=a+rX packages/pi-pool/package.json packages/pi-pool/
COPY --chmod=a+rX packages/pi-rlm/package.json packages/pi-rlm/
COPY --chmod=a+rX packages/pi-testkit/package.json packages/pi-testkit/
COPY --chmod=a+rX packages/sieun-rules/package.json packages/sieun-rules/
COPY --chmod=a+rX legacy/prime/user-history/package.json legacy/prime/user-history/package-lock.json legacy/prime/user-history/
COPY --chmod=a+rX legacy/prime/user-history/vendor/prime-sdk legacy/prime/user-history/vendor/prime-sdk
COPY --chmod=a+rX apps/chat/package.json apps/chat/package-lock.json apps/chat/
COPY --chmod=a+rX apps/chat/web/package.json apps/chat/web/package-lock.json apps/chat/web/
RUN --mount=type=cache,target=/root/.npm \
    for dir in . packages legacy/prime/user-history; do (cd "$dir" && npm ci --ignore-scripts --no-audit --no-fund) || exit 1; done \
 && (cd apps/chat && npm ci --no-audit --no-fund) \
 && (cd apps/chat/web && npm ci --no-audit --no-fund)

FROM deps AS web
COPY --chmod=a+rX apps/chat/web apps/chat/web
RUN cd apps/chat/web && npm run build

FROM deps
COPY --chmod=a+rX . .
COPY --from=web /app/apps/chat/web/dist apps/chat/web/dist
# One folder holds the instance: HOME, so every home-relative default of apps/chat and pi-host (agent dir, chat data, agent folders,
# kernel venvs) lands in the compose volume mounted here. Mode 1777, so the instance runs as any uid (compose.pool.yaml uses the box's).
ENV HOME=/data/home LANG=C.UTF-8 PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1
RUN mkdir -p /data/home/workspace /data/run && chmod -R 1777 /data
