from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse

from .api import router as api_router
from .database import init_database, get_supabase_client

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Dream11 League Prototype")
app.include_router(api_router)


@app.on_event("startup")
def startup() -> None:
    init_database()


@app.get("/")
def root() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/setup")
def setup_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "setup.html")


@app.get("/welcome")
def welcome_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "welcome.html")


@app.get("/join/{invite_code}")
def join_page(invite_code: str) -> FileResponse:
    return FileResponse(STATIC_DIR / "welcome.html")


@app.get("/players")
def players_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "players.html")


@app.get("/matches")
def matches_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "matches.html")


@app.get("/winners")
def winners_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "winners.html")


@app.get("/ledger")
def ledger_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "ledger.html")


@app.get("/login")
def login_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "login.html")


@app.get("/signup")
def signup_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "signup.html")


@app.get("/stats")
def stats_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "stats.html")


@app.get("/league-settings")
def league_settings_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "league-settings.html")


@app.get("/league-details")
def league_details_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "league-details.html")


@app.get("/health")
def health_check() -> dict[str, str]:
    """Health check endpoint for debugging"""
    supabase_client = get_supabase_client()
    if supabase_client:
        return {"status": "healthy", "database": "supabase"}
    else:
        return {"status": "healthy", "database": "sqlite"}


@app.get("/logo.png")
def logo() -> FileResponse:
    """Serve logo"""
    logo_path = STATIC_DIR / "logo.png"
    if logo_path.exists():
        return FileResponse(logo_path)
    return FileResponse(STATIC_DIR / "index.html", status_code=404)


@app.get("/favicon.ico")
def favicon() -> FileResponse:
    """Serve favicon"""
    favicon_path = STATIC_DIR / "favicon.ico"
    if favicon_path.exists():
        return FileResponse(favicon_path)
    png_favicon_path = STATIC_DIR / "favicon.png"
    if png_favicon_path.exists():
        return FileResponse(png_favicon_path, media_type="image/png")
    return FileResponse(STATIC_DIR / "index.html", status_code=404)


@app.get("/favicon.png")
def favicon_png() -> FileResponse:
    """Serve favicon as PNG"""
    favicon_path = STATIC_DIR / "favicon.png"
    if favicon_path.exists():
        return FileResponse(favicon_path)
    return FileResponse(STATIC_DIR / "index.html", status_code=404)


@app.get("/static/{file_path:path}")
def serve_static(file_path: str) -> FileResponse:
    """Serve static files"""
    file_path = STATIC_DIR / file_path
    if file_path.exists():
        return FileResponse(file_path)
    return FileResponse(STATIC_DIR / "index.html", status_code=404)
