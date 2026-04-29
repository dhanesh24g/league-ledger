# League Ledger

League Ledger is a spreadsheet-free fantasy league management app built for private leagues that want a simpler way to run matches, manage members, record winners, track payouts, and keep everyone updated.

Instead of juggling spreadsheets, screenshots, manual payout formulas, and chat messages, League Ledger gives admins and league members a clean workflow: set up the league, invite players, add matches, scan results with AI, confirm winners, view standings, and settle balances with clarity.

## ✨ What Makes It Useful

- 📊 **Spreadsheet-free league operations** - manage league setup, members, matches, winners, ledgers, stats, and settlements from one place.
- 🤖 **AI-assisted result entry** - upload fantasy leaderboard screenshots and let AI extract ranks, names, and points for admin review.
- 🧠 **Smarter future scans** - confirmed screenshot name mappings are remembered so fantasy handles resolve to the right league members over time.
- 👥 **Admin and read-only access** - admins control setup, winners, roles, settlements, and integrations while members can view league data safely.
- 🔐 **Modern authentication** - supports email/password login, Google Sign-In, refresh sessions, and password reset.
- 🔗 **Invite-based onboarding** - players join using league invite links, with admin approval before they become active members.
- 🏏 **Flexible match management** - create matches, select participants, override payout rules, edit match details, and handle match lifecycle states.
- 🏆 **Tie-aware winner payouts** - tied ranks are calculated correctly by combining payout slots and splitting prize amounts fairly.
- 🌧️ **Washout support** - cancelled matches can be marked as washouts with automatic equal refund handling.
- 📈 **Live stats and league insights** - view top earners, rank distribution, match history, player performance, and current-user snapshots.
- 💬 **Telegram updates** - connect a personal chat or league group and send match result updates directly from the winners workflow.
- 💸 **Simple settlement tracking** - see who owes, who is owed, and which players are already settled without maintaining a separate sheet.
- ☁️ **Deployment-ready architecture** - runs locally with SQLite and can be deployed with Supabase, Vercel, or Docker.

## 🎯 Why I Built This

Private fantasy leagues are fun to play but painful to manage. A typical league admin ends up switching between fantasy app screenshots, spreadsheets, calculator formulas, payment notes, and group chat updates.

League Ledger brings that entire workflow into one app. The goal is simple: make league management feel organized, transparent, and fast enough that admins can focus on the league instead of the bookkeeping.

## 🧭 Core Workflows

### 1. 🛠️ League Configuration

Admins can create or update a league with:

- Sport and tournament metadata
- Entry fee and active player count
- Default winner count
- Rank-wise payout ladder
- Automatic invite code and join link

The backend validates that payout ranks are continuous and that the configured payout total matches the expected prize pool.

### 2. 👥 Member Onboarding

League membership is handled through invite links and admin approvals:

- Users sign up with email/password or Google
- Users request to join a league through an invite code
- Admins review pending join requests
- Approved users are synced into the league player list
- Admins can update member roles or remove members

This keeps player management tied to authenticated users instead of loose manual names.

### 3. 🗓️ Match Entry

Admins can create match records with:

- Match title and date
- Selected participants
- Optional match-level winner count
- Optional match-level payout override

This supports real fantasy league scenarios where not every match has the same participants or payout model.

### 4. 🏆 Winner Assignment

Admins can record winners manually or through AI-assisted screenshot scanning.

Manual winner assignment supports searchable player inputs and multiple players per rank for tied outcomes. The service layer calculates payout distribution based on the configured payout slots and validates that result entries are consistent with the league rules.

### 5. 🤖 AI Leaderboard Screenshot Scan

Admins can upload a PNG, JPEG, or WebP leaderboard screenshot from fantasy platforms such as Dream11, My11Circle, MPL, or similar apps.

The AI vision flow:

- Sends the screenshot to the configured OpenAI vision model
- Extracts visible ranks, display names, and points
- Preserves ties where the screenshot shows shared ranks
- Matches extracted names against league players and saved aliases
- Returns suggestions for admin review
- Saves only after explicit admin confirmation

