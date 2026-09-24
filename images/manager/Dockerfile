# hellodac/dac-manager — 蜂群2计划 P2：控制面镜像（构建期 install+build，运行时零安装）
#
# 依赖 docker.sock（宿主机挂载）管理工蜂容器；git/curl 供工作区快照与 agent 工具。
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# better-sqlite3 13 的预编译二进制下载失败时会回退 node-gyp——slim 镜像没有
# 工具链，构建直接炸（compose-e2e 首跑实证）。构建期装上，运行层不含。
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json ./
# npm run build 首步跑 scripts/inject-version.mjs(版本注入)——脚本必须进构建上下文
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates curl tzdata \
    && rm -rf /var/lib/apt/lists/*

# 部署形态标记：容器形态 manager 无法拉起宿主机进程节点（provision 据此
# 显性拒绝 runner=process，向导同步禁用该选项；裸机部署无此变量 = 不受限）。
ENV NODE_ENV=production TZ=Asia/Shanghai DAC_DEPLOY_FORM=container
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY public ./public
# 工作区模板：容器路径没有 setup 步骤，manager 启动时对空工作区自动播种
COPY templates ./templates
# 债务 H1：manager 容器非 root。node 基础镜像自带 1000:1000 的 node 用户/组，
# 直接复用（名字无关紧要，bind mount 权限只认数值；getent 查数值命中即跳过，
# 否则才创建——直接 groupadd -g 1000 会在自带 node 组的镜像上撞
# "GID '1000' already exists"）。docker.sock 的访问靠 compose 的 group_add
# 注入宿主 docker 组 GID（镜像内不需要存在同名组）。/app/data 的宿主侧属主
# 由 install.sh 按 HOST_UID 放行（compose 里是 bind mount，以宿主权限为准）。
RUN mkdir -p /app/data \
    && (getent group 1000 >/dev/null || groupadd -g 1000 dac) \
    && (getent passwd 1000 >/dev/null || useradd -u 1000 -g 1000 -s /bin/sh dac) \
    && chown -R 1000:1000 /app/data \
    # 真相文件原子写（<file>.tmp + rename）要求文件所在目录可写：.env /
    # manager.config.yaml 的 .tmp 落在 /app（bind 挂的是文件本身，父目录仍是
    # 镜像层 root 属主 755）。容器以 HOST_UID 运行时建 .tmp 会 EACCES
    # （CI compose-e2e 实证：POST /api/nodes 500 open /app/.env.tmp）。
    # 单进程控制面容器（唯一进程就是 manager 自己），目录放写与节点镜像
    # /data 777 同款取舍。
    && chmod 777 /app
EXPOSE 8080
USER 1000:1000
CMD ["node", "dist/index.js"]
