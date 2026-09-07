/**
 * End-to-end check of the agent connection path, against a running server:
 *
 *   npm run dev:test       # in one terminal
 *   npm run verify:oauth   # in another
 *
 * dev:test, not dev: this script signs up, registers OAuth clients and writes a
 * recipe and a plan, and dev:test is the server that puts all of that in the
 * verification database. Both agree on the port through scripts/lib/dev-test.mjs.
 *
 * It walks the whole thing the way a real MCP client does: cold dynamic client
 * registration, an authorization request with PKCE, the login and consent
 * screens, the code exchange, an authenticated `whoami`, and a final check that
 * an unauthenticated call is still refused with RFC 9728 discovery.
 *
 * This lives as a script rather than a Vitest file because it needs an HTTP
 * server, and `npm run verify` must stay runnable with nothing but Postgres.
 * Phase 4 promotes this surface to production quality and is where it earns
 * automated coverage.
 *
 * Two details are load-bearing and easy to get wrong when driving this by hand:
 * every state-changing request needs an `Origin` header, and the authorization
 * request must look like a navigation or the provider answers with JSON instead
 * of a redirect.
 *
 * ---------------------------------------------------------------------------
 * How it is built, which matters as much as what it checks
 * ---------------------------------------------------------------------------
 *
 * 1. **Numbered steps, each a function returning what the next one needs.** It
 *    used to be one flat file of top-level awaits over shared mutable state, so
 *    a failed sign-in was followed by thirty steps failing for the same reason
 *    and the real cause was thirty lines up the scrollback.
 *
 * 2. **A precondition failure aborts.** `must()` records the step and then
 *    stops the run. Anything that cannot be true if the step above it failed is
 *    behind one.
 *
 * 3. **Every response body goes through `readJson`.** A Next error page, or a
 *    502 from a half-started server, is not JSON, and `response.json()` on it
 *    throws an unhandled rejection: the run ends on a stack trace with no FAIL
 *    line, which looks like a bug in the script rather than in the server.
 *
 * 4. **Every request has a timeout.** A server that accepts a connection and
 *    never answers used to hang this forever, which in CI is a job that burns
 *    its whole budget and reports nothing.
 *
 * 5. **The OAuth dance is one set of functions, called twice.** Registering,
 *    authorizing, consenting and exchanging were written out a second time for
 *    the narrow-scope client, with the checks left off, so a failure there
 *    surfaced five steps later as something unrelated.
 */
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { devTestOrigin } from "./lib/dev-test.mjs";

const BASE = process.env.VERIFY_BASE_URL || devTestOrigin();
const REDIRECT = "http://localhost:9999/callback";
// Truthiness throughout, matching scripts/lib/db.mjs: an override that is
// present but empty, which is what an uncommented and unfilled line in .env
// produces, is not an address and not a password.
const EMAIL = process.env.VERIFY_EMAIL || "cook@example.test";
const PASSWORD = process.env.VERIFY_PASSWORD || "motdepasse123";

/** Long enough for a cold `next dev` to compile a route, short enough to end. */
const TIMEOUT_MS = 15000;

const WIDE_SCOPE =
  "openid profile:read profile:write recipes:read recipes:write plan:read plan:write pantry:read feedback:read";

/** The week this writes into. Far enough out to be nobody's real plan. */
const PROPOSAL_WEEK = { year: 2026, week: 50 };

/**
 * Session state, and the only state that is shared. The cookie jar stands in
 * for the browser this script is impersonating, and the failure count is the
 * exit code. Everything else is threaded through return values.
 */
const cookieJar = new Map();
let failures = 0;

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

/** Thrown by `must` to end the run. Never printed: the step already was. */
class Precondition extends Error {}

function step(name, ok, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures += 1;
  return ok;
}

/** A step nothing after it can be interpreted without. */
function must(name, ok, detail = "") {
  if (!step(name, ok, detail)) {
    throw new Precondition(name);
  }
}

function storeCookies(response) {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const index = pair.indexOf("=");
    if (index > 0) cookieJar.set(pair.slice(0, index), pair.slice(index + 1));
  }
}

function cookieHeader() {
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/**
 * Every request in this file, so the timeout cannot be forgotten on one of
 * them. An abort surfaces as a TimeoutError, which the runner below turns into
 * a FAIL naming the URL rather than an unhandled rejection.
 */
async function request(path, init = {}) {
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  try {
    return await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...init,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`request to ${url} failed: ${reason}`);
  }
}

