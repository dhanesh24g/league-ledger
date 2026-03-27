from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "prototype.db"
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Dream11 League Prototype")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class LeaguePayload(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    tournament: str = Field(default="IPL")
    entry_fee: float = Field(gt=0)
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


def conn() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def parse_payouts(raw: str | None) -> dict[int, float]:
    if not raw:
        return {}
    data = json.loads(raw)
    return {int(k): float(v) for k, v in data.items()}


def init_db() -> None:
    with conn() as c:
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS league (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                name TEXT NOT NULL,
                tournament TEXT NOT NULL,
                entry_fee REAL NOT NULL,
                default_winner_count INTEGER NOT NULL,
                payouts_json TEXT NOT NULL
            )
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS players (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE
            )
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS matches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                match_date TEXT NOT NULL,
                winner_count INTEGER,
                payouts_json TEXT,
                status TEXT NOT NULL DEFAULT 'pending'
            )
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS winner_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                match_id INTEGER NOT NULL,
                rank INTEGER NOT NULL,
                player_id INTEGER NOT NULL,
                amount REAL NOT NULL,
                FOREIGN KEY(match_id) REFERENCES matches(id),
                FOREIGN KEY(player_id) REFERENCES players(id)
            )
            """
        )


@app.on_event("startup")
def startup() -> None:
    init_db()


@app.get("/")
def root() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/state")
def state() -> dict[str, Any]:
    with conn() as c:
        league = c.execute("SELECT * FROM league WHERE id = 1").fetchone()
        players = c.execute("SELECT * FROM players ORDER BY name ASC").fetchall()
        matches = c.execute("SELECT * FROM matches ORDER BY id DESC").fetchall()

    return {
        "league": {
            "name": league["name"],
            "tournament": league["tournament"],
            "entry_fee": league["entry_fee"],
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


@app.post("/api/league")
def upsert_league(payload: LeaguePayload) -> dict[str, str]:
    payouts_json = json.dumps(payload.payouts)
    with conn() as c:
        c.execute(
            """
            INSERT INTO league (id, name, tournament, entry_fee, default_winner_count, payouts_json)
            VALUES (1, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                tournament = excluded.tournament,
                entry_fee = excluded.entry_fee,
                default_winner_count = excluded.default_winner_count,
                payouts_json = excluded.payouts_json
            """,
            (
                payload.name.strip(),
                payload.tournament.strip(),
                payload.entry_fee,
                payload.default_winner_count,
                payouts_json,
            ),
        )
    return {"message": "League settings saved"}


@app.post("/api/players")
def add_player(payload: PlayerPayload) -> dict[str, str]:
    try:
        with conn() as c:
            c.execute("INSERT INTO players (name) VALUES (?)", (payload.name.strip(),))
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="Player already exists")
    return {"message": "Player added"}


@app.delete("/api/players/{player_id}")
def delete_player(player_id: int) -> dict[str, str]:
    with conn() as c:
        c.execute("DELETE FROM players WHERE id = ?", (player_id,))
    return {"message": "Player removed"}


@app.post("/api/matches")
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


@app.post("/api/matches/{match_id}/winners")
def save_winners(match_id: int, payload: WinnersPayload) -> dict[str, str]:
    with conn() as c:
        match_row = c.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
        league_row = c.execute("SELECT * FROM league WHERE id = 1").fetchone()
        if not match_row or not league_row:
            raise HTTPException(status_code=404, detail="League or match not found")

        payouts = parse_payouts(match_row["payouts_json"]) or parse_payouts(league_row["payouts_json"])

        c.execute("DELETE FROM winner_entries WHERE match_id = ?", (match_id,))

        for row in payload.ranks:
            winners = [pid for pid in row.player_ids]
            if not winners:
                continue
            rank_amount = payouts.get(row.rank, 0.0)
            split_amount = round(rank_amount / len(winners), 2) if winners else 0.0
            for player_id in winners:
                c.execute(
                    "INSERT INTO winner_entries (match_id, rank, player_id, amount) VALUES (?, ?, ?, ?)",
                    (match_id, row.rank, player_id, split_amount),
                )

        c.execute("UPDATE matches SET status = 'completed' WHERE id = ?", (match_id,))

    return {"message": "Winners saved"}


@app.get("/api/ledger")
def ledger() -> dict[str, Any]:
    with conn() as c:
        league_row = c.execute("SELECT * FROM league WHERE id = 1").fetchone()
        if not league_row:
            return {"rows": [], "completed_matches": 0, "entry_fee": 0}

        completed_matches = c.execute("SELECT COUNT(*) AS count FROM matches WHERE status = 'completed'").fetchone()[
            "count"
        ]
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


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=8001, reload=True)
