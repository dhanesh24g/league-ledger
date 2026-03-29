from __future__ import annotations

import json
import logging
import os
from typing import Any

from fastapi import HTTPException

from .database import get_supabase_client, DatabaseManager, parse_participant_ids, parse_payouts
from .schemas import LeaguePayload, MatchPayload, PlayerPayload, WinnersPayload
logger = logging.getLogger(__name__)

# Import Supabase service if available
try:
    from .supabase_service import (
        get_state as supabase_get_state,
        upsert_league as supabase_upsert_league,
        add_player as supabase_add_player,
        delete_player as supabase_delete_player,
        add_match as supabase_add_match,
        save_winners as supabase_save_winners,
        cancel_match as supabase_cancel_match,
        get_ledger as supabase_get_ledger,
        get_stats as supabase_get_stats,
    )
    SUPABASE_SERVICE_AVAILABLE = True
except ImportError:
    SUPABASE_SERVICE_AVAILABLE = False


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
    try:
        if get_supabase_client() and SUPABASE_SERVICE_AVAILABLE:
            return supabase_get_state()
    except Exception:
        logger.exception("Supabase read failed; falling back to SQLite")
    
    # Check if we're in Vercel environment
    if os.getenv("VERCEL"):
        raise HTTPException(
            status_code=500, 
            detail="Supabase not configured. Please set SUPABASE_URL and SUPABASE_ANON_KEY environment variables in Vercel."
        )
    
    # Fallback to SQLite for local development
    with DatabaseManager() as c:
        league = c.execute("SELECT * FROM league WHERE id = 1").fetchone()
        players = c.execute("SELECT * FROM players ORDER BY name ASC").fetchall()
        matches = c.execute("SELECT * FROM matches ORDER BY id DESC").fetchall()
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
        "players": [dict(p) for p in players],
        "matches": [
            {
                **dict(m),
                "payouts": parse_payouts(m["payouts_json"]),
                "participant_ids": parse_participant_ids(m["participant_ids_json"]) or fallback_participant_ids,
            }
            for m in matches
        ],
    }


def upsert_league(payload: LeaguePayload) -> dict[str, str]:
    if get_supabase_client() and SUPABASE_SERVICE_AVAILABLE:
        return supabase_upsert_league(payload)
    
    # Fallback to SQLite
    payouts_json = json.dumps(payload.payouts)
    with DatabaseManager() as c:
        cursor = c.execute(
            """
            INSERT INTO league (id, name, tournament, entry_fee, active_player_count, default_winner_count, payouts_json)
            VALUES (1, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                tournament = excluded.tournament,
                entry_fee = excluded.entry_fee,
                active_player_count = excluded.active_player_count,
                default_winner_count = excluded.default_winner_count,
                payouts_json = excluded.payouts_json
            """,
            (
                payload.name.strip(),
                payload.tournament.strip(),
                payload.entry_fee,
                payload.active_player_count,
                payload.default_winner_count,
                payouts_json,
            ),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=500, detail="League settings were not persisted")
    return {"message": "League settings saved"}


def add_player(payload: PlayerPayload) -> dict[str, str]:
    if get_supabase_client() and SUPABASE_SERVICE_AVAILABLE:
        return supabase_add_player(payload)
    
    # Fallback to SQLite
    player_name = payload.name.strip()
    try:
        with DatabaseManager() as c:
            cursor = c.execute("INSERT INTO players (name) VALUES (?)", (player_name,))
            if cursor.rowcount != 1:
                raise HTTPException(status_code=500, detail="Player insert failed")
            exists = c.execute("SELECT id FROM players WHERE name = ? LIMIT 1", (player_name,)).fetchone()
            if not exists:
                raise HTTPException(status_code=500, detail="Player insert verification failed")
    except Exception as exc:
        if "UNIQUE" in str(exc).upper():
            raise HTTPException(status_code=409, detail="Player already exists")
        if isinstance(exc, HTTPException):
            raise
        raise
    return {"message": "Player added"}


