import time
import logging
import re
import secrets
import json
import math
from datetime import datetime, timedelta, timezone
from threading import Lock
from typing import Any

from fastapi import HTTPException

try:
    from postgrest import APIError
except ImportError:
    APIError = None

from .auth import get_supabase_client, invalidate_profile_cache
from .database import parse_participant_ids, parse_payouts
from .integrations import (
    TelegramIntegrationConfig,
    build_telegram_link,
    build_telegram_message,
    ensure_telegram_webhook,
    get_telegram_webhook_info,
    hash_connect_token,
    render_qr_data_uri,
    send_telegram_message,
    set_telegram_webhook,
)
from .ai import (
    LeaderboardRow,
    PlayerRef,
    extract_leaderboard,
    normalize_alias,
    resolve as resolve_alias,
)
from .schemas import (
    BulkAliasPayload,
    LeaguePayload,
    MatchPayload,
    PlayerPayload,
    WinnersPayload,
)
logger = logging.getLogger(__name__)

_CACHE_TTL_SECONDS = 20.0
_LEAGUE_READ_CACHE: dict[tuple[int, str], tuple[float, dict[str, Any]]] = {}
_LEAGUE_READ_CACHE_LOCK = Lock()
TELEGRAM_EXPIRED_SESSION_RETENTION_DAYS = 30
TELEGRAM_MAX_PENDING_SESSIONS_PER_LEAGUE = 2


def _cache_get(league_id: int, scope: str) -> dict[str, Any] | None:
    now = time.monotonic()
    key = (int(league_id), scope)
    with _LEAGUE_READ_CACHE_LOCK:
        row = _LEAGUE_READ_CACHE.get(key)
        if not row:
            return None
        expires_at, payload = row
        if now >= expires_at:
            _LEAGUE_READ_CACHE.pop(key, None)
            return None
        return payload


def _cache_set(league_id: int, scope: str, payload: dict[str, Any]) -> None:
    key = (int(league_id), scope)
    expires_at = time.monotonic() + _CACHE_TTL_SECONDS
    with _LEAGUE_READ_CACHE_LOCK:
        _LEAGUE_READ_CACHE[key] = (expires_at, payload)


def _invalidate_league_cache(league_id: int, scopes: set[str] | None = None) -> None:
    prefix = int(league_id)
    target_scopes = scopes or {"state", "ledger", "stats"}
    with _LEAGUE_READ_CACHE_LOCK:
        for key in list(_LEAGUE_READ_CACHE.keys()):
            cache_league_id, cache_scope = key
            if cache_league_id == prefix and cache_scope in target_scopes:
                _LEAGUE_READ_CACHE.pop(key, None)


def _league_id_from_user(user: dict[str, Any]) -> int:
    league_id = user.get("active_league_id")
    if not league_id:
        raise HTTPException(status_code=400, detail="Select a league first")
    return int(league_id)


def _telegram_cleanup_cutoff() -> datetime:
    return _utc_now() - timedelta(days=TELEGRAM_EXPIRED_SESSION_RETENTION_DAYS)


def _purge_expired_telegram_sessions(supabase: Any, league_id: int | None = None, user_id: int | None = None) -> None:
    query = (
        supabase.table("telegram_link_sessions")
        .delete()
        .is_("consumed_at", "null")
        .lt("expires_at", _isoformat(_telegram_cleanup_cutoff()))
    )
    if league_id is not None:
        query = query.eq("league_id", int(league_id))
    if user_id is not None:
        query = query.eq("created_by_user_id", int(user_id))
    query.execute()


def _admin_league_count(supabase: Any, user_id: int) -> int:
    response = (
        supabase.table("league_memberships")
        .select("league_id", count="exact")
        .eq("user_id", int(user_id))
        .eq("status", "active")
        .eq("role", "admin")
        .execute()
    )
    return max(1, int(response.count or 0))


def _ensure_telegram_connect_session_capacity(supabase: Any, league_id: int, user_id: int) -> None:
    _purge_expired_telegram_sessions(supabase, user_id=user_id)
    league_count = _admin_league_count(supabase, user_id)
    total_limit = max(TELEGRAM_MAX_PENDING_SESSIONS_PER_LEAGUE, league_count * TELEGRAM_MAX_PENDING_SESSIONS_PER_LEAGUE)
    now_iso = _isoformat(_utc_now())

    total_response = (
        supabase.table("telegram_link_sessions")
        .select("id", count="exact")
        .eq("created_by_user_id", int(user_id))
        .is_("consumed_at", "null")
        .gte("expires_at", now_iso)
        .execute()
    )
    total_pending = int(total_response.count or 0)
    if total_pending >= total_limit:
        raise HTTPException(
            status_code=429,
            detail=f"Too many active Telegram connect sessions. Finish or wait for an existing session to expire before creating more (limit {total_limit}).",
        )

    league_response = (
        supabase.table("telegram_link_sessions")
        .select("id", count="exact")
        .eq("created_by_user_id", int(user_id))
        .eq("league_id", int(league_id))
        .is_("consumed_at", "null")
        .gte("expires_at", now_iso)
        .execute()
    )
    league_pending = int(league_response.count or 0)
    if league_pending >= TELEGRAM_MAX_PENDING_SESSIONS_PER_LEAGUE:
        raise HTTPException(
            status_code=429,
            detail="This league already has the maximum active Telegram connect sessions. Finish one before creating another.",
        )


def _member_player_name(member: dict[str, Any]) -> str:
    user_id_label = str(member.get("user_id") or "").strip()
    if user_id_label:
        return user_id_label
    first = str(member.get("first_name") or "").strip()
    last = str(member.get("last_name") or "").strip()
    full = f"{first} {last}".strip()
    return full or "member"


