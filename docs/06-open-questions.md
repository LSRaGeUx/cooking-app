# 06 - Open Questions and Assumptions

Status: living document
Last updated: 2026-08-31

Nothing here blocks starting phase 0. Each item names who decides and when it
must be decided by.

## Assumptions made, correct them if wrong

| # | Assumption | Impact if wrong |
|---|---|---|
| A1 | You cook mainly for yourself in v1, and the household case is genuinely v2 | Medium. Schema is shaped for it, but every UI screen would need a rethink |
| A2 | Your agent is Claude Desktop or Claude Code, so remote HTTP MCP with OAuth is the right connection story | High. A client without OAuth support would push the stdio wrapper into v1 |
| A3 | A week runs Monday to Sunday, ISO | Low, but it is in the data model |
| A4 | Recipe images are nice to have, not required | Low. If required, add storage and an upload path, probably object storage |
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
| Q5 | Should the app suggest slot time budget corrections automatically, or only when asked | Phase 6 |
| Q6 | Public repository or private. It affects whether the UI language decision matters for contributors | Phase 0 |
| Q7 | **Raised in phase 1.** Diet is specified as a hard filter on recipe assignment, but no recipe field says which diets a recipe satisfies, so there is nothing to filter on. Options: derive it from linked ingredient categories (cheap, wrong at the edges), add an explicit `diets` array on `recipe` that the user or their agent sets, or drop diet to advisory and let facts carry it. Allergens and exclusions are enforced either way | Phase 3 |
| Q8 | **Raised in phase 1.** Every manual edit creates a plan version, so a session of dragging produces a dozen. Immutability requires it. Should the history screen collapse consecutive user edits made within a few minutes into one entry for display, keeping every version revertible underneath | Phase 6, cosmetic until the history is used in anger |
| Q9 | **Raised in phase 1.** Rejection messages are written in French by the service layer and shown verbatim, with only the heading localized through next-intl. Adding English means keying every message off its code plus details. Worth doing when English lands, not before | Phase 10 |

## Technical unknowns to resolve by experiment

| # | Unknown | How to resolve | By |
|---|---|---|---|
| ~~T1~~ | **RESOLVED 2026-08-31.** Yes, through the separate `@better-auth/mcp` package, where `mcp()` IS the OAuth provider. Two rewrites are needed for RFC 8414 and RFC 9728 discovery, and `requireMcpAuth` needs the resource passed explicitly. Write-up in `07-phase-0-findings.md` | Done |
| ~~T2~~ | **RESOLVED 2026-08-31.** Measured against a synthetic worst case: 300 facts written near the 280-character limit, 6 allergens, 12 exclusions, 10 equipment entries, and 21 configured slots. At the 300-fact cap the document is 48.5 kB, roughly 14 000 tokens. At the default budget of 150 facts it is 26 kB, roughly 7 400 tokens. Real facts are shorter than the synthetic ones, so these are ceilings. The answer to "comfortable at 300" is no, which is exactly why the display budget defaults to 150 and the document states that it is showing a subset | Done |
| T3 | Do real agents actually respect the required rationale field, or do they emit filler | Test with several clients in phase 5. If filler appears, tighten the tool description and consider rejecting rationales that cite no refs | Phase 5 |
| T4 | schema.org Recipe coverage on the sites you actually use | Test ten of your bookmarks against the parser before committing to phase 9 | Phase 9 |
| T5 | Whether the ingredient paste-parser is good enough to keep manual recipe entry under a minute | Try entering fifteen real recipes in phase 1 | **Partly answered.** The parser is built and unit-tested against the awkward French forms (ranges, elision, abbreviated spoons, unicode fractions, optional markers) and handles a real paste correctly in the browser. Fifteen real recipes from your own sources is still the honest test, and it is yours to run |

## Explicitly decided, do not relitigate without a reason

Recorded so they stop consuming thought: the zero-LLM constraint, TypeScript,
Postgres, immutable plan versions, atomic typed facts, agent facts entering
unconfirmed, required rationale, and no numeric pantry quantities. Full list with
reasoning in `04-tech-spec.md` section 7.
