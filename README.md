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
bash scripts/setup-scanners.sh     # gitleaks 8.30.1 + semgrep 1.165.0 (M4)
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
packages/orchestrator  planning + build + scan flows (M2–M4)
packages/scanner  gitleaks + semgrep SARIF scan engine (M4)
legion-rules      in-repo semgrep house rules (Legion source, M4)
                  WebAuthn approval + merge execution live in orchestrator/daemon (M5)
vendor/hermes-agent  vendored NousResearch/hermes-agent, pinned @ v2026.6.5
```

### Mission lifecycle

```
                      PLAN_REJECTED                         SCAN_FAILED (M4: rework)
                    ┌───────────────┐                    ┌──────────────────────┐
                    ▼               │                    ▼                      │
DRAFT ──► PLANNING ──► AWAITING_PLAN_APPROVAL ──► BUILDING ──► SCANNING ──► AWAITING_MERGE_APPROVAL ──► MERGED
  │PLANNING_ │PLAN_PROPOSED   │PLAN_APPROVED   │BUILD_      │SCAN_PASSED   │MERGE_APPROVED
  │STARTED   │                │                │COMPLETED   │              │
  │          │                │   MERGE_REJECTED (M5: rework) ┘            │
  │          │                │                │            │              │
  └──────────┴────────────────┴── MISSION_FAILED / MISSION_CANCELLED ──► FAILED / CANCELLED
                                  (from any non-terminal state)
```

`BUILD_STARTED` and `SCAN_STARTED` are self-transitions inside BUILDING and
SCANNING. **M4 amendment**: `SCAN_FAILED` routes `SCANNING → BUILDING` for
rework. **M5 amendment**: `MERGE_REJECTED` routes
`AWAITING_MERGE_APPROVAL → BUILDING` for rework. After both amendments,
`MISSION_FAILED`/`MISSION_CANCELLED` are the only terminal-failure routes.
Terminal states: MERGED, FAILED, CANCELLED.

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

## Planning loop (Milestone 2)

A planner agent reads a real repository, produces a structured plan, and the
plan flows through the mission state machine's approval gate.

- **Plan contract.** `Plan` is a zod schema in `packages/core`: a one-paragraph
  `summary`, ≥1 `steps` (each with `n`, `title`, `detail`,
  `filesLikelyTouched`), `risks` with low/medium/high severity,
  `openQuestions`, and an `estimatedComplexity` of
  trivial/small/medium/large. The planner is instructed to write `plan.json`
  (schema embedded in its task prompt) at its workdir root.
- **Isolation.** The planner never touches the user's repository. The
  orchestrator (`packages/orchestrator`) runs
  `git clone --depth 1 file://<repoPath>` into the worker's isolated workdir
  and the planner works on the clone. No git credentials, no remote access.
- **Outcome handling.** On `WORKER_EXITED(0)` the orchestrator validates
  `plan.json` against the schema. Valid → `PLAN_PROPOSED {plan}` lands on
  `mission_events` (state → AWAITING_PLAN_APPROVAL). Missing/invalid →
  the attempt failed: the mission stays PLANNING and the zod issues are
  recorded in `worker_events` as `PLAN_INVALID`; no mission event. Crashes
  and timeouts likewise leave the mission in PLANNING.
- **Prompt-feedback loop on rejection.** `PLAN_REJECTED {reason}` returns the
  mission to PLANNING. The next attempt's prompt embeds the prior plan's
  summary and the rejection reason ("previous plan was rejected because: …").
  Every prompt is recorded verbatim in `worker_events` as `WORKER_TASK`, so
  the loop is auditable and testable.
- **Concurrency guard.** One live planner per mission — a second
  `POST /plan` while one is running returns 409.
- **Model.** The planner uses the M1 default (`openai/gpt-oss-120b`);
  override per role with the `LEGION_MODEL_PLANNER` env var (no UI).

### Planning API

```
POST /api/missions/:id/plan          → start attempt (202; 409 unless DRAFT/PLANNING)
POST /api/missions/:id/plan/approve  → PLAN_APPROVED (→ BUILDING; 409 otherwise)
POST /api/missions/:id/plan/reject   {reason} → PLAN_REJECTED (→ PLANNING)
```

## Build loop (Milestone 3)