Confirmed aliases are stored in `player_aliases`, making future scans faster and more reliable.

### 6. 🌧️ Washout and Cancellation Handling

If a match is cancelled or washed out, admins can mark it as `Washout / Cancelled`. League Ledger automatically:

- Marks the match as cancelled
- Calculates participant-level refunds
- Splits the match prize pool equally across participants
- Includes refund rows in ledger and stats calculations
- Allows eligible cancelled matches to be reopened

### 7. 💸 Ledger and Settlements

The ledger calculates:

- `Spent`: completed/cancelled match participation count multiplied by entry fee
- `Won`: winner payouts or washout refunds
- `Net`: amount won minus amount spent

The settlements dashboard makes final collection and distribution easier:

- Record money collected from players
- Record money distributed to players
- Track paid date and notes
- Edit or delete payment records
- Calculate remaining balance per player
- Categorize each player as `owes`, `owed`, or `settled`

This keeps the league transparent without asking the admin to maintain a separate settlement spreadsheet.

### 8. 💬 Telegram Match Updates

League Ledger includes a Telegram bot integration for sending match updates to a configured target.

Supported Telegram capabilities:

- Bot token and username configuration through environment variables
- Webhook registration endpoint
- Secure connect sessions with expiring tokens
- Personal chat connection flow
- Group chat connection flow
- Telegram deep links and QR code generation
- Stored league-level Telegram target
- Test messages
- Match update delivery after winners or washout results are recorded

Once connected, admins can send formatted result updates to the league's configured Telegram chat.

### 9. 📈 Stats and Analytics

The stats experience summarizes league activity with:

- Total matches, played matches, and cancelled matches
- Player-level spent, won, net, eligible payout, and finish history
- Rank distribution
- Match-by-match winner summaries
- Top earner and leaderboard-style views
- Current-user focused performance snapshots
- Mobile-friendly drill-down modals

## 🤖 AI Capabilities

League Ledger currently includes two AI-oriented layers.

### 👁️ Active AI Vision

The active AI feature is screenshot-based leaderboard extraction. It is guarded behind feature flags and requires an OpenAI API key.

Environment variables:

```bash
AI_VISION_ENABLED=1
OPENAI_API_KEY=sk-...
AI_VISION_MODEL=gpt-4o-mini
```

`AI_VISION_MODEL` is optional and defaults to `gpt-4o-mini`.

### 📝 AI Summary and Insight Foundation

The backend also includes structured modules for match result summaries, washout summaries, stats insight prompts, and ledger insight prompts under `server/ai/`. These provide a clean foundation for AI-generated commentary, match recaps, and league insights while keeping the current business logic deterministic and auditable.

## 🔐 Authentication and Access Control

League Ledger includes:

- 🔑 Password-based signup and login
- 🧂 PBKDF2 password hashing
- 🔁 Access tokens and refresh tokens
- ⏱️ Configurable token TTLs
- 🟦 Google ID token verification
- 🔗 Server-side Google account linking by Google subject or email
- 📩 Password reset tokens with expiry and optional SMTP delivery
- 🛡️ League-scoped active membership checks
- 👑 Admin-only routes for sensitive operations
- 👀 Read-only league member access for non-admin users

Google Sign-In is enabled when a Google Web Client ID is configured.

Supported Google client ID environment variables:

```bash
GOOGLE_CLIENT_ID
GOOGLE_OAUTH_CLIENT_ID
NEXT_PUBLIC_GOOGLE_CLIENT_ID
GOOGLE_WEB_CLIENT_ID
GOOGLE_SIGNIN_CLIENT_ID
GOOGLE_GSI_CLIENT_ID
GOOGLE_IDENTITY_CLIENT_ID
```

## 🧱 Technology Stack

