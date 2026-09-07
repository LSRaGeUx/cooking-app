# 00 - Vision and Scope

Status: draft v1
Last updated: 2026-08-31

## 1. One-line pitch

A self-hosted weekly cooking planner whose real asset is a deep, structured
profile of the cook, exposed to the user's own AI agent over MCP so the agent
can propose a genuinely personalized cooking week. The application never calls
an LLM itself.

## 2. Problem

Meal planning apps fail for two reasons:

1. They know almost nothing about you. A diet toggle and a "dislikes" tag list
   is not personalization. Real constraints are messy: "Tuesday I get home at
   21h", "I own a wok but no food processor", "I will not cook fish two days in
   a row", "I always have eggs and rice", "my Thursday lunch is leftovers".
2. Generic recipe recommendation engines optimize for catalogue coverage, not
   for the shape of one person's week.

Meanwhile, general-purpose AI agents are extremely good at exactly this kind of
soft constrained planning, but they have no memory of you and no place to put a
plan. Every session starts from zero, and the output is a chat message that
evaporates.

## 3. The differentiator

The product is not the calendar grid. Grids are commodity. The product is:

**A durable, structured, agent-readable and agent-writable context store about
one cook, plus a tool surface precise enough that a general agent can plan
against it and write results back.**

Three consequences follow, and they define the whole design:

- **The profile is the moat.** Depth and structure of what we store about the
  user, and how cleanly we hand it to an agent, is the entire competitive
  surface. Every other feature exists to feed it or consume it.
- **The agent learns over time.** The agent does not only read the profile, it
  writes new facts into it ("user skipped the fish dish twice, low confidence
  dislike"). Week 20 is better than week 1. That compounding is defensible in a
  way a recipe catalogue is not.
- **We are a tool provider, not an AI product.** No server-side LLM calls means
  no marginal cost per user, no prompt to maintain, no model version risk, no
  API key management, no rate limits. The user's agent subscription pays for the
  intelligence.

## 4. Cost model (hard constraint)

**The application must never make a paid LLM API call.** This is a design
constraint, not a preference, and it is load-bearing:

- Marginal cost per user tends to zero. Hosting is a container and a Postgres
  database.
- Self-hosting is viable for anyone.
- The intelligence is supplied by whatever agent the user already pays for
  (Claude Desktop, Claude Code, or any MCP-capable client).

Everything that would normally be prompt engineering must instead be expressed
as: schema design, tool descriptions, resource shaping, and optional prompt
templates we publish for the user to load into their own agent. See
`03-agent-interface.md`.

## 5. Primary user (v1)

One persona, deliberately narrow:

**"The organized home cook."** Cooks most weeknights for themselves. Already
plans loosely, in a notes app or in their head. Owns an AI agent subscription
and is comfortable connecting a tool to it. Wants less decision fatigue, less
food waste, and to stop eating the same six dishes. Cares about time budget per
weekday more than about nutrition macros.

Explicitly not the v1 user: families reconciling multiple eaters, macro-tracking
athletes, professional kitchens.

## 6. Must work without an agent

Non-negotiable. A visitor with no agent connected must still get a usable
application: manual week planning, a recipe library, an aggregated grocery list,
a pantry list, and meal feedback. The agent is turbo mode, not life support.

Two reasons. First, a dead-without-agent app has no on-ramp and cannot be
demoed. Second, and more important, manual use is what populates the profile
with honest data before an agent ever touches it.

## 7. In scope for v1

- Full authentication and user management (see section 9).
- Configurable weekly slot grid (which meals, which days) per user.
- Structured profile plus an open agent-writable facts store.
- Recipe library: manual creation, agent-generated, import from a URL.
- Manual and agent-driven week planning, with plan versioning.
- Grocery list aggregated from a week's plan.
- Light pantry: staples and use-soon items, not full stock accounting.
- Feedback loop: cooked / skipped / rating per planned slot.
- Batch and prep planning: link slots so one cooking session feeds several.
- Remote HTTP MCP server with OAuth, exposing all of the above as tools.
- French UI, metric units, internationalization-ready.

## 8. Out of scope for v1 (named, so they stay out)

| Deferred                                   | Why                                                                                    | Revisit when                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------- | --------------------------------------- |
| Household with multiple eaters             | Conflict reconciliation across eaters is a large data model and UX problem on its own  | v2, and the schema is shaped for it now |
| Nutrition and macro tracking               | Requires a nutrition database, adds licensing cost and a whole new correctness burden  | Only on real demand                     |
| External recipe APIs (Spoonacular, Edamam) | Cost, rate limits, dependency, and generic results, which is the opposite of the pitch | Probably never                          |
| Native mobile apps                         | Responsive web plus PWA covers the in-store grocery use case                           | Post product-market fit                 |
| Social features, sharing, public recipes   | Distraction from the single-user core loop                                             | Post v1                                 |
| Server-side AI features                    | Violates the zero-cost constraint                                                      | Never, by design                        |
| Grocery delivery integrations              | Partner-dependent, country-specific                                                    | Post v1                                 |

## 9. Deployment posture

Deployed for a single user (self-hosted), but built multi-tenant from day 1:

- Real authentication and user management, not a bypass.
- Every table carries an owning user reference and every query is scoped.
- No global singletons in the data model.

Rationale: the multi-tenancy retrofit is the one refactor that touches every
query and every MCP tool. Paying roughly 10 percent extra now removes a
rewrite later. Auth is also not optional here for a second reason: a remote MCP
endpoint is publicly reachable and must authenticate the caller regardless of
how many humans use the app.

## 10. Success criteria for v1

Functional, not vanity:

1. From a cold profile, a connected agent can produce a full week plan that the
   user accepts with at most two per-slot edits.
2. The grocery list for that week needs no manual correction before shopping.
3. After four weeks of feedback, the agent's proposals are visibly informed by
   recorded facts (verifiable: every proposed slot cites which facts drove it).
4. Zero LLM spend attributable to the application.
5. A user with no agent can plan a week manually in under five minutes.

## 11. Key risks

| Risk                                            | Impact                         | Mitigation                                                                                                                               |
| ----------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Pantry friction kills adoption                  | High                           | Pantry stays dumb and optional in v1: staples plus use-soon, no quantities required                                                      |
| Agent writes garbage facts into the profile     | High, it poisons the moat      | Every fact carries source, confidence, and timestamp. A review UI lets the user confirm or delete. Agent-written facts start unconfirmed |
| MCP OAuth setup defeats the user                | High, it is the entire on-ramp | Treat connect flow as a first-class feature: one URL, guided screen, connection test tool                                                |
| Agent output quality varies by client and model | Medium                         | Tool descriptions and published prompt templates do the steering. Validate agent writes server-side, reject impossible plans             |
| Scope creep from the four v1 side features      | Medium                         | Phased roadmap, each phase shippable alone. See `05-roadmap.md`                                                                          |
| URL recipe import breaks on many sites          | Low                            | Prefer schema.org Recipe JSON-LD, fall back to letting the user's agent parse the page and POST the result                               |