A coder agent implements the approved plan on a branch in an isolated
workspace, a reviewer agent reviews the diff, and the result is a durable
diff artifact. The user's repository is never written — merge is M5.

- **Workspace/attempt model.** Each `POST /build` creates
  `~/.legion/builds/<missionId>/attempt-<n>/repo`: a full local clone
  (file:// only, no credentials) with the `origin` remote removed so a push
  back to the user's repo is structurally impossible, on a fresh branch
  `legion/<missionId-short>`. The coder works only there. Failed attempt
  workspaces persist on disk for inspection.
- **Coder contract.** The coder's prompt embeds the approved plan (steps,
  files, risks) and requires real git commits — one per plan step where
  sensible, messages referencing step numbers. Identity comes from
  `GIT_AUTHOR/COMMITTER` env ("Legion Coder <coder@legion.local>") on top of
  the M1 allowlist. `HOME` points at the attempt dir so agent state never
  dirties the worktree. Default coder model: `qwen/qwen3-coder`
  (purpose-built for agentic coding — `gpt-oss-120b` reliably reads but
  often stops without acting on multi-step coding tasks); override with
  `LEGION_MODEL_CODER`.
- **Review loop.** A second worker (role `reviewer`, `LEGION_MODEL_REVIEWER`,
  default = planner default) receives plan + diff + commit list and writes
  `review.json` (zod `Review` schema in core). `request_changes` → one more
  coder cycle on the same branch with the comments embedded in its prompt
  (recorded as `WORKER_TASK`). Max 2 coder cycles per attempt; still
  rejected → `BUILD_ATTEMPT_FAILED` in worker_events, mission stays
  BUILDING, and the next attempt's coder prompt references the failed
  review summary. Empty diffs fail fast (`EMPTY_DIFF`) without burning a
  review cycle. Planner and reviewer file-output runs get one deterministic
  retry per attempt (the failed run keeps its `PLAN_INVALID`/`REVIEW_INVALID`
  record) — real models occasionally answer in chat instead of writing the
  file.
- **Artifacts & integrity.** On approval the orchestrator writes
  `git diff <base>..<branch>` to `~/.legion/artifacts/<missionId>/<id>.diff`,
  stores `{files, insertions, deletions, commits}` + sha256 in the
  `artifacts` table, and emits `BUILD_COMPLETED {artifactId, sha256, stats,
  reviewSummary}` (never diff bodies) → state SCANNING (parked until M4).
  `GET /api/artifacts/:id` recomputes the hash on every read and returns
  409 INTEGRITY on mismatch.

### Build API

```
POST /api/missions/:id/build      → start attempt (202; 409 unless BUILDING / attempt running)
GET  /api/missions/:id/artifacts  → artifact metadata list
GET  /api/artifacts/:id           → metadata + diff content (integrity-checked)
```

All HTTP boundary schemas are strict: unknown keys — including internal
spawn options like `taskOverride` — are rejected with 400 (T30).

### Updated cost estimate per full test run

M1 worker tests ≈ $0.005 (five trivial spawns). M2 planning ≈ $0.02–0.03
(two real planner runs + short spawns). M3 is multi-agent: T24 runs a real
coder (~10–25 calls on `qwen3-coder`, ≈ $0.01–0.02) plus a real reviewer
(~$0.005); T25/T26 each run 2 coder + 2 reviewer workers but with trivial
forced tasks except one real revision cycle in T25 (≈ $0.01–0.02 combined);
T27–T29 are short-lived spawns. **Total ≈ $0.06–0.10 per `pnpm test`**;
budget $0.25 for headroom (occasional planner/reviewer retries add one
worker run each).

## Security scan stage (Milestone 4)

Every build artifact is scanned before a human is asked to approve a merge.
Legion's scan engine is self-contained — two vendored OSS scanners, no
external/proprietary dependency.

- **Engine** (`packages/scanner`): orchestrates **gitleaks 8.30.1** (secrets,
  release binary) and **semgrep 1.165.0** (code patterns, isolated uv venv).
  `scripts/setup-scanners.sh` installs both into `~/.legion/tools/`
  (idempotent; pinned versions recorded here). Why these two: gitleaks is the
  de-facto secret scanner with native SARIF and full git-history awareness;
  semgrep is the leading open pattern engine with a large community ruleset
  (`p/default`) plus our in-repo `legion-rules/` for deterministic house
  rules. Both are vendored and never modified — gaps go in the report.
