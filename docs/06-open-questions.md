# 06 - Open Questions and Assumptions

Status: living document
Last updated: 2026-09-01

Nothing here blocks starting phase 0. Each item names who decides and when it
must be decided by.

## Assumptions made, correct them if wrong

| # | Assumption | Impact if wrong |
|---|---|---|
| A1 | You cook mainly for yourself in v1, and the household case is genuinely v2 | Medium. Schema is shaped for it, but every UI screen would need a rethink |
| A2 | Your agent is Claude Desktop or Claude Code, so remote HTTP MCP with OAuth is the right connection story | High. A client without OAuth support would push the stdio wrapper into v1 |
| A3 | A week runs Monday to Sunday, ISO | Low, but it is in the data model |
| A4 | Recipe images are nice to have, not required | **Settled in phase 10.** Shipped as an https address on the recipe, filled by hand or read from the imported page. Nothing is copied onto the server, so there is no store, no thumbnailer and no cleanup job. The cost is that the host sees the reader, which the form states, and that a dead link renders as nothing rather than a broken image. Uploads remain the fallback if this proves not enough |
| A5 | Self-hosting means a Compose file on a small VPS or a home machine, not Kubernetes. Dev uses Podman, so the file stays to the plain Compose spec with no Docker-only extensions | Low |
| A6 | You are comfortable with the app being French-only at launch | Low, i18n groundwork is in from phase 0 |
| A7 | Ingredient prices are out of scope, so budget stays advisory | Low. Real cost tracking needs a price source, which is a project of its own |

## Questions for you, needed before the phase they affect

| # | Question | Needed by |
|---|---|---|
| Q1 | Does the profile need anything the spec missed: fasting windows, religious constraints beyond the diet enum, medical restrictions such as low sodium, children's tastes | Phase 3 |
| Q2 | Do you want recipe steps timed and step-by-step during cooking (a cook mode), or is a static recipe view enough | Phase 10, cheap to add later |
| Q3 | Hosting target: VPS, home server, or a serverless host with managed Postgres. It changes the deployment work in phase 0 only slightly, but decide before phase 10 | Phase 10 |
| Q4 | Do you want the fact cap set higher or lower than 300. Note the measurement in T2: the cap governs how many facts may exist, and a separate display budget of 150 governs how many reach an agent in one document. Raising the cap is cheap, raising the display budget costs tokens on every agent interaction | Phase 3, still yours to set |
| ~~Q5~~ | **ANSWERED 2026-09-01 by building it.** Neither: the suggestion appears on the week review screen and in `get_history`, and applying it is one click. The data can see that a slot keeps running over; only the person living that evening knows whether the answer is a bigger budget or a simpler dish. Say if you would rather it applied itself | Done |
| Q6 | Public repository or private. It affects whether the UI language decision matters for contributors | Phase 0 |
| Q7 | **Raised in phase 1.** Diet is specified as a hard filter on recipe assignment, but no recipe field says which diets a recipe satisfies, so there is nothing to filter on. Options: derive it from linked ingredient categories (cheap, wrong at the edges), add an explicit `diets` array on `recipe` that the user or their agent sets, or drop diet to advisory and let facts carry it. Allergens and exclusions are enforced either way | Phase 3 |
| Q8 | **Raised in phase 1.** Every manual edit creates a plan version, so a session of dragging produces a dozen. Immutability requires it. Should the history screen collapse consecutive user edits made within a few minutes into one entry for display, keeping every version revertible underneath | Phase 6, cosmetic until the history is used in anger |
| ~~Q9~~ | **ANSWERED 2026-09-01 by building it.** Screens now rebuild the sentence from the code plus the details, one template per code rather than one per throw site: 64 throws share 15 codes, and a template per site would be the second copy of every rule the taxonomy exists to prevent. The service keeps writing one French sentence for the agent, which is what a model needs. `VALIDATION`, `NOT_FOUND`, `FORBIDDEN` and `RECIPE_NOT_FOUND` have no template on purpose: they are thrown from dozens of unrelated places, so the service sentence beats anything generic, and they fall back to it. `tests/domain/error-params.test.ts` throws each rule for real and renders both catalogues, because a dropped detail field degrades silently to French rather than failing | Done |

## Technical unknowns to resolve by experiment

