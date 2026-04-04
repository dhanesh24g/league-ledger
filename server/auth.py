from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import os
import random
import secrets
from threading import Lock
import time
from typing import Any

import httpx
from fastapi import Depends, Header, HTTPException

from .database import DatabaseManager, get_supabase_client

ACCESS_TOKEN_TTL_SECONDS = int(os.getenv("APP_ACCESS_TOKEN_TTL_SECONDS", str(60 * 60)))

# Simple in-memory cache for user profiles (5-minute TTL)
_profile_cache: dict[str, dict[str, Any]] = {}
_profile_cache_timestamps: dict[str, float] = {}
_cache_lock = Lock()
PROFILE_CACHE_TTL_SECONDS = 300  # 5 minutes
REFRESH_TOKEN_TTL_SECONDS = int(os.getenv("APP_REFRESH_TOKEN_TTL_SECONDS", str(60 * 60 * 24 * 30)))
TOKEN_TTL_SECONDS = ACCESS_TOKEN_TTL_SECONDS
PBKDF2_ITERATIONS = 120_000
USER_ID_CACHE_TTL_SECONDS = 60
PASSWORD_RESET_TOKEN_TTL_SECONDS = 60 * 30
LEAGUE_MEMBERS_CACHE_TTL_SECONDS = 20
_USER_ID_CACHE: dict[str, Any] = {"loaded_at": 0.0, "values": set()}
_LEAGUE_MEMBERS_CACHE: dict[int, tuple[float, dict[str, Any]]] = {}
_LEAGUE_MEMBERS_CACHE_LOCK = Lock()


def _members_cache_get(league_id: int) -> dict[str, Any] | None:
    now = time.monotonic()
    key = int(league_id)
    with _LEAGUE_MEMBERS_CACHE_LOCK:
        row = _LEAGUE_MEMBERS_CACHE.get(key)
        if not row:
            return None
        expires_at, payload = row
        if now >= expires_at:
            _LEAGUE_MEMBERS_CACHE.pop(key, None)
            return None
        return payload


def _members_cache_set(league_id: int, payload: dict[str, Any]) -> None:
    key = int(league_id)
    expires_at = time.monotonic() + LEAGUE_MEMBERS_CACHE_TTL_SECONDS
    with _LEAGUE_MEMBERS_CACHE_LOCK:
        _LEAGUE_MEMBERS_CACHE[key] = (expires_at, payload)


def _invalidate_members_cache(league_id: int) -> None:
    with _LEAGUE_MEMBERS_CACHE_LOCK:
        _LEAGUE_MEMBERS_CACHE.pop(int(league_id), None)


def _secret() -> bytes:
    return os.getenv("APP_AUTH_SECRET", "league-ledger-secret").encode("utf-8")


def _auth_enabled() -> bool:
    return os.getenv("APP_AUTH_ENABLED", "true").lower() not in {"0", "false", "no", "off"}


def _normalize_user_id(value: str) -> str:
    return "".join(char for char in value.strip().lower() if char.isalnum() or char in {"_", "-", "."})


def _normalize_email(value: str) -> str:
    return value.strip().lower()


def _normalize_invite_code(value: str) -> str:
    return "".join(char for char in value.strip().lower() if char.isalnum() or char == "-")


def _member_player_name(member: dict[str, Any]) -> str:
    user_id_label = str(member.get("user_id_label") or "").strip()
    if user_id_label:
        return user_id_label
    first = str(member.get("first_name") or "").strip()
    last = str(member.get("last_name") or "").strip()
    full_name = f"{first} {last}".strip()
    if full_name:
        return full_name
    return f"member-{int(member.get('user_id') or 0)}"


def _ensure_member_player_entry(league_id: int, member: dict[str, Any], connection: Any | None = None) -> None:
    player_name = _member_player_name(member)
    if not player_name:
        return

    if get_supabase_client():
        supabase = get_supabase_client()
        assert supabase is not None
        existing = (
            supabase.table("players")
            .select("id")
            .eq("league_id", int(league_id))
            .eq("name", player_name)
            .limit(1)
            .execute()
        )
        if existing.data:
            return
        supabase.table("players").insert({"league_id": int(league_id), "name": player_name}).execute()
        return

    if connection is not None:
        existing = connection.execute(
            "SELECT id FROM players WHERE league_id = ? AND name = ? LIMIT 1",
            (int(league_id), player_name),
        ).fetchone()
        if existing:
            return
        connection.execute(
            "INSERT INTO players (league_id, name) VALUES (?, ?)",
            (int(league_id), player_name),
        )
        return

    with DatabaseManager() as db_connection:
        existing = db_connection.execute(
            "SELECT id FROM players WHERE league_id = ? AND name = ? LIMIT 1",
            (int(league_id), player_name),
        ).fetchone()
        if existing:
            return
        db_connection.execute(
            "INSERT INTO players (league_id, name) VALUES (?, ?)",
            (int(league_id), player_name),
        )


def _google_client_id() -> str:
    for env_name in (
        "GOOGLE_CLIENT_ID",
        "GOOGLE_OAUTH_CLIENT_ID",
        "NEXT_PUBLIC_GOOGLE_CLIENT_ID",
        "GOOGLE_WEB_CLIENT_ID",
    ):
        value = os.getenv(env_name, "").strip()
        if value:
            return value
    return ""


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


def _reserved_usernames() -> set[str]:
    return {
        "admin",
        "root",
        "support",
        "help",
        "owner",
        "league",
        "system",
        "me",
        "api",
        "login",
        "signup",
        "welcome",
    }


