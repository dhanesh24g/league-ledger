from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any

from fastapi import Depends, Header, HTTPException

TOKEN_TTL_SECONDS = 60 * 60 * 24


def _secret() -> bytes:
    return os.getenv("APP_AUTH_SECRET", "league-ledger-secret").encode("utf-8")


def _auth_enabled() -> bool:
    return os.getenv("APP_AUTH_ENABLED", "true").lower() not in {"0", "false", "no", "off"}


def _users() -> dict[str, dict[str, str]]:
    admin_user = os.getenv("APP_ADMIN_USERNAME", "admin")
    admin_pass = os.getenv("APP_ADMIN_PASSWORD", "admin123")
    viewer_user = os.getenv("APP_VIEWER_USERNAME", "viewer")
    viewer_pass = os.getenv("APP_VIEWER_PASSWORD", "viewer123")

    return {
        admin_user: {"password": admin_pass, "role": "admin"},
        viewer_user: {"password": viewer_pass, "role": "viewer"},
    }


def auth_config() -> dict[str, Any]:
    users = _users()
    return {
        "enabled": _auth_enabled(),
        "roles": sorted({meta["role"] for meta in users.values()}),
        "default_users": [
            {"username": username, "role": meta["role"]}
            for username, meta in users.items()
        ],
    }


def authenticate(username: str, password: str) -> dict[str, str] | None:
    users = _users()
    meta = users.get(username)
    if not meta:
        return None
    if meta["password"] != password:
        return None
    return {"username": username, "role": meta["role"]}


def _encode(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")


def _decode(raw: str) -> dict[str, Any]:
    pad = "=" * (-len(raw) % 4)
    data = base64.urlsafe_b64decode((raw + pad).encode("utf-8"))
    return json.loads(data.decode("utf-8"))


def create_token(username: str, role: str) -> str:
    payload = {
        "sub": username,
        "role": role,
        "iat": int(time.time()),
        "exp": int(time.time()) + TOKEN_TTL_SECONDS,
    }
    payload_part = _encode(payload)
    sig = hmac.new(_secret(), payload_part.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{payload_part}.{sig}"


def decode_token(token: str) -> dict[str, Any]:
    try:
        payload_part, sig = token.split(".", 1)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Invalid token") from exc

    expected = hmac.new(_secret(), payload_part.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        raise HTTPException(status_code=401, detail="Invalid token signature")

    payload = _decode(payload_part)
    if int(payload.get("exp", 0)) < int(time.time()):
        raise HTTPException(status_code=401, detail="Token expired")

    return payload


def current_user(authorization: str | None = Header(default=None)) -> dict[str, str]:
    if not _auth_enabled():
        return {"username": "local-admin", "role": "admin"}

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")

    token = authorization.split(" ", 1)[1].strip()
    payload = decode_token(token)
    role = str(payload.get("role", "")).lower()
    username = str(payload.get("sub", ""))

    if role not in {"admin", "viewer"} or not username:
        raise HTTPException(status_code=401, detail="Invalid token payload")

    return {"username": username, "role": role}


def require_admin(user: dict[str, str] = Depends(current_user)) -> dict[str, str]:
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")
    return user
