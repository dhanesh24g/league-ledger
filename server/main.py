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


@app.get("/health")
def health_check() -> dict[str, str]:
    """Health check endpoint for debugging"""
    supabase_client = get_supabase_client()
    if supabase_client:
        return {"status": "healthy", "database": "supabase"}
    else:
        return {"status": "healthy", "database": "sqlite"}


@app.get("/debug")
def debug_env() -> dict[str, Any]:
    """Debug endpoint to check environment variables"""
    import os
    
    # Check all environment variables (safely)
    env_vars = {}
    for key in ["SUPABASE_URL", "SUPABASE_ANON_KEY", "VERCEL", "VERCEL_ENV"]:
        value = os.getenv(key)
        if value:
            if "KEY" in key:
                env_vars[key] = f"{value[:10]}..." if len(value) > 10 else "***SET***"
            else:
                env_vars[key] = value[:50] + "..." if len(value) > 50 else value
        else:
            env_vars[key] = "NOT_SET"
    
    from .database import get_supabase_client, SUPABASE_AVAILABLE
    supabase_client = get_supabase_client()
    
    return {
        "environment": env_vars,
        "supabase_available": SUPABASE_AVAILABLE,
        "supabase_client_created": supabase_client is not None,
        "all_env_keys": [k for k in os.environ.keys() if "SUPABASE" in k.upper() or "VERCEL" in k.upper()]
    }


@app.get("/static/{file_path:path}")
def serve_static(file_path: str) -> FileResponse:
    """Serve static files"""
    file_path = STATIC_DIR / file_path
    if file_path.exists():
        return FileResponse(file_path)
    return FileResponse(STATIC_DIR / "index.html", status_code=404)
