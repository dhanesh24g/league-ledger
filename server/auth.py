from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Any

from fastapi import Depends, Header, HTTPException

from .database import DatabaseManager, get_supabase_client

TOKEN_TTL_SECONDS = 60 * 60 * 24
PBKDF2_ITERATIONS = 120_000


def _secret() -> bytes:
    return os.getenv("APP_AUTH_SECRET", "league-ledger-secret").encode("utf-8")


def _auth_enabled() -> bool:
    return os.getenv("APP_AUTH_ENABLED", "true").lower() not in {"0", "false", "no", "off"}


def _normalize_user_id(value: str) -> str:
    return "".join(char for char in value.strip().lower() if char.isalnum() or char in {"_", "-", "."})


def _normalize_email(value: str) -> str:
    return value.strip().lower()


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    derived = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt.encode("utf-8"),
        PBKDF2_ITERATIONS,
    )
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt}${base64.b64encode(derived).decode('utf-8')}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        algorithm, iterations_raw, salt, encoded_hash = stored_hash.split("$", 3)
    except ValueError:
        return False

    if algorithm != "pbkdf2_sha256":
        return False

    try:
        iterations = int(iterations_raw)
    except ValueError:
        return False

    derived = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt.encode("utf-8"),
        iterations,
    )
    expected = base64.b64encode(derived).decode("utf-8")
    return hmac.compare_digest(expected, encoded_hash)


