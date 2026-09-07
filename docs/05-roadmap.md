# 05 - Roadmap

Status: draft v1
Last updated: 2026-09-07

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

## Phase 0 - Foundation and risk spike [DONE 2026-08-31]

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

## Phase 1 - The manual core loop [DONE 2026-08-31]

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

## Phase 2 - Grocery list [DONE 2026-08-31]

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

**Corrected 2026-09-07: a line was named after the vocabulary, not after the
product.** Merging keyed on the linked ingredient and displayed its canonical
name, so every recipe line that resolved to a broader entry was renamed on the
list: "coulis de tomate" shopped as "Tomate", "spaghetti" as "Pâtes", and "pain
de mie" and "pain à burger" collapsed into one "Pain". The vocabulary earns the
merge, the aisle and the allergens; it does not get to rename the shopping.

The split that fixes it is between linking and naming. A written name that is
the ingredient's own name, whatever its case, accents, ligatures or plural,
still reads back canonical and still adds up. Every other written name keeps
itself, and merges only with the same written name, so two coulis make one line
of 500 ml. Aliases are read for linking and for nothing else, which is what lets
them stay as loose as matching needs: "thym" can resolve to `Herbes de Provence`
for its aisle and its allergens without the list ever saying the wrong word. The
cost is that two names that both differ from the canonical one no longer add up,
"patate" beside "pomme de terre", which buys a duplicate at worst where the old
behaviour bought the wrong thing.

`grocery_line.product_variant` records which of the two a line was, because the
pantry is re-evaluated on every read and tomatoes in the cupboard cover no
coulis. `normalizeTerm` also folds œ and æ now, so "boeuf haché" and "bœuf
haché" are one word to the grocery merge, to ingredient linking and to the
allergen matcher, which is the direction a strict allergen wants to err in.

---

## Phase 3 - Profile and facts [DONE 2026-08-31]

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

## Phase 4 - Agent read access [DONE 2026-08-31]

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

## Phase 5 - Agent write access [DONE 2026-09-01]

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

## Phase 6 - Feedback loop [DONE 2026-09-01]

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

## Phase 7 - Pantry [DONE 2026-09-01]

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

## Phase 8 - Prep and batch planning [DONE 2026-09-01]

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

## Phase 9 - Recipe URL import [DONE 2026-09-01]

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

**Shipped.**

- PWA with offline grocery list and queued check-state replay.
- Recipe images, empty states, keyboard operation of the grid.
- Data export and account deletion.
- English translation, proving the i18n groundwork.
- Documentation for self-hosters.

What the phase settled, beyond ticking its own list:

- **The service worker caches the grocery list and nothing else.** Caching the
  application shell would serve a stale plan or a stale profile, which is worse
  than an error message. The one screen used in a place with no signal is the
  one screen that is cached.
- **The check queue lives in localStorage, not in the worker.** A queued tick
  has to survive the worker being evicted, and it has to be replayed by code
  that knows which server action to call. It is keyed by line, so ticking and
  unticking the same item collapses to one write rather than replaying a history
  nobody cares about. A queued tick stays on screen; only a refusal from the
  server rolls it back.
- **Recipe images are addresses, not uploads.** A self-hosted install should not
  grow an image store, a thumbnailer and a cleanup job for a field
  `06-open-questions.md` A4 already calls nice to have. The cost is that the
  host sees the reader, which the form says in as many words, and that a dead
  link renders as nothing at all rather than a broken-image icon.
- **The drag handle is its own button.** Spreading the drag listeners over the
  whole card put a keyboard drag and the "open this meal" button on the same
  element, so space did one of two things depending on where focus happened to
  be. The handle is a sibling of the title, and the keyboard sensor got a
  coordinate getter that jumps from slot to slot: dnd-kit's default nudges by 25
  pixels, which across a seven-column grid is a dozen key presses with no idea
  where the meal will land.
- **The locale is a cookie, not a URL segment.** The addresses in this
  application get bookmarked and pasted, and a `/fr/` prefix would make one page
  two addresses. The choice is per-browser rather than shareable, which is the
  right trade here.
- **`tests/messages.test.ts` is what makes the second locale worth having.** It
  fails on a key present in one catalogue and missing from the other, on
  mismatched ICU placeholders, on an empty translation, and on an em dash. A
  missing key does not crash next-intl: it renders the key path into the page,
  which is the kind of thing that ships.
