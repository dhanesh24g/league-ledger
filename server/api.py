from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from .auth import (
    approve_join_request,
    authenticate_google,
    auth_config,
    authenticate,
    create_join_request,
    create_refresh_token,
    create_token,
    current_user,
    reject_join_request,
    request_password_reset,
    reset_password,
    refresh_session,
    get_league_by_invite_code,
    suggest_user_ids,
    user_id_availability,
    verify_google_token,
    list_league_members,
    list_join_requests,
    remove_league_member,
    require_active_member,
    require_admin,
    signup_user,
    update_membership_role,
)
from .schemas import ForgotPasswordPayload, GoogleTokenPayload, JoinRequestPayload, LeaguePayload, LoginPayload, MatchPayload, MembershipRolePayload, PlayerPayload, RefreshTokenPayload, ResetPasswordPayload, SignupPayload, WinnersPayload
from .service import (
    add_match,
    add_player,
    cancel_match,
    delete_player,
    get_ledger,
    get_stats,
    get_state,
    save_winners,
)
from .supabase_service import (
    upsert_league,
)

router = APIRouter(prefix="/api")


@router.get("/state")
def state(user: dict[str, Any] = Depends(require_active_member)) -> dict[str, Any]:
    return get_state(user)


@router.post("/league")
def save_league(
    payload: LeaguePayload,
    create_new: bool = False,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return upsert_league(payload, user, create_new=create_new)


@router.post("/players")
def create_player(payload: PlayerPayload, user: dict[str, Any] = Depends(require_admin)) -> dict[str, str]:
    raise HTTPException(status_code=400, detail="Manual player add is disabled. Invite users to join the league instead.")


@router.delete("/players/{player_id}")
def remove_player(player_id: int, user: dict[str, Any] = Depends(require_admin)) -> dict[str, str]:
    return delete_player(player_id, user)


@router.post("/matches")
def create_match(payload: MatchPayload, user: dict[str, Any] = Depends(require_admin)) -> dict[str, str]:
    return add_match(payload, user)


@router.post("/matches/{match_id}/winners")
def set_winners(match_id: int, payload: WinnersPayload, user: dict[str, Any] = Depends(require_admin)) -> dict[str, str]:
    return save_winners(match_id, payload, user)


@router.post("/matches/{match_id}/cancel")
def set_match_canceled(match_id: int, user: dict[str, Any] = Depends(require_admin)) -> dict[str, str]:
    return cancel_match(match_id, user)


@router.get("/ledger")
def ledger(user: dict[str, Any] = Depends(require_active_member)) -> dict[str, Any]:
    return get_ledger(user)


@router.get("/stats")
def stats(user: dict[str, Any] = Depends(require_active_member)) -> dict[str, Any]:
    return get_stats(user)


@router.get("/auth/config")
def auth_settings() -> dict[str, Any]:
    return auth_config()


@router.get("/auth/user-id-check")
def auth_user_id_check(user_id: str) -> dict[str, Any]:
    return user_id_availability(user_id)


@router.get("/auth/user-id-suggestions")
def auth_user_id_suggestions(first_name: str = "", last_name: str = "") -> dict[str, Any]:
    return suggest_user_ids(first_name, last_name)


@router.post("/auth/google/profile")
def auth_google_profile(payload: GoogleTokenPayload) -> dict[str, Any]:
    return {"profile": verify_google_token(payload.credential)}


@router.post("/auth/signup")
def signup(payload: SignupPayload) -> dict[str, Any]:
    user = signup_user(
        payload.first_name,
        payload.last_name,
        payload.user_id,
        payload.email,
        payload.password,
        payload.google_token,
    )
    token = create_token(user)
    refresh_token = create_refresh_token(user)
    return {"token": token, "refresh_token": refresh_token, "user": user}


@router.post("/auth/login")
def login(payload: LoginPayload, x_league_id: str | None = None) -> dict[str, Any]:
    requested_league_id = int(x_league_id) if x_league_id and x_league_id.isdigit() else None
    user = authenticate(payload.user_id.strip(), payload.password, requested_league_id=requested_league_id)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid user ID or password")
    token = create_token(user)
    refresh_token = create_refresh_token(user)
    return {"token": token, "refresh_token": refresh_token, "user": user}


@router.post("/auth/google")
def google_login(payload: GoogleTokenPayload, x_league_id: str | None = None) -> dict[str, Any]:
    requested_league_id = int(x_league_id) if x_league_id and x_league_id.isdigit() else None
    user = authenticate_google(payload.credential, requested_league_id=requested_league_id)
    token = create_token(user)
    refresh_token = create_refresh_token(user)
    return {"token": token, "refresh_token": refresh_token, "user": user}


@router.post("/auth/refresh")
def auth_refresh(payload: RefreshTokenPayload, x_league_id: str | None = None) -> dict[str, Any]:
    requested_league_id = int(x_league_id) if x_league_id and x_league_id.isdigit() else None
    return refresh_session(payload.refresh_token, requested_league_id=requested_league_id)


@router.post("/auth/forgot-password")
def forgot_password(payload: ForgotPasswordPayload) -> dict[str, Any]:
    return request_password_reset(payload.identifier)


@router.post("/auth/reset-password")
def password_reset(payload: ResetPasswordPayload) -> dict[str, str]:
    return reset_password(payload.token, payload.new_password)


@router.get("/auth/me")
def auth_me(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"user": user}


@router.get("/leagues/invite/{invite_code}")
def invite_preview(invite_code: str) -> dict[str, Any]:
    return {"league": get_league_by_invite_code(invite_code)}


@router.post("/auth/join-request")
def join_request(payload: JoinRequestPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, str]:
    return create_join_request(user, league_id=payload.league_id, invite_code=payload.invite_code)


@router.get("/league/requests")
def join_requests(user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    return list_join_requests(user)


@router.post("/league/requests/{request_id}/approve")
def approve_request(
    request_id: int,
    payload: MembershipRolePayload,
    user: dict[str, Any] = Depends(require_admin),
) -> dict[str, str]:
    return approve_join_request(request_id, user, role="read")


@router.post("/league/requests/{request_id}/reject")
def reject_request(request_id: int, user: dict[str, Any] = Depends(require_admin)) -> dict[str, str]:
    return reject_join_request(request_id, user)


@router.get("/league/members")
def league_members(user: dict[str, Any] = Depends(require_active_member)) -> dict[str, Any]:
    return list_league_members(user)


@router.delete("/league/members/{member_user_id}")
def delete_member(member_user_id: int, user: dict[str, Any] = Depends(require_admin)) -> dict[str, str]:
    return remove_league_member(member_user_id, user)


@router.patch("/league/members/{member_user_id}/role")
def change_member_role(
    member_user_id: int,
    payload: MembershipRolePayload,
    user: dict[str, Any] = Depends(require_admin),
) -> dict[str, str]:
    return update_membership_role(member_user_id, payload.role, user)
