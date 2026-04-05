"""External delivery integrations for future League Ledger automations."""

from .telegram import TelegramIntegrationConfig, TelegramSendResult, build_telegram_message

__all__ = [
    "TelegramIntegrationConfig",
    "TelegramSendResult",
    "build_telegram_message",
]