- **Deletion is real, and pays a cost recorded in the data model.** Domain
  tables carry no foreign key to `user`, because the two migrators run in
  sequence, so nothing cascades on its own. `deleteAccount` removes children
  before parents across twenty tables and then deletes the Better Auth user,
  which does cascade the sessions, the registered clients and their consents.
- **One real defect fell out of the audit.** The runtime pool fell back from
  `APP_DATABASE_URL` to `DATABASE_URL`. That kept the application running while
  connecting as the table owner, which Postgres exempts from row-level security,
  so tenancy enforcement would have been silently gone with nothing failing. The
  fallback is removed and the boot error says why.

---

## Deployment

**Shipped.** Not a phase of its own: phase 10 wrote the self-hosting
documentation, and this is what happened when the container path in it was
actually run.

It did not work, in three places, and each one is the same kind of mistake.

- **Compose injects only the variables a service names.** A value in `.env` is
  available for interpolation on the right-hand side and does not otherwise
  reach the process. `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
  `ALLOWED_EMAILS` were named nowhere, so the container had no sign-in method
  and refused to boot. Had it booted, an empty allowlist in production locks
  everyone out.
- **The image had never been built.** `next build` collects route data for
  `/api/auth/[...all]`, which imports the auth module, which refuses a
  configuration with no way in. The build stage set placeholders for everything
  except a sign-in method.
- **The migrator imports that same module.** `scripts/auth-migrate.ts` reads the
  schema out of the installed Better Auth, so it constructs the auth instance,
  so it needs everything that instance validates at import. It had the two
  database URLs. `up` stopped there, before the application was ever started.

What the three have in common is that none of them can fail on a development
machine, and all of them fail on the first deploy. So the response was not only
to fix them:

- `tests/deploy.test.ts` reads the deployment files and pins down what they say,
  including that the migrator gets the auth block and that no service is ever
  handed `AUTH_PASSWORD_LOGIN`. Its last test scans `src/` for environment
  variables and fails on one that has not been classified, so the next variable
  cannot repeat the first defect quietly.
- A second CI job builds the image, brings the stack up with `--wait`, and
  checks the health endpoint, both discovery rewrites, the RFC 9728 challenge on
  an unauthenticated MCP call, and that the password endpoints refuse.

Then the first real server made the build itself the problem. `next build` set
the memory floor for the whole deployment, on a machine that otherwise needs
almost nothing to serve one household, and the image had to be amd64 while
development happens on arm64. So a third CI job publishes both shipping targets
of the Dockerfile to GHCR and the server only pulls: `git pull`, `docker compose
pull`, `up -d --no-build --wait`. It runs only on a push to main and only behind
the other two, so nothing reaches the registry that has not built, come up and
answered.

That moved one risk rather than removing it. The tag is now spelled in
`compose.yaml` and in `ci.yml`, and a disagreement surfaces as a pull failure,
which reads like a credentials problem rather than a typo, so
`tests/deploy.test.ts` asserts the two files agree. Each commit also publishes an
immutable `sha-<commit>` pair next to the moving one, which makes a rollback an
environment variable rather than a revert. Pulling stayed the server's job: a
push-based deploy would need a host key in GitHub secrets that is
root-equivalent on the machine, which is a poor trade for one operator.

The rest was the gap between the documentation and something an operator can
actually run: automatic TLS from Let's Encrypt in `deploy/`, split into an
overlay because Compose interpolates every service whichever profile is active,
so a required `APP_DOMAIN` in `compose.yaml` would make `npm run db:up` demand a
public hostname; `/api/health`, which answers `select 1` on the runtime pool, so
a container that is listening but cannot reach Postgres reports unhealthy;
capped container logs, because a year of them is what fills the smallest disk
first; `scripts/backup.sh`, writing through a `.partial` name so an interrupted
run cannot look like a backup; and response headers in `next.config.ts`, with
HSTS left to the proxy that terminates the TLS it is about.

One gap stays open and is recorded rather than papered over: there is no
Content-Security-Policy. Next inlines its own bootstrap script, so a useful
policy needs per-request nonces threaded through the root layout, and one loose
enough to skip that buys nothing.

---

## Mobile on iOS Safari

**Shipped.** Not a phase of its own either: the reference instance is read from
one phone, and the shell it had been built with does not survive that browser.

Both bars were `position: fixed` over a scrolling document. Safari grows and
shrinks its own toolbars as the document scrolls, and while it does, it leaves
fixed elements pinned to the edges the viewport used to have. The top bar drifts
down the screen with page content running above it, the bottom bar drifts up
with page content running below it, and both wobble for the length of a flick.
Nothing inside the page can correct it, because the page is not told the
viewport moved until the gesture ends.

So the document does not scroll any more. `.shell` in `globals.css` is exactly
one viewport tall, the two bars are ordinary flex children welded to its top and
bottom edges, and the scrolling happens in the box between them. Safari then has
no reason to touch its toolbars.

- **The shell is `position: fixed`, not merely a tall box with overflow
  hidden.** In flow, the content inside the scrolling box still counts towards
  the document's own scrollable height even though the box clips it, so the
  whole shell could be flicked off the top of the screen leaving bare ground
  behind, which is a worse version of the fault being fixed. That was measured
  in a browser rather than reasoned about. Out of flow, the body is zero pixels
  tall, and a body with nothing in it has nothing to scroll.
- **`viewport-fit=cover` was missing, so every safe-area inset resolved to
  zero.** The phone tab strip had carried `padding-bottom:
env(safe-area-inset-bottom)` since it was written and it had never done
  anything. Each bar now pads its own content out of the notch and the home
  indicator, and the shell paints underneath both, so ink reaches the edge of
  the screen and text does not sit under the clock.
- **Three offsets existed only to clear the fixed bars and are now wrong by
  definition.** The grocery progress bar, the proposal decision bar and the
  recipe plate all measured against a bar that no longer overlaps them. A future
  sticky element inside a screen measures from zero, not from the bar height.
- **The cost is that Safari keeps its toolbars out for good.** A document that
  never scrolls never triggers the collapse that was buying that height back. It
  is the right trade for bars that can be trusted to stay still, and it stops
  mattering on the install path below, which has no browser chrome at all.

---

## Home screen install

**Shipped.** The escape from the trade the section above accepted: launched from
the home screen there is no browser furniture at all, so the toolbars Safari now
keeps out permanently stop costing anything, and the safe-area padding written
for them finally has real insets to work with.

The application already declared `display: standalone` and
`appleWebApp.capable`, so what was missing was everything around it.

- **The only icon was an SVG, which iOS accepts for neither job.** Not as
  `apple-touch-icon`, not out of the manifest. Left alone it screenshots the
  page and uses that as the tile. The mark is now rasterised to
  `apple-touch-icon.png` at 180, and 192 and 512 for the manifest, with the
  `rx="14"` dropped and the tile run to the edges: both platforms mask the icon
  with their own shape, so an icon that rounds its own corners is cut twice and
  shows dark wedges where the transparent corners were composited. Opaque, for
  the same reason.
- **The manifest carried a palette the application does not have.**
  `background_color` and `theme_color` were both `#0a0a0a`, so a light
  application launched on a black splash. The splash is the page, so
  `background_color` is the ground.
- **`theme_color` is the panel, not the ground, and had to stop being static.**
  It colours the strip the operating system keeps for itself: the status bar of
  a standalone launch, sitting directly on top of the bar, and the browser
  furniture in Safari, sitting directly under the phone tab strip. Both
  neighbours are panel. The old value was the ground, which put an unruled seam
  across the top of the screen. It was also declared as one colour for both
  `prefers-color-scheme` branches, which is wrong here for the reason in
  `src/lib/theme.ts`: the theme is a cookie, so the media query says nothing
  about it and a dark-theme user got a light strip over a dark bar. `viewport`
  is now `generateViewport`, resolving the cookie the way the layout resolves
  the ground.
- **The safe-area inset goes on the cells of a bar, never on the bar.** Padding
  the bar ends the grid where the padding starts, so every fill and every rule
  ends with it and the bar's own background is left as a bare strip underneath.
  The phone tab strip shipped that way and it could only show once the
  application ran standalone, where the bottom inset is finally not zero: the
  active block floated above the bottom of the screen instead of meeting it.

One thing is recorded rather than fixed. On an already-installed clip the status
bar strip still reads a different colour from the bar, so the `theme_color`
correction did not visibly land. The likely cause is that iOS snapshots manifest
properties when the web clip is created, which would mean it needs removing from
the home screen and adding again rather than relaunching; the other candidate is
that the strip follows `background_color`, which is still the ground on purpose.
Neither was chased. `statusBarStyle` stays `default`, because the alternative
that would let the bar run under the status bar is `black-translucent`, and that
forces white status text over what is a white bar on three quarters of its
width.

