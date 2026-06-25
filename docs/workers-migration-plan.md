# Migration Plan: GitHub Pages + JSON files → Cloudflare Workers + D1

## Why

- GitHub API as a database is fragile and rate-limited
- No backend means CORS issues with third-party APIs (HelloClub sync broken)
- Admin auth relies on an encrypted PAT in a public repo
- Staging/prod data separation is a git merge-driver hack
- No real query capability over historical session data

---

## Target stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Cloudflare Pages | Native GitHub integration, replaces GitHub Pages |
| API | Cloudflare Worker (TypeScript, Hono) | Single Worker with route-based handlers |
| Database | Cloudflare D1 (SQLite) | Two databases: prod and staging |
| Auth | Google Sign-In + Worker-issued JWT | See Auth section |
| HelloClub proxy | Same Worker | Key stored as Worker secret, solves CORS |

Everything within free tiers. No custom domain (workers.dev + pages.dev URLs).

---

## Database schema

```sql
clubs (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  short_name   TEXT,
  config       TEXT NOT NULL  -- JSON: { timezone, hcSubdomain, hcClubId, minBoxSize, maxBoxSize, setsPerMatch }
)

players (
  id           INTEGER PRIMARY KEY,
  club_id      INTEGER NOT NULL REFERENCES clubs(id),
  name         TEXT NOT NULL,
  current_rank INTEGER NOT NULL,  -- maintained denormalised column, kept in sync on every rank-affecting write
  archived_at  TEXT               -- ISO date string; NULL = active
)

sessions (
  id           INTEGER PRIMARY KEY,
  club_id      INTEGER NOT NULL REFERENCES clubs(id),
  date         TEXT NOT NULL,     -- YYYY-MM-DD
  status       TEXT NOT NULL,     -- 'attendance' | 'boxes_assigned' | 'in_progress' | 'closed'
  created_at   TEXT NOT NULL,
  closed_at    TEXT
)

session_lb (
  session_id   INTEGER NOT NULL REFERENCES sessions(id),
  player_id    INTEGER NOT NULL REFERENCES players(id),
  rank_position INTEGER NOT NULL,
  snapshot     TEXT NOT NULL,     -- 'before' | 'after'
  PRIMARY KEY (session_id, player_id, snapshot)
)

attendees (
  session_id   INTEGER NOT NULL REFERENCES sessions(id),
  player_id    INTEGER NOT NULL REFERENCES players(id),
  PRIMARY KEY (session_id, player_id)
)

boxes (
  id           INTEGER PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES sessions(id),
  box_number   INTEGER NOT NULL
)

box_players (
  box_id       INTEGER NOT NULL REFERENCES boxes(id),
  player_id    INTEGER NOT NULL REFERENCES players(id),
  position     INTEGER NOT NULL,  -- 0-indexed; determines pairing per PAIRINGS_4/PAIRINGS_5 constants
  PRIMARY KEY (box_id, player_id)
)

matches (
  id           INTEGER PRIMARY KEY,
  box_id       INTEGER NOT NULL REFERENCES boxes(id),
  match_number INTEGER NOT NULL   -- 0-indexed; pairing layout derived from box size + match_number in code
)

match_sets (
  match_id     INTEGER NOT NULL REFERENCES matches(id),
  set_number   INTEGER NOT NULL,  -- 0, 1, 2
  score_a      INTEGER,           -- NULL = not yet entered
  score_b      INTEGER,
  PRIMARY KEY (match_id, set_number)
)

club_admins (
  club_id      INTEGER NOT NULL REFERENCES clubs(id),
  email        TEXT NOT NULL,
  role         TEXT NOT NULL,     -- 'owner' | 'admin'
  PRIMARY KEY (club_id, email)
)
```

### Key decisions

- **`current_rank` is denormalised** on `players` and kept in sync by every write that affects rank order. Deriving it from session snapshots on every read adds joins for no benefit.
- **No JSON blobs** except `clubs.config`, which is a pure property bag never queried field-by-field.
- **Pairing layout** (which positions play which in each match) is a code constant (PAIRINGS_4 / PAIRINGS_5), not stored in the DB. It is deterministic from box size + match_number.
- **`club_id` on every table** from day one. Multi-club is then additive — no schema migrations needed, just new rows.
- All existing scoring/standing algorithms stay client-side. The Worker assembles normalised rows into the shape the frontend already expects.

---

## Adding a new player mid-session

When a new player shows up and needs to be added to the ladder, the Worker runs a single D1 transaction:

1. `UPDATE players SET current_rank = current_rank + 1 WHERE club_id = ? AND current_rank >= :insertRank AND archived_at IS NULL`
2. `INSERT INTO players (club_id, name, current_rank) VALUES (?, ?, :insertRank)`
3. `UPDATE session_lb SET rank_position = rank_position + 1 WHERE session_id = ? AND snapshot = 'before' AND rank_position >= :insertRank`
4. `INSERT INTO session_lb (session_id, player_id, rank_position, snapshot) VALUES (?, :newId, :insertRank, 'before')`
5. `INSERT INTO attendees (session_id, player_id) VALUES (?, :newId)`

If boxes have already been assigned, the transaction also deletes `boxes`, `box_players`, `matches`, and `match_sets` for the session (same "attendance changed — boxes cleared" behaviour as today).

---

## Worker API (Hono, TypeScript)

