from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class MatchSummaryRequest:
    """Canonical payload for future AI-generated league summaries."""

    league_name: str
    match_number: int | None
    match_title: str
    match_date: str | None = None
    settled_amount: float | int = 0
    winners_by_rank: dict[int, list[str]] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)


def build_match_result_summary(request: MatchSummaryRequest) -> str:
    """Deterministic placeholder summary suitable for bots or email fallback."""

    match_label = (
        f"Match #{request.match_number}: {request.match_title}"
        if request.match_number
        else request.match_title
    )
    lines = [match_label]
    if request.match_date:
        lines.append(f"Date: {request.match_date}")

    for rank in sorted(request.winners_by_rank):
        players = ", ".join(request.winners_by_rank[rank]) or "TBD"
        title = {
            1: "Champion",
            2: "Runner-up",
            3: "Third place",
        }.get(rank, f"Rank {rank}")
        lines.append(f"{title}: {players}")

    lines.append(f"Settled: {float(request.settled_amount or 0):.2f}")
    return "\n".join(lines)


def build_washout_summary(
    *,
    league_name: str,
    match_number: int | None,
    match_title: str,
    participant_count: int,
    refund_amount_each: float | int,
) -> str:
    """Deterministic placeholder washout summary."""

    match_label = (
        f"Match #{match_number}: {match_title}"
        if match_number
        else match_title
    )
    return "\n".join(
        [
            match_label,
            "Status: Washout / Cancelled",
            f"Participants refunded equally: {participant_count}",
            f"Refund each: {float(refund_amount_each or 0):.2f}",
        ]
    )