def _generate_invite_code(name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-") or "league"
    token = secrets.token_hex(2)
    code = f"{base}-{token}"
    return code[:120]


def _sync_active_members_to_players(supabase: Any, league_id: int) -> list[dict[str, Any]]:
    max_retries = 3
    for attempt in range(max_retries):
        try:
            memberships_response = (
                supabase.table("league_memberships")
                .select("user_id")
                .eq("league_id", league_id)
                .eq("status", "active")
                .execute()
            )
            break
        except Exception as exc:
            if attempt == max_retries - 1:
                logger.error(f"Failed to fetch memberships after {max_retries} attempts: {str(exc)}")
                raise
            logger.warning(f"Retry {attempt + 1}/{max_retries} for memberships query: {str(exc)}")
            time.sleep(0.5 * (attempt + 1))
    membership_user_ids = sorted({int(row["user_id"]) for row in (memberships_response.data or [])})
    if not membership_user_ids:
        return []

    users_response = (
        supabase.table("users")
        .select("id, first_name, last_name, user_id")
        .in_("id", membership_user_ids)
        .execute()
    )
    users_by_id = {int(row["id"]): row for row in (users_response.data or [])}

    desired_names: list[str] = []
    seen_names: set[str] = set()
    for user_id in membership_user_ids:
        row = users_by_id.get(user_id)
        if not row:
            continue
        player_name = _member_player_name(row)
        if not player_name or player_name in seen_names:
            continue
        seen_names.add(player_name)
        desired_names.append(player_name)

    if not desired_names:
        return []

    existing_players_response = (
        supabase.table("players")
        .select("id, name")
        .eq("league_id", league_id)
        .execute()
    )
    existing_names = {str(row.get("name") or "") for row in (existing_players_response.data or [])}

    missing_names = [name for name in desired_names if name not in existing_names]
    if missing_names:
        try:
            supabase.table("players").insert(
                [{"league_id": league_id, "name": player_name} for player_name in missing_names]
            ).execute()
        except Exception as exc:
            logger.error(f"Failed to insert players for league {league_id}: {str(exc)}", exc_info=True)
            raise

    players_response = (
        supabase.table("players")
        .select("id, name")
        .eq("league_id", league_id)
        .order("name")
        .execute()
    )
    desired_set = set(desired_names)
    return [row for row in (players_response.data or []) if str(row.get("name") or "") in desired_set]


def _validate_league_payouts(payload: LeaguePayload) -> None:
    payouts = payload.payouts or {}
    if not payouts:
        raise HTTPException(status_code=400, detail="Add at least one winner payout")

    normalized: list[tuple[int, float]] = []
    for rank, amount in payouts.items():
        try:
            rank_num = int(rank)
            amount_num = float(amount)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Winner payouts contain invalid rank or amount")

        if rank_num < 1:
            raise HTTPException(status_code=400, detail="Winner payout ranks must start from 1")
        if not math.isfinite(amount_num) or amount_num <= 0:
            raise HTTPException(status_code=400, detail=f"Winner payout for rank {rank_num} must be greater than 0")

        normalized.append((rank_num, round(amount_num, 2)))

    normalized.sort(key=lambda item: item[0])
    actual_ranks = [rank for rank, _ in normalized]
    expected_ranks = list(range(1, len(normalized) + 1))
    if actual_ranks != expected_ranks:
        raise HTTPException(status_code=400, detail="Winner payout ranks must be continuous: 1, 2, 3...")

    winner_count = len(normalized)
    if winner_count != int(payload.default_winner_count):
        raise HTTPException(status_code=400, detail="Default winner count must match the number of payout rows")
    if winner_count > int(payload.active_player_count):
        raise HTTPException(status_code=400, detail="Winner count cannot exceed active league players")

    payout_total = round(sum(amount for _, amount in normalized), 2)
    prize_pool = round(float(payload.entry_fee) * int(payload.active_player_count), 2)
    if abs(payout_total - prize_pool) >= 0.01:
        raise HTTPException(
            status_code=400,
            detail=f"Winner payout total ({payout_total:.2f}) must match prize pool ({prize_pool:.2f})",
        )


def _normalize_participant_ids(raw_ids: list[int] | tuple[int, ...] | None) -> list[int]:
    normalized: list[int] = []
    seen: set[int] = set()
    for item in raw_ids or []:
        try:
            player_id = int(item)
        except (TypeError, ValueError):
            continue
        if player_id in seen:
            continue
        seen.add(player_id)
        normalized.append(player_id)
    return normalized


def _rank_label(rank: int, status: str, has_result: bool) -> str:
    if rank == 0:
        return "Washout / Refund"
    if rank == 1:
        return "Champion"
    if rank == 2:
        return "Runner-up"
    if rank == 3:
        return "Third place"
    if rank > 3:
        return f"Rank {rank}"
    if status == "pending":
        return "Scheduled"
    if status == "canceled":
        return "Washout"
    if status == "completed":
        return "Played"
    return "Played" if has_result else status.title()


def _build_refund_rows(match_id: int, participant_ids: list[int], entry_fee: float) -> list[dict[str, Any]]:
    if not participant_ids:
        return []
    pool = float(entry_fee) * len(participant_ids)
    split = round(pool / len(participant_ids), 2)
    remainder = round(pool - (split * len(participant_ids)), 2)
    rows: list[dict[str, Any]] = []
    for idx, player_id in enumerate(participant_ids):
        amount = split + (remainder if idx == 0 else 0.0)
        rows.append(
            {
                "match_id": int(match_id),
                "rank": 0,
                "player_id": int(player_id),
                "amount": round(amount, 2),
            }
        )
    return rows


def _build_match_number_map(matches: list[dict[str, Any]]) -> dict[int, int]:
    ordered_ids = sorted(int(match["id"]) for match in matches)
    return {match_id: index + 1 for index, match_id in enumerate(ordered_ids)}


def get_state(user: dict[str, Any]) -> dict[str, Any]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    league_id = _league_id_from_user(user)
    cached = _cache_get(league_id, "state")
    if cached is not None:
        return cached
    
    try:
        # Get league data
        league_response = supabase.table("league").select("*").eq("id", league_id).limit(1).execute()
        league = league_response.data[0] if league_response.data else None

        players = _sync_active_members_to_players(supabase, league_id)
        
        # Get matches
        matches_response = supabase.table("matches").select("*").eq("league_id", league_id).order("id", desc=True).execute()
        matches = matches_response.data
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
    fallback_participant_ids = [int(player["id"]) for player in players]
    match_number_map = _build_match_number_map(matches)

    response = {
        "league": {
            "sport": league.get("sport") or "Cricket",
            "name": league["name"],
            "tournament": league["tournament"],
            "entry_fee": league["entry_fee"],
            "active_player_count": league["active_player_count"],
            "default_winner_count": league["default_winner_count"],
            "payouts": parse_payouts(league["payouts_json"]),
            "invite_code": league.get("invite_code"),
            "invite_link": f"/join/{league['invite_code']}" if league.get("invite_code") else None,
        }
        if league
        else None,
        "players": players,
        "matches": [
            {
                **match,
                "match_number": match_number_map.get(int(match["id"]), 0),
                "payouts": parse_payouts(match["payouts_json"]),
                "participant_ids": parse_participant_ids(match.get("participant_ids_json")) or fallback_participant_ids,
            }
            for match in matches
        ],
    }
    _cache_set(league_id, "state", response)
    return response


def upsert_league(payload: LeaguePayload, user: dict[str, Any], create_new: bool = False) -> dict[str, str]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    _validate_league_payouts(payload)
    
    # Ensure payouts_json is always a valid JSON object for the constraint
    if payload.payouts and isinstance(payload.payouts, dict):
        payouts_json = json.dumps(payload.payouts)
    else:
        payouts_json = "{}"
    
    # Double-check it's valid JSON object
    try:
        parsed = json.loads(payouts_json)
        if not isinstance(parsed, dict):
            payouts_json = "{}"
    except (json.JSONDecodeError, TypeError):
        payouts_json = "{}"
    
    values = {
        "sport": payload.sport.strip(),
        "name": payload.name.strip(),
        "tournament": payload.tournament.strip(),
        "entry_fee": payload.entry_fee,
        "active_player_count": payload.active_player_count,
        "owner_user_id": int(user["id"]),
        "default_winner_count": payload.default_winner_count,
        "payouts_json": payouts_json,
    }

    try:
        existing_response = None
        if not create_new and user.get("active_league_id"):
            existing_response = (
                supabase.table("league")
                .select("*")
                .eq("id", int(user["active_league_id"]))
                .limit(1)
                .execute()
            )

        league_id: int | None = None
        invite_code: str | None = None

        if existing_response and existing_response.data and not create_new:
            if user["league_role"] != "admin":
                raise HTTPException(status_code=403, detail="Admin role required")
            existing_owner = existing_response.data[0].get("owner_user_id")
            values["owner_user_id"] = existing_owner or int(user["id"])
            update_result = supabase.table("league").update(values).eq("id", existing_response.data[0]["id"]).execute()
            if not update_result.data:
                raise HTTPException(status_code=500, detail="League update failed")
            league_id = int(existing_response.data[0]["id"])
            invite_code = str(existing_response.data[0].get("invite_code") or "")
        else:
            insert_values = {**values, "invite_code": _generate_invite_code(payload.name)}
            inserted = supabase.table("league").insert(insert_values).execute()
            if not inserted.data:
                raise HTTPException(status_code=500, detail="League insert failed")
            league_id = int(inserted.data[0]["id"])
            invite_code = str(inserted.data[0].get("invite_code") or "")

        if not league_id:
            raise HTTPException(status_code=500, detail="League save verification failed")

        membership_result = supabase.table("league_memberships").upsert(
            {
                "user_id": int(user["id"]),
                "league_id": league_id,
                "role": "admin",
                "status": "active",
            },
            on_conflict="user_id,league_id",
        ).execute()
        if not membership_result.data:
            logger.error(f"Failed to upsert membership for user {user['id']}, league {league_id}")

        delete_result = supabase.table("league_join_requests").delete().eq("user_id", int(user["id"])).eq("league_id", league_id).execute()
        logger.info(f"Deleted {len(delete_result.data or [])} join requests for user {user['id']}, league {league_id}")
        
        _sync_active_members_to_players(supabase, league_id)

        if create_new:
            invalidate_profile_cache(
                user_id_value=int(user["id"]),
                user_id_label=str(user.get("user_id") or ""),
            )

        if not invite_code:
            lookup = supabase.table("league").select("invite_code").eq("id", league_id).limit(1).execute()
            if lookup.data:
                invite_code = str(lookup.data[0].get("invite_code") or "")

        _invalidate_league_cache(league_id)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"Supabase league upsert failed. Values: {values}. User: {user.get('id')}. Error: {str(exc)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Database error: {str(exc)}") from exc

    return {"message": "League settings saved", "league_id": league_id, "invite_code": invite_code}


