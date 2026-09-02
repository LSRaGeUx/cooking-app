# Cooking App - project instructions

Self-hosted weekly cooking planner. The differentiator is a deep, structured,
agent-readable profile of the cook, exposed over MCP so the user's own agent
plans their week.

## Source of truth

`docs/` holds the full specification. Read `docs/README.md` first. Do not invent
behaviour that contradicts it. If the spec is wrong, change the spec in the same
change as the code, and say so.

| Doc | Settles |
|---|---|
| `docs/00-vision.md` | Scope in and out, cost model, risks |
| `docs/01-functional-spec.md` | Vocabulary, feature rules, screens, edge cases |
| `docs/02-data-model.md` | Entities, invariants, tenancy |
| `docs/03-agent-interface.md` | MCP tools, resources, snapshot, error taxonomy |
| `docs/04-tech-spec.md` | Stack, architecture, security, recorded decisions |
| `docs/05-roadmap.md` | Phases. Check which one is current before proposing work |
| `docs/06-open-questions.md` | Assumptions and unknowns. Add to it, do not silently assume |
| `docs/07-phase-0-findings.md` | What phase 0 proved about OAuth, MCP, RLS, and Postgres 18. Read before touching any of them |

## Constraints that must never be broken

1. **No server-side LLM call.** No LLM SDK may enter the dependency tree. CI
   enforces this with an allowlist check. Any feature that seems to need an LLM
   gets restructured as a tool the user's agent calls.
2. **Strict allergens are an absolute block.** No path, UI or MCP, may assign a
   recipe containing an allergen marked strict. Server-enforced and tested. No
   override.
3. **One service layer behind both entry points.** The web UI and the MCP
   endpoint call the same services. No business rule lives only in a route
   handler, a server action, or a React component.
4. **Plan versions are immutable.** Edits create a new version. Never mutate an
   existing one except for its state transition columns.
5. **Nothing an agent does is irreversible.** Facts are retired, not deleted.
   Recipe edits keep a revision. User-visible deletes are soft for 30 days.
6. **Agent-written facts enter as `unconfirmed`.** The server overrides any other
   value. Only a human confirms a fact.
7. **Every user-owned query is scoped by `user_id`,** with row-level security as
   a second line of defence.

## Local development

Node per `.nvmrc`, Postgres 18 in a container via Podman.

```sh
npm run db:setup     # container up, all three databases, role bootstrap, migrators
npm run verify       # check:deps, typecheck, test
npm run dev
npm run dev:test     # the same server on the test database, port 3100
npm run verify:oauth # needs `npm run dev:test` running: the agent connection path
```

`npm run verify` needs only Postgres, so it stays CI-runnable. Anything needing
an HTTP server goes in a script, not in Vitest.

Three databases on the one instance: `cooking` to develop in, `cooking_test` for
`npm test`, `cooking_verify` for `npm run dev:test` and therefore for
`verify:oauth`. Names are derived by appending a suffix, so a clone needs no
extra configuration, and `TEST_*` / `VERIFY_*` override them. A name without the
right suffix is refused rather than used, which is what keeps the three apart.

The suite truncates `cooking_test` before every run, so a failed run cannot
decide what the next one sees. That is also why `verify:oauth` does not share
it: `dev:test` holds sessions and OAuth consents for as long as it runs, and a
truncate underneath it would delete the session a half-finished verification
depends on. With the split they run at the same time. `npm run dev:test --
--fresh` empties the verification database first, for when a long run of
verifications has piled up OAuth clients.

What counts as each database is decided in one place, `scripts/lib/db.mjs`,
which the setup script, the dev:test server and both Vitest setup files call.
Both URLs of a pair are checked, not only the owner one, because the pool that
gets queried is built from the app URL.

