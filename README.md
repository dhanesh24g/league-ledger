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
