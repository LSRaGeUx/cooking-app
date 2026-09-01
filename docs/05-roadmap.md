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

## Phase 0 - Foundation and risk spike  [DONE 2026-08-31]

Goal: prove the hard part works, and stand up the skeleton.

Outcome, and the six things the spec got wrong: `07-phase-0-findings.md`.

- Next.js project, TypeScript strict, Tailwind, French i18n scaffolding with keys
  externalized from the first screen.
- Postgres 18 in a container via `compose.yaml`, Drizzle, first migration.
  Dev runtime is Podman (rootful machine, `/var/run/docker.sock` symlinked to the
  Podman socket, so Docker-socket clients such as Testcontainers work unchanged).
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

The spike succeeded, so the stack decision stands. The one item that carried into
phase 1, the token-authenticated `whoami` call awaiting real login and consent
screens, is now closed: `npm run verify:oauth` walks the whole path against a
running server and passes.

---

## Phase 1 - The manual core loop  [DONE 2026-08-31]

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

Built as specified, with four things worth recording:

- **Login and consent screens shipped here**, closing the last phase 0 item. Both
  hand the HMAC-signed authorization query back untouched, which is why the
  login/sign-up switch is local state rather than a link.
- **Diet is not enforced.** No recipe field says what diet a recipe satisfies, so
  the hard filter in `01-functional-spec.md` section 4 cannot be implemented as
  written. Allergens, exclusions, slot state, time budgets and repetition are all
  enforced. See Q7 in `06-open-questions.md`.
- **Every manual edit creates a version**, so dragging one entry produces one
  version. That is the immutability rule working, not a bug, but it makes the
  history long. See Q8.
- **The whole resulting week is revalidated on every write**, not just the entry
  that changed, so an allergen added after a week was planned blocks the next
  edit to that week rather than surviving in it.

---

## Phase 2 - Grocery list  [DONE 2026-08-31]

Goal: the feature with the highest perceived value per unit of work.

- Generate from a plan version, persist as a snapshot.
- Unit-compatible merging per normalized ingredient, unmergeable lines grouped
  rather than guessed.
- Aisle grouping, check state, manual lines.
- Regeneration merges instead of wiping: checked state and manual lines survive,
  changed lines highlighted.
- Mobile-first layout.

Ship: plan a week, shop from it.

Built as specified, with five things worth recording:

- **A list belongs to a week, not to a version.** A version is superseded by
  every edit, so a list pinned to one would be stale the moment the user moved a
  meal. `plan_version_id` records what the list was last built from and moves
  forward on regeneration; finding this week's list joins through it to `plan`.
- **Only units with an unambiguous definition convert.** Grams and litres do; a
  French tablespoon does, at 15 ml; a "tasse" does not, because it is 200 ml in
  one kitchen and 250 in another. A total that came from one spoon-like unit is
  also read back in that unit, so one tablespoon of oil is not shown as 15 ml.
- **Countable quantities round up.** You cannot buy 1,5 courgette, and rounding
  down is the one direction that ends a cooking session early.
- **Regeneration is explicit, never automatic.** The list is a snapshot the user
  is working from in a shop, and rearranging it under them unasked is the one
  thing this screen must not do. The button reports what moved.
- **Highlighting is not persisted.** The service returns which lines were added
  or changed and the screen highlights those, so a reload clears it. A highlight
  is about the last regeneration, not a property of the line.

Pantry subtraction from `01-functional-spec.md` section 8 is not here: the
pantry lands in phase 7. `grocery_line.covered_by_pantry` already exists so that
phase is a service change rather than a migration.

---

## Phase 3 - Profile and facts  [DONE 2026-08-31]

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

Built as specified, with six things worth recording:

- **The status of a fact is decided by who wrote it, not by the payload.** A
  user's fact is confirmed, an agent's is unconfirmed, and `confirmFact` refuses
  an agent caller outright. There is no request an agent can make that confirms
  its own claim.
- **Only filing and certainty move in place.** Category and confidence can be
  updated; the statement and the polarity are the fact's meaning, and changing
  those goes through supersede, which retires the old row and links the new one
  to it.
- **The cap is checked with headroom, so a replacement works at the cap** while
  an addition past it does not. A rejected write names the least recently
  referenced unconfirmed facts as retirement candidates.
- **Every fact category has a section in the snapshot.** `health` and any
  confirmed high-confidence rejection are lifted into section 2, equipment and
  technique go to section 4, organization, pantry habits and social go to
  section 5, taste and other go to section 6. Nothing can be written and then
  silently never reach an agent.