- **Invocations** (exact):
  - `gitleaks git --report-format sarif --report-path <tmp> --no-banner --exit-code 1 --log-opts=<base>..HEAD <repo>` — scans the attempt branch's commits over git history, so a secret that was added *and then deleted* still counts.
  - `semgrep scan --sarif --output <tmp> --config p/default --config legion-rules --metrics=off --quiet <repo>` — scans the workspace checkout.
- **Merged SARIF**: both outputs merge into one valid SARIF 2.1.0 document
  (two `runs[]`, tool metadata preserved). Stored via the M3 `artifacts`
  table as type `sarif` with the same sha256 integrity rules (tamper → 409
  on read). `mission_events` carry only the artifact id + counts
  `{errors, warnings, notes}`.
- **Threshold** (`LEGION_SCAN_FAIL_LEVEL`, default `error`): SARIF level
  `error` fails; `warning`/`note` pass but are recorded. Set `warning` to
  fail on warnings too. gitleaks findings are force-mapped to `error` — a
  hardcoded secret is never a warning. **Partial scans never pass**: if one
  scanner succeeds and the other crashes, the attempt fails.
- **Flow**: entering SCANNING (after `BUILD_COMPLETED`) auto-starts the scan
  → `SCAN_STARTED`; both scanners run against the attempt workspace; zero
  error-level findings → `SCAN_PASSED {sarifArtifactId, counts}` →
  AWAITING_MERGE_APPROVAL; otherwise → `SCAN_FAILED {sarifArtifactId, counts}`
  → **BUILDING** (rework). A scanner crash / invalid SARIF / unexpected exit
  → `SCAN_ATTEMPT_FAILED` (stderr tail recorded), mission **stays** SCANNING,
  `POST /scan` retries.
- **Rework loop** (state-machine amendment): `SCAN_FAILED` now transitions
  `SCANNING → BUILDING` (no longer `→ FAILED`). The next build attempt's
  coder prompt embeds the scan findings (rule + file + message), exactly as
  the M2/M3 prompt-feedback loops do. `MISSION_FAILED`/`MISSION_CANCELLED`
  remain the only terminal-failure routes.

### Scan API

```
POST /api/missions/:id/scan  → manual (re)trigger (202; 409 unless SCANNING / scan running)
GET  /api/missions/:id/scan  → latest status, counts by severity, per-tool breakdown, artifact id
```

### Updated cost estimate per full test run

Scans themselves cost nothing (local binaries). The agent spend is unchanged
from M3 except M4 adds several real coder/reviewer builds for its scan
fixtures (clean/secret/warning). **Total ≈ $0.12–0.20 per `pnpm test`**;
budget $0.40 for headroom (planner/coder/reviewer retries under model load).
First `pnpm test` after a fresh checkout also downloads gitleaks + the
semgrep venv via `setup-scanners.sh` (no API cost).

## The human gate (Milestone 5)

A clean-scanned mission is approved with a passkey ceremony cryptographically
bound to the exact artifact bytes — and only then does Legion merge into the
user's repository. This is the launch milestone.

- **WebAuthn**: `@simplewebauthn/server` (daemon) + `@simplewebauthn/browser`
  (board). `localhost:4242` is a secure context; platform authenticator
  (Touch ID) preferred, `rpID = localhost`. Single approver for v0.1.
- **The binding rule (the heart of M5).** The approval challenge is
  `base64url(sha256(missionId | diffArtifactSha256 | sarifArtifactSha256 |
  serverNonce))`. The server recomputes both artifact hashes **from disk** at
  challenge issue *and* again at verification; any mismatch (a byte changed
  between review and click) → **409 INTEGRITY**, the challenge is voided, and
  no merge happens. An approval therefore proves *which bytes* were approved,
  not merely that someone clicked.
- **Single-use + TTL.** Challenges are claimed atomically (`update … where
  used_at is null and expires_at > now()`), so a replayed assertion 409s and
  an expired one (2-minute TTL) 409s. A "no" is signed too: rejection runs the
  same ceremony and is recorded in `approvals`.
