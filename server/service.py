from __future__ import annotations

import json
import logging
import math
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException

from .auth import invalidate_profile_cache
from .database import DatabaseManager, get_supabase_client, parse_participant_ids, parse_payouts
from .integrations import (
    TelegramIntegrationConfig,
    build_telegram_link,
    build_telegram_message,
    ensure_telegram_webhook,
    get_telegram_webhook_info,
    hash_connect_token,
    render_qr_data_uri,
    send_telegram_message,
    set_telegram_webhook,
)
from .schemas import LeaguePayload, MatchPayload, PlayerPayload, WinnersPayload

logger = logging.getLogger(__name__)
TELEGRAM_EXPIRED_SESSION_RETENTION_DAYS = 30
TELEGRAM_MAX_PENDING_SESSIONS_PER_LEAGUE = 2

try:
    from .supabase_service import (
        add_match as supabase_add_match,
        add_player as supabase_add_player,
        cancel_match as supabase_cancel_match,
        delete_player as supabase_delete_player,
        get_ledger as supabase_get_ledger,
        get_state as supabase_get_state,
        get_stats as supabase_get_stats,
        get_telegram_status as supabase_get_telegram_status,
        create_telegram_connect_session as supabase_create_telegram_connect_session,
        get_telegram_connect_session_status as supabase_get_telegram_connect_session_status,
        process_telegram_webhook as supabase_process_telegram_webhook,
        send_match_update_to_telegram as supabase_send_match_update_to_telegram,
        register_telegram_webhook as supabase_register_telegram_webhook,
        reopen_match as supabase_reopen_match,
        upsert_league as supabase_upsert_league,
        save_winners as supabase_save_winners,
    )

    SUPABASE_SERVICE_AVAILABLE = True
except ImportError:
    SUPABASE_SERVICE_AVAILABLE = False


def _league_id_from_user(user: dict[str, Any]) -> int:
    league_id = user.get("active_league_id")
    if not league_id:
        raise HTTPException(status_code=400, detail="Select a league first")
    return int(league_id)


def _telegram_cleanup_cutoff() -> datetime:
    return _utc_now() - timedelta(days=TELEGRAM_EXPIRED_SESSION_RETENTION_DAYS)


def _purge_expired_telegram_sessions(connection: Any, league_id: int | None = None, user_id: int | None = None) -> None:
    cutoff = _isoformat(_telegram_cleanup_cutoff())
    query = """
        DELETE FROM telegram_link_sessions
        WHERE consumed_at IS NULL
          AND expires_at < ?
    """
    params: list[Any] = [cutoff]
    if league_id is not None:
        query += " AND league_id = ?"
        params.append(int(league_id))
    if user_id is not None:
        query += " AND created_by_user_id = ?"
        params.append(int(user_id))
    connection.execute(query, tuple(params))


def _admin_league_count(connection: Any, user_id: int) -> int:
    row = connection.execute(
        """
        SELECT COUNT(*) AS count
        FROM league_memberships
        WHERE user_id = ?
          AND status = 'active'
          AND role = 'admin'
        """,
        (int(user_id),),
    ).fetchone()
    return max(1, int(row["count"] if row and row["count"] is not None else 0))


def _ensure_telegram_connect_session_capacity(connection: Any, league_id: int, user_id: int) -> None:
    _purge_expired_telegram_sessions(connection, user_id=user_id)
    league_count = _admin_league_count(connection, user_id)
    total_limit = max(TELEGRAM_MAX_PENDING_SESSIONS_PER_LEAGUE, league_count * TELEGRAM_MAX_PENDING_SESSIONS_PER_LEAGUE)

    total_row = connection.execute(
        """
        SELECT COUNT(*) AS count
        FROM telegram_link_sessions
        WHERE created_by_user_id = ?
          AND consumed_at IS NULL
          AND expires_at >= ?
        """,
        (int(user_id), _isoformat(_utc_now())),
    ).fetchone()
    total_pending = int(total_row["count"] if total_row and total_row["count"] is not None else 0)
    if total_pending >= total_limit:
        raise HTTPException(
            status_code=429,
            detail=f"Too many active Telegram connect sessions. Finish or wait for an existing session to expire before creating more (limit {total_limit}).",
        )

    league_row = connection.execute(
        """
        SELECT COUNT(*) AS count
        FROM telegram_link_sessions
        WHERE created_by_user_id = ?
          AND league_id = ?
          AND consumed_at IS NULL
          AND expires_at >= ?
        """,
        (int(user_id), int(league_id), _isoformat(_utc_now())),
    ).fetchone()
    league_pending = int(league_row["count"] if league_row and league_row["count"] is not None else 0)
    if league_pending >= TELEGRAM_MAX_PENDING_SESSIONS_PER_LEAGUE:
        raise HTTPException(
            status_code=429,
            detail="This league already has the maximum active Telegram connect sessions. Finish one before creating another.",
        )


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


