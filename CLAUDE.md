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
npm run db:setup     # container up, both databases, role bootstrap, both migrators
npm run verify       # check:deps, typecheck, test
npm run dev
npm run dev:test     # the same server on the test database, port 3100
npm run verify:oauth # needs `npm run dev:test` running: the agent connection path
```

`npm run verify` needs only Postgres, so it stays CI-runnable. Anything needing
an HTTP server goes in a script, not in Vitest.

Two databases. `npm test` runs against `cooking_test`, never against the database
you develop in, and the suite truncates it before every run so a failed run
cannot decide what the next one sees. The names are derived by appending `_test`,
so a clone needs no extra configuration, and `TEST_DATABASE_URL` and
`TEST_APP_DATABASE_URL` override them. Anything not named with a `_test` suffix
is refused rather than truncated.

What counts as the test database is decided in one place, `scripts/lib/db.mjs`,
which the setup script and both Vitest setup files call. Both URLs are checked,
not only the owner one, because the pool the tests query through is built from
the app URL.

`verify:oauth` drives a real server, so isolating it is a matter of which server
you start: `npm run dev:test` serves on the test database with the allowlist open
and password sign-in on, which is what the script needs to sign itself in. It
takes port 3100 and binds loopback only, both deliberately. An open allowlist
plus password sign-in is an unauthenticated sign-up door, which has no business
on a network interface, and a port of its own is what stops `next dev` from
quietly incrementing past a busy 3000 while `verify:oauth` drives the
development server. `DEV_TEST_PORT` moves it, and both sides read it.

`npm run dev:test` and `npm test` share `cooking_test`, so do not run them at the
same time: the suite truncates that database on the way in. It will not corrupt
anything silently, it fails with a message naming dev:test, but the running
server loses its session and the verification has to start over.

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