def _load_existing_user_ids(force_refresh: bool = False) -> set[str]:
    now = time.time()
    cached_values = _USER_ID_CACHE.get("values")
    loaded_at = float(_USER_ID_CACHE.get("loaded_at") or 0.0)
    if not force_refresh and isinstance(cached_values, set) and (now - loaded_at) < USER_ID_CACHE_TTL_SECONDS:
        return set(cached_values)

    user_ids: set[str] = set()
    if get_supabase_client():
        supabase = get_supabase_client()
        assert supabase is not None
        response = supabase.table("users").select("user_id").execute()
        user_ids = {str(row.get("user_id") or "") for row in (response.data or []) if row.get("user_id")}
    else:
        with DatabaseManager() as connection:
            rows = connection.execute("SELECT user_id FROM users").fetchall()
        user_ids = {str(row["user_id"]) for row in rows if row["user_id"]}

    _USER_ID_CACHE["values"] = set(user_ids)
    _USER_ID_CACHE["loaded_at"] = now
    return user_ids


def _invalidate_user_id_cache() -> None:
    _USER_ID_CACHE["loaded_at"] = 0.0
    _USER_ID_CACHE["values"] = set()


def _is_user_id_taken(normalized_user_id: str) -> bool:
    return normalized_user_id in _load_existing_user_ids()


def user_id_availability(user_id_value: str) -> dict[str, Any]:
    normalized_user_id = _normalize_user_id(user_id_value)
    if len(normalized_user_id) < 3:
        return {"available": False, "normalized": normalized_user_id, "reason": "User ID must be at least 3 characters"}
    if normalized_user_id in _reserved_usernames():
        return {"available": False, "normalized": normalized_user_id, "reason": "That username is reserved"}
    return {"available": not _is_user_id_taken(normalized_user_id), "normalized": normalized_user_id}


def suggest_user_ids(first_name: str, last_name: str) -> dict[str, Any]:
    first = _normalize_user_id(first_name)[:24]
    last = _normalize_user_id(last_name)[:24]
    if not first:
        return {"suggestions": []}

    existing_user_ids = _load_existing_user_ids()
    reserved = _reserved_usernames()
    base_seeds = [
        f"{first}{last}" if last else first,
        f"{first}.{last}" if last else f"{first}.league",
        f"{first}_{last}" if last else f"{first}_play",
        f"{first}{last[:1]}" if last else f"{first}x",
        f"{first}-{last}" if last else f"{first}-fan",
    ]

    suggestions: list[str] = []
    seen: set[str] = set()
    rng = random.SystemRandom()

    for seed in base_seeds:
        candidate_base = _normalize_user_id(seed)[:28]
        if len(candidate_base) < 3 or candidate_base in reserved:
            continue

        attempts = 0
        while attempts < 24 and len(suggestions) < 4:
            digit_count = 3 if rng.random() < 0.5 else 4
            suffix = "".join(rng.choice("0123456789") for _ in range(digit_count))
            candidate = _normalize_user_id(f"{candidate_base}{suffix}")[:32]
            attempts += 1
            if len(candidate) < 6 or candidate in seen or candidate in reserved or candidate in existing_user_ids:
                continue
            seen.add(candidate)
            suggestions.append(candidate)
            existing_user_ids.add(candidate)

        if len(suggestions) >= 4:
            break

    return {"suggestions": suggestions[:4]}


def _random_password_seed() -> str:
    return secrets.token_urlsafe(24)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _utc_iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def _hash_reset_token(token: str) -> str:
    return hmac.new(_secret(), token.encode("utf-8"), hashlib.sha256).hexdigest()


def _find_user_for_password_reset(identifier: str) -> dict[str, Any] | None:
    normalized_identifier = str(identifier or "").strip()
    if not normalized_identifier:
        return None

    normalized_email = _normalize_email(normalized_identifier)
    normalized_user_id = _normalize_user_id(normalized_identifier)

    if get_supabase_client():
        supabase = get_supabase_client()
        assert supabase is not None
        response = (
            supabase.table("users")
            .select("id, user_id, email")
            .or_(f"email.eq.{normalized_email},user_id.eq.{normalized_user_id}")
            .limit(1)
            .execute()
        )
        if not response.data:
            return None
        return response.data[0]

    with DatabaseManager() as connection:
        row = connection.execute(
            "SELECT id, user_id, email FROM users WHERE email = ? OR user_id = ? LIMIT 1",
            (normalized_email, normalized_user_id),
        ).fetchone()
    return dict(row) if row else None


def request_password_reset(identifier: str) -> dict[str, Any]:
    generic_message = "If an account exists for that email/username, reset instructions have been generated."
    user = _find_user_for_password_reset(identifier)
    if not user:
        return {"message": generic_message}

    token = secrets.token_urlsafe(32)
    token_hash = _hash_reset_token(token)
    expires_at = _utc_iso(_utc_now() + timedelta(seconds=PASSWORD_RESET_TOKEN_TTL_SECONDS))

    if get_supabase_client():
        supabase = get_supabase_client()
        assert supabase is not None
        supabase.table("password_reset_tokens").insert(
            {
                "user_id": int(user["id"]),
                "token_hash": token_hash,
                "expires_at": expires_at,
            }
        ).execute()
    else:
        with DatabaseManager() as connection:
            connection.execute(
                """
                INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
                VALUES (?, ?, ?)
                """,
                (int(user["id"]), token_hash, expires_at),
            )

    reset_link = f"/reset-password?token={token}"
    include_link = os.getenv("APP_ENV", "development").lower() != "production"
    return {
        "message": generic_message,
        **({"reset_link": reset_link} if include_link else {}),
    }


