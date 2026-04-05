from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class AIContext:
    """Normalized context envelope for future LLM-backed features."""

    league_id: int
    route: str
    actor_user_id: int | None = None
    actor_username: str | None = None
    payload: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class InsightPrompt:
    """Serializable prompt shape for future AI orchestration."""

    system: str
    user: str
    metadata: dict[str, Any] = field(default_factory=dict)


def build_stats_insight_prompt(context: AIContext) -> InsightPrompt:
    """Create a grounded prompt for future `/stats` explanations."""

    league_id = context.league_id
    actor = context.actor_username or "the current user"
    return InsightPrompt(
        system=(
            "You are League Ledger's analytics assistant. Answer only from the structured "
            "league data provided. If the data is incomplete, say so instead of guessing."
        ),
        user=(
            f"Summarize the most important takeaways for league {league_id}. "
            f"Prioritize {actor}'s current position, payouts, and any unusual movements."
        ),
        metadata={
            "route": context.route,
            "league_id": league_id,
            "actor_user_id": context.actor_user_id,
        },
    )


def build_ledger_insight_prompt(context: AIContext) -> InsightPrompt:
    """Create a grounded prompt for future `/ledger` settlement help."""

    league_id = context.league_id
    return InsightPrompt(
        system=(
            "You are League Ledger's settlement assistant. Work only from the supplied rows "
            "and do not invent transfers or payment status."
        ),
        user=(
            f"Explain the cleanest settlement state for league {league_id}. "
            "Call out who is owed money, who owes money, and any obvious clusters."
        ),
        metadata={
            "route": context.route,
            "league_id": league_id,
            "actor_user_id": context.actor_user_id,
        },
    )
