# 03 - Agent Interface (MCP)

Status: draft v1
Last updated: 2026-09-07
Depends on: `01-functional-spec.md`, `02-data-model.md`

This is the differentiating surface of the product. The application supplies no
intelligence of its own, so everything that would normally be prompt engineering
lives here: schema shape, tool naming, tool descriptions, and the composition of
the context document we hand the agent.

## 1. Design principles

1. **The tool layer is the only write path.** The web UI calls the same internal
   service layer as MCP. Two entry points, one set of rules. No validation lives
   only in the UI, ever.
2. **Descriptions are the prompt.** We cannot steer a model we do not run. The
   only steering available is: tool names, tool descriptions, parameter
   descriptions, enum values, and the text of error messages. All four are
   product copy and get reviewed as such.
3. **Errors teach.** Every rejection returns a machine-readable code, a
   human-readable reason, and, where possible, a suggested corrective action.
   A well-shaped error turns a failed agent call into a successful retry without
   a human in the loop.
4. **Few, fat tools over many thin ones.** An agent planning a week should not
   need 14 calls. `propose_week` accepts new recipes and entries in one atomic
   payload. Round trips are the agent's cost and the user's latency.
5. **Read cheap, write guarded.** Reads are broad and generous. Writes are
   validated, logged, versioned, and reversible.
6. **No hidden state.** If a rule affects planning (a time budget, a strict
   allergen, a skipped slot), the agent can read it. Being rejected for a rule
   you could not see is the worst possible agent experience.

## 2. Transport and authentication

- **Transport:** Streamable HTTP MCP, single endpoint, for example
  `https://<host>/api/mcp`.
- **Authorization:** OAuth 2.1 with PKCE and **dynamic client registration**.
  The application acts as the authorization server. This is what lets a user
  paste one URL into an MCP client and get a browser consent screen, with no
  manual key handling.
- **Scopes:** deliberately coarse in v1, because fine-grained scopes the user
  cannot reason about are worse than none. The authoritative list is
  `MCP_SCOPES` in `src/lib/scopes.ts`, and it has two halves.

  The four OpenID Connect scopes, which are what an OAuth client expects to be
  able to ask for and which carry no access to cooking data at all:
  - `openid`: run the OIDC flow and identify the account. Without it the client
    gets a plain OAuth 2 authorization rather than an identity.
  - `profile`: read the account's name.
  - `email`: read the account's email address.
  - `offline_access`: receive a refresh token, so a long-lived agent does not
    have to send the user back through consent every hour.

  Then the nine application scopes, which are the ones that reach the user's
  data:
  - `profile:read`, `profile:write`
  - `recipes:read`, `recipes:write`
  - `plan:read`, `plan:write`
  - `pantry:read`, `pantry:write`
  - `feedback:read`

  Every scope is worded for the consent screen under `consent.scopeNames` in
  `messages/*.json`, so the sentence the user reads is translated copy rather
  than the scope string.

- **Client identity** is recorded per token and stamped on every write, so the
  activity log and the fact provenance can name which agent did what.
- **Revocation** is per client, from the account screen, effective immediately.
- **Rate limiting** per client: generous, but present, so a looping agent cannot
  fill the database.

Settled while building phase 4:

- **Revocation is enforced on every call, not only at token issue.** Access
  tokens are JWTs verified against our JWKS, so revoking a client cannot
  invalidate a token already in its hands. Each call re-checks that a consent row
  exists for the (user, client) pair, which is one indexed query for a revoke
  button that actually revokes. Revoking also deletes the stored access and
  refresh tokens so nothing can be minted again.
- **The rate limit is 120 calls per minute per client**, counted from
  `agent_activity` rather than from process memory, so it survives a restart and
  holds across instances without a shared cache.
- **Every tool and resource passes through one guard**, in
  `src/mcp/tool-runner.ts`. Scopes, revocation, rate limit, audit entry and error
  shaping are applied there and nowhere else, so a tool added later cannot
  quietly skip one.
- **First-run seeding happens on the first tool call**, through the same
  idempotent `ensureUserSetup()` the web entry point runs. An agent may well be
  the first thing an account ever talks to, and an unseeded account has no meal
  types and no slots: `get_week` would answer with an empty grid and
  `propose_week` would refuse every entry with `SLOT_UNKNOWN` and an empty list
  of valid keys, which is an error naming no way out and repairable by no tool.