def reset_password(token: str, new_password: str) -> dict[str, str]:
    raw_token = str(token or "").strip()
    if not raw_token:
        raise HTTPException(status_code=400, detail="Reset token is required")
    if len(str(new_password or "")) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")

    token_hash = _hash_reset_token(raw_token)
    now_utc = _utc_now()

    if get_supabase_client():
        supabase = get_supabase_client()
        assert supabase is not None
        token_rows = (
            supabase.table("password_reset_tokens")
            .select("id, user_id, expires_at, used_at")
            .eq("token_hash", token_hash)
            .order("id", desc=True)
            .limit(1)
            .execute()
            .data
            or []
        )
        if not token_rows:
            raise HTTPException(status_code=400, detail="Invalid or expired reset token")

        token_row = token_rows[0]
        if token_row.get("used_at"):
            raise HTTPException(status_code=400, detail="Reset token has already been used")
        expires_raw = str(token_row.get("expires_at") or "")
        try:
            expires_at = datetime.fromisoformat(expires_raw.replace("Z", "+00:00"))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid or expired reset token") from exc
        if expires_at < now_utc:
            raise HTTPException(status_code=400, detail="Invalid or expired reset token")

        supabase.table("users").update({"password_hash": hash_password(new_password)}).eq("id", int(token_row["user_id"])).execute()
        supabase.table("password_reset_tokens").update({"used_at": _utc_iso(now_utc)}).eq("id", int(token_row["id"])).execute()
        return {"message": "Password reset successful"}

    with DatabaseManager() as connection:
        token_row = connection.execute(
            """
            SELECT id, user_id, expires_at, used_at
            FROM password_reset_tokens
            WHERE token_hash = ?
            ORDER BY id DESC
            LIMIT 1
            """,
            (token_hash,),
        ).fetchone()
        if not token_row:
            raise HTTPException(status_code=400, detail="Invalid or expired reset token")
        if token_row["used_at"]:
            raise HTTPException(status_code=400, detail="Reset token has already been used")
        try:
            expires_at = datetime.fromisoformat(str(token_row["expires_at"]).replace("Z", "+00:00"))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid or expired reset token") from exc
        if expires_at < now_utc:
            raise HTTPException(status_code=400, detail="Invalid or expired reset token")

        connection.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (hash_password(new_password), int(token_row["user_id"])),
        )
        connection.execute(
            "UPDATE password_reset_tokens SET used_at = ? WHERE id = ?",
            (_utc_iso(now_utc), int(token_row["id"])),
        )
    return {"message": "Password reset successful"}


