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
| A5 | Self-hosting means Docker Compose on a small VPS or a home machine, not Kubernetes | Low |
| A6 | You are comfortable with the app being French-only at launch | Low, i18n groundwork is in from phase 0 |
| A7 | Ingredient prices are out of scope, so budget stays advisory | Low. Real cost tracking needs a price source, which is a project of its own |

## Questions for you, needed before the phase they affect

| # | Question | Needed by |
|---|---|---|
| Q1 | Does the profile need anything the spec missed: fasting windows, religious constraints beyond the diet enum, medical restrictions such as low sodium, children's tastes | Phase 3 |
| Q2 | Do you want recipe steps timed and step-by-step during cooking (a cook mode), or is a static recipe view enough | Phase 10, cheap to add later |
| Q3 | Hosting target: VPS, home server, or a serverless host with managed Postgres. It changes the deployment work in phase 0 only slightly, but decide before phase 10 | Phase 10 |
| Q4 | Do you want the fact cap set higher or lower than 300 | Phase 3 |
| Q5 | Should the app suggest slot time budget corrections automatically, or only when asked | Phase 6 |
| Q6 | Public repository or private. It affects whether the UI language decision matters for contributors | Phase 0 |

## Technical unknowns to resolve by experiment

| # | Unknown | How to resolve | By |
|---|---|---|---|
| T1 | Does the chosen auth library's MCP/OIDC provider plugin still cover dynamic client registration, discovery metadata, and the resource metadata document MCP clients look for | The phase 0 spike. This is the single biggest risk in the project | Phase 0 |
| T2 | How large is a realistic profile snapshot in tokens, and does it stay comfortable at 300 facts | Compose a synthetic worst-case profile in phase 3 and measure | Phase 3 |
| T3 | Do real agents actually respect the required rationale field, or do they emit filler | Test with several clients in phase 5. If filler appears, tighten the tool description and consider rejecting rationales that cite no refs | Phase 5 |
| T4 | schema.org Recipe coverage on the sites you actually use | Test ten of your bookmarks against the parser before committing to phase 9 | Phase 9 |
| T5 | Whether the ingredient paste-parser is good enough to keep manual recipe entry under a minute | Try entering fifteen real recipes in phase 1 | Phase 1 |

## Explicitly decided, do not relitigate without a reason

Recorded so they stop consuming thought: the zero-LLM constraint, TypeScript,
Postgres, immutable plan versions, atomic typed facts, agent facts entering
unconfirmed, required rationale, and no numeric pantry quantities. Full list with
reasoning in `04-tech-spec.md` section 7.
