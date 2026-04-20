# League Ledger

Python + FastAPI MVP to manage offline fantasy league money settlement.

## What this prototype supports

- League setup (name, tournament, entry fee, active player count)
- Winner payout builder with auto rank labels and live prize-pool validation
- Manual player management
- Manual match management with optional match-level payout overrides
- Winner assignment with searchable inputs
- Tie-aware payout logic (shared ranks consume combined payout slots)
- Washout/cancel flow with equal refund distribution across all players
- Live ledger per player: spent, won, net

## Tech stack

- FastAPI (backend + APIs)
- SQLite (local persistence)
- Vanilla HTML/CSS/JS (frontend)

## Project structure

- `app.py` - compatibility entrypoint (imports the FastAPI app)
- `server/main.py` - FastAPI app wiring (startup, static mount, routers)
- `server/api.py` - API route layer
- `server/service.py` - business logic and DB operations
- `server/schemas.py` - request payload schemas
- `server/db.py` - SQLite connection, migration/init, helpers
- `server/ai/` - future AI prompt and summary scaffolding
- `server/automation/` - future event + notification orchestration scaffolding
- `server/integrations/` - future external delivery integrations such as Telegram
- `static/index.html` - UI shell
- `static/app.js` - frontend logic
- `static/styles.css` - styling
- `prototype.db` - local SQLite database (created automatically)

## Run locally

```bash
cd /Users/parveenshaikh/Study/AI/Courses/Git-Repo/league-ledger/league-ledger
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --reload --port 8001
```

Open in browser:

`http://127.0.0.1:8001`

## Run with Docker

### Prerequisites
- Docker installed on your machine
- Docker Compose installed

### Build and run

```bash
cd /Users/parveenshaikh/Study/AI/Courses/Git-Repo/league-ledger/league-ledger
docker-compose up --build
```

The app will be available at: `http://localhost:8001`

### Docker commands

```bash
# Build and start containers
docker-compose up --build

# Run in background
docker-compose up -d

# Stop containers
docker-compose down

# View logs
docker-compose logs -f

# Rebuild after code changes
docker-compose up --build
```

### Environment variables (optional)

To use Supabase or Google Auth with Docker, add your credentials to `docker-compose.yml`:

```yaml
environment:
  SUPABASE_URL: your_supabase_url
  SUPABASE_SERVICE_ROLE_KEY: your_supabase_key
  GOOGLE_CLIENT_ID: your_google_client_id
```

## Google Auth Setup

Google sign-in and Google-assisted signup are already wired in the app, but they stay disabled until a Google Web client ID is configured.

Set one of these environment variables:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_ID`
- `NEXT_PUBLIC_GOOGLE_CLIENT_ID`
- `GOOGLE_WEB_CLIENT_ID`
- `GOOGLE_SIGNIN_CLIENT_ID`
- `GOOGLE_GSI_CLIENT_ID`
- `GOOGLE_IDENTITY_CLIENT_ID`

Recommended setup:

1. Create a Google OAuth Web application in Google Cloud Console.
2. Add your deployed domain and local dev origin as authorized JavaScript origins.
3. Add the client ID to Vercel for:
   - `Production`
   - `Preview`
   - `Development`
4. Add the same client ID locally in `.env` if you want to test Google auth on your machine.

This app verifies the Google ID token server-side and links returning users by `google_sub` or email. No separate Google client secret is required for the current frontend-driven sign-in flow.

## Quick validation flow

1. Setup league
   - Set entry fee, active player count, and default winner payouts.
   - Ensure total payout matches prize pool.

2. Add players
   - Player can join using the invitation link shared to them, provided the admin accepts their league joining request.

3. Add match
   - Add title/date.
   - Optionally enable override settings.

4. Record result
   - Use `Start Assignment` for normal results and set winners rank-wise.
   - Use `Washout / Cancelled` for canceled matches (equal refund handling).

5. Verify ledger
   - `Spent` = number of completed/canceled matches × entry fee.
   - `Won` = payout entries (winner split or cancellation refund).
   - `Net` = won - spent.

## Current limitations

- No authentication/authorization yet
- Manual match entry only
- No settlement payment-status workflow yet

## Next iteration ideas

- Auth + league-level roles
- API-based match import
- Settlement tracking (paid/unpaid)
- Export reports (CSV)