---

## Code quality audit [7 September 2026]

**Not a phase.** Every phase above is shipped, so this is what a full read of the
codebase found once there was a whole product to read rather than a phase to
finish.

Most of what it turned up was hygiene, and the hygiene is recorded where it
belongs rather than here: the environment variable module, the secret file
convention, the runtime connection role for Better Auth, ESLint and Prettier
gating `verify`, the split of `plan-service.ts` and the report-only content
security policy are decisions 24 to 31 in `04-tech-spec.md`. The schema work,
composite foreign keys tying a child row to its parent's owner, foreign key
indexes, the two purge functions and the retirement of `recipe.allergen_ids`, is
in `02-data-model.md`. The agent surface changes, uniform snake_case parameters,
one serializer per entity, four new error codes and the reversible pantry
removal, are in `03-agent-interface.md`. What was identified and deliberately not
done is `06-open-questions.md`, gaps G1 to G6.

Three findings were different in kind. They were not hygiene, not latent, and not
theoretical: they were user-visible bugs in shipped behaviour.

1. **The strict allergen matcher had three false negatives.** This is the one
   function constraint 2 depends on, the absolute block with no override path,
   and it failed to match in three ways. A hyphen was not folded, so a user who
   typed `fruits à coque` was not protected against an ingredient written
   `fruits-à-coque`, which matters because the regulated French allergen names
   are hyphenated compounds and a paste from a web page rarely uses the plain
   hyphen-minus. The plural was handled on one side only, so a user who typed
   `oeufs` was unprotected against `1 oeuf`. And a whitespace-only allergen name
   passed validation and could be stored as a strict block, which is a block that
   can never match anything: the user sees a strict allergen listed on their
   profile and has no protection at all. Every one of the three fails in the
   direction that lets a meal through.
2. **A French decimal comma destroyed the quantity.** `1,5 kg de farine` parsed
   to no quantity, no unit, and a bogus note. The parser treated the first comma
   as the start of a note, which is right for `2 oignons, émincés` and wrong for
   every half-kilo in a French recipe. A comma with a digit on either side is a
   decimal point, never a clause break.
3. **Any agent proposal carrying a prep link was always refused.** The link
   resolver looked its entries up through the active version, and a pending
   proposal's entries are by definition not in the active version, so the whole
   batch-cooking half of `propose_week` could not be used at all. The fix is
   `linkPrepInVersion`, which trusts the entries the write just produced rather
   than re-reading the week.

**All three were found by reading, not by the suite.** That is the part worth
keeping. The suite was green throughout, and it was green on the third one for a
specific and instructive reason: the test that was supposed to cover prep links
in a proposal passed an empty link array. It asserted a proposal succeeds, which
was true whether or not linking worked, so it would have gone on passing for as
long as the feature stayed broken. A test that cannot fail is worse than a
missing one, because a missing test is visibly missing. The durable lesson is to
check what an assertion would catch, not only that it passes, and the honest
prompt for it is to ask what would have to break for this test to go red.

---

## Deferred, in the order they would be reconsidered

1. **Household with multiple eaters.** The largest v2 feature and the most
   requested one, if this ever meets other users. The schema is already shaped
   for it: see `02-data-model.md` section 11.
2. Local stdio MCP wrapper.
3. **A grocery tool on the agent surface.** The interface spec listed a
   `generate_grocery_list` write tool for a while and no such tool was ever
   built, so it has been removed from `03-agent-interface.md`: a spec is not the
   place to record an intention as though it shipped. The intention itself is
   reasonable and lands here instead. Generation is a request-time read model
   today (`02-data-model.md` section 9) and the web screen is the only thing that
   triggers it. Before building the tool, settle what an agent gains over
   `cooking://plan/*` plus its own reading of the recipes, because the merge
   behaviour that makes the list survive a plan change is the interesting part and
   it is not obviously something an agent should drive.
4. Cost estimates per recipe and per week, once ingredients carry prices.
5. Seasonality awareness driven by a static ingredient calendar, no LLM needed.
6. Nutrition, only on real demand, and only with a licensing answer.
