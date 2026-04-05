from __future__ import annotations

from pydantic import BaseModel, Field


class LeaguePayload(BaseModel):
    league_id: int | None = None
    sport: str = Field(default="Cricket", min_length=2, max_length=80)
    name: str = Field(min_length=2, max_length=120)
    tournament: str = Field(default="IPL")
    entry_fee: float = Field(gt=0)
    active_player_count: int = Field(default=5, ge=2, le=100)
    default_winner_count: int = Field(default=4, ge=1, le=20)
    payouts: dict[int, float]


class PlayerPayload(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class MatchPayload(BaseModel):
    title: str = Field(min_length=2, max_length=150)
    match_date: str = Field(min_length=4, max_length=40)
    winner_count: int | None = Field(default=None, ge=1, le=20)
    payouts: dict[int, float] | None = None
    participant_ids: list[int] = Field(default_factory=list)


class RankWinners(BaseModel):
    rank: int = Field(ge=1, le=20)
    player_ids: list[int] = Field(default_factory=list)


class WinnersPayload(BaseModel):
    ranks: list[RankWinners]


class LoginPayload(BaseModel):
    user_id: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=200)


class SignupPayload(BaseModel):
    first_name: str = Field(min_length=1, max_length=80)
    last_name: str = Field(min_length=1, max_length=80)
    user_id: str = Field(min_length=3, max_length=80)
    email: str = Field(min_length=5, max_length=160)
    password: str | None = Field(default=None, min_length=8, max_length=200)
    google_token: str | None = Field(default=None, min_length=20, max_length=4096)


class GoogleTokenPayload(BaseModel):
    credential: str = Field(min_length=20, max_length=4096)


class RefreshTokenPayload(BaseModel):
    refresh_token: str = Field(min_length=20, max_length=4096)


class JoinRequestPayload(BaseModel):
    league_id: int | None = None
    invite_code: str | None = Field(default=None, max_length=160)


class MembershipRolePayload(BaseModel):
    role: str = Field(default="read", min_length=4, max_length=16)


class ForgotPasswordPayload(BaseModel):
    identifier: str = Field(min_length=3, max_length=160)


class ResetPasswordPayload(BaseModel):
    token: str = Field(min_length=16, max_length=512)
    new_password: str = Field(min_length=8, max_length=200)


class TelegramTestPayload(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    chat_id: str | None = Field(default=None, min_length=1, max_length=128)


class TelegramConnectSessionPayload(BaseModel):
    target: str = Field(pattern="^(personal|group)$")
    match_id: int | None = Field(default=None, ge=1)


class TelegramNotifyMatchPayload(BaseModel):
    match_id: int = Field(ge=1)
