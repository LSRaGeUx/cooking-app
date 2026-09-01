# 08 - Self-hosting

Everything an operator needs to run this on their own machine and keep it
running. It assumes no knowledge of the rest of `docs/`.

The product is built for one household on one server. There is no multi-tenant
control plane, no billing, no telemetry, and no outbound call to any AI service:
the intelligence comes from the agent the user already runs, which connects in
over MCP.

---

## 1. What you need

| Requirement | Why |
|---|---|
| Node, version in `.nvmrc` | The application runtime |
| PostgreSQL 18 | `uuidv7()` is used natively, and 18 is what the RLS setup is tested against |
| Podman or Docker | Only to run Postgres. `compose.yaml` is plain Compose spec and works under both |
| A domain and TLS, for anything beyond localhost | OAuth 2.1 and the MCP resource identifier both need https off the loopback |

Roughly 300 MB of disk for the database after a year of ordinary use, plus the
Node install. It runs comfortably on the smallest VPS you can rent.

---

## 2. First install

```sh
git clone <your fork> cooking-app
cd cooking-app
cp .env.example .env
```

Edit `.env` (section 3 below explains every line), then:

```sh
npm ci
npm run db:setup     # container up, role bootstrap, domain migrations, auth migrations
npm run build
npm run start
```

Open the app, create an account, and you land on the current week. A new account
is seeded with three meal types, dinner planned every day, and a starter
ingredient vocabulary, so grocery merging and allergen derivation work from the
first recipe rather than after an afternoon of data entry.

There is no admin user and no invite flow. Anyone who can reach `/signup` can
create an account. If the instance is on the public internet and meant for one
household, put it behind whatever your reverse proxy offers, or take the sign-up
route out.

---

## 3. Configuration

Every variable is server-side. There are no `NEXT_PUBLIC_` variables, so nothing
here reaches a browser.

| Variable | Required | What it is |
|---|---|---|
| `DATABASE_URL` | yes | The **owner** role. Migrations, and Better Auth's own pool. Postgres exempts a table owner from row-level security, so this must never be the runtime connection |
| `APP_DATABASE_URL` | yes | The **runtime** role, `cooking_app`, created `NOBYPASSRLS` by `npm run db:bootstrap`. Every application query uses it. The application refuses to boot without it rather than falling back to the owner and silently losing tenancy enforcement |
| `BETTER_AUTH_SECRET` | yes | Signing key for sessions and for the HMAC on the OAuth authorize query. Generate with `openssl rand -base64 32`. Changing it signs everyone out |
| `BETTER_AUTH_URL` | in production | The public origin, for example `https://cuisine.example.com`. It is the OAuth issuer and the base of every redirect URI. Defaults to `http://localhost:3000`, which in production means agents get sent to a localhost that is not yours |
| `MCP_RESOURCE` | yes | The canonical protected-resource identifier, RFC 8707 and RFC 9728. Set it to `https://<your host>/api/mcp`. It must match the address users paste into their client exactly, or token audience validation refuses every call |

Three variables exist only for `npm run verify:oauth` and are irrelevant in
production: `VERIFY_BASE_URL`, `VERIFY_EMAIL`, `VERIFY_PASSWORD`.

### The two database roles

This is the one piece of configuration worth understanding rather than copying.

- `DATABASE_URL` owns the tables. Migrations run as this role, and it can read
  everything.
- `APP_DATABASE_URL` is `cooking_app`, created `NOBYPASSRLS`. Every row-level
  security policy applies to it.

At runtime, every query on a user-owned table runs inside `withUser()`, which
opens a transaction and issues `SET LOCAL app.user_id`. Each policy compares that
setting against the row's `user_id`. A query that forgets `withUser()` returns
zero rows instead of another user's data, which is the intended failure and is
pinned down by `tests/rls.test.ts`.

Mixing the two up defeats the whole mechanism without producing a single error,
which is why the application will not start with only `DATABASE_URL` set.

### Behind a reverse proxy

Terminate TLS at the proxy and forward to the Node process. The two things that
must be right:

1. `BETTER_AUTH_URL` and `MCP_RESOURCE` use the public https origin, not the
   internal one. Discovery documents are generated from them, and a client that
   is told to authorise against `http://127.0.0.1:3000` will fail in a way that
   looks like a client bug.
2. Do not strip or rewrite the `/.well-known/` paths. Two rewrites in
   `next.config.ts` are what let an MCP client discover the authorization server
   at all. Section 5 of `docs/07-phase-0-findings.md` explains why they exist.

There is no `X-Forwarded-*` handling to configure: nothing in the application
reads the request host.

---

## 4. Day to day

```sh
npm run start        # production server
npm run verify       # dependency allowlist, typecheck, tests. Needs only Postgres
npm run verify:oauth # the whole agent connection path, against a running server
```

`npm run verify:oauth` is worth running once after any change to the domain, the
proxy or the secrets. It walks exactly what a real MCP client does: cold dynamic
client registration, an authorization request with PKCE, login, consent, the code
exchange, an authenticated `whoami`, and a check that an unauthenticated call is
still refused with correct RFC 9728 discovery. It is re-runnable and leaves the
account in a usable state.

