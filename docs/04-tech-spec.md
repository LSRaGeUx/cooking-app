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
| UI | React with Tailwind v4, design tokens in `src/app/globals.css` | No component library. The whole interface is six primitives over one token set, so a headless library would add a dependency and a second vocabulary for the same controls. Fonts are pulled at build time by `next/font` and served from this origin, so a self-hosted install makes no request to Google |
| Drag and drop | `dnd-kit` | Accessible, keyboard-operable, which matters because the grid is the main screen |
| i18n | `next-intl`, French default | Keys externalized from the first commit, per the locale decision |
| Background jobs | None in v1 | Grocery generation and snapshot composition are request-time. Adding a queue before there is a job that needs one is premature |
| Recipe URL parsing | `linkedom` plus a schema.org JSON-LD reader | No LLM. Agent-assisted fallback per `03-agent-interface.md` |
| Testing | Vitest for units, Playwright for the three critical flows | |
| Deployment | A `compose.yaml` with app plus Postgres 18, run by Podman in dev and by Podman or Docker in prod. Also runs on a serverless host with a managed Postgres | Self-host is the stated posture. Stay on the plain Compose spec, no Docker-only extensions, so either runtime works |
| Observability | Structured JSON logs, plus the in-app agent activity log | The activity log is a product feature, not just telemetry |

### 3.1 Design language

"Bloc". The interface is not a document, it is a board, and four rules hold it
together.

**Everything is a rectangle on a lattice.** A 2px ink rule separates cells, edge
to edge, with no gaps, no rounded corners and no shadows. `.wall` draws its top
and left rule and every child draws its right and bottom, so any grid becomes a
continuous mesh with no doubled lines. There is no centred column and the shell
gives no padding: screens are built from full-width bands, and a screen that is
genuinely one column of prose opts back into a margin with `.page`.

**Colour is structural.** A filled block means planned, bought, confirmed, or
today. Empty is white, out of play is hatched. Tomato is the cook: primary
actions, today's column, the wordmark. Cobalt is the agent, and only the agent:
proposals, unconfirmed facts, the activity log. There is no decorative colour.

**Every recipe owns one flat colour**, derived from its id
(`src/lib/recipe-seal.ts`), and wears it in the library tile, its cell in the
week, the edge of every shopping line it caused, and its own page. Derived,
never stored, so it costs no column and cannot drift.
`tests/domain/recipe-seal.test.ts` pins the stability and the spread.

**One typeface.** Bricolage Grotesque has a width axis and an optical size axis,
so the same family sets a 15px label and a 140px week number, condensed hard at
poster sizes. A second family would be a second voice. JetBrains Mono is a
stamp, not a voice: only strings a machine wrote or measured exactly, such as
the MCP endpoint, a tool name or a shell command.

Light is the product and dark is a preference, chosen on the settings index and
stored in a cookie so the server renders the right ground on the first byte
(`src/lib/theme.ts`).

Navigation is a bar welded into the top rule, not a rail: the four cooking
screens are blocks that fill with ink where you are, and the nine settings
screens live behind one block that opens the viewport as an index. Configuration
is not a peer of cooking. On a phone the four blocks move to the bottom, because
the grocery list is used one-handed in a shop.

The week screen is the clearest case of the whole language: meal types are rows
and days are columns, which is what the data actually is, and a planned meal
fills its cell with its own colour. The week is legible as a pattern before a
single title is read. Below 1024px it becomes a stack of day bands instead,
chosen in JavaScript rather than hidden with CSS: the two structures share
drag-and-drop ids, and two droppables with the same id is a silent bug. The
`DndContext` carries a fixed `id` for the same reason, so the accessibility
ids it generates do not depend on which structure rendered first.

Full width is for lattices, not for lines. A shopping row is no more usable for
having 1500 pixels between its checkbox and its delete button, so bands keep
their rules edge to edge while the content inside them sits in `.measure`, and
screens that are genuinely a form rather than a grid use `.page`, which is
centred and capped.


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

- Sign-in is Google OAuth, and an address allowlist in the environment
  (`ALLOWED_EMAILS`) decides who may hold an account. Google proves the address,
  it does not grant access: every Google account on earth can reach the callback,
  so the allowlist is the control and the provider is only the proof. It is
  enforced in `user.validateUserInfo`, which Better Auth calls on account
  creation, on account linking and on OAuth sign-in. An empty list is open in
  development and closed in production, because an instance facing the internet
  with no list configured has no door on it.
