/**
 * End-to-end check of the agent connection path, against a running server:
 *
 *   npm run dev            # in one terminal
 *   npm run verify:oauth   # in another
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
 */
import { createHash, randomBytes } from "node:crypto";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const REDIRECT = "http://localhost:9999/callback";
const EMAIL = process.env.VERIFY_EMAIL ?? "cook@example.test";
const PASSWORD = process.env.VERIFY_PASSWORD ?? "motdepasse123";

const cookieJar = new Map();

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

async function post(path, body, extra = {}) {
  const response = await fetch(`${BASE}${path}`, {
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

let failures = 0;

function step(name, ok, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures += 1;
}

// 1. A user to authorize as. Signing up is idempotent enough for this: an
//    existing address simply fails and the sign-in below carries on.
await post("/api/auth/sign-up/email", {
  email: EMAIL,
  password: PASSWORD,
  name: "Vérification",
});

const signIn = await post("/api/auth/sign-in/email", {
  email: EMAIL,
  password: PASSWORD,
});
step("sign in", signIn.status === 200, `status ${signIn.status}`);

// A real user reaches the browser before they reach an agent, and the first page
// load is what seeds the account: meal types, the weekly slots and the starter
// ingredient vocabulary all come from ensureUserSetup() behind requireUser().
// Nothing on the MCP path runs it, so a script that skipped straight to the
// token used to plan against whatever the developer's own account happened to
// hold. See T6 in docs/06-open-questions.md.
const firstVisit = await fetch(`${BASE}/`, {
  headers: { cookie: cookieHeader() },
  redirect: "manual",
});
step(
  "the first page load seeds the account",
  firstVisit.status < 400,
  `status ${firstVisit.status}`,
);

// 2. Dynamic client registration, cold, with no credentials at all.
const registration = await fetch(`${BASE}/api/auth/oauth2/register`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: BASE },
  body: JSON.stringify({
    client_name: "Test MCP Client",
    redirect_uris: [REDIRECT],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "native",
  }),
});
const client = await registration.json();
step(
  "dynamic client registration",
  registration.status < 300 && typeof client.client_id === "string",
  client.client_id ?? JSON.stringify(client).slice(0, 200),
);

// 3. Authorization request with PKCE.
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const authorizeQuery = new URLSearchParams({
  client_id: client.client_id,
  redirect_uri: REDIRECT,
  response_type: "code",
  scope:
    "openid profile:read profile:write recipes:read recipes:write plan:read plan:write pantry:read feedback:read",
  state: "test-state",
  code_challenge: challenge,
  code_challenge_method: "S256",
  resource: `${BASE}/api/mcp`,
});

/**
 * The provider answers a navigation with a 302 and a fetch with a JSON redirect
 * descriptor, so both shapes have to be read.
 */
async function redirectLocationOf(response) {
  const header = response.headers.get("location");
  if (header) return header;
  const body = await response
    .clone()
    .json()
    .catch(() => ({}));
  return body.url ?? body.redirect_uri ?? "";
}

const authorize = await fetch(
  `${BASE}/api/auth/oauth2/authorize?${authorizeQuery}`,
  {
    redirect: "manual",
    headers: {
      cookie: cookieHeader(),
      // The provider answers a navigation with a redirect and a fetch with
      // JSON, so the harness has to look like the browser it is standing in for.
      accept: "text/html,application/xhtml+xml",
      "sec-fetch-mode": "navigate",
    },
  },
);
storeCookies(authorize);
const consentLocation = await redirectLocationOf(authorize);
if (!consentLocation) {
  console.log("  authorize status", authorize.status, (await authorize.text()).slice(0, 200));
}
step(
  "authorize redirects a signed-in user to the consent screen",
  consentLocation.includes("/consent"),
  consentLocation.slice(0, 120),
);

// 4. The consent page must render, naming the client and the scopes.
const consentUrl = new URL(consentLocation, BASE);
const consentPage = await fetch(consentUrl, {
  headers: { cookie: cookieHeader() },
});
const consentHtml = await consentPage.text();
step(
  "consent page names the client",
  consentHtml.includes("Test MCP Client"),
  `status ${consentPage.status}`,
);
step(
  "consent page explains each scope in French",
  consentHtml.includes("Lire vos semaines planifi") &&
    consentHtml.includes("Proposer ou modifier une semaine"),
);

// 5. Accept, handing the signed query back untouched.
const consent = await post("/api/auth/oauth2/consent", {
  accept: true,
  oauth_query: consentUrl.search.replace(/^\?/, ""),
});
const consentBody = await consent.json();
const callback = consentBody.url ?? consentBody.redirect_uri ?? "";
const code = callback ? new URL(callback).searchParams.get("code") : null;
step(
  "consent returns an authorization code",
  typeof code === "string" && code.length > 0,
  callback ? new URL(callback).origin + new URL(callback).pathname : JSON.stringify(consentBody).slice(0, 200),
);

// 6. Exchange the code for a token.
const tokenResponse = await fetch(`${BASE}/api/auth/oauth2/token`, {
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    origin: BASE,
  },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code: code ?? "",
    redirect_uri: REDIRECT,
    client_id: client.client_id,
    code_verifier: verifier,
    resource: `${BASE}/api/mcp`,
  }),
});
const token = await tokenResponse.json();
step(
  "token exchange",
  typeof token.access_token === "string",
  JSON.stringify(token).slice(0, 160),
);