def add_player(payload: PlayerPayload, user: dict[str, Any]) -> dict[str, str]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    league_id = _league_id_from_user(user)
    
    player_name = payload.name.strip()
    try:
        supabase.table("players").insert({
            "league_id": league_id,
            "name": player_name
        }).execute()
        verify = supabase.table("players").select("id").eq("league_id", league_id).eq("name", player_name).limit(1).execute()
        if not verify.data:
            raise HTTPException(status_code=500, detail="Player insert verification failed")
    except Exception as exc:
        if "duplicate" in str(exc).lower() or "unique" in str(exc).lower():
            raise HTTPException(status_code=409, detail="Player already exists")
        if isinstance(exc, HTTPException):
            raise
        logger.exception("Supabase player insert failed")
        raise HTTPException(status_code=500, detail=f"Database error: {str(exc)}") from exc

    _invalidate_league_cache(league_id)
    
    return {"message": "Player added"}


def delete_player(player_id: int, user: dict[str, Any]) -> dict[str, str]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    league_id = _league_id_from_user(user)
    
    supabase.table("players").delete().eq("id", player_id).eq("league_id", league_id).execute()
    _invalidate_league_cache(league_id)
    return {"message": "Player removed"}


def add_match(payload: MatchPayload, user: dict[str, Any]) -> dict[str, str]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    league_id = _league_id_from_user(user)
    
    payouts_json = json.dumps(payload.payouts) if payload.payouts else None

    players = _sync_active_members_to_players(supabase, league_id)
    valid_player_ids = {int(player["id"]) for player in players}
    participant_ids = _normalize_participant_ids(payload.participant_ids)
    if participant_ids:
        invalid_ids = [player_id for player_id in participant_ids if player_id not in valid_player_ids]
        if invalid_ids:
            raise HTTPException(status_code=400, detail="Match participants include unknown players")
    else:
        participant_ids = [int(player["id"]) for player in players]

    if len(participant_ids) < 2:
        raise HTTPException(status_code=400, detail="Select at least two match participants")

    values = {
        "league_id": league_id,
        "title": payload.title.strip(),
        "match_date": payload.match_date.strip(),
        "winner_count": payload.winner_count,
        "payouts_json": payouts_json,
        "participant_ids_json": participant_ids,
    }

    try:
        before = supabase.table("matches").select("id").order("id", desc=True).limit(1).execute()
        before_id = int(before.data[0]["id"]) if before.data else 0

        supabase.table("matches").insert(values).execute()

        after = supabase.table("matches").select("id").order("id", desc=True).limit(1).execute()
        after_id = int(after.data[0]["id"]) if after.data else 0
        if after_id <= before_id:
            raise HTTPException(status_code=500, detail="Match insert verification failed")
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Supabase match insert failed")
        raise HTTPException(status_code=500, detail=f"Database error: {str(exc)}") from exc

    _invalidate_league_cache(league_id)
    
    return {"message": "Match added"}