async function post(path, body, extra = {}) {
  const response = await request(path, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      // A browser always sends this; Better Auth refuses state-changing
      // requests without it, which is the CSRF protection doing its job.
      origin: BASE,
      cookie: cookieHeader(),
      ...extra,
    },
    body: JSON.stringify(body),
  });
  storeCookies(response);
  return response;
}

/** A GET carrying the session, the way the browser would send it. */
function get(path, extra = {}) {
  return request(path, { headers: { cookie: cookieHeader(), ...extra } });
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

/**
 * The body of any response, parsed if it is JSON and described if it is not.
 * `{ raw: "<!DOCTYPE html>..." }` in a FAIL detail is a diagnosis; a stack
 * trace from `response.json()` is not.
 */
async function readJson(response) {
  return safeJson(await response.text());
}

// ---------------------------------------------------------------------------
// The OAuth dance, once, for both clients
// ---------------------------------------------------------------------------

/** Dynamic client registration, cold, with no credentials at all. */
async function registerClient(name) {
  const response = await request("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    }),
  });
  const body = await readJson(response);
  must(
    `dynamic client registration (${name})`,
    response.status < 300 && typeof body.client_id === "string",
    body.client_id ?? JSON.stringify(body).slice(0, 200),
  );
  return body.client_id;
}

/**
 * The provider answers a navigation with a 302 and a fetch with a JSON redirect
 * descriptor, so both shapes have to be read.
 */
async function redirectLocationOf(response) {
  const header = response.headers.get("location");
  if (header) return header;
  const body = await readJson(response.clone());
  return body.url ?? body.redirect_uri ?? "";
}

/**
 * An authorization request with PKCE, up to the consent screen.
 *
 * Returns the verifier as well as the consent URL, because the verifier and the
 * code have to come from the same exchange and pairing them by hand across two
 * copies of this is how the second copy lost its checks.
 */
async function authorize(clientId, scope, label) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope,
    state: `state-${label}`,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${BASE}/api/mcp`,
  });

  const response = await request(`/api/auth/oauth2/authorize?${query}`, {
    redirect: "manual",
    headers: {
      cookie: cookieHeader(),
      // The provider answers a navigation with a redirect and a fetch with
      // JSON, so the harness has to look like the browser it is standing in for.
      accept: "text/html,application/xhtml+xml",
      "sec-fetch-mode": "navigate",
    },
  });
  storeCookies(response);

  const location = await redirectLocationOf(response);
  // No fallback to /consent. It used to guess that path when the redirect was
  // missing, and then carried on with a consent query that was not signed by
  // anything, so the next four steps failed for a reason that had nothing to do
  // with what they were checking.
  must(
    `authorize redirects a signed-in user to the consent screen (${label})`,
    location.includes("/consent"),
    location ? location.slice(0, 120) : `status ${response.status}`,
  );

  return { consentUrl: new URL(location, BASE), verifier };
}

/** Accept, handing the signed query back untouched. */
async function acceptConsent(consentUrl, label) {
  const response = await post("/api/auth/oauth2/consent", {
    accept: true,
    oauth_query: consentUrl.search.replace(/^\?/, ""),
  });
  const body = await readJson(response);
  const callback = body.url ?? body.redirect_uri ?? "";
  const code = callback ? new URL(callback).searchParams.get("code") : null;
  must(
    `consent returns an authorization code (${label})`,
    typeof code === "string" && code.length > 0,
    callback
      ? new URL(callback).origin + new URL(callback).pathname
      : JSON.stringify(body).slice(0, 200),
  );
  return code;
}

/** Exchange the code for a token. */
async function exchangeCode(clientId, code, verifier, label) {
  const response = await request("/api/auth/oauth2/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: BASE,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${BASE}/api/mcp`,
    }),
  });
  const body = await readJson(response);
  must(
    `token exchange (${label})`,
    typeof body.access_token === "string",
    JSON.stringify(body).slice(0, 160),
  );
  return body.access_token;
}

