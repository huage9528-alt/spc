"""SPC-v2 Deploy Agent
生产主机侧独立进程，封装 git pull / docker build / docker load / docker compose up
/ 健康检查，把 PS1 脚本的能力以 HTTP + SSE 暴露给后端。

仅监听 127.0.0.1（默认），通过共享 JWT 鉴权（仅校验签名+过期，不校验
login_version，因为这是 service-to-service 调用）。
"""
__version__ = "0.1.0"