- **Merge execution** (only after a verified approval): preconditions checked
  atomically — the user repo working tree must be clean (else
  `MERGE_BLOCKED_DIRTY`, mission stays at the gate). Then
  `git fetch <attemptWorkspace> <legionBranch>` + `git merge --no-ff` with
  message `legion: <title> (M-<short>, approval <id>)`. A conflict aborts
  cleanly (`git merge --abort`), the user repo is verified byte-identical, and
  `MERGE_CONFLICT` is recorded (worker_events-style, not a mission event) while
  the mission stays at the gate. On success — and only after the merge commit
  exists — `MERGE_APPROVED {approvalId, artifactSha256s, mergeCommit}` is
  emitted → MERGED. **Crash reconciliation**: on boot, if a merge commit
  naming an approval exists but its mission isn't MERGED, the event is emitted
  exactly once (idempotent).
- **State amendment**: `MERGE_REJECTED` now routes
  `AWAITING_MERGE_APPROVAL → BUILDING` (rework) carrying `{reason, approvalId}`;
  the next build's coder prompt embeds the rejection reason.
  `MISSION_FAILED`/`MISSION_CANCELLED` remain the only terminal-failure routes.

### Approval API

```
POST /api/auth/approver/register-options   ┐ standard @simplewebauthn registration
POST /api/auth/approver/register           ┘ pair; 409 if an approver exists
POST /api/missions/:id/approval/options     → challenge bound to current artifacts; 409 unless AWAITING_MERGE_APPROVAL
POST /api/missions/:id/approve              → verify ceremony, then merge; 401 bad signature, 409 reused/expired/integrity
POST /api/missions/:id/reject  {reason}     → signed rejection → BUILDING
```

### Testing stance: real protocol, software key store

The acceptance tests use an **in-repo software FIDO2 authenticator**
(`apps/daemon/test/softkey.ts`): a **real ES256 keypair** with **real CBOR
attestation/assertion construction**. The entire `@simplewebauthn` server
verification path runs **unmodified** against it — genuine signatures, genuine
verification. This is the pinned, honest exception to hardware: real protocol,
software key store. **There are no verification bypass flags anywhere in the
code, not even for tests.**

## Task missions: accountable agent work beyond code (Milestone 6a)

Legion's second mission kind. A `task` mission's deliverable is one or more
**files** — research, writing, analysis — instead of a diff. The state machine
and its transition table are **unchanged**; the stages adapt by kind, and the
ledger stays canonical (`BUILD_*`/`MERGE_*` event names are kept — renaming
events would be a ledger-compat break; the UI shows friendlier stage labels).

- **Kind at the boundary** (migration 006):   `MISSION_CREATED` payloads carry
  `kind: 'code' | 'task'` (existing events backfilled to `'code'`; a code
  mission created without `kind` stores its payload unchanged and folding
  defaults absent kind to `'code'`, so every pre-M6a ledger — and its tests —
  is untouched).
  zod enforces the discrimination: code **requires** `repoPath`, task
  **forbids** it; optional `deliverTo` (absolute dir) is task-only, defaulting
  to `~/.legion/deliveries/<missionId>/`.
- **Planning**: the task planner gets the objective only — there is no clone.
  Same Plan schema; `filesLikelyTouched` carries the expected deliverable
  filenames. Same approval/rejection loop, same verbatim-feedback rule.
- **Execution**: a `worker`-role agent runs in an isolated workdir and must
  write its output files (md/txt/csv/json) into `deliverables/`. On exit the
  orchestrator collects them into **one hash-sealed artifact** of type
  `deliverable` — a single file as-is, multiple files as a tar — with the
  per-file manifest (names + sha256) recorded in `BUILD_COMPLETED`. A clean
  exit with an empty `deliverables/` fails the attempt (`EMPTY_DELIVERABLE`,
  mirroring `EMPTY_DIFF`). The reviewer reads the deliverable against the
  plan: same verdict contract, same max-2-cycles rule.
- **Scanning — the pitch**: every deliverable is **gitleaks-scanned before any
  human reads it** (`gitleaks dir` over the deliverables; semgrep is skipped
  for non-code and the per-tool breakdown shows gitleaks alone). Same
  threshold semantics, same SARIF artifact, same `SCAN_FAILED → BUILDING`
  rework with the findings embedded in the next attempt's prompt. An agent
  that pastes an API key into a "research summary" never reaches your eyes.