- **The budget cannot cut a dangerous fact.** Selection sorts health facts and
  confirmed high-confidence rejections to the front, so the cap only ever bites
  into the nuanced end of the list.
- **Sections 7 to 9 are stated as unavailable rather than shown empty**, so an
  agent cannot read "no staples listed" as "there are no staples".

Size, measured against a synthetic worst case (T2 in `06-open-questions.md`):
26 kB and roughly 7 400 tokens at the default 150-fact budget, 48.5 kB and
roughly 14 000 tokens at the 300-fact cap. That gap is why the display budget is
lower than the cap.

Viewing your own snapshot does not bump `last_referenced_at`: previewing the
document must not tell the pruning heuristic that an agent found those facts
useful.

---

## Phase 4 - Agent read access  [DONE 2026-08-31]

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

Built as specified, with five things worth recording:

- **One guard wraps every tool and every resource.** Scope check, revocation
  check, rate limit, audit entry and error shaping all live in
  `src/mcp/tool-runner.ts`, so a new tool cannot forget one of them. The phase 0
  `whoami` predated it and was bypassing all five; that is fixed, and it mattered
  most for `whoami` specifically, since that is the call an agent makes to check
  its connection.
- **Revocation is immediate, which a JWT cannot do alone.** Access tokens verify
  against our JWKS, so a revoked client's token stays cryptographically valid
  until it expires. Every call therefore re-checks that a consent row still
  exists. Revoking also deletes the stored access and refresh tokens.
- **The rate limit is counted from the audit log**, not from memory, so it holds
  across processes with no shared cache. 120 calls per minute per client.
- **`not_cooked_in_weeks` shipped as `not_planned_in_weeks`.** Feedback does not
  exist until phase 6, so "not cooked" would have been a lie. The two are
  genuinely different filters and phase 6 adds the other rather than changing
  what this one means. Same reasoning for `min_rating`, which is not here at all.
- **Unbuilt resources answer, rather than being absent.** `cooking://pantry` and
  `cooking://history/recent` return `{available: false, reason}`, so an agent
  learns why a section is empty instead of concluding there is nothing to know.

Two bugs found by testing, both of the same kind and both invisible from
outside: the rate limiter and the connected-clients screen queried
`agent_activity` without `withUser`. Row-level security did exactly what it is
designed to do and returned zero rows, so the limiter counted zero calls forever
and the screen said every client had never called. Any raw query touching a
domain table has to go through `inScope`, and `tests/services/mcp-guards.test.ts`
now pins both behaviours down.

---

## Phase 5 - Agent write access  [DONE 2026-09-01]

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

Built as specified, with six things worth recording:

- **`check_feasibility` returns every problem at once.** The validator was
  refactored to collect rather than throw, and the write path throws the first
  of the collected errors. One validator, two behaviours, no chance of the dry
  run disagreeing with the real thing.
- **A rationale is required of the entries a write introduces, not of the whole
  week.** Requiring it everywhere would stop an agent touching a week the user
  planned by hand, since a person owes nobody an explanation for their own
  dinner.
- **Authority is read from the profile, never from the payload.** An agent that
  could choose between proposing and applying would be escalating its own
  permission.
- **Accepting a proposal is a state transition, not a new version**, so the
  version the user reviewed is the one that becomes active. It is revalidated
  first: a proposal written before an allergen was declared must not activate
  after it.
- **Accepting part of a proposal builds a new version** merging the chosen slots
  onto the active week, and consumes the proposal.
- **A rejection keeps its reason**, and so does a retired fact, which needed a
  new column. Both are the user saying in their own words what was wrong, which
  is the best signal this product ever gets.

The `propose_week` transaction covers invented recipes too: a week refused for a
strict allergen leaves no orphaned recipes behind, which
`tests/services/proposals.test.ts` checks explicitly.

---

## Phase 6 - Feedback loop  [DONE 2026-09-01]

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

Built as specified, with five things worth recording:

- **Only the outcome is required.** A form demanding a rating and a note for
  seven meals is a form nobody fills twice, and an unanswered prompt teaches
  nothing. The outcome alone already carries the strongest signal.
- **A meal with no feedback is unjudged, not failed.** Every read path says so
  explicitly, in the tool description, the resource note and the snapshot,
  because an agent that treats silence as failure will draw confident
  conclusions from nothing.
- **Feedback follows the slot, not the entry row.** Plan versions are immutable,
  so editing a week rewrites its entries; without carrying feedback forward, a
  user who tidied a week after cooking would silently lose every verdict. The
  planning service re-points it when it copies a slot forward.
- **The app derives signals, never facts.** It will say a dish was planned three
  times and never cooked. Concluding that the person dislikes it is the agent's
  job, with low confidence and cited evidence, which keeps the fact store honest
  about where its claims came from.