def _build_refund_rows(match_id: int, participant_ids: list[int], entry_fee: float) -> list[dict[str, Any]]:
    if not participant_ids:
        return []
    pool = float(entry_fee) * len(participant_ids)
    split = round(pool / len(participant_ids), 2)
    remainder = round(pool - (split * len(participant_ids)), 2)
    rows: list[dict[str, Any]] = []
    for idx, player_id in enumerate(participant_ids):
        amount = split + (remainder if idx == 0 else 0.0)
        rows.append(
            {
                "match_id": int(match_id),
                "rank": 0,
                "player_id": int(player_id),
                "amount": round(amount, 2),
            }
        )
    return rows


def _build_match_number_map(matches: list[Any]) -> dict[int, int]:
    ordered_ids = sorted(int(match["id"]) for match in matches)
    return {match_id: index + 1 for index, match_id in enumerate(ordered_ids)}


def _generate_invite_code(name: str, league_id: int) -> str:
    import re

    base = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-") or "league"
    return f"{base}-{league_id}"


def _member_player_name(user_row: dict[str, Any] | Any) -> str:
    user_id_label = str(user_row.get("user_id_label") if isinstance(user_row, dict) else user_row["user_id_label"]).strip()
    if user_id_label:
        return user_id_label
    first_name = str(user_row.get("first_name") if isinstance(user_row, dict) else user_row["first_name"]).strip()
    last_name = str(user_row.get("last_name") if isinstance(user_row, dict) else user_row["last_name"]).strip()
    full_name = f"{first_name} {last_name}".strip()
    return full_name or "member"


def _sync_active_members_to_players(connection: Any, league_id: int) -> list[Any]:
    members = connection.execute(
        """
        SELECT u.user_id AS user_id_label, u.first_name, u.last_name
        FROM league_memberships m
        JOIN users u ON u.id = m.user_id
        WHERE m.league_id = ? AND m.status = 'active'
        ORDER BY u.user_id ASC
        """,
        (league_id,),
    ).fetchall()

    desired_names: list[str] = []
    seen_names: set[str] = set()
    for member in members:
        player_name = _member_player_name(member).strip()
        if not player_name or player_name in seen_names:
            continue
        seen_names.add(player_name)
        desired_names.append(player_name)
        connection.execute(
            "INSERT OR IGNORE INTO players (league_id, name) VALUES (?, ?)",
            (league_id, player_name),
        )

    if not desired_names:
        return []

    placeholders = ",".join("?" for _ in desired_names)
    return connection.execute(
        f"SELECT id, name FROM players WHERE league_id = ? AND name IN ({placeholders}) ORDER BY name ASC",
        (league_id, *desired_names),
    ).fetchall()


def _validate_league_payouts(payload: LeaguePayload) -> None:
    payouts = payload.payouts or {}
    if not payouts:
        raise HTTPException(status_code=400, detail="Add at least one winner payout")

    normalized: list[tuple[int, float]] = []
    for rank, amount in payouts.items():
        try:
            rank_num = int(rank)
            amount_num = float(amount)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Winner payouts contain invalid rank or amount")

        if rank_num < 1:
            raise HTTPException(status_code=400, detail="Winner payout ranks must start from 1")
        if not math.isfinite(amount_num) or amount_num <= 0:
            raise HTTPException(status_code=400, detail=f"Winner payout for rank {rank_num} must be greater than 0")

        normalized.append((rank_num, round(amount_num, 2)))

    normalized.sort(key=lambda item: item[0])
    actual_ranks = [rank for rank, _ in normalized]
    expected_ranks = list(range(1, len(normalized) + 1))
    if actual_ranks != expected_ranks:
        raise HTTPException(status_code=400, detail="Winner payout ranks must be continuous: 1, 2, 3...")

    winner_count = len(normalized)
    if winner_count != int(payload.default_winner_count):
        raise HTTPException(status_code=400, detail="Default winner count must match the number of payout rows")
    if winner_count > int(payload.active_player_count):
        raise HTTPException(status_code=400, detail="Winner count cannot exceed active league players")

    payout_total = round(sum(amount for _, amount in normalized), 2)
    prize_pool = round(float(payload.entry_fee) * int(payload.active_player_count), 2)
    if abs(payout_total - prize_pool) >= 0.01:
        raise HTTPException(
            status_code=400,
            detail=f"Winner payout total ({payout_total:.2f}) must match prize pool ({prize_pool:.2f})",
        )