// 7. Call the MCP endpoint with the bearer token.
async function rpc(method, params, accessToken = token.access_token) {
  const response = await fetch(`${BASE}/api/mcp`, {
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
  const payload = line ? JSON.parse(line.slice(6)) : safeJson(text);
  return { status: response.status, payload };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

const initialize = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "e2e", version: "0" },
});
step(
  "MCP initialize with a real token",
  initialize.status === 200 && Boolean(initialize.payload?.result),
  JSON.stringify(initialize.payload).slice(0, 160),
);

const called = await rpc("tools/call", { name: "whoami", arguments: {} });
const content = called.payload?.result?.content?.[0]?.text ?? "";
const whoami = (() => {
  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
})();
step(
  "whoami answers with the authenticated user and the calling client",
  typeof whoami.userId === "string" &&
    typeof whoami.clientId === "string" &&
    Array.isArray(whoami.scopes) &&
    whoami.scopes.includes("plan:write"),
  `${whoami.userId ?? "?"} via ${whoami.clientId ?? "?"}`,
);

// 8. The phase 4 read surface: tools, resources, and the guards around them.
function toolText(payload) {
  return payload?.result?.content?.[0]?.text ?? "";
}

const tools = await rpc("tools/list", {});
const toolNames = (tools.payload?.result?.tools ?? []).map((tool) => tool.name);
step(
  "the read tools are advertised",
  ["get_profile_snapshot", "search_recipes", "get_recipe", "get_week"].every(
    (name) => toolNames.includes(name),
  ),
  toolNames.join(", "),
);

const resources = await rpc("resources/list", {});
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

const snapshot = await rpc("tools/call", {
  name: "get_profile_snapshot",
  arguments: { format: "markdown" },
});
const snapshotText = toolText(snapshot.payload);
step(
  "get_profile_snapshot leads with the hard constraints",
  snapshotText.includes("## 1. Contraintes absolues") &&
    snapshotText.indexOf("## 1. Contraintes absolues") <
      snapshotText.indexOf("## 6."),
  `${snapshotText.length} characters`,
);

const search = await rpc("tools/call", {
  name: "search_recipes",
  arguments: { limit: 5 },
});
const searchPayload = safeJson(toolText(search.payload));
step(
  "search_recipes returns a compact list",
  typeof searchPayload.total === "number" &&
    Array.isArray(searchPayload.recipes),
  `${searchPayload.total ?? "?"} total`,
);

const week = await rpc("tools/call", { name: "get_week", arguments: {} });
const weekPayload = safeJson(toolText(week.payload));
step(
  "get_week defaults to the current week and names the concurrency token",
  typeof weekPayload.year === "number" &&
    Array.isArray(weekPayload.slots) &&
    "expected_base_version" in weekPayload,
  `${weekPayload.year ?? "?"}-W${weekPayload.week ?? "?"}`,
);

