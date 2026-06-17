<p align="center">
  <img src="assets/legion.png" alt="Nullsec Legion" width="100%" />
</p>

<h1 align="center">✦ Nullsec Legion</h1>

<p align="center">
  <a href="https://github.com/trynullsec/legion/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/trynullsec/legion/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-black?style=for-the-badge" /></a>
  <a href="https://github.com/NousResearch/hermes-agent"><img alt="Inspired by Hermes Agent · Nous Research" src="https://img.shields.io/badge/Inspired%20by-Hermes%20Agent%20%C2%B7%20Nous%20Research-blueviolet?style=for-the-badge" /></a>
  <!-- TODO: replace https://heylegion.io with your docs URL (DOCS_URL) -->
  <a href="https://heylegion.io"><img alt="Docs" src="https://img.shields.io/badge/Docs-Read-black?style=for-the-badge" /></a>
  <a href="https://x.com/trynullsec"><img alt="X" src="https://img.shields.io/badge/Follow-%40trynullsec-black?style=for-the-badge&logo=x&logoColor=white" /></a>
</p>

<p align="center">
  <strong>Nullsec Legion is an open-source AI operating system for software projects. You give it a mission — agents plan, build, review, and security-scan it — and nothing irreversible happens without your cryptographic signature.</strong>
</p>

---

## Why Legion

Legion treats agent work the way a serious team treats a change: as a unit of work with a plan, a review, a security scan, and a gate that a human signs. Agents do the labor in confinement; you hold the key. Every decision — every plan, prompt, diff, finding, and signature — is written to an append-only ledger, so the question "what did the agent do, and who approved it?" always has an exact answer.

| Capability | What it means |
| --- | --- |
| **Missions, not chats** | Durable, event-sourced units of work with a typed state machine and a microsecond-precise append-only ledger. |
| **A legion in lanes** | Specialized planner, coder, and reviewer agents; the coder works in an isolated clone whose git remote is removed, so it cannot push to your repo. |
| **Scanned before you see it** | Every diff is scanned for secrets (gitleaks) and unsafe patterns (semgrep) before you judge it; errors block, findings route back with the work. |
| **The human gate** | The merge waits for your passkey (WebAuthn), cryptographically bound to the exact bytes of the diff and scan report. Tamper with either and the approval voids. |
| **OS-enforced confinement** | Agents run under kernel-level sandboxing (seatbelt/bwrap): scoped filesystem, egress through an SSRF-filtered proxy, secrets unreadable. Refuses to start rather than run unconfined. |
| **Read-only research missions** | Agents search the live web and return a cited, scanned, signed report. |
| **Provider-agnostic** | Bring your own OpenRouter key; any model, no lock-in. |
| **A complete record** | Every plan, prompt, commit, finding, and signature, permanently, in the ledger. |

---

## Quick Install