/** Register, authorize, consent, exchange. The whole cold-start path. */
async function connect(name, scope, label) {
  const clientId = await registerClient(name);
  const { consentUrl, verifier } = await authorize(clientId, scope, label);
  return { clientId, consentUrl, verifier };
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

async function rpc(accessToken, method, params) {
  const response = await request("/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const payload = line ? safeJson(line.slice(6)) : safeJson(text);
  return { status: response.status, payload };
}

function callTool(accessToken, name, args = {}) {
  return rpc(accessToken, "tools/call", { name, arguments: args });
}

function toolText(payload) {
  return payload?.result?.content?.[0]?.text ?? "";
}

/** A tool's JSON payload, which arrives as text inside the content block. */
function toolJson(payload) {
  return safeJson(toolText(payload));
}

function resourceJson(payload) {
  return safeJson(payload?.result?.contents?.[0]?.text ?? "");
}

// ---------------------------------------------------------------------------
// 1. A user to authorize as
// ---------------------------------------------------------------------------
async function signIn() {
  // Signing up is idempotent enough for this: an existing address simply fails
  // and the sign-in below carries on.
  await post("/api/auth/sign-up/email", {
    email: EMAIL,
    password: PASSWORD,
    name: "Vérification",
  });

  const response = await post("/api/auth/sign-in/email", {
    email: EMAIL,
    password: PASSWORD,
  });
  must(
    "sign in",
    response.status === 200,
    response.status === 200
      ? `status ${response.status}`
      : JSON.stringify(await readJson(response)).slice(0, 160),
  );
  // Checked separately, because every request from here on carries the jar and a
  // silently empty one turns into an unrelated failure five steps later.
  must(
    "the session cookie is captured",
    cookieJar.size > 0,
    `${cookieJar.size} cookie(s)`,
  );
}

// ---------------------------------------------------------------------------
// 2. The client an agent would be, with the scopes it would ask for
// ---------------------------------------------------------------------------
async function connectWideClient() {
  const { clientId, consentUrl, verifier } = await connect(
    "Test MCP Client",
    WIDE_SCOPE,
    "wide",
  );

  // The consent page must render, naming the client and the scopes.
  const page = await get(consentUrl.href);
  const html = await page.text();
  step(
    "consent page names the client",
    html.includes("Test MCP Client"),
    `status ${page.status}`,
  );
  step(
    "consent page explains each scope in French",
    html.includes("Lire vos semaines planifi") &&
      html.includes("Proposer ou modifier une semaine"),
  );

  const code = await acceptConsent(consentUrl, "wide");
  const token = await exchangeCode(clientId, code, verifier, "wide");
  return token;
}

// ---------------------------------------------------------------------------
// 3. The endpoint answers the token
// ---------------------------------------------------------------------------
async function checkIdentity(token) {
  const initialize = await rpc(token, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "e2e", version: "0" },
  });
  must(
    "MCP initialize with a real token",
    initialize.status === 200 && Boolean(initialize.payload?.result),
    JSON.stringify(initialize.payload).slice(0, 160),
  );

  const called = await callTool(token, "whoami");
  const whoami = toolJson(called.payload);
  // snake_case, like every other field on the agent surface. `whoami` was the
  // last tool answering in camelCase, which is the inconsistency an agent pays
  // for: it learns one convention here and gets a validation error there.
  step(
    "whoami answers with the authenticated user and the calling client",
    typeof whoami.user_id === "string" &&
      typeof whoami.client_id === "string" &&
      Array.isArray(whoami.scopes) &&
      whoami.scopes.includes("plan:write"),
    `${whoami.user_id ?? "?"} via ${whoami.client_id ?? "?"}`,
  );
}

