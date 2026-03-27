# League Ledger (Prototype)

Python + FastAPI MVP to manage offline fantasy league money settlement.

## What this prototype supports

- League setup (name, tournament, entry fee, default winner count)
- Rank payout configuration (JSON map like rank -> amount)
- Manual player name entry
- Manual match entry
- Rank-wise winner selection (multiple winners per rank)
- Auto split of rank payout among tied winners
- Live ledger per player: spent, won, net

## Tech stack

- FastAPI (backend + APIs)
- SQLite (local persistence)
- Vanilla HTML/CSS/JS (frontend)

## Project structure

- `app.py` - FastAPI app and API endpoints
- `static/index.html` - UI
- `static/app.js` - Frontend logic
- `static/styles.css` - Styling
- `prototype.db` - Created on first run (local SQLite DB)

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

1. League setup
   - Enter league name, entry fee, winner count, and payouts JSON.
   - Example payouts JSON: `{"1":500,"2":300,"3":150,"4":50}`

2. Add players
   - Add 5-10 names manually.

3. Add matches
   - Add a match title and date.
   - Optionally override winner count and payouts for a match.

4. Choose winners
   - Select a match from dropdown.
   - Click `Load Ranks`.
   - For each rank, check one or more winners.
   - Click `Save Winners`.

5. Verify ledger
   - `Spent` should be: completed matches * entry fee.
   - `Won` should be: sum of split payouts from winner entries.
   - `Net` should be: won - spent.

## Current limitations (expected)

- No auth/roles yet (single-admin style usage)
- Manual match creation (no external sports API yet)
- No payment tracking status yet (settled/pending)

## Next planned iteration

- Auth + league-level admin/member roles
- API-based match import by tournament/date
- Settlement workflow (paid/unpaid)
- Export reports (CSV)