def _encode(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")


def _decode(raw: str) -> dict[str, Any]:
    pad = "=" * (-len(raw) % 4)
    data = base64.urlsafe_b64decode((raw + pad).encode("utf-8"))
    return json.loads(data.decode("utf-8"))


def create_token(user: dict[str, Any]) -> str:
    payload = {
        "uid": int(user["id"]),
        "sub": user["user_id"],
        "iat": int(time.time()),
        "exp": int(time.time()) + TOKEN_TTL_SECONDS,
    }
    payload_part = _encode(payload)
    sig = hmac.new(_secret(), payload_part.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{payload_part}.{sig}"


def decode_token(token: str) -> dict[str, Any]:
    try:
        payload_part, sig = token.split(".", 1)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Invalid token") from exc

    expected = hmac.new(_secret(), payload_part.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        raise HTTPException(status_code=401, detail="Invalid token signature")

    payload = _decode(payload_part)
    if int(payload.get("exp", 0)) < int(time.time()):
        raise HTTPException(status_code=401, detail="Token expired")
    return payload


def _build_profile(
    user_row: dict[str, Any],
    league_row: dict[str, Any] | None,
    membership_row: dict[str, Any] | None,
    request_row: dict[str, Any] | None,
) -> dict[str, Any]:
    membership_status = "active" if membership_row and membership_row.get("status") == "active" else "none"
    if membership_status != "active" and request_row and request_row.get("status") == "pending":
        membership_status = "pending"

    league_role = "none"
    if membership_status == "active":
        league_role = str(membership_row.get("role", "viewer")).lower()

    league_summary = None
    if league_row:
        league_summary = {
            "name": league_row.get("name"),
            "tournament": league_row.get("tournament"),
            "owner_user_id": league_row.get("owner_user_id"),
        }

    return {
        "id": int(user_row["id"]),
        "first_name": str(user_row["first_name"]),
        "last_name": str(user_row["last_name"]),
        "full_name": f'{str(user_row["first_name"])} {str(user_row["last_name"])}'.strip(),
        "user_id": str(user_row["user_id"]),
        "email": str(user_row["email"]),
        "role": "viewer",
        "league_role": league_role,
        "membership_status": membership_status,
        "league_exists": bool(league_row),
        "league": league_summary,
    }


def _sqlite_get_profile_by_user_id(user_id_value: str) -> dict[str, Any] | None:
    with DatabaseManager() as connection:
        user = connection.execute(
            "SELECT * FROM users WHERE user_id = ? LIMIT 1",
            (_normalize_user_id(user_id_value),),
        ).fetchone()
        if not user:
            return None

        league = connection.execute("SELECT * FROM league WHERE id = 1").fetchone()
        membership = connection.execute(
            "SELECT * FROM league_memberships WHERE user_id = ? LIMIT 1",
            (int(user["id"]),),
        ).fetchone()
        request = connection.execute(
            "SELECT * FROM league_join_requests WHERE user_id = ? LIMIT 1",
            (int(user["id"]),),
        ).fetchone()
    return _build_profile(dict(user), dict(league) if league else None, dict(membership) if membership else None, dict(request) if request else None)


def _sqlite_get_profile_by_id(user_id_value: int) -> dict[str, Any] | None:
    with DatabaseManager() as connection:
        user = connection.execute(
            "SELECT * FROM users WHERE id = ? LIMIT 1",
            (int(user_id_value),),
        ).fetchone()
        if not user:
            return None

        league = connection.execute("SELECT * FROM league WHERE id = 1").fetchone()
        membership = connection.execute(
            "SELECT * FROM league_memberships WHERE user_id = ? LIMIT 1",
            (int(user["id"]),),
        ).fetchone()
        request = connection.execute(
            "SELECT * FROM league_join_requests WHERE user_id = ? LIMIT 1",
            (int(user["id"]),),
        ).fetchone()
    return _build_profile(dict(user), dict(league) if league else None, dict(membership) if membership else None, dict(request) if request else None)


def _supabase_get_profile_by_user_id(user_id_value: str) -> dict[str, Any] | None:
    supabase = get_supabase_client()
    if not supabase:
        return None

    user_response = supabase.table("users").select("*").eq("user_id", _normalize_user_id(user_id_value)).limit(1).execute()
    if not user_response.data:
        return None

    user = user_response.data[0]
    league_response = supabase.table("league").select("*").limit(1).execute()
    membership_response = supabase.table("league_memberships").select("*").eq("user_id", int(user["id"])).limit(1).execute()
    request_response = supabase.table("league_join_requests").select("*").eq("user_id", int(user["id"])).limit(1).execute()

    league = league_response.data[0] if league_response.data else None
    membership = membership_response.data[0] if membership_response.data else None
    request = request_response.data[0] if request_response.data else None
    return _build_profile(user, league, membership, request)


def _supabase_get_profile_by_id(user_id_value: int) -> dict[str, Any] | None:
    supabase = get_supabase_client()
    if not supabase:
        return None

    user_response = supabase.table("users").select("*").eq("id", int(user_id_value)).limit(1).execute()
    if not user_response.data:
        return None

    user = user_response.data[0]
    league_response = supabase.table("league").select("*").limit(1).execute()
    membership_response = supabase.table("league_memberships").select("*").eq("user_id", int(user["id"])).limit(1).execute()
    request_response = supabase.table("league_join_requests").select("*").eq("user_id", int(user["id"])).limit(1).execute()

    league = league_response.data[0] if league_response.data else None
    membership = membership_response.data[0] if membership_response.data else None
    request = request_response.data[0] if request_response.data else None
    return _build_profile(user, league, membership, request)


def get_user_profile_by_user_id(user_id_value: str) -> dict[str, Any] | None:
    if get_supabase_client():
        return _supabase_get_profile_by_user_id(user_id_value)
    return _sqlite_get_profile_by_user_id(user_id_value)


def get_user_profile_by_id(user_id_value: int) -> dict[str, Any] | None:
    if get_supabase_client():
        return _supabase_get_profile_by_id(user_id_value)
    return _sqlite_get_profile_by_id(user_id_value)


def auth_config() -> dict[str, Any]:
    return {
        "enabled": _auth_enabled(),
        "signup_enabled": True,
    }


def signup_user(first_name: str, last_name: str, user_id_value: str, email: str, password: str) -> dict[str, Any]:
    normalized_user_id = _normalize_user_id(user_id_value)
    normalized_email = _normalize_email(email)
    password_hash = hash_password(password)

    if len(normalized_user_id) < 3:
        raise HTTPException(status_code=400, detail="User ID must be at least 3 characters")

    if get_supabase_client():
        supabase = get_supabase_client()
        assert supabase is not None
        try:
            supabase.table("users").insert({
                "first_name": first_name.strip(),
                "last_name": last_name.strip(),
                "user_id": normalized_user_id,
                "email": normalized_email,
                "password_hash": password_hash,
            }).execute()
        except Exception as exc:
            detail = str(exc).lower()
            if "duplicate" in detail or "unique" in detail:
                raise HTTPException(status_code=409, detail="User ID or email already exists") from exc
            raise HTTPException(status_code=500, detail=f"Database error: {str(exc)}") from exc
        user = get_user_profile_by_user_id(normalized_user_id)
        if not user:
            raise HTTPException(status_code=500, detail="Signup verification failed")
        return user

    try:
        with DatabaseManager() as connection:
            connection.execute(
                """
                INSERT INTO users (first_name, last_name, user_id, email, password_hash)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    first_name.strip(),
                    last_name.strip(),
                    normalized_user_id,
                    normalized_email,
                    password_hash,
                ),
            )
    except Exception as exc:
        detail = str(exc).upper()
        if "UNIQUE" in detail:
            raise HTTPException(status_code=409, detail="User ID or email already exists") from exc
        raise

    user = get_user_profile_by_user_id(normalized_user_id)
    if not user:
        raise HTTPException(status_code=500, detail="Signup verification failed")
    return user


def authenticate(user_id_value: str, password: str) -> dict[str, Any] | None:
    normalized_user_id = _normalize_user_id(user_id_value)

    if get_supabase_client():
        supabase = get_supabase_client()
        assert supabase is not None
        user_response = supabase.table("users").select("*").eq("user_id", normalized_user_id).limit(1).execute()
        if not user_response.data:
            return None
        user = user_response.data[0]
        if not verify_password(password, str(user["password_hash"])):
            return None
        return get_user_profile_by_id(int(user["id"]))

    with DatabaseManager() as connection:
        user = connection.execute(
            "SELECT * FROM users WHERE user_id = ? LIMIT 1",
            (normalized_user_id,),
        ).fetchone()
        if not user:
            return None
        if not verify_password(password, str(user["password_hash"])):
            return None
    return get_user_profile_by_id(int(user["id"]))


def create_join_request(user: dict[str, Any]) -> dict[str, str]:
    if user["membership_status"] == "active":
        raise HTTPException(status_code=400, detail="You are already a league member")
    if not user["league_exists"]:
        raise HTTPException(status_code=400, detail="No league exists yet to join")
    if user["membership_status"] == "pending":
        return {"message": "Join request already pending"}

    if get_supabase_client():
        supabase = get_supabase_client()
        assert supabase is not None
        supabase.table("league_join_requests").upsert({
            "user_id": int(user["id"]),
            "status": "pending",
        }, on_conflict="user_id").execute()
        return {"message": "Join request sent"}

    with DatabaseManager() as connection:
        existing = connection.execute(
            "SELECT id FROM league_join_requests WHERE user_id = ? LIMIT 1",
            (int(user["id"]),),
        ).fetchone()
        if existing:
            connection.execute(
                "UPDATE league_join_requests SET status = 'pending', reviewed_at = NULL WHERE user_id = ?",
                (int(user["id"]),),
            )
        else:
            connection.execute(
                "INSERT INTO league_join_requests (user_id, status) VALUES (?, 'pending')",
                (int(user["id"]),),
            )
    return {"message": "Join request sent"}


def list_join_requests(user: dict[str, Any]) -> dict[str, Any]:
    if user["league_role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")

    if get_supabase_client():
        supabase = get_supabase_client()
        assert supabase is not None
        requests_response = supabase.table("league_join_requests").select("id, user_id, status, created_at").eq("status", "pending").order("created_at").execute()
        users_response = supabase.table("users").select("id, first_name, last_name, user_id, email").execute()
        users_by_id = {int(row["id"]): row for row in users_response.data}
        rows = []
        for request in requests_response.data:
            req_user = users_by_id.get(int(request["user_id"]))
            if not req_user:
                continue
            rows.append({
                "request_id": int(request["id"]),
                "user_id": int(req_user["id"]),
                "first_name": str(req_user["first_name"]),
                "last_name": str(req_user["last_name"]),
                "user_id_label": str(req_user["user_id"]),
                "email": str(req_user["email"]),
                "created_at": request.get("created_at"),
            })
        return {"requests": rows}

    with DatabaseManager() as connection:
        rows = connection.execute(
            """
            SELECT
                r.id AS request_id,
                u.id AS user_id,
                u.first_name,
                u.last_name,
                u.user_id AS user_id_label,
                u.email,
                r.created_at
            FROM league_join_requests r
            JOIN users u ON u.id = r.user_id
            WHERE r.status = 'pending'
            ORDER BY r.created_at ASC
            """
        ).fetchall()
    return {"requests": [dict(row) for row in rows]}


def approve_join_request(request_id: int, user: dict[str, Any]) -> dict[str, str]:
    if user["league_role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")

    if get_supabase_client():
        supabase = get_supabase_client()
        assert supabase is not None
        request_response = supabase.table("league_join_requests").select("*").eq("id", int(request_id)).limit(1).execute()
        if not request_response.data:
            raise HTTPException(status_code=404, detail="Join request not found")
        request_row = request_response.data[0]
        supabase.table("league_memberships").upsert({
            "user_id": int(request_row["user_id"]),
            "role": "viewer",
            "status": "active",
        }, on_conflict="user_id").execute()
        supabase.table("league_join_requests").update({
            "status": "approved",
            "reviewed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }).eq("id", int(request_id)).execute()
        return {"message": "Join request approved"}

    with DatabaseManager() as connection:
        request_row = connection.execute(
            "SELECT * FROM league_join_requests WHERE id = ? LIMIT 1",
            (int(request_id),),
        ).fetchone()
        if not request_row:
            raise HTTPException(status_code=404, detail="Join request not found")
        connection.execute(
            """
            INSERT INTO league_memberships (user_id, role, status)
            VALUES (?, 'viewer', 'active')
            ON CONFLICT(user_id) DO UPDATE SET role = 'viewer', status = 'active'
            """,
            (int(request_row["user_id"]),),
        )
        connection.execute(
            "UPDATE league_join_requests SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP WHERE id = ?",
            (int(request_id),),
        )
    return {"message": "Join request approved"}


def current_user(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    if not _auth_enabled():
        return {
            "id": 0,
            "first_name": "Local",
            "last_name": "Admin",
            "full_name": "Local Admin",
            "user_id": "local-admin",
            "email": "local@example.com",
            "role": "viewer",
            "league_role": "admin",
            "membership_status": "active",
            "league_exists": True,
            "league": None,
        }

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")

    token = authorization.split(" ", 1)[1].strip()
    payload = decode_token(token)
    user_id_value = int(payload.get("uid", 0))
    if not user_id_value:
        raise HTTPException(status_code=401, detail="Invalid token payload")

    profile = get_user_profile_by_id(user_id_value)
    if not profile:
        raise HTTPException(status_code=401, detail="User not found")
    return profile


def require_admin(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if user["league_role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")
    return user


def require_active_member(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if user["membership_status"] != "active":
        raise HTTPException(status_code=403, detail="Active league membership required")
    return user
