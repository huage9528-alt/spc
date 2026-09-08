# SPC-v2 Deploy Agent

生产主机上的独立 Python 进程。封装 git pull / docker build / docker load /
docker compose up / 健康检查，监听 `127.0.0.1:8901`（默认），通过 HTTP + SSE
对外暴露，被同一台机器上的 SPC-v2 后端调用。

> 设计文档：`docs/superpowers/specs/2026-09-04-deploy-versions-page-design.md`
> 实现计划：`docs/superpowers/plans/2026-09-04-deploy-versions-implementation.md`

## 端点

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| GET  | `/health` | ❌ | loopback 健康检查 |
| GET  | `/api/v1/deploy/versions` | ✅ Bearer | 列出版本（镜像 OK / MISSING） |
| GET  | `/api/v1/deploy/status` | ✅ Bearer | 当前运行版本 + 摘要 |
| POST | `/api/v1/deploy/rollback` | ✅ Bearer | 回退到上一版（body `{version:""}`）或指定版 |
| POST | `/api/v1/deploy/switch` | ✅ Bearer | 切换当前到任意历史版本 |
| POST | `/api/v1/deploy/deploy-new` | ✅ Bearer | 部署新版本（git pull + 构建 + 切换） |
| GET  | `/api/v1/deploy/jobs/{id}/stream` | ✅ Bearer | SSE 实时日志流 |
| GET  | `/api/v1/deploy/jobs/{id}` | ✅ Bearer | 同步最终状态 |

所有 SSE 事件格式：

```
event: step
data: {"step":2,"name":"构建后端镜像","status":"running"}

event: log
data: {"ts":"...","level":"INFO","msg":"..."}

event: end
data: {"status":"ok","version":"v13-..."}
```

## 安装

### 1. 准备（一次性）

```bash
# 推荐用 deploy-agent 专属用户运行（限制 sudo 权限）
sudo useradd -r -s /usr/sbin/nologin -d /opt/spc-v2/source deploy-agent

# 工作目录
sudo mkdir -p /opt/spc-v2/{versions,data,source}
sudo chown -R deploy-agent:deploy-agent /opt/spc-v2

# 首次克隆源码（如已有可跳过）
sudo -u deploy-agent git clone https://github.com/your-org/spc-v2.git /opt/spc-v2/source
```

### 2. 启动（systemd）

复制 `scripts/deploy-agent.service` 到 `/etc/systemd/system/`，填写环境变量文件，
启用：

```bash
sudo cp deploy-agent/scripts/deploy-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now deploy-agent.service
sudo systemctl status deploy-agent.service
```

环境变量（写入 `/etc/default/deploy-agent` 或 `EnvironmentFile=` 指向的文件）：

```bash
DEPLOY_AGENT_WORK_DIR=/opt/spc-v2
DEPLOY_AGENT_SOURCE_DIR=/opt/spc-v2/source
DEPLOY_AGENT_GIT_URL=https://github.com/your-org/spc-v2.git
DEPLOY_AGENT_GIT_BRANCH=main
DEPLOY_AGENT_JWT_SECRET=<与后端 SECRET_KEY 一致>
DEPLOY_AGENT_RETAIN_COUNT=5
```

### 3. 验证

```bash
curl -s http://127.0.0.1:8901/health
# → {"status":"ok","service":"deploy_agent"}

# 需要 JWT（用后端 admin 登录拿 token）
TOKEN=$(...)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8901/api/v1/deploy/versions
```

## 本地开发

在仓库根目录：

```bash
cd backend
python -m pip install -r requirements.txt -r deploy_agent/requirements.txt

# 启动 agent（默认 127.0.0.1:8901）
DEPLOY_AGENT_WORK_DIR=$(pwd)/../_test_deploy \
DEPLOY_AGENT_SOURCE_DIR=$(pwd)/../_test_source \
DEPLOY_AGENT_GIT_URL="" \
DEPLOY_AGENT_JWT_SECRET="dev-secret" \
python -m uvicorn deploy_agent.main:app --port 8901 --reload
```

> agent 内部用 `docker` CLI；开发机需装 docker（如 Docker Desktop），且 backend
> 镜像必须已经存在（agent 不会自己构建 source）。

## 与后端联调

后端 `Settings.DEPLOY_AGENT_URL` 默认 `http://127.0.0.1:8901`。
后端调用 agent 时携带 `Authorization: Bearer <jwt>`（用同一 `SECRET_KEY`）。
