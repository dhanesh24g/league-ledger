from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from .auth import (
    approve_join_request,
    auth_config,
    authenticate,
    create_join_request,
    create_token,
    current_user,
    list_join_requests,
    require_active_member,
    require_admin,
    signup_user,
)
from .schemas import LeaguePayload, LoginPayload, MatchPayload, PlayerPayload, SignupPayload, WinnersPayload
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
def state(_: dict[str, Any] = Depends(require_active_member)) -> dict[str, Any]:
    return get_state()


@router.post("/league")
def save_league(payload: LeaguePayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, str]:
    return upsert_league(payload, user)


@router.post("/players")
def create_player(payload: PlayerPayload, _: dict[str, Any] = Depends(require_admin)) -> dict[str, str]:
    return add_player(payload)


@router.delete("/players/{player_id}")
def remove_player(player_id: int, _: dict[str, Any] = Depends(require_admin)) -> dict[str, str]:
    return delete_player(player_id)


@router.post("/matches")
def create_match(payload: MatchPayload, _: dict[str, Any] = Depends(require_admin)) -> dict[str, str]:
    return add_match(payload)


@router.post("/matches/{match_id}/winners")
def set_winners(match_id: int, payload: WinnersPayload, _: dict[str, Any] = Depends(require_admin)) -> dict[str, str]:
    return save_winners(match_id, payload)


@router.post("/matches/{match_id}/cancel")
def set_match_canceled(match_id: int, _: dict[str, Any] = Depends(require_admin)) -> dict[str, str]:
    return cancel_match(match_id)


@router.get("/ledger")
def ledger(_: dict[str, Any] = Depends(require_active_member)) -> dict[str, Any]:
    return get_ledger()


@router.get("/stats")
def stats(_: dict[str, Any] = Depends(require_active_member)) -> dict[str, Any]:
    return get_stats()


@router.get("/auth/config")
def auth_settings() -> dict[str, Any]:
    return auth_config()


@router.post("/auth/signup")
def signup(payload: SignupPayload) -> dict[str, Any]:
    user = signup_user(
        payload.first_name,
        payload.last_name,
        payload.user_id,
        payload.email,
        payload.password,
    )
    token = create_token(user)
    return {"token": token, "user": user}


@router.post("/auth/login")
def login(payload: LoginPayload) -> dict[str, Any]:
    user = authenticate(payload.user_id.strip(), payload.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid user ID or password")
    token = create_token(user)
    return {"token": token, "user": user}


@router.get("/auth/me")
def auth_me(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"user": user}


@router.post("/auth/join-request")
def join_request(user: dict[str, Any] = Depends(current_user)) -> dict[str, str]:
    return create_join_request(user)


@router.get("/league/requests")
def join_requests(user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    return list_join_requests(user)


@router.post("/league/requests/{request_id}/approve")
def approve_request(request_id: int, user: dict[str, Any] = Depends(require_admin)) -> dict[str, str]:
    return approve_join_request(request_id, user)
