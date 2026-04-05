from __future__ import annotations

import os
from dataclasses import dataclass


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
    reason: str | None = None


def build_telegram_message(*, title: str, lines: list[str]) -> str:
    """Create a compact Telegram-ready message body."""

    body = "\n".join(line.strip() for line in lines if line and line.strip())
    return f"{title.strip()}\n\n{body}".strip()