- ⚙️ **Backend:** FastAPI, Pydantic, Uvicorn
- 🗄️ **Database:** SQLite for local development, Supabase/Postgres for production-ready persistence
- 🎨 **Frontend:** Vanilla HTML, CSS, and JavaScript
- 🤖 **AI:** OpenAI vision-compatible chat completions endpoint
- 💬 **Integrations:** Telegram Bot API
- 🚀 **Deployment:** Vercel Python runtime, Docker
- 🧰 **Utilities:** httpx, python-dotenv, python-multipart, segno for QR generation

## 🗂️ Project Structure

```text
league-ledger/
|-- app.py                         # Compatibility entrypoint for deployment
|-- server/
|   |-- main.py                    # FastAPI app wiring, routes, static page serving
|   |-- api.py                     # API route layer
|   |-- auth.py                    # Auth, Google login, tokens, memberships
|   |-- database.py                # SQLite initialization and Supabase selection
|   |-- db.py                      # Database manager helpers
|   |-- service.py                 # Core league, match, ledger, settlement logic
|   |-- supabase_service.py        # Supabase-backed service implementation
|   |-- schemas.py                 # Pydantic request schemas
|   |-- ai/
|   |   |-- vision.py              # AI leaderboard screenshot extraction
|   |   |-- aliases.py             # Name normalization and alias resolution
|   |   |-- summaries.py           # Match and washout summary builders
|   |   `-- insights.py            # Stats and ledger insight prompt builders
|   |-- integrations/
|   |   `-- telegram.py            # Telegram message, webhook, QR, delivery utilities
|   `-- automation/                # Event and notification orchestration scaffolding
|-- static/
|   |-- index.html                 # Main application shell
|   |-- setup.html/js              # League setup workflow
|   |-- players.html/js            # League members and player list
|   |-- matches.html/js            # Match creation and participant selection
|   |-- winners.html/js            # Winner assignment, AI scan, Telegram updates
|   |-- ledger.html/js             # Player ledger
|   |-- expenses.html/js           # Settlements and payment tracking
|   |-- stats.html/js              # Analytics dashboard
|   |-- league-settings.html/js    # Members, roles, aliases, join requests
|   |-- login.html/js              # Login
|   |-- signup.html/js             # Signup and Google-assisted signup
|   `-- styles.css                 # Responsive application styling
|-- requirements.txt
|-- Dockerfile
|-- vercel.json
`-- prototype.db                   # Local SQLite database, created/updated automatically
```

## 🚀 Local Development

```bash
cd /Users/parveenshaikh/Study/AI/Courses/Git-Repo/league-ledger/league-ledger
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --reload --port 8001
```

Open:

```text
http://127.0.0.1:8001
```

Health check:

```text
http://127.0.0.1:8001/health
```

## ⚙️ Environment Variables

### 🧩 Application

```bash
APP_ENV=development
APP_AUTH_ENABLED=true
APP_AUTH_SECRET=replace-with-a-long-random-secret
APP_ACCESS_TOKEN_TTL_SECONDS=3600
APP_REFRESH_TOKEN_TTL_SECONDS=2592000
APP_BASE_URL=http://127.0.0.1:8001
PUBLIC_BASE_URL=http://127.0.0.1:8001
```

### 🗄️ Database

Local development uses SQLite by default.

For Supabase-backed production:

```bash
APP_ENV=production
DATABASE_PROVIDER=supabase
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

### 🔐 Google Auth

```bash
GOOGLE_CLIENT_ID=...
```

Add the local and deployed origins as authorized JavaScript origins in Google Cloud Console.

### 🤖 AI Screenshot Scan

```bash
AI_VISION_ENABLED=1
OPENAI_API_KEY=...
AI_VISION_MODEL=gpt-4o-mini
```

### 💬 Telegram

```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_BOT_USERNAME=...
TELEGRAM_WEBHOOK_SECRET=replace-with-random-secret
TELEGRAM_DEFAULT_CHAT_ID=optional-default-chat
APP_BASE_URL=https://your-deployed-domain.example
```

