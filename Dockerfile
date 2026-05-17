# syntax=docker/dockerfile:1.7
# Multi-stage build for kj-agent supervisor.
#
# Pre-condition: `bun run pull-protocol[:dev]` must have run on the host
# before `docker build`, so src/protocol.ts exists. The Dockerfile does
# not fetch the protocol itself — that requires network reachability the
# build context shouldn't depend on.

# ──────────────────────────────────────────────────────────────────────
# Stage 1 — install production dependencies. Separate so layer caching
# reuses node_modules when only source changes.
# ──────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS deps

WORKDIR /work
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ──────────────────────────────────────────────────────────────────────
# Stage 2 — runtime. Bun on Alpine.
# ──────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS runtime

WORKDIR /app

# Non-root user. Docker socket access is granted via the host's docker
# group; operators should pass --group-add accordingly at `docker run`
# time (gid varies per OS). Without that the bun process can't talk to
# /var/run/docker.sock and the supervisor exits at first list call.
RUN addgroup -S kj && adduser -S -G kj -h /app kj

COPY --chown=kj:kj package.json bun.lock ./
COPY --from=deps --chown=kj:kj /work/node_modules ./node_modules
COPY --chown=kj:kj src ./src

USER kj

ENV NODE_ENV=production
ENV KJ_CONFIG_DIR=/etc/kj-agent
ENV KJ_LOG_LEVEL=info

# The supervisor doesn't expose ports — only outbound to the control.
ENTRYPOINT ["bun", "src/main.ts"]