Settled during the September 2026 audit, all in `src/app/api/mcp/route.ts` and
`src/lib/auth.ts`:

- **The endpoint requires `profile:read` at the door**, before any tool's own
  scope check. A token holding only `recipes:read` is refused at the transport
  with `insufficient_scope` and never reaches `search_recipes`, which would have
  accepted it. Every consent screen this application drives asks for
  `profile:read`, so this only bites a client that deliberately requested a
  narrower set. It is a floor, not a replacement: per-tool scopes are still
  enforced inside each tool.
- **An unauthenticated or subject-less call answers 401 in the JSON-RPC shape**
  the rest of the endpoint speaks. A token with no `sub` claim used to throw a
  bare error inside the authenticated handler, which Next turned into an opaque
  500, so a client holding a structurally broken token was told the server was
  broken.
- **`OPTIONS` is answered with CORS headers,** allowing `Authorization`,
  `Content-Type`, `Mcp-Session-Id`, `Mcp-Protocol-Version` and `Last-Event-ID`
  by name, and exposing `Mcp-Session-Id` and `WWW-Authenticate`. There was no
  preflight answer at all, so a browser-hosted MCP client could not reach the
  endpoint: the preflight failed and the real request was never sent. The two
  Streamable HTTP headers have to be named rather than covered by a wildcard,
  because a wildcard is not honoured for a credentialed request. The origin is
  open because the credential is a bearer token and never the session cookie, so
  there is no ambient authority for another origin to borrow.
- **Dynamic client registration is rate limited to five per minute.** It is
  unauthenticated by necessity, since a client arriving cold has no credential to
  present, and that is the whole one-URL connection story. Unauthenticated and
  unbounded is another matter. A registered client with no consent row opens
  nothing, so the exposure being bounded is rows in `oauthApplication`.
- **An access token lives one hour, pinned rather than defaulted.** Two comments
  reason from that number, the revocation check in `src/mcp/tool-runner.ts` and
  the header of `src/lib/access.ts`, and a library default that changed in a
  patch release would make both of them quietly wrong. One hour is also what the
  default was, so this changed no behaviour on the day.

Fallback for local use: a thin stdio wrapper that holds a personal access token
and proxies to the same HTTP endpoint. Not v1, but the tool layer must not assume
HTTP-only so this stays cheap to add.

## 3. Resources

Resources are for context the agent should pull once per session and re-read
rarely.

| URI                             | Content                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `cooking://profile`             | The composed profile snapshot, see section 4                                                           |
| `cooking://slots`               | Slot configuration with time budgets                                                                   |
| `cooking://recipes/index`       | Compact recipe index: id, title, active time, tags, protein, rotation age, cook rate. Not full recipes |
| `cooking://recipes/{id}`        | One full recipe                                                                                        |
| `cooking://plan/current`        | Active version of the current ISO week                                                                 |
| `cooking://plan/{year}-W{week}` | Active version of a given week                                                                         |
| `cooking://pantry`              | Staples and use-soon items                                                                             |
| `cooking://history/recent`      | Last 8 weeks: what was planned, what was cooked, ratings, plus the unresolved signals                  |

The recipe index being compact and the full recipe being separate is a
deliberate context-budget decision: a 200-recipe library must be surveyable in a
few hundred tokens so the agent can decide what to fetch in full.

Settled during the September 2026 audit:

- **A resource and a tool return the same shape for the same entity,** from one
  serializer per entity in `src/mcp/serializers.ts`. Before that the two halves
  serialized independently: a tool curated a snake_case view while the matching
  resource handed back the raw service row. That is two problems in one. Every
  entity had two shapes an agent had to learn, and the resource half published
  internals it was never meant to: `cooking://recipes/{id}` returned the whole
  `RecipeDetail`, whose row carries `user_id`, `source_client_id`,
  `allergen_ids` and the row timestamps. None of those leave now. The rule is
  structural: one function per entity, and nothing else may serialize one.
