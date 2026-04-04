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


@app.get("/forgot-password")
def forgot_password_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "forgot-password.html")


@app.get("/reset-password")
def reset_password_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "reset-password.html")


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


@app.get("/debug/supabase")
def debug_supabase() -> dict[str, Any]:
    """Detailed Supabase connectivity check for debugging"""
    from .database import get_supabase_client
    from .auth import _supabase_profile_query
    import os
    import traceback
    
    debug_info = {
        "supabase_url_configured": bool(os.getenv("SUPABASE_URL")),
        "supabase_key_configured": bool(os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")),
        "client_available": False,
        "connection_test": False,
        "query_test": False,
        "errors": []
    }
    
    try:
        supabase_client = get_supabase_client()
        debug_info["client_available"] = supabase_client is not None
        
        if supabase_client:
            # Test basic connection
            try:
                result = supabase_client.table("users").select("id").limit(1).execute()
                debug_info["connection_test"] = True
                debug_info["connection_result"] = f"Success: {len(result.data) if result.data else 0} users found"
            except Exception as e:
                debug_info["errors"].append(f"Connection test failed: {type(e).__name__}: {str(e)}")
                debug_info["connection_error"] = {
                    "type": type(e).__name__,
                    "message": str(e),
                    "traceback": traceback.format_exc()
                }
            
            # Test profile query
            try:
                profile = _supabase_profile_query(user_id_value=1)
                debug_info["query_test"] = profile is not None
                debug_info["query_result"] = "Success" if profile else "No user found"
            except Exception as e:
                debug_info["errors"].append(f"Query test failed: {type(e).__name__}: {str(e)}")
                debug_info["query_error"] = {
                    "type": type(e).__name__,
                    "message": str(e),
                    "traceback": traceback.format_exc()
                }
    
    except Exception as e:
        debug_info["errors"].append(f"Setup failed: {type(e).__name__}: {str(e)}")
        debug_info["setup_error"] = {
            "type": type(e).__name__,
            "message": str(e),
            "traceback": traceback.format_exc()
        }
    
    return debug_info


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