def save_winners(match_id: int, payload: WinnersPayload, user: dict[str, Any]) -> dict[str, str]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    league_id = _league_id_from_user(user)
    
    # Get match and league data
    match_response = supabase.table("matches").select("*").eq("id", match_id).eq("league_id", league_id).execute()
    league_response = supabase.table("league").select("*").eq("id", league_id).limit(1).execute()
    
    if not match_response.data or not league_response.data:
        raise HTTPException(status_code=404, detail="League or match not found")
    
    match = match_response.data[0]
    league = league_response.data[0]
    if str(match.get("status") or "").lower() == "canceled":
        raise HTTPException(status_code=409, detail="This match is already marked as washout/cancelled")
    
    payouts = parse_payouts(match["payouts_json"]) or parse_payouts(league["payouts_json"])
    winner_limit = int(match["winner_count"] or league["default_winner_count"])
    participant_ids = parse_participant_ids(match.get("participant_ids_json")) or [int(player["id"]) for player in _sync_active_members_to_players(supabase, league_id)]
    
    rank_to_players = {row.rank: [pid for pid in row.player_ids] for row in payload.ranks}
    
    used_players: set[int] = set()
    for rank_players in rank_to_players.values():
        for player_id in rank_players:
            if player_id not in participant_ids:
                raise HTTPException(status_code=400, detail="Only match participants can be assigned as winners")
            if player_id in used_players:
                raise HTTPException(status_code=400, detail="A player is assigned in multiple ranks")
            used_players.add(player_id)
    
    # Delete existing winner entries
    supabase.table("winner_entries").delete().eq("match_id", match_id).execute()
    
    # Add new winner entries
    rank = 1
    while rank <= winner_limit:
        winners = rank_to_players.get(rank, [])
        if not winners:
            rank += 1
            continue
        
        tie_size = len(winners)
        payout_end_rank = min(winner_limit, rank + tie_size - 1)
        pooled_amount = sum(float(payouts.get(r, 0.0)) for r in range(rank, payout_end_rank + 1))
        split_amount = round(pooled_amount / tie_size, 2) if tie_size else 0.0
        
        for player_id in winners:
            supabase.table("winner_entries").insert({
                "match_id": match_id,
                "rank": rank,
                "player_id": player_id,
                "amount": split_amount,
            }).execute()
        
        rank += max(1, tie_size)
    
    # Update match status
    supabase.table("matches").update({"status": "completed"}).eq("id", match_id).execute()
    _invalidate_league_cache(league_id)
    
    return {"message": "Winners saved"}


def cancel_match(match_id: int, user: dict[str, Any]) -> dict[str, str]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    league_id = _league_id_from_user(user)
    
    # Get match and league data
    match_response = supabase.table("matches").select("*").eq("id", match_id).eq("league_id", league_id).execute()
    league_response = supabase.table("league").select("*").eq("id", league_id).limit(1).execute()
    players = _sync_active_members_to_players(supabase, league_id)
    
    if not match_response.data or not league_response.data:
        raise HTTPException(status_code=404, detail="League or match not found")
    
    match = match_response.data[0]
    league = league_response.data[0]
    participant_ids = parse_participant_ids(match.get("participant_ids_json")) or [int(player["id"]) for player in players]
    
    # Delete existing winner entries
    supabase.table("winner_entries").delete().eq("match_id", match_id).execute()
    
    if participant_ids:
        pool = float(league["entry_fee"]) * len(participant_ids)
        split = round(pool / len(participant_ids), 2)
        remainder = round(pool - (split * len(participant_ids)), 2)
        
        for idx, player_id in enumerate(participant_ids):
            amount = split + (remainder if idx == 0 else 0.0)
            supabase.table("winner_entries").insert({
                "match_id": match_id,
                "rank": 0,
                "player_id": player_id,
                "amount": round(amount, 2),
            }).execute()
    
    # Update match status
    supabase.table("matches").update({"status": "canceled"}).eq("id", match_id).execute()
    _invalidate_league_cache(league_id)
    
    return {"message": "Match marked as canceled and refund distributed equally"}


