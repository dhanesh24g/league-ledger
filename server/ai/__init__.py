"""AI scaffolding for League Ledger automation."""

from .aliases import AliasMatch, PlayerRef, normalize_alias, resolve
from .insights import AIContext, InsightPrompt
from .summaries import MatchSummaryRequest, build_match_result_summary, build_washout_summary
from .vision import LeaderboardRow, extract_leaderboard, vision_available

__all__ = [
    "AIContext",
    "AliasMatch",
    "InsightPrompt",
    "LeaderboardRow",
    "MatchSummaryRequest",
    "PlayerRef",
    "build_match_result_summary",
    "build_washout_summary",
    "extract_leaderboard",
    "normalize_alias",
    "resolve",
    "vision_available",
]
