# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Pace Rise Competition OS — a Korean track-and-field (athletics) competition operation system. Single Node.js/Express server backed by SQLite (or PostgreSQL), serving a set of static HTML/JS pages for judges, call-room staff, scoreboard operators, broadcast overlays, and admins. Multi-competition, real-time (WebSocket) scoreboard. Comments and docs are predominantly in Korean — match that when editing.

## Commands

```bash
npm start            # run server (node server.js) → http://localhost:3000
npm run dev          # same as start
npm test             # vitest run — full suite, runs serially
npm run test:watch   # vitest watch mode
npm run test:coverage

# Run a single test file or pattern:
npx vitest run tests/api/02_competitions.test.js
npx vitest run -t "some test name substring"
TEST_VERBOSE=1 npx vitest run <file>   # un-mute server boot logs for debugging
```

There is no lint/format/build step — it's plain CommonJS, run directly with `node`.

Deploy (production EC2, PM2 app named `pacerise`): `./scripts/deploy.sh [branch]`. It refuses a dirty tree, pulls, runs `npm ci --omit=dev` only if `package.json` changed, PM2-restarts, polls `/api/health`, and auto-rolls-back on failure.

## Tests are DB-isolated — never touch the production DB

`tests/setup/global-setup.js` injects `SQLITE_PATH` pointing at a fresh `mkdtemp` temp file and forces `DB_BACKEND=sqlite` per run, so tests never hit the operational `db/competition.db` (which holds real competition data). When adding tests, rely on this isolation; never hardcode a DB path. `vitest.config.js` forces a single fork / serial execution (`fileParallelism: false`) to avoid SQLite lock contention. server.js skips `listen()` under tests via a `require.main !== module` guard, exporting the Express `app` for supertest.

## Architecture

### server.js is the monolith (~755KB, ~13k lines)
It owns: boot self-check, all middleware, the DB handle, ~30 shared helper functions, the WebSocket server, and most routes. It is being **incrementally decomposed** into `lib/routes/*` — do not assume a route lives in a module; many are still inline in server.js. Check `docs/MODULARIZATION_PROGRESS.md` for status and the extraction conventions before moving routes.

### Route modules use a factory pattern with explicit dependency injection
Extracted route files export `module.exports = function mount<Domain>Routes(app, deps)` and are wired in server.js like:
```js
require('./lib/routes/results')(app, { db, isAdminKey, isOperationKey, opLog, broadcastSSE, calcWAPoints, requireAdminAfterCompEnd });
```
`deps` passes server.js's shared helpers and the db handle by reference so behavior is identical to the inline version. When extracting a route: keep registration order (prefix routes like `/api/x/foo` must register before `/api/x/:id`), preserve `db.transaction(async () => {...})()` call shapes, and don't change `opLog` message formats. Each extraction must keep `npm test` green.

### Database abstraction layer — `lib/db.js`
A single adapter exposes a unified interface over **two backends**, selected by `DB_BACKEND` (`sqlite` default, or `postgres`):
- SQLite (`better-sqlite3`) is **synchronous**; PostgreSQL (`pg`) is **asynchronous**.
- Unified API: `db.get / db.all / db.run / db.exec / db.transaction(fn) / db.prepare / db.pragma / db.close`, plus `db.isAsync` and `db.getBackendName()`.
- The PG adapter auto-translates SQL: `?` → `$1,$2,…`, `INSERT OR IGNORE/REPLACE` → `ON CONFLICT`, `datetime('now')` → `NOW()`, `strftime` → `TO_CHAR`, and adds `RETURNING id` when a `lastInsertRowid` is needed.

**Critical implication:** because the same code path must run under both a sync and an async backend, all query call sites are written with `await`, and code must avoid SQLite-only / PG-only SQL. When writing SQL that differs by backend, branch on `db.isAsync` (see `orderByBibSql()` in server.js for the canonical example — `CAST(... AS INTEGER)` on SQLite vs `regexp_replace + NUMERIC` on PG). Schemas: `db/schema.sql` (SQLite) and `db/schema.pg.sql` (PostgreSQL) must be kept in sync. A new SQLite DB is auto-initialized + seeded from `db/seed_clean.sql` on first run.

### Authentication — two coexisting systems
1. **Legacy access keys** (still primary for most routes): role is derived from a key string via helpers in server.js — `isAdminKey`, `isOperationKey`, `isRecordOfficerKey`, `isAdminOrManager`, `getKeyRole`, `getJudgeName`. Keys arrive via `?key=`, `body.admin_key/operation_key`, or `x-admin-key`. The admin key is bcrypt-hashed (`ACCESS_KEYS.adminHash`); operation keys are cached in `_opKeyCache`. Tiers: viewer / operation / record_officer / manager / admin.
2. **JWT** (`lib/auth/jwt.js`, `lib/auth/middleware.js`): `attachUser()` builds a unified `req.user` (JWT first, legacy key fallback). Being adopted gradually; not yet on every route.

When adding protected routes, follow the pattern of the surrounding routes in that domain rather than mixing the two schemes arbitrarily.

### Post-competition lock
Many write routes are gated by `requireAdminAfterCompEnd()` / `isCompetitionEnded()`: once a competition's `status='completed'` (or `end_date` passed with no explicit status), non-admins are blocked from mutations. Preserve this when touching write paths.

### Real-time & side effects
- WebSocket server at `/ws/scoreboard` pushes live scoreboard/overlay updates; `broadcastSSE` / WS broadcasts fire after result writes. The critical hot path is **judge record entry** (`record.html` → `POST /api/results`) which has concurrent-write risk — SQLite uses `busy_timeout` as mitigation; this flow is the priority target for the async/PG migration.
- `opLog(message, category, performedBy, compId)` writes to the operation log (surfaced in `oplog.html`). Treat its message format as a stable contract.

### Document generation
PDF/Excel output lives in `lib/` (not routes): `fullRecordExcel.js`, `fullRecordPdf.js`, `certificatePdf.js`, `comprehensiveByDivision.js`, plus `smsSender.js` for SMS. These use `exceljs`/`pdfkit`/`canvas` and contain large layout functions.

### Frontend
Static pages in `public/` (no framework, no bundler) — `record.html`+`record.js` (judge entry, core), `callroom.*`, `dashboard.*`, `monitor.html` / `overlay-*.html` (scoreboard & broadcast), `admin.html`, `results.*`. A service worker (`sw.js`) + `manifest.json` make it a PWA.

## Reference docs
- `docs/SYSTEM_MAP.md` — full system diagram, route groups, critical data flows.
- `docs/MODULARIZATION_PROGRESS.md` — server.js decomposition plan & safety rules.
- `docs/EXTERNAL_API.md`, `SCOREBOARD_API_GUIDE.md`, `FIELD_EVENT_GUIDE.md` — API/feature references.
- `db/schema.sql` / `db/schema.pg.sql` — table definitions (30+ tables).
