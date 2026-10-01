# hellodac/dac-node — Hive plan 2 P2: one container = one DSH node (DSH + gateway + an isolated DSH_HOME)
#
# Dependencies are frozen at build time (DSH pinned version + gateway pinned commit), zero install at runtime.
# Building in China:
#   --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:22-bookworm-slim
#   --build-arg NPM_REGISTRY=https://registry.npmmirror.com
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

# git: plugins/workspaces; curl/jq: tools agents use often; tzdata: TZ=Asia/Shanghai;
# python3/make/g++: for when the prebuilt download of the DSH suite's native dependencies fails and node-gyp is the
# fallback (the same lesson as the manager image: installed at build time, unavoidable in the runtime layer).
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates curl jq tzdata python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

ARG NPM_REGISTRY=https://registry.npmjs.org
# The pinned version matches the first line of SUPPORTED_DSH in src/dsh-matrix.ts (a standing check-docs assertion; bump it together when upstream ships a new release)
ARG DSH_VERSION=0.1.2-rc.1
# Empty default = "resolve per version": gen-node-profile.mjs maps DSH_VERSION to the paired facade
# ref (GATEWAY_REF_BY_VERSION, kept in sync with the matrix rows -- a pre-corridor facade on a 0.2.0
# host dies silently, dsh-facts §18.2). An explicit --build-arg overrides (pinned legacy builds).
ARG GATEWAY_REF=
# pnpm is pinned to a definite version (no floating range like pnpm@9: the same tag would install different build tools).
# 9 and not 11: 9 runs dependency build scripts under the old semantics, consistent with the existing verification of
# the bare-metal setup; pnpm ≥10's build-script allowlist key changed semantics again in 11 (measured: ERR_PNPM_IGNORED_BUILDS
# still fires), and build-time tooling has no reason to chase the newest release.
RUN npm install -g @deepseek-ai/dsh@${DSH_VERSION} pnpm@9.15.9 --registry="${NPM_REGISTRY}" --no-audit --no-fund \
    && npm cache clean --force

# Generate the node profile at build time (bundle pinned version + gateway pinned commit) and install its dependencies.
# profile-lock/<DSH_VERSION>.package-lock.json provides a reproducible dependency tree (npm ci);
# when the lock is missing the script falls back to npm install with a warning -- the container leftover of fact card §14.
COPY profile-lock ./profile-lock
COPY gen-node-profile.mjs /usr/local/bin/gen-node-profile.mjs
RUN DSH_VERSION="${DSH_VERSION}" GATEWAY_REF="${GATEWAY_REF}" NPM_REGISTRY="${NPM_REGISTRY}" \
    LOCK_DIR=/profile-lock \
    node /usr/local/bin/gen-node-profile.mjs

COPY entrypoint.sh /usr/local/bin/dsh-node-entrypoint
RUN chmod +x /usr/local/bin/dsh-node-entrypoint \
    && mkdir -p /data /workspace && chown -R 1000:1000 /data /workspace \
    # The container runs as HOST_UID (compose user: / DockerRunner User: both pass the host deploy uid; when that is
    # not the image's 1000 the named volume inherits 1000 as the owner of /data -> mkdir /data/profiles EACCES, the node
    # restarts forever). Volume root 777: any uid can work in the subtree it creates itself, while the files themselves
    # stay owned by their creator with the existing 0600 and similar modes tightened (single-tenant node container, no multi-user surface).
    && chmod 777 /data
# DSH_HOME is a mounted volume: the first start copies the profile from /opt/dac-profile (a local copy, zero network).
# HOME points at /data too: $HOME/.brain-auth (the brain token, 0600) and dsh's runtime writes such as ~/.config/~/.npm
# all land in the same writable volume (otherwise HOME=/home/node is owned by 1000, and with HOST_UID≠1000 the entrypoint
# gets the same EACCES writing .brain-auth).
# DSH_VERSION is re-exported at runtime: the entrypoint gates the GW_KEY injection path on it (0.2.0 corridor,
# upgrade card J1-04 -- legacy 0.1.2/0.1.5 lines -> settings.yaml; 0.1.7+/0.2.x -> the profile's cordis.patch.yml
# composition row, because settings.yaml became a one-shot import and ctx.settings.register is gone host-side).
# The node binds 0.0.0.0 (the container network is isolated, the port is not published to the host, and the manager reaches it over the hive network).
ENV DSH_HOME=/data \
    HOME=/data \
    NODE_ENV=production \
    TZ=Asia/Shanghai \
    DSH_VERSION=${DSH_VERSION}
WORKDIR /workspace
EXPOSE 3080
ENTRYPOINT ["dsh-node-entrypoint"]
