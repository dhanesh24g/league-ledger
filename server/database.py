from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
from pathlib import Path
from typing import Any

try:
    from supabase import Client, create_client

    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False
    Client = Any  # type: ignore[assignment]

BASE_DIR = Path(__file__).resolve().parent.parent
DB_PATH = BASE_DIR / "prototype.db"

_supabase_client: Client | None = None
_supabase_signature: tuple[str, str] | None = None
logger = logging.getLogger(__name__)


def get_supabase_client() -> Client | None:
    global _supabase_client, _supabase_signature

    if not SUPABASE_AVAILABLE:
        return None

    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
    if not supabase_url or not supabase_key:
        return None

    try:
        signature = (supabase_url, supabase_key)
        if _supabase_client is None or _supabase_signature != signature:
            # Create client without timeout options for now (the options format was incorrect)
            _supabase_client = create_client(supabase_url, supabase_key)
            _supabase_signature = signature
        return _supabase_client
    except Exception:
        logger.exception("Failed to initialize Supabase client")
        return None


def get_connection() -> Any:
    supabase = get_supabase_client()
    if supabase:
        return supabase
    return sqlite3.connect(DB_PATH)


def init_database() -> None:
    supabase = get_supabase_client()
    if supabase:
        init_supabase_schema()
        return

    if os.getenv("VERCEL"):
        raise RuntimeError(
            "Supabase environment variables (SUPABASE_URL and SUPABASE_ANON_KEY) "
            "must be set in Vercel deployment. SQLite is not supported in serverless functions."
        )

    init_sqlite_db()


def init_supabase_schema() -> None:
    logger.info("Supabase client available; assuming schema is managed externally.")


def _table_exists(connection: sqlite3.Connection, table_name: str) -> bool:
    row = connection.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table_name,),
    ).fetchone()
    return row is not None


def _table_columns(connection: sqlite3.Connection, table_name: str) -> set[str]:
    if not _table_exists(connection, table_name):
        return set()
    rows = connection.execute(f"PRAGMA table_info({table_name})").fetchall()
    return {str(row[1]) for row in rows}


def _slugify_code_seed(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", value.strip().lower())
    normalized = normalized.strip("-")
    return normalized or "league"


def _build_invite_code(existing_codes: set[str], name: str, league_id: int) -> str:
    base = _slugify_code_seed(name)
    candidate = f"{base}-{league_id}"
    suffix = 2
    while candidate in existing_codes:
        candidate = f"{base}-{league_id}-{suffix}"
        suffix += 1
    existing_codes.add(candidate)
    return candidate


def _create_sqlite_tables(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            first_name TEXT NOT NULL,
            last_name TEXT NOT NULL,
            user_id TEXT NOT NULL UNIQUE,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )

    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS league (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sport TEXT NOT NULL DEFAULT 'Cricket',
            name TEXT NOT NULL,
            tournament TEXT NOT NULL,
            entry_fee REAL NOT NULL,
            active_player_count INTEGER NOT NULL DEFAULT 5,
            owner_user_id INTEGER,
            default_winner_count INTEGER NOT NULL,
            payouts_json TEXT NOT NULL,
            invite_code TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(owner_user_id) REFERENCES users(id)
        )
        """
    )

    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS league_memberships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            league_id INTEGER NOT NULL,
            role TEXT NOT NULL DEFAULT 'read',
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, league_id),
            FOREIGN KEY(user_id) REFERENCES users(id),
            FOREIGN KEY(league_id) REFERENCES league(id)
        )
        """
    )

    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS league_join_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            league_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            reviewed_at TEXT,
            UNIQUE(user_id, league_id),
            FOREIGN KEY(user_id) REFERENCES users(id),
            FOREIGN KEY(league_id) REFERENCES league(id)
        )
        """
    )

    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS players (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            league_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            UNIQUE(league_id, name),
            FOREIGN KEY(league_id) REFERENCES league(id)
        )
        """
    )

    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            league_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            match_date TEXT NOT NULL,
            winner_count INTEGER,
            payouts_json TEXT,
            participant_ids_json TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            FOREIGN KEY(league_id) REFERENCES league(id)
        )
        """
    )

    connection.execute(
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

    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token_hash TEXT NOT NULL UNIQUE,
            expires_at TEXT NOT NULL,
            used_at TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
        """
    )


