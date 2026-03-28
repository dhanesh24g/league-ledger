from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from .auth import auth_config, authenticate, create_token, current_user, require_admin
from .schemas import LeaguePayload, LoginPayload, MatchPayload, PlayerPayload, WinnersPayload
from .service import (
    add_match,
    add_player,
    cancel_match,
    delete_player,
    get_ledger,
    get_stats,
    get_state,
    save_winners,
    upsert_league,
)

router = APIRouter(prefix="/api")


@router.get("/state")
def state(_: dict[str, str] = Depends(current_user)) -> dict[str, Any]:
    return get_state()


@router.post("/league")
def save_league(payload: LeaguePayload, _: dict[str, str] = Depends(require_admin)) -> dict[str, str]:
    return upsert_league(payload)


@router.post("/players")
def create_player(payload: PlayerPayload, _: dict[str, str] = Depends(require_admin)) -> dict[str, str]:
    return add_player(payload)


@router.delete("/players/{player_id}")
def remove_player(player_id: int, _: dict[str, str] = Depends(require_admin)) -> dict[str, str]:
    return delete_player(player_id)


@router.post("/matches")
def create_match(payload: MatchPayload, _: dict[str, str] = Depends(require_admin)) -> dict[str, str]:
    return add_match(payload)


@router.post("/matches/{match_id}/winners")
def set_winners(match_id: int, payload: WinnersPayload, _: dict[str, str] = Depends(require_admin)) -> dict[str, str]:
    return save_winners(match_id, payload)


@router.post("/matches/{match_id}/cancel")
def set_match_canceled(match_id: int, _: dict[str, str] = Depends(require_admin)) -> dict[str, str]:
    return cancel_match(match_id)


@router.get("/ledger")
def ledger(_: dict[str, str] = Depends(current_user)) -> dict[str, Any]:
    return get_ledger()


@router.get("/stats")
def stats(_: dict[str, str] = Depends(current_user)) -> dict[str, Any]:
    return get_stats()


@router.get("/auth/config")
def auth_settings() -> dict[str, Any]:
    return auth_config()


@router.post("/auth/login")
def login(payload: LoginPayload) -> dict[str, Any]:
    user = authenticate(payload.username.strip(), payload.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid username or password")
    token = create_token(user["username"], user["role"])
    return {"token": token, "user": user}


@router.get("/auth/me")
def auth_me(user: dict[str, str] = Depends(current_user)) -> dict[str, Any]:
    return {"user": user}
