# 07 - Phase 0 Findings

Status: complete
Date: 2026-08-31
Resolves: T1 in `06-open-questions.md`

Phase 0 existed to answer one question before the codebase took shape: is the
OAuth 2.1 authorization server with dynamic client registration, plus a
Streamable HTTP MCP endpoint, actually a solved path? Answer: yes, and better
than the spec assumed. What follows is what the spike established, including the
things that were wrong in the original spec.

## 1. T1 resolved: the auth library covers the whole OAuth surface

The plugin is not part of `better-auth` core. It is a separate package,
`@better-auth/mcp`, versioned in lockstep with `better-auth` (both 1.7.2 here),
and it depends on `@better-auth/oauth-provider`.

The important discovery: **`mcp()` is the OAuth 2.1 / OIDC provider**, not an
add-on to one. It cannot be combined with a separate `oauthProvider()`. It
audience-binds issued tokens to the MCP `resource` per RFC 8707, publishes the
RFC 9728 protected resource metadata, and links the resource to newly registered
clients. `requireMcpAuth()` protects the route: it verifies the bearer token
against our own JWKS and answers unauthenticated calls with a JSON-RPC 401
carrying the RFC 9728 `WWW-Authenticate` header.

Verified working, headlessly, against a real server:

| Step | Result |
|---|---|
| Unauthenticated MCP call returns a 401 with `WWW-Authenticate` naming the resource metadata URL and the required scope | OK |
| RFC 9728 protected resource metadata resolves and names the authorization server | OK |
| RFC 8414 authorization server metadata resolves with `registration_endpoint`, PKCE `S256`, and all 13 scopes | OK |
| Dynamic client registration accepts a cold client and issues a `client_id` | OK |
| `/oauth2/authorize` with a session redirects to the consent page | OK |
| `/oauth2/authorize` without a session redirects to the login page | OK |
| Consent POST, code exchange, and a real `whoami` call with a live token | **Closed in phase 1.** `npm run verify:oauth` walks registration, authorize, login, consent, token exchange and an authenticated `whoami` against a running server |

**Verdict: the stack decision in `04-tech-spec.md` holds.** The OAuth plumbing
that would have been weeks of hand-rolling on the JVM was configuration here.

## 2. Things the spec got wrong

### 2.1 `requireMcpAuth` needs the resource passed explicitly

`resource` on the `mcp()` plugin does not propagate to `requireMcpAuth()`, which
defaults to the auth base URL. Left alone, the 401 challenge advertised metadata
for `/api/auth` rather than `/api/mcp`, so a client would have discovered the
wrong protected resource and never reached the MCP endpoint. Pass `resource`
explicitly in both places.

### 2.2 Exactly two well-known rewrites are needed, and no more

Better Auth mounts everything under `/api/auth`, so the issuer is
`http://host/api/auth`. The three discovery conventions do not agree on where to
look, and the difference is not cosmetic:

| Convention | Path | Needs a rewrite |
|---|---|---|
| RFC 8414, OAuth AS metadata | `{host}/.well-known/oauth-authorization-server{issuer path}` | **Yes** |
| RFC 9728, protected resource metadata | `{host}/.well-known/oauth-protected-resource{resource path}` | **Yes** |
| OpenID Connect Discovery | `{issuer}/.well-known/openid-configuration` | No, answered natively |

RFC 8414 and 9728 insert the well-known segment *before* the path; OIDC appends
it *after*. An initial attempt added rewrites for the bare root paths and for
OIDC discovery. All of them were dead config: the bare root paths are not what
any conforming client requests, and OIDC already resolves. They were removed
rather than shipped.

Rewrites are registered as `beforeFiles` so a well-known path cannot be swallowed
by a page route or the 404 handler first.

### 2.3 Postgres 18 changed its data directory convention

The `postgres:18` images place data in a major-version subdirectory and refuse to
boot against a volume mounted at `/var/lib/postgresql/data`. The mount goes one
level up, at `/var/lib/postgresql`. The container exits with code 1 and a long
explanatory log, which is easy to mistake for a permissions problem.

### 2.4 RLS needs a `nullif`, or an unscoped query errors instead of returning nothing

The tenancy design says an unscoped query must return zero rows rather than leak.
The obvious policy predicate does not do that on a pooled connection:

```sql
-- Wrong: raises 22P02 on a reused connection.
user_id = current_setting('app.user_id', true)::uuid

-- Right.
user_id = nullif(current_setting('app.user_id', true), '')::uuid
```

Once a transaction-scoped `SET LOCAL` has committed, a custom GUC with no
session-level value resets to the **empty string**, not to null, and `''::uuid`
raises `22P02 invalid input syntax`. The first unscoped query on a fresh
connection returns zero rows as intended; the first one on a *reused* connection
throws. This was caught by the phase 0 test, which is the whole argument for
writing that test before the code that depends on it.

