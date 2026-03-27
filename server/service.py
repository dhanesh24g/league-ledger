from __future__ import annotations

import json
from typing import Any

from fastapi import HTTPException

from .db import conn, parse_payouts
from .schemas import LeaguePayload, MatchPayload, PlayerPayload, WinnersPayload


def get_state() -> dict[str, Any]:
    with conn() as c:
        league = c.execute("SELECT * FROM league WHERE id = 1").fetchone()
        players = c.execute("SELECT * FROM players ORDER BY name ASC").fetchall()
        matches = c.execute("SELECT * FROM matches ORDER BY id DESC").fetchall()

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
            }
            for m in matches
        ],
    }


def upsert_league(payload: LeaguePayload) -> dict[str, str]:
    payouts_json = json.dumps(payload.payouts)
    with conn() as c:
        c.execute(
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
    return {"message": "League settings saved"}


def add_player(payload: PlayerPayload) -> dict[str, str]:
    try:
        with conn() as c:
            c.execute("INSERT INTO players (name) VALUES (?)", (payload.name.strip(),))
    except Exception as exc:
        if "UNIQUE" in str(exc).upper():
            raise HTTPException(status_code=409, detail="Player already exists")
        raise
    return {"message": "Player added"}


def delete_player(player_id: int) -> dict[str, str]:
    with conn() as c:
        c.execute("DELETE FROM players WHERE id = ?", (player_id,))
    return {"message": "Player removed"}


def add_match(payload: MatchPayload) -> dict[str, str]:
    payouts_json = json.dumps(payload.payouts) if payload.payouts else None
    with conn() as c:
        c.execute(
            "INSERT INTO matches (title, match_date, winner_count, payouts_json) VALUES (?, ?, ?, ?)",
            (
                payload.title.strip(),
                payload.match_date.strip(),
                payload.winner_count,
                payouts_json,
            ),
        )
    return {"message": "Match added"}


def save_winners(match_id: int, payload: WinnersPayload) -> dict[str, str]:
    with conn() as c:
        match_row = c.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
        league_row = c.execute("SELECT * FROM league WHERE id = 1").fetchone()
        if not match_row or not league_row:
            raise HTTPException(status_code=404, detail="League or match not found")

        payouts = parse_payouts(match_row["payouts_json"]) or parse_payouts(league_row["payouts_json"])
        winner_limit = int(match_row["winner_count"] or league_row["default_winner_count"])

        rank_to_players = {row.rank: [pid for pid in row.player_ids] for row in payload.ranks}

        used_players: set[int] = set()
        for rank_players in rank_to_players.values():
            for player_id in rank_players:
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
    with conn() as c:
        match_row = c.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
        league_row = c.execute("SELECT * FROM league WHERE id = 1").fetchone()
        players = c.execute("SELECT id FROM players ORDER BY id ASC").fetchall()

        if not match_row or not league_row:
            raise HTTPException(status_code=404, detail="League or match not found")

        c.execute("DELETE FROM winner_entries WHERE match_id = ?", (match_id,))

        if players:
            pool = float(league_row["entry_fee"]) * len(players)
            split = round(pool / len(players), 2)
            remainder = round(pool - (split * len(players)), 2)

            for idx, player in enumerate(players):
                amount = split + (remainder if idx == 0 else 0.0)
                c.execute(
                    "INSERT INTO winner_entries (match_id, rank, player_id, amount) VALUES (?, ?, ?, ?)",
                    (match_id, 0, int(player["id"]), round(amount, 2)),
                )

        c.execute("UPDATE matches SET status = 'canceled' WHERE id = ?", (match_id,))

    return {"message": "Match marked as canceled and refund distributed equally"}


def get_ledger() -> dict[str, Any]:
    with conn() as c:
        league_row = c.execute("SELECT * FROM league WHERE id = 1").fetchone()
        if not league_row:
            return {"rows": [], "completed_matches": 0, "entry_fee": 0}

        completed_matches = c.execute(
            "SELECT COUNT(*) AS count FROM matches WHERE status IN ('completed', 'canceled')"
        ).fetchone()["count"]
        players = c.execute("SELECT id, name FROM players ORDER BY name ASC").fetchall()
        winnings = c.execute(
            "SELECT player_id, COALESCE(SUM(amount), 0) AS total FROM winner_entries GROUP BY player_id"
        ).fetchall()

    winnings_map = {row["player_id"]: float(row["total"]) for row in winnings}
    entry_fee = float(league_row["entry_fee"])

    rows = []
    for player in players:
        spent = round(completed_matches * entry_fee, 2)
        won = round(winnings_map.get(player["id"], 0.0), 2)
        net = round(won - spent, 2)
        rows.append(
            {
                "player_id": player["id"],
                "name": player["name"],
                "spent": spent,
                "won": won,
                "net": net,
            }
        )

    return {
        "rows": rows,
        "completed_matches": completed_matches,
        "entry_fee": entry_fee,
    }