- That gate covers the way in and nothing else. It does not run when an existing
  account signs in with a password, and it cannot reach a session cookie or an
  access token already issued, so removing an address does not on its own end an
  access already granted. The allowlist is therefore re-read on the way through
  too: in `requireUser()`, on the consent screen, and on every MCP call, where a
  refusal is `ACCESS_REVOKED`. Without the last one an agent connected before the
  removal keeps working for the full hour its token is valid, and a surviving
  cookie authorizes a new client and mints another hour on demand.
- Email and password sign-in is off unless `AUTH_PASSWORD_LOGIN` is set, and even
  then it lives on the auth API only. No screen offers it, and there is no
  sign-up route. It exists for local development and for `verify:oauth`, which
  cannot drive a Google consent screen. A second door into the same accounts is a
  second door to defend, so it is not advertised and it is closed in production.
  Closed means the endpoints answer `400` with `EMAIL_PASSWORD_DISABLED` rather
  than `404`, and the container is never given the flag: `compose.yaml` does not
  pass it, and CI asserts the refusal against the running stack.
- Account linking is disabled. One provider has nothing to link, and disabling it
  removes the case where a second identity claiming an allowlisted address
  inherits the account that already holds it.
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
- Secrets from environment only. No secrets in the repository. Compose names
  every variable the runtime reads, because a value present in `.env` is
  available for interpolation but does not reach the process unless it is
  listed. `AUTH_PASSWORD_LOGIN` is deliberately not listed, so the container
  cannot open the password endpoints however the file is edited.
- Response headers are set in `next.config.ts`: `nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`,
  a `Cross-Origin-Opener-Policy` that still allows a sign-in popup, and a
  `Permissions-Policy` that turns off the device APIs nothing here uses.
  `Strict-Transport-Security` belongs to the proxy, which terminates the TLS the
  header is about, and `deploy/Caddyfile` sends it. There is no
  Content-Security-Policy yet: Next inlines its own bootstrap script, so a
  useful policy needs per-request nonces threaded through the root layout, and
  one loose enough to skip that buys nothing. Recorded as a gap.
- `/api/health` is unauthenticated on purpose, because a container healthcheck
  and an uptime monitor both run without a session. It answers `select 1` on the
  runtime pool as up or not up, and carries no version, no configuration and no
  error text. The reason for a failure goes to the server log.
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
  scripts/              operator and development commands, backup.sh among them
  deploy/               Caddyfile and the compose overlay that mounts it
  compose.yaml          database for development, whole stack under --profile serve
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
| 13 | One CSS token set, no component library | Radix or Ark headless primitives | The app needs six primitives over one token set, and a library would add a dependency plus a second vocabulary for the same controls |
| 14 | Ember for the cook, woad for the agent | A single accent colour | Provenance is a domain concept here: who wrote a fact, who proposed a week. A reserved colour answers it before a label is read |
| 15 | Recipe colour derived from the id | A stored colour, or a colour the user picks | Costs no column, no migration and no decision, and cannot fall out of sync. A picker would also be one more thing to fill in before the app is useful |
| 16 | Light default, dark opt in, cookie not media query | Follow `prefers-color-scheme` | Following the system meant most users only ever saw the design inverted. A cookie also lets the server render the right ground on the first byte |
| 17 | No centred column, screens are full-width bands | A page container with a max width | The week is a lattice of meal types by days; a container puts a gutter down both sides of it and turns every screen back into a document |
| 18 | Meal types as rows, days as columns | Seven day cards, each listing its own meals | Dinner is one thing across the week, not seven unrelated items. The row-by-column form is what the data is, and it makes the week readable as a pattern |
| 19 | Settings behind a panel, not a takeover | A full-screen index | Blanking the screen to change a setting loses the thing you were changing it for. Nine screens still do not deserve permanent shelf space next to four |
| 20 | Google sign-in plus an environment allowlist | Open sign-up behind a reverse proxy password, or an invite table with an admin screen | A proxy password is a shared secret with no identity behind it, and an invite table needs a screen, a role and a first admin. A list of addresses in the environment is the smallest thing that names who gets in, and Google supplies the proof that an address is theirs |
| 21 | CI builds the images, the server pulls them | Building on the server with `--build` | `next build` sets the memory floor for the whole deployment, and the target is amd64 while development happens on arm64. Building in CI drops the floor to what serving needs and removes the architecture question. It also means only what passed both CI jobs can be deployed at all |
| 22 | Server pulls, CI does not push | A deploy step that SSHes into the host | A push-based deploy needs a host key in GitHub secrets that is root-equivalent on the server. For one operator, two commands over SSH are cheaper than that blast radius |
| 23 | One package, two tags, and a moving tag plus an immutable one | Two packages, or a tag per release | One registry repository is one login and one visibility setting to get wrong. `main-*` is what a deploy defaults to and `sha-<commit>-*` is what a rollback names, so reverting is an environment variable rather than a git operation |
