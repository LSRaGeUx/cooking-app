# 01 - Functional Specification

Status: draft v1
Last updated: 2026-08-31
Depends on: `00-vision.md`

## 1. Domain vocabulary

Fixed terms. Used identically in UI copy, database, and MCP tool names.

| Term | Meaning |
|---|---|
| **User** | One authenticated account. In v1, one eater. |
| **Profile** | The structured, enforced part of what we know: allergies, diet, skill, equipment, budget, time budgets, slot config. |
| **Fact** | One atomic, categorized, free-text statement about the user, with source, confidence, and timestamp. Agent-writable. |
| **Slot** | One plannable position: a (day, meal) pair, for example Tuesday dinner. Which slots exist is per-user config. |
| **Recipe** | A reusable dish definition: ingredients, steps, times, tags. Owned by the user. |
| **Plan** | One week of assignments of recipes to slots. Versioned. |
| **Plan version** | An immutable snapshot of a plan. A proposal is a version in `pending` state. |
| **Entry** | One recipe assigned to one slot inside a plan version, plus servings and notes. |
| **Prep link** | A relation stating that entry A's cooking session produces food consumed by entry B. |
| **Grocery list** | A derived, then user-editable, aggregation of a plan version's ingredients minus pantry coverage. |
| **Pantry item** | Something the user has: a staple (always present) or a use-soon item (expiring). |
| **Feedback** | Per-entry outcome after the fact: cooked, skipped, or swapped, plus optional rating and note. |

## 2. Core loop

```
      configure profile + slots
                 |
                 v
   +---->  plan the week  <-----------------+
   |      (manual or agent)                 |
   |             |                          |
   |             v                          |
   |      grocery list  ----> shop          |
   |             |                          |
   |             v                          |
   |          cook                          |
   |             |                          |
   |             v                          |
   |      record feedback                   |
   |             |                          |
   |             v                          |
   +----   facts updated  ------------------+
          (by user or agent)
```

Everything else is support. If a feature does not feed or consume this loop, it
is out.

## 3. Slot configuration

The grid is not fixed. Per user:

- A set of enabled meals, from an extensible list: breakfast, lunch, dinner,
  snack. Custom labels allowed.
