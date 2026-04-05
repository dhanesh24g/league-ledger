"""External delivery integrations for future League Ledger automations."""

from .telegram import (
    TelegramIntegrationConfig,
    TelegramSendResult,
    build_telegram_message,
    build_telegram_link,
    ensure_telegram_webhook,
    get_telegram_webhook_info,
    hash_connect_token,
    render_qr_data_uri,
    safe_compare,
    send_telegram_message,
    set_telegram_webhook,
    telegram_api_request,
)

__all__ = [
    "TelegramIntegrationConfig",
    "TelegramSendResult",
    "build_telegram_message",
    "build_telegram_link",
    "ensure_telegram_webhook",
    "get_telegram_webhook_info",
    "hash_connect_token",
    "render_qr_data_uri",
    "safe_compare",
    "send_telegram_message",
    "set_telegram_webhook",
    "telegram_api_request",
]