`APP_BASE_URL` is required for webhook registration because Telegram needs a public HTTPS endpoint.

### 📩 Password Reset Email

```bash
SMTP_HOST=...
SMTP_PORT=587
SMTP_USERNAME=...
SMTP_PASSWORD=...
SMTP_FROM=...
SMTP_USE_TLS=true
```

## 🐳 Docker

Build and run:

```bash
docker build -t league-ledger .
docker run --rm -p 8001:8001 --env-file .env league-ledger
```

Open:

```text
http://localhost:8001
```

## ▲ Vercel Deployment

The repository includes `vercel.json` configured for the Vercel Python runtime:

```json
{
  "version": 2,
  "builds": [
    {
      "src": "app.py",
      "use": "@vercel/python"
    }
  ],
  "routes": [
    {
      "src": "/(.*)",
      "dest": "app.py"
    }
  ]
}
```

For production deployment, configure the required environment variables in Vercel, especially Supabase, auth secret, Google client ID, OpenAI key, and Telegram settings.

## 🔌 Key API Areas

- 🔐 `/api/auth/*` - signup, login, Google login, refresh, password reset, current user
- 🛠️ `/api/league` - league configuration
- 🔗 `/api/leagues/invite/{invite_code}` - invite preview
- 👥 `/api/auth/join-request` - request league membership
- ✅ `/api/league/requests/*` - approve, reject, and cancel join requests
- 👑 `/api/league/members/*` - member listing, role updates, and removal
- 🗓️ `/api/matches` - match creation
- ✏️ `/api/matches/{match_id}` - match updates
- 🏆 `/api/matches/{match_id}/winners` - winner assignment and saved winners
- 🤖 `/api/matches/{match_id}/winners/extract` - AI screenshot extraction
- 🧠 `/api/player-aliases/*` - screenshot alias management
- 🌧️ `/api/matches/{match_id}/cancel` - washout/cancel flow
- 🔄 `/api/matches/{match_id}/reopen` - reopen cancelled match
- 📒 `/api/ledger` - admin ledger
- 💸 `/api/settlements` - settlement summary and payment records
- 📈 `/api/stats` - analytics data
- 💬 `/api/integrations/telegram/*` - Telegram status, connect session, webhook, test message, and match updates

## 🧾 Data Model Overview

League Ledger stores the operational state across:

- `users`
- `league`
- `league_memberships`
- `league_join_requests`
- `players`
- `matches`
- `winner_entries`
- `player_aliases`
- `settlement_payments`
- `password_reset_tokens`
- `league_integrations`
- `telegram_link_sessions`

SQLite tables are created and migrated automatically on startup for local development. Supabase schema management is expected to be handled externally for production.

## ✅ Validation and Business Rules

- ✅ League payout totals must match the prize pool
- ✅ Payout ranks must start at 1 and remain continuous
- ✅ Manual player creation is disabled in favor of authenticated invite-based membership
- ✅ Only admins can create matches, update winners, manage roles, record settlements, and configure integrations
- ✅ Winner payout calculation handles ties by pooling the relevant rank slots and splitting the total among tied winners
- ✅ Cancelled matches use equal refund distribution rather than standard winner payouts
- ✅ AI screenshot extraction never writes winners directly; admins must confirm before ledger-impacting changes are saved

## 🎬 Recommended Demo Flow

1. 🛠️ Create a league with entry fee, active player count, and payout ladder.
2. 🔗 Share the invite link with users.
3. ✅ Approve join requests from league settings.
4. 🗓️ Create a match and select participants.
5. 🤖 Upload a leaderboard screenshot on the winners page or assign winners manually.
6. 🏆 Confirm winners and save the result.
7. 💬 Send the match update to Telegram.
8. 📈 Review stats and ledger impact.
9. 💸 Record collected/distributed settlement payments.
10. 🎉 Confirm final player balances in the settlements dashboard.

## 📄 License

This project is licensed under the MIT License. See `LICENSE` for details.
