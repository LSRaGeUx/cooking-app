# 05 - Roadmap

Status: draft v1
Last updated: 2026-08-31

Budget is unspecified, so this is phased by dependency and by value. Every phase
ends in something usable. You can stop after any of them and still own a working
product.

Two sequencing rules drove the order:

1. **Spike the riskiest unknown first, before building around it.** The OAuth
   authorization server plus dynamic client registration plus Streamable HTTP MCP
   handshake is the one thing that could turn out to be much harder than
   expected. Find out in phase 0, not in phase 5 with a codebase already shaped.
2. **Reach agent read access as early as the data allows.** A connected agent
   that can read a rich profile and answer "what should I cook Tuesday" in chat
   is already the differentiator, even before it can write. It also validates the
   connection flow with real clients while the surface is small.

---

## Phase 0 - Foundation and risk spike

Goal: prove the hard part works, and stand up the skeleton.

- Next.js project, TypeScript strict, Tailwind, French i18n scaffolding with keys
  externalized from the first screen.
- Postgres via Docker Compose, Drizzle, first migration.
- Auth: email sign-in, sessions, user table.
- Row-level security enabled on the first user-owned table, with the
  request-scoped `user_id` context and a test proving a missing scope returns
  zero rows.
- CI: dependency allowlist check that fails on any LLM SDK.
- **Spike, throwaway code allowed:** OAuth authorization server with dynamic
  client registration, plus a Streamable HTTP MCP endpoint exposing exactly one
  trivial tool (`whoami`). Success criterion: Claude Desktop and Claude Code both
  connect by pasting the URL, complete consent, and call the tool.

Ship: nothing user-visible. This phase exists to remove the project's largest
technical unknown while it is still cheap to change course.

If the spike fails or drags, that is the moment to reconsider the stack, not
later. Note it in `06-open-questions.md`.

---

## Phase 1 - The manual core loop

Goal: a person with no agent can plan a week.

- Slot configuration: meal types, per-slot state, time budget, default servings.
  Visual week editor.
- Recipes: manual create, edit, list, search. Ingredient paste-parser good enough
  to save a recipe in under a minute. Normalized ingredient table with a seeded
  starter set, best-effort linking.
- Plans: plan, plan version, plan entry. Immutable versions from day 1, since
  retrofitting immutability means rewriting every write path.
- Week grid: assign, clear, drag between slots, duplicate to another slot, set
  servings and notes. Version history with revert.
- Hard rules implemented in the service layer: strict allergen block, slot state
  validation, time budget warning.

Ship: a usable weekly meal planner. Small, honest, and complete.

---

## Phase 2 - Grocery list

Goal: the feature with the highest perceived value per unit of work.

- Generate from a plan version, persist as a snapshot.
- Unit-compatible merging per normalized ingredient, unmergeable lines grouped
  rather than guessed.
- Aisle grouping, check state, manual lines.
- Regeneration merges instead of wiping: checked state and manual lines survive,
  changed lines highlighted.
- Mobile-first layout.

Ship: plan a week, shop from it.

---

## Phase 3 - Profile and facts

Goal: build the moat, and populate it by hand before an agent touches it.

- Structured profile screens grouped as dietary, kitchen, organization,
  preferences.
- Allergens with severity, exclusions, equipment.
- Facts: create, edit, retire, filter by category and status. Contradiction via
  supersede, never in-place overwrite.
- The profile snapshot composer, with the section ordering from
  `03-agent-interface.md`, viewable in the UI in both Markdown and JSON.

Making the snapshot visible to the user in phase 3, before any agent exists, is
deliberate. It is the fastest way to find out whether the context we assemble is
actually good, and it is testable by reading it.

Ship: a deep personal cooking profile, and the exact document an agent will read.

---

## Phase 4 - Agent read access

Goal: first real agent value, and validation of the connect flow.

- Promote the phase 0 spike to production quality: scopes, client registration,
  per-client tokens, revocation, rate limits.