def get_state(user: dict[str, Any]) -> dict[str, Any]:
    if get_supabase_client() and SUPABASE_SERVICE_AVAILABLE:
        return supabase_get_state(user)

    league_id = _league_id_from_user(user)
    with DatabaseManager() as c:
        league = c.execute("SELECT * FROM league WHERE id = ?", (league_id,)).fetchone()
        players = _sync_active_members_to_players(c, league_id)
        matches = c.execute("SELECT * FROM matches WHERE league_id = ? ORDER BY id DESC", (league_id,)).fetchall()

    fallback_participant_ids = [int(player["id"]) for player in players]
    match_number_map = _build_match_number_map(matches)
    return {
        "league": {
            "id": int(league["id"]),
            "sport": league["sport"] or "Cricket",
            "name": league["name"],
            "tournament": league["tournament"],
            "entry_fee": league["entry_fee"],
            "active_player_count": league["active_player_count"],
            "default_winner_count": league["default_winner_count"],
            "payouts": parse_payouts(league["payouts_json"]),
            "invite_code": league["invite_code"],
            "invite_link": f"/join/{league['invite_code']}",
        }
        if league
        else None,
        "players": [dict(p) for p in players],
        "matches": [
            {
                **dict(m),
                "match_number": match_number_map.get(int(m["id"]), 0),
                "payouts": parse_payouts(m["payouts_json"]),
                "participant_ids": parse_participant_ids(m["participant_ids_json"]) or fallback_participant_ids,
            }
            for m in matches
        ],
    }


