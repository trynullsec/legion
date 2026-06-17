# @trynullsec/legion-mcp

<p>
  <a href="https://www.npmjs.com/package/@trynullsec/legion-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@trynullsec/legion-mcp?color=black" /></a>
  <a href="https://www.npmjs.com/package/@trynullsec/legion-mcp"><img alt="provenance" src="https://img.shields.io/badge/npm-provenance-blueviolet" /></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/npm/l/@trynullsec/legion-mcp?color=black" /></a>
  <a href="https://modelcontextprotocol.io"><img alt="MCP" src="https://img.shields.io/badge/Model%20Context%20Protocol-server-black" /></a>
</p>

A [Model Context Protocol](https://modelcontextprotocol.io) server for **[Nullsec Legion](https://github.com/trynullsec/legion)**. It lets an AI client (Cursor, Claude Desktop, …) create, monitor, and review Legion missions through your running daemon.

It is a **thin translation layer** over Legion's HTTP API — each tool wraps one endpoint, adding no business logic.

## What it deliberately does not do

**It cannot approve a merge or delivery.** That is a human passkey (WebAuthn) ceremony performed in the Legion board, cryptographically bound to the exact bytes of the diff and scan report. An MCP client has no key and no tool to sign it — by design. The agent can plan, build, scan, and read the result; the irreversible step waits for you. `get_approval_status` *surfaces* when a mission is at that gate and points you to the board. There is no `approve_merge` tool, and there never will be one here.

## Prerequisites

A running Legion daemon (`pnpm dev`, default `http://localhost:4242`). The MCP server talks to it over HTTP.

## Tools

| Tool | What it does |
| --- | --- |
| `list_missions` | All missions with state + the recommended next action (optional `state`/`kind` filter) |
| `get_mission` | One mission: state, next action, recent event ledger |
| `create_mission` | Create a `code` / `task` / `open` mission (optional `autoStart`) |
| `start_planning` | Kick off the planner (or execution for open missions) |
| `approve_plan` / `reject_plan` | The **plan** gate (no passkey); rejection reason is fed back to the replan |
| `get_scan` | Latest scan verdict + per-tool finding counts (gitleaks/semgrep) |
| `get_deliverable` | Task/open deliverable preview (sha256 + per-file content) |
| `get_approval_status` | Whether a mission is at the human **merge** gate, with bound artifact hashes |
| `list_schedules` / `run_schedule_now` | Recurring mission schedules |

## Configuration (client)

The server runs over **stdio**. Point your client at it with `npx`.

**Cursor** — `~/.cursor/mcp.json` (or a project `.cursor/mcp.json`):

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

**Claude Desktop** — `claude_desktop_config.json` (same shape):

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

### Local development

To run it straight from a checkout (e.g. while hacking on the server itself):

```json
{
  "mcpServers": {
    "legion": {
      "command": "node",
      "args": ["/absolute/path/to/legion/mcp/bin/legion-mcp.mjs"],
      "env": { "LEGION_API_URL": "http://localhost:4242" }
    }
  }
}
```

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `LEGION_API_URL` | `http://localhost:4242` | The Legion daemon base URL |
| `LEGION_API_TOKEN` | _(none)_ | Optional `Bearer` token, if you front the daemon with auth |
| `LEGION_API_TIMEOUT_MS` | `30000` | Per-request timeout; a hung daemon returns a clean error, never hangs the client |

## License

MIT — see the [main repository](https://github.com/trynullsec/legion).
