# Agent Legion

An open-source AI operating system for software projects. Users create
**missions** (not chats); Legion coordinates agents, security scans, human
approval gates, and deploys through a durable Mission Board.

## Quick start

```bash
docker-compose up -d     # Postgres 16 + pgvector on localhost:5434 (db: legion)
pnpm install             # workspace dependencies
pnpm migrate             # apply SQL migrations
pnpm dev                 # build the board, serve everything on :4242
```

Mission Board: http://localhost:4242

Worker runtime (Milestone 1) additionally needs:

```bash
git submodule update --init        # vendor/hermes-agent @ v2026.6.5
bash scripts/setup-workers.sh      # uv venv (Python 3.11) + hermes install
echo 'OPENROUTER_API_KEY=sk-or-...' >> .env
```

Run everything:

```bash
pnpm test
```

## Architecture

```
apps/daemon       Node 20+, Hono — REST API + serves the board on :4242
apps/board        React 18 + Vite — the Mission Board UI
packages/core     pure mission domain logic (state machine), zero IO
packages/db       Postgres access, raw SQL migrations (no ORM)
packages/runtime  Hermes worker supervisor (M1)
vendor/hermes-agent  vendored NousResearch/hermes-agent, pinned @ v2026.6.5
```

### Mission lifecycle

```
                      PLAN_REJECTED
                    ┌───────────────┐
                    ▼               │
DRAFT ──► PLANNING ──► AWAITING_PLAN_APPROVAL ──► BUILDING ──► SCANNING ──► AWAITING_MERGE_APPROVAL ──► MERGED
  │PLANNING_ │PLAN_PROPOSED   │PLAN_APPROVED   │BUILD_      │SCAN_PASSED   │MERGE_APPROVED
  │STARTED   │                │                │COMPLETED   │              │
  │          │                │                │            │SCAN_FAILED   │MERGE_REJECTED
  │          │                │                │            ▼              ▼
  └──────────┴────────────────┴── MISSION_FAILED / MISSION_CANCELLED ──► FAILED / CANCELLED
                                  (from any non-terminal state)
```

`BUILD_STARTED` and `SCAN_STARTED` are self-transitions inside BUILDING and
SCANNING. Terminal states: MERGED, FAILED, CANCELLED.

### Why event sourcing

Missions are never stored as mutable rows. Every change is an append-only
event in `mission_events` (gapless per-mission `seq`, bitemporal
`valid_from`/`recorded_at` at microsecond precision); current state is always
derived by folding the log through the typed state machine in
`packages/core`. This gives us a complete audit trail for free (who did what,
when, in what order), makes illegal transitions structurally impossible to
persist, lets us answer "what did this mission look like at time T" exactly
(`GET /api/missions/:id/state?asOf=`), and survives restarts, crashes, and
handoffs without any reconciliation logic for mission state itself.

## Worker runtime (Milestone 1)

Legion spawns real [Hermes Agent](https://github.com/NousResearch/hermes-agent)
workers as supervised child processes — one OS process per worker.

- **Launcher.** `packages/runtime/python/worker_main.py` drives the vendored
  Hermes programmatically (`AIAgent` from `run_agent`) in non-interactive
  single-task mode and emits one JSON object per line for every meaningful
  unit: model messages, tool calls, tool results, agent status. Vendored code
  is never modified.
- **Trajectory capture.** The supervisor parses that stream as it arrives and
  appends to `worker_events` (gapless per-worker `seq`, microsecond UTC
  timestamps as text). Worker activity is purely observational in M1 —
  `mission_events` and the mission state machine are untouched.
- **Isolation.** Each worker runs in a fresh
  `~/.legion/workdirs/<missionId>/<workerId>/` with `HOME` pointed at it and a
  minimal env allowlist (`PATH`, `HOME`, `TMPDIR`, `PYTHONPATH`,
  `OPENROUTER_API_KEY`, `LEGION_*`). The parent environment is not inherited;
  workers cannot see `DATABASE_URL`.
- **Lifecycle.** Status is derived from the worker's event log:
  STARTING → RUNNING → EXITED | KILLED | FAILED. Graceful stop is SIGTERM,
  then SIGKILL after 10s; hard stop is immediate SIGKILL of the process
  group. Crashes record `WORKER_FAILED` with exit code and last stderr; no
  auto-restart. Hard timeout defaults to 10 minutes (configurable per
  worker). On boot the supervisor marks orphaned RUNNING workers as
  FAILED/ORPHANED.

### Worker API

```
POST /api/missions/:id/workers   {role, task}      → spawn, 201 {worker}
GET  /api/missions/:id/workers                     → {workers} with status
POST /api/workers/:id/stop       {graceful}        → 200 | 409 if not running
GET  /api/workers/:id/events                       → {events} ordered by seq
```

### Default model

`openai/gpt-oss-120b` via OpenRouter. Rationale: it is one of the cheapest
hosted models with dependable function calling (~$0.04/M input, ~$0.18/M
output as of June 2026), it is fast, widely served (no single-provider
outage risk), and open-weight, which fits Legion's open-source posture.
Override per supervisor via `WorkerSupervisor({pool, model})`.

### Running the M1 tests

```bash
docker-compose up -d && pnpm migrate
bash scripts/setup-workers.sh          # idempotent; also exercised by T9
# OPENROUTER_API_KEY must be in the repo-root .env — tests FAIL (never skip)
# without it, by design.
pnpm test
```

The integration tests spawn real Hermes workers against the real OpenRouter
model — no mocks, no fakes. **Expected API cost per full test run:** five
worker spawns on `gpt-oss-120b`, each 1–3 model calls on a trivial task
(~15k input / ~1k output tokens) ≈ **$0.005 total**; budget $0.05 for
headroom.

## Tests

| Suite | What it proves |
| --- | --- |
| `packages/core` | T2–T5 at fold level: state machine, illegal transitions, rejection loop |
| `packages/db` | T1 migrations + schema, T2 creation, T7 concurrency (gapless seq, retryable conflicts) |
| `apps/daemon` | T2–T6, T8 over HTTP incl. microsecond bitemporal reads; T15 worker API round-trip |
| `packages/runtime` | T9 venv provisioning, T10 real trajectory, T11 env isolation, T12 hard kill, T13 timeout, T14 orphan reconciliation |
