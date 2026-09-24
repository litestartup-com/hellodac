#!/usr/bin/env bash
# 蜂群2计划 P2：节点容器入口。幂等：重启不重复复制、不覆盖已有 settings。
set -euo pipefail

mkdir -p "$DSH_HOME"

# 0) 陈旧原子写锁清理：崩溃残留的 .credentials.yaml.lock 会让每次 boot 在
#    withFileLock 上超时（线上脊柱与 Windows 生产双实踩，事实卡 dsh-facts §13）——
#    容器单进程模型下入口处绝无并发写者，残留锁必为死进程遗留，直接清。
rm -f "$DSH_HOME/.credentials.yaml.lock"

# 1) 播种/升级 profile：卷里没有，或播种版本与镜像不一致 → 重新复制（本地，零网络）
SEED_CUR=""
SEED_NEW="$(cat /opt/dac-profile/.seed-version 2>/dev/null || echo unknown)"
[ -f "$DSH_HOME/profiles/dac-node/.seed-version" ] && SEED_CUR="$(cat "$DSH_HOME/profiles/dac-node/.seed-version")"
if [ ! -d "$DSH_HOME/profiles/dac-node" ] || [ "$SEED_CUR" != "$SEED_NEW" ]; then
  rm -rf "$DSH_HOME/profiles/dac-node"
  mkdir -p "$DSH_HOME/profiles"
  cp -a /opt/dac-profile "$DSH_HOME/profiles/dac-node"
  echo "[entrypoint] profile seeded into $DSH_HOME/profiles/dac-node (seed ${SEED_NEW:0:8})"
fi

# 2) gateway 静态密钥：环境变量是真相（A 清单：派生文件不可手改）。
#    文件缺失、或不在本插件的命名空间、或不含当前 GW_KEY 一律重写——
#    卷里可能残留上一版的旧钥匙/旧命名空间（0.1.1→0.1.2 升级实测：
#    旧 settings.yaml 的 dsh-api-gw 段含同一 key 串，光 grep key 会误判
#    「已写好」跳过重写 → facade 新命名空间空、apiKeySet:false）。
if [[ -n "${GW_KEY:-}" ]]; then
  NEED_WRITE=1
  if [ -f "$DSH_HOME/settings.yaml" ]; then
    if grep -q '^ohdsh-api-facade:' "$DSH_HOME/settings.yaml" 2>/dev/null \
       && grep -q "$GW_KEY" "$DSH_HOME/settings.yaml" 2>/dev/null; then NEED_WRITE=0; fi
  fi
  if [ "$NEED_WRITE" = "1" ]; then
    cat > "$DSH_HOME/settings.yaml" <<EOF
ohdsh-api-facade:
  apiKeys: ['$GW_KEY']
EOF
    chmod 600 "$DSH_HOME/settings.yaml"
    echo "[entrypoint] wrote $DSH_HOME/settings.yaml (GW_KEY 刷新)"
  fi
else
  echo "[entrypoint] ⚠ GW_KEY 未注入——网关沙箱路由将 401（manager 的 .env 里 GW_KEY_* 应为非空）"
fi

# 3) 主脑令牌文件（$HOME/.brain-auth，0600）：DSH 工具沙箱洗掉 TOKEN 字样
#    环境变量（DSH-FACTS §2），技能手册读文件走鉴权。幂等：内容变了才重写。
if [[ -n "${BRAIN_TOKEN:-}" && -n "${HOME:-}" ]]; then
  mkdir -p "$HOME"
  if [ ! -f "$HOME/.brain-auth" ] || [ "$(cat "$HOME/.brain-auth" 2>/dev/null)" != "$BRAIN_TOKEN" ]; then
    printf '%s' "$BRAIN_TOKEN" > "$HOME/.brain-auth"
    chmod 600 "$HOME/.brain-auth"
    echo "[entrypoint] wrote $HOME/.brain-auth"
  fi
fi

# 4) 模型凭据：DEEPSEEK_API_KEY 环境变量在 DSH 凭据分层里优先级最高，无需写文件

# 5) 启动：端口等参数透传给 web app（manager 侧 docker run 命令带 --port N）
exec dsh --profile dac-node --no-open "$@"