```
GET  /api/config                    → club config JSON
GET  /api/leaderboard               → ranked player list
GET  /api/sessions                  → list of { date, status }
GET  /api/sessions/:date            → full session (boxes, matches, sets, leaderboard snapshots)
POST /api/sessions                  → create session                [admin]
PUT  /api/sessions/:date/attendance → toggle attendee               [admin]
PUT  /api/sessions/:date/boxes      → assign boxes                  [admin]
PUT  /api/sessions/:date/score      → update a match set score      [admin]
POST /api/sessions/:date/close      → close session, update ranks   [admin]
POST /api/leaderboard/import        → replace full leaderboard      [admin]
POST /api/players                   → add player mid-session        [admin]
POST /api/auth/login                → validate Google ID token → JWT
POST /api/hc/sync                   → proxy HelloClub API calls     [admin]
```

`[admin]` routes require a valid JWT in the `Authorization: Bearer <token>` header. JWT payload: `{ sub: email, club_id, role, exp }`.

---

## Auth

### Mechanism: Google Sign-In + Worker JWT

1. Browser loads Google Identity Services SDK (CDN, no build step needed)
2. User clicks "Sign in with Google" → Google returns a signed ID token (JWT) client-side
3. Browser POSTs the ID token to `POST /api/auth/login`
4. Worker fetches Google's JWKS, validates the token (signature, expiry, audience)
5. Worker checks `club_admins` table for the email
6. Worker issues its own JWT `{ sub: email, club_id, role }` with a configurable expiry
7. Frontend stores the JWT in localStorage, attaches it to every write request

### Why Google Sign-In

- No password management or reset flows
- Every club member has a Google account
- Client-side SDK handles the OAuth flow; no redirect/callback route needed in the Worker
- If a custom domain is added later, Cloudflare Access can be put in front and the JWT validation stays identical

### Roles

| Role | Capabilities |
|---|---|
| `owner` | Everything including adding/removing admins, club config |
| `admin` | Session management, leaderboard import, HC sync |

No scorer role, no kiosk mode (see Kiosk section).

### Multi-club

Each club's admins are rows in `club_admins`. A user whose email appears in multiple clubs gets a JWT listing all their `{ club_id, role }` pairs; the frontend lets them pick which club they're managing.

---

## Kiosk / UX decisions

No dedicated kiosk mode. All write actions require admin login. Typical session-day flow:

1. Admin logs in (Google Sign-In) on the club PC
2. Admin starts the session
3. Players approach the PC and sign themselves in (admin toggles attendance on their behalf, or admin is present)
4. Admin assigns boxes and prints box sheets
5. Players enter their own scores — **this is still an admin-only action in this model**; score entry and closing procedures all require the admin to be logged in
6. Admin runs HC sync and WhatsApp share, closes session

The kiosk angle can be revisited later if it becomes a priority.

---

## Staging environment

- Two separate D1 databases: `ladder-prod` and `ladder-staging`
- Two CF Pages deployments: `main` branch → prod, `staging` branch → staging
- Two Worker deployments: `api` (prod) and `api-staging` (staging)
- Staging Worker binds to `ladder-staging` D1; prod Worker binds to `ladder-prod`

### Data refresh

On every push to `staging`, a GitHub Actions step:
1. `wrangler d1 export ladder-prod --output prod.sql`
2. Wipe `ladder-staging`
3. `wrangler d1 execute ladder-staging --file prod.sql`

Staging always starts with a fresh copy of prod data. If mid-test re-deploy is annoying in practice, add a `workflow_dispatch` manual refresh job alongside the auto-reset.

This replaces the `.gitattributes` custom merge driver entirely — no data lives in the repo.

---

## HelloClub sync

Moves entirely to the Worker. The Worker calls `https://northlandbadminton.helloclub.com/api/...` directly (server-side, no CORS). HC API key and club ID are Worker secrets, never touch the browser or the repo. The `encryptedHCKey` in `config.json` and the browser-side decryption code are removed.

---

## Migration path

1. **Build Worker skeleton** — Hono router, D1 bindings, auth middleware, stub routes
2. **Write D1 schema migrations** — `wrangler d1 migrations`
3. **Write data migration script** — reads current JSON files from GitHub API, inserts into D1
4. **Implement API routes** — one by one, matching the shape the frontend already expects
5. **Rewrite `js/storage.js`** — swap GitHub API calls for `fetch('/api/...')` calls; `js/app.js` stays almost entirely unchanged
6. **Switch hosting** — connect CF Pages to the GitHub repo; disable GitHub Pages deploy workflow
7. **Remove dead code** — `config.json`, `.gitattributes` merge driver, `scripts/encrypt-pat.js`, `js/storage.js` GitHub layer, deploy workflow

Steps 1–4 are backend-only and don't affect the running app. Step 5 is the cutover.

---

## Free tier headroom

| Resource | Limit | Expected usage |
|---|---|---|
| Worker requests | 100k/day | < 500/week for a single club |
| D1 reads | 5M/day | trivially low |
| D1 writes | 100k/day | trivially low |
| D1 storage | 5 GB | years of data = a few MB |
| CF Pages builds | 500/month | a few per week |
| GitHub Actions | unlimited (public repo) | — |

Comfortable for 10+ clubs on a single account.

---

## Deferred / open

- **Multiple clubs**: schema supports it from day one; Worker routing by club (subdomain or JWT claim) to be designed when a second club is onboarded
- **Season statistics**: normalised schema makes these straightforward SQL queries; UI not planned yet
- **Custom domain**: would enable Cloudflare Access as an auth layer upgrade, eliminating the Google JWKS validation code in the Worker
- **Score entry without admin**: explicitly deferred; revisit if the session-day flow proves cumbersome