### Backups

One database, no file storage, no object store. Recipe images are addresses, not
uploads, so there is nothing on disk to back up beyond Postgres itself.

```sh
podman compose exec -T db pg_dump -U cooking -Fc cooking > cooking-$(date +%F).dump
```

Restore into an empty database with `pg_restore -d cooking -U cooking`. Take a
dump before every upgrade.

Users can also export their own data from the Account screen: one JSON file with
the profile, facts, recipes, weeks, grocery lists, feedback and the agent log,
readable without this application. That is a portability guarantee, not a backup
strategy, since it holds no auth tables.

### Upgrades

```sh
git pull
npm ci
npm run db:migrate    # Drizzle, the domain tables
npm run auth:migrate  # Better Auth, its own 12 tables
npm run build
npm run start
```

Schema ownership is split on purpose and the two migrators must both run.
Drizzle owns the domain tables; Better Auth migrates its own. The reasoning is in
section 3.1 of `docs/07-phase-0-findings.md`. Do not hand-copy auth tables into
the Drizzle schema.

---

## 5. What is exposed, and what it can do

The MCP endpoint is at `/api/mcp`. A user connects a client by pasting that one
address; discovery, dynamic client registration and consent follow from it.

Access is per client, not per user: each client gets its own token, its own
scopes and its own row in the connected-clients list, and revoking one does not
touch the others. Revocation is immediate, including for a token already issued,
because the consent row is re-checked on every single call rather than trusted
from the token.

Every call passes through one guard: scopes, then the revocation check, then a
rate limit of 120 calls per minute counted from the activity log, then the tool
itself, then a log line either way. There is no path around it.

What an agent cannot do, by construction:

- Assign a recipe containing an allergen the user marked strict. Server-enforced
  on every write path, with no override and no scope that unlocks it.
- Delete anything. Facts are retired, recipes keep a revision, user-visible
  deletes are soft for 30 days.
- Confirm a fact about the user. Agent-written facts enter `unconfirmed` and the
  server overrides any other value the agent sends.
- Silently rewrite a plan. Versions are immutable; an edit creates a new version
  and the previous one stays readable and restorable.

### Outbound network

The application makes exactly one kind of outbound request: fetching a page the
user asked to import a recipe from. It goes through `src/lib/safe-fetch.ts`,
which resolves the hostname, refuses loopback, private ranges, carrier NAT,
link-local and cloud metadata addresses, then pins the validated address onto the
socket so a second DNS answer cannot redirect it. Redirects are capped at three
and every hop is revalidated, the body is capped at 2 MB and the whole request at
8 seconds.

Recipe images are not fetched by the server at all. They are addresses rendered
in the reader's browser, which means the site hosting the image sees the visit.
The recipe form says so, and the field can be left empty.

No LLM SDK is in the dependency tree, and `npm run check:deps` fails the build if
one appears.

---

## 6. Offline and installation

The grocery list is the one screen used somewhere with no signal, so it is the
only screen the service worker caches. Everything else goes to the network:
serving a stale plan is worse than an error.

Ticking a line that cannot reach the server is queued in the browser and replayed
when the connection returns, rather than being silently reverted. The screen says
how many ticks are waiting. The queue is keyed by line, so ticking and unticking
the same item collapses to one write.

The application is installable as a PWA. The service worker registers only in a
production build; in development any leftover worker is unregistered instead, so
a cached response never turns into a confusing bug.

---

## 7. When something is wrong

| Symptom | Cause |
|---|---|
| `APP_DATABASE_URL must be set` at boot | The runtime role is missing. Run `npm run db:bootstrap` |
| Every list is empty although the database has rows | A query that skipped `withUser()`. That is RLS working, not a data loss. The offending query returns zero rows |
| An MCP client cannot find the authorization server | `MCP_RESOURCE` or `BETTER_AUTH_URL` does not match the public origin, or the proxy is swallowing `/.well-known/`. Run `npm run verify:oauth` |
| `invalid audience` on every tool call | `MCP_RESOURCE` differs from the address the user pasted, down to the trailing path |
| Consent page opens but the client never returns | The client's registered redirect URI does not match the one it is now using. Revoke it from the Agent screen and connect again |
| Recipe import says the page publishes no structured recipe | It genuinely does not. This is a deliberate clean refusal rather than a guess: ask the agent to read the page and call `create_recipe` |
| Everyone signed out after a deploy | `BETTER_AUTH_SECRET` changed |

The Agent screen carries an activity log of every read and write an agent has
made, with the tool, the client, the result and the time. It is the first place
to look when a proposal is surprising.

---

## 8. Deleting an account

The Account screen deletes for real: all domain rows, then the Better Auth user,
which takes the sessions, the registered OAuth clients and their consents with
it. There is no grace period, which is why it is behind a typed confirmation.

The 30-day soft delete in this product covers recipes and plans. It does not
cover the decision to leave.
