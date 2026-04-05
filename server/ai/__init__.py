"""AI scaffolding for future League Ledger automation."""

from .insights import AIContext, InsightPrompt
from .summaries import MatchSummaryRequest, build_match_result_summary, build_washout_summary

__all__ = [
    "AIContext",
    "InsightPrompt",
    "MatchSummaryRequest",
    "build_match_result_summary",
    "build_washout_summary",
]