def upsert_league(payload: LeaguePayload, user: dict[str, Any], create_new: bool = False) -> dict[str, Any]:
    _validate_league_payouts(payload)

    if get_supabase_client() and SUPABASE_SERVICE_AVAILABLE:
        return supabase_upsert_league(payload, user, create_new=create_new)

    payouts_json = json.dumps(payload.payouts)
    with DatabaseManager() as c:
        if create_new or not payload.league_id:
            cursor = c.execute(
                """
                INSERT INTO league (sport, name, tournament, entry_fee, active_player_count, owner_user_id, default_winner_count, payouts_json, invite_code)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, '')
                """,
                (
                    payload.sport.strip(),
                    payload.name.strip(),
                    payload.tournament.strip(),
                    payload.entry_fee,
                    payload.active_player_count,
                    int(user["id"]),
                    payload.default_winner_count,
                    payouts_json,
                ),
            )
            league_id = int(cursor.lastrowid)
            invite_code = _generate_invite_code(payload.name, league_id)
            c.execute("UPDATE league SET invite_code = ? WHERE id = ?", (invite_code, league_id))
            c.execute(
                """
                INSERT INTO league_memberships (user_id, league_id, role, status)
                VALUES (?, ?, 'admin', 'active')
                ON CONFLICT(user_id, league_id) DO UPDATE SET role = 'admin', status = 'active'
                """,
                (int(user["id"]), league_id),
            )
            owner_player_name = str(user.get("user_id") or "").strip() or f"member-{int(user['id'])}"
            c.execute(
                "INSERT OR IGNORE INTO players (league_id, name) VALUES (?, ?)",
                (league_id, owner_player_name),
            )
            c.execute(
                "DELETE FROM league_join_requests WHERE user_id = ? AND league_id = ?",
                (int(user["id"]), league_id),
            )
            invalidate_profile_cache(user_id_value=int(user["id"]), user_id_label=str(user.get("user_id") or ""))
            return {"message": "League created", "league_id": league_id, "invite_code": invite_code}

        league_id = int(payload.league_id)
        existing = c.execute("SELECT * FROM league WHERE id = ? LIMIT 1", (league_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="League not found")
        if user["league_role"] != "admin" or int(user.get("active_league_id") or 0) != league_id:
            raise HTTPException(status_code=403, detail="Admin role required")

        c.execute(
            """
            UPDATE league
            SET sport = ?, name = ?, tournament = ?, entry_fee = ?, active_player_count = ?, default_winner_count = ?, payouts_json = ?
            WHERE id = ?
            """,
            (
                payload.sport.strip(),
                payload.name.strip(),
                payload.tournament.strip(),
                payload.entry_fee,
                payload.active_player_count,
                payload.default_winner_count,
                payouts_json,
                league_id,
            ),
        )
        return {"message": "League settings saved", "league_id": league_id, "invite_code": existing["invite_code"]}


def add_player(payload: PlayerPayload, user: dict[str, Any]) -> dict[str, str]:
    if get_supabase_client() and SUPABASE_SERVICE_AVAILABLE:
        return supabase_add_player(payload, user)

    league_id = _league_id_from_user(user)
    player_name = payload.name.strip()
    try:
        with DatabaseManager() as c:
            cursor = c.execute("INSERT INTO players (league_id, name) VALUES (?, ?)", (league_id, player_name))
            if cursor.rowcount != 1:
                raise HTTPException(status_code=500, detail="Player insert failed")
    except Exception as exc:
        if "UNIQUE" in str(exc).upper():
            raise HTTPException(status_code=409, detail="Player already exists")
        if isinstance(exc, HTTPException):
            raise
        raise
    return {"message": "Player added"}


def delete_player(player_id: int, user: dict[str, Any]) -> dict[str, str]:
    if get_supabase_client() and SUPABASE_SERVICE_AVAILABLE:
        return supabase_delete_player(player_id, user)

    league_id = _league_id_from_user(user)
    with DatabaseManager() as c:
        cursor = c.execute("DELETE FROM players WHERE id = ? AND league_id = ?", (player_id, league_id))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Player not found")
    return {"message": "Player removed"}


def add_match(payload: MatchPayload, user: dict[str, Any]) -> dict[str, str]:
    if get_supabase_client() and SUPABASE_SERVICE_AVAILABLE:
        return supabase_add_match(payload, user)

    league_id = _league_id_from_user(user)
    payouts_json = json.dumps(payload.payouts) if payload.payouts else None
    with DatabaseManager() as c:
        players = _sync_active_members_to_players(c, league_id)
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
            """
            INSERT INTO matches (league_id, title, match_date, winner_count, payouts_json, participant_ids_json)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                league_id,
                payload.title.strip(),
                payload.match_date.strip(),
                payload.winner_count,
                payouts_json,
                json.dumps(participant_ids),
            ),
        )
        if cursor.rowcount != 1:
            raise HTTPException(status_code=500, detail="Match insert failed")
    return {"message": "Match added"}


def save_winners(match_id: int, payload: WinnersPayload, user: dict[str, Any]) -> dict[str, str]:
    if get_supabase_client() and SUPABASE_SERVICE_AVAILABLE:
        return supabase_save_winners(match_id, payload, user)

    league_id = _league_id_from_user(user)
    with DatabaseManager() as c:
        match_row = c.execute("SELECT * FROM matches WHERE id = ? AND league_id = ?", (match_id, league_id)).fetchone()
        league_row = c.execute("SELECT * FROM league WHERE id = ?", (league_id,)).fetchone()
        players = _sync_active_members_to_players(c, league_id)
        players_by_id = {
            int(row["id"]): dict(row)
            for row in players
        }
        if not match_row or not league_row:
            raise HTTPException(status_code=404, detail="League or match not found")
        if str(match_row["status"] or "").lower() == "canceled":
            raise HTTPException(status_code=409, detail="This match is already marked as washout/cancelled")

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


def cancel_match(match_id: int, user: dict[str, Any]) -> dict[str, str]:
    if get_supabase_client() and SUPABASE_SERVICE_AVAILABLE:
        return supabase_cancel_match(match_id, user)

    league_id = _league_id_from_user(user)
    with DatabaseManager() as c:
        match_row = c.execute("SELECT * FROM matches WHERE id = ? AND league_id = ?", (match_id, league_id)).fetchone()
        league_row = c.execute("SELECT * FROM league WHERE id = ?", (league_id,)).fetchone()
        players = _sync_active_members_to_players(c, league_id)

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


def reopen_match(match_id: int, user: dict[str, Any]) -> dict[str, str]:
    if get_supabase_client() and SUPABASE_SERVICE_AVAILABLE:
        return supabase_reopen_match(match_id, user)

    league_id = _league_id_from_user(user)
    with DatabaseManager() as c:
        match_row = c.execute("SELECT * FROM matches WHERE id = ? AND league_id = ?", (match_id, league_id)).fetchone()
        if not match_row:
            raise HTTPException(status_code=404, detail="Match not found")
        if str(match_row["status"] or "").lower() != "canceled":
            raise HTTPException(status_code=409, detail="Only washout/cancelled matches can be reopened")

        c.execute("DELETE FROM winner_entries WHERE match_id = ?", (match_id,))
        c.execute("UPDATE matches SET status = 'pending' WHERE id = ?", (match_id,))

    return {"message": "Match reopened for winner assignment"}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _isoformat(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def _parse_timestamp(raw: Any) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None


def _fetch_match_notification_context_sqlite(c: Any, league_id: int, match_id: int) -> dict[str, Any]:
    league_row = c.execute("SELECT id, name, tournament, entry_fee FROM league WHERE id = ?", (league_id,)).fetchone()
    match_row = c.execute(
        "SELECT id, title, match_date, status, participant_ids_json FROM matches WHERE id = ? AND league_id = ?",
        (match_id, league_id),
    ).fetchone()
    if not league_row or not match_row:
        raise HTTPException(status_code=404, detail="Match not found")

    players = _sync_active_members_to_players(c, league_id)
    player_name_by_id = {int(player["id"]): str(player["name"]) for player in players}
    participant_ids = parse_participant_ids(match_row["participant_ids_json"]) or [int(player["id"]) for player in players]
    winner_rows = c.execute(
        """
        SELECT rank, player_id, amount
        FROM winner_entries
        WHERE match_id = ?
        ORDER BY rank ASC, player_id ASC
        """,
        (match_id,),
    ).fetchall()
    matches = c.execute(
        "SELECT id FROM matches WHERE league_id = ? ORDER BY id ASC",
        (league_id,),
    ).fetchall()
    match_number_map = _build_match_number_map(matches)

    grouped: dict[int, dict[str, Any]] = {}
    for row in winner_rows:
        rank = int(row["rank"])
        grouped.setdefault(
            rank,
            {
                "rank": rank,
                "label": _rank_label(rank, str(match_row["status"] or "pending"), True),
                "amount": float(row["amount"]),
                "players": [],
            },
        )["players"].append(player_name_by_id.get(int(row["player_id"]), f"Player #{row['player_id']}"))

    return {
        "league_name": str(league_row["name"]),
        "tournament": str(league_row["tournament"]),
        "entry_fee": float(league_row["entry_fee"]),
        "match_id": int(match_row["id"]),
        "match_number": match_number_map.get(int(match_row["id"]), 0),
        "title": str(match_row["title"]),
        "match_date": str(match_row["match_date"]),
        "status": str(match_row["status"] or "pending"),
        "participant_count": len(participant_ids),
        "winner_rows": list(grouped.values()),
    }


def _build_match_notification_message(context: dict[str, Any]) -> str:
    title = f"{context['league_name']} · Match #{context['match_number'] or context['match_id']}"
    lines = [
        f"{context['title']} · {context['match_date']}",
        f"Status: {str(context['status']).replace('_', ' ').title()}",
    ]

    if str(context["status"]).lower() == "canceled":
        lines.append(f"Washout recorded. Refund restored across {context['participant_count']} participants.")
    else:
        for row in context["winner_rows"]:
            players = ", ".join(row["players"]) if row["players"] else "No players"
            amount = float(row["amount"])
            lines.append(f"{row['label']}: {players} ({amount:.2f} each)")

    lines.append(f"Tournament: {context['tournament']}")
    return build_telegram_message(title=title, lines=lines)


def get_telegram_status(user: dict[str, Any]) -> dict[str, Any]:
    if get_supabase_client() and SUPABASE_SERVICE_AVAILABLE:
        return supabase_get_telegram_status(user)

    league_id = _league_id_from_user(user)
    config = TelegramIntegrationConfig.from_env()
    with DatabaseManager() as c:
        _purge_expired_telegram_sessions(c)
        row = c.execute(
            """
            SELECT telegram_chat_id, telegram_chat_name, telegram_chat_type, telegram_notifications_enabled, telegram_connected_at
            FROM league_integrations
            WHERE league_id = ?
            """,
            (league_id,),
        ).fetchone()

    target = None
    if row and row["telegram_chat_id"]:
        target = {
            "chat_id": str(row["telegram_chat_id"]),
            "chat_name": str(row["telegram_chat_name"] or ""),
            "chat_type": str(row["telegram_chat_type"] or ""),
            "enabled": bool(row["telegram_notifications_enabled"]),
            "connected_at": str(row["telegram_connected_at"] or ""),
        }

    webhook_registered = False
    if config.is_webhook_ready():
        try:
            info = get_telegram_webhook_info(config)
            webhook_registered = str((info.get("result") or {}).get("url") or "") == str(config.webhook_url() or "")
        except HTTPException:
            webhook_registered = False

    return {
        "bot_ready": config.is_bot_ready(),
        "connect_ready": config.is_bot_ready(),
        "send_ready": config.is_bot_ready() and bool(target and target.get("enabled")),
        "webhook_ready": config.is_webhook_ready(),
        "webhook_registered": webhook_registered,
        "bot_username": config.bot_username,
        "target": target,
    }


def create_telegram_connect_session(target: str, user: dict[str, Any], match_id: int | None = None) -> dict[str, Any]:
    if get_supabase_client() and SUPABASE_SERVICE_AVAILABLE:
        return supabase_create_telegram_connect_session(target, user, match_id=match_id)

    config = TelegramIntegrationConfig.from_env()
    if not config.is_bot_ready():
        raise HTTPException(status_code=503, detail="Telegram bot is not fully configured yet")
    if not config.is_webhook_ready():
        raise HTTPException(status_code=503, detail="Telegram webhook settings are incomplete")
    ensure_telegram_webhook(config)

    league_id = _league_id_from_user(user)
    session_id = secrets.token_urlsafe(18)
    raw_token = secrets.token_urlsafe(24)
    expires_at = _utc_now() + timedelta(minutes=15)
    deep_link = build_telegram_link(config.bot_username or "", raw_token, target)
    qr_code = render_qr_data_uri(deep_link)

    with DatabaseManager() as c:
        _ensure_telegram_connect_session_capacity(c, league_id, int(user["id"]))
        c.execute(
            """
            INSERT INTO telegram_link_sessions (
                id, token_hash, league_id, created_by_user_id, target, requested_match_id, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                hash_connect_token(raw_token),
                league_id,
                int(user["id"]),
                target,
                int(match_id) if match_id else None,
                _isoformat(expires_at),
            ),
        )

    return {
        "session_id": session_id,
        "target": target,
        "connect_url": deep_link,
        "start_command": f"/start {raw_token}",
        "qr_code_data_uri": qr_code,
        "expires_at": _isoformat(expires_at),
    }