- **The gate**: identical ceremony. The challenge binds
  `{missionId, deliverableSha256, sarifSha256}` — both recomputed from disk at
  issue *and* verify (T41 semantics). The board renders a deliverable preview
  (markdown rendered, others mono; archives list each file) above the hashes.
- **Delivery**: a verified approval copies the deliverable into `deliverTo`,
  verifies the copy's hashes against the build-time manifest, and **only
  then** emits `MERGE_APPROVED {approvalId, hashes, deliveredTo}` → MERGED.
  Boot reconciliation detects a completed-but-unrecorded delivery by manifest
  hashes in `deliverTo` and emits the event exactly once (T47 semantics).

## Risk-proportional pipelines (Milestone 6b)

`riskLevel` is load-bearing: the pipeline's human checkpoints scale with
declared risk. **The merge gate never scales away — every mission, every risk
level, ends at the passkey ceremony. No bypass exists.**

One policy module (`packages/orchestrator/src/policy.ts`) defines the map,
applied identically to code and task missions:

| Risk | Plan gate | Scan threshold |
| --- | --- | --- |
| `low` | **Auto-approved**: a schema-valid `PLAN_PROPOSED` is immediately followed by `PLAN_APPROVED {autoApproved: true, policy: 'risk:low'}` and the build auto-starts. The reviewer stage is unchanged. | default (`error`) |
| `medium` | Human approval, exactly as before — the literal default. | default (env-configurable) |
| `high` | Human approval, as before. | **forced `warning`** for this mission — warning-level findings block; the env var stays the global default for everyone else |

The ledger records that a gate was waived **by declared policy, never
silently** — auto-approval is the same `PLAN_APPROVED` event with a policy
payload; no new event types, no state-machine changes. `riskLevel` is
immutable after creation: any event payload carrying one is rejected with 400.
On a low-risk mission a human still disposes — by cancelling, or by letting
the work reach the merge gate and rejecting there with a signed ceremony
(the rework loop carries the reason as always).

## Full-capability open missions (Milestone 8)

Open missions graduate from read-only research into **full task execution**.
The open worker now runs the **complete vendored Hermes core toolset** —
terminal, `execute_code`, file read/write/patch, browser, web search/extract,
todo, delegation — and **loops with the native agent runtime until the task is
actually done** (raised iteration budget + timeout), not a single-shot report.
The deliverable is whatever the agent produced (files in its workspace, plus
its final summary), sealed, scanned, and passkey-gated like any other.

**No credentials required to launch.** The execution toolset (terminal, code,
browser, files, web) needs zero user accounts. Consequential connectors
(post-to-X, send-email, spend) are explicitly **not** in this milestone — they
are a later connector milestone, behind the gate.

### Terminal backend (mirrors Hermes)

`LEGION_TERMINAL_BACKEND = docker | local` (default **docker**). We don't
rewrite tools — we bind the vendored runtime's own backend by setting its
`TERMINAL_*` env, then drive it through our launcher.

- **docker** (recommended): one **hardened, persistent container per mission**
  for the worker's whole run — packages, cwd, and files carry across tool
  calls (Hermes's model). Hermes-grade hardening: `--cap-drop ALL` (with the
  three narrow file-ownership caps Hermes adds back), `--security-opt
  no-new-privileges`, `--pids-limit 256`, size-limited tmpfs, a persistent
  `/workspace` volume under `~/.legion/sandboxes/<missionId>/`, and **no host
  env forwarded**. Legion stamps each container with a `legion-mission=<id>`
  label and **stops + removes it on completion**. **If Docker is unavailable
  while the docker backend is selected, the mission FAILS with a clear
  `DOCKER_UNAVAILABLE` error — never a silent fallback to local.**
- **local**: runs on the host (under the M7 seatbelt profile), for users who
  want it.

### Isolation posture — container on top of M7

