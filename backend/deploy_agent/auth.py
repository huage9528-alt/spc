from __future__ import annotations

from typing import Annotated

import jwt
from fastapi import Depends, Header, HTTPException, status

from .config import get_settings


async def verify_token(
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
) -> dict:
    """校验 JWT。

    service-to-service 鉴权：不校验 login_version / jti（agent 不是终端用户）。
    仅校验签名 + 过期。生产环境请务必把 jwt_secret 配为强随机串。
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing Authorization: Bearer <token>",
        )
    token = authorization.split(None, 1)[1].strip()
    settings = get_settings()
    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=settings.jwt_algorithms,
            options={"require": ["exp"]},
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="token expired"
        ) from None
    except jwt.InvalidTokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=f"invalid token: {exc}"
        ) from None
    if "sub" not in payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="token missing sub"
        )
    return payload


TokenPayload = Annotated[dict, Depends(verify_token)]