def reopen_match(match_id: int, user: dict[str, Any]) -> dict[str, str]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    league_id = _league_id_from_user(user)

    match_response = supabase.table("matches").select("*").eq("id", match_id).eq("league_id", league_id).execute()
    if not match_response.data:
        raise HTTPException(status_code=404, detail="Match not found")

    match = match_response.data[0]
    if str(match.get("status") or "").lower() != "canceled":
        raise HTTPException(status_code=409, detail="Only washout/cancelled matches can be reopened")

    supabase.table("winner_entries").delete().eq("match_id", match_id).execute()
    supabase.table("matches").update({"status": "pending"}).eq("id", match_id).execute()
    _invalidate_league_cache(league_id)

    return {"message": "Match reopened for winner assignment"}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _isoformat(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def _parse_timestamp(raw: Any) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None


def _fetch_match_notification_context_supabase(supabase: Any, league_id: int, match_id: int) -> dict[str, Any]:
    league_response = supabase.table("league").select("id, name, tournament, entry_fee").eq("id", league_id).limit(1).execute()
    match_response = supabase.table("matches").select("id, title, match_date, status, participant_ids_json").eq("id", match_id).eq("league_id", league_id).limit(1).execute()
    if not league_response.data or not match_response.data:
        raise HTTPException(status_code=404, detail="Match not found")

    league = league_response.data[0]
    match = match_response.data[0]
    match_status = str(match.get("status") or "pending").lower()
    if match_status not in {"completed", "canceled"}:
        raise HTTPException(
            status_code=400,
            detail="Telegram updates can only be sent after winners are saved or a washout is recorded",
        )
    players = _sync_active_members_to_players(supabase, league_id)
    player_name_by_id = {int(player["id"]): str(player["name"]) for player in players}
    participant_ids = parse_participant_ids(match.get("participant_ids_json")) or [int(player["id"]) for player in players]
    winner_rows_response = (
        supabase.table("winner_entries")
        .select("rank, player_id, amount")
        .eq("match_id", match_id)
        .order("rank")
        .execute()
    )
    winner_rows = winner_rows_response.data or []
    matches_response = supabase.table("matches").select("id").eq("league_id", league_id).order("id").execute()
    match_number_map = _build_match_number_map(matches_response.data or [])

    grouped: dict[int, dict[str, Any]] = {}
    for row in winner_rows:
        rank = int(row["rank"])
        grouped.setdefault(
            rank,
            {
                "rank": rank,
                "label": _rank_label(rank, match_status, True),
                "amount": float(row["amount"]),
                "players": [],
            },
        )["players"].append(player_name_by_id.get(int(row["player_id"]), f"Player #{row['player_id']}"))

    return {
        "league_name": str(league["name"]),
        "tournament": str(league["tournament"]),
        "entry_fee": float(league["entry_fee"]),
        "match_id": int(match["id"]),
        "match_number": match_number_map.get(int(match["id"]), 0),
        "title": str(match["title"]),
        "match_date": str(match["match_date"]),
        "status": match_status,
        "participant_count": len(participant_ids),
        "winner_rows": list(grouped.values()),
    }


def _build_match_notification_message(context: dict[str, Any]) -> str:
    title = f"{context['league_name']} · Match #{context['match_number'] or context['match_id']}"
    lines = [
        f"{context['title']} · {context['match_date']}",
        f"Status: {str(context['status']).replace('_', ' ').title()}",
    ]
    if str(context["status"]).lower() == "canceled":
        lines.append(f"Washout recorded. Refund restored across {context['participant_count']} participants.")
    else:
        for row in context["winner_rows"]:
            players = ", ".join(row["players"]) if row["players"] else "No players"
            lines.append(f"{row['label']}: {players} ({float(row['amount']):.2f} each)")
    lines.append(f"Tournament: {context['tournament']}")
    return build_telegram_message(title=title, lines=lines)


def get_telegram_status(user: dict[str, Any]) -> dict[str, Any]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    league_id = _league_id_from_user(user)
    config = TelegramIntegrationConfig.from_env()
    target = None
    try:
        _purge_expired_telegram_sessions(supabase)
        response = supabase.table("league_integrations").select(
            "telegram_chat_id, telegram_chat_name, telegram_chat_type, telegram_notifications_enabled, telegram_connected_at"
        ).eq("league_id", league_id).limit(1).execute()
        row = response.data[0] if response.data else None
        if row and row.get("telegram_chat_id"):
            target = {
                "chat_id": str(row.get("telegram_chat_id") or ""),
                "chat_name": str(row.get("telegram_chat_name") or ""),
                "chat_type": str(row.get("telegram_chat_type") or ""),
                "enabled": bool(row.get("telegram_notifications_enabled", True)),
                "connected_at": str(row.get("telegram_connected_at") or ""),
            }
    except Exception:
        logger.warning("Telegram integration tables are not available yet in Supabase.")

    webhook_registered = False
    if config.is_webhook_ready():
        try:
            info = get_telegram_webhook_info(config)
            webhook_registered = str((info.get("result") or {}).get("url") or "") == str(config.webhook_url() or "")
        except HTTPException:
            webhook_registered = False

    return {
        "bot_ready": config.is_bot_ready(),
        "connect_ready": config.is_bot_ready(),
        "send_ready": config.is_bot_ready() and bool(target and target.get("enabled")),
        "webhook_ready": config.is_webhook_ready(),
        "webhook_registered": webhook_registered,
        "bot_username": config.bot_username,
        "target": target,
    }


def create_telegram_connect_session(target: str, user: dict[str, Any], match_id: int | None = None) -> dict[str, Any]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    config = TelegramIntegrationConfig.from_env()
    if not config.is_bot_ready():
        raise HTTPException(status_code=503, detail="Telegram bot is not fully configured yet")
    if not config.is_webhook_ready():
        raise HTTPException(status_code=503, detail="Telegram webhook settings are incomplete")
    ensure_telegram_webhook(config)

    league_id = _league_id_from_user(user)
    _ensure_telegram_connect_session_capacity(supabase, league_id, int(user["id"]))
    session_id = secrets.token_urlsafe(18)
    raw_token = secrets.token_urlsafe(24)
    expires_at = _utc_now() + timedelta(minutes=15)
    deep_link = build_telegram_link(config.bot_username or "", raw_token, target)

    supabase.table("telegram_link_sessions").insert(
        {
            "id": session_id,
            "token_hash": hash_connect_token(raw_token),
            "league_id": league_id,
            "created_by_user_id": int(user["id"]),
            "target": target,
            "requested_match_id": int(match_id) if match_id else None,
            "expires_at": _isoformat(expires_at),
        }
    ).execute()

    return {
        "session_id": session_id,
        "target": target,
        "connect_url": deep_link,
        "start_command": f"/start {raw_token}",
        "qr_code_data_uri": render_qr_data_uri(deep_link),
        "expires_at": _isoformat(expires_at),
    }


def get_telegram_connect_session_status(session_id: str, user: dict[str, Any]) -> dict[str, Any]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    league_id = _league_id_from_user(user)
    response = (
        supabase.table("telegram_link_sessions")
        .select("*")
        .eq("id", session_id)
        .eq("league_id", league_id)
        .eq("created_by_user_id", int(user["id"]))
        .limit(1)
        .execute()
    )
    row = response.data[0] if response.data else None
    if not row:
        raise HTTPException(status_code=404, detail="Telegram connect session not found")

    expires_at = _parse_timestamp(row.get("expires_at"))
    connected = bool(row.get("consumed_at") and row.get("connected_chat_id"))
    expired = bool(expires_at and _utc_now() >= expires_at and not connected)
    status = "connected" if connected else "expired" if expired else "pending"
    return {
        "session_id": str(row["id"]),
        "status": status,
        "target": str(row["target"]),
        "requested_match_id": int(row["requested_match_id"]) if row.get("requested_match_id") else None,
        "expires_at": str(row.get("expires_at") or ""),
        "connected_target": (
            {
                "chat_id": str(row.get("connected_chat_id") or ""),
                "chat_name": str(row.get("connected_chat_name") or ""),
                "chat_type": str(row.get("connected_chat_type") or ""),
            }
            if row.get("connected_chat_id")
            else None
        ),
        "last_error": str(row.get("last_error") or ""),
    }


def process_telegram_webhook(update: dict[str, Any]) -> dict[str, Any]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    message = (update or {}).get("message") or {}
    text = str(message.get("text") or "").strip()
    if not text.startswith("/start"):
        return {"ok": True, "handled": False}

    parts = text.split(maxsplit=1)
    raw_token = parts[1].strip() if len(parts) > 1 else ""
    if not raw_token:
        return {"ok": True, "handled": False}

    chat = message.get("chat") or {}
    chat_id = str(chat.get("id") or "").strip()
    chat_type = str(chat.get("type") or "").strip()
    if not chat_id:
        return {"ok": True, "handled": False}

    chat_name = (
        str(chat.get("title") or "").strip()
        or " ".join(part for part in [str(chat.get("first_name") or "").strip(), str(chat.get("last_name") or "").strip()] if part).strip()
        or str(chat.get("username") or "").strip()
        or "Telegram Chat"
    )
    token_hash = hash_connect_token(raw_token)
    response = supabase.table("telegram_link_sessions").select("*").eq("token_hash", token_hash).limit(1).execute()
    row = response.data[0] if response.data else None
    if not row:
        return {"ok": True, "handled": False}

    if row.get("consumed_at"):
        return {"ok": True, "handled": True, "status": "already_consumed"}

    expires_at = _parse_timestamp(row.get("expires_at"))
    if expires_at and _utc_now() >= expires_at:
        supabase.table("telegram_link_sessions").update({"last_error": "Session expired before Telegram link completed"}).eq("id", row["id"]).execute()
        return {"ok": True, "handled": True, "status": "expired"}

    target = str(row.get("target") or "")
    if target == "personal" and chat_type != "private":
        supabase.table("telegram_link_sessions").update({"last_error": "Personal connection must be completed from a private chat"}).eq("id", row["id"]).execute()
        return {"ok": True, "handled": True, "status": "invalid_chat_type"}
    if target == "group" and chat_type not in {"group", "supergroup"}:
        supabase.table("telegram_link_sessions").update({"last_error": "Group connection must be completed from a Telegram group"}).eq("id", row["id"]).execute()
        return {"ok": True, "handled": True, "status": "invalid_chat_type"}

    connected_at = _isoformat(_utc_now())
    supabase.table("league_integrations").upsert(
        {
            "league_id": int(row["league_id"]),
            "telegram_chat_id": chat_id,
            "telegram_chat_name": chat_name,
            "telegram_chat_type": chat_type,
            "telegram_notifications_enabled": True,
            "telegram_connected_by_user_id": int(row["created_by_user_id"]),
            "telegram_connected_at": connected_at,
            "updated_at": connected_at,
        },
        on_conflict="league_id",
    ).execute()
    supabase.table("telegram_link_sessions").update(
        {
            "connected_chat_id": chat_id,
            "connected_chat_name": chat_name,
            "connected_chat_type": chat_type,
            "consumed_at": connected_at,
            "last_error": None,
        }
    ).eq("id", row["id"]).execute()

    try:
        send_telegram_message(
            message=build_telegram_message(
                title="League Ledger connected",
                lines=[
                    f"{chat_name} is now linked for future match updates.",
                    "Return to League Ledger to send the latest result.",
                ],
            ),
            chat_id=chat_id,
            config=TelegramIntegrationConfig.from_env(),
        )
    except HTTPException:
        logger.warning("Telegram confirmation message could not be sent after successful link.")

    return {"ok": True, "handled": True, "status": "connected"}


def send_match_update_to_telegram(match_id: int, user: dict[str, Any]) -> dict[str, Any]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    league_id = _league_id_from_user(user)
    response = supabase.table("league_integrations").select(
        "telegram_chat_id, telegram_chat_name, telegram_notifications_enabled"
    ).eq("league_id", league_id).limit(1).execute()
    integration = response.data[0] if response.data else None
    if not integration or not integration.get("telegram_chat_id"):
        raise HTTPException(status_code=400, detail="Telegram is not connected for this league yet")
    if not bool(integration.get("telegram_notifications_enabled", True)):
        raise HTTPException(status_code=400, detail="Telegram notifications are disabled for this league")

    context = _fetch_match_notification_context_supabase(supabase, league_id, match_id)
    result = send_telegram_message(
        message=_build_match_notification_message(context),
        chat_id=str(integration["telegram_chat_id"]),
    )
    return {
        "ok": result.sent,
        "chat_id": result.chat_id,
        "chat_name": str(integration.get("telegram_chat_name") or ""),
        "message_id": result.message_id,
    }


def register_telegram_webhook(user: dict[str, Any]) -> dict[str, Any]:
    _league_id_from_user(user)
    data = set_telegram_webhook(TelegramIntegrationConfig.from_env())
    return {"ok": bool(data.get("ok")), "description": str(data.get("description") or "Webhook registered")}


def get_ledger(user: dict[str, Any]) -> dict[str, Any]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    if user.get("league_role") != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")
    league_id = _league_id_from_user(user)
    cached = _cache_get(league_id, "ledger")
    if cached is not None:
        return cached
    
    # Get league data
    league_response = supabase.table("league").select("*").eq("id", league_id).limit(1).execute()
    if not league_response.data:
        return {"rows": [], "completed_matches": 0, "entry_fee": 0}
    
    league = league_response.data[0]
    
    # Get completed matches count
    matches_response = supabase.table("matches").select("id, status, participant_ids_json").eq("league_id", league_id).in_("status", ["completed", "canceled"]).order("id", desc=True).execute()
    matches = matches_response.data
    completed_matches = len(matches)
    
    # Get players
    players = _sync_active_members_to_players(supabase, league_id)
    
    # Get winnings
    winnings: list[dict[str, Any]] = []
    if matches:
        winnings_response = (
            supabase.table("winner_entries")
            .select("player_id, amount, match_id")
            .in_("match_id", [int(match["id"]) for match in matches])
            .execute()
        )
        winnings = winnings_response.data or []

    by_match_winnings: dict[int, list[dict[str, Any]]] = {}
    for item in winnings:
        by_match_winnings.setdefault(int(item["match_id"]), []).append(
            {
                "match_id": int(item["match_id"]),
                "player_id": int(item["player_id"]),
                "amount": float(item["amount"]),
            }
        )

    entry_fee = float(league["entry_fee"])
    fallback_participants = [int(player["id"]) for player in players]
    match_counts_by_player: dict[int, int] = {}
    winnings_map: dict[int, float] = {}

    for match in matches:
        match_id = int(match["id"])
        participant_ids = parse_participant_ids(match.get("participant_ids_json")) or fallback_participants
        effective_rows = (
            _build_refund_rows(match_id, participant_ids, entry_fee)
            if str(match["status"]) == "canceled"
            else by_match_winnings.get(match_id, [])
        )
        for player_id in participant_ids:
            match_counts_by_player[player_id] = match_counts_by_player.get(player_id, 0) + 1
        for item in effective_rows:
            player_id = int(item["player_id"])
            winnings_map[player_id] = round(winnings_map.get(player_id, 0.0) + float(item["amount"]), 2)
    
    rows = []
    for player in players:
        spent = round(match_counts_by_player.get(int(player["id"]), 0) * entry_fee, 2)
        won = round(winnings_map.get(player["id"], 0.0), 2)
        net = round(won - spent, 2)
        rows.append({
            "player_id": player["id"],
            "name": player["name"],
            "spent": spent,
            "won": won,
            "net": net,
        })
    
    response = {
        "rows": rows,
        "completed_matches": completed_matches,
        "entry_fee": entry_fee,
    }
    _cache_set(league_id, "ledger", response)
    return response


def get_stats(user: dict[str, Any]) -> dict[str, Any]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    league_id = _league_id_from_user(user)
    cached = _cache_get(league_id, "stats")
    if cached is not None:
        return cached

    league_response = supabase.table("league").select("entry_fee").eq("id", league_id).limit(1).execute()
    league = league_response.data[0] if league_response.data else {"entry_fee": 0}

    players = _sync_active_members_to_players(supabase, league_id)

    matches_response = supabase.table("matches").select("id, title, match_date, status, participant_ids_json").eq("league_id", league_id).order("id", desc=True).execute()
    matches = matches_response.data

    winners: list[dict[str, Any]] = []
    if matches:
        winners_response = (
            supabase.table("winner_entries")
            .select("match_id, rank, player_id, amount")
            .in_("match_id", [int(match["id"]) for match in matches])
            .order("match_id", desc=True)
            .order("rank")
            .execute()
        )
        winners = winners_response.data or []

    canceled_match_ids = {int(match["id"]) for match in matches if str(match["status"]) == "canceled"}
    winners = [row for row in winners if int(row["match_id"]) not in canceled_match_ids]

    player_name_by_id = {int(p["id"]): str(p["name"]) for p in players}
    match_number_map = _build_match_number_map(matches)
    player_stats: dict[int, dict[str, Any]] = {
        int(p["id"]): {
            "player_id": int(p["id"]),
            "name": str(p["name"]),
            "wins_total": 0,
            "rank_counts": {},
            "matches_played": 0,
            "matches_won": 0,
            "washout_matches": 0,
            "total_amount": 0.0,
            "match_history": [],
            "_played_match_ids": set(),
            "_washout_match_ids": set(),
        }
        for p in players
    }

    by_match: dict[int, list[dict[str, Any]]] = {}
    winner_lookup: dict[int, dict[int, dict[str, Any]]] = {}
    for row in winners:
        match_id = int(row["match_id"])
        player_id = int(row["player_id"])
        rank = int(row["rank"])
        amount = float(row["amount"])
        player_name = player_name_by_id.get(player_id, f"Archived Player #{player_id}")
        record = {
            "match_id": match_id,
            "player_id": player_id,
            "rank": rank,
            "amount": amount,
            "player_name": player_name,
        }
        by_match.setdefault(match_id, []).append(record)
        winner_lookup.setdefault(match_id, {})[player_id] = {
            "rank": rank,
            "amount": amount,
        }

        stat = player_stats.get(player_id)
        if not stat:
            stat = {
                "player_id": player_id,
                "name": player_name,
                "wins_total": 0,
                "rank_counts": {},
                "matches_played": 0,
                "matches_won": 0,
                "washout_matches": 0,
                "total_amount": 0.0,
                "match_history": [],
                "_played_match_ids": set(),
                "_washout_match_ids": set(),
            }
            player_stats[player_id] = stat
        if rank == 1:
            stat["wins_total"] += 1
        if rank == 0:
            stat["_washout_match_ids"].add(match_id)
        rank_key = str(rank)
        stat["rank_counts"][rank_key] = int(stat["rank_counts"].get(rank_key, 0)) + 1
        stat["total_amount"] = round(float(stat["total_amount"]) + amount, 2)

    for match in matches:
        match_id = int(match["id"])
        if str(match["status"]) != "canceled":
            continue
        participant_ids = _normalize_participant_ids(parse_participant_ids(match.get("participant_ids_json")))
        if not participant_ids:
            participant_ids = _normalize_participant_ids(list(player_name_by_id.keys()))

        synthetic_rows = _build_refund_rows(match_id, participant_ids, entry_fee=float(league.get("entry_fee") or 0))
        for row in synthetic_rows:
            row["player_name"] = player_name_by_id.get(int(row["player_id"]), f"Archived Player #{row['player_id']}")
            by_match.setdefault(match_id, []).append(row)
            winner_lookup.setdefault(match_id, {})[int(row["player_id"])] = {
                "rank": 0,
                "amount": float(row["amount"]),
            }
            stat = player_stats.get(int(row["player_id"]))
            if not stat:
                stat = {
                    "player_id": int(row["player_id"]),
                    "name": row["player_name"],
                    "wins_total": 0,
                    "rank_counts": {},
                    "matches_played": 0,
                    "matches_won": 0,
                    "washout_matches": 0,
                    "total_amount": 0.0,
                    "match_history": [],
                    "_played_match_ids": set(),
                    "_washout_match_ids": set(),
                }
                player_stats[int(row["player_id"])] = stat
            stat["_washout_match_ids"].add(match_id)
            stat["rank_counts"]["0"] = int(stat["rank_counts"].get("0", 0)) + 1
            stat["total_amount"] = round(float(stat["total_amount"]) + float(row["amount"]), 2)

    for match_rows in by_match.values():
        unique_players = {row["player_id"] for row in match_rows if int(row["rank"]) > 0}
        for player_id in unique_players:
            stat = player_stats.get(player_id)
            if stat:
                stat["matches_won"] += 1

    match_stats: list[dict[str, Any]] = []
    for match in matches:
        match_id = int(match["id"])
        rows = by_match.get(match_id, [])
        rank_map: dict[int, dict[str, Any]] = {}
        for row in rows:
            rank = int(row["rank"])
            if rank not in rank_map:
                rank_map[rank] = {"rank": rank, "players": [], "amount_each": float(row["amount"])}
            rank_map[rank]["players"].append(row["player_name"])

        participant_ids = _normalize_participant_ids(parse_participant_ids(match.get("participant_ids_json")))
        if not participant_ids:
            participant_ids = _normalize_participant_ids(list(player_name_by_id.keys()))
        participant_names = [player_name_by_id.get(player_id, f"Archived Player #{player_id}") for player_id in participant_ids]

        for player_id in participant_ids:
            stat = player_stats.get(player_id)
            if not stat:
                stat = {
                    "player_id": player_id,
                    "name": player_name_by_id.get(player_id, f"Archived Player #{player_id}"),
                    "wins_total": 0,
                    "rank_counts": {},
                    "matches_played": 0,
                    "matches_won": 0,
                    "washout_matches": 0,
                    "total_amount": 0.0,
                    "match_history": [],
                    "_played_match_ids": set(),
                    "_washout_match_ids": set(),
                }
                player_stats[player_id] = stat

            result = winner_lookup.get(match_id, {}).get(player_id)
            if str(match["status"]) in {"completed", "canceled"}:
                stat["_played_match_ids"].add(match_id)
            if str(match["status"]) == "canceled" or (result and int(result["rank"]) == 0):
                stat["_washout_match_ids"].add(match_id)
            stat["match_history"].append(
                {
                    "match_id": match_id,
                    "title": str(match["title"]),
                    "match_date": str(match["match_date"]),
                    "status": str(match["status"]),
                    "result": _rank_label(int(result["rank"]) if result else -1, str(match["status"]), bool(result)),
                    "amount_won": round(float(result["amount"]), 2) if result else 0.0,
                }
            )

        match_stats.append(
            {
                "match_id": match_id,
                "match_number": match_number_map.get(match_id, 0),
                "title": str(match["title"]),
                "match_date": str(match["match_date"]),
                "status": str(match["status"]),
                "participant_ids": participant_ids,
                "participants": participant_names,
                "participant_count": len(participant_names),
                "winners": [rank_map[key] for key in sorted(rank_map)],
            }
        )

    for stat in player_stats.values():
        stat["matches_played"] = len(stat.pop("_played_match_ids", set()))
        stat["washout_matches"] = len(stat.pop("_washout_match_ids", set()))

    player_stats_list = sorted(
        player_stats.values(),
        key=lambda item: (-item["wins_total"], -item["total_amount"], item["name"].lower()),
    )
    entry_fee = round(float(league.get("entry_fee") or 0), 2)
    total_matches = len(matches)
    played_matches = sum(1 for match in matches if str(match["status"]) == "completed")
    canceled_matches = sum(1 for match in matches if str(match["status"]) == "canceled")
    response = {
        "summary": {
            "entry_fee": entry_fee,
            "total_matches": total_matches,
            "played_matches": played_matches,
            "canceled_matches": canceled_matches,
        },
        "matches": match_stats,
        "players": player_stats_list,
    }
    _cache_set(league_id, "stats", response)
    return response


# ---------------------------------------------------------------------------
# Player-alias management (AI screenshot scan)
# ---------------------------------------------------------------------------


def _fetch_alias_rows(supabase: Any, league_id: int) -> list[dict[str, Any]]:
    response = (
        supabase.table("player_aliases")
        .select("id,alias,alias_display,player_id,created_at,confirmed_by_user_id")
        .eq("league_id", league_id)
        .execute()
    )
    return list(response.data or [])


def list_player_aliases(user: dict[str, Any]) -> dict[str, Any]:
    """Supabase equivalent of the SQLite alias listing."""

    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    league_id = _league_id_from_user(user)

    alias_rows = _fetch_alias_rows(supabase, league_id)
    players = _sync_active_members_to_players(supabase, league_id)
    player_name_by_id = {int(p["id"]): str(p["name"]) for p in players}

    aliases = [
        {
            "id": int(row["id"]),
            "alias": str(row["alias"]),
            "alias_display": str(row["alias_display"]),
            "player_id": int(row["player_id"]) if row.get("player_id") is not None else None,
            "player_name": player_name_by_id.get(int(row["player_id"]), "")
            if row.get("player_id") is not None
            else "",
            "created_at": str(row.get("created_at") or ""),
            "confirmed_by_user_id": int(row["confirmed_by_user_id"])
            if row.get("confirmed_by_user_id") is not None
            else None,
        }
        for row in alias_rows
    ]
    aliases.sort(key=lambda item: str(item["alias_display"]).lower())

    return {
        "aliases": aliases,
        "players": [
            {"id": int(p["id"]), "name": str(p["name"])} for p in players
        ],
    }


def update_player_alias(alias_id: int, player_id: int, user: dict[str, Any]) -> dict[str, Any]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    league_id = _league_id_from_user(user)

    existing = (
        supabase.table("player_aliases")
        .select("id")
        .eq("id", int(alias_id))
        .eq("league_id", league_id)
        .limit(1)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Alias not found")

    players = _sync_active_members_to_players(supabase, league_id)
    if int(player_id) not in {int(p["id"]) for p in players}:
        raise HTTPException(status_code=400, detail="Player is not part of this league")

    supabase.table("player_aliases").update(
        {
            "player_id": int(player_id),
            "confirmed_by_user_id": int(user.get("id")) if user.get("id") is not None else None,
        }
    ).eq("id", int(alias_id)).eq("league_id", league_id).execute()

    return {"message": "Alias updated"}


def delete_player_alias(alias_id: int, user: dict[str, Any]) -> dict[str, str]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    league_id = _league_id_from_user(user)

    response = (
        supabase.table("player_aliases")
        .delete()
        .eq("id", int(alias_id))
        .eq("league_id", league_id)
        .execute()
    )
    if not response.data:
        raise HTTPException(status_code=404, detail="Alias not found")
    return {"message": "Alias removed"}


def save_player_aliases(payload: BulkAliasPayload, user: dict[str, Any]) -> dict[str, Any]:
    """Upsert admin-confirmed aliases on Supabase.

    Uses a unique (league_id, alias) constraint so corrections (admin overriding
    an earlier AI suggestion) naturally overwrite the prior mapping.
    """

    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    if not payload.entries:
        return {"saved": 0}

    league_id = _league_id_from_user(user)
    saved_user_id = int(user.get("id")) if user.get("id") is not None else None

    players = _sync_active_members_to_players(supabase, league_id)
    valid_player_ids = {int(p["id"]) for p in players}

    rows_to_upsert: list[dict[str, Any]] = []
    for entry in payload.entries:
        normalized = normalize_alias(entry.alias)
        if not normalized:
            continue
        if int(entry.player_id) not in valid_player_ids:
            raise HTTPException(
                status_code=400,
                detail="Alias references a player outside this league",
            )
        display = (entry.alias_display or entry.alias).strip() or entry.alias.strip()
        rows_to_upsert.append(
            {
                "league_id": league_id,
                "player_id": int(entry.player_id),
                "alias": normalized,
                "alias_display": display,
                "confirmed_by_user_id": saved_user_id,
            }
        )

    if not rows_to_upsert:
        return {"saved": 0}

    supabase.table("player_aliases").upsert(
        rows_to_upsert,
        on_conflict="league_id,alias",
    ).execute()

    return {"saved": len(rows_to_upsert)}


def extract_winners_from_screenshot(
    match_id: int,
    image_bytes: bytes,
    mime_type: str,
    user: dict[str, Any],
) -> dict[str, Any]:
    """Supabase equivalent of the SQLite screenshot extractor.

    Reads match + league + players + aliases from Supabase, calls the vision
    model, runs alias resolution locally, and returns a draft winners payload
    for admin confirmation. Never writes to winner_entries.
    """

    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    league_id = _league_id_from_user(user)

    match_response = (
        supabase.table("matches")
        .select("*")
        .eq("id", int(match_id))
        .eq("league_id", league_id)
        .limit(1)
        .execute()
    )
    league_response = (
        supabase.table("league").select("*").eq("id", league_id).limit(1).execute()
    )
    if not match_response.data or not league_response.data:
        raise HTTPException(status_code=404, detail="League or match not found")

    match_row = match_response.data[0]
    league_row = league_response.data[0]
    if str(match_row.get("status") or "").lower() == "canceled":
        raise HTTPException(status_code=409, detail="This match is marked as washout/cancelled")

    players = _sync_active_members_to_players(supabase, league_id)
    players_by_id = {int(p["id"]): str(p["name"]) for p in players}
    participant_ids = (
        parse_participant_ids(match_row.get("participant_ids_json"))
        or list(players_by_id.keys())
    )
    eligible = [
        PlayerRef(id=pid, name=players_by_id[pid])
        for pid in participant_ids
        if pid in players_by_id
    ]

    alias_rows = _fetch_alias_rows(supabase, league_id)
    alias_lookup: dict[str, int] = {
        str(row["alias"]): int(row["player_id"])
        for row in alias_rows
        if row.get("player_id") is not None
    }

    winner_limit = int(match_row.get("winner_count") or league_row.get("default_winner_count") or 0)

    rows: list[LeaderboardRow] = extract_leaderboard(image_bytes, mime_type)

    ranked_rows: list[dict[str, Any]] = []
    used_player_ids: set[int] = set()
    rank_to_players: dict[int, list[int]] = {}

    for row in rows:
        if row.rank > winner_limit:
            break
        match = resolve_alias(row.display_name, eligible, alias_lookup)

        player_id = match.player_id
        if player_id is not None and player_id in used_player_ids:
            player_id = None
            match_payload = {
                "player_id": None,
                "player_name": None,
                "confidence": 0.0,
                "source": "none",
            }
        else:
            match_payload = {
                "player_id": match.player_id,
                "player_name": match.player_name,
                "confidence": match.confidence,
                "source": match.source,
            }

        if player_id is not None:
            used_player_ids.add(player_id)
            rank_to_players.setdefault(row.rank, []).append(player_id)

        ranked_rows.append(
            {
                "rank": row.rank,
                "display_name": row.display_name,
                "points": row.points,
                "match": match_payload,
            }
        )

    draft_ranks = [
        {"rank": rank, "player_ids": player_ids}
        for rank, player_ids in sorted(rank_to_players.items())
    ]

    return {
        "match_id": int(match_id),
        "winner_limit": winner_limit,
        "rows": ranked_rows,
        "draft": {"ranks": draft_ranks},
        "eligible_players": [
            {"id": ref.id, "name": ref.name} for ref in eligible
        ],
    }
