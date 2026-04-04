import time
import logging
import re
import secrets
import json
import math
from threading import Lock
from typing import Any

from fastapi import HTTPException

try:
    from postgrest import APIError
except ImportError:
    APIError = None

from .auth import get_supabase_client
from .database import parse_participant_ids, parse_payouts
from .schemas import LeaguePayload, MatchPayload, PlayerPayload, WinnersPayload
logger = logging.getLogger(__name__)

_CACHE_TTL_SECONDS = 20.0
_LEAGUE_READ_CACHE: dict[tuple[int, str], tuple[float, dict[str, Any]]] = {}
_LEAGUE_READ_CACHE_LOCK = Lock()


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
    matches_response = supabase.table("matches").select("id, participant_ids_json").eq("league_id", league_id).in_("status", ["completed", "canceled"]).order("id", desc=True).execute()
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
    
    winnings_map = {}
    for item in winnings:
        player_id = item["player_id"]
        amount = float(item["amount"])
        winnings_map[player_id] = winnings_map.get(player_id, 0) + amount
    
    entry_fee = float(league["entry_fee"])
    fallback_participants = [int(player["id"]) for player in players]
    match_counts_by_player: dict[int, int] = {}

    for match in matches:
        participant_ids = parse_participant_ids(match.get("participant_ids_json")) or fallback_participants
        for player_id in participant_ids:
            match_counts_by_player[player_id] = match_counts_by_player.get(player_id, 0) + 1
    
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

    player_name_by_id = {int(p["id"]): str(p["name"]) for p in players}
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