def verify_google_token(credential: str) -> dict[str, Any]:
    client_id = _google_client_id()
    if not client_id:
        raise HTTPException(status_code=503, detail="Google sign-in is not configured")

    try:
        response = httpx.get(
            "https://oauth2.googleapis.com/tokeninfo",
            params={"id_token": credential},
            timeout=10.0,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Failed to verify Google identity") from exc

    if response.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid Google credential")

    payload = response.json()
    if payload.get("aud") != client_id:
        raise HTTPException(status_code=401, detail="Google credential audience mismatch")
    if payload.get("email_verified") not in {"true", True}:
        raise HTTPException(status_code=401, detail="Google account email is not verified")

    return {
        "google_sub": str(payload.get("sub") or ""),
        "email": _normalize_email(str(payload.get("email") or "")),
        "first_name": str(payload.get("given_name") or "").strip(),
        "last_name": str(payload.get("family_name") or "").strip(),
        "full_name": str(payload.get("name") or "").strip(),
    }


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
        "exp": int(time.time()) + ACCESS_TOKEN_TTL_SECONDS,
        "typ": "access",
    }
    payload_part = _encode(payload)
    sig = hmac.new(_secret(), payload_part.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{payload_part}.{sig}"


def create_refresh_token(user: dict[str, Any]) -> str:
    payload = {
        "uid": int(user["id"]),
        "sub": user["user_id"],
        "iat": int(time.time()),
        "exp": int(time.time()) + REFRESH_TOKEN_TTL_SECONDS,
        "typ": "refresh",
        "jti": secrets.token_hex(12),
    }
    payload_part = _encode(payload)
    sig = hmac.new(_secret(), payload_part.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{payload_part}.{sig}"


def decode_token(token: str, expected_type: str | None = None) -> dict[str, Any]:
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

    token_type = str(payload.get("typ") or "access")
    if expected_type and token_type != expected_type:
        raise HTTPException(status_code=401, detail="Invalid token type")

    return payload


def refresh_session(refresh_token: str, requested_league_id: int | None = None) -> dict[str, Any]:
    payload = decode_token(refresh_token, expected_type="refresh")
    user_id_value = int(payload.get("uid", 0))
    if not user_id_value:
        raise HTTPException(status_code=401, detail="Invalid token payload")

    profile = get_user_profile_by_id(user_id_value, requested_league_id=requested_league_id)
    if not profile:
        raise HTTPException(status_code=401, detail="User not found")

    return {
        "token": create_token(profile),
        "refresh_token": create_refresh_token(profile),
        "user": profile,
    }


def _shape_league_summary(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "sport": str(row.get("sport") or "Cricket"),
        "name": str(row["name"]),
        "tournament": str(row["tournament"]),
        "invite_code": str(row["invite_code"]),
        "owner_user_id": int(row["owner_user_id"]) if row.get("owner_user_id") is not None else None,
    }


def _normalize_membership_role(value: str | None) -> str:
    raw = str(value or "read").strip().lower()
    if raw == "viewer":
        raw = "read"
    if raw not in {"admin", "read"}:
        raise HTTPException(status_code=400, detail="Role must be admin or read")
    return raw


def _build_profile(
    user_row: dict[str, Any],
    leagues: list[dict[str, Any]],
    memberships: list[dict[str, Any]],
    requests: list[dict[str, Any]],
    requested_league_id: int | None = None,
    league_exists_override: bool | None = None,
) -> dict[str, Any]:
    leagues_by_id = {int(row["id"]): row for row in leagues}
    active_memberships = [row for row in memberships if str(row.get("status", "")).lower() == "active"]
    pending_requests = [row for row in requests if str(row.get("status", "")).lower() == "pending"]

    current_membership = None
    if requested_league_id is not None:
        current_membership = next(
            (row for row in active_memberships if int(row["league_id"]) == int(requested_league_id)),
            None,
        )
    if requested_league_id is None and current_membership is None and active_memberships:
        current_membership = active_memberships[0]

    current_pending = None
    if requested_league_id is not None:
        current_pending = next(
            (row for row in pending_requests if int(row["league_id"]) == int(requested_league_id)),
            None,
        )

    current_league = None
    league_role = "none"
    membership_status = "none"
    if current_membership:
        current_league = leagues_by_id.get(int(current_membership["league_id"]))
        league_role = _normalize_membership_role(current_membership.get("role", "read"))
        membership_status = "active"
    elif current_pending:
        current_league = leagues_by_id.get(int(current_pending["league_id"]))
        membership_status = "pending"

    memberships_payload = []
    for row in active_memberships:
        league = leagues_by_id.get(int(row["league_id"]))
        if not league:
            continue
        memberships_payload.append(
            {
                "league_id": int(row["league_id"]),
                "role": _normalize_membership_role(row.get("role", "read")),
                "status": str(row.get("status", "active")).lower(),
                "league": _shape_league_summary(league),
            }
        )

    pending_payload = []
    request_history_payload = []
    for row in pending_requests:
        league = leagues_by_id.get(int(row["league_id"]))
        if not league:
            continue
        pending_payload.append(
            {
                "request_id": int(row["id"]),
                "league_id": int(row["league_id"]),
                "status": str(row.get("status", "pending")).lower(),
                "league": _shape_league_summary(league),
            }
        )

    for row in requests:
        league = leagues_by_id.get(int(row["league_id"]))
        if not league:
            continue
        request_history_payload.append(
            {
                "request_id": int(row["id"]),
                "league_id": int(row["league_id"]),
                "status": str(row.get("status", "pending")).lower(),
                "created_at": row.get("created_at"),
                "reviewed_at": row.get("reviewed_at"),
                "league": _shape_league_summary(league),
            }
        )

    return {
        "id": int(user_row["id"]),
        "first_name": str(user_row["first_name"]),
        "last_name": str(user_row["last_name"]),
        "full_name": f'{str(user_row["first_name"])} {str(user_row["last_name"])}'.strip(),
        "user_id": str(user_row["user_id"]),
        "email": str(user_row["email"]),
        "role": "read",
        "league_role": league_role,
        "membership_status": membership_status,
        "league_exists": bool(leagues) if league_exists_override is None else bool(league_exists_override),
        "active_league_id": int(current_league["id"]) if current_league else None,
        "league": _shape_league_summary(current_league) if current_league else None,
        "memberships": memberships_payload,
        "pending_requests": pending_payload,
        "request_history": request_history_payload,
        "available_leagues": [],
    }


def _sqlite_profile_query(user_id_value: int | None = None, user_id_label: str | None = None, requested_league_id: int | None = None) -> dict[str, Any] | None:
    with DatabaseManager() as connection:
        if user_id_value is not None:
            user = connection.execute("SELECT * FROM users WHERE id = ? LIMIT 1", (int(user_id_value),)).fetchone()
        else:
            user = connection.execute(
                "SELECT * FROM users WHERE user_id = ? LIMIT 1",
                (_normalize_user_id(str(user_id_label or "")),),
            ).fetchone()
        if not user:
            return None

        leagues = connection.execute("SELECT * FROM league ORDER BY created_at ASC, id ASC").fetchall()
        memberships = connection.execute(
            "SELECT * FROM league_memberships WHERE user_id = ? ORDER BY created_at ASC, id ASC",
            (int(user["id"]),),
        ).fetchall()
        requests = connection.execute(
            "SELECT * FROM league_join_requests WHERE user_id = ? ORDER BY created_at ASC, id ASC",
            (int(user["id"]),),
        ).fetchall()

    return _build_profile(
        dict(user),
        [dict(row) for row in leagues],
        [dict(row) for row in memberships],
        [dict(row) for row in requests],
        requested_league_id=requested_league_id,
    )


def _supabase_profile_query(user_id_value: int | None = None, user_id_label: str | None = None, requested_league_id: int | None = None) -> dict[str, Any] | None:
    supabase = get_supabase_client()
    if not supabase:
        return None

    try:
        if user_id_value is not None:
            response = supabase.table("users").select("*").eq("id", int(user_id_value)).limit(1).execute()
        else:
            response = supabase.table("users").select("*").eq("user_id", _normalize_user_id(str(user_id_label or ""))).limit(1).execute()

        if not response.data:
            return None

        user = response.data[0]
        
        # Add error handling for memberships query
        try:
            memberships = (
                supabase.table("league_memberships")
                .select("id, user_id, league_id, role, status, created_at")
                .eq("user_id", int(user["id"]))
                .order("created_at")
                .order("id")
                .execute()
                .data
                or []
            )
        except Exception as e:
            # Log error but continue with empty memberships
            print(f"Error fetching memberships: {e}")
            memberships = []
        
        # Add error handling for requests query
        try:
            requests = (
                supabase.table("league_join_requests")
                .select("id, user_id, league_id, status, created_at, reviewed_at")
                .eq("user_id", int(user["id"]))
                .order("created_at")
                .order("id")
                .execute()
                .data
                or []
            )
        except Exception as e:
            # Log error but continue with empty requests
            print(f"Error fetching join requests: {e}")
            requests = []

        league_ids = {
            int(row["league_id"])
            for row in [*memberships, *requests]
            if row.get("league_id") is not None
        }
        if requested_league_id is not None:
            league_ids.add(int(requested_league_id))

        leagues: list[dict[str, Any]] = []
        if league_ids:
            try:
                leagues = (
                    supabase.table("league")
                    .select("*")
                    .in_("id", sorted(league_ids))
                    .order("created_at")
                    .order("id")
                    .execute()
                    .data
                    or []
                )
            except Exception as e:
                # Log error but continue with empty leagues
                print(f"Error fetching leagues: {e}")
                leagues = []

        league_exists = bool(leagues)
        if not league_exists:
            try:
                any_league_row = supabase.table("league").select("id").limit(1).execute().data or []
                league_exists = bool(any_league_row)
            except Exception as e:
                # Log error but default to False
                print(f"Error checking league existence: {e}")
                league_exists = False

        return _build_profile(
            user,
            leagues,
            memberships,
            requests,
            requested_league_id=requested_league_id,
            league_exists_override=league_exists,
        )
    except Exception as e:
        # Log detailed error information for debugging Supabase issues
        import traceback
        
        error_details = {
            "error_type": type(e).__name__,
            "error_message": str(e),
            "user_id_value": user_id_value,
            "user_id_label": user_id_label,
            "requested_league_id": requested_league_id,
            "traceback": traceback.format_exc()
        }
        
        # Check if it's a PostgREST API error
        if hasattr(e, '__dict__'):
            error_details.update(e.__dict__)
        
        print(f"Supabase Query Error Details: {error_details}")
        return None


def get_user_profile_by_user_id(user_id_value: str, requested_league_id: int | None = None) -> dict[str, Any] | None:
    cache_key = f"uid_{user_id_value}_league_{requested_league_id or 'none'}"
    current_time = time.time()
    
    with _cache_lock:
        # Check if we have a cached result that's still valid
        if cache_key in _profile_cache and cache_key in _profile_cache_timestamps:
            if current_time - _profile_cache_timestamps[cache_key] < PROFILE_CACHE_TTL_SECONDS:
                return _profile_cache[cache_key]
    
    # Cache miss or expired, fetch from database
    profile = None
    if get_supabase_client():
        profile = _supabase_profile_query(user_id_label=user_id_value, requested_league_id=requested_league_id)
    else:
        profile = _sqlite_profile_query(user_id_label=user_id_value, requested_league_id=requested_league_id)
    
    # Cache the result
    if profile:
        with _cache_lock:
            _profile_cache[cache_key] = profile
            _profile_cache_timestamps[cache_key] = current_time
    
    return profile


def get_user_profile_by_id(user_id_value: int, requested_league_id: int | None = None) -> dict[str, Any] | None:
    cache_key = f"id_{user_id_value}_league_{requested_league_id or 'none'}"
    current_time = time.time()
    
    with _cache_lock:
        # Check if we have a cached result that's still valid
        if cache_key in _profile_cache and cache_key in _profile_cache_timestamps:
            if current_time - _profile_cache_timestamps[cache_key] < PROFILE_CACHE_TTL_SECONDS:
                return _profile_cache[cache_key]
    
    # Cache miss or expired, fetch from database
    profile = None
    if get_supabase_client():
        profile = _supabase_profile_query(user_id_value=user_id_value, requested_league_id=requested_league_id)
    else:
        profile = _sqlite_profile_query(user_id_value=user_id_value, requested_league_id=requested_league_id)
    
    # Cache the result
    if profile:
        with _cache_lock:
            _profile_cache[cache_key] = profile
            _profile_cache_timestamps[cache_key] = current_time
    
    return profile


def auth_config() -> dict[str, Any]:
    return {
        "enabled": _auth_enabled(),
        "signup_enabled": True,
        "google_enabled": bool(_google_client_id()),
        "google_client_id": _google_client_id() or None,
        "session_ttl_hours": TOKEN_TTL_SECONDS // 3600,
    }


def signup_user(
    first_name: str,
    last_name: str,
    user_id_value: str,
    email: str,
    password: str | None,
    google_token: str | None = None,
) -> dict[str, Any]:
    normalized_user_id = _normalize_user_id(user_id_value)
    availability = user_id_availability(normalized_user_id)
    if not availability["available"]:
        raise HTTPException(status_code=409, detail=availability.get("reason") or "User ID already exists")

    google_profile = verify_google_token(google_token) if google_token else None
    normalized_email = google_profile["email"] if google_profile else _normalize_email(email)
    password_hash = hash_password(password or _random_password_seed())
    effective_first_name = google_profile["first_name"] if google_profile and google_profile["first_name"] else first_name.strip()
    effective_last_name = google_profile["last_name"] if google_profile and google_profile["last_name"] else last_name.strip()

    if len(normalized_user_id) < 3:
        raise HTTPException(status_code=400, detail="User ID must be at least 3 characters")
    if not google_profile and not password:
        raise HTTPException(status_code=400, detail="Password is required unless you continue with Google")

    if get_supabase_client():
        supabase = get_supabase_client()
        assert supabase is not None
        try:
            supabase.table("users").insert(
                {
                    "first_name": effective_first_name,
                    "last_name": effective_last_name,
                    "user_id": normalized_user_id,
                    "email": normalized_email,
                    "google_sub": google_profile["google_sub"] if google_profile else None,
                    "password_hash": password_hash,
                }
            ).execute()
        except Exception as exc:
            detail = str(exc).lower()
            if "duplicate" in detail or "unique" in detail:
                raise HTTPException(status_code=409, detail="User ID or email already exists") from exc
            raise HTTPException(status_code=500, detail=f"Database error: {str(exc)}") from exc
        _invalidate_user_id_cache()
        user = get_user_profile_by_user_id(normalized_user_id)
        if not user:
            raise HTTPException(status_code=500, detail="Signup verification failed")
        return user

    try:
        with DatabaseManager() as connection:
            connection.execute(
                """
                INSERT INTO users (first_name, last_name, user_id, email, google_sub, password_hash)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    effective_first_name,
                    effective_last_name,
                    normalized_user_id,
                    normalized_email,
                    google_profile["google_sub"] if google_profile else None,
                    password_hash,
                ),
            )
    except Exception as exc:
        detail = str(exc).upper()
        if "UNIQUE" in detail:
            raise HTTPException(status_code=409, detail="User ID or email already exists") from exc
        raise

    _invalidate_user_id_cache()
    user = get_user_profile_by_user_id(normalized_user_id)
    if not user:
        raise HTTPException(status_code=500, detail="Signup verification failed")
    return user


def authenticate(user_id_value: str, password: str, requested_league_id: int | None = None) -> dict[str, Any] | None:
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
        return get_user_profile_by_id(int(user["id"]), requested_league_id=requested_league_id)

    with DatabaseManager() as connection:
        user = connection.execute(
            "SELECT * FROM users WHERE user_id = ? LIMIT 1",
            (normalized_user_id,),
        ).fetchone()
        if not user:
            return None
        if not verify_password(password, str(user["password_hash"])):
            return None
    return get_user_profile_by_id(int(user["id"]), requested_league_id=requested_league_id)


def authenticate_google(credential: str, requested_league_id: int | None = None) -> dict[str, Any]:
    google_profile = verify_google_token(credential)
    if get_supabase_client():
        supabase = get_supabase_client()
        assert supabase is not None
        response = (
            supabase.table("users")
            .select("*")
            .or_(f"google_sub.eq.{google_profile['google_sub']},email.eq.{google_profile['email']}")
            .limit(1)
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=404, detail="No account found for this Google identity. Finish signup first.")
        user = response.data[0]
        if not user.get("google_sub"):
            supabase.table("users").update({"google_sub": google_profile["google_sub"]}).eq("id", int(user["id"])).execute()
        return get_user_profile_by_id(int(user["id"]), requested_league_id=requested_league_id) or {}

    with DatabaseManager() as connection:
        user = connection.execute(
            "SELECT * FROM users WHERE google_sub = ? OR email = ? LIMIT 1",
            (google_profile["google_sub"], google_profile["email"]),
        ).fetchone()
        if not user:
            raise HTTPException(status_code=404, detail="No account found for this Google identity. Finish signup first.")
        if not user["google_sub"]:
            connection.execute("UPDATE users SET google_sub = ? WHERE id = ?", (google_profile["google_sub"], int(user["id"])))
    profile = get_user_profile_by_id(int(user["id"]), requested_league_id=requested_league_id)
    if not profile:
        raise HTTPException(status_code=401, detail="User not found")
    return profile


def get_league_by_invite_code(invite_code: str) -> dict[str, Any]:
    normalized_code = _normalize_invite_code(invite_code)
    if not normalized_code:
        raise HTTPException(status_code=404, detail="League invite not found")

    if get_supabase_client():
        supabase = get_supabase_client()
        assert supabase is not None
        response = supabase.table("league").select("*").eq("invite_code", normalized_code).limit(1).execute()
        if not response.data:
            raise HTTPException(status_code=404, detail="League invite not found")
        return _shape_league_summary(response.data[0])

    with DatabaseManager() as connection:
        row = connection.execute("SELECT * FROM league WHERE invite_code = ? LIMIT 1", (normalized_code,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="League invite not found")
    return _shape_league_summary(dict(row))


def create_join_request(user: dict[str, Any], league_id: int | None = None, invite_code: str | None = None) -> dict[str, str]:
    if invite_code:
        league = get_league_by_invite_code(invite_code)
        target_league_id = int(league["id"])
    elif league_id is not None:
        target_league_id = int(league_id)
    else:
        raise HTTPException(status_code=400, detail="League selection is required")

    if any(int(item["league_id"]) == target_league_id for item in user.get("memberships", [])):
        raise HTTPException(status_code=400, detail="You are already a member of this league")
    if any(int(item["league_id"]) == target_league_id for item in user.get("pending_requests", [])):
        return {"message": "Join request already pending"}

    if get_supabase_client():
        supabase = get_supabase_client()
        assert supabase is not None
        supabase.table("league_join_requests").upsert(
            {
                "user_id": int(user["id"]),
                "league_id": target_league_id,
                "status": "pending",
            },
            on_conflict="user_id,league_id",
        ).execute()
        return {"message": "Join request sent"}

    with DatabaseManager() as connection:
        existing = connection.execute(
            "SELECT id FROM league_join_requests WHERE user_id = ? AND league_id = ? LIMIT 1",
            (int(user["id"]), target_league_id),
        ).fetchone()
        if existing:
            connection.execute(
                """
                UPDATE league_join_requests
                SET status = 'pending', reviewed_at = NULL
                WHERE user_id = ? AND league_id = ?
                """,
                (int(user["id"]), target_league_id),
            )
        else:
            connection.execute(
                "INSERT INTO league_join_requests (user_id, league_id, status) VALUES (?, ?, 'pending')",
                (int(user["id"]), target_league_id),
            )
    return {"message": "Join request sent"}


def list_join_requests(user: dict[str, Any]) -> dict[str, Any]:
    if user["league_role"] != "admin" or not user.get("active_league_id"):
        raise HTTPException(status_code=403, detail="Admin role required")

    league_id = int(user["active_league_id"])
    if get_supabase_client():
        supabase = get_supabase_client()
        assert supabase is not None
        requests_response = (
            supabase.table("league_join_requests")
            .select("id, user_id, league_id, status, created_at")
            .eq("league_id", league_id)
            .eq("status", "pending")
            .order("created_at")
            .execute()
        )
        
        # CRITICAL FIX: Only fetch users who have requests for this specific league
        request_user_ids = [int(request["user_id"]) for request in requests_response.data]
        if not request_user_ids:
            return {"requests": []}
            
        users_response = (
            supabase.table("users")
            .select("id, first_name, last_name, user_id, email")
            .in_("id", request_user_ids)
            .execute()
        )
        users_by_id = {int(row["id"]): row for row in users_response.data}
        
        rows = []
        for request in requests_response.data:
            req_user = users_by_id.get(int(request["user_id"]))
            if not req_user:
                continue
            rows.append(
                {
                    "request_id": int(request["id"]),
                    "league_id": int(request["league_id"]),
                    "user_id": int(req_user["id"]),
                    "first_name": str(req_user["first_name"]),
                    "last_name": str(req_user["last_name"]),
                    "user_id_label": str(req_user["user_id"]),
                    "email": str(req_user["email"]),
                    "created_at": request.get("created_at"),
                }
            )
        return {"requests": rows}

    with DatabaseManager() as connection:
        rows = connection.execute(
            """
            SELECT
                r.id AS request_id,
                r.league_id,
                u.id AS user_id,
                u.first_name,
                u.last_name,
                u.user_id AS user_id_label,
                u.email,
                r.created_at
            FROM league_join_requests r
            JOIN users u ON u.id = r.user_id
            WHERE r.league_id = ? AND r.status = 'pending'
            ORDER BY r.created_at ASC
            """,
            (league_id,),
        ).fetchall()
    return {"requests": [dict(row) for row in rows]}


def approve_join_request(request_id: int, user: dict[str, Any], role: str = "read") -> dict[str, str]:
    if user["league_role"] != "admin" or not user.get("active_league_id"):
        raise HTTPException(status_code=403, detail="Admin role required")

    league_id = int(user["active_league_id"])
    normalized_role = _normalize_membership_role(role)
    if get_supabase_client():
        supabase = get_supabase_client()
        assert supabase is not None
        request_response = (
            supabase.table("league_join_requests")
            .select("*")
            .eq("id", int(request_id))
            .eq("league_id", league_id)
            .limit(1)
            .execute()
        )
        if not request_response.data:
            raise HTTPException(status_code=404, detail="Join request not found")
        request_row = request_response.data[0]
        supabase.table("league_memberships").upsert(
            {
                "user_id": int(request_row["user_id"]),
                "league_id": league_id,
                "role": normalized_role,
                "status": "active",
            },
            on_conflict="user_id,league_id",
        ).execute()
        supabase.table("league_join_requests").update(
            {
                "status": "approved",
                "reviewed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
        ).eq("id", int(request_id)).execute()

        joined_user = (
            supabase.table("users")
            .select("id, first_name, last_name, user_id")
            .eq("id", int(request_row["user_id"]))
            .limit(1)
            .execute()
        )
        if joined_user.data:
            user_row = joined_user.data[0]
            _ensure_member_player_entry(
                league_id,
                {
                    "user_id": int(user_row["id"]),
                    "first_name": str(user_row.get("first_name") or ""),
                    "last_name": str(user_row.get("last_name") or ""),
                    "user_id_label": str(user_row.get("user_id") or ""),
                },
            )
        _invalidate_members_cache(league_id)
        return {"message": "Join request approved"}

    with DatabaseManager() as connection:
        request_row = connection.execute(
            "SELECT * FROM league_join_requests WHERE id = ? AND league_id = ? LIMIT 1",
            (int(request_id), league_id),
        ).fetchone()
        if not request_row:
            raise HTTPException(status_code=404, detail="Join request not found")
        connection.execute(
            """
            INSERT INTO league_memberships (user_id, league_id, role, status)
            VALUES (?, ?, ?, 'active')
            ON CONFLICT(user_id, league_id) DO UPDATE SET role = excluded.role, status = 'active'
            """,
            (int(request_row["user_id"]), league_id, normalized_role),
        )
        connection.execute(
            "UPDATE league_join_requests SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP WHERE id = ?",
            (int(request_id),),
        )

        joined_user = connection.execute(
            "SELECT id, first_name, last_name, user_id FROM users WHERE id = ? LIMIT 1",
            (int(request_row["user_id"]),),
        ).fetchone()
        if joined_user:
            _ensure_member_player_entry(
                league_id,
                {
                    "user_id": int(joined_user["id"]),
                    "first_name": str(joined_user["first_name"]),
                    "last_name": str(joined_user["last_name"]),
                    "user_id_label": str(joined_user["user_id"]),
                },
                connection=connection,
            )
    _invalidate_members_cache(league_id)
    return {"message": "Join request approved"}


def reject_join_request(request_id: int, user: dict[str, Any]) -> dict[str, str]:
    if user["league_role"] != "admin" or not user.get("active_league_id"):
        raise HTTPException(status_code=403, detail="Admin role required")

    league_id = int(user["active_league_id"])
    if get_supabase_client():
        supabase = get_supabase_client()
        assert supabase is not None
        request_response = (
            supabase.table("league_join_requests")
            .select("id")
            .eq("id", int(request_id))
            .eq("league_id", league_id)
            .eq("status", "pending")
            .limit(1)
            .execute()
        )
        if not request_response.data:
            raise HTTPException(status_code=404, detail="Join request not found")

        supabase.table("league_join_requests").update(
            {
                "status": "rejected",
                "reviewed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
        ).eq("id", int(request_id)).execute()
        return {"message": "Join request rejected"}

    with DatabaseManager() as connection:
        cursor = connection.execute(
            """
            UPDATE league_join_requests
            SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP
            WHERE id = ? AND league_id = ? AND status = 'pending'
            """,
            (int(request_id), league_id),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Join request not found")
    return {"message": "Join request rejected"}


def list_league_members(user: dict[str, Any]) -> dict[str, Any]:
    if user["membership_status"] != "active" or not user.get("active_league_id"):
        raise HTTPException(status_code=403, detail="Active league membership required")

    league_id = int(user["active_league_id"])
    
    # Clear any existing cache to ensure data integrity
    _invalidate_members_cache(league_id)
    
    cached = _members_cache_get(league_id)
    if cached is not None:
        return cached

    if get_supabase_client():
        supabase = get_supabase_client()
        assert supabase is not None
        # CRITICAL FIX: Only fetch users who are members of this specific league
        memberships = (
            supabase.table("league_memberships")
            .select("user_id, role, status")
            .eq("league_id", league_id)
            .eq("status", "active")
            .order("created_at")
            .execute()
            .data
            or []
        )
        
        # Only fetch user details for members of this league, not ALL users
        member_user_ids = [int(membership["user_id"]) for membership in memberships]
        if not member_user_ids:
            return {"members": []}
            
        users_response = (
            supabase.table("users")
            .select("id, first_name, last_name, user_id, email")
            .in_("id", member_user_ids)
            .execute()
        )
        users_by_id = {int(row["id"]): row for row in users_response.data}
        
        rows = []
        for membership in memberships:
            member = users_by_id.get(int(membership["user_id"]))
            if not member:
                continue
            rows.append(
                {
                    "user_id": int(member["id"]),
                    "user_id_label": str(member["user_id"]),
                    "first_name": str(member["first_name"]),
                    "last_name": str(member["last_name"]),
                    "email": str(member["email"]),
                    "role": _normalize_membership_role(membership.get("role", "read")),
                }
            )
        response = {"members": rows}
        _members_cache_set(league_id, response)
        return response

    with DatabaseManager() as connection:
        rows = connection.execute(
            """
            SELECT
                u.id AS user_id,
                u.user_id AS user_id_label,
                u.first_name,
                u.last_name,
                u.email,
                m.role
            FROM league_memberships m
            JOIN users u ON u.id = m.user_id
            WHERE m.league_id = ? AND m.status = 'active'
            ORDER BY u.first_name ASC, u.last_name ASC, u.user_id ASC
            """,
            (league_id,),
        ).fetchall()
    response = {"members": [{**dict(row), "role": _normalize_membership_role(dict(row)["role"])} for row in rows]}
    _members_cache_set(league_id, response)
    return response


def remove_league_member(member_user_id: int, user: dict[str, Any]) -> dict[str, str]:
    if user["league_role"] != "admin" or not user.get("active_league_id"):
        raise HTTPException(status_code=403, detail="Admin role required")

    league_id = int(user["active_league_id"])
    target_user_id = int(member_user_id)
    if int(user.get("id") or 0) == target_user_id:
        raise HTTPException(status_code=400, detail="You cannot remove yourself from the league")

    if get_supabase_client():
        supabase = get_supabase_client()
        assert supabase is not None
        existing = (
            supabase.table("league_memberships")
            .select("id")
            .eq("league_id", league_id)
            .eq("user_id", target_user_id)
            .eq("status", "active")
            .limit(1)
            .execute()
        )
        if not existing.data:
            raise HTTPException(status_code=404, detail="League member not found")

        supabase.table("league_memberships").delete().eq("league_id", league_id).eq("user_id", target_user_id).execute()
        supabase.table("league_join_requests").delete().eq("league_id", league_id).eq("user_id", target_user_id).execute()
        _invalidate_members_cache(league_id)
        return {"message": "League member removed"}

    with DatabaseManager() as connection:
        cursor = connection.execute(
            "DELETE FROM league_memberships WHERE league_id = ? AND user_id = ? AND status = 'active'",
            (league_id, target_user_id),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="League member not found")
        connection.execute(
            "DELETE FROM league_join_requests WHERE league_id = ? AND user_id = ?",
            (league_id, target_user_id),
        )
    _invalidate_members_cache(league_id)
    return {"message": "League member removed"}


def update_membership_role(member_user_id: int, role: str, user: dict[str, Any]) -> dict[str, str]:
    if user["league_role"] != "admin" or not user.get("active_league_id"):
        raise HTTPException(status_code=403, detail="Admin role required")

    league_id = int(user["active_league_id"])
    normalized_role = _normalize_membership_role(role)

    if get_supabase_client():
        supabase = get_supabase_client()
        assert supabase is not None
        response = (
            supabase.table("league_memberships")
            .select("*")
            .eq("league_id", league_id)
            .eq("user_id", int(member_user_id))
            .eq("status", "active")
            .limit(1)
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=404, detail="League member not found")
        supabase.table("league_memberships").update({"role": normalized_role}).eq("league_id", league_id).eq("user_id", int(member_user_id)).execute()
        _invalidate_members_cache(league_id)
        return {"message": "Member role updated"}

    with DatabaseManager() as connection:
        cursor = connection.execute(
            """
            UPDATE league_memberships
            SET role = ?
            WHERE league_id = ? AND user_id = ? AND status = 'active'
            """,
            (normalized_role, league_id, int(member_user_id)),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="League member not found")
    _invalidate_members_cache(league_id)
    return {"message": "Member role updated"}


def current_user(
    authorization: str | None = Header(default=None),
    x_league_id: str | None = Header(default=None),
) -> dict[str, Any]:
    if not _auth_enabled():
        return {
            "id": 0,
            "first_name": "Local",
            "last_name": "Admin",
            "full_name": "Local Admin",
            "user_id": "local-admin",
            "email": "local@example.com",
            "role": "read",
            "league_role": "admin",
            "membership_status": "active",
            "league_exists": True,
            "active_league_id": 1,
            "league": None,
            "memberships": [],
            "pending_requests": [],
            "available_leagues": [],
        }

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")

    requested_league_id = None
    if x_league_id:
        try:
            requested_league_id = int(x_league_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid league selection") from exc

    token = authorization.split(" ", 1)[1].strip()
    payload = decode_token(token, expected_type="access")
    user_id_value = int(payload.get("uid", 0))
    if not user_id_value:
        raise HTTPException(status_code=401, detail="Invalid token payload")

    profile = get_user_profile_by_id(user_id_value, requested_league_id=requested_league_id)
    if not profile:
        raise HTTPException(status_code=401, detail="User not found")
    return profile


def require_admin(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if user["league_role"] != "admin" or not user.get("active_league_id"):
        raise HTTPException(status_code=403, detail="Admin role required")
    return user


def require_active_member(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if user["membership_status"] != "active" or not user.get("active_league_id"):
        raise HTTPException(status_code=403, detail="Active league membership required")
    return user