// ---------------------------------------------------------------------------
// 4. The read surface: tools, resources, and the guards around them
// ---------------------------------------------------------------------------
async function readSurface(token) {
  const tools = await rpc(token, "tools/list", {});
  const toolNames = (tools.payload?.result?.tools ?? []).map(
    (tool) => tool.name,
  );
  step(
    "the read tools are advertised",
    ["get_profile_snapshot", "search_recipes", "get_recipe", "get_week"].every(
      (name) => toolNames.includes(name),
    ),
    toolNames.join(", "),
  );

  const resources = await rpc(token, "resources/list", {});
  const resourceUris = (resources.payload?.result?.resources ?? []).map(
    (resource) => resource.uri,
  );
  step(
    "the resources are advertised",
    ["cooking://profile", "cooking://slots", "cooking://recipes/index"].every(
      (uri) => resourceUris.includes(uri),
    ),
    resourceUris.join(", "),
  );

  const snapshot = await callTool(token, "get_profile_snapshot", {
    format: "markdown",
  });
  const snapshotText = toolText(snapshot.payload);
  step(
    "get_profile_snapshot leads with the hard constraints",
    snapshotText.includes("## 1. Contraintes absolues") &&
      snapshotText.indexOf("## 1. Contraintes absolues") <
        snapshotText.indexOf("## 6."),
    `${snapshotText.length} characters`,
  );

  const search = await callTool(token, "search_recipes", { limit: 5 });
  const searchPayload = toolJson(search.payload);
  step(
    "search_recipes returns a compact list",
    typeof searchPayload.total === "number" &&
      Array.isArray(searchPayload.recipes),
    `${searchPayload.total ?? "?"} total`,
  );

  const week = await callTool(token, "get_week");
  const weekPayload = toolJson(week.payload);
  step(
    "get_week defaults to the current week and names the concurrency token",
    typeof weekPayload.year === "number" &&
      Array.isArray(weekPayload.slots) &&
      "expected_base_version" in weekPayload,
    `${weekPayload.year ?? "?"}-W${weekPayload.week ?? "?"}`,
  );

  const index = await rpc(token, "resources/read", {
    uri: "cooking://recipes/index",
  });
  const indexPayload = resourceJson(index.payload);
  step(
    "the recipe index reports how long since each recipe was planned",
    Array.isArray(indexPayload.recipes) &&
      indexPayload.recipes.every((row) => "weeks_since_last_planned" in row),
    `${indexPayload.count ?? "?"} recipes`,
  );

  const pantry = await rpc(token, "resources/read", {
    uri: "cooking://pantry",
  });
  const pantryPayload = resourceJson(pantry.payload);
  step(
    // Placeholder until phase 8, real since. An empty list here means nothing has
    // been entered, which is not the same as an empty cupboard, and the resource
    // description says so to the agent.
    "the pantry resource is real, and separates staples from what to use soon",
    Array.isArray(pantryPayload.staples) &&
      Array.isArray(pantryPayload.use_soon),
    `${pantryPayload.staples?.length ?? "?"} staples, ${
      pantryPayload.use_soon?.length ?? "?"
    } to use soon`,
  );

  return { searchPayload };
}

