# 04 - Technical Specification

Status: draft v1
Last updated: 2026-08-31
Depends on: `02-data-model.md`, `03-agent-interface.md`

## 1. The forces that decide the stack

Ranked, because the ranking is what produces the answer:

1. **The app must be an OAuth 2.1 authorization server with dynamic client
   registration.** Not a client. A server. This is non-negotiable: it is how an
   MCP client attaches to a remote MCP endpoint. It is also the single largest
   piece of undifferentiated plumbing in the project.
2. **The app must speak Streamable HTTP MCP** including session handling and
   server-sent events.
3. **Zero LLM dependency.** No AI SDK in the tree.
4. **Solo developer velocity**, with an unknown time budget, which means the
   stack must not have a slow phase.
5. **UI weight is real.** A drag-and-drop week grid, a diff review screen, and a
   mobile grocery list are not trivial screens.
6. **Self-hostable in one container plus a database.**

Force 1 dominates. It is the only requirement where the choice of ecosystem
changes the work by weeks rather than by days.

## 2. Stack decision

**TypeScript, end to end.**

| Option | OAuth server + DCR | MCP SDK maturity | UI work | Your existing skill | Verdict |
|---|---|---|---|---|---|
| **TypeScript (Next.js)** | Solved by library. Better Auth ships an MCP / OIDC provider plugin that implements the authorization server, discovery metadata, and dynamic client registration | Reference implementation. `@modelcontextprotocol/sdk` is the SDK the spec is developed against | Same language as the backend, shared types from database to component | Adjacent, not native | **Chosen** |
| Java / Quarkus or Spring | Spring Authorization Server is capable but DCR plus MCP discovery metadata is hand-wired. Days to weeks of plumbing | An official Java SDK exists and Spring AI integrates it, but it trails the spec | Separate frontend project, two build systems, hand-maintained type contract at the boundary | Strongest (your Maven habits) | Rejected: cost lands entirely on the undifferentiated part |
| Scala / http4s or ZIO | Hand-rolled OAuth server. Weeks | Thinnest ecosystem | Separate frontend | Lunatech-native | Rejected: same reason, worse |
| Python / FastAPI | Reasonable OAuth libraries, strong MCP SDK | Strong, second only to TS | Separate frontend, or server-rendered templates | Unknown | Viable runner-up |

The honest counter-argument: your JVM fluency is real, and fighting an unfamiliar
ecosystem costs time too. It loses anyway, because the JVM tax here is
concentrated precisely on OAuth and MCP transport, which are pure plumbing that
produces zero product value. Spending your strongest skill on the least
differentiated code is the wrong trade. The domain logic (validation rules,
grocery merging, snapshot composition) is where care matters, and that is
ordinary code in any language.

Verify at implementation time that the auth library's MCP/OIDC provider plugin
still covers dynamic client registration as described. If it has moved, the
fallback is a dedicated OAuth server library plus the MCP SDK's own auth helpers,
which is more wiring but still in the same ecosystem.

## 3. Concrete choices

| Concern | Choice | Reasoning |
|---|---|---|
| Runtime | Node LTS | Broadest compatibility with the MCP SDK |
| Framework | Next.js, App Router | Server components suit the read-heavy screens, route handlers host the MCP endpoint, one deployable |
| Language | TypeScript, `strict` | |
| Database | PostgreSQL 18 | JSONB for snapshots and fact evidence, full-text search for recipes, row-level security, arrays. SQLite is tempting for self-hosting but loses RLS and JSONB indexing, and multi-tenancy was an explicit requirement |
| ORM | Drizzle | SQL-shaped, typed, migrations are readable files. Matters because the schema here is the product and needs review as SQL |
| Auth | Better Auth, with the OIDC/MCP provider plugin | Sessions for the UI and the OAuth server for MCP from one library, one user table |
| MCP | `@modelcontextprotocol/sdk`, Streamable HTTP | |
| Validation | Zod, single source of truth | Same schemas generate MCP tool JSON Schema, validate HTTP payloads, and type forms. Tool descriptions live in the Zod `.describe()` calls, which keeps the "descriptions are the prompt" principle enforceable in code review |
| UI | React with Tailwind, plus a headless component library | |
| Drag and drop | `dnd-kit` | Accessible, keyboard-operable, which matters because the grid is the main screen |
| i18n | `next-intl`, French default | Keys externalized from the first commit, per the locale decision |
| Background jobs | None in v1 | Grocery generation and snapshot composition are request-time. Adding a queue before there is a job that needs one is premature |
| Recipe URL parsing | `linkedom` plus a schema.org JSON-LD reader | No LLM. Agent-assisted fallback per `03-agent-interface.md` |
| Testing | Vitest for units, Playwright for the three critical flows | |
| Deployment | A `compose.yaml` with app plus Postgres 18, run by Podman in dev and by Podman or Docker in prod. Also runs on a serverless host with a managed Postgres | Self-host is the stated posture. Stay on the plain Compose spec, no Docker-only extensions, so either runtime works |
| Observability | Structured JSON logs, plus the in-app agent activity log | The activity log is a product feature, not just telemetry |

## 4. Architecture