def get_telegram_connect_session_status(session_id: str, user: dict[str, Any]) -> dict[str, Any]:
    if get_supabase_client() and SUPABASE_SERVICE_AVAILABLE:
        return supabase_get_telegram_connect_session_status(session_id, user)

    league_id = _league_id_from_user(user)
    with DatabaseManager() as c:
        row = c.execute(
            """
            SELECT *
            FROM telegram_link_sessions
            WHERE id = ? AND league_id = ? AND created_by_user_id = ?
            LIMIT 1
            """,
            (session_id, league_id, int(user["id"])),
        ).fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Telegram connect session not found")

    expires_at = _parse_timestamp(row["expires_at"])
    connected = bool(row["consumed_at"] and row["connected_chat_id"])
    expired = bool(expires_at and _utc_now() >= expires_at and not connected)
    status = "connected" if connected else "expired" if expired else "pending"

    return {
        "session_id": str(row["id"]),
        "status": status,
        "target": str(row["target"]),
        "requested_match_id": int(row["requested_match_id"]) if row["requested_match_id"] else None,
        "expires_at": str(row["expires_at"]),
        "connected_target": (
            {
                "chat_id": str(row["connected_chat_id"]),
                "chat_name": str(row["connected_chat_name"] or ""),
                "chat_type": str(row["connected_chat_type"] or ""),
            }
            if row["connected_chat_id"]
            else None
        ),
        "last_error": str(row["last_error"] or ""),
    }