- Resources: profile, slots, recipe index, current plan, pantry stub, history
  stub.
- Read tools: `get_profile_snapshot`, `search_recipes` (with the rotation-age
  filter), `get_recipe`, `get_week`.
- Agent connection screen: URL, per-client instructions, connection test,
  connected clients list with revoke.
- Agent activity log, read path.

Ship: connect your agent and ask it what to cook. It answers with real knowledge
of you. It cannot write yet, which makes this phase safe to hand to a stranger.

---

## Phase 5 - Agent write access

Goal: the actual pitch, delivered.

- `check_feasibility` (build this before `propose_week`, so the validation rules
  are exercised by a read-only tool first).
- `propose_week` with atomic recipe creation, required rationale, optimistic
  concurrency, and the review deep link.
- `update_slot`, `create_recipe`, `update_recipe`.
- `record_facts` and `retire_fact`, with agent facts entering unconfirmed.
- Authority mode setting: proposal or direct.
- **Proposal review screen:** slot-by-slot diff against the active version, per
  entry rationale with the cited facts rendered as links, accept all, accept per
  slot, reject with a captured reason.
- Facts review surface for unconfirmed agent facts, confirm or delete in one
  click.
- Full error taxonomy with actionable messages.
- Published prompt pack and MCP prompts.

Ship: the product as pitched. Say "plan my week", get a reviewed, personalized,
explained plan.

---

## Phase 6 - Feedback loop

Goal: make week 20 better than week 1.

- Per-entry outcome, rating, note, took-longer and portion flags.
- Batch fill for a past week, non-blocking prompts on the week screen.
- Derived signals: rotation age, cook rate, never-cooked-though-planned, slot
  overrun rate.
- Expose them through `get_history` and in the snapshot's unresolved-signals
  section.
- Suggest slot time budget corrections from overrun data. A suggestion in the UI,
  not an automatic change.

Ship: personalization that compounds. This is the phase that makes the product
defensible rather than merely nice.

---

## Phase 7 - Pantry

Goal: less waste, better context, minimum friction.

- Staples and use-soon lists. No quantities beyond a free-text note.
- Grocery list subtraction for staples, use-soon markers.
- `get_pantry`, `add_pantry_items`, `remove_pantry_item`.
- Use-soon items surfaced in the snapshot as a planning priority.

Ship: the agent plans around what is already in your kitchen.

---

## Phase 8 - Prep and batch planning

Goal: turn the time budget data into something that pays off.

- Prep links between entries, with servings drawn and shortfall detection.
- Grocery list counts a batched source once, scaled.
- `link_prep`, and prep links accepted inside `propose_week`.
- Week grid visualization of a cooking session feeding several slots.

Ship: "cook double Sunday, eat Tuesday in 10 minutes."

---

## Phase 9 - Recipe URL import

Goal: solve the cold-start library problem with recipes the user already likes.

- Server-side fetch with the SSRF protections from `04-tech-spec.md`.
- schema.org Recipe JSON-LD and microdata extraction, normalization, ingredient
  linking.
- `import_recipe_from_url` with the structured `PARSE_FAILED` path that invites
  the agent to fetch and post the recipe itself.

Deliberately late: it is valuable but not load-bearing, it carries the security
risk in the project, and the agent-generated recipe path already fills the
library.

---

## Phase 10 - Polish

- PWA with offline grocery list and queued check-state replay.
- Recipe images, empty states, keyboard operation of the grid.
- Data export and account deletion.
- English translation, proving the i18n groundwork.
- Documentation for self-hosters.

---

## Deferred, in the order they would be reconsidered

1. **Household with multiple eaters.** The largest v2 feature and the most
   requested one, if this ever meets other users. The schema is already shaped
   for it: see `02-data-model.md` section 10.
2. Local stdio MCP wrapper.
3. Cost estimates per recipe and per week, once ingredients carry prices.
4. Seasonality awareness driven by a static ingredient calendar, no LLM needed.
5. Nutrition, only on real demand, and only with a licensing answer.
