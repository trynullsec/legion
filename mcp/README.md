# @trynullsec/legion-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for **[Nullsec Legion](https://github.com/trynullsec/legion)**. It lets an AI client (Cursor, Claude Desktop, …) create, monitor, and review Legion missions through your running daemon.

It is a **thin translation layer** over Legion's HTTP API — each tool wraps one endpoint, adding no business logic.

> **The merge gate stays human.** Approving a merge or delivery is a passkey (WebAuthn) ceremony performed in the board. An MCP client cannot sign it — by design. These tools *surface* when a mission is awaiting your approval and point you to the board; there is no `approve_merge` tool.

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

Before publishing, run it straight from a checkout instead:

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

## License

MIT — see the [main repository](https://github.com/trynullsec/legion).
