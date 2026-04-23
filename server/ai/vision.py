"""Vision LLM extraction for fantasy-league leaderboard screenshots.

Provider: OpenAI gpt-4o-mini (cheapest vision option). Uses the existing
httpx dependency; no new package needed. Returns structured rows that the
service layer then matches against the league's player list.

Environment:
    AI_VISION_ENABLED=1   (required; feature flag)
    OPENAI_API_KEY=...    (required when enabled)
    AI_VISION_MODEL=gpt-4o-mini   (optional override)
"""

from __future__ import annotations

import base64
import json
import logging
import os
from dataclasses import dataclass
from typing import Any

import httpx
from fastapi import HTTPException

logger = logging.getLogger(__name__)

_OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions"
_DEFAULT_MODEL = "gpt-4o-mini"
_MAX_IMAGE_BYTES = 6 * 1024 * 1024  # 6 MB cap — plenty for a phone screenshot
_ALLOWED_MIME_TYPES = {"image/png", "image/jpeg", "image/jpg", "image/webp"}

_SYSTEM_PROMPT = (
    "You extract the final leaderboard from a single fantasy-cricket app screenshot "
    "(for example Dream11, My11Circle, MPL). "
    "Return ONLY valid JSON with this exact shape: "
    '{"rows": [{"rank": <int>, "display_name": <string>, "points": <number|null>}]}. '
    "Rules: "
    "1) Use the visible rank number if shown; otherwise order rows top-to-bottom starting at 1. "
    "2) display_name must be the player handle / team name as shown (preserve case). "
    "3) Do NOT invent rows that are not visible in the image. "
    "4) If multiple rows share the same rank (tie), output them as separate rows with the same rank value. "
    "5) Ignore banners, ads, and rows from other contests."
)


@dataclass(slots=True)
class LeaderboardRow:
    rank: int
    display_name: str
    points: float | None = None


@dataclass(slots=True)
class VisionConfig:
    enabled: bool
    api_key: str | None
    model: str

    @classmethod
    def from_env(cls) -> "VisionConfig":
        flag = (os.getenv("AI_VISION_ENABLED") or "").strip().lower()
        enabled = flag in {"1", "true", "yes", "on"}
        return cls(
            enabled=enabled,
            api_key=os.getenv("OPENAI_API_KEY"),
            model=(os.getenv("AI_VISION_MODEL") or _DEFAULT_MODEL).strip() or _DEFAULT_MODEL,
        )


def vision_available() -> bool:
    cfg = VisionConfig.from_env()
    return cfg.enabled and bool(cfg.api_key)


def extract_leaderboard(image_bytes: bytes, mime_type: str) -> list[LeaderboardRow]:
    """Call the vision LLM and return normalized leaderboard rows.

    Raises HTTPException with user-facing messages on validation or provider
    failures so callers can surface them directly.
    """

    cfg = VisionConfig.from_env()
    if not cfg.enabled:
        raise HTTPException(
            status_code=503,
            detail="AI screenshot extraction is disabled on this server (set AI_VISION_ENABLED=1).",
        )
    if not cfg.api_key:
        raise HTTPException(
            status_code=503,
            detail="AI screenshot extraction is not configured (missing OPENAI_API_KEY).",
        )

    if not image_bytes:
        raise HTTPException(status_code=400, detail="Screenshot is empty.")
    if len(image_bytes) > _MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Screenshot is too large (max 6 MB).")

    normalized_mime = (mime_type or "").strip().lower()
    if normalized_mime == "image/jpg":
        normalized_mime = "image/jpeg"
    if normalized_mime not in _ALLOWED_MIME_TYPES:
        raise HTTPException(
            status_code=415,
            detail="Unsupported image type. Please upload PNG, JPEG, or WebP.",
        )

    data_url = f"data:{normalized_mime};base64,{base64.b64encode(image_bytes).decode('ascii')}"

    body: dict[str, Any] = {
        "model": cfg.model,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": (
                            "Extract the leaderboard from this screenshot into the "
                            "JSON shape defined in the system prompt."
                        ),
                    },
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            },
        ],
    }

    try:
        with httpx.Client(timeout=30.0) as client:
            response = client.post(
                _OPENAI_ENDPOINT,
                headers={
                    "Authorization": f"Bearer {cfg.api_key}",
                    "Content-Type": "application/json",
                },
                json=body,
            )
            response.raise_for_status()
            payload = response.json()
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text or str(exc)
        logger.warning("OpenAI vision request failed: %s", detail)
        raise HTTPException(status_code=502, detail="Vision provider rejected the request.") from exc
    except httpx.HTTPError as exc:
        logger.warning("OpenAI vision transport failed: %s", exc)
        raise HTTPException(status_code=502, detail="Could not reach the vision provider.") from exc

    content = _first_message_content(payload)
    if not content:
        raise HTTPException(status_code=502, detail="Vision provider returned an empty response.")

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as exc:
        logger.warning("Vision response was not valid JSON: %s", content[:500])
        raise HTTPException(status_code=502, detail="Vision provider returned malformed JSON.") from exc

    rows = _coerce_rows(parsed)
    if not rows:
        raise HTTPException(
            status_code=422,
            detail="Could not read a leaderboard from this screenshot. Try a clearer image.",
        )
    return rows


def _first_message_content(payload: dict[str, Any]) -> str:
    choices = payload.get("choices") or []
    if not choices:
        return ""
    message = choices[0].get("message") or {}
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [part.get("text", "") for part in content if isinstance(part, dict)]
        return "".join(parts)
    return ""


def _coerce_rows(parsed: Any) -> list[LeaderboardRow]:
    raw_rows: Any = None
    if isinstance(parsed, dict):
        raw_rows = parsed.get("rows")
        if raw_rows is None and isinstance(parsed.get("leaderboard"), list):
            raw_rows = parsed["leaderboard"]
    elif isinstance(parsed, list):
        raw_rows = parsed

    if not isinstance(raw_rows, list):
        return []

    rows: list[LeaderboardRow] = []
    for index, item in enumerate(raw_rows, start=1):
        if not isinstance(item, dict):
            continue
        display_name = str(item.get("display_name") or item.get("name") or "").strip()
        if not display_name:
            continue
        try:
            rank = int(item.get("rank") or index)
        except (TypeError, ValueError):
            rank = index
        points_raw = item.get("points")
        points: float | None
        try:
            points = float(points_raw) if points_raw is not None else None
        except (TypeError, ValueError):
            points = None
        rows.append(LeaderboardRow(rank=max(1, rank), display_name=display_name, points=points))

    rows.sort(key=lambda r: r.rank)
    return rows
