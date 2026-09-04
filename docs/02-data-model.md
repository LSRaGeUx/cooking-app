# 02 - Data Model

Status: draft v1
Last updated: 2026-08-31
Depends on: `01-functional-spec.md`

Target: PostgreSQL. Conventions: `id` is uuid v7 (time-sortable), every
user-owned table carries `user_id` with an index and a row-level scoping rule,
timestamps are `timestamptz`, soft deletes use `deleted_at`.

Three conventions were corrected against reality when phase 1 built the schema,
and the corrections apply to every table below:

- **`id` defaults to `uuidv7()`**, which PostgreSQL 18 ships in core. No
  extension and no application-side id generation.
- **`user_id` is `text`, not `uuid`.** Better Auth owns the `user` table and
  types its `id` as text, so a uuid column here would reject every real user id
  on insert. There is no foreign key to `user` either: the two migrators run in
  sequence and Drizzle's runs first, so the referenced table does not exist yet.
  Deleting an account therefore has to delete domain rows explicitly, which is
  part of the phase 10 account-deletion work.
- **Child tables carry a denormalized `user_id`**, including
  `recipe_ingredient`, `recipe_step`, `recipe_revision`, `plan_version` and
  `plan_entry`. Their row-level security policy is then a column comparison
  rather than a subquery up the parent chain, and a forgotten join cannot leak
  across tenants.

## 1. Entity overview

```
              user
                |
   +------------+-------------------------------------------+
   |            |              |            |               |
profile      fact         slot_config    recipe          pantry_item
(1:1)        (1:N)          (1:N)         (1:N)             (1:N)
                                            |
                                     recipe_ingredient
                                     recipe_step
                                            |
                                        ingredient  (normalized, per user)

              user
                |
              plan  (1 per user per ISO week)
                |
           plan_version  (N, one active)
                |
             +--+--------------------+
             |                       |
        plan_entry              grocery_list
             |                       |
      prep_link (entry->entry)  grocery_line
             |
        entry_feedback

              user
                |
   +------------+--------------+
   |                           |
oauth_client (MCP clients)   agent_activity
```

## 2. Identity and access

### `user`
Owned and migrated by Better Auth, not by us. Its actual shape is `id` (text),
`name`, `email`, `emailVerified`, `image`, `createdAt`, `updatedAt`.

The `locale` and `unit_system` fields originally specified here were never added
to it, because extending a table another migrator owns means re-syncing on every
upgrade. Both are per-user preferences that belong on `profile` when they are
needed; the app is French and metric until then.

Auth-adjacent tables (`session`, `account`, `verification`, and the eight OAuth
tables) follow the auth library's schema and are not hand-designed here. See
`04-tech-spec.md` and `07-phase-0-findings.md` section 3.1.

### `oauth_client`
Registered MCP clients, created by dynamic client registration. Also owned by
Better Auth, as `oauthClient`, with a text `id`. Everywhere the domain schema
refers to a client (`agent_activity.oauth_client_id`, `recipe.source_client_id`,
`fact.source_client_id`, `plan_version.created_by_client_id`) it stores that text
id with no foreign key, for the reason given at the top of this document.

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| client_id, client_secret_hash | text | |
| name, redirect_uris | text, text[] | |
| user_id | uuid | FK, nullable until first authorization |
| created_at, last_seen_at, revoked_at | timestamptz | |

### `agent_activity`
Append-only audit log. Every MCP call lands here.

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | FK |
| oauth_client_id | uuid | FK, nullable |
| tool_name | text | |
| direction | text | `read` or `write` |
| payload_summary | jsonb | Redacted, size-capped |
| result | text | `ok`, `rejected`, `error` |
| rejection_code | text | nullable, matches the error taxonomy |
| created_at | timestamptz | index on (user_id, created_at desc) |

Retention: 90 days by default, configurable.

## 3. Profile and facts

### `profile` (1:1 with user)
| Column | Type | Notes |
|---|---|---|
| user_id | uuid | PK and FK |
| diet | text | enum-like, `none` default |
| diet_notes | text | free text extras |
| skill_level | smallint | 1 to 5 |
| default_servings | smallint | |
| default_time_budget_min | smallint | nullable |
| variety_preference | smallint | 1 to 5 |
| shopping_day | smallint | nullable, ISO 1 to 7. Defines the shopping cycle a grocery list covers |
| weekly_budget_amount | numeric(10,2) | nullable |
| weekly_budget_currency | char(3) | nullable |
| agent_authority | text | `proposal` or `direct` |
| time_budget_tolerance_min | smallint | default 10, used by write validation |
| updated_at | timestamptz | |

