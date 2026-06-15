# Security Policy

Legion's entire premise is that agent work is contained and that nothing
irreversible happens without a human signature. We take reports about that
boundary seriously and will work with you in good faith.

## Reporting a vulnerability

Please report security issues privately. **Do not open a public issue, pull
request, or discussion for a suspected vulnerability.**

Email **`security@<DOMAIN>`** with:

- a description of the issue and its impact,
- the components and versions affected,
- reproduction steps or a proof of concept, and
- any suggested remediation, if you have one.

If you need to share sensitive material, say so in your first message and we
will arrange an encrypted channel.

## What to expect

- **Acknowledgement** within **3 business days**.
- An initial assessment and severity triage shortly after.
- Coordinated disclosure: we will agree on a timeline with you, fix the issue,
  and credit you in the release notes unless you prefer to remain anonymous.

We do not currently operate a paid bug-bounty program. We are grateful for
responsible disclosure regardless.

## Scope

**In scope** — the Legion project in this repository:

- the daemon and its HTTP API (`apps/daemon`),
- the mission board (`apps/board`),
- the worker runtime and OS confinement (`packages/runtime` — seatbelt/bwrap,
  the egress proxy, SSRF defenses),
- the orchestrator, core state machine, scanner, and database layer
  (`packages/*`).

Examples of in-scope reports: a way to merge or deliver without a valid
passkey assertion; a path that lets a worker write or read outside its
capability profile; an egress-proxy bypass or SSRF; tampering with a diff or
scan artifact without voiding the bound approval; or a way to make the system
run a worker unconfined instead of refusing to start.

**Out of scope (upstream)** — the agent runtime itself is **[Hermes Agent](https://github.com/NousResearch/hermes-agent)**,
vendored as a git submodule under `vendor/hermes-agent`. Vulnerabilities in
that code belong upstream: please report them to
[Nous Research](https://github.com/NousResearch/hermes-agent/security). If a
Hermes issue is only exploitable *because of how Legion drives it*, that
integration is in scope here — tell us both.

Also out of scope: findings that require a malicious operator who already holds
the approval passkey, social-engineering, and issues in third-party services
(OpenRouter, your search provider, Docker, Postgres) unless Legion uses them in
a demonstrably unsafe way.

## Supported versions

Legion is pre-1.0. Security fixes target the latest `main` and the most recent
`v0.x` release. Pin a release and watch the repository for advisories.