- **Budget suggestions are a button, never an automatic change.** The data can
  see that Saturday keeps running over; only the person living the Saturday
  knows whether the answer is a bigger budget or a simpler dish. This answers Q5.

`search_recipes` gained the two filters phase 4 deferred for want of data:
`not_cooked_in_weeks`, which is about what happened rather than what was
intended, and `min_rating`, which excludes never-rated recipes because an absent
rating is not a good one.

---

## Phase 7 - Pantry  [DONE 2026-09-01]

Goal: less waste, better context, minimum friction.

- Staples and use-soon lists. No quantities beyond a free-text note.
- Grocery list subtraction for staples, use-soon markers.
- `get_pantry`, `add_pantry_items`, `remove_pantry_item`.
- Use-soon items surfaced in the snapshot as a planning priority.

Ship: the agent plans around what is already in your kitchen.

Built as specified, with three things worth recording:

- **A covered staple is set aside, not deleted.** It appears in a collapsed
  "you should already have" section, because the one week you are out of flour
  is the week a silently missing line ruins dinner.
- **Coverage is re-evaluated on every regeneration**, so a staple declared today
  drops off today's list rather than next week's.
- **The section numbering in the snapshot is now the spec's.** Pantry is 7,
  history 8, signals 9. Phase 6 had temporarily shifted history and signals up
  because the pantry did not exist yet.

With the pantry built, every section the snapshot model defines is filled, and
`unavailable` is empty for the first time. The field stays, so a future gap can
be declared rather than rendered as silence.

---

## Phase 8 - Prep and batch planning  [DONE 2026-09-01]

Goal: turn the time budget data into something that pays off.

- Prep links between entries, with servings drawn and shortfall detection.
- Grocery list counts a batched source once, scaled.
- `link_prep`, and prep links accepted inside `propose_week`.
- Week grid visualization of a cooking session feeding several slots.

Ship: "cook double Sunday, eat Tuesday in 10 minutes."

Built as specified, with three things worth recording:

- **`source_entry_id` is nullable, which the spec did not say.** Clearing the
  Sunday cooking session must not delete Tuesday's meal, so the link survives
  with no source and the week shows it as unsourced. Deleting the dependent
  would lose a meal the user still intends to eat.
- **Links are carried across versions, both ends at once.** A week is immutable,
  so every edit rewrites the entry rows a link points at. The remap runs beside
  the feedback remap in the same place.
- **One source per dependent meal**, enforced by a unique index. Two sources
  would make the shortfall arithmetic ambiguous and the screen unreadable.

The split between error and warning is the one the spec asks for: eating on
Tuesday what you cook on Thursday is impossible and refused, while stretching
four portions across five meals is merely optimistic and only flagged.

---

## Phase 9 - Recipe URL import  [DONE 2026-09-01]

Goal: solve the cold-start library problem with recipes the user already likes.

- Server-side fetch with the SSRF protections from `04-tech-spec.md`.
- schema.org Recipe JSON-LD and microdata extraction, normalization, ingredient
  linking.
- `import_recipe_from_url` with the structured `PARSE_FAILED` path that invites
  the agent to fetch and post the recipe itself.

Deliberately late: it is valuable but not load-bearing, it carries the security
risk in the project, and the agent-generated recipe path already fills the
library.

Built as specified. The security work is the substance, so it is written down:

- **`src/lib/safe-fetch.ts` is the only outbound request in the application**,
  and it takes a required `purpose`. Scheme allowlist, address validated after
  resolution, redirect cap of three with every hop revalidated, 2 MB cap, eight
  second timeout.
- **The validated address is pinned onto the socket.** Resolving a name, finding
  it public, and then calling `fetch` is nearly useless, because the name can
  resolve differently the second time. A custom `lookup` hands the connection
  the address that was actually checked, which closes DNS rebinding.
- **Every private range is refused**, loopback, RFC 1918, carrier NAT, multicast
  and, the one that matters most, 169.254.169.254. IPv4-mapped IPv6 is unwrapped
  first, because a loopback wearing an IPv6 hat is still a loopback.
- **Attended time is never inferred.** No site publishes it, and it is the field
  the slot budget compares against, so a guess there would quietly break
  planning. It is left empty.
- **A failure is specific and actionable.** `PARSE_FAILED` tells the agent to
  fetch the page itself and post a structured recipe, which is the tier-two path
  the spec describes rather than a workaround.

Nothing from the page is ever rendered: only text fields are extracted, every
string is length-capped, and the recipe is stored through the ordinary create
path so ingredient linking and allergen derivation apply as usual.

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