### `allergen`
| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | FK |
| name | text | |
| severity | text | `avoid` or `strict` |
| matches | text[] | ingredient names and aliases that trigger it |

`severity = 'strict'` is the only hard block in the system. The matching list is
explicit rather than inferred, because a false negative here is a health event.

### `exclusion`
Ingredients the user refuses. Same shape minus severity. Produces warnings only.

### `equipment`
| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | FK |
| key | text | controlled vocabulary, for example `oven`, `wok`, `pressure_cooker` |
| label | text | for user-added items |

### `fact`
The learning store. Central to the product.

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | FK |
| category | text | `taste`, `organization`, `pantry_habit`, `social`, `health`, `equipment`, `technique`, `other` |
| statement | text | max 280 chars, enforced. One assertion |
| polarity | text | `positive`, `negative`, `neutral` |
| confidence | text | `low`, `medium`, `high` |
| source | text | `user`, `agent`, `feedback_inference` |
| source_client_id | uuid | nullable FK to oauth_client |
| status | text | `unconfirmed`, `confirmed`, `retired` |
| supersedes_id | uuid | nullable self FK, for contradiction history |
| evidence | jsonb | array of references: entry ids, feedback ids, free text |
| created_at | timestamptz | |
| last_referenced_at | timestamptz | bumped when included in a profile snapshot |
| retired_at | timestamptz | nullable |
| retirement_reason | text | nullable, why it stopped being true. Added in phase 5 |

Invariants:
- Agent-written facts must be created with `status = 'unconfirmed'`. Server
  overrides any other value.
- A fact is never updated in place to change its meaning. Contradiction sets
  `retired_at` on the old row and creates a new row with `supersedes_id` set.
- Active fact count (`status <> 'retired'`) is capped per user. Default 300.
- The `statement` length cap exists to keep facts atomic. Without it the field
  degrades into the free-text blob that was explicitly rejected.

Enforced in the schema rather than only in the service, because these are the
invariants that make the store trustworthy:

- `char_length(statement) between 1 and 280`, so no code path can write a blob.
- `(status = 'retired') = (retired_at is not null)`, so a retired fact always
  carries its date and a live one never does.
- Check constraints on category, polarity, confidence, source and status.

In the service, `status` is derived from the caller rather than read from the
payload, and only `category` and `confidence` are updatable in place. Changing a
statement or a polarity goes through the supersede path, which is what keeps
"used to hate mushrooms, now eats them" legible.

## 4. Slot configuration

### `meal_type`
| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | FK |
| key | text | `breakfast`, `lunch`, `dinner`, `snack`, or custom |
| label | text | display |
| sort_order | smallint | |

### `slot_config`
One row per (day of week, meal type) the user has an opinion about.

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | FK |
| day_of_week | smallint | 1 = Monday to 7 = Sunday, ISO |
| meal_type_id | uuid | FK |
| state | text | `planned`, `skipped`, `hidden` |
| time_budget_min | smallint | nullable, active cooking minutes |
| default_servings | smallint | nullable |

Unique on (user_id, day_of_week, meal_type_id).

Note: this is a template, not instances. A plan version references the template
state as it was, via a snapshot, so later config changes never rewrite history.

## 5. Recipes

### `ingredient` (normalized, per user)
| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | FK |
| canonical_name | text | |
| aliases | text[] | drives matching on import and on grocery merge |
| category | text | `produce`, `dairy`, `meat`, `fish`, `dry_goods`, `spice`, `frozen`, `other` |
| aisle | text | nullable, drives grocery grouping |
| default_unit | text | nullable |
| density_g_per_ml | numeric | nullable, enables volume to mass conversion |
| allergen_ids | uuid[] | contributes to derived recipe allergens |

Per-user rather than global: it avoids a shared-vocabulary governance problem in
a self-hosted app, and a user's aisle layout is their own supermarket's. A
seeded starter set ships with the app.

### `recipe`
| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | FK |
| title | text | |
| description | text | nullable |
| image_url | text | nullable |
| source | text | `manual`, `agent`, `import` |
| source_url | text | nullable |
| source_client_id | uuid | nullable, which agent created it |
| servings | smallint | quantities are expressed for this |
| prep_time_min, cook_time_min | smallint | |
| active_time_min | smallint | attended time. Distinct from total, load-bearing for slot budgets |
| batch_friendly | boolean | default false. Gates prep-link sourcing |
| keeps_days | smallint | nullable, how long leftovers last |
| tags | text[] | |
| cuisine, main_protein, difficulty | text | nullable, derived or set |
| equipment_keys | text[] | required equipment |
| allergen_ids | uuid[] | derived from ingredients, user-overridable |
| revision | integer | bumped on edit |
| search_vector | tsvector | generated, `to_tsvector('french', title || description)`, GIN indexed |
| created_at, updated_at, deleted_at | timestamptz | |