def _copy_table(connection: sqlite3.Connection, source: str, target: str, columns: list[str]) -> None:
    if not _table_exists(connection, source):
        return
    select_columns = ", ".join(columns)
    connection.execute(
        f"INSERT INTO {target} ({select_columns}) SELECT {select_columns} FROM {source}"
    )


def _migrate_single_league_schema(connection: sqlite3.Connection) -> None:
    connection.execute("PRAGMA foreign_keys = OFF")
    for table_name in [
        "league",
        "league_memberships",
        "league_join_requests",
        "players",
        "matches",
        "winner_entries",
    ]:
        if _table_exists(connection, table_name):
            connection.execute(f"ALTER TABLE {table_name} RENAME TO {table_name}_legacy")

    _create_sqlite_tables(connection)

    existing_codes: set[str] = set()
    if _table_exists(connection, "league_legacy"):
        leagues = connection.execute(
            """
            SELECT
                id,
                name,
                tournament,
                entry_fee,
                active_player_count,
                owner_user_id,
                default_winner_count,
                payouts_json
            FROM league_legacy
            ORDER BY id ASC
            """
        ).fetchall()
        for row in leagues:
            invite_code = _build_invite_code(existing_codes, str(row["name"]), int(row["id"]))
            connection.execute(
                """
                INSERT INTO league (
                    id,
                    name,
                    tournament,
                    entry_fee,
                    active_player_count,
                    owner_user_id,
                    default_winner_count,
                    payouts_json,
                    invite_code
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    int(row["id"]),
                    row["name"],
                    row["tournament"],
                    row["entry_fee"],
                    row["active_player_count"],
                    row["owner_user_id"],
                    row["default_winner_count"],
                    row["payouts_json"],
                    invite_code,
                ),
            )

    legacy_league_id = 1 if _table_exists(connection, "league_legacy") else None

    if _table_exists(connection, "league_memberships_legacy") and legacy_league_id is not None:
        rows = connection.execute(
            "SELECT user_id, role, status, created_at FROM league_memberships_legacy"
        ).fetchall()
        for row in rows:
            connection.execute(
                """
                INSERT INTO league_memberships (user_id, league_id, role, status, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    row["user_id"],
                    legacy_league_id,
                    row["role"],
                    row["status"],
                    row["created_at"],
                ),
            )

    if _table_exists(connection, "league_join_requests_legacy") and legacy_league_id is not None:
        rows = connection.execute(
            "SELECT user_id, status, created_at, reviewed_at FROM league_join_requests_legacy"
        ).fetchall()
        for row in rows:
            connection.execute(
                """
                INSERT INTO league_join_requests (user_id, league_id, status, created_at, reviewed_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    row["user_id"],
                    legacy_league_id,
                    row["status"],
                    row["created_at"],
                    row["reviewed_at"],
                ),
            )

    if _table_exists(connection, "players_legacy") and legacy_league_id is not None:
        rows = connection.execute("SELECT id, name FROM players_legacy ORDER BY id ASC").fetchall()
        for row in rows:
            connection.execute(
                "INSERT INTO players (id, league_id, name) VALUES (?, ?, ?)",
                (int(row["id"]), legacy_league_id, row["name"]),
            )

    if _table_exists(connection, "matches_legacy") and legacy_league_id is not None:
        rows = connection.execute(
            """
            SELECT id, title, match_date, winner_count, payouts_json, participant_ids_json, status
            FROM matches_legacy
            ORDER BY id ASC
            """
        ).fetchall()
        for row in rows:
            connection.execute(
                """
                INSERT INTO matches (
                    id,
                    league_id,
                    title,
                    match_date,
                    winner_count,
                    payouts_json,
                    participant_ids_json,
                    status
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    int(row["id"]),
                    legacy_league_id,
                    row["title"],
                    row["match_date"],
                    row["winner_count"],
                    row["payouts_json"],
                    row["participant_ids_json"],
                    row["status"],
                ),
            )

    if _table_exists(connection, "winner_entries_legacy"):
        rows = connection.execute(
            "SELECT id, match_id, rank, player_id, amount FROM winner_entries_legacy ORDER BY id ASC"
        ).fetchall()
        for row in rows:
            connection.execute(
                """
                INSERT INTO winner_entries (id, match_id, rank, player_id, amount)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    int(row["id"]),
                    int(row["match_id"]),
                    int(row["rank"]),
                    int(row["player_id"]),
                    float(row["amount"]),
                ),
            )

    for table_name in [
        "winner_entries_legacy",
        "matches_legacy",
        "players_legacy",
        "league_join_requests_legacy",
        "league_memberships_legacy",
        "league_legacy",
    ]:
        if _table_exists(connection, table_name):
            connection.execute(f"DROP TABLE {table_name}")
    connection.execute("PRAGMA foreign_keys = ON")


def _has_legacy_tables(connection: sqlite3.Connection) -> bool:
    return any(
        _table_exists(connection, table_name)
        for table_name in [
            "league_legacy",
            "league_memberships_legacy",
            "league_join_requests_legacy",
            "players_legacy",
            "matches_legacy",
            "winner_entries_legacy",
        ]
    )


def _recover_interrupted_migration(connection: sqlite3.Connection) -> None:
    if not _has_legacy_tables(connection):
        return

    connection.execute("PRAGMA foreign_keys = OFF")
    for table_name in ["winner_entries", "matches", "players", "league_join_requests", "league_memberships", "league"]:
        if _table_exists(connection, table_name):
            connection.execute(f"DROP TABLE {table_name}")

    _create_sqlite_tables(connection)

    existing_codes: set[str] = set()
    if _table_exists(connection, "league_legacy"):
        leagues = connection.execute(
            """
            SELECT id, name, tournament, entry_fee, active_player_count, owner_user_id, default_winner_count, payouts_json
            FROM league_legacy
            ORDER BY id ASC
            """
        ).fetchall()
        for row in leagues:
            invite_code = _build_invite_code(existing_codes, str(row["name"]), int(row["id"]))
            connection.execute(
                """
                INSERT INTO league (
                    id, name, tournament, entry_fee, active_player_count, owner_user_id, default_winner_count, payouts_json, invite_code
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    int(row["id"]),
                    row["name"],
                    row["tournament"],
                    row["entry_fee"],
                    row["active_player_count"],
                    row["owner_user_id"],
                    row["default_winner_count"],
                    row["payouts_json"],
                    invite_code,
                ),
            )

    legacy_league_id = 1 if _table_exists(connection, "league_legacy") else None

    if _table_exists(connection, "league_memberships_legacy") and legacy_league_id is not None:
        rows = connection.execute("SELECT user_id, role, status, created_at FROM league_memberships_legacy").fetchall()
        for row in rows:
            connection.execute(
                """
                INSERT INTO league_memberships (user_id, league_id, role, status, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (row["user_id"], legacy_league_id, row["role"], row["status"], row["created_at"]),
            )

    if _table_exists(connection, "league_join_requests_legacy") and legacy_league_id is not None:
        rows = connection.execute(
            "SELECT user_id, status, created_at, reviewed_at FROM league_join_requests_legacy"
        ).fetchall()
        for row in rows:
            connection.execute(
                """
                INSERT INTO league_join_requests (user_id, league_id, status, created_at, reviewed_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (row["user_id"], legacy_league_id, row["status"], row["created_at"], row["reviewed_at"]),
            )

    if _table_exists(connection, "players_legacy") and legacy_league_id is not None:
        rows = connection.execute("SELECT id, name FROM players_legacy ORDER BY id ASC").fetchall()
        for row in rows:
            connection.execute(
                "INSERT INTO players (id, league_id, name) VALUES (?, ?, ?)",
                (int(row["id"]), legacy_league_id, row["name"]),
            )

    if _table_exists(connection, "matches_legacy") and legacy_league_id is not None:
        rows = connection.execute(
            """
            SELECT id, title, match_date, winner_count, payouts_json, participant_ids_json, status
            FROM matches_legacy
            ORDER BY id ASC
            """
        ).fetchall()
        for row in rows:
            connection.execute(
                """
                INSERT INTO matches (
                    id, league_id, title, match_date, winner_count, payouts_json, participant_ids_json, status
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    int(row["id"]),
                    legacy_league_id,
                    row["title"],
                    row["match_date"],
                    row["winner_count"],
                    row["payouts_json"],
                    row["participant_ids_json"],
                    row["status"],
                ),
            )

    if _table_exists(connection, "winner_entries_legacy"):
        rows = connection.execute(
            "SELECT id, match_id, rank, player_id, amount FROM winner_entries_legacy ORDER BY id ASC"
        ).fetchall()
        for row in rows:
            connection.execute(
                "INSERT INTO winner_entries (id, match_id, rank, player_id, amount) VALUES (?, ?, ?, ?, ?)",
                (int(row["id"]), int(row["match_id"]), int(row["rank"]), int(row["player_id"]), float(row["amount"])),
            )

    for table_name in [
        "winner_entries_legacy",
        "matches_legacy",
        "players_legacy",
        "league_join_requests_legacy",
        "league_memberships_legacy",
        "league_legacy",
    ]:
        if _table_exists(connection, table_name):
            connection.execute(f"DROP TABLE {table_name}")
    connection.execute("PRAGMA foreign_keys = ON")


def _needs_multileague_migration(connection: sqlite3.Connection) -> bool:
    if not _table_exists(connection, "league"):
        return False
    league_columns = _table_columns(connection, "league")
    membership_columns = _table_columns(connection, "league_memberships")
    request_columns = _table_columns(connection, "league_join_requests")
    player_columns = _table_columns(connection, "players")
    match_columns = _table_columns(connection, "matches")
    return (
        "invite_code" not in league_columns
        or "league_id" not in membership_columns
        or "league_id" not in request_columns
        or "league_id" not in player_columns
        or "league_id" not in match_columns
    )


def init_sqlite_db() -> None:
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")

    with connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                first_name TEXT NOT NULL,
                last_name TEXT NOT NULL,
                user_id TEXT NOT NULL UNIQUE,
                email TEXT NOT NULL UNIQUE,
                google_sub TEXT UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        try:
            connection.execute("ALTER TABLE users ADD COLUMN google_sub TEXT")
        except sqlite3.OperationalError:
            pass
        connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub)")
        try:
            connection.execute("ALTER TABLE league ADD COLUMN sport TEXT NOT NULL DEFAULT 'Cricket'")
        except sqlite3.OperationalError:
            pass

        if _has_legacy_tables(connection):
            _recover_interrupted_migration(connection)
        elif _needs_multileague_migration(connection):
            _migrate_single_league_schema(connection)
        else:
            _create_sqlite_tables(connection)

    connection.close()


class DatabaseManager:
    def __init__(self):
        self.connection = None
        self.supabase = get_supabase_client()

    def __enter__(self):
        if self.supabase:
            self.connection = self.supabase
        else:
            self.connection = sqlite3.connect(DB_PATH)
            self.connection.row_factory = sqlite3.Row
            self.connection.execute("PRAGMA foreign_keys = ON")
        return self.connection

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.connection and not self.supabase:
            if exc_type is None:
                self.connection.commit()
            else:
                self.connection.rollback()
            self.connection.close()


def parse_payouts(raw: str | None) -> dict[int, float]:
    if not raw:
        return {}
    data = json.loads(raw)
    return {int(k): float(v) for k, v in data.items()}


def parse_participant_ids(raw: Any) -> list[int]:
    if raw in (None, ""):
        return []

    data = raw
    if isinstance(raw, str):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return []

    if not isinstance(data, (list, tuple)):
        return []

    participant_ids: list[int] = []
    for item in data:
        try:
            participant_ids.append(int(item))
        except (TypeError, ValueError):
            continue
    return participant_ids