Docker-backend open missions are confined **by the container** ("the container
is the security boundary"). This is **added on top of M7, not instead of it**:
the worker process is still seatbelt-wrapped, the per-worker egress proxy +
SSRF blocks still apply to the worker's web tools, and `CAPABILITY_PROFILE` is
still recorded. The one capability the open profile gains is a **scoped grant
to the Docker daemon unix socket** (so the worker can orchestrate its
container); TCP egress stays confined to the loopback proxy. Tool execution —
the shell, code, file writes — happens inside the container, so an agent that
tries to write outside `/workspace` or delete host files cannot reach the host
(T89). The merge gate is unchanged: the sealed workspace deliverable is
hash-bound to your passkey before delivery.

## Runtime capability scoping (Milestone 7)

Every worker runs under an **OS-level capability profile scoped to its role**.
A confused or prompt-injected agent cannot act outside its grant — not by
instruction, not by accident. This is confinement only: it can only *reduce*
what a worker may do (the state machine, gate, and ledger are unchanged), and
it is the precondition for any future consequential-action milestone.

### The profiles (one per role)

| Role | Filesystem | Network | Subprocess |
| --- | --- | --- | --- |
| planner | write its workdir (plan.json) only | none | yes |
| coder | write its workspace clone only | none | yes |
| reviewer | write its workdir (review.json) only | none | yes |
| task | write its workdir/deliverables only | none | yes |
| open | write deliverables only | allowlist (web) | no\* |

Resolution is a pure function (`@legion/core` `resolveCapabilityProfile`); an
**unknown role throws — never a permissive default**. `write` is a strict
allowlist (the real teeth: a worker cannot mutate the host or write outside its
own workspace). `read` is broad for the system runtime — the dynamic linker and
Python must load or the process can't start at all — but the **repo `.env` is
explicitly deny-read**, so a confined worker never sees `DATABASE_URL` or keys.
`network` is enforced by the egress chokepoint below.

### Network: the egress chokepoint + SSRF defense

Every worker also needs to reach the **LLM control-plane endpoint** to think —
so "net:none" cannot mean zero packets. Instead, each worker gets a **per-worker
egress proxy on loopback**; seatbelt permits outbound **only** to
`localhost:<proxyPort>`, and the proxy enforces the per-role allowlist:

- `net:none` (planner/coder/reviewer/task): the proxy allows **only the model
  host**. A worker told to fetch any other URL fails closed (DNS is denied; the
  connection is refused) and the attempt is logged.
- `net:allowlist` (open): the model host **plus** general web, every request
  routed and **logged as a `NET_REQUEST` worker_event** (`{host, method,
  allowed, reason}`). **SSRF blocked**: loopback, RFC1918 private ranges,
  link-local `169.254.0.0/16` (incl. the `169.254.169.254` cloud-metadata IP),
  CGNAT, and IPv6 ULA/link-local all fail closed — both literal-IP hosts and
  hostnames that resolve into those ranges.

The resolved profile is recorded as a `CAPABILITY_PROFILE` worker_event **before
the worker does any work**, so the ledger proves what each worker was allowed to
do.

### Enforcement mechanism — honest platform matrix

| Platform | Mechanism | Status |
| --- | --- | --- |
| **macOS** | `sandbox-exec` (seatbelt) `(deny default)` profile generated per worker, paths realpath-resolved | **Enforced, verified** (T78–T84 run real escape attempts and observe kernel denial) |
| **Linux** (deploy target) | bubblewrap (`bwrap`): ro-binds for reads, bind for the writable workdir, `--unshare-net` for net:none, egress proxy for allowlist | **Code path provided, NOT verified on this dev machine** (no bwrap/Linux here) — labelled best-effort until a Linux run confirms it |
| other | — | refuse to start |

**Refuse-to-start is the invariant**: if the chosen mechanism cannot apply a
profile in the current environment (e.g. running inside another sandbox where
`sandbox_apply` is denied), the worker is **never run unconfined** — it records
`WORKER_FAILED {ENFORCEMENT_UNAVAILABLE}` and the spawn throws.

**Honest gaps (macOS):** seatbelt's `process-exec*` is allowed for every role
(the interpreter must exec to start), so the open role's "no subprocess" is
enforced by its toolset (web tools only, no shell) rather than by exec-denial;
and standard character devices (`/dev/null`, `/dev/urandom`, …) are writable
because every shell needs them. Neither is a path to mutating the host or
escaping the workspace. Linux/bwrap closes the exec gap with a private mount +
PID namespace when that path is verified.

## Open missions: read-only web research (Milestone 6d)

The everything-agent's first capability, scoped **read-only**. An `open`
mission is a free-flowing research agent: it searches the web, fetches pages,
and writes a **cited markdown report** as its deliverable. It cannot write,
send, spend, or act — those are later milestones, behind capability scoping
and the gate.

- **Pipeline**: EXECUTE → deliverable → gitleaks scan → gate. There is no
  plan gate (riskLevel is forced to `open-readonly`; a user-sent level is
  ignored **with a recorded note**), no build, no diff, no code scan. The
  state machine is unchanged — the orchestrator emits the synthetic
  `PLANNING_STARTED → PLAN_PROPOSED → PLAN_APPROVED` sequence with
  `policy: 'open-readonly'` in the ledger, then `BUILD_STARTED`/`BUILD_COMPLETED`
  around the worker (pin: ledger event names stay canonical).
- **Tools — an explicit allowlist**: the open worker's toolset is exactly
  `web_search(query)` and `web_extract(urls)` (the vendored runtime's name
  for *web_fetch*: url → readable text). Nothing else is reachable — no
  shell, no file tools, no messaging. The agent cannot even write its own
  report: the **launcher** (trusted Legion code) seals the agent's final
  message as `deliverables/report.md`, the only write the worker process
  performs.
- **Search provider (pinned)**: Tavily — one key drives both search and
  extract in the vendored runtime. Configure in `.env`:
  `LEGION_SEARCH_PROVIDER=tavily` (the only supported value in v0.1) and
  `LEGION_SEARCH_API_KEY=<your tavily key>`.
- **Citations required**: the worker must ground claims in fetched sources
  and cite URLs; the reviewer (reused from task missions) flags uncited
  claims and rejects a report with no sources at all.
- **The gate stays**: the deliverable is hash-sealed, gitleaks-scanned (an
  agent can paste a fetched secret into a report), and the same passkey
  ceremony binds the deliverable hash. Even read-only output is signed
  before it is "official."

### Open mission threat model

Read-only web tools **can be prompt-injected by fetched content** — a
malicious page can tell the agent to lie, omit, or mis-cite. The blast
radius is a **wrong deliverable, not host compromise**: the worker cannot
write outside its workdir (no shell, no file tools; the launcher writes only
`deliverables/report.md`), cannot send anything anywhere, and cannot spend.
Its environment is the same allowlist as every worker (no `DATABASE_URL`,
redirected `HOME`) — asserted from inside a real worker by the test suite.
And the wrong deliverable still faces the reviewer, the secrets scan, and
your passkey before it is delivered. Consequential tools (write/send/spend)
are gated and intentionally absent from this milestone.

## Scheduled missions (Milestone 6c)

Recurring work runs unattended — nightly audits, weekly reports — and only
pings a human when a gate needs one. **The merge gate remains invariant: a
scheduled mission parks at `AWAITING_MERGE_APPROVAL` like every other mission.
Nothing merges or delivers while you sleep.**

A **schedule** is a cron expression plus a mission template
(`{kind, title, objective, repoPath?, deliverTo?, riskLevel}`). A 30s daemon
tick fires due, enabled schedules; each firing creates a mission whose
`MISSION_CREATED` payload carries `{scheduledBy}` and immediately starts
planning. From there the M6b risk policy governs the flow — a **low-risk**
template runs hands-free (plan auto-approved → build → scan) straight to the
merge gate and waits for your passkey.

- **UTC only (v0.1).** Cron is standard 5-field (`min hour dom month dow`),
  evaluated in UTC — a daily job is exactly 24h apart with no daylight-saving
  drift. Parsing is via the pinned `croner` dependency; the next-run
  computation is a pure function in `@legion/core` (it takes `now` as an
  argument, so it is unit-testable without time-travel hacks).
- **One in flight, ever.** A schedule never fires while its most recent
  created mission is non-terminal; the due tick records `SKIPPED_ACTIVE`
  instead. The next tick after that mission reaches a terminal state fires
  normally.
- **Catch-up.** If the daemon was down across one *or more* intervals, the
  next tick (and the boot tick) fires **exactly once**, not N times, then
  anchors the next run on now. The `schedule_runs` row notes the catch-up.
- **Mutation & deletion.** Changing a schedule's cron or template takes effect
  from the next tick; in-flight missions are unaffected. Deleting a schedule
  never touches its missions — `scheduledBy` keeps pointing at the dead id;
  history is history.
- **`run-now`** fires immediately under the same concurrency guard. Ticks
  ignore disabled schedules silently; an explicit `run-now` on a disabled
  schedule records `SKIPPED_DISABLED` and returns 409.

### Schedule API

```
POST   /api/schedules              create (strict template, valid cron)
GET    /api/schedules              list + computed nextRunAt + last outcome
GET    /api/schedules/:id          detail + recent schedule_runs
PATCH  /api/schedules/:id          update cron/template/enabled
DELETE /api/schedules/:id          (missions untouched)
POST   /api/schedules/:id/run-now  manual fire under the guard
```

## Tests

### Execution protocol: two tiers

`pnpm test` = `test:fast` then `test:agents`.

- **`pnpm test:fast`** — every deterministic suite: `core`, `db`, `scanner`,
  `board`, and the daemon's `api` + `approval` suites (the WebAuthn ceremonies
  use the software authenticator — real crypto, no model). **retry: 0** — a
  deterministic suite that needs a retry is a bug. Expected wall-clock:
  **under a minute**; cost: **zero** (no model calls).
