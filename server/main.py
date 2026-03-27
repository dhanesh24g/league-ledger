from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .api import router as api_router
from .database import init_database, get_supabase_client

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Dream11 League Prototype")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.include_router(api_router)


@app.on_event("startup")
def startup() -> None:
    init_database()


@app.get("/")
def root() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
def health_check() -> dict[str, str]:
    """Health check endpoint for debugging"""
    supabase_client = get_supabase_client()
    if supabase_client:
        return {"status": "healthy", "database": "supabase"}
    else:
        return {"status": "healthy", "database": "sqlite"}
