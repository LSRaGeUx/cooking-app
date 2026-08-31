# Cooking App

A self-hosted weekly cooking planner whose real asset is a deep, structured
profile of the cook, exposed to the user's own AI agent over MCP so that agent
can propose a genuinely personalized cooking week.

**The application never calls an LLM.** Intelligence comes from whatever agent
the user already pays for (Claude Desktop, Claude Code, any MCP-capable client).
Marginal cost per user tends to zero.

## Status

**Phase 0 complete.** The OAuth 2.1 authorization server with dynamic client
registration, the Streamable HTTP MCP endpoint, and row-level security are all
standing and verified. See [`docs/07-phase-0-findings.md`](docs/07-phase-0-findings.md).

Next: phase 1, the manual core loop.

Full specs live in [`docs/`](docs/README.md). Start with
[`docs/README.md`](docs/README.md), then read in numbered order.

## Getting started

Requires Node (see `.nvmrc`) and Podman.

```sh
cp .env.example .env        # then set BETTER_AUTH_SECRET
npm ci
npm run db:setup            # container, role, migrations, auth tables
npm run verify              # dep check, typecheck, tests
npm run dev
```

The MCP endpoint is at `/api/mcp`. Discovery, registration, and the authorize
redirects work today; the login and consent screens are phase 1.

## What makes it different

The differentiator is not the calendar grid. It is a durable, structured,
agent-readable and agent-writable context store about one cook, plus a tool
surface precise enough that a general-purpose agent can plan against it and
write results back.

- **Structured profile** for things needing enforcement: allergens with
  severity, diet, equipment, per-slot time budgets.
- **Open fact store** the agent reads and writes, with category, polarity,
  confidence, source, and status. Agent-written facts enter unconfirmed and the
  user reviews them.
- **Immutable plan versions.** Every agent action is diffable and revertible.
- **Required rationale** on every agent-proposed meal, citing the facts that
  drove it, so the user can correct the cause rather than the dish.

## Planned stack

TypeScript end to end. Next.js, PostgreSQL, Drizzle, Better Auth acting as an
OAuth 2.1 provider, and the MCP TypeScript SDK. Reasoning and the rejected
alternatives are in [`docs/04-tech-spec.md`](docs/04-tech-spec.md).

## Non-negotiable constraints

1. No server-side LLM call, ever. Enforced in CI by a dependency allowlist.
2. Strict allergens are a hard block on every write path, UI and MCP alike.
3. One service layer behind both the UI and the MCP endpoint. No rule lives in
   only one of them.
4. Nothing an agent does is irreversible.
5. The app is fully usable with no agent connected.

## Licence

Not yet chosen.
