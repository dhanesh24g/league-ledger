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


@app.get("/login")
def login_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "login.html")


@app.get("/stats")
def stats_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "stats.html")


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
    # Return default favicon or 404
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
