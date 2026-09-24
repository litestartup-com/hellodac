# hellodac/dac-node — 蜂群2计划 P2：一个容器 = 一个 DSH 节点（DSH + gateway + 独立 DSH_HOME）
#
# 构建期冻结依赖（DSH 钉版 + gateway 钉 commit），运行时零安装。
# 国内构建：
#   --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:22-bookworm-slim
#   --build-arg NPM_REGISTRY=https://registry.npmmirror.com
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

# git：插件/工作区；curl/jq：agent 常用工具；tzdata：TZ=Asia/Shanghai；
# python3/make/g++：DSH 全家桶的原生依赖预编译下载失败时回退 node-gyp 用
# （manager 镜像同款教训，构建期装、运行层不可避免）。
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates curl jq tzdata python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

ARG NPM_REGISTRY=https://registry.npmjs.org
# 钉死版本与 src/dsh-matrix.ts 的 SUPPORTED_DSH 首行一致（check-docs 常驻断言；官方出新版时一起 bump）
ARG DSH_VERSION=0.1.2-rc.1
ARG GATEWAY_REF=github:litestartup-com/dsh-api-gateway#b592b4f
# pnpm 钉到确定版本（不写 pnpm@9 这种浮动区间：同一 tag 会装出不同的构建工具）。
# 9 而不是 11：9 按旧语义运行依赖构建脚本，与裸机 setup 的既有验证一致；
# pnpm ≥10 的构建脚本白名单键语义在 11 又变过（实测 ERR_PNPM_IGNORED_BUILDS 仍触发），
# 构建期工具没必要追新。
RUN npm install -g @deepseek-ai/dsh@${DSH_VERSION} pnpm@9.15.9 --registry="${NPM_REGISTRY}" --no-audit --no-fund \
    && npm cache clean --force

# 构建期生成节点 profile（bundle 钉版 + gateway 钉 commit）并安装依赖。
# profile-lock/<DSH_VERSION>.package-lock.json 提供可复现的依赖树（npm ci）；
# 缺锁时脚本回退 npm install 并告警——事实卡 §14 的容器遗留项。
COPY profile-lock ./profile-lock
COPY gen-node-profile.mjs /usr/local/bin/gen-node-profile.mjs
RUN DSH_VERSION="${DSH_VERSION}" GATEWAY_REF="${GATEWAY_REF}" NPM_REGISTRY="${NPM_REGISTRY}" \
    LOCK_DIR=/profile-lock \
    node /usr/local/bin/gen-node-profile.mjs

COPY entrypoint.sh /usr/local/bin/dsh-node-entrypoint
RUN chmod +x /usr/local/bin/dsh-node-entrypoint \
    && mkdir -p /data /workspace && chown -R 1000:1000 /data /workspace \
    # 容器以 HOST_UID 运行（compose user: / DockerRunner User: 均传宿主部署 uid，
    # 不等于镜像内 1000 时命名卷继承镜像 /data 的 1000 属主 → mkdir /data/profiles
    # EACCES、节点无限重启）。卷根 777：任何 uid 都能在自己创建的子树里工作，
    # 文件本身仍按创建者属主 + 既有 0600 等位收紧（单租户节点容器，无多用户面）。
    && chmod 777 /data
# DSH_HOME 挂卷：首次启动从 /opt/dac-profile 复制 profile（本地复制，零网络）。
# HOME 也指到 /data：$HOME/.brain-auth（主脑令牌，0600）与 dsh 的 ~/.config/~/.npm
# 等运行时写入全部落在同一个可写卷里（否则 HOME=/home/node 属主 1000，
# HOST_UID≠1000 时 entrypoint 写 .brain-auth 同样 EACCES）。
# 节点内绑 0.0.0.0（容器网络隔离，端口不发布到宿主机，manager 走 hive 内网访问）。
ENV DSH_HOME=/data \
    HOME=/data \
    NODE_ENV=production \
    TZ=Asia/Shanghai
WORKDIR /workspace
EXPOSE 3080
ENTRYPOINT ["dsh-node-entrypoint"]
