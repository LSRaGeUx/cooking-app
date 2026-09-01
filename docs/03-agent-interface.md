# 03 - Agent Interface (MCP)

Status: draft v1
Last updated: 2026-08-31
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
  cannot reason about are worse than none.
  - `profile:read`, `profile:write`
  - `recipes:read`, `recipes:write`
  - `plan:read`, `plan:write`
  - `pantry:read`, `pantry:write`
  - `feedback:read`
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

Fallback for local use: a thin stdio wrapper that holds a personal access token
and proxies to the same HTTP endpoint. Not v1, but the tool layer must not assume
HTTP-only so this stays cheap to add.

## 3. Resources

Resources are for context the agent should pull once per session and re-read
rarely.

| URI | Content |
|---|---|
| `cooking://profile` | The composed profile snapshot, see section 4 |
| `cooking://slots` | Slot configuration with time budgets |
| `cooking://recipes/index` | Compact recipe index: id, title, active time, tags, protein, rotation age, cook rate. Not full recipes |
| `cooking://recipes/{id}` | One full recipe |
| `cooking://plan/current` | Active version of the current ISO week |
| `cooking://plan/{year}-W{week}` | Active version of a given week |
| `cooking://pantry` | Staples and use-soon items |
| `cooking://history/recent` | Last 8 weeks: what was planned, what was cooked, ratings, plus the unresolved signals |

The recipe index being compact and the full recipe being separate is a
deliberate context-budget decision: a 200-recipe library must be surveyable in a
few hundred tokens so the agent can decide what to fetch in full.

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

### 5.1 Read tools

| Tool | Purpose | Notes |
|---|---|---|
| `get_profile_snapshot` | The composed context document | Params: `format` (markdown, json), `include_history` |
| `search_recipes` | Find recipes by criteria | Params: text query, tags, max active time, protein, `not_planned_in_weeks`, limit. The rotation filter is what enables "give me something I have not eaten in a while". Shipped in phase 4 as `not_planned_in_weeks`, not `not_cooked_in_weeks`: feedback does not exist until phase 6, so "not cooked" would have been a lie. The two are different filters and phase 6 adds the second rather than redefining the first. `min_rating` waits for the same reason |
| `get_recipe` | One full recipe | |
| `get_week` | A plan version with entries, rationales, prep links | Params: year, week, `version` (active, pending, or number) |
| `get_history` | Cooked and skipped history with ratings | Params: weeks back. Also returns the unresolved signals and any slot time budget the data disagrees with. A meal with no `outcome` is unjudged, not failed, and the tool says so |
| `get_pantry` | Staples and use-soon | |
| `check_feasibility` | Dry-run a proposed week without writing | Returns the same validation result `propose_week` would, with no side effect. Lets an agent iterate before committing |

`check_feasibility` deserves emphasis: it converts the validation rules from a
wall the agent hits into a tool it can consult. That single addition is expected
to be the difference between a good and a frustrating agent experience.

### 5.2 Write tools

| Tool | Purpose | Authority |
|---|---|---|
| `propose_week` | Create a plan version for a week, in one atomic call | Respects the user's authority setting: creates `pending`, or activates directly |
| `update_slot` | Set or clear a single slot in the active version | Creates a new version under the hood. Never mutates in place |
| `create_recipe` | Add a recipe | Marked agent-sourced |
| `update_recipe` | Edit a recipe, keeping a revision | |
| `import_recipe_from_url` | Server-side schema.org parse | Returns a structured `PARSE_FAILED` error inviting the agent to fetch and post the recipe itself |
| `record_facts` | Add one or more facts | Always enters as `unconfirmed`, source `agent`, client stamped |
| `retire_fact` | Retire a fact, with a reason | Never a hard delete |
| `add_pantry_items` | Add staples or use-soon items | |
| `remove_pantry_item` | | |
| `generate_grocery_list` | Build the list for a plan version | |
| `link_prep` | Declare a batch-cooking relation between entries | |

### 5.3 `propose_week` in detail

The central call. One transaction.

Input, conceptually:

```
year, week
expected_base_version   (optimistic concurrency token, nullable for a fresh week)
summary                 (one paragraph: the reasoning behind the week as a whole)
new_recipes[]           (full recipe objects to create, referenced below by temp id)
entries[]
  day_of_week
  meal_type            (key)
  recipe_ref           (existing recipe id, or temp id from new_recipes)
  servings
  note
  rationale            (REQUIRED)
  rationale_refs       (fact ids, pantry item ids, feedback ids)
prep_links[]           (source entry index -> dependent entry index, servings)
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

## 6. Validation and error taxonomy

Blocking errors (nothing is written):

| Code | Meaning |
|---|---|
| `STRICT_ALLERGEN` | An entry's recipe contains a strict allergen. Names the allergen and the ingredient that matched |
| `SLOT_NOT_PLANNED` | Target slot is `skipped` or `hidden` |
| `SLOT_UNKNOWN` | No such (day, meal) in this user's config. Lists valid slots |
| `RECIPE_NOT_FOUND` | Reference does not resolve |
| `TIME_BUDGET_EXCEEDED` | Active time exceeds the slot budget plus tolerance. Names slot, budget, and actual |
| `VERSION_CONFLICT` | `expected_base_version` is stale. Returns current version |
| `PREP_LINK_ORDER` | Source slot is after the dependent slot |
| `MISSING_RATIONALE` | An entry has no rationale |
| `FACT_CAP_REACHED` | Names the cap and lists the least recently referenced facts as retirement candidates |
| `VALIDATION` | Generic schema failure with a field path |

Warnings (written, surfaced to the user):

`DIET_MISMATCH`, `EXCLUDED_INGREDIENT`, `EQUIPMENT_MISSING`,
`REPEAT_RECIPE_THIS_WEEK`, `SERVINGS_SHORTFALL` on a prep link,
`NOT_BATCH_FRIENDLY` used as a prep source, `BUDGET_EXCEEDED`.

Three codes were added in phase 4, when the agent surface became real. Nothing
could be rate limited or revoked before there was anything to call:

| Code | Meaning |
|---|---|
| `MISSING_SCOPE` | The connection was not granted a scope this tool needs. Names the missing scopes, the granted ones, and how the user reconnects |
| `CLIENT_REVOKED` | The user revoked this client. The token may still be cryptographically valid; the data is closed anyway |
| `RATE_LIMITED` | The client exceeded its calls per minute. Names the limit and points at the bulk resource that avoids the loop |

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
details exist, alongside giving an agent the corrective information. Two
consequences worth knowing before changing an error:

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
- Change the authority mode. Escalating its own permissions is out.
- Modify feedback the user recorded.
- Modify or delete the activity log.
- Read another user's data. Enforced at the data layer, not the tool layer.