`search_vector` is a stored generated column so search can never drift from the
row. Tags are deliberately not in it: `array_to_string` is `STABLE` rather than
`IMMUTABLE`, so PostgreSQL refuses it in a generated column, and tags are a set
filter anyway. They get their own GIN index and are matched with `&&`.

### `recipe_ingredient`
| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| recipe_id | uuid | FK, cascade |
| position | smallint | |
| quantity | numeric | nullable |
| unit | text | nullable |
| raw_name | text | as written by the author |
| ingredient_id | uuid | nullable FK, best-effort link |
| note | text | nullable |
| optional | boolean | default false, shopped from the grocery list's own optional section |

`ingredient_id` nullable is intentional: an unlinked ingredient still displays
and still cooks, it only loses merging. Blocking recipe save on perfect linking
would make creation slow, and creation speed is what fills the library.

### `recipe_step`
| Column | Type | Notes |
|---|---|---|
| id, recipe_id, position | | |
| text | text | |
| duration_min | smallint | nullable |
| unattended | boolean | default false, feeds active-time computation |

### `recipe_revision`
Prior versions, stored as a jsonb snapshot with a timestamp. Cheap insurance for
agent-driven edits.

## 6. Plans

### `plan`
| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | FK |
| iso_year | smallint | |
| iso_week | smallint | 1 to 53 |
| created_at | timestamptz | |

Unique on (user_id, iso_year, iso_week). Never a bare week number.

### `plan_version`
| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| plan_id | uuid | FK |
| version_number | integer | monotonic per plan |
| state | text | `pending`, `active`, `superseded`, `rejected` |
| created_by | text | `user` or `agent` |
| created_by_client_id | uuid | nullable |
| summary | text | nullable, agent's one-paragraph explanation of the week |
| slot_snapshot | jsonb | the grid as configured at creation time |
| rejection_reason | text | nullable, captured on reject. High-value signal |
| created_at, activated_at | timestamptz | |

Invariants:
- At most one `active` version per plan. Activating one supersedes the previous.
- At most one `pending` version per plan. A new proposal supersedes any pending.
- Versions are immutable once created, except for the state transition columns.
  Edits create a new version. This is what makes every agent action revertible.

### `plan_entry`
| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| plan_version_id | uuid | FK, cascade |
| day_of_week | smallint | |
| meal_type_id | uuid | FK |
| recipe_id | uuid | nullable FK |
| recipe_title_snapshot | text | keeps history readable after recipe deletion |
| recipe_revision_snapshot | integer | which revision was planned |
| servings | smallint | |
| note | text | nullable |
| rationale | text | nullable for user-created, **required for agent-created** |
| rationale_refs | jsonb | fact ids, feedback ids, pantry item ids the agent cited |
| position | smallint | for multiple dishes in one slot |

The `rationale` and `rationale_refs` pair is the mechanism that makes
personalization inspectable. Without it, a proposal is indistinguishable from a
random pick and the user has nothing to correct but the dish itself.

### `prep_link`
| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| source_entry_id | uuid | FK, **nullable**, the cooking session |
| dependent_entry_id | uuid | FK, the reheat or assembly |
| servings_drawn | smallint | |
| note | text | nullable |

Invariants: source slot must be chronologically at or before the dependent slot,
both entries must belong to the same plan version, and the sum of
`servings_drawn` plus the source's own consumption must not exceed the source
entry's servings (violation is a warning, not a rejection, because a user may
knowingly stretch a dish).

Two things the original spec did not account for, both settled in phase 8:

- **`source_entry_id` is nullable.** Clearing the cooking session must not
  delete the meal that depended on it, so the link survives unsourced and the
  week screen flags it. A unique index on `dependent_entry_id` keeps it to one
  source per meal, because two would make the shortfall arithmetic ambiguous.
- **Links are remapped when a week is edited**, exactly like feedback: plan
  versions are immutable, so every edit rewrites both entries a link points at.

### `entry_feedback`
| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| plan_entry_id | uuid | unique FK |
| outcome | text | `cooked`, `skipped`, `swapped` |
| swapped_for | text | nullable free text |
| rating | smallint | nullable, 1 to 5 |
| note | text | nullable |
| took_longer | boolean | |
| portion_issue | text | nullable, `too_much` or `too_little` |
| created_at | timestamptz | |

