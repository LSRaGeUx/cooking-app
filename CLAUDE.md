# Cooking App - project instructions

Self-hosted weekly cooking planner. The differentiator is a deep, structured,
agent-readable profile of the cook, exposed over MCP so the user's own agent
plans their week.

## Source of truth

`docs/` holds the full specification. Read `docs/README.md` first. Do not invent
behaviour that contradicts it. If the spec is wrong, change the spec in the same
change as the code, and say so.

| Doc | Settles |
|---|---|
| `docs/00-vision.md` | Scope in and out, cost model, risks |
| `docs/01-functional-spec.md` | Vocabulary, feature rules, screens, edge cases |
| `docs/02-data-model.md` | Entities, invariants, tenancy |
| `docs/03-agent-interface.md` | MCP tools, resources, snapshot, error taxonomy |
| `docs/04-tech-spec.md` | Stack, architecture, security, recorded decisions |
| `docs/05-roadmap.md` | Phases. Check which one is current before proposing work |
| `docs/06-open-questions.md` | Assumptions and unknowns. Add to it, do not silently assume |

## Constraints that must never be broken

1. **No server-side LLM call.** No LLM SDK may enter the dependency tree. CI
   enforces this with an allowlist check. Any feature that seems to need an LLM
   gets restructured as a tool the user's agent calls.
2. **Strict allergens are an absolute block.** No path, UI or MCP, may assign a
   recipe containing an allergen marked strict. Server-enforced and tested. No
   override.
3. **One service layer behind both entry points.** The web UI and the MCP
   endpoint call the same services. No business rule lives only in a route
   handler, a server action, or a React component.
4. **Plan versions are immutable.** Edits create a new version. Never mutate an
   existing one except for its state transition columns.
5. **Nothing an agent does is irreversible.** Facts are retired, not deleted.
   Recipe edits keep a revision. User-visible deletes are soft for 30 days.
6. **Agent-written facts enter as `unconfirmed`.** The server overrides any other
   value. Only a human confirms a fact.
7. **Every user-owned query is scoped by `user_id`,** with row-level security as
   a second line of defence.

## Conventions

- TypeScript strict. Zod schemas are the single source of truth for validation,
  MCP tool JSON Schema, and form types.
- MCP tools live one per file in `src/mcp/tools/`, holding the Zod schema, the
  description, and the handler together. **Tool and parameter descriptions are
  product copy.** They are the only way to steer an agent we do not run, so
  review them as carefully as behaviour.
- Error messages returned to agents must be actionable by a model: a code, a
  reason, and the valid alternatives. Not `400 invalid slot`.
- UI copy is French and always externalized through `next-intl`. No hardcoded
  user-facing strings.
- Metric units, ISO week numbering with an explicit year.
- Never write an em dash in documents or UI copy.

## Commits

Conventional Commits. No co-author or generated-by trailers. Do not pass
`--author` or `-c user.email`; the repo config is already correct.