### 2.5 An http loopback redirect URI requires `application_type: "native"`

Dynamic registration rejects `http://localhost:.../callback` for the default
`application_type: "web"`, which mandates https. Sending
`application_type: "native"` registers cleanly. This is spec-correct, and it is
worth knowing before debugging a local MCP client that cannot register.

Also observed: the `scope` returned at registration is the full set of allowed
scopes, not the subset requested. Narrowing happens at authorization time, per
grant. Do not read the registration response as the granted scope.

### 2.6 The authorize query is HMAC-signed

The redirect to `/login` and `/consent` carries the original authorization
parameters plus `ba_param` markers and a `sig`. The consent page must pass them
through untouched. Anything that rebuilds the query loses the signature and the
flow breaks.

## 3. Decisions taken during the spike

### 3.1 Better Auth owns its own tables, Drizzle owns the domain

Better Auth needs 12 tables (`user`, `session`, `account`, `verification`,
`jwks`, `oauthClient`, `oauthResource`, `oauthClientResource`,
`oauthRefreshToken`, `oauthAccessToken`, `oauthConsent`, `oauthClientAssertion`).
Hand-syncing those into the Drizzle schema, and re-syncing on every upgrade, is
pure maintenance cost on tables we never query directly.

Instead: Better Auth runs its own migrator, and Drizzle owns only the domain
tables. Two query builders against one database, which is a real cost, paid
deliberately.

The migrator is invoked as `getMigrations()` from `better-auth/db/migration`,
imported from the installed version, rather than through `@better-auth/cli`. The
published CLI was at 1.4.21 against a 1.7.2 core, and a schema migrator that can
drift from the library defining the schema is not a tool worth having.

### 3.2 The app connects as a non-owner role

Postgres exempts table owners from row-level security, so an app connecting as
the owner has RLS as decoration. `src/db/bootstrap.sql` creates `cooking_app`
with `NOBYPASSRLS`, table privileges, and default privileges for future tables.
`DATABASE_URL` is the owner and is used only by migrations; `APP_DATABASE_URL` is
the runtime role.

### 3.3 Stateless MCP transport

`WebStandardStreamableHTTPServerTransport` takes a `Request` and returns a
`Response`, which is exactly a Next route handler, and needs no Node adapter. One
server instance per request, `sessionIdGenerator: undefined`. Nothing is held
between calls, so scaling horizontally needs no shared session store.

## 4. Exit criteria

| Criterion | Status |
|---|---|
| OAuth AS with dynamic client registration reachable and conforming | Met, verified by curl against the live server |
| Streamable HTTP MCP endpoint with a `whoami` tool | Built. Token-authenticated call awaits the login and consent UI |
| RLS proven: unscoped query returns zero rows, cross-user write refused | Met, 4 passing tests against real Postgres |
| CI fails on any LLM dependency | Met, 639 packages scanned |
| French i18n with no hardcoded strings | Met for the three scaffold screens |
| Typecheck and production build clean | Met |

## 5. What phase 1 inherits

- A working OAuth authorization server, so the agent connection screen is a UI
  job rather than a protocol job.
- The `withUser()` scoping helper, which every domain query must use.
- The activity log, already written to by the `whoami` tool.
- Two stub screens (`/login`, `/consent`) that the flow already redirects to and
  that must now be built for real. Completing the consent POST is the first thing
  that closes the last open item above.

## 6. What phase 1 found while closing that item

Four more things worth knowing before touching this surface again:

1. **The signed query travels in a `oauth_query` body field.** Posting it to any
   auth endpoint makes the plugin verify it, stash it, and, when the response
   sets a session cookie, resume the authorization flow on its own and answer
   with the URL to continue to. So the login form posts `oauth_query` alongside
   the credentials and needs no resume logic of its own. It reads the query from
   `window.location.search`, because anything that parses and re-serializes it
   breaks the signature.
2. **Every state-changing auth request needs an `Origin` header.** Browsers send
   it; a script does not, and Better Auth answers `403 MISSING_OR_NULL_ORIGIN`.
   This is the CSRF protection working, and it is the first thing to check when
   driving the flow by hand.
3. **`/oauth2/authorize` answers a navigation with a redirect and a fetch with
   JSON.** It decides from `sec-fetch-mode` and `accept`. A test harness has to
   look like the browser it stands in for, or it sees an empty `location`.
4. **`/oauth2/public-client` is session-guarded and answers in snake_case.**
   Calling it from a server component means forwarding the request headers, and
   the client's name arrives as `client_name`. Both were silent failures: the
   consent screen simply stopped naming who was asking.
