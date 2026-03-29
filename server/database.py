from __future__ import annotations

import logging
import os
from typing import Any

# Supabase imports
try:
    from supabase import create_client, Client
    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False

# SQLite imports
import sqlite3
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DB_PATH = BASE_DIR / "prototype.db"

# Global Supabase client
_supabase_client: Client | None = None
_supabase_signature: tuple[str, str] | None = None
logger = logging.getLogger(__name__)


def get_supabase_client() -> Client | None:
    """Get Supabase client if configured"""
    global _supabase_client, _supabase_signature
    
    if not SUPABASE_AVAILABLE:
        return None
        
    supabase_url = os.getenv("SUPABASE_URL")
    # Use service-role key for server-side writes when available.
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
    
    if not supabase_url or not supabase_key:
        return None
    
    try:
        signature = (supabase_url, supabase_key)
        if _supabase_client is None or _supabase_signature != signature:
            _supabase_client = create_client(supabase_url, supabase_key)
            _supabase_signature = signature
        return _supabase_client
    except Exception:
        logger.exception("Failed to initialize Supabase client")
        return None


def get_connection() -> Any:
    """Get database connection based on environment"""
    # Check if Supabase is configured
    supabase = get_supabase_client()
    if supabase:
        return supabase
    
    # Fallback to SQLite for local development
    return sqlite3.connect(DB_PATH)


def init_database() -> None:
    """Initialize database tables"""
    supabase = get_supabase_client()
    
    if supabase:
        # Supabase/Postgres schema
        init_supabase_schema()
    else:
        # Check if we're in Vercel environment
        if os.getenv("VERCEL"):
            # In Vercel, we MUST have Supabase configured
            raise RuntimeError(
                "Supabase environment variables (SUPABASE_URL and SUPABASE_ANON_KEY) "
                "must be set in Vercel deployment. SQLite is not supported in serverless functions."
            )
        else:
            # SQLite schema (existing logic) - only for local development
            init_sqlite_db()


def init_supabase_schema() -> None:
    """Initialize Supabase database schema"""
    supabase = get_supabase_client()
    if not supabase:
        return
    
    # Supabase schema should be managed via migrations / SQL editor.
    logger.info("Supabase client available; assuming schema is managed externally.")


def init_sqlite_db() -> None:
    """Initialize SQLite database (existing logic)"""
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    
    with connection:
        connection.execute("""
            CREATE TABLE IF NOT EXISTS league (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                name TEXT NOT NULL,
                tournament TEXT NOT NULL,
                entry_fee REAL NOT NULL,
                active_player_count INTEGER NOT NULL DEFAULT 5,
                owner_user_id INTEGER,
                default_winner_count INTEGER NOT NULL,
                payouts_json TEXT NOT NULL,
                FOREIGN KEY(owner_user_id) REFERENCES users(id)
            )
        """)
        
        try:
            connection.execute("ALTER TABLE league ADD COLUMN active_player_count INTEGER NOT NULL DEFAULT 5")
        except sqlite3.OperationalError:
            pass
        try:
            connection.execute("ALTER TABLE league ADD COLUMN owner_user_id INTEGER")
        except sqlite3.OperationalError:
            pass

        connection.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                first_name TEXT NOT NULL,
                last_name TEXT NOT NULL,
                user_id TEXT NOT NULL UNIQUE,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)

        connection.execute("""
            CREATE TABLE IF NOT EXISTS league_memberships (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL UNIQUE,
                role TEXT NOT NULL DEFAULT 'viewer',
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
        """)

        connection.execute("""
            CREATE TABLE IF NOT EXISTS league_join_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL UNIQUE,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                reviewed_at TEXT,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
        """)

        connection.execute("""
            CREATE TABLE IF NOT EXISTS players (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE
            )
        """)
        
        connection.execute("""
            CREATE TABLE IF NOT EXISTS matches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                match_date TEXT NOT NULL,
                winner_count INTEGER,
                payouts_json TEXT,
                participant_ids_json TEXT,
                status TEXT NOT NULL DEFAULT 'pending'
            )
        """)

        try:
            connection.execute("ALTER TABLE matches ADD COLUMN participant_ids_json TEXT")
        except sqlite3.OperationalError:
            pass
        
        connection.execute("""
            CREATE TABLE IF NOT EXISTS winner_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                match_id INTEGER NOT NULL,
                rank INTEGER NOT NULL,
                player_id INTEGER NOT NULL,
                amount REAL NOT NULL,
                FOREIGN KEY(match_id) REFERENCES matches(id),
                FOREIGN KEY(player_id) REFERENCES players(id)
            )
        """)


class DatabaseManager:
    """Database manager that works with both SQLite and Supabase"""
    
    def __init__(self):
        self.connection = None
        self.supabase = get_supabase_client()
    
    def __enter__(self):
        if self.supabase:
            self.connection = self.supabase
        else:
            self.connection = sqlite3.connect(DB_PATH)
            self.connection.row_factory = sqlite3.Row
            
        return self.connection
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.connection and not self.supabase:
            if exc_type is None:
                self.connection.commit()
            else:
                self.connection.rollback()
            self.connection.close()


def parse_payouts(raw: str | None) -> dict[int, float]:
    """Parse payouts from JSON string"""
    import json
    if not raw:
        return {}
    data = json.loads(raw)
    return {int(k): float(v) for k, v in data.items()}


def parse_participant_ids(raw: Any) -> list[int]:
    """Parse participant ids from JSON string or array-like value"""
    import json

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