def delete_player(player_id: int) -> dict[str, str]:
    if get_supabase_client() and SUPABASE_SERVICE_AVAILABLE:
        return supabase_delete_player(player_id)
    
    # Fallback to SQLite
    with DatabaseManager() as c:
        cursor = c.execute("DELETE FROM players WHERE id = ?", (player_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Player not found")
    return {"message": "Player removed"}


def add_match(payload: MatchPayload) -> dict[str, str]:
    if get_supabase_client() and SUPABASE_SERVICE_AVAILABLE:
        return supabase_add_match(payload)
    
    # Fallback to SQLite
    payouts_json = json.dumps(payload.payouts) if payload.payouts else None
    with DatabaseManager() as c:
        players = c.execute("SELECT id FROM players ORDER BY id ASC").fetchall()
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

        cursor = c.execute(
            "INSERT INTO matches (title, match_date, winner_count, payouts_json, participant_ids_json) VALUES (?, ?, ?, ?, ?)",
            (
                payload.title.strip(),
                payload.match_date.strip(),
                payload.winner_count,
                payouts_json,
                json.dumps(participant_ids),
            ),
        )
        if cursor.rowcount != 1:
            raise HTTPException(status_code=500, detail="Match insert failed")
        created_match = c.execute("SELECT id FROM matches WHERE id = ? LIMIT 1", (cursor.lastrowid,)).fetchone()
        if not created_match:
            raise HTTPException(status_code=500, detail="Match insert verification failed")
    return {"message": "Match added"}


def save_winners(match_id: int, payload: WinnersPayload) -> dict[str, str]:
    if get_supabase_client() and SUPABASE_SERVICE_AVAILABLE:
        return supabase_save_winners(match_id, payload)
    
    # Fallback to SQLite
    with DatabaseManager() as c:
        match_row = c.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
        league_row = c.execute("SELECT * FROM league WHERE id = 1").fetchone()
        players_by_id = {
            int(row["id"]): dict(row)
            for row in c.execute("SELECT id, name FROM players ORDER BY id ASC").fetchall()
        }
        if not match_row or not league_row:
            raise HTTPException(status_code=404, detail="League or match not found")

        payouts = parse_payouts(match_row["payouts_json"]) or parse_payouts(league_row["payouts_json"])
        winner_limit = int(match_row["winner_count"] or league_row["default_winner_count"])
        participant_ids = parse_participant_ids(match_row["participant_ids_json"]) or list(players_by_id.keys())

        rank_to_players = {row.rank: [pid for pid in row.player_ids] for row in payload.ranks}

        used_players: set[int] = set()
        for rank_players in rank_to_players.values():
            for player_id in rank_players:
                if player_id not in participant_ids:
                    raise HTTPException(status_code=400, detail="Only match participants can be assigned as winners")
                if player_id in used_players:
                    raise HTTPException(status_code=400, detail="A player is assigned in multiple ranks")
                used_players.add(player_id)

        c.execute("DELETE FROM winner_entries WHERE match_id = ?", (match_id,))

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
                c.execute(
                    "INSERT INTO winner_entries (match_id, rank, player_id, amount) VALUES (?, ?, ?, ?)",
                    (match_id, rank, player_id, split_amount),
                )

            rank += max(1, tie_size)

        c.execute("UPDATE matches SET status = 'completed' WHERE id = ?", (match_id,))

    return {"message": "Winners saved"}


def cancel_match(match_id: int) -> dict[str, str]:
    if get_supabase_client() and SUPABASE_SERVICE_AVAILABLE:
        return supabase_cancel_match(match_id)
    
    # Fallback to SQLite
    with DatabaseManager() as c:
        match_row = c.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
        league_row = c.execute("SELECT * FROM league WHERE id = 1").fetchone()
        players = c.execute("SELECT id FROM players ORDER BY id ASC").fetchall()

        if not match_row or not league_row:
            raise HTTPException(status_code=404, detail="League or match not found")

        participant_ids = parse_participant_ids(match_row["participant_ids_json"]) or [int(player["id"]) for player in players]
        c.execute("DELETE FROM winner_entries WHERE match_id = ?", (match_id,))

        if participant_ids:
            pool = float(league_row["entry_fee"]) * len(participant_ids)
            split = round(pool / len(participant_ids), 2)
            remainder = round(pool - (split * len(participant_ids)), 2)

            for idx, player_id in enumerate(participant_ids):
                amount = split + (remainder if idx == 0 else 0.0)
                c.execute(
                    "INSERT INTO winner_entries (match_id, rank, player_id, amount) VALUES (?, ?, ?, ?)",
                    (match_id, 0, int(player_id), round(amount, 2)),
                )

        c.execute("UPDATE matches SET status = 'canceled' WHERE id = ?", (match_id,))

    return {"message": "Match marked as canceled and refund distributed equally"}


def get_ledger() -> dict[str, Any]:
    if get_supabase_client() and SUPABASE_SERVICE_AVAILABLE:
        return supabase_get_ledger()
    
    # Fallback to SQLite
    with DatabaseManager() as c:
        league_row = c.execute("SELECT * FROM league WHERE id = 1").fetchone()
        if not league_row:
            return {"rows": [], "completed_matches": 0, "entry_fee": 0}

        players = c.execute("SELECT id, name FROM players ORDER BY name ASC").fetchall()
        matches = c.execute(
            "SELECT id, participant_ids_json FROM matches WHERE status IN ('completed', 'canceled') ORDER BY id DESC"
        ).fetchall()
        winnings = c.execute(
            "SELECT player_id, COALESCE(SUM(amount), 0) AS total FROM winner_entries GROUP BY player_id"
        ).fetchall()

    winnings_map = {row["player_id"]: float(row["total"]) for row in winnings}
    entry_fee = float(league_row["entry_fee"])
    completed_matches = len(matches)
    fallback_participants = [int(player["id"]) for player in players]
    match_counts_by_player: dict[int, int] = {}

    for match in matches:
        participant_ids = parse_participant_ids(match["participant_ids_json"]) or fallback_participants
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
    if get_supabase_client() and SUPABASE_SERVICE_AVAILABLE:
        return supabase_get_stats()

    with DatabaseManager() as c:
        players = c.execute("SELECT id, name FROM players ORDER BY name ASC").fetchall()
        matches = c.execute(
            "SELECT id, title, match_date, status, participant_ids_json FROM matches ORDER BY id DESC"
        ).fetchall()
        winners = c.execute(
            """
            SELECT
                we.match_id,
                we.rank,
                we.player_id,
                we.amount,
                COALESCE(p.name, 'Archived Player #' || we.player_id) AS player_name
            FROM winner_entries we
            LEFT JOIN players p ON p.id = we.player_id
            ORDER BY we.match_id DESC, we.rank ASC, player_name ASC
            """
        ).fetchall()

    player_name_by_id = {int(player["id"]): str(player["name"]) for player in players}
    player_stats: dict[int, dict[str, Any]] = {
        p["id"]: {
            "player_id": p["id"],
            "name": p["name"],
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
        by_match.setdefault(row["match_id"], []).append(dict(row))
        winner_lookup.setdefault(int(row["match_id"]), {})[int(row["player_id"])] = {
            "rank": int(row["rank"]),
            "amount": float(row["amount"]),
        }

        stat = player_stats.get(row["player_id"])
        if not stat:
            stat = {
                "player_id": row["player_id"],
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
            player_stats[row["player_id"]] = stat
        if int(row["rank"]) == 1:
            stat["wins_total"] += 1
        if int(row["rank"]) == 0:
            stat["_washout_match_ids"].add(int(row["match_id"]))
        rank_key = str(row["rank"])
        stat["rank_counts"][rank_key] = int(stat["rank_counts"].get(rank_key, 0)) + 1
        stat["total_amount"] = round(float(stat["total_amount"]) + float(row["amount"]), 2)

    for match_id, rows in by_match.items():
        unique_players = {r["player_id"] for r in rows if int(r["rank"]) > 0}
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

        participant_ids = _normalize_participant_ids(parse_participant_ids(match["participant_ids_json"]))
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
                "title": match["title"],
                "match_date": match["match_date"],
                "status": match["status"],
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