const index = await rpc("resources/read", { uri: "cooking://recipes/index" });
const indexText = index.payload?.result?.contents?.[0]?.text ?? "";
const indexPayload = safeJson(indexText);
step(
  "the recipe index reports how long since each recipe was planned",
  Array.isArray(indexPayload.recipes) &&
    indexPayload.recipes.every((row) => "weeks_since_last_planned" in row),
  `${indexPayload.count ?? "?"} recipes`,
);

const pantry = await rpc("resources/read", { uri: "cooking://pantry" });
const pantryPayload = safeJson(
  pantry.payload?.result?.contents?.[0]?.text ?? "",
);
step(
  // Placeholder until phase 8, real since. An empty list here means nothing has
  // been entered, which is not the same as an empty cupboard, and the resource
  // description says so to the agent.
  "the pantry resource is real, and separates staples from what to use soon",
  Array.isArray(pantryPayload.staples) && Array.isArray(pantryPayload.use_soon),
  `${pantryPayload.staples?.length ?? "?"} staples, ${
    pantryPayload.use_soon?.length ?? "?"
  } to use soon`,
);

// 9. The phase 5 write surface, driven the way an agent would.
//
// The library has to be seeded rather than assumed. This script runs against
// the test database, which starts empty, and taking whatever recipe happened to
// be lying around was how it used to depend on the developer's own data without
// saying so. See T6 in docs/06-open-questions.md.
let someRecipeId = searchPayload.recipes?.[0]?.id;
if (!someRecipeId) {
  const seeded = await rpc("tools/call", {
    name: "create_recipe",
    arguments: {
      title: "Poelee de verification",
      servings: 2,
      activeTimeMin: 20,
    },
  });
  someRecipeId = safeJson(toolText(seeded.payload)).id;
  step(
    "create_recipe seeds the library when it is empty",
    typeof someRecipeId === "string" && someRecipeId.length > 0,
    someRecipeId ?? "no id returned",
  );
}
const dinnerKey =
  weekPayload.slots?.find((slot) => slot.meal_type_key === "dinner")
    ?.meal_type_key ?? "dinner";
const PROPOSAL_WEEK = { year: 2026, week: 50 };

// Read the week before writing to it, exactly as an agent must: the script is
// re-runnable, so the target may already carry an accepted plan from last time.
const targetWeek = await rpc("tools/call", {
  name: "get_week",
  arguments: PROPOSAL_WEEK,
});
const baseVersion =
  safeJson(toolText(targetWeek.payload)).expected_base_version ?? null;

function proposal(overrides = {}) {
  return {
    year: PROPOSAL_WEEK.year,
    week: PROPOSAL_WEEK.week,
    expectedBaseVersion: baseVersion,
    summary: "Une semaine légère, deux plats seulement pour la vérification.",
    entries: [
      {
        dayOfWeek: 1,
        mealType: dinnerKey,
        recipeRef: someRecipeId,
        rationale:
          "Court en temps actif, et le créneau du lundi est le plus contraint.",
      },
    ],
    ...overrides,
  };
}

const infeasible = await rpc("tools/call", {
  name: "check_feasibility",
  arguments: proposal({
    entries: [
      {
        dayOfWeek: 1,
        mealType: dinnerKey,
        recipeRef: someRecipeId,
        rationale: "   ",
      },
    ],
  }),
});
const infeasiblePayload = safeJson(toolText(infeasible.payload));
step(
  "check_feasibility reports a missing rationale without writing",
  infeasiblePayload.feasible === false &&
    infeasiblePayload.errors?.some(
      (error) => error.code === "MISSING_RATIONALE",
    ),
  infeasiblePayload.errors?.[0]?.code,
);

