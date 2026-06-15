# @trynullsec/legion

The one-command installer for **[Nullsec Legion](https://github.com/trynullsec/legion)** — an open-source AI operating system for software projects.

It is not the product; it is a thin, dependency-free orchestrator that collapses the manual setup into a single command and **fails fast with a clear message** when your machine is missing something.

```bash
npx @trynullsec/legion
```

## What it does

Each step is idempotent and clearly logged — re-running after a fix is always safe.

1. **Preflight** — verifies Node 20+, git, pnpm (offers to enable it via corepack), uv, and a *running* Docker (plus bubblewrap on Linux). Each missing prerequisite prints exactly what to install and where.
2. **Fetch** — clones the repository and initializes the vendored agent runtime submodule. If the directory already holds Legion, it offers to update instead.
3. **Configure** — prompts for your OpenRouter API key (and an optional Tavily key for web research) and writes them to `.env`. **Keys are written only to `.env` — never logged, echoed, or transmitted**, and the file is created with mode `600`.
4. **Install** — `pnpm install`, then provisions the worker runtime and scan engine.
5. **Database** — `docker compose up -d`, waits for Postgres to report healthy, then runs migrations.
6. **Start** — launches the board at **http://localhost:4242** and prints your next steps.

## Options

| Flag | Effect |
| --- | --- |
| `-d, --dir <path>` | Where to install Legion (default: `./legion`) |
| `--no-start` | Set everything up but do not launch the board |
| `--update` | If the target dir already has Legion, update it |
| `-y, --yes` | Accept defaults / skip confirmations (non-interactive) |
| `-h, --help` | Show help |
| `-v, --version` | Show the installer version |

You can also pre-set `OPENROUTER_API_KEY` (and `LEGION_SEARCH_API_KEY`) in your environment; the installer will use them instead of prompting — useful for non-interactive installs.

## Requirements

- **macOS or Linux.** On Windows, install [WSL2](https://learn.microsoft.com/windows/wsl/install) and run the installer inside it. The installer detects Windows and tells you this.
- Node 20+, git, Docker (running). The installer can enable pnpm (via corepack), install uv, and install bubblewrap (Linux) for you when missing.

## Security

This package has **zero runtime dependencies** — only Node's standard library handles your input, by design. Your API keys never leave your machine: they are written to `<dir>/.env` and nothing else. The installer never prints them.

## License

MIT — see the [main repository](https://github.com/trynullsec/legion).
