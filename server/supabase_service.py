from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import HTTPException

from .database import get_supabase_client, parse_participant_ids, parse_payouts
from .schemas import LeaguePayload, MatchPayload, PlayerPayload, WinnersPayload
logger = logging.getLogger(__name__)


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


def get_state() -> dict[str, Any]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    
    try:
        # Get league data
        league_response = supabase.table("league").select("*").limit(1).execute()
        league = league_response.data[0] if league_response.data else None
        
        # Get players
        players_response = supabase.table("players").select("*").order("name").execute()
        players = players_response.data
        
        # Get matches
        matches_response = supabase.table("matches").select("*").order("id", desc=True).execute()
        matches = matches_response.data
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
    fallback_participant_ids = [int(player["id"]) for player in players]

    return {
        "league": {
            "name": league["name"],
            "tournament": league["tournament"],
            "entry_fee": league["entry_fee"],
            "active_player_count": league["active_player_count"],
            "default_winner_count": league["default_winner_count"],
            "payouts": parse_payouts(league["payouts_json"]),
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


def upsert_league(payload: LeaguePayload, user: dict[str, Any]) -> dict[str, str]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    
    payouts_json = json.dumps(payload.payouts)
    
    values = {
        "name": payload.name.strip(),
        "tournament": payload.tournament.strip(),
        "entry_fee": payload.entry_fee,
        "active_player_count": payload.active_player_count,
        "owner_user_id": int(user["id"]),
        "default_winner_count": payload.default_winner_count,
        "payouts_json": payouts_json,
    }

    try:
        existing_response = supabase.table("league").select("*").limit(1).execute()

        if existing_response.data:
            if user["league_role"] != "admin":
                raise HTTPException(status_code=403, detail="Admin role required")
            existing_owner = existing_response.data[0].get("owner_user_id")
            values["owner_user_id"] = existing_owner or int(user["id"])
            supabase.table("league").update(values).eq("id", existing_response.data[0]["id"]).execute()
        else:
            supabase.table("league").insert(values).execute()
            supabase.table("league_memberships").upsert({
                "user_id": int(user["id"]),
                "role": "admin",
                "status": "active",
            }, on_conflict="user_id").execute()
            supabase.table("league_join_requests").delete().eq("user_id", int(user["id"])).execute()

        verify = supabase.table("league").select("*").limit(1).execute()
        if not verify.data:
            raise HTTPException(status_code=500, detail="League save verification failed")
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Supabase league upsert failed")
        raise HTTPException(status_code=500, detail=f"Database error: {str(exc)}") from exc
    
    return {"message": "League settings saved"}


def add_player(payload: PlayerPayload) -> dict[str, str]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    
    player_name = payload.name.strip()
    try:
        supabase.table("players").insert({
            "name": player_name
        }).execute()
        verify = supabase.table("players").select("id").eq("name", player_name).limit(1).execute()
        if not verify.data:
            raise HTTPException(status_code=500, detail="Player insert verification failed")
    except Exception as exc:
        if "duplicate" in str(exc).lower() or "unique" in str(exc).lower():
            raise HTTPException(status_code=409, detail="Player already exists")
        if isinstance(exc, HTTPException):
            raise
        logger.exception("Supabase player insert failed")
        raise HTTPException(status_code=500, detail=f"Database error: {str(exc)}") from exc
    
    return {"message": "Player added"}


def delete_player(player_id: int) -> dict[str, str]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    
    supabase.table("players").delete().eq("id", player_id).execute()
    return {"message": "Player removed"}


def add_match(payload: MatchPayload) -> dict[str, str]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    
    payouts_json = json.dumps(payload.payouts) if payload.payouts else None

    players_response = supabase.table("players").select("id").order("id").execute()
    valid_player_ids = {int(player["id"]) for player in players_response.data}
    participant_ids = _normalize_participant_ids(payload.participant_ids)
    if participant_ids:
        invalid_ids = [player_id for player_id in participant_ids if player_id not in valid_player_ids]
        if invalid_ids:
            raise HTTPException(status_code=400, detail="Match participants include unknown players")
    else:
        participant_ids = [int(player["id"]) for player in players_response.data]

    if len(participant_ids) < 2:
        raise HTTPException(status_code=400, detail="Select at least two match participants")

    values = {
        "title": payload.title.strip(),
        "match_date": payload.match_date.strip(),
        "winner_count": payload.winner_count,
        "payouts_json": payouts_json,
        "participant_ids_json": json.dumps(participant_ids),
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
    
    return {"message": "Match added"}


def save_winners(match_id: int, payload: WinnersPayload) -> dict[str, str]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    
    # Get match and league data
    match_response = supabase.table("matches").select("*").eq("id", match_id).execute()
    league_response = supabase.table("league").select("*").limit(1).execute()
    
    if not match_response.data or not league_response.data:
        raise HTTPException(status_code=404, detail="League or match not found")
    
    match = match_response.data[0]
    league = league_response.data[0]
    
    payouts = parse_payouts(match["payouts_json"]) or parse_payouts(league["payouts_json"])
    winner_limit = int(match["winner_count"] or league["default_winner_count"])
    participant_ids = parse_participant_ids(match.get("participant_ids_json")) or [int(player["id"]) for player in supabase.table("players").select("id").order("id").execute().data]
    
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
    
    return {"message": "Winners saved"}


def cancel_match(match_id: int) -> dict[str, str]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    
    # Get match and league data
    match_response = supabase.table("matches").select("*").eq("id", match_id).execute()
    league_response = supabase.table("league").select("*").limit(1).execute()
    players_response = supabase.table("players").select("id").order("id").execute()
    
    if not match_response.data or not league_response.data:
        raise HTTPException(status_code=404, detail="League or match not found")
    
    match = match_response.data[0]
    league = league_response.data[0]
    players = players_response.data
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
    
    return {"message": "Match marked as canceled and refund distributed equally"}


def get_ledger() -> dict[str, Any]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    
    # Get league data
    league_response = supabase.table("league").select("*").limit(1).execute()
    if not league_response.data:
        return {"rows": [], "completed_matches": 0, "entry_fee": 0}
    
    league = league_response.data[0]
    
    # Get completed matches count
    matches_response = supabase.table("matches").select("id, participant_ids_json").in_("status", ["completed", "canceled"]).order("id", desc=True).execute()
    matches = matches_response.data
    completed_matches = len(matches)
    
    # Get players
    players_response = supabase.table("players").select("id, name").order("name").execute()
    players = players_response.data
    
    # Get winnings
    winnings_response = supabase.table("winner_entries").select("player_id, amount").execute()
    winnings = winnings_response.data
    
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
    
    return {
        "rows": rows,
        "completed_matches": completed_matches,
        "entry_fee": entry_fee,
    }


def get_stats() -> dict[str, Any]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    players_response = supabase.table("players").select("id, name").order("name").execute()
    players = players_response.data

    matches_response = supabase.table("matches").select("id, title, match_date, status, participant_ids_json").order("id", desc=True).execute()
    matches = matches_response.data

    winners_response = supabase.table("winner_entries").select("match_id, rank, player_id, amount").order("match_id", desc=True).order("rank").execute()
    winners = winners_response.data

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
    total_matches = len(matches)
    played_matches = sum(1 for match in matches if str(match["status"]) == "completed")
    canceled_matches = sum(1 for match in matches if str(match["status"]) == "canceled")
    return {
        "summary": {
            "total_matches": total_matches,
            "played_matches": played_matches,
            "canceled_matches": canceled_matches,
        },
        "matches": match_stats,
        "players": player_stats_list,
    }