// ---------------------------------------------------------------------------
// 5. The write surface, driven the way an agent would
// ---------------------------------------------------------------------------
async function writeSurface(token, { searchPayload }) {
  // The library has to be seeded rather than assumed. This script runs against
  // the verification database, which starts empty, and taking whatever recipe
  // happened to be lying around was how it used to depend on the developer's own
  // data without saying so. See T6 in docs/06-open-questions.md.
  let recipeId = searchPayload.recipes?.[0]?.id;
  if (!recipeId) {
    const seeded = await callTool(token, "create_recipe", {
      title: "Poelee de verification",
      servings: 2,
      activeTimeMin: 20,
    });
    recipeId = toolJson(seeded.payload).id;
    must(
      "create_recipe seeds the library when it is empty",
      typeof recipeId === "string" && recipeId.length > 0,
      recipeId ?? "no id returned",
    );
  }

  // The dinner slot, by the key the vocabulary gives it. This used to look the
  // key up by searching for that same key, which could only ever return what it
  // was given.
  const MEAL_TYPE = "dinner";

  // Read the week before writing to it, exactly as an agent must: the script is
  // re-runnable, so the target may already carry an accepted plan from last time.
  const targetWeek = await callTool(token, "get_week", PROPOSAL_WEEK);
  const baseVersion =
    toolJson(targetWeek.payload).expected_base_version ?? null;

  const proposal = (overrides = {}) => ({
    year: PROPOSAL_WEEK.year,
    week: PROPOSAL_WEEK.week,
    expected_base_version: baseVersion,
    summary: "Une semaine légère, deux plats seulement pour la vérification.",
    entries: [
      {
        day_of_week: 1,
        meal_type: MEAL_TYPE,
        recipe_ref: recipeId,
        rationale:
          "Court en temps actif, et le créneau du lundi est le plus contraint.",
      },
    ],
    ...overrides,
  });

  const infeasible = await callTool(
    token,
    "check_feasibility",
    proposal({
      entries: [
        {
          day_of_week: 1,
          meal_type: MEAL_TYPE,
          recipe_ref: recipeId,
          rationale: "   ",
        },
      ],
    }),
  );
  const infeasiblePayload = toolJson(infeasible.payload);
  step(
    "check_feasibility reports a missing rationale without writing",
    infeasiblePayload.feasible === false &&
      infeasiblePayload.errors?.some(
        (error) => error.code === "MISSING_RATIONALE",
      ),
    infeasiblePayload.errors?.[0]?.code,
  );

  const feasible = await callTool(token, "check_feasibility", proposal());
  const feasiblePayload = toolJson(feasible.payload);
  step(
    "check_feasibility passes a well-formed week",
    feasiblePayload.feasible === true,
    JSON.stringify(feasiblePayload.errors ?? []).slice(0, 120),
  );

  const proposed = await callTool(token, "propose_week", proposal());
  const proposedPayload = toolJson(proposed.payload);
  step(
    "propose_week writes a proposal and hands back a review link",
    proposedPayload.state === "pending" &&
      typeof proposedPayload.review_url === "string" &&
      proposedPayload.review_url.includes("/proposition"),
    `${proposedPayload.state ?? "?"} ${proposedPayload.review_url ?? ""}`,
  );

  const pendingWeek = await callTool(token, "get_week", {
    ...PROPOSAL_WEEK,
    version: "pending",
  });
  const pendingPayload = toolJson(pendingWeek.payload);
  step(
    "the proposal is readable, with its rationale intact",
    pendingPayload.version?.state === "pending" &&
      typeof pendingPayload.entries?.[0]?.rationale === "string",
    pendingPayload.entries?.[0]?.rationale?.slice(0, 50),
  );

  const stale = await callTool(
    token,
    "propose_week",
    proposal({ expected_base_version: (baseVersion ?? 0) + 99 }),
  );
  const stalePayload = toolJson(stale.payload);
  step(
    "a proposal built on a stale version is refused with the current state",
    stale.payload?.result?.isError === true &&
      stalePayload.error === "VERSION_CONFLICT",
    stalePayload.error ?? "no error",
  );

  // Rule 7, and this is the only end-to-end check of it. The fact asks for
  // `confirmed` outright, because a request that asks for nothing proves
  // nothing: the server has to override what the agent sent, not merely supply
  // a default the agent left blank.
  const recorded = await callTool(token, "record_facts", {
    facts: [
      {
        category: "organization",
        statement: "Vérification automatique : cuisine surtout en semaine",
        polarity: "neutral",
        confidence: "low",
        evidence: ["verify-oauth-flow"],
        status: "confirmed",
      },
    ],
  });
  const recordedPayload = toolJson(recorded.payload);
  step(
    "an agent's fact enters unconfirmed, whatever it asked for",
    recordedPayload.created?.[0]?.status === "unconfirmed",
    recordedPayload.created?.[0]?.status,
  );

  const retired = await callTool(token, "retire_fact", {
    fact_id: recordedPayload.created?.[0]?.id,
    reason: "Fin de la vérification automatique.",
  });
  const retiredPayload = toolJson(retired.payload);
  step(
    "retiring keeps the fact and its reason instead of deleting it",
    retiredPayload.status === "retired" &&
      typeof retiredPayload.retirement_reason === "string",
    retiredPayload.retirement_reason,
  );

  const history = await callTool(token, "get_history", { weeks_back: 8 });
  const historyPayload = toolJson(history.payload);
  step(
    "get_history returns weeks, signals and budget suggestions",
    Array.isArray(historyPayload.weeks) &&
      Array.isArray(historyPayload.unresolved_signals) &&
      Array.isArray(historyPayload.budget_suggestions) &&
      typeof historyPayload.note === "string",
    `${historyPayload.weeks?.length ?? "?"} weeks`,
  );

  const historyResource = await rpc(token, "resources/read", {
    uri: "cooking://history/recent",
  });
  const historyResourcePayload = resourceJson(historyResource.payload);
  step(
    "the history resource is real, not a placeholder",
    historyResourcePayload.available !== false &&
      Array.isArray(historyResourcePayload.weeks),
    `${historyResourcePayload.weeks?.length ?? "?"} weeks`,
  );

  const snapshot = await callTool(token, "get_profile_snapshot", {
    format: "markdown",
  });
  const snapshotText = toolText(snapshot.payload);
  step(
    "the snapshot now carries the history and signal sections",
    // Sections 7 and 8 until the pantry took 7 in phase 8. The numbers follow the
    // order the spec gives, so they move when a section is inserted.
    snapshotText.includes("## 8. Historique récent") &&
      snapshotText.includes("## 9. Signaux non résolus"),
    `${snapshotText.length} characters`,
  );

  const prompts = await rpc(token, "prompts/list", {});
  const promptNames = (prompts.payload?.result?.prompts ?? []).map(
    (prompt) => prompt.name,
  );
  step(
    "the prompt pack is served over MCP",
    ["plan_my_week", "weekly_review"].every((name) =>
      promptNames.includes(name),
    ),
    promptNames.join(", "),
  );
}