const feasible = await rpc("tools/call", {
  name: "check_feasibility",
  arguments: proposal(),
});
const feasiblePayload = safeJson(toolText(feasible.payload));
step(
  "check_feasibility passes a well-formed week",
  feasiblePayload.feasible === true,
  JSON.stringify(feasiblePayload.errors ?? []).slice(0, 120),
);

const proposed = await rpc("tools/call", {
  name: "propose_week",
  arguments: proposal(),
});
const proposedPayload = safeJson(toolText(proposed.payload));
step(
  "propose_week writes a proposal and hands back a review link",
  proposedPayload.state === "pending" &&
    typeof proposedPayload.review_url === "string" &&
    proposedPayload.review_url.includes("/proposition"),
  `${proposedPayload.state ?? "?"} ${proposedPayload.review_url ?? ""}`,
);

const pendingWeek = await rpc("tools/call", {
  name: "get_week",
  arguments: { ...PROPOSAL_WEEK, version: "pending" },
});
const pendingPayload = safeJson(toolText(pendingWeek.payload));
step(
  "the proposal is readable, with its rationale intact",
  pendingPayload.version?.state === "pending" &&
    typeof pendingPayload.entries?.[0]?.rationale === "string",
  pendingPayload.entries?.[0]?.rationale?.slice(0, 50),
);

const staleProposal = await rpc("tools/call", {
  name: "propose_week",
  arguments: proposal({ expectedBaseVersion: (baseVersion ?? 0) + 99 }),
});
const stalePayload = safeJson(toolText(staleProposal.payload));
step(
  "a proposal built on a stale version is refused with the current state",
  staleProposal.payload?.result?.isError === true &&
    stalePayload.error === "VERSION_CONFLICT",
  stalePayload.error ?? "no error",
);

const recorded = await rpc("tools/call", {
  name: "record_facts",
  arguments: {
    facts: [
      {
        category: "organization",
        statement: "Vérification automatique : cuisine surtout en semaine",
        polarity: "neutral",
        confidence: "low",
        evidence: ["verify-oauth-flow"],
      },
    ],
  },
});
const recordedPayload = safeJson(toolText(recorded.payload));
step(
  "an agent's fact enters unconfirmed, whatever it asked for",
  recordedPayload.created?.[0]?.status === "unconfirmed",
  recordedPayload.created?.[0]?.status,
);

const retired = await rpc("tools/call", {
  name: "retire_fact",
  arguments: {
    fact_id: recordedPayload.created?.[0]?.id,
    reason: "Fin de la vérification automatique.",
  },
});
const retiredPayload = safeJson(toolText(retired.payload));
step(
  "retiring keeps the fact and its reason instead of deleting it",
  retiredPayload.status === "retired" &&
    typeof retiredPayload.retirement_reason === "string",
  retiredPayload.retirement_reason,
);

const history = await rpc("tools/call", {
  name: "get_history",
  arguments: { weeks_back: 8 },
});
const historyPayload = safeJson(toolText(history.payload));
step(
  "get_history returns weeks, signals and budget suggestions",
  Array.isArray(historyPayload.weeks) &&
    Array.isArray(historyPayload.unresolved_signals) &&
    Array.isArray(historyPayload.budget_suggestions) &&
    typeof historyPayload.note === "string",
  `${historyPayload.weeks?.length ?? "?"} weeks`,
);

const historyResource = await rpc("resources/read", {
  uri: "cooking://history/recent",
});
const historyResourcePayload = safeJson(
  historyResource.payload?.result?.contents?.[0]?.text ?? "",
);
step(
  "the history resource is real, not a placeholder",
  historyResourcePayload.available !== false &&
    Array.isArray(historyResourcePayload.weeks),
  `${historyResourcePayload.weeks?.length ?? "?"} weeks`,
);

const snapshotWithHistory = await rpc("tools/call", {
  name: "get_profile_snapshot",
  arguments: { format: "markdown" },
});
const snapshotHistoryText = toolText(snapshotWithHistory.payload);
step(
  "the snapshot now carries the history and signal sections",
  // Sections 7 and 8 until the pantry took 7 in phase 8. The numbers follow the
  // order the spec gives, so they move when a section is inserted.
  snapshotHistoryText.includes("## 8. Historique récent") &&
    snapshotHistoryText.includes("## 9. Signaux non résolus"),
  `${snapshotHistoryText.length} characters`,
);

