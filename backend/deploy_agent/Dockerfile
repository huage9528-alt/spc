# SPC-v2 Deploy Agent 独立镜像
#
# 职责单一：封装 git pull / docker build / docker load / compose up / 健康检查，
# 供 SPC-v2 后端驱动远程版本部署。只装 agent 需要的依赖，不承载业务后端。
#
# 运行要求（docker-compose 注入）：
#   - 挂载 /var/run/docker.sock 访问宿主 daemon
#   - DEPLOY_AGENT_WORK_DIR / DEPLOY_AGENT_SOURCE_DIR 指向宿主部署目录

# 第一步：只取 docker CLI 静态二进制（远小于 docker.io daemon 全家桶）
FROM docker:27-cli AS docker-cli

FROM python:3.12-slim

# docker CLI + git（git pull 需要）
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 只装 agent 依赖（fastapi / pydantic-settings / PyJWT / uvicorn）
COPY deploy_agent/requirements.txt /app/requirements-agent.txt
RUN pip install --no-cache-dir -r /app/requirements-agent.txt

# agent 包
COPY deploy_agent/ /app/deploy_agent/

ENV DEPLOY_AGENT_HOST=0.0.0.0 \
    DEPLOY_AGENT_PORT=8901 \
    PYTHONUNBUFFERED=1

EXPOSE 8901

CMD ["python", "-m", "deploy_agent"]