// ---------------------------------------------------------------------------
// 6. A token granted narrower scopes must be refused, with the fix named
// ---------------------------------------------------------------------------
async function narrowScope() {
  const { clientId, consentUrl, verifier } = await connect(
    "Narrow Scope Client",
    // Deliberately no recipes:read.
    "openid profile:read",
    "narrow",
  );
  const code = await acceptConsent(consentUrl, "narrow");
  const token = await exchangeCode(clientId, code, verifier, "narrow");

  const refused = await callTool(token, "search_recipes");
  const refusedPayload = toolJson(refused.payload);
  step(
    "a call beyond the granted scopes is refused, naming what is missing",
    refused.payload?.result?.isError === true &&
      refusedPayload.error === "MISSING_SCOPE" &&
      refusedPayload.details?.missing?.includes("recipes:read"),
    refusedPayload.message?.slice(0, 80),
  );

  return { clientId, token };
}

// ---------------------------------------------------------------------------
// 7. Revocation is immediate, even for a token that is still cryptographically
//    valid. This is the property a JWT cannot give on its own.
// ---------------------------------------------------------------------------
async function revocation(narrow) {
  const response = await get("/api/auth/oauth2/get-consents");
  const consents = await readJson(response);
  const record = (Array.isArray(consents) ? consents : []).find(
    (row) => row.clientId === narrow.clientId,
  );
  must(
    "the consent granted to the narrow client is listed",
    record?.id !== undefined,
    Array.isArray(consents)
      ? `${consents.length} consent(s)`
      : JSON.stringify(consents).slice(0, 160),
  );

  await post("/api/auth/oauth2/delete-consent", { id: record.id });

  const after = await callTool(narrow.token, "whoami");
  const afterPayload = toolJson(after.payload);
  step(
    "a revoked client is refused immediately, before its token expires",
    after.payload?.result?.isError === true &&
      afterPayload.error === "CLIENT_REVOKED",
    afterPayload.error ?? "no error code",
  );
}

// ---------------------------------------------------------------------------
// 8. And an unauthenticated call is still refused with the discovery header
// ---------------------------------------------------------------------------
async function anonymousCall() {
  const response = await request("/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  step(
    "unauthenticated MCP call is refused with RFC 9728 discovery",
    response.status === 401 &&
      (response.headers.get("www-authenticate") ?? "").includes(
        "oauth-protected-resource",
      ),
    `status ${response.status}`,
  );
}

// ---------------------------------------------------------------------------

try {
  await signIn();
  const token = await connectWideClient();
  await checkIdentity(token);
  const surface = await readSurface(token);
  await writeSurface(token, surface);
  const narrow = await narrowScope();
  await revocation(narrow);
  await anonymousCall();
} catch (error) {
  if (error instanceof Precondition) {
    // The FAIL line is already printed. Saying which step stopped the run is
    // the only thing left to add, because the steps below it never ran and
    // their absence is otherwise unexplained.
    console.log(
      `\nStopped after "${error.message}": nothing below it can be read.`,
    );
  } else {
    failures += 1;
    console.log(
      `FAIL ${error instanceof Error ? error.message : String(error)}`,
    );
    console.log(
      "\nIs `npm run dev:test` running? This drives a real server and expects " +
        `one at ${BASE}.`,
    );
  }
}

console.log(
  failures === 0
    ? "\nAgent connection path verified end to end."
    : `\n${failures} step(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
