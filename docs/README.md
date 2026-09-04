# Cooking App - Specification

A self-hosted weekly cooking planner whose real asset is a deep, structured
profile of the cook, exposed to the user's own AI agent over MCP so that agent
can propose a genuinely personalized cooking week.

**The application never calls an LLM.** Intelligence is supplied by whatever
agent the user already pays for. Marginal cost per user tends to zero.

## Read in this order

| Doc | What it settles |
|---|---|
| [00-vision.md](00-vision.md) | Problem, differentiator, cost model, scope in and out, risks |
| [01-functional-spec.md](01-functional-spec.md) | Vocabulary, core loop, every feature's rules, screens, edge cases |
| [02-data-model.md](02-data-model.md) | Entities, columns, invariants, tenancy, the v2 household path |
| [03-agent-interface.md](03-agent-interface.md) | MCP transport, auth, resources, tools, the profile snapshot, error taxonomy |
| [04-tech-spec.md](04-tech-spec.md) | Stack argument, architecture, security, recorded decisions |
| [05-roadmap.md](05-roadmap.md) | Ten phases, each shippable alone |
| [06-open-questions.md](06-open-questions.md) | Assumptions, questions, unknowns to resolve by experiment |
| [07-phase-0-findings.md](07-phase-0-findings.md) | What the phase 0 spike proved, and the six things the spec got wrong |
| [08-self-hosting.md](08-self-hosting.md) | Running your own instance: requirements, configuration, backups, upgrades, troubleshooting |
| [09-hardening-a-host.md](09-hardening-a-host.md) | The machine under the instance: SSH, fail2ban, firewall, updates that apply themselves, disk caps, backups that leave the box |

## The five decisions that shape everything

1. **No server-side LLM.** All steering happens through schema design, tool
   descriptions, and published prompt templates.
2. **The profile is the product.** A structured, enforced core plus an open,
   agent-writable, reviewable fact store.
3. **The app works without an agent.** Manual planning is a first-class path and
   it is what populates the profile honestly.
4. **Every agent action is reversible and explained.** Immutable plan versions,
   required per-entry rationale, facts that enter unconfirmed.
5. **One service layer behind both the UI and MCP.** Rules cannot drift and
   cannot be bypassed.

## Status

All ten phases complete. A person with no agent can configure their weekly grid,
build a recipe library, plan a week with immutable versions and revert, shop
from a generated grocery list that survives the plan changing under it, and
maintain a deep structured profile plus an atomic fact store. The strict
allergen block, slot state validation and slot time budgets are enforced in the
service layer that both the UI and the MCP endpoint call.

An agent can connect, read and write: twelve tools, eight resources and two
prompts behind OAuth 2.1, with per-tool scopes, immediate revocation, a
per-client rate limit and an activity log. It proposes a week, the user reviews
it slot by slot against what is planned today, and accepts all of it, part of
it, or none of it with a reason that is kept.

The loop closes: recording what actually happened feeds cook rates, rotation
ages and slot overruns back into search, the snapshot and the agent's reading of
the week.

Phase 0 closed fully alongside phase 1: login and consent screens shipped, so
the OAuth 2.1 flow now runs end to end into an authenticated MCP call
(`npm run verify:oauth`).

Phase 10 added the polish that makes it liveable: an installable app whose
grocery list works with no signal and replays what you ticked, recipe photos,
empty states that say what to do next, a week grid a keyboard can operate slot
by slot, data export and real account deletion, an English translation with a
test that stops the two catalogues drifting, and
[08-self-hosting.md](08-self-hosting.md) for operators.
