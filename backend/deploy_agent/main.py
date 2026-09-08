from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .routes import actions, system, versions

logger = logging.getLogger("deploy_agent")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    logger.info(
        "deploy_agent starting on %s:%d · work_dir=%s source_dir=%s",
        settings.host, settings.port, settings.work_dir, settings.source_dir,
    )
    yield
    logger.info("deploy_agent shutting down")


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="SPC-v2 Deploy Agent",
        version="0.1.0",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    # 仅允许本机回环（agent 只被同机后端调用）。如需远程调试，可改为白名单。
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:*", "http://localhost:*"],
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type"],
        allow_credentials=False,
    )

    app.include_router(system.router, tags=["system"])
    app.include_router(versions.router, tags=["versions"], prefix="/api/v1/deploy")
    app.include_router(actions.router, tags=["actions"], prefix="/api/v1/deploy")

    return app


app = create_app()
