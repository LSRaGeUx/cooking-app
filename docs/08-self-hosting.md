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
| Podman or Docker | Runs Postgres, and optionally the application too. `compose.yaml` is plain Compose spec and works under both |
| A domain and TLS, for anything beyond localhost | OAuth 2.1 and the MCP resource identifier both need https off the loopback |

Roughly 300 MB of disk for the database after a year of ordinary use, plus the
Node install. It runs comfortably on the smallest VPS you can rent.

---

## 2. First install

Two ways. Containers if you want the server to hold nothing but Docker, from
source if you would rather run Node directly.

### 2.1 With containers (recommended for a server)

```sh
git clone <your fork> cooking-app
cd cooking-app
cp .env.example .env
```

Edit `.env`, then:

```sh
docker compose --profile serve up -d --build
```

That builds the image, waits for Postgres to report healthy, runs the role
bootstrap and both migrators once, and only then starts the application. The
`serve` profile is what keeps this out of the way in development: `npm run
db:up` still brings up the database alone.

Three variables have no default and the stack refuses to start without them,
which is deliberate: an instance that came up with a placeholder secret, or with
`localhost` as its OAuth issuer, fails in a way nobody notices until an agent
cannot connect.

- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL`
- `MCP_RESOURCE`

A fourth thing is checked at start-up: there has to be a way in. Set
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, or `AUTH_PASSWORD_LOGIN=true`,
or the application refuses to boot rather than serving a login screen with no
button on it. Section 3 has the Google side of it, and the allowlist that
decides who the button actually lets in.

The database URLs are built by `compose.yaml` and point at the `db` service, so
the values in `.env` for those two are used only when running from source.
Override the credentials with `POSTGRES_USER`, `POSTGRES_PASSWORD`,
`POSTGRES_DB` and `APP_DB_PASSWORD`.

Both the application and Postgres publish on loopback only. Nothing is reachable
from outside the machine until a reverse proxy is put in front, which is covered
in section 3.

Updating is the same command:

```sh
git pull && docker compose --profile serve up -d --build
```

The image is Next's standalone output: about 230 MB, with no npm and no
TypeScript toolchain in it. Schema changes need `drizzle-kit` and `tsx`, which
are development dependencies, so they run from a separate one-shot `migrate`
service rather than being carried into the image that faces the internet.

### 2.2 From source

```sh
git clone <your fork> cooking-app
cd cooking-app
cp .env.example .env
```

Edit `.env` (section 3 below explains every line), then:

```sh
npm ci
npm run db:setup     # container up, role bootstrap, both databases, both migrators
npm run build
npm run start
```

Open the app, create an account, and you land on the current week. A new account
is seeded with three meal types, dinner planned every day, and a starter
ingredient vocabulary, so grocery merging and allergen derivation work from the
first recipe rather than after an afternoon of data entry.

There is no admin user and no invite screen. Access is decided by
`ALLOWED_EMAILS`, a list of addresses in the environment, and changing it means
editing the file and restarting. That is the whole mechanism, and it is enough
for a household. `docs/04-tech-spec.md` section 5.3 says why it is not a table.

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
| `GOOGLE_CLIENT_ID` | for Google sign-in | The OAuth client from the Google Cloud console. Both Google variables are needed together, or neither takes effect |
| `GOOGLE_CLIENT_SECRET` | for Google sign-in | The matching secret |
| `ALLOWED_EMAILS` | in production | Comma-separated addresses allowed to hold an account, matched exactly after trimming and lowercasing. Empty is open in development and closed in production |
| `AUTH_PASSWORD_LOGIN` | no | `true` opens the email and password door. Development only: it is what `npm run verify:oauth` signs in with, and it exposes `/signup`. Unset in production |
| `TEST_DATABASE_URL` | no | Development only. Where the test database lives, if not beside the development one. Defaults to `DATABASE_URL` with `_test` appended, and the name must end in `_test`: the suite truncates every table in it |
| `TEST_APP_DATABASE_URL` | no | Development only. The runtime role's URL for that same database. It must name the same database as `TEST_DATABASE_URL` and carry the same password as `APP_DATABASE_URL`, since `cooking_app` is one cluster-wide role |
| `DEV_TEST_PORT` | no | Development only. Where `npm run dev:test` serves and `npm run verify:oauth` looks. Defaults to 3100, loopback only |

Three variables exist only for `npm run verify:oauth` and are irrelevant in
production: `VERIFY_BASE_URL`, `VERIFY_EMAIL`, `VERIFY_PASSWORD`.

### The reference instance

The deployment this project is written against runs at
`https://cooking.yanadam.fr`, which makes the three host-shaped values concrete:

```sh
BETTER_AUTH_URL=https://cooking.yanadam.fr
MCP_RESOURCE=https://cooking.yanadam.fr/api/mcp
# Authorised redirect URI on the Google OAuth client:
# https://cooking.yanadam.fr/api/auth/callback/google
```

All three carry the same origin, and they have to. A mismatch between the issuer
and the resource identifier surfaces as an audience rejection on every MCP call,
and a mismatch on the redirect URI surfaces as `redirect_uri_mismatch` before
Google shows a consent screen at all.

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

### Google sign-in, and who gets in

Two separate things, and conflating them is the mistake worth avoiding.

**Google decides that an address is really yours.** In the Google Cloud console,
create a project, then an OAuth client of type *Web application*. Its authorised
redirect URI is `<BETTER_AUTH_URL>/api/auth/callback/google`, spelled exactly,
including the scheme. The only scopes used are `openid`, `email` and `profile`,
all non-sensitive, so the consent screen needs no Google review and the app can
be published without the hundred-user cap that testing mode imposes. Nothing
about this step restricts anybody: every Google account on earth can complete it.

**`ALLOWED_EMAILS` decides who is let in.** It is checked server-side when an
account is created, when an account is linked, and on every Google sign-in, so
taking an address out of the list locks out the next sign-in from it. It does not
revoke a session already issued: to evict somebody immediately, remove them from
the list and delete their user row.

An address that is not on the list is sent back to `/login` with an explanation
and no account is created. If the list is empty on a production instance, nobody
gets in at all and the login screen names the missing variable. That is the
intended failure: an instance on the public internet with no list configured has
no door on it.

Account linking is switched off. With one provider there is nothing to link, and
switching it off removes the case where a second identity claiming an allowlisted
address inherits the account that already holds it.

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
npm run verify:oauth # the whole agent connection path, against `npm run dev:test`
```

`npm run verify:oauth` is worth running once after any change to the domain, the
proxy or the secrets. It walks exactly what a real MCP client does: cold dynamic
client registration, an authorization request with PKCE, login, consent, the code
exchange, an authenticated `whoami`, and a check that an unauthenticated call is
still refused with correct RFC 9728 discovery. It is re-runnable and leaves the
account in a usable state.

### Backups

One database worth backing up, no file storage, no object store. Recipe images
are addresses, not uploads, so there is nothing on disk to back up beyond
Postgres itself. A development machine also has `cooking_test` beside it, which
is disposable by construction and wants no backup.

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

Sign-in is Google only, gated by `ALLOWED_EMAILS`. There is no self-service
sign-up route in a production configuration: `/signup` exists only while
`AUTH_PASSWORD_LOGIN` is set, and redirects to `/login` otherwise.

One endpoint is deliberately open and worth knowing about: OAuth dynamic client
registration accepts unauthenticated registrations, because an MCP client
arriving cold has no `client_id` and no way to get one otherwise. Registering a
client grants nothing on its own. Nothing is readable until a signed-in user
completes consent, and that user has to be on the allowlist.

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