def process_telegram_webhook(update: dict[str, Any]) -> dict[str, Any]:
    if get_supabase_client() and SUPABASE_SERVICE_AVAILABLE:
        return supabase_process_telegram_webhook(update)

    message = (update or {}).get("message") or {}
    text = str(message.get("text") or "").strip()
    if not text.startswith("/start"):
        return {"ok": True, "handled": False}

    parts = text.split(maxsplit=1)
    raw_token = parts[1].strip() if len(parts) > 1 else ""
    if not raw_token:
        return {"ok": True, "handled": False}

    chat = message.get("chat") or {}
    chat_id = str(chat.get("id") or "").strip()
    chat_type = str(chat.get("type") or "").strip()
    if not chat_id:
        return {"ok": True, "handled": False}

    chat_name = (
        str(chat.get("title") or "").strip()
        or " ".join(part for part in [str(chat.get("first_name") or "").strip(), str(chat.get("last_name") or "").strip()] if part).strip()
        or str(chat.get("username") or "").strip()
        or "Telegram Chat"
    )
    token_hash = hash_connect_token(raw_token)
    config = TelegramIntegrationConfig.from_env()

    with DatabaseManager() as c:
        row = c.execute(
            """
            SELECT *
            FROM telegram_link_sessions
            WHERE token_hash = ?
            LIMIT 1
            """,
            (token_hash,),
        ).fetchone()
        if not row:
            return {"ok": True, "handled": False}

        if row["consumed_at"]:
            return {"ok": True, "handled": True, "status": "already_consumed"}

        expires_at = _parse_timestamp(row["expires_at"])
        if expires_at and _utc_now() >= expires_at:
            c.execute(
                "UPDATE telegram_link_sessions SET last_error = ? WHERE id = ?",
                ("Session expired before Telegram link completed", row["id"]),
            )
            return {"ok": True, "handled": True, "status": "expired"}

        target = str(row["target"])
        if target == "personal" and chat_type != "private":
            c.execute(
                "UPDATE telegram_link_sessions SET last_error = ? WHERE id = ?",
                ("Personal connection must be completed from a private chat", row["id"]),
            )
            return {"ok": True, "handled": True, "status": "invalid_chat_type"}
        if target == "group" and chat_type not in {"group", "supergroup"}:
            c.execute(
                "UPDATE telegram_link_sessions SET last_error = ? WHERE id = ?",
                ("Group connection must be completed from a Telegram group", row["id"]),
            )
            return {"ok": True, "handled": True, "status": "invalid_chat_type"}

        c.execute(
            """
            INSERT INTO league_integrations (
                league_id,
                telegram_chat_id,
                telegram_chat_name,
                telegram_chat_type,
                telegram_notifications_enabled,
                telegram_connected_by_user_id,
                telegram_connected_at,
                updated_at
            ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
            ON CONFLICT(league_id) DO UPDATE SET
                telegram_chat_id = excluded.telegram_chat_id,
                telegram_chat_name = excluded.telegram_chat_name,
                telegram_chat_type = excluded.telegram_chat_type,
                telegram_notifications_enabled = excluded.telegram_notifications_enabled,
                telegram_connected_by_user_id = excluded.telegram_connected_by_user_id,
                telegram_connected_at = excluded.telegram_connected_at,
                updated_at = excluded.updated_at
            """,
            (
                int(row["league_id"]),
                chat_id,
                chat_name,
                chat_type,
                int(row["created_by_user_id"]),
                _isoformat(_utc_now()),
                _isoformat(_utc_now()),
            ),
        )
        c.execute(
            """
            UPDATE telegram_link_sessions
            SET connected_chat_id = ?, connected_chat_name = ?, connected_chat_type = ?, consumed_at = ?, last_error = NULL
            WHERE id = ?
            """,
            (chat_id, chat_name, chat_type, _isoformat(_utc_now()), row["id"]),
        )

    try:
        send_telegram_message(
            message=build_telegram_message(
                title="League Ledger connected",
                lines=[
                    f"{chat_name} is now linked for future match updates.",
                    "Return to League Ledger to send the latest result.",
                ],
            ),
            chat_id=chat_id,
            config=config,
        )
    except HTTPException:
        logger.warning("Telegram confirmation message could not be sent after successful link.")

    return {"ok": True, "handled": True, "status": "connected"}