- **`cooking://plan/*` entries carry `id`.** They did not, and `link_prep` names
  the two meals it relates by entry id, so a week read through the resource
  could not then be linked. It can now.
- **Every output is compact JSON,** not pretty-printed. Indentation on a
  200-recipe index spends a third of the bytes on something no model reads, and
  the receiving end is a JSON parser, so there is nothing to trade off.
- Fields added in the same pass: `cooking://recipes/{id}` and `get_recipe` gained
  `difficulty`, `source` and `source_url`; `cooking://recipes/index` gained
  `cuisine`; plan entries gained `rationale_refs`.

## 4. The profile snapshot

The single most important artifact in the system. One document, assembled
server-side, designed to be pasted into an agent's context and to be sufficient
for planning without further reads.

Ordering and grouping are part of the design, not incidental:

```
1. HARD CONSTRAINTS      (strict allergens, diet)        <- never violate
2. STRONG PREFERENCES    (exclusions, confirmed negative facts)
3. THE WEEK'S SHAPE      (slots, time budgets, servings)
4. KITCHEN               (equipment, skill level)
5. ORGANIZATION FACTS    (schedule, batch habits, shopping habits)
6. TASTE FACTS           (positive then negative, confirmed then unconfirmed)
7. PANTRY                (staples, use-soon with dates)
8. RECENT HISTORY        (last 4 weeks cooked, ratings, rotation)
9. UNRESOLVED SIGNALS    (never-cooked-though-planned, slot overruns)
```

Rules for the snapshot:

- Hard constraints go first and are stated imperatively. Models weight early,
  explicit instructions more heavily, and this is the one place where a miss is
  a health event.
- Facts include confidence and status inline, so the agent can discount an
  unconfirmed low-confidence fact instead of treating all statements as equal.
- Retired facts are excluded.
- The snapshot is size-capped. When facts exceed the budget, selection is by
  status (confirmed first), then confidence, then recency of reference. The cap
  and the current usage are stated in the document itself, so the agent knows it
  is seeing a subset.
- Reading the snapshot bumps `last_referenced_at` on the included facts, which is
  what makes the pruning heuristic work.
- Available in two renderings: structured JSON, and Markdown. Markdown is the
  default for MCP resource reads because it costs fewer tokens and models follow
  prose constraints more reliably than nested JSON.

Settled while building it in phase 3:

- **Every fact category maps to one of the nine sections**, so nothing can be
  written and then silently never reach an agent. `health`, and any confirmed
  high-confidence negative fact whatever its category, are lifted into section 2.
  `equipment` and `technique` go to section 4. `organization`, `pantry_habit` and
  `social` go to section 5. `taste` and `other` go to section 6.
- **The budget cannot drop a dangerous fact.** Selection sorts health facts and
  confirmed high-confidence rejections ahead of everything else, so the cap only
  ever cuts into the nuanced end of the list.
- **The cap on facts stored (300) and the budget on facts shown (150) are
  different numbers.** Measured worst case: roughly 7 400 tokens at 150 facts and
  14 000 at 300, which is why the document shows fewer than it stores and says
  so.
- **Sections the build cannot fill yet are named as unavailable, with a reason,**
  rather than rendered empty. An agent must not read "no staples listed" as
  "there are no staples".
- **`last_referenced_at` is bumped only on a real read.** A user previewing their
  own snapshot in the UI does not count, or looking at the document would distort
  the pruning heuristic it feeds.

## 5. Tools

Names are stable API. Descriptions shown here in condensed form.

The surface is **twenty tools**, and they are registered in one place,
`src/mcp/server.ts`. That file is the authority: the tables below are a
description of it, not a second declaration of it.

**Every parameter is snake_case, at every depth.** A reader does not have to
check, and neither does an agent. That was not always true, and the way it was
untrue is worth stating so nobody restores it: a tool that declared its own
fields spelled them snake_case, and a tool that spread a domain Zod schema
straight into its `inputSchema` published the domain's camelCase, so
`update_slot` took `day_of_week` while `propose_week` took `dayOfWeek` and
`update_recipe` managed `recipe_id` beside `activeTimeMin` in one object. An
agent that learned one spelling from this server sent it to the next tool and got
`VALIDATION` for a parameter this same server had taught it. The wire shape now
lives in `src/mcp/schemas.ts`, camelCase stops at that boundary, and each wire
field reuses the domain field schema under a renamed key so the bounds, the enums
and the descriptions cannot drift apart. Section 5.4 lists what was renamed.

