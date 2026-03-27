from __future__ import annotations

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


def get_supabase_client() -> Client | None:
    """Get Supabase client if configured"""
    global _supabase_client
    
    if not SUPABASE_AVAILABLE:
        return None
        
    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_ANON_KEY")
    
    if not supabase_url or not supabase_key:
        return None
    
    try:
        if _supabase_client is None:
            _supabase_client = create_client(supabase_url, supabase_key)
        return _supabase_client
    except Exception as e:
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
    
    # Create tables using raw SQL
    tables_sql = [
        """
        CREATE TABLE IF NOT EXISTS league (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            tournament TEXT NOT NULL,
            entry_fee REAL NOT NULL,
            active_player_count INTEGER NOT NULL DEFAULT 5,
            default_winner_count INTEGER NOT NULL,
            payouts_json TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS players (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL UNIQUE
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS matches (
            id SERIAL PRIMARY KEY,
            title TEXT NOT NULL,
            match_date TEXT NOT NULL,
            winner_count INTEGER,
            payouts_json TEXT,
            status TEXT NOT NULL DEFAULT 'pending'
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS winner_entries (
            id SERIAL PRIMARY KEY,
            match_id INTEGER NOT NULL,
            rank INTEGER NOT NULL,
            player_id INTEGER NOT NULL,
            amount REAL NOT NULL,
            FOREIGN KEY(match_id) REFERENCES matches(id),
            FOREIGN KEY(player_id) REFERENCES players(id)
        )
        """
    ]
    
    # Execute table creation
    for sql in tables_sql:
        try:
            # Use Supabase RPC or direct SQL execution
            # For now, we'll assume tables are created manually in Supabase dashboard
            pass
        except Exception as e:
            print(f"Table creation note: {e}")


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
                default_winner_count INTEGER NOT NULL,
                payouts_json TEXT NOT NULL
            )
        """)
        
        try:
            connection.execute("ALTER TABLE league ADD COLUMN active_player_count INTEGER NOT NULL DEFAULT 5")
        except sqlite3.OperationalError:
            pass

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
                status TEXT NOT NULL DEFAULT 'pending'
            )
        """)
        
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
            self.connection.close()


def parse_payouts(raw: str | None) -> dict[int, float]:
    """Parse payouts from JSON string"""
    import json
    if not raw:
        return {}
    data = json.loads(raw)
    return {int(k): float(v) for k, v in data.items()}