def send_match_update_to_telegram(match_id: int, user: dict[str, Any]) -> dict[str, Any]:
    if get_supabase_client() and SUPABASE_SERVICE_AVAILABLE:
        return supabase_send_match_update_to_telegram(match_id, user)

    league_id = _league_id_from_user(user)
    with DatabaseManager() as c:
        integration = c.execute(
            """
            SELECT telegram_chat_id, telegram_chat_name, telegram_notifications_enabled
            FROM league_integrations
            WHERE league_id = ?
            LIMIT 1
            """,
            (league_id,),
        ).fetchone()
        if not integration or not integration["telegram_chat_id"]:
            raise HTTPException(status_code=400, detail="Telegram is not connected for this league yet")
        if not bool(integration["telegram_notifications_enabled"]):
            raise HTTPException(status_code=400, detail="Telegram notifications are disabled for this league")
        context = _fetch_match_notification_context_sqlite(c, league_id, match_id)

    result = send_telegram_message(
        message=_build_match_notification_message(context),
        chat_id=str(integration["telegram_chat_id"]),
    )
    return {
        "ok": result.sent,
        "chat_id": result.chat_id,
        "chat_name": str(integration["telegram_chat_name"] or ""),
        "message_id": result.message_id,
    }


def register_telegram_webhook(user: dict[str, Any]) -> dict[str, Any]:
    if get_supabase_client() and SUPABASE_SERVICE_AVAILABLE:
        return supabase_register_telegram_webhook(user)

    _league_id_from_user(user)
    data = set_telegram_webhook(TelegramIntegrationConfig.from_env())
    return {"ok": bool(data.get("ok")), "description": str(data.get("description") or "Webhook registered")}