> **macOS or Linux**, with **Node 20+**, **git**, and a running **Docker**. (Windows: use [WSL2](https://learn.microsoft.com/windows/wsl/install).)

One command clones, configures, and launches Legion. It checks your environment first and tells you exactly what's missing — nothing runs silently:

```bash
npx @trynullsec/legion
```

It prompts for your OpenRouter key (written only to `.env`, never logged), provisions the worker runtime and scanners, brings up Postgres, runs migrations, and opens the board. Use `--dir <path>` to choose where it lands or `--no-start` to set up without launching; see `npx @trynullsec/legion --help`.

<details>
<summary><strong>Manual install</strong> — the same steps, by hand</summary>

```bash
git clone https://github.com/trynullsec/legion.git
cd legion
git submodule update --init      # vendored agent runtime (Hermes Agent)
pnpm install
bash scripts/setup-workers.sh    # worker runtime (uv-managed Python venv + agent)
bash scripts/setup-scanners.sh   # gitleaks + semgrep
cp .env.example .env             # add your OPENROUTER_API_KEY
docker compose up -d             # Postgres (pgvector) on :5434
pnpm migrate
pnpm dev                         # board + API at http://localhost:4242
```

If port `5434` is already taken (e.g. a second Legion), publish Postgres on another port and keep `DATABASE_URL` in sync — `LEGION_PG_PORT=5500 docker compose up -d`, then set `...@localhost:5500/...` in `.env`. The `npx` installer does this for you automatically.

On Linux, also install bubblewrap (`sudo apt-get install -y bubblewrap`): Legion confines every worker at the OS level and refuses to run unconfined.

</details>

Then open **http://localhost:4242**, register a passkey, and create your first mission.

---

## Getting Started

```bash
pnpm dev              # Build the board and start the daemon (board + API on :4242)
pnpm migrate          # Apply database migrations
pnpm test             # Full suite — fast tier + real-agent tier
pnpm test:fast        # Fast tier only (no live agents required)
pnpm typecheck        # Type-check every package
docker compose up -d  # Start Postgres
docker compose down   # Stop Postgres
```

Set your keys in `.env`:

```bash
DATABASE_URL=postgres://legion:legion@localhost:5434/legion
OPENROUTER_API_KEY=sk-or-...          # any model, via OpenRouter
LEGION_SEARCH_PROVIDER=tavily         # for read-only research missions
LEGION_SEARCH_API_KEY=tvly-...
```

---

## How a mission flows

A mission moves through a single, typed state machine. The transition table never changes; stages adapt to the mission kind.

```
CREATED → PLANNING → AWAITING_PLAN_APPROVAL → BUILDING → REVIEW
        → SCANNING → AWAITING_MERGE_APPROVAL → MERGED
```

1. **Plan.** A planner agent reads the cloned repo (or, for research, the objective alone) and proposes a structured plan. You approve or reject; rejections carry your feedback forward verbatim.
2. **Build.** A coder agent implements the approved plan in an isolated workspace — a clone whose git remote has been removed, so nothing can be pushed upstream by the agent.
3. **Review.** A reviewer agent reads the diff against the plan and renders a verdict, with a bounded revision loop.
4. **Scan.** The diff is scanned by **gitleaks** (secrets) and **semgrep** (unsafe patterns) into a SARIF artifact. Error-level findings block; they route back into the next attempt with the work.
5. **Gate.** The merge parks until you sign. (Details below.)
6. **Merge.** Only after a verified signature does Legion perform a real `git merge --no-ff` into your repository.

---

## The human gate

The gate is the invariant. Every mission, every risk level, ends at the passkey ceremony — there is no bypass.

When a mission reaches `AWAITING_MERGE_APPROVAL`, Legion derives a WebAuthn challenge bound to the work itself:

```
challenge = base64url( sha256( missionId | diffSha256 | sarifSha256 | serverNonce ) )
```

The artifact hashes are **recomputed from disk** both when the challenge is issued and again when your assertion is verified. If a single byte of the diff or the scan report changed in between, the hashes no longer match and the approval voids with an `INTEGRITY` error — nothing merges. Your signature approves *those exact bytes*, not "the mission" in the abstract.

Risk level scales the checkpoints *before* the gate, never the gate itself:

- **low** — schema-valid plans auto-approve (recorded in the ledger as a policy decision, never silent); the build runs hands-free to the gate.
- **medium** — the default; plan approval is manual.
- **high** — the scan threshold tightens so warnings block, not just errors.

The merge gate is identical for all three.

---

## Confinement

Agents are not trusted; they are contained. Every worker is wrapped at spawn in an OS-level sandbox scoped to its role, and its resolved policy is written to the ledger (`CAPABILITY_PROFILE`) before it does any work. If the platform cannot enforce the policy, the worker **refuses to start** — it never silently runs unconfined.

- **Filesystem** — a per-role write allowlist (e.g. the coder may write only its workspace); everything else is denied, and secret paths are unreadable.
- **Network** — `none` for build roles; research workers reach the web only through a Legion-controlled egress proxy that logs every request and **fails closed** on loopback, RFC1918, and cloud-metadata addresses (SSRF defense).
- **Process** — subprocess spawning is denied by default.

| Platform | Mechanism | Status |
| --- | --- | --- |
| macOS | `sandbox-exec` (seatbelt) | Enforced |
| Linux | `bubblewrap` (bwrap) namespaces | Implemented; deploy-target path |

Confinement can only *reduce* what a worker can do. It cannot grant new abilities — it is a floor, not a feature switch.

---

## Mission kinds

| Kind | Deliverable | Pipeline |
| --- | --- | --- |
| **code** | A git diff merged into your repo | plan → build → review → scan → gate → merge |
| **task** | A file artifact (report, analysis, dataset) | plan → build → review → gitleaks scan → gate → deliver |
| **research** *(read-only)* | A cited markdown report | execute (web search + fetch) → gitleaks scan → gate → deliver |

Task and research deliverables are sealed as sha256-bound artifacts and gated by the same passkey ceremony as code — even read-only output is signed before it is official.

---

## Architecture

A pnpm + Turborepo monorepo. Presentation, orchestration, and confinement are separated so each can be reasoned about — and tested — on its own.

| Package | Responsibility |
| --- | --- |
| `@legion/core` | Domain types, the mission state machine, and pure policy (risk, schedule, capability resolution). |
| `@legion/db` | PostgreSQL migrations and the bitemporal, append-only event store. |
| `@legion/scanner` | gitleaks + semgrep, merged into a single SARIF artifact with threshold logic. |
| `@legion/runtime` | The worker supervisor, OS confinement (seatbelt/bwrap), and the SSRF-filtered egress proxy. |
| `@legion/orchestrator` | The plan / build / review / scan / deliver flows and the merge/delivery mechanics. |
| `apps/daemon` | A Hono HTTP API, the WebAuthn gate, and the schedule loop. |
| `apps/board` | The React mission board. |

The agent runtime itself is **[Hermes Agent](https://github.com/NousResearch/hermes-agent)**, vendored as a git submodule and driven by Legion's supervisor — never modified.

---

## What works today

Legion is honest about its scope. A claim lives under "works today" only if a committed, passing test backs it.

**Shipped & verified (M0–M7):**

- **Code missions** — the full plan → build → review → scan → passkey gate → merge pipeline.
- **Task missions** — accountable non-code work delivered as a scanned, signed file artifact.
- **Read-only research missions** — live web search and fetch, returned as a cited report.
- **Risk-proportional pipelines** — checkpoints scale with declared risk; the merge gate never does.
- **OS-enforced confinement** — per-role seatbelt/bwrap sandboxing, egress proxy, SSRF defense, refuse-to-start.

All of it is exercised by **170+ tests against real infrastructure** — real Postgres, real models, real git, real scanners, real WebAuthn. **No mocks.**

**Coming next:**

- **Full-capability execution** — agents that run code, drive a browser, and edit files in a sandboxed container to complete open-ended tasks (not just describe them), behind the same gate.
- **A hosted option** — Legion without the local setup.

These are roadmap, not promises kept. If it is not yet backed by a passing test, it is listed here, not above.

---

## Use it from your AI client (MCP)

[`@trynullsec/legion-mcp`](mcp/) is a [Model Context Protocol](https://modelcontextprotocol.io) server that lets Cursor, Claude Desktop, or any MCP client create, monitor, and review missions through your running daemon. Point your client at it:

```json
{
  "mcpServers": {
    "legion": {
      "command": "npx",
      "args": ["-y", "@trynullsec/legion-mcp"],
      "env": { "LEGION_API_URL": "http://localhost:4242" }
    }
  }
}
```

The merge gate stays human: an MCP client can plan, build, and read deliverables, but **approving a merge is a passkey ceremony in the board** — there is no tool to sign it. See [`mcp/README.md`](mcp/README.md).

---

## Documentation

Full documentation lives at **[heylegion.io](https://heylegion.io)**. <!-- TODO: replace with your docs URL -->

| Topic | What's covered |
| --- | --- |
| Quickstart | Install → migrate → first mission |
| Missions | The state machine, mission kinds, and the ledger |
| The gate | WebAuthn binding, challenge derivation, integrity rules |
| Confinement | Capability profiles, the egress proxy, the platform matrix |
| Configuration | Environment variables, providers, models |

---

## Community

- [X / @trynullsec](https://x.com/trynullsec)
- [Issues](https://github.com/trynullsec/legion/issues)

---

## License

MIT — see [LICENSE](LICENSE).

Built by Nullsec. Agent runtime vendored from [Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research, MIT) — thank you.