**Every parameter also carries a description,** which is the same claim as the
one in `CLAUDE.md` that tool and parameter copy is product copy: it is the only
way to steer an agent we do not run, so a parameter with no description is a
parameter an agent has to guess at. Two had none, `year` and `week` on
`link_prep`, and they were the two where a guess is most expensive: ISO week
numbering diverges from the civil calendar exactly at the turn of the year, so
an agent that assumes otherwise links the wrong week and finds out from an error
about entries that do not exist. Both say so now.

Neither of these two properties is a convention anyone has to remember.
`tests/mcp/surface.test.ts` walks the registered JSON Schema of every tool to
its full depth and fails on a parameter that is spelled in camelCase or that
carries no description, and it fails on a tool missing from the list this section
documents. A tool added without either cannot reach the surface.

### 5.1 Read tools

| Tool                   | Purpose                                             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whoami`               | Confirm the connection                              | No parameters. Returns `user_id`, `client_id` and `scopes`. This is the call the tool copy tells an agent to make first, which is exactly why it runs through the same guard as everything else: a connection test that cheerfully reports success on a revoked client is worse than none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `get_profile_snapshot` | The composed context document                       | One parameter, `format` (`markdown` or `json`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `search_recipes`       | Find recipes by criteria                            | Params: `query`, `tags`, `max_active_time_min`, `main_protein`, `batch_friendly`, `not_planned_in_weeks`, `not_cooked_in_weeks`, `min_rating`, `limit`, `offset`. Both rotation filters ship, and they are different questions: `not_planned_in_weeks` is about intention, `not_cooked_in_weeks` about what the recorded feedback says actually happened. The second is the one behind "give me something I have not eaten in a while". `min_rating` excludes an unrated recipe, because the absence of a rating is not a good rating. **`query` covers the recipe title and description and nothing else.** Ingredient names are not searchable: the search index is a Postgres generated column, and a generated column can only read the row it belongs to, while ingredients live in `recipe_ingredient`. The tool description says so in as many words, because an agent that searches for an ingredient and gets nothing concludes the library has no such dish rather than that it searched the wrong field. Reasoning recorded at `src/db/schema/recipes.ts` |
| `get_recipe`           | One full recipe                                     | Includes `difficulty`, `source` and `source_url`. A soft-deleted recipe is still readable, so history stays explicable, and is flagged `deleted` so it is not proposed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `get_week`             | A plan version with entries, rationales, prep links | Params: `year`, `week`, `version` (`active`, `pending`, or a number). `year` and `week` are optional together or not at all: `{ week: 40 }` is refused rather than silently answered about the current week. `orphaned_entries` are full entries, not stubs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `get_history`          | Cooked and skipped history with ratings             | One parameter, `weeks_back`. Also returns the unresolved signals and any slot time budget the data disagrees with. A meal with no `outcome` is unjudged, not failed, and the tool says so                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `get_pantry`           | Staples and use-soon                                | A removed item is excluded. `restore_pantry_item` brings one back                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `check_feasibility`    | Dry-run a proposed week without writing             | Takes exactly the parameters of `propose_week` and returns the same validation result, with no side effect. Lets an agent iterate before committing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

`check_feasibility` deserves emphasis: it converts the validation rules from a
wall the agent hits into a tool it can consult. That single addition is expected
to be the difference between a good and a frustrating agent experience.

### 5.2 Write tools

| Tool                     | Purpose                                              | Authority                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `propose_week`           | Create a plan version for a week, in one atomic call | Respects the user's authority setting: creates `pending`, or activates directly                                                                                                                                                                                                                                              |
| `update_slot`            | Set or clear a single slot in the active version     | Creates a new version under the hood. Never mutates in place                                                                                                                                                                                                                                                                 |
| `create_recipe`          | Add a recipe                                         | Marked agent-sourced                                                                                                                                                                                                                                                                                                         |
| `update_recipe`          | Edit a recipe, keeping a revision                    |                                                                                                                                                                                                                                                                                                                              |
| `import_recipe_from_url` | Server-side schema.org parse                         | Returns a structured `PARSE_FAILED` error inviting the agent to fetch and post the recipe itself, and `UPSTREAM_FAILED` when the remote server is the thing that failed. The two are separated on purpose: one means rewriting the address is pointless, the other means retrying the identical call later is the right move |
| `record_facts`           | Add one or more facts, up to twenty                  | Always enters as `unconfirmed`, source `agent`, client stamped. **The batch is one transaction:** a fact that breaches the cap means none of the batch is written, so the corrected batch can be resent whole with no risk of duplicating what got through                                                                   |
| `retire_fact`            | Retire a fact, with a reason                         | Never a hard delete, and `restore_fact` undoes it. An agent may retire an unconfirmed fact, or one an agent wrote; a fact the user confirmed themselves is refused with `FORBIDDEN`. See section 8                                                                                                                           |
| `restore_fact`           | Undo a retirement                                    | The fact resumes its place with its history and its retirement reason cleared. This is the tool for the case where the user corrects the agent just after a retirement: rewriting the fact with `record_facts` would duplicate it and lose its provenance                                                                    |
| `add_pantry_items`       | Add staples or use-soon items                        |                                                                                                                                                                                                                                                                                                                              |
| `remove_pantry_item`     | Take a product out of the pantry                     | Not a delete. The item leaves `get_pantry` and grocery coverage, and `restore_pantry_item` puts it back unchanged                                                                                                                                                                                                            |
| `restore_pantry_item`    | Undo a removal                                       | The product returns with its original name, quantity note and expiry date, which re-adding it would not preserve                                                                                                                                                                                                             |
| `link_prep`              | Declare a batch-cooking relation between entries     | Names the two meals by entry id, which is why every serialized entry carries `id`                                                                                                                                                                                                                                            |

`restore_fact` and `restore_pantry_item` are not conveniences. Rule 5 of
`CLAUDE.md` says nothing an agent does is irreversible, and pantry removal was
the one path on this surface that broke it.

### 5.3 `propose_week` in detail

The central call. One transaction.

Input, conceptually:

```
year, week
expected_base_version   (optimistic concurrency token, nullable for a fresh week)
summary                 (one paragraph: the reasoning behind the week as a whole)
new_recipes[]           (full recipe objects to create, each with a temp_id)
  temp_id
  title, description, image_url, servings
  prep_time_min, cook_time_min, active_time_min
  batch_friendly, keeps_days, tags, cuisine, main_protein, difficulty
  equipment_keys
  ingredients[]        (quantity, unit, raw_name, note, optional, ingredient_id)
  steps[]              (text, duration_min, unattended)
