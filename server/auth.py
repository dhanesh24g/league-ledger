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


def _normalize_invite_code(value: str) -> str:
    return "".join(char for char in value.strip().lower() if char.isalnum() or char == "-")


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


def _shape_league_summary(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
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
        "league_exists": bool(leagues),
        "active_league_id": int(current_league["id"]) if current_league else None,
        "league": _shape_league_summary(current_league) if current_league else None,
        "memberships": memberships_payload,
        "pending_requests": pending_payload,
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

    if user_id_value is not None:
        response = supabase.table("users").select("*").eq("id", int(user_id_value)).limit(1).execute()
    else:
        response = supabase.table("users").select("*").eq("user_id", _normalize_user_id(str(user_id_label or ""))).limit(1).execute()

    if not response.data:
        return None

    user = response.data[0]
    leagues = supabase.table("league").select("*").order("created_at").order("id").execute().data or []
    memberships = (
        supabase.table("league_memberships")
        .select("*")
        .eq("user_id", int(user["id"]))
        .order("created_at")
        .order("id")
        .execute()
        .data
        or []
    )
    requests = (
        supabase.table("league_join_requests")
        .select("*")
        .eq("user_id", int(user["id"]))
        .order("created_at")
        .order("id")
        .execute()
        .data
        or []
    )
    return _build_profile(user, leagues, memberships, requests, requested_league_id=requested_league_id)


def get_user_profile_by_user_id(user_id_value: str, requested_league_id: int | None = None) -> dict[str, Any] | None:
    if get_supabase_client():
        return _supabase_profile_query(user_id_label=user_id_value, requested_league_id=requested_league_id)
    return _sqlite_profile_query(user_id_label=user_id_value, requested_league_id=requested_league_id)


def get_user_profile_by_id(user_id_value: int, requested_league_id: int | None = None) -> dict[str, Any] | None:
    if get_supabase_client():
        return _supabase_profile_query(user_id_value=user_id_value, requested_league_id=requested_league_id)
    return _sqlite_profile_query(user_id_value=user_id_value, requested_league_id=requested_league_id)


def auth_config() -> dict[str, Any]:
    return {"enabled": _auth_enabled(), "signup_enabled": True}


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
            supabase.table("users").insert(
                {
                    "first_name": first_name.strip(),
                    "last_name": last_name.strip(),
                    "user_id": normalized_user_id,
                    "email": normalized_email,
                    "password_hash": password_hash,
                }
            ).execute()
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
        users_response = supabase.table("users").select("id, first_name, last_name, user_id, email").execute()
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
    return {"message": "Join request approved"}


def list_league_members(user: dict[str, Any]) -> dict[str, Any]:
    if user["league_role"] != "admin" or not user.get("active_league_id"):
        raise HTTPException(status_code=403, detail="Admin role required")

    league_id = int(user["active_league_id"])
    if get_supabase_client():
        supabase = get_supabase_client()
        assert supabase is not None
        memberships = (
            supabase.table("league_memberships")
            .select("*")
            .eq("league_id", league_id)
            .eq("status", "active")
            .order("created_at")
            .execute()
            .data
            or []
        )
        users_response = supabase.table("users").select("id, first_name, last_name, user_id, email").execute()
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
        return {"members": rows}

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
    return {"members": [{**dict(row), "role": _normalize_membership_role(dict(row)["role"])} for row in rows]}


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
    payload = decode_token(token)
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
