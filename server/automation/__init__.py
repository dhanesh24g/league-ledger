"""Event and notification scaffolding for future automation flows."""

from .events import AutomationEvent, AutomationEventType
from .notifications import NotificationDispatchResult, build_notification_payload

__all__ = [
    "AutomationEvent",
    "AutomationEventType",
    "NotificationDispatchResult",
    "build_notification_payload",
]