- Per (day, meal) pair, one of three states:
  - **planned**: appears in the grid and expects a recipe.
  - **skipped**: appears greyed, deliberately not planned (for example "Friday
    dinner is always takeaway"). Agent must not fill these.
  - **hidden**: not shown at all.
- Per slot, an optional **time budget** in minutes, meaning active cooking time
  the user is willing to spend at that slot. This is the single most valuable
  organization field in the model: it encodes "Tuesday I get home late" as a
  number an agent can plan against.
- Per slot, an optional **servings** default.

Rules:

- A user must have at least one planned slot to create a plan.
- Changing slot config never mutates existing plan versions. Historic plans keep
  the grid they were made with.
- If a slot becomes hidden while a plan entry occupies it, the entry survives in
  the data and renders in an "orphaned entries" strip on the plan screen.

## 4. Profile (structured part)

Enforced fields, because these need validation, filtering, or hard blocking:

| Field | Type | Enforcement |
|---|---|---|
| Allergies and intolerances | list of allergens, each with severity (avoid / strict) | **Strict is a hard block.** A recipe containing a strict allergen cannot be assigned to a slot, by UI or by agent. Server rejects. |
| Diet | one of none, vegetarian, vegan, pescatarian, halal, kosher, plus free-text extras | Hard filter on recipe assignment, overridable per entry with an explicit confirmation |
| Hard exclusions | list of ingredients the user refuses | Warning on assignment, not a block |
| Skill level | 1 to 5 | Advisory, surfaced to the agent |
| Equipment | list from a controlled vocabulary, extensible | Advisory. Recipes declare required equipment, mismatch raises a warning |
| Weekly budget | amount plus currency, optional | Advisory. Enables cost estimates when recipe ingredients carry prices |
| Default servings | integer | Default for new entries |
| Default time budget | minutes | Fallback when a slot has none |
| Variety preference | 1 to 5, from "I like repetition" to "never repeat" | Advisory, drives agent repetition behavior |
| Shopping day | one ISO weekday, optional | Defines the shopping cycle, which is what a grocery list covers. See section 8 |
| Locale and units | language, unit system | Formatting |

Allergen handling is the only place in the whole system with a hard,
non-overridable block. Everything else is a warning the user can accept. That
asymmetry is deliberate: a warning the user can click through is safe for a
disliked ingredient and unacceptable for a severe allergy.

## 5. Facts (open part)

The learning surface. One fact is one statement.

Fields:

| Field | Notes |
|---|---|
| Category | taste, organization, pantry habit, social, health, equipment, technique, other |
| Statement | Short free text, one assertion. "Dislikes coriander", not a paragraph |
| Polarity | positive, negative, neutral. Lets the agent filter fast |
| Confidence | low, medium, high |
| Source | user, agent, inferred-from-feedback |
| Status | unconfirmed, confirmed, retired |
| Timestamps | created, last referenced |
| Optional evidence | references to entries or feedback that support it |

Rules:

- Facts written by an agent enter as **unconfirmed**. They are still visible to
  agents and still influence planning, but the UI marks them and offers confirm
  or delete in one click.
- A fact is never silently overwritten. Contradiction is resolved by retiring
  the old fact and creating a new one, preserving history. This matters: "user
  used to hate mushrooms, now eats them" is real signal.
- Facts are soft-capped (for example 300 active). Past the cap, the user is
  prompted to prune, and the least recently referenced unconfirmed facts are
  surfaced first. Rationale: an unbounded fact list becomes an unusable context
  dump and degrades agent output.
- Retired facts are excluded from the agent-facing profile snapshot but kept for
  history.

### Why facts and not just a free-text note

A single markdown blob is more expressive but has three fatal properties:
allergies stop being enforceable, nothing is queryable or prunable, and
contradictions accumulate invisibly. Atomic facts keep expressiveness while
staying diffable, reviewable, and attributable.

## 6. Recipes

### 6.1 Shape

- Title, optional description, optional image, source (manual, agent, imported,
  with original URL when imported).
- Servings the quantities are expressed for.
- Prep time, cook time, and derived total. **Active time** is tracked separately
  from total time, because unattended oven time does not consume the user's
  evening.
- Ingredients: ordered list. Each has quantity (optional), unit (optional), name,
  optional note ("finely chopped"), and an optional link to a normalized
  ingredient record.
- Steps: ordered list of text.
- Tags: free-form plus derived (cuisine, main protein, season, difficulty).
- Required equipment: list.
- Allergens: derived from ingredients where possible, user-overridable.
- Batch friendliness: does this scale and keep well. Feeds prep planning.

### 6.2 Creation paths

1. **Manual.** A form. Must stay fast: title plus paste-a-block-of-ingredients
   with a light parser is enough to save.
2. **Agent-generated.** The agent creates a recipe through MCP with full
   structure. It is stored exactly like a manual one, flagged as agent-sourced,
   and is editable.
3. **URL import.** Two-tier strategy:
   - Tier 1, server-side: fetch the page, read schema.org Recipe JSON-LD or
     microdata, normalize. This covers the large majority of recipe sites at
     zero cost and no LLM.
   - Tier 2, agent-assisted: when tier 1 finds nothing, the app returns a clear
     "could not parse" result. The user's agent can fetch the page itself, read
     it, and POST a structured recipe. This is the pattern that replaces
     server-side AI throughout the app: when parsing gets hard, hand the job to
     the agent that is already in the loop.

### 6.3 Normalized ingredients

A separate, shared-by-that-user ingredient table with canonical names, aliases,
default unit, category (produce, dairy, dry goods, and so on), and aisle. Two
things depend on it and neither works without it:

- Grocery list merging: "2 onions" plus "1 oignon jaune" must add up.
- Allergen derivation.

Linking is best-effort: an unlinked ingredient still works, it just does not
merge.

## 7. Plans and versioning

### 7.1 Model

A plan is identified by a user and an ISO week. It holds an ordered list of
versions. Exactly one version is `active`. Versions can be `pending` (a
proposal), `active`, or `superseded`.

### 7.2 Manual planning

- Grid view of the configured slots for the week.
- Assign a recipe by search, by picking from a "suggestions" strip (recently
  cooked, highly rated, not cooked in N weeks), or by creating a recipe inline.
- Drag an entry between slots. Duplicate an entry to another slot (this is how a
  user manually expresses leftovers).
- Set servings and a per-entry note.
- Clear a slot. Mark a slot skipped for this week only, without touching config.

### 7.3 Agent planning

Two authority modes, a user setting, defaulting to proposal:

**Proposal mode (default).** The agent writes a new version in `pending` state.
The UI shows a review screen with a slot-by-slot diff against the active
version: unchanged, changed, added, removed. The user can:
- Accept the whole version, which activates it.
- Accept per slot, which builds a new version from the chosen entries.
- Reject with an optional reason. The reason is recorded and offered to the agent
  as feedback (and is high-quality training signal for facts).

**Direct mode.** The agent activates its version immediately. Full history is
kept and one-click revert restores the previous version.

Additional rules:
- Only one pending version at a time per plan week. A new proposal supersedes any
  earlier pending one.
- The agent must state a **rationale per entry**: which profile fields, facts,
  pantry items, or feedback drove that choice. This is required, not optional,
  for three reasons: it makes the personalization visible (the whole pitch), it
  makes bad proposals debuggable, and it lets the user correct the underlying
  fact rather than just the dish.
- Server-side validation rejects any agent write that: fills a skipped slot,
  places a strict-allergen recipe, exceeds a slot time budget by more than a
  configurable tolerance, or references a nonexistent recipe. Rejection returns
  a structured error the agent can act on, not a generic 400.

### 7.4 Prep links and batch cooking

An entry may declare that it is served by another entry's cooking session.

- Entry B links to entry A as its source. B carries no separate cooking work,
  only reheat or assembly instructions.
- A's servings must cover the sum of all linked entries. The UI shows the
  computed total and flags a shortfall.
- The grocery list counts A's ingredients once, scaled to the total.
- A prep link requires A's slot to be chronologically at or before B's slot.
- Recipes flagged as not batch-friendly raise a warning when used as a source.

This is the feature that turns the time budget data into something useful: a
Tuesday with a 15-minute budget is satisfiable by Sunday's batch.

## 8. Grocery list

### 8.1 The shopping cycle

A grocery list covers a **shopping cycle**, not an ISO week. The cycle is
derived from the profile's shopping day and runs seven days starting on it: a
cook who shops on Saturday gets a list covering Saturday to Friday, which
crosses the week boundary without being asked about it.

The week is the wrong unit for a list, for three reasons seen in use: you shop
on Saturday for the days that follow, so you want next week's meals and not
this week's; you shop mid-week and the meals already cooked are still sitting
unticked on the list; and you shop once for a span that straddles a Sunday.

Rules:

- The cycle containing today is the one that starts on the most recent shopping
  day, that day included. On the shopping day itself the list therefore switches
  to the new cycle: you shop for the week that starts now.
- The list aggregates every entry whose date falls inside the cycle, taken from
  the active version of each ISO week the cycle overlaps. A cycle overlaps at
  most two weeks.
- **The unit is the cooking session, not the meal.** You buy for a session that
  happens inside the cycle, scaled to cover everything it feeds, including a
  meal that will be eaten after the next shop: the cooking is now, so the
  ingredients are needed now. A meal fed by a session outside the cycle costs
  nothing here, because it was bought with that session on an earlier shop.
  Aggregating by meal instead would double-buy every batch that straddles a
  shop.
- A list is stale when any version it was built from is no longer active.
- With no shopping day set, the cycle is the ISO week containing today, Monday
  to Sunday. The feature is additive: an unconfigured account behaves as before.
- One live list per cycle, identified by the date it starts on.

Shifting a single cycle ("shopping on Friday this week") is deliberately not in
v1. The derived cycle is right almost always, and a manual override is the kind
of control that earns its place only once the automatic answer annoys someone.

### 8.2 Contents

- Generated from the plan on demand, then persisted and editable. It is a
  snapshot, not a live view, because the user shops with it while the plan may
  still change.
- Aggregation: sum quantities per normalized ingredient, converting compatible
  units. Non-convertible or unlinked items are listed separately rather than
  guessed.
- Pantry subtraction: items marked as staples are excluded by default and shown
  in a collapsed "you should already have" section. Use-soon items are called
  out with a "use this" marker.
- Optional ingredients are listed, in a collapsible section of their own after
  the aisles, and are counted in neither the aisle totals nor the progress
  figure. They are a decision made in front of the shelf, not part of what the
  trip is for, so a list that hides them loses information and a list that mixes
  them into the aisles can never be finished.
- An ingredient that is required by one meal and optional by another produces
  two lines, one in each section. The quantities are never added: what you must
  buy stays what you must buy.
- A line says which meals it is for in colour, with the same seal each dish
  wears in the week, rather than in words. The meal names stay available on the
  line's title and to a screen reader.
- Grouped by aisle, collapsible, with a checkbox per line. State persists.
- Manual lines can be added (non-recipe items: coffee, dish soap).
- Regenerating after a plan change performs a merge, not a wipe: checked state
  and manual lines survive, and changed lines are highlighted.
- Mobile is the primary viewport for this screen. It is used one-handed in a
  shop.

## 9. Pantry (deliberately minimal)

Two lists, no stock accounting:

- **Staples.** Things always present. Name plus optional note. Excluded from
  grocery lists.
- **Use soon.** Name, optional quantity, optional expiry or added date. Surfaced
  to the agent as a planning priority and marked in the grocery list.

Explicitly not in v1: quantities decremented on cooking, barcode scanning,
expiry notifications, full inventory. Those are what kill inventory features.
The user's job here is 30 seconds of typing, not bookkeeping.

Agents can read both lists and can add use-soon items (for example after the
user mentions leftovers in chat).

## 10. Feedback loop

Per plan entry, after its slot date passes:

- Outcome: cooked, skipped, or swapped (with what was eaten instead, free text).
- Optional rating, 1 to 5.
- Optional note.
- Optional flags: took longer than expected, too much food, too little food.

Surfacing: a light prompt on the plan screen for past slots, never a modal, never
blocking. Batch-fillable for a whole past week in one screen.

Derived signals available to the agent:
- Cook rate per recipe and per slot position.
- Recipes never cooked despite being planned more than once, which is a strong
  negative signal that a rating never captures.
- Time overruns per slot, which should correct the slot time budget.
- Rotation age: weeks since a recipe was last cooked.

The agent is expected to convert repeated signals into facts, with low
confidence and cited evidence. The app itself derives no facts automatically in
v1: no server-side inference, keeping the zero-cost constraint clean and keeping
the fact store honest about provenance.

## 11. Screens

| Screen | Purpose | Notes |
|---|---|---|
| **Week** (home) | The grid. Plan, review proposals, record feedback | The one screen that matters. Deep-linkable per week |
| **Proposal review** | Slot-by-slot diff of a pending version, with rationale per entry | Accept all, accept per slot, reject with reason |
| **Recipe library** | Search, filter by tag, time, protein, rotation age | Filters must include "not cooked in N weeks" |
| **Recipe detail and edit** | View and edit, see plan history for this recipe | Shows aggregate feedback |
| **Grocery list** | Shop from it | One shopping cycle per list, mobile-first, offline-tolerant |
| **Pantry** | Staples and use-soon | Two short lists |
| **Profile** | Structured fields | Grouped: dietary, kitchen, organization, preferences |
| **Facts** | Review, confirm, edit, retire, filter by category and status | Unconfirmed agent facts shown first. This screen is the trust surface of the product |
| **Slot configuration** | Define the weekly grid and time budgets | Visual week editor, not a form |
| **Agent connection** | Get the MCP URL, connect, test, see recent agent activity | Treated as a first-class feature, see below |
| **Agent activity log** | Chronological list of every agent read and write | Essential for trust and for debugging bad proposals |
| **Account** | Auth, sessions, connected clients, export, delete | Includes revoking an agent client |

### 11.1 Agent connection screen

This screen decides whether the product works at all, so it is specified
explicitly:

- The MCP endpoint URL, one click to copy.
- Step-by-step instructions per client (Claude Desktop, Claude Code, generic).
- A "test connection" indicator showing last successful handshake.
- List of connected clients with name, first connected, last seen, and a revoke
  button.
- A link to download the published prompt template and skill pack (see
  `03-agent-interface.md`).
- Authority mode toggle (proposal or direct) with a plain-language explanation.

## 12. Cross-cutting rules

1. **Allergen strictness is absolute.** No path, UI or MCP, can assign a recipe
   containing a strict allergen. Server-enforced, tested.
2. **Every agent write is logged and attributable**, with client identity,
   timestamp, tool name, and payload summary.
3. **Nothing the agent does is irreversible.** Plan versions are immutable and
   revertible. Facts are retired, not deleted. Recipe edits keep a prior
   revision. Deletion of user-visible entities is soft delete for 30 days.
4. **The app never calls an LLM.** Any feature that seems to need one gets
   restructured as a tool the user's agent can call. This is a hard
   architectural rule, enforced by having no LLM SDK in the dependency tree.
5. **Historic data is immutable.** Changing profile, slots, or a recipe never
   rewrites past plans or past grocery lists.
6. **Metric units and French UI**, with all copy externalized from day 1.

## 13. Edge cases worth deciding now

| Case | Decision |
|---|---|
| Recipe deleted while used in past plans | Soft delete. Past entries keep a denormalized title snapshot so history stays readable |
| Recipe edited after being cooked | Entries store the recipe reference plus a snapshot of servings and ingredient list used at plan time. Grocery lists already generated are untouched |
| Agent proposes a recipe that does not exist yet | Allowed and expected: the tool contract lets a single call create recipes and assign them atomically, in one transaction |
| Two agents connected at once | Allowed. Optimistic concurrency on plan versions via an expected-version token. Second writer gets a conflict error with the current state |
| User changes slot config mid-week | Active plan version untouched. Orphaned entries strip appears |
| Week with no plan | Grid renders empty and plannable. No implicit plan creation until first assignment |
| Plan spanning a year boundary | ISO week numbering with an explicit year, never a bare week number |
| Same recipe twice in one week | Allowed, no warning below a variety preference of 4, warning at 4 or 5 |
| Prep link source gets cleared | Dependent entries are flagged as unsourced, not deleted, and the plan shows an unresolved-prep banner |
| Grocery list for a pending version | Allowed, clearly labelled as a draft for an unapproved proposal |
| Unit conversion impossible (2 onions plus 300g onions) | List both lines under the same ingredient heading rather than fabricating a conversion |
| Fact contradicts a profile field | Profile field wins for enforcement. The contradiction is surfaced on the facts screen for the user to resolve |
| Agent hits the fact cap | Write is rejected with a structured error naming the cap and suggesting retirement of specific stale facts |
