from __future__ import annotations

import json
import sqlite3
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DB_PATH = BASE_DIR / "prototype.db"


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
                active_player_count INTEGER NOT NULL DEFAULT 5,
                default_winner_count INTEGER NOT NULL,
                payouts_json TEXT NOT NULL
            )
            """
        )
        try:
            c.execute("ALTER TABLE league ADD COLUMN active_player_count INTEGER NOT NULL DEFAULT 5")
        except sqlite3.OperationalError:
            pass

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
