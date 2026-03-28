from __future__ import annotations

from pydantic import BaseModel, Field


class LeaguePayload(BaseModel):
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


class RankWinners(BaseModel):
    rank: int = Field(ge=1, le=20)
    player_ids: list[int] = Field(default_factory=list)


class WinnersPayload(BaseModel):
    ranks: list[RankWinners]


class LoginPayload(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=200)
