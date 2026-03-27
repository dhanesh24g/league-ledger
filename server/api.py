from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from .schemas import LeaguePayload, MatchPayload, PlayerPayload, WinnersPayload
from .service import (
    add_match,
    add_player,
    cancel_match,
    delete_player,
    get_ledger,
    get_state,
    save_winners,
    upsert_league,
)

router = APIRouter(prefix="/api")


@router.get("/state")
def state() -> dict[str, Any]:
    return get_state()


@router.post("/league")
def save_league(payload: LeaguePayload) -> dict[str, str]:
    return upsert_league(payload)


@router.post("/players")
def create_player(payload: PlayerPayload) -> dict[str, str]:
    return add_player(payload)


@router.delete("/players/{player_id}")
def remove_player(player_id: int) -> dict[str, str]:
    return delete_player(player_id)


@router.post("/matches")
def create_match(payload: MatchPayload) -> dict[str, str]:
    return add_match(payload)


@router.post("/matches/{match_id}/winners")
def set_winners(match_id: int, payload: WinnersPayload) -> dict[str, str]:
    return save_winners(match_id, payload)


@router.post("/matches/{match_id}/cancel")
def set_match_canceled(match_id: int) -> dict[str, str]:
    return cancel_match(match_id)


@router.get("/ledger")
def ledger() -> dict[str, Any]:
    return get_ledger()