- **`pnpm test:agents`** — every suite that spawns real Hermes workers
  against the real model: `runtime`, then the daemon's `workers`, `planning`,
  `build`, `scan`, and `task` suites — **per package serially, each suite in
  its own vitest process** (one long-lived process accumulating dozens of
  real agent runs is how timeouts compound). Agent suites run with
  **`--retry=1`**: a re-run of a real test is not a mock — it is how
  stochastic integration tests are run honestly. Generous per-test timeouts
  (`--testTimeout=600000` default; suites keep their own explicit budgets).
  Expected wall-clock: **~20–50 minutes** depending on model latency; cost:
  **a few tens of cents** in OpenRouter usage for a full pass.

Both tiers fail loudly (never skip) when `OPENROUTER_API_KEY` or the
provisioned scanners are missing.

| Suite | What it proves |
| --- | --- |
| `packages/core` | T2–T5 state machine, illegal transitions, rejection loop; T17 plan schema; T23 review schema; T31 scan-failure rework; T44 merge-rejection rework; T62 next-run pure function (cron, UTC/DST, invalid rejection); T77 capability profile resolution (unknown role → error) |
| `packages/scanner` | T32 real gitleaks+semgrep SARIF merge, counts, threshold, crash handling |
| `packages/db` | T1 migrations + schema, T2 creation, T7 concurrency (gapless seq, retryable conflicts) |
| `apps/daemon` | T2–T6, T8 bitemporal HTTP; T15 worker API; T18–T22 planning; T24–T30 build; T33–T38 scan; T39–T47 human gate (real WebAuthn ceremonies via software authenticator, artifact binding, replay/expiry, dirty/conflict merge, crash reconciliation); T48–T54 task missions (kind boundary, real deliverable production, gitleaks-on-deliverables, tamper-voiding, EMPTY_DELIVERABLE, tar delivery, reviewer loop); T55–T60 express lane (risk-proportional plan gating, scan thresholds, gate invariance, riskLevel immutability); T63–T68 scheduled missions (real firing, concurrency guard, catch-up, run-now/disabled, CRUD) |
| `apps/board` | M5.5 operator-UX smokes; T61 risk-policy notices (express / strict-scan); T69 schedules view + SCHEDULED tag; T76 open selector + cited preview; T92 open live-tool feed + workspace tree |
| `packages/runtime` | T9 venv provisioning, T10 real trajectory, T11 env isolation, T12 hard kill, T13 timeout, T14 orphan reconciliation, T16 graceful-stop escalation; T71 open toolset allowlist; **M7**: egress proxy + SSRF (fast); T77-adjacent seatbelt profile gen + T82 refuse-to-start (fast); T78/T79/T81/T84 real seatbelt confinement (agent tier, auto-detecting); **M8**: T85 full toolset, T88 backend resolution + docker-unavailable fail, T86/T89 docker lifecycle + host safety (auto-detecting) |
