from __future__ import annotations

import base64
import hashlib
import hmac
import io
import os
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx
from fastapi import HTTPException

try:
    import segno
except ImportError:  # pragma: no cover - optional dependency until environment install
    segno = None


@dataclass(slots=True)
class TelegramIntegrationConfig:
    bot_token: str | None = None
    bot_username: str | None = None
    default_chat_id: str | None = None
    app_base_url: str | None = None
    webhook_secret: str | None = None

    @classmethod
    def from_env(cls) -> "TelegramIntegrationConfig":
        return cls(
            bot_token=os.getenv("TELEGRAM_BOT_TOKEN") or os.getenv("BOT_KEY"),
            bot_username=(os.getenv("TELEGRAM_BOT_USERNAME") or os.getenv("BOT_USERNAME") or "").lstrip("@") or None,
            default_chat_id=os.getenv("TELEGRAM_DEFAULT_CHAT_ID"),
            app_base_url=os.getenv("APP_BASE_URL") or os.getenv("PUBLIC_BASE_URL"),
            webhook_secret=os.getenv("TELEGRAM_WEBHOOK_SECRET"),
        )

    def is_bot_ready(self) -> bool:
        return bool(self.bot_token and self.bot_username)

    def is_webhook_ready(self) -> bool:
        return bool(self.is_bot_ready() and self.app_base_url and self.webhook_secret)

    def webhook_url(self) -> str | None:
        if not self.is_webhook_ready():
            return None
        return f"{str(self.app_base_url).rstrip('/')}/api/integrations/telegram/webhook/{self.webhook_secret}"


@dataclass(slots=True)
class TelegramSendResult:
    sent: bool
    chat_id: str | None = None
    message_id: int | None = None
    reason: str | None = None


def build_telegram_message(*, title: str, lines: list[str]) -> str:
    body = "\n".join(line.strip() for line in lines if line and line.strip())
    return f"{title.strip()}\n\n{body}".strip()


def hash_connect_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def build_telegram_link(bot_username: str, token: str, target: str) -> str:
    safe_username = str(bot_username or "").lstrip("@").strip()
    if not safe_username:
        raise HTTPException(status_code=503, detail="Telegram bot username is not configured")
    encoded = quote(token, safe="")
    param = "startgroup" if target == "group" else "start"
    return f"https://t.me/{safe_username}?{param}={encoded}"


def render_qr_data_uri(value: str) -> str | None:
    if not value or segno is None:
        return None

    buffer = io.BytesIO()
    qr = segno.make(value, error="m")
    qr.save(buffer, kind="png", scale=6, border=2, dark="#0b1020", light="#ffffff")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def telegram_api_request(config: TelegramIntegrationConfig, method: str, payload: dict[str, Any]) -> dict[str, Any]:
    token = str(config.bot_token or "").strip()
    if not token:
        raise HTTPException(status_code=503, detail="Telegram is not configured: missing bot token")

    url = f"https://api.telegram.org/bot{token}/{method}"
    try:
        with httpx.Client(timeout=15.0) as client:
            response = client.post(url, json=payload)
            response.raise_for_status()
            data: dict[str, Any] = response.json()
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text or str(exc)
        raise HTTPException(status_code=502, detail=f"Telegram API request failed: {detail}") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Telegram transport failed: {exc}") from exc

    if not data.get("ok"):
        description = str(data.get("description") or "Unknown Telegram error")
        raise HTTPException(status_code=502, detail=f"Telegram API rejected the request: {description}")
    return data


def set_telegram_webhook(config: TelegramIntegrationConfig) -> dict[str, Any]:
    webhook_url = config.webhook_url()
    if not webhook_url:
        raise HTTPException(status_code=400, detail="Webhook URL is not configured")
    return telegram_api_request(
        config,
        "setWebhook",
        {
            "url": webhook_url,
            "drop_pending_updates": False,
            "allowed_updates": ["message"],
        },
    )


def get_telegram_webhook_info(config: TelegramIntegrationConfig) -> dict[str, Any]:
    return telegram_api_request(config, "getWebhookInfo", {})


def ensure_telegram_webhook(config: TelegramIntegrationConfig) -> dict[str, Any]:
    expected_url = config.webhook_url()
    if not expected_url:
        raise HTTPException(status_code=400, detail="Webhook URL is not configured")

    info = get_telegram_webhook_info(config)
    result = info.get("result") or {}
    current_url = str(result.get("url") or "")
    if current_url == expected_url:
        return info
    set_telegram_webhook(config)
    return get_telegram_webhook_info(config)


def send_telegram_message(
    *,
    message: str,
    chat_id: str | None = None,
    config: TelegramIntegrationConfig | None = None,
) -> TelegramSendResult:
    resolved_config = config or TelegramIntegrationConfig.from_env()
    target_chat_id = str(chat_id or resolved_config.default_chat_id or "").strip()

    if not target_chat_id:
        raise HTTPException(status_code=400, detail="Telegram chat ID is required")
    if not str(message or "").strip():
        raise HTTPException(status_code=400, detail="Telegram message cannot be empty")

    data = telegram_api_request(
        resolved_config,
        "sendMessage",
        {
            "chat_id": target_chat_id,
            "text": str(message).strip(),
            "disable_web_page_preview": True,
        },
    )
    result = data.get("result") or {}
    return TelegramSendResult(
        sent=True,
        chat_id=str(result.get("chat", {}).get("id") or target_chat_id),
        message_id=int(result.get("message_id")) if result.get("message_id") is not None else None,
        reason=None,
    )


def safe_compare(value: str | None, expected: str | None) -> bool:
    return hmac.compare_digest(str(value or ""), str(expected or ""))