```
   Browser (React, Next.js)          MCP client (Claude Desktop / Code)
            |                                     |
            | session cookie                      | OAuth 2.1 bearer
            v                                     v
   +---------------------+          +---------------------------------+
   |  Next.js routes /   |          |  /api/mcp  Streamable HTTP MCP  |
   |  server actions     |          |  tools, resources, prompts      |
   +----------+----------+          +----------------+----------------+
              |                                      |
              +----------------+---------------------+
                               |
                     +---------v----------+
                     |   SERVICE LAYER    |   <-- all business rules live here
                     |  planning, recipes |
                     |  facts, grocery,   |
                     |  snapshot, pantry  |
                     +---------+----------+
                               |
                     +---------v----------+
                     |  Drizzle + Postgres|
                     |  RLS scoped        |
                     +--------------------+
```

The service layer is the load-bearing decision. Both entry points call it and
neither contains a rule. Consequences that are worth stating explicitly:

- Allergen blocking, slot validation, and version immutability cannot be bypassed
  by a caller, because no caller touches the database directly.
- The web UI and the agent cannot drift out of sync, which is otherwise
  guaranteed to happen the first time a rule changes.
- Rules are unit-testable without HTTP or MCP.

## 5. Cross-cutting concerns

### 5.1 Zero-LLM enforcement

An architectural constraint that decays silently unless it is mechanical:

- A dependency allowlist check in CI fails the build if any LLM SDK
  (`@anthropic-ai/*`, `openai`, `@google/generative-ai`, `langchain`, and
  similar) appears in the lockfile.
- No outbound HTTP from the server except recipe URL fetching, which goes through
  one audited fetch helper with an explicit purpose parameter.

### 5.2 Tenancy

- Every query goes through a request-scoped context carrying `user_id`.
- PostgreSQL row-level security is enabled on every user-owned table as a second
  line of defence, using a session variable set per connection checkout. A
  forgotten `where` clause then returns zero rows instead of leaking.
- Enabled in the first migration. Retrofitting RLS means re-auditing every query.

### 5.3 Security

- MCP endpoint: OAuth bearer only, no cookie auth, so a malicious page cannot
  drive the agent surface from a logged-in browser.
- Per-client rate limits on MCP writes.
- Recipe URL fetching is server-side request forgery bait. Mandatory: block
  private and link-local address ranges after DNS resolution, cap redirects, cap
  response size, hard timeout, allow only http and https.
- Imported recipe HTML is never rendered. Only extracted text fields are stored,
  and they are treated as untrusted on output.
- Imported and agent-authored content is data, never instruction. Recipe text and
  fact statements are never interpolated into anything executable, and the
  activity log stores payload summaries rather than raw payloads.
- Secrets from environment only. No secrets in the repository.
- Soft deletes plus a 30-day retention window, then a purge job.

### 5.4 Performance

Not a real concern at this scale, with two exceptions worth designing for:

- **Profile snapshot composition** runs on nearly every agent interaction. It
  touches facts, slots, pantry, and history. Compose it in one round trip of
  queries and cache it keyed by a per-user `context_version` counter bumped on
  any profile, fact, slot, or pantry write.
- **Recipe search** with the rotation-age and cook-rate filters joins feedback
  across all history. Materialize per-recipe aggregates if the library grows past
  a few hundred recipes.

### 5.5 Offline

The grocery list screen is used in a shop with poor signal. Ship it as a PWA with
the active list cached and check-state changes queued locally, replayed on
reconnect. Last-write-wins per line is acceptable for a checkbox. Nothing else in
the app needs offline support in v1.

## 6. Repository shape

```
/
  docs/                 these specs, source of truth
  src/
    app/                Next.js routes, French UI
      api/mcp/          the MCP endpoint
      api/auth/         auth and OAuth server routes
    domain/             pure types and rules, no I/O
    services/           the service layer
    mcp/
      tools/            one file per tool, Zod schema + description + handler
      resources/
      prompts/
    db/                 Drizzle schema and migrations
    i18n/               message catalogues, fr default
  agent-pack/           published prompt templates and skill pack
  tests/
  compose.yaml
```

`src/mcp/tools/` holding schema, description, and handler in one file per tool is
intentional: the description is product copy that must be reviewed alongside the
behavior it describes.

## 7. Decisions recorded

| # | Decision | Alternative rejected | Why |
|---|---|---|---|
| 1 | No server-side LLM, ever | In-app agent | Zero marginal cost is a stated hard constraint and the whole business model |
| 2 | TypeScript end to end | JVM or Scala | OAuth server plus DCR plus MCP transport is solved in TS and hand-rolled elsewhere |
| 3 | Postgres, not SQLite | SQLite for easy self-host | RLS, JSONB, full-text search, and the multi-tenant requirement |
| 4 | Service layer shared by UI and MCP | Separate implementations | Rules cannot drift, and cannot be bypassed |
| 5 | Immutable plan versions | Mutable plan with an audit trail | Makes every agent action revertible and diffable, which is what makes proposal mode safe |
| 6 | Facts atomic and typed, not a text blob | Free-text about-me | Enforceable allergies, prunable context, visible contradictions |
| 7 | Agent facts enter unconfirmed | Trust agent writes | The fact store is the moat. Poisoning it is the top product risk |
| 8 | Rationale required on agent entries | Optional | Makes personalization inspectable and correctable at the cause |
| 9 | `check_feasibility` dry run | Validate only on write | Turns validation from a wall into a tool, biggest win per line of code |
| 10 | Per-user normalized ingredients | Global shared table | Avoids shared-vocabulary governance in a self-hosted app; aisles are per supermarket |
| 11 | Pantry has no numeric quantities | Full inventory | Bookkeeping is what kills pantry features |
| 12 | RLS from the first migration | Add later | Retrofit means auditing every query path |
