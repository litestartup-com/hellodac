# hellodac/dac-manager — Hive plan 2 P2: the control-plane image (install+build at build time, zero install at runtime)
#
# Needs docker.sock (mounted from the host) to manage worker containers; git/curl serve workspace snapshots and agent tools.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# When the prebuilt binary download of better-sqlite3 13 fails it falls back to node-gyp -- the slim image has no
# toolchain, so the build blows up outright (seen on the first compose-e2e run). Installed at build time, absent from the runtime layer.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json ./
# The first step of npm run build runs scripts/inject-version.mjs (version injection) -- the script must enter the build context
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates curl tzdata \
    && rm -rf /var/lib/apt/lists/*

# Deploy-form marker: in container form the manager cannot start host process nodes (provision rejects
# runner=process explicitly because of it, and the wizard disables that option; a bare-metal deployment has no such variable = unrestricted).
ENV NODE_ENV=production TZ=Asia/Shanghai DAC_DEPLOY_FORM=container
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY public ./public
# Workspace templates: the container path has no setup step, so the manager seeds an empty workspace automatically at startup
COPY templates ./templates
# Debt H1: the manager container is non-root. The node base image already ships a 1000:1000 node user/group, so reuse
# it directly (the name does not matter, bind mount permissions only look at the numeric ids; a getent lookup that hits
# skips the creation, otherwise it is created -- a plain groupadd -g 1000 would hit "GID '1000' already exists" on an
# image that ships the node group). docker.sock access relies on compose's group_add injecting the host docker group GID
# (no same-named group needs to exist inside the image). The host-side owner of /app/data is released by install.sh
# according to HOST_UID (compose bind-mounts it, so host permissions win).
RUN mkdir -p /app/data \
    && (getent group 1000 >/dev/null || groupadd -g 1000 dac) \
    && (getent passwd 1000 >/dev/null || useradd -u 1000 -g 1000 -s /bin/sh dac) \
    && chown -R 1000:1000 /app/data \
    # The atomic write of truth files (<file>.tmp + rename) requires the directory holding the file to be writable:
    # the .tmp of .env / manager.config.yaml lands in /app (the bind mounts the file itself, the parent directory is
    # still 755 and owned by root from the image layer). Creating the .tmp while the container runs as HOST_UID gives
    # EACCES (seen in CI compose-e2e: POST /api/nodes 500 open /app/.env.tmp).
    # A single-process control-plane container (its only process is the manager itself), so relaxing the directory write
    # permission is the same trade-off as /data 777 in the node image.
    && chmod 777 /app
EXPOSE 8080
USER 1000:1000
CMD ["node", "dist/index.js"]
