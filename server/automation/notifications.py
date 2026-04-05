from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .events import AutomationEvent


@dataclass(slots=True)
class NotificationDispatchResult:
    """Return shape for future delivery providers."""

    delivered: bool
    channel: str
    reason: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


def build_notification_payload(event: AutomationEvent) -> dict[str, Any]:
    """Create a stable notification envelope from an automation event."""

    return {
        "event_type": event.type.value,
        "league_id": event.league_id,
        "match_id": event.match_id,
        "actor_user_id": event.actor_user_id,
        "payload": event.payload,
    }