`verify:oauth` drives a real server, so isolating it is a matter of which server
you start: `npm run dev:test` serves on the test database with the allowlist open
and password sign-in on, which is what the script needs to sign itself in. It
takes port 3100 and binds loopback only, both deliberately. An open allowlist
plus password sign-in is an unauthenticated sign-up door, which has no business
on a network interface, and a port of its own is what stops `next dev` from
quietly incrementing past a busy 3000 while `verify:oauth` drives the
development server. `DEV_TEST_PORT` moves it, and both sides read it.

A schema behind the migrations on disk is refused, by the suite and by
`dev:test`, with the command that fixes it: `npm run db:setup:test` or
`npm run db:setup:verify`. Neither is re-migrated by `npm run db:migrate`, which
migrates the development database.

Two connection roles, and mixing them up defeats tenancy:

- `DATABASE_URL` is the table owner. Migrations only. Postgres exempts owners
  from row-level security, so the app must never use it at runtime.
- `APP_DATABASE_URL` is `cooking_app`, `NOBYPASSRLS`. Everything at runtime.

Every read or write of a user-owned table goes through `withUser()` in
`src/db/client.ts`. A query that forgets it returns zero rows rather than
leaking, which is intended, and is what `tests/rls.test.ts` pins down.

Schema ownership is split on purpose: Better Auth migrates its own 12 tables
(`npm run auth:migrate`), Drizzle owns the domain tables
(`npm run db:generate` then `db:migrate`). Do not hand-copy auth tables into
the Drizzle schema. Reasoning in `docs/07-phase-0-findings.md` section 3.1.

## Deployment

`compose.yaml` runs the database alone for development and the whole stack under
`--profile serve`. `deploy/compose.proxy.yaml` layers Caddy on top for automatic
TLS, and is a separate file rather than a third profile because Compose
interpolates every service whichever profile is active.

**The server never builds.** CI publishes two images per commit to GHCR, one per
shipping target of the Dockerfile, and a deploy is `git pull`, `docker compose
pull`, `up -d --no-build --wait`. The `build:` blocks stay for CI and for local
work. `IMAGE_TAG` selects the build and defaults to `main`; every commit also
gets an immutable `sha-<commit>` pair, which is what a rollback names.

Three things to know before touching any of it:

1. **Compose injects only the variables a service's `environment:` block names.**
   A value in `.env` is available for interpolation on the right-hand side and
   does not otherwise reach the process. A new variable read by `src/` needs a
   line in `compose.yaml` too.
2. **The migrator imports `src/lib/auth.ts`**, which validates its configuration
   at import time, so it needs the auth block and not only the database URLs.
   `next build` imports it as well, for `/api/auth/[...all]`, which is why the
   Dockerfile's build stage sets placeholder credentials.
3. **A tag is spelled in two files.** `compose.yaml` names what to pull and
   `ci.yml` names what to push. Nothing catches a disagreement at runtime:
   Compose reports it as a pull failure, which reads like a credentials problem.

`tests/deploy.test.ts` pins all three down, and a second CI job builds the image
and brings the stack up before a third publishes anything. Neither of those
failures can happen on a laptop, so do not trust `npm run dev` as evidence that
a deployment change works.
`docs/05-roadmap.md` under *Deployment* has the three defects that motivated it.

## Conventions

- TypeScript strict. Zod schemas are the single source of truth for validation,
  MCP tool JSON Schema, and form types.
- MCP tools live one per file in `src/mcp/tools/`, holding the Zod schema, the
  description, and the handler together. **Tool and parameter descriptions are
  product copy.** They are the only way to steer an agent we do not run, so
  review them as carefully as behaviour.
- Error messages returned to agents must be actionable by a model: a code, a
  reason, and the valid alternatives. Not `400 invalid slot`.
- UI copy is French and always externalized through `next-intl`. No hardcoded
  user-facing strings.
- Metric units, ISO week numbering with an explicit year.
- Never write an em dash in documents or UI copy.

## Commits

Conventional Commits. No co-author or generated-by trailers. Do not pass
`--author` or `-c user.email`; the repo config is already correct.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
