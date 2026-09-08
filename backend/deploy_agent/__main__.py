"""Entry-point:
    python -m deploy_agent
等价于
    uvicorn deploy_agent.main:app --host 127.0.0.1 --port 8901
"""
import os
import uvicorn

from .config import get_settings


def main() -> None:
    settings = get_settings()
    uvicorn.run(
        "deploy_agent.main:app",
        host=os.getenv("DEPLOY_AGENT_HOST", settings.host),
        port=int(os.getenv("DEPLOY_AGENT_PORT", settings.port)),
        log_level="info",
        reload=False,
    )


if __name__ == "__main__":
    main()