entries[]
  day_of_week
  meal_type            (key)
  recipe_ref           (existing recipe id, or temp_id from new_recipes)
  servings
  note
  rationale            (REQUIRED)
  rationale_refs       (fact ids, pantry item ids, feedback ids)
prep_links[]
  source_index         (position in entries of the meal actually cooked)
  dependent_index      (position in entries of the meal that is a reheat)
  servings_drawn
  note
```

Output:

```
version_id, version_number, state
validation:
  errors[]    (blocking, nothing was written)
  warnings[]  (written, but flagged for the user)
review_url    (deep link the agent can hand the user in chat)
```

Design notes:

- **Atomic recipe creation.** An agent inventing a week of new dishes should not
  make 8 `create_recipe` calls then a 9th to assign them, with partial failure
  possible in the middle. Temp ids resolved server-side in one transaction solve
  it.
- **`rationale` is required per entry.** Enforced by schema. An agent that cannot
  say why a dish is there has not personalized anything, and the user has nothing
  to correct.
- **`expected_base_version`** gives optimistic concurrency for the two-agents or
  agent-plus-human case. Mismatch returns `VERSION_CONFLICT` with the current
  state attached so the agent can rebase rather than ask the user.
- **`review_url`** exists so the agent's chat reply can end with a link the user
  clicks. This is the handoff from chat back to the app, and it is the moment the
  whole product either feels seamless or does not.

### 5.4 The snake_case migration

A breaking change to a published interface, and it is recorded here rather than
only in the code because an agent written against the old spelling will fail on
every affected call. Four tools spread a domain schema and so published
camelCase. Their parameters are now, at every depth:

`propose_week` and `check_feasibility`, at the top level:

| Was                   | Is                      |
| --------------------- | ----------------------- |
| `expectedBaseVersion` | `expected_base_version` |
| `newRecipes`          | `new_recipes`           |
| `prepLinks`           | `prep_links`            |

Within `entries[]` of either:

| Was             | Is               |
| --------------- | ---------------- |
| `dayOfWeek`     | `day_of_week`    |
| `mealType`      | `meal_type`      |
| `recipeRef`     | `recipe_ref`     |
| `rationaleRefs` | `rationale_refs` |

Within `prep_links[]` of either:

| Was              | Is                |
| ---------------- | ----------------- |
| `sourceIndex`    | `source_index`    |
| `dependentIndex` | `dependent_index` |
| `servingsDrawn`  | `servings_drawn`  |

Within `new_recipes[]`, `tempId` became `temp_id`. The rest of the recipe shape
is shared by `create_recipe`, `update_recipe` and `new_recipes[]`:

| Was                          | Is                            |
| ---------------------------- | ----------------------------- |
| `imageUrl`                   | `image_url`                   |
| `prepTimeMin`                | `prep_time_min`               |
| `cookTimeMin`                | `cook_time_min`               |
| `activeTimeMin`              | `active_time_min`             |
| `batchFriendly`              | `batch_friendly`              |
| `keepsDays`                  | `keeps_days`                  |
| `mainProtein`                | `main_protein`                |
| `equipmentKeys`              | `equipment_keys`              |
| `ingredients[].rawName`      | `ingredients[].raw_name`      |
| `ingredients[].ingredientId` | `ingredients[].ingredient_id` |
| `steps[].durationMin`        | `steps[].duration_min`        |

And `add_pantry_items`: `quantityNote` became `quantity_note`, `expiresOn`
became `expires_on`. `record_facts` needed no rename, its schema was already
snake_case throughout.

One consequence worth knowing before adding a tool. A handler now maps its
arguments to the domain shape and parses the result through the real domain
schema, and that second parse is required rather than belt and braces: the MCP
SDK rebuilds its own object from the `.shape` it is handed, which drops every
object-level refinement. `isoWeekSchema` carries a refinement refusing a week
the year does not have, so a tool that only spread the shape accepted `2027-W53`
and was refused several layers deeper, with an error about a plan rather than
about a week.

## 6. Validation and error taxonomy

Blocking errors (nothing is written):

| Code                   | Meaning                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STRICT_ALLERGEN`      | An entry's recipe contains a strict allergen. Names the allergen and the ingredient that matched                                                                                                                                                                                                                                                                        |
| `SLOT_NOT_PLANNED`     | Target slot is `skipped` or `hidden`                                                                                                                                                                                                                                                                                                                                    |
| `SLOT_UNKNOWN`         | Two mistakes share this code, and each is answered with the list that fixes it. Raised for a meal-type key nothing matches, it names the valid keys. Raised for a known key in a position this user's configuration has no slot for, it names the plannable slots. An agent told the wrong one of the two corrects the wrong thing, so they are deliberately not merged |
| `RECIPE_NOT_FOUND`     | Reference does not resolve                                                                                                                                                                                                                                                                                                                                              |
| `NOT_FOUND`            | The named thing does not exist. Where a set of alternatives exists it is listed: asking `get_week` for `version: "pending"` with no pending version names the versions that do exist                                                                                                                                                                                    |
| `FORBIDDEN`            | The caller may not do this to this row                                                                                                                                                                                                                                                                                                                                  |
| `TIME_BUDGET_EXCEEDED` | Active time exceeds the slot budget plus tolerance. Names slot, budget, and actual                                                                                                                                                                                                                                                                                      |
| `VERSION_CONFLICT`     | `expected_base_version` is stale. Returns current version                                                                                                                                                                                                                                                                                                               |
| `ACCESS_REVOKED`       | The account behind the token no longer has access to this instance. Not a client problem: reconnecting grants nothing, and `details.retryable` is `false` so an agent does not loop through the authorization dance                                                                                                                                                     |
| `PREP_LINK_ORDER`      | Source slot is after the dependent slot                                                                                                                                                                                                                                                                                                                                 |
| `MISSING_RATIONALE`    | An entry has no rationale                                                                                                                                                                                                                                                                                                                                               |
| `FACT_CAP_REACHED`     | Names the cap and lists the least recently referenced facts as retirement candidates                                                                                                                                                                                                                                                                                    |
| `VALIDATION`           | Generic schema failure with a field path                                                                                                                                                                                                                                                                                                                                |