const prompts = await rpc("prompts/list", {});
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

// 10. A token granted narrower scopes must be refused, with the fix named.
const narrowClient = await (
  await fetch(`${BASE}/api/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({
      client_name: "Narrow Scope Client",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    }),
  })
).json();

const narrowVerifier = randomBytes(32).toString("base64url");
const narrowChallenge = createHash("sha256")
  .update(narrowVerifier)
  .digest("base64url");
const narrowAuthorize = await fetch(
  `${BASE}/api/auth/oauth2/authorize?${new URLSearchParams({
    client_id: narrowClient.client_id,
    redirect_uri: REDIRECT,
    response_type: "code",
    // Deliberately no recipes:read.
    scope: "openid profile:read",
    state: "narrow",
    code_challenge: narrowChallenge,
    code_challenge_method: "S256",
    resource: `${BASE}/api/mcp`,
  })}`,
  {
    redirect: "manual",
    headers: {
      cookie: cookieHeader(),
      accept: "text/html,application/xhtml+xml",
      "sec-fetch-mode": "navigate",
    },
  },
);
const narrowConsentUrl = new URL(
  (await redirectLocationOf(narrowAuthorize)) || "/consent",
  BASE,
);
const narrowConsent = await (
  await post("/api/auth/oauth2/consent", {
    accept: true,
    oauth_query: narrowConsentUrl.search.replace(/^\?/, ""),
  })
).json();
const narrowCode = new URL(
  narrowConsent.url ?? narrowConsent.redirect_uri ?? `${REDIRECT}?code=`,
).searchParams.get("code");
const narrowToken = await (
  await fetch(`${BASE}/api/auth/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: BASE,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: narrowCode ?? "",
      redirect_uri: REDIRECT,
      client_id: narrowClient.client_id,
      code_verifier: narrowVerifier,
      resource: `${BASE}/api/mcp`,
    }),
  })
).json();

const refused = await rpc(
  "tools/call",
  { name: "search_recipes", arguments: {} },
  narrowToken.access_token,
);
const refusedPayload = safeJson(toolText(refused.payload));
step(
  "a call beyond the granted scopes is refused, naming what is missing",
  refused.payload?.result?.isError === true &&
    refusedPayload.error === "MISSING_SCOPE" &&
    refusedPayload.details?.missing?.includes("recipes:read"),
  refusedPayload.message?.slice(0, 80),
);

// 11. Revocation is immediate, even for a token that is still cryptographically
//     valid. This is the property a JWT cannot give on its own.
const consents = await (
  await fetch(`${BASE}/api/auth/oauth2/get-consents`, {
    headers: { cookie: cookieHeader() },
  })
).json();
const narrowConsentRecord = (Array.isArray(consents) ? consents : []).find(
  (row) => row.clientId === narrowClient.client_id,
);
await post("/api/auth/oauth2/delete-consent", { id: narrowConsentRecord?.id });

const afterRevoke = await rpc(
  "tools/call",
  { name: "whoami", arguments: {} },
  narrowToken.access_token,
);
const afterRevokePayload = safeJson(toolText(afterRevoke.payload));
step(
  "a revoked client is refused immediately, before its token expires",
  afterRevoke.payload?.result?.isError === true &&
    afterRevokePayload.error === "CLIENT_REVOKED",
  afterRevokePayload.error ?? "no error code",
);

// 12. And an unauthenticated call is still refused with the discovery header.
const anonymous = await fetch(`${BASE}/api/mcp`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
step(
  "unauthenticated MCP call is refused with RFC 9728 discovery",
  anonymous.status === 401 &&
    (anonymous.headers.get("www-authenticate") ?? "").includes(
      "oauth-protected-resource",
    ),
  `status ${anonymous.status}`,
);

console.log(
  failures === 0
    ? "\nAgent connection path verified end to end."
    : `\n${failures} step(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
