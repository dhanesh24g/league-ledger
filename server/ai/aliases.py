"""Alias normalization and best-match resolution for screenshot extraction.

The screenshot's display names (e.g. "Ravi_Bhai") rarely match the League
Ledger player names exactly. We resolve matches in this priority order:

    1. Exact alias lookup in `player_aliases` (already confirmed by an admin).
    2. Exact case-insensitive match against `players.name`.
    3. Fuzzy match against player names above a confidence threshold.

Anything below the threshold is returned as `match=None` so the admin can
pick a player in the confirmation UI; the choice is then written back to
`player_aliases` so future screenshots resolve automatically.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Iterable

_FUZZY_THRESHOLD = 0.72
_FUZZY_STRONG = 0.90


@dataclass(slots=True)
class PlayerRef:
    id: int
    name: str


@dataclass(slots=True)
class AliasMatch:
    player_id: int | None
    player_name: str | None
    confidence: float
    source: str  # 'alias' | 'exact' | 'fuzzy' | 'none'


def normalize_alias(value: str) -> str:
    """Canonical form used for alias lookups and comparisons.

    Lowercase, strip, collapse non-alphanumeric runs to a single space.
    Screenshots often have underscores, dots, emoji suffixes etc., and we
    want `"Ravi_Bhai 🏏"` and `"ravi bhai"` to collide in lookup.
    """

    cleaned = re.sub(r"[^0-9a-zA-Z]+", " ", str(value or "")).strip().lower()
    return re.sub(r"\s+", " ", cleaned)


def resolve(
    display_name: str,
    players: Iterable[PlayerRef],
    aliases: dict[str, int],
) -> AliasMatch:
    """Resolve a single display name to a player_id if possible."""

    normalized = normalize_alias(display_name)
    if not normalized:
        return AliasMatch(None, None, 0.0, "none")

    player_list = list(players)
    player_by_id = {p.id: p for p in player_list}

    if normalized in aliases:
        pid = aliases[normalized]
        ref = player_by_id.get(pid)
        if ref is not None:
            return AliasMatch(ref.id, ref.name, 1.0, "alias")

    for player in player_list:
        if normalize_alias(player.name) == normalized:
            return AliasMatch(player.id, player.name, 1.0, "exact")

    best: tuple[float, PlayerRef | None] = (0.0, None)
    for player in player_list:
        ratio = SequenceMatcher(None, normalized, normalize_alias(player.name)).ratio()
        if ratio > best[0]:
            best = (ratio, player)

    score, player = best
    if player is not None and score >= _FUZZY_THRESHOLD:
        source = "fuzzy" if score < _FUZZY_STRONG else "fuzzy"
        return AliasMatch(player.id, player.name, round(score, 3), source)

    return AliasMatch(None, None, round(score, 3), "none")