Warnings (written, surfaced to the user):

`DIET_MISMATCH`, `EXCLUDED_INGREDIENT`, `EQUIPMENT_MISSING`,
`REPEAT_RECIPE_THIS_WEEK`, `SERVINGS_SHORTFALL` on a prep link,
`NOT_BATCH_FRIENDLY` used as a prep source, `BUDGET_EXCEEDED`,
`TIME_BUDGET_TIGHT`, `SLOT_NO_LONGER_PLANNED`.

**A warning carries `details` the way an error always did.** Four tools used to
return a warning as `{ code, message }` and drop the bag, while
`check_feasibility` kept it on the errors sitting beside them. The details are
where the correctable parts live: which slot overran and by how many minutes,
which ingredient matched. A warning stripped of them tells a client something is
wrong and nothing about what, which is the failure mode this whole taxonomy
exists to avoid, and it leaves a screen no choice but to render the server's
French sentence. See section 6.1.

Three codes were added in phase 4, when the agent surface became real. Nothing
could be rate limited or revoked before there was anything to call:

| Code             | Meaning                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `MISSING_SCOPE`  | The connection was not granted a scope this tool needs. Names the missing scopes, the granted ones, and how the user reconnects |
| `CLIENT_REVOKED` | The user revoked this client. The token may still be cryptographically valid; the data is closed anyway                         |
| `RATE_LIMITED`   | The client exceeded its calls per minute. Names the limit and points at the bulk resource that avoids the loop                  |