| # | Unknown | How to resolve | By |
|---|---|---|---|
| ~~T1~~ | **RESOLVED 2026-08-31.** Yes, through the separate `@better-auth/mcp` package, where `mcp()` IS the OAuth provider. Two rewrites are needed for RFC 8414 and RFC 9728 discovery, and `requireMcpAuth` needs the resource passed explicitly. Write-up in `07-phase-0-findings.md` | Done |
| ~~T2~~ | **RESOLVED 2026-08-31.** Measured against a synthetic worst case: 300 facts written near the 280-character limit, 6 allergens, 12 exclusions, 10 equipment entries, and 21 configured slots. At the 300-fact cap the document is 48.5 kB, roughly 14 000 tokens. At the default budget of 150 facts it is 26 kB, roughly 7 400 tokens. Real facts are shorter than the synthetic ones, so these are ceilings. The answer to "comfortable at 300" is no, which is exactly why the display budget defaults to 150 and the document states that it is showing a subset | Done |
| T3 | Do real agents actually respect the required rationale field, or do they emit filler | Test with several clients in phase 5. If filler appears, tighten the tool description and consider rejecting rationales that cite no refs | Phase 5 |
| T4 | schema.org Recipe coverage on the sites you actually use | Test ten of your bookmarks against the parser before committing to phase 9 | Phase 9 |
| ~~T6~~ | **RESOLVED 2026-09-01 by building it.** Tests now run against `cooking_test`, a second database on the same instance. The names are derived by appending `_test` to the development URLs, so a clone needs no configuration and a derived name can never equal the database it came from; `TEST_DATABASE_URL` and `TEST_APP_DATABASE_URL` override. A Vitest `setupFile` rewrites both variables before any test file imports `src/db/client.ts`, which is the whole mechanism, since that module builds its pool at import. A `globalSetup` truncates every table in `public` once per run, reading them from the catalogue so a new migration is covered without anybody remembering, and refusing outright if the database is not named with a `_test` suffix. `verify:oauth` drives a real server rather than a module, so it is isolated by starting a different one: `npm run dev:test`, which also empties the allowlist and forces password sign-in, both of which the script needs. That server gets a third database, `cooking_verify`, rather than sharing the suite's: it holds sessions and OAuth consents for as long as it runs, and a truncate underneath it deletes the session a half-finished verification depends on, or blocks on the lock it holds. With the split, `npm test` and `npm run verify:oauth` run at the same time, which is how they were verified. The two-role split is reproduced, so `tests/rls.test.ts` still proves what it did. Isolating it also exposed what the coupling had been hiding: `verify:oauth` planned with whatever recipe happened to be in the developer's library and relied on meal types that only exist because `ensureUserSetup()` runs behind `requireUser()` on a web page load. Against an empty database it failed five steps. It now seeds its own recipe, and the seeding gap turned out to be a product defect rather than a test one: nothing on the MCP path ran `ensureUserSetup()`, so a user who authorized an agent before ever opening the app got an empty grid from `get_week` and `SLOT_UNKNOWN` with an empty list of valid keys from `propose_week`, an error naming no way out on the exact path this product is built around. The MCP tool runner now runs the same idempotent ensure the web entry point does, and the script's page load, which had been standing in for it, is gone. `dev:test` also serves on a loopback port of its own rather than on 3000, because it opens an unauthenticated sign-up door and because `next dev` increments past a busy port in silence. Both siblings are created by one parameterised script, `scripts/db-setup-sibling.mjs`, and a schema behind the migrations on disk is refused with the command that fixes it rather than surfacing as a raw Postgres error mid-run. Note the deviation from the sketch below: the databases are created by `db:setup:test` and `db:setup:verify` rather than by `compose.yaml`, because the Postgres image only initialises databases on a fresh volume and every existing checkout already has one | Done |
| T5 | Whether the ingredient paste-parser is good enough to keep manual recipe entry under a minute | Try entering fifteen real recipes in phase 1 | **Partly answered.** The parser is built and unit-tested against the awkward French forms (ranges, elision, abbreviated spoons, unicode fractions, optional markers) and handles a real paste correctly in the browser. Fifteen real recipes from your own sources is still the honest test, and it is yours to run |

## Explicitly decided, do not relitigate without a reason

Recorded so they stop consuming thought: the zero-LLM constraint, TypeScript,
Postgres, immutable plan versions, atomic typed facts, agent facts entering
unconfirmed, required rationale, and no numeric pantry quantities. Full list with
reasoning in `04-tech-spec.md` section 7.
