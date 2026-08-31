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

Specification phase. No implementation. Next step is phase 0 of the roadmap,
which is a risk spike on OAuth plus MCP.
