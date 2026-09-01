# Cooking App

A self-hosted weekly cooking planner whose real asset is a deep, structured
profile of the cook, exposed to the user's own AI agent over MCP so that agent
can propose a genuinely personalized cooking week.

**The application never calls an LLM.** Intelligence comes from whatever agent
the user already pays for (Claude Desktop, Claude Code, any MCP-capable client).
Marginal cost per user tends to zero.

## Status

**Phases 0 to 4 complete.** You can configure your weekly grid, build a recipe
library, plan a week by hand, shop from a grocery list generated out of it, and
maintain the profile and fact store that make the planning personal. Plan
versions are immutable and revertible, and the strict allergen block, slot state
validation and per-slot time budgets are enforced in the service layer both
entry points share.

Your agent can connect and read. Paste one URL into an MCP client, approve the
consent screen, and it can read your profile snapshot, search your recipes and
read your planned weeks. It cannot write yet. Access is per client, scoped, rate
limited, logged, and revocable with immediate effect.

The profile snapshot, the exact document a connected agent reads, is also
viewable in the app in both Markdown and JSON. Reading it is the fastest way to
judge whether the context is any good.

Regenerating the grocery list merges rather than wipes: what you already ticked
off stays ticked, lines you added by hand survive, and the screen tells you what
moved.

Phase 0 closed alongside phase 1: the login and consent screens shipped, so the
OAuth 2.1 flow now runs end to end into an authenticated MCP call. See
[`docs/07-phase-0-findings.md`](docs/07-phase-0-findings.md).

Next: phase 5, agent write access.

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

Then open http://localhost:3000, create an account, and you land on the current
week. A new account is seeded with three meal types, dinner planned every day,
and a starter ingredient vocabulary so grocery merging and allergen derivation
work from the first recipe.

`npm run verify` needs only Postgres. The agent connection path needs a running
server, so it has its own check:

```sh
npm run dev                 # in one terminal
npm run verify:oauth        # in another
```

That walks what a real MCP client does: cold dynamic client registration, an
authorization request with PKCE, login, consent, the code exchange, an
authenticated `whoami`, and a check that an unauthenticated call is still refused
with RFC 9728 discovery.

The MCP endpoint is at `/api/mcp`, and the app's Agent screen walks you through
connecting a client to it. It exposes `whoami`, `get_profile_snapshot`,
`search_recipes`, `get_recipe` and `get_week`, plus resources for the profile,
the slots, the recipe index and any planned week. Write tools land in phase 5.

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

## Stack

TypeScript end to end. Next.js, PostgreSQL 18, Drizzle, Better Auth acting as an
OAuth 2.1 provider, the MCP TypeScript SDK, Zod as the single source of
validation, next-intl for French copy, and dnd-kit for the week grid. Reasoning
and the rejected alternatives are in
[`docs/04-tech-spec.md`](docs/04-tech-spec.md).

Layout: `src/domain` holds pure rules with no I/O, `src/services` is the one
service layer both entry points call, `src/app` is the French UI plus the MCP and
auth routes, `src/db` is the Drizzle schema and the tenancy-scoped client.

## Non-negotiable constraints

1. No server-side LLM call, ever. Enforced in CI by a dependency allowlist.
2. Strict allergens are a hard block on every write path, UI and MCP alike.
3. One service layer behind both the UI and the MCP endpoint. No rule lives in
   only one of them.
4. Nothing an agent does is irreversible.
5. The app is fully usable with no agent connected.

## Licence

Not yet chosen.