Four more were added in the September 2026 audit. Three of them were previously
reported as `VALIDATION`, and that was the defect rather than a shortcut:
`VALIDATION` means "your arguments were wrong, fix them and retry", so an agent
reads it as an instruction to edit its own call. For a server bug it edits a
correct call forever. For a page that publishes no recipe it rewrites a
perfectly good URL. For a remote server that is down it goes hunting for a typo
in an address that was right.

| Code                     | Kind        | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `INTERNAL`               | blocking    | The server failed and the call did not. Carries `details.retryable`, which says whether sending the identical call again is worth anything. **An agent must not modify its arguments in response to this code.** They were not the problem, and editing them is how a correct call gets rewritten into a wrong one                                                                                                                                                                                                                                           |
| `PARSE_FAILED`           | blocking    | The address was reachable and returned something, but no recipe could be read out of it. The URL is not in the cause and rewriting it changes nothing. The route forward is the one `import_recipe_from_url` names: fetch the page, read it, and post the recipe through `create_recipe`                                                                                                                                                                                                                                                                     |
| `UPSTREAM_FAILED`        | blocking    | The remote server refused or failed: a 5xx, a connection reset, a timeout. Nothing about the request needs changing, so the identical call retried later is the right move, and `details.retryable` is `true`                                                                                                                                                                                                                                                                                                                                                |
| `SLOT_NO_LONGER_PLANNED` | **warning** | A write carried an entry whose slot has since been set to skipped or hidden. The meal is kept, the week stays editable, and the grid will not show it. It is a warning rather than a blocking code because it is not the caller's mistake: this used to be a blocking `SLOT_NOT_PLANNED` raised on every later edit of such a week, naming a slot the caller had not touched, so changing Tuesday failed because of something done to Saturday. Carrying the entry forward silently would have been the other wrong answer, which is what the warning is for |

Note the asymmetry between the two upstream codes and the plain 4xx: a page that
answers 404 or 403 is still a `VALIDATION`, because there the address genuinely
is the thing to check.

Every error message is written to be actionable by a model, not by a developer.
Compare:

