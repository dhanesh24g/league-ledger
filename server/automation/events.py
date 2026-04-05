from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class AutomationEventType(StrEnum):
    MATCH_CREATED = "match_created"
    MATCH_COMPLETED = "match_completed"
    MATCH_CANCELED = "match_canceled"
    MATCH_REOPENED = "match_reopened"
    LEDGER_UPDATED = "ledger_updated"


@dataclass(slots=True)
class AutomationEvent:
    """Normalized automation event emitted by business workflows."""

    type: AutomationEventType
    league_id: int
    actor_user_id: int | None = None
    match_id: int | None = None
    payload: dict[str, Any] = field(default_factory=dict)