`plan_entry_id` is unique, so recording again corrects the previous answer
rather than stacking a second one.

One thing the original spec did not account for: a plan entry belongs to an
immutable version, so editing a week rewrites its entries and would orphan every
verdict attached to them. The planning service therefore re-points existing
feedback at the new entry when it copies a slot forward. Feedback belongs to
what happened in that slot this week, not to one revision of the plan.

## 7. Grocery lists

### `grocery_list`
| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | FK |
| starts_on | date | first day of the shopping cycle, and the list's identity |
| ends_on | date | last day covered, `starts_on` plus six |
| state | text | `draft`, `active`, `archived` |
| generated_at, updated_at | timestamptz | |

A snapshot, not a view. The user shops from it while the plan may still move.

The list belongs to a **shopping cycle**, so its identity is the date it starts
on, and a partial unique index on `(user_id, starts_on)` where the state is not
`archived` keeps it to one live list per cycle. A cycle is not a week and can
overlap two of them, which is why the version it was built from is no longer a
usable key.

### `grocery_list_version`
| Column | Type | Notes |
|---|---|---|
| grocery_list_id | uuid | FK, cascade, part of PK |
| plan_version_id | uuid | FK, cascade, part of PK |

Which plan versions a list was built from. A cycle overlaps at most two ISO
weeks, so there are at most two rows, and the set is rewritten on every
regeneration. This is what makes staleness answerable: a list is stale when any
row here points at a version that is no longer `active`. A single
`plan_version_id` column could not express a list that spans a Sunday.

### `grocery_line`
| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| grocery_list_id | uuid | FK, cascade |
| ingredient_id | uuid | nullable FK |
| display_name | text | |
| quantity | numeric | nullable |
| unit | text | nullable |
| aisle | text | nullable |
| origin | text | `derived`, `manual` |
| source_entry_ids | uuid[] | which meals need this. Lets the user drop a line and know what breaks |
| covered_by_pantry | boolean | |
| optional | boolean | every recipe that asked for this line called it optional |
| checked | boolean | |
| unmergeable_group | text | nullable, groups lines for the same ingredient in incompatible units |

Notes from the implementation:

- `covered_by_pantry` is written by phase 7 and is false until then. The column
  exists now so the pantry is a service change rather than a migration.
- A regeneration recognises a stored line by ingredient, name, unit and
  optionality together. The unit is part of it because one ingredient can
  legitimately hold several lines that could not be summed; optionality because
  the required and the optional half of one ingredient are two lines in two
  sections, and summing them would inflate what the cook has to buy.
- Only lines with an `ingredient_id` ever merge. Two unlinked names that look
  alike are not evidence that they are the same thing, so each keeps its line.

## 8. Pantry

### `pantry_item`
| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | FK |
| kind | text | `staple` or `use_soon` |
| ingredient_id | uuid | nullable FK |
| name | text | |
| quantity_note | text | nullable free text, deliberately not numeric |
| expires_on | date | nullable |
| added_at | timestamptz | |
| source | text | `user` or `agent` |

`quantity_note` is free text on purpose. A numeric quantity invites decrementing,
decrementing invites bookkeeping, and bookkeeping is what makes users abandon
pantry features.

## 9. Derived read models (not tables in v1)

Computed on demand, cached if they get slow:

- **Rotation age** per recipe: weeks since last `cooked` feedback.
- **Cook rate** per recipe: cooked / planned.
- **Never-cooked-though-planned**: planned 2 or more times, zero cooked. The
  strongest implicit negative signal in the system.
- **Slot overrun rate**: fraction of entries in a slot flagged `took_longer`.
  Should drive a suggestion to raise that slot's time budget.
- **Profile snapshot**: the single composed document handed to agents. See
  `03-agent-interface.md` section 4.

## 10. Multi-tenancy and future household support

Every user-owned table has `user_id`. Queries are scoped at the data access
layer, with PostgreSQL row-level security as a second line of defence so a
forgotten `where` clause cannot leak data. Enable RLS from the first migration,
not later: retrofitting it means auditing every query path.

For the v2 household feature, the intended path is an `eater` table under `user`,
with allergens, exclusions, and facts gaining a nullable `eater_id` (null meaning
"applies to the whole household"), and `plan_entry` gaining a set of eaters. No
table designed here needs to be dropped for that, which is the point of shaping
it now.