def get_ledger(user: dict[str, Any]) -> dict[str, Any]:
    if user.get("league_role") != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")

    if get_supabase_client() and SUPABASE_SERVICE_AVAILABLE:
        return supabase_get_ledger(user)

    league_id = _league_id_from_user(user)
    with DatabaseManager() as c:
        league_row = c.execute("SELECT * FROM league WHERE id = ?", (league_id,)).fetchone()
        if not league_row:
            return {"rows": [], "completed_matches": 0, "entry_fee": 0}

        players = _sync_active_members_to_players(c, league_id)
        matches = c.execute(
            "SELECT id, status, participant_ids_json FROM matches WHERE league_id = ? AND status IN ('completed', 'canceled') ORDER BY id DESC",
            (league_id,),
        ).fetchall()
        winnings = c.execute(
            """
            SELECT we.match_id, we.player_id, we.amount
            FROM winner_entries we
            JOIN matches m ON m.id = we.match_id
            WHERE m.league_id = ?
            """,
            (league_id,),
        ).fetchall()

    by_match_winnings: dict[int, list[dict[str, Any]]] = {}
    for row in winnings:
        by_match_winnings.setdefault(int(row["match_id"]), []).append(
            {
                "match_id": int(row["match_id"]),
                "player_id": int(row["player_id"]),
                "amount": float(row["amount"]),
            }
        )

    entry_fee = float(league_row["entry_fee"])
    completed_matches = len(matches)
    fallback_participants = [int(player["id"]) for player in players]
    match_counts_by_player: dict[int, int] = {}
    winnings_map: dict[int, float] = {}

    for match in matches:
        match_id = int(match["id"])
        participant_ids = parse_participant_ids(match["participant_ids_json"]) or fallback_participants
        effective_rows = (
            _build_refund_rows(match_id, participant_ids, entry_fee)
            if str(match["status"]) == "canceled"
            else by_match_winnings.get(match_id, [])
        )
        for player_id in participant_ids:
            match_counts_by_player[player_id] = match_counts_by_player.get(player_id, 0) + 1
        for row in effective_rows:
            player_id = int(row["player_id"])
            winnings_map[player_id] = round(winnings_map.get(player_id, 0.0) + float(row["amount"]), 2)

    rows = []
    for player in players:
        spent = round(match_counts_by_player.get(int(player["id"]), 0) * entry_fee, 2)
        won = round(winnings_map.get(player["id"], 0.0), 2)
        net = round(won - spent, 2)
        rows.append({"player_id": player["id"], "name": player["name"], "spent": spent, "won": won, "net": net})

    return {"rows": rows, "completed_matches": completed_matches, "entry_fee": entry_fee}


def get_stats(user: dict[str, Any]) -> dict[str, Any]:
    if get_supabase_client() and SUPABASE_SERVICE_AVAILABLE:
        return supabase_get_stats(user)

    league_id = _league_id_from_user(user)
    with DatabaseManager() as c:
        league = c.execute(
            "SELECT entry_fee FROM league WHERE id = ? LIMIT 1",
            (league_id,),
        ).fetchone()
        players = _sync_active_members_to_players(c, league_id)
        matches = c.execute(
            "SELECT id, title, match_date, status, participant_ids_json FROM matches WHERE league_id = ? ORDER BY id DESC",
            (league_id,),
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
            JOIN matches m ON m.id = we.match_id
            LEFT JOIN players p ON p.id = we.player_id
            WHERE m.league_id = ?
            ORDER BY we.match_id DESC, we.rank ASC, player_name ASC
            """,
            (league_id,),
        ).fetchall()

    canceled_match_ids = {int(match["id"]) for match in matches if str(match["status"]) == "canceled"}
    winners = [row for row in winners if int(row["match_id"]) not in canceled_match_ids]

    player_name_by_id = {int(player["id"]): str(player["name"]) for player in players}
    match_number_map = _build_match_number_map(matches)
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

    for match in matches:
        match_id = int(match["id"])
        if str(match["status"]) != "canceled":
            continue
        participant_ids = _normalize_participant_ids(parse_participant_ids(match["participant_ids_json"]))
        if not participant_ids:
            participant_ids = _normalize_participant_ids(list(player_name_by_id.keys()))

        synthetic_rows = _build_refund_rows(match_id, participant_ids, entry_fee=float(league["entry_fee"] or 0))
        for row in synthetic_rows:
            row["player_name"] = player_name_by_id.get(int(row["player_id"]), f"Archived Player #{row['player_id']}")
            by_match.setdefault(match_id, []).append(row)
            winner_lookup.setdefault(match_id, {})[int(row["player_id"])] = {
                "rank": 0,
                "amount": float(row["amount"]),
            }
            stat = player_stats.get(int(row["player_id"]))
            if not stat:
                stat = {
                    "player_id": int(row["player_id"]),
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
                player_stats[int(row["player_id"])] = stat
            stat["_washout_match_ids"].add(match_id)
            stat["rank_counts"]["0"] = int(stat["rank_counts"].get("0", 0)) + 1
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
                "match_number": match_number_map.get(match_id, 0),
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
    entry_fee = round(float(league["entry_fee"]), 2) if league and league["entry_fee"] is not None else 0.0
    total_matches = len(matches)
    played_matches = sum(1 for match in matches if str(match["status"]) == "completed")
    canceled_matches = sum(1 for match in matches if str(match["status"]) == "canceled")
    return {
        "summary": {
            "entry_fee": entry_fee,
            "total_matches": total_matches,
            "played_matches": played_matches,
            "canceled_matches": canceled_matches,
        },
        "matches": match_stats,
        "players": player_stats_list,
    }
