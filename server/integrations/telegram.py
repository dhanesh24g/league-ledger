from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

import httpx
from fastapi import HTTPException


@dataclass(slots=True)
class TelegramIntegrationConfig:
    """Environment-backed Telegram configuration placeholder."""

    bot_token: str | None = None
    default_chat_id: str | None = None

    @classmethod
    def from_env(cls) -> "TelegramIntegrationConfig":
        return cls(
            bot_token=os.getenv("TELEGRAM_BOT_TOKEN"),
            default_chat_id=os.getenv("TELEGRAM_DEFAULT_CHAT_ID"),
        )

    def is_configured(self) -> bool:
        return bool(self.bot_token and self.default_chat_id)


@dataclass(slots=True)
class TelegramSendResult:
    """Safe placeholder result until Telegram sending is implemented."""

    sent: bool
    chat_id: str | None = None
    message_id: int | None = None
    reason: str | None = None


def build_telegram_message(*, title: str, lines: list[str]) -> str:
    """Create a compact Telegram-ready message body."""

    body = "\n".join(line.strip() for line in lines if line and line.strip())
    return f"{title.strip()}\n\n{body}".strip()


def send_telegram_message(
    *,
    message: str,
    chat_id: str | None = None,
    config: TelegramIntegrationConfig | None = None,
) -> TelegramSendResult:
    """Send a Telegram bot message using the official Bot API."""

    resolved_config = config or TelegramIntegrationConfig.from_env()
    target_chat_id = str(chat_id or resolved_config.default_chat_id or "").strip()
    token = str(resolved_config.bot_token or "").strip()

    if not token:
        raise HTTPException(status_code=503, detail="Telegram is not configured: missing bot token")
    if not target_chat_id:
        raise HTTPException(status_code=400, detail="Telegram chat ID is required")
    if not str(message or "").strip():
        raise HTTPException(status_code=400, detail="Telegram message cannot be empty")

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {
        "chat_id": target_chat_id,
        "text": str(message).strip(),
        "disable_web_page_preview": True,
    }

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
        raise HTTPException(status_code=502, detail=f"Telegram API rejected the message: {description}")

    result = data.get("result") or {}
    return TelegramSendResult(
        sent=True,
        chat_id=str(result.get("chat", {}).get("id") or target_chat_id),
        message_id=int(result.get("message_id")) if result.get("message_id") is not None else None,
        reason=None,
    )
