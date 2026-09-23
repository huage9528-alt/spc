"""入口：python -m mcp_server

传输模式（CLI 参数优先于环境变量）：
  stdio（默认）      python -m mcp_server
  streamable-http    python -m mcp_server --transport streamable-http --host 127.0.0.1 --port 8902
"""

import argparse
import logging
import os
import sys

from . import __version__
from .server import HTTP_TOKEN, mcp

logger = logging.getLogger(__name__)

_TRANSPORT_STDIO = "stdio"
_TRANSPORT_STREAMABLE_HTTP = "streamable-http"


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="mcp_server", description="company-control MCP Server（只读）")
    parser.add_argument(
        "--transport",
        choices=[_TRANSPORT_STDIO, _TRANSPORT_STREAMABLE_HTTP],
        default=os.getenv("MCP_TRANSPORT") or _TRANSPORT_STDIO,
        help="传输模式（默认 stdio；env: MCP_TRANSPORT）",
    )
    parser.add_argument(
        "--host",
        default=os.getenv("MCP_HTTP_HOST") or "127.0.0.1",
        help="HTTP 监听地址（env: MCP_HTTP_HOST）",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.getenv("MCP_HTTP_PORT") or "8902"),
        help="HTTP 监听端口（env: MCP_HTTP_PORT）",
    )
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    if args.transport == _TRANSPORT_STREAMABLE_HTTP:
        if not HTTP_TOKEN:
            logger.error("HTTP 模式必须配置 MCP_HTTP_TOKEN（静态 Bearer Token），拒绝启动")
            sys.exit(2)
        logger.info(
            "company-control MCP Server v%s 启动（streamable-http %s:%s）", __version__, args.host, args.port
        )
        mcp.run(transport=_TRANSPORT_STREAMABLE_HTTP, host=args.host, port=args.port)
        return
    logger.info("company-control MCP Server v%s 启动（stdio 传输）", __version__)
    mcp.run()


if __name__ == "__main__":
    main()