- Bad: `400 Bad Request: invalid slot`
- Good: `SLOT_NOT_PLANNED: Friday dinner is configured as skipped ("always takeaway"). Planned slots for this week are: Mon-Fri dinner, Sat lunch, Sat dinner, Sun lunch.`

The second one gets fixed on retry with no human involved. This is the highest
leverage per line of code in the entire project.

### 6.1 The same refusal, in two places

That agent-facing sentence is French, because French is the language of
everything the agent reads about this user, and it is one string, because a
model needs the whole rule at once. Neither property suits a screen: the
interface exists in two languages, and a sentence that arrived pre-assembled
cannot be translated.

So `details` carries the parts, and the screen rebuilds the sentence in the
reader's language from the code plus those parts. That is the second reason
details exist, alongside giving an agent the corrective information. It is also
why a warning's `details` are no longer dropped on the way out: a warning
without them leaves the screen the same choice an error without them would,
which is to print French. Two consequences worth knowing before changing an
error:

- **Dropping a field from a `details` object is a UI regression**, not a
  cosmetic change. The message degrades silently to the French sentence rather
  than failing. `tests/domain/error-params.test.ts` throws each rule for real
  and renders both catalogues to catch it.
- **Slot-bearing errors carry `dayOfWeek` and `mealTypeLabel`** as well as the
  assembled French `slot` label, because a day name baked into the details
  cannot be translated either.

`VALIDATION`, `NOT_FOUND`, `FORBIDDEN` and `RECIPE_NOT_FOUND` deliberately have
no screen template. They are thrown from dozens of unrelated places, so nothing
general would beat the sentence the service already wrote, and they fall back to
it.

`INTERNAL`, `PARSE_FAILED` and `UPSTREAM_FAILED` have no `details`-driven
template either, and for a different reason: what they say is the same every
time, so a flat key under `errors.*` is the whole job and there is nothing to
substitute. `ACCESS_REVOKED` has neither, because it is raised on the agent path
only: a browser session that lost access never gets that far, it is stopped at
the request.

`DIET_MISMATCH` and `BUDGET_EXCEEDED` are declared in the taxonomy but never
emitted: the first has nothing to test against until Q7 is settled, and the
second needs ingredient prices, which assumption A7 puts out of scope.

## 7. Published prompt pack

Since there is no server-side prompt, we ship the steering as downloadable
artifacts from the agent connection screen:

1. **A planning prompt template.** "Plan my week" with the recommended call
   sequence: read the snapshot, survey the recipe index, check feasibility,
   propose, then hand back the review link.
2. **A weekly-review prompt template.** Read history, record facts from what
   happened, suggest slot budget corrections.
3. **An MCP prompts capability.** MCP supports server-provided prompts, so both
   templates are exposed as MCP prompts too, meaning a client can offer them
   natively without the user copying anything.
4. **A skill pack** for Claude Code and Claude Desktop: a folder with the
   templates plus house rules ("always cite facts in rationale", "never fill a
   skipped slot", "prefer use-soon pantry items").

These are versioned in the repository alongside the tool definitions, because a
tool signature change invalidates a template.

## 8. What the agent must never be able to do

- Assign a strict-allergen recipe. Server-enforced, tested, no override path.
- Hard-delete anything.
- Confirm its own facts. Only a human moves a fact to `confirmed`.
- Retire a user-confirmed fact that a person wrote. An agent may retire an
  unconfirmed fact, and may retire a fact an agent wrote whatever its status, but
  a confirmed fact from the user is a claim a person made about themselves. An
  agent able to retire those could empty the fact store one call at a time, which
  is the shape rule 5 exists to prevent. `retire_fact` answers `FORBIDDEN`, and
  its description says plainly that the refusal is the rule working rather than a
  mistake the agent made. Every retirement is undone by `restore_fact`, which
  brings the fact back `unconfirmed` rather than to whatever status it held:
  nothing records the old status, and guessing `confirmed` would let a
  retire-then-restore pair conjure a confirmation no human gave.
- Change the authority mode. Escalating its own permissions is out.
- Modify feedback the user recorded.
- Modify or delete the activity log.
- Read another user's data. Enforced at the data layer, not the tool layer.
